/**
 * The one shape a "problem" has, shared by the audit report (#33) and the repair
 * pass (#36) — roadmap X-14.
 *
 * Why this exists as its own module: the index already reports problems, but as
 * `validation_issues { code, path, detail }` — enough for a rebuild log, not enough
 * for a report a person reads or for a repair pass that has to fix exactly one
 * thing and prove it is gone. Without a shared shape the two halves would invent
 * two vocabularies, and a code emitted by the audit would be unrunnable by the
 * repairer (or, worse, two codes would mean the same thing).
 *
 * What lives here is deliberately small: the types, the five report groups, and the
 * code catalogue (`FINDING_CODES`). It has **no** check implementations and no
 * filesystem access — #33 produces findings, #36 consumes them, and both take their
 * vocabulary from this file. The catalogue is asserted against
 * [data-model §5](../../.agents/specs/data-model.md) by `tests/findings.test.js`, so
 * a code cannot exist in code and be missing from the invariant table (or the other
 * way round) without a test turning red.
 */

import type { ContentDir } from './conventions.js'

export type { ContentDir }

/** How loudly a finding is reported. `blocking` only ever comes from a write. */
export type FindingSeverity = 'blocking' | 'warning' | 'info'

/**
 * Where a finding points. Exactly one of these shapes, and never a free-form path
 * the caller supplies: a locator is built from an address the index already holds
 * (an entity id, a chapter id) or from a project-relative path the scan produced.
 *
 * `line` is 1-based and only meaningful for findings inside a file's body (a fact
 * ledger line, a frontmatter line). A locator with a line is only valid within the
 * session that produced it — the line moves when the file is edited, which is why
 * the repair pass re-runs its checks afterwards instead of trusting the locator.
 */
export type FindingLocator =
  | { readonly kind: 'entity'; readonly entityKind: ContentDir; readonly id: string }
  | { readonly kind: 'path'; readonly path: string; readonly line?: number }
  | { readonly kind: 'chapter'; readonly chapterId: string }
  | { readonly kind: 'catalog'; readonly volumeId?: string }

/** The five check families the report groups by (issue #33's 范围). */
export const FINDING_GROUPS = ['structure', 'ledger', 'foreshadow', 'timeline', 'catalog'] as const
export type FindingGroup = (typeof FINDING_GROUPS)[number]

export interface Finding {
  /** One of `FINDING_CODES`; never free text. */
  readonly code: string
  readonly group: FindingGroup
  readonly severity: FindingSeverity
  readonly locator: FindingLocator
  /** What is wrong, in one sentence, naming the concrete values. */
  readonly detail: string
  /** What to do about it — the repair hint a person reads. */
  readonly hint: string
  /** Whether #36 has a repair action for this code. */
  readonly fixable: boolean
}

export interface FindingCodeSpec {
  readonly code: string
  readonly group: FindingGroup
  /**
   * Whether the repair pass can fix it automatically.
   *
   * `false` is not a gap to be filled later for every code: a dangling relation
   * endpoint, for example, cannot be fixed by inventing an entity, and pretending
   * otherwise would make "一键修复" a data-loss button.
   */
  readonly fixable: boolean
  /** One-line meaning, kept in sync with data-model §5's invariant row. */
  readonly meaning: string
}

/**
 * The closed vocabulary of finding codes.
 *
 * Adding one means adding it **in the same commit** to
 * [data-model §5](../../.agents/specs/data-model.md) (X-14) — the test pins both
 * directions so neither can drift.
 */
