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
  // #48: the same unordered pair + kind claimed in contradictory directions (A→B and
  // B→A both directed, or one directed and one undirected). Not `fixable` on purpose:
  // which file holds the surviving claim is the author's decision, and merging toward a
  // guessed direction is how a graph silently loses an edge.
  { code: 'RELATION_CONFLICT', group: 'structure', fixable: false, meaning: '同一对实体同类型的关系方向互相矛盾' },
  // #188: the graph's third contradiction — `since`/`until` windows that cannot both hold
  // (one file whose window is empty or reversed, or two files writing two windows for one
  // relation). The judgement reuses the ledger's chapter order (I-23) rather than inventing a
  // second one. Not `fixable`: which of the two windows is the true one is the author's
  // knowledge, and merging toward a guessed span is how a relation silently moves in time.
  { code: 'RELATION_PERIOD_CONFLICT', group: 'structure', fixable: false, meaning: '关系的 since/until 时段自相矛盾或两条边写了两套时段' },
  // #188: a boundary the book cannot place — a free label (`永平三年秋`) or a chapter id the
  // book does not have. Reported so the gap is visible, and never blocking: "cannot say" is
  // not "says the opposite", and the lax path (no window at all, or free labels) must stay
  // writable.
  { code: 'RELATION_PERIOD_UNCOMPARABLE', group: 'structure', fixable: false, meaning: '关系时段有一端不是本书章 id，无法按章序判定' },
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
  // Not auto-fixable on purpose (#143, ADR-0015 D2): the fix is either naming the chapter
  // that pays the setup off (the author's knowledge) or retracting `resolved` (denying what
  // the author wrote). A catalogue entry claiming `fixable` with no action behind it makes
  // the report say "1 fixable" while the repair pass offers nothing.
  { code: 'FORESHADOW_RESOLVED_WITHOUT_CHAPTER', group: 'foreshadow', fixable: false, meaning: 'resolved: true 缺 resolvedChapter' },
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

  // The quality gate (#44, roadmap X-24). Seven checks over one chapter, emitted by
  // `gate.ts` / `gate-rules.ts` into `.inkflow/audit/gate-<chapterId>.json`.
  //
  // `group` answers "which family of book facts does this finding touch", because
  // ADR-0022 D3 keeps `FINDING_GROUPS` at five: a name or an entity reference is
  // `structure`, a ledger value is `ledger`, and everything that is a fact about the
  // chapter *text* is `catalog` (the chapter family). The seven checks stay
  // distinguishable through their codes and through `GATE_CODES`' `check` column.
  //
  // `fixable` is false for every one of them on purpose (ADR-0022 D3 / ADR-0015 D2):
  // `repair.ts` is the one repair path and it has no action for a gate code, so a
  // `true` here would promise a one-click fix that does nothing — the accident #143
  // recorded. The mechanical classes flip to true in the commit that also teaches
  // `repair.ts` the rewrite, with its own tests.
  //
  // 1 字数
  { code: 'GATE_WORD_COUNT_LOW', group: 'catalog', fixable: false, meaning: '本章字数低于目标下限' },
  { code: 'GATE_WORD_COUNT_HIGH', group: 'catalog', fixable: false, meaning: '本章字数超过目标上限' },
  // 2 章末钩子
  { code: 'GATE_HOOK_MISSING', group: 'catalog', fixable: false, meaning: '章末一段没有钩子信号（新处境/新疑问/新威胁）' },
  { code: 'GATE_HOOK_SUMMARY', group: 'catalog', fixable: false, meaning: '章末一段是总结、抒情或预告' },
  // 3 六维去 AI 味（open-questions Q4 的六维，一维一码）
  { code: 'GATE_AI_SENTENCE', group: 'catalog', fixable: false, meaning: '句长分布过于均匀或长句成串' },
  { code: 'GATE_AI_PUNCT', group: 'catalog', fixable: false, meaning: '破折号或省略号密度过高' },
  { code: 'GATE_AI_PARALLEL', group: 'catalog', fixable: false, meaning: '「不是…而是…」与连续同构句（排比/三段式）' },
  { code: 'GATE_AI_NARRATION', group: 'catalog', fixable: false, meaning: '解释性旁白：动作之后补写情绪结论' },
  { code: 'GATE_AI_MODIFIER', group: 'catalog', fixable: false, meaning: '形容词/副词（的、地、程度副词）密度过高' },
  { code: 'GATE_AI_TEMPLATE', group: 'catalog', fixable: false, meaning: '段尾套路话（空气仿佛凝固一类）' },
  // #214 B 块：同一项的反方向——「太碎」。判据与阈值见 `gate-fragment.ts` / `FRAGMENT`，
  // 严重级与上面六维一致（info，不拦写盘）：它们说的是「读着像不像人写的」，不是「写错了」。
  { code: 'GATE_AI_STUTTER', group: 'catalog', fixable: false, meaning: '电报体：连续 N 句都 ≤5 可见字' },
  { code: 'GATE_AI_LOW_LINK', group: 'catalog', fixable: false, meaning: '整章没有一处因果/转折/递进连接词' },
  { code: 'GATE_AI_LONG_PARA', group: 'catalog', fixable: false, meaning: '单段可见字超过上限（砌成墙）' },
  // 4 一致性（与设定库对账，不重判设定本身）
  { code: 'GATE_CONSISTENCY_POV_UNKNOWN', group: 'structure', fixable: false, meaning: '本章 frontmatter 的 pov 不在角色库里' },
  { code: 'GATE_CONSISTENCY_FACT_STALE', group: 'ledger', fixable: false, meaning: '账本里已失效的取值仍出现在本章正文' },
  // 5 敏感自查
  { code: 'GATE_SENSITIVE_WORD', group: 'catalog', fixable: false, meaning: '命中敏感词表' },
  // 6 平台规则（形式类：残留与引流）
  { code: 'GATE_PLATFORM_RESIDUE', group: 'catalog', fixable: false, meaning: '正文残留分页/求票/码字工具文字' },
  { code: 'GATE_PLATFORM_PROMO', group: 'catalog', fixable: false, meaning: '正文含站外引流或广告词' },
  // 7 机械校对（零模型、确定性）
  { code: 'GATE_PROOF_PUNCT_UNPAIRED', group: 'catalog', fixable: false, meaning: '引号/括号/书名号不成对' },
  { code: 'GATE_PROOF_HALF_PUNCT', group: 'catalog', fixable: false, meaning: '半角标点紧邻汉字（全半角混用）' },
  { code: 'GATE_PROOF_FULLWIDTH_ALNUM', group: 'catalog', fixable: false, meaning: '正文出现全角字母或数字' },
  { code: 'GATE_PROOF_REPEAT_WORD', group: 'catalog', fixable: false, meaning: '重复字词（的的、了了、紧邻同词）' },
  { code: 'GATE_PROOF_NEAR_NAME', group: 'structure', fixable: false, meaning: '别名词表外的近似名（疑似把角色名写错）' },
  { code: 'GATE_PROOF_APPELLATION_MIXED', group: 'catalog', fixable: false, meaning: '同一角色在同一章内混用不同称谓' },
  { code: 'GATE_PROOF_ARABIC_MEASURE', group: 'catalog', fixable: false, meaning: '阿拉伯数字后紧接中文量词' },
  { code: 'GATE_PROOF_NUMBER_MIXED', group: 'catalog', fixable: false, meaning: '同一段里阿拉伯数字与汉字数字混写' },
  // 8 退化检测（#212）— 「模型是不是写坏了」：七项判的是「写得好不好」，判不出复读、截断、
  // 占位语与工程词泄漏，而批量作业正是靠这条关口决定要不要落盘。四码都挂在章族（`catalog`）：
  // 它们全是「这一章的文本本身坏了」的事实，与设定库是否一致无关。
  { code: 'GATE_DEGEN_REPEAT', group: 'catalog', fixable: false, meaning: '复读：紧邻整行重复 / 整段重复 / 同句连发' },
  { code: 'GATE_DEGEN_TRUNCATED', group: 'catalog', fixable: false, meaning: '章末停在半句（正文不再以句末/收尾标点结束）' },
  { code: 'GATE_DEGEN_PLACEHOLDER', group: 'catalog', fixable: false, meaning: '占位语与元话语（（此处继续展开）/以下是第 N 章/生成拒绝语）' },
  { code: 'GATE_DEGEN_META_LEAK', group: 'catalog', fixable: false, meaning: '工程词泄漏（TODO/lorem/{{占位}}/as an AI/写作流水线术语）' },

  // The review DAG (#46, roadmap X-24/X-26). One code per dimension rather than one
  // `REVIEW_OPINION`: the code is what a report groups and a repair pass dispatches on, and
  // "a structure problem" vs "a pacing problem" is the distinction a reader acts on. The
  // dimension also travels as its own field, because the panel filters on it; the code is
  // how the same distinction reaches the shared vocabulary and data-model §5.
  //
  // `fixable` is false for all five, for the reason ADR-0022 D3 spells out: an aesthetic
  // judgement is not something `repair.ts` may rewrite, and a `fixable: true` with no
  // action behind it turns 「一键修复」 into a button that does nothing.
  { code: 'REVIEW_STRUCTURE', group: 'structure', fixable: false, meaning: '结构维度的审稿意见（场景/因果/章末推进力）' },
  { code: 'REVIEW_CHARACTER', group: 'structure', fixable: false, meaning: '人物维度的审稿意见（动机/言行/对话腔调）' },
  { code: 'REVIEW_PACING', group: 'catalog', fixable: false, meaning: '节奏维度的审稿意见（疏密/说明段/可删段）' },
  { code: 'REVIEW_STYLE', group: 'catalog', fixable: false, meaning: '文风维度的审稿意见（句长/重复/腔调）' },
  { code: 'REVIEW_CONSISTENCY', group: 'ledger', fixable: false, meaning: '一致性维度的审稿意见（与设定库/账本冲突）' },
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
