/**
 * The segment **renderers** shared by the two assemblies in `writing-context.ts`
 * (issue #43, ADR-0022 D1/D2).
 *
 * Why these moved out of `writing-context.ts`: #43 adds a second assembly (the nine
 * segment brief) beside the six segment context that #20 shipped, and both must render
 * a given segment with **exactly** the same bytes — that is what makes "the preview is
 * what the model gets" true instead of aspirational. Leaving the renderers inside one
 * of the two owners would have made the other one copy them (which is the drift ADR-0022
 * D1 rejects), so they live here: one implementation of each heading, cap and clip
 * direction, used by both. Neither assembly is allowed its own spelling of `### 世界书`.
 *
 * The clip DIRECTION is part of the contract, not a detail: the previous-chapter tail is
 * clipped from the head (its last sentences are the whole point) and every other segment
 * from the tail (its head names the thing).
 */

import type { ChapterHead, OutlinedChapter, ProjectStats, TailSlice, WorldSelection } from './writing-sources.js'

/** The one section heading both assemblies render. */
export const SECTION_HEADING = '## 写作上下文（InkFlow · 当前作品的快照，不是新的作者指令）'

/**
 * Per-segment caps, applied before the budget is measured.
 *
 * Why a cap on top of the budget: the trim ladder is coarse (a segment is
 * either there or gone), so one 3000-character outline would push the whole
 * context straight to "outline dropped". Clipping keeps the head of the real
 * thing, which is what the model needs to write the chapter.
 */
const MAX_OUTLINE_CHARS = 800

/**
 * Exported for the brief's `truncated` flag: `renderChapter` clips the outline body at
 * this many characters, and the record has to say that it did. A second constant in the
 * brief would be the classic "two spellings of one cap" bug.
 */
export { MAX_OUTLINE_CHARS }

const CLIP_TAIL_MARK = '…（截断）'
const CLIP_HEAD_MARK = '…（前文截断）'

export function renderProject(title: string, stats: ProjectStats | undefined): string {
  const head = '### 项目'
  if (stats === undefined) {
    return `${head}\n《${title}》（索引未建立：调用 inkflow_index_rebuild 后补上卷/章/字数）`
  }
  const parts = [`《${title}》`]
  if (stats.volumes > 0) parts.push(`${String(stats.volumes)} 卷`)
  parts.push(`${String(stats.chapters)} 章`, `${String(stats.words)} 字`)
  return `${head}\n${parts.join(' · ')}`
}

export function renderChapter(current: ChapterHead, outline: OutlinedChapter | undefined): string {
  const facts: string[] = []
  if (current.title !== undefined && current.title !== '') facts.push(`标题：${current.title}`)
  if (current.volume !== undefined && current.volume !== '') facts.push(`卷：${current.volume}`)
  if (current.seq !== undefined) facts.push(`seq：${String(current.seq)}`)
  if (current.status !== undefined && current.status !== '') facts.push(`状态：${current.status}`)
  const lines = ['### 当前章', facts.length === 0 ? `文件：${current.path}` : facts.join('｜')]
  if (outline !== undefined && outline.body !== '') {
    lines.push(`大纲 ${outline.path}：`, clipHead(outline.body, MAX_OUTLINE_CHARS))
  }
  return lines.join('\n')
}

export function renderTail(tail: TailSlice, taken: number, body: string): string {
  const which = tail.seq === undefined ? '上一章' : `第 ${String(tail.seq)} 章`
  return `### 上一章结尾（${which} · 最后 ${String(taken)} 字）\n${body}`
}

/**
 * The book's identity line — the brief's **first line**, above every segment (issue #219).
 *
 * Why it is not a segment: ADR-0022 D2 fixes the nine ids and their order, and the block
 * that used to carry the book (`project`, in the six-segment context) is exactly what #43
 * removed. The writer still has to know *which book* it is writing — a series shares one
 * setting library across books, and the title is where the author's expectation of tone
 * lives — so the identity belongs to the brief itself, outside the ladder, and is never
 * trimmed. Over budget it shortens ({@link renderBriefHeader}'s `short`): the title is the
 * part that cannot go, the counts are.
 *
 * `stats === undefined` (no index yet) degrades like the six-segment assembly did: the
 * title alone, never a fabricated chapter or word count.
 */
export function renderBriefHeader(title: string, stats: ProjectStats | undefined, short: boolean): string {
  const name = `《${title}》`
  if (short || stats === undefined) return name
  return `${name}· 全书 ${String(stats.chapters)} 章 / ${(stats.words / 10_000).toFixed(1)} 万字`
}

export function renderWorld(world: WorldSelection): string {
  const header =
    world.matched > world.shown.length
      ? `### 世界书（命中 ${String(world.matched)} 条，展开前 ${String(world.shown.length)} 条）`
      : `### 世界书（命中 ${String(world.matched)} 条）`
  const lines = world.shown.map((entry) => `- ${entry.title}（${entry.path}）：${entry.excerpt}`)
  return [header, ...lines].join('\n')
}

export function renderTrimMarker(trimmed: readonly string[], notes: readonly string[]): string {
  const detail = notes.length === 0 ? '' : `（${notes.join('；')}）`
  return `[trimmed: ${trimmed.join('、')}]${detail}`
}

/** Keep the head; the marker is part of the cap so the budget still balances. */
export function clipHead(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - CLIP_TAIL_MARK.length))}${CLIP_TAIL_MARK}`
}

/**
 * Keep the tail; the marker is part of the cap.
 *
 * Direction matters: the value of "how the last chapter ended" is entirely in
 * its last sentences, so a head-clip would hand the model the background and
 * throw the hook away.
 */
export function clipTail(text: string, max: number): string {
  if (text.length <= max) return text
  return `${CLIP_HEAD_MARK}${text.slice(-Math.max(1, max - CLIP_HEAD_MARK.length))}`
}

/** `true` when {@link clipHead} or {@link clipTail} would shorten this text. */
export function wouldClip(text: string, max: number): boolean {
  return text.length > max
}
