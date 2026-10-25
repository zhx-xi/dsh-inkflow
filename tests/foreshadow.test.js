/**
 * The foreshadowing domain: the state machine, the computed `overdue`
 * board state, the panel projection and the writing-context reminder.
 *
 * Why each group exists:
 *   - the 4x4 matrix (data-model §3.2.1): "illegal transitions are refused" is only
 *     worth something if every cell is exercised, so the pure predicate is checked
 *     cell by cell AND the write path is driven through all sixteen pairs on a real
 *     file, each refusal proven to write nothing (whole-tree hash);
 *   - the rebuild-side net: a rebuild has no history, so the only evidence of an
 *     illegal transition is the file contradicting itself (`resolved` vs `status`,
 *     `advancedAt` vs `status`). Those fixtures are the ones a hand-edited book
 *     actually produces;
 *   - `overdue` is COMPUTED (§3.2.2), never stored: the fixtures below ask the same
 *     book three different "current chapters" and the answer has to move with it;
 *   - the projection and the reminder: the board reads the index, the writing
 *     context reads the files, and both must agree about which entries are due.
 *
 * Runs against the BUILT artifacts (`lib/index.js`), like every other suite.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  DOMAIN_MODULES,
  EXTRA_SEGMENTS,
  INDEX_SCHEMA_VERSION,
  apply,
  buildIndex,
  buildWritingContext,
  chapterPositions,
  chapterPositionsFromFiles,
  domainTools,
  entityCounts,
  foreshadowTransitionAllowed,
  listEntities,
} from '../lib/index.js'

const ROOT = resolve(import.meta.dirname, '..')
const HOST = '127.0.0.1:2149'
const INTERNAL = '/inkflow/internal'
const DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']
const ALL_STATUSES = ['planted', 'advanced', 'resolved', 'overdue']

/** §3.2.1, cell by cell: `from -> to`. "No change" is idempotent, not a transition. */
const ALLOWED = new Set([
  'planted->planted',
  'planted->advanced',
  'planted->resolved',
  'planted->overdue',
  'advanced->advanced',
  'advanced->resolved',
  'advanced->overdue',
  'overdue->advanced',
  'overdue->resolved',
  'overdue->overdue',
  'resolved->resolved',
])

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-foreshadow-'))
}

function scaffold(root) {
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, '.git'))
  for (const dir of DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '伏笔之书' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.gitignore'), 'index/*.db\nindex/*.db-wal\nindex/*.db-shm\n.inkflow/\n', 'utf8')
}

function writeMarkdown(root, relativePath, frontmatter, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = frontmatter.length > 0 ? `---\n${frontmatter.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

function callTool(name, args) {
  const tool = domainTools().find((candidate) => candidate.name === name)
  assert.ok(tool, `${name} must be registered by a domain module`)
  return tool.execute(args, { signal: new AbortController().signal, callId: 'foreshadow-test' })
}

function ids(items) {
  return (items ?? []).map((item) => item.id)
}

/**
 * Three chapters in `vol-01` plus one in `vol-10`, and three foreshadows that are
 * due at three different points. `vol-10` exists so the volume comparison has a
 * case where the numeric order and the string order disagree (`vol-10` < `vol-02`
 * as text, 10 > 2 as numbers).
 */
function book(root) {
  scaffold(root)
  for (const [seq, id] of [
    [1, 'ch-1'],
    [2, 'ch-2'],
    [3, 'ch-3'],
  ]) {
    writeMarkdown(
      root,
      `chapters/vol-01/000${String(seq)}-第${String(seq)}章.md`,
      [`id: ${id}`, `title: 第${String(seq)}章`, 'volume: vol-01', `seq: ${String(seq)}`, 'status: draft'],
      `第${String(seq)}章正文。\n`,
    )
  }
  writeMarkdown(
    root,
    'chapters/vol-10/0001-终章.md',
    ['id: ch-10', 'title: 终章', 'volume: vol-10', 'seq: 1', 'status: draft'],
    '终章正文。\n',
  )
  mkdirSync(join(root, 'chapters', 'vol-02'), { recursive: true })
  writeFileSync(join(root, 'chapters', 'vol-02', '.gitkeep'), '', 'utf8')

  writeMarkdown(
    root,
    'foreshadowing/断剑.md',
    ['id: fs-overdue', 'title: 断剑', 'status: planted', 'plantedAt: ch-1', 'dueBy: ch-1', 'linkedEntities: [c-qingyin]'],
    '断剑埋在第一处。\n',
  )
  writeMarkdown(
    root,
    'foreshadowing/旧信.md',
    ['id: fs-duenow', 'title: 旧信', 'status: advanced', 'plantedAt: ch-1', 'advancedAt: [ch-2]', 'dueBy: ch-3', 'linkedEntities: [c-qingyin, w-baihe]'],
    '旧信推进过一次。\n',
  )
  writeMarkdown(root, 'foreshadowing/玉佩.md', ['id: fs-future', 'title: 玉佩', 'status: planted', 'dueBy: vol-02'], '玉佩要留到卷二。\n')

  writeMarkdown(root, 'characters/清音.md', ['id: c-qingyin', 'name: 清音'], '主角。')
  writeMarkdown(root, 'world/门派/白鹤门.md', ['id: w-baihe', 'title: 白鹤门'], '山中剑派。')
}

/**
 * A two-volume book: chapters 1-3 in `vol-01`, chapter 1 in `vol-02`, and an empty
 * `vol-03` so one foreshadow can be due *ahead* of the chapter being written.
 *
 * This is the shape `ORDER BY seq DESC` got wrong: `seq` is volume-local (a new chapter
 * takes its volume's max seq + 1), so the longest volume's last chapter — vol-01/3 —
 * came back as "the chapter being written" while the author was in vol-02. Nothing here
 * needs nine volumes; two is enough to make the two questions differ.
 */
function twoVolumes(root) {
  scaffold(root)
  for (const seq of [1, 2, 3]) {
    writeMarkdown(
      root,
      `chapters/vol-01/000${String(seq)}-第${String(seq)}章.md`,
      [`id: ch-${String(seq)}`, `title: 第${String(seq)}章`, 'volume: vol-01', `seq: ${String(seq)}`, 'status: draft'],
      `第${String(seq)}章正文。\n`,
    )
  }
  writeMarkdown(
    root,
    'chapters/vol-02/0001-卷二开端.md',
    ['id: ch-20', 'title: 卷二开端', 'volume: vol-02', 'seq: 1', 'status: draft'],
    '卷二正文。\n',
  )
  mkdirSync(join(root, 'chapters', 'vol-03'), { recursive: true })
  writeFileSync(join(root, 'chapters', 'vol-03', '.gitkeep'), '', 'utf8')

  // Due in vol-01, which the book has left: late.
  writeMarkdown(root, 'foreshadowing/甲卷末.md', [
    'id: fs-behind',
    'title: 甲卷末',
    'status: planted',
    'plantedAt: ch-1',
    'dueBy: ch-2',
  ])
  // Due in the very chapter being written: this chapter's job.
  writeMarkdown(root, 'foreshadowing/乙开场.md', ['id: fs-now', 'title: 乙开场', 'status: planted', 'dueBy: ch-20'])
  // Due in a later volume: not a reminder yet.
  writeMarkdown(root, 'foreshadowing/丙后卷.md', ['id: fs-ahead', 'title: 丙后卷', 'status: planted', 'dueBy: vol-03'])
}

function readDb(root, run) {
  const db = new DatabaseSync(join(root, 'index', 'inkflow.db'), { readOnly: true })
  try {
    return run(db)
  } finally {
    db.close()
  }
}

/**
 * Fingerprint of every **file** on disk: path, size and mtime.
 *
 * Same idea as `hash-tree.mjs` but deliberately without directory entries. A refused
 * write must leave the bytes AND the timestamps alone (an atomic rewrite with
 * identical content is still a write), while a directory's mtime on Windows is
 * reported lazily — under a loaded run it can move between two snapshots taken around
 * a call that wrote nothing, which would make this assertion fail for a reason that
 * has nothing to do with the code under test.
 */
function hashFiles(root) {
  const hash = createHash('sha256')
  const walk = (relative) => {
    const dir = relative === '' ? root : join(root, relative)
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        walk(child)
        continue
      }
      const info = statSync(join(root, child))
      hash.update(`${child}|${String(info.size)}|${String(info.mtimeMs)}\n`)
    }
  }
  walk('')
  return hash.digest('hex')
}

