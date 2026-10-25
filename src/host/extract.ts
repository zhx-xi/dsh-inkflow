/**
 * The extraction queue (ADR-0017, issue #38): candidate batches under
 * `<book>/.inkflow/candidates/`, and nothing else.
 *
 * What this module is responsible for, and what it deliberately is not:
 *
 *   * **It stores candidates.** A batch is one `<stamp>-<kind>.json` file
 *     (`{schemaVersion, submittedAt, source:{chapters[]}, proposals[]}`), one kind
 *     per file because the file name carries the kind (D3). The store is append-ish:
 *     a new submission adds a file, a corrected proposal rewrites its own line, and
 *     nothing is deleted except by an explicit `purge` of already-processed entries.
 *   * **It mints the id** (`ex-<8 hex>`, D2). A model never invents one; echoing back
 *     an id it read from `inkflow_extract_list` is how an update names its target.
 *   * **It judges the shape before the batch lands**: `evidence` must be
 *     `path#L<n>` or a chapter id that exists *now*, and `fields` must use the
 *     `data-model.md` §3 dictionary of its kind (no second vocabulary for
 *     extraction, no unknown keys — a candidate is machine-written, so a key this
 *     module does not know is a bug in the producer, not an author's addition).
 *   * **It never writes a content file.** Turning a candidate into an entity is
 *     `extract-accept.ts`'s single job (D4/D5). A guard test pins that direction:
 *     no other module may import the candidate readers/writers below.
 *
 * Why the private state directory rather than `index/`: D3 — the index is a cache
 * that is rebuilt at will, and a rebuild must not destroy an hour of extraction.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { readCatalog } from './catalog.js'
import { removeProjectFile, writeTextAtomic } from './io.js'
import { ensurePrivateStateIgnored, privateStateDirRelative, privateStateRelative } from './private-state.js'

/** Bumped only when the file shape changes; a past batch stays readable. */
export const CANDIDATE_SCHEMA_VERSION = 1

/** The six entity kinds extraction covers (ADR-0017 D2). */
export const EXTRACT_KINDS = ['character', 'foreshadowing', 'outline', 'relation', 'timeline', 'world'] as const
export type ExtractKind = (typeof EXTRACT_KINDS)[number]

/** `proposed` is the only state that can be accepted, rejected or updated. */
export const CANDIDATE_STATUSES = ['proposed', 'accepted', 'rejected'] as const
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number]

/** Ordering hint only — it never drives an automatic decision (D2). */
export const CONFIDENCES = ['high', 'medium', 'low'] as const
export type Confidence = (typeof CONFIDENCES)[number]

/** A candidate id is minted here and nowhere else: `ex-` + 8 lowercase hex. */
export const CANDIDATE_ID_PATTERN = /^ex-[0-9a-f]{8}$/

/**
 * One candidate, exactly as it sits on disk.
 *
 * `kind` is repeated inside the proposal even though the file name carries it: a
 * candidate may be read out of its batch by `inkflow_extract_list`, and an answer
 * that had to re-derive the kind from a file name would break the moment somebody
 * renames a file by hand.
 */
export interface CandidateProposal {
  readonly candidateId: string
  readonly kind: ExtractKind
  readonly fields: Readonly<Record<string, unknown>>
  /** `path#L<n>` or a chapter id. Never empty (D2). */
  readonly evidence: string
  readonly rationale: string
  readonly confidence: Confidence
  readonly status: CandidateStatus
  /**
   * What `accept` would refuse, judged at submit time by the very same function (#175).
   *
   * Absent means "no conflict seen"; it is a **warning, not a gate** — the author may
   * still accept (or fix the candidate first), and the queue must keep working after a
   * book changes underneath it, so this is recomputed on every submit rather than
   * trusted forever.
   */
  readonly willFail?: CandidateVerdict
  /**
   * The entity this candidate would replace, when the same identity already exists with
   * **different** content (#178).
   *
   * A candidate whose content is identical is never stored — there is nothing to review.
   * This marker is what turns the row into a question ("已存在，但内容不一致，是否覆盖？")
   * instead of an automatic write: `accept` refuses without `overwrite: true`, and the
   * digest is the CAS baseline that stops a late edit from being clobbered.
   */
  readonly duplicate?: DuplicateMark
}

/** Same identity, other content: the row the author has to decide about (#178). */
export interface DuplicateMark {
  /** Always `different` — identical candidates are dropped at submit time. */
  readonly state: 'different'
  /** The file that already holds this identity. */
  readonly path: string
  /** sha256 of that file when the verdict was made. */
  readonly digest?: string
  /** Which of the candidate's fields differ, so the row can say what would change. */
  readonly changedFields: readonly string[]
}

/** A refusal in the shape the accept path reports, so the two can be compared (D…). */
export interface CandidateVerdict {
  readonly code: string
  readonly message: string
  readonly path?: string
}

/** One submission: the batch file's whole content. */
export interface CandidateBatch {
  readonly schemaVersion: number
  readonly submittedAt: string
  readonly source: { readonly chapters: readonly string[] }
  readonly proposals: readonly CandidateProposal[]
}

