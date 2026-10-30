/**
 * What a candidate may say: the per-kind field dictionary (data-model.md §3) and
 * the two judgements a submission has to pass — `fields` and `evidence`.
 *
 * WHY IT IS A FILE: these are the rules that decide whether a batch lands, and
 * they are read by two callers with different lives — `inkflow_extract_propose`
 * refuses at submit time, and the accept path re-judges the same fields before it
 * writes a content file. Both must call ONE judge, or "the panel says it will
 * work" and "accept works" drift apart. That is why the rules live together and
 * away from the store: the store writes bytes, this file decides if they may be
 * written at all.
 *
 * It resolves evidence against the book *now* (a file with that line, or a chapter
 * id in the catalog), which is the only moment a bad anchor is certainly a mistake.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readCatalog } from './catalog.js'
import { refuse } from './extract-types.js'
import type { ExtractError, ExtractKind } from './extract-types.js'

// ---------------------------------------------------------------------------
// The field dictionary (`data-model.md` §3, per kind)
// ---------------------------------------------------------------------------

type FieldType = 'string' | 'stringList' | 'integer' | 'boolean' | 'states' | 'plotPoints'

/**
 * The keys a candidate of each kind may set, and what they must be.
 *
 * This is the §3 dictionary, narrowed to what the accept path can actually write:
 * `id` is absent on purpose (an extracted entity is new, so the plugin mints its
 * id — a model-supplied id could hijack an existing entity), and so are the fields
 * a domain's own renderer does not write yet (`place`/`calendar` on a timeline
 * event, `notes` on a foreshadow, the read-compat `resolved` flag). Accepting them
 * would silently drop them on the way to the file, which is worse than refusing.
 */
const FIELD_TYPES: Readonly<Record<ExtractKind, Readonly<Record<string, FieldType>>>> = {
  character: {
    name: 'string',
    aliases: 'stringList',
    group: 'string',
    role: 'string',
    pov: 'string',
    firstAppearance: 'integer',
    voice: 'stringList',
    states: 'states',
    body: 'string',
  },
  world: {
    title: 'string',
    category: 'string',
    parent: 'string',
    keywords: 'stringList',
    always: 'boolean',
    priority: 'integer',
    body: 'string',
  },
  outline: {
    kind: 'string',
    title: 'string',
    parent: 'string',
    order: 'integer',
    plotPoints: 'plotPoints',
    body: 'string',
  },
  timeline: {
    title: 'string',
    worldTime: 'string',
    narrativeOrder: 'integer',
    chapterId: 'string',
    participants: 'stringList',
    status: 'string',
    body: 'string',
  },
  foreshadowing: {
    title: 'string',
    status: 'string',
    plantedAt: 'string',
    advancedAt: 'stringList',
    dueBy: 'string',
    resolvedChapter: 'string',
    linkedEntities: 'stringList',
    body: 'string',
  },
  relation: {
    source: 'string',
    target: 'string',
    kind: 'string',
    title: 'string',
    dir: 'string',
    since: 'string',
    until: 'string',
    chapter: 'string',
    body: 'string',
  },
}

/** Keys without which the accept path could not address the entity at all. */
const REQUIRED_KEYS: Readonly<Record<ExtractKind, readonly string[]>> = {
  character: ['name'],
  world: ['title'],
  // `kind` is required: an outline node's level (overall / volume / chapter) is a
  // structural decision, and guessing `chapter` would quietly build the wrong tree.
  outline: ['kind', 'title'],
  timeline: ['title'],
  foreshadowing: ['title'],
  relation: ['source', 'target'],
}

/** Enumerated values, where §3 fixes them. */
const FIELD_ENUMS: Readonly<Record<ExtractKind, Readonly<Record<string, readonly string[]>>>> = {
  character: {},
  world: {},
  outline: { kind: ['overall', 'volume', 'chapter'] },
  timeline: { status: ['confirmed', 'unconfirmed'] },
  foreshadowing: { status: ['planted', 'advanced', 'resolved', 'overdue'] },
  relation: { kind: ['character', 'knowledge'], dir: ['directed', 'undirected'] },
}

/** The field names a caller may use for one kind — exported for the tools' help text. */
export function candidateFieldNames(kind: ExtractKind): readonly string[] {
  return Object.keys(FIELD_TYPES[kind])
}

// ---------------------------------------------------------------------------
// Field and evidence judgement
// ---------------------------------------------------------------------------

export type FieldCheck = { ok: true; fields: Record<string, unknown> } | { ok: false; error: ExtractError }

