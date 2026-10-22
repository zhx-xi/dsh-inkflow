/**
 * The world domain's two model-facing tools (#26): `inkflow_world_tree` and
 * `inkflow_world_upsert`.
 *
 * Why they live in the domain instead of `tools.ts`: roadmap §2.1 X-5 — a domain
 * branch adds one line to `DOMAIN_MODULES` and never to the built-in tool array.
 *
 * They resolve the book the same way a built-in tool does: an explicit `projectRoot`
 * first, else the **session's** working directory via `sessionCwd(deps.ctx, exec)`.
 * Never bare `process.cwd()` — inside the host process that is the DSH install
 * directory, so the tool would always report `NOT_AN_INKFLOW_PROJECT`.
 *
 * Everything that writes goes through `io.ts` (path checks + write lock + atomic
 * replace); everything that reads goes through the derived index, made fresh by
 * `ensureIndex()`.
 */

import { resolve as resolvePath } from 'node:path'

import type { ContentBlock, JsonSchemaNode, ToolDefinition, ToolRunContext } from '../context.js'
import { frontmatterLine } from '../frontmatter.js'
import { buildIndex, describeIndexBuildFailure } from '../index-build.js'
import { ensureIndex } from '../index-freshness.js'
import { writeTextAtomic } from '../io.js'
import { findProjectRoot, inspectProject } from '../project.js'
import { sessionCwd } from '../session-cwd.js'
import { listEntityIds, listWorldEntries } from './query.js'
import { buildWorldTree, planWorldUpsert } from './world-plan.js'
import type { WorldUpsertCandidate } from './world-plan.js'
import type { DomainToolDeps } from './types.js'

type Json = Record<string, unknown>

function text(lines: string[]): ContentBlock[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Tool argument → keyword list: an array, or one comma/。separated string. */
function readKeywords(value: unknown): string[] {
  const split = (text: string): string[] =>
    text
      .split(/[,，、]/u)
      .map((item) => item.trim())
      .filter((item) => item !== '')
  if (typeof value === 'string') return split(value)
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').flatMap((item) => split(item))
  }
  return []
}

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {}
}

