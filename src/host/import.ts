/**
 * Reading an old manuscript (issue #37, roadmap X-17): bytes → one analysable text.
 *
 * Everything here is a pure function over a `Buffer`. The write side (chapter files,
 * the backup package, the library copy) lives in `import-write.ts`; this module never
 * touches the filesystem, which is what lets the 59-万字 acceptance case run as a
 * plain assertion about paragraphs and characters instead of an integration test.
 *
 * THREE DECISIONS WORTH STATING, because each is a place where a plausible-looking
 * implementation silently mangles prose:
 *
 *   1. **The encoding tiers are ordered, and the order is the contract.**
 *      UTF-8 with a BOM → UTF-16 LE/BE by BOM → strict UTF-8 → GBK. Strict UTF-8 has
 *      to come *before* the GBK fallback (a GBK manuscript is almost never valid
 *      UTF-8, so the strict decoder is the discriminator) and *after* the BOM tiers
 *      (a UTF-16 file's bytes are often valid UTF-8 — `第一章` in UTF-16LE is
 *      `2D 4E 00 7B`, i.e. the ASCII `-N`, a NUL, and `{`). GBK is decoded through
 *      `TextDecoder('gbk')`: the Host runs Node 24 with full ICU, so the table ships
 *      with the binary and no dependency or hand-written code page is involved.
 *   2. **Line endings are remembered, not preserved.** The analysis text is LF
 *      (every comparison in this project is), the source style travels in the report,
 *      and the chapter files this import creates are new files — which data-safety
 *      §2.6 says land as LF. The style is therefore information for the author, not
 *      a format to reproduce; a file whose first terminator is CRLF is reported as
 *      CRLF even when the text handed on has none.
 *   3. **Nothing is dropped to make splitting tidy.** A title line never stays inside
 *      a body; text before the first title becomes a preface chapter; a file with no
 *      recognisable title becomes one chapter *and says so* in `warnings`, because
 *      "we split nothing" and "there was nothing to split" are different facts.
 *
 * Why the splitter needs TWO matches before it believes a pattern: `一、` is also how
 * an outline item or a numbered paragraph starts, and one short standalone line is how
 * plenty of ordinary prose looks. One match is a coincidence; two are a structure. A
 * single-chapter file is not a failure — it is one chapter whose text is untouched —
 * and the report says the title prefix was not recognised.
 */

import { countChars } from './domains/scan-helpers.js'

/** Largest source accepted, in bytes. 60 万字 of UTF-8 Chinese is ≈ 1.8 MB. */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024

/** File extensions the import path accepts: 旧稿 are TXT or Markdown. */
export const IMPORT_EXTENSIONS = ['.txt', '.md'] as const

/** Longest a line may be and still be a chapter title. */
const TITLE_MAX_CHARS = 60

/**
 * Longest a line may be in the "short standalone line" fallback tier, and the
 * characters that disqualify one: sentence punctuation means it is prose.
 */
const SHORT_TITLE_MAX_CHARS = 24
const SENTENCE_PUNCTUATION = /[。，、；：！？…—「」『』（）,.!?;:]/u

/** Which tier of `ImportEncoding` produced the text. */
export type ImportEncoding = 'utf8' | 'utf8-bom' | 'utf16le-bom' | 'utf16be-bom' | 'gbk'

/** The terminator style the source used (the analysis text is always LF). */
export type ImportEol = 'lf' | 'crlf'

/** Which title shape split the file; `none` means the whole file is one chapter. */
export type ImportPattern = 'numbered' | 'english' | 'cn-marker' | 'short-line' | 'none'

/** Bytes decoded into one LF-normalised text plus how that was decided. */
export interface ImportDecoded {
  /** LF-normalised, BOM-free. */
  text: string
  encoding: ImportEncoding
  /** Human-readable provenance of `encoding` — goes straight into the report. */
  sniff: string
  eol: ImportEol
  bom: boolean
}

