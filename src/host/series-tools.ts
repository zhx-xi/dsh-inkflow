/**
 * The series sync's tool surface: `inkflow_series_plan` / `inkflow_series_apply`.
 *
 * Two tools, one computation: `series.ts` owns both halves, and `apply` recomputes the
 * plan so the write can be compared against what was previewed (X-17). Nothing is
 * registered here that could write without that comparison — there is deliberately no
 * "sync everything" call, because the one thing this feature must not do is write a diff
 * nobody approved.
 *
 * WHY BUILT-INS rather than domain tools: a sync reads the plugin-level library and writes
 * into `world/` and `library/`, so it belongs to no single content directory (X-5).
 *
 * The replies are shaped so a model cannot misread the two facts that matter:
 *
 *   * `apply` on undecided conflicts answers `SERIES_CONFLICT_UNRESOLVED` with the list of
 *     rows still waiting — and writes nothing, so "partially synced" is not a state it can
 *     leave behind;
 *   * a row that drifted between plan and apply is reported as `SERIES_PLAN_STALE` by name,
 *     not folded into a count.
 */

import type { ContentBlock, HostContext, JsonSchemaNode, ToolDefinition, ToolRunContext } from './context.js'
import { gateFailure, resolveProject } from './domains/tool-project.js'
import { applySeriesSync, buildSeriesPlan } from './series.js'
import type { SeriesDecisionChoice, SeriesError } from './series.js'
import { rememberProject } from './state.js'

type Json = Record<string, unknown>

export interface SeriesToolDeps {
  readonly ctx: HostContext
  readonly dataDir: string
}

