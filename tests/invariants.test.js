/**
 * Issue #8 — one failing fixture per invariant (data-model.md §5, I-01…I-10).
 *
 * The index is a cache (ADR-0005) and invariant findings never block it
 * (conventions.md §4): a rebuild reports every problem as a machine-readable
 * `code` in `validation_issues` and still succeeds. That is exactly why each
 * invariant needs a test that can FAIL when its checker is removed — "the build
 * succeeded" proves nothing about whether the check is there.
 *
 * Matrix (one test per row, the code in brackets is what the fixture must
 * produce):
 *
 *   I-01  exactly one `overall` outline      [OUTLINE_NO_OVERALL, OUTLINE_MULTIPLE_OVERALL]
 *   I-02  volume parent / no volume-in-volume [OUTLINE_VOLUME_PARENT, OUTLINE_VOLUME_IN_VOLUME]
 *   I-03  character names unique (normalised) [CHARACTER_NAME_DUPLICATE]
 *   I-04  chapter ids unique                  [DUPLICATE_ID]
 *   I-05  `parent` resolves                   [DANGLING_PARENT]
 *   I-06  chapter status is legal             [no code: downgraded to `draft`]
 *   I-07  prose files are `.md`               [CHAPTER_NOT_MARKDOWN]
 *   I-08  one world root; children complete   [WORLD_ROOT_MISSING, WORLD_ROOT_MULTIPLE,
 *                                              WORLD_CATEGORY_REQUIRED]
 *   I-09  a resolved foreshadow names its chapter [FORESHADOW_RESOLVED_WITHOUT_CHAPTER]
 *   I-10  frontmatter parses                  [FRONTMATTER_ISSUE]
 *
 * They run against the BUILT artifacts (lib/index.js), like the other suites.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { apply } from '../lib/index.js'

// ADR-0006 D1: nine content directories plus index/, each carrying .gitkeep.
const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const INDEX_DIR = 'index'
const ALL_DIRS = [...CONTENT_DIRS, INDEX_DIR]
const KEEP = '.gitkeep'

function createHarness(workspace) {
  const tools = new Map()
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
    get(name) {
      // The session workspace is the trust anchor for an explicit projectRoot,
      // so tests fake it instead of mutating process.cwd().
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
      register() {
        return () => {}
      },
    },
  }
  return { ctx, tools }
}

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-invariants-'))
}

function makeTools(dataDir, workspace) {
  const harness = createHarness(workspace)
  apply(harness.ctx, { dataDir })
  return harness
}

async function callTool(harness, toolName, args) {
  const tool = harness.tools.get(toolName)
  assert.ok(tool, `tool ${toolName} must be registered`)
  return tool.execute(args, { signal: AbortSignal.timeout(15000), agent: { id: 'test-session' } })
}

/**
 * A usable book: real `.git`, ten directories with `.gitkeep`, meta and the
 * derived-index ignore rules. Every invariant fixture starts from this so a
 * failure cannot come from the gate.
 */
function project(root) {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of ALL_DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, KEEP), '', 'utf8')
  }
  writeFileSync(join(root, '.gitignore'), '# InkFlow derived index\nindex/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '不变量之书' }, null, 2)}\n`, 'utf8')
  return root
}

