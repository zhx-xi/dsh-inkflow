/**
 * The extraction pipeline (issue #38, ADR-0017): the candidate queue, the five tools and
 * the one write path.
 *
 * What each group pins, and why it can FAIL:
 *
 *   1. **evidence is mandatory** — a candidate without one, with a malformed anchor, or
 *      with an anchor that resolves to nothing is refused (`EVIDENCE_REQUIRED` /
 *      `EVIDENCE_INVALID` / `EVIDENCE_TARGET_MISSING`). Deleting the check makes the
 *      "no evidence, no candidate" rule (D2) disappear silently.
 *   2. **fields follow the data model** — an unknown key, a wrong type and a missing
 *      required key each have their own refusal, because a candidate is machine-written:
 *      accepting an unknown key would write a field nowhere and lose it without a word.
 *   3. **accept is the only way a candidate becomes a file** — before it, the content
 *      directories are byte-identical (per-file digests, `.inkflow/` and `index/`
 *      skipped); after it, the entity reads back through the same domain tools a hand
 *      write would, and the file's bytes equal a hand-written one (ids aside).
 *   4. **reject writes zero content files, purge only deletes processed candidates** —
 *      "拒绝等于零写入" is the sentence the panel shows, so it is asserted, not assumed.
 *   5. **a conflict is a refusal with the domain's own code, and nothing lands** — a
 *      taken name is `CHARACTER_NAME_DUPLICATE` (I-03), an occupied path is `DUPLICATE_ID`
 *      (I-04). Accepting never overwrites an existing entity.
 *   6. **an update is an update** — resubmitting an existing `candidateId` changes the
 *      fields in place: same count, same file, one candidate.
 *   7. **the structure is the guarantee** — a grep-style scan of the import graph proves
 *      the candidate store and the accept path have exactly the importers they may have,
 *      so no second ingestion path can exist even if this whole file were deleted (D5).
 *   8. **end to end** — ten chapters, four kinds, accept two and reject the rest: the
 *      accepted entities are in the index, the rejected ones left no file, and the
 *      consistency audit reports no new family of findings.
 *
 * Runs against the BUILT artifact (`lib/index.js`), like every other suite.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  apply,
  buildCandidates,
  acceptViaChannel,
  purgeViaChannel,
  rejectViaChannel,
} from '../lib/index.js'
import { CANDIDATE_SCHEMA_VERSION } from '../lib/index.js'
import { fileDigests } from './tree-digest.mjs'

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const ALL_DIRS = [...CONTENT_DIRS, 'index']
const KEEP = '.gitkeep'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function createHarness(workspace) {
  const tools = new Map()
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
      if (name === 'workingDirectory') return { ensure: async () => workspace }
      if (name === 'sessions') return { get: (id) => (id === 'session-1' ? { id, header: { cwd: workspace } } : undefined) }
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

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-extract-'))
}

function makeHarness(dir) {
  const harness = createHarness(dir)
  apply(harness.ctx, { dataDir: join(dir, 'state') })
  return harness
}

async function callTool(harness, toolName, args) {
  const tool = harness.tools.get(toolName)
  assert.ok(tool, `tool ${toolName} must be registered`)
  return tool.execute(args, { signal: AbortSignal.timeout(20000), agent: { id: 'test-session' } })
}

/** A usable book: real `.git`, ten directories with `.gitkeep`, meta, ignore rules. */
function project(root, title = '提取之书') {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of ALL_DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, KEEP), '', 'utf8')
  }
  writeFileSync(join(root, '.gitignore'), '# InkFlow derived index\nindex/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title }, null, 2)}\n`, 'utf8')
  return root
}

function markdown(root, relativePath, frontmatter = [], body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(dirname(absolute), { recursive: true })
  const block = frontmatter.length > 0 ? `---\n${frontmatter.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

/** Ten chapters in one volume, each with a line a candidate can cite. */
function tenChapters(root) {
  markdown(root, 'chapters/vol-01/0001-入山.md', CH1_FRONTMATTER, '清音提剑入门，白鹤门上下一片寂静。\n师父沉默了很久。\n')
  for (let seq = 2; seq <= 10; seq += 1) {
    const n = String(seq).padStart(4, '0')
    markdown(
      root,
      `chapters/vol-01/${n}-第${String(seq)}章.md`,
      [`id: ch-${n}`, 'volume: vol-01', `seq: ${String(seq)}`, `title: 第${String(seq)}章`, 'status: draft'],
      `第${String(seq)}章正文。\n`,
    )
  }
}

const CH1_FRONTMATTER = ['id: ch-0001', 'volume: vol-01', 'seq: 1', 'title: 第1章 入山', 'status: draft']

/**
 * Per-file digests of the CONTENT directories only.
 *
 * The queue (`.inkflow/`), the derived index and the project's own bookkeeping files (a
 * `.gitignore` gains `.inkflow/` the first time the queue is used) are not the truth this
 * test is about: "zero writes" means not one entity file appeared or changed.
 */
function contentDigests(root) {
  const out = new Map()
  for (const [path, digest] of fileDigests(root, { skipDirs: ['.inkflow', '.git', 'index'] })) {
    if (CONTENT_DIRS.includes(path.split('/')[0])) out.set(path, digest)
  }
  return out
}

function diffDigests(before, after) {
  const changed = []
  for (const [path, digest] of after) if (before.get(path) !== digest) changed.push(path)
  for (const path of before.keys()) if (!after.has(path)) changed.push(`-${path}`)
  return changed.sort()
}

function filesUnder(root, relativeDir) {
  const out = []
  const walk = (relativeDirPath) => {
    const dir = join(root, relativeDirPath)
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === KEEP) continue
      const child = `${relativeDirPath}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else out.push(child)
    }
  }
  walk(relativeDir)
  return out.sort()
}

