/**
 * Issue #39 — the unified search entry (roadmap X-16) and the search-replace batch (X-17).
 *
 * Two DoDs live here, so the file is in two halves:
 *
 *   A. **Search.** `searchEntries` must answer one entry shape for every kind
 *      (`{kind,id,path,title,snippet,offset?,score?}`), page it deterministically
 *      (`{offset,limit,total}`, `limit` clamped to 100 with `truncated: true`), stay under
 *      300 ms on a 500-chapter book, and refuse an unusable index with `INDEX_UNAVAILABLE`
 *      while writing nothing at all.
 *   B. **Replace.** The preview and the apply must be the *same* computation: the set
 *      comparison `(chapterId, count)` below is the assertion, and it would fail if the two
 *      halves ever counted differently. A stale preview has to refuse the affected file
 *      instead of writing it, a batch has to leave every file's line endings alone, and a
 *      rollback has to restore the bytes exactly.
 *
 * Everything is driven through `lib/index.js` — the artifact a user installs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  buildIndex,
  replaceApply,
  replacePreview,
  rollbackBackup,
  searchEntries,
} from '../lib/index.js'
import { hashTree } from './hash-tree.mjs'

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const ALL_DIRS = [...CONTENT_DIRS, 'index']
const KEEP = '.gitkeep'
const DB = join('index', 'inkflow.db')

// ---------------------------------------------------------------------------
// harness (lib/index.js only, same shape as tests/search.test.js)
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
  return mkdtempSync(join(tmpdir(), 'inkflow-search39-'))
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

function skeleton(root) {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of ALL_DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, KEEP), '', 'utf8')
  }
  writeFileSync(join(root, '.gitignore'), '# InkFlow derived index\nindex/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '检索与替换之书' }, null, 2)}\n`, 'utf8')
}

function markdown(root, relativePath, lines, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, `---\n${lines.join('\n')}\n---\n\n${body}`, 'utf8')
}

/**
 * The fixture book. Bodies are shaped so every assertion is exact:
 *
 *   ch-0001  云海翻涌 (twice)          — the common hit
 *   ch-0002  星河倒悬                  — a hit that is NOT the replaced one
 *   characters/清音.md  aliases 云海仙子  — an entity hit, no frontmatter in the snippet
 *   world/云海.md       title 云海, keywords 云海 秘境
 * `藏经阁` exists only in ch-0001's frontmatter: it must never reach a snippet.
 */
function fixture(root) {
  skeleton(root)
  markdown(
    root,
    'chapters/vol-01/0001-云海初见.md',
    ['id: ch-0001', 'title: 第一章 云海初见', 'seq: 1', 'volume: vol-01', 'status: final', 'note: 藏经阁秘录'],
    '少年抬头望见云海翻涌，云海翻涌不止。',
  )
  markdown(root, 'chapters/vol-01/0002-剑气.md', ['id: ch-0002', 'title: 第二章 剑气', 'seq: 2', 'volume: vol-01'], '一剑星河倒悬。')
  markdown(root, 'chapters/0003-长街.md', ['id: ch-0003', 'title: 第三章 长街', 'seq: 3'], '长街空无一人。')
  markdown(root, 'characters/清音.md', ['id: c-qingyin', 'title: 清音', 'aliases: 云海仙子', 'role: 主角'], '# 清音\n\n门派弟子。\n')
  markdown(root, 'world/云海.md', ['id: w-yunhai', 'title: 云海', 'category: 地理', 'keywords: 云海 秘境'], '# 云海\n\n山间云气。\n')
}

async function builtBook(dir) {
  const root = join(dir, 'book')
  fixture(root)
  const harness = makeTools(join(dir, 'state'), dir)
  const rebuild = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
  assert.equal(rebuild.ok, true, `rebuild must succeed: ${JSON.stringify(rebuild.error)}`)
  return { root, harness }
}

/** Every chapter file, in reading order, as `{ path, text }` (raw bytes, not normalised). */
function chapterTexts(root) {
  const out = []
  const walk = (relative) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        walk(child)
        continue
      }
      if (!entry.name.endsWith('.md')) continue
      out.push({ path: child, text: readFileSync(join(root, child), 'utf8') })
    }
  }
  walk('chapters')
  return out.sort((left, right) => (left.path < right.path ? -1 : 1))
}

