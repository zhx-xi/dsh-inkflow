/**
 * Issue #47 — the drafting half: `complete` (gate first, write second) and `approve`.
 *
 * Extracted from `jobs.ts` by #193, and split from the queue half (`jobs-actions.ts`)
 * because this is the only place in a batch job where a chapter file can change, and a
 * thousand-line file is not where a write path should be hard to find.
 *
 * ## What this module owns
 *
 *   * `completeChapter`: run the seven quality gates over the draft **before anything is
 *     written**. A clean verdict → `placeChapter` writes through `chapters.ts` and the record
 *     keeps the bytes' digest; a warning (or any finding, when the job was created with
 *     `pauseOn: 'any'`) → the job pauses, the draft is kept in the record as `pendingBody`,
 *     and **no chapter file is created**;
 *   * `approveDrafts`: write the drafts a human approved — the bytes the gate judged, with
 *     the verdict kept beside them (approving overrides a warning, it does not erase it);
 *   * `gateVerdictOf` / `pauseWorthy`: the one translation from a `GateReport` to what the
 *     job record keeps (counts always, findings sampled) and the `pauseOn` policy.
 *
 * ## What it refuses to own
 *
 *   * a pause policy it invented — it comes from the job record (`pauseOn`), never from here;
 *   * the gate's judgements (归 `gate.ts`；这里只搬运结论）、the record format and the lock
 *     (归 `jobs-store.ts`)、claiming and queueing (归 `jobs-actions.ts`)、drafting (X-26)。
 */

import { createChapter, deleteChapter, writeChapter } from './chapters.js'
import { gateFindingRecord, runGate } from './gate.js'
import type { GateReport } from './gate.js'
import {
  JOB_GATE_FINDINGS_LIMIT,
  accept,
  refuse,
} from './jobs-model.js'
import type { ChapterStatus, JobChapter, JobGateVerdict, JobResult, JobState, PausePolicy } from './jobs-model.js'
import { chapterDigest, lockedAsync, readJob, saveState } from './jobs-store.js'

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
