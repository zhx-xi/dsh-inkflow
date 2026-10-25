/**
 * Outline tools (`inkflow_outline_*`) — the model-facing write surface of
 * the outline domain.
 *
 * They live beside the domain rather than in `tools.ts` because the aggregate there is
 * `domainTools(DOMAIN_MODULES)`: a domain contributes its own tools (X-5), and adding
 * them to the built-ins array would make every parallel domain branch conflict on the
 * same lines.
 *
 * What is deliberately *not* used here, and why:
 *   - **`indexer.ts` / `index-build.ts` / `index-freshness.ts`**: they import the
 *     registry that imports this domain, so reaching them would close a runtime import
 *     cycle. The read side therefore parses `outlines/` — one small directory, and the
 *     truth — and a write reports `indexStale: true` instead of rebuilding. A stale
 *     index is not a wrong answer: `ensureIndex()` compares `files` against the disk and
 *     rebuilds on the next read (conventions.md §4.0), which is the "the index is a
 *     cache" contract (ADR-0005).
 *   - **`ctx`**: `DomainModule.tools()` receives no dependencies, so there is no session
 *     working directory to anchor on. `projectRoot` is therefore a first-class argument;
 *     without it the tool walks up from `process.cwd()`. An explicit root still passes
 *     the forbidden-path list and the four-state gate before a single byte is written.
 */

import { readdirSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'

import type { ContentBlock, JsonSchemaNode, ToolDefinition } from '../context.js'
import { INDEX_DIR } from '../conventions.js'
import { compareExpectation, fingerprintProjectFile } from '../file-cas.js'
import type { FileExpectation } from '../file-cas.js'
import { parseMarkdown } from '../frontmatter.js'
import { withProjectWriteLock, writeTextAtomic } from '../io.js'
import type { IoFailure, ProjectLock } from '../io.js'
import { checkProjectRootScope, findProjectRoot, inspectProject } from '../project.js'
import type { ProjectProbe } from '../project.js'
import {
  buildOutlineTree,
  outlineEntity,
  parseOutlineDocument,
  parsePlotPointItem,
  validateOutlineScan,
} from './outline-model.js'
import type { OutlinePlotPoint, OutlineRow } from './outline-model.js'
import { applyCandidate, rowsBucket } from './types.js'
import type { DomainWriteView } from './types.js'
import { planOutlineMove, planOutlineUpsert, renderOutlineDocument, writeNodesOf } from './outline-write.js'
import type { OutlinePlan, OutlineWriteNode } from './outline-write.js'
import { readText } from './scan-helpers.js'

type Json = Record<string, unknown>

const OUTLINES_DIR = 'outlines'
/** Same skip rules and depth cap as `walkProjectFiles()`, so both see one file set. */
const SKIP_DIRS = new Set([INDEX_DIR, 'node_modules', '.git'])
const MAX_DEPTH = 8
/** A frontmatter value is one line: a newline cannot be represented. */
const MULTILINE = /[\r\n]/u
/** Characters no portable file name may contain (`io.ts` refuses them at the write). */
const UNSAFE_SLUG = /[\\/:*?"<>|]/u

function text(lines: string[]): ContentBlock[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

// ---------------------------------------------------------------------------
// Reading `outlines/`
// ---------------------------------------------------------------------------

function walkOutlines(root: string, dir: string, out: string[], depth: number): void {
  if (depth > MAX_DEPTH) return
  let entries
  try {
    entries = readdirSync(dir === '' ? join(root, OUTLINES_DIR) : join(root, dir), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const relative = dir === '' ? `${OUTLINES_DIR}/${entry.name}` : `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walkOutlines(root, relative, out, depth + 1)
      continue
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    out.push(relative)
  }
}

/**
 * Every outline node of the project, parsed exactly as a rebuild parses it.
 *
 * A file whose kind cannot be inferred produces no row — the same decision `scan()`
 * makes — and the tree tool reports the parse finding instead of inventing a level.
 */
export function loadOutlineRows(root: string): OutlineRow[] {
  const paths: string[] = []
  walkOutlines(root, '', paths, 0)
  paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const rows: OutlineRow[] = []
  for (const path of paths) {
    const parsed = parseOutlineDocument(path, readText(join(root, path)))
    if (parsed.row !== undefined) rows.push(parsed.row)
  }
  return rows
}

// ---------------------------------------------------------------------------
// Resolving the project and refusing through the gate
// ---------------------------------------------------------------------------

type TargetResult = { ok: true; root: string } | { ok: false; value: Json }

function gateRefusal(probe: ProjectProbe): Json {
  const state = probe.state
  const code =
    state === 'needs-newer-plugin'
      ? 'PROJECT_NEEDS_NEWER_PLUGIN'
      : state === 'needs-repair'
        ? 'PROJECT_NEEDS_REPAIR'
        : 'NOT_AN_INKFLOW_PROJECT'
  return {
    ok: false,
    error: {
      code,
      state,
      message: `this directory is not a usable InkFlow project (state: ${state})`,
      root: probe.root,
      missing: probe.missing,
      reasons: probe.reasons,
      hint:
        state === 'needs-newer-plugin'
          ? 'the book was written by a newer dsh-inkflow; tell the user to upgrade instead of editing it here'
          : 'run inkflow_project_plan / inkflow_project_init on this root first, or pass the root of a usable book',
    },
  }
}

/**
 * `projectRoot`, else the nearest book above `process.cwd()`.
 *
 * Scope: a domain tool has no session workspace (see the file comment), so an explicit
 * root is checked against **itself** — that still rejects a volume root, the home
 * directory, a directory containing home and anything inside the install directories.
 * The real precondition is the four-state gate: an outline can only ever be written
 * into a directory that is already an InkFlow book.
 */
function resolveRoot(argument: unknown): TargetResult {
  const cwd = process.cwd()
  const requested = optionalString(argument)?.trim()
  const fromCwd = requested === undefined || requested === ''
  const root = fromCwd ? (findProjectRoot(cwd) ?? cwd) : resolvePath(requested)
  const rejection = checkProjectRootScope(root, fromCwd ? cwd : root)
  if (rejection !== undefined) {
    return {
      ok: false,
      value: {
        ok: false,
        error: {
          code: rejection.code,
          message: rejection.message,
          root: rejection.root,
          workspace: rejection.workspace,
          hint: rejection.hint,
        },
      },
    }
  }
  const probe = inspectProject(root)
  if (probe.usable !== true) return { ok: false, value: gateRefusal(probe) }
  return { ok: true, root: probe.root }
}

function planRefusal(plan: OutlinePlan, preview: Json): Json {
  if (plan.ok) return { ok: true }
  return {
    ok: false,
    code: plan.code,
    error: {
      code: plan.code,
      message: plan.message,
      ...(plan.path === undefined ? {} : { path: plan.path }),
      ...(plan.nodeId === undefined ? {} : { nodeId: plan.nodeId }),
      hint: 'nothing was written: the outline tree on disk is unchanged',
    },
    preview,
  }
}

function ioRefusal(error: IoFailure, preview: Json): Json {
  return { ok: false, error: { ...error, nothingWritten: true }, preview }
}

/** A tool-level refusal (bad argument, missing node): always "nothing was written". */
function rejected(code: string, message: string, extra: Json = {}): Json {
  return { ok: false, error: { code, message, nothingWritten: true, ...extra } }
}

/** The dry run of a write tool: the plan to show the user, and no bytes touched. */
function confirmRequired(preview: Json, message: string, hint: string): Json {
  return { ok: false, requiresConfirmation: true, preview, error: { code: 'CONFIRM_REQUIRED', message, hint } }
}

// ---------------------------------------------------------------------------
// File naming
// ---------------------------------------------------------------------------

/** `outlines/overall.md`, `outlines/vol-02.md`, `outlines/ch-003.md` (+ optional slug). */
export function defaultOutlineFile(
  kind: string,
  rows: readonly OutlineRow[],
  slug: string | undefined,
): { ok: true; value: string } | { ok: false; message: string } {
  const suffix = slug === undefined || slug === '' ? '' : `-${slug}`
  if (kind === 'overall') return { ok: true, value: `${OUTLINES_DIR}/overall.md` }
  if (kind === 'volume') {
    const highest = highestNumber(rows, 'volume', VOLUME_FILE_NUMBER)
    return { ok: true, value: `${OUTLINES_DIR}/vol-${String(highest + 1).padStart(2, '0')}${suffix}.md` }
  }
  if (kind === 'chapter') {
    const highest = highestNumber(rows, 'chapter', CHAPTER_FILE_NUMBER)
    return { ok: true, value: `${OUTLINES_DIR}/ch-${String(highest + 1).padStart(3, '0')}${suffix}.md` }
  }
  return { ok: false, message: `"${kind}" is not an outline kind (expected overall|volume|chapter)` }
}

const VOLUME_FILE_NUMBER = /\/vol-(\d+)/u
const CHAPTER_FILE_NUMBER = /\/ch-(\d+)/u

/**
 * The highest number already used by that kind's files, taken from the **paths** (not
 * the row count): deleting `ch-002` must not make the next create reuse a number, and a
 * reuse would overwrite a file the author may still be editing.
 */
function highestNumber(rows: readonly OutlineRow[], kind: string, pattern: RegExp): number {
  return rows
    .filter((row) => row.kind === kind)
    .reduce((max, row) => {
      const digits = pattern.exec(row.path)?.[1]
      return digits === undefined ? max : Math.max(max, Number(digits))
    }, 0)
}

function slugProblem(slug: string): string | undefined {
  if (slug === '') return 'a slug must not be empty'
  if (UNSAFE_SLUG.test(slug)) return `the slug contains a character that is not portable: ${slug}`
  if (/^[. ]/u.test(slug) || /[. ]$/u.test(slug)) return `a slug must not start or end with a dot or a space: ${slug}`
  return undefined
}

// ---------------------------------------------------------------------------
// One write: plan → parse → fold → validate → write
// ---------------------------------------------------------------------------

interface OutlineWriteInput {
  readonly file: string
  readonly fields: {
    readonly id: string
    readonly kind: string
    readonly title: string
    readonly parent: string | undefined
    readonly order: number | undefined
  }
  readonly body: string | undefined
  readonly plotPoints: readonly OutlinePlotPoint[] | undefined
  /** The text on disk when the file already exists; undefined to create it. */
  readonly existingText: string | undefined
}

/**
 * The pre-write sequence of X-4, all of it under the project write lock:
 *
 *   1. read the current view (`outlines/` parsed the way a rebuild parses it);
 *   2. `parseOutlineDocument()` the candidate text — never a hand-assembled row;
 *   3. `applyCandidate()` so `validate()` sees the **post-write** project;
 *   4. `validateOutlineScan(scan, { path })` for the invariants;
 *   5. compare-and-swap against the caller's baseline;
 *   6. only then `writeTextAtomic()`.
 */
function writeOutline(
  lock: ProjectLock,
  input: OutlineWriteInput,
  expected: FileExpectation | undefined,
  checkPlacement: (nodes: readonly OutlineWriteNode[]) => OutlinePlan,
  changed: readonly string[],
): Json {
  const rows = loadOutlineRows(lock.root)
  const preview: Json = {
    file: input.file,
    kind: input.fields.kind,
    title: input.fields.title,
    parent: input.fields.parent ?? null,
  }

  const plan = checkPlacement(writeNodesOf(rows))
  if (!plan.ok) return planRefusal(plan, preview)

  // A create must not land on a file that appeared after the rows were read — another
  // session's outline, or a hand-written file whose kind cannot be inferred (it has no
  // row, so `existing` was undefined and the name looks free). The author's prose is the
  // one thing this plugin may never overwrite by guessing.
  const onDisk = fingerprintProjectFile(lock.root, input.file)
  if (input.existingText === undefined && onDisk !== undefined) {
    return {
      ok: false,
      error: {
        code: 'FILE_EXISTS',
        message: `${input.file} already exists but is not a parsed outline node`,
        path: input.file,
        nothingWritten: true,
        current: onDisk,
        hint: 'read the file first (inkflow_outline_tree), then pass `expected` to confirm the edit',
      },
      preview,
    }
  }

  const keepBody = input.existingText === undefined ? undefined : parseMarkdown(input.existingText).body
  const text = renderOutlineDocument({
    ...(input.existingText === undefined ? {} : { text: input.existingText }),
    fields: {
      id: input.fields.id,
      kind: input.fields.kind,
      title: input.fields.title,
      parent: input.fields.parent ?? null,
      order: input.fields.order,
    },
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.plotPoints === undefined ? {} : { plotPoints: input.plotPoints }),
    ...(keepBody === undefined ? {} : { keepBody }),
  })

  const parsed = parseOutlineDocument(input.file, text)
  if (parsed.row === undefined) {
    return {
      ok: false,
      error: {
        code: 'OUTLINE_KIND_UNKNOWN',
        message: 'the document does not parse into an outline node; declare `kind` explicitly',
        path: input.file,
        hint: 'nothing was written',
      },
      preview,
    }
  }
  const parseIssue = parsed.issues[0]
  if (parseIssue !== undefined) {
    return {
      ok: false,
      error: { code: parseIssue.code, message: parseIssue.detail ?? 'frontmatter issue', path: input.file, hint: 'nothing was written' },
      preview,
    }
  }

  const projection = rows.map(outlineEntity)
  const view: DomainWriteView = { scan: { tables: [rowsBucket('outline_nodes', rows)], entities: projection, issues: [] }, entities: projection }
  const post = applyCandidate(view, {
    path: input.file,
    rows: [rowsBucket('outline_nodes', [parsed.row])],
    entity: outlineEntity(parsed.row),
    issues: parsed.issues,
  })
  const blocking = validateOutlineScan(post.scan, { path: input.file })
  if (blocking.length > 0) {
    const first = blocking[0]
    return {
      ok: false,
      error: {
        code: first?.code ?? 'OUTLINE_INVALID',
        message: first?.detail ?? 'the write would break an outline invariant',
        path: first?.path ?? input.file,
        issues: blocking,
        hint: 'nothing was written: this edit would leave the tree in a state the rebuild rejects (data-model.md §5)',
      },
      preview,
    }
  }

  const drift = compareExpectation(fingerprintProjectFile(lock.root, input.file), expected)
  if (drift !== undefined) {
    return {
      ok: false,
      error: {
        code: 'FILE_CHANGED',
        message: 'the file changed since the baseline you passed as `expected`',
        path: input.file,
        changed: drift.changed,
        current: drift.current,
        nothingWritten: true,
        hint: 're-read the node, then call again with the fresh sha256',
      },
      preview,
    }
  }

  const written = writeTextAtomic(lock.root, input.file, text)
  if (!written.ok) return ioRefusal(written.error, preview)
  return {
    ok: true,
    node: {
      id: parsed.row.id,
      kind: parsed.row.kind,
      title: parsed.row.title,
      file: parsed.row.path,
      parent: parsed.row.parent ?? null,
      order: parsed.row.order ?? null,
      plotPointCount: parsed.row.plotPointCount,
    },
    created: written.created,
    changed,
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const PROJECT_ROOT_PARAM = {
  type: 'string',
  description:
    'Absolute path of the InkFlow project root. Omit to walk up from the process working directory. Pass it when the ' +
    'session workspace is not the book (inkflow_project_status reports the root).',
} as const

const EXPECTED_PARAM = {
  type: 'object',
  properties: {
    sha256: { type: 'string', description: 'Lowercase hex sha256 of the file bytes you last read.' },
    size: { type: 'integer', description: 'Byte length of the file you last read (0 or higher).' },
    mtimeMs: { type: 'number', description: 'Modification time in ms (only compared when sha256/size are absent).' },
    absent: { type: 'boolean', description: 'True when the file must not exist yet.' },
  },
  additionalProperties: false,
  description:
    'Optional compare-and-swap baseline (the file fingerprint you last read). A mismatch is refused with FILE_CHANGED and ' +
    'nothing is written.',
} as const

function expectedParam(value: unknown): FileExpectation | undefined {
  const raw = asRecord(value)
  if (Object.keys(raw).length === 0) return undefined
  const expected: FileExpectation = {}
  if (typeof raw['sha256'] === 'string' && raw['sha256'].trim() !== '') expected.sha256 = raw['sha256'].trim()
  if (typeof raw['size'] === 'number') expected.size = raw['size']
  if (typeof raw['mtimeMs'] === 'number') expected.mtimeMs = raw['mtimeMs']
  if (raw['absent'] === true) expected.absent = true
  return expected
}

const SUCCESS_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: true,
}

function refusalLines(verb: string, value: Json): ContentBlock[] {
  const error = asRecord(value['error'])
  const lines = [`${verb} refused: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
  if (error['path'] !== undefined) lines.push(`path: ${String(error['path'])}`)
  if (error['nothingWritten'] === true) lines.push('Nothing was written.')
  if (error['hint'] !== undefined) lines.push(String(error['hint']))
  return text(lines)
}

/** The tree as indented text: one line per node, its plot points under it. */
export function renderOutlineTree(value: Json): ContentBlock[] {
  const lines: string[] = []
  const counts = asRecord(value['counts'])
  lines.push(
    `Outline tree of ${String(value['root'])}: ${String(counts['overall'] ?? 0)} overall, ` +
      `${String(counts['volumes'] ?? 0)} volume(s), ${String(counts['chapters'] ?? 0)} chapter outline(s), ` +
      `${String(counts['plotPoints'] ?? 0)} plot point(s).`,
  )
  const walk = (node: Json, depth: number): void => {
    const indent = '  '.repeat(depth)
    const order = node['order'] === undefined || node['order'] === null ? '' : ` #${String(node['order'])}`
    lines.push(`${indent}- ${String(node['title'])} (${String(node['kind'])})${order} — ${String(node['path'])}`)
    for (const point of Array.isArray(node['plotPoints']) ? (node['plotPoints'] as Json[]) : []) {
      const arc = typeof point['arc'] === 'string' ? `[${point['arc']}] ` : ''
      lines.push(`${indent}    · ${arc}${String(point['text'])}`)
    }
    for (const child of Array.isArray(node['children']) ? (node['children'] as Json[]) : []) walk(child, depth + 1)
  }
  for (const node of Array.isArray(value['trees']) ? (value['trees'] as Json[]) : []) walk(node, 0)

  const dangling = Array.isArray(value['dangling']) ? (value['dangling'] as Json[]) : []
  if (dangling.length > 0) {
    lines.push('', 'Dangling parents (I-05 — the parent id does not exist):')
    for (const node of dangling) lines.push(`- ${String(node['path'])} → parent "${String(node['parent'])}"`)
  }
  const issues = Array.isArray(value['issues']) ? (value['issues'] as Json[]) : []
  if (issues.length > 0) {
    lines.push('', 'Rebuild findings:')
    for (const issue of issues) lines.push(`- ${String(issue['code'])}: ${String(issue['detail'] ?? '')}`)
  }
  return text(lines)
}

export function buildOutlineTools(): ToolDefinition[] {
  const treeTool: ToolDefinition = {
    name: 'inkflow_outline_tree',
    description:
      'Read the three-level outline tree (overall → volume → chapter) with the plot points of every node, plus what a ' +
      'rebuild would report about `outlines/`. Call it before editing an outline: it is the only view that shows both the ' +
      'node ids (what `parent` takes) and the plot-point syntax (`- [故事线] 情节点`).',
    parameters: {
      type: 'object',
      properties: { projectRoot: PROJECT_ROOT_PARAM },
      additionalProperties: false,
    },
    output: { schema: SUCCESS_SCHEMA, render: (_args, value) => renderOutlineTree(asRecord(value)) },
    execute: (args: unknown): Promise<unknown> => {
      const a = asRecord(args)
      const target = resolveRoot(a['projectRoot'])
      if (!target.ok) return Promise.resolve(target.value)
      const rows = loadOutlineRows(target.root)
      const { trees, dangling } = buildOutlineTree(rows)
      const issues = validateOutlineScan({ tables: [rowsBucket('outline_nodes', rows)] })
      const counts = {
        overall: rows.filter((row) => row.kind === 'overall').length,
        volumes: rows.filter((row) => row.kind === 'volume').length,
        chapters: rows.filter((row) => row.kind === 'chapter').length,
        plotPoints: rows.reduce((sum, row) => sum + row.plotPointCount, 0),
      }
      return Promise.resolve({
        ok: true,
        root: target.root,
        counts,
        trees,
        dangling,
        issues,
        indexStale: true,
        hint: 'the derived index was not read: call inkflow_index_rebuild if a panel still shows the old tree',
      })
    },
  }

  const upsertTool: ToolDefinition = {
    name: 'inkflow_outline_upsert',
    description:
      'Create or update one outline node (`outlines/*.md`): `overall` (exactly one per book), `volume` (hangs under the ' +
      'overall — never under another volume) or `chapter` (under the overall or a volume). Only the fields you pass change ' +
      'and unknown frontmatter is preserved. Plot points are the body list items. Nothing is written without ' +
      '`confirm: true`; without it the call returns the plan to show the user.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        id: { type: 'string', description: 'Stable node id; omit on create to use the project-relative path.' },
        file: {
          type: 'string',
          description: 'Project-relative file (`outlines/vol-01.md`): addresses an existing node, or creates at that path.',
        },
        kind: { type: 'string', enum: ['overall', 'volume', 'chapter'], description: 'Node kind; required when creating.' },
        title: { type: 'string', description: 'Node title (one line).' },
        parent: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
          description:
            'Parent node id (or its project-relative path), or null for none. A volume must name the overall; a volume ' +
            'created without a parent hangs under the existing overall.',
        },
        order: { type: 'integer', description: 'Display order among siblings.' },
        body: { type: 'string', description: 'Replaces the whole body. Mutually exclusive with `plotPoints`.' },
        plotPoints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Body list items, one bullet each; a leading `[故事线]` tags the point with a story line.',
        },
        slug: { type: 'string', description: 'File-name suffix on create (e.g. `入山` → `outlines/vol-02-入山.md`).' },
        expected: EXPECTED_PARAM,
        confirm: { type: 'boolean', description: 'Must be true to write; false/absent only returns the plan.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          if (v['requiresConfirmation'] === true) {
            const preview = asRecord(v['preview'])
            return text([
              `Plan: write ${String(preview['file'])} (${String(preview['kind'])} "${String(preview['title'])}", ` +
                `parent ${String(preview['parent'])}, ${String(preview['plotPoints'])} plot point(s)).`,
              'Nothing was written. Show this to the user, then call again with confirm: true.',
            ])
          }
          return refusalLines('Outline upsert', v)
        }
        const node = asRecord(v['node'])
        return text([
          `${v['created'] === true ? 'Created' : 'Updated'} ${String(node['kind'])} "${String(node['title'])}" — ${String(node['file'])}`,
          `id: ${String(node['id'])} (use it as a parent) · parent: ${String(node['parent'])} · ${String(node['plotPointCount'])} plot point(s)`,
          'The derived index was not rebuilt by this call; the next read rebuilds it (the index is a cache).',
        ])
      },
    },
    execute: (args: unknown): Promise<unknown> => {
      const a = asRecord(args)
      const target = resolveRoot(a['projectRoot'])
      if (!target.ok) return Promise.resolve(target.value)

      const fileArg = optionalString(a['file'])?.trim().replaceAll('\\', '/')
      const idArg = optionalString(a['id'])?.trim()
      const rows = loadOutlineRows(target.root)
      const existing =
        fileArg !== undefined && fileArg !== ''
          ? rows.find((row) => row.path === fileArg)
          : idArg !== undefined && idArg !== ''
            ? rows.find((row) => row.id === idArg)
            : undefined

      const kind = (optionalString(a['kind']) ?? existing?.kind ?? '').trim()
      const titleArg = (optionalString(a['title']) ?? existing?.title ?? '').trim()
      const slug = optionalString(a['slug'])?.trim()
      const body = optionalString(a['body'])
      const plotPoints = Array.isArray(a['plotPoints'])
        ? (a['plotPoints'] as unknown[])
            .filter((item): item is string => typeof item === 'string')
            .map(parsePlotPointItem)
            .filter((point): point is OutlinePlotPoint => point !== undefined)
        : undefined
      const order = typeof a['order'] === 'number' ? a['order'] : existing?.order

      if (body !== undefined && plotPoints !== undefined) {
        return Promise.resolve(
          rejected('OUTLINE_FIELD_INVALID', 'pass either `body` or `plotPoints`, not both: the body can only have one source'),
        )
      }
      if (MULTILINE.test(titleArg)) {
        return Promise.resolve(rejected('OUTLINE_FIELD_INVALID', 'a title must be one line'))
      }
      if (slug !== undefined && slug !== '') {
        const problem = slugProblem(slug)
        if (problem !== undefined) return Promise.resolve(rejected('OUTLINE_FIELD_INVALID', problem))
      }

      let file: string
      if (existing !== undefined) {
        file = existing.path
      } else if (fileArg !== undefined && fileArg !== '') {
        file = fileArg
      } else {
        const named = defaultOutlineFile(kind, rows, slug)
        if (!named.ok) return Promise.resolve(rejected('OUTLINE_KIND_INVALID', named.message))
        file = named.value
      }
      if (!file.startsWith(`${OUTLINES_DIR}/`) || !file.toLowerCase().endsWith('.md')) {
        return Promise.resolve(
          rejected('OUTLINE_FIELD_INVALID', `an outline file must live under ${OUTLINES_DIR}/ and end with .md: ${file}`),
        )
      }

      // A volume created without a parent hangs under the single overall: that is the
      // only legal place for it (I-02), so defaulting is a convenience, not a guess.
      const parentArg = a['parent']
      const explicitParent = parentArg === null ? undefined : optionalString(parentArg)?.trim()
      const overall = rows.find((row) => row.kind === 'overall')
      const parent =
        parentArg === null
          ? undefined
          : explicitParent !== undefined && explicitParent !== ''
            ? explicitParent
            : kind === 'volume'
              ? overall?.id
              : existing?.parent

      const id = existing?.id ?? (idArg !== undefined && idArg !== '' ? idArg : file)
      const title = titleArg === '' ? (file.split('/').pop() ?? file).replace(/\.md$/u, '') : titleArg

      if (a['confirm'] !== true) {
        return Promise.resolve(
          confirmRequired(
            { file, kind, title, parent: parent ?? null, id, plotPoints: plotPoints?.length ?? 0 },
            'an outline write needs confirm: true',
            'show the plan to the user; call again with confirm: true when they agree',
          ),
        )
      }

      const changed = ['id', 'kind', 'title', 'parent', 'order'].filter((field) => a[field] !== undefined)
      if (body !== undefined) changed.push('body')
      if (plotPoints !== undefined) changed.push('plotPoints')

      const locked = withProjectWriteLock(target.root, (lock) =>
        writeOutline(
          lock,
          {
            file,
            fields: { id, kind, title, parent, order },
            body,
            plotPoints,
            existingText: existing === undefined ? undefined : readText(join(lock.root, existing.path)),
          },
          expectedParam(a['expected']),
          (nodes) => planOutlineUpsert({ nodes, node: { id, kind, path: file, parent } }),
          changed,
        ),
      )
      if (!locked.ok) return Promise.resolve(ioRefusal(locked.error, { file }))
      return Promise.resolve({ root: target.root, ...locked.value })
    },
  }

  const moveTool: ToolDefinition = {
    name: 'inkflow_outline_move',
    description:
      'Reparent one outline node: the file and the `id` stay, only `parent` changes. A volume may only hang under the ' +
      'overall (a volume-under-volume or overall-under-anything move is refused and nothing is written). Requires ' +
      '`confirm: true`; without it the call returns the plan.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        id: { type: 'string', description: 'Node id, or its project-relative path.' },
        parent: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
          description: 'New parent id (or path), or null to detach the node.',
        },
        expected: EXPECTED_PARAM,
        confirm: { type: 'boolean', description: 'Must be true to write.' },
      },
      required: ['id', 'parent'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          if (v['requiresConfirmation'] === true) {
            const preview = asRecord(v['preview'])
            return text([
              `Plan: move ${String(preview['id'])} under ${String(preview['parent'])}.`,
              'Nothing was written. Call again with confirm: true.',
            ])
          }
          return refusalLines('Outline move', v)
        }
        const node = asRecord(v['node'])
        return text([
          `Moved ${String(node['id'])}: parent ${String(v['movedFrom'])} → ${String(node['parent'])} — ${String(node['file'])}`,
          'The derived index was not rebuilt by this call; the next read rebuilds it.',
        ])
      },
    },
    execute: (args: unknown): Promise<unknown> => {
      const a = asRecord(args)
      const target = resolveRoot(a['projectRoot'])
      if (!target.ok) return Promise.resolve(target.value)
      const id = optionalString(a['id'])?.trim() ?? ''
      if (id === '') return Promise.resolve(rejected('OUTLINE_FIELD_INVALID', '`id` is required'))
      const parentArg = a['parent']
      const parent = parentArg === null ? undefined : optionalString(parentArg)?.trim()
      const rows = loadOutlineRows(target.root)
      const existing = rows.find((row) => row.id === id) ?? rows.find((row) => row.path === id)
      if (existing === undefined) {
        return Promise.resolve(rejected('OUTLINE_NODE_NOT_FOUND', `no outline node ${id}`))
      }
      if (a['confirm'] !== true) {
        return Promise.resolve(
          confirmRequired(
            { id: existing.id, file: existing.path, parent: parent ?? null },
            'an outline move needs confirm: true',
            'call again with confirm: true when the user agrees',
          ),
        )
      }

      const locked = withProjectWriteLock(target.root, (lock) =>
        writeOutline(
          lock,
          {
            file: existing.path,
            fields: { id: existing.id, kind: existing.kind, title: existing.title, parent, order: existing.order },
            body: undefined,
            plotPoints: undefined,
            existingText: readText(join(lock.root, existing.path)),
          },
          expectedParam(a['expected']),
          (nodes) => planOutlineMove({ nodes, id: existing.id, parent }),
          ['parent'],
        ),
      )
      if (!locked.ok) return Promise.resolve(ioRefusal(locked.error, { file: existing.path }))
      return Promise.resolve({ root: target.root, movedFrom: existing.parent ?? null, ...locked.value })
    },
  }

  return [treeTool, upsertTool, moveTool]
}
