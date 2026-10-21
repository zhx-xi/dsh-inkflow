/**
 * Atomic index build (ADR-0005: the index is a rebuildable cache).
 *
 * This module owns *where and when* an index gets written; `indexer.ts` owns
 * *what* gets written (scan + validate + schema). The split exists because the
 * failure modes below are the risky part and deserve to be read on their own:
 *
 *   - the database is built in `index/.inkflow.db.build-<pid>-<rand>` and only
 *     renamed over `inkflow.db` after a successful, fsynced build — a failed
 *     build (parse error, SQLITE_*, EPERM because somebody holds the old file)
 *     therefore leaves the previous index readable;
 *   - concurrent callers in one process share a single in-flight build;
 *   - across processes a best-effort `index/.lock` makes the loser fail fast
 *     with INDEX_BUSY instead of blocking or trampling the winner;
 *   - every failure is an `IndexBuildError` so tools/routes can answer with a
 *     structured value instead of handing the model a stack trace.
 *
 * 2026-10-21 measured on Windows (Node 24.16): rename over a database that
 * another handle has open fails with EPERM, and fsync needs a read/write handle.
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
import { join, resolve } from 'node:path'

import { INDEX_SCHEMA_VERSION } from './conventions.js'
import { indexPaths, scanProject, writeIndexDatabase } from './indexer.js'
import type { IndexBuildResult, ScanResult } from './indexer.js'

export type IndexBuildErrorCode = 'INDEX_BUILD_FAILED' | 'INDEX_BUSY'

export interface IndexBuildErrorDetails {
  errno: string
  root: string
  cause?: unknown
  /** The build temp file the failure happened on (for diagnostics/tests). */
  tempFile?: string
}

/**
 * Structured failure for `buildIndex`.
 *
 * Tools and HTTP routes catch this and answer `{ ok:false, error:{ code, errno,
 * message } }` — a model must never be handed a bare stack trace, and a failed
 * build must never take the previous (still usable) index down with it.
 */
export class IndexBuildError extends Error {
  readonly code: IndexBuildErrorCode
  readonly errno: string
  readonly root: string
  readonly tempFile: string | undefined

  constructor(code: IndexBuildErrorCode, message: string, details: IndexBuildErrorDetails) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause })
    this.name = 'IndexBuildError'
    this.code = code
    this.errno = details.errno
    this.root = details.root
    this.tempFile = details.tempFile
  }
}

export interface IndexBuildFailure {
  code: IndexBuildErrorCode
  errno: string
  message: string
  root?: string
}

/**
 * Map anything thrown by `buildIndex` onto the structured error shape.
 * Duck-typed as well as `instanceof`, so two loadings of this module (or an
 * error that crossed a bundle boundary) still surface as `INDEX_BUSY`.
 */
export function describeIndexBuildFailure(cause: unknown): IndexBuildFailure {
  if (cause instanceof IndexBuildError) {
    return { code: cause.code, errno: cause.errno, message: cause.message, root: cause.root }
  }
  if (typeof cause === 'object' && cause !== null) {
    const record = cause as Record<string, unknown>
    const code = record['code']
    if (code === 'INDEX_BUILD_FAILED' || code === 'INDEX_BUSY') {
      const failure: IndexBuildFailure = {
        code,
        errno: typeof record['errno'] === 'string' ? record['errno'] : 'EUNKNOWN',
        message: typeof record['message'] === 'string' ? record['message'] : 'index build failed',
      }
      if (typeof record['root'] === 'string') failure.root = record['root']
      return failure
    }
  }
  return { code: 'INDEX_BUILD_FAILED', errno: 'EUNKNOWN', message: messageOf(cause) }
}

// ---------------------------------------------------------------------------
// Atomic build: temp file + rename, single-flight inside the process and a
// best-effort `index/.lock` across processes.
// ---------------------------------------------------------------------------

interface FileLock {
  release: () => void
}

const BUILD_TEMP_PREFIX = '.inkflow.db.build-'
const LOCK_FILE = '.lock'
/** A lock older than this is treated as left behind by a hung/crashed build. */
const STALE_LOCK_MS = 10 * 60_000
/** The lock file is created before its pid is written: do not judge it too early. */
const LOCK_WRITE_GRACE_MS = 10_000
const MAX_ERROR_MESSAGE = 300

