/**
 * Issue #46 — the review DAG: five dimensions, an evidence chain, one run record per pass.
 *
 * ## What this module owns, and what it refuses to own
 *
 * The milestone's rule (roadmap X-26, [ADR-0017](.agents/adrs/0017-extraction-by-session-model.md))
 * is that the **plugin never calls a model**. So the opinions a review consists of arrive
 * from the session's model through `inkflow_review_run`, and this module does the part a
 * program can do honestly:
 *
 *   1. **Route** each opinion to one of the five dimensions
 *      (`structure` / `character` / `pacing` / `style` / `consistency`).
 *   2. **Locate** it against the real chapter text — the model's hint (`quote`,
 *      `paragraph`+`offset`, `offset`, `line`) is checked against the bytes on disk, and
 *      what comes back is a `FindingLocator` (`path#L<n>`) plus the excerpt around it.
 *   3. **Keep what cannot be located.** An opinion whose hint does not resolve is stored
 *      with `located: false` and a reason code. It is never silently dropped, and a
 *      position is never invented for it: `locator` stays `null` instead of being faked
 *      into a chapter-wide address, because a fabricated address would make the
 *      "locatable rate" that the comparison table reports (see `review-compare.ts`)
 *      constant 100% — a number that cannot be wrong is not a measurement.
 *   4. **Record** the run under `.inkflow/review/<chapterId>/<runId>.json`
 *      ([ADR-0023](.agents/adrs/0023-proposal-job-private-placement.md), widened to a
 *      seventh subpath by this issue): a run is not rebuildable, so it does not go into
 *      `index/` (ADR-0006 D2 — a directory that is silently rebuilt cannot hold evidence).
 *
 * The five dimensions are **one DAG, not five switches**: a fan-out from one read pass
 * into five independent nodes and a fold back into one record. Each node runs alone and
 * can be skipped (`dimensions` on the request, reported as `skipped`), and a node that
 * fails — throws, or refuses with a code — is reported in `failed` with a structured code
 * while the other four still finish. A crashed review is useless; a four-of-five review
 * with a named hole is usable.
 *
 * ## Where the shape comes from
 *
 * Opinions are `Finding`s with a dimension and an evidence chain, not a new problem type
 * (X-24 / [ADR-0022](.agents/adrs/0022-writing-context-gate-findings.md) D3): the same
 * `{code, group, severity, locator, detail, hint, fixable}`, the same `FindingLocator`
 * shapes, `fixable: false` for every one of them (an aesthetic judgement is not something
 * `repair.ts` may rewrite — ADR-0015 D2).
 *
 * ## Nodes do not judge
 *
 * A node's mechanical part is an **anchor digest** — paragraph counts, dialogue lines,
 * sentence statistics, which character names actually occur, which ledger subjects exist.
 * It reads the chapter and two setting directories and hands numbers to the reader; it
 * never says "this is bad". The verdict belongs to the model (X-26), and the *mechanical*
 * verdicts over the same chapter already belong to the seven quality gates (#44) — a
 * second threshold table here would be two answers to one question.
 */

import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { CONTENT_DIRS } from './conventions.js'
import type { ContentDir } from './conventions.js'
import { chapterPositionsFromFiles } from './domains/foreshadowing-query.js'
import { aliasesOf, countChars, leadingNumber, readText } from './domains/scan-helpers.js'
import type { Finding, FindingGroup, FindingLocator, FindingSeverity } from './findings.js'
import { intField, parseMarkdown, stringField } from './frontmatter.js'
import { walkProjectFiles } from './indexer.js'
import type { WalkedFile } from './indexer.js'
import { writeTextAtomic } from './io.js'
import { ensurePrivateStateIgnored, privateStateRelative } from './private-state.js'

// ---------------------------------------------------------------------------
// The five dimensions
// ---------------------------------------------------------------------------

/**
 * The review's dimensions, in report order. One node each (roadmap M19 「审稿 DAG」).
 *
 * Deliberately **not** `FINDING_GROUPS`: a dimension is "which reader's eye produced this
 * opinion", a group is "which family of book facts the problem touches". A structure
 * opinion and a character opinion are both about `structure` facts, but they come from
 * two different tasks and two different passes.
 */
export const REVIEW_DIMENSIONS = ['structure', 'character', 'pacing', 'style', 'consistency'] as const
export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number]

export interface ReviewDimensionSpec {
  readonly dimension: ReviewDimension
  /** The Chinese label the panel and the reply print. */
  readonly label: string
  /** The catalogue code one opinion carries (`findings.ts`), so the report has one vocabulary. */
  readonly code: string
  /** The `FINDING_GROUPS` family this dimension argues about (ADR-0022 D3: the enum stays five). */
  readonly group: FindingGroup
  /** What the model is asked to look for — printed by `inkflow_review_context`. */
  readonly task: string
}

/**
 * The **one** table: dimension → label, catalogue code, finding group, task.
 *
 * One array rather than four parallel `Record`s, because four maps over the same five keys
 * is four places to forget a dimension in (the defect this repo keeps re-learning: a fact
 * written twice drifts). The three public maps below are derived from it, and
 * `tests/review.test.js` asserts every dimension has all four fields.
 */
export const REVIEW_DIMENSION_SPECS: readonly ReviewDimensionSpec[] = [
  {
    dimension: 'structure',
    label: '结构',
    code: 'REVIEW_STRUCTURE',
    group: 'structure',
    task: '结构与场景：开场是否抓住人、场景切换有没有交代、章末是否留下推进力、情节因果是否闭合',
  },
  {
    dimension: 'character',
    label: '人物',
    code: 'REVIEW_CHARACTER',
    group: 'structure',
    task: '人物：动机是否成立、言行与人物卡是否一致、配角有没有自己的目的、对话是否各有腔调',
  },
  {
    dimension: 'pacing',
    label: '节奏',
    code: 'REVIEW_PACING',
    group: 'catalog',
    task: '节奏：信息与行动的疏密、有没有连续大段说明、紧张与缓冲是否交替、哪些段落可以删掉',
  },
  {
    dimension: 'style',
    label: '文风',
    code: 'REVIEW_STYLE',
    group: 'catalog',
    task: '文风：句长与断句、重复用词、叙述腔调是否统一、有没有翻译腔与陈词',
  },
  {
    dimension: 'consistency',
    label: '一致性',
    code: 'REVIEW_CONSISTENCY',
    group: 'ledger',
    task: '一致性：与设定库（角色卡 / 账本 / 伏笔 / 时间线）是否冲突，称谓与设定是否对得上',
  },
]

