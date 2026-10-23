/**
 * The private panel channel's projection layer (ADR-0008, issue #18).
 *
 * This module answers one question and derives four read-only projections from
 * it: **which book does this browser request belong to?** The browser carries
 * nothing but a `sessionId` (ADR-0008 D4); the root directory is resolved here
 * from Host services, never from the request.
 *
 * Why the resolution lives here instead of `tools.ts`: the tool surface
 * resolves from `exec.agent` (a model-facing call always has one), while an
 * HTTP request has only a session id string. Both must reach the *same* gate
 * verdict and the *same* `actions[]` (ADR-0008 D5), so this module reuses
 * `inspectProject` / `findProjectRoot` / `projectLabel` instead of duplicating
 * the four-state logic.
 *
 * WRITE DISCIPLINE: nothing here writes. `inspectProject` is called with
 * `recreateIndexDir: false` (its only write path), the catalog is read through
 * the projection API, the index is opened `readOnly`, and the chapter file is
 * only read. A browser request must never repair, rebuild or scaffold a book —
 * that stays behind a tool call the user confirmed (ADR-0006 D3).
 */

import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type {
  HostContext,
  SessionsLike,
  SessionLike,
  WorkingDirectoryLike,
  WorkspaceRegistryLike,
} from './context.js'
import { getLoadedBuild, summarizeBuild } from './build-info.js'
import { readCatalog } from './catalog.js'
import type { CatalogChapter, CatalogVolume } from './catalog.js'
import {
  createChapter,
  deleteChapter,
  moveChapter,
  writeChapter,
} from './chapters.js'
import type { ChapterOpFailure, ChapterOpError, ChapterView } from './chapters.js'
import { INDEX_SCHEMA_VERSION, CHAPTER_STATUSES } from './conventions.js'
import { fingerprintProjectFile } from './file-cas.js'
import type { FileExpectation, FileFingerprint } from './file-cas.js'
import { parseMarkdown } from './frontmatter.js'
import { countChars, indexPaths, readIndexMeta } from './indexer.js'
import { ensureIndex } from './index-freshness.js'
import type { EnsureIndexResult } from './index-freshness.js'
import type { ProjectProbe, ProjectState } from './project.js'
import { findProjectRoot, inspectProject, isWithin, projectLabel, realpathLoose } from './project.js'

/** The internal prefix. Not an API: no version segment, no compatibility promise. */
export const INTERNAL_PREFIX = '/inkflow/internal'

/**
 * Upper bound for a request body.
 *
 * Why 1 MiB and not the 64 KiB this used to be (#115): a save carries a whole
 * chapter or a whole setting entry as ONE JSON string, and the ceiling counts the
 * serialised bytes, not the prose. Measured on a real book: a body with 20,000
 * Chinese characters serialises to ~70 KB, so a long chapter could not be saved at
 * all — the panel answered `413 payload-too-large` and stayed in the editor. 1 MiB
 * is ~350k Chinese characters: far beyond any single chapter, still a guard
 * against a local page pushing megabytes through a socket nobody reads. The value
 * is exported so the tests state the ceiling once instead of hard-coding it.
 */
export const MAX_INTERNAL_BODY_BYTES = 1024 * 1024

/** Where the client puts its session identity (query wins over header). */
export const SESSION_ID_PARAM = 'sessionId'
export const SESSION_ID_HEADER = 'x-inkflow-session'

/**
 * Parameter names that would let the caller name a directory. ADR-0008 D4
 * refuses them in query *and* body before any filesystem access.
 */
export const FORBIDDEN_PATH_PARAMS = ['root', 'path', 'cwd', 'workspace', 'projectRoot'] as const

/** Session ids seen from DSH are `session-<n>` / uuid-shaped; nothing exotic. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,200}$/

/** `{ok:true,value}` / `{ok:false,error}` bodies: plain JSON objects. */
export type JsonRecord = Record<string, unknown>

// ---------------------------------------------------------------------------
// Host service narrowing
//
// Every service is optional (ADR-0008 D4): a profile may lack the workspace
// registry, the session store or workingDirectory, and the chain then simply
// falls through to its next step. Shape checks keep a Host upgrade from turning
// a missing method into a thrown TypeError inside a request handler.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function asSessions(value: unknown): SessionsLike | undefined {
  const record = asRecord(value)
  if (record === undefined || typeof record['get'] !== 'function') return undefined
  return value as SessionsLike
}

function asWorkspaceRegistry(value: unknown): WorkspaceRegistryLike | undefined {
  const record = asRecord(value)
  if (record === undefined || typeof record['list'] !== 'function') return undefined
  return value as WorkspaceRegistryLike
}

function asWorkingDirectory(value: unknown): WorkingDirectoryLike | undefined {
  const record = asRecord(value)
  if (record === undefined || typeof record['get'] !== 'function') return undefined
  return value as WorkingDirectoryLike
}

// ---------------------------------------------------------------------------
// Session → project root (ADR-0008 D4)
// ---------------------------------------------------------------------------

