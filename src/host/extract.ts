/**
 * The extraction queue (ADR-0017): candidate batches under
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
 *
 * WHY THIS FILE IS ONLY A FACADE: at 1084 lines the queue had three jobs in one
 * file — the vocabulary, the shape judge, the bytes, and the state machine. The
 * four modules below split them along the seams the code already had; this file
 * keeps the public address `./extract.js` so every caller and the import-graph
 * guard test stay exactly as they were. Nothing here computes anything.
 */

export { CANDIDATE_ID_PATTERN, CANDIDATE_SCHEMA_VERSION, CANDIDATE_STATUSES, CONFIDENCES, EXTRACT_KINDS, isExtractKind } from './extract-types.js'
export type { CandidateBatch, CandidateProposal, CandidateRecord, CandidateStatus, CandidateVerdict, Confidence, DuplicateMark, ExtractCode, ExtractError, ExtractKind } from './extract-types.js'
export { candidateFieldNames, checkCandidateFields, checkEvidence } from './extract-fields.js'
export type { FieldCheck } from './extract-fields.js'
export { candidateDir, candidateStamp, readCandidateStore } from './extract-store.js'
export type { CandidateStore } from './extract-store.js'
export { proposeCandidates, purgeCandidates, setCandidateStatuses } from './extract-queue.js'
export type { CandidateRef, ProposeInput, ProposeProposalInput, ProposeResult, PurgeOutcome, StatusOutcome } from './extract-queue.js'
