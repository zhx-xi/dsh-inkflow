/**
 * The book hub channel (`/inkflow/internal/hub/*`), which has NO session.
 *
 * WHY IT IS A FILE: the hub table answers a different question from the session tables — it
 * lists books and spends a plan token, and it is the only group whose writes require a
 * same-origin page rather than merely a loopback peer (ADR-0010 D6). Keeping it in the same
 * 1579-line module as the session routes meant every guard review had to re-establish which
 * half it was reading; now the boundary is the import list.
 *
 * It imports the plumbing from `routes-http.ts` and nothing from `routes.ts`, so the split
 * stays acyclic.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { HostContext } from './context.js'

import { HUB_EXPORT_BODY_FIELDS, hubExportOptions, hubExportReply } from './export-channel.js'
import { HUB_BACKUP_CREATE_BODY_FIELDS, HUB_BACKUP_RESTORE_BODY_FIELDS, HUB_DIAGNOSTICS_EXPORT_BODY_FIELDS, HUB_SETTINGS_BODY_FIELDS, buildHubBackups, buildHubDiagnostics, buildHubSettings, createHubBackup, exportHubDiagnostics, planHubRestore, restoreHubBackup, writeHubSettings } from './hub-settings.js'
import { buildHubShared } from './hub-shared.js'
import { HUB_APPLY_BODY_FIELDS, HUB_PLAN_BODY_FIELDS, hubApply, hubPlan } from './hub-wizard.js'
import { HUB_SEGMENT, buildHubBooks } from './hub.js'
import { buildHubModels } from './hub-models.js'
import { MAX_INTERNAL_BODY_BYTES, SESSION_ID_PARAM, findPathParam, findPathParamInBody } from './internal.js'
import type { JsonRecord } from './internal.js'
import { SEMANTIC_HUB_BODY_FIELDS, buildHubSemantic, purgeHubSemantic, rebuildHubSemantic } from './ovk-hub.js'
import type { HttpDeps, HttpMethod, InternalRoute, RouteReply } from './route-types.js'
import { failure, headerValue, isHttpMethod, isJsonContentType, isSameOrigin, ok, parseBody, readBody, sendJson, sessionIdFrom, unexpectedBodyField, unexpectedQueryParam } from './routes-http.js'
import { SERIES_APPLY_BODY_FIELDS, seriesApplyReply, seriesPlanReply } from './series-channel.js'
import { sharedRootOf } from './settings.js'
import { SHARED_COPY_BODY_FIELDS, SHARED_UPDATE_BODY_FIELDS, sharedCopiesReply, sharedCopyReply, sharedUpdateReply } from './shared-channel.js'


// ---------------------------------------------------------------------------
// The hub channel: `/inkflow/internal/hub/*` — no session, no path (ADR-0010 D3)
//
// A root-scoped panel has no session, so these routes deliberately do NOT use
// the session chain above. Their anchor is the Host workspace registry plus the
// absolute refusal set (ADR-0010 D6), and the browser still names nothing: the
// same path-parameter ban applies, so `?root=`/`{path}` is a 400 before any
// filesystem access. What is different, and stays different on purpose:
//
//   * no `sessionId` is required, and one that arrives is ignored (not refused):
//     the same panel may be opened from a session page, and a stray query
//     argument must not turn a global list into a session-scoped one;
//   * no session is resolved, so no `NO_SESSION_CONTEXT` is possible here;
//   * a write route (`plan`/`apply`) must carry an `Origin` that is the SAME
//     ORIGIN as `Host`, not merely a loopback one (ADR-0010 D6 guard 6).
// ---------------------------------------------------------------------------

export interface HubRouteInput {
  ctx: HostContext
  version: string
  /**
   * The plugin's own data directory, as `config.ts` resolved it at startup. The
   * shared library is the only thing under a hub route that lives outside any
   * book, so it is also the only consumer — and it comes from the plugin's
   * configuration, never from the request (ADR-0010 D5).
   */
  dataDir: string
  method: HttpMethod
  query: URLSearchParams
  body: JsonRecord
}

