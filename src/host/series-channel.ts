/**
 * The series sync's channel half (#49): `GET /hub/series/plan` and
 * `POST /hub/series/apply`, for the 共享内容 page.
 *
 * WHY SO THIN. Everything that decides WHAT a sync would do lives in `series.ts`; this
 * file decides only whether a request may touch a book at all. The anchor rule is not
 * re-implemented here — it is #40's (`shared-channel.ts`: the `book` field must be the
 * canonical path of a **registered workspace**, then the four-state gate, then the
 * domain). A second copy of "which directory may I write into" is exactly how a panel
 * write path drifts away from its guard, so the two functions are imported.
 *
 * THE BODY WHITELIST is the guard ADR-0010 D6 #6 requires on every hub write: `book`,
 * `expected`, `decisions`, `confirm`. There is no `root`, no `path`, and no way to name
 * the shared library — the library's location is the plugin's configuration (ADR-0010
 * D5), and the only book this channel can touch is one the Host itself listed.
 *
 * `plan` is a GET because it writes nothing at all: no non-GET verb is allowed to mean
 * "read", or the write guards would end up covering reads and the page would need a
 * same-origin dance to preview a diff.
 */

import type { HostContext } from './context.js'
import type { SeriesDecisionChoice, SeriesExpectedRow, SeriesError } from './series.js'
import { applySeriesSync, buildSeriesPlan } from './series.js'
import { registeredBook, usableBook } from './shared-channel.js'
import type { SharedChannelReply } from './shared-channel.js'

/** Body fields `POST /hub/series/apply` accepts; anything else is 400. */
export const SERIES_APPLY_BODY_FIELDS = ['book', 'expected', 'decisions', 'confirm'] as const

type JsonRecord = Record<string, unknown>

function ok(value: JsonRecord): JsonRecord {
  return { ok: true, value }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Why each series code answers with which status.
 *
 * Only the codes this feature introduces: `SHARED_UNAVAILABLE` (the library cannot be
 * named) keeps #40's 200-with-`ok:false` meaning — "cannot answer", not a transport
 * failure — and everything else is a 400 the caller can fix by sending a different body.
 * A conflict block is a 409: the request was well formed, the book's state is what
 * refuses it.
 */
function statusOf(code: string): number {
  if (code === 'SHARED_UNAVAILABLE') return 200
  if (code === 'SERIES_CONFLICT_UNRESOLVED') return 409
  return 400
}

/**
 * The refusal envelope. `unresolved` travels with it: the panel has to name every row
 * still waiting for a decision, and a bare code would leave the author to guess which.
 */
function failure(error: SeriesError): SharedChannelReply {
  return {
    status: statusOf(error.code),
    body: {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.hint === undefined ? {} : { hint: error.hint }),
        ...(error.path === undefined ? {} : { path: error.path }),
        ...(error.unresolved === undefined ? {} : { unresolved: error.unresolved }),
      },
    },
  }
}

/** `expected` as the plan emitted it. Defensive: the panel may hand back anything. */
function parseExpected(value: unknown): SeriesExpectedRow[] {
  if (!Array.isArray(value)) return []
  const rows: SeriesExpectedRow[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as JsonRecord
    const entryId = text(record['entryId'])
    const action = text(record['action'])
    if (entryId === '' || action === '') continue
    rows.push({ entryId, action })
  }
  return rows
}

/** `decisions`: one `{entryId, decision}` per conflict. Unknown decisions are refused downstream. */
function parseDecisions(value: unknown): Array<{ entryId: string; decision: SeriesDecisionChoice }> {
  if (!Array.isArray(value)) return []
  const rows: Array<{ entryId: string; decision: SeriesDecisionChoice }> = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as JsonRecord
    const entryId = text(record['entryId'])
    const decision = text(record['decision'])
    if (entryId === '' || decision === '') continue
    // Kept as-is and validated by `series.ts`: one place decides what a legal decision is.
    rows.push({ entryId, decision: decision as SeriesDecisionChoice })
  }
  return rows
}

/** `GET /hub/series/plan?book=…` — what a sync would do. Writes nothing. */
export function seriesPlanReply(ctx: HostContext, dataDir: string, book: unknown): SharedChannelReply {
  const target = registeredBook(ctx, book)
  if (!target.ok) return target.reply
  const plan = buildSeriesPlan({ dataDir, root: target.root })
  if (!plan.ok) return failure(plan.error)
  return { status: 200, body: ok(plan.value as unknown as JsonRecord) }
}

/** `POST /hub/series/apply` — perform the approved plan, one decision per conflict. */
export function seriesApplyReply(ctx: HostContext, dataDir: string, body: JsonRecord): SharedChannelReply {
  const target = registeredBook(ctx, body['book'])
  if (!target.ok) return target.reply
  const unusable = usableBook(target.root)
  if (unusable !== undefined) return unusable

  const applied = applySeriesSync({
    dataDir,
    root: target.root,
    expected: parseExpected(body['expected']),
    decisions: parseDecisions(body['decisions']),
    confirm: body['confirm'] === true,
  })
  if (!applied.ok) return failure(applied.error)
  return { status: 200, body: ok(applied.value as unknown as JsonRecord) }
}
