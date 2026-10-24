/**
 * The repair pass (#36): detect → preview → fix, over the findings vocabulary (#121, X-14).
 *
 * This module does **not** re-implement any check. Every problem it reports comes
 * from a check that already exists — `scanProject()` (structure, ledger, foreshadow,
 * timeline) and `validateCatalog()` (the committed catalog projection) — and is only
 * *reshaped* into the one `Finding` shape the audit report (#33) and this repairer
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
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import { digestRelative, newBackupBody, openBackup, sealBackup, stageFile } from './backup.js'
import type { BackupBody, BackupDigest, BackupFileEntry, BackupHandle } from './backup.js'
import { readCatalog, rebuildCatalog, validateCatalog } from './catalog.js'
import { rowsOf } from './domains/scan-helpers.js'
import type { OutlineRow } from './domains/outline-model.js'
import type { RelationKind } from './domains/relation-write.js'
import type { WorldRow } from './domains/world.js'
import { compareFindings, findingCode, locatorKey } from './findings.js'
import type { Finding, FindingGroup, FindingLocator, FindingSeverity } from './findings.js'
import { boolField, parseMarkdown, patchFrontmatter, stringArrayField, stringField } from './frontmatter.js'
import { scanProject } from './indexer.js'
import type { IndexCounts, ScanResult, ValidationIssue } from './indexer.js'
import { removeProjectFile, writeTextAtomic } from './io.js'
import { repairReportMarkdown, writeAuditReport } from './repair-report.js'

const INFO_CODES = new Set(['ID_PATH_DIVERGED', 'TIMELINE_WORLD_TIME_REVERSED'])

/**
 * The value `domains/relation.ts` reads when a relation file has no `kind:`.
 *
 * A constant, not a derived default: the repair makes the reader's fallback
 * **explicit in the file**, and the point of that is that the file then says what
 * the index already assumed. `RelationKind` pins it to the real catalogue.
 */
const RELATION_KIND_FALLBACK: RelationKind = 'character'

/** Which directory a path-less finding belongs to, so every finding has an address. */
function defaultDirFor(code: string): string {
  if (code.startsWith('OUTLINE_')) return 'outlines'
  if (code.startsWith('WORLD_')) return 'world'
  if (code.startsWith('CHARACTER_')) return 'characters'
  if (code.startsWith('RELATION_')) return 'relations'
  if (code.startsWith('FACT_')) return 'facts'
  if (code.startsWith('FORESHADOW_')) return 'foreshadowing'
  if (code.startsWith('TIMELINE_')) return 'timeline'
  if (code.startsWith('CHAPTER_') || code.startsWith('CATALOG_') || code.startsWith('VOLUME_')) return 'chapters'
  return '.'
}

/** Split the `path#L<n>` anchor the facts domain writes into a locator. */
function splitAnchor(value: string | undefined): { path: string | undefined; line: number | undefined } {
  if (value === undefined || value === '') return { path: undefined, line: undefined }
  const match = /^(.*)#L(\d+)$/.exec(value)
  if (match === null) return { path: value, line: undefined }
  return { path: match[1], line: Number(match[2]) }
}

function locatorOf(code: string, rawPath: string | undefined): FindingLocator {
  const { path, line } = splitAnchor(rawPath)
  if (path === undefined) return { kind: 'path', path: defaultDirFor(code) }
  return line === undefined ? { kind: 'path', path } : { kind: 'path', path, line }
}

function severityOf(code: string): FindingSeverity {
  // `blocking` only ever comes from a write (`findings.ts`), so a scan never says it.
  return INFO_CODES.has(code) ? 'info' : 'warning'
}

/** One finding's stable address inside a run: `CODE|locator`. */
export function findingKey(finding: Finding): string {
  return `${finding.code}|${locatorKey(finding.locator)}`
}

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

interface Detection {
  root: string
  scan: ScanResult
  findings: Finding[]
  unknown: Array<{ code: string; count: number }>
}

