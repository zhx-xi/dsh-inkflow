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
  /** Estimated-token budget for the injected writing context. */
  promptBudgetTokens: number
  /** Characters taken from the previous chapter into that context. */
  promptTailChars: number
}

const DEFAULTS = { serveHttp: true, promptBudgetTokens: 1200, promptTailChars: 300 } as const

/**
 * Budgets are user-facing numbers in a YAML patch, so a typo must not decide
 * whether the chat works: out-of-range values are clamped, non-numbers fall
 * back to the default.
 */
const PROMPT_LIMITS = {
  tokens: { min: 200, max: 8000 },
  tailChars: { min: 60, max: 2000 },
} as const

/** $DSH_HOME, defaulting to ~/.dsh (the value DSH itself uses). */
export function dshHome(): string {
  const fromEnv = process.env['DSH_HOME']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv)
  return join(homedir(), '.dsh')
}

/**
 * The DEFAULT shared library root (ADR-0007 C1): `dataDir/shared`, and the only
 * place that spells it. Callers must pass the resolved `dataDir` — never `$DSH_HOME`
 * and never a path from a request (ADR-0010 D5).
 *
 * NOT THE ROOT IN FORCE. A reader that is about to open the library asks
 * `settings.ts`'s `sharedRootOf(dataDir)`, which answers this path only when
 * `settings.json` configures no usable `sharedRoot`. Keeping the default here
 * and the decision there means one function spells the directory and one decides it.
 */
export function sharedDir(dataDir: string): string {
  return join(dataDir, 'shared')
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
  return {
    dataDir,
    serveHttp,
    promptBudgetTokens: clampedInt(
      config['promptBudgetTokens'],
      DEFAULTS.promptBudgetTokens,
      PROMPT_LIMITS.tokens,
    ),
    promptTailChars: clampedInt(config['promptTailChars'], DEFAULTS.promptTailChars, PROMPT_LIMITS.tailChars),
  }
}

/** A finite integer clamped into `limits`, or the default when it is not a number. */
function clampedInt(
  value: unknown,
  fallback: number,
  limits: { readonly min: number; readonly max: number },
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), limits.min), limits.max)
}
