/**
 * The impact report (#34, conventions §5.6, roadmap X-15).
 *
 * What this suite has to prove, and why each half matters:
 *
 *   1. **Five reference sites, one answer.** 改设定 is the most dangerous action a
 *      long-form author takes, so "which chapters would this touch" must not be a
 *      guess: the report reads `entity_mentions` (#29) for the manuscript,
 *      `relations` for the graph, and — because the index has no table yet for
 *      them — the timeline / ledger / foreshadowing files for the other three.
 *   2. **Read-only, provably.** The report is the thing the author looks at
 *      *before* deciding, so a listing that rewrites anything is unusable. The
 *      tests hash the whole project tree (bytes + mtimes, `tests/hash-tree.mjs`)
 *      around every listing and require it unchanged.
 *   3. **The plan is part of the listing.** `?slug=` previews the rename target
 *      and its blockers without writing, which is exactly what the panel's
 *      confirmation dialog shows; cancelling is therefore zero writes by
 *      construction rather than by discipline.
 *   4. **Degradation is not emptiness.** Without an index the mention and
 *      relation halves cannot be answered — the report says so instead of
 *      claiming the book never mentions the entry.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { apply, buildImpact, buildIndex } from '../lib/index.js'
import { hashTree } from './hash-tree.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']

/** The world entry every assertion is about; its id is its path (no `id:` in the file). */
const ENTRY_TITLE = '白云观'
/** Where the acceptance rename puts it: same category directory, new file name. */
const NEW_ID_UNUSED = 'world/门派/云台观.md'
const ENTRY_ID = 'world/门派/白云观.md'

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-impact-'))
}

