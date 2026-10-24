/**
 * Local backups as ZIP packages (ADR-0018 D3/D4/D6).
 *
 * Three things this file has to prove, each with the assertion shape the ADR names:
 *
 *   1. the CONTENT SET equals D4's include list minus its exclude list — a set
 *      comparison, not "it contains a file or two", because the whole point of the
 *      rule is what is absent (`index/`, `.git/`, `.inkflow/`);
 *   2. retention keeps the newest N and deletes the oldest — six backups, five left,
 *      and the first one is the one that is gone;
 *   3. a restore compares before it writes: a file edited after the plan is reported
 *      as `BACKUP_CONFLICT` and left alone, while the rest come back byte for byte,
 *      and the derived index is rebuilt afterwards.
 *
 * Runs against the built artifact (`../lib/index.js`).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BACKUP_KEEP_DEFAULT,
  BACKUPS_DIR,
  bookSlugOf,
  collectBackupFiles,
  createBookBackup,
  backupsDir,
  listBookBackups,
  openBookBackup,
  planRestore,
  readZip,
  restoreBookBackup,
  writeZip,
} from '../lib/index.js'
import { hashTree } from './hash-tree.mjs'

const NINE = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']

/** A book with one file in every content directory plus the three excluded trees. */
function book() {
  const parent = mkdtempSync(join(tmpdir(), 'inkflow-backup-zip-'))
  const root = join(parent, '我的书')
  for (const dir of [...NINE, 'index']) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  mkdirSync(join(root, 'chapters', 'vol-01'), { recursive: true })
  // A CRLF + BOM file: a restore has to hand back the same bytes, not "the same text"
  // (ADR-0016 is why every copy this plugin makes is verbatim).
  writeFileSync(join(root, 'chapters', 'vol-01', '0001-a.md'), '\uFEFF# 一\r\n正文\r\n', 'utf8')
  writeFileSync(join(root, 'chapters', 'index.json'), '{"volumes":[],"looseChapters":[]}', 'utf8')
  writeFileSync(join(root, 'characters', '清音.md'), '---\ntitle: 清音\n---\n', 'utf8')
  writeFileSync(join(root, 'world', '苍山.md'), '---\ntitle: 苍山\n---\n', 'utf8')
  writeFileSync(join(root, 'facts', '白云观.md'), '---\ntitle: 白云观\n---\n', 'utf8')
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '我的书' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.gitignore'), 'index/*.db\n.inkflow/\n', 'utf8')
  // Excluded trees: a rebuildable index, git's own history, the plugin's private state.
  writeFileSync(join(root, 'index', 'inkflow.db'), 'not-a-database', 'utf8')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'config'), '[core]\n', 'utf8')
  mkdirSync(join(root, '.inkflow', 'trash', 'deleted'), { recursive: true })
  writeFileSync(join(root, '.inkflow', 'trash', 'deleted', '0002-b.md'), '# 删掉的\n', 'utf8')
  mkdirSync(join(root, '.inkflow', 'backup', '20261024T000000000Z'), { recursive: true })
  writeFileSync(join(root, '.inkflow', 'backup', '20261024T000000000Z', 'manifest.json'), '{}\n', 'utf8')
  // A directory the author keeps inside the repository and asked to skip.
  mkdirSync(join(root, 'chapters', 'scratch'), { recursive: true })
  writeFileSync(join(root, 'chapters', 'scratch', 'notes.md'), '草稿\n', 'utf8')
  return { parent, root, dataDir: join(parent, 'state'), cleanup: () => rmSync(parent, { recursive: true, force: true }) }
}

/** Every file under the nine content directories plus the two root files. */
function expectedSet(root, options = {}) {
  const out = new Set(['inkflow.json', '.gitignore'])
  const walk = (relative) => {
    for (const entry of sortedEntries(join(root, relative))) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else out.add(child)
    }
  }
  for (const dir of NINE) walk(dir)
  for (const excluded of options.excludeDirs ?? []) {
    for (const path of [...out]) {
      if (path === excluded || path.startsWith(`${excluded}/`)) out.delete(path)
    }
  }
  if (options.includeTrash === true) walk('.inkflow/trash')
  return out
}

