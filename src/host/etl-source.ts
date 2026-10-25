/**
 * Reading the **old** InkFlow database (roadmap X-29).
 *
 * The legacy library is a 43-table SQLite file (`D:\小说\inkflow\inkflow.db` on this
 * machine: 12.6 MB, 59 万字, 106 projects). This module reads the **13 content tables**
 * out of it and nothing else — no writing, no schema creation, no index, and the
 * connection is opened `readOnly` so a bug here cannot damage the source.
 *
 * Why a separate module: the mapping (`etl-plan.ts`) is pure and must stay testable
 * without a database, and the apply path (`etl.ts`) must stay testable without the
 * mapping. Reading is the only place that knows the legacy column names.
 *
 * Two legacy facts drive the shape of this file:
 *
 *   1. **Columns appear over time.** The old app shipped 52 `ensure_*` patches, so a
 *      two-year-old database legitimately lacks `chapters.uuid` or
 *      `foreshadowings.first_chapter_id`. Every read therefore goes through
 *      `selectPresent()`, which projects only the columns the file actually has and
 *      reports the missing ones — raising on a missing column would make the migrator
 *      refuse exactly the oldest books.
 *   2. **Everything hangs off `projects.id`, an integer proxy key** (ADR-0002's own
 *      lesson), while the outside world refers to `uuid`. The caller addresses a
 *      project by uuid, name or number; the rows keep the integer.
 */

import { DatabaseSync } from 'node:sqlite'

/** The 13 legacy tables that carry content for one book (「13 核心表」). */
export const ETL_TABLES = [
  'volumes',
  'chapters',
  'chapter_summaries',
  'characters',
  'character_groups',
  'world_categories',
  'world_settings',
  'outlines',
  'plot_points',
  'story_arcs',
  'foreshadowings',
  'timeline_events',
  'knowledge_relations',
] as const

export type EtlTable = (typeof ETL_TABLES)[number]

/** One project row, as far as the selector needs it. */
export interface LegacyProject {
  readonly id: number
  readonly uuid: string | undefined
  readonly name: string
  readonly language: string | undefined
  readonly targetWords: number | undefined
  readonly isDeleted: boolean
}

export interface LegacyVolume {
  readonly id: number
  readonly title: string
  readonly orderIndex: number
}

export interface LegacyChapter {
  readonly id: number
  readonly uuid: string | undefined
  readonly volumeId: number | null
  readonly title: string
  readonly content: string
  readonly status: string
  readonly orderIndex: number
}

export interface LegacySummary {
  readonly id: number
  readonly chapterId: number
  readonly summary: string
}

export interface LegacyCharacter {
  readonly id: number
  readonly uuid: string | undefined
  readonly name: string
  readonly personality: string
  readonly background: string
  readonly goals: string
  readonly brief: string
}

export interface LegacyGroup {
  readonly id: number
  readonly name: string
  readonly description: string
  readonly sortOrder: number
}

export interface LegacyCategory {
  readonly id: number
  readonly name: string
  readonly kind: string
}

export interface LegacyWorld {
  readonly id: number
  readonly uuid: string | undefined
  readonly name: string
  readonly parentId: number | null
  readonly category: string
  readonly content: string
}

export interface LegacyOutline {
  readonly id: number
  readonly uuid: string | undefined
  readonly name: string
  readonly description: string
  readonly sortOrder: number
  readonly level: string
  readonly parentId: number | null
  readonly chapterId: number | null
  readonly volumeId: number | null
}

export interface LegacyPlotPoint {
  readonly id: number
  readonly outlineId: number
  readonly name: string
  readonly type: string
  readonly description: string
  readonly position: number
  readonly arcId: number | null
}

export interface LegacyArc {
  readonly id: number
  readonly name: string
  readonly description: string
}

export interface LegacyForeshadow {
  readonly id: number
  readonly title: string
  readonly description: string
  readonly status: string
  readonly priority: number
  readonly location: string
  readonly firstChapterId: number | null
  readonly resolvedAt: string | null
}

export interface LegacyTimelineEvent {
  readonly id: number
  readonly title: string
  readonly description: string
  readonly timeDisplay: string
  readonly timeUnit: string
  readonly timeValue: number | null
  readonly era: string
  readonly narrativePosition: number
  readonly sourceChapterId: number | null
}

