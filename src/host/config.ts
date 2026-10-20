/**
 * Plugin configuration.
 *
 * Under ADR-0005 there is almost nothing to configure: the novel lives in its
 * own git repository and the directory names are fixed conventions. The only
 * plugin-owned path is where this plugin keeps its own small state file.
 */

import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'

export interface ResolvedConfig {
  /** Absolute directory holding this plugin's own state (NOT novel data). */
  dataDir: string
  /** Whether the loopback-only /inkflow/api/* routes are registered. */
  serveHttp: boolean
}

const DEFAULTS = { serveHttp: true } as const

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
  const serveHttp =
    typeof config['serveHttp'] === 'boolean' ? config['serveHttp'] : DEFAULTS.serveHttp
  return { dataDir, serveHttp }
}
