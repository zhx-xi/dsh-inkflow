/**
 * The world domain's two model-facing tools: `inkflow_world_tree` and
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
 * replace) **and** through the domain module's own judge: `parseFile()` →
 * `applyCandidate()` → `validate({ candidate })` before a byte lands, the same chain
 * `character-tools.ts` runs. `planWorldUpsert()` stays as the precheck that gives the
 * model a reason it can act on, but the gate is the domain's. Everything that reads
 * goes through the derived index, made fresh by `ensureIndex()`.
 */

import { join, resolve as resolvePath } from 'node:path'

import type { ContentBlock, JsonSchemaNode, ToolDefinition, ToolRunContext } from '../context.js'
import { frontmatterLine } from '../frontmatter.js'
import { buildIndex, describeIndexBuildFailure } from '../index-build.js'
import { ensureIndex } from '../index-freshness.js'
import { scanProject } from '../indexer.js'
import { withProjectWriteLock, writeTextAtomic } from '../io.js'
import { findProjectRoot, inspectProject } from '../project.js'
import { sessionCwd } from '../session-cwd.js'
import { listWorldEntries } from './query.js'
import { readText, rowsOf } from './scan-helpers.js'
import { applyCandidate } from './types.js'
import type { DomainModule, DomainWriteView, DomainToolDeps } from './types.js'
import type { WorldRow } from './world.js'
import { buildWorldTree, planWorldUpsert } from './world-plan.js'
import type { WorldUpsertCandidate } from './world-plan.js'

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

const OUTPUT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: true,
}

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

/**
 * Keywords as an inline list: `keywords: [白鹤, 鹤鸣剑]` (what `conventions.md` §3.4 shows).
 *
 * A value is quoted when the parser would otherwise read it as something else.
 * The renderer writes plain text but the reader is a YAML-shaped type guesser: a bare `true`
 * becomes boolean `true`, `null`/`~` become null, and `#` starts a comment — `keywordsOf()`
 * only keeps strings, so those keywords used to vanish between "written successfully" and
 * the next read. `parseScalar()` strips quotes, so `"true"` comes back as the string
 * `true`. Values that quoting CANNOT save (a comma breaks the inline list itself, a line
 * break ends it) are refused by `keywordProblem()` before we get here.
 */
function renderKeywords(keywords: readonly string[]): string {
  return `[${keywords.map(renderKeyword).join(', ')}]`
}

/** Quote a keyword unless it is already unambiguous, and escape what YAML reads specially. */
function renderKeyword(value: string): string {
  const quoted = `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  const needsQuotes =
    /^(?:true|false|null|~)$/iu.test(value) ||
    /[:#[\]{}&*?|>'"%@`]/u.test(value) ||
    value !== value.trim()
  return needsQuotes ? quoted : value
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
 *
 * Exported because the extraction accept path must produce the *same* document
 * from a candidate's `fields`: a second renderer would be a second dialect of
 * `world/<category>/<slug>.md`, and the two would drift the first time this one
 * gained a field.
 */
