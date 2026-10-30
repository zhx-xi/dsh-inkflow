/**
 * The candidate store's bytes: reading every batch file under
 * `<book>/.inkflow/candidates/`, and the three primitives that write one back —
 * mint an id, stamp a file name, serialise and atomically replace.
 *
 * WHY IT IS A FILE: reading and writing one JSON file shape is a different job from
 * deciding whether a submission may be stored, and different again from the state
 * machine that moves candidates. The submit/status half calls the write primitives
 * this file exports; nothing else may. A malformed file is reported as an issue and
 * skipped, never fatal — one hand-broken JSON must not make the queue unreadable.
 *
 * The parsers here are defensive by design: a stored `willFail`/`duplicate` that
 * does not look like its shape is dropped, not repaired (a half-read advisory
 * warning is worse than none).
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { writeTextAtomic } from './io.js'
import { privateStateDirRelative, privateStateRelative } from './private-state.js'
import { CANDIDATE_ID_PATTERN, CANDIDATE_SCHEMA_VERSION, CANDIDATE_STATUSES, CONFIDENCES, isExtractKind, refuse } from './extract-types.js'
import type {
  CandidateBatch,
  CandidateProposal,
  CandidateRecord,
  CandidateStatus,
  CandidateVerdict,
  Confidence,
  DuplicateMark,
  ExtractError,
} from './extract-types.js'

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

export function batchFileName(root: string): string[] {
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
export function parseDuplicate(value: unknown): DuplicateMark | undefined {
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
export function parseVerdict(value: unknown): CandidateVerdict | undefined {
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

export function mintCandidateId(taken: ReadonlySet<string>): string {
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

export function writeBatch(root: string, file: string, batch: CandidateBatch): { ok: true } | { ok: false; error: ExtractError } {
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

export function readBatchFile(root: string, file: string): CandidateBatch | undefined {
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
