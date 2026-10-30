/**
 * Markdown → blocks → XHTML: the renderer all three sinks share, plus the XML escaper.
 *
 * WHY IT IS A FILE: it is the piece the sinks must agree on — a heading level or an escape
 * rule that differed per format would be a silent inconsistency between two files exported
 * from the same book.
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { writeZip } from './zip.js'
import type { ZipWriteEntry } from './zip.js'

// ---------------------------------------------------------------------------
// Markdown → the formats below (one renderer, three sinks)
// ---------------------------------------------------------------------------

/** One block of a chapter body, as every sink needs it. */
export type MarkdownBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }

/**
 * Cut a chapter body into paragraphs and ATX headings.
 *
 * Deliberately not a Markdown parser: the two shapes an export must honour are "a blank line
 * starts a new paragraph" and "a line of `#`s starts a heading". Everything else stays text,
 * which is why a table inside a chapter shows up as its own raw lines instead of vanishing.
 */
export function markdownBlocks(body: string): MarkdownBlock[] {
  const out: MarkdownBlock[] = []
  let paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length === 0) return
    out.push({ kind: 'paragraph', text: paragraph.join('\n') })
    paragraph = []
  }
  const normalized = body.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  for (const raw of normalized.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim() === '') {
      flush()
      continue
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading !== null) {
      flush()
      out.push({ kind: 'heading', level: (heading[1] ?? '').length, text: (heading[2] ?? '').trim() })
      continue
    }
    paragraph.push(line)
  }
  flush()
  return out
}

/**
 * XML-escape text for XHTML and OOXML.
 *
 * `&` first, then the four characters that would otherwise close a tag or an attribute:
 * replacing `<` after `&` cannot re-introduce a bare `&`, so the order is the whole trick.
 * A chapter that literally contains `<script>` therefore arrives as text in every reader
 * instead of as markup (ADR-0024 备选: no sanitiser, no whitelist — escape everything).
 */
export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** A block's heading level in a sink whose chapter title already sits at `chapterLevel`. */
export function below(chapterLevel: number, blockLevel: number): number {
  return Math.min(chapterLevel + blockLevel, 6)
}

export function blocksToXhtml(blocks: MarkdownBlock[]): string {
  const lines: string[] = []
  for (const block of blocks) {
    if (block.kind === 'heading') {
      const level = String(below(1, block.level))
      lines.push(`<h${level}>${escapeXml(block.text)}</h${level}>`)
      continue
    }
    // A newline inside a paragraph is a soft break in Markdown: one space, not a `<br/>`.
    lines.push(`<p>${escapeXml(block.text).replaceAll('\n', ' ')}</p>`)
  }
  return lines.join('\n')
}
