/**
 * The private panel channel: `/inkflow/internal/*` (ADR-0008).
 *
 * It is NOT an API. There is no version segment, no OpenAPI, no compatibility
 * promise and no documentation for third parties (ADR-0008 D2). The only
 * consumer is this plugin's own Client half, shipped in lockstep with this file.
 * The old `/inkflow/api/*` prefix is gone and answers 404 — it never was a
 * contract, so there is no alias.
 *
 * FAIL-CLOSED, because the DSH web server carries no authentication of its own
 * (ADR-0004 clauses that ADR-0008 D3 keeps):
 *
 *   1. `Host` must be a loopback authority (defeats DNS rebinding).
 *   2. `Origin`, when present, must be a loopback origin (defeats cross-site fetch).
 *   3. The peer socket address must be loopback when it is reported at all.
 *   4. Methods are declared PER ROUTE (`ROUTES[].methods`), never as one blanket
 *      rule: every P0 route below is read-only and therefore GET-only.
 *   5. No CORS header is ever emitted; every response is `no-store` + `nosniff`.
 *   6. Bodies are capped (`MAX_INTERNAL_BODY_BYTES`) and must be a JSON object.
 *
 * THE BROWSER NAMES A SESSION, NEVER A DIRECTORY (ADR-0008 D4). The request may
 * carry `sessionId` (query or `x-inkflow-session`); `root`/`path`/`cwd`/
 * `workspace`/`projectRoot` in the query or body is a 400 before any filesystem
 * access, and the root itself is resolved from Host services in `internal.ts`.
 * A session that cannot be resolved answers HTTP 200 + `ok:false` +
 * `NO_SESSION_CONTEXT`: that is "cannot answer yet", not a transport failure.
 * A resolvable session whose directory fails the four-state gate answers the
 * same structured checklist the tools return, and nothing is written.
 *
 * WRITE ROUTES: seven live on this build — four chapter routes
 * (`POST /chapters`, `POST|DELETE /chapters/:id`, `POST /chapters/:id/move`),
 * the setting library's save (`POST /library/item`), and the recovery bin's two
 * actions (`POST /trash/restore`, `POST /trash/purge`). They are POST/DELETE
 * only, require `Content-Type: application/json` (415 otherwise) and require a
 * loopback `Origin` to be PRESENT (403 otherwise) — the same-origin check is
 * mandatory exactly for requests that write. Read routes keep working without
 * `Origin` because a same-origin `fetch` from the panel may omit it. The chapter
 * routes go through `chapters.ts`, the library save through `library-write.ts`,
 * the bin through `trash.ts`; never through this file: see `internal.ts` for the
 * domain mapping and the CAS plumbing.
 *
 * THE RECOVERY BIN (roadmap X-9/X-10) is one read route — `/trash` —
 * plus those two writes. An entry is addressed by its manifest `id`, so the
 * browser still names no directory; `POST /trash/purge` needs `confirm: true`
 * in the body, which is the second half of ADR-0012 decision 4.
 *
 * THE SETTING LIBRARY is three read routes — `/library` (the
 * eight-kind tree, X-7), `/library/item?kind=&id=` (one entry) and
 * `/library/issues` (`validation_issues`) — plus the one `POST /library/item`
 * save. All of them name an entity rather than a directory and reuse every
 * guard below unchanged.
 *
 * THE HUB CHANNEL IS SEPARATE (`/inkflow/internal/hub/*`, ADR-0010 D3): the
 * root-scoped book hub has no session, so those routes take their anchor from
 * the Host workspace registry instead (see `hub.ts`) and are dispatched before
 * the session chain. They reuse every guard above except the session itself:
 * loopback host/origin/peer, per-route methods, the path-parameter ban, the body
 * cap, and a body-field allowlist per route. A hub write route (`plan`/`apply`,
 * ADR-0010 D4) additionally requires an `Origin` that is the SAME ORIGIN as
 * `Host`, not merely loopback (ADR-0010 D6 guard 6).
 *
 * THE SHARED LIBRARY HAS TWO HALVES (ADR-0007). Browsing it is the one hub
 * read that belongs to no book (`/hub/shared`, ADR-0010 D5). Taking an entry INTO
 * a book (`/hub/shared/copies`, `/hub/shared/copy`, `/hub/shared/update`) is a hub
 * WRITE, so it needs the same-origin guard *and* an anchor: the request names
 * `book`, which must be the canonical path of a registered workspace — the panel
 * can write into a book the user already opened, and nowhere else. The shared
 * library itself is never a write target on any route (no "push" direction).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { HostContext } from './context.js'
import { HUB_SEGMENT, buildHubBooks } from './hub.js'
import { buildHubShared } from './hub-shared.js'
import {
  SHARED_COPY_BODY_FIELDS,
  SHARED_UPDATE_BODY_FIELDS,
  sharedCopiesReply,
  sharedCopyReply,
  sharedUpdateReply,
} from './shared-channel.js'
// The series sync reuses the shared library's anchor rule (`registeredBook`/`usableBook`) rather than
// restating "which directory may I write into" — one guard, one place.
import { SERIES_APPLY_BODY_FIELDS, seriesApplyReply, seriesPlanReply } from './series-channel.js'
import {
  HUB_BACKUP_CREATE_BODY_FIELDS,
  HUB_BACKUP_RESTORE_BODY_FIELDS,
  HUB_DIAGNOSTICS_EXPORT_BODY_FIELDS,
  HUB_SETTINGS_BODY_FIELDS,
  buildHubBackups,
  buildHubDiagnostics,
  buildHubSettings,
  createHubBackup,
  exportHubDiagnostics,
  planHubRestore,
  restoreHubBackup,
  writeHubSettings,
} from './hub-settings.js'
import { HUB_APPLY_BODY_FIELDS, HUB_PLAN_BODY_FIELDS, hubApply, hubPlan } from './hub-wizard.js'
// The export entry: a thin forwarder to `exportBook()`, so the page and `inkflow_export`
// are one computation (ADR-0024 入口归属).
import { HUB_EXPORT_BODY_FIELDS, hubExportOptions, hubExportReply } from './export-channel.js'
import { sharedRootOf } from './settings.js'
import {
  CANDIDATES_ACCEPT_BODY_FIELDS,
  CANDIDATES_PURGE_BODY_FIELDS,
  CANDIDATES_REJECT_BODY_FIELDS,
  CHAPTER_CREATE_BODY_FIELDS,
  CHAPTER_MOVE_BODY_FIELDS,
  CHAPTER_SAVE_BODY_FIELDS,
  INTERNAL_PREFIX,
  LIBRARY_WRITE_BODY_FIELDS,
  MAX_INTERNAL_BODY_BYTES,
  RENAME_BODY_FIELDS,
  SESSION_ID_HEADER,
  SESSION_ID_PARAM,
  acceptViaChannel,
  buildCandidates,
  buildChapter,
  buildChapters,
  buildForeshadowBoard,
  buildImpact,
  buildLibrary,
  buildLibraryItem,
  buildLibraryIssues,
  buildSearch,
  buildStatus,
  createChapterViaChannel,
  deleteChapterViaChannel,
  findPathParam,
  findPathParamInBody,
  isSessionId,
  moveChapterViaChannel,
  noSessionContextBody,
  purgeViaChannel,
  rejectViaChannel,
  renameEntity,
  resolveChannelTarget,
  writeChapterViaChannel,
  writeLibraryItem,
  TRASH_PURGE_BODY_FIELDS,
  TRASH_RESTORE_BODY_FIELDS,
  purgeTrashReply,
  restoreTrashReply,
  trashListReply,
  AUDIT_EXPORT_BODY_FIELDS,
  buildAudit,
  exportAudit,
  buildGate,
  buildReviewList,
  buildReviewCompare,
  IMPORT_BODY_FIELDS,
  importViaChannel,
  BRIEF_AUDIT_BODY_FIELDS,
  briefOptionsFromQuery,
  buildBrief,
  exportBriefAudit,
  PROPOSAL_APPLY_BODY_FIELDS,
  PROPOSAL_DECIDE_BODY_FIELDS,
  PROPOSAL_ROLLBACK_BODY_FIELDS,
  applyViaChannel as applyProposalViaChannel,
  buildProposals,
  decideViaChannel as decideProposalViaChannel,
  rollbackViaChannel as rollbackProposalViaChannel,
  BATCH_RESUME_BODY_FIELDS,
  buildBatchPage,
  resumeViaChannel as resumeBatchViaChannel,
  TIMELINE_ROUTES,
  FORESHADOW_ROUTES,
} from './internal.js'
import type { ChannelTarget, JsonRecord, WriteReply } from './internal.js'
import {
  LOOPBACK_AUTHORITY,
  LOOPBACK_ORIGIN,
  addressedByOf,
  failure,
  headerValue,
  isHttpMethod,
  isJsonContentType,
  isLoopbackPeer,
  isSameOrigin,
  ok,
  parseBody,
  readBody,
  readChapterReply,
  sendJson,
  sessionIdFrom,
  toReply,
  unexpectedBodyField,
  unexpectedQueryParam,
  withAddressedBy,
  writeRequestOf,
} from './routes-http.js'
import type { RouteMatch } from './routes-http.js'

import { PRIVATE_PURGE_ROUTES } from './private-purge-routes.js'
import { KNOWN_METHODS } from './route-types.js'
import { HUB_ROUTES, handleHubRequest, isHubPath, matchHubRoute } from './routes-hub.js'
import { ROUTES } from './routes-internal.js'
import type { HttpDeps, HttpMethod, InternalRoute, RouteInput, RouteReply } from './route-types.js'
import { MAX_QUERY_CHARS } from './search.js'
import { REPLACE_APPLY_BODY_FIELDS, replaceApplyReply, replacePreviewReply, searchAllFromQuery } from './search-channel.js'
import {
  SEMANTIC_HUB_BODY_FIELDS,
  buildHubSemantic,
  purgeHubSemantic,
  rebuildHubSemantic,
} from './ovk-hub.js'

const PREFIX = '/inkflow'

/**
 * The route contract (`HttpMethod` / `RouteInput` / `RouteReply` / `InternalRoute` /
 * `KNOWN_METHODS`) lives in `route-types.ts`: this file is at its line budget, and the purge
 * routes keep their descriptors next to the channel that answers them, so the shape
 * needs a home that is not "inside the biggest dispatch loop".
 */


