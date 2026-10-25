/**
 * Local backups as standard ZIP packages (ADR-0018 D3/D4/D6, roadmap X-22).
 *
 * WHAT A BACKUP IS HERE, AND WHAT IT IS NOT. This is the author's safety net, not
 * version control: one package per backup, holding the nine content directories plus
 * `inkflow.json` and `.gitignore`, written store-only so any tool on any machine can
 * open it and read the text (`zip.ts`). The derived index, `.git/` and `.inkflow/`
 * are excluded — `index/` is rebuildable, git history belongs to git, and a safety
 * net that carries the recovery bin inside it is a net that doubles in size every
 * time it is used (D4).
 *
 * WHERE IT LIVES AND WHY NOT IN THE BOOK. `dataDir/backups/<bookSlug>-<stamp>.zip`
 * (D3): a package next to the book would land in the author's git repository (part
 * of the point of a backup is surviving a bad commit), and under `index/` it would
 * be deleted by the next rebuild.
 *
 * WHY RESTORE PREVIEWS FIRST (D6). A package may be days old while the book moved on,
 * so a restore that simply writes every entry back would silently discard that work.
 * The discipline is the repair pass's: compare, then write, then report.
 *
 *   - `planRestore` reads the package, compares every entry with the bytes on disk
 *     now, and writes NOTHING. That plan is what the panel shows and what the tool
 *     returns by default.
 *   - `restoreBookBackup` with `expected` compares the CURRENT bytes against the
 *     digests the caller saw in the plan. A file that changed in between is a
 *     `BACKUP_CONFLICT` and is skipped, while the rest of the restore proceeds —
 *     one edited chapter must not block putting back the other nine hundred.
 *   - Without `expected` there is no baseline the caller ever saw, so the restore
 *     proceeds "as observed": the snapshot wins everywhere. The tools default to
 *     `dryRun: true` exactly so this mode is a deliberate choice, never a default.
 *
 * The index is rebuilt after a restore (`ensureIndex`): rows for files that came back
 * must not be answering from a cache built before the restore.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { CONTENT_DIRS, PRIVATE_STATE_DIR, ROOT_META_FILE } from './conventions.js'
import { ensureIndex } from './index-freshness.js'
import type { IndexFreshnessState } from './index-freshness.js'
import { readZip, writeZip } from './zip.js'
import { ZipError } from './zip.js'
import type { ZipEntry } from './zip.js'

/** `dataDir/backups`: the plugin's own backup directory, outside every book. */
export const BACKUPS_DIR = 'backups'

/** Default retention; `settings.json`'s `backupKeep` overrides it (1–50, D3). */
export const BACKUP_KEEP_DEFAULT = 5

/** Clamp bounds for `backupKeep`, restated here so a caller without settings still clamps. */
export const BACKUP_KEEP_MIN = 1
export const BACKUP_KEEP_MAX = 50

/**
 * Root-level files a backup carries besides the content directories (D4).
 *
 * `.gitignore` matters because the plugin appends ignore lines to it (ADR-0012):
 * losing it means a restore quietly starts tracking `.inkflow/`.
 */
export const BACKUP_ROOT_FILES = [ROOT_META_FILE, '.gitignore'] as const

/**
 * Directories never included, by plan rather than by accident: the derived index,
 * git's own history, and the private state directory (the recovery bin and the
 * backup packages inside the book — D4 keeps a net from nesting).
 */
export const BACKUP_EXCLUDED_DIRS = ['index', '.git', PRIVATE_STATE_DIR] as const

/** The one exception inside the excluded private state dir, opted into (`includeTrash`). */
export const BACKUP_TRASH_DIR = `${PRIVATE_STATE_DIR}/trash`

/** A refusal a caller reports instead of a stack trace. */
export type BackupZipErrorCode =
  | 'BACKUP_ZIP_INVALID'
  | 'BACKUP_ZIP_NOT_FOUND'
  | 'BACKUP_ZIP_UNSAFE'
  | 'BACKUP_CONFLICT'
  | 'BACKUP_WRITE_FAILED'
  /** No file in the package belongs to a book (a foreign ZIP, or every entry excluded). */
  | 'BACKUP_EMPTY'

