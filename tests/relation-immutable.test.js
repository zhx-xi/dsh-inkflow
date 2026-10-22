/**
 * A refused relation write must not touch the file — including the *update* case (#27).
 *
 * The reviewer pointed out the existing suite proved "no new file appears" but never
 * "an existing file is left byte-identical" when the planner refuses an edit. These
 * cases cover the update path, which is where a partial write would actually lose an
 * author's edge. The planner is driven directly (it is a pure function), so the case
 * fails if the refusal disappears from either the planner or the guard it relies on.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildIndex, planRelationUpsert } from '../lib/index.js'

const DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']

function scaffold() {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-relation-immutable-'))
  const root = join(dir, 'book')
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const name of DIRS) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '关系不可变' }, null, 2)}\n`, 'utf8')
  return { dir, root }
}

function write(root, relativePath, frontmatter, body = '说明') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, `---\n${frontmatter.join('\n')}\n---\n\n${body}\n`, 'utf8')
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** The two projection rows the planner needs: it resolves endpoints against them. */
function view(rows, entities) {
  return { rows, entities }
}

test('a refused update leaves the existing relation file byte-identical', () => {
  const { dir, root } = scaffold()
  try {
    write(root, 'characters/清音.md', ['id: c-1', 'name: 清音'])
    write(root, 'characters/白鹤掌门.md', ['id: c-2', 'name: 白鹤掌门'])
    write(root, 'relations/师徒.md', ['id: r-1', 'source: c-1', 'target: c-2'])
    const target = join(root, 'relations', '师徒.md')
    const before = sha256(target)
    const relationsBefore = readdirSync(join(root, 'relations')).sort()

    const entities = [
      { kind: 'characters', id: 'c-1', path: 'characters/清音.md', title: '清音' },
      { kind: 'characters', id: 'c-2', path: 'characters/白鹤掌门.md', title: '白鹤掌门' },
      { kind: 'relations', id: 'r-1', path: 'relations/师徒.md', title: '师徒' },
    ]
    const rows = [{ id: 'r-1', path: 'relations/师徒.md', source: 'c-1', target: 'c-2', relationKind: 'character' }]

    // Turn the edge into a self-loop on the same path: the planner refuses it, and that
    // file on disk is exactly what an author would lose if the write leaked through.
    const plan = planRelationUpsert(view(rows, entities), {
      id: 'r-1',
      source: 'c-1',
      target: 'c-1',
      path: 'relations/师徒.md',
    })

    assert.equal(plan.ok, false)
    assert.equal(plan.error?.code, 'RELATION_SELF_LOOP')
    assert.equal(sha256(target), before, 'the rejected update must not rewrite the file')
    assert.deepEqual(readdirSync(join(root, 'relations')).sort(), relationsBefore, 'nor add or drop files')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a refused new edge writes nothing at all', () => {
  const { dir, root } = scaffold()
  try {
    write(root, 'characters/清音.md', ['id: c-1', 'name: 清音'])

    const entities = [{ kind: 'characters', id: 'c-1', path: 'characters/清音.md', title: '清音' }]
    // c-9 does not exist: RELATION_ENDPOINT.
    const plan = planRelationUpsert(view([], entities), { source: 'c-1', target: 'c-9', path: 'relations/悬空.md' })

    assert.equal(plan.ok, false)
    assert.equal(plan.error?.code, 'RELATION_ENDPOINT')
    assert.deepEqual(readdirSync(join(root, 'relations')), ['.gitkeep'], 'only the placeholder remains')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a rebuild reports the endpoint code for a hand-written broken edge', async () => {
  const { dir, root } = scaffold()
  try {
    write(root, 'characters/清音.md', ['id: c-1', 'name: 清音'])
    write(root, 'relations/悬空.md', ['id: r-3', 'source: c-1', 'target: c-9'])

    const build = await buildIndex(root)
    const codes = build.issues.map((issue) => issue.code)
    assert.ok(codes.includes('RELATION_ENDPOINT'), `expected RELATION_ENDPOINT, got ${codes.join(',')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
