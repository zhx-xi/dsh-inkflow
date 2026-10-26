/**
 * The timeline pane's half of the private channel: one read projection and one write action.
 *
 * Scope: `GET /timeline` and `POST /timeline/upsert`. Nothing about *what* the timeline means
 * lives here — the two axes, the pending area, the conflict rules and the refusal codes are
 * `domains/timeline-plan.ts`'s, the wire shape is `domains/timeline-view.ts`'s and the write
 * pipeline is `domains/timeline-write.ts`'s. This file only turns request fields into values
 * and a `{ ok, value | error }` envelope, so a caller cannot reach a rule the tools do not run.
 *
 * WHY BOTH SURFACES ARE THE SAME FUNCTIONS, not the same decisions written twice: the pane's
 * acceptance criterion is that `GET /timeline` answers **field for field** what
 * `inkflow_timeline_list` answers, and that the write route refuses with the **same codes**.
 * A second projection in the channel would answer successfully where the tool refuses the
 * first time somebody adds a field, and the drift would be invisible until an author read an
 * order the model could not see. `tests/timeline-channel.test.js` compares the two surfaces on
 * one book, so the shared functions are checked and not just asserted in a comment.
 *
 * ## The request rules, stated once so the route table stays declarative
 *
 *   * **the browser names no directory** (ADR-0008 D4): the book comes from the resolved
 *     `ChannelTarget`, never from a query or body field — `POST /timeline/upsert` therefore
 *     refuses `projectRoot` as an unexpected field;
 *   * **an event is addressed by `slug`**, the name the tool takes. A row carries `file` =
 *     `timeline/<slug>.md`, so the page derives the slug from it (`timeline-model.ts`). Neither
 *     `path` nor `root` may travel: the dispatcher refuses every path-bearing body field
 *     outright (`ROOT_PARAM_NOT_ALLOWED`), and that is what keeps a browser from naming a
 *     location;
 *   * **a write needs `confirm: true`** — the tool's own gate, reached through the same
 *     pipeline: absent is `TIMELINE_UPSERT_REQUIRES_CONFIRMATION` (400) with zero bytes written;
 *   * **the read path may make the index fresh** (`ensureIndex`), exactly like `/chapters` and
 *     `/foreshadow`: a stale cache is rebuilt, a missing one is built, and a failure is
 *     reported as `ok:false` instead of an empty axis.
 */

import { readBookCalendar } from './calendar-book.js'
import { ensureIndex } from './index-freshness.js'
import { listTimelineEvents } from './domains/query.js'
import { timelineCalendarJson, timelineListValue } from './domains/timeline-view.js'
import { upsertTimelineEvent } from './domains/timeline-write.js'
import type { InternalRoute } from './route-types.js'

type JsonRecord = Record<string, unknown>

/** The query keys `GET /timeline` reads (anything else is a 400 in the dispatcher). */
export const TIMELINE_QUERY = ['axis', 'chapter', 'includeUnconfirmed'] as const

/**
 * The body fields `POST /timeline/upsert` may carry: exactly the tool's own argument names.
 * `sessionId` is always allowed by the dispatcher, and a path-bearing key is refused before
 * this list is even consulted.
 */
export const TIMELINE_UPSERT_BODY_FIELDS = [
  'title',
  'id',
  'worldTime',
  'era',
  'narrativeOrder',
  'chapter',
  'participants',
  'status',
  'body',
  'slug',
  'confirm',
] as const

/** What a timeline reply needs from the resolved channel target. */
export interface TimelineChannelSource {
  sessionId: string
  root: string
}

export interface TimelineChannelReply {
  status: number
  body: JsonRecord
}

/**
 * HTTP status per refusal, so a caller can tell "the request is wrong" from "the book's state
 * is". Anything unlisted keeps the domain code and answers 500: the code stays diagnosable,
 * which is the point of not flattening it.
 *
 * The 409 rows are the states a retry cannot fix by itself: a slot already claimed by another
 * event (a real contradiction, not a malformed request), a file that cannot be read back, a
 * locked book, and a calendar table that does not validate (a book-data problem the author
 * fixes in `inkflow.json` — reported, never silently worked around, ADR-0025 D1).
 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  TITLE_REQUIRED: 400,
  TITLE_INVALID: 400,
  SLUG_INVALID: 400,
  ORDER_INVALID: 400,
  PARTICIPANT_INVALID: 400,
  TIMELINE_STATUS_INVALID: 400,
  TIMELINE_TIME_MISSING: 400,
  TIMELINE_TIME_INVALID: 400,
  TIMELINE_UPSERT_REQUIRES_CONFIRMATION: 400,
  TIMELINE_ORDER_CONFLICT: 409,
  DUPLICATE_ID: 409,
  FILE_UNREADABLE: 409,
  CALENDAR_INVALID_SPEC: 409,
  PROJECT_BUSY: 409,
  INDEX_BUSY: 409,
  PATH_NOT_WRITABLE: 409,
  PATH_OUT_OF_SCOPE: 409,
  PATH_RESERVED: 409,
  PATH_INVALID: 400,
  PATH_TOO_LONG: 400,
}

function refused(status: number, code: string, message: string, hint?: string): TimelineChannelReply {
  return { status, body: { ok: false, error: { code, message, ...(hint === undefined ? {} : { hint }) } } }
}

/**
 * One domain failure, as the channel answers it.
 *
 * The parameter is typed by the three keys it reads rather than by a record: the two callers are
 * a typed domain error (`EnsureIndexResult` / `CalendarError`) and the untrusted `error` object a
 * write pipeline hands back, and both fit a shape of three `unknown`s. No cast, no `any`.
 */
