/**
 * Contract tests for the book hub (ADR-0010).
 *
 * The hub is the **no-session** half of the private channel: a root-scoped panel
 * has no `sessionId`, so the book list is read from the Host `workspaceRegistry`
 * and every row is judged with the same `inspectProject` the workbench uses
 * (ADR-0010 D2/D5). These tests pin four things:
 *
 *   1. SHAPE — `GET /inkflow/internal/hub/books` answers
 *      `{ok:true,value:{books[],total,capped,truncated,readOnly:true}}`, one row
 *      per registered workspace, in registry order, with the four-state verdict,
 *      `dirStatus`, `missing[]`/`actions[]` and optional catalog counts.
 *   2. NO SESSION — the route needs no `sessionId` at all, ignores one if sent,
 *      and refuses a path parameter exactly like the session routes do.
 *   3. ZERO WRITES — a whole-tree hash of every known project root is identical
 *      before and after the request (no `index/`, no catalog, no meta touched).
 *   4. COST (ADR-0010 D8) — concurrency 4, 2 s per book → `state:'timeout'`,
 *      3 s budget and 200 rows → `truncated`/`capped`, no retry. The cost tests
 *      drive `buildHubBooks` directly with an injected probe so they stay fast
 *      and deterministic instead of sleeping for real seconds.
 *
 * Run: pnpm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HUB_BOOK_TIMEOUT_MS, HUB_CONCURRENCY, HUB_MAX_BOOKS, HUB_TOTAL_BUDGET_MS, apply, buildHubBooks, writeSettings } from '../lib/index.js'
import { createStateDir } from './state-dir.mjs'

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const ALL_DIRS = [...CONTENT_DIRS, 'index']
const KEEP = '.gitkeep'
const HOST = '127.0.0.1:2149'
const INTERNAL = '/inkflow/internal'
const HUB = `${INTERNAL}/hub`

// ---------------------------------------------------------------------------
// Harness: the /inkflow prefix route and the single Host service the hub reads
// ---------------------------------------------------------------------------

const STATE_DIR = createStateDir('inkflow-hub-state')

function createHarness({ workspaces } = {}) {
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
      if (name !== 'workspaceRegistry') return undefined
      if (workspaces === undefined) return undefined
      return {
        list() {
          return workspaces
        },
      }
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
  apply(ctx, { dataDir: STATE_DIR })
  return { ctx, routes }
}

/** Registry entries for the given directories, in order. */
function workspacesOf(...entries) {
  return entries.map((entry) => (typeof entry === 'string' ? { id: `ws-${entry}`, path: entry } : entry))
}

