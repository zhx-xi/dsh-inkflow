/**
 * The batch panel's read projection and its one write (#47, roadmap X-12/X-30).
 *
 * `GET /batch` answers "what is this job doing" from the job's own files and **nothing else**:
 * no index rebuild (a job must be readable on a book whose `index/` was just deleted — that is
 * exactly when the author wants to know whether the batch survived), no write of any kind, and
 * no model. The page therefore shows the same bytes the tools read, one revision at a time.
 *
 * Why a separate module from `jobs.ts`: the engine owns the state machine and holds the lock;
 * this file owns the *shape the browser sees* — which fields are stable, what the panel may
 * rely on, and the one path that writes (`resume`). Keeping them apart is what lets the panel
 * model be tested against a hand-written payload without a book (`batch-model.ts`).
 *
 * The resume route writes **no prose**: it re-queues failed chapters and clears the resumed
 * status. A job paused at the gate is refused with `APPROVAL_REQUIRED`, so the button can
 * never become a way around the gate — the approval itself stays with `inkflow_batch_approve`
 * (a tool, i.e. the author telling the session what to do), never a click that writes prose.
 */

import { CLAIM_LEASE_MS, inFlightCount, listJobs, readJob, resumeJob } from './jobs.js'
import type { JobChapter, JobState, JobMeta } from './jobs.js'

/** The one body field the resume route accepts (besides `sessionId`). */
export const BATCH_RESUME_BODY_FIELDS = ['jobId'] as const

const RESUME_HINT =
  'a job paused by the quality gate needs inkflow_batch_approve (confirm: true); resuming only retries failed chapters'

export interface BatchChapterRow {
  readonly seq: number
  readonly title: string
  readonly status: string
  readonly attempts: number
  readonly chapterId: string | null
  readonly path: string | null
  readonly digest: string | null
  readonly lastError: { readonly code: string; readonly message: string } | null
  /** Counts always cover all findings; `findings` is a sample (the panel prints the counts). */
  readonly gate: {
    readonly total: number
    readonly warning: number
    readonly info: number
    readonly paused: boolean
    readonly checks: readonly { readonly id: string; readonly label: string; readonly count: number }[]
    readonly findings: readonly { readonly check: string; readonly severity: string; readonly detail: string }[]
    readonly truncated: boolean
  } | null
  /** `true` when a gated draft is stored and can be approved without drafting it again. */
  readonly hasDraft: boolean
}

export interface BatchCounts {
  readonly total: number
  readonly pending: number
  readonly running: number
  readonly held: number
  readonly done: number
  readonly edited: number
  readonly failed: number
}

export interface BatchDetail {
  readonly jobId: string
  readonly dir: string
  readonly status: string
  readonly concurrency: number
  readonly batchSize: number
  readonly pauseOn: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly pauseReason: { readonly code: string; readonly message: string; readonly seqs: readonly number[] } | null
  readonly counts: BatchCounts
  /** Claims that are still alive right now, and chapters that can still be claimed. */
  readonly inFlight: number
  readonly remaining: number
  readonly chapters: readonly BatchChapterRow[]
}

export interface BatchPage {
  readonly jobs: readonly { readonly jobId: string; readonly status: string; readonly total: number; readonly done: number }[]
  readonly selected: BatchDetail | null
  /** Present when `jobId` named a job that could not be read: the page says why, then lists. */
  readonly error: { readonly code: string; readonly message: string; readonly hint?: string } | null
}

function countsOf(chapters: readonly JobChapter[]): BatchCounts {
  const count = (status: string): number => chapters.filter((chapter) => chapter.status === status).length
  return {
    total: chapters.length,
    pending: count('pending'),
    running: count('running'),
    held: count('held'),
    done: count('done'),
    edited: count('edited'),
    failed: count('failed'),
  }
}

