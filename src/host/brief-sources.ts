/**
 * Who is on stage, for the brief's `characters` and `voice` segments (ADR-0022 D2).
 *
 * WHY THIS IS NOT A DOMAIN MODULE: the two segments are *views* over the setting
 * library (`characters/*.md` → the `characters` + `character_states` tables), not a new
 * kind of entity. The comparison logic — "which cards does this chapter actually
 * involve?" — needs the same two things `writing-sources.ts`'s world matching needs (an
 * index read and the chapter's own text), so it lives next to that shape rather than
 * inside `writing-context.ts` (which would then be the place where the assembly, the
 * caps, the ladders AND the queries all grow).
 *
 * WHY "mentioned in the outline or the previous tail" IS THE RULE: the chapter being
 * written has no prose yet, so the only evidence of who appears in it is the author's
 * own plan (the outline body) plus where the previous chapter left off. Matching against
 * the whole book would put every recurring name in front of the model — the opposite of
 * a brief. This is the same haystack the world-book segment matches against, and using
 * one haystack is what keeps "why is this in my context?" answerable.
 *
 * Matching is deliberately **literal and cheap** (case-insensitive substring over name
 * and aliases, at least {@link MIN_MATCH_CHARS} characters). The index already stores
 * occurrences per chapter (`entity_mentions`), but only for chapters that exist — the
 * point of this segment is the chapter that does not yet.
 *
 * Degradation: no index, no cast, no match, or a cap too small for one whole line →
 * `undefined`, which the brief reports as `missing`. It never invents a name.
 */

import type { CharacterSummary } from './domains/character-query.js'
import { listCharacters } from './domains/character-query.js'
import { parsePlotPoints } from './domains/outline-model.js'
import { clipHead } from './writing-context-render.js'

/** A segment body packed from whole lines, plus whether anything had to be left out. */
export interface BriefPackedText {
  readonly text: string
  /** At least one line was left out: the header says how many, so the two agree. */
  readonly truncated: boolean
}

export interface BriefCastSource {
  readonly root: string
  /** The chapter being written; `undefined` = the book has no chapters yet. */
  readonly seq: number | undefined
  /** The text the cast is matched against: the chapter outline + the previous tail. */
  readonly haystack: string
  /** This segment's character cap, already computed by the seam. */
  readonly capChars: number
}

/** How many cards one segment may list, whatever the budget (a readability bound). */
export const MAX_CAST_SHOWN = 8
export const MAX_VOICE_SHOWN = 6

/**
 * Cap for one **marker** segment (`promise` / `anchors`), in characters.
 *
 * One constant for both: they are the same shape of material — a few hand-written lines
 * the author typed into the chapter's own outline node — read by the same function and
 * rendered the same way, so a second number would be a tuning knob nobody asked for (the
 * same reasoning `BRIEF_CAP_RATIOS` gives for its `0` shares). The cap exists only so one
 * pasted paragraph cannot eat the whole brief; the trim ladder never drops these two.
 */
export const MAX_TAGGED_CHARS = 400

/**
 * The two marker tags a chapter-level outline node may carry.
 *
 * `promise` / `anchors` had no source at all (X-26), so the brief said so with
 * `missing: true`. Giving them one does **not** mean a new frontmatter field — that would
 * move ADR-0019's read-back contract and data-model §3. The author's own words ride in
 * the outline node's body as two tagged bullets, the mechanism `[故事线]` already uses and
 * the parser below already understands: one spelling of "a bullet with a tag", everywhere.
 */
const TAG_OF = { promise: '承诺', anchors: '锚点' } as const

export type TaggedSegmentId = keyof typeof TAG_OF

/** A marker segment's body: text plus whether the cap shortened it (never "dropped"). */
export interface BriefTaggedText {
  readonly text: string
  /** The cap cut the tail. Distinct from {@link BriefPackedText}'s "some lines left out". */
  readonly truncated: boolean
}

/**
 * The `promise` / `anchors` segment, built from the tagged bullets of **this** chapter's
 * own outline body.
 *
 * `undefined` means exactly one thing: the author wrote no such bullet here, so the brief
 * reports `missing: true`. There is no fallback — not to the previous chapter's node, not
 * to a character card, not to placeholder prose. A brief that invents a commitment is
 * worse than one that admits the gap, and this is the function where that is decided.
 *
 * The tag is a marker, not content: `- [承诺] 断剑必须露一角` renders as
 * `- 断剑必须露一角` under the segment's own heading, the way `[故事线]` names a story line
 * instead of being spoken. Over-long material is clipped from the head (the commitment is
 * stated first) and reported as `truncated`; these two segments are on the never-trimmed
 * side of ADR-0022 D2, so the cap shortens them but the ladder never drops them.
 */
export function taggedOutlineSegment(
  body: string,
  id: TaggedSegmentId,
  heading: string,
): BriefTaggedText | undefined {
  const points = parsePlotPoints(body).filter((point) => point.arc === TAG_OF[id])
  if (points.length === 0) return undefined
  const text = [`### ${heading}`, ...points.map((point) => `- ${point.text}`)].join('\n')
  return { text: clipHead(text, MAX_TAGGED_CHARS), truncated: text.length > MAX_TAGGED_CHARS }
}

