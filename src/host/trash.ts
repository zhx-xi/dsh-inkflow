/**
 * The recovery bin (#35, roadmap X-9 / X-10, [ADR-0012](../../../.agents/adrs/0012-plugin-private-state-dir.md)).
 *
 * A delete that cannot be undone is the one mistake git cannot help with before
 * the author commits, so every removal this plugin performs first moves the file
 * into `<book>/.inkflow/trash/` **keeping its original relative path** — the
 * location then says where the file came from without reading the manifest.
 * Beside the copy sits one manifest entry (`.inkflow/trash/index.json`) holding
 * the identity (`id`), the origin (`originalPath`), the time (`deletedAt`), the
 * size and hash of the bytes that were removed (`bytes` / `sha256`) and who did
 * it (`reason`).
 *
 * Six properties this module is built around, each checkable:
 *
 *   1. **Nothing but a copy is ever created here.** The bin holds user data, so
 *      it is never auto-pruned (ADR-0012 #4): an entry leaves only through
 *      `restoreTrash` (the file went back) or `purgeTrash` (`confirm: true`).
 *   2. **The copy is verified before the original is touched.** "We have a copy"
 *      is a measurement, not a belief: after writing it the bytes are re-read and
 *      compared, and a mismatch aborts while the original is still in place.
 *   3. **A file the text writer cannot reproduce is never deleted.** Every write
 *      goes through `io.ts` (data-safety §2), which is text-only; a source that is
 *      not valid UTF-8 would come back different, so it is refused with
 *      `TRASH_COPY_MISMATCH` instead of being destroyed.
 *   4. **Restore never overwrites.** A file back at the original path is
 *      `RESTORE_TARGET_EXISTS` and zero writes — the author's newer text wins.
 *   5. **Restore returns the bytes that were deleted**, compared against the
 *      manifest's `sha256`, not "the same-looking text" (BOM and CRLF included:
 *      `writeTextAtomic(..., { verbatim: true })` skips the normaliser).
 *   6. **The manifest is never clobbered.** A manifest this module cannot read is
 *      `TRASH_MANIFEST_INVALID` for every operation: rebuilding it would silently
 *      forget entries the author may still need.
 *
 * Why its own module rather than a few functions in `chapters.ts`: the migration
 * backup (#36) shares the directory but not the format (X-10), and the chapter
 * cascade is already 1300 lines. This file owns the bin's format, its invariants
 * and nothing else. The channel half (route replies) lives in `trash-channel.ts`.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { removeEmptyProjectDirectory, removeProjectFile, writeJsonAtomic, writeTextAtomic } from './io.js'
import type { IoFailure } from './io.js'
import { ensurePrivateStateIgnored, isPrivateStatePath, privateStateDirRelative, privateStateRelative } from './private-state.js'

/** The manifest file, project-relative (forward slashes). */
export const TRASH_MANIFEST_RELATIVE = privateStateRelative('trash', 'index.json')

/** The manifest's own shape version; a different value is refused, never migrated. */
export const TRASH_SCHEMA_VERSION = 1

/** The only reason this build writes, and the one the chapter cascade sends. */
export const TRASH_REASON_CHAPTER_DELETE = 'chapter_delete'

/** One recorded removal. Every field is required: a partial entry cannot be restored. */
export interface TrashEntry {
  /** Stable id the panel and the routes address; a uuid minted at delete time. */
  id: string
  /** Where the file was, project-relative — and where it goes back. */
  originalPath: string
  /** ISO 8601 (UTC), for display and ordering. */
  deletedAt: string
  /** Byte length of the removed content. */
  bytes: number
  /** sha256 of the removed bytes; the restore compares against it. */
  sha256: string
  /** Who moved it (`chapter_delete` today); free text so a future domain need not migrate. */
  reason: string
}

/** An entry as the bin reports it: the manifest row plus what is on disk right now. */
export interface TrashEntryView extends TrashEntry {
  /** Where the copy lives (`.inkflow/trash/<originalPath>`). */
  trashPath: string
  /** `false` when the copy is gone (a hand-cleaned bin): the entry can still be purged. */
  present: boolean
}

