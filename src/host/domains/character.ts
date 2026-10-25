/**
 * Character domain (`characters/`).
 *
 * Owns three things:
 *
 *   1. **The card fields** (`data-model.md` §3, `conventions.md` §3.3): `name`,
 *      `aliases`, `group`, `role`, `pov`, `firstAppearance` and the two shapes this
 *      issue had to pin — `voice` (语言基因, a block list of one-line descriptors)
 *      and `states` (按章状态, `- <chapter>: <status>` items). Both list forms are
 *      what the frontmatter reader already supports, so a hand edit and a tool
 *      write land in the same shape.
 *   2. **The project-wide name rule (I-03)**: one normalised name or alias per
 *      project. The write side decides it in `character-write.ts
 *      planCharacterUpsert()`; `validate()` is the rebuild-side net, and both call
 *      the single `naming.ts nameKey()` so they cannot disagree.
 *   3. **The tables** (`characters` + `character_states`): the card row for queries
 *      and one row per state so "what was he at chapter 30" is a `WHERE chapter <=`
 *      instead of a JSON scan.
 *
 * Tools live in `character-tools.ts` (the write path needs `scanProject` and
 * `applyCandidate`, which sit above this layer) and are only *aggregated* here.
 */

import { basename, extname, join } from 'node:path'

import { intField, parseMarkdown, stringArrayField, stringField } from '../frontmatter.js'
import type { DomainEntityRef, DomainFileParse, DomainModule, DomainScanResult, ValidationIssue } from './types.js'
import { nameKey } from './naming.js'
import { rowsBucket } from './types.js'
import { aliasesOf, keywordsOf, readText, rowsOf } from './scan-helpers.js'
import { characterTools } from './character-tools.js'

/** One recorded state of a character, addressed by the chapter number it holds from. */
export interface CharacterState {
  readonly chapter: number
  readonly status: string
}

export interface CharacterRow {
  id: string
  path: string
  name: string
  key: string
  group?: string
  role?: string
  pov?: string
  firstAppearance?: number
  aliases: string[]
  /** 语言基因: one-line descriptors (句式/用词/口癖…), order preserved. */
  voice: string[]
  /** 按章状态, ascending by chapter. */
  states: CharacterState[]
  keywords: string[]
}

interface ParsedCharacter {
  row?: CharacterRow
  issues: ValidationIssue[]
}

/** Separator inside one `states` item: `30: 代掌门` / `30：代掌门`. */
const STATE_SEPARATOR = /[:：]/u

/**
 * Read `states` from frontmatter.
 *
 * The reader accepts the two list forms the frontmatter parser produces (a block
 * list and an inline array). Each item is `<chapter>: <status>`; the chapter is a
 * **chapter number** (`firstAppearance` is a number too), so "at chapter 30" is a
 * comparison rather than a lookup by chapter id.
 *
 * Problems are collected as strings and turned into `CHARACTER_STATE_INVALID` by
 * the caller: a malformed item is reported and skipped, so one bad line does not
 * hide the rest of the card from the index.
 */
function statesOf(data: Readonly<Record<string, unknown>>): { states: CharacterState[]; problems: string[] } {
  const states: CharacterState[] = []
  const problems: string[] = []
  for (const item of stringArrayField(data as Record<string, unknown>, 'states')) {
    const at = item.search(STATE_SEPARATOR)
    if (at === -1) {
      problems.push(`state "${item}" needs a chapter: write "<chapter>: <status>", e.g. "30: 代掌门"`)
      continue
    }
    const chapterText = item.slice(0, at).trim()
    const status = item.slice(at + 1).trim()
    if (!/^\d+$/u.test(chapterText) || Number(chapterText) < 1) {
      problems.push(`state "${item}" needs a positive chapter number before the colon`)
      continue
    }
    if (status === '') {
      problems.push(`state "${item}" needs a status after the colon`)
      continue
    }
    const chapter = Number(chapterText)
    if (states.some((state) => state.chapter === chapter)) {
      problems.push(`states duplicates chapter ${chapter}; one status per chapter`)
      continue
    }
    states.push({ chapter, status })
  }
  states.sort((left, right) => left.chapter - right.chapter)
  return { states, problems }
}

