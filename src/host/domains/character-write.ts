/**
 * Character card writing (#25) — the **pure** half.
 *
 * Two rules from the specs shape this file:
 *
 *   - I-03 (`data-model.md` §5) must hold on the **write side**, not just on a
 *     rebuild. `planCharacterUpsert()` is the decision itself: it takes the
 *     project's current cards and answers "allow + the normalised keys" or
 *     "refuse + a code", so the answer is testable without touching a disk. The
 *     normalisation is `naming.ts nameKey()` — the same call the rebuild makes, so
 *     the two paths cannot disagree about what "the same name" means.
 *   - the file is the truth, and the author edits it by hand. `renderCharacterCard`
 *     writes a fresh card; `patchCharacterCard` rewrites only the keys the caller
 *     named, leaving comments, unknown keys and key order alone
 *     (`patchFrontmatter`'s contract).
 *
 * Everything here is pure: no IO, no clock, no uuid. The caller supplies the id
 * and performs the write through `io.ts`; the ordering discipline
 * (parse → `applyCandidate` → `validate` → write) lives in `character-tools.ts`,
 * one layer up, where the seam functions are in scope.
 */

import { frontmatterLine, frontmatterListItem, patchFrontmatter, splitFrontmatter } from '../frontmatter.js'
import { nameKey } from './naming.js'
import type { CharacterRow, CharacterState } from './character.js'

/** Why a card write is refused before any file is touched. */
export type CharacterRejectCode = 'CHARACTER_NAME_REQUIRED' | 'CHARACTER_NAME_DUPLICATE' | 'CHARACTER_ALIAS_DUPLICATE'

/** Another card as the uniqueness check sees it: enough to decide a collision. */
export interface CharacterIdentity {
  readonly path: string
  readonly name: string
  readonly aliases: readonly string[]
}

export interface CharacterUpsertPlanInput {
  readonly name: string
  readonly aliases?: readonly string[]
  /** The file this write targets; its own name and aliases are not conflicts. */
  readonly path?: string
  /** Every card in the project, including the one being rewritten. */
  readonly existing: readonly CharacterIdentity[]
}

export type CharacterUpsertPlan =
  | { readonly ok: true; readonly nameKey: string; readonly aliasKeys: readonly string[] }
  | {
      readonly ok: false
      readonly code: CharacterRejectCode
      readonly message: string
      /** The card this write would collide with, when there is one. */
      readonly conflictPath?: string
    }

/**
 * Decide one upsert: may this name (and these aliases) be written?
 *
 * The name keys of **every other** card — its name *and* its aliases — are taken.
 * An alias colliding with another card's name is the same ambiguity as two
 * identical names (every mention of it could be either character), so it is
 * refused with its own code so the model can say which side to rename.
 */
export function planCharacterUpsert(input: CharacterUpsertPlanInput): CharacterUpsertPlan {
  const name = input.name.trim()
  if (name === '') {
    return { ok: false, code: 'CHARACTER_NAME_REQUIRED', message: 'a character card needs a name' }
  }
  const key = nameKey(name)

  const taken = new Map<string, string>()
  for (const card of input.existing) {
    if (card.path === input.path) continue
    for (const term of [card.name, ...card.aliases]) {
      const termKey = nameKey(term)
      if (termKey !== '' && !taken.has(termKey)) taken.set(termKey, card.path)
    }
  }

  const nameClash = taken.get(key)
  if (nameClash !== undefined) {
    return {
      ok: false,
      code: 'CHARACTER_NAME_DUPLICATE',
      message: `the name "${name}" is already used by ${nameClash} (names are compared after NFKC/case/space folding)`,
      conflictPath: nameClash,
    }
  }

  const aliasKeys: string[] = []
  for (const alias of input.aliases ?? []) {
    const aliasKey = nameKey(alias)
    // An alias that repeats the card's own name adds nothing; dropping it here is
    // why the write never needs a second de-duplication pass.
    if (aliasKey === '' || aliasKey === key || aliasKeys.includes(aliasKey)) continue
    const owner = taken.get(aliasKey)
    if (owner !== undefined) {
      return {
        ok: false,
        code: 'CHARACTER_ALIAS_DUPLICATE',
        message: `the alias "${aliasKey}" is already used by ${owner}`,
        conflictPath: owner,
      }
    }
    aliasKeys.push(aliasKey)
  }

  return { ok: true, nameKey: key, aliasKeys }
}

/** The card fields a write can set, already normalised by the caller. */
export interface CharacterCardFields {
  readonly id: string
  readonly name: string
  readonly aliases?: readonly string[]
  readonly group?: string
  readonly role?: string
  readonly pov?: string
  readonly firstAppearance?: number
  readonly voice?: readonly string[]
  readonly states?: readonly CharacterState[]
}

/** `{chapter: 30, status: '代掌门'}` → `30: 代掌门` (the on-disk form). */
export function formatState(state: CharacterState): string {
  return `${state.chapter}: ${state.status}`
}

