/**
 * Pure view model for the series sync section of the shared-content page.
 *
 * Same reason as `hub-shared-model.ts`: `node --test` has no DOM, so every wording
 * decision and every "may I press that" rule lives here as a plain function over plain
 * data and is asserted from `tests/panel-bundle.test.js`, while `series-sync.tsx` only
 * arranges it.
 *
 * THREE RULES THIS FILE ENCODES, because each one is a way the panel could lose data:
 *
 *   1. **An unresolved conflict blocks the button.** `applyBlockedReason` is the single
 *      answer to "why can I not sync yet", and it answers for the conflicts first: the
 *      Host refuses the whole run when one is undecided (`SERIES_CONFLICT_UNRESOLVED`,
 *      zero writes), so a button that looked pressable would only produce that refusal.
 *   2. **The plan travels with the request.** `applyPayload` hands back the plan's own
 *      `expected` rows: the Host compares them and skips anything that drifted
 *      (`SERIES_PLAN_STALE`). A payload built from the decisions alone would let the
 *      panel write a diff the author never saw.
 *   3. **`unchanged` is not a task.** The group is rendered so the author can see the
 *      whole picture, and it never carries a control: those files are not rewritten.
 */

import type { InternalError, InternalResult } from './internal.js'

/** The four actions, in the order the section shows them (a plan is read top-down). */
export const SERIES_ACTION_ORDER = ['conflict', 'create', 'update', 'unchanged'] as const
export type SeriesActionName = (typeof SERIES_ACTION_ORDER)[number]

/** Human names for the four actions. */
export const SERIES_ACTION_LABELS: Record<SeriesActionName, string> = {
  create: '新建',
  update: '更新',
  conflict: '冲突',
  unchanged: '无需改动',
}

/** Why a conflict is a conflict — the Host's own vocabulary, spelled out. */
export const SERIES_CONFLICT_LABELS: Record<string, string> = {
  'book-diverged': '本书改过、共享库没动',
  'unrelated-file': '本书里的同名文件不是这条的副本',
  'source-unreadable': '共享库那一侧读不出来',
}

/** The three decisions, and what each one does in one line. */
export const SERIES_DECISION_LABELS: Record<string, string> = {
  'take-shared': '采用共享库',
  'keep-book': '保留本书',
  skip: '跳过',
}

export const SERIES_DECISION_HINTS: Record<string, string> = {
  'take-shared': '用共享库的正文覆盖本书文件（先写备份包，可回滚）',
  'keep-book': '本书文件不动，共享库那一版不要',
  skip: '这次什么都不做，留在下次同步再看',
}

/** Everything this section prints. One place, so the bundle assertions are meaningful. */
export const SERIES_TEXTS = {
  title: '系列同步',
  hint: '把共享库里的设定（world/、library/）显式同步进这本书：先预览，逐条裁决冲突，再确认写入。共享库只读。',
  noBook: '先在上面选一本书，再预览同步。',
  plan: '预览同步',
  planning: '正在比对…',
  replan: '重新预览',
  apply: '应用同步',
  confirmApply: '确认写入',
  cancel: '取消',
  working: '正在写入…',
  blockedNoBook: '还没有选书',
  blockedNoPlan: '先预览一次同步',
  blockedUnresolved: '有冲突还没有裁决',
  blockedNothing: '这次没有需要写入的条目',
  emptyPlan: '共享库里没有可同步的设定条目（world/ 与 library/）。',
  unchangedNote: '这些条目两边已经一致，写入时不会重写（字节与修改时间不变）。',
  staleNote: '有条目在预览之后变了，已被跳过；重新预览再确认。',
  audit: '运行记录',
  backup: '回滚包',
} as const

/** One plan row, as the panel reads it (only the fields the page uses). */
export interface SeriesPlanRow {
  entryId?: string
  kind?: string
  sourcePath?: string
  targetPath?: string
  action?: string
  sharedDigest?: string
  bookDigest?: string
  changedFields?: string[]
  conflict?: string
}

/** `GET /hub/series/plan?book=…` → `value`. */
export interface SeriesPlanValue {
  seriesId?: string | null
  counts?: Record<string, number>
  entries?: SeriesPlanRow[]
  expected?: Array<{ entryId?: string; action?: string }>
  excluded?: { byKind?: Record<string, number>; reference?: number; unhashable?: number }
  truncated?: boolean
}

/** `POST /hub/series/apply` → `value`. */
export interface SeriesApplyValue {
  written?: Array<{ entryId?: string; path?: string; action?: string }>
  kept?: Array<{ entryId?: string; path?: string }>
  skipped?: Array<{ entryId?: string; path?: string; code?: string }>
  counts?: Record<string, number>
  auditPath?: string
  backupDir?: string
}

/** The decision a row currently carries, keyed by entryId. */
export type SeriesDecisions = Readonly<Record<string, string>>

