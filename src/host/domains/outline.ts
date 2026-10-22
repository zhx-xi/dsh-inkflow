/**
 * Outline domain (`outlines/`).
 *
 * Owns the three-level tree and I-01/I-02/I-05: exactly one `overall`, a volume hangs
 * under it, a volume never nests under a volume, and no node points at a missing
 * parent. The kind may be declared or inferred from the file name — a file whose kind
 * cannot be determined is reported instead of guessed.
 */

import { basename, extname, join } from 'node:path'

import { OUTLINE_KINDS } from '../conventions.js'
import { intField, parseMarkdown, stringField } from '../frontmatter.js'
import { rowsBucket } from './types.js'
import type { DomainEntityRef, DomainFileParse, DomainModule, DomainScanResult, ValidationIssue } from './types.js'
import { inferOutlineKind, readText, rowsOf } from './scan-helpers.js'

export interface OutlineRow {
  id: string
  path: string
  kind: string
  title: string
  parent: string | undefined
  order: number | undefined
}

interface ParsedOutline {
  row?: OutlineRow
  issues: ValidationIssue[]
}

function parseOutline(path: string, text: string): ParsedOutline {
  if (extname(path).toLowerCase() !== '.md') return { issues: [] }

  const parsed = parseMarkdown(text)
  const issues: ValidationIssue[] = parsed.issues.map((issue) => ({ code: 'FRONTMATTER_ISSUE', path, detail: issue }))

  const declared = stringField(parsed.data, 'kind')
  const kind = (OUTLINE_KINDS as readonly string[]).includes(declared ?? '')
    ? (declared as string)
    : inferOutlineKind(path)
  if (kind === undefined) {
    issues.push({
      code: 'OUTLINE_KIND_UNKNOWN',
      path,
      detail: 'cannot infer kind; declare kind: overall|volume|chapter',
    })
    return { issues }
  }

  return {
    issues,
    row: {
      id: stringField(parsed.data, 'id') ?? path,
      path,
      kind,
      title: stringField(parsed.data, 'title') ?? basename(path).replace(/\.md$/u, ''),
      parent: stringField(parsed.data, 'parent'),
      order: intField(parsed.data, 'order'),
    },
  }
}

function toEntity(row: OutlineRow): DomainEntityRef {
  return {
    kind: 'outlines',
    id: row.id,
    path: row.path,
    title: row.title,
    parent: row.parent,
    orderIndex: row.order,
  }
}

export const outlineDomain: DomainModule = {
  kind: 'outlines',

  scan({ root, files }): DomainScanResult {
    const rows: OutlineRow[] = []
    const issues: ValidationIssue[] = []
    for (const file of files) {
      const parsed = parseOutline(file.path, readText(join(root, file.path)))
      issues.push(...parsed.issues)
      if (parsed.row !== undefined) rows.push(parsed.row)
    }
    return { tables: [rowsBucket('outline_nodes', rows)], entities: rows.map(toEntity), issues }
  },

  parseFile({ path, text }): DomainFileParse {
    const parsed = parseOutline(path, text)
    const row = parsed.row
    return {
      path,
      rows: row === undefined ? [] : [rowsBucket('outline_nodes', [row])],
      entity: row === undefined ? undefined : toEntity(row),
      issues: parsed.issues,
    }
  },

  validate({ scan }): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    const nodes = rowsOf<OutlineRow>(scan, 'outline_nodes')

    const overall = nodes.filter((node) => node.kind === 'overall')
    if (overall.length === 0) {
      issues.push({ code: 'OUTLINE_NO_OVERALL', detail: 'project must have exactly one outlines/overall.md' })
    } else if (overall.length > 1) {
      issues.push({ code: 'OUTLINE_MULTIPLE_OVERALL', detail: `${String(overall.length)} overall outlines found` })
    }
    const overallId = overall[0]?.id
    const byId = new Map(nodes.map((node) => [node.id, node]))

    for (const node of nodes) {
      if (node.kind === 'volume' && (node.parent === undefined || overallId === undefined || node.parent !== overallId)) {
        issues.push({
          code: 'OUTLINE_VOLUME_PARENT',
          path: node.path,
          detail: 'volume outline must have parent = overall outline id',
        })
      }
      if (node.parent === undefined) continue
      const parent = byId.get(node.parent)
      if (parent === undefined) {
        issues.push({ code: 'DANGLING_PARENT', path: node.path, detail: `parent "${node.parent}" not found` })
      } else if (node.kind === 'volume' && parent.kind === 'volume') {
        issues.push({ code: 'OUTLINE_VOLUME_IN_VOLUME', path: node.path, detail: 'volume outline cannot nest under a volume' })
      }
      // chapter-under-volume is allowed; chapter-under-chapter is not part of the
      // three-level model but is not reported here — the writer refuses it (I-02).
    }
    return issues
  },

  schema() {
    return {
      ddl: [
        'CREATE TABLE outline_nodes (id TEXT PRIMARY KEY, path TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, parent TEXT, order_index INTEGER)',
        'CREATE INDEX ix_outline_kind ON outline_nodes(kind)',
      ],
      insert(db, scan): void {
        const insert = db.prepare(
          'INSERT OR REPLACE INTO outline_nodes (id, path, kind, title, parent, order_index) VALUES (?, ?, ?, ?, ?, ?)',
        )
        for (const row of rowsOf<OutlineRow>(scan, 'outline_nodes')) {
          insert.run(row.id, row.path, row.kind, row.title, row.parent ?? null, row.order ?? null)
        }
      },
    }
  },

  tools() {
    return []
  },
}
