/**
 * Pure view model for the book hub (ADR-0010 D1/D8, issue #85).
 *
 * Same reason as `panel-model.ts`: `node --test` has no DOM, so every wording
 * decision and every fallback lives here as a plain function over plain data and
 * is asserted directly (`tests/panel-bundle.test.js`), while the React view
 * (`hub.tsx`) only arranges it.
 *
 * TWO RULES THAT SHAPE THIS FILE:
 *
 *   1. The hub is a LIST, so "unknown" must be representable per row and per
 *      field (issue #85 review focus 3): a timed-out book, a directory that is
 *      gone, an unreadable catalog. A single "loading/error" state would hide
 *      the books that ARE answerable behind the one that is not.
 *   2. Paths are display data. The Host sends the canonical path and the home
 *      directory; `relativeToHome` shortens it to `~/…` for the card and the
 *      caller keeps the full path for the tooltip. Nothing here builds a
 *      request — the hub request carries no path at all (ADR-0010 D6).
 */

import type { InternalError, InternalResult } from './internal.js'

/** Panel id shared by the `sidebar.panellist` icon and the `main` body (ADR-0010 D1). */
export const HUB_PANEL_ID = 'inkflow-hub'

/** The visible name, the accessible name and the collapsed tooltip of the icon. */
export const HUB_PANEL_LABEL = 'InkFlow 书库'

/** Sidebar order: after the shipped seats, before the conversation view (40). */
export const HUB_PANEL_ORDER = 35

/**
 * The two entries this issue only reserves: the new-book wizard (#86) and the
 * shared-content page (#87). They render disabled with this release note —
 * a button that looks clickable and does nothing is worse than a disabled one.
 */
export const HUB_PLACEHOLDER_NOTE = '0.1.0 后续项'
export const HUB_NEW_BOOK_LABEL = '新开书'
export const HUB_SHARED_LABEL = '共享内容'

/** The hub's card texts. */
export const HUB_TEXTS = {
  title: '书库',
  refresh: '刷新',
  loading: '正在读取书单…',
  emptyTitle: '还没有书',
  emptyBody: '用下面的「新开书」创建（#86 提供）',
  emptyHint: 'DSH 的工作区就是书库的一行：把已存在的小说目录打开成工作区，这里就会出现它。',
  readOnly: '书库只读：不改目录、不建索引、不修复项目。',
} as const

/** The four gate states plus the hub's own "no verdict this time". */
export type HubBookState = 'usable' | 'needs-setup' | 'needs-repair' | 'needs-newer-plugin' | 'timeout'

/** Theme tones, rendered as `--dsw-alias-state-<tone>-primary`. */
export type HubBadgeTone = 'success' | 'warn' | 'error' | 'idle'

/**
 * `'timeout'` is not a fifth gate state: it means this answer has no verdict for
 * that book (the judgment exceeded the Host's 2 s budget, or threw). The badge
 * therefore reads as "unsure", never as "broken" — a refresh asks again.
 */
export const HUB_STATE_BADGES: Record<HubBookState, { label: string; tone: HubBadgeTone }> = {
  usable: { label: '可用', tone: 'success' },
  'needs-setup': { label: '待初始化', tone: 'warn' },
  'needs-repair': { label: '待修复', tone: 'warn' },
  'needs-newer-plugin': { label: '需升级插件', tone: 'error' },
  timeout: { label: '读取超时', tone: 'idle' },
}

const UNKNOWN_BADGE: { label: string; tone: HubBadgeTone } = { label: '状态未知', tone: 'idle' }

export type HubBookCounts = { chapters?: number; volumes?: number }

/** One row of `GET /inkflow/internal/hub/books` (only the fields the view reads). */
export interface HubBookRow {
  workspaceId?: string | null
  path?: string
  title?: string
  state?: string
  usable?: boolean
  missing?: string[]
  actions?: unknown[]
  dirStatus?: string
  counts?: HubBookCounts | null
  notABook?: boolean
  duplicates?: number
}

/** `GET /inkflow/internal/hub/books` → `value`. */
export interface HubBooksValue {
  home?: string
  total?: number
  capped?: boolean
  truncated?: boolean
  readOnly?: boolean
  books?: HubBookRow[]
}

/** What the view can render: an answerable list, or one reason it has none. */
export type HubState =
  | {
      status: 'ready'
      books: HubBookRow[]
      home: string | null
      total: number
      truncated: boolean
      capped: boolean
    }
  | { status: 'error'; message: string }

