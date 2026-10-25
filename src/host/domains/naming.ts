/**
 * Name normalisation — one implementation, shared by every domain (roadmap X-1).
 *
 * A second `nameKey` would let the write path and the rebuild disagree about
 * whether two names collide, which is exactly the class of bug this module exists to forbid.
 */

/** Normalise a name for uniqueness checks: NFKC, case-fold, strip whitespace. */
export function nameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')
}

/** A folded string plus the map back to where each folded element came from. */
export interface FoldedText {
  /**
   * One entry per **source code point**, NFKC-normalised and case-folded.
   * An element is a string, not a character: `İ` folds to two code units — what
   * matters is that the same element is produced for a pattern and for the text,
   * so the two compare equal element by element.
   */
  readonly chars: string[]
  /** `offsets[i]` = code-unit index in the source string of `chars[i]`. */
  readonly offsets: number[]
  /** The folded text joined — for a substring test, not for offsets. */
  readonly text: string
}

/**
 * The offset-preserving companion of {@link nameKey}.
 *
 * Same two rules — NFKC, then case folding — but applied **one code point at a
 * time**, so each folded element keeps the index of the character it came from.
 * That is the whole difference: `nameKey` may collapse a string's byte layout
 * (and strips whitespace) because it only ever answers "are these two names the
 * same"; a mention scan has to answer "where in the manuscript", and a marker
 * that no longer addresses the original text is worse than no match at all.
 *
 * Whitespace is therefore **kept**: a name with spaces only matches text that has
 * the same spaces. NFKC already folds the ideographic space U+3000 to a normal
 * one, so full-width and half-width layout still line up.
 */
export function foldChars(value: string): FoldedText {
  const chars: string[] = []
  const offsets: number[] = []
  let index = 0
  while (index < value.length) {
    const point = value.codePointAt(index)
    if (point === undefined) break
    const original = String.fromCodePoint(point)
    chars.push(original.normalize('NFKC').toLowerCase())
    offsets.push(index)
    index += original.length
  }
  return { chars, offsets, text: chars.join('') }
}
