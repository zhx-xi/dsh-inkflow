/**
 * The relation tools' own anchor: which book a call is about.
 *
 * WHY THIS IS A FILE AND NOT TWENTY LINES IN `relation-tools.ts`: that module is at the 600-line
 * ceiling (AGENTS.md §10.5), and "where is this book" is a rule in its own right — the same one
 * `tool-support.withProject()`, `tool-project.resolveProject()` and `outline-target.resolveTarget()`
 * answer. Keeping it here makes the four implementations comparable side by side instead of hiding
 * one of them among the write path's plumbing.
 *
 * The refusal fields are the point: `cwd` (which directory was looked at), `cwdSource` (did the
 * session name it, or is it the host process's own?), `searchedFrom` (`none` means nothing was
 * searched, so nothing was ruled out). A tool that answers "not an InkFlow project" without them
 * is describing an unrelated directory as if it were the author's.
 */

import { resolve as resolvePath } from 'node:path'

import type { ToolRunContext } from '../context.js'
import { findProjectRoot } from '../project.js'
import { sessionCwdWithSource } from '../session-cwd.js'
import type { DomainToolDeps } from './types.js'

export interface RootLookup {
  root?: string
  error?: {
    code: string
    message: string
    hint?: string
    /** The anchor this call looked at, and where that anchor came from (`withProject`'s set). */
    cwd?: string
    cwdSource?: 'session' | 'process'
    searchedFrom?: 'cwd' | 'none'
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Resolve the book without a Host context.
 *
 * An explicit `projectRoot` wins; otherwise the book is resolved from the **session's** working
 * directory and, when that directory cannot be named, the call is REFUSED with the anchor fields.
 * It used to search a `process.cwd()` fallback and answer `NOT_AN_INKFLOW_PROJECT`, so one session
 * got two stories: one tool said "there is no book here", another said "I do not know where to
 * look". Why refuse instead of searching elsewhere is argued in `withProject()`: inside the host
 * process `process.cwd()` is the DSH install directory, so a miss there is not evidence about the
 * author's book.
 */
export async function projectRootOf(value: unknown, deps: DomainToolDeps, exec: ToolRunContext): Promise<RootLookup> {
  const explicit = optionalString(value)
  if (explicit !== undefined && explicit.trim() !== '') return { root: resolvePath(explicit.trim()) }
  const session = await sessionCwdWithSource(deps.ctx, exec)
  if (session.source === 'process') {
    return {
      error: {
        code: 'PROJECT_ROOT_UNKNOWN',
        cwd: session.dir,
        cwdSource: 'process',
        searchedFrom: 'none',
        message: 'no session working directory is available, so the book cannot be resolved without projectRoot',
        hint: 'pass projectRoot: the absolute path of the book (inkflow_project_status reports the root)',
      },
    }
  }
  const found = findProjectRoot(session.dir)
  if (found === undefined) {
    return {
      error: {
        code: 'NOT_AN_INKFLOW_PROJECT',
        cwd: session.dir,
        cwdSource: 'session',
        searchedFrom: 'cwd',
        message: `no InkFlow project was found from the session working directory ${session.dir}`,
        hint: 'pass projectRoot, or open the book so the session working directory is inside it',
      },
    }
  }
  return { root: found }
}
