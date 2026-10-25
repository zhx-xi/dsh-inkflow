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
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { createChapter, deleteChapter, writeChapter } from './chapters.js'
import { INDEX_DIR } from './conventions.js'
import { readText } from './domains/scan-helpers.js'
import { gateFindingRecord, runGate } from './gate.js'
import type { GateReport } from './gate.js'
import { acquireProjectWriteLock, withProjectWriteLock, writeJsonAtomic } from './io.js'
import type { IoFailure } from './io.js'
import { ensurePrivateStateIgnored, privateStateRelative } from './private-state.js'
import { buildWritingBrief } from './writing-context.js'

// ---------------------------------------------------------------------------
// Constants and shapes
// ---------------------------------------------------------------------------

/** `meta.json`'s own identity, so a reader can refuse a file it does not understand. */
export const JOB_FORMAT = 'inkflow.batch-job'
/** Bumped only when the file shapes change: the job record is a fact, not a cache. */
export const JOB_SCHEMA_VERSION = 1
/** One chapter's file: the task plus its progress. */
export const JOB_CHAPTER_FORMAT = 'inkflow.batch-chapter'

/** `<jobId>` shape: `bj-` plus eight hex characters, minted here and never by a caller. */
export const JOB_ID_PREFIX = 'bj-'
const JOB_ID_PATTERN = /^bj-[0-9a-f]{8}$/u

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

function refuse<T>(code: string, message: string, extra: Omit<JobError, 'code' | 'message'> = {}): JobResult<T> {
  return { ok: false, error: { code, message, ...extra } }
}

