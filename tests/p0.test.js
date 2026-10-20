/**
 * P0 contract tests — run WITHOUT a DSH process.
 *
 * They exercise the exact artifacts that get installed: lib/index.js (Host
 * half) and the tool/route contracts it registers. The browser half is covered
 * by the manual install check (it needs the real DSH web shell).
 *
 * Run: pnpm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, name } from '../lib/index.js'

/** Minimal Host context: records registrations, ignores Cordis plumbing. */
function createHarness() {
  const tools = new Map()
  const routes = []
  const logs = []
  const disposers = []

  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }

  const ctx = {
    effect(setup) {
      const dispose = setup()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    get(service) {
      return service === 'webServer' ? webServer : undefined
    },
    logger() {
      return {
        debug() {},
        info(message) {
          logs.push(String(message))
        },
        warn(message) {
          logs.push(String(message))
        },
        error(message) {
          logs.push(String(message))
        },
      }
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    webServer,
  }

  return {
    ctx,
    tools,
    routes,
    logs,
    disposeAll() {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

function fakeRequest({ url, method = 'GET', host = '127.0.0.1:2149', origin }) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  return { url, method, headers }
}

function fakeResponse() {
  const response = {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(key, value) {
      response.headers[key] = value
    },
    end(payload) {
      response.body = payload
    },
  }
  return response
}

async function callRoute(routes, request) {
  const route = routes.find((entry) => entry.path === '/inkflow')
  assert.ok(route, 'expected a /inkflow prefix route')
  const response = fakeResponse()
  await route.handler(request, response)
  return { status: response.statusCode, headers: response.headers, json: JSON.parse(response.body) }
}

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-p0-'))
}

test('plugin exports the Cordis Host shape', () => {
  assert.equal(name, 'dsh-inkflow')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
})

test('apply registers three inkflow_* tools and the /inkflow prefix route', () => {
  const dir = workdir()
  try {
    const harness = createHarness()
    apply(harness.ctx, { dataDir: dir })

    assert.deepEqual([...harness.tools.keys()].sort(), [
      'inkflow_health',
      'inkflow_project_create',
      'inkflow_project_list',
    ])
    assert.equal(harness.routes.length, 1)
    assert.equal(harness.routes[0].kind, 'prefix')
    assert.equal(harness.routes[0].path, '/inkflow')

    for (const definition of harness.tools.values()) {
      assert.equal(typeof definition.description, 'string')
      assert.ok(definition.description.length > 20)
      assert.equal(definition.parameters.type, 'object')
      assert.equal(typeof definition.output.schema.type, 'string')
      assert.equal(typeof definition.execute, 'function')
    }

    assert.ok(existsSync(join(dir, 'inkflow.db')))
    harness.disposeAll()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sqlite round trip: create, list, change_log, persistence across reopen', async () => {
  const dir = workdir()
  try {
    const harness = createHarness()
    apply(harness.ctx, { dataDir: dir })

    const health = harness.tools.get('inkflow_health')
    const before = await health.execute({}, { signal: AbortSignal.timeout(1000) })
    assert.equal(before.ok, true)
    assert.equal(before.schemaVersion, 1)
    assert.equal(before.projectCount, 0)
    assert.equal(before.dataDir, dir)

    const create = harness.tools.get('inkflow_project_create')
    const created = await create.execute(
      { title: '蜀山', author: 'zhx-xi', genre: '仙侠' },
      { signal: AbortSignal.timeout(1000) },
    )
    assert.equal(created.project.title, '蜀山')
    assert.equal(created.project.status, 'draft')
    assert.equal(created.project.wordCount, 0)
    assert.match(created.project.id, /^[0-9a-f-]{36}$/)

    const list = harness.tools.get('inkflow_project_list')
    const listed = await list.execute({}, { signal: AbortSignal.timeout(1000) })
    assert.equal(listed.total, 1)
    assert.equal(listed.projects[0].id, created.project.id)

    // Renderers must return text content blocks for the model.
    const rendered = create.output.render({}, created)
    assert.equal(rendered[0].type, 'text')
    assert.match(rendered[0].text, /蜀山/)

    harness.disposeAll()

    // Reopen the same directory: rows and device id survive.
    const reopened = createHarness()
    apply(reopened.ctx, { dataDir: dir })
    const after = await reopened.tools.get('inkflow_health').execute(
      {},
      { signal: AbortSignal.timeout(1000) },
    )
    assert.equal(after.projectCount, 1)

    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(dir, 'inkflow.db'))
    const changes = db.prepare('SELECT entity_table, op, rev FROM change_log').all()
    assert.equal(changes.length, 1)
    assert.deepEqual({ ...changes[0] }, { entity_table: 'projects', op: 'insert', rev: 1 })
    const device = db.prepare("SELECT value FROM app_settings WHERE key = 'device_id'").get()
    assert.match(device.value, /^[0-9a-f-]{36}$/)
    db.close()
    reopened.disposeAll()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('http route: loopback only, read-only, json envelopes', async () => {
  const dir = workdir()
  try {
    const harness = createHarness()
    apply(harness.ctx, { dataDir: dir })

    const health = await callRoute(harness.routes, fakeRequest({ url: '/inkflow/api/health' }))
    assert.equal(health.status, 200)
    assert.equal(health.json.ok, true)
    assert.equal(health.json.value.schemaVersion, 1)
    assert.equal(health.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(health.headers['cache-control'], 'no-store')

    const projects = await callRoute(harness.routes, fakeRequest({ url: '/inkflow/api/projects' }))
    assert.equal(projects.status, 200)
    assert.equal(projects.json.value.total, 0)

    // DNS rebinding: a hostile Host header is refused.
    const rebind = await callRoute(
      harness.routes,
      fakeRequest({ url: '/inkflow/api/health', host: 'evil.example.com' }),
    )
    assert.equal(rebind.status, 403)
    assert.equal(rebind.json.error.code, 'forbidden-host')

    // Cross-site page: non-loopback Origin is refused.
    const crossSite = await callRoute(
      harness.routes,
      fakeRequest({ url: '/inkflow/api/health', origin: 'https://evil.example.com' }),
    )
    assert.equal(crossSite.status, 403)
    assert.equal(crossSite.json.error.code, 'forbidden-origin')

    // Same-origin page is allowed.
    const sameOrigin = await callRoute(
      harness.routes,
      fakeRequest({ url: '/inkflow/api/health', origin: 'http://127.0.0.1:2149' }),
    )
    assert.equal(sameOrigin.status, 200)

    // No mutations in P0.
    const post = await callRoute(
      harness.routes,
      fakeRequest({ url: '/inkflow/api/projects', method: 'POST' }),
    )
    assert.equal(post.status, 405)

    const missing = await callRoute(harness.routes, fakeRequest({ url: '/inkflow/api/nope' }))
    assert.equal(missing.status, 404)

    harness.disposeAll()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects an empty project title instead of writing a blank row', async () => {
  const dir = workdir()
  try {
    const harness = createHarness()
    apply(harness.ctx, { dataDir: dir })
    const create = harness.tools.get('inkflow_project_create')
    await assert.rejects(
      create.execute({ title: '   ' }, { signal: AbortSignal.timeout(1000) }),
      /title must not be empty/,
    )
    harness.disposeAll()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
