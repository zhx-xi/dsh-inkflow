/**
 * The single write door of the plugin.
 *
 * Everything that may end up in the user's novel repository goes through the
 * three capabilities in this file, and nothing in the plugin is allowed to call
 * `fs.writeFileSync` on a project path directly:
 *
 *   - `resolveWriteTarget` — one path parser for every write. It refuses what
 *     the filesystem would silently "fix" for us: `..` escapes, absolute and
 *     UNC paths, Windows reserved names, names with trailing dots/spaces,
 *     over-long paths, and junctions/symlinks that point out of the project.
 *     A write path is always *relative to the project root* and always inside
 *     one of the nine content directories or `index/` (ADR-0006 D1).
 *   - `writeTextAtomic` / `writeJsonAtomic` — temp file in the same directory,
 *     fsync, then rename over the target. A failure leaves the previous bytes
 *     untouched and no `.tmp` file behind, because the manuscript has no second
 *     copy.
 *   - `acquireProjectWriteLock` / `withProjectWriteLock` — one writer per
 *     project across sessions/processes (`index/.write.lock`), so two sessions
 *     editing the same chapter cannot both "succeed" and silently drop one
 *     edit. A stale lock (killed process) heals itself, and a release only
 *     deletes a lock it still owns.
 *
 * Why `index/.write.lock` and not `index/.lock`: `index-build.ts` already owns
 * `index/.lock` for the derived-index rebuild, and it treats a lock carrying the
 * current pid as stale (its single-flight map already serializes this process).
 * Reusing that file would make a nested write inside a build look stale and get
 * stolen. Two lock files = two independent resources: data files (this module)
 * and the rebuildable database (index-build). The build reads through atomic
 * renames, so a concurrent build always sees either the old or the new file.
 *
 * Every failure is a structured `IoFailure` value, never a thrown error: tools
 * hand these to the model, and a stack trace tells a model nothing about what to
 * do next. Measured on Windows 11 + Node 24.16: an open handle on the target
 * blocks the rename with EPERM (same semantics as the atomic index build).
 *
 * HOW THE DOOR IS SPLIT: this file keeps the path parser, the atomic write and
 * the two non-textual mutations (delete / rename) that go through the same
 * parser and the same lock. The single-writer lock itself is `io-lock.ts`, the
 * failure vocabulary and the liveness probes `io-support.ts`, and every shape a
 * caller names `io-types.ts`. All public names are re-exported below, so no
 * caller address moved.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { INDEX_DIR, PRIVATE_STATE_DIR, PRIVATE_STATE_SUBDIRS, WRITE_DIRS } from './conventions.js'
import { acquireProjectWriteLock } from './io-lock.js'
import type {
  AtomicWriteOptions,
  IoFailure,
  ProjectLock,
  ResolveWriteTargetResult,
  WriteResult,
  WriteTarget,
} from './io-types.js'
import {
  INDEX_BUILD_LOCK_FILE,
  IoWriteError,
  LOCK_FILE,
  errnoOf,
  fail,
  failure,
  fileAgeMs,
  isDirectory,
  messageOf,
  processAlive,
  randomToken,
  toFailure,
} from './io-support.js'
import { checkSegment } from './path-rules.js'
import type { SegmentProblem } from './path-rules.js'
import { isWithin, realpathLoose } from './project.js'
import { LF_STYLE, applyTextStyle } from './text-style.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Windows refuses paths over ~260 characters unless long paths are enabled, and
 * the plugin must not depend on a machine-level setting: 240 leaves room for the
 * `.tmp-<pid>-<rand>` suffix added to the same directory.
 */
const MAX_WRITE_PATH = 240
/** A temp file older than this is garbage even if its pid is still alive. */
const STALE_TEMP_MS = 10 * 60_000

/** `<name>.tmp-<pid>-<rand>` — see docs/conventions.md §5. */
const TEMP_FILE = /\.tmp-(\d+)-[0-9a-f]+$/

// ---------------------------------------------------------------------------
// Path resolution: the only way in
// ---------------------------------------------------------------------------

type SegmentCheck = SegmentProblem

interface ParsedRelativePath {
  segments: string[]
}

