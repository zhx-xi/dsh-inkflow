/**
 * Write-side planning for the relation domain (data-model §3.3, I-08).
 *
 * Why a separate module: the index rebuild and the write path have to agree about
 * what one edge means, and the only way to guarantee that is to keep the decision
 * pure — no filesystem, no database, no clock. The tool feeds it the *current*
 * view (existing rows + the whole book's projection) and gets back either the row
 * to write or the exact code that refuses it.
 *
 * The three refusals are the same invariants `validate()` reports on a rebuild, so
 * a write can never create a file the next rebuild would call broken:
 *   `RELATION_ENDPOINT`   both ends resolve to exactly one entity of the book
 *   `RELATION_SELF_LOOP`  source and target are two different entities
 *   `RELATION_DUPLICATE`  one (source, target, kind) edge is declared once
 *
 * Field naming: the frontmatter key is `kind` (character | knowledge, data-model
 * §3.3), which collides with the domain module's own `kind: 'relations'`. Inside
 * this codebase the same value is always `relationKind`, and the `relations` table
 * column is `relation_kind`, so neither reading of "kind" can be mistaken for the
 * other.
 */

import { createHash } from 'node:crypto'

import { frontmatterLine, patchFrontmatter, splitFrontmatter } from '../frontmatter.js'
import type { DomainEntityRef } from './types.js'

/**
 * `kind` of an edge — the knowledge graph's **type** vocabulary (data-model §3.3).
 *
 * Five types, and the split is a setting, not an enum for its own sake:
 *
 *   `character`  人物关系（师徒、旧识、仇敌）—— 0.2.0 以来的缺省值，读写都兼容
 *   `knowledge`  知识图谱关系（概念/物品/术法之间）
 *   `kinship`    血缘亲缘（父子、同族）
 *   `faction`    阵营与隶属（门派、势力、效忠）
 *   `geography`  地理关系（位于、通往、相邻）
 *
 * Why the same field carries both "what kind of edge is this" and "which family it
 * belongs to": the column set of the `entities` projection is fixed by X-1, so a second
 * field would have nowhere to live in the index, and two vocabularies for one axis is
 * how a panel ends up grouping half the edges. `toEntity()` puts this value in
 * `category`, which is what a tree groups by.
 *
 * Unknown values degrade to `character` **and are reported** (`FRONTMATTER_ISSUE`), the
 * same policy a bad chapter `status` uses: a rebuild must keep the edge visible, and a
 * write is refused with `RELATION_FIELD_INVALID` before anything lands.
 */
export const RELATION_KINDS = ['character', 'knowledge', 'kinship', 'faction', 'geography'] as const
export type RelationKind = (typeof RELATION_KINDS)[number]

/**
 * `dir` of an edge. `directed` is the default; `undirected` does not remove the
 * `source`/`target` pair, it only says the edge reads the same both ways (so the
 * projection still stores one canonical pair instead of two rows).
 */
export const RELATION_DIRECTIONS = ['directed', 'undirected'] as const
export type RelationDirection = (typeof RELATION_DIRECTIONS)[number]

/** One `relations/<slug>.md` file, as the table and the projection see it. */
export interface RelationRow {
  /** Stable id; defaults to the project-relative path (data-model §3.1). */
  id: string
  /** Project-relative path with forward slashes; every bucket row carries one. */
  path: string
  /** Display name, `源 → 目标` unless the file sets `title`. */
  title: string
  /** Frontmatter `kind` (character | knowledge). Never the domain kind. */
  relationKind: RelationKind
  /** Entity id of the tail of the edge. Empty when the file omits it. */
  source: string
  /** Entity id of the head of the edge. Empty when the file omits it. */
  target: string
  direction: RelationDirection
  /** Narrative position where the relation starts (chapter id or label). */
  since: string | undefined
  /** Narrative position where it stops holding. */
  until: string | undefined
  /** The chapter this edge is anchored to, when one is named. */
  chapter: string | undefined
}

export type RelationErrorCode =
  | 'RELATION_ENDPOINT'
  | 'RELATION_SELF_LOOP'
  | 'RELATION_DUPLICATE'
  | 'RELATION_FIELD_INVALID'
  | 'RELATION_PATH_INVALID'

export interface RelationPlanError {
  code: RelationErrorCode
  message: string
  hint?: string
}

