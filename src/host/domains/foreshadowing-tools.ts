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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ToolDefinition } from '../context.js'
import { buildIndex, describeIndexBuildFailure } from '../index-build.js'
import { ensureIndex } from '../index-freshness.js'
import { scanProject } from '../indexer.js'
import { writeTextAtomic } from '../io.js'
import { readForeshadowView } from './foreshadowing-query.js'
import type { ForeshadowItem } from './foreshadowing-query.js'
import {
  FORESHADOW_STATUSES,
  FORESHADOW_TABLE,
  foreshadowEntity,
  foreshadowTransitionAllowed,
  foreshadowValidate,
  parseForeshadowFile,
  renderForeshadowDocument,
} from './foreshadowing-plan.js'
import type { ForeshadowDocumentFields, ForeshadowRow, ForeshadowStatus } from './foreshadowing-plan.js'
import { rowsOf } from './scan-helpers.js'
import {
  OUTPUT_SCHEMA,
  PROJECT_ROOT_PARAM,
  asRecord,
  indexFailure,
  isPortableSlug,
  optionalBoolean,
  optionalString,
  readIdList,
  slugify,
  text,
  withProject,
} from './tool-support.js'
import type { Json } from './tool-support.js'
import { applyCandidate, rowsBucket } from './types.js'
import type { DomainFileParse, DomainToolDeps, DomainWriteView } from './types.js'

