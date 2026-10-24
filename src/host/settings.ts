/**
 * Plugin-level settings (ADR-0018 D1/D2, roadmap X-19): one file, outside every book.
 *
 * WHY THE FILE IS HERE AND NOT IN A BOOK. A book is the author's own git repository
 * (ADR-0005), so a plugin preference written into it would be committed and would
 * carry this machine's paths into every copy the author shares. The only
 * plugin-owned directory is `config.ts`'s `dataDir` (`$DSH_HOME/inkflow`), and that
 * is also where the settings file lives: `dataDir/settings.json`.
 *
 * WHY READING NEVER THROWS (D2). `settings.json` is a file a human may open in an
 * editor, and the plugin has to boot regardless of what is in it: a truncated
 * JSON, a string where a number belongs, a directory name in a number field. Every
 * read therefore answers with a COMPLETE settings object — missing file → defaults,
 * missing field → that field's default, out-of-range number → clamped, wrong type →
 * default — plus an optional `warn` the diagnostics package reports (D5). Nothing
 * on any read path can throw because of this file.
 *
 * WHY THERE IS NO CACHE (D2 "即时生效"). Every reader calls `readSettings()` at the
 * moment it needs the value, so a save through the panel or a hand edit is visible
 * on the next tool call without restarting DSH. The file is a few hundred bytes and
 * reads are rare (a write, a panel paint, a diagnostics export), so a cache would
 * buy nothing and cost the "I changed it and nothing happened" class of bug.
 *
 * WHY WRITES REFUSE A NEWER SCHEMA. The field whitelist below means a write
 * rewrites the file from the known fields only, which would silently DROP a field a
 * future plugin version added. `schemaVersion` is the one-way door for that: a file
 * stamped newer than `SETTINGS_SCHEMA_VERSION` is read (known fields only) but never
 * overwritten, and the caller gets `SETTINGS_NEWER_VERSION` instead of a quiet data
 * loss.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Shape version of `settings.json`.
 *
 * Bump only for a shape change a v1 reader would get wrong (a renamed field, a
 * changed unit). Adding a field does not need a bump: an old reader applies the
 * whitelist and a new reader defaults what is absent.
 */
export const SETTINGS_SCHEMA_VERSION = 1

/** File name inside `dataDir`; the only spelling of it in the codebase. */
export const SETTINGS_FILE = 'settings.json'

/**
 * The settings a book-independent surface may read.
 *
 * Optional keys (`sharedRoot`, `authorName`) are ABSENT when unset rather than
 * empty strings, so "set to empty" and "never set" stay distinguishable on the wire
 * and in the written file.
 */
export interface InkflowSettings {
  /**
   * Where the shared library lives (ADR-0007 C1): an ABSOLUTE path. Absent =
   * `dataDir/shared`, which is what `config.ts` already says. A value that is not
   * absolute, or that climbs with `..`, is ignored with a warning rather than
   * re-rooted — see `sharedRootOf`.
   *
   * Stored as the author typed it (the whitelist keeps the string): the store does
   * not decide, `sharedRootOf` does, so "what is in the file" and "what is in
   * force" stay two different questions.
   */
  sharedRoot?: string
  /**
   * Whether the semantic (OVK) backend may be used when it is available.
   *
   * Read by the retrieval layer (#41), never by this module: settings state the
   * author's preference, they do not implement a backend.
   */
  semanticSearch: boolean
  /**
   * Where the OpenViking HTTP server answers (`http://host:port`; a trailing slash is
   * stripped on read). Absent = nothing configured, so the retrieval layer degrades to
   * FTS5 with `no-endpoint` (ADR-0009 P8 / ADR-0020 E1).
   *
   * Deliberately NOT discovered from OVK's own machine config (`ov.conf`): that file is
   * machine state the reader cannot see in this page, it drifts per machine, and it
   * carries credentials that are not this plugin's to read.
   */
  semanticEndpoint?: string
  /**
   * Optional bearer token for that server, sent as `Authorization: Bearer`.
   *
   * A secret. It never travels back out: the panel, the tools and the diagnostics
   * package report only that it is set (ADR-0020 E6, ADR-0018 D5).
   */
  semanticApiKey?: string
  /** Idle delay before the workbench autosaves, in ms. */
  autosaveIntervalMs: number
  /** Default author name offered by the new-book wizard; absent = ask. */
  authorName?: string
  /**
   * Directory names (relative to a book root) that bulk operations skip, e.g. a
   * scratch directory the author keeps inside the repository. Never a path escape:
   * entries are normalised and `..` is dropped.
   */
  excludeDirs: string[]
  /** How many local backup packages to keep per book (1–50, D3). */
  backupKeep: number
}

