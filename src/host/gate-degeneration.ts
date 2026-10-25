/**
 * Item 8 of the quality gate: degeneration detection.
 *
 * The seven quality checks judge **how well** the chapter is written. None of them notices
 * that the model wrote it *wrong*, and in a batch job that gap is expensive: a paragraph
 * repeated verbatim, a body cut off by `max_tokens`, a draft still carrying
 * 「（此处继续展开）」, or `TODO` in the prose all pass every one of them, and the author only
 * finds out by opening all twenty chapters.
 *
 * Four detectors, one pass, no model (X-26):
 *
 *   1. `GATE_DEGEN_REPEAT` — 复读：紧邻整行重复 / 整段重复 / 同句连发；
 *   2. `GATE_DEGEN_TRUNCATED` — 章末停在半句；
 *   3. `GATE_DEGEN_PLACEHOLDER` — 占位语与元话语；
 *   4. `GATE_DEGEN_META_LEAK` — 工程词泄漏。
 *
 * ## 引号外叙述判定 + 对话行豁免
 *
 * Every text detector runs on the line with its **paired quoted spans masked out**. That one
 * decision carries the whole difference between a character and a model:
 *
 *   * 「我无法答应你。」 as a line of dialogue — a character refusing. Silent.
 *   * 我无法答应你。 as narration — the model refusing, which is degeneration. Reported.
 *
 * Repetition follows the same rule for the same reason: a repeated line of dialogue is a
 * device Chinese serials use on purpose (复沓/弹幕刷屏), while a repeated *narration* line is
 * the model going round in circles. A «narration + quoted line» paragraph is therefore judged
 * on its narration only, never exempted as a whole.
 *
 * ## 出处与改写点（ADR-0027）
 *
 * 四类划分与「引号外判定 + 对话豁免」这条形态参考 `zenstory-ai/oh-story-claudecode` 的
 * `skills/story-deslop/scripts/check-degeneration.js`（MIT，15,453 字节）。判定代码按本仓
 * 形状重写，阈值与词表在 `gate-vocabulary.ts` 的 `DEGENERATION`。按 ADR-0027 D3 写明改
 * 写点：
 *
 *   * 只有四类检测，没有 `hard`/`soft` 两档与退出码（本仓的严重级是 `warning`，暂停策略
 *     在 `jobs-drafts.ts` 的 `pauseWorthy`）；
 *   * 不处理 frontmatter 与代码围栏 —— `parseMarkdown` 已经把 body 切出来，参考实现处理的是
 *     整个文件；
 *   * 引号集合去掉英文单引号（见 `DEGENERATION.quotedSpanSources` 的注释）；
 *   * 「第 N 章 / 本章」这类**章节结构词不进词表**：故事内的「翻到第三章」是合法叙述，参考
 *     实现把它降级为 advisory，这里直接不作判据 —— 误报面比收益大；
 *   * 复读多一条「整段重复（≥2 次）」判据，阈值自标（`repeatBlockMinChars`）。
 *
 * Everything here is a detection, never a rewrite: `fixable` stays false until `repair.ts`
 * learns the action (ADR-0022 D3 / ADR-0015 D2).
 */

import type { Finding } from './findings.js'
import { lineLocator, maskQuoted, paragraphsOf, stripQuoted, visibleLength } from './gate-text.js'
import { DEGENERATION, gateFinding } from './gate-vocabulary.js'
import type { DegenerationPattern, GateInput } from './gate-vocabulary.js'

// ---------------------------------------------------------------------------
// 8 退化检测
// ---------------------------------------------------------------------------

/** A finding's excerpt: short enough to read in a table, long enough to recognize. */
function excerpt(text: string): string {
  const chars = [...text]
  return chars.length <= DEGENERATION.excerptChars ? text : `${chars.slice(0, DEGENERATION.excerptChars).join('')}…`
}

function clausesOf(text: string): string[] {
  return text
    .split(/[。！？!?…]+/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause !== '')
}

// ---------------------------------------------------------------------------
// 复读
// ---------------------------------------------------------------------------

/**
 * Three shapes, because a model that loops produces all three:
 *
 *   * the same line twice in a row — the most obvious loop;
 *   * the same paragraph twice, adjacent or not — a longer loop reads exactly like a copy;
 *   * one long sentence three times — the 「打转」 case where the paragraphs look different.
 *
 * Thresholds live in `DEGENERATION`; each is a **visible-character** count so that
 * punctuation-only repetition (「……」, 「——」) and short rhetorical echoes (「一声一声」)
 * are not loops.
 */
