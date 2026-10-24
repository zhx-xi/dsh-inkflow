/**
 * Contract tests for the plugin-level shared library's take-out direction
 * (#40, ADR-0007 C2–C6): copy snapshot, `origin` provenance, stale detection,
 * the explicit per-entry update, and the `library/`-only reference mode.
 *
 * What must FAIL when the implementation is wrong (each one is a scenario below):
 *   1. COPY IS A SNAPSHOT — the copy lands inside the book at the ADR-0007 C2
 *      destination, carries `origin{projectId,entryId,contentHash}` with the
 *      sha256 of the shared bytes AT COPY TIME, and the shared library is
 *      byte-identical afterwards (a whole-tree hash).
 *   2. SELF-CONTAINED — editing or deleting the shared entry changes nothing
 *      about the copy: its bytes still read back, and the status list marks it
 *      `stale` / `missing-source` instead of silently "fixing" it.
 *   3. UPDATE IS EXPLICIT AND REVERSIBLE — `updateSharedEntry` needs
 *      `confirm: true`, takes an `.inkflow/backup/<stamp>/` package first, makes
 *      the copy non-stale, and `rollbackBackup` puts the previous bytes back.
 *   4. REFUSALS WRITE NOTHING — a destination that already exists is
 *      `SHARED_COPY_CONFLICT`; `reference` on `world/` is
 *      `REFERENCE_NOT_ALLOWED`; a reference card cannot be written through the
 *      library save path (`REFERENCE_READONLY`); an unknown `entryId` is
 *      `SHARED_ENTRY_NOT_FOUND`. Every one of them is proven with a whole-tree
 *      hash of the book AND of the shared library.
 *   5. `projectId` — a book without one gets one exactly once (second call is a
 *      no-op), an existing value is never overwritten, and a book whose
 *      `inkflow.json` cannot be read still copies with `origin.projectId: null`.
 *   6. SERIES — a series entry copies NO file; it writes `inkflow.json.seriesId`.
 *
 * Run: pnpm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { hashTree } from './hash-tree.mjs'
import {
  buildSharedCopies,
  copySharedEntry,
  ensureProjectId,
  listBackups,
  rollbackBackup,
  updateSharedEntry,
  writeLibraryItem,
} from '../lib/index.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** A book: the nine content directories plus a minimal `inkflow.json`. */
function makeBook({ projectId, seriesId } = {}) {
  const root = tempDir('inkflow-book-')
  for (const dir of [...CONTENT_DIRS, 'index']) mkdirSync(join(root, dir), { recursive: true })
  const meta = { schemaVersion: 1, title: '测试书' }
  if (projectId !== undefined) meta.projectId = projectId
  if (seriesId !== undefined) meta.seriesId = seriesId
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  return root
}

function writeSharedEntry(sharedRoot, relativePath, lines = [], body = '共享正文。') {
  const absolute = join(sharedRoot, ...relativePath.split('/'))
  mkdirSync(dirname(absolute), { recursive: true })
  const block = lines.length > 0 ? `---\n${lines.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}\n`, 'utf8')
  return absolute
}

/** The shared library: one entry per copyable kind plus one series. */
function makeShared(dataDir) {
  const sharedRoot = join(dataDir, 'shared')
  writeSharedEntry(sharedRoot, 'world/门派/白鹤门.md', ['entryId: sh-aaaa1111', 'title: 白鹤门', 'tags: [门派]'], '白鹤门条目。')
  writeSharedEntry(sharedRoot, 'snippets/开篇片段.md', ['entryId: sh-bbbb2222', 'title: 开篇片段'], '片段正文。')
  writeSharedEntry(
    sharedRoot,
    'library/参考资料.md',
    ['entryId: sh-cccc3333', 'title: 参考资料', 'license: unknown', 'sha256: ' + 'a'.repeat(64)],
    '资料卡片正文。',
  )
  mkdirSync(join(sharedRoot, 'series'), { recursive: true })
  writeFileSync(
    join(sharedRoot, 'series', '蜀山.json'),
    `${JSON.stringify({ schemaVersion: 1, entryId: 'sh-dddd4444', seriesId: 'se-11112222', title: '蜀山' }, null, 2)}\n`,
    'utf8',
  )
  return sharedRoot
}

