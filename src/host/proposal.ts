/**
 * Revision proposals (#45, roadmap X-26): the store, the decisions, the apply and the
 * rollback.
 *
 * What a proposal is: `.inkflow/proposals/<proposalId>/` holds **one chapter body, cut
 * into line hunks, waiting for the author's verdict**. Three facts follow from that and
 * they are the whole design:
 *
 *   1. **It is a work item, not a derived artefact** ([ADR-0023](../../.agents/adrs/0023-proposal-job-private-placement.md)).
 *      A half-decided proposal cannot be recomputed — the model call that produced it is
 *      gone — so it lives under `.inkflow/` beside the recovery bin and the backup
 *      packages, never under `index/`, which a rebuild empties (ADR-0006 D2).
 *   2. **Nothing reaches a content file until `apply`.** Creating and deciding write
 *      only inside the proposal directory; `apply` is the single write path, and it goes
 *      through the existing chapter writer (`chapters.ts` → `io.ts`: write lock, atomic
 *      replace, style preservation), never around it.
 *   3. **The CAS baseline is taken when the author decides, not when `apply` runs**
 *      (the lesson of [ADR-0021](../../.agents/adrs/ADR-0021-candidate-outcomes.md)): the
 *      decision is recorded against the bytes the author was looking at, so text typed
 *      into the file *after* the decision is never silently overwritten — `apply` answers
 *      `FILE_CHANGED` and leaves the file alone.
 *
 * The plugin calls no model (X-26, ADR-0017): the revised body arrives as a string from
 * the session, and this module only validates, diffs, records decisions and writes.
 *
 * Rollback does not invent a second history: `apply` opens a `replace` package first
 * (`backup.ts`) and `rollback` replays it with `rollbackBackup`, which restores the
 * previous bytes **verbatim** (BOM and CRLF included) after checking that nobody has
 * edited the file since. Byte-for-byte equality is asserted by the tests, not promised
 * by the doc.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { newBackupBody, openBackup, rollbackBackup, sealBackup, stageFile } from './backup.js'
import type { BackupBody, BackupDigest, BackupError } from './backup.js'
import { readCatalog } from './catalog.js'
import type { CatalogChapter, CatalogReadResult } from './catalog.js'
import { writeChapter } from './chapters.js'
import { fingerprintProjectFile } from './file-cas.js'
import { parseMarkdown } from './frontmatter.js'
import { writeJsonAtomic } from './io.js'
import { ensurePrivateStateIgnored, privateStateDirRelative, privateStateRelative } from './private-state.js'
import { applyHunks, diffLines, joinLines, splitLines } from './proposal-diff.js'
import type { HunkKind, LineHunk } from './proposal-diff.js'
import { detectTextStyle } from './text-style.js'
import type { EolStyle } from './text-style.js'

// ---------------------------------------------------------------------------
// File shapes
// ---------------------------------------------------------------------------

/** Shape version of `meta.json` and of one `hunks/<n>.json`; a stranger value is refused. */
export const PROPOSAL_SCHEMA_VERSION = 1

/** `<proposalId>` shape: `pr-` plus eight hex characters, minted here and never by a caller. */
export const PROPOSAL_ID_PREFIX = 'pr-'
const PROPOSAL_ID_PATTERN = /^pr-[0-9a-f]{8}$/

/** The states a proposal can be in. `rolled-back` is reachable only from `applied`. */
export const PROPOSAL_STATUSES = ['open', 'applied', 'rolled-back'] as const
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number]

/** The states one hunk can be in. `pending` is the initial state, not a verdict. */
export const PROPOSAL_HUNK_STATUSES = ['pending', 'accepted', 'rejected'] as const
export type ProposalHunkStatus = (typeof PROPOSAL_HUNK_STATUSES)[number]

/** Whether a value is one of the three hunk states. */
export function isProposalHunkStatus(value: unknown): value is ProposalHunkStatus {
  return typeof value === 'string' && (PROPOSAL_HUNK_STATUSES as readonly string[]).includes(value)
}

/** `hunks/<n>.json` — the subdirectory that holds one file per hunk. */
export const PROPOSAL_HUNKS_DIR = 'hunks'

/** `meta.json` — everything about the proposal except the diff text itself. */
export const PROPOSAL_META_FILE = 'meta.json'

/** One hunk as stored: the diff plus the author's verdict. */
export interface ProposalHunk extends LineHunk {
  /** 1-based, in document order; the address `decide` takes. */
  index: number
  status: ProposalHunkStatus
}

export interface ProposalCounts {
  total: number
  pending: number
  accepted: number
  rejected: number
}

/** A byte fingerprint of one file, as the CAS compares it. */
export interface ProposalDigest {
  bytes: number
  sha256: string
}

/** One row of `meta.hunks`: the index list, without the text (that is in the hunk file). */
export interface ProposalHunkRef {
  index: number
  kind: HunkKind
  baseStart: number
  baseLines: number
  nextLines: number
  file: string
}

/** The base a proposal was written against, recorded once at creation. */
export interface ProposalBase extends ProposalDigest {
  lines: number
  eol: EolStyle
  bom: boolean
}

/** Everything in `meta.json`. */
export interface ProposalMeta {
  schemaVersion: number
  proposalId: string
  chapterId: string
  /** Project-relative chapter path (forward slashes) as it was when the proposal was made. */
  path: string
  title: string
  /** ISO time. A proposal is a work item, so a clock here is allowed (unlike a gate verdict). */
  createdAt: string
  /** Where the revised text came from. The plugin only ever knows what the session told it. */
  source: { kind: 'revised-body'; label: string; note?: string }
  base: ProposalBase
  revised: { lines: number; bytes: number }
  hunks: ProposalHunkRef[]
  counts: ProposalCounts
  status: ProposalStatus
  /**
   * The author's verdict session: recorded the moment they decide, with the chapter's
   * fingerprint **at that moment**. `apply` compares against this, so an edit made after
   * the decision is a refusal rather than a silent overwrite.
   */
  decision: { at: string; baseline: { size: number; mtimeMs: number; sha256: string }; counts: ProposalCounts } | null
  apply: { at: string; backup: string; before: ProposalDigest; after: ProposalDigest; accepted: number[] } | null
  rollback: { at: string; backup: string; verified: boolean; restored: string[] } | null
}

