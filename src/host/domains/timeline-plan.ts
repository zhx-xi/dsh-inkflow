/**
 * The timeline model, as pure functions (issue #28): parse one event, judge the
 * three conflict rules, produce the two independent axes, render one document.
 *
 * Why the rules live here and not inside `timeline.ts`: a rebuild judges a whole
 * scan while a write judges one candidate against the current view, and both must
 * apply the *same* rules (roadmap §2.1 X-4 — "写入侧落盘前调用同一个判定"). The rules
 * therefore live here once, and each caller hands in its own view. The parser lives
 * here for the same reason: `scan()` and `parseFile()` must never disagree about
 * what a candidate means, and the write path needs the parser without importing the
 * domain module (registry → domain → domain's own tools would close a cycle).
 *
 * Nothing in this file touches the disk: no reads, no writes, no clock.
 *
 * ## The declared shapes (data-model §3.4, as the project's frontmatter reader can
 * round-trip them)
 *
 *   worldTime: 1710-03-05     — year / month / day, precision = the finest part given
 *   narrativeOrder: 7          — book-wide screen slot (a number, not a chapter-local index)
 *   chapterId: c-1             — the chapter this event is told in (`chapter` is read too)
 *   participants: [c-a, c-b]   — character ids
 *   status: unconfirmed        — the pending area (`pending` is read as the same thing)
 *
 * `worldTime` is a flat scalar rather than the `{era, year, month, day, precision}`
 * object of data-model §3.4: `frontmatter.ts` reads scalars, inline arrays and block
 * arrays only — a nested mapping would be read back as an opaque string — and the
 * `precision` of the object form is exactly "how many components the author wrote".
 *
 * ## Multi-era (issue #48, ADR-0025)
 *
 * The scalar stays; only its **interpretation** became configurable. An event names the
 * era it is written in with `era: <id>` (data-model §3.4); without one, the date is read
 * in the calendar's last era — the one the book is currently in (`calendar-book.ts`).
 * Every row then carries the date in the two forms a reader needs: the author's own text
 * (`worldTime`) and the derived absolute day (`worldAbsoluteDay`), an integer on the one
 * axis all eras share.
 *
 * Why the absolute day lives on the row instead of being computed where it is compared:
 * it is what makes two eras comparable at all, and there are five consumers (both axes,
 * the slot rule, the reversal rule, the index column). Computing it once at parse time is
 * also the only way the index and the tools can be *proven* to agree — see
 * `tests/timeline-calendar.test.js`, which asserts the stored column equals
 * `toAbsolute()` of the file's own text, row by row.
 *
 * The leap/月长 arithmetic lives in `../calendar.js` and nowhere else (ADR-0025 D1): a
 * second copy of the Gregorian rules is exactly how one date ends up a day off in one
 * place and correct in the other.
 */

import { basename, extname } from 'node:path'

import { toAbsolute } from '../calendar.js'
import type { CalendarSpec } from '../calendar.js'
import { defaultEraOf } from '../calendar-book.js'
import { intField, parseMarkdown, stringArrayField, stringField } from '../frontmatter.js'
import { rowsBucket } from './types.js'
import type { DomainEntityRef, DomainFileParse, ValidationIssue } from './types.js'

/**
 * The one table this domain owns. Declared here rather than in `timeline.ts` because
 * the domain's tools read the bucket by name too, and importing the domain module from
 * its own tools would close a runtime import cycle.
 */
export const TIMELINE_TABLE = 'timeline_events'

export type TimelineStatus = 'confirmed' | 'unconfirmed'

/**
 * One event, as the rules and both axes read it. `status` is always concrete: a
 * file that does not say `unconfirmed` is a confirmed event.
 */
export interface TimelineRow {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly worldTime?: string
  /** The era `worldTime` is written in (data-model §3.4). Absent when the file omits it. */
  readonly worldEra?: string
  /**
   * Derived: the day number `worldTime` names on the calendar's shared axis, or absent
   * when the date is unreadable (reported as `TIMELINE_TIME_INVALID`) or absent.
   */
  readonly worldAbsoluteDay?: number
  readonly narrativeOrder?: number
  readonly chapter?: string
  readonly participants?: readonly string[]
  readonly status: TimelineStatus
}