/** Which link of the chain answered; reported so the panel can explain itself. */
export type SessionRootSource = 'workspace-registry' | 'working-directory' | 'session-header'

export interface SessionRoot {
  sessionId: string
  root: string
  source: SessionRootSource
}

/**
 * The two spellings a session id can arrive in.
 *
 * DSH stores a workspace's `sessionIds` with a `session-` prefix while the
 * session log and some protocol surfaces use the bare id (observed on
 * 0.2.1-rc.2: `~/.dsh/storages/workspace.json` lists `session-<uuid>`, the
 * session log header carries `<uuid>`). The channel must match either spelling
 * rather than report "no session" for a session that plainly exists.
 */
function sessionIdCandidates(sessionId: string): string[] {
  const prefix = 'session-'
  if (sessionId.startsWith(prefix)) {
    const bare = sessionId.slice(prefix.length)
    return bare === '' ? [sessionId] : [sessionId, bare]
  }
  return [sessionId, `${prefix}${sessionId}`]
}

/**
 * Resolve a session to the directory it belongs to, first hit wins:
 *
 *   1. `workspaceRegistry.list()` — a Workspace whose `sessionIds` contains the
 *      session. Its `path` is already `fs.realpath`-canonicalised by the host.
 *   2. `workingDirectory.get(sessions.get(sessionId))` — the committed,
 *      possibly-changed directory.
 *   3. `sessions.get(sessionId).header.cwd` — the creation-time directory.
 *
 * `undefined` means "cannot answer", which the caller turns into a structured
 * `NO_SESSION_CONTEXT` refusal. A plugin-wide remembered path is never a
 * substitute (that would report someone else's book as this session's project).
 */
export function resolveSessionRoot(ctx: HostContext, sessionId: string): SessionRoot | undefined {
  const candidates = sessionIdCandidates(sessionId)

  const registry = asWorkspaceRegistry(ctx.get('workspaceRegistry'))
  if (registry !== undefined) {
    for (const workspace of registry.list()) {
      const record = asRecord(workspace)
      if (record === undefined) continue
      const path = nonEmptyString(record['path'])
      const sessionIds = record['sessionIds']
      if (path === undefined || !Array.isArray(sessionIds)) continue
      if (candidates.some((candidate) => sessionIds.includes(candidate))) {
        return { sessionId, root: path, source: 'workspace-registry' }
      }
    }
  }

  const sessions = asSessions(ctx.get('sessions'))
  let session: SessionLike | undefined
  for (const candidate of candidates) {
    session = sessions?.get(candidate)
    if (session !== undefined) break
  }
  if (session === undefined) return undefined

  const workingDirectory = asWorkingDirectory(ctx.get('workingDirectory'))
  if (workingDirectory !== undefined) {
    try {
      const directory = nonEmptyString(workingDirectory.get(session))
      if (directory !== undefined) return { sessionId, root: directory, source: 'working-directory' }
    } catch {
      // A service that cannot answer must not decide the request: fall through.
    }
  }

  const created = nonEmptyString(session.header?.cwd)
  if (created !== undefined) return { sessionId, root: created, source: 'session-header' }
  return undefined
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export interface ChannelTarget {
  sessionId: string
  /** Project root: the resolved directory, walked up to the nearest book. */
  root: string
  source: SessionRootSource
  probe: ProjectProbe
}

export type ChannelResolution = { target: ChannelTarget } | { failure: JsonRecord }

/**
 * Same codes the tools return for the same state (ADR-0008 D5). Kept in one
 * place here rather than imported from `tools.ts`: that file's mapper is
 * module-private by design and the tool surface is being edited in parallel.
 */
function gateErrorCode(state: ProjectState): string {
  if (state === 'needs-newer-plugin') return 'PROJECT_NEEDS_NEWER_PLUGIN'
  if (state === 'needs-repair') return 'PROJECT_NEEDS_REPAIR'
  return 'NOT_AN_INKFLOW_PROJECT'
}

function gateHint(state: ProjectState): string {
  if (state === 'needs-newer-plugin') {
    return 'this book was written by a newer dsh-inkflow; tell the user to upgrade the plugin. Do not repair, rewrite or re-index it from this version.'
  }
  if (state === 'needs-repair') {
    return 'the book exists but is incomplete or damaged; run inkflow_project_plan for the exact list, show it to the user, then inkflow_project_init with confirm: true'
  }
  return 'an InkFlow project is a git repository with nine content directories (each carrying .gitkeep) plus index/ and inkflow.json; run inkflow_project_plan to see what would be created'
}

/** The structured four-state refusal, shaped like the tool-side checklist. */
export function gateFailureBody(sessionId: string, root: string, source: SessionRootSource, probe: ProjectProbe): JsonRecord {
  const state = probe.state
  return {
    ok: false,
    error: {
      code: gateErrorCode(state),
      state,
      message: `this directory is not a usable InkFlow project (state: ${state})`,
      needsSetup: state === 'needs-setup',
      needsRepair: state === 'needs-repair',
      readOnly: probe.readOnly,
      root: probe.root,
      sessionId,
      resolvedFrom: source,
      searchedFrom: 'session-workspace',
      checks: probe.checks,
      missing: probe.missing,
      actions: probe.actions,
      reasons: probe.reasons,
      ...(probe.metaError === undefined ? {} : { metaError: probe.metaError }),
      ...(probe.metaRaw === undefined ? {} : { metaRaw: probe.metaRaw }),
      hint: gateHint(state),
    },
  }
}

/**
 * The "cannot answer yet" refusal: HTTP 200 + `ok:false`. It is not a transport
 * failure, and it writes nothing — the book it would have named is unknown.
 */
export function noSessionContextBody(version: string, sessionId?: string): JsonRecord {
  return {
    ok: false,
    pluginVersion: version,
    error: {
      code: 'NO_SESSION_CONTEXT',
      ...(sessionId === undefined ? {} : { sessionId }),
      message: 'this request carries no session that maps to a workspace, so its project cannot be named',
      actions: [
        'open the InkFlow panel from a novel session (conversation.view) instead of a global page',
        'run inkflow_project_status in that session to see the project gate',
      ],
      hint: 'use the inkflow_* tools from the novel session; the panel only projects the book of its own session',
    },
  }
}

/**
 * Attach the loaded-build summary to a refusal envelope (issue #88).
 *
 * The stale-build banner has to render on the "needs setup" / "needs repair"
 * screens too: that screen is exactly what a stale generation shows for a book
 * that is in fact usable, so the summary must travel with the refusal and not
 * only with `value`. It goes under `error` (the envelope's payload half) so the
 * Client half keeps its `{ok,value|error}` shape.
 */
function withBuild(failure: JsonRecord, version: string): JsonRecord {
  const error = asRecord(failure['error'])
  if (error === undefined) return failure
  return { ...failure, error: { ...error, build: summarizeBuild(getLoadedBuild({ version })) } }
}

/**
 * Resolve the request's session to a usable project. `findProjectRoot` walks up
 * exactly like the tool surface, so a session opened in a chapter directory
 * still names its book (ADR-0006 D5).
 */
export function resolveChannelTarget(ctx: HostContext, sessionId: string, version: string): ChannelResolution {
  const resolved = resolveSessionRoot(ctx, sessionId)
  if (resolved === undefined) return { failure: withBuild(noSessionContextBody(version, sessionId), version) }

  const root = findProjectRoot(resolved.root) ?? resolved.root
  // `recreateIndexDir: false`: this is the one write `inspectProject` performs
  // (ADR-0006 D2 relaxation) and a browser request must not perform it.
  const probe = inspectProject(root, { recreateIndexDir: false })
  if (probe.usable !== true) {
    return { failure: withBuild(gateFailureBody(sessionId, root, resolved.source, probe), version) }
  }
  return { target: { sessionId, root: probe.root, source: resolved.source, probe } }
}

/** `session-<n>` / uuid shapes only: a session id is an identifier, not a path. */
export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value)
}

