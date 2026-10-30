/**
 * The catalog's shapes: what one chapter, one volume and one catalog file look like.
 *
 * WHY IT IS A FILE: these declarations are the half of `catalog.ts` that other modules and
 * the panel actually depend on, and they were buried under an 823-line module whose other
 * half scans the tree and writes JSON. They are a leaf — a type import here pulls in no IO,
 * no convention table and no writer — so the projection and the writer can share one
 * vocabulary instead of importing each other.
 */

// ---------------------------------------------------------------------------
// File shapes
// ---------------------------------------------------------------------------

/** One chapter as it appears in a catalog. */
export interface CatalogChapter {
  /** Durable id: frontmatter `id`, else the project-relative path. */
  chapterId: string
  /** Project-relative path with `/` separators. */
  file: string
  /** Chapter number; omitted when the file name has no leading number. */
  seq?: number
  title: string
}

/** One volume as it appears in the top-level catalog. */
export interface CatalogVolume {
  /** Stable `vol-NN` id; the chapter frontmatter stores this, not the slug. */
  volumeId: string
  /** Volume directory name; must start with `volumeId`. */
  dir: string
  /** Display title from the directory slug (fallback: the id). */
  title: string
  /** Position in the book (the numeric part of `volumeId`). */
  order: number
}

/** `chapters/index.json`: the volume list plus chapters that belong to no volume. */
export interface RootCatalog {
  schemaVersion: number
  volumes: CatalogVolume[]
  looseChapters: CatalogChapter[]
}

/** `chapters/<vol-dir>/index.json`: the chapter list of one volume. */
export interface VolumeCatalog {
  schemaVersion: number
  volumeId: string
  chapters: CatalogChapter[]
}

/** The projection of the `.md` files: what both catalog files must contain. */
export interface ProjectedCatalog {
  catalog: RootCatalog
  /** One entry per `catalog.volumes` item, same order. */
  volumeCatalogs: VolumeCatalog[]
}

// ---------------------------------------------------------------------------
// Stale reporting
// ---------------------------------------------------------------------------

/**
 * Why a catalog file is stale, for the message the model repeats to the user.
 */
export type CatalogStaleReason = 'missing' | 'invalid' | 'differs'

export interface StaleCatalogFile {
  path: string
  reason: CatalogStaleReason
}

export const STALE_DETAIL: Record<CatalogStaleReason, string> = {
  missing: 'the catalog file is missing; rebuild it from the .md files',
  invalid: 'the catalog file is not valid JSON; rebuild it from the .md files',
  differs: 'the catalog disagrees with the .md files; rebuild it (hand edits are never kept)',
}
