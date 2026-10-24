/**
 * The settings / diagnostics / backup tool surface (#42, ADR-0018).
 *
 * Five tools, and each one is shaped by where its data lives:
 *
 *   * `inkflow_settings_get` / `inkflow_settings_update` touch ONLY
 *     `dataDir/settings.json` (D1), so they take no `projectRoot` and never consult
 *     the gate — the settings must be readable and fixable precisely when a book is
 *     broken, and an unreadable settings file must not cost the user their tools (D2).
 *   * `inkflow_diagnostics_export` writes a package that LEAVES the machine (D5), so
 *     it needs `confirm: true`; its index section is optional and it runs on a book
 *     that fails the gate (a broken book is exactly when a package is worth sending).
 *   * `inkflow_backup_create` / `inkflow_backup_restore` do need a usable book, and a
 *     restore previews by default (`dryRun: true`) before anything is written (D6).
 *
 * Why the file surface lives here instead of `tools.ts`: that file is the built-in
 * chapter/volume/index surface and is already past the 600-line convention. These
 * five share one concern (the plugin's own state, not the book's), so `tools.ts`
 * gains one spread and this module owns the rest.
 */

import type { ContentBlock, HostContext, JsonSchemaNode, ToolDefinition, ToolRunContext } from './context.js'
import { gateFailure, resolveProject } from './domains/tool-project.js'
import {
  backupStampZip,
  bookSlugOf,
  collectBackupFiles,
  createBookBackup,
  listBookBackups,
  planRestore,
  restoreBookBackup,
} from './backup-zip.js'
import type { BackupPackage } from './backup-zip.js'
import { buildDiagnostics, exportDiagnostics, maskPath } from './diagnostics.js'
import type { ToolSurfaceSource } from './diagnostics.js'
import { SETTINGS_FIELDS, SETTINGS_LIMITS, readSettings, writeSettings } from './settings.js'
import type { InkflowSettings } from './settings.js'

type Json = Record<string, unknown>

export interface SettingsToolDeps {
  readonly ctx: HostContext
  readonly dataDir: string
  readonly version: string
  /**
   * The registered tool table, for the diagnostics package's surface list.
   *
   * A provider rather than an array: `buildTools()` builds this module's tools, so
   * passing the array in would be a cycle at module-initialisation time. The provider
   * is called only when a package is built, which is after registration.
   */
  readonly toolSurface?: () => readonly ToolSurfaceSource[]
}

function text(lines: string[]): ContentBlock[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {}
}

const SUCCESS_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: true,
}

const PROJECT_ROOT_PARAM = {
  type: 'string',
  description:
    'Absolute path of the InkFlow project root. Omit to resolve from the session working directory (walks up to the nearest project). An explicit path must live inside the session working directory.',
} as const

const CONFIRM_PARAM = {
  type: 'boolean',
  description:
    'Set true only after the user has seen what this call would do. Without it nothing is written and the reply describes the pending action.',
} as const

/** Masks a host path for a reply that may be pasted into an issue. */
function displayPath(path: string, deps: SettingsToolDeps): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? ''
  return maskPath(path, { home, dataDir: deps.dataDir })
}

/** The settings as a reply carries them: values plus where they came from. */
function settingsWire(deps: SettingsToolDeps): Json {
  const read = readSettings(deps.dataDir)
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? ''
  return {
    ok: true,
    settings: read.settings,
    source: read.source,
    warn: read.warn ?? null,
    fileSchemaVersion: read.fileSchemaVersion ?? null,
    fields: [...SETTINGS_FIELDS],
    limits: SETTINGS_LIMITS,
    dataDir: maskPath(deps.dataDir, { home, dataDir: deps.dataDir }),
  }
}

/** The patch a settings update would apply, from the tool's arguments. */
function settingsPatch(args: Json): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const field of SETTINGS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(args, field)) patch[field] = args[field]
  }
  return patch
}

function describeSettings(settings: InkflowSettings): string[] {
  return [
    `sharedRoot: ${settings.sharedRoot ?? '（未设置，用 dataDir/shared）'}`,
    `semanticSearch: ${String(settings.semanticSearch)}`,
    `autosaveIntervalMs: ${String(settings.autosaveIntervalMs)}`,
    `authorName: ${settings.authorName ?? '（未设置）'}`,
    `excludeDirs: ${settings.excludeDirs.length === 0 ? '（空）' : settings.excludeDirs.join(', ')}`,
    `backupKeep: ${String(settings.backupKeep)}`,
  ]
}

