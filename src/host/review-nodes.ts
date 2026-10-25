/**
 * Issue #46 — the five review dimensions and their nodes.
 *
 * Extracted from `review.ts` by #193. One file for "what a dimension is" and "what a
 * node may look at", so that adding a dimension or changing what one dimension counts
 * is a local edit instead of a surgical one inside a 1700-line file.
 *
 * ## What this module owns
 *
 *   * the dimensions themselves (`REVIEW_DIMENSIONS`) and their spec: label, catalogue
 *     code (one vocabulary per dimension), finding group, and the task sentence
 *     `inkflow_review_context` prints so the model knows what to look for;
 *   * the node table `REVIEW_NODES` — five independent nodes, each reading the chapter
 *     (two of them also `characters/` and `facts/`) and producing anchors + opinions;
 *   * the vocabulary a caller's opinion is checked against (`checkOpinion`): an unknown
 *     `dimension`, an empty `text` and a `severity` outside warning/info are refusals,
 *     because an aesthetic judgement is never a blocking finding (ADR-0015 D2).
 *
 * ## Nodes do not judge
 *
 * A node's mechanical part is an **anchor digest** — paragraph counts, dialogue lines,
 * sentence statistics, which character names actually occur, which ledger subjects
 * exist. It reads and hands numbers to the reader; it never says "this is bad". The
 * verdict belongs to the model (X-26), and the *mechanical* verdicts over the same
 * chapter already belong to the seven quality gates (#44) — a second threshold table
 * here would be two answers to one question.
 *
 * ## What it refuses to own
 *
 *   * turning a hint into an offset/excerpt (归 `review-locate.ts`)；
 *   * routing, ordering and the run record (归 `review.ts` / `review-store.ts`)；
 *   * any model call (the plugin has none, X-26)。
 */

import { join } from 'node:path'

import { aliasesOf, readText } from './domains/scan-helpers.js'
import type { FindingGroup, FindingSeverity } from './findings.js'
import { parseMarkdown, stringField } from './frontmatter.js'
import type { WalkedFile } from './indexer.js'
import { locateOpinion, occurrencesOf } from './review-locate.js'
import type { ReviewChapter, ReviewOpinion, ReviewOpinionInput, ReviewParagraph, ReviewRejection } from './review-locate.js'

/**
 * The review's dimensions, in report order. One node each (roadmap M19 「审稿 DAG」).
 *
 * Deliberately **not** `FINDING_GROUPS`: a dimension is "which reader's eye produced this
 * opinion", a group is "which family of book facts the problem touches". A structure
 * opinion and a character opinion are both about `structure` facts, but they come from
 * two different tasks and two different passes.
 */
export const REVIEW_DIMENSIONS = ['structure', 'character', 'pacing', 'style', 'consistency'] as const

export type ReviewDimension = (typeof REVIEW_DIMENSIONS)[number]

export interface ReviewDimensionSpec {
  readonly dimension: ReviewDimension
  /** The Chinese label the panel and the reply print. */
  readonly label: string
  /** The catalogue code one opinion carries (`findings.ts`), so the report has one vocabulary. */
  readonly code: string
  /** The `FINDING_GROUPS` family this dimension argues about (ADR-0022 D3: the enum stays five). */
  readonly group: FindingGroup
  /** What the model is asked to look for — printed by `inkflow_review_context`. */
  readonly task: string
}

/**
 * The **one** table: dimension → label, catalogue code, finding group, task.
 *
 * One array rather than four parallel `Record`s, because four maps over the same five keys
 * is four places to forget a dimension in (the defect this repo keeps re-learning: a fact
 * written twice drifts). The three public maps below are derived from it, and
 * `tests/review.test.js` asserts every dimension has all four fields.
 */
