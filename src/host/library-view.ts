/**
 * The setting library's panel projections (issue #30, roadmap X-7 / X-8).
 *
 * X-7 fixes the shape: the tree's top level is `CONTENT_DIRS` minus `chapters`
 * (8 kinds — the chapter tree belongs to the workbench, M13), and 地点 is a
 * `world/<category>` bucket rather than a kind of its own. X-8 fixes that the
 * payload belongs to this issue; the channel still has ONE entry point, because
 * `internal.ts` re-exports the three builders below.
 *
 * Why a separate module: `internal.ts` already carries the session chain, five
 * projections and the four write routes. A read-only payload layer that touches
 * nothing else is easier to keep honest on its own (AGENTS.md §10.5).
 *
 * READ DISCIPLINE: nothing here writes. `ensureIndex` is the one exception the
 * read routes are allowed (a rebuildable cache inside a `usable` project,
 * conventions §6.2 / issue #5) — the same call `/chapters` and `/search` make,
 * so a fresh book does not show an empty library until the chapter tab is
 * opened. The entity file is only READ, through `parseMarkdown` (BOM/CRLF
 * tolerant, the same reader the indexer uses).
 *
 * "Cannot answer" is not "empty": `listEntities` answers `undefined` when the
 * index is absent or built by another schema, and the tree then says
 * `indexAvailable: false` instead of claiming the book has no characters.
 */

import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { CHAPTERS_DIR, CONTENT_DIRS, INDEX_SCHEMA_VERSION } from './conventions.js'
import type { ContentDir } from './conventions.js'
import { entityFromRow } from './domains/entities.js'
import { listEntities } from './domains/query.js'
import type { EntitySummary } from './domains/query.js'
import { countChars } from './domains/scan-helpers.js'
import { fingerprintProjectFile } from './file-cas.js'
import { parseMarkdown } from './frontmatter.js'
import { ensureIndex } from './index-freshness.js'
import type { EnsureIndexResult } from './index-freshness.js'
import { indexPaths } from './indexer.js'
import { isWithin, realpathLoose } from './project.js'

/** A plain JSON payload, the channel's envelope half (`{ok,value|error}`). */
type JsonRecord = Record<string, unknown>

/**
 * The two fields every payload here needs. `ChannelTarget` satisfies it, and
 * typing it this narrowly keeps this module from importing back into the
 * channel layer it is re-exported from.
 */
export interface LibrarySource {
  sessionId: string
  root: string
}

/** Top-level groups the tree shows: X-7 = `CONTENT_DIRS` minus `chapters`. */
export const LIBRARY_KINDS: readonly ContentDir[] = CONTENT_DIRS.filter((dir) => dir !== CHAPTERS_DIR)

/**
 * Per-kind row cap. `listEntities` clamps to the same 500, and the group says
 * `truncated: true` when it was reached — never a silently short list.
 */
export const LIBRARY_KIND_LIMIT = 500

/** Cap for the problem panel: an index full of issues still answers quickly. */
export const LIBRARY_ISSUE_LIMIT = 500

/** How many issues ride along with one item's detail. */
const ITEM_ISSUE_LIMIT = 20

/** X-7: the one kind whose rows group by `category` (**not** a kind of its own). */
const WORLD_KIND: ContentDir = 'world'

/** The wire shape of one tree row: what the panel needs to address a file. */
export interface LibraryItemRow {
  id: string
  path: string
  title: string
  category: string | null
  parent: string | null
  status: string | null
  orderIndex: number | null
}

/** One `validation_issues` row as the problem panel reads it. */
export interface LibraryIssueRow {
  code: string
  path: string | null
  detail: string
}

/** A read route that may also refuse (`routes.ts`'s `RouteReply` minus headers). */
export interface LibraryItemReply {
  status: number
  body: JsonRecord
}

function ok(value: JsonRecord): JsonRecord {
  return { ok: true, value }
}

function refused(code: string, extra: JsonRecord = {}): JsonRecord {
  return { ok: false, error: { code, ...extra } }
}

/**
 * The degradation fields `/chapters` already carries, spelled the same way so
 * the client reads one shape. Kept local rather than imported from
 * `internal.ts`: that file imports this one, and the reverse edge would be a
 * runtime cycle for eight lines of field names.
 */
function indexDegradation(ensured: EnsureIndexResult): JsonRecord {
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

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function libraryItem(entity: EntitySummary): LibraryItemRow {
  return {
    id: entity.id,
    path: entity.path,
    title: entity.title,
    category: entity.category ?? null,
    parent: entity.parent ?? null,
    status: entity.status ?? null,
    orderIndex: entity.orderIndex ?? null,
  }
}

/**
 * `world/<category>/` → one bucket per category, named categories first in
 * storage order, the uncategorised rows last (they are a real editorial state:
 * a file written directly under `world/`).
 */
function worldCategories(items: readonly LibraryItemRow[]): JsonRecord[] {
  const buckets = new Map<string, LibraryItemRow[]>()
  for (const item of items) {
    const key = item.category ?? ''
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [item])
    else bucket.push(item)
  }
  const named = [...buckets.keys()].filter((key) => key !== '').sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  const keys = buckets.has('') ? [...named, ''] : named
  return keys.map((key) => ({
    category: key === '' ? null : key,
    total: buckets.get(key)?.length ?? 0,
    items: buckets.get(key) ?? [],
  }))
}

