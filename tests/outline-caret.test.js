/**
 * The 大纲 page after the caret policy change: ONE fold control (the volume), the rest of the
 * tree always visible, and the plot-point count arriving with the tree instead of costing a
 * request per node.
 *
 * Three kinds of assertion, matching the three things that can break:
 *
 *   1. `visibleOutlineRows` — which rows are drawn. Pure, so it is asserted directly, and the
 *      fourth level (a chapter under a chapter) has its own case: it must NOT be drawn.
 *   2. `readOutlineNodes` — the two cells the Host now sends (`tier`, `plotPointCount`) are
 *      read off the ROW, so a page with no detail requests can still show a tier badge and a
 *      count.
 *   3. The Host payload itself — `buildLibrary` over a real temporary book, which proves the
 *      index columns actually reach the wire (a view model reading a field nobody sends would
 *      pass 1 and 2 and fail here).
 *
 * Plus a source scan: the page must not go back to drawing plot points inline.
 *
 * Run: pnpm test (the Host half needs `pnpm run build` for the other suites, not for this one).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CLIENT = join(ROOT, 'src', 'client')
const require = createRequire(import.meta.url)

async function bundle(entry, platform = 'neutral') {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform,
    target: 'node22',
    write: false,
    logLevel: 'silent',
  })
  const code = Buffer.from(result.outputFiles[0].text, 'utf8').toString('base64')
  return import(`data:text/javascript;base64,${code}`)
}

const loadModel = () => bundle(join(CLIENT, 'outline-model.ts'))

/** One `OutlineRow` as `flattenOutlineTree` would emit it. */
function row(id, tier, depth, parent = null, plotPointCount = null) {
  return {
    node: { id, path: `outlines/${id}.md`, title: id, tier, parent, order: null, plotPointCount },
    depth,
    group: 'overall',
  }
}

/**
 * overall → 卷甲 → 章1, chapter 1 also carries a child (`deep`, the fourth level the model
 * does not allow) → 卷乙 → 章2.
 */
const ROWS = [
  row('all', 'overall', 0),
  row('v1', 'volume', 1, 'all'),
  row('c1', 'chapter', 2, 'v1'),
  row('deep', 'chapter', 3, 'c1'),
  row('v2', 'volume', 1, 'all'),
  row('c2', 'chapter', 2, 'v2'),
]

test('a volume is closed by default: the tree opens as overall + volumes', async () => {
  const model = await loadModel()
  const shown = model.visibleOutlineRows(ROWS, []).map((entry) => entry.node.id)
  assert.deepEqual(shown, ['all', 'v1', 'v2'], 'chapters wait for their volume to be opened')
})

test('opening one volume shows its chapters and leaves the other closed', async () => {
  const model = await loadModel()
  const shown = model.visibleOutlineRows(ROWS, ['v1']).map((entry) => entry.node.id)
  assert.deepEqual(shown, ['all', 'v1', 'c1', 'v2'], 'c2 is still hidden: its volume is closed')
})

test('the fourth level is never drawn, open or closed', async () => {
  const model = await loadModel()
  for (const expanded of [[], ['v1'], ['v1', 'c1'], ['c1', 'deep']]) {
    const shown = model.visibleOutlineRows(ROWS, expanded).map((entry) => entry.node.id)
    assert.equal(shown.includes('deep'), false, `a chapter under a chapter must not render (expanded: ${expanded.join(',')})`)
  }
})

test('opening a node that cannot fold changes nothing', async () => {
  const model = await loadModel()
  const shown = model.visibleOutlineRows(ROWS, ['c1']).map((entry) => entry.node.id)
  assert.deepEqual(shown, ['all', 'v1', 'v2'], 'a chapter id in the expanded set is not a 4th level request')
})

test('a jump into a collapsed volume opens the volume above it', async () => {
  const model = await loadModel()
  assert.deepEqual(model.revealFor(ROWS, 'c2'), ['v2'], 'the volume has to open or the jump lands on nothing')
  assert.deepEqual(model.revealFor(ROWS, 'all'), [], 'the overall node is always visible')
  assert.deepEqual(model.revealFor(ROWS, 'nope'), [], 'an unknown id reveals nothing rather than throwing')
})

