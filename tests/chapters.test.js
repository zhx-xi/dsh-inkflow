/**
 * Volume/chapter CRUD contract (issue #16, ADR-0006 D6).
 *
 * The whole point of this surface is that the **files stay the truth**: a tool
 * call moves bytes, and the two catalogs plus the derived index follow whatever
 * the `.md` files now say. The tests below therefore assert three things for
 * every operation, in this order:
 *
 *   1. the .md files (path, bytes, frontmatter) are exactly what was asked;
 *   2. the catalog projection agrees with them (`readCatalog` reports no drift);
 *   3. the derived index agrees too (it is a cache, so it must be rebuilt).
 *
 * Two properties get their own suite because they are the reason the tool exists
 * at all: a volume rename must not touch a single chapter frontmatter byte (all
 * chapters keep their `volume` value and their id), and a failure halfway through
 * a multi-file operation must leave the tree exactly as it was.
 *
 * Failure injection: Windows ignores the read-only attribute for file creation,
 * so "make the directory read-only" cannot be reproduced portably. Instead the
 * catalog target is replaced by a *directory* of the same name — the atomic
 * writer refuses to rename over a directory (`IO_FAILED`), which is a real
 * failure mode of the same shape: the mutation already happened, the projection
 * cannot be written, and the operation has to roll back.
 *
 * These run against the built artifact (lib/index.js), like every other suite.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { apply, parseMarkdown, readCatalog } from '../lib/index.js'

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
const ROOT_CATALOG = 'chapters/index.json'
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// ---------------------------------------------------------------------------
// Harness (same shape as contract.test.js: fake context, real files)
// ---------------------------------------------------------------------------

function createHarness(workspace, dataDir) {
  const tools = new Map()
  const logs = []
  const ctx = {
    effect(setup) {
      const dispose = setup()
      if (typeof dispose === 'function') dispose()
      return () => {}
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    get(name) {
      // The session workspace is the only trust anchor for path scope.
      if (name === 'workingDirectory' && typeof workspace === 'string') {
        return { ensure: async () => workspace }
      }
      return undefined
    },
    logger() {
      return {
        debug() {},
        info(message) {
          logs.push(String(message))
        },
        warn(message) {
          logs.push(String(message))
        },
        error(message) {
          logs.push(String(message))
        },
      }
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
  apply(ctx, { dataDir })
  return { ctx, tools, logs }
}

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-chapters-'))
}

function scaffold(dir) {
  const root = join(dir, 'book')
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const name of ALL_DIRS) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(
    join(root, 'inkflow.json'),
    `${JSON.stringify({ schemaVersion: 1, title: '卷章测试', author: 'tester' }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(root, '.gitignore'), 'index/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  return root
}

function makeHarness(root) {
  return createHarness(root, mkdtempSync(join(tmpdir(), 'inkflow-chapters-state-')))
}

function call(harness, toolName, args) {
  const tool = harness.tools.get(toolName)
  assert.ok(tool, `tool ${toolName} must be registered`)
  return tool.execute({ projectRoot: args.projectRoot, ...args }, { signal: AbortSignal.timeout(10_000), agent: { id: 'test-session' } })
}

function read(path) {
  return readFileSync(path, 'utf8')
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
}

/** Split a document into its frontmatter block (verbatim) and its body. */
function splitDoc(text) {
  const match = /^(---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n)/.exec(text)
  return match === null ? { head: '', body: text } : { head: match[1], body: text.slice(match[1].length) }
}

/** Every `.md` under chapters/, recursively, project-relative. */
function chapterFiles(root) {
  const out = []
  const walk = (relative) => {
    const absolute = join(root, ...relative.split('/'))
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.name.toLowerCase().endsWith('.md')) out.push(child)
    }
  }
  walk('chapters')
  return out.sort()
}

/** The truth only: volume directory names plus every chapter `.md` hash. */
function chapterSnapshot(root) {
  const volumes = readdirSync(join(root, 'chapters'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const files = chapterFiles(root).map(
    (file) => `${file}:${createHash('sha256').update(readFileSync(join(root, ...file.split('/')))).digest('hex')}`,
  )
  return { volumes, files }
}

/** Hash of every catalog file that is a file (the injection replaces one with a directory). */
function catalogHashes(root) {
  const out = {}
  const walk = (relative) => {
    const absolute = join(root, ...relative.split('/'))
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.name === 'index.json') {
        out[child] = createHash('sha256').update(readFileSync(join(root, ...child.split('/')))).digest('hex')
      }
    }
  }
  walk('chapters')
  return out
}

function indexChapterCount(root) {
  const db = new DatabaseSync(join(root, 'index', 'inkflow.db'), { readOnly: true })
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM chapters').get()
    return typeof row?.n === 'number' ? row.n : 0
  } finally {
    db.close()
  }
}

/** Make the root catalog unwritable: a directory of that name cannot be renamed over. */
function breakRootCatalog(root) {
  rmSync(join(root, ROOT_CATALOG), { force: true })
  mkdirSync(join(root, ROOT_CATALOG))
}

function volumeDir(root, volumeId) {
  const volume = readCatalog(root).catalog.volumes.find((item) => item.volumeId === volumeId)
  return volume === undefined ? undefined : volume.dir
}

// ---------------------------------------------------------------------------
// 1. inkflow_volume_create
// ---------------------------------------------------------------------------

