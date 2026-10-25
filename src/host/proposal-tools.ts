/**
 * The proposal tool surface (roadmap X-26): create, decide, apply, rollback.
 *
 * Four tools, one proposal. Their shape follows from where the intelligence lives
 * (ADR-0017 D1, restated as X-26 for this milestone): the **session model writes the
 * revision**, and the plugin only validates it, cuts it into line hunks, records the
 * author's verdict and — on one confirmed call — writes through the chapter writer and
 * opens a backup package. There is no model client in here, and no outbound call.
 *
 * Two decisions show up in the schemas:
 *
 *   * `create` takes `revisedBody` — the body only, never the whole document. The
 *     frontmatter of a chapter is not part of a revision (a title change is
 *     `inkflow_chapter_write`'s job), and diffing it as prose would produce hunks nobody
 *     can accept.
 *   * `decide` takes one verdict per hunk, addressed by `index`. A hunk left `pending`
 *     is NOT a "no": `apply` refuses while any hunk is undecided, because silently
 *     treating "undecided" as "keep" would drop a change the author never saw.
 *
 * Answers are counts plus the addresses: the tool surface never re-prints the diff —
 * `inkflow_proposal_create` returns the hunk list, and the panel is where the text is
 * read.
 */

import type { ContentBlock, JsonSchemaNode, ToolDefinition, ToolRunContext } from './context.js'
import { gateFailure, isRefused, resolveProject } from './domains/tool-project.js'
import { ensureIndex } from './index-freshness.js'
import { isProposalHunkStatus } from './proposal.js'
import { createProposal, decideProposal } from './proposal-actions.js'
import { applyProposal, rollbackProposal } from './proposal-apply.js'
import type { HunkDecision } from './proposal-actions.js'
import type { ToolDeps } from './tools.js'

type Json = Record<string, unknown>

function text(lines: string[]): ContentBlock[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

const SUCCESS_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: true,
}

const PROJECT_ROOT_PARAM = {
  type: 'string',
  description:
    'Absolute path of the InkFlow project root. Omit to resolve from the session working directory (walks up to the nearest project). An explicit path must live inside the session working directory.',
} as const

const CONFIRM_PARAM = {
  type: 'boolean',
  description:
    'Set true only after the author has seen the accepted hunks. Without it nothing is written and the reply describes what would happen.',
} as const

const PROPOSAL_ID_PARAM = {
  type: 'string',
  description: 'Proposal id from `inkflow_proposal_create` (or the 提案 tab): `pr-` plus eight hex characters.',
} as const

