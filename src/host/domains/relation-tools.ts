/**
 * The two model-facing relation tools.
 *
 * Why a separate module from `relation.ts`: the domain file is about *what an edge
 * is* (parse, invariants, DDL), while these are about *how a tool writes one* —
 * project resolution, the confirm gate, the seam round trip, index refresh. Keeping
 * them together pushed `relation.ts` past the file-size limit (AGENTS.md §10.5) and
 * mixed two failure surfaces in one file.
 *
 * The registration path stays `relationDomain.tools()` (X-5): `tools.ts` is untouched,
 * and the domain hands its own `parseFile`/`validate` in so the write path runs the
 * **same** implementation a rebuild runs (X-4) instead of a second copy.
 */

import { join, resolve as resolvePath } from 'node:path'

import type { ContentBlock, JsonSchemaNode, ToolDefinition, ToolRunContext } from '../context.js'
import { writeTextAtomic } from '../io.js'
import { findProjectRoot } from '../project.js'
import { sessionCwd } from '../session-cwd.js'
import { applyCandidate } from './types.js'
import { chapterPlacementsForBook, listRelationsFor, titlesForIds } from './query.js'
import type { RelationEdge } from './query.js'
import { relationPeriodMarks } from './relation-period.js'
import type { RelationPeriodMark } from './relation-period.js'
import { RELATION_DIRECTIONS, RELATION_KINDS, planRelationUpsert, renderRelationFile } from './relation-write.js'
import type { RelationKind, RelationRow } from './relation-write.js'
import type { DomainModule, DomainToolDeps } from './types.js'
import { readText, rowsOf } from './scan-helpers.js'

/** The half of a domain module the write path needs: the same parse and the same judgement. */
type RelationDomain = Pick<DomainModule, 'parseFile' | 'validate'>

function text(lines: string[]): ContentBlock[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

const PROJECT_ROOT_PARAM = {
  type: 'string',
  description:
    'Absolute path of the InkFlow project root. Omit when the session working directory is inside the book (the tool then walks up from it).',
} as const

const SUCCESS_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: true,
}

interface RootLookup {
  root?: string
  error?: { code: string; message: string; hint?: string }
}

/**
 * Resolve the book without a Host context.
 *
 * An explicit `projectRoot` wins; otherwise the book is resolved from the **session's**
 * working directory via `sessionCwd(deps.ctx, exec)` — the same anchor a built-in tool
 * uses, and never bare `process.cwd()` (inside the host process that is the DSH
 * install directory, so the tool would always report NOT_AN_INKFLOW_PROJECT).
 */
async function projectRootOf(value: unknown, deps: DomainToolDeps, exec: ToolRunContext): Promise<RootLookup> {
  const explicit = optionalString(value)
  if (explicit !== undefined && explicit.trim() !== '') return { root: resolvePath(explicit.trim()) }
  const found = findProjectRoot(await sessionCwd(deps.ctx, exec))
  if (found === undefined) {
    return {
      error: {
        code: 'NOT_AN_INKFLOW_PROJECT',
        message: 'no InkFlow project found from the session working directory',
        hint: 'pass projectRoot: the absolute path of the book',
      },
    }
  }
  return { root: found }
}

/**
 * The build seam, loaded on demand: `indexer.ts` imports the registry, so a static
 * import back into it would close a cycle.
 *
 * `applyCandidate` is **not** part of the seam any more: the domain split moved it to `types.ts`
 * precisely so a domain can fold a candidate without touching the registry.
 */
async function seam() {
  const [indexer, build] = await Promise.all([import('../indexer.js'), import('../index-build.js')])
  return { scanProject: indexer.scanProject, buildIndex: build.buildIndex }
}

/** One edge as the model sees it: the frontmatter field names, not the row's. */
function relationView(row: RelationRow): Record<string, unknown> {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    source: row.source,
    target: row.target,
    kind: row.relationKind,
    dir: row.direction,
    since: row.since,
    until: row.until,
    chapter: row.chapter,
  }
}

