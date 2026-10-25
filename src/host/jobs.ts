/**
 * Issue #47 — the batch job queue: many chapters drafted in one run, resumable after a
 * kill, without a model client inside the plugin.
 *
 * ## The division of labour (roadmap X-26, [ADR-0017](../../.agents/adrs/0017-extraction-by-session-model.md))
 *
 * A job is a **list of chapters that still need a draft**, not a writer. The plugin has no
 * HTTP client and no API key, so the loop is:
 *
 * ```
 * enqueue → take (claim N tasks + hand over each chapter's writing context)
 *         → the session's model writes the prose
 *         → complete (gate → write, or hold for approval)
 * ```
 *
 * `take` decides *what to write next*, `complete` is the only thing that writes prose. A
 * caller that never calls `complete` leaves the book byte-identical — which is what makes
 * "gate first, write second" possible at all.
 *
 * ## Why the progress lives in `.inkflow/jobs/` (ADR-0023)
 *
 * `index/` is a cache that a rebuild empties (ADR-0006 D2), so a job record stored there
 * would disappear exactly when someone reindexes, turning "resume where it stopped" into
 * "start over" (roadmap §2.4 called that out as making the feature fake). `.inkflow/` is
 * private state — already on the write whitelist, already git-ignored — and the job record
 * goes beside the recovery bin, the backup packages and the proposals.
 *
 * ```
 * <book>/.inkflow/jobs/<jobId>/
 *   meta.json              # job status, caps, and the per-chapter roll-up
 *   chapters/<seq>.json    # one chapter: what to write + how far it got
 * ```
 *
 * `meta.json` and the chapter files are **not two truths**: every chapter fact is read from
 * `chapters/*.json`, and `meta.chapters` is a roll-up that `saveState()` rewrites from them
 * in the same call. A reader that only wants "how is it going" opens one file; every writer
 * goes through the chapter files.
 *
 * ## The resume test is a digest, not a file name (the issue's own requirement)
 *
 * "That chapter already exists" is not evidence of anything — an author can create an empty
 * chapter by hand, and a killed writer leaves an empty file behind. So on completion the
 * record stores the **sha256 of the chapter bytes that were written**, and resuming compares
 * the bytes on disk to that digest:
 *
 *   * digest matches        → already done, never handed out again and never rewritten;
 *   * `running` + no digest → the write never finished, so the chapter is handed out again;
 *   * digest differs        → the author took the chapter over (`edited`): terminal, and the
 *                             job will not touch those bytes a second time.
 *
 * ## Why a claim has a lease (X-30's other half)
 *
 * A `running` chapter whose process was killed must become claimable again, or one kill makes
 * the job unwritable — the same reasoning as the stale write lock in `data-safety.md` §2.1.
 * A *live* claim must not be handed to a second caller, or two models would write the same
 * chapter twice. So a claim carries `claimedAt` and expires after `CLAIM_LEASE_MS`: `take`
 * only re-claims an expired one, while `complete` accepts its own claim whether or not it
 * expired (a model that takes an hour must not lose the chapter it is writing).
 *
 * ## Locking: one action at a time, never the whole job
 *
 * Every mutating action takes the project write lock for **its own** critical section and
 * releases it before returning (`withProjectWriteLock` / `acquireProjectWriteLock`+
 * `release`; `writeJsonAtomic` nests and is re-entrant). Nothing holds the lock across a
 * model call — that is the difference between "a batch job is running" and "the editor
 * cannot save for an hour" (X-30). A refusal is `PROJECT_BUSY` **plus** who holds the lock,
 * so the caller can say which session to wait for.
 *
 * ## Where the pieces live (#193 split)
 *
 * This file is the **entry surface** of the queue: the four layers below are re-exported here
 * so the tools, the panel route and the tests keep one import, and so "which module owns this"
 * has one answer (the module table in `architecture.md` §6). Nothing is implemented here —
 * `jobs.ts` was 1374 lines doing all four jobs at once.
 *
 * ```
 * jobs-model.ts    formats, caps, states, record shapes   (no IO, no transitions)
 * jobs-store.ts    paths, read-back, save, write lock     (the only filesystem access)
 * jobs-actions.ts  enqueue / take / resume                 (what to write next)
 * jobs-drafts.ts   complete / approve                     (whether a draft may land)
 * jobs-wire.ts     the panel projection + its one write   (unchanged, not this file)
 * ```
 */

export {
  JOB_FORMAT,
  JOB_SCHEMA_VERSION,
  JOB_CHAPTER_FORMAT,
  JOB_ID_PREFIX,
  JOB_META_FILE,
  JOB_CHAPTERS_DIR,
  DEFAULT_CONCURRENCY,
  DEFAULT_BATCH_SIZE,
  MAX_CONCURRENCY,
  MAX_BATCH_SIZE,
  CLAIM_LEASE_MS,
  MAX_ATTEMPTS,
  JOB_STATUSES,
  CHAPTER_STATUSES,
  PAUSE_POLICIES,
  JOB_GATE_FINDINGS_LIMIT,
} from './jobs-model.js'
export type {
  JobStatus,
  ChapterStatus,
  PausePolicy,
  JobError,
  JobResult,
  JobGateVerdict,
  JobChapter,
  JobChapterRef,
  JobPause,
  JobMeta,
  JobState,
} from './jobs-model.js'
export {
  jobDirRelative,
  jobMetaPath,
  jobChapterPath,
  isJobId,
  listJobs,
  readJob,
  statusFor,
  chapterDigest,
  reconcileChapter,
  inFlightCount,
} from './jobs-store.js'
export type {
  JobSummary,
} from './jobs-store.js'
export {
  enqueueJob,
  takeBatch,
  resumeJob,
} from './jobs-actions.js'
export type {
  JobChapterInput,
  EnqueueInput,
  TakeTask,
  TakeResult,
  ResumeInput,
} from './jobs-actions.js'
export {
  pauseWorthy,
  completeChapter,
  approveDrafts,
} from './jobs-drafts.js'
export type {
  CompleteInput,
  CompleteResult,
  ApproveInput,
  ApproveResult,
} from './jobs-drafts.js'
