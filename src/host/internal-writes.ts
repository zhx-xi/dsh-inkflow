/**
 * The panel channel's write routes: the editor's save path is the only place in
 * the channel that changes truth files, and it does it the way a tool does —
 * through `chapters.ts`, which owns the write lock, the atomic replace, the
 * catalog rebuild and `commitIndex`.
 *
 * WHY IT IS A FILE: request problems are answered here as HTTP-shaped refusals
 * (ADR-0008 D3), which is a different vocabulary from the read builders', and
 * keeping the two apart lets a reader see the write surface at once.
 *
 * `internal.ts` re-exports these functions so `routes-internal.ts` keeps its
 * single import.
 */

import { createChapter, deleteChapter, moveChapter, writeChapter } from './chapters.js'
import type { ChapterOpFailure, ChapterOpError, ChapterView } from './chapters.js'
import { fingerprintProjectFile } from './file-cas.js'
import type { FileExpectation, FileFingerprint } from './file-cas.js'
import type { EolStyle } from './text-style.js'
import type { ChannelTarget, JsonRecord } from './internal-types.js'

// ---------------------------------------------------------------------------
// Write routes: the panel editor's save path
//
// These are the only places in this module that change the truth files, and
// they do it the same way a tool does: through `chapters.ts`, which owns the
// write lock, the atomic replace, the catalog rebuild and `commitIndex`. The
// channel adds nothing but HTTP semantics and the CAS plumbing, so
// there is exactly one writer implementation in the plugin.
//
// The HTTP vocabulary is declared per route (ADR-0008 D3): request problems are
// 400/413/415, an unknown chapter is 404, a stale baseline or a taken name is
// 409 (`FILE_CHANGED` above all), and everything else is 500 with the domain
// code kept intact so a bug stays diagnosable.
// ---------------------------------------------------------------------------

/** HTTP answer of a write route: the route layer only sends it. */
export interface WriteReply {
  status: number
  body: JsonRecord
}

export interface WriteRequest {
  target: ChannelTarget
  /** Percent-encoded `pattern` captures; `params[0]` is the chapter id. */
  params: readonly string[]
  body: JsonRecord
  version: string
}

type FieldRead<T> = { ok: true; value: T } | { ok: false; reply: WriteReply }

/** 400 for one malformed field: the caller named something unusable. */
function badField(field: string, expected: string): WriteReply {
  return {
    status: 400,
    body: { ok: false, error: { code: 'invalid-field', field, hint: `\`${field}\` must be ${expected}` } },
  }
}

function invalidExpected(field: string): WriteReply {
  return {
    status: 400,
    body: {
      ok: false,
      error: { code: 'EXPECTED_INVALID', field, hint: 'expected must be an object: { sha256?, size?, mtimeMs?, absent? }' },
    },
  }
}

/** A declared field: absent/`null` is "not set", any other type is a 400. */
function optionalText(body: JsonRecord, key: string): FieldRead<string | undefined> {
  const value = body[key]
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== 'string') return { ok: false, reply: badField(key, 'a string') }
  return { ok: true, value }
}

function requiredText(body: JsonRecord, key: string): FieldRead<string> {
  const value = body[key]
  // Only the TYPE is checked here: an empty title is the domain's `TITLE_REQUIRED`
  // (400 with the code a tool caller already knows), not a channel field error.
  if (typeof value !== 'string') return { ok: false, reply: badField(key, 'a string') }
  return { ok: true, value }
}

/** `volumeId` is `vol-NN`, or `null` for "no volume" (a loose chapter). */
function optionalVolumeId(body: JsonRecord): FieldRead<string | null | undefined> {
  const value = body['volumeId']
  if (value === undefined) return { ok: true, value: undefined }
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, reply: badField('volumeId', 'a `vol-NN` string or null') }
  return { ok: true, value }
}

function optionalSeq(body: JsonRecord): FieldRead<number | undefined> {
  const value = body['seq']
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, reply: badField('seq', 'an integer') }
  return { ok: true, value }
}

/**
 * The line ending the panel read out of the file (ADR-0016).
 *
 * Only the two values a chapter can actually have: anything else is a caller that
 * invented a style, and the write path must not guess what it meant.
 */
