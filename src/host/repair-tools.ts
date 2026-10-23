/**
 * The maintenance tool surface (#36): `inkflow_project_repair` and
 * `inkflow_project_migrate`.
 *
 * Two tools, and both are deliberately **three-staged with an explicit confirm**,
 * because each one can touch many files at once:
 *
 *   * `inkflow_project_repair` — `detect` (read), `preview` (read: the action list),
 *     `fix` (write, needs `confirm: true`). Every action is addressable with
 *     `select`, so "fix only this one" is one call.
 *   * `inkflow_project_migrate` — `plan` (read), `apply` (write, needs `confirm:
 *     true`), `rollback` (needs `confirm: true` and the package name the plan or the
 *     apply returned).
 *
 * Why they live apart from `tools.ts`: that file is the built-in surface for
 * chapters/volumes/index, and it is already over the 600-line convention. These two
 * tools are one maintenance domain (the same two private-state subdirectories, the
 * same report renderer), so they ship together and `tools.ts` gains two lines.
 *
 * Neither tool re-implements the gate: `resolveMaintenanceRoot()` below mirrors
 * `resolveProject()`, but a book that is **not usable yet** must still be repairable
 * and migratable — that is the whole point of this pair — so a `needs-repair` state
 * passes through. `needs-setup` and `needs-newer-plugin` do not (there is nothing to
 * fix, or nothing that may be written).
 */

import type { ContentBlock, HostContext, JsonSchemaNode, ToolDefinition, ToolRunContext } from './context.js'
import { checkProjectRootScope, findProjectRoot, inspectProject } from './project.js'
import type { ProjectProbe } from './project.js'
import { applyRepair, detectFindings, planRepair } from './repair.js'
import { applyMigration, planMigration, rollbackMigration } from './migrate.js'
import { sessionCwd } from './session-cwd.js'

type Json = Record<string, unknown>

export interface RepairToolDeps {
  readonly ctx: HostContext
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
    'Absolute path of the InkFlow project root. Omit to resolve from the session working directory (walks up to the nearest project). An explicit path must live inside the session working directory.',
} as const

const SUCCESS_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: true,
}

const SELECT_PARAM = {
  type: 'array',
  items: { type: 'string' },
  description:
    'Which actions to run, by action key (`patch-frontmatter|facts/qingyin.md`), finding key (`FRONTMATTER_ISSUE|facts/qingyin.md`) or bare code (`CATALOG_STALE`). Omit for every fixable finding.',
} as const

const CONFIRM_PARAM = {
  type: 'boolean',
  description: 'Set true only after the user has seen the action list and agreed. Without it nothing is written.',
} as const

interface Resolution {
  cwd: string
  root: string
  probe?: ProjectProbe
  rejection?: { code: string; message: string }
}

/**
 * Resolve the book for a maintenance call.
 *
 * Same trust anchor as every other tool (the session working directory), but
 * `recreateIndexDir: false`: a `detect`/`plan` stage must not create `index/` on its
 * way in, and a book whose `index/` is missing is exactly one of the things the
 * migration fixes.
 */
async function resolveMaintenanceRoot(deps: RepairToolDeps, argumentRoot: unknown, exec: ToolRunContext): Promise<Resolution> {
  const cwd = await sessionCwd(deps.ctx, exec)
  if (typeof argumentRoot === 'string' && argumentRoot.trim() !== '') {
    const root = argumentRoot.trim()
    const rejection = checkProjectRootScope(root, cwd)
    if (rejection !== undefined) return { cwd, root, rejection: { code: rejection.code, message: rejection.message } }
    return { cwd, root, probe: inspectProject(root, { recreateIndexDir: false }) }
  }
  const found = findProjectRoot(cwd)
  const root = found ?? cwd
  return { cwd, root, probe: inspectProject(root, { recreateIndexDir: false }) }
}

