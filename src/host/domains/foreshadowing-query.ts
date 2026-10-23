/**
 * Reading foreshadows back out of the derived index, and the board the panel shows
 * (#31).
 *
 * Same policy as `character-query.ts` / `query.ts`: the index is a cache, so a
 * missing or foreign-schema database answers `undefined` and the caller says
 * "cannot answer" — never a partial list that looks complete.
 *
 * Two readers, deliberately:
 *
 *   * the **index** (`foreshadowings` + `chapters`) answers the tool and the board.
 *     Chapter order comes from the `chapters` rows, not from file names, so `vol-10`
 *     sorts after `vol-02` (data-model §3.2.2).
 *   * the **files** answer the writing-context reminder, because the first chapter of
 *     a fresh book may be written before any index exists. That path reads only the
 *     two directories it needs.
 *
 * `overdue` is computed per call from the chapter being asked about; nothing here
 * writes, and nothing caches a computed state.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { INDEX_SCHEMA_VERSION } from '../conventions.js'
import { intField, parseMarkdown, stringField } from '../frontmatter.js'
import { ensureIndex } from '../index-freshness.js'
import { indexPaths, walkProjectFiles } from '../indexer.js'
import type { ForeshadowRow } from './foreshadowing-plan.js'
import {
  FORESHADOW_TABLE,
  comparePosition,
  foreshadowUrgency,
  parseForeshadowFile,
  volumeOrderOf,
} from './foreshadowing-plan.js'
import type { ChapterPosition, ForeshadowStatus } from './foreshadowing-plan.js'
import type { ExtraSegmentInput, ExtraSegmentSpec } from '../writing-context.js'
import { splitTerms } from './scan-helpers.js'

/** A plain JSON payload, the channel's envelope half. */
type JsonRecord = Record<string, unknown>

/** The two fields the board needs from a resolved request; typed narrowly so this
 * module never imports back into the channel layer that re-exports it. */
export interface ForeshadowSource {
  sessionId: string
  root: string
}

/** One entry as the tool and the panel carry it: the row plus the computed state. */
export interface ForeshadowItem {
  readonly id: string
  readonly title: string
  readonly file: string
  /** The board's state (`overdue` when computed late). */
  readonly status: ForeshadowStatus
  /** What the file says — they differ exactly when the computed mark wins. */
  readonly declaredStatus: ForeshadowStatus
  readonly overdue: boolean
  readonly dueNow: boolean
  readonly dueBy: string | null
  readonly dueKind: string | null
  readonly plantedAt: string | null
  readonly advancedAt: readonly string[]
  readonly resolvedChapter: string | null
  readonly linkedEntities: readonly string[]
}

export interface ForeshadowCounts {
  readonly total: number
  readonly unresolved: number
  readonly resolved: number
  readonly overdue: number
  readonly dueNow: number
}

export interface ForeshadowView {
  readonly currentChapter: ChapterPosition | undefined
  readonly items: readonly ForeshadowItem[]
  readonly counts: ForeshadowCounts
}

export type ForeshadowViewResult =
  | { readonly ok: true; readonly view: ForeshadowView }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

const MAX_LIMIT = 500

function openIndex(root: string): DatabaseSync | undefined {
  const { dbFile } = indexPaths(root)
  if (!existsSync(dbFile)) return undefined
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbFile, { readOnly: true })
    const version = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    if (version?.user_version !== INDEX_SCHEMA_VERSION) {
      db.close()
      return undefined
    }
    return db
  } catch {
    db?.close()
    return undefined
  }
}

