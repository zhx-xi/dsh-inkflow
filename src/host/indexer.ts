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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  CHAPTER_STATUSES,
  CONTENT_DIRS,
  INDEX_DB_FILE,
  INDEX_DIR,
  INDEX_SCHEMA_VERSION,
  OUTLINE_KINDS,
} from './conventions.js'
import { intField, parseMarkdown, stringField } from './frontmatter.js'
import type { ProjectProbe } from './project.js'

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

/** Non-blank character count — matches how Chinese word counts are usually quoted. */
export function countChars(text: string): number {
  return text.replace(/\s+/gu, '').length
}

/** Normalise a name for uniqueness checks: NFKC, case-fold, strip whitespace. */
export function nameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')
}

interface WalkedFile {
  path: string
  dir: string
  size: number
  mtime: string
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
      })
    } catch {
      // Unreadable file: skip rather than fail the whole build.
    }
  }
}

function leadingNumber(file: string): number | undefined {
  const match = /^(\d+)/.exec(basename(file))
  return match?.[1] === undefined ? undefined : Number(match[1])
}

function dirNameOf(relPath: string): string {
  const parts = relPath.split('/')
  return parts.length > 1 ? (parts[parts.length - 2] ?? '') : ''
}

/**
 * `chapters/vol-01/0001-a.md` → `vol-01`; a chapter sitting directly in
 * `chapters/` has no volume. Taking "the parent directory name" blindly gave
 * every top-level chapter `volume: "chapters"`, which is not a volume but the
 * container itself (issue #7).
 */
function volumeDirOf(relPath: string): string | undefined {
  const parts = relPath.split('/')
  if (parts.length !== 3 || parts[0] !== 'chapters') return undefined
  const volume = parts[1]
  return volume === undefined || volume === '' ? undefined : volume
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

interface ChapterRecord {
  id: string
  path: string
  seq: number | undefined
  title: string
  volume: string | undefined
  status: string
  wordCount: number
  body: string
}

interface CharacterRecord {
  id: string
  path: string
  name: string
  key: string
  group: string | undefined
  role: string | undefined
}

interface WorldRecord {
  id: string
  path: string
  title: string
  category: string | undefined
  parent: string | undefined
}

interface OutlineRecord {
  id: string
  path: string
  kind: string
  title: string
  parent: string | undefined
  order: number | undefined
}

function inferOutlineKind(relPath: string): string | undefined {
  const name = basename(relPath, extname(relPath)).toLowerCase()
  if (name === 'overall' || name.startsWith('overall')) return 'overall'
  if (name.startsWith('vol-') || name.startsWith('volume-')) return 'volume'
  if (name.startsWith('ch-') || name.startsWith('chapter-')) return 'chapter'
  return undefined
}

/**
 * Keep only the first row per id.
 *
 * The id columns are PRIMARY KEYs and the whole rebuild runs in one transaction,
 * so one duplicate id aborts the build, leaves no index behind, and makes every
 * later read — and every retry — fail the same way. A duplicate id is content
 * the author can still fix, so the index reports it as `DUPLICATE_ID` and keeps
 * the first file instead of locking the project out (conventions.md §4: issues
 * never block the index).
 */
function keepFirstById<T extends { id: string }>(rows: readonly T[]): T[] {
  const seen = new Set<string>()
  const kept: T[] = []
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    kept.push(row)
  }
  return kept
}

/** Everything one scan produced; consumed by `writeIndexDatabase`. */
export interface ScanResult {
  files: WalkedFile[]
  issues: ValidationIssue[]
  chapterRows: ChapterRecord[]
  characterRows: CharacterRecord[]
  worldRows: WorldRecord[]
  outlineRows: OutlineRecord[]
  libraryFiles: WalkedFile[]
  counts: IndexCounts
}

