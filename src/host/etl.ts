/**
 * The migration **run**: book → staged copies → per-file rename → one backup package
 * (roadmap X-29 / X-30).
 *
 * `etl-plan.ts` decides *what* the book should contain; this module decides *how it gets
 * there* without ever leaving a half-migrated book behind:
 *
 *   `planEtl`     reads the old database, the id map and the file tree. **Zero writes**
 *                 — not a temp file, not the id map, not `index/`.
 *   `applyEtl`    re-runs that same computation (X-29: dry run IS the execution), then
 *                 stages every file under the backup package, moves them into place one
 *                 lock-batch at a time (X-30), writes the id map and rebuilds the two
 *                 projections.
 *   `rollbackEtl` replays the package: the manifest knows what landed, the `staging/`
 *                 directory still holds what never did. Either way the book goes back to
 *                 "nothing from this run", not to "half a book".
 *
 * Four rules this file is built around, each with a failure mode it prevents:
 *
 *   1. **The staging copy is the file that moves.** Writing straight into `chapters/…`
 *      would let a crash leave half a document; a staged copy plus `rename(2)` is atomic
 *      per file, and the staging area sits inside `.inkflow/` (ADR-0012) so even the
 *      intermediate state is invisible to the index and to `git status`.
 *   2. **One lock per batch, never per run** (X-30): a 1000-file migration that held the
 *      project write lock for its whole duration would make the GUI unable to save a
 *      chapter for minutes — a lock that long is indistinguishable from a deadlock. A
 *      batch is `batchSize` files (default 25); the lock is released between them.
 *   3. **Never overwrite.** A path that already holds other bytes is a `conflict` in the
 *      plan, and the runner refuses it again at the last moment (a file could appear
 *      between the plan and the rename).
 *   4. **The idempotency key is `(table, id)`** (X-29): the id map in
 *      `.inkflow/backup/etl-idmap.json` records what each row became, so a second run
 *      writes zero files. Ids come from the legacy uuid when there is one (ADR-0014), so
 *      migrated references keep resolving.
 *
 * `git` is never run: the baseline commit is a **string** (`commitSuggestion`) the caller
 * prints. Data-safety §3 puts commits under the author's hand, and a plugin that commits
 * on its own would also be a plugin that can lose a history to a bad `--amend`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  digestRelative,
  newBackupBody,
  openBackup,
  rollbackBackup,
  sealBackup,
} from './backup.js'
import type { BackupBody, BackupError, BackupHandle } from './backup.js'
import { rebuildCatalog } from './catalog.js'
import { INDEX_DIR, PRIVATE_STATE_DIR } from './conventions.js'
import { buildEtlPlan } from './etl-plan.js'
import type { EtlComputation, EtlIdMap, EtlIdMapEntry, EtlItem, EtlPlan } from './etl-plan.js'
import { ETL_IDMAP_RELATIVE, ETL_IDMAP_VERSION } from './etl-plan.js'
import { readLegacyBook } from './etl-source.js'
import type { EtlSourceError } from './etl-source.js'
import { fingerprintProjectFile } from './file-cas.js'
import { buildIndex, describeIndexBuildFailure } from './index-build.js'
import { removeProjectFile, resolveWriteTarget, withProjectWriteLock, writeJsonAtomic, writeTextAtomic } from './io.js'
import { detectFindings } from './repair.js'

/** Files moved into place per lock acquisition (X-30). */
export const ETL_DEFAULT_BATCH_SIZE = 25

/** Upper bound on one batch: bigger only makes the lock window wider. */
export const ETL_MAX_BATCH_SIZE = 200

export interface EtlRunOptions {
  /** Absolute path of the old `inkflow.db` (opened read-only). */
  readonly sourcePath: string
  /** Legacy project selector: uuid, exact name, substring, or number. */
  readonly project?: string
  readonly renumber?: 'keep' | 'compact'
  readonly batchSize?: number
}