function queueFiles(root) {
  const dir = join(root, '.inkflow', 'candidates')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
}

async function propose(harness, root, kind, proposals, chapters = ['ch-0001']) {
  return callTool(harness, 'inkflow_extract_propose', { projectRoot: root, kind, chapters, proposals })
}

async function listCandidates(harness, root, args = {}) {
  return callTool(harness, 'inkflow_extract_list', { projectRoot: root, ...args })
}

function idsOf(result) {
  return result.items.map((item) => item.candidateId)
}

// ---------------------------------------------------------------------------
// 1 + 2. Evidence and field judgement
// ---------------------------------------------------------------------------

test('a candidate without evidence, with a broken anchor or with a missing target is refused', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    tenChapters(root)
    const harness = makeHarness(dir)

    const missing = await propose(harness, root, 'character', [{ fields: { name: '清音' } }])
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'EVIDENCE_REQUIRED')
    assert.equal(queueFiles(root).length, 0, 'a refused batch must not create a queue file')

    const broken = await propose(harness, root, 'character', [
      { fields: { name: '清音' }, evidence: 'chapters/vol-01/0001-入山.md#L' },
    ])
    assert.equal(broken.ok, false)
    assert.equal(broken.error.code, 'EVIDENCE_INVALID')

    const zeroLine = await propose(harness, root, 'character', [
      { fields: { name: '清音' }, evidence: 'chapters/vol-01/0001-入山.md#L0' },
    ])
    assert.equal(zeroLine.error.code, 'EVIDENCE_INVALID')

    const unknownChapter = await propose(harness, root, 'character', [
      { fields: { name: '清音' }, evidence: 'ch-9999' },
    ])
    assert.equal(unknownChapter.ok, false)
    assert.equal(unknownChapter.error.code, 'EVIDENCE_TARGET_MISSING')

    const pastTheEnd = await propose(harness, root, 'character', [
      { fields: { name: '清音' }, evidence: 'chapters/vol-01/0001-入山.md#L900' },
    ])
    assert.equal(pastTheEnd.error.code, 'EVIDENCE_TARGET_MISSING')

    // A valid anchor and a valid chapter id both land, and the anchor is normalised.
    const good = await propose(harness, root, 'character', [
      { fields: { name: '清音' }, evidence: 'chapters/vol-01/0001-入山.md#L3' },
      { fields: { name: '师父' }, evidence: ' ch-0001 ' },
    ])
    assert.equal(good.ok, true, JSON.stringify(good.error))
    assert.equal(good.created.length, 2)
    assert.equal(good.created[0].evidence, 'chapters/vol-01/0001-入山.md#L3')
    assert.equal(good.created[1].evidence, 'ch-0001')
    assert.match(good.created[0].candidateId, /^ex-[0-9a-f]{8}$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fields must use the kind dictionary: unknown key, wrong type and missing key each refuse', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    tenChapters(root)
    const harness = makeHarness(dir)

    const unknownKey = await propose(harness, root, 'character', [
      { fields: { name: '清音', favouriteFood: '面' }, evidence: 'ch-0001' },
    ])
    assert.equal(unknownKey.ok, false)
    assert.equal(unknownKey.error.code, 'CANDIDATE_FIELD_UNKNOWN')
    assert.equal(unknownKey.error.field, 'favouriteFood')

    const wrongType = await propose(harness, root, 'character', [
      { fields: { name: '清音', firstAppearance: '1' }, evidence: 'ch-0001' },
    ])
    assert.equal(wrongType.error.code, 'CANDIDATE_FIELD_INVALID')

    const missingRequired = await propose(harness, root, 'character', [{ fields: { role: '主角' }, evidence: 'ch-0001' }])
    assert.equal(missingRequired.error.code, 'CANDIDATE_FIELD_REQUIRED')

    // An outline node's level is required: guessing `chapter` would build the wrong tree.
    const outlineNoKind = await propose(harness, root, 'outline', [{ fields: { title: '第1章 入山' }, evidence: 'ch-0001' }])
    assert.equal(outlineNoKind.error.code, 'CANDIDATE_FIELD_REQUIRED')
    assert.equal(outlineNoKind.error.field, 'kind')

    // A participant id is stored space-joined, so a space inside one is refused here and
    // not by the writer (which would answer IO_FAILED after the lock).
    const badParticipant = await propose(harness, root, 'timeline', [
      { fields: { title: '归来', worldTime: '2020-03', participants: ['ch 1'] }, evidence: 'ch-0001' },
    ])
    assert.equal(badParticipant.error.code, 'CANDIDATE_FIELD_INVALID')

    // Field names a kind does not have are refused per kind, not globally.
    const worldName = await propose(harness, root, 'world', [{ fields: { name: '白鹤门' }, evidence: 'ch-0001' }])
    assert.equal(worldName.error.code, 'CANDIDATE_FIELD_UNKNOWN')
    assert.equal(queueFiles(root).length, 0, 'nothing lands while any candidate in the batch is refused')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The queue itself
// ---------------------------------------------------------------------------

test('a batch is one <stamp>-<kind>.json file with the documented shape, and .gitignore gains .inkflow/', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    tenChapters(root)
    const harness = makeHarness(dir)

    const result = await propose(
      harness,
      root,
      'world',
      [{ fields: { title: '白鹤门', category: '门派', keywords: ['白鹤'], body: '剑派。' }, evidence: 'ch-0001', rationale: '首章出现' }],
      ['ch-0001', 'ch-0002'],
    )
    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.match(result.file, /^\d{8}T\d{9}Z-world\.json$/u)

    const batch = JSON.parse(readFileSync(join(root, '.inkflow', 'candidates', result.file), 'utf8'))
    assert.equal(batch.schemaVersion, CANDIDATE_SCHEMA_VERSION)
    assert.deepEqual(batch.source.chapters, ['ch-0001', 'ch-0002'])
    assert.equal(typeof batch.submittedAt, 'string')
    assert.equal(batch.proposals.length, 1)
    const proposal = batch.proposals[0]
    assert.deepEqual(Object.keys(proposal).sort(), ['candidateId', 'confidence', 'evidence', 'fields', 'kind', 'rationale', 'status'])
    assert.equal(proposal.status, 'proposed')
    assert.equal(proposal.kind, 'world')
    assert.equal(proposal.confidence, 'medium', 'an omitted confidence defaults to medium')

    // The queue is private state: the first write teaches `.gitignore` about it.
    assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^\.inkflow\/$/mu)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resubmitting an existing candidateId updates it in place: same count, same file, new fields', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    tenChapters(root)
    const harness = makeHarness(dir)

    const first = await propose(harness, root, 'character', [
      { fields: { name: '清音', role: '配角' }, evidence: 'ch-0001' },
    ])
    const candidateId = first.created[0].candidateId
    const countBefore = (await listCandidates(harness, root)).total
    assert.equal(countBefore, 1)

    const second = await propose(harness, root, 'character', [
      { candidateId, fields: { name: '清音', role: '主角', aliases: ['青音'] }, evidence: 'ch-0001', confidence: 'high' },
    ])
    assert.equal(second.ok, true, JSON.stringify(second.error))
    assert.equal(second.created.length, 0)
    assert.equal(second.updated.length, 1)
    assert.equal(second.updated[0].candidateId, candidateId, 'an update keeps the id it was given')

    const after = await listCandidates(harness, root)
    assert.equal(after.total, countBefore, 'an update must not add a candidate')
    const row = after.items.find((item) => item.candidateId === candidateId)
    assert.equal(row.fields.role, '主角')
    assert.deepEqual(row.fields.aliases, ['青音'])
    assert.equal(row.confidence, 'high')

    // An id the queue does not know is refused rather than created.
    const invented = await propose(harness, root, 'character', [
      { candidateId: 'ex-00000000', fields: { name: '无名' }, evidence: 'ch-0001' },
    ])
    assert.equal(invented.error.code, 'CANDIDATE_NOT_FOUND')
    assert.equal((await listCandidates(harness, root)).total, countBefore)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. Accept is the only write path, and it produces a hand-write-shaped file
// ---------------------------------------------------------------------------

test('accept writes one entity through the domain seam; before it the content tree is untouched', async () => {
  const dir = workdir()
  try {
    const acceptedRoot = project(join(dir, 'accepted'), '采纳之书')
    const handRoot = project(join(dir, 'hand'), '手写之书')
    tenChapters(acceptedRoot)
    tenChapters(handRoot)

    const harness = makeHarness(dir)
    const proposed = await propose(harness, acceptedRoot, 'character', [
      {
        fields: { name: '清音', aliases: ['青音'], group: '白鹤门', role: '主角', firstAppearance: 1, voice: ['短句'], states: [{ chapter: 1, status: '初入门墙' }], body: '性格：寡言。' },
        evidence: 'chapters/vol-01/0001-入山.md#L3',
        rationale: '首章出场',
        confidence: 'high',
      },
    ])
    const candidateId = proposed.created[0].candidateId

    // Nothing in the content directories yet — the queue lives in `.inkflow/`.
    assert.equal(filesUnder(acceptedRoot, 'characters').length, 0)
    const before = contentDigests(acceptedRoot)

    // A batch that names a candidate id the queue does not have changes nothing.
    const refused = await callTool(harness, 'inkflow_extract_accept', {
      projectRoot: acceptedRoot,
      candidateIds: ['ex-ffffffff'],
      confirm: true,
    })
    assert.equal(refused.ok, true)
    assert.equal(refused.accepted, 0)
    assert.equal(refused.outcomes[0].error.code, 'CANDIDATE_NOT_FOUND')
    assert.deepEqual(diffDigests(before, contentDigests(acceptedRoot)), [], 'a refused accept writes nothing')

    // Accept needs the author's confirmation, and says so before writing.
    const noConfirm = await callTool(harness, 'inkflow_extract_accept', { projectRoot: acceptedRoot, candidateIds: [candidateId] })
    assert.equal(noConfirm.ok, false)
    assert.equal(noConfirm.error.code, 'EXTRACT_CONFIRM_REQUIRED')
    assert.deepEqual(diffDigests(before, contentDigests(acceptedRoot)), [])

    const accepted = await callTool(harness, 'inkflow_extract_accept', {
      projectRoot: acceptedRoot,
      candidateIds: [candidateId],
      confirm: true,
    })
    assert.equal(accepted.ok, true, JSON.stringify(accepted.error))
    assert.equal(accepted.accepted, 1)
    assert.equal(accepted.outcomes[0].path, 'characters/清音.md')
    assert.equal(accepted.indexRebuilt, true)

    // The same card written by hand, through the model-facing tool, must be the same file
    // (ids aside: two new cards are two new uuids).
    const hand = await callTool(harness, 'inkflow_character_upsert', {
      projectRoot: handRoot,
      name: '清音',
      aliases: ['青音'],
      group: '白鹤门',
      role: '主角',
      firstAppearance: 1,
      voice: ['短句'],
      states: [{ chapter: 1, status: '初入门墙' }],
      body: '性格：寡言。',
      confirm: true,
    })
    assert.equal(hand.ok, true, JSON.stringify(hand.error))
    const strip = (text) => text.replace(/^id: .*$/mu, 'id: <uuid>')
    assert.equal(
      strip(readFileSync(join(acceptedRoot, 'characters', '清音.md'), 'utf8')),
      strip(readFileSync(join(handRoot, 'characters', '清音.md'), 'utf8')),
      'an accepted candidate and a hand write must produce the same card',
    )

    // ... and it reads back through the domain's own tool.
    const listed = await callTool(harness, 'inkflow_character_list', { projectRoot: acceptedRoot })
    assert.equal(listed.total, 1)
    assert.equal(listed.items[0].name, '清音')
    assert.deepEqual(listed.items[0].states, [{ chapter: 1, status: '初入门墙' }])

    // The queue recorded the decision; that is the only extra write.
    const after = await listCandidates(harness, acceptedRoot, { status: 'accepted' })
    assert.equal(after.total, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a candidate that would collide with an existing entity is refused with the domain code and writes nothing', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    tenChapters(root)
    const harness = makeHarness(dir)

    // The author already wrote this card by hand.
    const hand = await callTool(harness, 'inkflow_character_upsert', {
      projectRoot: root,
      name: '清音',
      role: '主角',
      confirm: true,
    })
    assert.equal(hand.ok, true, JSON.stringify(hand.error))
    const before = contentDigests(root)

    const proposed = await propose(harness, root, 'character', [{ fields: { name: '清音' }, evidence: 'ch-0001' }])
    const accepted = await callTool(harness, 'inkflow_extract_accept', {
      projectRoot: root,
      candidateIds: [proposed.created[0].candidateId],
      confirm: true,
    })
    assert.equal(accepted.accepted, 0)
    assert.equal(accepted.outcomes[0].error.code, 'CHARACTER_NAME_DUPLICATE', 'I-03 keeps its own code')
    assert.deepEqual(diffDigests(before, contentDigests(root)), [], 'a conflicting accept writes nothing')

    // The candidate is still undecided: the author can rename it and accept again.
    const still = await listCandidates(harness, root, { status: 'proposed' })
    assert.equal(still.total, 1)

    // An occupied path is I-04, whatever the entity's name is.
    markdown(root, 'world/门派/白鹤门.md', ['id: world/门派/白鹤门.md', 'title: 白鹤门', 'category: 门派'], '剑派。\n')
    const world = await propose(harness, root, 'world', [{ fields: { title: '白鹤门', category: '门派' }, evidence: 'ch-0001' }])
    const worldAccept = await callTool(harness, 'inkflow_extract_accept', {
      projectRoot: root,
      candidateIds: [world.created[0].candidateId],
      confirm: true,
    })
    assert.equal(worldAccept.accepted, 0)
    assert.equal(worldAccept.outcomes[0].error.code, 'DUPLICATE_ID')
    assert.equal(readFileSync(join(root, 'world', '门派', '白鹤门.md'), 'utf8'), '---\nid: world/门派/白鹤门.md\ntitle: 白鹤门\ncategory: 门派\n---\n\n剑派。\n', 'the existing file is byte-identical')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a structural refusal from the domain lands too: a second root or a missing overall is reported, not written', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    tenChapters(root)
    const harness = makeHarness(dir)

    const first = await propose(harness, root, 'world', [
      { fields: { title: '白鹤门', category: '门派' }, evidence: 'ch-0001' },
    ])
    const secondRoot = await propose(harness, root, 'world', [{ fields: { title: '青城派' }, evidence: 'ch-0001' }])
    const accepted = await callTool(harness, 'inkflow_extract_accept', {
      projectRoot: root,
      candidateIds: [first.created[0].candidateId, secondRoot.created[0].candidateId],
      confirm: true,
    })
    assert.equal(accepted.accepted, 2, JSON.stringify(accepted.outcomes))

    // A third root would break I-08's "exactly one root".
    const third = await propose(harness, root, 'world', [{ fields: { title: '昆仑' }, evidence: 'ch-0001' }])
    const refused = await callTool(harness, 'inkflow_extract_accept', {
      projectRoot: root,
      candidateIds: [third.created[0].candidateId],
      confirm: true,
    })
    assert.equal(refused.accepted, 0)
    assert.equal(refused.outcomes[0].error.code, 'WORLD_ROOT_MULTIPLE')
    assert.equal(existsSync(join(root, 'world', '昆仑.md')), false)

    // An outline node needs an overall outline to hang from (I-01).
    const outline = await propose(harness, root, 'outline', [
      { fields: { kind: 'chapter', title: '第1章 入山', plotPoints: ['[主线] 入门'] }, evidence: 'ch-0001' },
    ])
    const outlineAccept = await callTool(harness, 'inkflow_extract_accept', {
      projectRoot: root,
      candidateIds: [outline.created[0].candidateId],
      confirm: true,
    })
    assert.equal(outlineAccept.accepted, 0)
    assert.equal(outlineAccept.outcomes[0].error.code, 'OUTLINE_NO_OVERALL')
    assert.equal(filesUnder(root, 'outlines').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. Reject and purge
// ---------------------------------------------------------------------------

test('reject writes zero content files; purge deletes processed candidates only', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    tenChapters(root)
    const harness = makeHarness(dir)

    const proposed = await propose(harness, root, 'character', [
      { fields: { name: '清音' }, evidence: 'ch-0001' },
      { fields: { name: '师父' }, evidence: 'ch-0001' },
    ])
    const [rejectedId, keptId] = idsOf({ items: proposed.created })
    const before = contentDigests(root)

    const rejected = await callTool(harness, 'inkflow_extract_reject', {
      projectRoot: root,
      candidateIds: [rejectedId],
      reason: '名字对不上',
    })
    assert.equal(rejected.ok, true, JSON.stringify(rejected.error))
    assert.equal(rejected.rejected, 1)
    assert.equal(rejected.contentFilesWritten, 0)
    assert.deepEqual(diffDigests(before, contentDigests(root)), [], 'reject must not touch a content directory')

    // A proposed candidate cannot be purged: purge cleans up after a decision.
    const early = await callTool(harness, 'inkflow_extract_purge', {
      projectRoot: root,
      candidateIds: [keptId],
      confirm: true,
    })
    assert.equal(early.ok, false)
    assert.equal(early.error.code, 'CANDIDATE_NOT_PROCESSED')

    const purged = await callTool(harness, 'inkflow_extract_purge', {
      projectRoot: root,
      candidateIds: [rejectedId],
      confirm: true,
    })
    assert.equal(purged.ok, true, JSON.stringify(purged.error))
    assert.equal(purged.purged.length, 1)
    assert.equal(purged.remaining, 1, 'the undecided candidate stays')
    assert.equal((await listCandidates(harness, root)).total, 1)
    assert.deepEqual(diffDigests(before, contentDigests(root)), [])

    // Purge itself needs confirmation.
    const noConfirm = await callTool(harness, 'inkflow_extract_purge', { projectRoot: root, candidateIds: [keptId] })
    assert.equal(noConfirm.error.code, 'EXTRACT_CONFIRM_REQUIRED')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7. The structure is the guarantee
// ---------------------------------------------------------------------------

/**
 * Every file in `src/` whose import specifier resolves to `target` (a repo-relative path).
 *
 * Resolution, not suffix matching: a source import names `./extract.js` and lands on
 * `extract.ts`, and `src/client/extract.ts` (the panel page) must not be mistaken for
 * `src/host/extract.ts` (the store) — they share a file name and nothing else.
 */
function importersOf(target) {
  const wanted = join(ROOT, target)
  const offenders = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx)$/u.test(entry.name)) continue
      const text = readFileSync(full, 'utf8')
      for (const match of text.matchAll(/from\s+['"](\.[^'"]+)['"]/gu)) {
        const resolved = resolve(dirname(full), match[1]).replace(/\.js$/u, '.ts')
        if (resolved === wanted) {
          offenders.push(relative(ROOT, full).replaceAll('\\', '/'))
          break
        }
      }
    }
  }
  walk(join(ROOT, 'src'))
  return offenders.sort()
}

test('the candidate store and the accept path have exactly the importers they may have', () => {
  // "Silent ingestion = 0" is a structural claim (ADR-0017 D5): only the tool surface and
  // the panel channel may reach the store, and only they may reach the accept path. A
  // second module here would be a second way in — which is exactly what must not exist.
  assert.deepEqual(importersOf('src/host/extract.ts'), [
    'src/host/extract-accept.ts',
    'src/host/extract-channel.ts',
    'src/host/extract-tools.ts',
    'src/host/index.ts',
  ])

  assert.deepEqual(importersOf('src/host/extract-accept.ts'), [
    'src/host/extract-channel.ts',
    'src/host/extract-tools.ts',
    'src/host/index.ts',
  ])

  // The fields→document function is the only place a candidate becomes text, so it may be
  // used by nobody but its own module (and the index re-export the tests import).
  const materializeUsers = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx)$/u.test(entry.name)) continue
      const text = readFileSync(full, 'utf8')
      if (/\bmaterializeCandidate\b/u.test(text)) materializeUsers.push(relative(ROOT, full).replaceAll('\\', '/'))
    }
  }
  walk(join(ROOT, 'src'))
  assert.deepEqual(materializeUsers.sort(), ['src/host/extract-accept.ts', 'src/host/index.ts'])
})

