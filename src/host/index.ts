/**
 * dsh-inkflow — Host half.
 *
 * One plugin for the whole long-form novel workflow. This is the P0 skeleton:
 * it proves the four hard integration points against a real DSH install
 * (tool registration, loopback HTTP route, SQLite persistence, workbench panel)
 * and nothing more. The data model and tool surface grow in P1.
 *
 * HARD DSH CONSTRAINTS this file obeys (verified on 0.2.1-rc.2):
 *   - The plugin API is release-candidate: depend only on `ctx.*` public
 *     surface, never on Host internal packages.
 *   - No runtime imports of `@deepseek-ai/*` (see src/host/context.ts).
 *   - Plugin code runs un-sandboxed with the user's own permissions; the
 *     plugin must validate its own inputs and never trust the browser.
 *   - Never append new event types to a session log; plugin-owned state
 *     (drafts, run records) lives in this plugin's own SQLite file.
 */

import type { HostContext } from './context.js'
import { resolveConfig } from './config.js'
import { openDatabase } from './db.js'
import { buildTools } from './tools.js'
import { createHttpHandler } from './routes.js'

/** Loader entry name; must match the row `id` semantics used by DSH. */
export const name = 'dsh-inkflow'

/**
 * Hard dependency: the tool registry. `webServer` is optional and injected
 * lazily so the plugin still works in a headless profile.
 */
export const inject = ['tools']

const VERSION = '0.0.1'

export function apply(ctx: HostContext, rawConfig: unknown): void {
  const config = resolveConfig(rawConfig)
  const log = ctx.logger('dsh-inkflow')

  const database = openDatabase(config.dbFile, (message) => log.info(message))
  ctx.effect(() => () => database.close())

  log.info(`ready: data=${config.dataDir} db=${config.dbFile}`)

  const tools = ctx.tools
  if (tools === undefined) {
    log.warn('tools service missing; inkflow_* tools are not registered')
  } else {
    for (const definition of buildTools({
      database,
      dataDir: config.dataDir,
      dbFile: config.dbFile,
      version: VERSION,
    })) {
      ctx.effect(() => tools.register(definition))
    }
    log.info('inkflow_* tools registered')
  }

  if (config.serveHttp) {
    ctx.inject(['webServer'], (scoped) => {
      const webServer = scoped.webServer
      if (webServer === undefined) return
      scoped.effect(() =>
        webServer.register({
          kind: 'prefix',
          path: '/inkflow',
          handler: createHttpHandler({
            database,
            dataDir: config.dataDir,
            dbFile: config.dbFile,
            version: VERSION,
          }),
        }),
      )
      log.info('http routes registered under /inkflow')
    })
  }
}
