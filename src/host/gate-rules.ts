/**
 * Issue #44 — the seven quality gates: their vocabulary and their rules.
 *
 * Two constraints decide the shape of this file, and both are contracts rather than
 * preferences:
 *
 *   * **No model call, ever** (roadmap X-26). Every judgement below is a regular
 *     expression, a small static list or an arithmetic threshold over the chapter text.
 *     Nothing leaves the process, so gating one chapter costs the reads `gate.ts` already
 *     made plus a handful of scans — deterministically, and far under a second.
 *   * **The problem shape is `findings.ts`'s** (ADR-0022 D3 / X-24). A rule never invents
 *     a field: it returns `Finding` rows, and `group` / `fixable` are looked up in the
 *     shared catalogue, so a gate code cannot carry a second opinion about which family
 *     it belongs to or whether the repair pass can fix it.
 *
 * ## Why the seven checks are seven `check` ids but only five `group`s
 *
 * `FINDING_GROUPS` is the audit's five invariant families and is pinned by
 * `tests/audit.test.js` (the report always prints all five, all of them meaning "the
 * book's own data"), so ADR-0022 D3 says the gates file into the existing five rather
 * than growing the enum. The rule used here is "which family of book facts does this
 * finding touch": a name or an entity reference is `structure`, a ledger value is
 * `ledger`, and everything that is a fact about the chapter *text* is `catalog` (the
 * chapter family). The seven checks stay distinguishable through their **codes** and
 * through the `check` column of this table — the panel groups by that, not by `group`.
 * A new enum member would make every audit report print a permanently empty section,
 * which reads as "the gate passed" when the audit simply never runs it.
 *
 * ## `fixable` is false for all of them, on purpose
 *
 * `repair.ts` is the one repair path and it dispatches on the code; there is no action
 * behind `GATE_PROOF_*` yet. A `fixable: true` with no action makes the report say "1 项
 * 可由一键修复处理" and the button then does nothing — the accident #143 and ADR-0015 D2
 * record (`tests/repair.test.js` keeps it from coming back). The mechanical classes stay
 * *detectable* here; the flip to `fixable: true` belongs to the commit that also teaches
 * `repair.ts` the rewrite, with its own tests.
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
 * thresholds cannot be reproduced: "12 项" means nothing if the next run used a
 * different word-count window. The six de-AI dimensions' numbers are the defaults
 * below, not law — `open-questions.md` Q4 still holds "具体维度与阈值" as open, so a
 * caller may pass its own and the file will say which were used.
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
 * Everything the seven rules may read. Assembled once by `gate.ts`, so a rule never
 * touches the disk (which is what makes the whole run one pass of reads) and the
 * determinism test can feed the same input twice.
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
 * `group` and `fixable` are **not** here — they come from `FINDING_CODES` (see the file
 * header). Severity is here because `blocking` is reserved for a write refusal
 * (`findings.ts` says so) and a gate is a read: the loudest a gate ever gets is
 * `warning`.
 */
