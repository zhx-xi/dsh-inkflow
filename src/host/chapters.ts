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
import type {
  ChapterCreateInput,
  ChapterCreateResult,
  ChapterDeleteInput,
  ChapterDeleteResult,
  ChapterErrorCode,
  ChapterMoveInput,
  ChapterMoveOk,
  ChapterMoveResult,
  ChapterOpError,
  ChapterOpFailure,
  ChapterView,
  ChapterWriteInput,
  ChapterWriteOk,
  ChapterWriteResult,
  CommitInfo,
  RollbackStep,
  VolumeCreateInput,
  VolumeCreateResult,
  VolumeRenameInput,
  VolumeRenameOk,
  VolumeRenameResult,
  VolumeView,
  DeletedChapterReport,
} from './chapters-types.js'
// The contract is this module's public surface too: the channel, the tools and the re-export
// layer all import these names from 'chapters.js', and moving the declarations must not move
// the address they are imported by.
export type * from './chapters-types.js'

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

export function canonicalVolumeId(raw: string): string | undefined {
  const match = VOLUME_ID.exec(raw.trim())
  const digits = match?.[1]
  if (digits === undefined) return undefined
  const number = Number.parseInt(digits, 10)
  if (!Number.isInteger(number) || number < 1) return undefined
  return `vol-${String(number).padStart(2, '0')}`
}

export function volumeNumberOf(volumeId: string): number {
  return Number.parseInt(volumeId.slice('vol-'.length), 10)
}

/**
 * Title → directory/file slug. CJK survives as-is (a Chinese title needs no
 * transliteration and stays readable in `git diff`); whitespace and anything a
 * filesystem would rewrite becomes a single `-`. The catalog title of a volume
 * falls back to this slug when no `outlines/vol-NN*.md` exists, so a title
 * without spaces round-trips exactly.
 */
export function slugify(title: string): string {
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

export function padSeq(seq: number): string {
  return String(seq).padStart(SEQ_DIGITS, '0')
}

/**
 * Use the caller's slug when one was passed (an explicit `""` or `"  "` is a
 * mistake, not "derive it for me"), otherwise derive one from the title.
 */
export function resolveSlug(inputSlug: string | undefined, title: string): { ok: true; value: string } | { ok: false; problem: string } {
  if (inputSlug !== undefined) {
    const slug = inputSlug.trim()
    const problem = slugProblem(slug)
    if (problem !== undefined) return { ok: false, problem }
    return { ok: true, value: slug }
  }
  return { ok: true, value: slugify(title) }
}

export function fileNameOf(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1)
}

export function directoryOf(file: string): string {
  const at = file.lastIndexOf('/')
  return at === -1 ? '' : file.slice(0, at)
}

/** The numeric prefix of a chapter file name (`0001-入山.md` → `0001`). */
export function leadingDigitsOf(file: string): string | undefined {
  return /^(\d+)/.exec(fileNameOf(file))?.[1]
}

/** `chapters/vol-01-入山/0001-入山.md`; a `chapters` directory means a loose chapter. */
export function chapterFile(dir: string, prefix: string | undefined, slug: string): string {
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

export function fail(code: ChapterErrorCode | string, message: string, extra: FailureExtra = {}): ChapterOpFailure {
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
export function fromIo(io: IoFailure, extra: { root?: string; message?: string; hint?: string } = {}): ChapterOpFailure {
  return fail(io.code, extra.message ?? io.message, {
    root: extra.root ?? io.root,
    path: io.path,
    hint: extra.hint ?? io.hint,
    io,
  })
}

export function rollbackStep(steps: RollbackStep[], action: string, result: { ok: boolean; error?: { message?: string } }): void {
  steps.push(result.ok ? { action, ok: true } : { action, ok: false, message: result.error?.message ?? 'failed' })
}

/** Remove a file only if it is there; a missing one is not a rollback failure. */
export function removeIfExists(root: string, relative: string): { ok: boolean; error?: IoFailure } {
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

export function takeCatalogSnapshot(root: string): CatalogSnapshot {
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

export function restoreCatalogSnapshot(root: string, snapshot: CatalogSnapshot): RollbackStep[] {
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
export function afterCatalogFailure(root: string, cause: IoFailure, steps: RollbackStep[]): ChapterOpFailure {
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
export type Locked<T> = { ok: true; value: T } | ChapterOpFailure

/** Rebuild the derived index; a cache failure is reported, never rolled back. */
export async function commitIndex(root: string): Promise<Pick<CommitInfo, 'indexRebuilt' | 'indexError'>> {
  try {
    await buildIndex(root)
    return { indexRebuilt: true }
  } catch (cause) {
    const failure = describeIndexBuildFailure(cause)
    return { indexRebuilt: false, indexError: { code: failure.code, message: failure.message } }
  }
}

export const UNTOUCHED_INDEX = { indexRebuilt: false } as const

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

export function chaptersOf(catalog: CatalogReadResult, volumeId: string | null): CatalogChapter[] {
  if (volumeId === null) return catalog.catalog.looseChapters
  return catalog.volumeCatalogs.find((volume) => volume.volumeId === volumeId)?.chapters ?? []
}

export function maxSeq(chapters: readonly CatalogChapter[]): number {
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
export function resolveChapter(
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

export function readChapterText(root: string, file: string): string | undefined {
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
export function readChapterWithFingerprint(root: string, file: string): ChapterRead | undefined {
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
export function callerBaselineRefusal(
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
export function driftedSinceRead(root: string, path: string, baseline: FileFingerprint): ChapterOpFailure | undefined {
  const drift = compareExpectation(fingerprintProjectFile(root, path), baseline)
  return drift === undefined ? undefined : fileChangedFailure(root, path, drift, 'changed on disk while this call was working on it')
}

export function viewOf(chapterId: string, file: string, data: Record<string, unknown>, fallback: ChapterRef): ChapterView {
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
export function applyFields(text: string, entries: Record<string, string>, remove: readonly string[] = []): FieldApply {
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

export function withBody(text: string, body: string): string {
  const parts = splitFrontmatter(text)
  return `${parts.head}${body}`
}

// The operations live in `chapters-ops.ts`; this module keeps their address stable.
export { createChapter, deleteChapter, moveChapter, writeChapter } from './chapters-ops.js'
export { createVolume, renameVolume } from './chapters-ops-volume.js'
