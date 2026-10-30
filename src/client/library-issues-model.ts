/**
 * The setting library's problem list: `validation_issues` grouped by code, with labels.
 *
 * WHY IT IS A FILE: the codes and their Chinese labels (fifty-odd of them) and the grouping
 * that turns a flat wire list into counted groups are one conversation — "what is wrong in
 * this book" — and they sat in the middle of `library-model.ts` between the tree and the
 * editor. The list is deliberately partial: an unknown code is shown verbatim rather than
 * folded into "其他问题", so this file is also where that decision is recorded.
 */

import type { LibraryIssuesValue } from './library-tree-model.js'
import { asRecord, optionalString } from './library-tree-model.js'

/**
 * Wording for the validation codes the index records (`validation_issues`). The list is deliberately
 * partial: an unknown code is shown VERBATIM rather than folded into "其他问题", because a code the
 * panel does not know is still the most useful thing on the row (the author pastes it into an issue).
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
  // These two families' codes are the ones the Host actually emits: before that the panel printed
  // them verbatim (`FACT_CONFLICT`), which reads as a bug report rather than as a problem in the book.
  // `FORESHADOW_OVERDUE` / `FORESHADOW_DUE_NOW` are the audit's two lateness codes (data-model §5).
  FORESHADOW_RESOLVED_WITHOUT_CHAPTER: '伏笔标了已回收但没写回收章',
  FORESHADOW_TRANSITION_INVALID: '伏笔状态与历史字段矛盾',
  FORESHADOW_OVERDUE: '伏笔已超期未回收',
  FORESHADOW_DUE_NOW: '伏笔正好本期到期',
  FACT_LINE_MALFORMED: '账本行写不成一条事实',
  FACT_CONFLICT: '账本同一属性前后矛盾',
  RELATION_FIELD_DEPRECATED: '关系文件用了废弃字段',
  RELATION_PERIOD_CONFLICT: '关系时段互相矛盾',
  RELATION_PERIOD_UNCOMPARABLE: '关系时段无法按章序判定',
  ID_PATH_DIVERGED: '实体 id 是改名前的老路径',
  CATALOG_STALE: '卷章目录与正文不一致',
  CATALOG_DUPLICATE: '同一章出现在两条目录项',
  VOLUME_DIR_MISMATCH: '卷目录名与卷 id 不符',
  CHAPTER_FILE_MISSING: '目录引用的章文件不存在',
  FILE_UNREADABLE: '文件读不出来',
}

/** A code's label, or the code itself (see `ISSUE_LABELS`). */
export function describeIssueCode(code: string): string {
  return ISSUE_LABELS[code] ?? code
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
