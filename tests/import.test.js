/**
 * The analysis half of the import path (roadmap X-17).
 *
 * What must FAIL when this is wired wrong:
 *   1. an encoding tier is picked wrongly — a GBK manuscript decoded as UTF-8, a
 *      BOM left inside the first line, UTF-16 read as one-character-per-byte —
 *      every one of those corrupts the prose silently;
 *   2. the original line-ending style is not remembered (the report has to say
 *      "this came in as CRLF" even though the chapter file lands as LF);
 *   3. chapter splitting loses or merges prose: a paragraph dropped, a title line
 *      left inside the body, two chapters folded into one;
 *   4. the 59-万字 acceptance case loses a paragraph or a character.
 *
 * The samples are built from Buffers here, not read from fixtures: the point of
 * each one is exact bytes (BOM bytes, GBK byte pairs, CRLF), and a checked-in
 * file would be re-saved by an editor sooner or later.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { MAX_IMPORT_BYTES, analyzeImportBytes, decodeImportBytes } from '../lib/index.js'

/** Non-whitespace characters, the same rule `countChars` applies in the Host. */
function charsOf(text) {
  return [...text.replace(/\s+/gu, '')].length
}

/** Split a body into paragraphs the way the analyser does: blank line = separator. */
function paragraphsOf(body) {
  return body
    .split(/\n[ \t\u3000]*\n/u)
    .map((block) => block.trim())
    .filter((block) => block !== '')
}

/** A UTF-8 BOM in front of UTF-8 bytes. */
function withUtf8Bom(bytes) {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])
}

/** UTF-16LE bytes with the FF FE BOM, the way Windows editors write them. */
function utf16le(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')])
}

/** UTF-16BE with the FE FF BOM: byte-swapped, no Node encoder for it. */
function utf16be(text) {
  const le = Buffer.from(text, 'utf16le')
  const be = Buffer.alloc(le.length)
  for (let index = 0; index + 1 < le.length; index += 2) {
    be[index] = le[index + 1]
    be[index + 1] = le[index]
  }
  return Buffer.concat([Buffer.from([0xfe, 0xff]), be])
}

/**
 * GBK bytes for a two-chapter sample, produced by
 * `[System.Text.Encoding]::GetEncoding(936).GetBytes(...)` on Windows and
 * pasted here as hex — Node has no GBK *encoder*, only the decoder.
 *
 * Decodes to (CRLF line endings, 全角 spaces included):
 *   第一章 入山 / 山中无岁月，风起了。 / 他说：「走。」 / 第二章 出山 / 　　剑光一闪。
 */
const GBK_SAMPLE_HEX =
  'b5dad2bbd5c220c8ebc9bd0d0a0d0ac9bdd6d0cedecbead4c2a3acb7e7c6f0c1cba1a30d0a0d0acbfbcbb5a3baa1b8d7dfa1a3a1b9' +
  '0d0a0d0ab5dab6fed5c220b3f6c9bd0d0a0d0aa1a1a1a1bda3b9e2d2bbc9c1a1a3'

// ---------------------------------------------------------------------------
// Encoding tiers: UTF-8 (strict) → UTF-16 BOM → GBK
// ---------------------------------------------------------------------------

test('UTF-8 without BOM is the first tier: LF kept, nothing stripped', () => {
  const text = '第一章 入山\n\n山中无岁月。\n\n第二章 出山\n\n风起了。\n'
  const decoded = decodeImportBytes(Buffer.from(text, 'utf8'))
  assert.equal(decoded.encoding, 'utf8')
  assert.equal(decoded.bom, false)
  assert.equal(decoded.eol, 'lf')
  assert.equal(decoded.text, text)
  assert.match(decoded.sniff, /utf-8/iu)
})

test('a UTF-8 BOM is stripped and reported, never left in the first title', () => {
  const decoded = decodeImportBytes(withUtf8Bom(Buffer.from('第一章 入山\n\n正文。\n', 'utf8')))
  assert.equal(decoded.encoding, 'utf8-bom')
  assert.equal(decoded.bom, true)
  assert.equal(decoded.text.startsWith('第一章'), true, 'the BOM must not survive into the text')
  assert.equal(decoded.text.includes('\uFEFF'), false)
})

test('UTF-16LE and UTF-16BE are read through the BOM, not guessed', () => {
  const body = '第一章 入山\n\n山中无岁月。\n'
  const le = decodeImportBytes(utf16le(body))
  assert.equal(le.encoding, 'utf16le-bom')
  assert.equal(le.text, body)

  const be = decodeImportBytes(utf16be(body))
  assert.equal(be.encoding, 'utf16be-bom')
  assert.equal(be.text, body)
})

