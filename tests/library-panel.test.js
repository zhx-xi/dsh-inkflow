/**
 * Contract tests for the setting-library tab (roadmap X-7 / X-8).
 *
 * Two halves, both of which must FAIL when the panel is wired wrong:
 *
 *   1. HOST, against the BUILT artifact `lib/index.js` — the three new read
 *      routes (`/library`, `/library/item`, `/library/issues`) are driven through
 *      the same fake Cordis context + fake request/response pair the other
 *      channel tests use, so the guards they inherit are exercised for real:
 *      a missing session, a path parameter, a non-GET verb and a cross-site
 *      `Origin` each get their own refusal, and a successful tree call writes
 *      nothing outside `index/`.
 *   2. CLIENT, against `src/client/library-model.ts` bundled on the fly — the
 *      pure view model: the eight-kind tree, `world` grouped by `category`
 *      (X-7: 地点 is a bucket, not a kind) and `validation_issues` aggregated by
 *      `code`.
 *
 * Run: pnpm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { apply } from '../lib/index.js'

const ROOT = resolve(import.meta.dirname, '..')
const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const ALL_DIRS = [...CONTENT_DIRS, 'index']
const KEEP = '.gitkeep'
const HOST = '127.0.0.1:2149'
const INTERNAL = '/inkflow/internal'

/** X-7: the tree's top level, in `CONTENT_DIRS` order with `chapters` removed. */
const PANEL_KINDS = ['characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']

// ---------------------------------------------------------------------------
// Harness (same shape as internal-channel.test.js / internal-write.test.js)
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
  apply(ctx, { dataDir: join(tmpdir(), 'inkflow-library-state') })
  return { ctx, routes }
}

