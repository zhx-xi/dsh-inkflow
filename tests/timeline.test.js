/**
 * Issue #28 — the timeline domain: two independent axes, the pending area and the write
 * surface. The conflict rules have their own suite (`timeline-conflicts.test.js`).
 *
 * Why each group exists:
 *   - the axes: the whole point of the dual timeline is that "when it happened" and
 *     "when the reader learns it" are two orders over the same events. A writer that
 *     sorted one by the other would pass any single-axis test, so every axis assertion
 *     below checks both, on the same fixture, and asserts they differ.
 *   - the pending area: `status: unconfirmed` must never be ordered. If it slipped into
 *     either axis the author would read an invented order as canon.
 *   - the projection and the confirmation gate: an event has to be reachable through
 *     `entities` + `searchEntities` (#29/#30 read through them), and a write must not
 *     land before the user has seen the path.
 *
 * They run against the BUILT artifacts (lib/index.js), like every other suite.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  INDEX_SCHEMA_VERSION,
  buildIndex,
  domainTools,
  listTimelineEvents,
  planTimelineView,
  searchEntities,
} from '../lib/index.js'

const DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-timeline-'))
}

function scaffold(root) {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '时间线测试' }, null, 2)}\n`, 'utf8')
}

function writeEvent(root, relativePath, frontmatter, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, `---\n${frontmatter.join('\n')}\n---\n\n${body}`, 'utf8')
}

function callTool(name, args) {
  const tool = domainTools().find((candidate) => candidate.name === name)
  assert.ok(tool, `${name} must be registered by a domain module`)
  return tool.execute(args, { signal: new AbortController().signal, callId: 'timeline-test' })
}

/** Three events whose world order and narrative order deliberately disagree. */
function sampleBook(root) {
  scaffold(root)
  writeEvent(root, 'timeline/丙辰夜袭.md', [
    'id: t-3',
    'title: 丙辰夜袭',
    'worldTime: 1710-02-01',
    'narrativeOrder: 2',
    'chapterId: c-2',
    'participants: [c-a, c-b]',
  ])
  writeEvent(root, 'timeline/甲申立约.md', [
    'id: t-1',
    'title: 甲申立约',
    'worldTime: 1710-01-05',
    'narrativeOrder: 3',
    'chapterId: c-1',
  ])
  writeEvent(root, 'timeline/己卯屠村.md', ['id: t-2', 'title: 己卯屠村', 'worldTime: 1709-12-01', 'narrativeOrder: 1', 'chapterId: c-3'])
}

function ids(entries) {
  return (entries ?? []).map((entry) => entry.id)
}

// ---------------------------------------------------------------------------
// 1. The two axes
// ---------------------------------------------------------------------------