function fakeRequest({ url, method = 'GET', host = HOST, origin, remoteAddress = '127.0.0.1', body } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  const request = { url, method, headers, socket: { remoteAddress } }
  if (body === undefined) return request
  const buffer = Buffer.from(body, 'utf8')
  headers['content-length'] = String(buffer.length)
  request[Symbol.asyncIterator] = async function* iterate() {
    yield buffer
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

function hubCall(harness, path, options = {}) {
  return callRoute(harness, fakeRequest({ ...options, url: `${HUB}${path}` }))
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-hub-'))
}

function scaffold(root, { dirs = ALL_DIRS, keeps = true, meta = true, git = true } = {}) {
  mkdirSync(root, { recursive: true })
  if (git) mkdirSync(join(root, '.git'))
  for (const dir of dirs) {
    mkdirSync(join(root, dir), { recursive: true })
    if (keeps) writeFileSync(join(root, dir, KEEP), '', 'utf8')
  }
  if (meta) {
    writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '书库之书', author: 'tester' }, null, 2)}\n`, 'utf8')
    writeFileSync(join(root, '.gitignore'), 'index/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  }
}

/** A committed catalog projection: one volume with two chapters, one loose chapter. */
function writeCatalog(root) {
  const volume = { volumeId: 'vol-01', dir: 'vol-01-入山', title: '入山', order: 1 }
  writeFileSync(
    join(root, 'chapters', 'index.json'),
    `${JSON.stringify({ schemaVersion: 1, volumes: [volume], looseChapters: [{ chapterId: 'loose', file: 'chapters/loose.md', title: '散章' }] }, null, 2)}\n`,
    'utf8',
  )
  mkdirSync(join(root, 'chapters', volume.dir), { recursive: true })
  writeFileSync(
    join(root, 'chapters', volume.dir, 'index.json'),
    `${JSON.stringify({ schemaVersion: 1, volumeId: volume.volumeId, chapters: [
      { chapterId: 'c1', file: `chapters/${volume.dir}/0001.md`, title: '第一章' },
      { chapterId: 'c2', file: `chapters/${volume.dir}/0002.md`, title: '第二章' },
    ] }, null, 2)}\n`,
    'utf8',
  )
}

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

/** Two usable books, one `needs-repair`, one registered directory that is gone,
 *  and one complete book whose derived `index/` the user deleted. */
function fourBooks() {
  const base = workdir()
  const a = join(base, 'book-a')
  const b = join(base, 'book-b')
  const c = join(base, 'book-c')
  const gone = join(base, 'book-gone')
  const noIndex = join(base, 'book-no-index')
  scaffold(a)
  writeCatalog(a)
  scaffold(b)
  // `needs-repair`: one `.gitkeep` is missing.
  scaffold(c, { keeps: false })
  // Everything but `index/`: `inspectProject` would CREATE it unless the caller
  // passes `recreateIndexDir: false`. This is the write the hub must never do.
  scaffold(noIndex, { dirs: CONTENT_DIRS })
  const workspaces = workspacesOf(
    { id: 'ws-a', path: a, title: '书甲' },
    { id: 'ws-b', path: b },
    { id: 'ws-c', path: c, title: '书丙' },
    { id: 'ws-gone', path: gone, title: '已删之书' },
    { id: 'ws-no-index', path: noIndex, title: '无索引之书' },
  )
  return { base, a, b, c, gone, noIndex, workspaces }
}

// ---------------------------------------------------------------------------
// 1. Shape: one row per registered workspace, in registry order
// ---------------------------------------------------------------------------

test('GET /hub/books lists every registered workspace with the four-state verdict', async () => {
  const { a, b, c, gone, noIndex, workspaces } = fourBooks()
  const harness = createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) })
  // `book-gone` exists on disk for `status()`-less registries, so remove it: the
  // row must say "missing-dir" rather than pretend the book needs setup.
  rmSync(gone, { recursive: true, force: true })

  const response = await hubCall(harness, '/books', {})
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)

  const value = response.json.value
  assert.equal(value.readOnly, true, 'the hub channel is read-only by contract')
  assert.equal(value.total, 5, 'total counts the registered workspaces')
  assert.equal(value.capped, false)
  assert.equal(value.truncated, false)
  assert.equal(typeof value.home, 'string', 'the panel needs home to show ~/paths')
  assert.deepEqual(
    value.books.map((row) => row.path),
    [a, b, c, gone, noIndex],
    'rows keep the registry order',
  )

  const [rowA, rowB, rowC, rowGone, rowNoIndex] = value.books
  assert.equal(rowA.workspaceId, 'ws-a')
  assert.equal(rowA.title, '书甲', 'the registry title wins')
  assert.equal(rowA.state, 'usable')
  assert.equal(rowA.usable, true)
  assert.equal(rowA.dirStatus, 'ok')
  assert.deepEqual(rowA.missing, [])
  assert.deepEqual(rowA.actions, [])
  assert.deepEqual(rowA.counts, { chapters: 3, volumes: 1 }, 'counts come from the committed catalog')

  assert.equal(rowB.title, 'book-b', 'a titleless workspace falls back to the directory name')
  assert.equal(rowB.state, 'usable')
  assert.equal(rowB.counts, undefined, 'no catalog on disk: counts stay unknown, nothing is rebuilt')

  assert.equal(rowC.state, 'needs-repair')
  assert.equal(rowC.usable, false)
  assert.ok(rowC.missing.length > 0, 'needs-repair carries the checklist')
  assert.ok(rowC.actions.length > 0, 'needs-repair carries the wizard actions')

  assert.equal(rowGone.dirStatus, 'missing-dir')
  assert.equal(rowGone.usable, false)

  assert.equal(rowNoIndex.state, 'usable', 'the derived index/ is not part of "is this a book"')
  assert.equal(rowNoIndex.actions.some((action) => action.type === 'create-dir' && action.path.endsWith('index')), true)
  assert.equal(existsSync(join(noIndex, 'index')), false, 'reading the hub never creates index/')
  assert.equal(existsSync(join(gone, 'index')), false, 'a missing directory is never recreated')

  for (const root of [a, b, c]) assert.ok(existsSync(root))
})

test('a registered directory that is not a book is marked notABook and left alone', async () => {
  const base = workdir()
  const plain = join(base, 'plain-project')
  mkdirSync(plain, { recursive: true })
  writeFileSync(join(plain, 'README.md'), '# 不是小说\n', 'utf8')
  const before = hashTree(plain)

  const harness = createHarness({ workspaces: workspacesOf({ id: 'ws-plain', path: plain, title: '普通目录' }) })
  const response = await hubCall(harness, '/books')

  assert.equal(response.status, 200)
  const [row] = response.json.value.books
  assert.equal(row.state, 'needs-setup')
  assert.equal(row.notABook, true, 'no meta and no content directory means "not a book yet"')
  assert.equal(row.dirStatus, 'ok')
  assert.equal(hashTree(plain), before, 'a non-book directory is never initialised by the hub')
})

test('Workspace.status decides dirStatus when the registry exposes it', async () => {
  const base = workdir()
  const first = join(base, 'first')
  const second = join(base, 'second')
  scaffold(first)
  scaffold(second)

  // Host 0.2.1-rc.2 exposes `Workspace.status()`; reported status wins over the
  // filesystem, because that is the registry's own verdict on the registration.
  const registry = [
    { id: 'ws-ok', path: first, status: () => 'ok' },
    { id: 'ws-gone', path: second, status: () => 'missing-dir' },
  ]
  const response = await hubCall(createHarness({ workspaces: registry }), '/books')
  assert.deepEqual(
    response.json.value.books.map((row) => row.dirStatus),
    ['ok', 'missing-dir'],
  )
  assert.equal(response.json.value.books[1].state, 'needs-setup', 'a gone directory is not judged at all')

  // An unfamiliar status() (or one that throws) is not a verdict: fall back to
  // one stat instead of guessing.
  const odd = [
    { id: 'ws-odd', path: first, status: () => 'wat' },
    {
      id: 'ws-throw',
      path: second,
      status: () => {
        throw new Error('status exploded')
      },
    },
  ]
  const fallback = await hubCall(createHarness({ workspaces: odd }), '/books')
  assert.deepEqual(
    fallback.json.value.books.map((row) => row.dirStatus),
    ['ok', 'ok'],
    'both directories exist, so the stat fallback says ok',
  )
})

test('an empty registry answers an empty list, not an error', async () => {
  const harness = createHarness({ workspaces: [] })
  const response = await hubCall(harness, '/books')
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.deepEqual(response.json.value.books, [])
  assert.equal(response.json.value.total, 0)
  assert.equal(response.json.value.truncated, false)
})

test('the same directory registered twice is listed once, with a duplicate count', async () => {
  const { a } = fourBooks()
  const harness = createHarness({
    workspaces: workspacesOf({ id: 'ws-1', path: a, title: '书甲' }, { id: 'ws-2', path: a, title: '书甲（副本）' }),
  })
  const response = await hubCall(harness, '/books')
  const value = response.json.value
  assert.equal(value.books.length, 1, 'one book per canonical directory')
  assert.equal(value.total, 1)
  assert.equal(value.books[0].duplicates, 1)
})

// ---------------------------------------------------------------------------
// 2. Guards: no session required, no path parameter accepted, fail-closed host
// ---------------------------------------------------------------------------

test('the hub route needs no session id and ignores one that is sent', async () => {
  const { workspaces } = fourBooks()
  const bare = await hubCall(createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) }), '/books')
  assert.equal(bare.status, 200)
  assert.equal(bare.json.ok, true, 'the hub is the no-session channel: no sessionId is required')

  const withSession = await hubCall(
    createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) }),
    '/books?sessionId=session-1',
  )
  assert.equal(withSession.status, 200, 'a stray sessionId must not turn the hub into a session route')
  assert.equal(withSession.json.ok, true)
  assert.equal(withSession.json.value.total, 5)
})

test('a path parameter is refused before any filesystem access', async () => {
  const { a, workspaces } = fourBooks()
  const harness = createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) })
  const before = hashTree(a)

  for (const [param, value] of [
    ['root', '/tmp/x'],
    ['path', '/tmp/x'],
    ['cwd', '/tmp/x'],
    ['workspace', '/tmp/x'],
    ['projectRoot', '/tmp/x'],
  ]) {
    const response = await hubCall(harness, `/books?${param}=${encodeURIComponent(value)}`)
    assert.equal(response.status, 400, `${param}= is refused`)
    assert.equal(response.json.ok, false)
    assert.equal(response.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')
    assert.equal(response.json.error.param, param)
    assert.equal(response.json.error.in, 'query')
  }

  const inBody = await hubCall(harness, '/books', { body: JSON.stringify({ path: '/tmp/x' }) })
  assert.equal(inBody.status, 400, 'a path in the body is refused too')
  assert.equal(inBody.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')
  assert.equal(inBody.json.error.in, 'body')

  assert.equal(hashTree(a), before, 'refused requests touch nothing')
})

test('the hub guards fail closed and never alias the removed /inkflow/api/* prefix', async () => {
  const { workspaces } = fourBooks()
  const harness = createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) })

  const forgedHost = await hubCall(harness, '/books', { host: 'evil.example' })
  assert.equal(forgedHost.status, 403)
  assert.equal(forgedHost.json.error.code, 'forbidden-host')

  const crossSite = await hubCall(harness, '/books', { origin: 'http://evil.example' })
  assert.equal(crossSite.status, 403)
  assert.equal(crossSite.json.error.code, 'forbidden-origin')

  const remotePeer = await hubCall(harness, '/books', { remoteAddress: '10.0.0.9' })
  assert.equal(remotePeer.status, 403)
  assert.equal(remotePeer.json.error.code, 'forbidden-remote')

  const wrongMethod = await hubCall(harness, '/books', { method: 'POST' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.json.error.code, 'method-not-allowed')
  assert.equal(wrongMethod.headers.allow, 'GET')

  // `/hub/plan` and `/hub/apply` exist (POST only); `/hub/shared`
  // exists (GET only). A path no build declares is still 404.
  const planVerb = await hubCall(harness, '/plan')
  assert.equal(planVerb.status, 405, '/hub/plan is declared and POST-only')
  assert.equal(planVerb.json.error.code, 'method-not-allowed')
  assert.equal(planVerb.headers.allow, 'POST')

  const unknown = await hubCall(harness, '/not-a-route')
  assert.equal(unknown.status, 404, 'a hub route this build does not declare answers 404')

  const legacy = await callRoute(harness, fakeRequest({ url: '/inkflow/api/status' }))
  assert.equal(legacy.status, 404, '/inkflow/api/* stays gone (ADR-0008 D3)')

  const responses = [forgedHost, crossSite, remotePeer, wrongMethod, planVerb, unknown, legacy]
  for (const response of responses) {
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.headers['x-content-type-options'], 'nosniff')
  }
})

test('a profile without the workspace registry degrades to HUB_UNAVAILABLE', async () => {
  const harness = createHarness({ workspaces: undefined })
  const response = await hubCall(harness, '/books')
  assert.equal(response.status, 200, 'a missing Host service is data, not a transport failure')
  assert.equal(response.json.ok, false)
  assert.equal(response.json.error.code, 'HUB_UNAVAILABLE')
  assert.equal(typeof response.json.error.hint, 'string')
})

// ---------------------------------------------------------------------------
// 3. Zero writes: the whole tree of every project root is identical
// ---------------------------------------------------------------------------

test('listing the hub writes nothing anywhere', async () => {
  const { a, b, c, noIndex, workspaces, base } = fourBooks()
  const harness = createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) })
  const before = { a: hashTree(a), b: hashTree(b), c: hashTree(c), noIndex: hashTree(noIndex), base: hashTree(base) }

  const response = await hubCall(harness, '/books')
  assert.equal(response.json.ok, true)

  assert.equal(hashTree(a), before.a, 'the usable book is untouched')
  assert.equal(hashTree(b), before.b, 'a book without a catalog does not get one')
  assert.equal(hashTree(c), before.c, 'the broken book is not repaired')
  assert.equal(hashTree(noIndex), before.noIndex, 'index/ is NOT created for a book that lost it')
  assert.equal(hashTree(base), before.base, 'nothing new appears next to the books')
})

// ---------------------------------------------------------------------------
// 4. Cost: concurrency 4, 2 s per book, 3 s budget, 200 rows (ADR-0010 D8)
// ---------------------------------------------------------------------------

function registryOf(paths) {
  return {
    list() {
      return paths.map((path, index) => ({ id: `ws-${index}`, path }))
    },
  }
}

function probeCtx(paths) {
  // The directories must exist: a registered-but-deleted directory is reported
  // as `missing-dir` without a probe, which is a different scenario.
  for (const path of paths) mkdirSync(path, { recursive: true })
  return { get: (name) => (name === 'workspaceRegistry' ? registryOf(paths) : undefined) }
}

/** A usable verdict without touching the disk (the cost tests are about time). */
function usableProbe(root) {
  return {
    root,
    state: 'usable',
    checks: { git: true, dirs: {}, keeps: {}, meta: true },
    missingDirs: [],
    missing: [],
    actions: [],
    readOnly: false,
    usable: true,
    reasons: [],
    indexDirRecreated: false,
  }
}

test('the hub cost contract is pinned: 4 at a time, 2 s per book, 3 s budget, 200 rows', () => {
  // ADR-0010 D8. These numbers ARE the contract: tuning them is a spec change,
  // not an implementation detail, so the test fails if one drifts.
  assert.equal(HUB_CONCURRENCY, 4)
  assert.equal(HUB_BOOK_TIMEOUT_MS, 2_000)
  assert.equal(HUB_TOTAL_BUDGET_MS, 3_000)
  assert.equal(HUB_MAX_BOOKS, 200)
})

test('state reads are capped at four at a time', async () => {
  const base = workdir()
  const paths = Array.from({ length: 12 }, (_, index) => join(base, `book-${index}`))
  let active = 0
  let peak = 0
  const probe = async (root) => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return usableProbe(root)
  }

  const result = await buildHubBooks(probeCtx(paths), { probe, concurrency: 4 })
  assert.equal(result.ok, true)
  assert.equal(result.value.books.length, 12)
  assert.ok(peak <= 4, `at most four concurrent judgments, saw ${peak}`)
  assert.ok(peak > 1, 'the judgments really do run in parallel')
})

test('a book that misses the 2 s deadline becomes a timeout row and is not retried', async () => {
  const base = workdir()
  const fast = join(base, 'fast')
  const slow = join(base, 'slow')
  let slowCalls = 0
  const probe = (root) => {
    if (root === slow) {
      slowCalls += 1
      return new Promise(() => {})
    }
    return usableProbe(root)
  }

  const result = await buildHubBooks(probeCtx([fast, slow]), { probe, bookTimeoutMs: 30, budgetMs: 5_000 })
  assert.equal(result.ok, true)
  const rows = result.value.books
  assert.equal(rows.length, 2, 'the slow book still gets a row')
  assert.equal(rows[0].state, 'usable')
  assert.equal(rows[1].state, 'timeout')
  assert.equal(rows[1].usable, false)
  assert.equal(result.value.truncated, false)
  assert.equal(slowCalls, 1, 'a timed-out judgment is never retried')
})

test('the whole listing answers within its budget and says it is truncated', async () => {
  const base = workdir()
  const paths = Array.from({ length: 8 }, (_, index) => join(base, `slow-${index}`))
  const probe = async (root) => {
    await new Promise((resolve) => setTimeout(resolve, 40))
    return usableProbe(root)
  }

  const result = await buildHubBooks(probeCtx(paths), { probe, concurrency: 4, budgetMs: 30, bookTimeoutMs: 5_000 })
  assert.equal(result.ok, true)
  assert.equal(result.value.truncated, true, 'a spent budget is reported, not hidden')
  assert.equal(result.value.books.length, 4, 'the first wave (four judgments) fits before the budget runs out')
  assert.equal(result.value.total, paths.length, 'total still counts every registered workspace')
})

test('the row cap keeps the answer bounded and flags capped plus truncated', async () => {
  const base = workdir()
  const paths = Array.from({ length: 6 }, (_, index) => join(base, `book-${index}`))
  const result = await buildHubBooks(probeCtx(paths), { probe: (root) => usableProbe(root), limit: 2 })
  assert.equal(result.ok, true)
  assert.equal(result.value.books.length, 2)
  assert.equal(result.value.capped, true)
  assert.equal(result.value.truncated, true)
  assert.equal(result.value.total, 6)
})

test('a judgment that throws is reported as a row, not as a failed request', async () => {
  const base = workdir()
  const paths = [join(base, 'ok'), join(base, 'boom')]
  const probe = (root) => {
    if (root.endsWith('boom')) throw new Error('disk on fire')
    return usableProbe(root)
  }

  const result = await buildHubBooks(probeCtx(paths), { probe })
  assert.equal(result.ok, true)
  assert.equal(result.value.books.length, 2)
  assert.equal(result.value.books[1].state, 'timeout')
})

// ---------------------------------------------------------------------------
// 5. The semantic badge: local files only, never a probe
// ---------------------------------------------------------------------------

/**
 * WHY THE REQUEST COUNTER IS THE ASSERTION. The badge is drawn for every registered book on
 * every refresh, so "how do you know this book is (not) indexed" must be answerable without
 * a socket. A stub OpenViking is listening and the settings point at it: after the whole list
 * has been judged, it must still have received nothing. If that ever changes, 200 books
 * become 200 HTTP requests and the book list gets slowest exactly when the server is down.
 */
test('every row carries the semantic badge, read from local files with zero network', async () => {
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok', result: { healthy: true } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${String(server.address().port)}`
  try {
    const base = workdir()
    const dataDir = join(base, 'state')
    const withPeer = join(base, 'book-peer')
    const withoutPeer = join(base, 'book-plain')
    scaffold(withPeer)
    scaffold(withoutPeer)
    // A configured, reachable backend and a book that carries a peer — and nothing built yet.
    mkdirSync(join(withPeer, '.openviking'), { recursive: true })
    writeFileSync(join(withPeer, '.openviking', 'config.local.json'), `${JSON.stringify({ version: 1, peer: { id: 'shushan' } })}\n`, 'utf8')
    const written = writeSettings(dataDir, { confirm: true, semanticSearch: true, semanticEndpoint: endpoint })
    assert.equal(written.ok, true, JSON.stringify(written.error))

    const result = await buildHubBooks(probeCtx([withPeer, withoutPeer]), { probe: usableProbe, dataDir })
    assert.equal(result.ok, true)
    const [peerRow, plainRow] = result.value.books
    assert.equal(peerRow.semantic.state, 'no-ledger', 'configured, but never built for THIS book')
    assert.match(peerRow.semantic.headline, /还没有索引账本/u)
    assert.equal(peerRow.semantic.hasLedger, false)
    assert.equal(plainRow.semantic.state, 'unconfigured', 'nothing to build WITH: no peer in that book')
    assert.equal(plainRow.semantic.reason, 'no-peer')
    assert.equal(requests.length, 0, `the badge never probes: ${String(requests.length)} request(s) reached the stub`)

    // No `dataDir` = a caller that cannot read the plugin state: the field is absent, which
    // the panel renders as no badge. Absent is "cannot tell", never a verdict.
    const bare = await buildHubBooks(probeCtx([withPeer]), { probe: usableProbe })
    assert.equal(bare.value.books[0].semantic, undefined)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
