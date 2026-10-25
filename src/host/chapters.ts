/**
 * Volume and chapter CRUD (ADR-0006 D6).
 *
 * The rule the whole module is built around: **the `.md` files are the truth,
 * the catalog is a projection and the SQLite index is a cache.** So every
 * operation below does the same three things in the same order:
 *
 *   1. mutate files through `io.ts` (path parser + project write lock + atomic
 *      replace) while holding **one** project write lock for the whole cascade;
 *   2. rebuild the catalog inside that lock, because the projection has to match
 *      what just happened on disk;
 *   3. rebuild the derived index afterwards. The index is disposable, so a
 *      failed rebuild is reported (`indexError`) but never rolls anything back —
 *      rolling real files back because a cache could not be written would be the
 *      exact opposite of "the database is not the truth".
 *
 * Two identities make the cascade cheap:
 *
 *   - a chapter's `id` is a uuid minted at creation (`randomUUID`) and never
 *     changes; the file name is a *location*, so renaming a chapter or moving it
 *     to another volume keeps every reference (`chapterId`) working;
 *   - a volume's `volumeId` is `vol-NN` and its directory is `vol-NN-<slug>`, so
 *     renaming the volume rewrites the directory and both catalogs but **not one
 *     byte of any chapter frontmatter** (the `volume` value stays the same).
 *
 * Failure handling: a multi-file cascade is not atomic at the filesystem level,
 * so each step that can fail after a mutation has an explicit undo (restore the
 * previous bytes, delete the new copy, rename the directory back). The undo is
 * reported in `error.rollback[]`; if an undo step itself fails the code becomes
 * `ROLLBACK_INCOMPLETE` so the model cannot claim the tree is whole.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { readCatalog, rebuildCatalog } from './catalog.js'
import type { CatalogChapter, CatalogReadResult } from './catalog.js'
import { CATALOG_FILE, CHAPTER_STATUSES, CHAPTERS_DIR, DIR_KEEP_FILE } from './conventions.js'
import {
  compareExpectation,
  fingerprintBytes,
  fingerprintProjectFile,
} from './file-cas.js'
import type { FileChange, FileExpectation, FileFingerprint } from './file-cas.js'
import { frontmatterLine, parseMarkdown, patchFrontmatter, splitFrontmatter, stringField } from './frontmatter.js'
import { buildIndex, describeIndexBuildFailure } from './index-build.js'
import {
  removeEmptyProjectDirectory,
  removeProjectFile,
  renameProjectDirectory,
  withProjectWriteLock,
  writeTextAtomic,
} from './io.js'
import type { IoFailure } from './io.js'
import { trashFile, undoTrashFile } from './trash.js'
import { detectTextStyle } from './text-style.js'
import type { EolStyle, TextStyle } from './text-style.js'

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

/** Business-level failures; filesystem failures keep their `IoErrorCode`. */
export type ChapterErrorCode =
  | 'TITLE_REQUIRED'
  | 'VOLUME_ID_INVALID'
  | 'VOLUME_EXISTS'
  | 'VOLUME_NOT_FOUND'
  | 'SLUG_INVALID'
  | 'SEQ_INVALID'
  | 'SEQ_CONFLICT'
  | 'CHAPTER_EXISTS'
  | 'CHAPTER_NOT_FOUND'
  | 'CHAPTER_AMBIGUOUS'
  | 'CHAPTER_SELECTOR_REQUIRED'
  | 'CHAPTER_SELECTOR_CONFLICT'
  | 'FILE_INVALID'
  | 'STATUS_INVALID'
  | 'FILE_CHANGED'
  | 'CATALOG_REBUILD_FAILED'
  | 'ROLLBACK_INCOMPLETE'

/** One undo attempt, reported whether or not it worked. */
export interface RollbackStep {
  action: string
  ok: boolean
  message?: string
}

export interface ChapterOpError {
  /** A `ChapterErrorCode`, or the `IoErrorCode` that actually refused the write. */
  code: ChapterErrorCode | string
  message: string
  root: string
  path?: string
  hint?: string
  /** True only when every undo step succeeded. */
  rolledBack?: boolean
  rollback?: RollbackStep[]
  /** The underlying write failure, when the code above came from `io.ts`. */
  io?: IoFailure
  /** `FILE_CHANGED` only: the baseline the caller supplied. */
  expected?: FileExpectation
  /** `FILE_CHANGED` only: what is actually on disk now (`null` = the file is gone). */
  current?: FileFingerprint | null
  /** `FILE_CHANGED` only: which fields of the baseline no longer match. */
  changed?: string[]
  /** True when the refusal happened before the first byte was written. */
  nothingWritten?: boolean
}

export interface ChapterOpFailure {
  ok: false
  error: ChapterOpError
}

/** What every successful operation reports about the two projections. */
export interface CommitInfo {
  catalogRebuilt: boolean
  indexRebuilt: boolean
  indexError?: { code: string; message: string }
}

export interface VolumeView {
  volumeId: string
  dir: string
  title: string
  order: number
}

export interface ChapterView {
  chapterId: string
  file: string
  seq?: number
  title: string
  volumeId: string | null
  status: string
}

export interface VolumeCreateInput {
  volumeId?: string
  title: string
  slug?: string
}

export interface VolumeRenameInput {
  volumeId: string
  title?: string
  slug?: string
}

export interface ChapterCreateInput {
  volumeId?: string | null
  title: string
  slug?: string
  seq?: number
  /**
   * Rebuild the derived index after this call (default true).
   *
   * A batch caller (`import-write.ts`) passes `false` and rebuilds once at the end:
   * one index build per chapter is O(n²) work on a 200-chapter import — measured at 64 s
   * for a 60万字 manuscript, against ~2 s with a single build — and the index is a cache,
   * so "rebuilt 200 times" and "rebuilt once" are the same answer to every reader. A
   * single-chapter caller never passes it: freshness is not negotiable there.
   */
  indexCommit?: boolean
}

export interface ChapterWriteInput {
  chapterId?: string
  file?: string
  title?: string
  body?: string
  status?: string
  /**
   * The file's own line ending and BOM, as the read path reported them (ADR-0016).
   *
   * Omitted = "take it from the file": the tool path reads the bytes itself, and a
   * client that never sees raw bytes (the panel) passes back what `GET
   * /chapters/:id` told it. A new file is not written through this input at all,
   * so the default for a fresh chapter stays LF/no-BOM.
   */
  eol?: EolStyle
  bom?: boolean
  /** Baseline the caller last saw: a mismatch is `FILE_CHANGED`, zero writes. */
  expected?: FileExpectation
  /** Rebuild the derived index after this call (default true); see `ChapterCreateInput`. */
  indexCommit?: boolean
}

export interface ChapterMoveInput {
  chapterId?: string
  file?: string
  volumeId?: string | null
  /** Baseline the caller last saw. */
  expected?: FileExpectation
}

export interface ChapterDeleteInput {
  chapterId?: string
  file?: string
  /** Baseline the caller last saw: a delete of an unknown edit is refused. */
  expected?: FileExpectation
}