export interface TrashError {
  /** A `TrashErrorCode`, or the `IoErrorCode` that actually refused the write. */
  code: string
  message: string
  root?: string
  path?: string
  hint?: string
  /** The underlying `io.ts` failure, when the code above came from there. */
  io?: IoFailure
  /** True when the refusal happened before the first byte was written. */
  nothingWritten?: boolean
  /** True only when an undo of an earlier step succeeded. */
  rolledBack?: boolean
}

export interface TrashFailure {
  ok: false
  error: TrashError
}

export interface TrashFileInput {
  /** Project-relative path of the file to move into the bin. */
  path: string
  /** Defaults to `chapter_delete`. */
  reason?: string
}

export interface TrashFileOk {
  ok: true
  root: string
  entry: TrashEntry
  trashPath: string
  /** Result of the append-only `.gitignore` step (ADR-0012 #2); reported, not thrown. */
  ignored: { ok: boolean; added: boolean; error?: string }
}

export interface TrashListOk {
  ok: true
  root: string
  manifestPath: string
  total: number
  /** Sum of the recorded byte counts, for the panel's "可以清空" hint. */
  bytes: number
  entries: TrashEntryView[]
}

export interface RestoreInput {
  id: string
}

export interface RestoreOk {
  ok: true
  root: string
  restored: TrashEntry
  trashPath: string
  /** `false` only when the copy could not be removed after a successful restore. */
  copyRemoved: boolean
}

export interface PurgeInput {
  id: string
  /** Must be exactly `true`: a purge is the one irreversible action here. */
  confirm?: boolean
}

export interface PurgeOk {
  ok: true
  root: string
  purged: TrashEntry
  trashPath: string
  remaining: number
}

export type TrashFileResult = TrashFileOk | TrashFailure
export type TrashListResult = TrashListOk | TrashFailure
export type RestoreResult = RestoreOk | TrashFailure
export type PurgeResult = PurgeOk | TrashFailure

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function refuse(code: string, message: string, extra: Omit<TrashError, 'code' | 'message'> = {}): TrashFailure {
  return { ok: false, error: { code, message, ...extra } }
}

/** From an `io.ts` refusal, keeping its code so a caller can tell *why* it refused. */
function fromIo(error: IoFailure, message: string, extra: Omit<TrashError, 'code' | 'message' | 'io'> = {}): TrashFailure {
  return { ok: false, error: { code: error.code, message, io: error, ...extra } }
}

/** Absolute path of a project-relative path; forward slashes are the wire form. */
function absolute(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'))
}

/**
 * The project-relative form of a path, or `undefined` when it names something
 * that is not a plain file inside the project (`..`, an absolute path, an empty
 * segment). `io.ts` re-checks this for the copy; the source is read directly, so
 * it is checked here.
 */
function relativeInput(value: string): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const normalised = value.replaceAll('\\', '/').replace(/^\/+/, '')
  const segments = normalised.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined
  if (/^[A-Za-z]:/.test(normalised)) return undefined
  return normalised
}

interface ManifestRead {
  ok: true
  entries: TrashEntry[]
  exists: boolean
}