/**
 * Time-window marks for the edges a read is about to return.
 *
 * The judgement runs on the **edges the read already has**, not on a second query: every
 * edge that can contradict one of them joins the same `(unordered pair, kind)` bucket and
 * therefore also touches the entity being asked about. Only a `limit` that cuts a bucket in
 * half can hide a partner, which is why the mark is advisory and the audit reports the
 * book-wide list.
 *
 * A missing index answers no marks: the callers have already refused with
 * `INDEX_UNAVAILABLE` at that point, and inventing "no problems" for a book no one could
 * read is the silent empty list this module exists to avoid elsewhere.
 */
function periodMarksOf(root: string, edges: readonly RelationEdge[]): Map<string, RelationPeriodMark> {
  if (edges.length === 0) return new Map()
  const positions = chapterPlacementsForBook(root)
  if (positions === undefined) return new Map()
  return relationPeriodMarks(edges.map(toPeriodRow), positions)
}

/**
 * An index edge as the row the judgement reads.
 *
 * `kind` and `dir` are strings in the index payload (they are what an author may have
 * hand-written); an unknown value degrades to the same defaults the parser applies, so a
 * malformed row is marked from its windows instead of being dropped from the check.
 */
function toPeriodRow(edge: RelationEdge): RelationRow {
  const kind: RelationKind = RELATION_KINDS.find((candidate) => candidate === edge.kind) ?? 'character'
  return {
    id: edge.id,
    path: edge.path,
    title: edge.title,
    relationKind: kind,
    source: edge.source,
    target: edge.target,
    direction: edge.dir === 'undirected' ? 'undirected' : 'directed',
    since: edge.since,
    until: edge.until,
    chapter: edge.chapter,
  }
}

/** The edge plus its window mark, when it has one. */
function withPeriod(edge: RelationEdge, marks: ReadonlyMap<string, RelationPeriodMark>): Record<string, unknown> {
  const mark = marks.get(edge.path)
  return { ...edge, ...(mark === undefined ? {} : { period: mark }) }
}

/** One line of "what is wrong with this edge's window", for the tool's text reply. */
function periodLine(mark: RelationPeriodMark | undefined): string[] {
  if (mark === undefined) return []
  const lines: string[] = []
  if (mark.conflict !== undefined) {
    lines.push(
      mark.conflict.otherPath === undefined
        ? '  ! 时段矛盾：这条边自己的 since/until 写不出成立的区间'
        : `  ! 时段矛盾：与 ${mark.conflict.otherPath} 的时段不可能同时成立`,
    )
  }
  if (mark.uncomparable !== undefined) lines.push('  ? 时段无法判定：有一端不是本书的章 id')
  return lines
}