function summarize(findings: readonly Finding[]): DetectSummary[] {
  const summary: DetectSummary[] = []
  for (const finding of findings) {
    const bucket = summary.find((entry) => entry.group === finding.group)
    if (bucket === undefined) {
      summary.push({ group: finding.group, total: 1, fixable: finding.fixable ? 1 : 0 })
      continue
    }
    bucket.total += 1
    if (finding.fixable) bucket.fixable += 1
  }
  return summary
}

/** The one-line "what to do about it" the report prints next to a finding. */
function repairHint(code: string): string {
  switch (code) {
    case 'CATALOG_STALE':
    case 'CHAPTER_FILE_MISSING':
      return 'run the repair pass; `chapters/index.json` is a projection and is rebuilt from the `.md` files'
    case 'OUTLINE_VOLUME_PARENT':
    case 'OUTLINE_VOLUME_IN_VOLUME':
      return 'run the repair pass: the volume outline is re-attached to the overall outline'
    case 'OUTLINE_CHAPTER_IN_CHAPTER':
      return 'run the repair pass: the chapter outline is re-attached to its grandparent (the volume or the overall)'
    case 'WORLD_CATEGORY_REQUIRED':
      return 'run the repair pass: the category of the parent entry is copied in'
    case 'RELATION_DUPLICATE':
      return 'run the repair pass: the later duplicate file is removed (a copy stays in `.inkflow/backup/`)'
    case 'FRONTMATTER_ISSUE':
      return 'run the repair pass when a required key is missing; an unclosed block or an unparsable line needs a human'
    case 'FORESHADOW_TRANSITION_INVALID':
      return 'run the repair pass: `status` is derived from `resolved` / `resolvedChapter` / `advancedAt`; two contradictory evidence shapes are left to you'
    case 'FORESHADOW_RESOLVED_WITHOUT_CHAPTER':
      return 'name the chapter that pays the setup off (`resolvedChapter`), or set the status back to `advanced` / `planted`'
    case 'DUPLICATE_ID':
    case 'CHARACTER_NAME_DUPLICATE':
      return 'two entries claim one identity: rename one of them (the repair pass never picks a winner)'
    case 'DANGLING_PARENT':
    case 'RELATION_ENDPOINT':
      return 'point the reference at an existing entry, or create it; the repair pass never invents an entity'
    case 'ID_PATH_DIVERGED':
      return 'nothing to do: this is the normal state after a rename (ADR-0014)'
    default:
      return 'see `.agents/specs/data-model.md` §5 for the invariant behind this code'
  }
}

/**
 * Run every existing check and reshape the result into findings.
 *
 * `scanProject` is the same function the index build uses, so the repair pass sees
 * exactly what a rebuild would report; `validateCatalog` is added because the
 * catalog projection is not part of the index scan (it validates the committed
 * `index.json` files against the `.md` tree).
 */
function runDetection(projectRoot: string): Detection {
  const root = resolve(projectRoot)
  const scan = scanProject(root)
  const catalog = validateCatalog(root)
  const issues: ValidationIssue[] = [...scan.issues, ...catalog.issues]

  const findings: Finding[] = []
  const seen = new Set<string>()
  const unknown = new Map<string, number>()

  for (const issue of issues) {
    const spec = findingCode(issue.code)
    if (spec === undefined) {
      unknown.set(issue.code, (unknown.get(issue.code) ?? 0) + 1)
      continue
    }
    const finding: Finding = {
      code: spec.code,
      group: spec.group,
      severity: severityOf(spec.code),
      locator: locatorOf(spec.code, issue.path),
      detail: issue.detail,
      hint: repairHint(spec.code),
      fixable: spec.fixable,
    }
    const key = `${findingKey(finding)}\u0000${finding.detail}`
    if (seen.has(key)) continue
    seen.add(key)
    findings.push(finding)
  }

  findings.sort(compareFindings)
  return {
    root,
    scan,
    findings,
    unknown: [...unknown.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) => (left.code < right.code ? -1 : left.code > right.code ? 1 : 0)),
  }
}

