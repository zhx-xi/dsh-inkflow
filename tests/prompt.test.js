/**
 * Writing context (issue #20): the four facts injected into a writing session's
 * system prompt — project summary, current chapter, previous chapter's tail,
 * and the world-book entries this chapter triggers.
 *
 * What is pinned here, and why:
 *
 *   1. **The projection** (`buildWritingContext`) is a pure function, so every
 *      rule the prompt depends on is asserted directly: which chapter counts as
 *      "current", how much of the previous tail travels, which world entries
 *      fire, and exactly what a tight budget drops first.
 *   2. **The gate** is the trust anchor: a directory that is not a `usable`
 *      InkFlow project must contribute *nothing* — an empty section, not an
 *      empty-looking block. The three non-usable states are each exercised.
 *   3. **The wiring** (`registerWritingContext` + `apply`) must survive a Host
 *      without the `systemPrompt` service, a duplicate registration, and a
 *      session directory that cannot be resolved: one log line, no throw, and
 *      the tools keep working.
 *
 * Everything imports the BUILT bundle (`lib/index.js`), like the rest of the
 * suite: the tests exercise what users install.
 *
 * Since #183 the injected text is the **nine-segment brief** (`buildWritingBrief`,
 * ADR-0022 D2) rather than the six-segment context; `buildWritingContext` stays
 * exported and tested because it is the other projection of the same renderers and
 * because the equivalence test below compares the two byte for byte. The three
 * assertions that used to pin the six-segment shape are marked `MIGRATED (#183)`
 * where they stand.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BRIEF_LABELS,
  BRIEF_TRIM_ORDER,
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_TAIL_CHARS,
  PROMPT_SECTION_NAME,
  PROMPT_SECTION_ORDER,
  apply,
  briefRunSummary,
  buildIndex,
  buildWritingBrief,
  buildWritingContext,
  estimateTokens,
  registerWritingContext,
  resetBriefRunSummary,
} from '../lib/index.js'

/** ADR-0006 D1: nine content directories + the derived index/, each with `.gitkeep`. */
const CONTENT_DIRS = [
  'chapters',
  'characters',
  'world',
  'outlines',
  'foreshadowing',
  'timeline',
  'relations',
  'facts',
  'library',
]
const ALL_DIRS = [...CONTENT_DIRS, 'index']

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-prompt-'))
}