// ---------------------------------------------------------------------------
// World time
// ---------------------------------------------------------------------------

/** A parsed `worldTime`. `precision` is derived: it is how much of the date the author gave. */
export interface WorldTime {
  /** As written, so a tool can echo the author's own text back. */
  readonly raw: string
  readonly era: string
  readonly year: number
  readonly month?: number
  readonly day?: number
  readonly precision: 'year' | 'month' | 'day'
  /** `toAbsolute()` of the same date — the comparable form (ADR-0025 D3). */
  readonly absDay: number
}

/** The written shape only: `1710` / `1710-03` / `1710-03-05`, and nothing else. */
const WORLD_TIME_SHAPE = /^(\d{1,6})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/u

function writtenParts(raw: string): { year: number; month?: number; day?: number } | undefined {
  const match = WORLD_TIME_SHAPE.exec(raw)
  const yearText = match?.[1]
  if (match === null || yearText === undefined) return undefined
  const month = match[2] === undefined ? undefined : Number(match[2])
  const day = match[3] === undefined ? undefined : Number(match[3])
  return { year: Number(yearText), ...(month === undefined ? {} : { month }), ...(day === undefined ? {} : { day }) }
}

/**
 * `1710` / `1710-03` / `1710-03-05` → a comparable value; anything else → `undefined`.
 *
 * Whether the date *exists* is the calendar's answer, not this function's: a 13-month
 * era makes `1710-13-01` a real day, and `every 4 years` decides which year gets the
 * extra day. So the shape is checked here and the arithmetic is `toAbsolute()`'s.
 *
 * "Anything else" is not thrown away: a confirmed event whose `worldTime` cannot be
 * read is reported as `TIMELINE_TIME_INVALID` and stays in the index (the issue's
 * acceptance criterion: an illegal date lands in `validation_issues` and blocks
 * nothing). The write side is stricter — it owns the input and refuses the format,
 * naming the era that refused it.
 */
export function parseWorldTime(
  value: string | undefined,
  calendar: CalendarSpec,
  era?: string,
): WorldTime | undefined {
  const raw = (value ?? '').trim()
  const parts = writtenParts(raw)
  if (parts === undefined) return undefined
  // A bare date is the era the book is in; an event in an older era must say so, and an
  // unknown era id is refused by `toAbsolute` exactly like a date the era cannot express.
  const eraId = (era ?? '').trim() === '' ? defaultEraOf(calendar).id : (era ?? '').trim()
  const absolute = toAbsolute(calendar, { era: eraId, y: parts.year, m: parts.month ?? 1, d: parts.day ?? 1 })
  if (!absolute.ok) return undefined
  return {
    raw,
    era: eraId,
    year: parts.year,
    ...(parts.month === undefined ? {} : { month: parts.month }),
    ...(parts.day === undefined ? {} : { day: parts.day }),
    precision: parts.day !== undefined ? 'day' : parts.month !== undefined ? 'month' : 'year',
    absDay: absolute.value,
  }
}

/**
 * The comparable moment of an indexed/parsed row, from the fields the row already
 * carries — no calendar needed, so a row read back from the index compares exactly the
 * way it did at build time.
 */
export function momentOf(row: Pick<TimelineRow, 'worldTime' | 'worldAbsoluteDay' | 'worldEra'>): WorldTime | undefined {
  const raw = (row.worldTime ?? '').trim()
  const absDay = row.worldAbsoluteDay
  if (absDay === undefined) return undefined
  const parts = writtenParts(raw)
  if (parts === undefined) return undefined
  return {
    raw,
    era: row.worldEra ?? '',
    year: parts.year,
    ...(parts.month === undefined ? {} : { month: parts.month }),
    ...(parts.day === undefined ? {} : { day: parts.day }),
    precision: parts.day !== undefined ? 'day' : parts.month !== undefined ? 'month' : 'year',
    absDay,
  }
}

