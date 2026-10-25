/**
 * Issue #47 — the job record on disk: paths, read-back, save, and the write lock around it.
 *
 * Extracted from `jobs.ts` by #193. This is the only job module that touches the
 * filesystem, and the only one that takes the project write lock — which is why it is a
 * file of its own: every other job module composes these calls, and none of them can widen
 * the blast radius without editing this one.
 *
 * ## What this module owns
 *
 *   * the layout `.inkflow/jobs/<jobId>/{meta.json,chapters/<seq>.json}` (ADR-0023) and the
 *     job-id shape (`bj-` + eight hex characters, minted here, never by a caller);
 *   * reading back (`readMeta`, `readChapters` and the defensive coercers, `readJob`,
 *     `listJobs`, `resolveJobId`): a stranger's file is refused rather than guessed at;
 *   * saving (`saveChapter`, `saveState`): `meta.chapters` is a **roll-up** rewritten from
 *     the chapter files on every save, so the two are never two truths;
 *   * the lock helpers (`locked` / `lockedAsync` / `lockFailure` / `lockHolderOf`): one
 *     synchronous critical section under `withProjectWriteLock`, released before returning,
 *     and a refusal is `PROJECT_BUSY` **plus** who holds the lock (X-30);
 *   * the facts that decide a chapter's fate: `chapterDigest` (the sha256 of the bytes that
 *     were written) and `reconcileChapter` (digest matches → already done; differs → the
 *     author took the chapter over, so `edited` and terminal), plus `claimExpired` /
 *     `inFlightCount` for the claim lease.
 *
 * ## What it refuses to own
 *
 *   * what an action means — enqueue / take / complete / approve / resume live in
 *     `jobs-actions.ts` and `jobs-drafts.ts`；
 *   * writing chapter prose (归 `chapters.ts`，由 `jobs-drafts.ts` 调用）；
 *   * holding the lock across a model call (X-30：锁只包住一次读写，不包住思考）。
 */

import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { INDEX_DIR } from './conventions.js'
import { readText } from './domains/scan-helpers.js'
import { acquireProjectWriteLock, withProjectWriteLock, writeJsonAtomic } from './io.js'
import type { IoFailure } from './io.js'
import { ensurePrivateStateIgnored, privateStateRelative } from './private-state.js'
import {
  CHAPTER_STATUSES,
  CLAIM_LEASE_MS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  JOB_CHAPTER_FORMAT,
  JOB_CHAPTERS_DIR,
  JOB_FORMAT,
  JOB_ID_PATTERN,
  JOB_ID_PREFIX,
  JOB_META_FILE,
  JOB_SCHEMA_VERSION,
  JOB_STATUSES,
  PAUSE_POLICIES,
  accept,
  refuse,
} from './jobs-model.js'
import type { ChapterStatus, JobChapter, JobChapterRef, JobGateVerdict, JobMeta, JobPause, JobResult, JobState, JobStatus, PausePolicy } from './jobs-model.js'

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

export function absoluteOf(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'))
}

/** A new job id: four random bytes, so two sessions cannot mint the same one. */
export function mintJobId(): string {
  return `${JOB_ID_PREFIX}${randomBytes(4).toString('hex')}`
}

// ---------------------------------------------------------------------------
// Reading and writing JSON under `.inkflow/jobs/`

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

export function isPausePolicy(value: unknown): value is PausePolicy {
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
export function readMeta(root: string, jobId: string): JobResult<JobMeta> {
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
export function saveState(
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
export function pauseReasonFor(chapters: readonly JobChapter[], current: JobPause | null): JobPause | null {
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
export function locked<T>(root: string, body: (root: string) => JobResult<T>): JobResult<T> {
  const held = withProjectWriteLock(root, () => body(root))
  if (held.ok) return held.value
  return lockFailure(root, held.error)
}

/**
 * One asynchronous critical section (a chapter write is `async`: `chapters.ts` awaits the
 * index rebuild). `withProjectWriteLock` takes a synchronous body, so the lock is acquired
 * and released by hand here — the same lock, the same re-entrancy, one `finally`.
 */
export async function lockedAsync<T>(root: string, body: (root: string) => Promise<JobResult<T>>): Promise<JobResult<T>> {
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

export function claimExpired(chapter: JobChapter, now: number): boolean {
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
