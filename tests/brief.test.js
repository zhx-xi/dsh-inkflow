/**
 * Issue #43 — the nine-segment brief (ADR-0022 D1/D2/D4, roadmap X-23/X-25).
 *
 * The brief is the one place where "what the model is about to be told" becomes a fact
 * instead of a claim, so this suite pins the five properties that make it worth having:
 *
 *   1. **the segment table** — nine ids, one order, in the array, in the rendered text and
 *      in the audit file's field order. A caller may not reorder any of them (D2);
 *   2. **the ladder** — `world → facts → foreshadow → prevTail`, and the first three
 *      segments are never trimmed. Over budget is reported, never hidden by dropping the
 *      chapter's task statement (D2);
 *   3. **preview = injection** — two calls with the same input are equal field by field,
 *      and the audit record carries exactly the preview's segment fields (D1). This is the
 *      property a second assembly would break, and the reason there is only one;
 *   4. **determinism** — the audit file is the same bytes twice, with no clock, no random
 *      id and no absolute path, and it lands in `.inkflow/audit/` while `index/` gains
 *      nothing (D4, X-25);
 *   5. **no invented content** — `promise` and `anchors` have no source yet (X-26), so they
 *      are `missing: true` with zero bytes, and no placeholder heading reaches the text.
 *
 * Runs against the BUILT artifacts (`lib/index.js`), like every other suite.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BRIEF_CAP_RATIOS,
  BRIEF_LABELS,
  BRIEF_SEGMENT_ORDER,
  BRIEF_TRIM_ORDER,
  EXTRA_SEGMENTS,
  MAX_TAGGED_CHARS,
  apply,
  briefAuditPath,
  briefAuditRecord,
  briefFor,
  briefRunSummary,
  buildDiagnostics,
  briefWire,
  buildIndex,
  buildWritingBrief,
  estimateTokens,
  resetBriefRunSummary,
  serializeBriefAudit,
  writeBriefAudit,
} from '../lib/index.js'

const HOST = '127.0.0.1:2149'
const INTERNAL = '/inkflow/internal'
const DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-brief-'))
}

function scaffold(root) {
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, '.git'))
  for (const dir of DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '简报之书' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.gitignore'), 'index/*.db\nindex/*.db-wal\nindex/*.db-shm\n.inkflow/\n', 'utf8')
}

function writeMarkdown(root, relativePath, frontmatterLines, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = frontmatterLines.length > 0 ? `---\n${frontmatterLines.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

/** A book that can fill seven of the nine segments: cast, ledger, foreshadow, world, tail. */
async function book(root) {
  scaffold(root)
  writeMarkdown(
    root,
    'chapters/vol-01/0001-开端.md',
    ['id: ch-0001', 'title: 开端', 'volume: vol-01', 'seq: 1'],
    `${'第一章正文，青萍宗的山门在雨里。\n'.repeat(20)}`,
  )
  writeMarkdown(
    root,
    'chapters/vol-01/0002-起风.md',
    ['id: ch-0002', 'title: 起风', 'volume: vol-01', 'seq: 2'],
    `${'第二章正文，断剑仍在鞘中。\n'.repeat(20)}`,
  )
  // The outline names two people and one world entry: that is what the cast and the
  // world-book segments match against (the chapter being written has no prose yet).
  writeMarkdown(
    root,
    'outlines/ch-0002.md',
    ['id: oc-2', 'kind: chapter', 'title: 起风', 'parent: overall'],
    `${'- 起风：清音在青萍宗后山见到信物，师父提及断剑。\n'.repeat(30)}`,
  )
  writeMarkdown(root, 'outlines/overall.md', ['kind: overall', 'title: 总纲'], '- 故事线\n')
  writeMarkdown(root, 'world/门派/青萍宗.md', ['title: 青萍宗', 'category: 门派', 'keywords: 青萍'], '青萍宗，剑修门派。\n')
  writeMarkdown(
    root,
    'characters/清音.md',
    [
      'id: c-qingyin',
      'name: 清音',
      'role: 主角',
      'pov: 清音',
      'firstAppearance: 1',
      'voice: [短句，少形容词, 口头禅「罢了」]',
      'states: [1: 初入青萍, 2: 代掌门]',
    ],
    '青萍宗弟子。\n',
  )
  writeMarkdown(
    root,
    'foreshadowing/断剑.md',
    ['id: fs-1', 'title: 断剑', 'status: planted', 'plantedAt: ch-0001', 'dueBy: ch-0002'],
    '断剑埋在第一处。\n',
  )
  writeMarkdown(
    root,
    'facts/清音.md',
    ['subject: c-qingyin'],
    '- attribute: 境界 | value: 金丹初期 | since: ch-0001 | chapterId: ch-0001\n',
  )
  await buildIndex(root)
  return root
}

/** `BRIEF_SEGMENT_ORDER` as a plain array, so the assertions read like the ADR. */
const ORDER = [...BRIEF_SEGMENT_ORDER]

// ---------------------------------------------------------------------------
// 1. The segment table
// ---------------------------------------------------------------------------