/**
 * Earlier first, **across eras too**.
 *
 * Primary key is the absolute day (the only value two eras share); the written
 * granularity breaks a tie so a year-only event still sorts before the same year's
 * January 1st — "the author stated a coarser moment, and that is the earliest moment it
 * can be". Inside one era this is a refinement of the pre-#48 key `(year, month ?? 0,
 * day ?? 0)` and returns exactly the same verdicts, which is what keeps
 * `TIMELINE_WORLD_TIME_REVERSED` and `TIMELINE_ORDER_CONFLICT` meaning what they meant.
 */
export function compareWorldTime(left: WorldTime, right: WorldTime): number {
  if (left.absDay !== right.absDay) return left.absDay < right.absDay ? -1 : 1
  const keys: ReadonlyArray<readonly [number, number]> = [
    [left.month ?? 0, right.month ?? 0],
    [left.day ?? 0, right.day ?? 0],
  ]
  for (const [a, b] of keys) {
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

// ---------------------------------------------------------------------------
// Conflict rules
// ---------------------------------------------------------------------------

export type TimelineConflictCode =
  | 'TIMELINE_TIME_MISSING'
  | 'TIMELINE_TIME_INVALID'
  | 'TIMELINE_ORDER_CONFLICT'
  | 'TIMELINE_WORLD_TIME_REVERSED'

/**
 * A finding. A pair finding names both sides: the rebuild reports `path` (one row
 * per issue, the index has no place for a second path), while the write gate must
 * also refuse the write when the candidate is the *other* member of the pair —
 * otherwise the author fixes neither and the finding only shows up after the fact.
 */
export interface TimelineConflict {
  readonly code: TimelineConflictCode
  readonly path: string
  readonly otherPath?: string
  readonly detail: string
}

/**
 * The judging rules. All of them read **declared** data only, and only `confirmed`
 * events: an event in the pending area has, by definition, no settled world time and
 * is never an ordering error.
 *
 * `narrativeOrder` is **book-wide** (data-model §3.4): it is the sequence in which the
 * reader meets the events across the whole book, not an index inside one chapter. Both
 * slot rules below therefore judge **one bucket per book**, which is also the order the
 * narrative axis is listed in — a rule that grouped by chapter would disagree with the
 * axis the reader sees.
 *
 * 1. `TIMELINE_TIME_MISSING` — a confirmed event carries no `worldTime`. It claims a
 *    settled moment but names none, so the world axis cannot place it.
 * 2. `TIMELINE_TIME_INVALID` — a confirmed event's `worldTime` is not
 *    `YYYY[-MM[-DD]]` (or is not a real date: month 13, 30 February). Reported, never
 *    blocking on a rebuild (the issue's acceptance criterion); the write side refuses
 *    the same shape because it owns the input.
 * 3. `TIMELINE_ORDER_CONFLICT` — two confirmed events declare the **same
 *    `narrativeOrder`** but different world times. One book-wide slot cannot show two
 *    different moments; that is a contradiction, not a flashback — and it is
 *    contradictory across chapters too, because the slot itself is book-wide. Two
 *    events claiming the same slot *and* the same moment are not a contradiction, so
 *    they are not reported.
 * 4. `TIMELINE_WORLD_TIME_REVERSED` — two **adjacent declared slots** (`narrativeOrder`
 *    a < b, both declared) whose world times go backwards: the later-told scene happens
 *    earlier than the one just told. Telling a story out of world order **is normal**
 *    (in-chapter flashback, cross-chapter recall), so this finding is informational:
 *    the rebuild reports it, and the write side deliberately lets it through (only
 *    `TIMELINE_ORDER_CONFLICT` / `TIMELINE_TIME_MISSING` / `TIMELINE_TIME_INVALID`
 *    refuse a write — see `blocksWrite`). Only declared slots take part: an event
 *    without `narrativeOrder` declares no position, and a pair with equal slots belongs
 *    to rule 3 instead.
 */
export function timelineConflicts(rows: readonly TimelineRow[]): TimelineConflict[] {
  const findings: TimelineConflict[] = []
  const confirmed = rows.filter((row) => row.status === 'confirmed')

  for (const row of confirmed) {
    const written = (row.worldTime ?? '').trim()
    if (written === '') {
      findings.push({
        code: 'TIMELINE_TIME_MISSING',
        path: row.path,
        detail: 'a confirmed event must carry `worldTime` (YYYY[-MM[-DD]]); mark it `status: unconfirmed` if the time is not settled yet',
      })
      continue
    }
    if (momentOf(row) === undefined) {
      findings.push({
        code: 'TIMELINE_TIME_INVALID',
        path: row.path,
        detail: `worldTime "${written}"${row.worldEra === undefined ? '' : ` (era ${row.worldEra})`} is not a real date on this book's calendar`,
      })
    }
  }

  // One bucket for the whole book, never one per chapter: `narrativeOrder` is a
  // book-wide slot, so two events told in different chapters can still claim the same
  // slot (rule 3), and a flashback told across chapters still crosses the axes
  // (rule 4). Grouping by chapter missed both.
  findings.push(...slotConflicts(confirmed), ...reversalConflicts(confirmed))

  // Deterministic order: the same book must report the same list on every rebuild.
  return findings.sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1
    if (left.code !== right.code) return left.code < right.code ? -1 : 1
    return (left.otherPath ?? '') < (right.otherPath ?? '') ? -1 : 1
  })
}

