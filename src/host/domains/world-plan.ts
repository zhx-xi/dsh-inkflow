/**
 * World-tree shape and I-08 invariants, as pure functions.
 *
 * Why this is not inside `world.ts`: the rebuild path judges a whole scan while
 * the write path judges one candidate against the current view, and both must
 * apply the *same* rules (roadmap §2.1 X-4 — "写入侧落盘前调用同一个判定"). The
 * rules therefore live here once, and each caller hands in its own view.
 *
 * Nothing in this file touches the disk: no reads, no writes, no clock.
 */

import type { ValidationIssue } from './types.js'

/** The slice of a world entry the tree and the invariants reason about. */
export interface WorldPlanRow {
  readonly id: string
  readonly path: string
  readonly title?: string
  readonly category?: string
  readonly parent?: string
}

/** A world entry that is about to be written. `title` is required: it becomes the node label. */
export interface WorldUpsertCandidate extends WorldPlanRow {
  readonly title: string
  /** Trigger words; rejected when one contains a separator the frontmatter could not read back. */
  readonly keywords?: readonly string[]
}

export type WorldUpsertCode =
  | 'WORLD_ROOT_MULTIPLE'
  | 'WORLD_ROOT_MISSING'
  | 'WORLD_CATEGORY_REQUIRED'
  | 'DANGLING_PARENT'
  | 'DUPLICATE_ID'
  | 'KEYWORD_INVALID'

export interface WorldUpsertRejection {
  readonly code: WorldUpsertCode
  readonly message: string
  readonly path?: string
}

export type WorldUpsertPlan =
  | { readonly ok: true; readonly path: string; readonly replaced: boolean }
  | { readonly ok: false; readonly error: WorldUpsertRejection }

/**
 * `world/<slug>.md` is a top-level entry — what I-08 calls a candidate root. The
 * check is on the path shape, not on the frontmatter, exactly as `world.ts` decides
 * it during a rebuild (`relPath.split('/').length === 2`).
 */
function isFirstLevel(relPath: string): boolean {
  return relPath.split('/').length === 2
}

function hasParent(row: WorldPlanRow): boolean {
  return row.parent !== undefined && row.parent !== ''
}

/**
 * I-08 + I-05 over one view of the world tree.
 *
 * `knownIds` is the cross-class id set: a world entry may point at a chapter or a
 * character (see `world.ts` `validate()`), so judging `parent` against world ids
 * alone would report a legal link as dangling.
 *
 * The flat-category book stays legal on purpose: entries that all live under
 * `world/<category>/` and never claim a parent have no root and must not be
 * reported (settled during the review; see `.agents/specs/data-model.md` §5 I-08).
 */
export function worldIssues(rows: readonly WorldPlanRow[], knownIds: ReadonlySet<string>): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (rows.length === 0) return issues

  const roots = rows.filter((row) => !hasParent(row) && isFirstLevel(row.path))
  const claimsParent = rows.some(hasParent)

  if (roots.length > 1) {
    const shown = roots.slice(0, 3).map((row) => row.path).join(', ')
    issues.push({
      code: 'WORLD_ROOT_MULTIPLE',
      detail: `${String(roots.length)} world entries are roots (${shown}${roots.length > 3 ? ', …' : ''}); exactly one root is allowed`,
    })
  } else if (roots.length === 0 && claimsParent) {
    issues.push({
      code: 'WORLD_ROOT_MISSING',
      detail:
        'world entries claim parents but none is a root; either add one first-level entry without parent or drop the parents (flat category book)',
    })
  }

  for (const row of rows) {
    if (!hasParent(row)) continue
    if (row.category === undefined || row.category === '') {
      issues.push({
        code: 'WORLD_CATEGORY_REQUIRED',
        path: row.path,
        detail: 'a world entry with a parent must also carry a category (or live under world/<category>/)',
      })
    }
    if (!knownIds.has(row.parent ?? '')) {
      issues.push({ code: 'DANGLING_PARENT', path: row.path, detail: `parent "${row.parent ?? ''}" not found` })
    }
  }
  return issues
}

