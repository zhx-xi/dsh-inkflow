/**
 * Issue #48 / roadmap X-28 — the multi-era calendar, wired into the index and both axes.
 *
 * The arithmetic itself is `tests/calendar.test.js` (#180). What is asserted **here** is
 * the wiring, and only the wiring, because that is the part nothing else can catch:
 *
 *   1. **the derived column is the same answer** — every `timeline_events.world_absolute_day`
 *      equals `toAbsolute()` of that file's own `worldTime`, row by row. Two places
 *      computing a day number is exactly how a deadline ends up one day off, and no
 *      single-sided test can see it.
 *   2. **it is deterministic** — building the same book twice yields identical columns.
 *      A derived value that carries anything from the run (order, clock) would still pass
 *      check 1 in one build and drift in the next.
 *   3. **an invalid table is refused, never defaulted** — a `calendar` that does not
 *      validate has to be named; falling back to `DEFAULT_CALENDAR` would silently
 *      re-date every event in the book.
 *   4. **erasure boundaries sort correctly** — 旧历 year 900 is *after* 新历 year 1 in this
 *      fixture, so the world axis has to interleave the two eras. A string sort cannot.
 *   5. **an edited table marks the index stale** — `inkflow.json` is not a content
 *      directory, so without the stored fingerprint a calendar edit would leave every
 *      derived day describing the old table.
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
  DEFAULT_CALENDAR,
  buildIndex,
  checkIndexFreshness,
  domainTools,
  listTimelineEvents,
  planTimelineView,
  readBookCalendar,
  toAbsolute,
  validateCalendarSpec,
  writeBookCalendar,
} from '../lib/index.js'

const DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']

/**
 * Two eras that share one absolute axis: 人间 is the older numbering and starts at day
 * −3652, 天界 starts at day 0. Their month shapes differ on purpose (12 vs 13 months) —
 * a table where both eras look identical would not prove the table is being read at all.
 */
const TWO_ERAS = {
  id: 'mortal-and-celestial',
  eras: [
    {
      id: 'mortal',
      epochOffsetDays: -3652,
      months: [30, 29, 30, 29, 30, 29, 30, 29, 30, 29, 30, 29],
      leap: { kind: 'none' },
    },
    {
      id: 'celestial',
      epochOffsetDays: 0,
      months: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31, 30],
      leap: { kind: 'every', years: 4, month: 2 },
    },
  ],
}

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-calendar-'))
}

function scaffold(root, meta) {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(
    join(root, 'inkflow.json'),
    `${JSON.stringify(meta ?? { schemaVersion: 1, title: '历法测试' }, null, 2)}\n`,
    'utf8',
  )
}

function writeEvent(root, relativePath, frontmatter, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, `---\n${frontmatter.join('\n')}\n---\n\n${body}`, 'utf8')
}

function callTool(name, args) {
  const tool = domainTools().find((candidate) => candidate.name === name)
  assert.ok(tool, `${name} must be registered by a domain module`)
  return tool.execute(args, { signal: new AbortController().signal, callId: 'calendar-test' })
}

/** The stored columns, straight from the database (not through any reader). */
function storedRows(root) {
  const db = new DatabaseSync(join(root, 'index', 'inkflow.db'), { readOnly: true })
  try {
    return db
      .prepare('SELECT path, world_time, world_era, world_absolute_day FROM timeline_events ORDER BY path')
      .all()
      .map((row) => ({ ...row }))
  } finally {
    db.close()
  }
}

