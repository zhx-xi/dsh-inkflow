/**
 * Pure view model for the 时间线 pane.
 *
 * **The pane decides nothing the Host already decided.** Two axes, a pending area and the
 * conflict findings are computed by `domains/timeline-view.ts` (which the two tools share), and
 * the one rule that could drift — "which order is this row in?" — is answered there, once. So
 * this file does not sort, does not re-derive a slot and does not re-judge a conflict: it turns
 * the wire into rows a component can render, and it words the few things the Host has no reason
 * to word (a section heading, the 「读不出日期」 label, the empty card).
 *
 * Three consequences that are worth stating, because each one is easy to "fix" wrongly later:
 *
 *   * **the payload order is kept.** The world column arrives sorted by the calendar's absolute
 *     day and the narrative column by the book-wide slot, and those are two *different* orders
 *     over the same events. Re-sorting one by the other would erase the very thing this pane
 *     exists to show (a scene told later and set earlier);
 *   * **the one reordering is documented**: an event whose `worldAbsoluteDay` is missing cannot
 *     be placed in time, so it is moved to the END of the world column and labelled. Dropping it
 *     would hide an event; leaving it in place would claim a position it does not have;
 *   * **a bare number is never printed for a missing value.** No `#null`, no `—` where a slot
 *     should be: a row without a declared slot says 「未定叙事位」.
 *
 * No IO, no React, no `@deepseek-ai/*` import (ADR-0008 D4): `node --test` has no DOM, so the
 * grouping, the wording and the draft mapping are all tested here directly.
 */

import type { InternalResult } from './internal.js'

/** The two states the pending area is made of (the Host writes only these spellings). */
export type TimelineStatus = 'confirmed' | 'unconfirmed'

/** One event exactly as `GET /timeline` carries it (`eventJson` in the Host). */
export interface TimelineEvent {
  id: string
  title: string
  /** Project-relative file (`timeline/<slug>.md`): the row's evidence and its edit handle. */
  file: string
  worldTime: string | null
  /** The era `worldTime` is written in, or null when the file omits it. */
  era: string | null
  /** The derived day on the calendar's shared axis, or null when the date cannot be read. */
  worldAbsoluteDay: number | null
  /** Book-wide screen slot: when the reader learns this event. */
  narrativeOrder: number | null
  chapter: string | null
  participants: string[]
  status: TimelineStatus
}

/** One finding, verbatim: the pane shows the code, the file and the Host's sentence. */
export interface TimelineConflictLine {
  code: string
  path: string
  otherPath?: string
  detail: string
}

/** One era as the form hints it (`GET /timeline` → `calendar.eras`). */
export interface TimelineEra {
  id: string
  epochOffsetDays?: number
}

export interface TimelineCalendar {
  id: string
  source: string
  defaultEra: string | null
  eras: TimelineEra[]
}

/** `GET /inkflow/internal/timeline` → `value`, as far as the pane reads it. */
export interface TimelineValue {
  axis?: string
  counts?: { world?: number; narrative?: number; unconfirmed?: number }
  worldOrder?: TimelineEvent[]
  narrativeOrder?: TimelineEvent[]
  pending?: TimelineEvent[]
  conflicts?: TimelineConflictLine[]
  calendar?: TimelineCalendar
  indexRebuilt?: boolean
  indexState?: string
}

/** One row of an axis: the event plus the three labels the column needs. */
export interface TimelineAxisRow {
  event: TimelineEvent
  /** `1710-01-05` (plus the era when the file names one), or 「读不出日期」. */
  when: string
  /** The slot label (a `#` and the book-wide number), or null when the event declares none. */
  slot: string | null
  /** The event declares no `narrativeOrder`: the Host appends it after the declared ones. */
  undeclared: boolean
  /** The world time cannot be placed on this book's calendar. */
  unreadable: boolean
  /** Told after a later moment — a flashback or a recall. Never an error. */
  flashback: boolean
}

/** The whole pane, in one object. `null` means "not loaded yet" wherever it appears. */
export interface TimelineView {
  /** The request's own failure, already worded (`PROJECT_BUSY`, a refusal…) — plus its code. */
  error: string | null
  /** `false` = the derived index could not answer. NOT "this book has no events". */
  indexAvailable: boolean
  counts: { world: number; narrative: number; unconfirmed: number }
  world: TimelineAxisRow[]
  narrative: TimelineAxisRow[]
  pending: TimelineEvent[]
  conflicts: TimelineConflictLine[]
  calendar: TimelineCalendar | null
  /** Era ids the form offers as hints, in the table's own order. */
  eras: string[]
  defaultEra: string | null
  /** `待定 1 条` / `没有待定`. */
  pendingNote: string
  /** `1 处冲突` / `没有冲突`. */
  conflictsNote: string
  /** The card to draw when there is nothing to show, or null. */
  empty: { title: string; body: string } | null
}

