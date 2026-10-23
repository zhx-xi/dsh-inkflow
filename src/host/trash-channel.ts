/**
 * The recovery bin's half of the private channel (#35): one read projection and
 * two write actions, nothing else.
 *
 * Scope: `GET /inkflow/internal/trash`, `POST /inkflow/internal/trash/restore`
 * and `POST /inkflow/internal/trash/purge`. Everything about the bin's format and
 * invariants lives in `trash.ts`; this file only turns request fields into values
 * and a `{ ok, value | error }` envelope.
 *
 * Three request rules, stated once here so the route table can stay declarative:
 *
 *   * **an entry is addressed by `id`, never by a path** — the manifest id is the
 *     handle, and the path is *its* field (ADR-0008 D4: the browser names no
 *     directory);
 *   * **an absent `id` is a 400**, not "all of them": a write that forgets its
 *     target must not fall back to a bulk action;
 *   * **a purge needs `confirm: true`**, and `false`/absent is `CONFIRM_REQUIRED`
 *     (400) with zero writes. The panel already asks twice; this is the net under
 *     that, so no caller can empty the bin by accident.
 *
 * Why a separate module from `trash.ts`: `trash.ts` is the domain (read bytes,
 * write the copy, keep the manifest honest) and is imported by `chapters.ts`; the
 * envelope, the HTTP status vocabulary and the body-field names are channel
 * concerns. `internal.ts` re-exports these three functions so `routes.ts` keeps
 * one entry point (it is already ~1000 lines — AGENTS.md §10.5).
 */

import type { TrashEntry, TrashEntryView } from './trash.js'
import { listTrash, purgeTrash, restoreTrash } from './trash.js'

type JsonRecord = Record<string, unknown>

/** The body fields `POST /trash/restore` may carry (`sessionId` is always allowed). */
export const TRASH_RESTORE_BODY_FIELDS = ['id'] as const

/** The body fields `POST /trash/purge` may carry. */
export const TRASH_PURGE_BODY_FIELDS = ['id', 'confirm'] as const

/** What a bin projection needs from the resolved channel target. */
export interface TrashSource {
  sessionId: string
  root: string
}

export interface TrashReply {
  status: number
  body: JsonRecord
}

/**
 * HTTP status per refusal, so a caller can tell "the request is wrong" from "the
 * bin's state is". Anything unlisted keeps the domain code and answers 500: the
 * code stays diagnosable, which is the point of not flattening it.
 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  PATH_INVALID: 400,
  TRASH_SOURCE_NOT_ALLOWED: 400,
  CONFIRM_REQUIRED: 400,
  TRASH_SOURCE_NOT_FOUND: 404,
  TRASH_ENTRY_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  PROJECT_BUSY: 409,
  PATH_NOT_WRITABLE: 409,
  PATH_OUT_OF_SCOPE: 409,
  RESTORE_TARGET_EXISTS: 409,
  TRASH_COPY_MISSING: 409,
  TRASH_COPY_CHANGED: 409,
}

function refused(status: number, code: string, extra: JsonRecord = {}): TrashReply {
  return { status, body: { ok: false, error: { code, ...extra } } }
}

function badField(field: string, hint: string): TrashReply {
  return refused(400, 'invalid-field', { field, hint })
}

/** The wire form of one entry: the manifest row plus its location and presence. */
function entryWire(entry: TrashEntryView): JsonRecord {
  return {
    id: entry.id,
    originalPath: entry.originalPath,
    deletedAt: entry.deletedAt,
    bytes: entry.bytes,
    sha256: entry.sha256,
    reason: entry.reason,
    trashPath: entry.trashPath,
    present: entry.present,
  }
}

function restoredWire(entry: TrashEntry): JsonRecord {
  return {
    id: entry.id,
    originalPath: entry.originalPath,
    deletedAt: entry.deletedAt,
    bytes: entry.bytes,
    sha256: entry.sha256,
    reason: entry.reason,
  }
}

/** One domain failure, as the channel answers it. */
function failureReply(error: { code: string; message: string; path?: string; hint?: string; nothingWritten?: boolean; rolledBack?: boolean }): TrashReply {
  const detail: JsonRecord = { code: error.code, message: error.message }
  if (error.path !== undefined) detail['path'] = error.path
  if (error.hint !== undefined) detail['hint'] = error.hint
  if (error.nothingWritten !== undefined) detail['nothingWritten'] = error.nothingWritten
  if (error.rolledBack !== undefined) detail['rolledBack'] = error.rolledBack
  return { status: STATUS_BY_CODE[error.code] ?? 500, body: { ok: false, error: detail } }
}

/** `GET /trash`: what the bin holds, newest first. Reads only; never prunes. */
export function trashListReply(source: TrashSource, version: string): TrashReply {
  const listed = listTrash(source.root)
  if (!listed.ok) return failureReply(listed.error)
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: listed.root,
        manifestPath: listed.manifestPath,
        total: listed.total,
        bytes: listed.bytes,
        entries: listed.entries.map(entryWire),
      },
    },
  }
}

function readId(body: JsonRecord): { ok: true; id: string } | { ok: false; reply: TrashReply } {
  const value = body['id']
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, reply: badField('id', '`id` is the manifest id of one entry: list the bin first') }
  }
  return { ok: true, id: value.trim() }
}

/** `POST /trash/restore`: put one entry back where it was, refusing to overwrite. */
export function restoreTrashReply(source: TrashSource, version: string, body: JsonRecord): TrashReply {
  const id = readId(body)
  if (!id.ok) return id.reply
  const restored = restoreTrash(source.root, { id: id.id })
  if (!restored.ok) return failureReply(restored.error)
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: restored.root,
        restored: { ...restoredWire(restored.restored), trashPath: restored.trashPath },
        copyRemoved: restored.copyRemoved,
      },
    },
  }
}

/** `POST /trash/purge`: remove the copy and the entry — only with `confirm: true`. */
export function purgeTrashReply(source: TrashSource, version: string, body: JsonRecord): TrashReply {
  const id = readId(body)
  if (!id.ok) return id.reply
  const confirm = body['confirm']
  if (confirm !== undefined && typeof confirm !== 'boolean') {
    return badField('confirm', '`confirm` must be `true` (or absent, which is a refusal)')
  }
  const purged = purgeTrash(source.root, { id: id.id, confirm: confirm === true })
  if (!purged.ok) return failureReply(purged.error)
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: purged.root,
        purged: restoredWire(purged.purged),
        remaining: purged.remaining,
      },
    },
  }
}