export interface EtlError {
  code: string
  message: string
  hint?: string
  path?: string
  /** `PROJECT_BUSY` only: who holds the write lock. */
  lockHolder?: { readonly pid?: number; readonly startedAt?: string }
  rolledBack?: boolean
  rollback?: { readonly dir: string; readonly restored: readonly string[]; readonly removed: readonly string[]; readonly code?: string }
}

export type EtlPlanResult = { ok: true; plan: EtlPlan } | { ok: false; error: EtlError }
export type EtlIdMapResult = { ok: true; idmap: EtlIdMap | undefined } | { ok: false; error: EtlError }

export interface EtlApplyValue {
  readonly plan: EtlPlan
  readonly written: ReadonlyArray<{ readonly path: string; readonly key: string }>
  readonly skipped: ReadonlyArray<{ readonly key: string; readonly path: string; readonly reason: string }>
  readonly batches: number
  readonly batchSize: number
  readonly backup: { readonly dir: string; readonly sealed: boolean; readonly files: number }
  readonly idmap: { readonly path: string; readonly entries: number }
  readonly catalog: { readonly ok: boolean; readonly written: number }
  readonly index: { readonly ok: boolean; readonly error?: { readonly code: string; readonly message: string } }
  readonly invariants: { readonly issues: number; readonly codes: Readonly<Record<string, number>> }
  readonly commitSuggestion: string
  readonly ms: number
}

export type EtlApplyResult = { ok: true; value: EtlApplyValue } | { ok: false; error: EtlError }

export interface EtlRollbackValue {
  readonly backup: string
  readonly restored: readonly string[]
  readonly removed: readonly string[]
  readonly dirsRemoved: readonly string[]
  readonly stagingCleared: number
}

export type EtlRollbackResult = { ok: true; value: EtlRollbackValue } | { ok: false; error: EtlError }

function fail(code: string, message: string, extra: Partial<EtlError> = {}): { ok: false; error: EtlError } {
  return { ok: false, error: { code, message, ...extra } }
}

function sourceFailure(error: EtlSourceError): { ok: false; error: EtlError } {
  return fail(error.code, error.message, {
    ...(error.hint === undefined ? {} : { hint: error.hint }),
    ...(error.path === undefined ? {} : { path: error.path }),
  })
}

function backupFailure(error: BackupError): { ok: false; error: EtlError } {
  return fail(error.code, error.message, {
    ...(error.path === undefined ? {} : { path: error.path }),
    ...(error.hint === undefined ? {} : { hint: error.hint }),
  })
}

function clampBatch(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return ETL_DEFAULT_BATCH_SIZE
  return Math.max(1, Math.min(ETL_MAX_BATCH_SIZE, Math.trunc(value)))
}

// ---------------------------------------------------------------------------
// The id map (`.inkflow/backup/etl-idmap.json`, X-29)
// ---------------------------------------------------------------------------

function readIdMapEntries(root: string): { entries: EtlIdMapEntry[]; broken: boolean } {
  const absolute = join(root, ...ETL_IDMAP_RELATIVE.split('/'))
  if (!existsSync(absolute)) return { entries: [], broken: false }
  let text: string
  try {
    text = readFileSync(absolute, 'utf8')
  } catch {
    return { entries: [], broken: true }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { entries: [], broken: true }
  }
  const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  // A newer map shape is refused rather than guessed at: writing it back would downgrade
  // whatever a later build recorded.
  if (record['schemaVersion'] !== ETL_IDMAP_VERSION) return { entries: [], broken: true }
  const rawEntries = Array.isArray(record['entries']) ? record['entries'] : []
  const entries: EtlIdMapEntry[] = []
  for (const raw of rawEntries) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Record<string, unknown>
    const table = entry['table']
    const id = entry['id']
    const path = entry['path']
    const sha256 = entry['sha256']
    if (typeof table !== 'string' || typeof id !== 'number' || typeof path !== 'string' || typeof sha256 !== 'string') continue
    entries.push({
      table: table as EtlIdMapEntry['table'],
      id,
      entityId: typeof entry['entityId'] === 'string' ? entry['entityId'] : path,
      path,
      sha256,
    })
  }
  return { entries, broken: false }
}

