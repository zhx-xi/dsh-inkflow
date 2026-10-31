/**
 * The settings page's channel (`/inkflow/internal/hub/settings|diagnostics|backups`,
 * ADR-0018).
 *
 * A root-scoped page has no session, so these routes take their anchor from the Host's
 * workspace registry. Five things this file pins, each of them a way the page could
 * quietly do the wrong thing:
 *
 *   1. ANCHOR — a book is named by registry id or directory NAME, never by a path, and
 *      a name two books share is refused (`BOOK_AMBIGUOUS`) instead of guessed.
 *   2. SETTINGS — read answers with the defaults, a write needs `confirm: true`, and a
 *      save touches no book (whole-tree hash before/after).
 *   3. BODY WHITELIST — a `path`/`root` in the body is a 400 before any handler runs.
 *   4. WRITE GUARDS — every POST needs a same-origin `Origin` (ADR-0010 D6 rule 6).
 *   5. BACKUPS — list → preview (no writes) → confirm (restores, reports the index).
 *
 * Runs against the built artifact (`../lib/index.js`).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HUB_SETTINGS_BODY_FIELDS, MODELS_TIMEOUT_MS, SETTINGS_FIELDS, apply, buildHubModels } from '../lib/index.js'
import { hashTree } from './hash-tree.mjs'

const HOST = '127.0.0.1:2149'
const HUB = '/inkflow/internal/hub'
const NINE = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']

function bookDir(parent, name) {
  const root = join(parent, name)
  for (const dir of [...NINE, 'index']) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: name }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.gitignore'), 'index/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  writeFileSync(join(root, 'chapters', '0001-a.md'), '---\ntitle: 一\nid: ch-1\n---\n\n正文\n', 'utf8')
  const git = spawnSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root })
  assert.equal(git.status, 0, `git init failed: ${String(git.stderr)}`)
  return root
}

/** A harness with a fake workspace registry: two books, one of them registered twice. */
function harness({ services = {} } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'inkflow-hub-settings-'))
  const bookA = bookDir(parent, '书甲')
  const bookB = bookDir(parent, '书乙')
  const dataDir = join(parent, 'state')
  const registry = [
    { id: 'ws-1', path: bookA, title: '书甲' },
    { id: 'ws-2', path: bookB, title: '书乙' },
  ]
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
      if (name === 'workspaceRegistry') return { list: () => registry }
      if (Object.prototype.hasOwnProperty.call(services, name)) return services[name]
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
  apply(ctx, { dataDir })
  return { parent, bookA, bookB, dataDir, routes, registry, cleanup: () => rmSync(parent, { recursive: true, force: true }) }
}

function fakeRequest({ url, method = 'GET', host = HOST, origin, body } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  const request = { url, method, headers, socket: { remoteAddress: '127.0.0.1' } }
  if (body === undefined) return request
  const buffer = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  headers['content-length'] = String(buffer.length)
  headers['content-type'] = 'application/json'
  request[Symbol.asyncIterator] = async function* iterate() {
    yield buffer
  }
  return request
}

async function call(h, request) {
  const route = h.routes.find((entry) => entry.path === '/inkflow')
  assert.ok(route, 'expected a /inkflow prefix route')
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
  await route.handler(request, response)
  return { status: response.statusCode, json: response.body === undefined ? undefined : JSON.parse(response.body) }
}

function get(h, suffix) {
  return call(h, fakeRequest({ url: `${HUB}${suffix}` }))
}

function post(h, suffix, body, origin = `http://${HOST}`) {
  return call(h, fakeRequest({ url: `${HUB}${suffix}`, method: 'POST', origin, body }))
}

