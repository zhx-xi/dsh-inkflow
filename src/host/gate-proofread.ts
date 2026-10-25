/**
 * Issue #44 — item 7 of the quality gate: the mechanical proofreader.
 *
 * Six classes of 「错字」, all decidable without a model (X-26):
 *
 *   1. punctuation that must come in pairs (quotes, brackets, book titles);
 *   2. half-width `, ; : ! ?` next to Han characters;
 *   3. full-width letters and digits;
 *   4. doubled words (「的的」, 「忽然忽然」);
 *   5. names one character away from a declared character name;
 *   6. one character addressed by two different spellings in one chapter;
 *   7. numbers and measures (Arabic digit + Chinese measure word, mixed numeral systems).
 *
 * Two of these carry a **stated limit** rather than a hidden one, because a checker whose
 * noise exceeds its signal gets switched off by its author within a week:
 *
 *   * near-miss names only consider names of **three or more characters** — with
 *     two-character names every common word sharing one character with a name («清风» vs
 *     「清音») would become a candidate;
 *   * doubled words are reported for **function words** and for a closed list of adverbs
 *     that cannot be reduplicated — Chinese repeats two-character groups on purpose
 *     (「一声一声」「一步一步」「很久很久」), so a general rule would fire on good prose.
 *
 * Everything here is a detection, never a rewrite: `fixable` stays false until `repair.ts`
 * learns the corresponding action (ADR-0022 D3 的修订注记, ADR-0015 D2).
 */

import type { Finding } from './findings.js'
import { chapterLocator, charLength, hanOnly, lineLocator, lineOf, occurrences, paragraphsOf } from './gate-text.js'
import { gateFinding } from './gate-vocabulary.js'
import type { GateInput, GateRosterEntry } from './gate-vocabulary.js'

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

/**
 * Item 7 — the mechanical proofreader, one pass over the chapter body.
 *
 * Exported because `gate-rules.ts` owns the seven-check table (`GATE_CHECKS`): the order of
 * the checks is one decision, and it lives beside the other six.
 */
export function checkProofread(input: GateInput): Finding[] {
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
