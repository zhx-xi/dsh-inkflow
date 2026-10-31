/**
 * The batch tool surface: `inkflow_batch_enqueue` / `_take` / `_complete` / `_approve`.
 *
 * Four tools, one loop, and the split is the milestone's rule (roadmap X-26): the plugin owns
 * the queue, the gate and the write; **the session's model owns the prose**. There is no "write
 * 20 chapters" tool on purpose — a tool that drafted would need a model client, which this
 * plugin does not have.
 *
 * ```
 * enqueue  → what this job is (writes only .inkflow/jobs/, never a chapter)
 * take     → claim up to N chapters + the writing context for each one
 * complete → gate the draft; write it, or hold it for approval (nothing is written on hold)
 * approve  → write the drafts a human approved (confirm: true)
 * ```
 *
 * `resume` is deliberately **not** here: it is the panel's 续跑 button (`POST /batch/resume`,
 * `jobs-wire.ts`). Retrying a failed chapter is a human decision about a broken run, and the
 * surface the issue asks for is these four tools — a fifth one would have to be justified
 * against the whole milestone's tool budget.
 *
 * Why they are built-ins rather than domain tools: a job is not an entity, belongs to no
 * content directory, and its one write path is the chapter writer, which no domain module owns.
 *
 * Two behaviours the reply has to make unmissable, because a model reading a vague answer will
 * guess wrong:
 *
 *   * `complete` on a paused job returns `written: false` **and** the gate counts — the prose is
 *     stored in the job record, and only `approve` will land it;
 *   * `take` on a paused job hands back **no task** with `reason: 'PAUSED'`, so a model cannot
 *     "helpfully" draft past a human decision.
 */

import type { ContentBlock, HostContext, JsonSchemaNode, ToolDefinition, ToolRunContext } from './context.js'
import { gateFailure, resolveProject } from './domains/tool-project.js'
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  MAX_BATCH_SIZE,
  MAX_CONCURRENCY,
  PAUSE_POLICIES,
  approveDrafts,
  completeChapter,
  enqueueJob,
  takeBatch,
} from './jobs.js'
import type { ApproveResult, CompleteResult, JobState, TakeResult } from './jobs.js'
import { describeDelegation } from './delegation.js'
import { settingsOf } from './settings.js'
import { rememberProject } from './state.js'

type Json = Record<string, unknown>

export interface JobsToolDeps {
  readonly ctx: HostContext
  readonly dataDir: string
}

function text(lines: string[]): ContentBlock[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const PROJECT_ROOT_PARAM = {
  type: 'string',
  description:
    'Absolute path of the InkFlow project root. Omit to resolve from the session working directory (walks up to the nearest project). An explicit path must live within the session working directory.',
} as const

const JOB_ID_PARAM = {
  type: 'string',
  description:
    'The job to act on (bj- plus eight hex characters, minted by inkflow_batch_enqueue). Omit to use the newest job in this book; every reply carries the resolved id, so pass it next time.',
} as const

const SUCCESS_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: true,
}

const STATUS_LABELS: Readonly<Record<string, string>> = {
  running: '进行中',
  paused: '等人工批准',
  done: '已完成',
  failed: '有失败章',
}

const CHAPTER_LABELS: Readonly<Record<string, string>> = {
  pending: '待写',
  running: '领取中',
  done: '已落盘',
  held: '草稿待批准',
  failed: '失败',
  edited: '作者改过',
}

