/**
 * Exporting a book as EPUB, DOCX, or one Markdown/TXT file (and a package of them) —
 * [ADR-0024](../../.agents/adrs/0024-export-zip-reuse.md), roadmap X-27.
 *
 * **The artifact never lands in the book.** A book is a git repository whose nine content
 * directories are scanned by the index, the catalog, the gates and the backup: an export
 * dropped inside it would either be committed as a binary or show up in `git status` after
 * every export, and anything under `library/` would additionally be registered as
 * reference material. An export is a **derived** artifact — recomputable from the files at
 * any moment — so it is written to `dataDir/exports/`, next to `settings.json`, `backups/`
 * and `diagnostics/`, and named `<bookSlug>-<kind>-<stamp>.<ext>` with the same UTC stamp
 * the backup packages use. `exportBook()` is the only writer here and it writes exactly one
 * file, under `exportsDir(dataDir)`; a `dataDir` that resolves *inside* the book is refused
 * rather than obeyed (`EXPORT_DATA_DIR_INSIDE_BOOK`), because "outside the book" is the
 * property the whole decision rests on.
 *
 * **One ZIP writer (D1).** EPUB and DOCX are ZIP containers and this plugin has exactly one
 * container implementation (`zip.ts`: store-only, one CRC-32, entry order = the order
 * given). Both formats are built as `ZipWriteEntry[]` and written by `writeZip()`; this
 * module computes no CRC, spells no header magic, and imports nothing — the plugin has no
 * runtime dependencies, and a second ZIP writer would be a second way to corrupt the file
 * the author is trying to hand to a reader.
 *
 * **Why the EPUB `mimetype` entry is first and stored (D2).** OCF requires the first entry
 * to be `mimetype`, its payload to be exactly `application/epub+zip` (20 bytes, no BOM, no
 * newline), and that entry to be *uncompressed*. `zip.ts` stores every entry (method 0) and
 * keeps the order it is handed, so both halves come from the container instead of from a
 * branch here: `buildEpub()` returns `mimetype` as `entries[0]`, and the finished package is
 * read back with `readZip()` **before** it is written — a read that also proves every entry
 * is stored, because the reader refuses a compressed one (`ZIP_METHOD_UNSUPPORTED`).
 *
 * **Why the markup is rendered by hand.** A Markdown pipeline would be this plugin's first
 * runtime dependency, while the subset an export actually needs — escape `& < > " '`,
 * blank-line paragraphs, ATX headings — is a few dozen lines. Everything richer (tables,
 * inline code, links) degrades to escaped text, which is visible and correct rather than
 * silently wrong. The renderer is *the same* rule for both formats: chapter title one level
 * under the volume title, body headings one level under the chapter title.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { backupStampZip, bookSlugOf, freeStampedName } from './backup-zip.js'
import { readCatalog } from './catalog.js'
import { buildDocx } from './export-docx.js'
import { buildEpub } from './export-epub.js'
import type { ExportMeta } from './export-epub.js'
import { groupedText, singleFileText } from './export-text.js'
import { ENTRY_PREVIEW, EPUB_MIMETYPE, EXPORT_FORMATS, EXPORT_TARGETS, EXPORTS_DIR } from './export-types.js'
import type { ExportChapter, ExportChapterStatus, ExportError, ExportErrorCode, ExportFormat, ExportGroup, ExportPlan, ExportResult, ExportTarget } from './export-types.js'
import type { CatalogChapter } from './catalog.js'
import { CHAPTER_STATUSES, ROOT_META_FILE } from './conventions.js'
import { parseMarkdown, stringField } from './frontmatter.js'
import { readZip, writeZip } from './zip.js'
import type { ZipWriteEntry } from './zip.js'

type Json = Record<string, unknown>

// ---------------------------------------------------------------------------
// The surface (D4: where it lands, what it is called)
// ---------------------------------------------------------------------------

/** `dataDir/exports`. The one place that spells it. */
export function exportsDir(dataDir: string): string {
  return join(dataDir, EXPORTS_DIR)
}