/** Read `voice`: the same list forms as any other list field, order preserved. */
function voiceOf(data: Readonly<Record<string, unknown>>): string[] {
  return stringArrayField(data as Record<string, unknown>, 'voice')
    .map((line) => line.replace(/\s+$/u, ''))
    .filter((line) => line !== '')
}

function parseCharacter(path: string, text: string): ParsedCharacter {
  if (extname(path).toLowerCase() !== '.md') return { issues: [] }

  const parsed = parseMarkdown(text)
  const issues: ValidationIssue[] = parsed.issues.map((issue) => ({ code: 'FRONTMATTER_ISSUE', path, detail: issue }))

  const declaredName = stringField(parsed.data, 'name')
  const name = declaredName ?? basename(path).replace(/\.md$/u, '')
  if (declaredName === undefined || declaredName.trim() === '') {
    issues.push({
      code: 'CHARACTER_NAME_REQUIRED',
      path,
      detail: 'the card has no `name`; the file name is only a location, so the row falls back to it while this is reported',
    })
  }

  let firstAppearance: number | undefined
  const rawFirstAppearance = parsed.data['firstAppearance']
  if (rawFirstAppearance !== undefined && rawFirstAppearance !== null) {
    const value = intField(parsed.data, 'firstAppearance')
    if (value === undefined || value < 1) {
      issues.push({
        code: 'CHARACTER_FIRST_APPEARANCE_INVALID',
        path,
        detail: `firstAppearance must be a chapter number (got "${String(rawFirstAppearance)}")`,
      })
    } else {
      firstAppearance = value
    }
  }

  const { states, problems } = statesOf(parsed.data)
  for (const problem of problems) issues.push({ code: 'CHARACTER_STATE_INVALID', path, detail: problem })

  return {
    issues,
    row: {
      id: stringField(parsed.data, 'id') ?? path,
      path,
      name,
      key: nameKey(name),
      group: stringField(parsed.data, 'group'),
      role: stringField(parsed.data, 'role'),
      pov: stringField(parsed.data, 'pov'),
      ...(firstAppearance === undefined ? {} : { firstAppearance }),
      aliases: aliasesOf(parsed.data),
      voice: voiceOf(parsed.data),
      states,
      keywords: keywordsOf(parsed.data),
    },
  }
}

/** One state row as the index holds it (one row per card per chapter). */
interface CharacterStateRow {
  /** `${characterId}#${chapter}`: the table's primary key, stable across rebuilds. */
  id: string
  path: string
  characterId: string
  chapter: number
  status: string
}

/** Flatten the card rows into the state table's rows. */
function stateRowsOf(rows: readonly CharacterRow[]): CharacterStateRow[] {
  const out: CharacterStateRow[] = []
  for (const row of rows) {
    for (const state of row.states) {
      out.push({
        id: `${row.id}#${state.chapter}`,
        path: row.path,
        characterId: row.id,
        chapter: state.chapter,
        status: state.status,
      })
    }
  }
  return out
}

function toEntity(row: CharacterRow): DomainEntityRef {
  return {
    kind: 'characters',
    id: row.id,
    path: row.path,
    title: row.name,
    nameKey: row.key,
    keywords: row.keywords.length > 0 ? row.keywords : undefined,
    aliases: row.aliases.length > 0 ? row.aliases : undefined,
  }
}

/** JSON text for a list column; `null` when empty, so "no aliases" is not "[]" in a diff. */
function jsonColumn(values: readonly unknown[]): string | null {
  return values.length === 0 ? null : JSON.stringify(values)
}

