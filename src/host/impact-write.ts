/**
 * The rename write path (#34, ADR-0014, conventions §5.6).
 *
 * A rename is **one file's write**: the file moves to its new name and the *old*
 * id is pinned into its frontmatter. Nothing else is touched — relations keep
 * their `source`/`target`, the timeline keeps its `participants`/`place`, the
 * ledger keeps its `subject`, the foreshadow book keeps its `linkedEntities`, and
 * `entity_mentions` keeps keying on `kind:id`. That is the whole decision: the id
 * is the address, the path is where the file happens to live today.
 *
 * Why this is a module beside `impact.ts` rather than inside it: the listing must
 * be provably read-only (it has no `io.ts` import at all, which is a property a
 * reader can check in one look), and the write must hold the project lock, carry a
 * CAS baseline and roll back a half-done move. Two different failure models, so
 * two different files.
 *
 * Ordering inside the lock is deliberate and is the reverse of what feels natural:
 *
 *   1. read the source bytes and compare the baseline (`FILE_CHANGED` before a
 *      single byte is written — §5.5),
 *   2. write the NEW file (atomically, `io.ts`),
 *   3. remove the OLD one, and if that removal fails, remove the new file again
 *      (a copy left behind would be a second entry with the same pinned id → the
 *      rebuild would report `DUPLICATE_ID` and the author would have two halves of
 *      one entry).
 *
 * Deleting first would mean a failed write loses the only copy of the prose, which
 * is the one mistake this project cannot recover from (`data-safety` §1: git is the
 * fallback for what was already deleted, not for what was deleted a millisecond
 * ago by a bug).
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { ContentDir } from './conventions.js'
import { compareExpectation, fingerprintBytes, fingerprintProjectFile } from './file-cas.js'
import { frontmatterLine, parseMarkdown, patchFrontmatter, splitFrontmatter, stringField } from './frontmatter.js'
import type { FrontmatterValue } from './frontmatter.js'
import { impactKindOf, planRename, refused, renameRefusal, resolveEntity, titleFieldOf } from './impact.js'
import type { ImpactReply, ResolvedEntity } from './impact.js'
import { ensureIndex } from './index-freshness.js'
import type { EnsureIndexResult } from './index-freshness.js'
import { removeProjectFile, withProjectWriteLock, writeTextAtomic } from './io.js'
import type { IoFailure } from './io.js'
import { chaptersMentioning } from './domains/mentions-query.js'
import { readExpectation } from './library-request.js'

/** A plain JSON payload, the channel's envelope half. */
type JsonRecord = Record<string, unknown>

/** One rename request: the resolved book, the request body, the plugin version. */
export interface RenameRequest {
  source: { sessionId: string; root: string }
  version: string
  body: JsonRecord
}

/**
 * Fields the rename route accepts. Declared here (and repeated in `ROUTES`, which
 * is the guard that actually runs) so an undeclared field is a 400 before any file
 * is read: a write route may not accept a field nobody validated.
 */
export const RENAME_BODY_FIELDS = ['kind', 'id', 'slug', 'title', 'expected'] as const

// ---------------------------------------------------------------------------
// Pinning the id into the moved file
// ---------------------------------------------------------------------------

interface PinResult {
  text: string
  wroteId: boolean
  wroteTitle: boolean
}

/**
 * Put `pinId` into the file's frontmatter, and the new display title with it.
 *
 * `patchFrontmatter` is the same line-level patcher the library editor uses, so
 * key order, comments, quoting, unknown keys and line endings survive — a rename
 * must not reformat an author's file. A file with **no** frontmatter block gets one
 * created: without a block there is nowhere to pin the id, and writing the file
 * back unchanged would be a silent no-op that still reported success.
 */
function pinId(text: string, pinId: string, title: { field: string; value: string } | undefined): PinResult {
  const parsed = parseMarkdown(text)
  const declared = stringField(parsed.data, 'id')
  const entries: Record<string, FrontmatterValue> = {}
  const wroteId = (declared ?? '').trim() !== pinId
  if (wroteId) entries['id'] = pinId
  const wroteTitle = title !== undefined && (stringField(parsed.data, title.field) ?? '') !== title.value
  if (wroteTitle && title !== undefined) entries[title.field] = title.value
  if (!wroteId && !wroteTitle) return { text, wroteId: false, wroteTitle: false }

  if (!parsed.hasFrontmatter) {
    const lines = ['---', ...Object.entries(entries).map(([key, value]) => frontmatterLine(key, value as string)), '---', '']
    return { text: `${lines.join('\n')}\n${parsed.body}`, wroteId, wroteTitle }
  }
  const patched = patchFrontmatter(text, entries)
  return { text: patched.text, wroteId, wroteTitle }
}