export function renderWorldFile(input: WorldFileInput): string {
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

/** One world row as the tools report it (null, not `undefined`, so it survives JSON). */
function worldView(row: WorldRow): Json {
  return {
    id: row.id,
    path: row.path,
    title: row.title,
    category: row.category ?? null,
    parent: row.parent ?? null,
    keywords: [...row.keywords],
    always: row.always,
    priority: row.priority ?? null,
  }
}

/** The fields the file now holds, on one line: a lossy render must not pass as success. */
function describeWorldRow(value: unknown): string {
  const row = asRecord(value)
  const parts: string[] = [`「${String(row['title'] ?? '')}」`]
  const category = row['category']
  parts.push(category === null || category === undefined ? 'no category' : `category ${String(category)}`)
  const parent = row['parent']
  if (parent !== null && parent !== undefined) parts.push(`parent ${String(parent)}`)
  const keywords = Array.isArray(row['keywords']) ? (row['keywords'] as unknown[]).map(String) : []
  if (keywords.length > 0) parts.push(`keywords ${keywords.join(', ')}`)
  if (row['always'] === true) parts.push('always')
  const priority = row['priority']
  if (priority !== null && priority !== undefined) parts.push(`priority ${String(priority)}`)
  return `Read back: ${parts.join(' · ')}.`
}

/** Everything `applyUpsert()` needs, already argued down to the shape one file has. */
interface WorldUpsertInput {
  readonly id?: string
  readonly title: string
  readonly path: string
  readonly category?: string
  readonly parent?: string
  readonly keywords: readonly string[]
  readonly always: boolean
  readonly priority?: number
  readonly body: string
  readonly confirm: boolean
}

/**
 * Three outcomes, not two: "nothing was written because the caller has not confirmed
 * yet" is a normal answer carrying the plan, not a refusal. Kept out of `error` so the
 * tool can hand the model `willWrite`/`replaced` at the top level (that is what the
 * confirmation prompt reads) without inventing an error code for a non-error.
 */
type WriteOutcome =
  | { readonly ok: true; readonly value: Json }
  | { readonly ok: false; readonly error: Json }
  | { readonly ok: false; readonly confirmation: { readonly willWrite: string; readonly replaced: boolean } }

function refusal(root: string, code: string, message: string, extra: Json = {}): WriteOutcome {
  return { ok: false, error: { code, message, root, ...extra } }
}

/**
 * The write side of X-4 for the world book, all of it under the project write lock:
 *
 *   1. `scanProject()`           — the pre-write view, read from the **files**; the
 *                                  derived index is a cache, and judging a write against
 *                                  a stale one is how a second root slips in
 *   2. `planWorldUpsert()`       — the tree rules early, so the model gets a reason it
 *                                  can act on before any text is rendered
 *   3. `renderWorldFile()`       — the one renderer (the accept path uses it too)
 *   4. `parseFile()`             — the document, parsed exactly as a rebuild parses it
 *   5. `applyCandidate()`        — the seam-owned "replace this one path" fold
 *   6. `validate({ candidate })` — the same invariants a rebuild runs; **this** is the
 *                                  gate, step 2 is only its precheck
 *   7. `writeTextAtomic()`       — only then, through `io.ts`
 *   8. `parseFile()` again       — the answer reports what the file now says
 *
 * Steps 1 and 5 come from layers above the registry (`indexer.ts`, `types.ts`), which is
 * why the orchestration lives up here and not in `world.ts`: a domain module must not
 * import the seam that imports it (`character-tools.ts` records the same reason).
 */
function applyUpsert(domain: DomainModule, projectRoot: string, input: WorldUpsertInput): WriteOutcome {
  const locked = withProjectWriteLock(resolvePath(projectRoot), (lock): WriteOutcome => {
    const root = lock.root
    const scan = scanProject(root)
    const view: DomainWriteView = {
      scan: { tables: scan.tables, entities: scan.entities, issues: scan.issues },
      entities: scan.entities,
    }
    const rows = rowsOf<WorldRow>(view.scan, 'world_entries')
    // Editing an existing entry must keep its id, or every child that points at it
    // silently dangles: the gate only knows the post-write snapshot, so the breakage
    // would surface as DANGLING_PARENT on the *next* rebuild.
    const existing = rows.find((row) => row.path === input.path)
    const id = input.id ?? existing?.id ?? input.path
    const candidate: WorldUpsertCandidate = {
      id,
      path: input.path,
      title: input.title,
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.parent === undefined ? {} : { parent: input.parent }),
      keywords: input.keywords,
    }

    const plan = planWorldUpsert({
      entries: rows,
      candidate,
      knownIds: new Set(view.entities.map((entity) => entity.id)),
    })
    if (!plan.ok) {
      return refusal(root, plan.error.code, plan.error.message, plan.error.path === undefined ? {} : { path: plan.error.path })
    }
    if (!input.confirm) {
      return { ok: false, confirmation: { willWrite: plan.path, replaced: plan.replaced } }
    }

    const text = renderWorldFile({
      id,
      title: input.title,
      ...(input.category === undefined ? {} : { category: input.category }),
      ...(input.parent === undefined ? {} : { parent: input.parent }),
      keywords: input.keywords,
      always: input.always,
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      body: input.body,
    })

    // Double insurance (X-4): the text we are about to write is judged by the very same
    // parser and invariants a rebuild uses, so an entry can never land in a state the
    // next rebuild would flag. This is also the one net the plan alone never had — it
    // judges the tree, never the document.
    const parsed = domain.parseFile({ root, path: plan.path, text })
    if (parsed.issues.length > 0) {
      const issue = parsed.issues[0]
      return refusal(root, issue?.code ?? 'FRONTMATTER_ISSUE', issue?.detail ?? 'the entry could not be parsed', {
        path: plan.path,
      })
    }
    const post = applyCandidate(view, parsed)
    const blocking = domain
      .validate({ root, scan: post.scan, entities: post.entities, candidate: { path: plan.path } })
      .filter((issue) => issue.path === undefined || issue.path === plan.path)
    if (blocking.length > 0) {
      const issue = blocking[0]
      return refusal(root, issue?.code ?? 'WORLD_INVALID', issue?.detail ?? 'the entry breaks an invariant', {
        path: plan.path,
      })
    }

    const written = writeTextAtomic(root, plan.path, text)
    if (!written.ok) {
      return refusal(root, written.error.code, written.error.message, {
        path: plan.path,
        ...(written.error.hint === undefined ? {} : { hint: written.error.hint }),
      })
    }

    // The file is the truth: report what it now says, not what we meant to write.
    const after = domain.parseFile({ root, path: plan.path, text: readText(join(root, plan.path)) })
    const row = rowsOf<WorldRow>({ tables: after.rows }, 'world_entries')[0]
    if (row === undefined) {
      return refusal(root, 'WORLD_ENTRY_UNREADABLE', `the entry was written but cannot be read back from ${plan.path}`, {
        path: plan.path,
      })
    }
    return {
      ok: true,
      value: {
        ok: true,
        root,
        path: written.target.relative,
        id: row.id,
        created: written.created,
        replaced: plan.replaced,
        bytes: written.bytes,
        world: worldView(row),
      },
    }
  })

  // The lock itself can fail (PROJECT_BUSY): report its code against the root that was
  // asked for, so the answer still names a path.
  return locked.ok ? locked.value : refusal(resolvePath(projectRoot), locked.error.code, locked.error.message)
}