const upsertSurface: Omit<ToolDefinition, 'execute'> = {
  name: 'inkflow_relation_upsert',
  description:
    'Create or update one relation edge at relations/<slug>.md and rebuild the index. An edge names two entity ids of the book ' +
    '(any kind: characters, world, outlines, chapters or other relations) and a `kind` — a person-to-person relation or a ' +
    'knowledge-graph relation. Refused with RELATION_ENDPOINT / RELATION_SELF_LOOP / RELATION_DUPLICATE when the edge would ' +
    'violate I-08; a refusal writes nothing.',
  parameters: {
    type: 'object',
    properties: {
      projectRoot: PROJECT_ROOT_PARAM,
      source: { type: 'string', description: 'Entity id of the tail of the edge (the end the relation starts from).' },
      target: { type: 'string', description: 'Entity id of the head of the edge. Must differ from `source`.' },
      kind: {
        type: 'string',
        enum: [...RELATION_KINDS],
        description: '`character` for a person-to-person relation, `knowledge` for a knowledge-graph relation. Default `character`.',
      },
      dir: {
        type: 'string',
        enum: [...RELATION_DIRECTIONS],
        description: '`directed` (default) when the edge reads one way; `undirected` when it reads the same both ways.',
      },
      since: { type: 'string', description: 'Where the relation starts holding (chapter id or free label).' },
      until: { type: 'string', description: 'Where the relation stops holding.' },
      chapter: { type: 'string', description: 'Chapter id this edge is anchored to.' },
      id: {
        type: 'string',
        description: 'Stable id of the edge. Omit: an existing edge keeps its id, a new one uses its path.',
      },
      path: { type: 'string', description: 'Explicit `relations/<slug>.md`. Omit to derive it from the two ends.' },
      title: { type: 'string', description: "Display name. Omit to use `source → target` (or the file's existing title)." },
      confirm: {
        type: 'boolean',
        description: 'Must be `true`: the call writes a file. Anything else is refused with CONFIRM_REQUIRED and writes nothing.',
      },
    },
    required: ['source', 'target', 'confirm'],
    additionalProperties: false,
  },
  output: {
    schema: SUCCESS_SCHEMA,
    render: (_args, value) => {
      const v = asRecord(value)
      if (v['ok'] !== true) {
        const error = asRecord(v['error'])
        return text([
          `Relation upsert failed: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`,
          ...(error['path'] === undefined ? [] : [`path: ${String(error['path'])}`]),
          ...(error['hint'] === undefined ? [] : [String(error['hint'])]),
        ])
      }
      const relation = asRecord(v['relation'])
      const rebuilt = v['indexRebuilt'] === true ? 'index rebuilt' : 'index left as it was'
      const failure = v['indexError'] === undefined ? '' : ` (index rebuild failed: ${String(asRecord(v['indexError'])['code'])})`
      return text([
        `${v['created'] === true ? 'Created' : 'Updated'} relation ${String(relation['source'])} → ${String(relation['target'])} ` +
          `(${String(relation['kind'])}, ${String(relation['dir'])}) at ${String(relation['path'])}.`,
        `${rebuilt}${failure}; commit the new file with the rest of your writing.`,
      ])
    },
  },
}

const listSurface: Omit<ToolDefinition, 'execute'> = {
  name: 'inkflow_relation_list',
  description:
    'List every edge that touches one entity — both the edges where it is `source` and the edges where it is `target` — read ' +
    'from the derived index (rebuilt first when stale). Ordered by kind and path; a missing or foreign-schema index is ' +
    'reported as INDEX_UNAVAILABLE instead of an empty list.',
  parameters: {
    type: 'object',
    properties: {
      projectRoot: PROJECT_ROOT_PARAM,
      entity: {
        type: 'string',
        description: 'Entity id whose edges to list (a character, world, outline, chapter or relation id).',
      },
      limit: { type: 'integer', description: 'Maximum edges to return (1–500). Default 100.' },
    },
    required: ['entity'],
    additionalProperties: false,
  },
  output: {
    schema: SUCCESS_SCHEMA,
    render: (_args, value) => {
      const v = asRecord(value)
      if (v['ok'] !== true) {
        const error = asRecord(v['error'])
        return text([`Relation list failed: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`])
      }
      const edges = Array.isArray(v['edges']) ? (v['edges'] as Record<string, unknown>[]) : []
      if (edges.length === 0) return text([`No relations touch ${String(v['entity'])}.`])
      const lines = [`${String(edges.length)} relation(s) touch ${String(v['entity'])}:`]
      for (const edge of edges) {
        const asSource = edge['source'] === v['entity']
        const other = asSource ? String(edge['target']) : String(edge['source'])
        lines.push(
          `- (${asSource ? 'as source' : 'as target'}, ${String(edge['kind'])}, ${String(edge['dir'])}) ${other} — ${String(edge['path'])}`,
        )
        lines.push(...periodLine(edge['period'] as RelationPeriodMark | undefined))
      }
      return text(lines)
    },
  },
}

