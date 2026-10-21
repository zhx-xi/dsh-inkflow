/**
 * Project detection, gating and scaffolding — the "convention over
 * configuration" half of ADR-0005.
 *
 * A directory is an InkFlow project when it is a git repository AND every
 * required directory exists (docs/conventions.md §1). The plugin never
 * registers projects anywhere: the filesystem *is* the registry.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse as parsePath, relative as relativePath, resolve } from 'node:path'

import {
  CONTENT_DIRS,
  FILE_SCHEMA_VERSION,
  INDEX_DIR,
  INDEX_KEEP_FILE,
  REQUIRED_DIRS,
  REQUIRED_GITIGNORE_LINES,
  ROOT_META_FILE,
} from './conventions.js'

export interface ProjectMeta {
  schemaVersion: number
  title?: string
  author?: string
  seriesId?: string | null
  createdAt?: string
}

export interface ProjectChecks {
  git: boolean
  dirs: Record<string, boolean>
  meta: boolean
}

export interface ProjectProbe {
  root: string
  checks: ProjectChecks
  missingDirs: string[]
  missing: string[]
  meta?: ProjectMeta
  metaError?: string
  /** True when `index/` was absent and got created because the rest checked out. */
  indexDirRecreated: boolean
  usable: boolean
  reasons: string[]
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** A git worktree has a `.git` *file*; a normal repo has a `.git` directory. */
export function isGitRoot(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

export function hasContentDirs(dir: string): boolean {
  return CONTENT_DIRS.every((name) => isDirectory(join(dir, name)))
}

/**
 * Walk up from `start` to find the nearest directory that looks like an
 * InkFlow project. Intentionally lenient about `index/` (it is derived) so a
 * deleted index never hides the project; `inspectProject` applies the strict
 * gate and recreates the index directory.
 */
export function findProjectRoot(start: string): string | undefined {
  let current = resolve(start)
  for (let depth = 0; depth < 16; depth += 1) {
    if (isGitRoot(current) && hasContentDirs(current)) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

/**
 * Resolve a path that may not exist yet (`init` creates it): realpath the
 * nearest existing ancestor, then re-append the missing segments. Without this,
 * a junction/symlink or a `..` text trick could smuggle a path out of the
 * workspace while looking contained.
 *
 * Exported for `io.ts`, which needs the same tolerance for write targets that
 * do not exist yet (issue #14): one implementation of "resolve through links".
 */
export function realpathLoose(input: string): string {
  const absolute = resolve(input)
  const missing: string[] = []
  let current = absolute
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = realpathSync.native(current)
      const tail = missing.slice().reverse()
      return tail.length === 0 ? real : join(real, ...tail)
    } catch {
      const parent = dirname(current)
      if (parent === current) return absolute
      missing.push(basename(current))
      current = parent
    }
  }
  return absolute
}

/**
 * True when `child` is `parent` itself or sits below it. `path.relative` is
 * case-insensitive on Windows, which is what we want for drive-letter/case
 * variants of the same directory.
 *
 * Exported for `io.ts`: the write door must judge containment exactly the way
 * the gate does, or the two would disagree on the same path (issue #14).
 */
export function isWithin(parent: string, child: string): boolean {
  const relative = relativePath(parent, child)
  return relative === '' || (!relative.startsWith('..') && !isAbsolute(relative))
}

/** Directories that must never hold a novel project: writes there can damage the system. */
function forbiddenRoots(): string[] {
  const env = process.env
  const candidates = [
    env['SystemRoot'],
    env['ProgramFiles'],
    env['ProgramFiles(x86)'],
    env['ProgramData'],
    dirname(process.execPath),
  ]
  return candidates
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map(realpathLoose)
}

export interface ScopeRejection {
  code: 'PATH_OUT_OF_SCOPE' | 'PATH_FORBIDDEN'
  message: string
  root: string
  workspace: string
  hint: string
}

const SCOPE_HINT =
  'an InkFlow project must be one git repository inside the session working directory; ' +
  'open the novel directory as the session workspace (or scaffold it there) instead of pointing at another path'

/**
 * Gate for every caller-supplied path (issue #7). The plugin runs un-sandboxed
 * in the host process (hard-constraints H7), so an unchecked path is an
 * arbitrary-directory read/write primitive: `inspectProject` creates `index/`
 * and `initProject` creates a whole tree.
 *
 * The session workspace is the only trust anchor — it is the directory the user
 * actually opened — so anything outside it, plus the filesystem root, the home
 * directory itself and the install directories, is refused before any disk IO.
 */
export function checkProjectRootScope(candidate: string, workspace: string): ScopeRejection | undefined {
  const root = realpathLoose(candidate)
  const scope = realpathLoose(workspace)
  const reject = (code: ScopeRejection['code'], message: string): ScopeRejection => ({
    code,
    message,
    root,
    workspace: scope,
    hint: SCOPE_HINT,
  })

  if (root === parsePath(root).root) {
    return reject('PATH_FORBIDDEN', 'refusing a drive/volume root as a project root')
  }
  // `homedir()` honours HOME on POSIX and USERPROFILE on Windows, but tests and
  // portable setups may override only one of them; read the environment first so
  // both platforms agree, then fall back to the OS account directory.
  const home = realpathLoose(process.env['HOME'] ?? process.env['USERPROFILE'] ?? homedir())
  if (root === home) {
    return reject('PATH_FORBIDDEN', `refusing the user home directory itself (${home}); use a subdirectory`)
  }
  if (isWithin(root, home)) {
    return reject('PATH_FORBIDDEN', 'refusing a directory that contains the user home directory')
  }
  for (const directory of forbiddenRoots()) {
    if (isWithin(directory, root)) {
      return reject('PATH_FORBIDDEN', `refusing a path inside the installation directory ${directory}`)
    }
  }
  if (!isWithin(scope, root)) {
    return reject('PATH_OUT_OF_SCOPE', `the path is outside the session working directory ${scope}`)
  }
  return undefined
}

export function readMeta(root: string): { meta?: ProjectMeta; error?: string } {
  const file = join(root, ROOT_META_FILE)
  let raw: string
  try {
    // Users edit these files with arbitrary Windows tools: a UTF-8 BOM must not
    // make the project unreadable (PowerShell's Set-Content emits one).
    raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return { error: `${ROOT_META_FILE} is missing` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: `${ROOT_META_FILE} is not valid JSON` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: `${ROOT_META_FILE} must be a JSON object` }
  }
  const record = parsed as Record<string, unknown>
  const version = record['schemaVersion']
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { error: `${ROOT_META_FILE} is missing an integer schemaVersion` }
  }
  const meta: ProjectMeta = { schemaVersion: version }
  if (typeof record['title'] === 'string') meta.title = record['title']
  if (typeof record['author'] === 'string') meta.author = record['author']
  if (typeof record['seriesId'] === 'string' || record['seriesId'] === null) {
    meta.seriesId = record['seriesId'] as string | null
  }
  if (typeof record['createdAt'] === 'string') meta.createdAt = record['createdAt']
  return { meta }
}

