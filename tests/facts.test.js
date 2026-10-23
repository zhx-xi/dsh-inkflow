/**
 * Issue #32 — the fact ledger: the line format (ADR-0013), the interval rule (I-23), the
 * "which facts hold at chapter N" snapshot, and the writing-context segment.
 *
 * Why each group exists:
 *
 *   - **round-trip**: `parseFactLine` / `renderFactLine` are a pair or they are a bug
 *     source. A writer that escapes differently from the reader's unescaper corrupts the
 *     ledger the next time anything reads it, and nothing else in the suite would notice.
 *   - **D3-2 (50 章 / 20 处冲突)**: the acceptance criterion of the issue, run as a real
 *     synthetic book rather than as three hand-written rows. It prints the detected and
 *     missed counts, and it pins "no false positive" too — a detector that reported twenty
 *     conflicts *plus* ten phantom ones would satisfy "≥18" and still be useless.
 *   - **snapshot**: two requirements at once. It must answer "as of chapter N" by **chapter
 *     order** (string order puts `ch-10` before `ch-2`), and two identical runs must produce
 *     byte-identical output, or the injected context changes when nothing changed.
 *   - **the fifth segment**: the prompt is the reason the ledger exists. The assertion is on
 *     the rendered block, not on the builder alone.
 *   - **the write gate**: I-23 says "拒" (X-4's double insurance). The refusal is asserted
 *     with a whole-tree hash, so "refused" means zero bytes and zero timestamps changed.
 *
 * Every suite runs against the BUILT artifacts (`lib/index.js`), like every other test here.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  EXTRA_SEGMENTS,
  buildIndex,
  buildWritingContext,
  domainTools,
  factsConflicts,
  factsSnapshot,
  parseFactLine,
  parseFactsFile,
  renderFactLine,
  searchEntities,
} from '../lib/index.js'
import { hashTree } from './hash-tree.mjs'

const DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-facts-'))
}

function scaffold(root, title = '账本测试') {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.gitignore'), 'index/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
}

function writeFile(root, relativePath, text) {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, text, 'utf8')
}

/** `count` chapters with ids `ch-1 … ch-N` and `seq: 1 … N` (the ids are deliberately not padded). */
function writeChapters(root, count) {
  for (let seq = 1; seq <= count; seq += 1) {
    const id = `ch-${String(seq)}`
    writeFile(
      root,
      `chapters/vol-01/${String(seq).padStart(4, '0')}-${id}.md`,
      `---\nid: ${id}\ntitle: 第 ${String(seq)} 章\nseq: ${String(seq)}\n---\n\n正文 ${String(seq)}。\n`,
    )
  }
}

/** One ledger file: `lines` are `FactLine` objects (rendered) or raw strings. */
function writeLedger(root, slug, subject, lines, extraFrontmatter = []) {
  const body = lines.map((line) => (typeof line === 'string' ? line : renderFactLine(line))).join('\n')
  const extra = extraFrontmatter.map((line) => `${line}\n`).join('')
  writeFile(root, `facts/${slug}.md`, `---\nsubject: ${subject}\n${extra}---\n\n${body}\n`)
}

function callTool(name, args) {
  const tool = domainTools().find((candidate) => candidate.name === name)
  assert.ok(tool, `${name} must be registered by a domain module`)
  return tool.execute(args, { signal: new AbortController().signal, callId: 'facts-test' })
}

function indexIssues(root) {
  const db = new DatabaseSync(join(root, 'index', 'inkflow.db'), { readOnly: true })
  try {
    return db.prepare('SELECT code, path, detail FROM validation_issues ORDER BY seq').all()
  } finally {
    db.close()
  }
}

/** Fact-ledger findings only: a fixture book has no outline, so the rebuild reports that too. */
function factIssues(root) {
  return indexIssues(root).filter((issue) => String(issue.code).startsWith('FACT_'))
}

/** The order the assertion compares in: plain code-unit order on both sides. */
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

// ---------------------------------------------------------------------------
// 1. The line format, as a pair (ADR-0013)
// ---------------------------------------------------------------------------

