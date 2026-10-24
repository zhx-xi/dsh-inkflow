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
import { AUDIT_LIST_LIMIT, auditProject, exportAuditReport } from './audit.js'
import { auditWire } from './audit-channel.js'
import { getLoadedBuild, summarizeBuild } from './build-info.js'
import { FILE_SCHEMA_VERSION, INDEX_SCHEMA_VERSION, REQUIRED_DIRS, ROOT_META_FILE } from './conventions.js'
import { buildIndex, describeIndexBuildFailure } from './index-build.js'
import { ensureIndex } from './index-freshness.js'
import type { EnsureIndexResult } from './index-freshness.js'
import { listChapters, readIndexMeta } from './indexer.js'
import { createChapter, createVolume, deleteChapter, moveChapter, renameVolume, writeChapter } from './chapters.js'
import { applyImport, planImport } from './import-write.js'
import type { ImportError } from './import-write.js'
import { domainTools } from './domains/index.js'
import { sessionCwd } from './session-cwd.js'
import { repairTools } from './repair-tools.js'
import { settingsTools } from './settings-tools.js'
import { semanticTools } from './ovk-tools.js'
import { searchWithSemantic } from './ovk-search.js'
import { DOMAIN_MODULES } from './domains/index.js'
import type { DomainModule } from './domains/types.js'
import type { FileExpectation } from './file-cas.js'
import { applyWorkspace, planWorkspace } from './workspace.js'
import { checkProjectRootScope, findProjectRoot, inspectProject, projectLabel } from './project.js'
import { gateFailure, resolveProject } from './domains/tool-project.js'
import { rememberProject } from './state.js'
import { DEFAULT_SEARCH_LIMIT, MAX_QUERY_CHARS, MAX_SEARCH_LIMIT, SEARCH_KINDS, searchChapters, searchEntries } from './search.js'
import { replaceApply, replacePreview } from './replace.js'
import { sharedDir } from './config.js'
import { scanSharedLibrary } from './hub-shared.js'
import { buildSharedCopies, copySharedEntry, updateSharedEntry } from './shared-copy.js'

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
 * The project resolution and the four-state refusal are shared with the domain-owned
 * tools, so both live in `domains/tool-project.ts` (#25 review, D-4). The copy that used
 * to sit here had already drifted: the character tools answered a refusal without the
 * `build` summary this file attaches through `withBuild()` below, so the same broken
 * book read as two different situations depending on which tool asked.
 */

const OBJECT_SCHEMA: JsonSchemaNode = { type: 'object', additionalProperties: true }

/**
 * Put the loaded-build summary on a refusal (issue #88). "needs setup" is exactly
 * what a STALE generation reports for a book that is in fact usable, so the model
 * must be able to see that the running code is older than the disk instead of
 * confidently telling the user to re-initialise a healthy project.
 */
function withBuild(value: Json, version: string): Json {
  const error = asRecord(value['error'])
  if (Object.keys(error).length === 0) return value
  return { ...value, error: { ...error, build: summarizeBuild(getLoadedBuild({ version })) } }
}

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

/**
 * A caller-supplied write baseline (issue #5, `FILE_CHANGED`).
 *
 * Accepted as a plain object on `inkflow_chapter_write` / `_move` / `_delete`
 * and on `inkflow_project_init`; every field that is present must match, so
 * `{ sha256 }` alone is a full content check and `{ absent: true }` is "the file
 * must not exist yet".
 */
const EXPECTED_PARAM = {
  type: 'object',
  properties: {
    sha256: { type: 'string', description: 'Lowercase hex sha256 of the file bytes you last read.' },
    size: { type: 'integer', description: 'Byte length of the file you last read (0 or higher).' },
    mtimeMs: { type: 'number', description: 'Modification time in ms (only compared when sha256/size are absent).' },
    absent: { type: 'boolean', description: 'True when the file must not exist yet (project init).' },
  },
  additionalProperties: false,
  description:
    'Optional compare-and-swap baseline: the file fingerprint you last read. A mismatch is refused with FILE_CHANGED ' +
    'and nothing is written, so an editor save is never overwritten by a stale write.',
} as const

function expectedParam(value: unknown): FileExpectation | undefined {
  const raw = asRecord(value)
  if (Object.keys(raw).length === 0) return undefined
  const expected: FileExpectation = {}
  if (typeof raw['sha256'] === 'string' && raw['sha256'].trim() !== '') expected.sha256 = raw['sha256'].trim()
  if (typeof raw['size'] === 'number') expected.size = raw['size']
  if (typeof raw['mtimeMs'] === 'number') expected.mtimeMs = raw['mtimeMs']
  if (raw['absent'] === true) expected.absent = true
  return expected
}

/** Report a rebuild that `ensureIndex` refused, keeping the freshness verdict visible. */
function ensureFailure(ensured: EnsureIndexResult & { ok: false }, root: string): Json {
  const failure = indexBuildFailure(ensured.failure, root)
  const error = asRecord(failure['error'])
  return {
    ...failure,
    error: {
      ...error,
      indexState: ensured.state,
      indexReasons: ensured.freshness.reasons,
    },
  }
}

const PROJECT_ROOT_PARAM = {
  type: 'string',
  description:
    'Absolute path of the InkFlow project root. Omit to resolve from the session working directory (walks up to the nearest project). An explicit path must live inside the session working directory.',
} as const

/** A JSON argument that is not a string counts as "not given"; validation is the tool's job. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * The non-blocking findings an init result carries (issue #89), as records.
 *
 * Rendered rather than thrown away: a warning the model cannot see is the same
 * silence the issue is about, and the fix steps are the only actionable part.
 */
function warningsOf(value: Json): Json[] {
  const warnings = value['warnings']
  return Array.isArray(warnings) ? warnings.map((warning) => asRecord(warning)) : []
}

/**
 * Render a refused volume/chapter operation: the code, what it means, whether the
 * tree is whole, and the undo steps when there was a rollback. The rollback
 * report is the part the model must not swallow — "it failed" and "it failed and
 * your files are unchanged" are different instructions to give the user.
 */
/**
 * The audit tool's refusal, rendered: a gate refusal keeps its checklist, an export refusal
 * says what to pass instead. Never a bare code — the model has to be able to act.
 */
function renderAuditFailure(value: Json): ContentBlock[] {
  const error = asRecord(value['error'])
  const lines = [`Audit failed: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
  if (error['path'] !== undefined) lines.push(`path: ${String(error['path'])}`)
  if (Array.isArray(error['missing'])) {
    lines.push(`Missing: ${(error['missing'] as unknown[]).map(String).join(', ') || '—'}`)
  }
  if (error['hint'] !== undefined) lines.push(String(error['hint']))
  return text(lines)
}

/**
 * The import's refusal rendering: the code, the one-sentence cause, the place, and whether
 * the batch was undone. "rolled back" is spelled out because it is the fact the reader
 * needs before deciding what to do next — the same reason `renderChapterFailure` prints it.
 */
function renderImportFailure(value: Json): ContentBlock[] {
  const error = asRecord(value['error'])
  const lines = [`导入失败：${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
  if (error['path'] !== undefined) lines.push(`路径：${String(error['path'])}`)
  if (error['planChapter'] !== undefined) lines.push(`停在：${String(error['planChapter'])}`)
  if (error['rolledBack'] === true) lines.push('已回滚：本批写出的章与原件副本都撤回了，书里的文件与导入前一致。')
  if (error['rolledBack'] === false) {
    lines.push('回滚未完成：备份包还在，按提示手工恢复或重跑回滚。')
  }
  if (Array.isArray(error['allowedExtensions'])) {
    lines.push(`可导入的扩展名：${(error['allowedExtensions'] as unknown[]).map(String).join(' / ')}`)
  }
  if (Array.isArray(error['missing'])) {
    lines.push(`缺项：${(error['missing'] as unknown[]).map(String).join(', ') || '—'}`)
  }
  if (error['hint'] !== undefined) lines.push(String(error['hint']))
  return text(lines)
}

/** A refused import, in the shape every tool refusal uses (`{ok:false, root, error}`). */
function importFailure(root: string, error: ImportError): Json {
  // Spread rather than nest-as-is: `ImportError` is a closed interface, and the tool
  // envelope is a JSON object (`Json`), so the fields are copied into one.
  return { ok: false, root, error: { ...error } }
}

function renderChapterFailure(verb: string, value: Json): ContentBlock[] {  const error = asRecord(value['error'])
  const lines = [`${verb} failed: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
  if (error['path'] !== undefined) lines.push(`path: ${String(error['path'])}`)
  if (error['nothingWritten'] === true) {
    lines.push('Nothing was written: the file on disk is not the version you passed as `expected`.')
  }
  if (error['rolledBack'] === true) {
    lines.push('The change was rolled back: the project files are as they were before the call.')
  }
  if (error['rolledBack'] === false) {
    lines.push('WARNING: the rollback did not complete — inspect the steps below before writing again.')
  }
  const rollback = Array.isArray(error['rollback']) ? (error['rollback'] as Json[]) : []
  for (const step of rollback) {
    const outcome = step['ok'] === true ? 'ok' : 'FAILED'
    const detail = step['message'] === undefined ? '' : ` (${String(step['message'])})`
    lines.push(`- ${outcome}: ${String(step['action'])}${detail}`)
  }
  if (error['hint'] !== undefined) lines.push(String(error['hint']))
  return text(lines)
}

/**
 * A shared-library refusal, rendered once for the three tools.
 *
 * The codes carry the whole meaning (`SHARED_COPY_CONFLICT`, `REFERENCE_READONLY`,
 * `REFERENCE_NOT_ALLOWED`, `SHARED_SOURCE_MISSING`, …), so the line names the code,
 * the path and then the hint — which is the part the model has to act on.
 */
function renderSharedFailure(verb: string, value: Json): ContentBlock[] {
  const error = asRecord(value['error'])
  const lines = [`${verb} failed: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
  if (error['path'] !== undefined) lines.push(`path: ${String(error['path'])}`)
  if (error['hint'] !== undefined) lines.push(String(error['hint']))
  return text(lines)
}

const SUCCESS_SCHEMA: JsonSchemaNode = {
  type: 'object',  properties: { ok: { type: 'boolean' } },
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

/**
 * The model-facing tool table: built-ins first, then every registered domain's
 * tools (roadmap §2.1 X-5). `modules` is injectable so the contract test can prove
 * the aggregate is wired without mutating the production registry.
 */
export function buildTools(deps: ToolDeps, modules: readonly DomainModule[] = DOMAIN_MODULES): ToolDefinition[] {
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
        const lines = [
          `InkFlow project: ${String(v['label'])} (state: ${String(v['state'] ?? 'usable')})`,
          `root: ${String(v['root'])}`,
          `chapters ${String(counts['chapters'] ?? 0)} · characters ${String(counts['characters'] ?? 0)} · world ${String(counts['worldEntries'] ?? 0)} · outlines ${String(counts['outlineNodes'] ?? 0)}`,
          `index: ${asRecord(v['index'])['dbExists'] === true ? `built ${String(asRecord(v['index'])['builtAt'] ?? '?')}` : 'missing (run inkflow_index_rebuild)'}`,
        ]
        if (v['titleSuspicious'] === true) {
          lines.push(
            `Warning: the inkflow.json title looks like UTF-8 bytes read back as GBK ("${String(v['label'])}"). ` +
              'This is what a PowerShell 5 `Set-Content`/`echo` (default ANSI code page) or a GBK-default editor writes. ' +
              'The book is still usable; tell the user the title is garbled and offer to write it again as UTF-8 without BOM.',
          )
        }
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) {
        return withBuild(gateFailure(resolved), deps.version)
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
        // Issue #89: the title looks like a GBK round-trip accident (a file this
        // plugin did not write). Reported so the model can relay it; it changes
        // neither `state` nor what the tools below are allowed to do.
        ...(probe.titleSuspicious === true ? { titleSuspicious: true } : {}),
        indexSchemaVersion: INDEX_SCHEMA_VERSION,
        index: {
          dbFile: index.dbFile,
          dbExists: index.dbExists,
          schemaVersion: index.schemaVersion ?? null,
          schemaMatches: index.schemaMatches,
          builtAt: index.builtAt ?? null,
          counts: index.counts,
        },
        // Issue #88: informational only — it never moves the four-state verdict.
        build: summarizeBuild(getLoadedBuild({ version: deps.version })),
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
      'List chapters of the InkFlow project in reading order, read from the derived index. If the index is missing, ' +
      'built by another schema, or no longer matches the files (a chapter edited, added or deleted outside the ' +
      'plugin), it is rebuilt first (it is only a cache).',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        limit: { type: 'integer', description: 'Maximum chapters (1–500). Default 100.' },
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
      // Issue #5: the read path no longer decides anything itself. `ensureIndex`
      // is the single trigger, so this list and `inkflow_chapter_search` below
      // can never disagree about which build they are reading.
      const ensured = await ensureIndex(probe.root)
      if (!ensured.ok) return ensureFailure(ensured, probe.root)
      const chapters = listChapters(probe.root, limit) ?? []
      return {
        ok: true,
        root: probe.root,
        total: chapters.length,
        indexRebuilt: ensured.rebuilt,
        indexState: ensured.state,
        chapters,
      }
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
        metaFingerprint: planned.metaFingerprint,
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
        expected: EXPECTED_PARAM,
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
        for (const warning of warningsOf(v)) {
          lines.push(
            `Warning ${String(warning['code'])}: ${String(warning['message'])}`,
            `  fix: ${String(warning['hint'] ?? '')}`,
          )
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
        expected: expectedParam(a['expected']),
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
          // Issue #89: the read-back verdict on the meta this call wrote, plus
          // anything about it the user has to decide on. Neither is an error.
          ...(result.metaVerified === undefined ? {} : { metaVerified: result.metaVerified }),
          warnings: result.warnings,
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
          ...(result.error?.path === undefined ? {} : { path: result.error.path }),
          ...(result.error?.changed === undefined ? {} : { changed: result.error.changed }),
          hint:
            code === 'PROJECT_NEEDS_NEWER_PLUGIN'
              ? 'the book was written by a newer plugin: upgrade dsh-inkflow instead of repairing it here'
              : code === 'FILE_CHANGED'
                ? 'another session changed the plan between inkflow_project_plan and this call: re-plan, then apply again; nothing was written'
                : 'nothing outside the listed actions was touched',
        },
      }
    },
  }

  // -------------------------------------------------------------------------
  // Volume / chapter CRUD (issue #16). Every tool below resolves the same gate
  // first, calls the domain function in `chapters.ts`, and reports what the
  // write cascaded into (catalog + index). No schema above is touched.
  // -------------------------------------------------------------------------

  /** Gate → run → return. A non-usable project gets the structured checklist. */
  const runChapterTool = async (args: unknown, exec: ToolRunContext, run: (root: string, a: Json) => Promise<unknown>): Promise<unknown> => {
    const a = asRecord(args)
    const resolved = await resolveProject(deps, a['projectRoot'], exec)
    if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
    rememberProject(deps.dataDir, resolved.probe.root)
    return run(resolved.probe.root, a)
  }

  const commitLine = (value: Json): string => {
    const parts = ['catalog rebuilt']
    if (value['indexRebuilt'] === true) parts.push('index rebuilt')
    else if (value['indexError'] !== undefined) {
      parts.push(`index NOT rebuilt (${String(asRecord(value['indexError'])['code'] ?? 'unknown')}) — run inkflow_index_rebuild`)
    }
    return parts.join('; ')
  }

  const volumeCreate: ToolDefinition = {
    name: 'inkflow_volume_create',
    description:
      'Create a volume: allocates `vol-NN` when `volumeId` is omitted, creates `chapters/vol-NN-<slug>/` with a `.gitkeep`, ' +
      'and updates the volume/chapter catalog and the derived index. Call it when the user asks to add a volume.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        volumeId: {
          type: 'string',
          description: 'Stable volume id (`vol-NN`). Omit to allocate the next free number.',
        },
        title: { type: 'string', description: 'Volume title; the directory slug and the catalog title derive from it.' },
        slug: {
          type: 'string',
          description: 'Directory slug (`chapters/vol-NN-<slug>/`). Omit to derive it from the title.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return renderChapterFailure('Volume create', v)
        const volume = asRecord(v['volume'])
        return text([
          `Created volume ${String(volume['volumeId'])} "${String(volume['title'])}" at ${String(volume['dir'])}/.`,
          commitLine(v),
        ])
      },
    },
    execute: (args, exec) =>
      runChapterTool(args, exec, (root, a) =>
        createVolume(root, {
          volumeId: optionalString(a['volumeId']),
          title: optionalString(a['title']) ?? '',
          slug: optionalString(a['slug']),
        }),
      ),
  }

  const volumeRename: ToolDefinition = {
    name: 'inkflow_volume_rename',
    description:
      "Rename a volume's directory (the `vol-NN` prefix and therefore the volumeId stay) and update both catalogs. Chapters " +
      'move with the directory but their frontmatter is not rewritten, so every id and `volume` value still resolves. ' +
      'Rolls the rename back when the catalog cannot be written.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        volumeId: { type: 'string', description: 'Stable volume id (`vol-NN`) to rename.' },
        title: { type: 'string', description: 'New volume title; the directory slug derives from it unless `slug` is given.' },
        slug: { type: 'string', description: 'New directory slug (without the `vol-NN-` prefix).' },
      },
      required: ['volumeId'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return renderChapterFailure('Volume rename', v)
        const volume = asRecord(v['volume'])
        const previous = asRecord(v['previous'])
        if (v['changed'] === false) {
          return text([`Volume ${String(volume['volumeId'])} already lives at ${String(volume['dir'])}/; nothing to do.`])
        }
        return text([
          `Renamed volume ${String(volume['volumeId'])}: ${String(previous['dir'])}/ → ${String(volume['dir'])}/ ("${String(volume['title'])}").`,
          `${String(v['chaptersUnchanged'] ?? 0)} chapter file(s) moved with the directory; their frontmatter is untouched.`,
          commitLine(v),
        ])
      },
    },
    execute: (args, exec) =>
      runChapterTool(args, exec, (root, a) =>
        renameVolume(root, {
          volumeId: optionalString(a['volumeId']) ?? '',
          title: optionalString(a['title']),
          slug: optionalString(a['slug']),
        }),
      ),
  }

  const chapterCreate: ToolDefinition = {
    name: 'inkflow_chapter_create',
    description:
      'Create a chapter: mints the uuid `id` (the reference to use from now on), allocates `seq`, writes ' +
      '`chapters/<volume-dir>/NNNN-<slug>.md` with `id`/`title`/`volume`/`seq`/`status: draft` and an empty body, and ' +
      'updates both projections. Call it when the user asks to add a chapter.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        volumeId: {
          type: 'string',
          description: 'Volume to add the chapter to (`vol-NN`). Omit for a loose chapter directly under `chapters/`.',
        },
        title: { type: 'string', description: 'Chapter title, e.g. "第一章 入山".' },
        slug: { type: 'string', description: 'File slug; omit to derive it from the title.' },
        seq: {
          type: 'integer',
          description:
            'Chapter number (positive integer). Defaults to one more than the highest seq in that volume (or among loose chapters).',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return renderChapterFailure('Chapter create', v)
        const chapter = asRecord(v['chapter'])
        return text([
          `Created "${String(chapter['title'])}" as ${String(chapter['volumeId'] ?? 'loose')} #${String(chapter['seq'] ?? '?')} — ${String(chapter['file'])}`,
          `id: ${String(chapter['chapterId'])} (use this id from now on; the file name is only a location)`,
          commitLine(v),
        ])
      },
    },
    execute: (args, exec) =>
      runChapterTool(args, exec, (root, a) =>
        createChapter(root, {
          volumeId: optionalString(a['volumeId']),
          title: optionalString(a['title']) ?? '',
          slug: optionalString(a['slug']),
          seq: typeof a['seq'] === 'number' ? a['seq'] : undefined,
        }),
      ),
  }

  const chapterWrite: ToolDefinition = {
    name: 'inkflow_chapter_write',
    description:
      'Edit one chapter addressed by `chapterId` or `file`: only the fields you pass change and the rest of the frontmatter ' +
      'block is preserved byte for byte. A new `title` also renames the file; the id stays. This overwrites manuscript ' +
      'prose — call it only when the user asked for the edit.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        chapterId: { type: 'string', description: 'Stable chapter id (uuid). Mutually exclusive with `file`.' },
        file: {
          type: 'string',
          description: 'Project-relative chapter path (`chapters/vol-01/0001-x.md`). Mutually exclusive with `chapterId`.',
        },
        title: { type: 'string', description: 'New title; the file is renamed to match it.' },
        body: { type: 'string', description: 'New chapter body (everything after the frontmatter block).' },
        status: { type: 'string', enum: ['draft', 'revised', 'final'], description: 'New chapter status.' },
        expected: EXPECTED_PARAM,
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return renderChapterFailure('Chapter write', v)
        const chapter = asRecord(v['chapter'])
        const changed = Array.isArray(v['changed']) ? (v['changed'] as unknown[]).map(String) : []
        if (changed.length === 0) return text([`Nothing to change in ${String(chapter['file'])} (the values already match).`])
        const lines = [`Updated ${String(chapter['file'])}: ${changed.join(', ')}.`]
        if (v['renamedFrom'] !== undefined) lines.push(`Renamed from ${String(v['renamedFrom'])} (id ${String(chapter['chapterId'])} unchanged).`)
        lines.push(commitLine(v))
        return text(lines)
      },
    },
    execute: (args, exec) =>
      runChapterTool(args, exec, (root, a) =>
        writeChapter(root, {
          chapterId: optionalString(a['chapterId']),
          file: optionalString(a['file']),
          title: optionalString(a['title']),
          body: optionalString(a['body']),
          status: optionalString(a['status']),
          expected: expectedParam(a['expected']),
        }),
      ),
  }

  const chapterMove: ToolDefinition = {
    name: 'inkflow_chapter_move',
    description:
      'Move a chapter into another volume or out of every volume. The file name, the `id` and the `seq` stay; the `volume` ' +
      'field follows the new owner (and is removed for a loose chapter). A failure after the move is rolled back.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        chapterId: { type: 'string', description: 'Stable chapter id (uuid). Mutually exclusive with `file`.' },
        file: { type: 'string', description: 'Project-relative chapter path. Mutually exclusive with `chapterId`.' },
        volumeId: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
          description: 'Target volume (`vol-NN`), or null to make the chapter loose (directly under chapters/).',
        },
        expected: EXPECTED_PARAM,
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return renderChapterFailure('Chapter move', v)
        const chapter = asRecord(v['chapter'])
        if (v['moved'] === false) {
          return text([`${String(chapter['file'])} is already there; nothing to do.`])
        }
        return text([
          `Moved ${String(v['movedFrom'])} → ${String(chapter['file'])} (${String(chapter['volumeId'] ?? 'loose')}).`,
          `id: ${String(chapter['chapterId'])} (unchanged)`,
          commitLine(v),
        ])
      },
    },
    execute: (args, exec) =>
      runChapterTool(args, exec, (root, a) =>
        moveChapter(root, {
          chapterId: optionalString(a['chapterId']),
          file: optionalString(a['file']),
          volumeId: a['volumeId'] === null ? null : optionalString(a['volumeId']),
          expected: expectedParam(a['expected']),
        }),
      ),
  }

  const chapterDelete: ToolDefinition = {
    name: 'inkflow_chapter_delete',
    description:
      'Delete one chapter file addressed by `chapterId` or `file`. The file is first moved into the project recovery bin ' +
      '(`.inkflow/trash/<same relative path>`, manifest `.inkflow/trash/index.json`) and only then dropped from the tree, ' +
      'so the text stays restorable (panel tab 回收站, or the restore/purge routes) until that entry is purged. ' +
      'Confirm with the user before calling.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        chapterId: { type: 'string', description: 'Stable chapter id (uuid). Mutually exclusive with `file`.' },
        file: { type: 'string', description: 'Project-relative chapter path. Mutually exclusive with `chapterId`.' },
        expected: EXPECTED_PARAM,
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return renderChapterFailure('Chapter delete', v)
        const deleted = asRecord(v['deleted'])
        const trashed = asRecord(v['trashed'])
        return text([
          `Deleted "${String(deleted['title'])}" — ${String(deleted['file'])} (id ${String(deleted['chapterId'])}).`,
          trashed['trashPath'] === undefined
            ? 'The file is gone from the working tree; the text is recoverable from git only.'
            : `Moved into the recovery bin: ${String(trashed['trashPath'])} (entry ${String(trashed['id'])}) — restorable until purged.`,
          commitLine(v),
        ])
      },
    },
    execute: (args, exec) =>
      runChapterTool(args, exec, (root, a) =>
        deleteChapter(root, {
          chapterId: optionalString(a['chapterId']),
          file: optionalString(a['file']),
          expected: expectedParam(a['expected']),
        }),
      ),
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
          description: `Maximum hits to return (1–${MAX_SEARCH_LIMIT}). Default ${DEFAULT_SEARCH_LIMIT}.`,
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

      // Issue #5: same single trigger as `inkflow_chapter_list`. The query is
      // validated above, so a rejected query still writes nothing; after that
      // the index is made fresh once and both tools read the same build.
      const ensured = await ensureIndex(probe.root)
      if (!ensured.ok) return ensureFailure(ensured, probe.root)
      const result = searchChapters(probe.root, query, options)
      rememberProject(deps.dataDir, probe.root)
      if (!result.ok) {
        return {
          ok: false,
          root: probe.root,
          query,
          indexRebuilt: ensured.rebuilt,
          indexState: ensured.state,
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
        indexRebuilt: ensured.rebuilt,
        indexState: ensured.state,
        items: result.items,
      }
    },
  }

  /**
   * The single search entry (issue #39, roadmap X-16).
   *
   * One tool for every kind instead of one per kind: the model asks "where is this
   * name" and gets the setting entries and the chapter prose in one paged answer. The
   * envelope is fixed by X-16 (`{kind,id,path,title,snippet,offset?,score?}` per entry,
   * `{offset,limit,total}` paging, `searchBackend`), so #41 can put a semantic backend
   * behind it without changing this tool.
   */
  const searchAll: ToolDefinition = {
    name: 'inkflow_search',
    description:
      'Search the whole book through one entry: chapter prose plus every setting-library kind (characters, world, ' +
      'outlines, foreshadowing, timeline, relations, facts, library). Each hit is `{kind, id, path, title, snippet}` ' +
      'with `offset`/`score` where the backend provides them; the page is `{offset, limit, total}` and `truncated` ' +
      'says more matches exist (a `limit` above 100 is clamped, not refused). The setting library is listed before ' +
      'chapter prose, because an entity matches on its own title/aliases/keywords while the manuscript matches in ' +
      'every chapter that uses the word. Terms are matched literally (quotes, asterisks and OR are text), 1–2 ' +
      'character terms use a LIKE scan (trigram cannot match them), and multiple terms all have to appear. Snippets ' +
      'are prose or field values, never frontmatter. Read-only: if the index is missing or foreign it is rebuilt ' +
      'once and the query retried; a still-unusable index is INDEX_UNAVAILABLE, never a stack trace.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        query: { type: 'string', description: 'Words to look for. Matched literally; 1–2 character terms use a LIKE scan.' },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: [...SEARCH_KINDS] },
          description: `Kinds to include: ${SEARCH_KINDS.join(', ')}. Default: all of them.`,
        },
        offset: { type: 'integer', description: 'Hits to skip (0–5000, default 0).' },
        limit: {
          type: 'integer',
          description: `Hits per page (1–${MAX_SEARCH_LIMIT}, default ${DEFAULT_SEARCH_LIMIT}). A larger value is clamped and the reply reports truncated.`,
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
          return text([`Search failed: ${String(error['code'] ?? 'unknown')}${message}${hint}`])
        }
        const items = Array.isArray(v['items']) ? (v['items'] as Json[]) : []
        const total = typeof v['total'] === 'number' ? v['total'] : items.length
        const offset = typeof v['offset'] === 'number' ? v['offset'] : 0
        const query = String(v['query'])
        const backend = String(v['searchBackend'] ?? 'fts5')
        if (items.length === 0) {
          return text([`No match for "${query}" in ${total === 0 ? 'any kind' : 'this page'} (${backend}, ${String(v['mode'])}).`])
        }
        const last = offset + items.length
        const lines = [
          `${total} match(es) for "${query}" — showing ${offset + 1}–${last} (${backend}, ${String(v['mode'])}${v['indexRebuilt'] === true ? ', index rebuilt' : ''}):`,
        ]
        for (const item of items) {
          lines.push(`- [${String(item['kind'])}] ${String(item['title'])} — ${String(item['path'])} (id ${String(item['id'])})`)
          if (String(item['snippet'] ?? '') !== '') lines.push(`    ${String(item['snippet'])}`)
        }
        if (v['truncated'] === true) {
          lines.push(`…more matches exist; call again with offset ${String(last)} for the next page.`)
        }
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const queryRaw = a['query']
      if (typeof queryRaw !== 'string' || queryRaw.replace(/\s+/gu, '') === '') {
        return {
          ok: false,
          root: probe.root,
          error: {
            code: 'QUERY_INVALID',
            message: 'query must be a non-empty string',
            hint: `pass the words to look for (limit ${MAX_QUERY_CHARS} characters); 1–2 characters use a LIKE scan, 3+ use the trigram index`,
          },
        }
      }
      const query = queryRaw.trim()
      const kinds = Array.isArray(a['kinds']) ? (a['kinds'] as unknown[]).map(String) : undefined
      const offset = typeof a['offset'] === 'number' ? a['offset'] : 0
      const limit = typeof a['limit'] === 'number' ? a['limit'] : DEFAULT_SEARCH_LIMIT

      // Same single rebuild trigger as every other read tool (#5): the query is
      // validated above, so a refused query still writes nothing.
      const ensured = await ensureIndex(probe.root)
      if (!ensured.ok) return ensureFailure(ensured, probe.root)
      // The semantic backend sits BEHIND this same entry (X-16): when it is configured and
      // answering, its chapter hits lead the page; when it is not, the answer is the keyword
      // one with `degradedReason` (ADR-0009 P8). Nothing here can 500 — the composition
      // returns a structured result either way.
      const outcome = await searchWithSemantic(
        probe.root,
        query,
        { ...(kinds === undefined ? {} : { kinds }), offset, limit },
        { dataDir: deps.dataDir },
      )
      const result = outcome.result
      rememberProject(deps.dataDir, probe.root)
      if (!result.ok) {
        return {
          ok: false,
          root: probe.root,
          query,
          indexRebuilt: ensured.rebuilt,
          indexState: ensured.state,
          error: { code: result.code, message: result.message, hint: result.hint },
        }
      }
      return {
        ok: true,
        root: probe.root,
        query,
        searchBackend: result.searchBackend,
        mode: result.mode,
        offset: result.offset,
        limit: result.limit,
        total: result.total,
        truncated: result.truncated,
        ...(result.degradedReason === undefined ? {} : { degradedReason: result.degradedReason }),
        semantic: { backend: outcome.availability.backend, hits: outcome.semanticHits, staleIndex: outcome.staleHits },
        indexRebuilt: ensured.rebuilt,
        indexState: ensured.state,
        items: result.items,
      }
    },
  }

  /**
   * Search-and-replace over chapter prose (issue #39, roadmap X-17).
   *
   * Two actions in one tool because the contract is "preview = execution": the
   * preview's `items` ARE the `expected` set an apply must carry, and putting them in
   * one tool means a model cannot preview with one schema and apply with another.
   * `preview` writes nothing; `apply` needs `confirm: true` and a matching `expected`,
   * rewrites through the rollback package, and reports every refused file.
   */
  const searchReplace: ToolDefinition = {
    name: 'inkflow_search_replace',
    description:
      'Preview or apply a search-and-replace over chapter prose. `preview` (the default) lists every file the batch ' +
      'would change with the occurrence count and the text around the first hit, and writes nothing at all. `apply` ' +
      'rewrites those files: it requires `confirm: true` and the `expected` set from a preview ([{ chapterId, count }]) ' +
      '— a file whose count changed since the preview is skipped and reported as preview-stale instead of being ' +
      'rewritten silently. Every file keeps its own line endings and BOM. The batch opens a rollback package under ' +
      '.inkflow/backup/ before the first write, and rolls back through it if a write fails; the reply names that ' +
      'directory so the author can undo by hand. Matching is literal and case-insensitive, like search; the ' +
      'replacement is literal too (`$1` means nothing here). Chapter prose only.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        action: {
          type: 'string',
          enum: ['preview', 'apply'],
          description: '`preview` (default) writes nothing; `apply` rewrites the chapters and needs expected + confirm.',
        },
        query: { type: 'string', description: 'Literal text to look for (case-insensitive).' },
        replacement: { type: 'string', description: 'Literal replacement text; pass "" to delete the matches.' },
        expected: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              chapterId: { type: 'string' },
              count: { type: 'integer' },
            },
            required: ['chapterId', 'count'],
            additionalProperties: false,
          },
          description: 'The preview items as [{ chapterId, count }]. Required for apply.',
        },
        confirm: { type: 'boolean', description: 'Required for apply: it rewrites chapter files.' },
      },
      required: ['query', 'replacement'],
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
          const rolledBack = v['rolledBack'] === true ? '\nThe batch was rolled back from its backup package.' : ''
          return text([`Search-replace refused: ${String(error['code'] ?? 'unknown')}${message}${hint}${rolledBack}`])
        }
        const query = String(v['query'])
        const replacement = String(v['replacement'])
        const items = Array.isArray(v['items']) ? (v['items'] as Json[]) : []
        const written = Array.isArray(v['written']) ? (v['written'] as Json[]) : []
        const skipped = Array.isArray(v['skipped']) ? (v['skipped'] as Json[]) : []
        const lines: string[] = []
        if (v['applied'] === true) {
          const replaced = typeof v['replaced'] === 'number' ? v['replaced'] : 0
          lines.push(`Replaced "${query}" → "${replacement}": ${String(replaced)} occurrence(s) in ${String(written.length)} file(s).`)
          for (const item of written) {
            lines.push(`- ${String(item['title'])} — ${String(item['path'])} · ${String(item['count'])} 处`)
            lines.push(`    前：${String(item['before'])}`)
            lines.push(`    后：${String(item['after'])}`)
          }
          const backup = asRecord(v['backup'])
          if (backup['dir'] !== undefined) {
            lines.push(`Rollback package: ${String(backup['dir'])} (undo with inkflow_project_migrate action rollback, or delete the batch by hand).`)
          }
          if (v['indexRebuilt'] === true) lines.push('index rebuilt')
          else if (v['indexError'] !== undefined) {
            lines.push(`index NOT rebuilt (${String(asRecord(v['indexError'])['code'] ?? 'unknown')}) — run inkflow_index_rebuild`)
          }
        } else {
          const total = typeof v['total'] === 'number' ? v['total'] : items.length
          lines.push(`Preview: "${query}" → "${replacement}" would change ${String(total)} file(s). Nothing was written.`)
          for (const item of items) {
            lines.push(`- ${String(item['title'])} — ${String(item['path'])} · ${String(item['count'])} 处`)
            lines.push(`    前：${String(item['before'])}`)
            lines.push(`    后：${String(item['after'])}`)
          }
          if (items.length > 0) {
            lines.push('To apply, call again with action: apply, confirm: true and expected = these items as [{ chapterId, count }].')
          }
        }
        for (const item of skipped) {
          lines.push(
            `- skipped ${String(item['path'] === '' ? item['chapterId'] : item['path'])}: ${String(item['reason'])} ` +
              `(expected ${String(item['expected'])}, actual ${String(item['actual'])})${item['detail'] === undefined ? '' : ` — ${String(item['detail'])}`}`,
          )
        }
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const query = typeof a['query'] === 'string' ? a['query'] : ''
      const replacement = typeof a['replacement'] === 'string' ? a['replacement'] : ''
      const action = a['action'] === 'apply' ? 'apply' : 'preview'
      rememberProject(deps.dataDir, probe.root)
      if (action === 'preview') {
        const preview = replacePreview(probe.root, { query, replacement })
        if (!preview.ok) {
          return { ok: false, root: probe.root, error: { code: preview.code, message: preview.message, hint: preview.hint } }
        }
        return {
          ok: true,
          root: probe.root,
          applied: false,
          query: preview.query,
          replacement: preview.replacement,
          kinds: preview.kinds,
          items: preview.items,
          total: preview.total,
        }
      }

      const expected = Array.isArray(a['expected'])
        ? (a['expected'] as unknown[]).map((raw) => asRecord(raw)).map((item) => ({
            chapterId: String(item['chapterId'] ?? ''),
            count: typeof item['count'] === 'number' ? item['count'] : Number(item['count'] ?? 0),
          }))
        : undefined
      if (expected === undefined) {
        return {
          ok: false,
          root: probe.root,
          error: {
            code: 'EXPECTED_REQUIRED',
            message: 'apply needs the expected set from a preview',
            hint: 'call with action: preview first, then pass its items as expected: [{ chapterId, count }]',
          },
        }
      }
      const applied = replaceApply(probe.root, {
        query,
        replacement,
        expected,
        confirm: a['confirm'] === true,
      })
      if (!applied.ok) {
        return {
          ok: false,
          root: probe.root,
          ...(applied.backup === undefined ? {} : { backup: applied.backup }),
          ...(applied.written === undefined ? {} : { written: applied.written }),
          ...(applied.skipped === undefined ? {} : { skipped: applied.skipped }),
          ...(applied.rolledBack === undefined ? {} : { rolledBack: applied.rolledBack }),
          error: { code: applied.code, message: applied.message, hint: applied.hint },
        }
      }
      // The manuscript changed, so the derived cache is now stale: rebuild it here
      // (same single trigger as a chapter write) and report what happened.
      const ensured = await ensureIndex(probe.root)
      return {
        ok: true,
        root: probe.root,
        applied: true,
        query: applied.query,
        replacement: applied.replacement,
        ...(applied.backup === undefined ? {} : { backup: applied.backup }),
        written: applied.written,
        skipped: applied.skipped,
        replaced: applied.replaced,
        indexRebuilt: ensured.ok ? ensured.rebuilt : false,
        ...(ensured.ok ? {} : { indexError: { code: ensured.failure.code, message: ensured.failure.message } }),
      }
    },
  }

  /**
   * The consistency audit (#33, roadmap X-14). Read-only unless `export: true`, and the
   * export is the one action here that writes — under `.inkflow/audit/` (ADR-0012 #6).
   *
   * Why the reply carries only the first `limit` findings plus the counts: a 500-chapter
   * book can produce hundreds of findings, and a tool reply is context the model pays for.
   * The full list is the exported Markdown (and the panel), so `truncated` + `exportable`
   * tell the model what to do next instead of dumping everything.
   */
  const audit: ToolDefinition = {
    name: 'inkflow_project_audit',
    description:
      'Run the consistency audit over the whole book and return the findings grouped into five families: structure ' +
      '(tree/graph invariants and frontmatter), ledger (fact conflicts), foreshadow (late and due-now setups), ' +
      'timeline and catalog drift. Each finding carries a stable code, a severity, a locator (an entity `kind:id`, ' +
      'a chapter id, a `path#L<n>` line or a volume catalog), one sentence of what is wrong and one line of what to ' +
      'do about it. Read-only: it re-scans the files, never rebuilds the index and never writes. The reply holds the ' +
      'counts of every finding plus the first `limit` of them; pass `export: true` with `confirm: true` to also write ' +
      'the full Markdown report into `.inkflow/audit/`. Two runs on an unchanged book produce the same report, so the ' +
      'file is diffable. Use it after a bulk import or a big edit; for one specific problem prefer the domain tool ' +
      'that owns it (e.g. inkflow_foreshadow_list for a board, inkflow_fact_snapshot for a timeline-of-facts).',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        limit: {
          type: 'number',
          description: 'How many findings to return in the reply (1–500; default 100). The counts always cover all of them.',
        },
        export: {
          type: 'boolean',
          description: 'Also write the full Markdown report into `.inkflow/audit/audit-<timestamp>.md`. Needs `confirm: true`.',
        },
        confirm: {
          type: 'boolean',
          description: 'Required when `export` is true: the export writes a file. Without it nothing is written.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return renderAuditFailure(v)
        const counts = asRecord(v['counts'])
        const byGroup = asRecord(counts['byGroup'])
        const severity = asRecord(counts['severity'])
        const findings = Array.isArray(v['findings']) ? (v['findings'] as Json[]) : []
        const lines: string[] = []
        const exported = asRecord(v['exported'])
        lines.push(
          `审计完成：${String(counts['total'] ?? 0)} 项（warning ${String(severity['warning'] ?? 0)} · info ${String(severity['info'] ?? 0)}），` +
            `其中 ${String(counts['fixable'] ?? 0)} 项可自动修复。`,
        )
        lines.push(
          `分组：${['structure', 'ledger', 'foreshadow', 'timeline', 'catalog']
            .map((group) => `${group} ${String(byGroup[group] ?? 0)}`)
            .join(' · ')}`,
        )
        if (v['catalogStale'] === true) lines.push('注意：catalog 与正文不一致（catalog 偏差组的说明里有处理办法）。')
        if (exported['path'] === undefined) {
          lines.push(`indexState: ${String(v['indexState'] ?? '?')}（只影响缓存，不影响本次结果）`)
        } else {
          lines.push(`已导出：${String(exported['path'])}（${String(exported['bytes'] ?? 0)} 字节）`)
        }
        if (findings.length === 0) {
          lines.push('没有任何问题。')
          return text(lines)
        }
        lines.push('')
        for (const finding of findings) {
          lines.push(`- [${String(finding['group'])}/${String(finding['severity'])}] ${String(finding['code'])} · ${String(finding['address'])} · ${String(finding['detail'])}`)
        }
        if (v['truncated'] === true) {
          lines.push(
            `…还有 ${String(Number(counts['total'] ?? 0) - findings.length)} 项未列出；` +
              '需要全量报告就再调一次并带 export: true、confirm: true。',
          )
        }
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const rawLimit = a['limit']
      const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : AUDIT_LIST_LIMIT
      const wantsExport = a['export'] === true
      if (wantsExport && a['confirm'] !== true) {
        return {
          ok: false,
          root: probe.root,
          error: {
            code: 'CONFIRM_REQUIRED',
            message: 'exporting writes a Markdown file under .inkflow/audit/',
            hint: 'pass export: true together with confirm: true (the report is derived and can be deleted at any time)',
          },
        }
      }
      const report = auditProject(probe.root)
      rememberProject(deps.dataDir, probe.root)
      const value = auditWire(report, limit)
      if (!wantsExport) return { ok: true, root: probe.root, ...value }
      const exported = exportAuditReport(probe.root, report)
      if (!exported.ok) {
        return {
          ok: false,
          root: probe.root,
          error: { code: exported.error.code, message: exported.error.message, ...(exported.error.path === undefined ? {} : { path: exported.error.path }) },
          counts: value['counts'],
        }
      }
      return {
        ok: true,
        root: probe.root,
        ...value,
        exported: {
          path: exported.path,
          bytes: exported.bytes,
          created: exported.created,
          ignoreLineAdded: exported.ignoreLineAdded,
        },
      }
    },
  }
  /**
   * The shared library (#40, ADR-0007). Three tools, one direction: they read the
   * plugin-level library (`dataDir/shared`) and copy OUT of it into the current
   * book. Nothing here writes the library — the manifest is derived and there is no
   * "push" direction (ADR-0007 C6).
   *
   * Why `list` does not require a book: the library belongs to no project, and a
   * session that is not inside a book must still be able to browse it. When the
   * session IS inside a usable book, the same answer also carries that book's
   * copies and which of them are stale, so one call answers "what is there" and
   * "what is behind" without a second round trip.
   */
  const sharedList: ToolDefinition = {
    name: 'inkflow_shared_list',
    description:
      'List the plugin-level shared library (world / library / snippets / series under the plugin data directory) and, ' +
      'when the session is inside a usable book, what that book already holds from it: one row per copy with its ' +
      '`origin` and a `state` of `current`, `stale` (the shared entry changed since the copy) or `missing-source` (the ' +
      'entry was deleted; the copy is still a normal file). Read-only: nothing is written, and `shared/index.json` is ' +
      'never rewritten (it is a derived manifest). Use `entryId` from this answer with inkflow_shared_copy.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        kind: {
          type: 'string',
          enum: ['world', 'library', 'snippets', 'series'],
          description: 'Only this kind. Omit for all four.',
        },
        q: { type: 'string', description: 'Case-insensitive substring match over the entry path.' },
        staleOnly: {
          type: 'boolean',
          description: 'Only report copies whose contentHash no longer matches the shared entry.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return renderSharedFailure('Reading the shared library', v)
        const entries = Array.isArray(v['entries']) ? (v['entries'] as Json[]) : []
        const copies = Array.isArray(v['copies']) ? (v['copies'] as Json[]) : []
        const counts = asRecord(v['counts'])
        const lines = [`共享库：${String(v['total'] ?? entries.length)} 条（${String(v['libraryPath'] ?? '')}）`]
        for (const entry of entries) {
          const tags = Array.isArray(entry['tags']) && entry['tags'].length > 0 ? ` · ${(entry['tags'] as string[]).join('/')}` : ''
          lines.push(`- [${String(entry['kind'])}] ${String(entry['entryId'])} · ${String(entry['path'])}${tags}`)
        }
        if (v['truncated'] === true) lines.push('（未列全：已达扫描上限，用 kind 或 q 缩小范围）')
        if (v['copiesKnown'] !== true) {
          lines.push('本书副本：当前会话不在可用的书里，未检查。')
          return text(lines)
        }
        lines.push(
          `本书副本：${String(counts['total'] ?? 0)} 条 · 最新 ${String(counts['current'] ?? 0)} · 落后 ${String(counts['stale'] ?? 0)} · 来源已删 ${String(counts['missing'] ?? 0)}`,
        )
        for (const copy of copies) {
          lines.push(
            `- ${String(copy['state'])} · ${String(copy['file'])}${copy['entryId'] === null ? '' : ` ← ${String(copy['entryId'])}`}`,
          )
        }
        if (v['selfContained'] === false) lines.push('注意：本书含引用条目，不自包含（引用卡只读）。')
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const library = scanSharedLibrary(sharedDir(deps.dataDir))
      if (!library.ok) {
        return { ok: false, error: { code: library.error.code, message: library.error.message, hint: library.error.hint } }
      }
      const kind = optionalString(a['kind'])?.trim() ?? ''
      const q = optionalString(a['q'])?.trim().toLowerCase() ?? ''
      const matching = library.entries.filter((entry) => {
        if (kind !== '' && entry.kind !== kind) return false
        if (q !== '' && !entry.path.toLowerCase().includes(q)) return false
        return true
      })

      // A book is OPTIONAL here: the library is not part of any project, so a
      // session outside one still gets an answer instead of a gate refusal.
      let copies: Json[] = []
      let copiesKnown = false
      let selfContained = true
      let counts: Json = { total: 0, current: 0, stale: 0, missing: 0 }
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe !== undefined && resolved.probe.usable === true) {
        const status = buildSharedCopies({ dataDir: deps.dataDir, root: resolved.probe.root })
        if (status.ok) {
          copiesKnown = true
          selfContained = status.value.selfContained
          counts = { ...status.value.counts }
          copies = (a['staleOnly'] === true
            ? status.value.entries.filter((row) => row.state === 'stale')
            : status.value.entries) as unknown as Json[]
        }
      }
      return {
        ok: true,
        libraryPath: sharedDir(deps.dataDir),
        kind: kind === '' ? null : kind,
        q: q === '' ? null : q,
        total: matching.length,
        truncated: library.truncated,
        entries: matching.map((entry) => ({
          entryId: entry.entryId,
          kind: entry.kind,
          path: entry.path,
          sha256: entry.sha256 ?? null,
          tags: entry.tags ?? [],
          entryIdDerived: entry.entryIdDerived === true,
        })),
        copiesKnown,
        selfContained,
        counts,
        copies,
      }
    },
  }

  const sharedCopy: ToolDefinition = {
    name: 'inkflow_shared_copy',
    description:
      'Copy ONE entry from the plugin-level shared library into the current book (ADR-0007 C2). This is the default ' +
      'action and it is a SNAPSHOT: the file lands in the book with an `origin` block recording ' +
      '`{projectId, entryId, contentHash}` as of the copy, and later changes to the shared entry never touch it. ' +
      'Destinations: `world/…` keeps its sub-path, a `library/` card lands in `library/` (with its original), a ' +
      'snippet lands in `library/snippets/`, and a `series/*.json` writes `inkflow.json.seriesId` instead of a file. ' +
      '`mode: "reference"` exists for `library/` originals only: it writes a read-only card and makes the book ' +
      'NOT self-contained. An existing destination is refused (SHARED_COPY_CONFLICT) and nothing is written. ' +
      'Needs `confirm: true`.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        entryId: { type: 'string', description: 'Shared entry id (`sh-xxxxxxxx`) from inkflow_shared_list.' },
        mode: {
          type: 'string',
          enum: ['copy', 'reference'],
          description:
            'copy (default) writes the content into the book; reference writes a read-only library card and keeps the text in the shared library (library/ entries only).',
        },
        confirm: {
          type: 'boolean',
          description: 'Required: this writes files into the book. Show the user the entry and its destination first.',
        },
      },
      required: ['entryId'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return renderSharedFailure('Copying the shared entry', v)
        const files = Array.isArray(v['files']) ? (v['files'] as string[]) : []
        const origin = asRecord(v['origin'])
        const lines: string[] = []
        if (files.length === 0) {
          lines.push(`已把本书关联到系列 ${String(v['seriesId'] ?? '')}（不复制文件；系列分组留在共享库）。`)
        } else {
          lines.push(`已复制 ${String(v['entryId'])}（${String(v['kind'])}）→ ${files.join('、')}`)
          lines.push(
            `origin：projectId ${String(origin['projectId'] ?? 'null')} · entryId ${String(origin['entryId'])} · ` +
              `${origin['contentHash'] === undefined ? `sha256 ${String(origin['sha256'])}` : `contentHash ${String(origin['contentHash'])}`}`,
          )
        }
        if (v['mode'] === 'reference') lines.push('这是引用卡（只读）：正文留在共享库，本项目对该条不自包含。')
        if (v['projectIdCreated'] === true) lines.push('顺手为本书补上了 inkflow.json 的 projectId（uuid v4，不参与门禁）。')
        for (const warning of Array.isArray(v['warnings']) ? (v['warnings'] as string[]) : []) lines.push(`· ${warning}`)
        lines.push(commitLine(v))
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const mode = optionalString(a['mode'])?.trim()
      if (mode !== undefined && mode !== 'copy' && mode !== 'reference') {
        return {
          ok: false,
          root: probe.root,
          error: {
            code: 'MODE_INVALID',
            message: 'mode is `copy` or `reference`',
            hint: 'omit `mode` for a normal copy snapshot',
          },
        }
      }
      const result = copySharedEntry({
        dataDir: deps.dataDir,
        root: probe.root,
        entryId: optionalString(a['entryId']) ?? '',
        ...(mode === undefined ? {} : { mode }),
        confirm: a['confirm'] === true,
      })
      rememberProject(deps.dataDir, probe.root)
      if (!result.ok) return { ok: false, root: probe.root, error: result.error }
      return { ok: true, ...result.value }
    },
  }

  const sharedUpdate: ToolDefinition = {
    name: 'inkflow_shared_update',
    description:
      'Refresh ONE copy in this book from the shared library, after the user agreed (ADR-0007 C3). Stale copies are ' +
      'never updated automatically: this call replaces the copy with the shared entry as it is now, re-writes its ' +
      '`contentHash`, and FIRST puts the previous bytes into `.inkflow/backup/<stamp>/` so the refresh can be rolled ' +
      'back. A copy that is already current is a no-op (reported in `unchanged`). A reference card is refused with ' +
      'REFERENCE_READONLY (it holds no snapshot), and a copy whose shared entry was deleted is refused with ' +
      'SHARED_SOURCE_MISSING. Address it by `entryId` or by `file`. Needs `confirm: true`.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        entryId: { type: 'string', description: 'Shared entry id of the copy to refresh.' },
        file: {
          type: 'string',
          description: 'Project-relative path of the copy (`world/门派/白鹤门.md`); alternative to entryId.',
        },
        confirm: {
          type: 'boolean',
          description: 'Required: this overwrites a file in the book (a backup package is taken first).',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return renderSharedFailure('Updating the copy', v)
        const updated = Array.isArray(v['updated']) ? (v['updated'] as string[]) : []
        const unchanged = Array.isArray(v['unchanged']) ? (v['unchanged'] as string[]) : []
        if (updated.length === 0) return text([`无需更新：${unchanged.join('、')} 已经是最新的（未写盘、未建备份包）。`])
        const origin = asRecord(v['origin'])
        return text([
          `已更新 ${updated.join('、')} → contentHash ${String(origin['contentHash'] ?? '')}`,
          v['backupDir'] === undefined ? '（未建备份包）' : `备份包：${String(v['backupDir'])}（rollback 可复原）`,
          commitLine(v),
        ])
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const entryId = optionalString(a['entryId'])?.trim() ?? ''
      const file = optionalString(a['file'])?.trim() ?? ''
      const result = updateSharedEntry({
        dataDir: deps.dataDir,
        root: probe.root,
        ...(entryId === '' ? {} : { entryId }),
        ...(file === '' ? {} : { file }),
        confirm: a['confirm'] === true,
      })
      rememberProject(deps.dataDir, probe.root)
      if (!result.ok) return { ok: false, root: probe.root, error: result.error }
      return { ok: true, ...result.value }
    },
  }  /**
   * Importing an old manuscript (#37, roadmap X-17): `action: 'plan'` reads the source and
   * says what would happen, `action: 'apply'` writes it with `confirm: true`.
   *
   * Why one tool rather than two: the preview and the write must describe the same set of
   * chapters, and the `planToken` in this reply is how the second call proves it is acting
   * on the plan the first one showed. Two tools would let a model call the write one with
   * whatever it remembered.
   *
   * Why `sourcePath` is a plain path and not a project-relative one: an old manuscript
   * lives wherever the author keeps it — usually outside the book. The Host reads it; the
   * nine content directories are still the only place this tool *writes*.
   */
  const libraryImport: ToolDefinition = {
    name: 'inkflow_library_import',
    description:
      'Import an old manuscript (.txt or .md) as chapters, and register the original under library/. Two actions: ' +
      '"plan" (default) decodes the file, sniffs its encoding (UTF-8 → UTF-16 BOM → GBK), remembers the source line ' +
      'endings, splits it into chapters by title shape (「第N章」/「Chapter N」/「一、」/a short standalone line), and ' +
      'reports the chapters it would create with their seq, paragraph and character counts — writing NOTHING; ' +
      '"apply" performs exactly that plan and needs confirm: true (plus the planToken the preview returned). Every ' +
      'import is one backup package under .inkflow/backup/, and a failure mid-batch rolls the whole batch back. ' +
      'Chapter files land as UTF-8/LF; the original is kept under library/ as its decoded text (a GBK file cannot be ' +
      'stored byte-identically through the text writer, and the report says so). Use it when the author says ' +
      '"import my old draft"; for a single chapter, inkflow_chapter_write is the tool.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        sourcePath: {
          type: 'string',
          description:
            'Absolute path of the .txt/.md file to import. It may live outside the book (the Host reads it); a ' +
            'relative path is resolved against the session working directory.',
        },
        action: {
          type: 'string',
          enum: ['plan', 'apply'],
          description: 'plan = preview only (the default); apply = write it. Anything else is refused.',
        },
        volumeId: {
          type: 'string',
          description: 'Import into this volume (`vol-NN`); omit to create loose chapters under chapters/.',
        },
        keepOriginal: {
          type: 'boolean',
          description: 'Register the original under library/ (default true). false imports only the chapters.',
        },
        confirm: {
          type: 'boolean',
          description: 'Required for action "apply": every write in this plugin needs an explicit confirmation.',
        },
        planToken: {
          type: 'string',
          description:
            'The `planToken` from the preview. Sending it makes apply refuse (IMPORT_PLAN_STALE) if the source or ' +
            'the book changed in between; omitting it applies to whatever the file says now.',
        },
      },
      required: ['sourcePath'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return renderImportFailure(v)
        const plan = asRecord(v['plan'])
        const source = asRecord(plan['source'])
        const totals = asRecord(plan['totals'])
        const target = asRecord(plan['target'])
        const chapters = Array.isArray(plan['chapters']) ? (plan['chapters'] as Json[]) : []
        const lines: string[] = []
        const applied = v['action'] === 'apply'
        lines.push(
          `${applied ? '已导入' : '导入预览（未写盘）'}：${String(source['name'] ?? '?')} · ` +
            `${String(source['encoding'] ?? '?')} · 行尾 ${String(source['eol'] ?? '?').toUpperCase()}`,
        )
        lines.push(`编码判定：${String(source['sniff'] ?? '?')}`)
        if (plan['chaptering'] !== true) lines.push('未识别到分章：整篇作为一个章节，正文未切分。')
        lines.push(
          `目标：${target['volumeId'] === null || target['volumeId'] === undefined ? '书根（散章）' : `${String(target['volumeId'])} ${String(target['volumeTitle'] ?? '')}`}` +
            ` · ${String(totals['chapters'] ?? chapters.length)} 章 / ${String(totals['paragraphs'] ?? 0)} 段 / ${String(totals['chars'] ?? 0)} 字`,
        )
        for (const chapter of chapters.slice(0, 30)) {
          const record = asRecord(chapter)
          const seq = String(record['seq'] ?? '?')
          lines.push(
            `- ${seq.padStart(4, '0')} ${String(record['title'] ?? '')}（${String(record['paragraphs'] ?? 0)} 段 / ${String(record['chars'] ?? 0)} 字）`,
          )
        }
        if (chapters.length > 30) lines.push(`…还有 ${String(chapters.length - 30)} 章未列出`)
        const library = asRecord(plan['library'])
        if (library['path'] !== null && library['path'] !== undefined) {
          lines.push(`原件：${String(library['path'])}${library['identical'] === true ? '（已存在且内容相同，不会重写）' : ''}`)
        }
        const warnings = Array.isArray(plan['warnings']) ? (plan['warnings'] as unknown[]).map(String) : []
        for (const warning of warnings) lines.push(`注意：${warning}`)

        if (!applied) {
          lines.push('')
          lines.push(
            `确认后写入：inkflow_library_import action="apply" confirm=true planToken="${String(plan['planToken'] ?? '')}"`,
          )
          return text(lines)
        }
        const created = Array.isArray(v['created']) ? (v['created'] as Json[]) : []
        const backup = asRecord(v['backup'])
        const kept = asRecord(v['library'])
        lines.push(
          `已写出 ${String(created.length)} 章 · 备份包 ${String(backup['dir'] ?? '?')}（${String(backup['files'] ?? 0)} 个文件，` +
            `${backup['sealed'] === true ? '已封包' : '未封包'}）· 用时 ${Math.round(Number(v['ms'] ?? 0))} ms`,
        )
        if (kept['path'] !== undefined && kept['path'] !== null) {
          lines.push(
            `原件已登记：${String(kept['path'])}（${String(kept['storedBytes'] ?? 0)} 字节` +
              `${kept['byteIdentical'] === true ? '，与原件逐字节相同' : '，为解码后的 UTF-8 文本，非原件字节'}）`,
          )
        }
        if (v['indexRebuilt'] !== true) {
          lines.push(`索引未重建（${String(asRecord(v['indexError'])['code'] ?? '?')}）：文件已写出，下次读取会自动重建`)
        }
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const sourcePath = optionalString(a['sourcePath'])?.trim() ?? ''
      if (sourcePath === '') {
        return {
          ok: false,
          root: probe.root,
          error: {
            code: 'IMPORT_SOURCE_REQUIRED',
            message: 'pass the path of the .txt/.md file to import',
            hint: 'the path may point outside the book: the Host reads the file, only chapters/ and library/ are written',
          },
        }
      }
      const rawAction = optionalString(a['action'])?.trim() ?? 'plan'
      if (rawAction !== 'plan' && rawAction !== 'apply') {
        return {
          ok: false,
          root: probe.root,
          error: {
            code: 'ACTION_INVALID',
            message: `unknown action "${rawAction}"`,
            hint: 'pass action: "plan" to preview or action: "apply" with confirm: true to write',
          },
        }
      }
      const options = {
        sourcePath,
        ...(optionalString(a['volumeId']) === undefined ? {} : { volumeId: optionalString(a['volumeId']) ?? '' }),
        ...(typeof a['keepOriginal'] === 'boolean' ? { keepOriginal: a['keepOriginal'] } : {}),
      }
      rememberProject(deps.dataDir, probe.root)

      if (rawAction === 'plan') {
        const planned = planImport(probe.root, options)
        if (!planned.ok) return importFailure(probe.root, planned.error)
        return { ok: true, root: probe.root, action: 'plan', ...planned.value }
      }

      const applied = await applyImport(probe.root, {
        ...options,
        ...(typeof a['confirm'] === 'boolean' ? { confirm: a['confirm'] } : {}),
        ...(optionalString(a['planToken']) === undefined ? {} : { planToken: optionalString(a['planToken']) ?? '' }),
      })
      if (!applied.ok) return importFailure(probe.root, applied.error)
      return { ok: true, root: probe.root, action: 'apply', ...applied.value }
    },
  }
  return [
    status,
    rebuild,
    chapterList,
    chapterSearch,
    searchAll,
    searchReplace,
    audit,
    libraryImport,
    plan,
    init,
    volumeCreate,
    volumeRename,
    chapterCreate,
    chapterWrite,
    chapterMove,
    chapterDelete,
    // Maintenance (#36): repair and migration own their own gate allowance (a book
    // that is `needs-repair` must still be repairable) and their own module.
    ...repairTools(deps),
    // The shared library (#40): one read, two writes, all in one direction
    // (`shared-copy.ts`). Registered after the maintenance pair because they are
    // the most recent built-ins and the surface baseline lists them in this order.
    sharedList,
    sharedCopy,
    sharedUpdate,
    // The plugin's own state (#42): settings, the diagnostics package and the local
    // backups. They live outside any book, so they ship as one module with one gate
    // policy of their own. `toolSurface` is a provider because the diagnostics package
    // lists what this table registers, and building the table again at export time is
    // the only way to name the real surface without a module cycle.
    ...settingsTools({ ...deps, toolSurface: () => buildTools(deps, modules) }),
    // Semantic retrieval (#41): status / rebuild / purge. One module, because all three
    // read the same availability verdict and the same block ledger, and the purge is the
    // only path in this plugin allowed to call OVK's physical delete (ADR-0009 P6).
    ...semanticTools(deps),
    // Domain modules own their own `inkflow_*` tools (roadmap §2.1 X-5): a domain
    // branch adds one line to `DOMAIN_MODULES`, never to the literal above.
    ...domainTools(deps, modules),
  ]
}

/** Exported for tests: the schema every tool must satisfy. */
export const TOOL_OUTPUT_SCHEMA: JsonSchemaNode = OBJECT_SCHEMA