/** A proposal plus where it was found, which is what every caller needs. */
export interface CandidateRecord {
  /** Batch file name, project-relative to `.inkflow/candidates/`. */
  readonly file: string
  readonly submittedAt: string
  readonly proposal: CandidateProposal
}

// ---------------------------------------------------------------------------
// The field dictionary (`data-model.md` §3, per kind)
// ---------------------------------------------------------------------------

type FieldType = 'string' | 'stringList' | 'integer' | 'boolean' | 'states' | 'plotPoints'

/**
 * The keys a candidate of each kind may set, and what they must be.
 *
 * This is the §3 dictionary, narrowed to what the accept path can actually write:
 * `id` is absent on purpose (an extracted entity is new, so the plugin mints its
 * id — a model-supplied id could hijack an existing entity), and so are the fields
 * a domain's own renderer does not write yet (`place`/`calendar` on a timeline
 * event, `notes` on a foreshadow, the read-compat `resolved` flag). Accepting them
 * would silently drop them on the way to the file, which is worse than refusing.
 */
const FIELD_TYPES: Readonly<Record<ExtractKind, Readonly<Record<string, FieldType>>>> = {
  character: {
    name: 'string',
    aliases: 'stringList',
    group: 'string',
    role: 'string',
    pov: 'string',
    firstAppearance: 'integer',
    voice: 'stringList',
    states: 'states',
    body: 'string',
  },
  world: {
    title: 'string',
    category: 'string',
    parent: 'string',
    keywords: 'stringList',
    always: 'boolean',
    priority: 'integer',
    body: 'string',
  },
  outline: {
    kind: 'string',
    title: 'string',
    parent: 'string',
    order: 'integer',
    plotPoints: 'plotPoints',
    body: 'string',
  },
  timeline: {
    title: 'string',
    worldTime: 'string',
    narrativeOrder: 'integer',
    chapterId: 'string',
    participants: 'stringList',
    status: 'string',
    body: 'string',
  },
  foreshadowing: {
    title: 'string',
    status: 'string',
    plantedAt: 'string',
    advancedAt: 'stringList',
    dueBy: 'string',
    resolvedChapter: 'string',
    linkedEntities: 'stringList',
    body: 'string',
  },
  relation: {
    source: 'string',
    target: 'string',
    kind: 'string',
    title: 'string',
    dir: 'string',
    since: 'string',
    until: 'string',
    chapter: 'string',
    body: 'string',
  },
}

/** Keys without which the accept path could not address the entity at all. */
const REQUIRED_KEYS: Readonly<Record<ExtractKind, readonly string[]>> = {
  character: ['name'],
  world: ['title'],
  // `kind` is required: an outline node's level (overall / volume / chapter) is a
  // structural decision, and guessing `chapter` would quietly build the wrong tree.
  outline: ['kind', 'title'],
  timeline: ['title'],
  foreshadowing: ['title'],
  relation: ['source', 'target'],
}

/** Enumerated values, where §3 fixes them. */
const FIELD_ENUMS: Readonly<Record<ExtractKind, Readonly<Record<string, readonly string[]>>>> = {
  character: {},
  world: {},
  outline: { kind: ['overall', 'volume', 'chapter'] },
  timeline: { status: ['confirmed', 'unconfirmed'] },
  foreshadowing: { status: ['planted', 'advanced', 'resolved', 'overdue'] },
  relation: { kind: ['character', 'knowledge'], dir: ['directed', 'undirected'] },
}

