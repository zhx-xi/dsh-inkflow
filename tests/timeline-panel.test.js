/**
 * The 时间线 pane's view model (`src/client/timeline-model.ts`) and its tab.
 *
 * The page is a Client half: it reads `GET /timeline` (the same payload
 * `inkflow_timeline_list` answers) and writes `POST /timeline/upsert`. Nothing here may
 * re-derive a rule the Host already decided, so what is testable is the VIEW:
 *
 *   1. **两条轴各自成列，顺序是 Host 的** — the payload's order is kept (the Host sorts by the
 *      calendar's absolute day and by the book-wide slot); the model never re-sorts one axis by
 *      the other. The one exception is documented and asserted: an event whose date could not be
 *      read is moved to the END of the world column and labelled, because "cannot be placed" is
 *      not a position.
 *   2. **倒叙看得出来** — the narrative column marks a row whose world day is earlier than the
 *      row told before it. The data carries both numbers; the pane only says so.
 *   3. **待确认区单列** — `unconfirmed` never enters either axis, and the head says how many.
 *   4. **冲突逐条 + 空则明说** — code, file and the Host's one-sentence reason; zero findings
 *      reads 「没有冲突」 instead of an empty gap.
 *   5. **空态指向怎么加第一条** — the card names the page's own form and the tool.
 *   6. **表单把 Host 的码原样显示** — the draft → body mapping and the refusal wording, with no
 *      second validation in the pane.
 *
 * The last block is the bundle check: a page that never reaches `lib/client.js` is a page DSH
 * cannot show, and the tab count is the one number that says a row was actually added.
 *
 * Run: pnpm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
const require = createRequire(import.meta.url)

/** Bundle one client module to an ESM data URL and import it (no DOM needed). */
async function load(entry) {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client', entry)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    write: false,
    logLevel: 'silent',
  })
  const code = Buffer.from(result.outputFiles[0].text, 'utf8').toString('base64')
  return import(`data:text/javascript;base64,${code}`)
}

const loadTimelineModel = () => load('timeline-model.ts')

/** One event as `GET /timeline` carries it (the tool's own field names). */
function event(id, extra = {}) {
  return {
    id,
    title: id,
    file: `timeline/${id}.md`,
    worldTime: null,
    era: null,
    worldAbsoluteDay: null,
    narrativeOrder: null,
    chapter: null,
    participants: [],
    status: 'confirmed',
    ...extra,
  }
}

/**
 * A book whose two orders deliberately disagree: told 1 → 2 → 3, happening
 * 1709-12 → 1710-02 → 1710-01. The third row is a recall of an earlier scene.
 */
function crossingPayload(extra = {}) {
  const early = event('己卯屠村', { worldTime: '1709-12-01', worldAbsoluteDay: 5, narrativeOrder: 1, chapter: 'c-3' })
  const middle = event('丙辰夜袭', { worldTime: '1710-02-01', worldAbsoluteDay: 70, narrativeOrder: 2, chapter: 'c-2' })
  const recall = event('甲申立约', { worldTime: '1710-01-05', worldAbsoluteDay: 40, narrativeOrder: 3, chapter: 'c-1' })
  return {
    axis: 'both',
    counts: { world: 3, narrative: 3, unconfirmed: 0 },
    worldOrder: [early, middle, recall],
    narrativeOrder: [early, middle, recall],
    conflicts: [{ code: 'TIMELINE_WORLD_TIME_REVERSED', path: 'timeline/甲申立约.md', otherPath: 'timeline/丙辰夜袭.md', detail: 'told after 2 (1710-02-01) but set earlier (1710-01-05)' }],
    calendar: { id: 'common', source: 'default', defaultEra: 'ce', eras: [{ id: 'ce', epochOffsetDays: 0, months: [31], leap: { kind: 'none' } }] },
    ...extra,
  }
}

function ok(value) {
  return { ok: true, status: 200, value }
}

test('timeline-model: the world column keeps the Host order and labels an unreadable date', async () => {
  const model = await loadTimelineModel()
  const readable = event('已定', { worldTime: '1710-01-01', worldAbsoluteDay: 10, narrativeOrder: 1 })
  const broken = event('坏日期', { worldTime: '1710-13-01', worldAbsoluteDay: null, narrativeOrder: 2 })
  // Deliberately handed in "wrong": the Host would not sort it this way, and the model must not
  // re-sort by the other axis. Only the unplaceable row is moved — to the END.
  const view = model.readTimelineView(
    ok({ counts: { world: 1, narrative: 2, unconfirmed: 0 }, worldOrder: [broken, readable], narrativeOrder: [broken, readable], conflicts: [] }),
  )
  assert.deepEqual(
    view.world.map((row) => row.event.id),
    ['已定', '坏日期'],
    'the readable row keeps its place; the unplaceable one goes last',
  )
  assert.equal(view.world[1].unreadable, true)
  assert.equal(view.world[1].when, '读不出日期')
  assert.equal(view.world[0].unreadable, false)
  assert.equal(view.world[0].when, '1710-01-01')
  assert.equal(view.counts.world, 1, 'the counts are the Host numbers, not a recount of the array')
})

