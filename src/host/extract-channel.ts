/**
 * The candidate queue's half of the private channel (X-20): one read, three actions.
 *
 * Scope: `GET /inkflow/internal/candidates` plus `POST /candidates/accept`,
 * `/candidates/reject` and `/candidates/purge`. Everything about *what* a candidate
 * means lives in `extract.ts` / `extract-accept.ts`; this file only turns a request into
 * one of those calls and an HTTP status vocabulary, exactly like `audit-channel.ts`.
 *
 * Three request rules, stated once here so the route table stays declarative:
 *
 *   * **the read route writes nothing.** It does not call `ensureIndex` — the queue is
 *     plain JSON on disk, so the panel can always show it, even for a book whose index is
 *     missing. A read that rebuilt a cache would make "look at my candidates" a write.
 *   * **accept and purge need `confirm: true`** — one writes entity files, the other
 *     deletes candidates. `false`/absent is `CONFIRM_REQUIRED` (400) with zero writes.
 *     Reject needs no confirmation: it only changes a status and writes no content file.
 *   * **evidence travels parsed.** The panel gets `evidence` (the raw string, shown as
 *     written) and `locator` (the structured form), so a click never re-parses a string
 *     and the two can never disagree about which chapter was meant.
 *
 * Why a separate module from `extract.ts`: that file is the store and knows nothing about
 * HTTP; `internal.ts` re-exports these so `routes.ts` keeps one entry point.
 */

import { ensureIndex } from './index-freshness.js'
import { acceptCandidates } from './extract-accept.js'
import {
  CANDIDATE_STATUSES,
  EXTRACT_KINDS,
  purgeCandidates,
  readCandidateStore,
  setCandidateStatuses,
} from './extract.js'
import type { ExtractKind } from './extract.js'

type JsonRecord = Record<string, unknown>

/** What the projection needs from the resolved channel target. */
export interface CandidateSource {
  sessionId: string
  root: string
}

export interface CandidateReply {
  status: number
  body: JsonRecord
}

/** HTTP status per refusal; anything unlisted answers 400 and keeps the domain code. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  CONFIRM_REQUIRED: 400,
  EXTRACT_CONFIRM_REQUIRED: 400,
  CANDIDATE_NOT_FOUND: 404,
  CANDIDATE_ALREADY_PROCESSED: 409,
  CANDIDATE_NOT_PROCESSED: 409,
  CANDIDATE_KIND_INVALID: 400,
  CANDIDATE_FIELD_INVALID: 400,
  CANDIDATE_FIELD_REQUIRED: 400,
  CANDIDATE_FIELD_UNKNOWN: 400,
  CANDIDATE_ID_INVALID: 400,
  CANDIDATE_KIND_MISMATCH: 409,
  CANDIDATE_STORE_UNREADABLE: 500,
  EVIDENCE_REQUIRED: 400,
  EVIDENCE_INVALID: 400,
  EVIDENCE_TARGET_MISSING: 404,
  PROJECT_BUSY: 409,
  PATH_NOT_WRITABLE: 409,
  IO_FAILED: 409,
}

/** The body fields each action may carry (`sessionId` is always allowed). */
export const CANDIDATES_ACCEPT_BODY_FIELDS = ['candidateIds', 'confirm', 'overwrite'] as const
export const CANDIDATES_REJECT_BODY_FIELDS = ['candidateIds', 'reason'] as const
export const CANDIDATES_PURGE_BODY_FIELDS = ['candidateIds', 'confirm'] as const

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** `path#L<n>` → `{kind: 'path', path, line}`; anything else is a chapter id. */
function evidenceLocatorWire(evidence: string): JsonRecord {
  const match = /^([^#]+)#L(\d+)$/u.exec(evidence)
  if (match === null) return { kind: 'chapter', chapterId: evidence }
  return { kind: 'path', path: (match[1] ?? '').trim(), line: Number(match[2] ?? '') }
}

function refused(status: number, code: string, extra: JsonRecord = {}): CandidateReply {
  return { status, body: { ok: false, error: { code, ...extra } } }
}

function readIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  return ids.length === 0 ? undefined : ids
}

function readLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return DEFAULT_LIMIT
  return Math.min(value, MAX_LIMIT)
}

function readOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return 0
  return value
}

/**
 * `GET /candidates`: the queue, newest batch last, with counts over the whole queue.
 *
 * The counts are over everything the filters matched, not over the page — a page of
 * five accepted candidates beside "0 accepted" would be a lie the panel cannot detect.
 * `proposedTotal` is there for the tab badge: "3 waiting" is the number the author
 * actually needs, and it must not depend on the current filter.
 */