/** What the caller knows before writing: the current edges and the whole book's entities. */
export interface RelationUpsertView {
  readonly rows: readonly RelationRow[]
  /** Cross-class projection (X-1): endpoints may be any kind, not just characters. */
  readonly entities: readonly DomainEntityRef[]
}

export interface RelationUpsertRequest {
  readonly source: string
  readonly target: string
  /** `character` (default) or `knowledge`. */
  readonly relationKind?: string
  /** `directed` (default) or `undirected`. */
  readonly direction?: string
  readonly since?: string
  readonly until?: string
  readonly chapter?: string
  readonly id?: string
  /** Explicit `relations/<slug>.md`; omit to key the edge on its two ends. */
  readonly path?: string
  readonly title?: string
}

export type RelationPlan =
  | { readonly ok: true; readonly row: RelationRow; readonly created: boolean }
  | { readonly ok: false; readonly error: RelationPlanError }

function refuse(code: RelationErrorCode, message: string, hint?: string): RelationPlan {
  return { ok: false, error: hint === undefined ? { code, message } : { code, message, hint } }
}

function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

// ---------------------------------------------------------------------------
// The knowledge graph's second invariant: contradictory edges
// ---------------------------------------------------------------------------

/** One contradictory pair of edges, filed against the edge that came second by path. */
export interface RelationConflict {
  readonly code: 'RELATION_CONFLICT'
  readonly path: string
  readonly otherPath: string
  readonly detail: string
}

/**
 * Edges that describe **the same pair of entities, the same way, in two different
 * ways** — the knowledge graph's version of "these two facts cannot both be true".
 *
 * What counts, and why each is a contradiction rather than a duplicate:
 *
 *   * two `directed` edges pointing **opposite** ways (A→B and B→A) — "清音 师从 白云观"
 *     and "白云观 师从 清音" are not two facts, they are one fact claimed backwards;
 *   * a `directed` and an `undirected` edge on the same pair — one says the relation
 *     reads one way, the other says it reads both ways.
 *
 * What does **not** count: the same pair declared twice in the *same* orientation and
 * direction. That is `RELATION_DUPLICATE` (a second file for one fact), which is a
 * different mistake with a different fix (delete or merge the duplicate file).
 *
 * Time windows (`since` / `until`) are deliberately **not** compared here: they hold
 * free labels (a chapter id *or* a world time, data-model §3.3), and deciding "these
 * two intervals cannot both hold" needs the chapter order the ledger resolves for
 * facts (I-23). Half-implementing that here would report contradictions between a
 * chapter id and a world time that no one can adjudicate.
 *
 * Rows with an empty end are skipped: `RELATION_ENDPOINT` already reports them, and
 * pairing two half-edges would bury the real problem under a second finding.
 */
export function relationConflicts(rows: readonly RelationRow[]): RelationConflict[] {
  const groups = new Map<string, RelationRow[]>()
  for (const row of rows) {
    if (row.source === '' || row.target === '' || row.source === row.target) continue
    // Unordered key: the pair `{A, B}` is one bucket whatever the writing direction is,
    // which is the whole point — an opposite-direction pair has to meet in one bucket.
    const ends = [row.source, row.target].sort()
    const key = `${ends[0] ?? ''}\u0000${ends[1] ?? ''}\u0000${row.relationKind}`
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [row])
    else bucket.push(row)
  }

  const findings: RelationConflict[] = []
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue
    const sorted = [...bucket].sort((left, right) => (left.path === right.path ? 0 : left.path < right.path ? -1 : 1))
    const reference = sorted[0]
    if (reference === undefined) continue
    for (const other of sorted.slice(1)) {
      if (other.direction !== reference.direction) {
        findings.push({
          code: 'RELATION_CONFLICT',
          path: other.path,
          otherPath: reference.path,
          detail:
            `${reference.source} → ${reference.target} (${reference.relationKind}) is declared ${reference.direction} by ` +
            `${reference.path} and ${other.direction} by ${other.path}; one relation cannot read both ways and one way`,
        })
        continue
      }
      const opposite = other.source === reference.target && other.target === reference.source
      if (other.direction === 'directed' && opposite) {
        findings.push({
          code: 'RELATION_CONFLICT',
          path: other.path,
          otherPath: reference.path,
          detail:
            `${reference.source} ⇄ ${reference.target} (${reference.relationKind}) is declared in both directions ` +
            `(${reference.path} and ${other.path}); a directed relation has one direction — mark it \`dir: undirected\` if it reads both ways`,
        })
      }
    }
  }
  return findings
}

