/**
 * Issue #5, part 1 — index freshness and the single rebuild trigger.
 *
 * The bug: the index was only rebuilt when it was *absent* or built by another
 * schema version. Editing a chapter in an editor, or adding a chapter file,
 * left every reader (tools and the panel) answering from the old rows.
 *
 * These tests pin the two halves of the fix:
 *
 *   - `checkIndexFreshness(root)` is a pure, read-only verdict
 *     (`fresh` / `stale` / `missing` / `incompatible`) taken from **one**
 *     readdir+stat pass compared against the `files` table — no content is
 *     read, nothing is hashed, and the project is byte-for-byte unchanged;
 *   - `ensureIndex(root)` is the **only** place that decides to rebuild, so
 *     `chapter_list`, `chapter_search`, `/chapters` and `/search` cannot
 *     disagree ("the list is new but the search is old").
 *
 * They run against the built artifact (lib/index.js), like the other tests.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { apply, buildIndex, checkIndexFreshness, ensureIndex } from '../lib/index.js'

const ALL_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']
const KEEP = '.gitkeep'
const DB_RELATIVE = join('index', 'inkflow.db')
/**
 * The acceptance target is "500 chapters / ~3000 files under 50 ms". The bound
 * below is the measured value with headroom for a slow, loaded CI machine: a
 * regression (re-reading every file, or a per-file `open`) blows straight
 * through it, while a warm run stays near the 50 ms target.
 */
const FRESHNESS_BUDGET_MS = Number(process.env.INKFLOW_FRESHNESS_BUDGET_MS ?? 400)
const FRESHNESS_PERF_FILES = 3000

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-freshness-'))
}

/** A minimal but *usable* project: git dir, ten directories, meta, chapters. */
function project(dir, { chapters = 2 } = {}) {
  const root = join(dir, 'book')
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const name of ALL_DIRS) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, KEEP), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '新鲜度之书' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, 'outlines', 'overall.md'), '---\nid: ov\nkind: overall\ntitle: 总纲\n---\n\n- 起\n', 'utf8')
  for (let index = 1; index <= chapters; index += 1) {
    writeFileSync(
      join(root, 'chapters', `000${index}-章.md`),
      `---\nid: c${index}\nseq: ${index}\ntitle: 第${index}章\n---\n\n正文${index}\n`,
      'utf8',
    )
  }
  return root
}

/** Stable content hash of the whole project tree: any write moves it. */
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

/** Rewrite a file with a *newer* mtime than anything the build saw. */
function touchContent(root, relative, text) {
  const absolute = join(root, relative)
  writeFileSync(absolute, text, 'utf8')
  const future = new Date(Date.now() + 5_000)
  utimesSync(absolute, future, future)
}

// ---- a minimal Cordis harness so tools/routes can be exercised without DSH ----