test('a GBK manuscript (Chinese punctuation included) falls back to TextDecoder(gbk)', () => {
  const decoded = decodeImportBytes(Buffer.from(GBK_SAMPLE_HEX, 'hex'))
  assert.equal(decoded.encoding, 'gbk')
  assert.equal(decoded.bom, false)
  // The two things a wrong tier destroys: the ideographic punctuation and the
  // quotation marks. Both are GBK double-byte pairs.
  assert.equal(decoded.text.includes('山中无岁月，风起了。'), true)
  assert.equal(decoded.text.includes('他说：「走。」'), true)
  // CRLF came in and is reported; the text is normalised to LF for analysis.
  assert.equal(decoded.eol, 'crlf')
  assert.equal(decoded.text.includes('\r'), false)
})

test('CRLF is remembered even though the analysed text is LF', () => {
  const decoded = decodeImportBytes(Buffer.from('第一章 入山\r\n\r\n正文一。\r\n\r\n正文二。\r\n', 'utf8'))
  assert.equal(decoded.eol, 'crlf')
  assert.equal(decoded.text, '第一章 入山\n\n正文一。\n\n正文二。\n')
})

test('an empty file decodes to nothing instead of throwing', () => {
  const decoded = decodeImportBytes(Buffer.alloc(0))
  assert.equal(decoded.text, '')
  assert.equal(decoded.encoding, 'utf8')
})

// ---------------------------------------------------------------------------
// Chapter splitting
// ---------------------------------------------------------------------------

test('第N章 / 第N回 / Chapter N are all recognised as titles', () => {
  const text = ['第一章 入山', '', '甲。', '', '第二回 出山', '', '乙。', '', 'Chapter 3 The Road', '', '丙。'].join('\n')
  const analysis = analyzeImportBytes(Buffer.from(text, 'utf8'))
  assert.equal(analysis.chaptering, true)
  assert.equal(analysis.chapters.length, 3)
  assert.deepEqual(
    analysis.chapters.map((chapter) => chapter.title),
    ['第一章 入山', '第二回 出山', 'Chapter 3 The Road'],
  )
  // The title line is not part of the body: a title inside prose would be a
  // duplicated heading in every chapter the import writes.
  assert.deepEqual(
    analysis.chapters.map((chapter) => chapter.body),
    ['甲。', '乙。', '丙。'],
  )
  assert.deepEqual(
    analysis.chapters.map((chapter) => chapter.startLine),
    [1, 5, 9],
  )
})

test('一、二、 sections split a file that has no 第N章 marker', () => {
  const analysis = analyzeImportBytes(Buffer.from('一、入山\n\n甲。\n\n二、出山\n\n乙。\n', 'utf8'))
  assert.equal(analysis.chaptering, true)
  assert.equal(analysis.pattern, 'cn-marker')
  assert.deepEqual(
    analysis.chapters.map((chapter) => chapter.title),
    ['一、入山', '二、出山'],
  )
})

test('第N章 wins over 一、 when both appear: chapters first, sections second', () => {
  // The precedence is the rule, not an accident: a book of 第一章 whose sections are
  // 一、二、 must split on the chapters. One 一、 marker alone is not enough evidence
  // to split at all (a numbered paragraph looks the same).
  const analysis = analyzeImportBytes(
    Buffer.from('第一章 入山\n\n一、甲。\n\n二、乙。\n\n第二章 出山\n\n丙。\n', 'utf8'),
  )
  assert.equal(analysis.chapters.length, 2)
  assert.deepEqual(
    analysis.chapters.map((chapter) => chapter.title),
    ['第一章 入山', '第二章 出山'],
  )
  assert.equal(analysis.chapters[0].body.includes('二、乙。'), true, 'sections stay inside their chapter')
})

test('prose with no title line becomes ONE chapter and says so', () => {
  const text = '第一段。\n\n第二段。\n\n第三段。\n'
  const analysis = analyzeImportBytes(Buffer.from(text, 'utf8'))
  assert.equal(analysis.chaptering, false)
  assert.equal(analysis.pattern, 'none')
  assert.equal(analysis.chapters.length, 1)
  assert.equal(analysis.chapters[0].paragraphs, 3)
  assert.equal(analysis.chapters[0].chars, charsOf('第一段。第二段。第三段。'))
  // "No chapter found" is a report, not a silent single chapter: the caller has
  // to be able to tell the author that nothing was split.
  assert.equal(analysis.warnings.some((line) => line.includes('未识别到分章')), true)
})

test('content before the first title is kept as a preface chapter, not dropped', () => {
  const text = '楔子内容。\n\n第一章 入山\n\n正文。\n'
  const analysis = analyzeImportBytes(Buffer.from(text, 'utf8'))
  assert.equal(analysis.chapters.length, 2)
  assert.equal(analysis.chapters[0].preface, true)
  assert.equal(analysis.chapters[0].body, '楔子内容。')
  assert.equal(analysis.chapters[1].title, '第一章 入山')
  assert.equal(analysis.chapters[1].body, '正文。')
})