test('facts: a plain line parses to the declared shape and renders back unchanged', () => {
  const parsed = parseFactLine('- attribute: 境界 | value: 筑基后期 | since: ch-0007 | chapterId: ch-0009 | source: text')
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.fact, {
    attribute: '境界',
    value: '筑基后期',
    since: 'ch-0007',
    chapterId: 'ch-0009',
    source: 'text',
    extra: {},
  })
  // No `until` at all: the fact still holds (ADR-0013 rule 2).
  assert.equal(parsed.fact.until, undefined)
  assert.equal(
    renderFactLine(parsed.fact),
    '- attribute: 境界 | value: 筑基后期 | since: ch-0007 | chapterId: ch-0009 | source: text',
  )
})

test('facts: round-trip holds for the escape, the unknown key and the empty until', () => {
  const roundTrip = (line) => {
    const first = parseFactLine(line)
    assert.equal(first.ok, true, `"${line}" must parse`)
    const rendered = renderFactLine(first.fact)
    const second = parseFactLine(rendered)
    assert.equal(second.ok, true, `the rendering "${rendered}" must parse back`)
    // The criterion: 解析 → 渲染 → 再解析 is structurally identical.
    assert.deepEqual(second.fact, first.fact)
    assert.equal(renderFactLine(second.fact), rendered, 'rendering is idempotent')
    return { rendered, fact: first.fact }
  }

  // 1) A literal `|` inside the value: escaped on write, unescaped on read.
  const pipeFact = { attribute: '持有物', value: '青锋剑|断', since: 'ch-0012', source: 'manual', extra: {} }
  const renderedPipe = renderFactLine(pipeFact)
  assert.ok(renderedPipe.includes('青锋剑\\|断'), 'a literal pipe is written escaped')
  assert.deepEqual(parseFactLine(renderedPipe).fact, pipeFact)
  // ... and the escaped form survives a second trip.
  assert.equal(renderFactLine(parseFactLine(renderedPipe).fact), renderedPipe)
  // An unescaped pipe is a separator, never a guess (ADR-0013 rule 3): here it leaves a
  // segment that is not `key: value`, so the line is refused rather than half-read.
  assert.equal(parseFactLine('- attribute: 持有物 | value: 青锋剑 | 断 | since: ch-0012').ok, false)

  // 2) Unknown keys survive: kept, not rejected, and rendered after the known ones.
  const unknown = roundTrip('- attribute: 境界 | value: 金丹 | since: ch-0042 | 置信度: 高 | source: extract')
  assert.equal(unknown.fact.extra['置信度'], '高')
  assert.ok(unknown.rendered.endsWith('置信度: 高'), 'unknown keys are rendered last')

  // 3) An explicitly empty `until` means "no until" — not a value, not an error.
  const emptyUntil = roundTrip('- attribute: 生死 | value: 存 | since: ch-0001 | until: | chapterId: ch-0001')
  assert.equal(emptyUntil.fact.until, undefined)
  assert.ok(!emptyUntil.rendered.includes('until:'), 'an empty until is dropped, and reads back the same way')
})

test('facts: a line that is not a fact is refused without echoing the author’s text', () => {
  const missingValue = parseFactLine('- attribute: 境界 | since: ch-0001')
  assert.equal(missingValue.ok, false)
  assert.match(missingValue.reason, /value/u)

  const proseLine = parseFactLine('- 这一行被作者写成了散文')
  assert.equal(proseLine.ok, false)
  assert.ok(!proseLine.reason.includes('散文'), 'the reason must not carry the line text')

  assert.equal(parseFactLine('普通段落：attribute: 境界 | value: 金丹').ok, false)
  assert.equal(parseFactLine('-   ').ok, false)
})