export const GATE_CODES: readonly GateCodeSpec[] = [
  // 1 字数 — the target range, not the platform's hard window (that is item 6's residue
  // rules' neighbour: item 6 owns form, item 1 owns "did you write the chapter you
  // planned").
  { code: 'GATE_WORD_COUNT_LOW', check: 'wordCount', severity: 'info', hint: '按任务书区间补足内容，或与大纲核对本章目标字数' },
  { code: 'GATE_WORD_COUNT_HIGH', check: 'wordCount', severity: 'info', hint: '删掉不推动剧情的内容，或与大纲核对本章目标字数' },

  // 2 章末钩子
  { code: 'GATE_HOOK_MISSING', check: 'hook', severity: 'warning', hint: '章末落在新处境、新疑问或新威胁上，不要用收束句结束' },
  { code: 'GATE_HOOK_SUMMARY', check: 'hook', severity: 'warning', hint: '删掉末段的总结、抒情与预告，让场景自己收口' },

  // 3 六维去 AI 味 — one code per dimension (open-questions Q4), so a report row names
  // the dimension instead of "AI 味" in general.
  { code: 'GATE_AI_SENTENCE', check: 'aiFlavor', severity: 'info', hint: '动作段用短句（10–25 字），把成串的长句切开' },
  { code: 'GATE_AI_PUNCT', check: 'aiFlavor', severity: 'info', hint: '破折号一章 0–1 处；省略号不要用来拖节奏' },
  { code: 'GATE_AI_PARALLEL', check: 'aiFlavor', severity: 'info', hint: '「不是…而是…」与连续同构句只在真需要排比处使用' },
  { code: 'GATE_AI_NARRATION', check: 'aiFlavor', severity: 'info', hint: '删掉动作之后的情绪结论，让读者从动作里读出来' },
  { code: 'GATE_AI_MODIFIER', check: 'aiFlavor', severity: 'info', hint: '少堆「的/地」与程度副词，改写成具体动作或细节' },
  { code: 'GATE_AI_TEMPLATE', check: 'aiFlavor', severity: 'info', hint: '换掉套路句：写具体的动作、声音或触感' },

  // 4 一致性 — cross-checks against the setting library (never a second opinion about
  // the library itself: the library is the truth, the prose is what disagrees with it).
  { code: 'GATE_CONSISTENCY_POV_UNKNOWN', check: 'consistency', severity: 'warning', hint: 'pov 写角色卡里的名字或别名，或先补这张角色卡' },
  { code: 'GATE_CONSISTENCY_FACT_STALE', check: 'consistency', severity: 'info', hint: '若是回忆/回溯，把取值放进回忆语境；否则按账本当前取值改写' },

  // 5 敏感自查
  { code: 'GATE_SENSITIVE_WORD', check: 'sensitive', severity: 'warning', hint: '确认这句是否必要；必要时改成侧写，避免直陈' },

  // 6 平台规则 — the form rules platforms actually reject on: pasted-in page residue and
  // off-site promotion. The platform word-count window of Q6 is item 1's range plus the
  // platform table's own limits; reporting it twice would double-count one fact.
  { code: 'GATE_PLATFORM_RESIDUE', check: 'platform', severity: 'warning', hint: '删掉分页、求票、码字工具留下的残留句' },
  { code: 'GATE_PLATFORM_PROMO', check: 'platform', severity: 'warning', hint: '删掉站外引流与广告词：平台会直接下架或限流' },

  // 7 机械校对 — the six classes of issue #44 plus the number/unit pair. These are the
  // ones a person would call "错字" rather than "写得不好".
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
 * Build one finding. `group` and `fixable` come from the shared catalogue, so the two
 * lists cannot disagree; an undeclared code is a programming error, not a finding, and
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

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

function chapterLocator(input: GateInput): FindingLocator {
  return { kind: 'chapter', chapterId: input.chapter.id }
}

function lineLocator(input: GateInput, line: number): FindingLocator {
  return { kind: 'path', path: input.chapter.path, line }
}

/** 1-based line of a character offset in the body. */
function lineOf(body: string, index: number): number {
  let line = 1
  const end = Math.min(Math.max(index, 0), body.length)
  for (let at = 0; at < end; at += 1) if (body[at] === '\n') line += 1
  return line
}

interface Paragraph {
  readonly line: number
  readonly text: string
}

/** Non-empty paragraphs with their starting line — the unit "same paragraph" means. */
function paragraphsOf(body: string): Paragraph[] {
  const out: Paragraph[] = []
  let line = 1
  for (const raw of body.split('\n')) {
    const text = raw.trim()
    if (text !== '') out.push({ line, text })
    line += 1
  }
  return out
}

/** Sentences without their terminators; empty fragments dropped. */
function sentencesOf(body: string): string[] {
  return body
    .split(/[。！？!?…]+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '')
}

/**
 * The final clause **with its terminator**: everything after the second-to-last sentence
 * break. Keeping the terminator is the whole point — a chapter ending in 「？」 is a hook, and
 * splitting the punctuation away (which `sentencesOf` does, correctly, for length statistics)
 * would hide exactly the signal this rule looks for.
 */
function finalClause(text: string): string {
  const terminators = new Set(['。', '！', '？', '!', '?', '…'])
  let last = -1
  let previous = -1
  const chars = [...text]
  for (let at = 0; at < chars.length; at += 1) {
    const char = chars[at]
    if (char === undefined || !terminators.has(char)) continue
    previous = last
    last = at
  }
  const start = previous >= 0 ? previous + 1 : 0
  return chars.slice(start).join('').trim()
}

function occurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let at = haystack.indexOf(needle)
  while (at >= 0) {
    count += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

function charLength(text: string): number {
  return [...text].length
}

function per1000(count: number, wordCount: number): number {
  return (count * 1000) / Math.max(1, wordCount)
}

function fixed(value: number, digits = 1): string {
  return value.toFixed(digits)
}

function hanOnly(text: string): boolean {
  return /^[\u4e00-\u9fff]+$/u.test(text)
}

/**
 * Below this many characters a "per 1000 characters" ratio is arithmetic noise (one dash
 * in 200 characters reads as 5/1000). The modifier density therefore starts here; a chapter
 * that short is already item 1's finding, so nothing is lost. The dash and ellipsis rules do
 * not need this floor: they carry an allowance of at least one occurrence per chapter.
 */
const GATE_DENSITY_FLOOR = 1000

/**
 * How many occurrences a per-1000 rate allows in *this* chapter, never fewer than one.
 *
 * The writer skill's rule is per chapter (「破折号一章 0–1 处」), not per mille: a 2500-word
 * chapter with one dash is fine and a 400-word chapter with one dash is not a punctuation
 * problem at all. Rounding the rate down and keeping a floor of one turns the configured
 * ratio into "one per 1667 characters, at least one" without a second rule.
 */
function allowance(count: number, rate: number, wordCount: number): boolean {
  return count > Math.max(1, Math.floor((wordCount * rate) / 1000))
}

// ---------------------------------------------------------------------------
// 1 字数
// ---------------------------------------------------------------------------

function checkWordCount(input: GateInput): Finding[] {
  const { wordCount } = input.chapter
  const { wordCountMin, wordCountMax } = input.thresholds
  const out: Finding[] = []
  if (wordCount < wordCountMin) {
    out.push(
      gateFinding('GATE_WORD_COUNT_LOW', chapterLocator(input), `本章 ${String(wordCount)} 字，低于目标下限 ${String(wordCountMin)} 字`),
    )
  }
  if (wordCount > wordCountMax) {
    out.push(
      gateFinding('GATE_WORD_COUNT_HIGH', chapterLocator(input), `本章 ${String(wordCount)} 字，超过目标上限 ${String(wordCountMax)} 字`),
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// 2 章末钩子
// ---------------------------------------------------------------------------

/**
 * Openers that mark a closing summary rather than a new situation. The list is short on
 * purpose: it is the author's own wording ("总之/就这样/后来") plus the two markers every
 * serial platform strips ("未完待续", "待续").
 */
const SUMMARY_OPENERS = /^(总之|总而言之|就这样|于是|因此|从此|后来|一切|未来|接下来|后面|至于)/u
/**
 * What counts as a hook: a question, an exclamation, a trailing ellipsis, or one of the
 * turn words a scene ends on. Deliberately generous — this rule exists to catch "the
 * chapter ended with a plain declarative sentence", not to grade the wording.
 */
const HOOK_MARKERS = /[？！?!…]|(忽然|突然|竟然|没想到|就在这时|偏偏|却|只有|原来|要不要|似乎|隐约|好像|有什么|不知)/u

function checkHook(input: GateInput): Finding[] {
  const paragraphs = paragraphsOf(input.chapter.body)
  const last = paragraphs.at(-1)
  // An empty chapter is item 1's finding ("0 字"); saying "no hook" as well is noise.
  if (last === undefined) return []
  const clause = finalClause(last.text)
  if (SUMMARY_OPENERS.test(last.text) || /(未完待续|待续)/u.test(last.text)) {
    return [gateFinding('GATE_HOOK_SUMMARY', lineLocator(input, last.line), '章末一段是总结/抒情/预告，不是新的处境或疑问')]
  }
  if (!HOOK_MARKERS.test(clause)) {
    const shown = [...clause].length > 24 ? `${[...clause].slice(0, 24).join('')}…` : clause
    return [gateFinding('GATE_HOOK_MISSING', lineLocator(input, last.line), `章末没有钩子信号：「${shown}」`)]
  }
  return []
}

// ---------------------------------------------------------------------------
// 3 六维去 AI 味
// ---------------------------------------------------------------------------

const CLICHES: readonly string[] = [
  '空气仿佛凝固',
  '时间仿佛静止',
  '仿佛过了一个世纪',
  '不知过了多久',
  '心中五味杂陈',
  '百感交集',
  '命运的齿轮',
  '一切都结束了',
  '故事才刚刚开始',
  '没有人知道',
]

/**
 * Explanatory narration: the emotion is *told* right after it was shown, or in place of
 * showing it. Three shapes cover the filed complaints (#44 / writer skill 去 AI 味):
 * 「心中一沉」式, 「感到愤怒」式, and the four-character summary of a feeling.
 */
const NARRATION: readonly RegExp[] = [
  /(?:他|她|我)(?:心中|心里|内心)(?:一|顿|猛地|骤然)?(?:沉|凉|紧|暖|酸|苦|惊|喜|痛|软)/u,
  /(?:感到|觉得)(?:一阵|一股)?(?:愤怒|悲伤|恐惧|害怕|高兴|难过|羞愧|激动|紧张|无助|绝望)/u,
  /(?:心中|心里|内心)(?:五味杂陈|一片冰凉|翻江倒海|百感交集|涌起一股|微微一暖)/u,
]

function checkAiFlavor(input: GateInput): Finding[] {
  const body = input.chapter.body
  const { wordCount } = input.chapter
  const t = input.thresholds
  const out: Finding[] = []

  // Dimension 1 — sentence-length distribution.
  const sentences = sentencesOf(body).filter((sentence) => charLength(sentence) >= 4)
  if (sentences.length >= 8) {
    const lengths = sentences.map((sentence) => charLength(sentence))
    const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length
    const variance = lengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lengths.length
    const deviation = Math.sqrt(variance)
    if (mean > t.aiSentenceMeanMax) {
      out.push(
        gateFinding(
          'GATE_AI_SENTENCE',
          chapterLocator(input),
          `平均句长 ${fixed(mean)} 字（上限 ${String(t.aiSentenceMeanMax)} 字），长句成串`,
        ),
      )
    } else if (mean > 0 && deviation / mean < t.aiSentenceEvenness) {
      out.push(
        gateFinding(
          'GATE_AI_SENTENCE',
          chapterLocator(input),
          `句长过于均匀（平均 ${fixed(mean)} 字，标准差 ${fixed(deviation)}，变异系数 ${fixed(deviation / mean, 2)}）`,
        ),
      )
    }
  }

  // Dimension 2 — dash and ellipsis. One dash in Chinese is written 「——」, so the count is
  // over that pair; one ellipsis is a run of 「…」, counted per run.
  const dashes = occurrences(body, '——')
  const ellipses = (body.match(/…+/gu) ?? []).length
  if (allowance(dashes, t.aiDashPer1000, wordCount)) {
    out.push(
      gateFinding(
        'GATE_AI_PUNCT',
        chapterLocator(input),
        `破折号 ${String(dashes)} 处（每千字 ${fixed(per1000(dashes, wordCount), 2)}，上限 ${fixed(t.aiDashPer1000, 2)}）`,
      ),
    )
  }
  if (allowance(ellipses, t.aiEllipsisPer1000, wordCount)) {
    out.push(
      gateFinding(
        'GATE_AI_PUNCT',
        chapterLocator(input),
        `省略号 ${String(ellipses)} 处（每千字 ${fixed(per1000(ellipses, wordCount), 2)}，上限 ${fixed(t.aiEllipsisPer1000, 2)}）`,
      ),
    )
  }

  // Dimension 3 — 「不是…而是…」 and three consecutive sentences sharing their opening.
  const parallel = (body.match(/不是[^。！？!?\n]{0,18}?而是/gu) ?? []).length
  let triad = 0
  const openers = sentences.map((sentence) => [...sentence].slice(0, 2).join(''))
  for (let at = 0; at + 2 < openers.length; at += 1) {
    const first = openers[at]
    if (first === undefined || charLength(first) < 2) continue
    if (first === openers[at + 1] && first === openers[at + 2]) triad += 1
  }
  if (parallel > 0 || triad > 0) {
    out.push(
      gateFinding(
        'GATE_AI_PARALLEL',
        chapterLocator(input),
        `「不是…而是…」${String(parallel)} 处 · 连续三句同构 ${String(triad)} 处`,
      ),
    )
  }

  // Dimension 4 — explanatory narration, one finding per hit (the line matters here).
  let narrations = 0
  for (const pattern of NARRATION) {
    for (const match of body.matchAll(new RegExp(pattern.source, 'gu'))) {
      if (narrations >= t.maxFindingsPerRule) break
      narrations += 1
      out.push(
        gateFinding(
          'GATE_AI_NARRATION',
          lineLocator(input, lineOf(body, match.index ?? 0)),
          `动作之后又补了一句情绪结论：「${match[0]}」`,
        ),
      )
    }
  }

  // Dimension 5 — 「的/地」 and degree adverbs.
  const modifiers =
    (body.match(/[的地]/gu) ?? []).length + (body.match(/非常|十分|极其|格外|特别|异常|万分/gu) ?? []).length
  if (wordCount >= GATE_DENSITY_FLOOR && per1000(modifiers, wordCount) > t.aiModifierPer1000) {
    out.push(
      gateFinding(
        'GATE_AI_MODIFIER',
        chapterLocator(input),
        `「的/地」与程度副词 ${String(modifiers)} 处（每千字 ${fixed(per1000(modifiers, wordCount), 1)}，上限 ${fixed(t.aiModifierPer1000, 1)}）`,
      ),
    )
  }

  // Dimension 6 — cliché at the end of a paragraph.
  let templates = 0
  for (const paragraph of paragraphsOf(body)) {
    if (templates >= t.maxFindingsPerRule) break
    const hit = CLICHES.find((cliche) => paragraph.text.includes(cliche))
    if (hit === undefined) continue
    templates += 1
    out.push(gateFinding('GATE_AI_TEMPLATE', lineLocator(input, paragraph.line), `段尾套路话：「${hit}」`))
  }

  return out
}

// ---------------------------------------------------------------------------
// 4 一致性
// ---------------------------------------------------------------------------

/** Every spelling a ledger subject may appear under in the prose. */
function namesOfSubject(input: GateInput, subject: string): string[] {
  const entry = input.roster.find((candidate) => candidate.id === subject || candidate.name === subject)
  if (entry === undefined) return [subject]
  return [entry.name, ...entry.aliases, subject]
}

function checkConsistency(input: GateInput): Finding[] {
  const out: Finding[] = []
  const pov = (input.chapter.pov ?? '').trim()
  if (pov !== '') {
    const known = input.roster.some(
      (entry) => entry.id === pov || entry.name === pov || entry.aliases.includes(pov),
    )
    if (!known) {
      out.push(
        gateFinding('GATE_CONSISTENCY_POV_UNKNOWN', lineLocator(input, 1), `frontmatter 的 pov「${pov}」不在角色库里`),
      )
    }
  }

  // A ledger value whose interval has already closed, still written in this chapter.
  const chapterSeq = input.chapter.seq
  if (chapterSeq === undefined) return out
  const paragraphs = paragraphsOf(input.chapter.body)
  let stale = 0
  for (const fact of input.facts) {
    if (stale >= input.thresholds.maxFindingsPerRule) break
    const until = fact.until
    if (until === undefined || charLength(fact.value) < 2) continue
    const untilSeq = input.seqOf(until)
    if (untilSeq === undefined || chapterSeq < untilSeq) continue
    const names = namesOfSubject(input, fact.subject)
    const hit = paragraphs.find(
      (paragraph) => paragraph.text.includes(fact.value) && names.some((name) => paragraph.text.includes(name)),
    )
    if (hit === undefined) continue
    stale += 1
    out.push(
      gateFinding(
        'GATE_CONSISTENCY_FACT_STALE',
        lineLocator(input, hit.line),
        `账本记 ${fact.attribute}「${fact.value}」自 ${until} 起不再成立，本章仍写`,
      ),
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// 5 敏感自查
// ---------------------------------------------------------------------------

/**
 * A self-check list, not a censorship engine: the author asks the gate to point at lines a
 * platform's review is likely to reject (violence, sexual content, illegal trade,
 * self-harm). Matching is literal and the finding only says *which* term and *where* — the
 * gate never rewrites anything.
 */
const SENSITIVE_TERMS: readonly string[] = [
  '踩踏致死',
  '肢解',
  '斩首',
  '灭门',
  '屠城',
  '血腥',
  '自杀方法',
  '割腕',
  '服毒',
  '性虐',
  '强奸',
  '幼女',
  '毒品交易',
  '制毒',
  '炸药制作',
  '枪支弹药',
  '邪教',
  '分裂国家',
  '颠覆国家',
]

function checkSensitive(input: GateInput): Finding[] {
  const body = input.chapter.body
  const out: Finding[] = []
  for (const term of SENSITIVE_TERMS) {
    if (out.length >= input.thresholds.maxFindingsPerRule) break
    const at = body.indexOf(term)
    if (at < 0) continue
    const count = occurrences(body, term)
    out.push(
      gateFinding(
        'GATE_SENSITIVE_WORD',
        lineLocator(input, lineOf(body, at)),
        `命中敏感词表：「${term}」×${String(count)}`,
      ),
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// 6 平台规则
// ---------------------------------------------------------------------------

/** Pasted-in residue from editors, word-count tools and other platforms' pagination. */
const PLATFORM_RESIDUE: readonly string[] = [
  '求收藏',
  '求推荐',
  '求月票',
  '求订阅',
  '求打赏',
  '本章未完',
  '点击下一页',
  '未完待续',
  '字数不足',
  '章节报错',
]

/** Off-site promotion and advertising — what a platform rejects outright. */
const PLATFORM_PROMO: readonly string[] = [
  '加微信',
  '微信号',
  '公众号',
  '扫码',
  'QQ群',
  '群号',
  '私信我',
  '点击链接',
  '限时特价',
  '全网最低',
]

function checkPlatform(input: GateInput): Finding[] {
  const body = input.chapter.body
  const out: Finding[] = []
  for (const term of PLATFORM_RESIDUE) {
    if (out.length >= input.thresholds.maxFindingsPerRule) break
    const at = body.indexOf(term)
    if (at < 0) continue
    out.push(gateFinding('GATE_PLATFORM_RESIDUE', lineLocator(input, lineOf(body, at)), `正文残留：「${term}」`))
  }
  const url = /https?:\/\/\S+/u.exec(body)
  if (url !== null && out.length < input.thresholds.maxFindingsPerRule) {
    out.push(gateFinding('GATE_PLATFORM_PROMO', lineLocator(input, lineOf(body, url.index)), '正文里有外部链接'))
  }
  for (const term of PLATFORM_PROMO) {
    if (out.length >= input.thresholds.maxFindingsPerRule) break
    const at = body.indexOf(term)
    if (at < 0) continue
    out.push(gateFinding('GATE_PLATFORM_PROMO', lineLocator(input, lineOf(body, at)), `站外引流/广告词：「${term}」`))
  }
  return out
}

// ---------------------------------------------------------------------------
// 7 机械校对
// ---------------------------------------------------------------------------

/** Punctuation that must appear in pairs. Half-width `"` is checked separately (parity). */
const PAIRS: readonly (readonly [string, string])[] = [
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
  ['《', '》'],
  ['（', '）'],
  ['〔', '〕'],
  ['【', '】'],
]

const FULLWIDTH_ALNUM = /[０-９Ａ-Ｚａ-ｚ]/gu
const HALF_PUNCT_NEAR_HAN = /[\u4e00-\u9fff][,;:!?]|[,;:!?][\u4e00-\u9fff]/gu

/** Function words that are never legitimately doubled; 个/人/看/渐 are legit and excluded. */
const DOUBLE_FUNCTION_WORD = /(的|了|是|在|和|与|就|都|也|而|又|则|之|其|把|被|将|从|对|向|我|他|她|你|们)\1/gu
/**
 * A closed list of adverbs that are never reduplicated — the 「忽然忽然」 class.
 *
 * Why a list rather than "any two characters repeated": Chinese repeats two-character
 * groups on purpose (「一声一声」「一步一步」「很久很久」「琢磨琢磨」), so a general rule fires on
 * good prose far more often than on a stuck key. The words below cannot be doubled, which
 * makes this half of the check both precise and complete for the cases that matter.
 */
const DOUBLE_ADVERB =
  /(忽然|突然|立刻|马上|已经|正在|但是|而且|然后|似乎|仿佛|好像|因此|于是|随即|渐渐|仍旧|依然)\1/gu

const ARABIC_MEASURE =
  /(?<![\d第年月日时])([1-9]\d?)(个|名|位|岁|次|天|斤|里|尺|丈|口|只|匹|贯|文|把|张|条|件)(?![年月日])/gu
const CHINESE_MEASURE = /([一二两三四五六七八九十百千]+)(年|月|日|个|名|位|岁|次|天|把|张|条|件)/gu
const ARABIC_MEASURE_FOR_MIX = /(\d+)(年|月|日|个|名|位|岁|次|天|把|张|条|件)/gu

/** Line of the first punctuation imbalance; the last unmatched opener's line otherwise. */
function imbalanceLine(body: string, open: string, close: string): number {
  let depth = 0
  let lastOpen = -1
  for (let at = 0; at < body.length; at += 1) {
    const char = body[at]
    if (char === open) {
      depth += 1
      lastOpen = at
    } else if (char === close) {
      depth -= 1
      if (depth < 0) return lineOf(body, at)
    }
  }
  return lastOpen >= 0 ? lineOf(body, lastOpen) : 1
}

/** Exactly one character differs, same length. */
function differByOne(left: string, right: string): boolean {
  const a = [...left]
  const b = [...right]
  if (a.length !== b.length) return false
  let diff = 0
  for (let at = 0; at < a.length; at += 1) {
    if (a[at] !== b[at]) diff += 1
    if (diff > 1) return false
  }
  return diff === 1
}

interface NameHit {
  readonly form: string
  readonly canonical: string
  readonly index: number
}

/**
 * Names that are one character away from a declared name but are not declared.
 *
 * Only names of **three or more characters** take part: with two-character names every
 * common word that shares one character with a name ("清风" vs 「清音」) becomes a candidate,
 * and a checker whose noise exceeds its signal is worse than none. The limitation is
 * stated here rather than discovered by the author in a report they stop reading.
 */
function nearNameHits(input: GateInput): NameHit[] {
  const declared = new Map<string, string>()
  for (const entry of input.roster) {
    for (const form of [entry.name, ...entry.aliases]) {
      if (charLength(form) >= 3 && hanOnly(form)) declared.set(form, entry.name)
    }
  }
  if (declared.size === 0) return []
  const lengths = [...new Set([...declared.keys()].map((form) => charLength(form)))].sort((a, b) => a - b)
  const chars = [...input.chapter.body]
  const seen = new Map<string, NameHit>()
  for (let at = 0; at < chars.length; at += 1) {
    for (const length of lengths) {
      if (at + length > chars.length) continue
      const window = chars.slice(at, at + length).join('')
      if (!hanOnly(window)) continue
      if (declared.has(window) || seen.has(window)) continue
      for (const [form, canonical] of declared) {
        if (charLength(form) !== length) continue
        if (!differByOne(window, form)) continue
        seen.set(window, { form: window, canonical, index: at })
        break
      }
    }
  }
  return [...seen.values()].sort((left, right) => left.index - right.index)
}

/**
 * How often each spelling of one character occurs in this chapter. Longest form first, so
 * 「李慕白」 does not also count as an occurrence of an alias 「慕白」.
 */
function formCounts(input: GateInput, entry: GateRosterEntry): Map<string, number> {
  const body = input.chapter.body
  const forms = [entry.name, ...entry.aliases]
    .filter((form) => charLength(form) >= 2)
    .sort((left, right) => charLength(right) - charLength(left))
  const used = new Array<boolean>(body.length).fill(false)
  const counts = new Map<string, number>()
  for (const form of forms) {
    let count = 0
    let at = body.indexOf(form)
    while (at >= 0) {
      let free = true
      for (let offset = 0; offset < form.length; offset += 1) {
        if (used[at + offset] === true) free = false
      }
      if (free) {
        for (let offset = 0; offset < form.length; offset += 1) used[at + offset] = true
        count += 1
      }
      at = body.indexOf(form, at + form.length)
    }
    if (count > 0) counts.set(form, count)
  }
  return counts
}

function checkProofread(input: GateInput): Finding[] {
  const body = input.chapter.body
  const max = input.thresholds.maxFindingsPerRule
  const out: Finding[] = []

  // (a) punctuation pairs
  for (const [open, close] of PAIRS) {
    if (out.length >= max) break
    const opens = occurrences(body, open)
    const closes = occurrences(body, close)
    if (opens === closes) continue
    out.push(
      gateFinding(
        'GATE_PROOF_PUNCT_UNPAIRED',
        lineLocator(input, imbalanceLine(body, open, close)),
        `左「${open}」${String(opens)} 个、右「${close}」${String(closes)} 个，未成对`,
      ),
    )
  }
  const straight = occurrences(body, '"')
  if (straight % 2 === 1 && out.length < max) {
    out.push(
      gateFinding(
        'GATE_PROOF_PUNCT_UNPAIRED',
        lineLocator(input, lineOf(body, body.indexOf('"'))),
        `直引号 " 出现 ${String(straight)} 次（奇数），未成对`,
      ),
    )
  }

  // (b) half-width punctuation next to Han characters
  const halfHits = [...body.matchAll(HALF_PUNCT_NEAR_HAN)]
  const firstHalf = halfHits[0]
  if (firstHalf !== undefined) {
    out.push(
      gateFinding(
        'GATE_PROOF_HALF_PUNCT',
        lineLocator(input, lineOf(body, firstHalf.index ?? 0)),
        `半角标点紧邻汉字 ${String(halfHits.length)} 处（首处「${firstHalf[0]}」），中文标点应写全角`,
      ),
    )
  }

  // (c) full-width letters and digits
  const fullwidth = [...new Set(body.match(FULLWIDTH_ALNUM) ?? [])].sort()
  const firstFullwidth = body.search(FULLWIDTH_ALNUM)
  if (fullwidth.length > 0 && firstFullwidth >= 0) {
    out.push(
      gateFinding(
        'GATE_PROOF_FULLWIDTH_ALNUM',
        lineLocator(input, lineOf(body, firstFullwidth)),
        `全角字母/数字：${fullwidth.join(' ')}`,
      ),
    )
  }

  // (d) doubled words
  let repeats = 0
  for (const match of body.matchAll(DOUBLE_FUNCTION_WORD)) {
    if (repeats >= max) break
    repeats += 1
    out.push(
      gateFinding('GATE_PROOF_REPEAT_WORD', lineLocator(input, lineOf(body, match.index ?? 0)), `重复字词：「${match[0]}」`),
    )
  }
  for (const match of body.matchAll(DOUBLE_ADVERB)) {
    if (repeats >= max) break
    repeats += 1
    out.push(
      gateFinding('GATE_PROOF_REPEAT_WORD', lineLocator(input, lineOf(body, match.index ?? 0)), `紧邻同词：「${match[0]}」连写`),
    )
  }

  // (e) near-miss names
  let near = 0
  for (const hit of nearNameHits(input)) {
    if (near >= max) break
    near += 1
    out.push(
      gateFinding(
        'GATE_PROOF_NEAR_NAME',
        lineLocator(input, lineOf(body, hit.index)),
        `「${hit.form}」与角色名「${hit.canonical}」只差一个字，疑似写错`,
      ),
    )
  }

  // (f) one character addressed by two spellings in one chapter
  for (const entry of input.roster) {
    if (out.length >= max + 4) break
    const counts = formCounts(input, entry)
    const used = [...counts.entries()].filter(([, count]) => count >= 2)
    if (used.length < 2) continue
    const detail = used.map(([form, count]) => `${form}×${String(count)}`).join('、')
    out.push(
      gateFinding(
        'GATE_PROOF_APPELLATION_MIXED',
        chapterLocator(input),
        `同一角色「${entry.name}」在本章混用称谓：${detail}`,
      ),
    )
  }

  // (g) numbers and measures
  const arabic = [...body.matchAll(ARABIC_MEASURE)]
  const firstArabic = arabic[0]
  if (firstArabic !== undefined && out.length < max + 6) {
    const forms = [...new Set(arabic.map((match) => match[0]))].slice(0, 5)
    out.push(
      gateFinding(
        'GATE_PROOF_ARABIC_MEASURE',
        lineLocator(input, lineOf(body, firstArabic.index ?? 0)),
        `阿拉伯数字+量词 ${String(arabic.length)} 处（如 ${forms.join('、')}）`,
      ),
    )
  }
  for (const paragraph of paragraphsOf(body)) {
    const chineseUnits = new Set([...paragraph.text.matchAll(CHINESE_MEASURE)].map((match) => match[2] ?? ''))
    const arabicUnits = new Set([...paragraph.text.matchAll(ARABIC_MEASURE_FOR_MIX)].map((match) => match[2] ?? ''))
    const shared = [...chineseUnits].filter((unit) => unit !== '' && arabicUnits.has(unit)).sort()
    if (shared.length === 0) continue
    out.push(
      gateFinding(
        'GATE_PROOF_NUMBER_MIXED',
        lineLocator(input, paragraph.line),
        `同一段里数字体系混写（单位 ${shared.join('、')}）：阿拉伯数字与汉字数字并用`,
      ),
    )
    break
  }

  return out
}

// ---------------------------------------------------------------------------
// The table the report and the panel walk
// ---------------------------------------------------------------------------

export interface GateCheck {
  readonly id: GateCheckId
  readonly label: string
  readonly run: (input: GateInput) => Finding[]
}

/** The seven checks, in `GATE_CHECK_IDS` order — the report's order, unchanged. */
export const GATE_CHECKS: readonly GateCheck[] = [
  { id: 'wordCount', label: GATE_CHECK_LABELS.wordCount, run: checkWordCount },
  { id: 'hook', label: GATE_CHECK_LABELS.hook, run: checkHook },
  { id: 'aiFlavor', label: GATE_CHECK_LABELS.aiFlavor, run: checkAiFlavor },
  { id: 'consistency', label: GATE_CHECK_LABELS.consistency, run: checkConsistency },
  { id: 'sensitive', label: GATE_CHECK_LABELS.sensitive, run: checkSensitive },
  { id: 'platform', label: GATE_CHECK_LABELS.platform, run: checkPlatform },
  { id: 'proofread', label: GATE_CHECK_LABELS.proofread, run: checkProofread },
]
