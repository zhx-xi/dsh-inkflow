/**
 * The calendar conversion (issue #180, roadmap X-28).
 *
 * The property under test is the round trip: `toAbsolute(fromAbsolute(n)) === n`
 * for every day, with **zero** tolerance. Everything else here supports that —
 * leap days (including the century rules), era boundaries, and the four kinds of
 * input a caller can get wrong (unknown era, unrepresentable date, bad table,
 * day before the first era).
 *
 * A calendar that is off by a day is worse than no calendar: it produces a
 * deadline that moves whenever the report is re-run, and nobody can see which of
 * the two conversions lied. That is why the tolerance is exact rather than ±1.
 *
 * Like the other suites this runs against the built artifact (lib/index.js).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CALENDAR,
  calendarDaysBetween,
  eraAt,
  findEra,
  fromAbsolute,
  isLeapYear,
  monthLength,
  toAbsolute,
  validateCalendarSpec,
} from '../lib/index.js'

/** A two-era table: 旧历 (`old`) ends where 新历 (`new`) begins, ten years in. */
const TWO_ERAS = {
  id: 'test-two-era',
  eras: [
    {
      id: 'old',
      // 旧历 year 1 starts 3 652 days before the shared axis origin, so 旧历 11-01-01
      // is exactly day 0 and the two eras meet without a gap.
      epochOffsetDays: -3652,
      months: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
      leap: { kind: 'gregorian', month: 2 },
    },
    {
      id: 'new',
      epochOffsetDays: 0,
      months: [30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
      leap: { kind: 'every', years: 4, month: 12 },
    },
  ],
}

function absolute(spec, date) {
  const result = toAbsolute(spec, date)
  assert.equal(result.ok, true, `toAbsolute(${JSON.stringify(date)}) must succeed: ${result.ok ? '' : result.error.message}`)
  return result.value
}

function dateOf(spec, days) {
  const result = fromAbsolute(spec, days)
  assert.equal(result.ok, true, `fromAbsolute(${days}) must succeed: ${result.ok ? '' : result.error.message}`)
  return result.value
}

test('calendar: the default table is the proleptic Gregorian year the reader knows', () => {
  assert.equal(DEFAULT_CALENDAR.eras.length, 1)
  const [era] = DEFAULT_CALENDAR.eras
  assert.equal(era.id, 'ce')
  assert.equal(era.epochOffsetDays, 0)
  assert.deepEqual([...era.months], [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31])
  assert.equal(validateCalendarSpec(DEFAULT_CALENDAR).ok, true)
  // Day 0 is the era's own year 1, month 1, day 1 — the anchor, not an arbitrary date.
  assert.deepEqual(dateOf(DEFAULT_CALENDAR, 0), { era: 'ce', y: 1, m: 1, d: 1 })
  assert.equal(absolute(DEFAULT_CALENDAR, { era: 'ce', y: 1, m: 1, d: 1 }), 0)
  // 1970-01-01 is day 719162 on this axis; that equality is the reason the axis is
  // "days since year 1" rather than a Unix timestamp with its own 1970 anchor.
  assert.equal(absolute(DEFAULT_CALENDAR, { era: 'ce', y: 1970, m: 1, d: 1 }), 719162)
})

test('calendar: A→B→A is exact for every day across a leap year and both sides of the anchor', () => {
  // Covers 2020-01-01 … well past 2028: two leap years (2020, 2024), one common
  // year that a naive `% 4` rule would get wrong only in 2100, and the day-0 anchor.
  const start = absolute(DEFAULT_CALENDAR, { era: 'ce', y: 2019, m: 1, d: 1 })
  const end = absolute(DEFAULT_CALENDAR, { era: 'ce', y: 2029, m: 1, d: 1 })
  for (let days = start; days <= end; days += 1) {
    const date = dateOf(DEFAULT_CALENDAR, days)
    assert.equal(absolute(DEFAULT_CALENDAR, date), days, `day ${days} round-tripped through ${JSON.stringify(date)}`)
  }
  // The same sweep behind the anchor, where a floor/truncation bug in the leap-year
  // arithmetic would land: years 1..3 are before any leap day exists.
  for (let days = 0; days <= 800; days += 1) {
    assert.equal(absolute(DEFAULT_CALENDAR, dateOf(DEFAULT_CALENDAR, days)), days, `day ${days}`)
  }
})

test('calendar: the leap day exists exactly in the years the rule names', () => {
  const february = (y) => monthLength(DEFAULT_CALENDAR.eras[0], y, 2)
  assert.equal(february(2023), 28)
  assert.equal(february(2024), 29, '2024 is a leap year')
  assert.equal(february(2000), 29, 'a divisible-by-400 century is a leap year')
  assert.equal(february(1900), 28, 'a plain century is not')
  assert.equal(february(2100), 28)

  const [era] = DEFAULT_CALENDAR.eras
  assert.equal(isLeapYear(era, 2024), true)
  assert.equal(isLeapYear(era, 2023), false)
  assert.equal(isLeapYear(era, 1900), false)

  // 2/29 is a real date in a leap year and no date at all in a common one.
  assert.equal(toAbsolute(DEFAULT_CALENDAR, { era: 'ce', y: 2024, m: 2, d: 29 }).ok, true)
  const refused = toAbsolute(DEFAULT_CALENDAR, { era: 'ce', y: 2023, m: 2, d: 29 })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'CALENDAR_INVALID_DATE')
  assert.match(refused.error.message, /28 days/)

  // The leap day shifts every later date in the same year by one, and nothing in the
  // year after: the property a deadline calculation depends on.
  const before = absolute(DEFAULT_CALENDAR, { era: 'ce', y: 2024, m: 2, d: 28 })
  assert.equal(absolute(DEFAULT_CALENDAR, { era: 'ce', y: 2024, m: 2, d: 29 }), before + 1)
  assert.equal(absolute(DEFAULT_CALENDAR, { era: 'ce', y: 2024, m: 3, d: 1 }), before + 2)
  assert.equal(absolute(DEFAULT_CALENDAR, { era: 'ce', y: 2023, m: 3, d: 1 }), absolute(DEFAULT_CALENDAR, { era: 'ce', y: 2023, m: 2, d: 28 }) + 1)
})

