/**
 * What every part of the write door shares: the two reserved lock names, how a
 * failure is worded and classified, and the four probes that decide liveness.
 *
 * WHY IT IS A FILE: `io.ts` (paths, atomic write, delete/rename) and
 * `io-lock.ts` (one writer per project) need exactly the same helpers, and
 * neither may import the other — the lock is what the write path takes, not
 * where the write path lives. Putting the helpers here makes the two
 * capabilities siblings instead of a chain.
 */

import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'

import type { IoErrorCode, IoFailure } from './io-types.js'

// ---------------------------------------------------------------------------
// Names and bounds the whole door shares
// ---------------------------------------------------------------------------

/** The project write lock lives next to the derived index (never committed). */
export const LOCK_FILE = '.write.lock'
/** `index-build.ts` owns that one; it is not a legal write target for callers. */
export const INDEX_BUILD_LOCK_FILE = '.lock'

/** A quoted OS message is shown to the model: bound it so it cannot flood the context. */
const MAX_ERROR_MESSAGE = 300

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

export function failure(code: IoErrorCode, message: string, extra: FailureExtra = {}): IoFailure {
  const result: IoFailure = { code, message, root: extra.root ?? '' }
  if (extra.path !== undefined) result.path = extra.path
  if (extra.errno !== undefined) result.errno = extra.errno
  if (extra.hint !== undefined) result.hint = extra.hint
  if (extra.tempFile !== undefined) result.tempFile = extra.tempFile
  return result
}

export function fail(code: IoErrorCode, message: string, extra: FailureExtra = {}): { ok: false; error: IoFailure } {
  return { ok: false, error: failure(code, message, extra) }
}

export function errnoOf(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null) {
    const code = (cause as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  return 'EUNKNOWN'
}

export function messageOf(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  // Errors may quote a path (never novel text); bound them so a giant OS
  // message cannot flood the model's context.
  return raw.length > MAX_ERROR_MESSAGE ? `${raw.slice(0, MAX_ERROR_MESSAGE)}...` : raw
}

export function randomToken(): string {
  return randomBytes(6).toString('hex')
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function fileAgeMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export function processAlive(pid: number): boolean {
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
export class IoWriteError extends Error {
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

export function toFailure(cause: unknown, root: string, path: string | undefined): IoFailure {
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
