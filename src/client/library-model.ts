/**
 * Pure view model for the setting-library tab (issue #30, roadmap X-7).
 *
 * Everything here is a plain function over plain data, for the same reason
 * `panel-model.ts` is: `node --test` has no DOM, so the React View is only
 * checked as a built bundle while the grouping rules are tested directly.
 *
 * Two shapes from the private channel feed this file:
 *   * `GET /inkflow/internal/library` — eight kind groups (X-7: `CONTENT_DIRS`
 *     minus `chapters`), where `world` also carries its `category` buckets.
 *     `indexAvailable: false` means the Host could not read the derived index:
 *     that is "cannot answer", NOT "the book has no characters".
 *   * `GET /inkflow/internal/library/issues` — a flat `validation_issues` list.
 *     Grouping by `code` happens here because it is presentation; the wire stays
 *     flat so the Host never has to guess a label.
 *
 * The editor adds a third: the detail payload (`fingerprint` included) and the
 * `POST /library/item` body it becomes — the field sets per kind, "what changed"
 * and the CAS baseline all live here (see the editor section at the end).
 *
 * No IO, no React, no `@deepseek-ai/*` import (ADR-0008 D4/V7).
 */

import { describeTooLarge } from './error-text.js'
import type { InternalError, InternalResult } from './internal.js'

/** The one kind whose rows are grouped by `category` — 地点 is a bucket, not a kind. */
export const WORLD_KIND = 'world'

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

/**
 * Wording for the validation codes the index records (`validation_issues`).
 *
 * The list is deliberately partial: an unknown code is shown VERBATIM rather
 * than folded into "其他问题", because a code the panel does not know is still
 * the most useful thing on the row (it is what the author pastes into an issue).
 */
export const ISSUE_LABELS: Record<string, string> = {
  FRONTMATTER_ISSUE: 'frontmatter 解析问题',
  DUPLICATE_ID: '实体 id 重复',
  DANGLING_PARENT: 'parent 指向不存在的实体',
  ENTITIES_DRIFT: '投影与域表不一致',
  CHARACTER_NAME_DUPLICATE: '角色名重复',
  CHARACTER_NAME_REQUIRED: '角色缺名字',
  CHARACTER_ALIAS_DUPLICATE: '角色别名重复',
  CHAPTER_NOT_MARKDOWN: '章文件不是 Markdown',
  CHAPTER_INVALID: '章文件不合法',
  OUTLINE_NO_OVERALL: '缺整体大纲',
  OUTLINE_MULTIPLE_OVERALL: '整体大纲不唯一',
  OUTLINE_VOLUME_IN_VOLUME: '卷中卷',
  OUTLINE_CHAPTER_IN_CHAPTER: '章中章',
  OUTLINE_KIND_UNKNOWN: '大纲层级不明',
  OUTLINE_VOLUME_PARENT: '卷大纲挂错父节点',
  WORLD_ROOT_MISSING: '缺世界观根条目',
  WORLD_ROOT_MULTIPLE: '世界观根条目不唯一',
  WORLD_CATEGORY_REQUIRED: '世界观条目缺分类',
  RELATION_ENDPOINT: '关系端点不存在',
  RELATION_SELF_LOOP: '关系自环',
  RELATION_DUPLICATE: '关系重复',
  TIMELINE_TIME_MISSING: '时间线事件缺时间',
  TIMELINE_TIME_INVALID: '时间线时间不合法',
  TIMELINE_TIME_REVERSED: '世界时间倒流',
  TIMELINE_ORDER_CONFLICT: '叙事次序冲突',
  FILE_UNREADABLE: '文件读不出来',
}

/** A code's label, or the code itself (see `ISSUE_LABELS`). */
export function describeIssueCode(code: string): string {
  return ISSUE_LABELS[code] ?? code
}

