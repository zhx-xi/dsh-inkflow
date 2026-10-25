/**
 * Line-level diff for the proposal workflow (roadmap X-26).
 *
 * A proposal is "what the session model would write instead of this chapter body",
 * cut into hunks the author accepts or rejects one by one. Two decisions live here
 * and nowhere else:
 *
 *   * **Line granularity, never characters.** Chinese prose has no spaces, so a
 *     character-level diff cuts words in half (`说` / `道` inside one word) and every
 *     hunk then reads as gibberish. A line is the smallest unit the author can judge
 *     by reading it.
 *   * **Patience anchors, not a full LCS table.** A 3,000-line chapter puts a DP table
 *     at 9 million cells; patience diff is O(n log n), produces the hunks humans
 *     actually expect (a moved paragraph is one delete + one insert, not 3,000
 *     changes), and degrades honestly: when a region shares no unique line at all it
 *     becomes ONE replace hunk instead of pretending to find structure.
 *
 * The output is expressed against the base (`baseStart` is a 0-based line index), so
 * a caller can rebuild either "base with the accepted hunks applied" or "what the
 * rejected ones would have changed" without re-diffing. Hunks are ordered, disjoint,
 * and never empty on both sides.
 *
 * Pure: no IO, no clock, no randomness. `proposal.ts` owns the store.
 */

/** What one hunk does to the base lines. */
export type HunkKind = 'replace' | 'insert' | 'delete'

/**
 * One contiguous change.
 *
 * `insert` has no base lines, `delete` has no replacement lines, `replace` has both;
 * `baseStart` always points at the first base line the hunk touches (the line *after*
 * the previous hunk's end for an insert, so appending to the end stays expressible).
 */
export interface LineHunk {
  kind: HunkKind
  baseStart: number
  baseLines: string[]
  nextLines: string[]
}

/**
 * Split prose into lines without losing a byte of meaning.
 *
 * `joinLines(splitLines(text)) === text` for every text, including one that ends with
 * a newline (the trailing `''` element is the empty last line, not an artefact).
 */
export function splitLines(text: string): string[] {
  return text.split('\n')
}

/** Inverse of `splitLines`. */
export function joinLines(lines: readonly string[]): string {
  return lines.join('\n')
}

interface Anchor {
  baseIndex: number
  nextIndex: number
}

/** `line → {count, index}` for one region: the raw material of a patience anchor. */
function occurrenceIndex(lines: readonly string[], lo: number, hi: number): Map<string, { count: number; index: number }> {
  const seen = new Map<string, { count: number; index: number }>()
  for (let index = lo; index < hi; index += 1) {
    const line = lines[index] ?? ''
    const existing = seen.get(line)
    if (existing === undefined) seen.set(line, { count: 1, index })
    else existing.count += 1
  }
  return seen
}

/**
 * Lines that appear exactly once on each side, in the longest order that is
 * increasing on both (a longest increasing subsequence on the next-side indexes).
 */
function anchorsOf(
  base: readonly string[],
  baseLo: number,
  baseHi: number,
  next: readonly string[],
  nextLo: number,
  nextHi: number,
): Anchor[] {
  const baseSeen = occurrenceIndex(base, baseLo, baseHi)
  const nextSeen = occurrenceIndex(next, nextLo, nextHi)
  const pairs: Anchor[] = []
  for (const [line, info] of baseSeen) {
    if (info.count !== 1) continue
    const other = nextSeen.get(line)
    if (other === undefined || other.count !== 1) continue
    pairs.push({ baseIndex: info.index, nextIndex: other.index })
  }
  if (pairs.length === 0) return []
  pairs.sort((left, right) => left.baseIndex - right.baseIndex)

  // Longest increasing subsequence on nextIndex: `tails[k]` is the position in
  // `pairs` of the smallest possible tail of an increasing run of length k+1.
  const tails: number[] = []
  const previous: number[] = new Array<number>(pairs.length).fill(-1)
  for (let index = 0; index < pairs.length; index += 1) {
    const value = (pairs[index] as Anchor).nextIndex
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (((pairs[tails[middle] as number] as Anchor).nextIndex) < value) low = middle + 1
      else high = middle
    }
    if (low > 0) previous[index] = tails[low - 1] as number
    tails[low] = index
  }
  const chain: Anchor[] = []
  let cursor = tails.length === 0 ? -1 : (tails[tails.length - 1] as number)
  while (cursor !== -1) {
    chain.push(pairs[cursor] as Anchor)
    cursor = previous[cursor] as number
  }
  return chain.reverse()
}

