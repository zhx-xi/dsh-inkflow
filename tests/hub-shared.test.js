/**
 * Contract tests for the shared-content (只读) route (ADR-0010 D5).
 *
 * The shared library is a **plugin-level** directory (`dataDir/shared`, ADR-0007
 * C1), not part of any book, and the book hub only ever BROWNS it. These tests
 * pin five things:
 *
 *   1. SHAPE — `GET /inkflow/internal/hub/shared` answers
 *      `{ok:true,value:{created,indexSource,kinds[],entries[],countsByKind,..}}`
 *      with the ADR-0007 C1 entry fields (`entryId`/`kind`/`path`/`sha256?`/`tags?`).
 *   2. SOURCE — the derived manifest `shared/index.json` is used when it agrees
 *      with the directory, and an in-memory rescan answers `indexSource:'scan'`
 *      when it is missing or disagrees. The manifest is **never written back**
 *      (writes belong to the copy/update tools).
 *   3. EMPTY IS NOT AN ERROR — a missing library answers `created:false`, and
 *      neither the library nor any file is created.
 *   4. PATH DISCIPLINE — entries must stay inside the four kind directories:
 *      `..`, absolute paths and symlinks resolving outside `shared/` are
 *      refused, and an unknown `kind` is filtered out. The route itself accepts
 *      no path parameter at all.
 *   5. NO WRITES / BOUNDED COST — a whole-tree hash of `shared/` is identical
 *      before and after every request, and the entry cap + time budget are
 *      injected so the cost tests stay deterministic instead of sleeping.
 *
 * Run: pnpm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { SHARED_MAX_ENTRIES, SHARED_SCAN_BUDGET_MS, apply, buildHubShared } from '../lib/index.js'

const HOST = '127.0.0.1:2149'
const INTERNAL = '/inkflow/internal'
const HUB = `${INTERNAL}/hub`

// ---------------------------------------------------------------------------
// Harness: the /inkflow prefix route plus the plugin data dir (no registry use)
// ---------------------------------------------------------------------------

function createHarness({ dataDir }) {
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
    get() {
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
  return { ctx, routes }
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

function sharedCall(harness, suffix = '', options = {}) {
  return callRoute(harness, fakeRequest({ ...options, url: `${HUB}/shared${suffix}` }))
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Stable fingerprint of a directory tree: names, kinds, sizes, mtimes. */
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

function dataDirOf() {
  return mkdtempSync(join(tmpdir(), 'inkflow-shared-'))
}

function sharedRootOf(dataDir) {
  return join(dataDir, 'shared')
}

/** Write a shared entry with optional frontmatter fields and a body. */
function writeEntry(root, relativePath, frontmatterLines = [], body = '正文') {
  const absolute = join(root, ...relativePath.split('/'))
  mkdirSync(dirname(absolute), { recursive: true })
  const block = frontmatterLines.length > 0 ? `---\n${frontmatterLines.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}\n`, 'utf8')
  return absolute
}

/** Five entries across the four kinds: the baseline library. */
function sampleLibrary(dataDir) {
  const root = sharedRootOf(dataDir)
  writeEntry(root, 'world/门派/白鹤门.md', ['entryId: sh-aaaa1111', 'title: 白鹤门', 'tags: [门派, 设定]'], '门派条目。')
  writeEntry(root, 'world/门派/清音.md', ['entryId: sh-bbbb2222', 'title: 清音'], '人物条目。')
  writeEntry(root, 'library/参考资料.md', ['entryId: sh-cccc3333', 'title: 参考资料', 'tags: [资料]'], '资料卡片。')
  writeEntry(root, 'snippets/开篇片段.md', [], '片段正文。')
  const series = join(root, 'series', '蜀山.json')
  mkdirSync(dirname(series), { recursive: true })
  writeFileSync(series, `${JSON.stringify({ schemaVersion: 1, entryId: 'sh-dddd4444', seriesId: 'se-11112222', title: '蜀山' }, null, 2)}\n`, 'utf8')
  return root
}

