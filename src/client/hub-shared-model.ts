/**
 * Pure view model for the shared-content page (ADR-0010 D5, issue #87).
 *
 * Same reason as `hub-model.ts`: `node --test` has no DOM, so every wording
 * decision, every grouping rule and every fallback lives here as a plain function
 * over plain data and is asserted from `tests/panel-bundle.test.js`, while the
 * React view (`hub-shared.tsx`) only arranges it.
 *
 * THREE RULES THAT SHAPE THIS FILE:
 *
 *   1. The page is READ-ONLY at the wire and says so on screen. There is no write
 *      action to model — 复制/引用 belong to #40 — so the only verb here is
 *      "re-read".
 *   2. The data source is visible: `indexSource` is either the derived manifest
 *      (`shared/index.json`) or an in-memory rescan that was **not** written back
 *      (ADR-0010 D5). A user who edits `index.json` by hand must be able to see
 *      which of the two answered.
 *   3. "The library does not exist" is an empty state, not an error: `created:
 *      false` renders the release note, and no request is retried in a loop.
 */

import type { InternalError, InternalResult } from './internal.js'

/**
 * The four kinds, in display order (ADR-0007 C1). Declared locally rather than
 * imported from the Host: the two halves are separate bundles, and the Client
 * may only `import type` from the channel module.
 */
export const SHARED_KIND_ORDER = ['world', 'library', 'snippets', 'series'] as const
export type SharedKindName = (typeof SHARED_KIND_ORDER)[number]

/** Human names for the four kind directories. */
export const SHARED_KIND_LABELS: Record<SharedKindName, string> = {
  world: '世界观 / 设定',
  library: '资料',
  snippets: '写作片段',
  series: '系列',
}

/** Everything the page prints. One place, so the bundle assertions are meaningful. */
export const SHARED_TEXTS = {
  title: '共享内容',
  back: '返回书单',
  refresh: '刷新',
  loading: '正在读取共享库…',
  /** The exact release note ADR-0010 D5 requires for a library that is not there. */
  emptyTitle: '共享库尚未创建（0.4.0 支持）',
  emptyBody: '共享库是跨书的资料目录（世界观 / 资料 / 写作片段 / 系列）：一处维护，多书取用。',
  emptyHint: '0.4.0 起可以从这里加入条目（#40）。本页只读，不会替你建目录。',
  readOnly: '只读：复制/引用将在后续版本提供（#40）。',
  sourceIndex: '数据来源：shared/index.json（派生清单）',
  sourceScan: '数据来源：内存扫描，未写回 index.json',
  truncated: '本次未列全（已达扫描上限）',
  noTags: '无标签',
  noEntries: '这一类还没有条目',
  emptyFilter: '没有匹配的条目',
} as const

/** `indexSource` → the sentence that tells the user which source answered. */
export function describeSharedSource(indexSource: unknown): string {
  return indexSource === 'index' ? SHARED_TEXTS.sourceIndex : SHARED_TEXTS.sourceScan
}

/** One entry of `GET /inkflow/internal/hub/shared` (only the fields the page reads). */
export interface SharedEntry {
  entryId?: string
  kind?: string
  path?: string
  sha256?: string
  tags?: string[]
  entryIdDerived?: boolean
}

/** `GET /inkflow/internal/hub/shared` → `value`. */
export interface HubSharedValue {
  created?: boolean
  indexSource?: string
  kinds?: string[]
  entries?: SharedEntry[]
  countsByKind?: Record<string, number>
  total?: number
  truncated?: boolean
}

/** What the page can render: an answerable list, or one reason it has none. */
export type SharedState =
  | {
      status: 'ready'
      created: boolean
      indexSource: 'index' | 'scan'
      entries: SharedEntry[]
      countsByKind: Record<string, number>
      total: number
      truncated: boolean
    }
  | { status: 'error'; message: string }

