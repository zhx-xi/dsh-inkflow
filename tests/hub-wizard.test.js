/**
 * Contract tests for the book hub's new-book wizard (ADR-0010 D4/D6, issue #86).
 *
 * The wizard is the ONLY write path on the no-session hub channel, so these
 * tests pin the whole chain a browser cannot be trusted with:
 *
 *   1. PLAN IS READ-ONLY — `POST /hub/plan` judges a directory the user picked
 *      (`candidate`, the single path-bearing field of this channel) and answers
 *      the same checklist the tools answer. A whole-tree hash of the fixture
 *      is identical before and after, including the `index/` relaxation the
 *      gate would otherwise perform (ADR-0010 D6).
 *   2. ANCHOR — a registered directory answers "这本书已经在书库里" WITHOUT a
 *      `planToken`; a directory inside a registered workspace needs no
 *      `outsideRegistry`; a directory outside every workspace refuses
 *      `ANCHOR_REQUIRED` unless the caller says `outsideRegistry: true`
 *      (ADR-0010 D6 锚点 1–3).
 *   3. APPLY IS TOKEN-ONLY — the write route accepts no path at all: only a
 *      one-shot `planToken` + `confirm: true`. Replay is `TOKEN_CONSUMED`, a
 *      directory that changed after the plan is `PLAN_CHANGED`, and both leave
 *      the tree untouched (the token is consumed BEFORE the first byte is
 *      written, so a second attempt cannot write again).
 *   4. REGISTRATION IS HONEST — `workspaceRegistry.create` is called by the Host
 *      in the same request; a missing or throwing registry answers
 *      `registered: false` with a hint, never a fake success.
 *   5. GUARDS — same-origin `Origin` (not merely loopback), JSON body, 64 KiB
 *      cap, per-route verbs (`GET /hub/plan` is 405), and the path-parameter ban
 *      (`root`/`path`/`cwd`/`workspace`/`projectRoot` in query or body) before
 *      any filesystem access (ADR-0010 D6 #4–#8).
 *
 * `git init` is the only git write and it must not commit, configure a remote or
 * touch the user's identity (ADR-0006 D4) — asserted from `.git/config`.
 *
 * Run: pnpm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { realpathSync } from 'node:fs'

import { HUB_PLAN_TOKEN_TTL_MS, apply, createHubPlanTokenStore, hubApply, hubPlan } from '../lib/index.js'
import { hashTree } from './hash-tree.mjs'

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const ALL_DIRS = [...CONTENT_DIRS, 'index']
const KEEP = '.gitkeep'
const HOST = '127.0.0.1:2149'
/** A page served by the Host itself: the only origin a hub write may come from. */
const SAME_ORIGIN = `http://${HOST}`
const INTERNAL = '/inkflow/internal'
const HUB = `${INTERNAL}/hub`

// ---------------------------------------------------------------------------
// Harness: the /inkflow prefix route plus the workspace registry the hub reads
// ---------------------------------------------------------------------------

function createHarness({ workspaces } = {}) {
  const routes = []
  const created = []
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
        create(path, title) {
          const workspace = { id: `ws-new-${created.length}`, path, ...(title === undefined ? {} : { title }) }
          created.push(workspace)
          workspaces.push(workspace)
          return workspace
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
  apply(ctx, { dataDir: join(tmpdir(), 'inkflow-hub-wizard-state') })
  return { ctx, routes, created }
}

function fakeRequest({ url, method = 'GET', host = HOST, origin = SAME_ORIGIN, remoteAddress = '127.0.0.1', body, contentType } = {}) {
  const headers = { host }
  // `null` means "this request carries no Origin at all"; `undefined` falls back
  // to the same-origin default, because most cases do come from the panel.
  if (origin !== undefined && origin !== null) headers.origin = origin
  const request = { url, method, headers, socket: { remoteAddress } }
  if (body === undefined) return request
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  const buffer = Buffer.from(text, 'utf8')
  headers['content-length'] = String(buffer.length)
  headers['content-type'] = contentType ?? 'application/json'
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

function post(harness, path, body, options = {}) {
  return callRoute(harness, fakeRequest({ ...options, method: 'POST', url: `${HUB}${path}`, body }))
}

function get(harness, path, options = {}) {
  return callRoute(harness, fakeRequest({ ...options, method: 'GET', url: `${HUB}${path}` }))
}

/**
 * Run a request that must be refused and prove it wrote nothing.
 *
 * The tree hash covers names, kinds, sizes and mtimes, so an atomic rewrite of
 * identical bytes would still show up. See `tests/hash-tree.mjs`.
 */
async function refused(base, run) {
  const before = hashTree(base)
  const response = await run()
  assert.equal(hashTree(base), before, 'the refusal wrote nothing: whole-tree hash unchanged')
  return response
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-wizard-'))
}

/** A complete, `usable` book (git + nine directories + keeps + meta + ignore). */
function book(root, { title = '书甲' } = {}) {
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, '.git'))
  for (const dir of ALL_DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, KEEP), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.gitignore'), 'index/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  return root
}