export interface InspectOptions {
  /**
   * Create `index/` when it is the only missing directory. Default true: a
   * derived directory must never be able to lock the user out (ADR-0005).
   */
  recreateIndexDir?: boolean
}

export function inspectProject(root: string, options: InspectOptions = {}): ProjectProbe {
  const recreateIndexDir = options.recreateIndexDir ?? true
  const absolute = resolve(root)
  const checks: ProjectChecks = { git: isGitRoot(absolute), dirs: {}, meta: false }
  const missingDirs: string[] = []
  let indexDirRecreated = false

  for (const name of REQUIRED_DIRS) {
    checks.dirs[name] = isDirectory(join(absolute, name))
  }

  if (!checks.dirs[INDEX_DIR] && recreateIndexDir) {
    const othersPresent = CONTENT_DIRS.every((name) => checks.dirs[name] === true)
    if (checks.git && othersPresent) {
      try {
        mkdirSync(join(absolute, INDEX_DIR), { recursive: true })
        writeFileSync(join(absolute, INDEX_DIR, INDEX_KEEP_FILE), '', 'utf8')
        checks.dirs[INDEX_DIR] = true
        indexDirRecreated = true
      } catch {
        checks.dirs[INDEX_DIR] = false
      }
    }
  }

  for (const name of REQUIRED_DIRS) {
    if (checks.dirs[name] !== true) missingDirs.push(name)
  }

  const metaResult = readMeta(absolute)
  checks.meta = metaResult.meta !== undefined
  if (metaResult.meta !== undefined && metaResult.meta.schemaVersion > FILE_SCHEMA_VERSION) {
    checks.meta = false
    metaResult.error = `project file schema v${metaResult.meta.schemaVersion} is newer than this plugin (v${FILE_SCHEMA_VERSION})`
  }

  const missing: string[] = []
  if (!checks.git) missing.push('.git')
  missing.push(...missingDirs)
  if (!checks.meta) missing.push(ROOT_META_FILE)

  const reasons: string[] = []
  if (!checks.git) reasons.push('directory is not a git repository')
  for (const name of missingDirs) reasons.push(`missing directory: ${name}/`)
  if (!checks.meta) reasons.push(metaResult.error ?? `${ROOT_META_FILE} is invalid`)

  return {
    root: absolute,
    checks,
    missingDirs,
    missing,
    ...(metaResult.meta === undefined ? {} : { meta: metaResult.meta }),
    ...(metaResult.error === undefined ? {} : { metaError: metaResult.error }),
    indexDirRecreated,
    usable: missing.length === 0,
    reasons,
  }
}

