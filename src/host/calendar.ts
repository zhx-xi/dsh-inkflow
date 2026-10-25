/**
 * Calendars as pure arithmetic (issue #180, roadmap X-28).
 *
 * WHY A DAY COUNT AND NOT A DATE STRING: `timeline/` stores `worldTime` as a flat
 * scalar (`YYYY-MM-DD`, data-model §3.4), which sorts as a string only while a book
 * has one calendar. The moment a book has two eras (旧历/新历, 天界/人间) the same
 * string means two different days, and any comparison has to know the table. Doing
 * that comparison in two places — once in the index build, once in the panel — is
 * how a deadline ends up one day off in a report nobody can reproduce. So the
 * conversion lives here, once, and everything that needs to order dates converts to
 * an **absolute day number** first.
 *
 * WHY THIS MODULE IS PURE: no `fs`, no project, no lock, no `Date`. A calendar is a
 * table plus arithmetic; keeping it free of clock and disk is what makes the one
 * property that matters testable at all — `toAbsolute(fromAbsolute(n)) === n` for
 * every `n`, with no tolerance, over leap days and era boundaries too.
 *
 * WHY YEARS ARE 1-BASED AND NEVER ≤ 0: an era is anchored at *its* year 1 month 1
 * day 1 (`epochOffsetDays`). "before the era" is expressed by an **earlier era with
 * a negative offset**, not by year 0, so every absolute day maps back into exactly
 * one era and the round trip stays exact. Rejecting `y < 1` makes that a refusal
 * instead of a silent reinterpretation (a caller who wanted 公元前 should name the
 * earlier era).
 *
 * WHY ERAS MUST ASCEND: `fromAbsolute` picks the last era whose anchor is ≤ the day,
 * and an unordered list would make that answer depend on file order. The validator
 * says so instead of sorting silently, so a typo shows up at the first call rather
 * than as a different date in one book.
 */

/** Codes a calendar call can be refused with (never free text). */
export type CalendarErrorCode =
  | 'CALENDAR_INVALID_SPEC'
  | 'CALENDAR_UNKNOWN_ERA'
  | 'CALENDAR_INVALID_DATE'
  | 'CALENDAR_OUT_OF_RANGE'

export interface CalendarError {
  readonly code: CalendarErrorCode
  readonly message: string
}

/**
 * The one result shape (`io.ts` convention): a pure function never throws, so a
 * caller cannot crash the Host with a date it did not expect.
 */
export type CalendarResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: CalendarError }

/**
 * When a year gains a day, and in which month.
 *
 * `month` is 1-based and only sensible where a leap rule exists; `none` has no month
 * at all, so a spec cannot say "leap in some month" without naming the rule. Three
 * shapes are enough for the calendars a novel actually uses: a calendar with no leap
 * rule (360-day 太阴历), a simple `every N years` rule (四年一闰), and the Gregorian
 * rule that the author's own world time is usually quoted in.
 */
export type LeapRule =
  | { readonly kind: 'none' }
  | { readonly kind: 'every'; readonly years: number; readonly month: number }
  | { readonly kind: 'gregorian'; readonly month: number }

/**
 * One era: where it starts on the absolute day axis, and how its years are shaped.
 *
 * `months` is the common-year month lengths; the leap day comes on top of the month
 * `leap.month` names. Two eras may use completely different shapes — that is the
 * point of a table (天界十二个月 vs 人间十三个月 is a setting, not a code change).
 */
export interface EraSpec {
  readonly id: string
  /** Absolute day of this era's year 1, month 1, day 1 (may be negative). */
  readonly epochOffsetDays: number
  readonly months: readonly number[]
  readonly leap: LeapRule
}

export interface CalendarSpec {
  readonly id: string
  /** Ascending by `epochOffsetDays`; each era runs up to the next one's anchor. */
  readonly eras: readonly EraSpec[]
}

/** A point in one era's own numbering, exactly as a writer would say it. */
export interface CalendarDate {
  readonly era: string
  readonly y: number
  readonly m: number
  readonly d: number
}

