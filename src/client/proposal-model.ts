/**
 * The 提案 page's pure view model (#45, X-12): no React, no network, no IO.
 *
 * Everything the page decides with words or shapes lives here so it can be unit-tested
 * without a DOM: which state the page is in, what a hunk row says, which decisions a
 * button sends, and whether "apply" is allowed yet.
 *
 * The line that matters: **the page never re-derives a diff.** The Host sends each hunk
 * with its own `baseLines`/`nextLines` and its `status`; the page prints them. A second
 * diff implementation in the browser would be a second answer to "what will be written",
 * and the two would drift the first time either side changed a hunk boundary.
 */

/** One proposal row from `GET /proposal`. */
export interface ProposalRow {
  readonly proposalId: string
  readonly chapterId: string
  readonly path: string
  readonly title: string
  readonly createdAt: string
  readonly status: string
  readonly counts: ProposalCounts
  readonly label: string
  readonly note: string
  readonly decidedAt: string | null
  readonly appliedAt: string | null
  readonly rolledBackAt: string | null
  readonly backup: string | null
}

export interface ProposalCounts {
  readonly total: number
  readonly pending: number
  readonly accepted: number
  readonly rejected: number
}

/** One hunk as the page draws it. */
export interface HunkRow {
  readonly index: number
  readonly kind: string
  readonly status: string
  /** 1-based line number in the chapter body where this hunk starts. */
  readonly lineFrom: number
  readonly baseLines: readonly string[]
  readonly nextLines: readonly string[]
  readonly removed: number
  readonly added: number
}

/** The selected proposal, with its hunks. */
export interface ProposalDetail {
  readonly proposalId: string
  readonly path: string
  readonly title: string
  readonly status: string
  readonly counts: ProposalCounts
  readonly baseLines: number
  readonly eol: string
  readonly bom: boolean
  readonly hunks: readonly HunkRow[]
  readonly truncated: boolean
  readonly baseline: string | null
  readonly apply: { readonly backup: string; readonly at: string } | null
  readonly rollback: { readonly at: string; readonly verified: boolean } | null
}

/**
 * What the page can be showing. Three states plus "ready but nothing proposed":
 *
 *   * `failed` — the request itself failed (no session, network, 4xx/5xx);
 *   * `unreadable` — an answer arrived but its shape is not this build's;
 *   * `ready` — the answer parsed. Whether there is anything in it is a separate
 *     question (`rows.length === 0`), because "this book has no proposals yet" is a
 *     normal state and printing it as an error is how a page teaches the wrong thing.
 */
export type ProposalPhase = 'failed' | 'unreadable' | 'ready'

export interface ProposalPage {
  readonly phase: ProposalPhase
  readonly error: string | null
  readonly rows: readonly ProposalRow[]
  readonly total: number
  readonly truncated: boolean
  readonly open: number
  readonly applied: number
  readonly rolledBack: number
  readonly detail: ProposalDetail | null
}

