/**
 * Three-level outline, fourth level refused (I-02).
 *
 * The reviewer found this by hand: `chapter` under `chapter` was accepted by both the
 * write planner and the rebuild, while the code comment and the tool description both
 * promised refusal. These cases pin the fix from both sides, so either half regressing
 * fails a test.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildIndex, planOutlineUpsert } from '../lib/index.js'

const DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']

function scaffold() {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-outline-nest-'))
  const root = join(dir, 'book')
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const name of DIRS) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '大纲层级' }, null, 2)}\n`, 'utf8')
  return { dir, root }
}

function write(root, relativePath, frontmatter, body = '- 情节点') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, `---\n${frontmatter.join('\n')}\n---\n\n${body}\n`, 'utf8')
}

/** The three levels the tree may contain, as the planner sees them. */
const NODES = [
  { id: 'o-1', kind: 'overall', title: '总纲', path: 'outlines/overall.md' },
  { id: 'v-1', kind: 'volume', title: '卷一', parent: 'o-1', path: 'outlines/vol-01.md' },
  { id: 'c-1', kind: 'chapter', title: '第一章', parent: 'v-1', path: 'outlines/ch-01.md' },
]

test('the write planner refuses a chapter under a chapter', () => {
  const plan = planOutlineUpsert({
    nodes: NODES,
    node: { id: 'c-2', kind: 'chapter', title: '第二章', parent: 'c-1', path: 'outlines/ch-02.md' },
  })

  assert.equal(plan.ok, false)
  assert.equal(plan.code, 'OUTLINE_CHAPTER_IN_CHAPTER')
})

test('a chapter under a volume and under the overall outline stays legal', () => {
  const underVolume = planOutlineUpsert({
    nodes: NODES,
    node: { id: 'c-2', kind: 'chapter', title: '第二章', parent: 'v-1', path: 'outlines/ch-02.md' },
  })
  assert.equal(underVolume.ok, true, 'chapter under volume is the documented shape')

  const underOverall = planOutlineUpsert({
    nodes: NODES,
    node: { id: 'c-3', kind: 'chapter', title: '第三章', parent: 'o-1', path: 'outlines/ch-03.md' },
  })
  assert.equal(underOverall.ok, true, 'chapter directly under the overall outline is also documented')
})

test('a rebuild reports a chapter under a chapter as OUTLINE_CHAPTER_IN_CHAPTER', async () => {
  const { dir, root } = scaffold()
  try {
    write(root, 'outlines/overall.md', ['id: o-1', 'kind: overall', 'title: 总纲'])
    write(root, 'outlines/vol-01.md', ['id: v-1', 'kind: volume', 'title: 卷一', 'parent: o-1'])
    write(root, 'outlines/ch-01.md', ['id: c-1', 'kind: chapter', 'title: 第一章', 'parent: v-1'])
    // Written by hand or merged in: the rebuild has to notice even though the write
    // path would have refused it.
    write(root, 'outlines/ch-02.md', ['id: c-2', 'kind: chapter', 'title: 第二章', 'parent: c-1'])

    const build = await buildIndex(root)
    const codes = build.issues.map((issue) => issue.code)
    assert.ok(codes.includes('OUTLINE_CHAPTER_IN_CHAPTER'), `expected the fourth-level code, got ${codes.join(',')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
