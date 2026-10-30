/**
 * The repair pass: detect → preview → fix, over the findings vocabulary (X-14).
 *
 * This module does **not** re-implement any check. Every problem it reports comes
 * from a check that already exists — `scanProject()` (structure, ledger, foreshadow,
 * timeline) and `validateCatalog()` (the committed catalog projection) — and is only
 * *reshaped* into the one `Finding` shape the audit report and this repairer
 * share. What it adds is the second half of X-14: one repair action per finding, an
 * honest list of what it will not touch, and a re-run of the same checks afterwards
 * to prove the fix landed.
 *
 * Three properties the shape is built around:
 *
 *   1. **Three stages, separately runnable.** `detectFindings()` reads only;
 *      `planRepair()` reads only (no write lock, no `index/` creation, no
 *      `.gitignore` append); `applyRepair()` is the only writer and refuses without
 *      `confirm: true`.
 *   2. **Only-add is the default, and every "modify" is a projection.** A repair may
 *      append a missing frontmatter key, re-point a `parent:`, remove a duplicate
 *      relation (its bytes go into the backup first) and rewrite the chapter catalog
 *      — because the catalog is a *derived* projection of the `.md` files
 *      (ADR-0006 D6). No repair ever rewrites prose, a title, an id or a body byte.
 *   3. **`fixable: false` means "do not touch it".** The catalogue in `findings.ts`
 *      is the single decision about what a batch fix may do; a code marked `false`
 *      (a dangling relation endpoint, an unparsable fact line) is reported with a
 *      reason instead of being "repaired" by inventing data. A fixable code with no
 *      action in this build is reported the same way.
 *
 * Everything a fix run touches is first copied into `<book>/.inkflow/backup/`
 * (`backup.ts`), so the whole batch can be rolled back byte for byte.
 *
 * WHERE EACH STAGE LIVES: detection is `repair-detect.ts`, the plan (and the one
 * derivation a fix is allowed to write) `repair-plan.ts`, the write path
 * `repair-apply.ts`, and the contract all three share `repair-types.ts`. This
 * file re-exports the same public names, so a caller still imports one module
 * while a reader opens only the stage they care about.
 */

export { detectFindings, findingKey } from './repair-detect.js'
export { applyRepair } from './repair-apply.js'
export { deriveForeshadowStatus, planRepair } from './repair-plan.js'

export type {
  ApplyOptions,
  DetectResult,
  DetectSummary,
  PlanOptions,
  RepairAction,
  RepairKind,
  RepairOutcome,
  RepairPatchEntry,
  RepairPlan,
  RepairResult,
  RepairSkip,
} from './repair-types.js'