function fail(code: ExportErrorCode, message: string, hint?: string, extra: Partial<ExportError> = {}): { ok: false; error: ExportError } {
  return { ok: false, error: { code, message, ...(hint === undefined ? {} : { hint }), ...extra } }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

// ---------------------------------------------------------------------------
// The selection: which chapters, in which order
// ---------------------------------------------------------------------------

interface Selection {
  target: ExportTarget
  volumeId?: string
  status?: ExportChapterStatus
}

function isFormat(value: unknown): value is ExportFormat {
  return typeof value === 'string' && (EXPORT_FORMATS as readonly string[]).includes(value)
}

function isTarget(value: unknown): value is ExportTarget {
  return typeof value === 'string' && (EXPORT_TARGETS as readonly string[]).includes(value)
}

function isChapterStatus(value: unknown): value is ExportChapterStatus {
  return typeof value === 'string' && (CHAPTER_STATUSES as readonly string[]).includes(value)
}

/** `inkflow.json`'s display fields. A broken file is not fatal here: a slug still names the book. */
function readBookMeta(root: string, slug: string): { title: string; author: string } {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, ROOT_META_FILE), 'utf8').replace(/^\uFEFF/, ''))
    const meta: Json = typeof parsed === 'object' && parsed !== null ? (parsed as Json) : {}
    const title = stringField(meta, 'title')
    return {
      title: title === undefined || title.trim() === '' ? slug : title,
      author: stringField(meta, 'author') ?? '',
    }
  } catch {
    return { title: slug, author: '' }
  }
}

function readChapter(root: string, chapter: CatalogChapter): ExportResult<ExportChapter> {
  let text: string
  try {
    text = readFileSync(join(root, ...chapter.file.split('/')), 'utf8')
  } catch (cause) {
    return fail(
      'EXPORT_CHAPTER_UNREADABLE',
      `${chapter.file} could not be read: ${messageOf(cause)}`,
      'the catalog lists a chapter the disk does not have; rebuild the catalog (inkflow_index_rebuild) and export again — nothing was written',
      { path: chapter.file },
    )
  }
  const parsed = parseMarkdown(text)
  const status = stringField(parsed.data, 'status')
  const title = stringField(parsed.data, 'title')
  return {
    ok: true,
    value: {
      chapterId: chapter.chapterId,
      file: chapter.file,
      ...(chapter.seq === undefined ? {} : { seq: chapter.seq }),
      title: title === undefined || title.trim() === '' ? chapter.title : title,
      status: isChapterStatus(status) ? status : 'draft',
      body: parsed.body,
    },
  }
}

/**
 * Project the book onto the selection, reading every chapter that survives it.
 *
 * The catalog is the read path (never a directory scan, `AGENTS.md` §4): `readCatalog()`
 * projects the `.md` files, so a stale `index.json` cannot make an export disagree with the
 * book. Reading happens after filtering, so a status- or volume-scoped export only touches
 * the files it is about.
 */
