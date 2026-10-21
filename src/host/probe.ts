/**
 * Optional Host service lookup.
 *
 * A plugin must never throw because a *capability* is absent: a profile may
 * mount this plugin without the skills registry or the agent-preset registry.
 * `ctx.get(name)` is the non-injecting read (the `inject:` array, by contrast,
 * makes Cordis wait for the service and fail the plugin when it never arrives).
 *
 * The guard is required because `ctx.get` answers `unknown`: a service that is
 * present but of a different shape must degrade exactly like a missing one, or
 * the first real call throws inside a `ctx.effect` setup where nobody can
 * recover from it.
 */

import type { HostContext } from './context.js'

export function optionalService<T>(
  ctx: HostContext,
  name: string,
  guard: (value: Record<string, unknown>) => boolean,
): T | undefined {
  let value: unknown
  try {
    value = ctx.get(name)
  } catch {
    // A hard-injecting reader inside `get` may reject before the service
    // exists; "absent" is the answer the caller already handles.
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  return guard(record) ? (value as T) : undefined
}

/** Render an arbitrary rejection without trusting coercion. */
export function describeError(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'unrenderable thrown value'
  }
}