function createHarness(options) {
  const workspace = typeof options === 'string' ? options : options?.workspace
  const tools = new Map()
  const routes = []
  const ctx = {
    effect(setup) {
      const dispose = setup()
      if (typeof dispose === 'function') dispose()
      return () => {}
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    get(name) {
      // The panel channel resolves the project from the session (ADR-0008 D4),
      // so the three host services it reads have to answer for one session.
      if (name === 'workspaceRegistry') return undefined
      if (name === 'sessions') {
        return {
          get(id) {
            return id === 'session-1' ? { id, header: { cwd: workspace } } : undefined
          },
        }
      }
      if (name === 'workingDirectory' && typeof workspace === 'string') {
        return {
          get(session) {
            return session?.header?.cwd ?? workspace
          },
          ensure: async () => workspace,
        }
      }
      return undefined
    },
    logger() {
      return { debug() {}, info() {}, warn() {}, error() {} }
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
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
  return { ctx, tools, routes }
}

async function callTool(harness, toolName, args) {
  const tool = harness.tools.get(toolName)
  assert.ok(tool, `tool ${toolName} must be registered`)
  return tool.execute(args, { signal: AbortSignal.timeout(5000), agent: { id: 'test-session' } })
}

/** One `/inkflow/internal/*` GET through the real route handler. */
async function callInternal(harness, path) {
  const route = harness.routes.find((entry) => entry.path === '/inkflow')
  assert.ok(route, 'expected the /inkflow prefix route')
  const separator = path.includes('?') ? '&' : '?'
  const request = {
    url: `/inkflow/internal${path}${separator}sessionId=session-1`,
    method: 'GET',
    headers: { host: '127.0.0.1:2149' },
    socket: { remoteAddress: '127.0.0.1' },
  }
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
  const json = response.body === undefined ? undefined : JSON.parse(response.body)
  assert.equal(response.statusCode, 200, JSON.stringify(json))
  assert.equal(json.ok, true, JSON.stringify(json))
  return json
}

// ---------------------------------------------------------------------------
// 1. The four states
// ---------------------------------------------------------------------------

test('freshness: a freshly built index over unchanged files is fresh', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    await buildIndex(root)

    const verdict = checkIndexFreshness(root)
    assert.equal(verdict.state, 'fresh')
    assert.deepEqual(verdict.reasons, [])
    assert.equal(verdict.changes, 0)
    assert.equal(verdict.checkedFiles, 4, 'inkflow.json, the overall outline and two chapters; .gitkeep/index/ are skipped')
    assert.ok(verdict.ms >= 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('freshness: a missing database is `missing`, not `stale`', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    assert.equal(existsSync(join(root, DB_RELATIVE)), false)

    const verdict = checkIndexFreshness(root)
    assert.equal(verdict.state, 'missing')
    assert.equal(existsSync(join(root, DB_RELATIVE)), false, 'the check never creates the database')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('freshness: an index built by another schema is `incompatible` and is not deleted', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    await buildIndex(root)
    const dbFile = join(root, DB_RELATIVE)
    const writer = new DatabaseSync(dbFile)
    try {
      writer.exec('PRAGMA user_version = 999')
    } finally {
      writer.close()
    }

    const verdict = checkIndexFreshness(root)
    assert.equal(verdict.state, 'incompatible')
    assert.match(verdict.reasons[0] ?? '', /999/)
    // Deciding to rebuild (and therefore to delete) belongs to the caller.
    assert.equal(existsSync(dbFile), true)
    const reader = new DatabaseSync(dbFile, { readOnly: true })
    try {
      assert.equal(reader.prepare('PRAGMA user_version').get().user_version, 999)
    } finally {
      reader.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('freshness: an unreadable database is `incompatible` instead of throwing', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    // A database file that is not a database (a truncated write, a stray copy).
    writeFileSync(join(root, DB_RELATIVE), 'not a database at all', 'utf8')

    const verdict = checkIndexFreshness(root)
    assert.equal(verdict.state, 'incompatible')
    assert.ok(verdict.reasons.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. Every way a file can move under the index
// ---------------------------------------------------------------------------

test('freshness: editing one chapter (title and size) is stale', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    await buildIndex(root)
    touchContent(root, 'chapters/0001-章.md', '---\nid: c1\nseq: 1\ntitle: 第1章 改名\n---\n\n正文1 加长了\n')

    const verdict = checkIndexFreshness(root)
    assert.equal(verdict.state, 'stale')
    assert.ok(
      verdict.reasons.some((reason) => reason.includes('chapters/0001-章.md')),
      `the reason must name the file: ${JSON.stringify(verdict.reasons)}`,
    )
    assert.ok(verdict.changes >= 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('freshness: a new chapter file is stale', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    await buildIndex(root)
    writeFileSync(join(root, 'chapters', '0003-新章.md'), '---\nid: c3\nseq: 3\ntitle: 第3章\n---\n\n新正文\n', 'utf8')

    const verdict = checkIndexFreshness(root)
    assert.equal(verdict.state, 'stale')
    assert.ok(verdict.reasons.some((reason) => reason.includes('0003-新章.md')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('freshness: a deleted chapter file is stale', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    await buildIndex(root)
    rmSync(join(root, 'chapters', '0002-章.md'))

    const verdict = checkIndexFreshness(root)
    assert.equal(verdict.state, 'stale')
    assert.ok(verdict.reasons.some((reason) => reason.includes('0002-章.md')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('freshness: a bare mtime change (same bytes, same size) is stale', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    await buildIndex(root)
    // `touch` with the same content: size is unchanged, only the mtime moves.
    const absolute = join(root, 'chapters', '0002-章.md')
    const text = `---\nid: c2\nseq: 2\ntitle: 第2章\n---\n\n正文2\n`
    utimesSync(absolute, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000))

    const verdict = checkIndexFreshness(root)
    assert.equal(verdict.state, 'stale')
    assert.ok(
      verdict.reasons.some((reason) => reason.includes('0002-章.md')),
      `an mtime-only change is a change: ${JSON.stringify(verdict.reasons)}`,
    )
    assert.equal(statSync(absolute).size, Buffer.byteLength(text, 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('freshness: reasons are bounded, the change count is not', async () => {
  const dir = workdir()
  try {
    const root = project(dir, { chapters: 20 })
    await buildIndex(root)
    for (let index = 1; index <= 20; index += 1) {
      touchContent(root, `chapters/000${index}-章.md`, `---\nid: c${index}\nseq: ${index}\ntitle: 第${index}章\n---\n\n改过了\n`)
    }

    const verdict = checkIndexFreshness(root)
    assert.equal(verdict.state, 'stale')
    assert.equal(verdict.changes, 20)
    assert.ok(verdict.reasons.length <= 6, `reasons must stay bounded: ${verdict.reasons.length}`)
    assert.match(verdict.reasons.at(-1) ?? '', /more/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. The check is a pure read
// ---------------------------------------------------------------------------

test('freshness: checking writes nothing, not even a lock file', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    await buildIndex(root)
    const before = hashTree(root)

    assert.equal(checkIndexFreshness(root).state, 'fresh')
    writeFileSync(join(root, 'chapters', '0004-外改.md'), '---\nid: c4\nseq: 4\ntitle: 第4章\n---\n\n外改\n', 'utf8')
    const afterEdit = hashTree(root)
    assert.notEqual(afterEdit, before)
    assert.equal(checkIndexFreshness(root).state, 'stale')

    // Only the file we wrote moved: no index, no lock, no temp database.
    assert.equal(hashTree(root), afterEdit)
    assert.equal(existsSync(join(root, 'index', '.lock')), false)
    assert.deepEqual(readdirSync(join(root, 'index')).filter((name) => name.startsWith('.inkflow.db.build-')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. ensureIndex: one decision point, one build
// ---------------------------------------------------------------------------

test('ensureIndex: fresh is a no-op, stale/missing/incompatible rebuild once', async () => {
  const dir = workdir()
  try {
    const root = project(dir)

    const first = await ensureIndex(root)
    assert.equal(first.ok, true)
    assert.equal(first.state, 'missing')
    assert.equal(first.rebuilt, true, 'a missing index is built')
    assert.equal(existsSync(join(root, DB_RELATIVE)), true)

    const second = await ensureIndex(root)
    assert.equal(second.ok, true)
    assert.equal(second.state, 'fresh')
    assert.equal(second.rebuilt, false, 'a fresh index costs no build')

    touchContent(root, 'chapters/0001-章.md', '---\nid: c1\nseq: 1\ntitle: 第1章 改\n---\n\n改过\n')
    const third = await ensureIndex(root)
    assert.equal(third.state, 'stale')
    assert.equal(third.rebuilt, true, 'a stale index is rebuilt')
    assert.equal(third.build.counts.chapters, 2)

    // The rows really moved: the rebuilt index answers with the new title.
    const db = new DatabaseSync(join(root, DB_RELATIVE), { readOnly: true })
    try {
      const row = db.prepare('SELECT title FROM chapters WHERE id = ?').get('c1')
      assert.equal(row.title, '第1章 改')
    } finally {
      db.close()
    }
    assert.equal(checkIndexFreshness(root).state, 'fresh')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureIndex: rebuild: true forces a build over a fresh index', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    await ensureIndex(root)

    const forced = await ensureIndex(root, { rebuild: true })
    assert.equal(forced.ok, true)
    assert.equal(forced.state, 'fresh')
    assert.equal(forced.rebuilt, true, 'an explicit repair rebuilds anyway')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureIndex: a failed rebuild is structured data, never a stack', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    // A live foreign lock: the build fails fast with INDEX_BUSY (issue #4).
    writeFileSync(join(root, 'index', '.lock'), JSON.stringify({ pid: process.ppid, token: 'live', startedAt: Date.now() }), 'utf8')

    const result = await ensureIndex(root)
    assert.equal(result.ok, false)
    assert.equal(result.state, 'missing')
    assert.equal(result.rebuilt, false)
    assert.equal(result.failure.code, 'INDEX_BUSY')
    assert.equal(result.failure.errno, 'EBUSY')
    assert.equal(typeof result.failure.message, 'string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. One trigger, two readers: the list and the search agree
// ---------------------------------------------------------------------------

test('read paths: chapter_list and chapter_search both see an externally edited chapter', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const harness = createHarness(dir)
    apply(harness.ctx, { dataDir: join(dir, 'state') })

    const seeded = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root })
    assert.equal(seeded.ok, true)
    assert.equal(seeded.indexRebuilt, true, 'the first read builds the index')
    assert.equal(seeded.chapters[0].title, '第1章')

    // Edited outside the plugin, with no tool call in between.
    touchContent(
      root,
      'chapters/0001-章.md',
      '---\nid: c1\nseq: 1\ntitle: 第1章 云海初见\n---\n\n云海翻涌，白鹤归巢。\n',
    )

    const listed = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root })
    assert.equal(listed.ok, true)
    assert.equal(listed.chapters[0].title, '第1章 云海初见', 'the list must not answer from the old rows')
    assert.equal(listed.chapters[0].wordCount, 10, '云海翻涌，白鹤归巢。 → 10 non-space characters')
    const dbAfterList = statSync(join(root, DB_RELATIVE)).mtimeMs

    const searched = await callTool(harness, 'inkflow_chapter_search', { projectRoot: root, query: '云海翻涌' })
    assert.equal(searched.ok, true, JSON.stringify(searched.error))
    assert.equal(searched.total, 1)
    assert.equal(searched.items[0].title, '第1章 云海初见', 'search must not answer from the old rows either')
    assert.equal(searched.indexRebuilt, false, 'the list already rebuilt it: one build per change, not two')
    // The decisive check: the database was not rewritten between the two reads,
    // so exactly one build happened for this one external edit.
    assert.equal(statSync(join(root, DB_RELATIVE)).mtimeMs, dbAfterList, 'the second read path built again')

    // Acceptance criterion 2: a chapter added outside the plugin is listed
    // without anyone calling inkflow_index_rebuild.
    writeFileSync(join(root, 'chapters', '0003-新章.md'), '---\nid: c3\nseq: 3\ntitle: 第3章 新加\n---\n\n新章正文\n', 'utf8')
    const grown = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root })
    assert.equal(grown.ok, true)
    assert.equal(grown.total, 3)
    assert.deepEqual(
      grown.chapters.map((chapter) => chapter.title),
      ['第1章 云海初见', '第2章', '第3章 新加'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('read paths: /chapters and /search agree with the files after an external edit', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const harness = createHarness({ workspace: root })
    apply(harness.ctx, { dataDir: join(dir, 'state') })

    const first = await callInternal(harness, '/chapters')
    assert.equal(first.ok, true)
    assert.equal(first.value.indexState, 'missing')
    assert.equal(first.value.indexRebuilt, true)
    assert.equal(existsSync(join(root, DB_RELATIVE)), true, 'a panel read is allowed to fill the cache')

    touchContent(root, 'chapters/0001-章.md', '---\nid: c1\nseq: 1\ntitle: 第1章 改过的标题\n---\n\n改过的正文\n')

    // The list projection comes from the catalog (files); the search comes from
    // the index. They must not disagree about the new title.
    const search = await callInternal(harness, '/search?q=改过的标题')
    assert.equal(search.ok, true)
    assert.equal(search.value.indexState, 'stale')
    assert.equal(search.value.indexRebuilt, true)
    assert.equal(search.value.total, 1)
    assert.equal(search.value.results[0].title, '第1章 改过的标题')
    assert.equal(search.value.results[0].wordCount, 5, 'status and word count come from the rebuilt index')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('read paths: a second read over an unchanged project builds nothing', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const harness = createHarness({ workspace: root })
    apply(harness.ctx, { dataDir: join(dir, 'state') })

    const seeded = await callInternal(harness, '/chapters')
    assert.equal(seeded.value.indexRebuilt, true)
    const dbAfterBuild = statSync(join(root, DB_RELATIVE)).mtimeMs

    const listed = await callInternal(harness, '/chapters')
    assert.equal(listed.value.indexRebuilt, false)
    assert.equal(listed.value.indexState, 'fresh')

    const searched = await callInternal(harness, '/search?q=第2章')
    assert.equal(searched.value.indexRebuilt, false, 'the list already made the index fresh')
    assert.equal(searched.value.indexState, 'fresh')
    // Both read routes saw the same generation: exactly one build over three reads.
    assert.equal(statSync(join(root, DB_RELATIVE)).mtimeMs, dbAfterBuild, 'a read path rebuilt an already fresh index')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('read paths: when the index cannot be built, the panel degrades instead of failing', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const harness = createHarness({ workspace: root })
    apply(harness.ctx, { dataDir: join(dir, 'state') })
    // A stale index plus a live foreign lock: the rebuild is refused.
    await buildIndex(root)
    touchContent(root, 'chapters/0001-章.md', '---\nid: c1\nseq: 1\ntitle: 第1章 改\n---\n\n改过\n')
    writeFileSync(join(root, 'index', '.lock'), JSON.stringify({ pid: process.ppid, token: 'live', startedAt: Date.now() }), 'utf8')

    const search = await callInternal(harness, '/search?q=第1章')
    assert.equal(search.ok, true, 'the panel still answers from what it has')
    assert.equal(search.value.indexRebuilt, false)
    assert.equal(search.value.indexState, 'stale')
    assert.equal(search.value.indexError.code, 'INDEX_BUSY')

    const listed = await callInternal(harness, '/chapters')
    assert.equal(listed.ok, true)
    assert.equal(listed.value.indexError.code, 'INDEX_BUSY')
    assert.equal(listed.value.total, 2, 'the catalog projection still answers')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('read paths: a search tool reports the failed rebuild as data', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const harness = createHarness(dir)
    apply(harness.ctx, { dataDir: join(dir, 'state') })
    writeFileSync(join(root, 'index', '.lock'), JSON.stringify({ pid: process.ppid, token: 'live', startedAt: Date.now() }), 'utf8')

    const failure = await callTool(harness, 'inkflow_chapter_search', { projectRoot: root, query: '正文' })
    assert.equal(failure.ok, false)
    assert.equal(failure.error.code, 'INDEX_BUSY')
    assert.equal(failure.error.errno, 'EBUSY')
    assert.equal(typeof failure.error.hint, 'string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. Cost: 500 chapters over ~3000 files stays on the fast path
// ---------------------------------------------------------------------------

test('freshness: 500 chapters over 3000 files is judged inside the budget', async () => {
  const dir = workdir()
  try {
    const root = project(dir, { chapters: 0 })
    let files = 2 // inkflow.json + outlines/overall.md
    for (let volume = 1; volume <= 10; volume += 1) {
      const volumeDir = join(root, 'chapters', `vol-${String(volume).padStart(2, '0')}-v`)
      mkdirSync(volumeDir, { recursive: true })
      writeFileSync(join(volumeDir, KEEP), '', 'utf8')
    }
    for (let index = 1; index <= 500; index += 1) {
      const volume = String(Math.ceil(index / 50)).padStart(2, '0')
      writeFileSync(
        join(root, 'chapters', `vol-${volume}-v`, `${String(index).padStart(4, '0')}-章.md`),
        `---\nid: c${index}\nseq: ${index}\ntitle: 第${index}章\n---\n\n正文${index}\n`,
        'utf8',
      )
      files += 1
    }
    const fillers = [
      ['characters', 300],
      ['world', 1000],
      ['outlines', 299],
      ['foreshadowing', 300],
      ['facts', 200],
      ['library', 400],
    ]
    for (const [name, count] of fillers) {
      for (let index = 1; index <= count; index += 1) {
        writeFileSync(join(root, name, `${name}-${index}.md`), `# ${name} ${index}\n`, 'utf8')
        files += 1
      }
    }
    assert.ok(files >= FRESHNESS_PERF_FILES - 1, `fixture must be ~${FRESHNESS_PERF_FILES} files, got ${files}`)

    await buildIndex(root)
    assert.equal(checkIndexFreshness(root).state, 'fresh', 'the fixture must start fresh')

    // Warm the OS metadata cache first: the acceptance target is about the
    // algorithm (one walk, no hashing), not about cold NTFS lookups.
    checkIndexFreshness(root)
    const started = performance.now()
    const verdict = checkIndexFreshness(root)
    const elapsed = performance.now() - started

    assert.equal(verdict.state, 'fresh')
    assert.equal(verdict.checkedFiles, files)
    assert.ok(elapsed < FRESHNESS_BUDGET_MS, `freshness over ${files} files took ${elapsed.toFixed(1)} ms`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
