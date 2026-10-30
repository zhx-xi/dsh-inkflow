/**
 * The panel channel's read-only projections (ADR-0008 D1): every `GET` the panel
 * makes, one builder each, all of them answering from the derived index or the
 * catalog and none of them writing.
 *
 * WHY IT IS A FILE: these builders are the half of `internal.ts` that grows with
 * every new page, and they share nothing with the resolver but the target it
 * produces. `internal.ts` re-exports them, so `routes-internal.ts` still imports
 * one module.
 *
 * `ChannelTarget` is only ever constructed by the resolver: a builder trusts it.
 */

import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getLoadedBuild, summarizeBuild } from './build-info.js'
import { readCatalog } from './catalog.js'
import type { CatalogChapter, CatalogVolume } from './catalog.js'
import { INDEX_SCHEMA_VERSION, CHAPTER_STATUSES } from './conventions.js'
import { fingerprintProjectFile } from './file-cas.js'
import { parseMarkdown } from './frontmatter.js'
import { countChars, indexPaths, readIndexMeta } from './indexer.js'
import { ensureIndex } from './index-freshness.js'
import type { EnsureIndexResult } from './index-freshness.js'
import { searchEntries } from './search.js'
import { searchWithSemantic } from './ovk-search.js'
import { isWithin, projectLabel, realpathLoose } from './project.js'
import { detectTextStyle } from './text-style.js'
import type { ChannelTarget, JsonRecord } from './internal-types.js'

// ---------------------------------------------------------------------------
// Projections (all read-only)
// ---------------------------------------------------------------------------

/**
 * Why a degraded search answers from chapter metadata: the panel's search box must still
 * work on a book whose index cannot be built (a foreign lock, a read-only checkout), and
 * the reply has to say so rather than reporting "no match" for a word that is in the book.
 */
const SEARCH_REASON =
  'the derived index could not be used, so this answer lists chapter metadata only (id / path / title); body prose and the setting library need a rebuilt index'

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
    // A hand-written file with a GBK-misread title is a hint for the
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
    // The search box exists now and covers every kind (X-16); `scope` names what
    // `GET /search` answers, and a degraded answer (unusable index) says so per reply in
    // `degradedReason` — the capability itself no longer depends on the index.
    search: { available: true, scope: 'all-kinds', backends: ['fts5'] },
    // The panel's "is this build old?" banner. Read at call time, so a
    // rebuild while DSH is running makes the next `/status` answer "stale" and
    // only a restart makes it "fresh" again — refreshing cannot clear it.
    build: summarizeBuild(getLoadedBuild({ version })),
  }
}

/**
 * `GET /chapters`: the volume/chapter tree from the `.md` projection.
 *
 * The tree itself comes from the catalog (files → projection, always current),
 * but the index is made fresh first so that this call and a following
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
    // Raw on purpose (ADR-0016): the BOM and the `\r`s are what `detectTextStyle`
    // reads, and `parseMarkdown` already tolerates both — stripping here would
    // make a BOM'd chapter report `bom: false`.
    return readFileSync(absolute, 'utf8')
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
  const style = detectTextStyle(text)
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
    // The file's own format (ADR-0016). `body` above stays LF — the editor must
    // never see a `\r` — so this is the only way a save can put the file back the
    // way it found it. Read-only: the write path takes it back as a declaration.
    eol: style.eol,
    bom: style.bom,
    // The CAS baseline for the next save: the editor reads a chapter,
    // edits it, and writes back against exactly these bytes. Without it the
    // browser could not tell "the file changed under me" from "my own save".
    fingerprint: fingerprintProjectFile(target.root, entry.chapter.file) ?? null,
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`)
}

/**
 * Search the derived index's `chapters` table for a *metadata* match (id, path, title).
 *
 * This is the degraded answer, not the main one: `buildSearch` below searches body prose
 * and every setting kind through `searchEntries` (X-16) and only falls back here when
 * the index cannot be used at all. It reads the index rather than the catalog when it can,
 * because `seq`/`status`/`volume` are index columns and the panel shows them.
 *
 * `undefined` means "the index cannot answer" (missing, foreign schema, unreadable).
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
    return rows.map((row) => metadataHitOf(String(row['id']), String(row['path']), String(row['title'])))
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

/** One metadata-only hit in the X-16 entry shape: an empty snippet is the honest answer. */
function metadataHitOf(id: string, path: string, title: string): JsonRecord {
  return { kind: 'chapters', id, path, title, snippet: '' }
}

