/**
 * The repair pass's contract: what a detection answer, an action, a plan, one
 * applied outcome and the whole run look like.
 *
 * WHY IT IS A FILE: three stages (`repair-detect.ts` / `repair-plan.ts` /
 * `repair-apply.ts`) and the tool surface all name these shapes, and a stage
 * must not import the next one back. A leaf module keeps the graph acyclic, the
 * same reason `chapters-types.ts` exists for the chapter operations.
 */

import type { Finding, FindingGroup } from './findings.js'
import type { IndexCounts } from './indexer.js'

export interface DetectSummary {
  group: FindingGroup
  total: number
  fixable: number
}

export interface DetectResult {
  root: string
  findings: Finding[]
  summary: DetectSummary[]
  /** Codes the host emitted that the catalogue does not know (should stay empty). */
  unknown: Array<{ code: string; count: number }>
  counts: IndexCounts
  files: number
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type RepairKind =
  | 'patch-frontmatter'
  | 'derive-foreshadow-status'
  | 'reparent-outline'
  | 'remove-duplicate'
  | 'rebuild-catalog'

/** One `key: value` line a patch writes. Rendered verbatim, so the preview cannot lie. */
export interface RepairPatchEntry {
  key: string
  value: string
}

export interface RepairAction {
  /** Stable selection handle: `${kind}|${path}`. */
  key: string
  kind: RepairKind
  /** Project-relative primary target. */
  path: string
  /** Finding codes this action clears. */
  codes: string[]
  /** The findings (by key) this action addresses. */
  findingKeys: string[]
  /** What the action does, with the concrete values it writes. */
  detail: string
  /** `patch-frontmatter` / `reparent-outline`: the exact lines to write. */
  patch?: RepairPatchEntry[]
}

export interface RepairSkip {
  key: string
  code: string
  path: string | undefined
  fixable: boolean
  reason: string
}

export interface RepairPlan {
  root: string
  detect: DetectResult
  actions: RepairAction[]
  skipped: RepairSkip[]
  /** Derived files the run will rewrite (covered by the backup like anything else). */
  projections: string[]
}

export interface PlanOptions {
  /**
   * Which actions to plan: action keys (`patch-frontmatter|facts/a.md`), finding
   * keys (`FRONTMATTER_ISSUE|facts/a.md`) or bare codes (`CATALOG_STALE`). Absent
   * or empty means "every fixable finding".
   */
  select?: readonly string[]
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface RepairOutcome {
  action: RepairAction
  ok: boolean
  /** What changed, in one line (`subject`, `parent`, `removed`, `rebuilt N catalog file(s)`). */
  detail: string
  error?: { code: string; message: string }
}

export interface RepairResult {
  ok: boolean
  root: string
  before: DetectResult
  plan: RepairPlan
  applied: RepairOutcome[]
  backup?: { dir: string; manifestPath: string }
  after?: DetectResult
  /** Finding keys the re-run no longer reports. */
  cleared: string[]
  /** Findings that survived the pass (the report says why for each). */
  remaining: Finding[]
  report?: { path: string; written: boolean; error?: string }
  error?: { code: string; message: string; hint?: string; nothingWritten?: boolean }
  requiresConfirmation?: boolean
}

export interface ApplyOptions extends PlanOptions {
  /** Required for a write: a fix run is a deliberate answer to a shown plan. */
  confirm?: boolean
  /** Injectable clock, so a test can pin the backup/report stamp. */
  now?: Date
}
