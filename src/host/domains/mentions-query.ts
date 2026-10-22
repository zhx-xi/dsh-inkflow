/**
 * Reading `entity_mentions` (#29).
 *
 * Three questions, in the order the product asks them:
 *   `mentionsOf`         — where is this entity named? (jump-to-text, impact list)
 *   `chaptersMentioning` — which chapters, one row each (影响面 / 改名级联)
 *   `absentEntities`     — who stopped appearing after a given chapter (掉线检测)
 *
 * Same contract as `query.ts`: `undefined` means "no usable index" (absent, or
 * built by another schema), never "no rows" — a caller must be able to tell
 * "nothing here" from "rebuild first" instead of showing an empty book.
 *
 * Reads the index directly rather than importing `indexer.ts`, so a panel request
 * never drags the build path (and its writer lock) into the read.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { INDEX_DB_FILE, INDEX_DIR, INDEX_SCHEMA_VERSION } from '../conventions.js'
import { MENTION_SOURCES, MENTIONS_TABLE } from './mentions.js'
import type { MentionSource } from './mentions.js'

const DEFAULT_LIMIT = 500
const MAX_LIMIT = 5000

/** One occurrence, with the chapter it lives in. */
export interface MentionHit {
  /** `kind:id`. */
  readonly entityKey: string
  readonly entityId: string
  readonly chapterId: string
  /** Code-unit offset into the chapter body; negative for a frontmatter mention. */
  readonly offset: number
  /**
   * Every kind of evidence recorded **at this offset**, in {@link MENTION_SOURCES}
   * order.
   *
   * Normally one entry. The table's primary key is
   * `(entity_key, chapter_id, offset, source)`, so a `name` and an `alias` row may share
   * an offset; a consumer that reads a single `source` would then silently drop the
   * other one.
   */
  readonly sources: MentionSource[]
  /**
   * Earliest **body** offset of this entity in this chapter, or `undefined` when the
   * chapter only declares it in frontmatter.
   *
   * `offset` alone must not be used to place a caret: an `explicit` row is stored at
   * `-1` because frontmatter has no position inside the body, so a chapter whose only
   * hit is `pov: 清音` reports `offset: -1` with no `firstBodyOffset` at all, and a
   * chapter that declares *and* names the entity reports the prose position here —
   * never `-1`.
   */
  readonly firstBodyOffset?: number
}

export interface MentionQueryOptions {
  /** Restrict to one kind; omitted, the id is looked up across every kind. */
  readonly kind?: string
  readonly limit?: number
}

/** One chapter that names the entity, with its occurrence count. */
export interface MentionChapterHit {
  readonly entityKey: string
  readonly chapterId: string
  readonly title: string
  readonly path: string
  readonly seq: number | null
  readonly mentions: number
  /** Lowest body offset; `null` when the chapter only declares the entity in frontmatter. */
  readonly firstOffset: number | null
}

/** An entity that has no mention after the chapter asked about. */
export interface AbsentEntity {
  readonly entityKey: string
  readonly kind: string
  readonly title: string
  /** The chapter of its last mention; absent only if the entity was never mentioned at all. */
  readonly lastChapterId?: string
  readonly lastSeq?: number
  /**
   * Chapters that came after its last appearance, from any source:
   * **该实体最后一次出场（任何来源）之后又过了多少章；0 表示它在给定章仍在场.**
   */
  readonly missed: number
}

/** Default threshold of {@link AbsentQueryOptions.minMissed}: 掉线 starts at one missed chapter. */
const DEFAULT_MIN_MISSED = 1

export interface AbsentQueryOptions {
  /**
   * How many chapters must have passed since the entity's last appearance before it is
   * reported. Default **1**.
   *
   * `missed: 0` is not an absence — it means the entity is still onstage in
   * `sinceChapter`. Without this threshold a character who is only ever declared in
   * frontmatter (`pov: 清音`, no body hit) is listed as "dropped out" in the very
   * chapter it narrates, which is how the query used to produce false positives. The
   * filter lives here, not in the caller: the list is a **finding** list, and
   * "everything, including the cast that is still present" is what `minMissed: 0` is
   * for.
   */
  readonly minMissed?: number
  readonly limit?: number
}

