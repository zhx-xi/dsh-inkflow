/**
 * Outline domain model (`outlines/`) — pure, filesystem-free.
 *
 * The domain module (`./outline.ts`) and its tools (`./outline-tools.ts`) both use
 * this file, and that is the point: the rebuild path and the write path must judge
 * the same bytes by the same rules (X-4). Putting the parser, the tree builder and
 * the invariants here is what lets the tools call them without importing the
 * registry (which imports the domain — a runtime cycle).
 *
 * Plot points: [conventions.md §3.5](../../../.agents/specs/conventions.md) shows an
 * outline file as a frontmatter block plus a body of list items, one per plot point.
 * A list item may open with a bracketed story-line tag — `- [主线] 少年入山` — which is
 * this project's minimal expression of "故事线"; without the tag the file parses
 * exactly like the spec's example. The data model has no field dictionary for
 * story lines yet (`outlines/arcs/<slug>.md` is marked 未实现), so the tag is kept
 * inside the plot point instead of inventing frontmatter fields.
 */

import { basename, extname } from 'node:path'

import { OUTLINE_KINDS } from '../conventions.js'
import { intField, parseMarkdown, stringField } from '../frontmatter.js'
import type { DomainEntityRef, DomainTableRows, ValidationIssue } from './types.js'
import { inferOutlineKind, rowsOf } from './scan-helpers.js'

/** One plot point: the item text, plus the story line it was tagged with. */
export interface OutlinePlotPoint {
  text: string
  arc?: string
}

export interface OutlineRow {
  id: string
  path: string
  kind: string
  title: string
  parent: string | undefined
  order: number | undefined
  plotPoints: OutlinePlotPoint[]
  plotPointCount: number
}

export interface ParsedOutlineDocument {
  row?: OutlineRow
  issues: ValidationIssue[]
}