/**
 * Characters a file system would rewrite, collapsed to a single `-`.
 *
 * Not `chapters.ts slugify()`: that one is tuned for chapter titles (numeric
 * prefix, `SLUG_MAX`) and a chapter file name is a *location inside the reading
 * order*, while a card file name is just an address. Keeping this rule local also
 * keeps the chapter writer out of the domain layer's import graph.
 */
const UNSAFE_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/gu
const FILE_NAME_MAX = 64

/** `清音` → `清音`; `清/音` → `清-音`; an addressable fallback for a name of only unsafe characters. */
export function characterFileName(name: string): string {
  const normalized = name
    .normalize('NFKC')
    .replace(UNSAFE_FILE_CHARS, '-')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
  const trimmed = normalized.replace(/^[-. ]+/u, '').replace(/[-. ]+$/u, '')
  return [...trimmed].slice(0, FILE_NAME_MAX).join('') || 'character'
}

function blockLines(key: string, items: readonly string[]): string[] {
  return [`${key}:`, ...items.map(frontmatterListItem)]
}

/**
 * A whole new card, in the field order `conventions.md` §3.3 shows.
 *
 * The list fields are written in **block form** (`key:` + `  - item`) because an
 * alias or a state string may contain `,` or `:` — an inline array would split it
 * in half on the way back in.
 */
export function renderCharacterCard(fields: CharacterCardFields, body?: string): string {
  const lines: string[] = ['---', frontmatterLine('id', fields.id), frontmatterLine('name', fields.name)]
  if (fields.aliases !== undefined && fields.aliases.length > 0) lines.push(...blockLines('aliases', fields.aliases))
  for (const key of ['group', 'role', 'pov'] as const) {
    const value = fields[key]
    if (value !== undefined && value !== '') lines.push(frontmatterLine(key, value))
  }
  if (fields.firstAppearance !== undefined) lines.push(frontmatterLine('firstAppearance', String(fields.firstAppearance)))
  if (fields.voice !== undefined && fields.voice.length > 0) lines.push(...blockLines('voice', fields.voice))
  if (fields.states !== undefined && fields.states.length > 0) lines.push(...blockLines('states', fields.states.map(formatState)))
  lines.push('---')
  const block = `${lines.join('\n')}\n`
  if (body === undefined || body === '') return block
  const prose = body.replace(/\r\n/gu, '\n')
  return `${block}\n${prose.endsWith('\n') ? prose : `${prose}\n`}`
}

/** The subset of `CharacterCardFields` a patch may carry: absent means "leave it". */
export type CharacterCardPatch = Partial<Omit<CharacterCardFields, 'id'>> & { readonly id?: string }

/**
 * Rewrite the named keys of an existing card and nothing else.
 *
 * A list passed as `[]` deletes the key (an empty `aliases:` reads back as "the
 * author has not filled this in yet", which is not what "no aliases" means).
 */
export function patchCharacterCard(text: string, patch: CharacterCardPatch, body?: string): string {
  const entries: Record<string, string | readonly string[]> = {}
  if (patch.id !== undefined) entries['id'] = patch.id
  if (patch.name !== undefined) entries['name'] = patch.name
  if (patch.aliases !== undefined) entries['aliases'] = patch.aliases
  for (const key of ['group', 'role', 'pov'] as const) {
    const value = patch[key]
    if (value !== undefined) entries[key] = value
  }
  if (patch.firstAppearance !== undefined) entries['firstAppearance'] = String(patch.firstAppearance)
  if (patch.voice !== undefined) entries['voice'] = patch.voice
  if (patch.states !== undefined) entries['states'] = patch.states.map(formatState)

  const parts = splitFrontmatter(text)
  const patched = parts.hasFrontmatter
    ? patchFrontmatter(parts.head, entries).text + parts.body
    : `${['---', ...Object.keys(entries).flatMap((key) => entryLines(key, entries[key])), '---', '', ''].join('\n')}${text}`
  if (body === undefined) return patched
  const next = splitFrontmatter(patched)
  return `${next.head}${body.replace(/\r\n/gu, '\n')}`
}

/**
 * The frontmatter lines for one entry, used only when a document has no block yet
 * (`patchFrontmatter` appends into an existing block and never creates one).
 *
 * An empty list produces no line at all, matching the patch path: absent and empty
 * mean the same thing, so a key is written only when it has a value.
 */
function entryLines(key: string, value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [`${key}:`]
  if (typeof value === 'string') return [frontmatterLine(key, value)]
  return value.length === 0 ? [] : blockLines(key, value)
}

/** The eight card fields, in the order a report reads them. */
export const CARD_FIELDS = ['name', 'aliases', 'group', 'role', 'pov', 'firstAppearance', 'voice', 'states'] as const

function fieldValue(row: CharacterRow | undefined, field: (typeof CARD_FIELDS)[number]): unknown {
  if (row === undefined) return undefined
  const value = row[field]
  return value === '' ? undefined : value
}

/** Which of the eight fields a write actually changed (an unchanged rewrite is not reported). */
export function changedCardFields(before: CharacterRow | undefined, after: CharacterRow): string[] {
  const changed: string[] = []
  for (const field of CARD_FIELDS) {
    if (JSON.stringify(fieldValue(before, field)) !== JSON.stringify(fieldValue(after, field))) changed.push(field)
  }
  return changed
}
