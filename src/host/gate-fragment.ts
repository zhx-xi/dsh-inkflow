/**
 * Issue #214 (B 块) — item 3's third direction: **太碎**.
 *
 * The six dimensions judged prose that is too long and too even. All three detectors here judge
 * the opposite — prose that has been chopped up — and they exist because nothing did:
 *
 *   1. `GATE_AI_STUTTER` — 电报体：连续 N 句都 ≤5 可见字；
 *   2. `GATE_AI_LOW_LINK` — 整章没有一处因果/转折/递进连接；
 *   3. `GATE_AI_LONG_PARA` — 单段砌成墙，中间没有换气的地方。
 *
 * ## 为什么单开一个文件（而不是塞进 `gate-rules.ts`）
 *
 * 同一个理由让 #212 的退化检测单开：`gate-rules.ts` 拥有前七项的字数/钩子/一致性/敏感/平台
 * 判定，而这三个判据是**同一个 check 里的另一族判据**，各有自己的阈值表与豁免规则（引号内
 * 豁免、密度下限、段落作为单位）。词表仍在 `gate-vocabulary.ts` 的 `FRAGMENT`（ADR-0027 D5
 * 的单一来源），本文件只写判定。
 *
 * ## 引号内是台词，不参与「太碎」判定
 *
 * 短句对话（「走。」「现在？」）是角色在说话，不是叙述在跳字；一段只有一句台词的段落也不是
 * 「砌成墙」。所以判据一律跑在 `stripQuoted()` / `maskQuoted()` 之后的叙述上——与
 * `gate-degeneration.ts` 同一条规矩、同一组助手（`gate-text.ts`）。
 *
 * 全是 detection，不是 rewrite：`fixable` 保持 `false`（ADR-0022 D3 / ADR-0015 D2）。
 */

import type { Finding } from './findings.js'
import {
  GATE_DENSITY_FLOOR,
  fixed,
  lineLocator,
  paragraphsOf,
  per1000,
  sentencesOf,
  stripQuoted,
  visibleLength,
} from './gate-text.js'
import { FRAGMENT, gateFinding } from './gate-vocabulary.js'
import type { GateInput } from './gate-vocabulary.js'

/** One sentence of narration and the line it sits on (a paragraph is one line in a chapter file). */
interface NarrationSentence {
  readonly line: number
  readonly length: number
}

/**
 * Every narration sentence of the chapter, in reading order, **across paragraph breaks**.
 *
 * The runs deliberately span paragraphs: the classic telegram draft is one short sentence per
 * paragraph, so a run that resets at every line break would never see it. A sentence that is
 * entirely dialogue disappears (`stripQuoted` leaves nothing to split), which is what keeps
 * short-line dialogue out of the count.
 */
function narrationSentences(input: GateInput): NarrationSentence[] {
  const out: NarrationSentence[] = []
  for (const paragraph of paragraphsOf(input.chapter.body)) {
    for (const sentence of sentencesOf(stripQuoted(paragraph.text))) {
      out.push({ line: paragraph.line, length: visibleLength(sentence) })
    }
  }
  return out
}

/**
 * 电报体：`stutterRun` 句连着都 ≤ `stutterSentenceMax` 可见字。
 *
 * One finding per run (capped by `maxFindingsPerRule`), anchored on the run's first line: the
 * defect is the stretch, not the individual sentence, and a chapter that does it once usually
 * does it again further down.
 */
export function findStutter(input: GateInput): Finding[] {
  const { stutterRun, stutterSentenceMax } = FRAGMENT
  const sentences = narrationSentences(input)
  const out: Finding[] = []
  let run = 0
  let runStart = 0
  for (let at = 0; at < sentences.length; at += 1) {
    const sentence = sentences[at]
    if (sentence === undefined || sentence.length > stutterSentenceMax) {
      run = 0
      continue
    }
    if (run === 0) runStart = at
    run += 1
    if (run !== stutterRun) continue
    if (out.length >= input.thresholds.maxFindingsPerRule) return out
    const first = sentences[runStart]
    out.push(
      gateFinding(
        'GATE_AI_STUTTER',
        lineLocator(input, first?.line ?? 1),
        `电报体：从第 ${String(first?.line ?? 1)} 行起连续 ${String(run)} 句都 ≤${String(stutterSentenceMax)} 字，读到后面没有一处能停`,
      ),
    )
  }
  return out
}

/**
 * How many linking words the chapter has, counted without double counting.
 *
 * Longest first, each hit masked out: 「但是」 must not also count as 「但」. Over-counting would
 * only make the rule quieter, but a number the report prints should be the number a reader
 * would count by hand.
 */
function countLinks(body: string): number {
  let rest = body
  let count = 0
  for (const word of [...FRAGMENT.lowLinkWords].sort((left, right) => right.length - left.length)) {
    const parts = rest.split(word)
    count += parts.length - 1
    rest = parts.join('\u0000')
  }
  return count
}

/**
 * 无连接词：长章里一处因果/转折/递进都没有。
 *
 * Density, not count, for the reason `exceedsAllowance` and the modifier dimension already
 * spell out: a 400-character excerpt is not a chapter. `GATE_DENSITY_FLOOR` is reused, so this
 * rule and the modifier dimension start judging at the same length — one floor, one reason (see
 * `gate-text.ts`). The lower bound in `FRAGMENT` is deliberately close to zero: the target is
 * 「整章一次连接都没有」, and any single 「但/却/因为」 makes the rule silent.
 */
export function findLowLink(input: GateInput): Finding[] {
  const { wordCount } = input.chapter
  if (wordCount < GATE_DENSITY_FLOOR) return []
  const links = countLinks(input.chapter.body)
  const density = per1000(links, wordCount)
  if (density >= FRAGMENT.lowLinkPer1000) return []
  return [
    gateFinding(
      'GATE_AI_LOW_LINK',
      { kind: 'chapter', chapterId: input.chapter.id },
      `全章 ${String(wordCount)} 字只有 ${String(links)} 处连接词（每千字 ${fixed(density, 2)}，下界 ${fixed(FRAGMENT.lowLinkPer1000, 2)}）：因果、转折、递进一处都没有`,
    ),
  ]
}

/**
 * 超长段：单段可见字超过 `longParaChars`。
 *
 * Quoted spans are counted here (a paragraph is measured as the reader sees it — a wall of
 * narration plus dialogue is still a wall), unlike the stutter rule which must ignore dialogue.
 * One finding per offending paragraph, capped.
 */
export function findLongParagraph(input: GateInput): Finding[] {
  const out: Finding[] = []
  for (const paragraph of paragraphsOf(input.chapter.body)) {
    if (out.length >= input.thresholds.maxFindingsPerRule) break
    const length = visibleLength(paragraph.text)
    if (length <= FRAGMENT.longParaChars) continue
    out.push(
      gateFinding(
        'GATE_AI_LONG_PARA',
        lineLocator(input, paragraph.line),
        `第 ${String(paragraph.line)} 行这一段 ${String(length)} 字（上限 ${String(FRAGMENT.longParaChars)} 字），中间没有换气的地方`,
      ),
    )
  }
  return out
}

/** The three 太碎 detectors, in a fixed order so the report cannot reorder. */
export function checkFragment(input: GateInput): Finding[] {
  return [...findStutter(input), ...findLowLink(input), ...findLongParagraph(input)]
}