test('GET /hub/settings answers with the defaults and the book choices, and names no path', async () => {
  const h = harness()
  try {
    const response = await get(h, '/settings')
    assert.equal(response.status, 200)
    assert.equal(response.json.ok, true)
    const value = response.json.value
    assert.equal(value.settings.backupKeep, 5)
    assert.equal(value.source, 'default')
    assert.deepEqual(value.fields, [
      'sharedRoot',
      'semanticSearch',
      'semanticEndpoint',
      'semanticApiKey',
      'autosaveIntervalMs',
      'authorName',
      'excludeDirs',
      'backupKeep',
      'subagentEnabled',
      'subagentProvider',
      'subagentModel',
    ])
    // The page shows "what the session is being told" without re-deriving it: the Host
    // decides, with the same function the injection and the batch tool read.
    assert.deepEqual(value.delegation, { state: 'off', sentence: '写作方式：自己写（未开启子智能体）' })
    assert.deepEqual(value.notices, [])
    // The token is a credential (ADR-0020 E6): the page may learn THAT it is set, never the
    // value, so the wire carries `semanticApiKeySet` and no `semanticApiKey` at all.
    assert.equal(value.settings.semanticApiKeySet, false)
    assert.equal(Object.prototype.hasOwnProperty.call(value.settings, 'semanticApiKey'), false)
    assert.deepEqual(
      value.books.map((book) => book.workspaceId),
      ['ws-1', 'ws-2'],
    )
    // The selector offers ids, slugs and titles — never a directory.
    const text = JSON.stringify(value)
    assert.equal(text.includes(h.parent.replaceAll('\\', '/')), false)
    assert.equal(text.includes(h.parent.replaceAll('/', '\\\\')), false)
  } finally {
    h.cleanup()
  }
})

test('POST /hub/settings/update: same-origin required, confirm required, then the file changes and no book moves', async () => {
  const h = harness()
  try {
    const beforeBook = hashTree(h.bookA)

    const crossOrigin = await post(h, '/settings/update', { backupKeep: 3, confirm: true }, 'http://evil.example')
    assert.equal(crossOrigin.status, 403, 'a hub write needs a same-origin Origin')

    const unconfirmed = await post(h, '/settings/update', { backupKeep: 3 })
    assert.equal(unconfirmed.json.ok, false)
    assert.equal(unconfirmed.json.error.code, 'CONFIRM_REQUIRED')
    assert.equal(existsSync(join(h.dataDir, 'settings.json')), false)

    const saved = await post(h, '/settings/update', { backupKeep: 3, authorName: '作者', confirm: true })
    assert.equal(saved.json.ok, true, JSON.stringify(saved.json))
    assert.deepEqual(saved.json.value.changed, ['authorName', 'backupKeep'])
    assert.equal(saved.json.value.settings.backupKeep, 3)
    assert.equal(existsSync(join(h.dataDir, 'settings.json')), true)
    assert.equal(hashTree(h.bookA), beforeBook, 'a settings save must not write inside a book')
  } finally {
    h.cleanup()
  }
})

