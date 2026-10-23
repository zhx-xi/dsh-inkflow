/**
 * Entity rename = **id pinning** (#34, ADR-0014, conventions §5.6).
 *
 * The decision this file pins down, in one sentence: a rename moves the file and
 * writes the OLD id into the new file's `id:`, and **not one referencing file is
 * touched**. The alternative (rewrite every reference) turns one small, atomic,
 * reversible write into N writes with no transaction — the exact shape the
 * "cancelled means zero writes" acceptance criterion exists to forbid.
 *
 * So the assertions are deliberately about *what did not change*:
 *
 *   * `entities` keeps `(kind, id)` and only its `path` moves — everything that
 *     addresses an entity by id keeps working, including `entity_mentions`;
 *   * the relation / timeline / ledger / foreshadow files are byte-identical;
 *   * the rename's own two failure paths (`TARGET_EXISTS`, `FILE_CHANGED`) leave
 *     the whole tree hash unchanged;
 *   * and the divergence it creates is reported as `ID_PATH_DIVERGED` **info**:
 *     the build still succeeds and the next write is still allowed.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { buildImpact, buildIndex, chaptersMentioning, renameEntity } from '../lib/index.js'
import { hashTree } from './hash-tree.mjs'

const DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']
const ENTRY_ID = 'world/门派/白云观.md'
const NEW_ID_UNUSED = 'world/门派/云台观.md'
const RELATION = 'relations/清音-白云观.md'
const TIMELINE = 'timeline/入门.md'
const FACTS = 'facts/白云观.md'
const FORESHADOW = 'foreshadowing/古钟.md'

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-identity-'))
}

function scaffold(root) {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '改名测试' }, null, 2)}\n`, 'utf8')
}

function writeMarkdown(root, relativePath, frontmatterLines, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = frontmatterLines.length > 0 ? `---\n${frontmatterLines.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

/** Same fixture as `impact.test.js`: five chapters, three mentioning the entry, all five reference sites wired. */
function sampleBook(root) {
  scaffold(root)
  writeMarkdown(root, 'chapters/vol-01/0001-甲.md', ['id: ch-1', 'title: 甲', 'seq: 1'], '白云观的山门在半山腰，白云观三个字刻在石上。')
  writeMarkdown(root, 'chapters/vol-01/0002-乙.md', ['id: ch-2', 'title: 乙', 'seq: 2'], '清音走进山门，没有说话。')
  writeMarkdown(root, 'chapters/vol-01/0003-丙.md', ['id: ch-3', 'title: 丙', 'seq: 3'], '白云观里钟声一响。')
  writeMarkdown(root, 'chapters/vol-01/0004-丁.md', ['id: ch-4', 'title: 丁', 'seq: 4'], '山下起了雾。')
  writeMarkdown(root, 'chapters/vol-01/0005-戊.md', ['id: ch-5', 'title: 戊', 'seq: 5'], '他又回白云观。')

  writeMarkdown(root, 'characters/清音.md', ['name: 清音', 'group: 白云观'], '白云观弟子。')
  writeMarkdown(root, ENTRY_ID, ['title: 白云观', 'category: 门派'], '山中道观。')

  writeMarkdown(root, RELATION, ['source: characters/清音.md', `target: ${ENTRY_ID}`, 'kind: character', 'title: 清音 与 白云观'])
  writeMarkdown(root, TIMELINE, [
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
  writeMarkdown(root, FACTS, [`subject: ${ENTRY_ID}`, 'title: 白云观'], '- attribute: 位置 | value: 苍山 | source: manual\n')
  writeMarkdown(root, FORESHADOW, ['title: 古钟', 'status: planted', `linkedEntities: [${ENTRY_ID}]`])
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * The book's own bytes and mtimes, **without** `index/`.
 *
 * The project write lock is a file inside `index/` (§5.3), so acquiring and
 * releasing it moves that directory's mtime even on a refusal — an existing,
 * documented behaviour (conventions §5.5). "零写入" is therefore asserted on the
 * truth files here, with the derived database hashed separately (`indexDigest`),
 * which is the stronger pair: a rebuild would change the database, and no truth
 * file may move at all.
 */
function hashTruth(root, relative = '') {
  const hash = createHash('sha256')
  const walk = (relativePath) => {
    const dir = relativePath === '' ? root : join(root, relativePath)
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (relativePath === '' && entry.name === 'index') continue
      const child = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`
      const info = statSync(join(root, child))
      hash.update(`${child}|${entry.isDirectory() ? 'd' : 'f'}|${info.size}|${info.mtimeMs}\n`)
      if (entry.isDirectory()) walk(child)
    }
  }
  walk('')
  return hash.digest('hex')
}

function indexDigest(root) {
  const dbFile = join(root, 'index', 'inkflow.db')
  return existsSync(dbFile) ? sha256File(dbFile) : 'absent'
}

function sourceFor(root) {
  return { sessionId: 'session-identity', root }
}

function fingerprintOf(root, relativePath) {
  const bytes = readFileSync(join(root, relativePath))
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  }
}

function okBody(reply) {
  assert.equal(reply.status, 200, `expected 200, got ${String(reply.status)}: ${JSON.stringify(reply.body)}`)
  assert.equal(reply.body.ok, true, JSON.stringify(reply.body))
  return reply.body.value
}

function readEntityRow(root, kind, id) {
  const db = new DatabaseSync(join(root, 'index', 'inkflow.db'), { readOnly: true })
  try {
    const row = db.prepare('SELECT id, path, title FROM entities WHERE kind = ? AND id = ?').get(kind, id)
    return row === undefined ? undefined : { id: String(row.id), path: String(row.path), title: String(row.title) }
  } finally {
    db.close()
  }
}

function validationCodes(root) {
  const db = new DatabaseSync(join(root, 'index', 'inkflow.db'), { readOnly: true })
  try {
    const rows = db.prepare('SELECT code, path FROM validation_issues').all()
    return rows.map((row) => ({ code: String(row.code), path: row.path === null ? null : String(row.path) }))
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// 1. The rename itself
// ---------------------------------------------------------------------------

test('identity: a rename moves the file, pins the old id, and leaves all five reference sites untouched', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)
    const mentionsBefore = chaptersMentioning(root, `world:${ENTRY_ID}`)
    assert.equal(mentionsBefore.length, 3, 'the fixture really does have three mentioning chapters')

    const references = [RELATION, TIMELINE, FACTS, FORESHADOW].map((path) => [path, sha256File(join(root, path))])

    const value = okBody(
      await renameEntity({
        source: sourceFor(root),
        version: '1.0.0',
        body: { kind: 'world', id: ENTRY_ID, slug: '云台观', title: '云台观', expected: fingerprintOf(root, ENTRY_ID) },
      }),
    )

    assert.equal(value.id, ENTRY_ID, 'the entity id does not change: it is the address every reference holds')
    assert.equal(value.path, NEW_ID_UNUSED, 'the file moved to the new name inside the same category directory')
    assert.equal(value.previousPath, ENTRY_ID)
    assert.equal(value.pinnedId, true)
    assert.equal(value.title, '云台观')
    assert.deepEqual(value.changed, ['file', 'id', 'title'])

    assert.equal(existsSync(join(root, NEW_ID_UNUSED)), true, 'the new file exists')
    assert.equal(existsSync(join(root, ENTRY_ID)), false, 'the old file is gone — a rename is not a copy')

    const written = readFileSync(join(root, NEW_ID_UNUSED), 'utf8')
    assert.match(written, /^---\n/u)
    assert.match(written, new RegExp(`\nid: ${ENTRY_ID.replaceAll('/', '\\/')}\n`, 'u'), 'the OLD id is pinned into the new file')
    assert.match(written, /\ntitle: 云台观\n/u, 'the title field follows the rename')
    assert.match(written, /山中道观。$/u, 'the body survives byte for byte')

    for (const [path, hash] of references) {
      assert.equal(sha256File(join(root, path)), hash, `${path} must not be touched by a rename (X-15)`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('identity: after the rename the index keeps id, moves path, and keeps every mention', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)
    const mentionsBefore = chaptersMentioning(root, `world:${ENTRY_ID}`)
    const totalBefore = mentionsBefore.reduce((sum, row) => sum + row.mentions, 0)

    const value = okBody(
      await renameEntity({
        source: sourceFor(root),
        version: '1.0.0',
        body: { kind: 'world', id: ENTRY_ID, slug: '云台观', expected: fingerprintOf(root, ENTRY_ID) },
      }),
    )

    const row = readEntityRow(root, 'world', ENTRY_ID)
    assert.deepEqual(
      row,
      { id: ENTRY_ID, path: NEW_ID_UNUSED, title: '白云观' },
      'I-15/ADR-0014: same id, new path — this request renamed the FILE only, so the display name is untouched',
    )
    assert.deepEqual(value.before, { id: ENTRY_ID, path: ENTRY_ID })
    assert.deepEqual(value.after, { id: ENTRY_ID, path: NEW_ID_UNUSED })

    const mentionsAfter = chaptersMentioning(root, `world:${ENTRY_ID}`)
    assert.deepEqual(
      mentionsAfter.map((row) => row.chapterId).sort(),
      mentionsBefore.map((row) => row.chapterId).sort(),
      'the mention rows still resolve: they were keyed by id, not by path',
    )
    assert.equal(mentionsAfter.reduce((sum, row) => sum + row.mentions, 0), totalBefore)
    assert.deepEqual(value.mentions, { before: totalBefore, after: totalBefore })

    const codes = validationCodes(root)
    assert.deepEqual(
      codes.filter((issue) => issue.code === 'RELATION_ENDPOINT'),
      [],
      'no relation endpoint dangles — proof the pinning works and no reference needed rewriting',
    )
    assert.deepEqual(
      codes.filter((issue) => issue.code === 'DANGLING_PARENT'),
      [],
      'nothing else lost its parent on the move',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('identity: id/path divergence is reported as info — the rebuild and the next write both still go through', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)

    const value = okBody(
      await renameEntity({
        source: sourceFor(root),
        version: '1.0.0',
        body: { kind: 'world', id: ENTRY_ID, slug: '云台观', expected: fingerprintOf(root, ENTRY_ID) },
      }),
    )
    assert.equal(value.indexRebuilt, true)

    const diverged = validationCodes(root).filter((issue) => issue.code === 'ID_PATH_DIVERGED')
    assert.deepEqual(
      diverged.map((issue) => issue.path),
      [NEW_ID_UNUSED],
      'I-20: the entry that was renamed is listed (it carries `id: world/门派/白云观.md` at a different path)',
    )

    // Non-blocking, twice over: the build that reported it succeeded, and a plain
    // save on the renamed entry is still allowed afterwards.
    const saved = okBody(
      await renameEntity({
        source: sourceFor(root),
        version: '1.0.0',
        body: { kind: 'world', id: ENTRY_ID, title: '云台观（重修）', expected: fingerprintOf(root, NEW_ID_UNUSED) },
      }),
    )
    assert.equal(saved.path, NEW_ID_UNUSED, 'a title-only change keeps the file name')
    assert.equal(saved.id, ENTRY_ID, 'and keeps the pinned id')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('identity: a hand-written short id is not a rename trace, so I-20 stays quiet about it', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    // The style a hand-authored library uses: `id: char-1` on a file named 清音.md.
    // Nothing was renamed, so a report saying "this name was changed" would be a lie
    // — and on a real book it would be one lie per entry.
    writeMarkdown(root, 'characters/清音.md', ['id: char-1', 'name: 清音'], '白云观弟子。')
    await buildIndex(root)

    assert.deepEqual(
      validationCodes(root).filter((issue) => issue.code === 'ID_PATH_DIVERGED'),
      [],
      'a hand-written id is an identity, not a former path',
    )

    // …and renaming the OTHER entry afterwards lists exactly that one.
    okBody(
      await renameEntity({
        source: sourceFor(root),
        version: '1.0.0',
        body: { kind: 'world', id: ENTRY_ID, slug: '云台观', expected: fingerprintOf(root, ENTRY_ID) },
      }),
    )
    assert.deepEqual(
      validationCodes(root).filter((issue) => issue.code === 'ID_PATH_DIVERGED').map((issue) => issue.path),
      [NEW_ID_UNUSED],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('identity: renaming again keeps the pinned id instead of generating a new one', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)

    okBody(
      await renameEntity({
        source: sourceFor(root),
        version: '1.0.0',
        body: { kind: 'world', id: ENTRY_ID, slug: '云台观', expected: fingerprintOf(root, ENTRY_ID) },
      }),
    )
    const second = okBody(
      await renameEntity({
        source: sourceFor(root),
        version: '1.0.0',
        body: { kind: 'world', id: ENTRY_ID, slug: '云台观新址', expected: fingerprintOf(root, NEW_ID_UNUSED) },
      }),
    )
    assert.equal(second.id, ENTRY_ID, 'ADR-0014 §5: the second rename reuses the id already in the file')
    assert.equal(second.path, 'world/门派/云台观新址.md')
    assert.equal(readEntityRow(root, 'world', ENTRY_ID).path, 'world/门派/云台观新址.md')
    assert.equal(readdirSync(join(root, 'world', '门派')).filter((name) => name.endsWith('.md')).length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 1b. What a request may and may not write into the file
// ---------------------------------------------------------------------------

test('identity: a title-only edit writes no `id:` — only a move pins', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)

    // ADR-0014 §4 / §5.6: "只有「改名」写 `id`". A file whose name did not change has
    // nothing for the id to hold on to, so writing one would make the file claim it had
    // been renamed — and #33's audit would then list `ID_PATH_DIVERGED` for a rename
    // that never happened.
    const value = okBody(
      await renameEntity({
        source: sourceFor(root),
        version: '1.0.0',
        body: { kind: 'world', id: ENTRY_ID, title: '白云观（重修）', expected: fingerprintOf(root, ENTRY_ID) },
      }),
    )
    assert.equal(value.path, ENTRY_ID, 'a title-only edit keeps the file name')
    assert.deepEqual(value.changed, ['title'], 'the file did not move, so neither `file` nor `id` changed')
    assert.equal(value.pinnedId, false, 'nothing is pinned: the id still equals the path')

    const written = readFileSync(join(root, ENTRY_ID), 'utf8')
    assert.match(written, /\ntitle: 白云观（重修）\n/u)
    assert.equal(/(^|\n)id:/u.test(written), false, 'no `id:` line was added')
    assert.deepEqual(
      validationCodes(root).filter((issue) => issue.code === 'ID_PATH_DIVERGED'),
      [],
      'I-20 stays quiet: this entry is not a renamed one',
    )

    // The move that follows pins as before — the rule is about the move, not about
    // the request that happens to carry a title.
    const renamed = okBody(
      await renameEntity({
        source: sourceFor(root),
        version: '1.0.0',
        body: { kind: 'world', id: ENTRY_ID, slug: '云台观', expected: fingerprintOf(root, ENTRY_ID) },
      }),
    )
    assert.deepEqual(renamed.changed, ['file', 'id'])
    assert.equal(renamed.pinnedId, true)
    assert.match(
      readFileSync(join(root, NEW_ID_UNUSED), 'utf8'),
      new RegExp(`\nid: ${ENTRY_ID.replaceAll('/', '\\/')}\n`, 'u'),
      'a real move still pins the old id',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('identity: renaming a BOM+CRLF entry keeps the body and lands as plain LF with the pin', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    // The file a Windows editor leaves behind: UTF-8 BOM + CRLF. Reading must tolerate
    // it (H11) while the write normalises it (io.ts `normalizeText`, §5) — the pair a
    // hand-rolled rename gets wrong in one direction or the other.
    writeFileSync(join(root, ENTRY_ID), '\uFEFF---\r\ntitle: 白云观\r\ncategory: 门派\r\n---\r\n\r\n山中道观。\r\n', 'utf8')
    await buildIndex(root)

    const value = okBody(
      await renameEntity({
        source: sourceFor(root),
        version: '1.0.0',
        body: { kind: 'world', id: ENTRY_ID, slug: '云台观', title: '云台观', expected: fingerprintOf(root, ENTRY_ID) },
      }),
    )
    assert.deepEqual(value.changed, ['file', 'id', 'title'])

    const written = readFileSync(join(root, NEW_ID_UNUSED), 'utf8')
    assert.equal(written.startsWith('\uFEFF'), false, 'the BOM does not survive the write')
    assert.equal(written.includes('\r'), false, 'CRLF is normalised to LF at the write door, in one place')
    assert.match(written, /^---\ntitle: 云台观\ncategory: 门派\nid: [^\n]+\n---\n/u, 'frontmatter order and keys survive; the pin is appended')
    assert.match(written, new RegExp(`\nid: ${ENTRY_ID.replaceAll('/', '\\/')}\n`, 'u'))
    assert.equal(written.endsWith('山中道观。\n'), true, 'the prose survives byte for byte (after normalisation)')
    assert.equal(existsSync(join(root, ENTRY_ID)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('identity: a renamed entry answers to its NEW path as well as to its pinned id', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)
    okBody(
      await renameEntity({
        source: sourceFor(root),
        version: '1.0.0',
        body: { kind: 'world', id: ENTRY_ID, slug: '云台观', expected: fingerprintOf(root, ENTRY_ID) },
      }),
    )

    // A pinned id is a *former* path, so the file's current location no longer matches
    // any id. Whoever reads the tree (or the panel row) holds the path, and asking for
    // the impact of that path must land on the entry carrying the old id.
    const byPath = await buildImpact(sourceFor(root), '1.0.0', { kind: 'world', id: NEW_ID_UNUSED })
    assert.equal(byPath.status, 200, JSON.stringify(byPath.body))
    assert.equal(byPath.body.value.id, ENTRY_ID, 'the entry is still addressed by its pinned id')
    assert.equal(byPath.body.value.path, NEW_ID_UNUSED)
    assert.equal(byPath.body.value.totals.chapters, 3, 'and its mentions still resolve')

    const byId = await buildImpact(sourceFor(root), '1.0.0', { kind: 'world', id: ENTRY_ID })
    assert.equal(byId.status, 200, 'the old id keeps working too — that is the point of pinning it')
    assert.equal(byId.body.value.path, NEW_ID_UNUSED)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('identity: deleting the renamed entry afterwards is what dangles the references', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)
    okBody(
      await renameEntity({
        source: sourceFor(root),
        version: '1.0.0',
        body: { kind: 'world', id: ENTRY_ID, slug: '云台观', expected: fingerprintOf(root, ENTRY_ID) },
      }),
    )
    assert.deepEqual(
      validationCodes(root).filter((issue) => issue.code === 'RELATION_ENDPOINT'),
      [],
      'the rename itself dangles nothing',
    )

    // The entry is deleted for real (the author's own action): now the relation's
    // `target` names an id that no file carries any more. This is the failure the
    // pinning exists to prevent *for renames* — a deletion is the one case it cannot.
    rmSync(join(root, NEW_ID_UNUSED))
    await buildIndex(root)
    const dangling = validationCodes(root).filter((issue) => issue.code === 'RELATION_ENDPOINT')
    assert.equal(dangling.length > 0, true, 'with the file gone, `RELATION_ENDPOINT` is the honest report')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. Refusals: each one has to leave the tree exactly as it was
// ---------------------------------------------------------------------------

test('identity: renaming onto an existing file is refused with TARGET_EXISTS and writes nothing', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    writeMarkdown(root, NEW_ID_UNUSED, ['title: 云台观', 'category: 门派'], '另一座道观。')
    await buildIndex(root)
    const before = hashTruth(root)
    const indexBefore = indexDigest(root)
    const occupied = sha256File(join(root, NEW_ID_UNUSED))

    const reply = await renameEntity({
      source: sourceFor(root),
      version: '1.0.0',
      body: { kind: 'world', id: ENTRY_ID, slug: '云台观', expected: fingerprintOf(root, ENTRY_ID) },
    })
    assert.equal(reply.status, 409)
    assert.equal(reply.body.ok, false)
    assert.equal(reply.body.error.code, 'TARGET_EXISTS')
    assert.equal(reply.body.error.target, NEW_ID_UNUSED)

    assert.equal(hashTruth(root), before, 'neither file moved, no byte changed anywhere')
    assert.equal(indexDigest(root), indexBefore, 'a refusal does not rebuild the index either')
    assert.equal(sha256File(join(root, NEW_ID_UNUSED)), occupied, 'the occupied target keeps its own content')
    assert.equal(existsSync(join(root, ENTRY_ID)), true, 'the source is still where it was')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('identity: a stale baseline is refused with FILE_CHANGED and writes nothing', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)
    const expected = fingerprintOf(root, ENTRY_ID)
    // The author's editor saves behind the panel's back: the baseline handed out
    // by the impact listing is now stale.
    writeFileSync(join(root, ENTRY_ID), '---\ntitle: 白云观\ncategory: 门派\n---\n\n改过的正文。\n', 'utf8')
    const before = hashTruth(root)
    const indexBefore = indexDigest(root)

    const reply = await renameEntity({
      source: sourceFor(root),
      version: '1.0.0',
      body: { kind: 'world', id: ENTRY_ID, slug: '云台观', expected },
    })
    assert.equal(reply.status, 409)
    assert.equal(reply.body.error.code, 'FILE_CHANGED')
    assert.equal(reply.body.error.nothingWritten, true)
    assert.equal(hashTruth(root), before, '零写入: the file that drifted stays exactly as the editor left it')
    assert.equal(indexDigest(root), indexBefore, 'a 409 leaves the derived index alone')
    assert.equal(existsSync(join(root, NEW_ID_UNUSED)), false, 'no half-copy of the new name either')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('identity: a missing baseline, a no-op rename and a ledger file are each refused', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)
    const before = hashTruth(root)
    const indexBefore = indexDigest(root)

    const noBaseline = await renameEntity({
      source: sourceFor(root),
      version: '1.0.0',
      body: { kind: 'world', id: ENTRY_ID, slug: '云台观' },
    })
    assert.equal(noBaseline.status, 400)
    assert.equal(noBaseline.body.error.code, 'EXPECTED_REQUIRED')

    const noChange = await renameEntity({
      source: sourceFor(root),
      version: '1.0.0',
      body: { kind: 'world', id: ENTRY_ID, slug: '白云观', expected: fingerprintOf(root, ENTRY_ID) },
    })
    assert.equal(noChange.status, 400)
    assert.equal(noChange.body.error.code, 'RENAME_NO_CHANGE')

    // `facts/<subject>.md`: the file name IS the subject, so "rename" would mean
    // changing what the entry is about — a ledger decision, not a file move.
    const ledger = await renameEntity({
      source: sourceFor(root),
      version: '1.0.0',
      body: { kind: 'facts', id: FACTS, slug: '白云观-旧', expected: fingerprintOf(root, FACTS) },
    })
    assert.equal(ledger.status, 400)
    assert.equal(ledger.body.error.code, 'KIND_NOT_RENAMEABLE')

    assert.equal(hashTruth(root), before, 'all three refusals are zero-write')
    assert.equal(indexDigest(root), indexBefore, '…and none of them rebuilds the index')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('identity: a dot-leading file name is refused with SLUG_INVALID and writes nothing', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)

    // Why this is a refusal and not a style rule: both scanners skip dot entries
    // (`indexer.ts`'s walk, `impact.ts`'s listing), so a written `.hidden.md` exists on
    // disk and in no listing — the entry is invisible, its mentions are zero and the
    // relations naming it start reporting `RELATION_ENDPOINT`. Placing one by hand
    // demonstrates exactly that; git would be the only way back.
    writeMarkdown(root, 'world/门派/.hidden.md', ['title: 隐藏观', 'category: 门派'], '不该出现在任何清单里。')
    await buildIndex(root)
    const invisible = await buildImpact(sourceFor(root), '1.0.0', { kind: 'world', title: '隐藏观' })
    assert.equal(invisible.status, 404, 'a dot file is invisible to the listing — which is why the writer must refuse it')
    rmSync(join(root, 'world', '门派', '.hidden.md'))

    const before = hashTruth(root)
    const indexBefore = indexDigest(root)
    for (const slug of ['.', '..', '.hidden']) {
      const reply = await renameEntity({
        source: sourceFor(root),
        version: '1.0.0',
        body: { kind: 'world', id: ENTRY_ID, slug, expected: fingerprintOf(root, ENTRY_ID) },
      })
      assert.equal(reply.status, 400, `slug ${JSON.stringify(slug)} must be refused`)
      assert.equal(reply.body.error.code, 'SLUG_INVALID', JSON.stringify(reply.body))
    }

    assert.equal(hashTruth(root), before, '零写入: no dot file, no renamed file, no byte changed')
    assert.equal(indexDigest(root), indexBefore, 'a refusal does not rebuild the index')
    assert.deepEqual(
      readdirSync(join(root, 'world', '门派')).filter((name) => name.endsWith('.md')),
      ['白云观.md'],
      'the only entry is the one that was already there',
    )
    assert.equal(
      (await buildImpact(sourceFor(root), '1.0.0', { kind: 'world', id: ENTRY_ID })).status,
      200,
      'the entry is still reachable — the refusal is what kept it that way',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. Cancelling: the dialog's own path (list, then close without confirming)
// ---------------------------------------------------------------------------

test('identity: listing the impact and closing the dialog without confirming writes nothing at all', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)

    const treeBefore = hashTree(root)
    const filesBefore = [ENTRY_ID, RELATION, TIMELINE, FACTS, FORESHADOW].map((path) => [path, sha256File(join(root, path))])

    const listed = await buildImpact(sourceFor(root), '1.0.0', { kind: 'world', id: ENTRY_ID, slug: '云台观', title: '云台观' })
    assert.equal(listed.status, 200)
    assert.equal(listed.body.value.rename.to, NEW_ID_UNUSED, 'the dialog had a real plan to show')
    // …and the author clicks 取消: nothing else happens.

    assert.equal(hashTree(root), treeBefore, '取消 = 零写入: no file, no mtime, no rebuild')
    for (const [path, hash] of filesBefore) assert.equal(sha256File(join(root, path)), hash)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