function findRepeat(input: GateInput): Finding[] {
  const out: Finding[] = []
  const limit = input.thresholds.maxFindingsPerRule
  const paragraphs = paragraphsOf(input.chapter.body)

  // (1) 紧邻整行重复. Dialogue-only lines are exempt (the narration inside them is empty).
  for (let at = 1; at < paragraphs.length && out.length < limit; at += 1) {
    const here = paragraphs[at]
    const before = paragraphs[at - 1]
    if (here === undefined || before === undefined) continue
    if (here.text !== before.text) continue
    if (visibleLength(stripQuoted(here.text)) < DEGENERATION.repeatLineMinChars) continue
    out.push(
      gateFinding(
        'GATE_DEGEN_REPEAT',
        lineLocator(input, here.line),
        `紧邻整行重复（第 ${String(before.line)} 行与第 ${String(here.line)} 行一字不差）：「${excerpt(here.text)}」——疑似模型打转，删掉一处`,
      ),
    )
  }

  // (2) 整段重复（同一段出现 ≥2 次，相邻与否都算；行号报第二处）。
  //
  // The key is the **whole** paragraph, not its narration-only projection: two paragraphs that
  // share a long narration tail but carry different dialogue are not a copy-paste, and keying on
  // the stripped text would report them as one. The narration length still gates the rule, so a
  // repeated dialogue-heavy line stays exempt (its narration is what the threshold measures).
  const blocks = new Map<string, { count: number; first: number; second: number | undefined }>()
  for (const paragraph of paragraphs) {
    if (visibleLength(stripQuoted(paragraph.text)) < DEGENERATION.repeatBlockMinChars) continue
    const entry = blocks.get(paragraph.text)
    if (entry === undefined) {
      blocks.set(paragraph.text, { count: 1, first: paragraph.line, second: undefined })
      continue
    }
    entry.count += 1
    entry.second ??= paragraph.line
  }
  for (const [text, entry] of blocks) {
    if (out.length >= limit) break
    if (entry.second === undefined) continue
    out.push(
      gateFinding(
        'GATE_DEGEN_REPEAT',
        lineLocator(input, entry.second),
        `同一段重复 ${String(entry.count)} 次（首次在第 ${String(entry.first)} 行）：「${excerpt(text)}」——删掉重复，保留一处`,
      ),
    )
  }

  // (3) 同句连发：同一句长句出现 ≥3 次。
  const clauses = new Map<string, { count: number; line: number }>()
  for (const paragraph of paragraphs) {
    for (const clause of clausesOf(stripQuoted(paragraph.text))) {
      if (visibleLength(clause) < DEGENERATION.repeatSentenceMinChars) continue
      const entry = clauses.get(clause)
      if (entry === undefined) {
        clauses.set(clause, { count: 1, line: paragraph.line })
        continue
      }
      entry.count += 1
    }
  }
  for (const [clause, entry] of clauses) {
    if (out.length >= limit) break
    if (entry.count < DEGENERATION.repeatSentenceMinCount) continue
    out.push(
      gateFinding(
        'GATE_DEGEN_REPEAT',
        lineLocator(input, entry.line),
        `同一句出现 ${String(entry.count)} 次（首次在第 ${String(entry.line)} 行）：「${excerpt(clause)}」——保留一处，其余改写`,
      ),
    )
  }

  return out
}

// ---------------------------------------------------------------------------
// 截断
// ---------------------------------------------------------------------------

/**
 * A finished chapter ends on a terminator. This is the one rule where the *last character*
 * carries the whole judgement, so it must not judge length: 「雨停了。」 is a finished chapter
 * and 「他抬起头，看见」 is a cut-off one, at the same visible length.
 *
 * Markdown headings are skipped when looking for the last paragraph: a body may end with a
 * heading the author is about to fill, and the heading's own punctuation says nothing about
 * the prose.
 */
function findTruncated(input: GateInput): Finding[] {
  const paragraphs = paragraphsOf(input.chapter.body).filter((paragraph) => !paragraph.text.startsWith('#'))
  const last = paragraphs.at(-1)
  // An empty chapter is item 1's finding ("0 字"); reporting "truncated" as well is noise.
  if (last === undefined) return []
  if (new RegExp(DEGENERATION.truncatedTerminal, 'u').test(last.text)) return []
  const tail = [...last.text].slice(-DEGENERATION.excerptChars).join('')
  return [
    gateFinding(
      'GATE_DEGEN_TRUNCATED',
      lineLocator(input, last.line),
      `章末停在半句，正文没有以句末/收尾标点结束：「${tail}」——补完结尾或重写收尾`,
    ),
  ]
}

// ---------------------------------------------------------------------------
// 占位语与工程词
// ---------------------------------------------------------------------------

/**
 * One finding per line (the first pattern that matches wins): a line that leaks a placeholder
 * is broken, and reporting three labels for it would only bury the first one.
 *
 * The scan reads the **masked** line, so anything inside a paired quote is somebody's
 * dialogue — 「作为 AI，我会保护你」 is a line an AI *character* says in a system-流 novel, not
 * the model describing itself.
 */
function scanLines(input: GateInput, code: string, patterns: readonly DegenerationPattern[], what: string): Finding[] {
  const out: Finding[] = []
  const limit = input.thresholds.maxFindingsPerRule
  for (const paragraph of paragraphsOf(input.chapter.body)) {
    if (out.length >= limit) break
    const narration = maskQuoted(paragraph.text)
    for (const pattern of patterns) {
      const match = new RegExp(pattern.source, 'iu').exec(narration)
      if (match === null) continue
      out.push(
        gateFinding(code, lineLocator(input, paragraph.line), `${what}：${pattern.label}「${excerpt(match[0])}」——重写本段干净落地`),
      )
      break
    }
  }
  return out
}

/** The eighth check: four detectors, run in a fixed order so the report cannot reorder. */
export function checkDegeneration(input: GateInput): Finding[] {
  return [
    ...findRepeat(input),
    ...findTruncated(input),
    ...scanLines(input, 'GATE_DEGEN_PLACEHOLDER', DEGENERATION.placeholder, '占位语/元话语混入正文'),
    ...scanLines(input, 'GATE_DEGEN_META_LEAK', DEGENERATION.metaLeak, '工程词泄漏'),
  ]
}