/** Scan and validate the project files. Pure read: no index file is touched here. */
export function scanProject(root: string): ScanResult {
  const files: WalkedFile[] = []
  walk(root, '', files)
  // Deterministic scan order: when two files claim the same id, "the first file
  // wins" has to mean the same file on every rebuild — readdir order is not
  // guaranteed by the OS or the filesystem.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  const issues: ValidationIssue[] = []
  const chapters: ChapterRecord[] = []
  const characters: CharacterRecord[] = []
  const worldEntries: WorldRecord[] = []
  const outlineNodes: OutlineRecord[] = []
  const libraryFiles: WalkedFile[] = []
  const counts = emptyCounts()

  for (const file of files) {
    const kindDir = file.dir
    if ((CONTENT_DIRS as readonly string[]).includes(kindDir) === false) continue
    if (kindDir === 'library') libraryFiles.push(file)

    if (extname(file.path).toLowerCase() !== '.md') {
      if (kindDir === 'chapters') {
        issues.push({ code: 'CHAPTER_NOT_MARKDOWN', path: file.path, detail: 'chapters must be .md files' })
      }
      continue
    }

    const parsed = parseMarkdown(readText(join(root, file.path)))
    for (const issue of parsed.issues) {
      issues.push({ code: 'FRONTMATTER_ISSUE', path: file.path, detail: issue })
    }
    const id = stringField(parsed.data, 'id') ?? file.path

    if (kindDir === 'chapters') {
      const status = stringField(parsed.data, 'status')
      chapters.push({
        id,
        path: file.path,
        seq: intField(parsed.data, 'seq') ?? leadingNumber(file.path),
        title: stringField(parsed.data, 'title') ?? basename(file.path, '.md'),
        volume: stringField(parsed.data, 'volume') ?? volumeDirOf(file.path),
        status: (CHAPTER_STATUSES as readonly string[]).includes(status ?? '') ? (status as string) : 'draft',
        wordCount: countChars(parsed.body),
        body: parsed.body,
      })
    } else if (kindDir === 'characters') {
      const name = stringField(parsed.data, 'name') ?? basename(file.path, '.md')
      characters.push({
        id,
        path: file.path,
        name,
        key: nameKey(name),
        group: stringField(parsed.data, 'group'),
        role: stringField(parsed.data, 'role'),
      })
    } else if (kindDir === 'world') {
      worldEntries.push({
        id,
        path: file.path,
        title: stringField(parsed.data, 'title') ?? basename(file.path, '.md'),
        category: stringField(parsed.data, 'category') ?? (dirNameOf(file.path) || undefined),
        parent: stringField(parsed.data, 'parent'),
      })
    } else if (kindDir === 'outlines') {
      const declaredKind = stringField(parsed.data, 'kind')
      const kind = (OUTLINE_KINDS as readonly string[]).includes(declaredKind ?? '')
        ? (declaredKind as string)
        : inferOutlineKind(file.path)
      if (kind === undefined) {
        issues.push({
          code: 'OUTLINE_KIND_UNKNOWN',
          path: file.path,
          detail: 'cannot infer kind; declare kind: overall|volume|chapter',
        })
        continue
      }
      outlineNodes.push({
        id,
        path: file.path,
        kind,
        title: stringField(parsed.data, 'title') ?? basename(file.path, '.md'),
        parent: stringField(parsed.data, 'parent'),
        order: intField(parsed.data, 'order'),
      })
    }
  }

  // ---- invariant checks over the parsed view (application-level, ADR-0005) ----
  const overall = outlineNodes.filter((node) => node.kind === 'overall')
  if (overall.length === 0) {
    issues.push({ code: 'OUTLINE_NO_OVERALL', detail: 'project must have exactly one outlines/overall.md' })
  } else if (overall.length > 1) {
    issues.push({ code: 'OUTLINE_MULTIPLE_OVERALL', detail: `${overall.length} overall outlines found` })
  }
  const overallId = overall[0]?.id
  const outlineById = new Map(outlineNodes.map((node) => [node.id, node]))
  for (const node of outlineNodes) {
    if (node.kind === 'volume') {
      if (node.parent === undefined || overallId === undefined || node.parent !== overallId) {
        issues.push({
          code: 'OUTLINE_VOLUME_PARENT',
          path: node.path,
          detail: 'volume outline must have parent = overall outline id',
        })
      }
    }
    if (node.kind === 'chapter' && node.parent !== undefined) {
      const parent = outlineById.get(node.parent)
      if (parent === undefined) {
        issues.push({ code: 'DANGLING_PARENT', path: node.path, detail: `parent "${node.parent}" not found` })
      } else if (parent.kind === 'volume') {
        // allowed (chapter under volume); volume-under-volume is what we forbid
      }
    }
    if (node.kind === 'volume' && node.parent !== undefined) {
      const parent = outlineById.get(node.parent)
      if (parent !== undefined && parent.kind === 'volume') {
        issues.push({ code: 'OUTLINE_VOLUME_IN_VOLUME', path: node.path, detail: 'volume outline cannot nest under a volume' })
      }
    }
  }

  const seenCharacterKeys = new Map<string, string>()
  for (const character of characters) {
    const previous = seenCharacterKeys.get(character.key)
    if (previous !== undefined) {
      issues.push({
        code: 'CHARACTER_NAME_DUPLICATE',
        path: character.path,
        detail: `name "${character.name}" already used by ${previous}`,
      })
    } else {
      seenCharacterKeys.set(character.key, character.path)
    }
  }

  const knownIds = new Set<string>([...chapters.map((c) => c.id), ...characters.map((c) => c.id), ...worldEntries.map((c) => c.id)])
  for (const entry of worldEntries) {
    if (entry.parent !== undefined && entry.parent !== '' && !knownIds.has(entry.parent)) {
      issues.push({ code: 'DANGLING_PARENT', path: entry.path, detail: `parent "${entry.parent}" not found` })
    }
  }

  const duplicateIds = new Map<string, string>()
  for (const item of [...chapters, ...characters, ...worldEntries, ...outlineNodes]) {
    const previous = duplicateIds.get(item.id)
    if (previous !== undefined) {
      issues.push({ code: 'DUPLICATE_ID', path: item.path, detail: `id "${item.id}" also used by ${previous}` })
    } else {
      duplicateIds.set(item.id, item.path)
    }
  }

  // The validator above already reported every collision; the writer must not
  // be handed two rows with the same primary key, so the later files are dropped
  // from the index (their paths stay visible in the DUPLICATE_ID details).
  const chapterRows = keepFirstById(chapters)
  const characterRows = keepFirstById(characters)
  const worldRows = keepFirstById(worldEntries)
  const outlineRows = keepFirstById(outlineNodes)

  // Counts describe what is actually queryable in the index, so they follow the
  // kept rows — readIndexMeta counts rows too and the two must agree.
  counts.files = files.length
  counts.chapters = chapterRows.length
  counts.characters = characterRows.length
  counts.worldEntries = worldRows.length
  counts.outlineNodes = outlineRows.length
  counts.libraryFiles = libraryFiles.length

  return { files, issues, chapterRows, characterRows, worldRows, outlineRows, libraryFiles, counts }
}

