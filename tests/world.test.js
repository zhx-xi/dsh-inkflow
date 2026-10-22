/**
 * World domain (#26): the world book's own fields, the keyword matcher, the tree
 * shape, and the write-side half of I-08.
 *
 * What these tests exist to catch:
 *   - `keywords` / `always` / `priority` never reaching the index, so a chapter's
 *     setting cannot be looked up without reading every file;
 *   - a matcher whose answer depends on entry order or on the machine (the
 *     briefing chain in #43 must be reproducible before it can be tested);
 *   - the I-08 write gate letting a second root through, or refusing a flat
 *     category book (the #8 review settled that it is legal);
 *   - a refused write touching the disk anyway.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  INDEX_SCHEMA_VERSION,
  buildIndex,
  buildWorldTree,
  domainTools,
  matchWorldBook,
  planWorldUpsert,
} from '../lib/index.js'

const DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-world-'))
}

function scaffold(root) {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '世界观测试' }, null, 2)}\n`, 'utf8')
}

function writeMarkdown(root, relativePath, frontmatterLines, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = frontmatterLines.length > 0 ? `---\n${frontmatterLines.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

/** One root (`world/总览.md`), a two-level branch under `world/门派/`, and a lone
 *  entry under `world/秘境/` — a book that is valid under I-08 and has something
 *  for every field to be written on. */
function sampleBook(root) {
  scaffold(root)
  writeMarkdown(root, 'world/总览.md', ['id: w-0', 'title: 总览', 'keywords: [天地]'], '世界总览。')
  writeMarkdown(
    root,
    'world/门派/白鹤门.md',
    ['id: w-1', 'title: 白鹤门', 'category: 门派', 'parent: w-0', 'keywords: [白鹤, 剑宗]', 'always: true', 'priority: 7'],
    '山中剑派。',
  )
  writeMarkdown(root, 'world/门派/静水观.md', ['id: w-2', 'title: 静水观', 'category: 门派', 'parent: w-1'], '下院。')
  writeMarkdown(root, 'world/秘境/剑冢.md', ['id: w-3', 'title: 剑冢', 'category: 秘境'], '万剑归处。')
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function callTool(name, args) {
  const tool = domainTools().find((candidate) => candidate.name === name)
  assert.ok(tool, `${name} must be registered by a domain module`)
  return tool.execute(args, { signal: new AbortController().signal, callId: 'world-test' })
}

// ---------------------------------------------------------------------------
// 1. The fields reach the index (schema v3)
// ---------------------------------------------------------------------------

test('world-book fields land in world_entries, and the schema version says so', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    const build = await buildIndex(root)
    assert.deepEqual(
      build.issues.filter((issue) => issue.code.startsWith('WORLD_')),
      [],
      'the fixture is a valid world tree',
    )
<<<<<<< HEAD
    // Pinned literal on purpose: v3 added these columns, and a later domain that adds
    // its own must bump the constant (v4 is #25's `characters`/`character_states`) —
    // otherwise `ensureIndex()` calls a stale file fresh and every read degrades to
    // `INDEX_UNAVAILABLE`. A bump here is the reminder, not an accident.
    assert.equal(INDEX_SCHEMA_VERSION, 4, 'the world-book columns are a schema bump, not an ALTER')
=======
    // At least the version that introduced the world-book columns, and exactly the
    // version the build stamps: later domains (#28 timeline) bump it further, so an
    // equality against a literal would only pin this suite to one branch's history.
    assert.ok(INDEX_SCHEMA_VERSION >= 3, 'the world-book columns are a schema bump, not an ALTER')
>>>>>>> e30390f (feat(timeline): two-axis timeline with pending area and conflict detection)

    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(root, 'index', 'inkflow.db'))
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, INDEX_SCHEMA_VERSION)
      const row = db.prepare('SELECT category, parent, keywords, always, priority FROM world_entries WHERE id = ?').get('w-1')
      assert.deepEqual({ ...row }, { category: '门派', parent: 'w-0', keywords: '白鹤 剑宗', always: 1, priority: 7 })
      // An entry that carries none of the fields is still a row, with the defaults.
      const plain = db.prepare('SELECT keywords, always, priority FROM world_entries WHERE id = ?').get('w-3')
      assert.deepEqual({ ...plain }, { keywords: null, always: 0, priority: null })
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. Keyword matching — reproducible, no side effects
// ---------------------------------------------------------------------------