// ---------------------------------------------------------------------------
// Shape readers: the panel drops what it cannot name instead of rendering holes
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function optionalString(value: unknown): string | null {
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
 * Group world rows by `category`, named categories first (storage order kept),
 * the uncategorised rows last.
 *
 * Exported because it is the one rule X-7 is about: 地点 is a `world` category,
 * so this function — not a kind table — decides what the tree shows underneath
 * 世界观. It also runs on rows alone, so the panel still groups correctly if a
 * future Host payload drops the precomputed `categories`.
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
 * The eight-kind tree, kept as a tree.
 *
 * The Host lists the kinds in `CONTENT_DIRS` order and each kind's rows in the
 * projection's order, so this only normalises shapes: a group with no items is
 * kept, because "这一库还是空的" is an editorial state the author needs to see
 * (and, for 伏笔/账本/资料, it may also mean the projection for that directory
 * has not landed yet — the tab says so in one muted line instead of pretending).
 */
export function buildLibraryTree(value: LibraryValue | null): LibraryTree {
  if (value === null) return { groups: [], total: 0, indexAvailable: true }
  const groups: LibraryKindGroup[] = []
  for (const raw of Array.isArray(value.kinds) ? value.kinds : []) {
    const record = asRecord(raw)
    if (record === undefined) continue
    const kind = optionalString(record['kind'])
    if (kind === null) continue
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
 * The row behind a `validation_issues` path, if this tree holds it.
 *
 * The problem panel jumps to an entry by switching the selection, so it needs
 * the `(kind, id)` the detail route asks for. A path outside the eight kinds
 * (a chapter, an `inkflow.json`) simply has no row: the panel then shows the
 * issue without a jump target rather than guessing one.
 */
export function findItemByPath(tree: LibraryTree, path: string | null): LibraryTreeItem | undefined {
  if (path === null || path === '') return undefined
  const needle = path.replaceAll('\\', '/')
  return flattenLibrary(tree).find((item) => item.path.replaceAll('\\', '/') === needle)
}

// ---------------------------------------------------------------------------
// The problem panel: `validation_issues` grouped by code
// ---------------------------------------------------------------------------

export interface LibraryIssue {
  code: string
  path: string | null
  detail: string
}

export interface IssueGroup {
  code: string
  label: string
  total: number
  items: LibraryIssue[]
}

export interface IssueDigest {
  groups: IssueGroup[]
  total: number
  truncated: boolean
  /** `false` = the index could not answer; an empty list would be a false all-clear. */
  available: boolean
}

function asIssue(value: unknown): LibraryIssue | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const code = optionalString(record['code'])
  if (code === null) return undefined
  return {
    code,
    path: optionalString(record['path']),
    detail: typeof record['detail'] === 'string' ? record['detail'] : '',
  }
}

/**
 * Group the flat issue list by `code`, biggest group first then by code.
 *
 * Order matters more than it looks: the author fixes the cause with the most
 * rows first, and a tie broken by code keeps the panel identical between two
 * refreshes (an unstable order reads as "something changed").
 */
export function aggregateIssues(value: LibraryIssuesValue | null): IssueDigest {
  if (value === null) return { groups: [], total: 0, truncated: false, available: true }
  const issues: LibraryIssue[] = []
  for (const raw of Array.isArray(value.issues) ? value.issues : []) {
    const issue = asIssue(raw)
    if (issue !== undefined) issues.push(issue)
  }
  const buckets = new Map<string, LibraryIssue[]>()
  for (const issue of issues) {
    const bucket = buckets.get(issue.code)
    if (bucket === undefined) buckets.set(issue.code, [issue])
    else bucket.push(issue)
  }
  const groups: IssueGroup[] = [...buckets.entries()].map(([code, rows]) => ({
    code,
    label: describeIssueCode(code),
    total: rows.length,
    items: rows,
  }))
  groups.sort((left, right) => (right.total === left.total ? (left.code < right.code ? -1 : 1) : right.total - left.total))
  return {
    groups,
    total: issues.length,
    truncated: value.truncated === true,
    available: value.available !== false,
  }
}

/** One row of the problem panel: `DUPLICATE_ID · characters/甲.md`. */
export function describeIssueRow(issue: LibraryIssue): string {
  return issue.path === null ? describeIssueCode(issue.code) : `${describeIssueCode(issue.code)} · ${issue.path}`
}

// ---------------------------------------------------------------------------
// The editor (issue #30, second batch)
//
// The Host owns the file format; this half owns "which fields a kind shows" and
// "what the save sends". Both are pure functions over plain data — `node --test`
// has no DOM, so the rules are tested here and the View only wires them up.
//
// Two rules the payload obeys, because they are what keeps a save honest:
//   * only the fields the author CHANGED are sent — an untouched line must not be
//     rewritten (it would show up as a git diff the author did not make);
//   * a key the form does not know is never sent, so the Host's line-level patch
//     leaves it exactly as it was (`id`, `tags`, `origin`, …).
// ---------------------------------------------------------------------------

/** How a frontmatter field is edited. */
export type LibraryFieldType = 'text' | 'number' | 'boolean' | 'list'

export interface LibraryFieldSpec {
  readonly key: string
  readonly label: string
  readonly type: LibraryFieldType
}

/**
 * The common field set per kind — the fields the author edits by hand.
 *
 * Field names and types come from the data model (`.agents/specs/data-model.md`
 * §3.1–§3.6), not from a per-kind guess; `id` is deliberately absent (it is the
 * address the tree and this editor both use) and so are nested maps like
 * `origin`, which frontmatter cannot represent.
 */
export const KIND_FIELDS: Record<string, readonly LibraryFieldSpec[]> = {
  characters: [
    { key: 'name', label: '角色名', type: 'text' },
    { key: 'aliases', label: '别名', type: 'list' },
    { key: 'group', label: '分组', type: 'text' },
    { key: 'role', label: '定位', type: 'text' },
    { key: 'pov', label: '视角', type: 'text' },
    { key: 'firstAppearance', label: '首次出场', type: 'text' },
    { key: 'voice', label: '口吻', type: 'text' },
  ],
  world: [
    { key: 'title', label: '名称', type: 'text' },
    { key: 'category', label: '分类', type: 'text' },
    { key: 'parent', label: '上级', type: 'text' },
    { key: 'keywords', label: '触发词', type: 'list' },
    { key: 'always', label: '常驻注入', type: 'boolean' },
    { key: 'priority', label: '优先级', type: 'number' },
  ],
  outlines: [
    { key: 'kind', label: '层级', type: 'text' },
    { key: 'title', label: '标题', type: 'text' },
    { key: 'parent', label: '上级', type: 'text' },
    { key: 'order', label: '次序', type: 'number' },
  ],
  relations: [
    { key: 'source', label: '起点', type: 'text' },
    { key: 'target', label: '终点', type: 'text' },
    { key: 'dir', label: '方向', type: 'text' },
    { key: 'since', label: '起始', type: 'text' },
    { key: 'until', label: '终止', type: 'text' },
    { key: 'chapter', label: '章节', type: 'text' },
  ],
  timeline: [
    { key: 'title', label: '事件', type: 'text' },
    { key: 'worldTime', label: '世界时间', type: 'text' },
    { key: 'narrativeOrder', label: '叙事顺序', type: 'number' },
    { key: 'chapterId', label: '章节', type: 'text' },
    { key: 'participants', label: '参与者', type: 'list' },
    { key: 'status', label: '状态', type: 'text' },
  ],
  foreshadowing: [
    { key: 'title', label: '伏笔名', type: 'text' },
    { key: 'status', label: '状态', type: 'text' },
    { key: 'plantedAt', label: '埋设位置', type: 'text' },
    { key: 'advancedAt', label: '推进位置', type: 'list' },
    { key: 'resolved', label: '已回收', type: 'boolean' },
    { key: 'resolvedChapter', label: '回收章', type: 'text' },
    { key: 'dueBy', label: '期望回收', type: 'text' },
    { key: 'linkedEntities', label: '相关条目', type: 'list' },
    { key: 'notes', label: '备注', type: 'text' },
  ],
  facts: [
    { key: 'subject', label: '主体', type: 'text' },
    { key: 'attribute', label: '维度', type: 'text' },
    { key: 'value', label: '当前值', type: 'text' },
    { key: 'since', label: '生效', type: 'text' },
    { key: 'until', label: '失效', type: 'text' },
    { key: 'chapterId', label: '登记章', type: 'text' },
    { key: 'source', label: '来源', type: 'text' },
    { key: 'conflictsWith', label: '冲突事实', type: 'list' },
  ],
  library: [
    { key: 'title', label: '资料名', type: 'text' },
    { key: 'source', label: '来源', type: 'text' },
    { key: 'license', label: '许可', type: 'text' },
    { key: 'sha256', label: '原文哈希', type: 'text' },
    { key: 'mode', label: '保存方式', type: 'text' },
  ],
}

/** The editable fields of one kind; an unknown kind has none (its body is still editable). */
export function fieldsForKind(kind: string): readonly LibraryFieldSpec[] {
  return KIND_FIELDS[kind] ?? []
}

/** How a value is shown in the form: one item per line for a list, `true`/`false` for a boolean. */
function fieldText(spec: LibraryFieldSpec, value: unknown): string {
  if (spec.type === 'boolean') {
    if (value === true || value === 'true') return 'true'
    if (value === false || value === 'false') return 'false'
    return ''
  }
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : typeof item === 'number' ? String(item) : ''))
      .filter((item) => item !== '')
      .join('\n')
  }
  return ''
}

