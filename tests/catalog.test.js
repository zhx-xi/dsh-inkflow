/**
 * Volume/chapter catalog contract (issue #15, ADR-0006 D6).
 *
 * The catalog is a **projection**: `chapters/**\/*.md` (file name + frontmatter)
 * is the truth, `chapters/index.json` and `chapters/<vol-dir>/index.json` are a
 * reviewable, committed copy of the structure. That single sentence decides every
 * test below:
 *
 *   - reading must never write: a missing or hand-edited catalog only yields
 *     `catalogStale: true` plus an in-memory projection (a read path that wrote
 *     would make the panel/diagnostic surface mutate the user's repository);
 *   - rebuilding must be derived, atomic and idempotent: the same `.md` files
 *     twice produce byte-identical catalogs, and a failed write leaves the old
 *     catalog untouched (io.ts atomicity, issue #14);
 *   - the projection must resolve ownership from `volume` (volumeId) first and
 *     from the directory name only as a fallback, so renaming a volume slug does
 *     not renumber a single chapter;
 *   - the catalog is not a gate requirement (deleting it must not make a healthy
 *     book unreadable) and building the SQLite index must not write it.
 *
 * Like the other suites these run against the built artifact (lib/index.js).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { buildIndex, inspectProject, readCatalog, rebuildCatalog, validateCatalog } from '../lib/index.js'

const CHAPTERS = 'chapters'
const ROOT_CATALOG = 'chapters/index.json'
const REQUIRED_DIRS = [
  'chapters',
  'characters',
  'world',
  'outlines',
  'foreshadowing',
  'timeline',
  'relations',
  'facts',
  'library',
  'index',
]

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-catalog-'))
}

/** A usable project skeleton: git marker, ten dirs with .gitkeep, meta, gitignore. */
function project(dir) {
  const root = join(dir, 'book')
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const name of REQUIRED_DIRS) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '清单测试' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.gitignore'), 'index/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  return root
}

function chapter(root, relativePath, fields = {}) {
  const lines = ['---']
  if (fields.id !== undefined) lines.push(`id: ${fields.id}`)
  if (fields.title !== undefined) lines.push(`title: ${fields.title}`)
  if (fields.volume !== undefined) lines.push(`volume: ${fields.volume}`)
  if (fields.seq !== undefined) lines.push(`seq: ${fields.seq}`)
  lines.push('---', '', '正文第一段。', '')
  const absolute = join(root, ...relativePath.split('/'))
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, lines.join('\n'), 'utf8')
  return relativePath
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

test('catalog: a volume takes its title from the matching outline, not the slug', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    chapter(root, 'chapters/vol-01-ru-shan/0001-a.md', { title: '第一章', volume: 'vol-01', seq: 1 })
    writeFileSync(join(root, 'outlines', 'vol-01-ru-shan.md'), '---\ntitle: 入山卷\n---\n\n# 入山\n', 'utf8')

    const result = readCatalog(root)
    const volume = result.catalog.volumes.find((item) => item.volumeId === 'vol-01')
    assert.equal(volume.title, '入山卷', 'the outline is the human-authored source for the volume name')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog: without an outline the volume title falls back to the directory slug', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    chapter(root, 'chapters/vol-01-ru-shan/0001-a.md', { title: '第一章', volume: 'vol-01', seq: 1 })

    const result = readCatalog(root)
    const volume = result.catalog.volumes.find((item) => item.volumeId === 'vol-01')
    assert.equal(volume.title, 'ru-shan')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Content snapshot of the whole project (files + presence of directories). */
function snapshot(root) {
  const entries = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        entries.push(`${relative}/`)
        walk(absolute, relative)
        continue
      }
      entries.push(`${relative}:${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`)
    }
  }
  walk(root, '')
  return entries.sort()
}

function volumeCatalogPath(dir) {
  return `${CHAPTERS}/${dir}/index.json`
}

function codes(issues) {
  return issues.map((issue) => issue.code)
}

// ---------------------------------------------------------------------------
// 1. Projection: volumes and loose chapters mixed
// ---------------------------------------------------------------------------

