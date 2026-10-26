/**
 * The timeline domain's two model-facing tools: `inkflow_timeline_list` and
 * `inkflow_timeline_upsert`.
 *
 * They live in the domain, not in `tools.ts` (roadmap §2.1 X-5): a domain branch adds
 * one line to `DOMAIN_MODULES` and never to the built-in tool array.
 *
 * They resolve the book the way a built-in tool does: an explicit `projectRoot` first,
 * else the **session's** working directory via `sessionCwd(deps.ctx, exec)`. Never bare
 * `process.cwd()` — inside the host process that is the DSH install directory, so the
 * tool would always answer `NOT_AN_INKFLOW_PROJECT`.
 *
 * Writes never bypass `io.ts` (path checks + write lock + atomic replace); reads never
 * bypass the derived index, made fresh by `ensureIndex()`.
 *
 * The write path runs X-4 in order — `scanProject` → plan → parse the candidate →
 * `applyCandidate` → validate the post-write view → `writeTextAtomic` — using
 * `timelineFileParse` / `timelineValidate`, which are the **bodies** of the domain's
 * `parseFile()` / `validate()` (each a one-line delegation in `timeline.ts`). Importing
 * the domain module here would close a runtime cycle: registry → domain → its tools.
 */

import type { ToolDefinition } from '../context.js'
import { DEFAULT_CALENDAR, validateCalendarSpec } from '../calendar.js'
import type { CalendarSpec } from '../calendar.js'
import { BOOK_CALENDAR_KEY, readBookCalendar, writeBookCalendar } from '../calendar-book.js'
import { buildIndex, describeIndexBuildFailure } from '../index-build.js'
import { ensureIndex } from '../index-freshness.js'
import { listTimelineEvents } from './query.js'
import {
  OUTPUT_SCHEMA,
  PROJECT_ROOT_PARAM,
  asRecord,
  indexFailure,
  optionalBoolean,
  optionalString,
  text,
  withProject,
} from './tool-support.js'
import type { Json } from './tool-support.js'
import type { DomainToolDeps } from './types.js'
import { parseWorldTime } from './timeline-plan.js'
// The read payload and the write pipeline are shared with the panel's channel: the pane's
// contract is that `GET /timeline` / `POST /timeline/upsert` answer exactly what these two
// tools answer, so the wire shape (`timeline-view.ts`) and the refusal order
// (`timeline-write.ts`) exist once and both surfaces call them.
import { timelineListValue } from './timeline-view.js'
import { readStatus, upsertTimelineEvent } from './timeline-write.js'

/** The payload's own event objects (the `render()` half sees the JSON, not the rows). */
function renderEntries(entries: readonly Json[], withTime: boolean): string[] {
  return entries.map((entry) => {
    const parts: string[] = []
    const worldTime = entry['worldTime']
    if (withTime) parts.push(typeof worldTime === 'string' ? worldTime : '?')
    const order = entry['narrativeOrder']
    if (typeof order === 'number') parts.push(`#${String(order)}`)
    const chapter = entry['chapter']
    if (typeof chapter === 'string') parts.push(`[${chapter}]`)
    const head = parts.length === 0 ? '' : `${parts.join(' ')} — `
    const people = Array.isArray(entry['participants']) ? (entry['participants'] as unknown[]).map(String) : []
    const suffix = people.length === 0 ? '' : ` (${people.join(', ')})`
    return `- ${head}${String(entry['title'] ?? '')}${suffix} — ${String(entry['file'] ?? '')}`
  })
}

function asEntries(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : []
}

// ---------------------------------------------------------------------------
// inkflow_timeline_list
// ---------------------------------------------------------------------------