function scaffold(root, { title = '测试之书', git = true, meta = { schemaVersion: 1, title } } = {}) {
  mkdirSync(root, { recursive: true })
  if (git) mkdirSync(join(root, '.git'))
  for (const dir of ALL_DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  if (meta !== null) writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.gitignore'), 'index/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
}

function writeMarkdown(root, relativePath, frontmatterLines, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = frontmatterLines.length > 0 ? `---\n${frontmatterLines.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

/** Non-blank characters, the same count the index derives (`countChars`). */
function wordCount(text) {
  return text.replace(/\s+/gu, '').length
}

// A previous chapter longer than the 300-character tail, whose first and last
// sentences are both distinctive: the test can prove the END travelled.
const PREV_OPENING = '夜色压在山道上，他一脚深一脚浅地往上走。'
const PREV_LAST = '他把灯留在门里，转身走进雪里。'
const PREV_BODY = [
  PREV_OPENING,
  '雪粒打在脸上像细针，他把领口又紧了紧。'.repeat(12),
  '山门在雾里露出一角，钟声正好响过第三下。'.repeat(8),
  PREV_LAST,
].join('\n')
assert.ok(PREV_BODY.length > DEFAULT_TAIL_CHARS * 1.2, 'the fixture has to exceed the default tail')

const CURRENT_BODY = '他推门进去，屋里空无一人。'
const OUTLINE_BODY = '- 夜行：在雾里找山门\n- 鹤鸣剑出鞘，鹤鸣声惊起白鹤'

/**
 * One project with everything the four segments need: two chapters in one
 * volume, a chapter outline, a keyword-matched world entry, a non-matching one,
 * and an `always: true` entry.
 */
async function sampleProject(root) {
  scaffold(root)
  writeMarkdown(
    root,
    'chapters/vol-01/0001-入山.md',
    ['id: ch-1', 'title: 第一章 入山', 'volume: vol-01', 'seq: 1', 'status: final'],
    PREV_BODY,
  )
  writeMarkdown(
    root,
    'chapters/vol-01/0002-夜行.md',
    ['id: ch-2', 'title: 第二章 夜行', 'volume: vol-01', 'seq: 2', 'status: draft'],
    CURRENT_BODY,
  )
  writeMarkdown(root, 'outlines/overall.md', ['id: ov', 'kind: overall', 'title: 总纲'], '- 全书线')
  writeMarkdown(root, 'outlines/vol-01.md', ['id: vol-1', 'kind: volume', 'title: 第一卷', 'parent: ov'], '- 卷线')
  writeMarkdown(
    root,
    'outlines/ch-0002.md',
    ['id: oc-2', 'kind: chapter', 'title: 第二章细纲', 'parent: vol-1'],
    OUTLINE_BODY,
  )
  writeMarkdown(
    root,
    'world/门派/白鹤门.md',
    ['id: w-1', 'title: 白鹤门', 'category: 门派', 'keywords: [白鹤门, 鹤鸣剑]'],
    '白鹤门是苍山深处的门派，以鹤鸣剑法立派，山门终年藏在雾里，外人难得其门而入。',
  )
  writeMarkdown(
    root,
    'world/人物/清音.md',
    ['id: w-2', 'title: 清音', 'category: 人物', 'keywords: [清音, 掌门]'],
    '清音是白鹤门的掌门。',
  )
  writeMarkdown(
    root,
    'world/常驻/世界规矩.md',
    ['id: w-3', 'title: 世界规矩', 'category: 常驻', 'always: true'],
    '本书没有系统面板，也没有等级数值。',
  )
  await buildIndex(root)
}

/** Fake Cordis context: `services` is what `ctx.get()` answers, nothing else. */
function createCtx({ services = {}, tools = true } = {}) {
  const logs = []
  const disposes = []
  const ctx = {
    effect(setup) {
      const dispose = setup()
      disposes.push(() => {
        if (typeof dispose === 'function') dispose()
      })
      return () => {}
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    get(serviceName) {
      if (Object.prototype.hasOwnProperty.call(services, serviceName)) return services[serviceName]
      return undefined
    },
    logger() {
      const record = (level) => (message) => logs.push({ level, text: String(message) })
      return { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') }
    },
  }
  if (tools) ctx.tools = { register: () => () => {} }
  return { ctx, logs, disposes }
}

/** Capture the sections a `systemPrompt` service would accept. */
function createPromptService({ failWith } = {}) {
  const sections = []
  return {
    sections,
    service: {
      section(section) {
        if (failWith !== undefined) throw new Error(failWith)
        sections.push(section)
        return () => {}
      },
    },
  }
}

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

test('all four segments are rendered for a usable project', async (t) => {
  const root = workdir()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await sampleProject(root)

  const result = buildWritingContext(root)

  assert.equal(result.state, 'usable')
  assert.deepEqual(
    result.segments.map((segment) => segment.name),
    ['project', 'chapter', 'tail', 'world'],
  )
  assert.deepEqual(result.trimmed, [])
  assert.equal(result.budgetTokens, DEFAULT_BUDGET_TOKENS)
  assert.equal(result.tokens, estimateTokens(result.text))

  const text = result.text
  assert.match(text, /^## 写作上下文/)

  // 1. Project summary: title, volumes, chapters, words — the counts come from
  //    the derived index, so the expected number is computed from the bodies.
  const words = wordCount(PREV_BODY) + wordCount(CURRENT_BODY)
  assert.ok(text.includes('《测试之书》'), 'book title')
  assert.ok(text.includes('1 卷'), 'volume count')
  assert.ok(text.includes('2 章'), 'chapter count')
  assert.ok(text.includes(`${words} 字`), `word count ${words}`)

  // 2. Current chapter: the newest `seq`, its frontmatter and its outline file.
  assert.ok(text.includes('### 当前章'))
  assert.ok(text.includes('标题：第二章 夜行'))
  assert.ok(text.includes('卷：vol-01'))
  assert.ok(text.includes('seq：2'))
  assert.ok(text.includes('状态：draft'))
  assert.ok(text.includes('大纲 outlines/ch-0002.md：'))
  assert.ok(text.includes('鹤鸣剑出鞘'))

  // 3. Previous chapter's tail: the END of chapter 1, not its opening.
  assert.ok(text.includes(`### 上一章结尾（第 1 章 · 最后 ${String(DEFAULT_TAIL_CHARS)} 字）`))
  assert.ok(text.includes(PREV_LAST), 'the last sentence travels')
  assert.ok(!text.includes(PREV_OPENING), 'the opening is clipped away')

  // 4. World book: the keyword hit and the always entry, not the other one.
  assert.ok(text.includes('### 世界书（命中 2 条）'))
  assert.ok(text.includes('白鹤门（world/门派/白鹤门.md）'))
  assert.ok(text.includes('世界规矩（world/常驻/世界规矩.md）'))
  assert.ok(!text.includes('清音（world/人物/清音.md）'))
})