test('facts: one ledger file yields rows with 1-based file line anchors, and a bad line blocks nothing', () => {
  const text = [
    '---',
    'subject: char-qingyin',
    'title: 清音',
    '---',
    '',
    '- attribute: 境界 | value: 筑基后期 | since: ch-0007 | chapterId: ch-0009 | source: text',
    '- attribute: 境界 | value: 金丹初期 | since: ch-0042 | chapterId: ch-0045 | source: text',
    '- 作者随手写的一行',
    '- attribute: 持有物 | value: 青锋剑 | since: ch-0012 | until: ch-0061 | source: manual',
    '',
  ].join('\n')

  const parsed = parseFactsFile('facts/char-qingyin.md', text)
  assert.equal(parsed.subject, 'char-qingyin')
  assert.equal(parsed.title, '清音')
  // Lines: 1 `---`, 2 subject, 3 title, 4 `---`, 5 blank, 6/7 facts, 8 the bad line, 9 a fact.
  // The malformed line is a warning with a line anchor; the line after it still parses.
  assert.deepEqual(
    parsed.issues.map((issue) => [issue.code, issue.path]),
    [['FACT_LINE_MALFORMED', 'facts/char-qingyin.md#L8']],
  )
  assert.deepEqual(
    parsed.rows.map((row) => row.line),
    [6, 7, 9],
  )
  assert.equal(parsed.rows[0].id, 'facts/char-qingyin.md#L6')
})

test('facts: a ledger without a `subject` falls back to the file name instead of losing its facts', () => {
  const parsed = parseFactsFile(
    'facts/青锋剑.md',
    '---\ntitle: 青锋剑\n---\n\n- attribute: 持有者 | value: 清音 | since: ch-0012\n',
  )
  assert.equal(parsed.subject, '青锋剑')
  assert.equal(parsed.rows.length, 1)
  assert.equal(parsed.rows[0].subject, '青锋剑')
})

// ---------------------------------------------------------------------------
// 2. D3-2 — 50 chapters, 20 planted conflicts
// ---------------------------------------------------------------------------

/**
 * Plant 20 contradictions in a 50-chapter book, each inside its own `subject` so the
 * expected answer is exactly twenty pairs, and add non-conflicting neighbours (adjacent
 * intervals, and an overlap with the *same* value) that must **not** be reported.
 *
 * Line layout of every ledger (frontmatter is lines 1-3, the blank line is 4):
 *   5: 境界 旧值 [from, from+2)     6: 境界 新值 [from+1, from+3)   ← the planted conflict
 *   7: 境界 新值 [from+3, from+4)   8: 持有物 青锋剑 …  9: 持有物 青锋剑 …  ← not conflicts
 */
function conflictBook(root) {
  scaffold(root, '五十章冲突书')
  writeChapters(root, 50)
  const subjects = []
  for (let index = 0; index < 20; index += 1) {
    const subject = `char-${String(index + 1)}`
    const from = 2 * index + 1
    writeLedger(root, subject, subject, [
      { attribute: '境界', value: `旧值${String(index)}`, since: `ch-${String(from)}`, until: `ch-${String(from + 2)}`, source: 'text', extra: {} },
      { attribute: '境界', value: `新值${String(index)}`, since: `ch-${String(from + 1)}`, until: `ch-${String(from + 3)}`, source: 'text', extra: {} },
      { attribute: '境界', value: `新值${String(index)}`, since: `ch-${String(from + 3)}`, until: `ch-${String(from + 4)}`, source: 'text', extra: {} },
      { attribute: '持有物', value: '青锋剑', since: `ch-${String(from)}`, until: `ch-${String(from + 4)}`, source: 'manual', extra: {} },
      { attribute: '持有物', value: '青锋剑', since: `ch-${String(from + 1)}`, source: 'manual', extra: {} },
    ])
    subjects.push(subject)
  }
  return subjects
}

