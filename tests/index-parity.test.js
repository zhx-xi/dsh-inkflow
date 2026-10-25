/**
 * The derived index against the disk (ADR-0005: files are the truth,
 * the index is a cache).
 *
 * "The rebuild succeeded" says nothing about whether it saw everything. These
 * tests ask the two questions a cache has to answer:
 *
 *   1. Does the index contain exactly what is on disk — every file, every table,
 *      and every invariant issue — after a 200-file random book (Chinese names,
 *      nested volumes, empty bodies, duplicate character names, unknown
 *      frontmatter fields)?
 *   2. Does it still agree after 3 edits, 2 deletions and 1 rename, and is the
 *      rebuild idempotent (two runs → identical counts and issues)?
 *
 * The random book is generated from a fixed seed, so a failure is reproducible.
 * Parsing rules are mirrored here only where the test needs an expectation
 * (non-blank character count, the index walk); the assertions are on the
 * index's own rows, not on a second copy of the indexer.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { INDEX_SCHEMA_VERSION, apply } from '../lib/index.js'

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const INDEX_DIR = 'index'
const ALL_DIRS = [...CONTENT_DIRS, INDEX_DIR]
const KEEP = '.gitkeep'

/** Deterministic PRNG (mulberry32): the 200-file book is the same on every run. */
function seeded(seed) {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const TITLES = [
  '入山', '夜行', '断剑', '旧信', '青石台阶', '白鹤归巢', '风雪夜', '孤灯', '剑冢', '山门',
  '云海', '古碑', '残卷', '归途', '问心', '长夜', '破晓', '彼岸', '落星', '空山',
]

/** Non-blank character count, the way conventions.md §3.2 defines a chapter's word count. */
function countChars(text) {
  return text.replace(/\s+/gu, '').length
}

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
  return mkdtempSync(join(tmpdir(), 'inkflow-parity-'))
}

function makeTools(dataDir, workspace) {
  const harness = createHarness(workspace)
  apply(harness.ctx, { dataDir })
  return harness
}

async function callTool(harness, toolName, args) {
  const tool = harness.tools.get(toolName)
  assert.ok(tool, `tool ${toolName} must be registered`)
  return tool.execute(args, { signal: AbortSignal.timeout(30000), agent: { id: 'test-session' } })
}

/** Write one markdown file; `lines` is the frontmatter body between the `---` pair. */
function markdown(root, relativePath, lines, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, `---\n${lines.join('\n')}\n---\n\n${body}`, 'utf8')
}

/** The project skeleton the generator writes into: usable from the first read. */
function skeleton(root) {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of ALL_DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, KEEP), '', 'utf8')
  }
  writeFileSync(join(root, '.gitignore'), '# InkFlow derived index\nindex/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '对拍之书' }, null, 2)}\n`, 'utf8')
}

/**
 * Every file the index walk is supposed to see, from the filesystem alone.
 *
 * Mirrors conventions.md §4 and indexer.ts: skip dotfiles/dot-directories, skip
 * `index/`, `node_modules/`, `.git/`, and never follow a link.
 */
function diskFiles(root) {
  const out = []
  const walk = (relative) => {
    const entries = readdirSync(relative === '' ? root : join(root, relative), { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === INDEX_DIR || entry.name === 'node_modules') continue
        walk(child)
        continue
      }
      if (entry.isFile()) out.push(child)
    }
  }
  walk('')
  return out.sort()
}

/** Run `fn` with a read-only handle on the derived database. */
function readDb(root, fn) {
  const db = new DatabaseSync(join(root, INDEX_DIR, 'inkflow.db'), { readOnly: true })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function all(db, sql, ...params) {
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => ({ ...row }))
}

function count(db, table) {
  return all(db, `SELECT COUNT(*) AS n FROM ${table}`)[0].n
}

function issueKey(issue) {
  return `${issue.code}|${issue.path ?? ''}|${issue.detail}`
}

function codePathKey(issue) {
  return `${issue.code}|${issue.path ?? ''}`
}