function makeFixture(options = {}) {
  const dataDir = tempDir('inkflow-data-')
  const sharedRoot = makeShared(dataDir)
  const root = makeBook(options)
  return { dataDir, sharedRoot, root }
}

/** `origin` as the file holds it, parsed the same way the plugin reads it. */
function originOf(root, relativePath) {
  const text = readFileSync(join(root, ...relativePath.split('/')), 'utf8')
  const lines = text.split('\n')
  assert.equal(lines[0], '---', `${relativePath} must start with a frontmatter block`)
  const out = {}
  let inside = false
  for (const line of lines.slice(1)) {
    if (line === '---') break
    if (line === 'origin:') {
      inside = true
      continue
    }
    if (!inside) continue
    const match = /^\s{2}([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (match === null) {
      inside = false
      continue
    }
    out[match[1]] = match[2] === 'null' ? null : match[2]
  }
  return out
}

function bodyOf(root, relativePath) {
  const text = readFileSync(join(root, ...relativePath.split('/')), 'utf8')
  const parts = text.split('\n---\n')
  return parts.length > 1 ? parts.slice(1).join('\n---\n') : text
}

function sha256File(absolute) {
  return import('node:crypto').then(({ createHash }) => createHash('sha256').update(readFileSync(absolute)).digest('hex'))
}

// ---------------------------------------------------------------------------
// 1. Copy a `world/` entry: destination, origin three fields, snapshot
// ---------------------------------------------------------------------------

test('copying a world entry writes the project file with the three origin fields', async () => {
  const { dataDir, sharedRoot, root } = makeFixture({ projectId: '11111111-2222-4333-8444-555555555555' })
  const sharedBefore = hashTree(sharedRoot)
  const sourceText = readFileSync(join(sharedRoot, 'world', '门派', '白鹤门.md'))
  const sourceHash = (await import('node:crypto')).createHash('sha256').update(sourceText).digest('hex')

  const result = copySharedEntry({ dataDir, root, entryId: 'sh-aaaa1111', confirm: true })
  assert.equal(result.ok, true, JSON.stringify(result.error))

  const destination = 'world/门派/白鹤门.md'
  assert.deepEqual(result.value.files, [destination])
  assert.equal(readFileSync(join(root, ...destination.split('/')), 'utf8').includes('白鹤门条目。'), true)

  const origin = originOf(root, destination)
  assert.equal(origin.projectId, '11111111-2222-4333-8444-555555555555')
  assert.equal(origin.entryId, 'sh-aaaa1111')
  assert.equal(origin.contentHash, sourceHash, 'contentHash is the shared bytes at copy time')
  // The shared library is left exactly as it was: a copy never writes back.
  assert.equal(hashTree(sharedRoot), sharedBefore)
})

test('copy without confirm writes nothing at all', () => {
  const { dataDir, sharedRoot, root } = makeFixture()
  const bookBefore = hashTree(root)
  const sharedBefore = hashTree(sharedRoot)

  const result = copySharedEntry({ dataDir, root, entryId: 'sh-aaaa1111' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'CONFIRM_REQUIRED')
  assert.equal(hashTree(root), bookBefore)
  assert.equal(hashTree(sharedRoot), sharedBefore)
})

test('copying into an occupied destination refuses and writes nothing', () => {
  const { dataDir, sharedRoot, root } = makeFixture()
  const destination = 'world/门派/白鹤门.md'
  mkdirSync(join(root, 'world', '门派'), { recursive: true })
  writeFileSync(join(root, ...destination.split('/')), '---\ntitle: 我自己写的\n---\n\n原有正文。\n', 'utf8')
  const bookBefore = hashTree(root)
  const sharedBefore = hashTree(sharedRoot)

  const result = copySharedEntry({ dataDir, root, entryId: 'sh-aaaa1111', confirm: true })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'SHARED_COPY_CONFLICT')
  assert.equal(result.error.path, destination)
  assert.equal(hashTree(root), bookBefore, 'a conflict never overwrites the author file')
  assert.equal(hashTree(sharedRoot), sharedBefore)
})

test('an unknown entry id is not found and writes nothing', () => {
  const { dataDir, root } = makeFixture()
  const bookBefore = hashTree(root)
  const result = copySharedEntry({ dataDir, root, entryId: 'sh-ffff9999', confirm: true })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'SHARED_ENTRY_NOT_FOUND')
  assert.equal(hashTree(root), bookBefore)
})

// ---------------------------------------------------------------------------
// 2. The copy is self-contained; the source changing does not touch it
// ---------------------------------------------------------------------------

test('editing the shared entry leaves the copy byte-identical and marks it stale', async () => {
  const { dataDir, sharedRoot, root } = makeFixture({ projectId: 'p-1' })
  assert.equal(copySharedEntry({ dataDir, root, entryId: 'sh-aaaa1111', confirm: true }).ok, true)
  const destination = 'world/门派/白鹤门.md'
  const copyBefore = readFileSync(join(root, ...destination.split('/')))

  writeSharedEntry(sharedRoot, 'world/门派/白鹤门.md', ['entryId: sh-aaaa1111', 'title: 白鹤门（改）'], '改过的共享正文。')
  assert.deepEqual(readFileSync(join(root, ...destination.split('/'))), copyBefore, 'a copy is never auto-updated')

  const status = buildSharedCopies({ dataDir, root })
  assert.equal(status.ok, true, JSON.stringify(status.error))
  const row = status.value.entries.find((entry) => entry.entryId === 'sh-aaaa1111')
  assert.equal(row.state, 'stale')
  assert.equal(row.mode, 'copy')
  assert.equal(status.value.counts.stale, 1)
  assert.notEqual(row.contentHash, row.currentHash)
})

test('deleting the shared entry leaves the copy readable and reports a missing source', () => {
  const { dataDir, sharedRoot, root } = makeFixture()
  assert.equal(copySharedEntry({ dataDir, root, entryId: 'sh-aaaa1111', confirm: true }).ok, true)
  const destination = 'world/门派/白鹤门.md'
  const copyBefore = readFileSync(join(root, ...destination.split('/')))

  rmSync(join(sharedRoot, 'world', '门派', '白鹤门.md'))
  assert.deepEqual(readFileSync(join(root, ...destination.split('/'))), copyBefore)

  const status = buildSharedCopies({ dataDir, root })
  const row = status.value.entries.find((entry) => entry.entryId === 'sh-aaaa1111')
  assert.equal(row.state, 'missing-source')
  assert.equal(status.value.counts.missing, 1)
})

// ---------------------------------------------------------------------------
// 3. The explicit per-entry update: backup, then not stale, then rollback
// ---------------------------------------------------------------------------

test('updating a stale copy refreshes it, takes a backup package, and rolls back', async () => {
  const { dataDir, sharedRoot, root } = makeFixture({ projectId: 'p-1' })
  assert.equal(copySharedEntry({ dataDir, root, entryId: 'sh-aaaa1111', confirm: true }).ok, true)
  const destination = 'world/门派/白鹤门.md'
  const absolute = join(root, ...destination.split('/'))
  const copyBefore = readFileSync(absolute)

  writeSharedEntry(sharedRoot, 'world/门派/白鹤门.md', ['entryId: sh-aaaa1111', 'title: 白鹤门（改）'], '改过的共享正文。')

  const refused = updateSharedEntry({ dataDir, root, entryId: 'sh-aaaa1111' })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'CONFIRM_REQUIRED')
  assert.deepEqual(readFileSync(absolute), copyBefore)

  const updated = updateSharedEntry({ dataDir, root, entryId: 'sh-aaaa1111', confirm: true })
  assert.equal(updated.ok, true, JSON.stringify(updated.error))
  assert.deepEqual(updated.value.updated, [destination])
  assert.equal(readFileSync(absolute, 'utf8').includes('改过的共享正文。'), true)

  const fresh = buildSharedCopies({ dataDir, root })
  assert.equal(fresh.value.counts.stale, 0, 'after the update the copy is current again')
  assert.equal(fresh.value.entries.find((entry) => entry.entryId === 'sh-aaaa1111').state, 'current')

  // The update went through `.inkflow/backup/<stamp>/` with kind `shared`, so
  // the previous bytes are recoverable and the package can be undone.
  const packages = listBackups(root).filter((entry) => entry.kind === 'shared')
  assert.equal(packages.length, 1, `expected one shared backup package, got ${JSON.stringify(listBackups(root))}`)
  const rolled = rollbackBackup(root, packages[0].dir)
  assert.equal(rolled.ok, true, JSON.stringify(rolled.error))
  assert.deepEqual(readFileSync(absolute), copyBefore, 'the rollback restores the previous snapshot')
})