test('a chapter pulls in exactly the entries it names, with the reason', () => {
  const entries = [
    { id: 'w-1', title: '白鹤门', keywords: ['白鹤', '鹤鸣剑'] },
    { id: 'w-2', title: '静水观', keywords: ['静水'] },
    { id: 'w-3', title: '剑冢', keywords: [] },
  ]
  const chapter = '清音推开白鹤门的山门，匣中鹤鸣剑轻响。'

  const hits = matchWorldBook(entries, chapter)
  assert.deepEqual(hits, [{ id: 'w-1', title: '白鹤门', matched: 'keyword', keyword: '白鹤' }])
  // Reproducible: same input twice, and entry order is not an input.
  assert.deepEqual(matchWorldBook(entries, chapter), hits)
  assert.deepEqual(matchWorldBook([...entries].reverse(), chapter), hits)
  // Nothing named → nothing injected (an empty list, never "everything").
  assert.deepEqual(matchWorldBook(entries, '山中无岁月。'), [])
  assert.deepEqual(matchWorldBook(entries, ''), [])
  assert.deepEqual(matchWorldBook([], chapter), [])
})

test('an always entry is unconditional; a keyword hit is not', () => {
  const entries = [
    { id: 'w-9', title: '天地法则', always: true },
    { id: 'w-1', title: '白鹤门', keywords: ['白鹤'] },
  ]
  assert.deepEqual(matchWorldBook(entries, ''), [{ id: 'w-9', title: '天地法则', matched: 'always' }])
  assert.deepEqual(matchWorldBook(entries, '白鹤').map((hit) => hit.matched).sort(), ['always', 'keyword'])
  // `always: false` is not a hit on its own.
  assert.deepEqual(matchWorldBook([{ id: 'w-1', title: '白鹤门', keywords: ['白鹤'], always: false }], ''), [])
})

test('priority orders the hits; ties are broken by title, never by input order', () => {
  const ranked = [
    { id: 'w-low', title: '甲', keywords: ['剑'], priority: 1 },
    { id: 'w-high', title: '乙', keywords: ['剑'], priority: 9 },
    { id: 'w-mid', title: '丙', keywords: ['剑'] },
  ]
  assert.deepEqual(matchWorldBook(ranked, '剑光一闪').map((hit) => hit.id), ['w-high', 'w-low', 'w-mid'])

  const tied = [
    { id: 'w-beta', title: 'Beta', keywords: ['sword'] },
    { id: 'w-alpha', title: 'Alpha', keywords: ['sword'] },
  ]
  assert.deepEqual(matchWorldBook(tied, 'a sword').map((hit) => hit.id), ['w-alpha', 'w-beta'])
  // Latin keywords match case-insensitively; the text is what the author wrote.
  assert.deepEqual(matchWorldBook(tied, 'A SWORD').map((hit) => hit.id), ['w-alpha', 'w-beta'])
})

// ---------------------------------------------------------------------------
// 3. Tree shape — expandable, grouped by category
// ---------------------------------------------------------------------------

test('the tree expands parents and groups the same nodes by category', () => {
  const tree = buildWorldTree([
    { id: 'w-1', title: '白鹤门', path: 'world/门派/白鹤门.md', category: '门派' },
    { id: 'w-2', title: '静水观', path: 'world/门派/静水观.md', category: '门派', parent: 'w-1' },
    { id: 'w-3', title: '剑冢', path: 'world/秘境/剑冢.md', category: '秘境' },
  ])

  const sect = tree.groups.find((group) => group.category === '门派')
  assert.ok(sect, 'the 门派 group exists')
  assert.deepEqual(sect.nodes.map((node) => node.id), ['w-1'])
  assert.deepEqual(sect.nodes[0].children.map((node) => node.id), ['w-2'], 'a child expands under its parent')
  assert.deepEqual(sect.nodes[0].children[0].children, [], 'a leaf stays a leaf')
  assert.equal(tree.groups.find((group) => group.category === '秘境').nodes.length, 1)
  assert.equal(tree.groups.length, 2)
  assert.deepEqual(tree.danglingParents, [])
  // Two entries claim no parent, so both are tree tops (codepoint order: 剑 < 白).
  assert.deepEqual(tree.roots.map((node) => node.id), ['w-3', 'w-1'])
})

