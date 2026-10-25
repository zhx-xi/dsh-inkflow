/**
 * Pure view model for the foreshadow board (data-model §3.2).
 *
 * Everything here is a plain function over plain data, for the same reason
 * `panel-model.ts` is: `node --test` has no DOM, so the React View is only checked as
 * a built bundle while the grouping and the wording are tested directly.
 *
 * One shape feeds this file: `GET /inkflow/internal/foreshadow`. The Host sends the
 * same entries three times (open / late / by linked entity) because "late" is defined
 * once, in `data-model §3.2.2` — the panel must not re-derive it from `dueBy` and a
 * chapter number and then disagree with the tool.
 *
 * Three states are kept apart on purpose, because collapsing them is the bug this tab
 * exists to prevent:
 *   * `error` — the request failed (a code the user can act on);
 *   * `indexAvailable: false` — the Host could not read the index: "cannot answer",
 *     NOT "this book has no foreshadows";
 *   * an empty board — the book really has no open setups.
 *
 * No IO, no React, no `@deepseek-ai/*` import (ADR-0008 D4/V7).
 */

import type { InternalError, InternalResult } from './internal.js'

/** One entry as the channel sends it (`ForeshadowItem` on the Host side). */
export interface ForeshadowItem {
  id: string
  title: string
  file: string
  status: string
  declaredStatus: string
  overdue: boolean
  dueNow: boolean
  dueBy: string | null
  dueKind: string | null
  plantedAt?: string | null
  advancedAt?: string[]
  resolvedChapter?: string | null
  linkedEntities?: string[]
}

export interface ForeshadowCounts {
  total: number
  unresolved: number
  resolved: number
  overdue: number
  dueNow: number
}

export interface ForeshadowChapterRef {
  id: string
  title: string
  volume: string | null
  seq: number
  path: string
}

export interface ForeshadowEntityGroup {
  id: string | null
  title: string
  kind: string | null
  items: ForeshadowItem[]
}

/** The payload of `GET /inkflow/internal/foreshadow`. */
export interface ForeshadowBoardValue {
  pluginVersion?: string
  currentChapter: ForeshadowChapterRef | null
  indexAvailable: boolean
  counts: ForeshadowCounts | null
  groups: {
    unresolved: ForeshadowItem[]
    overdue: ForeshadowItem[]
    byEntity: ForeshadowEntityGroup[]
  } | null
  indexError?: { code?: string; message?: string }
  indexRebuilt?: boolean
  indexState?: string
}

/** One row as the panel renders it. */
export interface ForeshadowCard {
  id: string
  title: string
  file: string
  /** The word in the badge: 超期 / 本期到期 / the state's label. */
  badge: string
  /** Whether this card is about the chapter being written right now. */
  current: boolean
  /** Deadline sentence for the detail line (`null` when the entry has no `dueBy`). */
  due: string | null
  /** What the file itself claims, when it disagrees with the computed state. */
  declared: string | null
}

/** One group row in the "by character" section. */
export interface ForeshadowEntityRow {
  id: string | null
  label: string
  count: number
}

export interface ForeshadowSection {
  key: 'dueNow' | 'overdue' | 'unresolved' | 'byEntity'
  title: string
  note: string
  items: ForeshadowCard[]
  entities: ForeshadowEntityRow[]
}

export interface ForeshadowView {
  /** A request-level failure, already worded for a person. */
  error: string | null
  indexAvailable: boolean
  /** `null` when the request failed; the panel then shows the error instead. */
  summary: string | null
  currentChapter: string | null
  sections: ForeshadowSection[]
  /** The whole-board empty state; `null` when at least one entry exists. */
  empty: string | null
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  planted: '已埋',
  advanced: '已推进',
  resolved: '已回收',
  overdue: '超期',
}

/** The author's word for one state. Unknown values are echoed, never hidden. */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

/** Word a `dueBy` for the detail line: chapters and volumes read differently. */
export function describeDue(item: ForeshadowItem): string | null {
  if (item.dueBy === null || item.dueBy === '') return null
  if (item.dueKind === 'volume') return `卷末 ${item.dueBy}`
  if (item.dueKind === 'unknown') return `到期位置 ${item.dueBy}（找不到该章/卷）`
  return `第 ${item.dueBy} 章`
}

function cardOf(item: ForeshadowItem): ForeshadowCard {
  const badge = item.overdue ? '超期' : item.dueNow ? '本期到期' : statusLabel(item.status)
  return {
    id: item.id,
    title: item.title,
    file: item.file,
    badge,
    current: item.dueNow,
    due: describeDue(item),
    declared: item.declaredStatus !== item.status ? statusLabel(item.declaredStatus) : null,
  }
}