/**
 * What the author is editing: one string per field plus the prose.
 *
 * A list is edited one item per line and a boolean is `'true'`/`'false'` (the
 * checkbox state) — one shape for the form, converted back on save.
 */
export interface LibraryDraft {
  values: Record<string, string>
  body: string
}

export function draftFromItem(kind: string, frontmatter: Record<string, unknown>, body: string): LibraryDraft {
  const values: Record<string, string> = {}
  for (const spec of fieldsForKind(kind)) values[spec.key] = fieldText(spec, frontmatter[spec.key])
  return { values, body }
}

/**
 * The keys the form does not know, in file order.
 *
 * They are shown read-only and are NOT part of the payload: the Host patches the
 * file line by line, so an untouched key survives byte for byte (that is what
 * keeps `id`, `tags`, `origin` and this plugin's future fields from being eaten
 * by an editor that does not understand them yet).
 */
export function unknownFields(kind: string, frontmatter: Record<string, unknown>): Array<[string, unknown]> {
  const known = new Set(fieldsForKind(kind).map((spec) => spec.key))
  return Object.entries(frontmatter).filter(([key]) => !known.has(key))
}

/** The body of `POST /library/item`: only what changed. */
export interface LibrarySavePayload {
  frontmatter: Record<string, unknown>
  body?: string
}