/** One chapter, read-only. The request names an id; containment is the Host's job. */
function matchRoute(path: string): RouteMatch | undefined {
  for (const route of ROUTES) {
    const match = route.pattern.exec(path)
    if (match !== null) return { route, params: match.slice(1) }
  }
  return undefined
}

export function createHttpHandler(deps: HttpDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // ---- guards: identity of the peer, then of the page -------------------
    const host = headerValue(req, 'host')
    if (!LOOPBACK_AUTHORITY.test(host)) {
      sendJson(res, 403, failure('forbidden-host', { host }))
      return
    }
    const origin = headerValue(req, 'origin')
    if (origin !== '' && !LOOPBACK_ORIGIN.test(origin)) {
      sendJson(res, 403, failure('forbidden-origin', { origin }))
      return
    }
    if (!isLoopbackPeer(req)) {
      sendJson(res, 403, failure('forbidden-remote', { peer: 'non-loopback' }))
      return
    }

    // Only the pathname is trusted for routing; the query is read for the
    // session id and the forbidden-parameter check, never for a directory.
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (!path.startsWith(PREFIX)) {
      sendJson(res, 404, failure('not-found', { path }))
      return
    }
    // `/inkflow/api/*`, `/inkflow` and everything else under the prefix: gone.
    if (!path.startsWith(`${INTERNAL_PREFIX}/`)) {
      sendJson(res, 404, failure('not-found', { path }))
      return
    }
    const internalPath = path.slice(INTERNAL_PREFIX.length)

    // The hub channel is dispatched by its own table, before the session chain:
    // it takes no session and therefore never reaches `NO_SESSION_CONTEXT`.
    if (isHubPath(internalPath)) {
      await handleHubRequest({ deps, req, res, internalPath, url, origin, host })
      return
    }

    // A path parameter is refused before the route is even matched: no handler
    // and no filesystem access may run for it (ADR-0008 D4).
    const forbiddenQuery = findPathParam(url.searchParams.entries())
    if (forbiddenQuery !== undefined) {
      sendJson(res, 400, failure('ROOT_PARAM_NOT_ALLOWED', { reason: 'unexpected-path-param', param: forbiddenQuery, in: 'query' }))
      return
    }

    const matched = matchRoute(internalPath)
    if (matched === undefined) {
      sendJson(res, 404, failure('not-found', { path }))
      return
    }

    const method = (req.method ?? 'GET').toUpperCase()
    if (!isHttpMethod(method) || !matched.route.methods.includes(method)) {
      sendJson(res, 405, failure('method-not-allowed', { method, route: matched.route.name }), {
        allow: matched.route.methods.join(', '),
      })
      return
    }

    // A query key the route did not declare is a 400, before any filesystem access.
    // Silent acceptance is what made `?chapterID=` answer a DIFFERENT
    // chapter with HTTP 200 — a legal-looking response for a target that was dropped.
    const strayQuery = unexpectedQueryParam(url.searchParams, matched.route.query)
    if (strayQuery !== undefined) {
      sendJson(
        res,
        400,
        failure('UNKNOWN_QUERY_PARAM', {
          route: matched.route.name,
          param: strayQuery,
          allowed: [...matched.route.query, SESSION_ID_PARAM],
        }),
      )
      return
    }

    // ---- write guards (ADR-0008 D3): same-origin, JSON, declared fields -----
    // Only GET is a read in this channel, so any other declared verb is a write.
    const isWrite = method !== 'GET'
    if (isWrite) {
      // `Origin`, when it arrives, has already been checked for loipback above.
      //
      // An ABSENT `Origin` used to be a 403 `origin-required`. It is not, for two
      // measured reasons: a real panel save answered exactly
      // `forbidden-origin / origin-required` with every other guard satisfied, so
      // the header simply does not reach a Host write from that shell; and "no
      // Origin" is what a non-browser client looks like, not what a web page looks
      // like (a browser always sets it on a POST).
      //
      // What still keeps a cross-site page out, in this order: the peer and the
      // Host must both be loopback; a cross-origin JSON POST cannot skip its CORS
      // preflight, and this channel answers none; any other content type is a 415
      // below; and the request must name a session the Host resolves to a real book.
      // `Sec-Fetch-Site` is the second net for the one case a browser omits Origin:
      // a page that reached us cross-site still declares itself.
      if (origin === '') {
        const site = headerValue(req, 'sec-fetch-site').toLowerCase()
        if (site !== '' && site !== 'same-origin' && site !== 'none') {
          sendJson(
            res,
            403,
            failure('forbidden-origin', {
              reason: 'cross-site-fetch',
              site,
              hint: 'a write must come from the page this Host serves',
            }),
          )
          return
        }
      }
      if (!isJsonContentType(headerValue(req, 'content-type'))) {
        sendJson(
          res,
          415,
          failure('unsupported-media-type', { expected: 'application/json', hint: 'a write request must send a JSON object body' }),
        )
        return
      }
    }

    const body = await readBody(req)
    if (!body.ok) {
      sendJson(res, 413, failure('payload-too-large', { limitBytes: MAX_INTERNAL_BODY_BYTES }))
      return
    }
    const parsed = parseBody(body.text)
    if (!parsed.ok) {
      sendJson(res, 400, failure('invalid-body', { hint: 'send a JSON object, or no body at all' }))
      return
    }
    const forbiddenBody = findPathParamInBody(parsed.value)
    if (forbiddenBody !== undefined) {
      sendJson(res, 400, failure('ROOT_PARAM_NOT_ALLOWED', { reason: 'unexpected-path-param', param: forbiddenBody, in: 'body' }))
      return
    }
    if (isWrite && matched.route.body !== undefined) {
      const unexpected = unexpectedBodyField(parsed.value, matched.route.body)
      if (unexpected !== undefined) {
        sendJson(res, 400, failure('UNEXPECTED_BODY_FIELD', { field: unexpected, route: matched.route.name }))
        return
      }
    }

    // ---- the request's session, resolved by the Host ----------------------
    const sessionId = sessionIdFrom(req, url.searchParams, parsed.value)
    if (sessionId === undefined) {
      sendJson(res, 200, noSessionContextBody(deps.version))
      return
    }
    if (!isSessionId(sessionId)) {
      sendJson(res, 400, failure('SESSION_ID_INVALID', { hint: 'the session id is an identifier, not a path' }))
      return
    }
    const resolution = resolveChannelTarget(deps.ctx, sessionId, deps.version)
    if ('failure' in resolution) {
      // HTTP 200 + ok:false: the channel cannot answer for this session yet.
      sendJson(res, 200, resolution.failure)
      return
    }

    const reply = await matched.route.handle({
      target: resolution.target,
      method,
      query: url.searchParams,
      version: deps.version,
      dataDir: deps.dataDir,
      params: matched.params,
      body: parsed.value,
    })
    sendJson(res, reply.status, reply.body, reply.headers ?? {})
  }
}
