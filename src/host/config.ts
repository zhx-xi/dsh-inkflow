/**
 * Plugin configuration, resolved from the `cordis.patch.yml` row.
 *
 * Every path is configurable because the user's patch layer outlives plugin
 * upgrades; code must never hard-code a machine-specific location.
 */

import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'

export interface ResolvedConfig {
  /** Absolute directory holding this plugin's own state. */
  dataDir: string
  /** Absolute path of the SQLite database (truth source for novel data). */
  dbFile: string
  /** Whether the loopback-only /inkflow/api/* routes are registered. */
  serveHttp: boolean
}

const DEFAULTS = {
  dbFile: 'inkflow.db',
  serveHttp: true,
} as const

/** $DSH_HOME, defaulting to ~/.dsh (the value DSH itself uses). */
export function dshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function resolveConfig(raw: unknown): ResolvedConfig {
  const config = asRecord(raw)

  const configured = nonEmptyString(config['dataDir'])
  const dataDir = configured
    ? isAbsolute(configured)
      ? configured
      : resolve(dshHome(), configured)
    : join(dshHome(), 'inkflow')

  const dbName = nonEmptyString(config['dbFile']) ?? DEFAULTS.dbFile
  const dbFile = isAbsolute(dbName) ? dbName : join(dataDir, dbName)

  const serveHttp =
    typeof config['serveHttp'] === 'boolean' ? config['serveHttp'] : DEFAULTS.serveHttp

  return { dataDir, dbFile, serveHttp }
}