export interface HubRoute {
  readonly name: string
  readonly pattern: RegExp
  readonly methods: readonly HttpMethod[]
  /**
   * The body fields this route accepts. Anything else is 400
   * `UNEXPECTED_BODY_FIELD`: the wizard takes exactly one path-bearing field
   * (`candidate`, plan only) and one credential (`planToken`, apply only), so a
   * client cannot smuggle a directory or a future knob past the guards.
   */
  readonly body?: readonly string[]
  /**
   * The only QUERY keys this hub route reads — the same **required** declaration the
   * session channel carries (`InternalRoute.query`).
   *
   * Required here too, on purpose: `/hub/*` had the identical blind spot (a handler read
   * `book` and silently ignored every other key, so a typo answered the default book with
   * HTTP 200 and nothing to see). One declaration shape for both channels means the
   * 400 `UNKNOWN_QUERY_PARAM` decision is written once (`unexpectedQueryParam`), and the
   * third state — "nobody declared anything" — cannot come back.
   */
  readonly query: readonly string[]
  readonly handle: (input: HubRouteInput) => Promise<RouteReply> | RouteReply
}

/**
 * The hub's capability whitelist (ADR-0010 D3/D4). Two read routes (`books`,
 * `shared`), and the wizard's two POST steps (`plan`, `apply`) which
 * additionally require an `Origin` that is the SAME ORIGIN as `Host` (D6 guard 6) —
 * see `handleHubRequest`. Every capability declares its own verb here; there is
 * never a blanket write switch.
 */