export const REVIEW_DIMENSION_SPECS: readonly ReviewDimensionSpec[] = [
  {
    dimension: 'structure',
    label: '结构',
    code: 'REVIEW_STRUCTURE',
    group: 'structure',
    task: '结构与场景：开场是否抓住人、场景切换有没有交代、章末是否留下推进力、情节因果是否闭合',
  },
  {
    dimension: 'character',
    label: '人物',
    code: 'REVIEW_CHARACTER',
    group: 'structure',
    task: '人物：动机是否成立、言行与人物卡是否一致、配角有没有自己的目的、对话是否各有腔调',
  },
  {
    dimension: 'pacing',
    label: '节奏',
    code: 'REVIEW_PACING',
    group: 'catalog',
    task: '节奏：信息与行动的疏密、有没有连续大段说明、紧张与缓冲是否交替、哪些段落可以删掉',
  },
  {
    dimension: 'style',
    label: '文风',
    code: 'REVIEW_STYLE',
    group: 'catalog',
    task: '文风：句长与断句、重复用词、叙述腔调是否统一、有没有翻译腔与陈词',
  },
  {
    dimension: 'consistency',
    label: '一致性',
    code: 'REVIEW_CONSISTENCY',
    group: 'ledger',
    task: '一致性：与设定库（角色卡 / 账本 / 伏笔 / 时间线）是否冲突，称谓与设定是否对得上',
  },
]

function specOf(dimension: ReviewDimension): ReviewDimensionSpec {
  const found = REVIEW_DIMENSION_SPECS.find((entry) => entry.dimension === dimension)
  // Unreachable while SPECS covers REVIEW_DIMENSIONS, which a test asserts; the fallback
  // keeps this a total function instead of a `!` that would hide a hole at runtime.
  if (found === undefined) {
    return { dimension, label: dimension, code: 'REVIEW_STRUCTURE', group: 'catalog', task: '' }
  }
  return found
}

export const REVIEW_DIMENSION_LABELS = Object.fromEntries(
  REVIEW_DIMENSION_SPECS.map((entry) => [entry.dimension, entry.label]),
) as Readonly<Record<ReviewDimension, string>>

/** The catalogue code one opinion carries, so the report has one vocabulary per dimension. */
export const REVIEW_DIMENSION_CODES = Object.fromEntries(
  REVIEW_DIMENSION_SPECS.map((entry) => [entry.dimension, entry.code]),
) as Readonly<Record<ReviewDimension, string>>

/**
 * The `group` each dimension files under (ADR-0022 D3's rule: `FINDING_GROUPS` stays at
 * five, and a dimension maps to the family of facts it argues about).
 */
export const REVIEW_DIMENSION_GROUPS = Object.fromEntries(
  REVIEW_DIMENSION_SPECS.map((entry) => [entry.dimension, entry.group]),
) as Readonly<Record<ReviewDimension, FindingGroup>>

/** What the model is asked to look for — printed by `inkflow_review_context`, owned here. */
export const REVIEW_DIMENSION_TASKS = Object.fromEntries(
  REVIEW_DIMENSION_SPECS.map((entry) => [entry.dimension, entry.task]),
) as Readonly<Record<ReviewDimension, string>>

const VALID_SEVERITIES: readonly FindingSeverity[] = ['warning', 'info']

// ---------------------------------------------------------------------------
// Types: the chapter, the opinions, the record

export interface ReviewNodeInput {
  readonly root: string
  readonly chapter: ReviewChapter
  readonly files: readonly WalkedFile[]
  /** Only the opinions routed to this node. */
  readonly opinions: readonly ReviewOpinionInput[]
  readonly contextChars: number
}

export interface ReviewAnchorValue {
  readonly [key: string]: number | string | readonly string[]
}

export interface ReviewNodeOutput {
  readonly anchors: ReviewAnchorValue
  readonly opinions: readonly ReviewOpinion[]
}

/**
 * A node's outcome. A refusal is `{ok:false, code}` rather than a throw: "this dimension
 * cannot be judged because its source is unreadable" is a fact the report must print, and
 * a stack trace is not.
 */
export type ReviewNodeResult =
  | { readonly ok: true; readonly output: ReviewNodeOutput }
  | { readonly ok: false; readonly code: string; readonly message: string }

