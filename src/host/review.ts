/**
 * The review run: route the opinions, run the five nodes, assemble the replies.
 *
 * ## What this module owns, and what it refuses to own
 *
 * The milestone's rule (roadmap X-26, [ADR-0017](.agents/adrs/0017-extraction-by-session-model.md))
 * is that the **plugin never calls a model**. So the opinions a review consists of arrive
 * from the session's model through `inkflow_review_run`, and this module does the part a
 * program can do honestly:
 *
 *   1. **Route** each opinion to one of the five dimensions.
 *   2. **Locate** it against the real chapter text — the model's hint is checked against
 *      the bytes on disk, and what comes back is a `FindingLocator` (`path#L<n>`) plus the
 *      excerpt around it.
 *   3. **Keep what cannot be located.** An opinion whose hint does not resolve is stored
 *      with `located: false` and a reason code. It is never silently dropped, and a
 *      position is never invented for it: `locator` stays `null` instead of being faked
 *      into a chapter-wide address, because a fabricated address would make the
 *      "locatable rate" the comparison table reports (see `review-compare.ts`) constant
 *      100% — a number that cannot be wrong is not a measurement.
 *   4. **Record** the run under `.inkflow/review/<chapterId>/<runId>.json`
 *      ([ADR-0023](.agents/adrs/0023-proposal-job-private-placement.md)): a run is not
 *      rebuildable, so it does not go into `index/` (ADR-0006 D2).
 *
 * The five dimensions are **one DAG, not five switches**: a fan-out from one read pass
 * into five independent nodes and a fold back into one record. Each node runs alone and
 * can be skipped, and a node that fails is reported in `failed` with a structured code
 * while the other four still finish. A crashed review is useless; a four-of-five review
 * with a named hole is usable.
 *
 * ## Where the pieces live (the split)
 *
 * This file is the **orchestration and the outward replies**: run the DAG, then answer the
 * three callers — `inkflow_review_context` (`buildReviewContext`), the panel's
 * `GET /review` (`buildReviewList`) and the tool/panel wire of one run (in `review-store.ts`
 * beside the record it projects). The things it used to also own now have files named after
 * them: `review-nodes.ts` (the dimensions and the node table), `review-locate.ts` (the
 * chapter as the addressing layer sees it: paragraphs, hints, evidence windows),
 * `review-store.ts` (the record file). None of them calls a model, none of them judges prose.
 *
 * ## Where the shape comes from
 *
 * Opinions are `Finding`s with a dimension and an evidence chain, not a new problem type
 * (X-24 / [ADR-0022](.agents/adrs/0022-writing-context-gate-findings.md) D3): the same
 * `{code, group, severity, locator, detail, hint, fixable}`, the same `FindingLocator`
 * shapes, `fixable: false` for every one of them (an aesthetic judgement is not something
 * `repair.ts` may rewrite — ADR-0015 D2).
 */

import { REVIEW_CONTEXT_CHARS, REVIEW_DEFAULT_CONTEXT_CHARS, readChapter } from './review-locate.js'
import type { ReviewError, ReviewOpinion, ReviewOpinionInput, ReviewRejection } from './review-locate.js'
import {
  REVIEW_DIMENSIONS,
  REVIEW_DIMENSION_CODES,
  REVIEW_DIMENSION_LABELS,
  REVIEW_DIMENSION_TASKS,
  REVIEW_NODES,
  asDimension,
  checkOpinion,
} from './review-nodes.js'
import type { ReviewDimension, ReviewNode, ReviewNodeResult } from './review-nodes.js'
import {
  REVIEW_LIST_LIMIT,
  digestOf,
  listReviewRuns,
  recordRun,
  reviewDirOf,
  reviewRunId,
  reviewRunSummary,
  reviewRunWire,
  sortOpinions,
} from './review-store.js'
import type { ReviewDimensionSummary, ReviewFileResult, ReviewRunRecord } from './review-store.js'

export interface ReviewRequest {
  readonly chapterId?: string
  readonly chapterPath?: string
  /** Which model produced these opinions (`unknown` when omitted) — the comparison's row key. */
  readonly reviewer?: string
  readonly opinions: readonly ReviewOpinionInput[]
  /** Which nodes to run; omitted = all five. Anything else is a structured refusal. */
  readonly dimensions?: readonly string[]
  /** The model's own per-dimension score, copied into the record verbatim (never computed). */
  readonly scores?: Readonly<Record<string, number>>
}