test('an entry without a category is grouped, not dropped; a dangling parent is reported', () => {
  const tree = buildWorldTree([
    { id: 'w-1', title: '孤儿', path: 'world/门派/孤儿.md', category: '门派', parent: 'w-404' },
    { id: 'w-2', title: '总览', path: 'world/总览.md' },
  ])
  assert.deepEqual(tree.danglingParents, ['w-404'])
  // A dangling parent does not lose the node: it surfaces as a root.
  assert.ok(tree.roots.some((node) => node.id === 'w-1'))
  const leftover = tree.groups.find((group) => group.category === null)
  assert.ok(leftover, 'the uncategorised bucket exists')
  assert.deepEqual(leftover.nodes.map((node) => node.id), ['w-2'])
})

// ---------------------------------------------------------------------------
// 4. Write-side I-08 — it must stop what it claims to stop
// ---------------------------------------------------------------------------

const ROOT_ENTRY = { id: 'w-root', path: 'world/总览.md', title: '总览' }

test('a second root is refused', () => {
  const entries = [ROOT_ENTRY, { id: 'w-1', path: 'world/门派/白鹤门.md', title: '白鹤门', category: '门派', parent: 'w-root' }]
  const plan = planWorldUpsert({ entries, candidate: { id: 'w-2', path: 'world/第二个根.md', title: '第二个根' } })
  assert.equal(plan.ok, false)
  assert.equal(plan.error.code, 'WORLD_ROOT_MULTIPLE')
})

