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
import { describeEncodingSuspicion } from './encoding.js'
import { compareExpectation, fingerprintFile, fingerprintProjectFile } from './file-cas.js'
import type { FileChange, FileExpectation, FileFingerprint } from './file-cas.js'
import { inspectProject, isDirectory, isGitRoot, missingGitignoreLines, readMeta } from './project.js'
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
  /**
   * `inkflow.json` as it is right now (`null` = absent), so a plan → apply round
   * trip can carry the baseline it planned against (issue #5: two sessions
   * initialising the same directory must not overwrite each other's meta).
   */
  metaFingerprint: FileFingerprint | null
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
    metaFingerprint: fingerprintProjectFile(absolute, ROOT_META_FILE) ?? null,
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
  | 'FILE_CHANGED'
  | 'APPLY_FAILED'

/**
 * Non-blocking findings about `inkflow.json` after a successful apply (issue #89).
 *
 * These are not errors: the call did what it promised, and reporting a problem
 * the user can fix is better than pretending the file is fine. Two shapes:
 * the title this call asked for is not what is on disk, or what is on disk looks
 * like a GBK round-trip accident (a hand-written file).
 */
export type WorkspaceWarningCode = 'META_READBACK_MISMATCH' | 'META_ENCODING_SUSPECT'

export interface WorkspaceWarning {
  code: WorkspaceWarningCode
  message: string
  hint: string
  /** `META_READBACK_MISMATCH`: the title this call asked for (truncated). */
  requested?: string
  /** `META_READBACK_MISMATCH`: the title `inkflow.json` holds (truncated). */
  onDisk?: string
  /** `META_ENCODING_SUSPECT`: the title that looks garbled (truncated). */
  title?: string
  /** `META_ENCODING_SUSPECT`: the matched artifact groups (evidence, not prose). */
  hits?: string[]
}

export interface WorkspaceApplyInput {
  /** Set only after the user saw the plan and agreed (ADR-0006 D3). */
  confirm?: boolean
  /** Required whenever `inkflow.json` has to be written: titles are never invented. */
  title?: string
  author?: string
  /**
   * The `inkflow.json` baseline the caller planned against (issue #5). Pass
   * `{ absent: true }` when the plan reported `metaFingerprint: null`, or the
   * plan's `metaFingerprint` itself; a mismatch is `FILE_CHANGED`, zero writes.
   */
  expected?: FileExpectation
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
  /**
   * `inkflow.json` read back after the call, compared with the title this call
   * asked for (issue #89). `undefined` when no title was asked for: nothing to
   * verify, and saying `true` would be a claim that was never tested.
   */
  metaVerified?: boolean
  /** Findings about the meta on disk that must not fail the call. */
  warnings: WorkspaceWarning[]
  error?: {
    code: WorkspaceErrorCode
    message: string
    rolledBack: boolean
    /** `FILE_CHANGED` only: the file whose baseline no longer matches. */
    path?: string
    /** `FILE_CHANGED` only: which expected fields differ. */
    changed?: string[]
  }
}

