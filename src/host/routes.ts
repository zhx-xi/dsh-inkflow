/**
 * Loopback-only HTTP surface for the InkFlow workbench page.
 *
 * The DSH web server has NO authentication of its own: any page the browser
 * loads can attempt a fetch to 127.0.0.1:<port>/inkflow/... . Therefore this
 * handler is written fail-closed:
 *
 *   1. `Host` must be a loopback authority (defeats DNS rebinding: a hostile
 *      domain resolving to 127.0.0.1 still sends its own Host header).
 *   2. `Origin`, when present, must be a loopback origin (defeats cross-site
 *      fetches from a page served elsewhere).
 *   3. Only an explicit method allowlist is served; everything else is 405.
 *   4. No CORS headers are ever emitted, so browsers refuse cross-origin reads.
 *
 * Mutation routes (P1+) additionally require `Content-Type: application/json`
 * so a plain HTML form post cannot reach them.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Database } from './db.js'
import { countProjects, listProjects, SCHEMA_VERSION } from './db.js'

const LOOPBACK_AUTHORITY = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i
const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i
const PREFIX = '/inkflow'

export interface HttpDeps {
  database: Database
  dataDir: string
  dbFile: string
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

function isLoopbackAuthority(value: string): boolean {
  return LOOPBACK_AUTHORITY.test(value.trim())
}

export function createHttpHandler(deps: HttpDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = headerValue(req, 'host')
    if (!isLoopbackAuthority(host)) {
      sendJson(res, 403, { ok: false, error: { code: 'forbidden-host', host } })
      return
    }
    const origin = headerValue(req, 'origin')
    if (origin !== '' && !LOOPBACK_ORIGIN.test(origin.trim())) {
      sendJson(res, 403, { ok: false, error: { code: 'forbidden-origin', origin } })
      return
    }

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

    if (route === '/api/health') {
      sendJson(res, 200, {
        ok: true,
        value: {
          pluginVersion: deps.version,
          dataDir: deps.dataDir,
          dbFile: deps.dbFile,
          schemaVersion: SCHEMA_VERSION,
          projectCount: countProjects(deps.database),
        },
      })
      return
    }

    if (route === '/api/projects') {
      const includeArchived = url.searchParams.get('includeArchived') === '1'
      const limitRaw = Number(url.searchParams.get('limit') ?? '100')
      const limit = Number.isFinite(limitRaw) ? limitRaw : 100
      const rows = listProjects(deps.database, { includeArchived, limit })
      sendJson(res, 200, {
        ok: true,
        value: {
          total: rows.length,
          projects: rows.map((row) => ({
            id: row.id,
            title: row.title,
            subtitle: row.subtitle,
            author: row.author,
            genre: row.genre,
            seriesId: row.series_id ?? '',
            status: row.status,
            wordCount: row.word_count,
            chapterCount: row.chapter_count,
            rev: row.rev,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          })),
        },
      })
      return
    }

    sendJson(res, 404, { ok: false, error: { code: 'not-found', path } })
  }
}
