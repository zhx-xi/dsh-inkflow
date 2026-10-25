/**
 * The review page's pure model — no React, no network, no IO, so the panel's
 * decisions are unit-testable (the rule `architecture.md` §6.2 states for every
 * `*-model.ts`).
 *
 * What lives here and why each piece is a decision rather than plumbing:
 *
 *   * **three states** — `loading` / `error` / `ready`. "No runs yet" is *not* a fourth
 *     state: it is `ready` with `runCount === 0`, because the page must still offer the
 *     chapter selector and the explanation of what a run is. A dedicated empty state would
 *     hide the very control the reader needs to get out of it.
 *   * **`located` and `locator` are one fact** — the jump is offered exactly when the Host
 *     said the opinion has a locator, and the jump reuses `EvidenceJump`, the shape the
 *     candidate page already sends through `openFromEvidence`. No second jump protocol: an
 *     address is resolved by the workbench, which is the only component that knows which
 *     chapter is which.
 *   * **the comparison table is the Host's Markdown** — the panel prints the string it was
 *     handed instead of rendering its own table. Two renderings of one table is how a panel
 *     and an export start disagreeing about the same numbers.
 */

import type { EvidenceJump } from './extract-model.js'
import type { InternalResult } from './internal.js'

/** The page's three states. Anything else would be a second way to say "not ready". */
export type ReviewPanelState = 'loading' | 'error' | 'ready'

/** One recorded run, as the list prints it. */
export interface ReviewRunRow {
  readonly runId: string
  readonly reviewer: string
  readonly createdAt: string
  readonly opinions: number
  readonly located: number
  readonly failed: number
  readonly skipped: number
  readonly scores: Readonly<Record<string, number>> | null
}

/** One opinion, flattened for the view. */
export interface ReviewOpinionView {
  readonly dimension: string
  readonly code: string
  readonly severity: string
  readonly located: boolean
  readonly where: string
  readonly unlocatedReason: string
  readonly unlocatedDetail: string
  readonly detail: string
  readonly hint: string
  readonly before: string
  readonly quote: string
  readonly after: string
  readonly paragraph: number | null
  readonly offset: number
  readonly jump: EvidenceJump | null
}

/** One dimension's row in the selected run. */
export interface ReviewDimensionView {
  readonly dimension: string
  readonly label: string
  readonly status: string
  readonly opinions: number
  readonly located: number
  readonly code: string
  readonly message: string
  readonly anchors: readonly { readonly key: string; readonly value: string }[]
  readonly items: readonly ReviewOpinionView[]
}

export interface ReviewValue {
  readonly chapterId: string
  readonly chapterTitle: string
  readonly wordCount: number
  readonly paragraphCount: number
  readonly recordDir: string
  readonly runCount: number
  readonly runs: readonly ReviewRunRow[]
  /**
   * How many runs the page shows before folding, as the Host declared it.
   *
   * It is a field rather than a constant here on purpose: `REVIEW_LIST_LIMIT` is the Host's
   * number, and a second copy in the panel is how the two drift into disagreeing about what
   * the fold is counting. `0` means "the Host did not say" — the page then shows every row
   * it was handed and offers no fold.
   */
  readonly foldLimit: number
  readonly selectedRunId: string
  readonly selectedReviewer: string
  readonly selectedCreatedAt: string
  readonly selectedScores: readonly { readonly dimension: string; readonly value: number }[]
  readonly dimensions: readonly ReviewDimensionView[]
  readonly rejected: readonly { readonly index: number; readonly code: string; readonly message: string }[]
  readonly skippedFiles: readonly string[]
  readonly truncated: boolean
}

export interface ReviewCompareRowView {
  readonly reviewer: string
  readonly dimension: string
  readonly label: string
  readonly modelScore: number | null
  readonly opinions: number
  readonly locatedRate: number | null
  readonly density: number | null
  readonly status: string
}

export interface ReviewCompareView {
  readonly reviewers: readonly string[]
  readonly comparable: boolean
  readonly note: string
  readonly rows: readonly ReviewCompareRowView[]
  readonly markdown: string
}

/**
 * The empty value a page renders before the first answer arrives.
 *
 * Exported so the view has one literal instead of a `null` check on every field: the
 * loading and error states render the same shell, and a shell that has to branch per field
 * is how a page ends up with hooks after an early return (AGENTS.md §8 trap 2b).
 */
export const EMPTY_REVIEW: ReviewValue = {
  chapterId: '',
  chapterTitle: '',
  wordCount: 0,
  paragraphCount: 0,
  recordDir: '',
  runCount: 0,
  runs: [],
  foldLimit: 0,
  selectedRunId: '',
  selectedReviewer: '',
  selectedCreatedAt: '',
  selectedScores: [],
  dimensions: [],
  rejected: [],
  skippedFiles: [],
  truncated: false,
}

