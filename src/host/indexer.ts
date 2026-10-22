/**
 * Derived SQLite index (ADR-0005).
 *
 * The index is a **cache built from files**: nothing in here is authoritative,
 * and the whole database is rebuilt whenever the build runs. That is
 * deliberate — it means there is no database migration, ever: a new index
 * layout is just a new `INDEX_SCHEMA_VERSION`, and the old file is discarded.
 *
 * This module owns *what* goes into the index (scan, validate, schema). The
 * atomic build — temp file, rename, lock, structured failures — lives in
 * `index-build.ts`.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { CONTENT_DIRS, INDEX_DB_FILE, INDEX_DIR, INDEX_SCHEMA_VERSION } from './conventions.js'
import { boolField, parseMarkdown, stringField } from './frontmatter.js'
import type { ProjectProbe } from './project.js'
import { DOMAIN_MODULES } from './domains/index.js'
import { ENTITIES_DDL, insertEntities } from './domains/entities.js'
import { MENTIONS_DDL, chaptersOf, insertMentions, scanMentions } from './domains/mentions.js'
import { readText } from './domains/scan-helpers.js'
import type { DomainDatabase, DomainEntityRef, DomainScanResult, DomainTableRows } from './domains/types.js'

export interface IndexCounts {
  files: number
  chapters: number
  characters: number
  worldEntries: number
  outlineNodes: number
  libraryFiles: number
}

export interface ValidationIssue {
  code: string
  path?: string
  detail: string
}

export interface IndexBuildResult {
  root: string
  dbFile: string
  schemaVersion: number
  mode: 'rebuilt'
  counts: IndexCounts
  issues: ValidationIssue[]
  ms: number
  builtAt: string
  /** Identifies one physical build: concurrent single-flight callers share it. */
  buildId: string
}

export interface IndexMeta {
  dbFile: string
  dbExists: boolean
  schemaVersion?: number
  schemaMatches: boolean
  builtAt?: string
  counts: IndexCounts
  projectTitle?: string
}

const SKIP_DIRS = new Set([INDEX_DIR, 'node_modules', '.git'])

function emptyCounts(): IndexCounts {
  return { files: 0, chapters: 0, characters: 0, worldEntries: 0, outlineNodes: 0, libraryFiles: 0 }
}

export function indexPaths(root: string): { dir: string; dbFile: string } {
  const dir = join(root, INDEX_DIR)
  return { dir, dbFile: join(dir, INDEX_DB_FILE) }
}

// Re-exported from the domain layer: both used to live here, and `internal.ts` plus
// the write path already import them through this module (one implementation only).
export { countChars } from './domains/scan-helpers.js'
export { nameKey } from './domains/naming.js'

export interface WalkedFile {
  path: string
  dir: string
  size: number
  mtime: string
  /** Same instant as `mtime`, unrounded by the ISO serialisation (freshness compares this). */
  mtimeMs: number
}

