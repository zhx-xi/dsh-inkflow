/**
 * Volume/chapter catalog (ADR-0006 D6): `chapters/index.json` + one
 * `chapters/<vol-dir>/index.json` per volume.
 *
 * The catalog exists so the volume/chapter structure can be reviewed in a
 * `git diff` and read by external tools without scanning the tree. It is a
 * **projection**: the `.md` files (file name + frontmatter) are the truth, and
 * the catalog is regenerated from them. That single rule drives the three
 * exports below:
 *
 *   - `readCatalog` is read-only. A missing, hand-edited or stale catalog is
 *     reported as `catalogStale: true` and the projection from the `.md` files
 *     is returned in memory. A read path that wrote would let a diagnostic
 *     panel, an index rebuild or a second session mutate the user's repository.
 *   - `rebuildCatalog` scans under the project write lock (`index/.write.lock`)
 *     and writes every volume list first and the top-level list last,
 *     so a failure halfway leaves the top-level catalog stale rather than
 *     claiming a structure that is only partly on disk.
 *   - `validateCatalog` reports drift and invariant violations; it never blocks
 *     and never repairs (the derived SQLite index follows the same policy).
 *
 * Ownership rules (`chapter volume`):
 *   1. frontmatter `volume` (a stable `vol-NN` id) wins;
 *   2. otherwise the first directory segment under `chapters/` decides, if that
 *      directory is a volume directory;
 *   3. otherwise the chapter is loose (`looseChapters`).
 * Renaming the volume directory (`vol-01-入山` → `vol-01-开篇`) therefore keeps
 * every `volumeId` and every chapter assignment unchanged, which is the whole
 * point of separating the id from the slug (ADR-0006 D6).
 *
 * Shape notes:
 *   - `volumeId` is canonical `vol-NN` (two digits minimum), derived from the
 *     directory name; `dir` is the directory name and must start with the id;
 *   - `file` is project-relative with `/` separators (`chapters/vol-01/a.md`),
 *     so one field is unambiguous in both catalog files and in the derived index;
 *   - `seq` is omitted when neither frontmatter nor the file name provides one:
 *     a fake `0` would collide with a real chapter 0 and break uniqueness.
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { CatalogChapter, CatalogVolume, ProjectedCatalog, RootCatalog, VolumeCatalog } from './catalog-types.js'
import { STALE_DETAIL } from './catalog-types.js'
import type { DiskCatalogs } from './catalog-projection.js'
import {
  ROOT_CATALOG_PATH,
  inspectCatalogs,
  isDirectory,
  projectCatalog,
  volumeCatalogPath,
} from './catalog-projection.js'
import { CATALOG_SCHEMA_VERSION, CHAPTERS_DIR } from './conventions.js'
import { withProjectWriteLock, writeJsonAtomic } from './io.js'
import type { IoErrorCode, IoFailure } from './io.js'

// The shapes did not move for callers: catalog-types.ts is implementation detail.
export type { CatalogChapter, CatalogVolume, RootCatalog, VolumeCatalog } from './catalog-types.js'

// ---------------------------------------------------------------------------
// Failure helpers
// ---------------------------------------------------------------------------

function ioFailure(
  code: IoErrorCode,
  message: string,
  root: string,
  extra: { path?: string; hint?: string } = {},
): IoFailure {
  const failure: IoFailure = { code, message, root }
  if (extra.path !== undefined) failure.path = extra.path
  if (extra.hint !== undefined) failure.hint = extra.hint
  return failure
}

// ---------------------------------------------------------------------------
// Public read API
// ---------------------------------------------------------------------------

export interface CatalogReadResult {
  root: string
  /** The projection from the `.md` files: always the authoritative answer. */
  catalog: RootCatalog
  /** Per-volume chapter lists, in the same order as `catalog.volumes`. */
  volumeCatalogs: VolumeCatalog[]
  /** True when any catalog file is missing, unreadable or stale. */
  catalogStale: boolean
  /** Project-relative catalog files that need a rebuild (empty when fresh). */
  staleFiles: string[]
}

function emptyProjection(): ProjectedCatalog {
  return { catalog: { schemaVersion: CATALOG_SCHEMA_VERSION, volumes: [], looseChapters: [] }, volumeCatalogs: [] }
}