function gateRefusal(resolution: Resolution): Json | undefined {
  if (resolution.rejection !== undefined) {
    return { ok: false, root: resolution.root, error: { ...resolution.rejection } }
  }
  const probe = resolution.probe
  if (probe === undefined) return undefined
  if (probe.state === 'needs-newer-plugin') {
    return {
      ok: false,
      root: probe.root,
      state: probe.state,
      error: {
        code: 'PROJECT_NEEDS_NEWER_PLUGIN',
        message: probe.metaError ?? 'this book was written by a newer plugin',
        hint: 'tell the user to upgrade dsh-inkflow; an older plugin must not rewrite a newer book',
      },
    }
  }
  if (probe.state === 'needs-setup') {
    return {
      ok: false,
      root: probe.root,
      state: probe.state,
      error: {
        code: 'NOT_AN_INKFLOW_PROJECT',
        message: 'this directory has no InkFlow layout and no inkflow.json',
        hint: 'run inkflow_project_plan, then inkflow_project_init — there is nothing to repair yet',
      },
    }
  }
  return undefined
}

/** One line per finding, as the renderer receives them (plain records, not `Finding`). */
function findingsLines(findings: readonly Json[], limit = 40): string[] {
  const lines: string[] = []
  for (const finding of findings.slice(0, limit)) {
    const locator = asRecord(finding['locator'])
    const where = typeof locator['path'] === 'string' ? locator['path'] : ''
    const severity = finding['fixable'] === true ? '[fixable]' : '[manual] '
    lines.push(`- ${severity} ${String(finding['code'] ?? '')} @ ${where} — ${String(finding['detail'] ?? '')}`)
  }
  if (findings.length > limit) lines.push(`… ${String(findings.length - limit)} more (see the report)`)
  return lines
}

