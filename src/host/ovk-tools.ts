/**
 * The semantic-retrieval tool surface: status, rebuild, purge.
 *
 * Three tools, three different risk levels, so the shape of each is decided by what it can
 * destroy:
 *
 *   * `inkflow_semantic_status` — **read-only, no confirm.** It is the tool the model calls
 *     when the author asks "why is 语义检索 not working", so it must answer on a broken book,
 *     on a stopped OVK and on an unconfigured plugin: those are exactly the states it exists
 *     to explain.
 *   * `inkflow_semantic_rebuild` — **writes to OVK and costs money** (every block is
 *     summarised by a model), so it estimates first and requires `confirm: true` above the
 *     ADR-0009 P10 thresholds (>200 chapters or >5 MB).
 *   * `inkflow_semantic_purge` — **the only path in this plugin that calls `forget`**
 *     (ADR-0009 P6). It lists the tombstones it would remove, requires `confirm: true`, and
 *     stops at the first failure so a half-done purge is reported instead of hidden.
 *
 * The operations themselves live in `ovk-status.ts` (one implementation, two channels — the
 * settings panel asks the same three questions); this file is the model-facing shell.
 */

import type { ContentBlock, HostContext, JsonSchemaNode, ToolDefinition } from './context.js'
import { gateFailure, resolveProject } from './domains/tool-project.js'
import { ensureIndex } from './index-freshness.js'
import { OVK_DEGRADED_REASONS } from './ovk.js'
import type { RebuildSummary } from './ovk-ledger.js'
import {
  estimateRebuild,
  purgeApply,
  purgePlanOf,
  rebuildNow,
  semanticStatusOf,
} from './ovk-status.js'

type Json = Record<string, unknown>

export interface SemanticToolDeps {
  readonly ctx: HostContext
  readonly dataDir: string
  readonly version: string
}

function text(lines: string[]): ContentBlock[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {}
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
    'Set true only after the user has seen the estimate (rebuild) or the list of blocks (purge). Without it nothing is written and the reply describes the pending action.',
} as const

/** `1.2 MB` for a reply line; the wire carries bytes. */
function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function summaryLines(summary: RebuildSummary): string[] {
  return [
    `最近一次重建：${summary.at}`,
    `写入 ${String(summary.written)} 章 / 墓碑 ${String(summary.tombstoned)} 章 / 未变 ${String(summary.unchanged)} 章`,
    `块 ${String(summary.blocks)} 个 · ${bytesLabel(summary.bytes)} · 调用 ${String(summary.calls)} 次`,
    // A receipt is replayed JSON: the preview path has no `summary` at all, and a stored
    // summary may predate `staleChapters`. Both are absent fields, not broken data.
    ...((summary.stale ?? 0) === 0
      ? []
      : [`未完成（下次重试）：${String(summary.stale)} 章 — ${(summary.staleChapters ?? []).slice(0, 5).join(', ')}`]),
  ]
}

