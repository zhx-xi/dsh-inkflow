/**
 * The recovery bin (roadmap X-9 / X-10, ADR-0012): a delete keeps a copy
 * under `<book>/.inkflow/trash/<the original relative path>` plus one manifest
 * entry, and nothing in the bin is ever more than a copy — the chapter tree, the
 * search index and `entities` must stop seeing what was deleted.
 *
 * Same harness style as `tests/internal-write.test.js`: the built artifact
 * `lib/index.js` is driven through a fake Cordis context and a throwaway book on
 * disk. No DSH process, no socket. `git` IS used, for the one claim that cannot
 * be faked: `.inkflow/` never shows up as an untracked file.
 *
 * The five invariants this file pins, each with the case that must FAIL if it
 * regresses:
 *
 *   1. delete → one copy at the original relative path + one manifest entry; the
 *      manifest entry carries sha256/bytes of the bytes that were removed;
 *   2. restore → the original bytes come back **exactly** (BOM and CRLF
 *      included), the entry leaves the manifest and the copy is gone;
 *   3. restore never overwrites: a file back at the original path is a refusal
 *      and zero writes;
 *   4. purge needs `confirm: true` (tool/route level) and then removes both the
 *      copy and the entry;
 *   5. the bin is invisible to the index: no `files` / `entities` row for any
 *      `.inkflow/` path, and the deleted chapter leaves the tree, the prose
 *      search and `entities`.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, searchChapters } from '../lib/index.js'
import { createStateDir } from './state-dir.mjs'

const require = createRequire(import.meta.url)
const ROOT = join(import.meta.dirname, '..')

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const ALL_DIRS = [...CONTENT_DIRS, 'index']
const KEEP = '.gitkeep'
const HOST = '127.0.0.1:2159'
const ORIGIN = `http://${HOST}`
const INTERNAL = '/inkflow/internal'
const JSON_TYPE = 'application/json'
const CHAPTER = 'chapters/vol-01/0001-开篇.md'
const BODY = '他走进白鹤门。'
const TRASH_ROOT = '.inkflow/trash'
const MANIFEST = `${TRASH_ROOT}/index.json`

// ---------------------------------------------------------------------------
// Harness (same shape as tests/internal-write.test.js)
// ---------------------------------------------------------------------------

const STATE_DIR = createStateDir('inkflow-trash-state')

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
  // `&` when the route already has a query (`/search?q=…`), else `?`. Getting
  // this wrong makes the query swallow the session and hides the real failure
  // behind a `NO_SESSION_CONTEXT`.
  if (sessionId === null) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}sessionId=${encodeURIComponent(sessionId ?? 'session-1')}`
}

function read(harness, path, options = {}) {
  return callRoute(harness, fakeRequest({ url: `${INTERNAL}${withSession(path, options.sessionId)}`, ...options }))
}

function writeCall(harness, path, options = {}) {
  return callRoute(
    harness,
    fakeRequest({
      origin: ORIGIN,
      ...options,
      url: `${INTERNAL}${withSession(path, options.sessionId)}`,
      method: options.method ?? 'POST',
      body: JSON.stringify(options.payload ?? {}),
    }),
  )
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-trash-'))
}

function scaffold(root) {
  mkdirSync(root, { recursive: true })
  // A real repository, not a bare `.git` directory: one assertion below is the
  // author's own `git status` staying clean, and that cannot be faked.
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (const dir of ALL_DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, KEEP), '', 'utf8')
  }
  writeFileSync(
    join(root, 'inkflow.json'),
    `${JSON.stringify({ schemaVersion: 1, title: '回收站之书', author: 'tester' }, null, 2)}\n`,
    'utf8',
  )
}

function writeChapterFile(root, relativePath, bytes, frontmatterLines = ['id: ch-1', 'title: 开篇', 'volume: vol-01', 'seq: 1'], body = BODY) {
  mkdirSync(join(root, relativePath, '..'), { recursive: true })
  const payload =
    bytes ?? Buffer.from(`---\n${frontmatterLines.join('\n')}\n---\n\n${body}`, 'utf8')
  writeFileSync(join(root, relativePath), payload)
}

function bookProject(root) {
  scaffold(root)
  writeChapterFile(root, CHAPTER)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function manifestOf(root) {
  const file = join(root, MANIFEST)
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

function trunkChanges(root) {
  // `git status --porcelain -uall`: the only acceptable mention of `.inkflow/`
  // is none at all (it is ignored from the first write, ADR-0012 decision 2).
  //
  // `core.quotepath=false` is not cosmetic: with the default, git escapes every
  // non-ASCII byte (`"\345\274\200\347\257\207"`), so a Chinese file name matches
  // nothing on Linux while matching on Windows. The claim is about the path, so
  // the path is what the command must print.
  const output = execFileSync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain', '-uall'], {
    cwd: root,
    encoding: 'utf8',
  })
  return output.split('\n').filter((line) => line.trim() !== '')
}

/**
 * Every FILE in the project, with its bytes' hash — the zero-write fingerprint.
 *
 * Same technique as `tests/hash-tree.mjs` (names + sizes + mtimes around a
 * REFUSED request), with one deliberate difference: directories themselves are
 * left out. A request that refuses still runs the freshness check, which creates
 * and removes the plugin's own `index/.lock`, and that moves `index/`'s mtime
 * while no file in it changes. Including directory mtimes would make an honest
 * "nothing was written" assertion fail for a reason that says nothing about user
 * data; files are what a refusal must not touch.
 */