/**
 * The 200-file book: 20 outlines, 121 chapter files (120 markdown + 1 `.txt`),
 * 15 characters (three duplicate names after normalisation), 15 world entries
 * (one root, two dangling parents), 6 foreshadows, 6 timeline / 5 relations /
 * 5 facts files, 6 library files, plus `inkflow.json`.
 *
 * Seeded issues are listed in `expectedIssueKeys` — the parity test requires the
 * returned set to be *exactly* that, so a checker that over-fires fails too.
 */
function generateBook(root) {
  skeleton(root)
  const random = seeded(20261021)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const statuses = ['draft', 'revised', 'final']

  const spot = {}

  // ---- outlines: 1 overall + 2 volumes + 17 chapter nodes = 20 ----
  markdown(root, 'outlines/overall.md', ['id: ov', 'kind: overall', 'title: 全书总纲'], '- 情节点一\n- 情节点二')
  markdown(root, 'outlines/vol-01.md', ['id: v1', 'kind: volume', 'title: 卷一', 'parent: ov'], '- 卷一情节点')
  markdown(root, 'outlines/vol-02.md', ['id: v2', 'kind: volume', 'title: 卷二', 'parent: ov'], '- 卷二情节点')
  for (let index = 1; index <= 17; index += 1) {
    const parent = index % 3 === 0 ? 'v1' : 'ov'
    markdown(
      root,
      `outlines/ch-${String(index).padStart(4, '0')}.md`,
      [`id: oc-${String(index).padStart(2, '0')}`, 'kind: chapter', `title: 第${index}章细纲`, `parent: ${parent}`],
      `- 第${index}章情节点`,
    )
  }
  spot.outlineVolume = { path: 'outlines/vol-01.md', id: 'v1', kind: 'volume', title: '卷一', parent: 'ov' }

  // ---- chapters: 112 in four volumes + 8 at the top level = 120 markdown ----
  const volumeNames = ['vol-01', 'vol-02', 'vol-03', 'vol-04']
  const chapterRecords = []
  let chapterNumber = 0
  for (const volume of volumeNames) {
    for (let inVolume = 1; inVolume <= 28; inVolume += 1) {
      chapterNumber += 1
      const id = chapterNumber === 7 ? 'ch-0003' : `ch-${String(chapterNumber).padStart(4, '0')}`
      const title = `第${chapterNumber}章 ${TITLES[(chapterNumber - 1) % TITLES.length]}`
      const status = pick(statuses)
      const body = chapterNumber % 17 === 0 ? '' : `第${chapterNumber}章的正文。${TITLES[chapterNumber % TITLES.length]}在此处，风雪未停。`
      const lines = [`id: ${id}`, `title: ${title}`, `status: ${status}`, `mood: ${pick(['紧张', '平静', '悲凉'])}`]
      if (chapterNumber % 5 === 0) lines.push('note: 待改') // unknown ASCII key: parsed, then ignored
      if (chapterNumber % 7 === 0) lines.push('keywords: [白鹤, 门派]')
      if (chapterNumber === 10) lines.push('seq: 999') // explicit seq beats the filename
      if (chapterNumber === 35) lines.push('这一行不是键值对') // I-10 fixture
      if (chapterNumber === 61) lines.push('volume: vol-09') // explicit volume beats the directory
      const path = `chapters/${volume}/${String(inVolume).padStart(4, '0')}-${TITLES[inVolume % TITLES.length]}.md`
      markdown(root, path, lines, body)
      chapterRecords.push({ path, id, title, status, body, volume, inVolume })
    }
  }
  const topLevelRecords = []
  for (let index = 1; index <= 8; index += 1) {
    const id = `ch-${String(120 + index).padStart(4, '0')}`
    const body = `顶层第${index}章正文，无卷。`
    const path = `chapters/${String(index).padStart(4, '0')}-顶层${TITLES[index]}.md`
    markdown(root, path, [`id: ${id}`, `title: 顶层第${index}章`, 'status: final'], body)
    const record = { path, id, title: `顶层第${index}章`, status: 'final', body, volume: undefined, inVolume: index }
    chapterRecords.push(record)
    topLevelRecords.push(record)
  }
  writeFileSync(join(root, 'chapters', '笔记.txt'), '这一章写成了纯文本，扩展名不对。\n', 'utf8')

  const byNumber = (number) => chapterRecords[number - 1]
  spot.chapterVolume = {
    path: byNumber(3).path,
    id: 'ch-0003',
    seq: 3,
    title: byNumber(3).title,
    volume: 'vol-01',
    status: byNumber(3).status,
    wordCount: countChars(byNumber(3).body),
  }
  spot.chapterExplicitSeq = { path: byNumber(10).path, seq: 999 }
  spot.chapterExplicitVolume = { path: byNumber(61).path, volume: 'vol-09' }
  // 112 in-volume chapters come first, so the first top-level card comes after them.
  spot.chapterTopLevel = { path: topLevelRecords[0].path, volume: null, seq: 1 }
  spot.chapterEmptyBody = { path: byNumber(17).path, wordCount: 0 }

  // ---- characters: 15, three duplicate names once normalised ----
  const characterLines = [
    ['characters/a01-清音.md', ['id: char-01', 'name: 清音', 'group: 门派', 'role: 主角']],
    ['characters/a02-清音-空格.md', ['id: char-02', 'name: "清 音"', 'group: 门派']],
    ['characters/a03-Ling.md', ['id: char-03', 'name: Ling']],
    ['characters/a04-ling.md', ['id: char-04', 'name: ling']],
    ['characters/a05-白鹤.md', ['id: char-05', 'name: 白鹤']],
    ['characters/a06-白鹤-空格.md', ['id: char-06', 'name: "白 鹤"']],
    ['characters/a07-青城.md', ['id: char-07', 'name: 青城']],
    ['characters/b01-玄真.md', ['id: char-08', 'name: 玄真']],
    ['characters/b02-老掌门.md', ['id: char-09', 'name: 老掌门']],
    ['characters/b03-为真子.md', ['id: char-10', 'name: 为真子']],
    ['characters/b04-阿衡.md', ['id: char-11', 'name: 阿衡']],
    ['characters/b05-苏晚.md', ['id: char-12', 'name: 苏晚']],
    ['characters/b06-顾长安.md', ['id: char-13', 'name: 顾长安']],
    ['characters/b07-沈砚.md', ['id: char-14', 'name: 沈砚']],
    ['characters/b08-江月白.md', ['id: char-15', 'name: 江月白']],
  ]
  for (const [path, lines] of characterLines) markdown(root, path, lines, '角色卡正文。')
  spot.character = { path: 'characters/a01-清音.md', id: 'char-01', name: '清音', nameKey: '清音', group: '门派' }

  // ---- world: 1 root + 12 categorized + 2 dangling = 15 ----
  markdown(root, 'world/世界总览.md', ['id: w-root', 'title: 世界总览'], '根条目。')
  const categories = ['门派', '地理', '功法']
  let worldNumber = 0
  for (const category of categories) {
    for (let index = 1; index <= 4; index += 1) {
      worldNumber += 1
      const id = `w-${String(worldNumber).padStart(2, '0')}`
      const title = `${category}条目${index}`
      const lines = [`id: ${id}`, `title: ${title}`, 'parent: w-root']
      // Half the entries declare their category, the other half derive it from
      // the directory (conventions.md §3.4).
      if (index % 2 === 1) lines.push(`category: ${category}`)
      if (index === 3) lines.push('keywords: [白鹤, 鹤鸣剑]')
      markdown(root, `world/${category}/${title}.md`, lines, '条目正文。')
    }
  }
  markdown(root, 'world/门派/失落之门.md', ['id: w-13', 'title: 失落之门', 'parent: missing-parent'], '悬空父级。')
  markdown(root, 'world/地理/无名谷.md', ['id: w-14', 'title: 无名谷', 'parent: ghost'], '悬空父级。')
  spot.worldRoot = { path: 'world/世界总览.md', id: 'w-root', category: null, parent: null }
  spot.worldDerivedCategory = { path: 'world/门派/门派条目2.md', category: '门派', parent: 'w-root' }

  // ---- foreshadowing: 6, one resolved without a chapter ----
  markdown(root, 'foreshadowing/fs-01-断剑.md', ['id: fs-01', 'title: 断剑', 'resolved: false'], '尚未回收。')
  markdown(root, 'foreshadowing/fs-02-旧信.md', ['id: fs-02', 'title: 旧信', 'resolved: true'], '说回收了，却没说在哪一章。')
  for (let index = 3; index <= 6; index += 1) {
    markdown(
      root,
      `foreshadowing/fs-0${index}-伏笔${index}.md`,
      [`id: fs-0${index}`, `title: 伏笔${index}`, 'resolved: true', `resolvedChapter: ch-000${index}`],
      '已回收。',
    )
  }

  // ---- timeline / relations / facts: 6 + 5 + 5 ----
  for (let index = 1; index <= 6; index += 1) {
    // The timeline domain owns `timeline/`: a confirmed event needs a world time, so the fixture
    // writes a valid one (one event per chapter, so no ordering pair exists).
    markdown(
      root,
      `timeline/tl-0${index}.md`,
      [
        `id: tl-0${index}`,
        `title: 事件${index}`,
        `chapter: ${index}`,
        `worldTime: 17${String(10 + index)}-01-0${index}`,
        `narrativeOrder: ${index}`,
      ],
      '时间线事件。',
    )
  }
  // Relations carry the field names of data-model §3.3 (`source`/`target`/`kind`):
  // The relation domain owns `relations/`, so a legacy `from`/`to` file would be
  // reported as a broken edge instead of being ignored. Every pair is distinct — one
  // (source, target, kind) edge may exist once (RELATION_DUPLICATE).
  const relationPairs = [
    ['char-01', 'char-05'],
    ['char-02', 'char-06'],
    ['char-03', 'char-07'],
    ['char-04', 'char-08'],
    ['char-05', 'char-09'],
  ]
  for (const [offset, [source, target]] of relationPairs.entries()) {
    const index = offset + 1
    markdown(
      root,
      `relations/rl-0${index}.md`,
      [`id: rl-0${index}`, `title: 关系${index}`, `source: ${source}`, `target: ${target}`, 'kind: character', 'dir: directed'],
      '关系。',
    )
  }
  for (let index = 1; index <= 5; index += 1) {
    // `subject` is required by data-model §3.5 and now reported as a `FRONTMATTER_ISSUE`
    // warning when it is missing, so a fixture that wants *no* findings must write it.
    markdown(
      root,
      `facts/ft-0${index}.md`,
      [`subject: ft-0${index}`, 'entity: 清音', 'key: 年龄', `value: ${20 + index}`],
      '账本。',
    )
  }

  // ---- library: 6 files (4 markdown + 2 raw) ----
  for (let index = 1; index <= 4; index += 1) {
    markdown(root, `library/参考-${index}.md`, [`id: lib-0${index}`, `title: 参考资料${index}`], '资料正文。')
  }
  writeFileSync(join(root, 'library', '资料.txt'), '原始参考材料。\n', 'utf8')
  writeFileSync(join(root, 'library', 'metadata.json'), '{"source":"手抄本"}\n', 'utf8')
  spot.libraryFile = { path: 'library/资料.txt', size: statSync(join(root, 'library', '资料.txt')).size }

  const expectedIssueKeys = [
    'CHAPTER_NOT_MARKDOWN|chapters/笔记.txt',
    `FRONTMATTER_ISSUE|${byNumber(35).path}`,
    `DUPLICATE_ID|${byNumber(7).path}`,
    'CHARACTER_NAME_DUPLICATE|characters/a02-清音-空格.md',
    'CHARACTER_NAME_DUPLICATE|characters/a04-ling.md',
    'CHARACTER_NAME_DUPLICATE|characters/a06-白鹤-空格.md',
    'DANGLING_PARENT|world/门派/失落之门.md',
    'DANGLING_PARENT|world/地理/无名谷.md',
    'FORESHADOW_RESOLVED_WITHOUT_CHAPTER|foreshadowing/fs-02-旧信.md',
  ]

  return {
    spot,
    expectedIssueKeys,
    expectedCounts: {
      files: 200,
      chapters: 119, // 120 markdown, minus the dropped duplicate id
      characters: 15,
      worldEntries: 15,
      outlineNodes: 20,
      libraryFiles: 6,
    },
    paths: {
      chapterTitle: byNumber(20).path,
      chapterBody: byNumber(40).path,
      worldTitle: 'world/门派/门派条目1.md',
      chapterToDelete: byNumber(50).path,
      characterToDelete: 'characters/b06-顾长安.md',
      characterToRenameFrom: 'characters/b08-江月白.md',
      characterToRenameTo: 'characters/b08-江月白-改名.md',
    },
    records: {
      chapterTitle: byNumber(20),
      chapterBody: byNumber(40),
      chapterToDelete: byNumber(50),
    },
  }
}

