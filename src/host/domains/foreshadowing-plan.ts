/**
 * The foreshadowing model, as pure functions (#31): one file's meaning, the state
 * machine, the computed `overdue` state, and the document a write produces.
 *
 * Why the rules live here and not inside `foreshadowing.ts`: a rebuild judges a whole
 * scan while a write judges one candidate against the current view, and both must run
 * the *same* rules (roadmap X-4 — "写入侧落盘前调用同一个判定"). The parser lives here
 * for the same reason: `scan()` and `parseFile()` must never disagree about what a
 * candidate means, and the write path needs the parser without importing the domain
 * module (registry → domain → domain's own tools would close a runtime cycle).
 *
 * Nothing in this file touches the disk: no reads, no writes, no clock.
 *
 * ## The declared shape (data-model §3.2)
 *
 *   status: planted|advanced|resolved|overdue   — the machine field
 *   resolved: true|false                        — read-compatibility only (old files)
 *   plantedAt: ch-1
 *   advancedAt: [ch-2, ch-3]                    — block list, in reading order
 *   resolvedChapter: ch-9
 *   dueBy: ch-7 | vol-02                        — the only input of the `overdue` rule
 *   linkedEntities: [c-qingyin]                 — the board's per-character grouping
 *
 * ## Two things this file deliberately does NOT do
 *
 * 1. It never stores `overdue`. `overdue` is computed from the *current chapter*
 *    (§3.2.2), so a table column would go stale the moment the book moves on; the
 *    file's own `status: overdue` is echoed as `declaredStatus` and loses to the
 *    computed answer.
 * 2. It never compares file names. Chapter order is `(volume order, seq)` from the
 *    frontmatter — `vol-10` sorts *after* `vol-02` as text and that is the wrong
 *    answer.
 */

import { basename, extname } from 'node:path'

import {
  boolField,
  frontmatterLine,
  frontmatterListItem,
  parseMarkdown,
  patchFrontmatter,
  rawScalar,
  splitFrontmatter,
  stringArrayField,
  stringField,
} from '../frontmatter.js'
import type { FrontmatterValue } from '../frontmatter.js'
import type { DomainEntityRef, ValidationIssue } from './types.js'

/**
 * The one table this domain owns. Declared here rather than in `foreshadowing.ts`
 * because the domain's tools and its panel projection read the bucket by name too,
 * and importing the domain module from its own tools would close a runtime cycle.
 */
export const FORESHADOW_TABLE = 'foreshadowings'

export const FORESHADOW_STATUSES = ['planted', 'advanced', 'resolved', 'overdue'] as const
export type ForeshadowStatus = (typeof FORESHADOW_STATUSES)[number]

/** One foreshadow, as the rules and both read paths see it. */
export interface ForeshadowRow {
  readonly id: string
  readonly path: string
  readonly title: string
  /** Effective status: the file's `status`, or the value derived from `resolved`. */
  readonly status: ForeshadowStatus
  /** The `status` the file literally carries (`undefined` when it only says `resolved`). */
  readonly declaredStatus?: ForeshadowStatus
  /** The read-compatibility boolean, present only when the file has the key. */
  readonly resolved?: boolean
  readonly plantedAt?: string
  readonly advancedAt: readonly string[]
  readonly dueBy?: string
  readonly resolvedChapter?: string
  readonly linkedEntities: readonly string[]
}

// ---------------------------------------------------------------------------
// The state machine (data-model §3.2.1, I-21)
// ---------------------------------------------------------------------------

/** The eleven legal cells of the 4×4 matrix, spelled out rather than derived. */
const ALLOWED_TRANSITIONS: ReadonlySet<string> = new Set([
  'planted->planted',
  'planted->advanced',
  'planted->resolved',
  'planted->overdue',
  'advanced->advanced',
  'advanced->resolved',
  'advanced->overdue',
  'overdue->advanced',
  'overdue->resolved',
  'overdue->overdue',
  'resolved->resolved',
])

/**
 * May this write move a foreshadow from `from` to `to`?
 *
 * Written as an explicit allow-list because the rule is a product decision, not a
 * derivation: `overdue` is a mark rather than progress, so leaving it for `advanced`
 * is legal while stepping back to `planted` is not, and `resolved` is terminal.
 */
export function foreshadowTransitionAllowed(from: ForeshadowStatus, to: ForeshadowStatus): boolean {
  return ALLOWED_TRANSITIONS.has(`${from}->${to}`)
}