export interface ReviewNode {
  readonly dimension: ReviewDimension
  readonly label: string
  readonly run: (input: ReviewNodeInput) => ReviewNodeResult
}

export function asDimension(value: string): ReviewDimension | undefined {
  return (REVIEW_DIMENSIONS as readonly string[]).includes(value) ? (value as ReviewDimension) : undefined
}

export function asSeverity(value: string | undefined): FindingSeverity {
  return VALID_SEVERITIES.includes(value as FindingSeverity) ? (value as FindingSeverity) : 'info'
}

/** Build the `Finding`-shaped opinion for one input, located or not. */
function opinionOf(
  chapter: ReviewChapter,
  dimension: ReviewDimension,
  input: ReviewOpinionInput,
  contextChars: number,
): ReviewOpinion {
  const placed = locateOpinion(chapter, input, contextChars)
  const located = placed.located
  return {
    dimension,
    code: specOf(dimension).code,
    group: specOf(dimension).group,
    severity: asSeverity(input.severity),
    locator: located ? placed.locator : null,
    located,
    unlocatedReason: located ? null : placed.reason,
    unlocatedDetail: located ? null : placed.detail,
    detail: input.text.trim(),
    hint: (input.suggestion ?? '').trim() === '' ? '按这条意见改写原文这一段' : (input.suggestion as string).trim(),
    fixable: false,
    evidence: located ? placed.evidence : null,
  }
}

/** One opinion's whole pipeline: verify the shape, then locate it. */
function buildOpinions(
  chapter: ReviewChapter,
  dimension: ReviewDimension,
  inputs: readonly ReviewOpinionInput[],
  contextChars: number,
): ReviewOpinion[] {
  return inputs.map((input) => opinionOf(chapter, dimension, input, contextChars))
}

function charactersRoster(root: string, files: readonly WalkedFile[]): { name: string; aliases: string[] }[] {
  const out: { name: string; aliases: string[] }[] = []
  for (const file of files) {
    if (file.dir !== 'characters' || !file.path.toLowerCase().endsWith('.md')) continue
    const parsed = parseMarkdown(readText(join(root, file.path)))
    const name =
      stringField(parsed.data, 'name') ?? file.path.split('/').pop()?.replace(/\.md$/iu, '') ?? file.path
    out.push({ name, aliases: aliasesOf(parsed.data) })
  }
  return out
}

function ledgerSubjects(root: string, files: readonly WalkedFile[]): string[] {
  const out: string[] = []
  for (const file of files) {
    if (file.dir !== 'facts' || !file.path.toLowerCase().endsWith('.md')) continue
    const parsed = parseMarkdown(readText(join(root, file.path)))
    out.push(stringField(parsed.data, 'subject') ?? file.path.split('/').pop()?.replace(/\.md$/iu, '') ?? file.path)
  }
  return out
}

function sentencesOf(body: string): number {
  const parts = body.split(/[。！？!?…]+/u).filter((part) => part.trim() !== '')
  return parts.length
}

