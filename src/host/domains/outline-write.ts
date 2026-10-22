/**
 * Outline write model (`outlines/`) — the pure half of the write side (issue #24).
 *
 * Why a planner instead of "check inside the tool": I-01/I-02/I-05 used to exist only
 * in the rebuild validator, which runs *after* the bad file is already on disk. A
 * rebuild report is a diagnosis; a write must be a refusal. The planner is a pure
 * function over the rows, so a test can drive every refusal without a filesystem, and
 * the tool cannot skip a check by forgetting an `if`.
 *
 * The codes are deliberately the **rebuild codes** (`OUTLINE_MULTIPLE_OVERALL`,
 * `OUTLINE_VOLUME_PARENT`, `OUTLINE_VOLUME_IN_VOLUME`, `DANGLING_PARENT`,
 * `DUPLICATE_ID`): one finding must not have two names depending on which net caught
 * it. `OUTLINE_NODE_NOT_FOUND`, `OUTLINE_PARENT_CYCLE`, `OUTLINE_OVERALL_NO_PARENT`,
 * `OUTLINE_KIND_INVALID` and `OUTLINE_FIELD_INVALID` are write-only additions — they
 * describe an operation a rebuild cannot see (a refused move changed nothing).
 */

import { OUTLINE_KINDS } from '../conventions.js'
import { frontmatterLine, patchFrontmatter, splitFrontmatter } from '../frontmatter.js'
import type { OutlinePlotPoint, OutlineRow } from './outline-model.js'

export type OutlineRefusalCode =
  | 'OUTLINE_MULTIPLE_OVERALL'
  | 'OUTLINE_VOLUME_PARENT'
  | 'OUTLINE_VOLUME_IN_VOLUME'
  | 'DANGLING_PARENT'
  | 'DUPLICATE_ID'
  | 'OUTLINE_NODE_NOT_FOUND'
  | 'OUTLINE_PARENT_CYCLE'
  | 'OUTLINE_OVERALL_NO_PARENT'
  | 'OUTLINE_KIND_INVALID'
  | 'OUTLINE_FIELD_INVALID'

export interface OutlineRefusal {
  ok: false
  code: OutlineRefusalCode
  message: string
  path?: string
  nodeId?: string
}

export type OutlinePlan = { ok: true } | OutlineRefusal

/** The part of a row the planner judges. A candidate that does not exist yet fits too. */
export interface OutlineWriteNode {
  id: string
  kind: string
  path: string
  parent: string | undefined
}

function refuse(code: OutlineRefusalCode, message: string, extra: Partial<OutlineRefusal> = {}): OutlineRefusal {
  return { ok: false, code, message, ...extra }
}

/** A node reference from a tool argument: an `id` first, then a project-relative path. */
export function resolveOutlineRef(nodes: readonly OutlineWriteNode[], ref: string): OutlineWriteNode | undefined {
  const trimmed = ref.trim()
  if (trimmed === '') return undefined
  return nodes.find((node) => node.id === trimmed) ?? nodes.find((node) => node.path === trimmed)
}

/** Rows a caller can plan against, in the shape the planner judges. */
export function writeNodesOf(rows: readonly OutlineRow[]): OutlineWriteNode[] {
  return rows.map((row) => ({ id: row.id, kind: row.kind, path: row.path, parent: row.parent }))
}

/**
 * Is `node` allowed to sit where it claims?
 *
 * Shared by create/update and move on purpose: "where may a volume hang" is one rule,
 * not two, and a move that skipped it would be the hole the invariant exists to close.
 * `nodes` must already be the view **without** the candidate (the caller drops the file
 * being rewritten; the candidate may still be in it by path).
 */
