/**
 * Issue #41 — the semantic backend end to end, against a stub OpenViking.
 *
 * WHY A STUB. No OVK server is running on this machine, and the acceptance criteria are about
 * *this plugin's* behaviour on every answer shape: 200, 401, hang, and a port nobody listens
 * on. A `node:http` server gives all four deterministically and with zero dependencies; the
 * real server's embedding/ranking is out of scope here (ADR-0009 P1 gives that to OVK).
 *
 * WHAT THE STUB MODELS, and only this: `/health`, `POST /api/v1/content/write` (store by URI,
 * so the same URI overwrites), `POST /api/v1/search/find` (substring match over the stored
 * text, plus a synonym table so a *semantic-only* hit can be expressed), and
 * `DELETE /api/v1/fs?uri=` (physical delete). Every request is recorded, which is how the
 * tests assert the actor-peer header, the same-path overwrite, and the "forget only on purge"
 * rule.
 *
 * THE SIX DEGRADATION CASES are the first block: each asserts the same three things — the
 * answer is still the keyword answer, `searchBackend` is `fts5`, `degradedReason` is the fixed
 * word for that case — and nothing throws.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  estimateRebuild,
  purgeApply,
  runRebuild,
  searchWithSemantic,
  semanticStatusOf,
  writeSettings,
} from '../lib/index.js'

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']

// ---------------------------------------------------------------------------
// Stub OpenViking
// ---------------------------------------------------------------------------

async function startStub(options = {}) {
  const state = {
    mode: options.mode ?? 'ok',
    /** How late this stub answers, in ms — a slow runner, reproduced deterministically. */
    delayMs: options.delayMs ?? 0,
    blocks: new Map(),
    requests: [],
    synonyms: options.synonyms ?? {},
  }
  const sockets = new Set()
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const body = text === '' ? undefined : JSON.parse(text)
      state.requests.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body })

      // A late answer, on purpose: see the regression case for the 401/timeout mix-up.
      if (state.delayMs > 0) setTimeout(() => answer(), state.delayMs)
      else answer()

      function answer() {
      if (state.mode === 'hang') return // never answers: the client must time out
      if (state.mode === 'unauthorized') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'error', error: { message: 'bad or missing credential' } }))
        return
      }
      if (state.mode === 'html') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html><body>login</body></html>')
        return
      }

      const json = (payload, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }

      if (url.pathname === '/health') return json({ status: 'ok', result: { healthy: true } })

      if (url.pathname === '/api/v1/content/write' && req.method === 'POST') {
        state.blocks.set(body.uri, { content: body.content, tags: body.tags ?? [] })
        return json({ status: 'ok', result: { uri: body.uri } })
      }

      if (url.pathname === '/api/v1/search/find' && req.method === 'POST') {
        const query = String(body.query ?? '')
        const terms = query.split(/\s+/u).filter((term) => term !== '')
        const expanded = terms.flatMap((term) => [term, ...(state.synonyms[term] ?? [])])
        const hits = []
        for (const [uri, block] of state.blocks) {
          if (expanded.some((term) => block.content.includes(term))) {
            hits.push({ uri, score: 0.9 - hits.length * 0.05, abstract: block.content.slice(0, 40) })
          }
        }
        return json({ status: 'ok', result: { resources: hits, memories: [], skills: [], total: hits.length } })
      }

      if (url.pathname === '/api/v1/fs' && req.method === 'DELETE') {
        const uri = url.searchParams.get('uri') ?? ''
        if (!state.blocks.has(uri)) return json({ status: 'error', error: { message: 'not found' } }, 404)
        state.blocks.delete(uri)
        return json({ status: 'ok', result: { uri } })
      }

      return json({ status: 'error', error: { message: `no route ${url.pathname}` } }, 404)
      }
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    state,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/** A port nothing listens on: bind, read it, close it. */
async function closedPort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  return `http://127.0.0.1:${String(port)}`
}

// ---------------------------------------------------------------------------
// Book fixture (lib/index.js only, like every other contract test)
// ---------------------------------------------------------------------------

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-ovk-stub-'))
}

