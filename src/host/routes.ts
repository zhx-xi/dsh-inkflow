/**
 * The private panel channel: `/inkflow/internal/*` (ADR-0008, issue #18).
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
 * THE RECOVERY BIN (issue #35, roadmap X-9/X-10) is one read route — `/trash` —
 * plus those two writes. An entry is addressed by its manifest `id`, so the
 * browser still names no directory; `POST /trash/purge` needs `confirm: true`
 * in the body, which is the second half of ADR-0012 #4.
 *
 * THE SETTING LIBRARY (issue #30) is three read routes — `/library` (the
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
 * `Host`, not merely loopback (ADR-0010 D6 #6).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { HostContext } from './context.js'
import { sharedDir } from './config.js'
import { HUB_SEGMENT, buildHubBooks } from './hub.js'
import { buildHubShared } from './hub-shared.js'
import { hubApply, hubPlan } from './hub-wizard.js'
import {
  INTERNAL_PREFIX,
  LIBRARY_WRITE_BODY_FIELDS,
  MAX_INTERNAL_BODY_BYTES,
  RENAME_BODY_FIELDS,
  SESSION_ID_HEADER,
  SESSION_ID_PARAM,
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
  IMPORT_BODY_FIELDS,
  importViaChannel,
} from './internal.js'
import type { ChannelTarget, JsonRecord, WriteReply } from './internal.js'

const PREFIX = '/inkflow'
const LOOPBACK_AUTHORITY = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i
const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i
/** Node reports IPv4 peers of a dual-stack socket as `::ffff:127.0.0.1`. */
const LOOPBACK_PEER = /^(?:127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/i

export interface HttpDeps {
  ctx: HostContext
  dataDir: string
  version: string
}

/** Only the verbs the channel will ever declare; anything else is a 405. */
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const KNOWN_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

interface RouteInput {
  target: ChannelTarget
  /** The verb that actually arrived; a route may declare several. */
  method: HttpMethod
  query: URLSearchParams
  version: string
  /** `pattern` capture groups, still percent-encoded. */
  params: readonly string[]
  /** Parsed JSON object body (empty for a bodyless request). */
  body: JsonRecord
}

interface RouteReply {
  status: number
  body: JsonRecord
  headers?: Record<string, string>
}

interface InternalRoute {
  /** Human name for tests/logs, not a wire value. */
  readonly name: string
  readonly pattern: RegExp
  /** Declared per route. A verb outside this list is a 405 with `Allow`. */
  readonly methods: readonly HttpMethod[]
  /**
   * The only body fields this route accepts (writes only; `sessionId` is always
   * allowed). Anything else is a 400 `UNEXPECTED_BODY_FIELD`, so a client
   * cannot smuggle a directory or a future knob past the guards.
   */
  readonly body?: readonly string[]
  /**
   * Read routes may have to make the derived index fresh first (issue #5), so a
   * handler is allowed to be async; the dispatcher awaits it either way.
   */
  readonly handle: (input: RouteInput) => RouteReply | Promise<RouteReply>
}

function ok(value: JsonRecord): JsonRecord {
  return { ok: true, value }
}

function failure(code: string, extra: JsonRecord = {}): JsonRecord {
  return { ok: false, error: { code, ...extra } }
}

/**
 * Reads are GET; anything else declared here is a write and must satisfy the
 * write guards below. Each entry declares its own method list, so adding a write
 * route means writing `methods: ['POST']` next to this comment — not flipping a
 * global switch. One entry per pattern: `/chapters/:id` answers GET (detail),
 * POST (save) and DELETE (delete) from the same capture group.
 */
const ROUTES: readonly InternalRoute[] = [
  {
    name: 'status',
    pattern: /^\/status$/,
    methods: ['GET'],
    handle: ({ target, version }) => ({ status: 200, body: ok(buildStatus(target, version)) }),
  },
  {
    name: 'chapters',
    pattern: /^\/chapters$/,
    methods: ['GET', 'POST'],
    body: ['sessionId', 'title', 'volumeId', 'slug', 'seq'],
    handle: async (input) =>
      input.method === 'POST'
        ? toReply(await createChapterViaChannel(writeRequestOf(input)))
        : { status: 200, body: ok(await buildChapters(input.target, input.version)) },
  },
  {
    name: 'chapter',
    pattern: /^\/chapters\/([^/]+)$/,
    methods: ['GET', 'POST', 'DELETE'],
    // `eol`/`bom` are the file's own format, read from `GET /chapters/:id` and
    // handed back on save (ADR-0016): without them the write door can only
    // normalise, which rewrites a CRLF chapter to LF. Both are validated by
    // `internal.ts` — the whitelist is about *which* fields may travel, not what
    // values they carry.
    body: ['sessionId', 'title', 'body', 'status', 'eol', 'bom', 'expected'],
    handle: async (input) => {
      if (input.method === 'POST') return toReply(await writeChapterViaChannel(writeRequestOf(input)))
      if (input.method === 'DELETE') return toReply(await deleteChapterViaChannel(writeRequestOf(input)))
      return readChapterReply(input)
    },
  },
  {
    // Must be declared with the same `/chapters/…` prefix but a longer pattern:
    // `[^/]+` in the row above cannot swallow the `/move` segment.
    name: 'chapter-move',
    pattern: /^\/chapters\/([^/]+)\/move$/,
    methods: ['POST'],
    body: ['sessionId', 'volumeId', 'expected'],
    handle: async (input) => toReply(await moveChapterViaChannel(writeRequestOf(input))),
  },
  {
    name: 'search',
    pattern: /^\/search$/,
    methods: ['GET'],
    handle: async ({ target, query, version }) => {
      const q = (query.get('q') ?? '').trim()
      if (q === '') {
        return { status: 400, body: failure('QUERY_REQUIRED', { param: 'q', hint: 'pass ?q=<text> to search the chapter tree' }) }
      }
      return { status: 200, body: ok(await buildSearch(target, version, q)) }
    },
  },
  {
    // The setting library (issue #30, X-7): eight kind groups, `world` carrying
    // its `category` buckets. Read-only; the index is refreshed through the same
    // `ensureIndex` the chapter tree uses (conventions §4.0's single trigger).
    name: 'library',
    pattern: /^\/library$/,
    methods: ['GET'],
    handle: async ({ target, version }) => ({ status: 200, body: ok(await buildLibrary(target, version)) }),
  },
  {
    // One entry: `kind` and `id` are the tree's own addresses, never a path, so
    // the path-parameter ban above still means what it says. 400 for an unknown
    // kind or a missing id, 404 for an id the projection does not hold.
    //
    // POST is the editor's save (issue #30, second batch): it carries the same
    // `kind`/`id` address plus `frontmatter`/`body`/`expected`, so a write still
    // names an entity and never a directory. The body allowlist below is the
    // write guard — `path`/`root`/… are a 400 before any filesystem access.
    name: 'library-item',
    pattern: /^\/library\/item$/,
    methods: ['GET', 'POST'],
    body: LIBRARY_WRITE_BODY_FIELDS,
    handle: async (input) => {
      if (input.method === 'POST') {
        return toReply(
          await writeLibraryItem({ source: input.target, version: input.version, body: input.body }),
        )
      }
      return buildLibraryItem(input.target, input.version, input.query.get('kind') ?? '', input.query.get('id') ?? '')
    },
  },
  {
    // `validation_issues` for the problem panel: grouped client-side by `code`,
    // because grouping is presentation and the wire stays a flat list.
    name: 'library-issues',
    pattern: /^\/library\/issues$/,
    methods: ['GET'],
    handle: async ({ target, version }) => ({ status: 200, body: ok(await buildLibraryIssues(target, version)) }),
  },
  {
    // The impact listing (#34, conventions §5.6): what a setting change would touch
    // across the manuscript, the graph and the three file-only reference sites.
    //
    // GET-only and **read-only**: unlike `/chapters` and `/search` it does NOT call
    // `ensureIndex`, because the author is looking at a report to decide whether to
    // write — rebuilding the cache under them would be a write during a question.
    // A cache that is missing or stale is reported (`indexAvailable` / `indexState`)
    // instead of being silently replaced.
    //
    // `slug` / `newTitle` preview the rename plan; the dialog shows it, and simply
    // closing the dialog is therefore zero writes by construction.
    name: 'impact',
    pattern: /^\/impact$/,
    methods: ['GET'],
    handle: async ({ target, query, version }) =>
      buildImpact(target, version, {
        kind: query.get('kind') ?? '',
        ...(query.get('id') === null ? {} : { id: query.get('id') ?? '' }),
        ...(query.get('title') === null ? {} : { title: query.get('title') ?? '' }),
        ...(query.get('slug') === null ? {} : { slug: query.get('slug') ?? '' }),
        ...(query.get('newTitle') === null ? {} : { newTitle: query.get('newTitle') ?? '' }),
      }),
  },
  {
    // The rename itself (#34, ADR-0014): move the file, pin the OLD id, rewrite no
    // reference. A write route, so it carries every write guard declared above plus
    // the mandatory CAS baseline (`expected`, §5.5).
    name: 'impact-rename',
    pattern: /^\/impact\/rename$/,
    methods: ['POST'],
    body: RENAME_BODY_FIELDS,
    handle: async ({ target, version, body }) => renameEntity({ source: target, version, body }),
  },
  {
    // The recovery bin (#35, roadmap X-9/X-10): what a delete moved to
    // `.inkflow/trash/`, newest first. Read-only and read-only by design — the
    // bin never prunes itself (ADR-0012 #4), so this route only looks.
    name: 'trash',
    pattern: /^\/trash$/,
    methods: ['GET'],
    handle: ({ target, version }) => trashListReply(target, version),
  },
  {
    // One entry back to its original path: `id` only, never a path. The bin
    // refuses an occupied target instead of overwriting (RESTORE_TARGET_EXISTS).
    name: 'trash-restore',
    pattern: /^\/trash\/restore$/,
    methods: ['POST'],
    body: TRASH_RESTORE_BODY_FIELDS,
    handle: ({ target, version, body }) => restoreTrashReply(target, version, body),
  },
  {
    // Forever: copy plus entry. `confirm: true` is required in the body — the
    // panel asks twice, and this is the net under that (ADR-0012 #4).
    name: 'trash-purge',
    pattern: /^\/trash\/purge$/,
    methods: ['POST'],
    body: TRASH_PURGE_BODY_FIELDS,
    handle: ({ target, version, body }) => purgeTrashReply(target, version, body),
  },
  {
    // The foreshadow board (issue #31, data-model §3.2): read-only, three groupings
    // of the same entries (open / late / by linked entity). Lateness is computed by
    // the Host against the latest chapter — the panel never re-derives it, so there
    // is exactly one definition of "超期" in the product.
    name: 'foreshadow',
    pattern: /^\/foreshadow$/,
    methods: ['GET'],
    handle: async ({ target, version }) => ({ status: 200, body: ok(await buildForeshadowBoard(target, version)) }),
  },
  {
    // The consistency audit (#33, roadmap X-14): five families — structure / ledger /
    // foreshadow / timeline / catalog — as one sorted `Finding[]`, with the first `limit`
    // of them and the counts of all.
    //
    // GET-only and **read-only**: unlike `/chapters`, `/search` and `/foreshadow` it does
    // NOT call `ensureIndex`, because the audit answers from the files (`audit.ts`'s header
    // says why) and a report about integrity must not change the tree it reports on. The
    // cache's state travels as `indexState` instead, so the panel can suggest a rebuild
    // without doing one behind the author's back.
    name: 'audit',
    pattern: /^\/audit$/,
    methods: ['GET'],
    handle: ({ target, query, version }) => {
      const raw = Number(query.get('limit') ?? '')
      return buildAudit(target, version, Number.isFinite(raw) && raw > 0 ? { limit: raw } : {})
    },
  },
  {
    // The report file (#33): `.inkflow/audit/audit-<时间戳>.md`, derived and deletable
    // (ADR-0012 #6). A write route, so it carries every write guard declared above plus
    // `confirm: true` — the panel asks once with an explicit label, this is the net under
    // it. The audit is re-run here rather than trusting a client-supplied body: the report
    // must describe the files now.
    name: 'audit-export',
    pattern: /^\/audit\/export$/,
    methods: ['POST'],
    body: AUDIT_EXPORT_BODY_FIELDS,
    handle: ({ target, version, body }) => exportAudit(target, version, body),
  },
  {
    // Importing an old manuscript (#37, X-17): `action: 'plan'` previews, `action:
    // 'apply'` writes with `confirm: true`. ONE POST for both actions, because the
    // preview has to name the file the author picked (`sourcePath`) — and a field that may
    // point outside the book has to ride the write route's guards (Origin present and
    // loopback) rather than relax them. `path`/`root`/`cwd`/… stay forbidden: a browser
    // still never names a directory, only the manuscript. `import-channel.ts` holds the
    // whole argument and the status vocabulary.
    name: 'library-import',
    pattern: /^\/library\/import$/,
    methods: ['POST'],
    body: IMPORT_BODY_FIELDS,
    handle: async ({ target, version, body }) => importViaChannel({ source: target, version, body }),
  },
]

/** One chapter, read-only. The request names an id; containment is the Host's job. */
function readChapterReply(input: RouteInput): RouteReply {
  let id: string
  try {
    id = decodeURIComponent(input.params[0] ?? '')
  } catch {
    // Malformed percent-encoding names nothing: refuse it as a bad request
    // rather than letting decodeURIComponent throw inside the handler.
    return { status: 400, body: failure('invalid-path-encoding') }
  }
  const chapter = buildChapter(input.target, input.version, id)
  if (chapter === undefined) {
    return {
      status: 404,
      body: failure('chapter-not-found', { id, hint: 'list the chapters with GET /chapters and use a chapter id from there' }),
    }
  }
  return { status: 200, body: ok(chapter) }
}

function writeRequestOf(input: RouteInput) {
  return { target: input.target, params: input.params, body: input.body, version: input.version }
}

function toReply(reply: WriteReply): RouteReply {
  return { status: reply.status, body: reply.body }
}

/** The single write on the wire: a JSON response with the hardening headers. */
function sendJson(res: ServerResponse, status: number, body: JsonRecord, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.end(payload)
}

function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name]
  if (Array.isArray(raw)) return (raw[0] ?? '').trim()
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * Whether the peer is loopback.
 *
 * A socket-backed request always reports `remoteAddress`; when it is absent the
 * caller is not a real peer (contract tests drive the handler directly), so the
 * check cannot be performed and only an EXPLICIT non-loopback address is
 * refused. The authority/origin checks above still apply to such a call.
 */