function text(lines: string[]): ContentBlock[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {}
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((item): item is Json => typeof item === 'object' && item !== null) : []
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

const ACTION_LABELS: Readonly<Record<string, string>> = {
  create: '新建',
  update: '更新',
  conflict: '冲突（要裁决）',
  unchanged: '无需改动',
}

const DECISION_LABELS: Readonly<Record<string, string>> = {
  'take-shared': '采用共享库',
  'keep-book': '保留本书',
  skip: '跳过',
}

/** One refused call: what happened and what to do about it. */
function describeFailure(value: Json): ContentBlock[] {
  const error = asRecord(value['error'])
  const code = String(error['code'] ?? 'unknown')
  const lines = [`系列同步没有跑成：${code} — ${String(error['message'] ?? '')}`]
  if (error['hint'] !== undefined) lines.push(String(error['hint']))
  for (const row of records(error['unresolved'])) {
    lines.push(`- 未裁决：${String(row['path'] ?? '')}（${String(row['entryId'] ?? '')}）`)
  }
  return text(lines)
}

/** The counts line every reply starts with. */
function countsLine(counts: Json): string {
  return (
    `新建 ${String(Number(counts['create'] ?? 0))} · 更新 ${String(Number(counts['update'] ?? 0))} · ` +
    `冲突 ${String(Number(counts['conflict'] ?? 0))} · 无需改动 ${String(Number(counts['unchanged'] ?? 0))}`
  )
}

/** Per-row lines: the action, the path, what differs, and why a conflict is one. */
function rowLines(rows: readonly Json[]): string[] {
  const lines: string[] = []
  for (const row of rows) {
    const action = String(row['action'] ?? '')
    const fields = Array.isArray(row['changedFields']) ? (row['changedFields'] as unknown[]).map((item) => String(item)) : []
    const reason =
      row['conflict'] === 'book-diverged'
        ? '本书改过、共享库没动'
        : row['conflict'] === 'unrelated-file'
          ? '本书里的同名文件不是这条的副本'
          : row['conflict'] === 'source-unreadable'
            ? '共享库那一侧读不出来'
            : ''
    lines.push(
      `- ${ACTION_LABELS[action] ?? action} · ${String(row['targetPath'] ?? '')}` +
        (fields.length > 0 ? ` · 差异字段：${fields.join(', ')}` : '') +
        (reason === '' ? '' : ` · ${reason}`),
    )
  }
  return lines
}

function exclusionsLine(value: Json): string | null {
  const excluded = asRecord(value['excluded'])
  const byKind = asRecord(excluded['byKind'])
  const parts: string[] = []
  for (const [kind, count] of Object.entries(byKind)) parts.push(`${kind} ${String(count)} 条`)
  const reference = Number(excluded['reference'] ?? 0)
  if (reference > 0) parts.push(`引用卡 ${String(reference)} 条（只读）`)
  const unhashable = Number(excluded['unhashable'] ?? 0)
  if (unhashable > 0) parts.push(`无法计算摘要 ${String(unhashable)} 条`)
  return parts.length === 0 ? null : `不在同步范围内：${parts.join('、')}`
}

export function seriesTools(deps: SeriesToolDeps): ToolDefinition[] {
  /**
   * `plan` — the read-only half. It hashes the library, reads the copies and compares
   * them; it writes nothing, which is why the tool needs no `confirm`.
   */
  const seriesPlan: ToolDefinition = {
    name: 'inkflow_series_plan',
    description:
      'Preview a series sync: every world/ and library/ entry of the plugin-level shared library judged against this ' +
      'book, one row per entry with `action` = create (nothing there yet), update (the shared entry moved after the ' +
      'copy was taken), unchanged (both sides read the same) or conflict (the two sides differ and only a human can ' +
      'pick), plus `changedFields` for the ones that differ. Read-only: nothing is written, and the shared library is ' +
      'only read. Pass the returned `expected` and one decision per conflict to inkflow_series_apply.',
    parameters: {
      type: 'object',
      properties: { projectRoot: PROJECT_ROOT_PARAM },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return describeFailure(v)
        const rows = records(v['entries'])
        const lines = [`系列同步预览 · ${countsLine(asRecord(v['counts']))}`]
        if (v['seriesId'] !== null && v['seriesId'] !== undefined) lines.push(`seriesId：${String(v['seriesId'])}`)
        const excluded = exclusionsLine(v)
        if (excluded !== null) lines.push(excluded)
        if (rows.length === 0) {
          lines.push('共享库里没有可同步的设定条目（world/ 与 library/）。')
          return text(lines)
        }
        lines.push(...rowLines(rows))
        const conflicts = rows.filter((row) => row['action'] === 'conflict')
        if (conflicts.length > 0) {
          lines.push(
            '',
            `${String(conflicts.length)} 条冲突需要逐条裁决（take-shared / keep-book / skip）：未裁决时 inkflow_series_apply 会拒绝并且不写任何文件。`,
          )
        }
        return text(lines)
      },
    },
    execute: async (args, exec: ToolRunContext) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const plan = buildSeriesPlan({ dataDir: deps.dataDir, root: probe.root })
      if (!plan.ok) return seriesFailure(plan.error, probe.root)
      rememberProject(deps.dataDir, probe.root)
      return { ok: true, ...(plan.value as unknown as Json) }
    },
  }

  /**
   * `apply` — the write half. The confirmation, the `expected` comparison and the
   * decide-every-conflict guard all live in `applySeriesSync`; this tool only forwards
   * what the caller sent, so the tool surface cannot be more permissive than the engine.
   */
  const seriesApply: ToolDefinition = {
    name: 'inkflow_series_apply',
    description:
      'Perform a series sync that was previewed with inkflow_series_plan. Requires `confirm: true` and the plan\'s own ' +
      '`expected` rows: the engine recomputes the plan and writes only entries that still match what was previewed ' +
      '(anything that drifted is skipped and reported SERIES_PLAN_STALE). EVERY conflict needs a decision ' +
      '(`take-shared` / `keep-book` / `skip`); with one unresolved the call refuses with SERIES_CONFLICT_UNRESOLVED ' +
      'and writes nothing. Files that are written go into an .inkflow/backup/ package first, and the run is recorded ' +
      'under .inkflow/audit/series-<stamp>.json. The shared library itself is never written.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        expected: {
          type: 'array',
          description: 'The `expected` array from inkflow_series_plan, unchanged. Apply writes only rows in it.',
          items: {
            type: 'object',
            properties: {
              entryId: { type: 'string', description: 'Shared entry id (`sh-xxxxxxxx`).' },
              action: {
                type: 'string',
                enum: ['create', 'update', 'conflict', 'unchanged'],
                description: 'The action the preview showed for that entry.',
              },
            },
            required: ['entryId', 'action'],
            additionalProperties: false,
          },
        },
        decisions: {
          type: 'array',
          description: 'One entry per conflict row. A conflict with no decision refuses the whole run.',
          items: {
            type: 'object',
            properties: {
              entryId: { type: 'string', description: 'The conflicting shared entry id.' },
              decision: {
                type: 'string',
                enum: ['take-shared', 'keep-book', 'skip'],
                description:
                  'take-shared overwrites the book file with the shared entry (backed up first), keep-book leaves the book as it is, skip touches nothing.',
              },
            },
            required: ['entryId', 'decision'],
            additionalProperties: false,
          },
        },
        confirm: {
          type: 'boolean',
          description: 'Must be true: applying writes setting files into the book. Show the plan and the decisions first.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return describeFailure(v)
        const written = records(v['written'])
        const kept = records(v['kept'])
        const skipped = records(v['skipped'])
        const lines = [`系列同步已执行 · ${countsLine(asRecord(v['counts']))}`]
        if (written.length === 0) lines.push('没有写任何文件。')
        for (const row of written) {
          lines.push(
            `- 写入 ${String(row['path'] ?? '')}（${String(DECISION_LABELS[String(row['action'])] ?? String(row['action']))}）`,
          )
        }
        for (const row of kept) lines.push(`- 保留本书 ${String(row['path'] ?? '')}`)
        for (const row of skipped) {
          lines.push(
            row['code'] === 'SERIES_PLAN_STALE'
              ? `- 跳过（预览之后变了）：${String(row['path'] ?? row['entryId'] ?? '')}`
              : `- 跳过（按裁决）：${String(row['path'] ?? row['entryId'] ?? '')}`,
          )
        }
        if (skipped.some((row) => row['code'] === 'SERIES_PLAN_STALE')) {
          lines.push('有条目在预览之后变化了：重新跑一次 inkflow_series_plan 再确认。')
        }
        lines.push(`运行记录：${String(v['auditPath'] ?? '')}`)
        if (v['backupDir'] !== undefined) lines.push(`回滚包：${String(v['backupDir'])}`)
        return text(lines)
      },
    },
    execute: async (args, exec: ToolRunContext) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const applied = applySeriesSync({
        dataDir: deps.dataDir,
        root: probe.root,
        expected: records(a['expected']).map((row) => ({ entryId: String(row['entryId'] ?? ''), action: String(row['action'] ?? '') })),
        decisions: records(a['decisions']).map((row) => ({
          entryId: String(row['entryId'] ?? ''),
          decision: String(row['decision'] ?? '') as SeriesDecisionChoice,
        })),
        confirm: a['confirm'] === true,
      })
      if (!applied.ok) return seriesFailure(applied.error, probe.root)
      rememberProject(deps.dataDir, probe.root)
      return { ok: true, ...(applied.value as unknown as Json) }
    },
  }

  return [seriesPlan, seriesApply]
}

/** A domain refusal as a tool reply, with the book it happened in. */
function seriesFailure(error: SeriesError, root: string): Json {
  return {
    ok: false,
    root,
    error: {
      code: error.code,
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.unresolved === undefined ? {} : { unresolved: error.unresolved }),
    },
  }
}