test('brief: nine segments, ADR-0022 D2 order, ids and labels agree with the registry', async () => {
  const dir = workdir()
  try {
    const root = await book(join(dir, 'book'))
    // A generous budget: this test is about the table, not about the ladder.
    const brief = buildWritingBrief(root, { budgetTokens: 20_000 })

    assert.deepEqual(
      ORDER,
      ['outline', 'promise', 'characters', 'voice', 'facts', 'foreshadow', 'world', 'prevTail', 'anchors'],
      'the constant table is written down once, in D2 order',
    )
    assert.deepEqual(brief.segments.map((segment) => segment.id), ORDER, 'the record lists all nine, in order')
    assert.deepEqual([...BRIEF_TRIM_ORDER], ['world', 'facts', 'foreshadow', 'prevTail'], 'the ladder is D2 verbatim')

    // Every record carries the four fields D1 asks for, and they agree with each other.
    for (const segment of brief.segments) {
      assert.equal(typeof segment.label, 'string')
      assert.equal(segment.bytes, Buffer.byteLength(segment.text, 'utf8'), `${segment.id}: bytes describe its own text`)
      assert.equal(segment.tokens >= 0, true)
      assert.equal(typeof segment.truncated, 'boolean')
      assert.equal(typeof segment.missing, 'boolean')
      // A segment with no source has no size at all: no half-filled record.
      if (segment.missing) {
        assert.equal(segment.text, '')
        assert.equal(segment.bytes, 0)
        assert.equal(segment.tokens, 0)
      }
    }

    // The labels are the author's words, and the two registered segments keep the labels
    // their own modules publish (a second spelling would read as a second segment).
    for (const spec of EXTRA_SEGMENTS) {
      assert.equal(BRIEF_LABELS[spec.name], spec.label, `${spec.name}: the registry and the table must agree`)
    }
    // The shares in the table agree with the registry too, so a retuned cap cannot live in
    // only one of the two places.
    for (const spec of EXTRA_SEGMENTS) {
      assert.equal(BRIEF_CAP_RATIOS[spec.name], spec.capRatio, `${spec.name}: cap ratio drift`)
    }

    // Order on the wire, not just in the array: the rendered block repeats D2's order.
    const positions = ['### 当前章', '### 本章人物', '### 语言基因', '### 账本事实', '### 伏笔提示', '### 世界书', '### 上一章结尾']
      .map((heading) => brief.text.indexOf(heading))
      .filter((position) => position >= 0)
    assert.ok(positions.length === 7, `every sourced segment heading must be rendered, saw ${String(positions.length)}`)
    assert.deepEqual(positions, [...positions].sort((left, right) => left - right), 'the text follows the table order')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('brief: characters and voice come from the cards the chapter names, not from the whole book', async () => {
  const dir = workdir()
  try {
    const root = await book(join(dir, 'book'))
    // A card the outline never mentions, introduced before this chapter: it must not appear.
    writeMarkdown(
      root,
      'characters/路人.md',
      ['id: c-extra', 'name: 无名路人', 'firstAppearance: 1', 'voice: [沉默寡言]'],
      '路人。\n',
    )
    await buildIndex(root)

    const brief = buildWritingBrief(root)
    const cast = brief.segments.find((segment) => segment.id === 'characters')
    const voice = brief.segments.find((segment) => segment.id === 'voice')
    assert.ok(cast !== undefined && voice !== undefined)
    assert.equal(cast.missing, false, 'the book has cards and the outline names one')
    assert.match(cast.text, /清音/)
    assert.match(cast.text, /代掌门/, 'the status in force at this chapter, from `character_states`')
    assert.match(cast.text, /characters\/清音\.md/, 'the path lets the model open the card')
    assert.equal(cast.text.includes('无名路人'), false, 'a card this chapter never names stays out')

    assert.equal(voice.missing, false)
    assert.match(voice.text, /短句，少形容词/)
    assert.match(voice.text, /口头禅「罢了」/)
    assert.equal(voice.text.includes('沉默寡言'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. The ladder
// ---------------------------------------------------------------------------

test('brief: the ladder trims world → facts → foreshadow → prevTail and never the first three', async () => {
  const dir = workdir()
  try {
    const root = await book(join(dir, 'book'))
    const full = buildWritingBrief(root, { budgetTokens: 20_000 })
    assert.deepEqual(full.trims, [], 'a generous budget trims nothing')
    const never = new Set(['outline', 'promise', 'characters'])

    const reached = new Map()
    let previousCount = Number.POSITIVE_INFINITY
    // `+ 10` so the grid always contains a budget at or above the untrimmed cost: the last
    // step is a fixed 10, so a `full.tokens` that is not on the grid would never be tried
    // and "nothing is trimmed" would look unreachable (observed after #219, whose header
    // moved `full.tokens` off the grid).
    for (let budgetTokens = 20; budgetTokens <= full.tokens + 10; budgetTokens += 10) {
      const brief = buildWritingBrief(root, { budgetTokens })
      const trimmed = brief.trims.map((trim) => trim.segment)
      // A segment can be trimmed twice (the tail shrinks, then it is dropped), so the
      // ORDER is asserted on the sequence of distinct ids: that is a prefix of D2's
      // ladder, and nothing is ever trimmed out of turn.
      const distinct = [...new Set(trimmed)]
      assert.deepEqual(distinct, [...BRIEF_TRIM_ORDER].slice(0, distinct.length), `budget ${String(budgetTokens)}: ${trimmed.join(',')}`)
      assert.ok(trimmed.filter((id) => id === 'prevTail').length <= 2, 'the tail shrinks once, then drops once')
      // The first three never appear in the trim record, whatever the budget.
      for (const id of trimmed) assert.equal(never.has(id), false, `${id} must never be trimmed`)
      // … and the task statement is still on the wire: over budget, not silently emptied.
      const outline = brief.segments.find((segment) => segment.id === 'outline')
      assert.ok(outline !== undefined)
      assert.equal(outline.missing, false, `budget ${String(budgetTokens)}: the chapter segment is not dropped`)
      assert.ok(brief.text.includes('### 当前章'), `budget ${String(budgetTokens)}: the chapter block is rendered`)

      assert.ok(brief.trims.length <= previousCount, 'a bigger budget never trims more')
      previousCount = brief.trims.length

      // Every trim names a segment that really had content, and reports what it cost.
      for (const trim of brief.trims) {
        assert.ok(trim.before > 0, `${trim.segment}: only a present segment can be trimmed`)
        assert.ok(trim.after < trim.before, `${trim.segment}: a trim must reduce the cost`)
        assert.ok(trim.ratio > 0 && trim.ratio <= 1, `${trim.segment}: ratio is a fraction`)
      }
      reached.set(distinct.join('|'), brief)
    }

    // Every rung is reachable, from "nothing trimmed" to "all four gone".
    for (let depth = 0; depth <= BRIEF_TRIM_ORDER.length; depth += 1) {
      const key = [...BRIEF_TRIM_ORDER].slice(0, depth).join('|')
      assert.ok(reached.has(key), `rung "${key}" is reachable`)
    }

    // A tiny budget ends up over budget with the record saying so, instead of pretending.
    const squeezed = buildWritingBrief(root, { budgetTokens: 20 })
    assert.equal(squeezed.overBudget, true, 'outline/promise/characters are not droppable, so it overruns')
    assert.deepEqual([...new Set(squeezed.trims.map((trim) => trim.segment))], [...BRIEF_TRIM_ORDER])
    assert.match(squeezed.text, /\[trimmed: /)
    assert.equal(
      squeezed.segments.filter((segment) => never.has(segment.id) && segment.missing).length,
      1,
      'only `promise` is missing among the three: `outline` and `characters` have sources',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. Preview = injection (one assembly, one input)
// ---------------------------------------------------------------------------

test('brief: two calls with the same input are equal, and the audit record is the preview', async () => {
  const dir = workdir()
  try {
    const root = await book(join(dir, 'book'))
    const options = { budgetTokens: 300, tailChars: 200, chapterSeq: 2 }
    const first = briefFor(root, options)
    const second = briefFor(root, options)

    assert.deepEqual(second.segments, first.segments, 'segments: same input, same answer')
    assert.deepEqual(second.trims, first.trims, 'trims too')
    assert.equal(second.tokens, first.tokens)
    assert.equal(second.text, first.text)
    assert.equal(second.chapterId, first.chapterId)

    // The audit document is built from the brief, not from a second computation: every
    // field the preview shows must be identical to the field the file records.
    const record = briefAuditRecord(first)
    const preview = briefWire(first)
    const pick = (segment) => ({
      id: segment.id,
      label: segment.label,
      bytes: segment.bytes,
      tokens: segment.tokens,
      truncated: segment.truncated,
      missing: segment.missing,
    })
    assert.deepEqual(record.segments, preview.segments.map(pick))
    assert.deepEqual(record.trims, preview.trims)
    assert.equal(record.tokens, preview.tokens)
    assert.equal(record.budgetTokens, preview.budgetTokens)
    assert.equal(record.chapterId, preview.chapterId)
    assert.equal(record.overBudget, preview.overBudget)
    // The preview is the only place the prose travels.
    assert.ok(preview.text.length > 0)
    assert.equal(JSON.stringify(record).includes('起风正文'), false, 'the audit record carries no prose')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. The audit file: determinism, location, and a clean index/
// ---------------------------------------------------------------------------

test('brief: the audit file is the same bytes twice, with no clock and no absolute path', async () => {
  const dir = workdir()
  try {
    const root = await book(join(dir, 'book'))
    const relative = briefAuditPath('ch-0002')
    assert.equal(relative, '.inkflow/audit/brief-ch-0002.json', 'the name is the chapter, not the run (D4)')

    const indexBefore = readdirSync(join(root, 'index')).sort()
    // #219: the record gained the book header, so the two briefs are kept to prove the
    // header is a function of the tree like every other field.
    const firstBrief = buildWritingBrief(root)
    const first = writeBriefAudit(root, firstBrief)
    assert.equal(first.ok, true, first.ok ? '' : first.message)
    const firstBytes = readFileSync(join(root, relative), 'utf8')
    const secondBrief = buildWritingBrief(root)
    const second = writeBriefAudit(root, secondBrief)
    assert.equal(second.ok, true, second.ok ? '' : second.message)
    const secondBytes = readFileSync(join(root, relative), 'utf8')
    assert.equal(secondBrief.header, firstBrief.header, 'the header carries no clock either')

    assert.equal(secondBytes, firstBytes, 'two runs over an unchanged book are byte-identical')
    assert.equal(second.sha256, first.sha256, 'and hash the same')
    assert.equal(first.sha256.length, 64)

    // The content is a fact about the book, so it carries nothing machine-specific.
    assert.equal(/[A-Za-z]:[\\/]/u.test(firstBytes), false, 'no drive-qualified path')
    assert.equal(firstBytes.includes(root.replaceAll('\\', '/')), false, 'no absolute root')
    assert.equal(firstBytes.includes(tmpdir().replaceAll('\\', '/')), false, 'no temp directory')
    assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(firstBytes), false, 'no timestamp')
    assert.equal(firstBytes.includes('起风正文'), false, 'no chapter prose')

    // Parsed: the format/schema are declared, and the order is D2's.
    const parsed = JSON.parse(firstBytes)
    assert.equal(parsed.format, 'inkflow.brief-audit')
    // #219 bumped this: the record's shape gained `header` (an additive field, but the
    // key set is the contract, so a reader must be able to tell the two shapes apart).
    assert.equal(parsed.schemaVersion, 2)
    assert.equal(parsed.chapterId, 'ch-0002')
    assert.equal(parsed.chapterPath, 'chapters/vol-01/0002-起风.md')
    // The book identity is recorded verbatim — the same bytes the model is handed.
    assert.equal(parsed.header, firstBrief.header)
    assert.equal(firstBrief.text.split('\n')[0], parsed.header, 'the header is the text\'s first line')
    assert.deepEqual(Object.keys(parsed), ['format', 'schemaVersion', 'chapterId', 'chapterSeq', 'chapterPath', 'header', 'budgetTokens', 'tokens', 'overBudget', 'segments', 'trims'], 'top-level key order is the contract too')
    assert.deepEqual(parsed.segments.map((segment) => segment.id), ORDER)
    for (const segment of parsed.segments) {
      assert.deepEqual(Object.keys(segment), ['id', 'label', 'bytes', 'tokens', 'truncated', 'missing'], 'field order is the contract')
    }
    assert.equal(serializeBriefAudit(parsed), firstBytes, 'the serialiser round-trips its own bytes')

    // X-25: `index/` only ever holds `.gitkeep` and the database; the record is private state.
    const indexAfter = readdirSync(join(root, 'index')).sort()
    assert.deepEqual(indexAfter, indexBefore, 'the audit write adds nothing under index/')
    for (const name of indexAfter) {
      assert.ok(name === '.gitkeep' || name.startsWith('inkflow.db'), `unexpected file under index/: ${name}`)
    }
    assert.equal(existsSync(join(root, '.inkflow', 'audit')), true)
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8').includes('.inkflow/'), true, 'the private dir stays ignored')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('brief: the audit file name falls back to the chapter seq when the id is missing', async () => {
  const dir = workdir()
  try {
    const root = await book(join(dir, 'book'))
    // No `id:` in the frontmatter: the key must still be stable and filesystem-safe.
    writeMarkdown(root, 'chapters/vol-01/0002-起风.md', ['title: 起风', 'volume: vol-01', 'seq: 2'], '第二章正文。\n')
    await buildIndex(root)
    const brief = buildWritingBrief(root)
    assert.equal(brief.chapterId, 'seq-2')
    assert.equal(briefAuditPath(brief.chapterId), '.inkflow/audit/brief-seq-2.json')

    // A hand-written id with path characters is sanitised, never used as a path.
    writeMarkdown(root, 'chapters/vol-01/0002-起风.md', ['id: ../../etc/passwd', 'title: 起风', 'seq: 2'], '第二章正文。\n')
    await buildIndex(root)
    const hostile = buildWritingBrief(root)
    assert.equal(hostile.chapterId?.includes('/'), false)
    assert.equal(hostile.chapterId?.includes('..') !== true || !hostile.chapterId.includes('/'), true)
    assert.equal(briefAuditPath(hostile.chapterId).startsWith('.inkflow/audit/brief-'), true)
    const written = writeBriefAudit(root, hostile)
    assert.equal(written.ok, true, written.ok ? '' : written.message)
    assert.equal(written.ok && written.path.startsWith('.inkflow/audit/brief-'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. No invented content
// ---------------------------------------------------------------------------

test('brief: a segment with no source is missing, never a placeholder', async () => {
  const dir = workdir()
  try {
    const root = await book(join(dir, 'book'))
    const brief = buildWritingBrief(root)
    const promise = brief.segments.find((segment) => segment.id === 'promise')
    const anchors = brief.segments.find((segment) => segment.id === 'anchors')
    assert.deepEqual(promise, { id: 'promise', label: BRIEF_LABELS.promise, text: '', bytes: 0, tokens: 0, truncated: false, missing: true })
    assert.deepEqual(anchors, { id: 'anchors', label: BRIEF_LABELS.anchors, text: '', bytes: 0, tokens: 0, truncated: false, missing: true })
    // Nothing about them reaches the model: no heading, no "（待补）", no empty section.
    for (const label of [BRIEF_LABELS.promise, BRIEF_LABELS.anchors]) {
      assert.equal(brief.text.includes(label), false, `${label} must not be rendered`)
    }
    assert.equal(brief.text.includes('待补'), false)
    assert.equal(brief.text.includes('占位'), false)

    // An empty book: every segment with a source is missing too, and the brief still answers.
    const empty = join(dir, 'empty')
    scaffold(empty)
    await buildIndex(empty)
    const nothing = buildWritingBrief(empty)
    assert.deepEqual(nothing.segments.map((segment) => segment.id), ORDER)
    assert.equal(nothing.segments.every((segment) => segment.missing || segment.text === ''), true)
    assert.equal(nothing.text.trim(), '', 'no heading, no filler')
    assert.equal(nothing.overBudget, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5b. The two marker segments: `[承诺]` / `[锚点]` in the chapter's own outline (#213)
// ---------------------------------------------------------------------------

/**
 * #213 gives `promise` and `anchors` a source: two marker lines the author writes in the
 * chapter-level outline node (`outlines/ch-<seq>.md`, the same file the `outline` segment
 * renders). `[承诺]` / `[锚点]` join `[故事线]` as plot-point tags, so no frontmatter field
 * and no new file type is involved (ADR-0019's read-back contract is untouched).
 *
 * The honesty rule survives the new source: lines that are not in **this** chapter's node
 * leave the segment `missing`, and the marker itself is not content.
 */
test('brief: the chapter outline writes [承诺] / [锚点] lines and the two segments carry them (#213)', async () => {
  const dir = workdir()
  try {
    const root = await book(join(dir, 'book'))
    writeMarkdown(
      root,
      'outlines/ch-0002.md',
      ['id: oc-2', 'kind: chapter', 'title: 起风', 'parent: overall'],
      [
        '- [故事线] 起风：清音在青萍宗后山见到信物。',
        '- [承诺] 断剑的来历这一章必须露一角。',
        '- 普通的细纲条目，不带标记。',
        '- [锚点] 复沓句「剑未出鞘，雨先落」。',
        '',
      ].join('\n'),
    )
    await buildIndex(root)
    const brief = buildWritingBrief(root, { budgetTokens: 20_000 })

    const promise = brief.segments.find((segment) => segment.id === 'promise')
    const anchors = brief.segments.find((segment) => segment.id === 'anchors')
    assert.ok(promise !== undefined && anchors !== undefined)
    assert.equal(promise.missing, false, 'the chapter wrote a [承诺] line')
    assert.equal(promise.truncated, false)
    assert.match(promise.text, /断剑的来历这一章必须露一角。/, 'the words are the author\'s, not a summary')
    assert.equal(promise.text.includes('[承诺]'), false, 'the marker is a marker, not content')
    assert.equal(promise.text.includes('普通的细纲条目'), false, 'a bullet without the tag is not a promise')

    assert.equal(anchors.missing, false)
    assert.equal(anchors.truncated, false)
    assert.match(anchors.text, /剑未出鞘，雨先落/)
    assert.equal(anchors.text.includes('[锚点]'), false)

    // D2 order on the wire: right after the chapter block, and last of the nine.
    const at = (needle) => brief.text.indexOf(needle)
    assert.ok(at('### 当前章') >= 0)
    assert.ok(at(`### ${BRIEF_LABELS.promise}`) > at('### 当前章'), 'promise sits after outline')
    assert.ok(at(`### ${BRIEF_LABELS.promise}`) < at('### 本章人物'), 'promise sits before characters')
    assert.ok(at(`### ${BRIEF_LABELS.anchors}`) > at('### 上一章结尾'), 'anchors closes the nine')

    // The three surfaces are one computation (X-23): preview twice, injected text, audit file.
    const again = buildWritingBrief(root, { budgetTokens: 20_000 })
    assert.equal(again.text, brief.text, 'two assemblies of one tree are the same bytes')
    assert.deepEqual(again.segments, brief.segments)
    assert.ok(brief.text.includes(`### ${BRIEF_LABELS.promise}`), 'the injected text carries the segment')

    const written = writeBriefAudit(root, brief)
    assert.equal(written.ok, true, written.ok ? '' : written.message)
    const auditFile = join(root, '.inkflow', 'audit', 'brief-ch-0002.json')
    const firstBytes = readFileSync(auditFile, 'utf8')
    const parsed = JSON.parse(firstBytes)
    for (const id of ['promise', 'anchors']) {
      const fromFile = parsed.segments.find((segment) => segment.id === id)
      const fromPreview = briefWire(brief).segments.find((segment) => segment.id === id)
      // Same six fields, same values: the file records what the preview showed (D1).
      assert.deepEqual(
        fromFile,
        {
          id: fromPreview.id,
          label: fromPreview.label,
          bytes: fromPreview.bytes,
          tokens: fromPreview.tokens,
          truncated: fromPreview.truncated,
          missing: fromPreview.missing,
        },
        `${id}: the audit row is the preview row`,
      )
      assert.equal(fromFile.bytes, Buffer.byteLength(fromPreview.text, 'utf8'), `${id}: bytes describe the text the model sees`)
      assert.equal(fromFile.missing, false)
    }
    writeBriefAudit(root, buildWritingBrief(root, { budgetTokens: 20_000 }))
    assert.equal(readFileSync(auditFile, 'utf8'), firstBytes, 'same input, same file bytes')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('brief: markers written in another chapter do not fill this one, and a card is no fallback (#213)', async () => {
  const dir = workdir()
  try {
    const root = await book(join(dir, 'book'))
    // Last chapter's node carries both markers; this chapter's node carries neither.
    writeMarkdown(
      root,
      'outlines/ch-0001.md',
      ['id: oc-1', 'kind: chapter', 'title: 开端', 'parent: overall'],
      ['- [承诺] 上一章的承诺。', '- [锚点] 上一章的锚点。', ''].join('\n'),
    )
    // A card that reads like a promise: still not a source (the card is a card).
    writeMarkdown(
      root,
      'characters/清音.md',
      ['id: c-qingyin', 'name: 清音', 'role: 主角', 'firstAppearance: 1', 'states: [2: 代掌门]'],
      '承诺：她会带着断剑回来。\n',
    )
    await buildIndex(root)

    // The fixture is live: chapter 1's own node DOES fill both segments, so the
    // "missing" assertion below is about this chapter, not about a dead file name.
    const first = buildWritingBrief(root, { budgetTokens: 20_000, chapterSeq: 1 })
    assert.match(first.segments.find((entry) => entry.id === 'promise').text, /上一章的承诺/)
    assert.match(first.segments.find((entry) => entry.id === 'anchors').text, /上一章的锚点/)

    const brief = buildWritingBrief(root, { budgetTokens: 20_000 })
    assert.equal(brief.chapterSeq, 2, 'the brief is about the chapter that was asked for')

    for (const id of ['promise', 'anchors']) {
      const segment = brief.segments.find((entry) => entry.id === id)
      assert.deepEqual(
        segment,
        { id, label: BRIEF_LABELS[id], text: '', bytes: 0, tokens: 0, truncated: false, missing: true },
        `${id}: this chapter wrote no marker, so it stays honestly missing`,
      )
      assert.equal(brief.text.includes(BRIEF_LABELS[id]), false, `${id}: no heading on the wire either`)
    }
    assert.equal(brief.text.includes('上一章的承诺'), false, 'never borrowed from the previous chapter')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('brief: over-long marker lines are clipped with the segment kept, never trimmed by the ladder (#213)', async () => {
  const dir = workdir()
  try {
    const root = await book(join(dir, 'book'))
    const longPromise = `承诺开头${'要'.repeat(600)}`
    const longAnchor = `锚点开头${'回'.repeat(600)}`
    writeMarkdown(
      root,
      'outlines/ch-0002.md',
      ['id: oc-2', 'kind: chapter', 'title: 起风', 'parent: overall'],
      [`- [承诺] ${longPromise}`, `- [锚点] ${longAnchor}`, ''].join('\n'),
    )
    await buildIndex(root)

    // A generous budget: the cap, not the ladder, is what shortens these two.
    const roomy = buildWritingBrief(root, { budgetTokens: 20_000 })
    for (const [id, head] of [['promise', '承诺开头'], ['anchors', '锚点开头']]) {
      const segment = roomy.segments.find((entry) => entry.id === id)
      assert.equal(segment.missing, false, `${id}: there is a source, so it is not missing`)
      assert.equal(segment.truncated, true, `${id}: the cap had to shorten it`)
      assert.ok(segment.text.length <= MAX_TAGGED_CHARS, `${id}: the segment stays inside its cap`)
      assert.ok(segment.text.includes(head), `${id}: the head survives (clipHead, not clipTail)`)
      assert.ok(segment.text.includes('…（截断）'), `${id}: a clipped body says so`)
      assert.deepEqual(roomy.trims.map((trim) => trim.segment), [], 'a roomy budget trims nothing')
    }

    // A tiny budget: over budget is reported, and these two segments are still there —
    // `promise` / `anchors` are on the never-trim side of D2.
    const squeezed = buildWritingBrief(root, { budgetTokens: 20 })
    assert.equal(squeezed.overBudget, true)
    for (const id of ['promise', 'anchors']) {
      const segment = squeezed.segments.find((entry) => entry.id === id)
      assert.equal(segment.missing, false, `${id}: shrunk is not dropped`)
      assert.ok(segment.text.length > 0, `${id}: the words are still on the wire`)
    }
    const trimmed = new Set(squeezed.trims.map((trim) => trim.segment))
    assert.equal(trimmed.has('promise'), false, 'promise is never trimmed')
    assert.equal(trimmed.has('anchors'), false, 'anchors is never trimmed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. The channel: preview route and the confirm-gated audit write
// ---------------------------------------------------------------------------

function createHarness({ workspace, sessionId = 'session-1' }) {
  const routes = []
  const ctx = {
    effect(setup) {
      const dispose = setup()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    get(name) {
      if (name === 'sessions') {
        return { get: (id) => (id === sessionId ? { id, header: { cwd: workspace } } : undefined) }
      }
      if (name === 'workingDirectory') {
        return { get: (session) => session?.header?.cwd ?? workspace }
      }
      return undefined
    },
    logger() {
      return { debug() {}, info() {}, warn() {}, error() {} }
    },
    tools: { register: () => () => {} },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  apply(ctx, { dataDir: join(tmpdir(), 'inkflow-brief-state'), serveHttp: true })
  return { ctx, routes }
}

async function callRoute(harness, request) {
  const route = harness.routes.find((entry) => entry.path === '/inkflow')
  assert.ok(route, 'expected a /inkflow prefix route')
  const response = {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(key, value) {
      response.headers[key.toLowerCase()] = value
    },
    end(payload) {
      response.body = payload
    },
  }
  await route.handler(request, response)
  return {
    status: response.statusCode,
    headers: response.headers,
    json: response.body === undefined ? undefined : JSON.parse(response.body),
  }
}

function internalCall(harness, path, options = {}) {
  const query = `sessionId=${encodeURIComponent(options.sessionId ?? 'session-1')}`
  const separator = path.includes('?') ? '&' : '?'
  const headers = { host: HOST }
  if (options.origin !== undefined) headers.origin = options.origin
  const request = {
    url: `${INTERNAL}${path}${separator}${query}`,
    method: options.method ?? 'GET',
    headers,
    socket: { remoteAddress: '127.0.0.1' },
  }
  if (options.body !== undefined) {
    const buffer = Buffer.from(JSON.stringify(options.body), 'utf8')
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(buffer.length)
    request[Symbol.asyncIterator] = async function* iterate() {
      yield buffer
    }
  }
  return callRoute(harness, request)
}

test('brief: GET /brief serves the preview, POST /brief/audit needs confirm', async () => {
  const dir = workdir()
  try {
    const root = await book(join(dir, 'book'))
    const harness = createHarness({ workspace: root })

    const read = await internalCall(harness, '/brief')
    assert.equal(read.status, 200)
    assert.equal(read.json.ok, true, JSON.stringify(read.json.error))
    const value = read.json.value
    assert.deepEqual(value.segments.map((segment) => segment.id), ORDER)
    assert.equal(typeof value.tokens, 'number')
    assert.equal(value.budgetTokens > 0, true)
    assert.equal(value.auditPath, '.inkflow/audit/brief-ch-0002.json')
    assert.equal(typeof value.text, 'string')
    for (const segment of value.segments) {
      for (const key of ['id', 'label', 'bytes', 'tokens', 'truncated', 'missing']) {
        assert.equal(key in segment, true, `${segment.id} carries ${key}`)
      }
    }
    // The preview is read-only: nothing landed on disk yet.
    assert.equal(existsSync(join(root, '.inkflow', 'audit')), false, 'a preview writes no audit')

    // A write verb on the read route is a 405 with the Allow header.
    const wrongVerb = await internalCall(harness, '/brief', { method: 'POST', body: {} })
    assert.equal(wrongVerb.status, 405)
    assert.equal(wrongVerb.headers.allow, 'GET')

    // Cross-site Origin is refused before the handler runs.
    const crossSite = await internalCall(harness, '/brief', { origin: 'http://evil.example' })
    assert.equal(crossSite.status, 403)

    // No confirm, no file.
    const refused = await internalCall(harness, '/brief/audit', { method: 'POST', origin: `http://${HOST}`, body: {} })
    assert.equal(refused.status, 400)
    assert.equal(refused.json.error.code, 'CONFIRM_REQUIRED')
    assert.equal(existsSync(join(root, '.inkflow', 'audit', 'brief-ch-0002.json')), false)

    const written = await internalCall(harness, '/brief/audit', {
      method: 'POST',
      origin: `http://${HOST}`,
      body: { confirm: true },
    })
    assert.equal(written.status, 200, JSON.stringify(written.json))
    assert.equal(written.json.value.written.path, '.inkflow/audit/brief-ch-0002.json')
    assert.equal(written.json.value.written.sha256.length, 64)
    const file = readFileSync(join(root, '.inkflow', 'audit', 'brief-ch-0002.json'), 'utf8')
    assert.equal(file, readFileSync(join(root, '.inkflow', 'audit', 'brief-ch-0002.json'), 'utf8'))
    assert.deepEqual(JSON.parse(file).segments.map((segment) => segment.id), ORDER)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7. The diagnostics counter (ADR-0022 D2 / ADR-0018 D5)
// ---------------------------------------------------------------------------

test('brief: the over-budget counter reaches the diagnostics package without any prose', async () => {
  const dir = workdir()
  try {
    const root = await book(join(dir, 'book'))
    resetBriefRunSummary()
    assert.deepEqual(briefRunSummary(), { runs: 0, overBudgetRuns: 0, last: null })

    briefFor(root, { budgetTokens: 20 })
    const summary = briefRunSummary()
    assert.equal(summary.runs, 1)
    assert.equal(summary.overBudgetRuns, 1)
    assert.equal(summary.last?.overBudget, true)
    // Counts and segment ids only — the tail can legitimately appear twice (shrink, drop).
    assert.deepEqual([...new Set(summary.last?.trimmed ?? [])], [...BRIEF_TRIM_ORDER])

    briefFor(root, { budgetTokens: 20_000 })
    const second = briefRunSummary()
    assert.equal(second.runs, 2)
    assert.equal(second.overBudgetRuns, 1, 'a run that fits does not add to the over-budget count')
    assert.deepEqual(second.last?.trimmed, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('brief: the diagnostics package carries those counters and no prose', async () => {
  const dir = workdir()
  try {
    const root = await book(join(dir, 'book'))
    resetBriefRunSummary()
    briefFor(root, { budgetTokens: 20 })

    const document = buildDiagnostics({ dataDir: join(dir, 'state'), version: '0.0.0-test', bookRoot: root })
    // Exactly the whitelisted keys: the section is a counter, not a dump.
    assert.deepEqual(Object.keys(document.brief).sort(), ['last', 'overBudgetRuns', 'runs'])
    assert.ok(document.brief.last !== null)
    assert.deepEqual(Object.keys(document.brief.last).sort(), ['budgetTokens', 'overBudget', 'rungs', 'tokens', 'trimmed'])
    assert.equal(document.brief.runs, 1)
    assert.equal(document.brief.overBudgetRuns, 1)
    assert.deepEqual([...new Set(document.brief.last.trimmed)], [...BRIEF_TRIM_ORDER])

    // ADR-0018 D5: no chapter prose, no setting text, no absolute path in the section.
    const section = JSON.stringify(document.brief)
    assert.equal(section.includes('断剑仍在鞘中'), false)
    assert.equal(section.includes('清音在青萍宗后山'), false)
    assert.equal(section.includes('短句，少形容词'), false)
    assert.equal(/[A-Za-z]:[\\/]/u.test(section), false)
  } finally {
    resetBriefRunSummary()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7. The book header (issue #219)
// ---------------------------------------------------------------------------

test('brief: the header names the book and the whole book, ahead of the chapter block', async () => {
  const dir = workdir()
  try {
    const root = await book(join(dir, 'book'))
    const brief = buildWritingBrief(root)

    // The writer has to know WHICH BOOK it is writing before it reads what to write. Same
    // job the retired six-segment `project` block did — without a tenth segment (D2).
    const firstLine = brief.text.split('\n')[0]
    assert.match(firstLine, /^《简报之书》· 全书 2 章 \/ \d+\.\d 万字$/u)
    assert.equal(brief.header, firstLine, 'the field is the first line, not a second spelling of it')
    assert.equal(brief.text.indexOf(brief.header), 0)
    assert.ok(brief.text.indexOf('### 当前章') > 0, 'the chapter block follows the header')

    // Nine segments means nine: the identity is brief-level, not a tenth one.
    assert.deepEqual(brief.segments.map((segment) => segment.id), ORDER)
    assert.equal(brief.segments.some((segment) => segment.id === 'project'), false, 'the retired segment stays retired')
    for (const segment of brief.segments) {
      assert.equal(segment.text.includes('《简报之书》'), false, `${segment.id}: the identity stays out of the segments`)
    }

    // Paid for out of the budget, not added on top of it.
    assert.equal(brief.tokens, estimateTokens(brief.text))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('brief: a book with no declared title is named by its directory, never invented', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '无名之卷')
    await book(root)
    // The same judgement the six-segment assembly made (`loadMaterials`: declared `title`,
    // else the directory name) — a second rule here would be a second answer to "which book".
    writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1 }, null, 2)}\n`, 'utf8')

    const brief = buildWritingBrief(root)
    assert.match(brief.text.split('\n')[0], /^《无名之卷》/u)
    assert.equal(brief.header.includes('简报之书'), false, 'the old declared title is not remembered')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('brief: the header is never trimmed — at the floor it shortens to the title alone', async () => {
  const dir = workdir()
  try {
    const root = await book(join(dir, 'book'))
    const floor = buildWritingBrief(root, { budgetTokens: 1 })

    assert.equal(floor.header, '《简报之书》', 'the counts go before the title does')
    assert.equal(floor.text.split('\n')[0], '《简报之书》')
    assert.equal(floor.overBudget, true, 'a header that does not fit is reported, not dropped')
    assert.ok(floor.text.includes('### 当前章'), 'and it is not paid for by dropping the task statement')
    assert.deepEqual([...new Set(floor.trims.map((trim) => trim.segment))], [...BRIEF_TRIM_ORDER], 'the ladder still walks its own rungs')

    // The shortening is a floor-only branch: an ordinary budget keeps the whole line.
    const normal = buildWritingBrief(root)
    assert.match(normal.header, /· 全书 \d+ 章 \/ /u)
    assert.ok(estimateTokens(normal.header) > estimateTokens(floor.header))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('brief: preview, audit file and injection carry the same header bytes', async () => {
  const dir = workdir()
  try {
    const root = await book(join(dir, 'book'))
    const brief = briefFor(root)
    const wire = briefWire(brief)
    const written = writeBriefAudit(root, brief)
    assert.equal(written.ok, true, written.ok ? '' : written.message)
    const bytes = readFileSync(join(root, briefAuditPath(brief.chapterId)), 'utf8')
    const parsed = JSON.parse(bytes)

    // X-23: one call, three consumers — so there cannot be three spellings of the header.
    assert.equal(wire.header, brief.header, 'preview')
    assert.equal(parsed.header, brief.header, 'audit file')
    // Injection is `briefFor().text` (pinned byte-for-byte in prompt.test.js); here the
    // first line of that very text is checked against the two copies above.
    assert.equal(brief.text.split('\n')[0], brief.header, 'injection')
    assert.equal(wire.text, brief.text)
    assert.equal(bytes, serializeBriefAudit(parsed), 'the file on disk is that record, byte for byte')
    assert.equal(parsed.tokens, brief.tokens, 'the header is inside the recorded token count')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
