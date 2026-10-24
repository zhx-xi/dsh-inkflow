/**
 * The rollback package (#36, roadmap X-9 / X-10, [ADR-0012](../../.agents/adrs/0012-plugin-private-state-dir.md)).
 *
 * One batch change (a repair pass, a 6→9 layout migration) writes before/after
 * digests and byte copies into `<book>/.inkflow/backup/<stamp>/` **before** the
 * first change lands, so "undo that batch" never depends on the process still
 * being alive. The recovery bin (#35) shares the directory but not the format
 * (X-10): that one is a user-facing list with manual purging, this one is a
 * one-shot machine-read journal.
 *
 * Four properties, each checkable:
 *
 *   1. **The manifest is written before the change**, then re-sealed with the
 *      post-change digest. A crash between the two leaves a manifest whose
 *      `sealed: false` says exactly that, and the copies are already on disk.
 *   2. **A copy is verified as it is taken** ([`stageFile`]): the bytes are read
 *      back and compared, because "we have a backup" has to be a measurement.
 *   3. **A file the text writer cannot reproduce is refused** before anything
 *      changes — same rule as the bin's (`TRASH_COPY_MISMATCH`), for the same
 *      reason: `io.ts` is text-only, so a non-UTF-8 source would come back
 *      different.
 *   4. **Rollback verifies the current bytes before overwriting.** A file edited
 *      after the batch is a `BACKUP_CONFLICT` with zero writes for that file: the
 *      author's newer text wins over an old snapshot.
 *
 * Why not reuse the bin: a restore there is per-entry and addressed by id, and
 * it refuses to overwrite anything. A batch rollback has to put N files back
 * *and* delete the N it created, in one verified pass — sharing the format would
 * force one of the two to grow fields it never uses.
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { PRIVATE_STATE_DIR } from './conventions.js'
import { fingerprintProjectFile } from './file-cas.js'
import { removeProjectFile, writeJsonAtomic, writeTextAtomic } from './io.js'
import { ensurePrivateStateIgnored, privateStateDirRelative, privateStateRelative } from './private-state.js'

/** Shape version of `manifest.json`; a different value is refused, never migrated. */
export const BACKUP_SCHEMA_VERSION = 1

/** The manifest file name inside one backup directory. */
export const BACKUP_MANIFEST_FILE = 'manifest.json'

/** Where the byte copies live inside one backup directory. */
export const BACKUP_FILES_DIR = 'files'

/**
 * Which batch produced the package — the two maintenance passes (#36) and the four
 * 0.4.0 producers that reuse this package instead of inventing their own
 * (roadmap X-17: batch import, id replace, shared-content copy, restore).
 *
 * One closed list rather than a union per issue: a kind the writer accepts but a
 * reader refuses is a package nobody can roll back, so writer and reader both take
 * their vocabulary from `BACKUP_KINDS`. `shared` is the shared-library copy/update
 * batch (#40, ADR-0007 C2/C3): one package per copy or per per-entry update, so
 * "undo that refresh" does not depend on git.
 */
export const BACKUP_KINDS = ['repair', 'migrate', 'import', 'replace', 'shared', 'restore'] as const

export type BackupKind = (typeof BACKUP_KINDS)[number]

/** What a file is, as far as a restore cares. */
export interface BackupDigest {
  bytes: number
  sha256: string
}

/** One covered file: what it was, what this batch made it. */
export interface BackupFileEntry {
  /** Project-relative path, forward slashes. */
  path: string
  /**
   * `created` = this batch brought it into being; `modified` = it existed before
   * and has new bytes; `removed` = this batch deleted it.
   */
  change: 'created' | 'modified' | 'removed'
  /** Present for `modified` / `removed`: the digest the copy holds. */
  before?: BackupDigest
  /** The digest this batch left behind; absent for `removed`. A rollback refuses when it no longer matches. */
  after?: BackupDigest
}

