/**
 * Project resolution + the four-state gate, shared by the built-in tools and by
 * domain-owned tools (roadmap §2.1 X-4/X-5).
 *
 * Why this is not inside `tools.ts`: a domain module publishes its own
 * `inkflow_*` tools through `characterDomain.tools()`, and those tools must judge
 * the project **exactly** the way the built-ins do — same trust anchor (the
 * session working directory), same refusals, same codes. Having the domain import
 * `tools.ts` would invert the dependency direction (`tools.ts` → `domains/`), so
 * the shared half lives here instead: both sides import it, neither imports the
 * other.
 *
 * `sessionCwd()` is **not** reimplemented here: it already has one home
 * (`src/host/session-cwd.ts`, extracted in #26) and a second copy would drift the
 * moment either side learns something new about the `workingDirectory` service.
 * It is re-exported so a caller that reaches for it through this module keeps
 * working.
 */

import { resolve as resolvePath } from 'node:path'

import { REQUIRED_DIRS, ROOT_META_FILE } from '../conventions.js'
import type { HostContext, ToolRunContext } from '../context.js'
import { checkProjectRootScope, findProjectRoot, inspectProject } from '../project.js'
import type { ProjectProbe, ProjectState, ScopeRejection } from '../project.js'
import { sessionCwd } from '../session-cwd.js'

export { sessionCwd } from '../session-cwd.js'

type Json = Record<string, unknown>

/** The only Host service this module needs (`workingDirectory` is optional). */
export interface ProjectResolverDeps {
  readonly ctx: HostContext
}

export interface Resolution {
  cwd: string
  root: string
  source: 'argument' | 'cwd' | 'none'
  probe?: ProjectProbe
  /** Set when an explicit path was refused before touching the disk. */
  rejection?: ScopeRejection
}

export async function resolveProject(
  deps: ProjectResolverDeps,
  argumentRoot: unknown,
  exec: ToolRunContext,
): Promise<Resolution> {
  // The session working directory is the only trust anchor: it is the directory
  // the user actually opened. Every other path must be proven to live inside it.
  const cwd = await sessionCwd(deps.ctx, exec)

  if (typeof argumentRoot === 'string' && argumentRoot.trim() !== '') {
    const root = resolvePath(argumentRoot.trim())
    const rejection = checkProjectRootScope(root, cwd)
    // Checked BEFORE inspectProject: that call recreates index/, so a bad path
    // would already have written to someone else's directory.
    if (rejection !== undefined) return { cwd, root, source: 'argument', rejection }
    return { cwd, root, source: 'argument', probe: inspectProject(root) }
  }

  const found = findProjectRoot(cwd)
  if (found !== undefined) return { cwd, root: found, source: 'cwd', probe: inspectProject(found) }

  // No fallback to state.lastProjectRoot (issue #7): that file records whichever
  // session ran last, so answering with it reports another book as this
  // session's project. A session outside a project must say exactly that.
  return { cwd, root: cwd, source: 'none', probe: inspectProject(cwd) }
}

/** True when a resolution must be answered with `gateFailure()` instead of running. */
export function isRefused(value: Resolution): boolean {
  return value.probe === undefined || value.probe.usable !== true
}

/**
 * A refusal carries the whole next step (ADR-0006 D2): `state`, the per-item
 * `checks`, the `missing` checklist and the `actions` the wizard would perform.
 *
 * `NOT_AN_INKFLOW_PROJECT` keeps its issue-#7 meaning ("nothing here yet"); the
 * two actionable states get their own codes so the model cannot answer
 * "run setup" when the book actually exists and only needs repair — or, worse,
 * when it was written by a newer plugin and must not be touched at all.
 */
export function gateFailure(value: Resolution): Json {
  if (value.rejection !== undefined) return { ok: false, error: { ...value.rejection } }
  const probe = value.probe
  const state: ProjectState = probe?.state ?? 'needs-setup'
  const code =
    state === 'needs-newer-plugin'
      ? 'PROJECT_NEEDS_NEWER_PLUGIN'
      : state === 'needs-repair'
        ? 'PROJECT_NEEDS_REPAIR'
        : 'NOT_AN_INKFLOW_PROJECT'
  const hint =
    state === 'needs-newer-plugin'
      ? 'this book was written by a newer dsh-inkflow; tell the user to upgrade the plugin. Do not repair, rewrite or re-index it from this version.'
      : state === 'needs-repair'
        ? 'the book exists but is incomplete or damaged; call inkflow_project_plan for the exact list, show it to the user, then call inkflow_project_init with confirm: true'
        : 'an InkFlow project is a git repository with nine content directories (each carrying .gitkeep) plus index/ and inkflow.json; call inkflow_project_plan to see exactly what would be created'
  return {
    ok: false,
    error: {
      code,
      state,
      message: `this directory is not a usable InkFlow project (state: ${state})`,
      needsSetup: state === 'needs-setup',
      needsRepair: state === 'needs-repair',
      readOnly: probe?.readOnly ?? false,
      cwd: value.cwd,
      searchedFrom: value.source,
      root: probe?.root ?? value.root,
      checks: probe?.checks ?? { git: false, dirs: {}, keeps: {}, meta: false },
      missing: probe?.missing ?? ['.git', ...REQUIRED_DIRS, ROOT_META_FILE],
      actions: probe?.actions ?? [],
      reasons: probe?.reasons ?? ['no InkFlow project found from the session working directory'],
      ...(probe?.metaError === undefined ? {} : { metaError: probe.metaError }),
      ...(probe?.metaRaw === undefined ? {} : { metaRaw: probe.metaRaw }),
      hint,
    },
  }
}
