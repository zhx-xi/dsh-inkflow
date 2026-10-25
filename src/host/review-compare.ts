/**
 * The cross-model comparison table: the same chapter, several models' opinion
 * sets, one exportable table.
 *
 * ## The line this module does not cross
 *
 * **The plugin does not score.** Every number in the table is either
 *
 *   * **given by the model** — `score` is copied from the run record's `scores`, which the
 *     caller supplied through `inkflow_review_run`; it is never computed, averaged into a
 *     verdict, or compared against a threshold; or
 *   * **computed by an arithmetic rule anyone can redo by hand** — how many opinions, how
 *     many of them located, what share that is, how many per 1000 characters, how many
 *     warnings. These are counts, not judgements.
 *
 * A plugin-side aesthetic score would be exactly the thing X-26 keeps out of this plugin:
 * the model is the reader here, and a number the plugin invented would look like a second
 * opinion with no author behind it.
 *
 * ## Why the columns are fixed
 *
 * "Same-calibre comparison" (同口径) means two rows are comparable column by column, so
 * the column list is one constant and every row — including the per-model total — carries
 * every column. A row that omitted a column it could not fill would compare as "better"
 * in a spreadsheet sorted on that column; `null` is a value, an absent cell is not.
 *
 * ## The two null cases, stated once
 *
 *   * `locatedRate` is `null` when the model produced no opinions for that dimension: 0 of
 *     0 is not 0%, and printing 0% would read as "nothing it said could be found".
 *   * `density` is `null` when the chapter has no countable characters.
 */

import { REVIEW_DIMENSIONS, REVIEW_DIMENSION_LABELS } from './review-nodes.js'
import type { ReviewDimension } from './review-nodes.js'
import { buildReviewContext } from './review.js'
import { REVIEW_LIST_LIMIT, listReviewRuns } from './review-store.js'
import type { ReviewRunRecord } from './review-store.js'

/** The table's columns, in print order. Every row carries every one of them. */
export const REVIEW_COMPARE_COLUMNS = [
  'reviewer',
  'runId',
  'dimension',
  'label',
  'modelScore',
  'opinions',
  'located',
  'locatedRate',
  'density',
  'warnings',
  'infos',
  'status',
] as const

export type ReviewCompareColumn = (typeof REVIEW_COMPARE_COLUMNS)[number]

/**
 * One table row.
 *
 * `modelScore` — the model's own score (given, copied); `locatedRate` / `density` — the
 * two mechanical rates (computed here); `status` — what the node did in that run.
 */
export interface ReviewCompareRow {
  readonly reviewer: string
  readonly runId: string
  readonly dimension: ReviewDimension | 'total'
  readonly label: string
  readonly modelScore: number | null
  readonly opinions: number
  readonly located: number
  /** Percent 0–100, one decimal; `null` when there were no opinions to locate. */
  readonly locatedRate: number | null
  /** Opinions per 1000 body characters, one decimal; `null` when the chapter is empty. */
  readonly density: number | null
  readonly warnings: number
  readonly infos: number
  readonly status: 'ok' | 'failed' | 'skipped'
}

/**
 * The chapter a table is about — `chapterId` / `chapterTitle` / `wordCount` and nothing else.
 *
 * It is a named type because the identity has exactly ONE source: the chapter
 * the caller resolved. `ReviewContextValue` (the run's own reader) is structurally one of
 * these, so the route hands its resolved chapter straight in.
 */
export interface CompareChapter {
  readonly chapterId: string
  readonly chapterTitle: string
  readonly wordCount: number
}

/**
 * Decide the table's chapter identity — the one place that decides it.
 *
 * Priority: **the resolved chapter wins**; the recorded runs are only a fallback for a
 * caller that holds nothing but records (the old tool path). Why it matters: the route
 * resolves the chapter before it reads a single run, so "this chapter has no review yet"
 * still has a name; deriving the header from `first?.chapterId` instead gave an EMPTY
 * identity exactly when the page was asking "which chapter am I looking at?", and let a
 * hand-moved or renamed record relabel the whole table.
 */
export function compareChapterIdentity(chapter: CompareChapter | undefined, newest: ReviewRunRecord | undefined): CompareChapter {
  if (chapter !== undefined && chapter.chapterId !== '') {
    return { chapterId: chapter.chapterId, chapterTitle: chapter.chapterTitle, wordCount: chapter.wordCount }
  }
  return {
    chapterId: newest?.chapterId ?? '',
    chapterTitle: newest?.chapterTitle ?? '',
    wordCount: newest?.wordCount ?? 0,
  }
}

