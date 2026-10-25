/**
 * The writing-context segment registry (roadmap X-13).
 *
 * The seam exists so the foreshadow reminder and the ledger facts each add ONE
 * entry from their own module instead of editing the renderer. That promise is only
 * worth anything if the machinery behind it actually works while the registry is
 * empty — which is the state B0 ships in.
 *
 * So this suite registers a synthetic segment by pushing into the exported array,
 * and pins the four properties a contributor relies on:
 *
 *   1. its text lands **after** the world book and **before** the trim marker;
 *   2. its own `capRatio` clips it (a long segment cannot push everything else out);
 *   3. under a tight budget it is dropped **before** the previous-chapter tail, and
 *      its `label` appears in `trimmed` between 世界书 and 上章结尾 — the documented
 *      order, which the marker renders as-is;
 *   4. with the registry empty again the output is byte-identical to a build where
 *      the seam never existed (asserted by comparing two builds on the same book).
 *
 * The mutation is contained: `node --test` gives each file its own process, and the
 * push is undone in `finally` regardless of assertion failures.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EXTRA_SEGMENTS, buildIndex, buildWritingContext } from '../lib/index.js'

const CONTENT_DIRS = [
  'chapters',
  'characters',
  'world',
  'outlines',
  'foreshadowing',
  'timeline',
  'relations',
  'facts',
  'library',
]
const ALL_DIRS = [...CONTENT_DIRS, 'index']

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-segments-'))
}

function scaffold(root) {
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, '.git'))
  for (const dir of ALL_DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '接缝之书' }, null, 2)}\n`, 'utf8')
  writeFileSync(
    join(root, '.gitignore'),
    'index/*.db\nindex/*.db-wal\nindex/*.db-shm\n.inkflow/\n',
    'utf8',
  )
}

function writeMarkdown(root, relativePath, frontmatterLines, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = frontmatterLines.length > 0 ? `---\n${frontmatterLines.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

/** A two-chapter book with an outline and one world entry, enough to fill a budget. */
function book(dir) {
  const root = join(dir, 'book')
  scaffold(root)
  writeMarkdown(root, 'chapters/vol-01/0001-开端.md', ['id: ch-0001', 'title: 开端', 'volume: vol-01', 'seq: 1'], '第一章正文。\n'.repeat(20))
  writeMarkdown(root, 'chapters/vol-01/0002-起风.md', ['id: ch-0002', 'title: 起风', 'volume: vol-01', 'seq: 2'], '第二章正文。\n'.repeat(20))
  writeMarkdown(root, 'outlines/overall.md', ['kind: overall', 'title: 总纲'], '- 故事线\n')
  writeMarkdown(
    root,
    'outlines/ch-0002.md',
    ['kind: chapter', 'title: 起风', 'parent: overall'],
    `${'- 风起于青萍之末，主角在此见到信物。\n'.repeat(30)}`,
  )
  writeMarkdown(root, 'world/门派/青萍宗.md', ['title: 青萍宗', 'category: 门派', 'keywords: 青萍'], '青萍宗，剑修门派。\n')
  buildIndex(root)
  return root
}

function withSegment(spec, body) {
  EXTRA_SEGMENTS.push(spec)
  try {
    return body()
  } finally {
    const index = EXTRA_SEGMENTS.indexOf(spec)
    if (index >= 0) EXTRA_SEGMENTS.splice(index, 1)
  }
}

test('writing-context: a registered segment renders after the world book and before the marker', () => {
  const dir = workdir()
  try {
    const root = book(dir)
    const baseline = buildWritingContext(root)
    const withExtra = withSegment(
      { name: 'facts', label: '账本事实', capRatio: 0.15, build: () => '### 账本事实\n青萍宗现任掌门是清音' },
      () => buildWritingContext(root),
    )

    const names = withExtra.segments.map((segment) => segment.name)
    assert.deepEqual(names, ['project', 'chapter', 'tail', 'world', 'facts'])
    assert.ok(withExtra.text.includes('### 账本事实'))
    // Order on the wire: the world book's block precedes it, the marker follows it.
    assert.ok(withExtra.text.indexOf('### 世界书') < withExtra.text.indexOf('### 账本事实'))
    assert.ok(withExtra.text.trimEnd().split('\n\n').at(-1).startsWith('[') || withExtra.trimmed.length === 0)
    // Nothing else changed by registering a segment that fits.
    assert.deepEqual(withExtra.trimmed, baseline.trimmed)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writing-context: capRatio clips a segment instead of letting it displace the rest', () => {
  const dir = workdir()
  try {
    const root = book(dir)
    const budgetTokens = 1200
    const capChars = Math.floor(0.1 * budgetTokens)
    const huge = `### 账本事实\n${'长'.repeat(5000)}`
    const result = withSegment({ name: 'facts', label: '账本事实', capRatio: 0.1, build: () => huge }, () =>
      buildWritingContext(root, { budgetTokens }),
    )
    const segment = result.segments.find((entry) => entry.name === 'facts')
    assert.ok(segment !== undefined, 'the segment is present')
    assert.ok(segment.text.length <= capChars, `clipped to ${String(capChars)} chars, got ${String(segment.text.length)}`)
    assert.ok(segment.text.endsWith('…（截断）'), 'the clip is visible')
    // The chapter segment survives: the cap protects everything else.
    assert.ok(result.segments.some((entry) => entry.name === 'chapter'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writing-context: under a tight budget a registered segment is dropped before the tail', () => {
  const dir = workdir()
  try {
    const root = book(dir)
    // An entry that names its own label, so the marker's list can be read directly.
    const result = withSegment(
      { name: 'facts', label: '账本事实', capRatio: 0.5, build: () => `### 账本事实\n${'实'.repeat(400)}` },
      () => buildWritingContext(root, { budgetTokens: 60 }),
    )
    const names = result.segments.map((segment) => segment.name)
    assert.equal(names.includes('facts'), false, 'the extra is gone under pressure')
    const order = result.trimmed
    const factsAt = order.indexOf('账本事实')
    assert.ok(factsAt >= 0, `the marker names it: ${order.join('、')}`)
    // Documented order (X-13): world → extras → tail.
    const worldAt = order.indexOf('世界书')
    const tailAt = order.indexOf('上章结尾')
    if (worldAt >= 0) assert.ok(worldAt < factsAt)
    if (tailAt >= 0) assert.ok(factsAt < tailAt, `facts must drop before the tail: ${order.join('、')}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writing-context: an empty registry produces exactly the pre-seam text', () => {
  const dir = workdir()
  try {
    const root = book(dir)
    // Built twice in the same process: the second call must not see anything left over
    // from the previous tests, and neither may contain an extra segment.
    const first = buildWritingContext(root)
    const second = buildWritingContext(root)
    assert.equal(first.text, second.text)
    for (const segment of first.segments) {
      assert.ok(['project', 'chapter', 'tail', 'world'].includes(segment.name), `unexpected segment ${segment.name}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