function timelineListTool(deps: DomainToolDeps): ToolDefinition {
  return {
    name: 'inkflow_timeline_list',
    description:
      'List the timeline of the book on one or both axes. `world` is "when it happened" (worldTime, YYYY[-MM[-DD]]), ' +
      '`narrative` is "when the reader learns it" (narrativeOrder, book-wide: the order the tale is told in across the ' +
      'whole book); the two are independent and never overwrite each other. ' +
      'Events with `status: unconfirmed` are the pending area: they are excluded from both axes and returned separately as ' +
      '`pending` when `includeUnconfirmed` is true. The reply carries the conflict findings too ' +
      '(TIMELINE_TIME_MISSING / TIMELINE_TIME_INVALID / TIMELINE_ORDER_CONFLICT / TIMELINE_WORLD_TIME_REVERSED); ' +
      'TIMELINE_WORLD_TIME_REVERSED only says a scene is told out of world order (a flashback or a recall), ' +
      'the other three mean the data contradicts what it declares. ' +
      'Read-only; the derived index is rebuilt first when it is stale. Call it when the user asks what happened when, ' +
      'in which order the book tells it, which events still have no settled date, or why two events contradict.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        axis: {
          type: 'string',
          enum: ['world', 'narrative', 'both'],
          description: 'Which axis to sort by: `world`, `narrative`, or `both` (default).',
        },
        chapter: { type: 'string', description: 'Only events told in this chapter id.' },
        includeUnconfirmed: {
          type: 'boolean',
          description: 'Also return the pending area (events whose world time is not settled yet).',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          return text([`Timeline unavailable: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`])
        }
        const counts = asRecord(v['counts'])
        const world = typeof counts['world'] === 'number' ? counts['world'] : 0
        const pending = typeof counts['unconfirmed'] === 'number' ? counts['unconfirmed'] : 0
        const lines = [
          `${String(world)} placed event(s)${pending === 0 ? '' : `, ${String(pending)} unconfirmed`}` +
            `${v['indexRebuilt'] === true ? ' (index rebuilt)' : ''}:`,
        ]
        const worldOrder = asEntries(v['worldOrder'])
        if (Array.isArray(v['worldOrder'])) {
          lines.push('[世界内时间]', ...(worldOrder.length === 0 ? ['  (空)'] : renderEntries(worldOrder, true)))
        }
        if (Array.isArray(v['narrativeOrder'])) {
          const narrative = asEntries(v['narrativeOrder'])
          lines.push('[叙事顺序]', ...(narrative.length === 0 ? ['  (空)'] : renderEntries(narrative, false)))
        }
        const unconfirmed = asEntries(v['pending'])
        if (unconfirmed.length > 0) lines.push('[待确认区]', ...renderEntries(unconfirmed, true))
        for (const conflict of asEntries(v['conflicts']).slice(0, 10)) {
          lines.push(
            `! ${String(conflict['code'] ?? '')} ${String(conflict['path'] ?? '')} — ${String(conflict['detail'] ?? '')}`,
          )
        }
        return text(lines)
      },
    },
    execute: async (args, exec) =>
      withProject(deps, exec, args, async (root) => {
        const ensured = await ensureIndex(root)
        if (!ensured.ok) return indexFailure(root, ensured.failure)
        const rows = listTimelineEvents(root)
        if (rows === undefined) {
          return indexFailure(root, { code: 'INDEX_UNAVAILABLE', message: 'the derived index could not be read' })
        }
        const a = asRecord(args)
        const chapter = optionalString(a['chapter'])
        // The payload is built by `timelineListValue`, the SAME function `GET /timeline` calls:
        // the two surfaces are compared field for field in the channel suite, so a field added
        // here would have to be added there too — by construction, not by discipline.
        return {
          ok: true,
          root,
          ...timelineListValue({
            rows,
            axis: a['axis'],
            ...(chapter === undefined ? {} : { chapter }),
            includeUnconfirmed: optionalBoolean(a['includeUnconfirmed']),
          }),
          indexRebuilt: ensured.rebuilt,
          indexState: ensured.state,
        }
      }),
  }
}

// ---------------------------------------------------------------------------
// inkflow_timeline_upsert
// ---------------------------------------------------------------------------

