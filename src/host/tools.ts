/**
 * Model-facing tool surface (ADR-0005: files are the truth, the index is a cache).
 *
 * Design rules for this file:
 *   - Every business tool resolves the project from the *session working
 *     directory* (walking up), never from a plugin registry.
 *   - A gate refusal is a structured checklist, not an exception: the model
 *     needs `state` / `missing` / `actions`, not a stack (ADR-0006 D2).
 *   - The derived index is rebuilt on demand; nothing here migrates a database.
 *   - Nothing is written before `confirm: true`; the wizard's `plan` step is
 *     strictly read-only (ADR-0006 D3).
 */

import { resolve as resolvePath } from 'node:path'

import type { ContentBlock, HostContext, JsonSchemaNode, ToolDefinition, ToolRunContext } from './context.js'
import { FILE_SCHEMA_VERSION, INDEX_SCHEMA_VERSION, REQUIRED_DIRS, ROOT_META_FILE } from './conventions.js'
import { buildIndex, describeIndexBuildFailure } from './index-build.js'
import { listChapters, readIndexMeta } from './indexer.js'
import { DEFAULT_SEARCH_LIMIT, MAX_QUERY_CHARS, MAX_SEARCH_LIMIT, searchChapters } from './search.js'
import { applyWorkspace, planWorkspace } from './workspace.js'
import type { ProjectProbe, ProjectState, ScopeRejection } from './project.js'
import { checkProjectRootScope, findProjectRoot, inspectProject, projectLabel } from './project.js'
import { rememberProject } from './state.js'

export interface ToolDeps {
  ctx: HostContext
  dataDir: string
  version: string
}

type Json = Record<string, unknown>

function text(lines: string[]): ContentBlock[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {}
}

/**
 * The Session's effective working directory. Uses the public `workingDirectory`
 * service when the profile has it, and degrades to the process cwd otherwise
 * (a plugin must not throw just because an optional service is absent).
 */
