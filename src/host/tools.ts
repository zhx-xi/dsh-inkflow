/**
 * Model-facing tool surface (ADR-0005: files are the truth, the index is a cache).
 *
 * Design rules for this file:
 *   - Every business tool resolves the project from the *session working
 *     directory* (walking up), never from a plugin registry.
 *   - A missing gate condition returns a structured `NOT_AN_INKFLOW_PROJECT`
 *     value (not an exception): the model needs the checklist, not a stack.
 *   - The derived index is rebuilt on demand; nothing here migrates a database.
 */

import { resolve as resolvePath } from 'node:path'

import type { ContentBlock, HostContext, JsonSchemaNode, ToolDefinition, ToolRunContext } from './context.js'
import { FILE_SCHEMA_VERSION, INDEX_SCHEMA_VERSION, REQUIRED_DIRS } from './conventions.js'
import { buildIndex, listChapters, readIndexMeta } from './indexer.js'
import { findProjectRoot, initProject, inspectProject, projectLabel } from './project.js'
import type { ProjectProbe } from './project.js'
import { readState, rememberProject } from './state.js'

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
  source: 'argument' | 'cwd' | 'state' | 'none'
  probe?: ProjectProbe
}

async function resolveProject(
  deps: ToolDeps,
  argumentRoot: unknown,
  exec: ToolRunContext,
): Promise<Resolution> {
  if (typeof argumentRoot === 'string' && argumentRoot.trim() !== '') {
    const root = resolvePath(argumentRoot.trim())
    return { cwd: root, source: 'argument', probe: inspectProject(root) }
  }
  const cwd = await sessionCwd(deps.ctx, exec)
  const found = findProjectRoot(cwd)
  if (found !== undefined) return { cwd, source: 'cwd', probe: inspectProject(found) }

  const remembered = readState(deps.dataDir).lastProjectRoot
  if (typeof remembered === 'string' && remembered !== '') {
    const probe = inspectProject(remembered)
    if (probe.usable) return { cwd, source: 'state', probe }
  }
  return { cwd, source: 'none', probe: inspectProject(cwd) }
}

function gateFailure(value: { cwd: string; source: string; probe?: ProjectProbe }): Json {
  const probe = value.probe
  return {
    ok: false,
    error: {
      code: 'NOT_AN_INKFLOW_PROJECT',
      message: 'this directory is not an InkFlow project',
      cwd: value.cwd,
      searchedFrom: value.source,
      root: probe?.root ?? value.cwd,
      missing: probe?.missing ?? ['.git', ...REQUIRED_DIRS, 'inkflow.json'],
      reasons: probe?.reasons ?? ['no InkFlow project found from the session working directory'],
      hint:
        'an InkFlow project is a git repository containing chapters/, characters/, world/, outlines/, index/ and library/ plus inkflow.json; run inkflow_project_init to scaffold it',
    },
  }
}

const OBJECT_SCHEMA: JsonSchemaNode = { type: 'object', additionalProperties: true }

const PROJECT_ROOT_PARAM = {
  type: 'string',
  description:
    'Absolute path of the InkFlow project root. Omit to resolve from the session working directory (walks up to the nearest project).',
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
      'Inspect the InkFlow project around the current working directory: is it a git repo, which required ' +
      'directories exist, is inkflow.json valid, and what does the derived index contain. Call this first in ' +
      'any novel-writing session; if it reports NOT_AN_INKFLOW_PROJECT, relay the missing list to the user ' +
      'instead of creating files on your own.',
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
          const missing = Array.isArray(error['missing']) ? (error['missing'] as unknown[]).join(', ') : '?'
          return text([`Not an InkFlow project (${String(error['root'] ?? '?')}).`, `Missing: ${missing}`])
        }
        const counts = asRecord(asRecord(v['index'])['counts'])
        return text([
          `InkFlow project: ${String(v['label'])}`,
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
        checks: probe.checks,
        missing: probe.missing,
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
          return text([`Index rebuild failed: ${String(error['code'] ?? 'unknown')}`])
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
      const result = buildIndex(probe.root)
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
          return text([`Cannot list chapters: ${String(error['code'] ?? 'unknown')}`])
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
        buildIndex(probe.root)
        chapters = listChapters(probe.root, limit) ?? []
        indexRebuilt = true
      }
      return { ok: true, root: probe.root, total: chapters.length, indexRebuilt, chapters }
    },
  }

  const init: ToolDefinition = {
    name: 'inkflow_project_init',
    description:
      'Scaffold an InkFlow project at a directory: creates chapters/, characters/, world/, outlines/, index/, ' +
      'library/, the inkflow.json metadata file and the index .gitignore rules. It does NOT run git init — ' +
      'the repository identity and remote belong to the user. Never call this without the user asking to ' +
      'create a new novel project.',
    parameters: {
      type: 'object',
      properties: {
        root: {
          type: 'string',
          description:
            'Absolute path of the new project root. Omit to use the session working directory.',
        },
        title: { type: 'string', description: 'Novel title. Required when inkflow.json does not exist yet.' },
        author: { type: 'string', description: 'Optional author pen name.' },
        createRepository: {
          type: 'boolean',
          description:
            'Reserved for P1. Currently ignored: git init is the user\'s decision, not the plugin\'s.',
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
          return text([`Init failed: ${String(error['message'] ?? error['code'] ?? 'unknown')}`])
        }
        const lines = [
          `Scaffolded InkFlow project at ${String(v['root'])}.`,
          `${String((v['createdDirs'] as unknown[] | undefined)?.length ?? 0)} directories and ${String((v['createdFiles'] as unknown[] | undefined)?.length ?? 0)} files created.`,
        ]
        if (v['gitInitNeeded'] === true) lines.push('Next: run `git init` in that directory — the project becomes usable once it is a git repository.')
        else lines.push('Repository already initialised; the project is ready.')
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const rootRaw = a['root']
      const root =
        typeof rootRaw === 'string' && rootRaw.trim() !== ''
          ? resolvePath(rootRaw.trim())
          : await sessionCwd(deps.ctx, exec)
      const title = typeof a['title'] === 'string' ? a['title'] : ''
      try {
        const result = initProject(root, { title, author: typeof a['author'] === 'string' ? a['author'] : undefined })
        if (result.probe.usable) rememberProject(deps.dataDir, result.probe.root)
        return {
          ok: result.probe.usable,
          root: result.probe.root,
          createdDirs: result.createdDirs,
          createdFiles: result.createdFiles,
          gitignoreUpdated: result.gitignoreUpdated,
          gitInitNeeded: result.gitInitNeeded,
          missing: result.probe.missing,
          reasons: result.probe.reasons,
        }
      } catch (cause) {
        return {
          ok: false,
          error: {
            code: 'INIT_FAILED',
            message: cause instanceof Error ? cause.message : String(cause),
            root,
          },
        }
      }
    },
  }

  return [status, rebuild, chapterList, init]
}

/** Exported for tests: the schema every tool must satisfy. */
export const TOOL_OUTPUT_SCHEMA: JsonSchemaNode = OBJECT_SCHEMA
