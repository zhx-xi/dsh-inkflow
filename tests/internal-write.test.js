/**
 * Contract tests for the four chapter WRITE routes of the private channel
 * (`/inkflow/internal/chapters*`).
 *
 * Same harness style as `tests/internal-channel.test.js`: the built
 * artifact `lib/index.js` is driven through a fake Cordis context, a fake
 * request/response pair and a throwaway book on disk. No DSH process, no socket.
 *
 * The contract under test is ADR-0008 D3/D4 + conventions.md §6.2/§5.5:
 *   1. a write is POST/DELETE only, must carry `Content-Type: application/json`
 *      (415 otherwise) and a loopback `Origin` that is PRESENT (403 otherwise);
 *   2. the body may only name a session and the route's own fields — a path
 *      parameter is a 400 before any filesystem access;
 *   3. `expected` is a real CAS: a stale baseline is 409 `FILE_CHANGED` with
 *      `current`/`changed[]` and **zero bytes written**;
 *   4. a refusal (415/403/400/409/gate) leaves the project tree byte-identical.
 *
 * Run: pnpm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_INTERNAL_BODY_BYTES, apply } from '../lib/index.js'
import { createStateDir } from './state-dir.mjs'

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const ALL_DIRS = [...CONTENT_DIRS, 'index']
const KEEP = '.gitkeep'
const HOST = '127.0.0.1:2149'
const ORIGIN = `http://${HOST}`
const INTERNAL = '/inkflow/internal'
const JSON_TYPE = 'application/json'

// ---------------------------------------------------------------------------
// Harness: registrations recorded, Host services faked (same shape as the channel test)
// ---------------------------------------------------------------------------

const STATE_DIR = createStateDir('inkflow-internal-write-state')

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
  apply(ctx, { dataDir: STATE_DIR })
  return { ctx, routes }
}

/**
 * A request double. `remoteAddress` defaults to loopback because a real carrier
 * always sets it. `contentType: null` means "send no Content-Type header", which
 * is the 415 case; the body is still JSON so the refusal cannot be blamed on it.
 */
