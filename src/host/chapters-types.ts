/**
 * The chapter/volume operations' contract: every input, every success shape, every failure.
 *
 * WHY IT IS A FILE: these 200 lines of types sat at the top of a 1415-line module, so a reader
 * looking for "what does writeChapter accept" scrolled past them, and a reader looking for the
 * types scrolled past six operations. Types are the part of this module other modules depend on;
 * the operations are the part that touches the disk. Splitting on that line is what lets
 * `chapters-ops-*.ts` import the contract without dragging the store along.
 */

import type { FileExpectation, FileFingerprint } from './file-cas.js'
import type { IoFailure } from './io.js'
import type { EolStyle, TextStyle } from './text-style.js'

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

/** Business-level failures; filesystem failures keep their `IoErrorCode`. */
export type ChapterErrorCode =
  | 'TITLE_REQUIRED'
  | 'VOLUME_ID_INVALID'
  | 'VOLUME_EXISTS'
  | 'VOLUME_NOT_FOUND'
  | 'SLUG_INVALID'
  | 'SEQ_INVALID'
  | 'SEQ_CONFLICT'
  | 'CHAPTER_EXISTS'
  | 'CHAPTER_NOT_FOUND'
  | 'CHAPTER_AMBIGUOUS'
  | 'CHAPTER_SELECTOR_REQUIRED'
  | 'CHAPTER_SELECTOR_CONFLICT'
  | 'FILE_INVALID'
  | 'STATUS_INVALID'
  | 'FILE_CHANGED'
  | 'CATALOG_REBUILD_FAILED'
  | 'ROLLBACK_INCOMPLETE'

/** One undo attempt, reported whether or not it worked. */
export interface RollbackStep {
  action: string
  ok: boolean
  message?: string
}

export interface ChapterOpError {
  /** A `ChapterErrorCode`, or the `IoErrorCode` that actually refused the write. */
  code: ChapterErrorCode | string
  message: string
  root: string
  path?: string
  hint?: string
  /** True only when every undo step succeeded. */
  rolledBack?: boolean
  rollback?: RollbackStep[]
  /** The underlying write failure, when the code above came from `io.ts`. */
  io?: IoFailure
  /** `FILE_CHANGED` only: the baseline the caller supplied. */
  expected?: FileExpectation
  /** `FILE_CHANGED` only: what is actually on disk now (`null` = the file is gone). */
  current?: FileFingerprint | null
  /** `FILE_CHANGED` only: which fields of the baseline no longer match. */
  changed?: string[]
  /** True when the refusal happened before the first byte was written. */
  nothingWritten?: boolean
}

export interface ChapterOpFailure {
  ok: false
  error: ChapterOpError
}

/** What every successful operation reports about the two projections. */
export interface CommitInfo {
  catalogRebuilt: boolean
  indexRebuilt: boolean
  indexError?: { code: string; message: string }
}

export interface VolumeView {
  volumeId: string
  dir: string
  title: string
  order: number
}

export interface ChapterView {
  chapterId: string
  file: string
  seq?: number
  title: string
  volumeId: string | null
  status: string
}

export interface VolumeCreateInput {
  volumeId?: string
  title: string
  slug?: string
}

export interface VolumeRenameInput {
  volumeId: string
  title?: string
  slug?: string
}

export interface ChapterCreateInput {
  volumeId?: string | null
  title: string
  slug?: string
  seq?: number
  /**
   * Rebuild the derived index after this call (default true).
   *
   * A batch caller (`import-write.ts`) passes `false` and rebuilds once at the end:
   * one index build per chapter is O(n²) work on a 200-chapter import — measured at 64 s
   * for a 60万字 manuscript, against ~2 s with a single build — and the index is a cache,
   * so "rebuilt 200 times" and "rebuilt once" are the same answer to every reader. A
   * single-chapter caller never passes it: freshness is not negotiable there.
   */
  indexCommit?: boolean
}

export interface ChapterWriteInput {
  chapterId?: string
  file?: string
  title?: string
  body?: string
  status?: string
  /**
   * The file's own line ending and BOM, as the read path reported them (ADR-0016).
   *
   * Omitted = "take it from the file": the tool path reads the bytes itself, and a
   * client that never sees raw bytes (the panel) passes back what `GET
   * /chapters/:id` told it. A new file is not written through this input at all,
   * so the default for a fresh chapter stays LF/no-BOM.
   */
  eol?: EolStyle
  bom?: boolean
  /** Baseline the caller last saw: a mismatch is `FILE_CHANGED`, zero writes. */
  expected?: FileExpectation
  /** Rebuild the derived index after this call (default true); see `ChapterCreateInput`. */
  indexCommit?: boolean
}

export interface ChapterMoveInput {
  chapterId?: string
  file?: string
  volumeId?: string | null
  /** Baseline the caller last saw. */
  expected?: FileExpectation
}

export interface ChapterDeleteInput {
  chapterId?: string
  file?: string
  /** Baseline the caller last saw: a delete of an unknown edit is refused. */
  expected?: FileExpectation
}

export interface VolumeCreateOk extends CommitInfo {
  ok: true
  root: string
  volume: VolumeView
}

export interface VolumeRenameOk extends CommitInfo {
  ok: true
  root: string
  volume: VolumeView
  previous: VolumeView
  /** Chapter files carried along by the directory rename (their bytes are untouched). */
  chaptersUnchanged: number
  changed: boolean
}

export interface ChapterCreateOk extends CommitInfo {
  ok: true
  root: string
  chapter: ChapterView
}

export interface ChapterWriteOk extends CommitInfo {
  ok: true
  root: string
  chapter: ChapterView
  changed: string[]
  renamedFrom?: string
  /** The style the file is written in (ADR-0016) — what the next save must keep. */
  style: TextStyle
  /** The file as it is now — the baseline for the next CAS write. */
  fingerprint?: FileFingerprint
}

export interface ChapterMoveOk extends CommitInfo {
  ok: true
  root: string
  chapter: ChapterView
  moved: boolean
  movedFrom: string
  changed: string[]
  /** The file as it is now (at its new path). */
  fingerprint?: FileFingerprint
}

export interface ChapterDeleteOk extends CommitInfo {
  ok: true
  root: string
  deleted: { chapterId: string; file: string; title: string; seq?: number; volumeId: string | null }
  /** The recovery-bin entry this delete created. */
  trashed: { id: string; trashPath: string; bytes: number }
}

/**
 * What the delete cascade reports from inside the project write lock: the
 * chapter it removed and the recovery-bin entry that now holds the text. Split
 * out because the bin's copy is made inside the same lock as the file removal.
 */
export interface DeletedChapterReport {
  deleted: ChapterDeleteOk['deleted']
  trashed: ChapterDeleteOk['trashed']
}

export type VolumeCreateResult = VolumeCreateOk | ChapterOpFailure
export type VolumeRenameResult = VolumeRenameOk | ChapterOpFailure
export type ChapterCreateResult = ChapterCreateOk | ChapterOpFailure
export type ChapterWriteResult = ChapterWriteOk | ChapterOpFailure
export type ChapterMoveResult = ChapterMoveOk | ChapterOpFailure
export type ChapterDeleteResult = ChapterDeleteOk | ChapterOpFailure