/** The first forbidden path parameter present in `values`, if any. */
export function findPathParam(values: Iterable<[string, string]>): string | undefined {
  const forbidden = new Set<string>(FORBIDDEN_PATH_PARAMS)
  for (const [key] of values) {
    if (forbidden.has(key)) return key
  }
  return undefined
}

/** Same check for a JSON body: only top-level keys can name a directory. */
export function findPathParamInBody(body: JsonRecord): string | undefined {
  const forbidden = new Set<string>(FORBIDDEN_PATH_PARAMS)
  for (const key of Object.keys(body)) {
    if (forbidden.has(key)) return key
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Projections (all read-only)
// ---------------------------------------------------------------------------

const SEARCH_REASON =
  'body full-text search arrives with the index v2 tree (issue #22); matches are limited to chapter ids, paths and titles'

function chapterNode(chapter: CatalogChapter): JsonRecord {
  return { id: chapter.chapterId, path: chapter.file, seq: chapter.seq ?? null, title: chapter.title }
}

interface ChapterEntry {
  chapter: CatalogChapter
  volume: CatalogVolume | undefined
}

/** Flatten the catalog projection into (chapter, volume) pairs. */
function chapterEntries(root: string): ChapterEntry[] {
  const catalog = readCatalog(root)
  const entries: ChapterEntry[] = []
  for (const [index, volume] of catalog.catalog.volumes.entries()) {
    for (const chapter of catalog.volumeCatalogs[index]?.chapters ?? []) entries.push({ chapter, volume })
  }
  for (const chapter of catalog.catalog.looseChapters) entries.push({ chapter, volume: undefined })
  return entries
}

/** `GET /status`: the gate verdict plus index/catalog summaries. */
export function buildStatus(target: ChannelTarget, version: string): JsonRecord {
  const index = readIndexMeta(target.root, target.probe)
  const catalog = readCatalog(target.root)
  const chapterCount = chapterEntries(target.root).length
  return {
    pluginVersion: version,
    sessionId: target.sessionId,
    resolvedFrom: target.source,
    root: target.root,
    label: projectLabel(target.probe),
    state: target.probe.state,
    usable: target.probe.usable,
    readOnly: target.probe.readOnly,
    checks: target.probe.checks,
    missing: target.probe.missing,
    actions: target.probe.actions,
    reasons: target.probe.reasons,
    meta: target.probe.meta ?? {},
    // Issue #89: a hand-written file with a GBK-misread title is a hint for the
    // panel, not a verdict on the book — `state`/`usable`/`readOnly` above stay
    // exactly what the gate said.
    ...(target.probe.titleSuspicious === true ? { titleSuspicious: true } : {}),
    index: {
      dbFile: index.dbFile,
      dbExists: index.dbExists,
      schemaVersion: index.schemaVersion ?? null,
      schemaMatches: index.schemaMatches,
      builtAt: index.builtAt ?? null,
      counts: index.counts,
    },
    catalog: {
      stale: catalog.catalogStale,
      staleFiles: catalog.staleFiles,
      volumes: catalog.catalog.volumes.length,
      chapters: chapterCount,
    },
    search: { available: false, scope: 'chapter-metadata', reason: SEARCH_REASON },
    // Issue #88: the panel's "is this build old?" banner. Read at call time, so a
    // rebuild while DSH is running makes the next `/status` answer "stale" and
    // only a restart makes it "fresh" again — refreshing cannot clear it.
    build: summarizeBuild(getLoadedBuild({ version })),
  }
}

/**
 * `GET /chapters`: the volume/chapter tree from the `.md` projection.
 *
 * The tree itself comes from the catalog (files → projection, always current),
 * but the index is made fresh first (issue #5) so that this call and a following
 * `/search` cannot answer from two different generations of the cache. A failed
 * rebuild is reported, never fatal: the projection still answers.
 */
export async function buildChapters(target: ChannelTarget, version: string): Promise<JsonRecord> {
  const ensured = await ensureIndex(target.root)
  const catalog = readCatalog(target.root)
  const volumes = catalog.catalog.volumes.map((volume, index) => ({
    volumeId: volume.volumeId,
    dir: volume.dir,
    title: volume.title,
    order: volume.order,
    chapters: (catalog.volumeCatalogs[index]?.chapters ?? []).map(chapterNode),
  }))
  const looseChapters = catalog.catalog.looseChapters.map(chapterNode)
  const total = volumes.reduce((sum, volume) => sum + volume.chapters.length, 0) + looseChapters.length
  return {
    pluginVersion: version,
    sessionId: target.sessionId,
    root: target.root,
    total,
    volumes,
    looseChapters,
    catalogStale: catalog.catalogStale,
    staleFiles: catalog.staleFiles,
    indexBuilt: ensured.ok,
    indexRebuilt: ensured.rebuilt,
    indexState: ensured.state,
    ...indexFailureOf(ensured),
  }
}

/** The freshness/build failure a panel response carries (never a throw). */
function indexFailureOf(ensured: EnsureIndexResult): JsonRecord {
  if (ensured.ok) return {}
  return {
    indexError: {
      code: ensured.failure.code,
      errno: ensured.failure.errno,
      message: ensured.failure.message,
    },
    indexReasons: ensured.freshness.reasons,
  }
}

/**
 * Read one chapter file, refusing anything outside `chapters/`.
 *
 * The catalog only ever lists project-relative `.md` files, so this containment
 * check is the second net (a symlinked chapter or a crafted id must not turn the
 * channel into an arbitrary-file reader).
 */
function readChapterFile(root: string, relativePath: string): string | undefined {
  if (extname(relativePath).toLowerCase() !== '.md') return undefined
  const chaptersDir = realpathLoose(join(root, 'chapters'))
  const absolute = realpathLoose(join(root, relativePath))
  if (!isWithin(chaptersDir, absolute)) return undefined
  try {
    // UTF-8, tolerating a BOM the way every other reader in this project does.
    return readFileSync(absolute, 'utf8').replace(/^\uFEFF/u, '')
  } catch {
    return undefined
  }
}

/** The chapter status the domain accepts, defaulting the way the indexer does. */
function chapterStatusOf(data: Record<string, unknown>): string {
  const status = data['status']
  return typeof status === 'string' && (CHAPTER_STATUSES as readonly string[]).includes(status) ? status : 'draft'
}

/** `GET /chapters/:id`: frontmatter + body of one chapter. */
export function buildChapter(target: ChannelTarget, version: string, rawId: string): JsonRecord | undefined {
  const id = rawId.trim()
  if (id === '') return undefined
  const entries = chapterEntries(target.root)
  const entry =
    entries.find((candidate) => candidate.chapter.chapterId === id) ??
    entries.find((candidate) => candidate.chapter.file === id)
  if (entry === undefined) return undefined
  const text = readChapterFile(target.root, entry.chapter.file)
  if (text === undefined) return undefined
  const parsed = parseMarkdown(text)
  return {
    pluginVersion: version,
    sessionId: target.sessionId,
    root: target.root,
    id: entry.chapter.chapterId,
    path: entry.chapter.file,
    title: entry.chapter.title,
    seq: entry.chapter.seq ?? null,
    volumeId: entry.volume?.volumeId ?? null,
    hasFrontmatter: parsed.hasFrontmatter,
    frontmatter: parsed.data,
    status: chapterStatusOf(parsed.data),
    body: parsed.body,
    bodyChars: countChars(parsed.body),
    issues: parsed.issues,
    // The CAS baseline for the next save (issue #19): the editor reads a chapter,
    // edits it, and writes back against exactly these bytes. Without it the
    // browser could not tell "the file changed under me" from "my own save".
    fingerprint: fingerprintProjectFile(target.root, entry.chapter.file) ?? null,
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`)
}

/**
 * Search the derived index's `chapters` table. `undefined` means "the index
 * cannot answer" (missing, foreign schema, unreadable) — the caller then falls
 * back to the catalog projection instead of showing an error.
 */
function searchIndex(root: string, query: string, limit: number): JsonRecord[] | undefined {
  const paths = indexPaths(root)
  if (!existsSync(paths.dbFile)) return undefined
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(paths.dbFile, { readOnly: true })
    const version = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    if (version?.user_version !== INDEX_SCHEMA_VERSION) return undefined
    const pattern = `%${escapeLike(query)}%`
    const rows = db
      .prepare(
        "SELECT id, path, seq, title, volume, status, word_count FROM chapters WHERE id LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' ORDER BY seq IS NULL, seq, path LIMIT ?",
      )
      .all(pattern, pattern, pattern, limit) as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      kind: 'chapter',
      id: String(row['id']),
      path: String(row['path']),
      seq: typeof row['seq'] === 'number' ? row['seq'] : null,
      title: String(row['title']),
      volume: typeof row['volume'] === 'string' ? row['volume'] : null,
      status: typeof row['status'] === 'string' ? row['status'] : null,
      wordCount: typeof row['word_count'] === 'number' ? row['word_count'] : null,
    }))
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

/** Catalog-backed fallback: metadata only, so `status`/`wordCount` stay null. */
function searchCatalog(root: string, query: string, limit: number): JsonRecord[] {
  const needle = query.toLowerCase()
  const hits: JsonRecord[] = []
  for (const entry of chapterEntries(root)) {
    const { chapter, volume } = entry
    const matches =
      chapter.chapterId.toLowerCase().includes(needle) ||
      chapter.file.toLowerCase().includes(needle) ||
      chapter.title.toLowerCase().includes(needle)
    if (!matches) continue
    hits.push({
      kind: 'chapter',
      id: chapter.chapterId,
      path: chapter.file,
      seq: chapter.seq ?? null,
      title: chapter.title,
      volume: volume?.volumeId ?? null,
      status: null,
      wordCount: null,
    })
    if (hits.length >= limit) break
  }
  return hits
}

/**
 * `GET /search?q=`: chapter metadata search.
 *
 * Issue #5: the index is made fresh first, so the panel cannot show a chapter
 * list built from the files while searching an index from a previous
 * generation. If the rebuild is refused (another process holds the lock, say),
 * the old cache — or the catalog projection — still answers and the response
 * says why in `indexError`.
 */
export async function buildSearch(target: ChannelTarget, version: string, query: string, limit = 50): Promise<JsonRecord> {
  const ensured = await ensureIndex(target.root)
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 200)
  const results = searchIndex(target.root, query, bounded) ?? searchCatalog(target.root, query, bounded)
  return {
    pluginVersion: version,
    sessionId: target.sessionId,
    root: target.root,
    query,
    total: results.length,
    results,
    searchUnavailable: true,
    searchScope: 'chapter-metadata',
    reason: SEARCH_REASON,
    indexRebuilt: ensured.rebuilt,
    indexState: ensured.state,
    ...indexFailureOf(ensured),
  }
}

// ---------------------------------------------------------------------------
// Write routes (issue #19): the panel editor's save path
//
// These are the only places in this module that change the truth files, and
// they do it the same way a tool does: through `chapters.ts`, which owns the
// write lock, the atomic replace, the catalog rebuild and `commitIndex`. The
// channel adds nothing but HTTP semantics and the CAS plumbing (issue #5), so
// there is exactly one writer implementation in the plugin.
//
// The HTTP vocabulary is declared per route (ADR-0008 D3): request problems are
// 400/413/415, an unknown chapter is 404, a stale baseline or a taken name is
// 409 (`FILE_CHANGED` above all), and everything else is 500 with the domain
// code kept intact so a bug stays diagnosable.
// ---------------------------------------------------------------------------

/** HTTP answer of a write route: the route layer only sends it. */
export interface WriteReply {
  status: number
  body: JsonRecord
}

export interface WriteRequest {
  target: ChannelTarget
  /** Percent-encoded `pattern` captures; `params[0]` is the chapter id. */
  params: readonly string[]
  body: JsonRecord
  version: string
}

type FieldRead<T> = { ok: true; value: T } | { ok: false; reply: WriteReply }

/** 400 for one malformed field: the caller named something unusable. */
function badField(field: string, expected: string): WriteReply {
  return {
    status: 400,
    body: { ok: false, error: { code: 'invalid-field', field, hint: `\`${field}\` must be ${expected}` } },
  }
}

