/**
 * The character domain's model-facing tools (#25) — `inkflow_character_list` and
 * `inkflow_character_upsert`.
 *
 * Why the write orchestration lives here and not in `character-write.ts`: the
 * discipline it implements is the seam's own (X-4) —
 *
 *   1. `scanProject()`           — the pre-write view of the whole book
 *   2. `planCharacterUpsert()`   — I-03 decided before any byte is written
 *   3. `parseFile()`             — the candidate, parsed exactly as a rebuild would
 *   4. `applyCandidate()`        — the seam-owned "replace this one path" fold
 *   5. `validate({ candidate })` — the same invariants a rebuild runs
 *   6. `writeTextAtomic()`       — only then, through `io.ts`
 *
 * steps 1 and 4 come from layers *above* the domain registry (`indexer.ts`,
 * `domains/index.ts`), so they are in scope only up here. Keeping them out of
 * `character-write.ts` is what stops `domains/*` from importing the registry that
 * imports `domains/*`.
 *
 * The domain is passed in (`characterTools(deps, domain)`) instead of imported, for
 * the same reason: this module must not close the loop back onto `character.ts`.
 * `deps` is required and comes first, like `worldTools(deps)` (#26): a missing host
 * must fail at the call site that forgot it, not silently resolve the workspace
 * from `process.cwd()` — inside the host process that is the DSH install
 * directory, so every tool would answer `NOT_AN_INKFLOW_PROJECT` for a healthy book.
 */

import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

import type { ContentBlock, JsonSchemaNode, ToolDefinition, ToolRunContext } from '../context.js'
import { ensureIndex } from '../index-freshness.js'
import { scanProject } from '../indexer.js'
import { withProjectWriteLock, writeTextAtomic } from '../io.js'
import { applyCandidate } from './index.js'
import type { DomainWriteView } from './index.js'
import type { DomainModule, DomainToolDeps } from './types.js'
import { nameKey } from './naming.js'
import { readText, rowsOf } from './scan-helpers.js'
import { gateFailure, isRefused, resolveProject } from './tool-project.js'
import type { CharacterRow, CharacterState } from './character.js'
import { listCharacters } from './character-query.js'
import type { CharacterSummary } from './character-query.js'
import {
  changedCardFields,
  characterFileName,
  patchCharacterCard,
  planCharacterUpsert,
  renderCharacterCard,
} from './character-write.js'

type Json = Record<string, unknown>

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {}
}

function text(lines: string[]): ContentBlock[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function optionalStringList(value: unknown): string[] | undefined {
  if (typeof value === 'string') return value.split(/[,，、]/u).map((part) => part.trim()).filter((part) => part !== '')
  if (!Array.isArray(value)) return undefined
  return value.filter((part): part is string => typeof part === 'string').map((part) => part.trim()).filter((part) => part !== '')
}

/**
 * A block-list item has to be one line. `frontmatter.ts frontmatterListItem()`
 * throws a `TypeError` on `\n`/`\r`, and that throw happens *after* the caller is
 * committed: the write lock turns it into `IO_FAILED`, so the model is told the
 * disk failed when nothing was written, and it cannot see which field to fix.
 * Judged here, before the lock, so the refusal stays data (#25 review, D-6).
 */
function listItemProblem(field: string, items: readonly string[]): string | undefined {
  for (const item of items) {
    if (/[\r\n]/u.test(item)) {
      const shown = item.replace(/[\r\n]+/gu, '⏎')
      return `${field} item "${shown}" contains a line break; a block-list item must be a single line`
    }
  }
  return undefined
}

/** One card as the tools report it (null, not `undefined`, so it survives JSON). */
function cardView(row: CharacterRow): Json {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    aliases: [...row.aliases],
    group: row.group ?? null,
    role: row.role ?? null,
    pov: row.pov ?? null,
    firstAppearance: row.firstAppearance ?? null,
    voice: [...row.voice],
    states: row.states.map((state) => ({ ...state })),
  }
}

