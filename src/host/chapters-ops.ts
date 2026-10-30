/**
 * The six chapter/volume operations: the half of the store that writes.
 *
 * WHY IT IS A FILE: `chapters.ts` held the contract, the naming rules, the failure helpers,
 * the projection reader, the compare-and-swap and these six functions — 1415 lines, where the
 * write path and the read path scrolled past each other. What is left in `chapters.ts` is the
 * part every operation needs (names, refusals, CAS); this file is what happens on top of it.
 *
 * The contract types come from `chapters-types.ts`; the helpers from `chapters.js`. Nothing
 * here is imported back by `chapters.ts`, so the split is acyclic.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'

import { readCatalog, rebuildCatalog } from './catalog.js'
import { CHAPTERS_DIR, CHAPTER_STATUSES } from './conventions.js'
import { fingerprintProjectFile } from './file-cas.js'
import { frontmatterLine, parseMarkdown, stringField } from './frontmatter.js'
import { removeProjectFile, withProjectWriteLock, writeTextAtomic } from './io.js'
import { detectTextStyle } from './text-style.js'
import type { TextStyle } from './text-style.js'
import { trashFile, undoTrashFile } from './trash.js'
import type { ChapterCreateInput, ChapterCreateResult, ChapterDeleteInput, ChapterDeleteResult, ChapterMoveInput, ChapterMoveOk, ChapterMoveResult, ChapterView, ChapterWriteInput, ChapterWriteOk, ChapterWriteResult, DeletedChapterReport, RollbackStep } from './chapters-types.js'
import type { Locked } from './chapters.js'
import { UNTOUCHED_INDEX, afterCatalogFailure, applyFields, callerBaselineRefusal, canonicalVolumeId, chapterFile, chaptersOf, commitIndex, directoryOf, driftedSinceRead, fail, fileNameOf, fromIo, leadingDigitsOf, maxSeq, padSeq, readChapterText, readChapterWithFingerprint, removeIfExists, resolveChapter, resolveSlug, restoreCatalogSnapshot, rollbackStep, slugify, takeCatalogSnapshot, viewOf, volumeNumberOf, withBody } from './chapters.js'

// ---------------------------------------------------------------------------
// inkflow_chapter_create
// ---------------------------------------------------------------------------

export async function createChapter(projectRoot: string, input: ChapterCreateInput): Promise<ChapterCreateResult> {
  const root = resolve(projectRoot)

  // The `seq` and the file name are allocated from the projection, so the read
  // and the write must sit under one lock: two sessions creating at the same
  // moment would otherwise both allocate the same number.
  const locked = withProjectWriteLock(root, (lock): Locked<ChapterView> => {
    const root = lock.root
    const title = (input.title ?? '').trim()
    if (title === '') return fail('TITLE_REQUIRED', 'a chapter title is required', { root })

    const catalog = readCatalog(root)
    let volumeId: string | null = null
    let dir = CHAPTERS_DIR
    const requestedVolume = (input.volumeId ?? '').trim()
    if (requestedVolume !== '') {
      const canonical = canonicalVolumeId(requestedVolume)
      if (canonical === undefined) {
        return fail('VOLUME_ID_INVALID', `"${requestedVolume}" is not a volume id; expected vol-NN (two or more digits)`, {
          root,
        })
      }
      const volume = catalog.catalog.volumes.find((item) => item.volumeId === canonical)
      if (volume === undefined) {
        return fail('VOLUME_NOT_FOUND', `no volume ${canonical}; create it with inkflow_volume_create first`, { root })
      }
      volumeId = volume.volumeId
      dir = `${CHAPTERS_DIR}/${volume.dir}`
    }

    const siblings = chaptersOf(catalog, volumeId)
    let seq: number
    if (input.seq !== undefined) {
      if (!Number.isInteger(input.seq) || input.seq < 1) {
        return fail('SEQ_INVALID', `seq must be a positive integer (got ${String(input.seq)})`, { root })
      }
      seq = input.seq
    } else {
      seq = maxSeq(siblings) + 1
    }
    const clash = siblings.find((chapter) => chapter.seq === seq)
    if (clash !== undefined) {
      return fail('SEQ_CONFLICT', `seq ${seq} is already used by ${clash.file}`, { root, path: clash.file })
    }

    const resolvedSlug = resolveSlug(input.slug, title)
    if (!resolvedSlug.ok) return fail('SLUG_INVALID', resolvedSlug.problem, { root })
    const slug = resolvedSlug.value

    const file = chapterFile(dir, padSeq(seq), slug)
    if (existsSync(join(root, ...file.split('/')))) {
      return fail('CHAPTER_EXISTS', `the chapter file ${file} already exists`, { root, path: file })
    }

    const chapterId = randomUUID()
    const lines = ['---', frontmatterLine('id', chapterId), frontmatterLine('title', title)]
    if (volumeId !== null) lines.push(frontmatterLine('volume', volumeId))
    lines.push(frontmatterLine('seq', String(seq)), frontmatterLine('status', 'draft'), '---', '', '')
    const text = lines.join('\n')

    const catalogs = takeCatalogSnapshot(root)
    const written = writeTextAtomic(root, file, text)
    if (!written.ok) {
      return fromIo(written.error, { message: `the chapter file could not be written: ${written.error.message}` })
    }

    const rebuilt = rebuildCatalog(root)
    if (!rebuilt.ok) {
      const steps: RollbackStep[] = []
      rollbackStep(steps, `remove ${file}`, removeProjectFile(root, file))
      steps.push(...restoreCatalogSnapshot(root, catalogs))
      return afterCatalogFailure(root, rebuilt.error, steps)
    }
    return { ok: true, value: { chapterId, file, seq, title, volumeId, status: 'draft' } }
  })
  if (!locked.ok) return fromIo(locked.error)
  if (!locked.value.ok) return locked.value

  return {
    ok: true,
    root,
    chapter: locked.value.value,
    catalogRebuilt: true,
    ...(input.indexCommit === false ? UNTOUCHED_INDEX : await commitIndex(root)),
  }
}

// ---------------------------------------------------------------------------
// inkflow_chapter_write
// ---------------------------------------------------------------------------

export async function writeChapter(projectRoot: string, input: ChapterWriteInput): Promise<ChapterWriteResult> {
  const root = resolve(projectRoot)

  // The catalog reference and the file bytes are read under the same lock as the
  // write: otherwise a concurrent rename/move would leave this call patching a
  // path that no longer exists (or a different chapter that took its name).
  const locked = withProjectWriteLock(root, (lock): Locked<ChapterWriteOk> => {
    const root = lock.root
    const resolved = resolveChapter(root, input)
    if (!resolved.ok) return resolved
    const ref = resolved.value
    const read = readChapterWithFingerprint(root, ref.file)
    if (read === undefined) return fail('CHAPTER_NOT_FOUND', `${ref.file} could not be read`, { root, path: ref.file })
    const text = read.text
    const baseline = read.fingerprint
    // Both baselines are checked, and both are checked *before* any
    // byte is written, so a refusal leaves the tree byte-identical.
    const callerRefusal = callerBaselineRefusal(root, ref.file, baseline, input.expected)
    if (callerRefusal !== undefined) return callerRefusal

    const data = parseMarkdown(text).data
    const currentTitle = stringField(data, 'title') ?? ref.title
    // The file's own format, detected from the bytes just read. A caller that
    // cannot see raw bytes (the panel) declares it instead; the declaration wins
    // because it describes exactly the bytes its CAS baseline was taken from, and
    // the tool path simply has none (ADR-0016).
    const fileStyle = detectTextStyle(text)
    const style: TextStyle = { eol: input.eol ?? fileStyle.eol, bom: input.bom ?? fileStyle.bom }
    const entries: Record<string, string> = {}
    const changed: string[] = []

    if (input.title !== undefined) {
      const title = input.title.trim()
      if (title === '') return fail('TITLE_REQUIRED', 'a chapter title must not be empty', { root, path: ref.file })
      if (title !== currentTitle) {
        entries['title'] = title
        changed.push('title')
      }
    }
    if (input.status !== undefined) {
      if (!(CHAPTER_STATUSES as readonly string[]).includes(input.status)) {
        return fail('STATUS_INVALID', `status must be one of ${CHAPTER_STATUSES.join(', ')} (got "${input.status}")`, {
          root,
          path: ref.file,
        })
      }
      if (input.status !== stringField(data, 'status')) {
        entries['status'] = input.status
        changed.push('status')
      }
    }
    const body = input.body
    if (body !== undefined) changed.push('body')

    if (changed.length === 0) {
      return {
        ok: true,
        value: {
          ok: true,
          root,
          chapter: viewOf(ref.chapterId, ref.file, data, ref),
          changed: [],
          style,
          catalogRebuilt: false,
          ...UNTOUCHED_INDEX,
        },
      }
    }

    const edits = applyFields(text, entries)
    let next = edits.text
    if (body !== undefined) next = withBody(next, body)

    // A title change renames the file ("改标题 = 文件名 + frontmatter +
    // catalog 一起改"). The numeric prefix stays, so `0001-旧名.md` becomes
    // `0001-新名.md` and the reading order never depends on a rename.
    let target = ref.file
    const nextTitle = entries['title']
    if (nextTitle !== undefined) {
      const prefix = leadingDigitsOf(ref.file) ?? (ref.seq === undefined ? undefined : padSeq(ref.seq))
      const slug = slugify(nextTitle)
      if (prefix === undefined && slug === '') {
        return fail('SLUG_INVALID', 'the title yields an empty file name; pass a title with letters or digits', {
          root,
          path: ref.file,
        })
      }
      const candidate = chapterFile(directoryOf(ref.file), prefix, slug)
      if (candidate !== ref.file) {
        if (existsSync(join(root, ...candidate.split('/')))) {
          return fail('CHAPTER_EXISTS', `the target file ${candidate} already exists`, { root, path: candidate })
        }
        target = candidate
      }
    }

    const catalogs = takeCatalogSnapshot(root)
    const drifted = driftedSinceRead(root, ref.file, baseline)
    if (drifted !== undefined) return drifted
    // `next` mixes both halves on purpose (`applyFields` keeps the raw
    // frontmatter, `withBody` takes the caller's LF prose); the write door
    // normalises and then re-serialises the whole document in `style`, so the
    // file keeps its own format and one edited character stays one changed line.
    const written = writeTextAtomic(root, target, next, { style })
    if (!written.ok) {
      return fromIo(written.error, { message: `the chapter file could not be written: ${written.error.message}` })
    }

    if (target !== ref.file) {
      const removed = removeProjectFile(root, ref.file)
      if (!removed.ok) {
        const steps: RollbackStep[] = []
        rollbackStep(steps, `remove ${target}`, removeProjectFile(root, target))
        steps.push(...restoreCatalogSnapshot(root, catalogs))
        return fromIo(removed.error, { message: `the old chapter file could not be removed: ${removed.error.message}` })
      }
    }

    const rebuilt = rebuildCatalog(root)
    if (!rebuilt.ok) {
      const steps: RollbackStep[] = []
      rollbackStep(steps, `restore ${ref.file}`, writeTextAtomic(root, ref.file, text, { verbatim: true }))
      if (target !== ref.file) rollbackStep(steps, `remove ${target}`, removeProjectFile(root, target))
      steps.push(...restoreCatalogSnapshot(root, catalogs))
      return afterCatalogFailure(root, rebuilt.error, steps)
    }

    const fingerprint = fingerprintProjectFile(root, target)
    const finalData = parseMarkdown(readChapterText(root, target) ?? next).data
    return {
      ok: true,
      value: {
        ok: true,
        root,
        chapter: viewOf(ref.chapterId, target, finalData, ref),
        changed,
        ...(target === ref.file ? {} : { renamedFrom: ref.file }),
        style,
        catalogRebuilt: true,
        ...(fingerprint === undefined ? {} : { fingerprint }),
        ...UNTOUCHED_INDEX,
      },
    }
  })
  if (!locked.ok) return fromIo(locked.error)
  if (!locked.value.ok) return locked.value
  const result = locked.value.value
  // A batch caller suppresses this and rebuilds once at the end (see the input type).
  return result.catalogRebuilt && input.indexCommit !== false ? { ...result, ...(await commitIndex(root)) } : result
}

// ---------------------------------------------------------------------------
// inkflow_chapter_move
// ---------------------------------------------------------------------------

export async function moveChapter(projectRoot: string, input: ChapterMoveInput): Promise<ChapterMoveResult> {
  const root = resolve(projectRoot)

  // Same reason as the write path: the reference, the target volume and the seq
  // collision check all have to describe the state this call actually mutates.
  const locked = withProjectWriteLock(root, (lock): Locked<ChapterMoveOk> => {
    const root = lock.root
    const resolved = resolveChapter(root, input)
    if (!resolved.ok) return resolved
    const ref = resolved.value

    let targetVolumeId: string | null = null
    let targetDir = CHAPTERS_DIR
    const requested = (input.volumeId ?? '').trim()
    if (requested !== '') {
      const canonical = canonicalVolumeId(requested)
      if (canonical === undefined) {
        return fail('VOLUME_ID_INVALID', `"${requested}" is not a volume id; expected vol-NN (two or more digits)`, {
          root,
        })
      }
      const volume = resolved.catalog.catalog.volumes.find((item) => item.volumeId === canonical)
      if (volume === undefined) return fail('VOLUME_NOT_FOUND', `no volume ${canonical}`, { root })
      targetVolumeId = volume.volumeId
      targetDir = `${CHAPTERS_DIR}/${volume.dir}`
    }

    const read = readChapterWithFingerprint(root, ref.file)
    if (read === undefined) return fail('CHAPTER_NOT_FOUND', `${ref.file} could not be read`, { root, path: ref.file })
    const text = read.text
    const baseline = read.fingerprint
    const callerRefusal = callerBaselineRefusal(root, ref.file, baseline, input.expected)
    if (callerRefusal !== undefined) return callerRefusal
    const data = parseMarkdown(text).data

    // A move relocates the file; the name (prefix + slug) travels unchanged.
    const targetFile = `${targetDir}/${fileNameOf(ref.file)}`
    if (targetVolumeId === ref.volumeId && targetFile === ref.file) {
      return {
        ok: true,
        value: {
          ok: true,
          root,
          chapter: viewOf(ref.chapterId, ref.file, data, ref),
          moved: false,
          movedFrom: ref.file,
          changed: [],
          catalogRebuilt: false,
          ...UNTOUCHED_INDEX,
        },
      }
    }

    // A seq may only exist once per volume: the catalog's own uniqueness rule
    // (`CATALOG_DUPLICATE`) is refused here instead of written and reported later.
    if (ref.seq !== undefined) {
      const clash = chaptersOf(resolved.catalog, targetVolumeId).find(
        (chapter) => chapter.seq === ref.seq && chapter.file !== ref.file,
      )
      if (clash !== undefined) {
        const where = targetVolumeId === null ? 'the loose chapters' : targetVolumeId
        return fail('SEQ_CONFLICT', `seq ${ref.seq} is already used by ${clash.file} in ${where}`, {
          root,
          path: clash.file,
          hint: 'pick another volume, or renumber the chapter first (seq is not editable yet)',
        })
      }
    }
    if (targetFile !== ref.file && existsSync(join(root, ...targetFile.split('/')))) {
      return fail('CHAPTER_EXISTS', `the target file ${targetFile} already exists`, { root, path: targetFile })
    }

    // Leaving a volume must *remove* `volume`: an empty value reads back as an
    // empty block list, and the old value would keep the old owner.
    const next =
      targetVolumeId === null
        ? applyFields(text, {}, ['volume']).text
        : applyFields(text, { volume: targetVolumeId }).text
    const changed: string[] = []
    if (stringField(data, 'volume') !== (targetVolumeId ?? undefined)) changed.push('volume')
    if (targetFile !== ref.file) changed.push('file')

    const catalogs = takeCatalogSnapshot(root)
    const drifted = driftedSinceRead(root, ref.file, baseline)
    if (drifted !== undefined) return drifted
    const written = writeTextAtomic(root, targetFile, next)
    if (!written.ok) {
      return fromIo(written.error, { message: `the chapter could not be moved: ${written.error.message}` })
    }

    if (targetFile !== ref.file) {
      const removed = removeProjectFile(root, ref.file)
      if (!removed.ok) {
        const steps: RollbackStep[] = []
        rollbackStep(steps, `remove ${targetFile}`, removeProjectFile(root, targetFile))
        steps.push(...restoreCatalogSnapshot(root, catalogs))
        return fromIo(removed.error, { message: `the old chapter file could not be removed: ${removed.error.message}` })
      }
    }

    const rebuilt = rebuildCatalog(root)
    if (!rebuilt.ok) {
      const steps: RollbackStep[] = []
      rollbackStep(steps, `restore ${ref.file}`, writeTextAtomic(root, ref.file, text, { verbatim: true }))
      if (targetFile !== ref.file) rollbackStep(steps, `remove ${targetFile}`, removeProjectFile(root, targetFile))
      steps.push(...restoreCatalogSnapshot(root, catalogs))
      return afterCatalogFailure(root, rebuilt.error, steps)
    }

    const fingerprint = fingerprintProjectFile(root, targetFile)
    const finalData = parseMarkdown(readChapterText(root, targetFile) ?? next).data
    return {
      ok: true,
      value: {
        ok: true,
        root,
        chapter: viewOf(ref.chapterId, targetFile, finalData, { ...ref, volumeId: targetVolumeId }),
        moved: targetFile !== ref.file,
        movedFrom: ref.file,
        changed,
        catalogRebuilt: true,
        ...(fingerprint === undefined ? {} : { fingerprint }),
        ...UNTOUCHED_INDEX,
      },
    }
  })
  if (!locked.ok) return fromIo(locked.error)
  if (!locked.value.ok) return locked.value
  const result = locked.value.value
  return result.catalogRebuilt ? { ...result, ...(await commitIndex(root)) } : result
}

// ---------------------------------------------------------------------------
// inkflow_chapter_delete
// ---------------------------------------------------------------------------

export async function deleteChapter(projectRoot: string, input: ChapterDeleteInput): Promise<ChapterDeleteResult> {
  const root = resolve(projectRoot)

  const locked = withProjectWriteLock(root, (lock): Locked<DeletedChapterReport> => {
    const root = lock.root
    const resolved = resolveChapter(root, input)
    if (!resolved.ok) return resolved
    const ref = resolved.value

    // The text is captured *before* the deletion: it is the only copy the rollback
    // has, and re-reading after the unlink is impossible.
    const read = readChapterWithFingerprint(root, ref.file)
    if (read === undefined) return fail('CHAPTER_NOT_FOUND', `${ref.file} could not be read`, { root, path: ref.file })
    const text = read.text
    const baseline = read.fingerprint
    // Deleting a file the caller has not seen the latest version of is the one
    // mistake git cannot undo for them: refuse it before the unlink.
    const callerRefusal = callerBaselineRefusal(root, ref.file, baseline, input.expected)
    if (callerRefusal !== undefined) return callerRefusal
    const data = parseMarkdown(text).data

    const catalogs = takeCatalogSnapshot(root)
    const drifted = driftedSinceRead(root, ref.file, baseline)
    if (drifted !== undefined) return drifted
    // A delete is reversible on purpose (roadmap X-9): the file is moved
    // into the recovery bin (`.inkflow/trash/<same relative path>`) with a
    // verified byte-identical copy before the working tree loses it. Everything
    // below still behaves as before — the catalog is the projection and the
    // index a cache — so the bin adds a copy, not a second truth.
    const trashed = trashFile(root, { path: ref.file, reason: 'chapter_delete' })
    if (!trashed.ok) {
      // Reported with the bin's own code: a copy that cannot be made (or a
      // manifest that cannot be read) refuses the delete, so the only way this
      // fails is with the chapter still in place.
      return {
        ok: false,
        error: {
          code: trashed.error.code,
          message: `the chapter was not deleted: ${trashed.error.message}`,
          root,
          path: ref.file,
          ...(trashed.error.hint === undefined ? {} : { hint: trashed.error.hint }),
          ...(trashed.error.nothingWritten === undefined ? {} : { nothingWritten: trashed.error.nothingWritten }),
          ...(trashed.error.rolledBack === undefined ? {} : { rolledBack: trashed.error.rolledBack }),
        },
      }
    }

    const rebuilt = rebuildCatalog(root)
    if (!rebuilt.ok) {
      const steps: RollbackStep[] = []
      rollbackStep(steps, `restore ${ref.file}`, writeTextAtomic(root, ref.file, text, { verbatim: true }))
      // The bin must not keep an entry for a file that is back in the tree.
      rollbackStep(steps, `drop the recovery-bin entry for ${ref.file}`, undoTrashFile(root, trashed.entry.id))
      steps.push(...restoreCatalogSnapshot(root, catalogs))
      return afterCatalogFailure(root, rebuilt.error, steps)
    }

    return {
      ok: true,
      value: {
        deleted: {
          chapterId: ref.chapterId,
          file: ref.file,
          title: stringField(data, 'title') ?? ref.title,
          ...(ref.seq === undefined ? {} : { seq: ref.seq }),
          volumeId: ref.volumeId,
        },
        trashed: { id: trashed.entry.id, trashPath: trashed.trashPath, bytes: trashed.entry.bytes },
      },
    }
  })
  if (!locked.ok) return fromIo(locked.error)
  if (!locked.value.ok) return locked.value

  return {
    ok: true,
    root,
    deleted: locked.value.value.deleted,
    trashed: locked.value.value.trashed,
    catalogRebuilt: true,
    ...(await commitIndex(root)),
  }
}