export interface VolumeCreateOk extends CommitInfo {
  ok: true
  root: string
  volume: VolumeView
}

export interface VolumeRenameOk extends CommitInfo {
  ok: true
  root: string
  volume: VolumeView
  previous: VolumeView
  /** Chapter files carried along by the directory rename (their bytes are untouched). */
  chaptersUnchanged: number
  changed: boolean
}

export interface ChapterCreateOk extends CommitInfo {
  ok: true
  root: string
  chapter: ChapterView
}

export interface ChapterWriteOk extends CommitInfo {
  ok: true
  root: string
  chapter: ChapterView
  changed: string[]
  renamedFrom?: string
  /** The style the file is written in (ADR-0016) — what the next save must keep. */
  style: TextStyle
  /** The file as it is now — the baseline for the next CAS write. */
  fingerprint?: FileFingerprint
}

export interface ChapterMoveOk extends CommitInfo {
  ok: true
  root: string
  chapter: ChapterView
  moved: boolean
  movedFrom: string
  changed: string[]
  /** The file as it is now (at its new path). */
  fingerprint?: FileFingerprint
}

export interface ChapterDeleteOk extends CommitInfo {
  ok: true
  root: string
  deleted: { chapterId: string; file: string; title: string; seq?: number; volumeId: string | null }
  /** The recovery-bin entry this delete created. */
  trashed: { id: string; trashPath: string; bytes: number }
}

/**
 * What the delete cascade reports from inside the project write lock: the
 * chapter it removed and the recovery-bin entry that now holds the text. Split
 * out because the bin's copy is made inside the same lock as the file removal.
 */
interface DeletedChapterReport {
  deleted: ChapterDeleteOk['deleted']
  trashed: ChapterDeleteOk['trashed']
}

export type VolumeCreateResult = VolumeCreateOk | ChapterOpFailure
export type VolumeRenameResult = VolumeRenameOk | ChapterOpFailure
export type ChapterCreateResult = ChapterCreateOk | ChapterOpFailure
export type ChapterWriteResult = ChapterWriteOk | ChapterOpFailure
export type ChapterMoveResult = ChapterMoveOk | ChapterOpFailure
export type ChapterDeleteResult = ChapterDeleteOk | ChapterOpFailure

// ---------------------------------------------------------------------------
// Names: volume ids, slugs, file names
// ---------------------------------------------------------------------------

/**
 * `vol-NN` is the stable id (two digits minimum, ADR-0006 D6). The canonical
 * form is exactly what the catalog derives from a directory name, so `vol-007`
 * and `VOL-07` both collapse to `vol-07` while `vol-7` is refused — a one-digit
 * id can never be a volume directory without tripping `VOLUME_DIR_MISMATCH`.
 */
const VOLUME_ID = /^vol-(\d{2,})$/i

/** Chapter numbers are zero-padded to four digits (`0001-入山.md`). */
const SEQ_DIGITS = 4

/** Long enough for a readable slug, short enough to stay well inside the 240-char write limit. */
const SLUG_MAX = 60

/** Characters that are illegal or silently rewritten on Windows, plus path separators. */
const UNSAFE_SLUG = /[<>:"|?*\\/\u0000-\u001f\u007f]/u

function canonicalVolumeId(raw: string): string | undefined {
  const match = VOLUME_ID.exec(raw.trim())
  const digits = match?.[1]
  if (digits === undefined) return undefined
  const number = Number.parseInt(digits, 10)
  if (!Number.isInteger(number) || number < 1) return undefined
  return `vol-${String(number).padStart(2, '0')}`
}

function volumeNumberOf(volumeId: string): number {
  return Number.parseInt(volumeId.slice('vol-'.length), 10)
}

/**
 * Title → directory/file slug. CJK survives as-is (a Chinese title needs no
 * transliteration and stays readable in `git diff`); whitespace and anything a
 * filesystem would rewrite becomes a single `-`. The catalog title of a volume
 * falls back to this slug when no `outlines/vol-NN*.md` exists, so a title
 * without spaces round-trips exactly.
 */
function slugify(title: string): string {
  const normalized = title.normalize('NFKC').replace(UNSAFE_SLUG, '-').replace(/\s+/gu, '-').replace(/-+/gu, '-')
  const trimmed = normalized.replace(/^[-. ]+/u, '').replace(/[-. ]+$/u, '')
  // Slice by code point: cutting a surrogate pair in half produces a name no
  // filesystem round-trips.
  return [...trimmed].slice(0, SLUG_MAX).join('').replace(/[-. ]+$/u, '')
}

/** Why a caller-supplied slug is unusable, or undefined when it is fine. */
function slugProblem(slug: string): string | undefined {
  if (slug === '') return 'a slug must not be empty'
  if (slug === '.' || slug === '..') return 'a slug must not be "." or ".."'
  if (UNSAFE_SLUG.test(slug)) return `the slug contains a character that is not portable: ${slug}`
  if (/^[. ]/u.test(slug) || /[. ]$/u.test(slug)) {
    return `a slug must not start or end with a dot or a space: ${slug}`
  }
  if ([...slug].length > SLUG_MAX) return `the slug is longer than ${SLUG_MAX} characters`
  return undefined
}

function padSeq(seq: number): string {
  return String(seq).padStart(SEQ_DIGITS, '0')
}

/**
 * Use the caller's slug when one was passed (an explicit `""` or `"  "` is a
 * mistake, not "derive it for me"), otherwise derive one from the title.
 */
function resolveSlug(inputSlug: string | undefined, title: string): { ok: true; value: string } | { ok: false; problem: string } {
  if (inputSlug !== undefined) {
    const slug = inputSlug.trim()
    const problem = slugProblem(slug)
    if (problem !== undefined) return { ok: false, problem }
    return { ok: true, value: slug }
  }
  return { ok: true, value: slugify(title) }
}

function fileNameOf(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1)
}

function directoryOf(file: string): string {
  const at = file.lastIndexOf('/')
  return at === -1 ? '' : file.slice(0, at)
}

/** The numeric prefix of a chapter file name (`0001-入山.md` → `0001`). */
function leadingDigitsOf(file: string): string | undefined {
  return /^(\d+)/.exec(fileNameOf(file))?.[1]
}

/** `chapters/vol-01-入山/0001-入山.md`; a `chapters` directory means a loose chapter. */
function chapterFile(dir: string, prefix: string | undefined, slug: string): string {
  const name = prefix === undefined ? `${slug}.md` : `${prefix}${slug === '' ? '' : `-${slug}`}.md`
  return dir === CHAPTERS_DIR ? `${CHAPTERS_DIR}/${name}` : `${dir}/${name}`
}

// ---------------------------------------------------------------------------
// Failure helpers
// ---------------------------------------------------------------------------

interface FailureExtra {
  root?: string
  path?: string
  hint?: string
  rolledBack?: boolean
  rollback?: RollbackStep[]
  io?: IoFailure
  expected?: FileExpectation
  current?: FileFingerprint | null
  changed?: string[]
  nothingWritten?: boolean
}

