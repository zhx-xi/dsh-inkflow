/**
 * The writing context (issue #20): what a session opened inside a novel must
 * know before its first tool call — which book, which chapter, how the previous
 * chapter ended, and which world-book entries this chapter is about.
 *
 * WHY A SYSTEM-PROMPT SECTION AND NOT A TOOL: a tool answers only after the
 * model decided to call it, and by then the first paragraph is already drafted.
 * Skills are the same story (the catalog carries names; the body loads on
 * demand). The section is the one surface rendered before the model's first
 * token.
 *
 * WHY THIS IS A PURE PROJECTION: `buildWritingContext(root, opts)` is the whole
 * rule set — gate, segmentation, caps, budget ladder, rendering — with no
 * session state and no cache. That makes every rule testable without a Host,
 * and it is the function the workbench's "briefing preview" will reuse. The
 * Host wiring (session directory → service registration) lives in `prompt.ts`.
 *
 * Degradation is the default posture: anything that is not a `usable` project
 * yields `text: ''`, and unreadable data simply removes that segment. The one
 * write this path can cause is the gate's documented `index/` self-heal in
 * `inspectProject` — the same relaxation every tool gets, so a project cannot
 * be "usable for tools but invisible to the prompt".
 *
 * ## Two assemblies, one set of renderers (issue #43, ADR-0022 D1/D2)
 *
 * This module now owns **two** projections, and the difference is deliberate:
 *
 *   * {@link buildWritingContext} — the six segments #20 shipped, injected as the
 *     `inkflow:writing-context` system-prompt section. Its order, its caps and its
 *     six-rung ladder are pinned by `tests/prompt.test.js` (a byte-for-byte fence
 *     around a surface the model sees on every step), so #43 must not touch them.
 *   * {@link buildWritingBrief} — the **nine** segments of ADR-0022 D2
 *     (`outline → promise → characters → voice → facts → foreshadow → world →
 *     prevTail → anchors`), each reported as `{ id, bytes, tokens, truncated }`, with
 *     the four-rung ladder of D2 (`world → facts → foreshadow → prevTail`) and a trim
 *     record per rung. It is what the preview shows and what the audit file records.
 *
 * Why not one function with a flag: the two ladder contracts genuinely disagree —
 * D2 says the outline and the project's task statement are **never** trimmed, while the
 * injected six-segment block must keep trimming its summary first (otherwise a small
 * budget silently stops injecting the chapter). A single ladder cannot honour both, and
 * a shared ladder with a per-caller exception list is the "two spellings of one rule"
 * bug this project keeps re-learning. So: two ladders, **one** implementation of every
 * segment's text (`writing-context-render.ts`), which is what actually must not drift.
 *
 * Both assemblies share {@link estimateTokens} — the budget has exactly one unit.
 */

import { Buffer } from 'node:buffer'
import { basename } from 'node:path'

import { charactersInChapter, voiceInChapter } from './brief-sources.js'
import { MAX_OUTLINE_CHARS, SECTION_HEADING, clipHead, clipTail, renderChapter, renderProject, renderTail, renderTrimMarker, renderWorld } from './writing-context-render.js'
import { factsSegment } from './domains/facts-prompt.js'
import { foreshadowSegment } from './domains/foreshadowing-query.js'
import type { ProjectState } from './project.js'
import { inspectProject } from './project.js'
import type { ChapterHead, ChapterPair, OutlinedChapter, ProjectStats, TailSlice, WorldSelection } from './writing-sources.js'
import {
  loadWorldEntries,
  matchWorldEntries,
  readChapterOutline,
  readChapterPair,
  readDeclaredChapterId,
  readProjectStats,
  readTail,
} from './writing-sources.js'

export const DEFAULT_BUDGET_TOKENS = 1200
export const DEFAULT_TAIL_CHARS = 300

/** L3 shrinks the previous-chapter tail to this many characters. */
const SHRUNK_TAIL_CHARS = 120