test('a project that is not usable injects nothing', async (t) => {
  const empty = workdir()
  const repair = workdir()
  const newer = workdir()
  t.after(() => {
    rmSync(empty, { recursive: true, force: true })
    rmSync(repair, { recursive: true, force: true })
    rmSync(newer, { recursive: true, force: true })
  })

  // needs-setup: nothing that looks like a book (no meta, no content dirs).
  const setup = buildWritingContext(empty)
  assert.equal(setup.state, 'needs-setup')
  assert.equal(setup.text, '')
  assert.deepEqual(setup.segments, [])
  assert.deepEqual(setup.trimmed, [])
  assert.equal(setup.tokens, 0)

  // needs-repair: the InkFlow layout exists but the meta file is missing.
  scaffold(repair, { meta: null })
  const broken = buildWritingContext(repair)
  assert.equal(broken.state, 'needs-repair')
  assert.equal(broken.text, '')

  // needs-newer-plugin: a meta this plugin must not touch at all.
  scaffold(newer, { meta: { schemaVersion: 99, title: '未来之书' } })
  const future = buildWritingContext(newer)
  assert.equal(future.state, 'needs-newer-plugin')
  assert.equal(future.text, '')
})

test('an explicit chapterSeq overrides "the newest chapter"', async (t) => {
  const root = workdir()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await sampleProject(root)

  const result = buildWritingContext(root, { chapterSeq: 1 })

  assert.ok(result.text.includes('标题：第一章 入山'))
  assert.ok(!result.text.includes('标题：第二章 夜行'))
  // Nothing comes before chapter 1: the tail segment disappears instead of
  // silently describing chapter 2 as "previous".
  assert.ok(!result.segments.some((segment) => segment.name === 'tail'))
})

/**
 * #183 — MIGRATED, not deleted. This test used to pin the six-rung ladder of
 * `buildWritingContext` (`项目摘要 → 当前章大纲 → 世界书 → 上章结尾`, reported as
 * the `trimmed` label list). The generation path now injects the nine-segment
 * brief, so the ladder the model is subject to is ADR-0022 D2's
 * (`world → facts → foreshadow → prevTail`) and the never-dropped segments are
 * `outline` / `promise` / `characters`.
 *
 * Same shape of assertions (prefix of the ladder, monotone under a growing
 * budget, every rung reachable, the task statement survives, the marker names
 * what went and how to get it back), aimed at the new ladder and the new ids.
 * The one assertion whose ANSWER flipped is called out inline: the chapter
 * outline is no longer dropped at the floor — it is undroppable now, so the
 * brief reports `overBudget` instead.
 *
 * This fixture has sources for `world` and `prevTail` only (no `facts/`, no
 * `foreshadowing/`), so `facts`/`foreshadow` rungs render identically to the
 * rung above them and are correctly skipped: the reachable rungs are `world`
 * and `world, prevTail`. The full four-rung sweep lives in `tests/brief.test.js`
 * against a book that has all four sources.
 */
