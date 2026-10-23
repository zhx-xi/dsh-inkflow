/**
 * The 6→9 directory migrator (#36): a legacy six-directory book → the current
 * nine content directories plus `index/`.
 *
 * What a legacy book actually is: the same `inkflow.json`, the same `chapters/`
 * `characters/` `world/` `outlines/` `library/` `index/`, and **no**
 * `foreshadowing/` `timeline/` `relations/` `facts/`. So the migration is
 * structurally an *addition* — nothing is moved, nothing is renamed, and no
 * content file is rewritten. That is why "只补不改" is checkable here at all: the
 * only files whose bytes can change are the two **metadata** files
 * (`inkflow.json` for a `schemaVersion` bump, `.gitignore` for the derived-index
 * lines), and a run that changes anything else is a bug.
 *
 * Four contracts this module is built around:
 *
 *   1. **Dry run and execution are the same list.** `planMigration()` produces the
 *      actions; `applyMigration()` re-plans and reports, per step, whether it
 *      actually changed something. The two lists are compared as *sets* in the
 *      tests, so a step that silently does nothing cannot hide behind a count.
 *   2. **Snapshot before the first write.** `<book>/.inkflow/backup/<stamp>/`
 *      holds copies of every file the run will modify and a manifest with the
 *      digest each one had and the digest it got (`backup.ts`). The manifest is
 *      written *before* the change, so an interrupted run still leaves a usable
 *      journal.
 *   3. **No auto-rollback — a journaled one instead.** The wizard (`workspace.ts`)
 *      undoes an apply in memory because its actions only *create* things. A
 *      migration edits two existing files, so its undo has to survive the process:
 *      on a mid-run failure the caller gets the partial state, the backup handle and
 *      a rollback step, and the rollback replays from the manifest. (ADR-0015 keeps
 *      the comparison to the wizard's choice.)
 *   4. **`git init` boundary unchanged** (ADR-0006 D4 / conventions §6.4): init
 *      only — never `add`, `commit`, `remote`, identity or branch config. A rollback
 *      deliberately leaves `.git` in place (see `kept` in `backup.ts`).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { relative as relativePath, resolve } from 'node:path'

import {
  digestRelative,
  newBackupBody,
  openBackup,
  rollbackBackup,
  sealBackup,
  stageFile,
} from './backup.js'
import type { BackupBody, BackupHandle } from './backup.js'
import { listBackups } from './backup.js'
import { FILE_SCHEMA_VERSION } from './conventions.js'
import { inspectProject, missingGitignoreLines, readMeta } from './project.js'
import type { ProjectState } from './project.js'
import { migrationReportMarkdown, writeAuditReport } from './repair-report.js'
import type { ReportAction } from './repair-report.js'
import { planWorkspace } from './workspace.js'

/** One executable migration step. `path` is project-relative; `''` means the repository root. */
export type MigrationOp = 'git-init' | 'create-dir' | 'create-gitkeep' | 'append-gitignore' | 'write-meta'

export interface MigrationAction {
  op: MigrationOp
  path: string
  detail: string
}

export interface MigrationBlock {
  code: string
  message: string
  hint: string
}

export interface MigrationPlan {
  root: string
  /** `true` when the layout still looks like the older six-directory shape. */
  legacy: boolean
  state: ProjectState
  actions: MigrationAction[]
  notices: string[]
  /** Existing packages under `.inkflow/backup/`, newest first (for the rollback call). */
  backups: Array<{ dir: string; sealed: boolean; kind: string; files: number }>
  blocked?: MigrationBlock
}