/** index ↔ disk parity for one rebuilt project; returns the build result. */
async function assertParity(harness, root, expected) {
  const rebuild = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
  assert.equal(rebuild.ok, true, `rebuild must succeed: ${JSON.stringify(rebuild.error)}`)
  assert.deepEqual(rebuild.counts, expected.expectedCounts, 'counts must match the planned book')

  readDb(root, (db) => {
    // Every table agrees with the reported counts.
    assert.equal(count(db, 'chapters'), expected.expectedCounts.chapters)
    assert.equal(count(db, 'characters'), expected.expectedCounts.characters)
    assert.equal(count(db, 'world_entries'), expected.expectedCounts.worldEntries)
    assert.equal(count(db, 'outline_nodes'), expected.expectedCounts.outlineNodes)
    assert.equal(count(db, 'library_files'), expected.expectedCounts.libraryFiles)
    // One row per `timeline/<slug>.md`; the count is not part of `counts`
    // (`IndexCounts` is a fixed legacy shape), so it is asserted straight off the table.
    assert.equal(count(db, 'timeline_events'), 6)
    assert.equal(count(db, 'files'), expected.expectedCounts.files)

    // The file list is exactly the disk, not a superset or a subset.
    const indexed = all(db, 'SELECT path FROM files ORDER BY path').map((row) => row.path)
    assert.deepEqual(indexed, diskFiles(root), 'files table must equal the on-disk file set')

    // meta agrees with the file count and the schema version.
    const meta = Object.fromEntries(all(db, 'SELECT key, value FROM meta').map((row) => [row.key, row.value]))
    assert.equal(meta.fileCount, String(expected.expectedCounts.files))
    assert.equal(meta.indexSchemaVersion, String(INDEX_SCHEMA_VERSION))
    assert.equal(meta.root, root)

    // The issues in the database are byte-identical to the ones returned.
    const stored = all(db, 'SELECT code, path, detail FROM validation_issues ORDER BY seq')
    assert.deepEqual(stored.map(issueKey), rebuild.issues.map(issueKey))
    assert.deepEqual([...new Set(stored.map(codePathKey))].sort(), [...expected.expectedIssueKeys].sort())

    // Full-text index covers every kept chapter.
    assert.equal(count(db, 'chapters_fts'), expected.expectedCounts.chapters)
  })

  return rebuild
}