export const FINDING_CODES: readonly FindingCodeSpec[] = [
  // structure — tree/graph integrity (data-model I-01…I-08, I-10, I-15, I-20)
  { code: 'OUTLINE_NO_OVERALL', group: 'structure', fixable: false, meaning: '缺少唯一的 overall 大纲' },
  { code: 'OUTLINE_MULTIPLE_OVERALL', group: 'structure', fixable: false, meaning: '存在多份 overall 大纲' },
  { code: 'OUTLINE_VOLUME_PARENT', group: 'structure', fixable: true, meaning: '卷大纲挂错父节点（应挂 overall）' },
  { code: 'OUTLINE_VOLUME_IN_VOLUME', group: 'structure', fixable: true, meaning: '卷大纲挂在卷纲之下（不支持卷中卷）' },
  { code: 'OUTLINE_CHAPTER_IN_CHAPTER', group: 'structure', fixable: true, meaning: '章纲挂在章纲之下（超过三层）' },
  { code: 'CHARACTER_NAME_DUPLICATE', group: 'structure', fixable: false, meaning: '角色名（归一化后）重复' },
  { code: 'DUPLICATE_ID', group: 'structure', fixable: false, meaning: '同一 kind 内 id 重复' },
  { code: 'DANGLING_PARENT', group: 'structure', fixable: false, meaning: 'parent 指向不存在的条目' },
  { code: 'WORLD_ROOT_MISSING', group: 'structure', fixable: false, meaning: '世界观有多个分类但缺根条目' },
  { code: 'WORLD_ROOT_MULTIPLE', group: 'structure', fixable: false, meaning: '世界观出现多个根条目' },
  { code: 'WORLD_CATEGORY_REQUIRED', group: 'structure', fixable: true, meaning: '非根世界观条目缺 category' },
  { code: 'RELATION_ENDPOINT', group: 'structure', fixable: false, meaning: '关系两端不是各恰一个已存在实体' },
  { code: 'RELATION_SELF_LOOP', group: 'structure', fixable: false, meaning: '关系自环' },
  { code: 'RELATION_DUPLICATE', group: 'structure', fixable: true, meaning: '同 (source,target,kind) 的关系重复' },
  { code: 'RELATION_FIELD_DEPRECATED', group: 'structure', fixable: true, meaning: '关系文件用了已废弃字段（如 direction）' },
  // Emitted by a domain's scan/validate as well as by a write plan (a hand-written file
  // raises them), so they belong in the report's vocabulary — #33 surfaced that
  // `findings.test.js` had filed them as "bad request" codes because they are *also*
  // argument rejections. None is auto-fixable: each needs the author's judgement.
  { code: 'CHARACTER_NAME_REQUIRED', group: 'structure', fixable: false, meaning: '角色卡缺 name（文件名只是位置）' },
  { code: 'CHARACTER_FIRST_APPEARANCE_INVALID', group: 'structure', fixable: false, meaning: 'firstAppearance 不是正整数章号' },
  { code: 'OUTLINE_KIND_UNKNOWN', group: 'structure', fixable: false, meaning: '大纲节点缺 kind 或值非法' },
  { code: 'KEYWORD_INVALID', group: 'structure', fixable: false, meaning: '世界书 keywords 不是字符串列表' },
  { code: 'PARTICIPANT_INVALID', group: 'structure', fixable: false, meaning: '时间线 participants 含非法元素' },
  { code: 'FRONTMATTER_ISSUE', group: 'structure', fixable: true, meaning: 'frontmatter 不可解析或字段类型不合法' },
  { code: 'ENTITIES_DRIFT', group: 'structure', fixable: true, meaning: 'entities 投影与域表不同源' },
  { code: 'ID_PATH_DIVERGED', group: 'structure', fixable: false, meaning: '实体 id 与文件路径不一致（改过名的正常状态）' },

  // ledger — facts/<subject>.md (data-model I-22, I-23)
  { code: 'FACT_LINE_MALFORMED', group: 'ledger', fixable: false, meaning: '账本行无法解析' },
  { code: 'FACT_CONFLICT', group: 'ledger', fixable: false, meaning: '同主体同属性的生效区间重叠且取值不同' },

  // foreshadow — foreshadowing/ (data-model I-09, I-21)
  { code: 'FORESHADOW_RESOLVED_WITHOUT_CHAPTER', group: 'foreshadow', fixable: true, meaning: 'resolved: true 缺 resolvedChapter' },
  { code: 'FORESHADOW_TRANSITION_INVALID', group: 'foreshadow', fixable: true, meaning: '伏笔状态非法流转（可由证据字段确定性推导）' },
  // The two **audit-only** codes (#33). They are not invariants: nothing is refused and
  // no rebuild reports them, because "late" is a fact about where the book stands today,
  // not about the file being wrong (data-model §3.2.2). They live in the catalogue anyway
  // so the report cannot invent a second vocabulary for the same idea (X-14), and they are
  // emitted by `foreshadowing-plan.ts` — the module that owns the lateness rule — so #36
  // sees the same wording the audit prints.
  { code: 'FORESHADOW_OVERDUE', group: 'foreshadow', fixable: false, meaning: '伏笔已过 dueBy 仍未回收' },
  { code: 'FORESHADOW_DUE_NOW', group: 'foreshadow', fixable: false, meaning: '伏笔正好到期（本期该回收）' },

  // timeline — timeline/ (data-model I-16…I-19)
  { code: 'TIMELINE_TIME_MISSING', group: 'timeline', fixable: false, meaning: 'confirmed 事件缺 worldTime' },
  { code: 'TIMELINE_TIME_INVALID', group: 'timeline', fixable: false, meaning: 'worldTime 不是真实日期' },
  { code: 'TIMELINE_ORDER_CONFLICT', group: 'timeline', fixable: false, meaning: '同一叙事槽位声明了两个世界时间' },
  { code: 'TIMELINE_WORLD_TIME_REVERSED', group: 'timeline', fixable: false, meaning: '叙事顺序递增而世界时间倒退（倒叙，提示）' },

  // catalog — chapters/index.json (data-model I-07, I-11…I-14)
  { code: 'CATALOG_STALE', group: 'catalog', fixable: true, meaning: 'catalog 与 .md 不一致' },
  { code: 'CATALOG_DUPLICATE', group: 'catalog', fixable: false, meaning: '同一章出现在两条 catalog 项' },
  { code: 'VOLUME_DIR_MISMATCH', group: 'catalog', fixable: false, meaning: '卷目录名与 volumeId/卷大纲不一致' },
  { code: 'CHAPTER_FILE_MISSING', group: 'catalog', fixable: true, meaning: 'catalog 引用的章文件不存在' },
  { code: 'CHAPTER_NOT_MARKDOWN', group: 'catalog', fixable: false, meaning: '正文目录下有非 .md 文件（catalog 除外）' },
]