function optionalEol(body: JsonRecord): FieldRead<EolStyle | undefined> {
  const value = body['eol']
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (value !== 'lf' && value !== 'crlf') return { ok: false, reply: badField('eol', '`lf` or `crlf`') }
  return { ok: true, value }
}

/** A declared boolean (the `bom` half of the same metadata). */
function optionalBoolean(body: JsonRecord, key: string): FieldRead<boolean | undefined> {
  const value = body[key]
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== 'boolean') return { ok: false, reply: badField(key, 'a boolean') }
  return { ok: true, value }
}

/**
 * The CAS baseline (§5.5). Absent means "write regardless" — which is exactly
 * what the panel's explicit "仍要保存（覆盖）" sends, so the only way a conflict
 * is ever overwritten is a user pressing that button.
 */
function readExpected(body: JsonRecord): FieldRead<FileExpectation | undefined> {
  const raw = body['expected']
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reply: invalidExpected('expected') }
  const record = raw as JsonRecord
  const allowed = new Set(['sha256', 'size', 'mtimeMs', 'absent'])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return { ok: false, reply: invalidExpected(`expected.${key}`) }
  }
  const expected: FileExpectation = {}
  if (record['sha256'] !== undefined) {
    if (typeof record['sha256'] !== 'string') return { ok: false, reply: invalidExpected('expected.sha256') }
    expected.sha256 = record['sha256'].trim().toLowerCase()
  }
  if (record['size'] !== undefined) {
    if (typeof record['size'] !== 'number' || !Number.isFinite(record['size'])) {
      return { ok: false, reply: invalidExpected('expected.size') }
    }
    expected.size = record['size']
  }
  if (record['mtimeMs'] !== undefined) {
    if (typeof record['mtimeMs'] !== 'number' || !Number.isFinite(record['mtimeMs'])) {
      return { ok: false, reply: invalidExpected('expected.mtimeMs') }
    }
    expected.mtimeMs = record['mtimeMs']
  }
  if (record['absent'] === true) expected.absent = true
  return { ok: true, value: expected }
}

/** An id capture, percent-decoded; `undefined` means "malformed encoding". */
function decodeParam(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  try {
    const id = decodeURIComponent(raw).trim()
    return id === '' ? undefined : id
  } catch {
    return undefined
  }
}

/**
 * `:id` addresses a chapter by id **or** by project-relative path, exactly like
 * `GET /chapters/:id`. `chapters.ts` wants the two apart.
 */