function invalidExpected(field: string): WriteReply {
  return {
    status: 400,
    body: {
      ok: false,
      error: { code: 'EXPECTED_INVALID', field, hint: 'expected must be an object: { sha256?, size?, mtimeMs?, absent? }' },
    },
  }
}

/** A declared field: absent/`null` is "not set", any other type is a 400. */
function optionalText(body: JsonRecord, key: string): FieldRead<string | undefined> {
  const value = body[key]
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== 'string') return { ok: false, reply: badField(key, 'a string') }
  return { ok: true, value }
}

function requiredText(body: JsonRecord, key: string): FieldRead<string> {
  const value = body[key]
  // Only the TYPE is checked here: an empty title is the domain's `TITLE_REQUIRED`
  // (400 with the code a tool caller already knows), not a channel field error.
  if (typeof value !== 'string') return { ok: false, reply: badField(key, 'a string') }
  return { ok: true, value }
}

/** `volumeId` is `vol-NN`, or `null` for "no volume" (a loose chapter). */
function optionalVolumeId(body: JsonRecord): FieldRead<string | null | undefined> {
  const value = body['volumeId']
  if (value === undefined) return { ok: true, value: undefined }
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, reply: badField('volumeId', 'a `vol-NN` string or null') }
  return { ok: true, value }
}

