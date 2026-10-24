/**
 * The diagnostics package (ADR-0018 D5, roadmap X-22): what the plugin may say about
 * itself when the author pastes it into an issue.
 *
 * THE ONE RULE. This document leaves the machine, so it is a WHITELIST, not a
 * redaction of a dump: every field below is written because someone named it. It
 * carries versions, build stamps, platform facts, index metadata, per-domain COUNTS,
 * the tool list with its surface hashes, the settings after masking, and nothing
 * else. It never reads a chapter, a character card or a setting entry, never opens
 * `.env`, `.credentials.yaml` or `.openviking/config.local.json`, and never names an
 * absolute path — `~/…` stands in for the home directory and `<book>` for the book.
 *
 * WHY THE FORMAT IS JSON (and not Markdown). The tests have to prove an absence:
 * "the body text I planted is nowhere in the file". That is a string search over the
 * artifact, which is exact for JSON and fuzzy for a rendered report. JSON is also
 * diffable between two exports, which is what turns "it broke after the upgrade"
 * into one comparison. Human readability is not lost — `summary` holds the same facts
 * as lines, so the file reads fine when opened in an editor.
 *
 * WHY THE LOG SECTION SAYS "unavailable". DSH gives a plugin no log-file API, and the
 * only logs on disk belong to the Host: tailing them would ship other plugins' output
 * — and anything they printed — inside a package whose whole promise is D5's
 * whitelist. So the field is present and honest (`available: false` + the reason and
 * the requested line count) instead of being quietly absent or quietly unsafe.
 *
 * NOTHING HERE WRITES, EXCEPT `exportDiagnostics`. Building the document is a pure
 * read (one read-only index open, one `stat`), so the panel can show a preview.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

import { getLoadedBuild, summarizeBuild } from './build-info.js'
import type { BuildSummary } from './build-info.js'
import { INDEX_SCHEMA_VERSION } from './conventions.js'
import { checkIndexFreshness } from './index-freshness.js'
import type { IndexFreshnessState } from './index-freshness.js'
import { indexPaths, readIndexMeta } from './indexer.js'
import { SETTINGS_SCHEMA_VERSION, readSettings } from './settings.js'
import type { InkflowSettings, SettingsWarning } from './settings.js'

/** `dataDir/diagnostics`: the plugin's own drop directory for exported packages. */
export const DIAGNOSTICS_DIR = 'diagnostics'

/** The document's own format tag, so a reader can refuse a stranger's JSON. */
export const DIAGNOSTICS_FORMAT = 'inkflow-diagnostics/1'

/** Lines of host log asked for by default (D5). See the header: the answer is `unavailable`. */
export const DIAGNOSTICS_LOG_LINES = 200

/** One tool as the package lists it: a name and a hash of its model-facing surface. */
export interface ToolSurfaceEntry {
  name: string
  /** `sha256` of `{description, parameters, output}` over key-sorted JSON, first 8 hex. */
  surfaceHash: string
}

/** A tool definition, narrowed to what the surface hash needs (no Host import). */
export interface ToolSurfaceSource {
  name: string
  description?: string
  parameters?: unknown
  output?: { schema?: unknown }
}

export interface DiagnosticsInput {
  /** The plugin's own directory (`config.ts`'s `dataDir`). */
  dataDir: string
  /** The running plugin version (`apply()`'s `VERSION`). */
  version: string
  /** The book in scope; absent = a plugin-wide package with no index section. */
  bookRoot?: string
  /** The tool table the plugin registered, for the surface list. */
  tools?: readonly ToolSurfaceSource[]
  /** Timestamp override for a deterministic test. */
  at?: Date
}

/** Where the index stands, without building it. */
export interface DiagnosticsIndex {
  available: boolean
  reason?: string
  /** `PRAGMA user_version` as found. */
  userVersion?: number
  /** What this build would write; a mismatch means "the next read rebuilds". */
  expectedUserVersion: number
  fileCount?: number
  entityCount?: number
  /** Entity rows per domain kind (`character`, `chapter`, `world`, …). */
  byKind?: Record<string, number>
  /** Per-domain table counts the indexer already publishes. */
  tableCounts?: Record<string, number>
  /** `meta.builtAt`: when the index was last rebuilt. */
  builtAt?: string
  /** The freshness verdict as found (`fresh`/`stale`/`missing`/`incompatible`). */
  freshness?: IndexFreshnessState
  /** How many files differ from the index, capped by the freshness check itself. */
  changedFiles?: number
}

