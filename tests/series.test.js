/**
 * Contract tests for the series sync (#49, ADR-0007 C2/C5, X-17/X-25/X-26).
 *
 * What must FAIL when the implementation is wrong (each one is a scenario below):
 *
 *   1. THE FOUR ROWS ARE DECIDED, NOT GUESSED — a missing target is `create`, an
 *      identical copy is `unchanged`, a copy whose source moved is `update`, and a file
 *      the library did not write (or that the author edited on top of an unmoved source)
 *      is `conflict` with both digests and the reader-meaning `changedFields`.
 *   2. PLAN IS READ-ONLY — the book tree AND the shared library are hashed around the
 *      preview, `.inkflow/` is not created, and `index/` gains nothing.
 *   3. UNRESOLVED CONFLICT = ZERO WRITES — `SERIES_CONFLICT_UNRESOLVED` leaves the book
 *      and the library byte-identical and writes no run record; the same for a missing
 *      `confirm` and for a missing `expected`.
 *   4. THE DECISIONS MEAN WHAT THEY SAY — `keep-book` leaves the book file alone and
 *      `take-shared` overwrites it from the library, while NEITHER of them changes the
 *      shared library (a whole-tree hash).
 *   5. `unchanged` IS NOT A TASK — its file keeps its bytes AND its mtime.
 *   6. PLAN AND APPLY ARE ONE COMPUTATION — an approved row whose action changed in the
 *      meantime is skipped and reported `SERIES_PLAN_STALE`; the other approved rows
 *      still run.
 *   7. TWO BOOKS END UP THE SAME — same entry set, same reader-meaning content (the
 *      `origin` block differs only by `projectId`, so it is stripped before comparing).
 *   8. THE RUN RECORD EXISTS AND CARRIES NO PROSE — `.inkflow/audit/series-<stamp>.json`
 *      says what was written, kept and decided; searching it for the setting's body must
 *      come back empty.
 *   9. ESCAPES ARE REFUSED — a `world/` junction pointing out of the book is refused by
 *      the write path and nothing appears outside.
 *  10. THE SURFACES ARE WIRED — two tools with the right required fields, and a panel
 *      model that blocks `apply` while a conflict is undecided and hands the plan's own
 *      `expected` back with the request.
 *
 * Runs against the built artifact (`lib/index.js`), like every other contract test.
 *
 * Run: pnpm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { findColorLiterals } from './color-guard.mjs'
import { hashTree } from './hash-tree.mjs'
import { apply, applySeriesSync, buildSeriesPlan, buildTools, compareSeriesContent, copySharedEntry } from '../lib/index.js'

const ROOT = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function writeFile(root, relative, text) {
  const absolute = join(root, ...relative.split('/'))
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, text, 'utf8')
  return absolute
}

/** The shared library: two settings entries plus one reference card. */
function makeShared(dataDir) {
  const sharedRoot = join(dataDir, 'shared')
  writeFile(
    sharedRoot,
    'world/门派/白鹤门.md',
    '---\nentryId: sh-aaaa1111\ntitle: 白鹤门\ntags: [门派]\n---\n\n白鹤门座落云海之上。\n',
  )
  writeFile(sharedRoot, 'world/势力/青萍宗.md', '---\nentryId: sh-bbbb2222\ntitle: 青萍宗\n---\n\n青萍宗与水路镖局往来。\n')
  writeFile(
    sharedRoot,
    'library/参考资料.md',
    '---\nentryId: sh-cccc3333\ntitle: 参考资料\nlicense: unknown\n---\n\n资料卡片正文。\n',
  )
  // Out of scope on purpose: `snippets/` is material and `series/` copies no file.
  writeFile(sharedRoot, 'snippets/开篇片段.md', '---\nentryId: sh-eeee5555\n---\n\n片段。\n')
  writeFile(
    sharedRoot,
    'series/蜀山.json',
    `${JSON.stringify({ schemaVersion: 1, entryId: 'sh-dddd4444', seriesId: 'se-11112222', title: '蜀山' }, null, 2)}\n`,
  )
  return sharedRoot
}

function makeFixture(options = {}) {
  const dataDir = tempDir('inkflow-data-')
  const sharedRoot = makeShared(dataDir)
  const root = makeBook(options)
  return { dataDir, sharedRoot, root }
}

/** The expected rows an approved plan hands back — the same shape the panel echoes. */
function expectedOf(plan) {
  assert.equal(plan.ok, true, JSON.stringify(plan.error))
  return plan.value.expected
}

/** A file's text with its `origin:` block removed — what a reader would compare. */
function contentWithoutOrigin(root, relative) {
  const text = readFileSync(join(root, ...relative.split('/')), 'utf8')
  return text.replace(/^origin:\n(?:  [^\n]*\n)+/mu, '').replace(/\s+$/u, '')
}

