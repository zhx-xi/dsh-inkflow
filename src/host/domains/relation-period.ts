/**
 * Relation time windows, data-model §3.3 / §5 (I-08's third clause).
 *
 * `relations/<slug>.md` carries `since` / `until`: the narrative span a relation holds
 * over. The direction rule reported contradictory *directions* and deliberately left the spans
 * alone, because deciding "these two intervals cannot both hold" needs a **chapter
 * order**, and inventing a second one here is how two answers to "which chapter is
 * later" appear in one book.
 *
 * So this module owns no order of its own. It borrows the ledger's (I-23):
 *
 *   * a boundary is a **chapter id or its project-relative path**, resolved through
 *     {@link chapterPositionsFromRows} and compared with `comparePosition` — reading
 *     order is `(volume order, volume-local seq)`, never `seq` alone and never the id's
 *     text (`ch-10` sorts before `ch-9` as a string, and `vol-02/seq=1` comes after
 *     `vol-01/seq=1` even though both are `seq: 1`);
 *   * intervals are **`[since, until)`**: a missing `since` starts at the beginning of
 *     the book, a missing `until` still holds;
 *   * a boundary that cannot be placed is **not judged** (`RELATION_PERIOD_UNCOMPARABLE`,
 *     info) rather than guessed at — a typo in `since` must not accuse a correct edge,
 *     and a free label (`永平三年秋`) carries no position in the chapter order at all.
 *
 * ## The three judgements
 *
 *   1. **one edge that cannot hold** — `since` at or after `until` on the same file
 *      (`RELATION_PERIOD_CONFLICT`). `[c, c)` never holds, and a reversed window never
 *      holds either; both are defects of that one file, so unlike I-23 there *is* a
 *      per-row report (a ledger line with an empty interval is invisible, an edge that
 *      never holds is a relation the author believes in and the book does not have).
 *   2. **two edges for one fact** — one `(unordered pair, kind)` bucket is one relation
 *      (the same bucket `relationConflicts` uses), so two windows that are neither
 *      identical nor a clean split at a single point cannot both describe it. Abutting
 *      windows (`[a,b)` + `[b,c)`) are the one lawful split — their union is still one
 *      interval — and identical windows disagree about nothing (that is
 *      `RELATION_DUPLICATE` / `RELATION_CONFLICT`'s business).
 *   3. **uncomparable** — a declared window with a boundary the book cannot place. It is
 *      reported, so the gap is visible, and it never blocks a write: the lax path (no
 *      `since`/`until`, or free labels) must stay writable, and "cannot say" is not
 *      "says the opposite".
 *
 * Nothing here touches the disk, the clock or a model. The rebuild (`relation.ts`) and
 * the write path (`relation-tools.ts`) call the same function on the same post-write
 * rows — X-4's double insurance — so a file that lands can never be one the next rebuild
 * calls broken.
 */

import { comparePosition, volumeOrderOf } from './foreshadowing-plan.js'
import type { ChapterPosition } from './foreshadowing-plan.js'
import type { RelationRow } from './relation-write.js'
import { volumeDirOf } from './scan-helpers.js'
import type { DomainEntityRef, ValidationIssue } from './types.js'

/**
 * Chapter positions for the judgement, read from the **cross-class projection** (X-1).
 *
 * Why the projection and not `chapters/`: a domain's `validate()` receives only its own
 * tables (`indexer.ts`: `validate({ root, scan: result })`), so the projection is the one
 * channel that carries ids across directories — the same reason the fact ledger resolves
 * chapter order from `entities` rather than walking `chapters/` again. Reading the
 * directory here would be a second truth about chapter order *and* a file walk inside
 * every write.
 *
 * The volume a chapter belongs to comes from its **directory** (`chapters/vol-01-…/…`),
 * which is what the chapter domain itself defaults to when the frontmatter omits
 * `volume` — the projection has no volume column (X-1 fixes the column set), and a
 * frontmatter `volume` that disagrees with the directory is already reported as
 * `VOLUME_DIR_MISMATCH`. `orderIndex` carries the volume-local `seq`.
 *
 * Positions are keyed by **both** id and project-relative path, the way
 * `chapterPositions()` does it: an author writes `since: ch-0007` or
 * `since: chapters/vol-01-首卷/0007-x.md` and both must resolve.
 */
