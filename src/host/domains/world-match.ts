/**
 * World-book keyword matching.
 *
 * The world book (`world/<category>/`) is a *lookup* device: a chapter naming
 * 白鹤门 must be able to pull that entry into the briefing context, and an entry
 * marked `always: true` must come along whatever the chapter says. This module is
 * the whole rule set, as one pure function — the injection chain that consumes it
 * belongs to the brief, so nothing here reads the index, the files or the clock.
 *
 * Reproducibility is the contract: the same entries and the same chapter text give
 * the same hits in the same order, on every machine. That is why the order is
 * priority desc → title → id (codepoint), never insertion order or a locale
 * collation, and why `keyword` reports the *first* matching word of the entry.
 */

/** The fields matching reads from an entry. Anything else (body, `category`) is irrelevant here. */
export interface WorldBookEntry {
  readonly id: string
  readonly title: string
  readonly keywords?: readonly string[]
  /** Unconditional: the entry is always part of the chapter's setting. */
  readonly always?: boolean
  /** Higher wins; absent counts as 0. */
  readonly priority?: number
}

export type WorldBookMatchReason = 'keyword' | 'always'

export interface WorldBookHit {
  readonly id: string
  readonly title: string
  readonly matched: WorldBookMatchReason
  /** Set only for `matched: 'keyword'`: the word that hit, in the entry's own order. */
  readonly keyword?: string
}

function compareText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function priorityOf(entry: WorldBookEntry): number {
  return typeof entry.priority === 'number' && Number.isFinite(entry.priority) ? entry.priority : 0
}

/**
 * Which world-book entries a chapter's text pulls in.
 *
 * Matching is a literal substring test on the lower-cased text: Chinese keywords
 * have no word boundaries to split on, and a trigram index cannot answer a 1–2
 * character keyword (conventions §4.1), so a scan is both correct and cheap at
 * world-book scale (hundreds of entries, tens of thousands of characters).
 */
export function matchWorldBook(entries: readonly WorldBookEntry[], chapterText: string): WorldBookHit[] {
  const haystack = chapterText.toLowerCase()
  const hits: Array<{ hit: WorldBookHit; priority: number }> = []

  for (const entry of entries) {
    if (entry.always === true) {
      hits.push({ hit: { id: entry.id, title: entry.title, matched: 'always' }, priority: priorityOf(entry) })
      continue
    }
    const keyword = (entry.keywords ?? [])
      .map((value) => value.trim())
      .filter((value) => value !== '')
      .find((value) => haystack.includes(value.toLowerCase()))
    if (keyword === undefined) continue
    hits.push({
      hit: { id: entry.id, title: entry.title, matched: 'keyword', keyword },
      priority: priorityOf(entry),
    })
  }

  hits.sort(
    (left, right) =>
      right.priority - left.priority ||
      compareText(left.hit.title, right.hit.title) ||
      compareText(left.hit.id, right.hit.id),
  )
  return hits.map((entry) => entry.hit)
}