/** Canonical form of a path, for comparing the Host's answer with the fixture. */
function canonical(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

function assertSamePath(actual, expected, message) {
  assert.equal(
    String(actual).toLowerCase().replaceAll('\\', '/'),
    canonical(expected).toLowerCase().replaceAll('\\', '/'),
    message,
  )
}

/** A base directory with one registered, usable book and one brand-new directory. */
function fixture() {
  const base = workdir()
  const registered = book(join(base, 'existing'))
  const fresh = join(base, '新书')
  mkdirSync(fresh, { recursive: true })
  const workspaces = [{ id: 'ws-existing', path: canonical(registered), title: '书甲' }]
  return { base, registered, fresh, workspaces }
}

// ---------------------------------------------------------------------------
// 1. plan: the read-only judgment of a directory the user picked
// ---------------------------------------------------------------------------

test('POST /hub/plan plans a brand-new directory and writes nothing at all', async () => {
  const { base, fresh, workspaces } = fixture()
  const harness = createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) })

  const before = hashTree(base)
  const response = await post(harness, '/plan', { candidate: fresh, outsideRegistry: true })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.equal(hashTree(base), before, 'plan is a pure read: no directory, no index/, no meta')

  const value = response.json.value
  assertSamePath(value.path, fresh, 'the answer echoes the canonical path the user has to confirm')
  assert.equal(value.anchor, 'outside-registry', 'a directory outside every workspace is named as such')
  assert.equal(value.state, 'needs-setup')
  assert.equal(value.canApply, true)
  assert.equal(typeof value.planToken, 'string')
  assert.ok(value.planToken.length >= 16, 'the plan token is a real value, not a placeholder')
  assert.equal(Array.isArray(value.actions), true)

  // The five action kinds of ADR-0006 D3, in execution order.
  const kinds = value.willCreate
  for (const kind of ['git-init', 'create-dir', 'create-gitkeep', 'create-meta', 'create-gitignore']) {
    assert.ok(kinds.includes(kind), `willCreate must announce ${kind}: got ${kinds.join(', ')}`)
  }
  assert.equal(kinds[0], 'git-init', 'git init is announced first, before any directory is created')
  assert.equal(kinds.at(-1), 'create-gitignore', 'the ignore rules come last')
  assert.deepEqual(readdirSync(fresh), [], 'the planned directory is still empty')
  assert.equal(existsSync(join(fresh, 'chapters')), false)
  assert.equal(existsSync(join(fresh, 'index')), false)
})

test('plan anchors a directory inside a registered workspace without outsideRegistry', async () => {
  const { base, registered, workspaces } = fixture()
  const inside = join(registered, 'draft-book')
  mkdirSync(inside)
  const harness = createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) })

  const before = hashTree(base)
  const response = await post(harness, '/plan', { candidate: inside })
  assert.equal(response.status, 200)
  assert.equal(hashTree(base), before)

  const value = response.json.value
  assert.equal(value.anchor, 'in-workspace', 'a directory inside a known workspace needs no second confirmation')
  assert.equal(value.state, 'needs-setup')
  assert.equal(typeof value.planToken, 'string')
  // The book sits inside another git repository: the notice names it and asks
  // the user to ignore it themselves — the wizard never edits outside the root.
  assert.equal(value.notices.length, 1)
  assert.match(value.notices[0], /gitignore/)
  assert.equal(existsSync(join(inside, 'chapters')), false)
})