/** One refused call: the code, the sentence, and what the caller should do instead. */
function describeFailure(value: Json): ContentBlock[] {
  const error = asRecord(value['error'])
  const lines = [`批量作业没有跑成：${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
  if (error['hint'] !== undefined) lines.push(String(error['hint']))
  const holder = asRecord(error['lockHolder'])
  if (holder['pid'] !== undefined || holder['startedAt'] !== undefined) {
    lines.push(`占用写锁的是 pid ${String(holder['pid'] ?? '?')}（自 ${String(holder['startedAt'] ?? '未知')}）；等它写完再试。`)
  }
  return text(lines)
}

/**
 * The reply's own state section, read straight out of the wire value.
 *
 * Deliberately no "reconstruct a JobState from the wire" helper: the wire IS the contract here
 * (it is what the panel route and the tests read), and a second round-tripped shape would be a
 * third copy of the same facts to keep in step.
 */
function statusLine(value: Json): string {
  const counts = asRecord(value['counts'])
  const status = String(value['status'] ?? '')
  const label = STATUS_LABELS[status] ?? status
  return (
    `作业 ${String(value['jobId'] ?? '')}（${String(value['dir'] ?? '')}）· ${label} · ` +
    `共 ${String(Number(counts['total'] ?? 0))} 章：待写 ${String(Number(counts['pending'] ?? 0))} · ` +
    `领取中 ${String(Number(counts['running'] ?? 0))} · ` +
    `已落盘 ${String(Number(counts['done'] ?? 0))} · 待批准 ${String(Number(counts['held'] ?? 0))} · ` +
    `失败 ${String(Number(counts['failed'] ?? 0))}` +
    (Number(counts['edited'] ?? 0) > 0 ? ` · 作者改过 ${String(Number(counts['edited'] ?? 0))}` : '')
  )
}

/**
 * 「写作方式：…」 from the reply's `delegation` block, or nothing when it is absent.
 *
 * The words come from `delegation.ts` (`describeDelegation`), not from this renderer: the
 * same sentence is the first line of the injected policy, so the tool reply and the
 * system prompt cannot drift into two descriptions of who should write the chapter.
 */
function writingModeLine(value: Json): string | undefined {
  const delegation = asRecord(value['delegation'])
  return typeof delegation['sentence'] === 'string' ? delegation['sentence'] : undefined
}

/** One line per chapter: the status, the attempts, where it landed, and what the gate said. */
function chapterRows(value: Json): string[] {
  const chapters = Array.isArray(value['chapters']) ? (value['chapters'] as Json[]) : []
  return chapters.map((chapter) => {
    const bits = [
      `- #${String(chapter['seq'] ?? '?')} ${String(chapter['title'] ?? '')} · ` +
        `${CHAPTER_LABELS[String(chapter['status'] ?? '')] ?? String(chapter['status'] ?? '')} · 领取 ${String(chapter['attempts'] ?? 0)} 次`,
    ]
    if (chapter['path'] !== undefined && chapter['path'] !== null) bits.push(`落盘 ${String(chapter['path'])}`)
    const gate = asRecord(chapter['gate'])
    if (gate['total'] !== undefined) {
      bits.push(
        `门禁 ${String(gate['total'])} 项（需要处理 ${String(gate['warning'] ?? 0)} · 提示 ${String(gate['info'] ?? 0)}）` +
          (gate['paused'] === true ? ' → 停下来等批准' : ''),
      )
    }
    const error = asRecord(chapter['lastError'])
    if (error['code'] !== undefined) bits.push(`${String(error['code'])}：${String(error['message'] ?? '')}`)
    if (chapter['hasDraft'] === true) bits.push('有草稿等批准')
    return bits.join(' · ')
  })
}

/** A paused job says why before the table, so a reader cannot miss it. */
function pauseNote(value: Json): string | null {
  const pause = asRecord(value['pauseReason'])
  const message = pause['message']
  if (message === undefined) return null
  const seqs = Array.isArray(pause['seqs']) ? (pause['seqs'] as unknown[]).map((item) => String(item)) : []
  return (
    `已暂停（${String(pause['code'] ?? 'PAUSED')}）：${String(message)}` +
    (seqs.length > 0 ? ` — 第 ${seqs.join('、')} 章的草稿存在作业记录里` : '') +
    '，用 inkflow_batch_approve（confirm: true）批准后才会写进正文。'
  )
}

/**
 * The tools' shared reply shape: the resolved job, its counts, one row per chapter.
 * `take` and `complete` add their own section on top of it.
 */
function stateWire(state: JobState): Json {
  const count = (status: string): number => state.chapters.filter((chapter) => chapter.status === status).length
  return {
    jobId: state.jobId,
    dir: state.dir,
    status: state.meta.status,
    concurrency: state.meta.concurrency,
    batchSize: state.meta.batchSize,
    pauseOn: state.meta.pauseOn,
    pauseReason: state.meta.pauseReason,
    counts: {
      total: state.chapters.length,
      pending: count('pending'),
      running: count('running'),
      done: count('done'),
      held: count('held'),
      failed: count('failed'),
      edited: count('edited'),
    },
    chapters: state.chapters.map((chapter) => ({
      seq: chapter.seq,
      title: chapter.title,
      status: chapter.status,
      attempts: chapter.attempts,
      chapterId: chapter.chapterId,
      path: chapter.path,
      digest: chapter.digest,
      lastError: chapter.lastError,
      hasDraft: chapter.pendingBody !== null,
      gate:
        chapter.gate === null
          ? null
          : {
              total: chapter.gate.counts.total,
              warning: chapter.gate.counts.warning,
              info: chapter.gate.counts.info,
              paused: chapter.gate.paused,
              checks: chapter.gate.checks,
              findings: chapter.gate.findings,
              truncated: chapter.gate.truncated,
            },
    })),
  }
}