/**
 * The progress state under an `overdue` mark.
 *
 * `overdue` says "this should have been paid off" and carries no progress of its
 * own, so the state it falls back to is read from the file: an advance record means
 * `advanced`, otherwise `planted`. That fallback is what lets a `status: overdue`
 * that the computation disagrees with still display something truthful.
 */
export function baseStatusOf(row: ForeshadowRow): ForeshadowStatus {
  if (row.status !== 'overdue') return row.status
  return row.advancedAt.length > 0 ? 'advanced' : 'planted'
}

// ---------------------------------------------------------------------------
// Parsing one file
// ---------------------------------------------------------------------------

function statusValue(raw: string | undefined): ForeshadowStatus | undefined {
  const value = (raw ?? '').trim().toLowerCase()
  return (FORESHADOW_STATUSES as readonly string[]).includes(value) ? (value as ForeshadowStatus) : undefined
}

export interface ForeshadowParseResult {
  /** Absent only when the file has no frontmatter at all and no usable name. */
  readonly row?: ForeshadowRow
  readonly issues: ValidationIssue[]
}

/**
 * Parse one `foreshadowing/<slug>.md`.
 *
 * Tolerant on purpose: a hand-written file with no frontmatter is still a foreshadow
 * (titled after its file name), because the alternative — reporting every such file
 * as broken — is noise the author cannot act on. What *is* reported is a `status`
 * value outside the four, which no reader could interpret.
 */
export function parseForeshadowFile(path: string, text: string): ForeshadowParseResult {
  const parsed = parseMarkdown(text)
  const issues: ValidationIssue[] = parsed.issues.map((detail) => ({ code: 'FRONTMATTER_ISSUE', path, detail }))

  const declaredStatus = statusValue(stringField(parsed.data, 'status'))
  const rawStatus = (stringField(parsed.data, 'status') ?? '').trim()
  if (rawStatus !== '' && declaredStatus === undefined) {
    issues.push({
      code: 'FRONTMATTER_ISSUE',
      path,
      detail: `status "${rawStatus}" is not one of ${FORESHADOW_STATUSES.join('/')}`,
    })
  }

  const hasResolved = Object.prototype.hasOwnProperty.call(parsed.data, 'resolved')
  const resolved = hasResolved ? boolField(parsed.data, 'resolved') : undefined

  // `status` wins; the boolean is only a fallback for files written before it existed.
  const status: ForeshadowStatus = declaredStatus ?? (resolved === true ? 'resolved' : 'planted')

  const advancedAt = stringArrayField(parsed.data, 'advancedAt')
  const row: ForeshadowRow = {
    id: stringField(parsed.data, 'id') ?? path,
    path,
    title: stringField(parsed.data, 'title') ?? basename(path, extname(path)),
    status,
    ...(declaredStatus === undefined ? {} : { declaredStatus }),
    ...(resolved === undefined ? {} : { resolved }),
    ...(stringField(parsed.data, 'plantedAt') === undefined ? {} : { plantedAt: stringField(parsed.data, 'plantedAt') }),
    advancedAt,
    ...(stringField(parsed.data, 'dueBy') === undefined ? {} : { dueBy: stringField(parsed.data, 'dueBy') }),
    ...(stringField(parsed.data, 'resolvedChapter') === undefined
      ? {}
      : { resolvedChapter: stringField(parsed.data, 'resolvedChapter') }),
    linkedEntities: stringArrayField(parsed.data, 'linkedEntities'),
  }
  return { row, issues }
}

// ---------------------------------------------------------------------------
// Invariants (data-model §5, I-09 + I-21)
// ---------------------------------------------------------------------------

/**
 * I-09 and I-21 over the parsed rows.
 *
 * Why the transition rules are judged here rather than inside the parser: a rebuild
 * has no history, so the only evidence of an illegal transition is the file
 * contradicting *itself* — `resolved: true` under `status: planted`, an advance
 * position under `status: planted`, `status: advanced` with no advance position at
 * all. Judging that from the row keeps one implementation for both nets (X-4): the
 * rebuild calls `validate()` over the whole scan, the write path over the post-write
 * view filtered to its own candidate.
 */