function optionalSeq(body: JsonRecord): FieldRead<number | undefined> {
  const value = body['seq']
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, reply: badField('seq', 'an integer') }
  return { ok: true, value }
}

/**
 * The CAS baseline (§5.5). Absent means "write regardless" — which is exactly
 * what the panel's explicit "仍要保存（覆盖）" sends, so the only way a conflict
 * is ever overwritten is a user pressing that button.
 */
function readExpected(body: JsonRecord): FieldRead<FileExpectation | undefined> {
  const raw = body['expected']
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reply: invalidExpected('expected') }
  const record = raw as JsonRecord
  const allowed = new Set(['sha256', 'size', 'mtimeMs', 'absent'])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return { ok: false, reply: invalidExpected(`expected.${key}`) }
  }
  const expected: FileExpectation = {}
  if (record['sha256'] !== undefined) {
    if (typeof record['sha256'] !== 'string') return { ok: false, reply: invalidExpected('expected.sha256') }
    expected.sha256 = record['sha256'].trim().toLowerCase()
  }
  if (record['size'] !== undefined) {
    if (typeof record['size'] !== 'number' || !Number.isFinite(record['size'])) {
      return { ok: false, reply: invalidExpected('expected.size') }
    }
    expected.size = record['size']
  }
  if (record['mtimeMs'] !== undefined) {
    if (typeof record['mtimeMs'] !== 'number' || !Number.isFinite(record['mtimeMs'])) {
      return { ok: false, reply: invalidExpected('expected.mtimeMs') }
    }
    expected.mtimeMs = record['mtimeMs']
  }
  if (record['absent'] === true) expected.absent = true
  return { ok: true, value: expected }
}