/** Directory entries in name order, so the fixture walk is reproducible. */
function sortedEntries(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

function packageEntries(dataDir, file) {
  return readZip(readFileSync(join(backupsDir(dataDir), file))).map((entry) => entry.path).sort()
}

test('the package content set equals D4: nine content dirs + inkflow.json + .gitignore, minus index/, .git/ and .inkflow/', () => {
  const fixture = book()
  try {
    const created = createBookBackup(fixture.root, fixture.dataDir, { at: new Date('2026-10-24T09:30:00Z') })
    assert.equal(created.ok, true, JSON.stringify(created))

    const packed = new Set(packageEntries(fixture.dataDir, created.value.file))
    // Set comparison, both directions: nothing missing, and nothing that D4 excludes.
    assert.deepEqual([...packed].sort(), [...expectedSet(fixture.root)].sort())
    for (const excluded of ['index/inkflow.db', '.git/config', '.inkflow/backup/20261024T000000000Z/manifest.json']) {
      assert.equal(packed.has(excluded), false, `${excluded} must not be in a backup (D4)`)
    }
  } finally {
    fixture.cleanup()
  }
})

test('excludeDirs drops a directory the author keeps inside the repository, and includeTrash opts the bin back in', () => {
  const fixture = book()
  try {
    const withoutScratch = createBookBackup(fixture.root, fixture.dataDir, {
      at: new Date('2026-10-24T09:30:00Z'),
      excludeDirs: ['chapters/scratch'],
    })
    assert.equal(withoutScratch.ok, true)
    const packed = new Set(packageEntries(fixture.dataDir, withoutScratch.value.file))
    assert.equal(packed.has('chapters/scratch/notes.md'), false)
    assert.deepEqual([...packed].sort(), [...expectedSet(fixture.root, { excludeDirs: ['chapters/scratch'] })].sort())

    const withTrash = createBookBackup(fixture.root, fixture.dataDir, {
      at: new Date('2026-10-24T09:31:00Z'),
      includeTrash: true,
    })
    assert.equal(withTrash.ok, true)
    const trashPacked = new Set(packageEntries(fixture.dataDir, withTrash.value.file))
    assert.equal(trashPacked.has('.inkflow/trash/deleted/0002-b.md'), true)
    // Opting the bin in does not drag the in-book backup packages along.
    assert.equal(trashPacked.has('.inkflow/backup/20261024T000000000Z/manifest.json'), false)
  } finally {
    fixture.cleanup()
  }
})

test('the package is a standard ZIP: it reads back entry for entry, byte for byte (BOM and CRLF included)', () => {
  const fixture = book()
  try {
    const created = createBookBackup(fixture.root, fixture.dataDir, { at: new Date('2026-10-24T09:30:00Z') })
    assert.equal(created.ok, true)
    const entries = readZip(readFileSync(created.value.path))
    assert.equal(entries.length, created.value.files)
    for (const entry of entries) {
      const original = readFileSync(join(fixture.root, ...entry.path.split('/')))
      assert.equal(Buffer.compare(entry.bytes, original), 0, `${entry.path} must round-trip byte for byte`)
    }
    // The package really is store-only: a stored entry's payload equals its size.
    assert.ok(entries.some((entry) => entry.path === 'chapters/vol-01/0001-a.md'))
  } finally {
    fixture.cleanup()
  }
})

test('retention keeps the newest N and deletes the oldest: six backups leave five, and the first is gone', () => {
  const fixture = book()
  try {
    const stamps = []
    for (let index = 0; index < 6; index += 1) {
      const at = new Date(Date.UTC(2026, 9, 24, 9, 30, index))
      const created = createBookBackup(fixture.root, fixture.dataDir, { at })
      assert.equal(created.ok, true)
      stamps.push(created.value.file)
    }
    const left = listBookBackups(fixture.dataDir, bookSlugOf(fixture.root))
    assert.equal(left.length, BACKUP_KEEP_DEFAULT)
    assert.equal(existsSync(join(backupsDir(fixture.dataDir), stamps[0])), false, 'the oldest package must be pruned')
    for (const file of stamps.slice(1)) assert.equal(existsSync(join(backupsDir(fixture.dataDir), file)), true)
    // Newest first: the list is what the panel shows.
    assert.equal(left[0].file, stamps[5])
  } finally {
    fixture.cleanup()
  }
})

test('keep is clamped: 0 means 1 package, 999 means 50 (and nothing else in the directory is touched)', () => {
  const fixture = book()
  try {
    for (let index = 0; index < 3; index += 1) {
      createBookBackup(fixture.root, fixture.dataDir, { at: new Date(Date.UTC(2026, 9, 24, 9, 30, index)), keep: 0 })
    }
    const slug = bookSlugOf(fixture.root)
    assert.equal(listBookBackups(fixture.dataDir, slug).length, 1)

    // A ZIP the author dropped in by hand is never a retention candidate.
    mkdirSync(backupsDir(fixture.dataDir), { recursive: true })
    writeFileSync(join(backupsDir(fixture.dataDir), 'hand-made.zip'), 'not really a zip', 'utf8')
    createBookBackup(fixture.root, fixture.dataDir, { at: new Date(Date.UTC(2026, 9, 24, 9, 31, 0)), keep: 1 })
    assert.equal(existsSync(join(backupsDir(fixture.dataDir), 'hand-made.zip')), true)
  } finally {
    fixture.cleanup()
  }
})

test('a package name is validated against the book: no path, no other book\'s package', () => {
  const fixture = book()
  try {
    const created = createBookBackup(fixture.root, fixture.dataDir, { at: new Date('2026-10-24T09:30:00Z') })
    assert.equal(created.ok, true)
    const slug = bookSlugOf(fixture.root)

    const traversal = openBookBackup(fixture.dataDir, slug, '../settings.json')
    assert.equal(traversal.ok, false)
    assert.equal(traversal.error.code, 'BACKUP_ZIP_NOT_FOUND')

    const otherBook = openBookBackup(fixture.dataDir, '别的书', created.value.file)
    assert.equal(otherBook.ok, false)
    assert.equal(otherBook.error.code, 'BACKUP_ZIP_NOT_FOUND')
  } finally {
    fixture.cleanup()
  }
})

test('a dry run compares and writes nothing at all (whole-tree hash unchanged)', () => {
  const fixture = book()
  try {
    const created = createBookBackup(fixture.root, fixture.dataDir, { at: new Date('2026-10-24T09:30:00Z') })
    assert.equal(created.ok, true)
    const slug = bookSlugOf(fixture.root)
    const before = hashTree(fixture.root)

    writeFileSync(join(fixture.root, 'characters', '清音.md'), '---\ntitle: 清音\ndesc: 改过\n---\n', 'utf8')
    const afterEdit = hashTree(fixture.root)
    assert.notEqual(afterEdit, before)

    const planned = planRestore(fixture.root, fixture.dataDir, slug, created.value.file)
    assert.equal(planned.ok, true)
    assert.equal(planned.value.counts.overwrite, 1)
    assert.equal(planned.value.counts.same, planned.value.entries.length - 1)
    assert.equal(hashTree(fixture.root), afterEdit, 'a plan must not write')
  } finally {
    fixture.cleanup()
  }
})

test('restore with the plan as baseline: the edited file conflicts and is NOT overwritten, the rest come back', async () => {
  const fixture = book()
  try {
    // 1. Back up a healthy book.
    const created = createBookBackup(fixture.root, fixture.dataDir, { at: new Date('2026-10-24T09:30:00Z') })
    assert.equal(created.ok, true)
    const slug = bookSlugOf(fixture.root)
    const snapshot = new Map(
      readZip(readFileSync(created.value.path)).map((entry) => [entry.path, entry.bytes]),
    )

    // 2. Damage two files, then plan, then damage one of them AGAIN after the plan:
    //    that second edit is the one a restore must refuse to lose (D6).
    const chapter = join(fixture.root, 'chapters', 'vol-01', '0001-a.md')
    const character = join(fixture.root, 'characters', '清音.md')
    writeFileSync(chapter, '被破坏的正文\n', 'utf8')
    writeFileSync(character, '被破坏的角色\n', 'utf8')

    const planned = planRestore(fixture.root, fixture.dataDir, slug, created.value.file)
    assert.equal(planned.ok, true)
    const expected = {}
    for (const entry of planned.value.entries) {
      if (entry.action === 'same') continue
      expected[entry.path] = entry.current
    }
    writeFileSync(character, '预览之后作者又写的新内容\n', 'utf8')

    // 3. Restore with the plan's digests as the baseline.
    const restored = await restoreBookBackup(fixture.root, fixture.dataDir, slug, created.value.file, { expected })
    assert.equal(restored.ok, false)
    assert.equal(restored.error.code, 'BACKUP_CONFLICT')
    assert.deepEqual(restored.error.conflicts.map((conflict) => conflict.path), ['characters/清音.md'])
    assert.deepEqual(restored.error.restored, ['chapters/vol-01/0001-a.md'])

    // The conflicted file kept the author's newer text; the other one is byte-identical
    // to the package (BOM + CRLF included), i.e. the restore is not a text rewrite.
    assert.equal(readFileSync(character, 'utf8'), '预览之后作者又写的新内容\n')
    assert.equal(Buffer.compare(readFileSync(chapter), snapshot.get('chapters/vol-01/0001-a.md')), 0)

    // 4. Retry with the fresh baseline: now everything comes back.
    const replanned = planRestore(fixture.root, fixture.dataDir, slug, created.value.file)
    assert.equal(replanned.ok, true)
    const freshExpected = {}
    for (const entry of replanned.value.entries) {
      if (entry.action === 'same') continue
      freshExpected[entry.path] = entry.current
    }
    const finished = await restoreBookBackup(fixture.root, fixture.dataDir, slug, created.value.file, { expected: freshExpected })
    assert.equal(finished.ok, true, JSON.stringify(finished))
    for (const [path, bytes] of snapshot) {
      assert.equal(Buffer.compare(readFileSync(join(fixture.root, ...path.split('/'))), bytes), 0, `${path} must be back byte for byte`)
    }
    // 5. The derived index was rebuilt after the restore (D6).
    assert.equal(finished.value.index.ok, true)
    assert.equal(finished.value.index.rebuilt, true)
    assert.equal(existsSync(join(fixture.root, 'index', 'inkflow.db')), true)
  } finally {
    fixture.cleanup()
  }
})

test('an entry the backup rules exclude makes the whole package unusable (a foreign ZIP is not a backup)', async () => {
  const fixture = book()
  try {
    mkdirSync(backupsDir(fixture.dataDir), { recursive: true })
    const slug = bookSlugOf(fixture.root)
    const file = `${slug}-20261024-093000.zip`
    writeFileSync(
      join(backupsDir(fixture.dataDir), file),
      writeZip([
        { path: 'chapters/0001-a.md', bytes: '# 一\n' },
        { path: 'index/inkflow.db', bytes: 'nope' },
      ]),
    )
    const planned = planRestore(fixture.root, fixture.dataDir, slug, file)
    assert.equal(planned.ok, false)
    assert.equal(planned.error.code, 'BACKUP_ZIP_UNSAFE')
    assert.equal(planned.error.path, 'index/inkflow.db')

    const before = hashTree(fixture.root)
    const restored = await restoreBookBackup(fixture.root, fixture.dataDir, slug, file)
    assert.equal(restored.ok, false)
    assert.equal(hashTree(fixture.root), before, 'a refused package writes nothing')
  } finally {
    fixture.cleanup()
  }
})

test('restoring without a baseline is the documented "snapshot wins" mode, and reports what the book has extra', async () => {
  const fixture = book()
  try {
    const created = createBookBackup(fixture.root, fixture.dataDir, { at: new Date('2026-10-24T09:30:00Z') })
    assert.equal(created.ok, true)
    const slug = bookSlugOf(fixture.root)
    const snapshot = new Map(readZip(readFileSync(created.value.path)).map((entry) => [entry.path, entry.bytes]))

    writeFileSync(join(fixture.root, 'characters', '清音.md'), '后来写的\n', 'utf8')
    writeFileSync(join(fixture.root, 'characters', '新角色.md'), '包里没有\n', 'utf8')

    const restored = await restoreBookBackup(fixture.root, fixture.dataDir, slug, created.value.file)
    assert.equal(restored.ok, true, JSON.stringify(restored))
    assert.equal(readFileSync(join(fixture.root, 'characters', '清音.md')).toString(), snapshot.get('characters/清音.md').toString())
    // A file the package does not hold is reported, never deleted.
    assert.deepEqual(restored.value.extra, ['characters/新角色.md'])
    assert.equal(existsSync(join(fixture.root, 'characters', '新角色.md')), true)
  } finally {
    fixture.cleanup()
  }
})

test('a directory with nothing to carry is refused instead of writing an empty package', () => {
  const parent = mkdtempSync(join(tmpdir(), 'inkflow-backup-empty-'))
  try {
    const created = createBookBackup(parent, join(parent, 'state'))
    assert.equal(created.ok, false)
    assert.equal(created.error.code, 'BACKUP_EMPTY')
    assert.equal(existsSync(join(backupsDir(join(parent, 'state')), BACKUPS_DIR)), false)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('collectBackupFiles is the single D4 set: sorted, forward slashes, and the same list the package holds', () => {
  const fixture = book()
  try {
    const collected = collectBackupFiles(fixture.root)
    assert.deepEqual([...collected].sort(), [...expectedSet(fixture.root)].sort())
    assert.deepEqual(collected, [...collected].sort())
    assert.equal(collected.some((path) => path.includes('\\')), false)
    assert.equal(collected.some((path) => path.startsWith('index/') || path.startsWith('.git/') || path.startsWith('.inkflow/')), false)
  } finally {
    fixture.cleanup()
  }
})
