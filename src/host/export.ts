/**
 * Exporting a book as EPUB, DOCX, or one Markdown/TXT file (and a package of them) —
 * issue #50, [ADR-0024](../../.agents/adrs/0024-export-zip-reuse.md), roadmap X-27.
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
import type { CatalogChapter } from './catalog.js'
import { CHAPTER_STATUSES, ROOT_META_FILE } from './conventions.js'
import { parseMarkdown, stringField } from './frontmatter.js'
import { readZip, writeZip } from './zip.js'
import type { ZipWriteEntry } from './zip.js'

type Json = Record<string, unknown>

// ---------------------------------------------------------------------------
// The surface (D4: where it lands, what it is called)
// ---------------------------------------------------------------------------

/** `dataDir/exports`: the plugin's own export directory, outside every book (D4). */
export const EXPORTS_DIR = 'exports'

/** The four formats the issue asks for. `kind` in the file name is this value, verbatim. */
export const EXPORT_FORMATS = ['epub', 'docx', 'markdown', 'txt'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

/**
 * What gets exported: the whole book, one volume, or every chapter in one status.
 *
 * `book` and `volume` are scope selections; `status` is a *filter* across volumes, which
 * is why it packages one file per volume instead of one file for the book.
 */
export const EXPORT_TARGETS = ['book', 'volume', 'status'] as const
export type ExportTarget = (typeof EXPORT_TARGETS)[number]

/** OCF's payload for the first entry: 20 bytes, no BOM, no trailing newline (D2). */
export const EPUB_MIMETYPE = 'application/epub+zip'

const EPUB_OPF_PATH = 'OEBPS/content.opf'
const EPUB_NAV_PATH = 'OEBPS/toc.xhtml'
const EPUB_CONTAINER_PATH = 'META-INF/container.xml'

/** Entries a reply spells out before it switches to counting them. */
const ENTRY_PREVIEW = 12

/** A refusal a caller reports instead of a stack trace. */
export type ExportErrorCode =
  /** `format` is missing or not one of `EXPORT_FORMATS`. */
  | 'EXPORT_FORMAT_INVALID'
  /** `target` is missing or not one of `EXPORT_TARGETS`. */
  | 'EXPORT_TARGET_INVALID'
  /** `target: "volume"` without a `volumeId`. */
  | 'EXPORT_VOLUME_REQUIRED'
  /** `volumeId` names no volume of this book. */
  | 'EXPORT_VOLUME_UNKNOWN'
  /** `target: "status"` without a `status`. */
  | 'EXPORT_STATUS_REQUIRED'
  /** `status` is not one of `CHAPTER_STATUSES`. */
  | 'EXPORT_STATUS_INVALID'
  /** A selection parameter the chosen target does not read (`status` with `target: "volume"`). */
  | 'EXPORT_SELECTION_UNUSED'
  /** Nothing to export: an empty book, or a filter that matched no chapter. */
  | 'EXPORT_EMPTY'
  /** The catalog names a chapter file that cannot be read. */
  | 'EXPORT_CHAPTER_UNREADABLE'
  /** `dataDir` resolves inside the book, so an export there would pollute it (D4). */
  | 'EXPORT_DATA_DIR_INSIDE_BOOK'
  /** The package could not be read back before writing: nothing was written. */
  | 'EXPORT_SELFCHECK_FAILED'
  /** The file could not be written (permissions, free space). */
  | 'EXPORT_WRITE_FAILED'

export interface ExportError {
  code: ExportErrorCode
  message: string
  hint?: string
  /** Book-relative path the refusal is about (`EXPORT_CHAPTER_UNREADABLE`). */
  path?: string
  /** `EXPORT_EMPTY` / `EXPORT_VOLUME_UNKNOWN`: what the book does have. */
  available?: string[]
}

export type ExportResult<T> = { ok: true; value: T } | { ok: false; error: ExportError }

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
// Markdown → the formats below (one renderer, three sinks)
// ---------------------------------------------------------------------------

/** One block of a chapter body, as every sink needs it. */
export type MarkdownBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }

/**
 * Cut a chapter body into paragraphs and ATX headings.
 *
 * Deliberately not a Markdown parser: the two shapes an export must honour are "a blank line
 * starts a new paragraph" and "a line of `#`s starts a heading". Everything else stays text,
 * which is why a table inside a chapter shows up as its own raw lines instead of vanishing.
 */
export function markdownBlocks(body: string): MarkdownBlock[] {
  const out: MarkdownBlock[] = []
  let paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length === 0) return
    out.push({ kind: 'paragraph', text: paragraph.join('\n') })
    paragraph = []
  }
  const normalized = body.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  for (const raw of normalized.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') {
      flush()
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading !== null) {
      flush()
      out.push({ kind: 'heading', level: (heading[1] ?? '').length, text: (heading[2] ?? '').trim() })
      continue
    }
    paragraph.push(line)
  }
  flush()
  return out
}

/**
 * XML-escape text for XHTML and OOXML.
 *
 * `&` first, then the four characters that would otherwise close a tag or an attribute:
 * replacing `<` after `&` cannot re-introduce a bare `&`, so the order is the whole trick.
 * A chapter that literally contains `<script>` therefore arrives as text in every reader
 * instead of as markup (ADR-0024 备选: no sanitiser, no whitelist — escape everything).
 */
export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** A block's heading level in a sink whose chapter title already sits at `chapterLevel`. */
function below(chapterLevel: number, blockLevel: number): number {
  return Math.min(chapterLevel + blockLevel, 6)
}

function blocksToXhtml(blocks: MarkdownBlock[]): string {
  const lines: string[] = []
  for (const block of blocks) {
    if (block.kind === 'heading') {
      const level = String(below(1, block.level))
      lines.push(`<h${level}>${escapeXml(block.text)}</h${level}>`)
      continue
    }
    // A newline inside a paragraph is a soft break in Markdown: one space, not a `<br/>`.
    lines.push(`<p>${escapeXml(block.text).replaceAll('\n', ' ')}</p>`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// The selection: which chapters, in which order
// ---------------------------------------------------------------------------

export type ExportChapterStatus = (typeof CHAPTER_STATUSES)[number]

/** One chapter as the exporters consume it: frontmatter resolved, body stripped. */
export interface ExportChapter {
  /** Catalog id (frontmatter `id`, else the project-relative path). */
  chapterId: string
  /** Project-relative path with `/` separators (what a report names). */
  file: string
  seq?: number
  title: string
  /** Frontmatter `status`, normalized to `CHAPTER_STATUSES` (`draft` when absent). */
  status: ExportChapterStatus
  /** Body with the frontmatter block removed, LF-normalized. */
  body: string
}

/** One volume and the chapters of it that the selection kept. */
export interface ExportGroup {
  /** `vol-NN`: the stable id (not the directory slug). */
  volumeId: string
  /** Display title (from the directory slug, see `catalog.ts`). */
  title: string
  chapters: ExportChapter[]
}

/** Everything one export writes, in reading order. */
export interface ExportPlan {
  /** Book title from `inkflow.json`; falls back to the directory slug. */
  title: string
  /** `inkflow.json` author, `''` when the book names none. */
  author: string
  /** Volumes in reading order, each keeping only its selected chapters. */
  groups: ExportGroup[]
  /** Chapters that belong to no volume, in catalog order. */
  loose: ExportChapter[]
  /** Chapters written into the artifact. */
  chapters: number
  /** Volumes that still have at least one chapter. */
  volumes: number
}

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
// EPUB (D2: mimetype first, container → OPF → nav → one XHTML per chapter)
// ---------------------------------------------------------------------------

export interface ExportMeta {
  /** Book title (`inkflow.json`), escaped at every use site. */
  title: string
  author: string
  /** Display name of the book directory: the file name's first segment (D4). */
  slug: string
  /** Stamped into `dcterms:modified` and the ZIP headers; a fixed value makes bytes reproducible. */
  at: Date
}

interface EpubItem {
  id: string
  href: string
  chapter: ExportChapter
}

/** Reading order flattened, with the ids/hrefs the manifest and the spine share. */
function epubItems(plan: ExportPlan): EpubItem[] {
  const items: EpubItem[] = []
  const all = [...plan.groups.flatMap((group) => group.chapters), ...plan.loose]
  for (const [index, chapter] of all.entries()) {
    const id = `ch${String(index + 1).padStart(4, '0')}`
    items.push({ id, href: `text/${id}.xhtml`, chapter })
  }
  return items
}

/**
 * A book identifier derived from the slug and the title.
 *
 * Not random: two exports of the same book then claim to be the same book (a reader's
 * library stops growing a new entry per export), and the bytes stay reproducible.
 */
function bookIdentifier(meta: ExportMeta): string {
  const digest = createHash('sha256').update(`${meta.slug}\u0000${meta.title}`, 'utf8').digest('hex')
  return `urn:uuid:${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

/** `YYYY-MM-DDTHH:MM:SSZ` — the only shape `dcterms:modified` accepts. */
function epubTimestamp(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`
}

function xhtmlDocument(title: string, body: string): string {
  const escaped = escapeXml(title)
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!DOCTYPE html>',
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8"/>',
    `<title>${escaped}</title>`,
    '</head>',
    '<body>',
    `<h1>${escaped}</h1>`,
  ]
  if (body !== '') lines.push(body)
  lines.push('</body>', '</html>', '')
  return lines.join('\n')
}

function containerXml(): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">',
    '<rootfiles>',
    `<rootfile full-path="${EPUB_OPF_PATH}" media-type="application/oebps-package+xml"/>`,
    '</rootfiles>',
    '</container>',
    '',
  ].join('\n')
}