/** Lookup for the report/repair pass; `undefined` for an unknown code (a bug, not a finding). */
export function findingCode(code: string): FindingCodeSpec | undefined {
  return FINDING_CODES.find((spec) => spec.code === code)
}

/**
 * Stable report order: group (declaration order), then severity (blocking first),
 * then the locator's textual form. A report that reorders itself between two runs
 * on unchanged files is unreadable in a diff, so the sort key is total.
 */
export function compareFindings(left: Finding, right: Finding): number {
  const byGroup = FINDING_GROUPS.indexOf(left.group) - FINDING_GROUPS.indexOf(right.group)
  if (byGroup !== 0) return byGroup
  const order: readonly FindingSeverity[] = ['blocking', 'warning', 'info']
  const bySeverity = order.indexOf(left.severity) - order.indexOf(right.severity)
  if (bySeverity !== 0) return bySeverity
  const leftKey = `${left.code}\u0000${locatorKey(left.locator)}`
  const rightKey = `${right.code}\u0000${locatorKey(right.locator)}`
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
}

/** One-line textual address of a locator, used for sorting and for the report body. */
export function locatorKey(locator: FindingLocator): string {
  switch (locator.kind) {
    case 'entity':
      return `${locator.entityKind}:${locator.id}`
    case 'chapter':
      return `chapter:${locator.chapterId}`
    case 'catalog':
      return locator.volumeId === undefined ? 'catalog:' : `catalog:${locator.volumeId}`
    case 'path':
      return locator.line === undefined ? locator.path : `${locator.path}#L${locator.line}`
  }
}