export interface BackupZipError {
  code: BackupZipErrorCode
  message: string
  hint?: string
  /** Book-relative path the refusal is about (conflicts name one). */
  path?: string
  /** `BACKUP_CONFLICT` only: every file that was skipped, in package order. */
  conflicts?: Array<{ path: string; reason: string }>
  /** `BACKUP_CONFLICT` only: what the partial run already put back. */
  restored?: string[]
}

export type BackupZipResult<T> = { ok: true; value: T } | { ok: false; error: BackupZipError }

/** One package on disk, as the list route and the panel see it. */
export interface BackupPackage {
  /** File name, `<slug>-<stamp>.zip`; the identifier a caller passes back. */
  file: string
  /** `YYYYMMDD-HHmmss` in UTC (D3) — sorts chronologically as a string. */
  stamp: string
  bytes: number
  /** Entry count and the newest entry mtime in the package, both best-effort. */
  entries: number
  createdAt: string
  bookSlug: string
}

/** One entry's verdict in a restore plan. */
export interface RestorePlanEntry {
  path: string
  /** `create` = not on disk, `overwrite` = differs, `same` = identical (nothing to do). */
  action: 'create' | 'overwrite' | 'same'
  /** Bytes in the package. */
  bytes: number
  /** sha256 of the packaged bytes — the digest a caller hands back in `expected`. */
  sha256: string
  /** sha256 of the file on disk right now, or `null` when absent. */
  current: string | null
}

/** A dry run: what a restore would do, with zero writes. */
export interface RestorePlan {
  file: string
  bookSlug: string
  /** Entries that would be written (create + overwrite). `same` entries are not. */
  entries: RestorePlanEntry[]
  counts: { create: number; overwrite: number; same: number }
  /** Files on disk the package does not hold: never deleted by a restore, only reported. */
  extra: string[]
}

/** What a restore did. Present even on `BACKUP_CONFLICT`, so a partial run is legible. */
export interface RestoreReport {
  file: string
  restored: string[]
  /** Entries skipped because their current bytes no longer matched the plan. */
  conflicts: Array<{ path: string; reason: string }>
  /** Entries already identical to the package: no write, no byte changed. */
  unchanged: string[]
  /** Files the book has and the package does not (left alone on purpose). */
  extra: string[]
  index: { state: IndexFreshnessState; rebuilt: boolean; ok: boolean; message?: string }
}

// ---------------------------------------------------------------------------
// Stamps, slugs and paths
// ---------------------------------------------------------------------------

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The stamp in a package name: `YYYYMMDD-HHmmss`, in **UTC** (D3).
 *
 * UTC rather than local time because two backups taken in the same local hour across
 * a DST change would otherwise collide or sort backwards, and because a package name
 * that means a different instant on another machine is a name nobody can audit.
 */
export function backupStampZip(at: Date): string {
  const iso = at.toISOString() // 2026-10-24T09:30:00.000Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`
}

/**
 * A book's slug: its directory name with the characters Windows forbids replaced by
 * `-` (D3). Collisions are possible (two books named `我的书` in different parents),
 * which is exactly why the package filename is not the only identity — the tool also
 * carries the book root it came from in its reply.
 */
export function bookSlugOf(root: string): string {
  const name = basename(resolve(root))
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, '-').replace(/-{2,}/g, '-')
  return cleaned.replace(/^-+|-+$/g, '') === '' ? 'book' : cleaned.replace(/^-+|-+$/g, '')
}

/** `dataDir/backups`. */
export function backupsDir(dataDir: string): string {
  return join(dataDir, BACKUPS_DIR)
}

