/**
 * The extraction queue's state machine: submit (create or update in place) and the
 * three terminal moves — accept, reject, purge.
 *
 * WHY IT IS A FILE: this is the only place that *changes* a candidate's status, and
 * the rules it enforces are the queue's contract — everything is judged before the
 * first byte is written, an update keeps the id and the count, a candidate that was
 * already decided cannot be updated, and `purge` refuses whatever a human has not
 * judged yet. Those rules are readable end to end in one file; the JSON shape lives
 * in the store and the field rules live in the judge, so neither can be quietly
 * changed to make a status transition pass.
 */

import { removeProjectFile } from './io.js'
import { ensurePrivateStateIgnored, privateStateRelative } from './private-state.js'
import { batchFileName, candidateStamp, mintCandidateId, parseDuplicate, parseVerdict, readBatchFile, readCandidateStore, writeBatch } from './extract-store.js'
import { checkCandidateFields, checkEvidence } from './extract-fields.js'
import { CANDIDATE_ID_PATTERN, CANDIDATE_SCHEMA_VERSION, CONFIDENCES, refuse } from './extract-types.js'
import type { CandidateBatch, CandidateProposal, CandidateStatus, Confidence, ExtractError, ExtractKind } from './extract-types.js'

export interface ProposeProposalInput {
  /** Echo of an id the caller read back — the only way to *update* a candidate. */
  readonly candidateId?: string
  readonly fields: unknown
  readonly evidence: unknown
  readonly rationale?: unknown
  readonly confidence?: unknown
  /**
   * What the accept path would refuse, worked out by the caller.
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
    // decision 2). A read-only `.gitignore` must not cost the author a batch that is already
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
