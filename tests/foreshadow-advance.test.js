/**
 * The foreshadow pane's one write: `POST /foreshadow/advance`.
 *
 * Why this route exists at all: 伏笔 used to be edited in 设定库, and the board tab was
 * read-only on purpose — the state machine and its `confirm` gate live on
 * `inkflow_foreshadow_upsert`. Giving 伏笔 a tab of its own took the editor away from
 * the library page, so the tab has to carry the entry or the move would have cost
 * the author a capability.
 *
 * What each block pins down, so a failure names the promise that broke:
 *
 *   1. **合法流转写盘** — a legal move reaches the file (via `io.ts`: write lock +
 *      atomic replace) and answers what the tool answers.
 *   2. **拒绝码与工具同一套** — the route hands back the code the tool produces for
 *      the same args, so the pane can print the Host's word instead of inventing
 *      a second vocabulary. Compared against the tool, not asserted in a comment.
 *   3. **非法流转零写盘** — a step the machine forbids changes no byte.
 *   4. **缺 confirm 零写盘** — the gate is the tool's own, reached through the same
 *      function; without it nothing is written.
 *   5. **未知条目是一条拒绝，不是一次创建** — advance moves an entry that is there;
 *      a slug nobody has is a refusal (the tool would have created it).
 *   6. **未声明的字段是 400** — the route declares its body keys and the dispatcher
 *      refuses the rest.
 *
 * Runs against the built artifact (`lib/index.js`) through the panel channel, the same
 * way the other channel contracts do.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { apply, domainTools } from '../lib/index.js'
import { createStateDir } from './state-dir.mjs'

const ROOT = resolve(import.meta.dirname, '..')

const HOST = '127.0.0.1:2263'
const ORIGIN = `http://${HOST}`
const INTERNAL = '/inkflow/internal'
const JSON_TYPE = 'application/json'
const DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']

const STATE_DIR = createStateDir('inkflow-foreshadow-advance-state')

function createHarness({ sessionId = 'session-1', workspace } = {}) {
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
      if (name === 'sessions') {
        return {
          get(id) {
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

function fakeRequest({ url, method = 'GET', host = HOST, origin, remoteAddress = '127.0.0.1', body, contentType = JSON_TYPE } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  const request = { url, method, headers, socket: { remoteAddress } }
  if (body === undefined) return request
  const buffer = Buffer.from(body, 'utf8')
  headers['content-length'] = String(buffer.length)
  if (contentType !== null && buffer.length > 0) headers['content-type'] = contentType
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

function withSession(path, sessionId) {
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}sessionId=${encodeURIComponent(sessionId)}`
}

function post(harness, path, payload, options = {}) {
  return callRoute(
    harness,
    fakeRequest({
      origin: ORIGIN,
      ...options,
      url: `${INTERNAL}${withSession(path, options.sessionId ?? 'session-1')}`,
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  )
}

function callTool(name, args) {
  const tool = domainTools().find((candidate) => candidate.name === name)
  assert.ok(tool, `${name} must be registered by a domain module`)
  return tool.execute(args, { signal: new AbortController().signal, callId: 'foreshadow-advance-test' })
}

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-foreshadow-advance-'))
}

function scaffold(root) {
  mkdirSync(root, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (const dir of DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '伏笔推进' }, null, 2)}\n`, 'utf8')
}

function writeForeshadow(root, name, lines, body = '') {
  const absolute = join(root, 'foreshadowing', `${name}.md`)
  writeFileSync(absolute, `---\n${lines.join('\n')}\n---\n\n${body}`, 'utf8')
  return `foreshadowing/${name}.md`
}

/** One planted entry and one already resolved one: the two states the cases move from. */
function sampleBook(root) {
  scaffold(root)
  writeForeshadow(root, '青铜镜', ['id: f-1', 'title: 青铜镜', 'status: planted', 'plantedAt: ch-1', 'dueBy: ch-9'], '镜面裂了一道。\n')
  writeForeshadow(root, '断剑', ['id: f-2', 'title: 断剑', 'status: resolved', 'resolvedChapter: ch-4'], '剑断在冰面上。\n')
}

