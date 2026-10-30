/**
 * The nine-segment brief (ADR-0022 D1/D2, roadmap X-23): the order, the labels, the caps, the
 * records it reports, and the ladder that decides what the model still sees.
 *
 * WHY IT IS A FILE: its ladder genuinely disagrees with the six-segment one — `outline`,
 * `promise` and `characters` are **never** trimmed here, while the injected block trims its
 * summary first — so the two cannot share a rung table without a per-caller exception list,
 * which is the "two spellings of one rule" bug this project keeps re-learning. Everything
 * from "what is the order" to "what does a trimmed segment cost" is one contract and lives
 * together; only the segment text itself is shared (`writing-context-render.ts`).
 *
 * It reads the book through `loadMaterials` in `writing-context-build.ts` — one read, so the
 * preview, the audit file and the injection can never describe different chapters.
 */

import { Buffer } from 'node:buffer'

import { loadMaterials } from './writing-context-build.js'
import type { WritingContextOptions } from './writing-context-types.js'
import { DEFAULT_BUDGET_TOKENS, DEFAULT_TAIL_CHARS, EXTRA_SEGMENTS, SHRUNK_TAIL_CHARS, TAIL_RECOVERY_LINES, clampInt, estimateTokens } from './writing-context-types.js'
import { MAX_OUTLINE_CHARS, SECTION_HEADING, clipHead, clipTail, renderBriefHeader, renderOutlineSegment, renderTail, renderTrimMarker, renderWorld } from './writing-context-render.js'
import { charactersInChapter, taggedOutlineSegment, voiceInChapter } from './brief-sources.js'
import { inspectProject } from './project.js'
import type { ProjectState } from './project.js'
import type { ChapterHead, TailSlice } from './writing-sources.js'
import { readDeclaredChapterId } from './writing-sources.js'

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

/**
 * The nine segments, in the ONE order any caller may rely on (ADR-0022 D2).
 *
 * This is the constant table X-23 held back until its first consumer. It is the
 * single source of the brief's order, its labels, its caps and — through
 * {@link BRIEF_TRIM_ORDER} — its ladder. A caller that renders a brief in another order
 * is not "slightly different": the review pipeline addresses segments by `id`, and the
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
 * the audit record, so an id never appears where a person reads. `facts`/`foreshadow` must
 * equal the registered specs' labels (`tests/brief.test.js` compares them): one segment
 * named two ways in the ladder and in the marker would read as two segments.
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
 * characters — the unit the ledger and the foreshadow reminder already use).
 *
 * `0` means "this segment's cap is its own definition, not a share of the budget": `outline`
 * keeps `MAX_OUTLINE_CHARS`, `world` keeps `MAX_WORLD_SHOWN`, `prevTail` keeps `tailChars`,
 * the markers (`promise`/`anchors`) keep `MAX_TAGGED_CHARS`. The shares do not add up to 1
 * and must not: a cap is a ceiling, not a reservation — the ladder decides what is dropped.
 */
export const BRIEF_CAP_RATIOS: Readonly<Record<BriefSegmentId, number>> = {
  outline: 0,
  promise: 0,
  characters: 0.12,
  voice: 0.08,
  // The registry wins at runtime; `tests/brief.test.js` asserts the two agree.
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
  /**
   * The book identity line: the FIRST line of {@link text}, recorded verbatim by the audit
   * file so the three consumers share one string. Never trimmed; shortened at the floor.
   */
  readonly header: string
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
  header: string
  text: string
  tokens: number
}

/**
 * Build the nine-segment brief (ADR-0022 D1/D2, roadmap X-23).
 *
 * One function, one input, one answer: preview route, audit file and injection run THIS,
 * so "the preview is what the model gets" is a property of the code, not of discipline.
 * Deterministic for a given tree — no cache, no clock, no random id (ADR-0022 D4), which
 * is why the audit file can be `git diff`ed.
 *
 * No-source segments are `missing: true` with empty text — never placeholder prose, which
 * would put invented instructions in front of the writer. `promise`/`anchors` are the
 * author's own marker bullets in THIS chapter's outline node; none written = missing.
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
    header: '',
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
  // Decided once from the budget alone: no rung may be the reason a book loses its name, or
  // the reason a chapter loses its number.
  const fullHeader = renderBriefHeader(materials.title, materials.stats, false, current)
  const header =
    estimateTokens(fullHeader) <= budgetTokens ? fullHeader : renderBriefHeader(materials.title, materials.stats, true, current)

  // Every segment's full text, built once: the ladder only decides which of these
  // survive, so a rung can never change what a segment says.
  const built = new Map<BriefSegmentId, { text: string; truncated: boolean; missing: boolean }>()
  // The identity that rode in this block is on the header line now, so the segment depends on
  // the node alone; an empty body is the same answer as no node (a heading over a blank line
  // reads as "the plan is fine").
  built.set('outline', outline === undefined || outline.body === ''
    ? { text: '', truncated: false, missing: true }
    : { text: renderOutlineSegment(outline), truncated: outline.body.length > MAX_OUTLINE_CHARS, missing: false })
  // The two marker bullets in THIS chapter's outline node are their only source.
  for (const id of ['promise', 'anchors'] as const) {
    const tagged = taggedOutlineSegment(outline?.body ?? '', id, BRIEF_LABELS[id])
    built.set(id, tagged === undefined ? { text: '', truncated: false, missing: true } : { ...tagged, missing: false })
  }

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

  // The registered extras keep their own builders and caps (X-13): no second opinion here.
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
    const rendered = renderBrief({ rung, built, tail, tailChars, header })
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
    header: chosen.header,
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
  readonly header: string
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
        // the note says how to get the rest back (mirrors the injected context).
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
  if (rendered.length === 0) return { segments, header: '', text: '', tokens: 0 }
  // Outside `rendered`, so no rung can drop it: "which book" is read before "what to write".
  const text = [input.header, SECTION_HEADING, ...rendered, ...(marker === '' ? [] : [marker])].join('\n\n')
  return { segments, header: input.header, text, tokens: estimateTokens(text) }
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
 * The declared id is read from the file, not taken from `ChapterHead.id`: the index derives
 * an id from the path when the frontmatter has none, which would make a stable audit file
 * name look like a path and change if the file were renamed.
 */
function briefChapterId(root: string, current: ChapterHead | undefined): string | null {
  if (current === undefined) return null
  const declared = readDeclaredChapterId(root, current)
  const raw = declared ?? (current.seq === undefined ? undefined : `seq-${String(current.seq)}`)
  if (raw === undefined || raw.trim() === '') return null
  const safe = raw.trim().replace(/[^A-Za-z0-9._-]/gu, '-')
  return safe === '' ? null : safe.slice(0, 64)
}