function chapterSelector(id: string): { chapterId?: string; file?: string } {
  const normalized = id.replaceAll('\\', '/').replace(/^\.\//u, '')
  const lower = normalized.toLowerCase()
  if (lower.startsWith('chapters/') && lower.endsWith('.md')) return { file: normalized }
  return { chapterId: id }
}

/** `CHAPTER_NOT_FOUND` reaches the wire in the read route's spelling. */
const WIRE_CODES: Record<string, string> = {
  CHAPTER_NOT_FOUND: 'chapter-not-found',
  VOLUME_NOT_FOUND: 'volume-not-found',
}

const BAD_REQUEST_CODES = new Set([
  'TITLE_REQUIRED',
  'STATUS_INVALID',
  'SEQ_INVALID',
  'FILE_INVALID',
  'SLUG_INVALID',
  'VOLUME_ID_INVALID',
  'CHAPTER_SELECTOR_REQUIRED',
])

const CONFLICT_CODES = new Set([
  'CHAPTER_EXISTS',
  'CHAPTER_AMBIGUOUS',
  'CHAPTER_SELECTOR_CONFLICT',
  'SEQ_CONFLICT',
  'TARGET_EXISTS',
  'VOLUME_EXISTS',
  'PROJECT_BUSY',
  // The recovery bin refused the move because that path already owns a slot in it
  // (a review blocking finding): a state conflict, not a server fault.
  'TRASH_ENTRY_EXISTS',
])

const FILE_CHANGED_HINT =
  'the file changed on disk since you read it: reload it (discarding your edits) or save again without `expected` to overwrite'

/**
 * Domain failure → HTTP answer.
 *
 * `FILE_CHANGED` is the one that matters to the editor: it carries `expected`,
 * `current` and `changed[]` so the panel can say *what* moved, and it is
 * guaranteed to have written nothing (§5.5).
 */
function chapterFailureReply(failure: ChapterOpFailure): WriteReply {
  const error: ChapterOpError = failure.error
  const code = WIRE_CODES[error.code] ?? error.code
  const detail: JsonRecord = { code, message: error.message }
  if (error.path !== undefined) detail['path'] = error.path
  if (error.hint !== undefined) detail['hint'] = error.hint
  if (error.rolledBack !== undefined) detail['rolledBack'] = error.rolledBack
  if (error.rollback !== undefined) detail['rollback'] = error.rollback
  if (error.io !== undefined) detail['io'] = error.io
  if (error.nothingWritten !== undefined) detail['nothingWritten'] = error.nothingWritten

  if (error.code === 'FILE_CHANGED') {
    detail['expected'] = error.expected ?? null
    detail['current'] = error.current ?? null
    detail['changed'] = error.changed ?? []
    detail['nothingWritten'] = true
    if (detail['hint'] === undefined) detail['hint'] = FILE_CHANGED_HINT
    return { status: 409, body: { ok: false, error: detail } }
  }
  if (error.code === 'CHAPTER_NOT_FOUND' || error.code === 'VOLUME_NOT_FOUND') {
    return { status: 404, body: { ok: false, error: detail } }
  }
  if (BAD_REQUEST_CODES.has(error.code)) return { status: 400, body: { ok: false, error: detail } }
  if (CONFLICT_CODES.has(error.code)) return { status: 409, body: { ok: false, error: detail } }
  return { status: 500, body: { ok: false, error: detail } }
}

/** The successful value of a write: the chapter as it is now, plus its baseline. */
function writeValue(target: ChannelTarget, version: string, chapter: ChapterView, extra: JsonRecord): WriteReply {
  const fingerprint: FileFingerprint | undefined = fingerprintProjectFile(target.root, chapter.file)
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: target.sessionId,
        root: target.root,
        chapter,
        fingerprint: fingerprint ?? null,
        ...extra,
      },
    },
  }
}

// The three chapter write routes' body whitelists. They live here, not in the
// route table, because THIS is the module that reads those bodies: the field names sit
// next to the `requiredText`/`optionalSeq`/`readExpected` calls that consume them, so a
// new field is one edit in one file. `sessionId` is allowed on every write anyway
// (`routes.ts` always permits it); it is listed to keep each route's declaration a full
// statement of what may travel.

/** `POST /chapters` body: what a create may carry (`title` is the only required one). */
export const CHAPTER_CREATE_BODY_FIELDS = ['sessionId', 'title', 'volumeId', 'slug', 'seq'] as const

/** `POST|DELETE /chapters/:id`: the editor's save fields and the CAS baseline. */
export const CHAPTER_SAVE_BODY_FIELDS = [
  'sessionId',
  'title',
  'body',
  'status',
  'eol',
  'bom',
  'expected',
] as const

/** `POST /chapters/:id/move`: the target volume plus the CAS baseline. */
export const CHAPTER_MOVE_BODY_FIELDS = ['sessionId', 'volumeId', 'expected'] as const

/** `POST /chapters`: create a chapter (title is the only required field). */
export async function createChapterViaChannel(request: WriteRequest): Promise<WriteReply> {
  const title = requiredText(request.body, 'title')
  if (!title.ok) return title.reply
  const volumeId = optionalVolumeId(request.body)
  if (!volumeId.ok) return volumeId.reply
  const slug = optionalText(request.body, 'slug')
  if (!slug.ok) return slug.reply
  const seq = optionalSeq(request.body)
  if (!seq.ok) return seq.reply

  const result = await createChapter(request.target.root, {
    title: title.value,
    volumeId: volumeId.value,
    slug: slug.value,
    seq: seq.value,
  })
  if (!result.ok) return chapterFailureReply(result)
  return writeValue(request.target, request.version, result.chapter, {
    catalogRebuilt: result.catalogRebuilt,
    indexRebuilt: result.indexRebuilt,
    ...(result.indexError === undefined ? {} : { indexError: result.indexError }),
  })
}

