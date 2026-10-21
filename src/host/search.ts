/**
 * Chapter full-text search over the derived index (issue #22, ADR-0005).
 *
 * The index already carries `chapters_fts` built with `tokenize='trigram'`
 * (`indexer.ts`), and trigram matching has a hard floor: a query shorter than
 * three characters produces **zero rows without an error** (measured on
 * Windows, Node 24.16 / SQLite 3.53.0: `MATCH '"云海"'` → 0, `MATCH '"云海翻"'`
 * → 1). A search tool that only spoke FTS5 would therefore answer "no such
 * chapter" to every two-character Chinese word — the most common query there
 * is. Short queries are answered by a `LIKE` scan over the same table instead.
 *
 * Design rules for this file:
 *   - **Read-only.** Search never builds, repairs or deletes an index; a query
 *     must not write to the author's project. `INDEX_UNAVAILABLE` tells the
 *     caller to rebuild, and the tool layer decides to do so exactly once
 *     (issue #4's lazy rebuild).
 *   - **No query reaches the FTS parser as syntax.** Every term is wrapped in a
 *     double-quoted FTS5 phrase (with `"` doubled), so `-`, `*`, `NEAR(`, `OR`
 *     and friends are literal text, never operators. The LIKE branch escapes
 *     `%`, `_` and the escape character itself.
 *   - **A snippet is body prose only.** The index stores `parsed.body`, which
 *     already excludes the frontmatter block, so metadata (ids, notes, status)
 *     can never leak into what the model reads back.
 */

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { INDEX_SCHEMA_VERSION } from './conventions.js'
import { indexPaths } from './indexer.js'

/** How the hits were found — part of the answer, because it explains the ranking. */
export type SearchMode = 'fts' | 'like'

export interface ChapterSearchHit {
  chapterId: string
  /** Chapter file path relative to the project root (`chapters/vol-01/0001-a.md`). */
  file: string
  title: string
  seq?: number
  /** Body prose around the first hit, whitespace-collapsed, never frontmatter. */
  snippet: string
}

export interface ChapterSearchSuccess {
  ok: true
  items: ChapterSearchHit[]
  /** Every match, not the page size. */
  total: number
  mode: SearchMode
}

export type ChapterSearchErrorCode = 'INDEX_UNAVAILABLE' | 'QUERY_INVALID'

export interface ChapterSearchFailure {
  ok: false
  code: ChapterSearchErrorCode
  message: string
  hint?: string
}

export type ChapterSearchResult = ChapterSearchSuccess | ChapterSearchFailure

export interface ChapterSearchOptions {
  /** Maximum hits (default 20, capped at 100). */
  limit?: number
  /**
   * Characters kept before and after the hit (default 40; 0 → empty snippet).
   *
   * Named `snippet` because that is the field it controls; the snippet itself
   * is always part of a hit.
   */
  snippet?: number
}

export const DEFAULT_SEARCH_LIMIT = 20
export const MAX_SEARCH_LIMIT = 100
export const DEFAULT_SNIPPET_RADIUS = 40
/** A query longer than this is a caller bug (a whole paragraph), not a search. */
export const MAX_QUERY_CHARS = 200

function unavailable(message: string): ChapterSearchFailure {
  return {
    ok: false,
    code: 'INDEX_UNAVAILABLE',
    message,
    hint: 'the derived index is only a cache: rebuild it with inkflow_index_rebuild (or any read tool that rebuilds lazily) and search again. Search itself never writes.',
  }
}

function invalid(message: string): ChapterSearchFailure {
  return {
    ok: false,
    code: 'QUERY_INVALID',
    message,
    hint: `pass the words to look for (1–${MAX_QUERY_CHARS} characters). A 1–2 character query is answered by a LIKE scan; 3+ characters use the trigram index.`,
  }
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), min), max)
}

/** Split on whitespace; the caller has already collapsed runs into single spaces. */
function termsOf(query: string): string[] {
  return query.split(' ').filter((term) => term !== '')
}

/**
 * One FTS5 phrase per term, joined with AND.
 *
 * Quoting is what makes `-`, `*`, `"` and `NEAR(...)` literal: FTS5 only parses
 * operators outside a phrase, and a literal `"` inside one is written `""`.
 */
function ftsMatchExpression(terms: readonly string[]): string {
  return terms.map((term) => `"${term.replace(/"/gu, '""')}"`).join(' AND ')
}

/** Escape LIKE metacharacters so a query searches for them instead of acting as them. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** Earliest occurrence of any term (case-insensitive, index-preserving). */
function locate(body: string, terms: readonly string[]): { at: number; length: number } | undefined {
  let best: { at: number; length: number } | undefined
  for (const term of terms) {
    if (term === '') continue
    const match = new RegExp(escapeRegExp(term), 'iu').exec(body)
    if (match === null) continue
    if (best === undefined || match.index < best.at) best = { at: match.index, length: match[0].length }
  }
  return best
}

/**
 * `radius` characters either side of the hit, with `…` marking a truncated edge.
 *
 * Sliced here instead of using FTS5's `snippet()`: under the trigram tokenizer a
 * "token" is a three-character gram, so `snippet(..., 40)` means 40 grams (≈42
 * characters), not 40 characters either side. One implementation for both
 * branches also keeps FTS and LIKE snippets identical.
 *
 * Whitespace is collapsed for display: the body starts with the blank line that
 * followed the frontmatter, and a snippet full of newlines reads badly in a
 * tool result.
 */
