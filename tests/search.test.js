/**
 * Issue #22 — chapter full-text search over the derived index (ADR-0005).
 *
 * The index is a cache, and `chapters_fts` is built with `tokenize='trigram'`.
 * Trigram matching needs at least three characters: a 1–2 character query
 * returns zero rows *without an error*, which is the failure this feature fixes
 * by answering those queries with a `LIKE` scan instead.
 *
 * These tests drive the built artifact (`lib/index.js`) the way a user gets it,
 * and they assert the two questions the feature has to answer:
 *
 *   1. Does every query shape (3+ chars, 2 chars, 1 char, punctuation, empty,
 *      over-long) answer with data instead of an exception?
 *   2. Is a search read-only — including when the index is absent or built by
 *      another schema, where the answer must be `INDEX_UNAVAILABLE` and the
 *      project must be byte-for-byte unchanged?
 *
 * The raw-SQL assertions mirror `indexer.ts` (table name, tokenizer) only where
 * the test needs to prove *why* a branch exists; the product assertions go
 * through `searchChapters` / `inkflow_chapter_search`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { apply, searchChapters } from '../lib/index.js'

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const ALL_DIRS = [...CONTENT_DIRS, 'index']
const KEEP = '.gitkeep'
const DB = join('index', 'inkflow.db')

// ---------------------------------------------------------------------------
// harness (same shape as tests/index-parity.test.js: lib/index.js only)
// ---------------------------------------------------------------------------

function createHarness(workspace) {
  const tools = new Map()
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
  return mkdtempSync(join(tmpdir(), 'inkflow-search-'))
}

function makeTools(dataDir, workspace) {
  const harness = createHarness(workspace)
  apply(harness.ctx, { dataDir })
  return harness
}

async function callTool(harness, toolName, args) {
  const tool = harness.tools.get(toolName)
  assert.ok(tool, `tool ${toolName} must be registered`)
  return tool.execute(args, { signal: AbortSignal.timeout(60000), agent: { id: 'test-session' } })
}

/** One markdown file; `lines` is the frontmatter between the `---` pair. */
function markdown(root, relativePath, lines, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, `---\n${lines.join('\n')}\n---\n\n${body}`, 'utf8')
}

/** The project skeleton: usable from the first read, index not built yet. */
function skeleton(root) {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of ALL_DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, KEEP), '', 'utf8')
  }
  writeFileSync(join(root, '.gitignore'), '# InkFlow derived index\nindex/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '检索测试之书' }, null, 2)}\n`, 'utf8')
}

/**
 * The fixture book. Bodies are shaped so every assertion below is exact:
 *
 *   ch-0001  seq 1  long body (140 chars before / 120 after the hit)
 *   ch-0002  seq 2  punctuation, a quoted line, `*`, `-`
 *   ch-0003  seq 3  top-level chapter (no volume), holds 长街 + 少年
 *   ch-0004  seq 4  second 长街 / 少年 so ordering and limit are meaningful
 *
 * `藏经阁` exists only in ch-0001's frontmatter: it must never reach a snippet.
 */
function fixture(root) {
  skeleton(root)
  const before = '风从山谷里来。'.repeat(20)
  const after = '他站了很久。'.repeat(20)
  markdown(
    root,
    'chapters/vol-01/0001-云海初见.md',
    ['id: ch-0001', 'title: 第一章 云海初见', 'status: final', 'note: 藏经阁秘录'],
    `${before}少年抬头望见云海翻涌。${after}`,
  )
  markdown(
    root,
    'chapters/vol-01/0002-剑气.md',
    ['id: ch-0002', 'title: 第二章 剑气纵横', 'status: draft'],
    '剑气纵横三万里，一剑光寒十九州。他说："走吧"。*注* - 此处略。',
  )
  markdown(root, 'chapters/0003-长街.md', ['id: ch-0003', 'title: 第三章 长街', 'status: revised'], '长街空无一人，风起时少年独行。')
  markdown(root, 'chapters/vol-01/0004-长街再会.md', ['id: ch-0004', 'title: 第四章 长街再会', 'status: draft'], '又是长街，少年回头。')
}

/** Every path under `root` with size + mtime: the "this query wrote nothing" probe. */
function snapshot(root) {
  const out = []
  const walk = (relative) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        out.push(`${child}/`)
        walk(child)
        continue
      }
      const info = statSync(join(root, child))
      out.push(`${child}|${info.size}|${info.mtimeMs}`)
    }
  }
  walk('')
  return out.sort()
}