/** One `hunks/<n>.json`. */
export interface ProposalHunkFile {
  schemaVersion: number
  proposalId: string
  index: number
  kind: HunkKind
  baseStart: number
  baseLines: string[]
  nextLines: string[]
  status: ProposalHunkStatus
}

/** A proposal read back: `meta.json` plus every hunk file, in document order. */
export interface ProposalRead {
  dir: string
  metaPath: string
  meta: ProposalMeta
  hunks: ProposalHunk[]
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export interface ProposalError {
  code: string
  message: string
  root?: string
  path?: string
  hint?: string
  /** Present on `FILE_CHANGED`: what the baseline expected and what is on disk. */
  expected?: unknown
  current?: unknown
  changed?: string[]
  nothingWritten?: boolean
  /** Present when a backup package was opened for a write that did not land. */
  backup?: string
}

export type ProposalResult<T> = { ok: true; value: T } | { ok: false; error: ProposalError }

function fail(code: string, message: string, extra: Partial<ProposalError> = {}): { ok: false; error: ProposalError } {
  return { ok: false, error: { code, message, ...extra } }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `.inkflow/proposals` — the inbox root (ADR-0023 D1). */
export function proposalsDirRelative(): string {
  return privateStateDirRelative('proposals')
}

/** `.inkflow/proposals/<proposalId>`. */
export function proposalDirRelative(proposalId: string): string {
  return privateStateRelative('proposals', proposalId)
}

/** `.inkflow/proposals/<proposalId>/meta.json`. */
export function proposalMetaPath(proposalId: string): string {
  return privateStateRelative('proposals', `${proposalId}/${PROPOSAL_META_FILE}`)
}

/** `.inkflow/proposals/<proposalId>/hunks/<n>.json`. */
export function proposalHunkPath(proposalId: string, index: number): string {
  return privateStateRelative('proposals', `${proposalId}/${PROPOSAL_HUNKS_DIR}/${String(index)}.json`)
}

/** Whether a string is a proposal id this build could have minted. */
export function isProposalId(value: unknown): value is string {
  return typeof value === 'string' && PROPOSAL_ID_PATTERN.test(value)
}

function absolute(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'))
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function normalizeRevised(text: string): string {
  const withoutBom = text.startsWith('\uFEFF') ? text.slice(1) : text
  return withoutBom.replace(/\r\n?/g, '\n')
}

/** The one place hunk counts are computed, so a reply cannot disagree with `meta.json`. */
export function countsOf(hunks: readonly { status: ProposalHunkStatus }[]): ProposalCounts {
  const counts: ProposalCounts = { total: hunks.length, pending: 0, accepted: 0, rejected: 0 }
  for (const hunk of hunks) counts[hunk.status] += 1
  return counts
}

function digestOfFingerprint(fingerprint: { size: number; sha256: string }): ProposalDigest {
  return { bytes: fingerprint.size, sha256: fingerprint.sha256 }
}

function allCatalogChapters(catalog: CatalogReadResult): CatalogChapter[] {
  const out: CatalogChapter[] = [...catalog.catalog.looseChapters]
  for (const volume of catalog.volumeCatalogs) out.push(...volume.chapters)
  return out
}

/** `chapters/…md`, no escapes: the same rule `chapters.ts` applies to its `file` input. */
function chapterPathProblem(file: string): string | undefined {
  if (!file.startsWith('chapters/')) return 'a chapter file starts with chapters/'
  if (!file.endsWith('.md')) return 'a chapter file ends with .md'
  if (file.includes('\\')) return 'project-relative paths use / separators'
  if (file.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'a chapter path may not contain empty, "." or ".." segments'
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Read one proposal: `meta.json` and every hunk file it lists.
 *
 * A missing hunk file is `PROPOSAL_INVALID`, never a silent skip: applying a proposal
 * with holes in it would write a body that is neither the base nor the revision.
 */
export function readProposal(projectRoot: string, proposalId: unknown): ProposalResult<ProposalRead> {
  const root = resolve(projectRoot)
  if (!isProposalId(proposalId)) {
    return fail('PROPOSAL_ID_INVALID', `${String(proposalId)} is not a proposal id (pr-xxxxxxxx)`, { root })
  }
  const dir = proposalDirRelative(proposalId)
  const metaPath = proposalMetaPath(proposalId)
  let text: string
  try {
    text = readFileSync(absolute(root, metaPath), 'utf8')
  } catch {
    return fail('PROPOSAL_NOT_FOUND', `no proposal ${proposalId} in this book`, {
      root,
      path: metaPath,
      hint: `list the open proposals with the 提案 tab or GET /inkflow/internal/proposal; they live in ${proposalsDirRelative()}/`,
    })
  }
  const meta = parseMeta(text, root, metaPath)
  if (!meta.ok) return meta

  const hunks: ProposalHunk[] = []
  for (const ref of meta.value.hunks) {
    const hunkPath = proposalHunkPath(proposalId, ref.index)
    let raw: string
    try {
      raw = readFileSync(absolute(root, hunkPath), 'utf8')
    } catch {
      return fail('PROPOSAL_INVALID', `${hunkPath} is missing; the proposal is incomplete and cannot be applied`, {
        root,
        path: hunkPath,
      })
    }
    const hunk = parseHunk(raw, meta.value.proposalId, hunkPath)
    if (!hunk.ok) return hunk
    hunks.push(hunk.value)
  }
  return { ok: true, value: { dir, metaPath, meta: meta.value, hunks } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.every((item) => typeof item === 'string') ? (value as string[]) : undefined
}

function parseCounts(value: unknown): ProposalCounts | undefined {
  if (!isRecord(value)) return undefined
  const numbers = ['total', 'pending', 'accepted', 'rejected'] as const
  const out: ProposalCounts = { total: 0, pending: 0, accepted: 0, rejected: 0 }
  for (const key of numbers) {
    const raw = value[key]
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) return undefined
    out[key] = raw
  }
  return out
}

/** Read `meta.json` defensively: a hand-edited file is a refusal, never a guess. */
function parseMeta(text: string, root: string, path: string): ProposalResult<ProposalMeta> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail('PROPOSAL_INVALID', `${path} is not JSON`, { root, path })
  }
  const invalid = (why: string): { ok: false; error: ProposalError } =>
    fail('PROPOSAL_INVALID', `${path} ${why}`, { root, path })
  if (!isRecord(raw)) return invalid('is not a JSON object')
  if (raw['schemaVersion'] !== PROPOSAL_SCHEMA_VERSION) {
    return fail('PROPOSAL_INVALID', `${path} has schemaVersion ${String(raw['schemaVersion'])}; this build reads ${PROPOSAL_SCHEMA_VERSION}`, { root, path })
  }
  const proposalId = raw['proposalId']
  if (!isProposalId(proposalId)) return invalid('has no usable proposalId')
  const chapterId = raw['chapterId']
  const chapterPath = raw['path']
  if (typeof chapterId !== 'string' || chapterId === '') return invalid('has no chapterId')
  if (typeof chapterPath !== 'string' || chapterPathProblem(chapterPath) !== undefined) return invalid('has no usable chapter path')
  const status = raw['status']
  if (typeof status !== 'string' || !(PROPOSAL_STATUSES as readonly string[]).includes(status)) return invalid('has an unknown status')
  const counts = parseCounts(raw['counts'])
  if (counts === undefined) return invalid('has an unusable counts block')
  const base = raw['base']
  if (!isRecord(base)) return invalid('has no base block')
  const baseBytes = base['bytes']
  const baseSha = base['sha256']
  const baseLines = base['lines']
  const baseEol = base['eol']
  const baseBom = base['bom']
  if (typeof baseBytes !== 'number' || typeof baseSha !== 'string' || baseSha.length !== 64) return invalid('has no usable base digest')
  if (typeof baseLines !== 'number' || (baseEol !== 'lf' && baseEol !== 'crlf') || typeof baseBom !== 'boolean') return invalid('has no usable base style')
  const revised = raw['revised']
  if (!isRecord(revised) || typeof revised['lines'] !== 'number' || typeof revised['bytes'] !== 'number') return invalid('has no usable revised block')
  const source = raw['source']
  if (!isRecord(source) || typeof source['kind'] !== 'string' || typeof source['label'] !== 'string') return invalid('has no usable source block')
  const rawHunks = raw['hunks']
  if (!Array.isArray(rawHunks)) return invalid('has no hunks list')

  const refs: ProposalHunkRef[] = []
  for (const item of rawHunks) {
    if (!isRecord(item)) return invalid('holds a hunk row that is not an object')
    const index = item['index']
    const kind = item['kind']
    const baseStart = item['baseStart']
    const baseLineCount = item['baseLines']
    const nextLineCount = item['nextLines']
    const file = item['file']
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 1) return invalid('holds a hunk row without a usable index')
    if (kind !== 'replace' && kind !== 'insert' && kind !== 'delete') return invalid('holds a hunk row with an unknown kind')
    if (typeof baseStart !== 'number' || baseStart < 0) return invalid('holds a hunk row without a usable baseStart')
    if (typeof baseLineCount !== 'number' || typeof nextLineCount !== 'number') return invalid('holds a hunk row without line counts')
    if (typeof file !== 'string' || file === '') return invalid('holds a hunk row without a file')
    refs.push({ index, kind, baseStart, baseLines: baseLineCount, nextLines: nextLineCount, file })
  }

  const decision = raw['decision']
  const apply = raw['apply']
  const rollback = raw['rollback']
  const meta: ProposalMeta = {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    proposalId,
    chapterId,
    path: chapterPath,
    title: typeof raw['title'] === 'string' ? raw['title'] : chapterPath,
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : '',
    source: {
      kind: 'revised-body',
      label: source['label'],
      ...(typeof source['note'] === 'string' ? { note: source['note'] } : {}),
    },
    base: { bytes: baseBytes, sha256: baseSha, lines: baseLines, eol: baseEol, bom: baseBom },
    revised: { lines: revised['lines'], bytes: revised['bytes'] },
    hunks: refs,
    counts,
    status: status as ProposalStatus,
    decision: isRecord(decision) && isRecord(decision['baseline'])
      ? {
          at: typeof decision['at'] === 'string' ? decision['at'] : '',
          baseline: {
            size: typeof decision['baseline']['size'] === 'number' ? decision['baseline']['size'] : 0,
            mtimeMs: typeof decision['baseline']['mtimeMs'] === 'number' ? decision['baseline']['mtimeMs'] : 0,
            sha256: typeof decision['baseline']['sha256'] === 'string' ? decision['baseline']['sha256'] : '',
          },
          counts: parseCounts(decision['counts']) ?? counts,
        }
      : null,
    apply: isRecord(apply) && typeof apply['backup'] === 'string'
      ? {
          at: typeof apply['at'] === 'string' ? apply['at'] : '',
          backup: apply['backup'],
          before: readDigest(apply['before']) ?? { bytes: 0, sha256: '' },
          after: readDigest(apply['after']) ?? { bytes: 0, sha256: '' },
          accepted: Array.isArray(apply['accepted'])
            ? apply['accepted'].filter((item): item is number => typeof item === 'number')
            : [],
        }
      : null,
    rollback: isRecord(rollback) && typeof rollback['backup'] === 'string'
      ? {
          at: typeof rollback['at'] === 'string' ? rollback['at'] : '',
          backup: rollback['backup'],
          verified: rollback['verified'] === true,
          restored: Array.isArray(rollback['restored'])
            ? rollback['restored'].filter((item): item is string => typeof item === 'string')
            : [],
        }
      : null,
  }
  return { ok: true, value: meta }
}

function readDigest(value: unknown): ProposalDigest | undefined {
  if (!isRecord(value)) return undefined
  const bytes = value['bytes']
  const sha256 = value['sha256']
  if (typeof bytes !== 'number' || typeof sha256 !== 'string') return undefined
  return { bytes, sha256 }
}

function parseHunk(text: string, proposalId: string, path: string): ProposalResult<ProposalHunk> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail('PROPOSAL_INVALID', `${path} is not JSON`, { path })
  }
  const invalid = (why: string): { ok: false; error: ProposalError } =>
    fail('PROPOSAL_INVALID', `${path} ${why}`, { path })
  if (!isRecord(raw)) return invalid('is not a JSON object')
  if (raw['schemaVersion'] !== PROPOSAL_SCHEMA_VERSION) return invalid('has a foreign schemaVersion')
  if (raw['proposalId'] !== proposalId) return invalid('belongs to another proposal')
  const index = raw['index']
  const kind = raw['kind']
  const baseStart = raw['baseStart']
  const baseLines = asStringArray(raw['baseLines'])
  const nextLines = asStringArray(raw['nextLines'])
  const status = raw['status']
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 1) return invalid('has no usable index')
  if (kind !== 'replace' && kind !== 'insert' && kind !== 'delete') return invalid('has an unknown kind')
  if (typeof baseStart !== 'number' || baseStart < 0) return invalid('has no usable baseStart')
  if (baseLines === undefined || nextLines === undefined) return invalid('has no usable line lists')
  if (typeof status !== 'string' || !(PROPOSAL_HUNK_STATUSES as readonly string[]).includes(status)) return invalid('has an unknown status')
  return {
    ok: true,
    value: {
      index,
      kind,
      baseStart,
      baseLines,
      nextLines,
      status: status as ProposalHunkStatus,
    },
  }
}

