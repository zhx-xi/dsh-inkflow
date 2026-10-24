/**
 * The shared library's **write** surface on the hub channel (#40): copy, update and
 * the "what is stale" list, for the book hub's 共享内容 page.
 *
 * WHY THIS IS A THIN LAYER. Everything that decides what a copy is (destination,
 * `origin`, stale, backup) lives in `shared-copy.ts`; everything that decides
 * whether a request may touch a directory lives here. Keeping the two apart is what
 * makes the domain testable with a plain book on disk (no Host context) while the
 * routing rules stay in one readable place next to the route table.
 *
 * THE ANCHOR — the panel is ROOT-SCOPED, so there is no session (ADR-0010 D3). The
 * target book therefore has to be named by the caller, and the only names this
 * channel trusts are the ones the Host itself handed out: the `book` field must be
 * the canonical path of a **registered workspace** (the same registry `/hub/books`
 * projects, ADR-0010 D6). A path that is not registered is refused before any
 * filesystem access, so "copy into someone else's directory" is not expressible.
 * Within a registered book the four-state gate still decides: only `usable` is
 * writable, and a non-usable book answers the same checklist the tools answer.
 *
 * THE WRITE GUARDS are the channel's, not this file's (ADR-0010 D6 #6): a non-GET
 * hub route already requires an `Origin` that is same-origin with `Host`, a JSON
 * body, and a body-field allowlist. Here that allowlist is `book`/`entryId`/`mode`/
 * `confirm` for a copy and `book`/`entryId`/`file`/`confirm` for an update — no
 * `root`, no `path`, and no way to reach the shared library itself.
 */

import { resolve as resolvePath } from 'node:path'

import type { HostContext } from './context.js'
import { listRegisteredWorkspaces } from './hub.js'
import { inspectProject, realpathLoose } from './project.js'
import { buildSharedCopies, copySharedEntry, updateSharedEntry } from './shared-copy.js'
import type { SharedCopyMode } from './shared-copy.js'

/** Body fields `POST /hub/shared/copy` accepts; anything else is 400. */
export const SHARED_COPY_BODY_FIELDS = ['book', 'entryId', 'mode', 'confirm'] as const

/** Body fields `POST /hub/shared/update` accepts. */
export const SHARED_UPDATE_BODY_FIELDS = ['book', 'entryId', 'file', 'confirm'] as const

type JsonRecord = Record<string, unknown>

export interface SharedChannelReply {
  status: number
  body: JsonRecord
}

function ok(value: JsonRecord): JsonRecord {
  return { ok: true, value }
}