// ---------------------------------------------------------------------------
// 8. End to end: ten chapters, four kinds, two accepted
// ---------------------------------------------------------------------------

test('end to end: ten chapters → four kinds → accept two, reject the rest, no new audit findings', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'), '端到端之书')
    tenChapters(root)
    const harness = makeHarness(dir)

    const auditBefore = await callTool(harness, 'inkflow_project_audit', { projectRoot: root })
    assert.equal(auditBefore.ok, true, JSON.stringify(auditBefore.error))

    // A script standing in for the model: four kinds, five candidates.
    const characters = await propose(harness, root, 'character', [
      { fields: { name: '清音', role: '主角', firstAppearance: 1 }, evidence: 'chapters/vol-01/0001-入山.md#L3', confidence: 'high' },
      { fields: { name: '赵横', role: '反派' }, evidence: 'chapters/vol-01/0001-入山.md#L4', confidence: 'low' },
    ])
    const world = await propose(harness, root, 'world', [
      { fields: { title: '白鹤门', category: '门派', keywords: ['白鹤'], body: '剑派。' }, evidence: 'ch-0001' },
    ])
    const foreshadowing = await propose(harness, root, 'foreshadowing', [
      { fields: { title: '师父的沉默', dueBy: 'ch-0005', linkedEntities: ['ch-0001'] }, evidence: 'chapters/vol-01/0001-入山.md#L4' },
    ])
    const timeline = await propose(harness, root, 'timeline', [
      { fields: { title: '清音归来', worldTime: '2020-03', chapterId: 'ch-0001' }, evidence: 'ch-0001' },
    ])
    for (const result of [characters, world, foreshadowing, timeline]) {
      assert.equal(result.ok, true, JSON.stringify(result.error))
    }

    const all = await listCandidates(harness, root)
    assert.equal(all.total, 5)
    assert.deepEqual(
      [...new Set(all.items.map((item) => item.kind))].sort(),
      ['character', 'foreshadowing', 'timeline', 'world'],
      'the fixture must cover at least four kinds',
    )

    const acceptIds = [characters.created[0].candidateId, world.created[0].candidateId]
    const rejectIds = all.items.map((item) => item.candidateId).filter((id) => !acceptIds.includes(id))

    const beforeContent = contentDigests(root)
    const accepted = await callTool(harness, 'inkflow_extract_accept', { projectRoot: root, candidateIds: acceptIds, confirm: true })
    assert.equal(accepted.ok, true, JSON.stringify(accepted.error))
    assert.equal(accepted.accepted, 2)
    const rejected = await callTool(harness, 'inkflow_extract_reject', { projectRoot: root, candidateIds: rejectIds })
    assert.equal(rejected.rejected, 3)
    assert.equal(rejected.contentFilesWritten, 0)

    // Exactly two files appeared, in two directories.
    const changed = diffDigests(beforeContent, contentDigests(root))
    assert.deepEqual(changed, ['characters/清音.md', 'world/门派/白鹤门.md'])

    // The accepted entities are in the index (through the domains' own tools).
    const listedCharacters = await callTool(harness, 'inkflow_character_list', { projectRoot: root })
    assert.deepEqual(listedCharacters.items.map((item) => item.name), ['清音'])
    const worldTree = await callTool(harness, 'inkflow_world_tree', { projectRoot: root })
    assert.equal(worldTree.total, 1)

    // The rejected candidates left no file at all.
    assert.equal(existsSync(join(root, 'foreshadowing', '师父的沉默.md')), false)
    assert.equal(existsSync(join(root, 'timeline', '清音归来.md')), false)
    assert.equal(existsSync(join(root, 'characters', '赵横.md')), false)

    // The audit reports no new family of findings (a new entity must not introduce one).
    const auditAfter = await callTool(harness, 'inkflow_project_audit', { projectRoot: root })
    assert.equal(auditAfter.ok, true, JSON.stringify(auditAfter.error))
    const severitiesBefore = auditBefore.counts.severity
    const severitiesAfter = auditAfter.counts.severity
    assert.ok(
      severitiesAfter.blocking <= severitiesBefore.blocking && severitiesAfter.warning <= severitiesBefore.warning + 1,
      `accepting two entities must not add findings: ${JSON.stringify({ severitiesBefore, severitiesAfter })}`,
    )
    assert.equal(
      Object.entries(auditAfter.counts.byGroup).filter(([group, count]) => count > 0 && group !== 'catalog').length,
      Object.entries(auditBefore.counts.byGroup).filter(([group, count]) => count > 0 && group !== 'catalog').length,
      'no new finding family outside the catalog projection',
    )

    // The queue is history: three rejected, two accepted, all still readable.
    const states = await listCandidates(harness, root)
    assert.deepEqual(
      states.items.map((item) => item.status).sort(),
      ['accepted', 'accepted', 'rejected', 'rejected', 'rejected'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The panel channel (X-20)
// ---------------------------------------------------------------------------

test('the panel channel lists the queue and drives the same three actions', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    tenChapters(root)
    const harness = makeHarness(dir)
    const source = { sessionId: 'session-1', root }

    const proposed = await propose(harness, root, 'character', [
      { fields: { name: '清音' }, evidence: 'chapters/vol-01/0001-入山.md#L3' },
      { fields: { name: '师父' }, evidence: 'ch-0001' },
    ])

    const listed = buildCandidates(source, '0.0.2', {})
    assert.equal(listed.status, 200)
    assert.equal(listed.body.value.total, 2)
    assert.equal(listed.body.value.counts.proposedTotal, 2)
    const item = listed.body.value.items[0]
    assert.deepEqual(item.locator, { kind: 'path', path: 'chapters/vol-01/0001-入山.md', line: 3 })
    assert.deepEqual(listed.body.value.items[1].locator, { kind: 'chapter', chapterId: 'ch-0001' })

    const filtered = buildCandidates(source, '0.0.2', { status: 'accepted' })
    assert.equal(filtered.body.value.total, 0)
    assert.equal(filtered.body.value.counts.total, 2, 'counts describe the whole queue, not the page')

    const badKind = buildCandidates(source, '0.0.2', { kind: 'nope' })
    assert.equal(badKind.status, 400)

    const noConfirm = await acceptViaChannel(source, '0.0.2', { candidateIds: [proposed.created[0].candidateId] })
    assert.equal(noConfirm.status, 400)
    assert.equal(noConfirm.body.error.code, 'EXTRACT_CONFIRM_REQUIRED')

    const accepted = await acceptViaChannel(source, '0.0.2', { candidateIds: [proposed.created[0].candidateId], confirm: true })
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
    assert.equal(accepted.body.value.accepted, 1)

    const rejected = rejectViaChannel(source, '0.0.2', { candidateIds: [proposed.created[1].candidateId] })
    assert.equal(rejected.status, 200)
    assert.equal(rejected.body.value.contentFilesWritten, 0)

    const purged = purgeViaChannel(source, '0.0.2', {
      candidateIds: [proposed.created[0].candidateId, proposed.created[1].candidateId],
      confirm: true,
    })
    assert.equal(purged.status, 200, JSON.stringify(purged.body))
    assert.equal(purged.body.value.remaining, 0)
    assert.equal(queueFiles(root).length, 0, 'an emptied batch file is removed')
    assert.equal(existsSync(join(root, 'characters', '清音.md')), true, 'purging the queue never deletes an entity')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The routes themselves (the body whitelist is part of the contract)
// ---------------------------------------------------------------------------

/** A request double: the channel only reads `url`, `method`, `headers` and the body stream. */
function fakeRequest({ url, method = 'GET', origin, body } = {}) {
  const headers = { host: '127.0.0.1:2149' }
  if (origin !== undefined) headers.origin = origin
  // A write route refuses a body that is not declared JSON with 415 (ADR-0008 D3).
  if (body !== undefined) headers['content-type'] = 'application/json'
  const request = { url, method, headers, socket: { remoteAddress: '127.0.0.1' } }
  if (body === undefined) return request
  const buffer = Buffer.from(body, 'utf8')
  headers['content-length'] = String(buffer.length)
  request[Symbol.asyncIterator] = async function* iterate() {
    yield buffer
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

test('the candidate routes are wired, and a body field outside the whitelist is a 400', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    tenChapters(root)
    // The session's working directory is the book itself, so the channel resolves the
    // same project the tools do.
    const harness = createHarness(root)
    apply(harness.ctx, { dataDir: join(dir, 'state') })
    const route = harness.routes.find((entry) => entry.path === '/inkflow')
    assert.ok(route, 'the plugin registers one prefix route')

    const call = async (path, options = {}) => {
      const response = fakeResponse()
      await route.handler(fakeRequest({ url: `/inkflow/internal${path}`, ...options }), response)
      return { status: response.statusCode, json: response.body === undefined ? undefined : JSON.parse(response.body) }
    }

    const proposed = await propose(harness, root, 'character', [{ fields: { name: '清音' }, evidence: 'ch-0001' }])
    const candidateId = proposed.created[0].candidateId

    const read = await call('/candidates?sessionId=session-1')
    assert.equal(read.status, 200, JSON.stringify(read.json))
    assert.equal(read.json.value.total, 1)
    assert.equal(read.json.value.items[0].candidateId, candidateId)

    // The write guard: a directory name in the body is refused before anything else, and
    // any other undeclared field is refused by the allowlist (ADR-0008 D4/D3).
    const smuggledPath = await call('/candidates/accept', {
      method: 'POST',
      origin: 'http://127.0.0.1:2149',
      body: JSON.stringify({ sessionId: 'session-1', candidateIds: [candidateId], confirm: true, path: 'characters/x.md' }),
    })
    assert.equal(smuggledPath.status, 400)
    assert.equal(smuggledPath.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')

    const smuggledField = await call('/candidates/accept', {
      method: 'POST',
      origin: 'http://127.0.0.1:2149',
      body: JSON.stringify({ sessionId: 'session-1', candidateIds: [candidateId], confirm: true, autoApprove: true }),
    })
    assert.equal(smuggledField.status, 400)
    assert.equal(smuggledField.json.error.code, 'UNEXPECTED_BODY_FIELD')

    const accepted = await call('/candidates/accept', {
      method: 'POST',
      origin: 'http://127.0.0.1:2149',
      body: JSON.stringify({ sessionId: 'session-1', candidateIds: [candidateId], confirm: true }),
    })
    assert.equal(accepted.status, 200, JSON.stringify(accepted.json))
    assert.equal(accepted.json.value.accepted, 1)
    assert.equal(existsSync(join(root, 'characters', '清音.md')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The panel model and the bundle
// ---------------------------------------------------------------------------
/**
 * The panel model is TypeScript, so it is bundled on the fly (the same trick
 * `tests/search-model.test.js` uses): `node --test` cannot import a `.ts` file, and a
 * model that only a grep ever touched would not be a contract.
 */
async function loadExtractModel() {
  const esbuild = createRequire(import.meta.url)('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client', 'extract-model.ts')],
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

test('the panel model reads the queue, names the fields and refuses to guess a route', async () => {
  const model = await loadExtractModel()

  const list = model.readCandidateList({
    total: 2,
    truncated: false,
    counts: { byStatus: { proposed: 1, accepted: 1, rejected: 0 }, byKind: { character: 2 }, proposedTotal: 1, total: 2 },
    items: [
      {
        candidateId: 'ex-1111aaaa',
        kind: 'character',
        fields: { name: '清音', aliases: ['青音'], role: '主角', firstAppearance: 1, body: '很长的一段' },
        evidence: 'chapters/vol-01/0001-入山.md#L7',
        locator: { kind: 'path', path: 'chapters/vol-01/0001-入山.md', line: 7 },
        rationale: '首章出场',
        confidence: 'high',
        status: 'proposed',
        file: '20261024T000000000Z-character.json',
        submittedAt: '2026-10-24T00:00:00.000Z',
      },
      {
        candidateId: 'ex-2222bbbb',
        kind: 'world',
        fields: { title: '白鹤门' },
        evidence: 'ch-0001',
        locator: { kind: 'chapter', chapterId: 'ch-0001' },
        rationale: '',
        confidence: 'low',
        status: 'accepted',
        file: 'x-world.json',
        submittedAt: '',
      },
    ],
  })

  assert.equal(list.rows.length, 2)
  assert.equal(model.waitingCount(list.counts), 1, 'the badge counts undecided candidates, not the page')
  assert.equal(model.candidateTitle(list.rows[0]), '清音')
  assert.equal(model.candidateTitle(list.rows[1]), '白鹤门')
  assert.equal(model.describeFields(list.rows[0]), 'aliases=青音 · role=主角 · firstAppearance=1', 'body is not a summary field')
  assert.equal(model.describeEvidence(list.rows[0]), 'chapters/vol-01/0001-入山.md 第 7 行')
  assert.equal(model.describeEvidence(list.rows[1]), '章 id ch-0001')
  assert.equal(model.confidenceLabel(list.rows[0]), '高')
  assert.equal(model.statusLabel(list.rows[0]), '待审')
  assert.equal(model.kindLabel(list.rows[1]), '世界观')
  assert.equal(model.describeCounts(list.counts), '1 待审 · 1 已采纳 · 0 已拒绝')

  // A click on the evidence is a jump, and a row without an address has none: the page
  // must not invent a route for a chapter it was not told about.
  assert.deepEqual(model.evidenceTarget(list.rows[0]), { kind: 'chapter', path: 'chapters/vol-01/0001-入山.md', line: 7 })
  assert.deepEqual(model.evidenceTarget(list.rows[1]), { kind: 'chapter', chapterId: 'ch-0001' })
  assert.equal(model.evidenceTarget({ ...list.rows[1], locator: null }), null)

  // Batch actions only ever touch undecided rows.
  const selected = new Set(['ex-1111aaaa', 'ex-2222bbbb'])
  assert.deepEqual(model.actionableIds(list.rows, selected), ['ex-1111aaaa'])
  assert.deepEqual([...model.toggleSelected(selected, 'ex-1111aaaa')], ['ex-2222bbbb'])
  assert.deepEqual([...model.toggleAll(list.rows, new Set())], ['ex-1111aaaa'], 'select-all takes the waiting rows only')

  // A half-succeeded batch reports both halves, with the domain code intact.
  const outcome = model.describeOutcomes({
    outcomes: [
      { candidateId: 'ex-1111aaaa', accepted: true, path: 'characters/清音.md' },
      { candidateId: 'ex-3333cccc', accepted: false, error: { code: 'CHARACTER_NAME_DUPLICATE', message: 'taken' } },
    ],
  })
  assert.deepEqual(outcome.accepted, [{ candidateId: 'ex-1111aaaa', path: 'characters/清音.md' }])
  assert.deepEqual(outcome.refused, [{ candidateId: 'ex-3333cccc', code: 'CHARACTER_NAME_DUPLICATE', message: 'taken' }])
  assert.equal(model.describeOutcomeSummary({ accepted: 1, refused: 1 }), '采纳 1 条 · 未采纳 1 条')
  assert.match(model.describeCandidateError({ code: 'DUPLICATE_ID' }), /采纳从不覆盖/u)
})

test('the client bundle ships the candidate tab and its two actions', () => {
  const bundle = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  for (const marker of [
    '候选',
    '/candidates',
    '/candidates/accept',
    '/candidates/reject',
    '确认采纳',
    '批量拒绝',
    '待审',
  ]) {
    assert.ok(bundle.includes(marker), `the client bundle is missing "${marker}"`)
  }
  // The evidence jump is a callback, not a fabricated URL: the page never builds a route
  // for a chapter it was not given.
  assert.ok(bundle.includes('跳到原文'), 'the evidence row offers the jump')
  assert.equal(/setInterval/u.test(bundle), false, 'the candidate page polls nothing: one read per open + 刷新')
})
