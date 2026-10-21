/**
 * Regression tests for issue #4 — the index build is a cache rebuild, and a
 * cache rebuild must never be able to destroy the previous good cache:
 *
 *   - the build writes `.inkflow.db.build-<pid>-<rand>` and renames it in;
 *   - `buildIndex` single-flights concurrent callers in one process;
 *   - `index/.lock` makes concurrent processes fail fast with INDEX_BUSY;
 *   - failures surface as structured `{ ok:false, error:{ code, errno } }`,
 *     never as a raw exception/stack for the model. The HTTP route is covered
 *     too, but it fails closed with NO_SESSION_CONTEXT since issue #7 stopped
 *     resolving a project there — it never reaches the build at all.
 *
 * They run against the built artifacts (lib/index.js), like the contract tests.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { IndexBuildError, apply, buildIndex } from '../lib/index.js'

const ALL_DIRS = ['chapters', 'characters', 'world', 'outlines', 'index', 'library']
const DB_RELATIVE = join('index', 'inkflow.db')

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-index-build-'))
}

/** A minimal but *usable* project: git dir, six directories, meta, chapters. */
function project(dir, { chapters = 1 } = {}) {
  const root = join(dir, 'book')
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const name of ALL_DIRS) mkdirSync(join(root, name), { recursive: true })
  writeFileSync(
    join(root, 'inkflow.json'),
    `${JSON.stringify({ schemaVersion: 1, title: '测试之书' }, null, 2)}\n`,
    'utf8',
  )
  for (let index = 1; index <= chapters; index += 1) {
    writeFileSync(
      join(root, 'chapters', `000${index}-章.md`),
      `---\nid: c${index}\nseq: ${index}\ntitle: 第${index}章\n---\n\n正文${index}\n`,
      'utf8',
    )
  }
  return root
}

function lockFile(root) {
  return join(root, 'index', '.lock')
}

function buildLeftovers(root) {
  return readdirSync(join(root, 'index')).filter((name) => name.startsWith('.inkflow.db.build-'))
}

function readChapterCount(root) {
  const db = new DatabaseSync(join(root, DB_RELATIVE), { readOnly: true })
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM chapters').get()
    return row.n
  } finally {
    db.close()
  }
}

// ---- a minimal Cordis harness so tools/routes can be exercised without DSH ----