export function buildCandidates(
  source: CandidateSource,
  version: string,
  query: { kind?: string; status?: string; offset?: string | number; limit?: string | number } = {},
): CandidateReply {
  const kind = typeof query.kind === 'string' && query.kind !== '' ? query.kind : undefined
  if (kind !== undefined && !(EXTRACT_KINDS as readonly string[]).includes(kind)) {
    return refused(400, 'CANDIDATE_KIND_INVALID', { message: `unknown kind "${kind}"`, hint: `kinds: ${EXTRACT_KINDS.join(', ')}` })
  }
  const status = typeof query.status === 'string' && query.status !== '' ? query.status : undefined
  if (status !== undefined && !(CANDIDATE_STATUSES as readonly string[]).includes(status)) {
    return refused(400, 'CANDIDATE_STATUS_INVALID', {
      message: `unknown status "${status}"`,
      hint: `statuses: ${CANDIDATE_STATUSES.join(', ')}`,
    })
  }
  const numeric = (value: string | number | undefined): number | undefined => {
    if (typeof value === 'number') return value
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : undefined
    }
    return undefined
  }
  const offset = readOffset(numeric(query.offset))
  const limit = readLimit(numeric(query.limit))

  const store = readCandidateStore(source.root)
  const byStatus: Record<string, number> = { proposed: 0, accepted: 0, rejected: 0 }
  const byKind: Record<string, number> = {}
  for (const record of store.records) {
    byStatus[record.proposal.status] = (byStatus[record.proposal.status] ?? 0) + 1
    byKind[record.proposal.kind] = (byKind[record.proposal.kind] ?? 0) + 1
  }
  const matched = store.records.filter(
    (record) =>
      (kind === undefined || record.proposal.kind === kind) && (status === undefined || record.proposal.status === status),
  )
  const page = matched.slice(offset, offset + limit)
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: source.root,
        total: matched.length,
        offset,
        limit,
        truncated: offset + page.length < matched.length,
        counts: { byStatus, byKind, proposedTotal: byStatus['proposed'] ?? 0, total: store.records.length },
        kinds: [...EXTRACT_KINDS],
        statuses: [...CANDIDATE_STATUSES],
        ...(store.issues.length === 0 ? {} : { issues: store.issues.map((issue) => ({ ...issue })) }),
        items: page.map((record) => ({
          candidateId: record.proposal.candidateId,
          kind: record.proposal.kind,
          fields: record.proposal.fields,
          evidence: record.proposal.evidence,
          locator: evidenceLocatorWire(record.proposal.evidence),
          rationale: record.proposal.rationale,
          confidence: record.proposal.confidence,
          status: record.proposal.status,
          file: record.file,
          submittedAt: record.submittedAt,
          // The panel shows this as a badge and keeps the row out of a batch.
          ...(record.proposal.willFail === undefined ? {} : { willFail: { ...record.proposal.willFail } }),
          // Same identity, different content — the row asks about overwriting.
          ...(record.proposal.duplicate === undefined ? {} : { duplicate: { ...record.proposal.duplicate } }),
        })),
      },
    },
  }
}

/**
 * `POST /candidates/accept`: entity files through the seam, then the index.
 *
 * The index refresh is reported, never fatal: the files are the truth and a failed
 * rebuild is a cache problem (the next tool call rebuilds it).
 */