test('timeline: the world axis and the narrative axis sort the same events differently', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)

    const world = await callTool('inkflow_timeline_list', { projectRoot: root, axis: 'world' })
    assert.equal(world.ok, true)
    // When it happened: 1709-12 → 1710-01 → 1710-02.
    assert.deepEqual(ids(world.worldOrder), ['t-2', 't-1', 't-3'])
    assert.equal(world.narrativeOrder, undefined, 'axis: world must not answer the other axis')

    const narrative = await callTool('inkflow_timeline_list', { projectRoot: root, axis: 'narrative' })
    assert.equal(narrative.ok, true)
    // When the reader learns it: 1 → 2 → 3.
    assert.deepEqual(ids(narrative.narrativeOrder), ['t-2', 't-3', 't-1'])
    assert.equal(narrative.worldOrder, undefined, 'axis: narrative must not answer the other axis')

    // The two orders genuinely differ — otherwise a single sort would pass the test above.
    assert.notDeepEqual(ids(world.worldOrder), ids(narrative.narrativeOrder))

    const both = await callTool('inkflow_timeline_list', { projectRoot: root })
    assert.deepEqual(ids(both.worldOrder), ['t-2', 't-1', 't-3'])
    assert.deepEqual(ids(both.narrativeOrder), ['t-2', 't-3', 't-1'])
    // The fixture tells the tale out of world order on purpose. Under the book-wide slot
    // axis that is exactly one reported reversal — and only that: crossing the two axes
    // is a narrative choice, so it is reported by the rebuild and never refused.
    assert.deepEqual(
      both.conflicts.map((conflict) => conflict.code),
      ['TIMELINE_WORLD_TIME_REVERSED'],
    )
    assert.equal(both.axes, undefined, 'the payload never invents an `axes` field')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('timeline: sorting either axis never mutates the rows the other one reads', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)

    const rows = listTimelineEvents(root)
    assert.ok(rows, 'the index answers')
    const before = rows.map((row) => row.id)

    const first = planTimelineView(rows)
    const second = planTimelineView(rows)
    assert.deepEqual(ids(first.worldOrder), ids(second.worldOrder))
    assert.deepEqual(ids(first.narrativeOrder), ids(second.narrativeOrder))
    // The two axes disagree on this fixture; that is the property, not an accident.
    assert.notDeepEqual(ids(first.worldOrder), ids(first.narrativeOrder))
    // Planning is pure: the input rows keep their own order.
    assert.deepEqual(rows.map((row) => row.id), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. The pending area
// ---------------------------------------------------------------------------

test('timeline: an unconfirmed event is only ever in the pending area', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    // A tentative time: it must not be ordered, not even as a "maybe first" slot.
    writeEvent(root, 'timeline/无头案.md', [
      'id: t-p',
      'title: 无头案',
      'worldTime: 1710-01-20',
      'narrativeOrder: 9',
      'chapterId: c-4',
      'status: unconfirmed',
    ])
    // `pending` is data-model §3.4's spelling of the same state; it must read the same.
    writeEvent(root, 'timeline/存疑线索.md', ['id: t-q', 'title: 存疑线索', 'status: pending'])

    const hidden = await callTool('inkflow_timeline_list', { projectRoot: root })
    assert.equal(hidden.counts.unconfirmed, 2)
    assert.equal(hidden.pending, undefined, 'the pending area is opt-in')
    assert.ok(!ids(hidden.worldOrder).includes('t-p'))
    assert.ok(!ids(hidden.narrativeOrder).includes('t-p'))
    assert.deepEqual(ids(hidden.worldOrder), ['t-2', 't-1', 't-3'])

    const shown = await callTool('inkflow_timeline_list', { projectRoot: root, includeUnconfirmed: true })
    // The pending area is not an order: it is listed by path so two builds agree.
    assert.deepEqual(ids(shown.pending), ['t-q', 't-p'])
    assert.ok(!ids(shown.worldOrder).includes('t-p'))
    assert.ok(!ids(shown.narrativeOrder).includes('t-p'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. Create, read back through the projection, delete
// ---------------------------------------------------------------------------

test('timeline: an event can be created and deleted, and reaches entities + search', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)

    const created = await callTool('inkflow_timeline_upsert', {
      projectRoot: root,
      title: '白鹤门灭门',
      worldTime: '1711-03-05',
      narrativeOrder: 11,
      chapter: 'c-2',
      participants: ['c-a', 'c-b'],
      body: '一夜之间，山门尽毁。',
      confirm: true,
    })
    assert.equal(created.ok, true, JSON.stringify(created.error ?? {}))
    assert.equal(created.created, true)
    assert.equal(created.path, 'timeline/白鹤门灭门.md')
    assert.equal(created.indexRebuilt, true)

    // The file is the truth: the fields are in it, `chapterId` per data-model §3.4.
    const raw = readFileSync(join(root, 'timeline/白鹤门灭门.md'), 'utf8')
    assert.match(raw, /worldTime: 1711-03-05/)
    assert.match(raw, /narrativeOrder: 11/)
    assert.match(raw, /chapterId: c-2/)
    assert.match(raw, /participants: \[c-a, c-b\]/)
    assert.match(raw, /status: confirmed/)
    assert.match(raw, /一夜之间，山门尽毁。/)

    const rows = listTimelineEvents(root)
    assert.deepEqual(rows.map((row) => ({ id: row.id, time: row.worldTime, participants: row.participants })), [
      { id: created.id, time: '1711-03-05', participants: ['c-a', 'c-b'] },
    ])

    const db = new DatabaseSync(join(root, 'index', 'inkflow.db'), { readOnly: true })
    try {
      const projection = { ...db.prepare("SELECT kind, title, order_index, status FROM entities WHERE kind = 'timeline'").get() }
      assert.deepEqual(projection, { kind: 'timeline', title: '白鹤门灭门', order_index: 11, status: 'confirmed' })
      const stored = { ...db.prepare('SELECT world_time, narrative_order, chapter, participants, status FROM timeline_events').get() }
      assert.deepEqual(stored, {
        world_time: '1711-03-05',
        narrative_order: 11,
        chapter: 'c-2',
        participants: 'c-a c-b',
        status: 'confirmed',
      })
    } finally {
      db.close()
    }

    const hits = searchEntities(root, '白鹤门灭门')
    assert.ok(hits, 'the index answers')
    assert.deepEqual(
      hits.filter((hit) => hit.kind === 'timeline').map((hit) => hit.id),
      [created.id],
    )

    // Deletion is a file deletion: the index is a cache and follows on the next build.
    rmSync(join(root, 'timeline/白鹤门灭门.md'))
    await buildIndex(root)
    assert.deepEqual(listTimelineEvents(root), [])
    const after = new DatabaseSync(join(root, 'index', 'inkflow.db'), { readOnly: true })
    try {
      assert.equal(after.prepare("SELECT COUNT(*) AS n FROM entities WHERE kind = 'timeline'").get().n, 0)
    } finally {
      after.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('timeline: an edit patches the file, keeping the author keys and replacing the participant list', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    const created = await callTool('inkflow_timeline_upsert', {
      projectRoot: root,
      title: '白鹤门灭门',
      worldTime: '1711-03-05',
      participants: ['c-a'],
      confirm: true,
    })
    assert.equal(created.ok, true)

    // The author adds a key this domain does not model, plus prose.
    const path = join(root, 'timeline/白鹤门灭门.md')
    const original = readFileSync(path, 'utf8').replace('status: confirmed', 'status: confirmed\nnotes: 手写备注')
    writeFileSync(path, `${original}\n手写正文。\n`, 'utf8')
    await buildIndex(root)

    const edited = await callTool('inkflow_timeline_upsert', {
      projectRoot: root,
      title: '白鹤门灭门',
      worldTime: '1711-03-05',
      participants: ['c-b', 'c-c'],
      confirm: true,
    })
    assert.equal(edited.ok, true, JSON.stringify(edited.error ?? {}))
    assert.equal(edited.created, false)

    const text = readFileSync(path, 'utf8')
    assert.match(text, /notes: 手写备注/, 'a key the domain does not model survives an edit')
    assert.match(text, /participants: \[c-b, c-c\]/, 'the inline list is replaced, not appended')
    assert.doesNotMatch(text, /participants: \[c-a\]/)
    assert.match(text, /手写正文。/, 'the body is not rewritten when the call does not ask for it')
    assert.equal(edited.id, created.id, 'an edit keeps the id')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('timeline: a write without confirm reports the path and writes nothing', async () => {  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    const preview = await callTool('inkflow_timeline_upsert', {
      projectRoot: root,
      title: '两派签约',
      worldTime: '1710-01-01',
    })
    assert.equal(preview.ok, false)
    assert.equal(preview.requiresConfirmation, true)
    assert.equal(preview.willWrite, 'timeline/两派签约.md')
    assert.equal(preview.error.code, 'TIMELINE_UPSERT_REQUIRES_CONFIRMATION')
    assert.equal(existsSync(join(root, 'timeline/两派签约.md')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. The table itself
// ---------------------------------------------------------------------------

test('timeline: the schema bump carries timeline_events, and every row has a path', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)
    assert.ok(INDEX_SCHEMA_VERSION >= 4, 'the timeline table is a schema bump, not an ALTER')

    const db = new DatabaseSync(join(root, 'index', 'inkflow.db'), { readOnly: true })
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, INDEX_SCHEMA_VERSION)
      const rows = db.prepare('SELECT id, path FROM timeline_events ORDER BY id').all()
      assert.deepEqual(
        rows.map((row) => ({ ...row })),
        [
          { id: 't-1', path: 'timeline/甲申立约.md' },
          { id: 't-2', path: 'timeline/己卯屠村.md' },
          { id: 't-3', path: 'timeline/丙辰夜袭.md' },
        ],
      )
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
