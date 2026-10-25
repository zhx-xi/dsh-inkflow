/**
 * Series sync: take the SERIES' shared settings INTO one book.
 *
 * WHAT IT IS, AND WHAT IT IS NOT. The shared library gave the plugin one direction — copy one shared
 * entry into one book, on one click (`shared-copy.ts`). A series (ADR-0007 C5) is the
 * same direction applied to a *set*: every `world/`/`library/` entry of the library,
 * landed into the book at the same paths a copy would use, in one confirmed action.
 * There is no push direction (C6), no bidirectional sync, and nothing here writes the
 * shared library — `apply` only ever reads it.
 *
 * WHY THE TWO STEPS SHARE ONE COMPUTATION (X-17). `buildSeriesPlan` is the whole engine:
 * `apply` calls it again and compares what it now says with the rows the caller approved
 * (`expected`), keyed by `entryId + action`. Anything that moved in between is skipped
 * and reported `SERIES_PLAN_STALE` — the author approved a diff, so only that diff may
 * be written. A second implementation for "apply" is how a preview and a run come to
 * disagree, which is the one failure a two-step feature cannot survive.
 *
 * THE FOUR ROWS, AND WHY "conflict" NEEDS A DECISION (data-safety.md):
 *
 *   | action      | meaning                                                     | needs a decision |
 *   |-------------|-------------------------------------------------------------|------------------|
 *   | `create`    | the book has nothing at that path                            | no               |
 *   | `unchanged` | both sides read the same (reader-meaning, not byte-meaning)  | no — never written |
 *   | `update`    | the shared entry moved after the copy was taken              | no               |
 *   | `conflict`  | the two sides carry different text and only a human can pick | **yes**          |
 *
 * `update` vs `conflict` is decided by the shared library's own `stale` verdict: a copy whose recorded
 * `origin.contentHash` no longer matches the shared entry has a newer version to take
 * (that is literally what `updateSharedEntry` does, backed up). A copy whose hash still
 * matches cannot have been changed by the library, so any difference is the book's own
 * edit — nothing to take, and overwriting it would discard the author's work: `conflict`.
 * A file with no `origin` for this entry is two independent versions of one path, which
 * is a conflict by definition.
 *
 * KNOWN LIMIT, stated instead of hidden: `origin` records the source *hash*, not the
 * source *bytes* (ADR-0007 C3), so a three-way merge is impossible. When the library
 * moved AND the author also edited the copy, this engine can only classify it `update` —
 * it cannot prove the book was untouched. Two things bound that risk: `changedFields`
 * shows what the write replaces, and every write is staged into an
 * `.inkflow/backup/<stamp>/` package first (`kind: 'shared'` — the same undo trail the copy
 * path leaves), so nothing is unrecoverable.
 *
 * COMPARISON IS REUSED, NOT REBUILT: reader-meaning content comparison is
 * `extract-compare.ts` — `id`/bookkeeping keys ignored, EOL normalised, list
 * fields compared as sets. It is asked twice per row (source-as-candidate and
 * book-as-candidate) because it walks the candidate's field names only; asking both
 * ways is what makes a field that exists on just one side show up as a change.
 *
 * WHERE THINGS LAND: books get content files through `io.ts` (`writeTextAtomic` →
 * `resolveWriteTarget`: whitelisted directories, atomic replace, project write lock,
 * `..`/absolute/symlink escapes refused). The run record goes to
 * `.inkflow/audit/series-<stamp>.json` (ADR-0012 / X-25 — `index/` stays empty because
 * it is a cache a rebuild may sweep). The record carries no prose: which entries were
 * written, which were kept, and what the author decided.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { newBackupBody, openBackup, sealBackup, stageFile } from './backup.js'
import type { BackupBody, BackupHandle } from './backup.js'
import type { SharedKind } from './conventions.js'
import { compareDocument } from './extract-compare.js'
import { fingerprintProjectFile } from './file-cas.js'
import { parseMarkdown } from './frontmatter.js'
import { scanSharedLibrary } from './hub-shared.js'
import type { SharedEntry } from './hub-shared.js'
import { writeJsonAtomic, writeTextAtomic } from './io.js'
import { ensurePrivateStateIgnored, privateStateRelative } from './private-state.js'
import { sharedRootOf } from './settings.js'
import { applyOriginBlock, buildSharedCopies, ensureProjectId, sharedDestinationOf } from './shared-copy.js'

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/**
 * The kinds this engine syncs.
 *
 * Deliberately narrower than the library's four: `snippets/` is writing material (it
 * lands under `library/snippets/`, and "sync all my fragments into this book" is a
 * different promise), and `series/` copies no file at all — it only records
 * `inkflow.json.seriesId` (ADR-0007 C2/C5), which one copy already does. Both are
 * counted in `excluded` so nothing disappears silently.
 */
