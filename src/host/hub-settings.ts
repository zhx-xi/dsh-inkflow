/**
 * The settings page's Host half: the root-scoped channel for settings, the diagnostics
 * package and the local backups (#42, ADR-0018).
 *
 * WHY THIS IS A HUB MODULE AND NOT A SESSION ONE. The settings page lives in the book
 * hub (roadmap X-20: not a session tab), so its routes must answer with no session at
 * all — exactly the anchor problem `hub.ts` and `hub-shared.ts` already solve for the
 * book list and the shared library. What is different here is that two of the three
 * sections act on ONE book (backups are per book), so the panel has to name a book.
 *
 * HOW IT NAMES ONE WITHOUT NAMING A PATH (ADR-0008 D4 / ADR-0010 D3). The `book`
 * parameter is a **registry id** (or, for a profile whose registry exposes none, the
 * book's directory NAME). The Host matches it against `workspaceRegistry.list()` — the
 * same list the book rows come from — and never accepts a directory. A name that
 * matches two books is `BOOK_AMBIGUOUS` rather than a guess, because picking one and
 * backing up the other is exactly the silent wrong-book failure ADR-0010 D1 forbids.
 *
 * SETTINGS ARE NOT PER-BOOK (D1): the settings section needs no anchor at all, and a
 * write never touches a book. Only the backup and diagnostics sections resolve one.
 */

import type { HostContext } from './context.js'
import { realpathSync } from 'node:fs'
import {
  backupStampZip,
  bookSlugOf,
  createBookBackup,
  listBookBackups,
  planRestore,
  restoreBookBackup,
} from './backup-zip.js'
import type { BackupPackage, RestorePlan } from './backup-zip.js'
import { buildDiagnostics, exportDiagnostics, maskPath } from './diagnostics.js'
import { listRegisteredWorkspaces } from './hub.js'
import { SETTINGS_FIELDS, SETTINGS_LIMITS, readSettings, redactSettings, sharedRootOf, writeSettings } from './settings.js'
import { buildTools } from './tools.js'

type Json = Record<string, unknown>

export interface HubSettingsDeps {
  readonly ctx: HostContext
  readonly dataDir: string
  readonly version: string
}

/** A reply the route turns into `{ok:true,value}` / `{ok:false,error}`. */
export type HubReply<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; hint?: string } }

const ANCHOR_HINTS =
  'the settings page names a book by its workspace id (or its directory name), never by a path; refresh the book list and try again'

function asRecord(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined
}

function trimmed(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function homeDir(): string {
  return process.env['HOME'] ?? process.env['USERPROFILE'] ?? ''
}

// ---------------------------------------------------------------------------
// Anchors: a registered path, a registry id, or a book directory name
// ---------------------------------------------------------------------------

export interface HubBookAnchor {
  root: string
  title: string
  slug: string
  /** Registry id when the Host exposes one; absent otherwise. */
  workspaceId?: string
}

export type HubAnchorResult = { ok: true; value: HubBookAnchor } | { ok: false; error: { code: string; message: string; hint: string } }

function basenameOf(path: string): string {
  const normalised = path.replaceAll('\\', '/').replace(/\/+$/u, '')
  const index = normalised.lastIndexOf('/')
  return index < 0 ? normalised : normalised.slice(index + 1)
}

/** `realpath` when it resolves, the resolved path otherwise (a Windows junction case). */
function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/**
 * Resolve a `book` parameter against the workspace registry.
 *
 * THREE spellings, one rule: the anchor is always looked up in
 * `workspaceRegistry.list()`, and nothing outside the registry is ever accepted.
 *
 *   * a **registered path** (what `/hub/books` already hands the panel, and what the
 *     shared-content routes on this same channel take — one conversation, one
 *     spelling between the two panels). Compared by `realpath` on both sides, because
 *     the registry stores canonical paths while the panel may echo the row it was
 *     given with different casing or a trailing separator on Windows;
 *   * a **registry id** (stable across a directory rename);
 *   * a **directory name** (what a profile without ids can offer, and what a human
 *     recognises) — refused when two registered books share it.
 */
export function resolveHubBook(ctx: HostContext, anchor: unknown): HubAnchorResult {
  const wanted = trimmed(anchor)
  if (wanted === undefined) {
    return {
      ok: false,
      error: { code: 'BOOK_REQUIRED', message: 'this action needs a book', hint: ANCHOR_HINTS },
    }
  }
  const entries = listRegisteredWorkspaces(ctx)
  if (entries === undefined) {
    return {
      ok: false,
      error: {
        code: 'HUB_UNAVAILABLE',
        message: 'the Host exposes no workspace registry, so no book can be named',
        hint: 'open a book from a session with the InkFlow workbench first',
      },
    }
  }
  // A path-shaped anchor (a separator, a drive letter) is matched by canonical path
  // first and never falls through to name matching: "E:\书" must not match a book whose
  // directory happens to be called `书`.
  const looksLikePath = /[\\/]/.test(wanted) || /^[a-zA-Z]:/.test(wanted)
  if (looksLikePath) {
    const canonicalWanted = canonical(wanted)
    const match = entries.find((entry) => canonical(entry.path) === canonicalWanted || entry.path === wanted)
    if (match === undefined) {
      return {
        ok: false,
        error: {
          code: 'BOOK_NOT_FOUND',
          message: `${wanted} is not a registered book`,
          hint: `${ANCHOR_HINTS} — a path is accepted only when it is exactly a registered book`,
        },
      }
    }
    return { ok: true, value: anchorOf(match) }
  }

  const byId = entries.filter((entry) => entry.id !== undefined && entry.id === wanted)
  const candidates = byId.length > 0 ? byId : entries.filter((entry) => basenameOf(entry.path) === wanted)
  if (candidates.length === 0) {
    return {
      ok: false,
      error: { code: 'BOOK_NOT_FOUND', message: `no registered book matches ${JSON.stringify(wanted)}`, hint: ANCHOR_HINTS },
    }
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      error: {
        code: 'BOOK_AMBIGUOUS',
        message: `${String(candidates.length)} registered books match ${JSON.stringify(wanted)}`,
        hint: 'pass the workspace id (or the book\'s exact registered path) instead of the directory name; this page never guesses which book you meant',
      },
    }
  }
  return { ok: true, value: anchorOf(candidates[0] as { path: string; title?: string; id?: string }) }
}