function longestParagraph(paragraphs: readonly ReviewParagraph[]): number {
  let longest = 0
  for (const paragraph of paragraphs) longest = Math.max(longest, paragraph.text.trim().length)
  return longest
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * The five nodes, in report order.
 *
 * Each one is a pure function of (chapter, files, its opinions): no clock, no write, no
 * network. That is what makes a single node testable on its own, and what makes "run only
 * the dimensions you asked for" a real capability instead of a filter on the output.
 */
export const REVIEW_NODES: readonly ReviewNode[] = [
  {
    dimension: 'structure',
    label: specOf('structure').label,
    run: (input) => {
      const paragraphs = input.chapter.paragraphs
      const separators = paragraphs.filter((paragraph) => /^(?:\*{3,}|-{3,}|#{1,6}\s|（.{0,12}）)$/u.test(paragraph.text.trim())).length
      return {
        ok: true,
        output: {
          anchors: {
            paragraphs: paragraphs.length,
            chars: input.chapter.wordCount,
            separators,
            longestParagraph: longestParagraph(paragraphs),
          },
          opinions: buildOpinions(input.chapter, 'structure', input.opinions, input.contextChars),
        },
      }
    },
  },
  {
    dimension: 'character',
    label: specOf('character').label,
    run: (input) => {
      const roster = charactersRoster(input.root, input.files)
      const present: { name: string; count: number }[] = []
      for (const card of roster) {
        let count = 0
        for (const spelling of [card.name, ...card.aliases]) {
          if (spelling === '') continue
          count += occurrencesOf(input.chapter.body, spelling).length
        }
        if (count > 0) present.push({ name: card.name, count })
      }
      present.sort((left, right) => right.count - left.count || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      return {
        ok: true,
        output: {
          anchors: {
            roster: roster.length,
            onStage: present.slice(0, 12).map((entry) => `${entry.name}×${String(entry.count)}`),
          },
          opinions: buildOpinions(input.chapter, 'character', input.opinions, input.contextChars),
        },
      }
    },
  },
  {
    dimension: 'pacing',
    label: specOf('pacing').label,
    run: (input) => {
      const paragraphs = input.chapter.paragraphs
      const dialogue = paragraphs.filter((paragraph) => /^[「“"『]/u.test(paragraph.text.trim())).length
      const total = paragraphs.reduce((sum, paragraph) => sum + paragraph.text.trim().length, 0)
      return {
        ok: true,
        output: {
          anchors: {
            paragraphs: paragraphs.length,
            meanParagraphChars: paragraphs.length === 0 ? 0 : round1(total / paragraphs.length),
            dialogueParagraphs: dialogue,
            longestParagraph: longestParagraph(paragraphs),
          },
          opinions: buildOpinions(input.chapter, 'pacing', input.opinions, input.contextChars),
        },
      }
    },
  },
  {
    dimension: 'style',
    label: specOf('style').label,
    run: (input) => {
      const body = input.chapter.body
      const sentences = sentencesOf(body)
      return {
        ok: true,
        output: {
          anchors: {
            sentences,
            meanSentenceChars: sentences === 0 ? 0 : round1(input.chapter.wordCount / sentences),
            dashes: occurrencesOf(body, '——').length,
            ellipses: occurrencesOf(body, '…').length,
          },
          opinions: buildOpinions(input.chapter, 'style', input.opinions, input.contextChars),
        },
      }
    },
  },
  {
    dimension: 'consistency',
    label: specOf('consistency').label,
    run: (input) => ({
      ok: true,
      output: {
        anchors: {
          pov: input.chapter.pov ?? '',
          ledgerSubjects: ledgerSubjects(input.root, input.files).slice(0, 12),
        },
        opinions: buildOpinions(input.chapter, 'consistency', input.opinions, input.contextChars),
      },
    }),
  },
]

// ---------------------------------------------------------------------------
// Reading the chapter

/** Validate one opinion's shape. A missing/unknown dimension and empty text are refusals. */
export function checkOpinion(index: number, input: ReviewOpinionInput): ReviewRejection | undefined {
  const dimension = asDimension((input.dimension ?? '').trim())
  if (dimension === undefined) {
    return {
      index,
      code: 'REVIEW_DIMENSION_UNKNOWN',
      message: `第 ${String(index + 1)} 条意见的 dimension 是 "${String(input.dimension ?? '')}"，只认 ${REVIEW_DIMENSIONS.join(' / ')}`,
    }
  }
  if ((input.text ?? '').trim() === '') {
    return {
      index,
      code: 'REVIEW_TEXT_REQUIRED',
      message: `第 ${String(index + 1)} 条意见没有 text：意见本身要写清楚哪里不对、怎么改`,
    }
  }
  if (input.severity !== undefined && !VALID_SEVERITIES.includes(input.severity as FindingSeverity)) {
    return {
      index,
      code: 'REVIEW_SEVERITY_INVALID',
      message: `第 ${String(index + 1)} 条意见的 severity 是 "${input.severity}"，只认 warning / info（审稿意见不是阻断项）`,
    }
  }
  return undefined
}