/**
 * Project the `.md` files into catalog shape **without writing anything**.
 *
 * This is the read path the panel, diagnostics and future tools use: when the
 * catalogs are stale they still get the truth (the `.md` projection) plus a
 * `catalogStale` flag, so nobody has to trust a stale JSON file in order to
 * discover that it is stale.
 */
export function readCatalog(projectRoot: string): CatalogReadResult {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    return { root: '', ...emptyProjection(), catalogStale: true, staleFiles: [] }
  }
  const root = resolve(projectRoot.trim())
  const projected = projectCatalog(root)
  const disk = inspectCatalogs(root, projected)
  return {
    root,
    catalog: projected.catalog,
    volumeCatalogs: projected.volumeCatalogs,
    catalogStale: disk.stale.length > 0,
    staleFiles: disk.stale.map((entry) => entry.path),
  }
}

// ---------------------------------------------------------------------------
// Rebuild: the only writer
// ---------------------------------------------------------------------------

export type CatalogRebuildResult =
  | { ok: true; volumes: CatalogVolume[]; looseChapters: CatalogChapter[]; written: string[] }
  | {
      ok: false
      error: IoFailure
      /** The projection that was being written (empty when the lock was refused). */
      volumes: CatalogVolume[]
      looseChapters: CatalogChapter[]
      /** Catalog files written before the failure (top-level list last). */
      written: string[]
    }

interface RebuildBody {
  projected: ProjectedCatalog
  written: string[]
  error?: IoFailure
}

/**
 * Regenerate both catalog files from the `.md` files.
 *
 * Scanning happens **inside** the project write lock so the projection cannot
 * interleave with a chapter write from another session (acceptance:
 * two sessions writing the same volume must not drop entries). Files are written
 * volume lists first, top-level list last; on failure the top-level catalog is
 * left untouched, so the read path keeps reporting `catalogStale` instead of a
 * half-updated structure.
 *
 * Idempotent by construction: the projection is fully determined by the file
 * tree (sorted volumes, sorted chapters) and JSON is serialised by `io.ts`.
 */
export function rebuildCatalog(projectRoot: string): CatalogRebuildResult {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    return {
      ok: false,
      error: ioFailure('PATH_INVALID', 'a project root is required', ''),
      volumes: [],
      looseChapters: [],
      written: [],
    }
  }
  const root = resolve(projectRoot.trim())
  // Refuse before taking the lock: the lock lives in `index/` and creating it
  // would scaffold a directory inside something that is not a chapter tree.
  if (!isDirectory(join(root, CHAPTERS_DIR))) {
    return {
      ok: false,
      error: ioFailure(
        'PROJECT_NOT_FOUND',
        `${join(root, CHAPTERS_DIR)} is not a directory: this is not a chapter tree (run the workspace wizard first)`,
        root,
      ),
      volumes: [],
      looseChapters: [],
      written: [],
    }
  }

  const locked = withProjectWriteLock(root, (lock): RebuildBody => {
    const projected = projectCatalog(lock.root)
    const written: string[] = []
    for (let index = 0; index < projected.volumeCatalogs.length; index += 1) {
      const catalog = projected.volumeCatalogs[index]
      const volume = projected.catalog.volumes[index]
      if (catalog === undefined || volume === undefined) continue
      const relative = volumeCatalogPath(volume.dir)
      const result = writeJsonAtomic(lock.root, relative, catalog)
      if (!result.ok) return { projected, written, error: result.error }
      written.push(relative)
    }
    const topLevel = writeJsonAtomic(lock.root, ROOT_CATALOG_PATH, projected.catalog)
    if (!topLevel.ok) return { projected, written, error: topLevel.error }
    written.push(ROOT_CATALOG_PATH)
    return { projected, written }
  })

  if (!locked.ok) {
    return { ok: false, error: locked.error, volumes: [], looseChapters: [], written: [] }
  }
  const body = locked.value
  const volumes = body.projected.catalog.volumes
  const looseChapters = body.projected.catalog.looseChapters
  if (body.error !== undefined) return { ok: false, error: body.error, volumes, looseChapters, written: body.written }
  return { ok: true, volumes, looseChapters, written: body.written }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type CatalogIssueCode =
  | 'CATALOG_STALE'
  | 'CATALOG_DUPLICATE'
  | 'VOLUME_DIR_MISMATCH'
  | 'CHAPTER_FILE_MISSING'

