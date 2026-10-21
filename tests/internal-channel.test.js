/**
 * Contract tests for the private panel channel (`/inkflow/internal/*`, issue #18).
 *
 * These run against the BUILT artifact (`lib/index.js`) with no DSH process: a
 * fake Cordis context records the `/inkflow` prefix route and fakes the three
 * Host services the channel resolves a session through (`workspaceRegistry`,
 * `sessions`, `workingDirectory`). Every scenario scaffolds a throwaway project.
 *
 * The contract under test is ADR-0008:
 *   D2  it is not an API: `/inkflow/api/*` is 404 and there is no compatibility alias
 *   D3  methods are declared per route; the guards are fail-closed
 *   D4  the request carries only `sessionId`; a path parameter is a 400 before any
 *       filesystem access, and a session that cannot be resolved is a structured
 *       200 `{ok:false,error:{code:'NO_SESSION_CONTEXT'}}` — never a guess
 *   D5  the gate verdict is the same one the tools report
 *
 * Run: pnpm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const ALL_DIRS = [...CONTENT_DIRS, 'index']
const KEEP = '.gitkeep'
const HOST = '127.0.0.1:2149'
const INTERNAL = '/inkflow/internal'

// ---------------------------------------------------------------------------
// Harness: registrations recorded, Host services faked
// ---------------------------------------------------------------------------

function createHarness({ sessionId = 'session-1', workspace, sessions, workspaces } = {}) {
  const routes = []
  const ctx = {
    effect(setup) {
      const dispose = setup()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    get(name) {
      if (name === 'workspaceRegistry') {
        return workspaces === undefined
          ? undefined
          : {
              list() {
                return workspaces
              },
            }
      }
      if (name === 'sessions') {
        return {
          get(id) {
            if (sessions !== undefined) return sessions[id]
            return id === sessionId ? { id, header: { cwd: workspace } } : undefined
          },
        }
      }
      if (name === 'workingDirectory') {
        return {
          get(session) {
            return session?.header?.cwd ?? workspace
          },
        }
      }
      return undefined
    },
    logger() {
      return { debug() {}, info() {}, warn() {}, error() {} }
    },
    tools: {
      register() {
        return () => {}
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  apply(ctx, { dataDir: join(tmpdir(), 'inkflow-internal-state') })
  return { ctx, routes }
}

/**
 * A request double. `remoteAddress` defaults to loopback because a real carrier
 * always sets it; a non-loopback peer is the case under test.
 */
function fakeRequest({ url, method = 'GET', host = HOST, origin, remoteAddress = '127.0.0.1', body, contentLength } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  const request = { url, method, headers, socket: { remoteAddress } }
  if (body === undefined && contentLength === undefined) return request
  const buffer = body === undefined ? Buffer.alloc(0) : Buffer.from(body, 'utf8')
  headers['content-length'] = String(contentLength ?? buffer.length)
  request[Symbol.asyncIterator] = async function* iterate() {
    if (buffer.length > 0) yield buffer
  }
  return request
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

async function callRoute(harness, request) {
  const route = harness.routes.find((entry) => entry.path === '/inkflow')
  assert.ok(route, 'expected a /inkflow prefix route')
  const response = fakeResponse()
  await route.handler(request, response)
  return {
    status: response.statusCode,
    headers: response.headers,
    json: response.body === undefined ? undefined : JSON.parse(response.body),
  }
}

function internalCall(harness, path, options = {}) {
  const query = options.sessionId === null ? '' : `sessionId=${encodeURIComponent(options.sessionId ?? 'session-1')}`
  const separator = path.includes('?') ? '&' : '?'
  const url = query === '' ? `${INTERNAL}${path}` : `${INTERNAL}${path}${separator}${query}`
  return callRoute(harness, fakeRequest({ ...options, url }))
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-internal-'))
}

function scaffold(root, { dirs = ALL_DIRS, keeps = true, meta = true } = {}) {
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, '.git'))
  for (const dir of dirs) {
    mkdirSync(join(root, dir), { recursive: true })
    if (keeps) writeFileSync(join(root, dir, KEEP), '', 'utf8')
  }
  if (meta) {
    writeFileSync(
      join(root, 'inkflow.json'),
      `${JSON.stringify({ schemaVersion: 1, title: '通道之书', author: 'tester' }, null, 2)}\n`,
      'utf8',
    )
  }
}