export function foreshadowValidate(rows: readonly ForeshadowRow[], candidatePath?: string): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const judged = candidatePath === undefined ? rows : rows.filter((row) => row.path === candidatePath)
  for (const row of judged) {
    if (row.resolved === true && row.status !== 'resolved') {
      issues.push({
        code: 'FORESHADOW_TRANSITION_INVALID',
        path: row.path,
        detail: `resolved: true but status is "${row.status}" (I-21: the two fields must agree)`,
      })
    }
    if (row.resolved === false && row.declaredStatus === 'resolved') {
      issues.push({
        code: 'FORESHADOW_TRANSITION_INVALID',
        path: row.path,
        detail: 'resolved: false contradicts status "resolved" (I-21: the two fields must agree)',
      })
    }
    if (row.status === 'planted' && row.advancedAt.length > 0) {
      issues.push({
        code: 'FORESHADOW_TRANSITION_INVALID',
        path: row.path,
        detail: 'status "planted" carries advancedAt (I-21: an advanced setup cannot be un-advanced)',
      })
    }
    if (row.status === 'advanced' && row.advancedAt.length === 0) {
      issues.push({
        code: 'FORESHADOW_TRANSITION_INVALID',
        path: row.path,
        detail: 'status "advanced" without advancedAt (I-21: an advance has a position)',
      })
    }
    if (row.status === 'resolved' && (row.resolvedChapter ?? '').trim() === '') {
      issues.push({
        code: 'FORESHADOW_RESOLVED_WITHOUT_CHAPTER',
        path: row.path,
        detail: 'resolved: true requires resolvedChapter (the chapter that pays the setup off)',
      })
    }
  }
  return issues
}

/** The projection row: `overdue` is never published (it depends on the current chapter). */
export function foreshadowEntity(row: ForeshadowRow): DomainEntityRef {
  return {
    kind: 'foreshadowing',
    id: row.id,
    path: row.path,
    title: row.title,
    status: row.status,
  }
}

// ---------------------------------------------------------------------------
// Chapter positions and the computed `overdue` state (data-model §3.2.2)
// ---------------------------------------------------------------------------

/** One chapter's place in the book: the volume's order, then the volume-local `seq`. */
export interface ChapterPosition {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly volume?: string
  readonly seq: number
  /** `vol-02` → 2; a loose chapter (no volume) → 0, i.e. before every volume. */
  readonly order: number
}

/** The numeric part of a `vol-NN` id; 0 when there is no volume. */
export function volumeOrderOf(volume: string | undefined): number {
  const match = /^vol[-_]?(\d+)/i.exec((volume ?? '').trim())
  return match?.[1] === undefined ? 0 : Number(match[1])
}

/** Earlier first: volume order, then volume-local seq. Never a string comparison. */
export function comparePosition(left: ChapterPosition, right: ChapterPosition): number {
  if (left.order !== right.order) return left.order < right.order ? -1 : 1
  if (left.seq !== right.seq) return left.seq < right.seq ? -1 : 1
  return 0
}

export type ForeshadowDueKind = 'chapter' | 'volume' | 'unknown'

export interface ForeshadowUrgency {
  /** The board's state: `overdue` when computed late, else the progress state. */
  readonly status: ForeshadowStatus
  /** What the file says, echoed so a caller can show the disagreement. */
  readonly declaredStatus: ForeshadowStatus
  readonly overdue: boolean
  /** Due at the chapter/volume being written right now (the last chance, not yet late). */
  readonly dueNow: boolean
  readonly dueKind?: ForeshadowDueKind
}

type DueResolution =
  | { readonly kind: 'chapter'; readonly position: ChapterPosition }
  | { readonly kind: 'volume'; readonly order: number }
  | { readonly kind: 'unknown' }

function resolveDue(dueBy: string | undefined, positions: ReadonlyMap<string, ChapterPosition>): DueResolution | undefined {
  const raw = (dueBy ?? '').trim()
  if (raw === '') return undefined
  if (/^vol[-_]?\d+/i.test(raw)) return { kind: 'volume', order: volumeOrderOf(raw) }
  // A chapter id or a project-relative path: both are accepted, because a hand-written
  // `dueBy` may name the file the author sees in their editor.
  const position = positions.get(raw)
  return position === undefined ? { kind: 'unknown' } : { kind: 'chapter', position }
}

/**
 * Where does this foreshadow stand, as of `current`?
 *
 * Strictly later counts as late: the chapter a setup is due in is "due now", which
 * is the moment to pay it off, not the moment it failed.
 */