/** What a missing file, or a field a broken file could not supply, reads as. */
export const SETTINGS_DEFAULTS = {
  semanticSearch: false,
  /**
   * 1500 ms equals `client/editor-model.ts`'s `AUTOSAVE_DELAY_MS`, so the default
   * states today's behaviour instead of changing it by introducing a knob.
   *
   * NOT YET CONSUMED BY THE EDITOR: the workbench editor still times its autosave from
   * its own constant. Wiring this value in needs a session-scoped read route plus a
   * prop on the editor, which is the workbench owner's change — this module stores and
   * reports the value so that change has one place to read it from.
   */
  autosaveIntervalMs: 1500,
  backupKeep: 5,
  excludeDirs: [] as readonly string[],
} as const

/** Ranges are clamped, never refused (D2). Stated as data so the panel can show them. */
export const SETTINGS_LIMITS = {
  autosaveIntervalMs: { min: 500, max: 600_000 },
  backupKeep: { min: 1, max: 50 },
} as const

/** The field whitelist, in the order the panel shows them. Nothing else is written. */
export const SETTINGS_FIELDS = [
  'sharedRoot',
  'semanticSearch',
  'semanticEndpoint',
  'semanticApiKey',
  'autosaveIntervalMs',
  'authorName',
  'excludeDirs',
  'backupKeep',
] as const
export type SettingsField = (typeof SETTINGS_FIELDS)[number]

/** One line the diagnostics package carries instead of failing (D2/D5). */
export interface SettingsWarning {
  code: 'SETTINGS_UNREADABLE' | 'SETTINGS_NOT_OBJECT' | 'SETTINGS_NEWER_VERSION'
  message: string
}

/** A read: the complete settings plus how they were obtained. */
export interface SettingsRead {
  settings: InkflowSettings
  /** `'default'` = no file (or an unusable one), `'file'` = parsed from disk. */
  source: 'default' | 'file'
  /** The `schemaVersion` on disk when it differed from ours or was unreadable. */
  fileSchemaVersion?: number
  warn?: SettingsWarning
}

/** A write's answer: what is on disk now, and which fields actually moved. */
export interface SettingsWrite {
  settings: InkflowSettings
  /** Fields whose effective value changed (empty = a no-op save). */
  changed: SettingsField[]
  /** True when a broken file was replaced by a complete one. */
  repaired: boolean
  warn?: SettingsWarning
}

export type SettingsError = {
  code: 'SETTINGS_NEWER_VERSION' | 'SETTINGS_WRITE_FAILED'
  message: string
  hint?: string
  path?: string
}

export type SettingsResult<T> = { ok: true; value: T } | { ok: false; error: SettingsError }

/** `dataDir/settings.json` — the one file this module owns. */
export function settingsPath(dataDir: string): string {
  return join(dataDir, SETTINGS_FILE)
}

/**
 * The settings as a surface may SHOW them: everything except the secret.
 *
 * One function because three surfaces read settings into a reply (the settings tool, the
 * settings page's channel, the diagnostics package) and each of them would otherwise need to
 * remember that `semanticApiKey` is a credential (ADR-0020 E6, ADR-0018 D5). `semanticApiKeySet`
 * replaces it, so "configured but hidden" stays distinguishable from "not configured" —
 * which is the first question in "why is semantic search not working".
 */