/** The field names a caller may use for one kind — exported for the tools' help text. */
export function candidateFieldNames(kind: ExtractKind): readonly string[] {
  return Object.keys(FIELD_TYPES[kind])
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export type ExtractCode =
  | 'CANDIDATE_KIND_INVALID'
  | 'CANDIDATE_FIELD_UNKNOWN'
  | 'CANDIDATE_FIELD_INVALID'
  | 'CANDIDATE_FIELD_REQUIRED'
  | 'CANDIDATE_ID_INVALID'
  | 'CANDIDATE_NOT_FOUND'
  | 'CANDIDATE_ALREADY_PROCESSED'
  | 'CANDIDATE_KIND_MISMATCH'
  | 'CANDIDATE_NOT_PROCESSED'
  | 'CANDIDATE_STORE_UNREADABLE'
  | 'EVIDENCE_REQUIRED'
  | 'EVIDENCE_INVALID'
  | 'EVIDENCE_TARGET_MISSING'

/** One refusal, in the shape every tool answers with. */
export interface ExtractError {
  readonly code: ExtractCode
  readonly message: string
  /** The offending field or evidence string, when there is one. */
  readonly field?: string
  readonly path?: string
  readonly hint?: string
}

function refuse(code: ExtractCode, message: string, extra: { field?: string; path?: string; hint?: string } = {}): ExtractError {
  return { code, message, ...extra }
}

export function isExtractKind(value: unknown): value is ExtractKind {
  return typeof value === 'string' && (EXTRACT_KINDS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Field and evidence judgement
// ---------------------------------------------------------------------------

export type FieldCheck = { ok: true; fields: Record<string, unknown> } | { ok: false; error: ExtractError }

function asStringList(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const single = value.trim()
    return single === '' ? [] : [single]
  }
  if (!Array.isArray(value)) return undefined
  if (!value.every((item) => typeof item === 'string')) return undefined
  return value.map((item) => item.trim()).filter((item) => item !== '')
}

const BLOCK_ITEM_BREAK = /[\r\n]/u

/**
 * Judge one candidate's `fields` against its kind's dictionary.
 *
 * Two refusals matter beyond "wrong type" (both are D2's "the model submits a
 * shape, the plugin owns the shape"):
 *
 *   * an **unknown key** is refused rather than kept, because a kept key would be
 *     written nowhere and the author would read a candidate that silently lost a
 *     field. A candidate is machine-written: a key this module does not know is a
 *     producer bug, and saying so is more useful than preserving it.
 *   * a value that **cannot round-trip through one frontmatter line** (a newline in
 *     an alias, a `,`/`[`/`]`/space inside a timeline participant id) is refused
 *     here instead of at the writer, which would turn it into `IO_FAILED` after the
 *     write lock was already taken.
 */
export function checkCandidateFields(kind: ExtractKind, raw: unknown): FieldCheck {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', 'fields must be a JSON object', { field: 'fields' }) }
  }
  const input = raw as Record<string, unknown>
  const types = FIELD_TYPES[kind]
  const fields: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(input)) {
    const type = types[key]
    if (type === undefined) {
      return {
        ok: false,
        error: refuse('CANDIDATE_FIELD_UNKNOWN', `"${key}" is not a ${kind} field`, {
          field: key,
          hint: `known fields: ${Object.keys(types).join(', ')}`,
        }),
      }
    }
    if (value === undefined || value === null) continue

    if (type === 'string') {
      if (typeof value !== 'string') {
        return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', `${key} must be a string`, { field: key }) }
      }
      const trimmed = value.trim()
      if (trimmed === '') continue
      if (BLOCK_ITEM_BREAK.test(trimmed) && key !== 'body') {
        return {
          ok: false,
          error: refuse('CANDIDATE_FIELD_INVALID', `${key} must be a single line`, { field: key }),
        }
      }
      const allowed = FIELD_ENUMS[kind][key]
      if (allowed !== undefined && !allowed.includes(trimmed)) {
        return {
          ok: false,
          error: refuse('CANDIDATE_FIELD_INVALID', `${key} must be one of ${allowed.join(' / ')}`, { field: key }),
        }
      }
      fields[key] = trimmed
      continue
    }

    if (type === 'stringList' || type === 'plotPoints') {
      const list = asStringList(value)
      if (list === undefined) {
        return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', `${key} must be a list of strings`, { field: key }) }
      }
      const broken = type === 'plotPoints' ? list.find((item) => BLOCK_ITEM_BREAK.test(item)) : list.find((item) => BLOCK_ITEM_BREAK.test(item))
      if (broken !== undefined) {
        return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', `${key} items must be one line each`, { field: key }) }
      }
      // A participant is stored space-joined, so an id carrying a space, a comma or
      // a bracket reads back as two ids (data-model §3.4).
      if (key === 'participants') {
        const bad = list.find((item) => /[\s,[\]]/u.test(item))
        if (bad !== undefined) {
          return {
            ok: false,
            error: refuse('CANDIDATE_FIELD_INVALID', `participant "${bad}" contains a space, comma or bracket`, { field: key }),
          }
        }
      }
      fields[key] = list
      continue
    }

    if (type === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', `${key} must be an integer`, { field: key }) }
      }
      fields[key] = value
      continue
    }

    if (type === 'boolean') {
      if (typeof value !== 'boolean') {
        return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', `${key} must be a boolean`, { field: key }) }
      }
      fields[key] = value
      continue
    }

    // `states`: `[{chapter, status}]`, the same shape `inkflow_character_upsert` takes.
    if (!Array.isArray(value)) {
      return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', 'states must be a list of {chapter, status}', { field: key }) }
    }
    const states: Array<{ chapter: number; status: string }> = []
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', 'every state needs {chapter, status}', { field: key }) }
      }
      const record = entry as Record<string, unknown>
      const chapter = record['chapter']
      const status = typeof record['status'] === 'string' ? record['status'].trim() : ''
      if (typeof chapter !== 'number' || !Number.isInteger(chapter) || chapter < 1 || status === '') {
        return {
          ok: false,
          error: refuse('CANDIDATE_FIELD_INVALID', 'every state needs a positive integer chapter and a non-empty status', {
            field: key,
          }),
        }
      }
      if (BLOCK_ITEM_BREAK.test(status)) {
        return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', 'a state status must be a single line', { field: key }) }
      }
      if (states.some((state) => state.chapter === chapter)) {
        return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', `states repeats chapter ${chapter}`, { field: key }) }
      }
      states.push({ chapter, status })
    }
    states.sort((left, right) => left.chapter - right.chapter)
    fields[key] = states
  }

  for (const key of REQUIRED_KEYS[kind]) {
    const value = fields[key]
    if (value === undefined || value === '') {
      return { ok: false, error: refuse('CANDIDATE_FIELD_REQUIRED', `a ${kind} candidate needs "${key}"`, { field: key }) }
    }
  }
  return { ok: true, fields }
}

