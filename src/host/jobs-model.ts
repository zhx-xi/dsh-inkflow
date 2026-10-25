/**
 * Issue #47 — the batch job's vocabulary: the two file formats, the caps, the states, and
 * the record shapes those states are written into.
 *
 * Extracted from `jobs.ts` by #193. Nothing here does anything: no file is opened, no lock
 * is taken, no chapter is written. It is the contract the other three job modules share,
 * which is why it is its own file — `jobs-store.ts`, `jobs-actions.ts` and
 * `jobs-drafts.ts` must agree on the same constants and the same field names, and a string
 * literal repeated in three modules is three chances to disagree.
 *
 * ## What this module owns
 *
 *   * the two formats (`inkflow.batch-job` / `inkflow.batch-chapter`) and their schema
 *     versions: a reader refuses a file it does not understand instead of half-reading it;
 *   * the caps (`DEFAULT_CONCURRENCY` 3 / `MAX_CONCURRENCY` 8, `DEFAULT_BATCH_SIZE` 3 /
 *     `MAX_BATCH_SIZE` 20, `CLAIM_LEASE_MS`, `MAX_ATTEMPTS`) — the roadmap's 「首批 3」;
 *   * the state machines as values: `JOB_STATUSES` (running / paused / done / failed —
 *     `paused` is the human approval point) and `CHAPTER_STATUSES` (a chapter that cannot be
 *     drafted is `failed`, one a human must approve is `held`, one the author took over is
 *     `edited` and terminal);
 *   * the record shapes (`JobChapter`, `JobMeta`, `JobState`, `JobChapterRef`, `JobPause`,
 *     `JobGateVerdict`, `JobSummary`) and the two result envelopes (`JobResult` with
 *     `refuse` / `accept`).
 *
 * ## What it refuses to own
 *
 *   * any disk access (归 `jobs-store.ts`)、any state transition (归 `jobs-actions.ts` /
 *     `jobs-drafts.ts`)、the panel projection (归 `jobs-wire.ts`)；
 *   * the gate's own vocabulary (`GATE_*` codes live in `gate.ts`; a job keeps only counts).
 */

/** `meta.json`'s own identity, so a reader can refuse a file it does not understand. */
export const JOB_FORMAT = 'inkflow.batch-job'

/** Bumped only when the file shapes change: the job record is a fact, not a cache. */
export const JOB_SCHEMA_VERSION = 1

/** One chapter's file: the task plus its progress. */
export const JOB_CHAPTER_FORMAT = 'inkflow.batch-chapter'

/** `<jobId>` shape: `bj-` plus eight hex characters, minted here and never by a caller. */
export const JOB_ID_PREFIX = 'bj-'

export const JOB_ID_PATTERN = /^bj-[0-9a-f]{8}$/u

/** `meta.json` and the per-chapter directory, inside `.inkflow/jobs/<jobId>/`. */
export const JOB_META_FILE = 'meta.json'

export const JOB_CHAPTERS_DIR = 'chapters'

/** Default cap on chapters in flight (roadmap X-30: 「首批 3」). */
export const DEFAULT_CONCURRENCY = 3

/** Default cap on how many chapters one `take` hands out. */
export const DEFAULT_BATCH_SIZE = 3

/** Upper bounds for the two caps: a caller may lower them, not raise them past these. */
export const MAX_CONCURRENCY = 8

export const MAX_BATCH_SIZE = 20

/**
 * How long a claim stays valid. Far longer than one chapter takes to draft, so the common
 * case never re-claims; short enough that a killed run resumes the same working day.
 */
export const CLAIM_LEASE_MS = 45 * 60 * 1000

/** How many times one chapter may be claimed before the job stops retrying it. */
export const MAX_ATTEMPTS = 3

/** Job states. `paused` is the human approval point; the other three are mechanical. */
export const JOB_STATUSES = ['running', 'paused', 'done', 'failed'] as const

export type JobStatus = (typeof JOB_STATUSES)[number]

/**
 * Per-chapter states.
 *
 *   * `pending` — queued, never claimed (or re-queued by `resume`);
 *   * `running` — claimed by `take`; carries `claimedAt` and `attempts`;
 *   * `done`    — written, with the digest of the bytes that were written;
 *   * `held`    — drafted and gated, waiting for a human (`inkflow_batch_approve`);
 *   * `failed`  — the write refused (see `lastError`); `resume` re-queues it;
 *   * `edited`  — done once, but the file changed afterwards: the author owns it now.
 */