function rowOf(chapter: JobChapter): BatchChapterRow {
  const gate = chapter.gate
  return {
    seq: chapter.seq,
    title: chapter.title,
    status: chapter.status,
    attempts: chapter.attempts,
    chapterId: chapter.chapterId,
    path: chapter.path,
    digest: chapter.digest,
    lastError: chapter.lastError,
    gate:
      gate === null
        ? null
        : {
            total: gate.counts.total,
            warning: gate.counts.warning,
            info: gate.counts.info,
            paused: gate.paused,
            checks: gate.checks,
            findings: gate.findings.map((finding) => ({
              check: String(finding['check'] ?? ''),
              severity: String(finding['severity'] ?? ''),
              detail: String(finding['detail'] ?? ''),
            })),
            truncated: gate.truncated,
          },
    hasDraft: chapter.pendingBody !== null,
  }
}

function detailOf(state: JobState, now: number): BatchDetail {
  const meta: JobMeta = state.meta
  return {
    jobId: state.jobId,
    dir: state.dir,
    status: meta.status,
    concurrency: meta.concurrency,
    batchSize: meta.batchSize,
    pauseOn: meta.pauseOn,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    pauseReason: meta.pauseReason,
    counts: countsOf(state.chapters),
    inFlight: inFlightCount(state.chapters, now),
    remaining: state.chapters.filter((chapter) => chapter.status === 'pending').length,
    chapters: state.chapters.map(rowOf),
  }
}

/** `GET /batch`: read-only, and it never rebuilds the index it does not need. */
export function buildBatchPage(
  source: { readonly sessionId: string; readonly root: string },
  version: string,
  options: { readonly jobId?: string } = {},
): { status: number; body: Record<string, unknown> } {
  const wanted = (options.jobId ?? '').trim()
  const jobs = listJobs(source.root).map((job) => ({
    jobId: job.jobId,
    status: job.status,
    total: job.total,
    done: job.done,
  }))
  if (jobs.length === 0 && wanted === '') {
    return {
      status: 200,
      body: { ok: true, value: { pluginVersion: version, sessionId: source.sessionId, jobs: [], selected: null, error: null } },
    }
  }
  const state = readJob(source.root, wanted === '' ? undefined : wanted)
  if (!state.ok) {
    return {
      status: state.error.code === 'JOB_NOT_FOUND' ? 404 : 500,
      body: {
        ok: true,
        value: {
          pluginVersion: version,
          sessionId: source.sessionId,
          jobs,
          selected: null,
          error: {
            code: state.error.code,
            message: state.error.message,
            ...(state.error.hint === undefined ? {} : { hint: state.error.hint }),
          },
        },
      },
    }
  }
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        jobs,
        selected: detailOf(state.value, Date.now()),
        error: null,
      },
    },
  }
}

function listRows(root: string): BatchPage['jobs'] {
  return listJobs(root).map((job) => ({ jobId: job.jobId, status: job.status, total: job.total, done: job.done }))
}

/** `POST /batch/resume`: continue a job after an interruption, writing no prose. */
export function resumeViaChannel(
  target: { readonly sessionId: string; readonly root: string },
  version: string,
  body: Record<string, unknown>,
): { status: number; body: Record<string, unknown> } {
  const jobId = typeof body['jobId'] === 'string' && body['jobId'].trim() !== '' ? body['jobId'].trim() : undefined
  const resumed = resumeJob(target.root, jobId === undefined ? {} : { jobId })
  if (!resumed.ok) {
    const code = resumed.error.code
    return {
      status: code === 'JOB_NOT_FOUND' || code === 'JOB_UNREADABLE' ? 404 : code === 'APPROVAL_REQUIRED' ? 409 : 500,
      body: {
        ok: false,
        error: {
          code,
          message: resumed.error.message,
          hint: resumed.error.hint ?? RESUME_HINT,
        },
      },
    }
  }
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: target.sessionId,
        selected: detailOf(resumed.value, Date.now()),
      },
    },
  }
}