/** The five entries the manifest describes, in the shape ADR-0007 C1 defines. */
function indexEntries() {
  return [
    { entryId: 'sh-aaaa1111', kind: 'world', path: 'world/门派/白鹤门.md', sha256: 'a'.repeat(64), tags: ['门派', '设定'] },
    { entryId: 'sh-bbbb2222', kind: 'world', path: 'world/门派/清音.md', sha256: 'b'.repeat(64) },
    { entryId: 'sh-cccc3333', kind: 'library', path: 'library/参考资料.md', sha256: 'c'.repeat(64), tags: ['资料'] },
    { entryId: 'sh-eeee5555', kind: 'snippets', path: 'snippets/开篇片段.md', sha256: 'e'.repeat(64) },
    { entryId: 'sh-dddd4444', kind: 'series', path: 'series/蜀山.json', sha256: 'd'.repeat(64) },
  ]
}

function writeIndex(dataDir, entries) {
  const target = join(sharedRootOf(dataDir), 'index.json')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`, 'utf8')
  return target
}

function sha256OfFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function byPath(value, path) {
  return value.entries.find((entry) => entry.path === path)
}

/** A directory junction (Windows) / directory symlink (POSIX), privilege-free. */
function linkDirectory(target, at) {
  mkdirSync(dirname(at), { recursive: true })
  symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir')
}

function canLink() {
  const probe = mkdtempSync(join(tmpdir(), 'inkflow-link-'))
  try {
    const target = join(probe, 'target')
    mkdirSync(target)
    linkDirectory(target, join(probe, 'link'))
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// 1. The two data sources: the derived manifest, and an in-memory rescan
// ---------------------------------------------------------------------------

test('a manifest that agrees with the directory is the answer (indexSource: index)', async () => {
  const dataDir = dataDirOf()
  sampleLibrary(dataDir)
  const indexFile = writeIndex(dataDir, indexEntries())
  const before = readFileSync(indexFile)
  const harness = createHarness({ dataDir })

  const response = await sharedCall(harness)

  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true, 'a readable library is a successful answer')
  const value = response.json.value
  assert.equal(value.created, true)
  assert.equal(value.indexSource, 'index', 'the manifest is the preferred source (ADR-0010 D5)')
  assert.equal(value.entries.length, 5)
  assert.deepEqual(value.kinds, ['world', 'library', 'snippets', 'series'], 'kinds are canonical order, present only')
  assert.deepEqual(value.countsByKind, { world: 2, library: 1, snippets: 1, series: 1 })

  const world = byPath(value, 'world/门派/白鹤门.md')
  assert.ok(world, 'the nested path is reported with POSIX separators')
  assert.equal(world.kind, 'world')
  assert.equal(world.entryId, 'sh-aaaa1111')
  assert.deepEqual(world.tags, ['门派', '设定'])
  // The manifest's recorded hash is echoed, which is how this test proves the
  // answer came from the file and not from a rescan.
  assert.equal(world.sha256, 'a'.repeat(64))

  for (const entry of value.entries) {
    assert.equal(entry.path.includes('\\'), false, 'entry paths are POSIX-style')
    assert.equal(entry.path.startsWith('/') || /^[A-Za-z]:/.test(entry.path), false, 'entry paths are relative to shared/')
    assert.ok(['world', 'library', 'snippets', 'series'].includes(entry.kind))
  }

  assert.deepEqual(readFileSync(indexFile), before, 'the manifest is never rewritten by the hub')
})

test('a missing manifest is rebuilt in memory, and the rebuilt answer is not written back', async () => {
  const dataDir = dataDirOf()
  const root = sampleLibrary(dataDir)
  const indexFile = join(root, 'index.json')
  const harness = createHarness({ dataDir })

  const response = await sharedCall(harness)

  assert.equal(response.json.ok, true)
  const value = response.json.value
  assert.equal(value.indexSource, 'scan', 'no manifest means the directory is scanned')
  assert.equal(value.entries.length, 5)
  assert.equal(existsSync(indexFile), false, 'the hub does not create shared/index.json (that is the copy/update tools\' job)')

  const world = byPath(value, 'world/门派/白鹤门.md')
  assert.equal(world.sha256, sha256OfFile(join(root, 'world', '门派', '白鹤门.md')), 'the scan computes the real hash')
  assert.deepEqual(world.tags, ['门派', '设定'], 'tags are read from the entry frontmatter')
  assert.equal(world.entryIdDerived, undefined, 'a file-carried entryId is not marked as derived')

  const snippet = byPath(value, 'snippets/开篇片段.md')
  assert.match(snippet.entryId, /^sh-[0-9a-f]{8}$/, 'an entry without an id gets a stable derived one')
  assert.equal(snippet.entryIdDerived, true, 'derived ids say so instead of looking authored')
  assert.deepEqual(byPath(value, 'series/蜀山.json').tags, undefined, 'a series file without tags carries none')

  const hashes = { world: byPath(value, 'world/门派/清音.md').sha256, series: byPath(value, 'series/蜀山.json').sha256 }
  assert.equal(hashes.world, sha256OfFile(join(root, 'world', '门派', '清音.md')))
  assert.equal(hashes.series, sha256OfFile(join(root, 'series', '蜀山.json')))
})

test('a manifest that disagrees with the directory is discarded, not trusted or fixed', async () => {
  const dataDir = dataDirOf()
  const root = sampleLibrary(dataDir)
  const indexFile = writeIndex(dataDir, indexEntries())
  const before = readFileSync(indexFile)
  const beforeMtime = statSync(indexFile).mtimeMs
  // The directory moves on (one entry added, one removed) while the manifest stays.
  writeEntry(root, 'world/门派/新增.md', ['entryId: sh-ffff6666'], '新条目。')
  unlinkSync(join(root, 'snippets', '开篇片段.md'))
  const harness = createHarness({ dataDir })

  const response = await sharedCall(harness)

  const value = response.json.value
  assert.equal(value.indexSource, 'scan', 'a stale manifest must not decide the list')
  assert.equal(value.entries.length, 5, 'the answer follows the disk: 2 + 1 + 1 + 1 world/library/series/new entries')
  assert.ok(byPath(value, 'world/门派/新增.md'), 'the file the manifest does not know is listed')
  assert.equal(byPath(value, 'snippets/开篇片段.md'), undefined, 'the file the manifest still lists is gone')

  assert.deepEqual(readFileSync(indexFile), before, 'the stale manifest is left byte-identical')
  assert.equal(statSync(indexFile).mtimeMs, beforeMtime, 'and untouched (no rewrite with the same contents)')
})

// ---------------------------------------------------------------------------
// 2. "Empty" is not an error
// ---------------------------------------------------------------------------

test('a library that does not exist answers created:false and creates nothing', async () => {
  const dataDir = dataDirOf()
  const root = sharedRootOf(dataDir)
  const before = hashTree(dataDir)
  const harness = createHarness({ dataDir })

  const response = await sharedCall(harness)

  assert.equal(response.status, 200, 'a missing library is not a transport failure')
  assert.equal(response.json.ok, true)
  const value = response.json.value
  assert.equal(value.created, false)
  assert.deepEqual(value.entries, [])
  assert.deepEqual(value.countsByKind, {})
  assert.deepEqual(value.kinds, [])
  assert.equal(value.total, 0)

  assert.equal(existsSync(root), false, 'the shared directory is still absent: "empty" is not "create it"')
  assert.equal(hashTree(dataDir), before, 'nothing was written under the data directory')
})

// ---------------------------------------------------------------------------
// 3. Path discipline (ADR-0010 D5): four subdirectories, nothing else
// ---------------------------------------------------------------------------

test('entries may not escape shared/ with dot-dot segments', async () => {
  const dataDir = dataDirOf()
  const root = sampleLibrary(dataDir)
  writeFileSync(join(dataDir, 'outside.md'), 'outside\n', 'utf8')
  writeIndex(dataDir, [
    { entryId: 'sh-evil0001', kind: 'world', path: 'world/../../outside.md', sha256: 'a'.repeat(64) },
    ...indexEntries(),
  ])
  const harness = createHarness({ dataDir })

  const value = (await sharedCall(harness)).json.value

  assert.equal(value.indexSource, 'scan', 'a manifest carrying an escaping path is not usable')
  for (const entry of value.entries) {
    assert.equal(entry.path.includes('..'), false, `escaping path refused: ${entry.path}`)
    assert.notEqual(entry.path, 'outside.md')
  }
  assert.equal(value.entries.some((entry) => entry.path.includes('outside')), false)
  assert.equal(existsSync(join(root, 'world', '门派', '白鹤门.md')), true, 'the legitimate entries still answer')
})

test('entries may not be absolute paths', async () => {
  const dataDir = dataDirOf()
  sampleLibrary(dataDir)
  writeIndex(dataDir, [
    { entryId: 'sh-evil0002', kind: 'world', path: '/etc/passwd', sha256: 'a'.repeat(64) },
    { entryId: 'sh-evil0003', kind: 'library', path: 'C:/Windows/win.ini', sha256: 'a'.repeat(64) },
    ...indexEntries(),
  ])
  const harness = createHarness({ dataDir })

  const value = (await sharedCall(harness)).json.value

  assert.equal(value.indexSource, 'scan')
  for (const entry of value.entries) {
    assert.equal(entry.path.startsWith('/'), false, `absolute path refused: ${entry.path}`)
    assert.equal(/^[A-Za-z]:/.test(entry.path), false, `drive-letter path refused: ${entry.path}`)
  }
  assert.equal(value.entries.length, 5, 'the five legitimate entries are what remains')
})

test('a link that resolves outside shared/ is not followed', async (t) => {
  if (!canLink()) {
    t.skip('this platform cannot create directory links without elevation')
    return
  }
  const dataDir = dataDirOf()
  const root = sampleLibrary(dataDir)
  const outside = join(dataDir, 'outside-dir')
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, 'hidden.md'), '---\nentryId: sh-hidden01\n---\n\nshould not be listed\n', 'utf8')
  linkDirectory(outside, join(root, 'world', '逃逸目录'))
  let fileLink = false
  try {
    symlinkSync(join(outside, 'hidden.md'), join(root, 'world', 'hidden-link.md'), 'file')
    fileLink = true
  } catch {
    fileLink = false
  }
  const harness = createHarness({ dataDir })

  const value = (await sharedCall(harness)).json.value

  assert.equal(value.entries.some((entry) => entry.path.startsWith('world/逃逸目录')), false, 'an escaping directory link is not walked')
  assert.equal(value.entries.some((entry) => entry.entryId === 'sh-hidden01'), false, 'nor are the files behind it')
  if (fileLink) {
    assert.equal(byPath(value, 'world/hidden-link.md'), undefined, 'an escaping file link is not listed')
  }
  assert.ok(byPath(value, 'world/门派/白鹤门.md'), 'the contained entries still answer')
})

test('only the four kind directories are browsed; an unknown kind is filtered out', async () => {
  const dataDir = dataDirOf()
  const root = sampleLibrary(dataDir)
  writeEntry(root, 'other/笔记.md', ['entryId: sh-other001'], '不在四个子目录内。')
  writeFileSync(join(root, 'README.md'), '共享库说明\n', 'utf8')
  writeIndex(dataDir, [
    { entryId: 'sh-other002', kind: 'other', path: 'other/笔记.md', sha256: 'a'.repeat(64) },
    ...indexEntries(),
  ])
  const harness = createHarness({ dataDir })

  const value = (await sharedCall(harness)).json.value

  assert.equal(value.indexSource, 'scan', 'an out-of-whitelist kind makes the manifest unusable')
  assert.equal(value.entries.some((entry) => entry.path.startsWith('other/')), false)
  assert.equal(value.entries.some((entry) => entry.path === 'README.md'), false, 'a loose file at the root is not an entry')
  assert.deepEqual(value.kinds, ['world', 'library', 'snippets', 'series'])
  assert.equal(Object.keys(value.countsByKind).includes('other'), false)
})

// ---------------------------------------------------------------------------
// 4. The route itself: no path parameter, GET only, zero writes
// ---------------------------------------------------------------------------

test('the shared route accepts no path parameter, in the query or the body', async () => {
  const dataDir = dataDirOf()
  const root = sampleLibrary(dataDir)
  const harness = createHarness({ dataDir })
  const before = hashTree(root)

  for (const [param, value] of [
    ['root', '/tmp/x'],
    ['path', '/tmp/x'],
    ['cwd', '/tmp/x'],
    ['workspace', '/tmp/x'],
    ['projectRoot', '/tmp/x'],
  ]) {
    const response = await sharedCall(harness, `?${param}=${encodeURIComponent(value)}`)
    assert.equal(response.status, 400, `${param}= is refused`)
    assert.equal(response.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')
    assert.equal(response.json.error.param, param)
    assert.equal(response.json.error.in, 'query')
  }

  const inBody = await sharedCall(harness, '', { body: JSON.stringify({ path: '/tmp/x' }) })
  assert.equal(inBody.status, 400, 'a path in the body is refused too')
  assert.equal(inBody.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')
  assert.equal(inBody.json.error.in, 'body')

  assert.equal(hashTree(root), before, 'refused requests touch nothing')
})

test('the shared route is GET only, and says so in Allow', async () => {
  const dataDir = dataDirOf()
  sampleLibrary(dataDir)
  const harness = createHarness({ dataDir })

  for (const method of ['POST', 'DELETE', 'PATCH']) {
    const response = await sharedCall(harness, '', { method, body: method === 'DELETE' ? undefined : '{}' })
    assert.equal(response.status, 405, `${method} is not declared`)
    assert.equal(response.json.error.code, 'method-not-allowed')
    assert.equal(String(response.headers.allow).includes('GET'), true, 'Allow names the declared verb')
  }
})

test('the shared route never writes: the library tree hash is identical before and after', async () => {
  const dataDir = dataDirOf()
  const root = sampleLibrary(dataDir)
  const harness = createHarness({ dataDir })
  const before = hashTree(root)

  assert.equal((await sharedCall(harness)).json.value.entries.length, 5)
  assert.equal((await sharedCall(harness, '?kind=world')).json.value.entries.length, 2)
  assert.equal((await sharedCall(harness, '?q=白鹤')).json.value.entries.length, 1)

  assert.equal(hashTree(root), before, 'reading the library is a pure projection (ADR-0010 D6 零写盘断言)')
})

// ---------------------------------------------------------------------------
// 5. Bounded cost: the caps are injected, so no test sleeps
// ---------------------------------------------------------------------------

test('the entry cap and the time budget are honoured without sleeping', () => {
  const dataDir = dataDirOf()
  const root = sampleLibrary(dataDir)

  const capped = buildHubShared(root, { maxEntries: 2 })
  assert.equal(capped.ok, true)
  assert.equal(capped.value.entries.length, 2, 'the cap bounds one answer')
  assert.equal(capped.value.truncated, true, 'a capped answer says it is incomplete')

  let clock = 0
  const expired = buildHubShared(root, { budgetMs: 1, now: () => (clock += 5) })
  assert.equal(expired.ok, true)
  assert.equal(expired.value.truncated, true, 'a spent budget reports truncation instead of hanging')
  assert.ok(expired.value.entries.length < 5)

  assert.ok(SHARED_MAX_ENTRIES >= 1 && SHARED_SCAN_BUDGET_MS >= 1, 'the production limits are real numbers')
})

test('a file too large to hash is reported without a hash instead of a fake one', () => {
  const dataDir = dataDirOf()
  const root = sampleLibrary(dataDir)

  const value = buildHubShared(root, { maxHashBytes: 8 }).value
  const entry = byPath(value, 'world/门派/白鹤门.md')
  assert.ok(entry, 'the entry is still listed')
  assert.equal(entry.sha256, undefined, 'no hash beats a wrong hash')
})

// ---------------------------------------------------------------------------
// 6. Filters: `kind` and `q` narrow the list, never the counts
// ---------------------------------------------------------------------------

test('kind and q filter the list while countsByKind still describes the whole library', async () => {
  const dataDir = dataDirOf()
  sampleLibrary(dataDir)
  writeIndex(dataDir, indexEntries())
  const harness = createHarness({ dataDir })

  const worldOnly = (await sharedCall(harness, '?kind=world')).json.value
  assert.equal(worldOnly.entries.length, 2)
  assert.equal(worldOnly.entries.every((entry) => entry.kind === 'world'), true)
  assert.deepEqual(worldOnly.countsByKind, { world: 2, library: 1, snippets: 1, series: 1 }, 'the counts describe the library, not the filter')
  assert.equal(worldOnly.total, 2)

  const searched = (await sharedCall(harness, `?q=${encodeURIComponent('白鹤')}`)).json.value
  assert.equal(searched.entries.length, 1)
  assert.equal(searched.entries[0].path, 'world/门派/白鹤门.md')

  const none = (await sharedCall(harness, '?q=zzz-no-such-entry')).json.value
  assert.deepEqual(none.entries, [])
  assert.deepEqual(none.countsByKind, { world: 2, library: 1, snippets: 1, series: 1 }, 'an empty filter result is not an empty library')
})

test('an unusable data directory answers SHARED_UNAVAILABLE instead of an empty library', () => {
  for (const root of ['', undefined]) {
    const result = buildHubShared(root)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'SHARED_UNAVAILABLE')
    assert.equal(typeof result.error.hint, 'string')
  }
})

// ---------------------------------------------------------------------------
// 6. The root comes from the settings file
// ---------------------------------------------------------------------------
//
// `settings.json` has carried `sharedRoot` from the start and until now nothing read
// it: the library was always `dataDir/shared`, so a configured directory silently
// did nothing. These three cases pin the wiring (setting wins, a bad value falls
// back with a warning, an unset field is silent) and, in each one, that answering
// touches no book at all.

/** `dataDir/settings.json`, written the way the settings page writes it. */
function writeSettingsFile(dataDir, settings) {
  mkdirSync(dataDir, { recursive: true })
  const target = join(dataDir, 'settings.json')
  writeFileSync(target, `${JSON.stringify({ schemaVersion: 1, ...settings }, null, 2)}\n`, 'utf8')
  return target
}

/** A minimal book, so "the answer changed nothing in a book" has something to hash. */
function bookOf() {
  const root = mkdtempSync(join(tmpdir(), 'inkflow-shared-book-'))
  mkdirSync(join(root, 'chapters'), { recursive: true })
  writeFileSync(join(root, 'inkflow.json'), '{"schemaVersion":1,"title":"书"}\n', 'utf8')
  writeFileSync(join(root, 'chapters', '0001-a.md'), '# 一\n', 'utf8')
  return root
}

test('a configured sharedRoot is the directory the shared page reads', async () => {
  const dataDir = dataDirOf()
  const book = bookOf()
  const configured = mkdtempSync(join(tmpdir(), 'inkflow-shared-alt-'))
  const before = hashTree(book)

  writeEntry(configured, 'world/门派/白鹤门.md', ['entryId: sh-aaaa1111'], '配置目录里的条目。')
  // The default location holds a DIFFERENT entry, so "which root answered" is a
  // real question and not two paths that would look alike.
  writeEntry(join(dataDir, 'shared'), 'library/默认目录.md', ['entryId: sh-zzzz9999'], '默认目录里的条目。')
  writeSettingsFile(dataDir, { sharedRoot: configured })

  const harness = createHarness({ dataDir })
  const response = await sharedCall(harness)

  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  const value = response.json.value
  assert.equal(value.created, true)
  assert.deepEqual(value.entries.map((entry) => entry.path), ['world/门派/白鹤门.md'])
  assert.equal(value.indexSource, 'scan')
  assert.equal(value.sharedRootWarning, undefined, 'a usable setting is not a warning')
  assert.equal(hashTree(book), before, 'reading a configured library writes nothing into a book')
})

test('a relative or escaping sharedRoot falls back to dataDir/shared with one warning', async () => {
  for (const configured of ['libs', '..', '../outside', 'libs/../../outside']) {
    const dataDir = dataDirOf()
    const book = bookOf()
    const before = hashTree(book)
    writeEntry(join(dataDir, 'shared'), 'library/默认目录.md', ['entryId: sh-zzzz9999'], '默认目录里的条目。')
    writeSettingsFile(dataDir, { sharedRoot: configured })

    const harness = createHarness({ dataDir })
    const response = await sharedCall(harness)

    assert.equal(response.json.ok, true, `${configured} must not fail the request`)
    const value = response.json.value
    assert.deepEqual(value.entries.map((entry) => entry.path), ['library/默认目录.md'], `${configured} must not become the root`)
    assert.equal(value.sharedRootWarning?.code, 'SHARED_ROOT_IGNORED', `${configured} is reported, not silently ignored`)
    assert.match(String(value.sharedRootWarning?.message), /sharedRoot/)
    assert.equal(hashTree(book), before, 'a rejected setting writes nothing into a book')
  }
})

test('an unset sharedRoot reads dataDir/shared and reports no warning', async () => {
  const dataDir = dataDirOf()
  const book = bookOf()
  const before = hashTree(book)
  writeEntry(join(dataDir, 'shared'), 'library/默认目录.md', ['entryId: sh-zzzz9999'], '默认目录里的条目。')

  const harness = createHarness({ dataDir })
  const value = (await sharedCall(harness)).json.value

  assert.deepEqual(value.entries.map((entry) => entry.path), ['library/默认目录.md'])
  assert.equal('sharedRootWarning' in value, false, 'nothing is wrong, so there is nothing to report')
  assert.equal(hashTree(book), before)
})