function readForeshadowText(root, name) {
  return readFileSync(join(root, 'foreshadowing', `${name}.md`), 'utf8')
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** Every file under `foreshadowing/` with its hash: the "nothing was written" fingerprint. */
function foreshadowFiles(root) {
  const dir = join(root, 'foreshadowing')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name !== '.gitkeep')
    .sort()
    .map((name) => `${name} ${sha256(readFileSync(join(dir, name), 'utf8'))}`)
}

const ADVANCE = '/foreshadow/advance'

// ---------------------------------------------------------------------------
// 1. A legal move writes the file
// ---------------------------------------------------------------------------

test('foreshadow-advance: a legal move writes the entry and answers like the tool', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    const harness = createHarness({ workspace: root })

    const reply = await post(harness, ADVANCE, { slug: '青铜镜', status: 'advanced', advancedAt: ['ch-2'], confirm: true })
    assert.equal(reply.status, 200, JSON.stringify(reply.json))
    assert.equal(reply.json.ok, true)
    assert.equal(reply.json.value.status, 'advanced')
    assert.equal(reply.json.value.path, 'foreshadowing/青铜镜.md')
    assert.equal(reply.json.value.id, 'f-1', 'the entry keeps the id its file declares')
    assert.equal(reply.json.value.replaced, true)
    assert.equal(reply.json.value.created, false)

    const text = readForeshadowText(root, '青铜镜')
    assert.match(text, /status: advanced/)
    assert.match(text, /- ch-2/, 'the advance position is on the file')
    assert.match(text, /镜面裂了一道。/, 'the body survives the edit')
    assert.match(text, /dueBy: ch-9/, 'every field this route does not touch survives')

    // The tool and the route are one pipeline: the same args, the same answer.
    const tool = await callTool('inkflow_foreshadow_upsert', {
      projectRoot: root,
      slug: '青铜镜',
      title: '青铜镜',
      status: 'advanced',
      advancedAt: ['ch-2'],
      confirm: true,
    })
    assert.equal(tool.ok, true, 'the same move through the tool is legal too')
    assert.equal(tool.status, reply.json.value.status)
    assert.equal(text, readForeshadowText(root, '青铜镜'), 'an unchanged write does not churn the bytes')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. The refusal codes are the tool's own
// ---------------------------------------------------------------------------

test('foreshadow-advance: an illegal transition answers the tool code and writes nothing', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    const harness = createHarness({ workspace: root })
    const before = foreshadowFiles(root)

    // `resolved` is terminal: nothing steps back to `planted`.
    const reply = await post(harness, ADVANCE, { slug: '断剑', status: 'planted', confirm: true })
    assert.equal(reply.status, 409, JSON.stringify(reply.json))
    assert.equal(reply.json.ok, false)
    assert.equal(reply.json.error.code, 'FORESHADOW_TRANSITION_INVALID')
    assert.deepEqual(foreshadowFiles(root), before, 'a refused move changes no byte')

    // The tool refuses the same args with the same code — one state machine, two surfaces.
    const tool = await callTool('inkflow_foreshadow_upsert', {
      projectRoot: root,
      slug: '断剑',
      title: '断剑',
      status: 'planted',
      confirm: true,
    })
    assert.equal(tool.ok, false)
    assert.equal(tool.error.code, reply.json.error.code, 'the route may not invent a second vocabulary')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('foreshadow-advance: resolved without a chapter, and a status nobody knows, both refuse', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    const harness = createHarness({ workspace: root })
    const before = foreshadowFiles(root)

    const noChapter = await post(harness, ADVANCE, { slug: '青铜镜', status: 'resolved', confirm: true })
    assert.equal(noChapter.status, 400, JSON.stringify(noChapter.json))
    assert.equal(noChapter.json.error.code, 'FORESHADOW_RESOLVED_WITHOUT_CHAPTER')

    // `advanced` with no position is the state machine's refusal too (the code is one, so the
    // status is one): a retry of the same request will not help until a position is passed.
    const noAdvance = await post(harness, ADVANCE, { slug: '青铜镜', status: 'advanced', confirm: true })
    assert.equal(noAdvance.status, 409, JSON.stringify(noAdvance.json))
    assert.equal(noAdvance.json.error.code, 'FORESHADOW_TRANSITION_INVALID', 'advanced needs at least one position')

    const badStatus = await post(harness, ADVANCE, { slug: '青铜镜', status: '收回了', confirm: true })
    assert.equal(badStatus.status, 400, JSON.stringify(badStatus.json))
    assert.equal(badStatus.json.error.code, 'FORESHADOW_STATUS_INVALID')

    assert.deepEqual(foreshadowFiles(root), before, 'three refusals, zero bytes written')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. The confirm gate
// ---------------------------------------------------------------------------

test('foreshadow-advance: without confirm the gate holds and nothing is written', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    const harness = createHarness({ workspace: root })
    const before = foreshadowFiles(root)

    const reply = await post(harness, ADVANCE, { slug: '青铜镜', status: 'advanced', advancedAt: ['ch-2'] })
    assert.equal(reply.status, 400, JSON.stringify(reply.json))
    assert.equal(reply.json.ok, false)
    assert.equal(reply.json.error.code, 'FORESHADOW_UPSERT_REQUIRES_CONFIRMATION')
    assert.deepEqual(foreshadowFiles(root), before, 'the first click only arms: it writes nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. Advancing an entry that is not there
// ---------------------------------------------------------------------------

test('foreshadow-advance: a slug nobody has is a refusal, not a new entry', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    const harness = createHarness({ workspace: root })
    const before = foreshadowFiles(root)

    const reply = await post(harness, ADVANCE, { slug: '不存在', status: 'advanced', advancedAt: ['ch-2'], confirm: true })
    assert.equal(reply.status, 404, JSON.stringify(reply.json))
    assert.equal(reply.json.error.code, 'FORESHADOW_NOT_FOUND')
    assert.deepEqual(foreshadowFiles(root), before, 'advance moves an entry; it never creates one')

    // The tool WOULD have created it — that difference is why the route checks first.
    const tool = await callTool('inkflow_foreshadow_upsert', {
      projectRoot: root,
      slug: '不存在',
      title: '不存在',
      status: 'advanced',
      advancedAt: ['ch-2'],
      confirm: true,
    })
    assert.equal(tool.ok, true, 'the tool is an upsert: it creates')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. The dispatcher's own guards still apply
// ---------------------------------------------------------------------------

test('foreshadow-advance: an undeclared body field is a 400, and a cross-site write is refused', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    const harness = createHarness({ workspace: root })
    const before = foreshadowFiles(root)

    // The browser names a session, never a directory: a root-bearing field is refused by the
    // dispatcher's own guard, before the allowlist even looks at the rest.
    const extra = await post(harness, ADVANCE, { slug: '青铜镜', status: 'advanced', advancedAt: ['ch-2'], confirm: true, projectRoot: root })
    assert.equal(extra.status, 400, 'a browser never names a directory')
    assert.equal(extra.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')

    const unlisted = await post(harness, ADVANCE, { slug: '青铜镜', status: 'advanced', advancedAt: ['ch-2'], confirm: true, title: '改名' })
    assert.equal(unlisted.status, 400, 'a field nobody declared must not be read by nobody and reported by nobody')
    assert.equal(unlisted.json.error.code, 'UNEXPECTED_BODY_FIELD')

    const crossSite = await post(
      harness,
      ADVANCE,
      { slug: '青铜镜', status: 'advanced', advancedAt: ['ch-2'], confirm: true },
      { origin: 'http://evil.example' },
    )
    assert.equal(crossSite.status, 403, JSON.stringify(crossSite.json))

    assert.deepEqual(foreshadowFiles(root), before, 'two refusals, zero bytes written')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. The pane's half: the body one click sends, and the row a jump came from
//
// Both are pure, so the form's decision ("what does 推进 send?") and the jump's
// result ("which row is addressed?") are asserted without a DOM. The pane is
// allowed to hold state; it is not allowed to hold a second copy of the rules.
// ---------------------------------------------------------------------------

/** Bundle one client module to an ESM data URL, like `foreshadow.test.js` does. */
async function bundle(file) {
  const esbuild = createRequire(import.meta.url)('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client', file)],
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'neutral',
    target: 'es2022',
    logLevel: 'silent',
  })
  const code = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`)
}

/** One open entry with one earlier advance position, so appending is observable. */
function boardPayload() {
  return {
    ok: true,
    status: 200,
    value: {
      currentChapter: null,
      indexAvailable: true,
      counts: { total: 1, unresolved: 1, resolved: 0, overdue: 0, dueNow: 0 },
      groups: {
        unresolved: [
          {
            id: 'f-1',
            title: '青铜镜',
            file: 'foreshadowing/青铜镜.md',
            status: 'advanced',
            declaredStatus: 'advanced',
            overdue: false,
            dueNow: false,
            dueBy: null,
            dueKind: null,
            plantedAt: 'ch-1',
            advancedAt: ['ch-2'],
            resolvedChapter: null,
            linkedEntities: [],
          },
        ],
        overdue: [],
        byEntity: [],
      },
    },
  }
}

test('foreshadow-model: the pane builds the advance body from the row it shows', async () => {
  const model = await bundle('foreshadow-model.ts')
  const view = model.readForeshadowBoard(boardPayload())
  const card = view.sections.flatMap((section) => section.items).find((item) => item !== undefined)
  assert.ok(card !== undefined, 'the fixture must reach the board')
  assert.equal(card.slug, '青铜镜', 'the address is the file slug, the name the tool takes')

  // 推进 appends to the positions already on the file: the Host replaces the list it is
  // given, so sending only the new chapter would erase the earlier ones.
  assert.deepEqual(model.advanceBody(card, 'advanced', ' ch-9 '), {
    slug: '青铜镜',
    status: 'advanced',
    advancedAt: ['ch-2', 'ch-9'],
    confirm: true,
  })
  assert.deepEqual(model.advanceBody(card, 'resolved', 'ch-4'), {
    slug: '青铜镜',
    status: 'resolved',
    resolvedChapter: 'ch-4',
    confirm: true,
  })
  // An empty chapter is sent as "nothing new": whether that is legal is the Host's call,
  // not the form's — the pane never predicts a refusal.
  assert.deepEqual(model.advanceBody(card, 'advanced', '   '), {
    slug: '青铜镜',
    status: 'advanced',
    advancedAt: ['ch-2'],
    confirm: true,
  })
  assert.deepEqual(model.advanceBody(card, 'resolved', ''), { slug: '青铜镜', status: 'resolved', confirm: true })
})

test('foreshadow-model: a focus address marks the row the jump came from', async () => {
  const model = await bundle('foreshadow-model.ts')
  const view = model.readForeshadowBoard(boardPayload())

  // A problem row knows the file; a search hit or an audit finding knows the id.
  assert.equal(model.focusFileOf(view, { kind: 'foreshadowing', path: 'foreshadowing/青铜镜.md', nonce: 1 }), 'foreshadowing/青铜镜.md')
  assert.equal(model.focusFileOf(view, { kind: 'foreshadowing', id: 'f-1', nonce: 1 }), 'foreshadowing/青铜镜.md')
  assert.equal(model.focusFileOf(view, { kind: 'foreshadowing', path: 'foreshadowing/没有这个.md', nonce: 1 }), null)
  assert.equal(model.focusFileOf(view, { kind: 'timeline', id: 'f-1', nonce: 1 }), null, 'another kind is not ours')
  assert.equal(model.focusFileOf(view, null), null)
})
