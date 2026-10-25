/**
 * The export tool surface (#50, [ADR-0024](../../.agents/adrs/0024-export-zip-reuse.md), X-27):
 * one tool, `inkflow_export`.
 *
 * One tool, not four: the format and the scope are *arguments* of the same one-off action
 * ("hand this book to a reader / to Word / to a diff"), and one tool per format would put four
 * near-identical descriptions in front of the model for one decision.
 *
 * Why it is a built-in rather than a domain tool: an export reads every content directory at
 * once and writes nothing into the book, so no single domain module owns it (X-5).
 *
 * Two behaviours the reply has to make unmissable:
 *
 *   * the artifact is **outside the book** — `$DSH_HOME/inkflow/exports/`, never inside it
 *     (`git status` stays clean, the content scan stays untouched, D4);
 *   * a refusal (`EXPORT_EMPTY`, a bad `format`, an unknown `volumeId`) writes **no file at
 *     all** — an empty package named like a finished export is worse than an error.
 */

import type { ContentBlock, HostContext, JsonSchemaNode, ToolDefinition, ToolRunContext } from './context.js'
import { CHAPTER_STATUSES } from './conventions.js'
import { gateFailure, resolveProject } from './domains/tool-project.js'
import { EXPORT_FORMATS, EXPORT_TARGETS, exportBook } from './export.js'

type Json = Record<string, unknown>

export interface ExportToolDeps {
  readonly ctx: HostContext
  readonly dataDir: string
}

function text(lines: string[]): ContentBlock[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {}
}

const PROJECT_ROOT_PARAM = {
  type: 'string',
  description:
    'Absolute path of the InkFlow project root. Omit to resolve from the session working directory (walks up to the nearest project). An explicit path must live within the session working directory.',
} as const

const SUCCESS_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: true,
}

const FORMAT_LABELS: Readonly<Record<string, string>> = {
  epub: 'EPUB（电子书阅读器）',
  docx: 'DOCX（Word）',
  markdown: 'Markdown',
  txt: '纯文本',
}

const TARGET_LABELS: Readonly<Record<string, string>> = {
  book: '整本',
  volume: '一卷',
  status: '按状态筛选',
}

/** One refused call: the code, the sentence, and what the caller should do instead. */
function describeFailure(value: Json): ContentBlock[] {
  const error = asRecord(value['error'])
  const lines = [`导出没有跑成：${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
  if (error['hint'] !== undefined) lines.push(String(error['hint']))
  const available = Array.isArray(error['available']) ? (error['available'] as unknown[]).map((item) => String(item)) : []
  if (available.length > 0) lines.push(`可选：${available.join('、')}`)
  lines.push('书里的文件一个字节都没动，导出目录里也没有新文件。')
  return text(lines)
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : []
}

/** The rendered reply: where the file went, what is in it, and that the book is untouched. */
function describeSuccess(value: Json): ContentBlock[] {
  const entries = asStringArray(value['entries'])
  const entryCount = Number(value['entryCount'] ?? entries.length)
  const lines = [
    `已导出 ${String(value['chapters'] ?? 0)} 章、${String(value['volumes'] ?? 0)} 卷 → ` +
      `${FORMAT_LABELS[String(value['format'] ?? '')] ?? String(value['format'] ?? '')}` +
      `（${TARGET_LABELS[String(value['target'] ?? '')] ?? String(value['target'] ?? '')}）`,
    `文件：${String(value['file'] ?? '')}`,
    `位置：${String(value['path'] ?? '')}`,
    `大小：${String(Math.ceil(Number(value['bytes'] ?? 0) / 1024))} KB · 条目 ${String(entryCount)} 个`,
  ]
  if (entries.length > 0) {
    lines.push(`条目：${entries.join('、')}${entryCount > entries.length ? ` …（还有 ${String(entryCount - entries.length)} 个）` : ''}`)
  }
  const verified = asRecord(value['verified'])
  if (Number(verified['entries'] ?? 0) > 0) {
    lines.push(
      `自检：写盘前已用 readZip 读回 ${String(verified['entries'])} 个条目` +
        (verified['mimetypeFirst'] === true ? '，`mimetype` 是第一条且未压缩（OCF）' : '') +
        (verified['stored'] === true ? '，全部 store-only' : ''),
    )
  }
  lines.push('书里零写入：导出物落在插件自己的 exports/ 目录，`git status` 不会有新文件。')
  return text(lines)
}

export function exportTools(deps: ExportToolDeps): ToolDefinition[] {
  const tool: ToolDefinition = {
    name: 'inkflow_export',
    description:
      'Export the book once, as an artifact outside the book: EPUB (readers), DOCX (Word), or Markdown / TXT. ' +
      'Everything is written to `$DSH_HOME/inkflow/exports/` as `<bookSlug>-<kind>-<stamp>.<ext>` (UTC stamp, `-2` in the same second) ' +
      'and NOTHING is written into the book: no content directory, no `index/`, so `git status` stays clean — an export is a derived ' +
      'artifact that can be recomputed at any moment. ' +
      '`format`: epub | docx | markdown | txt. `target`: book (the whole book) | volume (needs `volumeId`) | ' +
      'status (needs `status`, one of draft/revised/final — a cross-volume filter, so it packages one file per volume). ' +
      'volume/book scope → ONE file; status scope in markdown/txt → a ZIP of one file per volume; EPUB and DOCX are always ZIP ' +
      'containers built the same way backups are (the plugin has one ZIP writer, store-only). The EPUB puts `mimetype` first and ' +
      'uncompressed (OCF) and its table of contents carries the volume → chapter hierarchy; the DOCX uses Heading 1 for volumes, ' +
      'Heading 2 for chapters and one paragraph per body block. ' +
      'Chapter prose is rendered by a hand-written, escape-everything renderer (no Markdown dependency): headings + paragraphs, ' +
      'everything else stays escaped text. ' +
      'Refusals write no file: an empty book or a filter that matches nothing answers EXPORT_EMPTY rather than producing an empty ' +
      'package that looks like a finished export.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        format: {
          type: 'string',
          enum: [...EXPORT_FORMATS],
          description: 'epub (EPUB 3 reader package), docx (Word), markdown, or txt.',
        },
        target: {
          type: 'string',
          enum: [...EXPORT_TARGETS],
          description:
            'book = every chapter; volume = the chapters of `volumeId`; status = every chapter whose frontmatter status is `status` (kept per volume).',
        },
        volumeId: {
          type: 'string',
          description: 'Required when target is "volume": the stable `vol-NN` id (not the directory name). `inkflow_chapter_list` shows them.',
        },
        status: {
          type: 'string',
          enum: [...CHAPTER_STATUSES],
          description: 'Required when target is "status": draft | revised | final.',
        },
      },
      required: ['format', 'target'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return describeFailure(v)
        return describeSuccess(v)
      },
    },
    execute: async (args, exec: ToolRunContext) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const exported = exportBook(probe.root, deps.dataDir, {
        format: a['format'],
        target: a['target'],
        ...(a['volumeId'] === undefined ? {} : { volumeId: a['volumeId'] }),
        ...(a['status'] === undefined ? {} : { status: a['status'] }),
      })
      if (!exported.ok) return { ok: false, root: probe.root, error: exported.error }
      return { ok: true, root: probe.root, ...exported.value }
    },
  }
  return [tool]
}
