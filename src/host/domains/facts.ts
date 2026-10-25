/**
 * Fact ledger domain (`facts/`).
 *
 * Owns the ledger table, the interval rule and the findings a rebuild must report
 * (data-model §3.5, §5 I-22 / I-23, [ADR-0013](../../../.agents/adrs/0013-facts-ledger-line-format.md)):
 * `FACT_LINE_MALFORMED` (warning, line-anchored) and `FACT_CONFLICT`.
 *
 * Before this module `facts/` was one of the two content directories with no owner: the
 * index only ran the generic frontmatter pass over it, so a ledger produced no entity, no
 * row and no cross-chapter answer. It now publishes one entity per ledger **file** (id = the
 * file path; the subject is a reference to another entity, data-model §4.1) and the rows the
 * snapshot is built from.
 *
 * The format and the rules live in `facts-line.ts` (parse/render pair) and `facts-plan.ts`
 * (file parse, interval judgement, snapshot) so the write path applies the identical set to
 * its candidate (X-4) instead of a second copy. The three model-facing tools live in
 * `facts-tools.ts`, the writing-context segment in `facts-prompt.ts`. This module is only
 * the seam: scan what the walk found, publish the projection row, declare the table, hand
 * the tools on.
 */

import { extname, join } from 'node:path'

import { rowsBucket } from './types.js'
import type { DomainFileParse, DomainEntityRef, DomainModule, DomainScanResult, ValidationIssue } from './types.js'
import { readText, rowsOf } from './scan-helpers.js'
import {
  FACTS_TABLE,
  chapterSeqFrom,
  factsEntity,
  factsFileParse,
  factsValidate,
  parseFactsFile,
} from './facts-plan.js'
import type { FactRow } from './facts-plan.js'
import { factsTools } from './facts-tools.js'

export { FACTS_TABLE } from './facts-plan.js'
export type { FactRow } from './facts-plan.js'

export const factsDomain: DomainModule = {
  kind: 'facts',

  scan({ root, files }): DomainScanResult {
    const rows: FactRow[] = []
    const entities: DomainEntityRef[] = []
    const issues: ValidationIssue[] = []
    for (const file of files) {
      // The directory is for ledgers; a stray name is skipped silently (the same policy
      // `timeline.ts` and `world.ts` apply to their own directories).
      if (extname(file.path).toLowerCase() !== '.md') continue
      const parsed = parseFactsFile(file.path, readText(join(root, file.path)))
      rows.push(...parsed.rows)
      entities.push(factsEntity(parsed, file.path))
      issues.push(...parsed.issues)
    }
    return { tables: [rowsBucket(FACTS_TABLE, rows)], entities, issues }
  },

  parseFile({ path, text }): DomainFileParse {
    // Same function the append tool calls, so scan and candidate cannot disagree about
    // what a ledger means.
    return factsFileParse(path, text)
  },

  validate({ scan, entities, candidate }): ValidationIssue[] {
    // Both nets run the same judge: the rebuild reports every conflict, the write gate only
    // the ones touching the candidate. Chapter order comes from the projection, which is
    // already post-write on the write path.
    return factsValidate(rowsOf<FactRow>(scan, FACTS_TABLE), chapterSeqFrom(entities), candidate)
  },

  schema() {
    return {
      ddl: [
        // `id` is `path#L<line>`: one file holds many facts, and `scanProject` de-duplicates
        // a table by `id ?? path`, so a row without its own id would collapse the ledger to
        // one row per file. `line` is kept beside it because it is the address findings use.
        `CREATE TABLE ${FACTS_TABLE} (id TEXT PRIMARY KEY, path TEXT NOT NULL, line INTEGER NOT NULL, subject TEXT NOT NULL, attribute TEXT NOT NULL, value TEXT NOT NULL, since TEXT, until TEXT, chapter TEXT, source TEXT NOT NULL)`,
        `CREATE INDEX ix_facts_subject ON ${FACTS_TABLE}(subject, attribute)`,
        `CREATE INDEX ix_facts_chapter ON ${FACTS_TABLE}(chapter)`,
      ],
      insert(db, scan): void {
        const insert = db.prepare(
          `INSERT OR REPLACE INTO ${FACTS_TABLE} (id, path, line, subject, attribute, value, since, until, chapter, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const row of rowsOf<FactRow>(scan, FACTS_TABLE)) {
          // Unknown keys stay in the file: they are not fields, and the index is a cache of
          // the fields the queries need (same policy as unknown frontmatter keys).
          insert.run(
            row.id,
            row.path,
            row.line,
            row.subject,
            row.attribute,
            row.value,
            row.since ?? null,
            row.until ?? null,
            row.chapter ?? null,
            row.source,
          )
        }
      },
    }
  },

  tools(deps) {
    return factsTools(deps)
  },
}