export const SERIES_SYNC_KINDS: readonly SharedKind[] = ['world', 'library']

export type SeriesAction = 'create' | 'update' | 'conflict' | 'unchanged'

/** Why a row is a conflict. Every value needs the author's decision. */
export type SeriesConflictReason =
  /** The library moved nothing, so the difference is the book's own edit. */
  | 'book-diverged'
  /** The book file exists but carries no `origin` for this entry: two independent versions. */
  | 'unrelated-file'
  /** The shared entry exists in the walk but cannot be read as text. */
  | 'source-unreadable'

/** One plan row. `sharedDigest`/`bookDigest` are raw byte hashes; `changedFields` is reader-meaning. */
export interface SeriesPlanEntry {
  entryId: string
  kind: SharedKind
  /** Path relative to the shared library root (`world/门派/白鹤门.md`). */
  sourcePath: string
  /** Path relative to the book root — the same path a copy would land at. */
  targetPath: string
  action: SeriesAction
  sharedDigest: string
  /** Absent for `create`: there is no book-side file to hash. */
  bookDigest?: string
  /** Field names that differ (empty for `create`/`unchanged`). Never prose. */
  changedFields: string[]
  conflict?: SeriesConflictReason
}

export interface SeriesPlanCounts {
  create: number
  update: number
  conflict: number
  unchanged: number
}

/** Everything the plan deliberately left out, so "why is this missing" has an answer. */
export interface SeriesExclusions {
  /** Shared entries of a kind this engine does not sync, by kind. */
  byKind: Record<string, number>
  /** Book-side reference cards (ADR-0007 C4): read-only, so never a sync target. */
  reference: number
  /** Shared entries too large to hash, so there is no digest to compare. */
  unhashable: number
}

export interface SeriesPlanInput {
  /** The plugin data directory; `shared/` under it (or the configured root) is the source. */
  dataDir: string
  /** The book to sync INTO. Never gated here: the caller owns the gate. */
  root: string
}

export interface SeriesPlanValue {
  root: string
  seriesId: string | null
  sharedRoot: string
  kinds: SharedKind[]
  counts: SeriesPlanCounts
  entries: SeriesPlanEntry[]
  /**
   * The rows an `apply` may be asked to perform, in plan order. This is the exact shape
   * `apply` compares against, so the caller hands back what it showed the user.
   */
  expected: Array<{ entryId: string; action: SeriesAction }>
  excluded: SeriesExclusions
  truncated: boolean
}

export interface SeriesError {
  code: string
  message: string
  hint?: string
  path?: string
  /** For `SERIES_CONFLICT_UNRESOLVED`: the rows still waiting for a decision. */
  unresolved?: Array<{ entryId: string; path: string; sharedDigest: string; bookDigest?: string }>
}

export type SeriesResult<T> = { ok: true; value: T } | { ok: false; error: SeriesError }

export type SeriesDecisionChoice = 'take-shared' | 'keep-book' | 'skip'

export interface SeriesExpectedRow {
  entryId: string
  action: string
}

export interface SeriesDecision {
  entryId: string
  decision: SeriesDecisionChoice
}

export interface SeriesApplyInput {
  dataDir: string
  root: string
  /** The plan rows the user approved. Required: `apply` writes only what was previewed. */
  expected?: readonly SeriesExpectedRow[]
  /** One entry per conflict row. A missing one refuses the whole run, zero writes. */
  decisions?: readonly SeriesDecision[]
  confirm?: boolean
  /** Clock seam for the run record's timestamp (tests pass a fixed one). */
  now?: Date
}