async function list(args) {
  const result = await callTool('inkflow_foreshadow_list', args)
  assert.equal(result.ok, true, JSON.stringify(result.error))
  return result
}

// ---------------------------------------------------------------------------
// 1. The state machine (§3.2.1) — every cell of the 4x4 matrix
// ---------------------------------------------------------------------------

test('foreshadow: the transition predicate allows exactly the eleven legal cells', () => {
  const observed = []
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      if (foreshadowTransitionAllowed(from, to)) observed.push(`${from}->${to}`)
    }
  }
  assert.deepEqual(observed.sort(), [...ALLOWED].sort(), 'the whole matrix, not a sample')

  // The four refusals this rule is really about, named one at a time:
  assert.equal(foreshadowTransitionAllowed('advanced', 'planted'), false, 'no stepping back from advanced')
  assert.equal(foreshadowTransitionAllowed('overdue', 'planted'), false, 'overdue is a mark, not progress: no step back')
  assert.equal(foreshadowTransitionAllowed('resolved', 'planted'), false, 'resolved is terminal')
  assert.equal(foreshadowTransitionAllowed('resolved', 'advanced'), false, 'resolved is terminal')
  assert.equal(foreshadowTransitionAllowed('resolved', 'overdue'), false, 'a paid-off setup can never be late')
  assert.equal(foreshadowTransitionAllowed('overdue', 'advanced'), true, 'advancing ends the lateness')
  assert.equal(foreshadowTransitionAllowed('planted', 'resolved'), true, 'a one-chapter setup may pay off directly')
})