/** Every proposal in the book, newest first by `createdAt` then id. Unreadable ones are skipped. */
export function listProposals(projectRoot: string): ProposalMeta[] {
  const root = resolve(projectRoot)
  let names: string[]
  try {
    names = readdirSync(absolute(root, proposalsDirRelative()), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
  const out: ProposalMeta[] = []
  for (const name of names) {
    if (!isProposalId(name)) continue
    const read = readProposal(root, name)
    if (read.ok) out.push(read.value.meta)
  }
  out.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1
    return left.proposalId < right.proposalId ? 1 : -1
  })
  return out
}

// ---------------------------------------------------------------------------
// inkflow_proposal_create
// ---------------------------------------------------------------------------

export interface CreateProposalInput {
  chapterId?: string
  file?: string
  /** The whole revised body, as the session model wrote it. Frontmatter is NOT part of it. */
  revisedBody: string
  /** Who produced it. Free text: `session-model`, a skill name, the author's own name. */
  label?: string
  note?: string
  at?: Date
}

export interface CreateProposalOk {
  ok: true
  root: string
  proposalId: string
  dir: string
  chapterId: string
  path: string
  base: ProposalBase
  revised: { lines: number; bytes: number }
  counts: ProposalCounts
  /** The hunks without their text: enough to print "3 hunks, +12 −9" without a second read. */
  hunks: Array<{ index: number; kind: HunkKind; baseStart: number; removed: number; added: number }>
  /** Every write this call performed, so "creating a proposal touches no content file" is checkable. */
  contentFilesWritten: 0
}