export function semanticTools(deps: SemanticToolDeps): ToolDefinition[] {
  const status: ToolDefinition = {
    name: 'inkflow_semantic_status',
    description:
      'Report the semantic (OpenViking) retrieval backend AND the coverage of this book in it, as two separate answers — ' +
      '"the server answers" and "this book was written into it" are different facts, and a book with 0 blocks cannot ' +
      'produce a semantic hit however healthy the server is. Backend: whether it is enabled in the plugin settings, ' +
      'which endpoint and peer are in force, whether the server answers right now, and when it does not, one of the six ' +
      'fixed reasons (disabled / no-endpoint / no-peer / unreachable / unauthorized / timeout). Coverage: how many of ' +
      'the chapters of this book have blocks (none / partial with the chapter ratio and how far behind / complete), plus ' +
      'the ledger counts and the last rebuild (chapters / blocks / bytes / calls). A book with no live block reports ' +
      '`no-blocks`, which is also what a search answers: it goes straight to keywords without sending an OpenViking ' +
      'request. Read-only: it never writes to OVK, the settings or the book, so it answers on a broken book and on a ' +
      'stopped server, which is exactly when it is worth calling. The API key is never echoed — only whether one is set.',
    parameters: {
      type: 'object',
      properties: { projectRoot: PROJECT_ROOT_PARAM },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          const lines = [`语义检索状态不可读：${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
          if (error['hint'] !== undefined) lines.push(String(error['hint']))
          return text(lines)
        }
        const availability = asRecord(v['availability'])
        const coverage = asRecord(v['coverage'])
        const settings = asRecord(v['settings'])
        const peer = asRecord(v['peer'])
        const ledger = asRecord(v['ledger'])
        const queue = asRecord(v['queue'])
        const backendUp = availability['backend'] === 'ovk'
        const lines = [
          `后端：${backendUp ? '可用（ovk）' : `不可用（关键词检索：${String(availability['reason'] ?? '')}）`}`,
        ]
        if (availability['detail'] !== undefined) lines.push(`  ${String(availability['detail'])}`)
        // The coverage line only appears when the backend answers: while it does not, the one
        // fix is the reason above, and a second complaint would point at the wrong thing.
        // Same wording as the settings page — both print `coverage.headline` verbatim.
        const headline = coverage['headline']
        if (backendUp && typeof headline === 'string' && headline !== '') lines.push(`本书覆盖：${headline}`)
        lines.push(`开关：semanticSearch=${String(settings['enabled'] === true)} · 端点：${String(settings['endpoint'] ?? '（未设置）')} · 密钥：${settings['apiKeySet'] === true ? '已设置' : '未设置'}`)
        lines.push(`peer：${String(peer['id'] ?? '（无）')}${peer['source'] === null ? '' : `（${String(peer['source'])} · ${String(peer['configPath'] ?? '')}）`}`)
        lines.push(`块：${String(ledger['blocks'] ?? 0)} 个（章 ${String(ledger['chapters'] ?? 0)} · 墓碑 ${String(ledger['tombstones'] ?? 0)} · projectId ${String(ledger['projectId'] ?? '（未建立）')}）`)
        const last = asRecord(ledger['lastRebuild'])
        if (Object.keys(last).length > 0) lines.push(...summaryLines(last as unknown as RebuildSummary))
        lines.push(`作业：${String(queue['state'] ?? 'idle')}${typeof queue['queued'] === 'number' ? `（排队 ${String(queue['queued'])}）` : ''}`)
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const root = resolved.probe.root
      const report = await semanticStatusOf(root, { dataDir: deps.dataDir })
      return { ok: true, root, reasons: [...OVK_DEGRADED_REASONS], ...report }
    },
  }

  const rebuild: ToolDefinition = {
    name: 'inkflow_semantic_rebuild',
    description:
      'Write this book\'s chapters into OpenViking as semantic blocks, one chapter at a time, overwriting the SAME URIs ' +
      '(idempotent: a second run over an unchanged book writes nothing, and a changed chapter overwrites its own blocks ' +
      'so no stale text lingers). Deleted chapters become tombstones here — nothing is physically removed (that is ' +
      'inkflow_semantic_purge). Estimate first: without confirm: true the reply is the plan (chapters to write, blocks, ' +
      'bytes, summary calls) and nothing is sent; above 200 chapters or 5 MB a build REQUIRES confirm: true because every ' +
      'block costs a model summary call. Runs are serial per book and coalesced, so two calls do not double the spend. ' +
      'Needs semanticSearch on, a semanticEndpoint, and a peer.id in the book\'s .openviking config.',
    parameters: {
      type: 'object',
      properties: { projectRoot: PROJECT_ROOT_PARAM, confirm: CONFIRM_PARAM },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        const estimate = asRecord(v['estimate'])
        const estimateLines = [
          `重建预估：${String(estimate['pending'] ?? 0)} 章待写（未变 ${String(estimate['unchanged'] ?? 0)} · 墓碑 ${String(estimate['tombstones'] ?? 0)}）`,
          `块 ${String(estimate['blocks'] ?? 0)} 个 · ${bytesLabel(Number(estimate['bytes'] ?? 0))} · 摘要调用 ${String(estimate['calls'] ?? 0)} 次`,
        ]
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          const lines = [`语义重建未执行：${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
          if (error['hint'] !== undefined) lines.push(String(error['hint']))
          if (v['requiresConfirm'] === true) lines.unshift(...estimateLines, '')
          return text(lines)
        }
        if (v['requiresConfirm'] === true) {
          return text([...estimateLines, '超过首建阈值，需要 confirm: true 才会执行（每块一次模型摘要调用，即真实费用）。'])
        }
        // Only a real run has a summary; the estimate-only reply stops at the two lines above.
        const summary = asRecord(v['summary'])
        const tail = Object.keys(summary).length === 0 ? [] : ['', ...summaryLines(summary as unknown as RebuildSummary)]
        return text([...estimateLines, ...tail])
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const root = resolved.probe.root
      // The estimate reads the chapter list from the index, so it has to be fresh — the same
      // single rebuild trigger every other read tool uses.
      const ensured = await ensureIndex(root)
      if (!ensured.ok) {
        return {
          ok: false,
          root,
          error: {
            code: ensured.failure.code,
            message: ensured.failure.message,
            hint: 'the chapter list comes from the derived index; fix the index first, then estimate again',
          },
        }
      }
      const estimated = estimateRebuild(root, { dataDir: deps.dataDir })
      if (!estimated.ok) {
        return {
          ok: false,
          root,
          error: {
            code: 'INDEX_UNAVAILABLE',
            message: 'the derived index cannot be read, so no estimate can be made',
            hint: 'rebuild the index (any read tool does it) and retry',
          },
        }
      }
      const estimate = estimated.estimate
      if (a['confirm'] !== true) {
        return {
          ok: true,
          root,
          estimate,
          requiresConfirm: estimate.requiresConfirm,
          ...(estimate.requiresConfirm
            ? {
                error: {
                  code: 'CONFIRM_REQUIRED',
                  message: `this build would write ${String(estimate.chapters)} chapters / ${String(estimate.blocks)} blocks (${bytesLabel(estimate.bytes)}) and costs ${String(estimate.calls)} summary calls`,
                  hint: 'show the user the estimate, then call again with confirm: true',
                },
              }
            : {}),
        }
      }
      const run = await rebuildNow(root, { dataDir: deps.dataDir })
      if (!run.ok) {
        return {
          ok: false,
          root,
          estimate,
          error: {
            code: 'SEMANTIC_UNAVAILABLE',
            reason: run.reason,
            message: run.detail,
            hint: 'run inkflow_semantic_status, fix the reported reason, then retry',
          },
        }
      }
      const outcome = run.outcome
      if (outcome.summary.calls === 0 && outcome.summary.written === 0 && outcome.summary.stale === 0 && outcome.status === 'failed') {
        return {
          ok: false,
          root,
          estimate,
          summary: outcome.summary,
          error: {
            code: 'SEMANTIC_REBUILD_FAILED',
            message: 'the rebuild could not read the book or write any block',
            hint: 'run inkflow_semantic_status for the transport reason',
          },
        }
      }
      return {
        ok: true,
        root,
        estimate,
        summary: outcome.summary,
        status: outcome.status,
        staleChapters: outcome.staleChapters,
      }
    },
  }

  const purge: ToolDefinition = {
    name: 'inkflow_semantic_purge',
    description:
      'Physically remove the semantic blocks of DELETED chapters from OpenViking. This is the only action in this plugin ' +
      'that deletes anything there: deleting a chapter only overwrites its blocks with tombstones (so a wrong delete ' +
      'stays recoverable), and those tombstones keep occupying space until this runs. Without confirm: true it lists ' +
      'what it would remove (count + URIs) and deletes nothing; with it, each URI is deleted one at a time and the run ' +
      'stops at the first failure, reporting what was removed and what was not. A live chapter is never in the list.',
    parameters: {
      type: 'object',
      properties: { projectRoot: PROJECT_ROOT_PARAM, confirm: CONFIRM_PARAM },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          const lines = [`语义清理未执行：${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
          if (error['hint'] !== undefined) lines.push(String(error['hint']))
          const uris = Array.isArray(v['uris']) ? (v['uris'] as unknown[]).map(String) : []
          if (uris.length > 0) lines.push(...uris.slice(0, 10).map((uri) => `- ${uri}`))
          return text(lines)
        }
        const uris = Array.isArray(v['uris']) ? (v['uris'] as unknown[]).map(String) : []
        if (v['requiresConfirm'] === true) {
          return text(
            [
              `待清理：${String(uris.length)} 个块（已删除章的占位条目）。`,
              ...uris.slice(0, 10).map((uri) => `- ${uri}`),
              ...(uris.length > 10 ? [`… 还有 ${String(uris.length - 10)} 个`] : []),
              '需要 confirm: true 才会真的删除。',
            ],
          )
        }
        const deleted = Array.isArray(v['deleted']) ? (v['deleted'] as unknown[]).map(String) : []
        const lines = [`已清理 ${String(deleted.length)} 个块。`, ...deleted.slice(0, 10).map((uri) => `- ${uri}`)]
        if (v['stoppedAt'] !== undefined) {
          const stopped = asRecord(v['stoppedAt'])
          lines.push(`在 ${String(stopped['uri'] ?? '')} 处停止：${String(stopped['reason'] ?? '')} — ${String(stopped['detail'] ?? '')}`)
        }
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const root = resolved.probe.root
      const uris = purgePlanOf(root, { dataDir: deps.dataDir })
      if (uris.length === 0) {
        return {
          ok: true,
          root,
          uris: [],
          deleted: [],
          requiresConfirm: false,
          message: 'no tombstoned blocks: nothing was deleted, or every deleted chapter was already cleaned',
        }
      }
      if (a['confirm'] !== true) {
        return {
          ok: false,
          root,
          uris,
          requiresConfirm: true,
          error: {
            code: 'CONFIRM_REQUIRED',
            message: `${String(uris.length)} tombstoned block(s) would be physically deleted; this is not recoverable`,
            hint: 'show the user the list, then call again with confirm: true',
          },
        }
      }
      const run = await purgeApply(root, { dataDir: deps.dataDir })
      if (!run.ok) {
        return {
          ok: false,
          root,
          uris,
          error: {
            code: 'SEMANTIC_UNAVAILABLE',
            reason: run.reason,
            message: run.detail,
            hint: 'run inkflow_semantic_status, fix the reported reason, then retry',
          },
        }
      }
      // Nothing deleted because the FIRST uri failed: that is not a completed purge, and
      // reporting ok would let a caller believe the cleanup happened.
      if (run.outcome.deleted.length === 0 && run.outcome.stoppedAt !== undefined) {
        return {
          ok: false,
          root,
          uris,
          stoppedAt: run.outcome.stoppedAt,
          error: {
            code: 'SEMANTIC_PURGE_FAILED',
            reason: run.outcome.stoppedAt.reason,
            message: `nothing was deleted: ${run.outcome.stoppedAt.detail}`,
            hint: 'the tombstone list is unchanged; fix the transport and retry',
          },
        }
      }
      return {
        ok: true,
        root,
        uris,
        deleted: run.outcome.deleted,
        ...(run.outcome.stoppedAt === undefined ? {} : { stoppedAt: run.outcome.stoppedAt }),
      }
    },
  }

  return [status, rebuild, purge]
}