test('foreshadow: the write path refuses all five illegal transitions and writes nothing', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    book(root)
    await buildIndex(root)

    let refused = 0
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        // Each cell starts from the same file, rewritten to `from`.
        const start = `---\nid: fs-cell\ntitle: 格子\nstatus: ${from}\n${from === 'advanced' ? 'advancedAt: [ch-1]\n' : ''}${
          from === 'resolved' ? 'resolvedChapter: ch-3\n' : ''
        }---\n\n正文。\n`
        writeFileSync(join(root, 'foreshadowing', '格子.md'), start, 'utf8')
        const expected = ALLOWED.has(`${from}->${to}`)
        const before = hashFiles(root)
        const result = await callTool('inkflow_foreshadow_upsert', {
          projectRoot: root,
          id: 'fs-cell',
          title: '格子',
          status: to,
          ...(to === 'advanced' ? { advancedAt: ['ch-2'] } : {}),
          ...(to === 'resolved' ? { resolvedChapter: 'ch-3' } : {}),
          confirm: true,
        })
        const onDisk = readFileSync(join(root, 'foreshadowing', '格子.md'), 'utf8')
        if (expected) {
          assert.equal(result.ok, true, `${from}->${to} must be allowed: ${JSON.stringify(result.error)}`)
          assert.match(onDisk, new RegExp(`^status: ${to}$`, 'mu'), `${from}->${to} landed on disk`)
        } else {
          refused += 1
          assert.equal(result.ok, false, `${from}->${to} must be refused`)
          assert.equal(result.error.code, 'FORESHADOW_TRANSITION_INVALID', `${from}->${to} names the rule`)
          // Zero write: the bytes AND the mtimes of the whole tree are unchanged.
          assert.equal(hashFiles(root), before, `${from}->${to} wrote something`)
          assert.equal(readFileSync(join(root, 'foreshadowing', '格子.md'), 'utf8'), start)
        }
      }
    }
    assert.equal(refused, 5, 'five cells are refused, not "some"')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('foreshadow: the rebuild reports a file that contradicts itself (no history needed)', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    book(root)
    // 1) the read-compatibility boolean disagrees with the machine field
    writeMarkdown(root, 'foreshadowing/矛盾一.md', ['id: fs-c1', 'title: 矛盾一', 'status: planted', 'resolved: true'])
    // 2) a setup that never advanced carries an advance position
    writeMarkdown(root, 'foreshadowing/矛盾二.md', ['id: fs-c2', 'title: 矛盾二', 'status: planted', 'advancedAt: [ch-2]'])
    // 3) an advanced setup with no advance position at all
    writeMarkdown(root, 'foreshadowing/矛盾三.md', ['id: fs-c3', 'title: 矛盾三', 'status: advanced'])
    // ... and one illegal *value*, which is a frontmatter problem, not a transition
    writeMarkdown(root, 'foreshadowing/坏值.md', ['id: fs-bad', 'title: 坏值', 'status: forgotten'])

    const build = await buildIndex(root)
    const transitions = build.issues.filter((issue) => issue.code === 'FORESHADOW_TRANSITION_INVALID')
    assert.deepEqual(
      transitions.map((issue) => issue.path).sort(),
      ['foreshadowing/矛盾一.md', 'foreshadowing/矛盾二.md', 'foreshadowing/矛盾三.md'].sort(),
    )
    assert.deepEqual(
      build.issues.filter((issue) => issue.code === 'FRONTMATTER_ISSUE').map((issue) => issue.path),
      ['foreshadowing/坏值.md'],
    )
    // A rebuild reports; it never blocks. The rows are still in the index.
    const rows = readDb(root, (db) => db.prepare('SELECT id, status FROM foreshadowings ORDER BY id').all())
    assert.deepEqual(
      rows.map((row) => row.id),
      ['fs-bad', 'fs-c1', 'fs-c2', 'fs-c3', 'fs-duenow', 'fs-future', 'fs-overdue'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('foreshadow: I-09 still fires — a paid-off setup must name the chapter that pays it', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    book(root)
    // Both spellings count as resolved: the boolean (old files) and the status (new ones).
    writeMarkdown(root, 'foreshadowing/旧写法.md', ['id: fs-legacy', 'title: 旧写法', 'resolved: true'])
    writeMarkdown(root, 'foreshadowing/新写法.md', ['id: fs-new', 'title: 新写法', 'status: resolved'])
    const build = await buildIndex(root)
    assert.deepEqual(
      build.issues.filter((issue) => issue.code === 'FORESHADOW_RESOLVED_WITHOUT_CHAPTER').map((issue) => issue.path).sort(),
      ['foreshadowing/新写法.md', 'foreshadowing/旧写法.md'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. `overdue` is computed (§3.2.2), never stored
// ---------------------------------------------------------------------------

test('foreshadow: the current chapter is the last (volume, seq), not the last seq', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    twoVolumes(root)
    await buildIndex(root)

    // vol-01 has the largest `seq` in the book, vol-02 has the later *position*: the
    // answer is the position, because `seq` restarts in every volume.
    const context = buildWritingContext(root, { budgetTokens: 20_000 })
    const chapter = context.segments.find((segment) => segment.name === 'chapter')
    assert.ok(chapter, 'the chapter segment is always present')
    assert.equal(
      chapter.text,
      ['### 当前章', '标题：卷二开端｜卷：vol-02｜seq：1｜状态：draft'].join('\n'),
      'the chapter being written is vol-02/1, not vol-01/3',
    )

    // Only the comparison changed: inside vol-01 the last chapter is still seq 3, so
    // "the previous chapter" still comes from the same volume.
    const tail = context.segments.find((segment) => segment.name === 'tail')
    assert.ok(tail, 'the previous chapter is part of the block')
    assert.match(tail.text, /^### 上一章结尾（第 3 章 · 最后 [0-9]+ 字）/, 'volume-local order is untouched')

    // And the number wins over the string: `book()` has vol-01 x3 plus vol-10 x1, and
    // "vol-10" sorts *before* "vol-02" as text.
    const wide = join(dir, 'wide')
    book(wide)
    await buildIndex(wide)
    const wideChapter = buildWritingContext(wide, { budgetTokens: 20_000 }).segments.find((s) => s.name === 'chapter')
    assert.match(wideChapter.text, /标题：终章｜卷：vol-10｜seq：1/, 'vol-10 is the last volume by number')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('foreshadow: the overdue list follows the chapter it is asked about', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    book(root)
    await buildIndex(root)

    // Asked as of the second chapter: only the entry due at ch-1 is late.
    const second = await list({ projectRoot: root, chapter: 'ch-2' })
    assert.deepEqual(ids(second.items.filter((item) => item.overdue)), ['fs-overdue'])
    assert.deepEqual(ids(second.items.filter((item) => item.dueNow)), [])
    assert.deepEqual(ids(second.items.filter((item) => !item.overdue && !item.dueNow)), ['fs-duenow', 'fs-future'])

    // Asked as of the third chapter: one late, one due right now, one still ahead.
    const third = await list({ projectRoot: root, chapter: 'ch-3' })
    assert.deepEqual(ids(third.items.filter((item) => item.overdue)), ['fs-overdue'])
    assert.deepEqual(ids(third.items.filter((item) => item.dueNow)), ['fs-duenow'])
    assert.deepEqual(ids(third.items.filter((item) => !item.overdue && !item.dueNow)), ['fs-future'])
    assert.equal(third.currentChapter.id, 'ch-3')
    assert.deepEqual(third.counts, { total: 3, unresolved: 3, resolved: 0, overdue: 1, dueNow: 1 })

    // The default current chapter is the latest position in the book — not the
    // latest file name, and not a chapter from the first volume. As of it, all three
    // entries are behind their deadline: ch-1 and ch-3 are earlier chapters, and
    // vol-02 is an earlier volume.
    const latest = await list({ projectRoot: root })
    assert.equal(latest.currentChapter.id, 'ch-10')
    assert.deepEqual(latest.currentChapter, { id: 'ch-10', title: '终章', volume: 'vol-10', seq: 1, path: 'chapters/vol-10/0001-终章.md' })
    assert.deepEqual(ids(latest.items.filter((item) => item.overdue)), ['fs-overdue', 'fs-duenow', 'fs-future'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('foreshadow: an index that exists but is out of date cannot hide a deadline', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    book(root)
    await buildIndex(root)

    // The author adds a chapter and a foreshadow in their editor; nothing rebuilds the
    // derived index. `dueBy` names a chapter the index has never seen, so a position
    // table read from the index answers "unknown deadline" — and the segment then simply
    // does not appear, which reads as "nothing is due" in a book that has a late setup.
    writeMarkdown(root, 'chapters/vol-02/0001-开端.md', ['id: ch-20', 'title: 开端', 'volume: vol-02', 'seq: 1'])
    writeMarkdown(root, 'foreshadowing/卷二到期.md', [
      'id: fs-stale',
      'title: 卷二到期',
      'status: planted',
      'dueBy: ch-20',
    ])

    const stale = buildWritingContext(root, { budgetTokens: 20_000 })
    const staleSegment = stale.segments.find((entry) => entry.name === 'foreshadow')
    assert.ok(staleSegment, 'the reminder must not depend on the derived index being current')
    assert.ok(
      staleSegment.text.includes('[超期] 卷二到期'),
      'vol-02 sits before vol-10, so the deadline is behind us',
    )

    // A rebuilt index answers the same: the reminder takes its positions from the files,
    // and the extra chapter does not move the current chapter (vol-10 is still last).
    await buildIndex(root)
    const fresh = buildWritingContext(root, { budgetTokens: 20_000 })
    const freshSegment = fresh.segments.find((entry) => entry.name === 'foreshadow')
    assert.equal(freshSegment.text, staleSegment.text, 'index present or not, the reminder says the same thing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('foreshadow: the reminder places the current chapter by its file, not by a stale index row', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    book(root)
    // Due exactly at the chapter being written: `[本期]`. That is the one shape where the
    // *current* chapter's own position decides whether the entry is listed at all, so it
    // is the shape that can tell the two position sources apart.
    writeMarkdown(root, 'foreshadowing/终章到期.md', [
      'id: fs-last',
      'title: 终章到期',
      'status: planted',
      'dueBy: ch-10',
    ])
    await buildIndex(root)

    // The author renumbers the last chapter in their editor (seq 1 → 4); nothing rebuilds
    // the derived index, which still says `vol-10 / seq 1`. Reading the position from the
    // index puts the deadline three steps ahead of the chapter being written, and the
    // reminder drops the entry silently — the failure mode data-model §3.2.2 names.
    writeMarkdown(
      root,
      'chapters/vol-10/0001-终章.md',
      ['id: ch-10', 'title: 终章', 'volume: vol-10', 'seq: 4', 'status: draft'],
      '终章正文。\n',
    )

    const context = buildWritingContext(root, { budgetTokens: 20_000 })
    const segment = context.segments.find((entry) => entry.name === 'foreshadow')
    assert.ok(segment, 'the reminder still renders')
    assert.ok(segment.text.includes('vol-10 第 4 章'), 'the header names the position the file gives')
    assert.ok(segment.text.includes('[本期] 终章到期'), 'the file says this very chapter is the deadline')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('foreshadow: the index and the file walk agree about where a chapter sits', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    book(root)
    // A hand-written chapter with no `seq` and no leading number in its file name: the
    // index used to drop it (`WHERE seq IS NOT NULL`) while the walk placed it at 1, so
    // the same book had two different position tables.
    writeMarkdown(root, 'chapters/vol-01/附录.md', ['id: ch-appendix', 'title: 附录', 'volume: vol-01'])
    writeMarkdown(root, 'foreshadowing/附录到期.md', ['id: fs-appendix', 'title: 附录到期', 'status: planted', 'dueBy: ch-appendix'])
    await buildIndex(root)

    const fromIndex = chapterPositions(root)
    assert.ok(fromIndex.has('ch-appendix'), 'the index path keeps a chapter without a seq')
    assert.equal(fromIndex.get('ch-appendix').seq, 1, 'and places it first in its volume')
    const fromFiles = chapterPositionsFromFiles(root)
    assert.deepEqual([...fromFiles.keys()].sort(), [...fromIndex.keys()].sort(), 'both sources name the same chapters')
    for (const key of fromFiles.keys()) {
      assert.deepEqual(fromFiles.get(key), fromIndex.get(key), `${key} sits in the same place`)
    }

    // And the deadline resolves as a chapter, not to "unknown".
    const result = await list({ projectRoot: root, chapter: 'ch-2' })
    const entry = result.items.find((item) => item.id === 'fs-appendix')
    assert.equal(entry.dueKind, 'chapter')
    assert.equal(entry.overdue, true, 'vol-01 chapter 1 is behind vol-01 chapter 2')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('foreshadow: over the row cap the counts still cover the whole book', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    book(root)
    // 3 from `book()` plus 498 = 501, one past the list cap. The counts used to be taken
    // from the capped list, so this book reported `total: 500`.
    for (let index = 1; index <= 498; index += 1) {
      writeMarkdown(root, `foreshadowing/批量${String(index)}.md`, [
        `id: fs-bulk-${String(index)}`,
        `title: 批量${String(index)}`,
        'status: planted',
      ])
    }
    await buildIndex(root)
    const result = await list({ projectRoot: root })
    assert.equal(result.counts.total, 501, 'the total counts every row, not the capped list')
    assert.equal(result.items.length, 500, 'the list itself stays capped')
    assert.equal(result.truncated, true, 'and it says the list is partial')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('foreshadow: a volume deadline compares numbers, not strings', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    book(root)
    // The only entry due at a *volume*: vol-02, which lies between vol-01 and vol-10.
    writeMarkdown(root, 'foreshadowing/卷二收线.md', ['id: fs-vol', 'title: 卷二收线', 'status: planted', 'dueBy: vol-02'])
    await buildIndex(root)

    // ch-10 sits in vol-10 (order 10 > 2): late. As text `vol-10` < `vol-02`, so a
    // string comparison would have answered "not yet".
    const late = await list({ projectRoot: root, chapter: 'ch-10' })
    const entry = late.items.find((item) => item.id === 'fs-vol')
    assert.equal(entry.dueKind, 'volume')
    assert.equal(entry.overdue, true)

    // Inside the due volume itself an entry is not late: the author still has the
    // whole volume to pay it off.
    const inVolume = await list({ projectRoot: root, chapter: 'ch-1' })
    const pending = inVolume.items.find((item) => item.id === 'fs-vol')
    assert.equal(pending.overdue, false, 'vol-01 is not the due volume')
    writeMarkdown(root, 'chapters/vol-02/0001-开端.md', ['id: ch-20', 'title: 卷二开端', 'volume: vol-02', 'seq: 1'])
    await buildIndex(root)
    const inside = await list({ projectRoot: root, chapter: 'ch-20' })
    assert.equal(inside.items.find((item) => item.id === 'fs-vol').dueNow, true, 'the due volume is "due now", not late')

    // An unresolvable deadline is not a late one, and it says so instead of guessing.
    writeMarkdown(root, 'foreshadowing/悬空到期.md', ['id: fs-dangling', 'title: 悬空到期', 'status: planted', 'dueBy: ch-999'])
    // The same for a volume that no `chapters/vol-*` directory carries: "the book has
    // moved past volume 99" is vacuously true, so a typo'd volume id would mark every
    // such setup late forever (§3.2.2 requires the id to hit the catalog).
    writeMarkdown(root, 'foreshadowing/错卷.md', ['id: fs-void', 'title: 错卷', 'status: planted', 'dueBy: vol-99'])
    await buildIndex(root)
    const dangling = await list({ projectRoot: root, chapter: 'ch-10' })
    const orphan = dangling.items.find((item) => item.id === 'fs-dangling')
    assert.equal(orphan.dueKind, 'unknown')
    assert.equal(orphan.overdue, false)
    const voidVolume = dangling.items.find((item) => item.id === 'fs-void')
    assert.equal(voidVolume.dueKind, 'unknown', 'vol-99 is not a volume of this book')
    assert.equal(voidVolume.overdue, false)
    assert.equal(voidVolume.dueNow, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('foreshadow: the computed state wins over a `status: overdue` written in the file', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    book(root)
    // Declared late, but nothing is due before ch-2 → the board shows the fallback.
    writeMarkdown(root, 'foreshadowing/自封超期.md', ['id: fs-claim', 'title: 自封超期', 'status: overdue', 'dueBy: ch-3'])
    // Declared late AND genuinely late, with an advance record → stays advanced underneath.
    writeMarkdown(root, 'foreshadowing/真的超期.md', ['id: fs-real', 'title: 真的超期', 'status: overdue', 'advancedAt: [ch-1]', 'dueBy: ch-1'])
    await buildIndex(root)

    const early = await list({ projectRoot: root, chapter: 'ch-2' })
    const claim = early.items.find((item) => item.id === 'fs-claim')
    assert.equal(claim.declaredStatus, 'overdue', 'the file value is echoed, never rewritten')
    assert.equal(claim.overdue, false)
    assert.equal(claim.status, 'planted', 'no advance record → the fallback is planted')

    const real = early.items.find((item) => item.id === 'fs-real')
    assert.equal(real.status, 'overdue', 'computed late')
    assert.equal(real.declaredStatus, 'overdue')

    // The file is untouched by a read: the index is a cache, not a write-back.
    assert.match(readFileSync(join(root, 'foreshadowing', '自封超期.md'), 'utf8'), /^status: overdue$/mu)

    // The very chapter it is due in is "due now", not late: the mark is not yet
    // justified by the calendar, so the computed answer is still the fallback.
    const due = await list({ projectRoot: root, chapter: 'ch-3' })
    const nowDue = due.items.find((item) => item.id === 'fs-claim')
    assert.equal(nowDue.dueNow, true)
    assert.equal(nowDue.status, 'planted')
    // One chapter later the mark is genuine, and the computed state agrees with it.
    const late = await list({ projectRoot: root, chapter: 'ch-10' })
    const nowLate = late.items.find((item) => item.id === 'fs-claim')
    assert.equal(nowLate.status, 'overdue')

    // The board says `planted` (computed) while the file says `overdue` — so writing
    // `planted` back is refused as a step back from the declared mark. That is right, but
    // it looks like a contradiction unless the hint says the computed value wins and
    // names a way out.
    const rewrite = await callTool('inkflow_foreshadow_upsert', {
      projectRoot: root,
      id: 'fs-claim',
      title: '自封超期',
      status: 'planted',
      confirm: true,
    })
    assert.equal(rewrite.ok, false)
    assert.equal(rewrite.error.code, 'FORESHADOW_TRANSITION_INVALID')
    assert.match(rewrite.error.hint, /overdue/, 'the hint names the declared mark')
    assert.match(rewrite.error.hint, /computed/, 'and says the computed state is what the board shows')
    assert.match(rewrite.error.hint, /advanced/, 'and how to change it instead')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. The write path: create, edit, confirm gate
// ---------------------------------------------------------------------------

test('foreshadow: upsert creates the document, keeps the body and needs confirmation', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    book(root)

    const unconfirmed = await callTool('inkflow_foreshadow_upsert', {
      projectRoot: root,
      id: 'fs-new',
      title: '新伏笔',
      status: 'planted',
      dueBy: 'ch-2',
    })
    assert.equal(unconfirmed.ok, false)
    assert.equal(unconfirmed.requiresConfirmation, true)
    assert.equal(unconfirmed.willWrite, 'foreshadowing/新伏笔.md')
    assert.equal(unconfirmed.error.code, 'FORESHADOW_UPSERT_REQUIRES_CONFIRMATION')

    const created = await callTool('inkflow_foreshadow_upsert', {
      projectRoot: root,
      id: 'fs-new',
      title: '新伏笔',
      status: 'planted',
      dueBy: 'ch-2',
      plantedAt: 'ch-1',
      linkedEntities: ['c-qingyin'],
      body: '第一章埋下。',
      confirm: true,
    })
    assert.equal(created.ok, true, JSON.stringify(created.error))
    assert.equal(created.created, true)
    assert.equal(created.indexRebuilt, true)
    const text = readFileSync(join(root, 'foreshadowing', '新伏笔.md'), 'utf8')
    assert.match(text, /^status: planted$/mu)
    assert.match(text, /^dueBy: ch-2$/mu)
    assert.match(text, /第一章埋下。/)

    // An edit patches the frontmatter and leaves the author's body and unknown keys alone.
    writeFileSync(
      join(root, 'foreshadowing', '新伏笔.md'),
      text.replace('第一章埋下。', '第一章埋下。\n\n# 备注\n作者自己的行。'),
      'utf8',
    )
    const edited = await callTool('inkflow_foreshadow_upsert', {
      projectRoot: root,
      id: 'fs-new',
      title: '新伏笔',
      status: 'advanced',
      advancedAt: ['ch-2'],
      confirm: true,
    })
    assert.equal(edited.ok, true, JSON.stringify(edited.error))
    assert.equal(edited.created, false)
    assert.equal(edited.replaced, true)
    const after = readFileSync(join(root, 'foreshadowing', '新伏笔.md'), 'utf8')
    assert.match(after, /^status: advanced$/mu)
    assert.match(after, /作者自己的行。/, 'the body survives a field edit')
    assert.match(after, /^dueBy: ch-2$/mu, 'a field the call does not mention keeps its value')

    // The projection and the table both know it, under the same kind.
    const entities = listEntities(root, { kind: 'foreshadowing' })
    assert.equal(entities.find((entity) => entity.id === 'fs-new')?.title, '新伏笔')
    assert.deepEqual(entityCounts(root)?.foreshadowing, 4)
    const rows = readDb(root, (db) => db.prepare('SELECT path, advanced_at FROM foreshadowings WHERE id = ?').all('fs-new'))
    // node:sqlite hands back null-prototype rows; compare plain objects.
    assert.deepEqual(rows.map((row) => ({ ...row })), [{ path: 'foreshadowing/新伏笔.md', advanced_at: 'ch-2' }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('foreshadow: a missing title and a bad status are refused before anything is written', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    book(root)
    const before = hashFiles(root)

    const noTitle = await callTool('inkflow_foreshadow_upsert', { projectRoot: root, status: 'planted', confirm: true })
    assert.equal(noTitle.error.code, 'TITLE_REQUIRED')

    const badStatus = await callTool('inkflow_foreshadow_upsert', {
      projectRoot: root,
      title: '坏状态',
      status: 'forgotten',
      confirm: true,
    })
    assert.equal(badStatus.error.code, 'FORESHADOW_STATUS_INVALID')

    const multiline = await callTool('inkflow_foreshadow_upsert', {
      projectRoot: root,
      title: '多行',
      dueBy: 'ch-1\nch-2',
      confirm: true,
    })
    assert.equal(multiline.error.code, 'FORESHADOW_FIELD_INVALID')

    // An id list goes into a frontmatter list line, and the renderer **throws** on a
    // line break: before the shared reader, these two calls crashed the tool instead of
    // answering with a code the model can act on.
    const multilineAdvanced = await callTool('inkflow_foreshadow_upsert', {
      projectRoot: root,
      title: '多行推进',
      status: 'advanced',
      advancedAt: ['ch-1\nch-2'],
      confirm: true,
    })
    assert.equal(multilineAdvanced.ok, false)
    assert.equal(multilineAdvanced.error.code, 'FORESHADOW_FIELD_INVALID')
    assert.equal(multilineAdvanced.error.code, 'FORESHADOW_FIELD_INVALID', 'a refusal, never a thrown TypeError')

    const multilineLinked = await callTool('inkflow_foreshadow_upsert', {
      projectRoot: root,
      title: '多行关联',
      linkedEntities: ['c-qingyin\nw-baihe'],
      confirm: true,
    })
    assert.equal(multilineLinked.ok, false)
    assert.equal(multilineLinked.error.code, 'FORESHADOW_FIELD_INVALID')

    assert.equal(hashFiles(root), before, 'a refused call writes nothing at all')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. The projection, the panel route and the writing-context reminder
// ---------------------------------------------------------------------------

test('foreshadow: the domain publishes the table, the entity rows and the module registration', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    book(root)
    await buildIndex(root)

    assert.equal(
      DOMAIN_MODULES.some((module) => module.kind === 'foreshadowing'),
      true,
      'the registry owns foreshadowing/ now, not the generic frontmatter pass',
    )
    const rows = readDb(root, (db) => db.prepare('SELECT id, path, status, due_by FROM foreshadowings ORDER BY id').all())
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { id: 'fs-duenow', path: 'foreshadowing/旧信.md', status: 'advanced', due_by: 'ch-3' },
      { id: 'fs-future', path: 'foreshadowing/玉佩.md', status: 'planted', due_by: 'vol-02' },
      { id: 'fs-overdue', path: 'foreshadowing/断剑.md', status: 'planted', due_by: 'ch-1' },
    ])
    assert.equal(INDEX_SCHEMA_VERSION, 9, 'a new table is a new schema version, never an ALTER')

    const entities = listEntities(root, { kind: 'foreshadowing' })
    assert.deepEqual(entities.map((entity) => entity.id).sort(), ['fs-duenow', 'fs-future', 'fs-overdue'])
    assert.equal(entities.find((entity) => entity.id === 'fs-overdue')?.status, 'planted', 'entities carries the FILE value')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('foreshadow: GET /foreshadow is the board, and it stays read-only', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    book(root)
    await buildIndex(root)
    const harness = createHarness({ workspace: root })

    const response = await internalCall(harness, '/foreshadow')
    assert.equal(response.status, 200)
    assert.equal(response.json.ok, true, JSON.stringify(response.json.error))
    const value = response.json.value
    assert.equal(value.currentChapter.id, 'ch-10')
    assert.deepEqual(Object.keys(value.groups).sort(), ['byEntity', 'overdue', 'unresolved'])
    assert.deepEqual(ids(value.groups.unresolved).sort(), ['fs-duenow', 'fs-future', 'fs-overdue'])
    // ch-1 and ch-3 are earlier chapters and vol-02 an earlier volume: as of the
    // furthest chapter in the book, all three are behind their deadline.
    assert.equal(value.groups.overdue.length, 3, 'as of the last chapter, three are late')
    // Grouped by the entities each entry links to, with the entity's own title.
    const qingyin = value.groups.byEntity.find((group) => group.id === 'c-qingyin')
    assert.ok(qingyin, 'a linked character gets a group')
    assert.equal(qingyin.title, '清音')
    assert.deepEqual(qingyin.items.map((item) => item.id).sort(), ['fs-duenow', 'fs-overdue'])
    const unattached = value.groups.byEntity.find((group) => group.id === null)
    assert.deepEqual(unattached.items.map((item) => item.id), ['fs-future'], 'no linked entities is its own bucket')

    // A write verb on a read route is a 405 with the Allow header, as for every read route.
    const rejected = await internalCall(harness, '/foreshadow', { method: 'POST' })
    assert.equal(rejected.status, 405)
    assert.equal(rejected.headers.allow, 'GET')
    // ... and a cross-site Origin is refused before the handler runs.
    const crossSite = await internalCall(harness, '/foreshadow', { origin: 'http://evil.example' })
    assert.equal(crossSite.status, 403)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('foreshadow: the writing context lists what this chapter should pay off', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    twoVolumes(root)
    await buildIndex(root)
    assert.equal(
      EXTRA_SEGMENTS.some((spec) => spec.name === 'foreshadow'),
      true,
      'the reminder is registered through the seam, not inside the renderer',
    )
    const spec = EXTRA_SEGMENTS.find((entry) => entry.name === 'foreshadow')
    assert.equal(spec.label, '伏笔提示')
    assert.equal(spec.capRatio, 0.1)

    // The whole block, pinned. It was a set of `match()` calls before, and that is how
    // the wrong current chapter survived review: "断剑 appears" stays true whether the
    // chapter is vol-02/1 or vol-01/3, while the `[超期]` / `[本期]` labels — the thing
    // the model acts on — flip between the two answers. A generous budget keeps the
    // segment's own 10% cap out of the way; the cap has its own test.
    const context = buildWritingContext(root, { budgetTokens: 20_000 })
    const segment = context.segments.find((entry) => entry.name === 'foreshadow')
    assert.ok(segment, `expected a foreshadow segment in ${context.segments.map((entry) => entry.name).join(',')}`)
    assert.equal(
      segment.text,
      [
        '### 伏笔提示',
        '本章建议回收 2 条（vol-02 第 1 章）：',
        '- [超期] 甲卷末 — 应在 ch-2 回收，已经越过（foreshadowing/甲卷末.md）',
        '- [本期] 乙开场 — 本章到期（foreshadowing/乙开场.md）',
      ].join('\n'),
      'an entry due in a later volume is not a reminder, and the two labels are the answer',
    )
    // Order on the wire: after the world book, and the block is a real heading.
    assert.ok(context.text.includes('### 伏笔提示'))

    // Nothing to remind about → no segment at all, not an empty heading.
    writeFileSync(
      join(root, 'foreshadowing', '甲卷末.md'),
      '---\nid: fs-behind\ntitle: 甲卷末\nstatus: resolved\nresolvedChapter: ch-2\n---\n\n收了。\n',
      'utf8',
    )
    writeFileSync(
      join(root, 'foreshadowing', '乙开场.md'),
      '---\nid: fs-now\ntitle: 乙开场\nstatus: resolved\nresolvedChapter: ch-20\n---\n\n也收了。\n',
      'utf8',
    )
    await buildIndex(root)
    const quiet = buildWritingContext(root, { budgetTokens: 20_000 })
    assert.equal(quiet.segments.some((entry) => entry.name === 'foreshadow'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('foreshadow: the reminder caps at five entries and survives a missing index', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    book(root)
    for (let index = 1; index <= 7; index += 1) {
      writeMarkdown(root, `foreshadowing/超期${String(index)}.md`, [
        `id: fs-late-${String(index)}`,
        `title: 超期${String(index)}`,
        'status: planted',
        'dueBy: ch-1',
      ])
    }
    // No buildIndex() here on purpose: the writing context may not depend on the
    // derived cache, because the first chapter of a fresh book has no index yet.
    // A generous budget keeps the segment's own 10% cap out of the way — the point of
    // this test is the five-entry limit, not the clip.
    const context = buildWritingContext(root, { budgetTokens: 20_000 })
    const segment = context.segments.find((entry) => entry.name === 'foreshadow')
    assert.ok(segment, 'the reminder works from the files alone')
    const listed = segment.text.split('\n').filter((line) => line.startsWith('- '))
    assert.equal(listed.length, 5, 'at most five suggestions, never the whole backlog')
    // Under the default budget the same segment is clipped to its 10% share.
    const clipped = buildWritingContext(root).segments.find((entry) => entry.name === 'foreshadow')
    assert.ok(clipped !== undefined && clipped.text.length <= Math.floor(0.1 * 1200))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. The client view model (pure)
// ---------------------------------------------------------------------------

test('foreshadow: the panel model groups the board and words each state', async () => {
  const model = await bundle('foreshadow-model.ts')
  const late = { id: 'fs-a', title: '断剑', file: 'foreshadowing/断剑.md', status: 'overdue', declaredStatus: 'planted', overdue: true, dueNow: false, dueBy: 'ch-1', dueKind: 'chapter', linkedEntities: ['c-qingyin'] }
  const now = { id: 'fs-b', title: '旧信', file: 'foreshadowing/旧信.md', status: 'advanced', declaredStatus: 'advanced', overdue: false, dueNow: true, dueBy: 'ch-3', dueKind: 'chapter', linkedEntities: ['c-qingyin'] }
  const view = model.readForeshadowBoard({
    ok: true,
    status: 200,
    value: {
      currentChapter: { id: 'ch-3', title: '第三章', volume: 'vol-01', seq: 3, path: 'chapters/vol-01/0003-第三章.md' },
      indexAvailable: true,
      counts: { total: 3, unresolved: 2, resolved: 1, overdue: 1, dueNow: 1 },
      groups: {
        unresolved: [late, now],
        overdue: [late],
        byEntity: [{ id: 'c-qingyin', title: '清音', kind: 'characters', items: [late, now] }],
      },
    },
  })
  assert.equal(view.error, null)
  assert.equal(view.summary, '超期 1 · 本期到期 1 · 未回收 2 / 共 3')
  assert.deepEqual(view.sections.map((section) => section.key), ['dueNow', 'overdue', 'unresolved', 'byEntity'])
  assert.equal(view.sections[0].title, '本期到期')
  assert.equal(view.sections[0].items[0].badge, '本期到期')
  assert.equal(view.sections[0].items[0].current, true)
  assert.equal(view.sections[1].title, '超期')
  assert.equal(view.sections[1].items[0].badge, '超期')
  assert.equal(view.sections[2].items[1].badge, '本期到期')
  assert.equal(view.sections[2].items[1].current, true)
  assert.equal(view.sections[3].entities[0].label, '清音（2）')

  // "Cannot answer" is not "no foreshadows": the wording has to keep them apart.
  const unavailable = model.readForeshadowBoard({ ok: true, status: 200, value: { currentChapter: null, indexAvailable: false, counts: null, groups: null } })
  assert.equal(unavailable.indexAvailable, false)
  assert.match(unavailable.empty, /索引/)
  const failed = model.readForeshadowBoard({ ok: false, status: 500, error: { code: 'INDEX_UNAVAILABLE', message: 'x' } })
  assert.match(failed.error, /INDEX_UNAVAILABLE/)
  assert.equal(model.statusLabel('overdue'), '超期')
  assert.equal(model.statusLabel('planted'), '已埋')
  assert.equal(model.statusLabel('advanced'), '已推进')
  assert.equal(model.statusLabel('resolved'), '已回收')
})

/**
 * Issue 137: the board had three sections while the verification checklist and the
 * user guide both promised four — 本期到期 existed only in the summary line, and it is
 * the one that says "pay this off in the chapter you are writing".
 *
 * The fixture is the smallest one that exercises every branch: one entry due in the
 * current chapter, one already late, one still ahead of its deadline. Membership AND
 * the counts are asserted, because the section must agree with the summary line the
 * author reads first — the Host sends both and they must not drift.
 */
test('foreshadow: the board renders 本期到期 as its own section, ahead of 超期 (issue 137)', async () => {
  const model = await bundle('foreshadow-model.ts')
  const now = { id: 'fs-now', title: '旧信', file: 'foreshadowing/旧信.md', status: 'planted', declaredStatus: 'planted', overdue: false, dueNow: true, dueBy: 'ch-3', dueKind: 'chapter', linkedEntities: ['c-qingyin'] }
  const late = { id: 'fs-late', title: '断剑', file: 'foreshadowing/断剑.md', status: 'advanced', declaredStatus: 'advanced', overdue: true, dueNow: false, dueBy: 'ch-1', dueKind: 'chapter', linkedEntities: ['c-qingyin'] }
  const future = { id: 'fs-future', title: '玉佩', file: 'foreshadowing/玉佩.md', status: 'planted', declaredStatus: 'planted', overdue: false, dueNow: false, dueBy: 'ch-9', dueKind: 'chapter', linkedEntities: [] }

  const view = model.readForeshadowBoard({
    ok: true,
    status: 200,
    value: {
      currentChapter: { id: 'ch-3', title: '第三章', volume: 'vol-01', seq: 3, path: 'chapters/vol-01/0003-第三章.md' },
      indexAvailable: true,
      counts: { total: 3, unresolved: 3, resolved: 0, overdue: 1, dueNow: 1 },
      groups: {
        // The Host's own two lists: `unresolved` is `status !== 'resolved'`, `overdue`
        // is the computed lateness. `dueNow` is a flag ON those rows, not a third list.
        unresolved: [late, now, future],
        overdue: [late],
        byEntity: [{ id: 'c-qingyin', title: '清音', kind: 'characters', items: [now, late] }],
      },
    },
  })

  assert.deepEqual(
    view.sections.map((section) => section.key),
    ['dueNow', 'overdue', 'unresolved', 'byEntity'],
    '本期到期 → 超期 → 未回收 → 按角色: what to do this chapter comes first',
  )
  const byKey = Object.fromEntries(view.sections.map((section) => [section.key, section]))
  assert.deepEqual(byKey.dueNow.items.map((card) => card.id), ['fs-now'], 'only the entry due in this chapter')
  assert.deepEqual(byKey.overdue.items.map((card) => card.id), ['fs-late'])
  assert.deepEqual(byKey.unresolved.items.map((card) => card.id), ['fs-late', 'fs-now', 'fs-future'])
  // The counts the author reads at the top and the section sizes are the same numbers.
  assert.equal(view.summary, '超期 1 · 本期到期 1 · 未回收 3 / 共 3')
  assert.equal(byKey.dueNow.items.length, 1, 'the section holds exactly the 1 the summary claims')
  assert.equal(byKey.overdue.items.length, 1)
  assert.equal(byKey.unresolved.items.length, 3)
  assert.equal(byKey.dueNow.items[0].badge, '本期到期')
  assert.equal(byKey.overdue.items[0].badge, '超期')

  // Empty groups are not rendered: no "本期到期（0）" placeholder pushing the real
  // sections down. A chapter later the same entry is late, not due, so that section
  // disappears entirely (the summary line still says 本期到期 0).
  const later = model.readForeshadowBoard({
    ok: true,
    status: 200,
    value: {
      currentChapter: { id: 'ch-4', title: '第四章', volume: 'vol-01', seq: 4, path: 'chapters/vol-01/0004-第四章.md' },
      indexAvailable: true,
      counts: { total: 3, unresolved: 3, resolved: 0, overdue: 2, dueNow: 0 },
      groups: {
        unresolved: [late, { ...now, status: 'overdue', overdue: true, dueNow: false }, future],
        overdue: [late, { ...now, status: 'overdue', overdue: true, dueNow: false }],
        byEntity: [],
      },
    },
  })
  assert.deepEqual(
    later.sections.map((section) => section.key),
    ['overdue', 'unresolved'],
    'nothing due now → no 本期到期 section at all (and no byEntity card either)',
  )
  assert.match(later.summary, /本期到期 0/, 'the zero is still stated — by the summary, not by an empty card')
})

// ---------------------------------------------------------------------------
// B3 — the field dictionary the author is told to copy
// ---------------------------------------------------------------------------

/**
 * Why this test exists: §3.9 of `conventions.md` is what a person (or a model) reads
 * before writing a `foreshadowing/*.md` by hand, and it used to name `threads` /
 * `characters` — keys the parser silently drops, so the file looked valid and did
 * nothing. The fix was a doc change, which is exactly the change that drifts back.
 * This pins §3.9 to §3.2's real field set: every field data-model lists must be named
 * here, and the example frontmatter must not invent a key §3.2 does not define.
 */
test('foreshadow: conventions §3.9 names exactly the fields data-model §3.2 defines', () => {
  const section = (file, start, end) => {
    const body = readFileSync(join(ROOT, '.agents/specs', file), 'utf8')
    const from = body.indexOf(start)
    const to = body.indexOf(end, from + start.length)
    assert.ok(from >= 0 && to > from, `${file}: "${start}" … "${end}" not found`)
    return body.slice(from, to)
  }

  const specFields = [...section('data-model.md', '### 3.2 伏笔', '#### 3.2.1').matchAll(/^\| `(\w+)` \|/gmu)].map(
    (match) => match[1],
  )
  assert.ok(specFields.length >= 8, `expected the §3.2 field table, parsed ${String(specFields.length)}`)

  const conventions = section('conventions.md', '### 3.9 伏笔', '### 3.10')
  const missing = specFields.filter((field) => !conventions.includes(field))
  assert.deepEqual(missing, [], 'conventions §3.9 must name every field of data-model §3.2')

  // The example is copied verbatim by readers: a key that is not in §3.2 makes a file
  // that parses and then silently loses the field (the `threads` / `characters` bug).
  const example = /```markdown\n(---\n[\s\S]*?\n---\n)/u.exec(conventions)
  assert.ok(example !== null, 'conventions §3.9 must keep a copy-pasteable frontmatter example')
  const keys = [...example[1].matchAll(/^([A-Za-z][\w-]*):/gmu)].map((match) => match[1])
  assert.ok(keys.length >= 3, `expected keys in the example, parsed ${keys.join(', ')}`)
  assert.deepEqual(
    keys.filter((key) => !specFields.includes(key)),
    [],
    'the §3.9 example must not invent a frontmatter key that data-model §3.2 does not define',
  )
})

// ---------------------------------------------------------------------------
// Harness helpers (the channel pair is the one internal-channel.test.js uses)
// ---------------------------------------------------------------------------

function createHarness({ workspace, sessionId = 'session-1' }) {
  const routes = []
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
      if (name === 'sessions') {
        return { get: (id) => (id === sessionId ? { id, header: { cwd: workspace } } : undefined) }
      }
      if (name === 'workingDirectory') {
        return { get: (session) => session?.header?.cwd ?? workspace }
      }
      return undefined
    },
    logger() {
      return { debug() {}, info() {}, warn() {}, error() {} }
    },
    tools: { register: () => () => {} },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  apply(ctx, { dataDir: join(tmpdir(), 'inkflow-foreshadow-state') })
  return { ctx, routes }
}

async function callRoute(harness, request) {
  const route = harness.routes.find((entry) => entry.path === '/inkflow')
  assert.ok(route, 'expected a /inkflow prefix route')
  const response = {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(key, value) {
      response.headers[key.toLowerCase()] = value
    },
    end(payload) {
      response.body = payload
    },
  }
  await route.handler(request, response)
  return {
    status: response.statusCode,
    headers: response.headers,
    json: response.body === undefined ? undefined : JSON.parse(response.body),
  }
}

function internalCall(harness, path, options = {}) {
  const query = `sessionId=${encodeURIComponent(options.sessionId ?? 'session-1')}`
  const separator = path.includes('?') ? '&' : '?'
  const headers = { host: HOST }
  if (options.origin !== undefined) headers.origin = options.origin
  return callRoute(harness, {
    url: `${INTERNAL}${path}${separator}${query}`,
    method: options.method ?? 'GET',
    headers,
    socket: { remoteAddress: '127.0.0.1' },
  })
}

/** Bundle one client module to an ESM data URL, exactly like `panel-bundle.test.js`. */
async function bundle(file) {
  const esbuild = createRequire(import.meta.url)('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client', file)],
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  })
  const code = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`)
}