test('catalog: read projects volumes, owned chapters and loose chapters from .md', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    chapter(root, 'chapters/vol-01-入山/0001-入山.md', { title: '第一章 入山', volume: 'vol-01', seq: 1 })
    chapter(root, 'chapters/vol-01-入山/0002-夜行.md', { title: '第二章 夜行', volume: 'vol-01', seq: 2 })
    // A chapter in the vol-02 directory whose frontmatter claims vol-01:
    // ownership follows `volume`, not the folder (ADR-0006 D6).
    chapter(root, 'chapters/vol-02-出海/0003-出海.md', { title: '第三章 出海', seq: 3 })
    chapter(root, 'chapters/vol-02-出海/0004-归途.md', { title: '第四章 归途', volume: 'vol-01', seq: 4 })
    // Loose chapters sit directly in chapters/.
    chapter(root, 'chapters/0010-序章.md', { title: '序章', seq: 10 })
    chapter(root, 'chapters/外传.md')

    const result = readCatalog(root)

    assert.equal(result.root, root)
    assert.equal(result.catalogStale, true, 'no catalog on disk yet')
    assert.deepEqual(result.catalog.volumes, [
      { volumeId: 'vol-01', dir: 'vol-01-入山', title: '入山', order: 1 },
      { volumeId: 'vol-02', dir: 'vol-02-出海', title: '出海', order: 2 },
    ])

    const vol1 = result.volumeCatalogs.find((catalog) => catalog.volumeId === 'vol-01')
    const vol2 = result.volumeCatalogs.find((catalog) => catalog.volumeId === 'vol-02')
    assert.ok(vol1)
    assert.ok(vol2)
    assert.deepEqual(
      vol1.chapters.map((item) => [item.seq, item.file]),
      [
        [1, 'chapters/vol-01-入山/0001-入山.md'],
        [2, 'chapters/vol-01-入山/0002-夜行.md'],
        // Owned by vol-01 through frontmatter even though the file is under vol-02.
        [4, 'chapters/vol-02-出海/0004-归途.md'],
      ],
    )
    assert.deepEqual(
      vol2.chapters.map((item) => [item.seq, item.file]),
      [[3, 'chapters/vol-02-出海/0003-出海.md']],
    )

    assert.deepEqual(
      result.catalog.looseChapters.map((item) => [item.seq, item.file, item.title]),
      [
        [10, 'chapters/0010-序章.md', '序章'],
        // No seq to derive: ordered by file name and the field is omitted rather
        // than invented (a fake 0 would collide with a real chapter 0).
        [undefined, 'chapters/外传.md', '外传'],
      ],
    )
    assert.equal(Object.hasOwn(result.catalog.looseChapters[1], 'seq'), false)

    // The projection carries the chapter id: frontmatter id wins, path otherwise.
    assert.equal(vol1.chapters[0].chapterId, 'chapters/vol-01-入山/0001-入山.md')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog: read is read-only — no catalog file, no index, no temp residue', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    chapter(root, 'chapters/vol-01-入山/0001-入山.md', { title: '第一章', seq: 1 })
    const before = snapshot(root)

    const first = readCatalog(root)
    const second = readCatalog(root)

    assert.deepEqual(snapshot(root), before, 'readCatalog must not touch the project')
    assert.equal(existsSync(join(root, ROOT_CATALOG)), false)
    assert.equal(existsSync(join(root, volumeCatalogPath('vol-01-入山'))), false)
    assert.equal(existsSync(join(root, 'index', '.write.lock')), false, 'the read path takes no lock')
    assert.equal(existsSync(join(root, 'index', 'inkflow.db')), false, 'the read path builds no index')
    assert.deepEqual(first, second)
    assert.equal(first.catalogStale, true)
    assert.deepEqual(first.staleFiles.sort(), [ROOT_CATALOG, volumeCatalogPath('vol-01-入山')].sort())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. Rebuild: derived, atomic, idempotent
// ---------------------------------------------------------------------------

test('catalog: rebuild writes both catalog files and agrees with the .md files', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    chapter(root, 'chapters/vol-01-入山/0001-入山.md', { title: '第一章 入山', volume: 'vol-01', seq: 1 })
    chapter(root, 'chapters/vol-01-入山/0002-夜行.md', { title: '第二章 夜行', volume: 'vol-01', seq: 2 })
    chapter(root, 'chapters/0010-序章.md', { title: '序章', seq: 10 })

    const rebuilt = rebuildCatalog(root)
    assert.equal(rebuilt.ok, true)
    assert.deepEqual(rebuilt.volumes, [{ volumeId: 'vol-01', dir: 'vol-01-入山', title: '入山', order: 1 }])
    assert.deepEqual(rebuilt.looseChapters.map((item) => item.file), ['chapters/0010-序章.md'])
    // Volume lists first, top-level list last: a failure leaves the root catalog
    // behind, so the read path reports `catalogStale` instead of a half-truth.
    assert.deepEqual(rebuilt.written, [volumeCatalogPath('vol-01-入山'), ROOT_CATALOG])

    const rootCatalog = readJson(join(root, ROOT_CATALOG))
    assert.deepEqual(rootCatalog, {
      schemaVersion: 1,
      volumes: [{ volumeId: 'vol-01', dir: 'vol-01-入山', title: '入山', order: 1 }],
      looseChapters: [
        { chapterId: 'chapters/0010-序章.md', file: 'chapters/0010-序章.md', seq: 10, title: '序章' },
      ],
    })
    const volumeCatalog = readJson(join(root, volumeCatalogPath('vol-01-入山')))
    assert.equal(volumeCatalog.schemaVersion, 1)
    assert.equal(volumeCatalog.volumeId, 'vol-01')
    assert.deepEqual(
      volumeCatalog.chapters.map((item) => [item.seq, item.file, item.title]),
      [
        [1, 'chapters/vol-01-入山/0001-入山.md', '第一章 入山'],
        [2, 'chapters/vol-01-入山/0002-夜行.md', '第二章 夜行'],
      ],
    )

    // Written bytes: UTF-8 without BOM, LF only, two-space JSON, trailing newline.
    const text = readFileSync(join(root, ROOT_CATALOG), 'utf8')
    assert.equal(text.charCodeAt(0) === 0xfeff, false)
    assert.equal(text.includes('\r'), false)
    assert.equal(text.endsWith('\n'), true)
    assert.equal(text.includes('\n  "volumes"'), true)

    const after = readCatalog(root)
    assert.equal(after.catalogStale, false)
    assert.deepEqual(after.staleFiles, [])
    assert.deepEqual(after.catalog, rootCatalog)
    assert.deepEqual(validateCatalog(root).issues, [], 'a fresh catalog violates no invariant')

    // The catalog is a projection, never a reason to build the SQLite index.
    assert.equal(existsSync(join(root, 'index', 'inkflow.db')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog: rebuild is idempotent — same .md files, same bytes and same result', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    chapter(root, 'chapters/vol-01-入山/0001-入山.md', { title: '第一章', volume: 'vol-01', seq: 1 })
    // Deliberately shuffled creation order: ordering comes from seq/file, not
    // from readdir order (which the OS does not guarantee).
    chapter(root, 'chapters/vol-01-入山/0003-三.md', { title: '第三章', volume: 'vol-01', seq: 3 })
    chapter(root, 'chapters/vol-01-入山/0002-二.md', { title: '第二章', volume: 'vol-01', seq: 2 })
    chapter(root, 'chapters/vol-02-出海/0001-首.md', { title: '出海一', volume: 'vol-02', seq: 1 })
    chapter(root, 'chapters/0001-散.md', { title: '散章一', seq: 1 })
    chapter(root, 'chapters/0002-散.md', { title: '散章二', seq: 2 })

    const first = rebuildCatalog(root)
    assert.equal(first.ok, true)
    const firstBytes = new Map(
      first.written.map((relative) => [relative, readFileSync(join(root, ...relative.split('/')), 'utf8')]),
    )

    const second = rebuildCatalog(root)
    assert.equal(second.ok, true)
    assert.deepEqual(second.volumes, first.volumes)
    assert.deepEqual(second.looseChapters, first.looseChapters)
    assert.deepEqual(second.written, first.written)
    for (const [relative, text] of firstBytes) {
      assert.equal(readFileSync(join(root, ...relative.split('/')), 'utf8'), text, `${relative} changed on a no-op rebuild`)
    }
    assert.deepEqual(readCatalog(root).staleFiles, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog: volumeId comes from the directory name, title from its slug', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    chapter(root, 'chapters/vol-12-外海/0001-启航.md', { title: '启航', seq: 1 })
    chapter(root, 'chapters/vol-99/0001-末卷.md', { title: '末卷', seq: 1 })
    chapter(root, 'chapters/notes/备忘.md', { title: '备忘' })

    const result = readCatalog(root)
    assert.deepEqual(result.catalog.volumes, [
      // volumeId is the stable `vol-NN` id; the slug is display only and may change.
      { volumeId: 'vol-12', dir: 'vol-12-外海', title: '外海', order: 12 },
      { volumeId: 'vol-99', dir: 'vol-99', title: 'vol-99', order: 99 },
    ])
    // A non-`vol-*` directory is not a volume: its chapters stay visible as
    // loose chapters instead of silently disappearing from the catalog.
    assert.deepEqual(
      result.catalog.looseChapters.map((item) => item.file),
      ['chapters/notes/备忘.md'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog: a deleted chapter is reported stale and disappears on the next rebuild', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    chapter(root, 'chapters/vol-01-入山/0001-入山.md', { title: '第一章', volume: 'vol-01', seq: 1 })
    chapter(root, 'chapters/vol-01-入山/0002-夜行.md', { title: '第二章', volume: 'vol-01', seq: 2 })
    assert.equal(rebuildCatalog(root).ok, true)

    // Deleting a chapter is a file operation; the catalog is now behind.
    rmSync(join(root, 'chapters/vol-01-入山/0002-夜行.md'))

    const behind = readCatalog(root)
    assert.equal(behind.catalogStale, true)
    assert.deepEqual(behind.volumeCatalogs[0].chapters.map((item) => item.seq), [1], 'the projection follows .md')
    assert.ok(codes(validateCatalog(root).issues).includes('CATALOG_STALE'))

    assert.equal(rebuildCatalog(root).ok, true)
    const repaired = readJson(join(root, volumeCatalogPath('vol-01-入山')))
    assert.deepEqual(repaired.chapters.map((item) => item.seq), [1])
    assert.equal(readCatalog(root).catalogStale, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. Validation: four issue codes, none of them blocking
// ---------------------------------------------------------------------------

test('catalog: CATALOG_STALE — a hand-edited catalog is reported and never rewritten by a read', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    chapter(root, 'chapters/vol-01-入山/0001-入山.md', { title: '第一章', volume: 'vol-01', seq: 1 })
    assert.equal(rebuildCatalog(root).ok, true)

    // The author (or a merge) emptied the catalog; the .md files did not change.
    const tampered = { schemaVersion: 1, volumes: [], looseChapters: [] }
    writeJson(join(root, ROOT_CATALOG), tampered)
    const before = snapshot(root)

    const stale = readCatalog(root)
    assert.equal(stale.catalogStale, true)
    assert.deepEqual(stale.catalog.volumes.map((volume) => volume.volumeId), ['vol-01'], '.md is the truth')
    assert.deepEqual(snapshot(root), before, 'readCatalog must not repair the file on disk')

    const validation = validateCatalog(root)
    assert.equal(validation.catalogStale, true)
    assert.ok(codes(validation.issues).includes('CATALOG_STALE'))
    const staleIssue = validation.issues.find((issue) => issue.code === 'CATALOG_STALE')
    assert.equal(staleIssue.path, ROOT_CATALOG)

    // Rebuild is the repair: the hand edit is overwritten by the .md projection.
    assert.equal(rebuildCatalog(root).ok, true)
    assert.deepEqual(readJson(join(root, ROOT_CATALOG)), stale.catalog)
    assert.equal(readCatalog(root).catalogStale, false)

    // A missing per-volume catalog is stale as well.
    rmSync(join(root, volumeCatalogPath('vol-01-入山')))
    assert.ok(codes(validateCatalog(root).issues).includes('CATALOG_STALE'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog: CATALOG_DUPLICATE — a repeated seq inside a volume and among loose chapters', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    chapter(root, 'chapters/vol-01-入山/0001-a.md', { title: 'A', volume: 'vol-01', seq: 1 })
    chapter(root, 'chapters/vol-01-入山/0002-b.md', { title: 'B', volume: 'vol-01', seq: 1 })
    chapter(root, 'chapters/0010-x.md', { title: 'X', seq: 10 })
    chapter(root, 'chapters/0011-y.md', { title: 'Y', seq: 10 })

    // The projection still lists both files (nothing is dropped from the truth),
    // and validation reports the collision for the author to fix.
    const rebuilt = rebuildCatalog(root)
    assert.equal(rebuilt.ok, true)
    const validation = validateCatalog(root)
    const duplicates = validation.issues.filter((issue) => issue.code === 'CATALOG_DUPLICATE')
    assert.equal(duplicates.length, 2, 'one volume-seq collision and one loose-seq collision')
    assert.ok(duplicates.some((issue) => issue.detail.includes('vol-01') && issue.detail.includes('1')))
    assert.ok(duplicates.some((issue) => issue.detail.includes('loose')))
    assert.equal(validation.catalogStale, false, 'duplicates are a content problem, not a drift problem')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog: VOLUME_DIR_MISMATCH — a volume directory that does not start with its volumeId', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    // `vol-7` normalises to the stable id `vol-07`, so the folder name no longer
    // starts with the id: the author has to rename the folder to `vol-07-*`.
    chapter(root, 'chapters/vol-7-散章/0001-a.md', { title: 'A', seq: 1 })
    assert.equal(rebuildCatalog(root).ok, true)

    const validation = validateCatalog(root)
    assert.equal(validation.catalogStale, false)
    const mismatch = validation.issues.filter((issue) => issue.code === 'VOLUME_DIR_MISMATCH')
    assert.equal(mismatch.length, 1)
    assert.equal(mismatch[0].path, volumeCatalogPath('vol-7-散章'))
    assert.match(mismatch[0].detail, /vol-07/)

    // A hand-edited catalog gets the same check against its own `dir` field.
    writeJson(join(root, ROOT_CATALOG), {
      schemaVersion: 1,
      volumes: [{ volumeId: 'vol-01', dir: 'vol-7-散章', title: '散章', order: 7 }],
      looseChapters: [],
    })
    assert.ok(codes(validateCatalog(root).issues).includes('VOLUME_DIR_MISMATCH'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog: CHAPTER_FILE_MISSING — a listed chapter file that no longer exists', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    chapter(root, 'chapters/vol-01-入山/0001-入山.md', { title: '第一章', volume: 'vol-01', seq: 1 })
    assert.equal(rebuildCatalog(root).ok, true)

    const path = join(root, volumeCatalogPath('vol-01-入山'))
    const catalog = readJson(path)
    catalog.chapters.push({
      chapterId: 'ghost',
      file: 'chapters/vol-01-入山/9999-ghost.md',
      seq: 99,
      title: '已删除的章',
    })
    writeJson(path, catalog)

    const validation = validateCatalog(root)
    const missing = validation.issues.filter((issue) => issue.code === 'CHAPTER_FILE_MISSING')
    assert.equal(missing.length, 1)
    assert.equal(missing[0].path, volumeCatalogPath('vol-01-入山'))
    assert.match(missing[0].detail, /9999-ghost\.md/)

    // The same check applies to loose chapters listed in the root catalog.
    const rootPath = join(root, ROOT_CATALOG)
    const rootCatalog = readJson(rootPath)
    rootCatalog.looseChapters.push({ chapterId: 'ghost', file: 'chapters/0000-ghost.md', seq: 0, title: '幽灵' })
    writeJson(rootPath, rootCatalog)
    assert.equal(
      validateCatalog(root).issues.filter((issue) => issue.code === 'CHAPTER_FILE_MISSING').length,
      2,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog: validate never throws and does not block a project without chapters/', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    rmSync(join(root, CHAPTERS), { recursive: true, force: true })

    const result = validateCatalog(root)
    assert.ok(result.issues.length > 0)
    assert.ok(codes(result.issues).includes('CATALOG_STALE'))
    assert.equal(existsSync(join(root, ROOT_CATALOG)), false)
    // The read path tolerates the same state: an empty projection, flagged stale.
    const read = readCatalog(root)
    assert.equal(read.catalogStale, true)
    assert.deepEqual(read.catalog.volumes, [])
    assert.deepEqual(read.catalog.looseChapters, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. Failure behaviour: atomic writes, the write lock, the gate boundary
// ---------------------------------------------------------------------------

test('catalog: a failed write leaves the previous catalog bytes untouched', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    chapter(root, 'chapters/vol-01-入山/0001-入山.md', { title: '第一章', volume: 'vol-01', seq: 1 })
    chapter(root, 'chapters/vol-01-入山/0002-二.md', { title: '第二章', volume: 'vol-01', seq: 2 })
    assert.equal(rebuildCatalog(root).ok, true)

    const rootCatalogBefore = readFileSync(join(root, ROOT_CATALOG), 'utf8')
    const volumeRelative = volumeCatalogPath('vol-01-入山')
    // Make the first write of the rebuild impossible (a directory cannot be
    // replaced by rename). The volume list is written before the root list, so
    // the root catalog must still be exactly what it was.
    rmSync(join(root, ...volumeRelative.split('/')))
    mkdirSync(join(root, ...volumeRelative.split('/')))

    const failed = rebuildCatalog(root)
    assert.equal(failed.ok, false)
    assert.equal(failed.error.code, 'IO_FAILED')
    assert.equal(failed.error.path, volumeRelative)
    assert.deepEqual(failed.written, [])
    assert.equal(readFileSync(join(root, ROOT_CATALOG), 'utf8'), rootCatalogBefore)
    assert.equal(statSync(join(root, ...volumeRelative.split('/'))).isDirectory(), true)
    // The read path now reports drift instead of pretending the catalog is fresh.
    assert.equal(readCatalog(root).catalogStale, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog: rebuild refuses while another session holds the project write lock', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    chapter(root, 'chapters/vol-01-入山/0001-入山.md', { title: '第一章', volume: 'vol-01', seq: 1 })
    // A live pid (the test runner's parent) makes the lock non-stale.
    writeFileSync(
      join(root, 'index', '.write.lock'),
      JSON.stringify({ pid: process.ppid, token: 'other-session', startedAt: Date.now() }),
      'utf8',
    )

    const result = rebuildCatalog(root)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'PROJECT_BUSY')
    assert.deepEqual(result.written, [])
    assert.equal(existsSync(join(root, ROOT_CATALOG)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog: rebuild refuses a directory that is not a chapter tree', () => {
  const dir = workdir()
  try {
    const root = join(dir, 'empty')
    mkdirSync(root, { recursive: true })
    const result = rebuildCatalog(root)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'PROJECT_NOT_FOUND')
    assert.deepEqual(result.written, [])
    assert.equal(existsSync(join(root, 'chapters')), false, 'no directory is scaffolded as a side effect')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('catalog: the catalog is not a gate requirement and the index build never writes it', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    chapter(root, 'chapters/vol-01-入山/0001-入山.md', { title: '第一章', volume: 'vol-01', seq: 1 })
    assert.equal(rebuildCatalog(root).ok, true)
    assert.equal(inspectProject(root).state, 'usable')

    // Deleting the projection must not make a healthy book unreadable.
    rmSync(join(root, ROOT_CATALOG))
    rmSync(join(root, volumeCatalogPath('vol-01-入山')))
    const probe = inspectProject(root)
    assert.equal(probe.state, 'usable')
    assert.equal(probe.usable, true)

    // The derived SQLite index and the catalog are independent: a rebuild of
    // the index is a read of the .md files and must not create catalog files.
    const built = await buildIndex(root)
    assert.ok(built.counts.chapters >= 1)
    assert.equal(existsSync(join(root, ROOT_CATALOG)), false, 'index rebuild must not write the catalog')
    assert.equal(readCatalog(root).catalogStale, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
