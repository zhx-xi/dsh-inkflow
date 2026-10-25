/**
 * The private state's purge area: cleaning up a review run or a finished
 * proposal is a **move**, and the author can put it back.
 *
 * What each block is for, so a failure names the promise that broke:
 *
 *   1. **`open` 的提案永不进候选** — the author ruling is "clean up only what is
 *      finished": an undecided proposal cleaned up would be a decision nobody made.
 *   2. **已结束的提案/单条运行搬进 `purged/`** — the source leaves the list, the bytes stay,
 *      the manifest row and the `.inkflow/audit/purge-<stamp>.md` record both exist, and the
 *      record names the session that asked (so "who deleted it" has an answer).
 *   3. **清理不得触碰内容目录** — `chapters/**\/*.md` is bit-identical before and after, the
 *      same claim the recovery bin makes for a different kind of deletion.
 *   4. **还原** — byte-identical (BOM/CRLF included), never overwrites, and a path outside
 *      `.inkflow/{review,proposals}` is refused before any write.
 *
 * Runs against the built artifact (`lib/index.js`) through the panel channel, like the other
 * channel contracts: the tests drive what a user installs, one fake request at a time.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { apply, createProposal, decideProposal } from '../lib/index.js'

const HOST = '127.0.0.1:2161'
const ORIGIN = `http://${HOST}`
const INTERNAL = '/inkflow/internal'
const JSON_TYPE = 'application/json'
const CHAPTER = 'chapters/vol-01/0001-开篇.md'
const ROOT = join(import.meta.dirname, '..')
const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']

// ---------------------------------------------------------------------------
// Harness (same shape as tests/trash.test.js)
// ---------------------------------------------------------------------------

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
  apply(ctx, { dataDir: join(tmpdir(), 'inkflow-purge-state') })
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
  if (sessionId === null) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}sessionId=${encodeURIComponent(sessionId)}`
}

function read(harness, path, options = {}) {
  return callRoute(harness, fakeRequest({ url: `${INTERNAL}${withSession(path, options.sessionId ?? 'session-1')}`, ...options }))
}

function writeCall(harness, path, options = {}) {
  return callRoute(
    harness,
    fakeRequest({
      origin: ORIGIN,
      ...options,
      url: `${INTERNAL}${withSession(path, options.sessionId ?? 'session-1')}`,
      method: options.method ?? 'POST',
      body: JSON.stringify(options.payload ?? {}),
    }),
  )
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function scaffold() {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-purge-'))
  const root = join(dir, '书')
  mkdirSync(root, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (const name of [...CONTENT_DIRS, 'index']) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '清理之书', author: 'tester' }, null, 2)}\n`, 'utf8')
  mkdirSync(join(root, 'chapters', 'vol-01'), { recursive: true })
  writeFileSync(
    join(root, CHAPTER),
    ['---', 'id: ch-0001', 'title: 第一章 开篇', 'volume: vol-01', 'seq: 1', '---', '', '他走进白鹤门。', '', '老人放下茶杯。', ''].join('\r\n'),
    'utf8',
  )
  return { dir, root, done: () => rmSync(dir, { recursive: true, force: true }) }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Every chapter file's path + hash — the "content must not move" fingerprint. */
function chapterFingerprint(root) {
  const out = []
  const walk = (relative) => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const child = `${relative}/${name}`
      const stats = statSync(join(root, child))
      if (stats.isDirectory()) walk(child)
      else if (name.endsWith('.md')) out.push(`${child} ${sha256(readFileSync(join(root, child)))}`)
    }
  }
  walk('chapters')
  return out
}