/** An id capture, percent-decoded; `undefined` means "malformed encoding". */
function decodeParam(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  try {
    const id = decodeURIComponent(raw).trim()
    return id === '' ? undefined : id
  } catch {
    return undefined
  }
}

/**
 * `:id` addresses a chapter by id **or** by project-relative path, exactly like
 * `GET /chapters/:id`. `chapters.ts` wants the two apart.
 */
function chapterSelector(id: string): { chapterId?: string; file?: string } {
  const normalized = id.replaceAll('\\', '/').replace(/^\.\//u, '')
  const lower = normalized.toLowerCase()
  if (lower.startsWith('chapters/') && lower.endsWith('.md')) return { file: normalized }
  return { chapterId: id }
}

/** `CHAPTER_NOT_FOUND` reaches the wire in the read route's spelling. */
const WIRE_CODES: Record<string, string> = {
  CHAPTER_NOT_FOUND: 'chapter-not-found',
  VOLUME_NOT_FOUND: 'volume-not-found',
}

const BAD_REQUEST_CODES = new Set([
  'TITLE_REQUIRED',
  'STATUS_INVALID',
  'SEQ_INVALID',
  'FILE_INVALID',
  'SLUG_INVALID',
  'VOLUME_ID_INVALID',
  'CHAPTER_SELECTOR_REQUIRED',
])

const CONFLICT_CODES = new Set([
  'CHAPTER_EXISTS',
  'CHAPTER_AMBIGUOUS',
  'CHAPTER_SELECTOR_CONFLICT',
  'SEQ_CONFLICT',
  'TARGET_EXISTS',
  'VOLUME_EXISTS',
  'PROJECT_BUSY',
  // The recovery bin refused the move because that path already owns a slot in it
  // (PR #123 review B1): a state conflict, not a server fault.
  'TRASH_ENTRY_EXISTS',
])

const FILE_CHANGED_HINT =
  'the file changed on disk since you read it: reload it (discarding your edits) or save again without `expected` to overwrite'

/**
 * Domain failure → HTTP answer.
 *
 * `FILE_CHANGED` is the one that matters to the editor: it carries `expected`,
 * `current` and `changed[]` so the panel can say *what* moved, and it is
 * guaranteed to have written nothing (§5.5).
 */
function chapterFailureReply(failure: ChapterOpFailure): WriteReply {
  const error: ChapterOpError = failure.error
  const code = WIRE_CODES[error.code] ?? error.code
  const detail: JsonRecord = { code, message: error.message }
  if (error.path !== undefined) detail['path'] = error.path
  if (error.hint !== undefined) detail['hint'] = error.hint
  if (error.rolledBack !== undefined) detail['rolledBack'] = error.rolledBack
  if (error.rollback !== undefined) detail['rollback'] = error.rollback
  if (error.io !== undefined) detail['io'] = error.io
  if (error.nothingWritten !== undefined) detail['nothingWritten'] = error.nothingWritten

  if (error.code === 'FILE_CHANGED') {
    detail['expected'] = error.expected ?? null
    detail['current'] = error.current ?? null
    detail['changed'] = error.changed ?? []
    detail['nothingWritten'] = true
    if (detail['hint'] === undefined) detail['hint'] = FILE_CHANGED_HINT
    return { status: 409, body: { ok: false, error: detail } }
  }
  if (error.code === 'CHAPTER_NOT_FOUND' || error.code === 'VOLUME_NOT_FOUND') {
    return { status: 404, body: { ok: false, error: detail } }
  }
  if (BAD_REQUEST_CODES.has(error.code)) return { status: 400, body: { ok: false, error: detail } }
  if (CONFLICT_CODES.has(error.code)) return { status: 409, body: { ok: false, error: detail } }
  return { status: 500, body: { ok: false, error: detail } }
}

/** The successful value of a write: the chapter as it is now, plus its baseline. */
function writeValue(target: ChannelTarget, version: string, chapter: ChapterView, extra: JsonRecord): WriteReply {
  const fingerprint: FileFingerprint | undefined = fingerprintProjectFile(target.root, chapter.file)
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: target.sessionId,
        root: target.root,
        chapter,
        fingerprint: fingerprint ?? null,
        ...extra,
      },
    },
  }
}