export interface BackupManifest {
  schemaVersion: number
  kind: BackupKind
  createdAt: string
  /** `true` once the batch finished; `false` means an interrupted run (partial state). */
  sealed: boolean
  /** `${op} ${path}` per executed step, in execution order — the journal. */
  steps: string[]
  /** Directories this batch created, outermost first. */
  dirs: string[]
  files: BackupFileEntry[]
  /**
   * Paths a rollback deliberately leaves in place: `git init` is additive (an
   * empty repository is not data, and deleting `.git` would be the one
   * destructive undo in the plugin).
   */
  kept: string[]
  /** ISO time of the last successful rollback; a second rollback is refused. */
  rolledBackAt?: string
}

/** An open package: where it lives, nothing sealed yet. */
export interface BackupHandle {
  /** Project-relative directory, `.inkflow/backup/<stamp>`. */
  dir: string
  /** Project-relative manifest path. */
  manifestPath: string
  /**
   * Non-fatal problems that happened while the package was opened (#149).
   *
   * Only one value today: `gitignore-not-updated` — the `.gitignore` append failed, so
   * the package's files will show up as untracked. The batch still runs; the caller
   * surfaces this instead of pretending the ignore rule is in place.
   */
  warnings?: readonly string[]
}

export interface BackupError {
  code: string
  message: string
  root?: string
  path?: string
  hint?: string
}

export type BackupResult<T> = { ok: true; value: T } | { ok: false; error: BackupError }

function fail(code: string, message: string, extra: Partial<BackupError> = {}): { ok: false; error: BackupError } {
  return { ok: false, error: { code, message, ...extra } }
}

/**
 * A sortable, filename-safe stamp: `20261024T015500123Z`.
 *
 * Colons are illegal in Windows paths, so ISO 8601 cannot be the directory name;
 * milliseconds keep two runs in the same second apart, and a numeric suffix (see
 * `openBackup`) covers the rest.
 */
export function backupStamp(at: Date = new Date()): string {
  const iso = at.toISOString() // 2026-10-24T01:55:00.123Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}${iso.slice(20, 23)}Z`
}

