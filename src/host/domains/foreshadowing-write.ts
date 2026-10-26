/**
 * The foreshadowing write pipeline, as one function: `inkflow_foreshadow_upsert` and the
 * panel's `POST /foreshadow/advance` both reach the disk here.
 *
 * Why the pipeline lives in the domain and not in the channel: the pane's acceptance
 * criterion is that a move it offers is refused with **the code the tool answers**, and
 * that a step the state machine forbids writes nothing. A second copy of the four steps
 * (scan → plan → parse the candidate → validate the post-write view → `writeTextAtomic`)
 * would agree on the day it was written and drift on the day one side changed — the
 * timeline pane made the same call (`domains/timeline-write.ts`).
 *
 * X-4 in order, unchanged from the tool it came from:
 *
 *   1. `scanProject` — the current view, including the entry being moved;
 *   2. the state machine (`foreshadowTransitionAllowed`) before anything else is decided,
 *      because an illegal transition is the one refusal that must not depend on how the
 *      rest of the call is shaped;
 *   3. the document (`renderForeshadowDocument` patches, so comments, quote style, key
 *      order and every field this domain does not model survive an edit);
 *   4. the post-write view (`applyCandidate` + `foreshadowValidate`), then `io.ts`.
 *
 * Nothing here resolves a project or reads a tool argument shape: `root` is resolved by
 * the caller (`withProject` for the tool, `ChannelTarget` for the pane) and `args` is the
 * tool's own argument object, so "the route passes one extra field" cannot happen.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildIndex, describeIndexBuildFailure } from '../index-build.js'
import { scanProject } from '../indexer.js'
import { writeTextAtomic } from '../io.js'
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
import { asRecord, isPortableSlug, optionalBoolean, optionalString, readIdList, slugify } from './tool-support.js'
import type { Json } from './tool-support.js'
import { applyCandidate, rowsBucket } from './types.js'
import type { DomainFileParse, DomainWriteView } from './types.js'

/** The requested state, or `invalid` so the caller can name the code the schema also lists. */
export function readStatus(value: unknown): ForeshadowStatus | 'invalid' | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') return 'invalid'
  const trimmed = value.trim().toLowerCase()
  return (FORESHADOW_STATUSES as readonly string[]).includes(trimmed) ? (trimmed as ForeshadowStatus) : 'invalid'
}

/**
 * One write: create or replace `foreshadowing/<slug>.md`, then rebuild the derived index.
 *
 * `args` is `inkflow_foreshadow_upsert`'s own argument object, and the caller hands the
 * envelope back as is: the refusal codes (`FORESHADOW_TRANSITION_INVALID`,
 * `FORESHADOW_RESOLVED_WITHOUT_CHAPTER`, `FORESHADOW_UPSERT_REQUIRES_CONFIRMATION`, …) are
 * what the pane prints, so a route that wrapped or renamed them would be a second
 * vocabulary the author has to learn twice.
 */
export async function upsertForeshadow(root: string, args: Record<string, unknown>): Promise<Json> {
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