export interface SeriesWriteRow {
  entryId: string
  path: string
  action: 'create' | 'update' | 'take-shared'
  sharedDigest: string
  bookDigest?: string
  changedFields: string[]
}

export interface SeriesKeptRow {
  entryId: string
  path: string
  sharedDigest: string
  bookDigest?: string
  changedFields: string[]
}

export interface SeriesSkippedRow {
  entryId: string
  code: 'SERIES_PLAN_STALE' | 'SKIP'
  path?: string
}

export interface SeriesApplyValue {
  root: string
  seriesId: string | null
  counts: SeriesPlanCounts
  /** Files this run wrote, with the action that wrote them. */
  written: SeriesWriteRow[]
  /** Conflicts the author kept as they are. */
  kept: SeriesKeptRow[]
  /** Rows nothing was written for: drifted since the plan, or decided `skip`. */
  skipped: SeriesSkippedRow[]
  /** Decisions that named a row which is not a conflict: ignored, and named here. */
  ignoredDecisions: string[]
  /** The run record, project-relative. */
  auditPath: string
  /** The undo package, project-relative; absent when nothing was written. */
  backupDir?: string
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function fail(code: string, message: string, extra: Partial<SeriesError> = {}): { ok: false; error: SeriesError } {
  return { ok: false, error: { code, message, ...extra } }
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** UTF-8 with a BOM stripped (H11): a Windows-edited setting must still compare. */
function readText(absolute: string): string | undefined {
  try {
    return readFileSync(absolute, 'utf8').replace(/^\uFEFF/u, '')
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

// ---------------------------------------------------------------------------
// Reader-meaning comparison (delegated to the duplicate judgement, ADR-0021)
// ---------------------------------------------------------------------------

/**
 * Keys that are bookkeeping, not content — the ones `extract-compare.ts` cannot know
 * about because they only exist on this side of the house.
 *
 * `origin` is the copy's provenance block (ADR-0007 C3) and `mode` marks a reference
 * card; neither says anything about what the setting *is*, and the shared entry never
 * carries them, so comparing them would report every copy as different forever.
 */
const SYNC_BOOKKEEPING = new Set(['origin', 'mode'])

/**
 * The field names a document sets — what decides WHICH fields `compareDocument` looks at.
 * Values are irrelevant (the text is the source of truth); only the key set matters.
 */
function comparableFields(text: string): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const key of Object.keys(parseMarkdown(text).data)) {
    if (SYNC_BOOKKEEPING.has(key)) continue
    fields[key] = true
  }
  fields['body'] = true
  return fields
}

/**
 * `changedFields` between a book file and the shared entry, by reader-meaning.
 *
 * `compareDocument` is asked in BOTH directions because it only walks the candidate's
 * field names: one pass finds "the source has a field the book lacks", the other finds
 * "the book has a field the source dropped". Both are real differences — an `update`
 * would overwrite in both cases — and reporting only one direction would call a
 * field-dropping edit "identical".
 */
export function compareSeriesContent(bookText: string, sourceText: string): string[] {
  const changed: string[] = []
  for (const field of compareDocument(bookText, sourceText, comparableFields(sourceText)).changedFields) {
    if (!changed.includes(field)) changed.push(field)
  }
  for (const field of compareDocument(sourceText, bookText, comparableFields(bookText)).changedFields) {
    if (!changed.includes(field)) changed.push(field)
  }
  return changed
}

// ---------------------------------------------------------------------------
// The plan: the one computation both steps use
// ---------------------------------------------------------------------------

/**
 * What a sync would do, per entry. **Read-only**: it hashes, reads and compares, and
 * writes nothing at all — not the index, not the library manifest, not a temp file.
 */
export function buildSeriesPlan(input: SeriesPlanInput): SeriesResult<SeriesPlanValue> {
  const root = resolve(input.root)
  const sharedRoot = sharedRootOf(input.dataDir).root
  const library = scanSharedLibrary(sharedRoot)
  if (!library.ok) return fail('SHARED_UNAVAILABLE', library.error.message, { hint: library.error.hint })

  // The book side in one pass: which files are copies, of what, and whether the copy is
  // behind its source. The shared library's own verdict is the authority here (see the header).
  const copies = buildSharedCopies({ dataDir: input.dataDir, root })
  if (!copies.ok) return fail('SHARED_UNAVAILABLE', copies.error.message, { hint: copies.error.hint })
  const copyByFile = new Map<string, { entryId: string | null; mode: string; state: string }>()
  for (const row of copies.value.entries) copyByFile.set(row.file, row)

  const entries: SeriesPlanEntry[] = []
  const counts: SeriesPlanCounts = { create: 0, update: 0, conflict: 0, unchanged: 0 }
  const excluded: SeriesExclusions = { byKind: {}, reference: 0, unhashable: 0 }
  const inScope = new Set<string>(SERIES_SYNC_KINDS)

  for (const entry of library.entries) {
    if (!inScope.has(entry.kind)) {
      excluded.byKind[entry.kind] = (excluded.byKind[entry.kind] ?? 0) + 1
      continue
    }
    const row = planRow(root, sharedRoot, entry, copyByFile, excluded)
    if (row === undefined) continue
    counts[row.action] += 1
    entries.push(row)
  }

  const seriesId = copies.value.seriesId
  return {
    ok: true,
    value: {
      root,
      seriesId,
      sharedRoot,
      kinds: [...SERIES_SYNC_KINDS],
      counts,
      entries,
      expected: entries.map((entry) => ({ entryId: entry.entryId, action: entry.action })),
      excluded,
      truncated: library.truncated || copies.value.truncated,
    },
  }
}

/** One shared entry judged against the book. `undefined` = deliberately out of scope. */
function planRow(
  root: string,
  sharedRoot: string,
  entry: SharedEntry,
  copyByFile: ReadonlyMap<string, { entryId: string | null; mode: string; state: string }>,
  excluded: SeriesExclusions,
): SeriesPlanEntry | undefined {
  const target = sharedDestinationOf(entry)
  if (target === undefined) {
    excluded.byKind[entry.kind] = (excluded.byKind[entry.kind] ?? 0) + 1
    return undefined
  }
  // A digest is the whole basis of "did this change": without one the row cannot be
  // compared, so it is reported instead of guessed at.
  const sharedDigest = entry.sha256
  if (sharedDigest === undefined) {
    excluded.unhashable += 1
    return undefined
  }
  // A reference card holds no snapshot (ADR-0007 C4) and is read-only by contract.
  // Syncing it would either compare an empty body or silently turn it into a copy.
  const copy = copyByFile.get(target)
  if (copy !== undefined && copy.mode === 'reference') {
    excluded.reference += 1
    return undefined
  }

  const absolute = join(root, ...target.split('/'))
  const base = {
    entryId: entry.entryId,
    kind: entry.kind,
    sourcePath: entry.path,
    targetPath: target,
    sharedDigest,
  }

  if (!existsSync(absolute)) {
    return { ...base, action: 'create', changedFields: [] }
  }

  const bookText = readText(absolute)
  if (bookText === undefined) {
    return { ...base, action: 'conflict', changedFields: [], conflict: 'source-unreadable' }
  }
  const bookDigest = digestOf(absolute) ?? sharedDigest
  const sourceText = readText(join(sharedRoot, ...entry.path.split('/')))
  if (sourceText === undefined) {
    return { ...base, action: 'conflict', bookDigest, changedFields: [], conflict: 'source-unreadable' }
  }

  const changedFields = compareSeriesContent(bookText, sourceText)
  if (changedFields.length === 0) {
    return { ...base, action: 'unchanged', bookDigest, changedFields }
  }

  // `stale` = the shared entry moved after this copy was taken. Anything else means the
  // library did not move, so the difference is the book's own edit — or the file was
  // never a copy of this entry at all.
  const sameEntry = copy !== undefined && copy.entryId === entry.entryId
  if (sameEntry && copy.state === 'stale') {
    return { ...base, action: 'update', bookDigest, changedFields }
  }
  return {
    ...base,
    action: 'conflict',
    bookDigest,
    changedFields,
    conflict: sameEntry ? 'book-diverged' : 'unrelated-file',
  }
}

function digestOf(absolute: string): string | undefined {
  try {
    return sha256Hex(readFileSync(absolute))
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Perform the approved plan (X-17's second half).
 *
 * The order is the contract, because each step is the guard for the next:
 *
 *   1. `confirm: true` — nothing happens without it;
 *   2. `expected` — the rows the user saw; without them there is nothing to compare and
 *      an "apply everything I computed just now" would be a one-step write in disguise;
 *   3. recompute with `buildSeriesPlan` and compare `entryId + action` as a multiset:
 *      a row that is not in `expected`, or whose action changed, is skipped and reported
 *      `SERIES_PLAN_STALE` (the other rows still run — they are what was approved);
 *   4. **every** conflict must carry a decision. One missing → `SERIES_CONFLICT_UNRESOLVED`
 *      and NOTHING is written: "解决了一部分冲突" is not a state this can leave behind,
 *      because the caller cannot tell which half landed;
 *   5. the backup package opens and every covered file is staged and the journal sealed
 *      `false` BEFORE the first byte (ADR-0012), so an interrupted sync still has its
 *      undo on disk;
 *   6. the run record lands under `.inkflow/audit/`.
 */
export function applySeriesSync(input: SeriesApplyInput): SeriesResult<SeriesApplyValue> {
  const root = resolve(input.root)
  if (input.confirm !== true) {
    return fail('CONFIRM_REQUIRED', 'syncing writes setting files into the book', {
      hint: 'show the plan to the user, collect a decision for every conflict, then call again with confirm: true',
    })
  }
  const expected = input.expected
  if (!Array.isArray(expected)) {
    return fail('SERIES_PLAN_REQUIRED', 'an apply has to say which plan rows were approved', {
      hint: 'call inkflow_series_plan first and pass its `expected` back unchanged; apply writes only what was previewed',
    })
  }

  const plan = buildSeriesPlan({ dataDir: input.dataDir, root })
  if (!plan.ok) return plan
  const value = plan.value

  // ---- 1. drift since the plan -------------------------------------------
  const approved = new Map<string, Set<string>>()
  for (const row of expected) {
    const entryId = nonEmptyString(row.entryId)
    const action = nonEmptyString(row.action)
    if (entryId === undefined || action === undefined) continue
    const actions = approved.get(entryId) ?? new Set<string>()
    actions.add(action)
    approved.set(entryId, actions)
  }

  const skipped: SeriesSkippedRow[] = []
  const live: SeriesPlanEntry[] = []
  for (const row of value.entries) {
    const actions = approved.get(row.entryId)
    if (actions === undefined || !actions.has(row.action)) {
      skipped.push({ entryId: row.entryId, code: 'SERIES_PLAN_STALE', path: row.targetPath })
      continue
    }
    live.push(row)
  }
  // A row the caller approved that the recomputation no longer has is drift too — the
  // entry was deleted from the library, or its path stopped mapping into the book.
  const planned = new Set(value.entries.map((row) => `${row.entryId}\u0000${row.action}`))
  for (const row of expected) {
    const entryId = nonEmptyString(row.entryId)
    const action = nonEmptyString(row.action)
    if (entryId === undefined || action === undefined) continue
    if (planned.has(`${entryId}\u0000${action}`)) continue
    if (skipped.some((item) => item.entryId === entryId)) continue
    skipped.push({ entryId, code: 'SERIES_PLAN_STALE' })
  }

  // ---- 2. every conflict decided (zero writes otherwise) -----------------
  const decisions = new Map<string, SeriesDecisionChoice>()
  const ignoredDecisions: string[] = []
  for (const row of input.decisions ?? []) {
    const entryId = nonEmptyString(row.entryId)
    const choice = row.decision
    if (entryId === undefined) continue
    if (choice !== 'take-shared' && choice !== 'keep-book' && choice !== 'skip') {
      return fail('SERIES_DECISION_INVALID', `the decision for ${entryId} is not one of take-shared / keep-book / skip`, {
        hint: 'send {entryId, decision} with decision = take-shared | keep-book | skip',
      })
    }
    decisions.set(entryId, choice)
  }

  const conflicts = live.filter((row) => row.action === 'conflict')
  const unresolved = conflicts
    .filter((row) => !decisions.has(row.entryId))
    .map((row) => ({
      entryId: row.entryId,
      path: row.targetPath,
      sharedDigest: row.sharedDigest,
      ...(row.bookDigest === undefined ? {} : { bookDigest: row.bookDigest }),
    }))
  if (unresolved.length > 0) {
    return fail(
      'SERIES_CONFLICT_UNRESOLVED',
      `${unresolved.length} conflict(s) still need a decision, so nothing was written`,
      {
        unresolved,
        hint: 'decide each one (take-shared | keep-book | skip) and call again: a half-decided sync is not a state this writes',
      },
    )
  }
  const conflictIds = new Set(conflicts.map((row) => row.entryId))
  for (const entryId of decisions.keys()) {
    if (!conflictIds.has(entryId)) ignoredDecisions.push(entryId)
  }

  // ---- 3. the writes ------------------------------------------------------
  const writes: SeriesPlanEntry[] = []
  const kept: SeriesKeptRow[] = []
  for (const row of live) {
    if (row.action === 'create' || row.action === 'update') {
      writes.push(row)
      continue
    }
    if (row.action === 'unchanged') continue
    const choice = decisions.get(row.entryId)
    if (choice === 'take-shared') {
      writes.push(row)
      continue
    }
    if (choice === 'skip') {
      skipped.push({ entryId: row.entryId, code: 'SKIP', path: row.targetPath })
      continue
    }
    kept.push({
      entryId: row.entryId,
      path: row.targetPath,
      sharedDigest: row.sharedDigest,
      ...(row.bookDigest === undefined ? {} : { bookDigest: row.bookDigest }),
      changedFields: row.changedFields,
    })
  }

  const written: SeriesWriteRow[] = []
  let backupDir: string | undefined
  if (writes.length > 0) {
    const projectId = ensureProjectId(root)
    if (!projectId.ok) return fail(projectId.error.code, projectId.error.message, { path: projectId.error.path })

    const opened = openBackup(root, 'shared')
    if (!opened.ok) return fail(opened.error.code, opened.error.message, { path: opened.error.path })
    const handle: BackupHandle = opened.value
    backupDir = handle.dir
    const body: BackupBody = newBackupBody()
    const journal = sealBackup(root, handle, 'shared', body, false)
    if (!journal.ok) return fail(journal.error.code, journal.error.message, { path: journal.error.path })

    for (const row of writes) {
      const sourceBytes = readBytes(join(value.sharedRoot, ...row.sourcePath.split('/')))
      if (sourceBytes === undefined) {
        return fail('SHARED_SOURCE_UNREADABLE', `${row.sourcePath} could not be read`, { path: row.sourcePath })
      }
      const text = sourceBytes.toString('utf8')
      if (sha256Hex(Buffer.from(text, 'utf8')) !== sha256Hex(sourceBytes)) {
        return fail('SHARED_SOURCE_NOT_UTF8', `${row.sourcePath} is not valid UTF-8`, {
          path: row.sourcePath,
          hint: 'the shared entry is left untouched; convert it to UTF-8 and sync again',
        })
      }
      // Staged BEFORE the write: `previous` is the bytes a rollback would put back, and
      // `undefined` means "this run creates the file", which the manifest records as such.
      const staged = stageFile(root, handle, row.targetPath)
      if (!staged.ok) return fail(staged.error.code, staged.error.message, { path: row.targetPath })
      const previous = staged.value
      const origin = { projectId: projectId.value.projectId, entryId: row.entryId, contentHash: sha256Hex(sourceBytes) }
      const wrote = writeTextAtomic(root, row.targetPath, applyOriginBlock(text, origin))
      if (!wrote.ok) {
        return fail(wrote.error.code, wrote.error.message, { path: row.targetPath })
      }
      const after = fingerprintProjectFile(root, row.targetPath)
      body.files.push({
        path: row.targetPath,
        change: row.action === 'create' ? 'created' : 'modified',
        ...(previous === undefined ? {} : { before: { bytes: previous.bytes, sha256: previous.sha256 } }),
        ...(after === undefined ? {} : { after: { bytes: after.size, sha256: after.sha256 } }),
      })
      body.steps.push(`${row.action} ${row.targetPath} from ${row.entryId}`)
      written.push({
        entryId: row.entryId,
        path: row.targetPath,
        action: row.action === 'create' ? 'create' : row.action === 'update' ? 'update' : 'take-shared',
        sharedDigest: row.sharedDigest,
        ...(row.bookDigest === undefined ? {} : { bookDigest: row.bookDigest }),
        changedFields: row.changedFields,
      })
    }

    const sealed = sealBackup(root, handle, 'shared', body, true)
    if (!sealed.ok) return fail(sealed.error.code, sealed.error.message, { path: sealed.error.path })
  }

  // ---- 4. the run record --------------------------------------------------
  const recorded = writeRunRecord(root, {
    seriesId: value.seriesId,
    counts: value.counts,
    written,
    kept,
    skipped,
    decisions: [...decisions.entries()].map(([entryId, decision]) => ({ entryId, decision })),
    backupDir,
    now: input.now ?? new Date(),
  })
  if (!recorded.ok) return recorded

  return {
    ok: true,
    value: {
      root,
      seriesId: value.seriesId,
      counts: value.counts,
      written,
      kept,
      skipped,
      ignoredDecisions,
      auditPath: recorded.value,
      ...(backupDir === undefined ? {} : { backupDir }),
    },
  }
}

/**
 * Read a file's bytes, or `undefined` when it is not there.
 *
 * The plan and the apply path both go through it so "the source vanished between the two
 * steps" produces `SHARED_SOURCE_UNREADABLE` instead of an exception in the middle of a
 * multi-file write.
 */
function readBytes(absolute: string): Buffer | undefined {
  try {
    return readFileSync(absolute)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// The run record (`.inkflow/audit/series-<stamp>.json`)
// ---------------------------------------------------------------------------

/** `series-20261025-185500.json`: sortable, unique per second, no colons (Windows). */
export function seriesRunName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp =
    `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `series-${stamp}.json`
}

export interface SeriesRunRecord {
  schemaVersion: number
  runAt: string
  seriesId: string | null
  counts: SeriesPlanCounts
  written: SeriesWriteRow[]
  kept: SeriesKeptRow[]
  skipped: SeriesSkippedRow[]
  decisions: SeriesDecision[]
  backupDir?: string
}

/**
 * Write the record of ONE run into the book's private state directory.
 *
 * WHY A TIMESTAMP HERE, WHEN A GATE CONCLUSION deliberately has none (ADR-0022 D4):
 * these are opposite kinds of file. A gate file answers "what does this chapter say now",
 * so two runs on unchanged input must be byte-identical and diffable. A series run answers
 * "what happened at 18:55" — who was overwritten, who was kept, which way each conflict
 * went — and two runs are two events. A timestamp is the identity of the event, not noise.
 *
 * NO PROSE: paths, digests, field names and decisions only. The record says a file changed
 * and what was decided about it; reading the setting is what the file itself is for.
 */
function writeRunRecord(
  root: string,
  input: {
    seriesId: string | null
    counts: SeriesPlanCounts
    written: SeriesWriteRow[]
    kept: SeriesKeptRow[]
    skipped: SeriesSkippedRow[]
    decisions: SeriesDecision[]
    backupDir?: string
    now: Date
  },
): SeriesResult<string> {
  ensurePrivateStateIgnored(root)
  const record: SeriesRunRecord = {
    schemaVersion: 1,
    runAt: input.now.toISOString(),
    seriesId: input.seriesId,
    counts: input.counts,
    written: input.written,
    kept: input.kept,
    skipped: input.skipped,
    decisions: input.decisions,
    ...(input.backupDir === undefined ? {} : { backupDir: input.backupDir }),
  }
  // Two runs inside one second are two runs: a second write must not overwrite the first
  // record, or the audit trail would lose exactly the run somebody is asking about.
  let name = seriesRunName(input.now)
  let relative = privateStateRelative('audit', name)
  for (let attempt = 2; attempt <= 99; attempt += 1) {
    if (!existsSync(join(root, ...relative.split('/')))) break
    name = `${seriesRunName(input.now).replace(/\.json$/u, '')}-${String(attempt)}.json`
    relative = privateStateRelative('audit', name)
  }
  const written = writeJsonAtomic(root, relative, record)
  if (!written.ok) return fail(written.error.code, written.error.message, { path: relative })
  return { ok: true, value: relative }
}
