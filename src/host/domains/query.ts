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
import { entityFromRow } from './entities.js'
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
    const rows =
      [...trimmed].length >= 3
        ? (db
            .prepare(
              `SELECT e.kind, e.id, e.path, e.title, e.name_key, e.category, e.parent, e.order_index, e.status, e.keywords, e.aliases
                 FROM entities_fts f
                 JOIN entities e ON e.kind || ':' || e.id = f.entity_key
                WHERE entities_fts MATCH ?
                ORDER BY rank
                LIMIT ?`,
            )
            .all(ftsPhrase(trimmed), capped) as unknown as Array<Record<string, unknown>>)
        : (db
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
          >)
    return rows.map(toSummary)
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