/** A recorded review run, written the way `inkflow_review_run` writes it. */
function seedRun(root, chapterId, runId, bytes = null) {
  const dir = join(root, '.inkflow', 'review', chapterId)
  mkdirSync(dir, { recursive: true })
  const record = {
    schemaVersion: 1,
    runId,
    chapterId,
    chapterPath: CHAPTER,
    chapterTitle: '第一章 开篇',
    wordCount: 20,
    chapterDigest: 'digest',
    reviewer: 'model-a',
    createdAt: '2026-10-25T09:55:01.123Z',
    dimensions: [],
    opinions: [],
    rejected: [],
    scores: null,
  }
  writeFileSync(join(dir, `${runId}.json`), bytes ?? `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return `.inkflow/review/${chapterId}/${runId}.json`
}

/** A proposal in the state the case needs, through the real writer (not a hand-made dir). */
function seedProposal(root, { status = 'open' } = {}) {
  const created = createProposal(root, {
    chapterId: 'ch-0001',
    revisedBody: '他走进白鹤门。\r\n\r\n老人放下茶杯，抬眼看他。',
    label: 'session-model',
  })
  assert.equal(created.ok, true, `the proposal could not be created: ${JSON.stringify(created.error ?? null)}`)
  const proposalId = created.value.proposalId
  const decided = decideProposal(root, {
    proposalId,
    decisions: created.value.hunks.map((hunk) => ({ index: hunk.index, status: 'accepted' })),
  })
  assert.equal(decided.ok, true, `the proposal could not be decided: ${JSON.stringify(decided.error ?? null)}`)
  assert.equal(status, 'open', 'this fixture only needs the undecided form; applied/rolled-back are reached by cleanup tests below')
  return proposalId
}

/** One proposal the author has finished with (`applied`), through apply. */
async function finishedProposal(root) {
  const { applyProposal } = await import('../lib/index.js')
  const created = createProposal(root, {
    chapterId: 'ch-0001',
    revisedBody: '他走进白鹤门。\r\n\r\n老人放下茶杯，抬眼看他。',
    label: 'session-model',
  })
  assert.equal(created.ok, true, JSON.stringify(created.error ?? null))
  const proposalId = created.value.proposalId
  const decided = decideProposal(root, {
    proposalId,
    decisions: created.value.hunks.map((hunk) => ({ index: hunk.index, status: 'accepted' })),
  })
  assert.equal(decided.ok, true, JSON.stringify(decided.error ?? null))
  const applied = await applyProposal(root, { proposalId, confirm: true })
  assert.equal(applied.ok, true, JSON.stringify(applied.error ?? null))
  return proposalId
}

function auditRecords(root) {
  const dir = join(root, '.inkflow', 'audit')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.startsWith('purge-'))
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
}

// ---------------------------------------------------------------------------
// 1. What may never be cleaned up
// ---------------------------------------------------------------------------

test('清理：open 的提案永不进候选（PURGE_OPEN_PROPOSAL，零写入）', async () => {
  const fixture = scaffold()
  try {
    const harness = createHarness({ workspace: fixture.root })
    const proposalId = seedProposal(fixture.root)
    const before = chapterFingerprint(fixture.root)

    const refused = await writeCall(harness, '/purged/clean', { payload: { kind: 'proposal', target: proposalId, confirm: true } })
    assert.equal(refused.status, 409)
    assert.equal(refused.json.ok, false)
    assert.equal(refused.json.error.code, 'PURGE_OPEN_PROPOSAL')
    assert.equal(
      existsSync(join(fixture.root, '.inkflow', 'proposals', proposalId, 'meta.json')),
      true,
      'the refused cleanup left the proposal alone',
    )
    assert.equal(existsSync(join(fixture.root, '.inkflow', 'purged')), false, 'a refusal creates nothing')
    assert.deepEqual(chapterFingerprint(fixture.root), before)
    assert.deepEqual(auditRecords(fixture.root), [])
  } finally {
    fixture.done()
  }
})

test('清理：没有 confirm 就什么都不动', async () => {
  const fixture = scaffold()
  try {
    const harness = createHarness({ workspace: fixture.root })
    const proposalId = await finishedProposal(fixture.root)

    const refused = await writeCall(harness, '/purged/clean', { payload: { kind: 'proposal', target: proposalId } })
    assert.equal(refused.status, 400)
    assert.equal(refused.json.error.code, 'CONFIRM_REQUIRED')
    assert.equal(existsSync(join(fixture.root, '.inkflow', 'proposals', proposalId)), true)
    assert.equal(existsSync(join(fixture.root, '.inkflow', 'purged')), false)
  } finally {
    fixture.done()
  }
})

// ---------------------------------------------------------------------------
// 2. A finished proposal moves, and the record says who did it
// ---------------------------------------------------------------------------

test('清理：已结束的提案搬进 purged/，源目录消失、清单与删除记录都在', async () => {
  const fixture = scaffold()
  try {
    const harness = createHarness({ workspace: fixture.root })
    const proposalId = await finishedProposal(fixture.root)
    const before = chapterFingerprint(fixture.root)

    const listed = await read(harness, '/proposal')
    assert.equal(listed.json.value.proposals.some((row) => row.proposalId === proposalId), true, 'it starts out in the inbox')

    const cleaned = await writeCall(harness, '/purged/clean', { payload: { kind: 'proposal', target: proposalId, confirm: true } })
    assert.equal(cleaned.status, 200)
    assert.equal(cleaned.json.ok, true)

    // Source gone, copies present, at the path the cleanup says.
    assert.equal(existsSync(join(fixture.root, '.inkflow', 'proposals', proposalId)), false, 'the proposal left .inkflow/proposals/')
    const copyDir = join(fixture.root, '.inkflow', 'purged', 'proposals', proposalId)
    assert.equal(existsSync(join(copyDir, 'meta.json')), true, 'the copy is at its own sub-path')
    assert.equal(existsSync(join(copyDir, 'hunks')), true, 'a proposal moves whole: its hunks come too')

    // The manifest says what left, and the panel can list it.
    const purged = await read(harness, '/purged')
    assert.equal(purged.status, 200)
    assert.equal(purged.json.value.total, 1)
    const [entry] = purged.json.value.entries
    assert.equal(entry.kind, 'proposal')
    assert.equal(entry.target, proposalId)
    assert.equal(entry.present, true)
    assert.ok(entry.bytes > 0)
    assert.ok(entry.files.some((file) => file.path === `proposals/${proposalId}/meta.json`))
    assert.equal(entry.files.every((file) => file.path.startsWith('proposals/')), true)

    // It is out of the inbox, and nothing in the book moved.
    const after = await read(harness, '/proposal')
    assert.equal(after.json.value.proposals.some((row) => row.proposalId === proposalId), false)
    assert.deepEqual(chapterFingerprint(fixture.root), before, 'cleaning up private state never touches a chapter')

    // The deletion record answers "who removed it".
    const [record] = auditRecords(fixture.root)
    assert.ok(record, 'a purge writes exactly one record')
    assert.match(record.text, /清理/)
    assert.match(record.text, new RegExp(proposalId))
    assert.match(record.text, /session-1/, 'the record names the session that asked')
    assert.match(record.text, new RegExp(`· ${String(entry.bytes)} 字节|字节：${String(entry.bytes)}`))
  } finally {
    fixture.done()
  }
})

// ---------------------------------------------------------------------------
// 3. One review run moves; the panel stops listing it
// ---------------------------------------------------------------------------

test('清理：单条运行记录搬进 purged/，审稿页不再列它，删的只是它', async () => {
  const fixture = scaffold()
  try {
    const harness = createHarness({ workspace: fixture.root })
    const kept = seedRun(fixture.root, 'ch-0001', '20261025T10000000Z')
    const cleaned = seedRun(fixture.root, 'ch-0001', '20261025T09000000Z')
    const before = chapterFingerprint(fixture.root)

    const listed = await read(harness, '/review?chapterId=ch-0001')
    assert.equal(listed.json.value.runCount, 2)

    const result = await writeCall(harness, '/purged/clean', {
      payload: { kind: 'review-run', target: 'ch-0001/20261025T09000000Z', confirm: true },
    })
    assert.equal(result.status, 200)
    assert.equal(result.json.ok, true)
    assert.equal(existsSync(join(fixture.root, cleaned)), false, 'the cleaned run left .inkflow/review/')
    assert.equal(existsSync(join(fixture.root, kept)), true, 'the other run is untouched')
    assert.equal(
      existsSync(join(fixture.root, '.inkflow', 'purged', 'review', 'ch-0001', '20261025T09000000Z.json')),
      true,
      'the copy keeps its path under .inkflow/',
    )

    const after = await read(harness, '/review?chapterId=ch-0001')
    assert.equal(after.json.value.runCount, 1, 'the panel lists one run fewer')
    assert.deepEqual(chapterFingerprint(fixture.root), before)

    // The comparison table keeps working on what is left (the acceptance case).
    const compare = await read(harness, '/review/compare?chapterId=ch-0001')
    assert.equal(compare.status, 200)
  } finally {
    fixture.done()
  }
})

// ---------------------------------------------------------------------------
// 4. The list is a projection of the manifest, not of the directory
// ---------------------------------------------------------------------------

test('清理：清单读不出来时列表如实拒绝，不假装空', async () => {
  const fixture = scaffold()
  try {
    const harness = createHarness({ workspace: fixture.root })
    mkdirSync(join(fixture.root, '.inkflow', 'purged'), { recursive: true })
    writeFileSync(join(fixture.root, '.inkflow', 'purged', 'index.json'), '{ not json', 'utf8')
    const listed = await read(harness, '/purged')
    assert.equal(listed.json.ok, false)
    assert.equal(listed.json.error.code, 'PURGE_MANIFEST_INVALID')
  } finally {
    fixture.done()
  }
})

test('清理：手工改过的清单行（path 指向内容目录）被拒读，也就是改不成任意写', async () => {
  const fixture = scaffold()
  try {
    const harness = createHarness({ workspace: fixture.root })
    mkdirSync(join(fixture.root, '.inkflow', 'purged'), { recursive: true })
    writeFileSync(
      join(fixture.root, '.inkflow', 'purged', 'index.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          entries: [
            {
              id: 'e1',
              kind: 'review-run',
              target: 'ch-0001/run',
              label: 'x',
              deletedAt: '2026-10-25T09:55:01.123Z',
              bytes: 1,
              sha256: 'a'.repeat(64),
              reason: 'author_cleanup',
              files: [{ path: 'chapters/vol-01/0001-开篇.md', bytes: 1, sha256: 'a'.repeat(64) }],
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    const listed = await read(harness, '/purged')
    assert.equal(listed.json.ok, false, 'a row whose path is outside .inkflow/{review,proposals} cannot be restored, so the list refuses it')
    assert.equal(listed.json.error.code, 'PURGE_MANIFEST_INVALID')
  } finally {
    fixture.done()
  }
})

/**
 * The "可还原" half, from the author's side: clean up a run, change your mind, and every byte
 * comes back at the path it left.
 *
 * The three refusals below are the ones that make the feature safe rather than merely useful: a
 * path outside `.inkflow/{review,proposals}` (a hand-edited manifest must not become a write
 * primitive), an occupied target (the author's newer state wins), and an unknown id.
 */
test('还原：清理后能逐字节写回原路径（BOM 与 CRLF 保留），审稿页重新列出它', async () => {
  const fixture = scaffold()
  try {
    const harness = createHarness({ workspace: fixture.root })
    const runId = '20261025T09000000Z'
    // A record with a BOM and CRLF: `writeTextAtomic(..., { verbatim: true })` is the only way
    // those bytes come back, and "the same text" would silently lose both.
    const bytes = `\uFEFF${JSON.stringify({ schemaVersion: 1, runId, chapterId: 'ch-0001', reviewer: 'model-a', createdAt: '2026-10-25T09:55:01.123Z', dimensions: [], opinions: [], rejected: [], scores: null }, null, 2).replaceAll('\n', '\r\n')}\r\n`
    const path = seedRun(fixture.root, 'ch-0001', runId, bytes)

    const cleaned = await writeCall(harness, '/purged/clean', {
      payload: { kind: 'review-run', target: `ch-0001/${runId}`, confirm: true },
    })
    assert.equal(cleaned.json.ok, true)
    const entryId = cleaned.json.value.cleaned.id
    assert.equal(existsSync(join(fixture.root, path)), false)
    assert.equal((await read(harness, '/review?chapterId=ch-0001')).json.value.runCount, 0)

    const restored = await writeCall(harness, '/purged/restore', { payload: { id: entryId } })
    assert.equal(restored.status, 200)
    assert.equal(restored.json.ok, true)
    assert.deepEqual(restored.json.value.files, ['.inkflow/review/ch-0001/20261025T09000000Z.json'], 'the answer says where the bytes went (project-relative, as every channel path is)')

    assert.equal(existsSync(join(fixture.root, path)), true, 'the run is back at the path it left')
    assert.equal(
      readFileSync(join(fixture.root, path)).equals(Buffer.from(bytes, 'utf8')),
      true,
      'the restored bytes are the deleted bytes: BOM and CRLF included',
    )
    assert.equal((await read(harness, '/review?chapterId=ch-0001')).json.value.runCount, 1, 'the panel lists it again')

    // The area is empty again, and the record says a restore happened.
    const after = await read(harness, '/purged')
    assert.equal(after.json.value.total, 0)
    assert.equal(existsSync(join(fixture.root, '.inkflow', 'purged', 'review', 'ch-0001', `${runId}.json`)), false)
    const records = auditRecords(fixture.root)
    assert.match(records.map((record) => record.text).join('\n'), /还原/)
  } finally {
    fixture.done()
  }
})

test('还原：目标已存在时零写入（作者现有状态优先），副本留在回收区', async () => {
  const fixture = scaffold()
  try {
    const harness = createHarness({ workspace: fixture.root })
    const runId = '20261025T09000000Z'
    const path = seedRun(fixture.root, 'ch-0001', runId)
    const cleaned = await writeCall(harness, '/purged/clean', {
      payload: { kind: 'review-run', target: `ch-0001/${runId}`, confirm: true },
    })
    const entryId = cleaned.json.value.cleaned.id
    // The author (or another session) recreates the path after the cleanup. The empty run
    // directory is pruned by the cleanup, so the recreation makes it again.
    mkdirSync(dirname(join(fixture.root, path)), { recursive: true })
    writeFileSync(join(fixture.root, path), '{"schemaVersion":1,"runId":"newer","chapterId":"ch-0001"}\n', 'utf8')
    const newerBytes = readFileSync(join(fixture.root, path))

    const refused = await writeCall(harness, '/purged/restore', { payload: { id: entryId } })
    assert.equal(refused.status, 409)
    assert.equal(refused.json.error.code, 'PURGE_TARGET_EXISTS')
    assert.equal(readFileSync(join(fixture.root, path)).equals(newerBytes), true, 'the newer file was not overwritten')
    assert.equal((await read(harness, '/purged')).json.value.total, 1, 'the copy stays in the area')
  } finally {
    fixture.done()
  }
})

test('还原：清单里越界的 path 一律读不出来（`..`、绝对路径、其它子目录）', async () => {
  const cases = ['../chapters/x.md', 'C:\\Windows\\x.json', 'jobs/20261025-draft.json', '.gitignore', 'review/../chapters/x.md']
  for (const path of cases) {
    const fixture = scaffold()
    try {
      const harness = createHarness({ workspace: fixture.root })
      mkdirSync(join(fixture.root, '.inkflow', 'purged'), { recursive: true })
      writeFileSync(
        join(fixture.root, '.inkflow', 'purged', 'index.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            entries: [
              {
                id: 'e1',
                kind: 'review-run',
                target: 'ch-0001/run',
                label: 'x',
                deletedAt: '2026-10-25T09:55:01.123Z',
                bytes: 1,
                sha256: 'a'.repeat(64),
                reason: 'author_cleanup',
                files: [{ path, bytes: 1, sha256: 'a'.repeat(64) }],
              },
            ],
          },
          null,
          2,
        )}\n`,
        'utf8',
      )
      const listed = await read(harness, '/purged')
      assert.equal(listed.json.ok, false, `${path} must not be restorable, so the area refuses the row`)
      assert.equal(listed.json.error.code, 'PURGE_MANIFEST_INVALID')
    } finally {
      fixture.done()
    }
  }
})