/** The one label for "this date could not be placed"; the axis and the form both use it. */
export const UNREADABLE_DATE = '读不出日期'

/** The slot text of an event that declares no screen position. */
export const UNDECLARED_SLOT = '未定叙事位'

/** Cards for the two empty-ish states. The tool name is real: it is what writes an event. */
export const TIMELINE_EMPTY: Record<'no-events' | 'index-unavailable', { title: string; body: string }> = {
  'no-events': {
    title: '这本书还没有时间线事件',
    body:
      '时间线按「世界内时间」和「叙事顺序」两条轴排事件，两边序号的差就是倒叙。用本页的「新建事件」表单写第一条（标题必填，' +
      '世界时间 YYYY[-MM[-DD]]、叙事顺序可留空），或让 AI 调工具 inkflow_timeline_upsert 写入 timeline/<事件名>.md。',
  },
  'index-unavailable': {
    title: '索引不可用',
    body: '时间线来自派生索引；先让 AI 调工具 inkflow_index_rebuild 重建索引，再回来看这一页。',
  },
}

/** The line under the head: what the two columns are, in one sentence. */
export const TIMELINE_NOTE =
  '左列按世界内时间（纪元 + 日期），右列按叙事顺序（#序号）；两列序号不一致的地方就是倒叙或回忆，数据本身不矛盾。'

/** Which statuses the form offers, in the order it offers them. */
export const TIMELINE_STATUS_OPTIONS: ReadonlyArray<{ value: TimelineStatus; label: string }> = [
  { value: 'confirmed', label: '已定（进两条轴）' },
  { value: 'unconfirmed', label: '待定（不参与排序）' },
]

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asEvent(value: unknown): TimelineEvent | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const id = text(record['id'])
  if (id === null) return undefined
  return {
    id,
    title: text(record['title']) ?? id,
    file: text(record['file']) ?? id,
    worldTime: text(record['worldTime']),
    era: text(record['era']),
    worldAbsoluteDay: numberOrNull(record['worldAbsoluteDay']),
    narrativeOrder: numberOrNull(record['narrativeOrder']),
    chapter: text(record['chapter']),
    participants: Array.isArray(record['participants'])
      ? record['participants'].filter((item): item is string => typeof item === 'string')
      : [],
    status: record['status'] === 'unconfirmed' ? 'unconfirmed' : 'confirmed',
  }
}

function asEvents(value: unknown): TimelineEvent[] {
  if (!Array.isArray(value)) return []
  return value.map(asEvent).filter((entry): entry is TimelineEvent => entry !== undefined)
}

function asConflicts(value: unknown): TimelineConflictLine[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const record = asRecord(item)
    const code = text(record?.['code'])
    if (record === undefined || code === null) return []
    const otherPath = text(record['otherPath'])
    return [
      {
        code,
        path: text(record['path']) ?? '',
        ...(otherPath === null ? {} : { otherPath }),
        detail: text(record['detail']) ?? '',
      },
    ]
  })
}

function asCalendar(value: unknown): TimelineCalendar | null {
  const record = asRecord(value)
  const id = text(record?.['id'])
  if (record === undefined || id === null) return null
  const eras = Array.isArray(record['eras'])
    ? record['eras'].flatMap((item) => {
        const entry = asRecord(item)
        const eraId = text(entry?.['id'])
        return eraId === null ? [] : [eraId]
      })
    : []
  return {
    id,
    source: text(record['source']) ?? 'default',
    defaultEra: text(record['defaultEra']),
    eras: eras.map((eraId) => ({ id: eraId })),
  }
}

/** `1710-01-05` / `1710-01-05 · 天启三年`(era) / 「读不出日期」. */
function whenOf(event: TimelineEvent): string {
  if (event.worldTime === null || event.worldAbsoluteDay === null) return UNREADABLE_DATE
  return event.era === null ? event.worldTime : `${event.worldTime} · ${event.era}`
}

/**
 * One event as a column row: the three labels both columns need, and nothing decided.
 *
 * Exported because the pending area draws the same row (an unconfirmed event is not on either
 * axis, but it is still a row the author can click into the form): one constructor means the
 * pending list cannot grow a different idea of what "读不出日期" means.
 */