/**
 * Walk one region between two anchors, pushing hunks in document order.
 *
 * Written as an explicit stack rather than recursion: a chapter and its rewrite can
 * share thousands of unique lines, and one stack frame per anchor on a pathological
 * input is a crash rather than an error message.
 */
function diffRegion(
  base: readonly string[],
  baseLo: number,
  baseHi: number,
  next: readonly string[],
  nextLo: number,
  nextHi: number,
  out: LineHunk[],
): void {
  const pending: Array<{ baseLo: number; baseHi: number; nextLo: number; nextHi: number }> = [
    { baseLo, baseHi, nextLo, nextHi },
  ]
  while (pending.length > 0) {
    const region = pending.pop() as { baseLo: number; baseHi: number; nextLo: number; nextHi: number }
    let lo = region.baseLo
    let nlo = region.nextLo
    let hi = region.baseHi
    let nhi = region.nextHi

    while (lo < hi && nlo < nhi && base[lo] === next[nlo]) {
      lo += 1
      nlo += 1
    }
    while (hi > lo && nhi > nlo && base[hi - 1] === next[nhi - 1]) {
      hi -= 1
      nhi -= 1
    }
    if (lo === hi && nlo === nhi) continue
    if (lo === hi) {
      out.push({ kind: 'insert', baseStart: lo, baseLines: [], nextLines: next.slice(nlo, nhi) })
      continue
    }
    if (nlo === nhi) {
      out.push({ kind: 'delete', baseStart: lo, baseLines: base.slice(lo, hi), nextLines: [] })
      continue
    }

    const anchors = anchorsOf(base, lo, hi, next, nlo, nhi)
    if (anchors.length === 0) {
      out.push({ kind: 'replace', baseStart: lo, baseLines: base.slice(lo, hi), nextLines: next.slice(nlo, nhi) })
      continue
    }
    // Sub-regions are pushed in reverse so the stack pops them in document order.
    let baseCursor = lo
    let nextCursor = nlo
    const segments: Array<{ baseLo: number; baseHi: number; nextLo: number; nextHi: number }> = []
    for (const anchor of anchors) {
      segments.push({ baseLo: baseCursor, baseHi: anchor.baseIndex, nextLo: nextCursor, nextHi: anchor.nextIndex })
      baseCursor = anchor.baseIndex + 1
      nextCursor = anchor.nextIndex + 1
    }
    segments.push({ baseLo: baseCursor, baseHi: hi, nextLo: nextCursor, nextHi: nhi })
    for (let index = segments.length - 1; index >= 0; index -= 1) pending.push(segments[index] as (typeof segments)[number])
  }
}

/**
 * The hunks that turn `base` into `next`, in document order.
 *
 * An identical pair of line lists yields `[]` — the caller turns that into
 * `PROPOSAL_EMPTY` rather than storing a proposal with nothing in it.
 */
export function diffLines(base: readonly string[], next: readonly string[]): LineHunk[] {
  const out: LineHunk[] = []
  diffRegion(base, 0, base.length, next, 0, next.length, out)
  return out
}

/**
 * Rebuild the next lines from the base plus a decision per hunk.
 *
 * `accepted(hunk)` decides: true takes `nextLines`, false keeps `baseLines`. Pending
 * hunks are the caller's problem — a proposal that still has undecided hunks must not
 * be applied at all (`proposal.ts` refuses it), because silently treating "undecided"
 * as "keep" would lose the author's change without saying so.
 */
export function applyHunks<Hunk extends LineHunk>(
  base: readonly string[],
  hunks: readonly Hunk[],
  accepted: (hunk: Hunk) => boolean,
): string[] {
  const out: string[] = []
  let cursor = 0
  for (const hunk of hunks) {
    if (hunk.baseStart < cursor) throw new Error(`hunk at line ${String(hunk.baseStart)} overlaps the previous one`)
    out.push(...base.slice(cursor, hunk.baseStart))
    out.push(...(accepted(hunk) ? hunk.nextLines : hunk.baseLines))
    cursor = hunk.baseStart + hunk.baseLines.length
  }
  out.push(...base.slice(cursor))
  return out
}