/**
 * Cut a revised body into hunks and store the proposal.
 *
 * Reads the chapter, never writes it: the only files this touches are
 * `.inkflow/proposals/<id>/…` (plus the `.inkflow/` ignore line, appended by the first
 * private-state writer as always — ADR-0012).
 */
export function createProposal(projectRoot: string, input: CreateProposalInput): ProposalResult<CreateProposalOk> {
  const root = resolve(projectRoot)
  const at = input.at ?? new Date()

  const revisedRaw = typeof input.revisedBody === 'string' ? input.revisedBody : ''
  if (revisedRaw.trim() === '') {
    return fail('PROPOSAL_BODY_REQUIRED', 'a proposal needs the revised body text', {
      root,
      hint: 'pass the body the model wrote (no frontmatter, no code fence around it)',
    })
  }
  const revisedText = normalizeRevised(revisedRaw)
  // A whole document instead of a body would diff the frontmatter as if it were prose,
  // and the hunks would then be unfixable garbage. `data` being non-empty is the tell:
  // a `---` scene break parses as a block but produces no keys.
  const revisedParsed = parseMarkdown(revisedText)
  if (revisedParsed.hasFrontmatter && Object.keys(revisedParsed.data).length > 0) {
    return fail('PROPOSAL_BODY_REQUIRED', 'the revised text starts with frontmatter; pass the chapter body only', {
      root,
      hint: 'the proposal replaces the body — the frontmatter of the chapter file is never part of a revision',
    })
  }

  const ref = resolveChapterRef(root, input)
  if (!ref.ok) return ref
  const chapter = ref.value
  let raw: string
  try {
    raw = readFileSync(absolute(root, chapter.file), 'utf8')
  } catch {
    return fail('CHAPTER_NOT_FOUND', `${chapter.file} could not be read`, { root, path: chapter.file })
  }
  const fingerprint = fingerprintProjectFile(root, chapter.file)
  if (fingerprint === undefined) {
    return fail('CHAPTER_NOT_FOUND', `${chapter.file} disappeared while the proposal was being made`, { root, path: chapter.file })
  }
  const style = detectTextStyle(raw)
  const baseBody = parseMarkdown(raw).body
  const baseLines = splitLines(baseBody)
  const revisedLines = alignLeadingBlank(baseLines, splitLines(revisedText))
  const hunks = diffLines(baseLines, revisedLines)
  if (hunks.length === 0) {
    return fail('PROPOSAL_EMPTY', 'the revised body is identical to the chapter body; there is nothing to propose', {
      root,
      path: chapter.file,
      hint: 'nothing was written — change something before sending a revision',
    })
  }

  const proposalId = mintProposalId(root)
  const counts: ProposalCounts = { total: hunks.length, pending: hunks.length, accepted: 0, rejected: 0 }
  const refs: ProposalHunkRef[] = hunks.map((hunk, position) => ({
    index: position + 1,
    kind: hunk.kind,
    baseStart: hunk.baseStart,
    baseLines: hunk.baseLines.length,
    nextLines: hunk.nextLines.length,
    file: proposalHunkPath(proposalId, position + 1),
  }))
  const meta: ProposalMeta = {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    proposalId,
    chapterId: chapter.chapterId,
    path: chapter.file,
    title: chapter.title,
    createdAt: at.toISOString(),
    source: {
      kind: 'revised-body',
      label: input.label === undefined || input.label.trim() === '' ? 'session-model' : input.label.trim(),
      ...(input.note === undefined || input.note.trim() === '' ? {} : { note: input.note.trim() }),
    },
    base: { ...digestOfFingerprint(fingerprint), lines: baseLines.length, eol: style.eol, bom: style.bom },
    revised: { lines: revisedLines.length, bytes: Buffer.byteLength(joinLines(revisedLines), 'utf8') },
    hunks: refs,
    counts,
    status: 'open',
    decision: null,
    apply: null,
    rollback: null,
  }

  ensurePrivateStateIgnored(root)
  for (const [position, hunk] of hunks.entries()) {
    const file: ProposalHunkFile = {
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      proposalId,
      index: position + 1,
      kind: hunk.kind,
      baseStart: hunk.baseStart,
      baseLines: [...hunk.baseLines],
      nextLines: [...hunk.nextLines],
      status: 'pending',
    }
    const written = writeJsonAtomic(root, proposalHunkPath(proposalId, position + 1), file)
    if (!written.ok) return fail(written.error.code, `the proposal could not be stored: ${written.error.message}`, { root, path: written.error.path })
  }
  const stored = writeJsonAtomic(root, proposalMetaPath(proposalId), meta)
  if (!stored.ok) return fail(stored.error.code, `the proposal could not be stored: ${stored.error.message}`, { root, path: stored.error.path })

  return {
    ok: true,
    value: {
      ok: true,
      root,
      proposalId,
      dir: proposalDirRelative(proposalId),
      chapterId: chapter.chapterId,
      path: chapter.file,
      base: meta.base,
      revised: meta.revised,
      counts,
      hunks: refs.map((ref, position) => ({
        index: ref.index,
        kind: ref.kind,
        baseStart: ref.baseStart,
        removed: (hunks[position] as LineHunk).baseLines.length,
        added: (hunks[position] as LineHunk).nextLines.length,
      })),
      contentFilesWritten: 0,
    },
  }
}