export function axisRowOf(event: TimelineEvent): TimelineAxisRow {
  return {
    event,
    when: whenOf(event),
    slot: event.narrativeOrder === null ? null : `#${String(event.narrativeOrder)}`,
    undeclared: event.narrativeOrder === null,
    unreadable: event.worldTime === null || event.worldAbsoluteDay === null,
    flashback: false,
  }
}

/**
 * The world column: payload order, except that an event whose date could not be read is moved
 * to the END. "Cannot be placed" is not a position, and the Host's own rules report such an
 * event as `TIMELINE_TIME_INVALID` — it must stay visible (it is still in the book) without
 * claiming a day it does not have.
 */
export function worldRows(events: readonly TimelineEvent[]): TimelineAxisRow[] {
  const placed: TimelineAxisRow[] = []
  const unplaceable: TimelineAxisRow[] = []
  for (const entry of events) {
    const row = axisRowOf(entry)
    if (row.unreadable) unplaceable.push(row)
    else placed.push(row)
  }
  return [...placed, ...unplaceable]
}

/**
 * The narrative column: payload order (the Host sorts by the book-wide slot and appends the
 * undeclared ones), with `flashback` marked where the telling order goes back in world time.
 *
 * `flashback` compares a row with the last row that HAD a readable day, not with the row
 * directly above: an unplaceable event in between must not silence the crossing it sits in.
 */
export function narrativeRows(events: readonly TimelineEvent[]): TimelineAxisRow[] {
  const rows: TimelineAxisRow[] = []
  let previousDay: number | null = null
  for (const entry of events) {
    const row = axisRowOf(entry)
    const day = entry.worldAbsoluteDay
    if (day !== null && previousDay !== null && day < previousDay) {
      rows.push({ ...row, flashback: true })
    } else {
      rows.push(row)
    }
    if (day !== null) previousDay = day
  }
  return rows
}

/** `1710-01-05 · #<序号> · c-1` — the time, the slot and the chapter, in the order the eye wants. */
export function describeRow(row: TimelineAxisRow): string {
  const parts = [row.when, row.slot ?? UNDECLARED_SLOT]
  if (row.event.chapter !== null) parts.push(row.event.chapter)
  return parts.join(' · ')
}

/** `TIMELINE_ORDER_CONFLICT · timeline/x.md — <the Host's sentence>`. */
export function describeConflict(conflict: TimelineConflictLine): string {
  const where = conflict.otherPath === undefined ? conflict.path : `${conflict.path} ↔ ${conflict.otherPath}`
  return `${conflict.code} · ${where} — ${conflict.detail}`
}

function countsOf(value: TimelineValue | undefined): { world: number; narrative: number; unconfirmed: number } {
  const counts = value?.counts
  const read = (raw: unknown): number => (typeof raw === 'number' && Number.isFinite(raw) ? raw : 0)
  return {
    world: read(counts?.world),
    narrative: read(counts?.narrative),
    unconfirmed: read(counts?.unconfirmed),
  }
}

const LOADING: TimelineView = {
  error: null,
  indexAvailable: true,
  counts: { world: 0, narrative: 0, unconfirmed: 0 },
  world: [],
  narrative: [],
  pending: [],
  conflicts: [],
  calendar: null,
  eras: [],
  defaultEra: null,
  pendingNote: '没有待定',
  conflictsNote: '没有冲突',
  empty: null,
}

/**
 * `GET /timeline` → the pane's state.
 *
 * Four states stay apart, the same way the foreshadow board and the map keep them apart: a
 * failed request, an unreadable index, an empty book and "nothing loaded yet" are four different
 * things to tell the author, and collapsing them makes 「索引没建」 read as 「你还没写事件」.
 */
export function readTimelineView(result: InternalResult<TimelineValue> | null): TimelineView {
  if (result === null) return LOADING

  if (!result.ok) {
    const code = result.error?.code ?? 'unknown'
    if (code === 'INDEX_UNAVAILABLE') {
      return { ...LOADING, indexAvailable: false, empty: null }
    }
    const message = result.error?.message
    return { ...LOADING, error: message === undefined ? code : `${code} — ${message}` }
  }

  const value = result.value ?? {}
  const counts = countsOf(value)
  const world = worldRows(asEvents(value.worldOrder))
  const narrative = narrativeRows(asEvents(value.narrativeOrder))
  const pending = asEvents(value.pending)
  const conflicts = asConflicts(value.conflicts)
  const calendar = asCalendar(value.calendar)
  const total = counts.world + counts.narrative + counts.unconfirmed

  return {
    error: null,
    indexAvailable: true,
    counts,
    world,
    narrative,
    pending,
    conflicts,
    calendar,
    eras: calendar === null ? [] : calendar.eras.map((era) => era.id),
    defaultEra: calendar?.defaultEra ?? null,
    pendingNote: counts.unconfirmed === 0 ? '没有待定' : `待定 ${String(counts.unconfirmed)} 条`,
    conflictsNote: conflicts.length === 0 ? '没有冲突' : `${String(conflicts.length)} 处冲突`,
    empty: total === 0 ? TIMELINE_EMPTY['no-events'] : null,
  }
}

