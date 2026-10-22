/**
 * Domain module registry — roadmap §2.1 (X-5).
 *
 * Every content directory that grows its own parser, invariants, tables and tools
 * registers one module here. Empty on purpose today: #101 only establishes the
 * seam, so the batch that follows (#24–#29) adds a line instead of editing
 * `indexer.ts` or the 880-line literal in `tools.ts`.
 *
 * Two things live here besides the list: `domainTools()` (the tool aggregate) and
 * `applyCandidate()` (the **only** implementation of "replace one path's rows").
 * Both are pure, so the tests drive them with a stub module and no registry
 * mutation — the registry itself stays a read-only list in production.
 */

import type { ToolDefinition } from '../context.js'
import type { DomainEntityRef, DomainFileParse, DomainModule, DomainScanResult } from './types.js'

/**
 * Registered modules, in a stable order.
 *
 * `readonly` is deliberate (X-5): a domain adds one entry here, never rewrites the
 * array. Insertion point is by `kind` in alphabetical order so two domain branches
 * conflict on adjacent lines at worst, which rebase resolves mechanically.
 */
export const DOMAIN_MODULES: readonly DomainModule[] = [
  // #24 outlines · #25 characters · #26 world · #27 relations · #28 timeline · #29 mentions
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