interface ChapterRef {
  chapterId: string
  file: string
  title: string
}

/** Resolve the chapter a proposal is about. Ids are durable; a file path is exact. */
function resolveChapterRef(
  root: string,
  input: { chapterId?: string; file?: string },
): ProposalResult<ChapterRef> {
  const hasId = typeof input.chapterId === 'string' && input.chapterId.trim() !== ''
  const hasFile = typeof input.file === 'string' && input.file.trim() !== ''
  if (hasId && hasFile) {
    return fail('CHAPTER_SELECTOR_CONFLICT', 'pass either chapterId or file, not both', { root })
  }
  if (!hasId && !hasFile) {
    return fail('CHAPTER_SELECTOR_REQUIRED', 'a chapterId or a file is required to address a chapter', {
      root,
      hint: 'use the chapter id from inkflow_chapter_list / the catalog',
    })
  }
  const chapters = allCatalogChapters(readCatalog(root))
  if (hasFile) {
    const file = (input.file as string).trim().replaceAll('\\', '/').replace(/^\/+/, '')
    const problem = chapterPathProblem(file)
    if (problem !== undefined) return fail('FILE_INVALID', `${file}: ${problem}`, { root, path: file })
    const match = chapters.find((chapter) => chapter.file === file)
    if (match === undefined) return fail('CHAPTER_NOT_FOUND', `no chapter file "${file}"`, { root, path: file })
    return { ok: true, value: { chapterId: match.chapterId, file: match.file, title: match.title } }
  }
  const id = (input.chapterId as string).trim()
  const matches = chapters.filter((chapter) => chapter.chapterId === id)
  const match = matches[0]
  if (match === undefined) {
    return fail('CHAPTER_NOT_FOUND', `no chapter with id "${id}"`, {
      root,
      hint: 'ids come from inkflow_chapter_list / the catalog; a volume directory name is not an id',
    })
  }
  if (matches.length > 1) {
    return fail('CHAPTER_AMBIGUOUS', `id "${id}" is used by ${matches.length} chapters`, {
      root,
      path: match.file,
      hint: `pass file: ${matches.map((chapter) => chapter.file).join(' | ')}`,
    })
  }
  return { ok: true, value: { chapterId: match.chapterId, file: match.file, title: match.title } }
}

/**
 * Align the revision's leading blank lines with the base's.
 *
 * `parseMarkdown().body` starts at the byte after the closing `---`, so a chapter written
 * the way this plugin writes them begins with the one blank separator line. Whether a
 * model's revised text repeats that blank line is an accident of its formatting, not a
 * decision about the prose — and diffing it as a change would put a meaningless
 * "delete an empty line" hunk on every single proposal. The frame belongs to the file;
 * only the body belongs to the revision.
 */
function alignLeadingBlank(base: readonly string[], next: readonly string[]): string[] {
  let lead = 0
  while (lead < base.length && (base[lead] ?? '') === '') lead += 1
  let skip = 0
  while (skip < next.length && (next[skip] ?? '') === '') skip += 1
  const body = next.slice(skip)
  const prefix = new Array<string>(lead).fill('')
  return body.length === 0 ? prefix : [...prefix, ...body]
}

