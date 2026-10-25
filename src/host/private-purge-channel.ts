/**
 * The purge area's half of the private channel (#199): one read projection and two write
 * actions, nothing else.
 *
 * Scope: `GET /inkflow/internal/purged`, `POST /inkflow/internal/purged/clean` and
 * `POST /inkflow/internal/purged/restore`. The area's shape and its moves live in
 * `private-purge.ts` / `private-purge-actions.ts`; this file only turns request fields into
 * values and a `{ ok, value | error }` envelope — the same split the recovery bin makes between
 * `trash.ts` and `trash-channel.ts`.
 *
 * Three request rules, stated once here so the route table stays declarative:
 *
 *   * **a cleanup names what it cleans** (`kind` + `target`), never a path: the run's file and
 *     the proposal's directory are derived from the pair/id, so the browser cannot name a
 *     directory (ADR-0008 D4);
 *   * **an absent target is a 400**, not "everything": a write that forgets its target must not
 *     fall back to a bulk action;
 *   * **a cleanup needs `confirm: true`** — the panel already asks twice, this is the net under
 *     it (ADR-0012 #4). A restore does not: it is the undo direction, and it still refuses to
 *     overwrite anything.
 *
 * `confirm` is checked again inside the domain (`cleanUp`), not only here: the tool-less
 * channel is not the only future caller.
 */

import {
  PURGE_KINDS,
  listPurged,
} from './private-purge.js'
import type { PurgeEntry, PurgeEntryView, PurgeFailure, PurgeKind } from './private-purge.js'
import { cleanUp, restorePurged } from './private-purge-actions.js'

type JsonRecord = Record<string, unknown>

/** The body fields `POST /purged/clean` may carry (`sessionId` is always allowed). */
export const PURGE_CLEAN_BODY_FIELDS = ['kind', 'target', 'confirm'] as const

/** The body fields `POST /purged/restore` may carry. */
export const PURGE_RESTORE_BODY_FIELDS = ['id'] as const

/** What a projection needs from the resolved channel target. */
export interface PurgeSource {
  sessionId: string
  root: string
}

export interface PurgeReply {
  status: number
  body: JsonRecord
}

/**
 * HTTP status per refusal: "the request is wrong" (400), "that thing is not here" (404) and
 * "the state refuses" (409). Anything unlisted keeps the domain code and answers 500 — the
 * code stays diagnosable, which is the point of not flattening it.
 */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  PURGE_TARGET_INVALID: 400,
  PURGE_KIND_INVALID: 400,
  PURGE_OPEN_PROPOSAL: 409,
  CONFIRM_REQUIRED: 400,
  PURGE_TARGET_NOT_FOUND: 404,
  PURGE_ENTRY_NOT_FOUND: 404,
  PROJECT_NOT_FOUND: 404,
  PURGE_ENTRY_EXISTS: 409,
  PURGE_TARGET_EXISTS: 409,
  PURGE_COPY_MISSING: 409,
  PURGE_COPY_CHANGED: 409,
  PURGE_COPY_MISMATCH: 409,
  PURGE_RESTORE_PATH_REFUSED: 409,
  PROJECT_BUSY: 409,
  PATH_NOT_WRITABLE: 409,
  PATH_OUT_OF_SCOPE: 409,
}

function refused(status: number, code: string, extra: JsonRecord = {}): PurgeReply {
  return { status, body: { ok: false, error: { code, ...extra } } }
}

function badField(field: string, hint: string): PurgeReply {
  return refused(400, 'invalid-field', { field, hint })
}

/** The wire form of one entry: the manifest row plus where the bytes are and whether they are. */
function entryWire(entry: PurgeEntryView): JsonRecord {
  return {
    id: entry.id,
    kind: entry.kind,
    target: entry.target,
    label: entry.label,
    deletedAt: entry.deletedAt,
    bytes: entry.bytes,
    sha256: entry.sha256,
    reason: entry.reason,
    purgedPath: entry.purgedPath,
    present: entry.present,
    files: entry.files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
  }
}

function entryRow(entry: PurgeEntry): JsonRecord {
  return {
    id: entry.id,
    kind: entry.kind,
    target: entry.target,
    label: entry.label,
    deletedAt: entry.deletedAt,
    bytes: entry.bytes,
    sha256: entry.sha256,
    reason: entry.reason,
    files: entry.files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
  }
}

/** One domain failure, as the channel answers it. */
function failureReply(error: PurgeFailure['error']): PurgeReply {
  const detail: JsonRecord = { code: error.code, message: error.message }
  if (error.path !== undefined) detail['path'] = error.path
  if (error.hint !== undefined) detail['hint'] = error.hint
  if (error.nothingWritten !== undefined) detail['nothingWritten'] = error.nothingWritten
  if (error.rolledBack !== undefined) detail['rolledBack'] = error.rolledBack
  return { status: STATUS_BY_CODE[error.code] ?? 500, body: { ok: false, error: detail } }
}

/** `GET /purged`: what the area holds, with the presence of every copy checked. Reads only. */
export function purgedListReply(source: PurgeSource, version: string): PurgeReply {
  const listed = listPurged(source.root)
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

/**
 * `POST /purged/clean`: move one review run or one finished proposal into the area.
 *
 * `target` is `<chapterId>/<runId>` for a run and `<proposalId>` for a proposal — the pair the
 * panel already shows, so the panel never invents a path.
 */
export function cleanUpViaChannel(source: PurgeSource, version: string, body: JsonRecord): PurgeReply {
  const kindRaw = body['kind']
  if (typeof kindRaw !== 'string' || kindRaw.trim() === '') {
    return badField('kind', `\`kind\` is one of ${PURGE_KINDS.join(' / ')}`)
  }
  const kind = kindRaw.trim()
  if (!(PURGE_KINDS as readonly string[]).includes(kind)) {
    return badField('kind', `\`kind\` must be one of ${PURGE_KINDS.join(' / ')}`)
  }
  const targetRaw = body['target']
  if (typeof targetRaw !== 'string' || targetRaw.trim() === '') {
    return badField('target', '`target` is `<chapterId>/<runId>` for a run, `<proposalId>` for a proposal')
  }
  const confirm = body['confirm']
  if (confirm !== undefined && typeof confirm !== 'boolean') {
    return badField('confirm', '`confirm` must be `true` (or absent, which is a refusal)')
  }
  const cleaned = cleanUp(source.root, {
    kind: kind as PurgeKind,
    target: targetRaw.trim(),
    confirm: confirm === true,
    source: { channel: 'panel', sessionId: source.sessionId },
  })
  if (!cleaned.ok) return failureReply(cleaned.error)
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: cleaned.root,
        cleaned: entryRow(cleaned.entry),
        record: cleaned.record,
        recordWritten: cleaned.recordWritten,
        remaining: cleaned.remaining,
      },
    },
  }
}

/** `POST /purged/restore`: put one cleanup back, byte for byte, refusing to overwrite. */
export function restorePurgedViaChannel(source: PurgeSource, version: string, body: JsonRecord): PurgeReply {
  const value = body['id']
  if (typeof value !== 'string' || value.trim() === '') {
    return badField('id', '`id` is the manifest id of one cleanup: list the area first')
  }
  const restored = restorePurged(source.root, {
    id: value.trim(),
    source: { channel: 'panel', sessionId: source.sessionId },
  })
  if (!restored.ok) return failureReply(restored.error)
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: restored.root,
        restored: entryRow(restored.entry),
        files: [...restored.files],
        record: restored.record,
        recordWritten: restored.recordWritten,
      },
    },
  }
}
