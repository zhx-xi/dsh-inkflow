/**
 * The vocabulary both writing-context assemblies agree on: what a caller may ask for, what a
 * segment is, how the budget is measured, and the extension seam domains append to.
 *
 * WHY IT IS A FILE: the six-segment context and the nine-segment brief disagree about the
 * ladder on purpose (ADR-0022 D2: the brief never trims the task statement, the injected
 * block trims its summary first), but they must agree on the unit, the options and the
 * registry — otherwise the two assemblies would slowly acquire two spellings of `budgetTokens`
 * or two ideas of what a segment name is. Keeping that agreement here is what lets each
 * assembly import the other's absence rather than importing the other assembly.
 *
 * A leaf in the module graph: it imports the two domain segments it registers and nothing
 * else from this module, so `writing-context-build.ts` and `writing-context-brief.ts` never
 * depend on each other through it.
 */

import { factsSegment } from './domains/facts-prompt.js'
import { foreshadowSegment } from './domains/foreshadowing-query.js'
import type { ProjectState } from './project.js'
import type { ChapterHead } from './writing-sources.js'

export const DEFAULT_BUDGET_TOKENS = 1200
export const DEFAULT_TAIL_CHARS = 300

/** L3 shrinks the previous-chapter tail to this many characters. */
export const SHRUNK_TAIL_CHARS = 120

/** A recovery hint must name a line count small enough to beat a full read. */
export const TAIL_RECOVERY_LINES = 40

/** CJK letters/punctuation: one token per character is the safe direction. */
const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u

export interface WritingContextOptions {
  /** Estimated-token budget for the whole block (default 1200). */
  budgetTokens?: number
  /** Characters taken from the previous chapter's body (default 300). */
  tailChars?: number
  /** Explicit chapter to describe; defaults to the highest `seq`. */
  chapterSeq?: number
  /**
   * The exact chapter file to describe, resolved by the caller.
   *
   * This is the `chapterId` of a `GET /brief` request after the channel looked it up in
   * `chapterPositions()`; it wins over `chapterSeq` because a volume-local number is the
   * wrong address for a named chapter in a multi-volume book. An id that matches nothing
   * is refused by the channel (404 `CHAPTER_NOT_FOUND`) and never reaches this option.
   */
  chapterPath?: string
}

export type WritingContextSegmentName = 'project' | 'chapter' | 'tail' | 'world' | 'facts' | 'foreshadow'

/**
 * One segment a domain contributes, in the fixed order of `EXTRA_SEGMENTS`
 * (roadmap X-13: `project → chapter → tail → world → facts → foreshadow`).
 *
 * Why a registry instead of another `if` in the renderer: two domains land their
 * own segment in the same milestone (the facts and foreshadowing domains), and the render
 * function is a single 40-line block with a hand-written trim ladder — without a
 * seam they queue on the same lines and every rebase is a semantic merge.
 *
 * A contributor supplies the text and its own cap, never the order: the order is
 * the array's order, and the drop order is `world → extras (in array order) → tail`
 * (see the ladder in `buildWritingContext`).
 */
export interface ExtraSegmentSpec {
  readonly name: WritingContextSegmentName
  /** Label used in the `[trimmed: …]` marker — the author's word, not the code's. */
  readonly label: string
  /**
   * Share of the token budget this segment may occupy, as a **character** cap of
   * `floor(capRatio × budgetTokens)`. Characters because `estimateTokens` counts a
   * CJK glyph as one token: the cap is then exact in the worst case and generous
   * for Latin text, which is the safe direction for a cap.
   */
  readonly capRatio: number
  /**
   * The segment's text for the chapter being written, or `undefined` when this
   * book has nothing to say (which renders no segment at all, not an empty one).
   */
  build(input: ExtraSegmentInput): string | undefined
}

export interface ExtraSegmentInput {
  readonly root: string
  /** The chapter being written; `undefined` when the book has no chapters yet. */
  readonly current: ChapterHead | undefined
  /** The chapter's outline body (its title/plot), already read for the chapter segment. */
  readonly outlineBody: string
  /**
   * This segment's character budget: `floor(capRatio × budgetTokens)`, computed once by
   * the seam (the field is read-only — a contributor must not re-derive or grow it).
   *
   * Why the builder needs it: a segment that lists one item per line cannot honour a
   * character cap it cannot see. The first version of the `facts` segment counted a
   * dozen facts, rendered them, and was then cut mid-line by the seam's `clipHead` —
   * the header said "12 条" while four lines came out and the last one ended inside a
   * value. A builder that packs **whole lines** up to `capChars` is the only shape that
   * can report a truthful count, and it is also the only shape that can decide
   * "header + one line does not fit, so say nothing at all" instead of emitting a
   * truncated heading that the trim ladder will never revisit.
   */
  readonly capChars: number
}

/**
 * Segments registered by domains. The array's order **is** the segment order (roadmap
 * X-13: `… → world → facts → foreshadow`), so a contributor inserts at the position the
 * contract names instead of reordering anything else.
 *
 * A contributor appends its ONE entry here — the renderer, the budget and the trim
 * ladder stay untouched. With the registry empty the produced text is byte-identical to
 * the pre-seam version, which is the property `tests/writing-context-segments.test.js`
 * pins (it is now exercised with facts and foreshadow registered, X-13 order).
 */
export const EXTRA_SEGMENTS: readonly ExtraSegmentSpec[] = [factsSegment, foreshadowSegment]

export interface WritingContextSegment {
  name: WritingContextSegmentName
  text: string
}

export interface WritingContextResult {
  /** The text injected into the system prompt; `''` means "inject nothing". */
  text: string
  /** Gate verdict that decided the outcome (`usable` is the only injecting one). */
  state: ProjectState
  /** Absolute project root — for logs/tests, never rendered into `text`. */
  root: string
  segments: WritingContextSegment[]
  /** Segment labels dropped or shortened by the budget, in trim-ladder order. */
  trimmed: string[]
  /** Estimated tokens of `text`. */
  tokens: number
  budgetTokens: number
}

/**
 * Estimate tokens without a tokenizer dependency.
 *
 * CJK glyphs count one token each (a deliberate over-estimate), the rest four
 * characters per token. The budget only has to be *conservative*: too low costs
 * a little context, too high costs the model's window.
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (CJK.test(char)) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), min), max)
}
