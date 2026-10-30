/**
 * The setting library's wire shapes, its kind labels and the tree they are folded into.
 *
 * WHY IT IS A FILE: `library-model.ts` was 812 lines of four different jobs — reading the
 * payload, grouping the problem list, editing one entry, and wording every empty state and
 * refusal. They are read by different questions, so a reader looking for "how is the tree
 * built" scrolled past the editor and the save payload. This is the reading half: what the
 * Host sends, what a row is, and the one function that groups rows into the tree.
 *
 * It is also the types leaf of the group: the other three import `LibraryItemValue` /
 * `LibraryIssuesValue` from here (never from each other), so the graph stays acyclic.
 * No IO, no React, no `@deepseek-ai/*` import (ADR-0008 D4/V7).
 */

/** The one kind whose rows are grouped by `category` — 地点 is a bucket, not a kind. */
export const WORLD_KIND = 'world'

/**
 * The kinds this tree renders.
 *
 * 大纲 / 伏笔 / 时间线 were MOVED out, not removed: each has a tab with its own reading
 * order and its own write. The wire is untouched on purpose — `GET /library` still answers
 * all eight groups, because the outline page reads its own group from that payload and
 * every jump resolves an address by `kind`. A kind outside this list is skipped here.
 */
export const SETTINGS_LIBRARY_KINDS = ['characters', 'world', 'relations', 'facts', 'library'] as const

/** Row shape the Host sends per kind (`LibraryItemRow` on the Host side). */
export interface LibraryItem {
  id: string
  path: string
  title: string
  category: string | null
  parent: string | null
  status: string | null
}

/** One row as the tree holds it: the item plus the kind it came from. */
export interface LibraryTreeItem extends LibraryItem {
  kind: string
}

export interface LibraryCategoryGroup {
  /** `null` = a file written directly under `world/` (a real state, not an error). */
  category: string | null
  label: string
  total: number
  items: LibraryTreeItem[]
}

export interface LibraryKindGroup {
  kind: string
  label: string
  total: number
  /** The Host reached its per-kind row cap: the list is short, not the book. */
  truncated: boolean
  items: LibraryTreeItem[]
  /** Filled for `world` only; every other kind is a flat list. */
  categories: LibraryCategoryGroup[]
}

export interface LibraryTree {
  groups: LibraryKindGroup[]
  total: number
  /** `false` = the derived index could not answer (`INDEX_UNAVAILABLE`). */
  indexAvailable: boolean
}

/**
 * "Open this entry for me" — a request from another page (an audit row, a search hit, a
 * problem row), not state the library owns.
 *
 * `nonce` exists because a second click on the *same* address must re-focus the same row:
 * without it React sees an equal prop and skips the effect, so the second click would look
 * dead. The library never stores the nonce; it only uses it to tell "same request again"
 * from "no request".
 */
export interface LibraryFocus {
  kind: string
  /** The entity id, when the caller has one (an audit finding, a search hit). */
  id?: string
  /** The project-relative file, when the caller has that instead (a `validation_issues` row). */
  path?: string
  nonce: number
}

/** The row a focus request names, found in the tree the panel already built (by id). */
export function findFocusItem(tree: LibraryTree, focus: LibraryFocus | null | undefined): LibraryTreeItem | undefined {
  if (focus === null || focus === undefined || focus.id === undefined) return undefined
  for (const group of tree.groups) {
    if (group.kind !== focus.kind) continue
    const direct = group.items.find((item) => item.id === focus.id)
    if (direct !== undefined) return direct
    for (const category of group.categories) {
      const item = category.items.find((candidate) => candidate.id === focus.id)
      if (item !== undefined) return item
    }
  }
  return undefined
}

/** `GET /inkflow/internal/library` → `value` (only what the panel reads). */
export interface LibraryValue {
  indexAvailable?: boolean
  total?: number
  kinds?: unknown[]
  indexState?: string
  indexError?: { code?: string; message?: string }
}

/** `GET /inkflow/internal/library/item` → `value`. */
export interface LibraryItemValue {
  kind?: string
  id?: string
  path?: string
  title?: string
  entity?: Record<string, unknown>
  readable?: boolean
  hasFrontmatter?: boolean
  frontmatter?: Record<string, unknown>
  body?: string
  bodyChars?: number
  issues?: unknown[]
  validationIssues?: unknown[]
  /** CAS baseline of the bytes on disk: what the save sends back as `expected`. */
  fingerprint?: LibraryFingerprint | null
  /** Present on a save when the derived index could not be rebuilt afterwards. */
  indexError?: { code?: string; message?: string }
  indexRebuilt?: boolean
  /** The freshness verdict after a write (`fresh` / `stale` / `missing` / `incompatible`). */
  indexState?: string
  readError?: { code?: string; message?: string }
}

/** The baseline one file is written against (Host `FileFingerprint`). */
export interface LibraryFingerprint {
  size: number
  mtimeMs: number
  sha256: string
}

/** `GET /inkflow/internal/library/issues` → `value`. */
export interface LibraryIssuesValue {
  available?: boolean
  total?: number
  truncated?: boolean
  countsByCode?: Record<string, number>
  issues?: unknown[]
}

