/**
 * Issue #46 — the review DAG, its evidence chain, the run record and the cross-model table.
 *
 * What each block is for, so a failure names the promise that broke:
 *
 *   1. **五维节点独立** — every dimension runs alone, a subset can be requested (the rest are
 *      `skipped`, not silently absent), and a node that throws or refuses does not take the
 *      other four down: the failure is a structured code in the record.
 *   2. **每条意见都有定位状态** — 100% of opinions carry `located: boolean`; `locator === null`
 *      exactly when `located` is false; the four hint kinds each resolve; and the ways a hint
 *      can fail (missing / ambiguous / out of range / not found) each come back with their own
 *      reason instead of being dropped.
 *   3. **证据取自真实正文** — the excerpt is a slice of the file, so editing the chapter changes
 *      it, and it never invents text that is not there.
 *   4. **横评只算表不打分** — two models, identical column sets, arithmetic that can be redone
 *      by hand, `—` where there is nothing to divide, and no plugin-side aesthetic score.
 *   5. **运行记录可回读** — the file is at `.inkflow/review/<chapterId>/<runId>.json`, a second
 *      run does not overwrite the first, and the panel's projection reads both back.
 *   6. **落点** — `index/` gains nothing (X-25), and `.gitignore` gains `.inkflow/` once.
 *   7. **词表** — the five `REVIEW_*` codes are in `FINDING_CODES`, in data-model §5, carry the
 *      right `group`, and are `fixable: false` (ADR-0022 D3).
 *   8. **工具与面板模型** — the three tools end to end, and the client model's three states.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FINDING_CODES,
  REVIEW_COMPARE_COLUMNS,
  REVIEW_DIMENSIONS,
  REVIEW_DIMENSION_CODES,
  REVIEW_DIMENSION_SPECS,
  REVIEW_LIST_LIMIT,
  REVIEW_NODES,
  apply,
  buildReviewCompare,
  buildReviewContext,
  buildReviewList,
  compareReviewRuns,
  findingCode,
  listReviewRuns,
  locateOpinion,
  paragraphsOf,
  renderCompareMarkdown,
  reviewDirOf,
  reviewRunPath,
  runReview,
} from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Three paragraphs, with one sentence repeated on purpose (the ambiguity case). */
const BODY = ['他推开门，屋里没有人。', '', '「你终于来了。」老人放下茶杯。', '', '他推开门，屋里没有人。'].join('\n')

const CHARACTERS = [
  { id: 'char-qingyin', name: '清音', aliases: ['音儿'] },
  { id: 'char-laoren', name: '老人', aliases: [] },
]

const FACTS = [{ subject: 'char-qingyin', lines: ['- attribute: 境界 | value: 筑基期'] }]