function takeWire(taken: TakeResult): Json {
  return {
    ...stateWire(taken.state),
    tasks: taken.tasks,
    skipped: taken.skipped,
    inFlight: taken.inFlight,
    remaining: taken.remaining,
    reason: taken.reason,
  }
}

function completeWire(done: CompleteResult): Json {
  return {
    ...stateWire(done.state),
    seq: done.seq,
    chapterId: done.chapterId,
    path: done.path,
    written: done.written,
    digest: done.digest,
    paused: done.paused,
    verdict:
      done.gate === null
        ? null
        : {
            total: done.gate.counts.total,
            warning: done.gate.counts.warning,
            info: done.gate.counts.info,
            paused: done.gate.paused,
            checks: done.gate.checks,
            findings: done.gate.findings,
            truncated: done.gate.truncated,
          },
  }
}

function approveWire(approved: ApproveResult): Json {
  return { ...stateWire(approved.state), approved: approved.approved, written: approved.written }
}

/** One entry of `enqueue`'s chapter list. */
const CHAPTER_ITEM: JsonSchemaNode = {
  type: 'object',
  properties: {
    seq: {
      type: 'integer',
      description:
        "Chapter number to create. Omit for the book's next free chapter number: the highest seq the book already uses, plus one (gaps are not backfilled, and numbers the job itself already holds raise that floor). It is not the job's own counter, so a new job on a book of eleven chapters starts at 12. A number the book already uses is refused later by inkflow_batch_complete (SEQ_CONFLICT), so check inkflow_chapter_list first.",
    },
    title: { type: 'string', description: 'Chapter title, as it will be written into the chapter file.' },
    volumeId: {
      type: 'string',
      description: 'Volume to create the chapter in (vol-NN). Omit for a loose chapter directly under chapters/.',
    },
    outline: {
      type: 'string',
      description:
        'One or two sentences: what has to happen in this chapter. It travels to the model with the writing context, so write it as a task, not as a summary of what does not exist yet.',
    },
    budgetWords: { type: 'integer', description: 'Target length in characters, when the plan has one.' },
  },
  required: ['title'],
  additionalProperties: false,
}

