/**
 * Markdown / TXT: one file for a scope, one file per volume for a status filter.
 *
 * WHY IT IS A FILE: the plain-text sinks share `chapterTextLines` and nothing else, and the
 * per-volume grouping rule is the only reason they return a list of entries at all. The two
 * entry points are exported because the write path in `export.ts` chooses between them.
 */

import { join } from 'node:path'
import type { ZipWriteEntry } from './zip.js'
import type { ExportChapter, ExportPlan } from './export-types.js'
import { markdownBlocks } from './export-render.js'

// ---------------------------------------------------------------------------
// Markdown / TXT: one file for a scope, one file per volume for a status filter
// ---------------------------------------------------------------------------

type TextFormat = 'markdown' | 'txt'

/**
 * The same blocks, flattened to prose.
 *
 * This is what makes a `.txt` export text rather than Markdown with the `#` left in: the ATX
 * marker is a rendering instruction, so it is dropped and the heading is kept as its line.
 */
function textBlocks(body: string): string[] {
  return markdownBlocks(body).map((block) => block.text)
}

function chapterTextLines(chapter: ExportChapter, format: TextFormat): string[] {
  const lines: string[] = []
  lines.push(format === 'markdown' ? `### ${chapter.title}` : chapter.title)
  lines.push('')
  if (format === 'markdown') {
    lines.push(chapter.body.replace(/^\n+/, '').replace(/\s+$/, ''))
  } else {
    lines.push(...textBlocks(chapter.body).map((block) => block.replace(/\n/g, ' ')))
  }
  lines.push('')
  return lines.filter((line, index, all) => !(line === '' && all[index - 1] === ''))
}

/**
 * The whole selection as one document: title, `##` per volume, `###` per chapter.
 *
 * One file is the right shape for a scope question ("give me book one"), which is why only
 * a status filter (a cross-volume slice) becomes a package instead.
 */
export function singleFileText(plan: ExportPlan, format: TextFormat): string {
  const lines: string[] = []
  lines.push(format === 'markdown' ? `# ${plan.title}` : plan.title)
  if (format === 'markdown' && plan.author !== '') lines.push('', `作者：${plan.author}`)
  lines.push('')
  for (const group of plan.groups) {
    lines.push(format === 'markdown' ? `## ${group.title}` : group.title)
    lines.push('')
    for (const chapter of group.chapters) lines.push(...chapterTextLines(chapter, format))
  }
  for (const chapter of plan.loose) lines.push(...chapterTextLines(chapter, format))
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}

/**
 * The status filter as a package: one entry per volume, plus `loose.<ext>` for chapters that
 * belong to none. Zero-chapter volumes are already gone (`buildPlan`), so no entry is empty.
 */
export function groupedText(plan: ExportPlan, format: TextFormat): ZipWriteEntry[] {
  const ext = format === 'markdown' ? '.md' : '.txt'
  const entries: ZipWriteEntry[] = []
  for (const group of plan.groups) {
    const lines: string[] = [format === 'markdown' ? `# ${group.title}` : group.title, '']
    for (const chapter of group.chapters) lines.push(...chapterTextLines(chapter, format))
    entries.push({ path: `${group.volumeId}${ext}`, bytes: `${lines.join('\n').replace(/\n+$/, '')}\n` })
  }
  if (plan.loose.length > 0) {
    const lines: string[] = [format === 'markdown' ? '# 散章' : '散章', '']
    for (const chapter of plan.loose) lines.push(...chapterTextLines(chapter, format))
    entries.push({ path: `loose${ext}`, bytes: `${lines.join('\n').replace(/\n+$/, '')}\n` })
  }
  return entries
}
