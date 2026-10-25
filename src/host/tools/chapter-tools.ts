/**
 * Chapter and volume built-in tools (split out of `tools.ts`): the read side
 * (`inkflow_chapter_list`) and the write side (volume create/rename, chapter
 * create/write/move/delete). Both go through `chapters.ts` under one write lock; the
 * tools only resolve the gate, pass the arguments through and render the reply.
 *
 * Why two aggregates: the registration order pins `inkflow_chapter_list` before the
 * search/audit/gate group and the six write tools after it, so the read tool and the
 * write tools cannot be one array without moving names in the tool table.
 */

import type { ContentBlock, ToolDefinition, ToolRunContext } from '../context.js'
import { clampChapterPage, countChapters, listChapters } from '../indexer.js'
import { createChapter, createVolume, deleteChapter, moveChapter, renameVolume, writeChapter } from '../chapters.js'
import { ensureIndex } from '../index-freshness.js'
import { gateFailure, resolveProject } from '../domains/tool-project.js'
import { rememberProject } from '../state.js'
import type { Json, ToolDeps } from './shared.js'
import { EXPECTED_PARAM, PROJECT_ROOT_PARAM, SUCCESS_SCHEMA, asRecord, commitLine, ensureFailure, expectedParam, optionalString, text } from './shared.js'

/**
 * Render a refused volume/chapter operation: the code, what it means, whether the
 * tree is whole, and the undo steps when there was a rollback. The rollback
 * report is the part the model must not swallow — "it failed" and "it failed and
 * your files are unchanged" are different instructions to give the user.
 */
