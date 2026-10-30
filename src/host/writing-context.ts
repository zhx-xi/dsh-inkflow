/**
 * The writing context: what a session opened inside a novel must
 * know before its first tool call — which book, which chapter, how the previous
 * chapter ended, and which world-book entries this chapter is about.
 *
 * WHY A SYSTEM-PROMPT SECTION AND NOT A TOOL: a tool answers only after the model decided
 * to call it, and by then the first paragraph is already drafted. Skills are the same
 * story (the catalog carries names; the body loads on demand). The section is the one
 * surface rendered before the model's first token.
 *
 * WHY THIS IS A PURE PROJECTION: the whole rule set — gate, segmentation, caps, budget
 * ladder, rendering — with no session state and no cache, so every rule is testable
 * without a Host. The Host wiring (session directory → service registration) is in
 * `prompt.ts`.
 *
 * Degradation is the default posture: anything that is not a `usable` project yields
 * `text: ''`, and unreadable data simply removes that segment. The one write this path
 * can cause is the gate's documented `index/` self-heal in `inspectProject` — the same
 * relaxation every tool gets, so a project cannot be "usable for tools but invisible to
 * the prompt".
 *
 * ## Two assemblies, one set of renderers (ADR-0022 D1/D2)
 *
 * This module now owns **two** projections, and the difference is deliberate:
 *
 *   * {@link buildWritingContext} — the six segments that shipped first, injected as the
 *     `inkflow:writing-context` system-prompt section. Its order, caps and six-rung ladder
 *     are pinned by `tests/prompt.test.js`, so the brief must not touch them.
 *   * {@link buildWritingBrief} — the **nine** segments of ADR-0022 D2
 *     (`outline → promise → characters → voice → facts → foreshadow → world →
 *     prevTail → anchors`), each reported as `{ id, bytes, tokens, truncated }`, with
 *     the four-rung ladder of D2 (`world → facts → foreshadow → prevTail`) and a trim
 *     record per rung. It is what the preview shows and what the audit file records, plus
 *     one book identity line above the first segment — outside the ladder.
 *
 * Why not one function with a flag: the two ladder contracts genuinely disagree — D2 says
 * the outline and the task statement are **never** trimmed, while the injected six-segment
 * block must trim its summary first (else a small budget stops injecting the chapter). A
 * shared ladder with a per-caller exception list is the "two spellings of one rule" bug
 * this project keeps re-learning. So: two ladders, **one** implementation of every
 * segment's text (`writing-context-render.ts`) — that is what must not drift.
 *
 * Both assemblies share {@link estimateTokens} — the budget has exactly one unit.
 */

// The contract, the registry and the budget unit; the segment tables and the two assemblies
// keep their single implementation in the files below, and this module keeps their address.
export type * from './writing-context-types.js'
export {
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_TAIL_CHARS,
  EXTRA_SEGMENTS,
  estimateTokens,
} from './writing-context-types.js'
export type { BriefSegmentId, BriefSegmentRecord, BriefTrimRecord, WritingBrief } from './writing-context-brief.js'
export {
  BRIEF_CAP_RATIOS,
  BRIEF_LABELS,
  BRIEF_SEGMENT_ORDER,
  BRIEF_TRIM_ORDER,
  buildWritingBrief,
} from './writing-context-brief.js'
export { buildWritingContext } from './writing-context-build.js'
