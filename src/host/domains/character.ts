/**
 * Character domain (`characters/`).
 *
 * Owns the character table and the project-wide name uniqueness rule (I-03). The
 * normalisation used here is the shared `naming.ts` one — a second implementation
 * would let the write path and the rebuild disagree about a collision.
 */

import { basename, extname, join } from 'node:path'

import { parseMarkdown, stringField } from '../frontmatter.js'
import { nameKey } from './naming.js'
import { rowsBucket } from './types.js'
import type { DomainEntityRef, DomainFileParse, DomainModule, DomainScanResult, ValidationIssue } from './types.js'
import { aliasesOf, keywordsOf, readText, rowsOf } from './scan-helpers.js'

export interface CharacterRow {
  id: string
  path: string
  name: string
  key: string
  group: string | undefined
  role: string | undefined
  aliases: string[]
  keywords: string[]
}

interface ParsedCharacter {
  row?: CharacterRow
  issues: ValidationIssue[]
}

function parseCharacter(path: string, text: string): ParsedCharacter {
  if (extname(path).toLowerCase() !== '.md') return { issues: [] }

  const parsed = parseMarkdown(text)
  const issues: ValidationIssue[] = parsed.issues.map((issue) => ({ code: 'FRONTMATTER_ISSUE', path, detail: issue }))
  const name = stringField(parsed.data, 'name') ?? basename(path).replace(/\.md$/u, '')

  return {
    issues,
    row: {
      id: stringField(parsed.data, 'id') ?? path,
      path,
      name,
      key: nameKey(name),
      group: stringField(parsed.data, 'group'),
      role: stringField(parsed.data, 'role'),
      aliases: aliasesOf(parsed.data),
      keywords: keywordsOf(parsed.data),
    },
  }
}

function toEntity(row: CharacterRow): DomainEntityRef {
  return {
    kind: 'characters',
    id: row.id,
    path: row.path,
    title: row.name,
    nameKey: row.key,
    keywords: row.keywords.length > 0 ? row.keywords : undefined,
    aliases: row.aliases.length > 0 ? row.aliases : undefined,
  }
}

export const characterDomain: DomainModule = {
  kind: 'characters',

  scan({ root, files }): DomainScanResult {
    const rows: CharacterRow[] = []
    const issues: ValidationIssue[] = []
    for (const file of files) {
      const parsed = parseCharacter(file.path, readText(join(root, file.path)))
      issues.push(...parsed.issues)
      if (parsed.row !== undefined) rows.push(parsed.row)
    }
    return { tables: [rowsBucket('characters', rows)], entities: rows.map(toEntity), issues }
  },

  parseFile({ path, text }): DomainFileParse {
    const parsed = parseCharacter(path, text)
    const row = parsed.row
    return {
      path,
      rows: row === undefined ? [] : [rowsBucket('characters', [row])],
      entity: row === undefined ? undefined : toEntity(row),
      issues: parsed.issues,
    }
  },

  /**
   * I-03: one name (normalised) per project, aliases included — an alias that is
   * another character's name makes every mention ambiguous, so it is the same
   * collision. First file in walk order wins; later ones are reported and dropped
   * by the cross-class de-duplication in `indexer.ts`.
   */
  validate({ scan }): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    const seen = new Map<string, string>()
    for (const row of rowsOf<CharacterRow>(scan, 'characters')) {
      for (const term of [row.key, ...row.aliases.map((alias) => nameKey(alias))]) {
        if (term === '') continue
        const previous = seen.get(term)
        if (previous !== undefined && previous !== row.path) {
          issues.push({
            code: 'CHARACTER_NAME_DUPLICATE',
            path: row.path,
            detail: `name "${term}" already used by ${previous}`,
          })
        } else {
          seen.set(term, row.path)
        }
      }
    }
    return issues
  },

  schema() {
    return {
      ddl: [
        'CREATE TABLE characters (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL, group_name TEXT, role TEXT)',
        'CREATE INDEX ix_characters_name ON characters(name_key)',
      ],
      insert(db, scan): void {
        const insert = db.prepare(
          'INSERT OR REPLACE INTO characters (id, path, name, name_key, group_name, role) VALUES (?, ?, ?, ?, ?, ?)',
        )
        for (const row of rowsOf<CharacterRow>(scan, 'characters')) {
          insert.run(row.id, row.path, row.name, row.key, row.group ?? null, row.role ?? null)
        }
      },
    }
  },

  tools() {
    return []
  },
}