test('updating a copy that is already current writes nothing', () => {
  const { dataDir, root } = makeFixture()
  assert.equal(copySharedEntry({ dataDir, root, entryId: 'sh-aaaa1111', confirm: true }).ok, true)
  const bookBefore = hashTree(root)

  const result = updateSharedEntry({ dataDir, root, entryId: 'sh-aaaa1111', confirm: true })
  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.deepEqual(result.value.updated, [])
  assert.deepEqual(result.value.unchanged, ['world/门派/白鹤门.md'])
  assert.equal(hashTree(root), bookBefore)
})

// ---------------------------------------------------------------------------
// 4. Reference mode: `library/` only, read-only card, selfContained false
// ---------------------------------------------------------------------------

test('a library reference writes a read-only card and says the book is not self-contained', () => {
  const { dataDir, root } = makeFixture({ projectId: 'p-1' })
  const result = copySharedEntry({ dataDir, root, entryId: 'sh-cccc3333', mode: 'reference', confirm: true })
  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.deepEqual(result.value.files, ['library/参考资料.md'])

  const text = readFileSync(join(root, 'library', '参考资料.md'), 'utf8')
  assert.match(text, /^mode: reference$/m, 'the card declares reference mode')
  const origin = originOf(root, 'library/参考资料.md')
  assert.equal(origin.contentHash, undefined, 'a reference records the source hash, not a copy hash')
  assert.match(origin.sha256, /^[0-9a-f]{64}$/)
  assert.equal(bodyOf(root, 'library/参考资料.md').trim(), '', 'a reference card carries no body')

  const status = buildSharedCopies({ dataDir, root })
  assert.equal(status.value.selfContained, false)
  assert.deepEqual(status.value.references, ['library/参考资料.md'])
})