test('children the page cannot draw are counted, so the detail pane can say so', async () => {
  const model = await loadModel()
  assert.equal(model.hiddenChildCount(ROWS, 'c1'), 1, 'the fourth level is hidden, not swallowed')
  assert.equal(model.hiddenChildCount(ROWS, 'v1'), 1, 'a volume counts its chapters whatever the fold state')
  assert.equal(model.hiddenChildCount(ROWS, 'all'), 2)
})

test('the tier badge and the plot-point count come off the row, not off a detail read', async () => {
  const model = await loadModel()
  const payload = {
    indexAvailable: true,
    kinds: [
      {
        kind: 'outlines',
        total: 2,
        truncated: false,
        items: [
          { id: 'main', path: 'outlines/main.md', title: '整体', tier: 'overall', plotPointCount: 7 },
          // A node that declares nothing and is named nothing: the wire is the only source.
          { id: 'x', path: 'outlines/x.md', title: '散章', tier: 'chapter', plotPointCount: 0 },
        ],
      },
    ],
  }
  const read = model.readOutlineNodes(payload)
  assert.deepEqual(
    read.nodes.map((node) => [node.id, node.tier, node.plotPointCount]),
    [
      ['main', 'overall', 7],
      ['x', 'chapter', 0],
    ],
  )

  // The other direction: no cells on the wire (an older Host) → unknown, never a fake zero.
  const bare = model.readOutlineNodes({
    indexAvailable: true,
    kinds: [{ kind: 'outlines', total: 1, truncated: false, items: [{ id: 'vol-01', path: 'outlines/vol-01.md', title: '卷一' }] }],
  })
  assert.equal(bare.nodes[0].tier, 'volume', 'the file name still classifies it')
  assert.equal(bare.nodes[0].plotPointCount, null, 'a count nobody sent is null, not 0')
})

test('the page draws no plot points inline any more', () => {
  const page = readFileSync(join(CLIENT, 'outline.tsx'), 'utf8')
  assert.equal(page.includes('DETAIL_POOL'), false, 'the warm-up pool is gone: the counts ride along')
  assert.equal(page.includes('declaredKindsOf'), false, 'tiers come off the wire, not from 161 detail reads')
  // The left column used to render `points[row.node.id]` under an open row. The right column
  // still lists the selected node's points (that is what `selectedPointsOf` is for), so the
  // assertion is on the per-row map, not on `<ul` — there is exactly one list left.
  assert.equal(page.includes('points[row.node.id]'), false, 'no plot points under a tree row')
  assert.equal((page.match(/<ul/gu) ?? []).length, 1, 'one list on the page: the detail pane')
  assert.ok(page.includes('visibleOutlineRows'), 'the tree folds through the pure rule')
})

test('the Host sends the two cells for outlines, and only for outlines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-outline-wire-'))
  try {
    for (const name of ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']) {
      mkdirSync(join(dir, name), { recursive: true })
      writeFileSync(join(dir, name, '.gitkeep'), '')
    }
    writeFileSync(
      join(dir, 'inkflow.json'),
      JSON.stringify({ schemaVersion: 1, title: '线材', author: '测试' }),
      'utf8',
    )
    writeFileSync(
      join(dir, 'outlines', 'overall.md'),
      ['---', 'kind: overall', 'title: 整体', '---', '', '- [主线] 少年入山', '- [主线] 出山', ''].join('\n'),
      'utf8',
    )
    writeFileSync(join(dir, 'characters', '沈青.md'), ['---', 'name: 沈青', '---', '', '一个人。', ''].join('\n'), 'utf8')

    const view = await bundle(join(ROOT, 'src/host/library-view.ts'), 'node')
    const payload = await view.buildLibrary({ sessionId: 'test', root: dir }, '0.0.0')
    const outlines = payload.kinds.find((kind) => kind.kind === 'outlines')
    assert.ok(outlines !== undefined, 'the library payload has an outlines group')
    assert.equal(outlines.items.length, 1)
    const node = outlines.items[0]
    assert.equal(node.tier, 'overall', 'the rebuild decides the tier; the panel must not re-infer it')
    assert.equal(node.plotPointCount, 2, 'the body declares two plot points')

    const characters = payload.kinds.find((kind) => kind.kind === 'characters')
    assert.equal(characters.items[0].tier, undefined, 'other kinds do not grow the outlines cells')
    assert.equal(characters.items[0].plotPointCount, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