/** One chapter as the analysis found it: prose only, title excluded from `body`. */
export interface ImportChapter {
  title: string
  /** LF, blank lines between paragraphs, no leading/trailing blank line. */
  body: string
  /** 1-based line number of the title line; 0 for the preface. */
  startLine: number
  paragraphs: number
  chars: number
  /** True for the text before the first recognised title. */
  preface?: true
}

/** The whole reading of one source file: what the preview shows and apply consumes. */
export interface ImportAnalysis {
  encoding: ImportEncoding
  sniff: string
  eol: ImportEol
  bom: boolean
  /** `false` = no title shape matched: the file is one chapter. */
  chaptering: boolean
  pattern: ImportPattern
  chapters: ImportChapter[]
  totals: { chapters: number; paragraphs: number; chars: number; lines: number }
  warnings: string[]
}

function startsWithBytes(bytes: Buffer, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[index] !== prefix[index]) return false
  }
  return true
}

/**
 * The terminator the file actually uses, from its **first** newline.
 *
 * The same rule `text-style.ts` applies to a chapter file (`detectTextStyle`): a file
 * with mixed endings has no single right answer, and "mostly CRLF" is not a fact this
 * report can prove cheaply. A lone `\r` with no `\n` at all (classic Mac) counts as
 * CRLF because it is definitely not the LF this project writes.
 */
function detectEol(raw: string): ImportEol {
  const newline = raw.indexOf('\n')
  if (newline > 0 && raw[newline - 1] === '\r') return 'crlf'
  if (newline === -1 && raw.includes('\r')) return 'crlf'
  return 'lf'
}

function normalizeNewlines(raw: string): string {
  return raw.replace(/\r\n?/gu, '\n')
}

/** Decode the bytes with the ordered tiers; never throws on a user file. */
export function decodeImportBytes(bytes: Buffer): ImportDecoded {
  if (bytes.length === 0) {
    return { text: '', encoding: 'utf8', sniff: '空文件（0 字节），按 UTF-8 处理', eol: 'lf', bom: false }
  }

  const finish = (raw: string, encoding: ImportEncoding, sniff: string, bom: boolean): ImportDecoded => {
    // A decoded U+FEFF at the very start is a BOM the tier above did not claim (a
    // decoder that keeps it); strip it here so no reader ever sees one (H11).
    const text = normalizeNewlines(raw.startsWith('\uFEFF') ? raw.slice(1) : raw)
    return { text, encoding, sniff, eol: detectEol(raw), bom: bom || raw.startsWith('\uFEFF') }
  }

  if (startsWithBytes(bytes, [0xef, 0xbb, 0xbf])) {
    const raw = new TextDecoder('utf-8').decode(bytes.subarray(3))
    return finish(raw, 'utf8-bom', 'UTF-8（文件带 BOM，已剥离）', true)
  }
  if (startsWithBytes(bytes, [0xff, 0xfe])) {
    const raw = new TextDecoder('utf-16le').decode(bytes.subarray(2))
    return finish(raw, 'utf16le-bom', 'UTF-16LE（BOM 声明，已剥离）', true)
  }
  if (startsWithBytes(bytes, [0xfe, 0xff])) {
    const raw = new TextDecoder('utf-16be').decode(bytes.subarray(2))
    return finish(raw, 'utf16be-bom', 'UTF-16BE（BOM 声明，已剥离）', true)
  }

  try {
    // `fatal: true` is the whole discriminator: it accepts exactly the byte
    // sequences UTF-8 defines, and throws on everything else.
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return finish(raw, 'utf8', 'UTF-8（严格校验通过，无 BOM）', false)
  } catch {
    // Not UTF-8. GBK is the next tier, and the only one left — a GBK manuscript
    // written on a Chinese Windows (which is what the issue describes).
    try {
      const raw = new TextDecoder('gbk', { fatal: true }).decode(bytes)
      return finish(raw, 'gbk', "GBK（UTF-8 严格校验失败，回落 TextDecoder('gbk')）", false)
    } catch {
      // Neither table can claim every byte. Non-fatal GBK keeps the readable part
      // and marks the rest U+FFFD rather than dropping the file; the report says so.
      const raw = new TextDecoder('gbk').decode(bytes)
      return finish(raw, 'gbk', "GBK（UTF-8 与严格 GBK 都失败，按 TextDecoder('gbk') 容错解码，可能有乱码字符）", false)
    }
  }
}