/** `chapters/vol-01/0001-a.md#L12` — the line anchor form evidence takes. */
const EVIDENCE_LINE = /^([^#]+)#L(\d+)$/u
/** Anything with `#L` in it that is not the form above is a malformed anchor. */
const EVIDENCE_LIKE = /#L/u

function portableRelativePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').trim()
  if (normalized === '' || normalized.startsWith('/')) return false
  if (/^[A-Za-z]:/u.test(normalized)) return false
  return !normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
}

function countLines(text: string): number {
  if (text === '') return 0
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
  return trimmed === '' ? 1 : trimmed.split('\n').length
}

/**
 * Judge one `evidence` string: `path#L<n>` or a chapter id (D2 — "no evidence, no
 * candidate").
 *
 * The target is resolved **now**, at submission: a file must exist and have that
 * line, and a chapter id must be in the catalog. Judging it here is what makes the
 * refusal useful — the model still has the text it was reading in front of it —
 * and it is also the only moment at which "this evidence points at nothing" is
 * certainly a mistake rather than a later deletion.
 */
export function checkEvidence(root: string, raw: unknown): { ok: true; evidence: string } | { ok: false; error: ExtractError } {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {
      ok: false,
      error: refuse('EVIDENCE_REQUIRED', 'every candidate needs evidence: "path#L<line>" or a chapter id', {
        field: 'evidence',
      }),
    }
  }
  const evidence = raw.trim()
  if (EVIDENCE_LIKE.test(evidence)) {
    const match = EVIDENCE_LINE.exec(evidence)
    if (match === null) {
      return {
        ok: false,
        error: refuse('EVIDENCE_INVALID', `"${evidence}" is not a line anchor: use path#L<line>`, { field: 'evidence' }),
      }
    }
    const path = (match[1] ?? '').trim()
    const line = Number(match[2] ?? '')
    if (!portableRelativePath(path) || !Number.isInteger(line) || line < 1) {
      return {
        ok: false,
        error: refuse('EVIDENCE_INVALID', `"${evidence}" is not a line anchor: use path#L<line> (line ≥ 1)`, {
          field: 'evidence',
        }),
      }
    }
    const absolute = join(root, path)
    if (!existsSync(absolute)) {
      return {
        ok: false,
        error: refuse('EVIDENCE_TARGET_MISSING', `${path} does not exist in this book`, { field: 'evidence', path }),
      }
    }
    let lines = 0
    try {
      lines = countLines(readFileSync(absolute, 'utf8').replace(/^\uFEFF/u, ''))
    } catch {
      return {
        ok: false,
        error: refuse('EVIDENCE_TARGET_MISSING', `${path} cannot be read`, { field: 'evidence', path }),
      }
    }
    if (line > lines) {
      return {
        ok: false,
        error: refuse('EVIDENCE_TARGET_MISSING', `${path} has ${String(lines)} lines; line ${String(line)} does not exist`, {
          field: 'evidence',
          path,
        }),
      }
    }
    return { ok: true, evidence: `${path}#L${String(line)}` }
  }

  // A chapter id: the catalog is the projection of the chapter files, so this needs
  // no index build and no other kind of id can be mistaken for a chapter.
  const catalog = readCatalog(root)
  const chapters = [...catalog.catalog.looseChapters, ...catalog.volumeCatalogs.flatMap((entry) => entry.chapters)]
  const hit = chapters.find((chapter) => chapter.chapterId === evidence)
  if (hit === undefined) {
    return {
      ok: false,
      error: refuse('EVIDENCE_TARGET_MISSING', `no chapter has the id "${evidence}"`, {
        field: 'evidence',
        hint: 'pass "path#L<line>" for a chapter file, or a chapter id listed by inkflow_chapter_list',
      }),
    }
  }
  return { ok: true, evidence }
}

// ---------------------------------------------------------------------------
// Reading the queue
// ---------------------------------------------------------------------------

export interface CandidateStore {
  readonly records: readonly CandidateRecord[]
  /** Files that could not be read as a batch (reported, never fatal). */
  readonly issues: readonly { file: string; detail: string }[]
}

