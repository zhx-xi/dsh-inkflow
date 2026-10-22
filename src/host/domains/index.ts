/**
 * Domain module registry — roadmap §2.1 (X-5).
 *
 * Every content directory that owns a parser, invariants, tables and tools registers
 * one module here; the index only aggregates what the registry returns. The list is
 * the single place a domain touches, ordered by `kind` so two domain branches
 * conflict on adjacent lines at worst, which rebase resolves mechanically.
 *
 * Two helpers live here besides the list: `domainTools()` (the tool aggregate) and
 * `applyCandidate()` (the **only** implementation of "replace one path's rows"). Both
 * are pure, so the contract test drives them with a stub module and leaves the
 * production registry untouched.
 */

import type { ToolDefinition } from '../context.js'
import { chapterDomain } from './chapter.js'
import { characterDomain } from './character.js'
import { outlineDomain } from './outline.js'
import { worldDomain } from './world.js'
import type { DomainEntityRef, DomainFileParse, DomainModule, DomainScanResult } from './types.js'

/** Registered modules, ordered by `kind`. */
export const DOMAIN_MODULES: readonly DomainModule[] = [
  chapterDomain,
  characterDomain,
  outlineDomain,
  worldDomain,
  // #27 relations · #28 timeline · #29 mentions · #31 foreshadowing state machine
]

/** Flatten every registered module's tools; the aggregate stays a pure function. */
export function domainTools(modules: readonly DomainModule[] = DOMAIN_MODULES): ToolDefinition[] {
  const tools: ToolDefinition[] = []
  for (const module of modules) tools.push(...module.tools())
  return tools
}

/** The pair every invariant check looks at: one domain's rows plus the cross-class projections. */
export interface DomainWriteView {
  readonly scan: DomainScanResult
  readonly entities: readonly DomainEntityRef[]
}

/**
 * Fold one parsed file into a whole-project view: this path's old rows and old
 * projection row are dropped first, then the candidate's are added.
 *
 * Why it lives here and not in each domain: seven domains doing "drop then add" by
 * hand is the same duplication X-1 forbids for `name_key`. It also keeps `I-04`
 * honest — an in-place edit would otherwise report itself as a duplicate id,
 * because the projection still held the row being replaced.
 */
export function applyCandidate(view: DomainWriteView, parsed: DomainFileParse): DomainWriteView {
  const superseded = (path: string | undefined): boolean => path !== parsed.path

  const tables = view.scan.tables.map((table) => ({
    table: table.table,
    rows: [
      ...table.rows.filter((row) => String(row['path'] ?? '') !== parsed.path),
      ...(parsed.rows.find((candidate) => candidate.table === table.table)?.rows ?? []),
    ],
  }))

  // A table the candidate fills but the current view has no rows for (first write
  // of a path into an otherwise empty table) must still be carried over.
  for (const candidate of parsed.rows) {
    if (!tables.some((table) => table.table === candidate.table)) {
      tables.push({ table: candidate.table, rows: [...candidate.rows] })
    }
  }

  const projection = [...view.scan.entities.filter((entity) => superseded(entity.path))]
  if (parsed.entity !== undefined) projection.push(parsed.entity)

  const entities = [...view.entities.filter((entity) => superseded(entity.path))]
  if (parsed.entity !== undefined) entities.push(parsed.entity)

  const issues = [
    ...view.scan.issues.filter((issue) => issue.path === undefined || superseded(issue.path)),
    ...parsed.issues,
  ]

  return { scan: { tables, entities: projection, issues }, entities }
}