export interface MigrationApplyResult {
  ok: boolean
  root: string
  plan: MigrationPlan
  /** `${op} ${path}` per step that actually changed something, in execution order. */
  applied: string[]
  /** Steps whose work was already in place (plan drift: never overwritten). */
  skipped: string[]
  backup?: { dir: string; manifestPath: string }
  stateBefore: ProjectState
  stateAfter?: ProjectState
  notices: string[]
  report?: { path: string; written: boolean; error?: string }
  /**
   * `true` when the run stopped in the middle: the steps before the failure stay
   * applied and `backup` is how they are undone.
   */
  partial?: boolean
  requiresConfirmation?: boolean
  error?: { code: string; message: string; hint?: string; nothingWritten?: boolean }
}

export interface RollbackOutcome {
  ok: boolean
  root: string
  backup: string
  restored: string[]
  removed: string[]
  dirsRemoved: string[]
  kept: Array<{ path: string; reason: string }>
  report?: { path: string; written: boolean; error?: string }
  error?: { code: string; message: string; hint?: string }
}

/** The four directories a legacy book does not have yet (roadmap §2.2 / ADR-0006 D1). */
const NEW_ONLY_DIRS = ['foreshadowing', 'timeline', 'relations', 'facts'] as const

/** The directories the older six-directory layout carried (its "content" half). */
const LEGACY_DIRS = ['chapters', 'characters', 'world', 'outlines', 'library'] as const

function relOf(root: string, absolute: string): string {
  const relative = relativePath(root, absolute)
  return relative.split('\\').join('/')
}

/**
 * The read-only plan: what the migration would do, and whether it is allowed.
 *
 * Composed from `planWorkspace()` on purpose: "what is missing" has exactly one
 * implementation (the gate + wizard), and a second copy here would drift the first
 * time the directory contract moves. What this function adds is the one action the
 * wizard never performs — a `schemaVersion` bump — and the legacy-layout verdict.
 */
export function planMigration(projectRoot: string): MigrationPlan {
  const root = resolve(projectRoot)
  const workspace = planWorkspace(root)
  const probe = inspectProject(root, { recreateIndexDir: false })
  const meta = readMeta(root).meta

  const legacy =
    probe.checks.meta &&
    LEGACY_DIRS.some((name) => probe.checks.dirs[name] === true) &&
    NEW_ONLY_DIRS.some((name) => probe.checks.dirs[name] !== true)

  const actions: MigrationAction[] = []
  let blocked: MigrationBlock | undefined
  if (probe.state === 'needs-newer-plugin') {
    blocked = {
      code: 'PROJECT_NEEDS_NEWER_PLUGIN',
      message: probe.metaError ?? 'this book was written by a newer plugin',
      hint: 'upgrade dsh-inkflow; an older plugin must not rewrite a newer book, not even its directories',
    }
  } else if (!probe.checks.meta) {
    blocked = {
      code: 'META_INVALID',
      message: `inkflow.json is missing or unreadable (${probe.metaError ?? 'unknown reason'})`,
      hint: 'this is not a legacy book that can be migrated: run inkflow_project_plan / inkflow_project_init, which asks for the title first',
    }
  } else if (probe.state === 'needs-setup') {
    blocked = {
      code: 'NOT_A_BOOK',
      message: 'this directory has no InkFlow layout and no inkflow.json',
      hint: 'nothing to migrate: run inkflow_project_plan, then inkflow_project_init',
    }
  } else {
    for (const action of workspace.actions) {
      if (action.type === 'manual') continue
      if (action.type === 'create-meta') {
        // Only reachable when the meta is invalid, which is blocked above.
        continue
      }
      const path = action.type === 'git-init' ? '' : relOf(root, action.path)
      // The wizard names the step by what it creates; a migration names it by what
      // it does to an existing file (`append-only`, never a rewrite).
      const op: MigrationOp = action.type === 'create-gitignore' ? 'append-gitignore' : action.type
      actions.push({ op, path, detail: action.reason })
    }
    const version = meta?.schemaVersion
    if (version !== undefined && version < FILE_SCHEMA_VERSION) {
      actions.push({
        op: 'write-meta',
        path: 'inkflow.json',
        detail: `schemaVersion ${String(version)} → ${String(FILE_SCHEMA_VERSION)} (only that field is rewritten)`,
      })
    }
  }

  return {
    root,
    legacy,
    state: probe.state,
    actions,
    notices: workspace.notices,
    backups: listBackups(root).map((entry) => ({
      dir: entry.dir,
      sealed: entry.sealed,
      kind: entry.kind,
      files: entry.files,
    })),
    ...(blocked === undefined ? {} : { blocked }),
  }
}

