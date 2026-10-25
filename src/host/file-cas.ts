/**
 * Write-time compare-and-swap on a project file.
 *
 * Files are the truth (ADR-0005), which means a human can edit a chapter in
 * their own editor at any moment — including between "the model read it" and
 * "the tool wrote it". Writing unconditionally would silently discard that
 * edit. So a write may carry the **baseline it expects** and the writer refuses
 * with `FILE_CHANGED` when the file no longer matches it, having written
 * nothing.
 *
 * Design rules:
 *   - **Content identity is the sha256.** `size` and `mtimeMs` are cheap
 *     corroboration (and are what a listing can hand back without hashing 500
 *     files); a caller that supplies several fields has all of them checked.
 *   - **A baseline is not an optimistic lock.** It is verified inside the
 *     existing project write lock (`io.ts`) against the very bytes that are
 *     about to be replaced, so there is no window between "check" and "write"
 *     other than a concurrent process the lock already excludes.
 *   - **Absence is a baseline too.** `{ absent: true }` means "the file must
 *     not exist yet", which is what a project initialisation needs: another
 *     session creating `inkflow.json` first must not be overwritten.
 *   - Zero dependencies: `node:crypto` only.
 */

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** What a file *is*, as far as a writer cares. */
export interface FileFingerprint {
  /** Byte length on disk. */
  size: number
  /** Modification time in milliseconds (the same value `fs.Stats` reports). */
  mtimeMs: number
  /** Lowercase hex sha256 of the file bytes. */
  sha256: string
}

/**
 * The baseline a caller expects. Every field is optional and every field that
 * is present must match; `absent: true` asserts the file does not exist.
 */
export interface FileExpectation {
  size?: number
  mtimeMs?: number
  sha256?: string
  absent?: boolean
}

/** Which expected field no longer matches, in a stable order. */
export type FileChangeField = 'absent' | 'size' | 'mtimeMs' | 'sha256'

export interface FileChange {
  /** Fields that differ between the expectation and the disk. */
  changed: FileChangeField[]
  /** What the caller expected (only the fields it supplied). */
  expected: FileExpectation
  /** What is on disk; `null` when the file is gone. */
  current: FileFingerprint | null
}

/** A fingerprint of bytes already in memory (the writer's own read). */
export function fingerprintBytes(bytes: Uint8Array, mtimeMs: number): FileFingerprint {
  return { size: bytes.length, mtimeMs, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/** Absolute-path fingerprint; `undefined` when the path is absent or unreadable. */
export function fingerprintFile(absolutePath: string): FileFingerprint | undefined {
  let bytes: Buffer
  try {
    bytes = readFileSync(absolutePath)
  } catch {
    return undefined
  }
  let mtimeMs: number
  try {
    // Read first, stat second: the bytes (and therefore the sha256) are the
    // identity, and a stat that lands after the read can only make the pair
    // stricter, never stale.
    mtimeMs = statSync(absolutePath).mtimeMs
  } catch {
    return undefined
  }
  return fingerprintBytes(bytes, mtimeMs)
}

/** Project-relative fingerprint (`chapters/vol-01/0001-a.md`). */
export function fingerprintProjectFile(root: string, relativePath: string): FileFingerprint | undefined {
  return fingerprintFile(join(root, ...relativePath.split('/')))
}

/**
 * Drop `undefined` fields so `{ sha256: undefined }` means "no expectation"
 * rather than "expects an undefined hash".
 */
export function normalizeExpectation(expected: FileExpectation | undefined): FileExpectation | undefined {
  if (expected === undefined) return undefined
  const normalized: FileExpectation = {}
  if (expected.absent === true) normalized.absent = true
  if (typeof expected.sha256 === 'string') normalized.sha256 = expected.sha256.toLowerCase()
  if (typeof expected.size === 'number' && Number.isFinite(expected.size)) normalized.size = expected.size
  if (typeof expected.mtimeMs === 'number' && Number.isFinite(expected.mtimeMs)) normalized.mtimeMs = expected.mtimeMs
  return Object.keys(normalized).length === 0 ? undefined : normalized
}

/**
 * Compare the disk state against an expectation.
 *
 * Returns `undefined` when everything the caller asserted still holds — the
 * common case, and the only one where a write may proceed.
 */
export function compareExpectation(
  current: FileFingerprint | undefined,
  expected: FileExpectation | undefined,
): FileChange | undefined {
  const normalized = normalizeExpectation(expected)
  if (normalized === undefined) return undefined

  const changed: FileChangeField[] = []
  if (normalized.absent === true) {
    if (current !== undefined) changed.push('absent')
  } else {
    if (current === undefined) {
      // The file the caller expected is gone: every supplied field is unmet.
      for (const field of ['sha256', 'size', 'mtimeMs'] as const) {
        if (normalized[field] !== undefined) changed.push(field)
      }
      if (changed.length === 0) changed.push('sha256')
    } else {
      if (normalized.sha256 !== undefined && normalized.sha256 !== current.sha256) changed.push('sha256')
      if (normalized.size !== undefined && normalized.size !== current.size) changed.push('size')
      // mtime is corroboration, not identity: filesystems round it, a copy can
      // preserve content while rewriting the timestamp, and a caller that has
      // both fields only ever means the content. It is compared only when the
      // caller supplied *just* the timestamp.
      if (
        normalized.mtimeMs !== undefined &&
        normalized.sha256 === undefined &&
        normalized.size === undefined &&
        Math.abs(normalized.mtimeMs - current.mtimeMs) > 1
      ) {
        changed.push('mtimeMs')
      }
    }
  }
  if (changed.length === 0) return undefined
  return { changed, expected: normalized, current: current ?? null }
}

/** True when both fingerprints describe the same file, byte for byte. */
export function sameContent(a: FileFingerprint | undefined, b: FileFingerprint | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.sha256 === b.sha256 && a.size === b.size
}