const cluesSurface: Omit<ToolDefinition, 'execute'> = {
  name: 'inkflow_relation_clues',
  description:
    'The clue view of the knowledge graph: given one entity id, list the entities connected to it **grouped by relation ' +
    `kind** (${RELATION_KINDS.join(' / ')}) with each peer's title, the direction as this entity sees it ('outgoing' / 'incoming' / 'both') and the edge file. ` +
    'Read-only, from the derived index (rebuilt first when stale). Use it to answer "who is this person connected to, and how"; ' +
    'use inkflow_relation_list when you need the flat edge list to edit one.',
  parameters: {
    type: 'object',
    properties: {
      projectRoot: PROJECT_ROOT_PARAM,
      entity: { type: 'string', description: 'Entity id whose clues to group (character, world, outline, chapter or relation id).' },
      kind: {
        type: 'string',
        enum: [...RELATION_KINDS],
        description: 'Only this relation kind. Omit for every kind.',
      },
      limit: { type: 'integer', description: 'Maximum edges to read before grouping (1–500). Default 100.' },
    },
    required: ['entity'],
    additionalProperties: false,
  },
  output: {
    schema: SUCCESS_SCHEMA,
    render: (_args, value) => {
      const v = asRecord(value)
      if (v['ok'] !== true) {
        const error = asRecord(v['error'])
        return text([`Clue view failed: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`])
      }
      const groups = Array.isArray(v['groups']) ? (v['groups'] as Record<string, unknown>[]) : []
      if (groups.length === 0) return text([`No relations touch ${String(v['entity'])}.`])
      const name = String(v['entityTitle'] ?? '') === '' ? String(v['entity']) : `${String(v['entityTitle'])} (${String(v['entity'])})`
      const lines = [`${name} — ${String(v['total'])} clue(s) in ${String(v['kinds'])} kind(s):`]
      for (const group of groups) {
        lines.push(`[${String(group['kind'])}] ${String(group['count'])}`)
        const peers = Array.isArray(group['peers']) ? (group['peers'] as Record<string, unknown>[]) : []
        for (const peer of peers) {
          const peerName = String(peer['title'] ?? '') === '' ? String(peer['id']) : `${String(peer['title'])} (${String(peer['id'])})`
          lines.push(`  - ${peerName} — ${String(peer['direction'])}, ${String(peer['path'])}`)
          lines.push(...periodLine(peer['period'] as RelationPeriodMark | undefined))
        }
      }
      return text(lines)
    },
  },
}

