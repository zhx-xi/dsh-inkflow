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

/**
 * One answer, plus **which** directory it is.
 *
 * `source` exists because the degrade-to-process-cwd path is not interchangeable with a
 * real session directory: inside the host process `process.cwd()` is the DSH install
 * directory, so a tool that treats it as "where the user is" answers `NOT_AN_INKFLOW_PROJECT`
 * for a book the session has open (or, worse, silently resolves an unrelated one). A tool
 * that wants to refuse instead of guess can see the difference here; a tool that only needs
 * a directory keeps calling `sessionCwd()`.
 */
export interface SessionCwd {
  readonly dir: string
  readonly source: 'session' | 'process'
}

export async function sessionCwdWithSource(ctx: HostContext, exec: ToolRunContext): Promise<SessionCwd> {
  const service = ctx.get('workingDirectory') as
    | { ensure?: (agent: unknown, signal?: AbortSignal) => Promise<string> }
    | undefined
  if (service !== undefined && typeof service.ensure === 'function' && exec.agent !== undefined) {
    try {
      const dir = await service.ensure(exec.agent, exec.signal)
      if (typeof dir === 'string' && dir !== '') return { dir, source: 'session' }
    } catch {
      // fall through to process.cwd()
    }
  }
  return { dir: process.cwd(), source: 'process' }
}

export async function sessionCwd(ctx: HostContext, exec: ToolRunContext): Promise<string> {
  return (await sessionCwdWithSource(ctx, exec)).dir
}
