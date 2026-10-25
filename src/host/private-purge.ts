/**
 * The private state's **purge area**: `.inkflow/purged/` (#199, [ADR-0026](../../../.agents/adrs/0026-private-purge-area.md)).
 *
 * Why it exists at all: review runs (`.inkflow/review/<chapterId>/<runId>.json`, #46) and
 * proposals (`.inkflow/proposals/<proposalId>/`, #45) accumulate, and until now the only two
 * options were "keep every one forever" or "delete it for good" — the extract queue's
 * `purge` is the second kind, and the author cannot undo it. The recovery bin (`trash/`, #35)
 * is deliberately NOT the answer: it refuses `.inkflow/` sources on purpose (a chapter the
 * author deleted and a probe the plugin wrote are different kinds of loss), so the private
 * state gets its **own** holding area instead of widening that ban.
 *
 * ## The shape
 *
 * ```
 * <book>/.inkflow/purged/
 *   index.json                                  # the manifest (one row per cleanup)
 *   review/<chapterId>/<runId>.json             # a cleaned-up run, at its own sub-path
 *   proposals/<proposalId>/{meta.json,hunks/…}  # a cleaned-up proposal, whole directory
 * ```
 *
 * The copy keeps the path it had **under `.inkflow/`**, which is what makes the restore
 * target a fact rather than an input: a row can only ever put bytes back into
 * `.inkflow/review/` or `.inkflow/proposals/`, and `restoreTargetOf` refuses everything else
 * (a `..` segment, an absolute path, `jobs/`, a content directory) before any write.
 *
 * ## What this module owns
 *
 *   * the layout, the manifest row shape and its digest recipe;
 *   * reading the area back (`listPurged`) and the restore-target guard (`restoreTargetOf`);
 *   * `cleanUpReviewRun` / `cleanUpProposal` (the two cleanable kinds) and `restorePurged`
 *     (the undo) — every one of them a move of private state, never a rewrite of content.
 *
 * ## What it refuses to own
 *
 *   * reading a proposal's own metadata or a run record: they belong to `proposal.ts` /
 *     `review-store.ts`, and the status check that keeps `open` un-cleanable asks them;
 *   * the delete record under `.inkflow/audit/` (归 `private-purge-channel.ts`) and the
 *     channel replies;
 *   * the recovery bin's ban on `.inkflow/` sources (ADR-0012): unchanged, untouched.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'

import { removeEmptyProjectDirectory } from './io.js'
import {
  absoluteOf,
  digestBytes,
  manifestBytes,
  manifestText,
  plainRelativePath,
  readPrivateManifest,
  writePrivateManifest,
} from './private-manifest.js'
import type { PrivateManifestFailure, PrivateManifestSpec } from './private-manifest.js'
import { privateStateDirRelative, privateStateRelative } from './private-state.js'

/** The manifest file, project-relative (forward slashes). */
export const PURGE_MANIFEST_RELATIVE = privateStateRelative('purged', 'index.json')

/** The manifest's own shape version; a different value is refused, never migrated. */
export const PURGE_SCHEMA_VERSION = 1

/** The two things an author may clean up (#199 P0 covers exactly these). */
export const PURGE_KINDS = ['review-run', 'proposal'] as const
export type PurgeKind = (typeof PURGE_KINDS)[number]

/** The only reason this build writes; free text, so a future caller need not migrate. */
export const PURGE_REASON_AUTHOR_CLEANUP = 'author_cleanup'

/**
 * The only two private-state subdirectories a restore may write back into.
 *
 * A closed list, checked by `restoreTargetOf` **before** any write: the purge area must
 * never become a way to put a byte anywhere else (a `jobs/` record, a chapter file, a
 * junction out of the project).
 */
export const PURGE_RESTORE_ROOTS = ['review', 'proposals'] as const

/** One file that moved out of the private state. */
export interface PurgedFile {
  /** Private-state-relative path: `review/<chapterId>/<runId>.json`, `proposals/<id>/meta.json`. */
  path: string
  bytes: number
  sha256: string
}

/** One cleanup: what left, when, how much, and the files that hold it. */
export interface PurgeEntry {
  /** Stable id the panel and the routes address; a uuid minted at cleanup time. */
  id: string
  kind: PurgeKind
  /** What was cleaned up, as the reader addresses it: `<chapterId>/<runId>` or `<proposalId>`. */
  target: string
  /** One line the panel prints instead of re-deriving the identity from `files`. */
  label: string
  /** ISO 8601 (UTC). */
  deletedAt: string
  /** Sum of `files[].bytes`. */
  bytes: number
  /** Digest over the file list (`digestOfFiles`). */
  sha256: string
  reason: string
  files: PurgedFile[]
}

