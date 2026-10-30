/**
 * The plan stage: one action per fixable finding, an honest skip for every other,
 * and the derived files a run would rewrite — all without touching anything.
 *
 * WHY IT IS A FILE: planning is where the decisions live (which missing key is
 * additive, which outline parent is the right one, which status the evidence
 * fields imply), and it is the half a reader must be able to check against
 * `findings.ts` without the backup package and the write path in between.
 */

import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import { readCatalog } from './catalog.js'
import { rowsOf } from './domains/scan-helpers.js'
import type { OutlineRow } from './domains/outline-model.js'
import type { RelationKind } from './domains/relation-write.js'
import type { WorldRow } from './domains/world.js'
import type { Finding } from './findings.js'
import { boolField, parseMarkdown, stringArrayField, stringField } from './frontmatter.js'
import { findingKey, runDetection, summarize } from './repair-detect.js'
import type {
  PlanOptions,
  RepairAction,
  RepairKind,
  RepairPatchEntry,
  RepairPlan,
  RepairSkip,
} from './repair-types.js'

/**
 * The value `domains/relation.ts` reads when a relation file has no `kind:`.
 *
 * A constant, not a derived default: the repair makes the reader's fallback
 * **explicit in the file**, and the point of that is that the file then says what
 * the index already assumed. `RelationKind` pins it to the real catalogue.
 */
const RELATION_KIND_FALLBACK: RelationKind = 'character'

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
 * What a foreshadow's own evidence fields say its `status` must be (data-model §3.2.1).
 *
 * `status` is the machine's truth, but a hand-written file can contradict it — `status: planted`
 * next to `advancedAt: [outline-934]`, `resolved: true` under `status: advanced`. I-21 reports
 * that, and until the repair pass could write it the report was a dead end. There is
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