/** Per-kind file lists, so "same entity count" is a set comparison, not a number. */
function contentFiles(root) {
  const out = []
  for (const dir of ['world', 'library']) {
    const walk = (relative) => {
      for (const entry of readdirSync(join(root, ...relative.split('/')), { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue
        const child = `${relative}/${entry.name}`
        if (entry.isDirectory()) walk(child)
        else if (entry.name.endsWith('.md')) out.push(child)
      }
    }
    walk(dir)
  }
  return out.sort()
}

/** A fixture with one copy already taken, one unrelated file and one entry to create. */
async function readyFixture(options = {}) {
  const fixture = makeFixture(options)
  const copied = copySharedEntry({ dataDir: fixture.dataDir, root: fixture.root, entryId: 'sh-aaaa1111', confirm: true })
  assert.equal(copied.ok, true, JSON.stringify(copied.error))
  // The author wrote this one themselves: no `origin`, different text.
  writeFile(fixture.root, 'library/参考资料.md', '---\ntitle: 我自己写的资料\n---\n\n另一份资料。\n')
  return fixture
}

// ---------------------------------------------------------------------------
// 1 + 2. The four rows, and a read-only preview
// ---------------------------------------------------------------------------

test('系列同步：plan 判出四类（新建 / 更新 / 冲突 / 无需改动）且一字节都不写', async () => {
  const { dataDir, sharedRoot, root } = await readyFixture({ projectId: '11111111-2222-4333-8444-555555555555' })
  const bookBefore = hashTree(root)
  const sharedBefore = hashTree(sharedRoot)

  const plan = buildSeriesPlan({ dataDir, root })
  assert.equal(plan.ok, true, JSON.stringify(plan.error))
  const rows = plan.value.entries
  const byId = new Map(rows.map((row) => [row.entryId, row]))

  // The two world entries plus the one library card; `snippets/` and `series/` are counted out.
  assert.deepEqual([...byId.keys()].sort(), ['sh-aaaa1111', 'sh-bbbb2222', 'sh-cccc3333'])
  assert.equal(byId.get('sh-bbbb2222').action, 'create')
  assert.equal(byId.get('sh-aaaa1111').action, 'unchanged')
  assert.equal(byId.get('sh-cccc3333').action, 'conflict')
  assert.equal(byId.get('sh-cccc3333').conflict, 'unrelated-file', 'a file with no origin for this entry is not a copy')
  assert.ok(byId.get('sh-cccc3333').changedFields.length > 0, 'a conflict says what differs')
  assert.deepEqual(plan.value.counts, { create: 1, update: 0, conflict: 1, unchanged: 1 })
  assert.deepEqual(plan.value.excluded.byKind, { snippets: 1, series: 1 })
  assert.equal(plan.value.seriesId, null)

  // The preview is read-only: the book, the library, and `.inkflow/` all untouched.
  assert.equal(hashTree(root), bookBefore, 'plan must not write into the book')
  assert.equal(hashTree(sharedRoot), sharedBefore, 'plan must not write into the library')
  assert.equal(existsSync(join(root, '.inkflow')), false, 'plan must not create the private state directory')
})

test('系列同步：源侧动过的副本判 update，本书改过而源没动判 conflict', async () => {
  const { dataDir, sharedRoot, root } = await readyFixture()

  // Source moved: the copy is now behind, which is the ordinary "take the new version".
  writeFile(sharedRoot, 'world/门派/白鹤门.md', '---\nentryId: sh-aaaa1111\ntitle: 白鹤门\ntags: [门派]\n---\n\n白鹤门改名白鹤观。\n')
  const plan = buildSeriesPlan({ dataDir, root })
  const updated = plan.value.entries.find((row) => row.entryId === 'sh-aaaa1111')
  assert.equal(updated.action, 'update')
  assert.deepEqual(updated.changedFields, ['body'], 'only the prose moved')

  // Now the author edits the copy while the library stays put: nothing to take, so the
  // difference is the book's and only a human can decide.
  const book = makeBook()
  assert.equal(copySharedEntry({ dataDir, root: book, entryId: 'sh-aaaa1111', confirm: true }).ok, true)
  // Edited in place, so the `origin` block survives — without it the file stops being a
  // copy at all, which is the OTHER conflict (`unrelated-file`).
  const copiedText = readFileSync(join(book, 'world', '门派', '白鹤门.md'), 'utf8')
  writeFile(book, 'world/门派/白鹤门.md', copiedText.replace('白鹤门改名白鹤观。', '我自己重写的正文。'))
  const second = buildSeriesPlan({ dataDir, root: book })
  const diverged = second.value.entries.find((row) => row.entryId === 'sh-aaaa1111')
  assert.equal(diverged.action, 'conflict')
  assert.equal(diverged.conflict, 'book-diverged')
  assert.equal(typeof diverged.bookDigest, 'string')
  assert.equal(diverged.sharedDigest.length, 64)
})

test('系列同步：比较用读者意义（忽略 origin / 簿记键，正文归一 EOL）', () => {
  const source = '---\nentryId: sh-aaaa1111\ntitle: 白鹤门\n---\n\n正文第一段。\n正文第二段。\n'
  const withBookkeeping = source.replace('---\n\n', 'id: char-1\nupdatedAt: 2026-01-01\norigin:\n  entryId: sh-aaaa1111\n  contentHash: ' + 'a'.repeat(64) + '\n---\n\n').replaceAll('\n', '\r\n')
  assert.deepEqual(compareSeriesContent(withBookkeeping, source), [], 'bookkeeping and line endings are not content')
  assert.deepEqual(compareSeriesContent(source.replace('白鹤门', '白鹤观'), source), ['title'], 'a changed field is named')
  assert.deepEqual(compareSeriesContent('---\ntitle: 白鹤门\n---\n\n正文第一段。\n正文第二段。\n', source), ['entryId'], 'a field only the source has still differs')
})

// ---------------------------------------------------------------------------
// 3. Refusals write nothing
// ---------------------------------------------------------------------------

test('系列同步：未裁决的冲突 = SERIES_CONFLICT_UNRESOLVED 且零写入', async () => {
  const { dataDir, sharedRoot, root } = await readyFixture()
  const expected = expectedOf(buildSeriesPlan({ dataDir, root }))
  const bookBefore = hashTree(root)
  const sharedBefore = hashTree(sharedRoot)

  const refused = applySeriesSync({ dataDir, root, expected, confirm: true })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'SERIES_CONFLICT_UNRESOLVED')
  assert.equal(refused.error.unresolved.length, 1)
  assert.equal(refused.error.unresolved[0].entryId, 'sh-cccc3333')
  assert.equal(refused.error.unresolved[0].path, 'library/参考资料.md')
  assert.equal(hashTree(root), bookBefore, 'a refused sync writes nothing, not even the entries that had no conflict')
  assert.equal(hashTree(sharedRoot), sharedBefore)
  assert.equal(existsSync(join(root, '.inkflow')), false, 'no run record for a refused run')

  // A decision for only ONE of two conflicts is still "one undecided".
  writeFile(root, 'world/势力/青萍宗.md', '---\ntitle: 我早写过青萍宗\n---\n\n另一版。\n')
  const two = buildSeriesPlan({ dataDir, root })
  assert.equal(two.value.counts.conflict, 2)
  const half = applySeriesSync({
    dataDir,
    root,
    expected: expectedOf(two),
    decisions: [{ entryId: 'sh-cccc3333', decision: 'keep-book' }],
    confirm: true,
  })
  assert.equal(half.ok, false)
  assert.equal(half.error.code, 'SERIES_CONFLICT_UNRESOLVED')
  assert.deepEqual(half.error.unresolved.map((row) => row.entryId), ['sh-bbbb2222'])
})

test('系列同步：缺 confirm 缺 expected 都拒绝，且不写一个字节', async () => {
  const { dataDir, sharedRoot, root } = await readyFixture()
  const expected = expectedOf(buildSeriesPlan({ dataDir, root }))
  const bookBefore = hashTree(root)
  const sharedBefore = hashTree(sharedRoot)
  const decisions = [{ entryId: 'sh-cccc3333', decision: 'keep-book' }]

  const unconfirmed = applySeriesSync({ dataDir, root, expected, decisions })
  assert.equal(unconfirmed.error.code, 'CONFIRM_REQUIRED')

  const noPlan = applySeriesSync({ dataDir, root, decisions, confirm: true })
  assert.equal(noPlan.error.code, 'SERIES_PLAN_REQUIRED')

  const badDecision = applySeriesSync({
    dataDir,
    root,
    expected,
    decisions: [{ entryId: 'sh-cccc3333', decision: 'whatever' }],
    confirm: true,
  })
  assert.equal(badDecision.error.code, 'SERIES_DECISION_INVALID')

  assert.equal(hashTree(root), bookBefore)
  assert.equal(hashTree(sharedRoot), sharedBefore)
})

// ---------------------------------------------------------------------------
// 4 + 5 + 8. The decisions, the untouched `unchanged`, and the run record
// ---------------------------------------------------------------------------

test('系列同步：keep-book 保留本书、take-shared 覆盖、共享库全程只读', async () => {
  const { dataDir, sharedRoot, root } = await readyFixture()
  const expected = expectedOf(buildSeriesPlan({ dataDir, root }))
  const sharedBefore = hashTree(sharedRoot)
  const ownText = readFileSync(join(root, 'library', '参考资料.md'), 'utf8')

  const kept = applySeriesSync({
    dataDir,
    root,
    expected,
    decisions: [{ entryId: 'sh-cccc3333', decision: 'keep-book' }],
    confirm: true,
  })
  assert.equal(kept.ok, true, JSON.stringify(kept.error))
  assert.deepEqual(kept.value.written.map((row) => row.path), ['world/势力/青萍宗.md'])
  assert.deepEqual(kept.value.kept.map((row) => row.path), ['library/参考资料.md'])
  assert.equal(readFileSync(join(root, 'library', '参考资料.md'), 'utf8'), ownText, 'keep-book leaves the file alone')
  assert.equal(hashTree(sharedRoot), sharedBefore, 'a sync never writes the shared library')

  // The created file is a real copy: the source text plus the three origin fields.
  const created = readFileSync(join(root, 'world', '势力', '青萍宗.md'), 'utf8')
  assert.ok(created.includes('entryId: sh-bbbb2222'), created)
  assert.ok(created.includes('contentHash: '), 'a create records what it copied')

  // Now take the shared version of the conflict.
  const taken = applySeriesSync({
    dataDir,
    root,
    expected: expectedOf(buildSeriesPlan({ dataDir, root })),
    decisions: [{ entryId: 'sh-cccc3333', decision: 'take-shared' }],
    confirm: true,
  })
  assert.equal(taken.ok, true, JSON.stringify(taken.error))
  assert.deepEqual(taken.value.written.map((row) => row.path).sort(), ['library/参考资料.md'])
  const overwritten = readFileSync(join(root, 'library', '参考资料.md'), 'utf8')
  assert.ok(overwritten.includes('资料卡片正文。'), 'take-shared brings the shared text in')
  assert.ok(overwritten.includes('entryId: sh-cccc3333'))
  assert.equal(hashTree(sharedRoot), sharedBefore, 'still read-only on the library side')
})

test('系列同步：unchanged 的条目不会被重写（字节与 mtime 都不变）', async () => {
  const { dataDir, root } = await readyFixture()
  const target = join(root, 'world', '门派', '白鹤门.md')
  const before = { text: readFileSync(target, 'utf8'), mtimeMs: statSync(target).mtimeMs }

  const applied = applySeriesSync({
    dataDir,
    root,
    expected: expectedOf(buildSeriesPlan({ dataDir, root })),
    decisions: [{ entryId: 'sh-cccc3333', decision: 'keep-book' }],
    confirm: true,
  })
  assert.equal(applied.ok, true, JSON.stringify(applied.error))
  assert.equal(applied.value.written.some((row) => row.path === 'world/门派/白鹤门.md'), false)

  const after = { text: readFileSync(target, 'utf8'), mtimeMs: statSync(target).mtimeMs }
  assert.equal(after.text, before.text)
  assert.equal(after.mtimeMs, before.mtimeMs, 'an unchanged row is not rewritten')
})

test('系列同步：运行记录落 .inkflow/audit、带时间戳、不记正文，index/ 零新增', async () => {
  const { dataDir, root } = await readyFixture()
  const indexBefore = readdirSync(join(root, 'index')).sort()
  const now = new Date(2026, 9, 25, 18, 55, 0)

  const applied = applySeriesSync({
    dataDir,
    root,
    expected: expectedOf(buildSeriesPlan({ dataDir, root })),
    decisions: [{ entryId: 'sh-cccc3333', decision: 'keep-book' }],
    confirm: true,
    now,
  })
  assert.equal(applied.ok, true, JSON.stringify(applied.error))
  assert.equal(applied.value.auditPath, '.inkflow/audit/series-20261025-185500.json')
  const record = JSON.parse(readFileSync(join(root, '.inkflow', 'audit', 'series-20261025-185500.json'), 'utf8'))

  assert.equal(record.schemaVersion, 1)
  assert.equal(record.runAt, now.toISOString(), 'a run record is an event, so it carries its time')
  assert.deepEqual(record.counts, { create: 1, update: 0, conflict: 1, unchanged: 1 })
  assert.deepEqual(record.written.map((row) => row.path), ['world/势力/青萍宗.md'])
  assert.deepEqual(record.kept.map((row) => row.path), ['library/参考资料.md'])
  assert.deepEqual(record.decisions, [{ entryId: 'sh-cccc3333', decision: 'keep-book' }])
  assert.equal(typeof record.backupDir, 'string')

  // No prose in the record: only paths, digests, field names and decisions.
  const serialized = JSON.stringify(record)
  assert.equal(serialized.includes('青萍宗与水路镖局往来'), false)
  assert.equal(serialized.includes('白鹤门座落云海之上'), false)
  assert.equal(serialized.includes('资料卡片正文'), false)

  // The undo package really holds the previous bytes.
  assert.equal(existsSync(join(root, ...record.backupDir.split('/'))), true)
  assert.deepEqual(readdirSync(join(root, 'index')).sort(), indexBefore, 'index/ gains nothing')
})

test('系列同步：同秒两次运行不覆盖前一份记录', async () => {
  const { dataDir, root } = await readyFixture()
  const now = new Date(2026, 9, 25, 18, 55, 0)
  const decisions = [{ entryId: 'sh-cccc3333', decision: 'keep-book' }]
  const first = applySeriesSync({
    dataDir,
    root,
    expected: expectedOf(buildSeriesPlan({ dataDir, root })),
    decisions,
    confirm: true,
    now,
  })
  const second = applySeriesSync({
    dataDir,
    root,
    expected: expectedOf(buildSeriesPlan({ dataDir, root })),
    decisions,
    confirm: true,
    now,
  })
  assert.equal(first.value.auditPath, '.inkflow/audit/series-20261025-185500.json')
  assert.equal(second.value.auditPath, '.inkflow/audit/series-20261025-185500-2.json')
})

// ---------------------------------------------------------------------------
// 6. Plan and apply are one computation
// ---------------------------------------------------------------------------

test('系列同步：预览后源变了 → 那条 SERIES_PLAN_STALE 跳过，其余照写', async () => {
  const { dataDir, sharedRoot, root } = await readyFixture()
  const approved = expectedOf(buildSeriesPlan({ dataDir, root }))
  // The author approved "nothing to do" for 白鹤门; meanwhile the library moves it.
  writeFile(sharedRoot, 'world/门派/白鹤门.md', '---\nentryId: sh-aaaa1111\ntitle: 白鹤门\n---\n\n改过的正文。\n')

  const applied = applySeriesSync({
    dataDir,
    root,
    expected: approved,
    decisions: [{ entryId: 'sh-cccc3333', decision: 'keep-book' }],
    confirm: true,
  })
  assert.equal(applied.ok, true, JSON.stringify(applied.error))
  const stale = applied.value.skipped.filter((row) => row.code === 'SERIES_PLAN_STALE')
  assert.deepEqual(stale.map((row) => row.entryId), ['sh-aaaa1111'])
  assert.deepEqual(applied.value.written.map((row) => row.path), ['world/势力/青萍宗.md'], 'the approved rows still run')
  assert.equal(
    readFileSync(join(root, 'world', '门派', '白鹤门.md'), 'utf8').includes('改过的正文'),
    false,
    'a row the author did not approve is never written',
  )
})

test('系列同步：apply 只认 expected 里的行（多给的行不会被写）', async () => {
  const { dataDir, root } = await readyFixture()
  const plan = buildSeriesPlan({ dataDir, root })
  const onlyConflict = plan.value.expected.filter((row) => row.entryId === 'sh-cccc3333')

  const applied = applySeriesSync({
    dataDir,
    root,
    expected: onlyConflict,
    decisions: [{ entryId: 'sh-cccc3333', decision: 'skip' }],
    confirm: true,
  })
  assert.equal(applied.ok, true, JSON.stringify(applied.error))
  assert.deepEqual(applied.value.written, [], 'nothing outside expected is written')
  assert.deepEqual(
    applied.value.skipped.map((row) => `${row.entryId}:${row.code}`).sort(),
    ['sh-aaaa1111:SERIES_PLAN_STALE', 'sh-bbbb2222:SERIES_PLAN_STALE', 'sh-cccc3333:SKIP'],
  )
  assert.equal(existsSync(join(root, 'world', '势力', '青萍宗.md')), false)
})

// ---------------------------------------------------------------------------
// 7. Two books, one library
// ---------------------------------------------------------------------------

test('系列同步：两本书同步后条目集合与内容一致（差异 0）', async () => {
  const dataDir = tempDir('inkflow-data-')
  makeShared(dataDir)
  const first = makeBook()
  const second = makeBook()

  for (const root of [first, second]) {
    const applied = applySeriesSync({
      dataDir,
      root,
      expected: expectedOf(buildSeriesPlan({ dataDir, root })),
      confirm: true,
      now: new Date(2026, 9, 25, 19, 0, 0),
    })
    assert.equal(applied.ok, true, JSON.stringify(applied.error))
  }

  const a = contentFiles(first)
  const b = contentFiles(second)
  assert.deepEqual(a, b, 'same entity set')
  assert.deepEqual(a, ['library/参考资料.md', 'world/势力/青萍宗.md', 'world/门派/白鹤门.md'])
  for (const file of a) {
    assert.equal(contentWithoutOrigin(second, file), contentWithoutOrigin(first, file), `${file} reads the same in both books`)
  }
  // `origin.projectId` is per book, which is exactly why it is stripped above.
  assert.notEqual(
    readFileSync(join(first, 'world', '门派', '白鹤门.md'), 'utf8'),
    readFileSync(join(second, 'world', '门派', '白鹤门.md'), 'utf8'),
    'the provenance blocks differ by projectId, and that is the only difference',
  )
})

// ---------------------------------------------------------------------------
// 9. Escapes
// ---------------------------------------------------------------------------

test('系列同步：world/ 是指向书外的 junction 时写入被拒，书外不出现文件', async (t) => {
  const { dataDir, root } = makeFixture()
  const outside = join(tempDir('inkflow-outside-'), 'leak')
  mkdirSync(outside, { recursive: true })
  rmSync(join(root, 'world'), { recursive: true, force: true })
  try {
    symlinkSync(outside, join(root, 'world'), process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    t.skip('this platform refuses directory links without extra privileges')
    return
  }

  const plan = buildSeriesPlan({ dataDir, root })
  assert.equal(plan.ok, true, JSON.stringify(plan.error))
  const applied = applySeriesSync({ dataDir, root, expected: expectedOf(plan), confirm: true })
  assert.equal(applied.ok, false)
  assert.equal(applied.error.code, 'PATH_OUT_OF_SCOPE')
  assert.deepEqual(readdirSync(outside), [], 'nothing was written through the link')
})

// ---------------------------------------------------------------------------
// 10. Surfaces: two tools, and a panel model that refuses an undecided sync
// ---------------------------------------------------------------------------

test('系列同步：工具面注册两个工具，apply 的 schema 要求 expected/decisions/confirm', () => {
  const tools = buildTools({ ctx: {}, dataDir: tmpdir(), version: 'test' })
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const plan = byName.get('inkflow_series_plan')
  const applyTool = byName.get('inkflow_series_apply')
  assert.ok(plan !== undefined, 'inkflow_series_plan must be registered')
  assert.ok(applyTool !== undefined, 'inkflow_series_apply must be registered')
  assert.equal(plan.parameters.properties.confirm, undefined, 'the preview writes nothing, so it takes no confirm')
  assert.deepEqual(Object.keys(plan.parameters.properties).sort(), ['projectRoot'])
  assert.deepEqual(Object.keys(applyTool.parameters.properties).sort(), ['confirm', 'decisions', 'expected', 'projectRoot'])
  assert.equal(applyTool.parameters.properties.expected.type, 'array')
  assert.equal(applyTool.parameters.properties.decisions.type, 'array')
  assert.equal(applyTool.parameters.properties.decisions.items.properties.decision.type, 'string')
  assert.deepEqual(applyTool.parameters.properties.decisions.items.properties.decision.enum, ['take-shared', 'keep-book', 'skip'])
})

/** Bundle the panel's pure model on the fly, the same way `panel-bundle.test.js` does. */
async function loadSeriesModel() {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client', 'series-model.ts')],
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

test('系列同步：面板模型按四类分组、未裁决时挡住 apply，并把计划自己的 expected 交回去', async () => {
  const model = await loadSeriesModel()
  const value = {
    seriesId: 'se-11112222',
    counts: { create: 1, update: 0, conflict: 1, unchanged: 1 },
    entries: [
      { entryId: 'sh-cccc3333', targetPath: 'library/参考资料.md', action: 'conflict', conflict: 'unrelated-file', changedFields: ['body'] },
      { entryId: 'sh-bbbb2222', targetPath: 'world/势力/青萍宗.md', action: 'create', changedFields: [] },
      { entryId: 'sh-aaaa1111', targetPath: 'world/门派/白鹤门.md', action: 'unchanged', changedFields: [] },
    ],
    expected: [
      { entryId: 'sh-cccc3333', action: 'conflict' },
      { entryId: 'sh-bbbb2222', action: 'create' },
      { entryId: 'sh-aaaa1111', action: 'unchanged' },
    ],
    excluded: { byKind: { snippets: 1 }, reference: 1, unhashable: 0 },
  }
  const ready = model.readSeriesPlan({ ok: true, status: 200, value })
  assert.equal(ready.status, 'ready')
  assert.deepEqual(model.seriesGroups(ready).map((group) => group.action), ['conflict', 'create', 'unchanged'], 'conflict first')
  assert.equal(model.seriesSummary(ready).includes('冲突 1'), true)

  // Nothing picked yet / nothing previewed / a conflict undecided / nothing to do.
  assert.equal(model.applyBlockedReason(model.readSeriesPlan({ ok: true, status: 200, value: {} }), {}, ''), model.SERIES_TEXTS.blockedNoBook)
  assert.equal(model.applyBlockedReason({ status: 'idle', message: 'x' }, {}, '/book'), model.SERIES_TEXTS.blockedNoPlan)
  const blocked = model.applyBlockedReason(ready, {}, '/book')
  assert.equal(blocked.startsWith(model.SERIES_TEXTS.blockedUnresolved), true)
  assert.equal(blocked.includes('library/参考资料.md'), true, 'the block names the row still waiting')
  assert.equal(model.unresolvedConflicts(ready, {}).length, 1)

  const decided = { 'sh-cccc3333': 'keep-book' }
  assert.equal(model.applyBlockedReason(ready, decided, '/book'), null, 'a decided conflict unblocks the button')

  const payload = model.applyPayload(ready, decided, '/book')
  assert.equal(payload.confirm, true)
  assert.equal(payload.book, '/book')
  assert.deepEqual(payload.expected, value.expected, 'the plan travels with the request (X-17)')
  assert.deepEqual(payload.decisions, [{ entryId: 'sh-cccc3333', decision: 'keep-book' }], 'only conflicts carry a decision')

  // Only "nothing to write" left: unchanged + a skipped conflict.
  const nothing = model.readSeriesPlan({
    ok: true,
    status: 200,
    value: { counts: { unchanged: 1 }, entries: [{ entryId: 'sh-aaaa1111', targetPath: 'a.md', action: 'unchanged' }] },
  })
  assert.equal(model.applyBlockedReason(nothing, {}, '/book'), model.SERIES_TEXTS.blockedNothing)

  const failed = model.readSeriesPlan({ ok: false, status: 409, error: { code: 'SERIES_CONFLICT_UNRESOLVED', message: 'nope' } })
  assert.equal(failed.status, 'error')
  assert.equal(model.describeSeriesError({ code: 'SERIES_CONFLICT_UNRESOLVED' }).includes('冲突'), true)

  const lines = model.describeApplyResult({
    written: [{ path: 'world/势力/青萍宗.md', action: 'create' }],
    kept: [{ path: 'library/参考资料.md' }],
    skipped: [{ entryId: 'sh-aaaa1111', code: 'SERIES_PLAN_STALE', path: 'world/门派/白鹤门.md' }],
    auditPath: '.inkflow/audit/series-1.json',
    backupDir: '.inkflow/backup/1',
  })
  assert.equal(lines.some((line) => line.includes('已写入 world/势力/青萍宗.md')), true)
  assert.equal(lines.some((line) => line.includes('运行记录：.inkflow/audit/series-1.json')), true)
  assert.equal(lines.some((line) => line.includes('跳过（预览之后变了）')), true)
})

test('系列同步：面板源码只走主题 token，纯模型不碰通道运行时', () => {
  const view = readFileSync(join(ROOT, 'src/client', 'series-sync.tsx'), 'utf8')
  assert.deepEqual(findColorLiterals(view), [], 'no hardcoded colour literals in series-sync.tsx (AGENTS.md §6)')
  assert.ok(view.includes('var(--dsw-alias-'), 'colours come from --dsw-alias-* tokens')
  assert.ok(view.includes('confirm'), 'the apply path carries the confirmation')

  const model = readFileSync(join(ROOT, 'src/client', 'series-model.ts'), 'utf8')
  for (const match of model.matchAll(/import\s+(type\s+)?[^'\n]*from\s+'\.\/internal\.js'/gu)) {
    assert.ok(match[1] !== undefined, 'series-model.ts may only `import type` from ./internal.js (it stays pure)')
  }
})

// ---------------------------------------------------------------------------
// 11. The hub routes the page calls
// ---------------------------------------------------------------------------

const HOST = '127.0.0.1:2151'
const ORIGIN = `http://${HOST}`

/** A book the four-state gate calls `usable` (ADR-0006 D1: `.gitkeep` in every directory). */
function makeGatedBook() {
  const root = tempDir('inkflow-series-route-')
  for (const dir of [...CONTENT_DIRS, 'index']) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.gitignore'), 'index/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '测试书' }, null, 2)}\n`, 'utf8')
  return root
}

function createHarness({ dataDir, book }) {
  const routes = []
  const workspaces = [{ id: 'ws-1', path: book, title: '测试书' }]
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
    get(service) {
      if (service === 'workspaceRegistry') return { list: () => workspaces }
      if (service === 'workingDirectory') return { ensure: async () => book }
      return undefined
    },
    logger() {
      return { debug() {}, info() {}, warn() {}, error() {} }
    },
    tools: { register: () => () => {} },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  apply(ctx, { dataDir })
  return { routes }
}

function fakeRequest({ url, method = 'GET', origin, body } = {}) {
  const headers = { host: HOST, 'content-type': 'application/json' }
  if (origin !== undefined) headers.origin = origin
  const request = { url, method, headers, socket: { remoteAddress: '127.0.0.1' } }
  if (body === undefined) return request
  const buffer = Buffer.from(JSON.stringify(body), 'utf8')
  headers['content-length'] = String(buffer.length)
  request[Symbol.asyncIterator] = async function* iterate() {
    yield buffer
  }
  return request
}

async function hubCall(harness, suffix, options = {}) {
  const route = harness.routes.find((entry) => entry.path === '/inkflow')
  assert.ok(route, 'expected a /inkflow prefix route')
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
  await route.handler(fakeRequest({ ...options, url: `/inkflow/internal/hub${suffix}` }), response)
  return { status: response.statusCode, json: response.body === undefined ? undefined : JSON.parse(response.body) }
}

test('系列同步：/hub/series/plan 只读、/hub/series/apply 受守卫（锚点 / 白名单 / 未裁决）', async () => {
  const dataDir = tempDir('inkflow-series-data-')
  makeShared(dataDir)
  const book = makeGatedBook()
  writeFile(book, 'library/参考资料.md', '---\ntitle: 我自己写的资料\n---\n\n另一份。\n')
  const harness = createHarness({ dataDir, book })
  const sharedBefore = hashTree(join(dataDir, 'shared'))

  // The preview is a GET and writes nothing at all.
  const bookBefore = hashTree(book)
  const preview = await hubCall(harness, `/series/plan?book=${encodeURIComponent(book)}`)
  assert.equal(preview.status, 200, JSON.stringify(preview.json))
  assert.equal(preview.json.ok, true)
  assert.equal(preview.json.value.counts.conflict, 1)
  assert.ok(Array.isArray(preview.json.value.expected), 'the plan hands back the rows apply compares against')
  assert.equal(hashTree(book), bookBefore, 'the preview writes nothing')

  // A write route may not be reached with the read verb.
  const wrongVerb = await hubCall(harness, '/series/apply', { method: 'GET' })
  assert.equal(wrongVerb.status, 405)

  // Every hub write needs a same-origin Origin, and the body allowlist holds.
  const noOrigin = await hubCall(harness, '/series/apply', {
    method: 'POST',
    body: { book, expected: preview.json.value.expected, confirm: true },
  })
  assert.notEqual(noOrigin.status, 200)
  assert.equal(noOrigin.json.ok, false)

  const pathField = await hubCall(harness, '/series/apply', {
    method: 'POST',
    origin: ORIGIN,
    body: { book, root: book, expected: [], confirm: true },
  })
  assert.equal(pathField.status, 400)
  // The channel refuses a `root`/`path` body field before the handler runs (ADR-0010 D6).
  assert.ok(
    ['ROOT_PARAM_NOT_ALLOWED', 'UNEXPECTED_BODY_FIELD'].includes(pathField.json.error.code),
    `a path-shaped body field is refused (got ${String(pathField.json.error.code)})`,
  )

  // An unregistered book is refused before the filesystem is touched.
  const unregistered = await hubCall(harness, '/series/apply', {
    method: 'POST',
    origin: ORIGIN,
    body: { book: tempDir('inkflow-series-other-'), expected: [], confirm: true },
  })
  assert.equal(unregistered.status, 400)
  assert.equal(unregistered.json.error.code, 'BOOK_NOT_REGISTERED')

  // The undecided conflict refuses the whole run, and the book is untouched.
  const stillBook = hashTree(book)
  const refused = await hubCall(harness, '/series/apply', {
    method: 'POST',
    origin: ORIGIN,
    body: { book, expected: preview.json.value.expected, confirm: true },
  })
  assert.equal(refused.status, 409)
  assert.equal(refused.json.error.code, 'SERIES_CONFLICT_UNRESOLVED')
  assert.equal(refused.json.error.unresolved.length, 1, 'the refusal names the row still waiting')
  assert.equal(hashTree(book), stillBook)

  // With the decision in place the same call lands it.
  const applied = await hubCall(harness, '/series/apply', {
    method: 'POST',
    origin: ORIGIN,
    body: {
      book,
      expected: preview.json.value.expected,
      decisions: [{ entryId: 'sh-cccc3333', decision: 'keep-book' }],
      confirm: true,
    },
  })
  assert.equal(applied.status, 200, JSON.stringify(applied.json))
  assert.equal(applied.json.value.written.length, 2, 'the two world entries land')
  assert.equal(applied.json.value.kept.length, 1)
  assert.ok(applied.json.value.auditPath.startsWith('.inkflow/audit/series-'))
  assert.equal(hashTree(join(dataDir, 'shared')), sharedBefore, 'the library is never written')
})