/** One character of a name/alias is too short: "清" would match half a book. */
const MIN_MATCH_CHARS = 2

/** The index's own ceiling: a bigger cast than this is a query, not a brief. */
const CAST_QUERY_LIMIT = 500

/**
 * The cast of the chapter, in the order the chapter names them, up to `MAX_CAST_SHOWN`.
 *
 * `undefined` when the derived index is missing or foreign (`listCharacters` answers
 * `undefined`) — that is "cannot answer", not "this chapter has nobody in it".
 */
function matchedCast(source: BriefCastSource): CharacterSummary[] | undefined {
  const index = listCharacters(source.root, { chapter: source.seq, limit: CAST_QUERY_LIMIT })
  if (index === undefined) return undefined
  const needle = source.haystack.toLowerCase()
  if (needle.trim() === '') return []

  const hits: Array<{ readonly at: number; readonly entry: CharacterSummary }> = []
  for (const entry of index) {
    // A card introduced later in the book is not in this chapter, even when the author
    // mentioned the name in an early outline by mistake.
    if (entry.firstAppearance !== null && source.seq !== undefined && entry.firstAppearance > source.seq) continue
    const at = firstOffset(needle, entry)
    if (at === undefined) continue
    hits.push({ at, entry })
  }
  hits.sort((left, right) => left.at - right.at || compareText(left.entry.name, right.entry.name))
  return hits.map((hit) => hit.entry)
}

function firstOffset(needle: string, entry: CharacterSummary): number | undefined {
  let best: number | undefined
  for (const candidate of [entry.name, ...entry.aliases]) {
    const text = candidate.trim().toLowerCase()
    if (text.length < MIN_MATCH_CHARS) continue
    const at = needle.indexOf(text)
    if (at < 0) continue
    if (best === undefined || at < best) best = at
  }
  return best
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * The `characters` segment: one line per person the chapter names.
 *
 * The line carries what a writer needs to keep a walk-on consistent — the narrative role
 * and the status in force at this chapter (`character_states`, resolved by the index) —
 * plus the card's path, so the model can open it instead of guessing.
 */
export function charactersInChapter(source: BriefCastSource): BriefPackedText | undefined {
  const cast = matchedCast(source)
  if (cast === undefined || cast.length === 0) return undefined
  const shown = cast.slice(0, MAX_CAST_SHOWN)
  const lines = shown.map((entry) => {
    const facts: string[] = []
    if (entry.role !== null && entry.role.trim() !== '') facts.push(entry.role.trim())
    if (entry.state !== null && entry.state.status.trim() !== '') facts.push(entry.state.status.trim())
    facts.push(entry.path)
    return `- ${entry.name}（${facts.join(' · ')}）`
  })
  const total = cast.length
  return packLines(
    (count) => (count < total ? `### 本章人物（命中 ${String(total)} 人，展开前 ${String(count)} 人）` : `### 本章人物（${String(total)} 人）`),
    lines,
    source.capChars,
  )
}

/**
 * The `voice` segment: the 语言基因 block of each matched card that has one.
 *
 * Data-model §3.3 calls the field `voice` and means exactly this — one-line descriptors
 * of how a character speaks — so the segment is a projection of a field that already
 * exists. A card without `voice` contributes nothing (not an empty bullet), and a chapter
 * whose cast has no voice blocks yields `undefined` rather than an empty heading.
 */
export function voiceInChapter(source: BriefCastSource): BriefPackedText | undefined {
  const cast = matchedCast(source)
  if (cast === undefined) return undefined
  const withVoice = cast.filter((entry) => entry.voice.length > 0)
  if (withVoice.length === 0) return undefined
  const lines = withVoice
    .slice(0, MAX_VOICE_SHOWN)
    .map((entry) => `- ${entry.name}：${entry.voice.join('；')}`)
  const total = withVoice.length
  return packLines(
    (count) => (count < total ? `### 语言基因（${String(total)} 人，展开前 ${String(count)} 人）` : `### 语言基因（${String(total)} 人）`),
    lines,
    source.capChars,
  )
}

/**
 * Assemble a body from **whole lines** until `capChars`, or give up.
 *
 * Same discipline as the ledger segment (`facts-prompt.ts`), because the same two things
 * went wrong there: a count cap announced over a character-clipped body reads as a lie,
 * and a half line of prose reads as a value.
 *
 * The two failures are reported differently on purpose:
 *   * `undefined` (from the caller) means "this book has no source" — the brief records
 *     `missing: true` and never fills it with placeholder prose;
 *   * `{ text: '', truncated: true }` means "there is a source, but the cap cannot fit
 *     even the header and one line" — the brief records `missing: false, truncated: true`,
 *     which the page renders as 已裁掉. Collapsing these two into one would let a tight
 *     budget look like an empty setting library.
 */
function packLines(
  header: (shown: number) => string,
  lines: readonly string[],
  capChars: number,
): BriefPackedText {
  let best: BriefPackedText | undefined
  for (let shown = 1; shown <= lines.length; shown += 1) {
    const text = [header(shown), ...lines.slice(0, shown)].join('\n')
    if (text.length > capChars) break
    best = { text, truncated: shown < lines.length }
  }
  return best ?? { text: '', truncated: true }
}
