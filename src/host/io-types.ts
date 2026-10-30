/**
 * The write door's contract: what a refusal, a write target, a lock and a result
 * ARE, with no behaviour behind them.
 *
 * WHY IT IS A FILE: the door is three modules now — `io.ts` (path parser +
 * atomic write + delete/rename), `io-lock.ts` (one writer per project) and
 * `io-support.ts` (the shared plumbing) — and every caller outside the door
 * names these shapes too. A leaf module is what keeps the three acyclic: each
 * depends on this file, none on another.
 */

import type { TextStyle } from './text-style.js'

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
  /** The source of a move/delete does not exist (or is not the kind it must be). */
  | 'PATH_NOT_FOUND'
  /** The destination of a move already exists; moves never overwrite a file. */
  | 'TARGET_EXISTS'
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
  /**
   * Write the string exactly as given instead of the normalised form.
   *
   * The normal path strips a BOM and rewrites CRLF to LF (one place for the
   * encoding invariant). A rollback has the opposite job: it must put the
   * *previous bytes* back, so it passes `verbatim: true` and skips both steps.
   */
  verbatim?: boolean
  /**
   * The style to serialise the normalised payload in (ADR-0016).
   *
   * Normalisation is not the end of the story: an existing chapter has a format
   * of its own (CRLF, a BOM), and rewriting it to LF turns a one-character edit
   * into a whole-chapter diff. Omitted = a new file, i.e. `LF_STYLE`.
   */
  style?: TextStyle
}