export function chapterPositionsFromProjection(entities: readonly DomainEntityRef[]): Map<string, ChapterPosition> {
  const positions = new Map<string, ChapterPosition>()
  for (const entity of entities) {
    if (entity.kind !== 'chapters') continue
    if (entity.id === '' || entity.path === '') continue
    const volume = volumeDirOf(entity.path)
    const position: ChapterPosition = {
      id: entity.id,
      path: entity.path,
      title: entity.title,
      ...(volume === undefined ? {} : { volume }),
      // A chapter with no `seq` is placed at 1 — the same default the chapter readers apply,
      // so one book never gets two orders depending on which reader asked.
      seq: entity.orderIndex ?? 1,
      order: volumeOrderOf(volume),
    }
    positions.set(position.id, position)
    positions.set(position.path, position)
  }
  return positions
}

/**
 * Reading order as an **ordinal** per chapter.
 *
 * The ordinals exist so the rest of this module compares numbers while the *order* stays
 * `comparePosition`'s answer: one place decides what "later" means, and a book whose
 * volumes are reordered re-numbers every boundary in one call.
 */
function readingOrder(positions: ReadonlyMap<string, ChapterPosition>): Map<string, number> {
  const distinct = new Map<string, ChapterPosition>()
  for (const position of positions.values()) distinct.set(position.path, position)
  const ordinals = new Map<string, number>()
  ;[...distinct.values()].sort(comparePosition).forEach((position, index) => {
    ordinals.set(position.id, index + 1)
    ordinals.set(position.path, index + 1)
  })
  return ordinals
}

/** An open end of the book: `since` absent starts here, `until` absent runs to the other. */
const BEFORE_BOOK = Number.NEGATIVE_INFINITY
const AFTER_BOOK = Number.POSITIVE_INFINITY

interface Bound {
  /** `false` when the label has no place in the chapter order — the window cannot be judged. */
  readonly placed: boolean
  readonly at: number
}

interface Window {
  readonly since: Bound
  readonly until: Bound
  /** Both ends placeable. */
  readonly placed: boolean
  /** `[c, c)` and `until < since` never hold: not a span at all. */
  readonly empty: boolean
}

function label(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? undefined : trimmed
}

function bound(value: string | undefined, ordinals: ReadonlyMap<string, number>, open: number): Bound {
  const written = label(value)
  if (written === undefined) return { placed: true, at: open }
  const at = ordinals.get(written)
  return at === undefined ? { placed: false, at: open } : { placed: true, at }
}

function windowOf(row: RelationRow, ordinals: ReadonlyMap<string, number>): Window {
  const since = bound(row.since, ordinals, BEFORE_BOOK)
  const until = bound(row.until, ordinals, AFTER_BOOK)
  const placed = since.placed && until.placed
  return { since, until, placed, empty: placed && until.at <= since.at }
}

/** Does this edge declare both ends? Only then can "its own window is empty" be judged. */
function declaresWindow(row: RelationRow): boolean {
  return label(row.since) !== undefined && label(row.until) !== undefined
}

/** The interval as the author wrote it, so a finding quotes their own words back. */
function intervalText(row: RelationRow): string {
  const from = label(row.since) ?? '书首'
  const to = label(row.until) ?? '至今'
  return `[${from}, ${to})`
}

export interface RelationPeriodConflict {
  readonly code: 'RELATION_PERIOD_CONFLICT'
  /** The edge the finding is filed against: the later-starting side of a pair. */
  readonly path: string
  /** The other edge of the pair; absent when one file contradicts itself. */
  readonly otherPath?: string
  readonly detail: string
}

export interface RelationPeriodUncomparable {
  readonly code: 'RELATION_PERIOD_UNCOMPARABLE'
  readonly path: string
  readonly otherPath?: string
  readonly detail: string
}

export interface RelationPeriodVerdict {
  readonly conflicts: readonly RelationPeriodConflict[]
  readonly uncomparable: readonly RelationPeriodUncomparable[]
}

function byPath(left: { readonly path: string; readonly otherPath?: string }, other: {
  readonly path: string
  readonly otherPath?: string
}): number {
  if (left.path !== other.path) return left.path < other.path ? -1 : 1
  const leftOther = left.otherPath ?? ''
  const rightOther = other.otherPath ?? ''
  return leftOther === rightOther ? 0 : leftOther < rightOther ? -1 : 1
}

