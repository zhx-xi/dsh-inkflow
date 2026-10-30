/**
 * The two volume operations.
 *
 * WHY IT IS A FILE: `chapters-ops.ts` still carried both halves — create/rename a volume, and
 * the four chapter operations — which is two different write paths in one file. A volume is a
 * directory plus a catalog row; a chapter is a file plus a row, plus a body and a status. The
 * seam is the data, not the line count.
 */

import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

import { readCatalog, rebuildCatalog } from './catalog.js'
import { CATALOG_FILE, CHAPTERS_DIR, DIR_KEEP_FILE } from './conventions.js'
import { removeEmptyProjectDirectory, removeProjectFile, renameProjectDirectory, withProjectWriteLock, writeTextAtomic } from './io.js'
import type { RollbackStep, VolumeCreateInput, VolumeCreateResult, VolumeRenameInput, VolumeRenameOk, VolumeRenameResult, VolumeView } from './chapters-types.js'
import type { Locked } from './chapters.js'
import { UNTOUCHED_INDEX, afterCatalogFailure, applyFields, callerBaselineRefusal, canonicalVolumeId, chapterFile, chaptersOf, commitIndex, directoryOf, driftedSinceRead, fail, fileNameOf, fromIo, leadingDigitsOf, maxSeq, padSeq, readChapterText, readChapterWithFingerprint, removeIfExists, resolveChapter, resolveSlug, restoreCatalogSnapshot, rollbackStep, slugify, takeCatalogSnapshot, viewOf, volumeNumberOf, withBody } from './chapters.js'

// ---------------------------------------------------------------------------
// inkflow_volume_create
// ---------------------------------------------------------------------------

export async function createVolume(projectRoot: string, input: VolumeCreateInput): Promise<VolumeCreateResult> {
  const root = resolve(projectRoot)

  // Everything from the projection read to the catalog rebuild happens under the
  // one project write lock: a `volumeId` chosen from a pre-lock projection could
  // be taken by another session before this one writes.
  const locked = withProjectWriteLock(root, (lock): Locked<VolumeView> => {
    const root = lock.root
    const title = (input.title ?? '').trim()
    if (title === '') return fail('TITLE_REQUIRED', 'a volume title is required', { root })

    const catalog = readCatalog(root)
    let volumeId: string
    const requested = (input.volumeId ?? '').trim()
    if (requested === '') {
      const highest = catalog.catalog.volumes.reduce((max, volume) => Math.max(max, volume.order), 0)
      volumeId = `vol-${String(highest + 1).padStart(2, '0')}`
    } else {
      const canonical = canonicalVolumeId(requested)
      if (canonical === undefined) {
        return fail('VOLUME_ID_INVALID', `"${requested}" is not a volume id; expected vol-NN (two or more digits)`, {
          root,
        })
      }
      volumeId = canonical
    }
    if (catalog.catalog.volumes.some((volume) => volume.volumeId === volumeId)) {
      return fail('VOLUME_EXISTS', `volume ${volumeId} already exists`, { root })
    }

    const resolvedSlug = resolveSlug(input.slug, title)
    if (!resolvedSlug.ok) return fail('SLUG_INVALID', resolvedSlug.problem, { root })
    const slug = resolvedSlug.value
    const dir = slug === '' ? volumeId : `${volumeId}-${slug}`
    if (existsSync(join(root, CHAPTERS_DIR, dir))) {
      return fail('VOLUME_EXISTS', `the volume directory ${CHAPTERS_DIR}/${dir} already exists`, {
        root,
        path: `${CHAPTERS_DIR}/${dir}`,
      })
    }

    const keep = `${CHAPTERS_DIR}/${dir}/${DIR_KEEP_FILE}`
    const catalogs = takeCatalogSnapshot(root)
    const written = writeTextAtomic(root, keep, '')
    if (!written.ok) {
      return fromIo(written.error, { message: `the volume directory could not be created: ${written.error.message}` })
    }

    const rebuilt = rebuildCatalog(root)
    if (!rebuilt.ok) {
      const steps: RollbackStep[] = []
      rollbackStep(steps, `remove ${keep}`, removeProjectFile(root, keep))
      // The failed rebuild may already have written this volume's own list.
      rollbackStep(steps, `remove ${CHAPTERS_DIR}/${dir}/${CATALOG_FILE}`, removeIfExists(root, `${CHAPTERS_DIR}/${dir}/${CATALOG_FILE}`))
      rollbackStep(steps, `remove ${CHAPTERS_DIR}/${dir}`, removeEmptyProjectDirectory(root, `${CHAPTERS_DIR}/${dir}`))
      steps.push(...restoreCatalogSnapshot(root, catalogs))
      return afterCatalogFailure(root, rebuilt.error, steps)
    }
    const volume = rebuilt.volumes.find((item) => item.volumeId === volumeId)
    return {
      ok: true,
      value: volume ?? { volumeId, dir, title: slug === '' ? volumeId : slug, order: volumeNumberOf(volumeId) },
    }
  })
  if (!locked.ok) return fromIo(locked.error)
  if (!locked.value.ok) return locked.value
  return { ok: true, root, volume: locked.value.value, catalogRebuilt: true, ...(await commitIndex(root)) }
}

