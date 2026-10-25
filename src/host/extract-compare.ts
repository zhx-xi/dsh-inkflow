/**
 * Does a candidate say the same thing as the entity already at its address? (#178)
 *
 * The author's rule, in their words: when a second extraction produces an entity that
 * already exists,
 *
 *   - the content is **the same** → it is nothing new, skip it (no row to review);
 *   - the content **differs** → show it and ask "已存在，但内容不一致，是否覆盖？".
 *
 * So the comparison has to answer "same" in the way a reader would, not byte for byte:
 *
 *   - **only what the candidate actually sets is compared.** A candidate that fills in
 *     two fields says nothing about the rest, so the existing body/fields it does not
 *     mention cannot make it "different" — otherwise every re-extraction would look new.
 *   - **`id` and bookkeeping keys are ignored.** A candidate's id is minted (a character
 *     card gets a fresh uuid) and `updatedAt`/`rev`-style keys are the file's business;
 *     comparing them would report "different" for identical content.
 *   - **text is normalized** (CRLF → LF, per-line trailing spaces dropped, leading and
 *     trailing blank lines dropped) because a hand-edited card and a rendered candidate
 *     rarely agree on whitespace, and whitespace is not what the author is being asked
 *     to overwrite.
 *   - **order-insensitive lists** (`keywords`, `aliases`, `voice`, …) compare as sets:
 *     re-rendering the same trigger words in another order is not a content change.
 *
 * The answers are `identical` / `different` **plus the field names that differ**, because
 * the panel has to tell the author what they would be overwriting, and "不一致" alone
 * would be a shrug.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseMarkdown } from './frontmatter.js'

/** Keys that never decide "same content": identity and per-file bookkeeping. */
const IGNORED_KEYS = new Set(['id', 'schemaVersion', 'updatedAt', 'createdAt', 'rev', 'device_id', 'projectId'])

export interface ContentComparison {
  readonly state: 'identical' | 'different'
  /** Field names that differ, in candidate order (empty when identical). */
  readonly changedFields: readonly string[]
}

/** One document, compared against a candidate's rendered text. */
export function compareDocument(existingText: string, candidateText: string, candidateFields: Readonly<Record<string, unknown>>): ContentComparison {
  const existing = parseMarkdown(existingText)
  const candidate = parseMarkdown(candidateText)
  const changed: string[] = []

  // The candidate's own field names decide what is compared — `body` is prose, the rest
  // live in the frontmatter block.
  for (const key of Object.keys(candidateFields)) {
    if (IGNORED_KEYS.has(key)) continue
    if (key === 'body') {
      if (normalizeBody(existing.body) !== normalizeBody(candidate.body)) changed.push('body')
      continue
    }
    if (!sameValue(existing.data[key], candidate.data[key])) changed.push(key)
  }

  return { state: changed.length === 0 ? 'identical' : 'different', changedFields: changed }
}

/**
 * Read the entity at `path` and compare it with the candidate's rendered document.
 *
 * `undefined` means "nothing to compare against" — the path is free, so the candidate is
 * a plain create and the caller should not treat it as a duplicate at all.
 */
export function compareWithExisting(
  root: string,
  path: string,
  candidateText: string,
  candidateFields: Readonly<Record<string, unknown>>,
): ContentComparison | undefined {
  let existingText: string
  try {
    existingText = readFileSync(join(root, path), 'utf8')
  } catch {
    return undefined
  }
  return compareDocument(existingText, candidateText, candidateFields)
}

/** Prose, in the form a reader would compare: one EOL, no trailing spaces, no blank edges. */
function normalizeBody(text: string): string {
  return text
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/u, ''))
    .join('\n')
    .replace(/^\n+/u, '')
    .replace(/\s+$/u, '')
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === undefined && right === undefined) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    const a = Array.isArray(left) ? left.map(scalarOf) : []
    const b = Array.isArray(right) ? right.map(scalarOf) : []
    return a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000')
  }
  return scalarOf(left) === scalarOf(right)
}

/** Everything comparable as a trimmed string; `undefined`/`null` collapse to `''`. */
function scalarOf(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return JSON.stringify(value.map(scalarOf))
  return String(value).trim()
}
