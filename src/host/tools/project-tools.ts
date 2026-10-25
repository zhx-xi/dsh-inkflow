/**
 * Project-scoped built-in tools (split out of `tools.ts`, #193): the four-state gate
 * verdict (`inkflow_project_status`), the derived-index rebuild (`inkflow_index_rebuild`)
 * and the two-phase setup wizard (`inkflow_project_plan` read-only, `inkflow_project_init`
 * with `confirm: true`).
 *
 * Why two exported aggregates rather than one: the registration order of the whole tool
 * table is part of the model-facing contract (`tests/domain-registry.test.js` pins the
 * exact key order `[ ...built-ins, ...domain tools ]`), and in that order the wizard pair
 * sits after the search/audit/gate/import group — the status and rebuild pair sits first.
 * One file, two aggregates, one place to read the project tools.
 */

import { resolve as resolvePath } from 'node:path'

import type { ToolDefinition } from '../context.js'
import { getLoadedBuild, summarizeBuild } from '../build-info.js'
import { FILE_SCHEMA_VERSION, INDEX_SCHEMA_VERSION } from '../conventions.js'
import { buildIndex } from '../index-build.js'
import { readIndexMeta } from '../indexer.js'
import { sessionCwd } from '../session-cwd.js'
import { applyWorkspace, planWorkspace } from '../workspace.js'
import { checkProjectRootScope, findProjectRoot, projectLabel } from '../project.js'
import { gateFailure, resolveProject } from '../domains/tool-project.js'
import { rememberProject } from '../state.js'
import type { Json, ToolDeps } from './shared.js'
import { EXPECTED_PARAM, PROJECT_ROOT_PARAM, SUCCESS_SCHEMA, asRecord, expectedParam, indexBuildFailure, text } from './shared.js'

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
 * The non-blocking findings an init result carries (issue #89), as records.
 *
 * Rendered rather than thrown away: a warning the model cannot see is the same
 * silence the issue is about, and the fix steps are the only actionable part.
 */
function warningsOf(value: Json): Json[] {
  const warnings = value['warnings']
  return Array.isArray(warnings) ? warnings.map((warning) => asRecord(warning)) : []
}

export function projectTools(deps: ToolDeps): ToolDefinition[] {
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

  return [status, rebuild]
}

export function projectWizardTools(deps: ToolDeps): ToolDefinition[] {
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

  return [plan, init]
}