export const HUB_ROUTES: readonly HubRoute[] = [
  {
    name: 'hub-books',
    pattern: /^\/hub\/books$/,
    methods: ['GET'],
    query: [],
    handle: async ({ ctx, dataDir, version }) => {
      // `dataDir` is what makes the semantic badge possible: its coverage is read from the
      // plugin's own ledger and settings, never from the book.
      const result = await buildHubBooks(ctx, { pluginVersion: version, dataDir })
      if (result.ok) return { status: 200, body: ok(result.value) }
      return { status: 200, body: failure(result.error.code, { message: result.error.message, hint: result.error.hint }) }
    },
  },
  {
    // The only route on this channel that accepts a PATH — and only as
    // `candidate`, because `root`/`path`/`cwd`/`workspace`/`projectRoot` are
    // refused before any handler runs. Read-only: no token is issued for a
    // book the user already has (ADR-0010 D4 step 2).
    name: 'hub-plan',
    pattern: /^\/hub\/plan$/,
    methods: ['POST'],
    query: [],
    body: HUB_PLAN_BODY_FIELDS,
    handle: ({ ctx, body }) => hubPlan(ctx, body),
  },
  {
    // The write route names NO path at all: a one-shot token plus `confirm`
    // (ADR-0010 D3 "为什么 plan 要一个路径、而 apply 不要").
    name: 'hub-apply',
    pattern: /^\/hub\/apply$/,
    methods: ['POST'],
    query: [],
    body: HUB_APPLY_BODY_FIELDS,
    handle: ({ ctx, body }) => hubApply(ctx, body),
  },
  {
    // The export entry (ADR-0024 D4 / 入口归属). Two routes and no new semantics: the
    // read half serves what the page may offer (volumes + the three vocabularies, straight
    // from `export.ts`), the write half forwards to `exportBook()` — the SAME function
    // `inkflow_export` calls, so the panel and the tool cannot drift apart.
    //
    // Two route objects rather than one with two verbs: a route declares its verbs AND its
    // guards together, and a GET must not inherit the write guards. They therefore need
    // different paths (`/hub/export/options` vs `/hub/export`), because this channel has no
    // method-based dispatch — which is exactly what keeps a write off a read route.
    name: 'hub-export-options',
    pattern: /^\/hub\/export\/options$/,
    methods: ['GET'],
    query: ['book'],
    handle: ({ ctx, dataDir, query }) => hubExportOptions(ctx, dataDir, query.get('book')),
  },
  {
    // No `confirm` field and no `planToken`: ADR-0024's判据 is "can it overwrite or delete",
    // and a stamped export name can never do either. The hub write guards (same-origin
    // `Origin`, JSON body, field whitelist) still apply, because this route does write a file.
    name: 'hub-export',
    pattern: /^\/hub\/export$/,
    methods: ['POST'],
    query: [],
    body: HUB_EXPORT_BODY_FIELDS,
    handle: ({ ctx, dataDir, body }) => hubExportReply(ctx, dataDir, body),
  },
  {
    // The shared library (ADR-0010 D5): read-only browsing of
    // `dataDir/shared`, the one hub surface that belongs to no book. There is no
    // anchor to resolve and nothing to accept from the caller — the root comes
    // from the plugin config, and the route takes only `kind?`/`q?` filters.
    name: 'hub-shared',
    pattern: /^\/hub\/shared$/,
    methods: ['GET'],
    query: ['kind', 'q'],
    handle: ({ dataDir, query }) => {
      // The root comes from the settings file: `dataDir/shared` unless the
      // author configured `sharedRoot`. A value the plugin refuses is reported in
      // the answer (`sharedRootWarning`) instead of being silently re-rooted.
      const shared = sharedRootOf(dataDir)
      const result = buildHubShared(shared.root, {
        kind: query.get('kind') ?? undefined,
        q: query.get('q') ?? undefined,
        ...(shared.warning === undefined ? {} : { rootWarning: shared.warning }),
      })
      if (result.ok) return { status: 200, body: ok(result.value) }
      return { status: 200, body: failure(result.error.code, { message: result.error.message, hint: result.error.hint }) }
    },
  },
  {
    // What this book already holds from the library, and how fresh each copy is
    // (ADR-0007 C3 — "stale" is a report, never a repair). Read-only: it hashes
    // the library and reads each copy's head; the library's own manifest is not
    // written back here either (that stays derived).
    //
    // `book` is the second path-shaped field this channel accepts besides the
    // wizard's `candidate`, and it means "a REGISTERED workspace, named exactly as
    // /hub/books listed it": `shared-channel.ts` refuses anything else before the
    // filesystem is touched, so the panel cannot copy into a directory the user has
    // not opened.
    name: 'hub-shared-copies',
    pattern: /^\/hub\/shared\/copies$/,
    methods: ['GET'],
    query: ['book'],
    handle: ({ ctx, dataDir, query }) => sharedCopiesReply(ctx, dataDir, query.get('book') ?? undefined),
  },
  {
    // The default take-out action (ADR-0007 C2): copy one entry into a book. A hub
    // write, so the same-origin `Origin` guard above applies, and `confirm` is the
    // second half of ADR-0006 D3's discipline.
    name: 'hub-shared-copy',
    pattern: /^\/hub\/shared\/copy$/,
    methods: ['POST'],
    query: [],
    body: SHARED_COPY_BODY_FIELDS,
    handle: ({ ctx, dataDir, body }) => sharedCopyReply(ctx, dataDir, body),
  },
  {
    // Refresh ONE stale copy. Explicit by design: the previous bytes go into
    // `.inkflow/backup/<stamp>/` before the write, so "undo that refresh" does not
    // depend on git (ADR-0012), and nothing happens without `confirm: true`.
    name: 'hub-shared-update',
    pattern: /^\/hub\/shared\/update$/,
    methods: ['POST'],
    query: [],
    body: SHARED_UPDATE_BODY_FIELDS,
    handle: ({ ctx, dataDir, body }) => sharedUpdateReply(ctx, dataDir, body),
  },
  {
    // The series sync: what a sync would do to ONE registered book. A GET because it
    // writes nothing at all — previewing a diff must not need the write guards, and the
    // plan is exactly what `apply` compares against (X-17).
    name: 'hub-series-plan',
    pattern: /^\/hub\/series\/plan$/,
    methods: ['GET'],
    query: ['book'],
    handle: ({ ctx, dataDir, query }) => seriesPlanReply(ctx, dataDir, query.get('book') ?? undefined),
  },
  {
    // Performing the approved plan. A hub write, so every guard above applies; `confirm`
    // is the net under the panel's armed button, and every conflict needs a decision or
    // the answer is SERIES_CONFLICT_UNRESOLVED with zero writes.
    name: 'hub-series-apply',
    pattern: /^\/hub\/series\/apply$/,
    methods: ['POST'],
    query: [],
    body: SERIES_APPLY_BODY_FIELDS,
    handle: ({ ctx, dataDir, body }) => seriesApplyReply(ctx, dataDir, body),
  },
  {
    // The settings page (ADR-0018 D1): settings live OUTSIDE every book, so this
    // route takes no anchor at all. It also carries the book choices the backup
    // section offers (id + title, never a path) and the retention rule in force.
    name: 'hub-settings',
    pattern: /^\/hub\/settings$/,
    methods: ['GET'],
    query: [],
    handle: ({ ctx, dataDir, version }) => ({ status: 200, body: ok(buildHubSettings({ ctx, dataDir, version })) }),
  },
  {
    // Saving settings. A write, so it carries every hub write guard (same-origin
    // `Origin`, the body whitelist) plus `confirm: true`: the panel arms its own
    // button, and this is the net under it.
    //
    // The whitelist is DERIVED (`SETTINGS_FIELDS` + `confirm`): this route is the
    // one that shipped a hand-copied field list and nearly refused a legal setting, so
    // the list lives beside the function that reads it (`writeHubSettings`) instead.
    name: 'hub-settings-update',
    pattern: /^\/hub\/settings\/update$/,
    methods: ['POST'],
    query: [],
    body: HUB_SETTINGS_BODY_FIELDS,
    handle: ({ ctx, dataDir, version, body }) => reply(writeHubSettings({ ctx, dataDir, version }, body)),
  },
  {
    // The diagnostics PREVIEW (D5): built, never written — the page shows the
    // summary and the target name before the user confirms the export.
    name: 'hub-diagnostics',
    pattern: /^\/hub\/diagnostics$/,
    methods: ['GET'],
    query: ['book'],
    handle: ({ ctx, dataDir, version, query }) =>
      reply(buildHubDiagnostics({ ctx, dataDir, version }, query.get('book') ?? undefined)),
  },
  {
    name: 'hub-diagnostics-export',
    pattern: /^\/hub\/diagnostics\/export$/,
    methods: ['POST'],
    query: [],
    body: HUB_DIAGNOSTICS_EXPORT_BODY_FIELDS,
    handle: ({ ctx, dataDir, version, body }) => reply(exportHubDiagnostics({ ctx, dataDir, version }, body)),
  },
  {
    // The model catalog the subagent switch offers (read-only, no anchor, no query).
    //
    // `ok: false` here is NOT a transport failure: the channel still answers HTTP 200,
    // and the page turns that into "type it by hand" — "I cannot list the models" must
    // never become "you cannot save a model". Two failure shapes are deliberate:
    // `LLM_UNAVAILABLE` (no `llm` service in this profile) and `LLM_TIMEOUT` (the 2 s
    // deadline expired); a provider whose own listing throws is reported as an empty
    // model list rather than as a failed catalog.
    name: 'hub-models',
    pattern: /^\/hub\/models$/,
    methods: ['GET'],
    query: [],
    handle: async ({ ctx }) => {
      const result = await buildHubModels(ctx)
      // Two successes are visible on the wire: `LLM_UNAVAILABLE` and `LLM_TIMEOUT` are
      // ordinary answers here (HTTP 200 + `ok:false`), because the page has a degraded
      // state for them and a transport error would only be retried.
      if (result.ok) return { status: 200, body: ok({ providers: result.value.providers, timeoutMs: result.value.timeoutMs }) }
      return {
        status: 200,
        body: failure(result.error.code, { message: result.error.message, hint: result.error.hint }),
      }
    },
  },
  {
    // The backup list of ONE book. The anchor is a registered book path, a registry id
    // or a directory name — nothing outside the registry is accepted, and an ambiguous
    // name is refused rather than guessed.
    name: 'hub-backups',
    pattern: /^\/hub\/backups$/,
    methods: ['GET'],
    query: ['book'],
    handle: ({ ctx, dataDir, version, query }) => reply(buildHubBackups({ ctx, dataDir, version }, query.get('book'))),
  },
  {
    name: 'hub-backups-create',
    pattern: /^\/hub\/backups\/create$/,
    methods: ['POST'],
    query: [],
    body: HUB_BACKUP_CREATE_BODY_FIELDS,
    handle: ({ ctx, dataDir, version, body }) => reply(createHubBackup({ ctx, dataDir, version }, body)),
  },
  {
    // The restore preview: read-only, and it is what produces the per-file `current`
    // digests the execute call hands back as `expected` (D6).
    name: 'hub-backups-plan',
    pattern: /^\/hub\/backups\/plan$/,
    methods: ['GET'],
    // `planHubRestore(deps, query)` reads BOTH keys: `book` (which book) and `file`
    // (which package to preview). Declaring only `book` would refuse the call the panel
    // actually makes — the list's own "preview" button carries the file name.
    query: ['book', 'file'],
    handle: ({ ctx, dataDir, version, query }) => reply(planHubRestore({ ctx, dataDir, version }, query)),
  },
  {
    name: 'hub-backups-restore',
    pattern: /^\/hub\/backups\/restore$/,
    methods: ['POST'],
    query: [],
    body: HUB_BACKUP_RESTORE_BODY_FIELDS,
    handle: async ({ ctx, dataDir, version, body }) => reply(await restoreHubBackup({ ctx, dataDir, version }, body)),
  },
  {
    // Semantic retrieval: status + estimate for ONE book, on the page that owns the
    // settings that decide whether it can work at all. The anchor is a registered book, like
    // the backup section above — never a path (ADR-0010 D3), and never the endpoint itself:
    // the connection comes from `settings.json` (ADR-0020 E1), so no request can point this
    // plugin at another server.
    name: 'hub-semantic',
    pattern: /^\/hub\/semantic$/,
    methods: ['GET'],
    query: ['book'],
    handle: async ({ ctx, dataDir, version, query }) =>
      reply(await buildHubSemantic({ ctx, dataDir, version }, query.get('book'))),
  },
  {
    // The rebuild: `confirm` is the net under the panel's armed button, and above the
    // first-build thresholds an unconfirmed call answers CONFIRM_REQUIRED with the estimate.
    name: 'hub-semantic-rebuild',
    pattern: /^\/hub\/semantic\/rebuild$/,
    methods: ['POST'],
    query: [],
    body: SEMANTIC_HUB_BODY_FIELDS,
    handle: async ({ ctx, dataDir, version, body }) => reply(await rebuildHubSemantic({ ctx, dataDir, version }, body)),
  },
  {
    // The purge — the only route that can make OVK physically delete something, and only for
    // blocks the ledger records as tombstones (ADR-0009 P6).
    name: 'hub-semantic-purge',
    pattern: /^\/hub\/semantic\/purge$/,
    methods: ['POST'],
    query: [],
    body: SEMANTIC_HUB_BODY_FIELDS,
    handle: async ({ ctx, dataDir, version, body }) => reply(await purgeHubSemantic({ ctx, dataDir, version }, body)),
  },
]