/** Route failures worth a sentence, so the panel does not print a bare code. */
export const HUB_ERROR_HINTS: Record<string, string> = {
  HUB_UNAVAILABLE: '这个 DSH 没有工作区注册表，书库读不到书单（HUB_UNAVAILABLE）',
  HUB_ROUTE_REQUIRED: '书库请求只允许走 /hub/*（面板内部错误）',
  'fetch-failed': '书库通道请求失败，检查 DSH 与插件的连接',
  'not-found': '这个版本的 Host 还没有书库路由，先更新插件并重启 DSH',
}

/** Message for a failed hub call: the hint table first, then the Host's words. */
export function describeHubError(error: InternalError | undefined): string {
  if (error === undefined) return '书库通道没有返回内容'
  return HUB_ERROR_HINTS[error.code] ?? error.message ?? error.code
}

/** Fold the channel result into one of the two renderable states. */
export function readHubBooks(result: InternalResult<HubBooksValue>): HubState {
  if (!result.ok || result.value === undefined) {
    return { status: 'error', message: describeHubError(result.error) }
  }
  const value = result.value
  const books = Array.isArray(value.books) ? value.books : []
  return {
    status: 'ready',
    books,
    home: typeof value.home === 'string' && value.home.trim() !== '' ? value.home : null,
    total: typeof value.total === 'number' && Number.isFinite(value.total) ? value.total : books.length,
    truncated: value.truncated === true,
    capped: value.capped === true,
  }
}

/** The badge for a row's state, with an "unknown" fallback for a newer Host. */
export function badgeOf(state: unknown): { label: string; tone: HubBadgeTone } {
  if (typeof state !== 'string') return UNKNOWN_BADGE
  return (HUB_STATE_BADGES as Record<string, { label: string; tone: HubBadgeTone }>)[state] ?? UNKNOWN_BADGE
}

/** `/`-spelled path without trailing separators, for comparisons only. */
function slashed(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/u, '')
}

/**
 * `~/…` for a path under the home directory, the full path otherwise.
 *
 * Case-insensitive on every platform: Windows paths differ only in case across
 * Host/Client spellings of the same directory, and a false negative here only
 * costs a longer label. The card keeps the full path in its tooltip either way.
 */
export function relativeToHome(path: string | undefined, home: string | null | undefined): string {
  if (typeof path !== 'string' || path.trim() === '') return ''
  if (typeof home !== 'string' || home.trim() === '') return path
  const target = slashed(path)
  const base = slashed(home)
  if (base === '') return path
  const lowerTarget = target.toLowerCase()
  const lowerBase = base.toLowerCase()
  if (lowerTarget === lowerBase) return '~'
  if (lowerTarget.startsWith(`${lowerBase}/`)) return `~/${target.slice(base.length + 1)}`
  return path
}

function countOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/**
 * `3 卷 · 128 章`, or `卷章数未知` when the committed catalog is missing.
 *
 * The Host never scans the chapter tree for the hub (ADR-0010 D8), so an absent
 * catalog means "not committed yet", not "no chapters".
 */
export function describeCounts(counts: HubBookCounts | null | undefined): string {
  const volumes = countOf(counts?.volumes)
  const chapters = countOf(counts?.chapters)
  if (volumes === null && chapters === null) return '卷章数未知'
  return `${volumes ?? 0} 卷 · ${chapters ?? 0} 章`
}

/**
 * The problems a card must say out loud, in a fixed order: a registration whose
 * directory is gone, a workspace that is not a book yet, and a directory
 * registered more than once.
 */
export function rowMarkers(row: HubBookRow): string[] {
  const markers: string[] = []
  if (row.dirStatus === 'missing-dir') markers.push('目录不在了')
  if (row.notABook === true) markers.push('不是书目录')
  const duplicates = countOf(row.duplicates)
  if (duplicates !== null && duplicates > 0) markers.push(`重复注册 ${duplicates} 次`)
  return markers
}

/** The card's title: the registry title, the directory name, or a placeholder. */
export function rowTitle(row: HubBookRow): string {
  if (typeof row.title === 'string' && row.title.trim() !== '') return row.title.trim()
  const path = typeof row.path === 'string' ? slashed(row.path) : ''
  const name = path.slice(path.lastIndexOf('/') + 1)
  return name === '' ? '（未命名）' : name
}

/** The header line above the cards: how many books, and whether it is complete. */
export function hubSummary(state: HubState): string {
  if (state.status === 'error') return '书库读不到'
  const shown = state.books.length
  if (state.total <= shown) return `共 ${state.total} 本`
  const reason = state.capped ? `最多显示 ${shown} 本` : `已判定 ${shown} 本`
  return `共 ${state.total} 本，${reason}${state.truncated ? '（本次未列全）' : ''}`
}

/** Whether a card should offer the "not a book yet" hint instead of counts. */
export function isBookRow(row: HubBookRow): boolean {
  return row.notABook !== true && row.dirStatus !== 'missing-dir'
}
