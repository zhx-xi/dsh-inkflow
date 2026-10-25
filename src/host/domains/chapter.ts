/**
 * Chapter domain (`chapters/`).
 *
 * Owns the chapter table, the chapter-body FTS index, and the "chapter files are
 * Markdown" rule. Everything else about chapters (catalog, volumes, CRUD) stays in
 * `chapters.ts` / `catalog.ts` — this module only produces the derived rows.
 */

import { basename, extname, join } from 'node:path'

import { CATALOG_FILE, CHAPTER_STATUSES } from '../conventions.js'
import { intField, parseMarkdown, stringField } from '../frontmatter.js'
import { rowsBucket } from './types.js'
import type { DomainEntityRef, DomainFileParse, DomainModule, DomainScanResult, ValidationIssue } from './types.js'
import { countChars, leadingNumber, readText, rowsOf, volumeDirOf } from './scan-helpers.js'

export interface ChapterRow {
  id: string
  path: string
  seq: number | undefined
  title: string
  volume: string | undefined
  status: string
  wordCount: number
  body: string
  /**
   * `pov` from frontmatter: who the chapter is told from (data-model §3.1).
   *
   * Carried for one reason: a mention scan has to cover the frontmatter too,
   * and an author's `pov: 清音` is a stronger statement than a name occurring in the
   * prose. Only this module parses chapter frontmatter, so it is the only place
   * that can hand it over — re-reading the file later would be a second truth.
   *
   * In-memory only: no `chapters.pov` column exists. The mention scan turns the
   * declaration into an `explicit` row in `entity_mentions`, and that row is what
   * reads later get; a column would be a second copy of it with no reader.
   */
  pov?: string
}

interface ParsedChapter {
  row?: ChapterRow
  issues: ValidationIssue[]
}

function parseChapter(path: string, text: string): ParsedChapter {
  if (extname(path).toLowerCase() !== '.md') {
    return { issues: [{ code: 'CHAPTER_NOT_MARKDOWN', path, detail: 'chapters must be .md files' }] }
  }

  const parsed = parseMarkdown(text)
  const issues: ValidationIssue[] = parsed.issues.map((issue) => ({ code: 'FRONTMATTER_ISSUE', path, detail: issue }))
  const status = stringField(parsed.data, 'status')

  return {
    issues,
    row: {
      id: stringField(parsed.data, 'id') ?? path,
      path,
      seq: intField(parsed.data, 'seq') ?? leadingNumber(path),
      title: stringField(parsed.data, 'title') ?? basename(path).replace(/\.md$/u, ''),
      volume: stringField(parsed.data, 'volume') ?? volumeDirOf(path),
      status: (CHAPTER_STATUSES as readonly string[]).includes(status ?? '') ? (status as string) : 'draft',
      wordCount: countChars(parsed.body),
      body: parsed.body,
      pov: stringField(parsed.data, 'pov'),
    },
  }
}

function toEntity(row: ChapterRow): DomainEntityRef {
  return {
    kind: 'chapters',
    id: row.id,
    path: row.path,
    title: row.title,
    orderIndex: row.seq,
    status: row.status,
  }
}

export const chapterDomain: DomainModule = {
  kind: 'chapters',

  scan({ root, files }): DomainScanResult {
    const rows: ChapterRow[] = []
    const issues: ValidationIssue[] = []
    for (const file of files) {
      // The catalog (`chapters/index.json`, `chapters/<vol>/index.json`) is a
      // committed projection written by this plugin, not a chapter: walking it as
      // one reported CHAPTER_NOT_MARKDOWN for every volume on every rebuild.
      if (basename(file.path) === CATALOG_FILE) continue
      const parsed = parseChapter(file.path, readText(join(root, file.path)))
      issues.push(...parsed.issues)
      if (parsed.row !== undefined) rows.push(parsed.row)
    }
    return { tables: [rowsBucket('chapters', rows)], entities: rows.map(toEntity), issues }
  },

  parseFile({ path, text }): DomainFileParse {
    const parsed = parseChapter(path, text)
    const row = parsed.row
    return {
      path,
      rows: row === undefined ? [] : [rowsBucket('chapters', [row])],
      entity: row === undefined ? undefined : toEntity(row),
      issues: parsed.issues,
    }
  },

  // No domain-local invariant: chapter identity is guarded cross-class by
  // `DUPLICATE_ID`, and the status enum degrades instead of blocking (I-06).
  validate(): ValidationIssue[] {
    return []
  },

  schema() {
    return {
      ddl: [
        // `pov` is deliberately **not** a column: it stays a `ChapterRow` field read
        // in memory (`chaptersOf()` in `mentions.ts` is its only consumer, via the
        // scan it receives), because a mention row already records the declaration —
        // storing it a second time would be a column with no reader.
        'CREATE TABLE chapters (id TEXT PRIMARY KEY, path TEXT NOT NULL, seq INTEGER, title TEXT NOT NULL, volume TEXT, status TEXT NOT NULL, word_count INTEGER NOT NULL)',
        'CREATE INDEX ix_chapters_seq ON chapters(seq)',
        // The body lives only in FTS: it is never read as a row, and keeping it out
        // of `chapters` keeps the table small enough to scan on every query.
        "CREATE VIRTUAL TABLE chapters_fts USING fts5(chapter_id UNINDEXED, title, body, tokenize='trigram')",
      ],
      insert(db, scan): void {
        const insert = db.prepare(
          'INSERT OR REPLACE INTO chapters (id, path, seq, title, volume, status, word_count) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        const insertFts = db.prepare('INSERT INTO chapters_fts (chapter_id, title, body) VALUES (?, ?, ?)')
        for (const row of rowsOf<ChapterRow>(scan, 'chapters')) {
          insert.run(row.id, row.path, row.seq ?? null, row.title, row.volume ?? null, row.status, row.wordCount)
          insertFts.run(row.id, row.title, row.body)
        }
      },
    }
  },

  tools() {
    return []
  },
}