export interface LegacyRelation {
  readonly id: number
  readonly sourceType: string
  readonly sourceId: number
  readonly targetType: string
  readonly targetId: number
  readonly relationType: string
  readonly description: string
}

/** Everything one book's rows look like, in the shapes the mapper wants. */
export interface LegacyBook {
  /** The file these rows were read from (absolute, as given) — the report names it. */
  readonly sourceDb: string
  readonly project: LegacyProject
  readonly volumes: readonly LegacyVolume[]
  readonly chapters: readonly LegacyChapter[]
  readonly summaries: readonly LegacySummary[]
  readonly characters: readonly LegacyCharacter[]
  readonly groups: readonly LegacyGroup[]
  /** `characterId` → group ids it belongs to, in group sort order. */
  readonly groupMembers: ReadonlyMap<number, readonly number[]>
  readonly categories: readonly LegacyCategory[]
  readonly world: readonly LegacyWorld[]
  readonly outlines: readonly LegacyOutline[]
  readonly plotPoints: readonly LegacyPlotPoint[]
  readonly arcs: readonly LegacyArc[]
  readonly foreshadows: readonly LegacyForeshadow[]
  readonly timeline: readonly LegacyTimelineEvent[]
  readonly relations: readonly LegacyRelation[]
  /** Legacy row count per table, for the per-class reconciliation. */
  readonly counts: Readonly<Record<EtlTable, number>>
}

export interface EtlSourceError {
  code: string
  message: string
  hint?: string
  path?: string
}

export type EtlSourceResult = { ok: true; value: LegacyBook } | { ok: false; error: EtlSourceError }
/** `{ok:true, value: projects}` when the caller asked for the project list. */
export type EtlProjectsResult = { ok: true; value: LegacyProject[] } | { ok: false; error: EtlSourceError }

export interface EtlSourceOptions {
  /** Absolute path of the legacy `.db`. Read-only; the file is never created. */
  readonly dbPath: string
  /** `uuid`, integer id or project name. Omitted = the only project that has content. */
  readonly project?: string
}

function fail(code: string, message: string, extra: Partial<EtlSourceError> = {}): { ok: false; error: EtlSourceError } {
  return { ok: false, error: { code, message, ...extra } }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
}

function strOrUndefined(value: unknown): string | undefined {
  const text = str(value)
  return text === '' ? undefined : text
}

function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(parsed) ? parsed : null
}

function intOrNull(value: unknown): number | null {
  const parsed = numOrNull(value)
  return parsed === null ? null : parsed
}

/** A row as it comes out of the driver. */
type Row = Record<string, unknown>

/** The columns a table actually has in this file (`PRAGMA table_info`, cached per query). */
function columnsOf(db: DatabaseSync, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Row[]
    return new Set(rows.map((row) => str(row['name'])))
  } catch {
    return new Set()
  }
}

function hasTable(db: DatabaseSync, table: string): boolean {
  try {
    const row = db.prepare("select name from sqlite_master where type = 'table' and name = ?").get(table) as Row | undefined
    return row !== undefined
  } catch {
    return false
  }
}

/**
 * Read one table with only the columns the file has.
 *
 * Returns `[]` for a table that does not exist at all: an older database simply has no
 * `story_arcs`, and "the table is absent" and "the table is empty" map to the same
 * answer for a migrator (zero rows), with the absence reported separately.
 */