function randomToken(): string {
  return randomBytes(6).toString('hex')
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
  // Index build errors may quote a path (never novel text); still bound them so
  // a giant SQLITE_* message cannot flood the model's context.
  return raw.length > MAX_ERROR_MESSAGE ? `${raw.slice(0, MAX_ERROR_MESSAGE)}...` : raw
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
    // "no such process" proves the lock holder is gone.
    return errnoOf(cause) === 'EPERM'
  }
}

/**
 * A lock left by a killed build must never wedge the project: it is stale when
 * its pid is dead, when its recorded start is older than `STALE_LOCK_MS`, or
 * when an unparsable lock file has been sitting there past the write grace.
 */
function lockIsStale(lockPath: string): boolean {
  let raw: string
  try {
    raw = readFileSync(lockPath, 'utf8')
  } catch {
    return true // vanished between EEXIST and the read: retry the O_EXCL create
  }
  let pid: unknown
  let startedAt: unknown
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return fileAgeMs(lockPath) > LOCK_WRITE_GRACE_MS
    pid = (parsed as Record<string, unknown>)['pid']
    startedAt = (parsed as Record<string, unknown>)['startedAt']
  } catch {
    return fileAgeMs(lockPath) > LOCK_WRITE_GRACE_MS
  }
  // A lock carrying *our own* pid cannot belong to a live build of this module
  // instance: `buildIndex` single-flights and releases it in `finally`. Treating
  // it as stale keeps a failed release (or a dead previous plugin generation)
  // from wedging this process for STALE_LOCK_MS while it keeps serving tools.
  if (typeof pid === 'number' && pid === process.pid) return true
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && !processAlive(pid)) return true
  if (typeof startedAt === 'number') return Date.now() - startedAt > STALE_LOCK_MS
  return fileAgeMs(lockPath) > STALE_LOCK_MS
}

/**
 * Project-level, best-effort, cross-process lock (`index/.lock`, created with
 * O_EXCL). Inside one process `buildIndex` already single-flights, so this only
 * arbitrates between sessions/processes and never waits: a live lock means
 * INDEX_BUSY, returned immediately.
 */
function acquireBuildLock(dir: string, root: string): FileLock {
  const lockPath = join(dir, LOCK_FILE)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomToken()
    let fd: number
    try {
      fd = openSync(lockPath, 'wx', 0o600)
    } catch (cause) {
      if (errnoOf(cause) !== 'EEXIST') {
        throw new IndexBuildError('INDEX_BUILD_FAILED', `cannot create the index lock ${lockPath}: ${messageOf(cause)}`, {
          errno: errnoOf(cause),
          root,
        })
      }
      if (attempt === 0 && lockIsStale(lockPath)) {
        try {
          unlinkSync(lockPath)
        } catch {
          // Another process removed/replaced it first: the retry decides.
        }
        continue
      }
      throw new IndexBuildError('INDEX_BUSY', `another index build is already running for ${root}`, {
        errno: 'EBUSY',
        root,
      })
    }
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }))
    } catch (cause) {
      try {
        unlinkSync(lockPath)
      } catch {
        // Best effort: a half-written lock becomes stale after the grace period.
      }
      throw new IndexBuildError('INDEX_BUILD_FAILED', `cannot write the index lock ${lockPath}: ${messageOf(cause)}`, {
        errno: errnoOf(cause),
        root,
      })
    } finally {
      closeSync(fd)
    }
    return { release: () => releaseBuildLock(lockPath, token) }
  }
  throw new IndexBuildError('INDEX_BUSY', `another index build is already running for ${root}`, {
    errno: 'EBUSY',
    root,
  })
}

function releaseBuildLock(lockPath: string, token: string): void {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return
    if ((parsed as { token?: unknown }).token !== token) return
    unlinkSync(lockPath)
  } catch {
    // Best effort: the next build treats a leftover lock as stale.
  }
}

/** Only called while holding `.lock`, so every build temp file is garbage. */
function removeStaleBuildFiles(dir: string): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.startsWith(BUILD_TEMP_PREFIX)) continue
    try {
      rmSync(join(dir, name), { force: true })
    } catch {
      // Held open by a crashed process on Windows: retried on the next build.
    }
  }
}