/** Wording for a failed request; the codes come from the Host's own vocabulary. */
export function describeForeshadowError(error: InternalError | undefined): string {
  const code = error?.code ?? 'unknown'
  const detail = typeof error?.message === 'string' && error.message !== '' ? `：${error.message}` : ''
  if (code === 'INDEX_UNAVAILABLE') return `索引不可读（INDEX_UNAVAILABLE）${detail}——先重建索引，再看伏笔看板。`
  if (code === 'NO_SESSION_CONTEXT') return '面板还没绑定到某个会话，无法确定是哪一本书。'
  if (code === 'INDEX_BUILD_FAILED') return `索引重建失败（INDEX_BUILD_FAILED）${detail}`
  if (code.startsWith('PROJECT_')) return `这本书当前不可用（${code}）${detail}`
  return `读取伏笔看板失败（${code}）${detail}`
}

/**
 * The four sections, in the order an author works in: what is due in the chapter being
 * written, then what is already late, then the rest of the backlog, then who is in them.
 *
 * 本期到期 used to exist only in the summary line (issue 137), while the verification
 * checklist and the user guide both promised four sections — and "due in this very
 * chapter" is the one that carries the action.
 */
const SECTION_TEXT = {
  dueNow: { title: '本期到期', note: 'dueBy 就是正在写的这一章：这是回收它的最后机会' },
  overdue: { title: '超期', note: '已越过 dueBy 指向的章/卷，仍未回收' },
  unresolved: { title: '未回收', note: '所有未回收的伏笔，含已超期与本期到期的' },
  byEntity: { title: '按角色分组', note: '每条伏笔关联的角色/世界观条目（linkedEntities）' },
} as const

function sectionOf(key: 'dueNow' | 'overdue' | 'unresolved', items: ForeshadowCard[]): ForeshadowSection {
  return { key, ...SECTION_TEXT[key], items, entities: [] }
}

/** Fold the wire payload into what the View renders. */
export function readForeshadowBoard(result: InternalResult<ForeshadowBoardValue>): ForeshadowView {
  if (!result.ok) {
    return {
      error: describeForeshadowError(result.error),
      indexAvailable: false,
      summary: null,
      currentChapter: null,
      sections: [],
      empty: null,
    }
  }
  const value = result.value
  const chapter = value?.currentChapter ?? null
  const currentChapter =
    chapter === null ? null : `${chapter.title === '' ? chapter.id : chapter.title}（第 ${String(chapter.seq)} 章${chapter.volume === null ? '' : ` · ${chapter.volume}`}）`
  if (value === undefined || value.indexAvailable !== true || value.groups === null) {
    return {
      error: null,
      indexAvailable: false,
      summary: null,
      currentChapter,
      sections: [],
      empty: '索引还不可读，看板暂时无法回答（这不是「没有伏笔」）。索引重建后再刷新。',
    }
  }

  const counts = value.counts
  const summary =
    counts === null
      ? null
      : `超期 ${String(counts.overdue)} · 本期到期 ${String(counts.dueNow)} · 未回收 ${String(counts.unresolved)} / 共 ${String(counts.total)}`

  const overdue = value.groups.overdue.map(cardOf)
  const unresolved = value.groups.unresolved.map(cardOf)
  // 本期到期 comes from the SAME list the counts are taken over and reuses the Host's
  // own `dueNow` flag (`foreshadowUrgency`, data-model §3.2.2) — the panel must not
  // re-derive "due in this chapter" from `dueBy` and a chapter number and then
  // disagree with the tool. `overdue` and `dueNow` are mutually exclusive by
  // construction (strictly later vs. exactly this one), so nothing lands in both.
  const dueNow = value.groups.unresolved.filter((item) => item.dueNow).map(cardOf)
  const entities: ForeshadowEntityRow[] = value.groups.byEntity.map((group) => ({
    id: group.id,
    label: `${group.title}（${String(group.items.length)}）`,
    count: group.items.length,
  }))

  // Empty groups are not rendered (issue 137 acceptance): the summary line above
  // already carries the zeroes, so a "本期到期（0）" card would be a placeholder that
  // pushes the sections the author actually has to act on off the screen.
  const sections: ForeshadowSection[] = [
    sectionOf('dueNow', dueNow),
    sectionOf('overdue', overdue),
    sectionOf('unresolved', unresolved),
  ].filter((section) => section.items.length > 0)
  if (entities.length > 0) {
    sections.push({ key: 'byEntity', ...SECTION_TEXT.byEntity, items: [], entities })
  }

  return {
    error: null,
    indexAvailable: true,
    summary,
    currentChapter,
    sections,
    empty: unresolved.length === 0 ? '这本书没有未回收的伏笔。' : null,
  }
}