test('a child without a category is refused', () => {
  const plan = planWorldUpsert({
    entries: [ROOT_ENTRY],
    candidate: { id: 'w-3', path: 'world/孤儿.md', title: '孤儿', parent: 'w-root' },
    knownIds: new Set(['w-root']),
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.error.code, 'WORLD_CATEGORY_REQUIRED')
})

test('a parent that resolves to nothing is refused, across kinds included', () => {
  const dangling = planWorldUpsert({
    entries: [ROOT_ENTRY],
    candidate: { id: 'w-4', path: 'world/门派/无名.md', title: '无名', category: '门派', parent: 'w-missing' },
    knownIds: new Set(['w-root']),
  })
  assert.equal(dangling.ok, false)
  assert.equal(dangling.error.code, 'DANGLING_PARENT')

  // A chapter id is a legal parent (world.ts validates against the global projection).
  const crossKind = planWorldUpsert({
    entries: [ROOT_ENTRY],
    candidate: { id: 'w-5', path: 'world/门派/某役.md', title: '某役', category: '门派', parent: 'ch-1' },
    knownIds: new Set(['w-root', 'ch-1']),
  })
  assert.equal(crossKind.ok, true)
})

test('a flat category book is legal and must not be refused', () => {
  // The #8 review settled this: every entry under `world/<category>/` with no
  // parent has no root, and that is a valid book — not a missing root.
  const plan = planWorldUpsert({
    entries: [{ id: 'w-1', path: 'world/门派/白鹤门.md', title: '白鹤门', category: '门派' }],
    candidate: { id: 'w-2', path: 'world/门派/静水观.md', title: '静水观', category: '门派' },
  })
  assert.deepEqual(plan, { ok: true, path: 'world/门派/静水观.md', replaced: false })
})

test('a claim on a parent with no root at all is refused as WORLD_ROOT_MISSING', () => {
  const plan = planWorldUpsert({
    entries: [{ id: 'w-1', path: 'world/门派/白鹤门.md', title: '白鹤门', category: '门派' }],
    candidate: { id: 'w-2', path: 'world/门派/静水观.md', title: '静水观', category: '门派', parent: 'w-1' },
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.error.code, 'WORLD_ROOT_MISSING')
})

test('an id already used by another file, or a keyword the frontmatter cannot read back, is refused', () => {
  const duplicate = planWorldUpsert({
    entries: [{ id: 'w-1', path: 'world/门派/白鹤门.md', title: '白鹤门', category: '门派' }],
    candidate: { id: 'w-1', path: 'world/门派/静水观.md', title: '静水观', category: '门派' },
  })
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.error.code, 'DUPLICATE_ID')
  assert.equal(duplicate.error.path, 'world/门派/静水观.md')

  const keyword = planWorldUpsert({
    entries: [],
    candidate: { id: 'w-9', path: 'world/秘境/九幽.md', title: '九幽', category: '秘境', keywords: ['九幽,幽冥'] },
  })
  assert.equal(keyword.ok, false)
  assert.equal(keyword.error.code, 'KEYWORD_INVALID')
})

test('an in-place edit is a replace, not a duplicate', () => {
  const plan = planWorldUpsert({
    entries: [{ id: 'w-1', path: 'world/门派/白鹤门.md', title: '白鹤门', category: '门派' }],
    candidate: { id: 'w-1', path: 'world/门派/白鹤门.md', title: '白鹤门（改）', category: '门派' },
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.replaced, true)
})

// ---------------------------------------------------------------------------
// 5. The two tools
// ---------------------------------------------------------------------------

test('inkflow_world_tree reads the book through the index and groups it', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    const result = await callTool('inkflow_world_tree', { projectRoot: root })

    assert.equal(result.ok, true, `the gate accepts the fixture: ${JSON.stringify(result.error ?? {})}`)
    assert.equal(result.total, 4)
    const sect = result.groups.find((group) => group.category === '门派')
    assert.deepEqual(sect.nodes.map((node) => node.id), ['w-1'], 'one top node per group: 白鹤门')
    assert.deepEqual(sect.nodes[0].children.map((node) => node.id), ['w-2'], 'its child expands under it')
    assert.equal(result.groups.at(-1).category, null, 'the uncategorised bucket sorts last')
    assert.deepEqual(result.danglingParents, [])

    // A category filter narrows the same read.
    const only = await callTool('inkflow_world_tree', { projectRoot: root, category: '秘境' })
    assert.equal(only.total, 1)
    assert.deepEqual(only.groups.map((group) => group.category), ['秘境'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('inkflow_world_upsert writes nothing without confirm: true', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    const before = sha256(join(root, 'world/门派/白鹤门.md'))

    const refused = await callTool('inkflow_world_upsert', { projectRoot: root, title: '九幽', category: '秘境' })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'WORLD_UPSERT_REQUIRES_CONFIRMATION')
    assert.equal(refused.willWrite, 'world/秘境/九幽.md')
    assert.equal(existsSync(join(root, 'world/秘境/九幽.md')), false, 'nothing was written')
    assert.equal(sha256(join(root, 'world/门派/白鹤门.md')), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a write refused by I-08 leaves every file untouched', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    const before = sha256(join(root, 'world/总览.md'))

    const refused = await callTool('inkflow_world_upsert', { projectRoot: root, title: '第二个根', confirm: true })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'WORLD_ROOT_MULTIPLE')
    assert.equal(existsSync(join(root, 'world/第二个根.md')), false, 'a refused write must not create the file')
    assert.equal(sha256(join(root, 'world/总览.md')), before, 'and must not rewrite the existing root')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a confirmed upsert writes the fields, rebuilds the index and replaces in place', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)

    const created = await callTool('inkflow_world_upsert', {
      projectRoot: root,
      title: '九幽',
      category: '秘境',
      keywords: ['九幽', '幽冥'],
      always: true,
      priority: 5,
      body: '九幽之地，不闻天光。',
      confirm: true,
    })
    assert.equal(created.ok, true, `upsert failed: ${JSON.stringify(created.error ?? {})}`)
    assert.equal(created.path, 'world/秘境/九幽.md')
    assert.equal(created.created, true)
    assert.equal(created.indexRebuilt, true)

    const file = join(root, 'world/秘境/九幽.md')
    const text = readFileSync(file, 'utf8')
    assert.match(text, /^---\n/u)
    assert.match(text, /keywords: \[九幽, 幽冥\]/u)
    assert.match(text, /always: true/u)
    assert.match(text, /priority: 5/u)
    assert.match(text, /九幽之地，不闻天光。\n$/u)

    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(root, 'index', 'inkflow.db'))
    try {
      const rows = db
        .prepare('SELECT path, category, keywords, always, priority FROM world_entries WHERE id = ?')
        .all('world/秘境/九幽.md')
      assert.deepEqual(
        rows.map((row) => ({ ...row })),
        [{ path: 'world/秘境/九幽.md', category: '秘境', keywords: '九幽 幽冥', always: 1, priority: 5 }],
      )
    } finally {
      db.close()
    }

    // The same call again is a replace, and the index still holds exactly one row.
    const replaced = await callTool('inkflow_world_upsert', {
      projectRoot: root,
      title: '九幽',
      category: '秘境',
      keywords: ['九幽'],
      confirm: true,
    })
    assert.equal(replaced.ok, true)
    assert.equal(replaced.replaced, true)
    assert.equal(replaced.created, false)
    assert.doesNotMatch(readFileSync(file, 'utf8'), /always: true/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the upsert tool refuses a book that is not a usable project', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'plain')
    mkdirSync(root, { recursive: true })
    const result = await callTool('inkflow_world_upsert', { projectRoot: root, title: '九幽', confirm: true })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'NOT_AN_INKFLOW_PROJECT')
    assert.equal(existsSync(join(root, 'world')), false, 'the gate refuses before any directory is created')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