test('timeline: every stored absolute day equals toAbsolute() of that file\'s own worldTime', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    writeEvent(root, 'timeline/甲.md', ['id: t-a', 'title: 甲', 'worldTime: 1710-01-05'])
    writeEvent(root, 'timeline/乙.md', ['id: t-b', 'title: 乙', 'worldTime: 1710-02'])
    writeEvent(root, 'timeline/丙.md', ['id: t-c', 'title: 丙', 'worldTime: 1710'])
    // A date the default table rejects: it must stay a row with NO day number rather than
    // crash or be guessed at (data-model I-17 reports it, nothing blocks).
    writeEvent(root, 'timeline/丁.md', ['id: t-d', 'title: 丁', 'worldTime: 1710-02-30'])
    writeEvent(root, 'timeline/戊.md', ['id: t-e', 'title: 戊', 'worldTime: 春天'])
    await buildIndex(root)

    const calendar = readBookCalendar(root)
    assert.equal(calendar.ok, true)
    if (!calendar.ok) return
    assert.equal(calendar.value.source, 'default', 'a book without a `calendar` key reads the default table')

    for (const row of storedRows(root)) {
      const era = row.world_era ?? 'ce'
      const parts = String(row.world_time ?? '').split('-').map(Number)
      const [y, m, d] = [parts[0], parts[1] ?? 1, parts[2] ?? 1]
      const expected = toAbsolute(calendar.value.spec, { era, y, m, d })
      if (expected.ok) {
        assert.equal(
          row.world_absolute_day,
          expected.value,
          `${String(row.path)}: the index must store the same day toAbsolute() computes`,
        )
      } else {
        // Not a date on this table (`1710-02-30`) or not a date at all (`春天`): no column
        // value, and the reason is a finding, not a crash.
        assert.equal(row.world_absolute_day, null, `${String(row.path)}: an unreadable date stores no day number`)
      }
    }
    // Precision does not change the day it names: `1710`, `1710-02` and the 5th all anchor
    // on the first moment of what the author wrote.
    const byPath = new Map(storedRows(root).map((row) => [String(row.path), row.world_absolute_day]))
    assert.equal(byPath.get('timeline/丙.md'), byPath.get('timeline/甲.md') === null ? null : toAbsoluteDays(calendar.value.spec, 1710, 1, 1))
    assert.equal(byPath.get('timeline/乙.md'), toAbsoluteDays(calendar.value.spec, 1710, 2, 1))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function toAbsoluteDays(spec, y, m, d) {
  const result = toAbsolute(spec, { era: spec.eras[spec.eras.length - 1].id, y, m, d })
  assert.equal(result.ok, true, `expected ${String(y)}-${String(m)}-${String(d)} to be a real date`)
  return result.ok ? result.value : -1
}

test('timeline: the derived column is deterministic across two builds of the same book', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    writeEvent(root, 'timeline/甲.md', ['id: t-a', 'title: 甲', 'worldTime: 1710-01-05', 'narrativeOrder: 2'])
    writeEvent(root, 'timeline/乙.md', ['id: t-b', 'title: 乙', 'worldTime: 1709-12-01', 'narrativeOrder: 1'])
    await buildIndex(root)
    const first = storedRows(root)
    await buildIndex(root)
    assert.deepEqual(storedRows(root), first, 'a derived value must not depend on the run')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('calendar: an invalid table is refused by name and never replaced by the default', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    // Two eras out of order: the validator's job, and the case a hand edit produces.
    scaffold(root, {
      schemaVersion: 1,
      title: '坏历法',
      calendar: {
        id: 'broken',
        eras: [
          { id: 'new', epochOffsetDays: 0, months: [31], leap: { kind: 'none' } },
          { id: 'old', epochOffsetDays: -100, months: [31], leap: { kind: 'none' } },
        ],
      },
    })
    writeEvent(root, 'timeline/甲.md', ['id: t-a', 'title: 甲', 'worldTime: 5-01-01'])

    const calendar = readBookCalendar(root)
    assert.equal(calendar.ok, false, 'a table that is present but invalid is an error, not a default')
    if (calendar.ok) return
    assert.equal(calendar.error.code, 'CALENDAR_INVALID_SPEC')
    assert.match(calendar.error.message, /ascend/u)

    // The rebuild still runs (the index is a cache, the rest of the book is fine), the
    // cause is reported once against the file that holds the mistake, and no day number
    // is invented from a table nobody could read.
    const build = await buildIndex(root)
    const issue = build.issues.find((candidate) => candidate.path === 'inkflow.json')
    assert.ok(issue, 'the unreadable calendar must be reported, naming inkflow.json')
    assert.equal(issue.code, 'TIMELINE_TIME_INVALID')
    assert.equal(storedRows(root)[0].world_absolute_day, null)

    // `inkflow_calendar_set` refuses the same table instead of writing it.
    const refused = await callTool('inkflow_calendar_set', { projectRoot: root, calendar: { id: 'x', eras: [] }, confirm: true })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'CALENDAR_INVALID_SPEC')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('calendar: a two-era table orders the world axis across eras, not by string', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    assert.equal(validateCalendarSpec(TWO_ERAS).ok, true, 'the fixture table must itself be legal')
    scaffold(root, { schemaVersion: 1, title: '两纪元', calendar: TWO_ERAS })
    // 人间 year 1 starts at day −3652, so 人间 year 5 is *before* 天界 year 1 — while its
    // year number (0005) is larger than 0001. Any sort over the author's text, or over
    // (year, month, day), puts these three in the wrong order; the absolute day does not.
    writeEvent(root, 'timeline/人间早.md', ['id: t-mortal-early', 'title: 人间早年', 'era: mortal', 'worldTime: 0005-01-01'])
    writeEvent(root, 'timeline/天界.md', ['id: t-celestial', 'title: 天界纪年', 'era: celestial', 'worldTime: 0001-01-01'])
    writeEvent(root, 'timeline/人间晚.md', ['id: t-mortal-late', 'title: 人间晚年', 'era: mortal', 'worldTime: 0900-03-01'])
    await buildIndex(root)

    const rows = listTimelineEvents(root)
    assert.ok(rows, 'the timeline table must be readable')
    if (rows === undefined) return
    const view = planTimelineView(rows)
    assert.deepEqual(
      view.worldOrder.map((row) => row.id),
      ['t-mortal-early', 't-celestial', 't-mortal-late'],
      'the world axis is the absolute day, so an earlier era can sit before a later one',
    )
    // A bare `worldTime` with no `era` is read in the newest era — the one the book is in.
    const bare = await callTool('inkflow_calendar_get', { projectRoot: root, date: '0002-01-01' })
    assert.equal(bare.ok, true)
    assert.equal(bare.era, 'celestial')

    // Sorting the same rows by (year, month, day) — the pre-#48 comparison — puts them in
    // a different order; that divergence is the bug this fixture exists to catch.
    const byWrittenYear = [...rows].sort((left, right) => String(left.worldTime).localeCompare(String(right.worldTime)))
    assert.notDeepEqual(
      view.worldOrder.map((row) => row.id),
      byWrittenYear.map((row) => row.id),
      'if these two orders agreed, the fixture would not prove anything',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('calendar: writing the table persists it in inkflow.json, refills the index and marks edits stale', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    writeEvent(root, 'timeline/甲.md', ['id: t-a', 'title: 甲', 'era: celestial', 'worldTime: 0001-01-01'])
    await buildIndex(root)
    // The default table has one era (`ce`), so `celestial` is an era it does not have: no
    // day number is invented, and the era the author wrote is kept so the finding can quote
    // it back.
    assert.equal(storedRows(root)[0].world_era, 'celestial')
    assert.equal(storedRows(root)[0].world_absolute_day, null)
    assert.equal(checkIndexFreshness(root).state, 'fresh')

    // Without `confirm` nothing is written.
    const refused = await callTool('inkflow_calendar_set', { projectRoot: root, calendar: TWO_ERAS })
    assert.equal(refused.ok, false)
    assert.equal(refused.requiresConfirmation, true)
    assert.equal(readBookCalendar(root).ok, true)
    assert.equal(JSON.parse(readFileSync(join(root, 'inkflow.json'), 'utf8')).calendar, undefined)

    const written = await callTool('inkflow_calendar_set', { projectRoot: root, calendar: TWO_ERAS, confirm: true })
    assert.equal(written.ok, true)
    assert.equal(written.indexRebuilt, true, 'every absolute day is a function of this table')
    const meta = JSON.parse(readFileSync(join(root, 'inkflow.json'), 'utf8'))
    assert.deepEqual(meta.calendar, TWO_ERAS, 'the table is persisted in the book, not in plugin settings')
    assert.equal(meta.title, '历法测试', 'the rest of inkflow.json survives the write')
    assert.equal(existsSync(join(root, 'inkflow.json.tmp')), false, 'no temp file is left behind')

    // After the rebuild the row carries the era it now belongs to.
    assert.equal(storedRows(root)[0].world_era, 'celestial')
    assert.equal(checkIndexFreshness(root).state, 'fresh')

    // A hand edit of the table (not through the tool) must still make the index stale —
    // otherwise the derived days would keep describing the old table forever.
    writeFileSync(
      join(root, 'inkflow.json'),
      `${JSON.stringify({ ...meta, calendar: { ...TWO_ERAS, id: 'renamed' } }, null, 2)}\n`,
      'utf8',
    )
    const stale = checkIndexFreshness(root)
    assert.equal(stale.state, 'stale')
    assert.ok(stale.reasons.some((reason) => reason.includes('calendar')), `expected a calendar reason, got ${stale.reasons.join(' | ')}`)

    // Resetting to the default is an explicit act: `calendar` omitted from the argument.
    const reset = await callTool('inkflow_calendar_set', { projectRoot: root, confirm: true })
    assert.equal(reset.ok, true)
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'inkflow.json'), 'utf8')).calendar, DEFAULT_CALENDAR)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('calendar: an unknown era in a file is an invalid date, reported and never silently re-read', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    writeEvent(root, 'timeline/甲.md', ['id: t-a', 'title: 甲', 'era: 天界', 'worldTime: 1710-01-01'])
    const build = await buildIndex(root)
    const issue = build.issues.find((candidate) => candidate.code === 'TIMELINE_TIME_INVALID')
    assert.ok(issue, 'an era the table does not have makes the date unreadable under this book')
    assert.equal(issue.path, 'timeline/甲.md')
    assert.equal(storedRows(root)[0].world_absolute_day, null)
    // The era the author wrote is still stored, so the report can quote it back.
    assert.equal(storedRows(root)[0].world_era, '天界')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('calendar: writeBookCalendar refuses a table that does not validate, and writes nothing', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    const before = readFileSync(join(root, 'inkflow.json'), 'utf8')
    const written = writeBookCalendar(root, { id: 'x', eras: [] })
    assert.equal(written.ok, false)
    assert.equal(readFileSync(join(root, 'inkflow.json'), 'utf8'), before, 'a refused table never touches the file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