function makeHarness(workspace, dataDir) {
  const tools = new Map()
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
      if (name === 'workingDirectory') return { ensure: async () => workspace }
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
      register() {
        return () => {}
      },
    },
  }
  apply(ctx, { dataDir })
  return { ctx, tools }
}

async function callTool(harness, name, args) {
  const tool = harness.tools.get(name)
  assert.ok(tool, `tool ${name} must be registered`)
  return tool.execute(args, { signal: AbortSignal.timeout(60000), agent: { id: 'test-session' } })
}

function skeleton(root, meta = {}) {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of [...CONTENT_DIRS, 'index']) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, '.gitignore'), '# InkFlow derived index\nindex/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '语义检索测试之书', ...meta }, null, 2)}\n`, 'utf8')
}

function chapter(root, relativePath, id, seq, title, body) {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(
    absolute,
    `---\nid: ${id}\ntitle: ${title}\nseq: ${String(seq)}\nstatus: draft\n---\n\n${body}`,
    'utf8',
  )
}

function peerConfig(root, peer) {
  mkdirSync(join(root, '.openviking'), { recursive: true })
  writeFileSync(join(root, '.openviking', 'config.local.json'), `${JSON.stringify({ version: 1, peer: { id: peer } }, null, 2)}\n`, 'utf8')
}

/** A usable book with three chapters; `prose` decides what is searchable. */
function fixtureBook(dir, options = {}) {
  const root = join(dir, 'book')
  skeleton(root, options.meta ?? { projectId: 'proj-test' })
  if (options.peer !== false) peerConfig(root, options.peer ?? 'book-test')
  chapter(root, 'chapters/vol-01/0001-残锋.md', 'ch-0001', 1, '第一章 残锋', '他握着那把残锋，剑光冷冽。\n\n雨落在青石上。')
  chapter(root, 'chapters/vol-01/0002-长街.md', 'ch-0002', 2, '第二章 长街', '长街尽头有一盏灯。\n\n少年没有回头。')
  chapter(root, 'chapters/vol-01/0003-藏经.md', 'ch-0003', 3, '第三章 藏经', '藏经阁里没有风。')
  return root
}

/** `dataDir` + a settings file that points at `endpoint` (or none). */
function writeSemanticSettings(dataDir, settings) {
  const result = writeSettings(dataDir, { confirm: true, ...settings })
  return result
}

async function builtBook(dir, options = {}) {
  const dataDir = join(dir, 'state')
  const root = fixtureBook(dir, options)
  const harness = makeHarness(root, dataDir)
  const rebuild = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
  assert.equal(rebuild.ok, true, `index rebuild must succeed: ${JSON.stringify(rebuild.error)}`)
  return { root, dataDir, harness }
}

/** Everything the semantic layer needs, pointed at a stub. */
async function wired(dir, stub, options = {}) {
  const book = await builtBook(dir, options)
  const written = writeSemanticSettings(book.dataDir, {
    semanticSearch: true,
    semanticEndpoint: stub.url,
    ...(options.apiKey === undefined ? {} : { semanticApiKey: options.apiKey }),
  })
  assert.equal(written.ok, true, `settings write must succeed: ${JSON.stringify(written.error)}`)
  return book
}

function writeCalls(stub) {
  return stub.state.requests.filter((request) => request.path === '/api/v1/content/write')
}

function deleteCalls(stub) {
  return stub.state.requests.filter((request) => request.method === 'DELETE')
}

// ---------------------------------------------------------------------------
// 1. The six degradation cases: keyword answer, fixed reason, no throw
// ---------------------------------------------------------------------------

/**
 * One degradation case: the keyword answer still comes back and names the same reason.
 *
 * `options.timeoutMs` is the probe budget, and the default is deliberately **generous**
 * rather than tight. It used to be 200 ms for every case, which made the reason depend on
 * how fast the runner happened to be: in `unauthorized` mode the stub answers 401
 * immediately, but on a loaded Windows CI box the 200 ms budget could expire first and the
 * answer became `timeout` — a red build for a correct implementation (see the 401 case in
 * the CI log of PR #164). Only the case that *tests* the timeout wants a small budget, and
 * it passes one (`{ timeoutMs: 200 }`); every other case is timing-independent.
 */
