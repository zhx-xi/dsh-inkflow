/**
 * Contract tests for the files-first architecture (ADR-0005).
 *
 * They run against the BUILT artifacts (lib/index.js) with no DSH process:
 * a fake Cordis context records registrations, and every scenario scaffolds a
 * throwaway project directory. The browser half is covered by the manual
 * install check.
 *
 * Run: pnpm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse as parsePath } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { INDEX_SCHEMA_VERSION, apply, inject, name } from '../lib/index.js'

// ADR-0006 D1: nine content directories plus the derived index/, each with a
// `.gitkeep` (git does not track empty directories).
const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const INDEX_DIR = 'index'
const ALL_DIRS = [...CONTENT_DIRS, INDEX_DIR]
const KEEP = '.gitkeep'
const ROOT_META_NAME = 'inkflow.json'

function createHarness(workspace) {
  const tools = new Map()
  const routes = []
  const logs = []
  const disposes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const ctx = {
    effect(setup) {
      const dispose = setup()
      disposes.push(() => {
        if (typeof dispose === 'function') dispose()
      })
      return () => {}
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    get(name) {
      // The session workspace is the only trust anchor for path scope, so tests
      // fake it explicitly instead of mutating process.cwd() (which would leak
      // across tests). Without it the code degrades to process.cwd().
      if (name === 'workingDirectory' && typeof workspace === 'string') {
        return { ensure: async () => workspace }
      }
      return undefined
    },
    logger() {
      return {
        debug() {},
        info(message) {
          logs.push(String(message))
        },
        warn(message) {
          logs.push(String(message))
        },
        error(message) {
          logs.push(String(message))
        },
      }
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    webServer,
  }
  return { ctx, tools, routes, logs, webServer }
}

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-contract-'))
}

function scaffold(root, { git = true, dirs = ALL_DIRS, keeps = true, title = '测试之书', meta = true } = {}) {
  mkdirSync(root, { recursive: true })
  if (git) mkdirSync(join(root, '.git'))
  for (const dir of dirs) {
    mkdirSync(join(root, dir), { recursive: true })
    if (keeps) writeFileSync(join(root, dir, KEEP), '', 'utf8')
  }
  if (meta) {
    writeFileSync(
      join(root, 'inkflow.json'),
      `${JSON.stringify({ schemaVersion: 1, title, author: 'tester' }, null, 2)}\n`,
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

function sampleProject(root) {
  scaffold(root)
  writeMarkdown(
    root,
    'chapters/vol-01/0001-开篇.md',
    ['id: ch-1', 'title: 开篇', '# 注释行会被忽略', 'volume: vol-01', 'seq: 1', 'status: final'],
    '他走进白鹤门。',
  )
  writeMarkdown(root, 'chapters/vol-01/0002-夜行.md', [], '夜里风很大。')
  writeMarkdown(root, 'characters/清音.md', ['id: char-1', 'name: 清音', 'group: 门派'], '主角。')
  writeMarkdown(root, 'characters/清音别名.md', ['id: char-2', 'name: "清音"'], '重名。')
  writeMarkdown(root, 'world/门派/白鹤门.md', ['id: w-1', 'title: 白鹤门', 'category: 门派', 'keywords: [白鹤, "鹤鸣剑"]'], '门派条目。')
  writeMarkdown(root, 'outlines/overall.md', ['id: ov', 'kind: overall', 'title: 总纲'], '- 情节点')
  writeMarkdown(root, 'outlines/ch-0001.md', ['id: oc-1', 'kind: chapter', 'title: 第一章细纲', 'parent: ov'], '- 开场')
  writeFileSync(join(root, 'library', '参考.txt'), '资料正文', 'utf8')
}

function makeTools(dataDir, workspace) {
  const harness = createHarness(workspace)
  apply(harness.ctx, { dataDir })
  return harness
}

async function callTool(harness, toolName, args) {
  const tool = harness.tools.get(toolName)
  assert.ok(tool, `tool ${toolName} must be registered`)
  // A real call always comes from a session; passing the agent makes the fake
  // workingDirectory service reachable (see createHarness).
  return tool.execute(args, { signal: AbortSignal.timeout(5000), agent: { id: 'test-session' } })
}

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

function fakeRequest({ url, method = 'GET', host = '127.0.0.1:2149', origin }) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  return { url, method, headers }
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
  return { status: response.statusCode, headers: response.headers, json: JSON.parse(response.body) }
}

test('plugin exports the Cordis Host shape', () => {
  assert.equal(name, 'dsh-inkflow')
  assert.deepEqual(inject, ['tools'])
  assert.equal(typeof apply, 'function')
})

test('registers the twenty-one built-ins, the tools of every registered domain, and one prefix route', () => {
  const dir = workdir()
  try {
    const harness = makeTools(join(dir, 'plugin-state'))
    // Built-ins first (imported by `tools.ts`), then whatever `DOMAIN_MODULES`
    // declares (roadmap §2.1 X-5): #26 adds the two world tools, #27 the two
    // relation tools. An unexpected entry here means a domain was wired without
    // extending this baseline.
    assert.deepEqual([...harness.tools.keys()].sort(), [
      // Built-ins in `tools.ts`…
      'inkflow_chapter_create',
      'inkflow_chapter_delete',
      'inkflow_chapter_list',
      'inkflow_chapter_move',
      'inkflow_chapter_search',
      'inkflow_chapter_write',
      // …plus the tools a domain module publishes through `tools()` (#25). A new
      // domain adds its names here, which is the point: the shipped surface stays
      // an explicit list instead of whatever happens to be registered.
      'inkflow_character_list',
      'inkflow_character_upsert',
      // #32: the fact ledger's three tools (append / snapshot / list).
      'inkflow_facts_append',
      'inkflow_facts_list',
      'inkflow_facts_snapshot',
      // #31: the foreshadowing domain's own tools, contributed through `domainTools()`.
      'inkflow_foreshadow_list',
      'inkflow_foreshadow_upsert',
      'inkflow_index_rebuild',
      // #37: importing an old manuscript, built-in for the same reason as the audit — it
      // writes chapters *and* a `library/` copy, so no single content directory owns it.
      'inkflow_library_import',
      // #24: the outline domain's own tools, contributed through `domainTools()`.
      'inkflow_outline_move',
      'inkflow_outline_tree',
      'inkflow_outline_upsert',
      // #33: the consistency audit. A built-in and not a domain tool: it aggregates all five
      // families and owns no content directory (roadmap X-14).
      'inkflow_project_audit',
      'inkflow_project_init',
      // #36: the maintenance pair (repair / migrate), built-ins in tools.ts.
      'inkflow_project_migrate',
      'inkflow_project_plan',
      'inkflow_project_repair',
      'inkflow_project_status',
      'inkflow_relation_list',
      'inkflow_relation_upsert',
      // #39: the single search entry (X-16) and the search-replace batch (X-17), both
      // built-ins — they span every kind and own no content directory.
      'inkflow_search',
      'inkflow_search_replace',
      // #40: the shared library's one read and two writes. Built-ins, not domain
      // tools — the library lives OUTSIDE every book, so no content directory owns
      // it and `domainTools()` cannot contribute it.
      'inkflow_shared_copy',
      'inkflow_shared_list',
      'inkflow_shared_update',
      'inkflow_timeline_list',
      'inkflow_timeline_upsert',
      'inkflow_volume_create',
      'inkflow_volume_rename',
      'inkflow_world_tree',
      'inkflow_world_upsert',
    ])
    assert.equal(harness.routes.length, 1)
    assert.equal(harness.routes[0].kind, 'prefix')
    for (const tool of harness.tools.values()) {
      assert.equal(typeof tool.description, 'string')
      assert.ok(tool.description.length > 40)
      assert.equal(tool.parameters.type, 'object')
      assert.equal(typeof tool.execute, 'function')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gate: a plain directory is rejected with a missing-item checklist', async () => {
  const dir = workdir()
  try {
    const harness = makeTools(join(dir, 'state'), dir)
    const result = await callTool(harness, 'inkflow_project_status', { projectRoot: dir })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'NOT_AN_INKFLOW_PROJECT')
    assert.equal(result.error.state, 'needs-setup')
    assert.ok(result.error.missing.includes('.git'))
    for (const name of CONTENT_DIRS) {
      assert.ok(result.error.missing.includes(name), `missing list should contain ${name}`)
      assert.ok(result.error.missing.includes(`${name}/${KEEP}`), `missing list should contain ${name}/${KEEP}`)
    }
    assert.ok(result.error.missing.includes(ROOT_META_NAME))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gate: git repo missing two directories reports exactly those', async () => {
  const dir = workdir()
  try {
    // A legacy-shaped book: every directory carries .gitkeep, two are missing.
    scaffold(dir, { dirs: ALL_DIRS.filter((name) => name !== 'world' && name !== 'outlines') })
    const harness = makeTools(join(dir, 'state'), dir)
    const result = await callTool(harness, 'inkflow_project_status', { projectRoot: dir })
    assert.equal(result.ok, false)
    assert.equal(result.error.state, 'needs-repair')
    assert.equal(result.error.code, 'PROJECT_NEEDS_REPAIR')
    assert.deepEqual([...result.error.missing].sort(), ['outlines', `outlines/${KEEP}`, 'world', `world/${KEEP}`])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gate: a derived index directory is recreated, never a lockout', async () => {
  const dir = workdir()
  try {
    scaffold(dir, { dirs: CONTENT_DIRS })
    assert.equal(existsSync(join(dir, 'index')), false)
    const harness = makeTools(join(dir, 'state'), dir)
    const result = await callTool(harness, 'inkflow_project_status', { projectRoot: dir })
    assert.equal(result.ok, true)
    assert.equal(result.indexDirRecreated, true)
    assert.equal(existsSync(join(dir, 'index', KEEP)), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('init scaffolds the convention tree, runs git init, and never commits', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '我的新书')
    const harness = makeTools(join(dir, 'state'), dir)
    // ADR-0006 D3: apply always runs after an explicit confirmation.
    const blocked = await callTool(harness, 'inkflow_project_init', { root, title: '新书' })
    assert.equal(blocked.requiresConfirmation, true)
    assert.equal(existsSync(root), false)

    const result = await callTool(harness, 'inkflow_project_init', { root, title: '新书', author: '作者', confirm: true })
    assert.equal(result.ok, true)
    assert.equal(result.state, 'usable')
    assert.equal(result.gitInit, 'created')
    assert.equal(existsSync(join(root, '.git')), true)
    for (const sub of ALL_DIRS) {
      assert.ok(existsSync(join(root, sub)), `${sub}/ should exist`)
      assert.ok(existsSync(join(root, sub, KEEP)), `${sub}/${KEEP} should exist`)
    }
    const meta = JSON.parse(readFileSync(join(root, 'inkflow.json'), 'utf8'))
    assert.equal(meta.title, '新书')
    assert.equal(meta.schemaVersion, 1)
    assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /index\/\*\.db/)

    const status = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    assert.equal(status.ok, true)
    assert.equal(status.label, '新书')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('index rebuild: counts, chapter order, word count, invariant issues', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleProject(root)
    const harness = makeTools(join(dir, 'state'), dir)
    const result = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })

    assert.equal(result.ok, true)
    assert.equal(result.counts.chapters, 2)
    assert.equal(result.counts.characters, 2)
    assert.equal(result.counts.worldEntries, 1)
    assert.equal(result.counts.outlineNodes, 2)
    assert.equal(result.counts.libraryFiles, 1)
    assert.ok(result.issues.some((issue) => issue.code === 'CHARACTER_NAME_DUPLICATE'))

    const list = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root })
    assert.equal(list.ok, true)
    assert.equal(list.indexRebuilt, false)
    assert.deepEqual(
      list.chapters.map((chapter) => chapter.seq),
      [1, 2],
    )
    assert.equal(list.chapters[0].title, '开篇')
    assert.equal(list.chapters[0].status, 'final')
    assert.equal(list.chapters[0].wordCount, 7) // 他走进白鹤门。 -> 7 non-space chars
    assert.equal(list.chapters[1].status, 'draft') // default
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('index is a cache: a foreign schema version is rebuilt automatically', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    writeMarkdown(root, 'chapters/0001-甲.md', ['id: c1', 'seq: 1'], '一二三')
    const harness = makeTools(join(dir, 'state'), dir)
    await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })

    // Simulate an old/new index built by a different plugin version.
    const db = new DatabaseSync(join(root, 'index', 'inkflow.db'))
    db.exec('PRAGMA user_version = 999')
    db.close()

    const list = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root })
    assert.equal(list.ok, true)
    assert.equal(list.indexRebuilt, true)
    assert.equal(list.chapters.length, 1)

    const after = new DatabaseSync(join(root, 'index', 'inkflow.db'), { readOnly: true })
    const version = after.prepare('PRAGMA user_version').get()
    assert.equal(version.user_version, INDEX_SCHEMA_VERSION)
    after.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('invariants: missing overall outline and volume-in-volume are reported', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    writeMarkdown(root, 'outlines/vol-01.md', ['id: v1', 'kind: volume', 'title: 卷一', 'parent: ov'], '- 卷一')
    writeMarkdown(root, 'outlines/vol-02.md', ['id: v2', 'kind: volume', 'title: 卷二', 'parent: v1'], '- 卷二')
    const harness = makeTools(join(dir, 'state'), dir)
    const result = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
    const codes = new Set(result.issues.map((issue) => issue.code))
    assert.ok(codes.has('OUTLINE_NO_OVERALL'))
    assert.ok(codes.has('OUTLINE_VOLUME_IN_VOLUME'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('http: loopback only, no path parameter, and it never guesses a project', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    // No index/ yet: the OLD code called inspectProject(?root=) here, which
    // creates index/ inside whatever directory the query string named.
    scaffold(root, { dirs: CONTENT_DIRS })
    writeMarkdown(root, 'chapters/0001-甲.md', ['id: c1', 'seq: 1', 'title: 开篇'], '正文正文')
    const stateDir = join(dir, 'state')
    const harness = makeTools(stateDir, dir)

    // A session may touch the project; that populates state.json (display only).
    const touched = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    assert.equal(touched.ok, true)
    assert.equal(existsSync(join(stateDir, 'state.json')), true)

    // Drop the derived index the tool just recreated: if the route handler ever
    // inspects a query-string path again, index/ reappears and the hash moves.
    rmSync(join(root, 'index'), { recursive: true, force: true })
    const before = hashTree(root)
    // A path parameter is refused before any filesystem access (ADR-0008 D4),
    // so neither route may read the book the query names.
    const status = await callRoute(
      harness,
      fakeRequest({ url: `/inkflow/internal/status?root=${encodeURIComponent(root)}` }),
    )
    const chapters = await callRoute(
      harness,
      fakeRequest({ url: `/inkflow/internal/chapters?root=${encodeURIComponent(root)}` }),
    )

    assert.equal(status.status, 400)
    assert.equal(status.json.ok, false)
    assert.equal(status.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')
    assert.equal(status.headers['cache-control'], 'no-store')
    assert.equal(chapters.status, 400)
    assert.equal(chapters.json.ok, false)
    assert.equal(chapters.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')

    // Neither the query string nor the remembered state may leak into the body.
    assert.equal(JSON.stringify(status.json).includes(root), false)
    assert.equal(JSON.stringify(chapters.json).includes(root), false)
    // and the target directory must be byte-for-byte untouched (no index/).
    assert.equal(hashTree(root), before)
    assert.equal(existsSync(join(root, 'index')), false)

    const rebind = await callRoute(harness, fakeRequest({ url: '/inkflow/internal/status', host: 'evil.example.com' }))
    assert.equal(rebind.status, 403)
    assert.equal(rebind.json.error.code, 'forbidden-host')

    const crossSite = await callRoute(harness, fakeRequest({ url: '/inkflow/internal/status', origin: 'https://evil.example.com' }))
    assert.equal(crossSite.status, 403)

    const sameOrigin = await callRoute(harness, fakeRequest({ url: '/inkflow/internal/status', origin: 'http://127.0.0.1:2149' }))
    assert.equal(sameOrigin.status, 200)
    assert.equal(sameOrigin.json.error.code, 'NO_SESSION_CONTEXT')

    const post = await callRoute(harness, fakeRequest({ url: '/inkflow/internal/status', method: 'POST' }))
    assert.equal(post.status, 405)

    const missing = await callRoute(harness, fakeRequest({ url: '/inkflow/internal/nope' }))
    assert.equal(missing.status, 404)

    // The old public prefix never was a contract: no alias survives (ADR-0008 D3).
    for (const legacy of ['/inkflow/api/status', '/inkflow/api/chapters']) {
      const gone = await callRoute(harness, fakeRequest({ url: legacy }))
      assert.equal(gone.status, 404, `${legacy} must be gone`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('http: the internal channel refuses a request that names no session', async () => {
  const dir = workdir()
  try {
    const harness = makeTools(join(dir, 'state'), dir)
    // No sessionId: the channel cannot name a book, and it must say so instead
    // of falling back to the plugin state file (ADR-0008 D4).
    const status = await callRoute(harness, fakeRequest({ url: '/inkflow/internal/status' }))
    assert.equal(status.status, 200)
    assert.equal(status.json.ok, false)
    assert.equal(status.json.error.code, 'NO_SESSION_CONTEXT')
    const chapters = await callRoute(harness, fakeRequest({ url: '/inkflow/internal/chapters' }))
    assert.equal(chapters.status, 200)
    assert.equal(chapters.json.error.code, 'NO_SESSION_CONTEXT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('frontmatter parsing survives the awkward forms used by hand-written files', async () => {  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    writeMarkdown(
      root,
      'chapters/0001-甲.md',
      [
        'id: c1',
        'title: "引号标题, 带逗号"',
        'seq: 1',
        'status: revised',
        '# 注释',
        'aliases:',
        '  - 甲',
        '  - 乙',
        'keywords: [白鹤, \'鹤鸣剑\']',
      ],
      '正文',
    )
    const harness = makeTools(join(dir, 'state'), dir)
    const list = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root })
    assert.equal(list.ok, true)
    assert.equal(list.chapters[0].title, '引号标题, 带逗号')
    assert.equal(list.chapters[0].status, 'revised')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * Regression for issue #3: a chapter id collision aborted the rebuild with a
 * UNIQUE constraint error, so the index was left half-built and every later
 * read (and every retry) failed. Duplicate ids are a *data* problem: the
 * rebuild must keep the first file, report DUPLICATE_ID, and stay usable.
 */
