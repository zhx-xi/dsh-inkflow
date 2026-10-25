/**
 * The review tool surface (#46): `inkflow_review_run` / `inkflow_review_context` /
 * `inkflow_review_compare`.
 *
 * The split follows X-26, which is the whole design:
 *
 *   * **the session's model produces the opinions** — the plugin has no model client, so
 *     `inkflow_review_run` *receives* them and does the verifying (locate → evidence →
 *     record);
 *   * `inkflow_review_context` is the other half of that loop: it hands the model the
 *     chapter with paragraph numbers and offsets, so the hints it writes back can actually
 *     resolve. A model asked to "point at a paragraph" without being told which number is
 *     which paragraph gets it wrong for reasons that are not its fault;
 *   * `inkflow_review_compare` builds the cross-model table out of the recorded runs — no
 *     new input, because the comparison must be over what was actually recorded.
 *
 * Why these are built-ins rather than domain tools: a review reads a chapter and two
 * setting directories and writes a run record; no content directory owns it (X-5).
 */

import type { ContentBlock, HostContext, JsonSchemaNode, ToolDefinition, ToolRunContext } from './context.js'
import { gateFailure, resolveProject } from './domains/tool-project.js'
import { compareReviewRuns, reviewCompareWire } from './review-compare.js'
import {
  REVIEW_DEFAULT_CONTEXT_CHARS,
  REVIEW_DIMENSIONS,
  REVIEW_DIMENSION_LABELS,
  REVIEW_LIST_LIMIT,
  buildReviewContext,
  listReviewRuns,
  reviewRunWire,
  runReview,
} from './review.js'
import type { ReviewOpinionInput, ReviewRunRecord } from './review.js'

type Json = Record<string, unknown>

export interface ReviewToolDeps {
  readonly ctx: HostContext
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

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

const PROJECT_ROOT_PARAM = {
  type: 'string',
  description:
    'Absolute path of the InkFlow project root. Omit to resolve from the session working directory (walks up to the nearest project). An explicit path must live within the session working directory.',
} as const

const SUCCESS_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: true,
}

const CHAPTER_PARAM = {
  type: 'string',
  description: 'Chapter id (or project-relative path) to review. Omit for the last chapter in reading order.',
} as const

const DIMENSION_LIST_PARAM = {
  type: 'array',
  items: { type: 'string', enum: [...REVIEW_DIMENSIONS] },
  description:
    `Which dimensions to run: ${REVIEW_DIMENSIONS.map((dimension) => `${dimension}（${REVIEW_DIMENSION_LABELS[dimension]}）`).join(' / ')}. ` +
    'Omit for all five; a dimension left out is reported as skipped, not silently ignored.',
} as const

/** One opinion as the model hands it in. `dimension` and `text` are the two required fields. */
const OPINION_ITEM: JsonSchemaNode = {
  type: 'object',
  properties: {
    dimension: {
      type: 'string',
      enum: [...REVIEW_DIMENSIONS],
      description: `Which dimension this opinion belongs to: ${REVIEW_DIMENSIONS.join(' / ')}.`,
    },
    text: { type: 'string', description: 'The opinion itself: what is wrong here and why it matters.' },
    suggestion: { type: 'string', description: 'What to do about it. Becomes the finding hint; defaults to a generic rewrite note.' },
    severity: {
      type: 'string',
      enum: ['warning', 'info'],
      description: 'warning = the author should deal with it; info = worth knowing. A review opinion is never blocking.',
    },
    quote: { type: 'string', description: 'An exact excerpt of the chapter. The strongest hint when it occurs exactly once.' },
    paragraph: { type: 'integer', description: '1-based paragraph number, as printed by inkflow_review_context (`[段 N | …]`).' },
    offset: {
      type: 'integer',
      description:
        '0-based character offset: inside `paragraph` when both are given, otherwise in the chapter body (frontmatter excluded).',
    },
    line: { type: 'integer', description: '1-based line number in the chapter .md file (frontmatter included).' },
  },
  required: ['dimension', 'text'],
  additionalProperties: false,
}