export interface ReviewRunOptions {
  /** Pinned by the tests; a run record is a *run*, so it carries the wall clock. */
  readonly now?: Date
  /** Injectable node table (the isolation tests replace one node). */
  readonly nodes?: readonly ReviewNode[]
  /** `false` computes without writing the record (nothing else needs this; it is the seam). */
  readonly record?: boolean
  readonly contextChars?: number
  /** Cap on the opinions the tool reply carries; the record always holds all of them. */
  readonly listLimit?: number
}

export type ReviewResult =
  | { readonly ok: true; readonly run: ReviewRunRecord; readonly file?: ReviewFileResult }
  | { readonly ok: false; readonly error: ReviewError }

function refuse(code: string, message: string, hint?: string): ReviewResult {
  return { ok: false, error: hint === undefined ? { code, message } : { code, message, hint } }
}

// ---------------------------------------------------------------------------
// Addressing: paragraphs, offsets, excerpt windows

/**
 * Run the review DAG over one chapter.
 *
 * Order: gather once → route every opinion to its dimension (refusals collected, not
 * thrown) → run each requested node → sort → record. `options.record` defaults to `true`:
 * a run record is the product of reviewing, and `inkflow_review_run` is the only caller
 * that may write it (the panel's route passes `record: false` because a GET must not write).
 */