function parseRelativePath(input: string): { ok: true; value: ParsedRelativePath } | { ok: false; error: SegmentCheck } {
  if (/[\u0000-\u001f]/.test(input)) {
    return { ok: false, error: { code: 'PATH_INVALID', message: 'control characters are not allowed in a write path' } }
  }
  // One entry point: a write path is always relative to the project root, so
  // every absolute form (drive letter, drive-relative, UNC, device path) is
  // refused instead of being reinterpreted by `path.join`.
  if (isAbsolute(input) || /^[a-zA-Z]:/.test(input) || input.startsWith('\\\\') || input.startsWith('//')) {
    return {
      ok: false,
      error: {
        code: 'PATH_INVALID',
        message: 'the write path must be relative to the project root (no drive letter, UNC or absolute path)',
      },
    }
  }
  const segments = input.replaceAll('\\', '/').split('/')
  for (const segment of segments) {
    const check = checkSegment(segment)
    if (check !== undefined) return { ok: false, error: check }
  }
  return { ok: true, value: { segments } }
}

/**
 * Turn a caller-supplied relative path into a validated absolute write target.
 *
 * The checks run in a fixed order so the reported code names the real problem:
 * path shape → allowed directory → reserved plugin files → length → containment
 * (realpath, so a junction cannot smuggle the write out of the project).
 * Nothing here touches the disk except `stat`/`realpath` reads.
 */
export function resolveWriteTarget(projectRoot: string, relativePath: string): ResolveWriteTargetResult {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    return fail('PATH_INVALID', 'a project root is required', { path: String(relativePath) })
  }
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    return fail('PATH_INVALID', 'a relative write path is required', { root: projectRoot })
  }

  const rootInput = resolve(projectRoot.trim())
  const root = realpathLoose(rootInput)
  if (!isDirectory(root)) {
    return fail('PROJECT_NOT_FOUND', `the project root ${rootInput} is not a directory`, { root })
  }

  const parsed = parseRelativePath(relativePath)
  if (!parsed.ok) return fail(parsed.error.code, parsed.error.message, { root, path: relativePath })
  const segments = parsed.value.segments
  const dir = segments[0] ?? ''

  // The private state directory (ADR-0012) is writable only inside its declared
  // subdirectories: `trash/`, `backup/`, `audit/`, `candidates/`, `proposals/`,
  // `jobs/`, `review/`, `purged/`. `.inkflow/` itself and any other name under it stay
  // outside the whitelist, so the widening is a closed list of eight paths rather than
  // "a whole dot-directory the caller may shape freely" (X-18 added `candidates/`;
  // X-25 / ADR-0023 added `proposals/` and `jobs/`; the review tab added `review/`; the
  // purge area added `purged/`, the holding area for the private state the author cleaned up).
  const privateSub = dir === PRIVATE_STATE_DIR ? (segments[1] ?? '') : ''
  const inPrivateState = (PRIVATE_STATE_SUBDIRS as readonly string[]).includes(privateSub)

  if (!inPrivateState && !(WRITE_DIRS as readonly string[]).includes(dir)) {
    return fail('PATH_NOT_WRITABLE', `writes are limited to ${WRITE_DIRS.join(', ')} and ${PRIVATE_STATE_DIR}/{${PRIVATE_STATE_SUBDIRS.join(',')}} (got "${dir}")`, {
      root,
      path: relativePath,
      hint: 'a write target always lives inside one of the project directories; project metadata is written by the scaffolding tools',
    })
  }
  // A private-state target is `<dir>/<sub>/<file…>`, one segment deeper than a
  // content-directory target: `.inkflow/trash/a.md` names a file, `.inkflow/trash`
  // does not.
  const minimumSegments = inPrivateState ? 3 : 2
  if (segments.length < minimumSegments) {
    return fail('PATH_INVALID', 'a write target must name a file inside an allowed directory', { root, path: relativePath })
  }
  if (dir === INDEX_DIR) {
    // The plugin's own lock files must never be a caller's write target: a
    // "write the lock" call would be a self-inflicted lost lock.
    const rest = segments.slice(1).join('/')
    if (rest === LOCK_FILE || rest === INDEX_BUILD_LOCK_FILE) {
      return fail('PATH_NOT_WRITABLE', `${rest} is reserved for the plugin's own locks`, { root, path: relativePath })
    }
  }

  const relative = segments.join('/')
  const unresolved = join(root, ...segments)
  if (unresolved.length > MAX_WRITE_PATH) {
    return fail('PATH_TOO_LONG', `the write path is ${unresolved.length} characters; the limit is ${MAX_WRITE_PATH}`, {
      root,
      path: relative,
    })
  }

  const absolute = realpathLoose(unresolved)
  if (!isWithin(root, absolute)) {
    return fail('PATH_OUT_OF_SCOPE', `the target resolves outside the project root: ${absolute}`, {
      root,
      path: relative,
      hint: 'remove the symlink/junction that leaves the project directory',
    })
  }
  if (absolute.length > MAX_WRITE_PATH) {
    return fail('PATH_TOO_LONG', `the resolved write path is ${absolute.length} characters; the limit is ${MAX_WRITE_PATH}`, {
      root,
      path: relative,
    })
  }

  return {
    ok: true,
    target: {
      root,
      absolute,
      relative,
      dir,
      parent: dirname(absolute),
      exists: existsSync(absolute),
    },
  }
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/**
 * Remove temp files left by a dead writer. Called under the project lock, so no
 * other writer of this project is active; an orphan is garbage by construction.
 */