/**
 * The navigation document: `卷 → 章` as nested `<ol>` (EPUB 3 `nav`, ADR-0024 D2).
 *
 * This is where the volume hierarchy lives — the XHTML files themselves are flat, one per
 * chapter, so a reader's table of contents shows two levels while the spine stays linear.
 */
function navXhtml(plan: ExportPlan, items: EpubItem[]): string {
  const hrefOf = new Map(items.map((item) => [item.chapter.chapterId, item.href]))
  const link = (chapter: ExportChapter): string => {
    const href = hrefOf.get(chapter.chapterId) ?? ''
    return `<li><a href="${escapeXml(href)}">${escapeXml(chapter.title)}</a></li>`
  }
  const list: string[] = []
  for (const group of plan.groups) {
    list.push('<li>')
    list.push(`<span>${escapeXml(group.title)}</span>`)
    list.push('<ol>')
    for (const chapter of group.chapters) list.push(link(chapter))
    list.push('</ol>')
    list.push('</li>')
  }
  for (const chapter of plan.loose) list.push(link(chapter))
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!DOCTYPE html>',
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8"/>',
    `<title>${escapeXml(plan.title)}</title>`,
    '</head>',
    '<body>',
    '<nav epub:type="toc" id="toc">',
    '<h1>目录</h1>',
    '<ol>',
    ...list,
    '</ol>',
    '</nav>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

function contentOpf(plan: ExportPlan, meta: ExportMeta, items: EpubItem[]): string {
  const manifest = [
    `<item id="nav" href="toc.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    ...items.map((item) => `<item id="${item.id}" href="${item.href}" media-type="application/xhtml+xml"/>`),
  ]
  const spine = items.map((item) => `<itemref idref="${item.id}"/>`)
  const creator = meta.author === '' ? [] : [`<dc:creator>${escapeXml(meta.author)}</dc:creator>`]
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">',
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `<dc:identifier id="bookid">${bookIdentifier(meta)}</dc:identifier>`,
    `<dc:title>${escapeXml(plan.title)}</dc:title>`,
    '<dc:language>zh-CN</dc:language>',
    ...creator,
    `<meta property="dcterms:modified">${epubTimestamp(meta.at)}</meta>`,
    '</metadata>',
    '<manifest>',
    ...manifest,
    '</manifest>',
    '<spine>',
    ...spine,
    '</spine>',
    '</package>',
    '',
  ].join('\n')
}

/**
 * The EPUB's entries, `mimetype` **first** (D2).
 *
 * Order is the contract: `writeZip` stores entries in the order it is handed them, so the
 * very first entry of the package is this one, stored (method 0, because everything this
 * plugin writes is stored) and 20 bytes long.
 */
export function buildEpub(plan: ExportPlan, meta: ExportMeta): ZipWriteEntry[] {
  const items = epubItems(plan)
  const entries: ZipWriteEntry[] = [
    { path: 'mimetype', bytes: EPUB_MIMETYPE },
    { path: EPUB_CONTAINER_PATH, bytes: containerXml() },
    { path: EPUB_OPF_PATH, bytes: contentOpf(plan, meta, items) },
    { path: EPUB_NAV_PATH, bytes: navXhtml(plan, items) },
  ]
  for (const item of items) {
    entries.push({ path: `OEBPS/${item.href}`, bytes: xhtmlDocument(item.chapter.title, blocksToXhtml(markdownBlocks(item.chapter.body))) })
  }
  return entries
}

// ---------------------------------------------------------------------------
// DOCX (D3: the minimal OOXML part set, headings instead of sections)
// ---------------------------------------------------------------------------

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const DOCX_MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
const DOCX_STYLES_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'

/** Heading levels the styles part defines: volume 1, chapter 2, body 3–6 (D3). */
const DOCX_HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const

function contentTypesXml(): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    `<Override PartName="/word/document.xml" ContentType="${DOCX_MAIN_TYPE}"/>`,
    `<Override PartName="/word/styles.xml" ContentType="${DOCX_STYLES_TYPE}"/>`,
    '</Types>',
    '',
  ].join('\n')
}

function packageRelsXml(): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<Relationships xmlns="${REL_NS}">`,
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '</Relationships>',
    '',
  ].join('\n')
}

/** `document.xml.rels` exists for one reason: styles are reached through it, not by guessing. */
function documentRelsXml(): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<Relationships xmlns="${REL_NS}">`,
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '</Relationships>',
    '',
  ].join('\n')
}

function stylesXml(): string {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<w:styles xmlns:w="${WORD_NS}">`,
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal">',
    '<w:name w:val="Normal"/>',
    '</w:style>',
  ]
  for (const level of DOCX_HEADING_LEVELS) {
    // Half-points: 16pt / 14pt / 12pt, then body size for the deeper levels.
    const size = [32, 28, 24, 22, 22, 22][level - 1] ?? 22
    lines.push(
      `<w:style w:type="paragraph" w:styleId="Heading${String(level)}">`,
      `<w:name w:val="heading ${String(level)}"/>`,
      '<w:basedOn w:val="Normal"/>',
      '<w:next w:val="Normal"/>',
      '<w:qFormat/>',
      `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${String(level - 1)}"/></w:pPr>`,
      `<w:rPr><w:b/><w:sz w:val="${String(size)}"/></w:rPr>`,
      '</w:style>',
    )
  }
  lines.push('</w:styles>', '')
  return lines.join('\n')
}

