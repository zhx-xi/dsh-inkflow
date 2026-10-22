/**
 * The request half of the setting library's save (issue #30, second batch).
 *
 * `POST /inkflow/internal/library/item` accepts four things besides the entity
 * address: `frontmatter`, `body`, `expected` and the implicit `sessionId`. This
 * module turns them into values the writer can trust, and refuses everything it
 * cannot write back faithfully — *before* a single byte is read from or written
 * to the book (the route's own guards already ran; this is the second net).
 *
 * Why a separate file from `library-write.ts`: the writer is about finding one
 * file, patching it and reporting the result; the request rules are about the
 * file format's limits (which value types it can read back, which key spelling
 * survives a round trip, what "no baseline" means). Two concerns, both readable
 * on their own (AGENTS.md §10.5).
 *
 * Three rules that are easy to get wrong, so they are stated once here:
 *
 *   * **`null` deletes a key, `[]` deletes a list.** The format has no nested
 *     mapping, so `null` cannot mean "write null": it means "remove the line",
 *     which is exactly what a cleared form field needs. `[]` means the same for
 *     a list, and both collapse into one `remove` list so the writer has one
 *     mechanism.
 *   * **A nested mapping is a 400, not a silent rewrite.** `parseMarkdown` reads
 *     `origin: {…}` back as one string, so accepting it would corrupt the file
 *     on the way out while looking fine in the response.
 *   * **`expected` is mandatory here.** The chapter editor's "仍要保存" sends no
 *     baseline (an explicit overwrite); the library editor has no such button,
 *     so an absent or empty baseline is `400 EXPECTED_REQUIRED`.
 */

import type { FileExpectation } from './file-cas.js'
import { rawScalar } from './frontmatter.js'
import type { FrontmatterValue } from './frontmatter.js'
import type { LibraryItemReply } from './library-view.js'

/** A plain JSON payload, the channel's envelope half (`{ok,value|error}`). */
type JsonRecord = Record<string, unknown>

/**
 * Field names that may appear in the body. The route declares the same list, so
 * an undeclared field is a 400 at the guard layer before this module runs; the
 * check here is the second net and the place the names are documented.
 */
export const LIBRARY_WRITE_BODY_FIELDS = ['kind', 'id', 'frontmatter', 'body', 'expected'] as const

/**
 * The one constructors of a refused `POST /library/item` (and of the 409 the
 * writer raises), so every refusal on this route has the same envelope.
 */
export function refused(status: number, code: string, extra: JsonRecord = {}): LibraryItemReply {
  return { status, body: { ok: false, error: { code, ...extra } } }
}

/** A field read: the value, or the reply that refuses the request. */
export type FieldRead<T> = { ok: true; value: T } | { ok: false; reply: LibraryItemReply }

/**
 * The frontmatter edit, split into what to write and what to delete.
 *
 * `entries` never holds an empty list or a `null`: both mean "remove the key",
 * and having one mechanism (`remove`) keeps the writer's block-creation path
 * from writing a `key:` line that reads back as an empty list.
 */
export interface FieldPatch {
  readonly entries: Record<string, FrontmatterValue>
  readonly remove: readonly string[]
}

const FRONTMATTER_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/

function invalidValue(key: string, reason: string): LibraryItemReply {
  return refused(400, 'FRONTMATTER_VALUE_INVALID', {
    field: key,
    reason,
    hint: 'a value may be a string, a number, a boolean, a list of those, or null to delete the key',
  })
}

/** A single-line scalar: everything the file format can represent. */
function singleLine(value: string): boolean {
  return !/[\r\n]/u.test(value)
}

/** One list item → text; numbers and booleans are rendered the way YAML reads them. */
function itemText(value: unknown): string | undefined {
  if (typeof value === 'string') return singleLine(value) ? value : undefined
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return undefined
}

/**
 * Parse the `frontmatter` field of the body.
 *
 * Only values this file format can read back are accepted: a nested mapping is
 * the one form the reader deliberately cannot represent (it reads back as one
 * string), so an object value is a 400 rather than a silent corruption.
 */