/** Read the map as it is on disk (read-only; the panel and the tests use it). */
export function readEtlIdMap(root: string): EtlIdMapResult {
  const absolute = join(root, ...ETL_IDMAP_RELATIVE.split('/'))
  if (!existsSync(absolute)) return { ok: true, idmap: undefined }
  const { entries, broken } = readIdMapEntries(root)
  if (broken) {
    return fail('ETL_IDMAP_INVALID', `${ETL_IDMAP_RELATIVE} is unreadable or carries a different schemaVersion`, {
      path: ETL_IDMAP_RELATIVE,
      hint: 'move it aside and re-run the plan; a migration without its map repeats itself, it does not lose data',
    })
  }
  const source = readIdMapSource(root)
  return {
    ok: true,
    idmap: {
      schemaVersion: ETL_IDMAP_VERSION,
      source: source ?? { db: 'inkflow.db', projectId: 0 },
      updatedAt: readIdMapUpdatedAt(root) ?? new Date(0).toISOString(),
      entries,
    },
  }
}

function readIdMapSource(root: string): EtlIdMap['source'] | undefined {
  const absolute = join(root, ...ETL_IDMAP_RELATIVE.split('/'))
  try {
    const parsed = JSON.parse(readFileSync(absolute, 'utf8')) as Record<string, unknown>
    const source = parsed['source']
    if (typeof source !== 'object' || source === null) return undefined
    const record = source as Record<string, unknown>
    if (typeof record['db'] !== 'string' || typeof record['projectId'] !== 'number') return undefined
    return {
      db: record['db'],
      projectId: record['projectId'],
      ...(typeof record['projectUuid'] === 'string' ? { projectUuid: record['projectUuid'] } : {}),
    }
  } catch {
    return undefined
  }
}

function readIdMapUpdatedAt(root: string): string | undefined {
  const absolute = join(root, ...ETL_IDMAP_RELATIVE.split('/'))
  try {
    const parsed = JSON.parse(readFileSync(absolute, 'utf8')) as Record<string, unknown>
    return typeof parsed['updatedAt'] === 'string' ? parsed['updatedAt'] : undefined
  } catch {
    return undefined
  }
}

/**
 * Merge this run's entries into the map.
 *
 * Merge, not replace: a book may be migrated project by project (the old file holds 106
 * of them), and wiping the map because a second run covered a different project would
 * make the first project's rows migrate a second time.
 */
function writeIdMap(
  root: string,
  plan: EtlPlan,
  items: readonly EtlItem[],
): { ok: true; path: string; entries: number } | { ok: false; error: EtlError } {
  const existing = readIdMapEntries(root)
  const merged = new Map<string, EtlIdMapEntry>()
  for (const entry of existing.entries) merged.set(`${entry.table}:${String(entry.id)}`, entry)
  for (const item of items) {
    if (item.state === 'conflict') continue
    const [table, rawId] = item.key.split(':')
    if (table === undefined) continue
    merged.set(item.key, {
      table: table as EtlIdMapEntry['table'],
      id: Number.parseInt(rawId ?? '0', 10) || 0,
      entityId: item.entityId,
      path: item.path,
      sha256: item.sha256,
    })
  }
  const idmap: EtlIdMap = {
    schemaVersion: ETL_IDMAP_VERSION,
    source: {
      db: plan.source.db,
      projectId: plan.source.projectId,
      ...(plan.source.projectUuid === undefined ? {} : { projectUuid: plan.source.projectUuid }),
    },
    updatedAt: new Date().toISOString(),
    entries: [...merged.values()].sort((left, right) => `${left.table}:${String(left.id)}`.localeCompare(`${right.table}:${String(right.id)}`)),
  }
  const written = writeJsonAtomic(root, ETL_IDMAP_RELATIVE, idmap)
  if (!written.ok) return { ok: false, error: { code: written.error.code, message: written.error.message, path: ETL_IDMAP_RELATIVE } }
  return { ok: true, path: ETL_IDMAP_RELATIVE, entries: merged.size }
}