export interface InitPlan {
  root: string
  targetKind: 'absent' | 'directory' | 'other'
  /** True when scaffolding cannot destroy anything the user made. */
  safeToScaffold: boolean
  /** Empty when scaffolding is safe; explains the confirmation requirement otherwise. */
  blockedReason: string
  /** First entries already present (capped; `existingCount` is the real total). */
  existingEntries: string[]
  existingCount: number
  willCreate: string[]
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

/**
 * What `initProject` would do, without writing anything. A non-empty directory
 * without `inkflow.json` is someone's existing folder (a manuscript dump, a
 * project of another app, a home directory by mistake): scaffolding it must be
 * an explicit decision, never a side effect of a vague "create my novel" call.
 */
export function planInit(root: string): InitPlan {
  const absolute = resolve(root)
  const targetKind: InitPlan['targetKind'] = existsSync(absolute)
    ? isDirectory(absolute)
      ? 'directory'
      : 'other'
    : 'absent'
  const entries = targetKind === 'directory' ? listEntries(absolute) : []
  const hasMeta = targetKind === 'directory' && existsSync(join(absolute, ROOT_META_FILE))
  const safeToScaffold = targetKind === 'absent' || (targetKind === 'directory' && (entries.length === 0 || hasMeta))
  const blockedReason =
    targetKind === 'other'
      ? 'the target exists and is not a directory'
      : safeToScaffold
        ? ''
        : `the directory is not empty and has no ${ROOT_META_FILE}`

  const willCreate: string[] = []
  for (const name of [...CONTENT_DIRS, INDEX_DIR]) {
    if (targetKind !== 'directory' || !isDirectory(join(absolute, name))) willCreate.push(name)
  }
  if (targetKind !== 'directory' || !existsSync(join(absolute, INDEX_DIR, INDEX_KEEP_FILE))) {
    willCreate.push(`${INDEX_DIR}/${INDEX_KEEP_FILE}`)
  }
  if (!hasMeta) willCreate.push(ROOT_META_FILE)
  if (targetKind !== 'directory' || !existsSync(join(absolute, '.gitignore'))) willCreate.push('.gitignore')

  return {
    root: absolute,
    targetKind,
    safeToScaffold,
    blockedReason,
    existingEntries: entries.slice(0, MAX_PLANNED_ENTRIES),
    existingCount: entries.length,
    willCreate,
  }
}

interface InitCreated {
  kind: 'created'
  root: string
  plan: InitPlan
  probe: ProjectProbe
  createdDirs: string[]
  createdFiles: string[]
  gitignoreUpdated: boolean
  gitInitNeeded: boolean
}

interface InitNeedsConfirmation {
  kind: 'requires-confirmation'
  root: string
  plan: InitPlan
  /** A confirmation round is a refusal: nothing was written. */
  createdDirs: []
  createdFiles: []
  gitignoreUpdated: false
  gitInitNeeded: boolean
}

export type InitResult = InitCreated | InitNeedsConfirmation

export interface InitOptions {
  /** Set only after the user agreed to scaffold into a non-empty directory. */
  confirm?: boolean
}

/**
 * Scaffold a project. Never runs `git init` on the user's behalf: the git
 * identity, remote and branch belong to the user, and a half-initialised repo
 * is worse than a clear "run git init" instruction.
 *
 * Writes only when `planInit` says the target is safe, or when the caller
 * passed `confirm` after showing the plan to the user (issue #7).
 */
export function initProject(root: string, input: { title: string; author?: string }, options: InitOptions = {}): InitResult {
  const absolute = resolve(root)
  const plan = planInit(absolute)
  if (plan.targetKind === 'other') {
    throw new Error(`inkflow: ${absolute} exists and is not a directory`)
  }

  const metaFile = join(absolute, ROOT_META_FILE)
  // Validate before any write so a rejected call leaves no trace at all.
  if (!existsSync(metaFile) && input.title.trim() === '') {
    throw new Error('inkflow: project title must not be empty')
  }

  if (!plan.safeToScaffold && options.confirm !== true) {
    return {
      kind: 'requires-confirmation',
      root: absolute,
      plan,
      createdDirs: [],
      createdFiles: [],
      gitignoreUpdated: false,
      gitInitNeeded: !isGitRoot(absolute),
    }
  }

  mkdirSync(absolute, { recursive: true })

  const createdDirs: string[] = []
  for (const name of [...CONTENT_DIRS, INDEX_DIR]) {
    const path = join(absolute, name)
    if (!isDirectory(path)) {
      mkdirSync(path, { recursive: true })
      createdDirs.push(name)
    }
  }

  const createdFiles: string[] = []
  const keep = join(absolute, INDEX_DIR, INDEX_KEEP_FILE)
  if (!existsSync(keep)) {
    writeFileSync(keep, '', 'utf8')
    createdFiles.push(`${INDEX_DIR}/${INDEX_KEEP_FILE}`)
  }

  if (!existsSync(metaFile)) {
    const title = input.title.trim()
    const meta: ProjectMeta = {
      schemaVersion: FILE_SCHEMA_VERSION,
      title,
      createdAt: new Date().toISOString(),
    }
    if (input.author !== undefined && input.author.trim() !== '') meta.author = input.author.trim()
    writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    createdFiles.push(ROOT_META_FILE)
  }

  const gitignore = join(absolute, '.gitignore')
  let gitignoreUpdated = false
  const existing = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : ''
  const missingLines = REQUIRED_GITIGNORE_LINES.filter((line) => !existing.split('\n').includes(line))
  if (missingLines.length > 0) {
    const prefix = existing === '' ? '' : existing.endsWith('\n') ? existing : `${existing}\n`
    const header = existing === '' ? '# InkFlow derived index — rebuildable, never committed\n' : ''
    writeFileSync(gitignore, `${prefix}${header}${missingLines.join('\n')}\n`, 'utf8')
    gitignoreUpdated = true
    if (existing === '') createdFiles.push('.gitignore')
  }

  return {
    kind: 'created',
    root: absolute,
    plan,
    probe: inspectProject(absolute),
    createdDirs,
    createdFiles,
    gitignoreUpdated,
    gitInitNeeded: !isGitRoot(absolute),
  }
}

/** Display name of a project: meta title, else the directory name. */
export function projectLabel(probe: ProjectProbe): string {
  return probe.meta?.title ?? parsePath(probe.root).name
}