/**
 * Chinese labels for the eight kinds (X-7). The Host sends kind names — the
 * directory names are the contract, so the label belongs to the reader's side.
 */
export const KIND_LABELS: Record<string, string> = {
  characters: '角色',
  world: '世界观',
  outlines: '大纲',
  foreshadowing: '伏笔',
  timeline: '时间线',
  relations: '关系',
  facts: '事实账本',
  library: '资料',
}

export const UNCATEGORIZED_LABEL = '未分类'

/** A kind's label, or the kind itself when it is one this build does not know. */
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

// ---------------------------------------------------------------------------
// Shape readers: the panel drops what it cannot name instead of rendering holes
//
// `asRecord` / `optionalString` are exported because `impact-model.ts` folds the
// same Host payloads and must drop malformed rows the same way — one rule, two
// models, instead of a second copy that drifts.
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

export function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function asItem(value: unknown, kind: string): LibraryTreeItem | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const id = optionalString(record['id'])
  if (id === null) return undefined
  return {
    kind,
    id,
    path: optionalString(record['path']) ?? id,
    title: optionalString(record['title']) ?? id,
    category: optionalString(record['category']),
    parent: optionalString(record['parent']),
    status: optionalString(record['status']),
  }
}

function asItems(value: unknown, kind: string): LibraryTreeItem[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => asItem(entry, kind)).filter((item): item is LibraryTreeItem => item !== undefined)
}

/**
 * Group world rows by `category`, named categories first (storage order kept), the
 * uncategorised rows last. Exported because it is the one rule X-7 is about: 地点 is a
 * `world` category, so this — not a kind table — decides what shows under 世界观. It runs
 * on rows alone too, so the panel still groups if a payload drops `categories`.
 */
export function groupByCategory(items: readonly LibraryTreeItem[]): LibraryCategoryGroup[] {
  const buckets = new Map<string, LibraryTreeItem[]>()
  for (const item of items) {
    const key = item.category ?? ''
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [item])
    else bucket.push(item)
  }
  const named = [...buckets.keys()].filter((key) => key !== '')
  const keys = buckets.has('') ? [...named, ''] : named
  return keys.map((key) => {
    const rows = buckets.get(key) ?? []
    return {
      category: key === '' ? null : key,
      label: key === '' ? UNCATEGORIZED_LABEL : key,
      total: rows.length,
      items: rows,
    }
  })
}

function asCategories(value: unknown, items: readonly LibraryTreeItem[]): LibraryCategoryGroup[] {
  if (!Array.isArray(value)) return groupByCategory(items)
  const groups: LibraryCategoryGroup[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (record === undefined) continue
    const category = optionalString(record['category'])
    const rows = asItems(record['items'], WORLD_KIND)
    groups.push({
      category,
      label: category ?? UNCATEGORIZED_LABEL,
      total: typeof record['total'] === 'number' ? record['total'] : rows.length,
      items: rows,
    })
  }
  return groups.length === 0 ? groupByCategory(items) : groups
}

/**
 * The tree this page renders: `SETTINGS_LIBRARY_KINDS` out of the eight the Host answers.
 * Shapes are normalised, order is kept, the three groups that own a page are dropped, and a
 * group with no items IS kept: "这一库还是空的" is an editorial state the author needs to see
 * (for 账本/资料 it may also mean the projection has not landed yet).
 */
export function buildLibraryTree(value: LibraryValue | null): LibraryTree {
  if (value === null) return { groups: [], total: 0, indexAvailable: true }
  const groups: LibraryKindGroup[] = []
  for (const raw of Array.isArray(value.kinds) ? value.kinds : []) {
    const record = asRecord(raw)
    if (record === undefined) continue
    const kind = optionalString(record['kind'])
    if (kind === null || !(SETTINGS_LIBRARY_KINDS as readonly string[]).includes(kind)) continue
    const items = asItems(record['items'], kind)
    groups.push({
      kind,
      label: kindLabel(kind),
      total: typeof record['total'] === 'number' ? record['total'] : items.length,
      truncated: record['truncated'] === true,
      items,
      categories: kind === WORLD_KIND ? asCategories(record['categories'], items) : [],
    })
  }
  return {
    groups,
    total: groups.reduce((sum, group) => sum + group.items.length, 0),
    indexAvailable: value.indexAvailable !== false,
  }
}

/** Every row of the tree in display order — what a search box would filter. */
export function flattenLibrary(tree: LibraryTree): LibraryTreeItem[] {
  return tree.groups.flatMap((group) => group.items)
}

/**
 * The row behind a `validation_issues` path, if this tree holds it — the `(kind, id)` the
 * detail route asks for. A path this page does not list (a chapter, an `inkflow.json`, or
 * one of the three kinds that own a page) has no row here: the panel then hands the path to
 * `movedKindOf` or shows the issue with no target, never a guess.
 */
export function findItemByPath(tree: LibraryTree, path: string | null): LibraryTreeItem | undefined {
  if (path === null || path === '') return undefined
  const needle = path.replaceAll('\\', '/')
  return flattenLibrary(tree).find((item) => item.path.replaceAll('\\', '/') === needle)
}