function sweepStaleTemps(dir: string): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const match = TEMP_FILE.exec(name)
    if (match === null) continue
    const pidText = match[1]
    const pid = pidText === undefined ? Number.NaN : Number.parseInt(pidText, 10)
    const path = join(dir, name)
    const ownerGone = Number.isInteger(pid) && pid > 0 && pid !== process.pid && !processAlive(pid)
    if (!ownerGone && fileAgeMs(path) <= STALE_TEMP_MS) continue
    try {
      rmSync(path, { force: true })
    } catch {
      // Held open by a crashed process on Windows: retried on the next write.
    }
  }
}

function normalizeText(text: string): string {
  // A BOM makes the file unreadable by JSON.parse and shows up in every diff;
  // CRLF mixed with LF makes every diff unreadable. Normalising at the write door
  // keeps the invariant in one place (data-safety §2.6). It is *not* a decision
  // about the file's format: a caller editing an existing file passes that file's
  // own style back (ADR-0016) and `applyTextStyle` re-applies it right after.
  const withoutBom = text.startsWith('\uFEFF') ? text.slice(1) : text
  return withoutBom.replace(/\r\n?/g, '\n')
}

/**
 * Temp file → fsync → rename over the target.
 *
 * The target is re-checked against the project root right before the temp file
 * is created: a junction created after `resolveWriteTarget` must not be able to
 * move the write outside the project (the sandbox-free host, H7, makes that a
 * data-safety concern rather than a theoretical one).
 */
function writeAtomically(target: WriteTarget, payload: string, options: AtomicWriteOptions): { bytes: number; tempFile: string } {
  const parent = target.parent
  if (options.createParents !== false) {
    try {
      mkdirSync(parent, { recursive: true })
    } catch (cause) {
      throw new IoWriteError('IO_FAILED', `cannot create ${parent}: ${messageOf(cause)}`, errnoOf(cause))
    }
  }

  const realParent = realpathLoose(parent)
  if (!isWithin(target.root, realParent)) {
    throw new IoWriteError('PATH_OUT_OF_SCOPE', `${parent} resolves outside the project root (${realParent})`, 'EACCES')
  }
  if (isDirectory(target.absolute)) {
    throw new IoWriteError('IO_FAILED', `${target.relative} is a directory, not a file`, 'EISDIR')
  }
  if (!isDirectory(realParent)) {
    throw new IoWriteError('IO_FAILED', `${realParent} is not a directory`, 'ENOTDIR')
  }

  sweepStaleTemps(realParent)

  const destination = join(realParent, basename(target.absolute))
  const temp = `${destination}.tmp-${process.pid}-${randomToken()}`
  const data = Buffer.from(payload, 'utf8')
  let fd: number | undefined
  try {
    fd = openSync(temp, 'wx', 0o644)
    let written = 0
    while (written < data.length) {
      written += writeSync(fd, data, written, data.length - written)
    }
    // Flush before the rename: a crash after the swap must not leave an empty
    // (but correctly named) chapter behind.
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, destination)
    return { bytes: data.length, tempFile: temp }
  } catch (cause) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Nothing useful to do; the temp file is removed below.
      }
    }
    try {
      rmSync(temp, { force: true })
    } catch {
      // Best effort: the temp-file sweep removes it on the next write.
    }
    if (cause instanceof IoWriteError) throw cause
    throw new IoWriteError('IO_FAILED', messageOf(cause), errnoOf(cause), temp)
  }
}