function specOf(dimension: ReviewDimension): ReviewDimensionSpec {
  const found = REVIEW_DIMENSION_SPECS.find((entry) => entry.dimension === dimension)
  // Unreachable while SPECS covers REVIEW_DIMENSIONS, which a test asserts; the fallback
  // keeps this a total function instead of a `!` that would hide a hole at runtime.
  if (found === undefined) {
    return { dimension, label: dimension, code: 'REVIEW_STRUCTURE', group: 'catalog', task: '' }
  }
  return found
}

export const REVIEW_DIMENSION_LABELS = Object.fromEntries(
  REVIEW_DIMENSION_SPECS.map((entry) => [entry.dimension, entry.label]),
) as Readonly<Record<ReviewDimension, string>>

/** The catalogue code one opinion carries, so the report has one vocabulary per dimension. */
export const REVIEW_DIMENSION_CODES = Object.fromEntries(
  REVIEW_DIMENSION_SPECS.map((entry) => [entry.dimension, entry.code]),
) as Readonly<Record<ReviewDimension, string>>

/**
 * The `group` each dimension files under (ADR-0022 D3's rule: `FINDING_GROUPS` stays at
 * five, and a dimension maps to the family of facts it argues about).
 */
const REVIEW_DIMENSION_GROUPS = Object.fromEntries(
  REVIEW_DIMENSION_SPECS.map((entry) => [entry.dimension, entry.group]),
) as Readonly<Record<ReviewDimension, FindingGroup>>

/** What the model is asked to look for — printed by `inkflow_review_context`, owned here. */
export const REVIEW_DIMENSION_TASKS = Object.fromEntries(
  REVIEW_DIMENSION_SPECS.map((entry) => [entry.dimension, entry.task]),
) as Readonly<Record<ReviewDimension, string>>

/** Bumped only when the record file's shape changes; a run record is a fact, not a cache. */
export const REVIEW_FILE_SCHEMA_VERSION = 1

/** How many runs a tool reply or the panel prints before saying "and N more". */
export const REVIEW_LIST_LIMIT = 20

/** Default excerpt radius on each side of a located opinion. */
export const REVIEW_CONTEXT_CHARS = 12

/** The longest context block `inkflow_review_context` will hand back. */
export const REVIEW_DEFAULT_CONTEXT_CHARS = 12000

/** How long the excerpt itself is when the hint was a position rather than a quotation. */
const REVIEW_QUOTE_SPAN = 24

const VALID_SEVERITIES: readonly FindingSeverity[] = ['warning', 'info']

// ---------------------------------------------------------------------------
// Types: the chapter, the opinions, the record
// ---------------------------------------------------------------------------

/** One non-empty line block of the body, with the offsets a hint can address it by. */
export interface ReviewParagraph {
  /** 1-based, the number a model writes in `paragraph`. */
  readonly index: number
  /** Char offset of the block's first character in the body. */
  readonly start: number
  /** Char offset just past the block's last character. */
  readonly end: number
  readonly text: string
}

/** The chapter under review, as the nodes see it. `body` is the text after the frontmatter. */
export interface ReviewChapter {
  readonly id: string
  readonly path: string
  readonly seq: number | undefined
  readonly title: string
  readonly pov: string | null
  readonly body: string
  readonly wordCount: number
  readonly paragraphs: readonly ReviewParagraph[]
  /** 1-based file line of body offset 0 (so a body offset becomes a `path#L<n>` anchor). */
  readonly bodyStartLine: number
}

/** Which hint actually produced a position — recorded so a wrong-looking excerpt is diagnosable. */
export type ReviewHintSource = 'quote' | 'paragraph' | 'offset' | 'line'

export interface ReviewEvidence {
  /** Up to `contextChars` characters before, cut at the previous newline. */
  readonly before: string
  /** The excerpt itself: the model's quotation when it matched, else a 24-char window. */
  readonly quote: string
  /** Up to `contextChars` characters after, cut at the next newline. */
  readonly after: string
  /** 1-based paragraph the excerpt starts in (`null` for a body with no non-empty line). */
  readonly paragraph: number | null
  /** Char offset of the excerpt in the body (0-based, UTF-16 code units). */
  readonly offset: number
  readonly source: ReviewHintSource
}

/**
 * One review opinion: a `Finding` with a dimension and an evidence chain.
 *
 * `locator` is `null` exactly when `located` is `false` — the two are one fact written
 * twice on purpose, because the panel filters on `located` while the jump path needs a
 * locator, and a shape where those can disagree is a bug waiting to happen.
 */
export interface ReviewOpinion extends Omit<Finding, 'locator'> {
  readonly dimension: ReviewDimension
  readonly locator: FindingLocator | null
  readonly located: boolean
  /** One of `REVIEW_UNLOCATED_*` when `located` is false, else `null`. */
  readonly unlocatedReason: string | null
  /** The same fact in words: which hint failed and what to pass instead. */
  readonly unlocatedDetail: string | null
  readonly evidence: ReviewEvidence | null
}

/** One opinion as the caller (the session's model) hands it in. */
export interface ReviewOpinionInput {
  readonly dimension: string
  readonly text: string
  readonly severity?: string
  readonly suggestion?: string
  /** An exact excerpt of the chapter; the strongest hint, when it is unique. */
  readonly quote?: string
  /** 1-based paragraph number; with `offset`, the offset is taken inside that paragraph. */
  readonly paragraph?: number
  /** Char offset — inside `paragraph` when both are given, else in the body. 0-based. */
  readonly offset?: number
  /** 1-based file line of the chapter `.md` (frontmatter included). */
  readonly line?: number
}

/** An opinion the run refused, kept in the record: a rejection is data, not an exception. */
export interface ReviewRejection {
  /** 0-based index into the request's `opinions`, so the caller can find it. */
  readonly index: number
  readonly code: string
  readonly message: string
}

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

export interface ReviewNodeInput {
  readonly root: string
  readonly chapter: ReviewChapter
  readonly files: readonly WalkedFile[]
  /** Only the opinions routed to this node. */
  readonly opinions: readonly ReviewOpinionInput[]
  readonly contextChars: number
}

export interface ReviewAnchorValue {
  readonly [key: string]: number | string | readonly string[]
}

export interface ReviewNodeOutput {
  readonly anchors: ReviewAnchorValue
  readonly opinions: readonly ReviewOpinion[]
}

/**
 * A node's outcome. A refusal is `{ok:false, code}` rather than a throw: "this dimension
 * cannot be judged because its source is unreadable" is a fact the report must print, and
 * a stack trace is not.
 */
export type ReviewNodeResult =
  | { readonly ok: true; readonly output: ReviewNodeOutput }
  | { readonly ok: false; readonly code: string; readonly message: string }