/** The plan's three renderable states. */
export type SeriesPlanState =
  | { status: 'idle'; message: string }
  | { status: 'error'; message: string }
  | {
      status: 'ready'
      seriesId: string | null
      rows: SeriesPlanRow[]
      counts: Record<string, number>
      expected: Array<{ entryId: string; action: string }>
      excluded: string[]
      truncated: boolean
    }

const PLAN_ERROR_HINTS: Record<string, string> = {
  SHARED_UNAVAILABLE: '读不到插件数据目录，共享库无法定位（SHARED_UNAVAILABLE）',
  HUB_ROUTE_REQUIRED: '系列同步请求只允许走 /hub/*（面板内部错误）',
  'fetch-failed': '共享内容通道请求失败，检查 DSH 与插件的连接',
  'not-found': '这个版本的 Host 还没有系列同步路由，先更新插件并重启 DSH',
  BOOK_REQUIRED: '先在上面选一本书',
  BOOK_NOT_REGISTERED: '这本书不在书库里（先用书单打开它）',
  BOOK_NOT_USABLE: '这本书还不能写入：先修好它（书单里能看到缺什么）',
  SERIES_CONFLICT_UNRESOLVED: '还有冲突没有裁决，这次一条都没写',
  SERIES_PLAN_REQUIRED: '写之前要先预览一次（面板内部错误）',
  SERIES_PLAN_STALE: '预览之后有东西变了，请重新预览',
  SERIES_DECISION_INVALID: '有一条裁决不是 take-shared / keep-book / skip',
  SHARED_PATH_INVALID: '共享条目无法映射进本书目录',
  SHARED_SOURCE_UNREADABLE: '共享库那一侧的文件读不出来了',
  SHARED_SOURCE_NOT_UTF8: '共享条目不是 UTF-8，无法按文本同步',
  CONFIRM_REQUIRED: '这次写入需要确认（先点确认按钮）',
}

export function describeSeriesError(error: InternalError | undefined): string {
  if (error === undefined) return '系列同步通道没有返回内容'
  return PLAN_ERROR_HINTS[error.code] ?? error.message ?? error.code
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : []
}

/**
 * Fold the plan answer into a renderable state.
 *
 * `expected` is rebuilt from the ROWS when the Host did not send it: the payload rule is
 * "hand back what the preview showed", and a missing array must not become "send nothing"
 * (which the Host refuses with `SERIES_PLAN_REQUIRED` and the author cannot fix).
 */
export function readSeriesPlan(result: InternalResult<SeriesPlanValue>): SeriesPlanState {
  if (!result.ok || result.value === undefined) {
    return { status: 'error', message: describeSeriesError(result.error) }
  }
  const value = result.value
  const rows = Array.isArray(value.entries) ? value.entries : []
  const expected = Array.isArray(value.expected)
    ? value.expected
        .map((row) => ({ entryId: typeof row.entryId === 'string' ? row.entryId : '', action: typeof row.action === 'string' ? row.action : '' }))
        .filter((row) => row.entryId !== '' && row.action !== '')
    : rows
        .map((row) => ({ entryId: typeof row.entryId === 'string' ? row.entryId : '', action: typeof row.action === 'string' ? row.action : '' }))
        .filter((row) => row.entryId !== '' && row.action !== '')
  const counts: Record<string, number> = {}
  for (const action of SERIES_ACTION_ORDER) counts[action] = countOf(value.counts?.[action])
  const excluded: string[] = []
  const byKind = value.excluded?.byKind ?? {}
  for (const [kind, count] of Object.entries(byKind)) excluded.push(`${kind} ${countOf(count)} 条`)
  const reference = countOf(value.excluded?.reference)
  if (reference > 0) excluded.push(`引用卡 ${reference} 条（只读）`)
  const unhashable = countOf(value.excluded?.unhashable)
  if (unhashable > 0) excluded.push(`无法计算摘要 ${unhashable} 条`)
  return {
    status: 'ready',
    seriesId: typeof value.seriesId === 'string' && value.seriesId !== '' ? value.seriesId : null,
    rows,
    counts,
    expected,
    excluded,
    truncated: value.truncated === true,
  }
}

/** The one line under the title: how many rows of each kind, and whether the list is complete. */
export function seriesSummary(state: SeriesPlanState): string {
  if (state.status === 'idle') return state.message
  if (state.status === 'error') return '同步预览失败'
  const parts = SERIES_ACTION_ORDER.filter((action) => countOf(state.counts[action]) > 0).map(
    (action) => `${SERIES_ACTION_LABELS[action]} ${countOf(state.counts[action])}`,
  )
  const headline = parts.length === 0 ? '没有可同步的条目' : parts.join(' · ')
  return state.truncated ? `${headline}（未列全：已达扫描上限）` : headline
}