function failureReply(error: {
  readonly code?: unknown
  readonly message?: unknown
  readonly hint?: unknown
}): TimelineChannelReply {
  const code = typeof error.code === 'string' ? error.code : 'TIMELINE_UNAVAILABLE'
  const message = typeof error.message === 'string' ? error.message : code
  const hint = typeof error.hint === 'string' ? error.hint : undefined
  return refused(STATUS_BY_CODE[code] ?? 500, code, message, hint)
}

/** The window `GET /timeline` answers. */
export async function timelineListReply(
  source: TimelineChannelSource,
  version: string,
  query: URLSearchParams,
): Promise<TimelineChannelReply> {
  const ensured = await ensureIndex(source.root)
  if (!ensured.ok) return failureReply(ensured.failure)
  const rows = listTimelineEvents(source.root)
  if (rows === undefined) {
    return refused(500, 'INDEX_UNAVAILABLE', 'the derived index could not be read', 'run inkflow_index_rebuild')
  }
  // Resolved on the read path too, and required: every date on the wire is the book's own, and
  // a table that does not validate must say so rather than be replaced by the default one
  // (ADR-0025 D1). A `calendar` object that silently fell back would re-date the whole book.
  const calendar = readBookCalendar(source.root)
  if (!calendar.ok) return failureReply(calendar.error)

  const chapter = (query.get('chapter') ?? '').trim()
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: source.root,
        ...timelineListValue({
          rows,
          axis: query.get('axis') ?? undefined,
          ...(chapter === '' ? {} : { chapter }),
          includeUnconfirmed: query.get('includeUnconfirmed') === 'true',
        }),
        calendar: timelineCalendarJson(calendar.value.spec, calendar.value.source),
        indexRebuilt: ensured.rebuilt,
        indexState: ensured.state,
      },
    },
  }
}

/**
 * The one write: same args as `inkflow_timeline_upsert`, same pipeline, same codes.
 *
 * The reply says which file was written and whether it was created or replaced — the tool's
 * `created`/`replaced` pair, so a page can word its receipt without consulting the disk.
 */
export async function timelineUpsertReply(
  source: TimelineChannelSource,
  version: string,
  body: JsonRecord,
): Promise<TimelineChannelReply> {
  const result = await upsertTimelineEvent(source.root, body)
  if (result['ok'] !== true) {
    const error = result['error']
    return failureReply(typeof error === 'object' && error !== null ? (error as { code?: unknown; message?: unknown; hint?: unknown }) : {})
  }
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: source.root,
        path: result['path'],
        id: result['id'],
        status: result['status'],
        created: result['created'],
        replaced: result['replaced'],
        bytes: result['bytes'],
        indexRebuilt: result['indexRebuilt'],
        ...(result['indexError'] === undefined ? {} : { indexError: result['indexError'] }),
      },
    },
  }
}

/**
 * The timeline's two routes.
 *
 * They live in this module rather than in `routes.ts` for one mechanical reason and one
 * structural one: that file is on its recorded line budget (`scripts/check-guards.mjs`), and
 * the dispatcher's hardening (loopback host/origin/peer, the method list, the body/query
 * allowlists, the body cap) applies to every entry of one table wherever the descriptor was
 * written. A route declared here is exactly as guarded as one declared inline.
 */
export const TIMELINE_ROUTES: readonly InternalRoute[] = [
  {
    // Two axes, one pending area, the conflict findings and the era table — the whole pane in
    // one answer. Read-only: the read path may make the index fresh and writes no file.
    name: 'timeline',
    pattern: /^\/timeline$/,
    methods: ['GET'],
    query: TIMELINE_QUERY,
    handle: ({ target, query, version }) => timelineListReply(target, version, query),
  },
  {
    // One event in, one file out. A write route, so it carries the confirmation gate: the
    // panel asks before it offers the button, and the pipeline is the net under that.
    name: 'timeline-upsert',
    pattern: /^\/timeline\/upsert$/,
    methods: ['POST'],
    query: [],
    body: TIMELINE_UPSERT_BODY_FIELDS,
    handle: ({ target, version, body }) => timelineUpsertReply(target, version, body),
  },
]