function isLoopbackPeer(req: IncomingMessage): boolean {
  const socket = (req as unknown as { socket?: { remoteAddress?: unknown } }).socket
  const address = typeof socket?.remoteAddress === 'string' ? socket.remoteAddress.trim() : ''
  if (address === '') return true
  return LOOPBACK_PEER.test(address)
}

type BodyRead = { ok: true; text: string } | { ok: false }

/** Read at most `MAX_INTERNAL_BODY_BYTES`; a larger body is refused unread. */
async function readBody(req: IncomingMessage): Promise<BodyRead> {
  const declared = headerValue(req, 'content-length')
  if (declared !== '') {
    const size = Number(declared)
    if (Number.isFinite(size) && size > MAX_INTERNAL_BODY_BYTES) return { ok: false }
  }
  const stream = req as unknown as { [Symbol.asyncIterator]?: unknown }
  if (typeof stream[Symbol.asyncIterator] !== 'function') return { ok: true, text: '' }

  let bytes = 0
  // Collect BYTES and decode ONCE. Decoding per chunk splits every multibyte
  // character that straddles a chunk boundary into two U+FFFD and writes the
  // damaged text back out — measured before this fix: a 300 KB body came back
  // `200 OK` with 8 replacement characters already on disk (issue #115 review).
  const chunks: Buffer[] = []
  for await (const chunk of req as AsyncIterable<unknown>) {
    const buffer =
      typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk instanceof Uint8Array ? Buffer.from(chunk) : undefined
    if (buffer === undefined) continue
    bytes += buffer.byteLength
    if (bytes > MAX_INTERNAL_BODY_BYTES) return { ok: false }
    chunks.push(buffer)
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') }
}

type BodyParse = { ok: true; value: JsonRecord } | { ok: false }

/** A request body must be absent, empty, or a JSON object — nothing else. */
function parseBody(text: string): BodyParse {
  if (text.trim() === '') return { ok: true, value: {} }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false }
    return { ok: true, value: parsed as JsonRecord }
  } catch {
    return { ok: false }
  }
}