/**
 * `states` from the tool call, judged before it reaches the file.
 *
 * The rules are the file's rules (`character.ts statesOf`): a positive chapter
 * number, a non-empty status, one status per chapter — otherwise the card would be
 * written and then reported as broken by the next rebuild, which is exactly the
 * "validate after the fact" the write path exists to prevent.
 */
type StateInputResult =
  | { ok: true; states: CharacterState[] }
  | { ok: false; code: 'CHARACTER_STATE_INVALID' | 'CHARACTER_FIELD_INVALID'; message: string }

function statesOfInput(raw: unknown): StateInputResult {
  if (raw === undefined) return { ok: true, states: [] }
  if (!Array.isArray(raw)) {
    return { ok: false, code: 'CHARACTER_STATE_INVALID', message: 'states must be a list of {chapter, status} objects' }
  }
  const states: CharacterState[] = []
  for (const entry of raw) {
    const record = asRecord(entry)
    const chapter = record['chapter']
    const status = optionalString(record['status'])?.trim() ?? ''
    if (typeof chapter !== 'number' || !Number.isInteger(chapter) || chapter < 1) {
      return { ok: false, code: 'CHARACTER_STATE_INVALID', message: 'every state needs a positive integer chapter' }
    }
    if (status === '') {
      return { ok: false, code: 'CHARACTER_STATE_INVALID', message: `the state for chapter ${chapter} needs a status` }
    }
    // `30: 代掌门` is written as one `- ` line, so a status cannot hold a line break
    // either — the same rule as `aliases` and `voice`, and the same refusal.
    const problem = listItemProblem('states', [status])
    if (problem !== undefined) {
      return { ok: false, code: 'CHARACTER_FIELD_INVALID', message: `the status for chapter ${chapter}: ${problem}` }
    }
    if (states.some((state) => state.chapter === chapter)) {
      return {
        ok: false,
        code: 'CHARACTER_STATE_INVALID',
        message: `states duplicates chapter ${chapter}; one status per chapter`,
      }
    }
    states.push({ chapter, status })
  }
  states.sort((left, right) => left.chapter - right.chapter)
  return { ok: true, states }
}

/** A caller-supplied card path: relative, under `characters/`, `.md`. */
function characterPath(raw: string): string | undefined {
  const normalized = raw.trim().replace(/\\/gu, '/').replace(/^\/+/u, '')
  if (!normalized.startsWith('characters/')) return undefined
  if (!normalized.toLowerCase().endsWith('.md')) return undefined
  if (normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) return undefined
  return normalized
}

interface CharacterUpsertInput {
  readonly name: string
  readonly aliases?: readonly string[]
  readonly group?: string
  readonly role?: string
  readonly pov?: string
  readonly firstAppearance?: number
  /** `undefined` = leave alone; `[]` = delete the key. */
  readonly voice?: readonly string[]
  readonly states?: readonly CharacterState[]
  readonly path?: string
  readonly body?: string
}

type WriteOutcome = { ok: true; value: Json } | { ok: false; error: Json }

function refusal(root: string, code: string, message: string, extra: Json = {}): WriteOutcome {
  return { ok: false, error: { code, message, root, ...extra } }
}

