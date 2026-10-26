/**
 * The foreshadowing domain's two model-facing tools: `inkflow_foreshadow_list`
 * and `inkflow_foreshadow_upsert`.
 *
 * They live in the domain, not in `tools.ts` (roadmap X-5): a domain branch adds one
 * line to `DOMAIN_MODULES` and never to the built-in tool array.
 *
 * They resolve the book the way a built-in tool does: an explicit `projectRoot` first,
 * else the **session's** working directory via `withProject()`. Never bare
 * `process.cwd()` — inside the host process that is the DSH install directory.
 *
 * Writes never bypass `io.ts` (path checks + write lock + atomic replace); reads never
 * bypass the derived index, made fresh by `ensureIndex()`.
 *
 * The write path runs X-4 in order — `scanProject` → plan → parse the candidate →
 * `applyCandidate` → validate the post-write view → `writeTextAtomic` — and the
 * transition rule is the *same* predicate the rebuild uses (`foreshadowTransitionAllowed`),
 * so "the write refused it" and "the rebuild reports it" cannot disagree.
 */

import type { ToolDefinition } from '../context.js'
import { ensureIndex } from '../index-freshness.js'
import { readForeshadowView } from './foreshadowing-query.js'
import type { ForeshadowItem } from './foreshadowing-query.js'
import { FORESHADOW_STATUSES } from './foreshadowing-plan.js'
import { readStatus, upsertForeshadow } from './foreshadowing-write.js'
import {
  OUTPUT_SCHEMA,
  PROJECT_ROOT_PARAM,
  asRecord,
  indexFailure,
  optionalBoolean,
  optionalString,
  text,
  withProject,
} from './tool-support.js'
import type { Json } from './tool-support.js'
import type { DomainToolDeps } from './types.js'

/** One entry as the payload carries it (`file` is the project-relative path). */
function itemJson(item: ForeshadowItem): Json {
  return {
    id: item.id,
    title: item.title,
    file: item.file,
    status: item.status,
    declaredStatus: item.declaredStatus,
    overdue: item.overdue,
    dueNow: item.dueNow,
    dueBy: item.dueBy,
    dueKind: item.dueKind,
    plantedAt: item.plantedAt,
    advancedAt: [...item.advancedAt],
    resolvedChapter: item.resolvedChapter,
    linkedEntities: [...item.linkedEntities],
  }
}

function renderItems(entries: readonly Json[]): string[] {
  return entries.map((entry) => {
    const marks: string[] = []
    if (entry['overdue'] === true) marks.push('超期')
    else if (entry['dueNow'] === true) marks.push('本期到期')
    const due = typeof entry['dueBy'] === 'string' ? ` → ${entry['dueBy']}` : ''
    const tag = marks.length === 0 ? '' : `[${marks.join('/')}] `
    return `- ${tag}${String(entry['title'] ?? '')}（${String(entry['status'] ?? '')}${due}）— ${String(entry['file'] ?? '')}`
  })
}

// ---------------------------------------------------------------------------
// inkflow_foreshadow_list
// ---------------------------------------------------------------------------

function foreshadowListTool(deps: DomainToolDeps): ToolDefinition {
  return {
    name: 'inkflow_foreshadow_list',
    description:
      'List the foreshadows of the book with the state of each one as of a given chapter. `status` is the ' +
      '**computed board state**: `overdue` when the entry is still open and its `dueBy` points at a chapter or a ' +
      'volume the book has already moved past (`planted` / `advanced` when it is merely late by the file\'s own ' +
      'say-so but not by the calendar). `declaredStatus` is what the file literally contains — the two differ ' +
      'exactly when the computed mark wins, and the file is never rewritten by a read. `dueBy` may name a chapter ' +
      'or a volume (`vol-02`); an entry due in the chapter you are writing is `dueNow` (the last chance), not ' +
      '`overdue`. Chapter order is `(volume order, seq)` from the frontmatter, never the file name. ' +
      'Filters: `status` (one of planted/advanced/resolved/overdue), `overdueOnly`, `entity` (an id in ' +
      '`linkedEntities`) and `chapter` ("as of this chapter"). Read-only; the derived index is rebuilt first when ' +
      'it is stale. Call it when the user asks what is still open, what has gone past its deadline, or which ' +
      'setups this chapter should pay off.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        status: {
          type: 'string',
          enum: [...FORESHADOW_STATUSES],
          description: 'Only entries whose **computed** state is this one. `overdue` means computed-late.',
        },
        overdueOnly: {
          type: 'boolean',
          description: 'Only entries that are late as of `chapter` (default: the latest chapter of the book).',
        },
        entity: {
          type: 'string',
          description: 'Only entries whose `linkedEntities` contains this id (a character or world entry id).',
        },
        chapter: {
          type: 'string',
          description:
            'Answer "as of this chapter" — a chapter id or its project-relative path. Omit for the furthest ' +
            'chapter in the book.',
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
          return text([`Foreshadows unavailable: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`])
        }
        const counts = asRecord(v['counts'])
        const chapter = asRecord(v['currentChapter'])
        const head =
          `${String(counts['total'] ?? 0)} foreshadow(s), ${String(counts['unresolved'] ?? 0)} open, ` +
          `${String(counts['overdue'] ?? 0)} overdue, ${String(counts['dueNow'] ?? 0)} due in this chapter` +
          `${v['indexRebuilt'] === true ? ' (index rebuilt)' : ''}`
        const where = chapter['id'] === undefined ? 'no chapter yet' : `as of chapter ${String(chapter['id'])}`
        const listed = Array.isArray(v['items']) ? (v['items'] as Json[]) : []
        const cut = v['truncated'] === true ? ['  (list truncated: the counts above cover every entry)'] : []
        return text([`${head} — ${where}:`, ...(listed.length === 0 ? ['  (空)'] : [...renderItems(listed), ...cut])])
      },
    },
    execute: async (args, exec) =>
      withProject(deps, exec, args, async (root) => {
        const ensured = await ensureIndex(root)
        if (!ensured.ok) return indexFailure(root, ensured.failure)
        const a = asRecord(args)
        const status = readStatus(a['status'])
        if (status === 'invalid') {
          return {
            ok: false,
            root,
            error: { code: 'FORESHADOW_STATUS_INVALID', message: `status must be one of ${FORESHADOW_STATUSES.join('/')}` },
          }
        }
        const chapter = optionalString(a['chapter'])
        const read = readForeshadowView(root, { ...(chapter === undefined ? {} : { chapter }) })
        if (!read.ok) return { ok: false, root, error: { code: read.error.code, message: read.error.message } }

        const entity = optionalString(a['entity'])
        const overdueOnly = optionalBoolean(a['overdueOnly'])
        const items = read.view.items.filter((item) => {
          if (status !== undefined && item.status !== status) return false
          if (overdueOnly && !item.overdue) return false
          if (entity !== undefined && !item.linkedEntities.includes(entity)) return false
          return true
        })

        return {
          ok: true,
          root,
          currentChapter:
            read.view.currentChapter === undefined
              ? null
              : {
                  id: read.view.currentChapter.id,
                  title: read.view.currentChapter.title,
                  // The payload's own shape: a chapter with no volume says `null`,
                  // never "chapters" (the container is not a volume).
                  volume: read.view.currentChapter.volume ?? null,
                  seq: read.view.currentChapter.seq,
                  path: read.view.currentChapter.path,
                },
          counts: read.view.counts,
          items: items.map(itemJson),
          truncated: read.view.truncated,
          indexRebuilt: ensured.rebuilt,
          indexState: ensured.state,
        }
      }),
  }
}

