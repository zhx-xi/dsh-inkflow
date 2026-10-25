/**
 * Pure view model for the shared-content page (ADR-0010 D5).
 *
 * Same reason as `hub-model.ts`: `node --test` has no DOM, so every wording
 * decision, every grouping rule and every fallback lives here as a plain function
 * over plain data and is asserted from `tests/panel-bundle.test.js`, while the
 * React view (`hub-shared.tsx`) only arranges it.
 *
 * FOUR RULES THAT SHAPE THIS FILE:
 *
 *   1. The page can WRITE, but only in one direction: copy a library
 *      entry INTO a book, or refresh one copy that went stale. Nothing here offers
 *      a way to change the shared library — there is no "push" (ADR-0007 C6).
 *   2. Both writes are two-step: the button arms a confirmation card, and the
 *      request carries `confirm: true` only after the user pressed 确认. A UI that
 *      writes on a single click would make ADR-0006 D3's discipline decorative.
 *   3. `stale` is a REPORT, so it is rendered as a state and never as an action
 *      that runs by itself; 更新 is per row and says what it will overwrite.
 *   4. The data source is visible: the library list says whether the derived
 *      manifest or an in-memory rescan answered, and the copies list says which
 *      book it is about.
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
  emptyTitle: '共享库还没有条目',
  emptyBody: '共享库是跨书的资料目录（世界观 / 资料 / 写作片段 / 系列）：一处维护，多书取用。',
  emptyHint: '把条目放进插件数据目录的 shared/ 下（world/ library/ snippets/ series/），这里就会出现。',
  /** ADR-0007 C2/C3: what a copy is, in one line, next to the button that makes one. */
  copyHint: '复制是快照：正文进本书并记录 origin，之后共享库再改也不会动它。',
  referenceHint: '引用只适用于资料原文：卡片只读、正文留在共享库，本项目对该条不自包含。',
  sourceIndex: '数据来源：shared/index.json（派生清单）',
  sourceScan: '数据来源：内存扫描，未写回 index.json',
  truncated: '本次未列全（已达扫描上限）',
  noTags: '无标签',
  noEntries: '这一类还没有条目',
  emptyFilter: '没有匹配的条目',
  pickBook: '复制到哪本书',
  noBook: '还没有可用的书：先用「新开书」创建或修复一本书，再回来复制。',
  copies: '本书的副本',
  copiesNone: '这本书还没有从共享库复制任何条目。',
  copiesLoading: '正在核对本书副本…',
  selfContainedOff: '本项目不自包含：有引用条目，正文留在共享库。',
  selfContainedOn: '本项目自包含：所有副本都是快照。',
  staleHint: 'stale 表示共享库里的那一条变了；副本不会自动更新。',
  copy: '复制',
  reference: '引用（只读）',
  update: '更新',
  confirmCopy: '确认复制',
  confirmUpdate: '确认更新（先备份）',
  cancel: '取消',
  working: '处理中…',
  seriesNote: '系列条目不复制文件：只把 inkflow.json 的 seriesId 指向它。',
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
  /**
   * Why the configured `sharedRoot` is not the directory that answered.
   *
   * Absent when the setting is in force (or unset). Mirrored as an optional shape
   * rather than imported: the two halves are separate bundles, and the Client may
   * only `import type` from the channel module.
   */
  sharedRootWarning?: { code?: string; message?: string }
}

/** One row of `GET /hub/shared/copies`: a copy in the book and its state. */
export interface SharedCopyRow {
  file?: string
  kind?: string
  entryId?: string | null
  mode?: string
  contentHash?: string
  currentHash?: string
  state?: string
}

/** `GET /hub/shared/copies` → `value`. */
export interface SharedCopiesValue {
  projectId?: string | null
  seriesId?: string | null
  seriesFound?: boolean
  selfContained?: boolean
  entries?: SharedCopyRow[]
  references?: string[]
  counts?: { total?: number; current?: number; stale?: number; missing?: number }
  truncated?: boolean
}