test('calendar: two eras meet at one day and the round trip holds across the boundary', () => {
  const spec = TWO_ERAS
  assert.equal(validateCalendarSpec(spec).ok, true)

  // 新历 year 1 starts at day 0, so day -1 is the last day of 旧历 year 10.
  assert.deepEqual(dateOf(spec, 0), { era: 'new', y: 1, m: 1, d: 1 })
  const lastOldDay = dateOf(spec, -1)
  assert.equal(lastOldDay.era, 'old', 'day -1 belongs to the earlier era, not to year 0 of 新历')
  assert.deepEqual(lastOldDay, { era: 'old', y: 10, m: 12, d: 31 })
  assert.equal(absolute(spec, lastOldDay), -1)

  // Sweep the boundary from both sides: 3 652 days of 旧历 plus 新历 up to its own
  // leap year (year 4, month 12), which is the other half of the table.
  for (let days = -3652; days <= 1600; days += 1) {
    const date = dateOf(spec, days)
    assert.equal(absolute(spec, date), days, `era boundary: day ${days} round-tripped through ${JSON.stringify(date)}`)
  }
  // 新历 has a `every 4 years` rule on month 12, so year 4 month 12 has 31 days and
  // year 3 does not — the configurable half of the table, exercised.
  assert.equal(monthLength(findEra(spec, 'new'), 4, 12), 31)
  assert.equal(monthLength(findEra(spec, 'new'), 3, 12), 30)
  assert.equal(isLeapYear(findEra(spec, 'old'), 4), true, 'the two eras keep their own leap rules')
  assert.equal(isLeapYear(findEra(spec, 'new'), 4), true)
})