function absolute(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'))
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The digest of a project file right now; `undefined` when it is not there. */
export function digestRelative(root: string, relativePath: string): BackupDigest | undefined {
  const fingerprint = fingerprintProjectFile(root, relativePath)
  return fingerprint === undefined ? undefined : { bytes: fingerprint.size, sha256: fingerprint.sha256 }
}

/** A digest of staged text, for a caller that computed the bytes it is about to write. */
function digestOf(text: string): BackupDigest {
  const bytes = Buffer.from(text, 'utf8')
  return { bytes: bytes.byteLength, sha256: sha256Hex(bytes) }
}

/** The copy's project-relative path for one covered file. */
export function backupCopyPath(dir: string, relativePath: string): string {
  return `${dir}/${BACKUP_FILES_DIR}/${relativePath.replace(/^\/+/, '')}`
}

/**
 * Create the package directory for this batch and return its handle.
 *
 * The directory is created lazily by the first `stageFile` / `sealBackup` write
 * (both go through `io.ts`), so a batch that writes nothing leaves no empty
 * directory behind. `.gitignore` gains `.inkflow/` here, before the first copy —
 * the same append-only discipline as the bin (ADR-0012 #2).
 */
export function openBackup(root: string, kind: BackupKind, at: Date = new Date()): BackupResult<BackupHandle> {
  const base = backupStamp(at)
  let name = base
  for (let attempt = 2; attempt <= 99; attempt += 1) {
    if (!existsSync(absolute(root, privateStateRelative('backup', name)))) break
    name = `${base}-${String(attempt)}`
  }
  const dir = privateStateRelative('backup', name)
  // A failed `.gitignore` append is NOT fatal — the copies still have to land, and a
  // backup that refuses to start because one ignore line is unwritable would be the
  // wrong trade. It is reported instead (#149): before this, both branches returned
  // the same object, so the caller could not tell "ignored" from "not ignored" and
  // the recovery bin's files quietly showed up as untracked in `git status`.
  const ignored = ensurePrivateStateIgnored(root)
  return {
    ok: true,
    value: {
      dir,
      manifestPath: `${dir}/${BACKUP_MANIFEST_FILE}`,
      ...(ignored.ok ? {} : { warnings: ['gitignore-not-updated'] as const }),
    },
  }
}

/**
 * Copy the current bytes of `relativePath` into the package and return their digest.
 *
 * `undefined` means the file does not exist yet (this batch created it). The copy
 * is read back and compared, so a short write cannot pass as a backup.
 */
export function stageFile(
  root: string,
  handle: BackupHandle,
  relativePath: string,
): BackupResult<BackupDigest | undefined> {
  const source = absolute(root, relativePath)
  if (!existsSync(source)) return { ok: true, value: undefined }

  let text: string
  try {
    if (!statSync(source).isFile()) {
      return fail('BACKUP_SOURCE_NOT_FILE', `${relativePath} is not a file`, { root, path: relativePath })
    }
    text = readFileSync(source, 'utf8')
  } catch (cause) {
    return fail('BACKUP_SOURCE_UNREADABLE', `${relativePath} could not be read: ${String(cause)}`, {
      root,
      path: relativePath,
    })
  }
  // Invariant 3: the copy has to survive the text writer byte for byte.
  const expected = sha256Hex(readFileSync(source))
  if (sha256Hex(Buffer.from(text, 'utf8')) !== expected) {
    return fail(
      'BACKUP_COPY_MISMATCH',
      `${relativePath} is not valid UTF-8, so a byte-exact copy cannot be made through the text writer`,
      {
        root,
        path: relativePath,
        hint: 'the file is left untouched; convert it to UTF-8 in the editor first',
      },
    )
  }

  const copy = backupCopyPath(handle.dir, relativePath)
  const written = writeTextAtomic(root, copy, text, { verbatim: true })
  if (!written.ok) {
    return fail(written.error.code, `the backup copy of ${relativePath} could not be written: ${written.error.message}`, {
      root,
      path: copy,
    })
  }
  const fingerprint = fingerprintProjectFile(root, copy)
  if (fingerprint === undefined || fingerprint.sha256 !== expected) {
    removeProjectFile(root, copy)
    return fail('BACKUP_COPY_MISMATCH', `the backup copy of ${relativePath} does not match the original bytes`, {
      root,
      path: relativePath,
      hint: 'the file is left untouched',
    })
  }
  return { ok: true, value: { bytes: Buffer.byteLength(text, 'utf8'), sha256: expected } }
}

/** The body the caller assembles while it runs. */
export interface BackupBody {
  steps: string[]
  dirs: string[]
  files: BackupFileEntry[]
  kept: string[]
}

export function newBackupBody(): BackupBody {
  return { steps: [], dirs: [], files: [], kept: [] }
}

/**
 * Write the manifest.
 *
 * Called twice per batch in the interrupted case: once with `sealed: false` right
 * after the package opens (so a crash leaves a readable journal), once with
 * `sealed: true` when the batch finishes. `steps` / `files` grow between the two.
 */
export function sealBackup(
  root: string,
  handle: BackupHandle,
  kind: BackupKind,
  body: BackupBody,
  sealed: boolean,
  at: Date = new Date(),
): BackupResult<BackupManifest> {
  const manifest: BackupManifest = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    kind,
    createdAt: at.toISOString(),
    sealed,
    steps: [...body.steps],
    dirs: [...body.dirs],
    files: [...body.files],
    kept: [...body.kept],
  }
  const written = writeJsonAtomic(root, handle.manifestPath, manifest)
  if (!written.ok) {
    return fail(written.error.code, `the backup manifest could not be written: ${written.error.message}`, {
      root,
      path: handle.manifestPath,
    })
  }
  return { ok: true, value: manifest }
}

/** One manifest read back: the parsed body plus where it came from. */
export interface BackupReadOk {
  ok: true
  dir: string
  manifestPath: string
  manifest: BackupManifest
}