function packPattern(slug: string): RegExp {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped}-(\\d{8}-\\d{6})(?:-(\\d+))?\\.zip$`)
}

// ---------------------------------------------------------------------------
// What goes into a package (D4)
// ---------------------------------------------------------------------------

export interface CollectOptions {
  /** Take `<book>/.inkflow/trash/` with it (D4: an opt-in, never the default). */
  includeTrash?: boolean
  /** Book-relative directory names a caller wants skipped (settings' `excludeDirs`). */
  excludeDirs?: readonly string[]
}

/** `true` for a book-relative path the package carries; the one set D4 defines. */
function included(relativePath: string, options: CollectOptions): boolean {
  const path = relativePath.replaceAll('\\', '/')
  if (path === '') return false
  const first = path.split('/')[0] as string
  for (const excluded of options.excludeDirs ?? []) {
    if (path === excluded || path.startsWith(`${excluded}/`)) return false
  }
  if ((BACKUP_EXCLUDED_DIRS as readonly string[]).includes(first)) {
    // `includeTrash` is the one door into the private state dir, and only into `trash/`
    // (D4): a package that carried the in-book backups would nest a net inside a net.
    return first === PRIVATE_STATE_DIR && options.includeTrash === true && path.startsWith(`${BACKUP_TRASH_DIR}/`)
  }
  if (!path.includes('/')) return (BACKUP_ROOT_FILES as readonly string[]).includes(path)
  return (CONTENT_DIRS as readonly string[]).includes(first)
}

/**
 * Every book-relative path a package carries, sorted.
 *
 * Sorted so two backups of an unchanged book produce the same entry order and a
 * diff of two packages is readable; symlinks are skipped rather than followed, since
 * a link can name a file outside the book and a backup must not leak the machine.
 */
export function collectBackupFiles(root: string, options: CollectOptions = {}): string[] {
  const out: string[] = []
  const walk = (absoluteDir: string): void => {
    let entries
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const absolutePath = join(absoluteDir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      const relativePath = relative(root, absolutePath).replaceAll('\\', '/')
      if (included(relativePath, options)) out.push(relativePath)
    }
  }
  walk(resolve(root))
  return out.sort()
}

// ---------------------------------------------------------------------------
// Creating a package
// ---------------------------------------------------------------------------

export interface CreateBackupOptions extends CollectOptions {
  /** Timestamp to name the package with; defaults to now (tests pass a fixed one). */
  at?: Date
  /** Retention to apply after writing; defaults to `BACKUP_KEEP_DEFAULT`. */
  keep?: number
}

export interface CreateBackupValue {
  file: string
  /** Absolute path of the package (the host's own path, never a request's). */
  path: string
  bookSlug: string
  stamp: string
  /** Entry count = file count. */
  files: number
  /** Which paths went in, so a caller can show or diff them. */
  entries: string[]
  bytes: number
  /** Packages deleted by retention, oldest first. */
  pruned: string[]
}

function clampKeep(keep: number | undefined): number {
  if (keep === undefined || !Number.isFinite(keep)) return BACKUP_KEEP_DEFAULT
  return Math.min(Math.max(Math.trunc(keep), BACKUP_KEEP_MIN), BACKUP_KEEP_MAX)
}

/**
 * The name a new artifact takes: `<slug>-<stamp><ext>`, or `-2`, `-3`… when a file of the
 * same second already exists.
 *
 * Resolved BEFORE writing rather than after a collision: D3's stamp has one-second
 * resolution, so two artifacts in the same second are normal (a tool call and a panel
 * click), and checking afterwards would leave the first one behind with a name nobody
 * asked for. Exported because the exporter (ADR-0024 D4) names its files by the same
 * rule and a second copy of it would drift.
 */
export function freeStampedName(dir: string, slug: string, stamp: string, ext: string): string {
  const first = `${slug}-${stamp}${ext}`
  if (!existsSync(join(dir, first))) return first
  for (let attempt = 2; attempt <= 99; attempt += 1) {
    const candidate = `${slug}-${stamp}-${String(attempt)}${ext}`
    if (!existsSync(join(dir, candidate))) return candidate
  }
  return `${slug}-${stamp}-${String(Date.now())}${ext}`
}

/** `freeStampedName` for the one extension this module writes. */
function freePackageName(dir: string, slug: string, stamp: string): string {
  return freeStampedName(dir, slug, stamp, '.zip')
}

/**
 * Write one package of `root` and apply retention.
 *
 * Refuses a book with nothing to back up (`BACKUP_EMPTY`) instead of writing a ZIP
 * with zero entries: an empty package would count against retention and put back
 * nothing, which is worse than an honest refusal.
 */
export function createBookBackup(
  root: string,
  dataDir: string,
  options: CreateBackupOptions = {},
): BackupZipResult<CreateBackupValue> {
  const bookRoot = resolve(root)
  const entries = collectBackupFiles(bookRoot, options)
  if (entries.length === 0) {
    return {
      ok: false,
      error: {
        code: 'BACKUP_EMPTY',
        message: 'this book has no file a backup would carry',
        hint: 'a package holds the nine content directories plus inkflow.json and .gitignore; check that this directory is a book',
      },
    }
  }

  const slug = bookSlugOf(bookRoot)
  const stamp = backupStampZip(options.at ?? new Date())
  const dir = backupsDir(dataDir)
  const write = (name: string): CreateBackupValue => {
    const payload: ZipEntry[] = []
    for (const path of entries) {
      try {
        payload.push({ path, bytes: readFileSync(join(bookRoot, ...path.split('/'))) })
      } catch (cause) {
        throw new Error(`${path} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`)
      }
    }
    let archive: Buffer
    try {
      archive = writeZip(payload, { at: options.at ?? new Date() })
    } catch (cause) {
      throw new Error(cause instanceof Error ? cause.message : String(cause))
    }
    const target = join(dir, name)
    // Atomic: a half-written package would be the only copy of "yesterday".
    const temp = `${target}.tmp-${String(process.pid)}`
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(temp, archive)
      renameSync(temp, target)
    } catch (cause) {
      try {
        rmSync(temp, { force: true })
      } catch {
        // A leftover temp file is cosmetic; the failure below is what matters.
      }
      throw new Error(cause instanceof Error ? cause.message : String(cause))
    }
    return {
      file: name,
      path: target,
      bookSlug: slug,
      stamp,
      files: entries.length,
      entries,
      bytes: archive.byteLength,
      pruned: [],
    }
  }

  let value: CreateBackupValue
  try {
    value = write(freePackageName(dir, slug, stamp))
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'BACKUP_WRITE_FAILED',
        message: `the backup package could not be written: ${cause instanceof Error ? cause.message : String(cause)}`,
        hint: 'nothing in the book was touched; check free space and permissions on the plugin data directory',
      },
    }
  }

  value.pruned = pruneBookBackups(dataDir, slug, clampKeep(options.keep))
  return { ok: true, value }
}

/** Every package of one book, newest first. */
export function listBookBackups(dataDir: string, slug: string): BackupPackage[] {
  const dir = backupsDir(dataDir)
  const pattern = packPattern(slug)
  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => pattern.test(name))
  } catch {
    return []
  }
  const out: BackupPackage[] = []
  for (const name of names) {
    const path = join(dir, name)
    let bytes = 0
    let createdAt = ''
    try {
      const stats = statSync(path)
      bytes = stats.size
      createdAt = stats.mtime.toISOString()
    } catch {
      continue
    }
    const match = pattern.exec(name)
    out.push({
      file: name,
      stamp: match?.[1] ?? '',
      bytes,
      entries: countEntriesSafe(path),
      createdAt,
      bookSlug: slug,
    })
  }
  // Name order is chronological because the stamp is fixed-width UTC; the numeric
  // suffix of a same-second package keeps its sort position next to its sibling.
  return out.sort((left, right) => (left.file < right.file ? 1 : left.file > right.file ? -1 : 0))
}

function countEntriesSafe(path: string): number {
  try {
    return readZip(readFileSync(path)).length
  } catch {
    return 0
  }
}

/**
 * Keep the newest `keep` packages of one book, delete the rest (D3).
 *
 * Only names this module writes are candidates (`<slug>-<stamp>[-n].zip`), so a ZIP
 * the author dropped into the directory by hand is never deleted by retention.
 */
export function pruneBookBackups(dataDir: string, slug: string, keep: number): string[] {
  const limit = clampKeep(keep)
  const packages = listBookBackups(dataDir, slug)
  const doomed = packages.slice(limit)
  const removed: string[] = []
  // Oldest first, so an interrupted prune leaves the newest intact.
  for (const pack of [...doomed].reverse()) {
    try {
      rmSync(join(backupsDir(dataDir), pack.file), { force: true })
      removed.push(pack.file)
    } catch {
      // A package that cannot be removed stays; the next run tries again.
    }
  }
  return removed
}

// ---------------------------------------------------------------------------
// Reading a package back
// ---------------------------------------------------------------------------

export interface OpenBackupValue {
  file: string
  bookSlug: string
  entries: ZipEntry[]
}

/**
 * Load one package by file name.
 *
 * The name is validated against `<slug>-<stamp>.zip` for the book it is asked about,
 * so a request can address a package but never a path: `../` or an absolute name
 * cannot reach the directory, and one book cannot read another's packages.
 */
export function openBookBackup(dataDir: string, slug: string, file: string): BackupZipResult<OpenBackupValue> {
  if (!packPattern(slug).test(file)) {
    return {
      ok: false,
      error: {
        code: 'BACKUP_ZIP_NOT_FOUND',
        message: `${file} is not a backup of ${slug}`,
        hint: 'name a package the list returned for this book',
      },
    }
  }
  const path = join(backupsDir(dataDir), file)
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    return {
      ok: false,
      error: { code: 'BACKUP_ZIP_NOT_FOUND', message: `${file} is not in the backup directory`, hint: 'refresh the backup list' },
    }
  }
  try {
    return { ok: true, value: { file, bookSlug: slug, entries: readZip(bytes) } }
  } catch (cause) {
    const code = cause instanceof ZipError && cause.code === 'ZIP_PATH_INVALID' ? 'BACKUP_ZIP_UNSAFE' : 'BACKUP_ZIP_INVALID'
    return {
      ok: false,
      error: {
        code,
        message: `${file} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`,
        hint: 'the package is damaged or was not written by this plugin; nothing was changed in the book',
      },
    }
  }
}

/**
 * Compare a package with the book as it is now. Writes nothing (D6).
 *
 * Entries that the packager would never have written (`index/…`, `.git/…`, an
 * absolute name) are refused as a whole package rather than skipped: a package that
 * claims to be a backup of this book but carries something the backup rules exclude
 * is not a package this code should be putting on disk.
 */
export function planRestore(
  root: string,
  dataDir: string,
  slug: string,
  file: string,
): BackupZipResult<RestorePlan> {
  const opened = openBookBackup(dataDir, slug, file)
  if (!opened.ok) return opened
  const bookRoot = resolve(root)

  const entries: RestorePlanEntry[] = []
  for (const entry of opened.value.entries) {
    if (!included(entry.path, {})) {
      return {
        ok: false,
        error: {
          code: 'BACKUP_ZIP_UNSAFE',
          message: `${file} holds ${entry.path}, which no backup of a book carries`,
          hint: 'a backup holds the nine content directories plus inkflow.json and .gitignore; this package is not one',
          path: entry.path,
        },
      }
    }
    const absolutePath = join(bookRoot, ...entry.path.split('/'))
    let current: string | null = null
    try {
      current = sha256Hex(readFileSync(absolutePath))
    } catch {
      current = null
    }
    const sha256 = sha256Hex(entry.bytes)
    entries.push({
      path: entry.path,
      action: current === null ? 'create' : current === sha256 ? 'same' : 'overwrite',
      bytes: entry.bytes.byteLength,
      sha256,
      current,
    })
  }

  const packed = new Set(entries.map((entry) => entry.path))
  const extra = collectBackupFiles(bookRoot).filter((path) => !packed.has(path))
  return {
    ok: true,
    value: {
      file,
      bookSlug: slug,
      entries,
      counts: {
        create: entries.filter((entry) => entry.action === 'create').length,
        overwrite: entries.filter((entry) => entry.action === 'overwrite').length,
        same: entries.filter((entry) => entry.action === 'same').length,
      },
      extra,
    },
  }
}

export interface RestoreOptions {
  /**
   * The digests the caller saw in the plan (path → sha256, `null` = "was absent").
   *
   * Absent = restore as observed. Present = per-file compare-and-swap: a file whose
   * bytes moved since the plan is a conflict and is skipped, the rest still proceeds.
   */
  expected?: Readonly<Record<string, string | null>>
  /** Rebuild the derived index afterwards; defaults to true (D6). */
  rebuildIndex?: boolean
}

/**
 * Put a package back, per-file, then rebuild the index (D6).
 *
 * A conflict never stops the run: the author's newer text is left alone and named in
 * the report, and the answer is `BACKUP_CONFLICT` carrying both lists so the caller
 * can show "restored 12, skipped 1" instead of a bare failure.
 *
 * Async because the rebuild is (`buildIndex`): the files are back before the await,
 * and the index verdict travels as data — a failed rebuild never undoes a restore.
 */
export async function restoreBookBackup(
  root: string,
  dataDir: string,
  slug: string,
  file: string,
  options: RestoreOptions = {},
): Promise<BackupZipResult<RestoreReport>> {
  const planned = planRestore(root, dataDir, slug, file)
  if (!planned.ok) return planned
  const plan = planned.value
  const bookRoot = resolve(root)
  const opened = openBookBackup(dataDir, slug, file)
  if (!opened.ok) return opened

  const restored: string[] = []
  const unchanged: string[] = []
  const conflicts: Array<{ path: string; reason: string }> = []
  const expected = options.expected

  for (const entry of opened.value.entries) {
    const plannedEntry = plan.entries.find((candidate) => candidate.path === entry.path)
    if (plannedEntry === undefined) {
      conflicts.push({ path: entry.path, reason: 'the package changed while it was being restored' })
      continue
    }
    if (plannedEntry.action === 'same') {
      // Nothing will be written, so there is nothing to lose and no baseline to
      // demand: the file on disk already IS the packaged bytes.
      unchanged.push(entry.path)
      continue
    }
    if (expected !== undefined) {
      // A file the caller's plan did not name has no baseline, and "a baseline I never
      // saw" must not licence overwriting it.
      if (!Object.prototype.hasOwnProperty.call(expected, entry.path)) {
        conflicts.push({ path: entry.path, reason: 'no baseline was given for this file, so overwriting it is not allowed' })
        continue
      }
      const wanted = expected[entry.path] ?? null
      if (wanted !== plannedEntry.current) {
        conflicts.push({
          path: entry.path,
          reason:
            plannedEntry.current === null
              ? 'it was absent when the plan was made and is not any more'
              : 'it changed after the plan was made, so the snapshot would overwrite newer work',
        })
        continue
      }
    }
    const target = join(bookRoot, ...entry.path.split('/'))
    try {
      mkdirSync(dirname(target), { recursive: true })
      // Atomic, and byte-verbatim: a restored file must be the file that was backed
      // up, BOM and CRLF included (ADR-0016's rule for every copy this plugin makes).
      const temp = `${target}.inkflow-restore-${String(process.pid)}`
      writeFileSync(temp, entry.bytes)
      renameSync(temp, target)
    } catch (cause) {
      conflicts.push({
        path: entry.path,
        reason: `could not be written: ${cause instanceof Error ? cause.message : String(cause)}`,
      })
      continue
    }
    if (sha256Hex(readFileSync(target)) !== plannedEntry.sha256) {
      conflicts.push({ path: entry.path, reason: 'the bytes on disk do not match the package after writing' })
      continue
    }
    restored.push(entry.path)
  }

  const index = await rebuildAfterRestore(bookRoot, options.rebuildIndex !== false)
  const report: RestoreReport = { file, restored, conflicts, unchanged, extra: plan.extra, index }
  if (conflicts.length > 0) {
    return {
      ok: false,
      error: {
        code: 'BACKUP_CONFLICT',
        message: `the restore could not finish: ${conflicts.map((conflict) => `${conflict.path} (${conflict.reason})`).join('; ')}`,
        hint: `${String(restored.length)} file(s) were restored and ${String(unchanged.length)} were already identical; resolve the conflicts above and run the restore again`,
        conflicts,
        restored,
      },
    }
  }
  return { ok: true, value: report }
}

/**
 * Rebuild the derived index after a restore.
 *
 * The restore is already complete when this runs — this only makes the CACHE catch
 * up with the bytes. Its failure is reported, never thrown: an unusable index costs
 * one rebuild, while an exception here would report a finished restore as failed.
 */
async function rebuildAfterRestore(root: string, rebuild: boolean): Promise<RestoreReport['index']> {
  if (!rebuild) return { state: 'fresh', rebuilt: false, ok: true, message: 'index rebuild skipped on request' }
  try {
    const ensured = await ensureIndex(root, { rebuild: true })
    if (ensured.ok) {
      return {
        state: ensured.state,
        rebuilt: ensured.rebuilt,
        ok: true,
        ...(ensured.rebuilt ? { message: 'index rebuilt from the restored files' } : {}),
      }
    }
    return { state: ensured.state, rebuilt: false, ok: false, message: ensured.failure.message }
  } catch (cause) {
    return { state: 'stale', rebuilt: false, ok: false, message: cause instanceof Error ? cause.message : String(cause) }
  }
}