export interface ReviewCompare {
  readonly chapterId: string
  readonly chapterTitle: string
  readonly wordCount: number
  /** Distinct `reviewer` values across the runs; the table needs at least two to compare. */
  readonly reviewers: readonly string[]
  readonly columns: readonly ReviewCompareColumn[]
  readonly rows: readonly ReviewCompareRow[]
  /** `false` when fewer than two models have a record for this chapter (the table still renders). */
  readonly comparable: boolean
  readonly note: string
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function rateOf(located: number, total: number): number | null {
  if (total <= 0) return null
  return round1((located / total) * 100)
}

function densityOf(opinions: number, wordCount: number): number | null {
  if (wordCount <= 0) return null
  return round1((opinions / wordCount) * 1000)
}

function scoreOf(run: ReviewRunRecord, dimension: ReviewDimension): number | null {
  const scores = run.scores
  if (scores === null) return null
  const value = scores[dimension]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Build the table from one chapter's run records.
 *
 * `chapter` is the chapter the caller resolved (route: `buildReviewContext`; tool: the same
 * reader) and it decides the header — see `compareChapterIdentity`. Omitting it falls back to
 * the newest record's chapter, which is what a caller holding only records can offer.
 *
 * Rows are per (run, dimension) plus one `total` row per run, so a model's five dimensions
 * and its whole pass are both visible without a second table. The total row's `modelScore`
 * is the **arithmetic mean of the scores that were given** (null when none was) — averaging
 * numbers the model handed in is bookkeeping, not a judgement, and it is stated here so
 * nobody has to guess whether a total was scored or summed.
 */
export function compareReviewRuns(runs: readonly ReviewRunRecord[], chapter?: CompareChapter): ReviewCompare {
  const ordered = [...runs].sort((left, right) => (left.runId < right.runId ? 1 : left.runId > right.runId ? -1 : 0))
  const reviewers: string[] = []
  for (const run of ordered) if (!reviewers.includes(run.reviewer)) reviewers.push(run.reviewer)
  const identity = compareChapterIdentity(chapter, ordered[0])
  const wordCount = identity.wordCount
  const rows: ReviewCompareRow[] = []

  for (const run of ordered) {
    let totalOpinions = 0
    let totalLocated = 0
    let totalWarnings = 0
    let totalInfos = 0
    const givenScores: number[] = []
    for (const dimension of REVIEW_DIMENSIONS) {
      const summary = run.dimensions.find((entry) => entry.dimension === dimension)
      const opinions = run.opinions.filter((opinion) => opinion.dimension === dimension)
      const located = opinions.filter((opinion) => opinion.located).length
      const warnings = opinions.filter((opinion) => opinion.severity === 'warning').length
      const infos = opinions.length - warnings
      const score = scoreOf(run, dimension)
      if (score !== null) givenScores.push(score)
      totalOpinions += opinions.length
      totalLocated += located
      totalWarnings += warnings
      totalInfos += infos
      rows.push({
        reviewer: run.reviewer,
        runId: run.runId,
        dimension,
        label: REVIEW_DIMENSION_LABELS[dimension],
        modelScore: score,
        opinions: opinions.length,
        located,
        locatedRate: rateOf(located, opinions.length),
        density: densityOf(opinions.length, run.wordCount),
        warnings,
        infos,
        status: summary?.status ?? 'skipped',
      })
    }
    rows.push({
      reviewer: run.reviewer,
      runId: run.runId,
      dimension: 'total',
      label: '合计',
      modelScore:
        givenScores.length === 0 ? null : round1(givenScores.reduce((sum, value) => sum + value, 0) / givenScores.length),
      opinions: totalOpinions,
      located: totalLocated,
      locatedRate: rateOf(totalLocated, totalOpinions),
      density: densityOf(totalOpinions, run.wordCount),
      warnings: totalWarnings,
      infos: totalInfos,
      status: run.dimensions.some((summary) => summary.status === 'failed')
        ? 'failed'
        : run.dimensions.every((summary) => summary.status === 'skipped')
          ? 'skipped'
          : 'ok',
    })
  }

  const comparable = reviewers.length >= 2
  return {
    chapterId: identity.chapterId,
    chapterTitle: identity.chapterTitle,
    wordCount,
    reviewers,
    columns: REVIEW_COMPARE_COLUMNS,
    rows,
    comparable,
    note: comparable
      ? '同一章、多个模型的意见集：模型自评来自各次运行传入的 scores，其余列为插件按定义算出的计数与比率'
      : ordered.length === 0
        ? '这一章还没有审稿运行：横评需要同一章至少 2 个模型各跑一次（inkflow_review_run）'
        : '只有 1 个模型的运行记录：表已列出，横评需要同一章至少 2 个模型各跑一次',
  }
}

function cellOf(value: number | null): string {
  return value === null ? '—' : String(value)
}

/**
 * The table as Markdown — the export.
 *
 * A table the author can paste into an issue or a review note is the deliverable the panel
 * shows; a second JSON file under `.inkflow/` would be a fifth private subpath for
 * something that is already in the run records.
 */
export function renderCompareMarkdown(table: ReviewCompare): string {
  const header = '| 模型 | 运行 | 维度 | 模型自评 | 意见 | 可定位 | 可定位率 % | 密度(条/千字) | 需要处理 | 提示 | 状态 |'
  const rule = '|---|---|---|---|---|---|---|---|---|---|---|'
  const lines = table.rows.map((row) =>
    [
      row.reviewer,
      row.runId,
      row.label,
      cellOf(row.modelScore),
      String(row.opinions),
      String(row.located),
      cellOf(row.locatedRate),
      cellOf(row.density),
      String(row.warnings),
      String(row.infos),
      row.status,
    ].join(' | '),
  )
  const head = [
    `### 审稿横评 · ${table.chapterTitle === '' ? table.chapterId : table.chapterTitle}（${String(table.wordCount)} 字）`,
    '',
    header,
    rule,
    ...lines.map((line) => `| ${line} |`),
    '',
    `模型：${table.reviewers.length === 0 ? '—' : table.reviewers.join(' / ')}`,
    table.note,
    '口径：模型自评＝各次运行传入的 scores（插件不改写、不评判）；可定位率＝可定位意见数 ÷ 意见数；密度＝意见数 ÷ 正文千字；「—」表示无意见或正文为空。',
  ]
  return head.join('\n')
}

/** The table on the wire: rows as records in `columns` order, plus the exportable Markdown. */
export function reviewCompareWire(table: ReviewCompare): Record<string, unknown> {
  return {
    chapterId: table.chapterId,
    chapterTitle: table.chapterTitle,
    wordCount: table.wordCount,
    reviewers: table.reviewers,
    comparable: table.comparable,
    note: table.note,
    columns: table.columns,
    rows: table.rows.map((row) => {
      const record: Record<string, unknown> = {}
      for (const column of table.columns) record[column] = row[column]
      return record
    }),
    markdown: renderCompareMarkdown(table),
  }
}

/**
 * `GET /review/compare?chapterId=`: the same table the tool returns, over the same records.
 *
 * Read-only, and it resolves its chapter through `buildReviewContext` — the run's own
 * reader — so "which chapter" has exactly one answer across the tool, the route and the
 * review itself. An id that matches nothing is a 404 `CHAPTER_NOT_FOUND` naming it, never a
 * fallback to the last chapter (the /brief rule).
 *
 * The resolved chapter is what the header names: a chapter with zero runs still gets
 * its own identity and the note says it has not been reviewed yet, instead of a table with
 * an empty `chapterId` and `0` words.
 */
export function buildReviewCompare(
  source: { readonly sessionId: string; readonly root: string },
  version: string,
  options: { readonly chapterId?: string; readonly chapterPath?: string; readonly limit?: number } = {},
): { status: number; body: Record<string, unknown> } {
  const resolved = buildReviewContext(source.root, {
    ...(options.chapterId === undefined ? {} : { chapterId: options.chapterId }),
    ...(options.chapterPath === undefined ? {} : { chapterPath: options.chapterPath }),
  })
  if (!resolved.ok) {
    return {
      status: resolved.error.code === 'CHAPTER_NOT_FOUND' ? 404 : 500,
      body: { ok: false, error: { ...resolved.error } },
    }
  }
  const cap = options.limit === undefined || options.limit <= 0 ? REVIEW_LIST_LIMIT : Math.trunc(options.limit)
  const listed = listReviewRuns(source.root, resolved.value.chapterId)
  const runs = listed.runs.slice(0, cap)
  const table = compareReviewRuns(runs, resolved.value)
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: source.root,
        runCount: runs.length,
        truncated: listed.runs.length > runs.length,
        skippedFiles: listed.skippedFiles,
        // `chapterId` / `chapterTitle` / `wordCount` come from the one identity the table
        // computed — never a second copy that could disagree with it.
        ...reviewCompareWire(table),
      },
    },
  }
}