/** The explicit title shapes, in the order they are tried. */
const TITLE_SHAPES: ReadonlyArray<{ pattern: Exclude<ImportPattern, 'none' | 'short-line'>; test: RegExp }> = [
  // 第一章 / 第 12 章 / 第１章 / 第三回 / 第二节 / 第五篇 / 第两卷
  { pattern: 'numbered', test: /^第\s*[0-9０-９零〇一二三四五六七八九十百千两]+\s*[章回节篇卷折]/u },
  // Chapter 1 / CHAPTER XII / Prologue / Epilogue / Part Two
  { pattern: 'english', test: /^(?:chapter|chap\.|prologue|epilogue|part)\b/iu },
  // 一、 / 三． — a Chinese numeral marker at the line start
  { pattern: 'cn-marker', test: /^[零〇一二三四五六七八九十百]+\s*[、.．]/u },
]

function isBlank(line: string): boolean {
  return line.trim() === ''
}

/** A candidate explicit title: bounded length and not a sentence. */
function explicitTitle(line: string): ImportPattern | undefined {
  const trimmed = line.trim()
  if (trimmed === '' || [...trimmed].length > TITLE_MAX_CHARS) return undefined
  if (/[。；]$/u.test(trimmed)) return undefined
  for (const shape of TITLE_SHAPES) {
    if (shape.test.test(trimmed)) return shape.pattern
  }
  return undefined
}

/**
 * The fallback tier: a short line standing alone between blank lines.
 *
 * "Standing alone" is what makes this safe enough to try at all — the previous and
 * next lines must both be blank (or the file boundary), and the line must carry no
 * sentence punctuation.
 */
function shortStandaloneTitle(lines: readonly string[], index: number): boolean {
  const trimmed = lines[index]?.trim() ?? ''
  if (trimmed === '') return false
  if ([...trimmed].length > SHORT_TITLE_MAX_CHARS) return false
  if (SENTENCE_PUNCTUATION.test(trimmed)) return false
  if (/^[0-9０-９]+$/u.test(trimmed)) return false
  const before = index === 0 ? '' : (lines[index - 1] ?? '')
  const after = index === lines.length - 1 ? '' : (lines[index + 1] ?? '')
  return isBlank(before) && isBlank(after)
}

function bodyOf(lines: readonly string[], from: number, to: number): string {
  let start = from
  let end = to
  while (start < end && isBlank(lines[start] ?? '')) start += 1
  while (end > start && isBlank(lines[end - 1] ?? '')) end -= 1
  return lines.slice(start, end).join('\n')
}

function countsOf(body: string): { paragraphs: number; chars: number } {
  const paragraphs = body.split(/\n[ \t\u3000]*\n/u).filter((block) => block.trim() !== '').length
  return { paragraphs, chars: countChars(body) }
}

/**
 * Where the titles are, plus the tier that found them.
 *
 * THREE STRENGTHS, and why the thresholds differ:
 *   * `第N章` / `Chapter N` / `Prologue` are unambiguous — a single one is a real
 *     chapter boundary (a one-chapter manuscript, or a preface followed by 第一章).
 *   * `一、` is also how an outline item or a numbered paragraph starts, and a short
 *     standalone line is how plenty of ordinary prose looks. For those two, one
 *     match is a coincidence and two are a structure.
 *   * A strong shape wins over the weak ones: a file with `第一章` lines and `一、`
 *     lines is a book of chapters whose sections are numbered, not a book of
 *     one-line chapters.
 */
