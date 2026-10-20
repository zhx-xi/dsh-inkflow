/**
 * SQLite data layer (node:sqlite — DSH's bundled Node 24 has it built in).
 *
 * Design rules for this project (see docs/data-model.md):
 *   - SQLite is the source of truth for novel data; Markdown/JSON export is a
 *     backup format only.
 *   - Every mutable row carries rev / updated_at / device_id so a future sync
 *     port can push change_log entries without reshaping tables; deletion is a
 *     tombstone (`deleted_at`), never a hard DELETE.
 *   - Migrations are ordered, versioned, and replayable (PRAGMA user_version).
 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export const SCHEMA_VERSION = 1

/** A row of `projects` as stored. */
export interface ProjectRow {
  id: string
  title: string
  subtitle: string
  author: string
  genre: string
  series_id: string | null
  cover_path: string | null
  status: 'draft' | 'writing' | 'finished' | 'archived'
  word_count: number
  chapter_count: number
  rev: number
  device_id: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface ProjectInput {
  title: string
  subtitle?: string
  author?: string
  genre?: string
  seriesId?: string | null
}

export const PROJECT_STATUSES = ['draft', 'writing', 'finished', 'archived'] as const

/** Current UTC instant as ISO-8601 with milliseconds (`2026-10-21T06:12:00.000Z`). */
export function nowIso(): string {
  return new Date().toISOString()
}

/** Stable per-install identifier; a future sync layer keys device-scoped changes by it. */
function resolveDeviceId(db: DatabaseSync): string {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE key = ?')
    .get('device_id') as { value?: unknown } | undefined
  if (typeof row?.value === 'string' && row.value !== '') return row.value
  const id = randomUUID()
  db.prepare('INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    'device_id',
    id,
    nowIso(),
  )
  return id
}

const DDL_V1 = `
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL CHECK (length(trim(title)) > 0),
  subtitle      TEXT NOT NULL DEFAULT '',
  author        TEXT NOT NULL DEFAULT '',
  genre         TEXT NOT NULL DEFAULT '',
  series_id     TEXT,
  cover_path    TEXT,
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'writing', 'finished', 'archived')),
  word_count    INTEGER NOT NULL DEFAULT 0 CHECK (word_count >= 0),
  chapter_count INTEGER NOT NULL DEFAULT 0 CHECK (chapter_count >= 0),
  rev           INTEGER NOT NULL DEFAULT 1 CHECK (rev > 0),
  device_id     TEXT NOT NULL DEFAULT 'local',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_series  ON projects (series_id);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects (updated_at DESC);

CREATE TABLE IF NOT EXISTS change_log (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_table TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  op           TEXT NOT NULL CHECK (op IN ('insert', 'update', 'delete')),
  rev          INTEGER NOT NULL,
  device_id    TEXT NOT NULL,
  changed_at   TEXT NOT NULL,
  payload      TEXT
);
CREATE INDEX IF NOT EXISTS idx_change_log_entity ON change_log (entity_table, entity_id);
`

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined
  return typeof row?.user_version === 'number' ? row.user_version : 0
}

function migrate(db: DatabaseSync, log: (message: string) => void): void {
  const version = readUserVersion(db)
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `inkflow: database schema v${version} is newer than this plugin (v${SCHEMA_VERSION}); refusing to open it`,
    )
  }
  if (version < 1) {
    db.exec('BEGIN')
    try {
      db.exec(DDL_V1)
      db.exec(`PRAGMA user_version = 1`)
      db.exec('COMMIT')
      log('schema migrated to v1')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}

export interface Database {
  readonly db: DatabaseSync
  readonly deviceId: string
  close(): void
}

/**
 * Open (creating if needed) the plugin database.
 *
 * Fails loudly: a plugin that cannot persist novel data must not pretend to
 * work, so the caller lets the activation error surface in the DSH log.
 */
export function openDatabase(dbFile: string, log: (message: string) => void = () => {}): Database {
  mkdirSync(dirname(dbFile), { recursive: true })
  const db = new DatabaseSync(dbFile)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db, log)
  const deviceId = resolveDeviceId(db)
  return {
    db,
    deviceId,
    close: () => {
      db.close()
    },
  }
}

/** Append a change_log row. `payload` is the JSON snapshot used by a future sync. */
function recordChange(
  handle: Database,
  table: string,
  id: string,
  op: 'insert' | 'update' | 'delete',
  rev: number,
  payload?: unknown,
): void {
  handle.db
    .prepare(
      `INSERT INTO change_log (entity_table, entity_id, op, rev, device_id, changed_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      table,
      id,
      op,
      rev,
      handle.deviceId,
      nowIso(),
      payload === undefined ? null : JSON.stringify(payload),
    )
}

export function createProject(handle: Database, input: ProjectInput): ProjectRow {
  const title = input.title.trim()
  if (title === '') throw new Error('inkflow: project title must not be empty')
  const now = nowIso()
  const row: ProjectRow = {
    id: randomUUID(),
    title,
    subtitle: (input.subtitle ?? '').trim(),
    author: (input.author ?? '').trim(),
    genre: (input.genre ?? '').trim(),
    series_id: input.seriesId ?? null,
    cover_path: null,
    status: 'draft',
    word_count: 0,
    chapter_count: 0,
    rev: 1,
    device_id: handle.deviceId,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  }
  handle.db
    .prepare(
      `INSERT INTO projects
         (id, title, subtitle, author, genre, series_id, cover_path, status,
          word_count, chapter_count, rev, device_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.title,
      row.subtitle,
      row.author,
      row.genre,
      row.series_id,
      row.cover_path,
      row.status,
      row.word_count,
      row.chapter_count,
      row.rev,
      row.device_id,
      row.created_at,
      row.updated_at,
      row.deleted_at,
    )
  recordChange(handle, 'projects', row.id, 'insert', row.rev, row)
  return row
}

export interface ListProjectsOptions {
  includeArchived?: boolean
  limit?: number
}

export function listProjects(handle: Database, options: ListProjectsOptions = {}): ProjectRow[] {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
  const where = options.includeArchived
    ? 'deleted_at IS NULL'
    : "deleted_at IS NULL AND status <> 'archived'"
  return handle.db
    .prepare(`SELECT * FROM projects WHERE ${where} ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as unknown as ProjectRow[]
}

export function countProjects(handle: Database): number {
  const row = handle.db
    .prepare('SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NULL')
    .get() as { n?: unknown } | undefined
  return typeof row?.n === 'number' ? row.n : 0
}

export function getProject(handle: Database, id: string): ProjectRow | undefined {
  const row = handle.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
    | ProjectRow
    | undefined
  return row
}