/** `POST /chapters`: create a chapter (title is the only required field). */
export async function createChapterViaChannel(request: WriteRequest): Promise<WriteReply> {
  const title = requiredText(request.body, 'title')
  if (!title.ok) return title.reply
  const volumeId = optionalVolumeId(request.body)
  if (!volumeId.ok) return volumeId.reply
  const slug = optionalText(request.body, 'slug')
  if (!slug.ok) return slug.reply
  const seq = optionalSeq(request.body)
  if (!seq.ok) return seq.reply

  const result = await createChapter(request.target.root, {
    title: title.value,
    volumeId: volumeId.value,
    slug: slug.value,
    seq: seq.value,
  })
  if (!result.ok) return chapterFailureReply(result)
  return writeValue(request.target, request.version, result.chapter, {
    catalogRebuilt: result.catalogRebuilt,
    indexRebuilt: result.indexRebuilt,
    ...(result.indexError === undefined ? {} : { indexError: result.indexError }),
  })
}

/** `POST /chapters/:id`: change title/body/status against a CAS baseline. */
export async function writeChapterViaChannel(request: WriteRequest): Promise<WriteReply> {
  const id = decodeParam(request.params[0])
  if (id === undefined) return { status: 400, body: { ok: false, error: { code: 'invalid-path-encoding' } } }
  const title = optionalText(request.body, 'title')
  if (!title.ok) return title.reply
  const body = optionalText(request.body, 'body')
  if (!body.ok) return body.reply
  const status = optionalText(request.body, 'status')
  if (!status.ok) return status.reply
  const expected = readExpected(request.body)
  if (!expected.ok) return expected.reply

  if (title.value === undefined && body.value === undefined && status.value === undefined) {
    return {
      status: 400,
      body: { ok: false, error: { code: 'invalid-field', field: 'body', hint: 'pass at least one of title, body, status' } },
    }
  }

  const result = await writeChapter(request.target.root, {
    ...chapterSelector(id),
    title: title.value,
    body: body.value,
    status: status.value,
    expected: expected.value,
  })
  if (!result.ok) return chapterFailureReply(result)
  return writeValue(request.target, request.version, result.chapter, {
    changed: result.changed,
    ...(result.renamedFrom === undefined ? {} : { renamedFrom: result.renamedFrom }),
    catalogRebuilt: result.catalogRebuilt,
    indexRebuilt: result.indexRebuilt,
    ...(result.indexError === undefined ? {} : { indexError: result.indexError }),
  })
}