/**
 * The default table: one Gregorian era anchored at absolute day 0.
 *
 * It exists so a caller with a single-calendar book (every book today) has something
 * to pass, and so the tests have a reference implementation of the proleptic
 * Gregorian rules to compare against.
 */
export const DEFAULT_CALENDAR: CalendarSpec = {
  id: 'common',
  eras: [
    {
      id: 'ce',
      epochOffsetDays: 0,
      months: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
      leap: { kind: 'gregorian', month: 2 },
    },
  ],
}

function ok<T>(value: T): CalendarResult<T> {
  return { ok: true, value }
}

function fail(code: CalendarErrorCode, message: string): CalendarResult<never> {
  return { ok: false, error: { code, message } }
}

/**
 * Check a table before it is used.
 *
 * Every call validates: the table is plain data a caller can build by hand (that is
 * what "configurable" means), and a wrong month length would otherwise show up as a
 * date that is silently off by a day. The check is O(months), which is nothing next
 * to the parse that produced the call.
 */
export function validateCalendarSpec(spec: CalendarSpec): CalendarResult<CalendarSpec> {
  if (typeof spec !== 'object' || spec === null) return fail('CALENDAR_INVALID_SPEC', 'a calendar spec is required')
  if (typeof spec.id !== 'string' || spec.id.trim() === '') {
    return fail('CALENDAR_INVALID_SPEC', 'a calendar spec needs a non-empty id')
  }
  const eras = spec.eras
  if (!Array.isArray(eras) || eras.length === 0) {
    return fail('CALENDAR_INVALID_SPEC', `calendar "${spec.id}" needs at least one era`)
  }
  const seen = new Set<string>()
  let previousOffset: number | undefined
  for (const era of eras) {
    if (typeof era !== 'object' || era === null) return fail('CALENDAR_INVALID_SPEC', 'every era must be an object')
    if (typeof era.id !== 'string' || era.id.trim() === '') {
      return fail('CALENDAR_INVALID_SPEC', 'every era needs a non-empty id')
    }
    if (seen.has(era.id)) return fail('CALENDAR_INVALID_SPEC', `calendar "${spec.id}" lists era "${era.id}" twice`)
    seen.add(era.id)
    if (!Number.isSafeInteger(era.epochOffsetDays)) {
      return fail('CALENDAR_INVALID_SPEC', `era "${era.id}" needs an integer epochOffsetDays (got ${String(era.epochOffsetDays)})`)
    }
    if (previousOffset !== undefined && era.epochOffsetDays <= previousOffset) {
      return fail('CALENDAR_INVALID_SPEC', `era "${era.id}" must start after the era before it (eras ascend by epochOffsetDays)`)
    }
    previousOffset = era.epochOffsetDays
    if (!Array.isArray(era.months) || era.months.length === 0) {
      return fail('CALENDAR_INVALID_SPEC', `era "${era.id}" needs at least one month`)
    }
    for (const length of era.months) {
      if (!Number.isSafeInteger(length) || length < 1) {
        return fail('CALENDAR_INVALID_SPEC', `era "${era.id}" has a month that is not a positive whole number of days`)
      }
    }
    const leap = era.leap
    if (typeof leap !== 'object' || leap === null) return fail('CALENDAR_INVALID_SPEC', `era "${era.id}" needs a leap rule`)
    if (leap.kind !== 'none' && leap.kind !== 'every' && leap.kind !== 'gregorian') {
      return fail('CALENDAR_INVALID_SPEC', `era "${era.id}" has an unknown leap rule`)
    }
    if (leap.kind === 'every' && (!Number.isSafeInteger(leap.years) || leap.years < 1)) {
      return fail('CALENDAR_INVALID_SPEC', `era "${era.id}" needs a positive whole number of years between leap years`)
    }
    if (leap.kind !== 'none') {
      if (!Number.isSafeInteger(leap.month) || leap.month < 1 || leap.month > era.months.length) {
        return fail(
          'CALENDAR_INVALID_SPEC',
          `era "${era.id}" adds its leap day to a month outside 1–${era.months.length}`,
        )
      }
    }
  }
  return ok(spec)
}

