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
 */

import type { ExtraSegmentSpec } from '../writing-context.js'
import { factsSnapshot } from './facts-plan.js'
import { chapterIndex, readFactsRows, seqOfChapters } from './facts-query.js'

/**
 * How many facts the segment carries.
 *
 * Twelve is the point where the segment still fits its 15% share of the default budget: one
 * line per fact, and a book whose ledger is longer than this is describing a chapter that the
 * model should query with `inkflow_facts_snapshot` instead of being handed everything.
 */
export const MAX_SEGMENT_FACTS = 12

export const factsSegment: ExtraSegmentSpec = {
  name: 'facts',
  label: '账本事实',
  // Roadmap X-13: `facts` may occupy at most 15% of the block's token budget.
  capRatio: 0.15,
  build({ root, current }): string | undefined {
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

    const shown = facts.slice(0, MAX_SEGMENT_FACTS)
    const header =
      facts.length > shown.length
        ? `### 账本事实（截至第 ${String(atSeq)} 章 · 共 ${String(facts.length)} 条，展开前 ${String(shown.length)} 条）`
        : `### 账本事实（截至第 ${String(atSeq)} 章 · ${String(facts.length)} 条）`
    const lines = shown.map((fact) => {
      const since = fact.since === undefined ? '' : `（自 ${fact.since}）`
      return `- ${fact.subject} · ${fact.attribute}：${fact.value}${since}`
    })
    return [header, ...lines].join('\n')
  },
}