test('还原：未知 id 是 404，不猜最近一条', async () => {
  const fixture = scaffold()
  try {
    const harness = createHarness({ workspace: fixture.root })
    const refused = await writeCall(harness, '/purged/restore', { payload: { id: 'nope' } })
    assert.equal(refused.status, 404)
    assert.equal(refused.json.error.code, 'PURGE_ENTRY_NOT_FOUND')
    assert.equal((await writeCall(harness, '/purged/restore', { payload: {} })).json.error.code, 'invalid-field')
  } finally {
    fixture.done()
  }
})

// ---------------------------------------------------------------------------
// 5. The panels' pure decisions (no React, no network: `*-model.ts` rules)
// ---------------------------------------------------------------------------

/** Bundle one client model on the fly — the panel tests' own trick (same compiler). */
async function loadClientModel(file) {
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const esbuild = require('esbuild')
  const built = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client', file)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    write: false,
    logLevel: 'silent',
  })
  const code = Buffer.from(built.outputFiles[0].text, 'utf8').toString('base64')
  return import(`data:text/javascript;base64,${code}`)
}

function proposalRow(overrides = {}) {
  return {
    proposalId: 'pr-00000001',
    chapterId: 'ch-0001',
    path: CHAPTER,
    title: '第一章 开篇',
    createdAt: '2026-10-25T09:00:00.000Z',
    status: 'open',
    counts: { total: 2, pending: 0, accepted: 2, rejected: 0 },
    source: { kind: 'revised-body', label: 'session-model' },
    decision: null,
    apply: null,
    rollback: null,
    ...overrides,
  }
}