// ---------------------------------------------------------------------------
// inkflow_foreshadow_upsert
// ---------------------------------------------------------------------------

function foreshadowUpsertTool(deps: DomainToolDeps): ToolDefinition {
  return {
    name: 'inkflow_foreshadow_upsert',
    description:
      'Create or update one foreshadow: writes `foreshadowing/<slug>.md` with `status` / `plantedAt` / ' +
      '`advancedAt` / `dueBy` / `resolvedChapter` / `linkedEntities`, then rebuilds the derived index. The state ' +
      'machine is enforced, not documented: `planted → advanced → resolved` and any open state → `overdue` are ' +
      'allowed, `overdue` may still advance or resolve (it is a mark, not progress) but may not step back to ' +
      '`planted`, and `resolved` is terminal — everything else is refused with FORESHADOW_TRANSITION_INVALID and ' +
      'nothing is written. `resolved` requires `resolvedChapter` (the chapter that pays the setup off) and ' +
      '`advanced` requires at least one entry in `advancedAt`. `dueBy` takes a chapter id or a volume id ' +
      '(`vol-02`); lateness is computed against the chapter being written, so do not write `overdue` to record it ' +
      '— the board computes it. Requires `confirm: true`, and writes nothing without it.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        title: { type: 'string', description: 'Foreshadow name; the file slug derives from it.' },
        id: {
          type: 'string',
          description: 'Stable id. Omit to use the file path (the same default the parser applies), and keep it on edits.',
        },
        slug: { type: 'string', description: 'File slug; omit to derive it from the title.' },
        status: {
          type: 'string',
          enum: [...FORESHADOW_STATUSES],
          description:
            'The state to write. Omit to keep the current one (a new entry starts as `planted`). `overdue` is ' +
            'accepted (a file may carry the mark) but the board recomputes it, so it is not how lateness is recorded.',
        },
        plantedAt: { type: 'string', description: 'The chapter the setup is planted in (a chapter id).' },
        advancedAt: {
          type: 'array',
          items: { type: 'string' },
          description: 'Chapter ids where the setup was pushed forward, in reading order. Required for `advanced`.',
        },
        dueBy: {
          type: 'string',
          description:
            'Where the setup is expected to pay off: a chapter id, or a volume id (`vol-02`) for "by the end of ' +
            'this volume". A volume deadline is late only once the book has moved into a later volume.',
        },
        resolvedChapter: {
          type: 'string',
          description: 'The chapter that pays the setup off. Required when the state is `resolved`.',
        },
        linkedEntities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Character / world entry ids this setup hangs on (the board groups by them).',
        },
        body: { type: 'string', description: 'Foreshadow body (Markdown). Omit to keep the existing body.' },
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
          return text([`Foreshadow upsert refused: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`])
        }
        const indexLine =
          v['indexRebuilt'] === true
            ? 'index rebuilt.'
            : `index NOT rebuilt (${String(asRecord(v['indexError'])['code'] ?? 'unknown')}) — run inkflow_index_rebuild.`
        return text([
          `${v['created'] === true ? 'Created' : 'Updated'} ${String(v['path'])} (id ${String(v['id'])}, ${String(v['status'])}).`,
          indexLine,
        ])
      },
    },
    // One pipeline, one set of codes: the panel's `POST /foreshadow/advance` calls the
    // same function, so "the tool refused it" and "the pane refused it" cannot disagree.
    execute: async (args, exec) => withProject(deps, exec, args, async (root) => upsertForeshadow(root, asRecord(args))),
  }
}

/** Both foreshadow tools, in registry order (X-5: the domain's whole tool surface). */
export function foreshadowTools(deps: DomainToolDeps): readonly ToolDefinition[] {
  return [foreshadowListTool(deps), foreshadowUpsertTool(deps)]
}