/**
 * One bucket of edges that describe the same fact: the unordered pair plus the kind.
 *
 * The *unordered* pair, not the ordered one, because that is the notion both rules in this
 * file need — `RELATION_DUPLICATE` keys on the ordered triple (it is about two files for
 * one claim), while "A and B are kin" is one fact however it is written down.
 */
function bucketsOf(rows: readonly RelationRow[]): RelationRow[][] {
  const groups = new Map<string, RelationRow[]>()
  for (const row of rows) {
    if (row.source === '' || row.target === '' || row.source === row.target) continue
    const ends = [row.source, row.target].sort()
    const key = `${ends[0] ?? ''}\u0000${ends[1] ?? ''}\u0000${row.relationKind}`
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [row])
    else bucket.push(row)
  }
  return [...groups.values()]
}

/**
 * Every time-window problem the book currently has.
 *
 * Deterministic order (path, then the other path) so two rebuilds of unchanged files
 * report the same list — the audit's whole value is being diffable between runs.
 */
export function relationPeriodFindings(
  rows: readonly RelationRow[],
  positions: ReadonlyMap<string, ChapterPosition>,
): RelationPeriodVerdict {
  const ordinals = readingOrder(positions)
  const conflicts: RelationPeriodConflict[] = []
  const uncomparable: RelationPeriodUncomparable[] = []

  // 1. A window that cannot hold, judged from the file alone.
  for (const row of rows) {
    if (!declaresWindow(row)) continue
    const window = windowOf(row, ordinals)
    if (!window.placed) {
      uncomparable.push({
        code: 'RELATION_PERIOD_UNCOMPARABLE',
        path: row.path,
        detail:
          `${row.path} 的时段 ${intervalText(row)} 里有一端不是本书的章 id，按章序排不出位置：` +
          '这段时段是否写反、是否为空都无法判定（改成本书章 id，或把自由标签留在正文里）',
      })
      continue
    }
    if (!window.empty) continue
    conflicts.push({
      code: 'RELATION_PERIOD_CONFLICT',
      path: row.path,
      detail:
        `${row.path} 的时段是空的：since「${label(row.since) ?? ''}」按章序不早于 until「${label(row.until) ?? ''}」，` +
        '这条关系从未成立（时段是 [since, until)，两端同一章也算空）',
    })
  }

  // 2. Two windows for one fact.
  for (const bucket of bucketsOf(rows)) {
    if (bucket.length < 2) continue
    const sorted = [...bucket].sort((left, right) => (left.path === right.path ? 0 : left.path < right.path ? -1 : 1))
    for (let index = 0; index < sorted.length; index += 1) {
      const left = sorted[index]
      if (left === undefined) continue
      for (let next = index + 1; next < sorted.length; next += 1) {
        const right = sorted[next]
        if (right === undefined) continue
        const leftWindow = windowOf(left, ordinals)
        const rightWindow = windowOf(right, ordinals)
        if (!leftWindow.placed || !rightWindow.placed) {
          uncomparable.push({
            code: 'RELATION_PERIOD_UNCOMPARABLE',
            path: right.path,
            otherPath: left.path,
            detail:
              `${left.path}（${intervalText(left)}）与 ${right.path}（${intervalText(right)}）写的是同一条关系，` +
              '但其中一端不是本书的章 id：这两段时段是否矛盾无法判定',
          })
          continue
        }
        // An empty window never holds, so it cannot contradict anything — the same filter
        // I-23 applies before pairing (its own defect is reported above).
        if (leftWindow.empty || rightWindow.empty) continue
        // Identical windows disagree about nothing: that is a duplicate or a direction
        // conflict, both reported by their own rule.
        if (leftWindow.since.at === rightWindow.since.at && leftWindow.until.at === rightWindow.until.at) continue
        // Abutting windows are one interval split at a point: the union is still a single
        // span, so the two files can both be true of one relation.
        if (leftWindow.until.at === rightWindow.since.at || rightWindow.until.at === leftWindow.since.at) continue
        conflicts.push({
          code: 'RELATION_PERIOD_CONFLICT',
          path: right.path,
          otherPath: left.path,
          detail:
            `同一条关系（${left.source} ⇄ ${left.target}, ${left.relationKind}）有两套时段：` +
            `${left.path} 是 ${intervalText(left)}，${right.path} 是 ${intervalText(right)}；` +
            '一条关系只有一个时段，两套既不相同也不是在一个点上一分为二，所以它们不可能同时成立',
        })
      }
    }
  }

  return { conflicts: conflicts.sort(byPath), uncomparable: uncomparable.sort(byPath) }
}

