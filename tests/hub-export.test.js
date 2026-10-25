/**
 * The export entry on the book hub (ADR-0024 D4 / 入口归属).
 *
 * The export tool shipped the capability (`inkflow_export` → `exportBook`); this file is about the *entry*,
 * because a capability a person can only reach by talking to an AI is not delivered. The
 * decision that shapes everything here: the panel gets the **same computation**, not a second
 * implementation. So the route is a thin forwarder and these tests prove it by comparing the
 * two paths' artifacts byte for byte where the format allows it (Markdown/TXT carry no
 * timestamp inside) and entry for entry where it does not (EPUB/DOCX stamp `dcterms:modified`).
 *
 * Four things are pinned:
 *
 *   1. ANCHOR — the book is named the way `/hub/books` listed it (a registered workspace), and
 *      the four-state gate still decides: only a `usable` book exports, exactly like the tool.
 *   2. SAME RESULT — the file lands in `dataDir/exports` (never inside the book: whole-tree
 *      hash before/after) and its bytes match `exportBook()`'s for the same request.
 *   3. REFUSALS WRITE NOTHING — an empty book, a bad format, a mixed selection: the answer is
 *      a code the page can turn into a sentence, and the exports directory stays as it was.
 *   4. GUARDS — a hub write needs a same-origin `Origin`, a JSON body and the field
 *      whitelist; a path field is refused before any handler runs.
 *
 * Plus the client's pure export model: the option lists must match what the Host accepts (no
 * second list to drift), and every refusal code must have a sentence a person can act on.
 *
 * Runs against the built artifact (`../lib/index.js`).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { EXPORT_FORMATS, EXPORT_TARGETS, apply, exportBook, exportsDir, readZip } from '../lib/index.js'
import { hashTree } from './hash-tree.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

const HOST = '127.0.0.1:2149'
const HUB = '/inkflow/internal/hub'
const NINE = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const STATUSES = ['draft', 'revised', 'final']

// ---------------------------------------------------------------------------
// Harness: a real usable book (git + nine dirs + meta) behind a fake registry
// ---------------------------------------------------------------------------

function bookDir(parent, name, { chapters = true } = {}) {
  const root = join(parent, name)
  for (const dir of [...NINE, 'index']) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '入山记', author: 'zhx' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.gitignore'), 'index/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  if (chapters) {
    mkdirSync(join(root, 'chapters', 'vol-01-入山'), { recursive: true })
    mkdirSync(join(root, 'chapters', 'vol-02-问道'), { recursive: true })
    const chapter = (path, fields, bodyText) => {
      const head = Object.entries(fields).map(([key, value]) => `${key}: ${String(value)}`).join('\n')
      writeFileSync(join(root, ...path.split('/')), `---\n${head}\n---\n\n${bodyText}`, 'utf8')
    }
    chapter('chapters/vol-01-入山/0001-初入.md', { id: 'ch-1', title: '初入', seq: 1, volume: 'vol-01', status: 'revised' }, '山雨欲来。\n')
    chapter('chapters/vol-01-入山/0002-夜行.md', { id: 'ch-2', title: '夜行', seq: 2, volume: 'vol-01', status: 'draft' }, '夜行不点灯。\n')
    chapter('chapters/vol-02-问道/0003-问道.md', { id: 'ch-3', title: '问道', seq: 3, volume: 'vol-02', status: 'final' }, '问道于野。\n')
  }
  const git = spawnSync('git', ['init', '--quiet', '-b', 'main'], { cwd: root })
  assert.equal(git.status, 0, `git init failed: ${String(git.stderr)}`)
  return root
}

function harness() {
  const parent = mkdtempSync(join(tmpdir(), 'inkflow-hub-export-'))
  const bookA = bookDir(parent, '我的书')
  const emptyBook = bookDir(parent, '空书', { chapters: false })
  const dataDir = join(parent, 'state')
  const registry = [
    { id: 'ws-1', path: bookA, title: '我的书' },
    { id: 'ws-2', path: emptyBook, title: '空书' },
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
  return { parent, bookA, emptyBook, dataDir, routes, registry, cleanup: () => rmSync(parent, { recursive: true, force: true }) }
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

const get = (h, suffix) => call(h, fakeRequest({ url: `${HUB}${suffix}` }))
const post = (h, suffix, body) => call(h, fakeRequest({ url: `${HUB}${suffix}`, method: 'POST', origin: `http://${HOST}`, body }))

/** File names in the exports directory, sorted — the "nothing was written" evidence. */
function exportNames(dataDir) {
  const dir = exportsDir(dataDir)
  return existsSync(dir) ? readdirSync(dir).sort() : []
}

