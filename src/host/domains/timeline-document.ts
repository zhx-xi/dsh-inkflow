/**
 * The timeline event document (`timeline/<slug>.md`), as a pure text transform (#28).
 *
 * Why this is not inside `timeline-plan.ts`: that file holds the rules (world time,
 * the three conflicts, the two axes) and this one holds the **file shape** — what an
 * event looks like on disk. Splitting them keeps each readable, and it mirrors the
 * project's existing split between a model and its writer (`outline-model.ts` /
 * `outline-write.ts`). Nothing here touches the disk.
 */

import { frontmatterLine, patchFrontmatter, splitFrontmatter } from '../frontmatter.js'
import type { TimelineStatus } from './timeline-plan.js'

export interface TimelineDocumentFields {
  readonly id: string
  readonly title: string
  readonly worldTime?: string
  /**
   * The era `worldTime` is written in (data-model §3.4, #48). Written only when the
   * caller states one: a single-era book never grows the key, and the reader's default
   * (the calendar's last era) stays the file's default too.
   */
  readonly era?: string
  readonly narrativeOrder?: number
  readonly chapter?: string
  readonly participants?: readonly string[]
  readonly status: TimelineStatus
}

/**
 * The document a write should produce.
 *
 * A new file is rendered from the fields above. An existing file is **patched**: the
 * scalar keys go through `patchFrontmatter`, so comments, quote style and any key this
 * domain does not model survive an edit (data-model §3.1). `participants` needs its own
 * line rewrite — `patchFrontmatter` quotes a value that starts with `[`, which would
 * read back as one string instead of an id list.
 */
export function renderTimelineDocument(input: {
  readonly text?: string
  readonly fields: TimelineDocumentFields
  readonly body?: string
}): string {
  const normalized = input.text === undefined ? undefined : normalizeText(input.text)
  const body = input.body === undefined ? undefined : trimBody(input.body)

  if (normalized === undefined || !splitFrontmatter(normalized).hasFrontmatter) {
    return freshDocument(input.fields, body ?? '')
  }

  const entries: Record<string, string> = {
    id: input.fields.id,
    title: input.fields.title,
    status: input.fields.status,
  }
  if (input.fields.worldTime !== undefined) entries['worldTime'] = input.fields.worldTime
  if (input.fields.era !== undefined) entries['era'] = input.fields.era
  if (input.fields.narrativeOrder !== undefined) entries['narrativeOrder'] = String(input.fields.narrativeOrder)
  if (input.fields.chapter !== undefined) entries['chapterId'] = input.fields.chapter

  let out = patchFrontmatter(normalized, entries).text
  if (input.fields.participants !== undefined) out = patchInlineArray(out, 'participants', input.fields.participants)
  if (body !== undefined) out = `${splitFrontmatter(out).head}${body === '' ? '' : `${body}\n`}`
  return out
}

function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n')
}

function trimBody(body: string): string {
  return body.replace(/^\n+/u, '').replace(/\s+$/u, '')
}

function freshDocument(fields: TimelineDocumentFields, body: string): string {
  const lines = ['---', frontmatterLine('id', fields.id), frontmatterLine('title', fields.title)]
  if (fields.worldTime !== undefined) lines.push(frontmatterLine('worldTime', fields.worldTime))
  if (fields.era !== undefined) lines.push(frontmatterLine('era', fields.era))
  if (fields.narrativeOrder !== undefined) lines.push(frontmatterLine('narrativeOrder', String(fields.narrativeOrder)))
  if (fields.chapter !== undefined) lines.push(frontmatterLine('chapterId', fields.chapter))
  if (fields.participants !== undefined) lines.push(`participants: [${fields.participants.join(', ')}]`)
  lines.push(frontmatterLine('status', fields.status), '---', '')
  return `${lines.join('\n')}\n${body === '' ? '' : `${body}\n`}`
}

/**
 * Rewrite one array key as an inline list, keeping every other line of the block
 * untouched. The key's own line and any block-list items under it are replaced; the
 * new line is inserted where the old one was (or before the closing `---`).
 *
 * Callers must have rejected values that cannot round-trip (`planTimelineUpsert`'s
 * `PARTICIPANT_INVALID`), because none of `[`, `]`, `,` can be escaped here.
 */
function patchInlineArray(text: string, key: string, values: readonly string[]): string {
  const parts = splitFrontmatter(normalizeText(text))
  if (!parts.hasFrontmatter) return text

  const lines = parts.head.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  // lines = ['---', ...block, '---']
  const closeIndex = lines.length - 1
  const rendered = `${key}: [${values.join(', ')}]`
  const pattern = new RegExp(`^${key}:`, 'u')

  const kept: string[] = []
  let inserted = false
  for (let index = 0; index < closeIndex; index += 1) {
    const line = lines[index] ?? ''
    if (pattern.test(line)) {
      if (!inserted) {
        kept.push(rendered)
        inserted = true
      }
      // Swallow the block-list items that belong to the key being replaced.
      while (index + 1 < closeIndex && /^\s*-\s/u.test(lines[index + 1] ?? '')) index += 1
      continue
    }
    kept.push(line)
  }
  if (!inserted) kept.push(rendered)

  kept.push('---')
  return `${kept.join('\n')}\n${parts.body}`
}