// ---------------------------------------------------------------------------
// The disk probe the plan needs (the one place that stats files)
// ---------------------------------------------------------------------------

function makeProbe(root: string): { probe(path: string, sha256: string): 'same' | 'different' | 'absent' } {
  return {
    probe(path, sha256) {
      const fingerprint = fingerprintProjectFile(root, path)
      if (fingerprint === undefined) return 'absent'
      return fingerprint.sha256 === sha256 ? 'same' : 'different'
    },
  }
}

/** Everything both `planEtl` and `applyEtl` need, computed once (X-29). */
function compute(root: string, options: EtlRunOptions): { ok: true; value: EtlComputation } | { ok: false; error: EtlError } {
  const read = readLegacyBook({
    dbPath: options.sourcePath,
    ...(options.project === undefined ? {} : { project: options.project }),
  })
  if (!read.ok) return sourceFailure(read.error)

  const { entries, broken } = readIdMapEntries(root)
  const prior = new Map<string, EtlIdMapEntry>()
  if (!broken) for (const entry of entries) prior.set(`${entry.table}:${String(entry.id)}`, entry)

  const computation = buildEtlPlan(read.value, {
    ...(options.renumber === undefined ? {} : { renumber: options.renumber }),
    probe: makeProbe(root),
    prior,
  })
  return { ok: true, value: computation }
}

/** Nothing is written here: the id map is only read, the file tree only stat'ed. */
export function planEtl(root: string, options: EtlRunOptions): EtlPlanResult {
  const computed = compute(root, options)
  if (!computed.ok) return computed
  return { ok: true, plan: computed.value.plan }
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface EtlApplyInput extends EtlRunOptions {
  /** X-17/X-29: no write happens without this. */
  readonly confirm?: boolean
  /** The `planToken` the preview returned; a mismatch is `ETL_PLAN_STALE`. */
  readonly planToken?: string
  /**
   * The preview's item set (`[{key, count}]`). When given, this run writes only the items
   * that are in **both** sets: an item that disappeared or changed shape is skipped and
   * reported, never silently replaced (X-29).
   */
  readonly items?: ReadonlyArray<{ readonly key: string; readonly count: number }>
}

function lockHolderOf(root: string): { pid?: number; startedAt?: string } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(root, INDEX_DIR, '.write.lock'), 'utf8')) as Record<string, unknown>
    const pid = typeof parsed['pid'] === 'number' ? parsed['pid'] : undefined
    const startedAt = typeof parsed['startedAt'] === 'number' ? new Date(parsed['startedAt']).toISOString() : undefined
    return { ...(pid === undefined ? {} : { pid }), ...(startedAt === undefined ? {} : { startedAt }) }
  } catch {
    return undefined
  }
}

/**
 * Turn any `io.ts` failure into the tool-facing shape, naming the lock holder when the cause
 * is `PROJECT_BUSY`.
 *
 * X-30 asks for `PROJECT_BUSY` **and** who is writing: staging, each batch and the id map
 * each take the lock on their own, so the same code can surface from three places and each
 * of them has to carry the same answer (a bare "busy" leaves the model unable to tell the
 * author which session to wait for).
 */
