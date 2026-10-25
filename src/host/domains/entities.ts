/**
 * The cross-class `entities` projection (roadmap X-1) and its full-text index (X-3).
 *
 * Why a projection at all: the nine-class panel, cross-class duplicate-id
 * checks (I-04) and mention resolution all need "every entity of this book"
 * without unioning six tables. The projection is written from the same scan as the
 * domain tables, in the same transaction, which is what keeps I-15 (`ENTITIES_DRIFT`)
 * a real check rather than a hope.
 */

import type { DomainDatabase, DomainEntityRef } from './types.js'
import { joinTerms, splitTerms } from './scan-helpers.js'

/**
 * Statements for the projection. The column set is fixed by X-1: a domain adds rows,
 * never columns, so `entityRows()` below can stay a single implementation.
 */
export const ENTITIES_DDL: readonly string[] = [
  // Primary key is (kind, id), not id alone: separate domain tables have separate
  // primary keys, so two kinds may legitimately share an id. That collision is
  // reported as `DUPLICATE_ID` (I-04) but neither row is dropped — an existing
  // contract of the index, and the projection must be able to represent it.
  'CREATE TABLE entities (kind TEXT NOT NULL, id TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, name_key TEXT, category TEXT, parent TEXT, order_index INTEGER, status TEXT, keywords TEXT, aliases TEXT, PRIMARY KEY (kind, id))',
  'CREATE INDEX ix_entities_id ON entities(id)',
  'CREATE INDEX ix_entities_kind ON entities(kind)',
  'CREATE INDEX ix_entities_path ON entities(path)',
  'CREATE INDEX ix_entities_name_key ON entities(name_key)',
  // One FTS table for the whole book (X-3): a per-domain FTS would give six places to
  // forget when a field changes, and the query would have to union them anyway.
  "CREATE VIRTUAL TABLE entities_fts USING fts5(entity_key UNINDEXED, title, aliases, keywords, tokenize='trigram')",
]

/** The exact column order `insertEntities` binds; exported so a test can assert it. */
export const ENTITY_COLUMNS = [
  'id',
  'kind',
  'path',
  'title',
  'name_key',
  'category',
  'parent',
  'order_index',
  'status',
  'keywords',
  'aliases',
] as const

/** One projection row → the values `insertEntities` binds, in `ENTITY_COLUMNS` order. */
export function entityValues(entity: DomainEntityRef): unknown[] {
  return [
    entity.id,
    entity.kind,
    entity.path,
    entity.title,
    entity.nameKey ?? null,
    entity.category ?? null,
    entity.parent ?? null,
    entity.orderIndex ?? null,
    entity.status ?? null,
    joinTerms(entity.keywords) ?? null,
    joinTerms(entity.aliases) ?? null,
  ]
}

/** Address of one projection row in the FTS table (`kind:id`). */
export function entityKey(entity: DomainEntityRef): string {
  return `${entity.kind}:${entity.id}`
}

/** Write the projection and its FTS rows; called inside the build transaction. */
export function insertEntities(db: DomainDatabase, entities: readonly DomainEntityRef[]): void {
  const insert = db.prepare(
    `INSERT OR REPLACE INTO entities (${ENTITY_COLUMNS.join(', ')}) VALUES (${ENTITY_COLUMNS.map(() => '?').join(', ')})`,
  )
  const insertFts = db.prepare('INSERT INTO entities_fts (entity_key, title, aliases, keywords) VALUES (?, ?, ?, ?)')
  for (const entity of entities) {
    insert.run(...entityValues(entity))
    insertFts.run(entityKey(entity), entity.title, joinTerms(entity.aliases) ?? '', joinTerms(entity.keywords) ?? '')
  }
}

/** Rebuild a projection row from a stored row (the reverse of {@link entityValues}). */
export function entityFromRow(row: Record<string, unknown>): DomainEntityRef {
  const text = (key: string): string | undefined => {
    const value = row[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  const number = (key: string): number | undefined => {
    const value = row[key]
    return typeof value === 'number' ? value : undefined
  }
  return {
    kind: text('kind') as DomainEntityRef['kind'],
    id: text('id') ?? '',
    path: text('path') ?? '',
    title: text('title') ?? '',
    nameKey: text('name_key'),
    category: text('category'),
    parent: text('parent'),
    orderIndex: number('order_index'),
    status: text('status'),
    keywords: splitTerms(text('keywords')),
    aliases: splitTerms(text('aliases')),
  }
}
