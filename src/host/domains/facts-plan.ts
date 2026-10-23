/**
 * The fact ledger's model, as pure functions (issue #32): parse one `facts/<subject>.md`,
 * judge the interval rule, and answer "which facts hold at chapter N".
 *
 * Why the rules live here and not inside `facts.ts`: a rebuild judges a whole scan while
 * a write judges one candidate against the current view, and both must apply the *same*
 * rules (roadmap §2.1 X-4 — "写入侧落盘前调用同一个判定"). The parser lives here for the
 * same reason `timeline-plan.ts` does: `scan()` and `parseFile()` must never disagree
 * about what a candidate means, and the write path needs the parser without importing
 * the domain module (registry → domain → the domain's own tools closes a cycle).
 *
 * Nothing in this file touches the disk: no reads, no writes, no clock.
 *
 * ## The two judgements (data-model §5)
 *
 * * **I-22 `FACT_LINE_MALFORMED`** — a body list item that is not a fact (ADR-0013). It is
 *   a **warning** carrying a line anchor `path#L<n>`: one bad line must not hide the rest
 *   of the file, and the author usually typed it by hand.
 * * **I-23 `FACT_CONFLICT`** — two facts of the same `subject + attribute` whose intervals
 *   overlap **and** whose values differ. Intervals are `[since, until)` and are compared
 *   **by chapter order (`chapters.seq`)**, never by id: `ch-10` sorts before `ch-9` as a
 *   string, which would put a fact in effect before it was ever established. A missing
 *   `since` starts at the beginning of the book, a missing `until` runs to the end.
 *
 * Two limits are deliberate and stated here rather than discovered later:
 *
 *   1. a boundary whose chapter id is not in the book cannot be placed, so a pair that
 *      needs that boundary is **not** judged (it is not silently "conflicting": a typo in
 *      `since` must not accuse a correct fact). `inkflow_facts_list` reports the ids it
 *      could not resolve, so the gap is visible instead of silent;
 *   2. `FACT_CONFLICT` is reported **per pair**, not per fact: three mutually overlapping
 *      values are three contradictions, and collapsing them would hide two of them;
 *   3. an **empty** interval (`until` at or before `since`) is not a span at all — it never
 *      holds — so it is left out of the pairing instead of being compared as if it did.
 */

import { basename, extname } from 'node:path'

import { splitFrontmatter, parseMarkdown, stringField } from '../frontmatter.js'
import { nameKey } from './naming.js'
import { rowsBucket } from './types.js'
import type { DomainEntityRef, DomainFileParse, ValidationIssue } from './types.js'
import { DEFAULT_FACT_SOURCE, isFactLine, parseFactLine } from './facts-line.js'
import type { FactLine } from './facts-line.js'

/**
 * The one table this domain owns. Declared here rather than in `facts.ts` because the
 * domain's tools read the bucket by name too, and importing the domain module from its
 * own tools would close a runtime import cycle.
 */
export const FACTS_TABLE = 'facts'

/** One fact, as the rules and the queries read it. */
export interface FactRow {
  /**
   * Row identity — `path#L<line>`.
   *
   * Why not `subject + attribute` and not the bare `path`: one file holds many facts, and
   * the seam's same-table de-duplication keys on `id ?? path` (`scanProject`), so rows
   * without their own id would collapse to one row per file. The line is the only
   * per-fact address a ledger has (ADR-0013), so it is the id.
   */
  readonly id: string
  readonly path: string
  /** 1-based line in the file, so a finding can point at it. */
  readonly line: number
  readonly subject: string
  readonly attribute: string
  readonly value: string
  readonly since?: string
  readonly until?: string
  /** The chapter the fact was *recorded* in — not the start of its interval. */
  readonly chapter?: string
  readonly source: string
  /** Unknown keys, kept in memory only: not a column, and never lost by a write. */
  readonly extra: Readonly<Record<string, string>>
}

export interface ParsedFacts {
  /** `subject` from frontmatter, else the file's own name (see {@link parseFactsFile}). */
  readonly subject: string
  readonly title?: string
  readonly rows: readonly FactRow[]
  readonly issues: readonly ValidationIssue[]
}

