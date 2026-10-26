/**
 * Pure view model for the 大纲 tab.
 *
 * The page has no route of its own and no second write path: it reads the setting
 * library's own projection (`GET /inkflow/internal/library`, the `outlines` group)
 * and saves through the same `POST /library/item` the library editor uses, against
 * the same CAS baseline. What is new is the READING ORDER — three levels (整体 → 卷 →
 * 章) plus the plot points of each node — and that is what lives here.
 *
 * Two facts about the wire shape decide this file:
 *
 *   * The row carries `orderIndex` (the outline's `order`) and `parent`, but NOT the
 *     tier. A node that declares `kind: overall` on a file called `main.md` therefore
 *     looks like "层级不明" until its detail is read, which is why `buildOutlineTree`
 *     accepts the declared kinds as an optional map and re-roots the tree on them.
 *     Until then the file name decides, exactly as the rebuild's own inference does.
 *   * Plot points are BODY text (`- [主线] 少年入山`), so they can only be parsed from
 *     the detail route's `body`. The parser below is the same rule set conventions
 *     §3.5 states: a top-level list item is a point, an indented line joins the point
 *     above it, fenced code is skipped, and a blank line or a heading ends the list.
 *     The `[标签]` is kept as `arc` and never stripped from what the author sees.
 *
 * No IO, no React, no `@deepseek-ai/*` import (ADR-0008 D4).
 */

import { asRecord, optionalString } from './library-model.js'
import type { LibraryFocus, LibraryItemValue, LibraryTreeItem, LibraryValue } from './library-model.js'

/** The content directory this page owns (`CONTENT_DIRS` name — plural, like the wire). */
export const OUTLINE_KIND = 'outlines'

/** The tab id — singular, and NOT the directory name; the two are different strings. */
export const OUTLINE_TAB = 'outline'

/** The tiers conventions §3.5 allows, in reading order. */
export const OUTLINE_TIERS = ['overall', 'volume', 'chapter'] as const

/** A node's level. `unknown` is a real answer (a file this build cannot classify). */
export type OutlineTier = (typeof OUTLINE_TIERS)[number] | 'unknown'

export const OUTLINE_TIER_LABELS: Record<OutlineTier, string> = {
  overall: '整体',
  volume: '卷',
  chapter: '章',
  unknown: '层级不明',
}

/**
 * The three groups the tree renders, top to bottom.
 *
 * The last two exist so a node can never be swallowed: a loose node (no `parent`) and
 * a node whose `parent` names nothing are the two states a hand-edited book reaches,
 * and both have to stay clickable — the author fixes them from here.
 */
export const OUTLINE_GROUP_LABELS = {
  overall: '整体大纲',
  unparented: '未挂父节点',
  orphan: '父节点不存在',
} as const

export type OutlineGroupId = keyof typeof OUTLINE_GROUP_LABELS

/** One outline node, as the tree holds it. */
export interface OutlineNode {
  id: string
  path: string
  title: string
  tier: OutlineTier
  parent: string | null
  /** The frontmatter `order` (the projection's `orderIndex`); `null` = not written. */
  order: number | null
}

/** A node whose `parent` names no node of this book, with the name it points at. */
export interface OutlineOrphan {
  node: OutlineNode
  parent: string
}

export interface OutlineTreeNode {
  node: OutlineNode
  depth: number
  children: OutlineTreeNode[]
}

export interface OutlineTree {
  /** Trees rooted at an `overall` node — normally exactly one. */
  overall: OutlineTreeNode[]
  /** Roots with no `parent` that are not an overall (a 散章, an unreached volume). */
  unparented: OutlineTreeNode[]
  /** Nodes whose `parent` names nothing: reported, never attached, never dropped. */
  orphans: OutlineOrphan[]
  /** Every node the group holds — the number the page must account for. */
  total: number
  /** `false` = the derived index could not answer (`INDEX_UNAVAILABLE`). */
  indexAvailable: boolean
  /** The Host reached its per-kind row cap: the tree is short, not the book. */
  truncated: boolean
}