/** A list item, at most three spaces in (CommonMark's own limit for top level). */
const PLOT_POINT_ITEM = /^ {0,3}(?:[-*+]|\d{1,3}[.)])(?:[ \t]+(.*))?$/u
/** A fence opens or closes a code block; nothing inside one is a plot point. */
const FENCE = /^ {0,3}(?:```|~~~)/u
/** `[主线] 少年入山` → arc `主线`. A tag is short; a `[` sentence is prose. */
const ARC_TAG = /^\[([^\]\n]{1,40})\][ \t]*/u

/**
 * The plot points of an outline body, in file order.
 *
 * Rules, all of them cheap to state because the file is the contract:
 *   - a top-level list item starts a plot point (`-`, `*`, `+`, `1.`, `1)`);
 *   - an indented continuation line belongs to the point above it (a wrapped bullet
 *     is one plot point, not two);
 *   - fenced code is skipped: a list inside an example block is not an outline;
 *   - a blank line, a heading or unindented prose ends the list, so a summary
 *     paragraph after the points does not become one.
 */
export function parsePlotPoints(body: string): OutlinePlotPoint[] {
  const points: OutlinePlotPoint[] = []
  let current: OutlinePlotPoint | undefined
  let fenced = false

  for (const line of body.split(/\r?\n/u)) {
    if (FENCE.test(line)) {
      fenced = !fenced
      current = undefined
      continue
    }
    if (fenced) continue

    const item = PLOT_POINT_ITEM.exec(line)
    if (item !== null) {
      current = parsePlotPointItem((item[1] ?? '').trim())
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

/**
 * One list item's content → a plot point. Shared by the body parser and the writer, so
 * `- [主线] 开场` and a `plotPoints: ['[主线] 开场']` argument cannot mean two things.
 */
export function parsePlotPointItem(content: string): OutlinePlotPoint | undefined {
  if (content === '') return undefined
  const tag = ARC_TAG.exec(content)
  if (tag !== null) {
    const arc = (tag[1] ?? '').trim()
    const text = content.slice(tag[0].length).trim()
    if (arc !== '' && text !== '') return { text, arc }
  }
  return { text: content }
}

/**
 * Parse one outline file exactly as a rebuild would.
 *
 * The kind may be declared in the frontmatter or inferred from the file name; a file
 * whose kind cannot be determined is reported instead of guessed, because guessing
 * would silently put a node at the wrong level of the tree.
 */
export function parseOutlineDocument(path: string, text: string): ParsedOutlineDocument {
  if (extname(path).toLowerCase() !== '.md') return { issues: [] }

  const parsed = parseMarkdown(text)
  const issues: ValidationIssue[] = parsed.issues.map((issue) => ({ code: 'FRONTMATTER_ISSUE', path, detail: issue }))

  const declared = stringField(parsed.data, 'kind')
  const kind = (OUTLINE_KINDS as readonly string[]).includes(declared ?? '')
    ? (declared as string)
    : inferOutlineKind(path)
  if (kind === undefined) {
    issues.push({
      code: 'OUTLINE_KIND_UNKNOWN',
      path,
      detail: 'cannot infer kind; declare kind: overall|volume|chapter',
    })
    return { issues }
  }

  const plotPoints = parsePlotPoints(parsed.body)
  return {
    issues,
    row: {
      id: stringField(parsed.data, 'id') ?? path,
      path,
      kind,
      title: stringField(parsed.data, 'title') ?? basename(path).replace(/\.md$/u, ''),
      parent: stringField(parsed.data, 'parent'),
      order: intField(parsed.data, 'order'),
      plotPoints,
      plotPointCount: plotPoints.length,
    },
  }
}

/** This row's cross-class projection entry (X-1: fixed columns, one row per entity). */
export function outlineEntity(row: OutlineRow): DomainEntityRef {
  return {
    kind: 'outlines',
    id: row.id,
    path: row.path,
    title: row.title,
    parent: row.parent,
    orderIndex: row.order,
  }
}

// ---------------------------------------------------------------------------
// The three-level tree
// ---------------------------------------------------------------------------

export interface OutlineTreeNodeView {
  id: string
  kind: string
  title: string
  path: string
  order?: number
  plotPoints: readonly OutlinePlotPoint[]
  plotPointCount: number
  children: OutlineTreeNodeView[]
}

export interface OutlineDanglingRef {
  id: string
  path: string
  parent: string
}

export interface OutlineTreeResult {
  /** Nodes without a parent: normally the single `overall`, plus any loose node. */
  trees: OutlineTreeNodeView[]
  /** Nodes whose `parent` names nothing — reported, not attached (I-05). */
  dangling: OutlineDanglingRef[]
}

/**
 * Assemble the tree from the rows.
 *
 * `order` first, then title, then id: the walk order of the files is arbitrary, so the
 * display order has to come from the data or two runs would disagree. A parent cycle
 * (only reachable by hand-editing, and possible in a file whose parent points at its
 * own descendant) is cut rather than followed: `visited` stops it, and the node is
 * simply not attached, leaving the rebuild validator to report it.
 */
export function buildOutlineTree(rows: readonly OutlineRow[]): OutlineTreeResult {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const childrenOf = new Map<string, OutlineRow[]>()
  const trees: OutlineTreeNodeView[] = []
  const dangling: OutlineDanglingRef[] = []

  for (const row of rows) {
    if (row.parent === undefined) continue
    if (!byId.has(row.parent)) {
      dangling.push({ id: row.id, path: row.path, parent: row.parent })
      continue
    }
    const bucket = childrenOf.get(row.parent)
    if (bucket === undefined) childrenOf.set(row.parent, [row])
    else bucket.push(row)
  }

  const visited = new Set<string>()
  const view = (row: OutlineRow, depth: number): OutlineTreeNodeView => {
    visited.add(row.id)
    const children = (childrenOf.get(row.id) ?? [])
      .filter((child) => !visited.has(child.id) && depth < 8)
      .sort(compareNodes)
      .map((child) => view(child, depth + 1))
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      path: row.path,
      ...(row.order === undefined ? {} : { order: row.order }),
      plotPoints: row.plotPoints,
      plotPointCount: row.plotPointCount,
      children,
    }
  }

  for (const row of [...rows].filter((candidate) => candidate.parent === undefined).sort(compareNodes)) {
    trees.push(view(row, 0))
  }
  // A node reachable only through a parent cycle (possible in a hand-edited file) has
  // no root above it. Showing it as an extra root keeps it visible; `visited` still
  // stops the cycle from being walked twice.
  for (const row of [...rows].sort(compareNodes)) {
    if (visited.has(row.id)) continue
    trees.push(view(row, 0))
  }

  return { trees, dangling }
}

function compareNodes(a: OutlineRow, b: OutlineRow): number {
  const orderA = a.order ?? Number.MAX_SAFE_INTEGER
  const orderB = b.order ?? Number.MAX_SAFE_INTEGER
  if (orderA !== orderB) return orderA - orderB
  if (a.title !== b.title) return a.title < b.title ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// ---------------------------------------------------------------------------
// Invariants (data-model.md §5, I-01 / I-02 / I-05)
// ---------------------------------------------------------------------------

/**
 * The invariants over one scan's outline rows.
 *
 * One implementation for both nets: a rebuild passes no `candidate` and gets every
 * finding; a write passes the path it is about to replace and gets only what blocks
 * *that* write (X-4). Findings that have no path — the `overall` count — always
 * apply, because a volume added to a book without an overall is exactly the state
 * I-01 forbids.
 */
export function validateOutlineScan(
  scan: { readonly tables: readonly DomainTableRows[] },
  candidate?: { readonly path: string },
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const nodes = rowsOf<OutlineRow>(scan, 'outline_nodes')
  const affects = (path: string | undefined): boolean => candidate === undefined || path === undefined || path === candidate.path

  const overall = nodes.filter((node) => node.kind === 'overall')
  if (overall.length === 0) {
    issues.push({ code: 'OUTLINE_NO_OVERALL', detail: 'project must have exactly one outlines/overall.md' })
  } else if (overall.length > 1) {
    issues.push({
      code: 'OUTLINE_MULTIPLE_OVERALL',
      detail: `${String(overall.length)} overall outlines found`,
      ...(candidate === undefined ? {} : { path: candidate.path }),
    })
  }
  const overallId = overall[0]?.id
  const byId = new Map(nodes.map((node) => [node.id, node]))

  for (const node of nodes) {
    if (!affects(node.path)) continue
    const parent = node.parent === undefined ? undefined : byId.get(node.parent)
    // Most specific finding first, so the write path reports the same code the planner
    // does: "a volume under a volume" is `OUTLINE_VOLUME_IN_VOLUME`, and only its
    // general form ("the parent is not the overall") is `OUTLINE_VOLUME_PARENT`.
    if (node.parent !== undefined && parent === undefined) {
      issues.push({ code: 'DANGLING_PARENT', path: node.path, detail: `parent "${node.parent}" not found` })
    } else if (node.kind === 'volume' && parent?.kind === 'volume') {
      issues.push({ code: 'OUTLINE_VOLUME_IN_VOLUME', path: node.path, detail: 'volume outline cannot nest under a volume' })
    }
    if (node.kind === 'volume' && (node.parent === undefined || overallId === undefined || node.parent !== overallId)) {
      issues.push({
        code: 'OUTLINE_VOLUME_PARENT',
        path: node.path,
        detail: 'volume outline must have parent = overall outline id',
      })
    }
    // chapter-under-volume is allowed; chapter-under-chapter is not part of the
    // I-02 also caps the tree at three levels: `chapter` may hang under the overall
    // outline or a volume, never under another chapter. Reporting it here as well as on
    // the write path is deliberate — the write path refusing is not a substitute for the
    // rebuild noticing a file that got that shape another way (hand edit, merge, import).
    if (node.kind === 'chapter' && parent !== undefined && parent.kind === 'chapter') {
      issues.push({
        code: 'OUTLINE_CHAPTER_IN_CHAPTER',
        path: node.path,
        detail: 'a chapter outline cannot nest under another chapter (three levels: overall / volume / chapter)',
      })
    }
  }
  return issues
}
