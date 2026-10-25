/**
 * Relation domain (`relations/`) — issue #27, data-model §3.1/§3.3/§5 (I-08).
 *
 * Why relations get their own directory: an edge used to be a frontmatter field on
 * a character file, so the same fact lived in two places (the character's field and
 * whatever the panel derived from it) and neither was authoritative. One file per
 * edge makes the edge itself the truth, addressable by `relations/<slug>.md`.
 *
 * Three invariants live here, and each one is reported identically by a rebuild and
 * by the write path (X-4, the "double insurance" of data-model §5):
 *   `RELATION_ENDPOINT`   both ends resolve to exactly one entity of the whole book
 *                         — cross-class on purpose: an edge may join a character to
 *                         a world entry, a chapter or another relation
 *   `RELATION_SELF_LOOP`  an edge joins two different entities
 *   `RELATION_DUPLICATE`  one (source, target, kind) edge exists once
 *
 * One diagnostic is deliberately **rebuild-only** (`RELATION_FIELD_DEPRECATED`): a
 * character file that still carries its old relation fields is not broken — the
 * field is simply ignored now — and batch migration of existing books belongs to
 * the migration issues (#34/#36), not to a single write. The write path therefore
 * never sees it (see the `candidate` gate in `validate()`): a warning must never
 * block an edit.
 *
 * The tools live in `relation-tools.ts`: this file answers "what is an edge", that
 * one answers "how does a tool write one".
 */

import { readdirSync } from 'node:fs'
import { extname, join } from 'node:path'

import { parseMarkdown, stringField } from '../frontmatter.js'
import { RELATION_DIRECTIONS, RELATION_KINDS, relationConflicts } from './relation-write.js'
import type { RelationRow } from './relation-write.js'
import { relationTools } from './relation-tools.js'
import { rowsBucket } from './types.js'
import type { DomainEntityRef, DomainFileParse, DomainModule, DomainScanResult, ValidationIssue } from './types.js'
import { readText, rowsOf } from './scan-helpers.js'

export type { RelationDirection, RelationKind, RelationRow } from './relation-write.js'

/** Frontmatter keys a character file used to carry its relations in (all ignored now). */
const LEGACY_RELATION_FIELDS = ['relations', 'relationships', 'relation'] as const

interface ParsedRelation {
  row?: RelationRow
  issues: ValidationIssue[]
}

function readRelationKind(
  path: string,
  data: Readonly<Record<string, unknown>>,
  issues: ValidationIssue[],
): RelationRow['relationKind'] {
  const raw = stringField(data, 'kind')
  if (raw === undefined || raw.trim() === '') {
    // Degrade, don't drop: a rebuild must keep the row visible (like a bad chapter
    // status degrading to `draft`) so the author still sees the broken edge.
    issues.push({
      code: 'FRONTMATTER_ISSUE',
      path,
      detail: `relation files need kind: ${RELATION_KINDS.join(' | ')} (missing; read as character)`,
    })
    return 'character'
  }
  const kind = RELATION_KINDS.find((candidate) => candidate === raw.trim().toLowerCase())
  if (kind === undefined) {
    issues.push({
      code: 'FRONTMATTER_ISSUE',
      path,
      detail: `kind "${raw}" is not one of ${RELATION_KINDS.join(' | ')} (read as character)`,
    })
    return 'character'
  }
  return kind
}

function readDirection(
  path: string,
  data: Readonly<Record<string, unknown>>,
  issues: ValidationIssue[],
): RelationRow['direction'] {
  // `dir` is the field this domain writes; `direction` is read as well so a file
  // written from data-model §3.3's earlier wording still parses instead of quietly
  // losing its direction.
  const raw = stringField(data, 'dir') ?? stringField(data, 'direction')
  if (raw === undefined || raw.trim() === '') return 'directed'
  const direction = RELATION_DIRECTIONS.find((candidate) => candidate === raw.trim().toLowerCase())
  if (direction === undefined) {
    issues.push({
      code: 'FRONTMATTER_ISSUE',
      path,
      detail: `dir "${raw}" is not one of ${RELATION_DIRECTIONS.join(' | ')} (read as directed)`,
    })
    return 'directed'
  }
  return direction
}

function parseRelation(path: string, text: string): ParsedRelation {
  if (extname(path).toLowerCase() !== '.md') return { issues: [] }

  const parsed = parseMarkdown(text)
  const issues: ValidationIssue[] = parsed.issues.map((issue) => ({ code: 'FRONTMATTER_ISSUE', path, detail: issue }))
  const source = (stringField(parsed.data, 'source') ?? '').trim()
  const target = (stringField(parsed.data, 'target') ?? '').trim()

  return {
    issues,
    row: {
      id: stringField(parsed.data, 'id') ?? path,
      path,
      title: stringField(parsed.data, 'title') ?? `${source} → ${target}`,
      relationKind: readRelationKind(path, parsed.data, issues),
      source,
      target,
      direction: readDirection(path, parsed.data, issues),
      since: stringField(parsed.data, 'since'),
      until: stringField(parsed.data, 'until'),
      chapter: stringField(parsed.data, 'chapter'),
    },
  }
}

/**
 * The projection row of one edge.
 *
 * `title` is the readable `source → target` (or the file's own `title`), `parent` is
 * the tail so a tree can hang edges under their source, and `category` carries the
 * person/knowledge split — the column set is fixed by X-1, so `kind` cannot be added
 * there and `category` is the only slot a panel can group by.
 */
function toEntity(row: RelationRow): DomainEntityRef {
  return {
    kind: 'relations',
    id: row.id,
    path: row.path,
    title: row.title,
    category: row.relationKind,
    parent: row.source === '' ? undefined : row.source,
  }
}

