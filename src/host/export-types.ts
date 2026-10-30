/**
 * The export surface: the formats, the targets, the error vocabulary, the block model and
 * the plan shapes every renderer takes.
 *
 * WHY IT IS A FILE: the EPUB, DOCX and text sinks all take the plan and the block model,
 * and none of them may import `export.ts` (it imports them back). One leaf module keeps
 * the graph acyclic, the same reason `route-types.ts` exists for the route tables.
 */

import { relative } from 'node:path'
import { CHAPTER_STATUSES } from './conventions.js'

/** `dataDir/exports`: the plugin's own export directory, outside every book (D4). */
export const EXPORTS_DIR = 'exports'

/** The four formats the issue asks for. `kind` in the file name is this value, verbatim. */
export const EXPORT_FORMATS = ['epub', 'docx', 'markdown', 'txt'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

/**
 * What gets exported: the whole book, one volume, or every chapter in one status.
 *
 * `book` and `volume` are scope selections; `status` is a *filter* across volumes, which
 * is why it packages one file per volume instead of one file for the book.
 */
export const EXPORT_TARGETS = ['book', 'volume', 'status'] as const
export type ExportTarget = (typeof EXPORT_TARGETS)[number]

/** OCF's payload for the first entry: 20 bytes, no BOM, no trailing newline (D2). */
export const EPUB_MIMETYPE = 'application/epub+zip'

export const EPUB_OPF_PATH = 'OEBPS/content.opf'
export const EPUB_NAV_PATH = 'OEBPS/toc.xhtml'
export const EPUB_CONTAINER_PATH = 'META-INF/container.xml'

/** Entries a reply spells out before it switches to counting them. */
export const ENTRY_PREVIEW = 12

/** A refusal a caller reports instead of a stack trace. */
export type ExportErrorCode =
  /** `format` is missing or not one of `EXPORT_FORMATS`. */
  | 'EXPORT_FORMAT_INVALID'
  /** `target` is missing or not one of `EXPORT_TARGETS`. */
  | 'EXPORT_TARGET_INVALID'
  /** `target: "volume"` without a `volumeId`. */
  | 'EXPORT_VOLUME_REQUIRED'
  /** `volumeId` names no volume of this book. */
  | 'EXPORT_VOLUME_UNKNOWN'
  /** `target: "status"` without a `status`. */
  | 'EXPORT_STATUS_REQUIRED'
  /** `status` is not one of `CHAPTER_STATUSES`. */
  | 'EXPORT_STATUS_INVALID'
  /** A selection parameter the chosen target does not read (`status` with `target: "volume"`). */
  | 'EXPORT_SELECTION_UNUSED'
  /** Nothing to export: an empty book, or a filter that matched no chapter. */
  | 'EXPORT_EMPTY'
  /** The catalog names a chapter file that cannot be read. */
  | 'EXPORT_CHAPTER_UNREADABLE'
  /** `dataDir` resolves inside the book, so an export there would pollute it (D4). */
  | 'EXPORT_DATA_DIR_INSIDE_BOOK'
  /** The package could not be read back before writing: nothing was written. */
  | 'EXPORT_SELFCHECK_FAILED'
  /** The file could not be written (permissions, free space). */
  | 'EXPORT_WRITE_FAILED'

export interface ExportError {
  code: ExportErrorCode
  message: string
  hint?: string
  /** Book-relative path the refusal is about (`EXPORT_CHAPTER_UNREADABLE`). */
  path?: string
  /** `EXPORT_EMPTY` / `EXPORT_VOLUME_UNKNOWN`: what the book does have. */
  available?: string[]
}

export type ExportResult<T> = { ok: true; value: T } | { ok: false; error: ExportError }

export type ExportChapterStatus = (typeof CHAPTER_STATUSES)[number]

/** One chapter as the exporters consume it: frontmatter resolved, body stripped. */
export interface ExportChapter {
  /** Catalog id (frontmatter `id`, else the project-relative path). */
  chapterId: string
  /** Project-relative path with `/` separators (what a report names). */
  file: string
  seq?: number
  title: string
  /** Frontmatter `status`, normalized to `CHAPTER_STATUSES` (`draft` when absent). */
  status: ExportChapterStatus
  /** Body with the frontmatter block removed, LF-normalized. */
  body: string
}

/** One volume and the chapters of it that the selection kept. */
export interface ExportGroup {
  /** `vol-NN`: the stable id (not the directory slug). */
  volumeId: string
  /** Display title (from the directory slug, see `catalog.ts`). */
  title: string
  chapters: ExportChapter[]
}

/** Everything one export writes, in reading order. */
export interface ExportPlan {
  /** Book title from `inkflow.json`; falls back to the directory slug. */
  title: string
  /** `inkflow.json` author, `''` when the book names none. */
  author: string
  /** Volumes in reading order, each keeping only its selected chapters. */
  groups: ExportGroup[]
  /** Chapters that belong to no volume, in catalog order. */
  loose: ExportChapter[]
  /** Chapters written into the artifact. */
  chapters: number
  /** Volumes that still have at least one chapter. */
  volumes: number
}