/** `relations/<slug>.md`, or `undefined` when the caller's path leaves the directory. */
export function normalizeRelationPath(input: string): string | undefined {  const value = input.trim().replaceAll('\\', '/')
  if (value === '' || value.startsWith('/') || /^[a-zA-Z]:/u.test(value) || value.split('/').includes('..')) {
    return undefined
  }
  const prefix = 'relations/'
  if (!value.startsWith(prefix)) return undefined
  const rest = value.slice(prefix.length)
  if (rest.length <= 3 || !rest.toLowerCase().endsWith('.md')) return undefined
  if (rest.includes('/')) return undefined
  return value
}

/** Filename-safe segment: ids are allowed to be paths or uuids, neither is a slug. */
function fileSegment(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/-{2,}/gu, '-')
    .replace(/^[-.]+|[-.]+$/gu, '')
  return cleaned === '' ? 'edge' : cleaned
}

const MAX_SLUG_CHARS = 96

/**
 * Deterministic default filename for an edge: `<source>--<target>.md`.
 *
 * A name derived from the two ends is what makes "one edge, one file" visible in a
 * directory listing, and it keeps the path stable when the same edge is written
 * again. Long ids are truncated with a short hash of the *full* pair, so two edges
 * that only differ past the cut still get different files.
 */
export function defaultRelationPath(source: string, target: string): string {
  const base = `${fileSegment(source)}--${fileSegment(target)}`
  if (base.length <= MAX_SLUG_CHARS) return `relations/${base}.md`
  const digest = createHash('sha256').update(base).digest('hex').slice(0, 8)
  return `relations/${base.slice(0, MAX_SLUG_CHARS)}-${digest}.md`
}

function titleOf(requested: string | undefined, existing: string | undefined, source: string, target: string): string {
  const explicit = clean(requested) ?? clean(existing)
  return explicit ?? `${source} → ${target}`
}

/**
 * Decide what one upsert means, or refuse it with a code.
 *
 * Keying: with `path` given the edge lives at that path; with `id` given it is the
 * file that already owns that id; otherwise the path is derived from the two ends,
 * so re-running the same call updates the same file instead of minting a second one.
 * An existing row at that path keeps its `id`, so an in-place edit cannot silently
 * re-key the entity the projection already published.
 */
