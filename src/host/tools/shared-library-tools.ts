/**
 * The shared-library tools (split out of `tools.ts`, #193): `inkflow_shared_list`,
 * `inkflow_shared_copy`, `inkflow_shared_update` (#40, ADR-0007). Three tools, one
 * direction: they read the plugin-level library (`dataDir/shared`) and copy OUT of it
 * into the current book. Nothing here writes the library — the manifest is derived and
 * there is no "push" direction (ADR-0007 C6).
 *
 * Why `list` does not require a book: the library belongs to no project, and a session
 * that is not inside a book must still be able to browse it. When the session IS inside
 * a usable book, the same answer also carries that book copies and which of them are
 * stale, so one call answers "what is there" and "what is behind".
 */

import type { ContentBlock, ToolDefinition } from '../context.js'
import { scanSharedLibrary } from '../hub-shared.js'
import { sharedRootOf } from '../settings.js'
import { buildSharedCopies, copySharedEntry, updateSharedEntry } from '../shared-copy.js'
import { gateFailure, resolveProject } from '../domains/tool-project.js'
import { rememberProject } from '../state.js'
import type { Json, ToolDeps } from './shared.js'
import { PROJECT_ROOT_PARAM, SUCCESS_SCHEMA, asRecord, commitLine, optionalString, text } from './shared.js'

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

export function sharedLibraryTools(deps: ToolDeps): ToolDefinition[] {
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
      const library = scanSharedLibrary(sharedRootOf(deps.dataDir).root)
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
        libraryPath: sharedRootOf(deps.dataDir).root,
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
  }

  return [sharedList, sharedCopy, sharedUpdate]
}