/** `.inkflow/candidates`, absolute. */
export function candidateDir(root: string): string {
  return join(root, privateStateDirRelative('candidates'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function batchFileName(root: string): string[] {
  const dir = candidateDir(root)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function parseProposal(value: unknown): CandidateProposal | undefined {
  if (!isRecord(value)) return undefined
  const candidateId = typeof value['candidateId'] === 'string' ? value['candidateId'] : ''
  const kind = value['kind']
  const status = value['status']
  const confidence = value['confidence']
  if (!CANDIDATE_ID_PATTERN.test(candidateId) || !isExtractKind(kind)) return undefined
  if (!(CANDIDATE_STATUSES as readonly unknown[]).includes(status)) return undefined
  if (!(CONFIDENCES as readonly unknown[]).includes(confidence)) return undefined
  const fields = isRecord(value['fields']) ? value['fields'] : {}
  const willFail = parseVerdict(value['willFail'])
  const duplicate = parseDuplicate(value['duplicate'])
  return {
    candidateId,
    kind,
    fields,
    evidence: typeof value['evidence'] === 'string' ? value['evidence'] : '',
    rationale: typeof value['rationale'] === 'string' ? value['rationale'] : '',
    confidence: confidence as Confidence,
    status: status as CandidateStatus,
    ...(willFail === undefined ? {} : { willFail }),
    ...(duplicate === undefined ? {} : { duplicate }),
  }
}

/**
 * A stored `duplicate` mark, sanitized. Only `state: 'different'` is accepted: an
 * `identical` mark would mean "this candidate is nothing new", and such a candidate is
 * never written, so a file carrying one is malformed — it is dropped, not repaired.
 */
function parseDuplicate(value: unknown): DuplicateMark | undefined {
  if (!isRecord(value)) return undefined
  if (value['state'] !== 'different') return undefined
  const path = value['path']
  if (typeof path !== 'string' || path.trim() === '') return undefined
  const digest = value['digest']
  const changed = value['changedFields']
  return {
    state: 'different',
    path: path.trim(),
    ...(typeof digest === 'string' && digest.trim() !== '' ? { digest: digest.trim() } : {}),
    changedFields: Array.isArray(changed) ? changed.filter((item): item is string => typeof item === 'string') : [],
  }
}

/**
 * A stored `willFail`, sanitized. Anything that does not look like
 * `{code, message, path?}` is dropped rather than repaired: the field is advisory, and a
 * half-read warning would be worse than none (it drives a greyed-out button).
 */
function parseVerdict(value: unknown): CandidateVerdict | undefined {
  if (!isRecord(value)) return undefined
  const code = value['code']
  const message = value['message']
  if (typeof code !== 'string' || code.trim() === '') return undefined
  if (typeof message !== 'string' || message.trim() === '') return undefined
  const path = value['path']
  return typeof path === 'string' && path.trim() !== ''
    ? { code: code.trim(), message: message.trim(), path: path.trim() }
    : { code: code.trim(), message: message.trim() }
}

/**
 * Read every batch, oldest submission first.
 *
 * A malformed file is reported in `issues` and skipped: one hand-broken JSON file
 * must not make the whole queue unreadable, which would leave the author unable to
 * accept the candidates beside it.
 */
export function readCandidateStore(root: string): CandidateStore {
  const records: CandidateRecord[] = []
  const issues: { file: string; detail: string }[] = []
  for (const file of batchFileName(root)) {
    let text: string
    try {
      text = readFileSync(join(candidateDir(root), file), 'utf8')
    } catch (cause) {
      issues.push({ file, detail: `cannot read: ${String(cause)}` })
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text.replace(/^\uFEFF/u, ''))
    } catch (cause) {
      issues.push({ file, detail: `not JSON: ${String(cause)}` })
      continue
    }
    if (!isRecord(parsed) || !Array.isArray(parsed['proposals'])) {
      issues.push({ file, detail: 'not a candidate batch: {schemaVersion, submittedAt, source, proposals[]} expected' })
      continue
    }
    const submittedAt = typeof parsed['submittedAt'] === 'string' ? parsed['submittedAt'] : ''
    for (const raw of parsed['proposals']) {
      const proposal = parseProposal(raw)
      if (proposal === undefined) {
        issues.push({ file, detail: 'a proposal is malformed; it is skipped' })
        continue
      }
      records.push({ file, submittedAt, proposal })
    }
  }
  records.sort((left, right) => (left.submittedAt === right.submittedAt ? 0 : left.submittedAt < right.submittedAt ? -1 : 1))
  return { records, issues }
}

// ---------------------------------------------------------------------------
// Writing the queue
// ---------------------------------------------------------------------------

/** `20261024T181043123Z` — sortable, second-and-millisecond precise, no locale. */
export function candidateStamp(at: Date = new Date()): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return (
    `${String(at.getUTCFullYear())}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}${pad(at.getUTCMilliseconds(), 3)}Z`
  )
}

function mintCandidateId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = `ex-${randomBytes(4).toString('hex')}`
    if (!taken.has(id)) return id
  }
}

function serializeBatch(batch: CandidateBatch): string {
  const proposals = batch.proposals.map((proposal) => ({
    candidateId: proposal.candidateId,
    kind: proposal.kind,
    fields: proposal.fields,
    evidence: proposal.evidence,
    rationale: proposal.rationale,
    confidence: proposal.confidence,
    status: proposal.status,
    // Written only when present: a clean candidate's file stays byte-identical to what
    // 0.4.0 wrote, and an older plugin reading the queue sees the fields it knows.
    ...(proposal.willFail === undefined ? {} : { willFail: proposal.willFail }),
    ...(proposal.duplicate === undefined ? {} : { duplicate: proposal.duplicate }),
  }))
  const text = JSON.stringify(
    { schemaVersion: batch.schemaVersion, submittedAt: batch.submittedAt, source: { chapters: [...batch.source.chapters] }, proposals },
    null,
    2,
  )
  return `${text}\n`
}

