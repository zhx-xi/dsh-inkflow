/**
 * The detect stage: run every existing check, reshape what it reports into the
 * one `Finding` shape, and answer with the same summary the report prints.
 *
 * WHY IT IS A FILE: detect is the only stage that may run without a plan (the
 * `detect` action of the tool, the audit, and the before/after pair of a fix
 * run), and it was the cheapest thing to separate — it reads and never writes,
 * so a reader who wants to know "what does this book report" no longer has to
 * scroll past the plan or the backup package.
 */

import { resolve } from 'node:path'

import { validateCatalog } from './catalog.js'
import { compareFindings, findingCode, locatorKey } from './findings.js'
import type { Finding, FindingLocator, FindingSeverity } from './findings.js'
import { scanProject } from './indexer.js'
import type { ScanResult, ValidationIssue } from './indexer.js'
import type { DetectResult, DetectSummary } from './repair-types.js'

const INFO_CODES = new Set(['ID_PATH_DIVERGED', 'TIMELINE_WORLD_TIME_REVERSED'])

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

interface Detection {
  root: string
  scan: ScanResult
  findings: Finding[]
  unknown: Array<{ code: string; count: number }>
}

export function summarize(findings: readonly Finding[]): DetectSummary[] {
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
export function runDetection(projectRoot: string): Detection {
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