test('timeline-model: the narrative column shows the slot, and a recall is visible', async () => {
  const model = await loadTimelineModel()
  const view = model.readTimelineView(ok(crossingPayload()))

  assert.deepEqual(
    view.narrative.map((row) => row.slot),
    ['#1', '#2', '#3'],
    'the slot is the book-wide narrative order, printed as the row\'s handle',
  )
  assert.deepEqual(
    view.narrative.map((row) => row.flashback),
    [false, false, true],
    'the third scene is told after a later moment: that is the crossing, and it is marked',
  )
  // The world column is NOT marked: it never goes backwards, and pretending it does would make
  // a flashback look like bad data.
  assert.deepEqual(view.world.map((row) => row.flashback), [false, false, false])
  assert.equal(model.describeRow(view.narrative[2]), '1710-01-05 · #3 · c-1', 'time, slot and chapter in one line')
})

test('timeline-model: an event with no narrative slot says so instead of printing #null', async () => {
  const model = await loadTimelineModel()
  const placed = event('有槽位', { worldTime: '1710-01-01', worldAbsoluteDay: 10, narrativeOrder: 1 })
  const loose = event('无槽位', { worldTime: '1710-01-02', worldAbsoluteDay: 11 })
  const view = model.readTimelineView(ok({ counts: { world: 2, narrative: 2, unconfirmed: 0 }, narrativeOrder: [placed, loose], conflicts: [] }))

  assert.equal(view.narrative[1].slot, null)
  assert.equal(view.narrative[1].undeclared, true)
  assert.equal(model.describeRow(view.narrative[1]), '1710-01-02 · 未定叙事位', 'the row says the slot is not declared')
})

test('timeline-model: the pending area is its own bucket and the head counts it', async () => {
  const model = await loadTimelineModel()
  const pending = event('待定的事', { status: 'unconfirmed', worldTime: '1710-01-01', worldAbsoluteDay: 10 })
  const view = model.readTimelineView(
    ok({ counts: { world: 1, narrative: 1, unconfirmed: 1 }, worldOrder: [event('已定', { worldTime: '1710-01-01', worldAbsoluteDay: 10 })], narrativeOrder: [event('已定', { worldTime: '1710-01-01', worldAbsoluteDay: 10 })], pending: [pending], conflicts: [] }),
  )
  assert.deepEqual(view.pending.map((row) => row.id), ['待定的事'])
  assert.equal(view.world.length, 1, 'an unconfirmed event never enters the world axis')
  assert.equal(view.narrative.length, 1, 'nor the narrative axis')
  assert.equal(view.pendingNote, '待定 1 条')

  const none = model.readTimelineView(ok({ counts: { world: 1, narrative: 1, unconfirmed: 0 }, conflicts: [] }))
  assert.equal(none.pendingNote, '没有待定', 'zero is stated, not left blank')
})

test('timeline-model: conflicts are listed one by one, and zero reads 没有冲突', async () => {
  const model = await loadTimelineModel()
  const view = model.readTimelineView(ok(crossingPayload()))
  assert.equal(view.conflicts.length, 1)
  const line = model.describeConflict(view.conflicts[0])
  assert.match(line, /TIMELINE_WORLD_TIME_REVERSED/u, 'the code travels verbatim: it is what the tool reports')
  assert.match(line, /timeline\/甲申立约\.md/u, 'the file names the event to open')
  assert.match(line, /set earlier/u, 'the Host\'s own sentence says why, with no second explanation')

  const clean = model.readTimelineView(ok({ counts: { world: 0, narrative: 0, unconfirmed: 0 }, conflicts: [] }))
  assert.equal(clean.conflictsNote, '没有冲突')
})

test('timeline-model: the empty card says how to add the first event, in the real tool', async () => {
  const model = await loadTimelineModel()
  const empty = model.readTimelineView(ok({ counts: { world: 0, narrative: 0, unconfirmed: 0 }, conflicts: [] }))
  assert.ok(empty.empty, 'a book with no events gets a card, not two blank columns')
  assert.equal(empty.empty.title, '这本书还没有时间线事件')
  assert.match(empty.empty.body, /inkflow_timeline_upsert/u, 'the card names the tool that writes one')
  assert.match(empty.empty.body, /表单/u, 'and the page\'s own form, which is the shorter path')

  const filled = model.readTimelineView(ok(crossingPayload()))
  assert.equal(filled.empty, null, 'a book with events gets no card')
})