/** Non-blocking validation finding; same spirit as `indexer.ValidationIssue`. */
export interface CatalogIssue {
  code: CatalogIssueCode
  /** Project-relative file the issue is about (catalog or chapter). */
  path?: string
  detail: string
}

export interface CatalogValidateResult {
  root: string
  issues: CatalogIssue[]
  catalogStale: boolean
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function asString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/** The four invariants of the truth (the `.md` projection). */
function projectionIssues(projected: ProjectedCatalog): CatalogIssue[] {
  const issues: CatalogIssue[] = []

  const volumeDirs = new Map<string, string>()
  for (const volume of projected.catalog.volumes) {
    const previous = volumeDirs.get(volume.volumeId)
    if (previous !== undefined) {
      issues.push({
        code: 'CATALOG_DUPLICATE',
        path: ROOT_CATALOG_PATH,
        detail: `volumeId "${volume.volumeId}" is used by two directories: ${previous} and ${volume.dir}`,
      })
    } else {
      volumeDirs.set(volume.volumeId, volume.dir)
    }
    if (!volume.dir.startsWith(volume.volumeId)) {
      issues.push({
        code: 'VOLUME_DIR_MISMATCH',
        path: volumeCatalogPath(volume.dir),
        detail: `volume directory "${volume.dir}" must start with its volumeId "${volume.volumeId}" (rename it to ${volume.volumeId}-<slug>)`,
      })
    }
  }

  const volumeSeq = new Map<string, string>()
  for (const catalog of projected.volumeCatalogs) {
    for (const chapter of catalog.chapters) {
      if (chapter.seq === undefined) continue
      const key = `${catalog.volumeId}#${String(chapter.seq)}`
      const previous = volumeSeq.get(key)
      if (previous !== undefined) {
        issues.push({
          code: 'CATALOG_DUPLICATE',
          path: chapter.file,
          detail: `seq ${chapter.seq} is used twice in ${catalog.volumeId} (also ${previous})`,
        })
      } else {
        volumeSeq.set(key, chapter.file)
      }
    }
  }

  const looseSeq = new Map<number, string>()
  for (const chapter of projected.catalog.looseChapters) {
    if (chapter.seq === undefined) continue
    const previous = looseSeq.get(chapter.seq)
    if (previous !== undefined) {
      issues.push({
        code: 'CATALOG_DUPLICATE',
        path: chapter.file,
        detail: `loose chapter seq ${chapter.seq} is used twice (also ${previous})`,
      })
    } else {
      looseSeq.set(chapter.seq, chapter.file)
    }
  }

  return issues
}

function chapterFileIssue(root: string, file: string, catalogPath: string): CatalogIssue | undefined {
  const normalized = file.replaceAll('\\', '/')
  if (!normalized.startsWith(`${CHAPTERS_DIR}/`) || !normalized.toLowerCase().endsWith('.md')) {
    return {
      code: 'CHAPTER_FILE_MISSING',
      path: catalogPath,
      detail: `"${file}" is not a project-relative chapter file under ${CHAPTERS_DIR}/`,
    }
  }
  if (!existsSync(join(root, ...normalized.split('/')))) {
    return { code: 'CHAPTER_FILE_MISSING', path: catalogPath, detail: `listed chapter file "${file}" does not exist` }
  }
  return undefined
}

/** Checks that need the *on-disk* catalog: it may point at files that are gone. */
function onDiskIssues(root: string, disk: DiskCatalogs, projected: ProjectedCatalog): CatalogIssue[] {
  const issues: CatalogIssue[] = []
  // A hand-edited catalog is judged against the projection: a mismatch that the
  // projection already reports must not be repeated (one finding per root cause).
  const projectedIds = new Map(projected.catalog.volumes.map((volume) => [volume.dir, volume.volumeId]))

  const rootRecord = asRecord(disk.rootValue)
  if (rootRecord !== undefined) {
    for (const item of asArray(rootRecord['volumes']) ?? []) {
      const volume = asRecord(item)
      if (volume === undefined) continue
      const volumeId = asString(volume, 'volumeId')
      const dir = asString(volume, 'dir')
      if (volumeId === undefined || dir === undefined) continue
      const projectedId = projectedIds.get(dir)
      if (!dir.startsWith(volumeId)) {
        // A pair the projection already reports is not repeated (one root cause,
        // one finding): `vol-7-散章` is already a VOLUME_DIR_MISMATCH from the
        // directory name alone.
        if (projectedId !== volumeId) {
          issues.push({
            code: 'VOLUME_DIR_MISMATCH',
            path: ROOT_CATALOG_PATH,
            detail: `volume directory "${dir}" must start with its volumeId "${volumeId}"`,
          })
        }
      } else if (projectedId !== undefined && projectedId !== volumeId) {
        issues.push({
          code: 'VOLUME_DIR_MISMATCH',
          path: ROOT_CATALOG_PATH,
          detail: `volume directory "${dir}" lists volumeId "${volumeId}" but belongs to "${projectedId}"`,
        })
      }
      if (!isDirectory(join(root, CHAPTERS_DIR, dir))) {
        issues.push({
          code: 'VOLUME_DIR_MISMATCH',
          path: ROOT_CATALOG_PATH,
          detail: `volume directory "${dir}" does not exist`,
        })
      }
    }
    for (const item of asArray(rootRecord['looseChapters']) ?? []) {
      const chapter = asRecord(item)
      const file = chapter === undefined ? undefined : asString(chapter, 'file')
      if (file === undefined) continue
      const issue = chapterFileIssue(root, file, ROOT_CATALOG_PATH)
      if (issue !== undefined) issues.push(issue)
    }
  }

  for (const [path, value] of disk.volumeValues) {
    const record = asRecord(value)
    if (record === undefined) continue
    const volumeId = asString(record, 'volumeId')
    const dir = path.split('/')[1]
    // The volume catalog lives in its volume directory, so the directory name is
    // the `dir` the invariant talks about even when the file omits `dir`.
    const projectedId = dir === undefined ? undefined : projectedIds.get(dir)
    if (volumeId !== undefined && dir !== undefined) {
      if (!dir.startsWith(volumeId)) {
        if (projectedId !== volumeId) {
          issues.push({
            code: 'VOLUME_DIR_MISMATCH',
            path,
            detail: `volume directory "${dir}" must start with its volumeId "${volumeId}"`,
          })
        }
      } else if (projectedId !== undefined && projectedId !== volumeId) {
        issues.push({
          code: 'VOLUME_DIR_MISMATCH',
          path,
          detail: `volume directory "${dir}" lists volumeId "${volumeId}" but belongs to "${projectedId}"`,
        })
      }
    }
    for (const item of asArray(record['chapters']) ?? []) {
      const chapter = asRecord(item)
      const file = chapter === undefined ? undefined : asString(chapter, 'file')
      if (file === undefined) continue
      const issue = chapterFileIssue(root, file, path)
      if (issue !== undefined) issues.push(issue)
    }
  }

  return issues
}

function dedupeIssues(issues: readonly CatalogIssue[]): CatalogIssue[] {
  const seen = new Set<string>()
  const unique: CatalogIssue[] = []
  for (const issue of issues) {
    const key = `${issue.code}\u0000${issue.path ?? ''}\u0000${issue.detail}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(issue)
  }
  return unique
}

/**
 * Report catalog drift and invariant violations. Never throws, never repairs,
 * never blocks: same policy as the derived index (`validation_issues`).
 *
 * Duplicates are judged on the projection (`.md` is the truth); missing files
 * and directory mismatches are judged on the on-disk catalog, because only a
 * catalog can point at something that no longer exists.
 */
export function validateCatalog(projectRoot: string): CatalogValidateResult {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    return { root: '', issues: [], catalogStale: true }
  }
  const root = resolve(projectRoot.trim())
  const projected = projectCatalog(root)
  const disk = inspectCatalogs(root, projected)

  const issues: CatalogIssue[] = []
  for (const entry of disk.stale) {
    issues.push({ code: 'CATALOG_STALE', path: entry.path, detail: STALE_DETAIL[entry.reason] })
  }
  issues.push(...projectionIssues(projected))
  issues.push(...onDiskIssues(root, disk, projected))

  return { root, issues: dedupeIssues(issues), catalogStale: disk.stale.length > 0 }
}
