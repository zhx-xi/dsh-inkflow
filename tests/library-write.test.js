/**
 * Contract tests for the setting library's SAVE path (issue #30, second batch):
 * `POST /inkflow/internal/library/item`.
 *
 * Same harness style as `tests/internal-write.test.js` / `tests/library-panel.test.js`:
 * the BUILT artifact `lib/index.js` is driven through a fake Cordis context, a
 * fake request/response pair and a throwaway book on disk. No DSH process, no
 * socket. The client half is checked against the BUILT `lib/client.js` bundle
 * plus `src/client/library-model.ts` bundled on the fly.
 *
 * What must FAIL when the save path is wired wrong:
 *   1. an edit lands in the file (frontmatter + body) and UNKNOWN fields, block
 *      lists and inline comments survive it;
 *   2. `expected` is a real CAS: a stale baseline is 409 `FILE_CHANGED` with the
 *      CURRENT fingerprint and **zero bytes written**;
 *   3. an id that escapes its content directory (`..`, absolute, non-`.md`) is
 *      refused with the filesystem untouched;
 *   4. the body allowlist holds (`path` is a 400 before any IO), and a non-POST
 *      verb or a cross-site `Origin` never reaches the handler;
 *   5. an unreadable index does not block the save (200 + `indexError`), and a
 *      successful save leaves the index agreeing with the file.
 *
 * Run: pnpm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { apply } from '../lib/index.js'

const ROOT = resolve(import.meta.dirname, '..')
const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const ALL_DIRS = [...CONTENT_DIRS, 'index']
const KEEP = '.gitkeep'
const HOST = '127.0.0.1:2149'
const ORIGIN = `http://${HOST}`
const INTERNAL = '/inkflow/internal'
const JSON_TYPE = 'application/json'

// ---------------------------------------------------------------------------
// Harness (same shape as internal-write.test.js / library-panel.test.js)
// ---------------------------------------------------------------------------

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
  apply(ctx, { dataDir: join(tmpdir(), 'inkflow-library-write-state') })
  return { ctx, routes }
}

function fakeRequest({ url, method = 'GET', host = HOST, origin, remoteAddress = '127.0.0.1', body, contentType = JSON_TYPE, secFetchSite } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  if (secFetchSite !== undefined) headers['sec-fetch-site'] = secFetchSite
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

/** A GET on the internal channel, with the session in the query. */
function internalCall(harness, path, options = {}) {
  const query = options.sessionId === null ? '' : `sessionId=${encodeURIComponent(options.sessionId ?? 'session-1')}`
  const separator = path.includes('?') ? '&' : '?'
  const url = query === '' ? `${INTERNAL}${path}` : `${INTERNAL}${path}${separator}${query}`
  return callRoute(harness, fakeRequest({ ...options, url }))
}

/** A save, with every guard satisfied unless the test overrides it. */
function saveCall(harness, payload, options = {}) {
  const query = options.sessionId === null ? '' : `sessionId=${encodeURIComponent(options.sessionId ?? 'session-1')}`
  const url = query === '' ? `${INTERNAL}/library/item` : `${INTERNAL}/library/item?${query}`
  return callRoute(
    harness,
    fakeRequest({
      origin: ORIGIN,
      ...options,
      url,
      method: options.method ?? 'POST',
      body: JSON.stringify(options.rawPayload ?? payload ?? {}),
    }),
  )
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-library-write-'))
}

function scaffold(root) {
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, '.git'))
  for (const dir of ALL_DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, KEEP), '', 'utf8')
  }
  writeFileSync(
    join(root, 'inkflow.json'),
    `${JSON.stringify({ schemaVersion: 1, title: '设定库之书', author: 'tester' }, null, 2)}\n`,
    'utf8',
  )
}