function anchorOf(entry: { path: string; title?: string; id?: string }): HubBookAnchor {
  return {
    root: entry.path,
    title: entry.title ?? basenameOf(entry.path),
    slug: bookSlugOf(entry.path),
    ...(entry.id === undefined ? {} : { workspaceId: entry.id }),
  }
}

/** The books the panel may offer in its selector: id, title, slug — no path. */
function bookChoices(ctx: HostContext): Array<{ workspaceId: string | null; bookSlug: string; title: string }> {
  const entries = listRegisteredWorkspaces(ctx) ?? []
  const seen = new Set<string>()
  const out: Array<{ workspaceId: string | null; bookSlug: string; title: string }> = []
  for (const entry of entries) {
    const slug = bookSlugOf(entry.path)
    const key = entry.id ?? slug
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ workspaceId: entry.id ?? null, bookSlug: slug, title: entry.title ?? basenameOf(entry.path) })
  }
  return out
}

// ---------------------------------------------------------------------------
// Settings (no book involved: D1)
// ---------------------------------------------------------------------------

export function buildHubSettings(deps: HubSettingsDeps): Json {
  const read = readSettings(deps.dataDir)
  // The root the shared page will actually read (#150). The page shows it because the
  // field beside it is editable: "I set it and nothing happened" needs somewhere to be
  // answered, and this path is masked like every other path in the payload.
  const shared = sharedRootOf(deps.dataDir, read.settings)
  return {
    // Redacted: the page may show "a key is set", never the key (ADR-0020 E6). A browser is a
    // lower-trust surface than the file, and nothing on the page needs the value.
    settings: redactSettings(read.settings),
    source: read.source,
    warn: read.warn ?? null,
    fields: [...SETTINGS_FIELDS],
    limits: SETTINGS_LIMITS,
    dataDir: maskPath(deps.dataDir, { home: homeDir(), dataDir: deps.dataDir }),
    sharedRoot: {
      path: maskPath(shared.root, { home: homeDir(), dataDir: deps.dataDir }),
      source: shared.source,
      // `null`, not absent: `warn` above already uses null for "nothing to report", and
      // one spelling of that on this payload is cheaper than two.
      warn: shared.warning ?? null,
    },
    books: bookChoices(deps.ctx),
    // The page states the retention rule it is enforcing, so "why did my old backup
    // disappear" never needs a trip to the docs (D3).
    backupKeep: read.settings.backupKeep,
  }
}

/**
 * Apply a settings patch from the panel.
 *
 * `confirm` is the second half of the panel's own confirmation: the browser arms the
 * button, and this refuses without it, so a stray click cannot rewrite the file.
 */
