/**
 * Revision proposals (roadmap X-26): the store, the decisions, the apply and the
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

import { readCatalog } from './catalog.js'
import type { CatalogChapter, CatalogReadResult } from './catalog.js'
import { ensurePrivateStateIgnored, privateStateDirRelative, privateStateRelative } from './private-state.js'
import type { HunkKind, LineHunk } from './proposal-diff.js'
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

export function fail(code: string, message: string, extra: Partial<ProposalError> = {}): { ok: false; error: ProposalError } {
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

export function absolute(root: string, relativePath: string): string {
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

// The action half (`proposal-actions.ts`) reuses these: they are pure (path assembly,
// text normalisation, catalog lookup), so exporting them keeps ONE copy of each instead
// of a second, drifting implementation next to the writers.
export { allCatalogChapters, chapterPathProblem, digestOfFingerprint, normalizeRevised }
export type { HunkKind, LineHunk } from './proposal-diff.js'
