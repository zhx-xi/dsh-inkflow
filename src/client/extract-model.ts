/**
 * Pure view model for the candidate tab (#38, X-20).
 *
 * Everything here is a plain function over plain data, for the same reason
 * `trash-model.ts` and `audit-model.ts` are: `node --test` has no DOM, so a page's
 * decisions have to live in a module the tests can import. The component
 * (`extract.tsx`) only renders what these functions return.
 *
 * The wire shape comes from `GET /inkflow/internal/candidates` and carries two things
 * this file refuses to recompute:
 *
 *   * `locator` — the structured form of `evidence`. A click on "跳到第 7 行" must not
 *     re-parse `path#L7`; parsing it twice is how the two disagree the day a path
 *     contains a `#`.
 *   * `counts` — over the whole queue, not over the page. A page slice must never
 *     make the tab badge read "0 waiting" while three candidates are waiting.
 *
 * No IO, no React, no `@deepseek-ai/*`: the page talks to the Host only through
 * `./internal.js` (ADR-0008 D4 — a session id, never a directory).
 */

import type { InternalError, InternalResult } from './internal.js'

/** The six entity kinds extraction covers (ADR-0017 D2). */
export const EXTRACT_KINDS = ['character', 'foreshadowing', 'outline', 'relation', 'timeline', 'world'] as const
export type ExtractKind = (typeof EXTRACT_KINDS)[number]

/** What the reviewer can filter on. `all` is the panel's own value, never sent. */
export const CANDIDATE_STATUSES = ['proposed', 'accepted', 'rejected'] as const
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number]

/** Chinese labels — the panel is a Chinese surface; the wire stays English. */
export const KIND_LABELS: Record<string, string> = {
  character: '角色',
  world: '世界观',
  outline: '大纲',
  timeline: '时间线',
  foreshadowing: '伏笔',
  relation: '关系',
}

export const STATUS_LABELS: Record<string, string> = {
  proposed: '待审',
  accepted: '已采纳',
  rejected: '已拒绝',
}

/** `high` / `medium` / `low` → a word, not a number: a score would look like a promise. */
export const CONFIDENCE_LABELS: Record<string, string> = {
  high: '高',
  medium: '中',
  low: '低',
}

/** Where an evidence anchor points, as the Host sent it. */
export interface EvidenceLocator {
  kind: 'chapter' | 'path'
  chapterId?: string
  path?: string
  line?: number
}

/** One candidate as the channel reports it. */
export interface CandidateRow {
  candidateId: string
  kind: string
  fields: Record<string, unknown>
  evidence: string
  locator: EvidenceLocator | null
  rationale: string
  confidence: string
  status: string
  file: string
  submittedAt: string
}

export interface CandidateCounts {
  byStatus: Record<string, number>
  byKind: Record<string, number>
  proposedTotal: number
  total: number
}

export interface CandidateListValue {
  total?: number
  offset?: number
  limit?: number
  truncated?: boolean
  counts?: CandidateCounts
  items?: unknown[]
  issues?: Array<{ file?: string; detail?: string }>
  kinds?: string[]
  statuses?: string[]
}

/** The page's own state: what the filters are and which rows are ticked. */
export interface CandidatFilter {
  kind: string
  status: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asLocator(value: unknown): EvidenceLocator | null {
  const record = asRecord(value)
  if (record === undefined) return null
  if (record['kind'] === 'chapter') return { kind: 'chapter', chapterId: text(record['chapterId']) }
  if (record['kind'] === 'path') {
    const line = record['line']
    return { kind: 'path', path: text(record['path']), ...(typeof line === 'number' ? { line } : {}) }
  }
  return null
}

/** Fold one item; a row the panel cannot address is dropped rather than half-rendered. */
function asRow(value: unknown): CandidateRow | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const candidateId = text(record['candidateId'])
  if (candidateId === '') return undefined
  const fields = asRecord(record['fields']) ?? {}
  return {
    candidateId,
    kind: text(record['kind']),
    fields,
    evidence: text(record['evidence']),
    locator: asLocator(record['locator']),
    rationale: text(record['rationale']),
    confidence: text(record['confidence']),
    status: text(record['status']),
    file: text(record['file']),
    submittedAt: text(record['submittedAt']),
  }
}

export interface CandidateList {
  rows: CandidateRow[]
  total: number
  truncated: boolean
  counts: CandidateCounts
  /** Batch files the Host could not read; shown as a warning, never as an empty list. */
  issues: Array<{ file: string; detail: string }>
}

const EMPTY_COUNTS: CandidateCounts = { byStatus: {}, byKind: {}, proposedTotal: 0, total: 0 }