export interface ReviewNode {
  readonly dimension: ReviewDimension
  readonly label: string
  readonly run: (input: ReviewNodeInput) => ReviewNodeResult
}

export interface ReviewDimensionSummary {
  readonly dimension: ReviewDimension
  readonly label: string
  readonly status: 'ok' | 'failed' | 'skipped'
  readonly opinions: number
  readonly located: number
  readonly anchors: ReviewAnchorValue
  /** Set only when `status` is `failed` (e.g. `REVIEW_NODE_FAILED`). */
  readonly code: string | null
  readonly message: string | null
  /** Set only when `status` is `skipped` (`not-requested`). */
  readonly skipReason: string | null
}

export interface ReviewRunRecord {
  readonly runId: string
  readonly chapterId: string
  readonly chapterPath: string
  readonly chapterTitle: string
  readonly seq: number | undefined
  readonly wordCount: number
  /** The bytes the run depended on (chapter + characters/ + facts/), same recipe as #44. */
  readonly chapterDigest: string
  readonly reviewer: string
  /** ISO instant: a run is an event, so unlike a gate verdict this file is not clock-free. */
  readonly createdAt: string
  readonly dimensions: readonly ReviewDimensionSummary[]
  readonly opinions: readonly ReviewOpinion[]
  readonly rejected: readonly ReviewRejection[]
  readonly scores: Readonly<Record<string, number>> | null
}

export interface ReviewError {
  readonly code: string
  readonly message: string
  readonly hint?: string
}

export interface ReviewFileResult {
  readonly path: string
  readonly bytes: number
  readonly created: boolean
  readonly ignoreLineAdded: boolean
}

export type ReviewResult =
  | { readonly ok: true; readonly run: ReviewRunRecord; readonly file?: ReviewFileResult }
  | { readonly ok: false; readonly error: ReviewError }

function refuse(code: string, message: string, hint?: string): ReviewResult {
  return { ok: false, error: hint === undefined ? { code, message } : { code, message, hint } }
}

// ---------------------------------------------------------------------------
// Addressing: paragraphs, offsets, excerpt windows
// ---------------------------------------------------------------------------

/**
 * The body's paragraphs: non-empty line blocks, in order.
 *
 * A block, not a line: a paragraph broken by hand into three lines is still one paragraph
 * to a reader, and a model counting paragraphs counts what it sees. Empty lines are not
 * paragraphs — numbering them would shift every number after a scene break.
 */
export function paragraphsOf(body: string): ReviewParagraph[] {
  const out: ReviewParagraph[] = []
  const pattern = /[^\n]+/gu
  let match: RegExpExecArray | null = pattern.exec(body)
  while (match !== null) {
    out.push({
      index: out.length + 1,
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    })
    match = pattern.exec(body)
  }
  return out
}

/** 1-based paragraph containing a body offset, or `null` when the offset is in whitespace. */
export function paragraphIndexAt(paragraphs: readonly ReviewParagraph[], offset: number): number | null {
  for (const paragraph of paragraphs) {
    if (offset >= paragraph.start && offset < paragraph.end) return paragraph.index
    if (offset < paragraph.start) break
  }
  return null
}

function countNewlines(text: string): number {
  let count = 0
  for (const char of text) if (char === '\n') count += 1
  return count
}

/** Every non-overlapping start offset of `needle` in `haystack` (empty needle: none). */
function occurrencesOf(haystack: string, needle: string): number[] {
  const out: number[] = []
  if (needle === '') return out
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return out
    out.push(at)
    from = at + needle.length
  }
}

/** The text after the last newline in `slice` — an excerpt must not drag a whole line in. */
function tailOf(slice: string): string {
  const cut = slice.lastIndexOf('\n')
  return cut < 0 ? slice : slice.slice(cut + 1)
}

/** The text before the first newline in `slice`. */
function headOf(slice: string): string {
  const cut = slice.indexOf('\n')
  return cut < 0 ? slice : slice.slice(0, cut)
}

/**
 * How many lines the frontmatter block occupies, so a body offset can be turned into the
 * `#L<n>` anchor the rest of the product uses. 0 when there is no frontmatter.
 *
 * Computed here rather than read from `parseMarkdown` because that function returns the
 * body and the fields but not where the body starts; a second frontmatter parser is not
 * worth it for one number.
 */
export function frontmatterLineCount(text: string): number {
  const normalized = text.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n')
  if (!normalized.startsWith('---')) return 0
  const lines = normalized.split('\n')
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '---') return index + 1
  }
  return 0
}

interface Located {
  readonly located: true
  readonly locator: FindingLocator
  readonly evidence: ReviewEvidence
}

/**
 * The excerpt window at one position.
 *
 * `start` is snapped forward past whitespace before the window is cut: a hint that lands on
 * the blank line between two paragraphs (an offset of 0 on a body that starts with a
 * newline, the start of a line after a scene break) would otherwise produce an excerpt that
 * *begins* with an empty line — correct by offset, useless to a reader, and impossible to
 * paste back into the text. The snap is one-way and only over whitespace, so the window
 * still starts inside the paragraph the hint named, and the recorded `offset` is the snapped
 * one: the record says where the excerpt actually begins.
 */
function evidenceAt(
  chapter: ReviewChapter,
  start: number,
  span: number,
  source: ReviewHintSource,
  contextChars: number,
): Located {
  const body = chapter.body
  let from = Math.max(0, Math.min(body.length, start))
  while (from < body.length && /\s/u.test(body[from] as string)) from += 1
  const to = Math.min(body.length, from + Math.max(1, span))
  const before = tailOf(body.slice(Math.max(0, from - contextChars), from))
  const after = headOf(body.slice(to, Math.min(body.length, to + contextChars)))
  return {
    located: true,
    locator: { kind: 'path', path: chapter.path, line: chapter.bodyStartLine + countNewlines(body.slice(0, from)) },
    evidence: {
      before,
      quote: body.slice(from, to),
      after,
      paragraph: paragraphIndexAt(chapter.paragraphs, from),
      offset: from,
      source,
    },
  }
}

type Unlocated = { readonly located: false; readonly reason: string; readonly detail: string }

/**
 * Resolve one hint against the chapter.
 *
 * Order is quote → paragraph (+offset) → offset → line, and the first hint that resolves
 * wins. Two behaviours worth stating, because both are decisions:
 *
 *   * A quotation that occurs more than once is **ambiguous**, not "the first one": the
 *     same sentence often opens and closes a scene, and guessing would put the evidence
 *     on the wrong paragraph with no trace. The caller is told to add `paragraph` or
 *     `offset`, and the opinion is kept as unlocated.
 *   * A quotation that does not occur at all falls through to the positional hints — an
 *     author-visible paraphrase of the line ("他把杯子放下" vs 「他把杯子放下。」) should not
 *     lose the position the model did get right.
 */