/** `path#L<n>` — the anchor every finding and every row identity uses. */
export function factAnchor(path: string, line: number): string {
  return `${path}#L${line}`
}

/**
 * Where the body starts, 1-based, so a body line index becomes a file line number.
 *
 * `parseMarkdown` returns the body without its offsets on purpose (it also normalises
 * BOM/CRLF), so the offset is recomputed here: the frontmatter block is byte-identical in
 * `splitFrontmatter().head`, and the body starts right after it.
 */
function bodyFirstLine(text: string): number {
  const head = splitFrontmatter(text).head
  if (head === '') return 1
  const normalized = head.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n')
  // `head` ends with the closing delimiter's newline, so the split's last element is the
  // (empty) first body line — its position *is* the body's first line number.
  return normalized.split('\n').length
}

/**
 * One ledger file → its subject, its facts and its warnings.
 *
 * `subject` falls back to the file name when the frontmatter omits it: the file name *is*
 * the subject by convention (`facts/<subject>.md`), and a ledger that refuses to load
 * because one metadata line was forgotten would lose every fact in it.
 *
 * The fallback is **not silent** (rework of PR #124): it is reported as a
 * `FRONTMATTER_ISSUE` warning (non-blocking, I-10 — frontmatter the format requires and the
 * file does not carry). Silent was wrong in a way that shows up later: the facts of that
 * ledger are indexed under a name nobody chose (`facts/qingyin.md` → subject `qingyin`), so
 * `inkflow_facts_append` with `subject: char-qingyin` does not find them and creates a
 * second file for the same subject. A warning at every rebuild is the cheapest place to
 * make that cost visible; nothing is refused, because a book that already lacks the key
 * must keep working.
 */
export function parseFactsFile(path: string, text: string): ParsedFacts {
  const fallbackSubject = basename(path).replace(/\.md$/u, '')
  if (extname(path).toLowerCase() !== '.md') {
    // Same policy as every other domain: the directory is for ledgers, a stray name is
    // not a problem worth a line in `validation_issues` on every rebuild.
    return { subject: fallbackSubject, rows: [], issues: [] }
  }

  const parsed = parseMarkdown(text)
  const issues: ValidationIssue[] = parsed.issues.map((issue) => ({ code: 'FRONTMATTER_ISSUE', path, detail: issue }))
  const declaredSubject = (stringField(parsed.data, 'subject') ?? '').trim()
  const subject = declaredSubject || fallbackSubject
  if (declaredSubject === '') {
    // I-10 (warning, never a refusal): the file must say which entity it is about, and the
    // fallback is the file name — which decides the *subject of every row in the file* and
    // therefore which ledger `inkflow_facts_append` looks for. Reported so the author can
    // correct the name instead of discovering it as a second ledger.
    issues.push({
      code: 'FRONTMATTER_ISSUE',
      path,
      detail: `subject 缺失：按文件名「${fallbackSubject}」登记这些事实；补一行 \`subject: <主体 id>\` 可消除这条提示`,
    })
  }
  const title = (stringField(parsed.data, 'title') ?? '').trim() || undefined

  const rows: FactRow[] = []
  const firstLine = bodyFirstLine(text)
  const lines = parsed.body.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string
    if (!isFactLine(line)) continue
    const lineNumber = firstLine + index
    const result = parseFactLine(line)
    if (!result.ok) {
      issues.push({
        code: 'FACT_LINE_MALFORMED',
        path: factAnchor(path, lineNumber),
        detail: result.reason,
      })
      continue
    }
    rows.push(toRow(path, lineNumber, subject, result.fact))
  }

  return { subject, ...(title === undefined ? {} : { title }), rows, issues }
}

function toRow(path: string, line: number, subject: string, fact: FactLine): FactRow {
  return {
    id: factAnchor(path, line),
    path,
    line,
    subject,
    attribute: fact.attribute,
    value: fact.value,
    ...(fact.since === undefined ? {} : { since: fact.since }),
    ...(fact.until === undefined ? {} : { until: fact.until }),
    ...(fact.chapterId === undefined ? {} : { chapter: fact.chapterId }),
    source: fact.source === '' ? DEFAULT_FACT_SOURCE : fact.source,
    extra: fact.extra,
  }
}

