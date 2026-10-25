/**
 * The 批量 page's decisions (#47, roadmap X-12).
 *
 * Pure by construction: no React, no network, no IO — the same shape as the other
 * `*-model.ts` files, so the panel's wording and its three states are unit-tested against the
 * built artifact instead of being inspected by hand in a browser.
 *
 * What lives here is exactly what a user reads:
 *
 *   * **三态** — `empty` (this book has no batch job), `active` (a job with something still to
 *     do, including "waiting for approval") and `closed` (`done` / `failed`: nothing left).
 *     A view that collapsed "paused at the gate" into "running" would hide the one state that
 *     needs a person.
 *   * **一句话说状态** — one sentence per chapter status, and per job status, in the author's
 *     words rather than the record's codes.
 *   * **按钮能不能点** — 续跑 is the only action, and it is disabled for a reason the page can
 *     print: a job paused at the gate needs an approval, not a resume.
 */

/** One chapter row as `GET /batch` returns it. */
export interface BatchChapterView {
  seq: number
  title: string
  status: string
  attempts: number
  chapterId: string | null
  path: string | null
  lastError: { code: string; message: string } | null
  gate: {
    total: number
    warning: number
    info: number
    paused: boolean
    checks: { id: string; label: string; count: number }[]
    findings: { check: string; severity: string; detail: string }[]
    truncated: boolean
  } | null
  hasDraft: boolean
}

export interface BatchJobView {
  jobId: string
  dir: string
  status: string
  concurrency: number
  batchSize: number
  pauseOn: string
  createdAt: string
  updatedAt: string
  pauseReason: { code: string; message: string; seqs: number[] } | null
  counts: {
    total: number
    pending: number
    running: number
    held: number
    done: number
    edited: number
    failed: number
  }
  inFlight: number
  remaining: number
  chapters: BatchChapterView[]
}

export interface BatchJobRow {
  jobId: string
  status: string
  total: number
  done: number
}

export interface BatchPageView {
  jobs: BatchJobRow[]
  selected: BatchJobView | null
  /** A job the request named that could not be read: the page says why instead of guessing. */
  error: { code: string; message: string; hint?: string } | null
  /** No session, a failed fetch, or a body that is not the expected envelope. */
  transport: string | null
}

/** The three states the page can be in, decided here and not in the component. */
export type BatchPanelState = 'empty' | 'active' | 'closed'

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function chapterOf(raw: unknown): BatchChapterView {
  const row = record(raw)
  const gate = record(row['gate'])
  return {
    seq: num(row['seq']),
    title: str(row['title'], `#${String(num(row['seq']))}`),
    status: str(row['status'], 'pending'),
    attempts: num(row['attempts']),
    chapterId: typeof row['chapterId'] === 'string' ? row['chapterId'] : null,
    path: typeof row['path'] === 'string' ? row['path'] : null,
    lastError:
      typeof row['lastError'] === 'object' && row['lastError'] !== null
        ? {
            code: str(record(row['lastError'])['code'], 'ERROR'),
            message: str(record(row['lastError'])['message']),
          }
        : null,
    gate:
      Object.keys(gate).length === 0
        ? null
        : {
            total: num(gate['total']),
            warning: num(gate['warning']),
            info: num(gate['info']),
            paused: gate['paused'] === true,
            checks: Array.isArray(gate['checks'])
              ? (gate['checks'] as unknown[]).map((item) => ({
                  id: str(record(item)['id']),
                  label: str(record(item)['label']),
                  count: num(record(item)['count']),
                }))
              : [],
            findings: Array.isArray(gate['findings'])
              ? (gate['findings'] as unknown[]).map((item) => ({
                  check: str(record(item)['check']),
                  severity: str(record(item)['severity']),
                  detail: str(record(item)['detail']),
                }))
              : [],
            truncated: gate['truncated'] === true,
          },
    hasDraft: row['hasDraft'] === true,
  }
}

function jobOf(raw: unknown): BatchJobView {
  const row = record(raw)
  const counts = record(row['counts'])
  const pause = record(row['pauseReason'])
  return {
    jobId: str(row['jobId']),
    dir: str(row['dir']),
    status: str(row['status'], 'running'),
    concurrency: num(row['concurrency'], 3),
    batchSize: num(row['batchSize'], 3),
    pauseOn: str(row['pauseOn'], 'warning'),
    createdAt: str(row['createdAt']),
    updatedAt: str(row['updatedAt']),
    pauseReason:
      pause['code'] === undefined
        ? null
        : {
            code: str(pause['code']),
            message: str(pause['message']),
            seqs: Array.isArray(pause['seqs']) ? (pause['seqs'] as unknown[]).map((item) => num(item)) : [],
          },
    counts: {
      total: num(counts['total']),
      pending: num(counts['pending']),
      running: num(counts['running']),
      held: num(counts['held']),
      done: num(counts['done']),
      edited: num(counts['edited']),
      failed: num(counts['failed']),
    },
    inFlight: num(row['inFlight']),
    remaining: num(row['remaining']),
    chapters: Array.isArray(row['chapters']) ? (row['chapters'] as unknown[]).map(chapterOf) : [],
  }
}