/** The whole document. Every key is here on purpose; nothing else is written. */
export interface DiagnosticsDocument {
  format: typeof DIAGNOSTICS_FORMAT
  generatedAt: string
  plugin: {
    version: string
    build: BuildSummary
    engines: Record<string, string>
  }
  runtime: {
    node: string
    platform: string
    arch: string
    /** `process.versions.icu` — the ICU version compiled in. */
    icu: string | null
    /** True when this Node was built with a small-ICU (a locale bug candidate). */
    icuSmall: boolean
    /** `process.versions.v8`, for a crash report that names an engine. */
    v8: string
  }
  settings: {
    schemaVersion: number
    /** Absolute paths replaced by `~/…`; the API key replaced by `[redacted]`. */
    values: InkflowSettings
    warn: SettingsWarning | null
  }
  book: {
    /** The book's directory name only — never its path. */
    slug: string
    indexPath: string
    index: DiagnosticsIndex
  } | null
  tools: {
    count: number
    entries: ToolSurfaceEntry[]
  }
  logs: {
    available: false
    requestedLines: number
    reason: string
  }
  /** The same facts as readable lines, so the file is legible in an editor. */
  summary: string[]
}

export interface ExportDiagnosticsValue {
  /** Absolute path of the written package. */
  path: string
  /** `~/…`-masked path, for a reply that leaves the machine. */
  displayPath: string
  bytes: number
  document: DiagnosticsDocument
}

export type DiagnosticsResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; hint?: string } }

// ---------------------------------------------------------------------------
// The tool surface hash
// ---------------------------------------------------------------------------

const MAX_SURFACE_HASH_CHARS = 8

/** Key-sorted JSON, so the hash does not depend on property order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

/**
 * The hash this package lists per tool.
 *
 * Same algorithm as `scripts/surface-hash.mjs` and `tests/domain-registry.test.js`
 * (key-sorted JSON of `{description, parameters, output}`, first 8 hex of sha256), so
 * a hash pasted from a diagnostics package can be compared with the pinned baseline
 * in the test suite without converting anything.
 */
export function toolSurfaceHash(tool: ToolSurfaceSource): string {
  const surface = { description: tool.description, parameters: tool.parameters, output: tool.output }
  return createHash('sha256').update(stableStringify(surface)).digest('hex').slice(0, MAX_SURFACE_HASH_CHARS)
}