test('the brief trims in the documented order and never drops the task statement', async (t) => {
  const root = workdir()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await sampleProject(root)

  const ladder = [...BRIEF_TRIM_ORDER]
  const labels = ladder.map((id) => BRIEF_LABELS[id])
  // The six-segment labels the injection used to report (#20): they must be gone from
  // the wire marker, otherwise a reader cannot tell which assembly produced the text.
  const retired = ['项目摘要', '当前章大纲']
  const reached = new Set()
  const rungs = []
  const full = buildWritingBrief(root)
  assert.deepEqual(full.trims, [], 'a generous budget trims nothing')

  // Sweep every budget between "only the task statement fits" and "everything fits":
  // each rung's threshold is an exact token count, so a coarse step would skip the
  // narrow ones.
  let previousCount = Number.POSITIVE_INFINITY
  for (let budgetTokens = 30; budgetTokens <= full.tokens; budgetTokens += 1) {
    const brief = buildWritingBrief(root, { budgetTokens })
    const trimmed = brief.trims.map((trim) => trim.segment)
    // A segment may be trimmed twice (the tail shrinks, then drops), so order is
    // asserted on the distinct sequence: it can only ever walk the ladder forward.
    // NOTE (#183): this fixture has no `facts/` or `foreshadowing/` sources, so those
    // rungs render exactly like the rung above them and are skipped by the builder —
    // hence "a subsequence of the ladder", not "a prefix of it" (the prefix form holds
    // for a book with all four sources; `tests/brief.test.js` sweeps that one).
    const distinct = [...new Set(trimmed)]
    const walked = distinct.map((id) => ladder.indexOf(id))
    assert.ok(walked.every((index) => index >= 0), `budget ${String(budgetTokens)}: unknown segment ${trimmed.join(',')}`)
    assert.deepEqual(
      walked,
      [...walked].sort((left, right) => left - right),
      `budget ${String(budgetTokens)} trimmed out of order: ${trimmed.join(',')}`,
    )
    // A larger budget can only keep more, never less.
    assert.ok(
      brief.trims.length <= previousCount,
      `trimming grew while the budget grew (${String(budgetTokens)})`,
    )
    previousCount = brief.trims.length
    // The hard floor: the task statement is on the wire on every rung.
    assert.ok(brief.text.includes('### 当前章'), `chapter kept at budget ${String(budgetTokens)}`)
    assert.ok(brief.text.includes('鹤鸣剑出鞘'))
    // The marker the model reads names the same segments, in the same order — and
    // none of the retired six-segment labels.
    const marker = /\[trimmed: ([^（\]]*)/u.exec(brief.text)
    if (marker !== null) {
      const named = marker[1].split('、')
      for (const label of named) {
        assert.ok(labels.includes(label), `the marker names "${label}", which is not a brief segment`)
      }
      const order = named.map((label) => labels.indexOf(label))
      assert.deepEqual(order, [...order].sort((left, right) => left - right), 'the marker follows the ladder')
      for (const label of retired) {
        assert.ok(!named.includes(label), `the retired label "${label}" is off the wire (#183)`)
      }
    }
    // The undroppable three never spend a trim, whatever the budget.
    for (const trim of brief.trims) {
      assert.ok(
        !['outline', 'promise', 'characters'].includes(trim.segment),
        `${trim.segment} must never be trimmed`,
      )
    }
    reached.add(distinct.join('|'))
    rungs.push(brief)
  }

  // Every rung this fixture can reach is actually reachable.
  assert.ok(reached.has('world'), 'the world book is droppable here')
  assert.ok(reached.has('world|prevTail'), 'and so is the tail, after it')

  // The world book goes before the tail is touched: the tail has no side channel
  // (the model cannot re-read the previous chapter), the world book does.
  assert.ok(
    rungs.some((brief) => brief.trims.some((trim) => trim.segment === 'world') && brief.text.includes('最后 300 字')),
    'the world book is dropped while the tail is still full length',
  )
  // Then the tail shrinks before it is dropped — the marker says so.
  assert.ok(
    rungs.some((brief) => brief.text.includes('最后 120 字')),
    'the tail is shrunk to 120 characters before being dropped',
  )
  assert.ok(
    rungs.some((brief) => brief.trims.some((trim) => trim.segment === 'prevTail') && !brief.text.includes('### 上一章结尾')),
    'the dropped tail is reported',
  )
  // And the recovery hint: a dropped tail must say how to get it back, because
  // "no tail" otherwise reads to the model as "there was no previous chapter".
  assert.ok(
    rungs.some((brief) => brief.text.includes('找回：读 chapters/vol-01/0001-入山.md')),
    'a dropped tail carries a recovery path',
  )

  // Squeezed to the floor. MIGRATED ANSWER (#183): the six-segment context dropped the
  // chapter outline here; the brief may not, so it goes over budget and says so.
  const squeezed = buildWritingBrief(root, { budgetTokens: 20 })
  assert.equal(squeezed.overBudget, true, 'over budget rather than dropping the task statement')
  assert.match(squeezed.text, /\[trimmed: 世界书、上章结尾/u)
  assert.ok(!squeezed.text.includes('### 世界书'))
  assert.ok(squeezed.text.includes('鹤鸣剑出鞘'), 'the outline is kept, not hidden')
  assert.ok(!/项目摘要|当前章大纲/u.test(squeezed.text), 'the retired labels are gone from the text too')
})

// ---------------------------------------------------------------------------
// #183: the injection assembly IS the brief
// ---------------------------------------------------------------------------

/**
 * The switch must not be a silent content change: every segment both assemblies
 * render must come out byte-identical, because they share one renderer
 * (`writing-context-render.ts`, ADR-0022 D1). Without this, "we now inject the
 * brief" would also mean "and the chapter block reads differently now" — an
 * invisible edit to what the model is told.
 */
test('the shared segments come out byte-identical through both assemblies (#183)', async (t) => {
  const root = workdir()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await sampleProject(root)

  const context = buildWritingContext(root)
  const brief = buildWritingBrief(root)
  const fromContext = (name) => context.segments.find((segment) => segment.name === name)?.text ?? ''
  const fromBrief = (id) => brief.segments.find((segment) => segment.id === id)?.text ?? ''

  // The same four materials under two ids: current chapter, previous tail, world book.
  assert.equal(fromBrief('outline'), fromContext('chapter'), 'the current chapter block is the same bytes')
  assert.equal(fromBrief('prevTail'), fromContext('tail'), 'the previous tail is the same bytes')
  assert.equal(fromBrief('world'), fromContext('world'), 'the world book is the same bytes')
  // The two registered domain segments come from one builder each (X-13), so they agree too.
  assert.equal(fromBrief('facts'), fromContext('facts'))
  assert.equal(fromBrief('foreshadow'), fromContext('foreshadow'))
  // A missing segment and an absent one are the same empty string, not a placeholder.
  assert.equal(fromBrief('facts'), '')

  // `project` is the one segment that does NOT cross over: the brief's nine segments do
  // not include it (ADR-0022 D2 revision), so this is where the two assemblies differ —
  // and the six-segment projection keeps rendering it for anyone who still asks.
  assert.equal(brief.segments.some((segment) => segment.id === 'project'), false)
  assert.ok(fromContext('project').includes('《测试之书》'), 'the six-segment projection is unchanged')
})

/**
 * #213 gave `promise` / `anchors` a source (the chapter outline's own `- [承诺]` /
 * `- [锚点]` bullets). This fixture's outline writes neither, so the honest gap must
 * still be a gap: absent, never invented instructions in front of the writer. Pinned
 * through the injected text, because that is where a placeholder would hurt. The other
 * direction — a node that DOES write them — is pinned in `tests/brief.test.js`.
 */
test('promise and anchors stay honestly missing when the outline writes no marker (#213)', async (t) => {
  const root = workdir()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await sampleProject(root)

  const brief = buildWritingBrief(root)
  const text = brief.text
  for (const id of ['promise', 'anchors']) {
    const segment = brief.segments.find((entry) => entry.id === id)
    assert.ok(segment !== undefined, `${id}: the record still lists the segment`)
    assert.equal(segment.missing, true, `${id}: this outline writes no marker`)
    assert.equal(segment.text, '', `${id}: no text`)
    assert.equal(segment.bytes, 0)
    assert.equal(segment.tokens, 0)
    // The label is the author's word for it; it must not appear on the wire either,
    // which is what a fabricated block would look like.
    assert.equal(text.includes(BRIEF_LABELS[id]), false, `${id}: no heading, no placeholder prose`)
  }
})

/**
 * The brief has no `project` segment, so the book-level title is no longer carried by
 * this section. What MUST survive is the chapter identity the writer addresses: title,
 * volume, sequence, status and the outline path — losing that would leave the model
 * writing into an unnamed chapter. Pinned here so the switch cannot quietly drop it.
 */
test('the injected text still addresses the chapter it is for (#183)', async (t) => {
  const root = workdir()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await sampleProject(root)

  const text = buildWritingBrief(root).text
  assert.ok(text.includes('### 当前章'))
  assert.ok(text.includes('标题：第二章 夜行'), 'which chapter')
  assert.ok(text.includes('卷：vol-01'), 'which volume')
  assert.ok(text.includes('seq：2'), 'which number')
  assert.ok(text.includes('状态：draft'), 'its status')
  assert.ok(text.includes('大纲 outlines/ch-0002.md：'), 'and where its outline lives')
})

test('a zero previous tail is a definition, not a trim', async (t) => {
  const root = workdir()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await sampleProject(root)

  const result = buildWritingContext(root, { tailChars: 80 })

  assert.ok(result.text.includes('### 上一章结尾（第 1 章 · 最后 80 字）'))
  assert.deepEqual(result.trimmed, [], 'the configured length is not a budget trim')
  assert.ok(result.text.includes(PREV_LAST))
})

test('a short previous chapter reports the length it actually has', async (t) => {
  const root = workdir()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await sampleProject(root)
  writeMarkdown(root, 'chapters/vol-01/0001-入山.md', ['title: 第一章 入山', 'seq: 1'], '短句。')
  await buildIndex(root)

  const result = buildWritingContext(root)

  assert.ok(result.text.includes('### 上一章结尾（第 1 章 · 最后 3 字）'))
  assert.ok(result.text.includes('短句。'))
})

test('world-book entries fire on keywords, or always stay', async (t) => {
  const root = workdir()
  const quiet = workdir()
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(quiet, { recursive: true, force: true })
  })
  await sampleProject(root)
  await sampleProject(quiet)
  // Same book, an outline whose keywords no entry declares.
  writeMarkdown(quiet, 'outlines/ch-0002.md', ['id: oc-2', 'kind: chapter', 'title: 无词细纲'], '- 夜行：在雾里找山门')
  await buildIndex(quiet)

  const quietResult = buildWritingContext(quiet)
  assert.ok(quietResult.text.includes('世界规矩（world/常驻/世界规矩.md）'), 'always: true is permanent')
  assert.ok(!quietResult.text.includes('白鹤门（world/门派/白鹤门.md）'), 'no keyword, no entry')

  // The previous chapter's tail is also a matching source: it mentions the
  // lantern, so a keyword living only there still fires.
  writeMarkdown(root, 'world/道具/灯.md', ['title: 油灯', 'keywords: [灯]'], '油灯是师兄留下的。')
  await buildIndex(root)
  const hit = buildWritingContext(root)
  assert.ok(hit.text.includes('油灯（world/道具/灯.md）'), 'the tail participates in matching')
})