function clamp(limit: number | undefined): number {
  const value = limit ?? DEFAULT_LIMIT
  return Math.min(Math.max(value, 1), MAX_LIMIT)
}

function openIndex(root: string): DatabaseSync | undefined {
  const dbFile = join(root, INDEX_DIR, INDEX_DB_FILE)
  if (!existsSync(dbFile)) return undefined
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbFile, { readOnly: true })
    const versionRow = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
    if (versionRow?.user_version !== INDEX_SCHEMA_VERSION) {
      db.close()
      return undefined
    }
    return db
  } catch {
    db?.close()
    return undefined
  }
}

/** A stored `source` that is not one of the three known values is data corruption, not a hit. */
function toSource(value: unknown): MentionSource | undefined {
  return (MENTION_SOURCES as readonly string[]).includes(String(value)) ? (String(value) as MentionSource) : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** `characters:c-1` → `c-1`; a key without a kind prefix stays as it is. */
function idOf(entityKey: string): string {
  const separator = entityKey.indexOf(':')
  return separator < 0 ? entityKey : entityKey.slice(separator + 1)
}

/**
 * Every occurrence of one entity, in reading order (chapter seq, then offset).
 *
 * `kind` is optional because a panel row already knows it while a hand-written
 * tool argument may not; without it the id is matched on the `kind:id` suffix, so
 * an id used by two kinds (I-04 allows that) reports both instead of guessing.
 *
 * Two things exist so a caller can act on a hit without second-guessing it:
 *
 *   - rows that share an `offset` are merged into one hit (`sources`), because the
 *     table can hold a `name` and an `alias` row for the same position;
 *   - `firstBodyOffset` carries the earliest position **in the body**, so an
 *     `explicit` hit (stored at `-1`) never becomes a caret placed before the text.
 *     Body offsets also sort before `explicit` inside a chapter — ordering by raw
 *     `offset` would put `-1` first, which is how "jump to the first mention" ended
 *     up pointing at nothing.
 *
 * Occurrences are capped (`limit`, default 500) like every other index list, so a
 * protagonist named thousands of times truncates; when the question is "which
 * chapters", ask {@link chaptersMentioning}, which groups instead of truncating.
 */
export function mentionsOf(
  root: string,
  entityId: string,
  options: MentionQueryOptions = {},
): MentionHit[] | undefined {
  if (entityId.trim() === '') return []
  const db = openIndex(root)
  if (db === undefined) return undefined
  try {
    // `first_body_offset` is a window over this entity's rows in the same chapter, so
    // it stays correct even for an `explicit` row whose chapter also names the entity
    // in prose; `PARTITION BY entity_key` keeps two kinds that share an id apart.
    const columns = `m.entity_key AS entity_key,
                     m.chapter_id AS chapter_id,
                     m.offset AS offset,
                     m.source AS source,
                     MIN(CASE WHEN m.offset >= 0 THEN m.offset END)
                       OVER (PARTITION BY m.entity_key, m.chapter_id) AS first_body_offset`
    const order = 'ORDER BY c.seq IS NULL, c.seq, c.path, m.offset < 0, m.offset'
    const rows =
      options.kind === undefined
        ? (db
            .prepare(
              `SELECT ${columns}
                 FROM ${MENTIONS_TABLE} m
                 LEFT JOIN chapters c ON c.id = m.chapter_id
                WHERE substr(m.entity_key, instr(m.entity_key, ':') + 1) = ?
                ${order}
                LIMIT ?`,
            )
            .all(entityId, clamp(options.limit)) as unknown as Array<Record<string, unknown>>)
        : (db
            .prepare(
              `SELECT ${columns}
                 FROM ${MENTIONS_TABLE} m
                 LEFT JOIN chapters c ON c.id = m.chapter_id
                WHERE m.entity_key = ?
                ${order}
                LIMIT ?`,
            )
            .all(`${options.kind}:${entityId}`, clamp(options.limit)) as unknown as Array<Record<string, unknown>>)

    // Merged by (entity, chapter, offset): the query's ORDER BY keeps equal offsets
    // adjacent, so insertion order still is reading order.
    const merged = new Map<string, MentionHit & { sources: MentionSource[] }>()
    for (const row of rows) {
      const source = toSource(row['source'])
      const entityKey = text(row['entity_key'])
      const chapterId = text(row['chapter_id'])
      if (source === undefined || entityKey === '' || chapterId === '') continue
      const offset = typeof row['offset'] === 'number' ? row['offset'] : -1
      const firstBodyOffset =
        typeof row['first_body_offset'] === 'number' ? row['first_body_offset'] : undefined
      const key = `${entityKey}\u0000${chapterId}\u0000${String(offset)}`
      const existing = merged.get(key)
      if (existing !== undefined) {
        addSource(existing.sources, source)
        continue
      }
      merged.set(key, {
        entityKey,
        entityId: idOf(entityKey),
        chapterId,
        offset,
        sources: [source],
        ...(firstBodyOffset === undefined ? {} : { firstBodyOffset }),
      })
    }
    return [...merged.values()]
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

/** Keep `sources` in `MENTION_SOURCES` order so two reads of one row are comparable. */
function addSource(sources: MentionSource[], source: MentionSource): void {
  if (sources.includes(source)) return
  sources.push(source)
  sources.sort((left, right) => MENTION_SOURCES.indexOf(left) - MENTION_SOURCES.indexOf(right))
}

/**
 * The chapters that name one entity (`kind:id`), one row each.
 *
 * This is the 影响面 / rename-cascade read: change a character's name and the
 * chapters returned here are exactly the ones whose prose still says the old one.
 */
export function chaptersMentioning(root: string, entityKey: string, limit?: number): MentionChapterHit[] | undefined {
  const trimmed = entityKey.trim()
  if (trimmed === '') return []
  const db = openIndex(root)
  if (db === undefined) return undefined
  try {
    const rows = db
      .prepare(
        `SELECT m.entity_key AS entity_key,
                m.chapter_id AS chapter_id,
                COUNT(*) AS n,
                MIN(CASE WHEN m.offset >= 0 THEN m.offset END) AS first_offset,
                c.title AS title,
                c.path AS path,
                c.seq AS seq
           FROM ${MENTIONS_TABLE} m
           LEFT JOIN chapters c ON c.id = m.chapter_id
          WHERE m.entity_key = ?
          GROUP BY m.entity_key, m.chapter_id, c.title, c.path, c.seq
          ORDER BY c.seq IS NULL, c.seq, c.path
          LIMIT ?`,
      )
      .all(trimmed, clamp(limit)) as unknown as Array<Record<string, unknown>>
    return rows.map((row) => ({
      entityKey: text(row['entity_key']),
      chapterId: text(row['chapter_id']),
      title: text(row['title']),
      path: text(row['path']),
      seq: typeof row['seq'] === 'number' ? row['seq'] : null,
      mentions: typeof row['n'] === 'number' ? row['n'] : 0,
      firstOffset: typeof row['first_offset'] === 'number' ? row['first_offset'] : null,
    }))
  } catch {
    return undefined
  } finally {
    db.close()
  }
}

/** Chapters (by seq) that come after `value` — the "how long has it been" count. */
function countAbove(sorted: readonly number[], value: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >> 1
    const current = sorted[middle] ?? 0
    if (current > value) high = middle
    else low = middle + 1
  }
  return sorted.length - low
}

/**
 * Entities with **no mention in any chapter after** `sinceChapter` (掉线检测).
 *
 * `sinceChapter` is a chapter id; its `seq` defines "after", which is narrative
 * order, not file order. `missed` counts the chapters that came after the
 * entity's *own* last appearance — that is the number a writer means by "he has
 * not shown up for N chapters", and it differs per entity even though the filter
 * is one chapter.
 *
 * Entities with no mention at all are deliberately **not** listed: "never used"
 * is a different finding (an unused setting entry), and mixing it in would bury
 * the character who actually dropped out.
 *
 * "After" is strictly after, so an entity that appears in `sinceChapter` itself and
 * nowhere later has `missed: 0` — it did not drop off *before* that chapter, it simply
 * has not been seen since, and it is still onstage. Those rows are therefore filtered
 * out by `minMissed` (default 1); the contract is stated once, here, and the caller
 * gets a finding list rather than a cast list it has to filter itself.
 *
 * `undefined` means the index is unusable, or the chapter is unknown, or the
 * chapter carries no `seq` — in all three cases there is no honest ordering to
 * report, so the caller says so instead of returning an empty list.
 */
export function absentEntities(
  root: string,
  sinceChapter: string,
  options: AbsentQueryOptions = {},
): AbsentEntity[] | undefined {
  const minMissed = Math.max(options.minMissed ?? DEFAULT_MIN_MISSED, 0)
  const db = openIndex(root)
  if (db === undefined) return undefined
  try {
    const chapters = db.prepare('SELECT id, seq FROM chapters').all() as unknown as Array<Record<string, unknown>>
    const sequence = new Map<string, number | null>()
    for (const row of chapters) {
      const id = text(row['id'])
      if (id === '') continue
      sequence.set(id, typeof row['seq'] === 'number' ? row['seq'] : null)
    }
    const sinceSeq = sequence.get(sinceChapter)
    if (sinceSeq === undefined || sinceSeq === null) return undefined

    const ordered = [...sequence.values()].filter((seq): seq is number => typeof seq === 'number').sort((a, b) => a - b)

    // Last appearance per entity: (entity_key, chapter_id) pairs are far fewer than
    // occurrences, so the grouping happens in the database and the max in here.
    const seen = db
      .prepare(
        `SELECT DISTINCT m.entity_key AS entity_key, m.chapter_id AS chapter_id, c.seq AS seq
           FROM ${MENTIONS_TABLE} m
           LEFT JOIN chapters c ON c.id = m.chapter_id`,
      )
      .all() as unknown as Array<Record<string, unknown>>

    interface LastSeen {
      seq?: number
      chapterId: string
    }
    const lastSeen = new Map<string, LastSeen>()
    for (const row of seen) {
      const key = text(row['entity_key'])
      const chapterId = text(row['chapter_id'])
      if (key === '' || chapterId === '') continue
      const seq = typeof row['seq'] === 'number' ? row['seq'] : undefined
      const current = lastSeen.get(key)
      if (current === undefined) {
        lastSeen.set(key, seq === undefined ? { chapterId } : { seq, chapterId })
        continue
      }
      if (seq !== undefined && (current.seq === undefined || seq > current.seq)) {
        lastSeen.set(key, { seq, chapterId })
      }
    }

    const titles = new Map<string, { kind: string; title: string }>()
    const entityRows = db.prepare('SELECT kind, id, title FROM entities').all() as unknown as Array<Record<string, unknown>>
    for (const row of entityRows) {
      const kind = text(row['kind'])
      const id = text(row['id'])
      if (kind === '' || id === '') continue
      titles.set(`${kind}:${id}`, { kind, title: text(row['title']) })
    }

    const absent: AbsentEntity[] = []
    for (const [entityKey, last] of lastSeen) {
      if (last.seq !== undefined && last.seq > sinceSeq) continue
      const missed = last.seq === undefined ? countAbove(ordered, sinceSeq) : countAbove(ordered, last.seq)
      // `missed: 0` means the entity is still onstage in `sinceChapter` itself; only a
      // caller that asked for the whole cast (`minMissed: 0`) wants those rows.
      if (missed < minMissed) continue
      const entity = titles.get(entityKey)
      absent.push({
        entityKey,
        kind: entity?.kind ?? '',
        title: entity?.title ?? idOf(entityKey),
        lastChapterId: last.chapterId,
        ...(last.seq === undefined ? {} : { lastSeq: last.seq }),
        missed,
      })
    }

    absent.sort((left, right) => {
      if (left.missed !== right.missed) return right.missed - left.missed
      return left.entityKey < right.entityKey ? -1 : left.entityKey > right.entityKey ? 1 : 0
    })
    return absent.slice(0, clamp(options.limit))
  } catch {
    return undefined
  } finally {
    db.close()
  }
}
