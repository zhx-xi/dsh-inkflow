/**
 * Index freshness and **the one rebuild trigger** (issue #5).
 *
 * The index used to be rebuilt only when it was *absent* or built by another
 * schema version (`listChapters` → `undefined`, `searchChapters` →
 * `INDEX_UNAVAILABLE`). Editing a chapter in an editor, adding one, or deleting
 * one therefore left the tools and the panel answering from old rows forever.
 *
 * Two responsibilities, deliberately separate:
 *
 *   - `checkIndexFreshness(root)` **decides, and only decides.** It is a pure
 *     read: one `readdir`+`stat` pass over the project compared against the
 *     index's own `files` table. No file content is read, nothing is hashed,
 *     and no lock or database is created — so it is safe to call on every read
 *     path and in a test that asserts "the project did not move".
 *   - `ensureIndex(root)` **acts.** `fresh` → nothing; `stale` / `missing` /
 *     `incompatible` → exactly one `buildIndex()` (issue #4's atomic build,
 *     single-flight, `index/.lock`, temp-file swap) and a structured failure
 *     value instead of a throw.
 *
 * Why the `files` table is the baseline and `meta.builtAt` is not enough:
 * `builtAt` vs "the newest mtime on disk" can only ever *suggest* staleness.
 * Deleting a file raises no mtime at all, and replacing one file with another
 * leaves the count unchanged — both are invisible to a timestamp heuristic.
 * Per-file `(size, mtime)` comparison catches all three cases (add, remove,
 * edit) with the same single walk, so the heuristic is not used to *decide*;
 * only the row comparison is.
 *
 * The target cost (500 chapters / ~3000 files) is one metadata pass: no
 * `readFile`, no `createHash`. See `tests/index-freshness.test.js`.
 */

import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { INDEX_SCHEMA_VERSION } from './conventions.js'
import { calendarFingerprint } from './calendar-book.js'
import { buildIndex, describeIndexBuildFailure } from './index-build.js'
import type { IndexBuildFailure } from './index-build.js'
import { indexPaths, walkProjectFiles } from './indexer.js'
import type { IndexBuildResult } from './indexer.js'

export type IndexFreshnessState = 'fresh' | 'stale' | 'missing' | 'incompatible'

/** How many individual differences are named; the count is unbounded. */
export const FRESHNESS_REASON_LIMIT = 5

export interface IndexFreshness {
  state: IndexFreshnessState
  /** What makes the index stale, capped at `FRESHNESS_REASON_LIMIT` entries. */
  reasons: string[]
  /** Total number of differences found (reasons are capped, this is not). */
  changes: number
  /** The derived database this verdict is about. */
  dbFile: string
  /** Files compared against the `files` table (0 when the check stopped early). */
  checkedFiles: number
  /** Wall time of the check in milliseconds. */
  ms: number
}

interface IndexedFileRow {
  path: string
  size: number
  mtime: string
}

function messageOf(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause)
  return raw.length > 200 ? `${raw.slice(0, 200)}...` : raw
}

/** One `files` row per indexed path; `undefined` when the table is unreadable. */
function readIndexedFiles(db: DatabaseSync): { rows: IndexedFileRow[] } | { problem: string } {
  try {
    const raw = db.prepare('SELECT path, size, mtime FROM files').all() as unknown as Array<Record<string, unknown>>
    const rows: IndexedFileRow[] = []
    for (const row of raw) {
      if (typeof row['path'] !== 'string') continue
      rows.push({
        path: row['path'],
        size: typeof row['size'] === 'number' ? row['size'] : -1,
        mtime: typeof row['mtime'] === 'string' ? row['mtime'] : '',
      })
    }
    return { rows }
  } catch (cause) {
    return { problem: messageOf(cause) }
  }
}

function schemaVersionOf(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined
  return typeof row?.user_version === 'number' ? row.user_version : 0
}

/**
 * The calendar fingerprint the index was built under, or `undefined` when the row is
 * missing (an index from before #48, which the schema bump already rejects).
 */
function indexedCalendar(db: DatabaseSync): string | undefined {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'calendarFingerprint'").get() as
      | { value?: unknown }
      | undefined
    return typeof row?.value === 'string' ? row.value : undefined
  } catch {
    return undefined
  }
}

/**
 * Judge whether `index/inkflow.db` still describes the files on disk.
 *
 * `incompatible` is **not** an instruction to delete anything: a caller (or a
 * human) decides to rebuild, and `ensureIndex` is the caller that does.
 */