function fileTree(root) {
  const hash = createHash('sha256')
  const walk = (relative) => {
    const dir = relative === '' ? root : join(root, relative)
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        walk(child)
        continue
      }
      const info = statSync(join(root, child))
      hash.update(`${child}|${info.size}|${info.mtimeMs}|${createHash('sha256').update(readFileSync(join(root, child))).digest('hex')}\n`)
    }
  }
  walk('')
  return hash.digest('hex')
}

// ---------------------------------------------------------------------------
// 1. Delete → the copy, the manifest entry and the ignore line
// ---------------------------------------------------------------------------

test('deleting a chapter keeps one copy and one manifest entry, and git stays clean', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    const originalBytes = readFileSync(join(root, CHAPTER))
    const originalHash = createHash('sha256').update(originalBytes).digest('hex')
    execFileSync('git', ['add', '-A'], { cwd: root })

    const deleted = await writeCall(harness, '/chapters/ch-1', { method: 'DELETE' })
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json).slice(0, 200))
    assert.equal(deleted.json.ok, true)
    assert.equal(deleted.json.value.deleted.file, CHAPTER)

    assert.equal(existsSync(join(root, CHAPTER)), false, 'the chapter is gone from the working tree')

    const copy = join(root, TRASH_ROOT, CHAPTER)
    assert.equal(existsSync(copy), true, `the copy keeps the original relative path: ${TRASH_ROOT}/${CHAPTER}`)
    assert.deepEqual(readFileSync(copy), originalBytes, 'the copy is byte-identical to what was removed')

    const manifest = manifestOf(root)
    assert.ok(manifest !== null, 'the manifest was written')
    assert.equal(manifest.schemaVersion, 1)
    assert.equal(manifest.entries.length, 1)
    const [entry] = manifest.entries
    assert.deepEqual(Object.keys(entry).sort(), ['bytes', 'deletedAt', 'id', 'originalPath', 'reason', 'sha256'])
    assert.equal(entry.originalPath, CHAPTER)
    assert.equal(entry.sha256, originalHash)
    assert.equal(entry.bytes, originalBytes.byteLength)
    assert.equal(entry.reason, 'chapter_delete')
    assert.equal(typeof entry.id, 'string')
    assert.ok(entry.id.length > 0)
    assert.equal(Number.isNaN(Date.parse(entry.deletedAt)), false, 'deletedAt is an ISO 8601 timestamp')

    const ignore = readFileSync(join(root, '.gitignore'), 'utf8')
    assert.ok(ignore.split('\n').map((line) => line.trim()).includes('.inkflow/'), '.gitignore gained `.inkflow/` on the first write')

    const status = trunkChanges(root)
    assert.deepEqual(
      status.filter((line) => line.includes('.inkflow')),
      [],
      'no `.inkflow/` path is ever untracked',
    )
    assert.ok(
      status.some((line) => line.includes('chapters/vol-01/0001-开篇.md')),
      'the delete itself is visible to git, as a deletion',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. Restore → byte-identical bytes (BOM, CRLF), empty manifest, no copy
// ---------------------------------------------------------------------------

test('restoring returns byte-identical content, BOM and CRLF included', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    // Written as BYTES on purpose: `\uFEFF` + CRLF is exactly the shape a
    // Windows editor produces, and any normalisation would change the hash.
    const raw = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('---\r\nid: ch-bom\r\ntitle: 带 BOM 的章\r\nvolume: vol-01\r\nseq: 2\r\n---\r\n\r\n第一行\r\n第二行\r\n', 'utf8'),
    ])
    const relative = 'chapters/vol-01/0002-bom.md'
    writeChapterFile(root, relative, raw)
    const harness = createHarness({ workspace: root })
    const hashBefore = createHash('sha256').update(raw).digest('hex')

    const deleted = await writeCall(harness, '/chapters/ch-bom', { method: 'DELETE' })
    assert.equal(deleted.status, 200, JSON.stringify(deleted.json).slice(0, 200))

    const listed = await read(harness, '/trash')
    assert.equal(listed.status, 200)
    assert.equal(listed.json.ok, true)
    assert.equal(listed.json.value.total, 1)
    const id = listed.json.value.entries[0].id
    assert.equal(listed.json.value.entries[0].present, true)
    assert.equal(listed.json.value.entries[0].bytes, raw.byteLength)

    const restored = await writeCall(harness, '/trash/restore', { payload: { id } })
    assert.equal(restored.status, 200, JSON.stringify(restored.json).slice(0, 200))
    assert.equal(restored.json.ok, true)
    assert.equal(restored.json.value.restored.originalPath, relative)

    assert.deepEqual(readFileSync(join(root, relative)), raw, 'the bytes are the bytes that were deleted')
    assert.equal(sha256(join(root, relative)), hashBefore, 'sha256 matches the manifest')
    assert.equal(existsSync(join(root, TRASH_ROOT, relative)), false, 'the copy is gone')
    const manifest = manifestOf(root)
    assert.equal(manifest.entries.length, 0, 'the entry left the manifest')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. Restore refuses to overwrite — and writes nothing at all