export function runReview(root: string, request: ReviewRequest, options: ReviewRunOptions = {}): ReviewResult {
  const gathered = readChapter(root, request)
  if ('error' in gathered) return { ok: false, error: gathered.error }
  const { chapter, files } = gathered
  const contextChars = options.contextChars ?? REVIEW_CONTEXT_CHARS
  const nodes = options.nodes ?? REVIEW_NODES
  const opinions = Array.isArray(request.opinions) ? request.opinions : []

  const requested: ReviewDimension[] = []
  const rawDimensions = request.dimensions
  if (rawDimensions === undefined || rawDimensions.length === 0) {
    requested.push(...REVIEW_DIMENSIONS)
  } else {
    for (const raw of rawDimensions) {
      const dimension = asDimension(String(raw).trim())
      if (dimension === undefined) {
        return refuse(
          'REVIEW_DIMENSION_UNKNOWN',
          `dimensions 里有 "${String(raw)}"`,
          `只认 ${REVIEW_DIMENSIONS.join(' / ')}；不传就是五维全跑`,
        )
      }
      if (!requested.includes(dimension)) requested.push(dimension)
    }
  }

  const rejected: ReviewRejection[] = []
  const accepted: { index: number; input: ReviewOpinionInput; dimension: ReviewDimension }[] = []
  for (const [index, input] of opinions.entries()) {
    const rejection = checkOpinion(index, input)
    if (rejection !== undefined) {
      rejected.push(rejection)
      continue
    }
    accepted.push({ index, input, dimension: asDimension(String(input.dimension).trim()) as ReviewDimension })
  }

  const summaries: ReviewDimensionSummary[] = []
  const collected: ReviewOpinion[] = []
  for (const dimension of REVIEW_DIMENSIONS) {
    const node = nodes.find((entry) => entry.dimension === dimension)
    if (!requested.includes(dimension)) {
      summaries.push({
        dimension,
        label: REVIEW_DIMENSION_LABELS[dimension],
        status: 'skipped',
        opinions: 0,
        located: 0,
        anchors: {},
        code: null,
        message: null,
        skipReason: 'not-requested',
      })
      continue
    }
    if (node === undefined) {
      summaries.push({
        dimension,
        label: REVIEW_DIMENSION_LABELS[dimension],
        status: 'failed',
        opinions: 0,
        located: 0,
        anchors: {},
        code: 'REVIEW_NODE_MISSING',
        message: `no node is registered for ${dimension}`,
        skipReason: null,
      })
      continue
    }
    const routed = accepted.filter((entry) => entry.dimension === dimension).map((entry) => entry.input)
    let result: ReviewNodeResult
    try {
      result = node.run({ root, chapter, files, opinions: routed, contextChars })
    } catch (cause) {
      // A node that throws must not take the other four down: the run is a report, and a
      // missing dimension is visible in `failed` while a crashed run produces nothing.
      result = { ok: false, code: 'REVIEW_NODE_FAILED', message: String(cause) }
    }
    if (!result.ok) {
      summaries.push({
        dimension,
        label: REVIEW_DIMENSION_LABELS[dimension],
        status: 'failed',
        opinions: 0,
        located: 0,
        anchors: {},
        code: result.code,
        message: result.message,
        skipReason: null,
      })
      continue
    }
    const produced = result.output.opinions
    collected.push(...produced)
    summaries.push({
      dimension,
      label: REVIEW_DIMENSION_LABELS[dimension],
      status: 'ok',
      opinions: produced.length,
      located: produced.filter((opinion) => opinion.located).length,
      anchors: result.output.anchors,
      code: null,
      message: null,
      skipReason: null,
    })
  }

  const scores: Record<string, number> = {}
  for (const [key, value] of Object.entries(request.scores ?? {})) {
    const dimension = asDimension(key.trim())
    if (dimension === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    scores[dimension] = value
  }

  const now = options.now ?? new Date()
  const run: ReviewRunRecord = {
    runId: reviewRunId(now),
    chapterId: chapter.id,
    chapterPath: chapter.path,
    chapterTitle: chapter.title,
    seq: chapter.seq,
    wordCount: chapter.wordCount,
    chapterDigest: digestOf(root, chapter.path, files),
    reviewer: (request.reviewer ?? '').trim() === '' ? 'unknown' : (request.reviewer as string).trim(),
    createdAt: now.toISOString(),
    dimensions: summaries,
    opinions: sortOpinions(collected),
    rejected,
    scores: Object.keys(scores).length === 0 ? null : scores,
  }

  if (options.record === false) return { ok: true, run }
  const written = recordRun(root, run)
  if (!written.ok) return { ok: false, error: written.error }
  return { ok: true, run, file: written.file }
}

/**
 * `GET /review?chapterId=&runId=`: the chapter's runs, plus the selected one in full.
 *
 * One route instead of two because "list the runs" and "open one run" are the same read
 * over the same directory; `runId` only chooses which record is expanded.
 */
export function buildReviewList(
  source: { readonly sessionId: string; readonly root: string },
  version: string,
  options: { readonly chapterId?: string; readonly chapterPath?: string; readonly runId?: string; readonly limit?: number } = {},
): { status: number; body: Record<string, unknown> } {
  const request: { chapterId?: string; chapterPath?: string } = {
    ...(options.chapterId === undefined ? {} : { chapterId: options.chapterId }),
    ...(options.chapterPath === undefined ? {} : { chapterPath: options.chapterPath }),
  }
  const gathered = readChapter(source.root, request)
  const fail = (error: ReviewError): { status: number; body: Record<string, unknown> } => ({
    status: error.code === 'CHAPTER_NOT_FOUND' ? 404 : 500,
    body: { ok: false, error: { ...error } },
  })
  if ('error' in gathered) return fail(gathered.error)
  const { chapter } = gathered
  const listed = listReviewRuns(source.root, chapter.id)
  const wanted = (options.runId ?? '').trim()
  const selected = wanted === '' ? listed.runs[0] : listed.runs.find((run) => run.runId === wanted)
  const limit = options.limit === undefined || options.limit <= 0 ? REVIEW_LIST_LIMIT : options.limit
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: source.root,
        chapterId: chapter.id,
        chapterPath: chapter.path,
        chapterTitle: chapter.title,
        seq: chapter.seq ?? null,
        wordCount: chapter.wordCount,
        paragraphCount: chapter.paragraphs.length,
        recordDir: reviewDirOf(chapter.id),
        runCount: listed.runs.length,
        runs: listed.runs.slice(0, limit).map((run) => reviewRunSummary(run)),
        // The fold boundary travels WITH the page. The panel draws "更早的 N 次运行"
        // past this number, so `limit` (a bigger page) must not move it — otherwise opening
        // the fold would push its own boundary and the count would never reach zero.
        foldLimit: REVIEW_LIST_LIMIT,
        truncated: listed.runs.length > limit,
        skippedFiles: listed.skippedFiles,
        selected: selected === undefined ? null : reviewRunWire(selected),
        /** Why the requested run is missing, instead of silently showing another one. */
        selectedMissing: wanted !== '' && selected === undefined,
      },
    },
  }
}

// ---------------------------------------------------------------------------
// The context tool: what the model is handed before it writes opinions

export interface ReviewContextOptions {
  readonly chapterId?: string
  readonly chapterPath?: string
  readonly dimensions?: readonly string[]
  readonly maxChars?: number
}

