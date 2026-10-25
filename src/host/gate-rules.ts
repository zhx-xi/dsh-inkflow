/**
 * Issue #44 — the seven quality gates: the rules themselves.
 *
 * Two constraints decide the shape of this file, and both are contracts rather than
 * preferences:
 *
 *   * **No model call, ever** (roadmap X-26). Every judgement below is a regular expression,
 *     a small static list or an arithmetic threshold over the chapter text. Nothing leaves the
 *     process, so gating one chapter costs the reads `gate.ts` already made plus a handful of
 *     scans — deterministically, and far under a second.
 *   * **The problem shape is `findings.ts`'s** (ADR-0022 D3 / X-24). A rule never invents a
 *     field: it returns `Finding` rows through `gateFinding()`, and `group` / `fixable` are
 *     looked up in the shared catalogue, so a gate code cannot carry a second opinion about
 *     which family it belongs to or whether the repair pass can fix it.
 *
 * Three files, one subject: `gate-vocabulary.ts` owns the words (check ids, code table,
 * thresholds, input types), `gate-text.ts` owns the pure text helpers, and this file owns the
 * seven judgements plus the table the report walks — so no single file both defines and uses
 * the words.
 *
 * ## Why the seven checks are seven `check` ids but only five `group`s
 *
 * `FINDING_GROUPS` is the audit's five invariant families and is pinned by
 * `tests/audit.test.js` (the report always prints all five, all of them meaning "the book's own
 * data"), so ADR-0022 D3 files the gates into the existing five rather than growing the enum.
 * The rule used here is "which family of book facts does this finding touch": a name or an
 * entity reference is `structure`, a ledger value is `ledger`, and everything that is a fact
 * about the chapter *text* is `catalog` (the chapter family). The seven checks stay
 * distinguishable through their codes and through `GATE_CODES`' `check` column — the panel
 * groups by that, not by `group`. A new enum member would make every audit report print a
 * permanently empty section, which reads as "the gate passed" when the audit never runs it.
 *
 * ## 「检测到」与「可自动改写」是两件事
 *
 * Every finding here is a **detection**: a regular expression, a static list or a threshold
 * said "this looks wrong", and that is all this module claims. `fixable` therefore stays
 * `false` for all of them, including the mechanical proofreading classes a program *could*
 * rewrite — the rewrite would have to live in `repair.ts` (the one repair path, which
 * dispatches on the code), and no `GATE_*` action exists there. Promising `fixable: true`
 * without that action turns 「一键修复」 into a button that does nothing while the report says
 * "N 项可自动修复" — the #143 / ADR-0015 D2 accident. The classes stay detectable now; the flip
 * belongs to the commit that teaches `repair.ts` the rewrite, with its own tests.
 */

import type { Finding } from './findings.js'
import { checkProofread } from './gate-proofread.js'
import {
  charLength,
  chapterLocator,
  exceedsAllowance,
  finalClause,
  fixed,
  GATE_DENSITY_FLOOR,
  lineLocator,
  lineOf,
  occurrences,
  paragraphsOf,
  per1000,
  sentencesOf,
} from './gate-text.js'
import { GATE_CHECK_IDS, GATE_CHECK_LABELS, gateFinding } from './gate-vocabulary.js'
import type { GateCheckId, GateInput } from './gate-vocabulary.js'

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
  if (exceedsAllowance(dashes, t.aiDashPer1000, wordCount)) {
    out.push(
      gateFinding(
        'GATE_AI_PUNCT',
        chapterLocator(input),
        `破折号 ${String(dashes)} 处（每千字 ${fixed(per1000(dashes, wordCount), 2)}，上限 ${fixed(t.aiDashPer1000, 2)}）`,
      ),
    )
  }
  if (exceedsAllowance(ellipses, t.aiEllipsisPer1000, wordCount)) {
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