// ---------------------------------------------------------------------------
// A. One search entry for every kind (X-16)
// ---------------------------------------------------------------------------

test('search: a chapter matches on its title too, not only on its prose', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    // `第三章` appears in ch-0003's title only; its body is 长街空无一人。
    const result = searchEntries(root, '第三章', { kinds: ['chapters'] })
    assert.equal(result.ok, true)
    assert.equal(result.total, 1)
    assert.equal(result.items[0].id, 'ch-0003')
    assert.equal(result.items[0].snippet, '第三章 长街', 'a title-only hit shows the title it matched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search: body prose, a character and a world entry all answer with their own kind', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    const result = searchEntries(root, '云海', { limit: 100 })
    assert.equal(result.ok, true)
    assert.equal(result.searchBackend, 'fts5')
    assert.equal(result.degradedReason, undefined, 'the fts5 backend never degrades')

    const kinds = result.items.map((item) => `${item.kind}:${item.id}`)
    assert.equal(kinds.includes('chapters:ch-0001'), true, `the chapter body must be a hit: ${kinds.join(', ')}`)
    assert.equal(kinds.includes('characters:c-qingyin'), true, 'the character card matches through its alias')
    assert.equal(kinds.includes('world:w-yunhai'), true, 'the world entry matches through its title/keywords')

    // Every entry is the fixed X-16 shape; nothing else travels.
    const allowed = new Set(['kind', 'id', 'path', 'title', 'snippet', 'offset', 'score'])
    for (const item of result.items) {
      for (const key of Object.keys(item)) assert.equal(allowed.has(key), true, `${key} is not part of the X-16 entry`)
      assert.equal(typeof item.kind, 'string')
      assert.equal(typeof item.id, 'string')
      assert.equal(typeof item.title, 'string')
      assert.equal(typeof item.snippet, 'string')
      assert.equal(item.path.startsWith(`${item.kind}/`), true, `${item.kind}:${item.id} path must sit in its directory`)
    }

    // The snippet never carries frontmatter: `藏经阁` lives only in ch-0001's frontmatter.
    const chapter = result.items.find((item) => item.kind === 'chapters')
    assert.equal(chapter.snippet.includes('藏经阁'), false, 'a snippet must be body prose only')
    assert.equal(chapter.snippet.includes('---'), false)
    const character = result.items.find((item) => item.kind === 'characters')
    assert.equal(character.snippet, '清音 · 云海仙子', 'an entity snippet is its own fields, not its file')
    assert.equal(character.snippet.includes('role:'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search: the setting library is listed before chapter prose, and kinds narrows it', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    const all = searchEntries(root, '云海', { limit: 100 })
    assert.equal(all.ok, true)
    const firstChapter = all.items.findIndex((item) => item.kind === 'chapters')
    const lastEntity = all.items.map((item) => item.kind).lastIndexOf('world')
    assert.equal(lastEntity < firstChapter, true, 'entities come first: the library answers "where is this defined"')

    const chaptersOnly = searchEntries(root, '云海', { kinds: ['chapters'], limit: 100 })
    assert.equal(chaptersOnly.ok, true)
    assert.deepEqual([...new Set(chaptersOnly.items.map((item) => item.kind))], ['chapters'])

    const settled = searchEntries(root, '云海', { kinds: ['characters', 'world'], limit: 100 })
    assert.equal(settled.ok, true)
    assert.deepEqual(
      settled.items.map((item) => `${item.kind}:${item.id}`).sort(),
      ['characters:c-qingyin', 'world:w-yunhai'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search: a two-character term falls back to LIKE and still finds both sides', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    const result = searchEntries(root, '云海', { limit: 100 })
    assert.equal(result.ok, true)
    assert.equal(result.mode, 'like', 'trigram cannot match two characters, so the whole answer is a scan')
    assert.equal(result.items.length >= 3, true, 'body, character alias and world entry all match')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search: an unknown kind is refused, not ignored', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    const result = searchEntries(root, '云海', { kinds: ['chapterz'] })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'QUERY_INVALID')
    assert.equal(result.message.includes('chapterz'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search: paging slices one stable list and counts every match', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    const whole = searchEntries(root, '云海', { limit: 100 })
    assert.equal(whole.ok, true)
    assert.equal(whole.offset, 0)
    assert.equal(whole.limit, 100)
    assert.equal(whole.truncated, false)

    const page = searchEntries(root, '云海', { offset: 1, limit: 1 })
    assert.equal(page.ok, true)
    assert.equal(page.total, whole.total, 'total is the match count, not the page size')
    assert.deepEqual(page.items, [whole.items[1]], 'a page is a slice of the same ordered list')

    // X-16: `limit` above the ceiling is clamped and SAID, never refused.
    const clamped = searchEntries(root, '云海', { limit: 500 })
    assert.equal(clamped.ok, true)
    assert.equal(clamped.limit, 100)
    assert.equal(clamped.truncated, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search: an unusable index is INDEX_UNAVAILABLE and writes nothing', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    unlinkSync(join(root, DB))
    const before = hashTree(root)
    const result = searchEntries(root, '云海', { limit: 10 })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'INDEX_UNAVAILABLE')
    assert.equal(result.hint.includes('inkflow_index_rebuild'), true, 'the hint must point at the rebuild, not at a bug')
    assert.equal(hashTree(root), before, 'a search may not even create the index it could not read')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * DoD D4-3: 500 chapters, paging under 300 ms (cold and warm).
 *
 * The chapters are ~1k characters each, so the query has real work to do; the numbers are
 * printed by `node --test` (the assertion is the 300 ms ceiling, the print is the evidence
 * the PR quotes).
 */
test('search: a 500-chapter book pages under 300 ms, cold and warm', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    skeleton(root)
    const filler = '风从山谷里来，吹过松林与石阶。'.repeat(40) // ≈ 640 characters
    for (let index = 1; index <= 500; index += 1) {
      const volume = String(Math.ceil(index / 50)).padStart(2, '0')
      markdown(
        root,
        `chapters/vol-${volume}-卷${volume}/${String(index).padStart(4, '0')}-章${index}.md`,
        [`id: ch-${index}`, `title: 第${index}章 故事`, `seq: ${index}`, `volume: vol-${volume}`],
        index % 10 === 0 ? `${filler}云海翻涌。` : filler,
      )
    }
    markdown(root, 'characters/清音.md', ['id: c-qingyin', 'title: 清音', 'aliases: 云海仙子'], '# 清音\n')
    const harness = makeTools(join(dir, 'state'), dir)
    const rebuild = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
    assert.equal(rebuild.ok, true, 'the index must build for the benchmark to mean anything')

    const coldStart = process.hrtime.bigint()
    const cold = searchEntries(root, '云海翻涌', { limit: 20 })
    const coldMs = Number(process.hrtime.bigint() - coldStart) / 1e6
    const warmStart = process.hrtime.bigint()
    const warm = searchEntries(root, '云海翻涌', { offset: 20, limit: 20 })
    const warmMs = Number(process.hrtime.bigint() - warmStart) / 1e6
    process.stdout.write(`  500 chapters, limit 20: cold ${coldMs.toFixed(1)} ms, warm ${warmMs.toFixed(1)} ms\n`)

    assert.equal(cold.ok, true)
    assert.equal(warm.ok, true)
    assert.equal(cold.total, 50, 'every tenth chapter of 500 carries the phrase')
    assert.equal(cold.items.length, 20)
    assert.equal(warm.items.length, 20)
    assert.deepEqual(warm.items, cold.items.length === 20 ? searchEntries(root, '云海翻涌', { limit: 40 }).items.slice(20, 40) : warm.items)
    assert.equal(coldMs < 300, true, `cold paged search took ${coldMs.toFixed(1)} ms`)
    assert.equal(warmMs < 300, true, `warm paged search took ${warmMs.toFixed(1)} ms`)

    const clamped = searchEntries(root, '云海翻涌', { limit: 500 })
    assert.equal(clamped.limit, 100)
    assert.equal(clamped.truncated, true)
    assert.equal(clamped.items.length, 50, 'every match fits in one clamped page here')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('search: the tool answers the same envelope and refreshes the cache once', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    fixture(root)
    const harness = makeTools(join(dir, 'state'), dir)
    const result = await callTool(harness, 'inkflow_search', { projectRoot: root, query: '云海', limit: 10 })
    assert.equal(result.ok, true)
    assert.equal(result.searchBackend, 'fts5')
    assert.equal(result.indexRebuilt, true)
    assert.equal(Array.isArray(result.items), true)
    assert.equal(result.items.length > 0, true)
    const again = await callTool(harness, 'inkflow_search', { projectRoot: root, query: '云海', kinds: ['chapters'], limit: 10 })
    assert.equal(again.ok, true)
    assert.equal(again.indexRebuilt, false, 'the second search must not rebuild a fresh index')

    const refused = await callTool(harness, 'inkflow_search', { projectRoot: root, query: '   ' })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'QUERY_INVALID')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// B. Search-and-replace (X-17): preview = execution, rollback, stale plan
// ---------------------------------------------------------------------------

test('replace: the preview writes nothing and its hit set equals what apply does', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    const before = hashTree(root)
    const preview = replacePreview(root, { query: '云海翻涌', replacement: '星河倒悬' })
    assert.equal(preview.ok, true)
    assert.equal(hashTree(root), before, 'a preview must not write: not a byte, not an mtime')
    assert.equal(preview.items.length, 1, 'only ch-0001 holds the phrase')
    assert.equal(preview.items[0].chapterId, 'ch-0001')
    assert.equal(preview.items[0].count, 2)
    assert.equal(preview.items[0].before.includes('云海翻涌'), true)
    assert.equal(preview.items[0].after.includes('星河倒悬'), true)
    assert.equal(preview.items[0].after.includes('云海翻涌'), false, 'the after-context shows the result')

    const expected = preview.items.map((item) => ({ chapterId: item.chapterId, count: item.count }))
    const applied = replaceApply(root, { query: '云海翻涌', replacement: '星河倒悬', expected, confirm: true })
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.equal(applied.rolledBack, false)
    assert.equal(applied.replaced, 2)
    assert.equal(applied.skipped.length, 0)
    assert.equal(applied.backup !== undefined, true, 'a batch always opens a rollback package')

    // Set comparison, both directions: the preview and the write agreed exactly.
    const previewSet = new Set(preview.items.map((item) => `${item.chapterId}:${item.count}`))
    const appliedSet = new Set(applied.written.map((item) => `${item.chapterId}:${item.count}`))
    assert.deepEqual([...appliedSet].sort(), [...previewSet].sort())

    const chapter = readFileSync(join(root, 'chapters', 'vol-01', '0001-云海初见.md'), 'utf8')
    assert.equal(chapter.includes('云海翻涌'), false)
    assert.equal(chapter.includes('星河倒悬，星河倒悬不止'), true)
    assert.equal(chapter.includes('note: 藏经阁秘录'), true, 'the frontmatter is untouched')
    // Only the lines that held the query changed — a whole-chapter rewrite would fail here.
    const original = `---\nid: ch-0001\ntitle: 第一章 云海初见\nseq: 1\nvolume: vol-01\nstatus: final\nnote: 藏经阁秘录\n---\n\n少年抬头望见云海翻涌，云海翻涌不止。`
    const beforeLines = original.split('\n')
    const afterLines = chapter.replace(/\n$/u, '').split('\n')
    assert.equal(afterLines.length, beforeLines.length)
    const changed = beforeLines.map((line, index) => (line === afterLines[index] ? null : index)).filter((index) => index !== null)
    assert.deepEqual(changed, [beforeLines.length - 1], 'only the prose line differs')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replace: a CRLF chapter with a BOM keeps both after the rewrite', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    fixture(root)
    const crlfPath = join(root, 'chapters', 'vol-01', '0009-行尾.md')
    const crlfRaw = '\uFEFF---\r\nid: ch-0009\r\ntitle: 第九章 行尾\r\nseq: 9\r\nvolume: vol-01\r\n---\r\n\r\n云海翻涌不止。\r\n'
    writeFileSync(crlfPath, crlfRaw, 'utf8')
    const harness = makeTools(join(dir, 'state'), dir)
    await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })

    const preview = replacePreview(root, { query: '云海翻涌', replacement: '星河倒悬' })
    assert.equal(preview.ok, true)
    const expected = preview.items.map((item) => ({ chapterId: item.chapterId, count: item.count }))
    const applied = replaceApply(root, { query: '云海翻涌', replacement: '星河倒悬', expected, confirm: true })
    assert.equal(applied.ok, true)

    const bytes = readFileSync(crlfPath)
    assert.equal(bytes[0], 0xef, 'the UTF-8 BOM must survive')
    assert.equal(bytes[1], 0xbb)
    assert.equal(bytes[2], 0xbf)
    const text = bytes.toString('utf8')
    assert.equal(text.includes('\r\n'), true, 'the file was written with CRLF')
    assert.equal(/(?<!\r)\n/u.test(text), false, 'no bare LF was introduced')
    assert.equal(text.includes('星河倒悬不止'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replace: without confirm nothing is written, and apply refuses a missing expected set', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    const before = hashTree(root)
    const unconfirmed = replaceApply(root, { query: '云海翻涌', replacement: '星河', expected: [{ chapterId: 'ch-0001', count: 2 }] })
    assert.equal(unconfirmed.ok, false)
    assert.equal(unconfirmed.code, 'CONFIRM_REQUIRED')
    assert.equal(hashTree(root), before)

    const noExpected = replaceApply(root, { query: '云海翻涌', replacement: '星河', expected: undefined, confirm: true })
    assert.equal(noExpected.ok, false)
    assert.equal(noExpected.code, 'EXPECTED_REQUIRED')
    assert.equal(hashTree(root), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replace: a preview that expired is skipped per file and reported, never written', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    // Two chapters hold the phrase, so one can go stale while the other still applies.
    markdown(root, 'chapters/vol-01/0004-再会.md', ['id: ch-0004', 'title: 第四章 再会', 'seq: 4', 'volume: vol-01'], '云海翻涌又起。')
    const harness = makeTools(join(dir, 'state'), dir)
    await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })

    const preview = replacePreview(root, { query: '云海翻涌', replacement: '星河倒悬' })
    assert.equal(preview.ok, true)
    assert.equal(preview.items.length, 2)
    const expected = preview.items.map((item) => ({ chapterId: item.chapterId, count: item.count }))

    // The author edits one chapter by hand between the preview and the apply: the
    // hit count there moves from 2 to 3.
    const stalePath = join(root, 'chapters', 'vol-01', '0001-云海初见.md')
    const edited = readFileSync(stalePath, 'utf8').replace('不止。', '不止。云海翻涌。')
    writeFileSync(stalePath, edited, 'utf8')

    const before = hashTree(root)
    const applied = replaceApply(root, { query: '云海翻涌', replacement: '星河倒悬', expected, confirm: true })
    assert.equal(applied.ok, true, 'a stale file is a report, not a failed batch')
    assert.deepEqual(
      applied.skipped.map((item) => `${item.chapterId}:${item.reason}:${item.expected}->${item.actual}`),
      ['ch-0001:PREVIEW_STALE:2->3'],
    )
    assert.deepEqual(
      applied.written.map((item) => item.chapterId),
      ['ch-0004'],
      'the file whose count still matches is written',
    )
    // The stale chapter was NOT touched: it still holds three occurrences of the old text.
    assert.equal(readFileSync(stalePath, 'utf8').includes('云海翻涌'), true)
    assert.equal((readFileSync(stalePath, 'utf8').match(/云海翻涌/gu) ?? []).length, 3)
    assert.notEqual(hashTree(root), before, 'the other chapter really was rewritten')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replace: a hit the preview never listed is refused as NOT_IN_PREVIEW', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    const preview = replacePreview(root, { query: '云海翻涌', replacement: '星河倒悬' })
    assert.equal(preview.ok, true)
    const expected = preview.items.map((item) => ({ chapterId: item.chapterId, count: item.count }))

    // A new chapter appears with the same phrase: it is not in the author's preview,
    // so the batch must not silently include it.
    markdown(root, 'chapters/vol-01/0005-新章.md', ['id: ch-0005', 'title: 第五章 新章', 'seq: 5', 'volume: vol-01'], '云海翻涌新起。')

    const applied = replaceApply(root, { query: '云海翻涌', replacement: '星河倒悬', expected, confirm: true })
    assert.equal(applied.ok, true)
    assert.deepEqual(
      applied.skipped.map((item) => `${item.chapterId}:${item.reason}`),
      ['ch-0005:NOT_IN_PREVIEW'],
    )
    assert.equal(readFileSync(join(root, 'chapters', 'vol-01', '0005-新章.md'), 'utf8').includes('云海翻涌'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replace: rolling the package back restores the files byte for byte', async () => {
  const dir = workdir()
  try {
    const { root } = await builtBook(dir)
    const beforeBytes = new Map(chapterTexts(root).map((entry) => [entry.path, entry.text]))

    const preview = replacePreview(root, { query: '云海翻涌', replacement: '星河倒悬' })
    assert.equal(preview.ok, true)
    const expected = preview.items.map((item) => ({ chapterId: item.chapterId, count: item.count }))
    const applied = replaceApply(root, { query: '云海翻涌', replacement: '星河倒悬', expected, confirm: true })
    assert.equal(applied.ok, true)
    assert.equal(applied.backup !== undefined, true)
    assert.equal(existsSync(join(root, ...applied.backup.dir.split('/'), 'manifest.json')), true, 'the journal is on disk')

    // The interruption case: whatever happened after the writes, the package is what
    // puts the manuscript back.
    const rolled = rollbackBackup(root, applied.backup.dir)
    assert.equal(rolled.ok, true, JSON.stringify(rolled))
    for (const [path, text] of beforeBytes) {
      assert.equal(readFileSync(join(root, ...path.split('/')), 'utf8'), text, `${path} must be byte-identical after the rollback`)
    }
    // …and a second rollback is refused instead of pretending.
    const twice = rollbackBackup(root, applied.backup.dir)
    assert.equal(twice.ok, false)
    assert.equal(twice.error.code, 'BACKUP_ALREADY_ROLLED_BACK')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replace: the tool previews without writing and applies with the preview set', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    fixture(root)
    const harness = makeTools(join(dir, 'state'), dir)
    const before = hashTree(root)
    const preview = await callTool(harness, 'inkflow_search_replace', { projectRoot: root, query: '云海翻涌', replacement: '星河倒悬' })
    assert.equal(preview.ok, true)
    assert.equal(preview.applied, false)
    assert.equal(hashTree(root), before, 'the preview route writes nothing either')

    const applied = await callTool(harness, 'inkflow_search_replace', {
      projectRoot: root,
      action: 'apply',
      query: '云海翻涌',
      replacement: '星河倒悬',
      expected: preview.items.map((item) => ({ chapterId: item.chapterId, count: item.count })),
      confirm: true,
    })
    assert.equal(applied.ok, true, JSON.stringify(applied.error ?? {}))
    assert.equal(applied.applied, true)
    assert.equal(applied.replaced, 2)
    assert.equal(applied.indexRebuilt, true, 'a write rebuilds the derived cache')
    assert.equal(readFileSync(join(root, 'chapters', 'vol-01', '0001-云海初见.md'), 'utf8').includes('星河倒悬'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replace: the preview needs no index, and building one does not change its answer', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    fixture(root)
    // No index at all: the preview reads the chapter files through the catalog, which
    // is why a stale cache cannot make it count the wrong number of places to edit.
    assert.equal(existsSync(join(root, DB)), false)
    const preview = replacePreview(root, { query: '云海翻涌', replacement: '星河倒悬' })
    assert.equal(preview.ok, true)
    assert.equal(preview.items.length, 1)
    assert.equal(existsSync(join(root, DB)), false, 'a preview must not build the cache either')

    await buildIndex(root)
    const afterIndex = replacePreview(root, { query: '云海翻涌', replacement: '星河倒悬' })
    assert.deepEqual(afterIndex.items, preview.items, 'the plan does not depend on the cache')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
