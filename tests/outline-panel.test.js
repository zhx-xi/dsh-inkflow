/**
 * Contract tests for the 大纲 tab (`src/client/outline-model.ts`).
 *
 * The page is pure client: it reads the setting library's own projection
 * (`GET /library` → the `outlines` group) and writes through the same
 * `POST /library/item` the library editor uses. There is nothing new on the Host
 * side, so what can be wrong here is the VIEW MODEL: which nodes the tree holds,
 * the order they are read in, whether a node can be lost, and whether a plot
 * point's story-line tag survives the trip.
 *
 * Every assertion below fails if the model is wrong, and the last test fails if
 * the page never reaches the bundle DSH loads.
 *
 * Run: pnpm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
const require = createRequire(import.meta.url)

/** Bundle `src/client/outline-model.ts` to an ESM data URL and import it. */
async function loadOutlineModel() {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client', 'outline-model.ts')],
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

/**
 * A `GET /library` answer shaped exactly as the Host builds it (`LibraryItemRow`):
 * `orderIndex` is the outline's `order`, and the tier is NOT on the wire — a node
 * that declares no `kind` has to be read off its file name, the same inference the
 * rebuild makes.
 */
function outlinesPayload(items, extra = {}) {
  return {
    indexAvailable: true,
    total: items.length,
    kinds: [
      { kind: 'characters', total: 1, truncated: false, items: [{ id: 'c1', path: 'characters/沈青.md', title: '沈青' }] },
      { kind: 'outlines', total: items.length, truncated: false, items },
    ],
    ...extra,
  }
}

function node(id, path, title, parent, orderIndex) {
  return { id, path, title, category: null, parent, status: null, orderIndex }
}

/** One well-formed book: one overall, two volumes, chapters under both. */
function threeLevelBook() {
  return outlinesPayload([
    node('ov', 'outlines/overall.md', '全书总纲', null, 0),
    node('v2', 'outlines/vol-02.md', '卷二 成长', 'ov', 2),
    node('v1', 'outlines/vol-01.md', '卷一 入山', 'ov', 1),
    node('c12', 'outlines/ch-0012.md', '第十二章', 'v1', 12),
    node('c11', 'outlines/ch-0011.md', '第十一章', 'v1', 11),
    node('c3', 'outlines/ch-0003.md', '第三章', 'ov', 3),
  ])
}

/** `[group:depth]id` per row — the whole shape of the reading order in one string. */
function shape(rows) {
  return rows.map((row) => `${row.group}:${String(row.depth)}:${row.node.id}`)
}

test('outline-model: 整体 first, then 卷 and 章 by order', async () => {
  const model = await loadOutlineModel()
  const tree = model.buildOutlineTree(threeLevelBook())
  const rows = model.flattenOutlineTree(tree)

  assert.deepEqual(
    shape(rows),
    ['overall:0:ov', 'overall:1:v1', 'overall:2:c11', 'overall:2:c12', 'overall:1:v2', 'overall:1:c3'],
    'the overall node roots the tree, volumes follow by order, and a chapter hangs under its own parent',
  )
  assert.equal(rows[0].node.tier, 'overall', 'the root is labelled 整体')
  assert.equal(rows[1].node.tier, 'volume', 'vol-01.md is a volume')
  assert.equal(rows[2].node.tier, 'chapter', 'ch-0011.md is a chapter')
  // The INDENT follows the tree, the LABEL follows the tier: a chapter hung directly on
  // the overall is one level in but still reads 章 (conventions §3.5 allows it).
  assert.equal(rows[5].node.tier, 'chapter', 'a chapter hanging on the overall is still a chapter')
  assert.equal(rows[5].depth, 1, 'it sits one level in, where its parent puts it')
  assert.equal(tree.total, 6, 'every node of the group is in the tree')
  assert.deepEqual(tree.orphans, [], 'nothing dangles in a well-formed book')
  assert.deepEqual(tree.unparented, [], 'nothing is loose in a well-formed book')

  // The other seven kinds are NOT this page's business: it reads its own group only.
  assert.equal(rows.some((row) => row.node.id === 'c1'), false, 'the characters group is ignored')
})

test('outline-model: a loose node and a dangling node each keep their own group', async () => {
  const model = await loadOutlineModel()
  const tree = model.buildOutlineTree(
    outlinesPayload([
      node('ov', 'outlines/overall.md', '全书总纲', null, 0),
      node('v1', 'outlines/vol-01.md', '卷一', 'ov', 1),
      // 散章: no parent at all — the author has not decided where it goes.
      node('loose', 'outlines/ch-0099.md', '第九十九章', null, 99),
      // 挂错: `parent` names a node this book does not have.
      node('lost', 'outlines/vol-09.md', '卷九 丢失的父节点', 'nobody', 9),
    ]),
  )
  const rows = model.flattenOutlineTree(tree)

  assert.deepEqual(
    shape(rows),
    ['overall:0:ov', 'overall:1:v1', 'unparented:0:loose', 'orphan:0:lost'],
    'a node is never swallowed: what cannot be attached is grouped, not dropped',
  )
  assert.deepEqual(
    tree.orphans.map((entry) => entry.parent),
    ['nobody'],
    'the dangling node remembers which parent it names, so the pane can say so',
  )
  assert.equal(rows.length, 4, 'four nodes in, four nodes out')
  assert.equal(model.OUTLINE_GROUP_LABELS.unparented, '未挂父节点')
  assert.equal(model.OUTLINE_GROUP_LABELS.orphan, '父节点不存在')
})

test('outline-model: a parent cycle is cut, not followed forever', async () => {
  const model = await loadOutlineModel()
  const tree = model.buildOutlineTree(
    outlinesPayload([
      node('ov', 'outlines/overall.md', '全书总纲', null, 0),
      node('a', 'outlines/vol-01.md', '卷一', 'b', 1),
      node('b', 'outlines/ch-0001.md', '第一章', 'a', 1),
    ]),
  )
  const rows = model.flattenOutlineTree(tree)
  assert.equal(rows.filter((row) => row.node.id === 'a').length, 1, 'a cycle cannot render one node twice')
  assert.equal(rows.filter((row) => row.node.id === 'b').length, 1)
  assert.equal(rows.length, 3, 'the overall node plus the two nodes of the cycle')
})

test('outline-model: a declared kind wins over the file name', async () => {
  const model = await loadOutlineModel()
  const payload = outlinesPayload([
    node('main', 'outlines/main.md', '总纲', null, 0),
    node('v1', 'outlines/vol-01.md', '卷一', 'main', 1),
  ])
  const byPath = model.buildOutlineTree(payload)
  assert.equal(byPath.overall.length, 0, 'without a declaration main.md is not recognisable as the overall')
  assert.deepEqual(
    byPath.unparented.map((entry) => entry.node.id),
    ['main'],
    'it still shows up as a loose node rather than vanishing',
  )

  // The pane only learns the declared kind once the detail route answers; the tree
  // then re-groups on it. A file the inference cannot read must not be stuck wrong.
  const declared = model.buildOutlineTree(payload, { main: 'overall' })
  assert.deepEqual(
    shape(model.flattenOutlineTree(declared)),
    ['overall:0:main', 'overall:1:v1'],
    'the declared kind re-roots the tree',
  )
})

test('outline-model: plot points keep their [标签] and the text after it', async () => {
  const model = await loadOutlineModel()
  const body = [
    '- [主线] 少年入山',
    '- [人物] 沈青登场',
    '- [伏笔] 断剑第一次出现',
    '- 无标签的一条',
    '  续行并进上一条',
    '',
    '这一段是说明文字，不是情节点。',
    '',
    '- [承诺] 这一章要让读者相信他赢不了',
    '- [锚点] 雨落在石阶上',
    '',
    '```',
    '- 代码块里的列表项不是情节点',
    '```',
    '- [主线] 收尾',
  ].join('\n')

  const points = model.parseOutlinePlotPoints(body)
  assert.deepEqual(
    points,
    [
      { text: '少年入山', arc: '主线' },
      { text: '沈青登场', arc: '人物' },
      { text: '断剑第一次出现', arc: '伏笔' },
      { text: '无标签的一条 续行并进上一条' },
      { text: '这一章要让读者相信他赢不了', arc: '承诺' },
      { text: '雨落在石阶上', arc: '锚点' },
      { text: '收尾', arc: '主线' },
    ],
    'the tag is data, the text is what follows it, and prose/fenced code are not plot points',
  )
  assert.equal(
    model.plotPointLabel(points[0]),
    '[主线] 少年入山',
    'the label puts the tag back in front, so nothing can quietly strip it',
  )
  assert.equal(model.plotPointLabel(points[3]), '无标签的一条 续行并进上一条', 'an untagged point gains no brackets')
  assert.deepEqual(model.parseOutlinePlotPoints(''), [], 'an empty body has no plot points')
})

test('outline-model: the empty state says what to do, in the tool that does it', async () => {
  const model = await loadOutlineModel()
  const empty = model.OUTLINE_EMPTY['no-nodes']

  assert.equal(empty.title, '这本书还没有大纲节点')
  assert.match(empty.body, /inkflow_outline_upsert/, 'the card names the real tool, not an invented one')
  assert.match(empty.body, /整体/, 'the card says the first node is the overall one')

  // "cannot answer" is not "the book has no outline": the index gate is its own card.
  const silent = model.buildOutlineTree({ kinds: [], indexAvailable: false })
  assert.equal(silent.indexAvailable, false, 'an unreadable index is reported, not read as an empty book')
  assert.equal(silent.total, 0)
  assert.equal(model.OUTLINE_EMPTY['index-unavailable'].title, '索引不可用')
  assert.equal(model.buildOutlineTree(null).indexAvailable, true, 'nothing loaded yet is not a refusal')
})

test('outline-model: an 大纲 address opens the 大纲 tab, every other kind opens 设定库', async () => {
  const model = await loadOutlineModel()
  // `AuditJumpTarget.entityKind` / `SearchHit.kind` carry the CONTENT DIR name (plural);
  // the tab id is singular. The workbench maps the address, the page never guesses.
  assert.equal(model.tabForEntityKind('outlines'), 'outline', 'an 大纲 finding lands on the new tab')
  assert.equal(model.tabForEntityKind('characters'), 'library', 'a character stays in 设定库')
  assert.equal(model.tabForEntityKind('world'), 'library', 'so does a place')
  assert.equal(model.tabForEntityKind(''), 'library', 'an unknown kind is not sent to a page that cannot show it')
})

test('outline-model: the facts line counts tiers, and a focus request finds its node', async () => {
  const model = await loadOutlineModel()
  const tree = model.buildOutlineTree(threeLevelBook())

  assert.equal(model.describeOutlineFacts(tree), '整体 1 · 卷 2 · 章 3 · 共 6 条')
  const loose = model.buildOutlineTree(
    outlinesPayload([node('ov', 'outlines/overall.md', '全书总纲', null, 0), node('x', 'outlines/ch-0001.md', '一', null, 1)]),
  )
  assert.equal(
    model.describeOutlineFacts(loose),
    '整体 1 · 卷 0 · 章 1 · 未挂父节点 1 · 共 2 条',
    'a loose node is counted out loud',
  )

  assert.equal(model.findOutlineNode(tree, { kind: 'outlines', id: 'c11', nonce: 1 })?.title, '第十一章')
  assert.equal(model.findOutlineNode(tree, { kind: 'characters', id: 'c11', nonce: 1 }), undefined, 'another kind is not ours')
  assert.equal(model.findOutlineNode(tree, null), undefined)

  const item = model.outlineItemOf(model.flattenOutlineTree(tree)[1].node)
  assert.deepEqual(
    { kind: item.kind, id: item.id, parent: item.parent, title: item.title },
    { kind: 'outlines', id: 'v1', parent: 'ov', title: '卷一 入山' },
    'the editor takes the library row shape, so it stays the ONE editor',
  )
})

test('the client bundle ships the 大纲 page and its wording', () => {
  if (!existsSync(BUNDLE)) throw new Error('lib/client.js is missing: run `pnpm run build` first')
  const text = readFileSync(BUNDLE, 'utf8')
  for (const marker of ['这本书还没有大纲节点', 'inkflow_outline_upsert', '情节点', '未挂父节点']) {
    assert.ok(text.includes(marker), `lib/client.js is missing the 大纲 wording: ${marker}`)
  }
  assert.ok(text.includes('/library/item'), 'the page writes through the library route, not a second one')
})