/** Route failures worth a sentence, so the page does not print a bare code. */
export const SHARED_ERROR_HINTS: Record<string, string> = {
  SHARED_UNAVAILABLE: '读不到插件数据目录，共享库无法定位（SHARED_UNAVAILABLE）',
  HUB_ROUTE_REQUIRED: '共享内容请求只允许走 /hub/*（面板内部错误）',
  'fetch-failed': '共享内容通道请求失败，检查 DSH 与插件的连接',
  'not-found': '这个版本的 Host 还没有共享内容路由，先更新插件并重启 DSH',
}

export function describeSharedError(error: InternalError | undefined): string {
  if (error === undefined) return '共享内容通道没有返回内容'
  return SHARED_ERROR_HINTS[error.code] ?? error.message ?? error.code
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

/** Fold the channel result into one of the two renderable states. */
export function readSharedLibrary(result: InternalResult<HubSharedValue>): SharedState {
  if (!result.ok || result.value === undefined) {
    return { status: 'error', message: describeSharedError(result.error) }
  }
  const value = result.value
  const entries = Array.isArray(value.entries) ? value.entries : []
  const countsByKind: Record<string, number> = {}
  for (const kind of SHARED_KIND_ORDER) countsByKind[kind] = countOf(value.countsByKind?.[kind])
  return {
    status: 'ready',
    created: value.created === true,
    indexSource: value.indexSource === 'index' ? 'index' : 'scan',
    entries,
    countsByKind,
    total: typeof value.total === 'number' && Number.isFinite(value.total) ? value.total : entries.length,
    truncated: value.truncated === true,
  }
}

export interface SharedGroup {
  kind: SharedKindName
  label: string
  /** Count over the WHOLE library: a `kind`/`q` filter never changes it. */
  count: number
  entries: SharedEntry[]
}

/**
 * Group the answer by kind, in the canonical order.
 *
 * Groups are chosen from `countsByKind` (the whole library) rather than from the
 * filtered `entries`, so a filter narrows each group instead of making the other
 * kinds disappear from the page.
 */
export function sharedGroups(entries: readonly SharedEntry[], countsByKind: Record<string, number>): SharedGroup[] {
  return SHARED_KIND_ORDER.filter((kind) => countOf(countsByKind[kind]) > 0).map((kind) => ({
    kind,
    label: SHARED_KIND_LABELS[kind],
    count: countOf(countsByKind[kind]),
    entries: entries.filter((entry) => entry.kind === kind),
  }))
}

/** The last path segment without a `.md`/`.json` suffix: what the row is called. */
export function entryName(path: unknown): string {
  if (typeof path !== 'string' || path.trim() === '') return '（未命名条目）'
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name.replace(/\.(?:md|json)$/iu, '')
}

/** `门派 · 设定`, or the "no tags" note — an entry without tags is not an error. */
export function describeTags(entry: SharedEntry): string {
  const tags = Array.isArray(entry.tags)
    ? entry.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '')
    : []
  return tags.length === 0 ? SHARED_TEXTS.noTags : tags.join(' · ')
}

/** The header line: how many entries this answer holds, and whether it is complete. */
export function sharedSummary(state: SharedState): string {
  if (state.status === 'error') return '共享库读不到'
  const perKind = SHARED_KIND_ORDER.filter((kind) => countOf(state.countsByKind[kind]) > 0)
    .map((kind) => `${SHARED_KIND_LABELS[kind]} ${countOf(state.countsByKind[kind])}`)
    .join(' · ')
  const headline = state.total === 0 ? '共 0 条' : `共 ${state.total} 条`
  const suffix = state.truncated ? `（${SHARED_TEXTS.truncated}）` : ''
  return perKind === '' ? `${headline}${suffix}` : `${headline}${suffix} · ${perKind}`
}

/** Whether this answer should render the "library not created yet" card. */
export function isEmptyLibrary(state: SharedState): boolean {
  return state.status === 'ready' && state.created === false
}

/** Whether this answer is a created-but-filtered-to-nothing library. */
export function isEmptyFilter(state: SharedState): boolean {
  return state.status === 'ready' && state.created === true && state.total === 0
}