/** The era with this id, or `undefined`. */
export function findEra(spec: CalendarSpec, id: string): EraSpec | undefined {
  return spec.eras.find((era) => era.id === id)
}

/**
 * The era a given absolute day belongs to: the last one that starts at or before it.
 *
 * Assumes a validated, ascending spec — an unordered table is refused by
 * `validateCalendarSpec` before any conversion runs.
 */
export function eraAt(spec: CalendarSpec, days: number): EraSpec | undefined {
  let match: EraSpec | undefined
  for (const era of spec.eras) {
    if (era.epochOffsetDays > days) break
    match = era
  }
  return match
}

/** Whether this era's year `y` carries the extra day. */
export function isLeapYear(era: EraSpec, y: number): boolean {
  const rule = era.leap
  if (rule.kind === 'none') return false
  if (rule.kind === 'every') return y % rule.years === 0
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
}

/**
 * Length of month `m` in year `y`, or `undefined` when the month does not exist.
 *
 * `undefined` rather than `0` on purpose: a caller asking for month 13 must be able
 * to tell "this calendar has no such month" from "this month has no days".
 */
export function monthLength(era: EraSpec, y: number, m: number): number | undefined {
  const base = era.months[m - 1]
  if (base === undefined) return undefined
  const leapMonth = era.leap.kind === 'none' ? undefined : era.leap.month
  return leapMonth === m && isLeapYear(era, y) ? base + 1 : base
}

/** Days in a common year (the leap day is added on top by `isLeapYear`). */
function baseYearDays(era: EraSpec): number {
  return era.months.reduce((total, length) => total + length, 0)
}

/** Leap days counted in years `1 … y-1` (i.e. everything before year `y` starts). */
function leapDaysBefore(era: EraSpec, y: number): number {
  const passed = y - 1
  const rule = era.leap
  if (rule.kind === 'none') return 0
  if (rule.kind === 'every') return Math.floor(passed / rule.years)
  // Gregorian, in closed form: the count of leaps in `passed` years is the count of
  // multiples of 4, minus centuries, plus the centuries divisible by 400.
  return Math.floor(passed / 4) - Math.floor(passed / 100) + Math.floor(passed / 400)
}

/** Days from this era's year 1 month 1 day 1 to year `y` month 1 day 1. */
function daysBeforeYear(era: EraSpec, y: number): number {
  return baseYearDays(era) * (y - 1) + leapDaysBefore(era, y)
}

/** Days from month 1 day 1 to month `m` day 1, inside year `y` (leap day included). */
function daysBeforeMonth(era: EraSpec, y: number, m: number): number {
  let total = 0
  for (let month = 1; month < m; month += 1) total += monthLength(era, y, month) ?? 0
  return total
}

/**
 * One calendar date → the absolute day number it names.
 *
 * Refusals are structural, not best-effort: an unknown era, a year below 1, a month
 * this era does not have, and a day the month does not have are four different
 * codes, because each one means a different mistake (wrong table vs. wrong date).
 */
