/**
 * The chapter list's 500-row cap used to be silent.
 *
 * `listChapters` clamped every request with `LIMIT min(max(limit,1),500)` and nothing
 * reported the cut; `inkflow_chapter_list` then read the *cut* list back as `total`, so a
 * 520-chapter book answered "100 chapters" (or "500" at the cap) with no sign that the
 * reply was partial. `ovk-ledger.ts` had grown its own unbounded query on top of that, so
 * one book had two chapter counts depending on which entry point you asked.
 *
 * The contract these tests pin:
 *
 *   - `limit` is a **page** cap (`LIST_CHAPTERS_MAX`), not a book size;
 *   - `offset` walks the pages, and the cap/offset are clamped (1..500, >= 0);
 *   - `total` is always the **whole** book, from `countChapters`;
 *   - `truncated` is `offset + returned < total` — "chapters still follow this page".
 *     The last page of a long book is therefore `false` (there is nothing after it), and
 *     an empty page past the end is `false` too: the flag answers "should I page on?",
 *     which is the only question a caller can act on. "This page is a slice" is already
 *     visible from `total` vs `returned`, and a flag that stayed `true` on the last page
 *     would send the caller into an empty reply;
 *   - `listAllChapters` is the one unbounded read, and `chapterSources` (the semantic
 *     ledger) goes through it so both entries see the same 520.
 *
 * Runs against the BUILT artifact (`lib/index.js`), like every other suite here.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LIST_CHAPTERS_MAX,
  apply,
  buildIndex,
  chapterSources,
  countChapters,
  listAllChapters,
  listChapters,
} from '../lib/index.js'

const DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']
const BOOK = 520

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-chapter-limit-'))
}

function scaffold(root, title = '五百二十章书') {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title }, null, 2)}\n`, 'utf8')
}

/** `count` chapters with ids `ch-1 … ch-N`, `seq: 1 … N`, two characters of prose each. */
function writeChapters(root, count) {
  for (let seq = 1; seq <= count; seq += 1) {
    const id = `ch-${String(seq)}`
    const file = join(root, 'chapters', 'vol-01', `${String(seq).padStart(4, '0')}-${id}.md`)
    mkdirSync(join(root, 'chapters', 'vol-01'), { recursive: true })
    writeFileSync(file, `---\nid: ${id}\ntitle: 第 ${String(seq)} 章\nseq: ${String(seq)}\n---\n\n正文 ${String(seq)}。\n`, 'utf8')
  }
}