/** `GET /candidates` value → what the page renders. */
export function readCandidateList(value: CandidateListValue | null | undefined): CandidateList {
  if (value === null || value === undefined) {
    return { rows: [], total: 0, truncated: false, counts: EMPTY_COUNTS, issues: [] }
  }
  const rows = (Array.isArray(value.items) ? value.items : [])
    .map(asRow)
    .filter((row): row is CandidateRow => row !== undefined)
  const counts = asRecord(value.counts)
  const byStatus = asRecord(counts?.['byStatus']) ?? {}
  const byKind = asRecord(counts?.['byKind']) ?? {}
  const numeric = (record: Record<string, unknown>, key: string): number => {
    const raw = record[key]
    return typeof raw === 'number' ? raw : 0
  }
  const issues = (Array.isArray(value.issues) ? value.issues : []).map((issue) => ({
    file: text(asRecord(issue)?.['file']),
    detail: text(asRecord(issue)?.['detail']),
  }))
  return {
    rows,
    total: typeof value.total === 'number' ? value.total : rows.length,
    truncated: value.truncated === true,
    counts: {
      byStatus: Object.fromEntries(Object.entries(byStatus).map(([key, count]) => [key, typeof count === 'number' ? count : 0])),
      byKind: Object.fromEntries(Object.entries(byKind).map(([key, count]) => [key, typeof count === 'number' ? count : 0])),
      proposedTotal: numeric(counts ?? {}, 'proposedTotal'),
      total: numeric(counts ?? {}, 'total'),
    },
    issues,
  }
}

/** The one-line name of a candidate: what the reviewer reads first. */
export function candidateTitle(row: CandidateRow): string {
  for (const key of ['name', 'title']) {
    const value = row.fields[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  const source = row.fields['source']
  const target = row.fields['target']
  if (typeof source === 'string' && typeof target === 'string') return `${source} → ${target}`
  return row.candidateId
}

/** `role=主角 · group=白鹤门` — a bounded summary, because a card can hold eight fields. */
export function describeFields(row: CandidateRow, max = 4): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(row.fields)) {
    if (key === 'body' || key === 'name' || key === 'title') continue
    if (Array.isArray(value)) {
      const list = value.filter((item): item is string => typeof item === 'string')
      if (list.length > 0) parts.push(`${key}=${list.join('/')}`)
      continue
    }
    if (typeof value === 'string' && value.trim() !== '') parts.push(`${key}=${value.trim()}`)
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(`${key}=${String(value)}`)
  }
  const shown = parts.slice(0, max)
  if (parts.length > shown.length) shown.push(`…+${String(parts.length - shown.length)}`)
  return shown.join(' · ')
}

/** `chapters/vol-01/0001-a.md 第 7 行` / `第 3 章的 id` — the anchor in words. */
export function describeEvidence(row: CandidateRow): string {
  const locator = row.locator
  if (locator === null) return row.evidence
  if (locator.kind === 'chapter') return `章 id ${locator.chapterId ?? row.evidence}`
  const line = locator.line === undefined ? '' : ` 第 ${String(locator.line)} 行`
  return `${locator.path ?? row.evidence}${line}`
}

/** Where a click on the evidence row should go: a chapter (by id or by path) and a line. */
export interface EvidenceJump {
  kind: 'chapter'
  chapterId?: string
  path?: string
  line?: number
}

/** The jump for one candidate, or `null` when the panel cannot open it. */
export function evidenceTarget(row: CandidateRow): EvidenceJump | null {
  const locator = row.locator
  if (locator === null) return null
  if (locator.kind === 'chapter') {
    return locator.chapterId === undefined || locator.chapterId === '' ? null : { kind: 'chapter', chapterId: locator.chapterId }
  }
  if (locator.path === undefined || locator.path === '') return null
  return { kind: 'chapter', path: locator.path, ...(locator.line === undefined ? {} : { line: locator.line }) }
}

export function confidenceLabel(row: CandidateRow): string {
  return CONFIDENCE_LABELS[row.confidence] ?? row.confidence
}

export function statusLabel(row: CandidateRow): string {
  return STATUS_LABELS[row.status] ?? row.status
}

export function kindLabel(row: CandidateRow): string {
  return KIND_LABELS[row.kind] ?? row.kind
}