function accept<T>(value: T): JobResult<T> {
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
// ---------------------------------------------------------------------------

/** `.inkflow/jobs/<jobId>` (project-relative, forward slashes). */
export function jobDirRelative(jobId: string): string {
  return privateStateRelative('jobs', `${jobId}/`)
    .replace(/\/+$/u, '')
}

/** `.inkflow/jobs/<jobId>/meta.json`. */
export function jobMetaPath(jobId: string): string {
  return privateStateRelative('jobs', `${jobId}/${JOB_META_FILE}`)
}

/** `.inkflow/jobs/<jobId>/chapters/<seq>.json`. */
export function jobChapterPath(jobId: string, seq: number): string {
  return privateStateRelative('jobs', `${jobId}/${JOB_CHAPTERS_DIR}/${String(seq)}.json`)
}

/** Whether a string is a job id this module could have minted. */
export function isJobId(value: string): boolean {
  return JOB_ID_PATTERN.test(value)
}

function absoluteOf(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'))
}

/** A new job id: four random bytes, so two sessions cannot mint the same one. */
function mintJobId(): string {
  return `${JOB_ID_PREFIX}${randomBytes(4).toString('hex')}`
}

// ---------------------------------------------------------------------------
// Reading and writing JSON under `.inkflow/jobs/`
// ---------------------------------------------------------------------------

/**
 * `readText` already tolerates a BOM (`scan-helpers.ts` strips it), which matters here: a
 * Windows editor saving `meta.json` must not make the job unreadable.
 */
function parseJsonFile<T>(path: string): { ok: true; value: T } | { ok: false; reason: string } {
  const text = readText(path)
  if (text === '') return { ok: false, reason: 'the file is missing or empty' }
  try {
    return { ok: true, value: JSON.parse(text) as T }
  } catch (cause) {
    return { ok: false, reason: `not valid JSON: ${String(cause)}` }
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function integerOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function nullOrText(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nullOrInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function isChapterStatus(value: unknown): value is ChapterStatus {
  return typeof value === 'string' && (CHAPTER_STATUSES as readonly string[]).includes(value)
}

function isPausePolicy(value: unknown): value is PausePolicy {
  return typeof value === 'string' && (PAUSE_POLICIES as readonly string[]).includes(value)
}

/** `chapters/*.json` → records ordered by `seq` (the file name is the address, not the order). */
function readChapters(root: string, jobId: string): JobResult<JobChapter[]> {
  const dir = absoluteOf(root, privateStateRelative('jobs', `${jobId}/${JOB_CHAPTERS_DIR}`))
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return accept([])
  }
  const chapters: JobChapter[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const relative = privateStateRelative('jobs', `${jobId}/${JOB_CHAPTERS_DIR}/${name}`)
    const parsed = parseJsonFile<JobChapter>(absoluteOf(root, relative))
    if (!parsed.ok) return refuse('JOB_UNREADABLE', `cannot read ${relative}: ${parsed.reason}`, { path: relative })
    const record = recordOf(parsed.value)
    const seq = integerOf(record['seq'])
    const status = record['status']
    if (seq === undefined || !isChapterStatus(status)) {
      return refuse('JOB_UNREADABLE', `${relative} is not a chapter record (seq/status missing)`, { path: relative })
    }
    chapters.push({
      format: JOB_CHAPTER_FORMAT,
      schemaVersion: integerOf(record['schemaVersion']) ?? JOB_SCHEMA_VERSION,
      jobId,
      seq,
      chapterId: nullOrText(record['chapterId']),
      path: nullOrText(record['path']),
      title: textOf(record['title']) ?? `#${String(seq)}`,
      volumeId: nullOrText(record['volumeId']),
      outline: nullOrText(record['outline']),
      budgetWords: nullOrInteger(record['budgetWords']),
      status,
      attempts: integerOf(record['attempts']) ?? 0,
      claimedAt: nullOrText(record['claimedAt']),
      startedAt: nullOrText(record['startedAt']),
      finishedAt: nullOrText(record['finishedAt']),
      digest: nullOrText(record['digest']),
      lastError: readError(record['lastError']),
      gate: readGate(record['gate']),
      pendingBody: nullOrText(record['pendingBody']),
    })
  }
  return accept(chapters.sort((left, right) => left.seq - right.seq))
}

function readError(value: unknown): JobChapter['lastError'] {
  const record = recordOf(value)
  const code = textOf(record['code'])
  return code === undefined ? null : { code, message: textOf(record['message']) ?? '' }
}

function readGate(value: unknown): JobGateVerdict | null {
  const record = recordOf(value)
  if (Object.keys(record).length === 0) return null
  const counts = recordOf(record['counts'])
  const checks = Array.isArray(record['checks']) ? record['checks'] : []
  const findings = Array.isArray(record['findings']) ? record['findings'].map((item) => recordOf(item)) : []
  return {
    counts: {
      total: integerOf(counts['total']) ?? 0,
      warning: integerOf(counts['warning']) ?? 0,
      info: integerOf(counts['info']) ?? 0,
      fixable: integerOf(counts['fixable']) ?? 0,
    },
    checks: checks.map((item) => {
      const check = recordOf(item)
      return {
        id: textOf(check['id']) ?? '',
        label: textOf(check['label']) ?? '',
        count: integerOf(check['count']) ?? 0,
      }
    }),
    findings,
    returned: integerOf(record['returned']) ?? findings.length,
    truncated: record['truncated'] === true,
    paused: record['paused'] === true,
  }
}

/** `meta.json` → the job-level record, refusing a stranger's file. */
function readMeta(root: string, jobId: string): JobResult<JobMeta> {
  const relative = jobMetaPath(jobId)
  const parsed = parseJsonFile<JobMeta>(absoluteOf(root, relative))
  if (!parsed.ok) return refuse('JOB_UNREADABLE', `cannot read ${relative}: ${parsed.reason}`, { path: relative })
  const record = recordOf(parsed.value)
  if (textOf(record['format']) !== JOB_FORMAT) {
    return refuse('JOB_UNREADABLE', `${relative} is not a batch job record`, { path: relative })
  }
  if (integerOf(record['schemaVersion']) !== JOB_SCHEMA_VERSION) {
    return refuse(
      'JOB_UNREADABLE',
      `${relative} was written by another plugin version (schemaVersion ${String(record['schemaVersion'])}); ` +
        'this build reads schemaVersion 1 only',
      { path: relative },
    )
  }
  const status = textOf(record['status']) ?? ''
  return accept({
    format: JOB_FORMAT,
    schemaVersion: JOB_SCHEMA_VERSION,
    jobId,
    status: (JOB_STATUSES as readonly string[]).includes(status) ? (status as JobStatus) : 'running',
    concurrency: integerOf(record['concurrency']) ?? DEFAULT_CONCURRENCY,
    batchSize: integerOf(record['batchSize']) ?? DEFAULT_BATCH_SIZE,
    pauseOn: isPausePolicy(record['pauseOn']) ? record['pauseOn'] : 'warning',
    createdAt: textOf(record['createdAt']) ?? new Date(0).toISOString(),
    updatedAt: textOf(record['updatedAt']) ?? new Date(0).toISOString(),
    pauseReason: readPause(record['pauseReason']),
    // The roll-up is rebuilt on every save; a hand-edited copy never becomes a second truth.
    chapters: [],
  })
}

function readPause(value: unknown): JobPause | null {
  const record = recordOf(value)
  const code = textOf(record['code'])
  if (code === undefined) return null
  const seqs = Array.isArray(record['seqs'])
    ? record['seqs'].filter((item): item is number => typeof item === 'number' && Number.isInteger(item))
    : []
  return { code, message: textOf(record['message']) ?? '', seqs }
}

export interface JobSummary {
  readonly jobId: string
  readonly status: JobStatus
  readonly dir: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly total: number
  readonly done: number
  readonly paused: JobPause | null
}

/**
 * Every job in the book, newest first.
 *
 * A directory whose `meta.json` cannot be read is skipped rather than reported: this list is
 * the panel's index, and one corrupt directory must not make the page unusable — the tool
 * that opens it by name is where the error surfaces.
 */
export function listJobs(root: string): JobSummary[] {
  const base = absoluteOf(root, privateStateRelative('jobs', ''))
  let names: string[]
  try {
    names = readdirSync(base)
  } catch {
    return []
  }
  const out: JobSummary[] = []
  for (const name of names) {
    if (!isJobId(name)) continue
    const meta = readMeta(root, name)
    if (!meta.ok) continue
    const chapters = readChapters(root, name)
    const list = chapters.ok ? chapters.value : []
    out.push({
      jobId: name,
      status: meta.value.status,
      dir: jobDirRelative(name),
      createdAt: meta.value.createdAt,
      updatedAt: meta.value.updatedAt,
      total: list.length,
      done: list.filter((chapter) => chapter.status === 'done' || chapter.status === 'edited').length,
      paused: meta.value.pauseReason,
    })
  }
  return out.sort((left, right) => (left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0))
}

/**
 * Which job a call means. An explicit id must be well-formed; without one the **newest** job
 * wins, and every reply carries the resolved id so the next call can pin it.
 */
function resolveJobId(root: string, requested: string | undefined): JobResult<string> {
  const wanted = (requested ?? '').trim()
  if (wanted !== '') {
    if (!isJobId(wanted)) {
      return refuse('JOB_ID_INVALID', `"${wanted}" is not a job id; expected bj- followed by eight hex characters`)
    }
    if (!existsSync(absoluteOf(root, jobMetaPath(wanted)))) {
      return refuse('JOB_NOT_FOUND', `this book has no job ${wanted}`, {
        hint: 'list the jobs with inkflow_batch_enqueue (it creates one) or open the 批量 panel',
      })
    }
    return accept(wanted)
  }
  const jobs = listJobs(root)
  const newest = jobs[0]
  if (newest === undefined) {
    return refuse('JOB_NOT_FOUND', 'this book has no batch job yet', {
      hint: 'create one with inkflow_batch_enqueue — it writes only .inkflow/jobs/, never a chapter',
    })
  }
  return accept(newest.jobId)
}

/** Load one job (or the newest). */
export function readJob(root: string, requested?: string): JobResult<JobState> {
  const resolved = resolveJobId(root, requested)
  if (!resolved.ok) return resolved
  const jobId = resolved.value
  const meta = readMeta(root, jobId)
  if (!meta.ok) return meta
  const chapters = readChapters(root, jobId)
  if (!chapters.ok) return chapters
  return accept({ jobId, dir: jobDirRelative(jobId), meta: meta.value, chapters: chapters.value })
}

// ---------------------------------------------------------------------------
// Status, roll-up, saving
// ---------------------------------------------------------------------------

function refOf(chapter: JobChapter): JobChapterRef {
  return {
    seq: chapter.seq,
    chapterId: chapter.chapterId,
    status: chapter.status,
    attempts: chapter.attempts,
    digest: chapter.digest,
  }
}

/**
 * The job's status, derived from the chapters every time (never a second stored decision):
 * a held draft means `paused`; otherwise anything claimable keeps it `running`; a job with
 * nothing left to do is `failed` when some chapter failed and `done` when none did.
 */
export function statusFor(chapters: readonly JobChapter[], current: JobStatus): JobStatus {
  if (chapters.length === 0) return current === 'paused' ? 'paused' : 'running'
  if (chapters.some((chapter) => chapter.status === 'held')) return 'paused'
  if (chapters.some((chapter) => chapter.status === 'pending' || chapter.status === 'running')) return 'running'
  return chapters.some((chapter) => chapter.status === 'failed') ? 'failed' : 'done'
}

/** Write one chapter record (the caller holds the lock). */
function saveChapter(root: string, chapter: JobChapter): JobResult<true> {
  const relative = jobChapterPath(chapter.jobId, chapter.seq)
  const written = writeJsonAtomic(root, relative, chapter)
  if (!written.ok) {
    return refuse('JOB_WRITE_FAILED', `cannot write ${relative}: ${written.error.message}`, { path: relative })
  }
  return accept(true)
}

/**
 * Write the whole state: the changed chapter records first, then `meta.json` (whose roll-up
 * is rebuilt from the chapters in this same call).
 *
 * The order is what a crash needs: a chapter record that made it to disk is true even if
 * `meta.json` is one revision behind, and nothing reads per-chapter state from `meta.json`.
 */
function saveState(
  root: string,
  meta: JobMeta,
  chapters: readonly JobChapter[],
  changed: readonly JobChapter[],
  now: string,
): JobResult<JobState> {
  // Best effort, exactly like the gate's record: a read-only `.gitignore` must not stop the
  // job from recording progress (the files are still private state on disk).
  ensurePrivateStateIgnored(root)
  for (const chapter of changed) {
    const written = saveChapter(root, chapter)
    if (!written.ok) return written
  }
  const next: JobMeta = {
    ...meta,
    status: statusFor(chapters, meta.status),
    updatedAt: now,
    pauseReason: pauseReasonFor(chapters, meta.pauseReason),
    chapters: chapters.map(refOf),
  }
  const relative = jobMetaPath(meta.jobId)
  const written = writeJsonAtomic(root, relative, next)
  if (!written.ok) {
    return refuse('JOB_WRITE_FAILED', `cannot write ${relative}: ${written.error.message}`, { path: relative })
  }
  return accept({ jobId: meta.jobId, dir: jobDirRelative(meta.jobId), meta: next, chapters })
}

/** A pause survives only while something is still held: approving the last draft clears it. */
function pauseReasonFor(chapters: readonly JobChapter[], current: JobPause | null): JobPause | null {
  const held = chapters.filter((chapter) => chapter.status === 'held')
  if (held.length === 0) return null
  return {
    code: current?.code ?? 'GATE_PAUSED',
    message: current?.message ?? 'gated drafts are waiting for a human decision',
    seqs: held.map((chapter) => chapter.seq),
  }
}

// ---------------------------------------------------------------------------
// The lock (X-30)
// ---------------------------------------------------------------------------

/** `.write.lock`'s content, read the same way `etl.ts` reads it (`pid` + `startedAt`). */
function lockHolderOf(root: string): { pid?: number; startedAt?: string } | undefined {
  const parsed = parseJsonFile<Record<string, unknown>>(join(root, INDEX_DIR, '.write.lock'))
  if (!parsed.ok) return undefined
  const pid = integerOf(parsed.value['pid'])
  const startedAt = integerOf(parsed.value['startedAt'])
  return {
    ...(pid === undefined ? {} : { pid }),
    ...(startedAt === undefined ? {} : { startedAt: new Date(startedAt).toISOString() }),
  }
}

/**
 * A `PROJECT_BUSY` (or any `io.ts`) refusal, with the holder named when it is about the lock:
 * "busy" alone leaves the model unable to tell the author which session to wait for.
 */
function lockFailure<T>(root: string, failure: IoFailure): JobResult<T> {
  const busy = failure.code === 'PROJECT_BUSY'
  return refuse(failure.code, failure.message, {
    ...(failure.path === undefined ? {} : { path: failure.path }),
    ...(busy
      ? {
          lockHolder: lockHolderOf(root) ?? {},
          hint: 'another session holds index/.write.lock; wait for it to finish and retry — completed chapters are skipped, so nothing is written twice',
        }
      : { hint: 'nothing was written: the job record could not be saved' }),
  })
}

/** One synchronous critical section under the project write lock. */
function locked<T>(root: string, body: (root: string) => JobResult<T>): JobResult<T> {
  const held = withProjectWriteLock(root, () => body(root))
  if (held.ok) return held.value
  return lockFailure(root, held.error)
}

/**
 * One asynchronous critical section (a chapter write is `async`: `chapters.ts` awaits the
 * index rebuild). `withProjectWriteLock` takes a synchronous body, so the lock is acquired
 * and released by hand here — the same lock, the same re-entrancy, one `finally`.
 */
async function lockedAsync<T>(root: string, body: (root: string) => Promise<JobResult<T>>): Promise<JobResult<T>> {
  const acquired = acquireProjectWriteLock(root)
  if (!acquired.ok) return lockFailure(root, acquired.error)
  try {
    return await body(acquired.value.root)
  } finally {
    acquired.value.release()
  }
}

// ---------------------------------------------------------------------------
// Digest: the resume test
// ---------------------------------------------------------------------------

/** sha256 of a chapter file's bytes on disk; `null` when there is no such file. */
export function chapterDigest(root: string, relativePath: string): string | null {
  const absolute = absoluteOf(root, relativePath)
  if (!existsSync(absolute)) return null
  try {
    return createHash('sha256').update(readFileSync(absolute)).digest('hex')
  } catch {
    return null
  }
}

/**
 * Bring a chapter's recorded state in line with the bytes on disk.
 *
 * Only `done` is compared: a `running` chapter has no digest by construction (the record is
 * written in the same action that writes the file), and `held`/`failed`/`pending` never
 * produced a file. `edited` is terminal — the digest is what the job wrote, so the divergence
 * stays visible instead of being overwritten by the next comparison.
 */
export function reconcileChapter(root: string, chapter: JobChapter): JobChapter {
  if (chapter.status !== 'done' || chapter.digest === null || chapter.path === null) return chapter
  if (chapterDigest(root, chapter.path) === chapter.digest) return chapter
  const gone = chapterDigest(root, chapter.path) === null
  return {
    ...chapter,
    status: 'edited',
    lastError: {
      code: 'CHAPTER_EDITED',
      message: gone
        ? 'the chapter file is gone; the job will not recreate it'
        : 'the chapter file changed after the job wrote it; the job will not overwrite the author',
    },
  }
}

// ---------------------------------------------------------------------------
// Claim arithmetic
// ---------------------------------------------------------------------------

function claimExpired(chapter: JobChapter, now: number): boolean {
  if (chapter.status !== 'running') return false
  const claimedAt = chapter.claimedAt === null ? Number.NaN : Date.parse(chapter.claimedAt)
  if (Number.isNaN(claimedAt)) return true
  return now - claimedAt > CLAIM_LEASE_MS
}

/** Chapters whose claim is alive right now: the ones `concurrency` counts. */
export function inFlightCount(chapters: readonly JobChapter[], now: number): number {
  return chapters.filter((chapter) => chapter.status === 'running' && !claimExpired(chapter, now)).length
}

// ---------------------------------------------------------------------------
// enqueue
// ---------------------------------------------------------------------------

export interface JobChapterInput {
  readonly seq?: number
  readonly title: string
  readonly volumeId?: string | null
  readonly outline?: string | null
  readonly budgetWords?: number | null
}

export interface EnqueueInput {
  readonly jobId?: string
  readonly concurrency?: number
  readonly batchSize?: number
  readonly pauseOn?: PausePolicy
  readonly chapters: readonly JobChapterInput[]
  readonly now?: number
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/**
 * Create a job, or add chapters to one.
 *
 * **This writes nothing outside `.inkflow/jobs/`** — no chapter file is created, no
 * `chapters/index.json` entry is made. That is the issue's 「建作业零写内容目录」, and it is also
 * what keeps `enqueue` safe to call before anyone has written a word: a job is a plan, and a
 * plan is not a manuscript.
 *
 * Re-enqueueing a `seq` the job already has is a no-op reported in `skipped` (data-safety
 * §2.7 idempotence) rather than a second record for the same chapter.
 */
export function enqueueJob(root: string, input: EnqueueInput): JobResult<JobState & { skipped: readonly number[] }> {
  if (input.chapters.length === 0) return refuse('JOB_EMPTY', 'a job needs at least one chapter to draft')
  const now = input.now ?? Date.now()
  const stamp = new Date(now).toISOString()
  return locked(root, (held) => {
    const requested = (input.jobId ?? '').trim()
    if (requested !== '' && !isJobId(requested)) {
      return refuse('JOB_ID_INVALID', `"${requested}" is not a job id; expected bj- followed by eight hex characters`)
    }
    const existing = requested !== '' && existsSync(absoluteOf(held, jobMetaPath(requested)))
      ? readJob(held, requested)
      : undefined
    if (existing !== undefined && !existing.ok) return existing
    const base: JobState | undefined = existing?.ok === true ? existing.value : undefined
    const jobId = base?.jobId ?? (requested === '' ? mintJobId() : requested)
    const chapters: JobChapter[] = base === undefined ? [] : [...base.chapters]
    const meta: JobMeta =
      base?.meta ?? {
        format: JOB_FORMAT,
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId,
        status: 'running',
        concurrency: clampInt(input.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY),
        batchSize: clampInt(input.batchSize, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE),
        pauseOn: isPausePolicy(input.pauseOn) ? input.pauseOn : 'warning',
        createdAt: stamp,
        updatedAt: stamp,
        pauseReason: null,
        chapters: [],
      }
    const skipped: number[] = []
    const added: JobChapter[] = []
    let nextSeq = chapters.reduce((max, chapter) => Math.max(max, chapter.seq), 0) + 1
    for (const item of input.chapters) {
      const title = (item.title ?? '').trim()
      if (title === '') return refuse('TITLE_REQUIRED', 'every chapter of a job needs a title')
      const seq = item.seq ?? nextSeq
      if (!Number.isInteger(seq) || seq < 1) {
        return refuse('SEQ_INVALID', `seq must be a positive integer (got ${String(item.seq)})`)
      }
      if (chapters.some((chapter) => chapter.seq === seq) || added.some((chapter) => chapter.seq === seq)) {
        skipped.push(seq)
        continue
      }
      nextSeq = Math.max(nextSeq, seq + 1)
      const chapter: JobChapter = {
        format: JOB_CHAPTER_FORMAT,
        schemaVersion: JOB_SCHEMA_VERSION,
        jobId,
        seq,
        chapterId: null,
        path: null,
        title,
        volumeId: (item.volumeId ?? '') === '' ? null : (item.volumeId ?? null),
        outline: (item.outline ?? '') === '' ? null : (item.outline ?? null),
        budgetWords: item.budgetWords ?? null,
        status: 'pending',
        attempts: 0,
        claimedAt: null,
        startedAt: null,
        finishedAt: null,
        digest: null,
        lastError: null,
        gate: null,
        pendingBody: null,
      }
      added.push(chapter)
      chapters.push(chapter)
    }
    chapters.sort((left, right) => left.seq - right.seq)
    const saved = saveState(held, meta, chapters, added, stamp)
    if (!saved.ok) return saved
    return accept({ ...saved.value, skipped })
  })
}

// ---------------------------------------------------------------------------
// take
// ---------------------------------------------------------------------------

/** One claimed chapter as `take` hands it over: the task, plus the context to write it. */
export interface TakeTask {
  readonly seq: number
  readonly title: string
  readonly volumeId: string | null
  readonly outline: string | null
  readonly budgetWords: number | null
  readonly attempts: number
  /** The writing brief for that chapter, from the ONE assembly (roadmap X-23). */
  readonly context: {
    readonly text: string
    readonly tokens: number
    readonly budgetTokens: number
    readonly overBudget: boolean
    /**
     * Which chapter the injection actually describes: the planned `seq` once the chapter
     * exists, and the book's newest chapter (or `null`) while it does not.
     */
    readonly chapterSeq: number | null
    /**
     * `true` when the brief describes another chapter than the one to write — a planned
     * chapter has no file, so there is no `outline` segment for it. The task's own `outline`
     * is the authoritative brief; this flag exists so nobody mistakes the block below for it.
     */
    readonly planned: boolean
    readonly segments: readonly {
      readonly id: string
      readonly bytes: number
      readonly tokens: number
      readonly truncated: boolean
      readonly missing: boolean
    }[]
  }
}

export interface TakeResult {
  readonly state: JobState
  readonly tasks: readonly TakeTask[]
  readonly skipped: readonly number[]
  readonly inFlight: number
  readonly remaining: number
  /** Why `tasks` is empty, when it is: `PAUSED` / `CONCURRENCY_REACHED` / `NOTHING_PENDING`. */
  readonly reason: string | null
}

/**
 * Claim the next batch of chapters, and hand each one its writing context.
 *
 * The capacity is `concurrency − inFlight`, so the cap is on the whole job, not on one call: a
 * model that takes three and then calls `take` again gets nothing until it completes one.
 * `batchSize` caps a single reply (a caller that wants one chapter at a time sets it to 1).
 *
 * A `paused` job hands nothing out — that is the point of the pause — and `done`/`failed`
 * jobs hand nothing out either; `resume` is the way back.
 */
export function takeBatch(root: string, input: { readonly jobId?: string; readonly now?: number } = {}): JobResult<TakeResult> {
  const now = input.now ?? Date.now()
  const stamp = new Date(now).toISOString()
  return locked(root, (held) => {
    const current = readJob(held, input.jobId)
    if (!current.ok) return current
    const state = current.value

    const chapters: JobChapter[] = []
    let reconciled = false
    for (const chapter of state.chapters) {
      const next = reconcileChapter(held, chapter)
      if (next.status !== chapter.status) reconciled = true
      chapters.push(next)
    }

    const inFlight = inFlightCount(chapters, now)
    const capacity = Math.max(0, state.meta.concurrency - inFlight)
    const claimed: JobChapter[] = []
    const skipped: number[] = []
    let changed = reconciled

    if (state.meta.status !== 'paused') {
      for (let index = 0; index < chapters.length; index += 1) {
        if (claimed.length >= Math.min(capacity, state.meta.batchSize)) break
        const chapter = chapters[index]
        if (chapter === undefined) continue
        if (chapter.status !== 'pending' && !claimExpired(chapter, now)) continue
        if (chapter.attempts >= MAX_ATTEMPTS) {
          chapters[index] = {
            ...chapter,
            status: 'failed',
            claimedAt: null,
            lastError: {
              code: 'ATTEMPTS_EXCEEDED',
              message: `this chapter was claimed ${String(chapter.attempts)} times without completing; resume the job to retry it`,
            },
          }
          skipped.push(chapter.seq)
          changed = true
          continue
        }
        const next: JobChapter = {
          ...chapter,
          status: 'running',
          attempts: chapter.attempts + 1,
          claimedAt: stamp,
          startedAt: chapter.startedAt ?? stamp,
          lastError: null,
        }
        chapters[index] = next
        claimed.push(next)
        changed = true
      }
    }

    const saved = changed ? saveState(held, state.meta, chapters, chapters, stamp) : accept(state)
    if (!saved.ok) return saved
    const after = saved.value
    const tasks: TakeTask[] = claimed.map((chapter) => ({
      seq: chapter.seq,
      title: chapter.title,
      volumeId: chapter.volumeId,
      outline: chapter.outline,
      budgetWords: chapter.budgetWords,
      attempts: chapter.attempts,
      context: contextFor(held, chapter.seq),
    }))
    return accept({
      state: after,
      tasks,
      skipped,
      inFlight: inFlightCount(after.chapters, now),
      remaining: after.chapters.filter((chapter) => chapter.status === 'pending').length,
      reason:
        tasks.length > 0
          ? null
          : after.meta.status === 'paused'
            ? 'PAUSED'
            : capacity === 0
              ? 'CONCURRENCY_REACHED'
              : 'NOTHING_PENDING',
    })
  })
}

/**
 * The chapter's writing context, from the assembly the injection uses (X-23): "what the model
 * would see" must be one computation, not a second one written for the batch.
 *
 * A chapter that does not exist yet has no `outline` segment — the brief describes the book's
 * newest chapter instead, and `planned: true` says so rather than letting a caller believe the
 * block is this chapter's plan. The task's own `outline` (enqueued by the caller) is the
 * authoritative brief for a planned chapter; the assembled block is the setting material around
 * it.
 */
function contextFor(root: string, seq: number): TakeTask['context'] {
  const brief = buildWritingBrief(root, { chapterSeq: seq })
  return {
    text: brief.text,
    tokens: brief.tokens,
    budgetTokens: brief.budgetTokens,
    overBudget: brief.overBudget,
    chapterSeq: brief.chapterSeq,
    planned: brief.chapterSeq !== seq,
    segments: brief.segments.map((segment) => ({
      id: segment.id,
      bytes: segment.bytes,
      tokens: segment.tokens,
      truncated: segment.truncated,
      missing: segment.missing,
    })),
  }
}

// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------

export interface CompleteInput {
  readonly jobId?: string
  readonly seq: number
  readonly body: string
  readonly now?: number
}

export interface CompleteResult {
  readonly state: JobState
  readonly seq: number
  readonly chapterId: string | null
  readonly path: string | null
  /** `true` only when the prose actually reached a chapter file. */
  readonly written: boolean
  readonly digest: string | null
  readonly gate: JobGateVerdict | null
  readonly paused: boolean
}

function gateVerdictOf(report: GateReport, paused: boolean): JobGateVerdict {
  const findings = report.findings.slice(0, JOB_GATE_FINDINGS_LIMIT).map((finding) => gateFindingRecord(finding))
  return {
    counts: {
      total: report.counts.total,
      warning: report.counts.warning,
      info: report.counts.info,
      fixable: report.counts.fixable,
    },
    checks: report.checks.map((summary) => ({ id: summary.id, label: summary.label, count: summary.count })),
    findings,
    returned: findings.length,
    truncated: report.findings.length > findings.length,
    paused,
  }
}

/** Whether a verdict is loud enough to stop the job (the policy never turns the gate off). */
export function pauseWorthy(verdict: { readonly total: number; readonly warning: number }, policy: PausePolicy): boolean {
  return verdict.warning > 0 || (policy === 'any' && verdict.total > 0)
}

/**
 * Turn one drafted chapter into a chapter file — **after** the seven gates have run over the
 * draft, and only when the verdict lets it through.
 *
 * The order is the requirement: 「门禁不通过 → paused 且没有写盘」. Gating a draft that is not on
 * disk is what makes that true rather than "wrote it, then put it back": `runGate` takes the
 * draft body as its input (the `draft` option in `gate.ts`), so nothing under `chapters/` is
 * created, touched or truncated before a clean verdict or a human says yes.
 *
 * A held draft is kept in the chapter record (`pendingBody`), so `approve` writes exactly the
 * bytes the gate judged — drafting them again would mean the gate judged something else.
 */
export async function completeChapter(root: string, input: CompleteInput): Promise<JobResult<CompleteResult>> {
  const body = typeof input.body === 'string' ? input.body : ''
  if (body.trim() === '') return refuse('BODY_REQUIRED', 'the drafted chapter body is empty')
  const now = input.now ?? Date.now()
  const stamp = new Date(now).toISOString()
  return lockedAsync(root, async (held) => {
    const current = readJob(held, input.jobId)
    if (!current.ok) return current
    const state = current.value
    const index = state.chapters.findIndex((chapter) => chapter.seq === input.seq)
    if (index < 0) {
      return refuse('CHAPTER_NOT_FOUND', `job ${state.jobId} has no chapter ${String(input.seq)}`, { seq: input.seq })
    }
    const chapter = state.chapters[index]
    if (chapter === undefined) {
      return refuse('CHAPTER_NOT_FOUND', `job ${state.jobId} has no chapter ${String(input.seq)}`, { seq: input.seq })
    }
    if (chapter.status !== 'running') {
      return refuse(
        'CHAPTER_NOT_CLAIMED',
        `chapter ${String(chapter.seq)} is ${chapter.status}, not claimed; take it with inkflow_batch_take first`,
        { seq: chapter.seq },
      )
    }

    const gated = runGate(
      held,
      chapter.path === null ? {} : { chapterPath: chapter.path },
      {
        record: false,
        draft: {
          body,
          title: chapter.title,
          seq: chapter.seq,
          ...(chapter.path === null ? {} : { path: chapter.path }),
        },
      },
    )
    if (!gated.ok) {
      return refuse('GATE_FAILED', `the quality gate could not run: ${gated.error.message}`, {
        seq: chapter.seq,
        ...(gated.error.hint === undefined ? {} : { hint: gated.error.hint }),
      })
    }
    const hold = pauseWorthy(gated.report.counts, state.meta.pauseOn)
    const verdict = gateVerdictOf(gated.report, hold)

    if (hold) {
      const held_ = {
        ...chapter,
        status: 'held' as ChapterStatus,
        claimedAt: null,
        finishedAt: stamp,
        gate: verdict,
        pendingBody: body,
      }
      const chapters = [...state.chapters]
      chapters[index] = held_
      const saved = saveState(held, state.meta, chapters, [held_], stamp)
      if (!saved.ok) return saved
      return accept({
        state: saved.value,
        seq: chapter.seq,
        chapterId: chapter.chapterId,
        path: chapter.path,
        written: false,
        digest: null,
        gate: verdict,
        paused: true,
      })
    }

    const placed = await placeChapter(held, chapter, body)
    const next: JobChapter = placed.ok
      ? {
          ...chapter,
          status: 'done',
          chapterId: placed.value.chapterId,
          path: placed.value.path,
          claimedAt: null,
          finishedAt: stamp,
          digest: placed.value.digest,
          gate: verdict,
          pendingBody: null,
          lastError: null,
        }
      : {
          ...chapter,
          status: 'failed',
          claimedAt: null,
          finishedAt: stamp,
          gate: verdict,
          pendingBody: null,
          lastError: { code: placed.error.code, message: placed.error.message },
        }
    const chapters = [...state.chapters]
    chapters[index] = next
    const saved = saveState(held, state.meta, chapters, [next], stamp)
    if (!saved.ok) return saved
    if (!placed.ok) {
      return refuse(placed.error.code, placed.error.message, {
        seq: chapter.seq,
        ...(placed.error.hint === undefined ? {} : { hint: placed.error.hint }),
      })
    }
    return accept({
      state: saved.value,
      seq: chapter.seq,
      chapterId: next.chapterId,
      path: next.path,
      written: true,
      digest: next.digest,
      gate: verdict,
      paused: false,
    })
  })
}

/**
 * The one write path: create the chapter, write the body, then read the bytes back so the
 * recorded digest describes the file rather than the string that was handed in.
 *
 * Two `chapters.ts` calls, one critical section (the lock nests), so no other session can slip
 * between "the chapter exists" and "it has prose". If the second half fails, the half-created
 * chapter goes to the recovery bin instead of being left as an empty file that the next run
 * would have to guess about.
 */
async function placeChapter(
  root: string,
  chapter: JobChapter,
  body: string,
): Promise<JobResult<{ chapterId: string; path: string; digest: string }>> {
  const created = await createChapter(root, {
    title: chapter.title,
    seq: chapter.seq,
    ...(chapter.volumeId === null ? {} : { volumeId: chapter.volumeId }),
    indexCommit: false,
  })
  if (!created.ok) {
    return refuse(created.error.code, created.error.message, {
      ...(created.error.path === undefined ? {} : { path: created.error.path }),
      ...(created.error.hint === undefined ? {} : { hint: created.error.hint }),
    })
  }
  const written = await writeChapter(root, { chapterId: created.chapter.chapterId, body, indexCommit: true })
  if (!written.ok) {
    // No empty chapter left behind: a half-write must not look like a finished task.
    await deleteChapter(root, { file: created.chapter.file })
    return refuse(written.error.code, written.error.message, {
      ...(written.error.path === undefined ? {} : { path: written.error.path }),
      ...(written.error.hint === undefined ? {} : { hint: written.error.hint }),
    })
  }
  const digest = chapterDigest(root, written.chapter.file)
  if (digest === null) {
    return refuse('CHAPTER_WRITE_FAILED', `${written.chapter.file} was written but cannot be read back`, {
      path: written.chapter.file,
    })
  }
  return accept({ chapterId: written.chapter.chapterId, path: written.chapter.file, digest })
}

// ---------------------------------------------------------------------------
// approve / resume
// ---------------------------------------------------------------------------

export interface ApproveInput {
  readonly jobId?: string
  readonly seq?: number
  readonly all?: boolean
  readonly confirm?: boolean
  readonly now?: number
}

export interface ApproveResult {
  readonly state: JobState
  readonly approved: readonly number[]
  readonly written: readonly { readonly seq: number; readonly chapterId: string; readonly path: string; readonly digest: string }[]
}

/**
 * Write the drafts a human has approved (`inkflow_batch_approve` / the panel's approve call).
 *
 * This is the second half of the gate's promise: `complete` refused to write, and the only way
 * forward is a caller that names the chapter and says `confirm: true`. The bytes written are
 * the ones the gate judged (`pendingBody`), and the verdict stays in the record — approval
 * overrides a warning, it does not erase it.
 */
export async function approveDrafts(root: string, input: ApproveInput): Promise<JobResult<ApproveResult>> {
  if (input.confirm !== true) {
    return refuse('CONFIRM_REQUIRED', 'approving a gated draft writes a chapter file', {
      hint: 'pass confirm: true together with the seq (or all: true) — the draft was gated and is stored, so nothing is re-generated',
    })
  }
  const now = input.now ?? Date.now()
  const stamp = new Date(now).toISOString()
  return lockedAsync(root, async (held) => {
    const current = readJob(held, input.jobId)
    if (!current.ok) return current
    const state = current.value
    const targets = state.chapters.filter(
      (chapter) =>
        chapter.status === 'held' &&
        (input.all === true || (input.seq !== undefined && chapter.seq === input.seq)),
    )
    if (targets.length === 0) {
      return refuse(
        'CHAPTER_NOT_HELD',
        input.seq === undefined && input.all !== true
          ? 'say which chapter to approve (seq), or all: true'
          : 'no gated draft matches; only a chapter that complete put on hold can be approved',
        { ...(input.seq === undefined ? {} : { seq: input.seq }) },
      )
    }
    const chapters = [...state.chapters]
    const written: { seq: number; chapterId: string; path: string; digest: string }[] = []
    for (const chapter of targets) {
      const body = chapter.pendingBody ?? ''
      if (body.trim() === '') {
        return refuse('BODY_REQUIRED', `chapter ${String(chapter.seq)} has no stored draft to approve`, { seq: chapter.seq })
      }
      const placed = await placeChapter(held, chapter, body)
      const index = chapters.findIndex((entry) => entry.seq === chapter.seq)
      if (!placed.ok) {
        chapters[index] = {
          ...chapter,
          status: 'failed',
          claimedAt: null,
          finishedAt: stamp,
          lastError: { code: placed.error.code, message: placed.error.message },
        }
        const failed = saveState(held, state.meta, chapters, [chapters[index]], stamp)
        if (!failed.ok) return failed
        return refuse(placed.error.code, placed.error.message, {
          seq: chapter.seq,
          ...(placed.error.hint === undefined ? {} : { hint: placed.error.hint }),
        })
      }
      chapters[index] = {
        ...chapter,
        status: 'done',
        chapterId: placed.value.chapterId,
        path: placed.value.path,
        finishedAt: stamp,
        digest: placed.value.digest,
        pendingBody: null,
        lastError: null,
      }
      written.push({ seq: chapter.seq, ...placed.value })
    }
    const saved = saveState(held, state.meta, chapters, chapters, stamp)
    if (!saved.ok) return saved
    return accept({ state: saved.value, approved: written.map((entry) => entry.seq), written })
  })
}

export interface ResumeInput {
  readonly jobId?: string
  readonly now?: number
}

/**
 * Continue a job after an interruption (`POST /batch/resume`, the panel's 续跑 button).
 *
 * Two different pauses, two different doors, and this one is not the gate's:
 *
 *   * a `failed` chapter goes back to `pending` with a fresh attempt budget — a human decided
 *     to try again, and the old error stays in the record until the next `take` clears it;
 *   * a `paused` job with held drafts is **refused** (`APPROVAL_REQUIRED`): resuming must not
 *     become "write without the gate", so the drafts have to go through `approve`.
 *
 * Expired claims are left alone: `take` re-claims them, which is where attempts are counted.
 */
export function resumeJob(root: string, input: ResumeInput = {}): JobResult<JobState> {
  const now = input.now ?? Date.now()
  const stamp = new Date(now).toISOString()
  return locked(root, (held) => {
    const current = readJob(held, input.jobId)
    if (!current.ok) return current
    const state = current.value
    const heldSeqs = state.chapters.filter((chapter) => chapter.status === 'held').map((chapter) => chapter.seq)
    if (heldSeqs.length > 0) {
      return refuse('APPROVAL_REQUIRED', `${String(heldSeqs.length)} gated draft(s) are waiting for a human decision`, {
        hint: 'approve them with inkflow_batch_approve (confirm: true) — resuming does not skip the gate',
      })
    }
    const retried: JobChapter[] = []
    const chapters = state.chapters.map((chapter) => {
      if (chapter.status !== 'failed') return chapter
      const next: JobChapter = { ...chapter, status: 'pending', attempts: 0, claimedAt: null }
      retried.push(next)
      return next
    })
    if (retried.length === 0 && state.meta.status === 'running') return accept(state)
    const saved = saveState(held, { ...state.meta, status: 'running' }, chapters, retried, stamp)
    if (!saved.ok) return saved
    return accept(saved.value)
  })
}