function backupLines(packages: readonly BackupPackage[], limit = 20): string[] {
  const lines: string[] = []
  for (const pack of packages.slice(0, limit)) {
    lines.push(`- ${pack.file} · ${String(pack.entries)} 个文件 · ${(pack.bytes / 1024).toFixed(1)} KB`)
  }
  if (packages.length > limit) lines.push(`… 还有 ${String(packages.length - limit)} 个`)
  return lines
}

export function settingsTools(deps: SettingsToolDeps): ToolDefinition[] {
  const get: ToolDefinition = {
    name: 'inkflow_settings_get',
    description:
      'Read the plugin-level settings (ADR-0018 D1/D2): sharedRoot, semanticSearch, autosaveIntervalMs, authorName, ' +
      'excludeDirs, backupKeep. They live in one file OUTSIDE every book ($DSH_HOME/inkflow/settings.json), never in the ' +
      'book\'s inkflow.json — a book is the author\'s git repository, and a machine-specific preference in it would be ' +
      'committed and shared. The reply always carries a complete settings object: a missing file, a missing field, an ' +
      'out-of-range number (clamped) or a wrong type (default) is not an error, and `warn` reports a broken file so you can ' +
      'tell the user. Read-only; no project is resolved, so this works on a broken book too.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        const settings = asRecord(v['settings'])
        const warn = v['warn'] === null || v['warn'] === undefined ? undefined : asRecord(v['warn'])
        const lines = [`设置（来源：${String(v['source'] ?? 'default')}，文件 ${String(v['dataDir'] ?? '')}/settings.json）`]
        lines.push(...describeSettings(settings as unknown as InkflowSettings))
        const limits = asRecord(v['limits'])
        const autosave = asRecord(limits['autosaveIntervalMs'])
        const keep = asRecord(limits['backupKeep'])
        lines.push(`范围：autosaveIntervalMs ${String(autosave['min'] ?? '')}–${String(autosave['max'] ?? '')} · backupKeep ${String(keep['min'] ?? '')}–${String(keep['max'] ?? '')}`)
        if (warn !== undefined) lines.push(`告警：${String(warn['code'] ?? '')} — ${String(warn['message'] ?? '')}`)
        return text(lines)
      },
    },
    execute: async () => settingsWire(deps),
  }

  const update: ToolDefinition = {
    name: 'inkflow_settings_update',
    description:
      'Merge fields into the plugin settings file ($DSH_HOME/inkflow/settings.json, schemaVersion 1) and write it ' +
      'atomically. Merge, not replace: a field you omit keeps its current value, `null` clears an optional one. Values are ' +
      'coerced exactly as they are read — out-of-range numbers are clamped (autosaveIntervalMs 500–600000, backupKeep ' +
      '1–50), a wrong type falls back to the default, excludeDirs entries are normalised to book-relative names. Only the ' +
      'whitelist is written; unknown keys are ignored. Nothing is written without confirm: true, and NO book file is ever ' +
      'touched. A settings file stamped with a newer schemaVersion is refused rather than downgraded, so a newer plugin\'s ' +
      'fields are not silently dropped.',
    parameters: {
      type: 'object',
      properties: {
        sharedRoot: {
          type: 'string',
          description: 'Shared library root (ADR-0007): absolute, or relative to the plugin data directory. Omit to keep, null to reset to dataDir/shared.',
        },
        semanticSearch: { type: 'boolean', description: 'Allow the semantic (OVK) retrieval backend when one is available; it never creates one.' },
        autosaveIntervalMs: { type: 'integer', description: 'Idle delay before the workbench autosaves, in ms (500–600000; default 1500). Out-of-range values are clamped.' },
        authorName: { type: 'string', description: 'Author name the new-book wizard offers. Omit to keep, null to clear.' },
        excludeDirs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Book-relative directories bulk operations skip (e.g. a scratch directory inside the repository). Replaces the whole list; [] clears it.',
        },
        backupKeep: { type: 'integer', description: 'How many local backup packages to keep per book (1–50; default 5). The oldest beyond this are deleted on the next backup.' },
        confirm: CONFIRM_PARAM,
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          const lines = [`设置未写入：${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
          const pending = Array.isArray(v['pending']) ? (v['pending'] as unknown[]).map(String) : []
          if (pending.length > 0) {
            lines.push(`待写入字段：${pending.join(', ')}`)
            lines.push('Nothing was written. Show this to the user, then call again with confirm: true.')
          }
          if (error['hint'] !== undefined) lines.push(String(error['hint']))
          return text(lines)
        }
        const settings = asRecord(v['settings']) as unknown as InkflowSettings
        const changed = Array.isArray(v['changed']) ? (v['changed'] as unknown[]).map(String) : []
        const lines = [changed.length === 0 ? '设置已保存（没有字段变化）。' : `设置已保存，改动字段：${changed.join(', ')}`]
        lines.push(...describeSettings(settings))
        const warn = v['warn'] === null || v['warn'] === undefined ? undefined : asRecord(v['warn'])
        if (warn !== undefined) lines.push(`告警：${String(warn['code'] ?? '')} — ${String(warn['message'] ?? '')}`)
        return text(lines)
      },
    },
    execute: async (args) => {
      const patch = settingsPatch(asRecord(args))
      if (Object.keys(patch).length === 0) {
        return {
          ok: false,
          error: {
            code: 'NOTHING_TO_UPDATE',
            message: 'no settings field was given',
            hint: `pass at least one of ${SETTINGS_FIELDS.join(', ')}`,
          },
        }
      }
      if (asRecord(args)['confirm'] !== true) {
        return {
          ok: false,
          pending: Object.keys(patch),
          error: {
            code: 'CONFIRM_REQUIRED',
            message: 'saving settings replaces the plugin settings file',
            hint: 'show the fields above to the user, then call again with confirm: true (no book file is touched)',
          },
        }
      }
      const written = writeSettings(deps.dataDir, patch)
      if (!written.ok) return { ok: false, error: written.error }
      return {
        ok: true,
        settings: written.value.settings,
        changed: written.value.changed,
        repaired: written.value.repaired,
        warn: written.value.warn ?? null,
        dataDir: displayPath(deps.dataDir, deps),
      }
    },
  }

  const diagnostics: ToolDefinition = {
    name: 'inkflow_diagnostics_export',
    description:
      'Write a support package to $DSH_HOME/inkflow/diagnostics/<stamp>.json (ADR-0018 D5) and report where it went. It ' +
      'is a WHITELIST, meant to be pasted into an issue: plugin version and build stamp, package engines, platform, Node and ' +
      'ICU, index metadata (user_version, file count, entity count, last rebuild, freshness), per-domain counts, the tool ' +
      'list with surface hashes, the settings with absolute paths masked to ~/…, and a note that host logs are not ' +
      'available to plugins. It NEVER contains chapter or setting text, .env, .credentials.yaml or OpenViking private peer ' +
      'files, and it never names an absolute path. Needs confirm: true because it writes a file; it does not need a usable ' +
      'book (a broken book is the usual reason to export one).',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        confirm: CONFIRM_PARAM,
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          const lines = [`诊断包未导出：${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
          const preview = asRecord(v['preview'])
          if (Object.keys(preview).length > 0) {
            lines.push(`将写入 ${String(preview['displayPath'] ?? '')}（${String(preview['bytes'] ?? 0)} 字节）`)
            lines.push('Nothing was written. Show this to the user, then call again with confirm: true.')
          }
          if (error['hint'] !== undefined) lines.push(String(error['hint']))
          return text(lines)
        }
        const lines = [`诊断包已导出：${String(v['displayPath'] ?? v['path'] ?? '')}（${String(v['bytes'] ?? 0)} 字节）`]
        const summary = Array.isArray(v['summary']) ? (v['summary'] as unknown[]).map(String) : []
        lines.push(...summary)
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      const bookRoot = resolved.rejection === undefined ? resolved.root : undefined
      const tools = deps.toolSurface === undefined ? undefined : deps.toolSurface()
      if (a['confirm'] !== true) {
        const preview = diagnosticsPreview(deps, bookRoot, tools)
        return {
          ok: false,
          preview,
          error: {
            code: 'CONFIRM_REQUIRED',
            message: 'exporting writes a diagnostics package file',
            hint: 'show the summary above to the user, then call again with confirm: true (the package can be deleted at any time)',
          },
        }
      }
      const exported = exportDiagnostics({
        dataDir: deps.dataDir,
        version: deps.version,
        ...(bookRoot === undefined ? {} : { bookRoot }),
        ...(tools === undefined ? {} : { tools }),
      })
      if (!exported.ok) return { ok: false, error: exported.error }
      return {
        ok: true,
        path: exported.value.path,
        displayPath: displayPath(exported.value.path, deps),
        bytes: exported.value.bytes,
        summary: exported.value.document.summary,
        format: exported.value.document.format,
      }
    },
  }

  const backup: ToolDefinition = {
    name: 'inkflow_backup_create',
    description:
      'Write one local backup package of the whole book to $DSH_HOME/inkflow/backups/<bookSlug>-<stamp>.zip (ADR-0018 ' +
      'D3/D4) and report its entry list. The package is a STANDARD, store-only ZIP: the nine content directories plus ' +
      'inkflow.json and .gitignore, without index/ (rebuildable), .git/ (git\'s own history) or .inkflow/ (the recovery bin ' +
      'and the in-book backup packages). It is a safety net, not version control — for history use git. Retention applies ' +
      'after writing: settings backupKeep packages are kept (default 5, 1–50) and the oldest are deleted, and the reply ' +
      'names what it pruned. Needs a usable book and confirm: true.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        keep: {
          type: 'integer',
          description: 'Retention for this run, overriding the settings value (1–50). Out-of-range values are clamped.',
        },
        includeTrash: {
          type: 'boolean',
          description: 'Also take <book>/.inkflow/trash/ with it. Off by default: a recovery bin inside a backup package is a net that nests.',
        },
        confirm: CONFIRM_PARAM,
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          const lines = [`备份未创建：${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
          const entries = Array.isArray(v['entries']) ? (v['entries'] as unknown[]).map(String) : []
          if (entries.length > 0) {
            lines.push(`将打包 ${String(entries.length)} 个文件（${String(v['bookSlug'] ?? '')}）`)
            lines.push('Nothing was written. Show this to the user, then call again with confirm: true.')
          }
          if (error['hint'] !== undefined) lines.push(String(error['hint']))
          return text(lines)
        }
        const entries = Array.isArray(v['entries']) ? (v['entries'] as unknown[]).map(String) : []
        const lines = [
          `备份已创建：${String(v['file'] ?? '')}（${String(v['files'] ?? 0)} 个文件，${((Number(v['bytes'] ?? 0) as number) / 1024).toFixed(1)} KB）`,
          `位置：${String(v['displayPath'] ?? '')}`,
        ]
        const pruned = Array.isArray(v['pruned']) ? (v['pruned'] as unknown[]).map(String) : []
        lines.push(pruned.length === 0 ? `保留 ${String(v['keep'] ?? '')} 份：没有需要删除的旧备份` : `按保留策略删除最旧：${pruned.join(', ')}`)
        if (entries.length <= 12) lines.push(...entries.map((entry) => `- ${entry}`))
        else lines.push(`- …（共 ${String(entries.length)} 条，见包内目录）`)
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const root = resolved.probe.root
      const settings = readSettings(deps.dataDir).settings
      const keepRaw = a['keep']
      const keep = typeof keepRaw === 'number' && Number.isFinite(keepRaw) ? keepRaw : settings.backupKeep
      const includeTrash = a['includeTrash'] === true
      // The entry list is computed even without `confirm`, so the pending reply says
      // exactly which files would be packaged instead of "a book" (D4 is a set, and the
      // user is entitled to see it before the file is written).
      const preview = backupPreviewEntries(root, { includeTrash, excludeDirs: settings.excludeDirs })
      if (a['confirm'] !== true) {
        return {
          ok: false,
          bookSlug: bookSlugOf(root),
          entries: preview,
          error: {
            code: 'CONFIRM_REQUIRED',
            message: `creating a backup writes a ZIP of ${String(preview.length)} file(s) into the plugin data directory`,
            hint: 'show the entry list above to the user, then call again with confirm: true',
          },
        }
      }
      const created = createBookBackup(root, deps.dataDir, {
        includeTrash,
        excludeDirs: settings.excludeDirs,
        keep,
      })
      if (!created.ok) return { ok: false, root, error: created.error }
      return {
        ok: true,
        root,
        file: created.value.file,
        path: created.value.path,
        displayPath: displayPath(created.value.path, deps),
        bookSlug: created.value.bookSlug,
        stamp: created.value.stamp,
        files: created.value.files,
        entries: created.value.entries,
        bytes: created.value.bytes,
        pruned: created.value.pruned,
        keep,
      }
    },
  }

  const restore: ToolDefinition = {
    name: 'inkflow_backup_restore',
    description:
      'Put a local backup package back into the book, per file, then rebuild the derived index (ADR-0018 D6). Without ' +
      '`file` the reply lists the packages this book has (nothing is read into the book). With `file`: `dryRun` defaults to ' +
      'true and only COMPARES — it returns a plan of create/overwrite/same per entry plus the book\'s files the package does ' +
      'not hold, and writes nothing. To execute, call again with dryRun: false and confirm: true, passing the plan\'s ' +
      'per-file digests as `expected` (a compact {path: sha256-or-null} object): any file whose bytes changed since the plan ' +
      'is reported as BACKUP_CONFLICT and is NOT overwritten, while the rest of the restore proceeds — a snapshot must ' +
      'never silently discard the author\'s newer text. Omit `expected` only when the user explicitly wants the snapshot to ' +
      'win everywhere. The reply reports what was restored, what was already identical and what was skipped.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        file: {
          type: 'string',
          description: 'Package file name as the list returned (`<bookSlug>-<stamp>.zip`). Omit to list what this book can restore.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Default true: compare and return the plan without writing. False (with confirm: true) performs the restore.',
        },
        expected: {
          type: 'object',
          additionalProperties: true,
          description:
            'The plan\'s per-file digests, as { "chapters/vol-01/0001-a.md": "<sha256>" | null }. A file whose current bytes no longer match is reported as a conflict and left alone. Null means "was absent".',
        },
        confirm: CONFIRM_PARAM,
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        const backups = Array.isArray(v['backups']) ? (v['backups'] as Json[]) : []
        if (v['needFile'] === true) {
          return text([
            `这本书有 ${String(backups.length)} 个备份包，选一个作为 file：`,
            ...backupLines(backups as unknown as BackupPackage[]),
          ])
        }
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          const lines = [`恢复未完成：${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
          const restored = Array.isArray(v['restored']) ? (v['restored'] as unknown[]).map(String) : []
          const conflicts = Array.isArray(v['conflicts']) ? (v['conflicts'] as Json[]) : []
          if (restored.length > 0) lines.push(`已恢复 ${String(restored.length)} 个文件：`)
          for (const path of restored.slice(0, 20)) lines.push(`- ${path}`)
          if (conflicts.length > 0) {
            lines.push(`冲突未覆盖 ${String(conflicts.length)} 个：`)
            for (const conflict of conflicts) lines.push(`- ${String(conflict['path'] ?? '')} — ${String(conflict['reason'] ?? '')}`)
            lines.push('解决冲突后可以再调一次；已恢复的文件不会再被改动。')
          }
          if (error['hint'] !== undefined) lines.push(String(error['hint']))
          return text(lines)
        }
        const plan = v['plan'] === undefined ? undefined : asRecord(v['plan'])
        const counts = plan === undefined ? asRecord({}) : asRecord(plan['counts'])
        if (plan !== undefined && v['dryRun'] === true) {
          const entries = Array.isArray(plan['entries']) ? (plan['entries'] as Json[]) : []
          const lines = [
            `预览（未写盘）：${String(v['file'] ?? '')}`,
            `create ${String(counts['create'] ?? 0)} · overwrite ${String(counts['overwrite'] ?? 0)} · same ${String(counts['same'] ?? 0)}`,
          ]
          for (const entry of entries.filter((candidate) => candidate['action'] !== 'same').slice(0, 20)) {
            lines.push(`- ${String(entry['action'])} ${String(entry['path'])}`)
          }
          const extra = Array.isArray(plan['extra']) ? (plan['extra'] as unknown[]).map(String) : []
          if (extra.length > 0) lines.push(`书里有 ${String(extra.length)} 个文件不在包内（恢复不会删除它们）`)
          lines.push('要执行就再调一次：dryRun: false、confirm: true，并把上面的 current 摘要作为 expected 传回。')
          return text(lines)
        }
        const restored = Array.isArray(v['restored']) ? (v['restored'] as unknown[]).map(String) : []
        const unchanged = Array.isArray(v['unchanged']) ? (v['unchanged'] as unknown[]).map(String) : []
        const index = asRecord(v['index'])
        const lines = [
          `恢复完成：写回 ${String(restored.length)} 个文件，${String(unchanged.length)} 个本来就一致`,
          `索引：${String(index['state'] ?? '')}${index['rebuilt'] === true ? '（已重建）' : '（未重建）'}${index['message'] === undefined ? '' : ` — ${String(index['message'])}`}`,
        ]
        const extra = Array.isArray(v['extra']) ? (v['extra'] as unknown[]).map(String) : []
        if (extra.length > 0) lines.push(`书里有 ${String(extra.length)} 个文件不在包内（恢复不会删除它们）`)
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const root = resolved.probe.root
      const slug = bookSlugOf(root)
      const file = typeof a['file'] === 'string' ? a['file'].trim() : ''
      if (file === '') {
        return { ok: true, root, needFile: true, backups: listBookBackups(deps.dataDir, slug) }
      }
      const dryRun = a['dryRun'] !== false
      if (dryRun) {
        const planned = planRestore(root, deps.dataDir, slug, file)
        if (!planned.ok) return { ok: false, root, error: planned.error }
        return { ok: true, root, dryRun: true, file, plan: planned.value }
      }
      if (a['confirm'] !== true) {
        const planned = planRestore(root, deps.dataDir, slug, file)
        const plan = planned.ok ? planned.value : undefined
        return {
          ok: false,
          root,
          file,
          dryRun: false,
          ...(plan === undefined ? {} : { plan }),
          error: {
            code: 'CONFIRM_REQUIRED',
            message: 'restoring writes the package\'s files back over the book',
            hint: `show the plan (${plan === undefined ? 'unreadable package' : `${String(plan.counts.overwrite)} overwrite · ${String(plan.counts.create)} create`}) to the user, then call again with confirm: true`,
          },
        }
      }
      const expectedRaw = a['expected']
      const expected = typeof expectedRaw === 'object' && expectedRaw !== null ? (expectedRaw as Record<string, string | null>) : undefined
      const restored = await restoreBookBackup(root, deps.dataDir, slug, file, expected === undefined ? {} : { expected })
      if (!restored.ok) {
        const error = restored.error
        return {
          ok: false,
          root,
          file,
          error,
          restored: error.restored ?? [],
          conflicts: error.conflicts ?? [],
        }
      }
      return {
        ok: true,
        root,
        file,
        dryRun: false,
        restored: restored.value.restored,
        unchanged: restored.value.unchanged,
        extra: restored.value.extra,
        index: restored.value.index,
      }
    },
  }

  return [get, update, diagnostics, backup, restore]
}