async function degradedCase(name, prepare, expectedReason, options = {}) {
  const dir = workdir()
  try {
    const root = fixtureBook(dir, options)
    const dataDir = join(dir, 'state')
    const harness = makeHarness(root, dataDir)
    const rebuild = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
    assert.equal(rebuild.ok, true)
    const cleanup = await prepare({ root, dataDir })
    try {
      const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 60_000
      const outcome = await searchWithSemantic(root, '残锋', {}, { dataDir, timeoutMs })
      assert.equal(outcome.availability.reason, expectedReason, `${name}: availability reason`)
      assert.equal(outcome.result.ok, true, `${name}: a search never fails because a backend is absent`)
      assert.equal(outcome.result.searchBackend, 'fts5', `${name}: the keyword backend answered`)
      assert.equal(outcome.result.degradedReason, expectedReason, `${name}: the answer says why`)
      assert.equal(outcome.result.items.length > 0, true, `${name}: the keyword hit is still there`)
      assert.equal(outcome.result.items[0].id, 'ch-0001')
      assert.equal(outcome.semanticHits, 0)
    } finally {
      if (cleanup !== undefined) await cleanup()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('degrades to fts5 with `disabled` when the setting is off', async () => {
  await degradedCase('disabled', ({ dataDir }) => {
    writeSemanticSettings(dataDir, { semanticSearch: false })
  }, 'disabled')
})

test('degrades with `no-endpoint` when semantic search is on but no URL is set', async () => {
  await degradedCase('no-endpoint', ({ dataDir }) => {
    writeSemanticSettings(dataDir, { semanticSearch: true })
  }, 'no-endpoint')
})

test('degrades with `no-peer` when the book has no .openviking peer', async () => {
  await degradedCase(
    'no-peer',
    ({ dataDir }) => {
      writeSemanticSettings(dataDir, { semanticSearch: true, semanticEndpoint: 'http://127.0.0.1:1933' })
    },
    'no-peer',
    { peer: false },
  )
})

test('degrades with `unreachable` when nothing listens on the endpoint', async () => {
  const endpoint = await closedPort()
  await degradedCase(
    'unreachable',
    ({ dataDir }) => {
      writeSemanticSettings(dataDir, { semanticSearch: true, semanticEndpoint: endpoint })
    },
    'unreachable',
  )
})

test('degrades with `unauthorized` when the endpoint answers 401', async () => {
  const stub = await startStub({ mode: 'unauthorized' })
  try {
    await degradedCase(
      'unauthorized',
      ({ dataDir }) => {
        writeSemanticSettings(dataDir, { semanticSearch: true, semanticEndpoint: stub.url, semanticApiKey: 'wrong' })
      },
      'unauthorized',
    )
  } finally {
    await stub.close()
  }
})

// The regression case for the CI failure on PR #164. The stub answers 401 *late* (400 ms —
// a stand-in for a loaded runner) and the case must still say `unauthorized`: with the old
// hard-coded 200 ms budget the probe gave up first and reported `timeout`, which is a red
// build for a correct implementation. The budget now comes from the case, not from a
// constant, and this test is what keeps it that way.
test('a late 401 is still `unauthorized`, not `timeout`: the probe budget is the caller\'s', async () => {
  const stub = await startStub({ mode: 'unauthorized', delayMs: 400 })
  try {
    await degradedCase(
      'unauthorized-late',
      ({ dataDir }) => {
        writeSemanticSettings(dataDir, { semanticSearch: true, semanticEndpoint: stub.url, semanticApiKey: 'wrong' })
      },
      'unauthorized',
    )
  } finally {
    await stub.close()
  }
})

test('degrades with `timeout` when the endpoint hangs (injected timeout)', async () => {
  const stub = await startStub({ mode: 'hang' })
  try {
    await degradedCase(
      'timeout',
      ({ dataDir }) => {
        writeSemanticSettings(dataDir, { semanticSearch: true, semanticEndpoint: stub.url })
      },
      'timeout',
      // The one case that IS about the clock: a hang must be cut off quickly. Every other
      // caller keeps the generous default, so "401" can never be reported as "timeout".
      { timeoutMs: 200 },
    )
  } finally {
    await stub.close()
  }
})

test('a non-JSON 200 (a proxy login page) is not "connected": it degrades as unreachable', async () => {
  const stub = await startStub({ mode: 'html' })
  try {
    await degradedCase(
      'html',
      ({ dataDir }) => {
        writeSemanticSettings(dataDir, { semanticSearch: true, semanticEndpoint: stub.url })
      },
      'unreachable',
    )
  } finally {
    await stub.close()
  }
})

// ---------------------------------------------------------------------------
// 2. Stub 200: recall leads the page, located by the book itself
// ---------------------------------------------------------------------------

test('with a live endpoint the answer is `ovk`, and the hit is located in the chapter file', async () => {
  const dir = workdir()
  const stub = await startStub({ synonyms: { 断剑: ['残锋'] } })
  try {
    const { root, dataDir } = await wired(dir, stub)
    const rebuild = await runRebuild({ root, dataDir, connection: { endpoint: stub.url }, peer: 'book-test' })
    assert.equal(rebuild.status, 'written')
    assert.equal(rebuild.summary.written, 3, 'three non-empty chapters')
    assert.ok(rebuild.summary.calls >= 3, 'one call per block at least')

    // The blocks were written with the actor peer on every request (ADR-0009 P3), i.e. the
    // peer is explicit rather than implied by the process's working directory.
    for (const request of writeCalls(stub)) {
      assert.equal(request.headers['x-openviking-actor-peer'], 'book-test')
      assert.equal(request.headers['content-type'], 'application/json')
      // Same-path OVERWRITE, never append: that is what makes a rebuild idempotent (P5).
      assert.equal(request.body.mode, 'replace')
      assert.equal(request.body.wait, false, 'a bulk rebuild does not wait for each block to be summarised')
      assert.ok(Array.isArray(request.body.tags))
      assert.ok(request.body.tags.includes('inkflow:project=proj-test'))
    }
    // The URI is the project's subtree: book isolation is the prefix (ADR-0020 E3).
    assert.deepEqual(
      [...stub.state.blocks.keys()].sort(),
      [
        'viking://resources/inkflow/proj-test/chapters/ch-0001/0.md',
        'viking://resources/inkflow/proj-test/chapters/ch-0002/0.md',
        'viking://resources/inkflow/proj-test/chapters/ch-0003/0.md',
      ],
    )

    // 断剑 appears nowhere in the manuscript: only the semantic backend can answer it.
    const keywordOnly = await searchWithSemantic(root, '断剑', {}, { dataDir: join(dir, 'no-settings') })
    assert.equal(keywordOnly.result.ok, true)
    assert.equal(keywordOnly.result.total, 0, 'the keyword backend cannot see the synonym')

    const outcome = await searchWithSemantic(root, '断剑', {}, { dataDir })
    assert.equal(outcome.availability.backend, 'ovk')
    assert.equal(outcome.result.ok, true)
    assert.equal(outcome.result.searchBackend, 'ovk')
    assert.equal(outcome.semanticHits, 1)
    assert.equal(outcome.result.items.length, 1)
    const [hit] = outcome.result.items
    assert.equal(hit.kind, 'chapters')
    assert.equal(hit.id, 'ch-0001')
    assert.equal(hit.path, 'chapters/vol-01/0001-残锋.md')
    assert.equal(hit.title, '第一章 残锋')
    // ADR-0009 P7: the snippet is the chapter's own text at the block's offsets, not OVK's
    // abstract (which is a model-written summary and must never be quoted as prose).
    assert.equal(hit.snippet.includes('残锋'), true)
    assert.equal(typeof hit.offset, 'number')
    assert.ok(hit.score > 0)
  } finally {
    await stub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. Idempotency: same URIs, no duplicate blocks
// ---------------------------------------------------------------------------

test('rebuilding an unchanged book writes nothing the second time (same URIs, same count)', async () => {
  const dir = workdir()
  const stub = await startStub()
  try {
    const { root, dataDir } = await wired(dir, stub)
    const first = await runRebuild({ root, dataDir, connection: { endpoint: stub.url }, peer: 'book-test' })
    assert.equal(first.status, 'written')
    const afterFirst = new Map(stub.state.blocks)
    assert.equal(afterFirst.size, 3)

    const second = await runRebuild({ root, dataDir, connection: { endpoint: stub.url }, peer: 'book-test' })
    assert.equal(second.status, 'summary', 'nothing changed, so nothing was sent')
    assert.equal(second.summary.unchanged, 3)
    assert.equal(second.summary.blocks, 0)
    assert.equal(stub.state.blocks.size, 3, 'no duplicate entries: the URIs are stable')
    for (const [uri, block] of afterFirst) assert.deepEqual(stub.state.blocks.get(uri), block)
    assert.equal(writeCalls(stub).length, 3, 'exactly one write per block, total')
  } finally {
    await stub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. A changed chapter overwrites its own block; the old text stops matching
// ---------------------------------------------------------------------------

test('editing a chapter overwrites its URI in place, and the old prose stops being recalled', async () => {
  const dir = workdir()
  const stub = await startStub()
  try {
    const { root, dataDir, harness } = await wired(dir, stub)
    await runRebuild({ root, dataDir, connection: { endpoint: stub.url }, peer: 'book-test' })
    const uri = 'viking://resources/inkflow/proj-test/chapters/ch-0001/0.md'
    assert.equal(String(stub.state.blocks.get(uri)?.content).includes('残锋'), true)

    // Rewrite the chapter: the same chapter id and path, different title and prose.
    chapter(root, 'chapters/vol-01/0001-残锋.md', 'ch-0001', 1, '第一章 剑鞘', '他把断剑收进鞘里。')
    // The chapter list and the prose both come from the index, so every real caller refreshes
    // it first (the tool and the panel route do). Doing it here keeps the assertion about OVK
    // rather than about a cache that was left stale on purpose.
    const reindexed = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
    assert.equal(reindexed.ok, true)
    const again = await runRebuild({ root, dataDir, connection: { endpoint: stub.url }, peer: 'book-test' })
    assert.equal(again.summary.written, 1, 'only the edited chapter is written')
    assert.equal(again.summary.unchanged, 2)
    assert.equal(stub.state.blocks.size, 3, 'the same three URIs, overwritten')
    assert.equal(String(stub.state.blocks.get(uri)?.content).includes('残锋'), false, 'no stale prose survives')
    assert.equal(String(stub.state.blocks.get(uri)?.content).includes('断剑'), true)

    const old = await searchWithSemantic(root, '残锋', {}, { dataDir })
    assert.equal(old.result.ok, true)
    assert.equal(old.result.searchBackend, 'fts5', 'the OVK backend has no match left; the keyword one has none either')
    assert.equal(old.result.total, 0, 'no ghost of the previous text')

    const fresh = await searchWithSemantic(root, '断剑', {}, { dataDir })
    assert.equal(fresh.result.searchBackend, 'ovk')
    assert.equal(fresh.result.items[0].id, 'ch-0001')
  } finally {
    await stub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. Deleting a chapter: tombstone, filtered recall, ZERO physical deletes
// ---------------------------------------------------------------------------

test('deleting a chapter tombstones its blocks, filters them out of recall, and calls no forget', async () => {
  const dir = workdir()
  // The synonym makes the stub return the TOMBSTONE block itself for this query, so the
  // deleted-flag filter is what the assertion actually exercises: without it, the tombstone
  // would come back as a hit (it still exists — that is the point of not calling `forget`).
  const stub = await startStub({ synonyms: { 藏经阁: ['该章已删除'] } })
  try {
    const { root, dataDir, harness } = await wired(dir, stub)
    await runRebuild({ root, dataDir, connection: { endpoint: stub.url }, peer: 'book-test' })
    const deletedUri = 'viking://resources/inkflow/proj-test/chapters/ch-0003/0.md'
    assert.equal(String(stub.state.blocks.get(deletedUri)?.content).includes('藏经阁'), true)

    // The book's own delete path: the file goes to `.inkflow/trash/`, and the semantic side is
    // told afterwards by a rebuild — nothing here calls `forget` (ADR-0009 P6).
    const removed = await callTool(harness, 'inkflow_chapter_delete', { projectRoot: root, chapterId: 'ch-0003', confirm: true })
    assert.equal(removed.ok, true, `chapter delete must succeed: ${JSON.stringify(removed.error)}`)

    const after = await runRebuild({ root, dataDir, connection: { endpoint: stub.url }, peer: 'book-test' })
    assert.equal(after.summary.tombstoned, 1)
    assert.equal(after.summary.written, 0, 'the surviving chapters are unchanged')
    assert.equal(deleteCalls(stub).length, 0, 'the delete path must never physically delete in OVK')

    const tombstone = String(stub.state.blocks.get(deletedUri)?.content)
    assert.equal(tombstone.includes('藏经阁'), false, 'the tombstone keeps no prose')
    assert.match(tombstone, /tombstone/)

    const recall = await searchWithSemantic(root, '藏经阁', {}, { dataDir })
    assert.equal(recall.result.ok, true)
    assert.equal(recall.semanticHits, 0, 'a tombstone is filtered out on this side, where the deleted flag lives')
    assert.equal(recall.result.total, 0)
    // Evidence that the filter is what did it: the stub DID return the tombstone block, and
    // the ledger found it — it was dropped because the chapter is deleted, not because the
    // locate failed.
    assert.equal(recall.staleHits, 0)
    assert.equal(recall.tombstoneHits, 1)
    const afterRecall = stub.state.requests.filter((request) => request.path === '/api/v1/search/find').at(-1)
    assert.equal(afterRecall.body.target_uri, 'viking://resources/inkflow/proj-test')
  } finally {
    await stub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. Purge: the one path that physically deletes
// ---------------------------------------------------------------------------

test('a ledger record marked deleted is never recalled, even while the chapter file is back', async () => {
  const dir = workdir()
  const stub = await startStub()
  try {
    const { root, dataDir } = await wired(dir, stub)
    await runRebuild({ root, dataDir, connection: { endpoint: stub.url }, peer: 'book-test' })
    // The state an interrupted delete leaves behind: the ledger still holds the chapter as a
    // tombstone record while the file itself is present again (restored from `.inkflow/trash/`,
    // or the rebuild that would have re-indexed it never ran). The recall must drop it on the
    // ledger's flag alone — otherwise a deleted chapter comes back the moment the file does.
    const slug = readdirSync(join(dataDir, 'semantic'))[0]
    const ledgerPath = join(dataDir, 'semantic', slug)
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    assert.equal(ledger.chapters['ch-0002'].deleted, false)
    ledger.chapters['ch-0002'].deleted = true
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')

    const recall = await searchWithSemantic(root, '长街', {}, { dataDir })
    assert.equal(recall.result.ok, true)
    assert.equal(recall.semanticHits, 0, 'the deleted flag alone must keep it out of the answer')
    assert.equal(recall.tombstoneHits, 1)
    assert.equal(recall.staleHits, 0)
  } finally {
    await stub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('purge lists tombstones without confirm, deletes exactly those with it', async () => {
  const dir = workdir()
  const stub = await startStub()
  try {
    const { root, dataDir, harness } = await wired(dir, stub)
    await runRebuild({ root, dataDir, connection: { endpoint: stub.url }, peer: 'book-test' })
    await callTool(harness, 'inkflow_chapter_delete', { projectRoot: root, chapterId: 'ch-0003', confirm: true })
    await runRebuild({ root, dataDir, connection: { endpoint: stub.url }, peer: 'book-test' })

    const listed = await callTool(harness, 'inkflow_semantic_purge', { projectRoot: root })
    assert.equal(listed.ok, false)
    assert.equal(listed.requiresConfirm, true)
    assert.equal(listed.error.code, 'CONFIRM_REQUIRED')
    assert.deepEqual(listed.uris, ['viking://resources/inkflow/proj-test/chapters/ch-0003/0.md'])
    assert.equal(deleteCalls(stub).length, 0, 'listing deletes nothing')

    const purged = await callTool(harness, 'inkflow_semantic_purge', { projectRoot: root, confirm: true })
    assert.equal(purged.ok, true, `purge must succeed: ${JSON.stringify(purged.error)}`)
    assert.deepEqual(purged.deleted, ['viking://resources/inkflow/proj-test/chapters/ch-0003/0.md'])
    assert.equal(deleteCalls(stub).length, 1)
    assert.equal(stub.state.blocks.has('viking://resources/inkflow/proj-test/chapters/ch-0003/0.md'), false)
    // The live chapters are untouched by a purge.
    assert.equal(stub.state.blocks.size, 2)

    const status = await callTool(harness, 'inkflow_semantic_status', { projectRoot: root })
    assert.equal(status.ok, true)
    assert.equal(status.ledger.tombstones, 0, 'the ledger dropped the purged chapter')
    assert.equal(status.ledger.blocks, 2)
  } finally {
    await stub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('purge stops at the first failure and reports where', async () => {
  const dir = workdir()
  const stub = await startStub()
  try {
    const { root, dataDir, harness } = await wired(dir, stub)
    await runRebuild({ root, dataDir, connection: { endpoint: stub.url }, peer: 'book-test' })
    await callTool(harness, 'inkflow_chapter_delete', { projectRoot: root, chapterId: 'ch-0003', confirm: true })
    await runRebuild({ root, dataDir, connection: { endpoint: stub.url }, peer: 'book-test' })
    // Someone else removed the block: the purge must treat 404 as "already gone", not as a
    // failure (otherwise a purge can never finish after a partial manual cleanup).
    stub.state.blocks.delete('viking://resources/inkflow/proj-test/chapters/ch-0003/0.md')
    const purged = await callTool(harness, 'inkflow_semantic_purge', { projectRoot: root, confirm: true })
    assert.equal(purged.ok, true)
    assert.equal(purged.deleted.length, 1)
    assert.equal(purged.stoppedAt, undefined)

    // A transport failure does stop it, and says where.
    const second = await wired(join(dir, 'second'), stub)
    await runRebuild({ root: second.root, dataDir: second.dataDir, connection: { endpoint: stub.url }, peer: 'book-test' })
    await callTool(second.harness, 'inkflow_chapter_delete', { projectRoot: second.root, chapterId: 'ch-0003', confirm: true })
    await runRebuild({ root: second.root, dataDir: second.dataDir, connection: { endpoint: stub.url }, peer: 'book-test' })
    stub.state.mode = 'unauthorized'
    const failed = await callTool(second.harness, 'inkflow_semantic_purge', { projectRoot: second.root, confirm: true })
    assert.equal(failed.ok, false)
    // Nothing was deleted, so this is a failed purge rather than a completed one with a note.
    assert.equal(failed.error.code, 'SEMANTIC_PURGE_FAILED')
    assert.equal(failed.error.reason, 'unauthorized')
    assert.equal(failed.stoppedAt.reason, 'unauthorized')
    const status = await callTool(second.harness, 'inkflow_semantic_status', { projectRoot: second.root })
    assert.equal(status.ok, true)
    assert.equal(status.ledger.tombstones, 1, 'a failed purge leaves the entry for the next attempt')
  } finally {
    await stub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7. Status: the six-word vocabulary and no secret on the wire
// ---------------------------------------------------------------------------

test('status reports the endpoint and peer, never the key, and names why it is degraded', async () => {
  const dir = workdir()
  const stub = await startStub()
  try {
    const { root, dataDir } = await wired(dir, stub, { apiKey: 'sk-very-secret-token' })
    const status = await semanticStatusOf(root, { dataDir })
    assert.equal(status.availability.backend, 'ovk')
    assert.equal(status.settings.apiKeySet, true)
    assert.equal(status.settings.endpoint, stub.url)
    assert.equal(status.peer.id, 'book-test')
    assert.equal(status.peer.source, 'local')
    assert.equal(JSON.stringify(status).includes('sk-very-secret-token'), false, 'the key never travels back')

    // A live server still reports the key only in the settings file.
    const settingsText = (await import('node:fs')).readFileSync(join(dataDir, 'settings.json'), 'utf8')
    assert.equal(settingsText.includes('sk-very-secret-token'), true)
  } finally {
    await stub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 8. First-build threshold: an estimate, and a refusal without confirm
// ---------------------------------------------------------------------------

test('a first build above 200 chapters refuses without confirm and shows the estimate', async () => {
  const dir = workdir()
  const stub = await startStub()
  try {
    const { root, dataDir, harness } = await wired(dir, stub)
    // 201 chapters, each tiny: the count is what trips the threshold (ADR-0009 P10).
    for (let index = 4; index <= 201; index += 1) {
      const padded = String(index).padStart(4, '0')
      chapter(root, `chapters/vol-01/${padded}-章.md`, `ch-${padded}`, index, `第 ${String(index)} 章`, `第${String(index)}章正文。`)
    }
    const rebuilt = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
    assert.equal(rebuilt.ok, true)

    const estimate = estimateRebuild(root, { dataDir })
    assert.equal(estimate.ok, true)
    assert.equal(estimate.estimate.chapters, 201)
    assert.equal(estimate.estimate.requiresConfirm, true)

    const refused = await callTool(harness, 'inkflow_semantic_rebuild', { projectRoot: root })
    assert.equal(refused.ok, true)
    assert.equal(refused.requiresConfirm, true)
    assert.equal(refused.error.code, 'CONFIRM_REQUIRED')
    assert.equal(refused.estimate.chapters, 201)
    assert.ok(refused.estimate.blocks >= 201)
    assert.equal(writeCalls(stub).length, 0, 'an unconfirmed build sends nothing (and costs nothing)')

    const executed = await callTool(harness, 'inkflow_semantic_rebuild', { projectRoot: root, confirm: true })
    assert.equal(executed.ok, true, `confirmed build must run: ${JSON.stringify(executed.error)}`)
    assert.equal(executed.summary.written, 201)
    assert.equal(stub.state.blocks.size, 201)
  } finally {
    await stub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 9. The degraded answer is still a search (never a 500-shaped tool reply)
// ---------------------------------------------------------------------------

test('inkflow_search answers with the keyword page plus the reason when the endpoint is down', async () => {
  const dir = workdir()
  try {
    const root = fixtureBook(dir)
    const dataDir = join(dir, 'state')
    const harness = makeHarness(root, dataDir)
    await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
    writeSemanticSettings(dataDir, { semanticSearch: true, semanticEndpoint: await closedPort() })

    const result = await callTool(harness, 'inkflow_search', { projectRoot: root, query: '残锋' })
    assert.equal(result.ok, true, `a dead backend must not fail the search: ${JSON.stringify(result.error)}`)
    assert.equal(result.searchBackend, 'fts5')
    assert.equal(result.degradedReason, 'unreachable')
    assert.equal(result.total, 1)
    assert.equal(result.items[0].id, 'ch-0001')
    assert.equal(result.semantic.backend, 'fts5')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('purgeApply on a book with no tombstones does nothing at all', async () => {
  const dir = workdir()
  const stub = await startStub()
  try {
    const { root, dataDir } = await wired(dir, stub)
    await runRebuild({ root, dataDir, connection: { endpoint: stub.url }, peer: 'book-test' })
    const result = await purgeApply(root, { dataDir })
    assert.equal(result.ok, true)
    assert.deepEqual(result.outcome.deleted, [])
    assert.equal(deleteCalls(stub).length, 0)
  } finally {
    await stub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