/** `POST /chapters/:id/move`: move between volumes (or out of every volume). */
export async function moveChapterViaChannel(request: WriteRequest): Promise<WriteReply> {
  const id = decodeParam(request.params[0])
  if (id === undefined) return { status: 400, body: { ok: false, error: { code: 'invalid-path-encoding' } } }
  const volumeId = optionalVolumeId(request.body)
  if (!volumeId.ok) return volumeId.reply
  if (volumeId.value === undefined) {
    // Required on purpose: `undefined` and `null` both mean "loose chapter" in
    // the domain layer, so a missing field would silently move the chapter out
    // of its volume.
    return { status: 400, body: { ok: false, error: { code: 'invalid-field', field: 'volumeId', hint: 'pass a volume id or null for "no volume"' } } }
  }
  const expected = readExpected(request.body)
  if (!expected.ok) return expected.reply

  const result = await moveChapter(request.target.root, {
    ...chapterSelector(id),
    volumeId: volumeId.value,
    expected: expected.value,
  })
  if (!result.ok) return chapterFailureReply(result)
  return writeValue(request.target, request.version, result.chapter, {
    moved: result.moved,
    movedFrom: result.movedFrom,
    changed: result.changed,
    catalogRebuilt: result.catalogRebuilt,
    indexRebuilt: result.indexRebuilt,
    ...(result.indexError === undefined ? {} : { indexError: result.indexError }),
  })
}

/** `DELETE /chapters/:id`: delete one chapter against a CAS baseline. */
export async function deleteChapterViaChannel(request: WriteRequest): Promise<WriteReply> {
  const id = decodeParam(request.params[0])
  if (id === undefined) return { status: 400, body: { ok: false, error: { code: 'invalid-path-encoding' } } }
  const expected = readExpected(request.body)
  if (!expected.ok) return expected.reply

  const result = await deleteChapter(request.target.root, {
    ...chapterSelector(id),
    expected: expected.value,
  })
  if (!result.ok) return chapterFailureReply(result)
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: request.version,
        sessionId: request.target.sessionId,
        root: request.target.root,
        deleted: result.deleted,
        // #35: the delete is reversible, so the wire says where the copy went.
        trashed: result.trashed,
        catalogRebuilt: result.catalogRebuilt,
        indexRebuilt: result.indexRebuilt,
        ...(result.indexError === undefined ? {} : { indexError: result.indexError }),
      },
    },
  }
}

// ---------------------------------------------------------------------------
// The setting library (issue #30, roadmap X-7 / X-8)
//
// X-8 puts these payloads in this issue rather than in a view registry. The two
// readers live in `library-view.ts` and the single writer in `library-write.ts`;
// both are re-exported here so the channel keeps ONE entry point for `routes.ts`
// (this file already carries the session chain, five projections and the four
// chapter write routes — AGENTS.md §10.5: no 1000-line grab bag).
//
// The three read builders open the index `readOnly` and write nothing. The one
// writer changes a truth file through `io.ts` (atomic replace + write lock +
// path whitelist) and then invalidates the derived index.
// ---------------------------------------------------------------------------

export {
  LIBRARY_KINDS,
  LIBRARY_KIND_LIMIT,
  LIBRARY_ISSUE_LIMIT,
  buildLibrary,
  buildLibraryItem,
  buildLibraryIssues,
} from './library-view.js'
export type { LibraryIssueRow, LibraryItemReply, LibraryItemRow, LibrarySource } from './library-view.js'
export { LIBRARY_WRITE_BODY_FIELDS } from './library-request.js'
export { writeLibraryItem } from './library-write.js'
export type { LibraryWriteRequest } from './library-write.js'

/**
 * 影响面与改名（#34, conventions §5.6): re-exported only, never implemented here.
 *
 * The listing and the rename write live in `impact.ts` / `impact-write.ts` — this
 * file already carries the session chain and the library projections, and the two
 * new routes need exactly the same `{sessionId, root}` target as the library ones
 * and nothing else from it.
 */
export { IMPACT_KINDS, buildImpact } from './impact.js'
export type { ImpactReply, ImpactRequest, ImpactSource } from './impact.js'
export { RENAME_BODY_FIELDS, renameEntity } from './impact-write.js'
export type { RenameRequest } from './impact-write.js'
// The recovery bin (#35): the domain lives in `trash.ts` (imported by
// `chapters.ts` as well), the three channel replies in `trash-channel.ts`. Both
// are re-exported here so `routes.ts` keeps ONE entry point for the channel.
export {
  TRASH_PURGE_BODY_FIELDS,
  TRASH_RESTORE_BODY_FIELDS,
  purgeTrashReply,
  restoreTrashReply,
  trashListReply,
} from './trash-channel.js'
export type { TrashReply, TrashSource } from './trash-channel.js'