/** The per-dimension score the model may hand in; copied into the record verbatim. */
const SCORES_PARAM: JsonSchemaNode = {
  type: 'object',
  properties: {
    structure: { type: 'number', description: '模型给结构维度的自评分（插件不改写、不评判）' },
    character: { type: 'number', description: '模型给人物维度的自评分' },
    pacing: { type: 'number', description: '模型给节奏维度的自评分' },
    style: { type: 'number', description: '模型给文风维度的自评分' },
    consistency: { type: 'number', description: '模型给一致性维度的自评分' },
  },
  additionalProperties: false,
}

/** `path#L<n>` / `chapter:<id>` — the same address string the record and the panel print. */
function addressOf(locator: Json): string {
  switch (String(locator['kind'] ?? '')) {
    case 'chapter':
      return `chapter:${String(locator['chapterId'] ?? '')}`
    case 'entity':
      return `${String(locator['entityKind'] ?? '')}:${String(locator['id'] ?? '')}`
    case 'catalog':
      return locator['volumeId'] === undefined ? 'catalog:' : `catalog:${String(locator['volumeId'])}`
    default:
      return locator['line'] === undefined
        ? String(locator['path'] ?? '')
        : `${String(locator['path'] ?? '')}#L${String(locator['line'])}`
  }
}

function dimensionLine(summary: Json): string {
  const status = String(summary['status'] ?? 'ok')
  const label = String(summary['label'] ?? summary['dimension'] ?? '?')
  if (status === 'failed') {
    return `- ${label}：**失败** ${String(summary['code'] ?? 'REVIEW_NODE_FAILED')} — ${String(summary['message'] ?? '')}`
  }
  if (status === 'skipped') {
    return `- ${label}：跳过（${String(summary['skipReason'] ?? 'not-requested')}）`
  }
  return `- ${label}：${String(summary['opinions'] ?? 0)} 条（${String(summary['located'] ?? 0)} 条带定位）`
}