/** `git init` exactly as the wizard runs it: no flags, no config, no remote (ADR-0006 D4). */
function gitInit(root: string): { ok: true } | { ok: false; message: string } {
  const result = spawnSync('git', ['init'], { cwd: root, stdio: 'ignore', windowsHide: true })
  if (result.error !== undefined) return { ok: false, message: result.error.message }
  if (result.status !== 0) return { ok: false, message: `git init exited with status ${String(result.status)}` }
  return { ok: true }
}

/** Append the derived-index ignore rules, keeping every existing line and its order. */
function appendGitignore(root: string): { ok: true; text: string } | { ok: false; message: string } {
  const file = resolve(root, '.gitignore')
  let existing = ''
  try {
    existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  } catch (cause) {
    return { ok: false, message: `.gitignore could not be read: ${String(cause)}` }
  }
  const missing = missingGitignoreLines(root)
  if (missing.length === 0) return { ok: false, message: 'the ignore rules are already there' }
  const header = existing === '' ? '# InkFlow derived index — rebuildable, never committed\n' : ''
  const prefix = existing === '' ? '' : existing.endsWith('\n') ? existing : `${existing}\n`
  return { ok: true, text: `${prefix}${header}${missing.join('\n')}\n` }
}

/**
 * Bump `schemaVersion` and nothing else.
 *
 * Unknown keys are preserved (a newer book may carry fields this build does not
 * know), and the file is written in the project's JSON convention: two-space
 * indent, LF, no BOM. The BOM is dropped deliberately — `readMeta` strips it on
 * read, so keeping it would mean writing a byte this plugin never produced.
 */