test('a usable but empty book only reports that it is empty', async (t) => {
  const root = workdir()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  scaffold(root)
  await buildIndex(root)

  const result = buildWritingContext(root)

  assert.equal(result.state, 'usable')
  // The summary still says "0 章 · 0 字": a brand-new book must not let the
  // model believe chapter 5 exists. What must NOT appear is an empty
  // chapter/tail/world block.
  assert.deepEqual(
    result.segments.map((segment) => segment.name),
    ['project'],
  )
  assert.ok(result.text.includes('0 章'))
  assert.ok(!result.text.includes('### 当前章'))
  assert.ok(!result.text.includes('### 上一章结尾'))
  assert.ok(!result.text.includes('### 世界书'))
})

test('the trim marker only names segments that really existed', async (t) => {
  const root = workdir()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await sampleProject(root)
  // No `outlines/ch-0002.md`: there is no chapter outline to lose, so a tight
  // budget must not claim it dropped one.
  rmSync(join(root, 'outlines/ch-0002.md'))
  await buildIndex(root)

  const squeezed = buildWritingContext(root, { budgetTokens: 30 })

  assert.ok(!squeezed.trimmed.includes('当前章大纲'))
  assert.ok(squeezed.trimmed.includes('项目摘要'))
  assert.ok(squeezed.text.includes('### 当前章'))
})