export function foreshadowUrgency(
  row: ForeshadowRow,
  current: ChapterPosition | undefined,
  positions: ReadonlyMap<string, ChapterPosition>,
): ForeshadowUrgency {
  const base = baseStatusOf(row)
  const due = resolveDue(row.dueBy, positions)
  const dueKind = due?.kind
  const settled: ForeshadowUrgency = {
    status: base,
    declaredStatus: row.status,
    overdue: false,
    dueNow: false,
    ...(dueKind === undefined ? {} : { dueKind }),
  }
  if (base === 'resolved' || current === undefined || due === undefined) return settled
  if (due.kind === 'volume') {
    const overdue = current.order > due.order
    return { ...settled, overdue, dueNow: current.order === due.order, ...(overdue ? { status: 'overdue' as const } : {}) }
  }
  if (due.kind === 'chapter') {
    const order = comparePosition(current, due.position)
    const overdue = order > 0
    return { ...settled, overdue, dueNow: order === 0, ...(overdue ? { status: 'overdue' as const } : {}) }
  }
  return settled
}

// ---------------------------------------------------------------------------
// The document a write produces
// ---------------------------------------------------------------------------

export interface ForeshadowDocumentFields {
  readonly id: string
  readonly title: string
  readonly status: ForeshadowStatus
  readonly plantedAt?: string
  readonly advancedAt: readonly string[]
  readonly dueBy?: string
  readonly resolvedChapter?: string
  readonly linkedEntities: readonly string[]
}

/**
 * The document a write should produce.
 *
 * A new file is rendered from the fields above; an existing file is **patched**
 * (`patchFrontmatter`), so comments, quote style, key order and every field this
 * domain does not model survive an edit (data-model §3.1).
 *
 * `resolved` is synced **only when the file already has it**: dropping it would make
 * an old file read as "not resolved" again, and adding it everywhere would create a
 * second source of truth for a state the machine field already owns.
 */
export function renderForeshadowDocument(input: {
  readonly text?: string
  readonly fields: ForeshadowDocumentFields
  readonly body?: string
}): string {
  const normalized = input.text === undefined ? undefined : normalizeText(input.text)
  const body = input.body === undefined ? undefined : trimBody(input.body)
  const hasFrontmatter = normalized !== undefined && splitFrontmatter(normalized).hasFrontmatter
  const hasResolvedKey = normalized !== undefined && /^resolved:[ \t]*/mu.test(splitFrontmatter(normalized).head)

  if (normalized === undefined || !hasFrontmatter) {
    return freshDocument(input.fields, body ?? '', hasResolvedKey)
  }

  const entries: Record<string, FrontmatterValue> = {
    id: input.fields.id,
    title: input.fields.title,
    status: input.fields.status,
  }
  if (input.fields.plantedAt !== undefined) entries['plantedAt'] = input.fields.plantedAt
  if (input.fields.dueBy !== undefined) entries['dueBy'] = input.fields.dueBy
  if (input.fields.resolvedChapter !== undefined) entries['resolvedChapter'] = input.fields.resolvedChapter
  // An empty list deletes the key, which is exactly right: "no advance positions"
  // must not be encoded as `advancedAt:` with nothing under it.
  entries['advancedAt'] = [...input.fields.advancedAt]
  entries['linkedEntities'] = [...input.fields.linkedEntities]
  if (hasResolvedKey) entries['resolved'] = rawScalar(input.fields.status === 'resolved' ? 'true' : 'false')

  const patched = patchFrontmatter(normalized, entries).text
  if (body === undefined) return patched
  return `${splitFrontmatter(patched).head}${body === '' ? '' : `${body}\n`}`
}

function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n')
}

function trimBody(body: string): string {
  return body.replace(/^\n+/u, '').replace(/\s+$/u, '')
}

function freshDocument(fields: ForeshadowDocumentFields, body: string, includeResolved: boolean): string {
  const lines = ['---', frontmatterLine('id', fields.id), frontmatterLine('title', fields.title)]
  lines.push(frontmatterLine('status', fields.status))
  if (includeResolved) lines.push(`resolved: ${fields.status === 'resolved' ? 'true' : 'false'}`)
  if (fields.plantedAt !== undefined) lines.push(frontmatterLine('plantedAt', fields.plantedAt))
  if (fields.advancedAt.length > 0) {
    lines.push('advancedAt:', ...fields.advancedAt.map((value) => frontmatterListItem(value)))
  }
  if (fields.dueBy !== undefined) lines.push(frontmatterLine('dueBy', fields.dueBy))
  if (fields.resolvedChapter !== undefined) lines.push(frontmatterLine('resolvedChapter', fields.resolvedChapter))
  if (fields.linkedEntities.length > 0) {
    lines.push('linkedEntities:', ...fields.linkedEntities.map((value) => frontmatterListItem(value)))
  }
  lines.push('---')
  return `${lines.join('\n')}\n${body === '' ? '' : `\n${body}\n`}`
}
