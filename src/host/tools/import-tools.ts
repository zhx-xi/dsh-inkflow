/**
 * The old-manuscript import tool (split out of `tools.ts`, #193):
 * `inkflow_library_import` (#37, roadmap X-17). A built-in rather than a domain tool: it
 * writes chapters *and* a `library/` copy, so no single content directory owns it.
 */

import type { ContentBlock, ToolDefinition } from '../context.js'
import type { ImportError } from '../import-write.js'
import { applyImport, planImport } from '../import-write.js'
import { gateFailure, resolveProject } from '../domains/tool-project.js'
import { rememberProject } from '../state.js'
import type { Json, ToolDeps } from './shared.js'
import { PROJECT_ROOT_PARAM, SUCCESS_SCHEMA, asRecord, optionalString, text } from './shared.js'

/**
 * The import's refusal rendering: the code, the one-sentence cause, the place, and whether
 * the batch was undone. "rolled back" is spelled out because it is the fact the reader
 * needs before deciding what to do next — the same reason `renderChapterFailure` prints it.
 */
function renderImportFailure(value: Json): ContentBlock[] {
  const error = asRecord(value['error'])
  const lines = [`导入失败：${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
  if (error['path'] !== undefined) lines.push(`路径：${String(error['path'])}`)
  if (error['planChapter'] !== undefined) lines.push(`停在：${String(error['planChapter'])}`)
  if (error['rolledBack'] === true) lines.push('已回滚：本批写出的章与原件副本都撤回了，书里的文件与导入前一致。')
  if (error['rolledBack'] === false) {
    lines.push('回滚未完成：备份包还在，按提示手工恢复或重跑回滚。')
  }
  if (Array.isArray(error['allowedExtensions'])) {
    lines.push(`可导入的扩展名：${(error['allowedExtensions'] as unknown[]).map(String).join(' / ')}`)
  }
  if (Array.isArray(error['missing'])) {
    lines.push(`缺项：${(error['missing'] as unknown[]).map(String).join(', ') || '—'}`)
  }
  if (error['hint'] !== undefined) lines.push(String(error['hint']))
  return text(lines)
}

/** A refused import, in the shape every tool refusal uses (`{ok:false, root, error}`). */
function importFailure(root: string, error: ImportError): Json {
  // Spread rather than nest-as-is: `ImportError` is a closed interface, and the tool
  // envelope is a JSON object (`Json`), so the fields are copied into one.
  return { ok: false, root, error: { ...error } }
}

export function importTools(deps: ToolDeps): ToolDefinition[] {
  /**
   * Importing an old manuscript (#37, roadmap X-17): `action: 'plan'` reads the source and
   * says what would happen, `action: 'apply'` writes it with `confirm: true`.
   *
   * Why one tool rather than two: the preview and the write must describe the same set of
   * chapters, and the `planToken` in this reply is how the second call proves it is acting
   * on the plan the first one showed. Two tools would let a model call the write one with
   * whatever it remembered.
   *
   * Why `sourcePath` is a plain path and not a project-relative one: an old manuscript
   * lives wherever the author keeps it — usually outside the book. The Host reads it; the
   * nine content directories are still the only place this tool *writes*.
   */
  const libraryImport: ToolDefinition = {
    name: 'inkflow_library_import',
    description:
      'Import an old manuscript (.txt or .md) as chapters, and register the original under library/. Two actions: ' +
      '"plan" (default) decodes the file, sniffs its encoding (UTF-8 → UTF-16 BOM → GBK), remembers the source line ' +
      'endings, splits it into chapters by title shape (「第N章」/「Chapter N」/「一、」/a short standalone line), and ' +
      'reports the chapters it would create with their seq, paragraph and character counts — writing NOTHING; ' +
      '"apply" performs exactly that plan and needs confirm: true (plus the planToken the preview returned). Every ' +
      'import is one backup package under .inkflow/backup/, and a failure mid-batch rolls the whole batch back. ' +
      'Chapter files land as UTF-8/LF; the original is kept under library/ as its decoded text (a GBK file cannot be ' +
      'stored byte-identically through the text writer, and the report says so). Use it when the author says ' +
      '"import my old draft"; for a single chapter, inkflow_chapter_write is the tool.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        sourcePath: {
          type: 'string',
          description:
            'Absolute path of the .txt/.md file to import. It may live outside the book (the Host reads it); a ' +
            'relative path is resolved against the session working directory.',
        },
        action: {
          type: 'string',
          enum: ['plan', 'apply'],
          description: 'plan = preview only (the default); apply = write it. Anything else is refused.',
        },
        volumeId: {
          type: 'string',
          description: 'Import into this volume (`vol-NN`); omit to create loose chapters under chapters/.',
        },
        keepOriginal: {
          type: 'boolean',
          description: 'Register the original under library/ (default true). false imports only the chapters.',
        },
        confirm: {
          type: 'boolean',
          description: 'Required for action "apply": every write in this plugin needs an explicit confirmation.',
        },
        planToken: {
          type: 'string',
          description:
            'The `planToken` from the preview. Sending it makes apply refuse (IMPORT_PLAN_STALE) if the source or ' +
            'the book changed in between; omitting it applies to whatever the file says now.',
        },
      },
      required: ['sourcePath'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return renderImportFailure(v)
        const plan = asRecord(v['plan'])
        const source = asRecord(plan['source'])
        const totals = asRecord(plan['totals'])
        const target = asRecord(plan['target'])
        const chapters = Array.isArray(plan['chapters']) ? (plan['chapters'] as Json[]) : []
        const lines: string[] = []
        const applied = v['action'] === 'apply'
        lines.push(
          `${applied ? '已导入' : '导入预览（未写盘）'}：${String(source['name'] ?? '?')} · ` +
            `${String(source['encoding'] ?? '?')} · 行尾 ${String(source['eol'] ?? '?').toUpperCase()}`,
        )
        lines.push(`编码判定：${String(source['sniff'] ?? '?')}`)
        if (plan['chaptering'] !== true) lines.push('未识别到分章：整篇作为一个章节，正文未切分。')
        lines.push(
          `目标：${target['volumeId'] === null || target['volumeId'] === undefined ? '书根（散章）' : `${String(target['volumeId'])} ${String(target['volumeTitle'] ?? '')}`}` +
            ` · ${String(totals['chapters'] ?? chapters.length)} 章 / ${String(totals['paragraphs'] ?? 0)} 段 / ${String(totals['chars'] ?? 0)} 字`,
        )
        for (const chapter of chapters.slice(0, 30)) {
          const record = asRecord(chapter)
          const seq = String(record['seq'] ?? '?')
          lines.push(
            `- ${seq.padStart(4, '0')} ${String(record['title'] ?? '')}（${String(record['paragraphs'] ?? 0)} 段 / ${String(record['chars'] ?? 0)} 字）`,
          )
        }
        if (chapters.length > 30) lines.push(`…还有 ${String(chapters.length - 30)} 章未列出`)
        const library = asRecord(plan['library'])
        if (library['path'] !== null && library['path'] !== undefined) {
          lines.push(`原件：${String(library['path'])}${library['identical'] === true ? '（已存在且内容相同，不会重写）' : ''}`)
        }
        const warnings = Array.isArray(plan['warnings']) ? (plan['warnings'] as unknown[]).map(String) : []
        for (const warning of warnings) lines.push(`注意：${warning}`)

        if (!applied) {
          lines.push('')
          lines.push(
            `确认后写入：inkflow_library_import action="apply" confirm=true planToken="${String(plan['planToken'] ?? '')}"`,
          )
          return text(lines)
        }
        const created = Array.isArray(v['created']) ? (v['created'] as Json[]) : []
        const backup = asRecord(v['backup'])
        const kept = asRecord(v['library'])
        lines.push(
          `已写出 ${String(created.length)} 章 · 备份包 ${String(backup['dir'] ?? '?')}（${String(backup['files'] ?? 0)} 个文件，` +
            `${backup['sealed'] === true ? '已封包' : '未封包'}）· 用时 ${Math.round(Number(v['ms'] ?? 0))} ms`,
        )
        if (kept['path'] !== undefined && kept['path'] !== null) {
          lines.push(
            `原件已登记：${String(kept['path'])}（${String(kept['storedBytes'] ?? 0)} 字节` +
              `${kept['byteIdentical'] === true ? '，与原件逐字节相同' : '，为解码后的 UTF-8 文本，非原件字节'}）`,
          )
        }
        if (v['indexRebuilt'] !== true) {
          lines.push(`索引未重建（${String(asRecord(v['indexError'])['code'] ?? '?')}）：文件已写出，下次读取会自动重建`)
        }
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const sourcePath = optionalString(a['sourcePath'])?.trim() ?? ''
      if (sourcePath === '') {
        return {
          ok: false,
          root: probe.root,
          error: {
            code: 'IMPORT_SOURCE_REQUIRED',
            message: 'pass the path of the .txt/.md file to import',
            hint: 'the path may point outside the book: the Host reads the file, only chapters/ and library/ are written',
          },
        }
      }
      const rawAction = optionalString(a['action'])?.trim() ?? 'plan'
      if (rawAction !== 'plan' && rawAction !== 'apply') {
        return {
          ok: false,
          root: probe.root,
          error: {
            code: 'ACTION_INVALID',
            message: `unknown action "${rawAction}"`,
            hint: 'pass action: "plan" to preview or action: "apply" with confirm: true to write',
          },
        }
      }
      const options = {
        sourcePath,
        ...(optionalString(a['volumeId']) === undefined ? {} : { volumeId: optionalString(a['volumeId']) ?? '' }),
        ...(typeof a['keepOriginal'] === 'boolean' ? { keepOriginal: a['keepOriginal'] } : {}),
      }
      rememberProject(deps.dataDir, probe.root)

      if (rawAction === 'plan') {
        const planned = planImport(probe.root, options)
        if (!planned.ok) return importFailure(probe.root, planned.error)
        return { ok: true, root: probe.root, action: 'plan', ...planned.value }
      }

      const applied = await applyImport(probe.root, {
        ...options,
        ...(typeof a['confirm'] === 'boolean' ? { confirm: a['confirm'] } : {}),
        ...(optionalString(a['planToken']) === undefined ? {} : { planToken: optionalString(a['planToken']) ?? '' }),
      })
      if (!applied.ok) return importFailure(probe.root, applied.error)
      return { ok: true, root: probe.root, action: 'apply', ...applied.value }
    },
  }

  return [libraryImport]
}

