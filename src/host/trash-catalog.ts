/**
 * The catalog half of a restore: which restores touch the volume/chapter projection,
 * and how that projection is repaired.
 *
 * The catalog (`chapters/index.json` + one `chapters/<vol-dir>/index.json`) is the
 * in-book projection of the `.md` truth — a file the author commits, not a cache
 * (ADR-0005: the derived index may be deleted and rebuilt, this may not). Every
 * chapter write rebuilds it, so a restore that puts a chapter back has to rebuild it
 * too: otherwise the files are exactly right and the next audit still reports
 * `CATALOG_STALE`, which is a report that accuses correct data.
 *
 * Why its own module: `trash.ts` sits at the 600-line cap, and "does this restored
 * path belong to the projection?" is a different question from the bin's own
 * invariants — it is answered from the scanner's rules, not from the manifest.
 */

import { rebuildCatalog } from './catalog.js'
import { CHAPTERS_DIR } from './conventions.js'

/** What a restore did to the projection, in the words a receipt needs. */
export interface CatalogRepair {
  /** `true` only when a rebuild ran and the projection now agrees with the files. */
  rebuilt: boolean
  /** Why a needed rebuild did not finish; the restored bytes are back regardless. */
  error?: { code: string; message: string }
}

/**
 * Is `relative` a file the catalog projects?
 *
 * Same rules as the scan in `catalog.ts` (`listChapterFiles`): a `.md` under
 * `chapters/`, any depth, with no dot-prefixed path segment — the scanner skips those
 * (`.inkflow/` never enters the projection, and `.gitkeep` is not markdown). A path the
 * scanner would never read cannot change one byte of the projection, and a restore of
 * it must not write one either.
 */
export function isProjectedChapterPath(relative: string): boolean {
  const segments = relative.split('/')
  const name = segments[segments.length - 1]
  if (segments[0] !== CHAPTERS_DIR || name === undefined) return false
  if (segments.some((segment) => segment.startsWith('.'))) return false
  return name.toLowerCase().endsWith('.md')
}

/**
 * Repair the projection after `relative` was written back.
 *
 * A failed rebuild is reported, neither thrown nor rolled back: the restored bytes are
 * already verified against the manifest, so turning "the chapter is back, the projection
 * is stale" into "the restore failed" would be a lie in the other direction — and the
 * caller would undo a good restore to avoid a state one rebuild action fixes. The
 * receipt carries `rebuilt: false` plus the code, so the author is told which of the two
 * halves of the restore fell short.
 *
 * Nothing is attempted for a path outside the projection: an unrelated restore must not
 * rewrite `chapters/index.json` (a pointless diff, and a write the author never asked
 * for).
 */
export function repairCatalogAfterRestore(root: string, relative: string): CatalogRepair {
  if (!isProjectedChapterPath(relative)) return { rebuilt: false }
  const rebuilt = rebuildCatalog(root)
  if (!rebuilt.ok) return { rebuilt: false, error: { code: rebuilt.error.code, message: rebuilt.error.message } }
  return { rebuilt: true }
}