function fail(code: ChapterErrorCode | string, message: string, extra: FailureExtra = {}): ChapterOpFailure {
  const error: ChapterOpError = { code, message, root: extra.root ?? '' }
  if (extra.path !== undefined) error.path = extra.path
  if (extra.hint !== undefined) error.hint = extra.hint
  if (extra.rolledBack !== undefined) error.rolledBack = extra.rolledBack
  if (extra.rollback !== undefined) error.rollback = extra.rollback
  if (extra.io !== undefined) error.io = extra.io
  if (extra.expected !== undefined) error.expected = extra.expected
  if (extra.current !== undefined) error.current = extra.current
  if (extra.changed !== undefined) error.changed = extra.changed
  if (extra.nothingWritten !== undefined) error.nothingWritten = extra.nothingWritten
  return { ok: false, error }
}

/** Surface a write-layer failure with its own code (the model can act on it). */
function fromIo(io: IoFailure, extra: { root?: string; message?: string; hint?: string } = {}): ChapterOpFailure {
  return fail(io.code, extra.message ?? io.message, {
    root: extra.root ?? io.root,
    path: io.path,
    hint: extra.hint ?? io.hint,
    io,
  })
}

function rollbackStep(steps: RollbackStep[], action: string, result: { ok: boolean; error?: { message?: string } }): void {
  steps.push(result.ok ? { action, ok: true } : { action, ok: false, message: result.error?.message ?? 'failed' })
}

/** Remove a file only if it is there; a missing one is not a rollback failure. */
function removeIfExists(root: string, relative: string): { ok: boolean; error?: IoFailure } {
  const absolute = join(root, ...relative.split('/'))
  if (!existsSync(absolute)) return { ok: true }
  return removeProjectFile(root, relative)
}

/**
 * The catalog files a rebuild may rewrite: the top-level list plus one list per
 * volume directory. A failed rebuild can have written several of them before the
 * write that failed, so a rollback has to put all of them back — otherwise the
 * tree is not byte-identical to the pre-call state and the read path reports a
 * drift the user never asked for (catalog drift is self-healing, but a failed
 * operation should not create it in the first place).
 */
function catalogPaths(root: string): string[] {
  const paths = [`${CHAPTERS_DIR}/${CATALOG_FILE}`]
  let entries
  try {
    entries = readdirSync(join(root, CHAPTERS_DIR), { withFileTypes: true })
  } catch {
    return paths
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) paths.push(`${CHAPTERS_DIR}/${entry.name}/${CATALOG_FILE}`)
  }
  return paths
}

/** `undefined` = the path was not a readable file before the call. */
type CatalogSnapshot = Map<string, string | undefined>

function takeCatalogSnapshot(root: string): CatalogSnapshot {
  const snapshot: CatalogSnapshot = new Map()
  for (const relative of catalogPaths(root)) {
    try {
      snapshot.set(relative, readFileSync(join(root, ...relative.split('/')), 'utf8'))
    } catch {
      snapshot.set(relative, undefined)
    }
  }
  return snapshot
}

function restoreCatalogSnapshot(root: string, snapshot: CatalogSnapshot): RollbackStep[] {
  const steps: RollbackStep[] = []
  for (const [relative, text] of snapshot) {
    const absolute = join(root, ...relative.split('/'))
    if (text === undefined) {
      // The path was absent, or was already a directory/unreadable file (a broken
      // environment is why the rebuild failed): leave it exactly as it was.
      let isFile = false
      try {
        isFile = existsSync(absolute) && statSync(absolute).isFile()
      } catch {
        isFile = false
      }
      if (isFile) rollbackStep(steps, `remove ${relative}`, removeProjectFile(root, relative))
      continue
    }
    rollbackStep(steps, `restore ${relative}`, writeTextAtomic(root, relative, text, { verbatim: true }))
  }
  return steps
}

/**
 * The catalog could not be written after a mutation: undo it and say so. The
 * distinction between `CATALOG_REBUILD_FAILED` (fully undone) and
 * `ROLLBACK_INCOMPLETE` (some undo failed) is what lets the model tell the user
 * whether the tree is whole.
 */
function afterCatalogFailure(root: string, cause: IoFailure, steps: RollbackStep[]): ChapterOpFailure {
  const complete = steps.every((step) => step.ok)
  const attempted = steps.map((step) => step.action).join('; ')
  if (!complete) {
    return fail(
      'ROLLBACK_INCOMPLETE',
      `the catalog could not be rebuilt (${cause.code}) and the rollback did not complete; inspect: ${attempted}`,
      { root, path: cause.path, rolledBack: false, rollback: steps, io: cause },
    )
  }
  return fail(
    'CATALOG_REBUILD_FAILED',
    `the catalog could not be rebuilt (${cause.code}: ${cause.message}); the change was rolled back`,
    { root, path: cause.path, rolledBack: true, rollback: steps, io: cause },
  )
}

/**
 * Body of a write-locked section: the value, or the structured failure that
 * stopped it. Returning failures as values (instead of throwing) keeps every
 * refusal a single shape the tool layer can render, and it lets the validation
 * run **inside** the lock — a projection read before the lock could allocate a
 * `seq` or a file name that another session commits first.
 */
type Locked<T> = { ok: true; value: T } | ChapterOpFailure

/** Rebuild the derived index; a cache failure is reported, never rolled back. */
async function commitIndex(root: string): Promise<Pick<CommitInfo, 'indexRebuilt' | 'indexError'>> {
  try {
    await buildIndex(root)
    return { indexRebuilt: true }
  } catch (cause) {
    const failure = describeIndexBuildFailure(cause)
    return { indexRebuilt: false, indexError: { code: failure.code, message: failure.message } }
  }
}

const UNTOUCHED_INDEX = { indexRebuilt: false } as const

// ---------------------------------------------------------------------------
// Reading the projection
// ---------------------------------------------------------------------------

interface ChapterRef {
  chapterId: string
  file: string
  seq?: number
  title: string
  volumeId: string | null
}

function toRef(chapter: CatalogChapter, volumeId: string | null): ChapterRef {
  return {
    chapterId: chapter.chapterId,
    file: chapter.file,
    ...(chapter.seq === undefined ? {} : { seq: chapter.seq }),
    title: chapter.title,
    volumeId,
  }
}

function allChapters(catalog: CatalogReadResult): ChapterRef[] {
  const owned = catalog.volumeCatalogs.flatMap((volume) =>
    volume.chapters.map((chapter) => toRef(chapter, volume.volumeId)),
  )
  return [...owned, ...catalog.catalog.looseChapters.map((chapter) => toRef(chapter, null))]
}

function chaptersOf(catalog: CatalogReadResult, volumeId: string | null): CatalogChapter[] {
  if (volumeId === null) return catalog.catalog.looseChapters
  return catalog.volumeCatalogs.find((volume) => volume.volumeId === volumeId)?.chapters ?? []
}