/**
 * Write the whole index into `targetFile` (always a build temp file).
 * The caller swaps it into place only after this returns and the file is
 * fsynced; on any throw the temp file is thrown away by the caller.
 */
export function writeIndexDatabase(targetFile: string, root: string, scan: ScanResult): string {
  const { files, chapterRows, characterRows, worldRows, outlineRows, libraryFiles, issues, counts } = scan
  const db = new DatabaseSync(targetFile)
  try {
    // DELETE journal: a WAL database brings `-wal`/`-shm` side files that would
    // have to be renamed together with the database. The temp file is renamed
    // alone, so it must be a single self-contained file.
    db.exec('PRAGMA journal_mode = DELETE')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('BEGIN')
    db.exec(`
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE files (path TEXT PRIMARY KEY, dir TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, mtime TEXT NOT NULL);
CREATE TABLE chapters (id TEXT PRIMARY KEY, path TEXT NOT NULL, seq INTEGER, title TEXT NOT NULL, volume TEXT, status TEXT NOT NULL, word_count INTEGER NOT NULL);
CREATE INDEX ix_chapters_seq ON chapters(seq);
CREATE TABLE characters (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL, group_name TEXT, role TEXT);
CREATE INDEX ix_characters_name ON characters(name_key);
CREATE TABLE world_entries (id TEXT PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, category TEXT, parent TEXT);
CREATE INDEX ix_world_category ON world_entries(category);
CREATE TABLE outline_nodes (id TEXT PRIMARY KEY, path TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, parent TEXT, order_index INTEGER);
CREATE INDEX ix_outline_kind ON outline_nodes(kind);
CREATE TABLE library_files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime TEXT NOT NULL);
CREATE TABLE validation_issues (seq INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, path TEXT, detail TEXT NOT NULL);
CREATE VIRTUAL TABLE chapters_fts USING fts5(chapter_id UNINDEXED, title, body, tokenize='trigram');
`)

    const insertFile = db.prepare('INSERT INTO files (path, dir, kind, size, mtime) VALUES (?, ?, ?, ?, ?)')
    for (const file of files) {
      insertFile.run(file.path, file.dir, file.dir === '' ? 'root' : file.dir, file.size, file.mtime)
    }
    // `INSERT OR REPLACE` is the second net below the `keepFirstById` prefilter:
    // a derived index must never be able to brick a project, so an unforeseen
    // duplicate replaces the earlier row instead of aborting the transaction.
    const insertChapter = db.prepare(
      'INSERT OR REPLACE INTO chapters (id, path, seq, title, volume, status, word_count) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const insertChapterFts = db.prepare('INSERT INTO chapters_fts (chapter_id, title, body) VALUES (?, ?, ?)')
    for (const chapter of chapterRows) {
      insertChapter.run(chapter.id, chapter.path, chapter.seq ?? null, chapter.title, chapter.volume ?? null, chapter.status, chapter.wordCount)
      insertChapterFts.run(chapter.id, chapter.title, chapter.body)
    }
    const insertCharacter = db.prepare(
      'INSERT OR REPLACE INTO characters (id, path, name, name_key, group_name, role) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const character of characterRows) {
      insertCharacter.run(character.id, character.path, character.name, character.key, character.group ?? null, character.role ?? null)
    }
    const insertWorld = db.prepare(
      'INSERT OR REPLACE INTO world_entries (id, path, title, category, parent) VALUES (?, ?, ?, ?, ?)',
    )
    for (const entry of worldRows) {
      insertWorld.run(entry.id, entry.path, entry.title, entry.category ?? null, entry.parent ?? null)
    }
    const insertOutline = db.prepare(
      'INSERT OR REPLACE INTO outline_nodes (id, path, kind, title, parent, order_index) VALUES (?, ?, ?, ?, ?, ?)',
    )
    for (const node of outlineRows) {
      insertOutline.run(node.id, node.path, node.kind, node.title, node.parent ?? null, node.order ?? null)
    }
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