function readManifest(root: string): ManifestRead | TrashFailure {
  const file = absolute(root, TRASH_MANIFEST_RELATIVE)
  if (!existsSync(file)) return { ok: true, entries: [], exists: false }

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (cause) {
    return refuse('TRASH_MANIFEST_INVALID', `the recovery-bin manifest could not be read: ${String(cause)}`, {
      root,
      path: TRASH_MANIFEST_RELATIVE,
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return refuse('TRASH_MANIFEST_INVALID', `${TRASH_MANIFEST_RELATIVE} is not JSON`, {
      root,
      path: TRASH_MANIFEST_RELATIVE,
      hint: 'the bin is left untouched on purpose: move the broken file aside to start a fresh manifest',
    })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return refuse('TRASH_MANIFEST_INVALID', `${TRASH_MANIFEST_RELATIVE} is not a JSON object`, { root, path: TRASH_MANIFEST_RELATIVE })
  }
  const record = parsed as Record<string, unknown>
  if (record['schemaVersion'] !== TRASH_SCHEMA_VERSION) {
    return refuse('TRASH_MANIFEST_INVALID', `${TRASH_MANIFEST_RELATIVE} has schemaVersion ${String(record['schemaVersion'])}; this build writes ${TRASH_SCHEMA_VERSION}`, {
      root,
      path: TRASH_MANIFEST_RELATIVE,
    })
  }
  const rawEntries = record['entries']
  if (!Array.isArray(rawEntries)) {
    return refuse('TRASH_MANIFEST_INVALID', `${TRASH_MANIFEST_RELATIVE} has no \`entries\` array`, { root, path: TRASH_MANIFEST_RELATIVE })
  }

  const entries: TrashEntry[] = []
  for (const raw of rawEntries) {
    const entry = readEntry(raw)
    if (entry === undefined) {
      return refuse('TRASH_MANIFEST_INVALID', `${TRASH_MANIFEST_RELATIVE} holds an entry that cannot be restored (missing or mistyped field)`, {
        root,
        path: TRASH_MANIFEST_RELATIVE,
      })
    }
    entries.push(entry)
  }
  return { ok: true, entries, exists: true }
}

/** One manifest row, or `undefined` when any field is missing or mistyped. */
function readEntry(raw: unknown): TrashEntry | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const text = (key: string): string | undefined => (typeof record[key] === 'string' && record[key] !== '' ? (record[key] as string) : undefined)
  const id = text('id')
  const originalPath = text('originalPath')
  const deletedAt = text('deletedAt')
  const sha256 = text('sha256')
  const reason = text('reason')
  const bytes = record['bytes']
  if (id === undefined || originalPath === undefined || deletedAt === undefined) return undefined
  if (sha256 === undefined || reason === undefined) return undefined
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return undefined
  // An entry whose path is not a plain project-relative path could not be
  // restored, and would let a hand-edited manifest point anywhere.
  if (relativeInput(originalPath) !== originalPath) return undefined
  return { id, originalPath, deletedAt, bytes, sha256, reason }
}

function writeManifest(root: string, entries: readonly TrashEntry[]): { ok: true } | TrashFailure {
  const written = writeJsonAtomic(root, TRASH_MANIFEST_RELATIVE, { schemaVersion: TRASH_SCHEMA_VERSION, entries })
  if (!written.ok) {
    return fromIo(written.error, `the recovery-bin manifest could not be written: ${written.error.message}`, {
      path: TRASH_MANIFEST_RELATIVE,
    })
  }
  return { ok: true }
}

/**
 * Remove now-empty directories inside the bin, deepest first, stopping at
 * `.inkflow/trash` itself. Best effort on purpose: a leftover empty directory is
 * cosmetic and must not turn a successful restore into an error.
 */
function pruneEmptyBinDirs(root: string, fileRelativePath: string): void {
  let dir = dirname(fileRelativePath).replaceAll('\\', '/')
  const floor = privateStateDirRelative('trash')
  while (dir.startsWith(`${floor}/`)) {
    const removed = removeEmptyProjectDirectory(root, dir)
    if (!removed.ok) return
    const parent = dirname(dir).replaceAll('\\', '/')
    if (parent === dir) return
    dir = parent
  }
}

// ---------------------------------------------------------------------------
// Move one file into the bin
// ---------------------------------------------------------------------------

/**
 * Move `input.path` into the bin: copy, verify, record, remove.
 *
 * Order matters and is the whole safety argument:
 *
 *   1. read the bytes and prove the text writer round-trips them (else refuse,
 *      original untouched);
 *   2. write the copy and re-read it (a rejected copy leaves nothing behind);
 *   3. write the manifest entry — *before* the original is removed, so a crash
 *      leaves "copy + entry + original" (duplicated, recoverable) rather than
 *      "copy + original, no entry" (an orphan nobody can find);
 *   4. remove the original; if that fails, unwind the entry and the copy so the
 *      bin never claims a file that is still in the working tree.
 *
 * `ensurePrivateStateIgnored` runs before the first byte lands: the copy must
 * never appear in `git status`, and the line is appended exactly when the bin
 * starts being used (ADR-0012 #2).
 */
export function trashFile(projectRoot: string, input: TrashFileInput): TrashFileResult {
  const root = resolve(projectRoot)
  const sourcePath = relativeInput(input.path)
  if (sourcePath === undefined) {
    return refuse('PATH_INVALID', `${String(input.path)} is not a project-relative file path`, { root, nothingWritten: true })
  }
  if (isPrivateStatePath(sourcePath)) {
    return refuse('TRASH_SOURCE_NOT_ALLOWED', 'the private state directory is not a delete target', {
      root,
      path: sourcePath,
      nothingWritten: true,
    })
  }

  const sourceFile = absolute(root, sourcePath)
  if (!existsSync(sourceFile)) {
    return refuse('TRASH_SOURCE_NOT_FOUND', `${sourcePath} does not exist`, { root, path: sourcePath, nothingWritten: true })
  }

  let bytes: Buffer
  try {
    bytes = readFileSync(sourceFile)
  } catch (cause) {
    return refuse('TRASH_SOURCE_NOT_FOUND', `${sourcePath} could not be read: ${String(cause)}`, {
      root,
      path: sourcePath,
      nothingWritten: true,
    })
  }
  const sha256 = digest(bytes)
  const text = bytes.toString('utf8')
  // Invariant 3: the copy has to survive the text writer unchanged.
  if (digest(Buffer.from(text, 'utf8')) !== sha256) {
    return refuse('TRASH_COPY_MISMATCH', `${sourcePath} is not valid UTF-8, so a byte-exact copy cannot be made through the text writer`, {
      root,
      path: sourcePath,
      hint: 'the file is left untouched; convert it to UTF-8 in the editor first',
      nothingWritten: true,
    })
  }

  const open = readManifest(root)
  if (!open.ok) return open

  const trashPath = privateStateRelative('trash', sourcePath)
  const ignored = ensurePrivateStateIgnored(root)

  const copied = writeTextAtomic(root, trashPath, text, { verbatim: true })
  if (!copied.ok) {
    return fromIo(copied.error, `the recovery-bin copy could not be written: ${copied.error.message}`, {
      path: trashPath,
      nothingWritten: true,
    })
  }
  // Invariant 2: prove the copy before the original is touched.
  let copyHash: string
  try {
    copyHash = digest(readFileSync(absolute(root, trashPath)))
  } catch (cause) {
    removeProjectFile(root, trashPath)
    return refuse('TRASH_COPY_MISMATCH', `the recovery-bin copy could not be read back: ${String(cause)}`, {
      root,
      path: trashPath,
      nothingWritten: true,
    })
  }
  if (copyHash !== sha256) {
    removeProjectFile(root, trashPath)
    return refuse('TRASH_COPY_MISMATCH', `the recovery-bin copy of ${sourcePath} does not match the original bytes`, {
      root,
      path: sourcePath,
      hint: 'the file is left untouched',
      nothingWritten: true,
    })
  }

  const entry: TrashEntry = {
    id: randomUUID(),
    originalPath: sourcePath,
    deletedAt: new Date().toISOString(),
    bytes: bytes.byteLength,
    sha256,
    reason: input.reason ?? TRASH_REASON_CHAPTER_DELETE,
  }
  const recorded = writeManifest(root, [entry, ...open.entries])
  if (!recorded.ok) {
    removeProjectFile(root, trashPath)
    return recorded
  }

  const removed = removeProjectFile(root, sourcePath)
  if (!removed.ok) {
    const unwound = writeManifest(root, open.entries)
    removeProjectFile(root, trashPath)
    return fromIo(removed.error, `${sourcePath} could not be removed: ${removed.error.message}`, {
      path: sourcePath,
      rolledBack: unwound.ok,
    })
  }

  return { ok: true, root, entry, trashPath, ignored }
}

/**
 * Undo a `trashFile` that a later step rolled back (the chapter cascade's
 * "catalog could not be rebuilt" path). Not exposed on any route or tool: the
 * only caller is the code that just created the entry, and the panel's own
 * removal is `purgeTrash` with an explicit confirmation.
 */
export function undoTrashFile(projectRoot: string, id: string): { ok: boolean; error?: { message: string } } {
  const root = resolve(projectRoot)
  const open = readManifest(root)
  if (!open.ok) return { ok: false, error: { message: open.error.message } }
  const entry = open.entries.find((candidate) => candidate.id === id)
  if (entry === undefined) return { ok: true }
  const trashPath = privateStateRelative('trash', entry.originalPath)
  if (existsSync(absolute(root, trashPath))) {
    const removed = removeProjectFile(root, trashPath)
    if (!removed.ok) return { ok: false, error: { message: removed.error.message } }
  }
  const written = writeManifest(root, open.entries.filter((candidate) => candidate.id !== id))
  if (!written.ok) return { ok: false, error: { message: written.error.message } }
  pruneEmptyBinDirs(root, trashPath)
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Read the bin
// ---------------------------------------------------------------------------

/** Every recorded removal, newest first, each with its on-disk presence checked. */
export function listTrash(projectRoot: string): TrashListResult {
  const root = resolve(projectRoot)
  const open = readManifest(root)
  if (!open.ok) return open
  const entries: TrashEntryView[] = open.entries.map((entry) => {
    const trashPath = privateStateRelative('trash', entry.originalPath)
    return { ...entry, trashPath, present: existsSync(absolute(root, trashPath)) }
  })
  return {
    ok: true,
    root,
    manifestPath: TRASH_MANIFEST_RELATIVE,
    total: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    entries,
  }
}

// ---------------------------------------------------------------------------
// Put one file back
// ---------------------------------------------------------------------------

/**
 * Restore one entry to its original path.
 *
 * Refusals that write nothing: unknown id, missing copy, a copy whose hash no
 * longer matches the manifest (someone edited it in the bin — restoring it would
 * hand back text that was never deleted), and an occupied target. The last one is
 * the important one: the author recreated or renamed a file onto that path, so
 * the newer text wins and the bin keeps its copy.
 */
export function restoreTrash(projectRoot: string, input: RestoreInput): RestoreResult {
  const root = resolve(projectRoot)
  const open = readManifest(root)
  if (!open.ok) return open

  const entry = open.entries.find((candidate) => candidate.id === input.id)
  if (entry === undefined) {
    return refuse('TRASH_ENTRY_NOT_FOUND', `the recovery bin has no entry ${String(input.id)}`, {
      root,
      hint: 'list the bin first; entries leave it when they are restored or purged',
      nothingWritten: true,
    })
  }

  const trashPath = privateStateRelative('trash', entry.originalPath)
  const copyFile = absolute(root, trashPath)
  if (!existsSync(copyFile)) {
    return refuse('TRASH_COPY_MISSING', `the copy of ${entry.originalPath} is gone from the bin`, {
      root,
      path: trashPath,
      hint: 'the entry can still be purged; the bytes are no longer recoverable',
      nothingWritten: true,
    })
  }

  let bytes: Buffer
  try {
    bytes = readFileSync(copyFile)
  } catch (cause) {
    return refuse('TRASH_COPY_MISSING', `the copy of ${entry.originalPath} could not be read: ${String(cause)}`, {
      root,
      path: trashPath,
      nothingWritten: true,
    })
  }
  if (digest(bytes) !== entry.sha256) {
    return refuse('TRASH_COPY_CHANGED', `the copy of ${entry.originalPath} no longer matches the hash recorded when it was deleted`, {
      root,
      path: trashPath,
      hint: 'restoring it would not give back the deleted bytes; purge the entry if the copy is no longer wanted',
      nothingWritten: true,
    })
  }
  if (existsSync(absolute(root, entry.originalPath))) {
    return refuse('RESTORE_TARGET_EXISTS', `${entry.originalPath} exists again, so the bin will not overwrite it`, {
      root,
      path: entry.originalPath,
      hint: 'move or delete the file at that path, then restore again; the bin keeps its copy until then',
      nothingWritten: true,
    })
  }

  // `verbatim`: the normaliser would rewrite CRLF and drop a BOM, and the promise
  // here is the bytes that were deleted, not the same-looking text.
  const written = writeTextAtomic(root, entry.originalPath, bytes.toString('utf8'), { verbatim: true })
  if (!written.ok) {
    return fromIo(written.error, `${entry.originalPath} could not be written back: ${written.error.message}`, {
      path: entry.originalPath,
      nothingWritten: true,
    })
  }

  const restoredHash = digest(readFileSync(absolute(root, entry.originalPath)))
  if (restoredHash !== entry.sha256) {
    removeProjectFile(root, entry.originalPath)
    return refuse('TRASH_RESTORE_MISMATCH', `the restored ${entry.originalPath} does not match the deleted bytes`, {
      root,
      path: entry.originalPath,
      hint: 'the half-written file was removed again; the bin still holds the copy',
      nothingWritten: true,
    })
  }

  const removedCopy = removeProjectFile(root, trashPath)
  const remaining = open.entries.filter((candidate) => candidate.id !== entry.id)
  const stored = writeManifest(root, remaining)
  if (!stored.ok) {
    // The file is back; only the bookkeeping failed. Say so instead of claiming a
    // clean restore — the entry then shows up as `present: false` in the bin.
    return { ok: false, error: { code: stored.error.code, message: `restored ${entry.originalPath}, but ${stored.error.message}`, root, path: TRASH_MANIFEST_RELATIVE, rolledBack: false } }
  }
  if (removedCopy.ok) pruneEmptyBinDirs(root, trashPath)
  return { ok: true, root, restored: entry, trashPath, copyRemoved: removedCopy.ok }
}

// ---------------------------------------------------------------------------
// Delete one copy for good
// ---------------------------------------------------------------------------

/**
 * Forever remove one entry: the copy and the manifest row.
 *
 * `confirm: true` is required — this is the only irreversible action in the bin
 * and the panel asks twice (ADR-0012 #4). A copy that is already gone is not an
 * error: purging is how an orphaned entry is cleared.
 */
export function purgeTrash(projectRoot: string, input: PurgeInput): PurgeResult {
  const root = resolve(projectRoot)
  if (input.confirm !== true) {
    return refuse('CONFIRM_REQUIRED', 'purging removes the copy and its manifest entry for good', {
      root,
      hint: 'pass `confirm: true` (the panel asks for a second click)',
      nothingWritten: true,
    })
  }

  const open = readManifest(root)
  if (!open.ok) return open
  const entry = open.entries.find((candidate) => candidate.id === input.id)
  if (entry === undefined) {
    return refuse('TRASH_ENTRY_NOT_FOUND', `the recovery bin has no entry ${String(input.id)}`, { root, nothingWritten: true })
  }

  const trashPath = privateStateRelative('trash', entry.originalPath)
  if (existsSync(absolute(root, trashPath))) {
    const removed = removeProjectFile(root, trashPath)
    if (!removed.ok) {
      return fromIo(removed.error, `the copy of ${entry.originalPath} could not be removed: ${removed.error.message}`, {
        path: trashPath,
        nothingWritten: true,
      })
    }
  }

  const remaining = open.entries.filter((candidate) => candidate.id !== entry.id)
  const stored = writeManifest(root, remaining)
  if (!stored.ok) return stored
  pruneEmptyBinDirs(root, trashPath)
  return { ok: true, root, purged: entry, trashPath, remaining: remaining.length }
}
