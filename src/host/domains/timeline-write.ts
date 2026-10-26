/**
 * The timeline's **write pipeline**: one event in, one file out — the orchestration both the
 * model-facing `inkflow_timeline_upsert` and the panel's `POST /timeline/upsert` run.
 *
 * WHY IT LIVES HERE and not inside the tool: the two surfaces must refuse with the *same*
 * codes, and "the same codes" is only a fact while there is one implementation. A second copy
 * in the channel would answer successfully where the tool refuses (or the other way round) the
 * first time anybody adds a field, and no test would say which one is right. So the tool keeps
 * its rendering and its schema, and this file keeps the ordering: candidate → plan → parse →
 * validate against the post-write view → write.
 *
 * The order is not negotiable, and it is documented in one place for both callers:
 *
 *   1. field-level refusals (title, slug, single-line values, participants, status, the date
 *      shape, the integer order) — cheap, and each names a code the caller can act on;
 *   2. `planTimelineUpsert` — the rules that need the whole book (a book-wide slot claimed
 *      twice, a confirmed event whose date no era can express);
 *   3. `confirm: true` — nothing lands before a human has seen the path;
 *   4. `renderTimelineDocument` → `timelineFileParse` → fold the candidate into the scan →
 *      `timelineValidate` on the post-write view (the same rules a rebuild runs);
 *   5. `writeTextAtomic` (path checks + write lock + atomic replace) and one index rebuild.
 *
 * Everything dialog-free: no stdout, no clock, no session. The caller owns the envelope.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readBookCalendar } from '../calendar-book.js'
import { buildIndex, describeIndexBuildFailure } from '../index-build.js'
import { scanProject } from '../indexer.js'
import { writeTextAtomic } from '../io.js'
import { rowsOf } from './scan-helpers.js'
import { renderTimelineDocument } from './timeline-document.js'
import type { TimelineDocumentFields } from './timeline-document.js'
import {
  TIMELINE_TABLE,
  parseWorldTime,
  planTimelineUpsert,
  statusOf,
  timelineFileParse,
  timelineValidate,
} from './timeline-plan.js'
import type { TimelineRow, TimelineStatus, TimelineUpsertCandidate } from './timeline-plan.js'
import { asRecord, isPortableSlug, optionalBoolean, optionalString, readIdList, slugify } from './tool-support.js'
import type { Json } from './tool-support.js'
import { applyCandidate } from './types.js'
import type { DomainWriteView } from './types.js'

/**
 * `status` as the write side reads it: the two values it writes, `pending` as the third
 * spelling the reader accepts, and `invalid` for anything else — the sentinel exists so the
 * caller can refuse with `TIMELINE_STATUS_INVALID` instead of silently writing a default.
 */
export function readStatus(value: unknown): TimelineStatus | 'invalid' | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return 'invalid'
  const trimmed = value.trim().toLowerCase()
  if (trimmed !== 'confirmed' && trimmed !== 'unconfirmed' && trimmed !== 'pending') return 'invalid'
  return statusOf(trimmed)
}

