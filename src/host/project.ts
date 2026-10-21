/**
 * Project detection and the four-state gate — the "convention over
 * configuration" half of ADR-0005, revised by ADR-0006.
 *
 * A directory is an InkFlow project when it is a git repository, carries the
 * nine content directories plus `index/` (each with a `.gitkeep`) and has a
 * parseable `inkflow.json` whose `schemaVersion` this plugin understands
 * (docs/conventions.md §1). The plugin never registers projects anywhere: the
 * filesystem *is* the registry.
 *
 * The gate answers "what should happen next" instead of "yes/no" (ADR-0006 D2),
 * with a fixed precedence — the first matching state wins:
 *
 *   1 needs-newer-plugin  meta parses but is newer than us   → upgrade, zero writes
 *   2 usable              git + ten dirs (+ .gitkeep) + meta → read/write
 *   3 needs-repair        meta file and/or `.git` exists     → repair (fill gaps only)
 *   4 needs-setup         none of the above                  → set up from scratch
 *
 * This module only *judges*: it builds the checklist (`missing[]`) and the
 * action list (`actions[]`) and never writes beyond the `index/` relaxation.
 * Executing the list lives in `workspace.ts` (plan → apply).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse as parsePath, relative as relativePath, resolve } from 'node:path'

import {
  CONTENT_DIRS,
  DIR_KEEP_FILE,
  FILE_SCHEMA_VERSION,
  INDEX_DIR,
  REQUIRED_DIRS,
  REQUIRED_GITIGNORE_LINES,
  ROOT_META_FILE,
} from './conventions.js'
import { looksLikeGbkMojibake } from './encoding.js'

export interface ProjectMeta {
  schemaVersion: number
  title?: string
  author?: string
  seriesId?: string | null
  createdAt?: string
}

/** The four gate states, in decision order (ADR-0006 D2). */
export type ProjectState = 'usable' | 'needs-setup' | 'needs-repair' | 'needs-newer-plugin'

export type WorkspaceActionType =
  | 'git-init'
  | 'create-dir'
  | 'create-gitkeep'
  | 'create-meta'
  | 'create-gitignore'
  /** Not executable by this plugin: the state is terminal until the user upgrades. */
  | 'manual'

/** One executable step of the wizard: what, where, why. */
export interface WorkspaceAction {
  type: WorkspaceActionType
  /** Absolute target; the project root itself for `git-init` / `manual`. */
  path: string
  reason: string
}

export interface ProjectChecks {
  git: boolean
  /** Presence of each required directory (nine content dirs + `index/`). */
  dirs: Record<string, boolean>
  /** Presence of `<dir>/.gitkeep` per required directory (ADR-0006 D1). */
  keeps: Record<string, boolean>
  meta: boolean
}

/**
 * Original text of an `inkflow.json` this plugin cannot use, so a rebuild shows
 * the user what is about to be replaced instead of silently overwriting it.
 */
export interface MetaRaw {
  text: string
  truncated: boolean
  bytes: number
}

export interface ProjectProbe {
  root: string
  state: ProjectState
  checks: ProjectChecks
  /** Missing directory names (`chapters`). */
  missingDirs: string[]
  /** Full checklist: `.git`, directories, `<dir>/.gitkeep`, `inkflow.json`. */
  missing: string[]
  /** What the wizard would do about it (`planWorkspace` adds the notices). */
  actions: WorkspaceAction[]
  /** `true` for `needs-newer-plugin`: no write is allowed in that state. */
  readOnly: boolean
  meta?: ProjectMeta
  metaError?: string
  metaRaw?: MetaRaw
  /**
   * The meta parses and its `title` carries GBK round-trip artifacts (issue #89):
   * the file was very likely written by something other than this plugin.
   *
   * A hint, never a gate input: the book stays `usable`. Absent (not `false`)
   * when there is no parseable title to judge, so "not judged" and "judged fine"
   * stay distinguishable at the wire.
   */
  titleSuspicious?: boolean
  /** True when `index/` was absent and got created because the rest checked out. */
  indexDirRecreated: boolean
  usable: boolean
  reasons: string[]
}

