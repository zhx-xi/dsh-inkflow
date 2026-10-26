/**
 * The one line under the 设定库 title: how many of this page's kinds hold something, the total,
 * and **where the other kinds went**.
 *
 * WHY THIS IS NOT IN `library-model.ts`: that file is at its line budget, and this is the one
 * part of the page's wording that exists because the page shows a SUBSET of the kinds. Keeping
 * it beside the tree logic meant every tweak to the sentence borrowed a line from something
 * that decides what the page shows.
 *
 * WHY THE DESTINATION CLAUSE IS ALWAYS THERE: it used to be part of the empty state, so the
 * moment the book had one entry the page stopped saying why 大纲 / 伏笔 / 时间线 are absent from
 * its tree — which reads as "they are gone". It is derived from the kind tables, never typed out
 * a second time, so renaming or moving a kind rewrites this sentence instead of leaving it lying.
 */

import { KIND_LABELS, SETTINGS_LIBRARY_KINDS, kindLabel } from './library-model.js'
import type { LibraryTree } from './library-model.js'

/** "大纲 / 伏笔 / 时间线" — every kind the library does not render, in label form. */
export const SETTINGS_LIBRARY_HINT = `其余 ${Object.keys(KIND_LABELS)
  .filter((kind) => !(SETTINGS_LIBRARY_KINDS as readonly string[]).includes(kind))
  .map((kind) => kindLabel(kind))
  .join(' / ')} 各有页签`

/**
 * The facts line: `索引 可用 · 3/5 类有条目 · 共 11 条 · 其余 大纲 / 伏笔 / 时间线 各有页签`.
 *
 * A missing index is said in this same line rather than in a card, because it is the same
 * question ("what does this page know?"), and the tree below already explains itself.
 */
export function describeLibraryFacts(tree: LibraryTree): string {
  if (!tree.indexAvailable) return `索引 不可用 · 本页 ${String(SETTINGS_LIBRARY_KINDS.length)} 类无法回答`
  const filled = tree.groups.filter((group) => group.items.length > 0).length
  return `索引 可用 · ${String(filled)}/${String(tree.groups.length)} 类有条目 · 共 ${String(tree.total)} 条 · ${SETTINGS_LIBRARY_HINT}`
}