/**
 * The ledger's projection row (X-1: this domain adds rows, never columns).
 *
 * **The id is the file path, not the subject.** A ledger's subject is a *reference* (it
 * names a character / item / place that has its own file), so using it as this entity's id
 * made the two rows collide: `characters/qingyin.md` with `id: char-qingyin` plus
 * `facts/char-qingyin.md` with `subject: char-qingyin` reported `DUPLICATE_ID` on every
 * rebuild, and the mention scan then counted every 清音 in the prose twice — once for the
 * character and once for its ledger, whose `title` is the character's name.
 *
 * A ledger entry has no name of its own: its "name" *is* the subject, which the subject
 * entity already publishes. So the ledger is addressed by its file (the default every other
 * kind falls back to), the subject stays a field of the *rows*, and `domains/mentions.ts`
 * leaves `kind === 'facts'` out of the automaton (data-model §4.1 / §5 I-04).
 */
export function factsEntity(parsed: ParsedFacts, path: string): DomainEntityRef {
  const title = parsed.title ?? parsed.subject
  return {
    kind: 'facts',
    id: path,
    path,
    title,
    nameKey: nameKey(title),
  }
}

/**
 * One file as the seam's `parseFile()` sees it — the body of `factsDomain.parseFile`.
 *
 * Exported so the write path can run the *same* parse without importing the domain
 * module (which imports the tools back: a runtime cycle).
 */
export function factsFileParse(path: string, text: string): DomainFileParse {
  if (extname(path).toLowerCase() !== '.md') return { path, rows: [], issues: [] }
  const parsed = parseFactsFile(path, text)
  return {
    path,
    rows: parsed.rows.length === 0 ? [] : [rowsBucket(FACTS_TABLE, parsed.rows)],
    // One ledger file is one entity (id = the path), even when the file currently holds no
    // fact line — an empty ledger is still a known ledger for its subject.
    entity: factsEntity(parsed, path),
    issues: parsed.issues,
  }
}

// ---------------------------------------------------------------------------
// Chapter order
// ---------------------------------------------------------------------------

/** Chapter id → its position in the book; `undefined` when the id is not a chapter. */
export type ChapterSeq = (chapterId: string | undefined) => number | undefined

/**
 * Build the order from the cross-class projection a scan already produced.
 *
 * Why the projection and not a second file walk: on the write path `validate()` gets a
 * post-write `entities` list and nothing else (a domain owns one directory), and the
 * chapter rows carry exactly what the rule needs — `id` + `orderIndex`, which the chapter
 * domain fills from `seq`. Reading `chapters/` again here would be a second truth about
 * chapter order.
 */
export function chapterSeqFrom(entities: readonly DomainEntityRef[]): ChapterSeq {
  const byId = new Map<string, number>()
  for (const entity of entities) {
    if (entity.kind !== 'chapters') continue
    if (entity.orderIndex === undefined) continue
    byId.set(entity.id, entity.orderIndex)
  }
  return (chapterId) => (chapterId === undefined ? undefined : byId.get(chapterId))
}

export function chapterSeqFromMap(byId: ReadonlyMap<string, number>): ChapterSeq {
  return (chapterId) => (chapterId === undefined ? undefined : byId.get(chapterId))
}

export function chapterIdsUsed(rows: readonly FactRow[]): string[] {
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.since !== undefined) ids.add(row.since)
    if (row.until !== undefined) ids.add(row.until)
  }
  return [...ids].sort()
}

/** Chapter ids a ledger names that the book does not have — a typo, not a conflict. */
export function unresolvedChapterIds(rows: readonly FactRow[], seqOf: ChapterSeq): string[] {
  return chapterIdsUsed(rows).filter((id) => seqOf(id) === undefined)
}

// ---------------------------------------------------------------------------
// The interval rule (I-23)
// ---------------------------------------------------------------------------

export interface FactConflict {
  readonly code: 'FACT_CONFLICT'
  /** The later-starting side of the pair: the fact an edit most likely introduced. */
  readonly path: string
  readonly line: number
  readonly otherPath: string
  readonly otherLine: number
  readonly detail: string
}

interface Bound {
  /** Resolvable, so a pair using it can be judged. */
  readonly placed: boolean
  readonly seq: number
}