export const EMPTY_COMPARE: ReviewCompareView = {
  reviewers: [],
  comparable: false,
  note: '',
  rows: [],
  markdown: '',
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** The locator as the one address string the record prints (`path#L<n>`, `chapter:<id>`). */
export function addressOf(raw: unknown): string {
  const locator = asRecord(raw)
  switch (str(locator['kind'])) {
    case 'chapter':
      return `chapter:${str(locator['chapterId'])}`
    case 'entity':
      return `${str(locator['entityKind'])}:${str(locator['id'])}`
    case 'catalog':
      return locator['volumeId'] === undefined ? 'catalog:' : `catalog:${str(locator['volumeId'])}`
    case 'path':
      return locator['line'] === undefined ? str(locator['path']) : `${str(locator['path'])}#L${String(num(locator['line']))}`
    default:
      return ''
  }
}

/**
 * Where a click on an opinion's evidence should go, or `null` when the Host did not locate
 * it. The locator is `path`+`line` for every review opinion (a chapter file), so this maps
 * onto the candidate page's `EvidenceJump` shape unchanged.
 */
export function evidenceJumpOf(locator: unknown): EvidenceJump | null {
  const raw = asRecord(locator)
  if (str(raw['kind']) === 'chapter') {
    const chapterId = str(raw['chapterId'])
    return chapterId === '' ? null : { kind: 'chapter', chapterId }
  }
  const path = str(raw['path'])
  if (path === '') return null
  return typeof raw['line'] === 'number'
    ? { kind: 'chapter', path, line: raw['line'] }
    : { kind: 'chapter', path }
}

function readOpinion(raw: unknown): ReviewOpinionView {
  const opinion = asRecord(raw)
  const locator = opinion['located'] === true ? opinion['locator'] : null
  const evidence = asRecord(opinion['evidence'])
  return {
    dimension: str(opinion['dimension']),
    code: str(opinion['code']),
    severity: str(opinion['severity']),
    located: locator !== null,
    where: locator === null ? '' : addressOf(locator),
    unlocatedReason: str(opinion['unlocatedReason']),
    unlocatedDetail: str(opinion['unlocatedDetail']),
    detail: str(opinion['detail']),
    hint: str(opinion['hint']),
    before: str(evidence['before']),
    quote: str(evidence['quote']),
    after: str(evidence['after']),
    paragraph: typeof evidence['paragraph'] === 'number' ? evidence['paragraph'] : null,
    offset: num(evidence['offset']),
    jump: evidenceJumpOf(locator),
  }
}

function anchorsOf(raw: unknown): { key: string; value: string }[] {
  const record = asRecord(raw)
  return Object.entries(record).map(([key, value]) => ({
    key,
    value: Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').join(' / ') : String(value),
  }))
}

function readDimensions(raw: unknown): ReviewDimensionView[] {
  const opinions = asArray(asRecord(raw)['opinions']).map((entry) => readOpinion(entry))
  return asArray(asRecord(raw)['dimensions']).map((entry) => {
    const summary = asRecord(entry)
    const dimension = str(summary['dimension'])
    return {
      dimension,
      label: str(summary['label']),
      status: str(summary['status']),
      opinions: num(summary['opinions']),
      located: num(summary['located']),
      code: str(summary['code']),
      message: str(summary['message']),
      anchors: anchorsOf(summary['anchors']),
      items: opinions.filter((opinion) => opinion.dimension === dimension),
    }
  })
}

function readScoreList(raw: unknown): { dimension: string; value: number }[] {
  const record = asRecord(raw)
  return Object.entries(record)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    .map(([dimension, value]) => ({ dimension, value: value as number }))
}

/** Fold the `GET /review` envelope (or `undefined`) into the page's shape. */
export function readReviewValue(raw: unknown): ReviewValue {
  const root = asRecord(raw)
  if (Object.keys(root).length === 0) return EMPTY_REVIEW
  const selected = asRecord(root['selected'])
  return {
    chapterId: str(root['chapterId']),
    chapterTitle: str(root['chapterTitle']),
    wordCount: num(root['wordCount']),
    paragraphCount: num(root['paragraphCount']),
    recordDir: str(root['recordDir']),
    runCount: num(root['runCount']),
    runs: asArray(root['runs']).map((entry) => {
      const row = asRecord(entry)
      return {
        runId: str(row['runId']),
        reviewer: str(row['reviewer']),
        createdAt: str(row['createdAt']),
        opinions: num(row['opinions']),
        located: num(row['located']),
        failed: num(row['failed']),
        skipped: num(row['skipped']),
        scores: Object.keys(asRecord(row['scores'])).length === 0 ? null : (asRecord(row['scores']) as Record<string, number>),
      }
    }),
    foldLimit: num(root['foldLimit']),
    selectedRunId: str(selected['runId']),
    selectedReviewer: str(selected['reviewer']),
    selectedCreatedAt: str(selected['createdAt']),
    selectedScores: readScoreList(selected['scores']),
    dimensions: readDimensions(selected),
    rejected: asArray(selected['rejected']).map((entry) => {
      const rejection = asRecord(entry)
      return { index: num(rejection['index']), code: str(rejection['code']), message: str(rejection['message']) }
    }),
    skippedFiles: asArray(root['skippedFiles']).filter((item): item is string => typeof item === 'string'),
    truncated: root['truncated'] === true,
  }
}

/** Fold the `GET /review/compare` envelope. */
export function readCompareValue(raw: unknown): ReviewCompareView {
  const root = asRecord(raw)
  if (Object.keys(root).length === 0) return EMPTY_COMPARE
  return {
    reviewers: asArray(root['reviewers']).filter((item): item is string => typeof item === 'string'),
    comparable: root['comparable'] === true,
    note: str(root['note']),
    rows: asArray(root['rows']).map((entry) => {
      const row = asRecord(entry)
      return {
        reviewer: str(row['reviewer']),
        dimension: str(row['dimension']),
        label: str(row['label']),
        modelScore: typeof row['modelScore'] === 'number' ? row['modelScore'] : null,
        opinions: num(row['opinions']),
        locatedRate: typeof row['locatedRate'] === 'number' ? row['locatedRate'] : null,
        density: typeof row['density'] === 'number' ? row['density'] : null,
        status: str(row['status']),
      }
    }),
    markdown: str(root['markdown']),
  }
}

/**
 * Which of the three states the page is in.
 *
 * `loading` wins while a request is in flight even if an older answer is on screen, because
 * the run list's numbers change per chapter and a stale list read as current is worse than
 * a moment of "读取中…".
 */
export function reviewPanelState(state: { readonly loading: boolean; readonly result: InternalResult<unknown> | null }): ReviewPanelState {
  if (state.loading) return 'loading'
  if (state.result === null || !state.result.ok) return 'error'
  return 'ready'
}

/** The error line: the Host's code, never a bare "failed". */
export function describeReviewError(error: { code?: string; message?: string; hint?: string } | undefined): string {
  if (error === undefined) return '审稿记录读取失败'
  const code = error.code === undefined ? '' : `（${error.code}）`
  const hint = error.hint === undefined || error.hint === '' ? '' : ` · ${error.hint}`
  return `${error.message ?? '审稿记录读取失败'}${code}${hint}`
}

/** `模型 · 时间 · N 条（M 条带定位）· 失败 K 维` — one row of the run list. */
export function describeRun(row: ReviewRunRow): string {
  const parts = [row.reviewer === '' ? 'unknown' : row.reviewer, row.createdAt, `${String(row.opinions)} 条意见`, `${String(row.located)} 条带定位`]
  if (row.failed > 0) parts.push(`${String(row.failed)} 维失败`)
  if (row.skipped > 0) parts.push(`${String(row.skipped)} 维跳过`)
  return parts.join(' · ')
}

export function statusLabel(status: string): string {
  if (status === 'failed') return '失败'
  if (status === 'skipped') return '跳过'
  return '完成'
}

/** The run list split at the fold. */
export interface ReviewRunSplit {
  /** The rows the first screen shows — the last `foldLimit` runs, newest first. */
  readonly recent: readonly ReviewRunRow[]
  /** The rows behind the fold; empty until the page has been asked for more. */
  readonly older: readonly ReviewRunRow[]
  /**
   * How many runs sit behind the fold, whether or not they have been loaded yet. This is
   * what the "更早的 N 次运行" row prints, so a folded page can say how much it is hiding
   * without fetching it.
   */
  readonly olderCount: number
}

/**
 * Split the run list at the fold the Host declared.
 *
 * Why the boundary is `foldLimit` and not `runs.length`: when the fold opens the panel asks
 * for a bigger page, so `runs.length` grows and would move its own boundary — the fold row
 * would keep saying "更早的 N 次" for the rows it just revealed. The Host's number does not
 * move, which is what makes the row disappear exactly when everything is shown.
 *
 * A `foldLimit` of `0` means the Host did not declare one: the page then shows what it has
 * and hides nothing, which is the only safe reading of "unknown" here.
 */
export function splitRuns(view: {
  readonly runCount: number
  readonly foldLimit: number
  readonly runs: readonly ReviewRunRow[]
}): ReviewRunSplit {
  const limit = view.foldLimit > 0 ? Math.min(view.foldLimit, view.runs.length) : view.runs.length
  const olderCount = view.foldLimit > 0 ? Math.max(view.runCount - view.foldLimit, 0) : 0
  return {
    recent: view.runs.slice(0, limit),
    older: view.runs.slice(limit),
    olderCount,
  }
}

export function dimensionLabel(dimension: string, label: string): string {
  return label === '' ? dimension : label
}

/** `before【quote】after` — the excerpt as one line, which is what a reader scans. */
export function evidenceLine(opinion: ReviewOpinionView): string {
  if (opinion.quote === '') return ''
  return `…${opinion.before}【${opinion.quote}】${opinion.after}…`
}

/** The score row as `结构 7 · 人物 8`, or `''` when the model gave none. */
export function describeScores(scores: readonly { dimension: string; value: number }[]): string {
  return scores.map((entry) => `${entry.dimension} ${String(entry.value)}`).join(' · ')
}
