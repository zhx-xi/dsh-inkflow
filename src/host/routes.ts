/**
 * Loopback-only HTTP surface for the InkFlow workbench page.
 *
 * The DSH web server has NO authentication of its own: any page the browser
 * loads can attempt a fetch to 127.0.0.1:<port>/inkflow/... . This handler is
 * therefore fail-closed (ADR-0004):
 *
 *   1. `Host` must be a loopback authority (defeats DNS rebinding).
 *   2. `Origin`, when present, must be a loopback origin (defeats cross-site fetch).
 *   3. Only an explicit method allowlist is served; everything else is 405.
 *   4. No CORS headers are ever emitted.
 *
 * WHY BOTH ROUTES FAIL CLOSED WITH `NO_SESSION_CONTEXT` (issue #7): a browser
 * request carries no session identity, so this surface cannot know which book it
 * should project. Two shortcuts were removed on purpose:
 *   - `?root=<path>` — any page on 127.0.0.1 could point the plugin at an
 *     arbitrary directory, and `inspectProject` even creates `index/` there.
 *   - `state.json`'s `lastProjectRoot` — one plugin-wide value written by
 *     whichever session ran last; it may belong to a completely different book.
 * Resolving sessionId → workspace lands in #18. Until then the page gets a
 * structured refusal instead of another novel's data, and nothing is written.
 *
 * CONSEQUENCE FOR THE ATOMIC INDEX BUILD (issue #4): with no project to resolve,
 * this surface never rebuilds the index, so there is no `IndexBuildError` to map
 * here. The mapping lives in `tools.ts` (`indexBuildFailure`), and whoever
 * restores a project lookup in #18 must route the rebuild through it too.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { HostContext } from './context.js'

const LOOPBACK_AUTHORITY = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i
const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i
const PREFIX = '/inkflow'

export interface HttpDeps {
  /** Kept for #18, where a request will be resolved to its session's workspace. */
  ctx: HostContext
  dataDir: string
  version: string
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(payload)
}

function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name]
  if (Array.isArray(raw)) return raw[0] ?? ''
  return typeof raw === 'string' ? raw : ''
}

function noSessionContext(version: string): unknown {
  return {
    ok: false,
    pluginVersion: version,
    error: {
      code: 'NO_SESSION_CONTEXT',
      message: 'the workbench page has no session → workspace mapping yet, so its project cannot be named',
      hint:
        'use inkflow_project_status from the novel session; the panel shows its project once session resolution lands (#18)',
    },
  }
}

export function createHttpHandler(deps: HttpDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = headerValue(req, 'host')
    if (!LOOPBACK_AUTHORITY.test(host.trim())) {
      sendJson(res, 403, { ok: false, error: { code: 'forbidden-host', host } })
      return
    }
    const origin = headerValue(req, 'origin')
    if (origin !== '' && !LOOPBACK_ORIGIN.test(origin.trim())) {
      sendJson(res, 403, { ok: false, error: { code: 'forbidden-origin', origin } })
      return
    }

    // Only the pathname is trusted; the query string is never read, so a
    // crafted `?root=` cannot reach the filesystem at all.
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (!path.startsWith(PREFIX)) {
      sendJson(res, 404, { ok: false, error: { code: 'not-found', path } })
      return
    }
    const route = path.slice(PREFIX.length)
    const method = (req.method ?? 'GET').toUpperCase()
    if (method !== 'GET') {
      sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', method } })
      return
    }

    if (route === '/api/status' || route === '/api/chapters') {
      // HTTP 200 with ok:false: this is a "cannot answer yet" state, not a
      // transport failure, and the client treats ok:false as a display hint.
      sendJson(res, 200, noSessionContext(deps.version))
      return
    }

    sendJson(res, 404, { ok: false, error: { code: 'not-found', path } })
  }
}