function asStringList(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const single = value.trim()
    return single === '' ? [] : [single]
  }
  if (!Array.isArray(value)) return undefined
  if (!value.every((item) => typeof item === 'string')) return undefined
  return value.map((item) => item.trim()).filter((item) => item !== '')
}

const BLOCK_ITEM_BREAK = /[\r\n]/u

/**
 * Judge one candidate's `fields` against its kind's dictionary.
 *
 * Two refusals matter beyond "wrong type" (both are D2's "the model submits a
 * shape, the plugin owns the shape"):
 *
 *   * an **unknown key** is refused rather than kept, because a kept key would be
 *     written nowhere and the author would read a candidate that silently lost a
 *     field. A candidate is machine-written: a key this module does not know is a
 *     producer bug, and saying so is more useful than preserving it.
 *   * a value that **cannot round-trip through one frontmatter line** (a newline in
 *     an alias, a `,`/`[`/`]`/space inside a timeline participant id) is refused
 *     here instead of at the writer, which would turn it into `IO_FAILED` after the
 *     write lock was already taken.
 */
export function checkCandidateFields(kind: ExtractKind, raw: unknown): FieldCheck {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', 'fields must be a JSON object', { field: 'fields' }) }
  }
  const input = raw as Record<string, unknown>
  const types = FIELD_TYPES[kind]
  const fields: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(input)) {
    const type = types[key]
    if (type === undefined) {
      return {
        ok: false,
        error: refuse('CANDIDATE_FIELD_UNKNOWN', `"${key}" is not a ${kind} field`, {
          field: key,
          hint: `known fields: ${Object.keys(types).join(', ')}`,
        }),
      }
    }
    if (value === undefined || value === null) continue

    if (type === 'string') {
      if (typeof value !== 'string') {
        return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', `${key} must be a string`, { field: key }) }
      }
      const trimmed = value.trim()
      if (trimmed === '') continue
      if (BLOCK_ITEM_BREAK.test(trimmed) && key !== 'body') {
        return {
          ok: false,
          error: refuse('CANDIDATE_FIELD_INVALID', `${key} must be a single line`, { field: key }),
        }
      }
      const allowed = FIELD_ENUMS[kind][key]
      if (allowed !== undefined && !allowed.includes(trimmed)) {
        return {
          ok: false,
          error: refuse('CANDIDATE_FIELD_INVALID', `${key} must be one of ${allowed.join(' / ')}`, { field: key }),
        }
      }
      fields[key] = trimmed
      continue
    }

    if (type === 'stringList' || type === 'plotPoints') {
      const list = asStringList(value)
      if (list === undefined) {
        return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', `${key} must be a list of strings`, { field: key }) }
      }
      const broken = type === 'plotPoints' ? list.find((item) => BLOCK_ITEM_BREAK.test(item)) : list.find((item) => BLOCK_ITEM_BREAK.test(item))
      if (broken !== undefined) {
        return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', `${key} items must be one line each`, { field: key }) }
      }
      // A participant is stored space-joined, so an id carrying a space, a comma or
      // a bracket reads back as two ids (data-model §3.4).
      if (key === 'participants') {
        const bad = list.find((item) => /[\s,[\]]/u.test(item))
        if (bad !== undefined) {
          return {
            ok: false,
            error: refuse('CANDIDATE_FIELD_INVALID', `participant "${bad}" contains a space, comma or bracket`, { field: key }),
          }
        }
      }
      fields[key] = list
      continue
    }

    if (type === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', `${key} must be an integer`, { field: key }) }
      }
      fields[key] = value
      continue
    }

    if (type === 'boolean') {
      if (typeof value !== 'boolean') {
        return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', `${key} must be a boolean`, { field: key }) }
      }
      fields[key] = value
      continue
    }

    // `states`: `[{chapter, status}]`, the same shape `inkflow_character_upsert` takes.
    if (!Array.isArray(value)) {
      return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', 'states must be a list of {chapter, status}', { field: key }) }
    }
    const states: Array<{ chapter: number; status: string }> = []
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', 'every state needs {chapter, status}', { field: key }) }
      }
      const record = entry as Record<string, unknown>
      const chapter = record['chapter']
      const status = typeof record['status'] === 'string' ? record['status'].trim() : ''
      if (typeof chapter !== 'number' || !Number.isInteger(chapter) || chapter < 1 || status === '') {
        return {
          ok: false,
          error: refuse('CANDIDATE_FIELD_INVALID', 'every state needs a positive integer chapter and a non-empty status', {
            field: key,
          }),
        }
      }
      if (BLOCK_ITEM_BREAK.test(status)) {
        return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', 'a state status must be a single line', { field: key }) }
      }
      if (states.some((state) => state.chapter === chapter)) {
        return { ok: false, error: refuse('CANDIDATE_FIELD_INVALID', `states repeats chapter ${chapter}`, { field: key }) }
      }
      states.push({ chapter, status })
    }
    states.sort((left, right) => left.chapter - right.chapter)
    fields[key] = states
  }

  for (const key of REQUIRED_KEYS[kind]) {
    const value = fields[key]
    if (value === undefined || value === '') {
      return { ok: false, error: refuse('CANDIDATE_FIELD_REQUIRED', `a ${kind} candidate needs "${key}"`, { field: key }) }
    }
  }
  return { ok: true, fields }
}