export function redactSettings(settings: InkflowSettings): Omit<InkflowSettings, 'semanticApiKey'> & { semanticApiKeySet: boolean } {
  const { semanticApiKey, ...rest } = settings
  return { ...rest, semanticApiKeySet: semanticApiKey !== undefined }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * A finite integer clamped into `limits`; anything that is not a number is the
 * default. Same rule as `config.ts`'s `clampedInt`, deliberately: two modules that
 * both answer "what does an out-of-range value mean" must not answer differently.
 */
function clampedInt(
  value: unknown,
  fallback: number,
  limits: { readonly min: number; readonly max: number },
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), limits.min), limits.max)
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Normalise one `excludeDirs` entry to a book-root-relative directory name.
 *
 * The list is matched against paths this plugin resolves itself, so an absolute
 * path or a `..` segment in it can only ever be a mistake: both are dropped here
 * rather than becoming a rule some future writer has to re-validate.
 */
function normalizeExcludeDir(value: unknown): string | undefined {
  const raw = trimmedString(value)
  if (raw === undefined) return undefined
  const slashed = raw.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (slashed === '') return undefined
  const segments = slashed.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) return undefined
  if (segments.some((segment) => segment === '..')) return undefined
  if (/^[a-zA-Z]:/.test(slashed)) return undefined
  return segments.join('/')
}

