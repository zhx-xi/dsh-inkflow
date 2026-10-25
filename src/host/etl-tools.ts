/**
 * The migration tool surface: `inkflow_etl_plan` and `inkflow_etl_apply`.
 *
 * Two tools, and the split is the whole safety story:
 *
 *   * `inkflow_etl_plan` is **read-only by construction** — it opens the old database
 *     read-only, stats the book and returns the plan (13 class reports, the chapter
 *     numbering gaps, the decisions the author has to make, and a `planToken`).
 *   * `inkflow_etl_apply` needs `confirm: true`, re-computes the same plan (X-29), and
 *     compares the caller's item set with what it just computed: a row that disappeared or
 *     changed shape is skipped and reported, never silently replaced.
 *
 * `action: "rollback"` rides on the same tool instead of a third one: undoing a migration
 * is the same operation seen backwards, and a separate tool would be a second place that
 * has to know how a package is addressed. It needs `confirm: true` as well — a rollback
 * deletes files.
 *
 * Why these are built-ins rather than domain tools: a migration writes into **every**
 * content directory, so no single domain module owns it (X-5).
 */

import type { ContentBlock, HostContext, JsonSchemaNode, ToolDefinition, ToolRunContext } from './context.js'
import { resolveProject } from './domains/tool-project.js'
import { gateFailure } from './domains/tool-project.js'
import { applyEtl, planEtl, rollbackEtl } from './etl.js'
import type { EtlError } from './etl.js'
import type { EtlClassReport, EtlPlan } from './etl-plan.js'

type Json = Record<string, unknown>

export interface EtlToolDeps {
  readonly ctx: HostContext
}

