/**
 * The Session's effective working directory.
 *
 * Extracted from `tools.ts` so a domain module can resolve the book the same way a
 * built-in tool does, without importing the built-in tool surface (that would be a
 * runtime cycle: `tools.ts` → `domains/index` → `domains/world` → `tools.ts`).
 *
 * Uses the public `workingDirectory` service when the profile has it, and degrades to
 * the process cwd otherwise — a plugin must not throw just because an optional host
 * service is absent.
 */

import type { HostContext, ToolRunContext } from './context.js'

export async function sessionCwd(ctx: HostContext, exec: ToolRunContext): Promise<string> {
  const service = ctx.get('workingDirectory') as
    | { ensure?: (agent: unknown, signal?: AbortSignal) => Promise<string> }
    | undefined
  if (service !== undefined && typeof service.ensure === 'function' && exec.agent !== undefined) {
    try {
      const dir = await service.ensure(exec.agent, exec.signal)
      if (typeof dir === 'string' && dir !== '') return dir
    } catch {
      // fall through to process.cwd()
    }
  }
  return process.cwd()
}
