/**
 * Contract tests for the shared library's HUB ROUTES and TOOLS (#40).
 *
 * `tests/shared-copy.test.js` proves what a copy IS. This file proves the two
 * surfaces that reach it are wired the way the channel requires:
 *
 *   1. ANCHOR — the panel is root-scoped and has no session (ADR-0010 D3), so the
 *      target book must be named. `/hub/shared/copy` accepts `book` and nothing
 *      else, and only a path the Host's own registry listed; an unregistered path
 *      is refused before any write (proved with a whole-tree hash).
 *   2. GUARDS — a hub write requires a same-origin `Origin` (ADR-0010 D6 #6), the
 *      body field allowlist holds (`root`/`path` are refused as path parameters),
 *      and a wrong verb is a 405 before any handler runs.
 *   3. READ SIDE — `GET /hub/shared/copies?book=…` answers the stale list, and it
 *      writes nothing at all (the book AND the shared library are hashed).
 *   4. TOOLS — `inkflow_shared_copy` / `inkflow_shared_update` resolve the book from
 *      the session working directory like every other built-in, refuse without
 *      `confirm: true`, and `inkflow_shared_list` answers even when the session is
 *      not inside a book (the library belongs to no project).
 *
 * Run: pnpm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { hashTree } from './hash-tree.mjs'
import { apply } from '../lib/index.js'

const HOST = '127.0.0.1:2149'
const ORIGIN = `http://${HOST}`
const HUB = '/inkflow/internal/hub'

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']

// ---------------------------------------------------------------------------
// Harness: a fake Cordis context with a workspace registry of ONE book
// ---------------------------------------------------------------------------

function createHarness({ dataDir, book }) {
  const routes = []
  const tools = new Map()
  const workspaces = [{ id: 'ws-1', path: book, title: '测试书' }]
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
    get(service) {
      if (service === 'workspaceRegistry') {
        return {
          list() {
            return workspaces
          },
        }
      }
      if (service === 'workingDirectory') {
        return { ensure: async () => book }
      }
      return undefined
    },
    logger() {
      return { debug() {}, info() {}, warn() {}, error() {} }
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
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
  apply(ctx, { dataDir })
  return { ctx, routes, tools }
}

function fakeRequest({ url, method = 'GET', host = HOST, origin, body } = {}) {
  const headers = { host, 'content-type': 'application/json' }
  if (origin !== undefined) headers.origin = origin
  const request = { url, method, headers, socket: { remoteAddress: '127.0.0.1' } }
  if (body === undefined) return request
  const buffer = Buffer.from(JSON.stringify(body), 'utf8')
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

async function call(harness, request) {
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

function hubCall(harness, suffix, options = {}) {
  return call(harness, fakeRequest({ ...options, url: `${HUB}/shared${suffix}` }))
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

function makeBook() {
  const root = tempDir('inkflow-route-book-')
  for (const dir of [...CONTENT_DIRS, 'index']) {
    mkdirSync(join(root, dir), { recursive: true })
    // ADR-0006 D1: the gate requires every required directory's `.gitkeep`, so a
    // fixture without them is `needs-repair` and the write routes refuse it.
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.gitignore'), 'index/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '测试书' }, null, 2)}\n`, 'utf8')
  return root
}

function writeShared(dataDir, relativePath, lines = [], body = '共享正文。') {
  const absolute = join(dataDir, 'shared', ...relativePath.split('/'))
  mkdirSync(dirname(absolute), { recursive: true })
  const block = lines.length > 0 ? `---\n${lines.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}\n`, 'utf8')
  return absolute
}

function makeFixture() {
  const dataDir = tempDir('inkflow-route-data-')
  writeShared(dataDir, 'world/门派/白鹤门.md', ['entryId: sh-aaaa1111', 'title: 白鹤门'], '白鹤门条目。')
  writeShared(dataDir, 'library/参考资料.md', ['entryId: sh-cccc3333', 'title: 参考资料'], '资料卡片。')
  const book = makeBook()
  return { dataDir, book }
}

// ---------------------------------------------------------------------------
// 1. The anchor: `book` must be a registered workspace
// ---------------------------------------------------------------------------

test('copies/copy without a book answers BOOK_REQUIRED and writes nothing', async () => {
  const { dataDir, book } = makeFixture()
  const harness = createHarness({ dataDir, book })
  const bookBefore = hashTree(book)
  const sharedBefore = hashTree(join(dataDir, 'shared'))

  const listed = await hubCall(harness, '/copies')
  assert.equal(listed.status, 400)
  assert.equal(listed.json.error.code, 'BOOK_REQUIRED')

  const copied = await hubCall(harness, '/copy', {
    method: 'POST',
    origin: ORIGIN,
    body: { entryId: 'sh-aaaa1111', confirm: true },
  })
  assert.equal(copied.status, 400)
  assert.equal(copied.json.error.code, 'BOOK_REQUIRED')
  assert.equal(hashTree(book), bookBefore)
  assert.equal(hashTree(join(dataDir, 'shared')), sharedBefore)
})

test('an unregistered book path is refused before anything is written', async () => {
  const { dataDir, book } = makeFixture()
  const harness = createHarness({ dataDir, book })
  const other = tempDir('inkflow-route-other-')
  const bookBefore = hashTree(book)

  const result = await hubCall(harness, '/copy', {
    method: 'POST',
    origin: ORIGIN,
    body: { book: other, entryId: 'sh-aaaa1111', confirm: true },
  })
  assert.equal(result.status, 400)
  assert.equal(result.json.error.code, 'BOOK_NOT_REGISTERED')
  assert.equal(hashTree(book), bookBefore)
})

// ---------------------------------------------------------------------------
// 2. The guards: same-origin Origin, body allowlist, verbs
// ---------------------------------------------------------------------------

test('a hub copy without an Origin is forbidden, and a path field is refused', async () => {
  const { dataDir, book } = makeFixture()
  const harness = createHarness({ dataDir, book })
  const bookBefore = hashTree(book)
  const destination = 'world/门派/白鹤门.md'

  const noOrigin = await hubCall(harness, '/copy', {
    method: 'POST',
    body: { book, entryId: 'sh-aaaa1111', confirm: true },
  })
  assert.equal(noOrigin.status, 403)
  assert.equal(hashTree(book), bookBefore)

  const pathField = await hubCall(harness, '/copy', {
    method: 'POST',
    origin: ORIGIN,
    body: { book, entryId: 'sh-aaaa1111', confirm: true, path: book },
  })
  assert.equal(pathField.status, 400, 'a path-shaped field name is refused by the channel guard')
  assert.equal(hashTree(book), bookBefore)
  assert.equal(decodeURIComponent(destination).includes('白鹤门'), true)
})

test('getting a hub write route with GET is a 405 before the handler', async () => {
  const { dataDir, book } = makeFixture()
  const harness = createHarness({ dataDir, book })
  const result = await hubCall(harness, '/copy', { method: 'GET' })
  assert.equal(result.status, 405)
})

// ---------------------------------------------------------------------------
// 3. The read side, then a copy, then a stale row, then an update
// ---------------------------------------------------------------------------

test('the copies list is read-only and follows the copy/update lifecycle', async () => {
  const { dataDir, book } = makeFixture()
  const harness = createHarness({ dataDir, book })
  const sharedRoot = join(dataDir, 'shared')

  const empty = await hubCall(harness, `/copies?book=${encodeURIComponent(book)}`)
  assert.equal(empty.status, 200)
  assert.equal(empty.json.value.counts.total, 0)
  assert.equal(empty.json.value.selfContained, true)

  const copied = await hubCall(harness, '/copy', {
    method: 'POST',
    origin: ORIGIN,
    body: { book, entryId: 'sh-aaaa1111', confirm: true },
  })
  assert.equal(copied.status, 200, JSON.stringify(copied.json))
  assert.deepEqual(copied.json.value.files, ['world/门派/白鹤门.md'])
  assert.match(copied.json.value.origin.contentHash, /^[0-9a-f]{64}$/)

  const current = await hubCall(harness, `/copies?book=${encodeURIComponent(book)}`)
  assert.equal(current.json.value.counts.current, 1)

  // Reading never writes: hash the book around the two GETs.
  const before = hashTree(book)
  await hubCall(harness, `/copies?book=${encodeURIComponent(book)}`)
  assert.equal(hashTree(book), before)

  // Change the source, then the same row is `stale`.
  writeFileSync(join(sharedRoot, 'world', '门派', '白鹤门.md'), '---\nentryId: sh-aaaa1111\ntitle: 白鹤门（改）\n---\n\n改过的正文。\n', 'utf8')
  const stale = await hubCall(harness, `/copies?book=${encodeURIComponent(book)}`)
  assert.equal(stale.json.value.counts.stale, 1)

  const updated = await hubCall(harness, '/update', {
    method: 'POST',
    origin: ORIGIN,
    body: { book, entryId: 'sh-aaaa1111', file: 'world/门派/白鹤门.md', confirm: true },
  })
  assert.equal(updated.status, 200, JSON.stringify(updated.json))
  assert.deepEqual(updated.json.value.updated, ['world/门派/白鹤门.md'])
  assert.match(String(updated.json.value.backupDir), /^\.inkflow\/backup\//)

  const fresh = await hubCall(harness, `/copies?book=${encodeURIComponent(book)}`)
  assert.equal(fresh.json.value.counts.stale, 0)
  assert.equal(readFileSync(join(book, 'world', '门派', '白鹤门.md'), 'utf8').includes('改过的正文。'), true)
})

test('a reference through the route makes selfContained false and names the card', async () => {
  const { dataDir, book } = makeFixture()
  const harness = createHarness({ dataDir, book })

  const result = await hubCall(harness, '/copy', {
    method: 'POST',
    origin: ORIGIN,
    body: { book, entryId: 'sh-cccc3333', mode: 'reference', confirm: true },
  })
  assert.equal(result.status, 200, JSON.stringify(result.json))

  const listed = await hubCall(harness, `/copies?book=${encodeURIComponent(book)}`)
  assert.equal(listed.json.value.selfContained, false)
  assert.deepEqual(listed.json.value.references, ['library/参考资料.md'])
})

test('an unknown mode is refused, and a mode outside the enum never reaches the domain', async () => {
  const { dataDir, book } = makeFixture()
  const harness = createHarness({ dataDir, book })
  const bookBefore = hashTree(book)
  const result = await hubCall(harness, '/copy', {
    method: 'POST',
    origin: ORIGIN,
    body: { book, entryId: 'sh-aaaa1111', mode: 'link', confirm: true },
  })
  assert.equal(result.status, 400)
  assert.equal(result.json.error.code, 'MODE_INVALID')
  assert.equal(hashTree(book), bookBefore)
})

// ---------------------------------------------------------------------------
// 4. The tools resolve the book from the session, not from an argument
// ---------------------------------------------------------------------------

async function callTool(harness, name, args) {
  const tool = harness.tools.get(name)
  assert.ok(tool, `${name} must be registered`)
  return tool.execute(args, { signal: AbortSignal.timeout(5000), agent: { id: 'session-1' } })
}

test('inkflow_shared_copy writes into the session book; without confirm it writes nothing', async () => {
  const { dataDir, book } = makeFixture()
  const harness = createHarness({ dataDir, book })
  const bookBefore = hashTree(book)

  const refused = await callTool(harness, 'inkflow_shared_copy', { entryId: 'sh-aaaa1111' })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'CONFIRM_REQUIRED')
  assert.equal(hashTree(book), bookBefore)

  const copied = await callTool(harness, 'inkflow_shared_copy', { entryId: 'sh-aaaa1111', confirm: true })
  assert.equal(copied.ok, true, JSON.stringify(copied.error))
  assert.deepEqual(copied.files, ['world/门派/白鹤门.md'])
})

test('inkflow_shared_list answers from a session that is not inside a book', async () => {
  const { dataDir } = makeFixture()
  const outside = tempDir('inkflow-route-outside-')
  const harness = createHarness({ dataDir, book: outside })

  const listed = await callTool(harness, 'inkflow_shared_list', {})
  // No usable book: the library is still listed, and the copy half says so.
  assert.equal(listed.total, 2)
  assert.equal(listed.copiesKnown, false)
  assert.deepEqual(listed.entries.map((entry) => entry.entryId).sort(), ['sh-aaaa1111', 'sh-cccc3333'])
})

test('inkflow_shared_list reports the stale row and the filter narrows without changing counts', async () => {
  const { dataDir, book } = makeFixture()
  const harness = createHarness({ dataDir, book })
  assert.equal((await callTool(harness, 'inkflow_shared_copy', { entryId: 'sh-aaaa1111', confirm: true })).ok, true)
  writeFileSync(join(dataDir, 'shared', 'world', '门派', '白鹤门.md'), '---\nentryId: sh-aaaa1111\n---\n\n新正文。\n', 'utf8')

  const listed = await callTool(harness, 'inkflow_shared_list', { kind: 'world' })
  assert.equal(listed.total, 1, 'the kind filter narrows the library list')
  assert.equal(listed.copiesKnown, true)
  assert.equal(listed.counts.stale, 1)
  assert.equal(listed.selfContained, true)

  const onlyStale = await callTool(harness, 'inkflow_shared_list', { staleOnly: true })
  assert.equal(onlyStale.copies.length, 1)
  assert.equal(onlyStale.copies[0].file, 'world/门派/白鹤门.md')
})

test('inkflow_shared_update refreshes a stale copy through the tool surface', async () => {
  const { dataDir, book } = makeFixture()
  const harness = createHarness({ dataDir, book })
  assert.equal((await callTool(harness, 'inkflow_shared_copy', { entryId: 'sh-aaaa1111', confirm: true })).ok, true)
  writeFileSync(join(dataDir, 'shared', 'world', '门派', '白鹤门.md'), '---\nentryId: sh-aaaa1111\n---\n\n新正文。\n', 'utf8')

  const updated = await callTool(harness, 'inkflow_shared_update', { entryId: 'sh-aaaa1111', confirm: true })
  assert.equal(updated.ok, true, JSON.stringify(updated.error))
  assert.deepEqual(updated.updated, ['world/门派/白鹤门.md'])
  assert.equal(readFileSync(join(book, 'world', '门派', '白鹤门.md'), 'utf8').includes('新正文。'), true)
})
