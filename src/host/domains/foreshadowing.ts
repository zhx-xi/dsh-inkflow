/**
 * Foreshadowing domain (`foreshadowing/`) — issue #31.
 *
 * Owns the state machine and the computed lateness of data-model §3.2: the
 * `foreshadowings` table, the reminder that goes into the writing context, and the two
 * model-facing tools.
 *
 * The rules and the parsers live in `foreshadowing-plan.ts` (pure) so the write path
 * applies the identical set to its candidate (X-4) instead of a second copy; the tools
 * live in `foreshadowing-tools.ts`, and the index/board reads plus the one
 * writing-context segment live in `foreshadowing-query.ts`. That split is not cosmetic:
 * `writing-context.ts` imports the segment, so the segment cannot live in *this* file —
 * reaching the registry through `writing-context` would evaluate it while
 * `foreshadowingDomain` is still undefined (`DOMAIN_MODULES` would hold `undefined`).
 * This module is only the seam: scan what the walk found, publish the projection row,
 * declare the table, hand the tools on.
 *
 * Before this module existed, `foreshadowing/` got nothing but the generic frontmatter
 * pass; the entries produced no `entities` rows and no table, so "what is still open"
 * was unanswerable by anything but a full file read.
 */

import { extname, join } from 'node:path'

import { rowsBucket } from './types.js'
import type { DomainFileParse, DomainModule, DomainScanResult, ValidationIssue } from './types.js'
import { joinTerms, readText, rowsOf } from './scan-helpers.js'
import {
  FORESHADOW_TABLE,
  foreshadowEntity,
  foreshadowValidate,
  parseForeshadowFile,
} from './foreshadowing-plan.js'
import type { ForeshadowRow } from './foreshadowing-plan.js'
import { foreshadowTools } from './foreshadowing-tools.js'

export { FORESHADOW_TABLE } from './foreshadowing-plan.js'
export type { ForeshadowRow, ForeshadowStatus } from './foreshadowing-plan.js'

export const foreshadowingDomain: DomainModule = {
  kind: 'foreshadowing',

  scan({ root, files }): DomainScanResult {
    const rows: ForeshadowRow[] = []
    const issues: ValidationIssue[] = []
    for (const file of files) {
      // Only Markdown is a foreshadow; anything else is an attachment the author put
      // in the directory (I-07 is about chapters and does not apply here).
      if (extname(file.path).toLowerCase() !== '.md') continue
      const parsed = parseForeshadowFile(file.path, readText(join(root, file.path)))
      issues.push(...parsed.issues)
      if (parsed.row !== undefined) rows.push(parsed.row)
    }
    return { tables: [rowsBucket(FORESHADOW_TABLE, rows)], entities: rows.map(foreshadowEntity), issues }
  },

  parseFile({ path, text }): DomainFileParse {
    // The same function the write path calls (`foreshadowing-tools.ts`), so scan and
    // candidate can never disagree about what a file means.
    const parsed = parseForeshadowFile(path, text)
    return {
      path,
      rows: parsed.row === undefined ? [] : [rowsBucket(FORESHADOW_TABLE, [parsed.row])],
      ...(parsed.row === undefined ? {} : { entity: foreshadowEntity(parsed.row) }),
      issues: parsed.issues,
    }
  },

  validate({ scan, candidate }): ValidationIssue[] {
    // Both nets run the same judge: nothing here is a rebuild-only opinion.
    return foreshadowValidate(rowsOf<ForeshadowRow>(scan, FORESHADOW_TABLE), candidate?.path)
  },

  schema() {
    return {
      ddl: [
        // `status` holds the FILE value; `overdue` is computed at read time from the
        // chapter being asked about (data-model §3.2.2), so it must not be a column —
        // a stored mark would go stale the day the book moves on.
        `CREATE TABLE ${FORESHADOW_TABLE} (id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, planted_at TEXT, advanced_at TEXT, due_by TEXT, resolved_chapter TEXT, linked_entities TEXT)`,
        `CREATE INDEX ix_foreshadowings_status ON ${FORESHADOW_TABLE}(status)`,
        `CREATE INDEX ix_foreshadowings_due ON ${FORESHADOW_TABLE}(due_by)`,
      ],
      insert(db, scan): void {
        const insert = db.prepare(
          `INSERT OR REPLACE INTO ${FORESHADOW_TABLE} (id, path, title, status, planted_at, advanced_at, due_by, resolved_chapter, linked_entities) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const row of rowsOf<ForeshadowRow>(scan, FORESHADOW_TABLE)) {
          insert.run(
            row.id,
            row.path,
            row.title,
            row.status,
            row.plantedAt ?? null,
            joinTerms(row.advancedAt) ?? null,
            row.dueBy ?? null,
            row.resolvedChapter ?? null,
            joinTerms(row.linkedEntities) ?? null,
          )
        }
      },
    }
  },

  tools(deps) {
    return foreshadowTools(deps)
  },
}
