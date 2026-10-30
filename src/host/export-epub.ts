/**
 * The EPUB 3 package (ADR-0013 D2): `mimetype` first and stored, container → OPF → nav →
 * one XHTML per chapter. Nothing here touches the disk.
 *
 * WHY IT IS A FILE: it is a whole format with its own escaping and heading rules; sitting
 * next to the DOCX sink in one module made both harder to check against their ADR.
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { writeZip } from './zip.js'
import type { ZipWriteEntry } from './zip.js'
import { EPUB_CONTAINER_PATH, EPUB_MIMETYPE, EPUB_NAV_PATH, EPUB_OPF_PATH } from './export-types.js'
import type { ExportChapter, ExportPlan } from './export-types.js'
import { blocksToXhtml, escapeXml, markdownBlocks } from './export-render.js'

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