export function writeHubSettings(deps: HubSettingsDeps, body: Json): HubReply<Json> {
  const patch: Json = {}
  for (const field of SETTINGS_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) patch[field] = body[field]
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, error: { code: 'NOTHING_TO_UPDATE', message: 'no settings field was given', hint: `pass at least one of ${SETTINGS_FIELDS.join(', ')}` } }
  }
  if (body['confirm'] !== true) {
    return {
      ok: false,
      error: {
        code: 'CONFIRM_REQUIRED',
        message: 'saving settings replaces the plugin settings file',
        hint: `confirm the ${Object.keys(patch).join(', ')} change; no book file is touched`,
      },
    }
  }
  const written = writeSettings(deps.dataDir, patch)
  if (!written.ok) return { ok: false, error: written.error }
  return {
    ok: true,
    value: {
      ...buildHubSettings(deps),
      // `buildHubSettings` re-reads the file, so the settings here are what the reader
      // will see; `changed`/`repaired` are the write's own facts.
      settings: written.value.settings,
      changed: written.value.changed,
      repaired: written.value.repaired,
      writeWarn: written.value.warn ?? null,
    },
  }
}

// ---------------------------------------------------------------------------
// Diagnostics (the anchor is optional: a broken book is worth reporting)
// ---------------------------------------------------------------------------

/** The tool table the package lists — the real one, built from this plugin's surface. */
function toolSurface(deps: HubSettingsDeps): ReturnType<typeof buildTools> {
  return buildTools({ ctx: deps.ctx, dataDir: deps.dataDir, version: deps.version })
}