export function reviewTools(deps: ReviewToolDeps): ToolDefinition[] {
  /**
   * Record one review pass.
   *
   * `write` is not exposed: unlike the audit's Markdown export (a report the user asks
   * for) or the gate's verdict (`write: false` exists for a read route), a review run has
   * exactly one meaning — "here are the model's opinions; locate and keep them". Computing
   * it without recording would produce nothing anyone can look at later.
   */
  const run: ToolDefinition = {
    name: 'inkflow_review_run',
    description:
      'Record one AI review pass over one chapter: hand in the opinions a model wrote, get them located, evidenced and ' +
      'stored. This plugin embeds no model client (zero runtime dependencies, roadmap X-26), so the opinions are ' +
      'yours to produce — most naturally after calling inkflow_review_context for the chapter text with paragraph ' +
      'numbers and offsets. Each opinion is routed to one of the five dimensions (structure / character / pacing / ' +
      'style / consistency), and its position hint (quote, paragraph+offset, offset, or line) is checked against the ' +
      'real chapter text: a resolved opinion comes back with a locator (`path#L<n>`) plus the excerpt and the ' +
      'characters on both sides of it, and an opinion that cannot be located is STILL stored, flagged `located: ' +
      'false` with a reason and a note saying which hint to pass instead — nothing is dropped and no position is ' +
      'invented. Each dimension is an independent node of one DAG: they run separately, a dimension you leave out is ' +
      'reported as skipped, and a node that fails returns a structured code while the other four still finish. The ' +
      'run lands in `.inkflow/review/<chapterId>/<runId>.json` (never in `index/`) together with a chapter digest, so ' +
      '"is this run about the text I am looking at" is answerable. Read which runs exist with the review panel or ' +
      'inkflow_review_compare; there is no model call here and nothing leaves the process.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        chapterId: CHAPTER_PARAM,
        chapterPath: { type: 'string', description: 'Project-relative chapter path, when no id is known.' },
        reviewer: {
          type: 'string',
          description: 'Which model produced these opinions (e.g. "deepseek-chat"). It is the row key of the comparison table; defaults to "unknown".',
        },
        dimensions: DIMENSION_LIST_PARAM,
        opinions: {
          type: 'array',
          items: OPINION_ITEM,
          description:
            'The opinions, each with a dimension and its text. Position hints are optional but strongly recommended: ' +
            'without one an opinion is kept as unlocated and cannot be jumped to.',
        },
        scores: SCORES_PARAM,
      },
      required: ['opinions'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          return text([
            `审稿没有跑成：${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`,
            String(error['hint'] ?? ''),
          ])
        }
        const counts = asRecord(v['counts'])
        const lines: string[] = []
        lines.push(
          `审稿：${String(v['chapterTitle'] ?? '')}（${String(v['chapterId'] ?? '?')}，${String(v['wordCount'] ?? 0)} 字）· ` +
            `模型 ${String(v['reviewer'] ?? 'unknown')} · 运行 ${String(v['runId'] ?? '?')}`,
        )
        lines.push(
          `意见 ${String(counts['opinions'] ?? 0)} 条：带定位 ${String(counts['located'] ?? 0)} · 未定位 ${String(
            counts['unlocated'] ?? 0,
          )} · 节点 ok ${String(counts['ok'] ?? 0)} / 失败 ${String(counts['failed'] ?? 0)} / 跳过 ${String(counts['skipped'] ?? 0)}`,
        )
        const dimensions = Array.isArray(v['dimensions']) ? (v['dimensions'] as Json[]) : []
        for (const summary of dimensions) lines.push(dimensionLine(summary))
        const rejected = Array.isArray(v['rejected']) ? (v['rejected'] as Json[]) : []
        if (rejected.length > 0) {
          lines.push('')
          lines.push('被拒收的意见（结构不合法，未进记录）：')
          for (const rejection of rejected) {
            lines.push(`- #${String(rejection['index'])} ${String(rejection['code'])}：${String(rejection['message'])}`)
          }
        }
        const opinions = Array.isArray(v['opinions']) ? (v['opinions'] as Json[]) : []
        if (opinions.length > 0) {
          lines.push('')
          for (const opinion of opinions) {
            const locator = asRecord(opinion['locator'])
            const where =
              opinion['located'] === true
                ? addressOf(locator)
                : `未定位（${String(opinion['unlocatedReason'] ?? 'REVIEW_HINT_MISSING')}）`
            const evidence = asRecord(opinion['evidence'])
            lines.push(`- [${String(opinion['dimension'])}/${String(opinion['severity'])}] ${String(opinion['detail'])}`)
            lines.push(`    ${where}`)
            if (evidence['quote'] !== undefined) {
              lines.push(`    …${String(evidence['before'] ?? '')}【${String(evidence['quote'] ?? '')}】${String(evidence['after'] ?? '')}…`)
            } else {
              lines.push(`    ${String(opinion['unlocatedDetail'] ?? '')}`)
            }
          }
        }
        if (v['truncated'] === true) {
          lines.push(`…还有意见未列出；全量在记录文件里。`)
        }
        lines.push('')
        lines.push(`记录：${String(v['recordPath'] ?? '')}`)
        return text(lines)
      },
    },
    execute: async (args, exec: ToolRunContext) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe

      const rawOpinions = Array.isArray(a['opinions']) ? (a['opinions'] as unknown[]) : []
      const opinions: ReviewOpinionInput[] = []
      for (const raw of rawOpinions) {
        const entry = asRecord(raw)
        opinions.push({
          dimension: typeof entry['dimension'] === 'string' ? entry['dimension'] : '',
          text: typeof entry['text'] === 'string' ? entry['text'] : '',
          ...(typeof entry['suggestion'] === 'string' ? { suggestion: entry['suggestion'] } : {}),
          ...(typeof entry['severity'] === 'string' ? { severity: entry['severity'] } : {}),
          ...(optionalString(entry['quote']) === undefined ? {} : { quote: optionalString(entry['quote']) ?? '' }),
          ...(optionalNumber(entry['paragraph']) === undefined ? {} : { paragraph: optionalNumber(entry['paragraph']) ?? 0 }),
          ...(optionalNumber(entry['offset']) === undefined ? {} : { offset: optionalNumber(entry['offset']) ?? 0 }),
          ...(optionalNumber(entry['line']) === undefined ? {} : { line: optionalNumber(entry['line']) ?? 0 }),
        })
      }
      if (opinions.length === 0) {
        return {
          ok: false,
          root: probe.root,
          error: {
            code: 'REVIEW_OPINIONS_REQUIRED',
            message: 'opinions is empty',
            hint: 'write the opinions first (inkflow_review_context hands you the chapter with paragraph numbers), then pass them here',
          },
        }
      }

      const rawScores = asRecord(a['scores'])
      const scores: Record<string, number> = {}
      for (const dimension of REVIEW_DIMENSIONS) {
        const value = optionalNumber(rawScores[dimension])
        if (value !== undefined) scores[dimension] = value
      }

      const chapterId = optionalString(a['chapterId'])
      const chapterPath = optionalString(a['chapterPath'])
      const reviewer = optionalString(a['reviewer'])
      const requested = stringList(a['dimensions'])
      const ran = runReview(probe.root, {
        ...(chapterId === undefined ? {} : { chapterId }),
        ...(chapterPath === undefined ? {} : { chapterPath }),
        ...(reviewer === undefined ? {} : { reviewer }),
        opinions,
        ...(requested.length === 0 ? {} : { dimensions: requested }),
        ...(Object.keys(scores).length === 0 ? {} : { scores }),
      })
      if (!ran.ok) return { ok: false, root: probe.root, error: { ...ran.error } }

      const payload = reviewRunWire(ran.run)
      return {
        ok: true,
        root: probe.root,
        ...payload,
        ...(ran.file === undefined ? {} : { file: ran.file }),
      }
    },
  }

  /**
   * The other half of the loop: what the model needs to write opinions that resolve.
   *
   * Read-only by construction (no `confirm`, no `write` flag): it reads one chapter and
   * returns a text block. The addressing protocol lives *in* the block, beside the
   * paragraph numbers, because that is where the model can act on it.
   */
  const context: ToolDefinition = {
    name: 'inkflow_review_context',
    description:
      'Return the review context text for one chapter: the body with every paragraph numbered and offset-tagged ' +
      '(`[段 3 | 偏移 412]`), the five dimensions with what each one looks for, and the addressing protocol an opinion ' +
      'should use (`quote` / `paragraph`+`offset` / `offset` / `line`). Call this first, read the chapter, write the ' +
      'opinions, then pass them to inkflow_review_run — the numbers in this text are exactly the ones that resolve ' +
      'there. Read-only: nothing is written, no model is called. `maxChars` caps the body handed back (default ' +
      `${String(REVIEW_DEFAULT_CONTEXT_CHARS)} characters); the reply reports \`truncated\` when it bit.`,
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        chapterId: CHAPTER_PARAM,
        chapterPath: { type: 'string', description: 'Project-relative chapter path, when no id is known.' },
        dimensions: DIMENSION_LIST_PARAM,
        maxChars: {
          type: 'integer',
          description: `Upper bound on the body text handed back (default ${String(REVIEW_DEFAULT_CONTEXT_CHARS)}). The header always comes through; 'truncated' says the body was cut.`,
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          return text([
            `审稿上下文没有取到：${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`,
            String(error['hint'] ?? ''),
          ])
        }
        const dimensions = Array.isArray(v['dimensions']) ? (v['dimensions'] as Json[]) : []
        return text([
          `审稿上下文：${String(v['chapterTitle'] ?? '')}（${String(v['chapterId'] ?? '?')}）· ${String(v['wordCount'] ?? 0)} 字 / ${String(
            v['paragraphCount'] ?? 0,
          )} 段`,
          `维度：${dimensions.map((entry) => `${String(entry['dimension'])}（${String(entry['label'])}）`).join(' · ')}`,
          v['truncated'] === true ? '正文按 maxChars 截断了（truncated）。' : '正文完整。',
          '',
          String(v['text'] ?? ''),
        ])
      },
    },
    execute: async (args, exec: ToolRunContext) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const chapterId = optionalString(a['chapterId'])
      const chapterPath = optionalString(a['chapterPath'])
      const maxChars = optionalNumber(a['maxChars'])
      const requested = stringList(a['dimensions'])
      const built = buildReviewContext(probe.root, {
        ...(chapterId === undefined ? {} : { chapterId }),
        ...(chapterPath === undefined ? {} : { chapterPath }),
        ...(requested.length === 0 ? {} : { dimensions: requested }),
        ...(maxChars === undefined ? {} : { maxChars }),
      })
      if (!built.ok) return { ok: false, root: probe.root, error: { ...built.error } }
      return { ok: true, root: probe.root, ...built.value }
    },
  }

  /**
   * The cross-model table. Its input is the recorded runs, never a body: a comparison
   * assembled from a caller's numbers would be a table about the caller, not about what
   * the models actually said.
   */
  const compare: ToolDefinition = {
    name: 'inkflow_review_compare',
    description:
      'Build the cross-model comparison table for one chapter from the review runs already recorded: one row per ' +
      '(run, dimension) plus a total row per run, with a fixed column set so two models compare column by column — ' +
      'model self-score (given by the model, never computed here), opinion count, located count, located rate, ' +
      'opinions per 1000 characters, warnings, infos and node status. The plugin does NOT score: every rate is an ' +
      'arithmetic definition printed with the table, and `—` marks a rate with nothing to divide by. Fewer than two ' +
      'distinct reviewers still returns the table with `comparable: false` and says so. The reply carries the rows ' +
      'and a ready-to-paste Markdown table. Read-only: only `.inkflow/review/<chapterId>/` is read.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        chapterId: CHAPTER_PARAM,
        chapterPath: { type: 'string', description: 'Project-relative chapter path, when no id is known.' },
        limit: { type: 'integer', description: `How many runs to compare, newest first (default ${String(REVIEW_LIST_LIMIT)}).` },
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          return text([
            `横评没有算成：${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`,
            String(error['hint'] ?? ''),
          ])
        }
        const lines: string[] = []
        lines.push(
          `横评：${String(v['chapterTitle'] ?? '')}（${String(v['chapterId'] ?? '?')}）· ${String(v['runCount'] ?? 0)} 次运行 · 模型 ${
            stringList(v['reviewers']).join(' / ') || '—'
          }`,
        )
        if (v['comparable'] !== true) lines.push('提示：同一章至少要有 2 个模型各跑一次才是横评。')
        lines.push('')
        lines.push(String(v['markdown'] ?? ''))
        if (v['truncated'] === true) lines.push(`…只比较了最近 ${String(v['runCount'] ?? 0)} 次运行。`)
        return text(lines)
      },
    },
    execute: async (args, exec: ToolRunContext) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const chapterId = optionalString(a['chapterId'])
      const chapterPath = optionalString(a['chapterPath'])
      const limit = optionalNumber(a['limit'])

      // The chapter is resolved through the same reader the run uses, so "which chapter"
      // has one answer: `chapterPath` names one, `chapterId` names one, and with neither
      // the book's last chapter is the subject — exactly the run's own default.
      const built = buildReviewContext(probe.root, {
        ...(chapterId === undefined ? {} : { chapterId }),
        ...(chapterPath === undefined ? {} : { chapterPath }),
      })
      if (!built.ok) return { ok: false, root: probe.root, error: { ...built.error } }

      const cap = limit === undefined || limit <= 0 ? REVIEW_LIST_LIMIT : Math.trunc(limit)
      const listed = listReviewRuns(probe.root, built.value.chapterId)
      const runs: readonly ReviewRunRecord[] = listed.runs.slice(0, cap)
      const table = compareReviewRuns(runs)
      return {
        ok: true,
        root: probe.root,
        chapterId: built.value.chapterId,
        chapterTitle: built.value.chapterTitle,
        runCount: runs.length,
        skippedFiles: listed.skippedFiles,
        truncated: listed.runs.length > runs.length,
        ...reviewCompareWire(table),
      }
    },
  }

  return [run, context, compare]
}