test('facts D3-2: a 50-chapter book with 20 planted conflicts is detected (≥18, 漏报 ≤2)', async () => {
  const dir = workdir()
  const root = join(dir, 'book')
  try {
    const subjects = conflictBook(root)
    await buildIndex(root)

    const conflicts = factIssues(root).filter((issue) => issue.code === 'FACT_CONFLICT')
    const detected = conflicts.length
    const missed = Math.max(0, subjects.length - detected)
    const falsePositives = Math.max(0, detected - subjects.length)
    console.log(
      `D3-2 · 章节 50 · 预埋冲突 ${String(subjects.length)} · 检出 ${String(detected)} · 漏报 ${String(missed)} · 误报 ${String(falsePositives)}`,
    )

    assert.ok(detected >= 18, `expected at least 18 of the 20 conflicts, got ${String(detected)}`)
    assert.ok(missed <= 2, `expected at most 2 misses, got ${String(missed)}`)

    // Stronger than the DoD: exactly the planted pairs, nothing else.
    assert.equal(detected, 20, `expected exactly 20 conflicts, got ${String(detected)}`)
    assert.equal(falsePositives, 0, 'adjacent intervals and equal-value overlaps are not conflicts')
    // Every finding is anchored on the later-starting line (#L6) and names the earlier one.
    const anchors = conflicts.map((issue) => issue.path).sort(compareText)
    const expectedAnchors = subjects.map((subject) => `facts/${subject}.md#L6`).sort(compareText)
    assert.deepEqual(anchors, expectedAnchors)
    for (const issue of conflicts) assert.match(issue.detail, /#L5|ch-\d+/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('facts I-22: a malformed line is a warning with an anchor and does not hide the rest of the file', async () => {
  const dir = workdir()
  const root = join(dir, 'book')
  try {
    scaffold(root, '坏行账本')
    writeChapters(root, 3)
    writeFile(
      root,
      'facts/char-a.md',
      ['---', 'subject: char-a', '---', '', '- attribute: 境界 | value: 练气 | since: ch-1', '- 这一行不是事实', ''].join('\n'),
    )
    await buildIndex(root)
    assert.deepEqual(
      factIssues(root).map((issue) => [issue.code, issue.path]),
      [['FACT_LINE_MALFORMED', 'facts/char-a.md#L6']],
    )
    const listed = await callTool('inkflow_facts_list', { projectRoot: root })
    assert.equal(listed.facts.length, 1, 'the good line still reaches the tools')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. The snapshot
// ---------------------------------------------------------------------------

test('facts snapshot: chapter order decides "in effect", not the id text', async () => {
  const dir = workdir()
  const root = join(dir, 'book')
  try {
    scaffold(root, '章序书')
    writeChapters(root, 12)
    writeLedger(root, 'char-a', 'char-a', [
      { attribute: '境界', value: '筑基', since: 'ch-2', until: 'ch-10', source: 'text', extra: {} },
      { attribute: '境界', value: '金丹', since: 'ch-10', source: 'text', extra: {} },
      { attribute: '持有物', value: '青锋剑', since: 'ch-1', source: 'text', extra: {} },
    ])
    await buildIndex(root)

    const early = await callTool('inkflow_facts_snapshot', { projectRoot: root, chapterId: 'ch-2' })
    assert.deepEqual(
      early.facts.map((fact) => `${fact.attribute}=${fact.value}`),
      ['境界=筑基', '持有物=青锋剑'],
      'as of ch-2 the realm is still 筑基',
    )
    // The sharp assertion: a naive string comparison would put `ch-10` (>= `ch-2` as text)
    // in effect here, and the writer would be told the wrong realm.
    assert.equal(
      early.facts.some((fact) => fact.value === '金丹'),
      false,
      'a fact starting at ch-10 must not appear at ch-2 even though "ch-10" < "ch-2" as text',
    )

    const later = await callTool('inkflow_facts_snapshot', { projectRoot: root, chapterId: 'ch-10' })
    assert.deepEqual(
      later.facts.map((fact) => `${fact.attribute}=${fact.value}`),
      ['境界=金丹', '持有物=青锋剑'],
      '`until` is exclusive: chapter 10 belongs to the new value',
    )

    const current = await callTool('inkflow_facts_snapshot', { projectRoot: root })
    assert.equal(current.chapterId, 'ch-12', 'no chapterId means the last chapter of the book')
    assert.deepEqual(current.facts.map((fact) => fact.value), ['金丹', '青锋剑'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('facts snapshot: the same input twice produces byte-identical output', async () => {
  const dir = workdir()
  const root = join(dir, 'book')
  try {
    scaffold(root, '可复现书')
    writeChapters(root, 8)
    // Deliberately written out of order, two subjects, mixed attributes.
    writeLedger(root, 'char-b', 'char-b', [
      { attribute: '境界', value: '金丹', since: 'ch-4', extra: {} },
      { attribute: '年龄', value: '三十', since: 'ch-1', extra: {} },
    ])
    writeLedger(root, 'char-a', 'char-a', [
      { attribute: '持有物', value: '青锋剑', since: 'ch-2', extra: {} },
      { attribute: '境界', value: '筑基', since: 'ch-1', until: 'ch-4', extra: {} },
    ])
    await buildIndex(root)

    // A warm-up call so both measured runs report the same index state.
    await callTool('inkflow_facts_snapshot', { projectRoot: root, chapterId: 'ch-6' })
    const first = await callTool('inkflow_facts_snapshot', { projectRoot: root, chapterId: 'ch-6' })
    const second = await callTool('inkflow_facts_snapshot', { projectRoot: root, chapterId: 'ch-6' })
    assert.equal(JSON.stringify(first), JSON.stringify(second))
    assert.deepEqual(
      first.facts.map((fact) => `${fact.subject}/${fact.attribute}`),
      ['char-a/持有物', 'char-b/境界', 'char-b/年龄'],
      'the documented order is subject → attribute → since (attribute order is code-unit order)',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('facts snapshot: an unknown chapter id is refused, not answered with the whole book', async () => {
  const dir = workdir()
  const root = join(dir, 'book')
  try {
    scaffold(root, '未知章书')
    writeChapters(root, 2)
    writeLedger(root, 'char-a', 'char-a', [{ attribute: '境界', value: '筑基', since: 'ch-1', extra: {} }])
    await buildIndex(root)
    const refused = await callTool('inkflow_facts_snapshot', { projectRoot: root, chapterId: 'ch-99' })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'CHAPTER_NOT_FOUND')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('facts list: an unresolvable chapter id is reported, and its interval is not judged', async () => {
  const dir = workdir()
  const root = join(dir, 'book')
  try {
    scaffold(root, '错章号书')
    writeChapters(root, 4)
    writeLedger(root, 'char-a', 'char-a', [
      { attribute: '境界', value: '筑基', since: 'ch-1', until: 'ch-9x', extra: {} },
      { attribute: '境界', value: '金丹', since: 'ch-2', extra: {} },
    ])
    await buildIndex(root)
    const listed = await callTool('inkflow_facts_list', { projectRoot: root })
    assert.deepEqual(listed.unresolvedChapters, ['ch-9x'])
    assert.deepEqual(listed.conflicts, [], 'a typo must not accuse a correct fact')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. The writing-context segment (the fifth one)
// ---------------------------------------------------------------------------

test('facts segment: the fifth segment carries the facts in effect at the current chapter', async () => {
  const dir = workdir()
  const root = join(dir, 'book')
  try {
    scaffold(root, '注入书')
    writeChapters(root, 5)
    // `always` keeps the world-book entry in the block so the segment order is visible.
    writeFile(root, 'world/青锋门.md', '---\ntitle: 青锋门\nalways: true\n---\n\n青锋门正文。\n')
    writeLedger(root, 'char-a', 'char-a', [
      { attribute: '境界', value: '筑基', since: 'ch-1', until: 'ch-4', source: 'text', extra: {} },
      { attribute: '境界', value: '金丹', since: 'ch-4', source: 'text', extra: {} },
      { attribute: '持有物', value: '已失去的旧剑', since: 'ch-1', until: 'ch-2', extra: {} },
    ])
    await buildIndex(root)

    const context = buildWritingContext(root)
    // Segment order is the contract (X-13): project → chapter → tail → world → facts.
    assert.deepEqual(
      context.segments.map((segment) => segment.name),
      ['project', 'chapter', 'tail', 'world', 'facts'],
    )
    const segment = context.segments[4]
    assert.equal(segment.name, 'facts', 'the ledger is the fifth segment')
    assert.ok(segment.text.includes('金丹'), 'the value in effect at the current chapter is injected')
    assert.ok(segment.text.includes('截至第 5 章'), 'the segment says which chapter it is as of')
    assert.equal(segment.text.includes('已失去的旧剑'), false, 'a fact that stopped holding is not injected')
    assert.equal(segment.text.includes('筑基'), false, 'the superseded value is not injected')
    assert.ok(context.text.includes(segment.text), 'the segment reaches the rendered block')
    assert.deepEqual(
      EXTRA_SEGMENTS.map((spec) => [spec.name, spec.capRatio]),
      [['facts', 0.15]],
      'this issue registers exactly one segment, with the X-13 cap',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('facts segment: a book with no ledger injects nothing (no empty heading)', async () => {
  const dir = workdir()
  const root = join(dir, 'book')
  try {
    scaffold(root, '空账本书')
    writeChapters(root, 2)
    await buildIndex(root)
    const context = buildWritingContext(root)
    assert.equal(
      context.segments.some((segment) => segment.name === 'facts'),
      false,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. The write gate (I-23's other net)
// ---------------------------------------------------------------------------

test('facts append: an overlapping different value is refused and nothing is written', async () => {
  const dir = workdir()
  const root = join(dir, 'book')
  try {
    scaffold(root, '拒写书')
    writeChapters(root, 6)
    writeLedger(root, 'char-a', 'char-a', [
      { attribute: '境界', value: '筑基', since: 'ch-1', until: 'ch-4', extra: {} },
      { attribute: '境界', value: '金丹', since: 'ch-4', extra: {} },
    ])
    await buildIndex(root)

    const before = hashTree(root)
    const refused = await callTool('inkflow_facts_append', {
      projectRoot: root,
      subject: 'char-a',
      attribute: '境界',
      value: '元婴',
      since: 'ch-2',
      until: 'ch-5',
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'FACT_CONFLICT')
    assert.equal(hashTree(root), before, 'a refused append writes nothing at all')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('facts append: a legal fact lands, keeps the author’s file intact, and the ledger answers for it', async () => {
  const dir = workdir()
  const root = join(dir, 'book')
  try {
    scaffold(root, '追加书')
    writeChapters(root, 6)
    const original = [
      '---',
      'subject: char-a',
      'title: 甲',
      '# 作者自己的备注',
      '---',
      '',
      '作者写在正文里的一句话，不是事实。',
      '',
      '- attribute: 境界 | value: 筑基 | since: ch-1 | until: ch-4 | source: text',
      '',
    ].join('\n')
    writeFile(root, 'facts/char-a.md', original)
    await buildIndex(root)

    const appended = await callTool('inkflow_facts_append', {
      projectRoot: root,
      subject: 'char-a',
      attribute: '境界',
      value: '金丹',
      since: 'ch-4',
      chapter: 'ch-4',
      source: 'text',
    })
    assert.equal(appended.ok, true)
    assert.equal(appended.file, 'facts/char-a.md')
    // The prose line at 7 and the blank at 8 are body lines; the append lands on line 10.
    assert.equal(appended.anchor, 'facts/char-a.md#L10')

    const text = readFileSync(join(root, 'facts', 'char-a.md'), 'utf8')
    assert.ok(text.startsWith(original.slice(0, original.length - 1)), 'every existing byte is kept')
    assert.ok(text.includes('- attribute: 境界 | value: 金丹 | since: ch-4 | chapterId: ch-4 | source: text'))

    const snapshot = await callTool('inkflow_facts_snapshot', { projectRoot: root, chapterId: 'ch-5' })
    assert.deepEqual(snapshot.facts.map((fact) => fact.value), ['金丹'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('facts append: creating a new ledger needs confirmation, and a stale baseline is refused', async () => {
  const dir = workdir()
  const root = join(dir, 'book')
  try {
    scaffold(root, '建账书')
    writeChapters(root, 3)
    await buildIndex(root)

    const before = hashTree(root)
    const pending = await callTool('inkflow_facts_append', {
      projectRoot: root,
      subject: 'char-b',
      attribute: '境界',
      value: '练气',
      since: 'ch-1',
    })
    assert.equal(pending.ok, false)
    assert.equal(pending.requiresConfirmation, true)
    assert.equal(pending.willWrite, 'facts/char-b.md')
    assert.equal(hashTree(root), before, 'the confirmation gate writes nothing')

    const created = await callTool('inkflow_facts_append', {
      projectRoot: root,
      subject: 'char-b',
      attribute: '境界',
      value: '练气',
      since: 'ch-1',
      confirm: true,
    })
    assert.equal(created.ok, true)
    assert.equal(created.created, true)
    assert.ok(readFileSync(join(root, 'facts', 'char-b.md'), 'utf8').includes('subject: char-b'))

    const stale = await callTool('inkflow_facts_append', {
      projectRoot: root,
      subject: 'char-b',
      attribute: '境界',
      value: '筑基',
      since: 'ch-2',
      expected: { sha256: 'deadbeef' },
    })
    assert.equal(stale.ok, false)
    assert.equal(stale.error.code, 'FILE_CHANGED')
    assert.deepEqual(stale.error.changed, ['sha256'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('facts: the interval rule is symmetric — extending the older fact is refused too', async () => {
  const dir = workdir()
  const root = join(dir, 'book')
  try {
    scaffold(root, '对称书')
    writeChapters(root, 6)
    writeLedger(root, 'char-a', 'char-a', [
      { attribute: '境界', value: '筑基', since: 'ch-1', until: 'ch-4', extra: {} },
      { attribute: '境界', value: '金丹', since: 'ch-4', extra: {} },
    ])
    await buildIndex(root)
    // The pair is judged from both sides: a candidate that runs past the later fact's start
    // is the same contradiction, and a gate that only looked at newer rows would miss it.
    const refused = await callTool('inkflow_facts_append', {
      projectRoot: root,
      subject: 'char-a',
      attribute: '境界',
      value: '筑基',
      since: 'ch-1',
      until: 'ch-6',
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'FACT_CONFLICT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. The domain projection
// ---------------------------------------------------------------------------

test('facts: the domain publishes one entity per subject, so the ledger is reachable by search', async () => {
  const dir = workdir()
  const root = join(dir, 'book')
  try {
    scaffold(root, '投影书')
    writeChapters(root, 2)
    writeLedger(root, 'char-a', 'char-a', [{ attribute: '境界', value: '筑基', since: 'ch-1', extra: {} }], ['title: 甲'])
    writeLedger(root, 'char-b', 'char-b', [{ attribute: '境界', value: '练气', since: 'ch-1', extra: {} }])
    await buildIndex(root)

    const db = new DatabaseSync(join(root, 'index', 'inkflow.db'), { readOnly: true })
    try {
      const rows = db.prepare("SELECT id, title FROM entities WHERE kind = 'facts' ORDER BY id").all()
      assert.deepEqual(
        rows.map((row) => [row.id, row.title]),
        [
          ['char-a', '甲'],
          ['char-b', 'char-b'],
        ],
        'one subject is one entity, not one per fact line',
      )
    } finally {
      db.close()
    }
    assert.ok((searchEntities(root, '甲') ?? []).some((entity) => entity.kind === 'facts'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('facts: factsSnapshot and factsConflicts are pure functions of the rows and the order', () => {
  const rows = [
    { id: 'a#L1', path: 'facts/a.md', line: 1, subject: 'a', attribute: '境界', value: '筑基', since: 'ch-1', until: 'ch-2', source: 'text', extra: {} },
    { id: 'a#L2', path: 'facts/a.md', line: 2, subject: 'a', attribute: '境界', value: '金丹', since: 'ch-2', source: 'text', extra: {} },
  ]
  const seqOf = (id) => (id === 'ch-1' ? 1 : id === 'ch-2' ? 2 : undefined)
  assert.deepEqual(
    factsSnapshot(rows, seqOf, 1).map((row) => row.value),
    ['筑基'],
  )
  assert.deepEqual(
    factsSnapshot(rows, seqOf, 2).map((row) => row.value),
    ['金丹'],
  )
  assert.deepEqual(factsSnapshot(rows, () => undefined, 5), [], 'an unplaceable boundary excludes the fact')
  assert.deepEqual(factsConflicts(rows, seqOf), [], 'adjacent intervals are not a conflict')
})