/** A `GET /proposal` envelope with `rows` + the host's full-population `counts`. */
function proposalEnvelope({ rows, counts, total = rows.length, limit = 50 }) {
  return {
    pluginVersion: '0.0.0-test',
    sessionId: 'session-1',
    root: '/book',
    proposals: rows,
    total,
    returned: rows.length,
    truncated: total > rows.length,
    counts,
    detail: null,
  }
}

test('面板纯模型：提案首屏只列 open，已结束的进折叠组且计数同一口径', async () => {
  const model = await loadClientModel('proposal-model.ts')
  const rows = [
    proposalRow({ proposalId: 'pr-00000003' }),
    proposalRow({ proposalId: 'pr-00000002', status: 'applied' }),
    proposalRow({ proposalId: 'pr-00000001' }),
  ]
  const page = model.readProposalPage({ ok: true, status: 200, value: proposalEnvelope({ rows, counts: { open: 2, applied: 1, rolledBack: 0 } }) }, false)
  const split = model.splitProposals(page)
  assert.deepEqual(split.open.map((row) => row.proposalId), ['pr-00000003', 'pr-00000001'])
  assert.deepEqual(split.closed.map((row) => row.proposalId), ['pr-00000002'])
  assert.equal(split.closedCount, 1)
  assert.equal(
    model.describeTotals(page).includes('待决定 2'),
    true,
    'the header counts the same split the list draws, not a second tally',
  )
  assert.equal(model.describeTotals(page).includes('已结束 1'), true)

  // A truncated page says so instead of under-reporting what it did not fetch.
  const big = model.readProposalPage(
    { ok: true, status: 200, value: proposalEnvelope({ rows, counts: { open: 5, applied: 2, rolledBack: 1 }, total: 8 }) },
    true,
  )
  const bigSplit = model.splitProposals(big)
  assert.equal(bigSplit.closedCount, 3, 'counts come from the host when the page only holds part of the book')
  assert.equal(model.describeTotals(big).includes('待决定 5'), true)
  assert.equal(model.describeTotals(big).includes('本页列出 3 个'), true)
})

