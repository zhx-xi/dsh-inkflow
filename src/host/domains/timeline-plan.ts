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
 * Multi-era calendars (the `era` field and cross-era comparison) are #48's scope.
 */

import { basename, extname } from 'node:path'

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
  readonly year: number
  readonly month?: number
  readonly day?: number
  readonly precision: 'year' | 'month' | 'day'
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29
  return MONTH_DAYS[month - 1] ?? 0
}

/**
 * `1710` / `1710-03` / `1710-03-05` → a comparable value; anything else → `undefined`.
 *
 * "Anything else" is not thrown away: a confirmed event whose `worldTime` cannot be
 * read is reported as `TIMELINE_TIME_INVALID` and stays in the index (the issue's
 * acceptance criterion: an illegal date lands in `validation_issues` and blocks
 * nothing). The write side is stricter — it owns the input and refuses the format.
 */
export function parseWorldTime(value: string | undefined): WorldTime | undefined {
  const raw = (value ?? '').trim()
  const match = /^(\d{1,6})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/u.exec(raw)
  const yearText = match?.[1]
  if (match === null || yearText === undefined) return undefined
  const year = Number(yearText)
  const month = match[2] === undefined ? undefined : Number(match[2])
  const day = match[3] === undefined ? undefined : Number(match[3])
  if (month !== undefined && (month < 1 || month > 12)) return undefined
  if (day !== undefined && (day < 1 || day > daysInMonth(year, month ?? 1))) return undefined
  return {
    raw,
    year,
    ...(month === undefined ? {} : { month }),
    ...(day === undefined ? {} : { day }),
    precision: day !== undefined ? 'day' : month !== undefined ? 'month' : 'year',
  }
}

/**
 * Earlier first. A year-only event sorts before a dated one in the same year: the
 * author stated a coarser moment, and that is the earliest moment it can be.
 */
export function compareWorldTime(left: WorldTime, right: WorldTime): number {
  const keys: ReadonlyArray<readonly [number, number]> = [
    [left.year, right.year],
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
 * 1. `TIMELINE_TIME_MISSING` — a confirmed event carries no `worldTime`. It claims a
 *    settled moment but names none, so the world axis cannot place it.
 * 2. `TIMELINE_TIME_INVALID` — a confirmed event's `worldTime` is not
 *    `YYYY[-MM[-DD]]` (or is not a real date: month 13, 30 February). Reported, never
 *    blocking on a rebuild (the issue's acceptance criterion); the write side refuses
 *    the same shape because it owns the input.
 * 3. `TIMELINE_ORDER_CONFLICT` — two confirmed events **in one chapter** declare the
 *    **same `narrativeOrder`** but different world times. One screen slot cannot show
 *    two different moments; that is a contradiction, not a flashback. (`chapter` is
 *    the grouping key because a narrative slot is read as "position in this chapter";
 *    events without a chapter form one group of their own.) Two events claiming the
 *    same slot *and* the same moment are not a contradiction — only warnings of
 *    "what?" would come out of it — so they are not reported.
 * 4. `TIMELINE_WORLD_TIME_REVERSED` — within one chapter, two **adjacent declared
 *    slots** (`narrativeOrder` a < b, both declared) whose world times go backwards:
 *    the later-told scene happens earlier than the one just told. A flashback chapter
 *    is legal, so this is deliberately **same-chapter only** and only over declared
 *    slots: an event without `narrativeOrder` declares no position and is never part
 *    of a reversal; a pair with equal slots belongs to rule 3 instead. An author who
 *    does mean an in-chapter flashback resolves it by giving the scene its own
 *    chapter, or by correcting the world time — the finding names both events.
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
    if (parseWorldTime(written) === undefined) {
      findings.push({
        code: 'TIMELINE_TIME_INVALID',
        path: row.path,
        detail: `worldTime "${written}" is not a real YYYY[-MM[-DD]] date`,
      })
    }
  }

  const chapters = new Map<string, TimelineRow[]>()
  for (const row of confirmed) {
    const key = row.chapter ?? ''
    const bucket = chapters.get(key)
    if (bucket === undefined) chapters.set(key, [row])
    else bucket.push(row)
  }

  for (const bucket of chapters.values()) {
    findings.push(...slotConflicts(bucket), ...reversalConflicts(bucket))
  }

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
    const referenceTime = parseWorldTime(reference?.worldTime)
    if (reference === undefined || referenceTime === undefined) continue
    for (const other of sorted.slice(1)) {
      const otherTime = parseWorldTime(other.worldTime)
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
    const time = parseWorldTime(row.worldTime)
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
      detail: `told after ${before.order} (${before.time.raw}) but set earlier (${current.time.raw}) in the same chapter`,
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
 * Judgement for one write, before anything lands (X-4).
 *
 * A finding blocks this write when it names the candidate's path **or** has the
 * candidate as the other side of a pair: a reversal introduced by editing the later
 * event must be caught even when the finding is filed against the earlier one.
 * A pre-existing finding between two *other* events is a rebuild diagnosis; refusing
 * every edit of the book until it is fixed would wedge work that cannot fix it.
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
  const blocking = timelineConflicts(next).find((finding) => finding.path === path || finding.otherPath === path)
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
    const time = parseWorldTime(row.worldTime)
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
 * Non-`.md` files are skipped silently, the same policy `world.ts` applies: the
 * directory is for events, and a stray name is not a parsing error worth a line in
 * `validation_issues` on every rebuild.
 */
export function parseTimelineFile(path: string, text: string): ParsedTimeline {
  if (extname(path).toLowerCase() !== '.md') return { issues: [] }

  const parsed = parseMarkdown(text)
  const issues: ValidationIssue[] = parsed.issues.map((issue) => ({ code: 'FRONTMATTER_ISSUE', path, detail: issue }))

  return {
    issues,
    row: {
      id: stringField(parsed.data, 'id') ?? path,
      path,
      title: stringField(parsed.data, 'title') ?? basename(path).replace(/\.md$/u, ''),
      ...optionalWorldTime(stringField(parsed.data, 'worldTime')),
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

function optionalChapter(value: string | undefined): { chapter?: string } {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? {} : { chapter: trimmed }
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
export function timelineFileParse(path: string, text: string): DomainFileParse {
  const parsed = parseTimelineFile(path, text)
  const row = parsed.row
  return {
    path,
    rows: row === undefined ? [] : [rowsBucket(TIMELINE_TABLE, [row])],
    entity: row === undefined ? undefined : timelineEntity(row),
    issues: parsed.issues,
  }
}

/**
 * The body of `timelineDomain.validate()`: every conflict rule over one view, narrowed
 * to one path when the caller passes a write candidate.
 *
 * With `candidatePath` the caller treats every returned issue as blocking, so a pair
 * finding is kept when **either** side is the candidate — a reversal introduced by
 * editing the later event must be caught even though the finding is filed against the
 * earlier one. A finding between two other events is a rebuild diagnosis; refusing an
 * unrelated edit until it is fixed would wedge work that cannot fix it.
 */
export function timelineValidate(rows: readonly TimelineRow[], candidatePath?: string): ValidationIssue[] {
  const conflicts = timelineConflicts(rows)
  const relevant =
    candidatePath === undefined
      ? conflicts
      : conflicts.filter((finding) => finding.path === candidatePath || finding.otherPath === candidatePath)
  return relevant.map((finding) => ({ code: finding.code, path: finding.path, detail: finding.detail }))
}