function writeMarkdown(root, relativePath, frontmatterLines, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = frontmatterLines.length > 0 ? `---\n${frontmatterLines.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

function bookProject(root) {
  scaffold(root)
  writeMarkdown(
    root,
    'chapters/vol-01/0001-开篇.md',
    ['id: ch-1', 'title: 开篇', 'volume: vol-01', 'seq: 1', 'status: final'],
    '他走进白鹤门。',
  )
  writeMarkdown(root, 'chapters/0002-散章.md', ['id: ch-2', 'title: 散章', 'seq: 2'], '门外下着雨。')
}

/** Stable content hash: any write inside the project moves it. */
function hashTree(root) {
  const hash = createHash('sha256')
  const walk = (relative) => {
    const dir = relative === '' ? root : join(root, relative)
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      const info = statSync(join(root, child))
      hash.update(`${child}|${entry.isDirectory() ? 'd' : 'f'}|${info.size}|${info.mtimeMs}\n`)
      if (entry.isDirectory()) walk(child)
    }
  }
  walk('')
  return hash.digest('hex')
}

// ---------------------------------------------------------------------------
// 1. Method declaration
// ---------------------------------------------------------------------------

test('internal channel: each route declares its method, so a write verb is a 405', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    for (const path of ['/status', '/chapters', '/chapters/ch-1', '/search?q=雨']) {
      const post = await internalCall(harness, path, { method: 'POST' })
      assert.equal(post.status, 405, `${path} must not accept POST`)
      assert.equal(post.json.ok, false)
      assert.equal(post.json.error.code, 'method-not-allowed')
      assert.equal(post.headers['allow'], 'GET', `${path} must advertise its single method`)
    }

    const del = await internalCall(harness, '/chapters', { method: 'DELETE' })
    assert.equal(del.status, 405)
    assert.equal(del.headers['allow'], 'GET')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. No path parameters, ever (ADR-0008 D4)
// ---------------------------------------------------------------------------

test('internal channel: a path parameter is a 400 before any filesystem access', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root, { dirs: CONTENT_DIRS })
    writeMarkdown(root, 'chapters/0001-甲.md', ['id: c1', 'seq: 1', 'title: 开篇'], '正文')
    const before = hashTree(root)
    const harness = createHarness({ workspace: dir })

    for (const key of ['root', 'path', 'cwd', 'workspace', 'projectRoot']) {
      const refused = await callRoute(
        harness,
        fakeRequest({ url: `${INTERNAL}/status?sessionId=session-1&${key}=${encodeURIComponent(root)}` }),
      )
      assert.equal(refused.status, 400, `?${key}= must be refused`)
      assert.equal(refused.json.ok, false)
      assert.equal(refused.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')
      // ADR-0008 D4 called this `unexpected-path-param`; both spellings address
      // the same refusal, so the wire carries the ADR slug as its reason.
      assert.equal(refused.json.error.reason, 'unexpected-path-param')
      assert.equal(refused.json.error.param, key)
    }

    const bodyParam = await internalCall(harness, '/status', { method: 'GET', body: JSON.stringify({ root }) })
    assert.equal(bodyParam.status, 400)
    assert.equal(bodyParam.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')

    // Nothing was read as a project: index/ was neither created nor rebuilt.
    assert.equal(hashTree(root), before)
    assert.equal(existsSync(join(root, 'index')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. No session identity → structured refusal, no guess (ADR-0008 D4/V7)
// ---------------------------------------------------------------------------

test('internal channel: with no resolvable session it answers NO_SESSION_CONTEXT', async () => {
  const dir = workdir()
  try {
    const harness = createHarness({ workspace: undefined })
    for (const path of ['/status', '/chapters', '/chapters/ch-1', '/search?q=x']) {
      const missing = await internalCall(harness, path, { sessionId: null })
      assert.equal(missing.status, 200, 'no session is "cannot answer yet", not a transport failure')
      assert.equal(missing.json.ok, false)
      assert.equal(missing.json.error.code, 'NO_SESSION_CONTEXT')
      assert.ok(Array.isArray(missing.json.error.actions) && missing.json.error.actions.length > 0)
    }

    const unknown = await internalCall(harness, '/status', { sessionId: 'session-does-not-exist' })
    assert.equal(unknown.json.error.code, 'NO_SESSION_CONTEXT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. Fail-closed guards (ADR-0004 clauses that ADR-0008 keeps)
// ---------------------------------------------------------------------------

test('internal channel: only a loopback host, origin and peer are served', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    const rebind = await callRoute(harness, fakeRequest({ url: `${INTERNAL}/status?sessionId=session-1`, host: 'evil.example.com' }))
    assert.equal(rebind.status, 403)
    assert.equal(rebind.json.error.code, 'forbidden-host')

    const crossSite = await callRoute(
      harness,
      fakeRequest({ url: `${INTERNAL}/status?sessionId=session-1`, origin: 'https://evil.example.com' }),
    )
    assert.equal(crossSite.status, 403)
    assert.equal(crossSite.json.error.code, 'forbidden-origin')

    const remotePeer = await callRoute(
      harness,
      fakeRequest({ url: `${INTERNAL}/status?sessionId=session-1`, remoteAddress: '192.168.1.5' }),
    )
    assert.equal(remotePeer.status, 403)
    assert.equal(remotePeer.json.error.code, 'forbidden-remote')

    const sameOrigin = await callRoute(
      harness,
      fakeRequest({ url: `${INTERNAL}/status?sessionId=session-1`, origin: 'http://127.0.0.1:2149' }),
    )
    assert.equal(sameOrigin.status, 200)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. The gate verdict, with zero writes (ADR-0008 D4/V9)
// ---------------------------------------------------------------------------

test('internal channel: a non-usable project answers the checklist and writes nothing', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    // No index/ at all: `inspectProject` would happily create it (ADR-0006 D2
    // relaxation), which is exactly the write a browser request must not cause.
    scaffold(root, { dirs: CONTENT_DIRS.filter((name) => name !== 'world' && name !== 'outlines') })
    const harness = createHarness({ workspace: root })
    const before = hashTree(root)

    const status = await internalCall(harness, '/status')
    assert.equal(status.status, 200)
    assert.equal(status.json.ok, false)
    const error = status.json.error
    assert.equal(error.code, 'PROJECT_NEEDS_REPAIR')
    assert.equal(error.state, 'needs-repair')
    assert.equal(error.needsRepair, true)
    assert.deepEqual([...error.missing].sort(), [
      'index',
      'index/.gitkeep',
      'outlines',
      'outlines/.gitkeep',
      'world',
      'world/.gitkeep',
    ])
    assert.equal(typeof error.checks.dirs.world, 'boolean')
    assert.ok(Array.isArray(error.actions) && error.actions.length > 0)
    assert.equal(error.readOnly, false)

    // Every projection routes through the same gate.
    for (const path of ['/chapters', '/chapters/ch-1', '/search?q=x']) {
      const refused = await internalCall(harness, path)
      assert.equal(refused.status, 200)
      assert.equal(refused.json.error.code, 'PROJECT_NEEDS_REPAIR')
      assert.deepEqual(refused.json.error.missing, error.missing)
    }

    // The browser surface must never repair on its own: no index/, no writes.
    assert.equal(hashTree(root), before)
    assert.equal(existsSync(join(root, 'index')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. The old API prefix is gone (ADR-0008 D3/V8)
// ---------------------------------------------------------------------------

test('internal channel: /inkflow/api/* is 404 and unknown internal paths are 404', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    for (const url of ['/inkflow/api/status', '/inkflow/api/chapters', '/inkflow/api', '/inkflow/other']) {
      const gone = await callRoute(harness, fakeRequest({ url: `${url}?sessionId=session-1` }))
      assert.equal(gone.status, 404, `${url} must be gone`)
      assert.equal(gone.json.error.code, 'not-found')
    }

    const unknown = await internalCall(harness, '/nope')
    assert.equal(unknown.status, 404)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7. Hardening headers, no CORS
// ---------------------------------------------------------------------------

test('internal channel: every response is uncached, nosniff and CORS-free', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    const responses = [
      await internalCall(harness, '/status'),
      await internalCall(harness, '/nope'),
      await callRoute(harness, fakeRequest({ url: `${INTERNAL}/status`, host: 'evil.example.com' })),
    ]
    for (const response of responses) {
      assert.equal(response.headers['cache-control'], 'no-store')
      assert.equal(response.headers['x-content-type-options'], 'nosniff')
      assert.match(response.headers['content-type'], /^application\/json/)
      const cors = Object.keys(response.headers).filter((key) => key.toLowerCase().startsWith('access-control-'))
      assert.deepEqual(cors, [], 'the channel never advertises CORS')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 8. Bounded request bodies
// ---------------------------------------------------------------------------

test('internal channel: a request body above 64 KiB is refused with 413', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    const declared = await internalCall(harness, '/status', { contentLength: 64 * 1024 + 1 })
    assert.equal(declared.status, 413)
    assert.equal(declared.json.error.code, 'payload-too-large')

    const oversized = await internalCall(harness, '/status', { body: 'x'.repeat(64 * 1024 + 1) })
    assert.equal(oversized.status, 413)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 9. Status projection, resolved from the session
// ---------------------------------------------------------------------------

test('internal channel: /status projects the session workspace, gate and index summary', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    const status = await internalCall(harness, '/status')
    assert.equal(status.status, 200)
    assert.equal(status.json.ok, true)
    const value = status.json.value
    assert.equal(value.root, root)
    assert.equal(value.state, 'usable')
    assert.equal(value.resolvedFrom, 'working-directory')
    assert.equal(value.sessionId, 'session-1')
    assert.equal(value.meta.title, '通道之书')
    assert.equal(value.index.dbExists, false, 'reading the panel must not build the index')
    assert.equal(value.index.schemaMatches, false)
    assert.equal(value.catalog.chapters, 2)
    assert.equal(value.search.available, false, 'body search arrives with the index v2 tree')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 10. Chapters tree
// ---------------------------------------------------------------------------

test('internal channel: /chapters groups volume chapters and loose chapters', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    const listed = await internalCall(harness, '/chapters')
    assert.equal(listed.status, 200)
    assert.equal(listed.json.ok, true)
    const value = listed.json.value
    assert.equal(value.total, 2)
    assert.equal(value.volumes.length, 1)
    assert.equal(value.volumes[0].dir, 'vol-01')
    assert.deepEqual(
      value.volumes[0].chapters.map((chapter) => chapter.id),
      ['ch-1'],
    )
    assert.deepEqual(
      value.looseChapters.map((chapter) => chapter.id),
      ['ch-2'],
    )
    assert.equal(value.volumes[0].chapters[0].path, 'chapters/vol-01/0001-开篇.md')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 11. Chapter detail: frontmatter + body, read-only, no traversal
// ---------------------------------------------------------------------------

test('internal channel: /chapters/:id returns frontmatter and body without writing', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    const before = hashTree(root)

    const detail = await internalCall(harness, '/chapters/ch-1')
    assert.equal(detail.status, 200)
    assert.equal(detail.json.ok, true)
    const value = detail.json.value
    assert.equal(value.id, 'ch-1')
    assert.equal(value.path, 'chapters/vol-01/0001-开篇.md')
    assert.equal(value.frontmatter.title, '开篇')
    assert.equal(value.frontmatter.status, 'final')
    // The body is returned verbatim (it may start with the blank line that
    // separated it from the frontmatter); `bodyChars` ignores whitespace.
    assert.equal(value.body.trim(), '他走进白鹤门。')
    assert.equal(value.bodyChars, 7)
    assert.equal(hashTree(root), before)

    // A path-looking id must not escape chapters/, and an unknown id is a 404.
    for (const id of ['..%2Finkflow.json', '..%2F..%2Fsecret.md', 'ch-404']) {
      const refused = await internalCall(harness, `/chapters/${id}`)
      assert.equal(refused.status, 404, `${id} must not resolve`)
      assert.equal(refused.json.error.code, 'chapter-not-found')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 12. Search: index LIKE today, honest about missing body search (#22)
// ---------------------------------------------------------------------------

test('internal channel: /search matches the index chapter table and flags body search', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    // Issue #5: the read path makes the derived index fresh first (it is a
    // cache, not the truth), so the first search fills it and answers from it.
    const empty = await internalCall(harness, '/search?q=雨')
    assert.equal(empty.status, 200)
    assert.equal(empty.json.ok, true)
    assert.equal(empty.json.value.searchUnavailable, true)
    assert.equal(empty.json.value.searchScope, 'chapter-metadata')
    assert.equal(empty.json.value.indexState, 'missing')
    assert.equal(empty.json.value.indexRebuilt, true)
    assert.equal(existsSync(join(root, 'index', 'inkflow.db')), true, 'the panel read filled the cache')

    const hit = await internalCall(harness, '/search?q=散章')
    assert.equal(hit.json.value.total, 1)
    assert.equal(hit.json.value.results[0].id, 'ch-2')
    assert.equal(hit.json.value.results[0].kind, 'chapter')

    const none = await internalCall(harness, '/search?q=不存在的词')
    assert.equal(none.json.value.total, 0)
    assert.deepEqual(none.json.value.results, [])

    const missingQuery = await internalCall(harness, '/search')
    assert.equal(missingQuery.status, 400)
    assert.equal(missingQuery.json.error.code, 'QUERY_REQUIRED')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 13. Resolution order: registry first, session directory second
// ---------------------------------------------------------------------------

test('internal channel: the workspace registry wins over the session directory', async () => {
  const dir = workdir()
  try {
    const registered = join(dir, 'registered-book')
    const sessionDir = join(dir, 'session-dir')
    bookProject(registered)
    bookProject(sessionDir)
    const harness = createHarness({
      sessionId: 'session-9',
      sessions: { 'session-9': { id: 'session-9', header: { cwd: sessionDir } } },
      workspaces: [{ path: registered, sessionIds: ['session-9'] }],
    })

    const status = await internalCall(harness, '/status', { sessionId: 'session-9' })
    assert.equal(status.json.ok, true)
    assert.equal(status.json.value.root, registered)
    assert.equal(status.json.value.resolvedFrom, 'workspace-registry')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 14. Both spellings of a session id resolve
// ---------------------------------------------------------------------------

test('internal channel: a session id resolves with or without the `session-` prefix', async () => {
  const dir = workdir()
  try {
    const registered = join(dir, 'registered-book')
    bookProject(registered)
    // The host stores `sessionIds` with the prefix (observed in
    // ~/.dsh/storages/workspace.json) while protocol surfaces may hand over the
    // bare uuid: neither spelling may turn into a false NO_SESSION_CONTEXT.
    const harness = createHarness({
      sessions: { 'session-abc-123': { id: 'session-abc-123', header: { cwd: registered } } },
      workspaces: [{ path: registered, sessionIds: ['session-abc-123'] }],
    })

    const prefixed = await internalCall(harness, '/status', { sessionId: 'session-abc-123' })
    assert.equal(prefixed.json.ok, true)
    assert.equal(prefixed.json.value.root, registered)

    const bare = await internalCall(harness, '/status', { sessionId: 'abc-123' })
    assert.equal(bare.json.ok, true)
    assert.equal(bare.json.value.root, registered)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
