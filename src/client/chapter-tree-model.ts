/**
 * The chapter tree's decisions — and nothing else.
 *
 * WHY THIS IS EMPTY-ISH: the tree used to be JSX inside `index.tsx`, where "is this volume
 * open" was not a concept at all (every volume rendered every chapter, `index.tsx` had no
 * state for it). Collapsing that row is a decision with a default and an invariant, and
 * `node --test` cannot press a button, so the rule lives here and the component only binds it.
 *
 * The invariant is the default: **a volume is open unless its id is in the closed set.** The
 * other way round (an open set) means a book that gains a volume silently shows it collapsed,
 * and "I added a volume and it is empty" is exactly the report that would follow.
 *
 * No IO, no React (ADR-0008 D4): this module is imported by the component and by the tests.
 */

/** Nothing collapsed — the state every page starts in. */
export const NO_VOLUMES_CLOSED: readonly string[] = []

/**
 * The id of the "未分卷" bucket.
 *
 * It collapses through the same rule as a volume, so it needs an id that cannot collide: a
 * volume id is `vol-NN`, and using an empty string would make the code read as "no group".
 */
export const LOOSE_GROUP_ID = 'loose'

/** `true` unless this group was collapsed. */
export function isVolumeOpen(closed: readonly string[], volumeId: string): boolean {
  return !closed.includes(volumeId)
}

/** Collapse an open group, or open a collapsed one. Order of the rest is preserved. */
export function toggleVolume(closed: readonly string[], volumeId: string): readonly string[] {
  return closed.includes(volumeId) ? closed.filter((id) => id !== volumeId) : [...closed, volumeId]
}

/**
 * What sits at the right of a volume head: how many chapters it holds.
 *
 * An empty volume is a real editorial state (a volume created before its chapters), so it
 * says so instead of showing `0 章` — a zero reads like a count bug.
 */
export function describeVolumeFacts(count: number): string {
  return count === 0 ? '还没有章' : `${String(count)} 章`
}
