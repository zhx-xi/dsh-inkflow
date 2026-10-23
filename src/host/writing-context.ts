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
 */

import { basename } from 'node:path'

import type { ProjectState } from './project.js'
import { inspectProject } from './project.js'
import type { ChapterHead, ChapterPair, OutlinedChapter, ProjectStats, TailSlice, WorldSelection } from './writing-sources.js'
import {
  loadWorldEntries,
  matchWorldEntries,
  readChapterOutline,
  readChapterPair,
  readProjectStats,
  readTail,
} from './writing-sources.js'

export const DEFAULT_BUDGET_TOKENS = 1200
export const DEFAULT_TAIL_CHARS = 300

/** L3 shrinks the previous-chapter tail to this many characters. */
const SHRUNK_TAIL_CHARS = 120

/**
 * Per-segment caps, applied before the budget is measured.
 *
 * Why a cap on top of the budget: the trim ladder is coarse (a segment is
 * either there or gone), so one 3000-character outline would push the whole
 * context straight to "outline dropped". Clipping keeps the head of the real
 * thing, which is what the model needs to write the chapter.
 */
const MAX_OUTLINE_CHARS = 800
/** A recovery hint must name a line count small enough to beat a full read. */
const TAIL_RECOVERY_LINES = 40

const CLIP_TAIL_MARK = '…（截断）'
const CLIP_HEAD_MARK = '…（前文截断）'

/** CJK letters/punctuation: one token per character is the safe direction. */
const CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/u

const SECTION_HEADING = '## 写作上下文（InkFlow · 当前作品的快照，不是新的作者指令）'

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
}

/**
 * Segments registered by domains. Empty in B0 on purpose: the seam lands first so
 * `#31`/`#32` each add ONE entry from their own module instead of editing the
 * renderer. With this array empty the produced text is byte-identical to before.
 */
export const EXTRA_SEGMENTS: readonly ExtraSegmentSpec[] = []

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

  const declared = probe.meta?.title
  const title = declared !== undefined && declared.trim() !== '' ? declared.trim() : basename(probe.root)
  const stats = readProjectStats(probe.root)
  const pair = readChapterPair(probe.root, options.chapterSeq)
  const outline = pair.current === undefined ? undefined : readChapterOutline(probe.root, pair.current)
  const tail = readTail(probe.root, pair.previous)

  // Matching happens against the FULL outline and tail, even when the budget
  // later drops or shrinks them: the hits describe the chapter, not the slice.
  const world = matchWorldEntries(loadWorldEntries(probe.root), `${outline?.body ?? ''}\n${tail?.body ?? ''}`)

  // Registered segments are built once, before the ladder: their content depends on
  // the chapter, never on a rung. An empty registry (B0's state) produces no extra,
  // so the rendered text stays byte-identical to the pre-seam version.
  const extras: RenderedExtra[] = EXTRA_SEGMENTS.map((spec) => {
    const built = spec.build({ root: probe.root, current: pair.current, outlineBody: outline?.body ?? '' })
    if (built === undefined || built.trim() === '') return undefined
    const capChars = Math.max(1, Math.floor(spec.capRatio * budgetTokens))
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

function renderProject(title: string, stats: ProjectStats | undefined): string {
  const head = '### 项目'
  if (stats === undefined) {
    return `${head}\n《${title}》（索引未建立：调用 inkflow_index_rebuild 后补上卷/章/字数）`
  }
  const parts = [`《${title}》`]
  if (stats.volumes > 0) parts.push(`${String(stats.volumes)} 卷`)
  parts.push(`${String(stats.chapters)} 章`, `${String(stats.words)} 字`)
  return `${head}\n${parts.join(' · ')}`
}

function renderChapter(current: ChapterHead, outline: OutlinedChapter | undefined): string {
  const facts: string[] = []
  if (current.title !== undefined && current.title !== '') facts.push(`标题：${current.title}`)
  if (current.volume !== undefined && current.volume !== '') facts.push(`卷：${current.volume}`)
  if (current.seq !== undefined) facts.push(`seq：${String(current.seq)}`)
  if (current.status !== undefined && current.status !== '') facts.push(`状态：${current.status}`)
  const lines = ['### 当前章', facts.length === 0 ? `文件：${current.path}` : facts.join('｜')]
  if (outline !== undefined && outline.body !== '') {
    lines.push(`大纲 ${outline.path}：`, clipHead(outline.body, MAX_OUTLINE_CHARS))
  }
  return lines.join('\n')
}

function renderTail(tail: TailSlice, taken: number, body: string): string {
  const which = tail.seq === undefined ? '上一章' : `第 ${String(tail.seq)} 章`
  return `### 上一章结尾（${which} · 最后 ${String(taken)} 字）\n${body}`
}

function renderWorld(world: WorldSelection): string {
  const header =
    world.matched > world.shown.length
      ? `### 世界书（命中 ${String(world.matched)} 条，展开前 ${String(world.shown.length)} 条）`
      : `### 世界书（命中 ${String(world.matched)} 条）`
  const lines = world.shown.map((entry) => `- ${entry.title}（${entry.path}）：${entry.excerpt}`)
  return [header, ...lines].join('\n')
}

function renderTrimMarker(trimmed: readonly string[], notes: readonly string[]): string {
  const detail = notes.length === 0 ? '' : `（${notes.join('；')}）`
  return `[trimmed: ${trimmed.join('、')}]${detail}`
}

/** Keep the head; the marker is part of the cap so the budget still balances. */
function clipHead(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - CLIP_TAIL_MARK.length))}${CLIP_TAIL_MARK}`
}

/**
 * Keep the tail; the marker is part of the cap.
 *
 * Direction matters: the value of "how the last chapter ended" is entirely in
 * its last sentences, so a head-clip would hand the model the background and
 * throw the hook away.
 */
function clipTail(text: string, max: number): string {
  if (text.length <= max) return text
  return `${CLIP_HEAD_MARK}${text.slice(-Math.max(1, max - CLIP_HEAD_MARK.length))}`
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), min), max)
}