test('a stale index, a deleted file or a corrupt database degrade instead of throwing', async (t) => {
  const stale = workdir()
  const corrupt = workdir()
  t.after(() => {
    rmSync(stale, { recursive: true, force: true })
    rmSync(corrupt, { recursive: true, force: true })
  })

  // The index remembers a chapter whose file is gone (user deleted it after the
  // last rebuild): the tail disappears, the rest of the block still renders.
  await sampleProject(stale)
  rmSync(join(stale, 'chapters/vol-01/0001-入山.md'))
  const staleResult = buildWritingContext(stale)
  assert.ok(!staleResult.segments.some((segment) => segment.name === 'tail'))
  assert.ok(staleResult.text.includes('### 当前章'))
  assert.ok(staleResult.text.includes('### 项目'))

  // A corrupt database must fall back to the files, not throw.
  await sampleProject(corrupt)
  writeFileSync(join(corrupt, 'index', 'inkflow.db'), 'this is not a database', 'utf8')
  const corruptResult = buildWritingContext(corrupt)
  assert.ok(corruptResult.text.includes('索引未建立'), 'the summary says why its numbers are missing')
  assert.ok(corruptResult.text.includes('第二章 夜行'), 'the current chapter comes from the files')
  assert.ok(corruptResult.text.includes('### 上一章结尾'))
})

