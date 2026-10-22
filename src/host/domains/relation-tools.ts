/**
 * The two model-facing relation tools (issue #27).
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

import type { ContentBlock, JsonSchemaNode, ToolDefinition } from '../context.js'
import { writeTextAtomic } from '../io.js'
import { findProjectRoot } from '../project.js'
import { listRelationsFor } from './query.js'
import { RELATION_DIRECTIONS, RELATION_KINDS, planRelationUpsert, renderRelationFile } from './relation-write.js'
import type { RelationRow } from './relation-write.js'
import type { DomainModule } from './types.js'
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
 * A domain module's `tools()` receives no `ToolDeps` (X-5: the registry only
 * assembles), so the session working directory is not reachable the way `tools.ts`
 * reaches it. An explicit `projectRoot` is therefore the reliable form, and
 * `process.cwd()` is only the fallback for a host that runs inside the book.
 */
function projectRootOf(value: unknown): RootLookup {
  const explicit = optionalString(value)
  if (explicit !== undefined && explicit.trim() !== '') return { root: resolvePath(explicit.trim()) }
  const found = findProjectRoot(process.cwd())
  if (found === undefined) {
    return {
      error: {
        code: 'NOT_AN_INKFLOW_PROJECT',
        message: 'no InkFlow project found from the process working directory',
        hint: 'pass projectRoot: the absolute path of the book',
      },
    }
  }
  return { root: found }
}

/** The seam, loaded on demand: a static import would close a cycle through the registry. */
async function seam() {
  const [indexer, build, registry] = await Promise.all([
    import('../indexer.js'),
    import('../index-build.js'),
    import('./index.js'),
  ])
  return { scanProject: indexer.scanProject, buildIndex: build.buildIndex, applyCandidate: registry.applyCandidate }
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
      limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum edges to return. Default 100.' },
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
      }
      return text(lines)
    },
  },
}

async function runRelationUpsert(args: unknown, domain: RelationDomain): Promise<Record<string, unknown>> {
  const a = asRecord(args)
  if (a['confirm'] !== true) {
    return {
      ok: false,
      error: { code: 'CONFIRM_REQUIRED', message: 'inkflow_relation_upsert writes a file; pass confirm: true to run it' },
    }
  }

  const lookup = projectRootOf(a['projectRoot'])
  if (lookup.root === undefined) return { ok: false, error: lookup.error }

  const root = lookup.root
  const { scanProject, buildIndex, applyCandidate } = await seam()
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

async function runRelationList(args: unknown): Promise<Record<string, unknown>> {
  const a = asRecord(args)
  const lookup = projectRootOf(a['projectRoot'])
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
  return { ok: true, entity, count: edges.length, edges }
}

/**
 * The relation tool surface, bound to the domain that owns the parse and the
 * invariants — passed in rather than imported, so neither module depends on the other.
 */
export function relationTools(domain: RelationDomain): ToolDefinition[] {
  return [
    { ...upsertSurface, execute: async (args) => runRelationUpsert(args, domain) },
    { ...listSurface, execute: async (args) => runRelationList(args) },
  ]
}
