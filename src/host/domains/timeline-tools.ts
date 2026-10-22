/**
 * The timeline domain's two model-facing tools (#28): `inkflow_timeline_list` and
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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ToolDefinition } from '../context.js'
import { buildIndex, describeIndexBuildFailure } from '../index-build.js'
import { ensureIndex } from '../index-freshness.js'
import { scanProject } from '../indexer.js'
import { writeTextAtomic } from '../io.js'
import { listTimelineEvents } from './query.js'
import { rowsOf } from './scan-helpers.js'
import { renderTimelineDocument } from './timeline-document.js'
import type { TimelineDocumentFields } from './timeline-document.js'
import {
  OUTPUT_SCHEMA,
  PROJECT_ROOT_PARAM,
  asRecord,
  indexFailure,
  isPortableSlug,
  optionalBoolean,
  optionalString,
  slugify,
  text,
  withProject,
} from './tool-support.js'
import type { Json } from './tool-support.js'
import { applyCandidate } from './types.js'
import type { DomainToolDeps, DomainWriteView } from './types.js'
import {
  TIMELINE_TABLE,
  parseWorldTime,
  planTimelineUpsert,
  planTimelineView,
  statusOf,
  timelineConflicts,
  timelineFileParse,
  timelineValidate,
} from './timeline-plan.js'
import type { TimelineRow, TimelineStatus, TimelineUpsertCandidate } from './timeline-plan.js'

/** Tool argument → id list: an array, or one comma/、separated string. */
function readIdList(value: unknown): string[] {
  const split = (raw: string): string[] =>
    raw
      .split(/[,，、]/u)
      .map((item) => item.trim())
      .filter((item) => item !== '')
  if (typeof value === 'string') return split(value)
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').flatMap((item) => split(item))
  }
  return []
}

function readAxis(value: unknown): 'world' | 'narrative' | 'both' {
  return value === 'world' || value === 'narrative' ? value : 'both'
}

/** One event as the payload carries it: `file` is the project-relative path (`path` is taken by the finding). */
function eventJson(row: TimelineRow): Json {
  return {
    id: row.id,
    title: row.title,
    file: row.path,
    worldTime: row.worldTime ?? null,
    narrativeOrder: row.narrativeOrder ?? null,
    chapter: row.chapter ?? null,
    participants: [...(row.participants ?? [])],
    status: row.status,
  }
}

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
      '`narrative` is "when the reader learns it" (narrativeOrder); the two are independent and never overwrite each other. ' +
      'Events with `status: unconfirmed` are the pending area: they are excluded from both axes and returned separately as ' +
      '`pending` when `includeUnconfirmed` is true. The reply carries the conflict findings too ' +
      '(TIMELINE_TIME_MISSING / TIMELINE_TIME_INVALID / TIMELINE_ORDER_CONFLICT / TIMELINE_WORLD_TIME_REVERSED). ' +
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
        const filtered = chapter === undefined ? rows : rows.filter((row) => row.chapter === chapter)
        const view = planTimelineView(filtered)
        const axis = readAxis(a['axis'])

        return {
          ok: true,
          root,
          axis,
          counts: {
            world: view.worldOrder.length,
            narrative: view.narrativeOrder.length,
            unconfirmed: view.unconfirmed.length,
          },
          ...(axis === 'narrative' ? {} : { worldOrder: view.worldOrder.map(eventJson) }),
          ...(axis === 'world' ? {} : { narrativeOrder: view.narrativeOrder.map(eventJson) }),
          ...(optionalBoolean(a['includeUnconfirmed']) ? { pending: view.unconfirmed.map(eventJson) } : {}),
          conflicts: timelineConflicts(filtered),
          indexRebuilt: ensured.rebuilt,
          indexState: ensured.state,
        }
      }),
  }
}

// ---------------------------------------------------------------------------
// inkflow_timeline_upsert
// ---------------------------------------------------------------------------

function readStatus(value: unknown): TimelineStatus | 'invalid' | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return 'invalid'
  const trimmed = value.trim().toLowerCase()
  if (trimmed !== 'confirmed' && trimmed !== 'unconfirmed' && trimmed !== 'pending') return 'invalid'
  return statusOf(trimmed)
}