const EMPTY: ProposalPage = {
  phase: 'failed',
  error: null,
  rows: [],
  total: 0,
  truncated: false,
  open: 0,
  applied: 0,
  rolledBack: 0,
  detail: null,
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function bool(value: unknown): boolean {
  return value === true
}

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function countsOf(raw: unknown): ProposalCounts {
  const counts = asRecord(raw)
  return {
    total: num(counts['total']),
    pending: num(counts['pending']),
    accepted: num(counts['accepted']),
    rejected: num(counts['rejected']),
  }
}

function rowOf(raw: unknown): ProposalRow | undefined {
  const row = asRecord(raw)
  const proposalId = str(row['proposalId'])
  if (proposalId === '') return undefined
  const source = asRecord(row['source'])
  return {
    proposalId,
    chapterId: str(row['chapterId']),
    path: str(row['path']),
    title: str(row['title']),
    createdAt: str(row['createdAt']),
    status: str(row['status']),
    counts: countsOf(row['counts']),
    label: str(source['label']),
    note: str(source['note']),
    decidedAt: row['decidedAt'] === null ? null : str(row['decidedAt']),
    appliedAt: row['appliedAt'] === null ? null : str(row['appliedAt']),
    rolledBackAt: row['rolledBackAt'] === null ? null : str(row['rolledBackAt']),
    backup: row['backup'] === null ? null : str(row['backup']),
  }
}

function hunkOf(raw: unknown): HunkRow | undefined {
  const hunk = asRecord(raw)
  const index = num(hunk['index'])
  if (index < 1) return undefined
  return {
    index,
    kind: str(hunk['kind']),
    status: str(hunk['status']),
    lineFrom: num(hunk['baseStart']) + 1,
    baseLines: strList(hunk['baseLines']),
    nextLines: strList(hunk['nextLines']),
    removed: num(hunk['removed']),
    added: num(hunk['added']),
  }
}

function detailOf(raw: unknown): ProposalDetail | null {
  const detail = asRecord(raw)
  const proposalId = str(detail['proposalId'])
  if (proposalId === '') return null
  const base = asRecord(detail['base'])
  const baseline = asRecord(detail['decisionBaseline'])
  const apply = asRecord(detail['apply'])
  const rollback = asRecord(detail['rollback'])
  const hunks = Array.isArray(detail['hunks']) ? detail['hunks'] : []
  return {
    proposalId,
    path: str(detail['path']),
    title: str(detail['title']),
    status: str(detail['status']),
    counts: countsOf(detail['counts']),
    baseLines: num(base['lines']),
    eol: str(base['eol']),
    bom: bool(base['bom']),
    hunks: hunks.map(hunkOf).filter((hunk): hunk is HunkRow => hunk !== undefined),
    truncated: bool(detail['detailTruncated']),
    baseline: str(baseline['sha256']) === '' ? null : str(baseline['sha256']),
    apply: str(apply['backup']) === '' ? null : { backup: str(apply['backup']), at: str(apply['at']) },
    rollback: rollback['at'] === undefined ? null : { at: str(rollback['at']), verified: bool(rollback['verified']) },
  }
}

/**
 * Fold one channel answer into the page state.
 *
 * `error` is the channel's own refusal (`{code, message, hint}`); it is rendered as text
 * rather than thrown, the same discipline every other page follows — a 409
 * `PROPOSAL_PENDING_HUNKS` is an instruction, not a crash.
 */
export function readProposalPage(
  result: { ok: boolean; value?: unknown; error?: { code?: string; message?: string; hint?: string } } | null,
  detailed = false,
): ProposalPage {
  if (result === null) return EMPTY
  if (!result.ok) {
    const error = result.error ?? {}
    const code = error.code === undefined || error.code === '' ? '未知错误' : error.code
    const message = error.message === undefined || error.message === '' ? '提案读取失败' : error.message
    return { ...EMPTY, phase: 'failed', error: `${message}（${code}）${error.hint === undefined ? '' : ` · ${error.hint}`}` }
  }
  const value = asRecord(result.value)
  if (Object.keys(value).length === 0) {
    return { ...EMPTY, phase: 'unreadable', error: '提案答案的形状不是这一版能读的（缺少 value）' }
  }
  const rawRows = value['proposals']
  if (!Array.isArray(rawRows)) {
    return { ...EMPTY, phase: 'unreadable', error: '提案答案里没有 proposals 列表' }
  }
  const rows = rawRows.map(rowOf).filter((row): row is ProposalRow => row !== undefined)
  if (rows.length !== rawRows.length) {
    return { ...EMPTY, phase: 'unreadable', error: '提案答案里有读不懂的行（缺 proposalId）' }
  }
  const counts = asRecord(value['counts'])
  const detail = detailed ? detailOf(value['detail']) : null
  return {
    phase: 'ready',
    error: null,
    rows,
    total: num(value['total']) || rows.length,
    truncated: bool(value['truncated']),
    open: num(counts['open']),
    applied: num(counts['applied']),
    rolledBack: num(counts['rolledBack']),
    detail,
  }
}

/** `proposal` / type label in Chinese; an unknown value is printed as it arrived. */
export function describeProposalStatus(status: string): string {
  switch (status) {
    case 'open':
      return '待决定'
    case 'applied':
      return '已应用'
    case 'rolled-back':
      return '已回滚'
    default:
      return status === '' ? '—' : status
  }
}

/** `accepted` / `rejected` / `pending` in Chinese. */
export function describeHunkStatus(status: string): string {
  switch (status) {
    case 'accepted':
      return '已接受'
    case 'rejected':
      return '已拒绝'
    case 'pending':
      return '待决定'
    default:
      return status === '' ? '—' : status
  }
}

/** `replace` / `insert` / `delete` in Chinese. */
export function describeHunkKind(kind: string): string {
  switch (kind) {
    case 'replace':
      return '改写'
    case 'insert':
      return '新增'
    case 'delete':
      return '删除'
    default:
      return kind === '' ? '—' : kind
  }
}

/** `第 12 行起 · 改写 · +3 −2 · 待决定` — one row's summary line. */
export function describeHunk(row: HunkRow): string {
  return `第 ${String(row.lineFrom)} 行起 · ${describeHunkKind(row.kind)} · +${String(row.added)} −${String(row.removed)} · ${describeHunkStatus(row.status)}`
}

/** `共 3 段：待定 3 · 接受 0 · 拒绝 0` */
export function describeCounts(counts: ProposalCounts): string {
  return `共 ${String(counts.total)} 段：待定 ${String(counts.pending)} · 接受 ${String(counts.accepted)} · 拒绝 ${String(counts.rejected)}`
}

/** The proposal list split at "still waiting on the author" vs "finished" (#199). */
export interface ProposalSplit {
  /** What the first screen shows: proposals that still need a decision. */
  readonly open: readonly ProposalRow[]
  /** `applied` + `rolled-back`: behind the fold, still openable, and the only cleanable ones. */
  readonly closed: readonly ProposalRow[]
  /** How many are finished **in the book**, which is not `closed.length` on a truncated page. */
  readonly closedCount: number
  readonly openCount: number
  readonly applied: number
  readonly rolledBack: number
}

/**
 * Split the inbox at the fold (#199).
 *
 * Two sources agree by construction: when the page holds the whole book the counts are the
 * rows' own, and when it does not (`truncated`) they come from the Host's full-population
 * `counts` — never from the rows, because a header that says "待决定 0" while the book has
 * three undecided proposals is worse than one that admits it only listed part of them.
 *
 * This is the fix for the old defect the issue names: `describeTotals` counted one thing and
 * the list drew another, so the header and the column could disagree about the same book.
 */
export function splitProposals(page: ProposalPage): ProposalSplit {
  const open = page.rows.filter((row) => row.status === 'open')
  const closed = page.rows.filter((row) => row.status !== 'open')
  const appliedFromRows = closed.filter((row) => row.status === 'applied').length
  const rolledBackFromRows = closed.filter((row) => row.status === 'rolled-back').length
  const applied = page.truncated ? page.applied : appliedFromRows
  const rolledBack = page.truncated ? page.rolledBack : rolledBackFromRows
  return {
    open,
    closed,
    openCount: page.truncated ? page.open : open.length,
    applied,
    rolledBack,
    closedCount: applied + rolledBack,
  }
}

/** `5 个提案：待决定 3 · 已结束 2（已应用 1 · 已回滚 1）`, from the same split the list draws. */
export function describeTotals(page: ProposalPage): string {
  const split = splitProposals(page)
  const head =
    `${String(page.total)} 个提案：待决定 ${String(split.openCount)} · 已结束 ${String(split.closedCount)}` +
    `（已应用 ${String(split.applied)} · 已回滚 ${String(split.rolledBack)}）`
  return page.truncated ? `${head} · 本页列出 ${String(page.rows.length)} 个` : head
}

/** `已结束（2）` — the fold's label, so the number is on the row that hides them. */
export function describeClosedGroup(split: ProposalSplit): string {
  return `已结束（${String(split.closedCount)}）`
}

/** Whether a row may be cleaned up: only what the author has finished with (#199). */
export function cleanable(status: string): boolean {
  return status === 'applied' || status === 'rolled-back'
}

/** The row the page should select first: the newest open proposal, else the newest. */
export function preferredProposalId(page: ProposalPage): string | null {
  const open = page.rows.find((row) => row.status === 'open')
  return (open ?? page.rows[0])?.proposalId ?? null
}

/**
 * Whether "应用" may be pressed, and why not.
 *
 * The Host refuses these three cases too; the page greys the button for the same reasons
 * so the author is not walked into a refusal. Neither side is decorative: the button is
 * the hint, the Host is the rule.
 */
export function applyBlocked(counts: ProposalCounts, status: string): string | null {
  if (status !== 'open') return status === 'applied' ? '这个提案已经应用过了；要改回去用「回滚」' : '这个提案已经回滚，不能再应用'
  if (counts.pending > 0) return `还有 ${String(counts.pending)} 段没有决定——未决定的段不会被写入`
  if (counts.accepted === 0) return '每一段都被拒绝了，没有可写入的内容'
  return null
}

/** The two-step confirm's first label, so a mis-click cannot rewrite a chapter. */
export function applyActionLabel(armed: boolean): string {
  return armed ? '确认写入（会改正文）' : '应用到正文'
}

/** The rollback half of the same rule. */
export function rollbackBlocked(status: string): string | null {
  if (status === 'applied') return null
  return status === 'rolled-back' ? '这个提案已经回滚过一次' : '只有已应用的提案可以回滚'
}

export function rollbackActionLabel(armed: boolean): string {
  return armed ? '确认回滚（逐字节还原）' : '回滚这次应用'
}

/** One decision, in the shape both the route and the tool take. */
export interface Decision {
  readonly index: number
  readonly status: 'accepted' | 'rejected' | 'pending'
}

/** `acceptAll` / `rejectAll`: decisions for every hunk still waiting. */
export function pendingDecisions(hunks: readonly HunkRow[], status: 'accepted' | 'rejected'): Decision[] {
  return hunks.filter((hunk) => hunk.status === 'pending').map((hunk) => ({ index: hunk.index, status }))
}

/** One hunk's verdict, for the row's own button. */
export function decisionFor(index: number, status: 'accepted' | 'rejected' | 'pending'): Decision {
  return { index, status }
}

/** Body of `POST /proposal/decide`. */
export function decidePayload(proposalId: string, decisions: readonly Decision[]): Record<string, unknown> {
  return { proposalId, decisions: decisions.map((decision) => ({ index: decision.index, status: decision.status })) }
}

/** Body of `POST /proposal/apply` / `POST /proposal/rollback`. */
export function confirmPayload(proposalId: string): Record<string, unknown> {
  return { proposalId, confirm: true }
}

/** `GET /proposal?proposalId=…` for one proposal's hunks. */
export function detailRequestPath(proposalId: string | null): string {
  return proposalId === null ? '/proposal' : `/proposal?proposalId=${encodeURIComponent(proposalId)}`
}

/**
 * What the page says after a decide/apply/rollback: the code translated to an action.
 *
 * A refusal's code is the most useful thing on the screen ("FILE_CHANGED" means "your
 * edit was kept"), so every code this feature can emit has its own sentence; anything
 * else keeps the message the Host sent.
 */
export interface OutcomeLike {
  ok: boolean
  error?: { code?: string; message?: string; hint?: string }
}

export function describeOutcome(
  action: 'decide' | 'apply' | 'rollback',
  result: OutcomeLike | null,
  successText: string,
): string {
  if (result === null) return ''
  if (result.ok) return successText
  const code = result.error?.code ?? ''
  const message = result.error?.message ?? ''
  switch (code) {
    case 'FILE_CHANGED':
      return '章节在你做决定之后被改过（FILE_CHANGED）：你的改动被保留，什么都没写。重新生成提案再逐段决定。'
    case 'PROPOSAL_PENDING_HUNKS':
      return '还有段落没决定：未决定的段不会被写入，所以这次应用被拒绝。'
    case 'PROPOSAL_NOTHING_ACCEPTED':
      return '每一段都被拒绝了，没有可写入的内容。'
    case 'BACKUP_CONFLICT':
      return '应用之后章节又被改过，回滚不会覆盖你的新正文（BACKUP_CONFLICT）。'
    case 'CONFIRM_REQUIRED':
      return '这一步会改正文，需要再点一次确认。'
    case 'PROPOSAL_NOT_FOUND':
      return '这个提案在书里已经找不到了（可能被清掉）。'
    case 'PROPOSAL_STATUS':
      return `${action === 'rollback' ? '只有已应用的提案可以回滚' : '这个提案的状态不允许这一步'}。`
    case 'NO_SESSION_CONTEXT':
      return '面板还没有绑定到会话：从一本小说的会话里打开 InkFlow。'
    default:
      return message === '' ? `${action} 失败（${code === '' ? '未知错误' : code}）` : `${message}（${code}）`
  }
}

/** The page's one-line explanation of where proposals land, printed in the header. */
export const PROPOSAL_NOTE =
  '提案落在书的 .inkflow/proposals/ 里：未确认的提案一个字节都不会写进正文；应用前自动开备份包，回滚逐字节还原。'