function byPath(left: TimelineRow, right: TimelineRow): number {
  if (left.path === right.path) return 0
  return left.path < right.path ? -1 : 1
}

/** Rule 3: one declared slot, two different moments. */
function slotConflicts(bucket: readonly TimelineRow[]): TimelineConflict[] {
  const slots = new Map<number, TimelineRow[]>()
  for (const row of bucket) {
    if (row.narrativeOrder === undefined) continue
    const same = slots.get(row.narrativeOrder)
    if (same === undefined) slots.set(row.narrativeOrder, [row])
    else same.push(row)
  }

  const findings: TimelineConflict[] = []
  for (const [order, sameSlot] of slots) {
    if (sameSlot.length < 2) continue
    const sorted = [...sameSlot].sort(byPath)
    const reference = sorted[0]
    const referenceTime = reference === undefined ? undefined : momentOf(reference)
    if (reference === undefined || referenceTime === undefined) continue
    for (const other of sorted.slice(1)) {
      const otherTime = momentOf(other)
      if (otherTime === undefined) continue
      if (compareWorldTime(referenceTime, otherTime) === 0) continue
      findings.push({
        code: 'TIMELINE_ORDER_CONFLICT',
        path: other.path,
        otherPath: reference.path,
        detail: `narrativeOrder ${String(order)} is claimed twice with different world times (${reference.worldTime ?? '?'} vs ${other.worldTime ?? '?'})`,
      })
    }
  }
  return findings
}