export async function acceptViaChannel(source: CandidateSource, version: string, body: JsonRecord): Promise<CandidateReply> {
  const confirm = body['confirm']
  if (confirm !== undefined && typeof confirm !== 'boolean') {
    return refused(400, 'invalid-field', { field: 'confirm', hint: 'send confirm: true (or omit it, which is a refusal)' })
  }
  if (confirm !== true) {
    return refused(400, 'EXTRACT_CONFIRM_REQUIRED', {
      hint: 'accepting writes entity files: show the candidates to the author, then send confirm: true',
    })
  }
  const ids = readIds(body['candidateIds'])
  if (ids === undefined) {
    return refused(400, 'CANDIDATE_ID_INVALID', { field: 'candidateIds', hint: 'send the candidateIds to accept' })
  }
  const overwrite = body['overwrite']
  if (overwrite !== undefined && typeof overwrite !== 'boolean') {
    return refused(400, 'invalid-field', { field: 'overwrite', hint: 'send overwrite: true only for the rows the author agreed to replace' })
  }
  const accepted = acceptCandidates(source.root, ids, undefined, { overwrite: overwrite === true })
  if (!accepted.ok) {
    const status = STATUS_BY_CODE[accepted.error.code] ?? 400
    return refused(status, accepted.error.code, {
      message: accepted.error.message,
      ...(accepted.error.path === undefined ? {} : { path: accepted.error.path }),
    })
  }
  let indexRebuilt = false
  let indexError: JsonRecord | undefined
  try {
    const ensured = await ensureIndex(source.root)
    if (ensured.ok) indexRebuilt = ensured.rebuilt
    else indexError = { code: ensured.failure.code, message: ensured.failure.message }
  } catch (cause) {
    indexError = { code: 'INDEX_BUILD_FAILED', message: String(cause) }
  }
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: source.root,
        accepted: accepted.value.accepted,
        refused: accepted.value.refused,
        outcomes: accepted.value.outcomes.map((outcome) => ({
          candidateId: outcome.candidateId,
          kind: outcome.kind,
          accepted: outcome.accepted,
          ...(outcome.path === undefined ? {} : { path: outcome.path }),
          ...(outcome.overwritten === true ? { overwritten: true } : {}),
          ...(outcome.unchanged === true ? { unchanged: true } : {}),
          ...(outcome.error === undefined ? {} : { error: { ...outcome.error } }),
        })),
        indexRebuilt,
        ...(indexError === undefined ? {} : { indexError }),
      },
    },
  }
}

/** `POST /candidates/reject`: status only. `contentFilesWritten: 0` is the answer's promise. */
export function rejectViaChannel(source: CandidateSource, version: string, body: JsonRecord): CandidateReply {
  const ids = readIds(body['candidateIds'])
  if (ids === undefined) {
    return refused(400, 'CANDIDATE_ID_INVALID', { field: 'candidateIds', hint: 'send the candidateIds to reject' })
  }
  const store = readCandidateStore(source.root)
  const refs = ids.map((candidateId) => ({
    candidateId,
    file: store.records.find((entry) => entry.proposal.candidateId === candidateId)?.file ?? '',
  }))
  const known = refs.filter((ref) => ref.file !== '')
  const outcomes: JsonRecord[] = refs
    .filter((ref) => ref.file === '')
    .map((ref) => ({
      candidateId: ref.candidateId,
      ok: false,
      error: { code: 'CANDIDATE_NOT_FOUND', message: `no candidate has the id ${ref.candidateId}` },
    }))
  for (const outcome of setCandidateStatuses(source.root, known, 'rejected', ['proposed'])) {
    outcomes.push(
      outcome.ok
        ? { candidateId: outcome.candidateId, ok: true }
        : { candidateId: outcome.candidateId, ok: false, error: { ...outcome.error } },
    )
  }
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: source.root,
        rejected: outcomes.filter((outcome) => outcome['ok'] === true).length,
        outcomes,
        contentFilesWritten: 0,
      },
    },
  }
}

/** `POST /candidates/purge`: delete processed candidates. `proposed` ones are refused. */
export function purgeViaChannel(source: CandidateSource, version: string, body: JsonRecord): CandidateReply {
  const confirm = body['confirm']
  if (confirm !== true) {
    return refused(400, 'EXTRACT_CONFIRM_REQUIRED', { hint: 'purging deletes candidates: send confirm: true' })
  }
  const ids = readIds(body['candidateIds'])
  if (ids === undefined) {
    return refused(400, 'CANDIDATE_ID_INVALID', { field: 'candidateIds', hint: 'send the candidateIds to purge' })
  }
  const store = readCandidateStore(source.root)
  const refs = ids.map((candidateId) => ({
    candidateId,
    file: store.records.find((entry) => entry.proposal.candidateId === candidateId)?.file ?? '',
  }))
  const unknown = refs.find((ref) => ref.file === '')
  if (unknown !== undefined) {
    return refused(404, 'CANDIDATE_NOT_FOUND', { message: `no candidate has the id ${unknown.candidateId}` })
  }
  const purged = purgeCandidates(source.root, refs)
  if (!purged.ok) {
    const status = STATUS_BY_CODE[purged.error.code] ?? 400
    return refused(status, purged.error.code, {
      message: purged.error.message,
      ...(purged.error.path === undefined ? {} : { path: purged.error.path }),
    })
  }
  const after = readCandidateStore(source.root)
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: source.root,
        purged: purged.purged.map((entry) => ({ ...entry })),
        remaining: after.records.length,
      },
    },
  }
}

/** Re-exported so the panel's model can clamp the same way the route does. */
export { DEFAULT_LIMIT as CANDIDATE_PAGE_LIMIT }

/** Kinds, for the panel's filter row — one list, one source. */
export type { ExtractKind }