/** Catalog-backed fallback: the files themselves, so a buildable index is not required. */
function searchCatalog(root: string, query: string, limit: number): JsonRecord[] {
  const needle = query.toLowerCase()
  const hits: JsonRecord[] = []
  for (const entry of chapterEntries(root)) {
    const { chapter } = entry
    const matches =
      chapter.chapterId.toLowerCase().includes(needle) ||
      chapter.file.toLowerCase().includes(needle) ||
      chapter.title.toLowerCase().includes(needle)
    if (!matches) continue
    hits.push(metadataHitOf(chapter.chapterId, chapter.file, chapter.title))
    if (hits.length >= limit) break
  }
  return hits
}

/** What a panel search may ask for: the one query, the kinds, and one page. */
export interface ChannelSearchInput {
  query: string
  kinds?: readonly string[]
  offset?: number
  limit?: number
}

/**
 * `GET /search?q=`: the single search entry over the whole book (X-16).
 *
 * The envelope is X-16's, unchanged from the tool surface: `items` of
 * `{kind, id, path, title, snippet}`, `{offset, limit, total}`, `truncated` and
 * `searchBackend`, so the panel and the model read the same answer.
 *
 * The index is made fresh first, so the panel cannot show a chapter list built
 * from the files while searching an index from a previous generation. If the index is
 * missing, foreign or unrebuildable (another process holds the lock), the answer degrades
 * to a metadata scan of the same files and `degradedReason` says exactly that — a panel
 * read never fails and never answers "no such word" when the cache is the problem.
 */
export async function buildSearch(
  target: ChannelTarget,
  version: string,
  input: ChannelSearchInput,
  pluginDataDir?: string,
): Promise<JsonRecord> {
  const ensured = await ensureIndex(target.root)
  const base = {
    pluginVersion: version,
    sessionId: target.sessionId,
    root: target.root,
    query: input.query,
    indexRebuilt: ensured.rebuilt,
    indexState: ensured.state,
    ...indexFailureOf(ensured),
  }
  // The semantic backend sits behind this same entry. With no `dataDir` (a caller that
  // has no plugin state to read) the answer is the keyword one, which is exactly what the
  // `disabled` degradation returns anyway — so the two paths agree instead of diverging.
  const semantic =
    pluginDataDir === undefined
      ? undefined
      : await searchWithSemantic(
          target.root,
          input.query,
          {
            ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
            ...(input.offset === undefined ? {} : { offset: input.offset }),
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          },
          { dataDir: pluginDataDir },
        )
  const result =
    semantic?.result ??
    searchEntries(target.root, input.query, {
      ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
      ...(input.offset === undefined ? {} : { offset: input.offset }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    })
  if (result.ok) {
    return {
      ...base,
      searchBackend: result.searchBackend,
      ...(result.degradedReason === undefined ? {} : { degradedReason: result.degradedReason }),
      mode: result.mode,
      offset: result.offset,
      limit: result.limit,
      total: result.total,
      truncated: result.truncated,
      items: result.items,
      ...(semantic === undefined ? {} : { semantic: { backend: semantic.availability.backend, hits: semantic.semanticHits, staleIndex: semantic.staleHits } }),
    }
  }

  // Degraded: metadata only, and it says so. `INDEX_UNAVAILABLE` is the expected case
  // here (the cache is missing or foreign); a rejected query is caught by the route
  // before this function, so any other code still answers rather than showing nothing.
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50), 1), 100)
  const offset = Math.min(Math.max(Math.trunc(input.offset ?? 0), 0), 5000)
  const metadata = searchIndex(target.root, input.query, offset + limit) ?? searchCatalog(target.root, input.query, offset + limit)
  const page = metadata.slice(offset, offset + limit)
  return {
    ...base,
    searchBackend: 'fts5',
    degradedReason: `${SEARCH_REASON} (${result.code}: ${result.message})`,
    mode: 'like',
    offset,
    limit,
    total: metadata.length,
    truncated: metadata.length >= offset + limit && metadata.length > 0,
    items: page,
  }
}
