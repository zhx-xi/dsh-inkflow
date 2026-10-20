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
 * Both routes here are read-only projections of the filesystem, so a browser
 * compromise cannot corrupt novel data through this surface.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { HostContext } from './context.js'
import { INDEX_SCHEMA_VERSION } from './conventions.js'
import { buildIndex, listChapters, readIndexMeta } from './indexer.js'
import { inspectProject, projectLabel } from './project.js'
import { readState } from './state.js'

const LOOPBACK_AUTHORITY = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i
const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i
const PREFIX = '/inkflow'

export interface HttpDeps {
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

    const rootParam = url.searchParams.get('root')
    const remembered = readState(deps.dataDir).lastProjectRoot
    const root = rootParam !== null && rootParam !== '' ? rootParam : remembered

    if (route === '/api/status') {
      if (root === undefined || root === '') {
        sendJson(res, 200, {
          ok: true,
          value: {
            pluginVersion: deps.version,
            project: null,
            hint: 'no project touched yet: run inkflow_project_status in a novel session',
          },
        })
        return
      }
      const probe = inspectProject(root)
      const index = readIndexMeta(probe.root, probe)
      sendJson(res, 200, {
        ok: true,
        value: {
          pluginVersion: deps.version,
          project: {
            root: probe.root,
            label: projectLabel(probe),
            usable: probe.usable,
            checks: probe.checks,
            missing: probe.missing,
            reasons: probe.reasons,
          },
          index: {
            dbFile: index.dbFile,
            dbExists: index.dbExists,
            schemaVersion: index.schemaVersion ?? null,
            schemaMatches: index.schemaMatches,
            builtAt: index.builtAt ?? null,
            counts: index.counts,
          },
          indexSchemaVersion: INDEX_SCHEMA_VERSION,
        },
      })
      return
    }

    if (route === '/api/chapters') {
      if (root === undefined || root === '') {
        sendJson(res, 200, { ok: true, value: { total: 0, chapters: [], hint: 'no project yet' } })
        return
      }
      const probe = inspectProject(root)
      if (!probe.usable) {
        sendJson(res, 200, {
          ok: false,
          error: { code: 'NOT_AN_INKFLOW_PROJECT', missing: probe.missing, reasons: probe.reasons },
        })
        return
      }
      let chapters = listChapters(probe.root, 200)
      let rebuilt = false
      if (chapters === undefined) {
        buildIndex(probe.root)
        chapters = listChapters(probe.root, 200) ?? []
        rebuilt = true
      }
      sendJson(res, 200, { ok: true, value: { total: chapters.length, indexRebuilt: rebuilt, chapters } })
      return
    }

    sendJson(res, 404, { ok: false, error: { code: 'not-found', path } })
  }
}