/** Read-only detection: the `detect` stage of the three-stage contract. */
export function detectFindings(projectRoot: string): DetectResult {
  const detection = runDetection(projectRoot)
  return {
    root: detection.root,
    findings: detection.findings,
    summary: summarize(detection.findings),
    unknown: detection.unknown,
    counts: detection.scan.counts,
    files: detection.scan.files.length,
  }
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

function selectedBy(select: readonly string[] | undefined, action: RepairAction): boolean {
  if (select === undefined) return true
  const wanted = new Set(select.map((value) => value.trim()).filter((value) => value !== ''))
  if (wanted.size === 0) return true
  if (wanted.has(action.key)) return true
  for (const code of action.codes) if (wanted.has(code)) return true
  for (const key of action.findingKeys) if (wanted.has(key)) return true
  return false
}

interface ActionBuilder {
  kind: RepairKind
  path: string
  detail: string
  codes: Set<string>
  keys: Set<string>
  patch?: RepairPatchEntry[]
}

function stemOf(path: string): string {
  return basename(path).replace(/\.md$/u, '')
}

/**
 * Which missing frontmatter key this build is willing to add.
 *
 * Deliberately a two-row table: the two cases where the domain already **reads a
 * fallback**, so writing the key down changes no meaning and only stops the
 * warning. Everything else (an unclosed block, an unparsable line, a mistyped
 * enum) is a decision about the author's text, not a missing default.
 */
function additiveKeyFor(path: string, text: string): RepairPatchEntry | undefined {
  const dir = path.split('/')[0] ?? ''
  const parsed = parseMarkdown(text)
  if (dir === 'facts') {
    if ((stringField(parsed.data, 'subject') ?? '').trim() !== '') return undefined
    return { key: 'subject', value: stemOf(path) }
  }
  if (dir === 'relations') {
    if ((stringField(parsed.data, 'kind') ?? '').trim() !== '') return undefined
    return { key: 'kind', value: RELATION_KIND_FALLBACK }
  }
  return undefined
}

/**
 * Chapter catalog files the rebuild rewrites: covered by the backup like anything else.
 *
 * Derived from the **projection** (`readCatalog`), not from the files on disk: a
 * volume catalog that does not exist yet is exactly one of the files the rebuild
 * creates, and a rollback has to know about it or the migration leaves a new
 * `chapters/<dir>/index.json` behind. The side effect — `readCatalog` needs the
 * chapter tree — is harmless here: a book without `chapters/` reports no catalog
 * issues, so no rebuild action is planned.
 */
function catalogProjections(root: string): string[] {
  const read = readCatalog(root)
  const paths = new Set<string>(['chapters/index.json'])
  for (const volume of read.catalog.volumes) paths.add(`chapters/${volume.dir}/index.json`)
  return [...paths].sort()
}

/**
 * What a foreshadow's own evidence fields say its `status` must be (#136, data-model §3.2.1).
 *
 * `status` is the machine's truth, but a hand-written file can contradict it — `status: planted`
 * next to `advancedAt: [outline-934]`, `resolved: true` under `status: advanced`. I-21 reports
 * that, and before #136 the report was a dead end: the author had to hand-edit the file. There is
 * exactly one reading of the evidence, so the repair pass may write it:
 *
 *     `resolved: true` or a `resolvedChapter` → `resolved`
 *     otherwise `advancedAt` non-empty         → `advanced`
 *     otherwise                                → `planted`
 *
 * Two shapes are deliberately **not** derived, because the fields contradict each other and every
 * answer would be a guess (ADR-0015 D2):
 *
 *   * `resolved: false` **with** a `resolvedChapter` — the two fields disagree about one event, and
 *     no status clears I-21 (writing `resolved` leaves rule ② unsatisfied, writing `planted` denies
 *     the chapter);
 *   * `resolved: true` **without** a `resolvedChapter` — `status: resolved` would clear I-21 and
 *     immediately raise `FORESHADOW_RESOLVED_WITHOUT_CHAPTER`, i.e. trade one finding for another.
 *
 * `overdue` is never a target: it is a computed marker (data-model §3.2.2), not a progress state,
 * so the derivation only ever writes one of the three states the matrix defines.
 */
type StatusDerivation = { ok: true; status: 'planted' | 'advanced' | 'resolved' } | { ok: false; reason: string }

export function deriveForeshadowStatus(data: Record<string, unknown>): StatusDerivation {
  const resolved = boolField(data, 'resolved')
  const resolvedChapter = (stringField(data, 'resolvedChapter') ?? '').trim()
  const advancedAt = stringArrayField(data, 'advancedAt')
  if (resolved === false && resolvedChapter !== '') {
    return {
      ok: false,
      reason: `\`resolved: false\` contradicts \`resolvedChapter: ${resolvedChapter}\`: the two evidence fields disagree, so the status is the author's call`,
    }
  }
  if (resolved === true || resolvedChapter !== '') {
    if (resolvedChapter === '') {
      return {
        ok: false,
        reason:
          '`resolved: true` without `resolvedChapter`: writing `status: resolved` would swap I-21 for ' +
          'FORESHADOW_RESOLVED_WITHOUT_CHAPTER, so name the chapter that pays it off first',
      }
    }
    return { ok: true, status: 'resolved' }
  }
  if (advancedAt.length > 0) return { ok: true, status: 'advanced' }
  return { ok: true, status: 'planted' }
}

/** The status a foreshadow file declares today, with the reader's fallback (`resolved`-only files). */
function declaredStatusOf(data: Record<string, unknown>): string {
  const declared = (stringField(data, 'status') ?? '').trim()
  if (declared !== '') return declared
  return boolField(data, 'resolved') === true ? 'resolved' : 'planted'
}

/**
 * The `preview` stage: what a fix would do, without touching anything.
 *
 * Read-only down to the `readFileSync` calls that decide whether an additive key is
 * actually missing. No directory is created, no lock is taken, `.gitignore` is not
 * extended.
 */
export function planRepair(projectRoot: string, options: PlanOptions = {}): RepairPlan {
  const detection = runDetection(projectRoot)
  const outlineNodes = rowsOf<OutlineRow>(detection.scan, 'outline_nodes')
  const worldRows = rowsOf<WorldRow>(detection.scan, 'world_entries')
  const overall = outlineNodes.find((node) => node.kind === 'overall')
  const outlineById = new Map(outlineNodes.map((node) => [node.id, node]))
  const outlineByPath = new Map(outlineNodes.map((node) => [node.path, node]))

  const actions = new Map<string, ActionBuilder>()
  const skipped = new Map<string, RepairSkip>()

  const skip = (finding: Finding, reason: string): void => {
    const key = findingKey(finding)
    if (skipped.has(key)) return
    skipped.set(key, {
      key,
      code: finding.code,
      path: finding.locator.kind === 'path' ? finding.locator.path : undefined,
      fixable: finding.fixable,
      reason,
    })
  }

  const add = (kind: RepairKind, path: string, detail: string, finding: Finding, patch?: RepairPatchEntry[]): void => {
    const key = `${kind}|${path}`
    const existing = actions.get(key)
    if (existing !== undefined) {
      existing.codes.add(finding.code)
      existing.keys.add(findingKey(finding))
      return
    }
    actions.set(key, {
      kind,
      path,
      detail,
      codes: new Set([finding.code]),
      keys: new Set([findingKey(finding)]),
      ...(patch === undefined ? {} : { patch }),
    })
  }

  for (const finding of detection.findings) {
    const path = finding.locator.kind === 'path' ? finding.locator.path : undefined
    switch (finding.code) {
      case 'CATALOG_STALE':
      case 'CHAPTER_FILE_MISSING': {
        add(
          'rebuild-catalog',
          'chapters',
          'rebuild chapters/index.json and the per-volume catalogs from the .md files (the catalog is a derived projection)',
          finding,
        )
        break
      }
      case 'OUTLINE_VOLUME_PARENT':
      case 'OUTLINE_VOLUME_IN_VOLUME': {
        const node = path === undefined ? undefined : outlineByPath.get(path)
        if (node === undefined || path === undefined) {
          skip(finding, 'the node is not in the scan, so there is nothing to re-attach')
          break
        }
        if (overall === undefined) {
          skip(finding, 'there is no overall outline to attach the volume to (add outlines/overall.md first)')
          break
        }
        if (node.parent === overall.id) {
          skip(finding, 'the parent is already the overall outline')
          break
        }
        add(
          'reparent-outline',
          path,
          `parent: ${node.parent ?? '(none)'} → ${overall.id} (a volume hangs under the overall outline)`,
          finding,
          [{ key: 'parent', value: overall.id }],
        )
        break
      }
      case 'OUTLINE_CHAPTER_IN_CHAPTER': {
        const node = path === undefined ? undefined : outlineByPath.get(path)
        if (node === undefined || path === undefined) {
          skip(finding, 'the node is not in the scan, so there is nothing to re-attach')
          break
        }
        const parent = node.parent === undefined ? undefined : outlineById.get(node.parent)
        const target = parent?.parent ?? overall?.id
        if (target === undefined) {
          skip(finding, 'the chapter outline has no ancestor above its parent chapter, so the target is ambiguous')
          break
        }
        add(
          'reparent-outline',
          path,
          `parent: ${node.parent ?? '(none)'} → ${target} (three levels: overall / volume / chapter)`,
          finding,
          [{ key: 'parent', value: target }],
        )
        break
      }
      case 'WORLD_CATEGORY_REQUIRED': {
        const row = path === undefined ? undefined : worldRows.find((candidate) => candidate.path === path)
        if (row === undefined || path === undefined) {
          skip(finding, 'the entry is not in the scan, so its parent cannot be read')
          break
        }
        const parentRow = row.parent === undefined ? undefined : worldRows.find((candidate) => candidate.id === row.parent)
        const category = parentRow?.category
        if (category === undefined || category === '') {
          skip(finding, 'the parent entry carries no category either: pick the category yourself, the repair pass will not guess')
          break
        }
        add('patch-frontmatter', path, `category: ${category} (copied from the parent entry "${String(row.parent)}")`, finding, [
          { key: 'category', value: category },
        ])
        break
      }
      case 'RELATION_DUPLICATE': {
        if (path === undefined) {
          skip(finding, 'the finding has no file to remove')
          break
        }
        add(
          'remove-duplicate',
          path,
          `${finding.detail} — the index keeps the first file in path order, so this one is removed and its bytes go into .inkflow/backup/ first`,
          finding,
        )
        break
      }
      case 'FRONTMATTER_ISSUE': {
        if (path === undefined) {
          skip(finding, 'the finding has no file to patch')
          break
        }
        let text: string
        try {
          text = readFileSync(resolve(detection.root, path), 'utf8')
        } catch {
          skip(finding, 'the file is gone or unreadable, so there is nothing to patch')
          break
        }
        const stripped = text.replace(/^\uFEFF/, '')
        if (stripped.trimStart().startsWith('---') && !parseMarkdown(text).hasFrontmatter) {
          skip(finding, 'the frontmatter block is opened but never closed: only a human can decide where it ends')
          break
        }
        const additive = additiveKeyFor(path, text)
        if (additive === undefined) {
          skip(finding, 'this is not a missing required key (an unparsable line or a wrong value): a human has to decide')
          break
        }
        add('patch-frontmatter', path, `${additive.key}: ${additive.value}`, finding, [additive])
        break
      }
      case 'FORESHADOW_TRANSITION_INVALID': {
        if (path === undefined) {
          skip(finding, 'the finding has no file to patch')
          break
        }
        let text: string
        try {
          text = readFileSync(resolve(detection.root, path), 'utf8')
        } catch {
          skip(finding, 'the file is gone or unreadable, so there is no `status` line to rewrite')
          break
        }
        const parsed = parseMarkdown(text)
        if (!parsed.hasFrontmatter) {
          skip(finding, 'the file has no frontmatter block, so there is no `status` line to rewrite')
          break
        }
        const derived = deriveForeshadowStatus(parsed.data)
        if (derived.ok === false) {
          skip(finding, derived.reason)
          break
        }
        const current = declaredStatusOf(parsed.data)
        if (current === derived.status) {
          skip(finding, 'the status already says what the evidence fields say')
          break
        }
        add(
          'derive-foreshadow-status',
          path,
          `status: ${current} → ${derived.status} (derived from resolved / resolvedChapter / advancedAt; no other line changes)`,
          finding,
          [{ key: 'status', value: derived.status }],
        )
        break
      }
      default: {
        skip(
          finding,
          finding.fixable
            ? 'this build derives no repair action for this code yet'
            : 'the finding catalogue marks this code as not auto-fixable: repairing it would mean inventing data',
        )
      }
    }
  }

  const planned = [...actions.values()]
    .map<RepairAction>((builder) => ({
      key: `${builder.kind}|${builder.path}`,
      kind: builder.kind,
      path: builder.path,
      codes: [...builder.codes].sort(),
      findingKeys: [...builder.keys].sort(),
      detail: builder.detail,
      ...(builder.patch === undefined ? {} : { patch: builder.patch }),
    }))
    .filter((action) => selectedBy(options.select, action))
    // Execution order: file-local edits first, the derived projection last (it is
    // rebuilt from whatever the earlier actions left behind).
    .sort(
      (left, right) =>
        orderOf(left.kind) - orderOf(right.kind) || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    )

  const projections = planned.some((action) => action.kind === 'rebuild-catalog')
    ? catalogProjections(detection.root)
    : []

  return {
    root: detection.root,
    detect: {
      root: detection.root,
      findings: detection.findings,
      summary: summarize(detection.findings),
      unknown: detection.unknown,
      counts: detection.scan.counts,
      files: detection.scan.files.length,
    },
    actions: planned,
    skipped: [...skipped.values()].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)),
    projections,
  }
}