/** What the page can render for the library: an answerable list, or one reason it has none. */
export type SharedState =
  | {
      status: 'ready'
      created: boolean
      indexSource: 'index' | 'scan'
      entries: SharedEntry[]
      countsByKind: Record<string, number>
      total: number
      truncated: boolean
      /**
       * One line when the settings file named a `sharedRoot` the plugin refused:
       * `null` otherwise.
       *
       * The page MUST say this: without it a library read from the default directory
       * looks exactly like the one the author configured and moved elsewhere, so the
       * failure presents as "my entries vanished" (the Host shipped the field, nothing read
       * it, and there was nowhere for that to show).
       */
      rootWarning: string | null
    }
  | { status: 'error'; message: string }

/** The same two shapes for the copies half. */
export type SharedCopiesState =
  | {
      status: 'ready'
      copies: SharedCopyRow[]
      references: string[]
      selfContained: boolean
      seriesId: string | null
      seriesFound: boolean
      counts: { total: number; current: number; stale: number; missing: number }
      truncated: boolean
    }
  | { status: 'idle'; message: string }
  | { status: 'error'; message: string }

/** Route failures worth a sentence, so the page does not print a bare code. */
export const SHARED_ERROR_HINTS: Record<string, string> = {
  SHARED_UNAVAILABLE: '读不到插件数据目录，共享库无法定位（SHARED_UNAVAILABLE）',
  HUB_ROUTE_REQUIRED: '共享内容请求只允许走 /hub/*（面板内部错误）',
  'fetch-failed': '共享内容通道请求失败，检查 DSH 与插件的连接',
  'not-found': '这个版本的 Host 还没有共享内容路由，先更新插件并重启 DSH',
  BOOK_REQUIRED: '先在上面选一本书',
  BOOK_NOT_REGISTERED: '这本书不在书库里（先用书单打开它）',
  BOOK_NOT_USABLE: '这本书还不能写入：先修好它（书单里能看到缺什么）',
  SHARED_ENTRY_NOT_FOUND: '共享库里没有这一条了，刷新看看',
  SHARED_COPY_CONFLICT: '目标文件已存在：复制不会覆盖，请先改名或删除',
  REFERENCE_NOT_ALLOWED: '只有资料条目可以引用，设定/片段/系列必须复制',
  REFERENCE_READONLY: '引用卡只读：正文在共享库那边',
  SHARED_SOURCE_MISSING: '共享库里这一条已被删除，副本仍是普通文件',
  SHARED_COPY_NOT_FOUND: '本书没有这条副本，先复制一次',
  CONFIRM_REQUIRED: '这次写入需要确认（先点确认按钮）',
  META_UNREADABLE: 'inkflow.json 读不出来，先修复这本书',
}

export function describeSharedError(error: InternalError | undefined): string {
  if (error === undefined) return '共享内容通道没有返回内容'
  return SHARED_ERROR_HINTS[error.code] ?? error.message ?? error.code
}

/** `stale` / `current` / `missing-source` → the Chinese state the row prints. */
export function describeCopyState(state: unknown): string {
  if (state === 'current') return '最新'
  if (state === 'stale') return '落后（源已变）'
  if (state === 'missing-source') return '来源已删'
  return '未知'
}

/** Whether a copy row may be refreshed: stale only (a report is not an action). */
export function copyNeedsUpdate(row: SharedCopyRow | undefined): boolean {
  return row?.state === 'stale' && row.mode !== 'reference'
}

/**
 * The modes a kind may be taken out with (ADR-0007 C4).
 *
 * `world/`, `snippets/` and `series/` get exactly one: copy. Offering a disabled
 * "引用" button next to them would imply the option exists and is merely off.
 */
export function copyModes(kind: unknown): Array<'copy' | 'reference'> {
  return kind === 'library' ? ['copy', 'reference'] : ['copy']
}