/** The tool surface needs a fake Cordis context; only `tools` is exercised here. */
function makeTools(dataDir, workspace) {
  const tools = new Map()
  const ctx = {
    effect(setup) {
      setup()
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
    webServer: { register: () => () => {} },
  }
  apply(ctx, { dataDir })
  return { ctx, tools }
}

async function callTool(harness, toolName, args) {
  const tool = harness.tools.get(toolName)
  assert.ok(tool, `tool ${toolName} must be registered`)
  return tool.execute(args, { signal: AbortSignal.timeout(120000), agent: { id: 'test-session' } })
}

/** A 520-chapter book with its derived index already built (one build, shared by the tests). */
async function longBook(dir) {
  const root = join(dir, 'book')
  scaffold(root)
  writeChapters(root, BOOK)
  await buildIndex(root)
  return root
}

test('chapter list: the 500-row cap is a page cap, and `total` is the whole book', async () => {
  const dir = workdir()
  try {
    const root = await longBook(dir)

    assert.equal(LIST_CHAPTERS_MAX, 500, 'the page cap is an exported contract, not a literal')
    assert.equal(countChapters(root), BOOK, 'countChapters counts every chapter')

    // Page 1 is a full page, not the book.
    const first = listChapters(root)
    assert.equal(first.length, 100, 'the default page is 100')
    assert.deepEqual(
      first.map((chapter) => chapter.seq).slice(0, 3),
      [1, 2, 3],
      'reading order is `seq IS NULL, seq, path`',
    )

    // The cap applies to the page and only to the page: asking for more returns one cap.
    assert.equal(listChapters(root, BOOK).length, LIST_CHAPTERS_MAX, 'a page never exceeds the cap')
    assert.equal(listChapters(root, 0).length, 1, 'limit is clamped up to 1')
    assert.equal(listChapters(root, 1, -5).length, 1, 'offset is clamped to 0')
    assert.equal(listChapters(root, 1, -5)[0].seq, 1, 'a negative offset serves the first chapter')

    // Paging reaches the end of the book.
    const tail = listChapters(root, 100, 500)
    assert.equal(tail.length, 20, 'the second page of a 520-chapter book holds 20')
    assert.equal(tail[0].seq, 501)
    assert.equal(tail[19].seq, 520)
    assert.deepEqual(listChapters(root, 100, BOOK), [], 'past the end is an empty page, not a crash')

    // The unbounded read is the one the semantic ledger needs, and it agrees with the count.
    const all = listAllChapters(root)
    assert.equal(all.length, BOOK, 'listAllChapters is not capped')
    assert.equal(all.length, countChapters(root), 'the two entries report one chapter count')
    assert.deepEqual(
      all.map((chapter) => chapter.seq),
      Array.from({ length: BOOK }, (_unused, index) => index + 1),
      'and the same reading order',
    )
    assert.deepEqual(
      (chapterSources(root) ?? []).map((chapter) => chapter.id),
      all.map((chapter) => chapter.id),
      'the semantic ledger sees the same chapters as the index',
    )
    assert.equal((chapterSources(root) ?? []).length, BOOK, 'the rebuild path is no longer truncated at 500')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('chapter list: no index yet means "unavailable", not "0 chapters"', () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    writeChapters(root, 3)
    assert.equal(countChapters(root), undefined, 'countChapters refuses to answer without an index')
    assert.equal(listChapters(root), undefined, 'and so does the page read')
    assert.equal(listAllChapters(root), undefined, 'and so does the unbounded read')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('chapter list tool: total is the whole book, returned/offset/truncated describe the page', async () => {
  const dir = workdir()
  try {
    const root = await longBook(dir)
    const harness = makeTools(join(dir, 'state'), dir)

    const first = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root })
    assert.equal(first.ok, true)
    assert.equal(first.total, BOOK, 'total is the book, not the page')
    assert.equal(first.returned, 100, 'the default page is 100 chapters')
    assert.equal(first.offset, 0)
    assert.equal(first.truncated, true, '100 of 520: chapters 101+ still follow')
    assert.equal(first.chapters.length, 100)

    const second = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root, offset: 500 })
    assert.equal(second.total, BOOK)
    assert.equal(second.returned, 20)
    assert.equal(second.offset, 500)
    assert.equal(second.chapters[0].seq, 501)
    assert.equal(second.truncated, false, 'nothing follows the last page: the flag answers "page on?" and the answer is no')

    // Asking for more than the cap reports the cap it actually served.
    const capped = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root, limit: 5000 })
    assert.equal(capped.returned, LIST_CHAPTERS_MAX, 'a page is capped at 500 chapters')
    assert.equal(capped.total, BOOK)
    assert.equal(capped.truncated, true, 'chapters 501+ still follow a 500-chapter page')

    // Past the end: an empty page that still tells the truth about the book.
    const past = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root, offset: 900 })
    assert.equal(past.ok, true)
    assert.equal(past.returned, 0)
    assert.equal(past.truncated, false, 'an empty page past the end promises nothing more')
    assert.equal(past.total, BOOK, 'an empty page does not report an empty book')
    assert.deepEqual(past.chapters, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('chapter list tool: truncated is "more follow", so the last page of a book is false', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root, '三章书')
    writeChapters(root, 3)
    await buildIndex(root)
    const harness = makeTools(join(dir, 'state'), dir)

    const whole = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root })
    assert.equal(whole.total, 3)
    assert.equal(whole.returned, 3)
    assert.equal(whole.truncated, false, 'the whole book fit: nothing follows')

    const slice = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root, limit: 2 })
    assert.equal(slice.returned, 2)
    assert.equal(slice.total, 3, 'a page smaller than the book still reports the real total')
    assert.equal(slice.truncated, true, 'chapter 3 of 3 follows the 2-chapter page')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