function timelineUpsertTool(deps: DomainToolDeps): ToolDefinition {
  return {
    name: 'inkflow_timeline_upsert',
    description:
      'Create or replace one timeline event: writes `timeline/<slug>.md` with `worldTime` / `narrativeOrder` / ' +
      '`chapterId` / `participants` / `status`, then rebuilds the derived index. The write-side half of the conflict rules ' +
      'runs first: a confirmed event without a usable world time is refused (TIMELINE_TIME_MISSING), a narrative slot ' +
      'claimed twice with different world times in one chapter is refused (TIMELINE_ORDER_CONFLICT), and a world time that ' +
      'goes backwards against the previous declared slot of the same chapter is refused (TIMELINE_WORLD_TIME_REVERSED). ' +
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
          description: 'World-internal time as `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. Required unless status is unconfirmed.',
        },
        narrativeOrder: {
          type: 'integer',
          description: 'Screen slot of the book: when the reader learns this, which may disagree with worldTime.',
        },
        chapter: { type: 'string', description: 'Chapter id this event is told in.' },
        participants: {
          type: 'array',
          items: { type: 'string' },
          description: 'Character ids taking part in the event.',
        },
        status: {
          type: 'string',
          enum: ['confirmed', 'unconfirmed'],
          description:
            '`unconfirmed` puts the event in the pending area; omit to keep the current value (default confirmed).',
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
      withProject(deps, exec, args, async (root) => {
        const a = asRecord(args)
        const title = optionalString(a['title'])
        if (title === undefined) {
          return { ok: false, root, error: { code: 'TITLE_REQUIRED', message: 'a timeline event needs a title' } }
        }
        const slugInput = optionalString(a['slug']) ?? slugify(title)
        if (!isPortableSlug(slugInput)) {
          return {
            ok: false,
            root,
            error: { code: 'SLUG_INVALID', message: `"${slugInput === '' ? title : slugInput}" is not a portable file name` },
          }
        }

        // Values go straight into `key: value` lines, and `frontmatterLine()` throws on
        // a newline so a written file can never be unparsable. Refuse here, where the
        // model can read the code, instead of letting the renderer throw.
        const multiline = [title, optionalString(a['id']), optionalString(a['chapter'])].find(
          (value) => value !== undefined && /[\r\n]/u.test(value),
        )
        if (multiline !== undefined) {
          return {
            ok: false,
            root,
            error: {
              code: 'TITLE_INVALID',
              message: 'a title, id or chapter must be a single line',
              hint: 'nothing was written',
            },
          }
        }

        const status = readStatus(a['status'])
        if (status === 'invalid') {
          return {
            ok: false,
            root,
            error: {
              code: 'TIMELINE_STATUS_INVALID',
              message: 'status must be `confirmed` or `unconfirmed`',
              hint: 'an event whose time is not settled yet is `unconfirmed` and shows up in the pending area',
            },
          }
        }

        const worldTimeArg = optionalString(a['worldTime'])
        if (worldTimeArg !== undefined && parseWorldTime(worldTimeArg) === undefined) {
          return {
            ok: false,
            root,
            error: {
              code: 'TIMELINE_TIME_INVALID',
              message: `worldTime "${worldTimeArg}" is not a real YYYY[-MM[-DD]] date`,
              hint: 'give a year (1710), a month (1710-03) or a day (1710-03-05); omit it for an unconfirmed event',
            },
          }
        }
        const rawOrder = a['narrativeOrder']
        if (rawOrder !== undefined && !(typeof rawOrder === 'number' && Number.isInteger(rawOrder))) {
          return { ok: false, root, error: { code: 'ORDER_INVALID', message: 'narrativeOrder must be an integer' } }
        }

        const path = `timeline/${slugInput}.md`
        const scanned = scanProject(root)
        const rows = rowsOf<TimelineRow>(scanned, TIMELINE_TABLE)
        // Editing an event must keep its id, and a field the call does not mention must
        // keep its value: the write gate only knows the pre-write snapshot, so an
        // accidental reset would surface as a conflict on the next rebuild.
        const existing = rows.find((row) => row.path === path)
        const id = optionalString(a['id']) ?? existing?.id ?? path
        const worldTime = worldTimeArg ?? existing?.worldTime
        const narrativeOrder = (typeof rawOrder === 'number' ? rawOrder : undefined) ?? existing?.narrativeOrder
        const chapter = optionalString(a['chapter']) ?? existing?.chapter
        const participants = a['participants'] === undefined ? existing?.participants : readIdList(a['participants'])
        const resolvedStatus = status ?? existing?.status ?? 'confirmed'

        const candidate: TimelineUpsertCandidate = {
          id,
          path,
          title,
          ...(worldTime === undefined ? {} : { worldTime }),
          ...(narrativeOrder === undefined ? {} : { narrativeOrder }),
          ...(chapter === undefined ? {} : { chapter }),
          participants: participants ?? [],
          status: resolvedStatus,
        }

        const plan = planTimelineUpsert({ rows, candidate })
        if (!plan.ok) return { ok: false, root, path, error: plan.error }

        if (!optionalBoolean(a['confirm'])) {
          return {
            ok: false,
            root,
            requiresConfirmation: true,
            willWrite: plan.path,
            replaced: plan.replaced,
            error: {
              code: 'TIMELINE_UPSERT_REQUIRES_CONFIRMATION',
              message: `writing ${plan.path} needs confirmation`,
              hint: 'show the path and fields to the user; nothing was written. Call again with confirm: true',
            },
          }
        }

        const fields: TimelineDocumentFields = {
          id,
          title,
          status: resolvedStatus,
          ...(worldTime === undefined ? {} : { worldTime }),
          ...(narrativeOrder === undefined ? {} : { narrativeOrder }),
          ...(chapter === undefined ? {} : { chapter }),
          participants: participants ?? [],
        }
        const body = optionalString(a['body'])
        const existingText = existing === undefined ? undefined : readProjectText(root, path)
        // The index says this file is there, but its text cannot be read: writing a fresh
        // document would replace the author's body and their unmodelled keys with a stub.
        if (existing !== undefined && existingText === undefined) {
          return {
            ok: false,
            root,
            path: plan.path,
            error: {
              code: 'FILE_UNREADABLE',
              message: `${plan.path} exists but could not be read, so an edit cannot preserve it`,
              hint: 'nothing was written; check the file permissions, or write the event by hand',
            },
          }
        }
        const content = renderTimelineDocument({
          ...(existingText === undefined ? {} : { text: existingText }),
          fields,
          ...(body === undefined ? {} : { body }),
        })

        // X-4, in order: parse the candidate, fold it into the post-write view, judge
        // that view with the same rules a rebuild runs, and only then write.
        const parsedFile = timelineFileParse(path, content)
        const parseIssue = parsedFile.issues[0]
        if (parseIssue !== undefined) {
          return {
            ok: false,
            root,
            path: plan.path,
            error: {
              code: parseIssue.code,
              message: parseIssue.detail,
              path: plan.path,
              hint: 'nothing was written: the document this call would write does not parse back',
            },
          }
        }
        const view: DomainWriteView = { scan: scanned, entities: scanned.entities }
        const post = applyCandidate(view, parsedFile)
        const blocking = timelineValidate(rowsOf<TimelineRow>(post.scan, TIMELINE_TABLE), path)
        const first = blocking[0]
        if (first !== undefined) {
          return {
            ok: false,
            root,
            path: plan.path,
            error: {
              code: first.code,
              message: first.detail,
              path: first.path ?? plan.path,
              hint: 'nothing was written: this edit would leave the timeline in a state the rebuild rejects',
            },
          }
        }

        const written = writeTextAtomic(root, plan.path, content)
        if (!written.ok) return { ok: false, root, path: plan.path, error: written.error }

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
          path: written.target.relative,
          id,
          status: resolvedStatus,
          replaced: plan.replaced,
          created: written.created,
          bytes: written.bytes,
          indexRebuilt,
          ...(indexError === undefined ? {} : { indexError }),
        }
      }),
  }
}

/** The current text of one project file, or undefined when it is not there yet. */
function readProjectText(root: string, relativePath: string): string | undefined {
  try {
    return readFileSync(join(root, relativePath), 'utf8')
  } catch {
    return undefined
  }
}

/** Both timeline tools, in registry order (X-5: the domain's whole model-facing surface). */
export function timelineTools(deps: DomainToolDeps): readonly ToolDefinition[] {
  return [timelineListTool(deps), timelineUpsertTool(deps)]
}