function timelineUpsertTool(deps: DomainToolDeps): ToolDefinition {
  return {
    name: 'inkflow_timeline_upsert',
    description:
      'Create or replace one timeline event: writes `timeline/<slug>.md` with `worldTime` / `narrativeOrder` / ' +
      '`chapterId` / `participants` / `status`, then rebuilds the derived index. Only contradictions are refused: a ' +
      'confirmed event without a usable world time (TIMELINE_TIME_MISSING / TIMELINE_TIME_INVALID), and one book-wide ' +
      'narrative slot claimed twice with different world times (TIMELINE_ORDER_CONFLICT). A world time that goes ' +
      'backwards against the previous declared slot — telling the story out of world order — is **not** refused: it is ' +
      'what flashbacks and recalls are, and the next rebuild reports it as TIMELINE_WORLD_TIME_REVERSED. ' +
      'Mark an event `status: unconfirmed` when its time is not settled: it goes to the pending area and is not ordered. ' +
      'Requires `confirm: true`, and writes nothing without it.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        title: { type: 'string', description: 'Event name; the file slug derives from it.' },
        id: {
          type: 'string',
          description: 'Stable id. Omit to use the file path (the same default the parser applies), and keep it on edits.',
        },
        worldTime: {
          type: 'string',
          description:
            'World-internal time as `YYYY`, `YYYY-MM` or `YYYY-MM-DD` (one flat value; the precision is how many parts ' +
            'you write). Required unless status is unconfirmed.',
        },
        narrativeOrder: {
          type: 'integer',
          description:
            'Book-wide screen slot: when the reader learns this, counted across the whole book (not an index inside one ' +
            'chapter). It may disagree with worldTime — that is a flashback, and it is allowed.',
        },
        chapter: { type: 'string', description: 'Chapter id this event is told in (written as `chapterId`).' },
        era: {
          type: 'string',
          description:
            'Era this date is written in (`era` in the file): an era id from the book\'s calendar ' +
            '(inkflow_calendar_get lists them). Omit to read the date in the newest era, which is what a bare year ' +
            'means; an older era must be named.',
        },
        participants: {
          type: 'array',
          items: { type: 'string' },
          description: 'Character ids taking part in the event.',
        },
        status: {
          type: 'string',
          enum: ['confirmed', 'unconfirmed'],
          description:
            '`unconfirmed` puts the event in the pending area; omit to keep the current value (default confirmed). ' +
            'Writing accepts only these two values — `pending` is still read as `unconfirmed`, for files written by hand.',
        },
        body: { type: 'string', description: 'Event body (Markdown). Omit to keep the existing body.' },
        slug: { type: 'string', description: 'File slug; omit to derive it from the title.' },
        confirm: {
          type: 'boolean',
          description: 'Set true only after the user has seen the path and the fields this call would write.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          if (v['requiresConfirmation'] === true) {
            return text([
              `Confirmation required: ${String(error['message'] ?? '')}`,
              `Would write: ${String(v['willWrite'] ?? '?')}${v['replaced'] === true ? ' (replaces the existing file)' : ''}`,
              'Nothing was written. Show this to the user, then call again with confirm: true.',
            ])
          }
          return text([`Timeline upsert refused: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`])
        }
        const indexLine =
          v['indexRebuilt'] === true
            ? 'index rebuilt.'
            : `index NOT rebuilt (${String(asRecord(v['indexError'])['code'] ?? 'unknown')}) — run inkflow_index_rebuild.`
        return text([
          `${v['created'] === true ? 'Created' : 'Replaced'} ${String(v['path'])} (id ${String(v['id'])}, ${String(v['status'])}).`,
          indexLine,
        ])
      },
    },
    execute: async (args, exec) =>
      // ONE writer for both surfaces: the panel's `POST /timeline/upsert` calls the same
      // `upsertTimelineEvent`, so a refusal code cannot drift between the tool and the page.
      withProject(deps, exec, args, async (root) => ({ root, ...(await upsertTimelineEvent(root, args)) })),
  }
}

/**
 * The calendar a book reads its dates in — read and write (roadmap X-28).
 *
 * They live beside the timeline tools because the timeline is the only consumer: the
 * calendar is not a content directory (it is a key in `inkflow.json`), so no domain can
 * own it, and putting it here keeps the write surface at one place a reader can find.
 *
 * `inkflow_calendar_get` is read-only and always answers the table **in force**: the
 * book's own, or the default one when the book never set any (with `source` saying
 * which). `inkflow_calendar_set` validates first, writes atomically, then rebuilds the
 * index — every derived `worldAbsoluteDay` in the index is a function of this table, so
 * leaving the index alone would mean the timeline kept describing the old calendar.
 */