function worldUpsertTool(deps: DomainToolDeps, domain: DomainModule): ToolDefinition {
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
          describeWorldRow(v['world']),
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
        const idArg = optionalString(a['id'])
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
        // Each of these becomes one `key: value` line, and `frontmatterLine()` throws on a
        // line break — inside the write lock that throw would be reported as `IO_FAILED`,
        // telling the model the disk failed when nothing was written. Judged here, before
        // the lock, so the refusal stays data the model can act on.
        for (const [field, value] of [
          ['title', title],
          ['id', idArg],
          ['parent', parent],
        ] as const) {
          if (value !== undefined && /[\r\n]/u.test(value)) {
            return {
              ok: false,
              root,
              error: {
                code: 'FIELD_INVALID',
                message: `${field} must be a single line: a line break cannot be written into the frontmatter`,
              },
            }
          }
        }
        const keywords = readKeywords(a['keywords'])
        const path = category === undefined ? `world/${slugInput}.md` : `world/${category}/${slugInput}.md`

        const outcome = applyUpsert(domain, root, {
          ...(idArg === undefined ? {} : { id: idArg }),
          title,
          path,
          ...(category === undefined ? {} : { category }),
          ...(parent === undefined ? {} : { parent }),
          keywords,
          always: a['always'] === true,
          ...(rawPriority === undefined ? {} : { priority: rawPriority as number }),
          body: optionalString(a['body']) ?? '',
          confirm: a['confirm'] === true,
        })
        if (!outcome.ok) {
          if ('confirmation' in outcome) {
            return {
              ok: false,
              root,
              requiresConfirmation: true,
              willWrite: outcome.confirmation.willWrite,
              replaced: outcome.confirmation.replaced,
              error: {
                code: 'WORLD_UPSERT_REQUIRES_CONFIRMATION',
                message: `writing ${outcome.confirmation.willWrite} needs confirmation`,
                hint: 'show the path and fields to the user; nothing was written. Call again with confirm: true',
              },
            }
          }
          return { ok: false, error: outcome.error }
        }

        // The index is a cache: it is refreshed after the lock, and a failed rebuild is
        // reported rather than rolling the write back.
        let indexRebuilt = false
        let indexError: Json | undefined
        try {
          await buildIndex(root)
          indexRebuilt = true
        } catch (cause) {
          const failure = describeIndexBuildFailure(cause)
          indexError = { code: failure.code, message: failure.message }
        }
        return { ...outcome.value, indexRebuilt, ...(indexError === undefined ? {} : { indexError }) }
      }),
  }
}

/** Both world tools, in registry order (X-5: the domain's whole model-facing surface). */
export function worldTools(deps: DomainToolDeps, domain: DomainModule): readonly ToolDefinition[] {
  return [worldTreeTool(deps), worldUpsertTool(deps, domain)]
}