function toolSurfaceEntries(tools: readonly ToolSurfaceSource[] | undefined): ToolSurfaceEntry[] {
  if (tools === undefined) return []
  return [...tools]
    .map((tool) => ({ name: tool.name, surfaceHash: toolSurfaceHash(tool) }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** `engines` from the manifest next to the bundle (`lib/index.js` → `../package.json`). */
function readEngines(): Record<string, string> {
  try {
    const url = import.meta.url
    if (!url.startsWith('file:')) return {}
    const manifest = join(dirname(fileURLToPath(url)), '..', 'package.json')
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const engines = (parsed as Record<string, unknown>)['engines']
    if (typeof engines !== 'object' || engines === null) return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(engines as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value
    }
    return out
  } catch {
    // A bundle without its manifest (a test bundling this file alone) reports no
    // engines rather than failing: the rest of the package is still worth having.
    return {}
  }
}

interface IcuFacts {
  icu: string | null
  icuSmall: boolean
}

function readIcu(): IcuFacts {
  const versions = process.versions as Record<string, string | undefined>
  const icu = typeof versions['icu'] === 'string' ? versions['icu'] : null
  // `process.config.variables.icu_small` is what distinguishes a small-ICU build —
  // the usual cause of "Intl works on my machine but not on yours".
  const config = process.config as unknown as { variables?: Record<string, unknown> } | undefined
  const small = config?.variables?.['icu_small']
  return { icu, icuSmall: small === true || small === 'true' }
}

/** Entity rows per kind, read from the derived index without building it. */
function readEntitiesByKind(root: string): { count: number; byKind: Record<string, number> } | undefined {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(indexPaths(root).dbFile, { readOnly: true })
    const rows = db.prepare('SELECT kind, COUNT(*) AS n FROM entities GROUP BY kind').all() as unknown as Array<
      Record<string, unknown>
    >
    const byKind: Record<string, number> = {}
    let count = 0
    for (const row of rows) {
      if (typeof row['kind'] !== 'string' || typeof row['n'] !== 'number') continue
      byKind[row['kind']] = row['n']
      count += row['n']
    }
    return { count, byKind }
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

function indexSection(root: string): DiagnosticsIndex {
  const meta = readIndexMeta(root)
  if (!meta.dbExists) {
    return { available: false, reason: 'index/inkflow.db is absent; the first read rebuilds it', expectedUserVersion: INDEX_SCHEMA_VERSION }
  }
  const freshness = checkIndexFreshness(root)
  const entities = meta.schemaMatches ? readEntitiesByKind(root) : undefined
  const section: DiagnosticsIndex = {
    available: true,
    expectedUserVersion: INDEX_SCHEMA_VERSION,
    freshness: freshness.state,
    changedFiles: freshness.changes,
  }
  if (meta.schemaVersion !== undefined) section.userVersion = meta.schemaVersion
  if (meta.builtAt !== undefined) section.builtAt = meta.builtAt
  section.fileCount = meta.counts.files
  section.tableCounts = {
    chapters: meta.counts.chapters,
    characters: meta.counts.characters,
    worldEntries: meta.counts.worldEntries,
    outlineNodes: meta.counts.outlineNodes,
    libraryFiles: meta.counts.libraryFiles,
  }
  if (entities !== undefined) {
    section.entityCount = entities.count
    section.byKind = entities.byKind
  }
  if (!meta.schemaMatches) {
    section.reason = `the index was built by schema v${String(meta.schemaVersion ?? 0)}; this plugin writes v${String(INDEX_SCHEMA_VERSION)}, so the next read discards and rebuilds it`
  }
  return section
}

/** The roots that are replaced by name, longest first (see `maskString`). */
export interface MaskRoots {
  /** The author's home directory → `~`. */
  home: string
  /** The plugin data directory → `<plugin>`; keeps the shape of a path inside it. */
  dataDir?: string
  /** The book in scope → `<book>`. */
  bookRoot?: string
}

function normalizedRoot(root: string | undefined): string | undefined {
  if (root === undefined) return undefined
  const slashed = root.replaceAll('\\', '/').replace(/\/+$/, '')
  return slashed === '' ? undefined : slashed
}

/**
 * A path as it may leave the machine.
 *
 * The three roots are checked longest-first (a book lives inside the data directory's
 * sibling space and both live under home, so short-first would hide the informative
 * part). Anything else that is still absolute keeps only its last segment: a path from
 * another volume cannot be partially meaningful without naming where it is.
 */
export function maskPath(path: string, roots: MaskRoots): string {
  const normalised = path.replaceAll('\\', '/')
  const candidates: Array<{ root: string; replacement: string }> = []
  const book = normalizedRoot(roots.bookRoot)
  if (book !== undefined) candidates.push({ root: book, replacement: '<book>' })
  const dataDir = normalizedRoot(roots.dataDir)
  if (dataDir !== undefined) candidates.push({ root: dataDir, replacement: '<plugin>' })
  const home = normalizedRoot(roots.home)
  if (home !== undefined) candidates.push({ root: home, replacement: '~' })
  candidates.sort((left, right) => right.root.length - left.root.length)

  for (const candidate of candidates) {
    if (!normalised.toLowerCase().startsWith(candidate.root.toLowerCase())) continue
    const rest = normalised.slice(candidate.root.length).replace(/^\/+/, '')
    return rest === '' ? candidate.replacement : `${candidate.replacement}/${rest}`
  }
  return /^([a-zA-Z]:\/|\/)/.test(normalised) ? `<absolute>/${basename(normalised)}` : normalised
}

/**
 * Walk the document and mask every string: known roots first, then anything that
 * looks like a credential.
 *
 * Done as a post-pass over the finished document rather than field by field, so a
 * field added later cannot skip it — the whitelist decides WHAT is in the package,
 * this pass decides that nothing in it names the machine.
 */
function maskDocument<T>(value: T, roots: MaskRoots): T {
  if (typeof value === 'string') return maskString(value, roots) as unknown as T
  if (Array.isArray(value)) return value.map((entry) => maskDocument(entry, roots)) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = maskDocument(entry, roots)
    }
    return out as unknown as T
  }
  return value
}

/** A secret shape this package must never carry, even if a future field holds one. */
const SECRET_SHAPE = /(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]{8,}|(?<=(?:token|secret|password|api[_-]?key)["'\s:=]{1,4})[A-Za-z0-9._-]{16,})/giu

/**
 * Mask one string.
 *
 * SUBSTRING, not prefix: a summary line like `settings: {"sharedRoot":"/home/x/…"}`
 * *contains* a path rather than being one, and whole-string masking let exactly that
 * leak on Linux (where the temp directory is not under home, so no prefix matched at
 * all). Replacing every occurrence of each known root fixes the class of bug instead of
 * one instance of it, and the longest-root-first order keeps `~/…` from swallowing a
 * book that lives under home.
 */
function maskString(text: string, roots: MaskRoots): string {
  const candidates: Array<{ root: string; replacement: string }> = []
  const book = normalizedRoot(roots.bookRoot)
  if (book !== undefined) candidates.push({ root: book, replacement: '<book>' })
  const dataDir = normalizedRoot(roots.dataDir)
  if (dataDir !== undefined) candidates.push({ root: dataDir, replacement: '<plugin>' })
  const home = normalizedRoot(roots.home)
  if (home !== undefined) candidates.push({ root: home, replacement: '~' })
  candidates.sort((left, right) => right.root.length - left.root.length)

  let masked = text
  for (const candidate of candidates) {
    // Both separators, because a Windows path may be echoed either way inside a JSON
    // string. The remainder is normalised to `/`, so one setting reads the same on both
    // platforms (`~/shared-root`, never `~\shared-root`).
    for (const variant of new Set([candidate.root, candidate.root.replaceAll('/', '\\')])) {
      for (;;) {
        const at = masked.toLowerCase().indexOf(variant.toLowerCase())
        if (at < 0) break
        const rest = masked.slice(at + variant.length).replaceAll('\\', '/')
        masked = `${masked.slice(0, at)}${candidate.replacement}${rest}`
      }
    }
  }
  // A string that IS an absolute path (and was not one of the known roots) keeps only
  // its last segment; a string that merely contains one is left alone here, because a
  // generic regex would eat URL-ish text that is not a local path.
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(masked)) masked = maskPath(masked, roots)
  return masked.replace(SECRET_SHAPE, '[redacted]')
}

// ---------------------------------------------------------------------------
// Building the document
// ---------------------------------------------------------------------------

/**
 * The settings as a package may carry them: every value except the secrets.
 *
 * A whitelist of what to KEEP would have to be maintained for every future field; naming the
 * one secret instead keeps a new knob useful in a package by default, which is the common
 * case. `[redacted]` rather than absence, so "configured but hidden" stays distinguishable
 * from "not configured" when a maintainer reads the file — that difference is the whole
 * question in "why is semantic search not working".
 */
export function maskSettingsSecrets(settings: InkflowSettings): Record<string, unknown> {
  const values: Record<string, unknown> = { ...settings }
  if (settings.semanticApiKey !== undefined) values['semanticApiKey'] = '[redacted]'
  return values
}

/**
 * Assemble the package. Pure apart from one read-only index open and one `stat`.
 *
 * Never throws: an unreadable index, a missing manifest or a broken settings file each
 * cost that section (or add a `warn`), never the export.
 */
export function buildDiagnostics(input: DiagnosticsInput): DiagnosticsDocument {
  const at = input.at ?? new Date()
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? homedir()
  const bookRoot = input.bookRoot === undefined ? undefined : resolve(input.bookRoot)
  const settingsRead = readSettings(input.dataDir)
  const icu = readIcu()
  const loaded = getLoadedBuild({ version: input.version })
  const tools = toolSurfaceEntries(input.tools)

  const document: DiagnosticsDocument = {
    format: DIAGNOSTICS_FORMAT,
    generatedAt: at.toISOString(),
    plugin: { version: input.version, build: summarizeBuild(loaded), engines: readEngines() },
    runtime: {
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      icu: icu.icu,
      icuSmall: icu.icuSmall,
      v8: process.versions.v8,
    },
    settings: {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      // The semantic search key is a credential (ADR-0020 E6): the package is meant to be
      // pasted into an issue, so it carries "a key is set", never the key itself.
      values: maskSettingsSecrets(settingsRead.settings) as unknown as InkflowSettings,
      warn: settingsRead.warn ?? null,
    },
    book:
      bookRoot === undefined
        ? null
        : {
            slug: basename(bookRoot),
            indexPath: maskPath(indexPaths(bookRoot).dbFile, { home, dataDir: input.dataDir, bookRoot }),
            index: indexSection(bookRoot),
          },
    tools: { count: tools.length, entries: tools },
    logs: {
      available: false,
      requestedLines: DIAGNOSTICS_LOG_LINES,
      reason:
        'the Host exposes no log file to plugins, and tailing its own logs would ship other plugins output; ask for the DSH log separately if a crash needs one',
    },
    summary: [],
  }

  // Mask FIRST, then summarize, then mask the summary itself. The order matters and
  // the reason is a real leak: a summary line embeds `JSON.stringify(settings.values)`,
  // whose backslashes are escaped (`"C:\\\\Users…"`), so masking afterwards cannot find
  // the raw root inside it. Summarizing already-masked values keeps the readable half
  // as safe as the structured half, and the last pass is the safety net for both.
  const roots: MaskRoots = { home, dataDir: input.dataDir, ...(bookRoot === undefined ? {} : { bookRoot }) }
  const masked = maskDocument(document, roots)
  masked.summary = maskDocument(summarizeDocument(masked), roots)
  return masked
}

/** The readable half: the same facts as lines, for a human opening the file. */
function summarizeDocument(document: DiagnosticsDocument): string[] {
  const lines: string[] = []
  lines.push(`InkFlow ${document.plugin.version} — build ${document.plugin.build.build} (loaded ${document.plugin.build.loadedAt})`)
  if (document.plugin.build.staleLoadedCode) {
    lines.push('the loaded code is OLDER than the bundle on disk: rebuild and fully restart DSH before reporting a bug')
  }
  lines.push(`node ${document.runtime.node} on ${document.runtime.platform}/${document.runtime.arch} (ICU ${document.runtime.icu ?? 'none'}${document.runtime.icuSmall ? ', small ICU' : ''})`)
  lines.push(`settings: ${JSON.stringify(document.settings.values)}${document.settings.warn === null ? '' : ` — warn: ${document.settings.warn.code}`}`)
  if (document.book === null) {
    lines.push('book: none in scope (plugin-wide package)')
  } else {
    const index = document.book.index
    lines.push(
      `book: ${document.book.slug} — index ${index.available ? `v${String(index.userVersion ?? 0)} (${index.freshness ?? 'unknown'}), ${String(index.fileCount ?? 0)} files, ${String(index.entityCount ?? 0)} entities` : (index.reason ?? 'unavailable')}`,
    )
    if (index.tableCounts !== undefined) {
      lines.push(
        `domains: ${Object.entries(index.tableCounts)
          .map(([key, count]) => `${key} ${String(count)}`)
          .join(' · ')}`,
      )
    }
  }
  lines.push(`tools: ${String(document.tools.count)} registered`)
  lines.push('logs: unavailable (see the logs.reason field)')
  return lines
}

// ---------------------------------------------------------------------------
// Writing the package
// ---------------------------------------------------------------------------

/** `dataDir/diagnostics`. */
export function diagnosticsDir(dataDir: string): string {
  return join(dataDir, DIAGNOSTICS_DIR)
}

/**
 * Write one package to `dataDir/diagnostics/<stamp>.json` and answer where it went.
 *
 * The stamp matches the backup naming (`YYYYMMDD-HHmmss`, UTC) so two exports sort
 * the same way the backup list does, and the extension states the format instead of
 * leaving the reader to guess.
 */
export function exportDiagnostics(input: DiagnosticsInput): DiagnosticsResult<ExportDiagnosticsValue> {
  const document = buildDiagnostics(input)
  const at = input.at ?? new Date()
  const iso = at.toISOString()
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`
  const dir = diagnosticsDir(input.dataDir)
  const path = join(dir, `${stamp}.json`)
  const text = `${JSON.stringify(document, null, 2)}\n`
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? homedir()

  try {
    mkdirSync(dir, { recursive: true })
    const temp = `${path}.tmp-${String(process.pid)}`
    // Atomic pair: write beside the target, then rename. A half-written package would
    // be attached to an issue as if it were complete.
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, path)
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'DIAGNOSTICS_WRITE_FAILED',
        message: `the diagnostics package could not be written: ${cause instanceof Error ? cause.message : String(cause)}`,
        hint: 'check that the plugin data directory is writable; nothing else was touched',
      },
    }
  }
  const bytes = existsSync(path) ? statSync(path).size : Buffer.byteLength(text, 'utf8')
  return {
    ok: true,
    value: {
      path,
      displayPath: maskPath(path, {
        home,
        dataDir: input.dataDir,
        ...(input.bookRoot === undefined ? {} : { bookRoot: resolve(input.bookRoot) }),
      }),
      bytes,
      document,
    },
  }
}