function calendarGetTool(deps: DomainToolDeps): ToolDefinition {
  return {
    name: 'inkflow_calendar_get',
    description:
      'Read the calendar this book interprets `worldTime` in: the eras (id, label-free id and the absolute day each ' +
      'era starts at), the month lengths and the leap rule of each, plus the resulting absolute day of a date when one ' +
      'is asked for. `source: "default"` means the book never set one (a single Gregorian era starting at day 0). ' +
      'A table that is present but does not validate is reported as an error with its code — it never silently falls ' +
      'back to the default, because that would change the meaning of every date in the book. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        date: {
          type: 'string',
          description: 'Optional `YYYY[-MM[-DD]]` date to convert; the reply then carries its absolute day.',
        },
        era: { type: 'string', description: 'Era for `date` (default: the newest era of the table).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          return text([`Calendar unavailable: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`])
        }
        const eras = Array.isArray(v['eras']) ? (v['eras'] as Record<string, unknown>[]) : []
        const lines = [`Calendar "${String(v['calendarId'])}" (${String(v['source'])}), ${String(eras.length)} era(s):`]
        for (const era of eras) {
          const months = Array.isArray(era['months']) ? (era['months'] as unknown[]).length : 0
          const leap = asRecord(era['leap'])
          lines.push(
            `- ${String(era['id'])}: starts at day ${String(era['epochOffsetDays'])}, ${String(months)} month(s), ` +
              `leap ${String(leap['kind'] ?? 'none')}${leap['month'] === undefined ? '' : ` in month ${String(leap['month'])}`}`,
          )
        }
        if (v['date'] !== undefined) {
          lines.push(
            v['absoluteDay'] === null || v['absoluteDay'] === undefined
              ? `! ${String(v['date'])} is not a date on this calendar`
              : `${String(v['date'])}${v['era'] === undefined ? '' : ` (era ${String(v['era'])})`} = day ${String(v['absoluteDay'])}`,
          )
        }
        return text(lines)
      },
    },
    execute: async (args, exec) =>
      withProject(deps, exec, args, async (root) => {
        const calendar = readBookCalendar(root)
        if (!calendar.ok) {
          return { ok: false, root, error: { code: calendar.error.code, message: calendar.error.message } }
        }
        const spec = calendar.value.spec
        const a = asRecord(args)
        const dateArg = optionalString(a['date'])
        const eraArg = optionalString(a['era'])
        const moment =
          dateArg === undefined
            ? undefined
            : parseWorldTime(dateArg, spec, eraArg)
        return {
          ok: true,
          root,
          calendarId: spec.id,
          source: calendar.value.source,
          defaultEra: spec.eras[spec.eras.length - 1]?.id ?? null,
          eras: spec.eras.map((era) => ({
            id: era.id,
            epochOffsetDays: era.epochOffsetDays,
            months: [...era.months],
            leap: { ...era.leap },
          })),
          ...(dateArg === undefined
            ? {}
            : {
                date: dateArg,
                era: eraArg ?? moment?.era ?? null,
                absoluteDay: moment?.absDay ?? null,
                precision: moment?.precision ?? null,
              }),
        }
      }),
  }
}

/** The era table a caller hands in: `{ id, eras: [{ id, epochOffsetDays, months, leap }] }`. */
function readCalendarSpecArg(value: unknown): CalendarSpec | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  return value as CalendarSpec
}