/**
 * The entry list a backup WOULD carry, computed without writing (and without the
 * side effects `createBookBackup` has: the file and retention).
 *
 * It goes through the same `collectBackupFiles` the writer uses, so the set the user
 * approves is the set that lands in the package (D4 is one set, not two).
 */
function backupPreviewEntries(
  root: string,
  options: { includeTrash: boolean; excludeDirs: readonly string[] },
): string[] {
  return collectBackupFiles(root, options)
}

/** The diagnostics document a confirm-less call previews: built, never written. */
function diagnosticsPreview(
  deps: SettingsToolDeps,
  bookRoot: string | undefined,
  tools: readonly ToolSurfaceSource[] | undefined,
): { displayPath: string; bytes: number; summary: string[] } {
  const stamp = backupStampZip(new Date())
  const document = buildDiagnostics({
    dataDir: deps.dataDir,
    version: deps.version,
    ...(bookRoot === undefined ? {} : { bookRoot }),
    ...(tools === undefined ? {} : { tools }),
  })
  const file = `${deps.dataDir}/diagnostics/${stamp}.json`
  return {
    displayPath: maskPath(file, { home: process.env['HOME'] ?? process.env['USERPROFILE'] ?? '', dataDir: deps.dataDir }),
    bytes: Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`, 'utf8'),
    summary: document.summary,
  }
}