export type BackupReadResult = BackupReadOk | { ok: false; error: BackupError }

/**
 * Accept either the backup directory name (`20261024T…Z`) or its full
 * project-relative path, and refuse anything that is not inside `.inkflow/backup/`.
 */
export function normalizeBackupDir(input: string): string | undefined {
  const normalised = input.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
  const prefix = privateStateDirRelative('backup')
  const relative = normalised.startsWith(`${prefix}/`) ? normalised : `${prefix}/${normalised}`
  const segments = relative.split('/')
  if (segments.length !== 3) return undefined
  if (segments[0] !== PRIVATE_STATE_DIR || segments[1] !== 'backup') return undefined
  if (segments[2] === '' || segments[2] === '.' || segments[2] === '..') return undefined
  return relative
}

function readEntry(raw: unknown): BackupFileEntry | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const path = record['path']
  const change = record['change']
  if (typeof path !== 'string' || path === '') return undefined
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined
  if (change !== 'created' && change !== 'modified' && change !== 'removed') return undefined
  const readDigest = (value: unknown): BackupDigest | undefined => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const digest = value as Record<string, unknown>
    const bytes = digest['bytes']
    const sha256 = digest['sha256']
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return undefined
    if (typeof sha256 !== 'string' || sha256.length !== 64) return undefined
    return { bytes, sha256 }
  }
  const afterDigest = readDigest(record['after'])
  const beforeDigest = readDigest(record['before'])
  // Every change kind has to carry the digests its undo needs, or the package
  // would promise a restore it cannot verify.
  if (change !== 'removed' && afterDigest === undefined) return undefined
  if (change !== 'created' && beforeDigest === undefined) return undefined
  return {
    path,
    change,
    ...(beforeDigest === undefined ? {} : { before: beforeDigest }),
    ...(afterDigest === undefined ? {} : { after: afterDigest }),
  }
}

/** Whether a value read out of a manifest is one of the kinds this build writes. */
function isBackupKind(value: unknown): value is BackupKind {
  return typeof value === 'string' && (BACKUP_KINDS as readonly string[]).includes(value)
}

/** Read one package's manifest; anything unreadable is refused, never rebuilt. */
export function readBackup(root: string, dirInput: string): BackupReadResult {
  const dir = normalizeBackupDir(dirInput)
  if (dir === undefined) {
    return fail('BACKUP_PATH_INVALID', `${String(dirInput)} is not a backup directory name`, { root, path: dirInput })
  }
  const manifestPath = `${dir}/${BACKUP_MANIFEST_FILE}`
  const file = absolute(root, manifestPath)
  if (!existsSync(file)) {
    return fail('BACKUP_NOT_FOUND', `no backup package at ${dir}`, {
      root,
      path: manifestPath,
      hint: 'list the packages with `inkflow_project_migrate` action `plan` (it reports them) or look in .inkflow/backup/',
    })
  }
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (cause) {
    return fail('BACKUP_MANIFEST_INVALID', `${manifestPath} could not be read: ${String(cause)}`, { root, path: manifestPath })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return fail('BACKUP_MANIFEST_INVALID', `${manifestPath} is not JSON`, { root, path: manifestPath })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return fail('BACKUP_MANIFEST_INVALID', `${manifestPath} is not a JSON object`, { root, path: manifestPath })
  }
  const record = parsed as Record<string, unknown>
  if (record['schemaVersion'] !== BACKUP_SCHEMA_VERSION) {
    return fail(
      'BACKUP_MANIFEST_INVALID',
      `${manifestPath} has schemaVersion ${String(record['schemaVersion'])}; this build reads ${BACKUP_SCHEMA_VERSION}`,
      { root, path: manifestPath },
    )
  }
  const kind = record['kind']
  // A word this build does not know is refused, not coerced to a default: reading a
  // foreign package as "some other batch" would make its report lie about what it is.
  if (!isBackupKind(kind)) {
    return fail('BACKUP_MANIFEST_INVALID', `${manifestPath} has an unknown kind`, { root, path: manifestPath })
  }
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  const rawFiles = record['files']
  if (!Array.isArray(rawFiles)) {
    return fail('BACKUP_MANIFEST_INVALID', `${manifestPath} has no \`files\` array`, { root, path: manifestPath })
  }
  const files: BackupFileEntry[] = []
  for (const raw of rawFiles) {
    const entry = readEntry(raw)
    if (entry === undefined) {
      return fail('BACKUP_MANIFEST_INVALID', `${manifestPath} holds a file entry that cannot be restored`, {
        root,
        path: manifestPath,
      })
    }
    files.push(entry)
  }

  return {
    ok: true,
    dir,
    manifestPath,
    manifest: {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      kind,
      createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : '',
      sealed: record['sealed'] === true,
      steps: strings(record['steps']),
      dirs: strings(record['dirs']),
      files,
      kept: strings(record['kept']),
      ...(typeof record['rolledBackAt'] === 'string' ? { rolledBackAt: record['rolledBackAt'] } : {}),
    },
  }
}