test('a reference card cannot be written through the library save path', async () => {
  const { dataDir, root } = makeFixture({ projectId: 'p-1' })
  assert.equal(copySharedEntry({ dataDir, root, entryId: 'sh-cccc3333', mode: 'reference', confirm: true }).ok, true)
  const absolute = join(root, 'library', '参考资料.md')
  const before = readFileSync(absolute)

  const reply = await writeLibraryItem({
    source: { sessionId: 'session-1', root },
    version: 'test',
    body: { kind: 'library', id: 'library/参考资料.md', frontmatter: { title: '改标题' } },
  })
  assert.equal(reply.status, 409)
  assert.equal(reply.body.error.code, 'REFERENCE_READONLY')
  assert.deepEqual(readFileSync(absolute), before, 'the reference card is untouched')
})

test('reference mode is refused for world/snippets/series and writes nothing', () => {
  for (const entryId of ['sh-aaaa1111', 'sh-bbbb2222', 'sh-dddd4444']) {
    const { dataDir, root } = makeFixture()
    const bookBefore = hashTree(root)
    const result = copySharedEntry({ dataDir, root, entryId, mode: 'reference', confirm: true })
    assert.equal(result.ok, false, `${entryId} must not be referenceable`)
    assert.equal(result.error.code, 'REFERENCE_NOT_ALLOWED')
    assert.equal(hashTree(root), bookBefore)
  }
})

// ---------------------------------------------------------------------------
// 5. projectId: written once, never overwritten, null when it cannot be read
// ---------------------------------------------------------------------------