test('calendar: eraAt picks the last era that starts at or before the day', () => {
  assert.equal(eraAt(TWO_ERAS, -3653), undefined, 'a day before every anchor has no era')
  assert.equal(eraAt(TWO_ERAS, -3652).id, 'old', 'the anchor day itself belongs to its era')
  assert.equal(eraAt(TWO_ERAS, -1).id, 'old')
  assert.equal(eraAt(TWO_ERAS, 0).id, 'new')
  assert.equal(eraAt(TWO_ERAS, 999999).id, 'new')
})

test('calendar: calendarDaysBetween is signed and counts leap days', () => {
  const between = (from, to, spec = DEFAULT_CALENDAR) => {
    const result = calendarDaysBetween(spec, from, to)
    assert.equal(result.ok, true)
    return result.value
  }
  const feb28 = { era: 'ce', y: 2024, m: 2, d: 28 }
  const mar1 = { era: 'ce', y: 2024, m: 3, d: 1 }
  assert.equal(between(feb28, mar1), 2, 'a leap year: 2/28 → 3/1 is two days')
  assert.equal(between({ era: 'ce', y: 2023, m: 2, d: 28 }, { era: 'ce', y: 2023, m: 3, d: 1 }), 1)
  assert.equal(between(mar1, feb28), -2, 'the distance is signed')
  assert.equal(between(feb28, feb28), 0)
  // Across the era boundary the distance is still the plain difference in days.
  assert.equal(between({ era: 'old', y: 10, m: 12, d: 31 }, { era: 'new', y: 1, m: 1, d: 2 }, TWO_ERAS), 2)
  // A refusal on either end is the refusal, never a number: a caller cannot average
  // a missing date into a deadline.
  const refused = calendarDaysBetween(DEFAULT_CALENDAR, { era: 'ce', y: 2023, m: 2, d: 29 }, feb28)
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'CALENDAR_INVALID_DATE')
})

test('calendar: an unknown era is CALENDAR_UNKNOWN_ERA, not a silent fallback', () => {
  const result = toAbsolute(DEFAULT_CALENDAR, { era: 'bc', y: 1, m: 1, d: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'CALENDAR_UNKNOWN_ERA')
  assert.match(result.error.message, /has no era "bc"/)
})

test('calendar: out-of-range dates are refused with the field that is wrong', () => {
  const cases = [
    [{ era: 'ce', y: 1, m: 0, d: 1 }, /months 1–12/],
    [{ era: 'ce', y: 1, m: 13, d: 1 }, /months 1–12/],
    [{ era: 'ce', y: 1, m: 1, d: 0 }, /31 days/],
    [{ era: 'ce', y: 1, m: 1, d: 32 }, /31 days/],
    [{ era: 'ce', y: 1, m: 4, d: 31 }, /30 days/],
  ]
  for (const [date, message] of cases) {
    const result = toAbsolute(DEFAULT_CALENDAR, date)
    assert.equal(result.ok, false, `${JSON.stringify(date)} must be refused`)
    assert.equal(result.error.code, 'CALENDAR_INVALID_DATE')
    assert.match(result.error.message, message)
  }
})

test('calendar: a non-integer or non-numeric field is CALENDAR_INVALID_DATE', () => {
  for (const date of [
    { era: 'ce', y: 1.5, m: 1, d: 1 },
    { era: 'ce', y: 2024, m: 2.5, d: 1 },
    { era: 'ce', y: 2024, m: 2, d: '29' },
    { era: 'ce', y: Number.NaN, m: 1, d: 1 },
    { era: 'ce', y: Number.POSITIVE_INFINITY, m: 1, d: 1 },
    { era: '', y: 2024, m: 1, d: 1 },
  ]) {
    const result = toAbsolute(DEFAULT_CALENDAR, date)
    assert.equal(result.ok, false, `${JSON.stringify(date)} must be refused`)
    assert.equal(result.error.code, 'CALENDAR_INVALID_DATE')
  }
  // `fromAbsolute` refuses a non-integer day for the same reason: half a day is not
  // a date, and rounding it silently would break the round trip.
  for (const days of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '0']) {
    const result = fromAbsolute(DEFAULT_CALENDAR, days)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'CALENDAR_INVALID_DATE')
  }
})