function text(lines: string[]): ContentBlock[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

const PROJECT_ROOT_PARAM = {
  type: 'string',
  description:
    'Absolute path of the InkFlow project root. Omit to resolve from the session working directory (walks up to the nearest project). An explicit path must live inside the session working directory.',
} as const

const SUCCESS_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: true,
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`
}

/** The 13-class table: legacy rows, what the plan does with them, and the ≤1% verdict. */
function classLines(classes: readonly EtlClassReport[]): string[] {
  const lines = ['| 旧库表 | 行数 | 已映射 | 无落点 | 丢失 | 偏差 | ≤1% |', '|---|---|---|---|---|---|---|']
  for (const entry of classes) {
    lines.push(
      `| ${entry.table} | ${String(entry.legacyRows)} | ${String(entry.mapped)} | ${String(entry.dropped)} | ${String(entry.lost)} | ${percent(
        entry.deviation,
      )} | ${entry.ok ? '✓' : '✗'} |`,
    )
  }
  return lines
}

function planLines(plan: EtlPlan): string[] {
  const lines: string[] = []
  const source = plan.source
  lines.push(
    `旧库：${source.db} · 项目「${source.projectName}」${source.projectUuid === undefined ? '' : `（${source.projectUuid}）`} · 章号策略 ${
      plan.options.renumber === 'keep' ? '保留（默认）' : '重排'
    }`,
  )
  lines.push(
    `计划产出 ${String(plan.totals.plannedFiles)} 个文件：待写 ${String(plan.totals.write)} · 已迁过 ${String(plan.totals.migrated)} · 跳过 ${String(
      plan.totals.conflict,
    )} · 正文 ${String(plan.totals.chars)} 字`,
  )
  lines.push('')
  lines.push(...classLines(plan.classes))
  lines.push('')
  const entities = plan.reconcile.entities
  const chars = plan.reconcile.chars
  lines.push(
    `抽样对账：实体 ${String(entities.legacy)} → 计入 ${String(entities.planned)}（无落点 ${String(entities.dropped)} · 丢失 ${String(
      entities.lost,
    )} · 偏差 ${percent(entities.deviation)}，阈值 ${percent(entities.threshold)} → ${entities.ok ? '成立' : '不成立'}）`,
  )
  lines.push(
    `　　　　　字数 ${String(chars.legacy)} → ${String(chars.planned)}（偏差 ${percent(chars.deviation)}，阈值 ${percent(chars.threshold)} → ${
      chars.ok ? '成立' : '不成立'
    }）`,
  )

  if (plan.gaps.length > 0) {
    lines.push('')
    lines.push('章号断层（**不自动重排**，由你裁决「保留」或「重排」）：')
    for (const gap of plan.gaps) {
      const scope = gap.scope === 'loose' ? '散章' : gap.scope
      lines.push(`- ${scope}：有 ${String(gap.present.length)} 章，缺 ${gap.missing.length} 个号 → 缺 ${gap.missing.join(', ')}`)
    }
  }

  if (plan.decisions.length > 0) {
    lines.push('')
    lines.push('要你裁决的事（迁移器只报告，不替你决定）：')
    for (const decision of plan.decisions) {
      lines.push(`- ${decision.code} × ${String(decision.count)}：${decision.detail}`)
      lines.push(`  下一步：${decision.hint}`)
    }
  }

  if (plan.warnings.length > 0) {
    lines.push('')
    for (const warning of plan.warnings) lines.push(`注意：${warning}`)
  }

  for (const entry of plan.classes) {
    if (entry.notes.length === 0) continue
    lines.push('')
    lines.push(`${entry.table} 明细：`)
    for (const note of entry.notes) lines.push(`- ${note}`)
  }
  return lines
}

function errorValue(root: string, error: EtlError): Json {
  return {
    ok: false,
    root,
    error: {
      code: error.code,
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.lockHolder === undefined ? {} : { lockHolder: error.lockHolder }),
      ...(error.rolledBack === undefined ? {} : { rolledBack: error.rolledBack }),
      ...(error.rollback === undefined ? {} : { rollback: error.rollback }),
    },
  }
}

/** Everything both tools take: the two data locations, plus the two policy knobs. */
const SHARED_PARAMS = {
  sourcePath: {
    type: 'string',
    description:
      'Absolute path of the OLD InkFlow database (the `.db` inside the old data directory, e.g. …\\inkflow\\inkflow.db). It is opened read-only and never modified.',
  },
  project: {
    type: 'string',
    description:
      'Which book inside the old database: its uuid, its exact name, a unique part of the name, or its number. Omit for the project with the most content.',
  },
  renumber: {
    type: 'string',
    enum: ['keep', 'compact'],
    description:
      'Chapter numbering. `keep` (default) preserves the old numbers, gaps included; `compact` renumbers 1..N over the reading order. Never applied unless asked.',
  },
  batchSize: {
    type: 'number',
    description:
      'Files moved per write-lock acquisition (default 25). The lock is released between batches, so the GUI can keep saving while a long migration runs.',
  },
} as const

export function etlTools(deps: EtlToolDeps): ToolDefinition[] {
  const plan: ToolDefinition = {
    name: 'inkflow_etl_plan',
    description:
      'Read-only plan for migrating an old InkFlow SQLite library into this book\'s file tree (13 legacy tables → chapters/ characters/ world/ outlines/ foreshadowing/ timeline/ relations/ library/). It reports, per legacy table, how many rows map where (the ≤1% entity and 0.5% character-count verdicts), the chapter-numbering gaps the old book has (kept, never renumbered silently), and every item the author has to decide (a foreshadow marked resolved with no chapter, a timeline date that is not a calendar date, a relation pointing at a missing entity). It also returns a `planToken` and the item set that `inkflow_etl_apply` compares against, so apply cannot write something the preview never showed. Writes NOTHING: the old database is opened read-only and the book is only stat\'ed.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        ...SHARED_PARAMS,
      },
      required: ['sourcePath'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          return text([
            `无法生成迁移计划：${String(error['code'] ?? '?')} — ${String(error['message'] ?? '')}`,
            ...(error['hint'] === undefined ? [] : [`下一步：${String(error['hint'])}`]),
          ])
        }
        const p = v['plan'] as unknown as EtlPlan
        const lines = planLines(p)
        lines.push('')
        lines.push(`确认后执行：inkflow_etl_apply action="apply" confirm=true planToken="${p.planToken}"`)
        lines.push(`迁移完成后由你自己提交：${p.commitSuggestion}`)
        return text(lines)
      },
    },
    execute: async (args, exec: ToolRunContext) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const sourcePath = optionalString(a['sourcePath'])
      if (sourcePath === undefined) {
        return {
          ok: false,
          root: probe.root,
          error: {
            code: 'ETL_SOURCE_REQUIRED',
            message: 'pass sourcePath: the .db file of the old InkFlow data directory',
            hint: 'the old file is read-only to the plugin; nothing in the book changes while planning',
          },
        }
      }
      const planned = planEtl(probe.root, {
        sourcePath,
        ...(optionalString(a['project']) === undefined ? {} : { project: optionalString(a['project']) ?? '' }),
        ...(a['renumber'] === 'compact' ? { renumber: 'compact' as const } : a['renumber'] === 'keep' ? { renumber: 'keep' as const } : {}),
      })
      if (!planned.ok) return errorValue(probe.root, planned.error)
      return { ok: true, root: probe.root, plan: planned.plan }
    },
  }

  const apply: ToolDefinition = {
    name: 'inkflow_etl_apply',
    description:
      'Run (or undo) the old-library migration planned by `inkflow_etl_plan`. `action: "apply"` needs confirm: true: it re-computes the same plan, compares its item set with the preview\'s (a row that disappeared or changed is skipped and reported, never silently replaced), stages every file under a backup package in .inkflow/backup/<stamp>/staging/, then moves them into place one lock-batch at a time so the GUI can keep writing. It records the (table, id) → path map in .inkflow/backup/etl-idmap.json, so running it twice writes zero files, and it never runs `git`: the baseline commit comes back as a string for the author to run. `action: "rollback"` (also confirm: true) removes exactly the files that run created — a file edited afterwards is a BACKUP_CONFLICT, not a casualty — and reports the package it undid. A target path that already holds other bytes is always skipped.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        action: {
          type: 'string',
          enum: ['apply', 'rollback'],
          description: 'apply = migrate (the default); rollback = undo one package.',
        },
        ...SHARED_PARAMS,
        confirm: {
          type: 'boolean',
          description: 'Required. Both actions write or delete files.',
        },
        planToken: {
          type: 'string',
          description:
            'The `planToken` from inkflow_etl_plan. A mismatch is ETL_PLAN_STALE and nothing is written.',
        },
        backup: {
          type: 'string',
          description: 'rollback only: the package directory name the apply returned (20261025T…Z), or its project-relative path.',
        },
      },
      required: ['action', 'confirm'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          const lines = [`迁移未完成：${String(error['code'] ?? '?')} — ${String(error['message'] ?? '')}`]
          if (error['hint'] !== undefined) lines.push(`下一步：${String(error['hint'])}`)
          const holder = asRecord(error['lockHolder'])
          if (holder['pid'] !== undefined) {
            lines.push(
              `写锁持有者：pid ${String(holder['pid'])}（自 ${String(holder['startedAt'] ?? '?')} 起）—— 等它写完再重跑，本工具不会替你抢锁。`,
            )
          }
          const rollback = asRecord(error['rollback'])
          if (rollback['dir'] !== undefined) {
            lines.push(`已落盘的文件都在备份包里：${String(rollback['dir'])}（可 rollback，或直接重跑续上已迁过的条目）`)
          }
          return text(lines)
        }

        if (v['action'] === 'rollback') {
          return text([
            `已回滚 ${String(v['backup'] ?? '?')}：删掉 ${String((v['removed'] as unknown[] | undefined)?.length ?? 0)} 个本轮新建的文件，恢复 ${String(
              (v['restored'] as unknown[] | undefined)?.length ?? 0,
            )} 个，清理暂存副本 ${String(v['stagingCleared'] ?? 0)} 个。`,
            '书回到迁移前的状态；映射表仍在（下次 apply 会重新计算）。',
          ])
        }

        const p = v['plan'] as unknown as EtlPlan
        const backup = asRecord(v['backup'])
        const idmap = asRecord(v['idmap'])
        const catalog = asRecord(v['catalog'])
        const index = asRecord(v['index'])
        const invariants = asRecord(v['invariants'])
        const lines: string[] = []
        lines.push(
          `已迁移：写 ${String((v['written'] as unknown[] | undefined)?.length ?? 0)} 个文件 · 跳过 ${String(
            (v['skipped'] as unknown[] | undefined)?.length ?? 0,
          )} · 已迁过 ${String(p.totals.migrated)} · 冲突 ${String(p.totals.conflict)} · ${String(v['batches'] ?? 0)} 个锁批（每批 ${
            String(v['batchSize'] ?? 0)
          } 个文件）· 用时 ${Math.round(Number(v['ms'] ?? 0))} ms`,
        )
        lines.push(
          `备份包 ${String(backup['dir'] ?? '?')}（${String(backup['files'] ?? 0)} 个文件，${backup['sealed'] === true ? '已封包' : '未封包'}）· 映射表 ${
            String(idmap['path'] ?? '?')
          } 共 ${String(idmap['entries'] ?? 0)} 条`,
        )
        lines.push(
          `目录投影：catalog ${catalog['ok'] === true ? '已重建' : '失败'} · 索引 ${index['ok'] === true ? '已重建' : `失败（${String(asRecord(index['error'])['code'] ?? '?')}）`}`,
        )
        lines.push(
          `改完后的不变量体检：${String(invariants['issues'] ?? 0)} 条发现${
            Object.keys(asRecord(invariants['codes'])).length === 0
              ? ''
              : `（${Object.entries(asRecord(invariants['codes']))
                  .map(([code, count]) => `${code}×${String(count)}`)
                  .join('、')}）`
          }`,
        )
        const skipped = (v['skipped'] as Json[] | undefined) ?? []
        if (skipped.length > 0) {
          lines.push('')
          lines.push('跳过的条目（集合比较不一致的一份，永不静默替换）：')
          for (const entry of skipped.slice(0, 10)) lines.push(`- ${String(asRecord(entry)['key'])}：${String(asRecord(entry)['reason'])}`)
        }
        lines.push('')
        lines.push(`接下来由你提交（插件不跑 git）：${String(v['commitSuggestion'] ?? '')}`)
        if (p.decisions.length > 0) {
          lines.push('')
          lines.push('还要裁决的事：')
          for (const decision of p.decisions) lines.push(`- ${decision.code} × ${String(decision.count)}：${decision.hint}`)
        }
        return text(lines)
      },
    },
    execute: async (args, exec: ToolRunContext) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const action = optionalString(a['action']) ?? 'apply'
      if (action !== 'apply' && action !== 'rollback') {
        return {
          ok: false,
          root: probe.root,
          error: {
            code: 'ACTION_INVALID',
            message: `unknown action "${action}"`,
            hint: 'pass action: "apply" to migrate or action: "rollback" with the package name to undo',
          },
        }
      }
      if (typeof a['confirm'] !== 'boolean') {
        return {
          ok: false,
          root: probe.root,
          error: {
            code: 'CONFIRM_REQUIRED',
            message: 'confirm: true is required for both actions',
            hint: 'show the plan first, then call again with confirm: true',
          },
        }
      }

      if (action === 'rollback') {
        const undone = rollbackEtl(probe.root, {
          backup: optionalString(a['backup']) ?? '',
          confirm: a['confirm'],
        })
        if (!undone.ok) return errorValue(probe.root, undone.error)
        return {
          ok: true,
          root: probe.root,
          action: 'rollback',
          backup: undone.value.backup,
          restored: undone.value.restored,
          removed: undone.value.removed,
          dirsRemoved: undone.value.dirsRemoved,
          stagingCleared: undone.value.stagingCleared,
        }
      }

      const sourcePath = optionalString(a['sourcePath'])
      if (sourcePath === undefined) {
        return {
          ok: false,
          root: probe.root,
          error: {
            code: 'ETL_SOURCE_REQUIRED',
            message: 'pass sourcePath: the .db file of the old InkFlow data directory',
            hint: 'run inkflow_etl_plan first; it takes the same path',
          },
        }
      }
      const applied = await applyEtl(probe.root, {
        sourcePath,
        ...(optionalString(a['project']) === undefined ? {} : { project: optionalString(a['project']) ?? '' }),
        ...(a['renumber'] === 'compact' ? { renumber: 'compact' as const } : a['renumber'] === 'keep' ? { renumber: 'keep' as const } : {}),
        ...(typeof a['batchSize'] === 'number' ? { batchSize: a['batchSize'] } : {}),
        confirm: a['confirm'],
        ...(optionalString(a['planToken']) === undefined ? {} : { planToken: optionalString(a['planToken']) ?? '' }),
      })
      if (!applied.ok) return errorValue(probe.root, applied.error)
      return {
        ok: true,
        root: probe.root,
        action: 'apply',
        ...applied.value,
      }
    },
  }

  return [plan, apply]
}