export const CHAPTER_STATUSES = ['pending', 'running', 'done', 'held', 'failed', 'edited'] as const

export type ChapterStatus = (typeof CHAPTER_STATUSES)[number]

/**
 * What makes a gated draft stop for a human.
 *
 * `warning` (default) pauses on any warning-or-worse finding; `any` also pauses on `info`.
 * There is deliberately no "never": the gate always runs and its verdict is always recorded,
 * so a job can never auto-approve prose (the issue's 「不许自动跳过门禁」).
 */
export const PAUSE_POLICIES = ['warning', 'any'] as const

export type PausePolicy = (typeof PAUSE_POLICIES)[number]

/** How many findings of one draft the chapter record keeps (counts always cover all). */
export const JOB_GATE_FINDINGS_LIMIT = 20

export interface JobError {
  readonly code: string
  readonly message: string
  readonly hint?: string
  readonly path?: string
  /** `PROJECT_BUSY` only: who holds `index/.write.lock` (X-30 asks for the holder by name). */
  readonly lockHolder?: { readonly pid?: number; readonly startedAt?: string }
  /** The chapter this error is about, when it is about one. */
  readonly seq?: number
}

export type JobResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: JobError }

export function refuse<T>(code: string, message: string, extra: Omit<JobError, 'code' | 'message'> = {}): JobResult<T> {
  return { ok: false, error: { code, message, ...extra } }
}

export function accept<T>(value: T): JobResult<T> {
  return { ok: true, value }
}

/** The gate's verdict as the chapter record keeps it: counts for all, findings for a sample. */
export interface JobGateVerdict {
  readonly counts: { readonly total: number; readonly warning: number; readonly info: number; readonly fixable: number }
  readonly checks: readonly { readonly id: string; readonly label: string; readonly count: number }[]
  readonly findings: readonly Record<string, unknown>[]
  readonly returned: number
  readonly truncated: boolean
  /** Whether this verdict is what paused the job. */
  readonly paused: boolean
}

/** One chapter of a job: the task, plus everything known about how far it got. */
export interface JobChapter {
  readonly format: typeof JOB_CHAPTER_FORMAT
  readonly schemaVersion: number
  readonly jobId: string
  readonly seq: number
  /** The chapter this task produced. `null` until `complete` has created it. */
  readonly chapterId: string | null
  /** Project-relative chapter path, once it exists. */
  readonly path: string | null
  readonly title: string
  readonly volumeId: string | null
  /** The one-line brief the caller enqueued ("what this chapter is about"). */
  readonly outline: string | null
  /** Target length in characters, when the caller gave one. */
  readonly budgetWords: number | null
  readonly status: ChapterStatus
  readonly attempts: number
  /** ISO time of the current (or last) claim; the lease is measured from here. */
  readonly claimedAt: string | null
  readonly startedAt: string | null
  readonly finishedAt: string | null
  /** sha256 of the chapter file's bytes as `complete` wrote them — the resume test. */
  readonly digest: string | null
  readonly lastError: { readonly code: string; readonly message: string } | null
  readonly gate: JobGateVerdict | null
  /** A gated draft that has not been written yet (`status: 'held'`). */
  readonly pendingBody: string | null
}

/** One row of `meta.chapters`: the roll-up, rewritten from the chapter files on every save. */
export interface JobChapterRef {
  readonly seq: number
  readonly chapterId: string | null
  readonly status: ChapterStatus
  readonly attempts: number
  readonly digest: string | null
}

export interface JobPause {
  readonly code: string
  readonly message: string
  readonly seqs: readonly number[]
}

export interface JobMeta {
  readonly format: typeof JOB_FORMAT
  readonly schemaVersion: number
  readonly jobId: string
  readonly status: JobStatus
  readonly concurrency: number
  readonly batchSize: number
  readonly pauseOn: PausePolicy
  readonly createdAt: string
  readonly updatedAt: string
  readonly pauseReason: JobPause | null
  readonly chapters: readonly JobChapterRef[]
}

export interface JobState {
  readonly jobId: string
  /** `.inkflow/jobs/<jobId>` — what the panel prints. */
  readonly dir: string
  readonly meta: JobMeta
  readonly chapters: readonly JobChapter[]
}

// ---------------------------------------------------------------------------
// Paths