function normalizeExcludeDirs(value: unknown): string[] {
  if (!Array.isArray(value)) return [...SETTINGS_DEFAULTS.excludeDirs]
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of value) {
    const normalized = normalizeExcludeDir(entry)
    if (normalized === undefined || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

/**
 * Project one raw record into the whitelist, field by field.
 *
 * This is the ONLY place the read rules live: the file reader, the writer's merge
 * and the test suite all go through it, so "field missing = default" cannot differ
 * between reading and saving.
 */
export function coerceSettings(raw: unknown): InkflowSettings {
  const record = asRecord(raw) ?? {}
  const settings: InkflowSettings = {
    semanticSearch:
      typeof record['semanticSearch'] === 'boolean' ? record['semanticSearch'] : SETTINGS_DEFAULTS.semanticSearch,
    autosaveIntervalMs: clampedInt(
      record['autosaveIntervalMs'],
      SETTINGS_DEFAULTS.autosaveIntervalMs,
      SETTINGS_LIMITS.autosaveIntervalMs,
    ),
    excludeDirs: normalizeExcludeDirs(record['excludeDirs']),
    backupKeep: clampedInt(record['backupKeep'], SETTINGS_DEFAULTS.backupKeep, SETTINGS_LIMITS.backupKeep),
  }
  const sharedRoot = trimmedString(record['sharedRoot'])
  if (sharedRoot !== undefined) settings.sharedRoot = sharedRoot
  const authorName = trimmedString(record['authorName'])
  if (authorName !== undefined) settings.authorName = authorName
  const semanticEndpoint = normalizeEndpoint(record['semanticEndpoint'])
  if (semanticEndpoint !== undefined) settings.semanticEndpoint = semanticEndpoint
  const semanticApiKey = trimmedString(record['semanticApiKey'])
  if (semanticApiKey !== undefined) settings.semanticApiKey = semanticApiKey
  return settings
}

/**
 * A server URL, or nothing.
 *
 * Only `http:`/`https:` are kept: this value is handed to `fetch`, so a relative path,
 * a `file:` URL or a scheme typo must read as "not configured" (degrade to FTS5) rather
 * than become a request the retrieval layer tries to make. Trailing slashes are stripped
 * because every request path in `ovk.ts` starts with `/` — keeping `http://x:1/` would
 * produce `//health`, which some servers answer and others do not.
 */
export function normalizeEndpoint(value: unknown): string | undefined {
  const raw = trimmedString(value)
  if (raw === undefined) return undefined
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (parsed.host === '') return undefined
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/u, '')}`
}

/**
 * Read `dataDir/settings.json`, answering complete settings in every case (D2).
 *
 * Never throws: an unreadable file, invalid JSON and a non-object document all
 * become `SETTINGS_DEFAULTS` plus one `warn`.
 */
export function readSettings(dataDir: string): SettingsRead {
  const path = settingsPath(dataDir)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // The overwhelmingly common case: the file does not exist yet.
    return { settings: coerceSettings(undefined), source: 'default' }
  }

  let parsed: unknown
  try {
    // A human may save this file with a BOM from a Windows editor; JSON.parse
    // refuses that byte, and the author would see "all settings lost".
    parsed = JSON.parse(text.replace(/^\uFEFF/u, ''))
  } catch {
    return {
      settings: coerceSettings(undefined),
      source: 'default',
      warn: {
        code: 'SETTINGS_UNREADABLE',
        message: `${SETTINGS_FILE} is not valid JSON, so every setting reads as its default; saving from the panel rewrites the file`,
      },
    }
  }

  const record = asRecord(parsed)
  if (record === undefined) {
    return {
      settings: coerceSettings(undefined),
      source: 'default',
      warn: {
        code: 'SETTINGS_NOT_OBJECT',
        message: `${SETTINGS_FILE} does not hold a JSON object, so every setting reads as its default`,
      },
    }
  }

  const rawVersion = record['schemaVersion']
  const version = typeof rawVersion === 'number' && Number.isFinite(rawVersion) ? rawVersion : undefined
  const settings = coerceSettings(record)
  if (version !== undefined && version !== SETTINGS_SCHEMA_VERSION) {
    return {
      settings,
      source: 'file',
      fileSchemaVersion: version,
      warn: {
        code: 'SETTINGS_NEWER_VERSION',
        message:
          version > SETTINGS_SCHEMA_VERSION
            ? `${SETTINGS_FILE} was written by a newer plugin (schemaVersion ${String(version)}); the fields this version knows are used and the file is never overwritten`
            : `${SETTINGS_FILE} carries schemaVersion ${String(version)}; this plugin writes ${String(SETTINGS_SCHEMA_VERSION)} and the fields it knows are used`,
      },
    }
  }
  return { settings, source: 'file' }
}

/** The settings themselves, for a caller that does not care how they were read. */
export function settingsOf(dataDir: string): InkflowSettings {
  return readSettings(dataDir).settings
}

/**
 * Why a configured `sharedRoot` is NOT the root in force.
 *
 * A warning rather than a refusal: D2 says a value the plugin cannot honour falls
 * back to the default and reports itself, because a settings file must never be
 * able to stop the plugin (or a book) from opening.
 */
export interface SharedRootWarning {
  code: 'SHARED_ROOT_IGNORED'
  message: string
}

/** The directory the shared library is read from, and how that was decided. */
export interface SharedRootResolution {
  /** Always usable, always absolute. */
  root: string
  /** `'setting'` = the author's `sharedRoot`; `'default'` = `dataDir/shared`. */
  source: 'default' | 'setting'
  /** Present only when a configured value was rejected (and `source` is `'default'`). */
  warning?: SharedRootWarning
}

/** `C:\…`, `C:/…`, `/…` or `\…`: lexical, so a Windows value means the same on CI. */
const ABSOLUTE_SHARED_ROOT = /^([a-zA-Z]:[\\/]|[\\/])/u

/**
 * Why a configured `sharedRoot` cannot be honoured, or `undefined` when it can.
 *
 * TWO REFUSALS, both for the same reason: this value names a directory whose files
 * the plugin reads and lists, so a value that only LOOKS like a path would make the
 * panel show something other than the library the author configured.
 *
 *   * NOT ABSOLUTE — `settings.json` is a machine-level file, so the only anchor a
 *     relative value could have is `dataDir`, and re-rooting it silently is exactly
 *     how "I set it and nothing happened" happens (`libs` would mean
 *     `$DSH_HOME/inkflow/libs`, which is not what anyone typing into a field called
 *     *path* expects). This module used to resolve it there; #150 reversed that
 *     because the surprise cost more than the portability it bought.
 *   * CLIMBS WITH `..` — an absolute path carrying a `..` segment does not name the
 *     directory the author read out of the picker, and normalising it here would
 *     make the field mean something it does not say.
 *
 * Both fall back to `dataDir/shared` WITH a warning (ADR-0018 D2), so the failure is
 * visible in the answer that needed the root instead of being a guess.
 */
function sharedRootProblem(configured: string): string | undefined {
  if (!ABSOLUTE_SHARED_ROOT.test(configured)) return 'not an absolute path'
  if (configured.split(/[\\/]/u).includes('..')) return 'a path that climbs with ".."'
  return undefined
}

/**
 * The shared library root this plugin should use: the setting when it is usable,
 * else `dataDir/shared` (ADR-0007 C1, ADR-0018 D1).
 *
 * THE ONE ANSWER EVERY READER TAKES: the shared page (`hub-shared.ts`), the copies
 * list, `inkflow_shared_list` and the copy path all resolve their root here, so a
 * configured directory cannot be honoured by one surface and ignored by another
 * (the state #42 left behind: the field existed, no reader looked at it, and the
 * setting silently did nothing).
 */
export function sharedRootOf(dataDir: string, settings: InkflowSettings = settingsOf(dataDir)): SharedRootResolution {
  const fallback = join(dataDir, 'shared')
  const configured = settings.sharedRoot
  if (configured === undefined) return { root: fallback, source: 'default' }
  const problem = sharedRootProblem(configured)
  if (problem !== undefined) {
    return {
      root: fallback,
      source: 'default',
      warning: {
        code: 'SHARED_ROOT_IGNORED',
        message: `sharedRoot ${JSON.stringify(configured)} is ${problem}, so it is ignored and the shared library stays at dataDir/shared`,
      },
    }
  }
  return { root: configured, source: 'setting' }
}

/** Which fields differ between two settings objects (whitelist order). */
function changedFields(before: InkflowSettings, after: InkflowSettings): SettingsField[] {
  const changed: SettingsField[] = []
  for (const field of SETTINGS_FIELDS) {
    const left = before[field]
    const right = after[field]
    const same = Array.isArray(left) && Array.isArray(right) ? left.join('\u0000') === right.join('\u0000') : left === right
    if (!same) changed.push(field)
  }
  return changed
}

/**
 * Merge `patch` into the settings on disk and replace the file atomically.
 *
 * MERGE, NOT REPLACE: a field the caller omits keeps its current effective value,
 * so two callers (a panel form and a tool call) cannot erase each other's fields by
 * sending partial objects. `undefined` and an absent key mean the same thing —
 * "leave it alone"; `null` on an optional field means "clear it"; an empty array
 * clears `excludeDirs`.
 *
 * Only the whitelist is written: an unknown key in `patch` is ignored rather than
 * persisted, so this file cannot become a dump for future keys that outlive their
 * reader.
 */
export function writeSettings(dataDir: string, patch: Record<string, unknown>): SettingsResult<SettingsWrite> {
  const path = settingsPath(dataDir)
  const read = readSettings(dataDir)
  if (read.warn?.code === 'SETTINGS_NEWER_VERSION' && (read.fileSchemaVersion ?? 0) > SETTINGS_SCHEMA_VERSION) {
    return {
      ok: false,
      error: {
        code: 'SETTINGS_NEWER_VERSION',
        message: read.warn.message,
        hint: 'this build is older than the file; upgrade the plugin or edit settings.json by hand',
        path,
      },
    }
  }

  const merged: Record<string, unknown> = { ...read.settings }
  for (const field of SETTINGS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue
    const value = patch[field]
    if (value === undefined) continue
    if (value === null) {
      // `null` clears an optional field and resets a required one to its default.
      delete merged[field]
      continue
    }
    merged[field] = value
  }
  // The writer's own projection: same coercers as the reader, so a save can never
  // store a value a later read would silently reinterpret.
  const next = coerceSettings(merged)
  const changed = changedFields(read.settings, next)
  const document = { schemaVersion: SETTINGS_SCHEMA_VERSION, ...next }

  try {
    mkdirSync(dataDir, { recursive: true })
    const temp = `${path}.tmp-${String(process.pid)}-${String(Date.now())}`
    writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    renameSync(temp, path)
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'SETTINGS_WRITE_FAILED',
        message: `settings.json could not be written: ${cause instanceof Error ? cause.message : String(cause)}`,
        hint: 'the previous file (if any) is untouched; check that the plugin data directory is writable',
        path,
      },
    }
  }

  const result: SettingsWrite = { settings: next, changed, repaired: read.source === 'default' && existsSync(path) }
  if (read.warn !== undefined && read.warn.code !== 'SETTINGS_NEWER_VERSION') result.warn = read.warn
  return { ok: true, value: result }
}

/** Best-effort removal, for a test or a "reset to defaults" action. */
export function removeSettingsFile(dataDir: string): void {
  try {
    rmSync(settingsPath(dataDir), { force: true })
  } catch {
    // A file that cannot be removed is reported by the next read (it still parses).
  }
}
