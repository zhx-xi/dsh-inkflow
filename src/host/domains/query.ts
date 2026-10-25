/**
 * Reading the cross-class projection.
 *
 * Why here and not in `search.ts`: `search.ts` answers "which chapter contains this
 * text" over the manuscript; this answers "which entity is this" over the setting
 * library. Same retrieval policy (trigram `MATCH` above two characters, `LIKE` below,
 * see conventions §4.1), different table and different meaning of a hit.
 *
 * Every function returns `undefined` when the index is absent or built by another
 * schema — the caller then tells the user to rebuild instead of showing stale rows.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { INDEX_DB_FILE, INDEX_DIR, INDEX_SCHEMA_VERSION } from '../conventions.js'
import { locateHit, makeSnippet } from '../snippet.js'
import { entityFromRow } from './entities.js'
import { splitTerms } from './scan-helpers.js'
import { statusOf } from './timeline-plan.js'
import type { TimelineRow } from './timeline-plan.js'
import type { DomainEntityRef } from './types.js'

export interface EntitySummary extends DomainEntityRef {
  /** Convenience for callers that only need the kind name (panel sections, counts). */
  readonly kindLabel: string
}

export interface ListEntitiesOptions {
  /** Restrict to one content directory (X-7's panel sections). */
  readonly kind?: string
  readonly limit?: number
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

function clamp(limit: number | undefined): number {
  const value = limit ?? DEFAULT_LIMIT
  return Math.min(Math.max(value, 1), MAX_LIMIT)
}

function openIndex(root: string): DatabaseSync | undefined {
  // Derived from the conventions rather than importing `indexer.ts`: the query side is
  // the only reader that must not drag the build path into a panel request.
  const dbFile = join(root, INDEX_DIR, INDEX_DB_FILE)
  if (!existsSync(dbFile)) return undefined
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbFile, { readOnly: true })
    const versionRow = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    if (versionRow?.user_version !== INDEX_SCHEMA_VERSION) {
      db.close()
      return undefined
    }
    return db
  } catch {
    db?.close()
    return undefined
  }
}

function toSummary(row: Record<string, unknown>): EntitySummary {
  const entity = entityFromRow(row)
  return { ...entity, kindLabel: entity.kind }
}

function selectColumns(): string {
  return 'kind, id, path, title, name_key, category, parent, order_index, status, keywords, aliases'
}

/**
 * List entities of the book, optionally one kind, in a stable order.
 *
 * Ordered by kind then title then path so a panel section is stable across rebuilds
 * (a book with two entries of the same title still has a deterministic order).
 */