test('a short standalone line is only a title when nothing else matched', () => {
  // Two title-ish lines with no 第N章 marker: the fallback tier splits here.
  const fallback = analyzeImportBytes(Buffer.from('入山\n\n甲。\n\n出山\n\n乙。\n', 'utf8'))
  assert.equal(fallback.chaptering, true)
  assert.equal(fallback.pattern, 'short-line')
  assert.deepEqual(
    fallback.chapters.map((chapter) => chapter.title),
    ['入山', '出山'],
  )

  // A single short line in ordinary prose is punctuation-free too — one match is
  // not enough evidence, so the file stays one chapter.
  const prose = analyzeImportBytes(Buffer.from('这一夜很静\n\n他睡着了。\n\n天亮了。\n', 'utf8'))
  assert.equal(prose.chaptering, false)
  assert.equal(prose.chapters.length, 1)
})

test('a paragraph is never merged across a blank line, and 全角 spaces do not split one', () => {
  const text = '第一章 入山\n\n　　第一段。\n\n　　第二段。\n　　还是第二段。\n'
  const analysis = analyzeImportBytes(Buffer.from(text, 'utf8'))
  assert.equal(analysis.chapters[0].paragraphs, 2)
  assert.equal(analysis.chapters[0].body.includes('还是第二段。'), true)
})

test('the same bytes analysed twice give the same result', () => {
  const bytes = Buffer.from(GBK_SAMPLE_HEX, 'hex')
  assert.deepEqual(analyzeImportBytes(bytes), analyzeImportBytes(bytes))
})

// ---------------------------------------------------------------------------
// The 59-万字 acceptance case
// ---------------------------------------------------------------------------

/** 200 chapters × 15 paragraphs × 200 characters ≈ 60 万字, with CRLF and a BOM. */
function syntheticBook({ chapters = 200, paragraphs = 15, charsPerParagraph = 200 } = {}) {
  const lines = []
  const expected = { chapters, paragraphs: chapters * paragraphs, chars: chapters * paragraphs * charsPerParagraph }
  for (let chapter = 1; chapter <= chapters; chapter += 1) {
    lines.push(`第${chapter}章 章名${chapter}`)
    lines.push('')
    for (let paragraph = 1; paragraph <= paragraphs; paragraph += 1) {
      const unit = `第${chapter}章第${paragraph}段`
      const padding = '文'.repeat(Math.max(0, charsPerParagraph - unit.length))
      lines.push(`　　${unit}${padding}`)
      lines.push('')
    }
  }
  return { text: lines.join('\r\n'), expected }
}

test('a 60万字 book imports without losing a paragraph or a character', (t) => {
  const { text, expected } = syntheticBook()
  const bytes = withUtf8Bom(Buffer.from(text, 'utf8'))
  assert.equal(bytes.byteLength < MAX_IMPORT_BYTES, true, 'the acceptance case must fit under the size cap')

  const startedAt = process.hrtime.bigint()
  const analysis = analyzeImportBytes(bytes)
  const ms = Number(process.hrtime.bigint() - startedAt) / 1e6

  assert.equal(analysis.chapters.length, expected.chapters, 'chapter count')
  assert.equal(analysis.totals.paragraphs, expected.paragraphs, 'paragraph count')
  assert.equal(analysis.totals.chars, expected.chars, 'character count (error must be 0)')
  assert.equal(analysis.encoding, 'utf8-bom')
  assert.equal(analysis.eol, 'crlf')
  // Per-chapter totals have to add up to the book total, or the report lies about
  // one of the two.
  assert.equal(
    analysis.chapters.reduce((sum, chapter) => sum + chapter.chars, 0),
    expected.chars,
  )
  assert.equal(
    analysis.chapters.reduce((sum, chapter) => sum + chapter.paragraphs, 0),
    expected.paragraphs,
  )
  assert.equal(
    analysis.chapters.every((chapter) => chapter.body.startsWith('　　第')),
    true,
  )

  t.diagnostic(
    `${expected.chapters} 章 / ${expected.paragraphs} 段 / ${expected.chars} 字（${bytes.byteLength} 字节）：${ms.toFixed(1)} ms`,
  )
})

test('every recognised chapter keeps its own paragraph and character counts', () => {
  const analysis = analyzeImportBytes(Buffer.from(GBK_SAMPLE_HEX, 'hex'))
  assert.equal(analysis.chapters.length, 2)
  assert.deepEqual(
    analysis.chapters.map((chapter) => [chapter.paragraphs, chapter.chars]),
    [
      [2, charsOf('山中无岁月，风起了。他说：「走。」')],
      [1, charsOf('剑光一闪。')],
    ],
  )
  assert.equal(analysis.totals.chars, analysis.chapters.reduce((sum, chapter) => sum + chapter.chars, 0))
  assert.deepEqual(paragraphsOf(analysis.chapters[0].body), ['山中无岁月，风起了。', '他说：「走。」'])
})