function lockAwareFailure(
  root: string,
  error: { code: string; message: string; path?: string; hint?: string },
  extra: Partial<EtlError> = {},
): { ok: false; error: EtlError } {
  const busy = error.code === 'PROJECT_BUSY'
  return fail(error.code, error.message, {
    ...(error.path === undefined ? {} : { path: error.path }),
    ...extra,
    ...(busy
      ? {
          lockHolder: lockHolderOf(root) ?? {},
          hint:
            'another session (or another process) holds index/.write.lock; wait for it to finish and re-run — already-migrated files are skipped by the id map, so the run continues where this one stopped',
        }
      : error.hint === undefined
        ? { hint: 'the files already moved are listed in the package manifest; roll back or re-run to continue' }
        : { hint: error.hint }),
  })
}

function stagingDirOf(handle: BackupHandle): string {
  return `${handle.dir}/staging`
}

/** Absolute path of a project-relative path. */
function absoluteOf(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'))
}

/** The staged copy of one planned file, inside the package. */
function stagedPathOf(handle: BackupHandle, item: EtlItem): string {
  return `${stagingDirOf(handle)}/${privateStateStripped(item.path)}`
}

/**
 * The staged path mirrors the target path so a person reading the package sees where each
 * file was going. `privateStateStripped` is not needed for the current writers (no target
 * lives under `.inkflow/`), but keeping the helper explicit means a future target under
 * `.inkflow/` cannot silently produce a `staging/.inkflow/…` double prefix.
 */
function privateStateStripped(relativePath: string): string {
  const prefix = `${PRIVATE_STATE_DIR}/`
  return relativePath.startsWith(prefix) ? relativePath.slice(prefix.length) : relativePath
}

/**
 * Move one staged file into place, holding the caller's lock.
 *
 * The three checks before the rename are the difference between "a migration" and "a data
 * loss incident": the destination must still be a legal write target, it must still be
 * free, and the staged copy must still exist.
 */
function placeOne(
  root: string,
  handle: BackupHandle,
  item: EtlItem,
): { ok: true; digest: { bytes: number; sha256: string }; createdDirs: string[] } | { ok: false; error: EtlError } {
  const resolved = resolveWriteTarget(root, item.path)
  if (!resolved.ok) {
    return fail(resolved.error.code, `the target path was refused: ${resolved.error.message}`, {
      path: item.path,
      ...(resolved.error.hint === undefined ? {} : { hint: resolved.error.hint }),
    })
  }
  const target = resolved.target.absolute
  if (existsSync(target)) {
    // Re-checked at the last moment: the plan said "absent", but another session (or the
    // author) could have created it while this run was staging.
    return fail('ETL_TARGET_EXISTS', `${item.path} appeared while this run was staging; it is left alone`, {
      path: item.path,
      hint: 're-run the plan: it will report the file as a conflict',
    })
  }
  const staged = absoluteOf(root, stagedPathOf(handle, item))
  if (!existsSync(staged)) {
    return fail('ETL_STAGING_MISSING', `the staged copy of ${item.path} is gone`, { path: stagedPathOf(handle, item) })
  }
  // Directories this file brings into being, outermost first: the manifest needs them or a
  // rollback would leave empty `chapters/vol-01-…` shells behind (ADR-0015 D9's lesson).
  const createdDirs: string[] = []
  const segments = item.path.split('/').slice(0, -1)
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const relative = segments.slice(0, depth).join('/')
    if (!existsSync(absoluteOf(root, relative))) createdDirs.push(relative)
  }
  try {
    mkdirSync(resolved.target.parent, { recursive: true })
    renameSync(staged, target)
  } catch (cause) {
    return fail('ETL_RENAME_FAILED', `${item.path} could not be moved into place: ${cause instanceof Error ? cause.message : String(cause)}`, {
      path: item.path,
    })
  }
  const fingerprint = fingerprintProjectFile(root, item.path)
  if (fingerprint === undefined) return fail('ETL_RENAME_FAILED', `${item.path} is not there after the move`, { path: item.path })
  return { ok: true, digest: { bytes: fingerprint.size, sha256: fingerprint.sha256 }, createdDirs }
}