// ---------------------------------------------------------------------------
// inkflow_volume_rename
// ---------------------------------------------------------------------------

export async function renameVolume(projectRoot: string, input: VolumeRenameInput): Promise<VolumeRenameResult> {
  const root = resolve(projectRoot)

  // Lock before reading: the directory a rename must move is exactly what the
  // projection says, so the projection has to be read under the same lock.
  const locked = withProjectWriteLock(root, (lock): Locked<VolumeRenameOk> => {
    const root = lock.root
    const requested = (input.volumeId ?? '').trim()
    if (requested === '') return fail('VOLUME_ID_INVALID', 'a volumeId is required', { root })
    const volumeId = canonicalVolumeId(requested)
    if (volumeId === undefined) {
      return fail('VOLUME_ID_INVALID', `"${requested}" is not a volume id; expected vol-NN (two or more digits)`, { root })
    }

    const catalog = readCatalog(root)
    const volume = catalog.catalog.volumes.find((item) => item.volumeId === volumeId)
    if (volume === undefined) return fail('VOLUME_NOT_FOUND', `no volume ${volumeId}`, { root })

    const title = (input.title ?? '').trim()
    if (title === '' && input.slug === undefined) {
      return fail('TITLE_REQUIRED', 'a rename needs a title or a slug', { root })
    }
    const resolvedSlug = resolveSlug(input.slug, title)
    if (!resolvedSlug.ok) return fail('SLUG_INVALID', resolvedSlug.problem, { root })
    const slug = resolvedSlug.value
    if (slug === '') {
      return fail('SLUG_INVALID', 'the title yields an empty directory name; pass an explicit slug', { root })
    }

    const from = `${CHAPTERS_DIR}/${volume.dir}`
    const dir = `${volumeId}-${slug}`
    const to = `${CHAPTERS_DIR}/${dir}`
    const chapters = chaptersOf(catalog, volumeId)
    if (to === from) {
      return {
        ok: true,
        value: {
          ok: true,
          root,
          volume,
          previous: volume,
          chaptersUnchanged: chapters.length,
          changed: false,
          catalogRebuilt: false,
          ...UNTOUCHED_INDEX,
        },
      }
    }
    if (existsSync(join(root, CHAPTERS_DIR, dir))) {
      return fail('VOLUME_EXISTS', `the volume directory ${to} already exists`, { root, path: to })
    }

    const catalogs = takeCatalogSnapshot(root)
    const renamed = renameProjectDirectory(root, from, to)
    if (!renamed.ok) {
      return fromIo(renamed.error, { message: `the volume directory could not be renamed: ${renamed.error.message}` })
    }

    const rebuilt = rebuildCatalog(root)
    if (!rebuilt.ok) {
      const steps: RollbackStep[] = []
      rollbackStep(steps, `rename ${to} back to ${from}`, renameProjectDirectory(root, to, from))
      // The volume list travelled with the directory; its old path is the one to
      // restore, so this runs after the directory is back in place.
      steps.push(...restoreCatalogSnapshot(root, catalogs))
      return afterCatalogFailure(root, rebuilt.error, steps)
    }
    const next = rebuilt.volumes.find((item) => item.volumeId === volumeId)
    return {
      ok: true,
      value: {
        ok: true,
        root,
        volume: next ?? { volumeId, dir, title: slug, order: volume.order },
        previous: volume,
        chaptersUnchanged: chapters.length,
        changed: true,
        catalogRebuilt: true,
        ...UNTOUCHED_INDEX,
      },
    }
  })
  if (!locked.ok) return fromIo(locked.error)
  if (!locked.value.ok) return locked.value
  const result = locked.value.value
  return result.changed ? { ...result, ...(await commitIndex(result.root)) } : result
}