export const characterDomain: DomainModule = {
  kind: 'characters',

  scan({ root, files }): DomainScanResult {
    const rows: CharacterRow[] = []
    const issues: ValidationIssue[] = []
    for (const file of files) {
      const parsed = parseCharacter(file.path, readText(join(root, file.path)))
      issues.push(...parsed.issues)
      if (parsed.row !== undefined) rows.push(parsed.row)
    }
    return {
      tables: [rowsBucket('characters', rows), rowsBucket('character_states', stateRowsOf(rows))],
      entities: rows.map(toEntity),
      issues,
    }
  },

  parseFile({ path, text }): DomainFileParse {
    const parsed = parseCharacter(path, text)
    const row = parsed.row
    return {
      path,
      rows:
        row === undefined
          ? []
          : [rowsBucket('characters', [row]), rowsBucket('character_states', stateRowsOf([row]))],
      entity: row === undefined ? undefined : toEntity(row),
      issues: parsed.issues,
    }
  },

  /**
   * I-03: one name (normalised) per project, aliases included — an alias that is
   * another character's name makes every mention ambiguous, so it is the same
   * collision. First file in walk order wins; later ones are reported and dropped
   * by the cross-class de-duplication in `indexer.ts`.
   */
  validate({ scan }): ValidationIssue[] {
    const issues: ValidationIssue[] = []
    const seen = new Map<string, string>()
    for (const row of rowsOf<CharacterRow>(scan, 'characters')) {
      for (const term of [row.key, ...row.aliases.map((alias) => nameKey(alias))]) {
        if (term === '') continue
        const previous = seen.get(term)
        if (previous !== undefined && previous !== row.path) {
          issues.push({
            code: 'CHARACTER_NAME_DUPLICATE',
            path: row.path,
            detail: `name "${term}" already used by ${previous}`,
          })
        } else {
          seen.set(term, row.path)
        }
      }
    }
    return issues
  },

  schema() {
    return {
      ddl: [
        'CREATE TABLE characters (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, name_key TEXT NOT NULL, group_name TEXT, role TEXT, pov TEXT, first_appearance INTEGER, aliases TEXT, voice TEXT)',
        'CREATE INDEX ix_characters_name ON characters(name_key)',
        'CREATE INDEX ix_characters_group ON characters(group_name)',
        // One row per recorded state instead of a JSON column on the card: "what
        // was he at chapter 30" is then `chapter <= 30` ordered backwards, which a
        // JSON blob cannot answer without reading and parsing every card. The file
        // stays the truth for the list itself (`states:` in the frontmatter).
        'CREATE TABLE character_states (id TEXT PRIMARY KEY, path TEXT NOT NULL, character_id TEXT NOT NULL, chapter INTEGER NOT NULL, status TEXT NOT NULL)',
        'CREATE INDEX ix_character_states_chapter ON character_states(chapter)',
        'CREATE INDEX ix_character_states_character ON character_states(character_id)',
      ],
      insert(db, scan): void {
        const insert = db.prepare(
          'INSERT OR REPLACE INTO characters (id, path, name, name_key, group_name, role, pov, first_appearance, aliases, voice) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        const insertState = db.prepare(
          'INSERT OR REPLACE INTO character_states (id, path, character_id, chapter, status) VALUES (?, ?, ?, ?, ?)',
        )
        for (const row of rowsOf<CharacterRow>(scan, 'characters')) {
          insert.run(
            row.id,
            row.path,
            row.name,
            row.key,
            row.group ?? null,
            row.role ?? null,
            row.pov ?? null,
            row.firstAppearance ?? null,
            jsonColumn(row.aliases),
            jsonColumn(row.voice),
          )
        }
        // Written from its own bucket, not recomputed from the card rows: two
        // derivations of the same facts is how a table and its projection drift.
        for (const state of rowsOf<CharacterStateRow>(scan, 'character_states')) {
          insertState.run(state.id, state.path, state.characterId, state.chapter, state.status)
        }
      },
    }
  },

  /**
   * Tools are bound to the session: `deps` is required, like `worldTools(deps)`.
   * There is no `process.cwd()` fallback — a card tool that guessed its
   * book would answer "not a project" for the one the user has open.
   */
  tools(deps) {
    return characterTools(deps, characterDomain)
  },
}