/**
 * Judge one write against the current view, before anything lands.
 *
 * Blocking rule: an issue counts against this write when it names the candidate's
 * path or has no path at all (the root-count findings are project-wide, and the
 * candidate is what changes them). A pre-existing issue on somebody *else's* path
 * is a rebuild finding — the index already reports it — and must not wedge edits
 * that cannot fix it.
 */
/**
 * A keyword that cannot survive the round trip through `keywords: [a, b]`, or `undefined`.
 *
 * The list form is split on commas and ended by a line break, and `[`/`]` close the array
 * early — quoting cannot save any of those (see `renderKeyword` in `world-tools.ts` for the
 * values quoting DOES save, like a YAML-reserved `true`). Exported because the extraction
 * accept path renders the same document: a candidate must be refused with the same code the
 * tool gives, or the same author input would land from one door and be rejected from another.
 */
export function keywordProblem(keywords: readonly string[]): string | undefined {
  return keywords.find((keyword) => /[,[\]\r\n]/u.test(keyword))
}

export function planWorldUpsert(input: {
  readonly entries: readonly WorldPlanRow[]
  readonly candidate: WorldUpsertCandidate
  readonly knownIds?: ReadonlySet<string>
}): WorldUpsertPlan {
  const candidate = input.candidate
  const path = candidate.path

  const invalidKeyword = keywordProblem(candidate.keywords ?? [])
  if (invalidKeyword !== undefined) {
    return {
      ok: false,
      error: {
        code: 'KEYWORD_INVALID',
        path,
        message: `the keyword "${invalidKeyword}" contains a separator (comma, bracket or newline) the frontmatter cannot read back`,
      },
    }
  }

  const sameIdElsewhere = input.entries.find((row) => row.id === candidate.id && row.path !== path)
  if (sameIdElsewhere !== undefined) {
    return {
      ok: false,
      error: {
        code: 'DUPLICATE_ID',
        path,
        message: `id "${candidate.id}" is already used by ${sameIdElsewhere.path}; an in-place edit keeps its id, a new entry needs a new one`,
      },
    }
  }

  // Post-write view: this path's superseded row is dropped first, then the
  // candidate is added — the same replace `applyCandidate()` performs in the seam.
  const next: WorldPlanRow[] = [...input.entries.filter((row) => row.path !== path), candidate]
  const known = input.knownIds ?? new Set(next.map((row) => row.id))

  const blocking = worldIssues(next, known).filter((issue) => issue.path === undefined || issue.path === path)
  const first = blocking[0]
  if (first !== undefined) {
    return {
      ok: false,
      error: {
        code: first.code as WorldUpsertCode,
        message: first.detail,
        ...(first.path === undefined ? {} : { path: first.path }),
      },
    }
  }

  return { ok: true, path, replaced: input.entries.some((row) => row.path === path) }
}

// ---------------------------------------------------------------------------
// Tree shape
// ---------------------------------------------------------------------------

/** The slice of a world entry the tree displays — the same row the invariants read. */
export type WorldTreeEntry = WorldPlanRow

export interface WorldTreeNode {
  readonly id: string
  readonly title: string
  readonly path: string
  readonly category?: string
  readonly children: readonly WorldTreeNode[]
}

/**
 * One category's nodes. `null` collects the entries that carry no category —
 * top-level entries and the flat-category book's uncategorised leftovers alike;
 * they are shown rather than dropped.
 */
export interface WorldTreeGroup {
  readonly category: string | null
  readonly nodes: readonly WorldTreeNode[]
}

export interface WorldTree {
  /** Entries whose `parent` is absent or unresolvable — the expandable top of the tree. */
  readonly roots: readonly WorldTreeNode[]
  /**
   * The same entries bucketed by category, each entry appearing **exactly once**
   * and nested only under a same-category parent. A cross-category `parent` link
   * (legal: I-08 does not require the parent to share the category) shows up in
   * `roots`, not here — otherwise the same node would be emitted twice.
   */
  readonly groups: readonly WorldTreeGroup[]
  /** Ids declared as `parent` that no entry carries — reported, not hidden. */
  readonly danglingParents: readonly string[]
}

