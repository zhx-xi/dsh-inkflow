/**
 * Issue #44 — the quality gate's vocabulary: the seven checks, their code table, the
 * thresholds and the input types the rules read.
 *
 * Split out of `gate-rules.ts` for two reasons, both structural rather than cosmetic:
 *
 *   * **the vocabulary is what three readers share** — `gate.ts` (report, serialiser), the
 *     tool/`GET /gate` (`check` labels, counts) and the seven rules themselves. Keeping it
 *     beside the rules made one file that both defines and uses the words, which is where a
 *     second definition starts growing;
 *   * the rules file was past the project's 600-line ceiling; the words are not the rules.
 *
 * Two contracts live here and nowhere else:
 *
 *   * `GATE_CHECK_IDS` order is the report's order, the file's order and the panel's order —
 *     nothing may reorder it.
 *   * `group` and `fixable` are **not** here: they come from `findings.ts` (X-14 / X-24), so a
 *     gate code cannot carry a second opinion about its family or about whether the repair
 *     pass can fix it. Severity is here because `blocking` is reserved for a write refusal
 *     (`findings.ts` says so) and a gate is a read — the loudest a gate ever gets is
 *     `warning`.
 */

import { findingCode } from './findings.js'
import type { Finding, FindingLocator, FindingSeverity } from './findings.js'

/** The seven checks, in report order. Nothing may reorder this tuple. */
export const GATE_CHECK_IDS = [
  'wordCount',
  'hook',
  'aiFlavor',
  'consistency',
  'sensitive',
  'platform',
  'proofread',
] as const
export type GateCheckId = (typeof GATE_CHECK_IDS)[number]

export const GATE_CHECK_LABELS: Readonly<Record<GateCheckId, string>> = {
  wordCount: '字数',
  hook: '章末钩子',
  aiFlavor: '六维去 AI 味',
  consistency: '一致性',
  sensitive: '敏感自查',
  platform: '平台规则',
  proofread: '机械校对',
}

/**
 * Every knob the rules read.
 *
 * The values travel into the gate file (ADR-0022 D4) because a verdict without its
 * thresholds cannot be reproduced: "12 项" means nothing if the next run used a different
 * word-count window. The six de-AI dimensions' numbers are defaults, not law —
 * `open-questions.md` Q4 still holds "具体维度与阈值" as open, so a caller may pass its own
 * and the file will say which were used.
 */
export interface GateThresholds {
  /** Target range for one chapter (item 1). */
  readonly wordCountMin: number
  readonly wordCountMax: number
  /** 破折号 / 省略号 per 1000 characters (item 3, dimension 2). */
  readonly aiDashPer1000: number
  readonly aiEllipsisPer1000: number
  /** Mean sentence length above which "长句成串" is reported (dimension 1). */
  readonly aiSentenceMeanMax: number
  /** Below this coefficient of variation the sentence lengths read as machine-even. */
  readonly aiSentenceEvenness: number
  /** 的 / 地 / 程度副词 per 1000 characters (dimension 5). */
  readonly aiModifierPer1000: number
  /** How many findings one rule may report before it stops naming individual hits. */
  readonly maxFindingsPerRule: number
}

export const GATE_DEFAULTS: GateThresholds = {
  wordCountMin: 2000,
  wordCountMax: 4500,
  aiDashPer1000: 0.6,
  aiEllipsisPer1000: 1.5,
  aiSentenceMeanMax: 34,
  aiSentenceEvenness: 0.34,
  aiModifierPer1000: 55,
  maxFindingsPerRule: 5,
}

/** One character card as the gates read it: names only — the gates never judge a card. */
export interface GateRosterEntry {
  readonly id: string
  readonly name: string
  readonly aliases: readonly string[]
}

/** One ledger line, plus where it came from (a locator needs the file and the line). */
export interface GateFact {
  readonly path: string
  readonly line: number
  readonly subject: string
  readonly attribute: string
  readonly value: string
  readonly until: string | undefined
}

/** The chapter under the gate: already read, already parsed. */
export interface GateChapter {
  readonly id: string
  readonly path: string
  readonly seq: number | undefined
  readonly title: string
  readonly pov: string | undefined
  readonly body: string
  /** Characters ignoring whitespace — the same count the index keeps (`countChars`). */
  readonly wordCount: number
}

/**
 * Everything the seven rules may read. Assembled once by `gate.ts`, so a rule never touches
 * the disk (which is what makes the whole run one pass of reads) and the determinism test can
 * feed the same input twice.
 */
export interface GateInput {
  readonly chapter: GateChapter
  readonly roster: readonly GateRosterEntry[]
  readonly facts: readonly GateFact[]
  /** Chapter sequence for a chapter id or path — `undefined` when the book lacks it. */
  readonly seqOf: (reference: string) => number | undefined
  readonly thresholds: GateThresholds
}

/** How a code is filed: which check owns it, how loud it is, and what to do about it. */
export interface GateCodeSpec {
  readonly code: string
  readonly check: GateCheckId
  readonly severity: FindingSeverity
  readonly hint: string
}

/**
 * The gate's vocabulary: one row per code, in check order.
 *
 * `group` and `fixable` come from `FINDING_CODES` (see the file header); this table adds only
 * what is the gate's own business — which check emits the code, how loud it is, and one line
 * of what to do about it.
 */