/** Shared with the wizard: "the target exists and is a directory". */
export function isDirectory(path: string): boolean {
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

/**
 * Walk up from `start` to the nearest directory that already signals "a book
 * lives here": it has an `inkflow.json` or a `.git` (ADR-0006 D5).
 *
 * Content directories are deliberately *not* part of the signal. A legacy
 * six-directory book or a half-scaffolded one must be reported as
 * `needs-repair`; requiring a full tree would make the walk skip past it and
 * answer for whatever repository happens to sit above.
 */
export function findProjectRoot(start: string): string | undefined {
  let current = resolve(start)
  for (let depth = 0; depth < 32; depth += 1) {
    if (existsSync(join(current, ROOT_META_FILE)) || isGitRoot(current)) return current
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
 * and the wizard creates a whole tree and runs `git init`.
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

/** Cap on how much of a broken `inkflow.json` is echoed back to the model. */
const MAX_META_RAW_CHARS = 4096

function readMetaRaw(file: string): MetaRaw {
  try {
    const raw = readFileSync(file, 'utf8')
    const truncated = raw.length > MAX_META_RAW_CHARS
    return {
      text: truncated ? raw.slice(0, MAX_META_RAW_CHARS) : raw,
      truncated,
      bytes: Buffer.byteLength(raw, 'utf8'),
    }
  } catch {
    return { text: '', truncated: false, bytes: 0 }
  }
}

/** `index/*.db*` lines a project's `.gitignore` is still missing (shared with the wizard). */
export function missingGitignoreLines(root: string): string[] {
  const file = join(root, '.gitignore')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const lines = existing.split('\n')
  return REQUIRED_GITIGNORE_LINES.filter((line) => !lines.includes(line))
}

export interface InspectOptions {
  /**
   * Create `index/` when it is the only problem. Default true: a derived
   * directory must never be able to lock the user out (ADR-0005 / ADR-0006 D2).
   * The wizard's read-only `plan` passes false so planning never writes.
   */
  recreateIndexDir?: boolean
}

export function inspectProject(root: string, options: InspectOptions = {}): ProjectProbe {
  const recreateIndexDir = options.recreateIndexDir ?? true
  const absolute = resolve(root)
  const checks: ProjectChecks = { git: isGitRoot(absolute), dirs: {}, keeps: {}, meta: false }

  for (const name of REQUIRED_DIRS) {
    const directory = join(absolute, name)
    const present = isDirectory(directory)
    checks.dirs[name] = present
    checks.keeps[name] = present && existsSync(join(directory, DIR_KEEP_FILE))
  }

  const metaFile = join(absolute, ROOT_META_FILE)
  const metaExists = existsSync(metaFile)
  const metaResult = readMeta(absolute)
  const newer =
    metaResult.meta !== undefined && metaResult.meta.schemaVersion > FILE_SCHEMA_VERSION
  checks.meta = metaResult.meta !== undefined && !newer

  // Everything the gate requires except the derived `index/` directory.
  const contentComplete = CONTENT_DIRS.every(
    (name) => checks.dirs[name] === true && checks.keeps[name] === true,
  )

  // The single write on the gate path (ADR-0006 D2): `index/` is derived, so a
  // deleted index directory must never read as "this is not a project".
  let indexDirRecreated = false
  let indexRelaxed = false
  if (!newer && checks.meta && checks.git && contentComplete && checks.dirs[INDEX_DIR] !== true) {
    indexRelaxed = true
    if (recreateIndexDir) {
      try {
        mkdirSync(join(absolute, INDEX_DIR), { recursive: true })
        writeFileSync(join(absolute, INDEX_DIR, DIR_KEEP_FILE), '', 'utf8')
        checks.dirs[INDEX_DIR] = true
        checks.keeps[INDEX_DIR] = true
        indexDirRecreated = true
      } catch {
        checks.dirs[INDEX_DIR] = false
        checks.keeps[INDEX_DIR] = false
      }
    }
  }

  const usable =
    checks.git &&
    checks.meta &&
    contentComplete &&
    (indexRelaxed || (checks.dirs[INDEX_DIR] === true && checks.keeps[INDEX_DIR] === true))

  const metaError = newer
    ? `${ROOT_META_FILE} schema v${String(metaResult.meta?.schemaVersion)} is newer than this plugin ` +
      `(v${FILE_SCHEMA_VERSION}): upgrade the plugin — nothing will be written`
    : metaResult.error

  const missingDirs: string[] = []
  const missing: string[] = []
  const reasons: string[] = []

  // Issue #89: judge the title only once it parses, and only to *say* something.
  // `reasons` deliberately does not mention it: a suspicious title is not a
  // gate failure, and the checklist must keep meaning "what blocks usable".
  const metaTitle = metaResult.meta?.title
  const titleSuspicious = metaTitle !== undefined && looksLikeGbkMojibake(metaTitle)

  if (!checks.git) {
    missing.push('.git')
    reasons.push('directory is not a git repository')
  }
  for (const name of REQUIRED_DIRS) {
    if (checks.dirs[name] !== true) {
      missingDirs.push(name)
      // A missing directory implies a missing marker; both are part of the
      // checklist the user has to satisfy.
      missing.push(name, `${name}/${DIR_KEEP_FILE}`)
      reasons.push(`missing directory: ${name}/`)
      continue
    }
    if (checks.keeps[name] !== true) {
      missing.push(`${name}/${DIR_KEEP_FILE}`)
      reasons.push(
        `missing ${name}/${DIR_KEEP_FILE}: git does not track empty directories, ` +
          `so ${name}/ would disappear after a clone`,
      )
    }
  }
  if (!checks.meta && !newer) {
    missing.push(ROOT_META_FILE)
    reasons.push(metaError ?? `${ROOT_META_FILE} is invalid`)
  }

  // A `.git` alone is not evidence of a book: every source repository has one,
  // so treating it as "repair me" made `inkflow_project_status` shout at any
  // git repository the session happened to sit in (found in review after #13).
  // Repair needs an InkFlow fingerprint: the meta file (even broken) or at
  // least one of the nine content directories.
  const hasInkflowLayout = REQUIRED_DIRS.some((name) => checks.dirs[name] === true)
  const state: ProjectState = newer
    ? 'needs-newer-plugin'
    : usable
      ? 'usable'
      : metaExists || hasInkflowLayout
        ? 'needs-repair'
        : 'needs-setup'
  const readOnly = state === 'needs-newer-plugin'

  const actions: WorkspaceAction[] = []
  if (readOnly) {
    // A terminal state: the only way out is a newer plugin. Offering a write
    // here is how an old plugin overwrites files a new one wrote.
    actions.push({ type: 'manual', path: absolute, reason: metaError ?? 'upgrade the plugin' })
  } else {
    if (!checks.git) {
      actions.push({
        type: 'git-init',
        path: absolute,
        reason: 'a book is one git repository; init only — never add, commit, remote or identity config',
      })
    }
    for (const name of REQUIRED_DIRS) {
      const directory = join(absolute, name)
      if (checks.dirs[name] !== true) {
        actions.push({ type: 'create-dir', path: directory, reason: `missing required directory ${name}/` })
        actions.push({
          type: 'create-gitkeep',
          path: join(directory, DIR_KEEP_FILE),
          reason: `every required directory carries ${DIR_KEEP_FILE} so a clone keeps it`,
        })
        continue
      }
      if (checks.keeps[name] !== true) {
        actions.push({
          type: 'create-gitkeep',
          path: join(directory, DIR_KEEP_FILE),
          reason: `${name}/${DIR_KEEP_FILE} is missing: git would drop the empty directory on a fresh clone`,
        })
      }
    }
    if (!checks.meta) {
      actions.push({
        type: 'create-meta',
        path: metaFile,
        reason: metaExists
          ? `${ROOT_META_FILE} is invalid (${metaResult.error ?? 'unknown reason'}); confirming replaces it — ` +
            `its current text is returned as metaRaw`
          : `the project has no ${ROOT_META_FILE}`,
      })
    }
    const missingLines = missingGitignoreLines(absolute)
    if (missingLines.length > 0) {
      actions.push({
        type: 'create-gitignore',
        path: join(absolute, '.gitignore'),
        reason: existsSync(join(absolute, '.gitignore'))
          ? `add the missing derived-index ignore rules: ${missingLines.join(', ')}`
          : 'ignore the derived SQLite index (index/*.db*)',
      })
    }
  }

  return {
    root: absolute,
    state,
    checks,
    missingDirs,
    missing,
    actions,
    readOnly,
    ...(metaResult.meta === undefined ? {} : { meta: metaResult.meta }),
    ...(metaError === undefined ? {} : { metaError }),
    ...(metaExists && !checks.meta ? { metaRaw: readMetaRaw(metaFile) } : {}),
    ...(titleSuspicious ? { titleSuspicious: true } : {}),
    indexDirRecreated,
    usable,
    reasons,
  }
}

/** Display name of a project: meta title, else the directory name. */
export function projectLabel(probe: ProjectProbe): string {
  return probe.meta?.title ?? parsePath(probe.root).name
}
