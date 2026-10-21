/**
 * The single write door of the plugin (issue #14).
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
 */

import { randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { INDEX_DIR, WRITE_DIRS } from './conventions.js'
import { isWithin, realpathLoose } from './project.js'

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export type IoErrorCode =
  /** The path itself is not a legal write target (empty, `..`, absolute, UNC, illegal characters). */
  | 'PATH_INVALID'
  /** The path resolves outside the project root (junction/symlink escape). */
  | 'PATH_OUT_OF_SCOPE'
  /** The first segment is not one of the nine content directories or `index/`. */
  | 'PATH_NOT_WRITABLE'
  /** A Windows reserved device name (CON/PRN/AUX/NUL/COM1-9/LPT1-9). */
  | 'PATH_RESERVED'
  /** Longer than a write may safely be (240 characters) or a segment over 255. */
  | 'PATH_TOO_LONG'
  /** `projectRoot` is missing or not a directory. */
  | 'PROJECT_NOT_FOUND'
  /** Another session/process holds the project write lock. */
  | 'PROJECT_BUSY'
  /** The filesystem refused the operation (permissions, sharing violation, disk). */
  | 'IO_FAILED'

/** The model-facing shape of a refused or failed write. */
export interface IoFailure {
  code: IoErrorCode
  message: string
  /** Project root the operation was scoped to (realpath). */
  root: string
  /** Project-relative path that was rejected, when there is one. */
  path?: string
  /** Filesystem errno (`EPERM`, `ENOSPC`, ...) when the OS reported one. */
  errno?: string
  hint?: string
  /** Temp file the failure happened on (diagnostics/tests only). */
  tempFile?: string
}

/** A validated write destination. */
export interface WriteTarget {
  /** Realpath of the project root. */
  root: string
  /** Realpath-resolved absolute path of the (possibly not yet existing) file. */
  absolute: string
  /** Normalized project-relative path, always with `/` separators. */
  relative: string
  /** First segment: the allowed directory the file lives in. */
  dir: string
  /** Absolute directory that will hold the file. */
  parent: string
  exists: boolean
}

export type ResolveWriteTargetResult = { ok: true; target: WriteTarget } | { ok: false; error: IoFailure }

export type WriteResult =
  | { ok: true; target: WriteTarget; bytes: number; created: boolean }
  | { ok: false; error: IoFailure }

/** A held project write lock. `release()` is idempotent and token-verified. */
export interface ProjectLock {
  readonly root: string
  readonly token: string
  release(): void
}

export type ProjectLockResult = { ok: true; value: ProjectLock } | { ok: false; error: IoFailure }

export type IoResult<T> = { ok: true; value: T } | { ok: false; error: IoFailure }

export interface AtomicWriteOptions {
  /**
   * Create the parent directories of the target (default true). A chapter write
   * needs `chapters/vol-01/` to exist even though the volume has no file yet.
   */
  createParents?: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The project write lock lives next to the derived index (never committed). */
const LOCK_FILE = '.write.lock'
/** `index-build.ts` owns that one; it is not a legal write target for callers. */
const INDEX_BUILD_LOCK_FILE = '.lock'

/**
 * Windows refuses paths over ~260 characters unless long paths are enabled, and
 * the plugin must not depend on a machine-level setting: 240 leaves room for the
 * `.tmp-<pid>-<rand>` suffix added to the same directory.
 */
const MAX_WRITE_PATH = 240
/** Per-component limit on NTFS. */
const MAX_SEGMENT = 255
/** A lock older than this was left behind by a hung/crashed writer. */
const STALE_LOCK_MS = 10 * 60_000
/** The lock file is created before its pid is written: do not judge it too early. */
const LOCK_WRITE_GRACE_MS = 10_000
/** A temp file older than this is garbage even if its pid is still alive. */
const STALE_TEMP_MS = 10 * 60_000
const MAX_ERROR_MESSAGE = 300

/** `<name>.tmp-<pid>-<rand>` — see docs/conventions.md §5. */
const TEMP_FILE = /\.tmp-(\d+)-[0-9a-f]+$/

/**
 * Device names Windows reserves: `CON.md` creates a file that no tool can open
 * again, and `COM1` writes to a serial port. Checked on every platform so a
 * project stays portable between the machines that share it.
 */
const WINDOWS_RESERVED = new Set<string>([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_unused, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_unused, index) => `LPT${index + 1}`),
])

/** Characters NTFS treats specially; legal on POSIX, but not portable. */
const UNSAFE_SEGMENT_CHARS = /[<>:"|?*]/

// ---------------------------------------------------------------------------
// Failure helpers
// ---------------------------------------------------------------------------

interface FailureExtra {
  root?: string
  path?: string
  errno?: string
  hint?: string
  tempFile?: string
}

function failure(code: IoErrorCode, message: string, extra: FailureExtra = {}): IoFailure {
  const result: IoFailure = { code, message, root: extra.root ?? '' }
  if (extra.path !== undefined) result.path = extra.path
  if (extra.errno !== undefined) result.errno = extra.errno
  if (extra.hint !== undefined) result.hint = extra.hint
  if (extra.tempFile !== undefined) result.tempFile = extra.tempFile
  return result
}

function fail(code: IoErrorCode, message: string, extra: FailureExtra = {}): { ok: false; error: IoFailure } {
  return { ok: false, error: failure(code, message, extra) }
}

function errnoOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  return 'EUNKNOWN'
}