// ---------------------------------------------------------------------------
// 1. The read half: what CAN be exported from this book
// ---------------------------------------------------------------------------

test('GET /hub/export/options lists the volumes, the axes and nothing else', async () => {
  const h = harness()
  try {
    const response = await get(h, `/export/options?book=${encodeURIComponent(h.bookA)}`)
    assert.equal(response.status, 200, JSON.stringify(response.json))
    assert.equal(response.json.ok, true, JSON.stringify(response.json))
    const value = response.json.value
    assert.deepEqual(
      value.volumes.map((volume) => volume.volumeId),
      ['vol-01', 'vol-02'],
    )
    assert.equal(value.volumes[0].title, '入山')
    assert.equal(value.volumes[0].chapters, 2)
    assert.deepEqual(value.formats, [...EXPORT_FORMATS])
    assert.deepEqual(value.targets, [...EXPORT_TARGETS])
    assert.deepEqual(value.statuses, STATUSES)
    // A preview is a read: it may describe the book, it may not export anything.
    assert.deepEqual(exportNames(h.dataDir), [])
    // The page shows the landing directory, and that is the plugin's own directory — never a
    // path inside a book.
    assert.equal(value.exportsDir, exportsDir(h.dataDir))
  } finally {
    h.cleanup()
  }
})