function walk(root: string, dir: string, out: WalkedFile[], depth = 0): void {
  if (depth > 8) return
  let entries
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const rel = dir === '' ? entry.name : `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(root, rel, out, depth + 1)
      continue
    }
    if (!entry.isFile()) continue
    const absolute = join(root, rel)
    try {
      const info = statSync(absolute)
      out.push({
        path: rel,
        dir: rel.split('/')[0] ?? '',
        size: info.size,
        mtime: info.mtime.toISOString(),
        mtimeMs: info.mtimeMs,
      })
    } catch {
      // Unreadable file: skip rather than fail the whole build.
    }
  }
}

/**
 * One `readdir`+`stat` pass over the project (contents are *not* read), in a
 * deterministic path order.
 *
 * Shared by the index build and by `checkIndexFreshness` on purpose: the
 * freshness verdict is only meaningful when it sees exactly the file set the
 * build would index, including the same skip rules (`index/`, `node_modules`,
 * `.git`, dotfiles, `depth > 8`).
 */
export function walkProjectFiles(root: string): WalkedFile[] {
  const files: WalkedFile[] = []
  walk(root, '', files)
  // Deterministic scan order: when two files claim the same id, "the first file
  // wins" has to mean the same file on every rebuild — readdir order is not
  // guaranteed by the OS or the filesystem.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return files
}











/** Everything one scan produced; consumed by `writeIndexDatabase`. */
export interface ScanResult {
  files: WalkedFile[]
  issues: ValidationIssue[]
  /** One bucket per table, contributed by the domain modules (#23). */
  tables: DomainTableRows[]
  /** The cross-class projection (X-1): every entity of the book, one row each. */
  entities: DomainEntityRef[]
  /**
   * Legacy narrow views, derived from `tables`. Kept so existing readers (parity
   * tests, the build result) do not have to care about the bucket shape; #23 is the
   * commit that introduced `tables`, so nothing else depends on them yet.
   */
  chapterRows: ReadonlyArray<Record<string, unknown>>
  characterRows: ReadonlyArray<Record<string, unknown>>
  worldRows: ReadonlyArray<Record<string, unknown>>
  outlineRows: ReadonlyArray<Record<string, unknown>>
  libraryFiles: WalkedFile[]
  counts: IndexCounts
}

/** Scan and validate the project files. Pure read: no index file is touched here. */
export function scanProject(root: string): ScanResult {
  const files = walkProjectFiles(root)

  const issues: ValidationIssue[] = []
  const tables: DomainTableRows[] = []
  const entities: DomainEntityRef[] = []
  const libraryFiles: WalkedFile[] = []

  // 1) Every registered domain scans its own directory; the index never parses a
  //    content directory itself (X-4/X-5). A domain owns exactly one kind.
  const ownedDirs = new Set<string>(DOMAIN_MODULES.map((module) => module.kind))
  const scanned = DOMAIN_MODULES.map((module) => ({
    module,
    result: module.scan({ root, files: files.filter((file) => file.dir === module.kind) }),
  }))
  for (const { result } of scanned) {
    tables.push(...result.tables)
    entities.push(...result.entities)
    issues.push(...result.issues)
  }

  // 2) A content directory with no owner yet still gets the generic frontmatter pass:
  //    v1 reported it for every content directory, and a broken frontmatter block must
  //    not become invisible just because its domain has not landed (#27/#28/#31).
  for (const file of files) {
    if ((CONTENT_DIRS as readonly string[]).includes(file.dir) === false) continue
    if (file.dir === 'library') libraryFiles.push(file)
    if (ownedDirs.has(file.dir)) continue
    if (extname(file.path).toLowerCase() !== '.md') continue
    const parsed = parseMarkdown(readText(join(root, file.path)))
    for (const issue of parsed.issues) issues.push({ code: 'FRONTMATTER_ISSUE', path: file.path, detail: issue })
    // I-09: `resolved: true` is only checkable when the file names the chapter that
    // pays it off. There is no table for it yet (#31), so this stays a validation-only
    // pass over the frontmatter — the same shape v1 had.
    if (file.dir === 'foreshadowing') {
      const resolvedChapter = stringField(parsed.data, 'resolvedChapter')
      if (boolField(parsed.data, 'resolved') && (resolvedChapter ?? '').trim() === '') {
        issues.push({
          code: 'FORESHADOW_RESOLVED_WITHOUT_CHAPTER',
          path: file.path,
          detail: 'resolved: true requires resolvedChapter (the chapter that pays the setup off)',
        })
      }
    }
  }

  // 3) I-04: report every collision across classes, then drop only **same-table**
  //    duplicates. Separate tables have separate primary keys, so two kinds may share an
  //    id: that is reported as DUPLICATE_ID with neither row dropped (the contract the
  //    bug test pins), and the projection's (kind, id) key can represent both.
  const firstPathById = new Map<string, string>()
  for (const entity of entities) {
    const previous = firstPathById.get(entity.id)
    if (previous !== undefined && previous !== entity.path) {
      issues.push({ code: 'DUPLICATE_ID', path: entity.path, detail: `id "${entity.id}" also used by ${previous}` })
    } else if (previous === undefined) {
      firstPathById.set(entity.id, entity.path)
    }
  }

  // 4) Domain invariants run on the domain's own rows with the whole book's projection
  //    available, so a domain can resolve references across directories.
  for (const { module, result } of scanned) {
    issues.push(...module.validate({ root, scan: result, entities }))
  }

  // Same-table de-duplication: one primary key holds one row, so the first file in walk
  // order wins and the later ones stay visible in the DUPLICATE_ID details.
  const keptTables = tables.map((table) => {
    const seen = new Set<string>()
    const rows = table.rows.filter((row) => {
      const key = String(row['id'] ?? row['path'] ?? '')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return { table: table.table, rows }
  })

  // The projection follows the same keep-first decision as the tables, or I-15 breaks:
  // `entities` is written from this list, so a row a domain table dropped must not
  // survive here (and must not be inserted into `entities_fts` twice).
  const seenEntityKeys = new Set<string>()
  const keptEntities = entities.filter((entity) => {
    const key = `${entity.kind}\u0000${entity.id}`
    if (seenEntityKeys.has(key)) return false
    seenEntityKeys.add(key)
    return true
  })

  const counts = emptyCounts()
  counts.files = files.length
  counts.chapters = tableCount(keptTables, 'chapters')
  counts.characters = tableCount(keptTables, 'characters')
  counts.worldEntries = tableCount(keptTables, 'world_entries')
  counts.outlineNodes = tableCount(keptTables, 'outline_nodes')
  counts.libraryFiles = libraryFiles.length

  return {
    files,
    issues,
    tables: keptTables,
    entities: keptEntities,
    chapterRows: tableRows(keptTables, 'chapters'),
    characterRows: tableRows(keptTables, 'characters'),
    worldRows: tableRows(keptTables, 'world_entries'),
    outlineRows: tableRows(keptTables, 'outline_nodes'),
    libraryFiles,
    counts,
  }
}

/** Rows of one bucket; empty when the table is absent. */
function tableRows(tables: readonly DomainTableRows[], name: string): ReadonlyArray<Record<string, unknown>> {
  return tables.find((table) => table.table === name)?.rows ?? []
}

/** Row count of one bucket — counts describe what is actually queryable. */
function tableCount(tables: readonly DomainTableRows[], name: string): number {
  return tableRows(tables, name).length
}

/**
 * Write the whole index into `targetFile` (always a build temp file).
 * The caller swaps it into place only after this returns and the file is fsynced; on
 * any throw the temp file is thrown away by the caller.
 *
 * Who creates what: this function creates the seam-owned tables (freshness baseline,
 * issue log, library registry, cross-class projection) and then asks every registered
 * domain for its own DDL and row writer (X-2). No table is created in two places.
 */
export function writeIndexDatabase(targetFile: string, root: string, scan: ScanResult): string {
  const { files, tables, entities, libraryFiles, issues, counts } = scan
  const db = new DatabaseSync(targetFile)
  try {
    // DELETE journal: a WAL database brings `-wal`/`-shm` side files that would have to
    // be renamed together with the database. The temp file is renamed alone, so it must
    // be a single self-contained file.
    db.exec('PRAGMA journal_mode = DELETE')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('BEGIN')

    db.exec(`
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE files (path TEXT PRIMARY KEY, dir TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, mtime TEXT NOT NULL);
CREATE TABLE library_files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime TEXT NOT NULL);
CREATE TABLE validation_issues (seq INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, path TEXT, detail TEXT NOT NULL);
`)
    for (const statement of ENTITIES_DDL) db.exec(statement)
    // Mentions (#29) are a cross-cutting scan, not a domain: `mentions` owns no
    // content directory, so its table is created here beside the projection.
    for (const statement of MENTIONS_DDL) db.exec(statement)
    for (const module of DOMAIN_MODULES) {
      for (const statement of module.schema().ddl) db.exec(statement)
    }

    const insertFile = db.prepare('INSERT INTO files (path, dir, kind, size, mtime) VALUES (?, ?, ?, ?, ?)')
    for (const file of files) {
      insertFile.run(file.path, file.dir, file.dir === '' ? 'root' : file.dir, file.size, file.mtime)
    }

    // Domain rows: each module writes its own tables (`INSERT OR REPLACE` inside, so an
    // unforeseen duplicate replaces the earlier row instead of aborting the build), and
    // then the projection is written from the same scan — same transaction, which is
    // what makes I-15 (ENTITIES_DRIFT) a check rather than a hope.
    const domainDatabase = db as unknown as DomainDatabase
    const domainScan: DomainScanResult = { tables, entities, issues }
    for (const module of DOMAIN_MODULES) module.schema().insert(domainDatabase, domainScan)
    insertEntities(domainDatabase, entities)
    // Mentions last, from the rows already scanned: the chapter bodies the chapter
    // domain parsed and the projection this build just wrote — no file is read twice.
    insertMentions(domainDatabase, scanMentions(chaptersOf(tables), entities))

    const insertLibrary = db.prepare('INSERT INTO library_files (path, size, mtime) VALUES (?, ?, ?)')
    for (const file of libraryFiles) insertLibrary.run(file.path, file.size, file.mtime)
    const insertIssue = db.prepare('INSERT INTO validation_issues (code, path, detail) VALUES (?, ?, ?)')
    for (const issue of issues) insertIssue.run(issue.code, issue.path ?? null, issue.detail)

    const builtAt = new Date().toISOString()
    const insertMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
    insertMeta.run('builtAt', builtAt)
    insertMeta.run('root', root)
    insertMeta.run('indexSchemaVersion', String(INDEX_SCHEMA_VERSION))
    insertMeta.run('fileCount', String(counts.files))
    insertMeta.run('entityCount', String(entities.length))
    db.exec(`PRAGMA user_version = ${INDEX_SCHEMA_VERSION}`)
    db.exec('COMMIT')
    return builtAt
  } finally {
    db.close()
  }
}

/** Read index metadata without rebuilding. Returns `dbExists: false` when absent. */export function readIndexMeta(root: string, probe?: ProjectProbe): IndexMeta {
  const paths = indexPaths(root)
  const base: IndexMeta = {
    dbFile: paths.dbFile,
    dbExists: existsSync(paths.dbFile),
    schemaMatches: false,
    counts: emptyCounts(),
  }
  if (probe?.meta?.title !== undefined) base.projectTitle = probe.meta.title
  if (!base.dbExists) return base

  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(paths.dbFile, { readOnly: true })
    const versionRow = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    const version = typeof versionRow?.user_version === 'number' ? versionRow.user_version : 0
    base.schemaVersion = version
    base.schemaMatches = version === INDEX_SCHEMA_VERSION
    if (!base.schemaMatches) return base

    const readMeta = db.prepare('SELECT value FROM meta WHERE key = ?')
    const builtAt = readMeta.get('builtAt') as { value?: string } | undefined
    if (typeof builtAt?.value === 'string') base.builtAt = builtAt.value
    const count = (sql: string): number => {
      const row = db?.prepare(sql).get() as { n?: number } | undefined
      return typeof row?.n === 'number' ? row.n : 0
    }
    base.counts = {
      files: count('SELECT COUNT(*) AS n FROM files'),
      chapters: count('SELECT COUNT(*) AS n FROM chapters'),
      characters: count('SELECT COUNT(*) AS n FROM characters'),
      worldEntries: count('SELECT COUNT(*) AS n FROM world_entries'),
      outlineNodes: count('SELECT COUNT(*) AS n FROM outline_nodes'),
      libraryFiles: count('SELECT COUNT(*) AS n FROM library_files'),
    }
    return base
  } catch {
    return base
  } finally {
    db?.close()
  }
}

export interface ChapterSummary {
  id: string
  path: string
  seq: number | null
  title: string
  volume: string | null
  status: string
  wordCount: number
}

/**
 * List chapters from the derived index.
 * Returns `undefined` when the index is absent or built by another schema —
 * the caller then tells the user to rebuild instead of showing stale data.
 */
export function listChapters(root: string, limit = 100): ChapterSummary[] | undefined {
  const paths = indexPaths(root)
  if (!existsSync(paths.dbFile)) return undefined
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(paths.dbFile, { readOnly: true })
    const versionRow = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    if (versionRow?.user_version !== INDEX_SCHEMA_VERSION) return undefined
    const rows = db
      .prepare('SELECT id, path, seq, title, volume, status, word_count FROM chapters ORDER BY seq IS NULL, seq, path LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 500)) as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row['id']),
      path: String(row['path']),
      seq: typeof row['seq'] === 'number' ? row['seq'] : null,
      title: String(row['title']),
      volume: typeof row['volume'] === 'string' ? row['volume'] : null,
      status: String(row['status']),
      wordCount: typeof row['word_count'] === 'number' ? row['word_count'] : 0,
    }))
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}
