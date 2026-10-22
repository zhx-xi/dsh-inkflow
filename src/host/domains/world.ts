/**
 * World domain (`world/<category>/`).
 *
 * Owns the world tree and I-08: one root or none (a "flat category book" that keeps
 * every entry under `world/<category>/` and never links them is valid), a child must
 * carry a category, and a `parent` must resolve — across the whole project, not just
 * inside this directory, which is why `validate()` reads the global projection.
 */

import { basename, extname, join } from 'node:path'

import { parseMarkdown, stringField } from '../frontmatter.js'
import { rowsBucket } from './types.js'
import type { DomainEntityRef, DomainFileParse, DomainModule, DomainScanResult, ValidationIssue } from './types.js'
import { keywordsOf, readText, rowsOf, worldCategoryOf } from './scan-helpers.js'

export interface WorldRow {
  id: string
  path: string
  title: string
  category: string | undefined
  parent: string | undefined
  keywords: string[]
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
    const issues: ValidationIssue[] = []
    const rows = rowsOf<WorldRow>(scan, 'world_entries')
    if (rows.length === 0) return issues

    const isFirstLevel = (relPath: string): boolean => relPath.split('/').length === 2
    const roots = rows.filter((row) => (row.parent === undefined || row.parent === '') && isFirstLevel(row.path))
    const claimsParent = rows.some((row) => row.parent !== undefined && row.parent !== '')

    if (roots.length > 1) {
      const shown = roots.slice(0, 3).map((row) => row.path).join(', ')
      issues.push({
        code: 'WORLD_ROOT_MULTIPLE',
        detail: `${String(roots.length)} world entries are roots (${shown}${roots.length > 3 ? ', …' : ''}); exactly one root is allowed`,
      })
    } else if (roots.length === 0 && claimsParent) {
      issues.push({
        code: 'WORLD_ROOT_MISSING',
        detail:
          'world entries claim parents but none is a root; either add one first-level entry without parent or drop the parents (flat category book)',
      })
    }

    // Cross-class on purpose: a world entry may point at a chapter or a character id.
    const known = new Set(entities.map((entity) => entity.id))
    for (const row of rows) {
      const hasParent = row.parent !== undefined && row.parent !== ''
      if (hasParent && (row.category === undefined || row.category === '')) {
        issues.push({
          code: 'WORLD_CATEGORY_REQUIRED',
          path: row.path,
          detail: 'a world entry with a parent must also carry a category (or live under world/<category>/)',
        })
      }
      if (hasParent && row.parent !== undefined && !known.has(row.parent)) {
        issues.push({ code: 'DANGLING_PARENT', path: row.path, detail: `parent "${row.parent}" not found` })
      }
    }
    return issues
  },

  schema() {
    return {
      ddl: [
        'CREATE TABLE world_entries (id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, category TEXT, parent TEXT)',
        'CREATE INDEX ix_world_category ON world_entries(category)',
      ],
      insert(db, scan): void {
        const insert = db.prepare(
          'INSERT OR REPLACE INTO world_entries (id, path, title, category, parent) VALUES (?, ?, ?, ?, ?)',
        )
        for (const row of rowsOf<WorldRow>(scan, 'world_entries')) {
          insert.run(row.id, row.path, row.title, row.category ?? null, row.parent ?? null)
        }
      },
    }
  },

  tools() {
    return []
  },
}