/** One form value → the JSON value the Host writes (`null` deletes, `[]` deletes a list). */
function payloadValue(spec: LibraryFieldSpec, text: string): unknown {
  if (spec.type === 'boolean') return text === 'true'
  if (spec.type === 'list') {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
  }
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (spec.type === 'number') {
    // Text typed into a number field is sent as text: refusing the save would be
    // worse than storing exactly what the author wrote, and the Host writes it
    // back as a plain scalar either way.
    const numeric = Number(trimmed)
    return Number.isFinite(numeric) ? numeric : trimmed
  }
  return trimmed
}

/**
 * The save payload, or `null` when nothing changed.
 *
 * `null` is the "no edits" answer the View uses to skip a pointless round trip;
 * the Host answers the same request with `400 EMPTY_UPDATE`.
 */
export function draftPayload(
  kind: string,
  draft: LibraryDraft,
  frontmatter: Record<string, unknown>,
  body: string,
): LibrarySavePayload | null {
  const changed: Record<string, unknown> = {}
  for (const spec of fieldsForKind(kind)) {
    const next = draft.values[spec.key] ?? ''
    if (next === fieldText(spec, frontmatter[spec.key])) continue
    changed[spec.key] = payloadValue(spec, next)
  }
  const payload: LibrarySavePayload = { frontmatter: changed }
  if (draft.body !== body) payload.body = draft.body
  return Object.keys(changed).length === 0 && payload.body === undefined ? null : payload
}

/** The CAS baseline a detail answer carries, or `null` when it has none. */
export function fingerprintOf(value: LibraryItemValue | null | undefined): LibraryFingerprint | null {
  const fingerprint = value?.fingerprint
  if (fingerprint === undefined || fingerprint === null) return null
  if (typeof fingerprint.sha256 !== 'string' || fingerprint.sha256 === '') return null
  return fingerprint
}

// ---------------------------------------------------------------------------
// State wording: every card the tab can show instead of a blank area
// ---------------------------------------------------------------------------

export const LIBRARY_EMPTY = {
  'no-items': {
    title: '设定库还没有条目',
    body: '八个目录（角色 / 世界观 / 大纲 / 伏笔 / 时间线 / 关系 / 事实账本 / 资料）都还是空的。让 AI 用 inkflow_* 工具建条目，或直接在对应目录里写带 frontmatter 的 Markdown，面板会按类显示。',
  },
  'no-selection': {
    title: '选择一条查看',
    body: '左栏点开一类，再点一条：右栏显示这条的详情（frontmatter 与正文），点「编辑」可以改常见字段和正文，保存时带基线指纹，磁盘上被改过就拒绝覆盖。',
  },
  'no-issues': {
    title: '没有记录到问题',
    body: '派生索引重建时没有记下 validation_issues：frontmatter、id 重复、层级、端点这些校验都通过了。',
  },
  'index-unavailable': {
    title: '索引不可用',
    body: '派生索引不存在、读不出来，或由别的 schema 版本建的，所以这一类暂时无法回答（不是「书里没有」）。让 AI 跑 inkflow_index_rebuild 后重开面板。',
  },
  'no-projection': {
    title: '',
    body: '空的这一类也可能是「还没有进索引投影」：伏笔 / 事实账本 / 资料 的实体随后续版本进入投影，文件本身已经在目录里。',
  },
} as const