function buildPlan(root: string, selection: Selection): ExportResult<ExportPlan> {
  const slug = bookSlugOf(root)
  const meta = readBookMeta(root, slug)
  const catalog = readCatalog(root)
  const volumes = catalog.catalog.volumes
  const volumeIds = volumes.map((volume) => volume.volumeId)

  if (selection.target === 'volume') {
    const wanted = selection.volumeId ?? ''
    if (wanted === '') {
      return fail('EXPORT_VOLUME_REQUIRED', 'target "volume" needs a volumeId', `this book has: ${volumeIds.join(', ')}`)
    }
    if (!volumeIds.includes(wanted)) {
      return fail(
        'EXPORT_VOLUME_UNKNOWN',
        `this book has no volume ${wanted}`,
        'call inkflow_chapter_list (or export the whole book) to see the volume ids',
        { available: volumeIds },
      )
    }
  }
  if (selection.target === 'status' && selection.status === undefined) {
    return fail('EXPORT_STATUS_REQUIRED', 'target "status" needs a status', `one of: ${CHAPTER_STATUSES.join(', ')}`)
  }

  const keep = (chapter: ExportChapter): boolean =>
    selection.target === 'status' ? chapter.status === selection.status : true

  const groups: ExportGroup[] = []
  let chapters = 0
  for (const [index, volume] of volumes.entries()) {
    if (selection.target === 'volume' && volume.volumeId !== selection.volumeId) continue
    const listed = catalog.volumeCatalogs[index]?.chapters ?? []
    const kept: ExportChapter[] = []
    for (const chapter of listed) {
      const read = readChapter(root, chapter)
      if (!read.ok) return read
      if (!keep(read.value)) continue
      kept.push(read.value)
    }
    if (kept.length === 0) continue
    groups.push({ volumeId: volume.volumeId, title: volume.title, chapters: kept })
    chapters += kept.length
  }

  const loose: ExportChapter[] = []
  for (const chapter of catalog.catalog.looseChapters) {
    const read = readChapter(root, chapter)
    if (!read.ok) return read
    if (!keep(read.value)) continue
    loose.push(read.value)
    chapters += 1
  }

  if (chapters === 0) {
    const scope =
      selection.target === 'volume'
        ? `volume ${String(selection.volumeId)}`
        : selection.target === 'status'
          ? `chapters with status "${String(selection.status)}"`
          : 'this book'
    return fail(
      'EXPORT_EMPTY',
      `there is nothing to export: ${scope} has no chapter`,
      'an export with zero chapters would be an empty file that looks like a broken book; write a chapter (or drop the filter) and export again — nothing was written',
      { available: volumeIds },
    )
  }

  return { ok: true, value: { title: meta.title, author: meta.author, groups, loose, chapters, volumes: groups.length } }
}

// ---------------------------------------------------------------------------
// Writing (one file, under `dataDir/exports`, read back first)
// ---------------------------------------------------------------------------

/** The request, unvalidated: the tool passes `args` straight through, so validation lives here. */
export interface ExportRequest {
  format?: unknown
  target?: unknown
  volumeId?: unknown
  status?: unknown
  /** Timestamp for the file name and the ZIP headers; tests pass a fixed one. */
  at?: Date
}

export interface ExportValue {
  /** File name, `<bookSlug>-<kind>-<stamp>.<ext>`; the identifier a caller reports. */
  file: string
  /** Absolute path of the artifact (the host's own path, never a request's). */
  path: string
  /** `dataDir/exports` — where the user finds it (D4). */
  dir: string
  bookSlug: string
  /** `YYYYMMDD-HHmmss` in UTC (D4, the same stamp backups use). */
  stamp: string
  format: ExportFormat
  target: ExportTarget
  /** `zip` for EPUB/DOCX and for a grouped Markdown/TXT package; `plain` for one file. */
  container: 'zip' | 'plain'
  bytes: number
  /** Entry count: 1 for a plain file, the package's parts otherwise. */
  entryCount: number
  /** The first `ENTRY_PREVIEW` entry names (a 500-chapter EPUB would otherwise print 500). */
  entries: string[]
  chapters: number
  volumes: number
  /** What reading the finished package back reported, before a byte was written. */
  verified: { entries: number; mimetypeFirst: boolean; stored: boolean }
}

/** `true` when `child` is `parent` or lives inside it (both already absolute). */
function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !/^[a-zA-Z]:/.test(path))
}

/**
 * Read a finished package back before it is written.
 *
 * `readZip()` refuses a compressed entry, a duplicate name and any escape-shaped path, so a
 * successful read is the proof D2 asks for: every entry is stored, and the first one is
 * `mimetype` with the OCF payload. A package that fails this is not written at all.
 */
