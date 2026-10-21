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
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_TAIL_CHARS,
  PROMPT_SECTION_NAME,
  PROMPT_SECTION_ORDER,
  apply,
  buildIndex,
  buildWritingContext,
  estimateTokens,
  registerWritingContext,
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

  // needs-setup: no git, no meta.
  scaffold(empty, { git: false, meta: null })
  const setup = buildWritingContext(empty)
  assert.equal(setup.state, 'needs-setup')
  assert.equal(setup.text, '')
  assert.deepEqual(setup.segments, [])
  assert.deepEqual(setup.trimmed, [])
  assert.equal(setup.tokens, 0)

  // needs-repair: a git repository with no inkflow.json.
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

test('the budget trims in the documented order and never drops the current chapter', async (t) => {
  const root = workdir()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  await sampleProject(root)

  const ladder = ['项目摘要', '当前章大纲', '上章结尾', '世界书']
  const reached = new Map()
  const full = buildWritingContext(root)
  assert.deepEqual(full.trimmed, [])

  // Sweep every budget between "only the chapter fits" and "everything fits":
  // each rung's threshold is an exact token count, so a coarse step would skip
  // the narrow ones (the project summary is only a couple of dozen tokens).
  let previousCount = Number.POSITIVE_INFINITY
  for (let budgetTokens = 30; budgetTokens <= full.tokens; budgetTokens += 1) {
    const result = buildWritingContext(root, { budgetTokens })
    // `trimmed` is always a prefix of the ladder: order is a contract, not an
    // artifact of the order segments happen to be rendered in.
    assert.deepEqual(
      result.trimmed,
      ladder.slice(0, result.trimmed.length),
      `budget ${String(budgetTokens)} produced ${result.trimmed.join(',')}`,
    )
    // A larger budget can only keep more, never less.
    assert.ok(
      result.trimmed.length <= previousCount,
      `trimming grew while the budget grew (${String(budgetTokens)})`,
    )
    previousCount = result.trimmed.length
    // The hard floor: the current chapter block is present on every rung.
    assert.ok(result.text.includes('### 当前章'), `chapter kept at budget ${String(budgetTokens)}`)
    assert.ok(result.text.includes('标题：第二章 夜行'))
    reached.set(result.trimmed.join('|'), result)
  }

  // Every rung is actually reachable, including "only the current chapter left".
  for (let depth = 0; depth <= ladder.length; depth += 1) {
    const key = ladder.slice(0, depth).join('|')
    assert.ok(reached.has(key), `rung "${key}" is reachable`)
  }

  // L3 shrinks the tail before L4 drops it — the marker says so.
  const rungs = [...reached.values()]
  assert.ok(
    rungs.some((result) => result.text.includes('最后 120 字')),
    'the tail is shrunk to 120 characters before being dropped',
  )
  assert.ok(
    rungs.some((result) => result.trimmed.includes('上章结尾') && !result.text.includes('### 上一章结尾')),
    'the dropped tail is reported',
  )
  // And the recovery hint: a dropped tail must say how to get it back, because
  // "no tail" otherwise reads to the model as "there was no previous chapter".
  assert.ok(
    rungs.some((result) => result.text.includes('找回：读 chapters/vol-01/0001-入山.md')),
    'a dropped tail carries a recovery path',
  )

  const squeezed = buildWritingContext(root, { budgetTokens: 20 })
  assert.deepEqual(squeezed.trimmed, ladder)
  assert.match(squeezed.text, /\[trimmed: 项目摘要、当前章大纲、上章结尾、世界书\]/)
  assert.ok(!squeezed.text.includes('### 世界书'))
  assert.ok(!squeezed.text.includes('鹤鸣剑出鞘'), 'the outline is gone, not just hidden')
  assert.ok(squeezed.tokens > squeezed.budgetTokens, 'over budget rather than dropping the chapter')
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

test('the section is registered once and its text is the projection', async (t) => {
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
  assert.equal(text, buildWritingContext(root).text)
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
