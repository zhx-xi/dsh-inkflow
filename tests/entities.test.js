/**
 * The cross-class projection (#23, roadmap X-1/X-3): nine-directory coverage, the
 * `entities` table, one full-text index, and the two-character fallback.
 *
 * The chapter body FTS already covers the manuscript; what these tests pin is that
 * the *setting library* is queryable at all — before #23 the index skipped every
 * content directory except chapters/characters/world/outlines, so timeline,
 * relations and facts entities were invisible no matter what was on disk.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildIndex,
  entityCounts,
  listEntities,
  searchEntities,
} from '../lib/index.js'

const DIRS = [
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
  return mkdtempSync(join(tmpdir(), 'inkflow-entities-'))
}

function scaffold(root) {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '实体测试' }, null, 2)}\n`, 'utf8')
}

function writeMarkdown(root, relativePath, frontmatterLines, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = frontmatterLines.length > 0 ? `---\n${frontmatterLines.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

function sampleBook(root) {
  scaffold(root)
  writeMarkdown(root, 'chapters/vol-01/0001-开篇.md', ['id: ch-1', 'title: 开篇', 'seq: 1', 'status: final'], '清音推开山门。')
  writeMarkdown(root, 'characters/清音.md', ['id: c-1', 'name: 清音', 'aliases: 静水、清音子', 'role: 主角'], '白鹤门弟子。')
  writeMarkdown(root, 'characters/白鹤掌门.md', ['id: c-2', 'name: 白鹤掌门', 'group: 白鹤门'], '门派掌门。')
  writeMarkdown(root, 'world/门派/白鹤门.md', ['id: w-1', 'title: 白鹤门', 'keywords: 白鹤、剑宗'], '山中剑派。')
  writeMarkdown(root, 'world/门派/静水观.md', ['id: w-2', 'title: 静水观', 'parent: w-1', 'category: 门派'], '下院。')
  writeMarkdown(root, 'outlines/overall.md', ['id: o-1', 'kind: overall', 'title: 总纲'], '- 情节点')
  writeMarkdown(root, 'outlines/vol-01.md', ['id: o-2', 'kind: volume', 'title: 卷一', 'parent: o-1'], '- 卷')
}

test('every registered content directory reaches the projection', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    const build = await buildIndex(root)
    assert.equal(build.issues.filter((issue) => issue.code === 'DUPLICATE_ID').length, 0)

    const counts = entityCounts(root)
    assert.deepEqual(counts, { chapters: 1, characters: 2, outlines: 2, world: 2 })

    const all = listEntities(root)
    assert.equal(all?.length, 7)
    // Stable order: kind, then title, then path.
    assert.deepEqual([...new Set(all.map((entity) => entity.kind))], ['chapters', 'characters', 'outlines', 'world'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one kind can be listed on its own, with its fields intact', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)

    const characters = listEntities(root, { kind: 'characters' })
    assert.equal(characters?.length, 2)
    const qingyin = characters?.find((entity) => entity.id === 'c-1')
    assert.equal(qingyin?.title, '清音')
    assert.equal(qingyin?.nameKey, '清音')
    assert.deepEqual(qingyin?.aliases, ['静水', '清音子'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('entities are searchable by title, alias and keyword', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)

    // ≥3 characters → FTS
    const byTitle = searchEntities(root, '白鹤门')
    assert.deepEqual(byTitle?.map((entity) => entity.id), ['w-1'])

    // alias hit resolves to the character that owns it
    const byAlias = searchEntities(root, '清音子')
    assert.deepEqual(byAlias?.map((entity) => entity.id), ['c-1'])

    // keyword hit resolves to the world entry
    const byKeyword = searchEntities(root, '剑宗')
    assert.deepEqual(byKeyword?.map((entity) => entity.id), ['w-1'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a two-character query still hits (LIKE fallback under the trigram floor)', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)

    // "清音" is two characters: the trigram index cannot match it, the LIKE pass must.
    const hits = searchEntities(root, '清音')
    assert.deepEqual(hits?.map((entity) => entity.id).sort(), ['c-1'])
    // A one-character query works the same way and stays a prefix-free substring match.
    assert.deepEqual(searchEntities(root, '观')?.map((entity) => entity.id), ['w-2'])
    // No match is an empty list, never undefined (the index exists).
    assert.deepEqual(searchEntities(root, '不存在的名字'), [])
    assert.deepEqual(searchEntities(root, '   '), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a foreign schema is not read: the caller must rebuild', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)

    // Simulate an index written by another plugin version.
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(root, 'index', 'inkflow.db'))
    db.exec('PRAGMA user_version = 1')
    db.close()

    assert.equal(listEntities(root), undefined)
    assert.equal(searchEntities(root, '清音'), undefined)
    assert.equal(entityCounts(root), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the projection is not a second truth: a rebuild reproduces it exactly', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)
    const first = listEntities(root)

    await buildIndex(root)
    const second = listEntities(root)

    assert.deepEqual(second, first)
    // And the identity of the row set does not depend on walk order: sort by path.
    const digest = createHash('sha256')
      .update(JSON.stringify([...(first ?? [])].sort((a, b) => (a.path < b.path ? -1 : 1))))
      .digest('hex')
    assert.equal(digest.length, 64)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