function renderChapterFailure(verb: string, value: Json): ContentBlock[] {
  const error = asRecord(value['error'])
  const lines = [`${verb} failed: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
  if (error['path'] !== undefined) lines.push(`path: ${String(error['path'])}`)
  if (error['nothingWritten'] === true) {
    lines.push('Nothing was written: the file on disk is not the version you passed as `expected`.')
  }
  if (error['rolledBack'] === true) {
    lines.push('The change was rolled back: the project files are as they were before the call.')
  }
  if (error['rolledBack'] === false) {
    lines.push('WARNING: the rollback did not complete — inspect the steps below before writing again.')
  }
  const rollback = Array.isArray(error['rollback']) ? (error['rollback'] as Json[]) : []
  for (const step of rollback) {
    const outcome = step['ok'] === true ? 'ok' : 'FAILED'
    const detail = step['message'] === undefined ? '' : ` (${String(step['message'])})`
    lines.push(`- ${outcome}: ${String(step['action'])}${detail}`)
  }
  if (error['hint'] !== undefined) lines.push(String(error['hint']))
  return text(lines)
}

export function chapterReadTools(deps: ToolDeps): ToolDefinition[] {
  const chapterList: ToolDefinition = {
    name: 'inkflow_chapter_list',
    description:
      'List chapters of the InkFlow project in reading order, read from the derived index, one page at a time. ' +
      '`limit` caps a single page (at most 500 — it is a page cap, not a book size); a longer book is walked with ' +
      '`offset`. `total` is always the number of chapters in the whole book; `truncated` says chapters still follow ' +
      'this page (pass `offset: offset + returned` to read on). If the index is missing, ' +
      'built by another schema, or no longer matches the files (a chapter edited, added or deleted outside the ' +
      'plugin), it is rebuilt first (it is only a cache).',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        limit: { type: 'integer', description: 'Maximum chapters per page (1–500; the page cap). Default 100.' },
        offset: { type: 'integer', description: 'Chapters to skip before this page (0 or higher). Default 0.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          const message = error['message'] === undefined ? '' : ` — ${String(error['message'])}`
          return text([`Cannot list chapters: ${String(error['code'] ?? 'unknown')}${message}`])
        }
        const chapters = Array.isArray(v['chapters']) ? (v['chapters'] as Json[]) : []
        if (chapters.length === 0) return text(['No chapters yet (chapters/ is empty).'])
        const total = typeof v['total'] === 'number' ? v['total'] : chapters.length
        const offset = typeof v['offset'] === 'number' ? v['offset'] : 0
        const page = `${v['truncated'] === true ? `showing chapters ${String(offset + 1)}–${String(offset + chapters.length)} of ${String(total)} (more follow — pass offset ${String(offset + chapters.length)} to read on)` : `${String(total)} chapter(s)${offset === 0 ? '' : ` — showing chapters ${String(offset + 1)}–${String(offset + chapters.length)} (end of list)`}`}`
        return text([
          `${page}${v['indexRebuilt'] === true ? ' (index was rebuilt)' : ''}:`,
          ...chapters.map(
            (c) =>
              `- ${c['seq'] === null ? '?' : String(c['seq'])}. ${String(c['title'])} [${String(c['status'])}] ${String(c['wordCount'])} 字 — ${String(c['path'])}`,
          ),
        ])
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) {
        return gateFailure(resolved)
      }
      const probe = resolved.probe
      rememberProject(deps.dataDir, probe.root)
      // The reply reports the page it actually served, so the bounds are applied once
      // here and once inside `listChapters` (which must not trust its caller).
      const page = clampChapterPage(a['limit'], a['offset'])
      // The read path no longer decides anything itself. `ensureIndex`
      // is the single trigger, so this list and `inkflow_chapter_search` below
      // can never disagree about which build they are reading.
      const ensured = await ensureIndex(probe.root)
      if (!ensured.ok) return ensureFailure(ensured, probe.root)
      const chapters = listChapters(probe.root, page.limit, page.offset) ?? []
      // `total` is the book. Reading it back as `chapters.length` made the page
      // cap invisible — a 520-chapter book answered "100 chapters" with no sign of a cut.
      const total = countChapters(probe.root)
      if (total === undefined) {
        return {
          ok: false,
          error: { code: 'INDEX_UNAVAILABLE', message: 'the derived index could not be read; rebuild it and retry' },
        }
      }
      return {
        ok: true,
        root: probe.root,
        total,
        returned: chapters.length,
        offset: page.offset,
        // "More chapters follow this page", not "this page is not the book": the latter is
        // already visible from `total` vs `returned`, and it stays true on the LAST page —
        // which would tell the caller to page on into an empty reply (review).
        truncated: page.offset + chapters.length < total,
        indexRebuilt: ensured.rebuilt,
        indexState: ensured.state,
        chapters,
      }
    },
  }

  return [chapterList]
}

export function chapterTools(deps: ToolDeps): ToolDefinition[] {
  /** Gate → run → return. A non-usable project gets the structured checklist. */
  const runChapterTool = async (args: unknown, exec: ToolRunContext, run: (root: string, a: Json) => Promise<unknown>): Promise<unknown> => {
    const a = asRecord(args)
    const resolved = await resolveProject(deps, a['projectRoot'], exec)
    if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
    rememberProject(deps.dataDir, resolved.probe.root)
    return run(resolved.probe.root, a)
  }

  const volumeCreate: ToolDefinition = {
    name: 'inkflow_volume_create',
    description:
      'Create a volume: allocates `vol-NN` when `volumeId` is omitted, creates `chapters/vol-NN-<slug>/` with a `.gitkeep`, ' +
      'and updates the volume/chapter catalog and the derived index. Call it when the user asks to add a volume.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        volumeId: {
          type: 'string',
          description: 'Stable volume id (`vol-NN`). Omit to allocate the next free number.',
        },
        title: { type: 'string', description: 'Volume title; the directory slug and the catalog title derive from it.' },
        slug: {
          type: 'string',
          description: 'Directory slug (`chapters/vol-NN-<slug>/`). Omit to derive it from the title.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return renderChapterFailure('Volume create', v)
        const volume = asRecord(v['volume'])
        return text([
          `Created volume ${String(volume['volumeId'])} "${String(volume['title'])}" at ${String(volume['dir'])}/.`,
          commitLine(v),
        ])
      },
    },
    execute: (args, exec) =>
      runChapterTool(args, exec, (root, a) =>
        createVolume(root, {
          volumeId: optionalString(a['volumeId']),
          title: optionalString(a['title']) ?? '',
          slug: optionalString(a['slug']),
        }),
      ),
  }

  const volumeRename: ToolDefinition = {
    name: 'inkflow_volume_rename',
    description:
      "Rename a volume's directory (the `vol-NN` prefix and therefore the volumeId stay) and update both catalogs. Chapters " +
      'move with the directory but their frontmatter is not rewritten, so every id and `volume` value still resolves. ' +
      'Rolls the rename back when the catalog cannot be written.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        volumeId: { type: 'string', description: 'Stable volume id (`vol-NN`) to rename.' },
        title: { type: 'string', description: 'New volume title; the directory slug derives from it unless `slug` is given.' },
        slug: { type: 'string', description: 'New directory slug (without the `vol-NN-` prefix).' },
      },
      required: ['volumeId'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return renderChapterFailure('Volume rename', v)
        const volume = asRecord(v['volume'])
        const previous = asRecord(v['previous'])
        if (v['changed'] === false) {
          return text([`Volume ${String(volume['volumeId'])} already lives at ${String(volume['dir'])}/; nothing to do.`])
        }
        return text([
          `Renamed volume ${String(volume['volumeId'])}: ${String(previous['dir'])}/ → ${String(volume['dir'])}/ ("${String(volume['title'])}").`,
          `${String(v['chaptersUnchanged'] ?? 0)} chapter file(s) moved with the directory; their frontmatter is untouched.`,
          commitLine(v),
        ])
      },
    },
    execute: (args, exec) =>
      runChapterTool(args, exec, (root, a) =>
        renameVolume(root, {
          volumeId: optionalString(a['volumeId']) ?? '',
          title: optionalString(a['title']),
          slug: optionalString(a['slug']),
        }),
      ),
  }

  const chapterCreate: ToolDefinition = {
    name: 'inkflow_chapter_create',
    description:
      'Create a chapter: mints the uuid `id` (the reference to use from now on), allocates `seq`, writes ' +
      '`chapters/<volume-dir>/NNNN-<slug>.md` with `id`/`title`/`volume`/`seq`/`status: draft` and an empty body, and ' +
      'updates both projections. Call it when the user asks to add a chapter.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        volumeId: {
          type: 'string',
          description: 'Volume to add the chapter to (`vol-NN`). Omit for a loose chapter directly under `chapters/`.',
        },
        title: { type: 'string', description: 'Chapter title, e.g. "第一章 入山".' },
        slug: { type: 'string', description: 'File slug; omit to derive it from the title.' },
        seq: {
          type: 'integer',
          description:
            'Chapter number (positive integer). Defaults to one more than the highest seq in that volume (or among loose chapters).',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return renderChapterFailure('Chapter create', v)
        const chapter = asRecord(v['chapter'])
        return text([
          `Created "${String(chapter['title'])}" as ${String(chapter['volumeId'] ?? 'loose')} #${String(chapter['seq'] ?? '?')} — ${String(chapter['file'])}`,
          `id: ${String(chapter['chapterId'])} (use this id from now on; the file name is only a location)`,
          commitLine(v),
        ])
      },
    },
    execute: (args, exec) =>
      runChapterTool(args, exec, (root, a) =>
        createChapter(root, {
          volumeId: optionalString(a['volumeId']),
          title: optionalString(a['title']) ?? '',
          slug: optionalString(a['slug']),
          seq: typeof a['seq'] === 'number' ? a['seq'] : undefined,
        }),
      ),
  }

  const chapterWrite: ToolDefinition = {
    name: 'inkflow_chapter_write',
    description:
      'Edit one chapter addressed by `chapterId` or `file`: only the fields you pass change and the rest of the frontmatter ' +
      'block is preserved byte for byte. A new `title` also renames the file; the id stays. This overwrites manuscript ' +
      'prose — call it only when the user asked for the edit.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        chapterId: { type: 'string', description: 'Stable chapter id (uuid). Mutually exclusive with `file`.' },
        file: {
          type: 'string',
          description: 'Project-relative chapter path (`chapters/vol-01/0001-x.md`). Mutually exclusive with `chapterId`.',
        },
        title: { type: 'string', description: 'New title; the file is renamed to match it.' },
        body: { type: 'string', description: 'New chapter body (everything after the frontmatter block).' },
        status: { type: 'string', enum: ['draft', 'revised', 'final'], description: 'New chapter status.' },
        expected: EXPECTED_PARAM,
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return renderChapterFailure('Chapter write', v)
        const chapter = asRecord(v['chapter'])
        const changed = Array.isArray(v['changed']) ? (v['changed'] as unknown[]).map(String) : []
        if (changed.length === 0) return text([`Nothing to change in ${String(chapter['file'])} (the values already match).`])
        const lines = [`Updated ${String(chapter['file'])}: ${changed.join(', ')}.`]
        if (v['renamedFrom'] !== undefined) lines.push(`Renamed from ${String(v['renamedFrom'])} (id ${String(chapter['chapterId'])} unchanged).`)
        lines.push(commitLine(v))
        return text(lines)
      },
    },
    execute: (args, exec) =>
      runChapterTool(args, exec, (root, a) =>
        writeChapter(root, {
          chapterId: optionalString(a['chapterId']),
          file: optionalString(a['file']),
          title: optionalString(a['title']),
          body: optionalString(a['body']),
          status: optionalString(a['status']),
          expected: expectedParam(a['expected']),
        }),
      ),
  }

  const chapterMove: ToolDefinition = {
    name: 'inkflow_chapter_move',
    description:
      'Move a chapter into another volume or out of every volume. The file name, the `id` and the `seq` stay; the `volume` ' +
      'field follows the new owner (and is removed for a loose chapter). A failure after the move is rolled back.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        chapterId: { type: 'string', description: 'Stable chapter id (uuid). Mutually exclusive with `file`.' },
        file: { type: 'string', description: 'Project-relative chapter path. Mutually exclusive with `chapterId`.' },
        volumeId: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
          description: 'Target volume (`vol-NN`), or null to make the chapter loose (directly under chapters/).',
        },
        expected: EXPECTED_PARAM,
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return renderChapterFailure('Chapter move', v)
        const chapter = asRecord(v['chapter'])
        if (v['moved'] === false) {
          return text([`${String(chapter['file'])} is already there; nothing to do.`])
        }
        return text([
          `Moved ${String(v['movedFrom'])} → ${String(chapter['file'])} (${String(chapter['volumeId'] ?? 'loose')}).`,
          `id: ${String(chapter['chapterId'])} (unchanged)`,
          commitLine(v),
        ])
      },
    },
    execute: (args, exec) =>
      runChapterTool(args, exec, (root, a) =>
        moveChapter(root, {
          chapterId: optionalString(a['chapterId']),
          file: optionalString(a['file']),
          volumeId: a['volumeId'] === null ? null : optionalString(a['volumeId']),
          expected: expectedParam(a['expected']),
        }),
      ),
  }

  const chapterDelete: ToolDefinition = {
    name: 'inkflow_chapter_delete',
    description:
      'Delete one chapter file addressed by `chapterId` or `file`. The file is first moved into the project recovery bin ' +
      '(`.inkflow/trash/<same relative path>`, manifest `.inkflow/trash/index.json`) and only then dropped from the tree, ' +
      'so the text stays restorable (panel tab 回收站, or the restore/purge routes) until that entry is purged. ' +
      'Confirm with the user before calling.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        chapterId: { type: 'string', description: 'Stable chapter id (uuid). Mutually exclusive with `file`.' },
        file: { type: 'string', description: 'Project-relative chapter path. Mutually exclusive with `chapterId`.' },
        expected: EXPECTED_PARAM,
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return renderChapterFailure('Chapter delete', v)
        const deleted = asRecord(v['deleted'])
        const trashed = asRecord(v['trashed'])
        return text([
          `Deleted "${String(deleted['title'])}" — ${String(deleted['file'])} (id ${String(deleted['chapterId'])}).`,
          trashed['trashPath'] === undefined
            ? 'The file is gone from the working tree; the text is recoverable from git only.'
            : `Moved into the recovery bin: ${String(trashed['trashPath'])} (entry ${String(trashed['id'])}) — restorable until purged.`,
          commitLine(v),
        ])
      },
    },
    execute: (args, exec) =>
      runChapterTool(args, exec, (root, a) =>
        deleteChapter(root, {
          chapterId: optionalString(a['chapterId']),
          file: optionalString(a['file']),
          expected: expectedParam(a['expected']),
        }),
      ),
  }

  return [volumeCreate, volumeRename, chapterCreate, chapterWrite, chapterMove, chapterDelete]
}

