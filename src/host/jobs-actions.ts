/**
 * The queue's own actions: `enqueue`, `take`, `resume`.
 *
 * Extracted from `jobs.ts` when it was split, and split from the drafting half (`jobs-drafts.ts`)
 * because the two answer different questions: this file decides **what to write next**, the
 * other decides **whether a draft may land**.
 *
 * ## What this module owns
 *
 *   * `enqueueJob`: write the job's own record only — zero content writes, and re-enqueueing
 *     a `seq` the job already has is a no-op reported in `skipped`;
 *   * `takeBatch`: claim up to `batchSize` chapters inside `concurrency − inFlight`, each
 *     with its writing context assembled (`contextFor` → `buildWritingBrief`). A claim
 *     carries `claimedAt` and expires after `CLAIM_LEASE_MS`, so one kill does not make the
 *     job unwritable, while a live claim is never handed out twice;
 *   * `resumeJob`: put `failed` chapters back in the queue. A job paused at a human approval
 *     point is refused with `APPROVAL_REQUIRED` — resuming is not a way around a person.
 *
 * ## What it refuses to own
 *
 *   * writing prose or gating a draft (归 `jobs-drafts.ts`：`complete` / `approve`）
 *   * the record's file format and the lock (归 `jobs-store.ts`)、the panel projection
 *     (归 `jobs-wire.ts`)、drafting itself (插件零模型调用，X-26)。
 */

import { existsSync } from 'node:fs'

import { readCatalog } from './catalog.js'
import type { CatalogChapter } from './catalog.js'
import {
  DEFAULT_BATCH_SIZE,
  JOB_CHAPTER_FORMAT,
  JOB_FORMAT,
  JOB_SCHEMA_VERSION,
  DEFAULT_CONCURRENCY,
  MAX_ATTEMPTS,
  MAX_BATCH_SIZE,
  MAX_CONCURRENCY,
  accept,
  refuse,
} from './jobs-model.js'
import type { JobChapter, JobMeta, JobResult, JobState, PausePolicy } from './jobs-model.js'
import {
  absoluteOf,
  claimExpired,
  inFlightCount,
  isJobId,
  isPausePolicy,
  jobMetaPath,
  locked,
  mintJobId,
  readJob,
  reconcileChapter,
  saveState,
} from './jobs-store.js'
import { buildWritingBrief } from './writing-context.js'

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
 * The book's next free chapter number: the highest `seq` the book already uses, plus one.
 *
 * Read from the **projection** (`readCatalog` → the `.md` files), not from the derived index:
 * `enqueue` writes only `.inkflow/jobs/` and never rebuilds the index, so asking the index would
 * make the answer depend on whether something else happened to read the book recently. The
 * projection is also what the panel and the export put in front of the author, and `catalog.ts`
 * imports no job module, so this dependency stays one-way.
 *
 * Gaps are **not** backfilled. A missing number means the author removed or renumbered a chapter
 * on purpose, and chapter numbers carry reading order: filling 7 because 7 is free would drop a
 * new chapter into the middle of the book instead of after its last chapter.
 */
function bookNextSeq(root: string): number {
  const projection = readCatalog(root)
  let highest = 0
  const consider = (chapter: CatalogChapter): void => {
    if (chapter.seq !== undefined && chapter.seq > highest) highest = chapter.seq
  }
  projection.catalog.looseChapters.forEach(consider)
  for (const volume of projection.volumeCatalogs) volume.chapters.forEach(consider)
  return highest + 1
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
    // 「省略 seq」means the book's next chapter, not the job's. A brand-new job has no chapters
    // of its own, so a job-only counter starts at 1 — and chapter 1 of a book that already has
    // eleven is taken, which `complete` refuses with SEQ_CONFLICT after the draft was written.
    // An explicit `seq` is still authoritative, so a call that names every number never reads
    // the book at all. Both floors apply: whichever is higher wins, so adding chapters to a job
    // that already holds 12/13 continues at 14 even while the book still ends at 11.
    const bookFloor = input.chapters.some((item) => item.seq === undefined) ? bookNextSeq(held) : 1
    let nextSeq = Math.max(bookFloor, chapters.reduce((max, chapter) => Math.max(max, chapter.seq), 0) + 1)
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