class ApplyFailure extends Error {
  readonly code: WorkspaceErrorCode
  /** Set for `FILE_CHANGED`: the project-relative path whose baseline moved. */
  readonly path: string | undefined
  constructor(code: WorkspaceErrorCode, message: string, path?: string) {
    super(message)
    this.code = code
    this.path = path
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

/** Cap on how much of a title is echoed back in a warning. */
const MAX_TITLE_ECHO_CHARS = 120

function echoTitle(value: string): string {
  return value.length > MAX_TITLE_ECHO_CHARS ? `${value.slice(0, MAX_TITLE_ECHO_CHARS)}…` : value
}

/**
 * Comparison form of a title (issue #89).
 *
 * Reformatting is not renaming: a trailing newline, doubled spaces, a full-width
 * space from a Chinese IME or a different Unicode normalisation must not read as
 * "the write failed". Only the printable content is compared.
 */
function normalizeMetaTitle(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim()
}

/**
 * Re-read `inkflow.json` and report what actually landed (issue #89).
 *
 * The plugin's own writer is UTF-8, so a mismatch means either another writer
 * (a session, a shell, the author) moved the file, or the bytes on disk are not
 * what this plugin wrote. Either way the file stays untouched: the wizard's job
 * is to report, never to "repair" a title the author may have chosen on purpose.
 */
function verifyWrittenMeta(root: string, requested: string): { metaVerified?: boolean; warnings: WorkspaceWarning[] } {
  const warnings: WorkspaceWarning[] = []
  const onDisk = readMeta(root).meta?.title
  const onDiskText = onDisk ?? ''

  const outcome: { metaVerified?: boolean; warnings: WorkspaceWarning[] } = { warnings }
  if (requested !== '') {
    const verified = onDisk !== undefined && normalizeMetaTitle(onDisk) === normalizeMetaTitle(requested)
    outcome.metaVerified = verified
    if (!verified) {
      warnings.push({
        code: 'META_READBACK_MISMATCH',
        message:
          `${ROOT_META_FILE} does not hold the title this call asked for: requested "${echoTitle(requested)}", ` +
          `on disk "${echoTitle(onDiskText)}"`,
        requested: echoTitle(requested),
        onDisk: echoTitle(onDiskText),
        hint:
          'nothing was rewritten: the wizard only replaces an unusable inkflow.json. To rename the book, edit ' +
          `${ROOT_META_FILE} yourself (UTF-8, no BOM) or rewrite it through the tool surface`,
      })
    }
  }

  const suspicion = onDiskText === '' ? undefined : describeEncodingSuspicion(onDiskText)
  if (suspicion !== undefined && suspicion.suspicious) {
    warnings.push({
      code: 'META_ENCODING_SUSPECT',
      message:
        `${ROOT_META_FILE} title looks like UTF-8 bytes read back as GBK ("${echoTitle(onDiskText)}"): ` +
        `matched ${suspicion.hits.join(', ')}`,
      title: echoTitle(onDiskText),
      hits: suspicion.hits,
      hint:
        'this is what PowerShell 5 Set-Content/echo (default ANSI code page) or a GBK-default editor writes, so ' +
        'the file was probably not written by this plugin. Rewrite the title through the tool surface, or save ' +
        `${ROOT_META_FILE} as UTF-8 without BOM; the file itself was left exactly as it is`,
    })
  }
  return outcome
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
    warnings: [],
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

  /**
   * Issue #5: `inkflow.json` is the one file this wizard may *overwrite*, and it
   * is also the file two concurrently initialising sessions both want to write.
   * So the baseline is taken now, checked against whatever the caller planned
   * against, and re-checked immediately before the overwrite — a lost race is
   * `FILE_CHANGED` with zero writes, never a silently replaced title.
   */
  const metaPath = join(absolute, ROOT_META_FILE)
  const metaBaseline = fingerprintFile(metaPath)
  const changedFailure = (drift: FileChange, why: string): WorkspaceApplyResult => ({
    ...refuse('FILE_CHANGED', `inkflow.json ${why} (${drift.changed.join(', ')}); nothing was written`),
    error: {
      code: 'FILE_CHANGED',
      message: `inkflow.json ${why} (${drift.changed.join(', ')}); nothing was written`,
      rolledBack: true,
      path: ROOT_META_FILE,
      changed: drift.changed,
    },
  })
  const plannedAgainst = compareExpectation(metaBaseline, input.expected)
  if (plannedAgainst !== undefined) {
    return changedFailure(plannedAgainst, 'is not the version this call planned against')
  }

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
        //
        // Issue #5: `git init` above can take long enough for another session to
        // finish its own initialisation, so the baseline is re-checked here, at
        // the last moment before the overwrite. A lost race rolls back to the
        // pre-call tree and reports `FILE_CHANGED`.
        const race = compareExpectation(fingerprintFile(action.path), metaBaseline)
        if (race !== undefined) {
          throw new ApplyFailure(
            'FILE_CHANGED',
            `inkflow.json changed while this call was initialising (${race.changed.join(', ')}); the other change was kept`,
            ROOT_META_FILE,
          )
        }
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
      warnings: [],
      error: {
        code: cause instanceof ApplyFailure ? cause.code : 'APPLY_FAILED',
        message: cause instanceof Error ? cause.message : String(cause),
        rolledBack,
        ...(cause instanceof ApplyFailure && cause.path !== undefined ? { path: cause.path } : {}),
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
      warnings: [],
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

  // Issue #89: read the meta back and report what landed. Never a failure, never
  // a rewrite — the author's file stays theirs, and the caller gets the evidence.
  const verification = verifyWrittenMeta(absolute, title)

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
    ...(verification.metaVerified === undefined ? {} : { metaVerified: verification.metaVerified }),
    warnings: verification.warnings,
  }
}

