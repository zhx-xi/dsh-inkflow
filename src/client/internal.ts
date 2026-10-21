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

/** Normalise a route path: `/status` and `status` both become `/status`. */
function internalUrl(path: string, sessionId: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`
  const route = suffix.startsWith(INTERNAL_PREFIX) ? suffix : `${INTERNAL_PREFIX}${suffix}`
  const separator = route.includes('?') ? '&' : '?'
  return `${route}${separator}sessionId=${encodeURIComponent(sessionId)}`
}

/**
 * GET one projection of the session's book.
 *
 * Failures stay data (never a thrown error): the panel renders `error.code` as a
 * hint instead of a crash. `response.ok` and the envelope's `ok` are both
 * checked, because a 403/404/405/413 from the guard layer carries an error body
 * too.
 */
export async function fetchInternal<T>(
  path: string,
  options: { sessionId?: string | null; signal?: AbortSignal } = {},
): Promise<InternalResult<T>> {
  const sessionId = options.sessionId ?? activeSessionId
  if (sessionId === null || sessionId === undefined || sessionId === '') return localRefusal()

  let response: Response
  try {
    response = await fetch(internalUrl(path, sessionId), {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      redirect: 'error',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    return {
      ok: false,
      status: 0,
      error: { code: 'fetch-failed', message: cause instanceof Error ? cause.message : String(cause) },
    }
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