function openForWrite(
  projectRoot: string,
  relativePath: string,
): { ok: true; target: WriteTarget; lock: ProjectLock } | { ok: false; error: IoFailure } {
  const resolved = resolveWriteTarget(projectRoot, relativePath)
  if (!resolved.ok) return { ok: false, error: resolved.error }
  const target = resolved.target
  const locked = acquireProjectWriteLock(target.root)
  if (!locked.ok) return { ok: false, error: locked.error }
  return { ok: true, target, lock: locked.value }
}

/**
 * Atomically write a UTF-8 text file inside the project.
 *
 * Returns a structured result: `ok:false` carries a machine-readable code and
 * the previous file (if any) is still intact, with no temp file left behind.
 */
export function writeTextAtomic(
  projectRoot: string,
  relativePath: string,
  text: string,
  options: AtomicWriteOptions = {},
): WriteResult {
  if (typeof text !== 'string') {
    return fail('IO_FAILED', 'the content to write must be a string', { path: String(relativePath) })
  }
  const opened = openForWrite(projectRoot, relativePath)
  if (!opened.ok) return { ok: false, error: opened.error }
  const { target, lock } = opened
  try {
    const created = !existsSync(target.absolute)
    // Two steps, one door: normalise (the invariant), then re-serialise in the
    // style the caller asked for — the file's own style when it is being edited
    // (ADR-0016), LF/no-BOM for every new file.
    const payload =
      options.verbatim === true ? text : applyTextStyle(normalizeText(text), options.style ?? LF_STYLE)
    const result = writeAtomically(target, payload, options)
    return { ok: true, target: { ...target, exists: true }, bytes: result.bytes, created }
  } catch (cause) {
    return { ok: false, error: toFailure(cause, target.root, target.relative) }
  } finally {
    lock.release()
  }
}

/**
 * Atomically write a JSON file (`JSON.stringify(value, null, 2)` + LF), the
 * format every JSON file in an InkFlow project uses (inkflow.json, catalogs).
 */
export function writeJsonAtomic(
  projectRoot: string,
  relativePath: string,
  value: unknown,
  options: AtomicWriteOptions = {},
): WriteResult {
  let payload: string | undefined
  try {
    payload = JSON.stringify(value, null, 2)
  } catch (cause) {
    return fail('IO_FAILED', `the value is not JSON-serializable: ${messageOf(cause)}`, { path: String(relativePath) })
  }
  if (payload === undefined) {
    return fail('IO_FAILED', 'the value is not JSON-serializable (undefined has no JSON form)', {
      path: String(relativePath),
    })
  }
  return writeTextAtomic(projectRoot, relativePath, `${payload}\n`, options)
}

// ---------------------------------------------------------------------------
// Remove / rename (the non-textual half of the same door)
// ---------------------------------------------------------------------------

/**
 * A write payload can be expressed as text; a deletion and a directory rename
 * cannot. They are still project-scoped filesystem mutations, so they live here
 * — next to the path parser and the write lock — instead of in a business module
 * that would have to re-implement both. Every function below takes the same
 * `resolveWriteTarget` routes and the same single-writer lock as `writeTextAtomic`.
 */
export type RemoveResult = { ok: true; root: string; path: string; bytes: number } | { ok: false; error: IoFailure }

export type RenameResult = { ok: true; root: string; from: string; to: string } | { ok: false; error: IoFailure }

/**
 * Delete one project file. The manuscript has no second copy, so this is the
 * primitive the delete tool calls *after* it has captured the text for its own
 * rollback; recovery of an already deleted chapter is git's job, not ours.
 *
 * A directory is refused (`IO_FAILED`/`EISDIR`): deleting a chapter must never be
 * able to take a volume's whole directory with it.
 */
export function removeProjectFile(projectRoot: string, relativePath: string): RemoveResult {
  const opened = openForWrite(projectRoot, relativePath)
  if (!opened.ok) return { ok: false, error: opened.error }
  const { target, lock } = opened
  try {
    if (!target.exists) {
      return { ok: false, error: failure('PATH_NOT_FOUND', `${target.relative} does not exist`, { root: target.root, path: target.relative }) }
    }
    const info = statSync(target.absolute)
    if (info.isDirectory()) {
      return {
        ok: false,
        error: failure('IO_FAILED', `${target.relative} is a directory, not a file`, {
          root: target.root,
          path: target.relative,
          errno: 'EISDIR',
        }),
      }
    }
    unlinkSync(target.absolute)
    return { ok: true, root: target.root, path: target.relative, bytes: info.size }
  } catch (cause) {
    return { ok: false, error: toFailure(cause, target.root, target.relative) }
  } finally {
    lock.release()
  }
}

