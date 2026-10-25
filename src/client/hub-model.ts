/**
 * Pure view model for the book hub (ADR-0010 D1/D8).
 *
 * Same reason as `panel-model.ts`: `node --test` has no DOM, so every wording
 * decision and every fallback lives here as a plain function over plain data and
 * is asserted directly (`tests/panel-bundle.test.js`), while the React view
 * (`hub.tsx`) only arranges it.
 *
 * TWO RULES THAT SHAPE THIS FILE:
 *
 *   1. The hub is a LIST, so "unknown" must be representable per row and per
 *      field: a timed-out book, a directory that is
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
 * The shared-content page was the one entry reserved here before it existed. The
 * new-book wizard became a real button first, so this one stayed disabled
 * with its release note — a button that looks clickable and does nothing is
 * worse than a disabled one.
 */
export const HUB_PLACEHOLDER_NOTE = '0.1.0 后续项'
export const HUB_SHARED_LABEL = '共享内容'

/** The hub's card texts. */
export const HUB_TEXTS = {
  title: '书库',
  refresh: '刷新',
  loading: '正在读取书单…',
  emptyTitle: '还没有书',
  emptyBody: '用上面的「新开书」创建，或选中一本已有书的目录把它导入',
  emptyHint: 'DSH 的工作区就是书库的一行：把已存在的小说目录打开成工作区，这里就会出现它。',
  readOnly: '书单只读：不改目录、不建索引、不修复项目；书库唯一会写盘的是「新开书」，且只在你确认之后。',
  /**
   * The fold's one sentence. It has to say the loop is closed: the directory is not
   * lost, it is one prompt away from becoming a book, and the prompt carries its own path.
   */
  othersHint: '这些目录还不是书。点「复制提示词」，把那段话发给任意会话，让 AI 走一遍初始化向导——目录不用你手动打开。',
  initCopy: '复制提示词',
  initCopied: '提示词已复制，发给任意会话即可',
  initFallback: '剪贴板被拦下了：下面这段已全选，按 Ctrl+C 复制',
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

// ---------------------------------------------------------------------------
// Two groups, not one list: "still a book" vs "other directories"
//
// The hub is one row per registered workspace, so a machine with two books and five
// ordinary directories showed seven "books". Filtering "everything that is not usable"
// would be worse than the noise: `needs-repair` and `needs-newer-plugin` ARE books, and
// losing them reads as "我的书不见了". So the split is:
//
//   main list  — the four verdicts that mean "this is a book" (including the two broken ones
//                and `timeout`, which is merely "no verdict this time");
//   other dirs — `needs-setup` / `notABook` / a registration whose directory is gone, folded
//                away by default and still explained row by row.
// ---------------------------------------------------------------------------

/** The gate outcomes that are a book. `needs-setup` and the two not-a-book markers are not. */
export const HUB_MAIN_STATES = ['usable', 'needs-repair', 'needs-newer-plugin', 'timeout'] as const

/**
 * Whether a row belongs in the main list.
 *
 * The directory check comes FIRST, on purpose: a registration whose directory was deleted
 * reports whatever gate verdict the missing path produces, and none of them makes it a book
 * the user can open. A row with an unknown state (a newer Host) folds away rather than
 * appearing as a book nobody can act on.
 */
export function isMainListRow(row: HubBookRow | null | undefined): boolean {
  if (row === null || row === undefined || typeof row !== 'object') return false
  if (row.dirStatus === 'missing-dir') return false
  if (row.notABook === true) return false
  const state = typeof row.state === 'string' ? row.state : ''
  return (HUB_MAIN_STATES as readonly string[]).includes(state)
}

export interface HubRowGroups {
  main: HubBookRow[]
  others: HubBookRow[]
}

/**
 * Split the answer into what is shown and what is folded.
 *
 * Order is preserved on both sides (the registry order is the user's own), and the input is
 * never mutated: the view keeps rendering `state.books` and derives the two lists from it.
 */
export function splitHubRows(books: HubBookRow[] | null | undefined): HubRowGroups {
  const main: HubBookRow[] = []
  const others: HubBookRow[] = []
  for (const row of Array.isArray(books) ? books : []) {
    if (row === null || typeof row !== 'object') continue
    if (isMainListRow(row)) main.push(row)
    else others.push(row)
  }
  return { main, others }
}

/** The fold's summary line: `其他目录（5）`. A count that is not a count renders as 0. */
export function othersHeading(count: unknown): string {
  const shown = typeof count === 'number' && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  return `其他目录（${String(shown)}）`
}

/** `chapters`, not `chapters/.gitkeep`: the checklist names both, the sentence needs one. */
function missingNames(missing: string[]): string[] {
  const names: string[] = []
  for (const entry of missing) {
    if (typeof entry !== 'string' || entry.trim() === '') continue
    const base = entry.split('/')[0] ?? ''
    if (base !== '' && !names.includes(base)) names.push(base)
  }
  return names
}

/**
 * Why a folded row is not a book, in one line.
 *
 * "目录不在了" stays in the answer even though the row is folded: a registration the user
 * forgot about is useful information, and deleting it silently would be the plugin deciding
 * what the user meant.
 */
export function whyNotABook(row: HubBookRow | null | undefined): string {
  if (row === null || row === undefined) return '还不是书'
  if (row.dirStatus === 'missing-dir') return '目录不在了（注册还在，插件不会自动移除它）'
  if (row.notABook === true) return '不是书：没有 inkflow.json，也没有内容目录'
  const missing = Array.isArray(row.missing) ? row.missing : []
  if (missing.length === 0) return '还不是书：门禁没说它缺什么'
  const names = missingNames(missing)
  const preview = names.slice(0, 3).join('、')
  return `还不是书：缺 ${String(missing.length)} 项（${preview}${names.length > 3 ? '…' : ''}）`
}

// ---------------------------------------------------------------------------
// The init prompt: ONE constant, filled per row
//
// Why a constant instead of wording in the JSX and again in the guide: two copies drift
// within weeks (the tool count and the whitelists both did). The guide quotes the rendered
// output of this template, and `tests/hub-groups.test.js` asserts the two stay identical.
//
// Why the tool name is tagged `<tool>…</tool>`: the prompt is pasted into a session where a
// model reads it, and the tag is what tells the model "this is the call to make" instead of
// "this is a topic" — the failure mode being a session that cheerfully explains how to
// initialise a project without ever calling `inkflow_project_init`.
//
// Why the three boundaries are spelled out: the wizard's own contract (ADR-0006 D3) is
// plan → apply with `confirm: true`, missing items only, and `git init` without commit or
// remote. A prompt that omits them invites a session to improvise all three.
// ---------------------------------------------------------------------------

/** The placeholder the template carries until a row fills it in. */
export const INIT_PROMPT_PATH_SLOT = '{{path}}'
export const INIT_PROMPT_TITLE_SLOT = '{{title}}'

export const INIT_PROMPT_TEMPLATE = `把下面这个目录初始化成 InkFlow 项目：

目录：${INIT_PROMPT_PATH_SLOT}
书名：${INIT_PROMPT_TITLE_SLOT}

请用 <tool>inkflow_project_init</tool> 来做。书名就用目录名，作者留空，回头可以在 inkflow.json 里改。

三条边界请守住：

1. 先 plan 后 apply：先调 inkflow_project_init 的 plan（只读，列出将要创建什么）给我看，我确认之后再带 confirm: true 走 apply。
2. 只补缺失项，不覆盖：目录里已经有的文件一个字节都不要改。
3. 只做 git init：不 commit、不配远端、不改我的 git 身份。

弄好之后把目录的绝对路径告诉我，我在 DSH 里把它打开成工作区。`

/** The prompt for one row: the row's own absolute path and directory name, nothing typed. */
export function buildInitPrompt(row: HubBookRow | null | undefined): string {
  const path = typeof row?.path === 'string' && row.path.trim() !== '' ? row.path.trim() : '（这一行没有路径）'
  const title = rowTitle(row ?? {})
  return INIT_PROMPT_TEMPLATE.replaceAll(INIT_PROMPT_PATH_SLOT, path).replaceAll(INIT_PROMPT_TITLE_SLOT, title)
}

// ---------------------------------------------------------------------------
// Copying: never a button that does nothing
//
// The hub rides in the Electron renderer, where `navigator.clipboard.writeText` can be
// refused (permissions, a non-secure context, a policy). The decision is therefore data —
// `copied` or `fallback` — and the view renders a read-only textarea for the second case
// instead of pretending the copy happened.
// ---------------------------------------------------------------------------

/** The clipboard surface this module needs. `navigator.clipboard` satisfies it. */
export interface ClipboardLike {
  writeText?: unknown
}

export type CopyOutcome = 'copied' | 'fallback'

/**
 * Try the clipboard, report what happened.
 *
 * Never throws: a rejected promise, a synchronous throw and a missing/non-function
 * `writeText` are all `fallback`, because the caller's job in every one of those cases is
 * the same — show the text so it can still be selected.
 */
export async function copyPrompt(text: string, clipboard: ClipboardLike | null | undefined): Promise<CopyOutcome> {
  const write = clipboard !== null && typeof clipboard === 'object' ? clipboard.writeText : undefined
  if (typeof write !== 'function') return 'fallback'
  try {
    await (write as (value: string) => unknown).call(clipboard, text)
    return 'copied'
  } catch {
    return 'fallback'
  }
}