test('面板纯模型：回收区条目按页面分拣，清理与还原的请求体是同一个形状', async () => {
  const model = await loadClientModel('purge-model.ts')
  const value = model.readPurgedValue({
    manifestPath: '.inkflow/purged/index.json',
    total: 2,
    bytes: 300,
    entries: [
      {
        id: 'e1',
        kind: 'review-run',
        target: 'ch-0001/20261025T09000000Z',
        label: 'ch-0001 · 运行 20261025T09000000Z',
        deletedAt: '2026-10-25T09:55:01.123Z',
        bytes: 120,
        present: true,
        files: [{ path: 'review/ch-0001/20261025T09000000Z.json', bytes: 120, sha256: 'a'.repeat(64) }],
      },
      {
        id: 'e2',
        kind: 'proposal',
        target: 'pr-00000002',
        label: 'pr-00000002 · 第一章 开篇 · applied',
        deletedAt: '2026-10-25T09:56:01.123Z',
        bytes: 180,
        present: false,
        files: [{ path: 'proposals/pr-00000002/meta.json', bytes: 180, sha256: 'b'.repeat(64) }],
      },
    ],
  })
  assert.equal(value.entries.length, 2)
  assert.equal(value.bytes, 300)
  assert.deepEqual(model.purgedFor(value, 'review-run').map((entry) => entry.id), ['e1'])
  assert.deepEqual(model.purgedFor(value, 'proposal').map((entry) => entry.id), ['e2'])
  assert.match(model.describePurgedEntry(value.entries[0]), /120 字节/)
  assert.match(model.describePurgedEntry(value.entries[1]), /副本已不在/, 'a missing copy says so instead of pretending')
  assert.deepEqual(model.cleanPayload('review-run', 'ch-0001/run-1'), { kind: 'review-run', target: 'ch-0001/run-1', confirm: true })
  assert.deepEqual(model.restorePayload('e1'), { id: 'e1' })
  assert.equal(model.cleanActionLabel(false), '清理')
  assert.match(model.cleanActionLabel(true), /确认清理/)
  assert.equal(model.readPurgedValue(undefined).entries.length, 0)
})