function writeBatch(root: string, file: string, batch: CandidateBatch): { ok: true } | { ok: false; error: ExtractError } {
  const written = writeTextAtomic(root, privateStateRelative('candidates', file), serializeBatch(batch))
  if (!written.ok) {
    return {
      ok: false,
      error: refuse('CANDIDATE_STORE_UNREADABLE', `cannot write .inkflow/candidates/${file}: ${written.error.message}`, {
        path: `.inkflow/candidates/${file}`,
      }),
    }
  }
  return { ok: true }
}

function readBatchFile(root: string, file: string): CandidateBatch | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(candidateDir(root), file), 'utf8').replace(/^\uFEFF/u, ''))
    if (!isRecord(parsed) || !Array.isArray(parsed['proposals'])) return undefined
    const proposals: CandidateProposal[] = []
    for (const raw of parsed['proposals']) {
      const proposal = parseProposal(raw)
      if (proposal !== undefined) proposals.push(proposal)
    }
    return {
      schemaVersion: typeof parsed['schemaVersion'] === 'number' ? parsed['schemaVersion'] : CANDIDATE_SCHEMA_VERSION,
      submittedAt: typeof parsed['submittedAt'] === 'string' ? parsed['submittedAt'] : '',
      source: {
        chapters: Array.isArray(parsed['source'])
          ? []
          : isRecord(parsed['source']) && Array.isArray(parsed['source']['chapters'])
            ? parsed['source']['chapters'].filter((value): value is string => typeof value === 'string')
            : [],
      },
      proposals,
    }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

export interface ProposeProposalInput {
  /** Echo of an id the caller read back — the only way to *update* a candidate. */
  readonly candidateId?: string
  readonly fields: unknown
  readonly evidence: unknown
  readonly rationale?: unknown
  readonly confidence?: unknown
  /**
   * What the accept path would refuse, worked out by the caller (#175).
   *
   * The queue must not know how an entity is judged — that is the domain seam's job — so
   * `inkflow_extract_propose` runs `judgeCandidate()` and hands the answer here. Anything
   * malformed is dropped by `parseVerdict`, exactly as a hand-edited file would be.
   */
  readonly willFail?: unknown
  /** The duplicate verdict from `judgeCandidate()`; only `different` reaches the queue. */
  readonly duplicate?: unknown
}

export interface ProposeInput {
  readonly kind: ExtractKind
  /** The chapters this batch was read from; documentation for the reviewer. */
  readonly chapters?: readonly string[]
  readonly proposals: readonly ProposeProposalInput[]
}

export interface ProposeResult {
  /** Batch file this call landed in (the first one, when it also updated others). */
  readonly file: string
  readonly submittedAt: string
  /** Newly minted ids, in submission order. */
  readonly created: readonly CandidateProposal[]
  /** Proposals whose fields/evidence changed in place, same id. */
  readonly updated: readonly CandidateProposal[]
  /** Everything this call wrote, in submission order. */
  readonly proposals: readonly CandidateProposal[]
  /** Batch files an update rewrote (empty for a pure create). */
  readonly updatedFiles: readonly string[]
}

/**
 * Submit one batch, or update candidates already in it.
 *
 * Everything is judged **before** the first byte is written, so a batch with one
 * bad evidence string lands nothing. Updates keep the id and the count (an author
 * re-reading the same sentence refines a candidate rather than duplicating it), and
 * a candidate that was already accepted or rejected cannot be updated — the decision
 * is history, and rewriting it would make the store disagree with the files.
 */
