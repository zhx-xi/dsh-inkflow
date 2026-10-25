/**
 * Reading character cards back out of the derived index.
 *
 * Same policy as `query.ts` / `search.ts`: the index is a cache, so a missing or
 * stale-schema database answers `undefined` and the caller tells the user to
 * rebuild — never a partial answer that looks complete.
 *
 * The per-chapter question ("what was he at chapter 30") is answered from
 * `character_states`: the state **in force** at chapter N is the newest recorded
 * state whose chapter is ≤ N. That is why the states are a table of their own
 * rather than a JSON blob on the card.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { INDEX_DB_FILE, INDEX_DIR, INDEX_SCHEMA_VERSION } from '../conventions.js'
import type { CharacterState } from './character.js'

export interface CharacterSummary {
  readonly id: string
  readonly path: string
  readonly name: string
  readonly aliases: string[]
  readonly group: string | null
  readonly role: string | null
  readonly pov: string | null
  readonly firstAppearance: number | null
  readonly voice: string[]
  /** Every recorded state, ascending by chapter. */
  readonly states: CharacterState[]
  /** The state in force at `options.chapter`; `null` when no chapter was asked or none applies. */
  readonly state: CharacterState | null
}
export interface CharacterListOptions {
  /** Exact group name (`group:` in the card frontmatter). */
  readonly group?: string
  /** Fragment of a name or an alias. */
  readonly query?: string
  /** Chapter number for the "state in force" answer. */
  readonly chapter?: number
  readonly limit?: number
}

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

function clamp(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
}

function openIndex(root: string): DatabaseSync | undefined {
  const dbFile = join(root, INDEX_DIR, INDEX_DB_FILE)
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

/** Parse a JSON text column, tolerating `null` and (defensively) a non-array value. */
function jsonArray<T>(value: unknown): T[] {
  if (typeof value !== 'string' || value === '') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/gu, (match) => `\\${match}`)}%`
}

/**
 * List character cards, optionally filtered by group and by a name/alias fragment,
 * optionally answering the state in force at a chapter.
 *
 * Ordered by name then path so a panel or a model sees the same order across
 * rebuilds (two cards can legitimately share a name only in a broken project, and
 * then the path decides).
 *
 * The states come from `character_states`, the only place the index keeps them:
 * the chapter filter is a real `WHERE chapter <= ?` instead of a JSON scan, which
 * is the whole reason the table exists.
 */
export function listCharacters(
  root: string,
  options: CharacterListOptions = {},
): CharacterSummary[] | undefined {
  const db = openIndex(root)
  if (db === undefined) return undefined
  try {
    const where: string[] = []
    const params: Array<string | number> = []
    const group = options.group?.trim()
    if (group !== undefined && group !== '') {
      where.push('group_name = ?')
      params.push(group)
    }
    const query = options.query?.trim()
    if (query !== undefined && query !== '') {
      where.push(`(name LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\')`)
      params.push(likePattern(query), likePattern(query))
    }
    const sql =
      'SELECT id, path, name, group_name, role, pov, first_appearance, aliases, voice FROM characters' +
      (where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`) +
      ' ORDER BY name, path LIMIT ?'
    const rows = db.prepare(sql).all(...params, clamp(options.limit)) as unknown as Array<Record<string, unknown>>
    if (rows.length === 0) return []

    const ids = rows.map((row) => String(row['id']))
    const placeholders = ids.map(() => '?').join(', ')
    const chapter = options.chapter
    const stateRows = db
      .prepare(
        `SELECT character_id, chapter, status FROM character_states WHERE character_id IN (${placeholders})` +
          (chapter === undefined ? '' : ' AND chapter <= ?') +
          ' ORDER BY character_id, chapter',
      )
      .all(...(chapter === undefined ? ids : [...ids, chapter])) as unknown as Array<Record<string, unknown>>

    const statesById = new Map<string, CharacterState[]>()
    for (const state of stateRows) {
      const id = String(state['character_id'])
      const list = statesById.get(id) ?? []
      list.push({ chapter: Number(state['chapter']), status: String(state['status']) })
      statesById.set(id, list)
    }

    return rows.map((row) => {
      const id = String(row['id'])
      const states = statesById.get(id) ?? []
      return {
        id,
        path: String(row['path']),
        name: String(row['name']),
        aliases: jsonArray<string>(row['aliases']),
        group: typeof row['group_name'] === 'string' ? row['group_name'] : null,
        role: typeof row['role'] === 'string' ? row['role'] : null,
        pov: typeof row['pov'] === 'string' ? row['pov'] : null,
        firstAppearance: typeof row['first_appearance'] === 'number' ? row['first_appearance'] : null,
        voice: jsonArray<string>(row['voice']),
        states,
        // Ascending, and already filtered to `chapter <= N`, so the last one wins:
        // that is "the state in force", and before the first state there is none.
        state: chapter === undefined || states.length === 0 ? null : (states[states.length - 1] ?? null),
      }
    })
  } catch {
    return undefined
  } finally {
    db.close()
  }
}
