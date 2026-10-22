/**
 * Domain module registry — roadmap §2.1 (X-5).
 *
 * Every content directory that owns a parser, invariants, tables and tools registers
 * one module here; the index only aggregates what the registry returns. The list is
 * the single place a domain touches, ordered by `kind` so two domain branches
 * conflict on adjacent lines at worst, which rebase resolves mechanically.
 *
 * Besides the list this module holds `domainTools()` (the tool aggregate). The other
 * seam helper — `applyCandidate()`, the **only** implementation of "replace one path's
 * rows" — moved to `./types.js` in #24: a domain's own tools have to run that fold
 * before writing, and importing this registry from a domain would close a runtime
 * import cycle (registry → domains → registry). Both names are re-exported below, so
 * no importer changes.
 */

import type { ToolDefinition } from '../context.js'
import { chapterDomain } from './chapter.js'
import { characterDomain } from './character.js'
import { outlineDomain } from './outline.js'
import { worldDomain } from './world.js'
import type {
  DomainEntityRef,
  DomainFileParse,
  DomainModule,
  DomainScanResult,
  DomainToolDeps,
} from './types.js'
/** Registered modules, ordered by `kind`. */
export const DOMAIN_MODULES: readonly DomainModule[] = [
  chapterDomain,
  characterDomain,
  outlineDomain,
  worldDomain,
  // #27 relations · #28 timeline · #29 mentions · #31 foreshadowing state machine
]

/**
 * Flatten every registered module's tools.
 *
 * `deps` is passed straight through: a domain tool resolves the book from the session
 * context (same as a built-in tool), and this aggregate never inspects it.
 */
export function domainTools(deps: DomainToolDeps, modules: readonly DomainModule[] = DOMAIN_MODULES): ToolDefinition[] {
  const tools: ToolDefinition[] = []
  for (const module of modules) tools.push(...module.tools(deps))
  return tools
}

export { applyCandidate } from './types.js'
export type { DomainWriteView } from './types.js'