/** `chapters/vol-01/0001-a.md#L12` — the line anchor form evidence takes. */
const EVIDENCE_LINE = /^([^#]+)#L(\d+)$/u
/** Anything with `#L` in it that is not the form above is a malformed anchor. */
const EVIDENCE_LIKE = /#L/u

function portableRelativePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/').trim()
  if (normalized === '' || normalized.startsWith('/')) return false
  if (/^[A-Za-z]:/u.test(normalized)) return false
  return !normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
}

function countLines(text: string): number {
  if (text === '') return 0
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
  return trimmed === '' ? 1 : trimmed.split('\n').length
}

/**
 * Judge one `evidence` string: `path#L<n>` or a chapter id (D2 — "no evidence, no
 * candidate").
 *
 * The target is resolved **now**, at submission: a file must exist and have that
 * line, and a chapter id must be in the catalog. Judging it here is what makes the
 * refusal useful — the model still has the text it was reading in front of it —
 * and it is also the only moment at which "this evidence points at nothing" is
 * certainly a mistake rather than a later deletion.
 */
export function checkEvidence(root: string, raw: unknown): { ok: true; evidence: string } | { ok: false; error: ExtractError } {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return {
      ok: false,
      error: refuse('EVIDENCE_REQUIRED', 'every candidate needs evidence: "path#L<line>" or a chapter id', {
        field: 'evidence',
      }),
    }
  }
  const evidence = raw.trim()
  if (EVIDENCE_LIKE.test(evidence)) {
    const match = EVIDENCE_LINE.exec(evidence)
    if (match === null) {
      return {
        ok: false,
        error: refuse('EVIDENCE_INVALID', `"${evidence}" is not a line anchor: use path#L<line>`, { field: 'evidence' }),
      }
    }
    const path = (match[1] ?? '').trim()
    const line = Number(match[2] ?? '')
    if (!portableRelativePath(path) || !Number.isInteger(line) || line < 1) {
      return {
        ok: false,
        error: refuse('EVIDENCE_INVALID', `"${evidence}" is not a line anchor: use path#L<line> (line ≥ 1)`, {
          field: 'evidence',
        }),
      }
    }
    const absolute = join(root, path)
    if (!existsSync(absolute)) {
      return {
        ok: false,
        error: refuse('EVIDENCE_TARGET_MISSING', `${path} does not exist in this book`, { field: 'evidence', path }),
      }
    }
    let lines = 0
    try {
      lines = countLines(readFileSync(absolute, 'utf8').replace(/^\uFEFF/u, ''))
    } catch {
      return {
        ok: false,
        error: refuse('EVIDENCE_TARGET_MISSING', `${path} cannot be read`, { field: 'evidence', path }),
      }
    }
    if (line > lines) {
      return {
        ok: false,
        error: refuse('EVIDENCE_TARGET_MISSING', `${path} has ${String(lines)} lines; line ${String(line)} does not exist`, {
          field: 'evidence',
          path,
        }),
      }
    }
    return { ok: true, evidence: `${path}#L${String(line)}` }
  }

  // A chapter id: the catalog is the projection of the chapter files, so this needs
  // no index build and no other kind of id can be mistaken for a chapter.
  const catalog = readCatalog(root)
  const chapters = [...catalog.catalog.looseChapters, ...catalog.volumeCatalogs.flatMap((entry) => entry.chapters)]
  const hit = chapters.find((chapter) => chapter.chapterId === evidence)
  if (hit === undefined) {
    return {
      ok: false,
      error: refuse('EVIDENCE_TARGET_MISSING', `no chapter has the id "${evidence}"`, {
        field: 'evidence',
        hint: 'pass "path#L<line>" for a chapter file, or a chapter id listed by inkflow_chapter_list',
      }),
    }
  }
  return { ok: true, evidence }
}
