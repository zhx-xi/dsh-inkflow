/**
 * dsh-inkflow — Host half.
 *
 * Architecture (ADR-0005): **files are the truth**, SQLite is a rebuildable
 * derived index living inside each project's `index/` directory. There is no
 * plugin-wide database and therefore no database migration: a project outlives
 * every plugin upgrade, and a new index layout is just a new schema version
 * that causes a delete-and-rebuild.
 *
 * HARD DSH CONSTRAINTS this file obeys (verified on 0.2.1-rc.2):
 *   - The plugin API is release-candidate: depend only on `ctx.*` public surface.
 *   - No runtime imports of `@deepseek-ai/*` (see src/host/context.ts).
 *   - Plugin code runs un-sandboxed with the user's own permissions; the plugin
 *     must validate its own inputs and never trust the browser.
 *   - Never append new event types to a session log.
 */

import type { HostContext } from './context.js'
import { resolveConfig } from './config.js'
import { readState } from './state.js'
import { buildTools } from './tools.js'
import { createHttpHandler } from './routes.js'

export const name = 'dsh-inkflow'

/**
 * The frontmatter reader/writer is re-exported from the bundle entry so the
 * contract tests can drive it directly (they import lib/index.js only). The P1
 * proposal writer uses the same pair in-process, so this is not a test-only
 * surface: `parseMarkdown` reads a file, `patchFrontmatter` rewrites one line.
 */
export { parseMarkdown, patchFrontmatter } from './frontmatter.js'
export type { FrontmatterPatchResult, ParsedMarkdown } from './frontmatter.js'

/** Hard dependency: the tool registry. `webServer` is injected lazily. */
export const inject = ['tools']

const VERSION = '0.0.2'

/**
 * Index-build API for embedders and tests. Tools/routes use these too; exporting
 * them from the entry point keeps the structured error contract addressable
 * without pulling in plugin assembly (`IndexBuildError` is the documented
 * failure type for `buildIndex`).
 */
export { buildIndex, describeIndexBuildFailure, IndexBuildError } from './index-build.js'
export type { IndexBuildErrorCode, IndexBuildFailure } from './index-build.js'
export type { IndexBuildResult } from './indexer.js'

export function apply(ctx: HostContext, rawConfig: unknown): void {
  const config = resolveConfig(rawConfig)
  const log = ctx.logger('dsh-inkflow')

  log.info(`ready: files-first mode, plugin state=${config.dataDir}`)

  // state.json is display-only (issue #7): it records the last project some
  // session touched, purely so a human can see it in the logs. It is never used
  // to resolve a project — one plugin-wide value cannot speak for a session.
  const remembered = readState(config.dataDir).lastProjectRoot
  if (remembered !== undefined) log.info(`last touched project (display only, not used for resolution): ${remembered}`)

  const tools = ctx.tools
  if (tools === undefined) {
    log.warn('tools service missing; inkflow_* tools are not registered')
  } else {
    for (const definition of buildTools({ ctx, dataDir: config.dataDir, version: VERSION })) {
      ctx.effect(() => tools.register(definition))
    }
    log.info('inkflow_* tools registered (files-first, derived index)')
  }

  if (config.serveHttp) {
    ctx.inject(['webServer'], (scoped) => {
      const webServer = scoped.webServer
      if (webServer === undefined) return
      scoped.effect(() =>
        webServer.register({
          kind: 'prefix',
          path: '/inkflow',
          handler: createHttpHandler({ ctx, dataDir: config.dataDir, version: VERSION }),
        }),
      )
      log.info('http routes registered under /inkflow')
    })
  }
}