function removeBuildArtifacts(tempFile: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      rmSync(`${tempFile}${suffix}`, { force: true })
    } catch {
      // Best effort: the next build removes everything with the build prefix.
    }
  }
}

/**
 * Swap the finished temp database in.
 *
 * The old `-wal`/`-shm` belong to the previous database generation: replaying
 * them into the new file would corrupt it, so they are removed first. Both the
 * unlink and the rename fail with EPERM/EBUSY on Windows while another process
 * holds the file — and then nothing has been replaced, so the old index stays
 * readable and a later call can retry.
 */
function replaceIndexFile(tempFile: string, dbFile: string, root: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const side = `${dbFile}${suffix}`
    if (!existsSync(side)) continue
    try {
      unlinkSync(side)
    } catch (cause) {
      throw new IndexBuildError('INDEX_BUILD_FAILED', `cannot replace the index: could not remove the previous ${side} (${errnoOf(cause)})`, {
        errno: errnoOf(cause),
        root,
        tempFile,
      })
    }
  }
  renameSync(tempFile, dbFile)
}

function fsyncFile(path: string): void {
  // 'r+' and not 'r': Windows refuses FlushFileBuffers on a read-only handle
  // (measured: fsyncSync(fd from 'r') throws EPERM, from 'r+' succeeds).
  const fd = openSync(path, 'r+')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

const inFlightBuilds = new Map<string, Promise<IndexBuildResult>>()

/**
 * Build (or rebuild) the derived index from the project's files.
 *
 * Concurrent calls for the same root share one in-flight build (single-flight),
 * so two sessions cannot write the same database at once. Across processes
 * `index/.lock` arbitrates; not getting it is reported as `INDEX_BUSY`
 * immediately instead of blocking the caller.
 */
export function buildIndex(root: string): Promise<IndexBuildResult> {
  const key = resolve(root)
  const existing = inFlightBuilds.get(key)
  if (existing !== undefined) return existing

  let promise: Promise<IndexBuildResult> | undefined
  const run = async (): Promise<IndexBuildResult> => {
    // Yield once before the synchronous build, so a second caller in the same
    // tick sees the in-flight entry instead of starting a second build.
    await Promise.resolve()
    try {
      return performBuild(key)
    } finally {
      if (promise !== undefined && inFlightBuilds.get(key) === promise) inFlightBuilds.delete(key)
    }
  }
  promise = run()
  inFlightBuilds.set(key, promise)
  return promise
}

function performBuild(root: string): IndexBuildResult {
  const started = Date.now()
  const paths = indexPaths(root)
  const buildId = randomToken()
  let tempFile: string | undefined
  let lock: FileLock | undefined
  try {
    // The gate guarantees the project and recreates `index/` when it is the
    // only missing directory; mirror that here for direct buildIndex() callers.
    mkdirSync(paths.dir, { recursive: true })
    lock = acquireBuildLock(paths.dir, root)
    removeStaleBuildFiles(paths.dir)

    tempFile = join(paths.dir, `${BUILD_TEMP_PREFIX}${process.pid}-${randomToken()}`)
    const scan = scanProject(root)
    const builtAt = writeIndexDatabase(tempFile, root, scan)
    fsyncFile(tempFile)
    replaceIndexFile(tempFile, paths.dbFile, root)
    tempFile = undefined // ownership moved to the real path

    return {
      root,
      dbFile: paths.dbFile,
      schemaVersion: INDEX_SCHEMA_VERSION,
      mode: 'rebuilt',
      counts: scan.counts,
      issues: scan.issues,
      ms: Date.now() - started,
      builtAt,
      buildId,
    }
  } catch (cause) {
    throw toIndexBuildError(cause, root, tempFile)
  } finally {
    if (tempFile !== undefined) removeBuildArtifacts(tempFile)
    lock?.release()
  }
}

function toIndexBuildError(cause: unknown, root: string, tempFile: string | undefined): IndexBuildError {
  if (cause instanceof IndexBuildError) return cause
  return new IndexBuildError('INDEX_BUILD_FAILED', `index build failed for ${root}: ${messageOf(cause)}`, {
    errno: errnoOf(cause),
    root,
    ...(tempFile === undefined ? {} : { tempFile }),
    cause,
  })
}