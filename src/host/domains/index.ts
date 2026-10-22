/**
 * Domain module registry — roadmap §2.1 (X-5).
 *
 * Every content directory that grows its own parser, invariants, tables and tools
 * registers one module here. Empty on purpose today: #101 only establishes the
 * seam, so the batch that follows (#24–#29) adds a line instead of editing
 * `indexer.ts` or the 880-line literal in `tools.ts`.
 *
 * Why a function and not a spread at the call site: the aggregate has to be
 * testable without a registry mutation, so `domainTools()` takes the module list
 * as an argument and the tests pass a stub module.
 */

import type { ToolDefinition } from '../context.js'
import type { DomainModule } from './types.js'

/**
 * Registered modules, in a stable order.
 *
 * `readonly` is deliberate (X-5): a domain adds one entry here, never rewrites
 * the array. Insertion point is by `kind` in alphabetical order so two domain
 * branches conflict on adjacent lines at worst, which rebase resolves mechanically.
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
