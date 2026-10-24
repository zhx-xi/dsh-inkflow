/**
 * The settings page's channel (`/inkflow/internal/hub/settings|diagnostics|backups`,
 * #42 / ADR-0018).
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
 *   4. WRITE GUARDS — every POST needs a same-origin `Origin` (ADR-0010 D6 #6).
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

import { apply } from '../lib/index.js'
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
function harness() {
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
    assert.deepEqual(value.fields, ['sharedRoot', 'semanticSearch', 'autosaveIntervalMs', 'authorName', 'excludeDirs', 'backupKeep'])
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