export function jobsTools(deps: JobsToolDeps): ToolDefinition[] {
  /**
   * `enqueue` — write the plan, and nothing else.
   *
   * The one thing worth saying twice: this tool creates **no chapter file**. A model that
   * believes `enqueue` has "started writing" reports progress that does not exist, so the reply
   * carries `contentFilesWritten: 0` in a field a test can assert.
   */
  const batchEnqueue: ToolDefinition = {
    name: 'inkflow_batch_enqueue',
    description:
      'Create a batch job (or add chapters to one): a queue of chapters to draft, each with its outline and word budget. ' +
      'It writes only `.inkflow/jobs/<jobId>/` — no chapter file, no catalog entry, nothing under `index/` — so it is safe to call before ' +
      'anyone has written a word, and re-enqueueing a seq the job already has is a no-op reported in `skipped`. ' +
      `Defaults: concurrency ${String(DEFAULT_CONCURRENCY)} (chapters alive at once, max ${String(MAX_CONCURRENCY)}), ` +
      `batchSize ${String(DEFAULT_BATCH_SIZE)} (how many one take hands out, max ${String(MAX_BATCH_SIZE)}), pauseOn "warning" ` +
      '(or "any" to also stop on info findings). ' +
      'The plugin embeds no model client (roadmap X-26): this tool starts nothing — the drafting loop is ' +
      'inkflow_batch_take → write the chapter yourself → inkflow_batch_complete. Omit jobId to mint a new job; pass an existing jobId to add chapters.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        jobId: {
          type: 'string',
          description:
            'Add to this existing job (bj- plus eight hex characters). Omit to mint a new one. A well-formed id with no job yet is created with that id, so a killed run can keep its name.',
        },
        concurrency: {
          type: 'integer',
          description: `How many chapters may be in flight at once (1-${String(MAX_CONCURRENCY)}, default ${String(DEFAULT_CONCURRENCY)}).`,
        },
        batchSize: {
          type: 'integer',
          description: `How many chapters one inkflow_batch_take hands out (1-${String(MAX_BATCH_SIZE)}, default ${String(DEFAULT_BATCH_SIZE)}).`,
        },
        pauseOn: {
          type: 'string',
          enum: [...PAUSE_POLICIES],
          description:
            'When a gated draft stops the job: "warning" (default) on any warning-or-worse finding, "any" also on info. The gate always runs; there is no "never".',
        },
        chapters: {
          type: 'array',
          items: CHAPTER_ITEM,
          description: 'The chapters to draft, in reading order. At least one.',
        },
      },
      required: ['chapters'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return describeFailure(v)
        const lines = [statusLine(v), '内容目录零写入（作业只是计划；正文要等 inkflow_batch_complete 落盘）。']
        const skipped = Array.isArray(v['skipped']) ? (v['skipped'] as unknown[]).map((item) => String(item)) : []
        if (skipped.length > 0) lines.push(`已在作业里、这次跳过：第 ${skipped.join('、')} 章`)
        lines.push('', ...chapterRows(v))
        lines.push('', `下一步：inkflow_batch_take（jobId: ${String(v['jobId'] ?? '')}）领取待写章与写作上下文。`)
        return text(lines)
      },
    },
    execute: async (args, exec: ToolRunContext) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const raw = Array.isArray(a['chapters']) ? (a['chapters'] as unknown[]) : []
      const chapters = raw.map((item) => {
        const entry = asRecord(item)
        const volumeId = optionalString(entry['volumeId'])
        const outline = optionalString(entry['outline'])
        const budgetWords = optionalNumber(entry['budgetWords'])
        return {
          ...(optionalNumber(entry['seq']) === undefined ? {} : { seq: optionalNumber(entry['seq']) }),
          title: typeof entry['title'] === 'string' ? entry['title'] : '',
          ...(volumeId === undefined ? {} : { volumeId }),
          ...(outline === undefined ? {} : { outline }),
          ...(budgetWords === undefined ? {} : { budgetWords }),
        }
      })
      const jobId = optionalString(a['jobId'])
      const concurrency = optionalNumber(a['concurrency'])
      const batchSize = optionalNumber(a['batchSize'])
      const enqueued = enqueueJob(probe.root, {
        ...(jobId === undefined ? {} : { jobId }),
        ...(concurrency === undefined ? {} : { concurrency }),
        ...(batchSize === undefined ? {} : { batchSize }),
        ...(a['pauseOn'] === 'any' || a['pauseOn'] === 'warning' ? { pauseOn: a['pauseOn'] } : {}),
        chapters,
      })
      if (!enqueued.ok) return { ok: false, root: probe.root, error: enqueued.error }
      rememberProject(deps.dataDir, probe.root)
      return {
        ok: true,
        root: probe.root,
        contentFilesWritten: 0,
        ...stateWire(enqueued.value),
        skipped: enqueued.value.skipped,
      }
    },
  }

  /**
   * `take` — the only place that decides what to write next, and the only reply that carries
   * the writing context. A second `take` before a `complete` returns no task
   * (`CONCURRENCY_REACHED`), which is what makes the cap real rather than advisory.
   */
  const batchTake: ToolDefinition = {
    name: 'inkflow_batch_take',
    description:
      'Claim the next batch of chapters from a batch job, and hand back for each one its outline plus the writing context ' +
      '(`context.text` — the assembled brief: characters, voice, ledger, foreshadowing, world book; the same assembly the injection uses). ' +
      'Draft each chapter from that, then call inkflow_batch_complete with the prose. ' +
      "Claims are capped by the job's concurrency (chapters alive at once) and batchSize (per reply): calling take again before completing " +
      'returns no task with `reason: "CONCURRENCY_REACHED"`. A PAUSED job returns no task (`reason: "PAUSED"`) — it waits for ' +
      'inkflow_batch_approve, not for more prose. A claim left behind by a killed process expires after 45 minutes and is handed out again, ' +
      'keeping the chapter\'s attempt count. Also the read path: with nothing claimable the reply still carries the whole job state, every ' +
      "chapter's status and its gate verdict.",
    parameters: {
      type: 'object',
      properties: { projectRoot: PROJECT_ROOT_PARAM, jobId: JOB_ID_PARAM },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return describeFailure(v)
        const lines = [statusLine(v)]
        // Who writes these chapters, on the one reply that hands out prose work. Placed
        // before the context dump on purpose: it is a instruction about what to do with
        // the chapters below, so it must be read before them.
        const writingMode = writingModeLine(v)
        if (writingMode !== undefined) lines.push(writingMode)
        const note = pauseNote(v)
        if (note !== null) lines.push(note)
        const tasks = Array.isArray(v['tasks']) ? (v['tasks'] as Json[]) : []
        if (tasks.length === 0) {
          const reason = String(v['reason'] ?? 'NOTHING_PENDING')
          lines.push(
            reason === 'PAUSED'
              ? '作业暂停中，没有可领取的章：先批准待批准的草稿（inkflow_batch_approve），或用面板的续跑按钮。'
              : reason === 'CONCURRENCY_REACHED'
                ? `并发已满（在写 ${String(v['inFlight'] ?? 0)} 章）：先用 inkflow_batch_complete 交回一章，再来领取。`
                : '没有待写的章了。',
          )
          return text(lines)
        }
        for (const task of tasks) {
          const context = asRecord(task['context'])
          lines.push('')
          lines.push(`## 第 ${String(task['seq'])} 章 · ${String(task['title'])}（第 ${String(task['attempts'])} 次领取）`)
          if (task['outline'] !== undefined && task['outline'] !== null) lines.push(`本章任务：${String(task['outline'])}`)
          if (task['budgetWords'] !== undefined && task['budgetWords'] !== null) {
            lines.push(`目标字数：${String(task['budgetWords'])} 字`)
          }
          lines.push(
            `写作上下文 ${String(context['tokens'] ?? 0)} / ${String(context['budgetTokens'] ?? 0)} token` +
              (context['overBudget'] === true ? '（超预算，已按裁剪阶梯缩过）' : ''),
          )
          if (context['planned'] === true) {
            lines.push(
              '这一章还没有章文件：下面注入的是本书最近一章的上下文（接续用），本章大纲以「本章任务」为准，别把下面的大纲当成这一章的计划。',
            )
          }
          const segments = Array.isArray(context['segments']) ? (context['segments'] as Json[]) : []
          const missing = segments.filter((segment) => segment['missing'] === true).map((segment) => String(segment['id']))
          if (missing.length > 0) lines.push(`本次缺段（这本书没有对应资料）：${missing.join('、')}`)
          lines.push('--- 写作上下文 ---')
          lines.push(String(context['text'] ?? ''))
          lines.push('--- 上下文结束 ---')
        }
        lines.push('')
        lines.push(
          `还剩 ${String(v['remaining'] ?? 0)} 章待领取。写完每章后调用 inkflow_batch_complete（jobId + seq + 正文）；` +
            '门禁有 warning 时作业会暂停并保留草稿，等你批准。',
        )
        return text(lines)
      },
    },
    execute: async (args, exec: ToolRunContext) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const jobId = optionalString(a['jobId'])
      const taken = takeBatch(probe.root, jobId === undefined ? {} : { jobId })
      if (!taken.ok) return { ok: false, root: probe.root, error: taken.error }
      rememberProject(deps.dataDir, probe.root)
      return {
        ok: true,
        root: probe.root,
        // Read per call, not cached: `settings.json` is a few hundred bytes, and a save
        // in the settings page therefore applies to the very next take without a restart.
        delegation: describeDelegation(settingsOf(deps.dataDir)).wire,
        ...takeWire(taken.value),
      }
    },
  }

  /**
   * `complete` — the gate, then (maybe) the write.
   *
   * The reply distinguishes three outcomes a model must not conflate: `written: true` (the prose
   * is in a chapter file), `written: false` + `paused: true` (the gate held it, the draft is
   * stored, a human must approve), and an error (nothing reached the book at all).
   */
  const batchComplete: ToolDefinition = {
    name: 'inkflow_batch_complete',
    description:
      'Hand back the prose for one claimed chapter. Before anything is written, the seven quality gates run over the draft — ' +
      'word count, chapter-end hook, the six de-AI dimensions, consistency with the setting library, sensitive words, platform form and ' +
      'mechanical proofreading — and the verdict is stored in the job record for that chapter. ' +
      'If the verdict has a warning or worse (or any finding when the job was created with pauseOn "any"), the job pauses, the draft is kept ' +
      'in the job record and **no chapter file is created**: the reply says `written: false` with the gate counts, and ' +
      'inkflow_batch_approve writes it after a human says yes. The plugin never auto-approves prose. ' +
      'On a clean verdict the chapter is created (its volume directory and catalog updated), its bytes are hashed into the record, and ' +
      'running the same completion again would write nothing — that digest is how a resumed job skips finished chapters. A chapter that is ' +
      'not currently claimed is refused (CHAPTER_NOT_CLAIMED): call inkflow_batch_take first.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        jobId: JOB_ID_PARAM,
        seq: { type: 'integer', description: 'The claimed chapter, by the seq take handed out.' },
        body: {
          type: 'string',
          description:
            "The chapter body as Markdown prose — no frontmatter (the chapter file's frontmatter is written from the job record), no heading, no '第 N 章' line.",
        },
      },
      required: ['seq', 'body'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return describeFailure(v)
        const verdict = asRecord(v['verdict'])
        const lines = [`第 ${String(v['seq'])} 章已交回。`]
        lines.push(
          `门禁：${String(verdict['total'] ?? 0)} 项（需要处理 ${String(verdict['warning'] ?? 0)} · 提示 ${String(verdict['info'] ?? 0)}）` +
            (v['paused'] === true ? ' → 作业暂停，草稿留在作业记录里' : ''),
        )
        if (v['written'] === true) {
          lines.push(`已落盘：${String(v['path'] ?? '')}（摘要 ${String(v['digest'] ?? '').slice(0, 12)}…）`)
        } else {
          lines.push(
            '没有写盘：这份草稿在等人工批准。用 inkflow_batch_approve（seq + confirm: true）批准后才会创建章文件；' +
              '要改就重写一版再交（先 resume 作业，再 take 同一章）。',
          )
        }
        lines.push('', statusLine(v))
        return text(lines)
      },
    },
    execute: async (args, exec: ToolRunContext) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const seq = optionalNumber(a['seq'])
      if (seq === undefined) {
        return {
          ok: false,
          root: probe.root,
          error: {
            code: 'SEQ_INVALID',
            message: 'seq is required: it is the number inkflow_batch_take handed out',
            hint: 'call inkflow_batch_take and use the seq it returned',
          },
        }
      }
      const jobId = optionalString(a['jobId'])
      const done = await completeChapter(probe.root, {
        ...(jobId === undefined ? {} : { jobId }),
        seq,
        body: typeof a['body'] === 'string' ? a['body'] : '',
      })
      if (!done.ok) return { ok: false, root: probe.root, error: done.error }
      rememberProject(deps.dataDir, probe.root)
      return { ok: true, root: probe.root, ...completeWire(done.value) }
    },
  }

  /**
   * `approve` — the human half of the gate. It writes exactly the stored draft, so approving
   * never costs a second model call, and the verdict stays in the record afterwards.
   */
  const batchApprove: ToolDefinition = {
    name: 'inkflow_batch_approve',
    description:
      'Approve gated drafts of a batch job and write them into chapter files. complete stored the drafted prose **and** its gate verdict in the ' +
      'job record, so approval never re-generates anything: it writes the bytes the gate judged and keeps the verdict (approving overrides a ' +
      'warning, it does not erase it). Requires confirm: true. Pass seq for one chapter, or all: true for every held draft; the job leaves the ' +
      'paused state once nothing is held. What it does NOT do: approve anything that is not held (CHAPTER_NOT_HELD), skip the gate, or resume a ' +
      "job (that is the panel's 续跑 button).",
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        jobId: JOB_ID_PARAM,
        seq: { type: 'integer', description: "Approve this chapter's held draft." },
        all: { type: 'boolean', description: 'Approve every held draft of the job.' },
        confirm: {
          type: 'boolean',
          description: 'Must be true: approving writes chapter files. Show the gate counts to the author first.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return describeFailure(v)
        const written = Array.isArray(v['written']) ? (v['written'] as Json[]) : []
        const lines = [`已批准 ${String(written.length)} 章，全部落盘。`]
        for (const entry of written) lines.push(`- 第 ${String(entry['seq'])} 章 → ${String(entry['path'] ?? '')}`)
        lines.push('', statusLine(v), ...chapterRows(v))
        return text(lines)
      },
    },
    execute: async (args, exec: ToolRunContext) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const jobId = optionalString(a['jobId'])
      const seq = optionalNumber(a['seq'])
      const approved = await approveDrafts(probe.root, {
        ...(jobId === undefined ? {} : { jobId }),
        ...(seq === undefined ? {} : { seq }),
        ...(a['all'] === true ? { all: true } : {}),
        ...(a['confirm'] === true ? { confirm: true } : {}),
      })
      if (!approved.ok) return { ok: false, root: probe.root, error: approved.error }
      rememberProject(deps.dataDir, probe.root)
      return { ok: true, root: probe.root, ...approveWire(approved.value) }
    },
  }

  return [batchEnqueue, batchTake, batchComplete, batchApprove]
}
