/**
 * The foreshadow pane's half of the private channel: one write, `POST /foreshadow/advance`.
 *
 * The board was read-only on purpose, and 伏笔 used to be *edited* in 设定库. Giving the
 * board a tab of its own took that editor away, so this module puts the one write the
 * board actually needs back where the entry is now shown — a state move on an existing
 * file. It deliberately does not become a second editor: creating an entry, changing its
 * title, its `dueBy` or its body stays on `inkflow_foreshadow_upsert`, which the pane
 * names out loud.
 *
 * WHY THE PIPELINE IS NOT WRITTEN AGAIN HERE: the pane's acceptance criterion is that a
 * move it offers answers with **the code the tool answers** (`FORESHADOW_TRANSITION_INVALID`
 * above all), and that a step the state machine forbids writes nothing. So this route
 * resolves the entry, then calls `upsertForeshadow` — the very function
 * `inkflow_foreshadow_upsert` runs — and prints its envelope unchanged. The four steps
 * (scan → plan → parse the candidate → validate the post-write view → `writeTextAtomic`),
 * the `confirm` gate and the transition matrix therefore have exactly one home.
 *
 * ## The request rules, stated once so the route table stays declarative
 *
 *   * **the browser names no directory** (ADR-0008 D4): the book comes from the resolved
 *     `ChannelTarget`; a body carrying `projectRoot` is refused by the dispatcher before
 *     this file is consulted;
 *   * **an entry is addressed by `slug`**, the name the tool takes, and the pane derives it
 *     from the row's `file` (`foreshadow-model.ts`). `path` and `root` may not travel;
 *   * **an advance moves an entry that is there**: a slug nobody has answers
 *     `FORESHADOW_NOT_FOUND` (404) with zero bytes written. The tool is an *upsert* — it
 *     would have created the file — and "click 推进 and get a new empty foreshadow" is not
 *     a thing an author can mean;
 *   * **`title` is not a request field**: it is read from the file being moved and passed
 *     on, so a stale copy in a browser cannot rename an entry as a side effect of
 *     advancing it;
 *   * **a write needs `confirm: true`** — the tool's own gate, reached through the same
 *     function: absent is `FORESHADOW_UPSERT_REQUIRES_CONFIRMATION` (400), nothing written.
 *
 * The entry is located from the FILES (`scanProject`), not from the derived index: the
 * title and the address must be the ones on disk, or an edit would write back a stale
 * title over the author's.
 */

import { scanProject } from './indexer.js'
import { FORESHADOW_TABLE } from './domains/foreshadowing-plan.js'
import type { ForeshadowRow, ForeshadowStatus } from './domains/foreshadowing-plan.js'
import { upsertForeshadow } from './domains/foreshadowing-write.js'
import { rowsOf } from './domains/scan-helpers.js'
import type { InternalRoute } from './route-types.js'

type JsonRecord = Record<string, unknown>

/**
 * The body fields `POST /foreshadow/advance` may carry: the tool's own argument names,
 * minus everything this route refuses to let a browser decide (`title`, `id`, `body`).
 * `sessionId` is always allowed by the dispatcher.
 */
export const FORESHADOW_ADVANCE_BODY_FIELDS = ['slug', 'status', 'advancedAt', 'resolvedChapter', 'confirm'] as const

/** What an advance needs from the resolved channel target. */
export interface ForeshadowChannelSource {
  sessionId: string
  root: string
}

export interface ForeshadowChannelReply {
  status: number
  body: JsonRecord
}