/** An entry as the area reports it: the manifest row plus what is on disk right now. */
export interface PurgeEntryView extends PurgeEntry {
  /** Where the bytes are now (`.inkflow/purged/…`). */
  purgedPath: string
  /** `false` when a copy is gone (hand-cleaned): the row can be dropped, nothing restored. */
  present: boolean
}

export interface PurgeError {
  /** A `PURGE_*` code, or the `IoErrorCode` that actually refused the write. */
  code: string
  message: string
  root?: string
  path?: string
  hint?: string
  nothingWritten?: boolean
  rolledBack?: boolean
}

export interface PurgeFailure {
  ok: false
  error: PurgeError
}

export interface PurgeListOk {
  ok: true
  root: string
  manifestPath: string
  total: number
  /** Sum of the recorded byte counts. */
  bytes: number
  entries: PurgeEntryView[]
}

export type PurgeListResult = PurgeListOk | PurgeFailure

export function purgeFailure(code: string, message: string, extra: Omit<PurgeError, 'code' | 'message'> = {}): PurgeFailure {
  return { ok: false, error: { code, message, ...extra } }
}

/**
 * The restore target for a purged path, or `undefined` when the path may not be written back.
 *
 * This is the guard the whole area stands on, so it is stated as two separate questions:
 * "is this a plain relative path at all" (`plainRelativePath`: no `..`, no absolute path, no
 * empty segment) and "does it sit inside the two subdirectories a cleanup can empty"
 * (`PURGE_RESTORE_ROOTS`). The manifest reader runs the same check on every row, so a
 * hand-edited `index.json` cannot turn a restore into an arbitrary write.
 */
export function restoreTargetOf(path: string): string | undefined {
  const plain = plainRelativePath(path)
  if (plain === undefined) return undefined
  const segments = plain.split('/')
  const root = segments[0] ?? ''
  if (!(PURGE_RESTORE_ROOTS as readonly string[]).includes(root)) return undefined
  if (segments.length < 2) return undefined
  return privateStateRelative(root as (typeof PURGE_RESTORE_ROOTS)[number], segments.slice(1).join('/'))
}

/**
 * The digest of a file list: `sha256` over the sorted `path\0sha256\n` lines.
 *
 * Sorted, because a proposal's files come from a directory walk and a walk order is not a
 * fact about the content; the digest answers "is this the same cleanup", and that must not
 * change when a filesystem returns the names in another order.
 */
export function digestOfFiles(files: readonly PurgedFile[]): string {
  const lines = files.map((file) => `${file.path}\u0000${file.sha256}\n`).sort()
  return digestBytes(Buffer.from(lines.join(''), 'utf8'))
}

/** `.inkflow/purged/<private-state-relative path>` — where a cleaned-up file lives now. */
export function purgedPathOf(path: string): string {
  return privateStateRelative('purged', path)
}

/** Where one entry's bytes live, as a project-relative path (the directory, for a proposal). */
export function purgedLocationOf(entry: PurgeEntry): string {
  if (entry.kind === 'proposal') return purgedPathOf(`proposals/${entry.target}`)
  return purgedPathOf(entry.files[0]?.path ?? `review/${entry.target}`)
}

function readFile(raw: unknown): PurgedFile | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const path = manifestText(record, 'path')
  const sha256 = manifestText(record, 'sha256')
  const bytes = manifestBytes(record)
  if (path === undefined || sha256 === undefined || bytes === undefined) return undefined
  // The path has to be restorable, or the row is a promise the area cannot keep.
  if (restoreTargetOf(path) === undefined) return undefined
  return { path, sha256, bytes }
}