function messageOf(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  // Errors may quote a path (never novel text); bound them so a giant OS
  // message cannot flood the model's context.
  return raw.length > MAX_ERROR_MESSAGE ? `${raw.slice(0, MAX_ERROR_MESSAGE)}...` : raw
}

function randomToken(): string {
  return randomBytes(6).toString('hex')
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function fileAgeMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    // Windows reports EPERM for a live process owned by somebody else; only
    // "no such process" proves the lock/temp owner is gone.
    return errnoOf(cause) === 'EPERM'
  }
}

/** Internal carrier for an already-classified write failure. */
class IoWriteError extends Error {
  readonly code: IoErrorCode
  readonly errno: string
  readonly tempFile: string | undefined

  constructor(code: IoErrorCode, message: string, errno: string, tempFile?: string) {
    super(message)
    this.name = 'IoWriteError'
    this.code = code
    this.errno = errno
    this.tempFile = tempFile
  }
}

function toFailure(cause: unknown, root: string, path: string | undefined): IoFailure {
  const extra: FailureExtra = { root }
  if (path !== undefined) extra.path = path
  if (cause instanceof IoWriteError) {
    extra.errno = cause.errno
    if (cause.tempFile !== undefined) extra.tempFile = cause.tempFile
    return failure(cause.code, cause.message, extra)
  }
  const errno = errnoOf(cause)
  if (errno !== 'EUNKNOWN') extra.errno = errno
  return failure('IO_FAILED', messageOf(cause), extra)
}

// ---------------------------------------------------------------------------
// Path resolution: the only way in
// ---------------------------------------------------------------------------

type SegmentCheck = { code: IoErrorCode; message: string }

function checkSegment(segment: string): SegmentCheck | undefined {
  if (segment === '') return { code: 'PATH_INVALID', message: 'a write path must not contain empty segments' }
  if (segment === '.' || segment === '..') {
    return { code: 'PATH_INVALID', message: `"${segment}" segments are not allowed; the path is already relative to the project root` }
  }
  if (segment.length > MAX_SEGMENT) {
    return { code: 'PATH_TOO_LONG', message: `the file name is ${segment.length} characters; the limit is ${MAX_SEGMENT}` }
  }
  if (UNSAFE_SEGMENT_CHARS.test(segment)) {
    return { code: 'PATH_INVALID', message: `the file name contains a character that is not portable: ${segment}` }
  }
  // Windows strips trailing dots and spaces, so `x.md.` and `x.md ` silently
  // address the same file as `x.md` while looking like different chapters.
  if (/[. ]$/.test(segment)) {
    return { code: 'PATH_INVALID', message: `a file name must not end with a dot or a space: ${segment}` }
  }
  const stem = (segment.split('.')[0] ?? '').toUpperCase()
  if (WINDOWS_RESERVED.has(stem)) {
    return { code: 'PATH_RESERVED', message: `"${segment}" uses the reserved Windows device name ${stem}` }
  }
  return undefined
}

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

  if (!(WRITE_DIRS as readonly string[]).includes(dir)) {
    return fail('PATH_NOT_WRITABLE', `writes are limited to ${WRITE_DIRS.join(', ')} (got "${dir}")`, {
      root,
      path: relativePath,
      hint: 'a write target always lives inside one of the project directories; project metadata is written by the scaffolding tools',
    })
  }
  if (segments.length < 2) {
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
// Project write lock
// ---------------------------------------------------------------------------

interface HeldLock {
  token: string
  depth: number
  path: string
}

/** Locks this process holds, keyed by realpath root (nested writes reuse them). */
const heldLocks = new Map<string, HeldLock>()

/**
 * A lock is stale when the holder is provably gone: a dead pid, an unparsable
 * file older than the write grace, or a recorded start older than STALE_LOCK_MS.
 *
 * A lock carrying *our own* pid but absent from `heldLocks` is stale too: it
 * belongs to a previous plugin generation (or a release that failed), and
 * honoring it would wedge every write in this process for ten minutes.
 */
function lockIsStale(lockPath: string): boolean {
  let raw: string
  try {
    raw = readFileSync(lockPath, 'utf8')
  } catch {
    return true // vanished between EEXIST and the read: retry the O_EXCL create
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fileAgeMs(lockPath) > LOCK_WRITE_GRACE_MS
  }
  if (typeof parsed !== 'object' || parsed === null) return fileAgeMs(lockPath) > LOCK_WRITE_GRACE_MS
  const record = parsed as Record<string, unknown>
  const pid = record['pid']
  const startedAt = record['startedAt']
  if (typeof pid === 'number' && pid === process.pid) return true
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && !processAlive(pid)) return true
  if (typeof startedAt === 'number') return Date.now() - startedAt > STALE_LOCK_MS
  return fileAgeMs(lockPath) > STALE_LOCK_MS
}

