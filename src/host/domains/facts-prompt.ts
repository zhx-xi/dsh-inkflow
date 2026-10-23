/**
 * The ledger's writing-context segment (issue #32, roadmap X-13).
 *
 * What it adds: the facts **in effect at the chapter being written**, one line each. This is
 * the segment that stops a model from giving a character a realm they lost twenty chapters
 * ago — the ledger already knows the interval, and the prompt had no way to see it.
 *
 * Why it is registered instead of rendered: `writing-context.ts` assembles segments from
 * `EXTRA_SEGMENTS` so two domains (facts #32, foreshadow #31) never edit the same renderer.
 * A contributor supplies its own text and cap and says nothing about order — the array's
 * order is the segment order, and X-13 fixes it as `… → world → facts → foreshadow`.
 *
 * Why it reads the **derived index** and not `facts/`: "in effect at chapter N" needs the
 * chapter order (`chapters.seq`), which only the index holds; parsing the ledgers here would
 * answer half the question. The cost is stated rather than hidden: this path does not run
 * `ensureIndex()` — the prompt build must never trigger a rebuild — so a fact edited on disk
 * but not yet re-indexed shows up after the next rebuild instead of immediately. Every tool
 * that reads the ledger does ensure the index, so the gap only exists for hand edits.
 *
 * Degradation: no chapter, no index, no order, no facts → `undefined`, which renders no
 * segment at all (an empty heading would cost budget and say nothing).
 *
 * ## Why the body is packed line by line (rework of PR #124)
 *
 * A count cap and a character cap are not interchangeable, and the first version applied
 * both as if they were: it took twelve facts, joined them, and let the seam clip the result
 * to 15% of the budget. At the default 1200-token budget that is 180 characters — four
 * lines — so the header announced "展开前 12 条" over a block of four, the fifth line was cut
 * in the middle of a value, and at a 120-token budget the whole segment degenerated to
 * `### 账本事实（截至第 …` and never reached the trim ladder (the block was already within
 * budget). Both answers are worse than no segment: a model reading a half line takes it as
 * a value.
 *
 * So the body is now assembled from **whole lines only**, in the one stable order the
 * snapshot promises, until `capChars` (`ExtraSegmentInput`) is reached; the header counts
 * what was actually rendered rather than how many facts exist; and if `header + 1 line`
 * does not fit, the segment is not produced at all (an empty heading says nothing a model
 * can use, and the remaining budget is better spent on the tail).
 */

import type { ExtraSegmentSpec } from '../writing-context.js'
import { factsSnapshot } from './facts-plan.js'
import { chapterIndex, readFactsRows, seqOfChapters } from './facts-query.js'

/**
 * How many facts the segment carries, at most.
 *
 * Twelve is a readability bound, not the budget (the budget is `capChars`): a list longer
 * than this is describing a chapter the model should ask `inkflow_facts_snapshot` about
 * instead of being handed everything. The header reports the number **rendered**, so the two
 * caps can never disagree in the text.
 */
export const MAX_SEGMENT_FACTS = 12

export const factsSegment: ExtraSegmentSpec = {
  name: 'facts',
  label: '账本事实',
  // Roadmap X-13: `facts` may occupy at most 15% of the block's token budget.
  capRatio: 0.15,
  build({ root, current, capChars }): string | undefined {
    if (current === undefined) return undefined

    const chapters = chapterIndex(root)
    if (chapters === undefined || chapters.placed === 0) return undefined
    const rows = readFactsRows(root)
    if (rows === undefined || rows.length === 0) return undefined

    // The chapter being written, by position. `ChapterHead` carries the file path and `seq`;
    // the ledger names chapter **ids**, so the path is joined to the id the index holds and
    // `seq` from the head is the fallback when the index has not seen that file yet.
    const head = chapters.byPath.get(current.path)
    const atSeq = (head === undefined ? undefined : chapters.byId.get(head.id)) ?? current.seq
    if (atSeq === undefined) return undefined

    const facts = factsSnapshot(rows, seqOfChapters(chapters), atSeq)
    if (facts.length === 0) return undefined

    const total = facts.length
    const lines = facts.slice(0, Math.min(total, MAX_SEGMENT_FACTS)).map((fact) => {
      const since = fact.since === undefined ? '' : `（自 ${fact.since}）`
      return `- ${fact.subject} · ${fact.attribute}：${fact.value}${since}`
    })

    // Two header forms: the truncated one carries the count it rendered, and is therefore
    // longer, so it is used as soon as one line has to be left out.
    const header = (shown: number): string =>
      shown < total
        ? `### 账本事实（截至第 ${String(atSeq)} 章 · 共 ${String(total)} 条，展开前 ${String(shown)} 条）`
        : `### 账本事实（截至第 ${String(atSeq)} 章 · ${String(total)} 条）`

    let best: string | undefined
    for (let shown = 1; shown <= lines.length; shown += 1) {
      const candidate = [header(shown), ...lines.slice(0, shown)].join('\n')
      if (candidate.length > capChars) break
      best = candidate
    }
    // `header + 1 line` does not fit: say nothing rather than emit a heading that promises
    // content it does not have (and that the budget ladder cannot trim, because the block is
    // already short).
    return best
  },
}