test('a registry path spelled through a junction still anchors its contents (and itself)', async () => {
  // Windows CI runners keep the temp directory behind a junction, so the
  // registry says one spelling while the picker answers another (resolved) one.
  // Comparing only one side canonicalised both `in-workspace` and `registered`
  // into `ANCHOR_REQUIRED` on windows-latest while passing locally (PR #97).
  const base = workdir()
  const real = book(join(base, 'real-book'))
  const link = join(base, 'link-book')
  try {
    symlinkSync(real, link, 'junction')
  } catch {
    return // junctions need no admin on Windows, but other platforms may refuse
  }
  const inside = join(real, 'draft-book')
  mkdirSync(inside)

  // 1) registry holds the junction spelling, the picker answers the real path.
  const harness = createHarness({ workspaces: [{ id: 'ws-link', path: link, title: '书乙' }] })
  const insideResponse = await post(harness, '/plan', { candidate: inside })
  assert.equal(insideResponse.status, 200, JSON.stringify(insideResponse.json))
  assert.equal(insideResponse.json.value.anchor, 'in-workspace')

  // 2) registry holds the real path, the picker answers the junction spelling.
  const harnessAgain = createHarness({ workspaces: [{ id: 'ws-real', path: real, title: '书乙' }] })
  const registeredResponse = await post(harnessAgain, '/plan', { candidate: link })
  assert.equal(registeredResponse.status, 200, JSON.stringify(registeredResponse.json))
  assert.equal(registeredResponse.json.value.anchor, 'registered')
  assert.equal(registeredResponse.json.value.planToken, undefined)

  // 3) the escaping-junction case with the registry canonicalised and the
  //    candidate reached through a differently spelled base — the shape a
  //    windows-latest runner actually produces. It must still be refused by the
  //    gate (403 PATH_OUT_OF_SCOPE), not by a vague ANCHOR_REQUIRED (400).
  const alias = join(base, 'alias-base')
  try {
    symlinkSync(base, alias, 'junction')
  } catch {
    return
  }
  const outside = join(base, 'outside-real')
  mkdirSync(outside, { recursive: true })
  const escape = join(alias, 'real-book', 'escape-link')
  symlinkSync(outside, escape, 'junction')
  const harnessEscape = createHarness({ workspaces: [{ id: 'ws-real-2', path: real, title: '书乙' }] })
  const escapeResponse = await post(harnessEscape, '/plan', { candidate: escape })
  assert.equal(escapeResponse.status, 403, JSON.stringify(escapeResponse.json))
  assert.equal(escapeResponse.json.error.code, 'PATH_OUT_OF_SCOPE')
})

test('plan on an already registered book returns its state and NO planToken', async () => {
  const { base, registered, workspaces } = fixture()
  const harness = createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) })

  const before = hashTree(base)
  const response = await post(harness, '/plan', { candidate: registered })
  assert.equal(response.status, 200)
  assert.equal(hashTree(base), before)

  const value = response.json.value
  assert.equal(value.anchor, 'registered')
  assert.equal(value.alreadyRegistered, true)
  assert.equal(value.state, 'usable')
  assert.equal(value.canApply, false, 'a registered book cannot be planned to write')
  assert.equal(value.planToken, undefined, 'a registered book must not receive a write token')
  assert.match(value.message, /已经在书库里/, 'the panel says why nothing can be applied')
  assert.equal(value.willCreate.length, 0)
})

