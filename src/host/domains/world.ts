/**
 * World domain (`world/<category>/`).
 *
 * Owns the world tree and I-08: one root or none (a "flat category book" that keeps
 * every entry under `world/<category>/` and never links them is valid), a child must
 * carry a category, and a `parent` must resolve — across the whole project, not just
 * inside this directory, which is why `validate()` reads the global projection.
 *
 * It also owns the world book's own fields: `keywords` (trigger words),
 * `always` (an entry that is always part of the current chapter's setting) and
 * `priority` (ordering among hits). The matching rule lives in `world-match.ts`,
 * the write-side invariants and tree shape in `world-plan.ts`, and the two
 * model-facing tools in `world-tools.ts` — each one testable on its own.
 */

import { basename, extname, join } from 'node:path'

import { boolField, intField, parseMarkdown, stringField } from '../frontmatter.js'
import { rowsBucket } from './types.js'
import type { DomainEntityRef, DomainFileParse, DomainModule, DomainScanResult, ValidationIssue } from './types.js'
import { joinTerms, keywordsOf, readText, rowsOf, worldCategoryOf } from './scan-helpers.js'
import { worldIssues } from './world-plan.js'
import { worldTools } from './world-tools.js'

export interface WorldRow {
  id: string
  path: string
  title: string
  category: string | undefined
  parent: string | undefined
  keywords: string[]
  always: boolean
  priority: number | undefined
}

interface ParsedWorld {
  row?: WorldRow
  issues: ValidationIssue[]
}

function parseWorld(path: string, text: string): ParsedWorld {
  if (extname(path).toLowerCase() !== '.md') return { issues: [] }

  const parsed = parseMarkdown(text)
  const issues: ValidationIssue[] = parsed.issues.map((issue) => ({ code: 'FRONTMATTER_ISSUE', path, detail: issue }))

  return {
    issues,
    row: {
      id: stringField(parsed.data, 'id') ?? path,
      path,
      title: stringField(parsed.data, 'title') ?? basename(path).replace(/\.md$/u, ''),
      // A file directly under `world/` has no category directory — see scan-helpers.
      category: stringField(parsed.data, 'category') ?? worldCategoryOf(path),
      parent: stringField(parsed.data, 'parent'),
      keywords: keywordsOf(parsed.data),
      // `boolField` reads a bare `true` only: a quoted "true" stays a string, so the
      // index never disagrees with the file about whether an entry is always on.
      always: boolField(parsed.data, 'always'),
      priority: intField(parsed.data, 'priority'),
    },
  }
}

function toEntity(row: WorldRow): DomainEntityRef {
  return {
    kind: 'world',
    id: row.id,
    path: row.path,
    title: row.title,
    category: row.category,
    parent: row.parent,
    // X-1 fixes the projection's column set: `always` / `priority` are world-book
    // fields and stay in `world_entries`, reachable through `listWorldEntries()`.
    keywords: row.keywords.length > 0 ? row.keywords : undefined,
  }
}

export const worldDomain: DomainModule = {
  kind: 'world',

  scan({ root, files }): DomainScanResult {
    const rows: WorldRow[] = []
    const issues: ValidationIssue[] = []
    for (const file of files) {
      const parsed = parseWorld(file.path, readText(join(root, file.path)))
      issues.push(...parsed.issues)
      if (parsed.row !== undefined) rows.push(parsed.row)
    }
    return { tables: [rowsBucket('world_entries', rows)], entities: rows.map(toEntity), issues }
  },

  parseFile({ path, text }): DomainFileParse {
    const parsed = parseWorld(path, text)
    const row = parsed.row
    return {
      path,
      rows: row === undefined ? [] : [rowsBucket('world_entries', [row])],
      entity: row === undefined ? undefined : toEntity(row),
      issues: parsed.issues,
    }
  },

  validate({ scan, entities }): ValidationIssue[] {
    // The rules themselves live in `world-plan.ts` so the write path applies the
    // identical set to its candidate (X-4) instead of a second copy.
    return worldIssues(rowsOf<WorldRow>(scan, 'world_entries'), new Set(entities.map((entity) => entity.id)))
  },

  schema() {
    return {
      ddl: [
        'CREATE TABLE world_entries (id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, category TEXT, parent TEXT, keywords TEXT, always INTEGER NOT NULL DEFAULT 0, priority INTEGER)',
        'CREATE INDEX ix_world_category ON world_entries(category)',
      ],
      insert(db, scan): void {
        const insert = db.prepare(
          'INSERT OR REPLACE INTO world_entries (id, path, title, category, parent, keywords, always, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        for (const row of rowsOf<WorldRow>(scan, 'world_entries')) {
          insert.run(
            row.id,
            row.path,
            row.title,
            row.category ?? null,
            row.parent ?? null,
            joinTerms(row.keywords) ?? null,
            row.always ? 1 : 0,
            row.priority ?? null,
          )
        }
      },
    }
  },

  tools(deps) {
    // The domain object is passed in rather than imported by `world-tools.ts`: the write
    // chain must judge with **this** module (`parseFile`/`validate`), and a module that
    // imports the registry that imports it would close a runtime cycle.
    return worldTools(deps, worldDomain)
  },
}
