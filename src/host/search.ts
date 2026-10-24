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

import { CONTENT_DIRS, INDEX_SCHEMA_VERSION } from './conventions.js'
import type { ContentDir } from './conventions.js'
import { searchEntityHits } from './domains/query.js'
import type { EntityHit } from './domains/query.js'
import { indexPaths } from './indexer.js'
import { locateHit, makeSnippet } from './snippet.js'

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
 * Collapse and bound the query once, so the length check, the LIKE escaping and the
 * FTS phrase builder all see the same string (both entry points share this).
 */
function normalizeQuery(query: unknown): { ok: true; text: string } | { ok: false; failure: ChapterSearchFailure } {
  if (typeof query !== 'string') return { ok: false, failure: invalid('query must be a string') }
  const text = query.replace(/\s+/gu, ' ').trim()
  if (text.length > MAX_QUERY_CHARS) {
    return { ok: false, failure: invalid(`query is ${text.length} characters long; the limit is ${MAX_QUERY_CHARS}`) }
  }
  return { ok: true, text }
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

/** A read-only handle on a usable index, or the structured reason there is none. */
type IndexOpen = { ok: true; db: DatabaseSync } | { ok: false; failure: ChapterSearchFailure }

/**
 * Open the derived index read-only, refusing a missing file or a foreign schema.
 *
 * Both entry points in this module go through here, so "a cache lookup rebuilds
 * nothing" is one decision instead of two. The caller closes `db`.
 */
function openIndexForSearch(root: string): IndexOpen {
  const paths = indexPaths(root)
  if (!existsSync(paths.dbFile)) return { ok: false, failure: unavailable(`no derived index at ${paths.dbFile}`) }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(paths.dbFile, { readOnly: true })
    const versionRow = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    if (versionRow?.user_version !== INDEX_SCHEMA_VERSION) {
      db.close()
      return {
        ok: false,
        failure: unavailable(
          `the index at ${paths.dbFile} was built with schema ${String(versionRow?.user_version ?? 0)}, this plugin expects ${INDEX_SCHEMA_VERSION}`,
        ),
      }
    }
    return { ok: true, db }
  } catch (cause) {
    db?.close()
    return {
      ok: false,
      failure: unavailable(`the derived index cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`),
    }
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
  const normalized = normalizeQuery(query)
  if (!normalized.ok) return normalized.failure
  if (normalized.text === '') return { ok: true, items: [], total: 0, mode: 'like' }

  const limit = clampInteger(options.limit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT)
  const radius = clampInteger(options.snippet, DEFAULT_SNIPPET_RADIUS, 0, 1000)

  const opened = openIndexForSearch(root)
  if (!opened.ok) return opened.failure
  const { db } = opened
  try {
    const terms = termsOf(normalized.text)
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
    db.close()
  }
}

// ---------------------------------------------------------------------------
// One search entry for every kind (issue #39, roadmap X-16)
//
// `searchChapters` above answers "which chapter holds this text". The book also
// holds six more kinds of prose (characters, world, outlines, foreshadowing,
// timeline, relations, facts, library) and the author's real question is "where
// is this name", not "which chapter". X-16 fixes one entry point and one entry
// shape for that question — `{kind, id, path, title, snippet, offset?, score?}`,
// paged by `{offset, limit, total}` with `limit` capped at 100 — so #41 can put a
// semantic backend behind the same envelope without changing a single caller.
//
// Three properties this implementation owns:
//   - **Read-only, no 500.** A missing or foreign index is `INDEX_UNAVAILABLE`,
//     the same structured answer the chapter-only search gives, and nothing is
//     written. The tool/route layer decides whether to rebuild once.
//   - **Chapter hits match body *or* title.** One `chapters_fts` row per chapter indexes
//     both columns, so the trigram branch already sees a title; the extra `LIKE` scan over
//     `chapters.title` is what keeps titles searchable for 1–2 character queries, where
//     trigram cannot match at all. A hit whose term is only in the title shows the title as
//     its snippet, never a body window that does not contain the word.
//   - **Deterministic order.** Kind groups follow `CONTENT_DIRS`, and inside a
//     group the order is the backend's (FTS rank) or reading order (`seq`, path).
//     Paging over two sources is then a slice of one merged list, not a guess.
// ---------------------------------------------------------------------------

/** The kinds one search can cover: the nine content directories (X-16). */
export const SEARCH_KINDS = CONTENT_DIRS
export type SearchKind = ContentDir

/** Which backend answered — `'ovk'` is #41's, and this build never claims it. */
export type SearchBackend = 'fts5' | 'ovk'

/** One hit, in the shape X-16 fixes for every backend. */
export interface SearchEntry {
  /** The content directory the hit lives in (`chapters`, `characters`, …). */
  kind: string
  /** The entity id (for a chapter: its chapter id). */
  id: string
  /** Project-relative path, `/` separators. */
  path: string
  title: string
  /** Matched text around the first hit — body prose or the entry's own fields, never frontmatter. */
  snippet: string
  /** Character offset of the first hit inside the text the snippet was cut from. */
  offset?: number
  /** The backend's own ranking; **higher is better**, comparable only within one response. */
  score?: number
}

export interface SearchEntriesSuccess {
  ok: true
  items: SearchEntry[]
  offset: number
  limit: number
  /** Every match in the selected kinds, not the page size. */
  total: number
  /**
   * True when the answer is short of what was asked for: more matches than the page,
   * or a requested `limit` above the ceiling of 100 (which is clamped, not refused).
   */
  truncated: boolean
  mode: SearchMode
  searchBackend: SearchBackend
  /** Set only when a non-default backend degraded; the fts5 backend never degrades. */
  degradedReason?: string
}

export interface SearchEntriesFailure {
  ok: false
  code: ChapterSearchErrorCode
  message: string
  hint?: string
}

export type SearchEntriesResult = SearchEntriesSuccess | SearchEntriesFailure

export interface SearchEntriesOptions {
  /** Kinds to include (default: all nine). Unknown names are refused, never ignored. */
  kinds?: readonly string[]
  /** Hits to skip (default 0). */
  offset?: number
  /** Hits per page (default 20, ceiling 100 — a larger request is clamped). */
  limit?: number
  /** Characters kept either side of the hit (default 40; 0 → empty snippet). */
  snippet?: number
}

/** A deep offset is a scan, not a page: bounded so a typo cannot read the whole book. */
export const MAX_SEARCH_OFFSET = 5000

function normalizeKinds(kinds: unknown): { ok: true; kinds: SearchKind[] } | { ok: false; failure: SearchEntriesFailure } {
  if (kinds === undefined || kinds === null) return { ok: true, kinds: [...CONTENT_DIRS] }
  if (!Array.isArray(kinds) || kinds.length === 0) {
    return { ok: false, failure: invalid('kinds must be a non-empty array of content directory names') }
  }
  const out: SearchKind[] = []
  for (const raw of kinds) {
    if (typeof raw !== 'string' || !(CONTENT_DIRS as readonly string[]).includes(raw)) {
      return {
        ok: false,
        failure: invalid(`unknown kind ${String(raw)}; the kinds are ${CONTENT_DIRS.join(', ')}`),
      }
    }
    const kind = raw as SearchKind
    if (!out.includes(kind)) out.push(kind)
  }
  return { ok: true, kinds: out }
}

interface ChapterHitRow {
  id: string
  path: string
  title: string
  /** Body text (empty for a title-only hit). */
  body: string
  score?: number
}

/** Chapter rows whose body matches, ranked (FTS) or in reading order (LIKE). */
function chapterBodyHits(db: DatabaseSync, terms: readonly string[], need: number): { rows: ChapterHitRow[]; total: number; fts: boolean } {
  const ordering = 'ORDER BY chapters.seq IS NULL, chapters.seq, chapters.path'
  if (terms.every((term) => term.length >= 3)) {
    try {
      const match = ftsMatchExpression(terms)
      const counted = db
        .prepare('SELECT COUNT(*) AS n FROM chapters_fts WHERE chapters_fts MATCH ?')
        .get(match) as { n?: number } | undefined
      const rows = db
        .prepare(
          `SELECT c.id AS id, c.path AS path, c.title AS title, f.body AS body, f.rank AS rank
             FROM chapters_fts f JOIN chapters c ON c.id = f.chapter_id
            WHERE chapters_fts MATCH ?
            ORDER BY f.rank
            LIMIT ?`,
        )
        .all(match, need) as unknown as Array<Record<string, unknown>>
      return { rows: rows.map(chapterRowOf), total: typeof counted?.n === 'number' ? counted.n : 0, fts: true }
    } catch {
      // A query the FTS parser still rejects degrades to the scan (same rule as
      // `searchChapters`): a cache lookup must not surface a parser error.
    }
  }
  const where = terms.map(() => "f.body LIKE ? ESCAPE '\\'").join(' AND ')
  const params = terms.map(likePattern)
  const counted = db
    .prepare(`SELECT COUNT(*) AS n FROM chapters_fts f WHERE ${where}`)
    .get(...params) as { n?: number } | undefined
  const rows = db
    .prepare(
      `SELECT c.id AS id, c.path AS path, c.title AS title, f.body AS body
         FROM chapters_fts f JOIN chapters c ON c.id = f.chapter_id
        WHERE ${where}
        ${ordering.replaceAll('chapters.', 'c.')}
        LIMIT ?`,
    )
    .all(...params, need) as unknown as Array<Record<string, unknown>>
  return { rows: rows.map(chapterRowOf), total: typeof counted?.n === 'number' ? counted.n : 0, fts: false }
}

function chapterRowOf(row: Record<string, unknown>): ChapterHitRow {
  const hit: ChapterHitRow = {
    id: String(row['id'] ?? ''),
    path: String(row['path'] ?? ''),
    title: String(row['title'] ?? ''),
    body: typeof row['body'] === 'string' ? row['body'] : '',
  }
  // FTS5's `rank` is bm25 with the sign flipped (more negative = better), so
  // `-rank` is "higher is better" — the one convention every backend reports.
  if (typeof row['rank'] === 'number' && Number.isFinite(row['rank'])) hit.score = -row['rank']
  return hit
}

/** Chapters whose **title** matches. A title has no trigram index, so this is a scan. */
function chapterTitleHits(db: DatabaseSync, terms: readonly string[], need: number): { rows: ChapterHitRow[]; total: number } {
  const where = terms.map(() => "title LIKE ? ESCAPE '\\'").join(' AND ')
  const params = terms.map(likePattern)
  const counted = db.prepare(`SELECT COUNT(*) AS n FROM chapters WHERE ${where}`).get(...params) as { n?: number } | undefined
  const rows = db
    .prepare(
      `SELECT id, path, title FROM chapters WHERE ${where}
        ORDER BY seq IS NULL, seq, path
        LIMIT ?`,
    )
    .all(...params, need) as unknown as Array<Record<string, unknown>>
  return {
    rows: rows.map((row) => ({ id: String(row['id'] ?? ''), path: String(row['path'] ?? ''), title: String(row['title'] ?? ''), body: '' })),
    total: typeof counted?.n === 'number' ? counted.n : 0,
  }
}

/** How many chapters match on body *and* title — the double count the totals must drop. */
function chapterOverlap(db: DatabaseSync, terms: readonly string[], bodyUsesFts: boolean): number {
  const titleWhere = terms.map(() => "c.title LIKE ? ESCAPE '\\'").join(' AND ')
  const titleParams = terms.map(likePattern)
  try {
    if (bodyUsesFts) {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM chapters_fts f JOIN chapters c ON c.id = f.chapter_id
            WHERE chapters_fts MATCH ? AND ${titleWhere}`,
        )
        .get(ftsMatchExpression(terms), ...titleParams) as { n?: number } | undefined
      return typeof row?.n === 'number' ? row.n : 0
    }
    const bodyWhere = terms.map(() => "f.body LIKE ? ESCAPE '\\'").join(' AND ')
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM chapters_fts f JOIN chapters c ON c.id = f.chapter_id
          WHERE ${bodyWhere} AND ${titleWhere}`,
      )
      .get(...terms.map(likePattern), ...titleParams) as { n?: number } | undefined
    return typeof row?.n === 'number' ? row.n : 0
  } catch {
    // A count that cannot be computed must not fail the search: the totals are
    // then a lower bound, which `truncated` already reports honestly.
    return 0
  }
}

function chapterEntries(db: DatabaseSync, terms: readonly string[], need: number, radius: number): { items: SearchEntry[]; total: number; mode: SearchMode } {
  const body = chapterBodyHits(db, terms, need)
  const titles = chapterTitleHits(db, terms, need)
  const items: SearchEntry[] = []
  const seen = new Set<string>()
  for (const row of body.rows) {
    // `chapters_fts` indexes the title *and* the body (one FTS row per chapter), so an
    // FTS hit may have matched the title alone. Slicing that snippet out of the body would
    // show text that does not contain the term — a hit with no visible reason. The title is
    // the honest context for that case, and the chapter-match rule stays "body or title".
    const inBody = locateHit(row.body, terms)
    const hit = inBody ?? locateHit(row.title, terms)
    const entry: SearchEntry = {
      kind: 'chapters',
      id: row.id,
      path: row.path,
      title: row.title,
      snippet: inBody === undefined ? makeSnippet(row.title, terms, radius) : makeSnippet(row.body, terms, radius),
    }
    if (hit !== undefined) entry.offset = hit.at
    if (row.score !== undefined) entry.score = row.score
    items.push(entry)
    seen.add(row.id)
  }
  for (const row of titles.rows) {
    if (seen.has(row.id)) continue
    const hit = locateHit(row.title, terms)
    const entry: SearchEntry = { kind: 'chapters', id: row.id, path: row.path, title: row.title, snippet: makeSnippet(row.title, terms, radius) }
    if (hit !== undefined) entry.offset = hit.at
    items.push(entry)
    seen.add(row.id)
  }
  return {
    items,
    total: body.total + titles.total - chapterOverlap(db, terms, body.fts),
    mode: body.fts ? 'fts' : 'like',
  }
}

function entityEntryOf(hit: EntityHit): SearchEntry {
  const entry: SearchEntry = { kind: hit.kind, id: hit.id, path: hit.path, title: hit.title, snippet: hit.snippet, offset: hit.offset }
  if (hit.score !== undefined) entry.score = hit.score
  return entry
}

/**
 * Search every kind of the book at `root` through one entry (X-16).
 *
 * Groups are merged in a fixed order — **the setting library first, chapter prose
 * last** — because the two questions are different sizes: an entity matches only when
 * its title/aliases/keywords hold the term (a handful of rows), while the manuscript
 * matches in every chapter that uses the word (hundreds). Putting the library first
 * answers "where is this defined" on page one and leaves the bulk to the pages after
 * it. Inside a group the order is the backend's (FTS rank) or reading order
 * (`seq`, path), so paging is a slice of a stable sequence.
 *
 * `total` counts every match in the selected kinds; `truncated` says the page is
 * smaller than that, or that the requested `limit` was clamped to 100.
 */
export function searchEntries(root: string, query: string, options: SearchEntriesOptions = {}): SearchEntriesResult {
  const normalized = normalizeQuery(query)
  if (!normalized.ok) return { ok: false, code: normalized.failure.code, message: normalized.failure.message, ...(normalized.failure.hint === undefined ? {} : { hint: normalized.failure.hint }) }
  const selected = normalizeKinds(options.kinds)
  if (!selected.ok) return selected.failure

  const requestedLimit = options.limit
  const limit = clampInteger(requestedLimit, DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT)
  const offset = clampInteger(options.offset, 0, 0, MAX_SEARCH_OFFSET)
  const radius = clampInteger(options.snippet, DEFAULT_SNIPPET_RADIUS, 0, 1000)
  const clampedLimit = typeof requestedLimit === 'number' && requestedLimit > MAX_SEARCH_LIMIT

  if (normalized.text === '') {
    return { ok: true, items: [], offset, limit, total: 0, truncated: clampedLimit, mode: 'like', searchBackend: 'fts5' }
  }

  const opened = openIndexForSearch(root)
  if (!opened.ok) return { ok: false, code: opened.failure.code, message: opened.failure.message, ...(opened.failure.hint === undefined ? {} : { hint: opened.failure.hint }) }
  const { db } = opened
  try {
    const terms = termsOf(normalized.text)
    // Both sources need the same number of rows: a page that starts at `offset`
    // can only be cut from a merged list that reaches `offset + limit`.
    const need = offset + limit
    const wantsChapters = selected.kinds.includes('chapters')
    const entityKinds = selected.kinds.filter((kind) => kind !== 'chapters')

    const chapters = wantsChapters ? chapterEntries(db, terms, need, radius) : { items: [] as SearchEntry[], total: 0, mode: 'like' as SearchMode }
    let entities: { items: SearchEntry[]; total: number } = { items: [], total: 0 }
    let mode = chapters.mode
    if (entityKinds.length > 0) {
      const page = searchEntityHits(root, terms, { kinds: entityKinds, limit: need, radius })
      if (page === undefined) {
        // The projection opened fine for the chapter side, so a failing entity read
        // means the index changed under us. `INDEX_UNAVAILABLE` says "rebuild", which
        // is both true and safe; an empty list would read as "no such entity".
        return unavailable(`the entity projection of ${root} cannot be read; rebuild the derived index and search again`)
      }
      entities = { items: page.items.map(entityEntryOf), total: page.total }
      if (page.mode === 'like') mode = 'like'
    }

    const merged = [...entities.items, ...chapters.items]
    const items = merged.slice(offset, offset + limit)
    const total = chapters.total + entities.total
    return {
      ok: true,
      items,
      offset,
      limit,
      total,
      truncated: clampedLimit || total > offset + items.length,
      mode,
      searchBackend: 'fts5',
    }
  } catch (cause) {
    return unavailable(`the derived index cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`)
  } finally {
    db.close()
  }
}
