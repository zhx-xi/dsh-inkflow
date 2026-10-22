/**
 * Name normalisation — one implementation, shared by every domain (roadmap X-1).
 *
 * A second `nameKey` would let the write path and the rebuild disagree about
 * whether two names collide, which is exactly the class of bug #101 forbids.
 */

/** Normalise a name for uniqueness checks: NFKC, case-fold, strip whitespace. */
export function nameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')
}