function maxSeq(chapters: readonly CatalogChapter[]): number {
  return chapters.reduce((highest, chapter) => (chapter.seq === undefined ? highest : Math.max(highest, chapter.seq)), 0)
}

/**
 * Normalise a caller-supplied chapter path. A path that could address anything
 * outside `chapters/**\/*.md` is refused before it reaches the filesystem; the
 * catalog lookup then decides whether the file is a chapter at all.
 */
function normalizeChapterFile(raw: string): string | undefined {
  const normalized = raw.trim().replaceAll('\\', '/').replace(/^\.\//u, '')
  if (!normalized.toLowerCase().startsWith(`${CHAPTERS_DIR}/`)) return undefined
  if (!normalized.toLowerCase().endsWith('.md')) return undefined
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined
  return normalized
}

/**
 * Resolve `chapterId` **or** `file` to exactly one chapter.
 *
 * An id is never a directory name: the lookup compares against the catalog's
 * `chapterId` values (the frontmatter `id`, else the path), so passing
 * `vol-01-入山` cannot silently address "the first chapter in that folder".
 */
function resolveChapter(
  root: string,
  input: { chapterId?: string; file?: string },
): { ok: true; value: ChapterRef; catalog: CatalogReadResult } | ChapterOpFailure {
  const hasId = typeof input.chapterId === 'string' && input.chapterId.trim() !== ''
  const hasFile = typeof input.file === 'string' && input.file.trim() !== ''
  if (hasId && hasFile) {
    return fail('CHAPTER_SELECTOR_CONFLICT', 'pass either chapterId or file, not both', { root })
  }
  if (!hasId && !hasFile) {
    return fail('CHAPTER_SELECTOR_REQUIRED', 'a chapterId or a file is required to address a chapter', {
      root,
      hint: 'use the chapter id from inkflow_chapter_list / the catalog; a file is a project-relative chapters/…md path',
    })
  }

  const catalog = readCatalog(root)
  const all = allChapters(catalog)

  if (hasFile) {
    const normalized = normalizeChapterFile(input.file as string)
    if (normalized === undefined) {
      return fail('FILE_INVALID', `${String(input.file)} is not a project-relative chapters/**/*.md path`, {
        root,
        path: String(input.file),
      })
    }
    const match = all.find((chapter) => chapter.file === normalized)
    if (match === undefined) {
      return fail('CHAPTER_NOT_FOUND', `no chapter file "${normalized}"`, { root, path: normalized })
    }
    return { ok: true, value: match, catalog }
  }

  const id = (input.chapterId as string).trim()
  const matches = all.filter((chapter) => chapter.chapterId === id)
  const match = matches[0]
  if (match === undefined) {
    return fail('CHAPTER_NOT_FOUND', `no chapter with id "${id}"`, {
      root,
      hint: 'ids are the uuid values from inkflow_chapter_list / the catalog; a volume directory name is not an id',
    })
  }
  if (matches.length > 1) {
    return fail('CHAPTER_AMBIGUOUS', `id "${id}" is used by ${matches.length} chapters`, {
      root,
      path: match.file,
      hint: `pass file: ${matches.map((chapter) => chapter.file).join(' | ')}`,
    })
  }
  return { ok: true, value: match, catalog }
}

function readChapterText(root: string, file: string): string | undefined {
  try {
    return readFileSync(join(root, ...file.split('/')), 'utf8')
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Write-time compare-and-swap
// ---------------------------------------------------------------------------

/** One chapter read plus the fingerprint of the very bytes that were parsed. */
interface ChapterRead {
  text: string
  fingerprint: FileFingerprint
}

/**
 * Read a chapter **and** fingerprint it in one go.
 *
 * The sha256 is taken from the buffer that is decoded into `text`, not from a
 * second read: a baseline that describes different bytes than the ones being
 * patched is worse than no baseline at all.
 */
function readChapterWithFingerprint(root: string, file: string): ChapterRead | undefined {
  const absolute = join(root, ...file.split('/'))
  let bytes: Buffer
  try {
    bytes = readFileSync(absolute)
  } catch {
    return undefined
  }
  let mtimeMs: number
  try {
    mtimeMs = statSync(absolute).mtimeMs
  } catch {
    return undefined
  }
  return { text: bytes.toString('utf8'), fingerprint: fingerprintBytes(bytes, mtimeMs) }
}

/** The one refusal shape for "the file is not what you thought it was". */
function fileChangedFailure(root: string, path: string, drift: FileChange, why: string): ChapterOpFailure {
  return fail('FILE_CHANGED', `${path} ${why} (${drift.changed.join(', ')}); nothing was written`, {
    root,
    path,
    expected: drift.expected,
    current: drift.current,
    changed: drift.changed,
    nothingWritten: true,
    hint: 're-read the chapter, then retry with its current size / mtimeMs / sha256 as `expected`',
  })
}

/** 1) The caller's baseline, checked against the file this call is about to edit. */
function callerBaselineRefusal(
  root: string,
  path: string,
  current: FileFingerprint,
  expected: FileExpectation | undefined,
): ChapterOpFailure | undefined {
  const drift = compareExpectation(current, expected)
  return drift === undefined ? undefined : fileChangedFailure(root, path, drift, 'changed on disk since the baseline you passed')
}

/**
 * 2) The baseline this call itself took, re-checked immediately before the
 * write. The project write lock already excludes another *session* of this
 * plugin; this catches the human's editor, which takes no lock.
 */
function driftedSinceRead(root: string, path: string, baseline: FileFingerprint): ChapterOpFailure | undefined {
  const drift = compareExpectation(fingerprintProjectFile(root, path), baseline)
  return drift === undefined ? undefined : fileChangedFailure(root, path, drift, 'changed on disk while this call was working on it')
}

function viewOf(chapterId: string, file: string, data: Record<string, unknown>, fallback: ChapterRef): ChapterView {
  const raw = data['seq']
  const seq =
    typeof raw === 'number' && Number.isInteger(raw)
      ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : fallback.seq
  const status = stringField(data, 'status')
  return {
    chapterId,
    file,
    ...(seq === undefined ? {} : { seq }),
    title: stringField(data, 'title') ?? fallback.title,
    volumeId: fallback.volumeId,
    status: status === undefined ? 'draft' : status,
  }
}

// ---------------------------------------------------------------------------
// Frontmatter edits on an existing chapter
// ---------------------------------------------------------------------------

interface FieldApply {
  text: string
  replaced: string[]
  appended: string[]
  removed: string[]
}

/**
 * Apply field edits to a document, preserving everything that is not edited.
 *
 * Two halves are handled differently on purpose: the frontmatter block is
 * patched line by line (comments, unknown keys, quote style and line endings
 * survive), the body is never touched here. A document with no block gets one
 * created — otherwise a write on a legacy file would silently do nothing.
 */
function applyFields(text: string, entries: Record<string, string>, remove: readonly string[] = []): FieldApply {
  const keys = Object.keys(entries)
  const parts = splitFrontmatter(text)
  if (!parts.hasFrontmatter) {
    if (keys.length === 0) return { text, replaced: [], appended: [], removed: [] }
    // `['---', …, '---', '', '']` joins to `---\n…\n---\n\n`: the blank line keeps
    // the block separate from the prose (the same shape a new chapter gets).
    const block = ['---', ...keys.map((key) => frontmatterLine(key, entries[key] ?? '')), '---', '', ''].join('\n')
    return { text: `${block}${text}`, replaced: [], appended: keys, removed: [] }
  }
  const patched = patchFrontmatter(parts.head, entries, { remove })
  return {
    text: patched.text + parts.body,
    replaced: patched.replaced,
    appended: patched.appended,
    removed: patched.removed,
  }
}

function withBody(text: string, body: string): string {
  const parts = splitFrontmatter(text)
  return `${parts.head}${body}`
}

// ---------------------------------------------------------------------------
// inkflow_volume_create
// ---------------------------------------------------------------------------

export async function createVolume(projectRoot: string, input: VolumeCreateInput): Promise<VolumeCreateResult> {
  const root = resolve(projectRoot)

  // Everything from the projection read to the catalog rebuild happens under the
  // one project write lock: a `volumeId` chosen from a pre-lock projection could
  // be taken by another session before this one writes.
  const locked = withProjectWriteLock(root, (lock): Locked<VolumeView> => {
    const root = lock.root
    const title = (input.title ?? '').trim()
    if (title === '') return fail('TITLE_REQUIRED', 'a volume title is required', { root })

    const catalog = readCatalog(root)
    let volumeId: string
    const requested = (input.volumeId ?? '').trim()
    if (requested === '') {
      const highest = catalog.catalog.volumes.reduce((max, volume) => Math.max(max, volume.order), 0)
      volumeId = `vol-${String(highest + 1).padStart(2, '0')}`
    } else {
      const canonical = canonicalVolumeId(requested)
      if (canonical === undefined) {
        return fail('VOLUME_ID_INVALID', `"${requested}" is not a volume id; expected vol-NN (two or more digits)`, {
          root,
        })
      }
      volumeId = canonical
    }
    if (catalog.catalog.volumes.some((volume) => volume.volumeId === volumeId)) {
      return fail('VOLUME_EXISTS', `volume ${volumeId} already exists`, { root })
    }

    const resolvedSlug = resolveSlug(input.slug, title)
    if (!resolvedSlug.ok) return fail('SLUG_INVALID', resolvedSlug.problem, { root })
    const slug = resolvedSlug.value
    const dir = slug === '' ? volumeId : `${volumeId}-${slug}`
    if (existsSync(join(root, CHAPTERS_DIR, dir))) {
      return fail('VOLUME_EXISTS', `the volume directory ${CHAPTERS_DIR}/${dir} already exists`, {
        root,
        path: `${CHAPTERS_DIR}/${dir}`,
      })
    }

    const keep = `${CHAPTERS_DIR}/${dir}/${DIR_KEEP_FILE}`
    const catalogs = takeCatalogSnapshot(root)
    const written = writeTextAtomic(root, keep, '')
    if (!written.ok) {
      return fromIo(written.error, { message: `the volume directory could not be created: ${written.error.message}` })
    }

    const rebuilt = rebuildCatalog(root)
    if (!rebuilt.ok) {
      const steps: RollbackStep[] = []
      rollbackStep(steps, `remove ${keep}`, removeProjectFile(root, keep))
      // The failed rebuild may already have written this volume's own list.
      rollbackStep(steps, `remove ${CHAPTERS_DIR}/${dir}/${CATALOG_FILE}`, removeIfExists(root, `${CHAPTERS_DIR}/${dir}/${CATALOG_FILE}`))
      rollbackStep(steps, `remove ${CHAPTERS_DIR}/${dir}`, removeEmptyProjectDirectory(root, `${CHAPTERS_DIR}/${dir}`))
      steps.push(...restoreCatalogSnapshot(root, catalogs))
      return afterCatalogFailure(root, rebuilt.error, steps)
    }
    const volume = rebuilt.volumes.find((item) => item.volumeId === volumeId)
    return {
      ok: true,
      value: volume ?? { volumeId, dir, title: slug === '' ? volumeId : slug, order: volumeNumberOf(volumeId) },
    }
  })
  if (!locked.ok) return fromIo(locked.error)
  if (!locked.value.ok) return locked.value
  return { ok: true, root, volume: locked.value.value, catalogRebuilt: true, ...(await commitIndex(root)) }
}

// ---------------------------------------------------------------------------
// inkflow_volume_rename
// ---------------------------------------------------------------------------

export async function renameVolume(projectRoot: string, input: VolumeRenameInput): Promise<VolumeRenameResult> {
  const root = resolve(projectRoot)

  // Lock before reading: the directory a rename must move is exactly what the
  // projection says, so the projection has to be read under the same lock.
  const locked = withProjectWriteLock(root, (lock): Locked<VolumeRenameOk> => {
    const root = lock.root
    const requested = (input.volumeId ?? '').trim()
    if (requested === '') return fail('VOLUME_ID_INVALID', 'a volumeId is required', { root })
    const volumeId = canonicalVolumeId(requested)
    if (volumeId === undefined) {
      return fail('VOLUME_ID_INVALID', `"${requested}" is not a volume id; expected vol-NN (two or more digits)`, { root })
    }

    const catalog = readCatalog(root)
    const volume = catalog.catalog.volumes.find((item) => item.volumeId === volumeId)
    if (volume === undefined) return fail('VOLUME_NOT_FOUND', `no volume ${volumeId}`, { root })

    const title = (input.title ?? '').trim()
    if (title === '' && input.slug === undefined) {
      return fail('TITLE_REQUIRED', 'a rename needs a title or a slug', { root })
    }
    const resolvedSlug = resolveSlug(input.slug, title)
    if (!resolvedSlug.ok) return fail('SLUG_INVALID', resolvedSlug.problem, { root })
    const slug = resolvedSlug.value
    if (slug === '') {
      return fail('SLUG_INVALID', 'the title yields an empty directory name; pass an explicit slug', { root })
    }

    const from = `${CHAPTERS_DIR}/${volume.dir}`
    const dir = `${volumeId}-${slug}`
    const to = `${CHAPTERS_DIR}/${dir}`
    const chapters = chaptersOf(catalog, volumeId)
    if (to === from) {
      return {
        ok: true,
        value: {
          ok: true,
          root,
          volume,
          previous: volume,
          chaptersUnchanged: chapters.length,
          changed: false,
          catalogRebuilt: false,
          ...UNTOUCHED_INDEX,
        },
      }
    }
    if (existsSync(join(root, CHAPTERS_DIR, dir))) {
      return fail('VOLUME_EXISTS', `the volume directory ${to} already exists`, { root, path: to })
    }

    const catalogs = takeCatalogSnapshot(root)
    const renamed = renameProjectDirectory(root, from, to)
    if (!renamed.ok) {
      return fromIo(renamed.error, { message: `the volume directory could not be renamed: ${renamed.error.message}` })
    }

    const rebuilt = rebuildCatalog(root)
    if (!rebuilt.ok) {
      const steps: RollbackStep[] = []
      rollbackStep(steps, `rename ${to} back to ${from}`, renameProjectDirectory(root, to, from))
      // The volume list travelled with the directory; its old path is the one to
      // restore, so this runs after the directory is back in place.
      steps.push(...restoreCatalogSnapshot(root, catalogs))
      return afterCatalogFailure(root, rebuilt.error, steps)
    }
    const next = rebuilt.volumes.find((item) => item.volumeId === volumeId)
    return {
      ok: true,
      value: {
        ok: true,
        root,
        volume: next ?? { volumeId, dir, title: slug, order: volume.order },
        previous: volume,
        chaptersUnchanged: chapters.length,
        changed: true,
        catalogRebuilt: true,
        ...UNTOUCHED_INDEX,
      },
    }
  })
  if (!locked.ok) return fromIo(locked.error)
  if (!locked.value.ok) return locked.value
  const result = locked.value.value
  return result.changed ? { ...result, ...(await commitIndex(result.root)) } : result
}

// ---------------------------------------------------------------------------
// inkflow_chapter_create
// ---------------------------------------------------------------------------

export async function createChapter(projectRoot: string, input: ChapterCreateInput): Promise<ChapterCreateResult> {
  const root = resolve(projectRoot)

  // The `seq` and the file name are allocated from the projection, so the read
  // and the write must sit under one lock: two sessions creating at the same
  // moment would otherwise both allocate the same number.
  const locked = withProjectWriteLock(root, (lock): Locked<ChapterView> => {
    const root = lock.root
    const title = (input.title ?? '').trim()
    if (title === '') return fail('TITLE_REQUIRED', 'a chapter title is required', { root })

    const catalog = readCatalog(root)
    let volumeId: string | null = null
    let dir = CHAPTERS_DIR
    const requestedVolume = (input.volumeId ?? '').trim()
    if (requestedVolume !== '') {
      const canonical = canonicalVolumeId(requestedVolume)
      if (canonical === undefined) {
        return fail('VOLUME_ID_INVALID', `"${requestedVolume}" is not a volume id; expected vol-NN (two or more digits)`, {
          root,
        })
      }
      const volume = catalog.catalog.volumes.find((item) => item.volumeId === canonical)
      if (volume === undefined) {
        return fail('VOLUME_NOT_FOUND', `no volume ${canonical}; create it with inkflow_volume_create first`, { root })
      }
      volumeId = volume.volumeId
      dir = `${CHAPTERS_DIR}/${volume.dir}`
    }

    const siblings = chaptersOf(catalog, volumeId)
    let seq: number
    if (input.seq !== undefined) {
      if (!Number.isInteger(input.seq) || input.seq < 1) {
        return fail('SEQ_INVALID', `seq must be a positive integer (got ${String(input.seq)})`, { root })
      }
      seq = input.seq
    } else {
      seq = maxSeq(siblings) + 1
    }
    const clash = siblings.find((chapter) => chapter.seq === seq)
    if (clash !== undefined) {
      return fail('SEQ_CONFLICT', `seq ${seq} is already used by ${clash.file}`, { root, path: clash.file })
    }

    const resolvedSlug = resolveSlug(input.slug, title)
    if (!resolvedSlug.ok) return fail('SLUG_INVALID', resolvedSlug.problem, { root })
    const slug = resolvedSlug.value

    const file = chapterFile(dir, padSeq(seq), slug)
    if (existsSync(join(root, ...file.split('/')))) {
      return fail('CHAPTER_EXISTS', `the chapter file ${file} already exists`, { root, path: file })
    }

    const chapterId = randomUUID()
    const lines = ['---', frontmatterLine('id', chapterId), frontmatterLine('title', title)]
    if (volumeId !== null) lines.push(frontmatterLine('volume', volumeId))
    lines.push(frontmatterLine('seq', String(seq)), frontmatterLine('status', 'draft'), '---', '', '')
    const text = lines.join('\n')

    const catalogs = takeCatalogSnapshot(root)
    const written = writeTextAtomic(root, file, text)
    if (!written.ok) {
      return fromIo(written.error, { message: `the chapter file could not be written: ${written.error.message}` })
    }

    const rebuilt = rebuildCatalog(root)
    if (!rebuilt.ok) {
      const steps: RollbackStep[] = []
      rollbackStep(steps, `remove ${file}`, removeProjectFile(root, file))
      steps.push(...restoreCatalogSnapshot(root, catalogs))
      return afterCatalogFailure(root, rebuilt.error, steps)
    }
    return { ok: true, value: { chapterId, file, seq, title, volumeId, status: 'draft' } }
  })
  if (!locked.ok) return fromIo(locked.error)
  if (!locked.value.ok) return locked.value

  return {
    ok: true,
    root,
    chapter: locked.value.value,
    catalogRebuilt: true,
    ...(input.indexCommit === false ? UNTOUCHED_INDEX : await commitIndex(root)),
  }
}

// ---------------------------------------------------------------------------
// inkflow_chapter_write
// ---------------------------------------------------------------------------

export async function writeChapter(projectRoot: string, input: ChapterWriteInput): Promise<ChapterWriteResult> {
  const root = resolve(projectRoot)

  // The catalog reference and the file bytes are read under the same lock as the
  // write: otherwise a concurrent rename/move would leave this call patching a
  // path that no longer exists (or a different chapter that took its name).
  const locked = withProjectWriteLock(root, (lock): Locked<ChapterWriteOk> => {
    const root = lock.root
    const resolved = resolveChapter(root, input)
    if (!resolved.ok) return resolved
    const ref = resolved.value
    const read = readChapterWithFingerprint(root, ref.file)
    if (read === undefined) return fail('CHAPTER_NOT_FOUND', `${ref.file} could not be read`, { root, path: ref.file })
    const text = read.text
    const baseline = read.fingerprint
    // Both baselines are checked, and both are checked *before* any
    // byte is written, so a refusal leaves the tree byte-identical.
    const callerRefusal = callerBaselineRefusal(root, ref.file, baseline, input.expected)
    if (callerRefusal !== undefined) return callerRefusal

    const data = parseMarkdown(text).data
    const currentTitle = stringField(data, 'title') ?? ref.title
    // The file's own format, detected from the bytes just read. A caller that
    // cannot see raw bytes (the panel) declares it instead; the declaration wins
    // because it describes exactly the bytes its CAS baseline was taken from, and
    // the tool path simply has none (ADR-0016).
    const fileStyle = detectTextStyle(text)
    const style: TextStyle = { eol: input.eol ?? fileStyle.eol, bom: input.bom ?? fileStyle.bom }
    const entries: Record<string, string> = {}
    const changed: string[] = []

    if (input.title !== undefined) {
      const title = input.title.trim()
      if (title === '') return fail('TITLE_REQUIRED', 'a chapter title must not be empty', { root, path: ref.file })
      if (title !== currentTitle) {
        entries['title'] = title
        changed.push('title')
      }
    }
    if (input.status !== undefined) {
      if (!(CHAPTER_STATUSES as readonly string[]).includes(input.status)) {
        return fail('STATUS_INVALID', `status must be one of ${CHAPTER_STATUSES.join(', ')} (got "${input.status}")`, {
          root,
          path: ref.file,
        })
      }
      if (input.status !== stringField(data, 'status')) {
        entries['status'] = input.status
        changed.push('status')
      }
    }
    const body = input.body
    if (body !== undefined) changed.push('body')

    if (changed.length === 0) {
      return {
        ok: true,
        value: {
          ok: true,
          root,
          chapter: viewOf(ref.chapterId, ref.file, data, ref),
          changed: [],
          style,
          catalogRebuilt: false,
          ...UNTOUCHED_INDEX,
        },
      }
    }

    const edits = applyFields(text, entries)
    let next = edits.text
    if (body !== undefined) next = withBody(next, body)

    // A title change renames the file ("改标题 = 文件名 + frontmatter +
    // catalog 一起改"). The numeric prefix stays, so `0001-旧名.md` becomes
    // `0001-新名.md` and the reading order never depends on a rename.
    let target = ref.file
    const nextTitle = entries['title']
    if (nextTitle !== undefined) {
      const prefix = leadingDigitsOf(ref.file) ?? (ref.seq === undefined ? undefined : padSeq(ref.seq))
      const slug = slugify(nextTitle)
      if (prefix === undefined && slug === '') {
        return fail('SLUG_INVALID', 'the title yields an empty file name; pass a title with letters or digits', {
          root,
          path: ref.file,
        })
      }
      const candidate = chapterFile(directoryOf(ref.file), prefix, slug)
      if (candidate !== ref.file) {
        if (existsSync(join(root, ...candidate.split('/')))) {
          return fail('CHAPTER_EXISTS', `the target file ${candidate} already exists`, { root, path: candidate })
        }
        target = candidate
      }
    }

    const catalogs = takeCatalogSnapshot(root)
    const drifted = driftedSinceRead(root, ref.file, baseline)
    if (drifted !== undefined) return drifted
    // `next` mixes both halves on purpose (`applyFields` keeps the raw
    // frontmatter, `withBody` takes the caller's LF prose); the write door
    // normalises and then re-serialises the whole document in `style`, so the
    // file keeps its own format and one edited character stays one changed line.
    const written = writeTextAtomic(root, target, next, { style })
    if (!written.ok) {
      return fromIo(written.error, { message: `the chapter file could not be written: ${written.error.message}` })
    }

    if (target !== ref.file) {
      const removed = removeProjectFile(root, ref.file)
      if (!removed.ok) {
        const steps: RollbackStep[] = []
        rollbackStep(steps, `remove ${target}`, removeProjectFile(root, target))
        steps.push(...restoreCatalogSnapshot(root, catalogs))
        return fromIo(removed.error, { message: `the old chapter file could not be removed: ${removed.error.message}` })
      }
    }

    const rebuilt = rebuildCatalog(root)
    if (!rebuilt.ok) {
      const steps: RollbackStep[] = []
      rollbackStep(steps, `restore ${ref.file}`, writeTextAtomic(root, ref.file, text, { verbatim: true }))
      if (target !== ref.file) rollbackStep(steps, `remove ${target}`, removeProjectFile(root, target))
      steps.push(...restoreCatalogSnapshot(root, catalogs))
      return afterCatalogFailure(root, rebuilt.error, steps)
    }

    const fingerprint = fingerprintProjectFile(root, target)
    const finalData = parseMarkdown(readChapterText(root, target) ?? next).data
    return {
      ok: true,
      value: {
        ok: true,
        root,
        chapter: viewOf(ref.chapterId, target, finalData, ref),
        changed,
        ...(target === ref.file ? {} : { renamedFrom: ref.file }),
        style,
        catalogRebuilt: true,
        ...(fingerprint === undefined ? {} : { fingerprint }),
        ...UNTOUCHED_INDEX,
      },
    }
  })
  if (!locked.ok) return fromIo(locked.error)
  if (!locked.value.ok) return locked.value
  const result = locked.value.value
  // A batch caller suppresses this and rebuilds once at the end (see the input type).
  return result.catalogRebuilt && input.indexCommit !== false ? { ...result, ...(await commitIndex(root)) } : result
}

// ---------------------------------------------------------------------------
// inkflow_chapter_move
// ---------------------------------------------------------------------------

export async function moveChapter(projectRoot: string, input: ChapterMoveInput): Promise<ChapterMoveResult> {
  const root = resolve(projectRoot)

  // Same reason as the write path: the reference, the target volume and the seq
  // collision check all have to describe the state this call actually mutates.
  const locked = withProjectWriteLock(root, (lock): Locked<ChapterMoveOk> => {
    const root = lock.root
    const resolved = resolveChapter(root, input)
    if (!resolved.ok) return resolved
    const ref = resolved.value

    let targetVolumeId: string | null = null
    let targetDir = CHAPTERS_DIR
    const requested = (input.volumeId ?? '').trim()
    if (requested !== '') {
      const canonical = canonicalVolumeId(requested)
      if (canonical === undefined) {
        return fail('VOLUME_ID_INVALID', `"${requested}" is not a volume id; expected vol-NN (two or more digits)`, {
          root,
        })
      }
      const volume = resolved.catalog.catalog.volumes.find((item) => item.volumeId === canonical)
      if (volume === undefined) return fail('VOLUME_NOT_FOUND', `no volume ${canonical}`, { root })
      targetVolumeId = volume.volumeId
      targetDir = `${CHAPTERS_DIR}/${volume.dir}`
    }

    const read = readChapterWithFingerprint(root, ref.file)
    if (read === undefined) return fail('CHAPTER_NOT_FOUND', `${ref.file} could not be read`, { root, path: ref.file })
    const text = read.text
    const baseline = read.fingerprint
    const callerRefusal = callerBaselineRefusal(root, ref.file, baseline, input.expected)
    if (callerRefusal !== undefined) return callerRefusal
    const data = parseMarkdown(text).data

    // A move relocates the file; the name (prefix + slug) travels unchanged.
    const targetFile = `${targetDir}/${fileNameOf(ref.file)}`
    if (targetVolumeId === ref.volumeId && targetFile === ref.file) {
      return {
        ok: true,
        value: {
          ok: true,
          root,
          chapter: viewOf(ref.chapterId, ref.file, data, ref),
          moved: false,
          movedFrom: ref.file,
          changed: [],
          catalogRebuilt: false,
          ...UNTOUCHED_INDEX,
        },
      }
    }

    // A seq may only exist once per volume: the catalog's own uniqueness rule
    // (`CATALOG_DUPLICATE`) is refused here instead of written and reported later.
    if (ref.seq !== undefined) {
      const clash = chaptersOf(resolved.catalog, targetVolumeId).find(
        (chapter) => chapter.seq === ref.seq && chapter.file !== ref.file,
      )
      if (clash !== undefined) {
        const where = targetVolumeId === null ? 'the loose chapters' : targetVolumeId
        return fail('SEQ_CONFLICT', `seq ${ref.seq} is already used by ${clash.file} in ${where}`, {
          root,
          path: clash.file,
          hint: 'pick another volume, or renumber the chapter first (seq is not editable yet)',
        })
      }
    }
    if (targetFile !== ref.file && existsSync(join(root, ...targetFile.split('/')))) {
      return fail('CHAPTER_EXISTS', `the target file ${targetFile} already exists`, { root, path: targetFile })
    }

    // Leaving a volume must *remove* `volume`: an empty value reads back as an
    // empty block list, and the old value would keep the old owner.
    const next =
      targetVolumeId === null
        ? applyFields(text, {}, ['volume']).text
        : applyFields(text, { volume: targetVolumeId }).text
    const changed: string[] = []
    if (stringField(data, 'volume') !== (targetVolumeId ?? undefined)) changed.push('volume')
    if (targetFile !== ref.file) changed.push('file')

    const catalogs = takeCatalogSnapshot(root)
    const drifted = driftedSinceRead(root, ref.file, baseline)
    if (drifted !== undefined) return drifted
    const written = writeTextAtomic(root, targetFile, next)
    if (!written.ok) {
      return fromIo(written.error, { message: `the chapter could not be moved: ${written.error.message}` })
    }

    if (targetFile !== ref.file) {
      const removed = removeProjectFile(root, ref.file)
      if (!removed.ok) {
        const steps: RollbackStep[] = []
        rollbackStep(steps, `remove ${targetFile}`, removeProjectFile(root, targetFile))
        steps.push(...restoreCatalogSnapshot(root, catalogs))
        return fromIo(removed.error, { message: `the old chapter file could not be removed: ${removed.error.message}` })
      }
    }

    const rebuilt = rebuildCatalog(root)
    if (!rebuilt.ok) {
      const steps: RollbackStep[] = []
      rollbackStep(steps, `restore ${ref.file}`, writeTextAtomic(root, ref.file, text, { verbatim: true }))
      if (targetFile !== ref.file) rollbackStep(steps, `remove ${targetFile}`, removeProjectFile(root, targetFile))
      steps.push(...restoreCatalogSnapshot(root, catalogs))
      return afterCatalogFailure(root, rebuilt.error, steps)
    }

    const fingerprint = fingerprintProjectFile(root, targetFile)
    const finalData = parseMarkdown(readChapterText(root, targetFile) ?? next).data
    return {
      ok: true,
      value: {
        ok: true,
        root,
        chapter: viewOf(ref.chapterId, targetFile, finalData, { ...ref, volumeId: targetVolumeId }),
        moved: targetFile !== ref.file,
        movedFrom: ref.file,
        changed,
        catalogRebuilt: true,
        ...(fingerprint === undefined ? {} : { fingerprint }),
        ...UNTOUCHED_INDEX,
      },
    }
  })
  if (!locked.ok) return fromIo(locked.error)
  if (!locked.value.ok) return locked.value
  const result = locked.value.value
  return result.catalogRebuilt ? { ...result, ...(await commitIndex(root)) } : result
}

// ---------------------------------------------------------------------------
// inkflow_chapter_delete
// ---------------------------------------------------------------------------

export async function deleteChapter(projectRoot: string, input: ChapterDeleteInput): Promise<ChapterDeleteResult> {
  const root = resolve(projectRoot)

  const locked = withProjectWriteLock(root, (lock): Locked<DeletedChapterReport> => {
    const root = lock.root
    const resolved = resolveChapter(root, input)
    if (!resolved.ok) return resolved
    const ref = resolved.value

    // The text is captured *before* the deletion: it is the only copy the rollback
    // has, and re-reading after the unlink is impossible.
    const read = readChapterWithFingerprint(root, ref.file)
    if (read === undefined) return fail('CHAPTER_NOT_FOUND', `${ref.file} could not be read`, { root, path: ref.file })
    const text = read.text
    const baseline = read.fingerprint
    // Deleting a file the caller has not seen the latest version of is the one
    // mistake git cannot undo for them: refuse it before the unlink.
    const callerRefusal = callerBaselineRefusal(root, ref.file, baseline, input.expected)
    if (callerRefusal !== undefined) return callerRefusal
    const data = parseMarkdown(text).data

    const catalogs = takeCatalogSnapshot(root)
    const drifted = driftedSinceRead(root, ref.file, baseline)
    if (drifted !== undefined) return drifted
    // A delete is reversible on purpose (roadmap X-9): the file is moved
    // into the recovery bin (`.inkflow/trash/<same relative path>`) with a
    // verified byte-identical copy before the working tree loses it. Everything
    // below still behaves as before — the catalog is the projection and the
    // index a cache — so the bin adds a copy, not a second truth.
    const trashed = trashFile(root, { path: ref.file, reason: 'chapter_delete' })
    if (!trashed.ok) {
      // Reported with the bin's own code: a copy that cannot be made (or a
      // manifest that cannot be read) refuses the delete, so the only way this
      // fails is with the chapter still in place.
      return {
        ok: false,
        error: {
          code: trashed.error.code,
          message: `the chapter was not deleted: ${trashed.error.message}`,
          root,
          path: ref.file,
          ...(trashed.error.hint === undefined ? {} : { hint: trashed.error.hint }),
          ...(trashed.error.nothingWritten === undefined ? {} : { nothingWritten: trashed.error.nothingWritten }),
          ...(trashed.error.rolledBack === undefined ? {} : { rolledBack: trashed.error.rolledBack }),
        },
      }
    }

    const rebuilt = rebuildCatalog(root)
    if (!rebuilt.ok) {
      const steps: RollbackStep[] = []
      rollbackStep(steps, `restore ${ref.file}`, writeTextAtomic(root, ref.file, text, { verbatim: true }))
      // The bin must not keep an entry for a file that is back in the tree.
      rollbackStep(steps, `drop the recovery-bin entry for ${ref.file}`, undoTrashFile(root, trashed.entry.id))
      steps.push(...restoreCatalogSnapshot(root, catalogs))
      return afterCatalogFailure(root, rebuilt.error, steps)
    }

    return {
      ok: true,
      value: {
        deleted: {
          chapterId: ref.chapterId,
          file: ref.file,
          title: stringField(data, 'title') ?? ref.title,
          ...(ref.seq === undefined ? {} : { seq: ref.seq }),
          volumeId: ref.volumeId,
        },
        trashed: { id: trashed.entry.id, trashPath: trashed.trashPath, bytes: trashed.entry.bytes },
      },
    }
  })
  if (!locked.ok) return fromIo(locked.error)
  if (!locked.value.ok) return locked.value

  return {
    ok: true,
    root,
    deleted: locked.value.value.deleted,
    trashed: locked.value.value.trashed,
    catalogRebuilt: true,
    ...(await commitIndex(root)),
  }
}
