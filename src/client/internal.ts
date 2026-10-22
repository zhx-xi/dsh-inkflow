/**
 * The Client half of the private panel channel (ADR-0008, issue #18).
 *
 * The browser may name a SESSION, never a directory: `fetchInternal` always
 * sends `sessionId` and never `root`/`path`/`cwd`. The Host resolves that id to
 * the book's directory and answers with the `{ok:true,value}` /
 * `{ok:false,error}` envelope.
 *
 * This is not an API: there is no version segment and no compatibility promise.
 * The path is same-origin and relative so no CORS header is needed (the channel
 * sends none on purpose).
 *
 * THE HUB EXCEPTION (ADR-0010 D3): the root-scoped book hub has no session at
 * all, so `fetchInternal` accepts `sessionless: true` — pinned to `/hub/*` right
 * here, never left to the call sites, so the session routes cannot lose their
 * "a session is mandatory" property by accident.
 */

/** Internal prefix. Not exported to users; both halves ship in one version. */
export const INTERNAL_PREFIX = '/inkflow/internal'

export interface InternalError {
  code: string
  message?: string
  hint?: string
  [key: string]: unknown
}

export interface InternalResult<T> {
  ok: boolean
  /** Present only when `ok` is true. */
  value?: T
  /** Present only when `ok` is false. */
  error?: InternalError
  /** HTTP status; 0 when the request never left the browser. */
  status: number
}

/**
 * The session this panel is attached to.
 *
 * Set by the session-scoped entry (`conversation.view`, issue #17): a root-scoped
 * panel has no session, and guessing one would report another book. Until it is
 * set, every request answers `NO_SESSION_CONTEXT` without a round trip.
 */
let activeSessionId: string | null = null

export function setActiveSessionId(sessionId: string | null): void {
  activeSessionId = typeof sessionId === 'string' && sessionId.trim() !== '' ? sessionId.trim() : null
}

export function getActiveSessionId(): string | null {
  return activeSessionId
}

function localRefusal(): InternalResult<never> {
  return {
    ok: false,
    status: 0,
    error: {
      code: 'NO_SESSION_CONTEXT',
      message: 'the panel is not attached to a session yet',
      hint: 'open the InkFlow panel from a novel session',
    },
  }
}

/** The hub segment (ADR-0010 D3): the only routes that may be called sessionless. */
const HUB_ROUTE_PREFIX = '/hub'

