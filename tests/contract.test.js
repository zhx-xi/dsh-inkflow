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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { apply, inject, name } from '../lib/index.js'

const ALL_DIRS = ['chapters', 'characters', 'world', 'outlines', 'index', 'library']

function createHarness() {
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
    get() {
      return undefined // no workingDirectory service: resolution falls back to cwd
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

function scaffold(root, { git = true, dirs = ALL_DIRS, title = '测试之书', meta = true } = {}) {
  mkdirSync(root, { recursive: true })
  if (git) mkdirSync(join(root, '.git'))
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true })
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

function makeTools(dataDir) {
  const harness = createHarness()
  apply(harness.ctx, { dataDir })
  return harness
}

async function callTool(harness, toolName, args) {
  const tool = harness.tools.get(toolName)
  assert.ok(tool, `tool ${toolName} must be registered`)
  return tool.execute(args, { signal: AbortSignal.timeout(5000) })
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

test('registers the four files-first tools and one prefix route', () => {
  const dir = workdir()
  try {
    const harness = makeTools(join(dir, 'plugin-state'))
    assert.deepEqual([...harness.tools.keys()].sort(), [
      'inkflow_chapter_list',
      'inkflow_index_rebuild',
      'inkflow_project_init',
      'inkflow_project_status',
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
    const harness = makeTools(join(dir, 'state'))
    const result = await callTool(harness, 'inkflow_project_status', { projectRoot: dir })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'NOT_AN_INKFLOW_PROJECT')
    for (const item of ['.git', 'chapters', 'characters', 'world', 'outlines', 'library', 'inkflow.json']) {
      assert.ok(result.error.missing.includes(item), `missing list should contain ${item}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gate: git repo missing two directories reports exactly those', async () => {
  const dir = workdir()
  try {
    scaffold(dir, { dirs: ['chapters', 'characters', 'index', 'library'] })
    const harness = makeTools(join(dir, 'state'))
    const result = await callTool(harness, 'inkflow_project_status', { projectRoot: dir })
    assert.equal(result.ok, false)
    assert.deepEqual([...result.error.missing].sort(), ['outlines', 'world'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gate: a derived index directory is recreated, never a lockout', async () => {
  const dir = workdir()
  try {
    scaffold(dir, { dirs: ['chapters', 'characters', 'world', 'outlines', 'library'] })
    assert.equal(existsSync(join(dir, 'index')), false)
    const harness = makeTools(join(dir, 'state'))
    const result = await callTool(harness, 'inkflow_project_status', { projectRoot: dir })
    assert.equal(result.ok, true)
    assert.equal(result.indexDirRecreated, true)
    assert.equal(existsSync(join(dir, 'index', '.gitkeep')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('init scaffolds the convention tree without running git init', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '我的新书')
    const harness = makeTools(join(dir, 'state'))
    const result = await callTool(harness, 'inkflow_project_init', { root, title: '新书', author: '作者' })
    assert.equal(result.gitInitNeeded, true)
    assert.equal(result.ok, false) // not usable until it is a git repository
    for (const sub of ALL_DIRS) assert.ok(existsSync(join(root, sub)), `${sub}/ should exist`)
    const meta = JSON.parse(readFileSync(join(root, 'inkflow.json'), 'utf8'))
    assert.equal(meta.title, '新书')
    assert.equal(meta.schemaVersion, 1)
    assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /index\/\*\.db/)

    mkdirSync(join(root, '.git'))
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
    const harness = makeTools(join(dir, 'state'))
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
    const harness = makeTools(join(dir, 'state'))
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
    assert.equal(version.user_version, 1)
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
    const harness = makeTools(join(dir, 'state'))
    const result = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
    const codes = new Set(result.issues.map((issue) => issue.code))
    assert.ok(codes.has('OUTLINE_NO_OVERALL'))
    assert.ok(codes.has('OUTLINE_VOLUME_IN_VOLUME'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('http: loopback only, read-only, status and chapters projections', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    writeMarkdown(root, 'chapters/0001-甲.md', ['id: c1', 'seq: 1', 'title: 开篇'], '正文正文')
    const stateDir = join(dir, 'state')
    const harness = makeTools(stateDir)
    // Touch the project so the plugin remembers it, then drop the explicit root.
    await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    assert.equal(existsSync(join(stateDir, 'state.json')), true)

    const status = await callRoute(harness, fakeRequest({ url: '/inkflow/api/status' }))
    assert.equal(status.status, 200)
    assert.equal(status.json.ok, true)
    assert.equal(status.json.value.project.usable, true)
    assert.equal(status.headers['cache-control'], 'no-store')

    const chapters = await callRoute(harness, fakeRequest({ url: '/inkflow/api/chapters' }))
    assert.equal(chapters.status, 200)
    assert.equal(chapters.json.value.total, 1)

    const rebind = await callRoute(harness, fakeRequest({ url: '/inkflow/api/status', host: 'evil.example.com' }))
    assert.equal(rebind.status, 403)
    assert.equal(rebind.json.error.code, 'forbidden-host')

    const crossSite = await callRoute(harness, fakeRequest({ url: '/inkflow/api/status', origin: 'https://evil.example.com' }))
    assert.equal(crossSite.status, 403)

    const sameOrigin = await callRoute(harness, fakeRequest({ url: '/inkflow/api/status', origin: 'http://127.0.0.1:2149' }))
    assert.equal(sameOrigin.status, 200)

    const post = await callRoute(harness, fakeRequest({ url: '/inkflow/api/status', method: 'POST' }))
    assert.equal(post.status, 405)

    const missing = await callRoute(harness, fakeRequest({ url: '/inkflow/api/nope' }))
    assert.equal(missing.status, 404)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('http: no project remembered yields an empty projection, not an error', async () => {
  const dir = workdir()
  try {
    const harness = makeTools(join(dir, 'state'))
    const status = await callRoute(harness, fakeRequest({ url: '/inkflow/api/status' }))
    assert.equal(status.status, 200)
    assert.equal(status.json.value.project, null)
    const chapters = await callRoute(harness, fakeRequest({ url: '/inkflow/api/chapters' }))
    assert.equal(chapters.status, 200)
    assert.equal(chapters.json.value.total, 0)
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
    const harness = makeTools(join(dir, 'state'))
    const list = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root })
    assert.equal(list.ok, true)
    assert.equal(list.chapters[0].title, '引号标题, 带逗号')
    assert.equal(list.chapters[0].status, 'revised')
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
    const harness = makeTools(join(dir, 'state'))
    const result = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    assert.equal(result.ok, true)
    assert.equal(result.label, '带 BOM 的书')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