function fakeRequest({ url, method = 'GET', host = HOST, origin, remoteAddress = '127.0.0.1' } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  return { url, method, headers, socket: { remoteAddress } }
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

function internalCall(harness, path, options = {}) {
  const query = options.sessionId === null ? '' : `sessionId=${encodeURIComponent(options.sessionId ?? 'session-1')}`
  const separator = path.includes('?') ? '&' : '?'
  const url = query === '' ? `${INTERNAL}${path}` : `${INTERNAL}${path}${separator}${query}`
  return callRoute(harness, fakeRequest({ ...options, url }))
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-library-'))
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

/**
 * A book with four published kinds (characters / world / relations / outlines'
 * rows are whatever the domains publish) plus one deliberate inconsistency:
 * `world/地点/青云山.md` names a `parent` that does not exist, which the rebuild
 * records as `DANGLING_PARENT` — the problem panel's own fixture.
 */
function bookProject(root) {
  scaffold(root)
  writeMarkdown(root, 'characters/沈青.md', ['id: char-shen', 'title: 沈青', 'aliases: [阿青]'], '剑不离身。')
  writeMarkdown(root, 'characters/李四.md', ['id: char-li', 'title: 李四'], '善使长枪。')
  writeMarkdown(root, 'world/地点/青云山.md', ['id: world-qingyun', 'title: 青云山', 'parent: char-missing'], '山中有鹤。')
  writeMarkdown(root, 'world/门派/白鹤门.md', ['id: world-baihe', 'title: 白鹤门'], '门规十一条。')
  // Directly under `world/`: no category directory, a real editorial state.
  writeMarkdown(root, 'world/散记.md', ['id: world-notes', 'title: 散记'], '零零散散。')
  writeMarkdown(root, 'relations/师承.md', ['id: rel-1', 'title: 师承', 'source: char-shen', 'target: char-li'], '')
}

/** Stable hash of everything except the derived index (which a read may rebuild). */
function hashTruth(root) {
  const hash = createHash('sha256')
  const walk = (relative) => {
    const dir = relative === '' ? root : join(root, relative)
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (relative === '' && entry.name === 'index') continue
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      const info = statSync(join(root, child))
      hash.update(`${child}|${entry.isDirectory() ? 'd' : 'f'}|${info.size}|${info.mtimeMs}\n`)
      if (entry.isDirectory()) walk(child)
    }
  }
  walk('')
  return hash.digest('hex')
}

// ---------------------------------------------------------------------------
// Client harness: bundle the pure view model on the fly (same trick as
// panel-bundle.test.js — the project's own esbuild, no TS loader dependency)
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

// ---------------------------------------------------------------------------
// 1. GET /library — the eight-kind tree
// ---------------------------------------------------------------------------

test('library: GET /library answers the eight kinds, world grouped by category (X-7)', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const before = hashTruth(root)
    const harness = createHarness({ workspace: root })

    const response = await internalCall(harness, '/library')
    assert.equal(response.status, 200)
    assert.equal(response.json.ok, true)
    const value = response.json.value

    assert.deepEqual(
      value.kinds.map((group) => group.kind),
      PANEL_KINDS,
      'the tree is CONTENT_DIRS minus chapters, in that order (X-7)',
    )
    assert.equal(value.indexAvailable, true, 'the freshly built index answers')
    assert.equal(typeof value.total, 'number')

    const characters = value.kinds.find((group) => group.kind === 'characters')
    assert.deepEqual(
      characters.items.map((item) => item.id).sort(),
      ['char-li', 'char-shen'],
      'every published character row reaches the panel',
    )
    const shen = characters.items.find((item) => item.id === 'char-shen')
    assert.equal(shen.title, '沈青')
    assert.equal(shen.path, 'characters/沈青.md')
    assert.equal(shen.category, null, 'a character has no category')

    const world = value.kinds.find((group) => group.kind === 'world')
    assert.equal(world.total, 3)
    const categories = world.categories.map((group) => group.category)
    assert.deepEqual(categories, ['地点', '门派', null], 'named categories in storage order, uncategorised last')
    assert.deepEqual(
      world.categories.map((group) => group.total),
      [1, 1, 1],
    )

    // 地点 is a bucket, never a top-level kind.
    assert.equal(PANEL_KINDS.includes('地点'), false)
    assert.equal(
      value.kinds.some((group) => group.kind === 'chapters'),
      false,
      'the chapter tree belongs to the workbench (M13), not this panel',
    )

    // Empty but declared kinds are still listed: "这一库是空的" is a state.
    for (const kind of ['foreshadowing', 'timeline', 'facts', 'library']) {
      const group = value.kinds.find((entry) => entry.kind === kind)
      assert.equal(group.total, 0)
      assert.deepEqual(group.items, [])
    }

    assert.equal(hashTruth(root), before, 'a read route writes nothing outside index/')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. GET /library/item — one entry, read-only
// ---------------------------------------------------------------------------

test('library: GET /library/item answers the projection row plus the file (frontmatter + body)', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    const world = await internalCall(harness, '/library/item?kind=world&id=world-qingyun')
    assert.equal(world.status, 200)
    assert.equal(world.json.ok, true)
    const value = world.json.value
    assert.equal(value.kind, 'world')
    assert.equal(value.id, 'world-qingyun')
    assert.equal(value.path, 'world/地点/青云山.md')
    assert.equal(value.title, '青云山')
    assert.equal(value.entity.category, '地点', 'the category comes from the directory (X-7)')
    assert.equal(value.readable, true)
    assert.equal(value.hasFrontmatter, true)
    assert.equal(value.frontmatter.title, '青云山')
    assert.equal(value.frontmatter.parent, 'char-missing')
    assert.equal(value.body.trim(), '山中有鹤。')
    assert.equal(value.bodyChars, [...'山中有鹤。'].length)
    // The dangling parent is the file's own recorded problem.
    assert.ok(
      value.validationIssues.some((issue) => issue.code === 'DANGLING_PARENT'),
      `expected DANGLING_PARENT among ${JSON.stringify(value.validationIssues)}`,
    )

    // A character reads through the same route: the kind decides the directory.
    const character = await internalCall(harness, '/library/item?kind=characters&id=char-shen')
    assert.equal(character.status, 200)
    assert.equal(character.json.value.path, 'characters/沈青.md')
    assert.deepEqual(character.json.value.entity.aliases, ['阿青'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('library: an unknown kind is a 400 and an unknown id is a 404', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    const badKind = await internalCall(harness, '/library/item?kind=chapters&id=ch-1')
    assert.equal(badKind.status, 400, 'chapters is not a panel kind (X-7)')
    assert.equal(badKind.json.ok, false)
    assert.equal(badKind.json.error.code, 'KIND_INVALID')
    assert.equal(badKind.json.error.param, 'kind')
    assert.deepEqual(badKind.json.error.allowed, PANEL_KINDS)

    const noKind = await internalCall(harness, '/library/item?id=char-shen')
    assert.equal(noKind.status, 400)
    assert.equal(noKind.json.error.code, 'KIND_REQUIRED')

    const noId = await internalCall(harness, '/library/item?kind=characters')
    assert.equal(noId.status, 400)
    assert.equal(noId.json.error.code, 'ID_REQUIRED')

    const missing = await internalCall(harness, '/library/item?kind=characters&id=char-nope')
    assert.equal(missing.status, 404)
    assert.equal(missing.json.ok, false)
    assert.equal(missing.json.error.code, 'library-item-not-found')
    assert.equal(missing.json.error.kind, 'characters')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. GET /library/issues — the problem panel's list
// ---------------------------------------------------------------------------

test('library: GET /library/issues answers validation_issues with a per-code count', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    const response = await internalCall(harness, '/library/issues')
    assert.equal(response.status, 200)
    assert.equal(response.json.ok, true)
    const value = response.json.value
    assert.equal(value.available, true)
    assert.ok(Array.isArray(value.issues))
    assert.equal(typeof value.countsByCode, 'object')

    const dangling = value.issues.find((issue) => issue.code === 'DANGLING_PARENT')
    assert.ok(dangling, `expected DANGLING_PARENT among ${JSON.stringify(value.issues)}`)
    assert.equal(dangling.path, 'world/地点/青云山.md')
    assert.equal(typeof dangling.detail, 'string')

    const sum = Object.values(value.countsByCode).reduce((total, count) => total + count, 0)
    assert.equal(sum, value.total, 'countsByCode must add up to the returned rows')
    assert.equal(value.total, value.issues.length)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. The inherited guards apply to the three read routes
//
// `/library/item` is also the save route since the second batch (`POST`
// with `frontmatter`/`body`/`expected`), so the "no verb but GET" claim below is
// checked on the two read-only routes, and the item route's write verbs are
// covered by `tests/library-write.test.js` (415/403/405 + the body allowlist).
// What stays true here: no route answers a cross-site Origin, none answers
// without a session, and none accepts a path parameter.
// ---------------------------------------------------------------------------

test('library: the read routes refuse a missing session, a path parameter, an undeclared verb and a cross-site Origin', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    bookProject(root)
    const harness = createHarness({ workspace: root })

    const paths = ['/library', '/library/item?kind=characters&id=char-shen', '/library/issues']

    for (const path of paths) {
      const missing = await internalCall(harness, path, { sessionId: null })
      assert.equal(missing.status, 200, `${path}: no session is "cannot answer yet", not a transport failure`)
      assert.equal(missing.json.ok, false)
      assert.equal(missing.json.error.code, 'NO_SESSION_CONTEXT')

      const crossSite = await internalCall(harness, path, { origin: 'https://evil.example.com' })
      assert.equal(crossSite.status, 403)
      assert.equal(crossSite.json.error.code, 'forbidden-origin')
    }

    for (const path of ['/library', '/library/issues']) {
      const post = await internalCall(harness, path, { method: 'POST' })
      assert.equal(post.status, 405, `${path} must not accept POST`)
      assert.equal(post.json.error.code, 'method-not-allowed')
      assert.equal(post.headers['allow'], 'GET')
    }
    // `/library/item` declares GET and POST: PUT is still an undeclared verb.
    const put = await internalCall(harness, '/library/item?kind=characters&id=char-shen', { method: 'PUT' })
    assert.equal(put.status, 405)
    assert.equal(put.headers['allow'], 'GET, POST')

    // A path parameter is a 400 before any filesystem access (ADR-0008 D4).
    for (const key of ['root', 'path', 'cwd', 'workspace', 'projectRoot']) {
      const refused = await callRoute(
        harness,
        fakeRequest({ url: `${INTERNAL}/library?sessionId=session-1&${key}=${encodeURIComponent(root)}` }),
      )
      assert.equal(refused.status, 400, `?${key}= must be refused on /library`)
      assert.equal(refused.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')
      assert.equal(refused.json.error.param, key)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('library: an unusable project answers the same gate checklist, not an empty tree', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'not-a-book')
    mkdirSync(root, { recursive: true })
    const harness = createHarness({ workspace: root })

    const response = await internalCall(harness, '/library')
    assert.equal(response.status, 200)
    assert.equal(response.json.ok, false)
    assert.ok(
      ['NOT_AN_INKFLOW_PROJECT', 'PROJECT_NEEDS_REPAIR'].includes(response.json.error.code),
      `expected a gate refusal, got ${response.json.error.code}`,
    )
    assert.ok(Array.isArray(response.json.error.missing))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. Client model: the tree (X-7), the world categories, the issue digest
// ---------------------------------------------------------------------------

/** A payload shaped exactly like `GET /library` answers it. */
function libraryPayload() {
  return {
    indexAvailable: true,
    total: 4,
    kinds: [
      {
        kind: 'characters',
        total: 2,
        truncated: false,
        items: [
          { id: 'char-shen', path: 'characters/沈青.md', title: '沈青', category: null, parent: null, status: null },
          { id: 'char-li', path: 'characters/李四.md', title: '李四', category: null, parent: null, status: null },
        ],
      },
      {
        kind: 'world',
        total: 2,
        truncated: false,
        items: [
          { id: 'world-qingyun', path: 'world/地点/青云山.md', title: '青云山', category: '地点', parent: null, status: null },
          { id: 'world-notes', path: 'world/散记.md', title: '散记', category: null, parent: null, status: null },
        ],
        categories: [
          { category: '地点', total: 1, items: [{ id: 'world-qingyun', path: 'world/地点/青云山.md', title: '青云山', category: '地点' }] },
          { category: null, total: 1, items: [{ id: 'world-notes', path: 'world/散记.md', title: '散记', category: null }] },
        ],
      },
      { kind: 'facts', total: 0, truncated: false, items: [] },
    ],
  }
}

test('library-model: buildLibraryTree labels the kinds and keeps empty groups', async () => {
  const model = await loadLibraryModel()
  const tree = model.buildLibraryTree(libraryPayload())

  assert.deepEqual(
    tree.groups.map((group) => group.kind),
    ['characters', 'world', 'facts'],
    'payload order is preserved',
  )
  assert.deepEqual(
    tree.groups.map((group) => group.label),
    ['角色', '世界观', '事实账本'],
  )
  assert.equal(tree.total, 4)
  assert.equal(tree.indexAvailable, true)
  const facts = tree.groups[2]
  assert.equal(facts.total, 0, 'an empty kind stays in the tree')
  assert.deepEqual(facts.items, [])
  assert.deepEqual(facts.categories, [], 'only world carries categories')

  assert.deepEqual(model.buildLibraryTree(null), { groups: [], total: 0, indexAvailable: true })
  assert.equal(model.buildLibraryTree({ kinds: [], indexAvailable: false }).indexAvailable, false)
  assert.equal(model.kindLabel('未知类'), '未知类', 'an unknown kind shows its own name')
})

test('library-model: world groups by category, uncategorised last (X-7)', async () => {
  const model = await loadLibraryModel()
  const tree = model.buildLibraryTree(libraryPayload())
  const world = tree.groups.find((group) => group.kind === 'world')

  assert.deepEqual(
    world.categories.map((group) => group.label),
    ['地点', model.UNCATEGORIZED_LABEL],
  )
  assert.equal(world.categories[0].items[0].kind, 'world', 'every row carries the kind the detail route needs')

  // The same grouping works from rows alone, so a payload without the
  // precomputed `categories` groups correctly too.
  const rows = [
    { kind: 'world', id: 'b', path: 'world/门派/乙.md', title: '乙', category: '门派', parent: null, status: null },
    { kind: 'world', id: 'a', path: 'world/地点/甲.md', title: '甲', category: '地点', parent: null, status: null },
    { kind: 'world', id: 'c', path: 'world/丙.md', title: '丙', category: null, parent: null, status: null },
  ]
  const derived = model.groupByCategory(rows)
  assert.deepEqual(
    derived.map((group) => group.category),
    ['门派', '地点', null],
  )
  assert.deepEqual(
    derived.map((group) => group.total),
    [1, 1, 1],
  )
})

test('library-model: findItemByPath resolves an issue row to the entry it belongs to', async () => {
  const model = await loadLibraryModel()
  const tree = model.buildLibraryTree(libraryPayload())

  const hit = model.findItemByPath(tree, 'world/地点/青云山.md')
  assert.equal(hit.kind, 'world')
  assert.equal(hit.id, 'world-qingyun')
  assert.equal(model.findItemByPath(tree, 'world\\地点\\青云山.md')?.id, 'world-qingyun', 'backslashes are tolerated')
  // A chapter is not in this tree: the problem panel then has no jump target
  // instead of guessing one.
  assert.equal(model.findItemByPath(tree, 'chapters/vol-01/0001-开篇.md'), undefined)
  assert.equal(model.findItemByPath(tree, null), undefined)
})

test('library-model: aggregateIssues groups validation issues by code, biggest first', async () => {
  const model = await loadLibraryModel()
  const digest = model.aggregateIssues({
    available: true,
    total: 4,
    issues: [
      { code: 'DANGLING_PARENT', path: 'world/甲.md', detail: 'parent 指向不存在的实体' },
      { code: 'DUPLICATE_ID', path: 'characters/乙.md', detail: 'id 已被 characters 占用' },
      { code: 'DANGLING_PARENT', path: 'world/丙.md', detail: 'parent 指向不存在的实体' },
      { code: 'UNKNOWN_CODE', path: null, detail: '代码还没起中文名' },
    ],
  })

  assert.equal(digest.total, 4)
  assert.equal(digest.available, true)
  assert.deepEqual(
    digest.groups.map((group) => group.code),
    ['DANGLING_PARENT', 'DUPLICATE_ID', 'UNKNOWN_CODE'],
    'biggest group first, then by code',
  )
  assert.deepEqual(
    digest.groups.map((group) => group.total),
    [2, 1, 1],
  )
  assert.equal(digest.groups[0].label, 'parent 指向不存在的实体')
  assert.equal(digest.groups[2].label, 'UNKNOWN_CODE', 'an unknown code is shown verbatim, never folded away')
  assert.deepEqual(digest.groups[0].items.map((issue) => issue.path), ['world/甲.md', 'world/丙.md'])

  assert.equal(model.describeIssueRow({ code: 'DUPLICATE_ID', path: 'characters/乙.md', detail: '' }), '实体 id 重复 · characters/乙.md')
  assert.equal(model.describeIssueRow({ code: 'DUPLICATE_ID', path: null, detail: '' }), '实体 id 重复')

  // "Cannot answer" and "no problems" are different claims.
  const unavailable = model.aggregateIssues({ available: false, total: 0, issues: [] })
  assert.equal(unavailable.available, false)
  assert.deepEqual(model.aggregateIssues(null), { groups: [], total: 0, truncated: false, available: true })
})

test('library-model: every one of the eight kinds has a label (X-7)', async () => {
  const model = await loadLibraryModel()
  for (const kind of PANEL_KINDS) {
    assert.equal(typeof model.KIND_LABELS[kind], 'string', `${kind} needs a label`)
    assert.notEqual(model.kindLabel(kind), kind, `${kind} must not fall back to its directory name`)
  }
  assert.equal(Object.keys(model.KIND_LABELS).length, PANEL_KINDS.length)
})

test('library-model: the empty states are structured, never a blank pane', async () => {
  const model = await loadLibraryModel()
  for (const kind of ['no-items', 'no-selection', 'no-issues', 'index-unavailable', 'no-projection']) {
    const message = model.LIBRARY_EMPTY[kind]
    assert.ok(message !== undefined, `${kind} must have a card`)
    assert.equal(typeof message.body, 'string')
    assert.ok(message.body.length > 10, `${kind} must say something useful`)
  }
  assert.match(model.LIBRARY_EMPTY['index-unavailable'].body, /不是「书里没有」/)
  assert.match(model.describeLibraryFacts(model.buildLibraryTree(libraryPayload())), /共 4 条/)
})

// ---------------------------------------------------------------------------
// 6. The artifact DSH actually loads carries the tab and its calls
// ---------------------------------------------------------------------------

test('the built client bundle ships the setting-library tab and its three routes', () => {
  // A tab that is declared but never rendered is exactly the "有图标没页面"
  // failure AGENTS.md §8 warns about, and it compiles cleanly. The strings below
  // only reach `lib/client.js` if `index.tsx` really imports the View and the
  // View really calls the routes.
  const text = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  assert.match(text, /设定库/, 'the tab label must be in the bundle')
  assert.match(text, /\/library\/item/, 'the detail route must be called')
  assert.match(text, /\/library\/issues/, 'the problem panel route must be called')
  assert.match(text, /按 code 分组/, 'the problem panel must be rendered')
})

test('library-model: a refusal that carries a size says the size (issue 115)', async () => {
  const model = await loadLibraryModel()
  // The library editor had the same blind spot as the chapter editor: the refusal
  // carried `limitBytes` and the panel showed a bare code at the top of a long form.
  const tooLarge = model.describeSaveError({ code: 'payload-too-large', limitBytes: 1024 * 1024 })
  assert.match(tooLarge, /太长/)
  assert.match(tooLarge, /1\.0 MB/)
  assert.match(tooLarge, /原文没有改动/)
  assert.doesNotMatch(tooLarge, /payload-too-large/)
  assert.match(model.describeSaveError({ code: 'payload-too-large', limitBytes: 96 * 1024 }), /96 KB/)
  // Every other code keeps its own wording: the new branch must not swallow them.
  assert.match(model.describeSaveError({ code: 'FILE_CHANGED' }), /文件已被改动/)
})

// ---------------------------------------------------------------------------
// 7. The editor's two writes (issue 134)
//
// The bug was a UI state hidden inside JSX: 确认改名 was `disabled={busy || dirty ||
// plan === undefined}`, so before 查看影响面 answered it sat there greyed out with no
// explanation, next to the content's 保存 as a second primary button. The decision is
// now a pure function, so the four states can be asserted directly — and the view is
// only allowed to consume it.
// ---------------------------------------------------------------------------

test('library-model: the editor offers one write at a time (issue 134)', async () => {
  const { editorActions } = await loadLibraryModel()

  // 1. Nothing typed yet and no plan: 保存 is the only button, 确认改名 is not rendered
  //    at all, and one sentence says what to do first.
  const fresh = editorActions({ dirty: false, planReady: false })
  assert.deepEqual(fresh, {
    contentSave: 'primary',
    rename: 'hidden',
    contentNote: null,
    renameNote: '先点「查看影响面」确认影响，才能改名。',
  })

  // 2. A dirty draft: the content save stays, the rename block folds into one line.
  const dirty = editorActions({ dirty: true, planReady: false })
  assert.equal(dirty.contentSave, 'primary', 'the draft is still savable')
  assert.equal(dirty.rename, 'blocked', 'the rename is folded away, not merely disabled')
  assert.match(dirty.renameNote, /先保存或放弃/, 'the line says what unblocks it')

  // 3. Dirty AND a plan already fetched: `dirty` wins — the plan itself refuses to run
  //    over an unsaved draft (two writes, same bytes), so the click must not be offered.
  assert.deepEqual(editorActions({ dirty: true, planReady: true }), dirty, 'dirty outranks a fetched plan')

  // 4. A plan and nothing left to save: 确认改名 is the button, 保存 becomes a grey line.
  const ready = editorActions({ dirty: false, planReady: true })
  assert.equal(ready.contentSave, 'muted')
  assert.equal(ready.rename, 'confirm')
  assert.equal(ready.renameNote, null)
  assert.match(ready.contentNote, /用不上/, 'the grey line explains the missing 保存 button')

  // The invariant the whole issue is about: never two primary buttons on the same
  // screen. (The four states above are exhaustive: two booleans, three outcomes.)
  for (const state of [fresh, dirty, ready]) {
    assert.equal(state.contentSave === 'primary' && state.rename === 'confirm', false, 'exactly one write is on offer')
  }
})

test('the library editor renders only the write the state machine offers (issue 134)', () => {
  const source = readFileSync(join(ROOT, 'src/client/library-editor.tsx'), 'utf8')

  // The exact bug, as a guard: 确认改名 greyed out on `dirty` / on a missing plan.
  assert.equal(
    /disabled=\{[^}\n]*(dirty|plan === undefined)[^}\n]*\}/.test(source),
    false,
    '确认改名 must not be a disabled button waiting for state: it is rendered or it is not',
  )
  // 确认改名 is rendered by ONE branch, and that branch is the confirm state.
  assert.equal((source.match(/确认改名/g) ?? []).length, 1, 'one 确认改名 button in the file')
  const confirmAt = source.indexOf('确认改名')
  const confirmGuard = source.lastIndexOf("actions.rename === 'confirm'", confirmAt)
  assert.ok(confirmGuard > 0 && confirmAt - confirmGuard < 400, '确认改名 sits inside the confirm branch')
  // 保存 is rendered by ONE branch too, on the state machine's word — not on `payload`.
  assert.equal((source.match(/actions\.contentSave === 'primary'/g) ?? []).length, 1)
  const saveAt = source.indexOf("saving ? '保存中…' : '保存'")
  assert.ok(source.lastIndexOf("actions.contentSave === 'primary'", saveAt) > 0, '保存 is inside the primary branch')
  // The rename block reads the decision, it does not re-derive it from `dirty`.
  assert.equal(source.includes('dirty={dirty}'), false, 'the rename block takes the state machine, not raw flags')
  assert.equal((source.match(/actions=\{actions\}/g) ?? []).length, 1)
})