// ---------------------------------------------------------------------------
// The one-event form
// ---------------------------------------------------------------------------

/**
 * The form's state. Every value is a string because that is what an `<input>` holds: parsing a
 * number here would refuse keystrokes the author is still typing, and the Host is the one that
 * decides whether an integer is acceptable.
 */
export interface TimelineDraft {
  title: string
  /** `timeline/<slug>.md` without the directory and the extension; empty for a new event. */
  slug: string
  worldTime: string
  era: string
  narrativeOrder: string
  chapter: string
  /** As typed: ids separated by `,` / `，` / `、`. */
  participants: string
  status: TimelineStatus
  body: string
}

/** A row's slug: the file name without `timeline/` and `.md`. */
export function slugOfFile(file: string): string {
  return file.replace(/^timeline\//u, '').replace(/\.md$/u, '')
}

/** The draft of an existing event, or the blank one a new event starts from. */
export function draftOf(event: TimelineEvent | null): TimelineDraft {
  if (event === null) {
    return { title: '', slug: '', worldTime: '', era: '', narrativeOrder: '', chapter: '', participants: '', status: 'confirmed', body: '' }
  }
  return {
    title: event.title,
    slug: slugOfFile(event.file),
    worldTime: event.worldTime ?? '',
    era: event.era ?? '',
    narrativeOrder: event.narrativeOrder === null ? '' : String(event.narrativeOrder),
    chapter: event.chapter ?? '',
    participants: event.participants.join(', '),
    status: event.status,
    body: '',
  }
}

/**
 * The draft as `POST /timeline/upsert` reads it: the tool's own argument names, empty inputs
 * omitted rather than sent as `''` (a blank `worldTime` is *absent*, which is what an unconfirmed
 * event means), and `confirm: true` because the author pressed the button that says so.
 *
 * No rule is enforced here. A malformed date, a negative slot or a duplicate id travel to the
 * Host unchanged and come back with the Host's code — the pane does not run a second, quieter
 * copy of the timeline's validation.
 */
export function upsertBodyOf(draft: TimelineDraft): Record<string, unknown> {
  const body: Record<string, unknown> = { title: draft.title.trim(), status: draft.status, confirm: true }
  if (draft.slug.trim() !== '') body['slug'] = draft.slug.trim()
  if (draft.worldTime.trim() !== '') body['worldTime'] = draft.worldTime.trim()
  if (draft.era.trim() !== '') body['era'] = draft.era.trim()
  const order = Number(draft.narrativeOrder.trim())
  if (draft.narrativeOrder.trim() !== '' && Number.isInteger(order)) body['narrativeOrder'] = order
  if (draft.chapter.trim() !== '') body['chapter'] = draft.chapter.trim()
  const participants = draft.participants
    .split(/[,，、]/u)
    .map((item) => item.trim())
    .filter((item) => item !== '')
  if (participants.length > 0) body['participants'] = participants
  if (draft.body.trim() !== '') body['body'] = draft.body
  return body
}

/** `POST /timeline/upsert` → `value`, as far as the receipt reads it. */
export interface TimelineWriteValue {
  path?: string
  id?: string
  status?: string
  created?: boolean
  replaced?: boolean
  bytes?: number
  indexRebuilt?: boolean
  indexError?: { code?: string }
}

/**
 * The one-line receipt, or the Host's refusal verbatim.
 *
 * `created` and `replaced` are worded differently on purpose: the author has either added an
 * event or overwritten one, and the two are not the same news.
 */
export function describeUpsert(result: InternalResult<TimelineWriteValue> | null): string | null {
  if (result === null) return null
  if (!result.ok) {
    const code = result.error?.code ?? 'unknown'
    const message = result.error?.message
    return message === undefined ? code : `${code} — ${message}`
  }
  const value = result.value ?? {}
  const verb = value.created === true ? '新建' : '覆盖'
  const where = value.path ?? value.id ?? '(未命名)'
  const index =
    value.indexRebuilt === true
      ? '索引已重建。'
      : `索引未重建（${value.indexError?.code ?? 'unknown'}），让 AI 调工具 inkflow_index_rebuild。`
  return `${verb} ${where}${value.bytes === undefined ? '' : `（${String(value.bytes)} 字节）`}；${index}`
}