export function checkIndexFreshness(root: string): IndexFreshness {
  const started = Date.now()
  const paths = indexPaths(root)
  const report = (state: IndexFreshnessState, reasons: string[], changes: number, checkedFiles = 0): IndexFreshness => ({
    state,
    reasons: reasons.slice(0, FRESHNESS_REASON_LIMIT),
    changes,
    dbFile: paths.dbFile,
    checkedFiles,
    ms: Date.now() - started,
  })

  if (!existsSync(paths.dbFile)) return report('missing', ['index/inkflow.db is absent'], 1)

  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(paths.dbFile, { readOnly: true })
    const version = schemaVersionOf(db)
    if (version !== INDEX_SCHEMA_VERSION) {
      return report(
        'incompatible',
        [`the index was built by schema v${String(version)}, this plugin builds v${String(INDEX_SCHEMA_VERSION)}`],
        1,
      )
    }
    const indexed = readIndexedFiles(db)
    if ('problem' in indexed) return report('incompatible', [`the index has no readable files table: ${indexed.problem}`], 1)

    // The fast path: one readdir+stat pass, no content read, no hashing.
    const disk = walkProjectFiles(root)
    const byPath = new Map(indexed.rows.map((row) => [row.path, row]))
    const reasons: string[] = []
    let changes = 0
    const note = (reason: string): void => {
      changes += 1
      if (reasons.length < FRESHNESS_REASON_LIMIT) reasons.push(reason)
    }

    for (const file of disk) {
      const row = byPath.get(file.path)
      if (row === undefined) {
        note(`added ${file.path}`)
        continue
      }
      byPath.delete(file.path)
      if (row.size !== file.size) note(`resized ${file.path} (${String(row.size)} → ${String(file.size)} bytes)`)
      else if (row.mtime !== file.mtime) note(`touched ${file.path}`)
    }
    for (const path of byPath.keys()) note(`removed ${path}`)
    // The book's calendar lives in `inkflow.json`, which is not one of the nine content
    // directories, so no `files` row describes it. Comparing its fingerprint is what keeps
    // a table edit from leaving every derived `world_absolute_day` describing the old one.
    if (indexedCalendar(db) !== calendarFingerprint(root)) note('the book calendar in inkflow.json changed')

    if (changes === 0) return report('fresh', [], 0, disk.length)
    if (changes > FRESHNESS_REASON_LIMIT) {
      // Keep the last slot for the count, so "20 files changed" never reads as
      // "5 files changed".
      reasons[FRESHNESS_REASON_LIMIT - 1] = `… and ${String(changes - (FRESHNESS_REASON_LIMIT - 1))} more`
    }
    return report('stale', reasons, changes, disk.length)
  } catch (cause) {
    // A corrupt/unopenable database is not "stale data", it is "unusable index":
    // the caller deletes and rebuilds, never reads.
    return report('incompatible', [`the index could not be read: ${messageOf(cause)}`], 1)
  } finally {
    db?.close()
  }
}

export interface EnsureIndexOptions {
  /** Rebuild even when the index is fresh (an explicit repair). */
  rebuild?: boolean
}

export interface EnsureIndexSuccess {
  ok: true
  root: string
  /** The verdict *before* acting — what the caller would have had to reason about. */
  state: IndexFreshnessState
  rebuilt: boolean
  freshness: IndexFreshness
  /** Present only when a build ran. */
  build?: IndexBuildResult
}

export interface EnsureIndexFailure {
  ok: false
  root: string
  state: IndexFreshnessState
  rebuilt: false
  freshness: IndexFreshness
  /** Issue #4's structured build failure (`INDEX_BUILD_FAILED` / `INDEX_BUSY`). */
  failure: IndexBuildFailure
}

export type EnsureIndexResult = EnsureIndexSuccess | EnsureIndexFailure

/**
 * Make the index trustworthy, once, for every read path.
 *
 * `chapter_list`, `chapter_search`, `/chapters` and `/search` all call this and
 * nothing else decides to rebuild — that is what keeps "the list is new, the
 * search is old" from happening: both read paths see the same build.
 *
 * Never throws: a failed build is `{ ok:false, failure }`, and the previous
 * index (if any) is left readable by `buildIndex` (issue #4).
 */
export async function ensureIndex(root: string, options: EnsureIndexOptions = {}): Promise<EnsureIndexResult> {
  const freshness = checkIndexFreshness(root)
  if (options.rebuild !== true && freshness.state === 'fresh') {
    return { ok: true, root, state: 'fresh', rebuilt: false, freshness }
  }
  try {
    const build = await buildIndex(root)
    return { ok: true, root, state: freshness.state, rebuilt: true, freshness, build }
  } catch (cause) {
    return { ok: false, root, state: freshness.state, rebuilt: false, freshness, failure: describeIndexBuildFailure(cause) }
  }
}