function allValuesOf(db, table, column, where = '', params = []) {
  const sql = `SELECT ${column} FROM ${table}${where === '' ? '' : ` WHERE ${where}`}`
  return all(db, sql, ...params).map((row) => row[column])
}

// ---------------------------------------------------------------------------
// 1. 200 random files: index == disk
// ---------------------------------------------------------------------------

test('parity: a 200-file book indexes exactly what is on disk, issues included', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    const generated = generateBook(root)
    assert.equal(diskFiles(root).length, 200, 'the fixture must really hold 200 files')
    const harness = makeTools(join(dir, 'state'), dir)

    const first = await assertParity(harness, root, generated)

    readDb(root, (db) => {
      const spot = generated.spot
      // --- chapter fields: derived seq, directory volume, explicit overrides ---
      const titleChapter = all(db, 'SELECT id, seq, title, volume, status, word_count FROM chapters WHERE path = ?', spot.chapterVolume.path)
      assert.deepEqual(titleChapter, [
        {
          id: spot.chapterVolume.id,
          seq: spot.chapterVolume.seq,
          title: spot.chapterVolume.title,
          volume: spot.chapterVolume.volume,
          status: spot.chapterVolume.status,
          word_count: spot.chapterVolume.wordCount,
        },
      ])
      assert.deepEqual(all(db, 'SELECT seq FROM chapters WHERE path = ?', spot.chapterExplicitSeq.path), [{ seq: 999 }])
      assert.deepEqual(allValuesOf(db, 'chapters', 'volume', 'path = ?', [spot.chapterExplicitVolume.path]), ['vol-09'])
      // A chapter directly under chapters/ has no volume — never "chapters".
      assert.deepEqual(allValuesOf(db, 'chapters', 'volume', 'path = ?', [spot.chapterTopLevel.path]), [null])
      assert.deepEqual(allValuesOf(db, 'chapters', 'seq', 'path = ?', [spot.chapterTopLevel.path]), [1])
      // An empty body is indexed as 0 characters, not as a missing row.
      assert.deepEqual(allValuesOf(db, 'chapters', 'word_count', 'path = ?', [spot.chapterEmptyBody.path]), [0])

      // --- character name is indexed normalised ---
      assert.deepEqual(all(db, 'SELECT id, name, name_key, group_name FROM characters WHERE path = ?', spot.character.path), [
        { id: spot.character.id, name: spot.character.name, name_key: spot.character.nameKey, group_name: spot.character.group },
      ])
      // The duplicate-name pair keeps both rows (ids differ; the name is the finding).
      assert.equal(
        allValuesOf(db, 'characters', 'name', 'name_key = ?', ['清音']).length,
        2,
      )

      // --- world tree: root has null category/parent, directory is the category ---
      assert.deepEqual(all(db, 'SELECT id, category, parent FROM world_entries WHERE path = ?', spot.worldRoot.path), [
        { id: spot.worldRoot.id, category: null, parent: null },
      ])
      assert.deepEqual(all(db, 'SELECT category, parent FROM world_entries WHERE path = ?', spot.worldDerivedCategory.path), [
        { category: spot.worldDerivedCategory.category, parent: spot.worldDerivedCategory.parent },
      ])

      // --- outline kinds and parents ---
      assert.deepEqual(all(db, 'SELECT id, kind, title, parent FROM outline_nodes WHERE path = ?', spot.outlineVolume.path), [
        { id: spot.outlineVolume.id, kind: spot.outlineVolume.kind, title: spot.outlineVolume.title, parent: spot.outlineVolume.parent },
      ])

      // --- library rows are registry only: path + size ---
      assert.deepEqual(all(db, 'SELECT size FROM library_files WHERE path = ?', spot.libraryFile.path), [{ size: spot.libraryFile.size }])
      assert.equal(allValuesOf(db, 'library_files', 'path').includes('library/资料.txt'), true)
    })

    // ---- idempotent: two rebuilds produce identical counts and issues ----
    const second = await assertParity(harness, root, generated)
    assert.deepEqual(second.counts, first.counts)
    assert.deepEqual(second.issues, first.issues)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. Edit 3, delete 2, rename 1 → the index follows on the next rebuild
// ---------------------------------------------------------------------------

test('parity: three edits, two deletions and one rename are reflected exactly', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    const generated = generateBook(root)
    const harness = makeTools(join(dir, 'state'), dir)
    await assertParity(harness, root, generated)

    // 1. edit a chapter title
    const titleRecord = generated.records.chapterTitle
    markdown(
      root,
      titleRecord.path,
      [`id: ${titleRecord.id}`, 'title: 改名之后的章节', 'status: final', 'mood: 平静'],
      titleRecord.body,
    )

    // 2. edit a chapter body (word count must follow the file)
    const bodyRecord = generated.records.chapterBody
    const newBody = '新正文。雪山之巅，剑气纵横，三人相对而立。'.repeat(4)
    markdown(root, bodyRecord.path, [`id: ${bodyRecord.id}`, `title: ${bodyRecord.title}`, 'status: revised'], newBody)

    // 3. edit a world entry's title (tree shape unchanged)
    markdown(root, generated.paths.worldTitle, ['id: w-01', 'title: 门派条目一（改名）', 'parent: w-root', 'category: 门派'], '条目正文。')

    // 4 + 5. delete one chapter and one character
    rmSync(join(root, generated.paths.chapterToDelete))
    rmSync(join(root, generated.paths.characterToDelete))

    // 6. rename a character card (id and name unchanged, path moves)
    renameSync(join(root, generated.paths.characterToRenameFrom), join(root, generated.paths.characterToRenameTo))

    const expectedCounts = {
      files: 198, // 200 - 2 deletions (a rename keeps one file)
      chapters: 118, // 119 - 1 deleted
      characters: 14, // 15 - 1 deleted
      worldEntries: 15,
      outlineNodes: 20,
      libraryFiles: 6,
    }
    const rebuild = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
    assert.equal(rebuild.ok, true, JSON.stringify(rebuild.error))
    assert.deepEqual(rebuild.counts, expectedCounts)

    readDb(root, (db) => {
      assert.deepEqual(all(db, 'SELECT path FROM files ORDER BY path').map((row) => row.path), diskFiles(root))
      assert.equal(count(db, 'chapters'), expectedCounts.chapters)
      assert.equal(count(db, 'characters'), expectedCounts.characters)

      // edited in place
      assert.deepEqual(allValuesOf(db, 'chapters', 'title', 'id = ?', [titleRecord.id]), ['改名之后的章节'])
      assert.deepEqual(allValuesOf(db, 'chapters', 'status', 'id = ?', [titleRecord.id]), ['final'])
      assert.deepEqual(allValuesOf(db, 'chapters', 'word_count', 'id = ?', [bodyRecord.id]), [countChars(newBody)])
      assert.deepEqual(allValuesOf(db, 'chapters', 'status', 'id = ?', [bodyRecord.id]), ['revised'])
      assert.deepEqual(allValuesOf(db, 'world_entries', 'title', 'id = ?', ['w-01']), ['门派条目一（改名）'])

      // deleted files leave no rows
      assert.deepEqual(all(db, 'SELECT path FROM chapters WHERE path = ?', generated.paths.chapterToDelete), [])
      assert.deepEqual(all(db, 'SELECT path FROM characters WHERE path = ?', generated.paths.characterToDelete), [])
      assert.equal(allValuesOf(db, 'files', 'path').includes(generated.paths.chapterToDelete), false)

      // renamed file: the row follows the new path, the id does not change
      assert.deepEqual(allValuesOf(db, 'characters', 'path', 'id = ?', ['char-15']), [generated.paths.characterToRenameTo])
      assert.deepEqual(all(db, 'SELECT path FROM characters WHERE path = ?', generated.paths.characterToRenameFrom), [])

      // the seeded issues are unaffected by these particular changes
      const stored = all(db, 'SELECT code, path, detail FROM validation_issues ORDER BY seq')
      assert.deepEqual(stored.map(issueKey), rebuild.issues.map(issueKey))
      assert.deepEqual([...new Set(stored.map(codePathKey))].sort(), [...generated.expectedIssueKeys].sort())
    })

    // idempotent after the mutations too
    const again = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
    assert.equal(again.ok, true)
    assert.deepEqual(again.counts, rebuild.counts)
    assert.deepEqual(again.issues, rebuild.issues)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
