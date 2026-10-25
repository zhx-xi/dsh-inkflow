/**
 * Rebuild-side I-08: the index must *report* the world-tree violations, not just
 * refuse them on the write path.
 *
 * Why this file exists separately: `tests/world.test.js` covers the write-side planner
 * and the happy paths. When the reviewer disabled the rebuild-side call
 * (`world.ts` `validate()`), every one of those tests stayed green — the contract
 * "each invariant has a failing case" was not met for the rebuild side. These two cases
 * fail the moment `validate()` stops delegating to `worldIssues()`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildIndex } from '../lib/index.js'

const DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']

function scaffold() {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-world-inv-'))
  const root = join(dir, 'book')
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const name of DIRS) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '世界树不变量' }, null, 2)}\n`, 'utf8')
  return { dir, root }
}

function write(root, relativePath, frontmatter) {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, `---\n${frontmatter.join('\n')}\n---\n\n正文\n`, 'utf8')
}

test('a rebuild reports two first-level world entries as WORLD_ROOT_MULTIPLE', async () => {
  const { dir, root } = scaffold()
  try {
    // Both sit directly under world/ with no parent: two roots.
    write(root, 'world/总览.md', ['id: w-a', 'title: 总览'])
    write(root, 'world/门派.md', ['id: w-b', 'title: 门派'])
    const build = await buildIndex(root)
    const codes = build.issues.map((issue) => issue.code)
    assert.ok(codes.includes('WORLD_ROOT_MULTIPLE'), `expected WORLD_ROOT_MULTIPLE, got ${codes.join(',')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a rebuild reports a child without a category as WORLD_CATEGORY_REQUIRED', async () => {
  const { dir, root } = scaffold()
  try {
    write(root, 'world/总览.md', ['id: w-root', 'title: 总览'])
    // A parent, but neither the field nor a `world/<category>/` directory supplies one.
    write(root, 'world/弟子.md', ['id: w-child', 'title: 弟子', 'parent: w-root'])
    const build = await buildIndex(root)
    const codes = build.issues.map((issue) => issue.code)
    assert.ok(codes.includes('WORLD_CATEGORY_REQUIRED'), `expected WORLD_CATEGORY_REQUIRED, got ${codes.join(',')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a flat category book is still legal on a rebuild', async () => {
  const { dir, root } = scaffold()
  try {
    // Every entry under world/<category>/ nobody declares a parent: valid.
    write(root, 'world/门派/白鹤门.md', ['id: w-1', 'title: 白鹤门'])
    write(root, 'world/门派/静水观.md', ['id: w-2', 'title: 静水观'])
    const build = await buildIndex(root)
    const worldCodes = build.issues.map((issue) => issue.code).filter((code) => code.startsWith('WORLD_'))
    assert.deepEqual(worldCodes, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