function applyUpsert(domain: DomainModule, projectRoot: string, input: CharacterUpsertInput): WriteOutcome {
  const locked = withProjectWriteLock(resolve(projectRoot), (lock): WriteOutcome => {
    const root = lock.root
    const scan = scanProject(root)
    const view: DomainWriteView = {
      scan: { tables: scan.tables, entities: scan.entities, issues: scan.issues },
      entities: scan.entities,
    }
    const rows = rowsOf<CharacterRow>(view.scan, 'characters')

    const requestedPath = input.path === undefined ? undefined : characterPath(input.path)
    if (input.path !== undefined && requestedPath === undefined) {
      return refusal(root, 'PATH_INVALID', `"${input.path}" is not a card path: pass characters/<slug>.md`, {
        path: input.path,
      })
    }

    const name = input.name.trim()
    // Upsert = "the card with this name", so the target is the existing file when
    // one exists: a second call edits a card instead of creating a twin.
    const own =
      requestedPath === undefined
        ? rows.find((row) => row.key === nameKey(name))
        : rows.find((row) => row.path === requestedPath)
    const target = requestedPath ?? own?.path ?? `characters/${characterFileName(name)}.md`

    const plan = planCharacterUpsert({ name, aliases: input.aliases, path: target, existing: rows })
    if (!plan.ok) {
      return refusal(root, plan.code, plan.message, plan.conflictPath === undefined ? {} : { path: plan.conflictPath })
    }

    const previousText = own === undefined ? undefined : readText(join(root, target))
    const created = previousText === undefined || previousText === ''
    // A card keeps the id it was minted with; a legacy hand-written card with no
    // `id` gets one now, so later renames (a path change) do not break references.
    const id = own !== undefined && own.id !== own.path ? own.id : randomUUID()

    const fields = {
      name,
      ...(input.aliases === undefined ? {} : { aliases: input.aliases }),
      ...(input.group === undefined ? {} : { group: input.group }),
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.pov === undefined ? {} : { pov: input.pov }),
      ...(input.firstAppearance === undefined ? {} : { firstAppearance: input.firstAppearance }),
      ...(input.voice === undefined ? {} : { voice: input.voice }),
      ...(input.states === undefined ? {} : { states: input.states }),
    }
    const nextText = created
      ? renderCharacterCard({ id, ...fields }, input.body)
      : patchCharacterCard(previousText, { id, ...fields }, input.body)

    // Double insurance: the text we are about to write is judged by the very same
    // parser and invariants a rebuild uses, so a card can never land in a state the
    // next rebuild would flag.
    const parsed = domain.parseFile({ root, path: target, text: nextText })
    if (parsed.issues.length > 0) {
      const issue = parsed.issues[0]
      return refusal(root, issue?.code ?? 'FRONTMATTER_ISSUE', issue?.detail ?? 'the card could not be parsed', {
        path: target,
      })
    }
    const post = applyCandidate(view, parsed)
    const blocking = domain
      .validate({ root, scan: post.scan, entities: post.entities, candidate: { path: target } })
      .filter((issue) => issue.path === undefined || issue.path === target)
    if (blocking.length > 0) {
      const issue = blocking[0]
      return refusal(root, issue?.code ?? 'CHARACTER_NAME_DUPLICATE', issue?.detail ?? 'the card breaks an invariant', {
        path: target,
      })
    }

    const written = writeTextAtomic(root, target, nextText)
    if (!written.ok) {
      return refusal(root, written.error.code, written.error.message, {
        path: target,
        ...(written.error.hint === undefined ? {} : { hint: written.error.hint }),
      })
    }

    // The file is the truth: report what it now says, not what we meant to write.
    const after = domain.parseFile({ root, path: target, text: readText(join(root, target)) })
    const row = rowsOf<CharacterRow>({ tables: after.rows }, 'characters')[0]
    if (row === undefined) {
      return refusal(root, 'CARD_UNREADABLE', `the card was written but cannot be read back from ${target}`, {
        path: target,
      })
    }
    return {
      ok: true,
      value: {
        ok: true,
        root,
        path: target,
        created,
        // A created card reports what was written; an update reports only the fields
        // whose value actually moved, so "no change" is visible as an empty list.
        changed: created ? Object.keys(fields) : changedCardFields(own, row),
        character: cardView(row),
      },
    }
  })

  // The lock itself can fail (PROJECT_BUSY, PATH_INVALID): report its code, and the
  // root the caller asked for, so the answer still names a path.
  return locked.ok ? locked.value : refusal(resolve(projectRoot), locked.error.code, locked.error.message)
}