function verifyPackage(archive: Buffer, format: ExportFormat, expected: number): ExportResult<{ entries: number; mimetypeFirst: boolean; stored: boolean }> {
  try {
    const read = readZip(archive)
    if (read.length !== expected) {
      return fail(
        'EXPORT_SELFCHECK_FAILED',
        `the package reads back as ${String(read.length)} entries but was built from ${String(expected)}`,
        'nothing was written; this is a bug in the exporter, report it with the format you asked for',
      )
    }
    if (format !== 'epub') return { ok: true, value: { entries: read.length, mimetypeFirst: false, stored: true } }
    const first = read[0]
    const mimetypeFirst = first !== undefined && first.path === 'mimetype' && first.bytes.toString('utf8') === EPUB_MIMETYPE
    if (!mimetypeFirst) {
      return fail(
        'EXPORT_SELFCHECK_FAILED',
        'the EPUB was built without `mimetype` as its first entry',
        'nothing was written; OCF requires that entry first and uncompressed, so a package without it is not an EPUB',
      )
    }
    return { ok: true, value: { entries: read.length, mimetypeFirst, stored: true } }
  } catch (cause) {
    return fail(
      'EXPORT_SELFCHECK_FAILED',
      `the finished package could not be read back: ${messageOf(cause)}`,
      'nothing was written; an exported file that cannot be opened is worse than no file',
    )
  }
}

function writeArtifact(dir: string, name: string, bytes: Buffer): ExportResult<string> {
  const target = join(dir, name)
  const temp = `${target}.tmp-${String(process.pid)}`
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(temp, bytes)
    renameSync(temp, target)
    return { ok: true, value: target }
  } catch (cause) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // A leftover temp file is cosmetic; the failure below is what the caller needs.
    }
    return fail(
      'EXPORT_WRITE_FAILED',
      `the export could not be written: ${messageOf(cause)}`,
      'nothing in the book was touched; check free space and permissions on the plugin data directory',
    )
  }
}

function previewEntries(entries: ZipWriteEntry[]): string[] {
  return entries.slice(0, ENTRY_PREVIEW).map((entry) => entry.path)
}

/**
 * Export this book, once, into `dataDir/exports` (D4).
 *
 * The order of the checks is deliberate: the request is validated, then the selection is
 * read (any failure here writes nothing), then the artifact is built and read back, and only
 * a package that survives all of that reaches the disk.
 */