/** A complete book in a temp directory. The caller always removes it. */
function book(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-review-'))
  const root = join(dir, '书')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const name of ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '审稿之书' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.gitignore'), 'index/*.db\n', 'utf8')
  for (const card of options.characters ?? CHARACTERS) {
    writeFileSync(
      join(root, 'characters', `${card.id}.md`),
      ['---', `id: ${card.id}`, `name: ${card.name}`, `aliases: [${card.aliases.join(', ')}]`, '---', '', `${card.name}的卡片。`, ''].join('\n'),
      'utf8',
    )
  }
  for (const ledger of options.facts ?? FACTS) {
    writeFileSync(
      join(root, 'facts', `${ledger.subject}.md`),
      ['---', `subject: ${ledger.subject}`, '---', '', ...ledger.lines, ''].join('\n'),
      'utf8',
    )
  }
  const volume = join(root, 'chapters', 'vol-01')
  mkdirSync(volume, { recursive: true })
  writeFileSync(join(volume, '.gitkeep'), '', 'utf8')
  const chapters = options.chapters ?? [{ id: 'ch-0001', seq: 1, title: '第一章 推门', body: options.body ?? BODY }]
  for (const chapter of chapters) {
    const frontmatter = ['---', `id: ${chapter.id}`, `title: ${chapter.title}`, 'volume: vol-01', `seq: ${String(chapter.seq)}`, 'pov: 清音', '---', '']
    writeFileSync(join(volume, `${String(chapter.seq).padStart(4, '0')}-${chapter.id}.md`), [...frontmatter, chapter.body].join('\n'), 'utf8')
  }
  return { dir, root, chapterPath: `chapters/vol-01/0001-${chapters[0].id}.md`, done: () => rmSync(dir, { recursive: true, force: true }) }
}

/** The clock every test pins, so a run id is predictable. */
const NOW = new Date('2026-10-25T09:55:01.123Z')

function opinon(dimension, text, extra = {}) {
  return { dimension, text, ...extra }
}

function runOn(fixture, request, options = {}) {
  const result = runReview(fixture.root, { chapterId: 'ch-0001', ...request }, { now: NOW, ...options })
  assert.equal(result.ok, true, `the run was refused: ${JSON.stringify(result.error ?? null)}`)
  return result
}

/** `20261025T095501123Z`: sortable, no separators a Windows path would reject. */
function seedRuns(root, chapterId, count) {
  const dir = join(root, '.inkflow', 'review', chapterId)
  mkdirSync(dir, { recursive: true })
  const ids = []
  for (let index = 0; index < count; index += 1) {
    const runId = `20261025T${String(10000000 + index)}Z`
    ids.push(runId)
    const record = {
      schemaVersion: 1,
      runId,
      chapterId,
      chapterPath: `chapters/vol-01/0001-${chapterId}.md`,
      chapterTitle: '第一章 推门',
      wordCount: 20,
      chapterDigest: 'digest',
      reviewer: 'model-a',
      createdAt: '2026-10-25T09:55:01.123Z',
      dimensions: [],
      opinions: [],
      rejected: [],
      scores: null,
    }
    writeFileSync(join(dir, `${runId}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  }
  return ids
}

// ---------------------------------------------------------------------------
// 1. The DAG: five nodes, runnable alone, isolated failures
// ---------------------------------------------------------------------------

test('审稿 DAG：五个维度各是一个节点，只跑请求的那几维，其余标 skipped', () => {
  const fixture = book()
  try {
    assert.deepEqual(REVIEW_NODES.map((node) => node.dimension), [...REVIEW_DIMENSIONS])
    const ran = runOn(fixture, {
      opinions: [opunonPacing()],
      dimensions: ['pacing'],
    }, { record: false })
    const statuses = Object.fromEntries(ran.run.dimensions.map((summary) => [summary.dimension, summary.status]))
    assert.equal(statuses['pacing'], 'ok')
    for (const skipped of ['structure', 'character', 'style', 'consistency']) {
      assert.equal(statuses[skipped], 'skipped', `${skipped} must be reported as skipped, not omitted`)
    }
    const skippedSummary = ran.run.dimensions.find((summary) => summary.dimension === 'style')
    assert.equal(skippedSummary.skipReason, 'not-requested')
    // A skipped node contributes no opinions: the pacing opinion is the only one.
    assert.equal(ran.run.opinions.length, 1)
  } finally {
    fixture.done()
  }
})

test('审稿 DAG：一个节点抛异常不拖垮其他四维，失败以结构化 code 记进记录', () => {
  const fixture = book()
  try {
    const nodes = REVIEW_NODES.map((node) =>
      node.dimension === 'structure'
        ? {
            ...node,
            run: () => {
              throw new Error('boom')
            },
          }
        : node,
    )
    const ran = runOn(
      fixture,
      {
        opinions: [
          opunonPacing(),
          opinon('style', '这一段的句长一模一样', { quote: '他推开门，屋里没有人。', paragraph: 1 }),
        ],
      },
      { nodes, record: false },
    )
    const failed = ran.run.dimensions.filter((summary) => summary.status === 'failed')
    assert.equal(failed.length, 1)
    assert.equal(failed[0].dimension, 'structure')
    assert.equal(failed[0].code, 'REVIEW_NODE_FAILED')
    assert.ok(failed[0].message.includes('boom'))
    // The other four finished, and the opinions routed to them are still in the record.
    for (const dimension of ['character', 'pacing', 'style', 'consistency']) {
      assert.equal(ran.run.dimensions.find((summary) => summary.dimension === dimension).status, 'ok')
    }
    assert.equal(ran.run.opinions.length, 2)
  } finally {
    fixture.done()
  }
})

test('审稿 DAG：节点也可以拒绝（不抛），拒绝码原样进记录', () => {
  const fixture = book()
  try {
    const nodes = REVIEW_NODES.map((node) =>
      node.dimension === 'consistency'
        ? { ...node, run: () => ({ ok: false, code: 'REVIEW_SOURCE_UNREADABLE', message: '账本读不动' }) }
        : node,
    )
    const ran = runOn(fixture, { opinions: [opunonPacing()] }, { nodes, record: false })
    const summary = ran.run.dimensions.find((entry) => entry.dimension === 'consistency')
    assert.equal(summary.status, 'failed')
    assert.equal(summary.code, 'REVIEW_SOURCE_UNREADABLE')
    assert.equal(summary.message, '账本读不动')
    assert.equal(ran.run.opinions.length, 1)
  } finally {
    fixture.done()
  }
})

test('审稿 DAG：请求一个不存在的维度是整体拒绝，不是静默少跑一维', () => {
  const fixture = book()
  try {
    const refused = runReview(fixture.root, { chapterId: 'ch-0001', opinions: [opunonPacing()], dimensions: ['mood'] }, { now: NOW })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'REVIEW_DIMENSION_UNKNOWN')
    assert.ok(refused.error.hint.includes('structure'))
  } finally {
    fixture.done()
  }
})

/** One filler opinion in a dimension no other subtest asserts on. */
function opunonPacing() {
  return opinon('pacing', '第二段之后停得太久', { quote: '老人放下茶杯。' })
}

// ---------------------------------------------------------------------------
// 2. Locating: every opinion carries a located state, no hint is guessed
// ---------------------------------------------------------------------------

test('定位：四种提示都能落到 path#L<n>，每段证据都是正文里的原文', () => {
  const fixture = book()
  try {
    const ran = runOn(fixture, {
      opinions: [
        opinon('structure', '开场太快', { quote: '他推开门，屋里没有人。', paragraph: 1 }),
        opinon('character', '老人没有名字', { paragraph: 2, offset: 0 }),
        opinon('pacing', '这里停顿', { offset: 0 }),
        opinon('style', '第五行重复', { line: 12 }),
      ],
    }, { record: false })
    assert.equal(ran.run.opinions.length, 4)
    for (const opinion of ran.run.opinions) {
      assert.equal(typeof opinion.located, 'boolean', 'located must always be a boolean, never undefined')
      assert.equal(opinion.locator === null, !opinion.located, 'locator is null exactly when the opinion is unlocated')
      assert.equal(opinion.evidence === null, !opinion.located)
      if (!opinion.located) continue
      assert.equal(opinion.locator.kind, 'path')
      assert.equal(opinion.locator.path, 'chapters/vol-01/0001-ch-0001.md')
      assert.equal(typeof opinion.locator.line, 'number')
      assert.ok(BODY.includes(opinion.evidence.quote), `the excerpt must be text from the chapter: ${String(opinion.evidence.quote)}`)
      assert.equal(opinion.evidence.offset >= 0, true)
    }
    const byDimension = Object.fromEntries(ran.run.opinions.map((opinion) => [opinion.dimension, opinion]))
    assert.equal(byDimension['structure'].evidence.source, 'quote')
    assert.equal(byDimension['character'].evidence.source, 'paragraph')
    assert.equal(byDimension['pacing'].evidence.source, 'offset')
    assert.equal(byDimension['style'].evidence.source, 'line')
    // The excerpt's neighbours come from the same line, never across a paragraph break.
    assert.equal(byDimension['structure'].evidence.before.includes('\n'), false)
    assert.equal(byDimension['structure'].evidence.after.includes('\n'), false)
  } finally {
    fixture.done()
  }
})

test('定位：定位不到的意见被保留并带理由码，绝不编一个定位', () => {
  const fixture = book()
  try {
    const ran = runOn(fixture, {
      opinions: [
        opinon('structure', '没给任何提示'),
        opinon('character', '引文出现两次', { quote: '他推开门，屋里没有人。' }),
        opinon('pacing', '段号越界', { paragraph: 99 }),
        opinon('style', '引文找不到', { quote: '这句正文里根本没有' }),
        opinon('consistency', '偏移越界', { offset: 99999 }),
      ],
    }, { record: false })
    const reasons = ran.run.opinions.map((opinion) => opinion.unlocatedReason)
    assert.deepEqual(reasons.sort(), [
      'REVIEW_HINT_MISSING',
      'REVIEW_OFFSET_OUT_OF_RANGE',
      'REVIEW_PARAGRAPH_OUT_OF_RANGE',
      'REVIEW_QUOTE_AMBIGUOUS',
      'REVIEW_QUOTE_NOT_FOUND',
    ].sort())
    for (const opinion of ran.run.opinions) {
      assert.equal(opinion.located, false)
      assert.equal(opinion.locator, null)
      assert.equal(opinion.evidence, null)
      assert.ok(opinion.detail !== '', 'the opinion text is kept — the point is that nothing is dropped')
      assert.ok(opinion.unlocatedDetail !== '', 'and the reason is spelled out for the reader')
      // Still the shared finding shape, so a report can print it like any other finding.
      assert.equal(opinion.code, REVIEW_DIMENSION_CODES[opinion.dimension])
      assert.equal(opinion.fixable, false)
    }
    // The ambiguous quote can be disambiguated by the paragraph, and then it resolves.
    const disambiguated = locateOpinion(reviewChapterOf(fixture, BODY), { quote: '他推开门，屋里没有人。', paragraph: 3 })
    assert.equal(disambiguated.located, true)
    assert.equal(disambiguated.evidence.paragraph, 3)
  } finally {
    fixture.done()
  }
})

/** The chapter as `locateOpinion` sees it, built from the body the test knows. */
function reviewChapterOf(fixture, body) {
  const paragraphs = paragraphsOf(body)
  return {
    id: 'ch-0001',
    path: 'chapters/vol-01/0001-ch-0001.md',
    seq: 1,
    title: '第一章 推门',
    pov: '清音',
    body,
    wordCount: body.replace(/\s+/gu, '').length,
    paragraphs,
    bodyStartLine: 9,
  }
}

test('定位：同一句出现两次时，paragraph 能消歧，offset 与 paragraph 一起用时按段内偏移算', () => {
  const chapter = reviewChapterOf({ root: '' }, BODY)
  const first = locateOpinion(chapter, { quote: '他推开门，屋里没有人。' })
  assert.equal(first.located, false)
  assert.ok(first.detail.includes('2 次'))
  const inLast = locateOpinion(chapter, { quote: '他推开门，屋里没有人。', paragraph: 3 })
  assert.equal(inLast.located, true)
  assert.equal(inLast.evidence.offset, BODY.lastIndexOf('他推开门'))
  // paragraph + offset: the offset is inside that paragraph, not the body.
  const inner = locateOpinion(chapter, { paragraph: 3, offset: 1 })
  assert.equal(inner.located, true)
  assert.equal(inner.evidence.offset, chapter.paragraphs[2].start + 1)
})

// ---------------------------------------------------------------------------
// 3. Evidence comes from the real body
// ---------------------------------------------------------------------------

test('证据链：提示核对磁盘上的字节，改正文之后同一条意见要么改摘录要么变未定位', () => {
  const fixture = book()
  try {
    const quoteHint = { dimension: 'style', text: '这句读着别扭', quote: '老人放下茶杯。' }
    const first = runOn(fixture, { opinions: [quoteHint] }, { record: false })
    assert.equal(first.run.opinions[0].located, true)
    assert.ok(first.run.opinions[0].evidence.quote.includes('老人放下茶杯'))

    const file = join(fixture.root, 'chapters', 'vol-01', '0001-ch-0001.md')
    const text = readFileSync(file, 'utf8')
    writeFileSync(file, text.replace('老人放下茶杯', '老人把茶杯搁下'), 'utf8')

    // (a) The same quotation no longer exists: the opinion is kept as unlocated instead of
    // pointing at text that is not there any more — the hint is checked, not remembered.
    const second = runOn(fixture, { opinions: [quoteHint] }, { record: false })
    assert.equal(second.run.opinions[0].located, false)
    assert.equal(second.run.opinions[0].unlocatedReason, 'REVIEW_QUOTE_NOT_FOUND')
    assert.equal(second.run.opinions[0].locator, null)

    // (b) A positional hint resolves again, and the excerpt is the NEW wording — it is a
    // slice of the file, so editing the chapter changes the evidence.
    const byOffset = runOn(fixture, { opinions: [{ dimension: 'style', text: '同上', offset: 14 }] }, { record: false })
    assert.equal(byOffset.run.opinions[0].located, true)
    assert.ok(byOffset.run.opinions[0].evidence.quote.includes('老人把茶杯搁下'))

    // And the digest moved with the bytes: two runs, two digests.
    assert.notEqual(second.run.chapterDigest, first.run.chapterDigest)
  } finally {
    fixture.done()
  }
})

// ---------------------------------------------------------------------------
// 4. The comparison table: two models, same columns, arithmetic only
// ---------------------------------------------------------------------------

test('横评：两个模型同口径，列集一致，比率可手算，插件不打分', () => {
  const fixture = book()
  try {
    const modelA = runOn(fixture, {
      reviewer: 'model-a',
      opinions: [
        opinon('style', 'A 的第一条', { quote: '老人放下茶杯。' }),
        opinon('style', 'A 的第二条（没定位）'),
      ],
      scores: { style: 6 },
    }, { now: new Date('2026-10-25T09:00:00.000Z') })
    const modelB = runOn(fixture, {
      reviewer: 'model-b',
      opinions: [opinon('pacing', 'B 的唯一一条', { offset: 0 })],
    }, { now: new Date('2026-10-25T09:30:00.000Z') })

    const listed = listReviewRuns(fixture.root, 'ch-0001')
    assert.equal(listed.runs.length, 2)
    assert.deepEqual(
      listed.runs.map((run) => run.runId),
      [modelB.run.runId, modelA.run.runId],
      'newest first',
    )

    const table = compareReviewRuns(listed.runs)
    assert.equal(table.comparable, true)
    assert.deepEqual([...table.columns], [...REVIEW_COMPARE_COLUMNS])
    assert.deepEqual([...table.reviewers], ['model-b', 'model-a'])
    for (const row of table.rows) {
      assert.deepEqual(Object.keys(row).sort(), [...REVIEW_COMPARE_COLUMNS].sort(), 'every row carries every column')
    }
    const styleA = table.rows.find((row) => row.reviewer === 'model-a' && row.dimension === 'style')
    assert.equal(styleA.opinions, 2)
    assert.equal(styleA.located, 1)
    assert.equal(styleA.locatedRate, 50)
    assert.equal(styleA.modelScore, 6, 'the model score is copied, not computed')
    const emptyB = table.rows.find((row) => row.reviewer === 'model-b' && row.dimension === 'style')
    assert.equal(emptyB.opinions, 0)
    assert.equal(emptyB.locatedRate, null, '0 of 0 is null, not 0%')
    const totalB = table.rows.find((row) => row.reviewer === 'model-b' && row.dimension === 'total')
    assert.equal(totalB.modelScore, null, 'no score given, none invented')
    // Density is opinions per 1000 characters of the chapter body.
    assert.equal(totalB.density, Math.round((1 / (table.wordCount / 1000)) * 10) / 10)
    const markdown = renderCompareMarkdown(table)
    assert.ok(markdown.includes('model-a'))
    assert.ok(markdown.includes('model-b'))
    assert.ok(markdown.includes('—'), 'an empty rate prints as —, not as 0')
  } finally {
    fixture.done()
  }
})

test('横评：只有 1 个模型时表照样出，但明确标不可比', () => {
  const fixture = book()
  try {
    runOn(fixture, { reviewer: 'solo', opinions: [opunonPacing()] })
    const listed = listReviewRuns(fixture.root, 'ch-0001')
    const table = compareReviewRuns(listed.runs)
    assert.equal(table.comparable, false)
    assert.ok(table.note.includes('2 个模型'))
    assert.ok(table.rows.length > 0, 'the rows are still there — a single model is still a table')
  } finally {
    fixture.done()
  }
})

test('横评 #205：表头的章身份取自解析出的那一章，记录只是回落', () => {
  const fixture = book({
    chapters: [
      { id: 'ch-0001', seq: 1, title: '第一章 推门', body: BODY },
      { id: 'ch-0002', seq: 2, title: '第二章 夜谈', body: BODY },
    ],
  })
  try {
    const context = buildReviewContext(fixture.root, { chapterId: 'ch-0001' })
    assert.equal(context.ok, true)
    const resolved = { chapterId: 'ch-0001', chapterTitle: '第一章 推门', wordCount: context.value.wordCount }

    // (a) A chapter that resolved but has no recorded run: `rows: []` is fine, an EMPTY
    // identity is not — the page must be able to say which chapter it is looking at.
    // Before the fix the header came from `first?.chapterId ?? ''`, so this was `''` / `''` / 0.
    const empty = compareReviewRuns([], resolved)
    assert.equal(empty.chapterId, 'ch-0001', '章解析成功就回显该章 id')
    assert.equal(empty.chapterTitle, '第一章 推门')
    assert.equal(empty.wordCount, context.value.wordCount, '字数取自这一章，不是记录推出来的 0')
    assert.deepEqual([...empty.rows], [])
    assert.equal(empty.comparable, false)
    assert.ok(empty.note.includes('还没有审稿运行'), `note 要说清这一章没跑过：${empty.note}`)

    // (b) A record that names ANOTHER chapter (a hand-copied file, a renamed chapter) must
    // not win over the resolved one: the records are the fallback, not the source.
    const dir = join(fixture.root, '.inkflow', 'review', 'ch-0001')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '20261025T100000000Z.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runId: '20261025T100000000Z',
          chapterId: 'ch-0002',
          chapterPath: 'chapters/vol-01/0002-ch-0002.md',
          chapterTitle: '第二章 夜谈',
          wordCount: 999,
          chapterDigest: 'digest',
          reviewer: 'model-a',
          createdAt: '2026-10-25T10:00:00.000Z',
          dimensions: [],
          opinions: [],
          rejected: [],
          scores: null,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    const stray = listReviewRuns(fixture.root, 'ch-0001')
    assert.equal(stray.runs.length, 1, 'the record is readable, it just disagrees about the chapter')
    const table = compareReviewRuns(stray.runs, resolved)
    assert.equal(table.chapterId, 'ch-0001', '解析出的章压过记录里的章')
    assert.equal(table.chapterTitle, '第一章 推门')
    assert.equal(table.wordCount, context.value.wordCount, '字数也取自这一章，不是记录里的 999')
    assert.equal(table.rows.length, 5 + 1, 'the rows still come from the record')

    // (c) No chapter in hand: the record is still the fallback (the path the tool took before
    // the route resolved a chapter for it), and it says so instead of inventing a chapter.
    const fallback = compareReviewRuns(stray.runs)
    assert.equal(fallback.chapterId, 'ch-0002', 'records are the fallback when nothing was resolved')
  } finally {
    fixture.done()
  }
})

test('横评路由 #205：?chapterId= 就是那一章，未知 id 404 不回退，默认仍是最后一章', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-review-compare-205-'))
  const fixture = book({
    chapters: [
      { id: 'ch-0001', seq: 1, title: '第一章 推门', body: BODY },
      { id: 'ch-0002', seq: 2, title: '第二章 夜谈', body: BODY },
    ],
  })
  try {
    // One run on ch-0002 only, so "the chapter I asked for has no runs" is a real state.
    runOn(fixture, { chapterId: 'ch-0002', reviewer: 'model-a', opinions: [opunonPacing()] })
    const source = { sessionId: 's-1', root: fixture.root }

    const asked = buildReviewCompare(source, '0.0.0-test', { chapterId: 'ch-0001' })
    assert.equal(asked.status, 200)
    const askedValue = asked.body.value
    assert.equal(askedValue.chapterId, 'ch-0001', 'the table header is the chapter the caller named')
    assert.equal(askedValue.chapterTitle, '第一章 推门')
    assert.ok(askedValue.wordCount > 0, 'the word count is the chapter\'s, not the record-derived 0')
    assert.deepEqual(askedValue.rows, [])
    assert.equal(askedValue.comparable, false)
    assert.ok(askedValue.note.includes('还没有审稿运行'), `note 说清这一章还没跑过：${askedValue.note}`)
    assert.ok(askedValue.markdown.includes('第一章 推门'), 'the export header names it too')

    // The chapter WITH runs is still that chapter: the fix must not turn the header into
    // "whatever the first record claims".
    const withRuns = buildReviewCompare(source, '0.0.0-test', { chapterId: 'ch-0002' })
    assert.equal(withRuns.status, 200)
    assert.equal(withRuns.body.value.chapterId, 'ch-0002')
    assert.equal(withRuns.body.value.chapterTitle, '第二章 夜谈')
    assert.ok(withRuns.body.value.rows.length > 0, 'the rows are the run\'s')

    // No address: the last chapter, the route's documented default — and named, not `''`.
    const byDefault = buildReviewCompare(source, '0.0.0-test', {})
    assert.equal(byDefault.status, 200)
    assert.equal(byDefault.body.value.chapterId, 'ch-0002')

    // An unknown id is refused like /brief: 404 naming the id, never a fallback.
    const missing = buildReviewCompare(source, '0.0.0-test', { chapterId: 'ch-9999' })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'CHAPTER_NOT_FOUND')
    assert.equal(missing.body.value, undefined, 'no payload at all to mistake for the asked chapter')
    assert.ok(!JSON.stringify(missing.body).includes('夜谈'), 'the last chapter is nowhere in the refusal')

    // The tool and the route are one wire: the same chapter identity, zero runs included.
    const harness = makeTools(join(dir, 'state'), fixture.dir)
    const viaTool = await callTool(harness, 'inkflow_review_compare', { projectRoot: fixture.root, chapterId: 'ch-0001' })
    assert.equal(viaTool.ok, true)
    assert.equal(viaTool.chapterId, 'ch-0001')
    assert.equal(viaTool.chapterTitle, '第一章 推门')
    assert.equal(viaTool.markdown, askedValue.markdown, 'the tool and the route render one table')
  } finally {
    fixture.done()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. The record: on disk, readable, one per run
// ---------------------------------------------------------------------------

test('运行记录：落 .inkflow/review/<chapterId>/<runId>.json，可回读，两次运行互不覆盖', () => {
  const fixture = book()
  try {
    assert.equal(reviewDirOf('ch-0001'), '.inkflow/review/ch-0001')
    assert.equal(reviewRunPath('ch-0001', '20261025T095501123Z'), '.inkflow/review/ch-0001/20261025T095501123Z.json')

    const first = runOn(fixture, { reviewer: 'model-a', opinions: [opunonPacing()] })
    assert.equal(first.file.path, '.inkflow/review/ch-0001/20261025T095501123Z.json')
    assert.equal(first.file.created, true)
    const second = runOn(
      fixture,
      { reviewer: 'model-b', opinions: [opunonPacing()] },
      { now: new Date('2026-10-25T10:00:00.000Z') },
    )
    assert.notEqual(second.file.path, first.file.path)

    const onDisk = JSON.parse(readFileSync(join(fixture.root, ...first.file.path.split('/')), 'utf8'))
    assert.equal(onDisk.schemaVersion, 1)
    assert.equal(onDisk.runId, '20261025T095501123Z')
    assert.equal(onDisk.chapterId, 'ch-0001')
    assert.equal(onDisk.reviewer, 'model-a')
    assert.equal(onDisk.createdAt, NOW.toISOString())
    assert.equal(onDisk.opinions.length, 1)
    assert.equal(typeof onDisk.chapterDigest, 'string')
    // The record holds the excerpt, which is what the panel prints and the jump points at.
    assert.equal(typeof onDisk.opinions[0].evidence.quote, 'string')
    // No absolute path in the record.
    assert.equal(JSON.stringify(onDisk).includes(fixture.root.replaceAll('\\', '/')), false)

    const listed = listReviewRuns(fixture.root, 'ch-0001')
    assert.deepEqual(listed.runs.map((run) => run.reviewer), ['model-b', 'model-a'])
    assert.deepEqual(listed.skippedFiles, [])

    // The panel's projection: both runs listed, the requested one expanded.
    const projection = buildReviewList({ sessionId: 's-1', root: fixture.root }, '0.0.0-test', { chapterId: 'ch-0001' })
    assert.equal(projection.status, 200)
    assert.equal(projection.body.value.runCount, 2)
    assert.equal(projection.body.value.runs.length, 2)
    assert.equal(projection.body.value.selected.runId, '20261025T100000000Z')
    assert.equal(projection.body.value.recordDir, '.inkflow/review/ch-0001')
    const older = buildReviewList({ sessionId: 's-1', root: fixture.root }, '0.0.0-test', {
      chapterId: 'ch-0001',
      runId: '20261025T095501123Z',
    })
    assert.equal(older.body.value.selected.reviewer, 'model-a')
    const missing = buildReviewList({ sessionId: 's-1', root: fixture.root }, '0.0.0-test', {
      chapterId: 'ch-0001',
      runId: 'nope',
    })
    assert.equal(missing.body.value.selectedMissing, true, 'a missing run is reported, never silently swapped for another')
  } finally {
    fixture.done()
  }
})

/**
 * #199: the run list is folded, not truncated away.
 *
 * The author's question was "do these stay here forever?" — and the honest answer needs
 * both halves: the first screen stays readable (one page of runs) AND the older ones stay
 * reachable. So the fold boundary travels **with the page** (`foldLimit`) instead of being
 * a second copy of `20` in the panel, and `limit` is how the panel asks for the rest.
 *
 * Fails if: the host stops sending `foldLimit`, the default page grows past
 * `REVIEW_LIST_LIMIT`, a larger `limit` is ignored, or an old run cannot be selected.
 */
test('运行列表：默认一页、更早的由 foldLimit 说明、limit 放大后可选中旧运行（#199）', () => {
  const fixture = book()
  try {
    seedRuns(fixture.root, 'ch-0001', 25)
    const page = buildReviewList({ sessionId: 's-1', root: fixture.root }, '0.0.0-test', { chapterId: 'ch-0001' })
    assert.equal(page.body.value.runCount, 25)
    assert.equal(page.body.value.runs.length, REVIEW_LIST_LIMIT, 'the first screen is one page of runs')
    assert.equal(page.body.value.truncated, true)
    assert.equal(
      page.body.value.foldLimit,
      REVIEW_LIST_LIMIT,
      'the fold boundary comes from the host: the panel must not keep a second copy of the number',
    )

    const expanded = buildReviewList({ sessionId: 's-1', root: fixture.root }, '0.0.0-test', { chapterId: 'ch-0001', limit: 25 })
    assert.equal(expanded.body.value.runs.length, 25, 'limit is what the panel asks with when the fold opens')
    assert.equal(expanded.body.value.foldLimit, REVIEW_LIST_LIMIT, 'the fold boundary does not move when the page grows')

    const oldest = '20261025T10000000Z'
    const picked = buildReviewList({ sessionId: 's-1', root: fixture.root }, '0.0.0-test', { chapterId: 'ch-0001', limit: 25, runId: oldest })
    assert.equal(picked.body.value.selected.runId, oldest, 'a run behind the fold is selectable once the fold opens')
    assert.equal(picked.body.value.selectedMissing, false)
  } finally {
    fixture.done()
  }
})

test('运行记录：手改坏的记录文件计进 skippedFiles，不拖垮面板', () => {
  const fixture = book()
  try {
    runOn(fixture, { opinions: [opunonPacing()] })
    writeFileSync(join(fixture.root, '.inkflow', 'review', 'ch-0001', 'broken.json'), '{ not json', 'utf8')
    const listed = listReviewRuns(fixture.root, 'ch-0001')
    assert.equal(listed.runs.length, 1)
    assert.deepEqual(listed.skippedFiles, ['.inkflow/review/ch-0001/broken.json'])
  } finally {
    fixture.done()
  }
})

// ---------------------------------------------------------------------------
// 6. Placement: .inkflow only, index/ untouched
// ---------------------------------------------------------------------------

test('落点：index/ 只多出 .gitkeep 与数据库文件，.gitignore 只追加一次 .inkflow/', () => {
  const fixture = book()
  try {
    writeFileSync(join(fixture.root, 'index', '.gitkeep'), '', 'utf8')
    runOn(fixture, { opinions: [opunonPacing()] })
    runOn(fixture, { opinions: [opunonPacing()] }, { now: new Date('2026-10-25T10:00:00.000Z') })
    const indexEntries = readdirSync(join(fixture.root, 'index')).sort()
    for (const name of indexEntries) {
      assert.ok(name === '.gitkeep' || name.startsWith('inkflow.db'), `index/ gained ${name} (X-25)`)
    }
    const ignore = readFileSync(join(fixture.root, '.gitignore'), 'utf8')
    assert.equal(ignore.split('\n').filter((line) => line.trim() === '.inkflow/').length, 1, 'appended once, not per run')
    assert.ok(existsSync(join(fixture.root, '.inkflow', 'review', 'ch-0001')))
  } finally {
    fixture.done()
  }
})

// ---------------------------------------------------------------------------
// 7. Vocabulary
// ---------------------------------------------------------------------------

test('词表：五个 REVIEW_* 在 FINDING_CODES 与 data-model §5，group 对得上，一律不可自动修复', () => {
  const spec = readFileSync(join(repoRoot, '.agents/specs/data-model.md'), 'utf8')
  assert.equal(REVIEW_DIMENSION_SPECS.length, REVIEW_DIMENSIONS.length)
  for (const dimension of REVIEW_DIMENSIONS) {
    const entry = REVIEW_DIMENSION_SPECS.find((candidate) => candidate.dimension === dimension)
    assert.ok(entry, `${dimension} has no spec row`)
    assert.ok(entry.label !== '' && entry.code !== '' && entry.task !== '', `${dimension} is missing a field`)
    const code = REVIEW_DIMENSION_CODES[dimension]
    assert.equal(code, entry.code)
    const catalogued = findingCode(code)
    assert.ok(catalogued, `${code} is not in FINDING_CODES`)
    assert.equal(catalogued.group, entry.group)
    assert.equal(catalogued.fixable, false, 'an aesthetic judgement is never auto-fixable (ADR-0022 D3)')
    assert.ok(spec.includes(code), `${code} is missing from data-model §5`)
  }
  // And the catalogue entry exists exactly once per code.
  const reviewCodes = FINDING_CODES.filter((entry) => entry.code.startsWith('REVIEW_'))
  assert.equal(reviewCodes.length, REVIEW_DIMENSIONS.length)
})

test('词表：形状不合法的意见被拒收并报出来，不是静默丢掉', () => {
  const fixture = book()
  try {
    const ran = runOn(fixture, {
      opinions: [
        opunonPacing(),
        { dimension: 'mood', text: '维度不存在' },
        { dimension: 'style', text: '   ' },
        { dimension: 'style', text: '严重级不对', severity: 'blocking' },
      ],
    }, { record: false })
    assert.deepEqual(ran.run.rejected.map((rejection) => rejection.code), [
      'REVIEW_DIMENSION_UNKNOWN',
      'REVIEW_TEXT_REQUIRED',
      'REVIEW_SEVERITY_INVALID',
    ])
    assert.deepEqual(ran.run.rejected.map((rejection) => rejection.index), [1, 2, 3])
    assert.equal(ran.run.opinions.length, 1)
  } finally {
    fixture.done()
  }
})

// ---------------------------------------------------------------------------
// 8. Tools + the client model
// ---------------------------------------------------------------------------

function createHarness(workspace) {
  const tools = new Map()
  const routes = []
  const ctx = {
    effect(setup) {
      const dispose = setup()
      void dispose
      return () => {}
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    get(name) {
      if (name === 'workingDirectory' && typeof workspace === 'string') {
        return { ensure: async () => workspace }
      }
      return undefined
    },
    logger() {
      return { debug() {}, info() {}, warn() {}, error() {} }
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  return { ctx, tools, routes }
}

function makeTools(dataDir, workspace) {
  const harness = createHarness(workspace)
  apply(harness.ctx, { dataDir })
  return harness
}

async function callTool(harness, name, args) {
  const tool = harness.tools.get(name)
  assert.ok(tool, `tool ${name} must be registered`)
  return tool.execute(args, { signal: AbortSignal.timeout(15000), agent: { id: 'test-session' } })
}

test('工具：context 给上下文，run 收意见并落盘，compare 出表（同一条链路）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-review-tool-'))
  const fixture = book()
  try {
    const harness = makeTools(join(dir, 'state'), fixture.dir)

    const context = await callTool(harness, 'inkflow_review_context', { projectRoot: fixture.root })
    assert.equal(context.ok, true)
    assert.equal(context.chapterId, 'ch-0001')
    assert.equal(context.paragraphCount, 3)
    assert.deepEqual(context.dimensions.map((entry) => entry.dimension), [...REVIEW_DIMENSIONS])
    assert.match(context.text, /[段 1 | 偏移 d+]/)
    assert.ok(context.text.includes('【正文】'))
    assert.ok(context.text.includes('quote'), 'the addressing protocol travels with the text')
    const capped = await callTool(harness, 'inkflow_review_context', { projectRoot: fixture.root, maxChars: 40 })
    assert.equal(capped.truncated, true)

    const ran = await callTool(harness, 'inkflow_review_run', {
      projectRoot: fixture.root,
      reviewer: 'model-a',
      opinions: [
        { dimension: 'style', text: '句长太匀', quote: '老人放下茶杯。', severity: 'warning' },
        { dimension: 'pacing', text: '这里可以删' },
      ],
      scores: { style: 5 },
    })
    assert.equal(ran.ok, true)
    assert.equal(ran.counts.opinions, 2)
    assert.equal(ran.counts.located, 1)
    assert.equal(ran.counts.unlocated, 1)
    assert.equal(ran.file.path.startsWith('.inkflow/review/ch-0001/'), true)
    for (const opinion of ran.opinions) {
      assert.deepEqual(Object.keys(opinion), [
        'dimension',
        'code',
        'group',
        'severity',
        'locator',
        'located',
        'unlocatedReason',
        'unlocatedDetail',
        'detail',
        'hint',
        'fixable',
        'evidence',
      ])
    }

    const empty = await callTool(harness, 'inkflow_review_run', { projectRoot: fixture.root, opinions: [] })
    assert.equal(empty.ok, false)
    assert.equal(empty.error.code, 'REVIEW_OPINIONS_REQUIRED')

    const compared = await callTool(harness, 'inkflow_review_compare', { projectRoot: fixture.root })
    assert.equal(compared.ok, true)
    assert.equal(compared.comparable, false, 'only one model ran')
    assert.equal(compared.chapterId, 'ch-0001')
    assert.deepEqual([...compared.columns], [...REVIEW_COMPARE_COLUMNS])
    assert.ok(compared.markdown.includes('model-a'))

    // The route's projection is the same computation (kind: read-only, no write).
    const projection = buildReviewCompare({ sessionId: 's-1', root: fixture.root }, '0.0.0-test', { chapterId: 'ch-0001' })
    assert.equal(projection.status, 200)
    assert.deepEqual(projection.body.value.columns, [...REVIEW_COMPARE_COLUMNS])
    assert.equal(projection.body.value.markdown, compared.markdown)
    const notFound = buildReviewCompare({ sessionId: 's-1', root: fixture.root }, '0.0.0-test', { chapterId: 'nope' })
    assert.equal(notFound.status, 404)
  } finally {
    fixture.done()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('工具：review_context 在空书上给结构化拒绝，不抛', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-review-empty-'))
  const fixture = book()
  try {
    const harness = makeTools(join(dir, 'state'), fixture.dir)
    const refused = await callTool(harness, 'inkflow_review_context', { projectRoot: fixture.root, chapterId: 'nope' })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'CHAPTER_NOT_FOUND')
    assert.equal(typeof refused.error.hint, 'string')
  } finally {
    fixture.done()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('面板纯模型：三态、跳转形状、证据行与空值', async () => {
  const model = await loadClientModel('review-model.ts')
  assert.equal(model.reviewPanelState({ loading: true, result: null }), 'loading')
  assert.equal(model.reviewPanelState({ loading: false, result: null }), 'error')
  assert.equal(model.reviewPanelState({ loading: false, result: { ok: false, status: 500 } }), 'error')
  assert.equal(model.reviewPanelState({ loading: false, result: { ok: true, status: 200, value: {} } }), 'ready')

  // A located opinion gets the candidate page's jump shape; an unlocated one gets none.
  const jump = model.evidenceJumpOf({ kind: 'path', path: 'chapters/vol-01/0001-ch-0001.md', line: 7 })
  assert.deepEqual(jump, { kind: 'chapter', path: 'chapters/vol-01/0001-ch-0001.md', line: 7 })
  assert.equal(model.evidenceJumpOf(null), null)
  assert.equal(model.addressOf({ kind: 'path', path: 'a.md', line: 3 }), 'a.md#L3')

  const view = model.readReviewValue({
    chapterId: 'ch-0001',
    chapterTitle: '第一章',
    wordCount: 120,
    paragraphCount: 3,
    recordDir: '.inkflow/review/ch-0001',
    runCount: 1,
    runs: [{ runId: 'r1', reviewer: 'model-a', createdAt: 'now', opinions: 2, located: 1, failed: 0, skipped: 0, scores: { style: 5 } }],
    selected: {
      runId: 'r1',
      reviewer: 'model-a',
      createdAt: 'now',
      scores: { style: 5 },
      rejected: [{ index: 0, code: 'REVIEW_TEXT_REQUIRED', message: 'x' }],
      dimensions: [
        {
          dimension: 'style',
          label: '文风',
          status: 'ok',
          opinions: 2,
          located: 1,
          code: null,
          message: null,
          anchors: { sentences: 4 },
          opinionsList: [],
        },
      ],
      opinions: [
        {
          dimension: 'style',
          code: 'REVIEW_STYLE',
          severity: 'warning',
          located: true,
          locator: { kind: 'path', path: 'chapters/vol-01/0001-ch-0001.md', line: 4 },
          evidence: { before: '前', quote: '原文', after: '后', paragraph: 1, offset: 3, source: 'quote' },
          detail: '太匀',
          hint: '改短',
          fixable: false,
        },
        {
          dimension: 'style',
          code: 'REVIEW_STYLE',
          severity: 'info',
          located: false,
          locator: null,
          unlocatedReason: 'REVIEW_HINT_MISSING',
          unlocatedDetail: '给个 quote',
          detail: '没定位',
          hint: '',
          fixable: false,
          evidence: null,
        },
      ],
    },
  })
  assert.equal(view.runCount, 1)
  assert.equal(view.selectedRunId, 'r1')
  assert.deepEqual(view.selectedScores, [{ dimension: 'style', value: 5 }])
  assert.equal(view.dimensions.length, 1)
  const items = view.dimensions[0].items
  assert.equal(items.length, 2)
  assert.equal(items[0].located, true)
  assert.equal(items[0].where, 'chapters/vol-01/0001-ch-0001.md#L4')
  assert.equal(items[0].jump === null, false)
  assert.equal(items[1].located, false)
  assert.equal(items[1].jump, null)
  assert.equal(model.evidenceLine(items[0]), '…前【原文】后…')
  assert.equal(model.evidenceLine(items[1]), '')
  assert.equal(view.dimensions[0].anchors[0].value, '4')
  assert.equal(model.readReviewValue(undefined), model.EMPTY_REVIEW)
  assert.equal(model.describeRun(view.runs[0]).includes('model-a'), true)
})

/**
 * #199: the panel's fold, as a pure decision.
 *
 * The list is one page plus a count of what is behind it; opening the fold must not
 * *renumber* the fold (the older rows are always the ones past the host's boundary), and a
 * book whose runs all fit must never show a fold row at all.
 *
 * Fails if: `splitRuns` is missing, the boundary is taken from `runs.length` instead of
 * `foldLimit`, or the older rows are returned in a different order than the host sent them.
 */
test('面板纯模型：运行列表分「当前一页」与「更早的 N 次」（#199）', async () => {
  const model = await loadClientModel('review-model.ts')
  const rows = Array.from({ length: 25 }, (_, index) => ({
    runId: `r${String(25 - index).padStart(2, '0')}`,
    reviewer: 'model-a',
    createdAt: '2026-10-25T09:55:01.123Z',
    opinions: 1,
    located: 1,
    failed: 0,
    skipped: 0,
    scores: null,
  }))

  const folded = model.splitRuns({ runCount: 25, foldLimit: 20, runs: rows.slice(0, 20) })
  assert.equal(folded.recent.length, 20)
  assert.equal(folded.older.length, 0, 'the first page carries no older row: they are behind the fold')
  assert.equal(folded.olderCount, 5, 'the fold row says how many runs are behind it')

  const expanded = model.splitRuns({ runCount: 25, foldLimit: 20, runs: rows })
  assert.equal(expanded.recent.length, 20)
  assert.equal(expanded.older.length, 5)
  assert.equal(expanded.olderCount, 5)
  assert.equal(expanded.older[0].runId, 'r05', 'older runs keep the host order (newest first)')
  assert.equal(expanded.older.at(-1).runId, 'r01')

  const everything = model.splitRuns({ runCount: 3, foldLimit: 20, runs: rows.slice(0, 3) })
  assert.equal(everything.olderCount, 0, 'a book that fits shows no fold row')
  assert.equal(everything.older.length, 0)
  assert.equal(everything.recent.length, 3)
})

/** Bundle one client model on the fly (the panel tests' own trick: same compiler). */
async function loadClientModel(file) {
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const esbuild = require('esbuild')
  const built = await esbuild.build({
    entryPoints: [join(repoRoot, 'src/client', file)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    write: false,
    logLevel: 'silent',
  })
  const code = Buffer.from(built.outputFiles[0].text, 'utf8').toString('base64')
  return import(`data:text/javascript;base64,${code}`)
}