/** Turn a hub module's `{ok,value|error}` into the channel's reply envelope. */
function reply(result: { ok: true; value: JsonRecord } | { ok: false; error: { code: string; message: string; hint?: string } }): RouteReply {
  if (result.ok) return { status: 200, body: ok(result.value) }
  return {
    status: 200,
    body: failure(result.error.code, {
      message: result.error.message,
      ...(result.error.hint === undefined ? {} : { hint: result.error.hint }),
    }),
  }
}

export function matchHubRoute(path: string): HubRoute | undefined {
  for (const route of HUB_ROUTES) {
    if (route.pattern.test(path)) return route
  }
  return undefined
}

/** `/hub` is the segment after `/inkflow/internal`; the route table lives here. */
export function isHubPath(internalPath: string): boolean {
  return internalPath === HUB_SEGMENT || internalPath.startsWith(`${HUB_SEGMENT}/`)
}

/**
 * Same-origin, not merely loopback (ADR-0010 D6 guard 6).
 *
 * The session channel's write routes only need a loopback `Origin`, because the
 * Host derives their path from a session it resolved itself. A hub WRITE is
 * different: `plan` takes a directory the user picked and `apply` spends the
 * token it minted, so "another page on this machine" must not be able to drive
 * it — only the page the Host is serving (same scheme-less authority, port
 * included).
 */