/** Index refresh after a write: reported, never rolling the write back (the index is a cache). */
async function refreshIndex(root: string): Promise<Json> {
  try {
    const ensured = await ensureIndex(root)
    if (ensured.ok) return { indexRebuilt: ensured.rebuilt, indexState: ensured.state }
    return { indexRebuilt: false, indexError: { code: ensured.failure.code, message: ensured.failure.message } }
  } catch (cause) {
    return { indexRebuilt: false, indexError: { code: 'INDEX_BUILD_FAILED', message: String(cause) } }
  }
}

const PROJECT_ROOT_PARAM = {
  type: 'string',
  description:
    'Absolute path of the InkFlow project root. Omit to resolve from the session working directory (walks up to the nearest project). An explicit path must live inside the session working directory.',
} as const

const CONFIRM_PARAM = {
  type: 'boolean',
  description:
    'Must be true. A card write changes the author’s setting library, so the model has to show what it is about to write first.',
} as const

const SUCCESS_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: true,
}

function failureLine(verb: string, value: Json, wrote = false): ContentBlock[] {
  const error = asRecord(value['error'])
  const lines = [`${verb} failed: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
  if (error['path'] !== undefined) lines.push(`path: ${String(error['path'])}`)
  if (wrote) lines.push('Nothing was written: a refused card write leaves the project unchanged.')
  if (error['hint'] !== undefined) lines.push(String(error['hint']))
  return text(lines)
}

/**
 * Spread `key: value` only when the caller supplied it: on an update `undefined`
 * means "leave the field alone", which is a different instruction from `[]`
 * (delete the key).
 */
function provided<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>)
}

function indexLine(value: Json): string {
  if (value['indexRebuilt'] === true) return 'index rebuilt'
  const error = asRecord(value['indexError'])
  if (Object.keys(error).length > 0) {
    return `index NOT rebuilt (${String(error['code'] ?? 'unknown')}) — run inkflow_index_rebuild`
  }
  return 'index already fresh'
}

/**
 * The domain's tools.
 *
 * `deps` is required and first, exactly like `worldTools(deps)` (#26). An optional
 * `deps` with a `{ get: () => undefined }` stand-in let a mis-assembled plugin keep
 * answering — every tool then resolved the workspace from `process.cwd()` and
 * reported `NOT_AN_INKFLOW_PROJECT` for a book the user had open. A required
 * parameter turns that into a compile error at the one call site instead.
 */
export function characterTools(deps: DomainToolDeps, domain: DomainModule): ToolDefinition[] {
  const resolveRoot = async (args: Json, exec: ToolRunContext) => resolveProject(deps, args['projectRoot'], exec)

  const list: ToolDefinition = {
    name: 'inkflow_character_list',
    description:
      'List character cards: name, aliases, group, role, point of view, first appearance, voice (语言基因) and per-chapter ' +
      'states. Filter by `group` or by a name/alias fragment with `query`. Pass `chapter` to answer "what was this ' +
      'character at chapter N" — the state in force is the newest recorded state at or before that chapter. Reads the ' +
      'derived index and rebuilds it once when it is missing or stale.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        group: { type: 'string', description: 'Exact group name (`group:` in the card), e.g. "白鹤门".' },
        query: { type: 'string', description: 'Fragment of a name or an alias.' },
        chapter: { type: 'integer', description: 'Chapter number for the state-in-force answer (0 or higher).' },
        limit: { type: 'integer', description: 'Maximum cards to return (1–500). Default 100.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return failureLine('Character list', v)
        const items = Array.isArray(v['items']) ? (v['items'] as Json[]) : []
        const total = typeof v['total'] === 'number' ? v['total'] : items.length
        if (items.length === 0) return text(['No character card matches.'])
        const lines = [`${total} character card(s)${v['indexRebuilt'] === true ? ' [index rebuilt]' : ''}:`]
        for (const item of items) {
          const facts: string[] = [String(item['path'])]
          for (const key of ['group', 'role', 'pov'] as const) {
            if (item[key] !== null && item[key] !== undefined) facts.push(String(item[key]))
          }
          if (item['firstAppearance'] !== null && item['firstAppearance'] !== undefined) {
            facts.push(`出场第 ${String(item['firstAppearance'])} 章`)
          }
          const state = asRecord(item['state'])
          if (Object.keys(state).length > 0) {
            lines.push(`- ${String(item['name'])} — ${facts.join(' · ')} — 第 ${String(state['chapter'])} 章: ${String(state['status'])}`)
          } else {
            lines.push(`- ${String(item['name'])} — ${facts.join(' · ')}`)
          }
          const aliases = Array.isArray(item['aliases']) ? (item['aliases'] as unknown[]).map(String) : []
          if (aliases.length > 0) lines.push(`    别名: ${aliases.join('、')}`)
        }
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveRoot(a, exec)
      if (isRefused(resolved)) return gateFailure(resolved)
      const root = resolved.probe?.root ?? resolved.root

      const chapterRaw = a['chapter']
      if (chapterRaw !== undefined && (typeof chapterRaw !== 'number' || !Number.isInteger(chapterRaw) || chapterRaw < 0)) {
        return {
          ok: false,
          root,
          error: { code: 'CHAPTER_INVALID', message: 'chapter must be a non-negative integer chapter number' },
        }
      }

      const ensured = await ensureIndex(root)
      if (!ensured.ok) {
        return {
          ok: false,
          root,
          error: {
            code: ensured.failure.code,
            message: ensured.failure.message,
            hint: 'the derived index could not be built; retry, or run inkflow_index_rebuild',
          },
        }
      }
      const group = optionalString(a['group'])
      const query = optionalString(a['query'])
      const items = listCharacters(root, {
        ...(group === undefined ? {} : { group }),
        ...(query === undefined ? {} : { query }),
        ...(typeof chapterRaw === 'number' ? { chapter: chapterRaw } : {}),
        ...(typeof a['limit'] === 'number' ? { limit: a['limit'] } : {}),
      })
      if (items === undefined) {
        return {
          ok: false,
          root,
          indexRebuilt: ensured.rebuilt,
          error: {
            code: 'INDEX_UNAVAILABLE',
            message: 'the derived index is missing or was built by another schema and the rebuild did not fix it',
            hint: 'run inkflow_index_rebuild',
          },
        }
      }
      return {
        ok: true,
        root,
        total: items.length,
        items: items.map((item: CharacterSummary) => ({ ...item })),
        indexRebuilt: ensured.rebuilt,
        indexState: ensured.state,
      }
    },
  }

  const upsert: ToolDefinition = {
    name: 'inkflow_character_upsert',
    description:
      'Create or update one character card (name, aliases, group, role, pov, firstAppearance, voice 语言基因, per-chapter ' +
      'states) plus optional `body` prose, and refresh both the index and any projection the file drives. Requires ' +
      '`confirm: true`. The name and every alias must be unique across the project after NFKC/case/space folding ' +
      '(I-03): a collision is refused with CHARACTER_NAME_DUPLICATE or CHARACTER_ALIAS_DUPLICATE and nothing is written. ' +
      'Calling it again with the same name edits that card instead of creating a second one.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        name: { type: 'string', description: 'Character name; the uniqueness key and the default file name.' },
        aliases: { type: 'array', items: { type: 'string' }, description: 'Alternative names used in the prose.' },
        group: { type: 'string', description: 'Group the card belongs to (门派/阵营/…); the list tool filters on it.' },
        role: { type: 'string', description: 'Narrative role, e.g. 主角 / 配角 / 反派.' },
        pov: { type: 'string', description: 'Point of view this character is narrated in.' },
        firstAppearance: { type: 'integer', description: 'Chapter number of the first appearance (1 or higher).' },
        voice: {
          type: 'array',
          items: { type: 'string' },
          description: '语言基因: one-line descriptors (句式/用词/口癖). Block form in the file, order preserved.',
        },
        states: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              chapter: { type: 'integer', description: 'Chapter number the state starts at (1 or higher).' },
              status: { type: 'string', description: 'What the character is at that point.' },
            },
            required: ['chapter', 'status'],
            additionalProperties: false,
          },
          description: '按章状态: replaces the whole list when given; one status per chapter.',
        },
        path: {
          type: 'string',
          description: 'Card file to write (`characters/<slug>.md`). Omit to reuse the card with this name, else derive the file name from it.',
        },
        body: { type: 'string', description: 'Card prose (性格/外貌/动机…). Omitted leaves the existing body alone.' },
        confirm: CONFIRM_PARAM,
      },
      required: ['name', 'confirm'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return failureLine('Character upsert', v, true)
        const card = asRecord(v['character'])
        const verb = v['created'] === true ? 'Created' : 'Updated'
        const changed = Array.isArray(v['changed']) ? (v['changed'] as unknown[]).map(String) : []
        return text([
          `${verb} ${String(card['name'])} — ${String(v['path'])} (id: ${String(card['id'])})`,
          changed.length === 0 ? 'No field changed.' : `Changed: ${changed.join(', ')}.`,
          indexLine(v),
        ])
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveRoot(a, exec)
      if (isRefused(resolved)) return gateFailure(resolved)
      const root = resolved.probe?.root ?? resolved.root

      if (a['confirm'] !== true) {
        return {
          ok: false,
          root,
          error: {
            code: 'CONFIRM_REQUIRED',
            message: 'a character card write needs confirm: true',
            hint: 'show the user the card you are about to write (name, aliases, group, states), then call again with confirm: true',
          },
        }
      }

      const name = optionalString(a['name']) ?? ''
      if (name.trim() === '') {
        return {
          ok: false,
          root,
          error: { code: 'CHARACTER_NAME_REQUIRED', message: 'a character card needs a name' },
        }
      }
      const firstAppearance = a['firstAppearance']
      if (
        firstAppearance !== undefined &&
        (typeof firstAppearance !== 'number' || !Number.isInteger(firstAppearance) || firstAppearance < 1)
      ) {
        return {
          ok: false,
          root,
          error: { code: 'CHARACTER_FIRST_APPEARANCE_INVALID', message: 'firstAppearance must be a positive chapter number' },
        }
      }
      const states = statesOfInput(a['states'])
      if (!states.ok) {
        return { ok: false, root, error: { code: states.code, message: states.message } }
      }
      // `aliases` and `voice` become block-list items verbatim; a line break in one
      // of them has to be refused here, before the write lock, or the serialiser
      // throws and the answer comes back as `IO_FAILED` (see `listItemProblem`).
      const aliases = optionalStringList(a['aliases'])
      const voice = optionalStringList(a['voice'])
      const listProblem =
        (aliases === undefined ? undefined : listItemProblem('aliases', aliases)) ??
        (voice === undefined ? undefined : listItemProblem('voice', voice))
      if (listProblem !== undefined) {
        return { ok: false, root, error: { code: 'CHARACTER_FIELD_INVALID', message: listProblem } }
      }

      const outcome = applyUpsert(domain, root, {
        name,
        ...provided('aliases', aliases),
        ...provided('group', optionalString(a['group'])),
        ...provided('role', optionalString(a['role'])),
        ...provided('pov', optionalString(a['pov'])),
        ...provided('firstAppearance', typeof firstAppearance === 'number' ? firstAppearance : undefined),
        ...provided('voice', voice),
        // An explicit `states: []` clears the list, which is why it is keyed on the
        // argument being present rather than on the normalized result.
        ...(a['states'] === undefined ? {} : { states: states.states }),
        ...provided('path', optionalString(a['path'])),
        ...provided('body', optionalString(a['body'])),
      })
      if (!outcome.ok) return { ok: false, error: outcome.error }
      return { ...outcome.value, ...(await refreshIndex(root)) }
    },
  }

  return [list, upsert]
}