/** Read-only raw access, used only to prove the trigram boundary. */
function readDb(root, fn) {
  const db = new DatabaseSync(join(root, DB), { readOnly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

async function builtBook(dir) {
  const root = join(dir, 'book')
  fixture(root)
  const harness = makeTools(join(dir, 'state'), dir)
  const rebuild = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
  assert.equal(rebuild.ok, true, `rebuild must succeed: ${JSON.stringify(rebuild.error)}`)
  return { root, harness }
}

// ---------------------------------------------------------------------------
// 1. ≥3 characters: the trigram index answers, best match first
// ---------------------------------------------------------------------------

test('search: a three-or-more-character query is answered by the trigram FTS (mode fts)', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    const result = searchChapters(root, '云海翻涌')
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'fts', 'a 4-character Chinese query must take the FTS branch')
    assert.equal(result.total, 1)
    assert.deepEqual(result.items, [
      {
        chapterId: 'ch-0001',
        file: 'chapters/vol-01/0001-云海初见.md',
        title: '第一章 云海初见',
        seq: 1,
        snippet: result.items[0].snippet,
      },
    ])
    assert.equal(result.items[0].snippet.includes('云海翻涌'), true, 'the snippet must contain the hit')

    const second = searchChapters(root, '剑气纵横')
    assert.equal(second.ok, true)
    assert.equal(second.mode, 'fts')
    assert.deepEqual(
      second.items.map((item) => item.chapterId),
      ['ch-0002'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. 2 characters: trigram returns zero rows, LIKE finds it (the whole point)
// ---------------------------------------------------------------------------

test('search: a two-character query is answered by LIKE where trigram returns nothing', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)

    // Evidence for the branch: the index's own trigram MATCH cannot see it.
    const trigram = readDb(root, (db) => db.prepare('SELECT COUNT(*) AS n FROM chapters_fts WHERE chapters_fts MATCH ?').get('"云海"'))
    assert.equal(trigram.n, 0, 'trigram MATCH on a 2-character query returns zero rows')

    const result = searchChapters(root, '云海')
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'like')
    assert.equal(result.total, 1)
    assert.equal(result.items[0].chapterId, 'ch-0001')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search: a one-character query is answered by LIKE too', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    const result = searchChapters(root, '剑')
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'like')
    assert.deepEqual(
      result.items.map((item) => item.chapterId),
      ['ch-0002'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. Every query shape answers with data, never with a parser error
// ---------------------------------------------------------------------------

test('search: FTS syntax characters are treated literally and never throw', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    // A leading `-` used to reach the parser as NOT; `"`/`*`/parentheses/NEAR
    // are all FTS5 operators. Every one of these must be a plain phrase.
    const queries = ['-云海翻', '"云海翻', '云海*', '云海"翻', 'OR', 'NEAR(云海翻涌)', 'a*b-c', '*注*', '"', '%', '_', '\\']
    for (const query of queries) {
      const result = searchChapters(root, query)
      assert.equal(result.ok, true, `query ${JSON.stringify(query)} must answer with data, got ${JSON.stringify(result)}`)
      assert.ok(result.mode === 'fts' || result.mode === 'like', `unexpected mode for ${JSON.stringify(query)}`)
    }
    // LIKE metacharacters are escaped, not operators: they match no body here.
    assert.equal(searchChapters(root, '%').total, 0)
    assert.equal(searchChapters(root, '_').total, 0)
    // A literal quote is a 1-character LIKE query and does occur in ch-0002.
    assert.equal(searchChapters(root, '"').total, 1)
    // Punctuation is indexed by trigram, so a 3-character punctuation query hits.
    assert.equal(searchChapters(root, '*注*').total, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search: whitespace splits terms; any term shorter than three characters falls back to LIKE', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    // Both terms are indexable → FTS AND.
    const fts = searchChapters(root, '云海翻涌 剑气')
    assert.equal(fts.ok, true)
    assert.equal(fts.mode, 'like', 'a 2-character term makes the whole query unindexable')

    // Both terms are short → LIKE AND over every term (this is the useful case).
    const both = searchChapters(root, '云海 翻涌')
    assert.equal(both.ok, true)
    assert.equal(both.mode, 'like')
    assert.deepEqual(
      both.items.map((item) => item.chapterId),
      ['ch-0001'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search: an empty or blank query returns no items without touching the index', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    const before = snapshot(root)
    for (const query of ['', '   ', '\n\t ']) {
      const result = searchChapters(root, query)
      assert.deepEqual(result, { ok: true, items: [], total: 0, mode: 'like' })
    }
    assert.deepEqual(snapshot(root), before, 'an empty query must not write anything')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. Limit, ordering and snippets
// ---------------------------------------------------------------------------

test('search: limit truncates items while total keeps counting every match', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    const all = searchChapters(root, '少年')
    assert.equal(all.ok, true)
    assert.equal(all.total, 3, 'ch-0001, ch-0003 and ch-0004 all contain 少年')
    assert.equal(all.items.length, 3)

    const one = searchChapters(root, '少年', { limit: 1 })
    assert.equal(one.ok, true)
    assert.equal(one.total, 3, 'total is the match count, not the page size')
    assert.equal(one.items.length, 1)
    assert.equal(one.items[0].chapterId, 'ch-0001', 'LIKE results start at the earliest seq')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search: LIKE results are ordered by seq and then by file', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    const result = searchChapters(root, '长街')
    assert.equal(result.ok, true)
    assert.deepEqual(
      result.items.map((item) => item.file),
      ['chapters/0003-长街.md', 'chapters/vol-01/0004-长街再会.md'],
    )
    assert.deepEqual(
      result.items.map((item) => item.seq),
      [3, 4],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search: the snippet is 40 characters either side of the hit and carries no frontmatter', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    const result = searchChapters(root, '云海')
    assert.equal(result.ok, true)
    const snippet = result.items[0].snippet
    // 40 before + 2 hit + 40 after + two ellipses.
    assert.equal(snippet.length, 40 + 2 + 40 + 2, `unexpected snippet: ${JSON.stringify(snippet)}`)
    assert.equal(snippet.startsWith('…'), true)
    assert.equal(snippet.endsWith('…'), true)
    assert.equal(snippet.indexOf('云海'), 41, '40 surrounding characters precede the hit')
    assert.equal(snippet.includes('藏经阁'), false, 'frontmatter must never leak into a snippet')
    assert.equal(snippet.includes('note:'), false)

    // The radius is an option; 0 means "no snippet".
    const tight = searchChapters(root, '云海', { snippet: 5 })
    assert.equal(tight.ok, true)
    assert.equal(tight.items[0].snippet.length, 5 + 2 + 5 + 2)
    assert.equal(tight.items[0].snippet.indexOf('云海'), 6)

    const bare = searchChapters(root, '云海', { snippet: 0 })
    assert.equal(bare.ok, true)
    assert.equal(bare.items[0].snippet, '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. An unavailable index is reported and never repaired by the read path
// ---------------------------------------------------------------------------

test('search: an absent index returns INDEX_UNAVAILABLE and writes nothing', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    fixture(root)
    const before = snapshot(root)
    const result = searchChapters(root, '云海翻涌')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'INDEX_UNAVAILABLE')
    assert.match(result.message, /index/i)
    assert.equal(existsSync(join(root, DB)), false, 'the read path must not create the database')
    assert.deepEqual(snapshot(root), before, 'the project must be byte-for-byte unchanged')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search: an index built by another schema is INDEX_UNAVAILABLE and is not rewritten', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    const dbFile = join(root, DB)
    const writer = new DatabaseSync(dbFile)
    try {
      writer.exec('PRAGMA user_version = 999')
    } finally {
      writer.close()
    }
    const before = statSync(dbFile)
    const result = searchChapters(root, '云海翻涌')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'INDEX_UNAVAILABLE')
    const after = statSync(dbFile)
    assert.equal(after.size, before.size, 'the database file must not change')
    assert.equal(after.mtimeMs, before.mtimeMs, 'the database file must not be rewritten')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search: a non-string query is QUERY_INVALID, not a thrown stack', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    assert.equal(searchChapters(root, undefined).ok, false)
    assert.equal(searchChapters(root, undefined).code, 'QUERY_INVALID')
    assert.equal(searchChapters(root, 42).code, 'QUERY_INVALID')
    const tooLong = '云'.repeat(201)
    const long = searchChapters(root, tooLong)
    assert.equal(long.ok, false)
    assert.equal(long.code, 'QUERY_INVALID')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. The tool: gate, lazy rebuild once, then the same answers
// ---------------------------------------------------------------------------

test('tool: inkflow_chapter_search rebuilds a missing index once and then answers', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    fixture(root)
    assert.equal(existsSync(join(root, DB)), false)
    const harness = makeTools(join(dir, 'state'), dir)
    const tool = harness.tools.get('inkflow_chapter_search')
    assert.ok(tool, 'inkflow_chapter_search must be registered')
    assert.deepEqual(tool.parameters.required, ['query'])
    assert.ok(tool.parameters.properties.query)
    assert.ok(tool.parameters.properties.limit)

    const result = await callTool(harness, 'inkflow_chapter_search', { projectRoot: root, query: '云海翻涌' })
    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.equal(result.indexRebuilt, true, 'a missing index is rebuilt once by the tool layer')
    assert.equal(result.mode, 'fts')
    assert.equal(result.total, 1)
    assert.equal(result.items[0].chapterId, 'ch-0001')
    assert.equal(existsSync(join(root, DB)), true, 'the lazy rebuild created the index')

    // Second call: the index is there, so nothing is rebuilt.
    const again = await callTool(harness, 'inkflow_chapter_search', { projectRoot: root, query: '云海' })
    assert.equal(again.ok, true)
    assert.equal(again.indexRebuilt, false)
    assert.equal(again.mode, 'like')
    assert.equal(again.total, 1)

    const rendered = tool.output.render({ query: '云海' }, again)
    const renderedText = rendered.map((block) => block.text).join('\n')
    assert.match(renderedText, /云海/)
    assert.match(renderedText, /ch-0001|第一章 云海初见/)
    assert.match(renderedText, /like/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tool: inkflow_chapter_search refuses outside a project and rejects a blank query', async () => {
  const dir = workdir()
  try {
    const empty = join(dir, 'empty')
    mkdirSync(empty, { recursive: true })
    const harness = makeTools(join(dir, 'state'), empty)
    const refusal = await callTool(harness, 'inkflow_chapter_search', { query: '云海' })
    assert.equal(refusal.ok, false)
    assert.equal(refusal.error.code, 'NOT_AN_INKFLOW_PROJECT')
    assert.equal(existsSync(join(empty, DB)), false, 'a refusal writes nothing')

    const root = join(dir, 'book')
    fixture(root)
    const inside = makeTools(join(dir, 'state2'), dir)
    const blank = await callTool(inside, 'inkflow_chapter_search', { projectRoot: root, query: '   ' })
    assert.equal(blank.ok, false)
    assert.equal(blank.error.code, 'QUERY_INVALID')
    const missing = await callTool(inside, 'inkflow_chapter_search', { projectRoot: root })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'QUERY_INVALID')
    assert.equal(existsSync(join(root, DB)), false, 'a rejected query writes nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7. Cost: 100k characters of manuscript, one two-character query
// ---------------------------------------------------------------------------

test('search: a two-character query over a 100k-character book stays fast', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    skeleton(root)
    let characters = 0
    const filler = '少年游历江湖，看尽人间烟火，也见过长街无人。'
    for (let index = 1; index <= 20; index += 1) {
      const body = filler.repeat(250)
      characters += body.length
      markdown(
        root,
        `chapters/perf/${String(index).padStart(4, '0')}-perf.md`,
        [`id: ch-${String(index).padStart(4, '0')}`, `title: 第${index}章 长街`, 'status: draft'],
        body,
      )
    }
    assert.ok(characters >= 100000, `fixture must exceed 100k characters, got ${characters}`)

    const harness = makeTools(join(dir, 'state'), dir)
    const rebuild = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
    assert.equal(rebuild.ok, true, JSON.stringify(rebuild.error))

    const started = performance.now()
    const result = searchChapters(root, '江湖', { limit: 20 })
    const elapsed = performance.now() - started
    assert.equal(result.ok, true)
    assert.equal(result.total, 20, 'the LIKE scan must see every chapter')
    // The acceptance target is 100 ms on this corpus; the bound below is 5x that
    // so a slow CI machine still reports a real regression rather than noise.
    assert.ok(elapsed < 500, `2-character LIKE over ${characters} characters took ${elapsed.toFixed(1)} ms`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
