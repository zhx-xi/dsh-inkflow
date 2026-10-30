/**
 * The copy direction's wire shapes: what a copy request, a copy result, a row of
 * the stale list and an `origin` block look like from the outside.
 *
 * WHY IT IS A FILE: the operations (`shared-copy.ts`) and the book-side
 * provenance layer (`shared-copy-provenance.ts`) both name these shapes, and the
 * provenance layer must not import the operations back. A leaf module keeps the
 * graph acyclic, the same reason `internal-types.ts` exists for the channel.
 */

import { SHARED_COPY_MODE, SHARED_REFERENCE_MODE } from './conventions.js'
import type { SharedKind } from './conventions.js'

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** `origin` on a copy: evidence of WHICH version was copied (ADR-0007 C3). */
export interface SharedOriginCopy {
  projectId: string | null
  entryId: string
  contentHash: string
}

/** `origin` on a reference card: the source hash, and no copy hash (C4). */
export interface SharedOriginReference {
  projectId: string | null
  entryId: string
  sha256: string
}

export type SharedCopyMode = typeof SHARED_COPY_MODE | typeof SHARED_REFERENCE_MODE

export interface SharedCopyError {
  code: string
  message: string
  hint?: string
  path?: string
}

export type SharedResult<T> = { ok: true; value: T } | { ok: false; error: SharedCopyError }

export interface SharedCopyInput {
  /** The plugin data directory; `shared/` under it is the source library. */
  dataDir: string
  /** The book to copy INTO (already past the gate: this module never gates). */
  root: string
  entryId: string
  mode?: SharedCopyMode
  confirm?: boolean
}

export interface SharedCopyValue {
  root: string
  entryId: string
  kind: SharedKind
  mode: SharedCopyMode
  /** Project-relative files this call created (empty for a series link). */
  files: string[]
  origin?: SharedOriginCopy | SharedOriginReference
  /** `true` when this call added `projectId` to `inkflow.json`. */
  projectIdCreated: boolean
  projectId: string | null
  /** Present for a series entry: the `inkflow.json.seriesId` it set. */
  seriesId?: string
  /** Things the user should know but that are not failures. */
  warnings: string[]
}

export interface SharedUpdateInput {
  dataDir: string
  root: string
  /** Address the copy by its shared entry id… */
  entryId?: string
  /** …or by the project file it lives at (which is what the panel shows). */
  file?: string
  confirm?: boolean
}

export interface SharedUpdateValue {
  root: string
  updated: string[]
  unchanged: string[]
  /** Absent when nothing was written: a no-op leaves no package behind. */
  backupDir?: string
  origin?: SharedOriginCopy
}

/** What the "only the differences" view prints per copy (ADR-0007 V3). */
export interface SharedCopyRow {
  file: string
  kind: SharedKind
  /** `null` for a file whose `origin` block carries no id (hand-edited). */
  entryId: string | null
  mode: SharedCopyMode
  /** The hash recorded in `origin` at copy time. */
  contentHash?: string
  /** The shared entry's hash right now; absent when the source is gone. */
  currentHash?: string
  state: 'current' | 'stale' | 'missing-source'
}

export interface SharedCopiesValue {
  root: string
  projectId: string | null
  seriesId: string | null
  seriesFound: boolean
  /** `false` when at least one copy is a reference (ADR-0007 C4). */
  selfContained: boolean
  entries: SharedCopyRow[]
  /** The reference cards by path, so a caller can name them without filtering. */
  references: string[]
  counts: { total: number; current: number; stale: number; missing: number }
  /** True when the walk hit its cap: the list is short, not complete. */
  truncated: boolean
}

export interface EnsureProjectIdValue {
  /** `null` when `inkflow.json` cannot be read or parsed: `origin.projectId` is then `null`. */
  projectId: string | null
  /** `true` only when THIS call wrote the field. */
  created: boolean
}

/** Copies considered in one status answer; beyond this the list says `truncated`. */
export const SHARED_COPY_MAX_ROWS = 500
