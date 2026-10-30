/**
 * Chapter numbering: the old numbers are kept unless the author asked to compact them, and the
 * gaps they leave are reported as a decision rather than silently closed.
 *
 * WHY IT IS A FILE: numbering is the one part of the plan with a rule the author can argue with
 * ("do not renumber my chapters"), so it gets a module whose exports read as that rule, instead
 * of being 110 lines in the middle of the builder.
 */

import { CHAPTER_STATUSES } from './conventions.js'
import type { ForeshadowStatus } from './domains/foreshadowing-plan.js'
import type { LegacyBook } from './etl-source.js'
import { pad2 } from './etl-plan-text.js'
import type { EtlGap } from './etl-plan-types.js'

// ---------------------------------------------------------------------------
// Chapters: numbering, and the gap report nobody may act on automatically
// ---------------------------------------------------------------------------

export interface Numbering {
  readonly numbers: Map<number, number>
  readonly gaps: EtlGap[]
  readonly conflicts: readonly number[]
}

/**
 * Assign a chapter number to every legacy chapter.
 *
 * `keep` (the default) takes the legacy `order_index` when it is a positive integer and
 * unused — that is what reproduces the author's numbering, gaps included. Anything else
 * (a fractional index left by a drag-and-drop reorder, a duplicated number) falls back to
 * the next free number, and the affected rows are listed so the report can say which
 * numbers moved.
 */
export function numberChapters(book: LegacyBook, renumber: 'keep' | 'compact'): Numbering {
  const numbers = new Map<number, number>()
  const conflicts: number[] = []
  const used = new Set<number>()

  if (renumber === 'compact') {
    book.chapters.forEach((chapter, index) => numbers.set(chapter.id, index + 1))
    return { numbers, gaps: [], conflicts }
  }

  let next = 1
  for (const chapter of book.chapters) {
    const rounded = Math.round(chapter.orderIndex)
    const integral = Math.abs(chapter.orderIndex - rounded) < 1e-6 && rounded >= 1
    let candidate = integral && !used.has(rounded) ? rounded : 0
    if (candidate === 0 && integral) conflicts.push(chapter.id)
    if (candidate === 0) {
      candidate = next
      while (used.has(candidate)) candidate += 1
    }
    used.add(candidate)
    numbers.set(chapter.id, candidate)
    next = Math.max(next, candidate + 1)
  }
  return { numbers, gaps: gapsOf(book, numbers), conflicts }
}

/**
 * Missing chapter numbers — at **book** scope first, then per volume.
 *
 * Book scope is not a convenience: the real cases are gaps *between* volumes (one library
 * skips 49–50 while its volumes are 39–48 and 51–86, another skips 121–137). A per-volume
 * range alone reports nothing there, because the missing numbers fall outside every
 * volume's own [min, max]. Nothing before the first chapter or after the last is "missing":
 * a book that starts at 3 is not broken.
 */
export function gapsOf(book: LegacyBook, numbers: ReadonlyMap<number, number>): EtlGap[] {
  const byScope = new Map<string, number[]>()
  for (const chapter of book.chapters) {
    const number = numbers.get(chapter.id)
    if (number === undefined) continue
    const scope = chapter.volumeId === null ? 'loose' : `volume:${String(chapter.volumeId)}`
    const list = byScope.get(scope) ?? []
    list.push(number)
    byScope.set(scope, list)
  }
  const missingIn = (list: readonly number[]): { present: number[]; missing: number[] } => {
    const sorted = [...list].sort((left, right) => left - right)
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    if (first === undefined || last === undefined) return { present: sorted, missing: [] }
    const present = new Set(sorted)
    const missing: number[] = []
    for (let number = first; number <= last; number += 1) if (!present.has(number)) missing.push(number)
    return { present: sorted, missing }
  }

  const gaps: EtlGap[] = []
  const everything = [...byScope.values()].flat()
  const whole = missingIn(everything)
  if (whole.missing.length > 0) gaps.push({ scope: 'book', present: whole.present, missing: whole.missing })

  for (const [scope, list] of [...byScope].sort(([left], [right]) => left.localeCompare(right))) {
    const found = missingIn(list)
    if (found.missing.length === 0) continue
    gaps.push({
      scope: scope === 'loose' ? 'loose' : `vol-${pad2(Number(scope.slice('volume:'.length)))}`,
      present: found.present,
      missing: found.missing,
    })
  }
  return gaps
}

/** `open`/`planted` → planted; the old app wrote just `open` for every unresolved entry. */
export function foreshadowStatusOf(raw: string): ForeshadowStatus | undefined {
  const value = raw.trim().toLowerCase()
  if (value === '' || value === 'open' || value === 'planted') return 'planted'
  if (value === 'advanced' || value === 'advancing' || value === 'developing') return 'advanced'
  if (value === 'resolved' || value === 'closed' || value === 'done') return 'resolved'
  if (value === 'overdue') return 'overdue'
  return undefined
}

export function chapterStatusOf(raw: string): 'draft' | 'revised' | 'final' {
  const value = raw.trim().toLowerCase()
  return (CHAPTER_STATUSES as readonly string[]).includes(value) ? (value as 'draft' | 'revised' | 'final') : 'draft'
}

export const CALENDAR_DATE = /^\d{4}(?:-\d{2}(?:-\d{2}))?$/u
