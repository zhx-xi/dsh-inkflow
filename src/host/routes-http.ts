/**
 * The plumbing under both route tables: peer/page guards, body and query parsing, and the
 * two reply shapes.
 *
 * WHY IT IS A FILE OF ITS OWN: routes.ts held the internal table, the hub table, every guard
 * and the dispatcher in one 1579-line file, so touching one route meant scrolling past four
 * unrelated concerns. Nothing here knows a route: it answers "may this peer speak", "what did
 * the body say", "what does a refusal look like". The tables import these; these import none
 * of the tables, which is what keeps the split acyclic.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { MAX_INTERNAL_BODY_BYTES, SESSION_ID_HEADER, SESSION_ID_PARAM, buildChapter } from './internal.js'
import type { ChannelTarget, JsonRecord, WriteReply } from './internal.js'
import { KNOWN_METHODS } from './route-types.js'
import type { HttpMethod, InternalRoute, RouteInput, RouteReply } from './route-types.js'

export const LOOPBACK_AUTHORITY = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i
export const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i
/** Node reports IPv4 peers of a dual-stack socket as `::ffff:127.0.0.1`. */
export const LOOPBACK_PEER = /^(?:127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/i


export function ok(value: JsonRecord): JsonRecord {
  return { ok: true, value }
}

export function failure(code: string, extra: JsonRecord = {}): JsonRecord {
  return { ok: false, error: { code, ...extra } }
}

/**
 * Reads are GET; anything else declared here is a write and must satisfy the
 * write guards below. Each entry declares its own method list, so adding a write
 * route means writing `methods: ['POST']` next to this comment — not flipping a
 * global switch. One entry per pattern: `/chapters/:id` answers GET (detail),
 * POST (save) and DELETE (delete) from the same capture group.
 */

export function readChapterReply(input: RouteInput): RouteReply {
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

export function writeRequestOf(input: RouteInput) {
  return { target: input.target, params: input.params, body: input.body, version: input.version }
}

export function toReply(reply: WriteReply): RouteReply {
  return { status: reply.status, body: reply.body }
}

/** The single write on the wire: a JSON response with the hardening headers. */
export function sendJson(res: ServerResponse, status: number, body: JsonRecord, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
  res.end(payload)
}

export function headerValue(req: IncomingMessage, name: string): string {
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
export function isLoopbackPeer(req: IncomingMessage): boolean {
  const socket = (req as unknown as { socket?: { remoteAddress?: unknown } }).socket
  const address = typeof socket?.remoteAddress === 'string' ? socket.remoteAddress.trim() : ''
  if (address === '') return true
  return LOOPBACK_PEER.test(address)
}

export type BodyRead = { ok: true; text: string } | { ok: false }

/** Read at most `MAX_INTERNAL_BODY_BYTES`; a larger body is refused unread. */
export async function readBody(req: IncomingMessage): Promise<BodyRead> {
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
  // `200 OK` with 8 replacement characters already on disk (review).
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

export type BodyParse = { ok: true; value: JsonRecord } | { ok: false }

/** A request body must be absent, empty, or a JSON object — nothing else. */
export function parseBody(text: string): BodyParse {
  if (text.trim() === '') return { ok: true, value: {} }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false }
    return { ok: true, value: parsed as JsonRecord }
  } catch {
    return { ok: false }
  }
}

export function isHttpMethod(value: string): value is HttpMethod {
  return (KNOWN_METHODS as readonly string[]).includes(value)
}

export function sessionIdFrom(req: IncomingMessage, query: URLSearchParams, body: JsonRecord): string | undefined {
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
export function isJsonContentType(value: string): boolean {
  return /^application\/json(?:\s*;.*)?$/i.test(value.trim())
}

/** The first body field the route did not declare, if any (writes only). */
export function unexpectedBodyField(body: JsonRecord, allowed: readonly string[]): string | undefined {
  const permitted = new Set([...allowed, SESSION_ID_PARAM])
  for (const key of Object.keys(body)) {
    if (!permitted.has(key)) return key
  }
  return undefined
}

/**
 * The first QUERY key the route did not declare, if any.
 *
 * The counterpart of `unexpectedBodyField`, and `sessionId` is permitted for the same
 * reason it is in a body: it is how the panel addresses the request, not a knob of the
 * route. Everything else must be declared in the route table — the channel reads its
 * query keys one by one, so an undeclared one used to be read by nobody and reported by
 * nobody.
 */
export function unexpectedQueryParam(query: URLSearchParams, allowed: readonly string[]): string | undefined {
  const permitted = new Set([...allowed, SESSION_ID_PARAM])
  for (const key of query.keys()) {
    if (!permitted.has(key)) return key
  }
  return undefined
}

/** Which query key addressed the chapter. */
type AddressedBy = 'chapterId' | 'chapterSeq' | 'default'

/**
 * The key that actually addressed the chapter, in precedence order.
 *
 * `keys` is ordered the way the handlers read them (`chapterId` before `chapterSeq`), and a
 * key present but blank counts as absent — that is exactly how the handlers treat
 * `?chapterId=`, so the report and the behaviour cannot disagree.
 */
export function addressedByOf(query: URLSearchParams, keys: readonly Exclude<AddressedBy, 'default'>[]): AddressedBy {
  for (const key of keys) {
    if ((query.get(key) ?? '').trim() !== '') return key
  }
  return 'default'
}

/**
 * Attach `addressedBy` to a read route's `value`.
 *
 * Why here and not inside each domain builder: which query key addressed the chapter is a
 * fact about the ROUTE, not about the gate/review/brief computation. One helper keeps the
 * four read routes from each inventing the field — and leaves `buildGate` /
 * `buildReviewList` / `buildReviewCompare` / `buildBrief` with the signatures the TOOLS
 * call, so the tool surfaces do not change at all.
 */
export function withAddressedBy(reply: RouteReply, addressedBy: AddressedBy): RouteReply {
  const value = reply.body['value']
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return reply
  return { ...reply, body: { ...reply.body, value: { ...(value as Record<string, unknown>), addressedBy } } }
}

export interface RouteMatch {
  route: InternalRoute
  params: string[]
}


export function isSameOrigin(origin: string, host: string): boolean {
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