export function planRelationUpsert(view: RelationUpsertView, request: RelationUpsertRequest): RelationPlan {
  const source = clean(request.source)
  const target = clean(request.target)
  if (source === undefined || target === undefined) {
    return refuse(
      'RELATION_ENDPOINT',
      source === undefined ? 'source is required (an edge names both of its ends)' : 'target is required (an edge names both of its ends)',
      'pass the entity ids of the two ends; `inkflow_relation_list` shows the ids already in use',
    )
  }

  const kindInput = clean(request.relationKind)
  const kindValue = (kindInput ?? 'character').toLowerCase()
  const relationKind = RELATION_KINDS.find((kind) => kind === kindValue)
  if (relationKind === undefined) {
    return refuse('RELATION_FIELD_INVALID', `kind must be one of ${RELATION_KINDS.join(' / ')} (got "${kindInput ?? ''}")`)
  }

  const directionInput = clean(request.direction)
  const directionValue = (directionInput ?? 'directed').toLowerCase()
  const direction = RELATION_DIRECTIONS.find((candidate) => candidate === directionValue)
  if (direction === undefined) {
    return refuse('RELATION_FIELD_INVALID', `dir must be one of ${RELATION_DIRECTIONS.join(' / ')} (got "${directionInput ?? ''}")`)
  }

  if (source === target) {
    return refuse(
      'RELATION_SELF_LOOP',
      `source and target are both "${source}"; an edge joins two different entities`,
      direction === 'undirected'
        ? 'an undirected edge is still a pair: direction does not make a self-loop meaningful'
        : undefined,
    )
  }

  // I-08: each end must resolve to exactly one entity of the book. Two kinds may
  // legitimately share an id (X-1), which is why "exactly one" and not "at least one".
  const endChecks: ReadonlyArray<readonly [string, string]> = [
    ['source', source],
    ['target', target],
  ]
  for (const [role, value] of endChecks) {
    const hits = view.entities.filter((entity) => entity.id === value)
    if (hits.length === 0) {
      return refuse(
        'RELATION_ENDPOINT',
        `${role} "${value}" does not resolve to an entity of this book`,
        'both ends must be ids of an existing chapters/characters/world/outlines/relations entity; use inkflow_relation_list or inkflow_chapter_search to find the right id',
      )
    }
    if (hits.length > 1) {
      return refuse(
        'RELATION_ENDPOINT',
        `${role} "${value}" is ambiguous: ${String(hits.length)} entities share that id (${hits.map((hit) => hit.kind).join(', ')})`,
        'rename one of them or give the id a kind-unique value',
      )
    }
  }

  let requestedPath: string | undefined
  if (request.path !== undefined) {
    const normalized = normalizeRelationPath(request.path)
    if (normalized === undefined) {
      return refuse(
        'RELATION_PATH_INVALID',
        `"${request.path}" is not a relation file path`,
        'a relation lives at relations/<slug>.md (one level, Markdown, inside the project)',
      )
    }
    requestedPath = normalized
  }

  const requestedId = clean(request.id)
  const byId = requestedId === undefined ? undefined : view.rows.find((row) => row.id === requestedId)
  const path = requestedPath ?? byId?.path ?? defaultRelationPath(source, target)
  const existing = view.rows.find((row) => row.path === path)

  const id = requestedId ?? existing?.id ?? path
  const idOwner = view.rows.find((row) => row.id === id && row.path !== path)
  if (idOwner !== undefined) {
    return refuse(
      'RELATION_FIELD_INVALID',
      `id "${id}" is already used by ${idOwner.path}`,
      'omit id to key the edge on its two ends, or pass that path to edit the existing edge',
    )
  }

  const clash = view.rows.find(
    (row) =>
      row.path !== path && row.source === source && row.target === target && row.relationKind === relationKind,
  )
  if (clash !== undefined) {
    return refuse(
      'RELATION_DUPLICATE',
      `the edge ${source} → ${target} (${relationKind}) is already declared by ${clash.path}`,
      'one edge per (source, target, kind): pass that path to edit it, or change the relation kind',
    )
  }

  return {
    ok: true,
    created: existing === undefined,
    row: {
      id,
      path,
      title: titleOf(request.title, existing?.title, source, target),
      relationKind,
      source,
      target,
      direction,
      since: clean(request.since),
      until: clean(request.until),
      chapter: clean(request.chapter),
    },
  }
}

/** Frontmatter keys of a relation file, in the order a new file writes them. */
function relationEntries(row: RelationRow): Array<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [['id', row.id]]
  // The derived `source → target` name is not written: it is what a file *without* a
  // title reads as, so writing it would only add noise to every hand-made edge.
  if (row.title !== `${row.source} → ${row.target}`) entries.push(['title', row.title])
  entries.push(['source', row.source], ['target', row.target], ['kind', row.relationKind], ['dir', row.direction])
  for (const [key, value] of [
    ['since', row.since],
    ['until', row.until],
    ['chapter', row.chapter],
  ] as const) {
    if (value !== undefined) entries.push([key, value])
  }
  return entries
}

const OPTIONAL_KEYS = ['since', 'until', 'chapter'] as const

/**
 * The file text for one edge.
 *
 * An existing document is patched line by line instead of re-rendered: relation
 * files are authored by hand, and a wholesale rewrite would drop comments, key
 * order and any field this plugin does not know about (frontmatter.ts §patch). A
 * document that has prose but no frontmatter block keeps its prose and gains the
 * block on top, rather than being replaced by one.
 */
export function renderRelationFile(existingText: string | undefined, row: RelationRow): string {
  const entries = relationEntries(row)
  if (existingText !== undefined && splitFrontmatter(existingText).hasFrontmatter) {
    const written = new Set(entries.map(([key]) => key))
    const remove = OPTIONAL_KEYS.filter((key) => !written.has(key))
    const patched = patchFrontmatter(existingText, Object.fromEntries(entries), remove.length > 0 ? { remove } : {})
    return patched.text
  }
  const block = ['---', ...entries.map(([key, value]) => frontmatterLine(key, value)), '---', '', ''].join('\n')
  return existingText === undefined ? block : `${block}${existingText}`
}