/** One paragraph. `xml:space="preserve"` keeps the author's leading spaces. */
function docxParagraph(text: string, style?: string): string {
  const pPr = style === undefined ? '' : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
}

/**
 * The body, in reading order: volume = Heading 1, chapter = Heading 2, body blocks below.
 *
 * No `sectPr` and no section breaks (ADR-0024 D3): the structure is the heading hierarchy,
 * which is what Word's navigation pane and every "save as PDF" pipeline read.
 */
function documentXml(plan: ExportPlan): string {
  const body: string[] = []
  const writeChapter = (chapter: ExportChapter): void => {
    body.push(docxParagraph(chapter.title, 'Heading2'))
    for (const block of markdownBlocks(chapter.body)) {
      if (block.kind === 'heading') body.push(docxParagraph(block.text, `Heading${String(below(2, block.level))}`))
      else body.push(docxParagraph(block.text))
    }
  }
  for (const group of plan.groups) {
    body.push(docxParagraph(group.title, 'Heading1'))
    for (const chapter of group.chapters) writeChapter(chapter)
  }
  for (const chapter of plan.loose) writeChapter(chapter)
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<w:document xmlns:w="${WORD_NS}">`,
    '<w:body>',
    ...body,
    '</w:body>',
    '</w:document>',
    '',
  ].join('\n')
}

/**
 * The DOCX's entries: four required parts plus the styles part that makes Heading 1/2 real.
 *
 * `styles.xml` is the ADR's "optional" part, taken because the issue asks for heading
 * *levels*: a `pStyle` reference to a style the package does not define degrades to body
 * text in Word, so the hierarchy would exist only in the XML.
 */
export function buildDocx(plan: ExportPlan): ZipWriteEntry[] {
  return [
    { path: '[Content_Types].xml', bytes: contentTypesXml() },
    { path: '_rels/.rels', bytes: packageRelsXml() },
    { path: 'word/document.xml', bytes: documentXml(plan) },
    { path: 'word/_rels/document.xml.rels', bytes: documentRelsXml() },
    { path: 'word/styles.xml', bytes: stylesXml() },
  ]
}

// ---------------------------------------------------------------------------
// Markdown / TXT: one file for a scope, one file per volume for a status filter
// ---------------------------------------------------------------------------

type TextFormat = 'markdown' | 'txt'

/**
 * The same blocks, flattened to prose.
 *
 * This is what makes a `.txt` export text rather than Markdown with the `#` left in: the ATX
 * marker is a rendering instruction, so it is dropped and the heading is kept as its line.
 */
function textBlocks(body: string): string[] {
  return markdownBlocks(body).map((block) => block.text)
}

function chapterTextLines(chapter: ExportChapter, format: TextFormat): string[] {
  const lines: string[] = []
  lines.push(format === 'markdown' ? `### ${chapter.title}` : chapter.title)
  lines.push('')
  if (format === 'markdown') {
    lines.push(chapter.body.replace(/^\n+/, '').replace(/\s+$/, ''))
  } else {
    lines.push(...textBlocks(chapter.body).map((block) => block.replace(/\n/g, ' ')))
  }
  lines.push('')
  return lines.filter((line, index, all) => !(line === '' && all[index - 1] === ''))
}

/**
 * The whole selection as one document: title, `##` per volume, `###` per chapter.
 *
 * One file is the right shape for a scope question ("give me book one"), which is why only
 * a status filter (a cross-volume slice) becomes a package instead.
 */
function singleFileText(plan: ExportPlan, format: TextFormat): string {
  const lines: string[] = []
  lines.push(format === 'markdown' ? `# ${plan.title}` : plan.title)
  if (format === 'markdown' && plan.author !== '') lines.push('', `作者：${plan.author}`)
  lines.push('')
  for (const group of plan.groups) {
    lines.push(format === 'markdown' ? `## ${group.title}` : group.title)
    lines.push('')
    for (const chapter of group.chapters) lines.push(...chapterTextLines(chapter, format))
  }
  for (const chapter of plan.loose) lines.push(...chapterTextLines(chapter, format))
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

/**
 * The status filter as a package: one entry per volume, plus `loose.<ext>` for chapters that
 * belong to none. Zero-chapter volumes are already gone (`buildPlan`), so no entry is empty.
 */
function groupedText(plan: ExportPlan, format: TextFormat): ZipWriteEntry[] {
  const ext = format === 'markdown' ? '.md' : '.txt'
  const entries: ZipWriteEntry[] = []
  for (const group of plan.groups) {
    const lines: string[] = [format === 'markdown' ? `# ${group.title}` : group.title, '']
    for (const chapter of group.chapters) lines.push(...chapterTextLines(chapter, format))
    entries.push({ path: `${group.volumeId}${ext}`, bytes: `${lines.join('\n').replace(/\n+$/, '')}\n` })
  }
  if (plan.loose.length > 0) {
    const lines: string[] = [format === 'markdown' ? '# 散章' : '散章', '']
    for (const chapter of plan.loose) lines.push(...chapterTextLines(chapter, format))
    entries.push({ path: `loose${ext}`, bytes: `${lines.join('\n').replace(/\n+$/, '')}\n` })
  }
  return entries
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