export function proposeCandidates(root: string, input: ProposeInput): { ok: true; value: ProposeResult } | { ok: false; error: ExtractError } {
  const store = readCandidateStore(root)
  const byId = new Map(store.records.map((record) => [record.proposal.candidateId, record]))
  const taken = new Set(byId.keys())
  const chapters = (input.chapters ?? []).map((chapter) => chapter.trim()).filter((chapter) => chapter !== '')

  const prepared: { proposal: CandidateProposal; file?: string }[] = []
  for (const proposal of input.proposals) {
    const fields = checkCandidateFields(input.kind, proposal.fields)
    if (!fields.ok) return { ok: false, error: fields.error }
    const evidence = checkEvidence(root, proposal.evidence)
    if (!evidence.ok) return { ok: false, error: evidence.error }

    const confidenceRaw = proposal.confidence
    let confidence: Confidence = 'medium'
    if (confidenceRaw !== undefined) {
      if (typeof confidenceRaw !== 'string' || !(CONFIDENCES as readonly string[]).includes(confidenceRaw)) {
        return {
          ok: false,
          error: refuse('CANDIDATE_FIELD_INVALID', 'confidence must be one of high / medium / low', { field: 'confidence' }),
        }
      }
      confidence = confidenceRaw as Confidence
    }

    let candidateId: string
    if (proposal.candidateId !== undefined) {
      if (typeof proposal.candidateId !== 'string' || !CANDIDATE_ID_PATTERN.test(proposal.candidateId)) {
        return {
          ok: false,
          error: refuse('CANDIDATE_ID_INVALID', `"${String(proposal.candidateId)}" is not a candidate id (ex-<8 hex>)`, {
            field: 'candidateId',
          }),
        }
      }
      const existing = byId.get(proposal.candidateId)
      if (existing === undefined) {
        return {
          ok: false,
          error: refuse('CANDIDATE_NOT_FOUND', `no candidate has the id ${proposal.candidateId}`, { field: 'candidateId' }),
        }
      }
      if (existing.proposal.kind !== input.kind) {
        return {
          ok: false,
          error: refuse(
            'CANDIDATE_KIND_MISMATCH',
            `${proposal.candidateId} is a ${existing.proposal.kind} candidate; this batch is ${input.kind}`,
            { field: 'candidateId' },
          ),
        }
      }
      if (existing.proposal.status !== 'proposed') {
        return {
          ok: false,
          error: refuse(
            'CANDIDATE_ALREADY_PROCESSED',
            `${proposal.candidateId} was already ${existing.proposal.status}; submit a new candidate instead`,
            { field: 'candidateId' },
          ),
        }
      }
      candidateId = proposal.candidateId
    } else {
      candidateId = mintCandidateId(taken)
      taken.add(candidateId)
    }

    prepared.push({
      proposal: {
        candidateId,
        kind: input.kind,
        fields: fields.fields,
        evidence: evidence.evidence,
        rationale: typeof proposal.rationale === 'string' ? proposal.rationale.trim() : '',
        confidence,
        status: 'proposed',
        ...(() => {
          const verdict = parseVerdict(proposal.willFail)
          return verdict === undefined ? {} : { willFail: verdict }
        })(),
        ...(() => {
          const mark = parseDuplicate(proposal.duplicate)
          return mark === undefined ? {} : { duplicate: mark }
        })(),
      },
      ...(byId.get(candidateId) === undefined ? {} : { file: byId.get(candidateId)?.file ?? '' }),
    })
  }

  // The batch file: an update rewrites the file its candidate lives in; a new batch
  // gets `<stamp>-<kind>.json`, suffixed when two batches land in the same millisecond.
  const created = prepared.filter((entry) => entry.file === undefined).map((entry) => entry.proposal)
  const updated = prepared.filter((entry) => entry.file !== undefined).map((entry) => entry.proposal)
  const updatesByFile = new Map<string, CandidateProposal[]>()
  for (const entry of prepared) {
    if (entry.file === undefined) continue
    const list = updatesByFile.get(entry.file) ?? []
    list.push(entry.proposal)
    updatesByFile.set(entry.file, list)
  }

  for (const [file, proposals] of updatesByFile) {
    const batch = readBatchFile(root, file)
    if (batch === undefined) {
      return { ok: false, error: refuse('CANDIDATE_STORE_UNREADABLE', `cannot read .inkflow/candidates/${file}`, { path: file }) }
    }
    const next = new Map(proposals.map((proposal) => [proposal.candidateId, proposal]))
    const merged: CandidateProposal[] = batch.proposals.map((proposal) => next.get(proposal.candidateId) ?? proposal)
    const written = writeBatch(root, file, { ...batch, proposals: merged })
    if (!written.ok) return { ok: false, error: written.error }
  }

  let file = updated.length > 0 && created.length === 0 ? [...updatesByFile.keys()][0] ?? '' : ''
  let submittedAt = file === '' ? '' : readBatchFile(root, file)?.submittedAt ?? ''
  if (created.length > 0) {
    const stamp = candidateStamp()
    submittedAt = new Date().toISOString()
    const base = `${stamp}-${input.kind}`
    let name = `${base}.json`
    const existingFiles = batchFileName(root)
    for (let suffix = 2; existingFiles.includes(name); suffix += 1) name = `${base}-${String(suffix)}.json`
    const batch: CandidateBatch = {
      schemaVersion: CANDIDATE_SCHEMA_VERSION,
      submittedAt,
      source: { chapters },
      proposals: created,
    }
    const written = writeBatch(root, name, batch)
    if (!written.ok) return { ok: false, error: written.error }
    file = name
    // `.gitignore` gains `.inkflow/` the first time the directory is used (ADR-0012
    // #3). A read-only `.gitignore` must not cost the author a batch that is already
    // on disk, so the outcome is not part of the answer.
    ensurePrivateStateIgnored(root)
  }

  return {
    ok: true,
    value: { file, submittedAt, created, updated, proposals: [...created, ...updated], updatedFiles: [...updatesByFile.keys()] },
  }
}

// ---------------------------------------------------------------------------
// Status changes and purge
// ---------------------------------------------------------------------------

