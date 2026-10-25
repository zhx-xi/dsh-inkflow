/**
 * 作者口径的字面豁免（[ADR-0028](../../.agents/adrs/0028-gate-calibration-per-book.md) D3–D5）。
 *
 * 一句话：**「这句话是我故意这么写的」是可以声明的，但声明不能变成关门禁**。所以这个模块
 * 只做三件事，每件都带着自己的边界：
 *
 *   * **解析**（`parseWhitelist`）：一行一条片段，`#` 注释、空行忽略，BOM/CRLF 容忍；超过
 *     长度或条数上限就**返回错误**，不静默丢条目——静默丢等于作者以为豁免了、实际没有。
 *   * **比对**（`fold`）：两侧都做 NFKC + 小写折叠，全半角与大小写不再是两件事；片段是
 *     **字面**的，不做正则、不做通配——一条 `.*` 就是「关掉全部门禁」。
 *   * **生效**（`waiveFindings`）：只在 finding **自己那一行**上判，且只对 `WAIVABLE_CODES`
 *     这一闭集生效。命中即从结果里**移除**（不降级为 info：那只是把同一句话换个音量），
 *     并把「豁免了什么」写进 `GateWaiverHit`，供结论文件、工具回执与面板显示。
 *
 * 为什么是行级而不是章节级：`GATE_AI_PUNCT` 那种密度判据本来就是整章的判断（作者的意图由
 * `inkflow.json` 的 `gate` 段表达，见 ADR-0028 D1），而能被一句「固定台词」说服的只有句级
 * 判定。行级还有一个副作用是好的：同一行的其它码（错字、与设定库矛盾）照报。
 */

import type { Finding } from './findings.js'

/** 白名单里的一条：`line` 是文件里的 1-based 行号（注释与空行也计入）。 */
export interface GateWaiverEntry {
  readonly line: number
  readonly text: string
}

/**
 * 防橡皮的两个上限（ADR-0028 D5）。
 *
 * 它们**不进** `GateThresholds`，也不进 `inkflow.json`：能被书调高的上限就不是上限——把整章
 * 贴进白名单只需要把上限调大。"40 × 30" 同时给文件大小兜了顶，所以不再单独设字节上限。
 */
export const GATE_WAIVER_LIMITS = { maxChars: 40, maxEntries: 30 } as const

/**
 * 可豁免的码：**闭集**，其它一律不可豁免（ADR-0028 D4 的表）。
 *
 * 入选的两条判据，缺一不可：①判定是**句级**的（定位能落到 `path#L<n>`，否则没有可以挂片段的
 * 「那一行」——`GATE_PROOF_APPELLATION_MIXED` 与 `GATE_AI_PARALLEL` 因此进不来）；②命题是
 * **口径**而不是**事实**（错字、角色名写错、与账本矛盾、平台会拒、模型写坏了，都不是「作者
 * 故意的」）。
 */
export const WAIVABLE_CODES: readonly string[] = [
  'GATE_AI_NARRATION',
  'GATE_AI_TEMPLATE',
  'GATE_SENSITIVE_WORD',
  'GATE_PROOF_HALF_PUNCT',
  'GATE_PROOF_FULLWIDTH_ALNUM',
  'GATE_PROOF_ARABIC_MEASURE',
  'GATE_PROOF_NUMBER_MIXED',
]

const WAIVABLE = new Set(WAIVABLE_CODES)

/** 比对用的折叠：全角→半角、大小写归一。只抹平书写形式，不改任何字的身份。 */
export function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase()
}

export interface ParsedWhitelist {
  readonly entries: readonly GateWaiverEntry[]
  /** 越界时给出人话：哪个文件、第几行、上限多少。`entries` 仍是解析到这里为止的结果。 */
  readonly error?: { readonly code: 'GATE_WHITELIST_INVALID'; readonly message: string }
}

/**
 * Parse the waiver file. Comments and blank lines cost a line number but no entry, and a
 * duplicate fragment (after `fold`) is kept once: the author repeating a sentence is not an
 * error worth failing a gate over.
 */
export function parseWhitelist(text: string, relativePath: string): ParsedWhitelist {
  const entries: GateWaiverEntry[] = []
  const seen = new Set<string>()
  const lines = text.replace(/^\uFEFF/u, '').split(/\r?\n/u)
  for (const [index, raw] of lines.entries()) {
    const line = index + 1
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const chars = [...trimmed].length
    if (chars > GATE_WAIVER_LIMITS.maxChars) {
      return {
        entries,
        error: {
          code: 'GATE_WHITELIST_INVALID',
          message:
            `${relativePath} line ${String(line)}: the fragment is ${String(chars)} characters; at most ` +
            `${String(GATE_WAIVER_LIMITS.maxChars)} are allowed. Point at the shortest literal that has to ` +
            'appear on that line, not at the sentence around it.',
        },
      }
    }
    const key = fold(trimmed)
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({ line, text: trimmed })
    if (entries.length > GATE_WAIVER_LIMITS.maxEntries) {
      return {
        entries,
        error: {
          code: 'GATE_WHITELIST_INVALID',
          message:
            `${relativePath} has ${String(entries.length)} entries; at most ` +
            `${String(GATE_WAIVER_LIMITS.maxEntries)} are allowed. A list that covers a chapter is the gate ` +
            'switched off: fix the prose, or state the calibration in inkflow.json.',
        },
      }
    }
  }
  return { entries }
}

/** One finding that a waiver removed: what, where, which fragment, and where the fragment lives. */
export interface GateWaiverHit {
  readonly code: string
  /** `path#L<n>` — the same address shape the finding carried. */
  readonly locator: string
  readonly fragment: string
  /** 1-based line in the whitelist file, so the author can jump straight back to it. */
  readonly whitelistLine: number
}

/** What the report says about waivers: how many exist, and which ones actually applied. */
export interface GateWaivers {
  readonly configured: number
  readonly applied: readonly GateWaiverHit[]
}

/** The findings that survive: every non-waivable code, and every waivable one with no fragment on its line. */
export function waiveFindings(
  findings: readonly Finding[],
  chapterPath: string,
  body: string,
  entries: readonly GateWaiverEntry[],
  applied: GateWaiverHit[],
): Finding[] {
  if (entries.length === 0) return [...findings]
  const lines = body.split('\n')
  const needles = entries.map((entry) => ({ entry, needle: fold(entry.text) }))
  const kept: Finding[] = []
  for (const finding of findings) {
    if (!WAIVABLE.has(finding.code)) {
      kept.push(finding)
      continue
    }
    const locator = finding.locator
    // Only a finding addressed at one line of *this* chapter can be waived by a literal: a
    // chapter-wide finding (`chapter:<id>`) has no line to test, and D4 keeps those out of the
    // waivable set anyway — this guard is what makes that structural rather than a promise.
    if (locator.kind !== 'path' || locator.line === undefined || locator.path !== chapterPath) {
      kept.push(finding)
      continue
    }
    const haystack = fold(lines[locator.line - 1] ?? '')
    const hit = needles.find((candidate) => haystack.includes(candidate.needle))
    if (hit === undefined) {
      kept.push(finding)
      continue
    }
    applied.push({
      code: finding.code,
      locator: `${locator.path}#L${String(locator.line)}`,
      fragment: hit.entry.text,
      whitelistLine: hit.entry.line,
    })
  }
  return kept
}