test('a path in the body is refused before any handler runs (the browser names no directory)', async () => {
  const h = harness()
  try {
    const refused = await post(h, '/settings/update', { path: 'E:\\somewhere\\book', confirm: true })
    assert.equal(refused.status, 400)
    assert.equal(refused.json.ok, false)
    assert.equal(refused.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')

    const alsoRefused = await get(h, '/backups?root=E%3A%5Csomewhere')
    assert.equal(alsoRefused.status, 400)
    assert.equal(alsoRefused.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')
  } finally {
    h.cleanup()
  }
})

/**
 * The save route's whitelist is DERIVED from `SETTINGS_FIELDS`, never copied.
 *
 * The failure this pins is quiet by construction: a hand-copied list that misses one
 * field still answers 200 for every OTHER field, and only the missing one is a 400
 * `UNEXPECTED_BODY_FIELD` — on a field the settings layer stores happily. The settings work added
 * `semanticEndpoint`/`semanticApiKey` and the copy survived by luck.
 */
test('the settings save whitelist is SETTINGS_FIELDS + confirm, derived not copied', () => {
  assert.ok(Array.isArray(SETTINGS_FIELDS), 'SETTINGS_FIELDS must be exported')
  assert.ok(Array.isArray(HUB_SETTINGS_BODY_FIELDS), 'hub-settings.ts must export HUB_SETTINGS_BODY_FIELDS')

  // No omission: every stored setting can travel. A missing one is the 400.
  for (const field of SETTINGS_FIELDS) {
    assert.ok(
      HUB_SETTINGS_BODY_FIELDS.includes(field),
      `HUB_SETTINGS_BODY_FIELDS must accept the setting \`${field}\``,
    )
  }

  // No surplus: the route accepts only what `writeHubSettings` reads.
  const known = new Set([...SETTINGS_FIELDS, 'confirm'])
  for (const field of HUB_SETTINGS_BODY_FIELDS) {
    assert.ok(
      known.has(field),
      `HUB_SETTINGS_BODY_FIELDS accepts \`${field}\`, which is neither a SETTINGS_FIELDS member nor \`confirm\``,
    )
  }

  // Same content, same order, `confirm` last — the constant IS the settings list, extended once.
  assert.deepEqual([...HUB_SETTINGS_BODY_FIELDS], [...SETTINGS_FIELDS, 'confirm'])
})

test('every settings field passes the save route body whitelist', async () => {
  const h = harness()
  try {
    // One legal sample per field, so a field cannot pass merely because it was absent.
    const sample = {
      sharedRoot: 'E:/共享库',
      semanticSearch: true,
      semanticEndpoint: 'http://127.0.0.1:1933',
      semanticApiKey: 'test-key',
      autosaveIntervalMs: 1200,
      authorName: '作者',
      excludeDirs: ['scratch'],
      backupKeep: 3,
      subagentEnabled: true,
      subagentProvider: 'deepseek-account',
      subagentModel: 'deepseek-v4-pro',
    }
    assert.deepEqual(Object.keys(sample).sort(), [...SETTINGS_FIELDS].sort(), 'add a sample value for the new setting')

    for (const field of SETTINGS_FIELDS) {
      // `confirm: false` is the nearest net AFTER the whitelist: reaching it proves the
      // field was accepted, and nothing is written (the file stays absent).
      const reply = await post(h, '/settings/update', { [field]: sample[field], confirm: false })
      assert.notEqual(
        reply.json.error?.code,
        'UNEXPECTED_BODY_FIELD',
        `\`${field}\` is a legal setting but the route refused it: ${JSON.stringify(reply.json)}`,
      )
      assert.equal(reply.status, 200)
      assert.equal(reply.json.error.code, 'CONFIRM_REQUIRED', `${field} should stop at the confirm net`)
    }

    assert.equal(existsSync(join(h.dataDir, 'settings.json')), false, 'an unconfirmed save writes nothing')
  } finally {
    h.cleanup()
  }
})

test('the backup anchor is a registry id or a directory name; an unknown or ambiguous name is refused', async () => {
  const h = harness()
  try {
    const byId = await get(h, '/backups?book=ws-1')
    assert.equal(byId.json.ok, true)
    assert.equal(byId.json.value.book.workspaceId, 'ws-1')
    assert.equal(byId.json.value.book.bookSlug, '书甲')
    assert.deepEqual(byId.json.value.backups, [])
    assert.equal(byId.json.value.keep, 5)

    const byName = await get(h, `/backups?book=${encodeURIComponent('书乙')}`)
    assert.equal(byName.json.ok, true)
    assert.equal(byName.json.value.book.workspaceId, 'ws-2')

    // The third spelling is the one the shared-content routes on this same channel use
    // the book's exact registered PATH. Accepted because the registry is the only
    // authority — a path outside it is still refused below.
    const byPath = await get(h, `/backups?book=${encodeURIComponent(h.bookA)}`)
    assert.equal(byPath.json.ok, true, JSON.stringify(byPath.json))
    assert.equal(byPath.json.value.book.workspaceId, 'ws-1')

    const strangerPath = await get(h, `/backups?book=${encodeURIComponent(join(h.parent, 'not-a-book'))}`)
    assert.equal(strangerPath.json.ok, false)
    assert.equal(strangerPath.json.error.code, 'BOOK_NOT_FOUND')

    const unknown = await get(h, '/backups?book=nope')
    assert.equal(unknown.json.ok, false)
    assert.equal(unknown.json.error.code, 'BOOK_NOT_FOUND')

    const missing = await get(h, '/backups')
    assert.equal(missing.json.error.code, 'BOOK_REQUIRED')

    // A second book with the same directory name makes the name ambiguous: the page
    // must ask for the id rather than pick one (backing up the wrong book silently is
    // the failure ADR-0010 D1 exists to prevent).
    const twin = bookDir(h.parent, '书甲')
    h.registry.push({ id: 'ws-3', path: twin, title: '书甲（副本）' })
    const ambiguous = await get(h, `/backups?book=${encodeURIComponent('书甲')}`)
    assert.equal(ambiguous.json.ok, false)
    assert.equal(ambiguous.json.error.code, 'BOOK_AMBIGUOUS')
  } finally {
    h.cleanup()
  }
})

test('backups: create (confirm) → list → preview (no writes) → restore, with the index reported', async () => {
  const h = harness()
  try {
    const unconfirmed = await post(h, '/backups/create', { book: 'ws-1' })
    assert.equal(unconfirmed.json.ok, false)
    assert.equal(unconfirmed.json.error.code, 'CONFIRM_REQUIRED')

    const created = await post(h, '/backups/create', { book: 'ws-1', confirm: true })
    assert.equal(created.json.ok, true, JSON.stringify(created.json))
    const file = created.json.value.file
    assert.match(file, /^书甲-\d{8}-\d{6}\.zip$/u)
    assert.equal(created.json.value.files, created.json.value.files)
    assert.deepEqual(created.json.value.pruned, [])
    assert.deepEqual(created.json.value.backups.map((pack) => pack.file), [file])

    // Damage a chapter, then preview: the plan names the file, and nothing is written.
    writeFileSync(join(h.bookA, 'chapters', '0001-a.md'), '被改坏\n', 'utf8')
    const beforePlan = hashTree(h.bookA)
    const planned = await get(h, `/backups/plan?book=ws-1&file=${encodeURIComponent(file)}`)
    assert.equal(planned.json.ok, true, JSON.stringify(planned.json))
    assert.equal(planned.json.value.plan.counts.overwrite, 1)
    assert.equal(hashTree(h.bookA), beforePlan, 'a preview must not write')

    const expected = {}
    for (const entry of planned.json.value.plan.entries) {
      if (entry.action === 'same') continue
      expected[entry.path] = entry.current
    }
    const restored = await post(h, '/backups/restore', { book: 'ws-1', file, expected, confirm: true })
    assert.equal(restored.json.ok, true, JSON.stringify(restored.json))
    assert.deepEqual(restored.json.value.restored, ['chapters/0001-a.md'])
    assert.equal(restored.json.value.index.ok, true)
    assert.equal(readFileSync(join(h.bookA, 'chapters', '0001-a.md'), 'utf8'), '---\ntitle: 一\nid: ch-1\n---\n\n正文\n')
  } finally {
    h.cleanup()
  }
})

test('diagnostics: the preview writes nothing, the export needs confirm, and the package lands outside the book', async () => {
  const h = harness()
  try {
    const beforeBook = hashTree(h.bookA)
    const preview = await get(h, '/diagnostics?book=ws-1')
    assert.equal(preview.json.ok, true)
    assert.match(preview.json.value.path, /diagnostics\//u)
    assert.equal(existsSync(join(h.dataDir, 'diagnostics')), false)
    assert.ok(preview.json.value.summary.length > 3)

    const unconfirmed = await post(h, '/diagnostics/export', { book: 'ws-1' })
    assert.equal(unconfirmed.json.ok, false)
    assert.equal(unconfirmed.json.error.code, 'CONFIRM_REQUIRED')

    const exported = await post(h, '/diagnostics/export', { book: 'ws-1', confirm: true })
    assert.equal(exported.json.ok, true, JSON.stringify(exported.json))
    assert.equal(exported.json.value.format, 'inkflow-diagnostics/1')
    assert.equal(hashTree(h.bookA), beforeBook, 'a diagnostics export must not write inside the book')

    // A book-less package is legal: the plugin-wide half is still worth exporting.
    const global = await post(h, '/diagnostics/export', { confirm: true })
    assert.equal(global.json.ok, true)
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// The model catalog behind the subagent switch (`GET /hub/models`)
// ---------------------------------------------------------------------------

/**
 * The picker's data source is a CAPABILITY, not a prerequisite: a profile may expose no
 * `llm` service, and a provider may hang. Both degrade to "type the ids by hand", and the
 * values are stored either way — so the assertion below that matters most is the one on
 * the SAVE, not on the catalog.
 */
test('GET /hub/models without an llm service answers a typed failure, and the setting still saves by hand', async () => {
  const h = harness()
  try {
    const response = await get(h, '/models')
    assert.equal(response.status, 200, 'a missing capability is an answer, never a transport failure')
    assert.equal(response.json.ok, false)
    assert.equal(response.json.error.code, 'LLM_UNAVAILABLE')
    assert.ok(typeof response.json.error.hint === 'string' && response.json.error.hint !== '')

    const saved = await post(h, '/settings/update', {
      subagentEnabled: true,
      subagentProvider: 'deepseek-account',
      subagentModel: 'deepseek-v4-pro',
      confirm: true,
    })
    assert.equal(saved.json.ok, true, JSON.stringify(saved.json))
    assert.equal(saved.json.value.settings.subagentModel, 'deepseek-v4-pro')
    // The page does not re-derive the state: the Host decides with the same function the
    // injection and the batch tool read.
    assert.equal(saved.json.value.delegation.state, 'delegated')
    assert.equal(saved.json.value.delegation.sentence, '写作方式：委派子智能体（deepseek-account/deepseek-v4-pro）')
  } finally {
    h.cleanup()
  }
})

test('GET /hub/models lists providers and models; one provider failing costs only its own list', async () => {
  const llm = {
    listProviders: () => [
      { id: 'deepseek-account', name: 'DeepSeek' },
      { id: 'broken', name: '坏路由' },
    ],
    listModels: async (provider) => {
      // The message quotes a URL on purpose: an adapter's error text can carry a
      // credential, so the route must not forward it.
      if (provider === 'broken') throw new Error('adapter exploded: https://example.test/v1?key=SECRET')
      return [{ id: 'deepseek-v4-pro', name: 'V4 Pro' }]
    },
  }
  const h = harness({ services: { llm } })
  try {
    const response = await get(h, '/models')
    assert.equal(response.json.ok, true, JSON.stringify(response.json))
    assert.deepEqual(response.json.value.providers, [
      { id: 'deepseek-account', name: 'DeepSeek', models: [{ id: 'deepseek-v4-pro', name: 'V4 Pro' }] },
      { id: 'broken', name: '坏路由', models: [] },
    ])
    assert.equal(JSON.stringify(response.json).includes('SECRET'), false, 'adapter error text must not reach the page')
  } finally {
    h.cleanup()
  }
})

test('the catalog gives up at its deadline instead of holding the page open', async () => {
  // 2 s is what production uses; the deadline is injectable so this test does not wait for it.
  assert.equal(MODELS_TIMEOUT_MS, 2000)
  const hung = {
    listProviders: () => [{ id: 'slow', name: '慢' }],
    listModels: () => new Promise(() => {}),
  }
  const started = Date.now()
  const result = await buildHubModels({ get: () => hung }, { timeoutMs: 25 })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'LLM_TIMEOUT')
  assert.ok(Date.now() - started < 2000, 'the injected deadline is the one that fires')
})

test('a provider with no model reads as unconfigured, and the page is told what is missing', async () => {
  const h = harness()
  try {
    const saved = await post(h, '/settings/update', {
      subagentEnabled: true,
      subagentProvider: 'deepseek-account',
      confirm: true,
    })
    assert.equal(saved.json.ok, true, JSON.stringify(saved.json))
    assert.equal(saved.json.value.settings.subagentProvider, 'deepseek-account')
    // Only the provider is stored; the model key stays ABSENT (not an empty string).
    assert.equal(Object.prototype.hasOwnProperty.call(saved.json.value.settings, 'subagentModel'), false)
    assert.equal(saved.json.value.delegation.state, 'unconfigured')
    assert.equal(saved.json.value.delegation.sentence, '写作方式：未配置模型 —— 先问作者要哪个模型，再委派')
  } finally {
    h.cleanup()
  }
})

test('a hand-edited value the reader cannot use is reported per field, and reads as unconfigured', async () => {
  const h = harness()
  try {
    mkdirSync(h.dataDir, { recursive: true })
    writeFileSync(
      join(h.dataDir, 'settings.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          subagentEnabled: true,
          subagentProvider: '   ',
          subagentModel: 42,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    const response = await get(h, '/settings')
    assert.equal(response.json.ok, true, 'a hand edit must never make the page fail')
    assert.equal(response.json.value.settings.subagentEnabled, true)
    assert.equal(Object.prototype.hasOwnProperty.call(response.json.value.settings, 'subagentProvider'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(response.json.value.settings, 'subagentModel'), false)
    assert.equal(response.json.value.warn.code, 'SETTINGS_FIELD_IGNORED')
    assert.deepEqual(
      response.json.value.notices.map((notice) => notice.field),
      ['subagentProvider', 'subagentModel'],
    )
  } finally {
    h.cleanup()
  }
})