/** The same label for a bare kind string (the filter row's options). */
export function kindLabelOf(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

/** `3 待审 · 5 已采纳 · 1 已拒绝` — the queue's state, over everything the filter matched. */
export function describeCounts(counts: CandidateCounts): string {
  const proposed = counts.byStatus['proposed'] ?? 0
  const accepted = counts.byStatus['accepted'] ?? 0
  const rejected = counts.byStatus['rejected'] ?? 0
  return `${String(proposed)} 待审 · ${String(accepted)} 已采纳 · ${String(rejected)} 已拒绝`
}

/** The tab's badge number: candidates nobody has judged yet (never the page's). */
export function waitingCount(counts: CandidateCounts | null): number {
  return counts?.proposedTotal ?? 0
}

/** Rows a batch action may act on: only the ones still waiting for a decision. */
export function actionableIds(rows: readonly CandidateRow[], selected: ReadonlySet<string>): string[] {
  return rows.filter((row) => row.status === 'proposed' && selected.has(row.candidateId)).map((row) => row.candidateId)
}

/** Toggle one id in a selection, returning a new set (React state must not be mutated). */
export function toggleSelected(selected: ReadonlySet<string>, candidateId: string): Set<string> {
  const next = new Set(selected)
  if (next.has(candidateId)) next.delete(candidateId)
  else next.add(candidateId)
  return next
}

/** Select-all for a page: adds every waiting row, or clears them when all are already in. */
export function toggleAll(rows: readonly CandidateRow[], selected: ReadonlySet<string>): Set<string> {
  const waiting = rows.filter((row) => row.status === 'proposed').map((row) => row.candidateId)
  if (waiting.length === 0) return new Set(selected)
  const allSelected = waiting.every((id) => selected.has(id))
  const next = new Set(selected)
  for (const id of waiting) {
    if (allSelected) next.delete(id)
    else next.add(id)
  }
  return next
}

/**
 * A refusal, in the panel's words.
 *
 * Each code here means something different about what to do next — so each gets its own
 * sentence instead of a generic "操作失败".
 */
export const CANDIDATE_ERROR_HINTS: Record<string, string> = {
  EXTRACT_CONFIRM_REQUIRED: '采纳会写入实体文件：先看清候选，再点「确认采纳」',
  CANDIDATE_ALREADY_PROCESSED: '这条候选已经被处理过（采纳或拒绝），刷新后可以看到最新状态',
  CANDIDATE_NOT_PROCESSED: '还没判断过的候选不能清理：先采纳或拒绝它',
  CANDIDATE_NOT_FOUND: '这条候选已经不在了（可能已被清理），刷新列表',
  CANDIDATE_STORE_UNREADABLE: '候选目录里有读不了的文件，先修好它再操作',
  DUPLICATE_ID: '目标文件已经有实体了：采纳从不覆盖，请在设定库里编辑现有条目，或拒绝这条候选',
  CHARACTER_NAME_DUPLICATE: '这个角色名已被另一张卡占用（名字归一化后比较），先改名或拒绝',
  CHARACTER_ALIAS_DUPLICATE: '这个别名已被另一张卡占用，先改名或拒绝',
}

export function describeCandidateError(error: InternalError | undefined): string {
  if (error === undefined) return '面板通道没有返回内容'
  return CANDIDATE_ERROR_HINTS[error.code] ?? error.message ?? error.code
}

/**
 * The refusal's own words, when the Host answered 200 with per-candidate outcomes.
 *
 * A batch can half-succeed, so the page reports both halves: what landed, and the code
 * plus domain message for what did not. Losing the domain code here would turn
 * "CHARACTER_NAME_DUPLICATE" into "some candidates failed".
 */
export function describeOutcomes(value: unknown): { accepted: Array<{ candidateId: string; path: string }>; refused: Array<{ candidateId: string; code: string; message: string }> } {
  const record = asRecord(value)
  const outcomes = Array.isArray(record?.['outcomes']) ? (record['outcomes'] as unknown[]) : []
  const accepted: Array<{ candidateId: string; path: string }> = []
  const refused: Array<{ candidateId: string; code: string; message: string }> = []
  for (const item of outcomes) {
    const entry = asRecord(item)
    if (entry === undefined) continue
    const candidateId = text(entry['candidateId'])
    if (entry['accepted'] === true) {
      accepted.push({ candidateId, path: text(entry['path']) })
      continue
    }
    const error = asRecord(entry['error'])
    refused.push({ candidateId, code: text(error?.['code']), message: text(error?.['message']) })
  }
  return { accepted, refused }
}

/** `采纳 2 条 · 拒绝 8 条` — the batch's own summary line. */
export function describeOutcomeSummary(value: unknown): string | null {
  const record = asRecord(value)
  if (record === undefined) return null
  const accepted = record['accepted']
  const refused = record['refused']
  if (typeof accepted !== 'number' || typeof refused !== 'number') return null
  return `采纳 ${String(accepted)} 条 · 未采纳 ${String(refused)} 条`
}

/** Type guard for a value that came back from `writeInternal` without a shape. */
export function asValueRecord(result: InternalResult<unknown> | null): Record<string, unknown> | null {
  if (result === null || !result.ok) return null
  return asRecord(result.value) ?? null
}