export function toAbsolute(spec: CalendarSpec, date: CalendarDate): CalendarResult<number> {
  const valid = validateCalendarSpec(spec)
  if (!valid.ok) return valid
  if (typeof date !== 'object' || date === null) return fail('CALENDAR_INVALID_DATE', 'a {era, y, m, d} date is required')
  if (typeof date.era !== 'string' || date.era.trim() === '') {
    return fail('CALENDAR_INVALID_DATE', 'the date must name an era')
  }
  const era = findEra(spec, date.era)
  if (era === undefined) {
    return fail('CALENDAR_UNKNOWN_ERA', `calendar "${spec.id}" has no era "${date.era}" (eras: ${spec.eras.map((entry) => entry.id).join(', ')})`)
  }
  for (const [field, value] of [
    ['y', date.y],
    ['m', date.m],
    ['d', date.d],
  ] as const) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      return fail('CALENDAR_INVALID_DATE', `era "${date.era}" needs a whole number for ${field} (got ${String(value)})`)
    }
  }
  if (date.y < 1) {
    return fail(
      'CALENDAR_INVALID_DATE',
      `era "${date.era}" starts at year 1; a date before the era belongs to an earlier era (got year ${date.y})`,
    )
  }
  const monthCount = era.months.length
  if (date.m < 1 || date.m > monthCount) {
    return fail('CALENDAR_INVALID_DATE', `era "${date.era}" has months 1–${monthCount} (got ${date.m})`)
  }
  const length = monthLength(era, date.y, date.m) ?? 0
  if (date.d < 1 || date.d > length) {
    return fail(
      'CALENDAR_INVALID_DATE',
      `era "${date.era}" year ${date.y} month ${date.m} has ${length} days (got day ${date.d})`,
    )
  }
  const days = era.epochOffsetDays + daysBeforeYear(era, date.y) + daysBeforeMonth(era, date.y, date.m) + (date.d - 1)
  if (!Number.isSafeInteger(days)) {
    return fail('CALENDAR_OUT_OF_RANGE', `that date is beyond the safely representable day axis (${String(days)})`)
  }
  return ok(days)
}

/**
 * An absolute day number → the date it names, in the era that covers it.
 *
 * The year is found by bracketing rather than by an approximate division: an average
 * year length is exactly the sort of estimate that is off by one right next to a
 * leap day, which is the case authors care about. The bracket is exact because every
 * year is at least as long as a common year, so `floor(offset / common) + 1` bounds
 * the answer from above.
 */
export function fromAbsolute(spec: CalendarSpec, days: number): CalendarResult<CalendarDate> {
  const valid = validateCalendarSpec(spec)
  if (!valid.ok) return valid
  if (typeof days !== 'number' || !Number.isSafeInteger(days)) {
    return fail('CALENDAR_INVALID_DATE', `the absolute day must be a whole number (got ${String(days)})`)
  }
  const era = eraAt(spec, days)
  if (era === undefined) {
    const first = spec.eras[0]?.id ?? '—'
    return fail('CALENDAR_OUT_OF_RANGE', `day ${days} is before the first era of calendar "${spec.id}" (${first})`)
  }
  const offset = days - era.epochOffsetDays
  const base = baseYearDays(era)
  let low = 1
  let high = Math.floor(offset / base) + 1
  while (low < high) {
    const middle = low + Math.floor((high - low + 1) / 2)
    if (daysBeforeYear(era, middle) <= offset) low = middle
    else high = middle - 1
  }
  const y = low
  let rest = offset - daysBeforeYear(era, y)
  let m = 1
  for (;;) {
    const length = monthLength(era, y, m)
    if (length === undefined) {
      // Only reachable if the spec changed shape between validation and here; the
      // validator already refuses month lists shorter than a month index.
      return fail('CALENDAR_INVALID_SPEC', `era "${era.id}" ran out of months while reading day ${days}`)
    }
    if (rest < length) return ok({ era: era.id, y, m, d: rest + 1 })
    rest -= length
    m += 1
  }
}

/**
 * Signed day distance `to - from`, both named in the calendar's own numbering.
 *
 * Why not `toAbsolute(to) - toAbsolute(from)` at the call site: a caller that does
 * that has to unwrap two results and decide what to do when one of them is a
 * refusal, and the third copy of that unwrapping is where the calendar quietly
 * starts having two behaviours.
 */
export function calendarDaysBetween(
  spec: CalendarSpec,
  from: CalendarDate,
  to: CalendarDate,
): CalendarResult<number> {
  const start = toAbsolute(spec, from)
  if (!start.ok) return start
  const end = toAbsolute(spec, to)
  if (!end.ok) return end
  return ok(end.value - start.value)
}