/** Every package in the book, newest first (by directory name). */
export function listBackups(root: string): Array<{ dir: string; sealed: boolean; kind: BackupKind; createdAt: string; files: number }> {
  const dir = absolute(root, privateStateDirRelative('backup'))
  let names: string[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse()
  } catch {
    return []
  }
  const out: Array<{ dir: string; sealed: boolean; kind: BackupKind; createdAt: string; files: number }> = []
  for (const name of names) {
    const read = readBackup(root, name)
    if (!read.ok) continue
    out.push({
      dir: read.dir,
      sealed: read.manifest.sealed,
      kind: read.manifest.kind,
      createdAt: read.manifest.createdAt,
      files: read.manifest.files.length,
    })
  }
  return out
}

export interface RollbackOk {
  ok: true
  root: string
  dir: string
  /** Files put back byte for byte. */
  restored: string[]
  /** Files this batch created and the rollback removed. */
  removed: string[]
  /** Created directories removed (deepest first). */
  dirsRemoved: string[]
  /** Paths left alone on purpose, with the reason. */
  kept: Array<{ path: string; reason: string }>
}

export type RollbackResult = RollbackOk | { ok: false; error: BackupError }

function sameDigest(left: BackupDigest | undefined, right: Buffer | undefined): boolean {
  if (left === undefined || right === undefined) return left === undefined && right === undefined
  return left.bytes === right.byteLength && left.sha256 === sha256Hex(right)
}

/**
 * Put one staged copy back, verbatim (BOM and CRLF included), and verify the
 * result against the digest the manifest recorded.
 *
 * `verbatim: true` is the whole point: the normal write path strips a BOM and
 * rewrites CRLF, which would hand back "the same text" instead of the same bytes.
 *
 * Root-level book metadata (`inkflow.json`, `.gitignore`) is deliberately outside
 * `resolveWriteTarget`'s whitelist (only the scaffolding path writes it — ADR-0006
 * D3), so a restore falls back to the same direct write the wizard and the migrator
 * use for those two files. The fallback is reachable **only** for a path with no
 * directory part and only for `PATH_NOT_WRITABLE`: everything else keeps the
 * whitelist's refusal.
 */
function writeBackCopy(root: string, dir: string, entry: BackupFileEntry): boolean {
  const copy = absolute(root, backupCopyPath(dir, entry.path))
  let text: string
  try {
    text = readFileSync(copy, 'utf8')
  } catch {
    return false
  }
  const written = writeTextAtomic(root, entry.path, text, { verbatim: true })
  if (!written.ok) {
    if (written.error.code !== 'PATH_NOT_WRITABLE' || entry.path.includes('/')) return false
    try {
      writeFileSync(absolute(root, entry.path), text, 'utf8')
    } catch {
      return false
    }
  }
  const fingerprint = fingerprintProjectFile(root, entry.path)
  return fingerprint !== undefined && entry.before !== undefined && fingerprint.sha256 === entry.before.sha256
}