function findTitles(lines: readonly string[]): { indexes: number[]; pattern: ImportPattern } {
  const strong: number[] = []
  let strongPattern: ImportPattern = 'none'
  const weak: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const shape = explicitTitle(lines[index] ?? '')
    if (shape === undefined) continue
    if (shape === 'cn-marker') {
      weak.push(index)
      continue
    }
    strong.push(index)
    if (strongPattern === 'none') strongPattern = shape
  }
  if (strong.length >= 1) return { indexes: strong, pattern: strongPattern }
  if (weak.length >= 2) return { indexes: weak, pattern: 'cn-marker' }

  const fallback: number[] = []
  for (let index = 0; index < lines.length; index += 1) {
    if (shortStandaloneTitle(lines, index)) fallback.push(index)
  }
  if (fallback.length >= 2) return { indexes: fallback, pattern: 'short-line' }
  return { indexes: [], pattern: 'none' }
}

/**
 * Split an already-decoded text into chapters.
 *
 * `fallbackTitle` names the single chapter of a file with no recognisable titles
 * (the caller passes the file's base name; the default is for callers without one).
 */
export function splitImportChapters(
  text: string,
  fallbackTitle = '全文',
): { chapters: ImportChapter[]; chaptering: boolean; pattern: ImportPattern; warnings: string[] } {
  const lines = text.split('\n')
  // A trailing newline produces one empty last line; it is not a line of the file.
  if (lines.length > 1 && (lines[lines.length - 1] ?? '') === '') lines.pop()

  const found = findTitles(lines)
  const warnings: string[] = []
  const chapters: ImportChapter[] = []

  const push = (title: string, from: number, to: number, startLine: number, preface: boolean): void => {
    const body = bodyOf(lines, from, to)
    if (body.trim() === '') return
    const counts = countsOf(body)
    chapters.push({ title, body, startLine, ...counts, ...(preface ? { preface: true as const } : {}) })
  }

  if (found.indexes.length === 0) {
    push(fallbackTitle, 0, lines.length, 0, false)
    warnings.push(
      '未识别到分章：整篇作为一个章节导入，正文未做任何切分。' +
        '想按章导入，就让原稿里每章有一行独立标题（「第N章 …」「第N回 …」「Chapter N …」「一、…」），前后各空一行。',
    )
    return { chapters, chaptering: false, pattern: 'none', warnings }
  }

  const first = found.indexes[0] ?? 0
  if (bodyOf(lines, 0, first).trim() !== '') {
    push('前言', 0, first, 0, true)
    warnings.push('第一个标题之前还有正文，已作为「前言」章保留（没有丢段落）。')
  }
  for (let position = 0; position < found.indexes.length; position += 1) {
    const index = found.indexes[position] ?? 0
    const next = found.indexes[position + 1] ?? lines.length
    const title = (lines[index] ?? '').trim()
    if (bodyOf(lines, index + 1, next).trim() === '') {
      warnings.push(`第 ${String(index + 1)} 行的标题「${title}」后面没有正文，已跳过（不会建空章）。`)
      continue
    }
    push(title, index + 1, next, index + 1, false)
  }
  if (found.pattern === 'short-line') {
    warnings.push('分章用的是「短行独占」这一档：每个独立成行的短句都被当成章标题，请核对预览里的章标题。')
  }
  return { chapters, chaptering: true, pattern: found.pattern, warnings }
}

/** Decode + count in one call: what the tool, the route and the tests all use. */
export function analyzeImportBytes(bytes: Buffer, options: { fallbackTitle?: string } = {}): ImportAnalysis {
  const decoded = decodeImportBytes(bytes)
  const split = splitImportChapters(decoded.text, options.fallbackTitle ?? '全文')
  const paragraphs = split.chapters.reduce((sum, chapter) => sum + chapter.paragraphs, 0)
  const chars = split.chapters.reduce((sum, chapter) => sum + chapter.chars, 0)
  return {
    encoding: decoded.encoding,
    sniff: decoded.sniff,
    eol: decoded.eol,
    bom: decoded.bom,
    chaptering: split.chaptering,
    pattern: split.pattern,
    chapters: split.chapters,
    totals: { chapters: split.chapters.length, paragraphs, chars, lines: decoded.text.split('\n').length },
    warnings: split.warnings,
  }
}