function makeSnippet(body: string, terms: readonly string[], radius: number): string {
  if (body === '' || radius <= 0) return ''
  const hit = locate(body, terms)
  const start = hit === undefined ? 0 : Math.max(0, hit.at - radius)
  const end = hit === undefined ? Math.min(body.length, radius * 2) : Math.min(body.length, hit.at + hit.length + radius)
  const head = start > 0 ? '…' : ''
  const tail = end < body.length ? '…' : ''
  return `${head}${body.slice(start, end).replace(/\s+/gu, ' ').trim()}${tail}`
}

/** Chapter metadata for the hit rows, in the order the query returned them. */
function hydrate(
  db: DatabaseSync,
  rows: readonly Record<string, unknown>[],
  terms: readonly string[],
  radius: number,
): ChapterSearchHit[] {
  if (rows.length === 0) return []
  const meta = db.prepare('SELECT id, path, seq, title FROM chapters WHERE id = ?')
  const items: ChapterSearchHit[] = []
  for (const row of rows) {
    const chapterId = String(row['chapter_id'])
    const info = meta.get(chapterId) as Record<string, unknown> | undefined
    if (info === undefined) continue
    const hit: ChapterSearchHit = {
      chapterId,
      file: String(info['path']),
      title: String(info['title']),
      snippet: makeSnippet(typeof row['body'] === 'string' ? row['body'] : '', terms, radius),
    }
    if (typeof info['seq'] === 'number') hit.seq = info['seq']
    items.push(hit)
  }
  return items
}

/** Ranked by the FTS5 `rank` column (bm25: lower is better). */
function searchFts(db: DatabaseSync, terms: readonly string[], limit: number, radius: number): ChapterSearchSuccess {
  const match = ftsMatchExpression(terms)
  const counted = db.prepare('SELECT COUNT(*) AS n FROM chapters_fts WHERE chapters_fts MATCH ?').get(match) as
    | { n?: number }
    | undefined
  const rows = db
    .prepare('SELECT chapter_id, body FROM chapters_fts WHERE chapters_fts MATCH ? ORDER BY rank LIMIT ?')
    .all(match, limit) as unknown as Array<Record<string, unknown>>
  return {
    ok: true,
    items: hydrate(db, rows, terms, radius),
    total: typeof counted?.n === 'number' ? counted.n : 0,
    mode: 'fts',
  }
}

/** Ordered by `seq` then file: a short query has no rank, so reading order is the answer. */
function searchLike(db: DatabaseSync, terms: readonly string[], limit: number, radius: number): ChapterSearchSuccess {
  // Terms never reach the SQL text: one placeholder per term, values bound.
  const where = terms.map(() => "chapters_fts.body LIKE ? ESCAPE '\\'").join(' AND ')
  const params = terms.map(likePattern)
  const counted = db
    .prepare(
      `SELECT COUNT(*) AS n FROM chapters_fts JOIN chapters ON chapters.id = chapters_fts.chapter_id WHERE ${where}`,
    )
    .get(...params) as { n?: number } | undefined
  const rows = db
    .prepare(
      `SELECT chapters_fts.chapter_id AS chapter_id, chapters_fts.body AS body
         FROM chapters_fts JOIN chapters ON chapters.id = chapters_fts.chapter_id
        WHERE ${where}
        ORDER BY chapters.seq IS NULL, chapters.seq, chapters.path
        LIMIT ?`,
    )
    .all(...params, limit) as unknown as Array<Record<string, unknown>>
  return {
    ok: true,
    items: hydrate(db, rows, terms, radius),
    total: typeof counted?.n === 'number' ? counted.n : 0,
    mode: 'like',
  }
}

/**
 * Search chapter bodies of the project at `root`.
 *
 * Returns a structured value in every case — an empty query, an invalid query
 * and an unusable index are all answers, not exceptions. The function is
 * deliberately read-only: when the index is absent or was built by another
 * schema it answers `INDEX_UNAVAILABLE` and the caller decides whether to
 * rebuild (the `inkflow_chapter_search` tool rebuilds once, lazily).
 */
export function searchChapters(root: string, query: string, options: ChapterSearchOptions = {}): ChapterSearchResult {
  if (typeof query !== 'string') return invalid('query must be a string')

  // Collapse whitespace once: the LIKE escaping and the FTS phrase builder must
  // both see the same string the length check sees.
  const normalized = query.replace(/\s+/gu, ' ').trim()
  if (normalized.length > MAX_QUERY_CHARS) {
    return invalid(`query is ${normalized.length} characters long; the limit is ${MAX_QUERY_CHARS}`)
  }
  if (normalized === '') return { ok: true, items: [], total: 0, mode: 'like' }

  const limit = clampInteger(options.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT)
  const radius = clampInteger(options.snippet, DEFAULT_SNIPPET_RADIUS, 0, 1000)

  const paths = indexPaths(root)
  if (!existsSync(paths.dbFile)) return unavailable(`no derived index at ${paths.dbFile}`)

  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(paths.dbFile, { readOnly: true })
    const versionRow = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    if (versionRow?.user_version !== INDEX_SCHEMA_VERSION) {
      return unavailable(
        `the index at ${paths.dbFile} was built with schema ${String(versionRow?.user_version ?? 0)}, this plugin expects ${INDEX_SCHEMA_VERSION}`,
      )
    }

    const terms = termsOf(normalized)
    // FTS5's trigram tokenizer cannot index a term shorter than three
    // characters. If *any* term is that short, the whole query is answered by
    // LIKE so that every term still has to match (strict AND, no silent drop).
    if (terms.every((term) => term.length >= 3)) {
      try {
        return searchFts(db, terms, limit, radius)
      } catch {
        // A query the FTS parser still rejects must degrade to the scan, not
        // fail the tool: a cache lookup has no reason to surface a stack.
      }
    }
    return searchLike(db, terms, limit, radius)
  } catch (cause) {
    return unavailable(`the derived index cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`)
  } finally {
    db?.close()
  }
}