function isHttpMethod(value: string): value is HttpMethod {
  return (KNOWN_METHODS as readonly string[]).includes(value)
}

function sessionIdFrom(req: IncomingMessage, query: URLSearchParams, body: JsonRecord): string | undefined {
  const fromQuery = (query.get(SESSION_ID_PARAM) ?? '').trim()
  if (fromQuery !== '') return fromQuery
  const fromHeader = headerValue(req, SESSION_ID_HEADER)
  if (fromHeader !== '') return fromHeader
  // A write may name its session in the body instead (`{sessionId}` is one of
  // the two things a write body is allowed to contain). Never a directory.
  const fromBody = body[SESSION_ID_PARAM]
  return typeof fromBody === 'string' && fromBody.trim() !== '' ? fromBody.trim() : undefined
}

/** `application/json`, with or without parameters (`; charset=utf-8`). */
function isJsonContentType(value: string): boolean {
  return /^application\/json(?:\s*;.*)?$/i.test(value.trim())
}

/** The first body field the route did not declare, if any (writes only). */
function unexpectedBodyField(body: JsonRecord, allowed: readonly string[]): string | undefined {
  const permitted = new Set([...allowed, SESSION_ID_PARAM])
  for (const key of Object.keys(body)) {
    if (!permitted.has(key)) return key
  }
  return undefined
}