export async function handleHubRequest(input: {
  deps: HttpDeps
  req: IncomingMessage
  res: ServerResponse
  internalPath: string
  url: URL
  origin: string
  host: string
}): Promise<void> {
  const { deps, req, res, internalPath, url, origin, host } = input

  // A path parameter is refused before the route is even matched: no handler and
  // no filesystem access may run for it (ADR-0010 D6 guard 5).
  const forbiddenQuery = findPathParam(url.searchParams.entries())
  if (forbiddenQuery !== undefined) {
    sendJson(res, 400, failure('ROOT_PARAM_NOT_ALLOWED', { reason: 'unexpected-path-param', param: forbiddenQuery, in: 'query' }))
    return
  }

  const route = matchHubRoute(internalPath)
  if (route === undefined) {
    sendJson(res, 404, failure('not-found', { path: internalPath }))
    return
  }

  const method = (req.method ?? 'GET').toUpperCase()
  if (!isHttpMethod(method) || !route.methods.includes(method)) {
    sendJson(res, 405, failure('method-not-allowed', { method, route: route.name }), { allow: route.methods.join(', ') })
    return
  }

  // The hub's half: `book` is how a hub call names the book it means, and a
  // misspelt key used to answer the DEFAULT book with HTTP 200. Same decision function as
  // the session channel, same 400, same body — a caller that gets it wrong on one channel
  // does not get a different answer on the other. Checked before any handler and any IO.
  const strayHubQuery = unexpectedQueryParam(url.searchParams, route.query)
  if (strayHubQuery !== undefined) {
    sendJson(
      res,
      400,
      failure('UNKNOWN_QUERY_PARAM', {
        route: route.name,
        param: strayHubQuery,
        allowed: [...route.query, SESSION_ID_PARAM],
      }),
    )
    return
  }

  // Write guards (ADR-0010 D6 guards 6/7): the hub's POST routes are `plan`/`apply`.
  // Read routes stay usable without an `Origin` — a same-origin `fetch` from the
  // panel may omit it — but a write must come from the page the Host serves.
  if (method !== 'GET') {
    if (origin === '') {
      sendJson(res, 403, failure('forbidden-origin', { reason: 'origin-required', hint: 'a hub write must carry the hosting page’s Origin' }))
      return
    }
    if (!isSameOrigin(origin, host)) {
      sendJson(
        res,
        403,
        failure('forbidden-origin', {
          reason: 'origin-mismatch',
          origin,
          host,
          hint: 'a hub write must be same-origin with the Host, not merely loopback',
        }),
      )
      return
    }
    if (!isJsonContentType(headerValue(req, 'content-type'))) {
      sendJson(
        res,
        415,
        failure('unsupported-media-type', { expected: 'application/json', hint: 'a hub write must send a JSON object body' }),
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
  if (method !== 'GET' && route.body !== undefined) {
    const unexpected = unexpectedBodyField(parsed.value, route.body)
    if (unexpected !== undefined) {
      sendJson(res, 400, failure('UNEXPECTED_BODY_FIELD', { field: unexpected, route: route.name }))
      return
    }
  }

  const reply = await route.handle({
    ctx: deps.ctx,
    version: deps.version,
    dataDir: deps.dataDir,
    method,
    query: url.searchParams,
    body: parsed.value,
  })
  sendJson(res, reply.status, reply.body, reply.headers ?? {})
}

