/**
 * Issue #24 — the outline domain's write side: three-level tree, the three
 * invariants that already existed only on the rebuild side (I-01/I-02/I-05), the
 * plot-point syntax of conventions.md §3.5, and the model-facing tool surface.
 *
 * Why this suite exists at all: an invariant that is only checked by a rebuild
 * is a report, not a refusal — the bad file is already on disk by then. Every
 * refusal test below therefore asserts **two** things: the code, and that the
 * bytes of the file the call would have touched are unchanged.
 *
 * They run against the BUILT artifacts (lib/index.js), like the other suites.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { apply, buildIndex } from '../lib/index.js'

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
  return mkdtempSync(join(tmpdir(), 'inkflow-outline-'))
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

/** A usable book: real `.git`, ten directories with `.gitkeep`, meta and ignore rules. */
function project(root) {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of ALL_DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, KEEP), '', 'utf8')
  }
  writeFileSync(join(root, '.gitignore'), '# InkFlow derived index\nindex/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '大纲之书' }, null, 2)}\n`, 'utf8')
  return root
}

function markdown(root, relativePath, frontmatter = [], body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = frontmatter.length > 0 ? `---\n${frontmatter.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

function sha256(root, relativePath) {
  return createHash('sha256').update(readFileSync(join(root, relativePath))).digest('hex')
}

/** The outlines directory as a sorted list, so "nothing was created" is checkable. */
function outlinesDir(root) {
  return readdirSync(join(root, 'outlines')).sort()
}

async function upsert(harness, root, args) {
  return callTool(harness, 'inkflow_outline_upsert', { projectRoot: root, confirm: true, ...args })
}

async function move(harness, root, args) {
  return callTool(harness, 'inkflow_outline_move', { projectRoot: root, confirm: true, ...args })
}

async function tree(harness, root) {
  return callTool(harness, 'inkflow_outline_tree', { projectRoot: root })
}

/** The file a node lives in, straight from the tool's own answer. */
function fileOf(result) {
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result)}`)
  return result.node.file
}

// ---------------------------------------------------------------------------
// Three-level tree, create + move
// ---------------------------------------------------------------------------