export function planOutlinePlacement(nodes: readonly OutlineWriteNode[], node: OutlineWriteNode): OutlinePlan {
  if (!(OUTLINE_KINDS as readonly string[]).includes(node.kind)) {
    return refuse('OUTLINE_KIND_INVALID', `"${node.kind}" is not an outline kind (expected overall|volume|chapter)`, {
      path: node.path,
      nodeId: node.id,
    })
  }

  const siblings = nodes.filter((other) => other.path !== node.path)

  if (node.kind === 'overall') {
    if (node.parent !== undefined) {
      return refuse('OUTLINE_OVERALL_NO_PARENT', 'the overall outline is the root of the tree and cannot have a parent', {
        path: node.path,
        nodeId: node.id,
      })
    }
    return { ok: true }
  }

  const parentRef = node.parent?.trim()
  const parent = parentRef === undefined || parentRef === '' ? undefined : resolveOutlineRef(siblings, parentRef)
  if (parentRef !== undefined && parentRef !== '' && parent === undefined) {
    return refuse('DANGLING_PARENT', `parent "${parentRef}" does not exist (I-05)`, {
      path: node.path,
      nodeId: node.id,
    })
  }

  if (node.kind === 'volume') {
    if (parent !== undefined && parent.kind === 'volume') {
      return refuse('OUTLINE_VOLUME_IN_VOLUME', 'a volume outline cannot nest under another volume (I-02)', {
        path: node.path,
        nodeId: node.id,
      })
    }
    const overall = siblings.find((other) => other.kind === 'overall')
    if (overall === undefined) {
      return refuse('OUTLINE_VOLUME_PARENT', 'a volume needs the overall outline as its parent, and none exists (I-01/I-02)', {
        path: node.path,
        nodeId: node.id,
      })
    }
    if (parent === undefined || parent.id !== overall.id) {
      return refuse('OUTLINE_VOLUME_PARENT', `a volume outline must have parent = the overall outline ("${overall.id}") (I-02)`, {
        path: node.path,
        nodeId: node.id,
      })
    }
  }

  // A parent chain that loops back to the node makes the tree unrenderable and every
  // depth-first consumer (tree viewer, exporter) hang. Rows are keyed by id, so a loop
  // is only reachable by pointing a parent at a descendant — exactly what a `move`
  // does if it is not checked.
  if (parent !== undefined) {
    const seen = new Set<string>()
    let cursor: OutlineWriteNode | undefined = parent
    while (cursor !== undefined) {
      if (cursor.id === node.id || seen.has(cursor.id)) {
        return refuse('OUTLINE_PARENT_CYCLE', `"${parentRef ?? ''}" would put the node under itself`, {
          path: node.path,
          nodeId: node.id,
        })
      }
      seen.add(cursor.id)
      const next: string | undefined = cursor.parent
      cursor = next === undefined ? undefined : siblings.find((other) => other.id === next)
    }
  }

  return { ok: true }
}

/**
 * The pre-write verdict for a create/update. `nodes` is the **current** project view
 * (the node's own row included when it already exists; the planner drops it by path),
 * `node` is the candidate's post-write state.
 */
export function planOutlineUpsert(input: {
  readonly nodes: readonly OutlineWriteNode[]
  readonly node: OutlineWriteNode
}): OutlinePlan {
  const others = input.nodes.filter((other) => other.path !== input.node.path)

  // I-04, write half: a domain table has one primary key, so an id already used by
  // another outline file would silently replace that node's row on the next rebuild.
  const duplicate = others.find((other) => other.id === input.node.id)
  if (duplicate !== undefined) {
    return refuse('DUPLICATE_ID', `id "${input.node.id}" is already used by ${duplicate.path} (I-04)`, {
      path: input.node.path,
      nodeId: input.node.id,
    })
  }

  if (input.node.kind === 'overall') {
    const existing = others.filter((other) => other.kind === 'overall')
    if (existing.length > 0) {
      return refuse('OUTLINE_MULTIPLE_OVERALL', `this book already has an overall outline (${existing[0]?.path ?? '?'}) (I-01)`, {
        path: input.node.path,
        nodeId: input.node.id,
      })
    }
  }
  return planOutlinePlacement(input.nodes, input.node)
}