function createHarness(workspace) {
  const tools = new Map()
  const routes = []
  const disposes = []
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
      // Issue #7 made the session workspace the only trust anchor for an explicit
      // projectRoot, so tests must fake it rather than mutate process.cwd().
      if (name === 'workingDirectory' && typeof workspace === 'string') {
        return { ensure: async () => workspace }
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
  // A real call always comes from a session; passing the agent makes the fake
  // workingDirectory service reachable (see createHarness).
  return tool.execute(args, { signal: AbortSignal.timeout(5000), agent: { id: 'test-session' } })
}

async function callChaptersRoute(harness) {
  const route = harness.routes.find((entry) => entry.path === '/inkflow')
  assert.ok(route, 'expected the /inkflow prefix route')
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
  await route.handler({ url: '/inkflow/api/chapters', method: 'GET', headers: { host: '127.0.0.1:2149' } }, response)
  return { status: response.statusCode, json: JSON.parse(response.body) }
}

// ---------------------------------------------------------------------------
// 1. Single-flight: two concurrent calls share one build
// ---------------------------------------------------------------------------

test('index build: concurrent calls share one in-flight build', async () => {
  const dir = workdir()
  try {
    const root = project(dir, { chapters: 2 })
    const [first, second] = await Promise.all([buildIndex(root), buildIndex(root)])

    assert.equal(first.mode, 'rebuilt')
    assert.equal(first.buildId, second.buildId, 'both callers must see the same build')
    assert.equal(first.builtAt, second.builtAt)
    assert.deepEqual(first.counts, second.counts)
    assert.equal(readChapterCount(root), 2)
    assert.deepEqual(buildLeftovers(root), [])
    // The swapped-in database is one self-contained file: no WAL side files that
    // a rename would have left behind from the previous generation.
    assert.equal(existsSync(join(root, 'index', 'inkflow.db-wal')), false)
    assert.equal(existsSync(join(root, 'index', 'inkflow.db-shm')), false)
    assert.equal(existsSync(lockFile(root)), false, 'the lock must be released')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. A crashed build must not wedge the project: stale lock + temp files
// ---------------------------------------------------------------------------

test('index build: a killed build leaves no permanent lock or temp residue', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    // What a SIGKILL in the middle of a build leaves behind: a lock owned by a
    // pid that no longer exists, plus a half-written temp database.
    writeFileSync(lockFile(root), JSON.stringify({ pid: 999999, token: 'dead', startedAt: Date.now() }), 'utf8')
    writeFileSync(join(root, 'index', '.inkflow.db.build-999999-dead'), 'half-built', 'utf8')
    writeFileSync(join(root, 'index', '.inkflow.db.build-999999-dead-wal'), 'stale wal', 'utf8')

    const result = await buildIndex(root)

    assert.equal(result.mode, 'rebuilt')
    assert.equal(result.counts.chapters, 1)
    assert.equal(existsSync(lockFile(root)), false)
    assert.deepEqual(buildLeftovers(root), [], 'the crashed build temp files are cleaned up')
    assert.equal(readChapterCount(root), 1, 'the index is usable after the self-heal')

    // Same story for an orphaned lock owned by this very process (a release that
    // failed, or a dead previous plugin generation): it must not wedge the build.
    writeFileSync(lockFile(root), JSON.stringify({ pid: process.pid, token: 'own', startedAt: Date.now() }), 'utf8')
    const again = await buildIndex(root)
    assert.equal(again.counts.chapters, 1)
    assert.equal(existsSync(lockFile(root)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. A live foreign lock is INDEX_BUSY, not a stolen lock
// ---------------------------------------------------------------------------

test('index build: a live foreign lock reports INDEX_BUSY and is not stolen', async () => {
  const dir = workdir()
  try {
    const root = project(dir, { chapters: 2 })
    await buildIndex(root)
    const livePid = process.ppid
    writeFileSync(lockFile(root), JSON.stringify({ pid: livePid, token: 'live', startedAt: Date.now() }), 'utf8')

    await assert.rejects(buildIndex(root), (error) => {
      assert.ok(error instanceof IndexBuildError, 'the failure must be a structured IndexBuildError')
      assert.equal(error.code, 'INDEX_BUSY')
      assert.equal(error.errno, 'EBUSY')
      assert.match(error.message, /already running/)
      return true
    })

    assert.equal(existsSync(lockFile(root)), true, 'a live lock must survive the failed attempt')
    assert.deepEqual(buildLeftovers(root), [])
    assert.equal(readChapterCount(root), 2, 'the previous index is untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. The Windows EPERM case: another process holds the database open
// ---------------------------------------------------------------------------

test(
  'index build: a database held open elsewhere fails structured and keeps the old index',
  { skip: process.platform === 'win32' ? false : 'Windows file-sharing semantics (rename fails EPERM)' },
  async () => {
    const dir = workdir()
    try {
      const root = project(dir, { chapters: 2 })
      const built = await buildIndex(root)
      assert.equal(built.counts.chapters, 2)

      // On Windows this is exactly "another process has the db open": rename
      // over the target fails with EPERM/EBUSY and must not lose the old index.
      const holder = new DatabaseSync(join(root, DB_RELATIVE), { readOnly: true })
      try {
        await assert.rejects(buildIndex(root), (error) => {
          assert.ok(error instanceof IndexBuildError)
          assert.equal(error.code, 'INDEX_BUILD_FAILED')
          assert.match(error.errno, /^(EPERM|EACCES|EBUSY)$/)
          // The failure names the temp file it wrote, so the temp-then-rename
          // strategy is observable even though the build never finished.
          assert.ok(typeof error.tempFile === 'string', 'the error carries the temp file path')
          assert.match(error.tempFile, /[\\/]index[\\/]\.inkflow\.db\.build-\d+-[0-9a-f]+$/)
          assert.equal(existsSync(error.tempFile), false, 'the temp file is removed on failure')
          return true
        })
      } finally {
        holder.close()
      }

      assert.deepEqual(buildLeftovers(root), [], 'no temp residue after the failed build')
      assert.equal(existsSync(lockFile(root)), false, 'the lock is released on the failure path')
      assert.equal(readChapterCount(root), 2, 'the previous index is still readable')

      const retry = await buildIndex(root)
      assert.equal(retry.counts.chapters, 2, 'a retry succeeds once the holder is gone')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

// ---------------------------------------------------------------------------
// 4b. A build that fails *after* the scan (portable replace failure)
// ---------------------------------------------------------------------------

test('index build: a replace failure after the scan keeps the previous index readable', async () => {
  const dir = workdir()
  try {
    const root = project(dir, { chapters: 2 })
    await buildIndex(root)

    // The previous generation's side file cannot be replaced: on Windows this is
    // EPERM/EBUSY, on POSIX EISDIR. The old code deleted the db before parsing;
    // this failure must instead leave the last good index untouched.
    const blockedSideFile = join(root, 'index', 'inkflow.db-wal')
    mkdirSync(blockedSideFile)

    await assert.rejects(buildIndex(root), (error) => {
      assert.ok(error instanceof IndexBuildError)
      assert.equal(error.code, 'INDEX_BUILD_FAILED')
      assert.match(error.errno, /^(EPERM|EACCES|EBUSY|EISDIR)$/)
      assert.ok(typeof error.tempFile === 'string')
      assert.equal(existsSync(error.tempFile), false, 'the temp file is removed')
      return true
    })

    assert.equal(existsSync(join(root, DB_RELATIVE)), true, 'the previous db is not deleted')
    assert.equal(readChapterCount(root), 2, 'the previous index is still readable')
    assert.deepEqual(buildLeftovers(root), [])

    rmSync(blockedSideFile, { recursive: true, force: true })
    const retry = await buildIndex(root)
    assert.equal(retry.counts.chapters, 2, 'the next build succeeds once the blocker is gone')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. Tools never leak the exception; the HTTP route fails closed (#7)
// ---------------------------------------------------------------------------

test('index build: tools return structured errors, never a stack', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const harness = createHarness(dir)
    apply(harness.ctx, { dataDir: join(dir, 'state') })

    const first = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
    assert.equal(first.ok, true)

    writeFileSync(lockFile(root), JSON.stringify({ pid: process.ppid, token: 'live', startedAt: Date.now() }), 'utf8')

    const toolFailure = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
    assert.equal(toolFailure.ok, false)
    assert.equal(toolFailure.error.code, 'INDEX_BUSY')
    assert.equal(toolFailure.error.errno, 'EBUSY')
    assert.equal(typeof toolFailure.error.message, 'string')

    // With the old index still in place the lazy rebuild is not triggered at
    // all: the cache answers while another process holds the lock.
    const listOk = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root })
    assert.equal(listOk.ok, true, 'the old index still answers while another build holds the lock')

    // Drop the index: chapter_list must rebuild, fail, and report it as data
    // instead of throwing at the model.
    rmSync(join(root, DB_RELATIVE), { force: true })
    const listFailure = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root })
    assert.equal(listFailure.ok, false)
    assert.equal(listFailure.error.code, 'INDEX_BUSY')
    assert.equal(listFailure.error.errno, 'EBUSY')

    // The HTTP route no longer resolves a project at all (issue #7): it answers a
    // structured refusal with HTTP 200 rather than throwing, which would 500.
    // Issue #4's remaining guarantee on this surface is "never a stack trace".
    const routeRefusal = await callChaptersRoute(harness)
    assert.equal(routeRefusal.status, 200)
    assert.equal(routeRefusal.json.ok, false)
    assert.equal(routeRefusal.json.error.code, 'NO_SESSION_CONTEXT')
    assert.equal(existsSync(lockFile(root)), true, 'a refused route call leaves the lock alone')

    // Once the lock is gone the lazy rebuild succeeds again from the tool surface.
    rmSync(lockFile(root), { force: true })
    const recovered = await callTool(harness, 'inkflow_chapter_list', { projectRoot: root })
    assert.equal(recovered.ok, true)
    assert.equal(recovered.total, 1)
    assert.equal(recovered.indexRebuilt, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