interface RouteMatch {
  route: InternalRoute
  params: string[]
}

function matchRoute(path: string): RouteMatch | undefined {
  for (const route of ROUTES) {
    const match = route.pattern.exec(path)
    if (match !== null) return { route, params: match.slice(1) }
  }
  return undefined
}

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
//     ORIGIN as `Host`, not merely a loopback one (ADR-0010 D6 #6).
// ---------------------------------------------------------------------------

interface HubRouteInput {
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

interface HubRoute {
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
  readonly handle: (input: HubRouteInput) => Promise<RouteReply> | RouteReply
}

/**
 * The hub's capability whitelist (ADR-0010 D3/D4). Two read routes (`books`,
 * `shared`), and the wizard's two POST steps (`plan`, `apply`) which
 * additionally require an `Origin` that is the SAME ORIGIN as `Host` (D6 #6) —
 * see `handleHubRequest`. Every capability declares its own verb here; there is
 * never a blanket write switch.
 */
const HUB_ROUTES: readonly HubRoute[] = [
  {
    name: 'hub-books',
    pattern: /^\/hub\/books$/,
    methods: ['GET'],
    handle: async ({ ctx, version }) => {
      const result = await buildHubBooks(ctx, { pluginVersion: version })
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
    body: ['candidate', 'outsideRegistry', 'title'],
    handle: ({ ctx, body }) => hubPlan(ctx, body),
  },
  {
    // The write route names NO path at all: a one-shot token plus `confirm`
    // (ADR-0010 D3 "为什么 plan 要一个路径、而 apply 不要").
    name: 'hub-apply',
    pattern: /^\/hub\/apply$/,
    methods: ['POST'],
    body: ['planToken', 'confirm', 'title'],
    handle: ({ ctx, body }) => hubApply(ctx, body),
  },
  {
    // The shared library (ADR-0010 D5, issue #87): read-only browsing of
    // `dataDir/shared`, the one hub surface that belongs to no book. There is no
    // anchor to resolve and nothing to accept from the caller — the root comes
    // from the plugin config, and the route takes only `kind?`/`q?` filters.
    name: 'hub-shared',
    pattern: /^\/hub\/shared$/,
    methods: ['GET'],
    handle: ({ dataDir, query }) => {
      const result = buildHubShared(sharedDir(dataDir), {
        kind: query.get('kind') ?? undefined,
        q: query.get('q') ?? undefined,
      })
      if (result.ok) return { status: 200, body: ok(result.value) }
      return { status: 200, body: failure(result.error.code, { message: result.error.message, hint: result.error.hint }) }
    },
  },
]

function matchHubRoute(path: string): HubRoute | undefined {
  for (const route of HUB_ROUTES) {
    if (route.pattern.test(path)) return route
  }
  return undefined
}

/** `/hub` is the segment after `/inkflow/internal`; the route table lives here. */
function isHubPath(internalPath: string): boolean {
  return internalPath === HUB_SEGMENT || internalPath.startsWith(`${HUB_SEGMENT}/`)
}

/**
 * Same-origin, not merely loopback (ADR-0010 D6 #6).
 *
 * The session channel's write routes only need a loopback `Origin`, because the
 * Host derives their path from a session it resolved itself. A hub WRITE is
 * different: `plan` takes a directory the user picked and `apply` spends the
 * token it minted, so "another page on this machine" must not be able to drive
 * it — only the page the Host is serving (same scheme-less authority, port
 * included).
 */
function isSameOrigin(origin: string, host: string): boolean {
  if (origin === '' || host === '') return false
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    // `Origin: null` (sandboxed frame / file://) is not a page the Host serves.
    return false
  }
  return parsed.host.toLowerCase() === host.trim().toLowerCase()
}

async function handleHubRequest(input: {
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
  // no filesystem access may run for it (ADR-0010 D6 #5).
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

  // Write guards (ADR-0010 D6 #6/#7): the hub's POST routes are `plan`/`apply`.
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

    // ---- write guards (ADR-0008 D3): same-origin, JSON, declared fields -----
    // Only GET is a read in this channel, so any other declared verb is a write.
    const isWrite = method !== 'GET'
    if (isWrite) {
      // `Origin`, when it arrives, has already been checked for loipback above.
      //
      // An ABSENT `Origin` used to be a 403 `origin-required`. It is not, for two
      // measured reasons (issue #115): a real panel save answered exactly
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
      params: matched.params,
      body: parsed.value,
    })
    sendJson(res, reply.status, reply.body, reply.headers ?? {})
  }
}