/** Write a markdown file, `frontmatter` being the lines between the `---` pair. */
function markdown(root, relativePath, frontmatter = [], body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = frontmatter.length > 0 ? `---\n${frontmatter.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

async function rebuild(harness, root) {
  const result = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
  assert.equal(result.ok, true, `the rebuild must always succeed: ${JSON.stringify(result.error)}`)
  return result
}

function codesOf(result) {
  return result.issues.map((issue) => issue.code)
}

function issueOf(result, code) {
  const found = result.issues.filter((issue) => issue.code === code)
  assert.equal(found.length, 1, `expected exactly one ${code}, got ${JSON.stringify(result.issues)}`)
  return found[0]
}

/** One overall outline so a fixture is not accidentally reporting I-01 too. */
function overall(root, id = 'ov') {
  markdown(root, 'outlines/overall.md', [`id: ${id}`, 'kind: overall', 'title: 总纲'], '- 情节点')
}

/** Read rows from the derived index, as plain objects (node:sqlite uses null prototypes). */
function readIndex(root, sql, ...params) {
  const db = new DatabaseSync(join(root, INDEX_DIR, 'inkflow.db'), { readOnly: true })
  try {
    return db
      .prepare(sql)
      .all(...params)
      .map((row) => ({ ...row }))
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// I-01 — exactly one overall outline
// ---------------------------------------------------------------------------

test('I-01: an outline tree without an overall node reports OUTLINE_NO_OVERALL', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    markdown(root, 'outlines/ch-0001.md', ['id: oc-1', 'kind: chapter', 'title: 第一章'], '- 开场')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    assert.ok(codesOf(result).includes('OUTLINE_NO_OVERALL'))
    issueOf(result, 'OUTLINE_NO_OVERALL')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('I-01: two overall outlines report OUTLINE_MULTIPLE_OVERALL', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    overall(root)
    markdown(root, 'outlines/overall-copy.md', ['id: ov-2', 'kind: overall', 'title: 第二份总纲'], '- 情节点')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    const issue = issueOf(result, 'OUTLINE_MULTIPLE_OVERALL')
    assert.match(issue.detail, /2 overall outlines found/)
    assert.equal(codesOf(result).includes('OUTLINE_NO_OVERALL'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// I-02 — a volume hangs off the overall node; never inside another volume
// ---------------------------------------------------------------------------

test('I-02: a volume whose parent is not the overall node reports OUTLINE_VOLUME_PARENT', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    overall(root)
    markdown(root, 'outlines/vol-01.md', ['id: v1', 'kind: volume', 'title: 卷一', 'parent: nowhere'], '- 卷一')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    const issue = issueOf(result, 'OUTLINE_VOLUME_PARENT')
    assert.equal(issue.path, 'outlines/vol-01.md')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('I-02: a volume nested under a volume reports OUTLINE_VOLUME_IN_VOLUME', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    overall(root)
    markdown(root, 'outlines/vol-01.md', ['id: v1', 'kind: volume', 'title: 卷一', 'parent: ov'], '- 卷一')
    markdown(root, 'outlines/vol-02.md', ['id: v2', 'kind: volume', 'title: 卷二', 'parent: v1'], '- 卷二')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    const issue = issueOf(result, 'OUTLINE_VOLUME_IN_VOLUME')
    assert.equal(issue.path, 'outlines/vol-02.md')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// I-03 — character names are unique after normalisation
// ---------------------------------------------------------------------------

test('I-03: two names equal after NFKC/space/case folding report CHARACTER_NAME_DUPLICATE', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    overall(root)
    markdown(root, 'characters/a-清音.md', ['id: char-1', 'name: 清音'], '本体。')
    // Whitespace differs, so the author sees two different names; the key does not.
    markdown(root, 'characters/b-清音-空格.md', ['id: char-2', 'name: "清 音"'], '分身。')
    markdown(root, 'characters/c-Ling.md', ['id: char-3', 'name: Ling'], '英文名。')
    markdown(root, 'characters/d-ling.md', ['id: char-4', 'name: ling'], '同一个名字。')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    const duplicates = result.issues.filter((issue) => issue.code === 'CHARACTER_NAME_DUPLICATE')
    assert.deepEqual(duplicates.map((issue) => issue.path).sort(), ['characters/b-清音-空格.md', 'characters/d-ling.md'])
    assert.match(duplicates[0].detail, /already used by characters\/a-清音\.md|already used by characters\/c-Ling\.md/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// I-04 — ids are unique; a collision is data, not a crashed rebuild
// ---------------------------------------------------------------------------

test('I-04: two chapters sharing an id report DUPLICATE_ID and keep the first file', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    overall(root)
    markdown(root, 'chapters/vol-01/0001-甲.md', ['id: ch-dup', 'seq: 1', 'title: 甲'], '正文一')
    markdown(root, 'chapters/vol-01/0002-乙.md', ['id: ch-dup', 'seq: 2', 'title: 乙'], '正文二')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    assert.equal(result.counts.chapters, 1)
    const issue = issueOf(result, 'DUPLICATE_ID')
    assert.equal(issue.path, 'chapters/vol-01/0002-乙.md')
    assert.match(issue.detail, /chapters\/vol-01\/0001-甲\.md/)
    assert.deepEqual(readIndex(root, 'SELECT id, path FROM chapters'), [{ id: 'ch-dup', path: 'chapters/vol-01/0001-甲.md' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// I-05 — `parent` must point at an existing entry
// ---------------------------------------------------------------------------

test('I-05: a chapter outline with an unknown parent reports DANGLING_PARENT', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    overall(root)
    markdown(root, 'outlines/ch-0001.md', ['id: oc-1', 'kind: chapter', 'title: 第一章', 'parent: ghost'], '- 开场')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    const issue = issueOf(result, 'DANGLING_PARENT')
    assert.equal(issue.path, 'outlines/ch-0001.md')
    assert.match(issue.detail, /parent "ghost" not found/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('I-05: a world entry with an unknown parent reports DANGLING_PARENT', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    overall(root)
    markdown(root, 'world/世界总览.md', ['id: w-root', 'title: 世界总览'], '根条目。')
    markdown(root, 'world/门派/白鹤门.md', ['id: w-1', 'title: 白鹤门', 'parent: ghost'], '门派条目。')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    const issue = issueOf(result, 'DANGLING_PARENT')
    assert.equal(issue.path, 'world/门派/白鹤门.md')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// I-06 — an illegal status is downgraded, never stored as-is
// ---------------------------------------------------------------------------

test('I-06: an illegal status is downgraded to draft and reports no issue', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    overall(root)
    markdown(root, 'chapters/0001-甲.md', ['id: c1', 'seq: 1', 'status: 已定稿'], '正文')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    // Downgrading is not a finding: conventions.md §4 only lists the blocking ones.
    assert.deepEqual(result.issues, [])
    assert.deepEqual(readIndex(root, 'SELECT status FROM chapters'), [{ status: 'draft' }])

    const list = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root })
    assert.equal(list.ok, true)
    assert.equal(list.chapters[0].status, 'draft')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// I-07 — chapters are markdown
// ---------------------------------------------------------------------------

test('I-07: a non-markdown file under chapters/ reports CHAPTER_NOT_MARKDOWN', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    overall(root)
    writeFileSync(join(root, 'chapters', '0001-笔记.txt'), '这是一段正文，但扩展名不对。\n', 'utf8')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    const issue = issueOf(result, 'CHAPTER_NOT_MARKDOWN')
    assert.equal(issue.path, 'chapters/0001-笔记.txt')
    // It is counted as a file but never as a chapter.
    assert.equal(result.counts.chapters, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// I-08 — one world root; every other entry is pinned into the tree
// ---------------------------------------------------------------------------

test('I-08: two world entries without a parent report WORLD_ROOT_MULTIPLE', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    overall(root)
    markdown(root, 'world/甲总览.md', ['id: w-a', 'title: 甲总览'], '根一。')
    markdown(root, 'world/乙总览.md', ['id: w-b', 'title: 乙总览'], '根二。')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    const issue = issueOf(result, 'WORLD_ROOT_MULTIPLE')
    assert.match(issue.detail, /2 world entries have no parent/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('I-08: a world tree without any root reports WORLD_ROOT_MISSING', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    overall(root)
    markdown(root, 'world/门派/白鹤门.md', ['id: w-1', 'title: 白鹤门', 'parent: w-2'], '条目。')
    markdown(root, 'world/门派/青城派.md', ['id: w-2', 'title: 青城派', 'parent: w-1'], '条目。')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    issueOf(result, 'WORLD_ROOT_MISSING')
    assert.equal(codesOf(result).includes('WORLD_ROOT_MULTIPLE'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('I-08: a child entry without a category reports WORLD_CATEGORY_REQUIRED', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    overall(root)
    markdown(root, 'world/世界总览.md', ['id: w-root', 'title: 世界总览'], '根条目。')
    // Directly under world/ with a parent: claims to be a child but has no
    // category (a file in world/<category>/ would derive one from the directory).
    markdown(root, 'world/无分类条目.md', ['id: w-1', 'title: 无分类条目', 'parent: w-root'], '条目。')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    const issue = issueOf(result, 'WORLD_CATEGORY_REQUIRED')
    assert.equal(issue.path, 'world/无分类条目.md')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// I-09 — a resolved foreshadow names the chapter that resolves it
// ---------------------------------------------------------------------------

test('I-09: resolved without a resolved chapter reports FORESHADOW_RESOLVED_WITHOUT_CHAPTER', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    overall(root)
    markdown(root, 'foreshadowing/断剑.md', ['id: fs-1', 'title: 断剑', 'resolved: true'], '回收了，但没说在哪一章。')
    markdown(root, 'foreshadowing/旧信.md', ['id: fs-2', 'title: 旧信', 'resolved: true', 'resolvedChapter: ch-12'], '已回收。')
    markdown(root, 'foreshadowing/玉佩.md', ['id: fs-3', 'title: 玉佩', 'resolved: false'], '尚未回收。')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    const issues = result.issues.filter((issue) => issue.code === 'FORESHADOW_RESOLVED_WITHOUT_CHAPTER')
    assert.deepEqual(issues.map((issue) => issue.path), ['foreshadowing/断剑.md'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// I-10 — frontmatter parses
// ---------------------------------------------------------------------------

test('I-10: an unparsed frontmatter line reports FRONTMATTER_ISSUE without eating the body', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    overall(root)
    markdown(
      root,
      'chapters/0001-甲.md',
      ['id: c1', 'title: 甲', '这一行不是键值对', '- 没有人认领的列表项'],
      '正文一个字都不能少。',
    )
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    const issues = result.issues.filter((issue) => issue.code === 'FRONTMATTER_ISSUE')
    assert.equal(issues.length, 2, `both broken lines must be reported: ${JSON.stringify(issues)}`)
    assert.deepEqual(issues.map((issue) => issue.path), ['chapters/0001-甲.md', 'chapters/0001-甲.md'])
    assert.match(issues[0].detail, /unparsed frontmatter line at line 4/)
    assert.match(issues[1].detail, /array item without a key at line 5/)

    // The body wins: a partly broken header never costs the author their prose.
    const rows = readIndex(root, 'SELECT id, word_count FROM chapters')
    assert.deepEqual(rows, [{ id: 'c1', word_count: 10 }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The other direction: a clean book must report none of the ten codes.
// ---------------------------------------------------------------------------

test('invariants: a complete, consistent book reports no issues at all', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    overall(root)
    markdown(root, 'outlines/vol-01.md', ['id: v1', 'kind: volume', 'title: 卷一', 'parent: ov'], '- 卷一')
    markdown(root, 'outlines/ch-0001.md', ['id: oc-1', 'kind: chapter', 'title: 第一章', 'parent: v1'], '- 开场')
    markdown(root, 'chapters/vol-01/0001-入山.md', ['id: ch-1', 'seq: 1', 'status: final'], '他走进白鹤门。')
    markdown(root, 'characters/清音.md', ['id: char-1', 'name: 清音'], '主角。')
    markdown(root, 'world/世界总览.md', ['id: w-root', 'title: 世界总览'], '根条目。')
    markdown(root, 'world/门派/白鹤门.md', ['id: w-1', 'title: 白鹤门', 'parent: w-root'], '门派条目。')
    markdown(root, 'foreshadowing/旧信.md', ['id: fs-1', 'title: 旧信', 'resolved: true', 'resolvedChapter: ch-1'], '已回收。')
    writeFileSync(join(root, 'library', '参考.txt'), '资料正文', 'utf8')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    assert.deepEqual(result.issues, [])
    assert.deepEqual(result.counts, {
      files: 10, // 8 markdown + library/参考.txt + inkflow.json (dotfiles are skipped)
      chapters: 1,
      characters: 1,
      worldEntries: 2,
      outlineNodes: 3,
      libraryFiles: 1,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