const NEGATIVE_INFINITY = Number.NEGATIVE_INFINITY
const POSITIVE_INFINITY = Number.POSITIVE_INFINITY

function sinceBound(row: FactRow, seqOf: ChapterSeq): Bound {
  if (row.since === undefined) return { placed: true, seq: NEGATIVE_INFINITY }
  const seq = seqOf(row.since)
  return seq === undefined ? { placed: false, seq: NEGATIVE_INFINITY } : { placed: true, seq }
}

function untilBound(row: FactRow, seqOf: ChapterSeq): Bound {
  if (row.until === undefined) return { placed: true, seq: POSITIVE_INFINITY }
  const seq = seqOf(row.until)
  return seq === undefined ? { placed: false, seq: POSITIVE_INFINITY } : { placed: true, seq }
}

function compareRows(left: FactRow, right: FactRow): number {
  if (left.subject !== right.subject) return left.subject < right.subject ? -1 : 1
  if (left.attribute !== right.attribute) return left.attribute < right.attribute ? -1 : 1
  if (left.since !== right.since) return (left.since ?? '') < (right.since ?? '') ? -1 : 1
  if (left.path !== right.path) return left.path < right.path ? -1 : 1
  return left.line - right.line
}

/**
 * Every overlapping pair of one `subject + attribute` whose values differ (I-23).
 *
 * Deterministic order (path, line, other path, other line) so a rebuild of unchanged files
 * reports the same list, which is what makes the finding diffable and the audit (#33)
 * comparable between runs.
 */
export function factsConflicts(rows: readonly FactRow[], seqOf: ChapterSeq): FactConflict[] {
  const groups = new Map<string, FactRow[]>()
  for (const row of rows) {
    const key = `${row.subject}\u0000${row.attribute}`
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [row])
    else bucket.push(row)
  }

  const findings: FactConflict[] = []
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue
    const placed = bucket
      .map((row) => ({ row, since: sinceBound(row, seqOf), until: untilBound(row, seqOf) }))
      // An **empty** interval (`until` at or before `since`) never holds, so it cannot
      // contradict anything: without this filter `[ch-5, ch-5)` or a reversed `[ch-9, ch-2)`
      // looks like a real span to the overlap test and accuses a fact that is never in
      // effect. `factInEffect` already answers `false` for both.
      .filter((bound) => bound.until.seq > bound.since.seq)
      .sort((left, right) => {
        if (left.since.seq !== right.since.seq) return left.since.seq < right.since.seq ? -1 : 1
        return compareRows(left.row, right.row)
      })
    if (placed.length < 2) continue

    for (let index = 0; index < placed.length; index += 1) {
      const left = placed[index]
      if (left === undefined) continue
      for (let next = index + 1; next < placed.length; next += 1) {
        const right = placed[next]
        if (right === undefined) continue
        if (!left.since.placed || !left.until.placed || !right.since.placed || !right.until.placed) continue
        // `[since, until)`: touching intervals are adjacent, not overlapping.
        if (!(left.since.seq < right.until.seq && right.since.seq < left.until.seq)) continue
        if (left.row.value === right.row.value) continue
        findings.push({
          code: 'FACT_CONFLICT',
          path: right.row.path,
          line: right.row.line,
          otherPath: left.row.path,
          otherLine: left.row.line,
          detail:
            `"${right.row.attribute}" of ${right.row.subject} is established twice with different values ` +
            `(${describeInterval(left.row)} = "${left.row.value}" vs ${describeInterval(right.row)} = "${right.row.value}")`,
        })
      }
    }
  }

  return findings.sort((left, right) => {
    if (left.path !== right.path) return left.path < right.path ? -1 : 1
    if (left.line !== right.line) return left.line - right.line
    if (left.otherPath !== right.otherPath) return left.otherPath < right.otherPath ? -1 : 1
    return left.otherLine - right.otherLine
  })
}

function describeInterval(row: FactRow): string {
  const from = row.since === undefined ? '书首' : row.since
  const to = row.until === undefined ? '至今' : row.until
  return `[${from}, ${to})`
}

