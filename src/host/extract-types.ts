/**
 * The extraction queue's shared vocabulary: the schema version, the three closed
 * value sets, the id pattern and the candidate shapes.
 *
 * WHY IT IS A FILE: the queue is now four modules (this one, the field/evidence
 * judge, the store and the submit/status half) and every one of them has to agree
 * on what a candidate *is*. Keeping those shapes in a leaf module means the other
 * three can import them without importing each other — the module graph stays a
 *cyclic — and a candidate file read by an older plugin still parses against one
 * definition of its shape.
 *
 * No IO, no clock, no React: constants, interfaces and the two refusal helpers.
 */

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
   * What `accept` would refuse, judged at submit time by the very same function.
   *
   * Absent means "no conflict seen"; it is a **warning, not a gate** — the author may
   * still accept (or fix the candidate first), and the queue must keep working after a
   * book changes underneath it, so this is recomputed on every submit rather than
   * trusted forever.
   */
  readonly willFail?: CandidateVerdict
  /**
   * The entity this candidate would replace, when the same identity already exists with
   * **different** content.
   *
   * A candidate whose content is identical is never stored — there is nothing to review.
   * This marker is what turns the row into a question ("已存在，但内容不一致，是否覆盖？")
   * instead of an automatic write: `accept` refuses without `overwrite: true`, and the
   * digest is the CAS baseline that stops a late edit from being clobbered.
   */
  readonly duplicate?: DuplicateMark
}

/** Same identity, other content: the row the author has to decide about. */
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

export function refuse(code: ExtractCode, message: string, extra: { field?: string; path?: string; hint?: string } = {}): ExtractError {
  return { code, message, ...extra }
}

export function isExtractKind(value: unknown): value is ExtractKind {
  return typeof value === 'string' && (EXTRACT_KINDS as readonly string[]).includes(value)
}