async function sessionCwd(ctx: HostContext, exec: ToolRunContext): Promise<string> {
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

interface Resolution {
  cwd: string
  root: string
  source: 'argument' | 'cwd' | 'none'
  probe?: ProjectProbe
  /** Set when an explicit path was refused before touching the disk. */
  rejection?: ScopeRejection
}

async function resolveProject(
  deps: ToolDeps,
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

/**
 * A refusal carries the whole next step (ADR-0006 D2): `state`, the per-item
 * `checks`, the `missing` checklist and the `actions` the wizard would perform.
 *
 * `NOT_AN_INKFLOW_PROJECT` keeps its issue-#7 meaning ("nothing here yet"); the
 * two actionable states get their own codes so the model cannot answer
 * "run setup" when the book actually exists and only needs repair — or, worse,
 * when it was written by a newer plugin and must not be touched at all.
 */
function gateFailure(value: Resolution): Json {
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

const OBJECT_SCHEMA: JsonSchemaNode = { type: 'object', additionalProperties: true }

/**
 * The model-facing shape of a failed rebuild. The index is a cache, so a failed
 * rebuild is reported as data — never as a thrown stack trace (issue #4).
 */
function indexBuildFailure(cause: unknown, root: string): Json {
  const failure = describeIndexBuildFailure(cause)
  return {
    ok: false,
    root,
    error: {
      code: failure.code,
      errno: failure.errno,
      message: failure.message,
      hint:
        failure.code === 'INDEX_BUSY'
          ? 'another session or process is already rebuilding this index; retry in a moment'
          : 'the previous index (if any) is still readable; fix the cause and rebuild',
    },
  }
}

const PROJECT_ROOT_PARAM = {
  type: 'string',
  description:
    'Absolute path of the InkFlow project root. Omit to resolve from the session working directory (walks up to the nearest project). An explicit path must live inside the session working directory.',
} as const

const SUCCESS_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: true,
}

function countsSchema(): JsonSchemaNode {
  return {
    type: 'object',
    properties: {
      files: { type: 'integer' },
      chapters: { type: 'integer' },
      characters: { type: 'integer' },
      worldEntries: { type: 'integer' },
      outlineNodes: { type: 'integer' },
      libraryFiles: { type: 'integer' },
    },
    additionalProperties: true,
  }
}

export function buildTools(deps: ToolDeps): ToolDefinition[] {
  const status: ToolDefinition = {
    name: 'inkflow_project_status',
    description:
      'Inspect the InkFlow project around the current working directory: the four-state gate verdict (usable, ' +
      'needs-setup, needs-repair, needs-newer-plugin), which required directories and .gitkeep markers exist, whether ' +
      'inkflow.json is valid, and what the derived index contains. Call this first in any novel-writing session; if it ' +
      'is not usable, relay the state plus the missing list to the user instead of creating files on your own.',
    parameters: {
      type: 'object',
      properties: { projectRoot: PROJECT_ROOT_PARAM },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          const code = String(error['code'] ?? 'unknown')
          if (code === 'PATH_OUT_OF_SCOPE' || code === 'PATH_FORBIDDEN') {
            return text([`Project status unavailable: ${code} — ${String(error['message'] ?? '')}`])
          }
          const state = String(error['state'] ?? 'unknown')
          const missing = Array.isArray(error['missing']) ? (error['missing'] as unknown[]).map(String) : []
          const actions = Array.isArray(error['actions']) ? (error['actions'] as Json[]) : []
          const lines = [
            `Not a usable InkFlow project (state: ${state}).`,
            `root: ${String(error['root'] ?? '?')}`,
            `Missing: ${missing.length === 0 ? '—' : missing.join(', ')}`,
          ]
          for (const action of actions) {
            lines.push(`- ${String(action['type'])}: ${String(action['path'])} — ${String(action['reason'])}`)
          }
          if (error['metaRaw'] !== undefined) {
            const raw = asRecord(error['metaRaw'])
            lines.push(
              `inkflow.json${raw['truncated'] === true ? ' (truncated)' : ''}: ${String(raw['text'] === undefined ? '' : raw['text'])}`,
            )
          }
          lines.push(String(error['hint'] ?? ''))
          return text(lines)
        }
        const counts = asRecord(asRecord(v['index'])['counts'])
        return text([
          `InkFlow project: ${String(v['label'])} (state: ${String(v['state'] ?? 'usable')})`,
          `root: ${String(v['root'])}`,
          `chapters ${String(counts['chapters'] ?? 0)} · characters ${String(counts['characters'] ?? 0)} · world ${String(counts['worldEntries'] ?? 0)} · outlines ${String(counts['outlineNodes'] ?? 0)}`,
          `index: ${asRecord(v['index'])['dbExists'] === true ? `built ${String(asRecord(v['index'])['builtAt'] ?? '?')}` : 'missing (run inkflow_index_rebuild)'}`,
        ])
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) {
        return gateFailure(resolved)
      }
      const probe = resolved.probe
      rememberProject(deps.dataDir, probe.root)
      const index = readIndexMeta(probe.root, probe)
      return {
        ok: true,
        root: probe.root,
        label: projectLabel(probe),
        source: resolved.source,
        state: probe.state,
        readOnly: probe.readOnly,
        checks: probe.checks,
        missing: probe.missing,
        actions: probe.actions,
        indexDirRecreated: probe.indexDirRecreated,
        projectSchemaVersion: probe.meta?.schemaVersion ?? FILE_SCHEMA_VERSION,
        meta: probe.meta ?? {},
        indexSchemaVersion: INDEX_SCHEMA_VERSION,
        index: {
          dbFile: index.dbFile,
          dbExists: index.dbExists,
          schemaVersion: index.schemaVersion ?? null,
          schemaMatches: index.schemaMatches,
          builtAt: index.builtAt ?? null,
          counts: index.counts,
        },
      }
    },
  }

  const rebuild: ToolDefinition = {
    name: 'inkflow_index_rebuild',
    description:
      'Rebuild the derived SQLite index from the project files under index/. The index is a rebuildable cache: ' +
      'this always deletes and re-scans, so it is safe after bulk edits, imports, or an index schema upgrade. ' +
      'It also runs the invariant checks (single overall outline, no volume-in-volume, unique character names, ' +
      'no dangling parents) and returns the issues it found.',
    parameters: {
      type: 'object',
      properties: { projectRoot: PROJECT_ROOT_PARAM },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          const message = error['message'] === undefined ? '' : ` — ${String(error['message'])}`
          return text([`Index rebuild failed: ${String(error['code'] ?? 'unknown')}${message}`])
        }
        const counts = asRecord(v['counts'])
        const issues = Array.isArray(v['issues']) ? (v['issues'] as Json[]) : []
        const lines = [
          `Index rebuilt in ${String(v['ms'])} ms.`,
          `files ${String(counts['files'] ?? 0)} · chapters ${String(counts['chapters'] ?? 0)} · characters ${String(counts['characters'] ?? 0)} · world ${String(counts['worldEntries'] ?? 0)} · outlines ${String(counts['outlineNodes'] ?? 0)} · library ${String(counts['libraryFiles'] ?? 0)}`,
          `issues: ${issues.length}`,
        ]
        for (const issue of issues.slice(0, 12)) {
          lines.push(`- ${String(issue['code'])}${issue['path'] === undefined ? '' : ` (${String(issue['path'])})`}: ${String(issue['detail'])}`)
        }
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) {
        return gateFailure(resolved)
      }
      const probe = resolved.probe
      rememberProject(deps.dataDir, probe.root)
      try {
        const result = await buildIndex(probe.root)
        return {
          ok: true,
          root: result.root,
          dbFile: result.dbFile,
          schemaVersion: result.schemaVersion,
          mode: result.mode,
          counts: result.counts,
          issues: result.issues,
          ms: result.ms,
          builtAt: result.builtAt,
        }
      } catch (cause) {
        return indexBuildFailure(cause, probe.root)
      }
    },
  }

  const chapterList: ToolDefinition = {
    name: 'inkflow_chapter_list',
    description:
      'List chapters of the InkFlow project in reading order, read from the derived index. If the index is ' +
      'missing or was built by another schema, it is rebuilt automatically first (it is only a cache).',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum chapters. Default 100.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          const message = error['message'] === undefined ? '' : ` — ${String(error['message'])}`
          return text([`Cannot list chapters: ${String(error['code'] ?? 'unknown')}${message}`])
        }
        const chapters = Array.isArray(v['chapters']) ? (v['chapters'] as Json[]) : []
        if (chapters.length === 0) return text(['No chapters yet (chapters/ is empty).'])
        return text([
          `${chapters.length} chapter(s)${v['indexRebuilt'] === true ? ' (index was rebuilt)' : ''}:`,
          ...chapters.map(
            (c) =>
              `- ${c['seq'] === null ? '?' : String(c['seq'])}. ${String(c['title'])} [${String(c['status'])}] ${String(c['wordCount'])} 字 — ${String(c['path'])}`,
          ),
        ])
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) {
        return gateFailure(resolved)
      }
      const probe = resolved.probe
      rememberProject(deps.dataDir, probe.root)
      const limit = typeof a['limit'] === 'number' ? a['limit'] : 100
      let chapters = listChapters(probe.root, limit)
      let indexRebuilt = false
      if (chapters === undefined) {
        try {
          await buildIndex(probe.root)
        } catch (cause) {
          return indexBuildFailure(cause, probe.root)
        }
        chapters = listChapters(probe.root, limit) ?? []
        indexRebuilt = true
      }
      return { ok: true, root: probe.root, total: chapters.length, indexRebuilt, chapters }
    },
  }

  const plan: ToolDefinition = {
    name: 'inkflow_project_plan',
    description:
      'Read-only gate + wizard plan for the InkFlow project around the current working directory: reports the ' +
      'four-state verdict (usable / needs-setup / needs-repair / needs-newer-plugin) and the exact actions ' +
      'inkflow_project_init would perform (git init, nine content directories and index/ with .gitkeep, inkflow.json, ' +
      '.gitignore). Writes nothing and runs no git command. Always call this before scaffolding or repairing, show the ' +
      'actions to the user, then call inkflow_project_init with confirm: true. In needs-newer-plugin the book was ' +
      'written by a newer plugin and nothing may be written: tell the user to upgrade.',
    parameters: {
      type: 'object',
      properties: { projectRoot: PROJECT_ROOT_PARAM },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          return text([`Project plan unavailable: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`])
        }
        const actions = Array.isArray(v['actions']) ? (v['actions'] as Json[]) : []
        const lines = [
          `State: ${String(v['state'] ?? '?')}${v['readOnly'] === true ? ' (read-only)' : ''}`,
          `root: ${String(v['root'] ?? '?')}`,
        ]
        const missing = Array.isArray(v['missing']) ? (v['missing'] as unknown[]).map(String) : []
        lines.push(`Missing: ${missing.length === 0 ? '—' : missing.join(', ')}`)
        if (actions.length === 0) lines.push('Nothing to do.')
        for (const action of actions) {
          lines.push(`- ${String(action['type'])}: ${String(action['path'])} — ${String(action['reason'])}`)
        }
        for (const notice of (Array.isArray(v['notices']) ? v['notices'] : []).map(String)) lines.push(`Note: ${notice}`)
        if (v['metaRaw'] !== undefined) {
          const raw = asRecord(v['metaRaw'])
          lines.push(`inkflow.json${raw['truncated'] === true ? ' (truncated)' : ''}: ${String(raw['text'] ?? '')}`)
        }
        if (v['blockedReason'] !== undefined && String(v['blockedReason']) !== '') {
          lines.push(`Blocked: ${String(v['blockedReason'])}`)
        }
        if (actions.length > 0) lines.push('Nothing was written. Confirm with the user, then call inkflow_project_init with confirm: true.')
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const cwd = await sessionCwd(deps.ctx, exec)
      const rootRaw = a['projectRoot']
      const explicit = typeof rootRaw === 'string' && rootRaw.trim() !== ''
      const root = explicit ? resolvePath((rootRaw as string).trim()) : (findProjectRoot(cwd) ?? cwd)
      // Only an explicit path is user input that has to be proven in scope; a
      // walked-up root is derived from the session workspace itself.
      if (explicit) {
        const rejection = checkProjectRootScope(root, cwd)
        if (rejection !== undefined) return { ok: false, error: { ...rejection } }
      }
      const planned = planWorkspace(root)
      return {
        ok: true,
        root: planned.root,
        state: planned.state,
        usable: planned.state === 'usable',
        readOnly: planned.readOnly,
        targetKind: planned.targetKind,
        checks: planned.checks,
        missing: planned.missing,
        reasons: planned.reasons,
        actions: planned.actions,
        notices: planned.notices,
        blockedReason: planned.blockedReason,
        existing: planned.existingEntries,
        existingCount: planned.existingCount,
        ...(planned.metaRaw === undefined ? {} : { metaRaw: planned.metaRaw }),
        ...(planned.metaError === undefined ? {} : { metaError: planned.metaError }),
      }
    },
  }

  const init: ToolDefinition = {
    name: 'inkflow_project_init',
    description:
      'Set up or repair the InkFlow project at a directory by applying the plan from inkflow_project_plan: creates ' +
      'the nine content directories and index/ (each with a .gitkeep), inkflow.json and the derived-index .gitignore ' +
      'rules, and runs `git init` when the directory is not a repository yet (never add, commit, remote or identity ' +
      'config). It only fills gaps: existing directories and files are skipped, never overwritten — the single ' +
      'exception is an invalid inkflow.json, whose current text is returned first and replaced only after confirm. ' +
      'Requires confirm: true: call inkflow_project_plan, show the user the actions, then call again with confirm: ' +
      'true. Never call this without the user asking to create or repair a novel project.',
    parameters: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description:
            'Absolute path of the project root. Omit to use the session working directory. Must live inside the session working directory.',
        },
        title: {
          type: 'string',
          description: 'Novel title. Required whenever inkflow.json has to be written or rebuilt (it is never invented).',
        },
        author: { type: 'string', description: 'Optional author pen name, used when inkflow.json is written.' },
        confirm: {
          type: 'boolean',
          description: 'Set true only after the user has seen the plan (inkflow_project_plan) and agreed to it.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          const message = String(error['message'] ?? error['code'] ?? 'unknown')
          if (v['requiresConfirmation'] === true) {
            const willCreate = Array.isArray(v['willCreate']) ? (v['willCreate'] as unknown[]).map(String) : []
            const existing = Array.isArray(v['existing']) ? (v['existing'] as unknown[]).map(String) : []
            const count = typeof v['existingCount'] === 'number' ? v['existingCount'] : existing.length
            const shown = existing.slice(0, 10).join(', ')
            const more = count > Math.min(existing.length, 10) ? ', …' : ''
            const lines = [
              `Confirmation required for ${String(v['root'])}: ${message}.`,
              `State: ${String(v['state'] ?? '?')}`,
              `Would create (${willCreate.length}): ${willCreate.join(', ')}`,
              `Already there (${count}): ${shown === '' ? '—' : `${shown}${more}`}`,
            ]
            if (v['metaRaw'] !== undefined) {
              const raw = asRecord(v['metaRaw'])
              lines.push(
                `inkflow.json would be replaced${raw['truncated'] === true ? ' (current text truncated)' : ''}: ${String(raw['text'] ?? '')}`,
              )
            }
            for (const notice of (Array.isArray(v['notices']) ? v['notices'] : []).map(String)) lines.push(`Note: ${notice}`)
            lines.push('Nothing was written. Ask the user, then call again with confirm: true.')
            return text(lines)
          }
          return text([`Init failed: ${String(error['code'] ?? 'unknown')} — ${message}`])
        }
        const created = Array.isArray(v['created']) ? (v['created'] as unknown[]) : []
        const updated = Array.isArray(v['updated']) ? (v['updated'] as unknown[]) : []
        const skipped = Array.isArray(v['skipped']) ? (v['skipped'] as unknown[]) : []
        const lines = [
          `InkFlow project ready at ${String(v['root'])} (state: ${String(v['state'] ?? 'usable')}).`,
          `created ${created.length} · updated ${updated.length} · skipped ${skipped.length}`,
        ]
        if (v['gitInit'] === 'created') {
          lines.push('Ran `git init` (no commit, no remote, no identity config): the first commit is yours to make.')
        }
        for (const notice of (Array.isArray(v['notices']) ? v['notices'] : []).map(String)) lines.push(`Note: ${notice}`)
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const cwd = await sessionCwd(deps.ctx, exec)
      const rootRaw = a['root']
      const root = typeof rootRaw === 'string' && rootRaw.trim() !== '' ? resolvePath(rootRaw.trim()) : cwd

      // Refuse before creating anything: apply writes a whole directory tree and
      // runs git init, so an unchecked path is an arbitrary-directory-write
      // primitive (H7) and an arbitrary-repository-creation one.
      const rejection = checkProjectRootScope(root, cwd)
      if (rejection !== undefined) return { ok: false, error: { ...rejection } }

      const result = applyWorkspace(root, {
        confirm: a['confirm'] === true,
        title: typeof a['title'] === 'string' ? a['title'] : '',
        author: typeof a['author'] === 'string' ? a['author'] : undefined,
      })
      const base = {
        root: result.root,
        state: result.state,
        notices: result.notices,
        ...(result.plan.metaRaw === undefined ? {} : { metaRaw: result.plan.metaRaw }),
        ...(result.plan.metaError === undefined ? {} : { metaError: result.plan.metaError }),
      }

      if (result.ok) {
        if (result.probe.usable) rememberProject(deps.dataDir, result.root)
        return {
          ok: true,
          ...base,
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
          gitInit: result.gitInit,
          missing: result.probe.missing,
          reasons: result.probe.reasons,
        }
      }

      const code = result.error?.code ?? 'APPLY_FAILED'
      if (code === 'INIT_REQUIRES_CONFIRMATION') {
        return {
          ok: false,
          ...base,
          requiresConfirmation: true,
          existing: result.plan.existingEntries,
          existingCount: result.plan.existingCount,
          willCreate: result.plan.actions.map((action) => action.path),
          actions: result.plan.actions,
          error: {
            code,
            message: result.plan.targetKind === 'absent' ? 'the target directory does not exist yet' : 'nothing was written',
            hint: 'nothing was written. Show willCreate/actions to the user; if they agree, call again with confirm: true',
          },
        }
      }
      return {
        ok: false,
        ...base,
        error: {
          code,
          message: result.error?.message ?? 'the plan could not be applied',
          rolledBack: result.error?.rolledBack === true,
          hint:
            code === 'PROJECT_NEEDS_NEWER_PLUGIN'
              ? 'the book was written by a newer plugin: upgrade dsh-inkflow instead of repairing it here'
              : 'nothing outside the listed actions was touched',
        },
      }
    },
  }

  const chapterSearch: ToolDefinition = {
    name: 'inkflow_chapter_search',
    description:
      'Search chapter prose for a keyword and return the matching chapters with a snippet around the first hit. ' +
      'Queries of three or more characters use the FTS5 trigram index and are ranked; 1–2 character queries ' +
      '(which trigram cannot match at all) fall back to a LIKE scan ordered by chapter number. Terms are matched ' +
      'literally — quotes, asterisks, hyphens and OR are text, not operators — and multiple whitespace-separated ' +
      'terms all have to appear. Snippets are body prose only (never the frontmatter). If the index is missing or ' +
      'was built by another schema it is rebuilt once (it is only a cache) and the search is retried; an index ' +
      'that still cannot be used is reported as INDEX_UNAVAILABLE, never as a stack trace.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        query: {
          type: 'string',
          description: 'Words to look for in chapter bodies. Matched literally; 1–2 character queries use a LIKE scan.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
          description: `Maximum hits to return. Default ${DEFAULT_SEARCH_LIMIT}.`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          const message = error['message'] === undefined ? '' : ` — ${String(error['message'])}`
          const hint = error['hint'] === undefined ? '' : `\n${String(error['hint'])}`
          return text([`Cannot search chapters: ${String(error['code'] ?? 'unknown')}${message}${hint}`])
        }
        const items = Array.isArray(v['items']) ? (v['items'] as Json[]) : []
        const total = typeof v['total'] === 'number' ? v['total'] : items.length
        const query = String(v['query'])
        if (items.length === 0) return text([`No chapter matches "${query}" (${String(v['mode'])} search, total ${total}).`])
        const lines = [
          `${total} chapter(s) match "${query}" (${String(v['mode'])} search${v['indexRebuilt'] === true ? ', index rebuilt' : ''}):`,
        ]
        for (const item of items) {
          const seq = item['seq'] === undefined || item['seq'] === null ? '?' : String(item['seq'])
          lines.push(`- ${seq}. ${String(item['title'])} — ${String(item['file'])}`)
          if (String(item['snippet'] ?? '') !== '') lines.push(`    ${String(item['snippet'])}`)
        }
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) {
        return gateFailure(resolved)
      }
      const probe = resolved.probe
      const queryRaw = a['query']
      if (typeof queryRaw !== 'string' || queryRaw.replace(/\s+/gu, '') === '') {
        return {
          ok: false,
          root: probe.root,
          error: {
            code: 'QUERY_INVALID',
            message: 'query must be a non-empty string',
            hint: `pass the words to look for; 1–2 characters use a LIKE scan, 3+ use the trigram index (limit ${MAX_QUERY_CHARS} characters)`,
          },
        }
      }
      const query = queryRaw.trim()
      const limit = typeof a['limit'] === 'number' ? a['limit'] : DEFAULT_SEARCH_LIMIT
      const options = { limit }

      let result = searchChapters(probe.root, query, options)
      let indexRebuilt = false
      // Lazy rebuild (issue #4): the search function itself must stay read-only,
      // so the decision to write an index lives here, at the tool boundary.
      if (!result.ok && result.code === 'INDEX_UNAVAILABLE') {
        try {
          await buildIndex(probe.root)
        } catch (cause) {
          return indexBuildFailure(cause, probe.root)
        }
        indexRebuilt = true
        result = searchChapters(probe.root, query, options)
      }
      rememberProject(deps.dataDir, probe.root)
      if (!result.ok) {
        return {
          ok: false,
          root: probe.root,
          query,
          indexRebuilt,
          error: { code: result.code, message: result.message, hint: result.hint },
        }
      }
      return {
        ok: true,
        root: probe.root,
        query,
        mode: result.mode,
        total: result.total,
        limit,
        indexRebuilt,
        items: result.items,
      }
    },
  }

  return [status, rebuild, chapterList, plan, init, chapterSearch]
}

/** Exported for tests: the schema every tool must satisfy. */
export const TOOL_OUTPUT_SCHEMA: JsonSchemaNode = OBJECT_SCHEMA