test('calendar: year 0 does not exist in an era — the earlier era must be named', () => {
  const result = toAbsolute(DEFAULT_CALENDAR, { era: 'ce', y: 0, m: 1, d: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'CALENDAR_INVALID_DATE')
  assert.match(result.error.message, /earlier era/)
  assert.equal(toAbsolute(DEFAULT_CALENDAR, { era: 'ce', y: -1, m: 1, d: 1 }).ok, false)
})

test('calendar: a day before the first era is CALENDAR_OUT_OF_RANGE', () => {
  const result = fromAbsolute(DEFAULT_CALENDAR, -1)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'CALENDAR_OUT_OF_RANGE')
  assert.match(result.error.message, /before the first era/)
})

test('calendar: a malformed table is refused before any conversion runs', () => {
  const bad = [
    [{ id: 'x', eras: [] }, /at least one era/],
    [{ id: '', eras: DEFAULT_CALENDAR.eras }, /non-empty id/],
    [
      { id: 'x', eras: [{ id: 'a', epochOffsetDays: 0, months: [30], leap: { kind: 'none' } }, { id: 'a', epochOffsetDays: 5, months: [30], leap: { kind: 'none' } }] },
      /twice/,
    ],
    [
      // Descending eras: the answer to "which era is this day in" would depend on order.
      { id: 'x', eras: [{ id: 'b', epochOffsetDays: 10, months: [30], leap: { kind: 'none' } }, { id: 'a', epochOffsetDays: 0, months: [30], leap: { kind: 'none' } }] },
      /must start after/,
    ],
    [{ id: 'x', eras: [{ id: 'a', epochOffsetDays: 1.5, months: [30], leap: { kind: 'none' } }] }, /integer epochOffsetDays/],
    [{ id: 'x', eras: [{ id: 'a', epochOffsetDays: 0, months: [0], leap: { kind: 'none' } }] }, /positive whole number of days/],
    [{ id: 'x', eras: [{ id: 'a', epochOffsetDays: 0, months: [], leap: { kind: 'none' } }] }, /at least one month/],
    [{ id: 'x', eras: [{ id: 'a', epochOffsetDays: 0, months: [30], leap: { kind: 'every', years: 0, month: 1 } }] }, /positive whole number of years/],
    [{ id: 'x', eras: [{ id: 'a', epochOffsetDays: 0, months: [30], leap: { kind: 'gregorian', month: 2 } }] }, /outside 1–1/],
    [{ id: 'x', eras: [{ id: 'a', epochOffsetDays: 0, months: [30], leap: { kind: 'lunar' } }] }, /unknown leap rule/],
  ]
  for (const [spec, message] of bad) {
    const result = validateCalendarSpec(spec)
    assert.equal(result.ok, false, `${JSON.stringify(spec)} must be refused`)
    assert.equal(result.error.code, 'CALENDAR_INVALID_SPEC')
    assert.match(result.error.message, message)
    // The same refusal reaches the conversions instead of running on a broken table.
    assert.equal(toAbsolute(spec, { era: 'a', y: 1, m: 1, d: 1 }).ok, false)
    assert.equal(fromAbsolute(spec, 0).ok, false)
  }
})

test('calendar: conversion is a pure function — the same input gives the same day', () => {
  const date = { era: 'ce', y: 2024, m: 2, d: 29 }
  const first = absolute(DEFAULT_CALENDAR, date)
  for (let run = 0; run < 3; run += 1) assert.equal(absolute(DEFAULT_CALENDAR, date), first)
  // Two separate tables with the same shape answer identically: nothing is cached
  // between calls, so nothing can drift after a table is edited.
  const copy = JSON.parse(JSON.stringify(DEFAULT_CALENDAR))
  assert.equal(absolute(copy, date), first)
})
