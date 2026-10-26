/**
 * The timeline's **read projection**, in one place: one event as the wire carries it, the
 * two axes plus the pending area and the conflicts, and the book's own era table.
 *
 * WHY THIS IS NOT IN `timeline-tools.ts`: the same payload is answered by two surfaces — the
 * model-facing `inkflow_timeline_list` and the panel's `GET /timeline` — and the pane's whole
 * acceptance criterion is that the two agree **field for field**. Two call sites building the
 * object themselves is how they stop agreeing: one grows a field, the other keeps the old
 * shape, and nothing fails until an author reads an order the model cannot see. So the shape
 * is built once here and both surfaces hand in their own rows.
 *
 * The judgement is `timeline-plan.ts`'s (`planTimelineView` / `timelineConflicts`) and stays
 * there: this file only decides what travels on the wire and in which order the keys appear.
 * Nothing here touches the disk, so it is testable without a book.
 */

import type { CalendarSpec } from '../calendar.js'
import { planTimelineView, timelineConflicts } from './timeline-plan.js'
import type { TimelineRow } from './timeline-plan.js'
import type { Json } from './tool-support.js'

/**
 * Which axes a request asks for. An unrecognised value means `both`, on both surfaces: a
 * typo must not silently narrow the answer to one axis (the panel would draw an empty column
 * and blame the book).
 */
export function readAxis(value: unknown): 'world' | 'narrative' | 'both' {
  return value === 'world' || value === 'narrative' ? value : 'both'
}

/**
 * One event as the payload carries it.
 *
 * `file` is the project-relative path, and `path` is deliberately NOT reused for it: every
 * conflict finding already spells its own `path`, and two meanings for one key on the same
 * wire is how a reader confuses "the event" with "the finding".
 *
 * `worldAbsoluteDay` is present only when the date is readable under this book's table; that
 * absence is the answer for an event whose `worldTime` no era can express, and the pane draws
 * it as 「读不出日期」 rather than inventing a position.
 */
export function eventJson(row: TimelineRow): Json {
  return {
    id: row.id,
    title: row.title,
    file: row.path,
    worldTime: row.worldTime ?? null,
    era: row.worldEra ?? null,
    worldAbsoluteDay: row.worldAbsoluteDay ?? null,
    narrativeOrder: row.narrativeOrder ?? null,
    chapter: row.chapter ?? null,
    participants: [...(row.participants ?? [])],
    status: row.status,
  }
}

/** What a read surface hands in: its own rows and the knobs it read off the request. */
export interface TimelineListInput {
  readonly rows: readonly TimelineRow[]
  /** Raw `axis` (query string or tool argument): `readAxis` normalises it. */
  readonly axis: unknown
  /** Only the events told in this chapter, or `undefined` for the whole book. */
  readonly chapter?: string
  readonly includeUnconfirmed?: boolean
}

/**
 * The payload both surfaces answer with.
 *
 * Key order is construction order and therefore part of the contract: the tool's output is
 * compared to the route's field by field in `tests/timeline-channel.test.js`, and a reordered
 * object would make that diff unreadable without being wrong.
 *
 * Two decisions worth keeping:
 *   * `counts` always counts the WHOLE view, even when `axis` suppresses one of the lists — a
 *     reader must be able to see "3 placed, 1 unconfirmed" while looking at one axis;
 *   * `conflicts` is judged over **all** rows, never over the chapter filter: `narrativeOrder`
 *     is a book-wide slot, so a filter would hide the one contradiction the author most needs
 *     (the same slot claimed by two different chapters).
 */
export function timelineListValue(input: TimelineListInput): Json {
  const chapter = input.chapter
  const filtered = chapter === undefined ? input.rows : input.rows.filter((row) => row.chapter === chapter)
  const view = planTimelineView(filtered)
  const axis = readAxis(input.axis)

  return {
    axis,
    counts: {
      world: view.worldOrder.length,
      narrative: view.narrativeOrder.length,
      unconfirmed: view.unconfirmed.length,
    },
    ...(axis === 'narrative' ? {} : { worldOrder: view.worldOrder.map(eventJson) }),
    ...(axis === 'world' ? {} : { narrativeOrder: view.narrativeOrder.map(eventJson) }),
    ...(input.includeUnconfirmed === true ? { pending: view.unconfirmed.map(eventJson) } : {}),
    conflicts: timelineConflicts(input.rows),
  }
}

/**
 * The era table a form needs to hint `era` ids with.
 *
 * The fields are the ones `inkflow_calendar_get` answers (`calendarId`/`source`/`defaultEra`/
 * `eras[]`), renamed only where the nesting differs — `id` inside the calendar object instead
 * of a top-level `calendarId`, because this object travels as one key of the timeline payload.
 * `tests/timeline-channel.test.js` asserts the two readings agree era for era, so an id the
 * pane offers is an id the tool accepts; a second reading of `inkflow.json` here would be the
 * failure mode ADR-0025 D1 exists to prevent.
 */
export function timelineCalendarJson(spec: CalendarSpec, source: string): Json {
  return {
    id: spec.id,
    source,
    defaultEra: spec.eras[spec.eras.length - 1]?.id ?? null,
    eras: spec.eras.map((era) => ({
      id: era.id,
      epochOffsetDays: era.epochOffsetDays,
      months: [...era.months],
      leap: { ...era.leap },
    })),
  }
}