// ---------------------------------------------------------------------------

test('restoring onto an occupied path is refused and writes nothing', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    assert.equal((await writeCall(harness, '/chapters/ch-1', { method: 'DELETE' })).status, 200)
    const id = manifestOf(root).entries[0].id
    // The author recreated the chapter (or renamed another file onto the path):
    // the bin must never silently replace it with the old text.
    writeChapterFile(root, CHAPTER, undefined, ['id: ch-1', 'title: 开篇（新）', 'volume: vol-01', 'seq: 1'], '新的正文。')
    const before = fileTree(root)
    const recreatedBytes = readFileSync(join(root, CHAPTER))

    const refused = await writeCall(harness, '/trash/restore', { payload: { id } })
    assert.equal(refused.status, 409, JSON.stringify(refused.json).slice(0, 200))
    assert.equal(refused.json.ok, false)
    assert.equal(refused.json.error.code, 'RESTORE_TARGET_EXISTS')

    assert.equal(fileTree(root), before, 'a refused restore touches nothing')
    assert.deepEqual(readFileSync(join(root, CHAPTER)), recreatedBytes, 'the file at the path is untouched')
    assert.equal(manifestOf(root).entries.length, 1, 'the entry stays in the bin')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. Purge → confirm required, then copy and entry both go
// ---------------------------------------------------------------------------

test('purging needs confirm: true, then empties the bin', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    assert.equal((await writeCall(harness, '/chapters/ch-1', { method: 'DELETE' })).status, 200)
    const id = manifestOf(root).entries[0].id
    const before = fileTree(root)

    const unconfirmed = await writeCall(harness, '/trash/purge', { payload: { id } })
    assert.equal(unconfirmed.status, 400, JSON.stringify(unconfirmed.json).slice(0, 200))
    assert.equal(unconfirmed.json.error.code, 'CONFIRM_REQUIRED')
    assert.equal(fileTree(root), before, 'an unconfirmed purge writes nothing')
    assert.equal(existsSync(join(root, TRASH_ROOT, CHAPTER)), true)

    const explicitNo = await writeCall(harness, '/trash/purge', { payload: { id, confirm: false } })
    assert.equal(explicitNo.json.error.code, 'CONFIRM_REQUIRED')

    const purged = await writeCall(harness, '/trash/purge', { payload: { id, confirm: true } })
    assert.equal(purged.status, 200, JSON.stringify(purged.json).slice(0, 200))
    assert.equal(purged.json.value.purged.id, id)
    assert.equal(existsSync(join(root, TRASH_ROOT, CHAPTER)), false, 'the copy is gone')
    assert.deepEqual(manifestOf(root).entries, [], 'the manifest is empty')
    assert.equal((await read(harness, '/trash')).json.value.total, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4b. One slot per original path (review B1)
//
// The copy is keyed by the ORIGINAL path, so two deletions of that path would
// share one location: the second `writeTextAtomic` would silently replace the
// first version's bytes while its entry went on saying `present: true`. The
// refusal is `TRASH_ENTRY_EXISTS`, and the slot frees again through restore or
// purge — the two tests after this one are the legal halves of the same rule.
// ---------------------------------------------------------------------------

test('deleting the same path twice is refused, and the earlier copy keeps its bytes', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    assert.equal((await writeCall(harness, '/chapters/ch-1', { method: 'DELETE' })).status, 200)
    const firstEntry = manifestOf(root).entries[0]
    const copyPath = join(root, TRASH_ROOT, CHAPTER)
    const firstCopy = readFileSync(copyPath)

    // The author writes a second version onto the same path (same chapter id,
    // different body) and deletes it too — v1 and v2 want the same slot.
    writeChapterFile(root, CHAPTER, undefined, ['id: ch-1', 'title: 开篇（新）', 'volume: vol-01', 'seq: 1'], '第二版正文。')
    const secondBytes = readFileSync(join(root, CHAPTER))
    assert.equal((await read(harness, '/chapters')).json.ok, true)
    const before = fileTree(root)

    const second = await writeCall(harness, '/chapters/ch-1', { method: 'DELETE' })
    assert.equal(second.status, 409, JSON.stringify(second.json).slice(0, 200))
    assert.equal(second.json.ok, false)
    assert.equal(second.json.error.code, 'TRASH_ENTRY_EXISTS', JSON.stringify(second.json).slice(0, 200))
    assert.equal(second.json.error.nothingWritten, true)

    assert.equal(fileTree(root), before, 'the refused second delete writes nothing at all')
    assert.deepEqual(readFileSync(copyPath), firstCopy, 'the bin copy is still v1, byte for byte')
    assert.deepEqual(readFileSync(join(root, CHAPTER)), secondBytes, 'v2 is still in the working tree')
    const manifest = manifestOf(root)
    assert.equal(manifest.entries.length, 1, 'no second entry was recorded')
    assert.equal(manifest.entries[0].id, firstEntry.id)

    // The point of the whole rule: v1 is still there to be recovered. While v2
    // occupies the path the restore refuses (that is 3's rule), and once the path
    // is free the bin hands v1 back unchanged.
    const blocked = await writeCall(harness, '/trash/restore', { payload: { id: firstEntry.id } })
    assert.equal(blocked.json.error.code, 'RESTORE_TARGET_EXISTS')
    rmSync(join(root, CHAPTER))
    const restored = await writeCall(harness, '/trash/restore', { payload: { id: firstEntry.id } })
    assert.equal(restored.status, 200, JSON.stringify(restored.json).slice(0, 200))
    assert.deepEqual(readFileSync(join(root, CHAPTER)), firstCopy, 'v1 came back out of the bin')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('delete → restore → delete is legal: a restore frees the slot', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    const original = readFileSync(join(root, CHAPTER))

    assert.equal((await writeCall(harness, '/chapters/ch-1', { method: 'DELETE' })).status, 200)
    const id = manifestOf(root).entries[0].id
    assert.equal((await writeCall(harness, '/trash/restore', { payload: { id } })).status, 200)
    assert.deepEqual(readFileSync(join(root, CHAPTER)), original)

    const again = await writeCall(harness, '/chapters/ch-1', { method: 'DELETE' })
    assert.equal(again.status, 200, JSON.stringify(again.json).slice(0, 200))
    assert.equal(existsSync(join(root, CHAPTER)), false)
    const manifest = manifestOf(root)
    assert.equal(manifest.entries.length, 1, 'exactly one entry: the first one was consumed by the restore')
    assert.notEqual(manifest.entries[0].id, id, 'the second delete minted its own id')
    assert.deepEqual(readFileSync(join(root, TRASH_ROOT, CHAPTER)), original)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('delete → purge → delete is legal: a purge frees the slot', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    assert.equal((await writeCall(harness, '/chapters/ch-1', { method: 'DELETE' })).status, 200)
    const id = manifestOf(root).entries[0].id
    const purged = await writeCall(harness, '/trash/purge', { payload: { id, confirm: true } })
    assert.equal(purged.status, 200, JSON.stringify(purged.json).slice(0, 200))
    assert.deepEqual(manifestOf(root).entries, [])
    assert.equal(existsSync(join(root, TRASH_ROOT, CHAPTER)), false)

    // A purge is forever, so the file has to come back some other way (the author
    // retypes the chapter, or restores it from git) before it can be deleted again.
    writeChapterFile(root, CHAPTER, undefined, ['id: ch-1', 'title: 开篇（重写）', 'volume: vol-01', 'seq: 1'], '重写的正文。')
    assert.equal((await read(harness, '/chapters')).json.ok, true)
    const again = await writeCall(harness, '/chapters/ch-1', { method: 'DELETE' })
    assert.equal(again.status, 200, JSON.stringify(again.json).slice(0, 200))
    assert.equal(manifestOf(root).entries.length, 1)
    assert.equal(existsSync(join(root, TRASH_ROOT, CHAPTER)), true, 'the freshly deleted copy is in the bin')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. The text writer's one blind spot: bytes that are not valid UTF-8
// ---------------------------------------------------------------------------

test('a file the text writer cannot reproduce byte-exactly is never deleted', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    // 0x80 alone is not valid UTF-8: reading it as text yields `\uFFFD`, and
    // writing that back would be a different file. A delete must refuse rather
    // than destroy bytes it cannot restore.
    const raw = Buffer.concat([
      Buffer.from('---\nid: ch-raw\ntitle: 坏字节\n---\n\n', 'utf8'),
      Buffer.from([0x80, 0x81]),
      Buffer.from('\n', 'utf8'),
    ])
    const relative = 'chapters/0003-坏字节.md'
    writeChapterFile(root, relative, raw)
    const harness = createHarness({ workspace: root })
    // Warm the derived index first: a rebuild inside the refused request would
    // move the tree hash for a reason that has nothing to do with the refusal.
    assert.equal((await read(harness, '/chapters')).json.ok, true)
    const before = fileTree(root)

    const refused = await writeCall(harness, '/chapters/ch-raw', { method: 'DELETE' })
    assert.equal(refused.json.ok, false)
    assert.equal(refused.json.error.code, 'TRASH_COPY_MISMATCH', JSON.stringify(refused.json).slice(0, 200))

    assert.equal(fileTree(root), before, 'the refusal writes nothing at all')
    assert.deepEqual(readFileSync(join(root, relative)), raw, 'the original is still there, byte for byte')
    assert.equal(existsSync(join(root, TRASH_ROOT)), false, 'no copy was left behind')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5b. "Nothing was written" includes `.gitignore`
//
// The ignore line is appended only after the copy and its manifest entry exist,
// so a delete that could not make its copy must not have touched `.gitignore`
// either — otherwise the refusal's `nothingWritten: true` is a lie.
// ---------------------------------------------------------------------------

test('a delete whose copy cannot be written leaves .gitignore alone', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    // A file where the copy needs a directory: `.inkflow/trash/chapters/...` can
    // then never be created, which is a copy failure with the original untouched.
    mkdirSync(join(root, TRASH_ROOT), { recursive: true })
    writeFileSync(join(root, TRASH_ROOT, 'chapters'), 'not a directory\n', 'utf8')
    assert.equal((await read(harness, '/chapters')).json.ok, true)
    const before = fileTree(root)

    const refused = await writeCall(harness, '/chapters/ch-1', { method: 'DELETE' })
    assert.equal(refused.json.ok, false, JSON.stringify(refused.json).slice(0, 200))
    assert.equal(refused.json.error.nothingWritten, true)

    assert.equal(fileTree(root), before, 'the failed delete writes nothing')
    assert.equal(existsSync(join(root, '.gitignore')), false, '`.gitignore` was not appended before the copy existed')
    assert.equal(existsSync(join(root, CHAPTER)), true, 'the chapter is still there')
    assert.equal(existsSync(join(root, MANIFEST)), false, 'no manifest entry was recorded')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. A corrupt manifest is refused, never overwritten
// ---------------------------------------------------------------------------

test('a corrupt manifest refuses every trash operation instead of overwriting it', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    mkdirSync(join(root, TRASH_ROOT), { recursive: true })
    writeFileSync(join(root, MANIFEST), '{ this is not json', 'utf8')

    const listed = await read(harness, '/trash')
    assert.equal(listed.json.ok, false)
    assert.equal(listed.json.error.code, 'TRASH_MANIFEST_INVALID')

    // Same warm-up as above: the index rebuild is a legitimate write that must
    // not be confused with the refusal's zero writes.
    assert.equal((await read(harness, '/chapters')).json.ok, true)
    const before = fileTree(root)
    const refused = await writeCall(harness, '/chapters/ch-1', { method: 'DELETE' })
    assert.equal(refused.json.ok, false)
    assert.equal(refused.json.error.code, 'TRASH_MANIFEST_INVALID')
    assert.equal(fileTree(root), before, 'the chapter is not deleted when its copy cannot be recorded')
    assert.equal(readFileSync(join(root, MANIFEST), 'utf8'), '{ this is not json', 'the manifest is left alone')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6b. The spec's other two restore refusals, and the manifest shapes it refuses
// ---------------------------------------------------------------------------

test('restoring an entry whose copy was cleaned by hand is TRASH_COPY_MISSING and writes nothing', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    assert.equal((await writeCall(harness, '/chapters/ch-1', { method: 'DELETE' })).status, 200)
    const id = manifestOf(root).entries[0].id
    rmSync(join(root, TRASH_ROOT, CHAPTER))
    const before = fileTree(root)

    const refused = await writeCall(harness, '/trash/restore', { payload: { id } })
    assert.equal(refused.status, 409, JSON.stringify(refused.json).slice(0, 200))
    assert.equal(refused.json.error.code, 'TRASH_COPY_MISSING')
    assert.equal(refused.json.error.nothingWritten, true)

    assert.equal(fileTree(root), before, 'a missing copy is refused without writing')
    assert.equal(existsSync(join(root, CHAPTER)), false, 'nothing was written back to the working tree')
    assert.equal(manifestOf(root).entries.length, 1, 'the entry stays, so it can still be purged')
    const listed = await read(harness, '/trash')
    assert.equal(listed.json.value.entries[0].present, false, 'the panel is told the copy is gone')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('restoring a copy edited inside the bin is TRASH_COPY_CHANGED and writes nothing', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    assert.equal((await writeCall(harness, '/chapters/ch-1', { method: 'DELETE' })).status, 200)
    const id = manifestOf(root).entries[0].id
    const copyPath = join(root, TRASH_ROOT, CHAPTER)
    // Same length as the deleted text would not help: the check is a hash.
    writeFileSync(copyPath, '被改过的副本\n', 'utf8')
    const tampered = readFileSync(copyPath)
    const before = fileTree(root)

    const refused = await writeCall(harness, '/trash/restore', { payload: { id } })
    assert.equal(refused.status, 409, JSON.stringify(refused.json).slice(0, 200))
    assert.equal(refused.json.error.code, 'TRASH_COPY_CHANGED')
    assert.equal(refused.json.error.nothingWritten, true)

    assert.equal(fileTree(root), before, 'a changed copy is refused without writing')
    assert.deepEqual(readFileSync(copyPath), tampered, 'the copy is left exactly as the author left it')
    assert.equal(existsSync(join(root, CHAPTER)), false, 'the edited copy was not handed back as the deleted text')
    assert.equal(manifestOf(root).entries.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a manifest entry pointing into .inkflow/ is TRASH_MANIFEST_INVALID, never restored', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    // A hand-edited manifest: every field is well-formed, and only the path is
    // forbidden. Restoring it would drop a file inside the plugin's own state
    // directory, where `listTrash` never looks again.
    const evilPath = `${TRASH_ROOT}/evil.md`
    mkdirSync(join(root, TRASH_ROOT), { recursive: true })
    const manifest = {
      schemaVersion: 1,
      entries: [
        {
          id: 't-evil',
          originalPath: evilPath,
          deletedAt: '2026-10-24T00:00:00.000Z',
          bytes: 4,
          sha256: 'a'.repeat(64),
          reason: 'chapter_delete',
        },
      ],
    }
    writeFileSync(join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    const manifestText = readFileSync(join(root, MANIFEST), 'utf8')

    const listed = await read(harness, '/trash')
    assert.equal(listed.status, 500, 'an unreadable manifest is not a client error: the list answers 500')
    assert.equal(listed.json.ok, false)
    assert.equal(listed.json.error.code, 'TRASH_MANIFEST_INVALID')

    assert.equal((await read(harness, '/chapters')).json.ok, true)
    const before = fileTree(root)
    const refused = await writeCall(harness, '/trash/restore', { payload: { id: 't-evil' } })
    assert.equal(refused.json.ok, false)
    assert.equal(refused.json.error.code, 'TRASH_MANIFEST_INVALID')
    // A manifest this module cannot read refuses the deletes too, not just the reads.
    const deleteRefused = await writeCall(harness, '/chapters/ch-1', { method: 'DELETE' })
    assert.equal(deleteRefused.json.error.code, 'TRASH_MANIFEST_INVALID')

    assert.equal(fileTree(root), before, 'neither refusal writes anything')
    assert.equal(existsSync(join(root, evilPath)), false, 'no file was written into the private state directory')
    assert.equal(readFileSync(join(root, MANIFEST), 'utf8'), manifestText, 'the manifest is left alone')
    assert.equal(existsSync(join(root, CHAPTER)), true, 'the chapter is still there')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a manifest with another schemaVersion or a partial entry is TRASH_MANIFEST_INVALID', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    mkdirSync(join(root, TRASH_ROOT), { recursive: true })
    const cases = [
      ['schemaVersion 2', { schemaVersion: 2, entries: [] }],
      [
        'an entry without sha256',
        {
          schemaVersion: 1,
          entries: [{ id: 't1', originalPath: CHAPTER, deletedAt: '2026-10-24T00:00:00.000Z', bytes: 3, reason: 'chapter_delete' }],
        },
      ],
      ['an entries field that is not an array', { schemaVersion: 1, entries: 'nope' }],
    ]
    for (const [label, value] of cases) {
      writeFileSync(join(root, MANIFEST), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      const listed = await read(harness, '/trash')
      assert.equal(listed.json.ok, false, label)
      assert.equal(listed.json.error.code, 'TRASH_MANIFEST_INVALID', label)
    }
    // ...and the last shape still refuses a delete with zero writes.
    assert.equal((await read(harness, '/chapters')).json.ok, true)
    const before = fileTree(root)
    const refused = await writeCall(harness, '/chapters/ch-1', { method: 'DELETE' })
    assert.equal(refused.json.error.code, 'TRASH_MANIFEST_INVALID')
    assert.equal(fileTree(root), before)
    assert.equal(existsSync(join(root, CHAPTER)), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7. The bin is invisible to the index and to every read projection
// ---------------------------------------------------------------------------

test('the deleted chapter leaves the tree, the search and entities; the bin never enters them', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    const before = await read(harness, '/chapters')
    assert.equal(before.json.value.total, 1)
    // Two different searches on purpose. The channel's `/search` route answers
    // chapter METADATA only in this build (`searchUnavailable: true`, reason
    // quoted from the acceptance case), so a hit there proves the catalog; the prose answer
    // comes from `searchChapters`, which reads `chapters_fts` in the derived
    // index. "Gone from retrieval" has to hold for both.
    const metadataBefore = await read(harness, '/search?q=开篇')
    assert.equal(metadataBefore.json.value.total, 1, 'the metadata search finds the chapter before the delete')
    const proseBefore = searchChapters(root, '白鹤门')
    assert.equal(proseBefore.ok, true)
    assert.ok(proseBefore.total >= 1, 'the prose index holds the body before the delete')

    assert.equal((await writeCall(harness, '/chapters/ch-1', { method: 'DELETE' })).status, 200)

    const after = await read(harness, '/chapters')
    assert.equal(after.json.value.total, 0, 'the chapter tree no longer lists it')
    const metadataAfter = await read(harness, '/search?q=开篇')
    assert.equal(metadataAfter.json.value.total, 0, 'the metadata search no longer finds it')
    const proseAfter = searchChapters(root, '白鹤门')
    assert.equal(proseAfter.ok, true)
    assert.equal(proseAfter.total, 0, 'the prose index no longer holds the body')

    const bin = await read(harness, '/trash')
    assert.equal(bin.json.value.total, 1, '...while the recovery bin still has it')

    const db = new DatabaseSync(join(root, 'index', 'inkflow.db'), { readOnly: true })
    try {
      const privateRows = db.prepare("SELECT COUNT(*) AS n FROM files WHERE path LIKE '.inkflow/%'").get()
      assert.equal(privateRows.n, 0, 'no `files` row is ever produced for the private state directory')
      const privateEntities = db.prepare("SELECT COUNT(*) AS n FROM entities WHERE path LIKE '.inkflow/%'").get()
      assert.equal(privateEntities.n, 0, 'no `entities` row either')
      const deletedChapter = db.prepare('SELECT COUNT(*) AS n FROM files WHERE path = ?').get(CHAPTER)
      assert.equal(deletedChapter.n, 0, 'the deleted chapter file is out of the index')
      const deletedEntity = db.prepare("SELECT COUNT(*) AS n FROM entities WHERE kind = 'chapter' AND path = ?").get(CHAPTER)
      assert.equal(deletedEntity.n, 0, 'and out of the cross-class projection')
    } finally {
      db.close()
    }
    assert.equal(statSync(join(root, TRASH_ROOT, CHAPTER)).isFile(), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 8. The channel's own guards still hold on the two new write routes
// ---------------------------------------------------------------------------

test('the trash routes keep the channel guards: JSON, declared fields, session', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    assert.equal((await writeCall(harness, '/chapters/ch-1', { method: 'DELETE' })).status, 200)
    const id = manifestOf(root).entries[0].id

    const before = fileTree(root)
    const noType = await writeCall(harness, '/trash/restore', { contentType: null, payload: { id } })
    assert.equal(noType.status, 415)
    assert.equal(fileTree(root), before, 'a 415 writes nothing')

    const smuggled = await writeCall(harness, '/trash/restore', { payload: { id, path: 'chapters/x.md' } })
    assert.equal(smuggled.status, 400)
    // A body may not name a directory at all: the path-parameter ban fires
    // before the route's own allowlist, and both codes are refusals.
    assert.equal(smuggled.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')

    const undeclared = await writeCall(harness, '/trash/purge', { payload: { id, confirm: true, recursive: true } })
    assert.equal(undeclared.status, 400)
    assert.equal(undeclared.json.error.code, 'UNEXPECTED_BODY_FIELD')
    assert.equal(undeclared.json.error.field, 'recursive')

    const missingId = await writeCall(harness, '/trash/restore', { payload: {} })
    assert.equal(missingId.status, 400)
    assert.equal(missingId.json.error.code, 'invalid-field')

    const badConfirm = await writeCall(harness, '/trash/purge', { payload: { id, confirm: 'yes' } })
    assert.equal(badConfirm.status, 400)
    assert.equal(badConfirm.json.error.field, 'confirm')

    const crossSite = await writeCall(harness, '/trash/purge', { origin: 'https://evil.example.com', payload: { id, confirm: true } })
    assert.equal(crossSite.status, 403)
    assert.equal(crossSite.json.ok, false)

    const noSession = await read(harness, '/trash', { sessionId: null })
    assert.equal(noSession.status, 200)
    assert.equal(noSession.json.ok, false)
    assert.equal(noSession.json.error.code, 'NO_SESSION_CONTEXT')

    const getOnWrite = await read(harness, '/trash/purge')
    assert.equal(getOnWrite.status, 405)
    assert.equal(getOnWrite.headers.allow, 'POST')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 9. The page's pure view model
// ---------------------------------------------------------------------------

async function loadTrashModel() {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client', 'trash-model.ts')],
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

test('the trash view model words the page without touching the channel at import time', async () => {
  const model = await loadTrashModel()
  const source = readFileSync(join(ROOT, 'src/client', 'trash-model.ts'), 'utf8')
  assert.equal(/^import\s+\{[^}]*\}\s+from\s+'\.\/internal\.js'/m.test(source), false, 'a runtime import of the channel module is forbidden')
  assert.ok(source.includes("import type"), 'types only, erased at build time')

  assert.equal(model.formatBytes(0), '0 B')
  assert.equal(model.formatBytes(999), '999 B')
  assert.equal(model.formatBytes(2048), '2.0 KB')

  const entry = {
    id: 't1',
    originalPath: 'chapters/vol-01/0001-开篇.md',
    deletedAt: '2026-10-24T01:02:03.000Z',
    bytes: 2048,
    sha256: 'a'.repeat(64),
    reason: 'chapter_delete',
    present: true,
  }
  assert.equal(model.describeEntry(entry).path, 'chapters/vol-01/0001-开篇.md')
  assert.equal(model.describeEntry(entry).size, '2.0 KB')
  assert.equal(model.describeReason('chapter_delete'), '删除章节')
  assert.equal(model.restoreBlockedReason(entry), null)
  assert.notEqual(model.restoreBlockedReason({ ...entry, present: false }), null, 'a missing copy blocks the restore button')

  // Purge is two clicks on the panel, and the second click is what writes.
  assert.equal(model.purgeStage(null, 't1'), 'armed')
  assert.equal(model.purgeStage('t1', 't1'), 'confirmed')
  assert.equal(model.purgeStage('t2', 't1'), 'armed')

  assert.ok(model.describeTrashError({ code: 'RESTORE_TARGET_EXISTS' }).includes('已存在'))
  assert.ok(model.describeTrashError({ code: 'TRASH_ENTRY_EXISTS' }).includes('恢复'), 'the same-path refusal says how to free the slot')
  assert.ok(model.describeTrashError({ code: 'CONFIRM_REQUIRED' }).includes('确认'))
  assert.ok(model.describeTrashError({ code: 'SOMETHING_UNKNOWN' }).length > 0, 'an unknown code still says something')
})