/**
 * Undo one package: modified files get their bytes back, created files are removed.
 *
 * Refusals that write nothing *for that file* (the rest still proceeds, and the
 * report names every conflict):
 *   * a covered file changed after the batch (`BACKUP_CONFLICT`) — the author's
 *     newer text wins over a snapshot;
 *   * a copy is missing or no longer matches its recorded digest.
 *
 * The manifest is then stamped `rolledBackAt` so a second rollback is refused:
 * after a restore the covered files no longer match `after`, and silently doing
 * nothing would look like success.
 */
export function rollbackBackup(projectRoot: string, dirInput: string, at: Date = new Date()): RollbackResult {
  const root = resolve(projectRoot)
  const read = readBackup(root, dirInput)
  if (!read.ok) return read
  if (read.manifest.rolledBackAt !== undefined) {
    return fail('BACKUP_ALREADY_ROLLED_BACK', `${read.dir} was already rolled back at ${read.manifest.rolledBackAt}`, {
      root,
      path: read.manifestPath,
    })
  }

  const restored: string[] = []
  const removed: string[] = []
  const conflicts: string[] = []

  for (const entry of [...read.manifest.files].reverse()) {
    const absolutePath = absolute(root, entry.path)
    const current = existsSync(absolutePath) ? readFileSync(absolutePath) : undefined

    if (entry.change === 'removed') {
      // The batch deleted it, so a file at that path now is somebody's new work.
      if (current !== undefined) {
        conflicts.push(`${entry.path}: was re-created after this batch, so restoring the snapshot would overwrite it`)
        continue
      }
      if (writeBackCopy(root, read.dir, entry)) restored.push(entry.path)
      else conflicts.push(`${entry.path}: its backup copy could not be restored`)
      continue
    }

    if (!sameDigest(entry.after, current)) {
      conflicts.push(
        `${entry.path}: ${current === undefined ? 'is gone' : 'was changed'} after this batch, so the snapshot would overwrite it`,
      )
      continue
    }
    if (entry.change === 'created') {
      const result = removeProjectFile(root, entry.path)
      if (result.ok) removed.push(entry.path)
      else conflicts.push(`${entry.path}: ${result.error.message}`)
      continue
    }
    if (writeBackCopy(root, read.dir, entry)) restored.push(entry.path)
    else conflicts.push(`${entry.path}: its backup copy could not be restored`)
  }

  const dirsRemoved: string[] = []
  for (const dir of [...read.manifest.dirs].reverse()) {
    const target = absolute(root, dir)
    if (!existsSync(target)) continue
    let empty = true
    try {
      empty = readdirSync(target).length === 0
    } catch {
      empty = false
    }
    if (!empty) continue
    try {
      rmdirSync(target)
      dirsRemoved.push(dir)
    } catch {
      // A directory that cannot be removed is cosmetic; the files are what matters.
    }
  }

  const kept = read.manifest.kept.map((path) => ({
    path,
    reason: '`git init` is additive: an empty repository holds no data, and deleting `.git` is the one undo this plugin will not do',
  }))

  if (conflicts.length > 0) {
    // The conflicting files were skipped; everything else was restored, and the
    // manifest stays un-stamped so the same rollback can be retried after the
    // conflict is resolved.
    return fail('BACKUP_CONFLICT', `the rollback could not finish: ${conflicts.join('; ')}`, {
      root,
      path: read.manifestPath,
      hint: `${String(restored.length)} file(s) were restored and ${String(removed.length)} removed before this; resolve the conflicts above and run the rollback again`,
    })
  }

  const stamped = writeJsonAtomic(root, read.manifestPath, { ...read.manifest, rolledBackAt: at.toISOString() })
  if (!stamped.ok) {
    return fail(stamped.error.code, `the files were restored, but the manifest could not be stamped: ${stamped.error.message}`, {
      root,
      path: read.manifestPath,
    })
  }

  return { ok: true, root, dir: read.dir, restored, removed, dirsRemoved, kept }
}

export { digestOf }