/** Rule 4: adjacent declared slots, world time going backwards. */
function reversalConflicts(bucket: readonly TimelineRow[]): TimelineConflict[] {
  const placed: Array<{ readonly row: TimelineRow; readonly order: number; readonly time: WorldTime }> = []
  for (const row of bucket) {
    const time = momentOf(row)
    if (row.narrativeOrder === undefined || time === undefined) continue
    placed.push({ row, order: row.narrativeOrder, time })
  }
  placed.sort((left, right) => (left.order === right.order ? byPath(left.row, right.row) : left.order - right.order))

  const findings: TimelineConflict[] = []
  for (let index = 1; index < placed.length; index += 1) {
    const before = placed[index - 1]
    const current = placed[index]
    if (before === undefined || current === undefined) continue
    // A shared slot is rule 3's business; it is not an ordering statement at all.
    if (before.order === current.order) continue
    if (compareWorldTime(before.time, current.time) <= 0) continue
    findings.push({
      code: 'TIMELINE_WORLD_TIME_REVERSED',
      path: current.row.path,
      otherPath: before.row.path,
      detail: `told after ${before.order} (${before.time.raw}) but set earlier (${current.time.raw})`,
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// The write side
// ---------------------------------------------------------------------------

/** A candidate is a row: the post-write view is the current rows with this one swapped in. */
export type TimelineUpsertCandidate = TimelineRow

export type TimelineUpsertCode = TimelineConflictCode | 'DUPLICATE_ID' | 'PARTICIPANT_INVALID' | 'TIMELINE_STATUS_INVALID'

export interface TimelineUpsertRejection {
  readonly code: TimelineUpsertCode
  readonly message: string
  readonly path?: string
}

export type TimelineUpsertPlan =
  | { readonly ok: true; readonly path: string; readonly replaced: boolean }
  | { readonly ok: false; readonly error: TimelineUpsertRejection }

/**
 * Which findings refuse a write.
 *
 * Only the three that make the data **self-contradictory or unreadable**: a confirmed
 * event with no usable world time (missing / invalid), and one narrative slot claimed
 * twice with two different world times. `TIMELINE_WORLD_TIME_REVERSED` is deliberately
 * **not** here (product decision): telling the story out of world order is how flashbacks
 * and recalls are written — a scene told later that happened earlier is a narrative
 * choice, not broken data. Refusing it made legal writing impossible; the rebuild still
 * reports it, so the author sees the axis crossing without being blocked.
 */
function blocksWrite(finding: TimelineConflict): boolean {
  return (
    finding.code === 'TIMELINE_ORDER_CONFLICT' ||
    finding.code === 'TIMELINE_TIME_MISSING' ||
    finding.code === 'TIMELINE_TIME_INVALID'
  )
}

/**
 * Judgement for one write, before anything lands (X-4).
 *
 * A blocking finding refuses this write when it names the candidate's path **or** has
 * the candidate as the other side of a pair: a contradiction introduced by editing one
 * of the two events must be caught even when the finding is filed against the other one.
 * A pre-existing finding between two *other* events is a rebuild diagnosis; refusing
 * every edit of the book until it is fixed would wedge work that cannot fix it.
 *
 * `TIMELINE_WORLD_TIME_REVERSED` never blocks (see `blocksWrite`): it is reported by the
 * rebuild, and the write that creates a flashback must still land.
 */
export function planTimelineUpsert(input: {
  readonly rows: readonly TimelineRow[]
  readonly candidate: TimelineUpsertCandidate
}): TimelineUpsertPlan {
  const candidate = input.candidate
  const path = candidate.path

  if (candidate.status !== 'confirmed' && candidate.status !== 'unconfirmed') {
    return {
      ok: false,
      error: {
        code: 'TIMELINE_STATUS_INVALID',
        path,
        message: `status "${String(candidate.status)}" is not confirmed|unconfirmed`,
      },
    }
  }

  // Participants are stored space-joined, so a separator inside one would read back
  // as two participants (same trap `KEYWORD_INVALID` closes for the world book).
  const invalidParticipant = (candidate.participants ?? []).find((participant) => /[\s,[\]\r\n]/u.test(participant))
  if (invalidParticipant !== undefined) {
    return {
      ok: false,
      error: {
        code: 'PARTICIPANT_INVALID',
        path,
        message: `the participant "${invalidParticipant}" contains whitespace, a comma or a bracket, which the frontmatter cannot read back as one id`,
      },
    }
  }

  const sameIdElsewhere = input.rows.find((row) => row.id === candidate.id && row.path !== path)
  if (sameIdElsewhere !== undefined) {
    return {
      ok: false,
      error: {
        code: 'DUPLICATE_ID',
        path,
        message: `id "${candidate.id}" is already used by ${sameIdElsewhere.path}; an in-place edit keeps its id, a new event needs a new one`,
      },
    }
  }

  const next: TimelineRow[] = [...input.rows.filter((row) => row.path !== path), candidate]
  const blocking = timelineConflicts(next).find(
    (finding) => blocksWrite(finding) && (finding.path === path || finding.otherPath === path),
  )
  if (blocking !== undefined) {
    // The refusal is always filed against the file being written (`path`), even when the
    // finding itself is filed against the other half of the pair: the caller has to know
    // which write was refused, and the message names the partner.
    const partner = blocking.path === path ? blocking.otherPath : blocking.path
    return {
      ok: false,
      error: {
        code: blocking.code,
        path,
        message: partner === undefined ? blocking.detail : `${blocking.detail} — the other event is ${partner}`,
      },
    }
  }

  return { ok: true, path, replaced: input.rows.some((row) => row.path === path) }
}

// ---------------------------------------------------------------------------
// The two axes
// ---------------------------------------------------------------------------

/**
 * The pending area, and the two orders that never overwrite each other.
 *
 * `worldOrder` is "when it happened", `narrativeOrder` is "when the reader learns
 * it"; both hold the same events and neither is derived from the other. `unconfirmed`
 * is a third bucket, not a sorted one: an event whose time is not settled must not
 * appear on either axis (data-model §3.4), or the pending area would silently invent
 * an order for it.
 *
 * Two "this axis cannot place it" cases, both kept rather than dropped:
 *   - a confirmed event with no readable world time is reported
 *     (`TIMELINE_TIME_MISSING` / `TIMELINE_TIME_INVALID`) and shown on the narrative
 *     axis only — the world axis never invents a position;
 *   - a confirmed event with no `narrativeOrder` declares no screen slot; it is
 *     appended after the declared ones in path order so the list still accounts for it.
 */
export interface TimelineView {
  readonly worldOrder: readonly TimelineRow[]
  readonly narrativeOrder: readonly TimelineRow[]
  readonly unconfirmed: readonly TimelineRow[]
}

export function planTimelineView(rows: readonly TimelineRow[]): TimelineView {
  const confirmed = rows.filter((row) => row.status === 'confirmed')
  const unconfirmed = rows.filter((row) => row.status !== 'confirmed').sort(byPath)

  const placed: Array<{ readonly row: TimelineRow; readonly time: WorldTime }> = []
  for (const row of confirmed) {
    const time = momentOf(row)
    if (time !== undefined) placed.push({ row, time })
  }
  placed.sort((left, right) => {
    const byTime = compareWorldTime(left.time, right.time)
    if (byTime !== 0) return byTime
    const leftOrder = left.row.narrativeOrder ?? Number.POSITIVE_INFINITY
    const rightOrder = right.row.narrativeOrder ?? Number.POSITIVE_INFINITY
    if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1
    return byPath(left.row, right.row)
  })

  const declared = confirmed.filter((row) => row.narrativeOrder !== undefined)
  const undeclared = confirmed.filter((row) => row.narrativeOrder === undefined).sort(byPath)
  declared.sort((left, right) => {
    const leftOrder = left.narrativeOrder ?? 0
    const rightOrder = right.narrativeOrder ?? 0
    if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1
    const leftChapter = left.chapter ?? ''
    const rightChapter = right.chapter ?? ''
    if (leftChapter !== rightChapter) return leftChapter < rightChapter ? -1 : 1
    return byPath(left, right)
  })

  return {
    worldOrder: placed.map((entry) => entry.row),
    narrativeOrder: [...declared, ...undeclared],
    unconfirmed,
  }
}

// ---------------------------------------------------------------------------
// One file
// ---------------------------------------------------------------------------

export interface ParsedTimeline {
  readonly row?: TimelineRow
  readonly issues: ValidationIssue[]
}

/**
 * One event file → one row, exactly as `scan()` would read it.
 *
 * `calendar` is **required** rather than defaulted (ADR-0025 D1): a silent fall back to
 * `DEFAULT_CALENDAR` is the failure mode the whole module exists to prevent — every date
 * in a book with a custom table would quietly be re-read in the Gregorian one, and
 * nothing would report it. The caller resolves it once per scan
 * (`readBookCalendar(root)`), so an unreadable table is one structured error at the
 * domain level instead of a per-file surprise.
 *
 * Non-`.md` files are skipped silently, the same policy `world.ts` applies: the
 * directory is for events, and a stray name is not a parsing error worth a line in
 * `validation_issues` on every rebuild.
 */
export function parseTimelineFile(path: string, text: string, calendar: CalendarSpec | undefined): ParsedTimeline {
  if (extname(path).toLowerCase() !== '.md') return { issues: [] }

  const parsed = parseMarkdown(text)
  const issues: ValidationIssue[] = parsed.issues.map((issue) => ({ code: 'FRONTMATTER_ISSUE', path, detail: issue }))
  const written = optionalWorldTime(stringField(parsed.data, 'worldTime'))
  const era = optionalText(stringField(parsed.data, 'era'))
  // `worldAbsoluteDay` is derived here and only here: `toAbsolute` is the one arithmetic
  // implementation (ADR-0025 D1), and storing the answer is what makes the index and the
  // tools provably read the same day (see `momentOf`).
  const moment =
    written.worldTime === undefined || calendar === undefined
      ? undefined
      : parseWorldTime(written.worldTime, calendar, era.text)

  return {
    issues,
    row: {
      id: stringField(parsed.data, 'id') ?? path,
      path,
      title: stringField(parsed.data, 'title') ?? basename(path).replace(/\.md$/u, ''),
      ...written,
      ...(era.text === undefined ? {} : { worldEra: moment?.era ?? era.text }),
      ...(moment === undefined ? {} : { worldAbsoluteDay: moment.absDay }),
      ...optionalOrder(intField(parsed.data, 'narrativeOrder')),
      ...optionalChapter(stringField(parsed.data, 'chapterId') ?? stringField(parsed.data, 'chapter')),
      participants: readParticipants(parsed.data),
      status: statusOf(stringField(parsed.data, 'status')),
    },
  }
}

function optionalWorldTime(value: string | undefined): { worldTime?: string } {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? {} : { worldTime: trimmed }
}

function optionalOrder(value: number | undefined): { narrativeOrder?: number } {
  return value === undefined ? {} : { narrativeOrder: value }
}

/** A trimmed, non-empty single-line string field (the shape `era` and `chapter` share). */
function optionalText(value: string | undefined): { text?: string } {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? {} : { text: trimmed }
}

function optionalChapter(value: string | undefined): { chapter?: string } {
  const trimmed = optionalText(value).text
  return trimmed === undefined ? {} : { chapter: trimmed }
}

function readParticipants(data: Record<string, unknown>): string[] {
  return stringArrayField(data, 'participants')
    .map((value) => value.trim())
    .filter((value) => value !== '')
}

/**
 * `unconfirmed` is the canonical pending marker; `pending` is read as the same thing
 * because data-model §3.4 spells the enum that way. Writing always uses
 * `unconfirmed` (the issue's wording), so a file never grows a second spelling.
 */
export function statusOf(value: string | undefined): TimelineStatus {
  const trimmed = (value ?? '').trim().toLowerCase()
  return trimmed === 'unconfirmed' || trimmed === 'pending' ? 'unconfirmed' : 'confirmed'
}

/** The event's projection row (X-1: this domain adds rows, never columns). */
export function timelineEntity(row: TimelineRow): DomainEntityRef {
  return {
    kind: 'timeline',
    id: row.id,
    path: row.path,
    title: row.title,
    orderIndex: row.narrativeOrder,
    status: row.status,
  }
}

/**
 * One file as the seam's `parseFile()` sees it — the body of `timelineDomain.parseFile`.
 *
 * Exported so the write path can run the *same* parse without importing the domain
 * module (which imports the tools back: a runtime cycle). `timeline.ts` delegates to
 * this function, so there is one implementation, not two (X-4).
 */
export function timelineFileParse(path: string, text: string, calendar: CalendarSpec | undefined): DomainFileParse {
  const parsed = parseTimelineFile(path, text, calendar)
  const row = parsed.row
  return {
    path,
    rows: row === undefined ? [] : [rowsBucket(TIMELINE_TABLE, [row])],
    entity: row === undefined ? undefined : timelineEntity(row),
    issues: parsed.issues,
  }
}

/**
 * The body of `timelineDomain.validate()`: every conflict rule over one view.
 *
 * Two callers, two nets, one judge:
 *   - the rebuild passes no `candidatePath` and reports **every** finding, informational
 *     ones included (`TIMELINE_WORLD_TIME_REVERSED` is how the author learns that a scene
 *     is told out of world order);
 *   - the write gate passes the path being written, and only `blocksWrite()` findings
 *     naming **either** side of the pair are returned — a contradiction introduced by
 *     editing one of the two events must be caught even though the finding is filed
 *     against the other one, while a flashback must still be writable.
 */
export function timelineValidate(rows: readonly TimelineRow[], candidatePath?: string): ValidationIssue[] {
  const conflicts = timelineConflicts(rows)
  const relevant =
    candidatePath === undefined
      ? conflicts
      : conflicts.filter(
          (finding) => blocksWrite(finding) && (finding.path === candidatePath || finding.otherPath === candidatePath),
        )
  return relevant.map((finding) => ({ code: finding.code, path: finding.path, detail: finding.detail }))
}
