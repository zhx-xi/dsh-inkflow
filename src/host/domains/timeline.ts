/**
 * Timeline domain (`timeline/`) — issue #28.
 *
 * Owns the event table, the two ordering axes and the conflict rules of data-model
 * §3.4: world time, narrative order, the pending area (`status: unconfirmed`), and the
 * findings a rebuild must report — `TIMELINE_TIME_MISSING`, `TIMELINE_TIME_INVALID`,
 * `TIMELINE_ORDER_CONFLICT`, `TIMELINE_WORLD_TIME_REVERSED`.
 *
 * The rules and the parsers live in `timeline-plan.ts` (pure) so the write path applies
 * the identical set to its candidate (X-4) instead of a second copy, and the two
 * model-facing tools live in `timeline-tools.ts`. This module is only the seam: scan
 * what the walk found, publish the projection row, declare the table, hand the tools on.
 */

import { join } from 'node:path'

import { rowsBucket } from './types.js'
import type { DomainFileParse, DomainModule, DomainScanResult, ValidationIssue } from './types.js'
import { readText, rowsOf } from './scan-helpers.js'
import {
  TIMELINE_TABLE,
  parseTimelineFile,
  timelineEntity,
  timelineFileParse,
  timelineValidate,
} from './timeline-plan.js'
import type { TimelineRow } from './timeline-plan.js'
import { timelineTools } from './timeline-tools.js'

export { TIMELINE_TABLE } from './timeline-plan.js'
export type { TimelineRow } from './timeline-plan.js'

/**
 * Participants are stored space-joined, the same shape `entities.aliases` uses, so a
 * reader never has to parse a JSON column and `PARTICIPANT_INVALID` keeps the join
 * reversible (a participant id never contains a space).
 */
function joinParticipants(participants: readonly string[] | undefined): string | null {
  const terms = (participants ?? []).map((value) => value.trim()).filter((value) => value !== '')
  return terms.length === 0 ? null : terms.join(' ')
}

export const timelineDomain: DomainModule = {
  kind: 'timeline',

  scan({ root, files }): DomainScanResult {
    const rows: TimelineRow[] = []
    const issues: ValidationIssue[] = []
    for (const file of files) {
      const parsed = parseTimelineFile(file.path, readText(join(root, file.path)))
      issues.push(...parsed.issues)
      if (parsed.row !== undefined) rows.push(parsed.row)
    }
    return { tables: [rowsBucket(TIMELINE_TABLE, rows)], entities: rows.map(timelineEntity), issues }
  },

  parseFile({ path, text }): DomainFileParse {
    // Same function the write path calls (`timeline-tools.ts`), so scan and candidate
    // can never disagree about what a file means.
    return timelineFileParse(path, text)
  },

  validate({ scan, candidate }): ValidationIssue[] {
    // Both nets run the same judge: nothing here is a rebuild-only opinion.
    return timelineValidate(rowsOf<TimelineRow>(scan, TIMELINE_TABLE), candidate?.path)
  },

  schema() {
    return {
      ddl: [
        // `world_time` keeps the author's own text; the comparable form is derived
        // (`parseWorldTime`) rather than stored, so a schema change cannot make the
        // index disagree with the file about when an event happened.
        `CREATE TABLE ${TIMELINE_TABLE} (id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, world_time TEXT, narrative_order INTEGER, chapter TEXT, participants TEXT, status TEXT NOT NULL)`,
        `CREATE INDEX ix_timeline_chapter ON ${TIMELINE_TABLE}(chapter)`,
        `CREATE INDEX ix_timeline_narrative ON ${TIMELINE_TABLE}(narrative_order)`,
      ],
      insert(db, scan): void {
        const insert = db.prepare(
          `INSERT OR REPLACE INTO ${TIMELINE_TABLE} (id, path, title, world_time, narrative_order, chapter, participants, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const row of rowsOf<TimelineRow>(scan, TIMELINE_TABLE)) {
          insert.run(
            row.id,
            row.path,
            row.title,
            row.worldTime ?? null,
            row.narrativeOrder ?? null,
            row.chapter ?? null,
            joinParticipants(row.participants),
            row.status,
          )
        }
      },
    }
  },

  tools(deps) {
    return timelineTools(deps)
  },
}