/**
 * The conflicts a write must be refused for.
 *
 * A pair is "touched" when the candidate is either half of it: a contradiction can be
 * introduced by editing the *older* fact as easily as the newer one, and a gate that only
 * looked at the newer side would let half the edits through. A conflict between two other
 * lines of the same file is a rebuild diagnosis and must not wedge every later append —
 * that is why the match is per line, not per file.
 */
export function conflictsTouching(
  conflicts: readonly FactConflict[],
  candidate: { readonly path: string; readonly line?: number },
): FactConflict[] {
  const match = (path: string, line: number): boolean =>
    path === candidate.path && (candidate.line === undefined || candidate.line === line)
  return conflicts.filter(
    (conflict) => match(conflict.path, conflict.line) || match(conflict.otherPath, conflict.otherLine),
  )
}

/**
 * The body of `factsDomain.validate()`: one judge, two nets.
 *
 * A rebuild passes no candidate and gets every conflict (each anchored at a line); the
 * seam's write path passes the path being written and gets only the conflicts that touch
 * it. Line numbers are unknown there (`DomainValidateInput.candidate` carries a path), so
 * any conflict inside that file is returned — the stricter direction, and a shape no
 * production caller uses yet.
 */
export function factsValidate(
  rows: readonly FactRow[],
  seqOf: ChapterSeq,
  candidate?: { readonly path: string; readonly line?: number },
): ValidationIssue[] {
  const conflicts = factsConflicts(rows, seqOf)
  const relevant = candidate === undefined ? conflicts : conflictsTouching(conflicts, candidate)
  return relevant.map((conflict) => ({
    code: conflict.code,
    path: factAnchor(conflict.path, conflict.line),
    detail: conflict.detail,
  }))
}

// ---------------------------------------------------------------------------
// The snapshot ("which facts hold at chapter N")
// ---------------------------------------------------------------------------

/**
 * Is this fact in effect at `atSeq`?
 *
 * `[since, until)` with `since` missing meaning "from the beginning" and `until` missing
 * meaning "still true". A fact whose boundary cannot be placed is **excluded**: the
 * snapshot answers "what is certainly true", and including a fact whose start chapter is a
 * typo would inject a fact that may not have happened yet.
 */
export function factInEffect(row: FactRow, seqOf: ChapterSeq, atSeq: number): boolean {
  const since = sinceBound(row, seqOf)
  if (!since.placed) return false
  const until = untilBound(row, seqOf)
  if (!until.placed) return false
  return since.seq <= atSeq && atSeq < until.seq
}

/**
 * The facts in effect at `atSeq`, in the one stable order the snapshot promises:
 * `subject → attribute → since (by chapter order) → line`.
 *
 * Determinism is a criterion of its own (issue #32): two runs on the same book must produce
 * byte-identical output, so nothing here depends on map iteration order or on the readdir
 * order the rows arrived in.
 */
export function factsSnapshot(rows: readonly FactRow[], seqOf: ChapterSeq, atSeq: number): FactRow[] {
  return rows
    .filter((row) => factInEffect(row, seqOf, atSeq))
    .sort((left, right) => {
      if (left.subject !== right.subject) return left.subject < right.subject ? -1 : 1
      if (left.attribute !== right.attribute) return left.attribute < right.attribute ? -1 : 1
      const leftSince = sinceBound(left, seqOf).seq
      const rightSince = sinceBound(right, seqOf).seq
      if (leftSince !== rightSince) return leftSince < rightSince ? -1 : 1
      if (left.path !== right.path) return left.path < right.path ? -1 : 1
      return left.line - right.line
    })
}

/** Every fact in the stable order the list tool reports (no chapter filter, no line filter). */
export function sortFacts(rows: readonly FactRow[], seqOf: ChapterSeq): FactRow[] {
  return [...rows].sort((left, right) => {
    if (left.subject !== right.subject) return left.subject < right.subject ? -1 : 1
    if (left.attribute !== right.attribute) return left.attribute < right.attribute ? -1 : 1
    const leftSince = sinceBound(left, seqOf).seq
    const rightSince = sinceBound(right, seqOf).seq
    if (leftSince !== rightSince) return leftSince < rightSince ? -1 : 1
    if (left.path !== right.path) return left.path < right.path ? -1 : 1
    return left.line - right.line
  })
}
