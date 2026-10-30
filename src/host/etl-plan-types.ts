/**
 * The legacy-migration plan's vocabulary: the id map, the disk probe, the options, and the
 * shapes one plan reports (items, class reports, gaps, decisions, the reconcile verdict).
 *
 * WHY IT IS A FILE: these are what `etl.ts` persists, what the ETL tool renders and what the
 * apply step reads back. They change when the migration format changes, not when a phase of
 * `buildEtlPlan` does, and keeping them here is what lets the plan module stay under the
 * size gate without turning one 1200-line file into two 600-line ones.
 */

import type { EtlTable } from './etl-source.js'

/** Shape version of the id map; a different value is refused, never migrated. */
export const ETL_IDMAP_VERSION = 1

/** Where the id map lives (X-29 names this path): `.inkflow/backup/etl-idmap.json`. */
export const ETL_IDMAP_RELATIVE = '.inkflow/backup/etl-idmap.json'

/** One legacy row that now owns a file. `(table, id)` is the idempotency key (X-29). */
export interface EtlIdMapEntry {
  readonly table: EtlTable
  readonly id: number
  /** Entity id written into the file's frontmatter; pinned to the legacy uuid when it has one (ADR-0014). */
  readonly entityId: string
  readonly path: string
  readonly sha256: string
}

export interface EtlIdMap {
  readonly schemaVersion: number
  readonly source: { readonly db: string; readonly projectId: number; readonly projectUuid?: string }
  readonly updatedAt: string
  readonly entries: readonly EtlIdMapEntry[]
}

/** What the caller learned about the disk, so this module can stay pure. */
export interface EtlDiskProbe {
  /**
   * `same` = the path holds exactly the bytes the plan wants, `different` = it holds
   * something else, `absent` = nothing there.
   */
  probe(path: string, sha256: string): 'same' | 'different' | 'absent'
}

export interface EtlPlanOptions {
  /** `keep` (default) preserves the legacy numbering; `compact` renumbers 1..N over the reading order. */
  readonly renumber?: 'keep' | 'compact'
  readonly probe: EtlDiskProbe
  /** Rows a previous run already migrated: `(table, id)` → what it wrote. */
  readonly prior?: ReadonlyMap<string, EtlIdMapEntry>
}

/** One file the plan wants on disk. `chars` counts the **body** for chapters, the whole text otherwise. */
export interface EtlWrite {
  readonly key: string
  readonly table: EtlTable
  readonly legacyId: number
  readonly entityId: string
  readonly path: string
  readonly text: string
  readonly chars: number
  readonly sha256: string
}

/** Why one planned file will not be written this run. */
export type EtlItemState = 'write' | 'migrated' | 'conflict'

export interface EtlItem {
  readonly key: string
  readonly table: EtlTable
  /** The id the file's frontmatter carries (also what the id map records). */
  readonly entityId: string
  readonly path: string
  readonly sha256: string
  readonly chars: number
  readonly state: EtlItemState
  /** `conflict` only: the code a caller can act on (`ETL_TARGET_EXISTS`, `ETL_MAPPING_STALE`). */
  readonly code?: string
  readonly detail?: string
}

export interface EtlClassReport {
  readonly table: EtlTable
  /** Rows in the old database for this class. */
  readonly legacyRows: number
  /** Rows that ended up in the plan (a file, a bullet, a line, a field). */
  readonly mapped: number
  /** Rows the new model has no place for (an empty category, an unused arc): recorded, not lost. */
  readonly dropped: number
  /** Rows that should have landed and did not — the only number the ≤1% check counts. */
  readonly lost: number
  /** `mapped + dropped + lost == legacyRows`; false means this module has a hole. */
  readonly balanced: boolean
  /** `lost / legacyRows` (0 when the class is empty). */
  readonly deviation: number
  /** `deviation <= 0.01` — the issue's acceptance threshold (A-26). */
  readonly ok: boolean
  readonly notes: readonly string[]
}

export interface EtlGap {
  /** `book` (whole-book numbering), `vol-NN`, or `loose` for chapters that belong to no volume. */
  readonly scope: string
  readonly present: readonly number[]
  readonly missing: readonly number[]
}

/** One thing the author has to decide; the migrator never decides it. */
export interface EtlDecision {
  readonly code: string
  readonly count: number
  readonly detail: string
  readonly hint: string
}

export interface EtlReconcile {
  readonly entities: {
    readonly legacy: number
    /** Rows accounted for: they landed, or the new model has no place for them (see `dropped`). */
    readonly planned: number
    /** Rows the new model has no place for — reported per class, and a decision of its own. */
    readonly dropped: number
    /** Rows that should have landed and did not. This is what `deviation` measures. */
    readonly lost: number
    readonly deviation: number
    readonly ok: boolean
    readonly threshold: number
  }
  readonly chars: {
    readonly legacy: number
    readonly planned: number
    readonly deviation: number
    readonly ok: boolean
    readonly threshold: number
  }
}

export interface EtlPlan {
  readonly source: {
    readonly db: string
    readonly projectId: number
    readonly projectUuid?: string
    readonly projectName: string
    readonly language?: string
    readonly targetWords?: number
    readonly rowCounts: Readonly<Record<EtlTable, number>>
  }
  readonly options: { readonly renumber: 'keep' | 'compact' }
  readonly classes: readonly EtlClassReport[]
  readonly items: readonly EtlItem[]
  readonly gaps: readonly EtlGap[]
  readonly decisions: readonly EtlDecision[]
  readonly warnings: readonly string[]
  readonly reconcile: EtlReconcile
  readonly totals: {
    readonly plannedFiles: number
    readonly write: number
    readonly migrated: number
    readonly conflict: number
    readonly chars: number
  }
  /** sha256 over the item set (`key|path|sha256`): what `apply` re-computes and compares. */
  readonly planToken: string
  /** The commit the author should run afterwards. Recorded, never executed (data-safety §3). */
  readonly commitSuggestion: string
}

export interface EtlComputation {
  readonly plan: EtlPlan
  /** The files to move into place, in plan order (`state: 'write'` only). */
  readonly writes: readonly EtlWrite[]
}
