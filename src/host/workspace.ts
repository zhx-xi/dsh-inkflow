/**
 * The setup/repair wizard (ADR-0006 D3/D4): read-only plan → confirmed apply.
 *
 * Split out of `project.ts` because "what a directory is" (the gate) and "what
 * to do about it" (the wizard) are separate responsibilities that kept one
 * file over the 600-line convention.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative as relativePath, resolve } from 'node:path'

import { DIR_KEEP_FILE, FILE_SCHEMA_VERSION, REQUIRED_DIRS, ROOT_META_FILE } from './conventions.js'
import { inspectProject, isDirectory, isGitRoot, missingGitignoreLines } from './project.js'
import type { MetaRaw, ProjectChecks, ProjectMeta, ProjectProbe, ProjectState, WorkspaceAction } from './project.js'

/** Nearest ancestor (excluding `start` itself) that is a git repository. */
function nearestGitRepository(start: string): string | undefined {
  let current = resolve(start)
  for (let depth = 0; depth < 64; depth += 1) {
    if (isGitRoot(current)) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  return undefined
}

/** Cap on how many pre-existing entries are echoed back to the model. */
const MAX_PLANNED_ENTRIES = 50

function listEntries(dir: string): string[] {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

export interface WorkspacePlan {
  root: string
  targetKind: 'absent' | 'directory' | 'other'
  state: ProjectState
  readOnly: boolean
  checks: ProjectChecks
  missing: string[]
  /** Read-only list of what `applyWorkspace` would do, in execution order. */
  actions: WorkspaceAction[]
  reasons: string[]
  /** Hints the user has to act on themselves (never a write outside the book). */
  notices: string[]
  /** Non-empty when the plan cannot be applied at all. */
  blockedReason: string
  existingEntries: string[]
  existingCount: number
  metaRaw?: MetaRaw
  metaError?: string
}

/**
 * What the wizard would do, without writing anything (ADR-0006 D3).
 *
 * Planning is a pure read, including the `index/` relaxation: a plan that
 * quietly created a directory would break its own promise.
 */
export function planWorkspace(root: string): WorkspacePlan {
  const absolute = resolve(root)
  const targetKind: WorkspacePlan['targetKind'] = existsSync(absolute)
    ? isDirectory(absolute)
      ? 'directory'
      : 'other'
    : 'absent'
  const probe = inspectProject(absolute, { recreateIndexDir: false })

  const notices: string[] = []
  if (probe.actions.some((action) => action.type === 'git-init')) {
    const outer = nearestGitRepository(dirname(absolute))
    if (outer !== undefined) {
      const relative = relativePath(outer, absolute).split('\\').join('/')
      notices.push(
        `this book sits inside the git repository ${outer}; add ${relative}/ to that repository's ` +
          `.gitignore yourself — the wizard never edits files outside the book root`,
      )
    }
  }

  const entries = targetKind === 'directory' ? listEntries(absolute) : []
  const blockedReason =
    targetKind === 'other'
      ? 'the target exists and is not a directory'
      : probe.readOnly
        ? (probe.metaError ?? 'this book was written by a newer plugin')
        : ''

  return {
    root: absolute,
    targetKind,
    state: probe.state,
    readOnly: probe.readOnly,
    checks: probe.checks,
    missing: probe.missing,
    actions: probe.actions,
    reasons: probe.reasons,
    notices,
    blockedReason,
    existingEntries: entries.slice(0, MAX_PLANNED_ENTRIES),
    existingCount: entries.length,
    ...(probe.metaRaw === undefined ? {} : { metaRaw: probe.metaRaw }),
    ...(probe.metaError === undefined ? {} : { metaError: probe.metaError }),
  }
}

export type WorkspaceErrorCode =
  | 'INIT_REQUIRES_CONFIRMATION'
  | 'PROJECT_NEEDS_NEWER_PLUGIN'
  | 'META_TITLE_REQUIRED'
  | 'TARGET_NOT_DIRECTORY'
  | 'GIT_INIT_FAILED'
  | 'APPLY_FAILED'

export interface WorkspaceApplyInput {
  /** Set only after the user saw the plan and agreed (ADR-0006 D3). */
  confirm?: boolean
  /** Required whenever `inkflow.json` has to be written: titles are never invented. */
  title?: string
  author?: string
}

export interface WorkspaceApplyResult {
  ok: boolean
  root: string
  state: ProjectState
  plan: WorkspacePlan
  probe: ProjectProbe
  /** Relative paths this call created (including `.git` after a `git init`). */
  created: string[]
  /** Relative paths this call extended without overwriting (currently `.gitignore`). */
  updated: string[]
  /** Relative paths that were already in place, i.e. the previous apply's work. */
  skipped: string[]
  gitInit: 'created' | 'already-initialised' | 'not-run'
  notices: string[]
  error?: { code: WorkspaceErrorCode; message: string; rolledBack: boolean }
}

class ApplyFailure extends Error {
  readonly code: WorkspaceErrorCode
  constructor(code: WorkspaceErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** Every path-like item a complete book has; used to report what was skipped. */
function completeItemPaths(): string[] {
  return [
    '.git',
    ...REQUIRED_DIRS,
    ...REQUIRED_DIRS.map((name) => `${name}/${DIR_KEEP_FILE}`),
    ROOT_META_FILE,
    '.gitignore',
  ]
}

function metaBody(title: string, author?: string): string {
  const meta: ProjectMeta = {
    schemaVersion: FILE_SCHEMA_VERSION,
    title,
    createdAt: new Date().toISOString(),
  }
  if (author !== undefined && author.trim() !== '') meta.author = author.trim()
  return `${JSON.stringify(meta, null, 2)}\n`
}

/**
 * Apply a plan. Requires `confirm: true` and only ever fills gaps in the current
 * plan: existing directories and files are skipped, and an existing
 * `inkflow.json` is rebuilt only when it is invalid **and** the caller confirmed
 * (ADR-0006 D3). `git init` is the only git operation (D4).
 */
export function applyWorkspace(root: string, input: WorkspaceApplyInput = {}): WorkspaceApplyResult {
  const absolute = resolve(root)
  const plan = planWorkspace(absolute)
  const probeBefore = inspectProject(absolute, { recreateIndexDir: false })
  const gitInit: WorkspaceApplyResult['gitInit'] = plan.checks.git ? 'already-initialised' : 'not-run'

  const refuse = (code: WorkspaceErrorCode, message: string, rolledBack = false): WorkspaceApplyResult => ({
    ok: false,
    root: absolute,
    state: probeBefore.state,
    plan,
    probe: probeBefore,
    created: [],
    updated: [],
    skipped: [],
    gitInit,
    notices: plan.notices,
    error: { code, message, rolledBack },
  })

  if (plan.targetKind === 'other') {
    return refuse('TARGET_NOT_DIRECTORY', `${absolute} exists and is not a directory`)
  }
  if (probeBefore.state === 'needs-newer-plugin') {
    return refuse(
      'PROJECT_NEEDS_NEWER_PLUGIN',
      probeBefore.metaError ?? `${ROOT_META_FILE} was written by a newer plugin: nothing was written`,
    )
  }
  // The confirmation is checked before the title: a refusal must never depend on
  // arguments that only matter once the user said yes.
  if (input.confirm !== true) {
    return refuse('INIT_REQUIRES_CONFIRMATION', 'nothing was written: show the plan to the user, then call again with confirm: true')
  }
  const title = (input.title ?? '').trim()
  if (plan.actions.some((action) => action.type === 'create-meta') && title === '') {
    return refuse(
      'META_TITLE_REQUIRED',
      `${ROOT_META_FILE} has to be written, so a title is required: pass the user's book title ` +
        '(the plugin does not invent one)',
    )
  }

  const created: string[] = []
  const updated: string[] = []
  const written: string[] = []
  /** Existing files this call extended; restored verbatim if a later step fails. */
  const restore: Array<{ path: string; original: string }> = []
  let gitDirectoryCreated = false
  let createdGit = false

  const rollback = (): boolean => {
    let clean = true
    for (const entry of restore) {
      try {
        writeFileSync(entry.path, entry.original, 'utf8')
      } catch {
        clean = false
      }
    }
    for (const path of [...written].reverse()) {
      try {
        if (statSync(path).isDirectory()) rmdirSync(path)
        else unlinkSync(path)
      } catch {
        clean = false
      }
    }
    if (gitDirectoryCreated) {
      try {
        rmSync(join(absolute, '.git'), { recursive: true, force: true })
      } catch {
        clean = false
      }
    }
    return clean
  }

  try {
    if (plan.targetKind === 'absent') mkdirSync(absolute, { recursive: true })

    for (const action of plan.actions) {
      if (action.type === 'manual') continue
      if (action.type === 'git-init') {
        // The only git write in the whole plugin (ADR-0006 D4). No `-b`, no
        // config, no remote: the branch name, identity and history are the user's.
        const result = spawnSync('git', ['init'], { cwd: absolute, stdio: 'ignore', windowsHide: true })
        if (result.error !== undefined || result.status !== 0) {
          const detail = result.error?.message ?? `git init exited with status ${String(result.status)}`
          throw new ApplyFailure('GIT_INIT_FAILED', detail)
        }
        gitDirectoryCreated = true
        createdGit = true
        created.push('.git')
        continue
      }
      const relative = relativePath(absolute, action.path).split('\\').join('/')
      if (action.type === 'create-meta') {
        // The single overwrite the wizard may perform (ADR-0006 D3): only for an
        // inkflow.json this plugin cannot use, only after the caller confirmed,
        // and the old text stays available in the confirm round via metaRaw.
        const existed = existsSync(action.path)
        if (existed) restore.push({ path: action.path, original: readFileSync(action.path, 'utf8') })
        writeFileSync(action.path, metaBody(title, input.author), 'utf8')
        written.push(action.path)
        if (existed) updated.push(relative)
        else created.push(relative)
        continue
      }
      if (action.type === 'create-gitignore') {
        // Append-only: an existing .gitignore keeps its lines, its order and its
        // trailing newline; only the derived-index rules are added.
        const existed = existsSync(action.path)
        const existing = existed ? readFileSync(action.path, 'utf8') : ''
        const missing = missingGitignoreLines(absolute)
        if (missing.length === 0) continue // plan drift: already complete
        if (existed) restore.push({ path: action.path, original: existing })
        const header = existing === '' ? '# InkFlow derived index — rebuildable, never committed\n' : ''
        const prefix = existing === '' ? '' : existing.endsWith('\n') ? existing : `${existing}\n`
        writeFileSync(action.path, `${prefix}${header}${missing.join('\n')}\n`, 'utf8')
        if (existed) updated.push(relative)
        else {
          written.push(action.path)
          created.push(relative)
        }
        continue
      }
      if (existsSync(action.path)) continue // plan drift: never overwrite

      if (action.type === 'create-dir') {
        mkdirSync(action.path, { recursive: true })
      } else {
        writeFileSync(action.path, '', 'utf8')
      }
      written.push(action.path)
      created.push(relative)
    }
  } catch (cause) {
    const rolledBack = rollback()
    return {
      ok: false,
      root: absolute,
      state: probeBefore.state,
      plan,
      probe: probeBefore,
      created,
      updated: [],
      skipped: [],
      gitInit: createdGit ? 'not-run' : gitInit,
      notices: plan.notices,
      error: {
        code: cause instanceof ApplyFailure ? cause.code : 'APPLY_FAILED',
        message: cause instanceof Error ? cause.message : String(cause),
        rolledBack,
      },
    }
  }

  const probe = inspectProject(absolute)
  if (!probe.usable) {
    return {
      ok: false,
      root: absolute,
      state: probe.state,
      plan,
      probe,
      created,
      updated,
      skipped: [],
      gitInit: createdGit ? 'created' : gitInit,
      notices: plan.notices,
      error: {
        code: 'APPLY_FAILED',
        message: `the project is still not usable after applying the plan (state ${probe.state}): ${probe.missing.join(', ')}`,
        rolledBack: false,
      },
    }
  }

  const createdSet = new Set(created)
  const updatedSet = new Set(updated)
  const skipped = completeItemPaths().filter(
    (item) => !createdSet.has(item) && !updatedSet.has(item) && existsSync(join(absolute, item)),
  )

  return {
    ok: true,
    root: absolute,
    state: probe.state,
    plan,
    probe,
    created,
    updated,
    skipped,
    gitInit: createdGit ? 'created' : gitInit,
    notices: plan.notices,
  }
}