/** Codepoint order: stable across machines and locales, unlike `localeCompare`. */
function compareText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function titleOf(entry: WorldTreeEntry): string {
  return entry.title ?? entry.id
}

function sortNodes<T extends { readonly title: string; readonly path: string }>(nodes: T[]): T[] {
  return nodes.sort((left, right) => compareText(left.title, right.title) || compareText(left.path, right.path))
}

function categoryKeyOf(entry: WorldTreeEntry): string {
  return entry.category === undefined || entry.category === '' ? '' : entry.category
}

function toNode(
  entry: WorldTreeEntry,
  kidsOf: (id: string) => readonly WorldTreeEntry[],
  branch: ReadonlySet<string>,
): WorldTreeNode {
  const nextBranch = new Set(branch)
  nextBranch.add(entry.id)
  const kids = kidsOf(entry.id).filter((child) => !nextBranch.has(child.id))
  return {
    id: entry.id,
    title: titleOf(entry),
    path: entry.path,
    ...(entry.category === undefined || entry.category === '' ? {} : { category: entry.category }),
    children: sortNodes(kids.map((child) => toNode(child, kidsOf, nextBranch))),
  }
}

/**
 * Build the two views the panel and `inkflow_world_tree` want from one flat list:
 * `roots` (the whole tree, following every `parent` link) and `groups` (a tree per
 * category, following only same-category links).
 *
 * A dangling `parent` does not lose the node: it becomes a root and its id is
 * listed in `danglingParents`. A parent cycle terminates — a node already placed
 * in the current branch is not placed twice — and anything a cycle would strand is
 * still emitted as a top-level node of its group, so no entry is ever dropped.
 */
export function buildWorldTree(entries: readonly WorldTreeEntry[]): WorldTree {
  const byId = new Map<string, WorldTreeEntry>()
  for (const entry of entries) byId.set(entry.id, entry)

  const childrenOf = new Map<string, WorldTreeEntry[]>()
  const dangling: string[] = []
  const rootEntries: WorldTreeEntry[] = []
  const seenDangling = new Set<string>()
  for (const entry of entries) {
    const parent = entry.parent ?? ''
    if (parent === '') {
      rootEntries.push(entry)
      continue
    }
    if (!byId.has(parent)) {
      rootEntries.push(entry)
      if (!seenDangling.has(parent)) {
        seenDangling.add(parent)
        dangling.push(parent)
      }
      continue
    }
    const bucket = childrenOf.get(parent)
    if (bucket === undefined) childrenOf.set(parent, [entry])
    else bucket.push(entry)
  }

  const roots = sortNodes(rootEntries.map((entry) => toNode(entry, (id) => childrenOf.get(id) ?? [], new Set())))

  const buckets = new Map<string, WorldTreeEntry[]>()
  for (const entry of entries) {
    const key = categoryKeyOf(entry)
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [entry])
    else bucket.push(entry)
  }

  const groups: WorldTreeGroup[] = []
  for (const [key, bucket] of buckets) {
    const localChildren = new Map<string, WorldTreeEntry[]>()
    const nested = new Set<string>()
    for (const entry of bucket) {
      const parent = entry.parent === undefined ? undefined : byId.get(entry.parent)
      if (parent === undefined || categoryKeyOf(parent) !== key || parent.id === entry.id) continue
      const siblings = localChildren.get(parent.id)
      if (siblings === undefined) localChildren.set(parent.id, [entry])
      else siblings.push(entry)
      nested.add(entry.id)
    }
    const tops = bucket.filter((entry) => !nested.has(entry.id))
    const nodes = tops.map((entry) => toNode(entry, (id) => localChildren.get(id) ?? [], new Set()))
    groups.push({ category: key === '' ? null : key, nodes: sortNodes(nodes) })
  }

  groups.sort((left, right) => {
    // Uncategorised last: it is the leftover bucket, not a category.
    if (left.category === null) return right.category === null ? 0 : 1
    if (right.category === null) return -1
    return compareText(left.category, right.category)
  })

  return { roots, groups, danglingParents: dangling.sort(compareText) }
}