export interface CandidateRef {
  /** Batch file the candidate was read from. */
  readonly file: string
  readonly candidateId: string
}

/** One status change, or the refusal that stopped it. */
export type StatusOutcome = { ok: true; candidateId: string; status: CandidateStatus } | { ok: false; candidateId: string; error: ExtractError }

/**
 * Move candidates to `accepted` / `rejected`.
 *
 * This writes **only** the batch JSONs: a status is the queue's own state and has
 * no business touching a content directory (D4 — reject means zero content writes).
 * Callers pass the refs they already resolved, so an id that appears twice in the
 * store cannot be moved by accident.
 */
export function setCandidateStatuses(root: string, refs: readonly CandidateRef[], status: CandidateStatus, allowedFrom: readonly CandidateStatus[]): StatusOutcome[] {
  const outcomes: StatusOutcome[] = []
  const byFile = new Map<string, { candidateId: string }[]>()
  for (const ref of refs) {
    const list = byFile.get(ref.file) ?? []
    list.push({ candidateId: ref.candidateId })
    byFile.set(ref.file, list)
  }

  for (const [file, wanted] of byFile) {
    const batch = readBatchFile(root, file)
    if (batch === undefined) {
      for (const entry of wanted) {
        outcomes.push({
          ok: false,
          candidateId: entry.candidateId,
          error: refuse('CANDIDATE_STORE_UNREADABLE', `cannot read .inkflow/candidates/${file}`, { path: file }),
        })
      }
      continue
    }
    const moving = new Set<string>()
    for (const entry of wanted) {
      const proposal = batch.proposals.find((candidate) => candidate.candidateId === entry.candidateId)
      if (proposal === undefined) {
        outcomes.push({
          ok: false,
          candidateId: entry.candidateId,
          error: refuse('CANDIDATE_NOT_FOUND', `no candidate has the id ${entry.candidateId}`),
        })
        continue
      }
      if (!allowedFrom.includes(proposal.status)) {
        outcomes.push({
          ok: false,
          candidateId: entry.candidateId,
          error: refuse('CANDIDATE_ALREADY_PROCESSED', `${entry.candidateId} is already ${proposal.status}`, {
            path: file,
          }),
        })
        continue
      }
      moving.add(entry.candidateId)
    }
    if (moving.size === 0) continue
    const merged = batch.proposals.map((proposal) =>
      moving.has(proposal.candidateId) ? { ...proposal, status } : proposal,
    )
    const written = writeBatch(root, file, { ...batch, proposals: merged })
    for (const candidateId of moving) {
      outcomes.push(
        written.ok
          ? { ok: true, candidateId, status }
          : { ok: false, candidateId, error: written.error },
      )
    }
  }
  return outcomes
}

export interface PurgeOutcome {
  readonly candidateId: string
  readonly file: string
}

/**
 * Delete processed candidates from the queue.
 *
 * `proposed` candidates are refused: purge cleans up after a decision, and a
 * candidate nobody has judged yet is exactly the thing that must not disappear
 * because somebody clicked the wrong button.
 */
export function purgeCandidates(
  root: string,
  refs: readonly CandidateRef[],
): { ok: true; purged: readonly PurgeOutcome[] } | { ok: false; error: ExtractError } {
  const byFile = new Map<string, Set<string>>()
  for (const ref of refs) {
    const set = byFile.get(ref.file) ?? new Set<string>()
    set.add(ref.candidateId)
    byFile.set(ref.file, set)
  }
  const purged: PurgeOutcome[] = []
  for (const [file, wanted] of byFile) {
    const batch = readBatchFile(root, file)
    if (batch === undefined) {
      return { ok: false, error: refuse('CANDIDATE_STORE_UNREADABLE', `cannot read .inkflow/candidates/${file}`, { path: file }) }
    }
    for (const candidateId of wanted) {
      const proposal = batch.proposals.find((candidate) => candidate.candidateId === candidateId)
      if (proposal === undefined) {
        return { ok: false, error: refuse('CANDIDATE_NOT_FOUND', `no candidate has the id ${candidateId}`, { path: file }) }
      }
      if (proposal.status === 'proposed') {
        return {
          ok: false,
          error: refuse(
            'CANDIDATE_NOT_PROCESSED',
            `${candidateId} is still proposed; accept or reject it before purging`,
            { path: file },
          ),
        }
      }
    }
    const kept = batch.proposals.filter((proposal) => !wanted.has(proposal.candidateId))
    if (kept.length === 0) {
      const removed = removeProjectFile(root, privateStateRelative('candidates', file))
      if (!removed.ok) {
        return {
          ok: false,
          error: refuse('CANDIDATE_STORE_UNREADABLE', `cannot delete .inkflow/candidates/${file}: ${removed.error.message}`, {
            path: file,
          }),
        }
      }
    } else {
      const written = writeBatch(root, file, { ...batch, proposals: kept })
      if (!written.ok) return { ok: false, error: written.error }
    }
    for (const candidateId of wanted) purged.push({ candidateId, file })
  }
  return { ok: true, purged }
}

