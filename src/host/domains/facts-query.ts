/**
 * Reading the ledger out of the derived index (issue #32).
 *
 * Why the tools read the **table** instead of re-parsing `facts/`: the table exists for
 * exactly this (data-model §4.1 — "账本跨章查询"), and "which facts are in effect at
 * chapter N" is a query, not a second scan of every ledger file. The read goes through
 * `ensureIndex()` first (the caller's job, like every other tool), so the rows are as fresh
 * as the files the moment they are read.
 *
 * The prompt segment reads the same two sources through this module rather than parsing the
 * files itself: two read paths over one format would eventually disagree about what the
 * ledger says, and the injected context is the one place a disagreement is invisible.
 *
 * Chapter order comes from `chapters` (id → `seq`), never from the id's text: `ch-10` sorts
 * before `ch-9` as a string, and a "截至第 N 章" answer built on string order puts facts in
 * effect before they were established.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { INDEX_DB_FILE, INDEX_DIR, INDEX_SCHEMA_VERSION } from '../conventions.js'
import { listChapters } from '../indexer.js'
import { DEFAULT_FACT_SOURCE } from './facts-line.js'
import { FACTS_TABLE } from './facts-plan.js'
import type { ChapterSeq, FactRow } from './facts-plan.js'
import { chapterSeqFromMap } from './facts-plan.js'

/**
 * Chapter ids and positions as the index knows them.
 *
 * `byPath` exists because the writing context hands a chapter's **file path**
 * (`ChapterHead.path`) and the ledger names chapter **ids**: a book whose frontmatter
 * declares `id: ch-0007` cannot be joined on the path alone.
 */
export interface ChapterIndex {
  readonly byId: ReadonlyMap<string, number>
  readonly byPath: ReadonlyMap<string, { readonly id: string; readonly seq?: number }>
  /** The highest `seq` in the book — "the current chapter" when no chapter is named. */
  readonly maxSeq?: number
  /** How many chapters carried a `seq`; `0` means "no order to judge against". */
  readonly placed: number
}

/**
 * `listChapters` caps at 500 rows (its own contract). A book longer than that has its tail
 * chapters unresolvable here, which makes a fact naming one *not judged* rather than
 * wrongly judged — the same visible gap `unresolvedChapterIds` reports.
 */
export const CHAPTER_INDEX_LIMIT = 500

export function chapterIndex(root: string): ChapterIndex | undefined {
  const chapters = listChapters(root, CHAPTER_INDEX_LIMIT)
  if (chapters === undefined) return undefined
  const byId = new Map<string, number>()
  const byPath = new Map<string, { readonly id: string; readonly seq?: number }>()
  let maxSeq: number | undefined
  for (const chapter of chapters) {
    if (chapter.seq !== null) {
      byId.set(chapter.id, chapter.seq)
      maxSeq = maxSeq === undefined ? chapter.seq : Math.max(maxSeq, chapter.seq)
    }
    byPath.set(chapter.path, { id: chapter.id, ...(chapter.seq === null ? {} : { seq: chapter.seq }) })
  }
  return { byId, byPath, ...(maxSeq === undefined ? {} : { maxSeq }), placed: byId.size }
}

export function seqOfChapters(chapters: ChapterIndex): ChapterSeq {
  return chapterSeqFromMap(chapters.byId)
}

function openIndex(root: string): DatabaseSync | undefined {
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

/**
 * Every fact row in the index, in file order. `undefined` means "the index is absent or was
 * built by another schema" — the caller answers `INDEX_UNAVAILABLE` instead of an empty
 * ledger, because "no facts" and "cannot read the facts" are different answers.
 *
 * `extra` is empty here by design: unknown keys are not indexed (they are not fields, they
 * are the author's spare room), and nothing that reads the table writes a file back.
 */
export function readFactsRows(root: string): FactRow[] | undefined {
  const db = openIndex(root)
  if (db === undefined) return undefined
  try {
    const rows = db
      .prepare(
        `SELECT id, path, line, subject, attribute, value, since, until, chapter, source FROM ${FACTS_TABLE} ORDER BY path, line`,
      )
      .all() as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row['id']),
      path: String(row['path']),
      line: typeof row['line'] === 'number' ? row['line'] : 0,
      subject: String(row['subject']),
      attribute: String(row['attribute']),
      value: String(row['value']),
      ...optional('since', row['since']),
      ...optional('until', row['until']),
      ...optional('chapter', row['chapter']),
      source: typeof row['source'] === 'string' && row['source'] !== '' ? row['source'] : DEFAULT_FACT_SOURCE,
      extra: {},
    }))
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

function optional(key: 'since' | 'until' | 'chapter', value: unknown): Record<string, string> {
  return typeof value === 'string' && value !== '' ? { [key]: value } : {}
}