export interface ReviewContextValue {
  readonly chapterId: string
  readonly chapterPath: string
  readonly chapterTitle: string
  readonly seq: number | null
  readonly wordCount: number
  readonly paragraphCount: number
  readonly dimensions: readonly { dimension: ReviewDimension; label: string; code: string; task: string }[]
  readonly text: string
  readonly chars: number
  readonly truncated: boolean
}

export type ReviewContextResult =
  | { readonly ok: true; readonly value: ReviewContextValue }
  | { readonly ok: false; readonly error: ReviewError }

/**
 * The text handed to the session's model, with the addressing protocol written into it.
 *
 * Why the protocol is in the output and not only in the tool description: the model reads
 * this block, and the block is where the paragraph numbers and offsets actually are. A
 * description says "give me a paragraph number"; the block shows which number belongs to
 * which paragraph, which is the difference between a hint that resolves and one that does
 * not.
 */
export function buildReviewContext(root: string, options: ReviewContextOptions = {}): ReviewContextResult {
  const request: { chapterId?: string; chapterPath?: string } = {
    ...(options.chapterId === undefined ? {} : { chapterId: options.chapterId }),
    ...(options.chapterPath === undefined ? {} : { chapterPath: options.chapterPath }),
  }
  const gathered = readChapter(root, request)
  if ('error' in gathered) return { ok: false, error: gathered.error }
  const { chapter } = gathered

  const requested: ReviewDimension[] = []
  for (const raw of options.dimensions ?? []) {
    const dimension = asDimension(String(raw).trim())
    if (dimension === undefined) {
      return {
        ok: false,
        error: {
          code: 'REVIEW_DIMENSION_UNKNOWN',
          message: `dimensions 里有 "${String(raw)}"`,
          hint: `只认 ${REVIEW_DIMENSIONS.join(' / ')}；不传就是五维全给`,
        },
      }
    }
    if (!requested.includes(dimension)) requested.push(dimension)
  }
  const shown = requested.length === 0 ? [...REVIEW_DIMENSIONS] : requested
  const maxChars = options.maxChars === undefined || options.maxChars <= 0 ? REVIEW_DEFAULT_CONTEXT_CHARS : options.maxChars

  const header = [
    `【审稿上下文】${chapter.title}（id: ${chapter.id}，路径: ${chapter.path}，序号: ${chapter.seq === undefined ? '未编号' : String(chapter.seq)}）`,
    `正文 ${String(chapter.wordCount)} 字 / ${String(chapter.paragraphs.length)} 段；下面每段前标了 [段 N | 偏移 X]。`,
    '',
    '【要看的维度】',
    ...shown.map((dimension) => `- ${dimension}（${REVIEW_DIMENSION_LABELS[dimension]}）：${REVIEW_DIMENSION_TASKS[dimension]}`),
    '',
    '【每条意见怎么定位】',
    '- quote：贴一段原文片段（最容易辨认；同一句在正文里出现多次时补 paragraph 或 offset 消歧）。',
    '- paragraph + offset：段序号（1 起）+ 该段内的字符偏移（0 起）。',
    '- offset：正文里的字符偏移（0 起，不含 frontmatter）。',
    '- line：章节文件的行号（1 起，含 frontmatter）。',
    '插件按这些提示核对原文：能定位的会带上前后文存进证据链；定位不到的意见保留并标 unlocated，不会被丢掉。',
    '',
    '【正文】',
  ]
  const blocks = chapter.paragraphs.map(
    (paragraph) => `[段 ${String(paragraph.index)} | 偏移 ${String(paragraph.start)}] ${paragraph.text}`,
  )
  const body = blocks.join('\n')
  const limited = maxChars > 0 && body.length > maxChars ? body.slice(0, maxChars) : body
  const text = `${header.join('\n')}${limited}`
  return {
    ok: true,
    value: {
      chapterId: chapter.id,
      chapterPath: chapter.path,
      chapterTitle: chapter.title,
      seq: chapter.seq ?? null,
      wordCount: chapter.wordCount,
      paragraphCount: chapter.paragraphs.length,
      dimensions: shown.map((dimension) => ({
        dimension,
        label: REVIEW_DIMENSION_LABELS[dimension],
        code: REVIEW_DIMENSION_CODES[dimension],
        task: REVIEW_DIMENSION_TASKS[dimension],
      })),
      text,
      chars: text.length,
      truncated: limited.length < body.length,
    },
  }
}