export function locateOpinion(
  chapter: ReviewChapter,
  input: ReviewOpinionInput,
  contextChars: number = REVIEW_CONTEXT_CHARS,
): Located | Unlocated {
  const body = chapter.body
  const quote = (input.quote ?? '').trim()
  const paragraph = typeof input.paragraph === 'number' ? input.paragraph : undefined
  const offset = typeof input.offset === 'number' ? input.offset : undefined
  const line = typeof input.line === 'number' ? input.line : undefined

  if (quote !== '') {
    const hits = occurrencesOf(body, quote)
    if (hits.length === 1) return evidenceAt(chapter, hits[0] as number, quote.length, 'quote', contextChars)
    if (hits.length > 1) {
      if (paragraph !== undefined) {
        const inParagraph = hits.filter((at) => paragraphIndexAt(chapter.paragraphs, at) === paragraph)
        if (inParagraph.length === 1) {
          return evidenceAt(chapter, inParagraph[0] as number, quote.length, 'quote', contextChars)
        }
      }
      return {
        located: false,
        reason: 'REVIEW_QUOTE_AMBIGUOUS',
        detail: `这段原文在正文出现 ${String(hits.length)} 次，补 paragraph（段序号）或 offset（字符偏移）来消歧`,
      }
    }
  }

  if (paragraph !== undefined) {
    const block = chapter.paragraphs[paragraph - 1]
    if (block === undefined) {
      return {
        located: false,
        reason: 'REVIEW_PARAGRAPH_OUT_OF_RANGE',
        detail: `正文只有 ${String(chapter.paragraphs.length)} 段，paragraph 要 1 到 ${String(chapter.paragraphs.length)}`,
      }
    }
    const inner = offset ?? 0
    if (!Number.isInteger(inner) || inner < 0 || inner >= block.end - block.start) {
      return {
        located: false,
        reason: 'REVIEW_OFFSET_OUT_OF_RANGE',
        detail: `第 ${String(block.index)} 段长 ${String(block.end - block.start)} 字，给了 paragraph 时 offset 要在段内（0 起）`,
      }
    }
    return evidenceAt(chapter, block.start + inner, REVIEW_QUOTE_SPAN, 'paragraph', contextChars)
  }

  if (offset !== undefined) {
    if (!Number.isInteger(offset) || offset < 0 || offset >= body.length) {
      return {
        located: false,
        reason: 'REVIEW_OFFSET_OUT_OF_RANGE',
        detail: `正文长 ${String(body.length)} 字（不含 frontmatter），offset 要在 0 到 ${String(Math.max(0, body.length - 1))}`,
      }
    }
    return evidenceAt(chapter, offset, REVIEW_QUOTE_SPAN, 'offset', contextChars)
  }

  if (line !== undefined) {
    const start = bodyOffsetOfLine(chapter, line)
    if (start === undefined) {
      const total = chapter.bodyStartLine + countNewlines(body)
      return {
        located: false,
        reason: 'REVIEW_LINE_OUT_OF_RANGE',
        detail: `正文从第 ${String(chapter.bodyStartLine)} 行到第 ${String(total)} 行，line 就是这个范围内的 1 起行号`,
      }
    }
    return evidenceAt(chapter, start, REVIEW_QUOTE_SPAN, 'line', contextChars)
  }

  return {
    located: false,
    reason: quote !== '' ? 'REVIEW_QUOTE_NOT_FOUND' : 'REVIEW_HINT_MISSING',
    detail:
      quote !== ''
        ? 'quote 在正文里找不到（连空白与标点都要一致），也没有可用的 paragraph / offset / line；补一个位置提示，或改成逐字摘录'
        : '给 quote（原文片段，最容易辨认）、paragraph（段序号）、offset（字符偏移）或 line（文件行号）之一',
  }
}

/** The body offset of a 1-based file line, or `undefined` when the line is outside the body. */
function bodyOffsetOfLine(chapter: ReviewChapter, line: number): number | undefined {
  if (!Number.isInteger(line) || line < chapter.bodyStartLine) return undefined
  const body = chapter.body
  let remaining = line - chapter.bodyStartLine
  let at = 0
  while (remaining > 0) {
    const next = body.indexOf('\n', at)
    if (next < 0) return undefined
    at = next + 1
    remaining -= 1
  }
  return at
}

// ---------------------------------------------------------------------------
// The nodes
// ---------------------------------------------------------------------------

function asDimension(value: string): ReviewDimension | undefined {
  return (REVIEW_DIMENSIONS as readonly string[]).includes(value) ? (value as ReviewDimension) : undefined
}

function asSeverity(value: string | undefined): FindingSeverity {
  return VALID_SEVERITIES.includes(value as FindingSeverity) ? (value as FindingSeverity) : 'info'
}

/** Build the `Finding`-shaped opinion for one input, located or not. */
function opinionOf(
  chapter: ReviewChapter,
  dimension: ReviewDimension,
  input: ReviewOpinionInput,
  contextChars: number,
): ReviewOpinion {
  const placed = locateOpinion(chapter, input, contextChars)
  const located = placed.located
  return {
    dimension,
    code: specOf(dimension).code,
    group: specOf(dimension).group,
    severity: asSeverity(input.severity),
    locator: located ? placed.locator : null,
    located,
    unlocatedReason: located ? null : placed.reason,
    unlocatedDetail: located ? null : placed.detail,
    detail: input.text.trim(),
    hint: (input.suggestion ?? '').trim() === '' ? '按这条意见改写原文这一段' : (input.suggestion as string).trim(),
    fixable: false,
    evidence: located ? placed.evidence : null,
  }
}

/** One opinion's whole pipeline: verify the shape, then locate it. */
function buildOpinions(
  chapter: ReviewChapter,
  dimension: ReviewDimension,
  inputs: readonly ReviewOpinionInput[],
  contextChars: number,
): ReviewOpinion[] {
  return inputs.map((input) => opinionOf(chapter, dimension, input, contextChars))
}

function charactersRoster(root: string, files: readonly WalkedFile[]): { name: string; aliases: string[] }[] {
  const out: { name: string; aliases: string[] }[] = []
  for (const file of files) {
    if (file.dir !== 'characters' || !file.path.toLowerCase().endsWith('.md')) continue
    const parsed = parseMarkdown(readText(join(root, file.path)))
    const name =
      stringField(parsed.data, 'name') ?? file.path.split('/').pop()?.replace(/\.md$/iu, '') ?? file.path
    out.push({ name, aliases: aliasesOf(parsed.data) })
  }
  return out
}