test('bugs: ids 001 and 1 are two distinct chapters, not a UNIQUE crash', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    // `id: 001` used to be parsed as the number 1, colliding with `id: 1`.
    writeMarkdown(root, 'chapters/vol-01/0001-甲.md', ['id: 001', 'seq: 5', 'title: 甲'], '正文一')
    writeMarkdown(root, 'chapters/vol-01/0002-乙.md', ['id: 1', 'seq: 6', 'title: 乙'], '正文二')
    const harness = makeTools(join(dir, 'state'), dir)

    const rebuild = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
    assert.equal(rebuild.ok, true)
    assert.equal(rebuild.counts.chapters, 2)
    assert.equal(rebuild.issues.some((issue) => issue.code === 'DUPLICATE_ID'), false)

    const list = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root })
    assert.equal(list.ok, true)
    assert.deepEqual(list.chapters.map((chapter) => chapter.id).sort(), ['001', '1'])
    // Numeric literals stay strings, so intField must still read seq as a number.
    assert.deepEqual(list.chapters.map((chapter) => chapter.seq).sort(), [5, 6])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bugs: a copied chapter keeps its id — first file wins, DUPLICATE_ID, list still works', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    writeMarkdown(root, 'chapters/vol-01/0001-甲.md', ['id: dup', 'seq: 1', 'title: 原章'], '正文一')
    // A copy whose id was never changed: same id, different file.
    writeMarkdown(root, 'chapters/vol-01/0002-甲的副本.md', ['id: dup', 'seq: 2', 'title: 副本'], '正文二')
    const harness = makeTools(join(dir, 'state'), dir)

    // The lazy rebuild inside chapter_list is the path that used to throw on
    // every call, because no index could ever be built.
    const list = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root })
    assert.equal(list.ok, true)
    assert.equal(list.total, 1)
    assert.equal(list.chapters[0].title, '原章')

    const rebuild = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
    assert.equal(rebuild.ok, true)
    assert.equal(rebuild.counts.chapters, 1)
    // status counts index rows, so it must agree with what the rebuild wrote.
    const status = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    assert.equal(status.index.counts.chapters, 1)
    const duplicate = rebuild.issues.find((issue) => issue.code === 'DUPLICATE_ID')
    assert.ok(duplicate, 'DUPLICATE_ID must be reported')
    assert.equal(duplicate.path, 'chapters/vol-01/0002-甲的副本.md')
    assert.match(duplicate.detail, /chapters\/vol-01\/0001-甲\.md/)

    // Rebuilding again must keep the same file: "first" is the path order, not
    // whatever order readdir happened to return.
    const again = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root })
    assert.equal(again.total, 1)
    assert.equal(again.chapters[0].path, 'chapters/vol-01/0001-甲.md')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('bugs: the same id in two tables is reported but neither row is dropped', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    writeMarkdown(root, 'chapters/0001-甲.md', ['id: shared', 'seq: 1'], '正文')
    writeMarkdown(root, 'outlines/overall.md', ['id: shared', 'kind: overall', 'title: 总纲'], '- 情节点')
    const harness = makeTools(join(dir, 'state'), dir)
    const rebuild = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
    assert.equal(rebuild.ok, true)
    assert.ok(rebuild.issues.some((issue) => issue.code === 'DUPLICATE_ID'))
    // Separate tables, separate primary keys: only same-table collisions drop a row.
    assert.equal(rebuild.counts.chapters, 1)
    assert.equal(rebuild.counts.outlineNodes, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a UTF-8 BOM in inkflow.json does not break the gate', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root, { meta: false })
    writeFileSync(join(root, 'inkflow.json'), '\uFEFF' + JSON.stringify({ schemaVersion: 1, title: '带 BOM 的书' }), 'utf8')
    const harness = makeTools(join(dir, 'state'), dir)
    const result = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    assert.equal(result.ok, true)
    assert.equal(result.label, '带 BOM 的书')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Issue #7 — identity and scope hardening
// ---------------------------------------------------------------------------

test('identity: a session outside a project never answers for a remembered book', async () => {
  const dir = workdir()
  try {
    const bookA = join(dir, 'book-a')
    sampleProject(bookA)
    // The session sits in book-a's PARENT directory, which is not itself a
    // project: this used to fall back to state.lastProjectRoot and return
    // book-a with ok:true (issue #7).
    const stateDir = join(dir, 'state')

    const first = makeTools(stateDir, dir)
    const touched = await callTool(first, 'inkflow_project_status', { projectRoot: bookA })
    assert.equal(touched.ok, true)
    assert.equal(existsSync(join(stateDir, 'state.json')), true)

    const second = makeTools(stateDir, dir)
    const status = await callTool(second, 'inkflow_project_status', {})
    assert.equal(status.ok, false)
    assert.equal(status.error.code, 'NOT_AN_INKFLOW_PROJECT')
    assert.equal(status.error.needsSetup, true)
    assert.equal(realpathSync.native(status.error.root), realpathSync.native(dir))
    assert.notEqual(realpathSync.native(status.error.root), realpathSync.native(bookA))
    assert.ok(status.error.missing.includes('.git'))
    assert.ok(Array.isArray(status.error.reasons))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scope: a projectRoot outside the session workspace is rejected untouched', async () => {
  const inside = workdir()
  const outside = workdir()
  try {
    const outsideBook = join(outside, 'book')
    scaffold(outsideBook, { dirs: ['chapters', 'characters', 'world', 'outlines', 'library'] })
    const harness = makeTools(join(inside, 'state'), inside)

    const before = statSync(outsideBook).mtimeMs
    const status = await callTool(harness, 'inkflow_project_status', { projectRoot: outsideBook })
    assert.equal(status.ok, false)
    assert.equal(status.error.code, 'PATH_OUT_OF_SCOPE')
    // Windows CI exposes the temp dir through an 8.3 short name (RUNNER~1); the
    // guard returns the real path, so compare resolved forms on both sides.
    assert.equal(realpathSync.native(status.error.root), realpathSync.native(outsideBook))
    // The derived index directory is the observable side effect of the old code.
    assert.equal(existsSync(join(outsideBook, 'index')), false)
    assert.equal(statSync(outsideBook).mtimeMs, before)

    const rebuild = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: outsideBook })
    assert.equal(rebuild.error.code, 'PATH_OUT_OF_SCOPE')

    const init = await callTool(harness, 'inkflow_project_init', { root: join(outside, 'new-book'), title: '越界' })
    assert.equal(init.ok, false)
    assert.equal(init.error.code, 'PATH_OUT_OF_SCOPE')
    assert.equal(existsSync(join(outside, 'new-book')), false)

    // A drive/volume root is refused even though it is "an existing directory".
    // Read-only call: if the guard regressed, inspectProject still writes nothing
    // there unless the root happens to be a full InkFlow project.
    const driveRoot = parsePath(inside).root
    const atRoot = await callTool(harness, 'inkflow_project_status', { projectRoot: driveRoot })
    assert.equal(atRoot.ok, false)
    assert.equal(atRoot.error.code, 'PATH_FORBIDDEN')
  } finally {
    rmSync(inside, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('scope: the user home directory itself is refused as a project root', async () => {
  const dir = workdir()
  const previousHome = process.env['HOME']
  const previousProfile = process.env['USERPROFILE']
  try {
    const fakeHome = join(dir, 'home')
    mkdirSync(fakeHome, { recursive: true })
    // The plugin reads HOME first (POSIX) then USERPROFILE (Windows), so set both
    // to exercise the real "no scaffolding in your home directory" rule.
    process.env['HOME'] = fakeHome
    process.env['USERPROFILE'] = fakeHome
    const harness = makeTools(join(dir, 'state'), dir)
    const result = await callTool(harness, 'inkflow_project_init', { root: fakeHome, title: '放家里' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'PATH_FORBIDDEN')
    assert.deepEqual(readdirSync(fakeHome), [])
  } finally {
    if (previousHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = previousHome
    if (previousProfile === undefined) delete process.env['USERPROFILE']
    else process.env['USERPROFILE'] = previousProfile
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scope: a path inside an install directory is refused even within the workspace', async () => {
  const dir = workdir()
  const previous = process.env['ProgramFiles']
  try {
    const fakeInstall = join(dir, 'FakeProgramFiles')
    const target = join(fakeInstall, 'novel')
    mkdirSync(target, { recursive: true })
    process.env['ProgramFiles'] = fakeInstall
    const harness = makeTools(join(dir, 'state'), dir)
    const result = await callTool(harness, 'inkflow_project_init', { root: target, title: '装进安装目录' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'PATH_FORBIDDEN')
    assert.deepEqual(readdirSync(target), []) // zero writes
  } finally {
    if (previous === undefined) delete process.env['ProgramFiles']
    else process.env['ProgramFiles'] = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('init: a non-empty directory without inkflow.json requires confirmation and writes nothing', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '已有内容的目录')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, '草稿.txt'), '不能被覆盖\n', 'utf8')
    mkdirSync(join(root, 'chapters'))
    const harness = makeTools(join(dir, 'state'), dir)

    const before = hashTree(root)
    const blocked = await callTool(harness, 'inkflow_project_init', { root, title: '旧稿整理' })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.requiresConfirmation, true)
    assert.equal(blocked.error.code, 'INIT_REQUIRES_CONFIRMATION')
    assert.deepEqual(blocked.existing, ['chapters', '草稿.txt'])
    assert.ok(blocked.willCreate.some((path) => path.endsWith('inkflow.json')))
    assert.ok(blocked.willCreate.some((path) => path.endsWith('characters')))
    assert.equal(blocked.willCreate.some((path) => /[\\/]chapters$/.test(path)), false) // already there
    // Zero writes: no directory, file or mtime change.
    assert.equal(hashTree(root), before)
    assert.equal(existsSync(join(root, 'inkflow.json')), false)
    assert.equal(existsSync(join(root, 'index')), false)

    const confirmed = await callTool(harness, 'inkflow_project_init', { root, title: '旧稿整理', confirm: true })
    assert.equal(confirmed.ok, true) // git init ran: the directory is a project now
    assert.equal(confirmed.error, undefined)
    for (const sub of ALL_DIRS) {
      assert.ok(existsSync(join(root, sub)), `${sub}/ should exist`)
      assert.ok(existsSync(join(root, sub, KEEP)), `${sub}/${KEEP} should exist`)
    }
    assert.equal(readFileSync(join(root, '草稿.txt'), 'utf8'), '不能被覆盖\n')
    assert.equal(JSON.parse(readFileSync(join(root, 'inkflow.json'), 'utf8')).title, '旧稿整理')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('init: even an empty directory needs exactly one confirmation round', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '空目录')
    mkdirSync(root)
    const harness = makeTools(join(dir, 'state'), dir)
    const blocked = await callTool(harness, 'inkflow_project_init', { root, title: '新书' })
    // ADR-0006 D3: apply is confirmed, not implicit — even with nothing to lose.
    assert.equal(blocked.requiresConfirmation, true)
    assert.equal(existsSync(join(root, 'inkflow.json')), false)
    const result = await callTool(harness, 'inkflow_project_init', { root, title: '新书', confirm: true })
    assert.equal(result.ok, true)
    assert.equal(existsSync(join(root, 'inkflow.json')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('index: volume comes from a real volume directory, never from chapters/', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    writeMarkdown(root, 'chapters/0001-顶层.md', ['id: c1', 'seq: 1', 'title: 顶层'], '正文')
    writeMarkdown(root, 'chapters/vol-01/0002-入卷.md', ['id: c2', 'seq: 2', 'title: 入卷'], '正文')
    writeMarkdown(root, 'chapters/0003-显式.md', ['id: c3', 'seq: 3', 'title: 显式', 'volume: vol-09'], '正文')
    const harness = makeTools(join(dir, 'state'), dir)
    const list = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root })
    assert.equal(list.ok, true)
    const byId = new Map(list.chapters.map((chapter) => [chapter.id, chapter]))
    assert.equal(byId.get('c1').volume, null) // used to be "chapters"
    assert.equal(byId.get('c2').volume, 'vol-01')
    assert.equal(byId.get('c3').volume, 'vol-09') // frontmatter still wins
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
