/**
 * The semantic-retrieval section of the settings page (root-scoped hub channel).
 *
 * WHY THE PANEL'S SECTION IS A HUB ROUTE AND NOT A SESSION ONE. The settings page lives in
 * the book hub (roadmap X-20), so it has no session to derive a project from — the same
 * anchoring problem `hub-settings.ts` already solves for backups and the diagnostics
 * package. It therefore names a book the same way: a registry id, a registered path or a
 * directory name, resolved by `resolveHubBook` and never taken as a path from the client
 * (ADR-0008 D4, ADR-0010 D3).
 *
 * WHAT IT ADDS OVER THE TOOLS. Nothing about the operations — those live in `ovk-status.ts`
 * and are shared. What is different is what a panel needs before it can offer a button: the
 * count of chapters that would be written, the block estimate and whether the rebuild needs
 * a confirmation at all. The page shows that estimate next to the button (ADR-0009 P10: the
 * author must see the size and the cost before a first build).
 */

import type { HostContext } from './context.js'
import type { HubReply } from './hub-settings.js'
import { resolveHubBook } from './hub-settings.js'
import { ensureIndex } from './index-freshness.js'
import { estimateRebuild, purgeApply, purgePlanOf, rebuildNow, semanticStatusOf } from './ovk-status.js'

type Json = Record<string, unknown>

export interface SemanticHubDeps {
  readonly ctx: HostContext
  readonly dataDir: string
  readonly version: string
}

function failed(code: string, message: string, hint: string): HubReply<Json> {
  return { ok: false, error: { code, message, hint } }
}

/**
 * `GET /hub/semantic?book=…`: status + estimate for one book.
 *
 * The index is refreshed first because the estimate counts chapters, and a panel that showed
 * "12 chapters" for a book of 300 (a stale index) would be lying about the size of the
 * action it is offering.
 */
export async function buildHubSemantic(deps: SemanticHubDeps, anchor: unknown): Promise<HubReply<Json>> {
  const book = resolveHubBook(deps.ctx, anchor)
  if (!book.ok) return book
  const ensured = await ensureIndex(book.value.root)
  const status = await semanticStatusOf(book.value.root, { dataDir: deps.dataDir })
  const estimate = estimateRebuild(book.value.root, { dataDir: deps.dataDir })
  return {
    ok: true,
    value: {
      pluginVersion: deps.version,
      book: { slug: book.value.slug, title: book.value.title },
      indexRebuilt: ensured.ok ? ensured.rebuilt : false,
      indexState: ensured.state,
      ...(ensured.ok ? {} : { indexError: { code: ensured.failure.code, message: ensured.failure.message } }),
      status,
      estimate: estimate.ok ? estimate.estimate : null,
      thresholds: status.thresholds,
    },
  }
}

/** `POST /hub/semantic/rebuild`: the estimate when unconfirmed, the run when confirmed. */
export async function rebuildHubSemantic(deps: SemanticHubDeps, body: Json): Promise<HubReply<Json>> {
  const book = resolveHubBook(deps.ctx, body['book'])
  if (!book.ok) return book
  const ensured = await ensureIndex(book.value.root)
  if (!ensured.ok) {
    return failed('INDEX_UNAVAILABLE', ensured.failure.message, 'the chapter list comes from the derived index; fix it and retry')
  }
  const estimated = estimateRebuild(book.value.root, { dataDir: deps.dataDir })
  if (!estimated.ok) {
    return failed('INDEX_UNAVAILABLE', 'the derived index cannot be read', 'rebuild the index and retry')
  }
  const estimate = estimated.estimate
  if (body['confirm'] !== true) {
    if (estimate.requiresConfirm) {
      return failed(
        'CONFIRM_REQUIRED',
        `this build would write ${String(estimate.chapters)} chapters / ${String(estimate.blocks)} blocks and costs ${String(estimate.calls)} summary calls`,
        'show the estimate next to the button, then post confirm: true',
      )
    }
    // Below the threshold an unconfirmed call still writes nothing: the panel arms its own
    // button, and "the estimate arrived" is the answer to an unarmed one.
    return { ok: true, value: { book: { slug: book.value.slug, title: book.value.title }, estimate, requiresConfirm: false, executed: false } }
  }
  const run = await rebuildNow(book.value.root, { dataDir: deps.dataDir })
  if (!run.ok) return failed('SEMANTIC_UNAVAILABLE', run.detail, `fix the ${run.reason} reason reported by the status section and retry`)
  return {
    ok: true,
    value: {
      book: { slug: book.value.slug, title: book.value.title },
      estimate,
      requiresConfirm: estimate.requiresConfirm,
      executed: true,
      status: run.outcome.status,
      summary: run.outcome.summary,
      staleChapters: run.outcome.staleChapters,
    },
  }
}

/** `POST /hub/semantic/purge`: the list when unconfirmed, the run when confirmed. */
export async function purgeHubSemantic(deps: SemanticHubDeps, body: Json): Promise<HubReply<Json>> {
  const book = resolveHubBook(deps.ctx, body['book'])
  if (!book.ok) return book
  const uris = purgePlanOf(book.value.root, { dataDir: deps.dataDir })
  const bookWire = { slug: book.value.slug, title: book.value.title }
  if (uris.length === 0) {
    return { ok: true, value: { book: bookWire, uris: [], deleted: [], requiresConfirm: false, executed: false } }
  }
  if (body['confirm'] !== true) {
    return { ok: true, value: { book: bookWire, uris, deleted: [], requiresConfirm: true, executed: false } }
  }
  const run = await purgeApply(book.value.root, { dataDir: deps.dataDir })
  if (!run.ok) return failed('SEMANTIC_UNAVAILABLE', run.detail, `fix the ${run.reason} reason reported by the status section and retry`)
  if (run.outcome.deleted.length === 0 && run.outcome.stoppedAt !== undefined) {
    // The first URI failed, so nothing was deleted: reporting a completed purge would let the
    // page clear its section while every tombstone is still there.
    return failed('SEMANTIC_PURGE_FAILED', `nothing was deleted: ${run.outcome.stoppedAt.detail}`, 'the tombstone list is unchanged; fix the transport and retry')
  }
  return {
    ok: true,
    value: {
      book: bookWire,
      uris,
      deleted: run.outcome.deleted,
      requiresConfirm: true,
      executed: true,
      ...(run.outcome.stoppedAt === undefined ? {} : { stoppedAt: run.outcome.stoppedAt }),
    },
  }
}

/** Body fields the two write routes accept (nothing path-shaped ever travels). */
export const SEMANTIC_HUB_BODY_FIELDS = ['book', 'confirm'] as const