export function repairTools(deps: RepairToolDeps): ToolDefinition[] {
  const repair: ToolDefinition = {
    name: 'inkflow_project_repair',
    description:
      'Detect and fix structural problems in the InkFlow book: three separately runnable stages. `detect` lists the findings ' +
      '(frontmatter, duplicate ids, dangling parents, relation endpoints/duplicates, catalog drift, outline nesting, world ' +
      'categories); `preview` adds the exact repair action list without writing anything; `fix` executes it and needs ' +
      'confirm: true. Only additive or projection-level repairs are performed: a missing frontmatter key is appended, an ' +
      'outline is re-attached, a duplicate relation file is removed, `chapters/index.json` is rebuilt from the `.md` files. ' +
      'Codes the finding catalogue marks as not auto-fixable are reported with a reason, never "fixed" by inventing data. ' +
      'Every touched file is copied into `.inkflow/backup/<stamp>/` first and a report is written to ' +
      '`.inkflow/audit/repair-<stamp>.md`, then the checks are re-run to prove the fix landed.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        action: {
          type: 'string',
          enum: ['detect', 'preview', 'fix'],
          description:
            'detect = list findings (read-only); preview = findings plus the repair actions (read-only); fix = execute them (needs confirm: true).',
        },
        select: SELECT_PARAM,
        confirm: CONFIRM_PARAM,
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          const lines = [`Repair ${String(v['action'] ?? '')} did not run: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
          if (v['requiresConfirmation'] === true) {
            const actions = Array.isArray(v['actions']) ? (v['actions'] as Json[]) : []
            lines.push(`Planned actions (${String(actions.length)}):`)
            for (const action of actions) lines.push(`- ${String(action['kind'])} ${String(action['path'])} — ${String(action['detail'])}`)
            lines.push('Nothing was written. Show these to the user, then call again with confirm: true.')
          }
          if (error['hint'] !== undefined) lines.push(String(error['hint']))
          return text(lines)
        }

        const findings = Array.isArray(v['findings']) ? (v['findings'] as Json[]) : []
        const actions = Array.isArray(v['actions']) ? (v['actions'] as Json[]) : []
        const skipped = Array.isArray(v['skipped']) ? (v['skipped'] as Json[]) : []
        const applied = Array.isArray(v['applied']) ? (v['applied'] as Json[]) : []
        const lines = [
          `Book: ${String(v['root'] ?? '')} (${String(v['action'] ?? '')})`,
          `Findings: ${String(findings.length)} · actions: ${String(actions.length)} · not auto-fixable: ${String(skipped.length)}`,
        ]
        if (findings.length > 0) lines.push(...findingsLines(findings))
        if (actions.length > 0 && applied.length === 0) {
          lines.push('Planned actions:')
          for (const action of actions) lines.push(`- ${String(action['kind'])} ${String(action['path'])} — ${String(action['detail'])}`)
          lines.push('Nothing was written (preview). Show this to the user, then call again with confirm: true.')
        }
        if (applied.length > 0) {
          lines.push('Applied:')
          for (const outcome of applied) {
            const action = asRecord(outcome['action'])
            const ok = outcome['ok'] === true
            lines.push(
              `- ${ok ? 'ok  ' : 'FAIL'} ${String(action['kind'])} ${String(action['path'])} — ${
                ok ? String(outcome['detail'] ?? '') : `${String(asRecord(outcome['error'])['code'] ?? '')} ${String(asRecord(outcome['error'])['message'] ?? '')}`
              }`,
            )
          }
        }
        const backup = v['backup'] === undefined ? undefined : asRecord(v['backup'])
        if (backup !== undefined) {
          lines.push(`Backup: ${String(backup['dir'] ?? '')} (roll back with inkflow_project_migrate action rollback)`)
        }
        const cleared = Array.isArray(v['cleared']) ? (v['cleared'] as unknown[]).map(String) : []
        if (applied.length > 0 || cleared.length > 0) {
          lines.push(`Re-check: ${String(cleared.length)} finding(s) gone, ${String(v['remainingCount'] ?? 0)} left`)
        }
        const report = v['report'] === undefined ? undefined : asRecord(v['report'])
        if (report !== undefined && report['path'] !== undefined) lines.push(`Report: ${String(report['path'])}`)
        for (const skip of skipped.slice(0, 20)) {
          lines.push(`- [not fixed] ${String(skip['code'])} — ${String(skip['reason'])}`)
        }
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const action = typeof a['action'] === 'string' ? (a['action'] as string) : 'detect'
      const resolved = await resolveMaintenanceRoot(deps, a['projectRoot'], exec)
      const refusal = gateRefusal(resolved)
      if (refusal !== undefined) return refusal
      const root = resolved.probe?.root ?? resolved.root
      const select = Array.isArray(a['select']) ? (a['select'] as unknown[]).filter((item): item is string => typeof item === 'string') : undefined

      if (action === 'detect') {
        const detected = detectFindings(root)
        return { ok: true, root, action, findings: detected.findings, summary: detected.summary, unknown: detected.unknown, files: detected.files }
      }
      if (action === 'preview') {
        const planned = planRepair(root, { select })
        return {
          ok: true,
          root,
          action,
          findings: planned.detect.findings,
          summary: planned.detect.summary,
          actions: planned.actions,
          skipped: planned.skipped,
          projections: planned.projections,
          nothingWritten: true,
        }
      }
      if (action !== 'fix') {
        return { ok: false, root, action, error: { code: 'ACTION_INVALID', message: `unknown action "${action}"`, hint: 'use detect, preview or fix' } }
      }

      const result = applyRepair(root, { select, confirm: a['confirm'] === true })
      const base = {
        root: result.root,
        action,
        findings: result.before.findings,
        summary: result.before.summary,
        actions: result.plan.actions,
        skipped: result.plan.skipped,
      }
      if (result.requiresConfirmation === true) {
        return { ok: false, ...base, requiresConfirmation: true, error: result.error }
      }
      if (result.after === undefined) {
        return { ok: result.ok, ...base, applied: [], remainingCount: result.remaining.length, error: result.error }
      }
      return {
        ok: result.ok,
        ...base,
        applied: result.applied,
        cleared: result.cleared,
        remaining: result.remaining,
        remainingCount: result.remaining.length,
        ...(result.backup === undefined ? {} : { backup: result.backup }),
        ...(result.report === undefined ? {} : { report: result.report }),
        ...(result.error === undefined ? {} : { error: result.error }),
      }
    },
  }

  const migrate: ToolDefinition = {
    name: 'inkflow_project_migrate',
    description:
      'Migrate a legacy six-directory InkFlow book (`chapters/ characters/ world/ outlines/ library/ index/` + inkflow.json) to ' +
      'the current layout (nine content directories + index/, each with a .gitkeep, the derived-index .gitignore lines and an ' +
      'inkflow.json schemaVersion bump). Three stages: `plan` returns the exact action list and writes nothing; `apply` executes ' +
      'it (needs confirm: true) after copying every file it will modify into `.inkflow/backup/<stamp>/`; `rollback` puts that ' +
      'package back (needs confirm: true and the backup name). Nothing is moved, renamed or rewritten except `.gitignore` ' +
      '(append-only) and `inkflow.json` (schemaVersion only) — chapter, character, world, outline and library files keep their ' +
      'bytes. `git init` keeps its existing boundary: no add, commit, remote or identity config.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        action: {
          type: 'string',
          enum: ['plan', 'apply', 'rollback'],
          description: 'plan = the action list (read-only); apply = execute it (needs confirm: true); rollback = undo one backup package.',
        },
        backup: {
          type: 'string',
          description:
            'rollback only: the package to undo, either its directory name (`20261024T015500123Z`) or `.inkflow/backup/<name>`. `plan` lists the packages it can see.',
        },
        confirm: CONFIRM_PARAM,
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        const actions = Array.isArray(v['actions']) ? (v['actions'] as Json[]) : []
        const applied = Array.isArray(v['applied']) ? (v['applied'] as unknown[]).map(String) : []
        const lines = [`Book: ${String(v['root'] ?? '')} (${String(v['action'] ?? '')}) — state ${String(v['state'] ?? '?')}${v['legacy'] === true ? ' (legacy six-directory layout)' : ''}`]
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          lines.push(`Did not run: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`)
          if (v['requiresConfirmation'] === true) {
            lines.push(`Planned steps (${String(actions.length)}):`)
            for (const action of actions) lines.push(`- ${String(action['op'])} ${String(action['path'])} — ${String(action['detail'])}`)
            lines.push('Nothing was written. Show these to the user, then call again with confirm: true.')
          }
          if (error['hint'] !== undefined) lines.push(String(error['hint']))
          const restored = Array.isArray(v['restored']) ? (v['restored'] as unknown[]).map(String) : []
          if (restored.length > 0) lines.push(`Restored: ${restored.join(', ')}`)
          return text(lines)
        }

        if (v['action'] === 'rollback') {
          const restored = Array.isArray(v['restored']) ? (v['restored'] as unknown[]).map(String) : []
          const removed = Array.isArray(v['removed']) ? (v['removed'] as unknown[]).map(String) : []
          const dirs = Array.isArray(v['dirsRemoved']) ? (v['dirsRemoved'] as unknown[]).map(String) : []
          lines.push(`Rolled back ${String(v['backup'] ?? '')}: restored ${String(restored.length)}, removed ${String(removed.length)}, directories ${String(dirs.length)}`)
          if (restored.length > 0) lines.push(`restored: ${restored.join(', ')}`)
          if (removed.length > 0) lines.push(`removed: ${removed.join(', ')}`)
          const report = v['report'] === undefined ? undefined : asRecord(v['report'])
          if (report !== undefined && report['path'] !== undefined) lines.push(`Report: ${String(report['path'])}`)
          return text(lines)
        }

        lines.push(actions.length === 0 ? 'Nothing to do.' : `Steps (${String(actions.length)}):`)
        for (const action of actions) lines.push(`- ${String(action['op'])} ${String(action['path'])} — ${String(action['detail'])}`)
        if (applied.length > 0) lines.push(`Applied ${String(applied.length)} step(s): ${applied.join('; ')}`)
        else if (v['action'] === 'plan') lines.push('Nothing was written (dry run). Show this list to the user, then call again with action apply and confirm: true.')
        const backup = v['backup'] === undefined ? undefined : asRecord(v['backup'])
        if (backup !== undefined) lines.push(`Backup: ${String(backup['dir'] ?? '')}`)
        const backups = Array.isArray(v['backups']) ? (v['backups'] as Json[]) : []
        if (backups.length > 0) lines.push(`Existing packages: ${backups.map((entry) => String(entry['dir'])).join(', ')}`)
        const report = v['report'] === undefined ? undefined : asRecord(v['report'])
        if (report !== undefined && report['path'] !== undefined) lines.push(`Report: ${String(report['path'])}`)
        for (const notice of (Array.isArray(v['notices']) ? v['notices'] : []).map(String)) lines.push(`Note: ${notice}`)
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const action = typeof a['action'] === 'string' ? (a['action'] as string) : 'plan'
      const resolved = await resolveMaintenanceRoot(deps, a['projectRoot'], exec)
      const refusal = gateRefusal(resolved)
      if (refusal !== undefined) return refusal
      const root = resolved.probe?.root ?? resolved.root

      if (action === 'plan') {
        const planned = planMigration(root)
        return {
          ok: planned.blocked === undefined,
          root,
          action,
          state: planned.state,
          legacy: planned.legacy,
          actions: planned.actions,
          notices: planned.notices,
          backups: planned.backups,
          nothingWritten: true,
          ...(planned.blocked === undefined ? {} : { error: planned.blocked }),
        }
      }
      if (action === 'apply') {
        const result = applyMigration(root, { confirm: a['confirm'] === true })
        return {
          ok: result.ok,
          root: result.root,
          action,
          state: result.stateAfter ?? result.stateBefore,
          legacy: result.plan.legacy,
          actions: result.plan.actions,
          applied: result.applied,
          skipped: result.skipped,
          notices: result.notices,
          backups: result.plan.backups,
          ...(result.backup === undefined ? {} : { backup: result.backup }),
          ...(result.report === undefined ? {} : { report: result.report }),
          ...(result.partial === true ? { partial: true } : {}),
          ...(result.requiresConfirmation === true ? { requiresConfirmation: true } : {}),
          ...(result.error === undefined ? {} : { error: result.error }),
        }
      }
      if (action === 'rollback') {
        const backup = typeof a['backup'] === 'string' ? a['backup'].trim() : ''
        if (backup === '') {
          return {
            ok: false,
            root,
            action,
            backups: planMigration(root).backups,
            error: {
              code: 'BACKUP_REQUIRED',
              message: 'rollback needs the backup package to undo',
              hint: 'call action plan to list the packages under .inkflow/backup/, then pass one as `backup`',
            },
          }
        }
        if (a['confirm'] !== true) {
          return {
            ok: false,
            root,
            action,
            requiresConfirmation: true,
            backup,
            error: {
              code: 'ROLLBACK_REQUIRES_CONFIRMATION',
              message: `nothing was written: rolling back ${backup} restores every file in that package`,
              hint: 'show the package name to the user, then call again with confirm: true',
            },
          }
        }
        const rolled = rollbackMigration(root, { backup })
        return {
          ok: rolled.ok,
          root: rolled.root,
          action,
          backup: rolled.backup,
          restored: rolled.restored,
          removed: rolled.removed,
          dirsRemoved: rolled.dirsRemoved,
          kept: rolled.kept,
          ...(rolled.report === undefined ? {} : { report: rolled.report }),
          ...(rolled.error === undefined ? {} : { error: rolled.error }),
        }
      }
      return { ok: false, root, action, error: { code: 'ACTION_INVALID', message: `unknown action "${action}"`, hint: 'use plan, apply or rollback' } }
    },
  }

  return [repair, migrate]
}