test('the preview refuses an unregistered book, an unready book and a misspelt book', async () => {
  const h = harness()
  try {
    const missing = await get(h, '/export/options')
    assert.equal(missing.status, 400)
    assert.equal(missing.json.error.code, 'BOOK_REQUIRED')

    const unregistered = await get(h, '/export/options?book=D%3A%5Cnot%5Cregistered')
    assert.equal(unregistered.status, 400)
    assert.equal(unregistered.json.error.code, 'BOOK_NOT_REGISTERED')

    // The gate still decides, exactly like the tool: a needs-repair book keeps its checklist.
    rmSync(join(h.bookA, 'world', '.gitkeep'))
    const unready = await get(h, `/export/options?book=${encodeURIComponent(h.bookA)}`)
    assert.equal(unready.status, 409)
    assert.equal(unready.json.error.code, 'BOOK_NOT_USABLE')
    assert.ok(Array.isArray(unready.json.error.missing) && unready.json.error.missing.length > 0)

    // A misspelt query key answers 400 instead of silently exporting the default book.
    const stray = await get(h, `/export/options?books=${encodeURIComponent(h.bookA)}`)
    assert.equal(stray.status, 400)
    assert.equal(stray.json.error.code, 'UNKNOWN_QUERY_PARAM')

    const pathParam = await get(h, `/export/options?book=${encodeURIComponent(h.bookA)}&root=D%3A%5Csomewhere`)
    assert.equal(pathParam.status, 400)
    assert.equal(pathParam.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 2. Same computation as `inkflow_export` — not a second exporter
// ---------------------------------------------------------------------------

test('the route writes the SAME bytes as exportBook for the same request (markdown)', async () => {
  const h = harness()
  try {
    const before = hashTree(h.bookA)
    const response = await post(h, '/export', { book: h.bookA, format: 'markdown', target: 'book' })
    assert.equal(response.json.ok, true, JSON.stringify(response.json))
    const value = response.json.value
    assert.match(value.file, /^我的书-markdown-\d{8}-\d{6}(-2)?\.md$/u)
    assert.equal(value.dir, exportsDir(h.dataDir))
    assert.equal(existsSync(value.path), true)
    assert.equal(value.target, 'book')
    assert.equal(value.chapters, 3)
    assert.equal(hashTree(h.bookA), before, 'an export must not change one byte inside the book')

    // The tool's own path, same request: Markdown carries no timestamp, so the two artifacts
    // are comparable byte for byte. This is the "one computation" assertion.
    const viaTool = exportBook(h.bookA, h.dataDir, { format: 'markdown', target: 'book' })
    assert.equal(viaTool.ok, true, JSON.stringify(viaTool.error ?? {}))
    assert.equal(readFileSync(viaTool.value.path, 'utf8'), readFileSync(value.path, 'utf8'))
    assert.match(viaTool.value.file, /^我的书-markdown-\d{8}-\d{6}(-2)?\.md$/u)
    assert.equal(viaTool.value.chapters, value.chapters)
  } finally {
    h.cleanup()
  }
})

test('EPUB goes through the same builder — same entries, same chapter count', async () => {
  const h = harness()
  try {
    const response = await post(h, '/export', { book: h.bookA, format: 'epub', target: 'volume', volumeId: 'vol-01' })
    assert.equal(response.json.ok, true, JSON.stringify(response.json))
    const value = response.json.value
    assert.equal(value.format, 'epub')
    assert.equal(value.container, 'zip')
    assert.equal(value.verified.mimetypeFirst, true, 'OCF: mimetype is the first entry, stored')

    const viaTool = exportBook(h.bookA, h.dataDir, { format: 'epub', target: 'volume', volumeId: 'vol-01' })
    assert.equal(viaTool.ok, true, JSON.stringify(viaTool.error ?? {}))
    const routeEntries = readZip(readFileSync(value.path)).map((entry) => entry.path)
    const toolEntries = readZip(readFileSync(viaTool.value.path)).map((entry) => entry.path)
    assert.deepEqual(routeEntries, toolEntries, 'the two paths must build the same package')
    assert.equal(viaTool.value.chapters, value.chapters)
    assert.equal(value.chapters, 2)
  } finally {
    h.cleanup()
  }
})

test('no confirm is required — a stamped name never overwrites anything (ADR-0024 判据)', async () => {
  const h = harness()
  try {
    const first = await post(h, '/export', { book: h.bookA, format: 'txt', target: 'status', status: 'draft' })
    assert.equal(first.json.ok, true, JSON.stringify(first.json))
    assert.equal(first.json.value.container, 'zip', 'a status filter is one file per volume')
    assert.equal(first.json.error, undefined)

    const second = await post(h, '/export', { book: h.bookA, format: 'txt', target: 'status', status: 'draft' })
    assert.equal(second.json.ok, true, JSON.stringify(second.json))
    assert.notEqual(second.json.value.file, first.json.value.file, 'two exports in the same second must both survive')
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 3. Refusals: a sentence, and not one byte written
// ---------------------------------------------------------------------------

test('an empty book, a bad format and a mixed selection write nothing at all', async () => {
  const h = harness()
  try {
    const empty = await post(h, '/export', { book: h.emptyBook, format: 'epub', target: 'book' })
    assert.equal(empty.json.ok, false)
    assert.equal(empty.json.error.code, 'EXPORT_EMPTY')
    assert.deepEqual(exportNames(h.dataDir), [], 'a refusal must not leave a file behind')

    const badFormat = await post(h, '/export', { book: h.bookA, format: 'pdf', target: 'book' })
    assert.equal(badFormat.json.ok, false)
    assert.equal(badFormat.json.error.code, 'EXPORT_FORMAT_INVALID')

    // The two selection axes are not combinable: reflecting that instead of guessing
    // which one the user meant is the whole point of EXPORT_SELECTION_UNUSED.
    const mixed = await post(h, '/export', { book: h.bookA, format: 'epub', target: 'book', status: 'draft' })
    assert.equal(mixed.json.ok, false)
    assert.equal(mixed.json.error.code, 'EXPORT_SELECTION_UNUSED')

    const unknownVolume = await post(h, '/export', { book: h.bookA, format: 'epub', target: 'volume', volumeId: 'vol-99' })
    assert.equal(unknownVolume.json.ok, false)
    assert.equal(unknownVolume.json.error.code, 'EXPORT_VOLUME_UNKNOWN')
    assert.deepEqual(unknownVolume.json.error.available, ['vol-01', 'vol-02'])

    assert.deepEqual(exportNames(h.dataDir), [], 'four refusals later, the exports directory is still empty')
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 4. The write guards the hub channel already applies
// ---------------------------------------------------------------------------

test('the export POST is a hub write — same-origin Origin, JSON body, field whitelist', async () => {
  const h = harness()
  try {
    const crossOrigin = await call(
      h,
      fakeRequest({ url: `${HUB}/export`, method: 'POST', origin: 'http://evil.example', body: { book: h.bookA, format: 'txt', target: 'book' } }),
    )
    assert.equal(crossOrigin.status, 403)
    assert.equal(crossOrigin.json.ok, false)
    assert.ok(['forbidden-origin', 'origin-mismatch'].includes(crossOrigin.json.error.code ?? crossOrigin.json.error.reason)) 

    const noOrigin = await call(
      h,
      fakeRequest({ url: `${HUB}/export`, method: 'POST', body: { book: h.bookA, format: 'txt', target: 'book' } }),
    )
    assert.equal(noOrigin.status, 403)

    const pathField = await post(h, '/export', { book: h.bookA, path: 'E:\\somewhere', format: 'txt', target: 'book' })
    assert.equal(pathField.status, 400)
    assert.equal(pathField.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')

    const unknownField = await post(h, '/export', { book: h.bookA, format: 'txt', target: 'book', confirm: true })
    assert.equal(unknownField.status, 400)
    assert.equal(unknownField.json.error.code, 'UNEXPECTED_BODY_FIELD')

    const readOnWrite = await get(h, `/export/options?book=${encodeURIComponent(h.bookA)}`)
    assert.equal(readOnWrite.status, 200, 'the GET half stays a read')

    const writeOnRead = await call(h, fakeRequest({ url: `${HUB}/export/options`, method: 'POST', origin: `http://${HOST}`, body: {} }))
    assert.equal(writeOnRead.status, 405, 'the read half must not accept a write verb')

    assert.deepEqual(exportNames(h.dataDir), [])
  } finally {
    h.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 5. The client's pure export model
// ---------------------------------------------------------------------------

async function loadExportModel() {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client', 'export-model.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    write: false,
    logLevel: 'silent',
  })
  const code = Buffer.from(result.outputFiles[0].text, 'utf8').toString('base64')
  return import(`data:text/javascript;base64,${code}`)
}

const exportModel = await loadExportModel()

test('the page offers exactly the axes the Host accepts (no second list to drift)', () => {
  assert.deepEqual([...exportModel.EXPORT_FORMATS], [...EXPORT_FORMATS])
  assert.deepEqual([...exportModel.EXPORT_TARGETS], [...EXPORT_TARGETS])
  assert.deepEqual([...exportModel.EXPORT_STATUSES], STATUSES)
  for (const format of EXPORT_FORMATS) {
    assert.equal(typeof exportModel.EXPORT_FORMAT_LABELS[format], 'string', `${format} needs a human label`)
    assert.notEqual(exportModel.EXPORT_FORMAT_LABELS[format].trim(), '')
  }
  for (const target of EXPORT_TARGETS) {
    assert.equal(typeof exportModel.EXPORT_TARGET_LABELS[target], 'string')
  }
})

test('the request body carries the book and the axes, and drops nothing silently', () => {
  assert.deepEqual(exportModel.buildExportBody('D:\\小说\\我的书', { format: 'epub', target: 'book' }), {
    book: 'D:\\小说\\我的书',
    format: 'epub',
    target: 'book',
  })
  assert.deepEqual(exportModel.buildExportBody('book', { format: 'docx', target: 'volume', volumeId: 'vol-02' }), {
    book: 'book',
    format: 'docx',
    target: 'volume',
    volumeId: 'vol-02',
  })
  assert.deepEqual(exportModel.buildExportBody('book', { format: 'txt', target: 'status', status: 'final' }), {
    book: 'book',
    format: 'txt',
    target: 'status',
    status: 'final',
  })
  // Both axes chosen at once travel as chosen: dropping one would answer a different
  // question than the user asked, and the Host's EXPORT_SELECTION_UNUSED says which to drop.
  assert.deepEqual(exportModel.buildExportBody('book', { format: 'txt', target: 'book', status: 'final', volumeId: 'vol-01' }), {
    book: 'book',
    format: 'txt',
    target: 'book',
    status: 'final',
    volumeId: 'vol-01',
  })
  // An empty book name is not a request at all.
  assert.equal(exportModel.buildExportBody('', { format: 'txt', target: 'book' }), null)
})

test('every Host refusal becomes a sentence the author can act on', () => {
  const codes = [
    'EXPORT_EMPTY',
    'EXPORT_FORMAT_INVALID',
    'EXPORT_TARGET_INVALID',
    'EXPORT_VOLUME_REQUIRED',
    'EXPORT_VOLUME_UNKNOWN',
    'EXPORT_STATUS_REQUIRED',
    'EXPORT_STATUS_INVALID',
    'EXPORT_SELECTION_UNUSED',
    'EXPORT_WRITE_FAILED',
    'BOOK_NOT_USABLE',
    'BOOK_NOT_REGISTERED',
  ]
  for (const code of codes) {
    const text = exportModel.describeExportError({ code, message: 'raw host message' })
    assert.ok(text.length > 0, `${code} needs a sentence`)
    assert.equal(text.includes('undefined'), false, `${code} must not render an undefined`)
    assert.notEqual(text, 'raw host message', `${code} must not fall through to the raw code`)
  }
  assert.match(exportModel.describeExportError({ code: 'EXPORT_EMPTY' }), /一个文件都没写/u)
  assert.match(exportModel.describeExportError({ code: 'EXPORT_SELECTION_UNUSED' }), /两条/u)
  // An unknown code still says something usable instead of a bare token.
  assert.match(exportModel.describeExportError({ code: 'SOMETHING_NEW', message: 'host says' }), /SOMETHING_NEW/u)
  assert.match(exportModel.describeExportError(undefined), /没有|未知/u)
})

test('the finished export is reported as a place, a name and a size', () => {
  const line = exportModel.describeExportValue({
    file: '我的书-epub-20261025-102030.epub',
    path: 'C:\\Users\\x\\.dsh\\inkflow\\exports\\我的书-epub-20261025-102030.epub',
    dir: 'C:\\Users\\x\\.dsh\\inkflow\\exports',
    bytes: 2048,
    chapters: 3,
    volumes: 2,
    format: 'epub',
    target: 'book',
  })
  assert.match(line, /我的书-epub-20261025-102030\.epub/u)
  assert.match(line, /exports/u)
  assert.match(line, /3 章/u)
})

test('the page folds the channel answer into ready / error like every other page', () => {
  const ready = exportModel.readExportOptions({
    ok: true,
    status: 200,
    value: { volumes: [{ volumeId: 'vol-01', title: '入山', chapters: 2 }], formats: [...EXPORT_FORMATS], targets: [...EXPORT_TARGETS], statuses: STATUSES, exportsDir: 'C:\\state\\exports' },
  })
  assert.equal(ready.status, 'ready')
  assert.equal(ready.volumes.length, 1)
  assert.equal(ready.exportsDir, 'C:\\state\\exports')

  const failed = exportModel.readExportOptions({ ok: false, status: 200, error: { code: 'HUB_UNAVAILABLE' } })
  assert.equal(failed.status, 'error')
  assert.ok(failed.message.length > 0)

  const done = exportModel.readExportDone({ ok: true, status: 200, value: { file: 'a.epub', dir: 'C:\\state\\exports', bytes: 10, chapters: 1, volumes: 1 } })
  assert.equal(done.status, 'done')
  const refused = exportModel.readExportDone({ ok: false, status: 200, error: { code: 'EXPORT_EMPTY' } })
  assert.equal(refused.status, 'error')
  assert.match(refused.message, /一个文件都没写/u)
})