/**
 * Remove an **empty** directory (used to roll back a half-created volume). A
 * non-empty directory is refused (`ENOTEMPTY`): the caller must never be able to
 * erase chapters as a side effect of undoing a directory creation.
 */
export function removeEmptyProjectDirectory(projectRoot: string, relativePath: string): RemoveResult {
  const opened = openForWrite(projectRoot, relativePath)
  if (!opened.ok) return { ok: false, error: opened.error }
  const { target, lock } = opened
  try {
    if (!target.exists || !isDirectory(target.absolute)) {
      return {
        ok: false,
        error: failure('PATH_NOT_FOUND', `${target.relative} is not an existing directory`, {
          root: target.root,
          path: target.relative,
        }),
      }
    }
    rmdirSync(target.absolute)
    return { ok: true, root: target.root, path: target.relative, bytes: 0 }
  } catch (cause) {
    return { ok: false, error: toFailure(cause, target.root, target.relative) }
  } finally {
    lock.release()
  }
}

/**
 * Rename a directory inside the project (a volume directory, in practice).
 *
 * Both ends go through `resolveWriteTarget`, so a rename cannot leave the
 * allowed directories or the project subtree, and the source must be an existing
 * directory while the destination must not exist yet: `renameSync` over an
 * existing directory behaves differently on Windows and POSIX, and a silently
 * merged directory is exactly the kind of half-state the catalog cannot express.
 */
export function renameProjectDirectory(projectRoot: string, fromRelative: string, toRelative: string): RenameResult {
  if (typeof fromRelative !== 'string' || typeof toRelative !== 'string') {
    return { ok: false, error: failure('PATH_INVALID', 'both the source and the destination are required') }
  }
  const from = resolveWriteTarget(projectRoot, fromRelative)
  if (!from.ok) return { ok: false, error: from.error }
  const to = resolveWriteTarget(from.target.root, toRelative)
  if (!to.ok) return { ok: false, error: to.error }

  const locked = acquireProjectWriteLock(from.target.root)
  if (!locked.ok) return { ok: false, error: locked.error }
  const lock = locked.value
  try {
    const source = from.target
    const destination = to.target
    if (source.absolute === destination.absolute) {
      return {
        ok: false,
        error: failure('PATH_INVALID', 'the source and the destination are the same directory', {
          root: source.root,
          path: source.relative,
        }),
      }
    }
    if (!source.exists || !isDirectory(source.absolute)) {
      return {
        ok: false,
        error: failure('PATH_NOT_FOUND', `${source.relative} is not an existing directory`, {
          root: source.root,
          path: source.relative,
        }),
      }
    }
    if (destination.exists) {
      return {
        ok: false,
        error: failure('TARGET_EXISTS', `${destination.relative} already exists`, {
          root: source.root,
          path: destination.relative,
          hint: 'pick another slug; a rename never merges two directories',
        }),
      }
    }
    // `chapters/vol-01` → `chapters/vol-01/inner` would need an infinite move.
    if (isWithin(source.absolute, destination.absolute)) {
      return {
        ok: false,
        error: failure('PATH_INVALID', 'a directory cannot be moved inside itself', {
          root: source.root,
          path: destination.relative,
        }),
      }
    }
    try {
      mkdirSync(destination.parent, { recursive: true })
    } catch (cause) {
      throw new IoWriteError('IO_FAILED', `cannot create ${destination.parent}: ${messageOf(cause)}`, errnoOf(cause))
    }
    const realParent = realpathLoose(destination.parent)
    if (!isWithin(source.root, realParent)) {
      throw new IoWriteError('PATH_OUT_OF_SCOPE', `${destination.parent} resolves outside the project root (${realParent})`, 'EACCES')
    }
    renameSync(source.absolute, join(realParent, basename(destination.absolute)))
    return { ok: true, root: source.root, from: source.relative, to: destination.relative }
  } catch (cause) {
    return { ok: false, error: toFailure(cause, from.target.root, from.target.relative) }
  } finally {
    lock.release()
  }
}

// ---------------------------------------------------------------------------
// The rest of the door, at its original addresses
// ---------------------------------------------------------------------------

export { acquireProjectWriteLock, withProjectWriteLock } from './io-lock.js'

export type {
  AtomicWriteOptions,
  IoErrorCode,
  IoFailure,
  IoResult,
  ProjectLock,
  ProjectLockResult,
  ResolveWriteTargetResult,
  WriteResult,
  WriteTarget,
} from './io-types.js'