async function runRelationUpsert(
  args: unknown,
  exec: ToolRunContext,
  deps: DomainToolDeps,
  domain: RelationDomain,
): Promise<Record<string, unknown>> {
  const a = asRecord(args)
  if (a['confirm'] !== true) {
    return {
      ok: false,
      error: { code: 'CONFIRM_REQUIRED', message: 'inkflow_relation_upsert writes a file; pass confirm: true to run it' },
    }
  }

  const lookup = await projectRootOf(a['projectRoot'], deps, exec)
  if (lookup.root === undefined) return { ok: false, error: lookup.error }

  const root = lookup.root
  const { scanProject, buildIndex } = await seam()
  const scan = scanProject(root)
  const rows = rowsOf<RelationRow>(scan, 'relations')

  const plan = planRelationUpsert(
    { rows, entities: scan.entities },
    {
      source: optionalString(a['source']) ?? '',
      target: optionalString(a['target']) ?? '',
      relationKind: optionalString(a['kind']),
      direction: optionalString(a['dir']),
      since: optionalString(a['since']),
      until: optionalString(a['until']),
      chapter: optionalString(a['chapter']),
      id: optionalString(a['id']),
      path: optionalString(a['path']),
      title: optionalString(a['title']),
    },
  )
  if (!plan.ok) return { ok: false, error: plan.error }

  // The second net (X-4): the same `validate()` a rebuild runs, on the post-write
  // view, so the file that lands can never be one the next rebuild calls broken.
  const existing = rows.find((row) => row.path === plan.row.path)
  const document = renderRelationFile(existing === undefined ? undefined : readText(join(root, plan.row.path)), plan.row)
  const parsed = domain.parseFile({ root, path: plan.row.path, text: document })
  const view = applyCandidate(
    { scan: { tables: scan.tables, entities: scan.entities, issues: scan.issues }, entities: scan.entities },
    parsed,
  )
  const blocking = domain.validate({ root, scan: view.scan, entities: view.entities, candidate: { path: plan.row.path } })
  if (blocking.length > 0) {
    const first = blocking[0]
    return {
      ok: false,
      error: {
        code: first?.code ?? 'RELATION_FIELD_INVALID',
        message: first?.detail ?? 'the relation would violate an invariant',
        path: first?.path,
        issues: blocking,
      },
    }
  }

  const written = writeTextAtomic(root, plan.row.path, document)
  if (!written.ok) {
    return { ok: false, error: { code: written.error.code, message: written.error.message, path: plan.row.path } }
  }

  const result: Record<string, unknown> = {
    ok: true,
    created: plan.created,
    relation: relationView(plan.row),
    bytes: written.bytes,
    indexRebuilt: false,
  }
  try {
    await buildIndex(root)
    result['indexRebuilt'] = true
  } catch (cause) {
    // The index is a cache: a failed rebuild is reported, never rolled back.
    const failure = asRecord(cause)
    result['indexError'] = {
      code: String(failure['code'] ?? 'INDEX_BUILD_FAILED'),
      message: String(failure['message'] ?? ''),
    }
  }
  return result
}

async function runRelationList(args: unknown, exec: ToolRunContext, deps: DomainToolDeps): Promise<Record<string, unknown>> {
  const a = asRecord(args)
  const lookup = await projectRootOf(a['projectRoot'], deps, exec)
  if (lookup.root === undefined) return { ok: false, error: lookup.error }

  const entity = (optionalString(a['entity']) ?? '').trim()
  if (entity === '') {
    return { ok: false, error: { code: 'ENTITY_REQUIRED', message: 'pass entity: the id whose edges to list' } }
  }

  const root = lookup.root
  const { ensureIndex } = await import('../index-freshness.js')
  const ensured = await ensureIndex(root)
  if (!ensured.ok) {
    return {
      ok: false,
      error: {
        code: 'INDEX_UNAVAILABLE',
        message: `the derived index could not be built: ${ensured.failure.message}`,
        indexState: ensured.state,
      },
    }
  }

  const limit = typeof a['limit'] === 'number' ? Math.trunc(a['limit']) : undefined
  const edges = listRelationsFor(root, entity, limit)
  if (edges === undefined) {
    return {
      ok: false,
      error: { code: 'INDEX_UNAVAILABLE', message: 'the index is missing or was built by another schema version' },
    }
  }
  const marks = periodMarksOf(root, edges)
  return { ok: true, entity, count: edges.length, edges: edges.map((edge) => withPeriod(edge, marks)) }
}

/**
 * The clue view: one entity, grouped by relation type, with the peer's **name**.
 *
 * Why a second read tool beside `inkflow_relation_list`: that one answers "which files
 * touch this id" — a flat, path-ordered edge list, which is what an edit needs. A clue
 * view answers a different question ("who is this person connected to, and how"), so it
 * groups by `kind`, resolves each peer's title from the projection, and says which way
 * each edge reads from **this** entity's side (`outgoing` / `incoming` / `both`). Writing
 * the panel instead was the alternative; a tool was chosen because it costs no new page,
 * no route and no client bundle for a view a model can render in one reply.
 */