function scaffold(root) {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '影响面测试' }, null, 2)}\n`, 'utf8')
}

function writeMarkdown(root, relativePath, frontmatterLines, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = frontmatterLines.length > 0 ? `---\n${frontmatterLines.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

/**
 * Five chapters, three of which name 白云观 — the acceptance shape, in one fixture:
 *
 *   ch-1 names it twice, ch-3 once, ch-5 once, ch-2/ch-4 never name it.
 *
 * The other four reference sites each point at the same entry exactly once, so a
 * section that silently reads the wrong field shows up as a wrong count rather
 * than as a plausible-looking list.
 */
function sampleBook(root) {
  scaffold(root)
  writeMarkdown(root, 'chapters/vol-01/0001-甲.md', ['id: ch-1', 'title: 甲', 'seq: 1'], '白云观的山门在半山腰，白云观三个字刻在石上。')
  writeMarkdown(root, 'chapters/vol-01/0002-乙.md', ['id: ch-2', 'title: 乙', 'seq: 2'], '清音走进山门，没有说话。')
  writeMarkdown(root, 'chapters/vol-01/0003-丙.md', ['id: ch-3', 'title: 丙', 'seq: 3'], '白云观里钟声一响。')
  writeMarkdown(root, 'chapters/vol-01/0004-丁.md', ['id: ch-4', 'title: 丁', 'seq: 4'], '山下起了雾。')
  writeMarkdown(root, 'chapters/vol-01/0005-戊.md', ['id: ch-5', 'title: 戊', 'seq: 5'], '他又回白云观。')

  writeMarkdown(root, 'characters/清音.md', ['name: 清音', 'group: 白云观'], '白云观弟子。')
  writeMarkdown(root, 'world/门派/白云观.md', ['title: 白云观', 'category: 门派'], '山中道观。')

  writeMarkdown(root, 'relations/清音-白云观.md', [
    'source: characters/清音.md',
    `target: ${ENTRY_ID}`,
    'kind: character',
    'title: 清音 与 白云观',
  ])
  writeMarkdown(root, 'timeline/入门.md', [
    'title: 入门',
    'worldTime: 2020-01',
    'narrativeOrder: 1',
    'chapterId: ch-1',
    'participants: characters/清音.md',
    `place: ${ENTRY_ID}`,
    'status: confirmed',
  ])
  writeMarkdown(root, 'timeline/斗法.md', [
    'title: 斗法',
    'worldTime: 2020-02',
    'narrativeOrder: 2',
    `participants: [characters/清音.md, ${ENTRY_ID}]`,
    'status: confirmed',
  ])
  writeMarkdown(root, 'facts/白云观.md', [`subject: ${ENTRY_ID}`, 'title: 白云观'], '- attribute: 位置 | value: 苍山 | source: manual\n')
  writeMarkdown(root, 'foreshadowing/古钟.md', [
    'title: 古钟',
    'status: planted',
    `linkedEntities: [${ENTRY_ID}]`,
  ])
}

/** A second world entry, only for the ambiguity case. */
function addSecondEntry(root) {
  writeMarkdown(root, 'world/门派/白云观旧址.md', ['title: 白云观旧址', 'category: 门派'], '旧观。')
}

function readReport(result) {
  assert.equal(result.status, 200, `expected 200, got ${String(result.status)}: ${JSON.stringify(result.body)}`)
  assert.equal(result.body.ok, true, JSON.stringify(result.body))
  return result.body.value
}

function sourceFor(root) {
  return { sessionId: 'session-impact', root }
}

/** The CAS baseline the panel gets from a listing and sends back on the rename. */
function fingerprintOf(root, relativePath) {
  const bytes = readFileSync(join(root, relativePath))
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
}

function chapterIds(value) {
  return value.chapters.map((row) => row.chapterId).sort()
}

// ---------------------------------------------------------------------------
// 1. The listing: five reference sites + totals
// ---------------------------------------------------------------------------

test('impact: a world entry lists the three chapters that mention it, with titles and counts', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)

    const value = readReport(await buildImpact(sourceFor(root), '1.0.0', { kind: 'world', id: ENTRY_ID }))

    assert.equal(value.kind, 'world')
    assert.equal(value.id, ENTRY_ID, 'an entry without `id:` is addressed by its project-relative path')
    assert.equal(value.path, ENTRY_ID)
    assert.equal(value.title, ENTRY_TITLE)
    assert.equal(value.pinnedId, false, 'nothing has been renamed yet, so id === path')

    assert.deepEqual(chapterIds(value), ['ch-1', 'ch-3', 'ch-5'], 'exactly the chapters whose body names the entry')
    const byId = new Map(value.chapters.map((row) => [row.chapterId, row]))
    assert.equal(byId.get('ch-1').title, '甲', 'the row carries the chapter title, not just its id')
    assert.equal(byId.get('ch-1').mentions, 2, 'a chapter that says the name twice is two occurrences')
    assert.equal(byId.get('ch-1').seq, 1)
    assert.equal(byId.get('ch-3').mentions, 1)
    assert.equal(byId.get('ch-5').mentions, 1)
    assert.match(byId.get('ch-1').path, /^chapters\/vol-01\/0001-/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('impact: relations, timeline events, ledger entries and foreshadow links all land in one report', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)

    const value = readReport(await buildImpact(sourceFor(root), '1.0.0', { kind: 'world', id: ENTRY_ID }))

    assert.equal(value.relations.length, 1)
    assert.equal(value.relations[0].role, 'target', 'the entry is the relation\'s target, and the report says which end it is')
    assert.equal(value.relations[0].other, 'characters/清音.md', 'the other end is named, so the author sees what would break')
    assert.equal(value.relations[0].path, 'relations/清音-白云观.md')

    const events = [...value.events].sort((left, right) => (left.path < right.path ? -1 : 1))
    assert.deepEqual(
      events.map((row) => [row.path, row.role]),
      [
        ['timeline/入门.md', 'place'],
        ['timeline/斗法.md', 'participant'],
      ],
      'both timeline reference fields are covered: `place` as well as `participants`',
    )

    assert.deepEqual(value.facts.map((row) => row.path), ['facts/白云观.md'], 'the ledger file whose `subject` is this entry')
    assert.deepEqual(value.foreshadowing.map((row) => row.path), ['foreshadowing/古钟.md'], 'the foreshadow whose `linkedEntities` names it')

    assert.deepEqual(value.totals, {
      chapters: 3,
      mentions: 4,
      relations: 1,
      events: 2,
      facts: 1,
      foreshadowing: 1,
      total: 3 + 4 + 1 + 2 + 1 + 1,
    }, 'totals add up what the sections list — the number the dialog shows first')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('impact: listing an entry writes nothing — the whole tree hash is unchanged', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)

    // Something must be read between the two snapshots for the comparison to mean
    // anything: the report is the read, the tree must not move.
    const before = hashTree(root)
    const bytesBefore = readFileSync(join(root, ENTRY_ID), 'utf8')
    const value = readReport(await buildImpact(sourceFor(root), '1.0.0', { kind: 'world', id: ENTRY_ID }))
    assert.equal(value.totals.chapters, 3, 'the report really ran')
    assert.equal(hashTree(root), before, 'a listing must not touch a byte (or an mtime) anywhere in the project')
    assert.equal(readFileSync(join(root, ENTRY_ID), 'utf8'), bytesBefore)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. Addressing: id, fuzzy title, ambiguity, absence
// ---------------------------------------------------------------------------

test('impact: a title fragment finds the entry, and an ambiguous fragment answers candidates instead of picking one', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    addSecondEntry(root)
    await buildIndex(root)

    const byTitle = readReport(await buildImpact(sourceFor(root), '1.0.0', { kind: 'world', title: '白云观' }))
    assert.equal(byTitle.id, ENTRY_ID, 'an exact title still resolves to the one entry that has it')

    const ambiguous = await buildImpact(sourceFor(root), '1.0.0', { kind: 'world', title: '白云' })
    assert.equal(ambiguous.status, 400)
    assert.equal(ambiguous.body.ok, false)
    assert.equal(ambiguous.body.error.code, 'TITLE_AMBIGUOUS')
    assert.deepEqual(
      ambiguous.body.error.candidates.map((row) => row.id).sort(),
      [ENTRY_ID, 'world/门派/白云观旧址.md'],
      'every candidate is listed: silently picking one would report the wrong impact',
    )

    const missing = await buildImpact(sourceFor(root), '1.0.0', { kind: 'world', id: 'world/门派/不存在.md' })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'impact-entity-not-found')

    const noSelector = await buildImpact(sourceFor(root), '1.0.0', { kind: 'world' })
    assert.equal(noSelector.status, 400)
    assert.equal(noSelector.body.error.code, 'SELECTOR_REQUIRED')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('impact: without an index the report says so instead of answering "no chapters"', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    // No buildIndex(): the mentions/relations halves have no cache to read.

    const value = readReport(await buildImpact(sourceFor(root), '1.0.0', { kind: 'world', id: ENTRY_ID }))
    assert.equal(value.indexAvailable, false)
    assert.equal(value.indexState, 'missing')
    assert.deepEqual(value.chapters, [])
    assert.deepEqual(value.relations, [])
    // The three file-read halves still answer: they never depended on the cache.
    assert.equal(value.events.length, 2)
    assert.equal(value.facts.length, 1)
    assert.equal(value.foreshadowing.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. The plan: what a rename would produce, still without writing
// ---------------------------------------------------------------------------

test('impact: ?slug= previews the rename target and its blockers, and the preview writes nothing', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    addSecondEntry(root)
    await buildIndex(root)
    const before = hashTree(root)

    const planned = readReport(await buildImpact(sourceFor(root), '1.0.0', { kind: 'world', id: ENTRY_ID, slug: '云台观' }))
    assert.deepEqual(planned.rename, {
      from: ENTRY_ID,
      to: 'world/门派/云台观.md',
      slug: '云台观',
      title: null,
      pinId: ENTRY_ID,
      targetExists: false,
      blockers: [],
    }, 'the plan keeps the category directory and pins the OLD id (ADR-0014)')

    const blocked = readReport(await buildImpact(sourceFor(root), '1.0.0', { kind: 'world', id: ENTRY_ID, slug: '白云观旧址' }))
    assert.equal(blocked.rename.targetExists, true)
    assert.deepEqual(blocked.rename.blockers, ['TARGET_EXISTS'], 'the dialog can refuse before the author clicks 确认')

    assert.equal(hashTree(root), before, 'planning is read-only: the entry file and its directory are untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('impact: a chapter-side entity (character) reports the chapters that name it', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)

    // 清音 is named in ch-2's body and in ch-1's `group: 白云观`… no: `group` is not
    // scanned, only chapter prose is. So exactly one chapter mentions it, and the
    // report must not invent the others from the world entry's own text.
    const value = readReport(await buildImpact(sourceFor(root), '1.0.0', { kind: 'characters', id: 'characters/清音.md' }))
    assert.deepEqual(chapterIds(value), ['ch-2'])
    assert.deepEqual(value.relations.map((row) => row.role), ['source'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. Client half: the dialog's pure view model
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url)

/**
 * The two client models, bundled on the fly (the trick `panel-bundle.test.js` and
 * `library-panel.test.js` use: the project's own esbuild, no TS loader). The
 * impact model imports the library model, so one bundle covers both.
 */
async function loadClientModels() {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client/impact-model.ts')],
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

test('impact (client): the digest turns the report into the dialog rows, chapters first', async () => {
  const model = await loadClientModels()
  const plainReport = {
    kind: 'world',
    id: ENTRY_ID,
    title: ENTRY_TITLE,
    indexAvailable: true,
    indexState: 'fresh',
    chapters: [
      { chapterId: 'ch-1', title: '甲', seq: 1, path: 'chapters/vol-01/0001-甲.md', mentions: 2, firstOffset: 0 },
      { chapterId: 'ch-3', title: '丙', seq: 3, path: 'chapters/vol-01/0003-丙.md', mentions: 1, firstOffset: 0 },
    ],
    relations: [{ id: 'r-1', path: 'relations/清音-白云观.md', title: '清音 与 白云观', role: 'target', other: 'characters/清音.md' }],
    events: [{ id: 't-1', path: 'timeline/入门.md', title: '入门', role: 'place' }],
    facts: [{ path: 'facts/白云观.md', subject: ENTRY_ID, title: '白云观', lines: 1 }],
    foreshadowing: [{ path: 'foreshadowing/古钟.md', title: '古钟', status: 'planted' }],
    totals: { chapters: 2, mentions: 3, relations: 1, events: 1, facts: 1, foreshadowing: 1, total: 9 },
  }
  const digest = model.buildImpactDigest(plainReport)

  assert.equal(digest.available, true)
  assert.equal(digest.headline, '2 章提到 · 共 9 处引用')
  assert.deepEqual(
    digest.groups.map((group) => [group.key, group.total]),
    [
      ['chapters', 2],
      ['relations', 1],
      ['events', 1],
      ['facts', 1],
      ['foreshadowing', 1],
    ],
    'the five reference sites, in the order the dialog lists them',
  )
  assert.deepEqual(digest.groups[0].rows, ['第 1 章 甲 · 2 处', '第 3 章 丙 · 1 处'])
  assert.equal(digest.groups[2].rows[0], '入门 · 地点')

  // A book that titles its chapters `第3章 清音报信` must not be printed as
  // "第 3 章 第3章 清音报信" — the real corpus is written that way.
  const numbered = model.buildImpactDigest({
    ...plainReport,
    chapters: [{ chapterId: 'ch-3', title: '第3章 清音报信', seq: 3, path: 'chapters/vol-01/0003-x.md', mentions: 41, firstOffset: 0 }],
  })
  assert.equal(numbered.groups[0].rows[0], '第3章 清音报信 · 41 处')

  const unavailable = model.buildImpactDigest({
    kind: 'world',
    id: ENTRY_ID,
    indexAvailable: false,
    indexState: 'missing',
    chapters: [],
    relations: [],
    events: [],
    facts: [],
    foreshadowing: [],
    totals: { chapters: 0, mentions: 0, relations: 0, events: 0, facts: 0, foreshadowing: 0, total: 0 },
  })
  assert.equal(unavailable.available, false)
  assert.match(unavailable.notice, /索引/u, 'a missing index is reported as "cannot answer", never as "no mentions"')
})

test('impact (client): the rename request carries the address, the new slug and the baseline', async () => {
  const model = await loadClientModels()
  const payload = model.renamePayload({
    kind: 'world',
    id: ENTRY_ID,
    slug: '云台观',
    title: '云台观',
    fingerprint: { sha256: 'a'.repeat(64), size: 120, mtimeMs: 1 },
  })
  assert.deepEqual(payload, {
    kind: 'world',
    id: ENTRY_ID,
    slug: '云台观',
    title: '云台观',
    expected: { sha256: 'a'.repeat(64), size: 120, mtimeMs: 1 },
  })
  assert.equal(model.renamePayload({ kind: 'world', id: ENTRY_ID, fingerprint: null }), null, 'no baseline → the dialog refuses to send')
  assert.equal(model.describeRenameError({ code: 'TARGET_EXISTS' }).includes('已存在'), true)
  assert.equal(model.describeRenameError({ code: 'FILE_CHANGED' }).includes('没有写入'), true)
  assert.match(model.impactQuery('world', ENTRY_ID), /^\/impact\?kind=world&id=/u)
})

// ---------------------------------------------------------------------------
// 5. The routes themselves: registered, GET-only / POST-only, body allowlist
//
// The domain tests above call `buildImpact` / `renameEntity` directly, so a route
// that was never registered (or was registered with the wrong verbs) would pass
// them. This harness is the smallest one that proves otherwise: a fake Cordis
// context records the `/inkflow` prefix route, and the three Host services a
// session resolves through are faked (the same shape `internal-channel.test.js`
// uses — that file also explains why nothing needs a real server).
// ---------------------------------------------------------------------------

function createHarness({ workspace, sessionId = 'session-1' }) {
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
      if (name === 'workspaceRegistry') return { list: () => [] }
      if (name === 'sessions') return { get: (id) => (id === sessionId ? { id, header: { cwd: workspace } } : undefined) }
      if (name === 'workingDirectory') return { get: (session) => session?.header?.cwd ?? workspace }
      return undefined
    },
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    tools: { register: () => () => {} },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  apply(ctx, { dataDir: join(tmpdir(), 'inkflow-impact-state') })
  return { ctx, routes }
}

async function internalCall(harness, path, { method = 'GET', body, sessionId = 'session-1' } = {}) {
  const route = harness.routes.find((entry) => entry.path === '/inkflow')
  assert.ok(route, 'expected a /inkflow prefix route')
  const headers = { host: '127.0.0.1:2149' }
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
  if (payload !== undefined) {
    headers['content-type'] = 'application/json'
    headers['content-length'] = String(payload.length)
  }
  const separator = path.includes('?') ? '&' : '?'
  const request = { url: `/inkflow/internal${path}${separator}sessionId=${encodeURIComponent(sessionId)}`, method, headers, socket: { remoteAddress: '127.0.0.1' } }
  if (payload !== undefined) {
    request[Symbol.asyncIterator] = async function* iterate() {
      yield payload
    }
  }
  const response = {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(key, value) {
      response.headers[key] = value
    },
    end(text) {
      response.body = text
    },
  }
  await route.handler(request, response)
  return { status: response.statusCode, headers: response.headers, json: response.body === undefined ? undefined : JSON.parse(response.body) }
}

test('impact: both routes are registered with their own verbs and refuse an undeclared field', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)
    const harness = createHarness({ workspace: root })

    const listed = await internalCall(harness, `/impact?kind=world&id=${encodeURIComponent(ENTRY_ID)}`)
    assert.equal(listed.status, 200, JSON.stringify(listed.json))
    assert.equal(listed.json.ok, true)
    assert.equal(listed.json.value.id, ENTRY_ID)
    assert.equal(listed.json.value.totals.chapters, 3)

    // GET on the write route: the verb is declared per route (ADR-0008 D3).
    const wrongVerb = await internalCall(harness, '/impact/rename')
    assert.equal(wrongVerb.status, 405)
    assert.match(String(wrongVerb.headers['allow'] ?? wrongVerb.headers['Allow']), /POST/u)

    // A write route accepts only the fields it declared. (`path` would be refused a
    // step earlier as a path parameter — this asserts the allowlist itself.)
    const unexpected = await internalCall(harness, '/impact/rename', {
      method: 'POST',
      body: { kind: 'world', id: ENTRY_ID, slug: '云台观', force: true },
    })
    assert.equal(unexpected.status, 400)
    assert.equal(unexpected.json.error.code, 'UNEXPECTED_BODY_FIELD')

    // …and the real write goes through the same route.
    const renamed = await internalCall(harness, '/impact/rename', {
      method: 'POST',
      body: { kind: 'world', id: ENTRY_ID, slug: '云台观', expected: fingerprintOf(root, ENTRY_ID) },
    })
    assert.equal(renamed.status, 200, JSON.stringify(renamed.json))
    assert.equal(renamed.json.value.id, ENTRY_ID)
    assert.equal(renamed.json.value.path, NEW_ID_UNUSED)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