export function readFrontmatterFields(value: unknown): FieldRead<FieldPatch | undefined> {
  if (value === undefined) return { ok: true, value: undefined }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      ok: false,
      reply: refused(400, 'FRONTMATTER_INVALID', {
        field: 'frontmatter',
        hint: 'send `frontmatter` as an object of key → value',
      }),
    }
  }

  const entries: Record<string, FrontmatterValue> = {}
  const remove: string[] = []
  for (const [key, raw] of Object.entries(value as JsonRecord)) {
    if (!FRONTMATTER_KEY.test(key)) {
      return {
        ok: false,
        reply: refused(400, 'FRONTMATTER_INVALID', {
          field: 'frontmatter',
          key,
          hint: 'a frontmatter key is letters, digits, `_` and `-`, starting with a letter or `_`',
        }),
      }
    }
    if (raw === null) {
      remove.push(key)
      continue
    }
    if (typeof raw === 'string') {
      if (!singleLine(raw)) return { ok: false, reply: invalidValue(key, 'a value cannot contain a line break') }
      entries[key] = raw
      continue
    }
    if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) return { ok: false, reply: invalidValue(key, 'a number must be finite') }
      // `rawScalar`: `parseScalar` keeps numbers as text, so `priority: 3` reads
      // back as "3" — quoting it would only make the file louder.
      entries[key] = rawScalar(String(raw))
      continue
    }
    if (typeof raw === 'boolean') {
      entries[key] = rawScalar(raw ? 'true' : 'false')
      continue
    }
    if (Array.isArray(raw)) {
      const items: string[] = []
      for (const item of raw) {
        const text = itemText(item)
        if (text === undefined) {
          return { ok: false, reply: invalidValue(key, 'a list item must be a string, a number or a boolean') }
        }
        items.push(text)
      }
      // An empty list is "no value" in the file format: delete the key.
      if (items.length === 0) remove.push(key)
      else entries[key] = items
      continue
    }
    return { ok: false, reply: invalidValue(key, 'a nested mapping cannot be represented in frontmatter') }
  }
  return { ok: true, value: { entries, remove } }
}

/**
 * Whether every code unit pairs up into a real character.
 *
 * This is `String.prototype.isWellFormed()` (ES2024) spelled out: the project
 * targets ES2023, and an unpaired surrogate has no UTF-8 encoding — writing one
 * would put a replacement character into the author's prose.
 */
function isWellFormedText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1)
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false
      index += 1
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}

/**
 * The `body` field: a whole-body replacement.
 *
 * `isWellFormedText()` is the exact test for "this string has a UTF-8 encoding":
 * an unpaired surrogate has none, and writing it would corrupt the prose.
 */
export function readBodyText(body: JsonRecord): FieldRead<string | undefined> {
  const value = body['body']
  if (value === undefined) return { ok: true, value: undefined }
  if (typeof value !== 'string') {
    return { ok: false, reply: refused(400, 'BODY_INVALID', { field: 'body', hint: '`body` must be a string of UTF-8 text' }) }
  }
  if (!isWellFormedText(value)) {
    return {
      ok: false,
      reply: refused(400, 'BODY_INVALID', {
        field: 'body',
        reason: 'not-utf8',
        hint: 'the body contains an unpaired surrogate, which has no UTF-8 encoding',
      }),
    }
  }
  return { ok: true, value }
}

/**
 * The mandatory CAS baseline (§5.5).
 *
 * Every supplied field is checked; an object with no checkable field is refused
 * as "no baseline", because `{}` would silently mean "overwrite whatever is
 * there" — the exact behaviour this route does not offer.
 */
export function readExpectation(body: JsonRecord): FieldRead<FileExpectation> {
  const raw = body['expected']
  if (raw === undefined || raw === null) {
    return {
      ok: false,
      reply: refused(400, 'EXPECTED_REQUIRED', {
        field: 'expected',
        hint: 'send the `fingerprint` of the entry you loaded: { sha256, size, mtimeMs }',
      }),
    }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reply: refused(400, 'EXPECTED_INVALID', { field: 'expected', hint: 'expected must be an object' }) }
  }
  const record = raw as JsonRecord
  const expected: FileExpectation = {}
  for (const key of Object.keys(record)) {
    if (key !== 'sha256' && key !== 'size' && key !== 'mtimeMs') {
      return {
        ok: false,
        reply: refused(400, 'EXPECTED_INVALID', {
          field: `expected.${key}`,
          hint: 'expected accepts sha256, size and mtimeMs only',
        }),
      }
    }
  }
  const sha256 = record['sha256']
  if (sha256 !== undefined) {
    if (typeof sha256 !== 'string' || sha256.trim() === '') {
      return { ok: false, reply: refused(400, 'EXPECTED_INVALID', { field: 'expected.sha256' }) }
    }
    expected.sha256 = sha256.trim().toLowerCase()
  }
  const size = record['size']
  if (size !== undefined) {
    if (typeof size !== 'number' || !Number.isFinite(size)) {
      return { ok: false, reply: refused(400, 'EXPECTED_INVALID', { field: 'expected.size' }) }
    }
    expected.size = size
  }
  const mtimeMs = record['mtimeMs']
  if (mtimeMs !== undefined) {
    if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) {
      return { ok: false, reply: refused(400, 'EXPECTED_INVALID', { field: 'expected.mtimeMs' }) }
    }
    expected.mtimeMs = mtimeMs
  }
  if (expected.sha256 === undefined && expected.size === undefined && expected.mtimeMs === undefined) {
    return {
      ok: false,
      reply: refused(400, 'EXPECTED_REQUIRED', {
        field: 'expected',
        hint: 'an empty baseline cannot detect a change: send at least one of sha256, size, mtimeMs',
      }),
    }
  }
  return { ok: true, value: expected }
}