/** One rendered row: the node, its indent, and which group it belongs to. */
export interface OutlineRow {
  node: OutlineNode
  depth: number
  group: OutlineGroupId
}

/** Deeper than this is a hand-edited file, not a story: the walk stops rather than looping. */
const MAX_DEPTH = 8

/** A list item, at most three spaces in (CommonMark's own limit for the top level). */
const PLOT_POINT_ITEM = /^ {0,3}(?:[-*+]|\d{1,3}[.)])(?:[ \t]+(.*))?$/u
/** A fence opens or closes a code block; nothing inside one is a plot point. */
const FENCE = /^ {0,3}(?:```|~~~)/u
/** `[主线] 少年入山` → arc `主线`. A tag is short; a `[` sentence is prose. */
const ARC_TAG = /^\[([^\]\n]{1,40})\][ \t]*/u

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function basenameOf(path: string): string {
  const slashed = path.replaceAll('\\', '/')
  return slashed.slice(slashed.lastIndexOf('/') + 1)
}

/**
 * The tier a file name implies — the same inference the rebuild makes when a node
 * declares no `kind` (`domains/scan-helpers.ts`), restated here because the Client
 * half cannot import the Host's modules.
 */
export function inferOutlineTier(path: string): OutlineTier {
  const name = basenameOf(path)
    .replace(/\.[^.]*$/u, '')
    .toLowerCase()
  if (name === 'overall' || name.startsWith('overall')) return 'overall'
  if (name.startsWith('vol-') || name.startsWith('volume-')) return 'volume'
  if (name.startsWith('ch-') || name.startsWith('chapter-')) return 'chapter'
  return 'unknown'
}

function tierOf(value: unknown): OutlineTier | undefined {
  return typeof value === 'string' && (OUTLINE_TIERS as readonly string[]).includes(value)
    ? (value as OutlineTier)
    : undefined
}

/**
 * The tier a detail's own `frontmatter.kind` declares.
 *
 * The file is the truth, so this beats the file name — a node moved to `main.md` keeps
 * its level. `undefined` means the detail said nothing usable (or was not loaded yet).
 */
export function tierFromDetail(value: LibraryItemValue | undefined): OutlineTier | undefined {
  const frontmatter = value?.frontmatter ?? {}
  return tierOf(frontmatter['kind']) ?? tierOf(value?.entity?.['kind'])
}

/**
 * `id → declared tier` for the details the page has loaded, ready to hand to
 * `buildOutlineTree`. A detail that declares nothing contributes no entry, so the
 * file-name inference still applies to it.
 */
export function declaredKindsOf(details: Iterable<LibraryItemValue>): Record<string, string> {
  const declared: Record<string, string> = {}
  for (const value of details) {
    const id = optionalString(value.id)
    const tier = tierFromDetail(value)
    if (id !== null && tier !== undefined) declared[id] = tier
  }
  return declared
}

function asNode(raw: unknown, kind: string, declared: Record<string, string>): OutlineNode | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const id = optionalString(record['id'])
  if (id === null) return undefined
  const path = optionalString(record['path']) ?? id
  return {
    id,
    path,
    title: optionalString(record['title']) ?? id,
    tier: tierOf(declared[id]) ?? inferOutlineTier(path),
    parent: optionalString(record['parent']),
    order: numberOrNull(record['orderIndex']) ?? numberOrNull(record['order']),
  }
}

/**
 * The `outlines` group of a `GET /library` answer, as nodes.
 *
 * The other seven kinds are ignored on purpose: this page is not a second setting
 * library, and reading them here would be the second entry point the split avoids.
 */
export function readOutlineNodes(
  value: LibraryValue | null,
  declared: Record<string, string> = {},
): { nodes: OutlineNode[]; indexAvailable: boolean; truncated: boolean } {
  if (value === null) return { nodes: [], indexAvailable: true, truncated: false }
  for (const raw of Array.isArray(value.kinds) ? value.kinds : []) {
    const record = asRecord(raw)
    if (record === undefined || optionalString(record['kind']) !== OUTLINE_KIND) continue
    const items = Array.isArray(record['items']) ? record['items'] : []
    return {
      nodes: items.map((item) => asNode(item, OUTLINE_KIND, declared)).filter((node): node is OutlineNode => node !== undefined),
      indexAvailable: value.indexAvailable !== false,
      truncated: record['truncated'] === true,
    }
  }
  // The kind is absent from a payload the Host did answer: the book simply has no
  // outline node yet. That is `total 0`, not "the index cannot answer".
  return { nodes: [], indexAvailable: value.indexAvailable !== false, truncated: false }
}

/** `order` first, then title, then id — a walk order that does not depend on the filesystem. */
function compareNodes(left: OutlineNode, right: OutlineNode): number {
  const orderLeft = left.order ?? Number.MAX_SAFE_INTEGER
  const orderRight = right.order ?? Number.MAX_SAFE_INTEGER
  if (orderLeft !== orderRight) return orderLeft - orderRight
  if (left.title !== right.title) return left.title < right.title ? -1 : 1
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/**
 * Assemble the tree.
 *
 * `declared` is what the loaded details say their `kind` is — the map
 * `declaredKindsOf` builds. Reading order and grouping both follow the Host's own
 * tree builder, with one addition the panel needs: the unparented nodes and the
 * dangling ones are separate GROUPS rather than "extra roots", so the pane can print
 * why they are there.
 */
export function buildOutlineTree(value: LibraryValue | null, declared: Record<string, string> = {}): OutlineTree {
  const read = readOutlineNodes(value, declared)
  const byId = new Map(read.nodes.map((node) => [node.id, node]))
  const childrenOf = new Map<string, OutlineNode[]>()
  const orphans: OutlineOrphan[] = []

  for (const node of read.nodes) {
    if (node.parent === null) continue
    if (!byId.has(node.parent)) {
      orphans.push({ node, parent: node.parent })
      continue
    }
    const bucket = childrenOf.get(node.parent)
    if (bucket === undefined) childrenOf.set(node.parent, [node])
    else bucket.push(node)
  }

  const visited = new Set<string>()
  const view = (node: OutlineNode, depth: number): OutlineTreeNode => {
    visited.add(node.id)
    const children = (childrenOf.get(node.id) ?? [])
      .filter((child) => !visited.has(child.id) && depth < MAX_DEPTH)
      .sort(compareNodes)
      .map((child) => view(child, depth + 1))
    return { node, depth, children }
  }

  // A dangling node is already accounted for in its own group: it has no parent to
  // attach to, and listing it twice would be the page contradicting itself.
  for (const orphan of orphans) visited.add(orphan.node.id)

  const roots = read.nodes.filter((node) => node.parent === null).sort(compareNodes)
  const overall = roots.filter((node) => node.tier === 'overall').map((node) => view(node, 0))
  const unparented = roots.filter((node) => node.tier !== 'overall').map((node) => view(node, 0))
  // A node reachable only through a parent cycle has no root above it. It joins the
  // unparented group rather than vanishing — the pane's job is to show the author what
  // the file says, and the rebuild reports the cycle separately.
  for (const node of read.nodes) {
    if (visited.has(node.id)) continue
    unparented.push(view(node, 0))
  }

  return {
    overall,
    unparented,
    orphans: orphans.sort((left, right) => compareNodes(left.node, right.node)),
    total: read.nodes.length,
    indexAvailable: read.indexAvailable,
    truncated: read.truncated,
  }
}

function pushRows(out: OutlineRow[], tree: OutlineTreeNode, group: OutlineGroupId): void {
  out.push({ node: tree.node, depth: tree.depth, group })
  for (const child of tree.children) pushRows(out, child, group)
}

/** Every row in reading order — what the left column maps over, indent included. */
export function flattenOutlineTree(tree: OutlineTree): OutlineRow[] {
  const rows: OutlineRow[] = []
  for (const root of tree.overall) pushRows(rows, root, 'overall')
  for (const root of tree.unparented) pushRows(rows, root, 'unparented')
  for (const orphan of tree.orphans) rows.push({ node: orphan.node, depth: 0, group: 'orphan' })
  return rows
}

/**
 * The node a focus request names, if this tree holds it.
 *
 * Two addresses resolve here on purpose: a search hit or an audit finding carries an `id`,
 * while 设定库's problem panel knows only the `path` a `validation_issues` row carries. A pane
 * that answered one and not the other would switch the tab and then look like a dead click.
 */
export function findOutlineNode(tree: OutlineTree, focus: LibraryFocus | null | undefined): OutlineNode | undefined {
  if (focus === null || focus === undefined || focus.kind !== OUTLINE_KIND) return undefined
  const matches = (node: OutlineNode): boolean =>
    (focus.id !== undefined && node.id === focus.id) || (focus.path !== undefined && node.path === focus.path)
  const hit =
    tree.overall.concat(tree.unparented).map((root) => findInTree(root, matches)).find((node) => node !== undefined) ??
    tree.orphans.map((orphan) => orphan.node).find(matches)
  return hit
}

function findInTree(tree: OutlineTreeNode, matches: (node: OutlineNode) => boolean): OutlineNode | undefined {
  if (matches(tree.node)) return tree.node
  for (const child of tree.children) {
    const hit = findInTree(child, matches)
    if (hit !== undefined) return hit
  }
  return undefined
}

/**
 * The row shape the library editor takes.
 *
 * The editor is reused as-is (`library-editor.tsx`), which is the whole point of this
 * page: one editor, one save route, one CAS rule. Its props are a `LibraryTreeItem`,
 * so an outline node is projected into that shape rather than a second editor being
 * written for the same fields.
 */
export function outlineItemOf(node: OutlineNode): LibraryTreeItem {
  return {
    kind: OUTLINE_KIND,
    id: node.id,
    path: node.path,
    title: node.title,
    category: null,
    parent: node.parent,
    status: null,
  }
}

/**
 * The kinds that have a page of their own, with the tab id each one opens.
 *
 * `AuditJumpTarget.entityKind` and `SearchHit.kind` carry the CONTENT DIR name (plural);
 * the tab ids are their own strings, and 大纲's is singular (`outline`). Three kinds own a
 * page: 大纲 (its own reading order), 伏笔 (a board that can now advance a state) and 时间线
 * (two axes). Every other kind is read in 设定库, whose tree lists exactly the rest.
 */
export const OWN_PAGE_TABS: Readonly<Record<string, string>> = {
  [OUTLINE_KIND]: OUTLINE_TAB,
  foreshadowing: 'foreshadowing',
  timeline: 'timeline',
}

/**
 * Which tab an entity address opens.
 *
 * The mapping belongs to the workbench, not to the page that received the click — a report
 * prints an address and never guesses a route.
 */
export function tabForEntityKind(kind: string): string {
  return OWN_PAGE_TABS[kind] ?? 'library'
}

/**
 * The kind a problem row's file belongs to, when that kind has a page of its own.
 *
 * `validation_issues` carries a path and nothing else, so the first segment is the whole
 * address this page can resolve. `undefined` means "this page's own tree, or no page at
 * all" — a chapter is neither, and the row then keeps its in-place jump (or none).
 */
export function movedKindOf(path: string | null): string | undefined {
  if (path === null) return undefined
  const [kind] = path.replaceAll('\\', '/').split('/')
  return kind !== undefined && OWN_PAGE_TABS[kind] !== undefined ? kind : undefined
}

/**
 * One plot point: the author's text, the story line it was tagged with, and the file's
 * own line.
 *
 * `raw` is what the reader can hold against the file: the list item exactly as written,
 * `- ` included, before the tag is parsed and before a continuation line is joined. The
 * badge is a rendering (`text` + `arc`), the file is the truth — and a tooltip that
 * rebuilt the line instead of quoting it could not show the difference (a lost `- `, a
 * joined continuation, a tag the parser refused still standing in the file).
 */
export interface OutlinePlotPoint {
  text: string
  arc?: string
  raw: string
}

/** One list item's content → a plot point (`- [主线] 开场` → arc 主线, text 开场). */
function plotPointOf(content: string, raw: string): OutlinePlotPoint | undefined {
  if (content === '') return undefined
  const tag = ARC_TAG.exec(content)
  if (tag !== null) {
    const arc = (tag[1] ?? '').trim()
    const text = content.slice(tag[0].length).trim()
    if (arc !== '' && text !== '') return { text, arc, raw }
  }
  return { text: content, raw }
}

/**
 * The plot points of one outline body, in file order.
 *
 * Rules (conventions §3.5, the same four the rebuild applies): a top-level list item
 * starts a point; an indented continuation line joins the point above it; fenced code
 * is skipped; a blank line, a heading or unindented prose ends the list.
 */
export function parseOutlinePlotPoints(body: string): OutlinePlotPoint[] {
  const points: OutlinePlotPoint[] = []
  let current: OutlinePlotPoint | undefined
  let fenced = false

  for (const line of (body ?? '').split(/\r?\n/u)) {
    if (FENCE.test(line)) {
      fenced = !fenced
      current = undefined
      continue
    }
    if (fenced) continue

    const item = PLOT_POINT_ITEM.exec(line)
    if (item !== null) {
      current = plotPointOf((item[1] ?? '').trim(), line.trimEnd())
      if (current !== undefined) points.push(current)
      continue
    }
    if (line.trim() === '') {
      current = undefined
      continue
    }
    if (current !== undefined && /^[ \t]/u.test(line)) {
      current.text = `${current.text} ${line.trim()}`.trim()
      continue
    }
    current = undefined
  }
  return points
}

/** The one-line hint under the tree: counts per tier, and the two "not attached" states. */
export function describeOutlineFacts(tree: OutlineTree): string {
  if (!tree.indexAvailable) return '索引 不可用 · 大纲节点无法回答'
  const count = (tier: OutlineTier): number => countTier(tree, tier)
  const parts = [
    `整体 ${String(count('overall'))}`,
    `卷 ${String(count('volume'))}`,
    `章 ${String(count('chapter'))}`,
  ]
  const unknown = count('unknown')
  if (unknown > 0) parts.push(`层级不明 ${String(unknown)}`)
  if (tree.unparented.length > 0) parts.push(`未挂父节点 ${String(tree.unparented.length)}`)
  if (tree.orphans.length > 0) parts.push(`父节点不存在 ${String(tree.orphans.length)}`)
  parts.push(`共 ${String(tree.total)} 条`)
  return parts.join(' · ')
}

function countTier(tree: OutlineTree, tier: OutlineTier): number {
  let total = 0
  const walk = (node: OutlineTreeNode): void => {
    if (node.node.tier === tier) total += 1
    for (const child of node.children) walk(child)
  }
  for (const root of tree.overall) walk(root)
  for (const root of tree.unparented) walk(root)
  for (const orphan of tree.orphans) if (orphan.node.tier === tier) total += 1
  return total
}

/**
 * Every card the page shows instead of a blank area.
 *
 * `no-nodes` names the tool that creates the first node (`inkflow_outline_upsert`),
 * because an empty page that says "还没有内容" and nothing else leaves the author with
 * no next step — and inventing a button the tool layer does not have would be worse.
 */
export const OUTLINE_EMPTY = {
  'no-nodes': {
    title: '这本书还没有大纲节点',
    body: '让 AI 调 inkflow_outline_upsert 建第一条：一个项目恰有一条整体大纲（`kind: overall`），卷只能挂整体、章挂整体或卷。建完左栏就是三层树，右栏可以改标题、情节点与次序。',
  },
  'index-unavailable': {
    title: '索引不可用',
    body: '派生索引不存在、读不出来，或由别的 schema 版本建的，所以大纲暂时无法回答（不是「这本书没有大纲」）。让 AI 跑 inkflow_index_rebuild 后重开面板。',
  },
  'no-selection': {
    title: '选择一条大纲节点',
    body: '左栏点一个节点：右栏显示它的层级、标题、上级、次序与逐条情节点；点「编辑」可以改这些字段和情节点正文，保存时带基线指纹，磁盘上被改过就拒绝覆盖。',
  },
} as const

export type OutlineEmptyKind = keyof typeof OUTLINE_EMPTY