test('outline: builds overall → volume → chapter and moves a chapter between levels', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    const harness = makeTools(join(dir, 'state'), dir)

    const overall = await upsert(harness, root, { kind: 'overall', title: '总纲' })
    assert.equal(fileOf(overall), 'outlines/overall.md')
    assert.equal(overall.created, true)

    const volume = await upsert(harness, root, { kind: 'volume', title: '卷一 入山' })
    assert.equal(volume.node.kind, 'volume')
    // A volume without an explicit parent hangs under the single overall (I-02).
    assert.equal(volume.node.parent, overall.node.id)

    const chapter = await upsert(harness, root, { kind: 'chapter', title: '第一章', parent: volume.node.id })
    assert.equal(chapter.node.parent, volume.node.id)

    const built = await tree(harness, root)
    assert.equal(built.ok, true, JSON.stringify(built))
    assert.equal(built.trees.length, 1)
    const rootNode = built.trees[0]
    assert.equal(rootNode.kind, 'overall')
    assert.equal(rootNode.children.length, 1)
    assert.equal(rootNode.children[0].kind, 'volume')
    assert.equal(rootNode.children[0].children.length, 1)
    assert.equal(rootNode.children[0].children[0].title, '第一章')

    // A chapter may hang directly under the overall: that is what `move` is for.
    const moved = await move(harness, root, { id: chapter.node.id, parent: overall.node.id })
    assert.equal(moved.ok, true, JSON.stringify(moved))
    const rebuilt = await tree(harness, root)
    assert.equal(rebuilt.trees[0].children[0].children.length, 0)
    assert.equal(rebuilt.trees[0].children.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// I-02 — no volume inside a volume
// ---------------------------------------------------------------------------

test('outline: I-02 refuses a volume under a volume and writes no file', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    const harness = makeTools(join(dir, 'state'), dir)

    await upsert(harness, root, { kind: 'overall', title: '总纲' })
    const volume = await upsert(harness, root, { kind: 'volume', title: '卷一', slug: 'vol-one' })
    const before = sha256(root, volume.node.file)

    const refused = await upsert(harness, root, { kind: 'volume', title: '卷二', slug: 'vol-two', parent: volume.node.id })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'OUTLINE_VOLUME_IN_VOLUME')
    assert.equal(existsSync(join(root, 'outlines/vol-two.md')), false, 'nothing may be created for a refused write')
    assert.equal(sha256(root, volume.node.file), before, 'the existing volume file must be byte-identical')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('outline: I-02 refuses a volume whose parent is not the overall outline', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    const harness = makeTools(join(dir, 'state'), dir)

    await upsert(harness, root, { kind: 'overall', title: '总纲' })
    // A chapter node is a legal parent id to *look up*, but not for a volume.
    const chapter = await upsert(harness, root, { kind: 'chapter', title: '第一章' })

    const refused = await upsert(harness, root, { kind: 'volume', title: '卷二', parent: chapter.node.id })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'OUTLINE_VOLUME_PARENT')
    assert.deepEqual(outlinesDir(root), ['.gitkeep', chapter.node.file.replace('outlines/', ''), 'overall.md'].sort())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// I-01 — exactly one overall
// ---------------------------------------------------------------------------

test('outline: I-01 refuses a second overall and leaves the first byte-identical', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    const harness = makeTools(join(dir, 'state'), dir)

    const overall = await upsert(harness, root, { kind: 'overall', title: '总纲' })
    const before = sha256(root, 'outlines/overall.md')

    const refused = await upsert(harness, root, { kind: 'overall', title: '另一份总纲', file: 'outlines/overall-2.md' })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'OUTLINE_MULTIPLE_OVERALL')
    assert.equal(existsSync(join(root, 'outlines/overall-2.md')), false)
    assert.equal(sha256(root, 'outlines/overall.md'), before)
    assert.equal(overall.node.kind, 'overall')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// I-05 — parent must exist
// ---------------------------------------------------------------------------

test('outline: I-05 refuses a dangling parent and writes nothing', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    const harness = makeTools(join(dir, 'state'), dir)
    await upsert(harness, root, { kind: 'overall', title: '总纲' })

    const refused = await upsert(harness, root, { kind: 'chapter', title: '第一章', parent: 'no-such-node' })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'DANGLING_PARENT')
    assert.deepEqual(outlinesDir(root), ['.gitkeep', 'overall.md'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// A refused *update* must not touch the file that was being edited
// ---------------------------------------------------------------------------

test('outline: a refused update leaves the target file byte-identical', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    const harness = makeTools(join(dir, 'state'), dir)

    await upsert(harness, root, { kind: 'overall', title: '总纲' })
    const first = await upsert(harness, root, { kind: 'volume', title: '卷一', slug: 'vol-one' })
    const second = await upsert(harness, root, { kind: 'volume', title: '卷二', slug: 'vol-two' })
    const before = sha256(root, first.node.file)

    const refused = await upsert(harness, root, {
      file: first.node.file,
      kind: 'volume',
      title: '卷一（改）',
      parent: second.node.id,
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'OUTLINE_VOLUME_IN_VOLUME')
    assert.equal(sha256(root, first.node.file), before, 'the edited file must be byte-identical after a refusal')
    assert.match(readFileSync(join(root, first.node.file), 'utf8'), /title: 卷一/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Plot points (conventions.md §3.5)
// ---------------------------------------------------------------------------

const PLOT_POINT_BODY = [
  '- [主线] 少年入山',
  '- [支线] 师父病重',
  '  咳血三日不肯说破',
  '- 卷末破碎虚空',
  '',
  '```',
  '- 这不是情节点：代码块里的列表项',
  '```',
  '',
].join('\n')

test('outline: parses body plot points and story-line tags into the tree', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    markdown(root, 'outlines/overall.md', ['id: ov', 'kind: overall', 'title: 总纲'], PLOT_POINT_BODY)
    markdown(root, 'outlines/vol-01.md', ['id: v1', 'kind: volume', 'title: 卷一', 'parent: ov'], '- 卷一中段\n')
    const harness = makeTools(join(dir, 'state'), dir)

    const built = await tree(harness, root)
    assert.equal(built.ok, true, JSON.stringify(built))
    const overall = built.trees[0]
    assert.equal(overall.id, 'ov')

    assert.deepEqual(overall.plotPoints, [
      { text: '少年入山', arc: '主线' },
      { text: '师父病重 咳血三日不肯说破', arc: '支线' },
      { text: '卷末破碎虚空' },
    ])
    assert.equal(overall.plotPointCount, 3)
    assert.equal(built.counts.plotPoints, 4)

    // The rendered answer must show the points and their story lines.
    const rendered = harness.tools.get('inkflow_outline_tree').output.render({}, built)
    const text = rendered.map((block) => block.text).join('\n')
    assert.match(text, /少年入山/u)
    assert.match(text, /主线/u)
    assert.match(text, /卷末破碎虚空/u)
    assert.equal(text.includes('代码块'), false, 'fenced code is not a plot point')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('outline: upsert writes plotPoints as a bullet list the parser reads back', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    const harness = makeTools(join(dir, 'state'), dir)

    await upsert(harness, root, { kind: 'overall', title: '总纲' })
    const written = await upsert(harness, root, {
      file: 'outlines/overall.md',
      plotPoints: ['[主线] 开场', '伏笔埋下'],
    })
    assert.equal(written.ok, true, JSON.stringify(written))
    const text = readFileSync(join(root, 'outlines/overall.md'), 'utf8')
    assert.match(text, /- \[主线\] 开场/u)
    assert.match(text, /- 伏笔埋下/u)

    const built = await tree(harness, root)
    assert.deepEqual(built.trees[0].plotPoints, [{ text: '开场', arc: '主线' }, { text: '伏笔埋下' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('outline: a new chapter outline never reuses a number that is already on disk', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    const harness = makeTools(join(dir, 'state'), dir)
    await upsert(harness, root, { kind: 'overall', title: '总纲' })

    // ch-002 exists, ch-001 does not: the count-based name would be `ch-002` and would
    // overwrite the author's file, so the number comes from the paths.
    markdown(root, 'outlines/ch-002.md', ['id: oc-2', 'kind: chapter', 'title: 第二章'], '- 后半段\n')
    const created = await upsert(harness, root, { kind: 'chapter', title: '新章' })
    assert.equal(created.ok, true, JSON.stringify(created))
    assert.equal(created.node.file, 'outlines/ch-003.md')
    assert.match(readFileSync(join(root, 'outlines/ch-002.md'), 'utf8'), /title: 第二章/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('outline: a create never overwrites a file that is already on disk', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    const harness = makeTools(join(dir, 'state'), dir)
    await upsert(harness, root, { kind: 'overall', title: '总纲' })

    // A name-based kind cannot be inferred here, so the file has no row — and a create
    // aimed at that path must refuse rather than replace the author's text.
    markdown(root, 'outlines/mystery.md', [], '作者手写的自由文本\n')
    const before = sha256(root, 'outlines/mystery.md')

    const refused = await upsert(harness, root, { kind: 'chapter', title: '第一章', file: 'outlines/mystery.md' })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'FILE_EXISTS')
    assert.equal(sha256(root, 'outlines/mystery.md'), before)
    assert.equal(readFileSync(join(root, 'outlines/mystery.md'), 'utf8'), '作者手写的自由文本\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Without confirm: nothing is written
// ---------------------------------------------------------------------------

test('outline: upsert and move write nothing without confirm: true', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    const harness = makeTools(join(dir, 'state'), dir)

    const dry = await callTool(harness, 'inkflow_outline_upsert', { projectRoot: root, kind: 'overall', title: '总纲' })
    assert.equal(dry.ok, false)
    assert.equal(dry.requiresConfirmation, true)
    assert.equal(dry.error.code, 'CONFIRM_REQUIRED')
    assert.equal(existsSync(join(root, 'outlines/overall.md')), false)

    await upsert(harness, root, { kind: 'overall', title: '总纲' })
    const chapter = await upsert(harness, root, { kind: 'chapter', title: '第一章' })
    const before = sha256(root, chapter.node.file)
    const dryMove = await callTool(harness, 'inkflow_outline_move', { projectRoot: root, id: chapter.node.id, parent: 'ov' })
    assert.equal(dryMove.ok, false)
    assert.equal(dryMove.requiresConfirmation, true)
    assert.equal(sha256(root, chapter.node.file), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The v3 index carries the new columns
// ---------------------------------------------------------------------------

test('outline: the rebuilt index stores plot points per outline node', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    markdown(root, 'outlines/overall.md', ['id: ov', 'kind: overall', 'title: 总纲'], PLOT_POINT_BODY)
    await buildIndex(root)

    const db = new DatabaseSync(join(root, INDEX_DIR, 'inkflow.db'), { readOnly: true })
    try {
      const version = { ...db.prepare('PRAGMA user_version').get() }
      // v3 introduced these two columns; the current version is pinned as a literal so
      // an added column without a bump fails here instead of silently reading a stale
      // database (`AGENTS.md` §8 trap 5). v4 is #25's character-card schema, v6 #29's
      // mentions, v7 #32's fact ledger.
      assert.equal(version.user_version, 7)
      const row = { ...db.prepare('SELECT id, kind, plot_point_count, plot_points FROM outline_nodes WHERE id = ?').get('ov') }
      assert.equal(row.plot_point_count, 3)
      assert.deepEqual(JSON.parse(row.plot_points), [
        { text: '少年入山', arc: '主线' },
        { text: '师父病重 咳血三日不肯说破', arc: '支线' },
        { text: '卷末破碎虚空' },
      ])
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
