/**
 * The six-segment writing context: the block injected as the `inkflow:writing-context`
 * system-prompt section, with its own trim ladder (summary first).
 *
 * WHY IT IS A FILE: it is one of the two assemblies this module owns, and the higher-volume
 * of the two ladders — six rungs, a tail that shrinks before it is dropped, and the
 * documented asymmetry that the world book goes before the tail (the tail has no way back).
 * The nine-segment brief is the other assembly, in `writing-context-brief.ts`; they
 * deliberately do not share a ladder, only the renderers (`writing-context-render.ts`).
 *
 * `loadMaterials` also lives here because both assemblies read the book exactly once per
 * call, and one loader is how "the hits describe the chapter, not the slice" stays true on
 * both paths — see the comment on the function.
 */

import { basename } from 'node:path'

import type { WritingContextOptions, WritingContextResult, WritingContextSegment, WritingContextSegmentName } from './writing-context-types.js'
import { DEFAULT_BUDGET_TOKENS, DEFAULT_TAIL_CHARS, EXTRA_SEGMENTS, SHRUNK_TAIL_CHARS, TAIL_RECOVERY_LINES, clampInt, estimateTokens } from './writing-context-types.js'
import { SECTION_HEADING, clipHead, clipTail, renderChapter, renderProject, renderTail, renderTrimMarker, renderWorld } from './writing-context-render.js'
import { inspectProject } from './project.js'
import type { ChapterPair, OutlinedChapter, ProjectStats, TailSlice, WorldSelection } from './writing-sources.js'
import { loadWorldEntries, matchWorldEntries, readChapterOutline, readChapterPair, readProjectStats, readTail } from './writing-sources.js'

/** Ladder labels, in the documented drop order. */
/** Ladder labels, in the documented drop order. */
const TRIM_SUMMARY = '项目摘要'
const TRIM_OUTLINE = '当前章大纲'
const TRIM_TAIL = '上章结尾'
const TRIM_WORLD = '世界书'

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

export function loadMaterials(root: string, options: WritingContextOptions): Materials {
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
  // again by the model (found in review: the first ladder dropped the
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