/** A JSON argument that is not a string counts as "not given"; validation is the tool's job. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

const PROJECT_ROOT_PARAM = {
  type: 'string',
  description:
    'Absolute path of the InkFlow project root. Omit to resolve from the process working directory (walks up to the nearest project).',
} as const

const OUTPUT_SCHEMA: JsonSchemaNode = { type: 'object', required: ['ok'], additionalProperties: true }

/** Characters a slug or a category may never carry: path separators, control bytes, Windows-reserved shapes. */
const UNSAFE_SEGMENT = /[<>:"|?*\\/\u0000-\u001f]/u
const SLUG_MAX = 60

/**
 * Title → file slug. CJK survives as-is (a Chinese title needs no transliteration
 * and stays readable in `git diff`); whitespace and anything a filesystem would
 * rewrite collapses to a single `-`. Same rule as a chapter slug, kept local
 * because `chapters.ts` does not export its own.
 */
function slugify(title: string): string {
  const normalized = title.normalize('NFKC').replace(UNSAFE_SEGMENT, '-').replace(/\s+/gu, '-').replace(/-+/gu, '-')
  const trimmed = normalized.replace(/^[-. ]+/u, '').replace(/[-. ]+$/u, '')
  return [...trimmed].slice(0, SLUG_MAX).join('').replace(/[-. ]+$/u, '')
}

/** Keywords as an inline list: `keywords: [白鹤, 鹤鸣剑]` (what `conventions.md` §3.4 shows). */
function renderKeywords(keywords: readonly string[]): string {
  return `[${keywords.join(', ')}]`
}

interface WorldFileInput {
  readonly id: string
  readonly title: string
  readonly category?: string
  readonly parent?: string
  readonly keywords: readonly string[]
  readonly always: boolean
  readonly priority?: number
  readonly body: string
}

/**
 * The whole file text: the fields `scan()` reads, nothing invented. `always` and
 * `priority` are written only when meaningful, so a plain entry stays a three-line
 * frontmatter and `git diff` shows what the author actually asked for.
 */
function renderWorldFile(input: WorldFileInput): string {
  const lines = ['---', frontmatterLine('id', input.id), frontmatterLine('title', input.title)]
  if (input.category !== undefined) lines.push(frontmatterLine('category', input.category))
  if (input.parent !== undefined) lines.push(frontmatterLine('parent', input.parent))
  if (input.keywords.length > 0) lines.push(`keywords: ${renderKeywords(input.keywords)}`)
  if (input.always) lines.push('always: true')
  if (input.priority !== undefined) lines.push(`priority: ${String(input.priority)}`)
  lines.push('---', '')
  const body = input.body.replace(/^\n+/u, '').replace(/\s+$/u, '')
  return `${lines.join('\n')}\n${body === '' ? '' : `${body}\n`}`
}

/** Index failure, in the same shape `tools.ts` answers with, so the model sees one code family. */
function indexFailure(root: string, failure: { code: string; errno?: string; message: string }): Json {
  return {
    ok: false,
    root,
    error: {
      code: failure.code,
      ...(failure.errno === undefined ? {} : { errno: failure.errno }),
      message: failure.message,
      hint:
        failure.code === 'INDEX_BUSY'
          ? 'another session or process is already rebuilding this index; retry in a moment'
          : 'the previous index (if any) is still readable; fix the cause and rebuild',
    },
  }
}

/** Gate → run. A non-usable project gets the same four-state refusal `tools.ts` gives. */
async function withProject(
  deps: DomainToolDeps,
  exec: ToolRunContext,
  args: unknown,
  run: (root: string) => Promise<Json>,
): Promise<Json> {
  const a = asRecord(args)
  const requested = optionalString(a['projectRoot'])
  // Explicit argument first, then the session's working directory. Never bare
  // `process.cwd()`: inside the host process that is the DSH install directory, so a
  // tool would quietly target the wrong tree.
  const root = requested !== undefined ? resolvePath(requested) : findProjectRoot(await sessionCwd(deps.ctx, exec))
  if (root === undefined) {
    return {
      ok: false,
      error: {
        code: 'NOT_AN_INKFLOW_PROJECT',
        state: 'needs-setup',
        message: 'no InkFlow project was found from the process working directory',
        hint: 'pass projectRoot, or open the book so the session working directory is inside it',
      },
    }
  }
  const probe = inspectProject(root)
  if (probe.usable !== true) {
    const code =
      probe.state === 'needs-newer-plugin'
        ? 'PROJECT_NEEDS_NEWER_PLUGIN'
        : probe.state === 'needs-repair'
          ? 'PROJECT_NEEDS_REPAIR'
          : 'NOT_AN_INKFLOW_PROJECT'
    return {
      ok: false,
      error: {
        code,
        state: probe.state,
        root: probe.root,
        message: `this directory is not a usable InkFlow project (state: ${probe.state})`,
        missing: probe.missing,
        hint:
          code === 'PROJECT_NEEDS_NEWER_PLUGIN'
            ? 'this book was written by a newer dsh-inkflow; tell the user to upgrade the plugin'
            : 'run inkflow_project_plan, show the list to the user, then inkflow_project_init with confirm: true',
      },
    }
  }
  return run(probe.root)
}

function indent(depth: number): string {
  return '  '.repeat(depth)
}

function renderNode(node: Json, depth: number): string[] {
  const lines = [`${indent(depth)}- ${String(node['title'] ?? '')} — ${String(node['path'] ?? '')}`]
  for (const child of Array.isArray(node['children']) ? (node['children'] as Json[]) : []) {
    lines.push(...renderNode(child, depth + 1))
  }
  return lines
}

// ---------------------------------------------------------------------------
// inkflow_world_tree
// ---------------------------------------------------------------------------

function worldTreeTool(deps: DomainToolDeps): ToolDefinition {
  return {
    name: 'inkflow_world_tree',
  description:
    'Show the world tree of the book: every `world/<category>/` entry grouped by category, each entry carrying its children. ' +
    'I-08 allows at most one root and permits a "flat category book" with no root at all, so a missing top node is not an ' +
    'error. Read-only; the derived index is rebuilt first when it is stale. Call it when the user asks about the setting ' +
    'library, a category of the world, or where an entry sits.',
  parameters: {
    type: 'object',
    properties: {
      projectRoot: PROJECT_ROOT_PARAM,
      category: {
        type: 'string',
        description: 'Only show this category (`world/<category>/`), e.g. "门派". Omit for every category.',
      },
    },
    additionalProperties: false,
  },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_args, value) => {
      const v = asRecord(value)
      if (v['ok'] !== true) {
        const error = asRecord(v['error'])
        return text([`World tree unavailable: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`])
      }
      const groups = Array.isArray(v['groups']) ? (v['groups'] as Json[]) : []
      const total = typeof v['total'] === 'number' ? v['total'] : 0
      if (total === 0) return text(['The world book is empty: no entry under `world/` yet.'])
      const lines = [
        `${String(total)} world entr${total === 1 ? 'y' : 'ies'} in ${String(groups.length)} group(s)` +
          `${v['indexRebuilt'] === true ? ' (index rebuilt)' : ''}:`,
      ]
      for (const group of groups) {
        const category = group['category']
        lines.push(`[${category === null || category === undefined ? '未分类' : String(category)}]`)
        for (const node of Array.isArray(group['nodes']) ? (group['nodes'] as Json[]) : []) {
          lines.push(...renderNode(node, 1))
        }
      }
      const dangling = Array.isArray(v['danglingParents']) ? (v['danglingParents'] as unknown[]).map(String) : []
      if (dangling.length > 0) lines.push(`Missing parent(s): ${dangling.join(', ')} — run check and fix the frontmatter.`)
      return text(lines)
    },
  },
  execute: async (args, exec) =>
    withProject(deps, exec, args, async (root) => {
      const ensured = await ensureIndex(root)
      if (!ensured.ok) return indexFailure(root, ensured.failure)
      const entries = listWorldEntries(root)
      if (entries === undefined) {
        return indexFailure(root, { code: 'INDEX_UNAVAILABLE', message: 'the derived index could not be read' })
      }
      const requested = optionalString(asRecord(args)['category'])
      const filtered = requested === undefined ? entries : entries.filter((entry) => entry.category === requested)
      const tree = buildWorldTree(filtered)
      return {
        ok: true,
        root,
        category: requested ?? null,
        total: filtered.length,
        groups: tree.groups,
        danglingParents: tree.danglingParents,
        indexRebuilt: ensured.rebuilt,
        indexState: ensured.state,
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// inkflow_world_upsert
// ---------------------------------------------------------------------------

function worldUpsertTool(deps: DomainToolDeps): ToolDefinition {
  return {
    name: 'inkflow_world_upsert',
  description:
    'Create or replace one world-book entry: writes `world/<category>/<slug>.md` (or `world/<slug>.md` for a top-level ' +
    'entry) with `id` / `title` / `category` / `parent` / `keywords` / `always` / `priority`, then rebuilds the derived ' +
    'index. The write-side half of I-08 runs first and refuses a second root, a child without a category, a dangling ' +
    'parent or a duplicate id — a flat category book (every entry under `world/<category>/`, no parent) stays legal. ' +
    'Requires `confirm: true`, and writes nothing without it.',
  parameters: {
    type: 'object',
    properties: {
      projectRoot: PROJECT_ROOT_PARAM,
      title: { type: 'string', description: 'Entry title; the file slug derives from it.' },
      id: {
        type: 'string',
        description: 'Stable id. Omit to use the file path (the same default the parser applies), and keep it on edits.',
      },
      category: {
        type: 'string',
        description: 'Category (= the `world/<category>/` directory), e.g. "门派". Required when `parent` is set.',
      },
      parent: { type: 'string', description: 'Parent entry id (`world/` first-level entry with no parent is a root).' },
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: 'World-book trigger words: a chapter whose text contains one pulls this entry in.',
      },
      always: { type: 'boolean', description: 'True when this entry belongs to every chapter unconditionally.' },
      priority: {
        type: 'integer',
        description: 'Ordering among matches: higher first (absent counts as 0).',
      },
      body: { type: 'string', description: 'Entry body (Markdown). Omit for a stub with frontmatter only.' },
      slug: { type: 'string', description: 'File slug; omit to derive it from the title.' },
      confirm: {
        type: 'boolean',
        description: 'Set true only after the user has seen the path and the fields this call would write.',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_args, value) => {
      const v = asRecord(value)
      if (v['ok'] !== true) {
        const error = asRecord(v['error'])
        if (v['requiresConfirmation'] === true) {
          return text([
            `Confirmation required: ${String(error['message'] ?? '')}`,
            `Would write: ${String(v['willWrite'] ?? '?')}${v['replaced'] === true ? ' (replaces the existing file)' : ''}`,
            'Nothing was written. Show this to the user, then call again with confirm: true.',
          ])
        }
        return text([`World upsert refused: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`])
      }
      const indexLine =
        v['indexRebuilt'] === true
          ? 'index rebuilt.'
          : `index NOT rebuilt (${String(asRecord(v['indexError'])['code'] ?? 'unknown')}) — run inkflow_index_rebuild.`
      return text([
        `${v['created'] === true ? 'Created' : 'Replaced'} ${String(v['path'])} (id ${String(v['id'])}).`,
        indexLine,
      ])
    },
  },
  execute: async (args, exec) =>
    withProject(deps, exec, args, async (root) => {
      const a = asRecord(args)
      const title = optionalString(a['title'])
      if (title === undefined) {
        return { ok: false, root, error: { code: 'TITLE_REQUIRED', message: 'a world entry needs a title' } }
      }
      const category = optionalString(a['category'])
      const parent = optionalString(a['parent'])
      const slugInput = optionalString(a['slug']) ?? slugify(title)
      if (slugInput === '') {
        return { ok: false, root, error: { code: 'SLUG_INVALID', message: `"${title}" has no usable file slug` } }
      }
      if (UNSAFE_SEGMENT.test(slugInput) || slugInput.includes('/')) {
        return { ok: false, root, error: { code: 'SLUG_INVALID', message: `"${slugInput}" is not a portable file name` } }
      }
      if (category !== undefined && (UNSAFE_SEGMENT.test(category) || category.includes('/'))) {
        return { ok: false, root, error: { code: 'CATEGORY_INVALID', message: `"${category}" is not a portable directory name` } }
      }
      const rawPriority = a['priority']
      if (rawPriority !== undefined && !(typeof rawPriority === 'number' && Number.isInteger(rawPriority))) {
        return { ok: false, root, error: { code: 'PRIORITY_INVALID', message: 'priority must be an integer' } }
      }
      const keywords = readKeywords(a['keywords'])
      const path = category === undefined ? `world/${slugInput}.md` : `world/${category}/${slugInput}.md`
      // Editing an existing entry must keep its id, or every child that points at it
      // silently dangles: the write-side gate only knows the pre-write snapshot, so the
      // breakage would surface as DANGLING_PARENT on the *next* rebuild.
      const existing = listWorldEntries(root)?.find((entry) => entry.path === path)
      const id = optionalString(a['id']) ?? existing?.id ?? path
      const candidate: WorldUpsertCandidate = {
        id,
        path,
        title,
        ...(category === undefined ? {} : { category }),
        ...(parent === undefined ? {} : { parent }),
        keywords,
      }

      const ensured = await ensureIndex(root)
      if (!ensured.ok) return indexFailure(root, ensured.failure)
      const entries = listWorldEntries(root)
      const knownIds = listEntityIds(root)
      if (entries === undefined || knownIds === undefined) {
        return indexFailure(root, { code: 'INDEX_UNAVAILABLE', message: 'the derived index could not be read' })
      }

      const plan = planWorldUpsert({ entries, candidate, knownIds })
      if (!plan.ok) return { ok: false, root, error: plan.error }

      if (a['confirm'] !== true) {
        return {
          ok: false,
          root,
          requiresConfirmation: true,
          willWrite: plan.path,
          replaced: plan.replaced,
          error: {
            code: 'WORLD_UPSERT_REQUIRES_CONFIRMATION',
            message: `writing ${plan.path} needs confirmation`,
            hint: 'show the path and fields to the user; nothing was written. Call again with confirm: true',
          },
        }
      }

      const content = renderWorldFile({
        id,
        title,
        ...(category === undefined ? {} : { category }),
        ...(parent === undefined ? {} : { parent }),
        keywords,
        always: a['always'] === true,
        ...(rawPriority === undefined ? {} : { priority: rawPriority }),
        body: optionalString(a['body']) ?? '',
      })
      const written = writeTextAtomic(root, plan.path, content)
      if (!written.ok) return { ok: false, root, path: plan.path, error: written.error }

      let indexRebuilt = false
      let indexError: Json | undefined
      try {
        await buildIndex(root)
        indexRebuilt = true
      } catch (cause) {
        const failure = describeIndexBuildFailure(cause)
        indexError = { code: failure.code, message: failure.message }
      }

      return {
        ok: true,
        root,
        path: written.target.relative,
        id,
        replaced: plan.replaced,
        created: written.created,
        bytes: written.bytes,
        indexRebuilt,
        ...(indexError === undefined ? {} : { indexError }),
      }
    }),
  }
}

/** Both world tools, in registry order (X-5: the domain's whole model-facing surface). */
export function worldTools(deps: DomainToolDeps): readonly ToolDefinition[] {
  return [worldTreeTool(deps), worldUpsertTool(deps)]
}