/**
 * HTTP status per refusal, so a caller can tell "the request is wrong" from "the book's
 * state is". Anything unlisted keeps the domain code and answers 500: the code stays
 * diagnosable, which is the point of not flattening it.
 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  TITLE_REQUIRED: 400,
  SLUG_REQUIRED: 400,
  SLUG_INVALID: 400,
  FORESHADOW_STATUS_INVALID: 400,
  FORESHADOW_FIELD_INVALID: 400,
  FORESHADOW_RESOLVED_WITHOUT_CHAPTER: 400,
  FORESHADOW_UPSERT_REQUIRES_CONFIRMATION: 400,
  FORESHADOW_NOT_FOUND: 404,
  FORESHADOW_TRANSITION_INVALID: 409,
  FILE_UNREADABLE: 409,
  DUPLICATE_ID: 409,
  PROJECT_BUSY: 409,
  INDEX_BUSY: 409,
  PATH_NOT_WRITABLE: 409,
  PATH_OUT_OF_SCOPE: 409,
  PATH_RESERVED: 409,
  PATH_INVALID: 400,
  PATH_TOO_LONG: 400,
}

function refused(status: number, code: string, message: string, hint?: string): ForeshadowChannelReply {
  return { status, body: { ok: false, error: { code, message, ...(hint === undefined ? {} : { hint }) } } }
}

/**
 * One domain failure, as the channel answers it.
 *
 * Typed by the three keys it reads rather than by a record: the writer hands back an
 * untrusted `error` object, and a shape of three `unknown`s is what it always fits.
 */
function failureReply(error: {
  readonly code?: unknown
  readonly message?: unknown
  readonly hint?: unknown
}): ForeshadowChannelReply {
  const code = typeof error.code === 'string' ? error.code : 'FORESHADOW_UNAVAILABLE'
  const message = typeof error.message === 'string' ? error.message : code
  const hint = typeof error.hint === 'string' ? error.hint : undefined
  return refused(STATUS_BY_CODE[code] ?? 500, code, message, hint)
}

/** The one write: same pipeline as `inkflow_foreshadow_upsert`, same codes, same gate. */
export async function foreshadowAdvanceReply(
  source: ForeshadowChannelSource,
  version: string,
  body: JsonRecord,
): Promise<ForeshadowChannelReply> {
  const slug = typeof body['slug'] === 'string' ? body['slug'].trim() : ''
  if (slug === '') {
    return refused(400, 'SLUG_REQUIRED', 'an advance names the entry it moves', 'pass slug: <file slug> — the pane derives it from the row')
  }

  const path = `foreshadowing/${slug}.md`
  const scanned = scanProject(source.root)
  const row = rowsOf<ForeshadowRow>(scanned, FORESHADOW_TABLE).find((candidate) => candidate.path === path)
  if (row === undefined) {
    return refused(
      404,
      'FORESHADOW_NOT_FOUND',
      `${path} is not in this book, so there is nothing to move`,
      'advance moves an existing entry; create one with inkflow_foreshadow_upsert',
    )
  }

  // Only the fields the tool itself takes, and the title from the file rather than from
  // the request: an advance must not be able to rename what it moves.
  const args: JsonRecord = { slug, title: row.title }
  for (const key of ['status', 'advancedAt', 'resolvedChapter', 'confirm'] as const) {
    const value = body[key]
    if (value !== undefined) args[key] = value
  }

  const result = await upsertForeshadow(source.root, args)
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
        declaredStatus: result['declaredStatus'] as ForeshadowStatus | undefined,
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
 * The foreshadow pane's one route.
 *
 * It lives in this module rather than in `routes.ts` for one mechanical reason and one
 * structural one: that file is on its recorded line budget (`scripts/check-guards.mjs`),
 * and the dispatcher's hardening (loopback host/origin/peer, the method list, the
 * body/query allowlists, the body cap) applies to every entry of one table wherever the
 * descriptor was written. A route declared here is exactly as guarded as one declared
 * inline. The board's read route (`GET /foreshadow`) stays where it is: this module is
 * the write half, and moving a working read route would be churn.
 */
export const FORESHADOW_ROUTES: readonly InternalRoute[] = [
  {
    // One legal state move on one existing entry. A write route, so it carries the
    // confirmation gate: the pane asks twice, and the pipeline is the net under that.
    name: 'foreshadow-advance',
    pattern: /^\/foreshadow\/advance$/,
    methods: ['POST'],
    query: [],
    body: FORESHADOW_ADVANCE_BODY_FIELDS,
    handle: ({ target, version, body }) => foreshadowAdvanceReply(target, version, body),
  },
]