export type LibraryEmptyKind = keyof typeof LIBRARY_EMPTY

/** The hint under the tree: counts, plus one line about why some kinds are empty. */
export function describeLibraryFacts(tree: LibraryTree): string {
  if (!tree.indexAvailable) return '索引 不可用 · 八类无法回答'
  const filled = tree.groups.filter((group) => group.items.length > 0).length
  return `索引 可用 · ${filled}/${tree.groups.length} 类有条目 · 共 ${tree.total} 条`
}

/** Message for a failed library call: the Host's own words beat a bare code. */
export function describeLibraryError(error: InternalError | undefined): string {
  if (error === undefined) return '设定库通道没有返回内容'
  if (error.code === 'INDEX_UNAVAILABLE') return LIBRARY_EMPTY['index-unavailable'].body
  if (error.code === 'library-item-not-found') return '这一条在索引里找不到了，可能已被改名或删除（刷新后重查）'
  if (error.code === 'KIND_INVALID' || error.code === 'KIND_REQUIRED') return '请求里缺少或写错了类别（面板内部错误）'
  return error.message ?? error.code
}

/** Message for a failed save: a 409 says the file moved, everything else is the Host's own text. */
export function describeSaveError(error: InternalError | undefined): string {
  if (error === undefined) return '保存没有返回内容'
  // Same reason as the chapter editor (issue 115): a refusal that carries a size
  // must say the size, or the author only sees "保存失败" and no next step.
  const tooLarge = describeTooLarge(error)
  if (tooLarge !== null) return tooLarge
  if (error.code === 'FILE_CHANGED') {
    return '文件已被改动：磁盘上的内容已经不是这次加载的版本，所以这次没有写入任何字节。'
  }
  if (error.code === 'library-item-not-found') return '这一条在目录里找不到了：可能已被改名或删除。'
  if (error.code === 'CHAPTER_AMBIGUOUS') {
    // The write route resolves a chapter by id and demands uniqueness: two files
    // sharing one `id:` make the chapter unsavable, and the Host's own words are
    // an English sentence with a path in it.
    return '这个 id 被两章共用，写路径无法确定改哪一章：请给其中一章换一个 id 后再保存。'
  }
  if (error.code === 'PATH_OUT_OF_SCOPE') return '这个 id 会逃出它的内容目录，已拒绝。'
  if (error.code === 'EXPECTED_REQUIRED') return '保存缺少基线指纹（面板内部错误），重新加载这一条后再改。'
  if (error.code === 'EXPECTED_INVALID') return '基线指纹格式不对（面板内部错误），重新加载这一条后再改。'
  if (error.code === 'BODY_INVALID') return '正文里有无法保存为 UTF-8 的字符。'
  if (error.code === 'FRONTMATTER_INVALID' || error.code === 'FRONTMATTER_VALUE_INVALID') {
    return '这个字段的值不能写进 frontmatter（嵌套结构或换行）。'
  }
  if (error.code === 'EMPTY_UPDATE') return '这次没有改动。'
  return error.message ?? error.code
}

/**
 * What to say after a save that changed the file but could not rebuild the index.
 *
 * The save itself is `ok`, so this is a notice, not an error: the file is right
 * and the tree is stale until the index is rebuilt.
 */
export function describeIndexWarning(value: LibraryItemValue | null | undefined): string | null {
  const error = value?.indexError
  if (error === undefined) return null
  return `已保存，但派生索引没能重建（${error.code ?? 'INDEX_UNAVAILABLE'}）：左栏与详情暂时还是旧值，跑一次 inkflow_index_rebuild 即可。`
}

/** `data` for a loaded-but-refused result: keeps the panel on its structured cards. */
export function libraryErrorOf(result: InternalResult<unknown> | null): InternalError | undefined {
  if (result === null || result.ok) return undefined
  return result.error
}