/**
 * The findings a **write** must be refused for.
 *
 * Only pairs the candidate is a half of: a contradiction can be introduced by editing the
 * older edge as easily as the newer one, but a pre-existing conflict between two other
 * files is a rebuild diagnosis — reporting it here would wedge every later edit on a line
 * the author was not touching (the same reasoning `conflictsTouching` applies to the
 * ledger).
 */
export function periodConflictsTouching(
  conflicts: readonly RelationPeriodConflict[],
  path: string,
): RelationPeriodConflict[] {
  return conflicts.filter((conflict) => conflict.path === path || conflict.otherPath === path)
}

/** What the read surface says about one edge's window. */
export interface RelationPeriodMark {
  /** The edge says something its own window cannot support. */
  readonly conflict?: { readonly otherPath?: string; readonly detail: string }
  /** The window has a boundary this book cannot place, so nothing is claimed about it. */
  readonly uncomparable?: { readonly detail: string }
}

/**
 * Per-edge marks for the read side (`inkflow_relation_list` / `inkflow_relation_clues`).
 *
 * Both halves of a conflicting pair are marked, because the author has to see the pair:
 * a row that only said "this edge is fine" while the book reports a conflict would send
 * them looking for the problem in the wrong file.
 */
export function relationPeriodMarks(
  rows: readonly RelationRow[],
  positions: ReadonlyMap<string, ChapterPosition>,
): Map<string, RelationPeriodMark> {
  const verdict = relationPeriodFindings(rows, positions)
  const marks = new Map<string, RelationPeriodMark>()
  // First mark wins per half: an edge with two problems gets the one found first, and the
  // order of `relationPeriodFindings` is stable, so two reads report the same text.
  const add = (path: string, mark: RelationPeriodMark): void => {
    const existing = marks.get(path)
    if (existing === undefined) {
      marks.set(path, mark)
      return
    }
    const conflict = existing.conflict ?? mark.conflict
    const note = existing.uncomparable ?? mark.uncomparable
    marks.set(path, {
      ...(conflict === undefined ? {} : { conflict }),
      ...(note === undefined ? {} : { uncomparable: note }),
    })
  }
  for (const conflict of verdict.conflicts) {
    add(conflict.path, {
      conflict: {
        ...(conflict.otherPath === undefined ? {} : { otherPath: conflict.otherPath }),
        detail: conflict.detail,
      },
    })
    if (conflict.otherPath !== undefined) {
      add(conflict.otherPath, { conflict: { otherPath: conflict.path, detail: conflict.detail } })
    }
  }
  for (const note of verdict.uncomparable) {
    add(note.path, { uncomparable: { detail: note.detail } })
    if (note.otherPath !== undefined) add(note.otherPath, { uncomparable: { detail: note.detail } })
  }
  return marks
}

/**
 * The body of `relationDomain.validate()` for this rule.
 *
 * With `candidate` present only the conflicts that touch it are returned, because on the
 * write path every returned issue blocks the write (`DomainValidateInput`), and an
 * uncomparable note must never be blocking — a free label is the documented lax path.
 */
export function relationPeriodIssues(
  rows: readonly RelationRow[],
  positions: ReadonlyMap<string, ChapterPosition>,
  candidate?: { readonly path: string },
): ValidationIssue[] {
  const verdict = relationPeriodFindings(rows, positions)
  if (candidate === undefined) {
    return [
      ...verdict.conflicts.map((conflict) => ({
        code: conflict.code,
        path: conflict.path,
        detail: conflict.detail,
      })),
      ...verdict.uncomparable.map((note) => ({ code: note.code, path: note.path, detail: note.detail })),
    ]
  }
  return periodConflictsTouching(verdict.conflicts, candidate.path).map((conflict) => ({
    code: conflict.code,
    path: conflict.path,
    detail: conflict.detail,
  }))
}