test('timeline-model: an unreadable index and a refused request are different cards', async () => {
  const model = await loadTimelineModel()
  const noIndex = model.readTimelineView({ ok: false, status: 500, error: { code: 'INDEX_UNAVAILABLE', message: 'gone' } })
  assert.equal(noIndex.indexAvailable, false)
  assert.equal(noIndex.error, null, 'the index card says what to do; an error line would say it twice')
  assert.equal(noIndex.empty, null)
  assert.equal(model.TIMELINE_EMPTY['index-unavailable'].title, '索引不可用')

  const refused = model.readTimelineView({ ok: false, status: 409, error: { code: 'PROJECT_BUSY', message: 'another session holds the lock' } })
  assert.equal(refused.indexAvailable, true)
  assert.match(refused.error, /PROJECT_BUSY/u)
  assert.match(refused.error, /another session holds the lock/u, 'the Host\'s own words survive')
})

test('timeline-model: the form maps a draft to the tool\'s own arguments', async () => {
  const model = await loadTimelineModel()
  const row = event('甲申立约', {
    worldTime: '1710-01-05',
    era: 'ce',
    worldAbsoluteDay: 40,
    narrativeOrder: 3,
    chapter: 'c-1',
    participants: ['c-a', 'c-b'],
    status: 'confirmed',
  })

  const draft = model.draftOf(row)
  assert.deepEqual(
    { title: draft.title, worldTime: draft.worldTime, era: draft.era, order: draft.narrativeOrder, chapter: draft.chapter, participants: draft.participants, status: draft.status, slug: draft.slug },
    { title: '甲申立约', worldTime: '1710-01-05', era: 'ce', order: '3', chapter: 'c-1', participants: 'c-a, c-b', status: 'confirmed', slug: '甲申立约' },
    'an existing event loads its own values, participants as one comma-separated line',
  )
  assert.deepEqual(model.upsertBodyOf(draft), {
    title: '甲申立约',
    slug: '甲申立约',
    worldTime: '1710-01-05',
    era: 'ce',
    narrativeOrder: 3,
    chapter: 'c-1',
    participants: ['c-a', 'c-b'],
    status: 'confirmed',
    confirm: true,
  }, 'the body is the tool\'s argument names, and the pane always confirms what the author typed')

  const blank = model.draftOf(null)
  assert.equal(blank.slug, '', 'a new event derives its file from the title')
  const minimal = model.upsertBodyOf({ ...blank, title: '新事件', worldTime: '', era: '', narrativeOrder: '', chapter: '', participants: '', status: 'unconfirmed' })
  assert.deepEqual(minimal, { title: '新事件', status: 'unconfirmed', confirm: true }, 'empty inputs are absent, not empty strings')
  assert.equal(model.slugOfFile('timeline/甲申立约.md'), '甲申立约', 'a row names its file; the slug is that name')
})

test('timeline-model: a refusal is shown with the Host\'s own code', async () => {
  const model = await loadTimelineModel()
  const refused = model.describeUpsert({ ok: false, status: 409, error: { code: 'TIMELINE_ORDER_CONFLICT', message: 'narrativeOrder 2 is claimed twice with different world times' } })
  assert.match(refused, /TIMELINE_ORDER_CONFLICT/u, 'the code stays verbatim: the pane does not re-word a rule')
  assert.match(refused, /claimed twice/u)
  assert.equal(model.describeUpsert(null), null, 'nothing to say before a save happened')

  const written = model.describeUpsert({
    ok: true,
    status: 200,
    value: { path: 'timeline/甲申立约.md', created: true, replaced: false, indexRebuilt: true },
  })
  assert.match(written, /timeline\/甲申立约\.md/u)
  assert.match(written, /新建/u, 'created and replaced are worded differently: the author just overwrote something or did not')
  assert.match(written, /索引/u, 'and the reply says whether the cache was rebuilt')
})

test('the panel ships the 时间线 tab and its page', async () => {
  const panel = await load('panel-model.ts')
  const ids = panel.PANEL_TABS.map((tab) => tab.id)
  assert.equal(ids.length, 14, 'the tab row grew by exactly one row')
  assert.ok(ids.includes('timeline'), 'the row exists')
  const row = panel.PANEL_TABS.find((tab) => tab.id === 'timeline')
  assert.equal(row.label, '时间线')
  assert.equal(row.available, true, 'a live tab: the page is in the bundle below')

  if (!existsSync(BUNDLE)) throw new Error('lib/client.js is missing: run `pnpm run build` first')
  const text = readFileSync(BUNDLE, 'utf8')
  for (const marker of ['时间线', '读不出日期', '倒叙', '/timeline/upsert', 'inkflow_timeline_upsert', '没有冲突']) {
    assert.ok(text.includes(marker), `lib/client.js is missing the 时间线 wording: ${marker}`)
  }
})