/**
 * `GET /inkflow/internal/library`: the eight-kind tree.
 *
 * One `listEntities` call per kind rather than one call for everything: the
 * projection is capped per query, so a single 500-row answer would truncate the
 * book's largest kinds and hide the rest behind them.
 */
export async function buildLibrary(source: LibrarySource, version: string): Promise<JsonRecord> {
  const ensured = await ensureIndex(source.root)
  const byKind = new Map<ContentDir, EntitySummary[]>()
  let indexAvailable = true
  for (const kind of LIBRARY_KINDS) {
    const rows = listEntities(source.root, { kind, limit: LIBRARY_KIND_LIMIT })
    if (rows === undefined) indexAvailable = false
    byKind.set(kind, rows ?? [])
  }

  const kinds = LIBRARY_KINDS.map((kind) => {
    const items = (byKind.get(kind) ?? []).map(libraryItem)
    const group: JsonRecord = {
      kind,
      total: items.length,
      truncated: items.length >= LIBRARY_KIND_LIMIT,
      items,
    }
    if (kind === WORLD_KIND) group['categories'] = worldCategories(items)
    return group
  })

  return {
    pluginVersion: version,
    sessionId: source.sessionId,
    root: source.root,
    indexAvailable,
    kinds,
    total: kinds.reduce((sum, group) => sum + Number(group['total'] ?? 0), 0),
    indexRebuilt: ensured.rebuilt,
    indexState: ensured.state,
    ...indexDegradation(ensured),
  }
}

type RowLookup = { ok: true; row: Record<string, unknown> | undefined } | { ok: false }

/**
 * The projection row for one `(kind, id)`, read straight from the cache.
 *
 * Not `listEntities(...).find(...)`: that is capped at 500 rows per kind, so a
 * large kind would answer "not found" for a row that exists. The index is
 * opened `readOnly` and a foreign `user_version` reads as "cannot answer"
 * (ADR-0005: a cache is never migrated).
 */
function readEntityRow(root: string, kind: string, id: string): RowLookup {
  const paths = indexPaths(root)
  if (!existsSync(paths.dbFile)) return { ok: false }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(paths.dbFile, { readOnly: true })
    const version = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    if (version?.user_version !== INDEX_SCHEMA_VERSION) return { ok: false }
    const row = db
      .prepare(
        'SELECT kind, id, path, title, name_key, category, parent, order_index, status, keywords, aliases FROM entities WHERE kind = ? AND id = ?',
      )
      .get(kind, id) as Record<string, unknown> | undefined
    return { ok: true, row }
  } catch {
    return { ok: false }
  } finally {
    db?.close()
  }
}

/**
 * Read one entity file, refusing anything outside its own content directory.
 *
 * The projection only ever lists files under the nine content directories, so
 * this containment check is the second net: a crafted id or a symlink must not
 * turn the channel into an arbitrary-file reader (same rule as
 * `readChapterFile`, generalised over the kind).
 */
function readEntityFile(root: string, kind: string, relativePath: string): string | undefined {
  if (extname(relativePath).toLowerCase() !== '.md') return undefined
  const base = realpathLoose(join(root, kind))
  const absolute = realpathLoose(join(root, relativePath))
  if (!isWithin(base, absolute)) return undefined
  try {
    // UTF-8, tolerating a BOM the way every reader in this project does.
    return readFileSync(absolute, 'utf8').replace(/^\uFEFF/u, '')
  } catch {
    return undefined
  }
}

type IssueLookup = { ok: true; rows: LibraryIssueRow[] } | { ok: false }

/** `validation_issues`, optionally narrowed to one file path. */
function readValidationIssues(root: string, options: { path?: string; limit: number }): IssueLookup {
  const paths = indexPaths(root)
  if (!existsSync(paths.dbFile)) return { ok: false }
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(paths.dbFile, { readOnly: true })
    const version = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    if (version?.user_version !== INDEX_SCHEMA_VERSION) return { ok: false }
    const statement =
      options.path === undefined
        ? db.prepare('SELECT code, path, detail FROM validation_issues ORDER BY seq LIMIT ?')
        : db.prepare('SELECT code, path, detail FROM validation_issues WHERE path = ? ORDER BY seq LIMIT ?')
    const rows = (
      options.path === undefined ? statement.all(options.limit) : statement.all(options.path, options.limit)
    ) as unknown as Array<Record<string, unknown>>
    return {
      ok: true,
      rows: rows.map((row) => ({
        code: String(row['code'] ?? ''),
        path: text(row['path']),
        detail: String(row['detail'] ?? ''),
      })),
    }
  } catch {
    return { ok: false }
  } finally {
    db?.close()
  }
}