function failureLines(label: string, raw: unknown): ContentBlock[] {
  const error = asRecord(raw)
  const lines = [`${label}失败：${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
  if (typeof error['path'] === 'string') lines.push(`路径：${error['path']}`)
  if (error['nothingWritten'] === true) lines.push('未写入任何章节文件：书里的正文与调用前一致。')
  if (typeof error['backup'] === 'string') lines.push(`备份包：${error['backup']}（回滚时用它）`)
  if (typeof error['hint'] === 'string' && error['hint'] !== '') lines.push(error['hint'])
  return text(lines)
}

/** `+12 −9` for one hunk, the way a diff is usually read. */
function hunkDelta(removed: unknown, added: unknown): string {
  return `+${String(typeof added === 'number' ? added : 0)} −${String(typeof removed === 'number' ? removed : 0)}`
}

function countsLine(value: Json): string {
  const counts = asRecord(value['counts'])
  return (
    `共 ${String(counts['total'] ?? 0)} 段：待定 ${String(counts['pending'] ?? 0)} · ` +
    `接受 ${String(counts['accepted'] ?? 0)} · 拒绝 ${String(counts['rejected'] ?? 0)}`
  )
}

export function proposalTools(deps: ToolDeps): ToolDefinition[] {
  const root = (a: Json, exec: ToolRunContext) => resolveProject(deps, a['projectRoot'], exec)

  const create: ToolDefinition = {
    name: 'inkflow_proposal_create',
    description:
      'Store a revision proposal for one chapter: the plugin cuts the revised body into line hunks under ' +
      '`.inkflow/proposals/<proposalId>/` and writes NOTHING to the chapter. Send `revisedBody` — the chapter body ' +
      'only, no frontmatter, no code fence — as the text the session model wrote; the plugin has no model client and ' +
      'never calls one (X-26). The reply carries the proposal id, the hunk count and one row per hunk (`index`, `kind`, ' +
      '`+added −removed`), which is what `inkflow_proposal_decide` addresses. The baseline recorded here is the file as ' +
      'it is now; deciding takes a fresh baseline so a later edit in the author\'s editor wins. Line-level on purpose: ' +
      'Chinese prose diffed per character produces hunks that cut words in half.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        chapterId: {
          type: 'string',
          description: 'Chapter id (or a project-relative chapter path) whose body the revision replaces.',
        },
        file: {
          type: 'string',
          description: 'Exact project-relative chapter file (`chapters/vol-01/0001-a.md`); an alternative to `chapterId`.',
        },
        revisedBody: {
          type: 'string',
          description:
            'The revised chapter body as produced by the session model. Body only: the frontmatter block of the file is never replaced by a proposal.',
        },
        label: {
          type: 'string',
          description: 'Where the revised text came from (`session-model`, a skill name, the author\'s name). Default `session-model`.',
        },
        note: {
          type: 'string',
          description: 'One line about what this revision does, shown in the 提案 tab.',
        },
      },
      required: ['revisedBody'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return failureLines('建立提案', v['error'])
        const hunks = Array.isArray(v['hunks']) ? (v['hunks'] as Json[]) : []
        const lines = [
          `提案 ${String(v['proposalId'])}：${String(v['path'] ?? '')}（${String(v['title'] ?? '')}）`,
          countsLine(v),
          `基线 ${String(asRecord(v['base'])['sha256'] ?? '')}（${String(asRecord(v['base'])['lines'] ?? 0)} 行，行尾 ${String(asRecord(v['base'])['eol'] ?? 'lf')}）`,
        ]
        for (const hunk of hunks) {
          lines.push(
            `- 第 ${String(hunk['index'])} 段 [${String(hunk['kind'])}] 从正文第 ${String(Number(hunk['baseStart']) + 1)} 行起 ${hunkDelta(hunk['removed'], hunk['added'])}`,
          )
        }
        lines.push('正文未改动：这一段只落在 .inkflow/proposals/ 里。逐段决定用 inkflow_proposal_decide。')
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await root(a, exec)
      if (isRefused(resolved)) return gateFailure(resolved)
      const projectRoot = resolved.probe?.root ?? resolved.root
      const revisedBody = typeof a['revisedBody'] === 'string' ? a['revisedBody'] : ''
      const created = createProposal(projectRoot, {
        revisedBody,
        ...(optionalString(a['chapterId']) === undefined ? {} : { chapterId: optionalString(a['chapterId']) ?? '' }),
        ...(optionalString(a['file']) === undefined ? {} : { file: optionalString(a['file']) ?? '' }),
        ...(optionalString(a['label']) === undefined ? {} : { label: optionalString(a['label']) ?? '' }),
        ...(optionalString(a['note']) === undefined ? {} : { note: optionalString(a['note']) ?? '' }),
      })
      if (!created.ok) return { ok: false, root: projectRoot, error: { ...created.error } }
      return { ...created.value }
    },
  }

  const decide: ToolDefinition = {
    name: 'inkflow_proposal_decide',
    description:
      'Record the author\'s verdict on proposal hunks: `decisions` is a list of `{ index, status }` where status is ' +
      '`accepted`, `rejected` or `pending` (pending undoes an earlier verdict). Nothing is written to the chapter — the ' +
      'only files touched are the proposal\'s own hunk records. The chapter\'s fingerprint is captured at THIS moment ' +
      'and stored as the baseline `apply` will check, so text typed afterwards is a refusal rather than an overwrite. ' +
      'If the chapter changed since the proposal was made, the decision is refused with FILE_CHANGED and nothing is ' +
      'recorded: the hunks address line ranges of the old text.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        proposalId: PROPOSAL_ID_PARAM,
        decisions: {
          type: 'array',
          description: 'One verdict per hunk, addressed by the `index` from inkflow_proposal_create.',
          items: {
            type: 'object',
            properties: {
              index: { type: 'number', description: 'Hunk number, 1-based, as listed by create.' },
              status: {
                type: 'string',
                enum: ['accepted', 'rejected', 'pending'],
                description: 'accepted writes this hunk into the chapter on apply; rejected keeps the original text.',
              },
            },
            required: ['index', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['proposalId', 'decisions'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return failureLines('记录决定', v['error'])
        const pending = Array.isArray(v['pending']) ? (v['pending'] as unknown[]) : []
        const lines = [`提案 ${String(v['proposalId'])}：${countsLine(v)}`]
        const decision = asRecord(v['decision'])
        lines.push(`基线（决定时刻）${String(asRecord(decision['baseline'])['sha256'] ?? '')}`)
        lines.push(
          pending.length === 0
            ? '每一段都决定了，可以用 inkflow_proposal_apply 落盘。'
            : `还有待定的段：${pending.map(String).join('、')} —— 未决定的段不会被写入，apply 在它们决定前会拒绝。`,
        )
        lines.push('正文未改动（contentFilesWritten: 0）。')
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await root(a, exec)
      if (isRefused(resolved)) return gateFailure(resolved)
      const projectRoot = resolved.probe?.root ?? resolved.root
      const proposalId = optionalString(a['proposalId']) ?? ''
      const raw = a['decisions']
      if (!Array.isArray(raw)) {
        return {
          ok: false,
          root: projectRoot,
          error: {
            code: 'PROPOSAL_DECISIONS_REQUIRED',
            message: 'decisions must be a list of { index, status }',
            hint: 'status is accepted, rejected or pending',
          },
        }
      }
      const decisions: HunkDecision[] = raw.map((item) => {
        const record = asRecord(item)
        const rawIndex = record['index']
        const rawStatus = record['status']
        return {
          index: typeof rawIndex === 'number' ? rawIndex : Number.NaN,
          status: isProposalHunkStatus(rawStatus) ? rawStatus : String(rawStatus ?? ''),
        }
      })
      const decided = decideProposal(projectRoot, { proposalId, decisions })
      if (!decided.ok) return { ok: false, root: projectRoot, error: { ...decided.error } }
      return { ...decided.value }
    },
  }

  const apply: ToolDefinition = {
    name: 'inkflow_proposal_apply',
    description:
      'Write the accepted hunks of a proposal into its chapter — the proposal\'s only write path, and it needs ' +
      '`confirm: true`. Refused with zero writes when any hunk is still undecided (an undecided hunk is not a "no"), ' +
      'when nothing was accepted, or when the chapter no longer matches the baseline recorded at decision time ' +
      '(FILE_CHANGED — the author\'s own edit wins). The write goes through the chapter writer, so the write lock, the ' +
      'catalog and derived index and the file\'s own line endings and BOM (ADR-0016) all apply. A `replace` backup ' +
      'package is opened BEFORE the write, and its path travels in the reply: that is what inkflow_proposal_rollback ' +
      'replays. Rejected hunks contribute not one byte.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        proposalId: PROPOSAL_ID_PARAM,
        confirm: CONFIRM_PARAM,
      },
      required: ['proposalId', 'confirm'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return failureLines('应用提案', v['error'])
        const applied = Array.isArray(v['applied']) ? (v['applied'] as unknown[]) : []
        const skipped = Array.isArray(v['skipped']) ? (v['skipped'] as unknown[]) : []
        const lines = [
          `已写入 ${String(v['path'] ?? '')}：接受 ${applied.length} 段（${applied.map(String).join('、') || '—'}），` +
            `拒绝 ${skipped.length} 段（${skipped.map(String).join('、') || '—'} 一个字节都没进文件）`,
          `${String(v['bytes'] ?? 0)} 字节 · sha256 ${String(asRecord(v['after'])['sha256'] ?? '')}`,
          `备份包：${String(v['backup'] ?? '')}（inkflow_proposal_rollback 用它逐字节还原）`,
        ]
        lines.push(
          v['indexRebuilt'] === true ? '派生索引已重建。' : '派生索引未重建（下次读取会自行刷新）。',
        )
        if (typeof v['commitSuggestion'] === 'string') {
          lines.push(`建议的提交（插件不跑 git，交给你执行）：${v['commitSuggestion']}`)
        }
        lines.push('这一步改了正文：作者若不满意，先回滚再重做，不要在上面继续改。')
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await root(a, exec)
      if (isRefused(resolved)) return gateFailure(resolved)
      const projectRoot = resolved.probe?.root ?? resolved.root
      const applied = await applyProposal(projectRoot, {
        proposalId: optionalString(a['proposalId']) ?? '',
        ...(typeof a['confirm'] === 'boolean' ? { confirm: a['confirm'] } : {}),
      })
      if (!applied.ok) return { ok: false, root: projectRoot, error: { ...applied.error } }
      // `writeChapter` already rebuilt the index when it wrote; nothing else to do here.
      return { ...applied.value }
    },
  }

  const rollback: ToolDefinition = {
    name: 'inkflow_proposal_rollback',
    description:
      'Undo an applied proposal by replaying its backup package: the chapter file goes back to the exact bytes it had ' +
      'before the apply (BOM and CRLF included), and the reply says `verified: true` only when the digest on disk equals ' +
      'the one recorded before the write. Needs `confirm: true`. A chapter edited after the apply is a BACKUP_CONFLICT ' +
      'and is left untouched — the author\'s newer text wins over a snapshot. One rollback per apply; the derived index ' +
      'is refreshed afterwards.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        proposalId: PROPOSAL_ID_PARAM,
        confirm: CONFIRM_PARAM,
      },
      required: ['proposalId', 'confirm'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return failureLines('回滚提案', v['error'])
        const restored = Array.isArray(v['restored']) ? (v['restored'] as unknown[]) : []
        const lines = [
          `已回滚：${restored.map(String).join('、') || '—'}`,
          `备份包：${String(v['backup'] ?? '')}`,
          v['verified'] === true
            ? `逐字节一致：sha256 ${String(asRecord(v['before'])['sha256'] ?? '')}（${String(v['bytes'] ?? 0)} 字节）`
            : '未能验证字节一致：文件现在的摘要与回滚前记录的不一样，先看备份包里的副本再决定下一步。',
        ]
        if (v['indexRebuilt'] === true) lines.push('派生索引已重建。')
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await root(a, exec)
      if (isRefused(resolved)) return gateFailure(resolved)
      const projectRoot = resolved.probe?.root ?? resolved.root
      const undone = rollbackProposal(projectRoot, {
        proposalId: optionalString(a['proposalId']) ?? '',
        ...(typeof a['confirm'] === 'boolean' ? { confirm: a['confirm'] } : {}),
      })
      if (!undone.ok) return { ok: false, root: projectRoot, error: { ...undone.error } }
      const ensured = await ensureIndex(projectRoot)
      // `value`, not the whole `{ ok, value }` envelope: `execute` answers the flat
      // payload its own `render` reads — spreading the envelope left `restored`, `backup`
      // and `verified` undefined, so a byte-identical rollback printed as a failed check.
      return { ...undone.value, indexRebuilt: ensured.ok ? ensured.rebuilt : false }
    },
  }

  return [create, decide, apply, rollback]
}
