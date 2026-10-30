/**
 * The DOCX package (ADR-0013 D3): the minimal OOXML part set, Heading 1/2 instead of
 * sections. Nothing here touches the disk.
 *
 * WHY IT IS A FILE: a format of its own with its own part list and styles part, so a reader
 * comparing the two binary formats can open them side by side.
 */

import { join } from 'node:path'
import type { ZipWriteEntry } from './zip.js'
import type { ExportChapter, ExportPlan } from './export-types.js'
import { below, escapeXml, markdownBlocks } from './export-render.js'

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