/**
 * Rebuild-only deprecation pass over `characters/`.
 *
 * `scan()` only receives this directory's own files, so this reads the character
 * files itself — one `readdir` plus one small parse per character, and only on a
 * rebuild (never on a write, which has a `candidate`).
 */
function legacyRelationFieldIssues(root: string): ValidationIssue[] {
  let entries
  try {
    entries = readdirSync(join(root, 'characters'), { withFileTypes: true })
  } catch {
    return []
  }
  const issues: ValidationIssue[] = []
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.md') continue
    const path = `characters/${entry.name}`
    const parsed = parseMarkdown(readText(join(root, path)))
    const found = LEGACY_RELATION_FIELDS.filter((field) => parsed.data[field] !== undefined)
    if (found.length === 0) continue
    issues.push({
      code: 'RELATION_FIELD_DEPRECATED',
      path,
      detail: `carries ${found.map((field) => `"${field}"`).join(', ')}, which is no longer read: relations live in relations/<slug>.md (warning only; batch migration is tracked apart)`,
    })
  }
  return issues
}

export const relationDomain: DomainModule = {
  kind: 'relations',

  scan({ root, files }): DomainScanResult {
    const rows: RelationRow[] = []
    const issues: ValidationIssue[] = []
    for (const file of files) {
      const parsed = parseRelation(file.path, readText(join(root, file.path)))
      issues.push(...parsed.issues)
      if (parsed.row !== undefined) rows.push(parsed.row)
    }
    return { tables: [rowsBucket('relations', rows)], entities: rows.map(toEntity), issues }
  },

  parseFile({ path, text }): DomainFileParse {
    const parsed = parseRelation(path, text)
    const row = parsed.row
    return {
      path,
      rows: row === undefined ? [] : [rowsBucket('relations', [row])],
      entity: row === undefined ? undefined : toEntity(row),
      issues: parsed.issues,
    }
  },

  validate({ root, scan, entities, candidate }): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    const rows = rowsOf<RelationRow>(scan, 'relations')

    // "Exactly one": two kinds may legitimately share an id (X-1), and an edge that
    // pointed at such an id would be ambiguous rather than merely missing.
    const idCount = new Map<string, number>()
    for (const entity of entities) idCount.set(entity.id, (idCount.get(entity.id) ?? 0) + 1)

    const seenEdges = new Map<string, string>()
    for (const row of rows) {
      const ends: ReadonlyArray<readonly [string, string]> = [
        ['source', row.source],
        ['target', row.target],
      ]
      for (const [role, value] of ends) {
        if (value === '') {
          issues.push({
            code: 'RELATION_ENDPOINT',
            path: row.path,
            detail: `${role} is required: an edge names both of its ends`,
          })
          continue
        }
        const count = idCount.get(value) ?? 0
        if (count === 0) {
          issues.push({
            code: 'RELATION_ENDPOINT',
            path: row.path,
            detail: `${role} "${value}" does not resolve to an entity of this book`,
          })
        } else if (count > 1) {
          issues.push({
            code: 'RELATION_ENDPOINT',
            path: row.path,
            detail: `${role} "${value}" is ambiguous: ${String(count)} entities share that id`,
          })
        }
      }

      if (row.source !== '' && row.source === row.target) {
        issues.push({
          code: 'RELATION_SELF_LOOP',
          path: row.path,
          detail: `source and target are both "${row.source}" (dir: ${row.direction}); an edge joins two different entities`,
        })
      }

      if (row.source === '' || row.target === '') continue
      const key = `${row.source}\u0000${row.target}\u0000${row.relationKind}`
      const previous = seenEdges.get(key)
      if (previous === undefined) {
        seenEdges.set(key, row.path)
      } else {
        issues.push({
          code: 'RELATION_DUPLICATE',
          path: row.path,
          detail: `the edge ${row.source} → ${row.target} (${row.relationKind}) is already declared by ${previous}`,
        })
      }
    }

    // The knowledge graph's second invariant (#48): the same pair + kind claimed in
    // contradictory directions. Blocking on both nets — a write that would create one is
    // refused, and a rebuild reports the pair, so a hand-written pair of files is visible
    // instead of silently overriding each other.
    for (const conflict of relationConflicts(rows)) {
      issues.push({ code: conflict.code, path: conflict.path, detail: conflict.detail })
    }

    // Write path: only blocking issues belong here (types.ts `DomainValidateInput`).
    if (candidate === undefined) issues.push(...legacyRelationFieldIssues(root))
    return issues
  },

  schema() {
    return {
      ddl: [
        'CREATE TABLE relations (id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, relation_kind TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, direction TEXT NOT NULL, since TEXT, until TEXT, chapter TEXT)',
        'CREATE INDEX ix_relations_source ON relations(source)',
        'CREATE INDEX ix_relations_target ON relations(target)',
        'CREATE INDEX ix_relations_edge ON relations(source, target, relation_kind)',
      ],
      insert(db, scan): void {
        const insert = db.prepare(
          'INSERT OR REPLACE INTO relations (id, path, title, relation_kind, source, target, direction, since, until, chapter) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        for (const row of rowsOf<RelationRow>(scan, 'relations')) {
          insert.run(
            row.id,
            row.path,
            row.title,
            row.relationKind,
            row.source,
            row.target,
            row.direction,
            row.since ?? null,
            row.until ?? null,
            row.chapter ?? null,
          )
        }
      },
    }
  },

  tools(deps) {
    return relationTools(relationDomain, deps)
  },
}