/** The pre-write verdict for reparenting an existing node. */
export function planOutlineMove(input: {
  readonly nodes: readonly OutlineWriteNode[]
  readonly id: string
  readonly parent: string | undefined
}): OutlinePlan {
  const node = resolveOutlineRef(input.nodes, input.id)
  if (node === undefined) {
    return refuse('OUTLINE_NODE_NOT_FOUND', `no outline node ${input.id}`, { nodeId: input.id })
  }
  return planOutlinePlacement(input.nodes, { ...node, parent: input.parent })
}

// ---------------------------------------------------------------------------
// Writing the document
// ---------------------------------------------------------------------------

export interface OutlineDocumentFields {
  id?: string
  kind?: string
  title?: string
  /** `null`/undefined means "no parent": `parent: null` on create, key removed on update. */
  parent?: string | null
  order?: number
}

/**
 * The document a write should produce.
 *
 * A new file is rendered from the field dictionary of conventions.md §3.5 (frontmatter
 * block + body). An existing file is **patched**, never regenerated: `patchFrontmatter`
 * touches only the named lines, so comments, unknown keys and quote style the author
 * wrote survive an edit — unknown fields are preserved by contract (data-model §3.1).
 */
export function renderOutlineDocument(input: {
  /** The current text, or undefined when the file is about to be created. */
  readonly text?: string
  readonly fields: OutlineDocumentFields
  /** Replaces the whole body when given. */
  readonly body?: string
  /** Rendered as the body when `body` is absent (one bullet per point). */
  readonly plotPoints?: readonly OutlinePlotPoint[]
  /** Body to keep when neither `body` nor `plotPoints` is given. */
  readonly keepBody?: string
}): string {
  const body =
    input.body !== undefined
      ? input.body
      : input.plotPoints !== undefined
        ? renderPlotPoints(input.plotPoints)
        : (input.keepBody ?? '')

  const parts = input.text === undefined ? undefined : splitFrontmatter(input.text)
  // No block at all (a fresh file, or a legacy one): writing the fields *is* the point
  // of an upsert, so the block is created rather than skipped.
  if (parts === undefined || parts.hasFrontmatter === false) return freshDocument(input.fields, body)

  const entries: Record<string, string> = {}
  if (input.fields.id !== undefined) entries['id'] = input.fields.id
  if (input.fields.kind !== undefined) entries['kind'] = input.fields.kind
  if (input.fields.title !== undefined) entries['title'] = input.fields.title
  if (input.fields.order !== undefined) entries['order'] = String(input.fields.order)

  const parent = input.fields.parent
  let patched: string
  if (parent === undefined) {
    patched = patchFrontmatter(input.text ?? '', entries).text
  } else if (parent === null) {
    // `parent` is removed rather than emptied: an empty value reads back as a block
    // list, and the old owner would keep winning (same reasoning as the chapter
    // writer's `volume` removal).
    patched = patchFrontmatter(input.text ?? '', entries, { remove: ['parent'] }).text
  } else {
    patched = patchFrontmatter(input.text ?? '', { ...entries, parent }).text
  }
  return `${splitFrontmatter(patched).head}${body}`
}

function freshDocument(fields: OutlineDocumentFields, body: string): string {
  const lines = ['---']
  for (const key of ['id', 'kind', 'title'] as const) {
    const value = fields[key]
    if (value !== undefined) lines.push(frontmatterLine(key, value))
  }
  lines.push(fields.parent === undefined || fields.parent === null ? 'parent: null' : frontmatterLine('parent', fields.parent))
  if (fields.order !== undefined) lines.push(frontmatterLine('order', String(fields.order)))
  lines.push('---', '')
  const prose = body === '' ? '' : body.endsWith('\n') ? body : `${body}\n`
  return `${lines.join('\n')}\n${prose}`
}

/** The bullet list conventions.md §3.5 uses for plot points. */
export function renderPlotPoints(points: readonly OutlinePlotPoint[]): string {
  if (points.length === 0) return ''
  const lines = points.map((point) => `- ${point.arc === undefined ? point.text : `[${point.arc}] ${point.text}`}`)
  return `${lines.join('\n')}\n`
}
