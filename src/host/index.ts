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
import { buildTools } from './tools.js'
import { createHttpHandler } from './routes.js'

export const name = 'dsh-inkflow'

/** Hard dependency: the tool registry. `webServer` is injected lazily. */
export const inject = ['tools']

const VERSION = '0.0.2'

export function apply(ctx: HostContext, rawConfig: unknown): void {
  const config = resolveConfig(rawConfig)
  const log = ctx.logger('dsh-inkflow')

  log.info(`ready: files-first mode, plugin state=${config.dataDir}`)

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