async function runRelationClues(args: unknown, exec: ToolRunContext, deps: DomainToolDeps): Promise<Record<string, unknown>> {
  const a = asRecord(args)
  const lookup = await projectRootOf(a['projectRoot'], deps, exec)
  if (lookup.root === undefined) return { ok: false, error: lookup.error }

  const entity = (optionalString(a['entity']) ?? '').trim()
  if (entity === '') {
    return { ok: false, error: { code: 'ENTITY_REQUIRED', message: 'pass entity: the id whose clues to group' } }
  }

  const root = lookup.root
  const { ensureIndex } = await import('../index-freshness.js')
  const ensured = await ensureIndex(root)
  if (!ensured.ok) {
    return {
      ok: false,
      error: {
        code: 'INDEX_UNAVAILABLE',
        message: `the derived index could not be built: ${ensured.failure.message}`,
        indexState: ensured.state,
      },
    }
  }

  const wanted = optionalString(a['kind'])
  const kindFilter = wanted === undefined ? undefined : RELATION_KINDS.find((kind) => kind === wanted.trim().toLowerCase())
  if (wanted !== undefined && kindFilter === undefined) {
    return {
      ok: false,
      error: { code: 'RELATION_FIELD_INVALID', message: `kind must be one of ${RELATION_KINDS.join(' / ')}` },
    }
  }

  const limit = typeof a['limit'] === 'number' ? Math.trunc(a['limit']) : undefined
  const edges = listRelationsFor(root, entity, limit)
  if (edges === undefined) {
    return {
      ok: false,
      error: { code: 'INDEX_UNAVAILABLE', message: 'the index is missing or was built by another schema version' },
    }
  }

  const kept = kindFilter === undefined ? edges : edges.filter((edge) => edge.kind === kindFilter)
  const marks = periodMarksOf(root, kept)
  const peers = kept.map((edge) => (edge.source === entity ? edge.target : edge.source))
  // The entity itself is asked for too, so the reply can name what it is talking about.
  const titles = titlesForIds(root, [...new Set([entity, ...peers])])
  if (titles === undefined) {
    return { ok: false, error: { code: 'INDEX_UNAVAILABLE', message: 'the entity projection could not be read' } }
  }
  const titleOf = (id: string): string => titles[id] ?? ''

  // One group per relation kind, in the vocabulary's own order (data-model §3.3), so two
  // reads of the same book return the same shape.
  const groups = RELATION_KINDS.filter((kind) => kindFilter === undefined || kind === kindFilter)
    .map((kind) => {
      const rows = kept
        .filter((edge) => edge.kind === kind)
        .map((edge) => {
          const outgoing = edge.source === entity
          const peer = outgoing ? edge.target : edge.source
          const mark = marks.get(edge.path)
          return {
            id: peer,
            title: titleOf(peer),
            direction: edge.dir === 'undirected' ? 'both' : outgoing ? 'outgoing' : 'incoming',
            path: edge.path,
            ...(edge.since === undefined ? {} : { since: edge.since }),
            ...(edge.until === undefined ? {} : { until: edge.until }),
            ...(edge.chapter === undefined ? {} : { chapter: edge.chapter }),
            ...(mark === undefined ? {} : { period: mark }),
          }
        })
        .sort((left, right) => (left.id === right.id ? 0 : left.id < right.id ? -1 : 1))
      return { kind, count: rows.length, peers: rows }
    })
    .filter((group) => group.count > 0)

  return {
    ok: true,
    entity,
    entityTitle: titleOf(entity),
    total: kept.length,
    kinds: groups.length,
    groups,
  }
}

/**
 * The relation tool surface, bound to the domain that owns the parse and the
 * invariants — passed in rather than imported, so neither module depends on the other.
 */
export function relationTools(domain: RelationDomain, deps: DomainToolDeps): ToolDefinition[] {
  return [
    { ...upsertSurface, execute: async (args, exec) => runRelationUpsert(args, exec, deps, domain) },
    { ...listSurface, execute: async (args, exec) => runRelationList(args, exec, deps) },
    { ...cluesSurface, execute: async (args, exec) => runRelationClues(args, exec, deps) },
  ]
}