function mintProposalId(root: string): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = `${PROPOSAL_ID_PREFIX}${randomBytes(4).toString('hex')}`
    try {
      readFileSync(absolute(root, proposalMetaPath(candidate)), 'utf8')
    } catch {
      // Nothing there: the id is free. A read is cheaper than an existsSync+race.
      return candidate
    }
  }
  // 16 collisions in a row means the directory is not what it claims to be; a fresh
  // random id would only hide that. `create` reports it instead of looping forever.
  return `${PROPOSAL_ID_PREFIX}${randomBytes(4).toString('hex')}`
}

// ---------------------------------------------------------------------------
// inkflow_proposal_decide
// ---------------------------------------------------------------------------

export interface HunkDecision {
  index: number
  /** `accepted` | `rejected` | `pending`; validated by `decideProposal`, so a raw string is allowed here. */
  status: string
}

export interface DecideProposalInput {
  proposalId: string
  decisions: readonly HunkDecision[]
  at?: Date
}

export interface DecideProposalOk {
  ok: true
  root: string
  proposalId: string
  counts: ProposalCounts
  /** The baseline `apply` will compare against, taken now (ADR-0021: the decision moment). */
  decision: { at: string; baseline: { size: number; mtimeMs: number; sha256: string } }
  /** Hunks that are still undecided — `apply` refuses while this is non-empty. */
  pending: number[]
  /** Set when the chapter changed since the proposal was made: the caller must regenerate. */
  contentFilesWritten: 0
}

/**
 * Record the author's verdict on one or more hunks.
 *
 * The chapter's fingerprint is taken **here** and stored in `meta.decision.baseline`.
 * If the chapter no longer matches the base the proposal was cut from, the decision is
 * refused (`FILE_CHANGED`) with nothing written: hunks address line ranges of a
 * specific text, so accepting them against different text would apply the right words
 * at the wrong place.
 */
export function decideProposal(projectRoot: string, input: DecideProposalInput): ProposalResult<DecideProposalOk> {
  const root = resolve(projectRoot)
  const at = input.at ?? new Date()
  const read = readProposal(root, input.proposalId)
  if (!read.ok) return read
  const { meta, hunks } = read.value
  if (meta.status !== 'open') {
    return fail('PROPOSAL_STATUS', `proposal ${meta.proposalId} is already ${meta.status}`, {
      root,
      path: read.value.metaPath,
      hint: meta.status === 'applied' ? 'roll it back before deciding anything else' : 'make a new proposal for further changes',
    })
  }
  const decisions = Array.isArray(input.decisions) ? input.decisions : []
  if (decisions.length === 0) {
    return fail('PROPOSAL_DECISIONS_REQUIRED', 'decisions must list at least one hunk', {
      root,
      hint: 'pass [{ "index": 1, "status": "accepted" }]; status is accepted, rejected or pending',
    })
  }
  const byIndex = new Map(hunks.map((hunk) => [hunk.index, hunk]))
  for (const decision of decisions) {
    const index = typeof decision.index === 'number' ? decision.index : Number.NaN
    if (!byIndex.has(index)) {
      return fail('PROPOSAL_HUNK_NOT_FOUND', `proposal ${meta.proposalId} has no hunk ${String(decision.index)}`, {
        root,
        hint: `hunks are numbered 1…${String(hunks.length)}`,
      })
    }
    if (!isProposalHunkStatus(decision.status)) {
      return fail('PROPOSAL_HUNK_STATUS_INVALID', `"${decision.status}" is not a hunk status`, {
        root,
        hint: 'status must be accepted, rejected or pending',
      })
    }
  }

  // The decision-time baseline. Read once; a mismatch means the hunks no longer address
  // the text the author is looking at, so nothing is recorded.
  const current = fingerprintProjectFile(root, meta.path)
  if (current === undefined) {
    return fail('CHAPTER_NOT_FOUND', `${meta.path} is gone; the proposal cannot be decided against it`, { root, path: meta.path })
  }
  if (current.sha256 !== meta.base.sha256) {
    return fail(
      'FILE_CHANGED',
      `${meta.path} changed on disk since this proposal was made (sha256 ${current.sha256.slice(0, 8)}… ≠ base ${meta.base.sha256.slice(0, 8)}…)`,
      {
        root,
        path: meta.path,
        nothingWritten: true,
        expected: { sha256: meta.base.sha256, size: meta.base.bytes },
        current: { sha256: current.sha256, size: current.size },
        changed: ['sha256'],
        hint: 'the hunks address line ranges of the old text; forget this proposal and create a new one from the current file',
      },
    )
  }

  for (const decision of decisions) {
    const hunk = byIndex.get(decision.index) as ProposalHunk
    if (hunk.status === decision.status) continue
    hunk.status = decision.status
    const file: ProposalHunkFile = {
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      proposalId: meta.proposalId,
      index: hunk.index,
      kind: hunk.kind,
      baseStart: hunk.baseStart,
      baseLines: [...hunk.baseLines],
      nextLines: [...hunk.nextLines],
      status: hunk.status,
    }
    const written = writeJsonAtomic(root, proposalHunkPath(meta.proposalId, hunk.index), file)
    if (!written.ok) {
      return fail(written.error.code, `the decision could not be stored: ${written.error.message}`, { root, path: written.error.path })
    }
  }

  const counts = countsOf(hunks)
  const baseline = { size: current.size, mtimeMs: current.mtimeMs, sha256: current.sha256 }
  const next: ProposalMeta = { ...meta, counts, decision: { at: at.toISOString(), baseline, counts } }
  const stored = writeJsonAtomic(root, read.value.metaPath, next)
  if (!stored.ok) {
    return fail(stored.error.code, `the decision could not be stored: ${stored.error.message}`, { root, path: stored.error.path })
  }
  return {
    ok: true,
    value: {
      ok: true,
      root,
      proposalId: meta.proposalId,
      counts,
      decision: { at: next.decision?.at ?? at.toISOString(), baseline },
      pending: hunks.filter((hunk) => hunk.status === 'pending').map((hunk) => hunk.index),
      contentFilesWritten: 0,
    },
  }
}