// ---------------------------------------------------------------------------
// Refusals, in the channel's vocabulary
// ---------------------------------------------------------------------------

function ioRefusal(failure: IoFailure): ImpactReply {
  const status =
    failure.code === 'PATH_OUT_OF_SCOPE' ||
    failure.code === 'PATH_INVALID' ||
    failure.code === 'PATH_NOT_WRITABLE' ||
    failure.code === 'PATH_RESERVED' ||
    failure.code === 'PATH_TOO_LONG'
      ? 400
      : failure.code === 'PROJECT_BUSY' || failure.code === 'TARGET_EXISTS'
        ? 409
        : failure.code === 'PATH_NOT_FOUND'
          ? 404
          : 500
  return {
    status,
    body: {
      ok: false,
      error: {
        code: failure.code,
        message: failure.message,
        ...(failure.path === undefined ? {} : { path: failure.path }),
        ...(failure.errno === undefined ? {} : { errno: failure.errno }),
        ...(failure.code === 'PROJECT_BUSY' || failure.code === 'IO_FAILED' ? { nothingWritten: true } : {}),
      },
    },
  }
}

function indexDegradation(ensured: EnsureIndexResult): JsonRecord {
  if (ensured.ok) return { indexRebuilt: ensured.rebuilt, indexState: ensured.state }
  return {
    indexRebuilt: false,
    indexState: ensured.state,
    indexError: { code: ensured.failure.code, errno: ensured.failure.errno, message: ensured.failure.message },
    indexReasons: ensured.freshness.reasons,
  }
}

function singleLine(value: string): boolean {
  return !/[\r\n]/u.test(value)
}