/** The route part of a path, whatever spelling the caller used. */
function routeOf(path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`
  return suffix.startsWith(INTERNAL_PREFIX) ? suffix.slice(INTERNAL_PREFIX.length) : suffix
}

/** `true` for `/hub/books` and anything else under the hub segment. */
function isHubRoute(path: string): boolean {
  const route = routeOf(path)
  return route === HUB_ROUTE_PREFIX || route.startsWith(`${HUB_ROUTE_PREFIX}/`)
}

/**
 * Why a sessionless call is refused: the hub is a whitelist, not a bypass.
 *
 * `sessionless` exists because a root-scoped panel has no session at all
 * (ADR-0010 D1/D3). Letting it address a *session* route would be a way around
 * the "the browser names a session, never a directory" rule, so the option is
 * pinned to `/hub/*` here rather than at the call sites.
 */
function sessionlessRefusal(): InternalResult<never> {
  return {
    ok: false,
    status: 0,
    error: {
      code: 'HUB_ROUTE_REQUIRED',
      message: 'a sessionless request may only address /hub/*',
      hint: 'session routes need a sessionId; only the book hub has no session',
    },
  }
}

/** Normalise a route path: `/status` and `status` both become `/status`. */
function internalUrl(path: string, sessionId: string): string {
  const route = internalRoute(path)
  const separator = route.includes('?') ? '&' : '?'
  return `${route}${separator}sessionId=${encodeURIComponent(sessionId)}`
}

/** The absolute internal URL for a route, without a session parameter. */
function internalRoute(path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`
  return suffix.startsWith(INTERNAL_PREFIX) ? suffix : `${INTERNAL_PREFIX}${suffix}`
}

/** Verbs this half ever sends: reads are GET, writes are POST/DELETE. */
export type InternalMethod = 'GET' | 'POST' | 'DELETE'

export interface InternalRequest {
  sessionId?: string | null
  signal?: AbortSignal
  method?: InternalMethod
  /**
   * The hub channel has no session (ADR-0010 D3), so it must not send one and
   * must not need one. Only `/hub/*` accepts this; every other route keeps
   * requiring a session id.
   */
  sessionless?: boolean
  /** Serialised as JSON; writes always send an object (the `{}` case included). */
  body?: unknown
  /** Writes are bounded so a stuck request cannot hold the editor in "saving". */
  timeoutMs?: number
}

/** How long a write may stay in flight before the editor is told it failed. */
export const WRITE_TIMEOUT_MS = 15_000

/**
 * One round trip to the private channel.
 *
 * Failures stay data (never a thrown error): the panel renders `error.code` as a
 * hint instead of a crash. `response.ok` and the envelope's `ok` are both
 * checked, because a 403/404/405/409/413/415 from the guard layer carries an
 * error body too — and a 409 `FILE_CHANGED` is the editor's conflict signal.
 */
async function requestInternal<T>(path: string, options: InternalRequest): Promise<InternalResult<T>> {
  const sessionless = options.sessionless === true
  const sessionId = options.sessionId ?? activeSessionId
  if (sessionless) {
    if (!isHubRoute(path)) return sessionlessRefusal()
  } else if (sessionId === null || sessionId === undefined || sessionId === '') {
    return localRefusal()
  }

  const method: InternalMethod = options.method ?? 'GET'
  const isWrite = method !== 'GET'
  const headers: Record<string, string> = { accept: 'application/json' }
  if (isWrite) headers['content-type'] = 'application/json'

  const controller = new AbortController()
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  // A write gets a timeout; a read keeps the plain signal so a slow first paint
  // is not reported as a failure.
  const timer = isWrite ? setTimeout(() => controller.abort(), options.timeoutMs ?? WRITE_TIMEOUT_MS) : null

  let response: Response
  try {
    response = await fetch(sessionless ? internalRoute(path) : internalUrl(path, sessionId as string), {
      method,
      headers,
      credentials: 'same-origin',
      redirect: 'error',
      ...(isWrite ? { body: JSON.stringify(options.body ?? {}) } : {}),
      signal: controller.signal,
    })
  } catch (cause) {
    const aborted = options.signal?.aborted === true
    return {
      ok: false,
      status: 0,
      error: {
        code: aborted ? 'aborted' : isWrite ? 'write-failed' : 'fetch-failed',
        message: cause instanceof Error ? cause.message : String(cause),
      },
    }
  } finally {
    if (timer !== null) clearTimeout(timer)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return { ok: false, status: response.status, error: { code: `http-${response.status}` } }
  }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, status: response.status, error: { code: 'bad-envelope' } }
  }

  const envelope = body as { ok?: unknown; value?: unknown; error?: unknown }
  if (envelope.ok === true) return { ok: true, status: response.status, value: envelope.value as T }
  const error =
    typeof envelope.error === 'object' && envelope.error !== null
      ? (envelope.error as InternalError)
      : { code: `http-${response.status}` }
  return { ok: false, status: response.status, error }
}

/** GET one projection of the session's book (or, sessionless, of the hub). */
export function fetchInternal<T>(
  path: string,
  options: { sessionId?: string | null; signal?: AbortSignal; sessionless?: boolean } = {},
): Promise<InternalResult<T>> {
  return requestInternal<T>(path, { ...options, method: 'GET' })
}

/**
 * Write through the private channel.
 *
 * The panel is allowed exactly two write verbs (ADR-0008 D3): `POST` for
 * create/save/move and `DELETE` for a delete. The body is always a JSON object
 * — a delete sends `{}` — because the Host refuses a write without
 * `Content-Type: application/json` (415) before it looks at anything else.
 *
 * `sessionless` is the hub exception (ADR-0010 D3/D4): the book hub's
 * `plan`/`apply` have no session at all. It goes through the SAME `/hub/*` pin
 * as the read path, so a write cannot use it to reach a session route.
 */
export function writeInternal<T>(
  path: string,
  body: unknown,
  options: {
    method?: 'POST' | 'DELETE'
    sessionId?: string | null
    signal?: AbortSignal
    timeoutMs?: number
    sessionless?: boolean
  } = {},
): Promise<InternalResult<T>> {
  return requestInternal<T>(path, {
    method: options.method ?? 'POST',
    body,
    sessionId: options.sessionId,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    sessionless: options.sessionless,
  })
}