/**
 * Run the migration.
 *
 * Order is the contract:
 *   1. `confirm`, then the same `compute()` the preview ran, then the token comparison;
 *   2. the item-set comparison (X-29) — drifted items are skipped and reported;
 *   3. open the package, seal it `sealed: false`, stage every file;
 *   4. move the files in, `batchSize` at a time, each batch inside one lock;
 *   5. merge the id map, seal the package, rebuild catalog + index;
 *   6. collect the invariants the new tree produces (they are a *report*, not a gate: the
 *      files are the truth and a finding is a decision for the author).
 */
export async function applyEtl(root: string, input: EtlApplyInput): Promise<EtlApplyResult> {
  if (input.confirm !== true) {
    return fail('CONFIRM_REQUIRED', 'the migration writes files into chapters/, characters/, world/, outlines/, foreshadowing/, timeline/, relations/ and library/', {
      hint: 'run inkflow_etl_plan first, show the plan, then call apply with confirm: true and that planToken',
    })
  }

  const computed = compute(root, input)
  if (!computed.ok) return computed
  const { plan, writes } = computed.value

  if (input.planToken !== undefined && input.planToken !== plan.planToken) {
    return fail('ETL_PLAN_STALE', 'the book or the source database changed since the preview', {
      hint: 'run inkflow_etl_plan again and confirm the plan it returns',
    })
  }

  // X-29: the preview set and the execution set are compared as sets, per item.
  const expected = input.items === undefined ? undefined : new Set(input.items.filter((item) => item.count > 0).map((item) => item.key))
  const skipped: Array<{ key: string; path: string; reason: string }> = []
  // Whatever the plan itself refuses to write is reported the same way a drifted item is:
  // a conflict is "the preview promised a file here, and it cannot be written now".
  for (const item of plan.items) {
    if (item.state !== 'conflict') continue
    skipped.push({ key: item.key, path: item.path, reason: `${item.code ?? 'ETL_CONFLICT'}: ${item.detail ?? ''}`.trim() })
  }
  const toWrite = writes.filter((write) => {
    if (expected === undefined) return true
    if (expected.has(write.key)) return true
    skipped.push({ key: write.key, path: write.path, reason: 'ETL_PLAN_DRIFT: 预览里没有这一条（或已变样），本次跳过' })
    return false
  })
  if (expected !== undefined) {
    const plannedKeys = new Set(plan.items.map((item) => item.key))
    for (const key of expected) {
      if (plannedKeys.has(key)) continue
      const known = plan.items.find((item) => item.key === key)
      skipped.push({ key, path: known?.path ?? '', reason: 'ETL_PLAN_DRIFT: 预览里有这一条，但这次算不出来（跳过而不是替换）' })
    }
  }

  const startedAt = process.hrtime.bigint()
  const batchSize = clampBatch(input.batchSize)

  const opened = openBackup(root, 'migrate')
  if (!opened.ok) return backupFailure(opened.error)
  const handle = opened.value
  const body = newBackupBody()

  const sealer = (sealed: boolean): boolean => sealBackup(root, handle, 'migrate', body, sealed).ok

  /**
   * Cover what the batch is about to create *and* what this run may have already created
   * (a resumed run): the manifest is the only thing a rollback replays, so every landed
   * file has to be in it.
   */
  const cover = (path: string, change: 'created' | 'modified', before?: { bytes: number; sha256: string }): void => {
    if (body.files.some((entry) => entry.path === path)) return
    body.files.push({ path, change, ...(before === undefined ? {} : { before }) })
    const digest = digestRelative(root, path)
    if (digest !== undefined) {
      const entry = body.files[body.files.length - 1]
      if (entry !== undefined) entry.after = digest
    }
  }

  // (3) Stage. A copy per file, verified as it is written; nothing in the book changes.
  for (const write of toWrite) {
    const stagedRelative = `${stagingDirOf(handle)}/${privateStateStripped(write.path)}`
    const written = writeTextAtomic(root, stagedRelative, write.text)
    if (!written.ok) {
      sealer(false)
      return lockAwareFailure(root, written.error, {
        hint: `nothing in the book changed; the package ${handle.dir} holds only staged copies (if it exists at all)`,
      })
    }
    body.steps.push(`stage ${write.path}`)
  }
  if (!sealer(false)) {
    return fail('ETL_BACKUP_UNSEALED', `the backup manifest could not be written in ${handle.dir}`, {
      path: handle.manifestPath,
      hint: 'nothing in the book changed; check the disk and permissions',
    })
  }

  // (4) Move in, one lock per batch (X-30).
  const written: Array<{ path: string; key: string }> = []
  const stagedItems = toWrite.map((write) => {
    const item = plan.items.find((candidate) => candidate.key === write.key)
    return { write, item }
  })
  const valid = stagedItems.filter((entry): entry is { write: (typeof toWrite)[number]; item: EtlItem } => entry.item !== undefined)
  let batches = 0
  for (let offset = 0; offset < valid.length; offset += batchSize) {
    const batch = valid.slice(offset, offset + batchSize)
    const locked = withProjectWriteLock(root, () => {
      // Every file in the batch, or a code naming the first one that failed.
      for (const entry of batch) {
        const placed = placeOne(root, handle, entry.item)
        if (!placed.ok) return placed
        for (const dir of placed.createdDirs) if (!body.dirs.includes(dir)) body.dirs.push(dir)
        cover(entry.write.path, 'created')
        body.steps.push(`rename ${entry.write.path}`)
        written.push({ path: entry.write.path, key: entry.write.key })
      }
      return { ok: true as const }
    })
    if (!locked.ok) {
      sealer(false)
      return lockAwareFailure(root, locked.error, {
        rolledBack: false,
        rollback: { dir: handle.dir, restored: [], removed: [] },
      })
    }
    if (!locked.value.ok) {
      const failure = locked.value.error
      sealer(false)
      return fail(failure.code, failure.message, {
        ...(failure.path === undefined ? {} : { path: failure.path }),
        ...(failure.hint === undefined ? {} : { hint: failure.hint }),
        rolledBack: false,
        rollback: { dir: handle.dir, restored: [], removed: [] },
      })
    }
    batches += 1
    // Journal after every batch: an interruption names exactly what landed, and the
    // staging directory still holds everything that did not.
    sealer(false)
  }

  // (5) The id map, then seal.
  const idmap = writeIdMap(root, plan, plan.items)
  if (!idmap.ok) {
    sealer(false)
    return fail(idmap.error.code, `the id map could not be written: ${idmap.error.message}`, {
      path: ETL_IDMAP_RELATIVE,
      hint: 'the migrated files are on disk; fix the write problem and re-run (nothing is written twice)',
      rolledBack: false,
      rollback: { dir: handle.dir, restored: [], removed: [] },
    })
  }
  const sealed = sealer(true)

  // The staged copies that were moved are gone; what is left is the residue of a batch
  // that never ran (a refusal above). Removing an empty staging directory keeps the
  // package readable without hiding anything: the files are still in the manifest.
  clearEmptyStaging(root, handle)

  const catalogResult = rebuildCatalog(root)
  let indexOk = false
  let indexError: { code: string; message: string } | undefined
  try {
    // `buildIndex` throws an `IndexBuildError`; the index is a cache, so a failure here is
    // reported and never rolls the files back (the same policy as `chapters.ts`).
    await buildIndex(root)
    indexOk = true
  } catch (cause) {
    const described = describeIndexBuildFailure(cause)
    indexError = { code: described.code, message: described.message }
  }

  const findings = detectFindings(root)
  const codes: Record<string, number> = {}
  for (const finding of findings.findings) codes[finding.code] = (codes[finding.code] ?? 0) + 1

  return {
    ok: true,
    value: {
      plan,
      written,
      skipped,
      batches,
      batchSize,
      backup: { dir: handle.dir, sealed, files: body.files.length },
      idmap: { path: idmap.path, entries: idmap.entries },
      catalog: { ok: catalogResult.ok, written: catalogResult.ok ? catalogResult.written.length : 0 },
      index: { ok: indexOk, ...(indexError === undefined ? {} : { error: indexError }) },
      invariants: { issues: findings.findings.length, codes },
      commitSuggestion: plan.commitSuggestion,
      ms: Number(process.hrtime.bigint() - startedAt) / 1e6,
    },
  }
}