/** A series entry writes no file; the card says so instead of promising a path. */
export function isSeriesLink(kind: unknown): boolean {
  return kind === 'series'
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

/**
 * The one line that explains a `sharedRoot` the plugin refused, or `null`.
 *
 * The Host's own message is quoted when it sent one: it already says what the value
 * was and why it was refused, and re-wording it here would give the author two
 * different explanations of one fact.
 */
export function describeSharedRootWarning(warning: unknown): string | null {
  const record = typeof warning === 'object' && warning !== null ? (warning as Record<string, unknown>) : undefined
  if (record === undefined) return null
  const message = typeof record['message'] === 'string' && record['message'].trim() !== '' ? record['message'].trim() : ''
  return message === ''
    ? '设置里的「共享库路径」未生效：插件没有接受这个值，这里显示的是缺省目录（插件数据目录下的 shared/）。'
    : `设置里的「共享库路径」未生效：${message}`
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
    rootWarning: describeSharedRootWarning(value.sharedRootWarning),
  }
}

/** Fold the copies answer. No book selected is `idle`, not an error. */
export function readSharedCopies(result: InternalResult<SharedCopiesValue>): SharedCopiesState {
  if (!result.ok || result.value === undefined) {
    return { status: 'error', message: describeSharedError(result.error) }
  }
  const value = result.value
  const copies = Array.isArray(value.entries) ? value.entries : []
  return {
    status: 'ready',
    copies,
    references: Array.isArray(value.references)
      ? value.references.filter((item): item is string => typeof item === 'string')
      : [],
    selfContained: value.selfContained !== false,
    seriesId: typeof value.seriesId === 'string' && value.seriesId !== '' ? value.seriesId : null,
    seriesFound: value.seriesFound === true,
    counts: {
      total: countOf(value.counts?.total),
      current: countOf(value.counts?.current),
      stale: countOf(value.counts?.stale),
      missing: countOf(value.counts?.missing),
    },
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

/** The copies line: how many the book holds, split by state (ADR-0007 V3). */
export function copiesSummary(state: SharedCopiesState): string {
  if (state.status === 'idle') return state.message
  if (state.status === 'error') return '本书副本核对失败'
  const { counts } = state
  if (counts.total === 0) return SHARED_TEXTS.copiesNone
  const parts = [`共 ${counts.total} 条`, `最新 ${counts.current}`]
  if (counts.stale > 0) parts.push(`落后 ${counts.stale}`)
  if (counts.missing > 0) parts.push(`来源已删 ${counts.missing}`)
  return parts.join(' · ')
}

/**
 * Whether this answer should render the "library does not exist yet" card.
 *
 * `created: false` is the only thing that means "there is no library": a library
 * that exists but answers nothing is a different state (see `isEmptyFilter`), and
 * conflating them would tell a user with 200 entries that they have none.
 */
export function isEmptyLibrary(state: SharedState): boolean {
  return state.status === 'ready' && state.created === false
}

/** Whether this answer is a created library showing no entries (filter or empty). */
export function isEmptyFilter(state: SharedState): boolean {
  return state.status === 'ready' && state.created === true && state.total === 0
}

/** The one banner the page shows about self-containment (ADR-0007 C4). */
export function selfContainedNote(state: SharedCopiesState): string {
  if (state.status !== 'ready') return ''
  return state.selfContained ? SHARED_TEXTS.selfContainedOn : SHARED_TEXTS.selfContainedOff
}

/**
 * The usable books a copy may target, in the order the book list already showed.
 *
 * Only `usable` rows: the Host refuses a write into any other state, so offering
 * one would be a button that always fails.
 */
export function copyTargets<Row extends { path?: string; title?: string; state?: string }>(
  books: readonly Row[],
): Array<{ path: string; label: string }> {
  return books
    .filter((book) => book.state === 'usable' && typeof book.path === 'string' && book.path !== '')
    .map((book) => ({
      path: book.path as string,
      label: typeof book.title === 'string' && book.title !== '' ? book.title : (book.path as string),
    }))
}