function bumpMeta(
  root: string,
): { ok: true; text: string } | { ok: false; message: string } {
  const file = resolve(root, 'inkflow.json')
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (cause) {
    return { ok: false, message: `inkflow.json could not be read: ${String(cause)}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    return { ok: false, message: 'inkflow.json is not valid JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'inkflow.json is not a JSON object' }
  }
  const next = { ...(parsed as Record<string, unknown>), schemaVersion: FILE_SCHEMA_VERSION }
  return { ok: true, text: `${JSON.stringify(next, null, 2)}\n` }
}

export interface MigrationApplyInput {
  /** Required for a write: the plan has to be shown first. */
  confirm?: boolean
  /** Injectable clock, so a test can pin the package and report names. */
  now?: Date
}

/**
 * Apply the plan: run the steps in order, snapshotting every file it will modify.
 *
 * No auto-rollback (see the module comment): a mid-run failure returns
 * `partial: true` together with the backup handle, and `rollbackMigration()`
 * replays the manifest. The alternative — reusing the wizard's in-memory undo —
 * would keep the recovery path inside the failing process, which is exactly what a
 * crash takes away.
 */
export function applyMigration(projectRoot: string, input: MigrationApplyInput = {}): MigrationApplyResult {
  const root = resolve(projectRoot)
  const plan = planMigration(root)
  const stateBefore = plan.state

  if (plan.blocked !== undefined) {
    return {
      ok: false,
      root,
      plan,
      applied: [],
      skipped: [],
      stateBefore,
      notices: plan.notices,
      error: { code: plan.blocked.code, message: plan.blocked.message, hint: plan.blocked.hint, nothingWritten: true },
    }
  }
  if (plan.actions.length === 0) {
    return { ok: true, root, plan, applied: [], skipped: [], stateBefore, notices: plan.notices }
  }
  if (input.confirm !== true) {
    return {
      ok: false,
      root,
      plan,
      applied: [],
      skipped: [],
      stateBefore,
      notices: plan.notices,
      requiresConfirmation: true,
      error: {
        code: 'MIGRATION_REQUIRES_CONFIRMATION',
        message: `nothing was written: ${String(plan.actions.length)} migration step(s) are planned`,
        hint: 'show the action list to the user, then call again with confirm: true',
        nothingWritten: true,
      },
    }
  }

  const now = input.now ?? new Date()
  const opened = openBackup(root, 'migrate', now)
  if (!opened.ok) {
    return {
      ok: false,
      root,
      plan,
      applied: [],
      skipped: [],
      stateBefore,
      notices: plan.notices,
      error: { code: opened.error.code, message: opened.error.message, nothingWritten: true },
    }
  }
  const handle: BackupHandle = opened.value
  const body: BackupBody = newBackupBody()
  const backup = { dir: handle.dir, manifestPath: handle.manifestPath }
  const described = sealBackup(root, handle, 'migrate', body, false, now)
  if (!described.ok) {
    return {
      ok: false,
      root,
      plan,
      applied: [],
      skipped: [],
      stateBefore,
      notices: plan.notices,
      error: { code: described.error.code, message: described.error.message, nothingWritten: true },
    }
  }

  const applied: string[] = []
  const skipped: string[] = []

  for (const action of plan.actions) {
    try {
      const changed = runStep(root, handle, action, body)
      if (changed) {
        applied.push(`${action.op} ${action.path}`.trim())
        body.steps.push(`${action.op} ${action.path}`.trim())
      } else {
        skipped.push(`${action.op} ${action.path}`.trim())
      }
    } catch (cause) {
      // A step failed: keep the partial state and the journal, and hand the caller
      // the one thing that can undo it.
      sealBackup(root, handle, 'migrate', body, false, now)
      const message = cause instanceof Error ? cause.message : String(cause)
      const report = writeAuditReport(
        root,
        `migrate-${stamp(now)}.md`,
        migrationReportMarkdown({
          root,
          at: now,
          stage: 'apply',
          actions: plan.actions.map(toReportAction),
          applied,
          backup,
          notices: plan.notices,
          before: stateBefore,
          error: { code: 'MIGRATION_STEP_FAILED', message },
        }),
      )
      return {
        ok: false,
        root,
        plan,
        applied,
        skipped,
        backup,
        stateBefore,
        notices: plan.notices,
        partial: true,
        report: { path: report.path, written: report.ok, ...(report.error === undefined ? {} : { error: report.error }) },
        error: {
          code: 'MIGRATION_STEP_FAILED',
          message,
          hint: `the steps above stayed applied; undo the whole run with action: rollback and backup: ${handle.dir.split('/').pop() ?? ''}`,
        },
      }
    }
  }

  sealBackup(root, handle, 'migrate', body, true, now)
  const after = inspectProject(root, { recreateIndexDir: false })
  const report = writeAuditReport(
    root,
    `migrate-${stamp(now)}.md`,
    migrationReportMarkdown({
      root,
      at: now,
      stage: 'apply',
      actions: plan.actions.map(toReportAction),
      applied,
      backup,
      notices: plan.notices,
      before: stateBefore,
      after: after.state,
    }),
  )

  return {
    ok: true,
    root,
    plan,
    applied,
    skipped,
    backup,
    stateBefore,
    stateAfter: after.state,
    notices: plan.notices,
    report: { path: report.path, written: report.ok, ...(report.error === undefined ? {} : { error: report.error }) },
  }
}

function toReportAction(action: MigrationAction): ReportAction {
  return { key: `${action.op}|${action.path}`, kind: action.op, path: action.path, codes: [], detail: action.detail }
}

function stamp(at: Date): string {
  const iso = at.toISOString()
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}${iso.slice(20, 23)}Z`
}

/**
 * Run one step and record what it changed. Returns `false` when the step found its
 * work already in place (plan drift never overwrites anything).
 */
function runStep(root: string, handle: BackupHandle, action: MigrationAction, body: BackupBody): boolean {
  switch (action.op) {
    case 'git-init': {
      const result = gitInit(root)
      if (!result.ok) throw new Error(`git init failed: ${result.message}`)
      // An empty repository is not data: a rollback leaves it (backup.ts `kept`).
      body.kept.push('.git')
      return true
    }
    case 'create-dir': {
      const target = resolve(root, action.path)
      if (existsSync(target)) return false
      mkdirSync(target, { recursive: true })
      body.dirs.push(action.path)
      return true
    }
    case 'create-gitkeep': {
      const target = resolve(root, action.path)
      if (existsSync(target)) return false
      const staged = stageFile(root, handle, action.path)
      if (!staged.ok) throw new Error(staged.error.message)
      writeFileSync(target, '', 'utf8')
      const after = digestRelative(root, action.path)
      if (after !== undefined) {
        body.files.push({ path: action.path, change: 'created', after })
      }
      return true
    }
    case 'append-gitignore': {
      const appended = appendGitignore(root)
      if (!appended.ok) throw new Error(appended.message)
      const staged = stageFile(root, handle, action.path)
      if (!staged.ok) throw new Error(staged.error.message)
      writeFileSync(resolve(root, action.path), appended.text, 'utf8')
      const after = digestRelative(root, action.path)
      if (after === undefined) throw new Error('.gitignore is gone after the write')
      body.files.push({
        path: action.path,
        change: staged.value === undefined ? 'created' : 'modified',
        ...(staged.value === undefined ? {} : { before: staged.value }),
        after,
      })
      return true
    }
    case 'write-meta': {
      const bumped = bumpMeta(root)
      if (!bumped.ok) throw new Error(bumped.message)
      const staged = stageFile(root, handle, action.path)
      if (!staged.ok) throw new Error(staged.error.message)
      writeFileSync(resolve(root, action.path), bumped.text, 'utf8')
      const after = digestRelative(root, action.path)
      if (after === undefined) throw new Error('inkflow.json is gone after the write')
      body.files.push({
        path: action.path,
        change: staged.value === undefined ? 'created' : 'modified',
        ...(staged.value === undefined ? {} : { before: staged.value }),
        after,
      })
      return true
    }
  }
}

/**
 * Undo one migration package and write the rollback report.
 *
 * The verification lives in `backup.ts` (a file changed after the run is a
 * conflict, not an overwrite); this wrapper adds the audit trail, because "we
 * rolled it back" is exactly the claim that needs a timestamped record.
 */
export function rollbackMigration(
  projectRoot: string,
  input: { backup: string; now?: Date },
): RollbackOutcome {
  const root = resolve(projectRoot)
  const now = input.now ?? new Date()
  const result = rollbackBackup(root, input.backup, now)
  if (!result.ok) {
    return {
      ok: false,
      root,
      backup: input.backup,
      restored: [],
      removed: [],
      dirsRemoved: [],
      kept: [],
      error: {
        code: result.error.code,
        message: result.error.message,
        ...(result.error.hint === undefined ? {} : { hint: result.error.hint }),
      },
    }
  }

  const report = writeAuditReport(
    root,
    `migrate-${stamp(now)}.md`,
    migrationReportMarkdown({
      root,
      at: now,
      stage: 'rollback',
      actions: [],
      applied: [],
      backup: { dir: result.dir, manifestPath: `${result.dir}/manifest.json` },
      notices: [],
      before: inspectProject(root, { recreateIndexDir: false }).state,
      rolledBack: result,
    }),
  )

  return {
    ok: true,
    root,
    backup: result.dir,
    restored: result.restored,
    removed: result.removed,
    dirsRemoved: result.dirsRemoved,
    kept: result.kept,
    report: { path: report.path, written: report.ok, ...(report.error === undefined ? {} : { error: report.error }) },
  }
}