/**
 * Floor for a share-based segment cap, in characters (one header plus one line).
 *
 * A share of a tiny budget is a fraction of a sentence: at 20 tokens the ledger's 15% is
 * three characters, so its own builder (which packs whole lines, `facts-prompt.ts`)
 * correctly refuses to emit anything — and the brief would then report a book **with**
 * ledger entries as "no source", which is a lie about the book rather than a fact about
 * the budget. The floor keeps the segment visible; the trim ladder, not the cap, is what
 * decides it does not fit, and `overBudget` says so.
 */
const BRIEF_MIN_CAP_CHARS = 80

/** A recovery hint must name a line count small enough to beat a full read. */
const TAIL_RECOVERY_LINES = 40

/** CJK letters/punctuation: one token per character is the safe direction. */
const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u

/** Ladder labels, in the documented drop order. */
const TRIM_SUMMARY = '项目摘要'
const TRIM_OUTLINE = '当前章大纲'
const TRIM_TAIL = '上章结尾'
const TRIM_WORLD = '世界书'

export interface WritingContextOptions {
  /** Estimated-token budget for the whole block (default 1200). */
  budgetTokens?: number
  /** Characters taken from the previous chapter's body (default 300). */
  tailChars?: number
  /** Explicit chapter to describe; defaults to the highest `seq`. */
  chapterSeq?: number
  /**
   * The exact chapter file to describe, resolved by the caller (issue #200).
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
 * own segment in the same milestone (facts #32, foreshadow #31), and the render
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

/** One rung of the trim ladder. */
interface RenderState {
  dropSummary: boolean
  dropOutline: boolean
  dropTail: boolean
  dropWorld: boolean
  /** Drops every registered extra segment at once (roadmap X-13's `facts`/`foreshadow`). */
  dropExtras: boolean
  tailLimit: number
}

/** One registered extra segment, already built and clipped to its own cap. */
interface RenderedExtra {
  name: WritingContextSegmentName
  label: string
  text: string
}

interface RenderInput {
  state: RenderState
  /** The configured tail length: the definition, not a trim. */
  tailChars: number
  title: string
  stats: ProjectStats | undefined
  pair: ChapterPair
  outline: OutlinedChapter | undefined
  tail: TailSlice | undefined
  world: WorldSelection
  extras: readonly RenderedExtra[]
}

interface RenderedContext {
  segments: WritingContextSegment[]
  trimmed: string[]
  text: string
  tokens: number
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

/**
 * Build the writing context for a project root.
 *
 * Deterministic for a given tree, with no cache: a stale "current chapter" is
 * worse than the few milliseconds a fresh read costs.
 */
export function buildWritingContext(root: string, options: WritingContextOptions = {}): WritingContextResult {
  const budgetTokens = clampInt(options.budgetTokens, DEFAULT_BUDGET_TOKENS, 1, 200_000)
  const tailChars = clampInt(options.tailChars, DEFAULT_TAIL_CHARS, 1, 20_000)
  const probe = inspectProject(root)
  const empty: WritingContextResult = {
    text: '',
    state: probe.state,
    root: probe.root,
    segments: [],
    trimmed: [],
    tokens: 0,
    budgetTokens,
  }
  if (!probe.usable) return empty

  const materials = loadMaterials(probe.root, options)
  const { title, stats, pair, outline, tail, world } = materials

  // Registered segments are built once, before the ladder: their content depends on
  // the chapter, never on a rung. An empty registry (B0's state) produces no extra,
  // so the rendered text stays byte-identical to the pre-seam version.
  const extras: RenderedExtra[] = EXTRA_SEGMENTS.map((spec) => {
    // The cap is the seam's to compute (it owns the budget) and the segment's to honour
    // (it owns the line structure). `clipHead` below stays as the last-resort guard: a
    // contributor that ignores `capChars` must not be able to displace the rest.
    const capChars = Math.max(1, Math.floor(spec.capRatio * budgetTokens))
    const built = spec.build({ root: probe.root, current: pair.current, outlineBody: outline?.body ?? '', capChars })
    if (built === undefined || built.trim() === '') return undefined
    return { name: spec.name, label: spec.label, text: clipHead(built, capChars) }
  }).filter((extra): extra is RenderedExtra => extra !== undefined)

  const base: RenderState = {
    dropSummary: false,
    dropOutline: false,
    dropTail: false,
    dropWorld: false,
    dropExtras: false,
    tailLimit: tailChars,
  }
  const shrunk = Math.min(SHRUNK_TAIL_CHARS, tailChars)
  // Drop order: summary → current-chapter outline → world book → registered extras →
  // tail (shrink first, then drop). The world book goes before the tail because the
  // tail is the only segment with no way back (the model cannot re-read the previous
  // chapter, but it can fetch a world entry). The current chapter is never removed.
  // See the matching rationale in renderWritingContext.
  //
  // The extra-drop rung sits between them, and is a no-op when nothing is registered:
  // a rung that renders identically to the one above it is skipped below, so the
  // ladder's behaviour is unchanged while the registry is empty.
  const ladder: RenderState[] = [
    base,
    { ...base, dropSummary: true },
    { ...base, dropSummary: true, dropOutline: true },
    { ...base, dropSummary: true, dropOutline: true, dropWorld: true },
    ...(extras.length === 0
      ? []
      : [{ ...base, dropSummary: true, dropOutline: true, dropWorld: true, dropExtras: true }]),
    ...(shrunk < tailChars
      ? [{ ...base, dropSummary: true, dropOutline: true, dropWorld: true, dropExtras: true, tailLimit: shrunk }]
      : []),
    {
      ...base,
      dropSummary: true,
      dropOutline: true,
      dropWorld: true,
      dropExtras: true,
      tailLimit: shrunk,
      dropTail: true,
    },
  ]

  let chosen: RenderedContext | undefined
  let previousText: string | undefined
  for (const state of ladder) {
    const rendered = renderWritingContext({ state, tailChars, title, stats, pair, outline, tail, world, extras })
    // A rung that renders identically to the one above it (e.g. a book with no
    // outline) must not be reported as "trimmed": nothing was dropped.
    if (rendered.text === previousText) continue
    previousText = rendered.text
    chosen = rendered
    if (rendered.tokens <= budgetTokens) break
  }

  if (chosen === undefined) return empty
  return {
    text: chosen.text,
    state: probe.state,
    root: probe.root,
    segments: chosen.segments,
    trimmed: chosen.trimmed,
    tokens: chosen.tokens,
    budgetTokens,
  }
}

/** Everything both assemblies read from the book, loaded once per call. */
interface Materials {
  title: string
  stats: ProjectStats | undefined
  pair: ChapterPair
  outline: OutlinedChapter | undefined
  tail: TailSlice | undefined
  world: WorldSelection
}

function loadMaterials(root: string, options: WritingContextOptions): Materials {
  const declared = inspectProject(root).meta?.title
  const title = declared !== undefined && declared.trim() !== '' ? declared.trim() : basename(root)
  const stats = readProjectStats(root)
  const pair = readChapterPair(root, {
    ...(options.chapterPath === undefined ? {} : { chapterPath: options.chapterPath }),
    ...(options.chapterSeq === undefined ? {} : { chapterSeq: options.chapterSeq }),
  })
  const outline = pair.current === undefined ? undefined : readChapterOutline(root, pair.current)
  const tail = readTail(root, pair.previous)

  // Matching happens against the FULL outline and tail, even when the budget
  // later drops or shrinks them: the hits describe the chapter, not the slice.
  const world = matchWorldEntries(loadWorldEntries(root), `${outline?.body ?? ''}\n${tail?.body ?? ''}`)
  return { title, stats, pair, outline, tail, world }
}

function renderWritingContext(input: RenderInput): RenderedContext {
  const segments: WritingContextSegment[] = []
  const trimmed: string[] = []
  const notes: string[] = []

  // Trim order (the order this list is reported in) is a contract: summary →
  // current-chapter outline → world book → previous tail. The world book comes
  // before the tail because the tail has no side channel — a model that loses
  // it cannot re-read the previous chapter, while world entries can be fetched
  // again by the model (found in review after #20: the first ladder dropped the
  // tail first, which contradicts that asymmetry).
  if (input.state.dropSummary) trimmed.push(TRIM_SUMMARY)
  if (input.state.dropOutline && input.outline !== undefined) trimmed.push(TRIM_OUTLINE)
  if (input.state.dropWorld && input.world.shown.length > 0) trimmed.push(TRIM_WORLD)
  // Registered extras are reported between the world book and the tail: that is the
  // documented drop order (X-13), and the marker's list is read as the ladder order.
  if (input.state.dropExtras) {
    for (const extra of input.extras) trimmed.push(extra.label)
  }
  if (input.tail !== undefined) {
    if (input.state.dropTail) {
      trimmed.push(TRIM_TAIL)
      notes.push(`找回：读 ${input.tail.path} 的最后约 ${String(TAIL_RECOVERY_LINES)} 行`)
    } else if (input.state.tailLimit < input.tailChars) {
      // Clipping to the *configured* length is the segment's definition; only a
      // shorter limit is a budget decision worth reporting.
      trimmed.push(TRIM_TAIL)
    }
  }

  if (!input.state.dropSummary) {
    segments.push({ name: 'project', text: renderProject(input.title, input.stats) })
  }

  if (input.pair.current !== undefined) {
    segments.push({
      name: 'chapter',
      text: renderChapter(input.pair.current, input.state.dropOutline ? undefined : input.outline),
    })
  }

  if (input.tail !== undefined && !input.state.dropTail) {
    const body = clipTail(input.tail.body, input.state.tailLimit)
    segments.push({ name: 'tail', text: renderTail(input.tail, body.length, body) })
  }

  if (!input.state.dropWorld && input.world.shown.length > 0) {
    segments.push({ name: 'world', text: renderWorld(input.world) })
  }

  // Registry order is the documented segment order (X-13): after `world`, before the
  // trim marker. An extra is present exactly when it was built and not dropped.
  if (!input.state.dropExtras) {
    for (const extra of input.extras) segments.push({ name: extra.name, text: extra.text })
  }

  const marker = trimmed.length === 0 ? '' : renderTrimMarker(trimmed, notes)
  const text = [SECTION_HEADING, ...segments.map((segment) => segment.text), ...(marker === '' ? [] : [marker])].join(
    '\n\n',
  )
  return { segments, trimmed, text, tokens: estimateTokens(text) }
}

// ---------------------------------------------------------------------------
// The nine-segment brief (issue #43, ADR-0022 D1/D2)
// ---------------------------------------------------------------------------

/**
 * The nine segments, in the ONE order any caller may rely on (ADR-0022 D2).
 *
 * This is the constant table X-23 held back until its first consumer (#43). It is the
 * single source of the brief's order, its labels, its caps and — through
 * {@link BRIEF_TRIM_ORDER} — its ladder. A caller that renders a brief in another order
 * is not "slightly different": #46's review pipeline addresses segments by `id`, and the
 * audit file's field order is this order, so a reordering would silently rewrite what a
 * stored audit says.
 */
export const BRIEF_SEGMENT_ORDER = [
  'outline',
  'promise',
  'characters',
  'voice',
  'facts',
  'foreshadow',
  'world',
  'prevTail',
  'anchors',
] as const

export type BriefSegmentId = (typeof BRIEF_SEGMENT_ORDER)[number]

/**
 * The only droppable segments, first to go first (ADR-0022 D2).
 *
 * `outline` / `promise` / `characters` are **never** in this list: they are "what this
 * chapter is", and a brief that silently drops the task statement makes the model write
 * something unrelated to the author's plan. Over budget is the honest answer there, and
 * `overBudget` reports it.
 */
export const BRIEF_TRIM_ORDER = ['world', 'facts', 'foreshadow', 'prevTail'] as const

/**
 * Author-facing labels. They travel in the preview, in the `[trimmed: …]` marker and in
 * the audit record, so an id never appears where a person reads.
 *
 * `facts` and `foreshadow` must equal the registered specs' labels (`tests/brief.test.js`
 * compares them): the same segment named differently in the ladder and in the marker
 * would read as two segments.
 */
export const BRIEF_LABELS: Readonly<Record<BriefSegmentId, string>> = {
  outline: '当前章大纲',
  promise: '承诺书',
  characters: '本章人物',
  voice: '语言基因',
  facts: '账本事实',
  foreshadow: '伏笔提示',
  world: '世界书',
  prevTail: '上章结尾',
  anchors: '锚点',
}

/**
 * Per-segment budget share, as a fraction of `budgetTokens` (`floor(ratio × budget)`
 * characters, the same unit the ledger and the foreshadow reminder use).
 *
 * `0` means "this segment's cap is its own definition, not a share of the budget":
 * the outline keeps `MAX_OUTLINE_CHARS`, the world book keeps `MAX_WORLD_SHOWN` entries,
 * the tail keeps `tailChars`, and the two segments with no source yet (`promise`,
 * `anchors`) carry nothing at all. Those values are not 0 because the segment is
 * unimportant — they are 0 because a second cap on top of an existing one is a tuning
 * knob nobody asked for, and the audit reports the resulting sizes anyway.
 *
 * The shares do not add up to 1 and must not: a cap is a ceiling, not a reservation.
 * The ladder — not the sum — decides what is dropped.
 */
export const BRIEF_CAP_RATIOS: Readonly<Record<BriefSegmentId, number>> = {
  outline: 0,
  promise: 0,
  characters: 0.12,
  voice: 0.08,
  // Kept in step with the registered specs (the registry wins at runtime; the test
  // asserts the two agree, so a retuned cap cannot live in only one of them).
  facts: 0.15,
  foreshadow: 0.1,
  world: 0,
  prevTail: 0,
  anchors: 0,
}

/** One segment of a brief, as the preview shows it and the audit file stores it. */
export interface BriefSegmentRecord {
  readonly id: BriefSegmentId
  readonly label: string
  /** The rendered text. `''` when the segment has no source or was dropped. */
  readonly text: string
  /** UTF-8 bytes of `text`: "why did the model not see the foreshadows?" starts here. */
  readonly bytes: number
  /** {@link estimateTokens} of `text` — the budget's own unit. */
  readonly tokens: number
  /** Shortened by this segment's cap, shrunk, or dropped by the ladder (ADR-0022 D1). */
  readonly truncated: boolean
  /** This book has no source for the segment. Never filled with placeholder prose. */
  readonly missing: boolean
}

/** One rung that actually changed something: the segment, and what it cost before/after. */
export interface BriefTrimRecord {
  readonly segment: BriefSegmentId
  /** Tokens this segment occupied before the rung. */
  readonly before: number
  /** Tokens it occupies after the rung (`0` when dropped). */
  readonly after: number
  /** `(before - after) / before`, rounded to three decimals; `0` when `before` was 0. */
  readonly ratio: number
}

export interface WritingBrief {
  readonly state: ProjectState
  readonly root: string
  /**
   * The chapter the brief is about, as the audit file names it — the frontmatter `id`,
   * else `seq-<n>`, else `no-chapter`. Filesystem-safe, and a function of the book
   * alone: the same chapter yields the same file name forever (ADR-0022 D4).
   */
  readonly chapterId: string | null
  readonly chapterSeq: number | null
  /** Project-relative chapter path, for a preview header. Never an absolute path. */
  readonly chapterPath: string | null
  readonly budgetTokens: number
  /** All nine, in {@link BRIEF_SEGMENT_ORDER}, present or not. */
  readonly segments: readonly BriefSegmentRecord[]
  /** Trim rungs applied, in the order they were applied. */
  readonly trims: readonly BriefTrimRecord[]
  readonly text: string
  readonly tokens: number
  /** `tokens > budgetTokens` after the ladder ran out of rungs. The caller reports it. */
  readonly overBudget: boolean
  /** How many trim rungs were applied (0 = the brief fit). Diagnostics counts this. */
  readonly rungs: number
}

/** One rung of the brief's ladder: what it drops, and (for the tail) how short it gets. */
interface BriefRung {
  /** The segment this rung is about; `undefined` for the untrimmed rung. */
  readonly target?: BriefSegmentId
  readonly dropWorld: boolean
  readonly dropFacts: boolean
  readonly dropForeshadow: boolean
  readonly tailLimit: number
  readonly dropPrevTail: boolean
}

interface RenderedBrief {
  segments: BriefSegmentRecord[]
  text: string
  tokens: number
}

/**
 * Build the nine-segment brief (ADR-0022 D1/D2, roadmap X-23).
 *
 * One function, one input, one answer: the preview route, the audit file and any future
 * injection caller run THIS, so "the preview is what the model gets" is a property of the
 * code and not of discipline. Deterministic for a given tree — no cache, no clock, no
 * random id (ADR-0022 D4), which is why the audit file can be `git diff`ed.
 *
 * Segments with no source in this book are reported as `missing: true` with an empty
 * text. Deliberate: `promise` (the chapter's commitment) and `anchors` (the scene's fixed
 * points) are produced by the **session's model** under X-26 and have no file to read yet;
 * filling them with a placeholder would put invented instructions in front of the writer,
 * which is worse than an honest gap.
 */
export function buildWritingBrief(root: string, options: WritingContextOptions = {}): WritingBrief {
  const budgetTokens = clampInt(options.budgetTokens, DEFAULT_BUDGET_TOKENS, 1, 200_000)
  const tailChars = clampInt(options.tailChars, DEFAULT_TAIL_CHARS, 1, 20_000)
  const probe = inspectProject(root)
  const empty: WritingBrief = {
    state: probe.state,
    root: probe.root,
    chapterId: null,
    chapterSeq: null,
    chapterPath: null,
    budgetTokens,
    segments: [],
    trims: [],
    text: '',
    tokens: 0,
    overBudget: false,
    rungs: 0,
  }
  if (!probe.usable) return empty

  const materials = loadMaterials(probe.root, options)
  const { pair, outline, tail, world } = materials
  const current = pair.current
  const chapterId = briefChapterId(probe.root, current)
  const haystack = `${outline?.body ?? ''}\n${tail?.body ?? ''}`

  // Every segment's full text, built once: the ladder only decides which of these
  // survive, so a rung can never change what a segment says.
  const built = new Map<BriefSegmentId, { text: string; truncated: boolean; missing: boolean }>()
  if (current !== undefined) {
    built.set('outline', {
      text: renderChapter(current, outline),
      truncated: outline !== undefined && outline.body.length > MAX_OUTLINE_CHARS,
      missing: false,
    })
  } else {
    built.set('outline', { text: '', truncated: false, missing: true })
  }
  // No source yet (X-26: the session's model produces these; the plugin only assembles).
  built.set('promise', { text: '', truncated: false, missing: true })
  built.set('anchors', { text: '', truncated: false, missing: true })

  const cast = charactersInChapter({
    root: probe.root,
    seq: current?.seq,
    haystack,
    capChars: briefCapChars(budgetTokens, 'characters'),
  })
  built.set('characters', cast === undefined ? { text: '', truncated: false, missing: true } : { text: cast.text, truncated: cast.truncated, missing: false })

  const voices = voiceInChapter({
    root: probe.root,
    seq: current?.seq,
    haystack,
    capChars: briefCapChars(budgetTokens, 'voice'),
  })
  built.set('voice', voices === undefined ? { text: '', truncated: false, missing: true } : { text: voices.text, truncated: voices.truncated, missing: false })

  // The two registered extras keep their own builders and their own caps (X-13): the
  // brief does not get a second opinion about what a ledger line looks like.
  for (const id of ['facts', 'foreshadow'] as const) {
    const spec = EXTRA_SEGMENTS.find((entry) => entry.name === id)
    if (spec === undefined) {
      built.set(id, { text: '', truncated: false, missing: true })
      continue
    }
    const capChars = briefCapChars(budgetTokens, id)
    const text = spec.build({ root: probe.root, current, outlineBody: outline?.body ?? '', capChars })
    if (text === undefined || text.trim() === '') {
      built.set(id, { text: '', truncated: false, missing: true })
      continue
    }
    built.set(id, { text: clipHead(text, capChars), truncated: text.length > capChars, missing: false })
  }

  built.set('world', world.shown.length === 0
    ? { text: '', truncated: false, missing: true }
    : { text: renderWorld(world), truncated: false, missing: false })
  // The tail's text depends on the rung (it shrinks before it is dropped), so it is
  // rendered inside `renderBrief`; only its presence is decided here.
  built.set('prevTail', tail === undefined
    ? { text: '', truncated: false, missing: true }
    : { text: '', truncated: false, missing: false })

  const shrunk = Math.min(SHRUNK_TAIL_CHARS, tailChars)
  const rungs: BriefRung[] = [
    { dropWorld: false, dropFacts: false, dropForeshadow: false, tailLimit: tailChars, dropPrevTail: false },
    { target: 'world', dropWorld: true, dropFacts: false, dropForeshadow: false, tailLimit: tailChars, dropPrevTail: false },
    { target: 'facts', dropWorld: true, dropFacts: true, dropForeshadow: false, tailLimit: tailChars, dropPrevTail: false },
    { target: 'foreshadow', dropWorld: true, dropFacts: true, dropForeshadow: true, tailLimit: tailChars, dropPrevTail: false },
    ...(shrunk < tailChars
      ? [{ target: 'prevTail', dropWorld: true, dropFacts: true, dropForeshadow: true, tailLimit: shrunk, dropPrevTail: false } as const]
      : []),
    { target: 'prevTail', dropWorld: true, dropFacts: true, dropForeshadow: true, tailLimit: shrunk, dropPrevTail: true },
  ]

  let previous: RenderedBrief | undefined
  let chosen: RenderedBrief | undefined
  const trims: BriefTrimRecord[] = []
  for (const rung of rungs) {
    const rendered = renderBrief({ rung, built, tail, tailChars })
    // A rung that renders exactly like the previous one dropped nothing (no previous
    // chapter, no such segment): it must not show up as a trim, and it must not count.
    if (previous !== undefined && rendered.text === previous.text) continue
    if (rung.target !== undefined && previous !== undefined) {
      const before = tokenOf(previous.segments, rung.target)
      const after = tokenOf(rendered.segments, rung.target)
      if (before !== after) trims.push({ segment: rung.target, before, after, ratio: ratioOf(before, after) })
    }
    previous = rendered
    chosen = rendered
    if (rendered.tokens <= budgetTokens) break
  }

  if (chosen === undefined) return empty
  return {
    state: probe.state,
    root: probe.root,
    chapterId,
    chapterSeq: current?.seq ?? null,
    chapterPath: current?.path ?? null,
    budgetTokens,
    segments: chosen.segments,
    trims,
    text: chosen.text,
    tokens: chosen.tokens,
    overBudget: chosen.tokens > budgetTokens,
    rungs: trims.length,
  }
}

interface RenderBriefInput {
  readonly rung: BriefRung
  readonly built: ReadonlyMap<BriefSegmentId, { text: string; truncated: boolean; missing: boolean }>
  readonly tail: TailSlice | undefined
  readonly tailChars: number
}

function renderBrief(input: RenderBriefInput): RenderedBrief {
  const segments: BriefSegmentRecord[] = []
  const notes: string[] = []
  const dropped: string[] = []

  for (const id of BRIEF_SEGMENT_ORDER) {
    const source = input.built.get(id) ?? { text: '', truncated: false, missing: true }
    const label = BRIEF_LABELS[id]
    const isDropped =
      (id === 'world' && input.rung.dropWorld) ||
      (id === 'facts' && input.rung.dropFacts) ||
      (id === 'foreshadow' && input.rung.dropForeshadow) ||
      (id === 'prevTail' && input.rung.dropPrevTail)
    if (isDropped) {
      if (!source.missing) dropped.push(label)
      segments.push({ id, label, text: '', bytes: 0, tokens: 0, truncated: !source.missing, missing: source.missing })
      continue
    }
    if (id === 'prevTail') {
      if (input.tail === undefined) {
        segments.push({ id, label, text: '', bytes: 0, tokens: 0, truncated: false, missing: true })
        continue
      }
      const body = clipTail(input.tail.body, input.rung.tailLimit)
      const text = renderTail(input.tail, body.length, body)
      const shrunk = input.rung.tailLimit < input.tailChars
      if (shrunk) {
        // A shrunk tail is trimmed exactly like a dropped one: the marker names it and
        // the note says how to get the rest back (mirrors the injected context, #20).
        dropped.push(label)
        notes.push(`找回：读 ${input.tail.path} 的最后约 ${String(TAIL_RECOVERY_LINES)} 行`)
      }
      segments.push({
        id,
        label,
        text,
        bytes: byteLength(text),
        tokens: estimateTokens(text),
        truncated: shrunk,
        missing: false,
      })
      continue
    }
    segments.push({
      id,
      label,
      text: source.text,
      bytes: byteLength(source.text),
      tokens: estimateTokens(source.text),
      truncated: source.missing ? false : source.truncated,
      missing: source.missing,
    })
  }

  const marker = dropped.length === 0 ? '' : renderTrimMarker(dropped, notes)
  const rendered = segments.filter((segment) => segment.text !== '').map((segment) => segment.text)
  // Nothing to say (a brand-new book, or a book whose nine sources are all absent): no
  // heading either. The heading alone would be a section that costs tokens and injects
  // nothing — the same reason `buildWritingContext` returns `''` for a non-usable project.
  if (rendered.length === 0) return { segments, text: '', tokens: 0 }
  const text = [SECTION_HEADING, ...rendered, ...(marker === '' ? [] : [marker])].join('\n\n')
  return { segments, text, tokens: estimateTokens(text) }
}

/** `floor(ratio × budget)` with a floor of one header plus one line, per segment. */
function briefCapChars(budgetTokens: number, id: BriefSegmentId): number {
  const registered = EXTRA_SEGMENTS.find((entry) => entry.name === id)?.capRatio
  const ratio = registered ?? BRIEF_CAP_RATIOS[id]
  return Math.max(BRIEF_MIN_CAP_CHARS, Math.floor(ratio * budgetTokens))
}

function tokenOf(segments: readonly BriefSegmentRecord[], id: BriefSegmentId): number {
  return segments.find((segment) => segment.id === id)?.tokens ?? 0
}

function ratioOf(before: number, after: number): number {
  if (before <= 0) return 0
  return Math.round(((before - after) / before) * 1000) / 1000
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * The chapter key that names the audit file: the **declared** frontmatter `id` when the
 * chapter has one, else `seq-<n>`, else `no-chapter`. Sanitised to `[A-Za-z0-9._-]` so a
 * hand-written id cannot walk out of `.inkflow/audit/`.
 *
 * The declared id is read from the file rather than taken from `ChapterHead.id`: the index
 * derives an id from the path when the frontmatter has none
 * (`chapters-vol-01-0002-起风.md`), which would make a perfectly stable audit file name
 * look like a path and change if the file were renamed.
 */
function briefChapterId(root: string, current: ChapterHead | undefined): string | null {
  if (current === undefined) return null
  const declared = readDeclaredChapterId(root, current)
  const raw = declared ?? (current.seq === undefined ? undefined : `seq-${String(current.seq)}`)
  if (raw === undefined || raw.trim() === '') return null
  const safe = raw.trim().replace(/[^A-Za-z0-9._-]/gu, '-')
  return safe === '' ? null : safe.slice(0, 64)
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), min), max)
}
