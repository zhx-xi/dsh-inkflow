/**
 * The book's calendar, as a file (issue #48 / roadmap X-28).
 *
 * `calendar.ts` owns the arithmetic and is deliberately free of disk and clock. This
 * module owns the other half: where the table lives and what a *missing* or *broken*
 * one means.
 *
 * WHY IT IS PERSISTED IN `inkflow.json`: a calendar is a property of the book, not of
 * the plugin and not of the machine — two clones of the same repository must read the
 * same dates, and a user setting in `$DSH_HOME` would silently re-interpret every
 * `worldTime` on the second machine. It is also *not* allowed to be a second truth
 * beside the content files: it is a table that explains them, so `inkflow.json` (which
 * already carries the book's identity) is where it belongs.
 *
 * WHY A BROKEN TABLE IS AN ERROR AND NOT A DEFAULT: falling back to `DEFAULT_CALENDAR`
 * would make every date in the book mean something slightly different, and nothing
 * would report it — a leap rule that is off by one month only shows up as "this event
 * is 28 days later than it should be" in a report nobody can reproduce. So a table that
 * is *present* must validate, and the caller gets a structured refusal it can print.
 *
 * WHY `defaultEra` IS THE **LAST** ERA: `timeline/*.md` keeps `worldTime` a flat scalar
 * (ADR-0025 D3), so a bare `0500-03-01` has to be read in *some* era. The eras ascend,
 * so the last one is the era the book is currently in — which is what a writer means by
 * a bare year. An event set in an older era names it (`era: <id>`, data-model §3.4); the
 * default never applies to a date the author marked otherwise.
 */

import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import {
  DEFAULT_CALENDAR,
  validateCalendarSpec,
} from './calendar.js'
import type { CalendarError, CalendarErrorCode, CalendarResult, CalendarSpec, EraSpec } from './calendar.js'
import { ROOT_META_FILE } from './conventions.js'

/** The key inside `inkflow.json` that holds the table (data-model §2). */
export const BOOK_CALENDAR_KEY = 'calendar'

export interface BookCalendar {
  readonly spec: CalendarSpec
  /** `book` when `inkflow.json` carries one; `default` when the book never set one. */
  readonly source: 'book' | 'default'
}

function ok<T>(value: T): CalendarResult<T> {
  return { ok: true, value }
}

function fail(code: CalendarErrorCode, message: string): CalendarResult<never> {
  return { ok: false, error: { code, message } }
}

/** `inkflow.json` as a plain object, BOM stripped (AGENTS.md §8 trap 4). */
function readMetaRecord(root: string): CalendarResult<Record<string, unknown>> {
  let raw: string
  try {
    raw = readFileSync(join(root, ROOT_META_FILE), 'utf8').replace(/^\uFEFF/u, '')
  } catch {
    return fail('CALENDAR_INVALID_SPEC', `${ROOT_META_FILE} is missing, so the book has no calendar to read`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fail('CALENDAR_INVALID_SPEC', `${ROOT_META_FILE} is not valid JSON, so the book's calendar cannot be read`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('CALENDAR_INVALID_SPEC', `${ROOT_META_FILE} must be a JSON object`)
  }
  return ok(parsed as Record<string, unknown>)
}

/**
 * The calendar this book reads its dates in.
 *
 * Three outcomes, and the middle one is the point: absent → the default table (a book
 * that never thought about calendars keeps working), present → it must validate, and a
 * malformed one is *named*, never replaced.
 */
export function readBookCalendar(root: string): CalendarResult<BookCalendar> {
  const meta = readMetaRecord(root)
  if (!meta.ok) return meta
  const raw = meta.value[BOOK_CALENDAR_KEY]
  if (raw === undefined || raw === null) return ok({ spec: DEFAULT_CALENDAR, source: 'default' })
  const valid = validateCalendarSpec(raw as unknown as CalendarSpec)
  if (!valid.ok) {
    return fail(
      valid.error.code,
      `${ROOT_META_FILE}: "${BOOK_CALENDAR_KEY}" is not a usable calendar — ${valid.error.message}. ` +
        'Nothing falls back to the default table: every date in the book would quietly change meaning.',
    )
  }
  return ok({ spec: valid.value, source: 'book' })
}

/** The era a bare `worldTime` is read in: the newest one, because eras ascend. */
export function defaultEraOf(spec: CalendarSpec): EraSpec {
  const last = spec.eras[spec.eras.length - 1]
  if (last !== undefined) return last
  // `validateCalendarSpec` refuses an empty `eras`, so this is unreachable for a spec a
  // caller received; a pure reader must not throw, so it answers with the one era the
  // default table always has.
  return DEFAULT_CALENDAR.eras[0] as EraSpec
}

/**
 * Write the table into the book.
 *
 * Deliberately **not** through `io.ts`'s `resolveWriteTarget`: that door is the content
 * whitelist (nine directories + `.inkflow/*`), and `inkflow.json` is scaffolding-owned
 * metadata — the same reason `hub-wizard.ts` and `shared-copy.ts` write it themselves.
 * The write is still atomic (temp file + rename in the same directory), so a crash
 * cannot leave the book without a meta file, and a table that does not validate is
 * refused *before* anything is written.
 */
export function writeBookCalendar(root: string, spec: CalendarSpec): CalendarResult<BookCalendar> {
  const valid = validateCalendarSpec(spec)
  if (!valid.ok) return valid
  const meta = readMetaRecord(root)
  if (!meta.ok) return meta

  const record: Record<string, unknown> = { ...meta.value, [BOOK_CALENDAR_KEY]: valid.value }
  const payload = `${JSON.stringify(record, null, 2)}\n`
  const target = join(root, ROOT_META_FILE)
  const temp = `${target}.tmp-${randomBytes(6).toString('hex')}`
  try {
    writeFileSync(temp, payload, 'utf8')
    renameSync(temp, target)
  } catch (cause) {
    try {
      unlinkSync(temp)
    } catch {
      // The temp file may not exist; a failed cleanup must not mask the real error.
    }
    return fail('CALENDAR_INVALID_SPEC', `writing ${ROOT_META_FILE} failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  return ok({ spec: valid.value, source: 'book' })
}

/**
 * A stable fingerprint of the table in force, stored in the index so a calendar edit
 * cannot leave derived absolute days stale.
 *
 * Why the index needs this at all: freshness is decided by comparing `files` (the nine
 * content directories) against disk. `inkflow.json` is not one of them, so changing the
 * calendar would otherwise look like "nothing changed" while every derived day number
 * in the index was computed under the old table.
 */
export function calendarFingerprint(root: string): string {
  const calendar = readBookCalendar(root)
  const text = calendar.ok ? JSON.stringify(calendar.value.spec) : `invalid:${calendar.error.code}`
  // Not a cryptographic hash: this answers "did the table change", and a 32-bit FNV-1a
  // collision would need two different tables that also differ only there. The stability
  // that matters is "same table → same string", which is what the comparison needs.
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${calendar.ok ? calendar.value.source : 'invalid'}:${hash.toString(16)}`
}

/** Re-export so a caller that only needs the failure shape imports from one module. */
export type { CalendarError, CalendarResult, CalendarSpec, EraSpec }
