/**
 * Outline domain (`outlines/`).
 *
 * Owns the three-level tree and I-01/I-02/I-05: exactly one `overall`, a volume hangs
 * under it, a volume never nests under a volume, and no node points at a missing
 * parent. The kind may be declared or inferred from the file name — a file whose kind
 * cannot be determined is reported instead of guessed.
 *
 * Where the logic lives, and why: parsing, plot-point reading, the tree and the
 * invariants are in `./outline-model.ts`, and the pre-write planner is in
 * `./outline-write.ts`. Both are pure, and both are used by this module *and* by
 * `./outline-tools.ts`. That split is what lets the write path run the same validation
 * as a rebuild (X-4) without a domain importing the registry that imports it.
 */

import { join } from 'node:path'

import { outlineEntity, parseOutlineDocument, validateOutlineScan } from './outline-model.js'
import type { OutlineRow } from './outline-model.js'
import { buildOutlineTools } from './outline-tools.js'
import { rowsBucket } from './types.js'
import type { DomainFileParse, DomainModule, DomainScanResult, ValidationIssue } from './types.js'
import { readText, rowsOf } from './scan-helpers.js'

export type { OutlinePlotPoint, OutlineRow } from './outline-model.js'

export const outlineDomain: DomainModule = {
  kind: 'outlines',

  scan({ root, files }): DomainScanResult {
    const rows: OutlineRow[] = []
    const issues: ValidationIssue[] = []
    for (const file of files) {
      const parsed = parseOutlineDocument(file.path, readText(join(root, file.path)))
      issues.push(...parsed.issues)
      if (parsed.row !== undefined) rows.push(parsed.row)
    }
    return { tables: [rowsBucket('outline_nodes', rows)], entities: rows.map(outlineEntity), issues }
  },

  parseFile({ path, text }): DomainFileParse {
    const parsed = parseOutlineDocument(path, text)
    const row = parsed.row
    return {
      path,
      rows: row === undefined ? [] : [rowsBucket('outline_nodes', [row])],
      entity: row === undefined ? undefined : outlineEntity(row),
      issues: parsed.issues,
    }
  },

  /**
   * I-01/I-02/I-05 over the rows.
   *
   * With `candidate` set (the write path) the same function reports only what blocks
   * *that* write: findings about other files are already-known history and would make
   * every edit in a damaged book impossible, while the path-less findings (the `overall`
   * count) always apply — a volume added to a book without an overall is exactly the
   * state I-01 forbids.
   */
  validate({ scan, candidate }): ValidationIssue[] {
    return validateOutlineScan(scan, candidate)
  },

  schema() {
    return {
      // v3 (#24): `plot_point_count` / `plot_points` carry the body's list items so the
      // tree can be read without re-parsing prose for every query. `plot_points` is the
      // JSON form of the parsed points (`[{text, arc?}]`); the file stays the truth, so a
      // syntax change is a re-index and never a migration (ADR-0005).
      ddl: [
        'CREATE TABLE outline_nodes (id TEXT PRIMARY KEY, path TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, parent TEXT, order_index INTEGER, plot_point_count INTEGER NOT NULL DEFAULT 0, plot_points TEXT)',
        'CREATE INDEX ix_outline_kind ON outline_nodes(kind)',
      ],
      insert(db, scan): void {
        const insert = db.prepare(
          'INSERT OR REPLACE INTO outline_nodes (id, path, kind, title, parent, order_index, plot_point_count, plot_points) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        for (const row of rowsOf<OutlineRow>(scan, 'outline_nodes')) {
          insert.run(
            row.id,
            row.path,
            row.kind,
            row.title,
            row.parent ?? null,
            row.order ?? null,
            row.plotPointCount,
            JSON.stringify(row.plotPoints),
          )
        }
      },
    }
  },

  tools() {
    return buildOutlineTools()
  },
}