function calendarSetTool(deps: DomainToolDeps): ToolDefinition {
  return {
    name: 'inkflow_calendar_set',
    description:
      'Replace the book\'s calendar table in `inkflow.json` (the `calendar` key), then rebuild the derived index so ' +
      'every event\'s absolute day is recomputed. The table is validated first and a bad one is refused with ' +
      'CALENDAR_INVALID_SPEC: eras must ascend by `epochOffsetDays`, each needs positive month lengths and a leap rule ' +
      '(`none` | `{"kind":"every","years":N,"month":M}` | `{"kind":"gregorian","month":M}`). Content files are NOT ' +
      'touched — `timeline/*.md` keeps its flat `worldTime`, only its interpretation changes, so a table that moves the ' +
      'era anchors re-dates every event that names no era. Requires `confirm: true`.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        calendar: {
          type: 'object',
          description:
            'The table: `{ "id": "common", "eras": [{ "id": "ce", "epochOffsetDays": 0, "months": [31,28,...], ' +
            '"leap": { "kind": "gregorian", "month": 2 } }] }`. Omit entirely to reset the book to the default table.',
          properties: {
            id: { type: 'string', description: 'Calendar id (non-empty).' },
            eras: {
              type: 'array',
              description: 'Eras, ascending by epochOffsetDays; the last one is the era a bare date is read in.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'Era id, unique in the table.' },
                  epochOffsetDays: {
                    type: 'integer',
                    description: 'Absolute day of this era\'s year 1 month 1 day 1 (may be negative).',
                  },
                  months: {
                    type: 'array',
                    items: { type: 'integer' },
                    description: 'Common-year month lengths, at least one, each a positive whole number of days.',
                  },
                  leap: {
                    type: 'object',
                    description: '`{kind:"none"}` | `{kind:"every",years,month}` | `{kind:"gregorian",month}`.',
                    properties: {
                      kind: { type: 'string', description: 'none | every | gregorian' },
                      years: { type: 'integer', description: 'Years between leap years (`every` only).' },
                      month: { type: 'integer', description: '1-based month that gains the extra day.' },
                    },
                  },
                },
              },
            },
          },
        },
        confirm: {
          type: 'boolean',
          description: 'Set true only after the user has seen the table this call would write.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          if (v['requiresConfirmation'] === true) {
            return text([
              `Confirmation required: ${String(error['message'] ?? '')}`,
              'Nothing was written. Show the table to the user, then call again with confirm: true.',
            ])
          }
          return text([`Calendar refused: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`])
        }
        const indexLine =
          v['indexRebuilt'] === true
            ? 'index rebuilt (every absolute day recomputed).'
            : `index NOT rebuilt (${String(asRecord(v['indexError'])['code'] ?? 'unknown')}) — run inkflow_index_rebuild.`
        return text([`Wrote the calendar "${String(v['calendarId'])}" into ${String(v['file'])}, ${indexLine}`])
      },
    },
    execute: async (args, exec) =>
      withProject(deps, exec, args, async (root) => {
        const a = asRecord(args)
        const asked = a['calendar']
        const spec = asked === undefined ? DEFAULT_CALENDAR : readCalendarSpecArg(asked)
        if (spec === undefined) {
          return {
            ok: false,
            root,
            error: {
              code: 'CALENDAR_INVALID_SPEC',
              message: 'the calendar must be an object {id, eras[]}, or omitted to reset to the default table',
            },
          }
        }
        const valid = validateCalendarSpec(spec)
        if (!valid.ok) {
          return { ok: false, root, error: { code: valid.error.code, message: valid.error.message } }
        }
        if (!optionalBoolean(a['confirm'])) {
          return {
            ok: false,
            root,
            requiresConfirmation: true,
            willWrite: 'inkflow.json',
            error: {
              code: 'CALENDAR_SET_REQUIRES_CONFIRMATION',
              message: `replacing the calendar in ${BOOK_CALENDAR_KEY} rewrites the meaning of every worldTime in this book; pass confirm: true`,
              hint: 'nothing was written',
            },
          }
        }
        const written = writeBookCalendar(root, valid.value)
        if (!written.ok) return { ok: false, root, error: { code: written.error.code, message: written.error.message } }

        let indexRebuilt = false
        let indexError: Json | undefined
        try {
          await buildIndex(root)
          indexRebuilt = true
        } catch (cause) {
          const failure = describeIndexBuildFailure(cause)
          indexError = { code: failure.code, message: failure.message }
        }
        return {
          ok: true,
          root,
          file: 'inkflow.json',
          calendarId: valid.value.id,
          eras: valid.value.eras.map((era) => era.id),
          indexRebuilt,
          ...(indexError === undefined ? {} : { indexError }),
        }
      }),
  }
}

/**
 * The timeline domain's model-facing surface, in registry order (X-5).
 *
 * The two calendar tools ship with it rather than in `tools.ts`: the calendar is not a
 * content directory (it is a key in `inkflow.json`), so no domain owns it, and the
 * timeline is its only consumer.
 */
export function timelineTools(deps: DomainToolDeps): readonly ToolDefinition[] {
  return [timelineListTool(deps), timelineUpsertTool(deps), calendarGetTool(deps), calendarSetTool(deps)]
}