function writeMarkdown(root, relativePath, frontmatterLines, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = frontmatterLines.length > 0 ? `---\n${frontmatterLines.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

const CHARACTER = 'characters/沈青.md'
const WORLD = 'world/地点/青云山.md'

/**
 * One book with the three frontmatter shapes the editor has to survive:
 * a block list plus an inline comment (`characters`), booleans and numbers
 * (`world`), and an unknown key no form knows about.
 */
function bookProject(root) {
  scaffold(root)
  writeMarkdown(
    root,
    CHARACTER,
    [
      'id: char-shen',
      'name: 沈青',
      'aliases:',
      '  - 阿青',
      '  - 青妹',
      'role: 主角',
      'voice: 寡言   # 作者的备注',
      'tags: [剑修, 冷面]',
    ],
    '剑不离身。',
  )
  writeMarkdown(
    root,
    WORLD,
    ['id: world-qingyun', 'title: 青云山', 'category: 地点', 'keywords: [青云, 鹤]', 'always: false', 'priority: 2'],
    '山中有鹤。',
  )
}

function readFileText(root, relativePath) {
  return readFileSync(join(root, relativePath), 'utf8')
}

/**
 * Stable hash of every TRUTH file: the nine content directories, `inkflow.json`
 * and `.git` are in, `index/` is out.
 *
 * The derived index is the plugin's own cache and the place its write lock lives
 * (`index/.write.lock` — created and removed around every write section, which
 * moves that directory's mtime without touching a single byte). A refusal has to
 * leave the *book* identical, and the index must not be rebuilt — that second
 * claim is asserted separately, by hashing the database file itself.
 */
function hashTruth(root, relative = '') {
  const hash = createHash('sha256')
  const walk = (relativePath) => {
    const dir = relativePath === '' ? root : join(root, relativePath)
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (relativePath === '' && entry.name === 'index') continue
      const child = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`
      const info = statSync(join(root, child))
      hash.update(`${child}|${entry.isDirectory() ? 'd' : 'f'}|${info.size}|${info.mtimeMs}\n`)
      if (entry.isDirectory()) walk(child)
    }
  }
  walk(relative)
  return hash.digest('hex')
}

/** Byte identity of the derived database, or `null` when it does not exist. */
function indexDigest(root) {
  const dbFile = join(root, 'index', 'inkflow.db')
  if (!existsSync(dbFile) || !statSync(dbFile).isFile()) return null
  return createHash('sha256').update(readFileSync(dbFile)).digest('hex')
}

/** The CAS baseline the editor is given by the read route. */
async function fingerprintOf(harness, kind, id) {
  const detail = await internalCall(harness, `/library/item?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`)
  assert.equal(detail.status, 200, `detail must answer: ${JSON.stringify(detail.json)}`)
  assert.equal(detail.json.ok, true, `detail must answer: ${JSON.stringify(detail.json)}`)
  const fingerprint = detail.json.value.fingerprint
  assert.ok(fingerprint !== null && typeof fingerprint.sha256 === 'string', 'the detail route must publish a CAS baseline')
  return fingerprint
}

// ---------------------------------------------------------------------------
// 1. A save lands: frontmatter edited, unknown fields kept, body replaced
// ---------------------------------------------------------------------------