export function buildHubDiagnostics(deps: HubSettingsDeps, anchor: unknown): HubReply<Json> {
  // A named-but-unresolvable book is not fatal: the plugin-wide package is still worth
  // exporting, and the reply says which part is missing.
  const book = trimmed(anchor) === undefined ? undefined : resolveHubBook(deps.ctx, anchor)
  const bookRoot = book !== undefined && book.ok ? book.value.root : undefined
  const document = buildDiagnostics({
    dataDir: deps.dataDir,
    version: deps.version,
    ...(bookRoot === undefined ? {} : { bookRoot }),
    tools: toolSurface(deps),
  })
  const stamp = backupStampZip(new Date())
  const path = `${deps.dataDir}/diagnostics/${stamp}.json`
  return {
    ok: true,
    value: {
      path: maskPath(path, { home: homeDir(), dataDir: deps.dataDir, ...(bookRoot === undefined ? {} : { bookRoot }) }),
      bytes: Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`, 'utf8'),
      summary: document.summary,
      book: bookRoot === undefined ? null : { slug: bookSlugOf(bookRoot) },
      bookProblem: book !== undefined && !book.ok ? book.error.code : null,
    },
  }
}

export function exportHubDiagnostics(deps: HubSettingsDeps, body: Json): HubReply<Json> {
  if (body['confirm'] !== true) {
    return {
      ok: false,
      error: {
        code: 'CONFIRM_REQUIRED',
        message: 'exporting writes a diagnostics package file',
        hint: 'the preview above is what would be written; confirm to write it',
      },
    }
  }
  const book = trimmed(body['book']) === undefined ? undefined : resolveHubBook(deps.ctx, body['book'])
  const bookRoot = book !== undefined && book.ok ? book.value.root : undefined
  const exported = exportDiagnostics({
    dataDir: deps.dataDir,
    version: deps.version,
    ...(bookRoot === undefined ? {} : { bookRoot }),
    tools: toolSurface(deps),
  })
  if (!exported.ok) return { ok: false, error: exported.error }
  return {
    ok: true,
    value: {
      path: maskPath(exported.value.path, { home: homeDir(), dataDir: deps.dataDir, ...(bookRoot === undefined ? {} : { bookRoot }) }),
      bytes: exported.value.bytes,
      summary: exported.value.document.summary,
      format: exported.value.document.format,
    },
  }
}

// ---------------------------------------------------------------------------
// Backups (one book per call)
// ---------------------------------------------------------------------------

function packageWire(pack: BackupPackage): Json {
  return { file: pack.file, stamp: pack.stamp, bytes: pack.bytes, entries: pack.entries, createdAt: pack.createdAt }
}

export function buildHubBackups(deps: HubSettingsDeps, anchor: unknown): HubReply<Json> {
  const book = resolveHubBook(deps.ctx, anchor)
  if (!book.ok) return { ok: false, error: book.error }
  const keep = readSettings(deps.dataDir).settings.backupKeep
  return {
    ok: true,
    value: {
      book: { workspaceId: book.value.workspaceId ?? null, bookSlug: book.value.slug, title: book.value.title },
      keep,
      backups: listBookBackups(deps.dataDir, book.value.slug).map(packageWire),
    },
  }
}

export function createHubBackup(deps: HubSettingsDeps, body: Json): HubReply<Json> {
  const book = resolveHubBook(deps.ctx, body['book'])
  if (!book.ok) return { ok: false, error: book.error }
  const settings = readSettings(deps.dataDir).settings
  const rawKeep = body['keep']
  const keep = typeof rawKeep === 'number' && Number.isFinite(rawKeep) ? rawKeep : settings.backupKeep
  if (body['confirm'] !== true) {
    return {
      ok: false,
      error: {
        code: 'CONFIRM_REQUIRED',
        message: `creating a backup writes a ZIP of this book into the plugin data directory and keeps ${String(keep)} package(s)`,
        hint: 'the confirmation is the panel button; nothing has been written',
      },
    }
  }
  const created = createBookBackup(book.value.root, deps.dataDir, {
    includeTrash: body['includeTrash'] === true,
    excludeDirs: settings.excludeDirs,
    keep,
  })
  if (!created.ok) return { ok: false, error: created.error }
  return {
    ok: true,
    value: {
      book: { workspaceId: book.value.workspaceId ?? null, bookSlug: created.value.bookSlug, title: book.value.title },
      file: created.value.file,
      files: created.value.files,
      bytes: created.value.bytes,
      pruned: created.value.pruned,
      keep: Math.min(Math.max(Math.trunc(keep), 1), 50),
      backups: listBookBackups(deps.dataDir, created.value.bookSlug).map(packageWire),
    },
  }
}

/**
 * The per-file baseline the browser hands back on the execute call.
 *
 * Values are `sha256` strings, or `null` for "was absent". Anything else is dropped
 * rather than coerced: a baseline the Host cannot read must never become "no baseline".
 */
function expectedMap(raw: unknown): Record<string, string | null> {
  const record = asRecord(raw)
  if (record === undefined) return {}
  const out: Record<string, string | null> = {}
  for (const [path, value] of Object.entries(record)) {
    if (typeof value === 'string') out[path] = value
    else if (value === null) out[path] = null
  }
  return out
}

export function planHubRestore(deps: HubSettingsDeps, query: URLSearchParams): HubReply<Json> {
  const book = resolveHubBook(deps.ctx, query.get('book'))
  if (!book.ok) return { ok: false, error: book.error }
  const file = trimmed(query.get('file'))
  if (file === undefined) {
    return {
      ok: false,
      error: { code: 'FILE_REQUIRED', message: 'name a backup package to preview', hint: 'the backup list on this page is the set' },
    }
  }
  const planned = planRestore(book.value.root, deps.dataDir, book.value.slug, file)
  if (!planned.ok) return { ok: false, error: planned.error }
  return { ok: true, value: { book: { workspaceId: book.value.workspaceId ?? null, bookSlug: book.value.slug }, plan: planWire(planned.value) } }
}

function planWire(plan: RestorePlan): Json {
  return {
    file: plan.file,
    counts: plan.counts,
    // `current` is what the panel hands back as `expected`; the packaged digest is not
    // sent, because "what is on disk now" is the only baseline a restore compares with.
    entries: plan.entries.map((entry) => ({
      path: entry.path,
      action: entry.action,
      bytes: entry.bytes,
      current: entry.current,
    })),
    extra: plan.extra,
  }
}

export async function restoreHubBackup(deps: HubSettingsDeps, body: Json): Promise<HubReply<Json>> {
  const book = resolveHubBook(deps.ctx, body['book'])
  if (!book.ok) return { ok: false, error: book.error }
  const file = trimmed(body['file'])
  if (file === undefined) {
    return { ok: false, error: { code: 'FILE_REQUIRED', message: 'name a backup package to restore', hint: 'refresh the backup list' } }
  }
  if (body['confirm'] !== true) {
    return {
      ok: false,
      error: { code: 'CONFIRM_REQUIRED', message: 'restoring writes the package back over the book', hint: 'preview first, then confirm' },
    }
  }
  const restored = await restoreBookBackup(book.value.root, deps.dataDir, book.value.slug, file, { expected: expectedMap(body['expected']) })
  if (!restored.ok) {
    return {
      ok: false,
      error: {
        ...restored.error,
        ...(restored.error.code === 'BACKUP_CONFLICT'
          ? {
              hint: `${String(restored.error.restored?.length ?? 0)} file(s) were restored; the conflicted ones were left alone so newer work survives. Restore again to finish.`,
            }
          : {}),
      },
    }
  }
  return {
    ok: true,
    value: {
      book: { workspaceId: book.value.workspaceId ?? null, bookSlug: book.value.slug },
      file: restored.value.file,
      restored: restored.value.restored,
      unchanged: restored.value.unchanged,
      extra: restored.value.extra,
      index: restored.value.index,
      backups: listBookBackups(deps.dataDir, book.value.slug).map(packageWire),
    },
  }
}