test('the injected text leaks no absolute path', async (t) => {
  const root = workdir()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await sampleProject(root)

  const { text } = buildWritingContext(root)

  assert.ok(!text.includes(root), 'the absolute project root must not appear')
  assert.ok(!text.includes(tmpdir().replaceAll('\\', '/')), 'nor the OS temp directory')
  assert.ok(!/[A-Za-z]:[\\/]/.test(text), 'nor any drive-qualified path')
  assert.ok(text.includes('world/门派/白鹤门.md'), 'relative paths are how the model reaches the file')
  assert.ok(text.includes('outlines/ch-0002.md'))
})

test('estimateTokens is a conservative character heuristic', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('中文'), 2)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
  assert.equal(estimateTokens('中abcde'), 3)
  assert.ok(estimateTokens('一'.repeat(400)) === 400)
})

// ---------------------------------------------------------------------------
// Host wiring
// ---------------------------------------------------------------------------

test('the section is registered once and its text is the nine-segment brief', async (t) => {
  const root = workdir()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await sampleProject(root)

  const { service, sections } = createPromptService()
  const { ctx, logs } = createCtx({ services: { systemPrompt: service, workingDirectory: { get: () => root } } })

  const registration = registerWritingContext(ctx, { log: ctx.logger('test') })

  assert.equal(registration.registered, true)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, PROMPT_SECTION_NAME)
  assert.equal(sections[0].order, PROMPT_SECTION_ORDER)

  const text = sections[0].text({ agent: { session: { id: 'session-1' } } })
  // MIGRATED (#183): this used to pin `=== buildWritingContext(root).text` — the
  // six-segment assembly. The generation path now injects the brief, and the pin
  // moves with it: byte-for-byte the brief's own `text`, so the preview, the audit
  // record and the model keep reading one computation (ADR-0022 D1, X-23).
  assert.equal(text, buildWritingBrief(root).text)
  // …and the old assembly is gone, not merely equal: a regression back to
  // `buildWritingContext` must fail here, which an "is a string" assertion would not.
  assert.notEqual(text, buildWritingContext(root).text)
  assert.equal(text.includes('### 项目'), false, 'the brief has no project segment (ADR-0022 D2 revision)')
  assert.ok(logs.some((entry) => entry.level === 'info' && entry.text.includes(PROMPT_SECTION_NAME)))
})

test('sessions outside a project get an empty section', async (t) => {
  const root = workdir()
  const outside = workdir()
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  await sampleProject(root)

  const { service, sections } = createPromptService()
  const { ctx } = createCtx({ services: { systemPrompt: service, workingDirectory: { get: () => outside } } })
  registerWritingContext(ctx, { log: ctx.logger('test') })

  assert.equal(sections[0].text({ agent: { session: {} } }), '')
  assert.equal(sections[0].text(undefined), '', 'a context without an agent must not throw')
})

test('the session directory falls back to the header, then to the process cwd', async (t) => {
  const root = workdir()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await sampleProject(root)

  const { service, sections } = createPromptService()
  const { ctx } = createCtx({
    services: {
      systemPrompt: service,
      // A service that rejects: the header cwd is still a usable answer.
      workingDirectory: {
        get() {
          throw new Error('session not published')
        },
      },
    },
  })
  registerWritingContext(ctx, { log: ctx.logger('test') })

  const viaHeader = sections[0].text({ agent: { session: { header: { cwd: root } } } })
  assert.ok(viaHeader.includes('### 当前章'))
})