export const GATE_CODES: readonly GateCodeSpec[] = [
  // 1 字数 — the target range ("did you write the chapter you planned"), not the platform's
  // hard window: item 6 owns form, item 1 owns the target.
  { code: 'GATE_WORD_COUNT_LOW', check: 'wordCount', severity: 'info', hint: '按任务书区间补足内容，或与大纲核对本章目标字数' },
  { code: 'GATE_WORD_COUNT_HIGH', check: 'wordCount', severity: 'info', hint: '删掉不推动剧情的内容，或与大纲核对本章目标字数' },

  // 2 章末钩子
  { code: 'GATE_HOOK_MISSING', check: 'hook', severity: 'warning', hint: '章末落在新处境、新疑问或新威胁上，不要用收束句结束' },
  { code: 'GATE_HOOK_SUMMARY', check: 'hook', severity: 'warning', hint: '删掉末段的总结、抒情与预告，让场景自己收口' },

  // 3 六维去 AI 味 — one code per dimension (open-questions Q4), so a report row names the
  // dimension instead of "AI 味" in general.
  { code: 'GATE_AI_SENTENCE', check: 'aiFlavor', severity: 'info', hint: '动作段用短句（10–25 字），把成串的长句切开' },
  { code: 'GATE_AI_PUNCT', check: 'aiFlavor', severity: 'info', hint: '破折号一章 0–1 处；省略号不要用来拖节奏' },
  { code: 'GATE_AI_PARALLEL', check: 'aiFlavor', severity: 'info', hint: '「不是…而是…」与连续同构句只在真需要排比处使用' },
  { code: 'GATE_AI_NARRATION', check: 'aiFlavor', severity: 'info', hint: '删掉动作之后的情绪结论，让读者从动作里读出来' },
  { code: 'GATE_AI_MODIFIER', check: 'aiFlavor', severity: 'info', hint: '少堆「的/地」与程度副词，改写成具体动作或细节' },
  { code: 'GATE_AI_TEMPLATE', check: 'aiFlavor', severity: 'info', hint: '换掉套路句：写具体的动作、声音或触感' },

  // 4 一致性 — cross-checks against the setting library (never a second opinion about the
  // library itself: the library is the truth, the prose is what disagrees with it).
  { code: 'GATE_CONSISTENCY_POV_UNKNOWN', check: 'consistency', severity: 'warning', hint: 'pov 写角色卡里的名字或别名，或先补这张角色卡' },
  { code: 'GATE_CONSISTENCY_FACT_STALE', check: 'consistency', severity: 'info', hint: '若是回忆/回溯，把取值放进回忆语境；否则按账本当前取值改写' },

  // 5 敏感自查
  { code: 'GATE_SENSITIVE_WORD', check: 'sensitive', severity: 'warning', hint: '确认这句是否必要；必要时改成侧写，避免直陈' },

  // 6 平台规则 — the form rules platforms actually reject on: pasted-in page residue and
  // off-site promotion. Q6's platform word-count window is item 1's range; reporting one fact
  // twice would just double the noise.
  { code: 'GATE_PLATFORM_RESIDUE', check: 'platform', severity: 'warning', hint: '删掉分页、求票、码字工具留下的残留句' },
  { code: 'GATE_PLATFORM_PROMO', check: 'platform', severity: 'warning', hint: '删掉站外引流与广告词：平台会直接下架或限流' },

  // 7 机械校对 — the six classes of issue #44 plus the number/unit pair. These are the ones a
  // person would call "错字" rather than "写得不好".
  { code: 'GATE_PROOF_PUNCT_UNPAIRED', check: 'proofread', severity: 'warning', hint: '补齐或删掉不成对的引号、括号、书名号' },
  { code: 'GATE_PROOF_HALF_PUNCT', check: 'proofread', severity: 'info', hint: '把中文语境里的 , ; : ! ? 改成全角，或改写成中文标点' },
  { code: 'GATE_PROOF_FULLWIDTH_ALNUM', check: 'proofread', severity: 'info', hint: '把全角字母与数字改成半角' },
  { code: 'GATE_PROOF_REPEAT_WORD', check: 'proofread', severity: 'info', hint: '删掉重复的字词（手误或连打）' },
  { code: 'GATE_PROOF_NEAR_NAME', check: 'proofread', severity: 'warning', hint: '核对是不是把角色名写错了：名字必须与角色卡一致' },
  { code: 'GATE_PROOF_APPELLATION_MIXED', check: 'proofread', severity: 'info', hint: '同一章内统一称谓：选定一个，其余改成动作指代' },
  { code: 'GATE_PROOF_ARABIC_MEASURE', check: 'proofread', severity: 'info', hint: '正文数量一般写汉字（三个、五次），年份与编号除外' },
  { code: 'GATE_PROOF_NUMBER_MIXED', check: 'proofread', severity: 'info', hint: '同一段里统一数字写法：要么全阿拉伯数字，要么全汉字' },
]

const SPEC_BY_CODE = new Map(GATE_CODES.map((spec) => [spec.code, spec]))

/** The check that owns a code (`undefined` for a code this module does not emit). */
export function gateCheckOf(code: string): GateCheckId | undefined {
  return SPEC_BY_CODE.get(code)?.check
}

/**
 * Build one finding. `group` and `fixable` come from the shared catalogue, so the two lists
 * cannot disagree; an undeclared code is a programming error, not a finding, and
 * `tests/quality-gate.test.js` pins both lists so it cannot reach a build.
 */
export function gateFinding(code: string, locator: FindingLocator, detail: string): Finding {
  const spec = SPEC_BY_CODE.get(code)
  const catalogue = findingCode(code)
  if (spec === undefined || catalogue === undefined) {
    throw new Error(`gate code ${code} is missing from GATE_CODES or FINDING_CODES`)
  }
  return { code, group: catalogue.group, severity: spec.severity, locator, detail, hint: spec.hint, fixable: catalogue.fixable }
}