/**
 * `GET /library/item?kind=&id=` — one entry, read-only.
 *
 * The read half of the editor pair: it answers the projection row plus the
 * frontmatter and body the file itself carries (so the pane shows what the
 * author wrote, not a copy of the index) and the `fingerprint` the save sends
 * back as `expected`. Saving is `POST /library/item`, implemented in
 * `library-write.ts` — this module still writes nothing.
 */
export async function buildLibraryItem(
  source: LibrarySource,
  version: string,
  rawKind: string,
  rawId: string,
): Promise<LibraryItemReply> {
  const kind = rawKind.trim()
  const id = rawId.trim()
  if (kind === '') {
    return {
      status: 400,
      body: refused('KIND_REQUIRED', { param: 'kind', hint: `pass ?kind=<one of ${LIBRARY_KINDS.join(', ')}>` }),
    }
  }
  if (!(LIBRARY_KINDS as readonly string[]).includes(kind)) {
    return {
      status: 400,
      body: refused('KIND_INVALID', { param: 'kind', value: kind, allowed: LIBRARY_KINDS }),
    }
  }
  if (id === '') {
    return { status: 400, body: refused('ID_REQUIRED', { param: 'id', hint: 'pass ?id=<entity id from the tree>' }) }
  }

  await ensureIndex(source.root)
  const lookup = readEntityRow(source.root, kind, id)
  if (!lookup.ok) {
    return {
      status: 200,
      body: refused('INDEX_UNAVAILABLE', {
        kind,
        message: 'the derived index is missing, unreadable or built by another schema, so this entry cannot be resolved',
        hint: 'rebuild the index (inkflow_index_rebuild) and reopen the panel',
      }),
    }
  }
  if (lookup.row === undefined) {
    return {
      status: 404,
      body: refused('library-item-not-found', {
        kind,
        id,
        hint: `list the tree with GET /library and use an id from its "${kind}" group`,
      }),
    }
  }

  const entity = entityFromRow(lookup.row)
  const path = entity.path
  const parsed = path === '' ? undefined : (() => {
    const content = readEntityFile(source.root, kind, path)
    return content === undefined ? undefined : parseMarkdown(content)
  })()
  const issues = readValidationIssues(source.root, { path, limit: ITEM_ISSUE_LIMIT })

  return {
    status: 200,
    body: ok({
      pluginVersion: version,
      sessionId: source.sessionId,
      root: source.root,
      kind,
      id: entity.id,
      path,
      title: entity.title,
      entity: {
        kind: entity.kind,
        id: entity.id,
        path: entity.path,
        title: entity.title,
        nameKey: entity.nameKey ?? null,
        category: entity.category ?? null,
        parent: entity.parent ?? null,
        orderIndex: entity.orderIndex ?? null,
        status: entity.status ?? null,
        keywords: entity.keywords ?? [],
        aliases: entity.aliases ?? [],
      },
      readable: parsed !== undefined,
      hasFrontmatter: parsed?.hasFrontmatter ?? false,
      frontmatter: parsed?.data ?? {},
      body: parsed?.body ?? '',
      bodyChars: parsed === undefined ? 0 : countChars(parsed.body),
      issues: parsed?.issues ?? [],
      // The CAS baseline for the next save (issue #30, second batch): the editor
      // reads an entry, edits it, and writes back against exactly these bytes.
      // Without it the panel could not tell "the file changed under me" from
      // "my own save", and `POST /library/item` refuses a save without one.
      fingerprint: path === '' ? null : (fingerprintProjectFile(source.root, path) ?? null),
      // The same rows the problem panel lists, narrowed to this file: a detail
      // pane that hides the reason the file is flagged would be a dead end.
      validationIssues: issues.ok ? issues.rows : [],
      ...(parsed === undefined
        ? {
            readError: {
              code: 'FILE_UNREADABLE',
              message: 'the index knows this entry but its file cannot be read (moved, deleted, or outside the project)',
              hint: 'rebuild the index, or check the file still exists at `path`',
            },
          }
        : {}),
    }),
  }
}

/**
 * `GET /library/issues` — `validation_issues` for the problem panel.
 *
 * `available: false` means "the index cannot answer"; an empty list with
 * `available: true` means "the book has no recorded problems". Those are
 * different claims and the panel shows them differently.
 */
export async function buildLibraryIssues(source: LibrarySource, version: string): Promise<JsonRecord> {
  const ensured = await ensureIndex(source.root)
  const found = readValidationIssues(source.root, { limit: LIBRARY_ISSUE_LIMIT })
  const issues = found.ok ? found.rows : []
  const countsByCode: Record<string, number> = {}
  for (const issue of issues) countsByCode[issue.code] = (countsByCode[issue.code] ?? 0) + 1
  return {
    pluginVersion: version,
    sessionId: source.sessionId,
    root: source.root,
    available: found.ok,
    total: issues.length,
    truncated: issues.length >= LIBRARY_ISSUE_LIMIT,
    countsByCode,
    issues,
    indexRebuilt: ensured.rebuilt,
    indexState: ensured.state,
    ...indexDegradation(ensured),
  }
}