test('plan refuses a newer-plugin book, a home directory and a drive root (zero writes)', async () => {
  const { base, fresh, workspaces } = fixture()
  const newer = join(base, 'future')
  mkdirSync(newer)
  writeFileSync(join(newer, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 999, title: '未来之书' })}\n`, 'utf8')
  const harness = createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) })

  const future = await refused(base, () => post(harness, '/plan', { candidate: newer, outsideRegistry: true }))
  assert.equal(future.status, 200)
  assert.equal(future.json.value.state, 'needs-newer-plugin')
  assert.equal(future.json.value.canApply, false, 'an old plugin must not plan a write into a newer book')
  assert.equal(future.json.value.planToken, undefined)
  assert.ok(future.json.value.blockedReason.length > 0, 'the refusal carries a reason, not just a flag')

  const home = process.env.HOME ?? process.env.USERPROFILE ?? homedir()
  const forbiddenHome = await refused(base, () => post(harness, '/plan', { candidate: home, outsideRegistry: true }))
  assert.equal(forbiddenHome.status, 403)
  assert.equal(forbiddenHome.json.error.code, 'PATH_FORBIDDEN')

  const volumeRoot = parse(canonical(base)).root
  const forbiddenRoot = await refused(base, () => post(harness, '/plan', { candidate: volumeRoot, outsideRegistry: true }))
  assert.equal(forbiddenRoot.status, 403)
  assert.equal(forbiddenRoot.json.error.code, 'PATH_FORBIDDEN')

  assert.equal(existsSync(join(fresh, 'chapters')), false)
})

test('plan refuses a junction inside a workspace that points out of it (PATH_OUT_OF_SCOPE)', async (t) => {
  const { base, registered, workspaces } = fixture()
  const outside = join(base, 'outside')
  mkdirSync(outside)
  const link = join(registered, 'escape')
  try {
    // A junction needs no privilege on Windows; 'dir' is the POSIX equivalent.
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    t.skip('this platform cannot create a directory link without privileges')
    return
  }
  const candidate = join(link, 'book')
  mkdirSync(candidate)
  const harness = createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) })

  const response = await refused(base, () => post(harness, '/plan', { candidate }))
  assert.equal(response.status, 403)
  assert.equal(
    response.json.error.code,
    'PATH_OUT_OF_SCOPE',
    'the anchor is the text-level workspace, but the gate judges the resolved path',
  )
  assert.equal(existsSync(join(candidate, 'chapters')), false)
})

test('plan refuses a directory outside the registry unless outsideRegistry is explicit', async () => {
  const { base, fresh, workspaces } = fixture()
  const harness = createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) })

  const missingAnchor = await refused(base, () => post(harness, '/plan', { candidate: fresh }))
  assert.equal(missingAnchor.status, 400)
  assert.equal(missingAnchor.json.error.code, 'ANCHOR_REQUIRED')
  assert.match(missingAnchor.json.error.hint, /outsideRegistry/)

  const blank = await refused(base, () => post(harness, '/plan', {}))
  assert.equal(blank.status, 400)
  assert.equal(blank.json.error.code, 'CANDIDATE_REQUIRED')

  const relative = await refused(base, () => post(harness, '/plan', { candidate: 'some/relative/dir', outsideRegistry: true }))
  assert.equal(relative.status, 400)
  assert.equal(relative.json.error.code, 'CANDIDATE_NOT_ABSOLUTE')

  const sneaky = await refused(base, () => post(harness, '/plan', { candidate: fresh, outsideRegistry: true, mode: 'force' }))
  assert.equal(sneaky.status, 400)
  assert.equal(sneaky.json.error.code, 'UNEXPECTED_BODY_FIELD')
})

test('the hub write guards refuse path parameters, a cross-origin page, a plain body and an oversized body', async () => {
  const { base, fresh, workspaces } = fixture()
  const harness = createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) })

  // ADR-0010 D6 #5: the ban is checked before the route even matches.
  const queryParam = await refused(base, () => get(harness, '/plan?root=somewhere'))
  assert.equal(queryParam.status, 400)
  assert.equal(queryParam.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')
  assert.equal(queryParam.json.error.in, 'query')

  for (const param of ['path', 'cwd', 'workspace', 'projectRoot']) {
    const inBody = await refused(base, () => post(harness, '/plan', { candidate: fresh, outsideRegistry: true, [param]: '/tmp' }))
    assert.equal(inBody.status, 400, `a hub write body must not accept ${param}`)
    assert.equal(inBody.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')
    assert.equal(inBody.json.error.in, 'body')
  }

  // #6: same-origin, NOT merely loopback. A different loopback port is a
  // different page and must not be able to drive a write.
  const missingOrigin = await refused(base, () => post(harness, '/plan', { candidate: fresh, outsideRegistry: true }, { origin: null }))
  assert.equal(missingOrigin.status, 403)
  assert.equal(missingOrigin.json.error.code, 'forbidden-origin')
  assert.equal(missingOrigin.json.error.reason, 'origin-required')

  const otherPort = await refused(base, () =>
    post(harness, '/plan', { candidate: fresh, outsideRegistry: true }, { origin: 'http://127.0.0.1:9999' }),
  )
  assert.equal(otherPort.status, 403)
  assert.equal(otherPort.json.error.code, 'forbidden-origin')

  const crossSite = await refused(base, () =>
    post(harness, '/plan', { candidate: fresh, outsideRegistry: true }, { origin: 'http://evil.example' }),
  )
  assert.equal(crossSite.status, 403)
  assert.equal(crossSite.json.error.code, 'forbidden-origin')

  const plain = await refused(base, () =>
    post(harness, '/plan', { candidate: fresh, outsideRegistry: true }, { contentType: 'text/plain' }),
  )
  assert.equal(plain.status, 415)
  assert.equal(plain.json.error.code, 'unsupported-media-type')

  const huge = await refused(base, () =>
    post(harness, '/plan', { candidate: fresh, outsideRegistry: true, pad: 'x'.repeat(70 * 1024) }),
  )
  assert.equal(huge.status, 413)
  assert.equal(huge.json.error.code, 'payload-too-large')

  // #4: the verbs are declared per route.
  const wrongVerb = await refused(base, () => get(harness, '/plan'))
  assert.equal(wrongVerb.status, 405)
  assert.equal(wrongVerb.headers.allow, 'POST')
  const wrongVerbApply = await refused(base, () => get(harness, '/apply'))
  assert.equal(wrongVerbApply.status, 405)
})

// ---------------------------------------------------------------------------
// 2. apply: token-only, confirmed, and honest about registration
// ---------------------------------------------------------------------------

test('POST /hub/apply builds the book tree, registers the workspace and commits nothing', async () => {
  const { base, fresh, workspaces } = fixture()
  const harness = createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) })

  const planned = await post(harness, '/plan', { candidate: fresh, outsideRegistry: true })
  const token = planned.json.value.planToken

  const applied = await post(harness, '/apply', { planToken: token, confirm: true, title: '入山记' })
  assert.equal(applied.status, 200)
  assert.equal(applied.json.ok, true)
  const value = applied.json.value

  assertSamePath(value.path, fresh, 'the applied path is the one the plan named')
  assert.equal(value.state, 'usable', 'the book passes the gate right after apply')
  for (const relative of ['inkflow.json', '.gitignore', '.git', 'chapters', 'chapters/.gitkeep', 'index', 'index/.gitkeep']) {
    assert.ok(value.created.includes(relative), `created[] must list ${relative}: got ${value.created.join(', ')}`)
  }
  assert.equal(value.updated.length, 0, 'nothing was extended: a fresh directory had nothing to extend')
  assert.equal(value.gitInit, 'created')

  // The tree on disk, not just the report.
  for (const dir of ALL_DIRS) {
    assert.equal(existsSync(join(fresh, dir, KEEP)), true, `${dir}/${KEEP} exists`)
  }
  const meta = JSON.parse(readFileSync(join(fresh, 'inkflow.json'), 'utf8'))
  assert.equal(meta.title, '入山记')
  assert.equal(meta.schemaVersion, 1)

  // git init ONLY (ADR-0006 D4): no commit, no remote, no identity change.
  const config = readFileSync(join(fresh, '.git', 'config'), 'utf8')
  assert.equal(config.includes('[remote'), false, 'the wizard never configures a remote')
  assert.equal(config.includes('[user'), false, 'the wizard never touches the git identity')
  const head = spawnSync('git', ['-C', fresh, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', windowsHide: true })
  assert.notEqual(head.status, 0, 'there is no commit: the first one is the user’s to make')
  const remotes = spawnSync('git', ['-C', fresh, 'remote'], { encoding: 'utf8', windowsHide: true })
  assert.equal((remotes.stdout ?? '').trim(), '')

  // Registration happened in the same request, by the Host (ADR-0010 D4 step 5).
  assert.equal(value.registered, true)
  assertSamePath(value.workspace.path, fresh, 'the registry got the canonical path')
  assert.equal(value.workspace.title, '入山记')
  assert.equal(harness.created.length, 1, 'the Host called workspaceRegistry.create exactly once')
  assertSamePath(harness.created[0].path, fresh)

  // Degradation A (ADR-0010 D4): the panel says what to do next; nothing jumps.
  assert.equal(value.nextStep.kind, 'open-new-session')
  assert.equal(value.nextStep.title, '入山记')
  assertSamePath(value.nextStep.path, fresh)
  assert.match(value.nextStep.message, /书已就绪/)
  assert.match(value.nextStep.message, /「入山记」/)
  assert.match(value.nextStep.message, /新会话/)

  assert.equal(hashTree(base).length > 0, true)
})

test('apply reports registered:false with a hint when the Host has no registry', async () => {
  const { fresh, workspaces } = fixture()
  const harness = createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) })
  // A second Host profile with no registry at all: the book is still built, and
  // the registration is honestly reported as not done (ADR-0010 D4 step 5).
  const noRegistry = createHarness({ workspaces: undefined })

  const planned = await post(harness, '/plan', { candidate: fresh, outsideRegistry: true })
  const applied = await post(noRegistry, '/apply', { planToken: planned.json.value.planToken, confirm: true, title: '无注册表之书' })
  assert.equal(applied.status, 200)
  assert.equal(applied.json.value.state, 'usable')
  assert.equal(applied.json.value.registered, false)
  assert.equal(applied.json.value.workspace, null)
  assert.match(applied.json.value.hint, /手动打开/)
})

test('a planToken is one-shot: the replay is TOKEN_CONSUMED and writes nothing', async () => {
  const { base, fresh, workspaces } = fixture()
  const harness = createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) })

  const planned = await post(harness, '/plan', { candidate: fresh, outsideRegistry: true })
  const token = planned.json.value.planToken
  const first = await post(harness, '/apply', { planToken: token, confirm: true, title: '只写一次' })
  assert.equal(first.status, 200)

  const afterFirst = hashTree(base)
  const replay = await post(harness, '/apply', { planToken: token, confirm: true, title: '只写一次' })
  assert.equal(replay.status, 409)
  assert.equal(replay.json.error.code, 'TOKEN_CONSUMED')
  assert.equal(hashTree(base), afterFirst, 'the consumed token cannot write a second time')
  assert.equal(harness.created.length, 1, 'nor register the workspace twice')
})

test('apply refuses PLAN_CHANGED when the directory changed after the plan, then dies for good', async () => {
  const { base, fresh, workspaces } = fixture()
  const harness = createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) })

  const planned = await post(harness, '/plan', { candidate: fresh, outsideRegistry: true })
  const token = planned.json.value.planToken
  // Someone (another session, the author, a shell) put a meta file in place
  // between the plan and the confirmation: the planned action set no longer
  // describes the directory, so the write must not go ahead.
  writeFileSync(join(fresh, 'inkflow.json'), '{ "schemaVersion": 1, "title": "别处写的" }\n', 'utf8')

  const changed = await refused(base, () => post(harness, '/apply', { planToken: token, confirm: true, title: '重新计划' }))
  assert.equal(changed.status, 409)
  assert.equal(changed.json.error.code, 'PLAN_CHANGED')
  assert.equal(readFileSync(join(fresh, 'inkflow.json'), 'utf8').includes('别处写的'), true, 'the other writer’s file survived')
  assert.equal(existsSync(join(fresh, 'chapters')), false, 'no half tree: the refusal happens before the first write')

  // The token is consumed by the attempt: the user must re-plan, not retry.
  const retry = await refused(base, () => post(harness, '/apply', { planToken: token, confirm: true, title: '重新计划' }))
  assert.equal(retry.status, 409)
  assert.equal(retry.json.error.code, 'TOKEN_CONSUMED')
})

test('apply without confirm writes nothing and keeps the token usable', async () => {
  const { base, fresh, workspaces } = fixture()
  const harness = createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) })

  const planned = await post(harness, '/plan', { candidate: fresh, outsideRegistry: true })
  const token = planned.json.value.planToken

  const unconfirmed = await refused(base, () => post(harness, '/apply', { planToken: token, title: '未确认之书' }))
  assert.equal(unconfirmed.status, 400)
  assert.equal(unconfirmed.json.error.code, 'INIT_REQUIRES_CONFIRMATION')

  const explicitFalse = await refused(base, () => post(harness, '/apply', { planToken: token, confirm: false }))
  assert.equal(explicitFalse.status, 400)
  assert.equal(explicitFalse.json.error.code, 'INIT_REQUIRES_CONFIRMATION')

  // The refusal did not burn the token: the user can still say yes.
  const confirmed = await post(harness, '/apply', { planToken: token, confirm: true, title: '未确认之书' })
  assert.equal(confirmed.status, 200)
  assert.equal(confirmed.json.value.state, 'usable')

  const unknown = await refused(base, () => post(harness, '/apply', { planToken: 'no-such-token', confirm: true }))
  assert.equal(unknown.status, 400)
  assert.equal(unknown.json.error.code, 'TOKEN_UNKNOWN')

  const missing = await refused(base, () => post(harness, '/apply', { confirm: true }))
  assert.equal(missing.status, 400)
  assert.equal(missing.json.error.code, 'PLAN_TOKEN_REQUIRED')

  const badField = await refused(base, () => post(harness, '/apply', { planToken: 'x', confirm: true, path: fresh }))
  assert.equal(badField.status, 400)
  assert.equal(badField.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')
})

// ---------------------------------------------------------------------------
// 3. The token store: one-shot, TTL-bounded, consumed before any write
// ---------------------------------------------------------------------------

test('the plan token store is one-shot with an injectable TTL', async () => {
  const { base, fresh, workspaces } = fixture()
  const harness = createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) })

  assert.equal(HUB_PLAN_TOKEN_TTL_MS, 5 * 60 * 1000, 'ADR-0010 D3: five minutes by default')
  let now = 1_000
  const store = createHubPlanTokenStore({ ttlMs: 50, now: () => now })

  const planned = await hubPlan(harness.ctx, { candidate: fresh, outsideRegistry: true }, { store })
  assert.equal(planned.status, 200)
  const token = planned.body.value.planToken
  assert.equal(store.size(), 1)

  now += 51
  const before = hashTree(base)
  const expired = await hubApply(harness.ctx, { planToken: token, confirm: true, title: '过期' }, { store })
  assert.equal(expired.status, 400)
  assert.equal(expired.body.error.code, 'TOKEN_EXPIRED')
  assert.equal(hashTree(base), before, 'an expired token writes nothing')
  assert.equal(store.size(), 0, 'an expired token is dropped, not kept for a later attempt')
})

test('plan and apply share the same projection the routes use, so the wire and the module agree', async () => {
  const { fresh, workspaces } = fixture()
  const harness = createHarness({ workspaces: workspaces.map((workspace) => ({ ...workspace })) })

  const planned = await hubPlan(harness.ctx, { candidate: fresh, outsideRegistry: true })
  assert.equal(planned.status, 200)
  const viaRoute = await post(harness, '/plan', { candidate: fresh, outsideRegistry: true })
  assert.deepEqual(
    Object.keys(planned.body.value).sort(),
    Object.keys(viaRoute.json.value).sort(),
    'the route is a thin envelope: same fields, same meaning',
  )
  assert.equal(resolve(fresh).length > 0, true)
})