/** Rows grouped by action, conflict first — the group that needs the author is on top. */
export function seriesGroups(state: SeriesPlanState): Array<{ action: SeriesActionName; label: string; rows: SeriesPlanRow[] }> {
  if (state.status !== 'ready') return []
  return SERIES_ACTION_ORDER.map((action) => ({
    action,
    label: SERIES_ACTION_LABELS[action],
    rows: state.rows.filter((row) => row.action === action),
  })).filter((group) => group.rows.length > 0)
}

/** `entryId` of a row — the key every decision and every plan comparison uses. */
export function rowId(row: SeriesPlanRow | undefined): string {
  return typeof row?.entryId === 'string' ? row.entryId : ''
}

/** The conflicts the plan still lists, in plan order. */
export function conflictRows(state: SeriesPlanState): SeriesPlanRow[] {
  if (state.status !== 'ready') return []
  return state.rows.filter((row) => row.action === 'conflict')
}

/** Conflicts with no decision yet — the whole reason `apply` would be refused. */
export function unresolvedConflicts(state: SeriesPlanState, decisions: SeriesDecisions): SeriesPlanRow[] {
  return conflictRows(state).filter((row) => {
    const choice = decisions[rowId(row)]
    return choice !== 'take-shared' && choice !== 'keep-book' && choice !== 'skip'
  })
}

/**
 * Why the apply button cannot be pressed, or `null` when it can.
 *
 * Ordered by what the author has to do next: choose a book, preview, decide the
 * conflicts — and only then "there is nothing to write", which is not a problem at all.
 */
export function applyBlockedReason(state: SeriesPlanState, decisions: SeriesDecisions, book: string): string | null {
  if (book === '') return SERIES_TEXTS.blockedNoBook
  if (state.status === 'idle') return SERIES_TEXTS.blockedNoPlan
  if (state.status === 'error') return state.message
  const unresolved = unresolvedConflicts(state, decisions)
  if (unresolved.length > 0) {
    return `${SERIES_TEXTS.blockedUnresolved}：${unresolved.map((row) => String(row.targetPath ?? rowId(row))).join('、')}`
  }
  const actionable = state.rows.filter((row) => row.action === 'create' || row.action === 'update').length
  const taken = conflictRows(state).filter((row) => decisions[rowId(row)] === 'take-shared').length
  if (actionable + taken === 0) return SERIES_TEXTS.blockedNothing
  return null
}

/**
 * The apply payload: the book, the plan's own rows, the decisions, and `confirm`.
 *
 * `confirm: true` appears only here, i.e. only on the path that follows the author's own
 * press — the same two-step discipline the shared-library page keeps.
 */
export function applyPayload(
  state: SeriesPlanState,
  decisions: SeriesDecisions,
  book: string,
): { book: string; expected: Array<{ entryId: string; action: string }>; decisions: Array<{ entryId: string; decision: string }>; confirm: true } {
  const expected = state.status === 'ready' ? state.expected : []
  const chosen = expected
    .filter((row) => row.action === 'conflict')
    .map((row) => ({ entryId: row.entryId, decision: decisions[row.entryId] ?? '' }))
    .filter((row) => row.decision !== '')
  return { book, expected, decisions: chosen, confirm: true }
}

/** One line per applied row: what was written, kept, or skipped. */
export function describeApplyResult(value: SeriesApplyValue | undefined): string[] {
  if (value === undefined) return []
  const lines: string[] = []
  for (const row of Array.isArray(value.written) ? value.written : []) {
    lines.push(`已写入 ${String(row.path ?? '')}`)
  }
  for (const row of Array.isArray(value.kept) ? value.kept : []) {
    lines.push(`保留本书 ${String(row.path ?? '')}`)
  }
  const skipped = Array.isArray(value.skipped) ? value.skipped : []
  for (const row of skipped) {
    lines.push(
      row.code === 'SERIES_PLAN_STALE'
        ? `跳过（预览之后变了）${String(row.path ?? row.entryId ?? '')}`
        : `跳过（按裁决）${String(row.path ?? row.entryId ?? '')}`,
    )
  }
  if (lines.length === 0) lines.push('没有写任何文件。')
  if (skipped.some((row) => row.code === 'SERIES_PLAN_STALE')) lines.push(SERIES_TEXTS.staleNote)
  if (typeof value.auditPath === 'string' && value.auditPath !== '') {
    lines.push(`${SERIES_TEXTS.audit}：${value.auditPath}`)
  }
  if (typeof value.backupDir === 'string' && value.backupDir !== '') {
    lines.push(`${SERIES_TEXTS.backup}：${value.backupDir}`)
  }
  return lines
}

/** `changed fields` → the words a reader understands, for one row. */
export function describeChangedFields(row: SeriesPlanRow): string {
  return stringList(row.changedFields).join(', ')
}