export function exportBook(root: string, dataDir: string, request: ExportRequest): ExportResult<ExportValue> {
  const format = request.format
  if (!isFormat(format)) {
    return fail(
      'EXPORT_FORMAT_INVALID',
      `unknown format ${JSON.stringify(format ?? null)}`,
      `pass one of: ${EXPORT_FORMATS.join(', ')}`,
    )
  }
  const target = request.target
  if (!isTarget(target)) {
    return fail(
      'EXPORT_TARGET_INVALID',
      `unknown target ${JSON.stringify(target ?? null)}`,
      `pass one of: ${EXPORT_TARGETS.join(', ')}`,
    )
  }
  const volumeId = typeof request.volumeId === 'string' && request.volumeId.trim() !== '' ? request.volumeId.trim() : undefined
  if (request.status !== undefined && request.status !== null && request.status !== '' && !isChapterStatus(request.status)) {
    return fail(
      'EXPORT_STATUS_INVALID',
      `unknown status ${JSON.stringify(request.status)}`,
      `pass one of: ${CHAPTER_STATUSES.join(', ')}`,
    )
  }
  const status = isChapterStatus(request.status) ? request.status : undefined

  // The two selection axes are not combinable: `volume` is a scope and `status` is a
  // filter across volumes. Ignoring one of them would answer a different question than the
  // caller asked, so a mixed request is refused with the name of the parameter to drop.
  if (target !== 'status' && status !== undefined) {
    return fail(
      'EXPORT_SELECTION_UNUSED',
      `\`status\` only applies to target "status", not "${target}"`,
      'pass target: "status" to filter by chapter status, or drop `status` — a volume export is one volume, unfiltered',
    )
  }
  if (target !== 'volume' && volumeId !== undefined) {
    return fail(
      'EXPORT_SELECTION_UNUSED',
      `\`volumeId\` only applies to target "volume", not "${target}"`,
      'pass target: "volume" to export one volume, or drop `volumeId`',
    )
  }

  const bookRoot = resolve(root)
  const stateDir = resolve(dataDir)
  if (isInside(bookRoot, stateDir)) {
    return fail(
      'EXPORT_DATA_DIR_INSIDE_BOOK',
      `the export directory ${exportsDir(stateDir)} is inside this book`,
      'exports are derived artifacts and must not land in the book (they would enter git and the content scan); point dataDir outside the book',
    )
  }

  const planned = buildPlan(bookRoot, {
    target,
    ...(volumeId === undefined ? {} : { volumeId }),
    ...(status === undefined ? {} : { status }),
  })
  if (!planned.ok) return planned
  const plan = planned.value

  const at = request.at ?? new Date()
  const slug = bookSlugOf(bookRoot)
  const meta: ExportMeta = { title: plan.title, author: plan.author, slug, at }

  const grouped = format === 'markdown' || format === 'txt' ? target === 'status' : false
  const entries: ZipWriteEntry[] =
    format === 'epub' ? buildEpub(plan, meta) : format === 'docx' ? buildDocx(plan) : grouped ? groupedText(plan, format) : []

  let payload: Buffer
  if (format === 'epub' || format === 'docx' || grouped) {
    try {
      payload = writeZip(entries, { at })
    } catch (cause) {
      return fail(
        'EXPORT_SELFCHECK_FAILED',
        `the package could not be assembled: ${messageOf(cause)}`,
        'nothing was written; this is a bug in the exporter, report it with the format you asked for',
      )
    }
  } else {
    payload = Buffer.from(singleFileText(plan, format), 'utf8')
  }

  const isContainer = format === 'epub' || format === 'docx' || grouped
  let verified: { entries: number; mimetypeFirst: boolean; stored: boolean }
  if (isContainer) {
    const checked = verifyPackage(payload, format, entries.length)
    if (!checked.ok) return checked
    verified = checked.value
  } else {
    // A single text file has nothing to unpack; its "self-check" is that it is not empty.
    verified = { entries: 1, mimetypeFirst: false, stored: false }
  }

  const ext = format === 'epub' ? '.epub' : format === 'docx' ? '.docx' : grouped ? '.zip' : format === 'markdown' ? '.md' : '.txt'
  const dir = exportsDir(stateDir)
  // Resolved before writing: the stamp has one-second resolution, so two exports in the
  // same second are normal and both must survive (D4 reuses the backup naming rule).
  const name = freeStampedName(dir, `${slug}-${format}`, backupStampZip(at), ext)
  const written = writeArtifact(dir, name, payload)
  if (!written.ok) return written

  return {
    ok: true,
    value: {
      file: name,
      path: written.value,
      dir,
      bookSlug: slug,
      stamp: backupStampZip(at),
      format,
      target,
      container: isContainer ? 'zip' : 'plain',
      bytes: payload.byteLength,
      entryCount: verified.entries,
      entries: isContainer ? previewEntries(entries) : [name],
      chapters: plan.chapters,
      volumes: plan.volumes,
      verified,
    },
  }
}

// Every format's surface is re-exported from here: `tools.ts` and the hub pages import
// this module and only this module, so the split moved code without moving addresses.
export { EXPORT_FORMATS, EXPORT_TARGETS, EPUB_MIMETYPE, EXPORTS_DIR } from './export-types.js'
export type { ExportChapter, ExportChapterStatus, ExportError, ExportErrorCode, ExportFormat, ExportGroup, ExportPlan, ExportResult, ExportTarget } from './export-types.js'
export type { ExportMeta } from './export-epub.js'
export { escapeXml, markdownBlocks } from './export-render.js'
export type { MarkdownBlock } from './export-render.js'
export { buildEpub } from './export-epub.js'
export { buildDocx } from './export-docx.js'