/** One manifest row, or `undefined` when any field is missing or mistyped. */
function readEntry(raw: unknown): PurgeEntry | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const id = manifestText(record, 'id')
  const kind = manifestText(record, 'kind')
  const target = manifestText(record, 'target')
  const label = manifestText(record, 'label')
  const deletedAt = manifestText(record, 'deletedAt')
  const sha256 = manifestText(record, 'sha256')
  const reason = manifestText(record, 'reason')
  const bytes = manifestBytes(record)
  if (id === undefined || target === undefined || deletedAt === undefined) return undefined
  if (label === undefined || sha256 === undefined || reason === undefined || bytes === undefined) return undefined
  if (kind === undefined || !(PURGE_KINDS as readonly string[]).includes(kind)) return undefined
  if (!Array.isArray(record['files'])) return undefined
  const files: PurgedFile[] = []
  for (const rawFile of record['files']) {
    const file = readFile(rawFile)
    if (file === undefined) return undefined
    files.push(file)
  }
  // A cleanup with no files could not be restored and says nothing: refused rather than
  // listed as an empty promise.
  if (files.length === 0) return undefined
  return { id, kind: kind as PurgeKind, target, label, deletedAt, bytes, sha256, reason, files }
}

/** The area's manifest, as the shared reader in `private-manifest.ts` needs it. */
const PURGE_MANIFEST: PrivateManifestSpec<PurgeEntry> = {
  relative: PURGE_MANIFEST_RELATIVE,
  schemaVersion: PURGE_SCHEMA_VERSION,
  invalidCode: 'PURGE_MANIFEST_INVALID',
  label: 'the purge-area manifest',
  entryProblem: 'holds an entry that cannot be restored (missing or mistyped field)',
  brokenHint: 'the area is left untouched on purpose: move the broken file aside to start a fresh manifest',
  parse: readEntry,
}

function readManifest(root: string): { ok: true; entries: PurgeEntry[]; exists: boolean } | PrivateManifestFailure {
  return readPrivateManifest(root, PURGE_MANIFEST)
}

function writeManifest(root: string, entries: readonly PurgeEntry[]): { ok: true } | PrivateManifestFailure {
  return writePrivateManifest(root, PURGE_MANIFEST, entries)
}

/**
 * Every file under one private-state directory, recursively, as `path`/`bytes`/`sha256`.
 *
 * A file that cannot be read is skipped rather than aborting: the caller uses this to decide
 * what a cleanup would move, and "one unreadable file" must not be reported as "nothing to
 * clean up" (it is reported as an absence from the list, and the cleanup's own copy step
 * compares the totals).
 */
export function filesUnder(root: string, privateRelative: string): PurgedFile[] {
  const base = privateRelative.replace(/\/+$/u, '')
  const out: PurgedFile[] = []
  const walk = (directory: string): void => {
    let names: string[]
    try {
      names = readdirSync(absoluteOf(root, directory))
    } catch {
      return
    }
    for (const name of names.sort()) {
      const child = `${directory}/${name}`
      let isDirectory = false
      try {
        const stats = statSync(absoluteOf(root, child))
        if (stats.isDirectory()) isDirectory = true
        else if (!stats.isFile()) continue
      } catch {
        continue
      }
      if (isDirectory) {
        walk(child)
        continue
      }
      try {
        const bytes = readFileSync(absoluteOf(root, child))
        out.push({ path: child, bytes: bytes.byteLength, sha256: digestBytes(bytes) })
      } catch {
        continue
      }
    }
  }
  walk(base)
  return out
}

/**
 * Everything the area holds, newest first.
 *
 * Read-only, and tolerant the way the recovery bin is: an entry whose copy went missing is
 * reported with `present: false` instead of disappearing — a row nobody can see cannot be
 * cleaned up.
 */
export function listPurged(projectRoot: string): PurgeListResult {
  const root = projectRoot
  const open = readManifest(root)
  if (!open.ok) return open
  const entries: PurgeEntryView[] = open.entries.map((entry) => ({
    ...entry,
    purgedPath: purgedLocationOf(entry),
    present: entry.files.every((file) => existsSync(absoluteOf(root, purgedPathOf(file.path)))),
  }))
  return {
    ok: true,
    root,
    manifestPath: PURGE_MANIFEST_RELATIVE,
    total: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    entries,
  }
}

/** Remove now-empty directories inside the area, deepest first, stopping at the area itself. */
export function pruneEmptyAreaDirs(root: string, projectRelativeFile: string): void {
  const floor = privateStateDirRelative('purged')
  let directory = projectRelativeFile.replaceAll('\\', '/').split('/').slice(0, -1).join('/')
  while (directory.startsWith(`${floor}/`)) {
    const removed = removeEmptyProjectDirectory(root, directory)
    if (!removed.ok) return
    directory = directory.split('/').slice(0, -1).join('/')
  }
}