function orderOf(kind: RepairKind): number {
  switch (kind) {
    case 'patch-frontmatter':
      return 0
    // Same shape as `patch-frontmatter` (one frontmatter line, nothing else moves), so it sorts
    // with it rather than beside the pointer/structure actions.
    case 'derive-foreshadow-status':
      return 0
    case 'reparent-outline':
      return 1
    case 'remove-duplicate':
      return 2
    case 'rebuild-catalog':
      return 3
  }
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

interface StepOutcome {
  outcome: RepairOutcome
  entries: BackupFileEntry[]
}

type StageResult =
  | { ok: true; before: BackupDigest | undefined }
  | { ok: false; code: string; message: string }

/**
 * Execute the planned repairs.
 *
 * One action's failure does not abort the rest: each action is a single atomic file
 * write (or a single `removeProjectFile`), so continuing leaves no half-state —
 * unlike a migration, whose steps build one structure together. Every failure is
 * reported and the checks are re-run, so "ok" can never mean "some fixes silently
 * did not land".
 */
export function applyRepair(projectRoot: string, options: ApplyOptions = {}): RepairResult {
  const plan = planRepair(projectRoot, { select: options.select })
  const before = plan.detect

  if (plan.actions.length === 0) {
    return { ok: true, root: plan.root, before, plan, applied: [], cleared: [], remaining: before.findings }
  }

  if (options.confirm !== true) {
    return {
      ok: false,
      root: plan.root,
      before,
      plan,
      applied: [],
      cleared: [],
      remaining: before.findings,
      requiresConfirmation: true,
      error: {
        code: 'REPAIR_REQUIRES_CONFIRMATION',
        message: `nothing was written: ${String(plan.actions.length)} action(s) are planned`,
        hint: 'show the actions to the user, then call again with confirm: true (or narrow the run with `select`)',
        nothingWritten: true,
      },
    }
  }

  const now = options.now ?? new Date()
  const opened = openBackup(plan.root, 'repair', now)
  if (!opened.ok) {
    return {
      ok: false,
      root: plan.root,
      before,
      plan,
      applied: [],
      cleared: [],
      remaining: before.findings,
      error: { code: opened.error.code, message: opened.error.message, ...(opened.error.hint === undefined ? {} : { hint: opened.error.hint }), nothingWritten: true },
    }
  }
  const handle: BackupHandle = opened.value
  const body: BackupBody = newBackupBody()
  const backup = { dir: handle.dir, manifestPath: handle.manifestPath }

  // The package is described before the first change: a crash leaves a journal that
  // says which run it belonged to and that it never finished.
  const described = sealBackup(plan.root, handle, 'repair', body, false, now)
  if (!described.ok) {
    return {
      ok: false,
      root: plan.root,
      before,
      plan,
      applied: [],
      cleared: [],
      remaining: before.findings,
      error: { code: described.error.code, message: described.error.message, nothingWritten: true },
    }
  }

  const applied: RepairOutcome[] = []
  for (const action of plan.actions) {
    const step = runAction(plan.root, handle, action, plan.projections)
    applied.push(step.outcome)
    body.steps.push(`${action.kind} ${action.path}`)
    body.files.push(...step.entries)
  }

  sealBackup(plan.root, handle, 'repair', body, true, now)

  const after = detectFindings(plan.root)
  const beforeKeys = new Set(before.findings.map((finding) => findingKey(finding)))
  const afterKeys = new Set(after.findings.map((finding) => findingKey(finding)))
  const cleared = [...beforeKeys].filter((key) => !afterKeys.has(key)).sort()

  const report = writeAuditReport(
    plan.root,
    `repair-${stampForReport(now)}.md`,
    repairReportMarkdown({ root: plan.root, at: now, backup, before, plan, applied, after, cleared }),
  )

  return {
    ok: applied.every((outcome) => outcome.ok),
    root: plan.root,
    before,
    plan,
    applied,
    backup,
    after,
    cleared,
    remaining: after.findings,
    report: {
      path: report.path,
      written: report.ok,
      ...(report.error === undefined ? {} : { error: report.error }),
    },
  }
}

/** Same shape as `backupStamp`, kept local so the report name cannot drift from the package. */
function stampForReport(at: Date): string {
  const iso = at.toISOString()
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}${iso.slice(20, 23)}Z`
}

function runAction(root: string, handle: BackupHandle, action: RepairAction, projections: readonly string[]): StepOutcome {
  const entries: BackupFileEntry[] = []
  const failed = (code: string, message: string): StepOutcome => ({
    outcome: { action, ok: false, detail: '', error: { code, message } },
    entries,
  })

  const stage = (path: string, required: boolean): StageResult => {
    const staged = stageFile(root, handle, path)
    if (!staged.ok) return { ok: false, code: staged.error.code, message: staged.error.message }
    if (staged.value === undefined && required) {
      return { ok: false, code: 'PATH_NOT_FOUND', message: `${path} does not exist` }
    }
    return { ok: true, before: staged.value }
  }

  try {
    switch (action.kind) {
      case 'patch-frontmatter':
      case 'derive-foreshadow-status':
      case 'reparent-outline': {
        const target = resolve(root, action.path)
        if (!existsSync(target)) return failed('PATH_NOT_FOUND', `${action.path} does not exist`)
        let text: string
        try {
          text = readFileSync(target, 'utf8')
        } catch (cause) {
          return failed('FILE_UNREADABLE', `${action.path} could not be read: ${String(cause)}`)
        }
        const patched = patchText(text, action.patch ?? [])
        if (patched === undefined) {
          return failed('REPAIR_NO_EFFECT', `${action.path} already holds the value this repair would write`)
        }
        const staged = stage(action.path, true)
        if (!staged.ok) return failed(staged.code, staged.message)
        const written = writeTextAtomic(root, action.path, patched.text, { verbatim: true })
        if (!written.ok) return failed(written.error.code, written.error.message)
        const after = digestRelative(root, action.path)
        if (after === undefined) return failed('REPAIR_WRITE_LOST', `${action.path} is gone after the write`)
        entries.push({
          path: action.path,
          change: 'modified',
          ...(staged.before === undefined ? {} : { before: staged.before }),
          after,
        })
        return {
          outcome: { action, ok: true, detail: [...patched.appended, ...patched.replaced].join(', ') || 'rewritten' },
          entries,
        }
      }
      case 'remove-duplicate': {
        const staged = stage(action.path, true)
        if (!staged.ok) return failed(staged.code, staged.message)
        if (staged.before === undefined) {
          return failed('PATH_NOT_FOUND', `${action.path} does not exist`)
        }
        const removed = removeProjectFile(root, action.path)
        if (!removed.ok) return failed(removed.error.code, removed.error.message)
        entries.push({ path: action.path, change: 'removed', before: staged.before })
        return { outcome: { action, ok: true, detail: 'removed (its bytes stay in the backup)' }, entries }
      }
      case 'rebuild-catalog': {
        for (const projection of projections) {
          const staged = stage(projection, false)
          if (!staged.ok) return failed(staged.code, staged.message)
          entries.push({
            path: projection,
            change: staged.before === undefined ? 'created' : 'modified',
            ...(staged.before === undefined ? {} : { before: staged.before }),
            after: staged.before ?? { bytes: 0, sha256: '' },
          })
        }
        const rebuilt = rebuildCatalog(root)
        if (!rebuilt.ok) return failed(rebuilt.error.code, rebuilt.error.message)
        const recorded: BackupFileEntry[] = []
        for (const entry of entries) {
          const after = digestRelative(root, entry.path)
          if (after === undefined) continue
          recorded.push({ ...entry, after })
        }
        return {
          outcome: {
            action,
            ok: true,
            detail: `rebuilt ${String(rebuilt.written.length)} catalog file(s): ${rebuilt.written.join(', ')}`,
          },
          entries: recorded,
        }
      }
    }
  } catch (cause) {
    return failed('REPAIR_FAILED', cause instanceof Error ? cause.message : String(cause))
  }
}

/** The patched text for a set of `key: value` lines, or `undefined` when nothing would change. */
function patchText(text: string, entries: readonly RepairPatchEntry[]): { text: string; appended: string[]; replaced: string[] } | undefined {
  if (entries.length === 0) return undefined
  const values: Record<string, string> = {}
  for (const entry of entries) values[entry.key] = entry.value
  const parsed = parseMarkdown(text)
  if (!parsed.hasFrontmatter) {
    // No block at all: prepend one. Additive — not one byte of the author's text moves.
    const body = text.replace(/^\uFEFF/, '')
    const block = entries.map((entry) => `${entry.key}: ${entry.value}`).join('\n')
    return { text: `---\n${block}\n---\n\n${body}`, appended: entries.map((entry) => entry.key), replaced: [] }
  }
  const patched = patchFrontmatter(text, values)
  if (patched.appended.length === 0 && patched.replaced.length === 0) return undefined
  return { text: patched.text, appended: patched.appended, replaced: patched.replaced }
}