function readStatus(value: unknown): ForeshadowStatus | 'invalid' | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return 'invalid'
  const trimmed = value.trim().toLowerCase()
  return (FORESHADOW_STATUSES as readonly string[]).includes(trimmed) ? (trimmed as ForeshadowStatus) : 'invalid'
}

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
    execute: async (args, exec) =>
      withProject(deps, exec, args, async (root) => {
        const a = asRecord(args)
        const title = optionalString(a['title'])
        if (title === undefined) {
          return { ok: false, root, error: { code: 'TITLE_REQUIRED', message: 'a foreshadow needs a title' } }
        }
        const slugInput = optionalString(a['slug']) ?? slugify(title)
        if (!isPortableSlug(slugInput)) {
          return {
            ok: false,
            root,
            error: { code: 'SLUG_INVALID', message: `"${slugInput === '' ? title : slugInput}" is not a portable file name` },
          }
        }

        // Values go straight into `key: value` lines, and a newline would split the
        // block; refuse here, where the model can read the code.
        const multiline = [title, optionalString(a['id']), optionalString(a['dueBy']), optionalString(a['plantedAt']), optionalString(a['resolvedChapter']), slugInput].find(
          (value) => value !== undefined && /[\r\n]/u.test(value),
        )
        if (multiline !== undefined) {
          return {
            ok: false,
            root,
            error: {
              code: 'FORESHADOW_FIELD_INVALID',
              message: 'a title, id, slug, dueBy, plantedAt or resolvedChapter must be a single line',
              hint: 'nothing was written',
            },
          }
        }

        const requested = readStatus(a['status'])
        if (requested === 'invalid') {
          return {
            ok: false,
            root,
            error: {
              code: 'FORESHADOW_STATUS_INVALID',
              message: `status must be one of ${FORESHADOW_STATUSES.join('/')}`,
              hint: 'omit it to keep the current state; a new foreshadow starts as `planted`',
            },
          }
        }

        const path = `foreshadowing/${slugInput}.md`
        const scanned = scanProject(root)
        const rows = rowsOf<ForeshadowRow>(scanned, FORESHADOW_TABLE)
        const existing = rows.find((row) => row.path === path)
        const id = optionalString(a['id']) ?? existing?.id ?? path
        const target: ForeshadowStatus = requested ?? existing?.status ?? 'planted'

        // The state machine, before anything else is decided: an illegal transition is
        // the one refusal that must never depend on how the rest of the call is shaped.
        if (existing !== undefined && !foreshadowTransitionAllowed(existing.status, target)) {
          return {
            ok: false,
            root,
            path,
            error: {
              code: 'FORESHADOW_TRANSITION_INVALID',
              message: `${path} is "${existing.status}" and cannot become "${target}"`,
              // The confusing case is a file that says `overdue` while the board computes
              // something else (§3.2.2: the computed state wins). The author then sees
              // "planted" on screen and cannot write "planted" back, which looks like a
              // contradiction unless the refusal says why and how to get out.
              hint:
                existing.status === 'overdue'
                  ? 'the file says "overdue" but the board shows the state computed from the calendar, and that computed value wins; writing "planted" is still a step back from the declared mark — write "advanced" / "resolved", or edit the file by hand'
                  : 'resolved is terminal; overdue may advance or resolve, but nothing may step back to planted',
            },
          }
        }

        // Id lists go into frontmatter list lines, and the renderer throws on a line
        // break — refuse it here, where the model can read the code (§ tool-support).
        const advancedRead = a['advancedAt'] === undefined ? undefined : readIdList(a['advancedAt'])
        const linkedRead = a['linkedEntities'] === undefined ? undefined : readIdList(a['linkedEntities'])
        if (advancedRead?.multiline !== undefined || linkedRead?.multiline !== undefined) {
          return {
            ok: false,
            root,
            path,
            error: {
              code: 'FORESHADOW_FIELD_INVALID',
              message: 'every advancedAt / linkedEntities item must be a single line',
              hint: 'nothing was written; split the ids into separate array items',
            },
          }
        }

        const advancedAt = advancedRead === undefined ? [...(existing?.advancedAt ?? [])] : advancedRead.ids
        const resolvedChapter = optionalString(a['resolvedChapter']) ?? existing?.resolvedChapter
        const dueBy = optionalString(a['dueBy']) ?? existing?.dueBy
        const plantedAt = optionalString(a['plantedAt']) ?? existing?.plantedAt
        const linkedEntities = linkedRead === undefined ? [...(existing?.linkedEntities ?? [])] : linkedRead.ids

        if (target === 'advanced' && advancedAt.length === 0) {
          return {
            ok: false,
            root,
            path,
            error: {
              code: 'FORESHADOW_TRANSITION_INVALID',
              message: 'status "advanced" needs at least one chapter in advancedAt',
              hint: 'pass advancedAt: [<chapter id>], or keep the state at planted',
            },
          }
        }
        if (target === 'resolved' && (resolvedChapter ?? '').trim() === '') {
          return {
            ok: false,
            root,
            path,
            error: {
              code: 'FORESHADOW_RESOLVED_WITHOUT_CHAPTER',
              message: 'a resolved foreshadow must name the chapter that pays it off',
              hint: 'pass resolvedChapter: <chapter id> (I-09)',
            },
          }
        }

        if (!optionalBoolean(a['confirm'])) {
          return {
            ok: false,
            root,
            requiresConfirmation: true,
            willWrite: path,
            replaced: existing !== undefined,
            error: {
              code: 'FORESHADOW_UPSERT_REQUIRES_CONFIRMATION',
              message: `writing ${path} needs confirmation`,
              hint: 'show the path and fields to the user; nothing was written. Call again with confirm: true',
            },
          }
        }

        const fields: ForeshadowDocumentFields = {
          id,
          title,
          status: target,
          advancedAt,
          linkedEntities,
          ...(plantedAt === undefined ? {} : { plantedAt }),
          ...(dueBy === undefined ? {} : { dueBy }),
          ...(resolvedChapter === undefined ? {} : { resolvedChapter }),
        }
        const body = optionalString(a['body'])
        const existingText = existing === undefined ? undefined : readProjectText(root, path)
        // The index says this file is there, but its text cannot be read: writing a
        // fresh document would replace the author's body and their unmodelled keys.
        if (existing !== undefined && existingText === undefined) {
          return {
            ok: false,
            root,
            path,
            error: {
              code: 'FILE_UNREADABLE',
              message: `${path} exists but could not be read, so an edit cannot preserve it`,
              hint: 'nothing was written; check the file permissions, or write the entry by hand',
            },
          }
        }
        const content = renderForeshadowDocument({
          ...(existingText === undefined ? {} : { text: existingText }),
          fields,
          ...(body === undefined ? {} : { body }),
        })

        const parsedFile = candidateParse(path, content)
        const parseIssue = parsedFile.issues[0]
        if (parseIssue !== undefined) {
          return {
            ok: false,
            root,
            path,
            error: {
              code: parseIssue.code,
              message: parseIssue.detail,
              path,
              hint: 'nothing was written: the document this call would write does not parse back',
            },
          }
        }

        const view: DomainWriteView = { scan: scanned, entities: scanned.entities }
        const post = applyCandidate(view, parsedFile)
        const blocking = foreshadowValidate(rowsOf<ForeshadowRow>(post.scan, FORESHADOW_TABLE), path)
        const first = blocking[0]
        if (first !== undefined) {
          return {
            ok: false,
            root,
            path,
            error: {
              code: first.code,
              message: first.detail,
              path: first.path ?? path,
              hint: 'nothing was written: this edit would leave the file in a state the rebuild rejects',
            },
          }
        }

        const written = writeTextAtomic(root, path, content)
        if (!written.ok) return { ok: false, root, path, error: written.error }

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
          status: target,
          declaredStatus: target,
          replaced: existing !== undefined,
          created: written.created,
          bytes: written.bytes,
          indexRebuilt,
          ...(indexError === undefined ? {} : { indexError }),
        }
      }),
  }
}

/**
 * Parse a candidate document into the seam's per-file shape.
 *
 * The domain module's `parseFile()` does exactly this, but `foreshadowing.ts` imports
 * *this* file (registry → domain → its tools); importing it back would close a runtime
 * cycle. So the three lines that build the shape live here, on top of the one parser.
 */
function candidateParse(path: string, text: string): DomainFileParse {
  const parsed = parseForeshadowFile(path, text)
  return {
    path,
    rows: parsed.row === undefined ? [] : [rowsBucket(FORESHADOW_TABLE, [parsed.row])],
    ...(parsed.row === undefined ? {} : { entity: foreshadowEntity(parsed.row) }),
    issues: parsed.issues,
  }
}

/** The current text of one project file, or undefined when it is not there yet. */
function readProjectText(root: string, relativePath: string): string | undefined {
  try {
    return readFileSync(join(root, relativePath), 'utf8')
  } catch {
    return undefined
  }
}

/** Both foreshadow tools, in registry order (X-5: the domain's whole tool surface). */
export function foreshadowTools(deps: DomainToolDeps): readonly ToolDefinition[] {
  return [foreshadowListTool(deps), foreshadowUpsertTool(deps)]
}