function selectPresent(db: DatabaseSync, table: string, wanted: readonly string[], where?: string, params: readonly unknown[] = []): Row[] {
  if (!hasTable(db, table)) return []
  const present = columnsOf(db, table)
  const selected = wanted.filter((name) => present.has(name))
  if (selected.length === 0) return []
  const sql = `select ${selected.map((name) => `"${name}"`).join(', ')} from "${table}"${where === undefined ? '' : ` where ${where}`}`
  try {
    return db.prepare(sql).all(...(params as never[])) as Row[]
  } catch (cause) {
    throw new Error(`${table}: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

const PROJECT_COLUMNS = ['id', 'uuid', 'name', 'language', 'target_words', 'is_deleted'] as const

/** Every project in the file, newest-first is not useful here: id order is stable. */
function readProjects(db: DatabaseSync): LegacyProject[] {
  const rows = selectPresent(db, 'projects', PROJECT_COLUMNS, undefined)
  return rows
    .map((row) => ({
      id: num(row['id']),
      uuid: strOrUndefined(row['uuid']),
      name: str(row['name']),
      language: strOrUndefined(row['language']),
      targetWords: numOrNull(row['target_words']) ?? undefined,
      isDeleted: num(row['is_deleted']) !== 0,
    }))
    .filter((project) => project.id > 0)
}

/**
 * How many content rows a project has — the selector's tie-breaker.
 *
 * A legacy file holds ~100 projects, most of them test fixtures with one chapter, so
 * "no project named" must not silently pick project 1. The fallback is the project with
 * the most chapters, then the most world entries, then the most characters, then the
 * lowest id: the book somebody actually wrote.
 */
function contentScore(db: DatabaseSync, projectId: number): number {
  const count = (table: string, column: string): number => {
    if (!hasTable(db, table)) return 0
    try {
      const row = db.prepare(`select count(*) c from "${table}" where "${column}" = ?`).get(projectId) as Row | undefined
      return num(row?.['c'])
    } catch {
      return 0
    }
  }
  return count('chapters', 'project_id') * 1000 + count('world_settings', 'project_id') * 10 + count('characters', 'project_id')
}

/** Resolve the selector: uuid (exact), name (exact, then substring), or integer id. */
function pickProject(db: DatabaseSync, projects: readonly LegacyProject[], selector: string | undefined): LegacyProject | undefined {
  if (selector === undefined || selector.trim() === '') {
    const ranked = projects
      .filter((project) => !project.isDeleted)
      .map((project) => ({ project, score: contentScore(db, project.id) }))
      .sort((left, right) => right.score - left.score || left.project.id - right.project.id)
    return ranked[0]?.project
  }
  const wanted = selector.trim()
  const byUuid = projects.find((project) => project.uuid === wanted)
  if (byUuid !== undefined) return byUuid
  const byName = projects.find((project) => project.name === wanted)
  if (byName !== undefined) return byName
  if (/^\d+$/u.test(wanted)) {
    const byId = projects.find((project) => project.id === Number.parseInt(wanted, 10))
    if (byId !== undefined) return byId
  }
  const matches = projects.filter((project) => project.name.includes(wanted))
  return matches.length === 1 ? matches[0] : undefined
}

/** Open the file once, hand the reader a live handle, and close it in `finally`. */
function withDatabase<T>(dbPath: string, body: (db: DatabaseSync) => T): { ok: true; value: T } | { ok: false; error: EtlSourceError } {
  const path = dbPath.trim()
  if (path === '') {
    return fail('ETL_SOURCE_REQUIRED', 'a path to the legacy inkflow.db is required', {
      hint: 'pass sourcePath: the .db file of the old InkFlow data directory (for example …\\inkflow\\inkflow.db)',
    })
  }
  let db: DatabaseSync
  try {
    // `readOnly` is the point: the source is the author's only copy of 59 万字.
    db = new DatabaseSync(path, { readOnly: true })
  } catch (cause) {
    return fail('ETL_SOURCE_UNREADABLE', `the legacy database could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`, {
      path,
      hint: 'check the path; the migrator opens the file read-only and never creates it',
    })
  }
  try {
    return { ok: true, value: body(db) }
  } catch (cause) {
    // A refusal raised inside the body (`ETL_PROJECT_NOT_FOUND`) keeps its own code and
    // hint: turning it into "unreadable file" would tell the caller to check a path that
    // is demonstrably fine.
    const carried = cause as { etlCode?: string; etlHint?: string; message?: string }
    const message = carried.message ?? String(cause)
    if (typeof carried.etlCode === 'string') {
      return fail(carried.etlCode, message, { path, ...(typeof carried.etlHint === 'string' ? { hint: carried.etlHint } : {}) })
    }
    return fail('ETL_SOURCE_INVALID', `the legacy database could not be read: ${message}`, {
      path,
      hint: 'the file must be an old InkFlow database (a `projects` table plus the 13 content tables); it is opened read-only',
    })
  } finally {
    try {
      db.close()
    } catch {
      // Closing a read-only handle cannot lose data; a failure here is not worth a code.
    }
  }
}

/** The projects a caller can choose between (for a helpful ETL_PROJECT_NOT_FOUND). */
export function listLegacyProjects(dbPath: string): EtlProjectsResult {
  return withDatabase(dbPath, (db) => {
    if (!hasTable(db, 'projects')) throw new Error('no `projects` table: this is not an old InkFlow database')
    return readProjects(db)
  })
}

/**
 * Read one book's 13 tables.
 *
 * Ordering is fixed everywhere (`order_index`, then `id`; world entries by `id` after
 * their parents) because the plan token and the file names must be reproducible: the
 * same database has to produce the same plan on every run, or "dry-run equals apply"
 * is untestable.
 */
export function readLegacyBook(options: EtlSourceOptions): EtlSourceResult {
  const dbPath = options.dbPath
  return withDatabase(dbPath, (db) => {
    if (!hasTable(db, 'projects')) throw new Error('no `projects` table: this is not an old InkFlow database')
    const projects = readProjects(db)
    const project = pickProject(db, projects, options.project)
    if (project === undefined) {
      throw Object.assign(new Error('project not found'), {
        etlCode: 'ETL_PROJECT_NOT_FOUND',
        etlHint:
          options.project === undefined
            ? 'the database has no project with content'
            : `no project matched "${String(options.project)}" — pass its uuid, its exact name or its number`,
      })
    }
    const id = project.id

    const volumes = selectPresent(
      db,
      'volumes',
      ['id', 'title', 'order_index'],
      'project_id = ? order by order_index, id',
      [id],
    ).map((row) => ({ id: num(row['id']), title: str(row['title']), orderIndex: num(row['order_index']) }))

    const chapters = selectPresent(
      db,
      'chapters',
      ['id', 'uuid', 'volume_id', 'title', 'content', 'status', 'order_index'],
      'project_id = ? order by order_index, id',
      [id],
    ).map((row) => ({
      id: num(row['id']),
      uuid: strOrUndefined(row['uuid']),
      volumeId: intOrNull(row['volume_id']),
      title: str(row['title']),
      content: str(row['content']),
      status: str(row['status']),
      orderIndex: num(row['order_index']),
    }))

    const chapterIds = new Set(chapters.map((chapter) => chapter.id))
    const summaries = selectPresent(db, 'chapter_summaries', ['id', 'chapter_id', 'summary'], undefined)
      .map((row) => ({ id: num(row['id']), chapterId: num(row['chapter_id']), summary: str(row['summary']) }))
      .filter((summary) => chapterIds.has(summary.chapterId))
      .sort((left, right) => left.chapterId - right.chapterId || left.id - right.id)

    const characters = selectPresent(
      db,
      'characters',
      ['id', 'uuid', 'name', 'personality', 'background', 'goals', 'brief'],
      'project_id = ? order by id',
      [id],
    ).map((row) => ({
      id: num(row['id']),
      uuid: strOrUndefined(row['uuid']),
      name: str(row['name']),
      personality: str(row['personality']),
      background: str(row['background']),
      goals: str(row['goals']),
      brief: str(row['brief']),
    }))

    const groups = selectPresent(db, 'character_groups', ['id', 'name', 'description', 'sort_order'], 'project_id = ? order by sort_order, id', [
      id,
    ]).map((row) => ({ id: num(row['id']), name: str(row['name']), description: str(row['description']), sortOrder: num(row['sort_order']) }))

    const groupMembers = new Map<number, number[]>()
    const groupIds = new Set(groups.map((group) => group.id))
    const characterIds = new Set(characters.map((character) => character.id))
    for (const row of selectPresent(db, 'character_group_members', ['character_id', 'group_id'], undefined)) {
      const characterId = num(row['character_id'])
      const groupId = num(row['group_id'])
      if (!characterIds.has(characterId) || !groupIds.has(groupId)) continue
      const list = groupMembers.get(characterId) ?? []
      list.push(groupId)
      groupMembers.set(characterId, list)
    }

    const categories = selectPresent(db, 'world_categories', ['id', 'name', 'kind'], 'project_id = ? order by id', [id]).map((row) => ({
      id: num(row['id']),
      name: str(row['name']),
      kind: str(row['kind']),
    }))

    const world = selectPresent(
      db,
      'world_settings',
      ['id', 'uuid', 'name', 'parent_id', 'category', 'content'],
      'project_id = ? order by id',
      [id],
    ).map((row) => ({
      id: num(row['id']),
      uuid: strOrUndefined(row['uuid']),
      name: str(row['name']),
      parentId: intOrNull(row['parent_id']),
      category: str(row['category']),
      content: str(row['content']),
    }))

    const outlines = selectPresent(
      db,
      'outlines',
      ['id', 'uuid', 'name', 'description', 'sort_order', 'level', 'parent_id', 'chapter_id', 'volume_id'],
      'project_id = ? order by sort_order, id',
      [id],
    ).map((row) => ({
      id: num(row['id']),
      uuid: strOrUndefined(row['uuid']),
      name: str(row['name']),
      description: str(row['description']),
      sortOrder: num(row['sort_order']),
      level: str(row['level']),
      parentId: intOrNull(row['parent_id']),
      chapterId: intOrNull(row['chapter_id']),
      volumeId: intOrNull(row['volume_id']),
    }))
    const outlineIds = new Set(outlines.map((outline) => outline.id))

    const plotPoints = selectPresent(
      db,
      'plot_points',
      ['id', 'outline_id', 'name', 'type', 'description', 'position', 'arc_id'],
      'project_id = ? order by position, id',
      [id],
    )
      .map((row) => ({
        id: num(row['id']),
        outlineId: num(row['outline_id']),
        name: str(row['name']),
        type: str(row['type']),
        description: str(row['description']),
        position: num(row['position']),
        arcId: intOrNull(row['arc_id']),
      }))
      .filter((point) => outlineIds.has(point.outlineId))

    const arcs = selectPresent(db, 'story_arcs', ['id', 'name', 'description'], 'project_id = ? order by id', [id]).map((row) => ({
      id: num(row['id']),
      name: str(row['name']),
      description: str(row['description']),
    }))

    const foreshadows = selectPresent(
      db,
      'foreshadowings',
      ['id', 'title', 'description', 'status', 'priority', 'location', 'first_chapter_id', 'resolved_at'],
      'project_id = ? order by id',
      [id],
    ).map((row) => ({
      id: num(row['id']),
      title: str(row['title']),
      description: str(row['description']),
      status: str(row['status']),
      priority: num(row['priority']),
      location: str(row['location']),
      firstChapterId: intOrNull(row['first_chapter_id']),
      resolvedAt: strOrUndefined(row['resolved_at']) ?? null,
    }))

    const timeline = selectPresent(
      db,
      'timeline_events',
      ['id', 'title', 'description', 'time_display', 'time_unit', 'time_value', 'era', 'narrative_position', 'source_chapter_id'],
      'project_id = ? order by narrative_position, id',
      [id],
    ).map((row) => ({
      id: num(row['id']),
      title: str(row['title']),
      description: str(row['description']),
      timeDisplay: str(row['time_display']),
      timeUnit: str(row['time_unit']),
      timeValue: numOrNull(row['time_value']),
      era: str(row['era']),
      narrativePosition: num(row['narrative_position']),
      sourceChapterId: intOrNull(row['source_chapter_id']),
    }))

    const relations = selectPresent(
      db,
      'knowledge_relations',
      ['id', 'source_type', 'source_id', 'target_type', 'target_id', 'relation_type', 'description'],
      'project_id = ? order by id',
      [id],
    ).map((row) => ({
      id: num(row['id']),
      sourceType: str(row['source_type']),
      sourceId: num(row['source_id']),
      targetType: str(row['target_type']),
      targetId: num(row['target_id']),
      relationType: str(row['relation_type']),
      description: str(row['description']),
    }))

    return {
      sourceDb: dbPath,
      project,
      volumes,
      chapters,
      summaries,
      characters,
      groups,
      groupMembers,
      categories,
      world,
      outlines,
      plotPoints,
      arcs,
      foreshadows,
      timeline,
      relations,
      counts: {
        volumes: volumes.length,
        chapters: chapters.length,
        chapter_summaries: summaries.length,
        characters: characters.length,
        character_groups: groups.length,
        world_categories: categories.length,
        world_settings: world.length,
        outlines: outlines.length,
        plot_points: plotPoints.length,
        story_arcs: arcs.length,
        foreshadowings: foreshadows.length,
        timeline_events: timeline.length,
        knowledge_relations: relations.length,
      },
    } satisfies LegacyBook
  })
}