/** Total occurrences across the chapters that name the entity (0 when the index cannot answer). */
function mentionCount(root: string, kind: ContentDir, id: string): number {
  const rows = chaptersMentioning(root, `${kind}:${id}`)
  return rows === undefined ? 0 : rows.reduce((sum, row) => sum + row.mentions, 0)
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

type LockedOutcome =
  | { ok: true; written: { path: string; changed: string[] } }
  | { ok: false; reply: ImpactReply }

/**
 * Read → CAS → write new → remove old → (rollback on failure), all inside the
 * project write lock.
 *
 * Both baselines are compared before the first byte lands: the caller's, and then
 * the one this call took (the author's editor takes no lock, so the file can move
 * between the patch and the rename). Refusals leave the tree byte-identical.
 */
function renameLocked(root: string, input: {
  entity: ResolvedEntity
  to: string
  pinId: string
  title: { field: string; value: string } | undefined
  expected: Parameters<typeof compareExpectation>[1]
}): LockedOutcome {
  const fromAbsolute = join(root, ...input.entity.path.split('/'))
  let bytes: Buffer
  let mtimeMs: number
  try {
    bytes = readFileSync(fromAbsolute)
    mtimeMs = statSync(fromAbsolute).mtimeMs
  } catch {
    return {
      ok: false,
      reply: refused(404, 'impact-entity-not-found', {
        kind: input.entity.kind,
        id: input.entity.id,
        path: input.entity.path,
        hint: 'the file disappeared before the write',
      }),
    }
  }

  const baseline = fingerprintBytes(bytes, mtimeMs)
  const drift = compareExpectation(baseline, input.expected)
  if (drift !== undefined) {
    return {
      ok: false,
      reply: refused(409, 'FILE_CHANGED', {
        path: input.entity.path,
        expected: drift.expected,
        current: drift.current,
        changed: drift.changed,
        nothingWritten: true,
        hint: 'reload the entry (the impact listing returns a fresh `fingerprint`) and rename again',
      }),
    }
  }

  const text = bytes.toString('utf8')
  const pin = pinId(text, input.pinId, input.title)
  const moved = input.to !== input.entity.path

  const written = writeTextAtomic(root, input.to, pin.text)
  if (!written.ok) return { ok: false, reply: ioRefusal(written.error) }

  if (moved) {
    const removed = removeProjectFile(root, input.entity.path)
    if (!removed.ok) {
      // Roll the new file back: leaving both halves would be two entries carrying
      // the same pinned id, which the rebuild reports as `DUPLICATE_ID` and the
      // author reads as "my entry got duplicated" — far worse than a failed rename.
      const rollback = removeProjectFile(root, input.to)
      return {
        ok: false,
        reply: {
          status: 500,
          body: {
            ok: false,
            error: {
              code: removed.error.code,
              message: removed.error.message,
              path: removed.error.path,
              errno: removed.error.errno,
              rolledBack: rollback.ok,
              hint: 'the new file was removed again; the old one is still in place',
            },
          },
        },
      }
    }
  }

  const changed: string[] = []
  if (moved) changed.push('file')
  if (pin.wroteId) changed.push('id')
  if (pin.wroteTitle) changed.push('title')
  return { ok: true, written: { path: input.to, changed } }
}

/**
 * `POST /inkflow/internal/impact/rename` — move one entry's file and pin its id.
 *
 * The rebuild afterwards is the same "write then invalidate" every write path does
 * (conventions §4.0); it is reported, never rolled back, because the file is the
 * truth and the index is a cache. The two proof numbers it returns (`entities`
 * id unchanged / mentions unchanged) are what the panel shows after the click.
 */
export async function renameEntity(request: RenameRequest): Promise<ImpactReply> {
  const { source, version, body } = request

  const kind = typeof body['kind'] === 'string' ? body['kind'].trim() : ''
  if (kind === '') {
    return refused(400, 'KIND_REQUIRED', { param: 'kind', hint: 'pass the kind of the entry you loaded' })
  }
  const renamedKind = impactKindOf(kind)
  if (renamedKind === undefined) {
    return refused(400, 'KIND_INVALID', { param: 'kind', value: kind })
  }
  const id = typeof body['id'] === 'string' ? body['id'].trim() : ''
  if (id === '') {
    return refused(400, 'ID_REQUIRED', { param: 'id', hint: 'pass the id of the entry you want to rename' })
  }

  const refusal = renameRefusal(renamedKind)
  if (refusal !== undefined) {
    return refused(400, 'KIND_NOT_RENAMEABLE', { kind, reason: refusal, hint: 'move the file by hand if that is really what you mean' })
  }

  const slugRaw = body['slug']
  if (slugRaw !== undefined && typeof slugRaw !== 'string') {
    return refused(400, 'SLUG_INVALID', { field: 'slug', hint: '`slug` must be the new file name without the .md suffix' })
  }
  const titleRaw = body['title']
  if (titleRaw !== undefined && typeof titleRaw !== 'string') {
    return refused(400, 'TITLE_INVALID', { field: 'title', hint: '`title` must be the new display name' })
  }
  const newTitle = typeof titleRaw === 'string' ? titleRaw.trim() : ''
  if (newTitle !== '' && !singleLine(newTitle)) {
    return refused(400, 'TITLE_INVALID', { field: 'title', reason: 'not-single-line', hint: 'a display name cannot contain a line break' })
  }

  const expected = readExpectation(body)
  if (!expected.ok) return expected.reply

  const resolved = resolveEntity(source.root, renamedKind, { id })
  if (!resolved.ok) {
    return refused(404, 'impact-entity-not-found', {
      kind,
      id,
      hint: 'list the tree with GET /library and use an id from its group',
    })
  }
  const entity = resolved.entity

  const plan = planRename(source.root, entity, { slug: typeof slugRaw === 'string' ? slugRaw : undefined, newTitle })
  if (plan.blockers.includes('SLUG_INVALID')) {
    return refused(400, 'SLUG_INVALID', {
      field: 'slug',
      value: plan.slug,
      hint: 'a file name cannot contain a path separator, a control byte or a Windows-reserved character',
    })
  }
  if (plan.blockers.includes('RENAME_NO_CHANGE')) {
    return refused(400, 'RENAME_NO_CHANGE', {
      path: entity.path,
      hint: 'neither `slug` nor `title` would change anything: there is nothing to write',
    })
  }
  if (plan.blockers.includes('TARGET_EXISTS')) {
    return refused(409, 'TARGET_EXISTS', {
      target: plan.to,
      hint: 'another entry already uses that file name; pick a different one',
      nothingWritten: true,
    })
  }

  const mentionsBefore = mentionCount(source.root, renamedKind, entity.id)
  const title = newTitle === '' ? undefined : { field: titleFieldOf(renamedKind), value: newTitle }

  const locked = withProjectWriteLock(source.root, (lock) =>
    renameLocked(lock.root, { entity, to: plan.to, pinId: entity.id, title, expected: expected.value }),
  )
  if (!locked.ok) return ioRefusal(locked.error)
  if (!locked.value.ok) return locked.value.reply

  const ensured = await ensureIndex(source.root, { rebuild: true })
  const after = mentionCount(source.root, renamedKind, entity.id)

  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: source.root,
        kind,
        id: entity.id,
        path: locked.value.written.path,
        previousPath: entity.path,
        title: newTitle === '' ? entity.title : newTitle,
        pinnedId: true,
        changed: locked.value.written.changed,
        fingerprint: fingerprintProjectFile(source.root, locked.value.written.path) ?? null,
        before: { id: entity.id, path: entity.path },
        after: { id: entity.id, path: locked.value.written.path },
        // The two numbers that prove nothing was rewritten: the mentions were keyed
        // by id, so they resolve exactly as many times as before the move.
        mentions: { before: mentionsBefore, after },
        ...indexDegradation(ensured),
      },
    },
  }
}