test('a missing systemPrompt service degrades to one log line', () => {
  const { ctx, logs } = createCtx({ services: {} })

  const registration = registerWritingContext(ctx, { log: ctx.logger('test') })

  assert.equal(registration.registered, false)
  assert.ok(logs.some((entry) => entry.level === 'info' && entry.text.includes('systemPrompt')))
})

test('a duplicate registration is survivable', () => {
  const { service } = createPromptService({ failWith: `section ${PROMPT_SECTION_NAME} already registered` })
  const { ctx, logs } = createCtx({ services: { systemPrompt: service } })

  const registration = registerWritingContext(ctx, { log: ctx.logger('test') })

  assert.equal(registration.registered, false)
  assert.ok(logs.some((entry) => entry.level === 'warn' && entry.text.includes('already registered')))
})

test('apply() assembles the section and honours the configured budget', async (t) => {
  const root = workdir()
  const dataDir = workdir()
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })
  await sampleProject(root)

  const { service, sections } = createPromptService()
  const { ctx } = createCtx({ services: { systemPrompt: service, workingDirectory: { get: () => root } } })

  apply(ctx, { dataDir, serveHttp: false, promptBudgetTokens: 60, promptTailChars: 300 })

  assert.equal(sections.length, 1)
  const squeezed = sections[0].text({ agent: { session: {} } })
  assert.match(squeezed, /\[trimmed: /)
  assert.ok(squeezed.includes('### 当前章'))

  // And the default budget fits this small book: no marker at all.
  const second = createPromptService()
  const other = createCtx({ services: { systemPrompt: second.service, workingDirectory: { get: () => root } } })
  apply(other.ctx, { dataDir, serveHttp: false })
  assert.ok(!second.sections[0].text({ agent: { session: {} } }).includes('[trimmed: '))
})

/**
 * #183 / ADR-0022 D2: "每次裁剪都要埋点……同一章的超预算次数进诊断包". The counter
 * lives on `briefFor`, and `briefFor` is what the injection calls now — so a
 * squeezed injection has to show up in `briefRunSummary()` (which is what
 * `inkflow_diagnostics_export` reads). Before the switch the injected text came
 * from `buildWritingContext` and the injection side contributed nothing.
 *
 * The budget a profile can configure bottoms out at 200 tokens (`PROMPT_LIMITS`),
 * so "over budget" on the injection path needs a book whose undroppable task
 * statement alone is bigger than that — a real 800-character outline, which is
 * exactly the case the ADR says must be reported rather than silently emptied.
 */
test('a squeezed injection is counted in the brief run summary (diagnostics)', async (t) => {
  const root = workdir()
  const dataDir = workdir()
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  })
  await sampleProject(root)
  // A chapter outline long enough that `outline` alone overruns the floor budget:
  // the four droppable segments can go, and it is still too big — the honest answer
  // is `overBudget`, never a silently emptied task statement.
  const longOutline = `- ${'夜行：在雾里找山门，鹤鸣剑出鞘。'.repeat(60)}`
  writeMarkdown(root, 'outlines/ch-0002.md', ['id: oc-2', 'kind: chapter', 'title: 第二章细纲', 'parent: vol-1'], longOutline)
  await buildIndex(root)

  resetBriefRunSummary()
  assert.deepEqual(briefRunSummary(), { runs: 0, overBudgetRuns: 0, last: null })

  const { service, sections } = createPromptService()
  const { ctx } = createCtx({ services: { systemPrompt: service, workingDirectory: { get: () => root } } })
  apply(ctx, { dataDir, serveHttp: false, promptBudgetTokens: 200 })

  const text = sections[0].text({ agent: { session: {} } })
  assert.ok(text.includes('### 当前章'), 'the task statement is still injected')
  assert.match(text, /\[trimmed: 世界书、上章结尾/u)

  const summary = briefRunSummary()
  assert.equal(summary.runs, 1, 'the injection assembled exactly one brief')
  assert.equal(summary.overBudgetRuns, 1, 'and it was over budget')
  assert.ok(summary.last !== null)
  assert.equal(summary.last.overBudget, true)
  assert.equal(summary.last.budgetTokens, 200)
  assert.deepEqual(
    [...new Set(summary.last.trimmed)],
    ['world', 'prevTail'],
    'which segments it cost, in ladder order',
  )
})
