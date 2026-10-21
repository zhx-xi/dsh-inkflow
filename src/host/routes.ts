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
 * FUTURE WRITE ROUTES (there are none on this build) MUST: be POST only, require
 * `Content-Type: application/json` (415 otherwise) and require a loopback
 * `Origin` to be PRESENT (403 otherwise) — the same-origin check is mandatory
 * exactly for requests that write. Read routes keep working without `Origin`
 * because a same-origin `fetch` from the panel may omit it.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { HostContext } from './context.js'
import {
  INTERNAL_PREFIX,
  MAX_INTERNAL_BODY_BYTES,
  SESSION_ID_HEADER,
  SESSION_ID_PARAM,
  buildChapter,
  buildChapters,
  buildSearch,
  buildStatus,
  findPathParam,
  findPathParamInBody,
  isSessionId,
  noSessionContextBody,
  resolveChannelTarget,
} from './internal.js'
import type { ChannelTarget, JsonRecord } from './internal.js'

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
  query: URLSearchParams
  version: string
  /** `pattern` capture groups, still percent-encoded. */
  params: readonly string[]
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
  readonly handle: (input: RouteInput) => RouteReply
}

function ok(value: JsonRecord): JsonRecord {
  return { ok: true, value }
}

function failure(code: string, extra: JsonRecord = {}): JsonRecord {
  return { ok: false, error: { code, ...extra } }
}

/**
 * P0 is read-only: four GET projections. Each entry declares its own method
 * list, so adding a write route means writing `methods: ['POST']` next to this
 * comment — not flipping a global switch.
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
    methods: ['GET'],
    handle: ({ target, version }) => ({ status: 200, body: ok(buildChapters(target, version)) }),
  },
  {
    name: 'chapter',
    pattern: /^\/chapters\/([^/]+)$/,
    methods: ['GET'],
    handle: ({ target, version, params }) => {
      let id: string
      try {
        id = decodeURIComponent(params[0] ?? '')
      } catch {
        // Malformed percent-encoding names nothing: refuse it as a bad request
        // rather than letting decodeURIComponent throw inside the handler.
        return { status: 400, body: failure('invalid-path-encoding') }
      }
      const chapter = buildChapter(target, version, id)
      if (chapter === undefined) {
        return {
          status: 404,
          body: failure('chapter-not-found', { id, hint: 'list the chapters with GET /chapters and use a chapter id from there' }),
        }
      }
      return { status: 200, body: ok(chapter) }
    },
  },
  {
    name: 'search',
    pattern: /^\/search$/,
    methods: ['GET'],
    handle: ({ target, query, version }) => {
      const q = (query.get('q') ?? '').trim()
      if (q === '') {
        return { status: 400, body: failure('QUERY_REQUIRED', { param: 'q', hint: 'pass ?q=<text> to search the chapter tree' }) }
      }
      return { status: 200, body: ok(buildSearch(target, version, q)) }
    },
  },
]

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
  const chunks: string[] = []
  for await (const chunk of req as AsyncIterable<unknown>) {
    const buffer =
      typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk instanceof Uint8Array ? Buffer.from(chunk) : undefined
    if (buffer === undefined) continue
    bytes += buffer.byteLength
    if (bytes > MAX_INTERNAL_BODY_BYTES) return { ok: false }
    chunks.push(buffer.toString('utf8'))
  }
  return { ok: true, text: chunks.join('') }
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

function sessionIdFrom(req: IncomingMessage, query: URLSearchParams): string | undefined {
  const fromQuery = (query.get(SESSION_ID_PARAM) ?? '').trim()
  if (fromQuery !== '') return fromQuery
  const fromHeader = headerValue(req, SESSION_ID_HEADER)
  return fromHeader === '' ? undefined : fromHeader
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

    // ---- the request's session, resolved by the Host ----------------------
    const sessionId = sessionIdFrom(req, url.searchParams)
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

    const reply = matched.route.handle({
      target: resolution.target,
      query: url.searchParams,
      version: deps.version,
      params: matched.params,
    })
    sendJson(res, reply.status, reply.body, reply.headers ?? {})
  }
}