// ---------------------------------------------------------------------------
// inkflow_proposal_apply
// ---------------------------------------------------------------------------

export interface ApplyProposalInput {
  proposalId: string
  confirm?: boolean
  at?: Date
}

export interface ApplyProposalOk {
  ok: true
  root: string
  proposalId: string
  chapterId: string
  path: string
  /** The backup package a rollback replays. */
  backup: string
  before: ProposalDigest
  after: ProposalDigest
  applied: number[]
  /** Hunks the author rejected: their text did not enter the file. */
  skipped: number[]
  bytes: number
  catalogRebuilt: boolean
  indexRebuilt: boolean
}

/**
 * Write the accepted hunks into the chapter — the proposal's only write path.
 *
 * The order is the point:
 *   1. refuse unless `confirm: true`, every hunk is decided, and at least one is accepted;
 *   2. compare the file against the **decision-time** baseline (`FILE_CHANGED`, zero writes);
 *   3. open a `replace` backup package and copy the current bytes into it;
 *   4. write through `writeChapter` (write lock, atomic replace, the file's own EOL/BOM),
 *      which re-checks the same baseline under the lock;
 *   5. seal the package with the post-write digest and record it in `meta.apply`.
 *
 * Step 4 is the reason this module has no writer of its own: a second implementation of
 * "replace a chapter body" would be a second answer to "what does a chapter file look
 * like", and the catalog/index rebuild would be forgotten in one of the two.
 */
export async function applyProposal(projectRoot: string, input: ApplyProposalInput): Promise<ProposalResult<ApplyProposalOk>> {
  const root = resolve(projectRoot)
  const at = input.at ?? new Date()
  if (input.confirm !== true) {
    return fail('CONFIRM_REQUIRED', 'applying a proposal rewrites a chapter, so it needs confirm: true', {
      root,
      hint: 'show the author the accepted hunks first, then call again with confirm: true',
    })
  }
  const read = readProposal(root, input.proposalId)
  if (!read.ok) return read
  const { meta, hunks } = read.value
  if (meta.status !== 'open') {
    return fail('PROPOSAL_STATUS', `proposal ${meta.proposalId} is already ${meta.status}`, {
      root,
      path: read.value.metaPath,
      hint: 'a proposal is applied once; make a new one for further changes',
    })
  }
  const counts = countsOf(hunks)
  const baseline = meta.decision?.baseline
  if (baseline === undefined) {
    return fail('PROPOSAL_UNDECIDED', 'this proposal has no recorded decision, so it has no baseline to write against', {
      root,
      path: read.value.metaPath,
      nothingWritten: true,
      hint: 'call inkflow_proposal_decide first: the baseline is taken when the author decides, not when the write runs',
    })
  }
  if (counts.pending > 0) {
    return fail('PROPOSAL_PENDING_HUNKS', `${String(counts.pending)} of ${String(counts.total)} hunk(s) are still undecided`, {
      root,
      path: read.value.metaPath,
      nothingWritten: true,
      hint: `decide every hunk first (undecided: ${hunks.filter((hunk) => hunk.status === 'pending').map((hunk) => hunk.index).join(', ')}); an undecided hunk is not a "no"`,
    })
  }
  if (counts.accepted === 0) {
    return fail('PROPOSAL_NOTHING_ACCEPTED', 'every hunk was rejected, so there is nothing to apply', {
      root,
      path: read.value.metaPath,
      nothingWritten: true,
      hint: 'accept at least one hunk, or leave the chapter as it is',
    })
  }
  const current = fingerprintProjectFile(root, meta.path)
  if (current === undefined) {
    return fail('CHAPTER_NOT_FOUND', `${meta.path} is gone; the accepted text has nowhere to land`, { root, path: meta.path })
  }
  if (current.sha256 !== baseline.sha256) {
    return fail('FILE_CHANGED', `${meta.path} was edited after you decided (sha256 ${current.sha256.slice(0, 8)}… ≠ decision ${baseline.sha256.slice(0, 8)}…)`, {
      root,
      path: meta.path,
      nothingWritten: true,
      expected: { sha256: baseline.sha256, size: baseline.size },
      current: { sha256: current.sha256, size: current.size },
      changed: ['sha256'],
      hint: 'your edit was kept: re-read the chapter and make a new proposal instead of overwriting it',
    })
  }

  const baseBody = readBody(root, meta.path)
  if (baseBody === undefined) {
    return fail('CHAPTER_NOT_FOUND', `${meta.path} could not be read, so the accepted hunks have nothing to land on`, {
      root,
      path: meta.path,
      nothingWritten: true,
    })
  }
  const nextBody = joinLines(applyHunks(splitLines(baseBody), hunks, (hunk) => hunk.status === 'accepted'))

  const opened = openBackup(root, 'replace', at)
  if (!opened.ok) return { ok: false, error: { ...opened.error } }
  const staged = stageFile(root, opened.value, meta.path)
  if (!staged.ok) return { ok: false, error: { ...staged.error } }
  const before = staged.value
  if (before === undefined) {
    return fail('CHAPTER_NOT_FOUND', `${meta.path} vanished before it could be backed up`, { root, path: meta.path, nothingWritten: true })
  }
  const packageBody: BackupBody = newBackupBody()
  packageBody.steps.push(`stage ${meta.path}`)
  packageBody.files.push({ path: meta.path, change: 'modified', before })
  // Sealed before the write (ADR-0012 #1): a crash mid-apply must leave a readable
  // journal whose `sealed: false` says exactly that.
  const journal = sealBackup(root, opened.value, 'replace', packageBody, false, at)
  if (!journal.ok) return { ok: false, error: { ...journal.error } }

  const written = await writeChapter(root, {
    chapterId: meta.chapterId,
    body: nextBody,
    expected: { sha256: baseline.sha256, size: baseline.size },
  })
  if (!written.ok) {
    packageBody.steps.push('write refused')
    sealBackup(root, opened.value, 'replace', packageBody, false, at)
    const error = written.error
    return {
      ok: false,
      error: {
        code: error.code,
        message: `the chapter was not written: ${error.message}`,
        ...(error.root === undefined ? { root } : { root: error.root }),
        ...(error.path === undefined ? { path: meta.path } : { path: error.path }),
        ...(error.hint === undefined ? {} : { hint: error.hint }),
        nothingWritten: true,
        backup: opened.value.dir,
      },
    }
  }

  const afterFingerprint = fingerprintProjectFile(root, meta.path)
  const after: ProposalDigest = afterFingerprint === undefined
    ? { bytes: 0, sha256: '' }
    : digestOfFingerprint(afterFingerprint)
  const entry = packageBody.files[0]
  if (entry !== undefined) entry.after = after
  packageBody.steps.push(`write ${meta.path} (${String(after.bytes)} bytes)`)
  const sealed = sealBackup(root, opened.value, 'replace', packageBody, true, at)
  if (!sealed.ok) return { ok: false, error: { ...sealed.error } }

  const applied = hunks.filter((hunk) => hunk.status === 'accepted').map((hunk) => hunk.index)
  const skipped = hunks.filter((hunk) => hunk.status === 'rejected').map((hunk) => hunk.index)
  const nextMeta: ProposalMeta = {
    ...meta,
    status: 'applied',
    apply: { at: at.toISOString(), backup: opened.value.dir, before: { bytes: before.bytes, sha256: before.sha256 }, after, accepted: applied },
  }
  const stored = writeJsonAtomic(root, read.value.metaPath, nextMeta)
  if (!stored.ok) {
    // The chapter is written; only the bookkeeping failed. Say so instead of claiming
    // the apply did not happen — the backup package is on disk either way.
    return fail(stored.error.code, `the chapter was written but the proposal record could not be updated: ${stored.error.message}`, {
      root,
      path: stored.error.path,
      hint: `roll back with the backup package ${opened.value.dir} if the file must go back`,
    })
  }

  const result = written
  return {
    ok: true,
    value: {
      ok: true,
      root,
      proposalId: meta.proposalId,
      chapterId: result.chapter.chapterId,
      path: meta.path,
      backup: opened.value.dir,
      before: { bytes: before.bytes, sha256: before.sha256 },
      after,
      applied,
      skipped,
      bytes: after.bytes,
      catalogRebuilt: result.catalogRebuilt,
      indexRebuilt: result.indexRebuilt,
    },
  }
}