test('library save: an edit lands in the file and every unknown key survives', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    const before = readFileText(root, CHARACTER)
    const fingerprint = await fingerprintOf(harness, 'characters', 'char-shen')

    const saved = await saveCall(harness, {
      kind: 'characters',
      id: 'char-shen',
      frontmatter: { role: '反派', voice: '话少而准' },
      body: '剑已在鞘。\n',
      expected: fingerprint,
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.json))
    assert.equal(saved.json.ok, true)
    const value = saved.json.value
    assert.equal(value.replaced, true, 'the file was replaced')
    assert.equal(value.kind, 'characters')
    assert.equal(value.path, CHARACTER)
    assert.deepEqual(value.changed.sort(), ['body', 'role', 'voice'])
    assert.equal(value.frontmatter.role, '反派')
    assert.equal(value.frontmatter.voice, '话少而准')
    assert.equal(value.body.trim(), '剑已在鞘。')

    const after = readFileText(root, CHARACTER)
    assert.notEqual(after, before, 'the file must actually change')
    // What the author did not edit is still there, byte for byte.
    for (const line of ['id: char-shen', 'name: 沈青', '  - 阿青', '  - 青妹', 'tags: [剑修, 冷面]']) {
      assert.ok(after.includes(line), `expected the untouched line "${line}" in:\n${after}`)
    }
    assert.ok(after.includes('# 作者的备注'), 'the inline comment must survive the patch')
    assert.ok(after.includes('role: 反派'), 'the edited key is rewritten')
    assert.ok(after.trimEnd().endsWith('剑已在鞘。'), 'the body was replaced')

    // A new fingerprint, and it describes what is on disk now.
    assert.notEqual(value.fingerprint.sha256, fingerprint.sha256, 'the baseline must move with the file')
    assert.equal(value.fingerprint.size, statSync(join(root, CHARACTER)).size)
    const again = await fingerprintOf(harness, 'characters', 'char-shen')
    assert.equal(again.sha256, value.fingerprint.sha256, 'the detail route reports the same bytes the save wrote')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. CAS: a stale baseline is 409 and writes nothing
// ---------------------------------------------------------------------------

test('library save: a stale expected is a 409 FILE_CHANGED and the bytes do not move', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    const fingerprint = await fingerprintOf(harness, 'characters', 'char-shen')

    // The author saves from their own editor between load and save.
    const onDisk = readFileText(root, CHARACTER).replace('role: 主角', 'role: 配角')
    writeFileSync(join(root, CHARACTER), onDisk, 'utf8')
    const before = hashTruth(root)
    const indexBefore = indexDigest(root)

    const refused = await saveCall(harness, {
      kind: 'characters',
      id: 'char-shen',
      frontmatter: { role: '反派' },
      expected: fingerprint,
    })
    assert.equal(refused.status, 409, JSON.stringify(refused.json))
    assert.equal(refused.json.ok, false)
    assert.equal(refused.json.error.code, 'FILE_CHANGED')
    assert.equal(refused.json.error.nothingWritten, true)
    assert.equal(refused.json.error.path, CHARACTER)
    assert.ok(refused.json.error.changed.includes('sha256'), 'the drift names the field that moved')
    assert.equal(refused.json.error.current.sha256, createHash('sha256').update(onDisk, 'utf8').digest('hex'))
    assert.equal(refused.json.error.expected.sha256, fingerprint.sha256)

    assert.equal(readFileText(root, CHARACTER), onDisk, 'a 409 must not touch the file')
    assert.equal(hashTruth(root), before, 'a 409 must not touch the book')
    assert.equal(indexDigest(root), indexBefore, 'a refusal is not a rebuild either')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. An id that escapes its content directory
// ---------------------------------------------------------------------------

test('library save: an escaping id is refused and the filesystem does not move', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    const fingerprint = await fingerprintOf(harness, 'characters', 'char-shen')
    const before = hashTruth(root)
    const escaped = ['../../etc/passwd', join(root, CHARACTER), 'characters/../inkflow.json', 'chapters/0001-x.md']
    for (const id of escaped) {
      const refused = await saveCall(harness, { kind: 'characters', id, frontmatter: { role: 'x' }, expected: fingerprint })
      assert.equal(refused.json.ok, false, `${id} must be refused`)
      assert.ok([400, 404].includes(refused.status), `${id}: expected 400/404, got ${refused.status}`)
      assert.ok(
        ['PATH_OUT_OF_SCOPE', 'library-item-not-found'].includes(refused.json.error.code),
        `${id}: unexpected code ${refused.json.error.code}`,
      )
    }

    // A non-Markdown name is not an entry either.
    const notMarkdown = await saveCall(harness, {
      kind: 'characters',
      id: 'characters/沈青.txt',
      frontmatter: { role: 'x' },
      expected: fingerprint,
    })
    assert.equal(notMarkdown.status, 404)
    assert.equal(notMarkdown.json.error.code, 'library-item-not-found')
    assert.equal(hashTruth(root), before, 'no refusal may write, move or rebuild anything')

    // The same file addressed correctly still saves (the nets are not blanket).
    const ok = await saveCall(harness, { kind: 'characters', id: CHARACTER, frontmatter: { role: '主角' }, expected: fingerprint })
    assert.equal(ok.status, 200, JSON.stringify(ok.json))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. The guards: body allowlist, verbs, Origin
// ---------------------------------------------------------------------------

test('library save: a path parameter in the body is a 400 before any IO', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    const fingerprint = await fingerprintOf(harness, 'characters', 'char-shen')
    const before = hashTruth(root)

    for (const key of ['path', 'root', 'cwd', 'workspace', 'projectRoot']) {
      const refused = await saveCall(harness, {
        kind: 'characters',
        id: 'char-shen',
        frontmatter: { role: 'x' },
        expected: fingerprint,
        [key]: CHARACTER,
      })
      assert.equal(refused.status, 400, `{${key}} must be refused`)
      assert.equal(refused.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')
      assert.equal(refused.json.error.param, key)
    }

    // An undeclared field is the same guard one step later.
    const undeclared = await saveCall(harness, {
      kind: 'characters',
      id: 'char-shen',
      frontmatter: { role: 'x' },
      expected: fingerprint,
      rename: '沈青.md',
    })
    assert.equal(undeclared.status, 400)
    assert.equal(undeclared.json.error.code, 'UNEXPECTED_BODY_FIELD')
    assert.equal(undeclared.json.error.field, 'rename')

    assert.equal(hashTruth(root), before, 'a refused body must not touch the book')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('library save: a non-POST verb, a missing or cross-site Origin and a non-JSON body are refused', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    const fingerprint = await fingerprintOf(harness, 'characters', 'char-shen')
    const before = hashTruth(root)
    const payload = { kind: 'characters', id: 'char-shen', frontmatter: { role: 'x' }, expected: fingerprint }

    // GET is a declared verb on this route (it is also the detail reader), so the
    // 405 list is the verbs that are not declared; a GET without `kind`/`id` is
    // still a refusal, not a write.
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const refused = await saveCall(harness, payload, { method })
      assert.equal(refused.status, 405, `${method} must not be accepted on the save route`)
      assert.equal(refused.json.error.code, 'method-not-allowed')
      assert.equal(refused.headers['allow'], 'GET, POST')
    }
    const getWithoutAddress = await saveCall(harness, {}, { method: 'GET' })
    assert.equal(getWithoutAddress.status, 400)
    assert.equal(getWithoutAddress.json.error.code, 'KIND_REQUIRED', 'a GET reads, it never writes with a body')

    // An ABSENT Origin is no longer a refusal (issue #115): a browser always sets
    // it on a POST, so the absence means the caller is not a web page — and a page
    // that arrived cross-site still declares `Sec-Fetch-Site: cross-site`.
    const noOrigin = await saveCall(harness, payload, { origin: undefined })
    assert.equal(noOrigin.status, 200, JSON.stringify(noOrigin.json).slice(0, 160))
    assert.equal(noOrigin.json.ok, true)

    const crossSiteFetch = await saveCall(harness, payload, { origin: undefined, secFetchSite: 'cross-site' })
    assert.equal(crossSiteFetch.status, 403)
    assert.equal(crossSiteFetch.json.error.code, 'forbidden-origin')
    assert.equal(crossSiteFetch.json.error.reason, 'cross-site-fetch')

    const crossSite = await saveCall(harness, payload, { origin: 'https://evil.example.com' })
    assert.equal(crossSite.status, 403)
    assert.equal(crossSite.json.error.code, 'forbidden-origin')

    const wrongType = await saveCall(harness, payload, { contentType: 'text/plain' })
    assert.equal(wrongType.status, 415)
    assert.equal(wrongType.json.error.code, 'unsupported-media-type')

    // No session at all: "cannot answer yet", not a write.
    const noSession = await saveCall(harness, payload, { sessionId: null })
    assert.equal(noSession.status, 200)
    assert.equal(noSession.json.ok, false)
    assert.equal(noSession.json.error.code, 'NO_SESSION_CONTEXT')

    // Only the origin-less save reached the file; every refusal left the book alone.
    assert.notEqual(hashTruth(root), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. A dead index does not block the save
// ---------------------------------------------------------------------------

test('library save: an unreadable index still saves the file and reports indexError', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    // A directory where the database must be: `ensureIndex` cannot open it and
    // cannot rename over it, which is the real "index unavailable" state.
    rmSync(join(root, 'index', 'inkflow.db'), { force: true })
    mkdirSync(join(root, 'index', 'inkflow.db'), { recursive: true })

    const saved = await saveCall(harness, {
      kind: 'characters',
      id: 'char-shen',
      frontmatter: { name: '沈青儿' },
      expected: await expectedFromFile(root, CHARACTER),
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.json))
    assert.equal(saved.json.ok, true, 'an unusable index must not stop a save')
    assert.equal(saved.json.value.replaced, true)
    assert.ok(saved.json.value.indexError !== undefined, 'the value must say why the index is not fresh')
    assert.equal(typeof saved.json.value.indexError.code, 'string')
    assert.equal(saved.json.value.indexRebuilt, false)
    assert.ok(readFileText(root, CHARACTER).includes('name: 沈青儿'), 'the file is written regardless')

    // And the read route agrees that the index is unusable — the same claim.
    const detail = await internalCall(harness, '/library/item?kind=characters&id=char-shen')
    assert.equal(detail.status, 200)
    assert.equal(detail.json.ok, false)
    assert.equal(detail.json.error.code, 'INDEX_UNAVAILABLE')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The CAS baseline taken straight from the bytes on disk, for a book whose index
 * cannot answer (the normal read route is unavailable there on purpose).
 */
async function expectedFromFile(root, relativePath) {
  const bytes = readFileSync(join(root, relativePath))
  return {
    size: bytes.length,
    mtimeMs: statSync(join(root, relativePath)).mtimeMs,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

// ---------------------------------------------------------------------------
// 6. Arrays, numbers, booleans and comments round-trip through the file
// ---------------------------------------------------------------------------

test('library save: a list is written as a block list, numbers and booleans stay unquoted, comments survive', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    const fingerprint = await fingerprintOf(harness, 'world', 'world-qingyun')

    const saved = await saveCall(harness, {
      kind: 'world',
      id: 'world-qingyun',
      frontmatter: {
        keywords: ['青云', '鹤鸣', '山门'],
        always: true,
        priority: 5,
        title: '青云山   # 山名不改备注也算改',
      },
      expected: fingerprint,
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.json))
    const text = readFileText(root, WORLD)

    // Block form, one item per line — the only list form the reader accepts for
    // values that may contain `,` or `:`.
    assert.ok(text.includes('keywords:\n  - 青云\n  - 鹤鸣\n  - 山门'), `expected a block list in:\n${text}`)
    assert.ok(text.includes('always: true'), `a boolean must be written unquoted, got:\n${text}`)
    assert.equal(text.includes('"true"'), false)
    assert.ok(text.includes('priority: 5'), `a number must be written unquoted, got:\n${text}`)

    // The value the author typed wins, but the comment after it belongs to the
    // line, not to the value: patchFrontmatter keeps it.
    assert.ok(text.includes('# 山名不改备注也算改'), 'the trailing comment survives a value rewrite')
    assert.equal(saved.json.value.frontmatter.always, true, 'a boolean reads back as a boolean')
    assert.deepEqual(saved.json.value.frontmatter.keywords, ['青云', '鹤鸣', '山门'])

    // A cleared field deletes its line instead of leaving `key:` behind.
    const cleared = await saveCall(harness, {
      kind: 'world',
      id: 'world-qingyun',
      frontmatter: { keywords: [], priority: null },
      expected: saved.json.value.fingerprint,
    })
    assert.equal(cleared.status, 200, JSON.stringify(cleared.json))
    const after = readFileText(root, WORLD)
    assert.equal(after.includes('keywords:'), false, 'an empty list deletes the key')
    assert.equal(after.includes('priority:'), false, 'a null deletes the key')
    assert.ok(after.includes('always: true'), 'the keys the author kept are untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7. The index agrees with the file after a save
// ---------------------------------------------------------------------------

test('library save: the rebuilt index answers with the new value', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    // Warm the index so the tree answers before the save.
    const treeBefore = await internalCall(harness, '/library')
    assert.equal(treeBefore.json.ok, true)
    const fingerprint = await fingerprintOf(harness, 'characters', 'char-shen')

    const saved = await saveCall(harness, {
      kind: 'characters',
      id: 'char-shen',
      frontmatter: { aliases: ['阿青', '青妹', '沈姑娘'], name: '沈青' },
      expected: fingerprint,
    })
    assert.equal(saved.status, 200, JSON.stringify(saved.json))
    assert.equal(saved.json.value.indexRebuilt, true)
    assert.equal(saved.json.value.indexError, undefined)

    const tree = await internalCall(harness, '/library')
    const characters = tree.json.value.kinds.find((group) => group.kind === 'characters')
    const shen = characters.items.find((item) => item.id === 'char-shen')
    assert.ok(shen, 'the entity is still addressable by its id after the save')
    assert.deepEqual(shen.aliases, undefined, 'the tree row is a projection: aliases live in the detail')
    assert.equal(shen.title, '沈青')

    // `listEntities` (through the same index) sees the new alias set.
    const detail = await internalCall(harness, '/library/item?kind=characters&id=char-shen')
    assert.equal(detail.json.value.entity.aliases.join('、'), '阿青、青妹、沈姑娘')
    assert.equal(detail.json.value.fingerprint.sha256, saved.json.value.fingerprint.sha256)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 8. Request-shape refusals the client can hit
// ---------------------------------------------------------------------------

test('library save: missing or unusable request fields are structured 400s', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })
    const fingerprint = await fingerprintOf(harness, 'characters', 'char-shen')
    const before = hashTruth(root)

    const noKind = await saveCall(harness, { id: 'char-shen', frontmatter: { role: 'x' }, expected: fingerprint })
    assert.equal(noKind.status, 400)
    assert.equal(noKind.json.error.code, 'KIND_REQUIRED')

    const badKind = await saveCall(harness, { kind: 'chapters', id: 'ch-1', frontmatter: { role: 'x' }, expected: fingerprint })
    assert.equal(badKind.status, 400)
    assert.equal(badKind.json.error.code, 'KIND_INVALID')
    assert.ok(badKind.json.error.allowed.includes('characters'))

    const noId = await saveCall(harness, { kind: 'characters', frontmatter: { role: 'x' }, expected: fingerprint })
    assert.equal(noId.status, 400)
    assert.equal(noId.json.error.code, 'ID_REQUIRED')

    const noExpected = await saveCall(harness, { kind: 'characters', id: 'char-shen', frontmatter: { role: 'x' } })
    assert.equal(noExpected.status, 400)
    assert.equal(noExpected.json.error.code, 'EXPECTED_REQUIRED', 'this route has no overwrite button')

    const emptyExpected = await saveCall(harness, {
      kind: 'characters',
      id: 'char-shen',
      frontmatter: { role: 'x' },
      expected: {},
    })
    assert.equal(emptyExpected.status, 400)
    assert.equal(emptyExpected.json.error.code, 'EXPECTED_REQUIRED', 'an empty baseline cannot detect a change')

    const notUtf8 = await saveCall(harness, {
      kind: 'characters',
      id: 'char-shen',
      body: '半个代理对 \ud800',
      expected: fingerprint,
    })
    assert.equal(notUtf8.status, 400)
    assert.equal(notUtf8.json.error.code, 'BODY_INVALID')

    const notObject = await saveCall(harness, {
      kind: 'characters',
      id: 'char-shen',
      frontmatter: ['role'],
      expected: fingerprint,
    })
    assert.equal(notObject.status, 400)
    assert.equal(notObject.json.error.code, 'FRONTMATTER_INVALID')

    const nested = await saveCall(harness, {
      kind: 'characters',
      id: 'char-shen',
      frontmatter: { origin: { projectId: 'p-1' } },
      expected: fingerprint,
    })
    assert.equal(nested.status, 400)
    assert.equal(nested.json.error.code, 'FRONTMATTER_VALUE_INVALID', 'a nested mapping cannot be represented')

    const nothing = await saveCall(harness, { kind: 'characters', id: 'char-shen', expected: fingerprint })
    assert.equal(nothing.status, 400)
    assert.equal(nothing.json.error.code, 'EMPTY_UPDATE')

    assert.equal(hashTruth(root), before, 'no refused request may touch the book')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 9. The client half: the editor exists and the model knows the field sets
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url)

async function loadLibraryModel() {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client/library-model.ts')],
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

const model = await loadLibraryModel()

test('library editor: the built client bundle saves through the write route and never auto-overwrites', () => {
  const bundle = join(ROOT, 'lib', 'client.js')
  assert.ok(existsSync(bundle), 'lib/client.js is missing: run `pnpm run build` first')
  const text = readFileSync(bundle, 'utf8')
  assert.ok(text.includes('/library/item'), 'the save goes to the library item route')
  assert.ok(text.includes('FILE_CHANGED'), 'a 409 must be recognised by name')
  for (const marker of ['文件已被改动', '重新加载', '编辑']) {
    assert.ok(text.includes(marker), `the editor must be able to say ${marker}`)
  }
  // The save carries a real baseline, never an unchecked write.
  for (const marker of ['expected', 'sha256']) assert.ok(text.includes(marker), `the save carries ${marker}`)
})

test('library editor: the field set per kind, unknown keys kept aside, payload only carries the edits', () => {
  const characterFields = model.fieldsForKind('characters').map((field) => field.key)
  assert.deepEqual(characterFields, ['name', 'aliases', 'group', 'role', 'pov', 'firstAppearance', 'voice'])
  assert.deepEqual(model.fieldsForKind('world').map((field) => field.key), ['title', 'category', 'parent', 'keywords', 'always', 'priority'])
  assert.deepEqual(model.fieldsForKind('outlines').map((field) => field.key), ['kind', 'title', 'parent', 'order'])
  assert.deepEqual(model.fieldsForKind('relations').map((field) => field.key), ['source', 'target', 'dir', 'since', 'until', 'chapter'])
  assert.deepEqual(model.fieldsForKind('timeline').map((field) => field.key), [
    'title',
    'worldTime',
    'narrativeOrder',
    'chapterId',
    'participants',
    'status',
  ])
  assert.deepEqual(model.fieldsForKind('unknown-kind'), [])

  const frontmatter = {
    id: 'char-shen',
    name: '沈青',
    aliases: ['阿青', '青妹'],
    role: '主角',
    voice: '寡言',
    tags: ['剑修'],
  }
  // The unknown key is displayed, folded, and never written back.
  assert.deepEqual(
    model.unknownFields('characters', frontmatter).map(([key]) => key),
    ['id', 'tags'],
  )

  const draft = model.draftFromItem('characters', frontmatter, '剑不离身。')
  assert.equal(draft.values['aliases'], '阿青\n青妹', 'a list is edited one item per line')
  assert.equal(draft.values['role'], '主角')
  assert.equal(draft.body, '剑不离身。')
  // Nothing edited: nothing to send (a save must not rewrite untouched lines).
  assert.equal(model.draftPayload('characters', draft, frontmatter, '剑不离身。'), null)

  const edited = { ...draft, values: { ...draft.values, role: '反派', aliases: '阿青\n沈姑娘' } }
  const payload = model.draftPayload('characters', edited, frontmatter, '剑不离身。')
  assert.deepEqual(payload, { frontmatter: { role: '反派', aliases: ['阿青', '沈姑娘'] } })
  assert.equal('body' in payload, false, 'an untouched body is not resent')

  // Clearing a field is a delete (`null`), clearing a list is `[]`.
  const cleared = { ...draft, values: { ...draft.values, role: '', voice: '', aliases: '' } }
  assert.deepEqual(model.draftPayload('characters', cleared, frontmatter, '剑不离身。'), {
    frontmatter: { role: null, voice: null, aliases: [] },
  })

  // Numbers and booleans keep their types in the payload.
  const worldDraft = model.draftFromItem('world', { title: '青云山', always: false, priority: 2 }, '')
  assert.equal(worldDraft.values['always'], 'false', 'a boolean is a checkbox, not free text')
  const worldPayload = model.draftPayload(
    'world',
    { ...worldDraft, values: { ...worldDraft.values, always: 'true', priority: '7' } },
    { title: '青云山', always: false, priority: 2 },
    '',
  )
  assert.deepEqual(worldPayload, { frontmatter: { always: true, priority: 7 } })

  // The CAS baseline the editor sends is the one the detail route published.
  assert.equal(model.fingerprintOf({ fingerprint: { size: 1, mtimeMs: 2, sha256: 'c'.repeat(64) } }).sha256, 'c'.repeat(64))
  assert.equal(model.fingerprintOf({ fingerprint: null }), null)
})