/** Remove the staging directory when it is empty; leave it alone when it still holds copies. */
function clearEmptyStaging(root: string, handle: BackupHandle): void {
  const relative = stagingDirOf(handle)
  const absolute = absoluteOf(root, relative)
  if (!existsSync(absolute)) return
  let entries: string[]
  try {
    entries = readdirSync(absolute)
  } catch {
    return
  }
  if (entries.length > 0) return
  try {
    rmdirSync(absolute)
  } catch {
    // Cosmetic: an empty directory inside a private package hurts nothing.
  }
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

export interface EtlRollbackInput {
  /** The package directory name (`20261025T…Z`) or its project-relative path. */
  readonly backup: string
  readonly confirm?: boolean
}

/**
 * Undo one migration run.
 *
 * Two halves, and both are needed: the manifest removes every file the run created (with
 * a byte check first, so a chapter the author edited afterwards is a conflict rather than
 * a casualty), and `staging/` is cleared of the copies the run never moved. Doing only
 * the first would leave a directory of orphans that looks like data.
 */
export function rollbackEtl(root: string, input: EtlRollbackInput): EtlRollbackResult {
  if (input.confirm !== true) {
    return fail('CONFIRM_REQUIRED', 'a rollback deletes the files this migration created', {
      hint: 'pass confirm: true once the user agrees to undo the run',
    })
  }
  const name = input.backup.trim()
  if (name === '') {
    return fail('ETL_BACKUP_REQUIRED', 'pass the backup directory name the apply returned', { path: ETL_IDMAP_RELATIVE })
  }
  const undone = rollbackBackup(root, name)
  if (!undone.ok) return backupFailure(undone.error)

  const staging = `${undone.dir}/staging`
  let cleared = 0
  const stagingAbs = absoluteOf(root, staging)
  if (existsSync(stagingAbs)) {
    // Everything under staging is a copy of a file that never landed: removing it can only
    // lose text that the book already has, or never got (in which case the plan is the
    // copy that matters, and re-running the plan regenerates it).
    for (const path of walkRelative(root, staging)) {
      // Staged copies live under `.inkflow/backup/…`, which `resolveWriteTarget` allows, so
      // the removal goes through the one write door like every other file operation.
      if (removeProjectFile(root, path).ok) cleared += 1
    }
    clearEmptyStaging(root, { dir: undone.dir, manifestPath: `${undone.dir}/manifest.json` })
  }

  return {
    ok: true,
    value: {
      backup: undone.dir,
      restored: undone.restored,
      removed: undone.removed,
      dirsRemoved: undone.dirsRemoved,
      stagingCleared: cleared,
    },
  }
}

function walkRelative(root: string, relativeDir: string): string[] {
  const out: string[] = []
  const visit = (relative: string): void => {
    let names: string[]
    try {
      names = readdirSync(join(root, ...relative.split('/')))
    } catch {
      return
    }
    for (const name of names) {
      const child = `${relative}/${name}`
      let isDirectory = false
      try {
        isDirectory = statSync(join(root, ...child.split('/'))).isDirectory()
      } catch {
        isDirectory = false
      }
      if (isDirectory) visit(child)
      else out.push(child)
    }
  }
  visit(relativeDir)
  return out
}