export function listEntities(root: string, options: ListEntitiesOptions = {}): EntitySummary[] | undefined {
  const db = openIndex(root)
  if (db === undefined) return undefined
  try {
    const limit = clamp(options.limit)
    const rows =
      options.kind === undefined
        ? (db
            .prepare(`SELECT ${selectColumns()} FROM entities ORDER BY kind, title, path LIMIT ?`)
            .all(limit) as unknown as Array<Record<string, unknown>>)
        : (db
            .prepare(`SELECT ${selectColumns()} FROM entities WHERE kind = ? ORDER BY title, path LIMIT ?`)
            .all(options.kind, limit) as unknown as Array<Record<string, unknown>>)
    return rows.map(toSummary)
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

/** Escape a value for FTS5 phrase matching (`"` doubled, everything else literal). */
function ftsPhrase(query: string): string {
  return `"${query.replace(/"/gu, '""')}"`
}

/** Escape LIKE wildcards so a literal `%` or `_` in a name matches itself. */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/gu, (match) => `\\${match}`)}%`
}

/**
 * Search the projection by title, aliases or keywords.
 *
 * The two-character boundary is the same one the manuscript search has: a trigram
 * index cannot match fewer than three characters, so 1–2 character queries fall back
 * to `LIKE` over the three text columns (conventions §4.1). Hits keep the entity's
 * kind so a panel can jump to the right section.
 */
export function searchEntities(root: string, query: string, limit = DEFAULT_LIMIT): EntitySummary[] | undefined {
  const trimmed = query.trim()
  if (trimmed === '') return []
  const db = openIndex(root)
  if (db === undefined) return undefined
  try {
    const capped = clamp(limit)
    if ([...trimmed].length >= 3) {
      try {
        const rows = db
          .prepare(
            `SELECT e.kind, e.id, e.path, e.title, e.name_key, e.category, e.parent, e.order_index, e.status, e.keywords, e.aliases
               FROM entities_fts f
               JOIN entities e ON e.kind || ':' || e.id = f.entity_key
              WHERE entities_fts MATCH ?
              ORDER BY rank
              LIMIT ?`,
          )
          .all(ftsPhrase(trimmed), capped) as unknown as Array<Record<string, unknown>>
        return rows.map(toSummary)
      } catch {
        // A query FTS5 cannot parse (unbalanced quote, operator) must not read as
        // "index unusable" — `search.ts` degrades the same way. Fall through to LIKE.
      }
    }
    const rows = db
      .prepare(
        `SELECT ${selectColumns()}
           FROM entities
          WHERE title LIKE ? ESCAPE '\\'
             OR aliases LIKE ? ESCAPE '\\'
             OR keywords LIKE ? ESCAPE '\\'
          ORDER BY kind, title, path
          LIMIT ?`,
      )
      .all(likePattern(trimmed), likePattern(trimmed), likePattern(trimmed), capped) as unknown as Array<
      Record<string, unknown>
    >
    return rows.map(toSummary)
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

/**
 * One hit of the cross-class search, in the shape X-16 fixes
 * (`{kind, id, path, title, snippet, offset?, score?}`, issue #39).
 *
 * `snippet` is cut from the entry's own searchable fields (title · aliases ·
 * keywords) rather than from the file: the projection stores frontmatter values, not
 * frontmatter text, so a snippet can never leak `id:`/`status:` lines into what the
 * model or the panel reads back.
 */
export interface EntityHit {
  readonly kind: string
  readonly id: string
  readonly path: string
  readonly title: string
  readonly snippet: string
  /** Character offset of the first hit inside the joined field text. */
  readonly offset: number
  /** The backend's ranking; higher is better. Absent on the `LIKE` scan. */
  readonly score?: number
}

export interface EntityHitPage {
  readonly items: EntityHit[]
  /** Every match in the requested kinds, not the page size. */
  readonly total: number
  readonly mode: 'fts' | 'like'
}

export interface EntityHitOptions {
  /**
   * Content directories to search. The caller passes already-validated names and
   * **must not** include `chapters`: chapter rows are also in the projection, and the
   * unified search reads chapter prose from `chapters_fts` — asking for both would
   * report the same chapter twice.
   */
  readonly kinds?: readonly string[]
  readonly limit?: number
  /** Characters kept either side of the hit (default 40). */
  readonly radius?: number
}

/** Terms joined the way the projection stored them (`joinTerms` in `scan-helpers.ts`). */
function fieldTextOf(row: Record<string, unknown>): string {
  const parts: string[] = []
  for (const key of ['title', 'aliases', 'keywords']) {
    const value = row[key]
    if (typeof value === 'string' && value.trim() !== '') parts.push(value.trim())
  }
  return parts.join(' · ')
}

function entityHitOf(row: Record<string, unknown>, terms: readonly string[], radius: number): EntityHit {
  const text = fieldTextOf(row)
  const hit = locateHit(text, terms)
  const result: EntityHit = {
    kind: String(row['kind'] ?? ''),
    id: String(row['id'] ?? ''),
    path: String(row['path'] ?? ''),
    title: String(row['title'] ?? ''),
    snippet: makeSnippet(text, terms, radius),
    offset: hit === undefined ? 0 : hit.at,
  }
  // FTS5's bm25 `rank` is more-negative-is-better; the wire convention is the reverse.
  if (typeof row['rank'] === 'number' && Number.isFinite(row['rank'])) {
    return { ...result, score: -(row['rank'] as number) }
  }
  return result
}

/**
 * Search the entity projection by title, aliases or keywords, with a total and a page.
 *
 * This is the shape the unified search (#39, X-16) needs and `searchEntities` above
 * cannot give it: a count for `total`, a snippet, and multi-term AND semantics that
 * match the chapter side (every whitespace-separated term has to appear somewhere in
 * the entry's fields). `undefined` means "no usable index", never "no matches".
 */
export function searchEntityHits(
  root: string,
  terms: readonly string[],
  options: EntityHitOptions = {},
): EntityHitPage | undefined {
  const effective = terms.filter((term) => term !== '')
  if (effective.length === 0) return { items: [], total: 0, mode: 'like' }
  const db = openIndex(root)
  if (db === undefined) return undefined
  const limit = clamp(options.limit)
  const radius = options.radius ?? 40
  const kinds = options.kinds === undefined || options.kinds.length === 0 ? undefined : [...options.kinds]
  try {
    if (effective.every((term) => term.length >= 3)) {
      try {
        // One quoted phrase per term joined by AND: the same strict semantics the
        // chapter side uses, and the same guarantee that no term reaches the FTS
        // parser as an operator (a phrase is literal text).
        const match = effective.map((term) => ftsPhrase(term)).join(' AND ')
        const kindWhere = kinds === undefined ? '' : ` AND e.kind IN (${kinds.map(() => '?').join(', ')})`
        const kindParams = kinds ?? []
        const counted = db
          .prepare(
            `SELECT COUNT(*) AS n FROM entities_fts f JOIN entities e ON e.kind || ':' || e.id = f.entity_key
              WHERE entities_fts MATCH ?${kindWhere}`,
          )
          .get(match, ...kindParams) as { n?: number } | undefined
        const rows = db
          .prepare(
            `SELECT e.kind, e.id, e.path, e.title, e.aliases, e.keywords, f.rank AS rank
               FROM entities_fts f JOIN entities e ON e.kind || ':' || e.id = f.entity_key
              WHERE entities_fts MATCH ?${kindWhere}
              ORDER BY f.rank
              LIMIT ?`,
          )
          .all(match, ...kindParams, limit) as unknown as Array<Record<string, unknown>>
        return {
          items: rows.map((row) => entityHitOf(row, effective, radius)),
          total: typeof counted?.n === 'number' ? counted.n : 0,
          mode: 'fts',
        }
      } catch {
        // A query FTS5 cannot parse degrades to the scan, exactly as `search.ts` does.
      }
    }
    const termWhere = effective
      .map(() => "(e.title LIKE ? ESCAPE '\\' OR e.aliases LIKE ? ESCAPE '\\' OR e.keywords LIKE ? ESCAPE '\\')")
      .join(' AND ')
    const kindWhere = kinds === undefined ? '' : ` AND e.kind IN (${kinds.map(() => '?').join(', ')})`
    const params = [
      ...effective.flatMap((term) => [likePattern(term), likePattern(term), likePattern(term)]),
      ...(kinds ?? []),
    ]
    const counted = db
      .prepare(`SELECT COUNT(*) AS n FROM entities e WHERE ${termWhere}${kindWhere}`)
      .get(...params) as { n?: number } | undefined
    const rows = db
      .prepare(
        `SELECT e.kind, e.id, e.path, e.title, e.aliases, e.keywords
           FROM entities e
          WHERE ${termWhere}${kindWhere}
          ORDER BY e.kind, e.title, e.path
          LIMIT ?`,
      )
      .all(...params, limit) as unknown as Array<Record<string, unknown>>
    return {
      items: rows.map((row) => entityHitOf(row, effective, radius)),
      total: typeof counted?.n === 'number' ? counted.n : 0,
      mode: 'like',
    }
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

/**
 * One edge of the relation graph, as a reader sees it.
 *
 * Field names are the frontmatter ones (`kind`, `dir`) rather than the row's
 * (`relation_kind`, `direction`): the edge is what the file says, and the tool that
 * writes it already speaks this vocabulary.
 */
export interface RelationEdge {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly source: string
  readonly target: string
  readonly kind: string
  readonly dir: string
  readonly since?: string
  readonly until?: string
  readonly chapter?: string
}

function toEdge(row: Record<string, unknown>): RelationEdge {
  const text = (key: string): string | undefined => {
    const value = row[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  return {
    id: text('id') ?? '',
    path: text('path') ?? '',
    title: text('title') ?? '',
    source: text('source') ?? '',
    target: text('target') ?? '',
    kind: text('relation_kind') ?? '',
    dir: text('direction') ?? 'directed',
    since: text('since'),
    until: text('until'),
    chapter: text('chapter'),
  }
}

/**
 * Every edge touching one entity, in both roles — the read behind
 * `inkflow_relation_list` and, later, the panel's relation section.
 *
 * `source = ? OR target = ?` is the whole point: an edge is symmetric to the writer
 * but directional to the reader, and "all edges of this character" must not depend
 * on which end the author happened to name first. `undefined` means the index is
 * absent or foreign — the caller rebuilds, never renders an empty list as "no edges".
 */
export function listRelationsFor(root: string, entityId: string, limit?: number): RelationEdge[] | undefined {
  const db = openIndex(root)
  if (db === undefined) return undefined
  try {
    const rows = db
      .prepare(
        `SELECT id, path, title, relation_kind, source, target, direction, since, until, chapter
           FROM relations
          WHERE source = ? OR target = ?
          ORDER BY relation_kind, path
          LIMIT ?`,
      )
      .all(entityId, entityId, clamp(limit)) as unknown as Array<Record<string, unknown>>
    return rows.map(toEdge)
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

/**
 * Display titles for a handful of entity ids, from the cross-class projection (#48).
 *
 * Why not `listEntities` + a filter: the clue view asks about the peers of *one* entity,
 * which may be a dozen ids of five different kinds, and reading the whole projection to
 * resolve twelve names is the query this tool would then spend its budget on.
 *
 * "Exactly one" is not required here (unlike `RELATION_ENDPOINT`): an id two kinds share
 * still resolves to a *name* for display, and the report says which one won by taking the
 * first in `(kind, id)` order — deterministic on every run, which is what a stable reply
 * needs.
 */
export function titlesForIds(root: string, ids: readonly string[]): Record<string, string> | undefined {
  if (ids.length === 0) return {}
  const db = openIndex(root)
  if (db === undefined) return undefined
  try {
    const placeholders = ids.map(() => '?').join(', ')
    const rows = db
      .prepare(`SELECT id, title FROM entities WHERE id IN (${placeholders}) ORDER BY kind, id`)
      .all(...ids) as unknown as Array<Record<string, unknown>>
    const titles: Record<string, string> = {}
    for (const row of rows) {
      const id = typeof row['id'] === 'string' ? row['id'] : ''
      const title = typeof row['title'] === 'string' ? row['title'] : ''
      if (id === '' || id in titles) continue
      titles[id] = title
    }
    return titles
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

/** Count entities per kind — the panel's section badges, and a cheap sanity check. */
export function entityCounts(root: string): Record<string, number> | undefined {
  const db = openIndex(root)
  if (db === undefined) return undefined
  try {
    const rows = db.prepare('SELECT kind, COUNT(*) AS n FROM entities GROUP BY kind ORDER BY kind').all() as unknown as Array<{
      kind: string
      n: number
    }>
    return Object.fromEntries(rows.map((row) => [row.kind, row.n]))
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

/**
 * One world entry as the world book reads it (issue #26).
 *
 * Read from `world_entries` rather than from the `entities` projection: `always`
 * and `priority` are world-book fields and are deliberately **not** columns of the
 * projection (X-1 fixes that column set), so the projection cannot answer "which
 * entries are always on".
 */
export interface WorldIndexEntry {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly category?: string
  readonly parent?: string
  readonly keywords: readonly string[]
  readonly always: boolean
  readonly priority?: number
}

/**
 * Every world entry, ordered by path so two builds of the same book list them the
 * same way. `undefined` means "no usable index" — the caller rebuilds instead of
 * reporting an empty tree as the truth.
 */
export function listWorldEntries(root: string): WorldIndexEntry[] | undefined {
  const db = openIndex(root)
  if (db === undefined) return undefined
  try {
    const rows = db
      .prepare('SELECT id, path, title, category, parent, keywords, always, priority FROM world_entries ORDER BY path')
      .all() as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row['id'] ?? ''),
      path: String(row['path'] ?? ''),
      title: String(row['title'] ?? ''),
      ...(typeof row['category'] === 'string' ? { category: row['category'] } : {}),
      ...(typeof row['parent'] === 'string' ? { parent: row['parent'] } : {}),
      keywords: splitTerms(typeof row['keywords'] === 'string' ? row['keywords'] : undefined),
      always: Number(row['always'] ?? 0) === 1,
      ...(typeof row['priority'] === 'number' ? { priority: row['priority'] } : {}),
    }))
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

/**
 * Every entity id in the book, across all nine kinds (I-05's write-side input).
 *
 * A world entry's `parent` may point at a chapter or a character — `world.ts`
 * validates against the global projection for exactly that reason — so the write
 * path needs the cross-class id set, not just the world one.
 */
export function listEntityIds(root: string): Set<string> | undefined {
  const db = openIndex(root)
  if (db === undefined) return undefined
  try {
    const rows = db.prepare('SELECT id FROM entities').all() as unknown as Array<{ id?: unknown }>
    return new Set(rows.map((row) => String(row.id ?? '')).filter((id) => id !== ''))
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

/**
 * Every timeline event, ordered by path so two builds of the same book list them the
 * same way. The **axes** are not sorted here: `planTimelineView()` owns both orders,
 * so the world axis and the narrative axis are judged by one pure function (#28)
 * instead of by an SQL ORDER BY that a caller could forget to ask for.
 *
 * Read from `timeline_events` rather than from the `entities` projection: `worldTime`,
 * `chapter` and `participants` are timeline fields and are deliberately not columns of
 * the projection (X-1 fixes that column set), so the projection cannot answer "what
 * happened before some date".
 *
 * `world_era` / `world_absolute_day` come straight out of the row (#48): they were
 * derived once at build time from the book's calendar, so a reader that gets a row back
 * never re-derives (and cannot re-derive differently) which day the author meant.
 */
export function listTimelineEvents(root: string): TimelineRow[] | undefined {
  const db = openIndex(root)
  if (db === undefined) return undefined
  try {
    const rows = db
      .prepare(
        'SELECT id, path, title, world_time, world_era, world_absolute_day, narrative_order, chapter, participants, status FROM timeline_events ORDER BY path',
      )
      .all() as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row['id'] ?? ''),
      path: String(row['path'] ?? ''),
      title: String(row['title'] ?? ''),
      ...(typeof row['world_time'] === 'string' && row['world_time'] !== '' ? { worldTime: row['world_time'] } : {}),
      ...(typeof row['world_era'] === 'string' && row['world_era'] !== '' ? { worldEra: row['world_era'] } : {}),
      ...(typeof row['world_absolute_day'] === 'number' ? { worldAbsoluteDay: row['world_absolute_day'] } : {}),
      ...(typeof row['narrative_order'] === 'number' ? { narrativeOrder: row['narrative_order'] } : {}),
      ...(typeof row['chapter'] === 'string' && row['chapter'] !== '' ? { chapter: row['chapter'] } : {}),
      participants: splitTerms(typeof row['participants'] === 'string' ? row['participants'] : undefined),
      status: statusOf(typeof row['status'] === 'string' ? row['status'] : undefined),
    }))
  } catch {
    return undefined
  } finally {
    db.close()
  }
}