/** The current text of one project file, or undefined when it is not there yet. */
function readProjectText(root: string, relativePath: string): string | undefined {
  try {
    return readFileSync(join(root, relativePath), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Create or replace one event. The reply is the tool's `value` **without** `root`: the caller
 * adds how it resolved the book (a tool from its session, a channel request from its session id).
 *
 * Why the arguments are read as `unknown` and validated here rather than typed: the two callers
 * arrive with different sources of truth (a model's JSON, a browser's JSON), and the refusals
 * are the projection of that shared validation — one reader, one code, both surfaces.
 */
export async function upsertTimelineEvent(root: string, args: unknown): Promise<Json> {
  const a = asRecord(args)
  const title = optionalString(a['title'])
  if (title === undefined) {
    return { ok: false, error: { code: 'TITLE_REQUIRED', message: 'a timeline event needs a title' } }
  }
  const slugInput = optionalString(a['slug']) ?? slugify(title)
  if (!isPortableSlug(slugInput)) {
    return {
      ok: false,
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
      error: {
        code: 'TITLE_INVALID',
        message: 'a title, id or chapter must be a single line',
        hint: 'nothing was written',
      },
    }
  }

  // `participants` is rendered as an inline array line, which does not throw on a
  // line break — it writes a file whose frontmatter no longer parses. Refuse it
  // with the same reader the foreshadow tools use.
  const participantsRead = a['participants'] === undefined ? undefined : readIdList(a['participants'])
  if (participantsRead?.multiline !== undefined) {
    return {
      ok: false,
      error: {
        code: 'TITLE_INVALID',
        message: 'every participants item must be a single line',
        hint: 'nothing was written; split the ids into separate array items',
      },
    }
  }

  const status = readStatus(a['status'])
  if (status === 'invalid') {
    return {
      ok: false,
      error: {
        code: 'TIMELINE_STATUS_INVALID',
        message: 'status must be `confirmed` or `unconfirmed`',
        hint: 'an event whose time is not settled yet is `unconfirmed` and shows up in the pending area',
      },
    }
  }

  const worldTimeArg = optionalString(a['worldTime'])
  const eraArg = optionalString(a['era'])
  // The calendar is resolved once per call and passed down, never defaulted here:
  // a book whose table does not validate must say so instead of having its dates
  // re-read in the Gregorian table (ADR-0025 D1).
  const calendar = readBookCalendar(root)
  if (!calendar.ok) {
    return {
      ok: false,
      error: {
        code: calendar.error.code,
        message: calendar.error.message,
        hint:
          'nothing was written; the book\'s `inkflow.json` `calendar` table must be fixed first ' +
          '(inkflow_calendar_set writes a valid one)',
      },
    }
  }
  const spec = calendar.value.spec
  if (worldTimeArg !== undefined && parseWorldTime(worldTimeArg, spec, eraArg) === undefined) {
    const eras = spec.eras.map((era) => era.id).join(', ')
    return {
      ok: false,
      error: {
        code: 'TIMELINE_TIME_INVALID',
        message: `worldTime "${worldTimeArg}"${eraArg === undefined ? '' : ` (era ${eraArg})`} is not a real date on this book's calendar`,
        hint:
          'give a year (1710), a month (1710-03) or a day (1710-03-05); omit it for an unconfirmed event. ' +
          `Eras: ${eras}${eraArg === undefined ? ' (no era given: the newest one is assumed)' : ''}`,
      },
    }
  }
  const rawOrder = a['narrativeOrder']
  if (rawOrder !== undefined && !(typeof rawOrder === 'number' && Number.isInteger(rawOrder))) {
    return { ok: false, error: { code: 'ORDER_INVALID', message: 'narrativeOrder must be an integer' } }
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
  const era = eraArg ?? existing?.worldEra
  const narrativeOrder = (typeof rawOrder === 'number' ? rawOrder : undefined) ?? existing?.narrativeOrder
  const chapter = optionalString(a['chapter']) ?? existing?.chapter
  const participants = a['participants'] === undefined ? existing?.participants : participantsRead?.ids
  const resolvedStatus = status ?? existing?.status ?? 'confirmed'
  // Derived once, here, from the same `toAbsolute()` the rebuild uses: the candidate
  // the rules judge must carry the same absolute day its file will produce, or the
  // write gate would be judging a different date than the one being written.
  const moment = worldTime === undefined ? undefined : parseWorldTime(worldTime, spec, era)

  const candidate: TimelineUpsertCandidate = {
    id,
    path,
    title,
    ...(worldTime === undefined ? {} : { worldTime }),
    ...(era === undefined ? {} : { worldEra: moment?.era ?? era }),
    ...(moment === undefined ? {} : { worldAbsoluteDay: moment.absDay }),
    ...(narrativeOrder === undefined ? {} : { narrativeOrder }),
    ...(chapter === undefined ? {} : { chapter }),
    participants: participants ?? [],
    status: resolvedStatus,
  }

  const plan = planTimelineUpsert({ rows, candidate })
  if (!plan.ok) return { ok: false, path, error: plan.error }

  if (!optionalBoolean(a['confirm'])) {
    return {
      ok: false,
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
    ...(era === undefined ? {} : { era }),
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

  // The rules, in order: parse the candidate, fold it into the post-write view, judge
  // that view with the same rules a rebuild runs, and only then write.
  const parsedFile = timelineFileParse(path, content, spec)
  const parseIssue = parsedFile.issues[0]
  if (parseIssue !== undefined) {
    return {
      ok: false,
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
  if (!written.ok) return { ok: false, path: plan.path, error: written.error }

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
    path: written.target.relative,
    id,
    status: resolvedStatus,
    replaced: plan.replaced,
    created: written.created,
    bytes: written.bytes,
    indexRebuilt,
    ...(indexError === undefined ? {} : { indexError }),
  }
}
