/**
 * The one hit-snippet implementation.
 *
 * Why a module of its own: two readers need it — `search.ts` (chapter prose, both the
 * chapter-only search and the unified entry) and `domains/query.ts` (the entity
 * projection) — and `search.ts` imports `indexer.ts`, which imports the domain
 * registry, which imports `domains/query.ts`. Sharing the helper through
 * `search.ts` would close that loop; a leaf module with no imports cannot.
 *
 * Two rules the whole product inherits from here:
 *   - **A snippet is what the author wrote**, with whitespace collapsed for display.
 *     No frontmatter ever reaches it, because the caller passes body prose only.
 *   - **`radius` is characters, not tokens.** FTS5's `snippet()` would mean 40 trigram
 *     grams (≈42 characters) under `tokenize='trigram'`, and the FTS and LIKE branches
 *     would disagree. Slicing here makes every answer identical whichever branch
 *     produced it.
 */

/** Escape a literal for `new RegExp`, so a query searches for `.` instead of "any". */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** Earliest occurrence of any term (case-insensitive, index-preserving). */
export function locateHit(text: string, terms: readonly string[]): { at: number; length: number } | undefined {
  let best: { at: number; length: number } | undefined
  for (const term of terms) {
    if (term === '') continue
    const match = new RegExp(escapeRegExp(term), 'iu').exec(text)
    if (match === null) continue
    if (best === undefined || match.index < best.at) best = { at: match.index, length: match[0].length }
  }
  return best
}

/**
 * `radius` characters either side of the hit, with `…` marking a truncated edge.
 *
 * When no term is present (an entity whose FTS row matched a column the caller did
 * not join, say) the snippet is the head of the text rather than an empty string:
 * a hit with no visible context is not an answer.
 */
export function makeSnippet(text: string, terms: readonly string[], radius: number): string {
  if (text === '' || radius <= 0) return ''
  const hit = locateHit(text, terms)
  return hit === undefined
    ? sliceContext(text, 0, Math.min(text.length, radius * 2), radius)
    : sliceContext(text, hit.at, hit.length, radius)
}

/**
 * Context around a **known** position, for a caller that already found the hit.
 *
 * The replace preview needs this: after the replacement the query is gone, so
 * locating it again would silently fall back to the head of the chapter and show
 * the author context that has nothing to do with their edit.
 */
export function sliceContext(text: string, at: number, length: number, radius: number): string {
  if (text === '') return ''
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + length + radius)
  const head = start > 0 ? '…' : ''
  const tail = end < text.length ? '…' : ''
  return `${head}${text.slice(start, end).replace(/\s+/gu, ' ').trim()}${tail}`
}
