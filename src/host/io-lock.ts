/**
 * One writer per project: `index/.write.lock`, created with O_EXCL, re-entrant
 * inside this process, released only by the writer that still owns its token.
 *
 * WHY IT IS A FILE: the lock answers "may this process touch the book at all",
 * while `io.ts` answers "is this path a legal target and how do the new bytes
 * replace the old ones". They meet at exactly two entry points
 * (`acquireProjectWriteLock` / `withProjectWriteLock`), so the lock is not part
 * of the write path's body — and a stale lock can be reasoned about without
 * reading a single line of the atomic replace.
 */

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { INDEX_DIR } from './conventions.js'
import type { IoResult, ProjectLock, ProjectLockResult } from './io-types.js'
import {
  LOCK_FILE,
  errnoOf,
  fail,
  fileAgeMs,
  isDirectory,
  messageOf,
  processAlive,
  randomToken,
  toFailure,
} from './io-support.js'
import { realpathLoose } from './project.js'

/** A lock older than this was left behind by a hung/crashed writer. */
const STALE_LOCK_MS = 10 * 60_000
/** The lock file is created before its pid is written: do not judge it too early. */
const LOCK_WRITE_GRACE_MS = 10_000

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