test('volume: create allocates vol-NN, writes the directory and rebuilds catalog + index', async () => {
  const dir = workdir()
  try {
    const root = scaffold(dir)
    const harness = makeHarness(root)

    const first = await call(harness, 'inkflow_volume_create', { title: '入山卷' })
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.deepEqual(first.volume, { volumeId: 'vol-01', dir: 'vol-01-入山卷', title: '入山卷', order: 1 })
    assert.equal(first.catalogRebuilt, true)
    assert.equal(first.indexRebuilt, true)
    // The empty volume directory must survive a clone.
    assert.equal(existsSync(join(root, 'chapters', 'vol-01-入山卷', '.gitkeep')), true)

    const catalog = readCatalog(root)
    assert.equal(catalog.catalogStale, false, 'the write path rebuilds the projection')
    assert.deepEqual(catalog.catalog.volumes, [
      { volumeId: 'vol-01', dir: 'vol-01-入山卷', title: '入山卷', order: 1 },
    ])
    assert.deepEqual(readJson(join(root, ROOT_CATALOG)).volumes, catalog.catalog.volumes)

    // The next automatic id is max + 1; an explicit id keeps its own number.
    const second = await call(harness, 'inkflow_volume_create', { title: '出海' })
    assert.equal(second.volume.volumeId, 'vol-02')
    const explicit = await call(harness, 'inkflow_volume_create', { volumeId: 'vol-07', title: '外海' })
    assert.equal(explicit.volume.volumeId, 'vol-07')
    assert.equal(explicit.volume.dir, 'vol-07-外海')
    assert.equal(explicit.volume.order, 7)
    const next = await call(harness, 'inkflow_volume_create', { title: '末卷' })
    assert.equal(next.volume.volumeId, 'vol-08')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('volume: create refuses a duplicate id, a malformed id, an empty title and an unsafe slug', async () => {
  const dir = workdir()
  try {
    const root = scaffold(dir)
    const harness = makeHarness(root)
    await call(harness, 'inkflow_volume_create', { title: '入山' })
    const before = chapterSnapshot(root)

    const duplicate = await call(harness, 'inkflow_volume_create', { volumeId: 'vol-01', title: '再来一卷' })
    assert.equal(duplicate.ok, false)
    assert.equal(duplicate.error.code, 'VOLUME_EXISTS')

    const malformed = await call(harness, 'inkflow_volume_create', { volumeId: 'vol-1', title: '一位数' })
    assert.equal(malformed.error.code, 'VOLUME_ID_INVALID')

    const noTitle = await call(harness, 'inkflow_volume_create', { title: '  ' })
    assert.equal(noTitle.error.code, 'TITLE_REQUIRED')

    for (const slug of ['a/b', '..', '..\\evil', 'bad:name', '', '   ']) {
      const unsafe = await call(harness, 'inkflow_volume_create', { title: '安全', slug })
      assert.equal(unsafe.ok, false, `slug ${JSON.stringify(slug)} must be refused`)
      assert.equal(unsafe.error.code, 'SLUG_INVALID')
    }

    assert.deepEqual(chapterSnapshot(root), before, 'a refused create writes nothing')
    assert.equal(existsSync(join(dir, 'evil')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. inkflow_chapter_create
// ---------------------------------------------------------------------------

test('chapter: create assigns a uuid, the next seq and a NNNN-slug.md file in the volume', async () => {
  const dir = workdir()
  try {
    const root = scaffold(dir)
    const harness = makeHarness(root)
    const volume = (await call(harness, 'inkflow_volume_create', { title: '入山' })).volume

    const first = await call(harness, 'inkflow_chapter_create', { volumeId: volume.volumeId, title: '第一章 入山' })
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.match(first.chapter.chapterId, UUID_V4)
    assert.equal(first.chapter.seq, 1)
    assert.equal(first.chapter.volumeId, 'vol-01')
    assert.equal(first.chapter.file, 'chapters/vol-01-入山/0001-第一章-入山.md')
    assert.equal(first.chapter.status, 'draft')

    const text = read(join(root, ...first.chapter.file.split('/')))
    const parsed = parseMarkdown(text)
    assert.equal(parsed.data.id, first.chapter.chapterId)
    assert.equal(parsed.data.title, '第一章 入山')
    assert.equal(parsed.data.volume, 'vol-01')
    assert.equal(String(parsed.data.seq), '1')
    assert.equal(parsed.data.status, 'draft')
    assert.equal(parsed.body.trim(), '', 'a new chapter is an empty placeholder')

    // seq continues per volume, and a second volume numbers independently.
    const second = await call(harness, 'inkflow_chapter_create', { volumeId: 'vol-01', title: '第二章' })
    assert.equal(second.chapter.seq, 2)
    assert.equal(second.chapter.file, 'chapters/vol-01-入山/0002-第二章.md')
    const otherVolume = (await call(harness, 'inkflow_volume_create', { title: '出海' })).volume
    const other = await call(harness, 'inkflow_chapter_create', { volumeId: otherVolume.volumeId, title: '启航' })
    assert.equal(other.chapter.seq, 1, 'each volume numbers its own chapters')
    assert.equal(other.chapter.file, 'chapters/vol-02-出海/0001-启航.md')

    // A chapter with no volume is loose and lives directly under chapters/.
    const loose = await call(harness, 'inkflow_chapter_create', { title: '序章' })
    assert.equal(loose.chapter.volumeId, null)
    assert.equal(loose.chapter.seq, 1, 'loose chapters have their own sequence')
    assert.equal(loose.chapter.file, 'chapters/0001-序章.md')

    // An explicit seq is honoured, and the automatic one starts after it.
    const explicit = await call(harness, 'inkflow_chapter_create', { volumeId: 'vol-01', title: '番外', seq: 10 })
    assert.equal(explicit.chapter.seq, 10)
    const afterExplicit = await call(harness, 'inkflow_chapter_create', { volumeId: 'vol-01', title: '后记' })
    assert.equal(afterExplicit.chapter.seq, 11)

    const catalog = readCatalog(root)
    assert.equal(catalog.catalogStale, false)
    assert.deepEqual(
      catalog.volumeCatalogs.find((item) => item.volumeId === 'vol-01').chapters.map((item) => item.seq),
      [1, 2, 10, 11],
    )
    assert.deepEqual(catalog.catalog.looseChapters.map((item) => item.file), ['chapters/0001-序章.md'])
    assert.equal(indexChapterCount(root), 6, 'the derived index follows the files')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('chapter: create gives every chapter a distinct uuid (ten chapters, two volumes)', async () => {
  const dir = workdir()
  try {
    const root = scaffold(dir)
    const harness = makeHarness(root)
    const v1 = (await call(harness, 'inkflow_volume_create', { title: '上卷' })).volume.volumeId
    const v2 = (await call(harness, 'inkflow_volume_create', { title: '下卷' })).volume.volumeId

    const ids = new Set()
    const files = new Set()
    for (let index = 0; index < 10; index += 1) {
      const result = await call(harness, 'inkflow_chapter_create', {
        volumeId: index < 5 ? v1 : v2,
        title: `第${index + 1}章`,
      })
      assert.equal(result.ok, true, JSON.stringify(result))
      ids.add(result.chapter.chapterId)
      files.add(result.chapter.file)
    }
    assert.equal(ids.size, 10, 'ids are unique')
    assert.equal(files.size, 10, 'file names are unique')
    for (const id of ids) assert.match(id, UUID_V4)
    assert.equal(chapterFiles(root).length, 10)
    assert.equal(indexChapterCount(root), 10)

    // Every id is addressable one by one — the id, not the path, is the handle.
    for (const file of files) {
      const written = await call(harness, 'inkflow_chapter_write', {
        file,
        body: `正文 ${file}`,
      })
      assert.equal(written.ok, true, JSON.stringify(written))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('chapter: create refuses a seq collision, a missing volume, a bad slug and a bad seq', async () => {
  const dir = workdir()
  try {
    const root = scaffold(dir)
    const harness = makeHarness(root)
    await call(harness, 'inkflow_volume_create', { title: '入山' })
    await call(harness, 'inkflow_chapter_create', { volumeId: 'vol-01', title: '第一章' })
    const before = chapterSnapshot(root)

    const collision = await call(harness, 'inkflow_chapter_create', { volumeId: 'vol-01', title: '撞号', seq: 1 })
    assert.equal(collision.ok, false)
    assert.equal(collision.error.code, 'SEQ_CONFLICT')
    assert.match(collision.error.message, /0001/)

    const missingVolume = await call(harness, 'inkflow_chapter_create', { volumeId: 'vol-09', title: '无卷' })
    assert.equal(missingVolume.error.code, 'VOLUME_NOT_FOUND')

    const badVolumeId = await call(harness, 'inkflow_chapter_create', { volumeId: 'chapter-1', title: '坏卷' })
    assert.equal(badVolumeId.error.code, 'VOLUME_ID_INVALID')

    const badSeq = await call(harness, 'inkflow_chapter_create', { title: '坏号', seq: 0 })
    assert.equal(badSeq.error.code, 'SEQ_INVALID')
    const fractional = await call(harness, 'inkflow_chapter_create', { title: '半号', seq: 1.5 })
    assert.equal(fractional.error.code, 'SEQ_INVALID')

    const unsafe = await call(harness, 'inkflow_chapter_create', { title: '逃逸', slug: '../evil' })
    assert.equal(unsafe.error.code, 'SLUG_INVALID')
    assert.equal(existsSync(join(dir, 'evil.md')), false)

    assert.deepEqual(chapterSnapshot(root), before, 'a refused create writes nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. inkflow_chapter_write
// ---------------------------------------------------------------------------

test('chapter: write changes only the requested fields and keeps the frontmatter bytes', async () => {
  const dir = workdir()
  try {
    const root = scaffold(dir)
    const harness = makeHarness(root)
    await call(harness, 'inkflow_volume_create', { title: '入山' })
    const created = (await call(harness, 'inkflow_chapter_create', { volumeId: 'vol-01', title: '第一章' })).chapter

    // Give the file a hand-written field and an inline comment: a rewrite that
    // re-serialises the block would drop both.
    const absolute = join(root, ...created.file.split('/'))
    const hand = read(absolute).replace('status: draft', 'pov: 主角\nstatus: draft   # 作者标注')
    writeFileSync(absolute, hand, 'utf8')
    const before = splitDoc(hand)

    const written = await call(harness, 'inkflow_chapter_write', {
      chapterId: created.chapterId,
      body: '他走进白鹤门。\n',
    })
    assert.equal(written.ok, true, JSON.stringify(written))
    assert.deepEqual(written.changed, ['body'])
    assert.equal(written.chapter.file, created.file, 'a body-only write does not move the file')

    const after = read(absolute)
    assert.equal(splitDoc(after).head, before.head, 'frontmatter bytes are untouched')
    assert.equal(splitDoc(after).body, '他走进白鹤门。\n')
    const parsed = parseMarkdown(after)
    assert.equal(parsed.data.pov, '主角', 'an unknown field survives')
    assert.equal(parsed.data.status, 'draft')

    // status only
    const status = await call(harness, 'inkflow_chapter_write', { chapterId: created.chapterId, status: 'revised' })
    assert.deepEqual(status.changed, ['status'])
    assert.equal(parseMarkdown(read(absolute)).data.status, 'revised')

    // title only: frontmatter + file name move together, the id does not change
    const renamed = await call(harness, 'inkflow_chapter_write', { chapterId: created.chapterId, title: '第一章 入山' })
    assert.equal(renamed.ok, true, JSON.stringify(renamed))
    assert.deepEqual(renamed.changed, ['title'])
    assert.equal(renamed.chapter.chapterId, created.chapterId, 'the id is stable across a rename')
    assert.equal(renamed.renamedFrom, created.file)
    assert.equal(renamed.chapter.file, 'chapters/vol-01-入山/0001-第一章-入山.md')
    assert.equal(existsSync(absolute), false, 'the old file is gone')
    const moved = parseMarkdown(read(join(root, ...renamed.chapter.file.split('/'))))
    assert.equal(moved.data.title, '第一章 入山')
    assert.equal(moved.data.id, created.chapterId)
    assert.equal(moved.data.volume, 'vol-01')
    assert.equal(String(moved.data.seq), '1')
    assert.equal(moved.data.pov, '主角')

    // The catalog followed the rename, and the id still resolves.
    const catalog = readCatalog(root)
    assert.equal(catalog.catalogStale, false)
    assert.deepEqual(
      catalog.volumeCatalogs[0].chapters.map((item) => [item.chapterId, item.file]),
      [[created.chapterId, renamed.chapter.file]],
    )
    const byId = await call(harness, 'inkflow_chapter_write', { chapterId: created.chapterId, body: '改回来。' })
    assert.equal(byId.ok, true)

    // A call that changes nothing is a no-op, not a rewrite.
    const same = await call(harness, 'inkflow_chapter_write', { chapterId: created.chapterId, title: '第一章 入山' })
    assert.equal(same.ok, true)
    assert.deepEqual(same.changed, [])
    assert.equal(same.catalogRebuilt, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('chapter: write refuses an unknown id, a path selector, a bad status and an unsafe file', async () => {
  const dir = workdir()
  try {
    const root = scaffold(dir)
    const harness = makeHarness(root)
    await call(harness, 'inkflow_volume_create', { title: '入山' })
    const created = (await call(harness, 'inkflow_chapter_create', { volumeId: 'vol-01', title: '第一章' })).chapter
    const absolute = join(root, ...created.file.split('/'))
    const before = read(absolute)

    const unknown = await call(harness, 'inkflow_chapter_write', { chapterId: 'not-a-chapter', body: 'x' })
    assert.equal(unknown.error.code, 'CHAPTER_NOT_FOUND')

    // A directory name is not an id (ADR-0006 D6: ids are uuid values).
    const dirName = await call(harness, 'inkflow_chapter_write', { chapterId: 'vol-01-入山', body: 'x' })
    assert.equal(dirName.error.code, 'CHAPTER_NOT_FOUND')

    const badStatus = await call(harness, 'inkflow_chapter_write', { chapterId: created.chapterId, status: 'published' })
    assert.equal(badStatus.error.code, 'STATUS_INVALID')
    assert.match(badStatus.error.message, /draft/)

    const noSelector = await call(harness, 'inkflow_chapter_write', { body: 'x' })
    assert.equal(noSelector.error.code, 'CHAPTER_SELECTOR_REQUIRED')
    const both = await call(harness, 'inkflow_chapter_write', { chapterId: created.chapterId, file: created.file, body: 'x' })
    assert.equal(both.error.code, 'CHAPTER_SELECTOR_CONFLICT')

    for (const file of ['../evil.md', 'chapters/../evil.md', 'inkflow.json', 'chapters/vol-01-入山']) {
      const unsafe = await call(harness, 'inkflow_chapter_write', { file, body: 'x' })
      assert.equal(unsafe.ok, false, `file ${file} must be refused`)
      assert.equal(unsafe.error.code, 'FILE_INVALID')
    }
    assert.equal(existsSync(join(dir, 'evil.md')), false)

    const emptyTitle = await call(harness, 'inkflow_chapter_write', { chapterId: created.chapterId, title: '  ' })
    assert.equal(emptyTitle.error.code, 'TITLE_REQUIRED')

    assert.equal(read(absolute), before, 'no refused write touches the file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. inkflow_chapter_move
// ---------------------------------------------------------------------------

test('chapter: move relocates the file, updates volume and keeps the id and seq', async () => {
  const dir = workdir()
  try {
    const root = scaffold(dir)
    const harness = makeHarness(root)
    await call(harness, 'inkflow_volume_create', { title: '入山' })
    await call(harness, 'inkflow_volume_create', { title: '出海' })
    const created = (await call(harness, 'inkflow_chapter_create', { volumeId: 'vol-01', title: '第一章' })).chapter
    await call(harness, 'inkflow_chapter_write', { chapterId: created.chapterId, body: '他走进白鹤门。' })

    const moved = await call(harness, 'inkflow_chapter_move', { chapterId: created.chapterId, volumeId: 'vol-02' })
    assert.equal(moved.ok, true, JSON.stringify(moved))
    assert.equal(moved.moved, true)
    assert.equal(moved.movedFrom, created.file)
    assert.equal(moved.chapter.file, 'chapters/vol-02-出海/0001-第一章.md')
    assert.equal(moved.chapter.chapterId, created.chapterId)
    assert.equal(moved.chapter.volumeId, 'vol-02')
    assert.equal(moved.chapter.seq, 1)
    assert.equal(existsSync(join(root, ...created.file.split('/'))), false, 'the old path is gone')

    const parsed = parseMarkdown(read(join(root, ...moved.chapter.file.split('/'))))
    assert.equal(parsed.data.volume, 'vol-02')
    assert.equal(parsed.data.id, created.chapterId)
    assert.equal(parsed.body, '他走进白鹤门。', 'the body travels with the chapter')

    const catalog = readCatalog(root)
    assert.equal(catalog.catalogStale, false)
    assert.deepEqual(catalog.volumeCatalogs.find((item) => item.volumeId === 'vol-01').chapters, [])
    assert.deepEqual(
      catalog.volumeCatalogs.find((item) => item.volumeId === 'vol-02').chapters.map((item) => item.file),
      [moved.chapter.file],
    )

    // Moving out of every volume drops the `volume` field, so ownership falls
    // back to the directory rule (loose) instead of a dangling id.
    const loose = await call(harness, 'inkflow_chapter_move', { chapterId: created.chapterId, volumeId: null })
    assert.equal(loose.ok, true, JSON.stringify(loose))
    assert.equal(loose.chapter.volumeId, null)
    assert.equal(loose.chapter.file, 'chapters/0001-第一章.md')
    const looseParsed = parseMarkdown(read(join(root, ...loose.chapter.file.split('/'))))
    assert.equal(Object.hasOwn(looseParsed.data, 'volume'), false, 'the volume line is removed, not emptied')
    assert.deepEqual(readCatalog(root).catalog.looseChapters.map((item) => item.file), [loose.chapter.file])

    // Moving back in re-adds it.
    const back = await call(harness, 'inkflow_chapter_move', { chapterId: created.chapterId, volumeId: 'vol-01' })
    assert.equal(back.ok, true, JSON.stringify(back))
    assert.equal(back.chapter.file, 'chapters/vol-01-入山/0001-第一章.md')
    assert.equal(parseMarkdown(read(join(root, ...back.chapter.file.split('/')))).data.volume, 'vol-01')

    // Same volume: a no-op, not a rewrite.
    const same = await call(harness, 'inkflow_chapter_move', { chapterId: created.chapterId, volumeId: 'vol-01' })
    assert.equal(same.ok, true)
    assert.equal(same.moved, false)
    assert.deepEqual(same.changed, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('chapter: move refuses a seq collision in the target volume and a missing volume', async () => {
  const dir = workdir()
  try {
    const root = scaffold(dir)
    const harness = makeHarness(root)
    await call(harness, 'inkflow_volume_create', { title: '上卷' })
    await call(harness, 'inkflow_volume_create', { title: '下卷' })
    const source = (await call(harness, 'inkflow_chapter_create', { volumeId: 'vol-01', title: '第一章' })).chapter
    const blocker = (await call(harness, 'inkflow_chapter_create', { volumeId: 'vol-02', title: '撞号' })).chapter
    assert.equal(blocker.seq, 1)
    const before = chapterSnapshot(root)

    const conflict = await call(harness, 'inkflow_chapter_move', { chapterId: source.chapterId, volumeId: 'vol-02' })
    assert.equal(conflict.ok, false)
    assert.equal(conflict.error.code, 'SEQ_CONFLICT')
    assert.match(conflict.error.message, /0001-撞号/)
    assert.deepEqual(chapterSnapshot(root), before, 'a refused move writes nothing')

    const missing = await call(harness, 'inkflow_chapter_move', { chapterId: source.chapterId, volumeId: 'vol-42' })
    assert.equal(missing.error.code, 'VOLUME_NOT_FOUND')

    const unknown = await call(harness, 'inkflow_chapter_move', { chapterId: 'nope', volumeId: 'vol-02' })
    assert.equal(unknown.error.code, 'CHAPTER_NOT_FOUND')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. inkflow_chapter_delete
// ---------------------------------------------------------------------------

test('chapter: delete removes the file and both projections agree afterwards', async () => {
  const dir = workdir()
  try {
    const root = scaffold(dir)
    const harness = makeHarness(root)
    await call(harness, 'inkflow_volume_create', { title: '入山' })
    const keep = (await call(harness, 'inkflow_chapter_create', { volumeId: 'vol-01', title: '留下' })).chapter
    const drop = (await call(harness, 'inkflow_chapter_create', { volumeId: 'vol-01', title: '删掉' })).chapter
    assert.equal(indexChapterCount(root), 2)

    const deleted = await call(harness, 'inkflow_chapter_delete', { chapterId: drop.chapterId })
    assert.equal(deleted.ok, true, JSON.stringify(deleted))
    assert.equal(deleted.deleted.file, drop.file)
    assert.equal(deleted.deleted.chapterId, drop.chapterId)
    assert.equal(deleted.deleted.title, '删掉')
    assert.equal(existsSync(join(root, ...drop.file.split('/'))), false)
    assert.equal(existsSync(join(root, ...keep.file.split('/'))), true)

    const catalog = readCatalog(root)
    assert.equal(catalog.catalogStale, false)
    assert.deepEqual(catalog.volumeCatalogs[0].chapters.map((item) => item.chapterId), [keep.chapterId])
    assert.equal(indexChapterCount(root), 1, 'the derived index no longer lists the chapter')

    // Deleted means deleted: the id no longer resolves.
    const again = await call(harness, 'inkflow_chapter_delete', { chapterId: drop.chapterId })
    assert.equal(again.error.code, 'CHAPTER_NOT_FOUND')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. inkflow_volume_rename — the cascade
// ---------------------------------------------------------------------------

test('volume: rename moves the directory and both catalogs but not one chapter byte', async () => {
  const dir = workdir()
  try {
    const root = scaffold(dir)
    const harness = makeHarness(root)
    await call(harness, 'inkflow_volume_create', { title: '入山' })
    const first = (await call(harness, 'inkflow_chapter_create', { volumeId: 'vol-01', title: '第一章' })).chapter
    const second = (await call(harness, 'inkflow_chapter_create', { volumeId: 'vol-01', title: '第二章' })).chapter
    const beforeHashes = new Map(
      [first, second].map((item) => [item.chapterId, createHash('sha256').update(readFileSync(join(root, ...item.file.split('/')))).digest('hex')]),
    )

    const renamed = await call(harness, 'inkflow_volume_rename', { volumeId: 'vol-01', title: '入山卷' })
    assert.equal(renamed.ok, true, JSON.stringify(renamed))
    assert.equal(renamed.previous.dir, 'vol-01-入山')
    assert.deepEqual(renamed.volume, { volumeId: 'vol-01', dir: 'vol-01-入山卷', title: '入山卷', order: 1 })
    assert.equal(renamed.chaptersUnchanged, 2)
    assert.equal(existsSync(join(root, 'chapters', 'vol-01-入山')), false)
    assert.equal(existsSync(join(root, 'chapters', 'vol-01-入山卷', '.gitkeep')), true)

    // Both catalogs follow: the volume list and the per-volume chapter paths.
    const catalog = readCatalog(root)
    assert.equal(catalog.catalogStale, false)
    assert.deepEqual(catalog.catalog.volumes, [
      { volumeId: 'vol-01', dir: 'vol-01-入山卷', title: '入山卷', order: 1 },
    ])
    assert.deepEqual(
      catalog.volumeCatalogs[0].chapters.map((item) => item.file),
      ['chapters/vol-01-入山卷/0001-第一章.md', 'chapters/vol-01-入山卷/0002-第二章.md'],
    )
    assert.equal(existsSync(join(root, 'chapters', 'vol-01-入山卷', 'index.json')), true)

    // The chapter frontmatter is untouched: same volume value, same id, same bytes.
    for (const item of [first, second]) {
      const file = item.file.replace('vol-01-入山/', 'vol-01-入山卷/')
      const text = read(join(root, ...file.split('/')))
      assert.equal(createHash('sha256').update(text).digest('hex'), beforeHashes.get(item.chapterId))
      assert.equal(parseMarkdown(text).data.volume, 'vol-01')
    }

    // The ids still resolve after the rename (the reason ids exist).
    const byId = await call(harness, 'inkflow_chapter_write', { chapterId: first.chapterId, body: '改名后仍可写。' })
    assert.equal(byId.ok, true, JSON.stringify(byId))
    assert.equal(byId.chapter.file, 'chapters/vol-01-入山卷/0001-第一章.md')

    // A slug-only rename and a title+slug rename behave the same way.
    const slugOnly = await call(harness, 'inkflow_volume_rename', { volumeId: 'vol-01', slug: 'kai-pian' })
    assert.equal(slugOnly.volume.dir, 'vol-01-kai-pian')
    const both = await call(harness, 'inkflow_volume_rename', { volumeId: 'vol-01', title: '开篇', slug: 'kai-pian-2' })
    assert.equal(both.volume.dir, 'vol-01-kai-pian-2')
    assert.equal(readCatalog(root).catalogStale, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('volume: rename refuses an unknown volume, a taken directory and an unsafe slug', async () => {
  const dir = workdir()
  try {
    const root = scaffold(dir)
    const harness = makeHarness(root)
    // ASCII slugs keep the catalog's directory ordering (and therefore which
    // `vol-01-*` directory is "the" volume) independent of the locale.
    await call(harness, 'inkflow_volume_create', { title: 'ru' })
    await call(harness, 'inkflow_volume_create', { title: 'chu' })
    // A leftover directory that already occupies the rename target.
    mkdirSync(join(root, 'chapters', 'vol-01-zz'))
    const before = chapterSnapshot(root)

    const unknown = await call(harness, 'inkflow_volume_rename', { volumeId: 'vol-09', title: '无卷' })
    assert.equal(unknown.error.code, 'VOLUME_NOT_FOUND')
    const badId = await call(harness, 'inkflow_volume_rename', { volumeId: 'vol-9', title: '坏卷' })
    assert.equal(badId.error.code, 'VOLUME_ID_INVALID')

    const taken = await call(harness, 'inkflow_volume_rename', { volumeId: 'vol-01', slug: 'zz' })
    assert.equal(taken.ok, false)
    assert.equal(taken.error.code, 'VOLUME_EXISTS')
    assert.match(taken.error.message, /vol-01-zz/)

    const unsafe = await call(harness, 'inkflow_volume_rename', { volumeId: 'vol-01', slug: '../evil' })
    assert.equal(unsafe.error.code, 'SLUG_INVALID')

    const noTitle = await call(harness, 'inkflow_volume_rename', { volumeId: 'vol-01', title: '   ' })
    assert.equal(noTitle.error.code, 'TITLE_REQUIRED')

    assert.deepEqual(chapterSnapshot(root), before, 'a refused rename writes nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7. Failures: rollback, the write lock, the gate
// ---------------------------------------------------------------------------

test('failure: a volume rename whose catalog cannot be written rolls the directory back', async () => {
  const dir = workdir()
  try {
    const root = scaffold(dir)
    const harness = makeHarness(root)
    await call(harness, 'inkflow_volume_create', { title: '入山' })
    const chapter = (await call(harness, 'inkflow_chapter_create', { volumeId: 'vol-01', title: '第一章' })).chapter
    // The top-level catalog is written last: the directory rename has already
    // happened when this fails, so only a rollback keeps the tree whole.
    breakRootCatalog(root)
    const before = chapterSnapshot(root)
    const beforeCatalogs = catalogHashes(root)

    const failed = await call(harness, 'inkflow_volume_rename', { volumeId: 'vol-01', title: '入山卷' })
    assert.equal(failed.ok, false, JSON.stringify(failed))
    assert.equal(failed.error.code, 'CATALOG_REBUILD_FAILED')
    assert.equal(failed.error.rolledBack, true)
    assert.ok(Array.isArray(failed.error.rollback) && failed.error.rollback.length > 0)

    assert.deepEqual(chapterSnapshot(root), before, 'no half-renamed volume, no rewritten chapter')
    assert.deepEqual(catalogHashes(root), beforeCatalogs, 'the projection is byte-identical again')
    assert.equal(existsSync(join(root, 'chapters', 'vol-01-入山')), true)
    assert.equal(existsSync(join(root, 'chapters', 'vol-01-入山卷')), false)
    assert.equal(existsSync(join(root, ...chapter.file.split('/'))), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('failure: a chapter move whose catalog cannot be written restores the original file', async () => {
  const dir = workdir()
  try {
    const root = scaffold(dir)
    const harness = makeHarness(root)
    await call(harness, 'inkflow_volume_create', { title: '入山' })
    await call(harness, 'inkflow_volume_create', { title: '出海' })
    const chapter = (await call(harness, 'inkflow_chapter_create', { volumeId: 'vol-01', title: '第一章' })).chapter
    await call(harness, 'inkflow_chapter_write', { chapterId: chapter.chapterId, body: '正文不可丢。' })
    const original = read(join(root, ...chapter.file.split('/')))
    breakRootCatalog(root)
    const before = chapterSnapshot(root)
    const beforeCatalogs = catalogHashes(root)

    const failed = await call(harness, 'inkflow_chapter_move', { chapterId: chapter.chapterId, volumeId: 'vol-02' })
    assert.equal(failed.ok, false, JSON.stringify(failed))
    assert.equal(failed.error.code, 'CATALOG_REBUILD_FAILED')
    assert.equal(failed.error.rolledBack, true)

    assert.deepEqual(chapterSnapshot(root), before)
    assert.deepEqual(catalogHashes(root), beforeCatalogs, 'the volume list is restored too')
    assert.equal(read(join(root, ...chapter.file.split('/'))), original, 'the original bytes are back')
    assert.equal(existsSync(join(root, 'chapters', 'vol-02-出海', '0001-第一章.md')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('failure: a chapter create or write whose catalog cannot be written leaves no half-work', async () => {
  const dir = workdir()
  try {
    const root = scaffold(dir)
    const harness = makeHarness(root)
    await call(harness, 'inkflow_volume_create', { title: '入山' })
    const chapter = (await call(harness, 'inkflow_chapter_create', { volumeId: 'vol-01', title: '第一章' })).chapter
    const original = read(join(root, ...chapter.file.split('/')))
    breakRootCatalog(root)
    const before = chapterSnapshot(root)
    const beforeCatalogs = catalogHashes(root)

    const created = await call(harness, 'inkflow_chapter_create', { volumeId: 'vol-01', title: '第二章' })
    assert.equal(created.error.code, 'CATALOG_REBUILD_FAILED')
    assert.equal(created.error.rolledBack, true)
    assert.equal(existsSync(join(root, 'chapters', 'vol-01-入山', '0002-第二章.md')), false)

    const written = await call(harness, 'inkflow_chapter_write', { chapterId: chapter.chapterId, body: '不该落盘。' })
    assert.equal(written.error.code, 'CATALOG_REBUILD_FAILED')
    assert.equal(written.error.rolledBack, true)
    assert.equal(read(join(root, ...chapter.file.split('/'))), original)

    assert.deepEqual(chapterSnapshot(root), before)
    assert.deepEqual(catalogHashes(root), beforeCatalogs, 'the chapter list is restored too')
    const leftovers = readdirSync(join(root, 'chapters', 'vol-01-入山')).filter((name) => name.includes('.tmp-'))
    assert.deepEqual(leftovers, [], 'no temp file survives a rolled-back write')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('failure: a volume create whose catalog cannot be written leaves no phantom volume', async () => {
  const dir = workdir()
  try {
    const root = scaffold(dir)
    const harness = makeHarness(root)
    await call(harness, 'inkflow_volume_create', { title: '入山' })
    breakRootCatalog(root)
    const before = chapterSnapshot(root)
    const beforeCatalogs = catalogHashes(root)

    const failed = await call(harness, 'inkflow_volume_create', { title: '出海' })
    assert.equal(failed.ok, false, JSON.stringify(failed))
    assert.equal(failed.error.code, 'CATALOG_REBUILD_FAILED')
    assert.equal(failed.error.rolledBack, true)
    // The failed rebuild writes this volume's own list before failing on the
    // top-level one, so the directory is not empty — removing it as if it were
    // would leave a phantom volume behind.
    assert.equal(existsSync(join(root, 'chapters', 'vol-02-出海')), false)
    assert.equal(existsSync(join(root, 'chapters', 'vol-02-出海', '.gitkeep')), false)
    assert.deepEqual(chapterSnapshot(root), before)
    assert.deepEqual(catalogHashes(root), beforeCatalogs)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('failure: every chapter tool refuses while another session holds the write lock', async () => {
  const dir = workdir()
  try {
    const root = scaffold(dir)
    const harness = makeHarness(root)
    const volume = (await call(harness, 'inkflow_volume_create', { title: '入山' })).volume
    const chapter = (await call(harness, 'inkflow_chapter_create', { volumeId: volume.volumeId, title: '第一章' })).chapter
    // A live pid (the test runner's parent) makes the lock non-stale.
    writeFileSync(
      join(root, 'index', '.write.lock'),
      JSON.stringify({ pid: process.ppid, token: 'other-session', startedAt: Date.now() }),
      'utf8',
    )
    const before = chapterSnapshot(root)

    const calls = [
      ['inkflow_volume_create', { title: '新卷' }],
      ['inkflow_volume_rename', { volumeId: volume.volumeId, title: '改名' }],
      ['inkflow_chapter_create', { title: '新章' }],
      ['inkflow_chapter_write', { chapterId: chapter.chapterId, body: 'x' }],
      ['inkflow_chapter_move', { chapterId: chapter.chapterId, volumeId: null }],
      ['inkflow_chapter_delete', { chapterId: chapter.chapterId }],
    ]
    for (const [name, args] of calls) {
      const refused = await call(harness, name, args)
      assert.equal(refused.ok, false, `${name} must refuse while the lock is held`)
      assert.equal(refused.error.code, 'PROJECT_BUSY', name)
    }
    // The lock is taken *before* the projection is read, so even an argument
    // error is reported as BUSY: proving that no read happens outside the lock
    // (otherwise two sessions could allocate the same seq from one snapshot).
    const busyBeatsValidation = await call(harness, 'inkflow_chapter_create', { title: '' })
    assert.equal(busyBeatsValidation.error.code, 'PROJECT_BUSY')
    assert.deepEqual(chapterSnapshot(root), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('failure: a non-usable project is refused with the gate checklist and zero writes', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'empty')
    mkdirSync(root, { recursive: true })
    const harness = makeHarness(root)
    for (const name of [
      'inkflow_volume_create',
      'inkflow_volume_rename',
      'inkflow_chapter_create',
      'inkflow_chapter_write',
      'inkflow_chapter_move',
      'inkflow_chapter_delete',
    ]) {
      const refused = await call(harness, name, { title: 'x', volumeId: 'vol-01', chapterId: 'x' })
      assert.equal(refused.ok, false, name)
      assert.equal(refused.error.code, 'NOT_AN_INKFLOW_PROJECT', name)
      assert.ok(Array.isArray(refused.error.actions), name)
    }
    assert.deepEqual(readdirSync(root), [], 'the gate refusal writes nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('chapter: a hand-written chapter without frontmatter is still addressable and editable', async () => {
  const dir = workdir()
  try {
    const root = scaffold(dir)
    // The author dropped a plain .md into a volume directory: no block, no id.
    mkdirSync(join(root, 'chapters', 'vol-01-入山'), { recursive: true })
    writeFileSync(join(root, 'chapters', 'vol-01-入山', '0001-手写.md'), '他走进白鹤门。\n', 'utf8')
    const harness = makeHarness(root)
    const file = 'chapters/vol-01-入山/0001-手写.md'

    // Without a block the id is the path, and a body write keeps it that way.
    const written = await call(harness, 'inkflow_chapter_write', { file, body: '改过的正文。' })
    assert.equal(written.ok, true, JSON.stringify(written))
    assert.equal(written.chapter.chapterId, file)
    assert.equal(read(join(root, ...file.split('/'))), '改过的正文。')

    // A title write has to create a block — otherwise the call would silently do
    // nothing — and the numeric prefix is kept by the rename.
    const titled = await call(harness, 'inkflow_chapter_write', { file, title: '第一章' })
    assert.equal(titled.ok, true, JSON.stringify(titled))
    assert.equal(titled.chapter.file, 'chapters/vol-01-入山/0001-第一章.md')
    const parsed = parseMarkdown(read(join(root, 'chapters', 'vol-01-入山', '0001-第一章.md')))
    assert.equal(parsed.data.title, '第一章')
    // The created block ends with the usual blank separator line, exactly like a
    // chapter made by inkflow_chapter_create, so the prose starts after it.
    assert.equal(parsed.body.trim(), '改过的正文。')

    // Moving it out of the volume writes no `volume` line at all (there is none),
    // but the file still moves and the catalog follows.
    const moved = await call(harness, 'inkflow_chapter_move', { file: titled.chapter.file, volumeId: null })
    assert.equal(moved.ok, true, JSON.stringify(moved))
    assert.equal(moved.chapter.file, 'chapters/0001-第一章.md')
    assert.deepEqual(readCatalog(root).catalog.looseChapters.map((item) => item.file), ['chapters/0001-第一章.md'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('safety: a title with a comment marker or a trailing dot is quoted or refused, never corrupts', async () => {
  const dir = workdir()
  try {
    const root = scaffold(dir)
    const harness = makeHarness(root)

    // `#` inside a title must stay part of the value when the file is read back.
    const hashed = await call(harness, 'inkflow_chapter_create', { title: '第一章 # 入山' })
    assert.equal(hashed.ok, true, JSON.stringify(hashed))
    const parsed = parseMarkdown(read(join(root, ...hashed.chapter.file.split('/'))))
    assert.equal(parsed.data.title, '第一章 # 入山')

    // A dot at the end of a Windows path segment is silently dropped by the OS,
    // so the writer must refuse it instead of creating a file with another name.
    const dotted = await call(harness, 'inkflow_chapter_create', { title: '末章.', slug: 'mo-zhang.' })
    assert.equal(dotted.ok, false)
    assert.equal(dotted.error.code, 'SLUG_INVALID')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