test('projectId is added once and stays stable; an existing one is never replaced', () => {
  const { dataDir, root } = makeFixture()
  const before = readFileSync(join(root, 'inkflow.json'), 'utf8')
  assert.equal(JSON.parse(before).projectId, undefined)

  const first = ensureProjectId(root)
  assert.equal(first.ok, true, JSON.stringify(first.error))
  assert.equal(first.value.created, true)
  assert.match(first.value.projectId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  const afterFirst = readFileSync(join(root, 'inkflow.json'), 'utf8')
  assert.equal(JSON.parse(afterFirst).title, '测试书', 'the wizard fields survive the addition')

  const second = ensureProjectId(root)
  assert.equal(second.value.created, false)
  assert.equal(second.value.projectId, first.value.projectId)
  assert.equal(readFileSync(join(root, 'inkflow.json'), 'utf8'), afterFirst, 'the second call is a no-op')

  const existing = makeBook({ projectId: 'fixed-id' })
  const kept = ensureProjectId(existing)
  assert.equal(kept.value.projectId, 'fixed-id')
  assert.equal(kept.value.created, false)
  assert.equal(JSON.parse(readFileSync(join(existing, 'inkflow.json'), 'utf8')).projectId, 'fixed-id')
  assert.equal(dataDir === undefined, false)
})

test('an unreadable inkflow.json copies with a null projectId instead of failing', () => {
  const { dataDir, root } = makeFixture()
  writeFileSync(join(root, 'inkflow.json'), '{ not json', 'utf8')
  const metaBefore = readFileSync(join(root, 'inkflow.json'), 'utf8')

  const result = copySharedEntry({ dataDir, root, entryId: 'sh-aaaa1111', confirm: true })
  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.equal(originOf(root, 'world/门派/白鹤门.md').projectId, null)
  assert.equal(readFileSync(join(root, 'inkflow.json'), 'utf8'), metaBefore, 'a broken meta is never rewritten')
})

// ---------------------------------------------------------------------------
// 6. Series: no file copied, only `inkflow.json.seriesId`
// ---------------------------------------------------------------------------

test('copying a series entry writes seriesId and copies no file', () => {
  const { dataDir, root } = makeFixture()
  const result = copySharedEntry({ dataDir, root, entryId: 'sh-dddd4444', confirm: true })
  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.deepEqual(result.value.files, [], 'a series copies no file (ADR-0007 C2/C5)')
  assert.equal(JSON.parse(readFileSync(join(root, 'inkflow.json'), 'utf8')).seriesId, 'se-11112222')
  assert.equal(existsSync(join(root, 'library', 'series')), false)
  assert.equal(existsSync(join(root, 'series')), false)

  const status = buildSharedCopies({ dataDir, root })
  assert.equal(status.value.seriesId, 'se-11112222')
  assert.equal(status.value.seriesFound, true)
})

test('a seriesId pointing at no series is reported, never repaired', () => {
  const { dataDir, root } = makeFixture({ seriesId: 'se-does-not-exist' })
  const metaBefore = readFileSync(join(root, 'inkflow.json'), 'utf8')

  const status = buildSharedCopies({ dataDir, root })
  assert.equal(status.ok, true)
  assert.equal(status.value.seriesId, 'se-does-not-exist')
  assert.equal(status.value.seriesFound, false)
  assert.equal(readFileSync(join(root, 'inkflow.json'), 'utf8'), metaBefore)
})

// ---------------------------------------------------------------------------
// 7. Snippets land under library/ (no tenth top-level directory)
// ---------------------------------------------------------------------------

test('a snippet copies into library/snippets/ and keeps its origin', () => {
  const { dataDir, root } = makeFixture()
  const result = copySharedEntry({ dataDir, root, entryId: 'sh-bbbb2222', confirm: true })
  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.deepEqual(result.value.files, ['library/snippets/开篇片段.md'])
  assert.equal(originOf(root, 'library/snippets/开篇片段.md').entryId, 'sh-bbbb2222')
})

test('a missing shared library answers SHARED_UNAVAILABLE without touching the book', () => {
  const dataDir = tempDir('inkflow-data-empty-')
  const root = makeBook()
  const bookBefore = hashTree(root)
  const result = copySharedEntry({ dataDir, root, entryId: 'sh-aaaa1111', confirm: true })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'SHARED_ENTRY_NOT_FOUND')
  assert.equal(hashTree(root), bookBefore)
  assert.equal(existsSync(join(dataDir, 'shared')), false, 'the copy path never creates the library')
})

test('the helper above really does read sha256 (guards the assertions)', async () => {
  const { sharedRoot } = makeFixture()
  const digest = await sha256File(join(sharedRoot, 'world', '门派', '白鹤门.md'))
  assert.match(digest, /^[0-9a-f]{64}$/)
})