/** `POST /chapters/:id`: change title/body/status against a CAS baseline. */
export async function writeChapterViaChannel(request: WriteRequest): Promise<WriteReply> {
  const id = decodeParam(request.params[0])
  if (id === undefined) return { status: 400, body: { ok: false, error: { code: 'invalid-path-encoding' } } }
  const title = optionalText(request.body, 'title')
  if (!title.ok) return title.reply
  const body = optionalText(request.body, 'body')
  if (!body.ok) return body.reply
  const status = optionalText(request.body, 'status')
  if (!status.ok) return status.reply
  const eol = optionalEol(request.body)
  if (!eol.ok) return eol.reply
  const bom = optionalBoolean(request.body, 'bom')
  if (!bom.ok) return bom.reply
  const expected = readExpected(request.body)
  if (!expected.ok) return expected.reply

  if (title.value === undefined && body.value === undefined && status.value === undefined) {
    return {
      status: 400,
      body: { ok: false, error: { code: 'invalid-field', field: 'body', hint: 'pass at least one of title, body, status' } },
    }
  }

  const result = await writeChapter(request.target.root, {
    ...chapterSelector(id),
    title: title.value,
    body: body.value,
    status: status.value,
    eol: eol.value,
    bom: bom.value,
    expected: expected.value,
  })
  if (!result.ok) return chapterFailureReply(result)
  return writeValue(request.target, request.version, result.chapter, {
    changed: result.changed,
    ...(result.renamedFrom === undefined ? {} : { renamedFrom: result.renamedFrom }),
    // Echo the style actually written: a panel that declared something else
    // learns here what the file now is, instead of guessing on the next save.
    eol: result.style.eol,
    bom: result.style.bom,
    catalogRebuilt: result.catalogRebuilt,
    indexRebuilt: result.indexRebuilt,
    ...(result.indexError === undefined ? {} : { indexError: result.indexError }),
  })
}

/** `POST /chapters/:id/move`: move between volumes (or out of every volume). */
export async function moveChapterViaChannel(request: WriteRequest): Promise<WriteReply> {
  const id = decodeParam(request.params[0])
  if (id === undefined) return { status: 400, body: { ok: false, error: { code: 'invalid-path-encoding' } } }
  const volumeId = optionalVolumeId(request.body)
  if (!volumeId.ok) return volumeId.reply
  if (volumeId.value === undefined) {
    // Required on purpose: `undefined` and `null` both mean "loose chapter" in
    // the domain layer, so a missing field would silently move the chapter out
    // of its volume.
    return { status: 400, body: { ok: false, error: { code: 'invalid-field', field: 'volumeId', hint: 'pass a volume id or null for "no volume"' } } }
  }
  const expected = readExpected(request.body)
  if (!expected.ok) return expected.reply

  const result = await moveChapter(request.target.root, {
    ...chapterSelector(id),
    volumeId: volumeId.value,
    expected: expected.value,
  })
  if (!result.ok) return chapterFailureReply(result)
  return writeValue(request.target, request.version, result.chapter, {
    moved: result.moved,
    movedFrom: result.movedFrom,
    changed: result.changed,
    catalogRebuilt: result.catalogRebuilt,
    indexRebuilt: result.indexRebuilt,
    ...(result.indexError === undefined ? {} : { indexError: result.indexError }),
  })
}

/** `DELETE /chapters/:id`: delete one chapter against a CAS baseline. */
export async function deleteChapterViaChannel(request: WriteRequest): Promise<WriteReply> {
  const id = decodeParam(request.params[0])
  if (id === undefined) return { status: 400, body: { ok: false, error: { code: 'invalid-path-encoding' } } }
  const expected = readExpected(request.body)
  if (!expected.ok) return expected.reply

  const result = await deleteChapter(request.target.root, {
    ...chapterSelector(id),
    expected: expected.value,
  })
  if (!result.ok) return chapterFailureReply(result)
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: request.version,
        sessionId: request.target.sessionId,
        root: request.target.root,
        deleted: result.deleted,
        // The delete is reversible, so the wire says where the copy went.
        trashed: result.trashed,
        catalogRebuilt: result.catalogRebuilt,
        indexRebuilt: result.indexRebuilt,
        ...(result.indexError === undefined ? {} : { indexError: result.indexError }),
      },
    },
  }
}