function ledgerSubjects(root: string, files: readonly WalkedFile[]): string[] {
  const out: string[] = []
  for (const file of files) {
    if (file.dir !== 'facts' || !file.path.toLowerCase().endsWith('.md')) continue
    const parsed = parseMarkdown(readText(join(root, file.path)))
    out.push(stringField(parsed.data, 'subject') ?? file.path.split('/').pop()?.replace(/\.md$/iu, '') ?? file.path)
  }
  return out
}

function sentencesOf(body: string): number {
  const parts = body.split(/[。！？!?…]+/u).filter((part) => part.trim() !== '')
  return parts.length
}

function longestParagraph(paragraphs: readonly ReviewParagraph[]): number {
  let longest = 0
  for (const paragraph of paragraphs) longest = Math.max(longest, paragraph.text.trim().length)
  return longest
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * The five nodes, in report order.
 *
 * Each one is a pure function of (chapter, files, its opinions): no clock, no write, no
 * network. That is what makes a single node testable on its own, and what makes "run only
 * the dimensions you asked for" a real capability instead of a filter on the output.
 */
export const REVIEW_NODES: readonly ReviewNode[] = [
  {
    dimension: 'structure',
    label: specOf('structure').label,
    run: (input) => {
      const paragraphs = input.chapter.paragraphs
      const separators = paragraphs.filter((paragraph) => /^(?:\*{3,}|-{3,}|#{1,6}\s|（.{0,12}）)$/u.test(paragraph.text.trim())).length
      return {
        ok: true,
        output: {
          anchors: {
            paragraphs: paragraphs.length,
            chars: input.chapter.wordCount,
            separators,
            longestParagraph: longestParagraph(paragraphs),
          },
          opinions: buildOpinions(input.chapter, 'structure', input.opinions, input.contextChars),
        },
      }
    },
  },
  {
    dimension: 'character',
    label: specOf('character').label,
    run: (input) => {
      const roster = charactersRoster(input.root, input.files)
      const present: { name: string; count: number }[] = []
      for (const card of roster) {
        let count = 0
        for (const spelling of [card.name, ...card.aliases]) {
          if (spelling === '') continue
          count += occurrencesOf(input.chapter.body, spelling).length
        }
        if (count > 0) present.push({ name: card.name, count })
      }
      present.sort((left, right) => right.count - left.count || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      return {
        ok: true,
        output: {
          anchors: {
            roster: roster.length,
            onStage: present.slice(0, 12).map((entry) => `${entry.name}×${String(entry.count)}`),
          },
          opinions: buildOpinions(input.chapter, 'character', input.opinions, input.contextChars),
        },
      }
    },
  },
  {
    dimension: 'pacing',
    label: specOf('pacing').label,
    run: (input) => {
      const paragraphs = input.chapter.paragraphs
      const dialogue = paragraphs.filter((paragraph) => /^[「“"『]/u.test(paragraph.text.trim())).length
      const total = paragraphs.reduce((sum, paragraph) => sum + paragraph.text.trim().length, 0)
      return {
        ok: true,
        output: {
          anchors: {
            paragraphs: paragraphs.length,
            meanParagraphChars: paragraphs.length === 0 ? 0 : round1(total / paragraphs.length),
            dialogueParagraphs: dialogue,
            longestParagraph: longestParagraph(paragraphs),
          },
          opinions: buildOpinions(input.chapter, 'pacing', input.opinions, input.contextChars),
        },
      }
    },
  },
  {
    dimension: 'style',
    label: specOf('style').label,
    run: (input) => {
      const body = input.chapter.body
      const sentences = sentencesOf(body)
      return {
        ok: true,
        output: {
          anchors: {
            sentences,
            meanSentenceChars: sentences === 0 ? 0 : round1(input.chapter.wordCount / sentences),
            dashes: occurrencesOf(body, '——').length,
            ellipses: occurrencesOf(body, '…').length,
          },
          opinions: buildOpinions(input.chapter, 'style', input.opinions, input.contextChars),
        },
      }
    },
  },
  {
    dimension: 'consistency',
    label: specOf('consistency').label,
    run: (input) => ({
      ok: true,
      output: {
        anchors: {
          pov: input.chapter.pov ?? '',
          ledgerSubjects: ledgerSubjects(input.root, input.files).slice(0, 12),
        },
        opinions: buildOpinions(input.chapter, 'consistency', input.opinions, input.contextChars),
      },
    }),
  },
]

// ---------------------------------------------------------------------------
// Reading the chapter
// ---------------------------------------------------------------------------

interface ChapterGather {
  readonly chapter: ReviewChapter
  readonly files: readonly WalkedFile[]
}

function readChapter(
  root: string,
  request: { readonly chapterId?: string; readonly chapterPath?: string },
): ChapterGather | { readonly error: ReviewError } {
  let files: WalkedFile[]
  try {
    files = walkProjectFiles(root)
  } catch (cause) {
    return { error: { code: 'REVIEW_READ_FAILED', message: `cannot walk the project: ${String(cause)}` } }
  }
  const chapters = files.filter((file) => file.dir === 'chapters' && file.path.toLowerCase().endsWith('.md'))
  const wanted = (request.chapterPath ?? request.chapterId ?? '').trim()
  let picked: WalkedFile | undefined
  if (wanted !== '') {
    picked = chapters.find((file) => file.path === wanted)
    if (picked === undefined) {
      const positions = chapterPositionsFromFiles(root)
      const position = positions.get(wanted)
      if (position !== undefined) picked = chapters.find((file) => file.path === position.path)
    }
    if (picked === undefined) {
      return {
        error: {
          code: 'CHAPTER_NOT_FOUND',
          message: `no chapter matches ${wanted}`,
          hint: 'run inkflow_chapter_list to get the chapter ids this book actually has',
        },
      }
    }
  } else {
    // No address: the last chapter in reading order, the same default #44 uses.
    const positions = chapterPositionsFromFiles(root)
    let bestKey: [number, number] = [-1, -1]
    for (const file of chapters) {
      const position = positions.get(file.path)
      const seq = position?.seq ?? leadingNumber(file.path) ?? 0
      const order = position?.order ?? 0
      if (order > bestKey[0] || (order === bestKey[0] && seq > bestKey[1])) {
        picked = file
        bestKey = [order, seq]
      }
    }
  }
  if (picked === undefined) {
    return {
      error: {
        code: 'CHAPTER_NOT_FOUND',
        message: wanted === '' ? 'the book has no chapter files' : `no chapter matches ${wanted}`,
        hint: 'write a chapter first (inkflow_chapter_create), then review it',
      },
    }
  }
  const text = readText(join(root, picked.path))
  if (text === '') {
    return {
      error: {
        code: 'FILE_UNREADABLE',
        message: `cannot read ${picked.path}`,
        hint: 'the chapter file exists but reads as empty',
      },
    }
  }
  const parsed = parseMarkdown(text)
  const body = parsed.body
  const chapter: ReviewChapter = {
    id: stringField(parsed.data, 'id') ?? picked.path,
    path: picked.path,
    seq: intField(parsed.data, 'seq') ?? leadingNumber(picked.path),
    title:
      stringField(parsed.data, 'title') ?? picked.path.split('/').pop()?.replace(/\.md$/iu, '') ?? picked.path,
    pov: stringField(parsed.data, 'pov') ?? null,
    body,
    wordCount: countChars(body),
    paragraphs: paragraphsOf(body),
    bodyStartLine: frontmatterLineCount(text) + 1,
  }
  return { chapter, files }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The digest the record carries: the chapter plus the two setting directories the nodes
 * read, sorted so the walk order cannot change it. Same recipe as #44's `chapterDigest`,
 * for the same reason — "is this run about the text I am looking at" is a fact about the
 * bytes, not about the file name.
 */
function digestOf(root: string, chapterPath: string, files: readonly WalkedFile[]): string {
  const inputs = [
    chapterPath,
    ...files.filter((file) => file.dir === 'characters' || file.dir === 'facts').map((file) => file.path),
  ].sort()
  const body = inputs.map((path) => `${path}\u0000${sha256(readText(join(root, path)))}`).join('\n')
  return sha256(`review-inputs-v1\n${body}\n`)
}

/** `20261025T095501123Z`: sortable, no separators a Windows path would reject. */
export function reviewRunId(now: Date): string {
  const iso = now.toISOString()
  const [date, time] = iso.split('T')
  const stamp = (time ?? '').replace('Z', '').replaceAll(':', '').replaceAll('.', '')
  return `${(date ?? '').replaceAll('-', '')}T${stamp}Z`
}

/** A chapter id made safe for one directory name; nothing else is allowed to leak in. */
function safeChapterId(chapterId: string): string {
  const safe = chapterId.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return safe === '' ? 'chapter' : safe
}

/** `.inkflow/review/<chapterId>` — the run directory ([ADR-0023](.agents/adrs/0023-proposal-job-private-placement.md)). */
export function reviewDirOf(chapterId: string): string {
  return privateStateRelative('review', safeChapterId(chapterId))
}

/** `.inkflow/review/<chapterId>/<runId>.json` — one run's record. */
export function reviewRunPath(chapterId: string, runId: string): string {
  const safeRun = runId.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return `${reviewDirOf(chapterId)}/${safeRun === '' ? 'run' : safeRun}.json`
}

/** Sort opinions so two runs over the same input cannot reorder: dimension, offset, text. */
function sortOpinions(opinions: readonly ReviewOpinion[]): ReviewOpinion[] {
  const dimensionOrder = (dimension: ReviewDimension): number => REVIEW_DIMENSIONS.indexOf(dimension)
  return [...opinions].sort((left, right) => {
    const byDimension = dimensionOrder(left.dimension) - dimensionOrder(right.dimension)
    if (byDimension !== 0) return byDimension
    const leftOffset = left.evidence === null ? Number.MAX_SAFE_INTEGER : left.evidence.offset
    const rightOffset = right.evidence === null ? Number.MAX_SAFE_INTEGER : right.evidence.offset
    if (leftOffset !== rightOffset) return leftOffset - rightOffset
    if (left.detail === right.detail) return 0
    return left.detail < right.detail ? -1 : 1
  })
}

/** Validate one opinion's shape. A missing/unknown dimension and empty text are refusals. */
function checkOpinion(index: number, input: ReviewOpinionInput): ReviewRejection | undefined {
  const dimension = asDimension((input.dimension ?? '').trim())
  if (dimension === undefined) {
    return {
      index,
      code: 'REVIEW_DIMENSION_UNKNOWN',
      message: `第 ${String(index + 1)} 条意见的 dimension 是 "${String(input.dimension ?? '')}"，只认 ${REVIEW_DIMENSIONS.join(' / ')}`,
    }
  }
  if ((input.text ?? '').trim() === '') {
    return {
      index,
      code: 'REVIEW_TEXT_REQUIRED',
      message: `第 ${String(index + 1)} 条意见没有 text：意见本身要写清楚哪里不对、怎么改`,
    }
  }
  if (input.severity !== undefined && !VALID_SEVERITIES.includes(input.severity as FindingSeverity)) {
    return {
      index,
      code: 'REVIEW_SEVERITY_INVALID',
      message: `第 ${String(index + 1)} 条意见的 severity 是 "${input.severity}"，只认 warning / info（审稿意见不是阻断项）`,
    }
  }
  return undefined
}

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

type RecordOutcome =
  | { readonly ok: true; readonly file: ReviewFileResult }
  | { readonly ok: false; readonly error: ReviewError }

function recordRun(root: string, run: ReviewRunRecord): RecordOutcome {
  const relative = reviewRunPath(run.chapterId, run.runId)
  const ignored = ensurePrivateStateIgnored(root)
  const written = writeTextAtomic(root, relative, renderReviewRunFile(run))
  if (!written.ok) {
    return {
      ok: false,
      error: {
        code: written.error.code,
        message: written.error.message,
        hint: 'the run record lives under .inkflow/review/; check the write lock and the path rules',
      },
    }
  }
  return {
    ok: true,
    file: {
      path: relative,
      bytes: written.bytes,
      created: written.created,
      ignoreLineAdded: ignored.ok && ignored.added,
    },
  }
}

// ---------------------------------------------------------------------------
// Serialisation: the record is a contract, so the key order is part of it
// ---------------------------------------------------------------------------

function locatorRecord(locator: FindingLocator | null): Record<string, unknown> | null {
  if (locator === null) return null
  switch (locator.kind) {
    case 'entity':
      return { kind: 'entity', entityKind: locator.entityKind, id: locator.id }
    case 'chapter':
      return { kind: 'chapter', chapterId: locator.chapterId }
    case 'catalog':
      return locator.volumeId === undefined ? { kind: 'catalog' } : { kind: 'catalog', volumeId: locator.volumeId }
    case 'path':
      return locator.line === undefined
        ? { kind: 'path', path: locator.path }
        : { kind: 'path', path: locator.path, line: locator.line }
  }
}

export function reviewOpinionRecord(opinion: ReviewOpinion): Record<string, unknown> {
  return {
    dimension: opinion.dimension,
    code: opinion.code,
    group: opinion.group,
    severity: opinion.severity,
    locator: locatorRecord(opinion.locator),
    located: opinion.located,
    unlocatedReason: opinion.unlocatedReason,
    unlocatedDetail: opinion.unlocatedDetail,
    detail: opinion.detail,
    hint: opinion.hint,
    fixable: opinion.fixable,
    evidence:
      opinion.evidence === null
        ? null
        : {
            before: opinion.evidence.before,
            quote: opinion.evidence.quote,
            after: opinion.evidence.after,
            paragraph: opinion.evidence.paragraph,
            offset: opinion.evidence.offset,
            source: opinion.evidence.source,
          },
  }
}

function anchorsRecord(anchors: ReviewAnchorValue): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(anchors)) out[key] = value
  return out
}

function dimensionRecord(summary: ReviewDimensionSummary): Record<string, unknown> {
  return {
    dimension: summary.dimension,
    label: summary.label,
    status: summary.status,
    opinions: summary.opinions,
    located: summary.located,
    anchors: anchorsRecord(summary.anchors),
    code: summary.code,
    message: summary.message,
    skipReason: summary.skipReason,
  }
}

/**
 * The record's bytes.
 *
 * Unlike the gate's conclusion this file **is** clock-stamped (`createdAt` + the run id):
 * ADR-0022 D4.5 draws that line — a verdict about a chapter is the same bytes twice, a
 * *run* is an event, and the reviewer's opinions are not reproducible because the model
 * that produced them is not part of this plugin (X-26).
 */
export function renderReviewRunFile(run: ReviewRunRecord): string {
  const payload = {
    schemaVersion: REVIEW_FILE_SCHEMA_VERSION,
    runId: run.runId,
    chapterId: run.chapterId,
    chapterPath: run.chapterPath,
    chapterTitle: run.chapterTitle,
    seq: run.seq ?? null,
    wordCount: run.wordCount,
    chapterDigest: run.chapterDigest,
    reviewer: run.reviewer,
    createdAt: run.createdAt,
    scores: run.scores,
    dimensions: run.dimensions.map((summary) => dimensionRecord(summary)),
    rejected: run.rejected.map((rejection) => ({
      index: rejection.index,
      code: rejection.code,
      message: rejection.message,
    })),
    opinions: run.opinions.map((opinion) => reviewOpinionRecord(opinion)),
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/** Counts over everything, printing only the first `limit` opinions (the record keeps all). */
export function reviewRunWire(run: ReviewRunRecord, limit = REVIEW_LIST_LIMIT * 5): Record<string, unknown> {
  const capped = run.opinions.slice(0, Math.max(0, limit))
  const located = run.opinions.filter((opinion) => opinion.located).length
  return {
    runId: run.runId,
    chapterId: run.chapterId,
    chapterPath: run.chapterPath,
    chapterTitle: run.chapterTitle,
    seq: run.seq ?? null,
    wordCount: run.wordCount,
    chapterDigest: run.chapterDigest,
    reviewer: run.reviewer,
    createdAt: run.createdAt,
    scores: run.scores,
    counts: {
      opinions: run.opinions.length,
      located,
      unlocated: run.opinions.length - located,
      ok: run.dimensions.filter((summary) => summary.status === 'ok').length,
      failed: run.dimensions.filter((summary) => summary.status === 'failed').length,
      skipped: run.dimensions.filter((summary) => summary.status === 'skipped').length,
      rejected: run.rejected.length,
    },
    dimensions: run.dimensions.map((summary) => dimensionRecord(summary)),
    rejected: run.rejected.map((rejection) => ({
      index: rejection.index,
      code: rejection.code,
      message: rejection.message,
    })),
    opinions: capped.map((opinion) => reviewOpinionRecord(opinion)),
    returned: capped.length,
    truncated: run.opinions.length > capped.length,
    recordPath: reviewRunPath(run.chapterId, run.runId),
  }
}

// ---------------------------------------------------------------------------
// Reading runs back: the panel's list, and the comparison table's input
// ---------------------------------------------------------------------------

export interface ReviewRunList {
  readonly runs: readonly ReviewRunRecord[]
  /** Files under the run directory that could not be read as a record (never silently nothing). */
  readonly skippedFiles: readonly string[]
}

/**
 * Every recorded run of one chapter, newest first.
 *
 * Newest first is the run id sorted descending, which works because `reviewRunId` is a
 * fixed-width UTC stamp — no directory mtime, so a `git clone` or a copy keeps the order.
 */
export function listReviewRuns(root: string, chapterId: string): ReviewRunList {
  const dir = reviewDirOf(chapterId)
  let names: string[]
  try {
    names = readdirSync(join(root, ...dir.split('/')))
  } catch {
    return { runs: [], skippedFiles: [] }
  }
  const runs: ReviewRunRecord[] = []
  const skippedFiles: string[] = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue
    const record = readRunFile(root, `${dir}/${name}`)
    if (record === undefined) skippedFiles.push(`${dir}/${name}`)
    else runs.push(record)
  }
  runs.sort((left, right) => (left.runId < right.runId ? 1 : left.runId > right.runId ? -1 : 0))
  skippedFiles.sort()
  return { runs, skippedFiles }
}

function readRunFile(root: string, relative: string): ReviewRunRecord | undefined {
  let text: string
  try {
    text = readText(join(root, ...relative.split('/')))
  } catch {
    return undefined
  }
  if (text === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/u, ''))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const raw = parsed as Record<string, unknown>
  // Tolerant on purpose: the reader's job is to show what is there, and a hand-edited or
  // half-written record must not take the whole panel down with it. Anything that cannot
  // supply the fields the panel needs is reported as a skipped file by the caller.
  const runId = typeof raw['runId'] === 'string' ? raw['runId'] : undefined
  const runChapterId = typeof raw['chapterId'] === 'string' ? raw['chapterId'] : undefined
  if (runId === undefined || runChapterId === undefined) return undefined
  const dimensionsRaw = Array.isArray(raw['dimensions']) ? (raw['dimensions'] as unknown[]) : []
  const opinionsRaw = Array.isArray(raw['opinions']) ? (raw['opinions'] as unknown[]) : []
  const rejectedRaw = Array.isArray(raw['rejected']) ? (raw['rejected'] as unknown[]) : []
  return {
    runId,
    chapterId: runChapterId,
    chapterPath: typeof raw['chapterPath'] === 'string' ? raw['chapterPath'] : '',
    chapterTitle: typeof raw['chapterTitle'] === 'string' ? raw['chapterTitle'] : '',
    seq: typeof raw['seq'] === 'number' ? raw['seq'] : undefined,
    wordCount: typeof raw['wordCount'] === 'number' ? raw['wordCount'] : 0,
    chapterDigest: typeof raw['chapterDigest'] === 'string' ? raw['chapterDigest'] : '',
    reviewer: typeof raw['reviewer'] === 'string' ? raw['reviewer'] : 'unknown',
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : '',
    dimensions: dimensionsRaw.map((entry) => readDimensionSummary(entry)).filter((entry): entry is ReviewDimensionSummary => entry !== undefined),
    opinions: opinionsRaw.map((entry) => readOpinion(entry)).filter((entry): entry is ReviewOpinion => entry !== undefined),
    rejected: rejectedRaw
      .map((entry) => readRejection(entry))
      .filter((entry): entry is ReviewRejection => entry !== undefined),
    scores: readScores(raw['scores']),
  }
}

function readScores(raw: unknown): Readonly<Record<string, number>> | null {
  if (typeof raw !== 'object' || raw === null) return null
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (asDimension(key) === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    out[key] = value
  }
  return Object.keys(out).length === 0 ? null : out
}

function readRejection(raw: unknown): ReviewRejection | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record['code'] !== 'string') return undefined
  return {
    index: typeof record['index'] === 'number' ? record['index'] : 0,
    code: record['code'],
    message: typeof record['message'] === 'string' ? record['message'] : '',
  }
}

function readDimensionSummary(raw: unknown): ReviewDimensionSummary | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const dimension = asDimension(typeof record['dimension'] === 'string' ? record['dimension'] : '')
  if (dimension === undefined) return undefined
  const status = record['status']
  const anchorsRaw = typeof record['anchors'] === 'object' && record['anchors'] !== null ? (record['anchors'] as Record<string, unknown>) : {}
  const anchors: Record<string, number | string | readonly string[]> = {}
  for (const [key, value] of Object.entries(anchorsRaw)) {
    if (typeof value === 'number' || typeof value === 'string') anchors[key] = value
    else if (Array.isArray(value)) anchors[key] = value.filter((item): item is string => typeof item === 'string')
  }
  return {
    dimension,
    label: typeof record['label'] === 'string' ? record['label'] : REVIEW_DIMENSION_LABELS[dimension],
    status: status === 'failed' ? 'failed' : status === 'skipped' ? 'skipped' : 'ok',
    opinions: typeof record['opinions'] === 'number' ? record['opinions'] : 0,
    located: typeof record['located'] === 'number' ? record['located'] : 0,
    anchors,
    code: typeof record['code'] === 'string' ? record['code'] : null,
    message: typeof record['message'] === 'string' ? record['message'] : null,
    skipReason: typeof record['skipReason'] === 'string' ? record['skipReason'] : null,
  }
}

function readLocator(raw: unknown): FindingLocator | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  switch (record['kind']) {
    case 'entity': {
      const kind = record['entityKind']
      if (typeof kind !== 'string' || typeof record['id'] !== 'string') return null
      if (!(CONTENT_DIRS as readonly string[]).includes(kind)) return null
      return { kind: 'entity', entityKind: kind as ContentDir, id: record['id'] }
    }
    case 'chapter':
      return typeof record['chapterId'] === 'string' ? { kind: 'chapter', chapterId: record['chapterId'] } : null
    case 'catalog':
      return typeof record['volumeId'] === 'string' ? { kind: 'catalog', volumeId: record['volumeId'] } : { kind: 'catalog' }
    case 'path':
      if (typeof record['path'] !== 'string') return null
      return typeof record['line'] === 'number'
        ? { kind: 'path', path: record['path'], line: record['line'] }
        : { kind: 'path', path: record['path'] }
    default:
      return null
  }
}

function readOpinion(raw: unknown): ReviewOpinion | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const dimension = asDimension(typeof record['dimension'] === 'string' ? record['dimension'] : '')
  if (dimension === undefined) return undefined
  const located = record['located'] === true
  const locator = located ? readLocator(record['locator']) : null
  const evidenceRaw = typeof record['evidence'] === 'object' && record['evidence'] !== null ? (record['evidence'] as Record<string, unknown>) : null
  const source = evidenceRaw?.['source']
  return {
    dimension,
    code: typeof record['code'] === 'string' ? record['code'] : REVIEW_DIMENSION_CODES[dimension],
    group:
      typeof record['group'] === 'string'
        ? (record['group'] as FindingGroup)
        : REVIEW_DIMENSION_GROUPS[dimension],
    severity: asSeverity(typeof record['severity'] === 'string' ? record['severity'] : undefined),
    locator,
    // One fact written twice: a record whose `located` and `locator` disagree is read as
    // unlocated, because the jump path is what would otherwise break.
    located: located && locator !== null,
    unlocatedReason: typeof record['unlocatedReason'] === 'string' ? record['unlocatedReason'] : null,
    unlocatedDetail: typeof record['unlocatedDetail'] === 'string' ? record['unlocatedDetail'] : null,
    detail: typeof record['detail'] === 'string' ? record['detail'] : '',
    hint: typeof record['hint'] === 'string' ? record['hint'] : '',
    fixable: false,
    evidence:
      evidenceRaw === null
        ? null
        : {
            before: typeof evidenceRaw['before'] === 'string' ? evidenceRaw['before'] : '',
            quote: typeof evidenceRaw['quote'] === 'string' ? evidenceRaw['quote'] : '',
            after: typeof evidenceRaw['after'] === 'string' ? evidenceRaw['after'] : '',
            paragraph: typeof evidenceRaw['paragraph'] === 'number' ? evidenceRaw['paragraph'] : null,
            offset: typeof evidenceRaw['offset'] === 'number' ? evidenceRaw['offset'] : 0,
            source:
              source === 'quote' || source === 'paragraph' || source === 'offset' || source === 'line'
                ? source
                : 'offset',
          },
  }
}

// ---------------------------------------------------------------------------
// The two channel projections (read-only: the panel never writes a run)
// ---------------------------------------------------------------------------

/** One run reduced to what a list row needs. */
export function reviewRunSummary(run: ReviewRunRecord): Record<string, unknown> {
  const located = run.opinions.filter((opinion) => opinion.located).length
  return {
    runId: run.runId,
    reviewer: run.reviewer,
    createdAt: run.createdAt,
    chapterDigest: run.chapterDigest,
    opinions: run.opinions.length,
    located,
    failed: run.dimensions.filter((summary) => summary.status === 'failed').length,
    skipped: run.dimensions.filter((summary) => summary.status === 'skipped').length,
    scores: run.scores,
  }
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
// ---------------------------------------------------------------------------

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
