/**
 * Which book a domain tool is talking about.
 *
 * The anchor is the **session** working directory, never `process.cwd()`.
 *
 * `DomainModule.tools(deps)` carries `deps.ctx`, so `sessionCwd()` is reachable from a
 * domain tool. This file used to live inside `outline-tools.ts` with a `process.cwd()`
 * fallback whose stated reason was "`DomainModule.tools()` receives no dependencies" —
 * true when the outline tools landed, false since the seam passed `deps` in. The cost of
 * the stale premise: inside the host process `process.cwd()` is the DSH install
 * directory, so `inkflow_outline_tree` answered "0 overall, 0 volume(s), 0 chapter
 * outline(s)" for a book the session had open, while every other tool in the same
 * session recognised it.
 *
 * Order of operations, and why:
 *   1. `projectRoot`, when given, is `resolvePath()`d and checked **against itself** —
 *      that still rejects a volume root, the home directory, a directory containing home
 *      and anything inside the install directories;
 *   2. otherwise the **session** directory is walked up to the nearest book;
 *   3. the forbidden-path list runs **before** `inspectProject()`, because that call
 *      recreates `index/` — judging scope afterwards would already have written into a
 *      directory the tool was about to refuse;
 *   4. the four-state gate last: an outline may only ever be read or written in a
 *      directory that is already a usable InkFlow book.
 *
 * A call with no `projectRoot` and no session directory is **refused**, not searched:
 * `sessionCwd()` degrades to `process.cwd()` when the optional `workingDirectory`
 * service answers nothing, and guessing that anchor is the defect this resolves. Both
 * anchor refusals carry `cwd` + `searchedFrom` (+ `cwdSource`) so the model — and the
 * person reading its answer — can see which directory was used and where it came from.
 */

import { resolve as resolvePath } from 'node:path'

import type { ToolRunContext } from '../context.js'
import { checkProjectRootScope, findProjectRoot, inspectProject } from '../project.js'
import type { ProjectProbe } from '../project.js'
import { sessionCwdWithSource } from '../session-cwd.js'
import { optionalString } from './tool-support.js'
import type { Json } from './tool-support.js'
import type { DomainToolDeps } from './types.js'

export type TargetResult = { ok: true; root: string } | { ok: false; value: Json }

/**
 * The gate every write already went through, in the same shape the outline tools answer
 * with: the state, what the wizard would fill in, and a hint that fits the state.
 */
function gateRefusal(probe: ProjectProbe): Json {
  const state = probe.state
  const code =
    state === 'needs-newer-plugin'
      ? 'PROJECT_NEEDS_NEWER_PLUGIN'
      : state === 'needs-repair'
        ? 'PROJECT_NEEDS_REPAIR'
        : 'NOT_AN_INKFLOW_PROJECT'
  return {
    ok: false,
    error: {
      code,
      state,
      message: `this directory is not a usable InkFlow project (state: ${state})`,
      root: probe.root,
      missing: probe.missing,
      reasons: probe.reasons,
      hint:
        state === 'needs-newer-plugin'
          ? 'the book was written by a newer dsh-inkflow; tell the user to upgrade instead of editing it here'
          : 'run inkflow_project_plan / inkflow_project_init on this root first, or pass the root of a usable book',
    },
  }
}

/**
 * The forbidden-path list, then the four-state gate: nothing is read or written before
 * both pass.
 *
 * `workspace` is what `checkProjectRootScope()` judges the candidate against — it wants
 * the candidate to live *inside* that anchor, which is the right rule for a path the
 * model typed. A book found by walking **up** from the session directory is an ancestor
 * of it by construction, so that one is its own anchor (exactly as `resolveProject()`
 * skips the scope check for its `source: 'cwd'` answer); the forbidden-directory rules
 * still apply to it.
 */
function gatedTarget(root: string, workspace: string): TargetResult {
  const rejection = checkProjectRootScope(root, workspace)
  if (rejection !== undefined) {
    return {
      ok: false,
      value: {
        ok: false,
        error: {
          code: rejection.code,
          message: rejection.message,
          root: rejection.root,
          workspace: rejection.workspace,
          hint: rejection.hint,
        },
      },
    }
  }
  const probe = inspectProject(root)
  if (probe.usable !== true) return { ok: false, value: gateRefusal(probe) }
  return { ok: true, root: probe.root }
}

/** A refusal that names the anchor it searched, so a wrong anchor is diagnosable. */
function anchorRefusal(code: string, message: string, details: Json): TargetResult {
  return { ok: false, value: { ok: false, error: { code, message, ...details } } }
}

/**
 * The book a call targets: `projectRoot` when given, else the nearest book above the
 * session working directory. See the file comment for the order and the two refusals.
 */
export async function resolveTarget(deps: DomainToolDeps, exec: ToolRunContext, argument: unknown): Promise<TargetResult> {
  const requested = optionalString(argument)
  if (requested !== undefined) {
    const explicit = resolvePath(requested)
    return gatedTarget(explicit, explicit)
  }
  const session = await sessionCwdWithSource(deps.ctx, exec)
  if (session.source === 'process') {
    return anchorRefusal(
      'PROJECT_ROOT_UNKNOWN',
      'no session working directory is available, so the book cannot be resolved without projectRoot',
      {
        cwd: session.dir,
        cwdSource: 'process',
        searchedFrom: 'none',
        hint: 'pass projectRoot: the absolute path of the book (inkflow_project_status reports the root)',
      },
    )
  }
  const found = findProjectRoot(session.dir)
  if (found === undefined) {
    return anchorRefusal(
      'NOT_AN_INKFLOW_PROJECT',
      `no InkFlow project was found from the session working directory ${session.dir}`,
      {
        state: 'needs-setup',
        cwd: session.dir,
        cwdSource: 'session',
        searchedFrom: 'cwd',
        hint: 'pass projectRoot, or open the book so the session working directory is inside it',
      },
    )
  }
  return gatedTarget(found, found)
}