/** Every foreshadow row, or `undefined` when the index cannot be read. */
export function listForeshadowings(root: string): ForeshadowRow[] | undefined {
  const db = openIndex(root)
  if (db === undefined) return undefined
  try {
    const rows = db
      .prepare(
        `SELECT id, path, title, status, planted_at, advanced_at, due_by, resolved_chapter, linked_entities FROM ${FORESHADOW_TABLE} ORDER BY path`,
      )
      .all() as unknown as Array<Record<string, unknown>>
    return rows.map((row) => {
      const status = String(row['status'] ?? 'planted') as ForeshadowStatus
      const plantedAt = row['planted_at']
      const dueBy = row['due_by']
      const resolvedChapter = row['resolved_chapter']
      const row_: ForeshadowRow = {
        id: String(row['id']),
        path: String(row['path']),
        title: String(row['title'] ?? ''),
        status,
        advancedAt: splitTerms(typeof row['advanced_at'] === 'string' ? row['advanced_at'] : undefined),
        linkedEntities: splitTerms(typeof row['linked_entities'] === 'string' ? row['linked_entities'] : undefined),
        ...(typeof plantedAt === 'string' ? { plantedAt } : {}),
        ...(typeof dueBy === 'string' ? { dueBy } : {}),
        ...(typeof resolvedChapter === 'string' ? { resolvedChapter } : {}),
      }
      return row_
    })
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

/**
 * Chapter positions, keyed by **both** the chapter id and its project-relative path.
 *
 * The index answers when it can (one query); a book with no index falls back to
 * reading the chapter frontmatter, which is what a fresh project looks like. The
 * fallback is the only reason this module reads files at all.
 */
export function chapterPositions(root: string): Map<string, ChapterPosition> {
  const fromIndex = chapterPositionsFromIndex(root)
  return fromIndex ?? chapterPositionsFromFiles(root)
}

function chapterPositionsFromIndex(root: string): Map<string, ChapterPosition> | undefined {
  const db = openIndex(root)
  if (db === undefined) return undefined
  try {
    const rows = db
      .prepare('SELECT id, path, seq, title, volume FROM chapters WHERE seq IS NOT NULL ORDER BY path')
      .all() as unknown as Array<Record<string, unknown>>
    const positions = new Map<string, ChapterPosition>()
    for (const row of rows) {
      const position = positionOf({
        id: String(row['id']),
        path: String(row['path']),
        title: String(row['title'] ?? ''),
        ...(typeof row['volume'] === 'string' ? { volume: row['volume'] } : {}),
        seq: typeof row['seq'] === 'number' ? row['seq'] : 1,
      })
      positions.set(position.id, position)
      positions.set(position.path, position)
    }
    return positions
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

function chapterPositionsFromFiles(root: string): Map<string, ChapterPosition> {
  const positions = new Map<string, ChapterPosition>()
  let files: ReturnType<typeof walkProjectFiles>
  try {
    files = walkProjectFiles(root)
  } catch {
    return positions
  }
  for (const file of files) {
    if (file.dir !== 'chapters' || !file.path.toLowerCase().endsWith('.md')) continue
    let data: Record<string, unknown>
    try {
      data = parseMarkdown(readFileSync(join(root, file.path), 'utf8')).data
    } catch {
      continue
    }
    const leading = /^(\d+)/.exec(file.path.split('/').pop() ?? '')?.[1]
    const seq = intField(data, 'seq') ?? (leading === undefined ? 1 : Number(leading))
    const volume = stringField(data, 'volume')
    const position = positionOf({
      id: stringField(data, 'id') ?? file.path,
      path: file.path,
      title: stringField(data, 'title') ?? '',
      ...(volume === undefined ? {} : { volume }),
      seq,
    })
    positions.set(position.id, position)
    positions.set(position.path, position)
  }
  return positions
}

function positionOf(input: {
  id: string
  path: string
  title: string
  volume?: string
  seq: number
}): ChapterPosition {
  return {
    id: input.id,
    path: input.path,
    title: input.title,
    ...(input.volume === undefined ? {} : { volume: input.volume }),
    seq: input.seq,
    order: volumeOrderOf(input.volume),
  }
}

/** The furthest chapter in the book: the default "where are we now". */
export function latestChapter(positions: ReadonlyMap<string, ChapterPosition>): ChapterPosition | undefined {
  let latest: ChapterPosition | undefined
  for (const position of positions.values()) {
    if (latest === undefined || comparePosition(position, latest) > 0) latest = position
  }
  return latest
}

function toItem(row: ForeshadowRow, current: ChapterPosition | undefined, positions: ReadonlyMap<string, ChapterPosition>): ForeshadowItem {
  const urgency = foreshadowUrgency(row, current, positions)
  return {
    id: row.id,
    title: row.title,
    file: row.path,
    status: urgency.status,
    declaredStatus: urgency.declaredStatus,
    overdue: urgency.overdue,
    dueNow: urgency.dueNow,
    dueBy: row.dueBy ?? null,
    dueKind: urgency.dueKind ?? null,
    plantedAt: row.plantedAt ?? null,
    advancedAt: [...row.advancedAt],
    resolvedChapter: row.resolvedChapter ?? null,
    linkedEntities: [...row.linkedEntities],
  }
}

function countOf(items: readonly ForeshadowItem[]): ForeshadowCounts {
  return {
    total: items.length,
    unresolved: items.filter((item) => item.status !== 'resolved').length,
    resolved: items.filter((item) => item.status === 'resolved').length,
    overdue: items.filter((item) => item.overdue).length,
    dueNow: items.filter((item) => item.dueNow).length,
  }
}

/**
 * The tool's and the board's one answer: every foreshadow with its computed state, as
 * of `options.chapter` (a chapter id or path) or of the furthest chapter.
 */
export function readForeshadowView(root: string, options: { chapter?: string } = {}): ForeshadowViewResult {
  const rows = listForeshadowings(root)
  if (rows === undefined) {
    return {
      ok: false,
      error: { code: 'INDEX_UNAVAILABLE', message: 'the derived index could not be read; rebuild it and retry' },
    }
  }
  const positions = chapterPositions(root)
  let current = latestChapter(positions)
  const asked = (options.chapter ?? '').trim()
  if (asked !== '') {
    const found = positions.get(asked)
    if (found === undefined) {
      return { ok: false, error: { code: 'CHAPTER_INVALID', message: `no chapter "${asked}" in this book` } }
    }
    current = found
  }
  const items = rows.slice(0, MAX_LIMIT).map((row) => toItem(row, current, positions))
  return { ok: true, view: { currentChapter: current, items, counts: countOf(items) } }
}

/**
 * What the chapter being written should pay off (roadmap X-13's `foreshadow` segment).
 *
 * Reads the files rather than the index: a fresh book has no index yet, and the
 * reminder is exactly what a session needs *before* its first write. Overdue entries
 * come first — they are the ones a reader has already been waiting on — then the ones
 * due in this very chapter.
 */
export function foreshadowReminders(
  root: string,
  current: ChapterPosition | undefined,
  limit = 5,
): ForeshadowItem[] {
  if (current === undefined) return []
  const rows = readForeshadowRowsFromFiles(root)
  const positions = chapterPositions(root)
  // The walked view is authoritative for the reminder; the index may legitimately not
  // exist yet, so `positions` here is only used to resolve `dueBy`.
  const items = rows.map((row) => toItem(row, current, positions))
  const due = items.filter((item) => item.status !== 'resolved' && (item.overdue || item.dueNow))
  due.sort((left, right) => Number(right.overdue) - Number(left.overdue) || left.file.localeCompare(right.file))
  return due.slice(0, limit)
}

function readForeshadowRowsFromFiles(root: string): ForeshadowRow[] {
  let files: ReturnType<typeof walkProjectFiles>
  try {
    files = walkProjectFiles(root)
  } catch {
    return []
  }
  const rows: ForeshadowRow[] = []
  for (const file of files) {
    if (file.dir !== 'foreshadowing' || !file.path.toLowerCase().endsWith('.md')) continue
    let text: string
    try {
      text = readFileSync(join(root, file.path), 'utf8')
    } catch {
      continue
    }
    // The same parser the scan and the write path use: one meaning per file (X-4).
    const parsed = parseForeshadowFile(file.path, text)
    if (parsed.row !== undefined) rows.push(parsed.row)
  }
  return rows
}

// ---------------------------------------------------------------------------
// The panel projection
// ---------------------------------------------------------------------------

export interface ForeshadowEntityGroup {
  readonly id: string | null
  readonly title: string
  readonly kind: string | null
  readonly items: readonly ForeshadowItem[]
}

/**
 * `GET /inkflow/internal/foreshadow` — the read-only board.
 *
 * Three groupings, all of them the same items from three angles: what is still open,
 * what is late, and which character/world entry each setup hangs on. The client
 * groups again for display; sending the three views means the panel never has to
 * reimplement "late" (data-model §3.2.2 is the only definition of it).
 */
export async function buildForeshadowBoard(source: ForeshadowSource, version: string): Promise<JsonRecord> {
  const ensured = await ensureIndex(source.root)
  if (!ensured.ok) {
    // "Cannot answer" is not "no foreshadows": the payload keeps its shape and says
    // so, exactly like the library tree does when the index is unreadable.
    return {
      pluginVersion: version,
      sessionId: source.sessionId,
      currentChapter: null,
      indexAvailable: false,
      counts: null,
      groups: null,
      indexError: { code: ensured.failure.code, message: ensured.failure.message },
      indexRebuilt: false,
      indexState: ensured.state,
    }
  }
  const read = readForeshadowView(source.root)
  if (!read.ok) {
    return {
      pluginVersion: version,
      sessionId: source.sessionId,
      currentChapter: null,
      indexAvailable: false,
      counts: null,
      groups: null,
      indexError: { code: read.error.code, message: read.error.message },
      indexRebuilt: ensured.rebuilt,
      indexState: ensured.state,
    }
  }

  const { view } = read
  const titles = entityTitles(source.root, view.items)
  const unresolved = view.items.filter((item) => item.status !== 'resolved')
  const overdue = view.items.filter((item) => item.overdue)

  const groups = new Map<string | null, ForeshadowItem[]>()
  for (const item of view.items) {
    const keys: (string | null)[] = item.linkedEntities.length === 0 ? [null] : [...item.linkedEntities]
    for (const key of keys) {
      const bucket = groups.get(key)
      if (bucket === undefined) groups.set(key, [item])
      else bucket.push(item)
    }
  }
  const byEntity: ForeshadowEntityGroup[] = [...groups.entries()]
    .map(([id, items]) => {
      const known = id === null ? undefined : titles.get(id)
      return {
        id,
        title: id === null ? '未关联条目' : (known?.title ?? id),
        kind: known?.kind ?? null,
        items,
      }
    })
    .sort((left, right) => (left.id ?? '').localeCompare(right.id ?? ''))

  return {
    pluginVersion: version,
    sessionId: source.sessionId,
    currentChapter: jsonChapter(view.currentChapter),
    indexAvailable: true,
    counts: view.counts,
    groups: {
      unresolved: unresolved.map((item) => ({ ...item })),
      overdue: overdue.map((item) => ({ ...item })),
      byEntity: byEntity.map((group) => ({ ...group, items: group.items.map((item) => ({ ...item })) })),
    },
    indexRebuilt: ensured.rebuilt,
    indexState: ensured.state,
  }
}

function jsonChapter(position: ChapterPosition | undefined): JsonRecord | null {
  if (position === undefined) return null
  return {
    id: position.id,
    title: position.title,
    volume: position.volume ?? null,
    seq: position.seq,
    path: position.path,
  }
}

/** Titles and kinds for the entities a foreshadow links to; unknown ids fall back to the id. */
function entityTitles(root: string, items: readonly ForeshadowItem[]): Map<string, { title: string; kind: string }> {
  const wanted = new Set<string>()
  for (const item of items) for (const id of item.linkedEntities) wanted.add(id)
  const found = new Map<string, { title: string; kind: string }>()
  if (wanted.size === 0) return found
  const db = openIndex(root)
  if (db === undefined) return found
  try {
    const statement = db.prepare('SELECT kind, title FROM entities WHERE id = ? LIMIT 1')
    for (const id of wanted) {
      const row = statement.get(id) as { kind?: unknown; title?: unknown } | undefined
      if (row === undefined) continue
      found.set(id, { title: String(row.title ?? id), kind: String(row.kind ?? '') })
    }
    return found
  } catch {
    return found
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// The writing-context segment (roadmap X-13)
// ---------------------------------------------------------------------------

/**
 * Where the chapter being written sits in the book.
 *
 * Built from the `ChapterHead` the renderer already resolved — not from a re-read of
 * the catalog — so the reminder can never disagree with the chapter the rest of the
 * context describes. `seq` falls back to the file name's leading number, the same
 * convention the chapter parser uses.
 */
function positionOfCurrent(input: ExtraSegmentInput, known: ReadonlyMap<string, ChapterPosition>): ChapterPosition | undefined {
  const current = input.current
  if (current === undefined) return undefined
  const found = known.get(current.path)
  if (found !== undefined) return found
  const leading = /^(\d+)/.exec(current.path.split('/').pop() ?? '')?.[1]
  const seq = current.seq ?? (leading === undefined ? 1 : Number(leading))
  return {
    id: current.path,
    path: current.path,
    title: current.title ?? '',
    ...(current.volume === undefined ? {} : { volume: current.volume }),
    seq,
    order: volumeOrderOf(current.volume),
  }
}

function describeReminders(items: ReturnType<typeof foreshadowReminders>, position: ChapterPosition): string {
  const lines = [`本章建议回收 ${String(items.length)} 条（第 ${String(position.seq)} 章）：`]
  for (const item of items) {
    if (item.overdue) {
      lines.push(`- [超期] ${item.title} — 应在 ${item.dueBy ?? '?'} 回收，已经越过（${item.file}）`)
    } else {
      lines.push(`- [本期] ${item.title} — 本章到期（${item.file}）`)
    }
  }
  return lines.join('\n')
}

/**
 * The `foreshadow` segment: what this chapter should pay off.
 *
 * Overdue entries first (a reader has already been waiting on those), then the ones
 * due in this very chapter; at most five, because a reminder longer than the chapter
 * outline is noise. `undefined` when there is nothing to pay off — an empty heading in
 * every prompt would teach the model to ignore the section.
 */
export const foreshadowSegment: ExtraSegmentSpec = {
  name: 'foreshadow',
  label: '伏笔提示',
  capRatio: 0.1,
  build(input: ExtraSegmentInput): string | undefined {
    const known = chapterPositions(input.root)
    const position = positionOfCurrent(input, known)
    if (position === undefined) return undefined
    const items = foreshadowReminders(input.root, position, 5)
    if (items.length === 0) return undefined
    return `### 伏笔提示\n${describeReminders(items, position)}`
  },
}