/** `GET /batch`'s envelope → the page's view, never throwing on a shape it does not know. */
export function readBatchPage(result: { ok: boolean; value?: unknown; error?: unknown } | null): BatchPageView {
  if (result === null) {
    return { jobs: [], selected: null, error: null, transport: 'NETWORK' }
  }
  if (!result.ok) {
    const error = record(result.error)
    return { jobs: [], selected: null, error: null, transport: str(error['code'], 'FETCH_FAILED') }
  }
  const value = record(result.value)
  const failure = record(value['error'])
  return {
    jobs: Array.isArray(value['jobs'])
      ? (value['jobs'] as unknown[]).map((item) => ({
          jobId: str(record(item)['jobId']),
          status: str(record(item)['status']),
          total: num(record(item)['total']),
          done: num(record(item)['done']),
        }))
      : [],
    selected: value['selected'] === null || value['selected'] === undefined ? null : jobOf(value['selected']),
    error:
      failure['code'] === undefined
        ? null
        : {
            code: str(failure['code']),
            message: str(failure['message']),
            ...(typeof failure['hint'] === 'string' ? { hint: failure['hint'] } : {}),
          },
    transport: null,
  }
}

/** The page's state: no job at all, a job still moving, or a job with nothing left to do. */
export function batchPanelState(page: BatchPageView): BatchPanelState {
  if (page.selected === null) return 'empty'
  const job = page.selected
  const open =
    job.counts.pending > 0 || job.counts.running > 0 || job.counts.held > 0 || job.status === 'paused'
  return open ? 'active' : 'closed'
}

/** The headline of the empty state: what the author has to do to get a queue. */
export const EMPTY_BATCH_NOTE =
  '这本书还没有批量作业。让 AI 建一个（说「排 20 章草稿」），它会用 inkflow_batch_enqueue 把章节任务排进 .inkflow/jobs/ —— 这一步不写任何正文。'

/** The one sentence that explains a chapter's state in the author's terms. */
export function describeChapterStatus(status: string): string {
  switch (status) {
    case 'pending':
      return '待写：还没被领取'
    case 'running':
      return '领取中：AI 正在写这一章'
    case 'done':
      return '已落盘：正文已写进章文件'
    case 'held':
      return '待批准：草稿过了门禁但有问题，等你点头'
    case 'failed':
      return '失败：这一章没写成，原因见下'
    case 'edited':
      return '作者改过：作业写完你又动过它，作业不会再碰它'
    default:
      return status
  }
}

/** The job's own one-liner, so the header never prints a raw status code. */
export function describeJobStatus(status: string): string {
  switch (status) {
    case 'running':
      return '进行中'
    case 'paused':
      return '已暂停（等人工批准）'
    case 'done':
      return '全部完成'
    case 'failed':
      return '有章节失败'
    default:
      return status
  }
}

/** `门禁 12 项（需要处理 2 · 提示 10）` — the same counts the tool reply prints. */
export function describeGate(gate: BatchChapterView['gate']): string | null {
  if (gate === null) return null
  if (gate.total === 0) return '门禁 0 项（八项都没发现问题）'
  return `门禁 ${gate.total} 项（需要处理 ${gate.warning} · 提示 ${gate.info}）${gate.paused ? ' → 停下来等批准' : ''}`
}

/** One line per chapter: the status sentence, the attempts, and where it landed. */
export function describeChapter(chapter: BatchChapterView): string {
  const bits = [`第 ${chapter.seq} 章 · ${describeChapterStatus(chapter.status)}`]
  if (chapter.attempts > 1) bits.push(`领取 ${chapter.attempts} 次`)
  if (chapter.path !== null) bits.push(chapter.path)
  return bits.join(' · ')
}

/** Why the job is paused, in one sentence; `null` when it is not. */
export function describePause(job: BatchJobView): string | null {
  const pause = job.pauseReason
  if (pause === null) return null
  const seqs = pause.seqs.length > 0 ? `（第 ${pause.seqs.join('、')} 章）` : ''
  return `已暂停：${pause.message}${seqs} —— 草稿存在作业记录里，等人工批准；批准走 inkflow_batch_approve（confirm: true）。`
}

/**
 * Whether 续跑 can be pressed, and the sentence that explains a disabled button.
 *
 * A gate pause is **not** resumable: approving is the door, so the page says so instead of
 * offering a button that would either do nothing or (worse) write prose without the gate.
 */
export function resumeBlockedReason(job: BatchJobView): string | null {
  if (job.counts.held > 0 || job.status === 'paused') {
    return '暂停是门禁造成的：先批准草稿（让 AI 调用 inkflow_batch_approve），续跑不会跳过门禁。'
  }
  if (job.counts.running > 0) {
    return `AI 正在写（在写 ${job.counts.running} 章），没有需要续跑的东西。`
  }
  if (job.status === 'running' && job.counts.failed === 0 && job.counts.pending > 0) {
    return '作业还在进行，没有需要续跑的东西。'
  }
  if (job.status === 'running' && job.counts.failed === 0 && job.counts.pending === 0) {
    return '没有待写的章了。'
  }
  if (job.status === 'done') return '全部写完了，没有需要续跑的东西。'
  return null
}

/** The resume request body: the resolved job, nothing else (the route whitelists `jobId`). */
export function resumePayload(jobId: string): Record<string, unknown> {
  return { jobId }
}

/** The heading of one job row in the selector. */
export function describeJobRow(row: BatchJobRow): string {
  return `${row.jobId} · ${describeJobStatus(row.status)} · ${row.done}/${row.total} 章已落盘`
}