function releaseProjectWriteLock(root: string, entry: HeldLock): void {
  const current = heldLocks.get(root)
  // A stale-heal may have replaced the entry; never drop the new owner's depth.
  if (current !== entry) return
  entry.depth -= 1
  if (entry.depth > 0) return
  heldLocks.delete(root)
  try {
    const parsed: unknown = JSON.parse(readFileSync(entry.path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return
    // Token check: after a stale-heal race this file belongs to somebody else.
    if ((parsed as { token?: unknown }).token !== entry.token) return
    unlinkSync(entry.path)
  } catch {
    // Best effort: the next writer treats a leftover lock as stale.
  }
}

type LockFileOpen = { kind: 'created'; fd: number } | { kind: 'exists' } | { kind: 'failed'; errno: string; cause: unknown }

function tryCreateLockFile(lockPath: string): LockFileOpen {
  try {
    return { kind: 'created', fd: openSync(lockPath, 'wx', 0o600) }
  } catch (cause) {
    const errno = errnoOf(cause)
    if (errno === 'EEXIST') return { kind: 'exists' }
    return { kind: 'failed', errno, cause }
  }
}

/**
 * Take the project write lock (`index/.write.lock`, created with O_EXCL).
 *
 * The lock is re-entrant within one process: a nested acquire returns the lock
 * already held and only the outermost release removes the file. Across
 * processes/plugin generations it never waits — a live holder means
 * `PROJECT_BUSY` immediately, so a tool cannot hang behind another session.
 */
export function acquireProjectWriteLock(projectRoot: string): ProjectLockResult {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    return fail('PATH_INVALID', 'a project root is required')
  }
  const input = resolve(projectRoot.trim())
  const root = realpathLoose(input)
  if (!isDirectory(root)) {
    return fail('PROJECT_NOT_FOUND', `the project root ${input} is not a directory`, { root })
  }

  const held = heldLocks.get(root)
  if (held !== undefined) {
    held.depth += 1
    return { ok: true, value: { root, token: held.token, release: () => releaseProjectWriteLock(root, held) } }
  }

  const lockDir = join(root, INDEX_DIR)
  try {
    mkdirSync(lockDir, { recursive: true })
  } catch (cause) {
    return fail('IO_FAILED', `cannot create the index directory ${lockDir}: ${messageOf(cause)}`, {
      root,
      errno: errnoOf(cause),
    })
  }
  const lockPath = join(lockDir, LOCK_FILE)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomToken()
    const opened = tryCreateLockFile(lockPath)
    if (opened.kind === 'failed') {
      return fail('IO_FAILED', `cannot create the project lock ${lockPath}: ${messageOf(opened.cause)}`, {
        root,
        errno: opened.errno,
      })
    }
    if (opened.kind === 'exists') {
      if (attempt === 0 && lockIsStale(lockPath)) {
        try {
          unlinkSync(lockPath)
        } catch {
          // Another process removed/replaced it first: the retry decides.
        }
        continue
      }
      return fail('PROJECT_BUSY', `another session is writing to ${root}; retry when it is done`, {
        root,
        errno: 'EBUSY',
        hint: 'the project write lock is single-writer; wait for the other write (or remove a stale index/.write.lock)',
      })
    }
    const { fd } = opened
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }))
    } catch (cause) {
      try {
        unlinkSync(lockPath)
      } catch {
        // A half-written lock becomes stale after the grace period.
      }
      return fail('IO_FAILED', `cannot write the project lock ${lockPath}: ${messageOf(cause)}`, {
        root,
        errno: errnoOf(cause),
      })
    } finally {
      closeSync(fd)
    }
    const entry: HeldLock = { token, depth: 1, path: lockPath }
    heldLocks.set(root, entry)
    return { ok: true, value: { root, token, release: () => releaseProjectWriteLock(root, entry) } }
  }

  return fail('PROJECT_BUSY', `another session is writing to ${root}; retry when it is done`, { root, errno: 'EBUSY' })
}

/**
 * Run `body` while holding the project write lock. Used by multi-file operations
 * (scaffolding, repair, chapter + catalog) that must not interleave with another
 * session halfway through. The lock is released even when the body throws.
 */
export function withProjectWriteLock<T>(projectRoot: string, body: (lock: ProjectLock) => T): IoResult<T> {
  const locked = acquireProjectWriteLock(projectRoot)
  if (!locked.ok) return { ok: false, error: locked.error }
  const lock = locked.value
  try {
    return { ok: true, value: body(lock) }
  } catch (cause) {
    return { ok: false, error: toFailure(cause, lock.root, undefined) }
  } finally {
    lock.release()
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
  // CRLF is rewritten by .gitattributes on the next commit. Normalizing at the
  // write door keeps the invariant in one place (data-safety §2.4).
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
    const result = writeAtomically(target, normalizeText(text), options)
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
