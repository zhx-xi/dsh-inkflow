/**
 * Issue #89 — GBK mojibake detection (pure functions, `src/host/encoding.ts`).
 *
 * The field evidence: a hand-written `inkflow.json` whose `title` reads
 * `浜哄湪铚€灞憋紝鏄帉闂?` — UTF-8 bytes read back as GBK. The plugin never writes
 * that, but it must recognise it, because "written, then reported invalid" is a
 * silent failure the author cannot act on.
 *
 * THE BAR IS PRECISION, NOT RECALL: a false positive nags every ordinary Chinese
 * title, so the negatives below are the real contract. A miss only means the
 * author sees a garbled title without an explanation — annoying, not wrong.
 *
 * The signature table in the implementation was derived, not invented: see
 * `.tmp/gbk-*.mjs` analysis in the issue thread (corpus → GBK misread → keep the
 * artifacts that never occur in genuine Chinese → group by artifact byte class).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { MIN_NON_ASCII_RATIO, MIN_SIGNATURE_FEATURES, describeEncodingSuspicion, looksLikeGbkMojibake } from '../lib/index.js'

/** The exact title from the issue's field report (`?` is the decoder's loss). */
const FIELD_TITLE = '浜哄湪铚€灞憋紝鏄帉闂?'

/** `人在蜀山，我是掌门` re-read as GBK: the pristine shape of the same accident. */
const REBUILT_TITLE = '浜哄湪铚€灞憋紝鎴戞槸鎺岄棬'

test('encoding: the field title from issue #89 is suspicious', () => {
  assert.equal(looksLikeGbkMojibake(FIELD_TITLE), true)
  const verdict = describeEncodingSuspicion(FIELD_TITLE)
  assert.equal(verdict.suspicious, true)
  assert.ok(verdict.hits.length >= MIN_SIGNATURE_FEATURES, `hits: ${verdict.hits.join(', ')}`)
  assert.ok(verdict.hits.includes('lead-e4'), 'the E4 artifact (人) is the loudest tell')
})

test('encoding: a reconstructed GBK misread of a real title is suspicious', () => {
  // Produced with `new TextDecoder('gbk').decode(Buffer.from('人在蜀山，我是掌门', 'utf8'))`,
  // i.e. exactly what PowerShell 5's default ANSI encoding does on this machine.
  assert.equal(looksLikeGbkMojibake(REBUILT_TITLE), true)
  const verdict = describeEncodingSuspicion(REBUILT_TITLE)
  assert.ok(verdict.hits.length >= 3, `a whole garbled title trips several groups: ${verdict.hits.join(', ')}`)
})

test('encoding: genuine Chinese, Japanese, emoji and English titles are never flagged', () => {
  const genuine = [
    '人在蜀山，我是掌门',
    '测试之书',
    '蜀山剑侠传',
    '長安十二時辰',
    '雨夜',
    'テスト小説',
    '東京物語',
    '蜀山 🚀 掌门',
    'His Dark Materials',
    'The Long Night',
  ]
  for (const title of genuine) {
    assert.equal(looksLikeGbkMojibake(title), false, `must not flag a genuine title: ${title}`)
    assert.deepEqual(describeEncodingSuspicion(title), { suspicious: false, hits: [] }, title)
  }
})

test('encoding: rare but legitimate prose characters are not tells', () => {
  // Every one of these is a real character an author may put in a book or a name
  // (`绮罗`, `濮阳` the place, `寰宇`, `娓娓道来`, `河浜` the creek). The table is
  // generated from frequency, so this list is the guard that keeps it honest.
  const literary = ['绮璇', '娴婧', '骞濮', '濮阳', '寰宇', '娓娓道来', '妖娆', '缥缈', '绫罗', '绯红', '北门之外', '凡尘', '哄堂大笑', '涓流', '河浜']
  for (const title of literary) {
    assert.equal(looksLikeGbkMojibake(title), false, `must not flag: ${title}`)
  }
})

test('encoding: one artifact class alone is not suspicious', () => {
  // `鏂`/`鏉` are both E6 artifacts: dense, but a single class. Genuine prose can
  // contain one such character by accident; two classes at once is the accident.
  assert.equal(describeEncodingSuspicion('鏂鏂鏉').suspicious, false)
  const verdict = describeEncodingSuspicion('鏂鏂鏉')
  assert.equal(verdict.hits.length, 1)
})

test('encoding: the non-ASCII ratio threshold is 30%', () => {
  // Three E5/E6 artifacts among ten non-ASCII characters: exactly at the bar.
  const atBar = '鍦鍦鏂天地玄黄宇宙洪'
  const below = '鍦鏂天地玄黄宇宙洪荒'
  assert.equal(MIN_NON_ASCII_RATIO, 0.3)
  assert.equal(Array.from(atBar).filter((char) => char.codePointAt(0) > 0x7f).length, 10)
  assert.equal(looksLikeGbkMojibake(atBar), true, '3 hits / 10 non-ASCII is exactly 30%')
  assert.equal(looksLikeGbkMojibake(below), false, '2 hits / 10 non-ASCII stays under the bar')
})

test('encoding: empty, ASCII-only and whitespace text is not suspicious', () => {
  for (const text of ['', '   ', 'shushan', 'INKFLOW.json', '?????????']) {
    assert.deepEqual(describeEncodingSuspicion(text), { suspicious: false, hits: [] }, JSON.stringify(text))
    assert.equal(looksLikeGbkMojibake(text), false)
  }
})

test('encoding: hits are distinct groups, not a character count', () => {
  const verdict = describeEncodingSuspicion(REBUILT_TITLE)
  assert.equal(new Set(verdict.hits).size, verdict.hits.length, 'each group is reported once')
  for (const hit of verdict.hits) assert.equal(typeof hit, 'string')
})
