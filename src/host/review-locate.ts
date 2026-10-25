/**
 * Issue #46 — addressing: from a model's position hint to a verified `path#L<n>` anchor.
 *
 * Extracted from `review.ts` by #193. The bytes of the logic did not change; what changed
 * is that the one thing a review cannot fake now lives in a file whose whole subject is
 * that one thing.
 *
 * ## What this module owns
 *
 *   * the body's **paragraphs** (`paragraphsOf`): non-empty line blocks with their
 *     offsets, because a model counting paragraphs counts what it sees;
 *   * the **hint protocol** (`locateOpinion`): `quote` / `paragraph`+`offset` /
 *     `offset` / `line`, each checked against the real bytes, with the source that
 *     actually resolved recorded (`source`) so a wrong-looking excerpt is diagnosable;
 *   * the **evidence window** around a located excerpt (before/quote/after, cut at
 *     newlines so an excerpt never drags a whole line in);
 *   * the two **shapes** an opinion exists in: `ReviewOpinionInput` (what the model
 *     hands in) and `ReviewOpinion` (what the record keeps, `locator`/`located` as two
 *     spells of one fact);
 *   * the **refusal vocabulary** for an opinion the run kept but could not locate
 *     (`REVIEW_UNLOCATED_*` codes) — a rejection is data, not an exception.
 *
 * ## What it refuses to own
 *
 *   * what any dimension means, or which dimensions exist (归 `review-nodes.ts`)；
 *   * whether an opinion should exist at all — routing and shape validation are the
 *     nodes' business;
 *   * the run record file (归 `review-store.ts`)、the DAG (归 `review.ts`)。
 */

import { join } from 'node:path'

import { chapterPositionsFromFiles } from './domains/foreshadowing-query.js'
import { countChars, leadingNumber, readText } from './domains/scan-helpers.js'
import type { Finding, FindingLocator } from './findings.js'
import { intField, parseMarkdown, stringField } from './frontmatter.js'
import { walkProjectFiles } from './indexer.js'
import type { WalkedFile } from './indexer.js'
import type { ReviewDimension } from './review-nodes.js'

/** Default excerpt radius on each side of a located opinion. */
export const REVIEW_CONTEXT_CHARS = 12

/** The longest context block `inkflow_review_context` will hand back. */
export const REVIEW_DEFAULT_CONTEXT_CHARS = 12000

/** How long the excerpt itself is when the hint was a position rather than a quotation. */
const REVIEW_QUOTE_SPAN = 24

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

export interface ReviewError {
  readonly code: string
  readonly message: string
  readonly hint?: string
}

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
export function occurrencesOf(haystack: string, needle: string): number[] {
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

interface ChapterGather {
  readonly chapter: ReviewChapter
  readonly files: readonly WalkedFile[]
}

export function readChapter(
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