function fakeRequest({
  url,
  method = 'GET',
  host = HOST,
  origin,
  remoteAddress = '127.0.0.1',
  body,
  contentLength,
  contentType = JSON_TYPE,
  chunkSize,
  secFetchSite,
} = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  if (secFetchSite !== undefined) headers['sec-fetch-site'] = secFetchSite
  const request = { url, method, headers, socket: { remoteAddress } }
  if (body === undefined && contentLength === undefined) return request
  const buffer = body === undefined ? Buffer.alloc(0) : Buffer.from(body, 'utf8')
  headers['content-length'] = String(contentLength ?? buffer.length)
  if (contentType !== null && buffer.length > 0) headers['content-type'] = contentType
  request[Symbol.asyncIterator] = async function* iterate() {
    // `chunkSize` exists for the multibyte case: a real socket hands over whatever
    // TCP delivered, so a Chinese character can straddle two chunks. Yielding one
    // buffer here (the default) would hide exactly that bug.
    if (Buffer.isBuffer(chunkSize) || typeof chunkSize === 'number') {
      const size = typeof chunkSize === 'number' ? chunkSize : 1
      for (let offset = 0; offset < buffer.length; offset += size) {
        yield buffer.subarray(offset, Math.min(offset + size, buffer.length))
      }
      return
    }
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

/** A write call with the guards satisfied unless the test overrides them. */
function writeCall(harness, path, options = {}) {
  const query = options.sessionId === null ? '' : `sessionId=${encodeURIComponent(options.sessionId ?? 'session-1')}`
  const url = query === '' ? `${INTERNAL}${path}` : `${INTERNAL}${path}?${query}`
  return callRoute(
    harness,
    fakeRequest({
      origin: ORIGIN,
      ...options,
      url,
      method: options.method ?? 'POST',
      body: JSON.stringify(options.payload ?? {}),
    }),
  )
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-write-'))
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
      `${JSON.stringify({ schemaVersion: 1, title: '写路径之书', author: 'tester' }, null, 2)}\n`,
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

const CHAPTER = 'chapters/vol-01/0001-开篇.md'

function bookProject(root) {
  scaffold(root)
  writeMarkdown(root, CHAPTER, ['id: ch-1', 'title: 开篇', 'volume: vol-01', 'seq: 1', 'status: final'], '他走进白鹤门。')
  writeMarkdown(root, 'chapters/0002-散章.md', ['id: ch-2', 'title: 散章', 'seq: 2'], '门外下着雨。')
}

function readChapter(root, relativePath = CHAPTER) {
  return readFileSync(join(root, relativePath), 'utf8')
}

/** Stable content hash: any write inside the project moves it. */
function hashTree(root, relative = '') {
  const hash = createHash('sha256')
  const walk = (relativePath) => {
    const dir = relativePath === '' ? root : join(root, relativePath)
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const child = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`
      const info = statSync(join(root, child))
      hash.update(`${child}|${entry.isDirectory() ? 'd' : 'f'}|${info.size}|${info.mtimeMs}\n`)
      if (entry.isDirectory()) walk(child)
    }
  }
  walk(relative)
  return hash.digest('hex')
}

async function fingerprintOf(harness, id = 'ch-1') {
  const detail = await callRoute(harness, fakeRequest({ url: `${INTERNAL}/chapters/${id}?sessionId=session-1` }))
  assert.equal(detail.status, 200)
  assert.equal(detail.json.ok, true)
  return detail.json.value.fingerprint
}

// ---------------------------------------------------------------------------
// 1. Write guards: Content-Type, Origin, body shape — all before any write
// ---------------------------------------------------------------------------

test('write routes: no Content-Type is a 415 and writes nothing', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    const before = hashTree(root)

    const refused = await writeCall(harness, '/chapters/ch-1', {
      contentType: null,
      payload: { body: '被拒绝的正文' },
    })
    assert.equal(refused.status, 415)
    assert.equal(refused.json.ok, false)
    assert.equal(refused.json.error.code, 'unsupported-media-type')

    const wrongType = await writeCall(harness, '/chapters/ch-1', {
      contentType: 'text/plain',
      payload: { body: '被拒绝的正文' },
    })
    assert.equal(wrongType.status, 415)

    assert.equal(readChapter(root).includes('被拒绝的正文'), false)
    assert.equal(hashTree(root), before, 'a 415 must not touch the project tree')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write routes: a cross-site write is refused, an origin-less one is not (issue 115)', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    const before = hashTree(root)

    // Measured in the field: a real panel save arrived with NO Origin header and every
    // other guard satisfied, and the Host answered `forbidden-origin /
    // origin-required` -- which the author saw as a dead Save button. A browser
    // always sets Origin on a POST, so an absent header means "not a web page".
    const originless = await writeCall(harness, '/chapters/ch-1', { origin: undefined, payload: { body: '本地脚本正文' } })
    assert.equal(originless.status, 200, JSON.stringify(originless.json).slice(0, 160))
    assert.equal(originless.json.ok, true)
    assert.ok(readChapter(root).includes('本地脚本正文'))

    // ... but a page that reached us cross-site still declares itself, and that is
    // refused even without an Origin header.
    const crossSiteFetch = await writeCall(harness, '/chapters/ch-1', {
      origin: undefined,
      secFetchSite: 'cross-site',
      payload: { body: '跨站正文' },
    })
    assert.equal(crossSiteFetch.status, 403)
    assert.equal(crossSiteFetch.json.error.code, 'forbidden-origin')
    assert.equal(crossSiteFetch.json.error.reason, 'cross-site-fetch')

    const crossSite = await writeCall(harness, '/chapters/ch-1', { origin: 'https://evil.example.com', payload: { body: '跨站正文' } })
    assert.equal(crossSite.status, 403)
    assert.equal(crossSite.json.error.code, 'forbidden-origin')

    // A read route still answers without an Origin (the panel's own fetch may omit it).
    const read = await callRoute(harness, fakeRequest({ url: `${INTERNAL}/chapters/ch-1?sessionId=session-1` }))
    assert.equal(read.status, 200)

    assert.equal(readChapter(root).includes('跨站正文'), false, 'the refused writes wrote nothing')
    assert.notEqual(hashTree(root), before, 'only the origin-less write reached the file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write routes: a path parameter or an undeclared field in the body is a 400', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    const before = hashTree(root)

    for (const key of ['root', 'path', 'cwd', 'workspace', 'projectRoot']) {
      const refused = await writeCall(harness, '/chapters/ch-1', { payload: { body: '正文', [key]: root } })
      assert.equal(refused.status, 400, `${key} must be refused in a write body`)
      assert.equal(refused.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')
      assert.equal(refused.json.error.reason, 'unexpected-path-param')
      assert.equal(refused.json.error.param, key)
      assert.equal(refused.json.error.in, 'body')
    }

    const unknownField = await writeCall(harness, '/chapters/ch-1', { payload: { body: '正文', sneaky: 1 } })
    assert.equal(unknownField.status, 400)
    assert.equal(unknownField.json.error.code, 'UNEXPECTED_BODY_FIELD')
    assert.equal(unknownField.json.error.field, 'sneaky')

    const badExpected = await writeCall(harness, '/chapters/ch-1', { payload: { body: '正文', expected: 'sha256' } })
    assert.equal(badExpected.status, 400)
    assert.equal(badExpected.json.error.code, 'EXPECTED_INVALID')

    const badTitle = await writeCall(harness, '/chapters/ch-1', { payload: { title: 42 } })
    assert.equal(badTitle.status, 400)
    assert.equal(badTitle.json.error.code, 'invalid-field')
    assert.equal(badTitle.json.error.field, 'title')

    assert.equal(hashTree(root), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write route: the session may arrive in the body instead of the query', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    // `sessionId` is one of the two things a write body is allowed to contain
    // (conventions.md §6.2), so a body-only call must still resolve the book.
    const saved = await callRoute(
      harness,
      fakeRequest({
        url: `${INTERNAL}/chapters/ch-1`,
        method: 'POST',
        origin: ORIGIN,
        body: JSON.stringify({ sessionId: 'session-1', body: '只带 body 的会话' }),
      }),
    )
    assert.equal(saved.status, 200)
    assert.equal(saved.json.ok, true)
    assert.equal(readChapter(root).includes('只带 body 的会话'), true)

    const noSession = await callRoute(
      harness,
      fakeRequest({ url: `${INTERNAL}/chapters/ch-1`, method: 'POST', origin: ORIGIN, body: JSON.stringify({ body: 'x' }) }),
    )
    assert.equal(noSession.status, 200)
    assert.equal(noSession.json.error.code, 'NO_SESSION_CONTEXT', 'no session anywhere is still a structured refusal')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. POST /chapters/:id — the editor's save
// ---------------------------------------------------------------------------

test('write route: POST /chapters/:id saves body/title/status and returns the new baseline', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    const baseline = await fingerprintOf(harness)
    assert.equal(typeof baseline.sha256, 'string', 'GET /chapters/:id hands out the CAS baseline')

    const saved = await writeCall(harness, '/chapters/ch-1', {
      payload: { body: '他改走了后山。', status: 'revised', expected: { sha256: baseline.sha256 } },
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.json.ok, true)
    const value = saved.json.value
    assert.deepEqual(value.changed, ['status', 'body'])
    assert.equal(value.chapter.chapterId, 'ch-1')
    assert.equal(value.chapter.status, 'revised')
    assert.equal(typeof value.fingerprint.sha256, 'string')
    assert.equal(value.catalogRebuilt, true)
    // The returned fingerprint describes the file as it now is.
    const text = readChapter(root)
    assert.equal(text.includes('他改走了后山。'), true)
    assert.equal(createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'), value.fingerprint.sha256)

    // The next save may use it directly, and an unchanged value set is a no-op.
    const again = await writeCall(harness, '/chapters/ch-1', {
      payload: { status: 'revised', expected: { sha256: value.fingerprint.sha256 } },
    })
    assert.equal(again.status, 200)
    assert.deepEqual(again.json.value.changed, [], 'nothing to change: the domain reports an empty diff')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write route: a stale baseline is a 409 FILE_CHANGED and the external edit survives', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    const baseline = await fingerprintOf(harness)
    // Someone edits the file outside the plugin (their own editor, a git pull…).
    const external = `${readChapter(root)}他改的不是这里。\n`
    writeFileSync(join(root, CHAPTER), external, 'utf8')

    const conflict = await writeCall(harness, '/chapters/ch-1', {
      payload: { body: '插件以为的正文', expected: { sha256: baseline.sha256 } },
    })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.json.ok, false)
    assert.equal(conflict.json.error.code, 'FILE_CHANGED')
    assert.deepEqual(conflict.json.error.changed, ['sha256'])
    assert.equal(conflict.json.error.current.sha256, createHash('sha256').update(Buffer.from(external, 'utf8')).digest('hex'))
    assert.equal(conflict.json.error.expected.sha256, baseline.sha256)
    assert.equal(typeof conflict.json.error.hint, 'string')

    // Nothing was written: the external bytes are still the file, and the index
    // was not rebuilt either (the refusal happens before any write).
    assert.equal(readChapter(root), external)

    // "Overwrite" is an explicit act: no `expected` means "write regardless".
    const overwritten = await writeCall(harness, '/chapters/ch-1', { payload: { body: '插件现在的正文' } })
    assert.equal(overwritten.status, 200)
    assert.equal(readChapter(root).includes('插件现在的正文'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write route: POST /chapters creates a chapter under a volume', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    const created = await writeCall(harness, '/chapters', { payload: { title: '第二趟山门', volumeId: 'vol-01', seq: 3 } })
    assert.equal(created.status, 200)
    assert.equal(created.json.ok, true)
    const chapter = created.json.value.chapter
    assert.equal(chapter.title, '第二趟山门')
    assert.equal(chapter.volumeId, 'vol-01')
    assert.equal(chapter.status, 'draft')
    assert.equal(existsSync(join(root, ...chapter.file.split('/'))), true)

    const listed = await callRoute(harness, fakeRequest({ url: `${INTERNAL}/chapters?sessionId=session-1` }))
    assert.equal(listed.json.value.total, 3, 'the new chapter shows up in the tree')

    // The domain rules still hold through the channel: an empty title is a 400.
    const invalid = await writeCall(harness, '/chapters', { payload: { title: '   ' } })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.json.error.code, 'TITLE_REQUIRED')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. Move and delete
// ---------------------------------------------------------------------------

test('write route: POST /chapters/:id/move moves the chapter and keeps the CAS', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    const baseline = await fingerprintOf(harness, 'ch-1')
    const moved = await writeCall(harness, '/chapters/ch-1/move', {
      payload: { volumeId: null, expected: { sha256: baseline.sha256 } },
    })
    assert.equal(moved.status, 200)
    assert.equal(moved.json.value.moved, true)
    assert.equal(moved.json.value.chapter.volumeId, null)
    assert.equal(moved.json.value.chapter.file, 'chapters/0001-开篇.md')
    assert.equal(existsSync(join(root, CHAPTER)), false)
    assert.equal(existsSync(join(root, 'chapters/0001-开篇.md')), true)

    // The CAS applies to a move exactly as it does to a write.
    const stale = await writeCall(harness, '/chapters/ch-1/move', {
      payload: { volumeId: 'vol-01', expected: { sha256: baseline.sha256 } },
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.json.error.code, 'FILE_CHANGED')
    assert.equal(existsSync(join(root, 'chapters/0001-开篇.md')), true, 'a refused move does not move anything back')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write route: DELETE /chapters/:id deletes with the same guards and CAS', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    const baseline = await fingerprintOf(harness, 'ch-2')
    const stale = await writeCall(harness, '/chapters/ch-2', {
      method: 'DELETE',
      payload: { expected: { sha256: 'de'.repeat(32) } },
    })
    assert.equal(stale.status, 409)
    assert.equal(stale.json.error.code, 'FILE_CHANGED')
    assert.equal(existsSync(join(root, 'chapters/0002-散章.md')), true)

    const deleted = await writeCall(harness, '/chapters/ch-2', {
      method: 'DELETE',
      payload: { expected: { sha256: baseline.sha256 } },
    })
    assert.equal(deleted.status, 200)
    assert.equal(deleted.json.value.deleted.chapterId, 'ch-2')
    assert.equal(existsSync(join(root, 'chapters/0002-散章.md')), false)

    const missing = await writeCall(harness, '/chapters/ch-2', { method: 'DELETE', payload: {} })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.code, 'chapter-not-found')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. Refusals that must not write: unknown ids, non-usable books, size, verbs
// ---------------------------------------------------------------------------

test('write route: an unknown chapter id is a 404 on every chapter write route', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    const before = hashTree(root, 'chapters')

    const write = await writeCall(harness, '/chapters/ch-404', { payload: { body: '无主正文' } })
    assert.equal(write.status, 404)
    assert.equal(write.json.error.code, 'chapter-not-found')

    const move = await writeCall(harness, '/chapters/ch-404/move', { payload: { volumeId: null } })
    assert.equal(move.status, 404)

    const remove = await writeCall(harness, '/chapters/ch-404', { method: 'DELETE', payload: {} })
    assert.equal(remove.status, 404)

    // The refusal happens inside the write lock, so `index/` may move a mtime
    // (the lock file comes and goes — existing behaviour, §5.5); the manuscript
    // itself must be byte-identical.
    assert.equal(hashTree(root, 'chapters'), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write route: a non-usable book refuses writes with the gate checklist and writes nothing', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    // Missing two content directories (and no index/): needs-repair.
    scaffold(root, { dirs: CONTENT_DIRS.filter((name) => name !== 'world' && name !== 'outlines') })
    writeMarkdown(root, 'chapters/0001-甲.md', ['id: ch-1', 'title: 甲', 'seq: 1'], '正文')
    const harness = createHarness({ workspace: root })
    const before = hashTree(root)

    for (const [path, options] of [
      ['/chapters/ch-1', { payload: { body: '不该写进去' } }],
      ['/chapters', { payload: { title: '不该建出来' } }],
      ['/chapters/ch-1/move', { payload: { volumeId: null } }],
      ['/chapters/ch-1', { method: 'DELETE', payload: {} }],
    ]) {
      const refused = await writeCall(harness, path, options)
      assert.equal(refused.status, 200, `${path}: the gate is "cannot answer", not a transport failure`)
      assert.equal(refused.json.ok, false)
      assert.equal(refused.json.error.code, 'PROJECT_NEEDS_REPAIR')
      assert.deepEqual(refused.json.error.missing.sort(), ['index', 'index/.gitkeep', 'outlines', 'outlines/.gitkeep', 'world', 'world/.gitkeep'])
      assert.ok(Array.isArray(refused.json.error.actions) && refused.json.error.actions.length > 0)
    }

    assert.equal(hashTree(root), before, 'the write routes never repair a book')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write route: a character split across two chunks is not damaged', async () => {
  // Review of issue 115's first attempt found this: `readBody` decoded each chunk
  // on its own, so a multibyte character straddling a chunk boundary became two
  // U+FFFD -- written to the file, with a 200 OK. A real socket splits wherever TCP
  // wants, so the double must be able to split too.
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    const body = '第一章 灯下改稿\n\n他在灯下改了这一章，字字都要落准。\n'
    // One byte per chunk: every Chinese character is cut in the middle.
    const saved = await writeCall(harness, '/chapters/ch-1', { payload: { body }, chunkSize: 1 })
    assert.equal(saved.status, 200, JSON.stringify(saved.json).slice(0, 200))
    assert.equal(saved.json.ok, true)

    const written = readChapter(root)
    assert.equal(written.includes('\uFFFD'), false, 'no replacement character may reach the file')
    assert.ok(written.includes(body.trim()), `the submitted prose must survive byte for byte:\n${written.slice(-200)}`)

    // The same guarantee across a 3-byte split (characters of different lengths).
    const again = await writeCall(harness, '/chapters/ch-1', { payload: { body: `${body}😀 emoji
` }, chunkSize: 3 })
    assert.equal(again.status, 200)
    assert.equal(readChapter(root).includes('\uFFFD'), false, 'a 3-byte character split in three is still intact')
    assert.ok(readChapter(root).includes('😀 emoji'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write route: a long chapter saves (the ceiling counts bytes, not characters)', async () => {
  // issue 115: the ceiling used to be 64 KiB of *serialised* JSON. A chapter of
  // 20,000 Chinese characters serialises to ~70 KB, so the panel answered
  // `413 payload-too-large` and the author could not save a long chapter at all.
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    // 30,000 Chinese characters ≈ 90 KB of UTF-8, ≈ 90 KB more once JSON-escaped
    // per line: well past the old ceiling, comfortably inside the new one.
    const longBody = Array.from({ length: 300 }, () => '他在灯下改了这一章的三百字。'.repeat(10)).join(String.fromCharCode(10))
    const saved = await writeCall(harness, '/chapters/ch-1', { payload: { body: longBody } })
    assert.equal(saved.status, 200, JSON.stringify(saved.json).slice(0, 200))
    assert.equal(saved.json.ok, true, 'a long chapter is a normal save, not a refusal')
    assert.ok(readChapter(root).includes('他在灯下改了这一章的三百字。'))

    // The ceiling still exists: above it the refusal names the number.
    const refused = await writeCall(harness, '/chapters/ch-1', {
      payload: { body: 'x'.repeat(MAX_INTERNAL_BODY_BYTES) },
    })
    assert.equal(refused.status, 413)
    assert.equal(refused.json.error.code, 'payload-too-large')
    assert.equal(refused.json.error.limitBytes, MAX_INTERNAL_BODY_BYTES)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('write route: an oversized body is a 413 and an undeclared verb is a 405', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    const before = hashTree(root)

    const huge = await writeCall(harness, '/chapters/ch-1', { payload: { body: 'x'.repeat(MAX_INTERNAL_BODY_BYTES + 10) } })
    assert.equal(huge.status, 413)
    assert.equal(huge.json.error.code, 'payload-too-large')

    const put = await writeCall(harness, '/chapters/ch-1', { method: 'PUT', payload: { body: '乱来' } })
    assert.equal(put.status, 405)
    assert.equal(put.json.error.code, 'method-not-allowed')
    assert.equal(put.headers['allow'], 'GET, POST, DELETE')

    assert.equal(hashTree(root), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 9. The file's own line endings and BOM survive a panel save
// ---------------------------------------------------------------------------

/**
 * The single edited window between two texts: everything outside it must be
 * byte-identical. "Fixed" means `before`/`after` hold the one character the
 * author actually touched — not the whole manuscript rewritten to LF.
 */
function editWindow(before, after) {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return { before: before.slice(prefix, before.length - suffix), after: after.slice(prefix, after.length - suffix) }
}

function writeRaw(root, relativePath, text) {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, text, 'utf8')
}

test('eol: a CRLF+BOM chapter saved from the panel keeps both', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    const original =
      '\uFEFF---\r\nid: ch-1\r\ntitle: 开篇\r\nvolume: vol-01\r\nseq: 1\r\nstatus: final\r\n---\r\n\r\n他走进白鹤门。\r\n门外下着雨。\r\n'
    writeRaw(root, CHAPTER, original)
    const harness = createHarness({ workspace: root })

    const detail = await callRoute(harness, fakeRequest({ url: `${INTERNAL}/chapters/ch-1?sessionId=session-1` }))
    assert.equal(detail.status, 200)
    // The read path reports the file's own format while the body stays LF: the
    // editor never sees a `\r`, and the metadata is what makes the save lossless.
    assert.equal(detail.json.value.eol, 'crlf')
    assert.equal(detail.json.value.bom, true)
    assert.equal(detail.json.value.body.includes('\r'), false)

    const edited = detail.json.value.body.replace('白鹤门', '青鹤门')
    assert.notEqual(edited, detail.json.value.body)
    const saved = await writeCall(harness, '/chapters/ch-1', {
      payload: { body: edited, eol: detail.json.value.eol, bom: detail.json.value.bom },
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.json).slice(0, 200))

    const after = readFileSync(join(root, ...CHAPTER.split('/')), 'utf8')
    assert.deepEqual(editWindow(original, after), { before: '白', after: '青' }, 'only the edited character may change')
    assert.equal(after.startsWith('\uFEFF'), true, 'the BOM must survive the save')
    assert.equal((after.match(/\r\n/g) ?? []).length, (original.match(/\r\n/g) ?? []).length)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('eol: an LF chapter saved from the panel stays LF and gains no BOM', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    const original = readChapter(root)

    const detail = await callRoute(harness, fakeRequest({ url: `${INTERNAL}/chapters/ch-1?sessionId=session-1` }))
    assert.equal(detail.json.value.eol, 'lf')
    assert.equal(detail.json.value.bom, false)

    const edited = detail.json.value.body.replace('白鹤门', '青鹤门')
    const saved = await writeCall(harness, '/chapters/ch-1', {
      payload: { body: edited, eol: detail.json.value.eol, bom: detail.json.value.bom },
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.json).slice(0, 200))

    const after = readChapter(root)
    assert.deepEqual(editWindow(original, after), { before: '白', after: '青' })
    assert.equal(after.includes('\r'), false, 'an LF chapter must not be "fixed" into CRLF')
    assert.equal(after.startsWith('\uFEFF'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