/** The chapter body as it is on disk right now; `undefined` when the file cannot be read. */
function readBody(root: string, relativePath: string): string | undefined {
  try {
    return parseMarkdown(readFileSync(absolute(root, relativePath), 'utf8')).body
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// inkflow_proposal_rollback
// ---------------------------------------------------------------------------

export interface RollbackProposalInput {
  proposalId: string
  confirm?: boolean
  at?: Date
}

export interface RollbackProposalOk {
  ok: true
  root: string
  proposalId: string
  backup: string
  restored: string[]
  /** True when the chapter's bytes are byte-for-byte what they were before the apply. */
  verified: boolean
  before: ProposalDigest
  bytes: number
}

/**
 * Undo an applied proposal by replaying its backup package.
 *
 * `rollbackBackup` is the one implementation of "put these bytes back": it verifies the
 * current digest first, writes the copy **verbatim** (BOM and CRLF included) and then
 * checks the result — which is why a rollback that reports `verified: true` really is
 * byte-identical, not "the same text". A chapter edited after the apply is a
 * `BACKUP_CONFLICT` with the file left alone: the author's newer text wins over a
 * snapshot.
 */
export function rollbackProposal(projectRoot: string, input: RollbackProposalInput): ProposalResult<RollbackProposalOk> {
  const root = resolve(projectRoot)
  const at = input.at ?? new Date()
  if (input.confirm !== true) {
    return fail('CONFIRM_REQUIRED', 'rolling a proposal back rewrites a chapter, so it needs confirm: true', { root })
  }
  const read = readProposal(root, input.proposalId)
  if (!read.ok) return read
  const { meta } = read.value
  if (meta.status !== 'applied' || meta.apply === null) {
    return fail('PROPOSAL_STATUS', `proposal ${meta.proposalId} is ${meta.status}, so there is nothing to roll back`, {
      root,
      path: read.value.metaPath,
      nothingWritten: true,
      hint: 'rollback undoes one apply; an open proposal has written nothing',
    })
  }
  const undone = rollbackBackup(root, meta.apply.backup, at)
  if (!undone.ok) {
    const error: BackupError = undone.error
    return fail(error.code, error.message, {
      ...(error.root === undefined ? { root } : { root: error.root }),
      ...(error.path === undefined ? { path: error.path } : { path: error.path }),
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    })
  }

  const after = fingerprintProjectFile(root, meta.path)
  const verified = after !== undefined && after.sha256 === meta.apply.before.sha256
  const nextMeta: ProposalMeta = {
    ...meta,
    status: 'rolled-back',
    rollback: { at: at.toISOString(), backup: meta.apply.backup, verified, restored: [...undone.restored] },
  }
  const stored = writeJsonAtomic(root, read.value.metaPath, nextMeta)
  if (!stored.ok) {
    return fail(stored.error.code, `the chapter was restored but the proposal record could not be updated: ${stored.error.message}`, {
      root,
      path: stored.error.path,
    })
  }
  return {
    ok: true,
    value: {
      ok: true,
      root,
      proposalId: meta.proposalId,
      backup: meta.apply.backup,
      restored: [...undone.restored],
      verified,
      before: meta.apply.before,
      bytes: after?.size ?? 0,
    },
  }
}
