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

import { readBookCalendar } from '../calendar-book.js'
import { ROOT_META_FILE } from '../conventions.js'
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

/**
 * The book's calendar, or the one issue that explains why there is none.
 *
 * A broken table must not stop the rebuild — the index is a cache and the rest of the
 * book is still perfectly readable — but it must not fall back to the default either, so
 * the rows simply carry no absolute day and the cause is named once, against
 * `inkflow.json` where the mistake actually is. Per-event `TIMELINE_TIME_INVALID` findings
 * follow from that (no date can be placed), which is the honest answer rather than noise.
 */
function bookCalendarOf(root: string): { spec?: import('../calendar.js').CalendarSpec; issues: ValidationIssue[] } {
  const calendar = readBookCalendar(root)
  if (calendar.ok) return { spec: calendar.value.spec, issues: [] }
  return {
    issues: [
      {
        code: 'TIMELINE_TIME_INVALID',
        path: ROOT_META_FILE,
        detail:
          `the book's calendar cannot be read (${calendar.error.code}: ${calendar.error.message}); ` +
          'no worldTime is placed on the world axis until it is fixed',
      },
    ],
  }
}

export const timelineDomain: DomainModule = {
  kind: 'timeline',

  scan({ root, files }): DomainScanResult {
    const rows: TimelineRow[] = []
    const calendar = bookCalendarOf(root)
    const issues: ValidationIssue[] = [...calendar.issues]
    for (const file of files) {
      const parsed = parseTimelineFile(file.path, readText(join(root, file.path)), calendar.spec)
      issues.push(...parsed.issues)
      if (parsed.row !== undefined) rows.push(parsed.row)
    }
    return { tables: [rowsBucket(TIMELINE_TABLE, rows)], entities: rows.map(timelineEntity), issues }
  },

  parseFile({ root, path, text }): DomainFileParse {
    // Same function the write path calls (`timeline-tools.ts`), so scan and candidate
    // can never disagree about what a file means — including which calendar read the date.
    return timelineFileParse(path, text, bookCalendarOf(root).spec)
  },

  validate({ scan, candidate }): ValidationIssue[] {
    // Both nets run the same judge: nothing here is a rebuild-only opinion.
    return timelineValidate(rowsOf<TimelineRow>(scan, TIMELINE_TABLE), candidate?.path)
  },

  schema() {
    return {
      ddl: [
        // `world_time` keeps the author's own text; the comparable form is the derived
        // `world_absolute_day` (ADR-0025 D3: derived column, never written back to the
        // file). Storing it — instead of recomputing per read — is what lets a cross-era
        // sort be one integer comparison, and what makes "the index and `toAbsolute()`
        // agree" a testable claim rather than a hope.
        //
        // `world_era` is the era the row's date is written in, resolved at parse time
        // (`era:` in the file, else the calendar's last era). It is not derivable from
        // the number alone without the table, and a reader holding a row should not need
        // the table to say *how* the event is dated.
        `CREATE TABLE ${TIMELINE_TABLE} (id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, world_time TEXT, world_era TEXT, world_absolute_day INTEGER, narrative_order INTEGER, chapter TEXT, participants TEXT, status TEXT NOT NULL)`,
        `CREATE INDEX ix_timeline_chapter ON ${TIMELINE_TABLE}(chapter)`,
        `CREATE INDEX ix_timeline_narrative ON ${TIMELINE_TABLE}(narrative_order)`,
        `CREATE INDEX ix_timeline_absolute ON ${TIMELINE_TABLE}(world_absolute_day)`,
      ],
      insert(db, scan): void {
        const insert = db.prepare(
          `INSERT OR REPLACE INTO ${TIMELINE_TABLE} (id, path, title, world_time, world_era, world_absolute_day, narrative_order, chapter, participants, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        for (const row of rowsOf<TimelineRow>(scan, TIMELINE_TABLE)) {
          insert.run(
            row.id,
            row.path,
            row.title,
            row.worldTime ?? null,
            row.worldEra ?? null,
            row.worldAbsoluteDay ?? null,
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