function failure(code: string, extra: JsonRecord = {}): JsonRecord {
  return { ok: false, error: { code, ...extra } }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The canonical path of a registered workspace, or the refusal that says why not.
 *
 * `realpathLoose` on both sides: the registry stores canonical paths, while the
 * panel may echo the path it was handed with different casing or a trailing
 * separator on Windows.
 */
function registeredBook(ctx: HostContext, book: unknown): { ok: true; root: string } | { ok: false; reply: SharedChannelReply } {
  const wanted = text(book)
  if (wanted === '') {
    return {
      ok: false,
      reply: {
        status: 400,
        body: failure('BOOK_REQUIRED', {
          hint: 'pass `book`: the path of the book to copy into, exactly as /hub/books listed it',
        }),
      },
    }
  }
  const listed = listRegisteredWorkspaces(ctx)
  if (listed === undefined) {
    return {
      ok: false,
      reply: {
        status: 200,
        body: failure('HUB_UNAVAILABLE', {
          message: 'the Host exposes no workspace registry, so no book can be named',
          hint: 'open the book from a session with the InkFlow workbench instead',
        }),
      },
    }
  }
  const canonical = realpathLoose(resolvePath(wanted))
  const match = listed.find((entry) => realpathLoose(entry.path) === canonical)
  if (match === undefined) {
    return {
      ok: false,
      reply: {
        status: 400,
        body: failure('BOOK_NOT_REGISTERED', {
          path: wanted,
          hint: 'the panel may only write into a book the user already opened, and it names it exactly as /hub/books listed it',
        }),
      },
    }
  }
  return { ok: true, root: canonical }
}

/** A book the gate allows to be written: the checklist travels on refusal. */
function usableBook(root: string): SharedChannelReply | undefined {
  const probe = inspectProject(root, { recreateIndexDir: false })
  if (probe.usable) return undefined
  return {
    status: 409,
    body: failure('BOOK_NOT_USABLE', {
      root,
      state: probe.state,
      missing: probe.missing,
      actions: probe.actions,
      hint: 'finish (or repair) this book before copying shared entries into it — the wizard reports what is missing',
    }),
  }
}

/** Human-readable message for a domain refusal, so the panel never prints a bare code. */
function domainFailure(error: { code: string; message: string; hint?: string; path?: string }): SharedChannelReply {
  const status =
    error.code === 'SHARED_ENTRY_NOT_FOUND' || error.code === 'SHARED_COPY_NOT_FOUND' || error.code === 'SHARED_SOURCE_MISSING'
      ? 404
      : error.code === 'SHARED_UNAVAILABLE'
        ? 200
        : error.code === 'SHARED_COPY_CONFLICT' || error.code === 'REFERENCE_READONLY'
          ? 409
          : 400
  return {
    status,
    body: failure(error.code, {
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      ...(error.path === undefined ? {} : { path: error.path }),
    }),
  }
}

/** `GET /hub/shared/copies?book=…` — what this book holds, and what is stale. */
export function sharedCopiesReply(ctx: HostContext, dataDir: string, book: unknown): SharedChannelReply {
  const target = registeredBook(ctx, book)
  if (!target.ok) return target.reply
  const result = buildSharedCopies({ dataDir, root: target.root })
  if (!result.ok) return domainFailure(result.error)
  return { status: 200, body: ok(result.value as unknown as JsonRecord) }
}

/** `POST /hub/shared/copy` — the default take-out action (ADR-0007 C2). */
export function sharedCopyReply(ctx: HostContext, dataDir: string, body: JsonRecord): SharedChannelReply {
  const target = registeredBook(ctx, body['book'])
  if (!target.ok) return target.reply
  const unusable = usableBook(target.root)
  if (unusable !== undefined) return unusable

  const mode: SharedCopyMode | undefined =
    body['mode'] === 'reference' ? 'reference' : body['mode'] === 'copy' ? 'copy' : undefined
  if (body['mode'] !== undefined && mode === undefined) {
    return {
      status: 400,
      body: failure('MODE_INVALID', {
        value: String(body['mode']),
        hint: 'mode is `copy` (default) or `reference` (library/ originals only)',
      })
    }
  }
  const result = copySharedEntry({
    dataDir,
    root: target.root,
    entryId: text(body['entryId']),
    ...(mode === undefined ? {} : { mode }),
    confirm: body['confirm'] === true,
  })
  if (!result.ok) return domainFailure(result.error)
  return { status: 200, body: ok(result.value as unknown as JsonRecord) }
}

/** `POST /hub/shared/update` — refresh ONE copy, after the user confirmed it. */
export function sharedUpdateReply(ctx: HostContext, dataDir: string, body: JsonRecord): SharedChannelReply {
  const target = registeredBook(ctx, body['book'])
  if (!target.ok) return target.reply
  const unusable = usableBook(target.root)
  if (unusable !== undefined) return unusable

  const result = updateSharedEntry({
    dataDir,
    root: target.root,
    ...(text(body['entryId']) === '' ? {} : { entryId: text(body['entryId']) }),
    ...(text(body['file']) === '' ? {} : { file: text(body['file']) }),
    confirm: body['confirm'] === true,
  })
  if (!result.ok) return domainFailure(result.error)
  return { status: 200, body: ok(result.value as unknown as JsonRecord) }
}
