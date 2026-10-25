/**
 * The setting library's save path (second batch): one entity file,
 * frontmatter fields plus body, against a compare-and-swap baseline.
 *
 * Why a module of its own: `library-view.ts` is the read projection and states
 * in its own header that it writes nothing; the chapter write routes own
 * `chapters.ts`, whose domain rules (title → file rename, catalog rebuild,
 * volume allocation) do not apply to a setting-library entry. This file is the
 * one implementation of "replace the fields the author edited, keep every other
 * byte of the file", and it writes through `io.ts` like every other writer
 * (atomic temp+rename, project write lock, path whitelist — data-safety §2).
 *
 * Two decisions worth stating, because they differ from the chapter editor:
 *
 *   * **The id is resolved from the files, not from the index.** The index may be
 *     unreadable (that is a normal, reported state: `INDEX_UNAVAILABLE`), and a
 *     save must not depend on a cache. A bare id is matched against the files of
 *     that kind's directory (`id:` when the file declares one, otherwise the
 *     project-relative path — the same rule the domains use); a path-shaped id
 *     (`characters/沈青.md`) is accepted only inside that kind's directory.
 *   * **A title edit does not rename the file.** The chapter editor renames
 *     because a chapter file name is its reading order; a library file name is
 *     the author's own choice, and for a file without `id:` it *is* the entity
 *     id — renaming it would change the address under the browser's feet.
 *
 * The request's own rules (which value types survive a round trip, why `null`
 * deletes a field, why `expected` is mandatory here and optional on the chapter
 * route) live in `library-request.ts` — this file starts from values it can
 * trust.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

import type { ContentDir } from './conventions.js'
import { SHARED_REFERENCE_MODE } from './conventions.js'
import { countChars } from './domains/scan-helpers.js'
import { compareExpectation, fingerprintBytes, fingerprintProjectFile } from './file-cas.js'
import type { FileChange, FileExpectation, FileFingerprint } from './file-cas.js'
import {
  frontmatterLine,
  frontmatterListItem,
  frontmatterRawLine,
  parseMarkdown,
  patchFrontmatter,
  splitFrontmatter,
  stringField,
} from './frontmatter.js'
import type { FrontmatterValue } from './frontmatter.js'
import { ensureIndex } from './index-freshness.js'
import type { EnsureIndexResult } from './index-freshness.js'
import { withProjectWriteLock, writeTextAtomic } from './io.js'
import type { IoFailure } from './io.js'
import { readBodyText, readExpectation, readFrontmatterFields, refused } from './library-request.js'
import type { FieldPatch } from './library-request.js'
import { LIBRARY_KINDS } from './library-view.js'
import type { LibraryItemReply, LibrarySource } from './library-view.js'
import { isWithin, realpathLoose } from './project.js'

/** A plain JSON payload, the channel's envelope half (`{ok,value|error}`). */
type JsonRecord = Record<string, unknown>

/** One save request: the resolved book, the request body, the plugin version. */
export interface LibraryWriteRequest {
  source: LibrarySource
  version: string
  body: JsonRecord
}

/** How deep a kind directory may nest (chapter subtrees do not exist here). */
const MAX_KIND_DEPTH = 4

function ok(value: JsonRecord): JsonRecord {
  return { ok: true, value }
}

function isLibraryKind(value: string): value is ContentDir {
  return (LIBRARY_KINDS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Resolving (kind, id) → one file
// ---------------------------------------------------------------------------

type ResolveOutcome = { ok: true; path: string } | { ok: false; reply: LibraryItemReply }

function outOfScope(kind: string, id: string, reason: string): LibraryItemReply {
  return refused(400, 'PATH_OUT_OF_SCOPE', { kind, id, reason, hint: `an entry id addresses a file inside ${kind}/ only` })
}

function notFound(kind: string, id: string, reason?: string): LibraryItemReply {
  return refused(404, 'library-item-not-found', {
    kind,
    id,
    ...(reason === undefined ? {} : { reason }),
    hint: `list the tree with GET /library and use an id from its "${kind}" group`,
  })
}

/** A `.md` file directly under `kind/` or in one of its subdirectories. */
function collectMarkdown(root: string, dir: string, out: string[], depth: number): void {
  if (depth > MAX_KIND_DEPTH) return
  let entries
  try {
    entries = readdirSync(join(root, ...dir.split('/')), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const child = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      collectMarkdown(root, child, out, depth + 1)
      continue
    }
    // `isFile()` is false for a symlink: a link is not an entry the index would
    // have published, and following one could leave the content directory.
    if (!entry.isFile()) continue
    if (extname(entry.name).toLowerCase() !== '.md') continue
    out.push(child)
  }
}

/** Every Markdown file under one kind directory, in a stable order. */
function markdownFilesIn(root: string, kind: string): string[] {
  const out: string[] = []
  collectMarkdown(root, kind, out, 0)
  out.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  return out
}

function readTextFile(absolute: string): string | undefined {
  try {
    // UTF-8, tolerating a BOM the way every reader in this project does (H11).
    return readFileSync(absolute, 'utf8').replace(/^\uFEFF/u, '')
  } catch {
    return undefined
  }
}

function looksLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value)
}

/**
 * A path-shaped id: the same escape nets the chapter detail route applies,
 * generalised over the kind. A caller may name the file it already knows, but
 * never a file outside that kind's directory.
 */
function resolveByPath(root: string, kind: ContentDir, id: string): ResolveOutcome {
  const candidate = id.replaceAll('\\', '/').replace(/^\.\//u, '')
  if (candidate.startsWith('/') || /^[A-Za-z]:/u.test(candidate)) {
    return { ok: false, reply: outOfScope(kind, id, 'an absolute path cannot name a library entry') }
  }
  const segments = candidate.split('/')
  if (segments.includes('..')) {
    return { ok: false, reply: outOfScope(kind, id, 'a `..` segment cannot name a library entry') }
  }
  if (segments[0] !== kind) {
    return { ok: false, reply: outOfScope(kind, id, `the path must start with ${kind}/`) }
  }
  if (extname(candidate).toLowerCase() !== '.md') {
    return { ok: false, reply: notFound(kind, id, 'only Markdown files are library entries') }
  }
  // Realpath containment, not string prefixing: a symlinked directory inside the
  // kind dir would otherwise read/write a file that belongs to another directory.
  const base = realpathLoose(join(root, kind))
  const absolute = realpathLoose(join(root, ...segments))
  if (!isWithin(base, absolute)) {
    return { ok: false, reply: outOfScope(kind, id, 'the path resolves outside the content directory') }
  }
  let isFile = false
  try {
    isFile = statSync(absolute).isFile()
  } catch {
    isFile = false
  }
  if (!isFile) return { ok: false, reply: notFound(kind, id) }
  return { ok: true, path: candidate }
}

/**
 * A bare id: match it against the files of that kind.
 *
 * The id a domain publishes is `frontmatter.id` when the file declares one and
 * the project-relative path otherwise (`stringField(data, 'id') ?? path`, the
 * rule in every registered domain), so both spellings are compared here. The
 * index is not consulted: it is a cache, and a save must work when the cache
 * cannot be read. Two files claiming the same id resolve to the first in walk
 * order, exactly like the indexer's keep-first rule.
 */
function resolveById(root: string, kind: ContentDir, id: string): ResolveOutcome {
  for (const relative of markdownFilesIn(root, kind)) {
    const text = readTextFile(join(root, ...relative.split('/')))
    if (text === undefined) continue
    // Cheap prefilter: a file that does not even mention the id cannot declare
    // it. (A path-shaped id equals the path, so that spelling is checked too.)
    if (!text.includes(id) && relative !== id) continue
    const declared = stringField(parseMarkdown(text).data, 'id')
    const entityId = declared === undefined || declared.trim() === '' ? relative : declared.trim()
    if (entityId === id) return { ok: true, path: relative }
  }
  return { ok: false, reply: notFound(kind, id) }
}

/**
 * ADR-0007 C4: a `mode: reference` card points at the shared library's original and
 * holds no body, so the book is not self-contained for that entry. Letting the save
 * path write it would silently turn a reference into a second copy that still claims
 * to be a reference — so every write to it is refused, before anything is patched.
 *
 * Read here (before the lock, so the refusal is not masked by a missing `expected`)
 * and again inside `writeLocked` (after the lock, so the check is authoritative).
 */
function referenceCardReply(root: string, relativePath: string): LibraryItemReply | undefined {
  const text = readTextFile(join(root, ...relativePath.split('/')))
  if (text === undefined) return undefined
  if (stringField(parseMarkdown(text).data, 'mode') !== SHARED_REFERENCE_MODE) return undefined
  return refused(409, 'REFERENCE_READONLY', {
    path: relativePath,
    nothingWritten: true,
    hint:
      'this card is a reference to a shared library original (ADR-0007 C4): the book does not hold its text. ' +
      'Edit the shared entry, or remove the card and copy the entry as a snapshot (mode: copy)',
  })
}

function resolveEntityFile(root: string, kind: ContentDir, id: string): ResolveOutcome {
  return looksLikePath(id) ? resolveByPath(root, kind, id) : resolveById(root, kind, id)
}

// ---------------------------------------------------------------------------
// Rendering the edit
// ---------------------------------------------------------------------------

interface EditResult {
  text: string
  /** `frontmatter` keys written and `body` when the prose was replaced. */
  changed: string[]
  replacedKeys: string[]
  appendedKeys: string[]
  removedKeys: string[]
}

/** `FrontmatterRawScalar` is the only non-string, non-array value form. */
function isRawScalarValue(value: FrontmatterValue): value is { readonly raw: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One `key: value` line (or a block list), rendered exactly as `patchFrontmatter` would. */
function renderEntry(key: string, value: FrontmatterValue): string[] {
  if (typeof value === 'string') return [frontmatterLine(key, value)]
  if (isRawScalarValue(value)) return [frontmatterRawLine(key, value.raw)]
  return [`${key}:`, ...value.map(frontmatterListItem)]
}

/**
 * Apply the patch to the document.
 *
 * The frontmatter half is rewritten line by line (unknown keys, key order,
 * comments, quote style and line endings survive — that is `patchFrontmatter`'s
 * contract); the body half is replaced wholesale when the caller sent one. A
 * document with no block gets one created, otherwise a save on a legacy file
 * would silently do nothing.
 */
function applyEdit(text: string, patch: FieldPatch, body: string | undefined): EditResult {
  const keys = Object.keys(patch.entries)
  const parts = splitFrontmatter(text)
  const changed: string[] = []
  let replacedKeys: string[] = []
  let appendedKeys: string[] = []
  let removedKeys: string[] = []
  let next = text

  if (keys.length > 0 || patch.remove.length > 0) {
    if (!parts.hasFrontmatter) {
      // `['---', …, '---', '', '']` joins to `---\n…\n---\n\n`: the blank line
      // keeps the block separate from the prose (chapters.ts does the same).
      const lines = ['---', ...keys.flatMap((key) => renderEntry(key, patch.entries[key] ?? '')), '---', '']
      next = `${lines.join('\n')}\n${parts.body}`
      appendedKeys = keys
      changed.push(...keys)
      // Nothing to remove: a document without a block has no keys.
    } else {
      const patched = patchFrontmatter(parts.head, patch.entries, { remove: patch.remove })
      next = patched.text + parts.body
      replacedKeys = patched.replaced
      appendedKeys = patched.appended
      removedKeys = patched.removed
      changed.push(...patched.replaced, ...patched.appended, ...patched.removed)
    }
  }

  if (body !== undefined) {
    next = `${splitFrontmatter(next).head}${body}`
    changed.push('body')
  }
  return { text: next, changed, replacedKeys, appendedKeys, removedKeys }
}

// ---------------------------------------------------------------------------
// The write itself
// ---------------------------------------------------------------------------

/** The line endings and BOM `io.ts` normalises away; used only for comparison. */
function normalize(text: string): string {
  return (text.startsWith('\uFEFF') ? text.slice(1) : text).replace(/\r\n?/gu, '\n')
}

function fileChanged(relative: string, drift: FileChange): LibraryItemReply {
  return refused(409, 'FILE_CHANGED', {
    path: relative,
    expected: drift.expected,
    current: drift.current,
    changed: drift.changed,
    nothingWritten: true,
    hint: 'reload the entry and save again: this route never overwrites a file that changed on disk',
  })
}

/** A refused/failed `io.ts` call, in the channel's own vocabulary. */
function ioRefusal(failure: IoFailure): LibraryItemReply {
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
      },
    },
  }
}

interface WriteOutcome {
  changed: string[]
  replacedKeys: string[]
  appendedKeys: string[]
  removedKeys: string[]
  replaced: boolean
  fingerprint: FileFingerprint
  hasFrontmatter: boolean
  frontmatter: Record<string, unknown>
  body: string
  path: string
}

type LockedWrite = { ok: true; value: WriteOutcome } | { ok: false; reply: LibraryItemReply }

interface LockedInput {
  kind: ContentDir
  id: string
  path: string
  patch: FieldPatch
  body: string | undefined
  expected: FileExpectation
}

/**
 * Read → CAS → patch → CAS again → write, all inside the project write lock.
 *
 * Both baselines are checked before a single byte is written (§5.5), so a
 * refusal leaves the file byte-identical; the second check catches the author's
 * own editor, which takes no lock.
 *
 * Coverage note: only the first comparison has a failing test (removing it turns the
 * 409 case red). The second one is defensive — reaching it needs a writer that changes
 * the file between the patch and the rename while holding no lock, which no test can
 * stage without a seam just for that. It stays because the cost is one `stat`.
 */
function writeLocked(root: string, input: LockedInput): LockedWrite {
  const absolute = join(root, ...input.path.split('/'))
  let bytes: Buffer
  try {
    bytes = readFileSync(absolute)
  } catch {
    return { ok: false, reply: notFound(input.kind, input.id, 'the file disappeared before the write') }
  }
  let mtimeMs: number
  try {
    mtimeMs = statSync(absolute).mtimeMs
  } catch {
    return { ok: false, reply: notFound(input.kind, input.id, 'the file disappeared before the write') }
  }

  const text = bytes.toString('utf8')
  // ADR-0007 C4: a `mode: reference` card points at the shared library's原文 and
  // holds no body, so the book is no longer self-contained for that entry. Letting
  // the save path write it would silently turn a reference into a second copy that
  // still claims to be a reference — so the refusal is here, on the one path that
  // could do it, and it happens before anything is patched.
  const parsedText = parseMarkdown(text)
  if (stringField(parsedText.data, 'mode') === SHARED_REFERENCE_MODE) {
    return {
      ok: false,
      reply: refused(409, 'REFERENCE_READONLY', {
        path: input.path,
        nothingWritten: true,
        hint:
          'this card is a reference to a shared library original (ADR-0007 C4): the book does not hold its text. ' +
          'Edit the shared entry, or remove the card and copy the entry as a snapshot (mode: copy)',
      }),
    }
  }
  const baseline = fingerprintBytes(bytes, mtimeMs)
  const drift = compareExpectation(baseline, input.expected)
  if (drift !== undefined) return { ok: false, reply: fileChanged(input.path, drift) }

  const edit = applyEdit(text, input.patch, input.body)
  if (normalize(edit.text) === normalize(text)) {
    // Nothing to write: report the same baseline instead of touching mtime (a
    // save that changes nothing must not appear as a change in git).
    const parsed = parseMarkdown(text)
    return {
      ok: true,
      value: {
        changed: [],
        replacedKeys: [],
        appendedKeys: [],
        removedKeys: [],
        replaced: false,
        fingerprint: baseline,
        hasFrontmatter: parsed.hasFrontmatter,
        frontmatter: parsed.data,
        body: parsed.body,
        path: input.path,
      },
    }
  }

  const moved = compareExpectation(fingerprintProjectFile(root, input.path), baseline)
  if (moved !== undefined) {
    return { ok: false, reply: fileChanged(input.path, moved) }
  }

  const written = writeTextAtomic(root, input.path, edit.text)
  if (!written.ok) return { ok: false, reply: ioRefusal(written.error) }

  const parsed = parseMarkdown(edit.text)
  return {
    ok: true,
    value: {
      changed: edit.changed,
      replacedKeys: edit.replacedKeys,
      appendedKeys: edit.appendedKeys,
      removedKeys: edit.removedKeys,
      replaced: true,
      fingerprint: fingerprintProjectFile(root, input.path) ?? baseline,
      hasFrontmatter: parsed.hasFrontmatter,
      frontmatter: parsed.data,
      body: parsed.body,
      path: input.path,
    },
  }
}

/** The index degradation fields, spelled exactly like `library-view.ts`'s. */
function indexDegradation(ensured: EnsureIndexResult): JsonRecord {
  if (ensured.ok) return { indexRebuilt: ensured.rebuilt, indexState: ensured.state }
  return {
    indexRebuilt: false,
    indexState: ensured.state,
    indexError: {
      code: ensured.failure.code,
      errno: ensured.failure.errno,
      message: ensured.failure.message,
    },
    indexReasons: ensured.freshness.reasons,
  }
}

/**
 * `POST /inkflow/internal/library/item` — save one entry.
 *
 * Adds nothing to the truth files that the author did not send; rebuilds the
 * derived index afterwards because the file just changed (conventions §4.0's
 * "write then invalidate"). A failed rebuild is reported in the value and never
 * rolls the file back: the file is the truth and the index is a cache.
 */
export async function writeLibraryItem(request: LibraryWriteRequest): Promise<LibraryItemReply> {
  const { source, version, body } = request

  const rawKind = typeof body['kind'] === 'string' ? body['kind'].trim() : ''
  if (rawKind === '') {
    return refused(400, 'KIND_REQUIRED', { param: 'kind', hint: `pass kind=<one of ${LIBRARY_KINDS.join(', ')}>` })
  }
  if (!isLibraryKind(rawKind)) {
    return refused(400, 'KIND_INVALID', { param: 'kind', value: rawKind, allowed: LIBRARY_KINDS })
  }
  const kind = rawKind

  const id = typeof body['id'] === 'string' ? body['id'].trim() : ''
  if (id === '') {
    return refused(400, 'ID_REQUIRED', { param: 'id', hint: 'pass the id of the entry you loaded' })
  }

  const patch = readFrontmatterFields(body['frontmatter'])
  if (!patch.ok) return patch.reply
  const nextBody = readBodyText(body)
  if (!nextBody.ok) return nextBody.reply
  if (patch.value === undefined && nextBody.value === undefined) {
    return refused(400, 'EMPTY_UPDATE', {
      hint: 'send `frontmatter`, `body`, or both: a save with neither would rewrite nothing',
    })
  }
  // `expected` is validated AFTER the target is resolved and its reference mode is
  // decided: a request against a read-only card must answer "this card has no text
  // in this book" rather than "you forgot the baseline" (ADR-0007 C4).
  const resolved = resolveEntityFile(source.root, kind, id)
  if (!resolved.ok) return resolved.reply

  const readOnly = referenceCardReply(source.root, resolved.path)
  if (readOnly !== undefined) return readOnly

  const expected = readExpectation(body)
  if (!expected.ok) return expected.reply

  const locked = withProjectWriteLock(source.root, (lock) =>
    writeLocked(lock.root, {
      kind,
      id,
      path: resolved.path,
      patch: patch.value ?? { entries: {}, remove: [] },
      body: nextBody.value,
      expected: expected.value,
    }),
  )
  if (!locked.ok) return ioRefusal(locked.error)
  if (!locked.value.ok) return locked.value.reply
  const outcome = locked.value.value

  const ensured = await ensureIndex(source.root, { rebuild: true })
  return {
    status: 200,
    body: ok({
      pluginVersion: version,
      sessionId: source.sessionId,
      root: source.root,
      kind,
      id,
      path: outcome.path,
      replaced: outcome.replaced,
      changed: outcome.changed,
      replacedKeys: outcome.replacedKeys,
      appendedKeys: outcome.appendedKeys,
      removedKeys: outcome.removedKeys,
      hasFrontmatter: outcome.hasFrontmatter,
      frontmatter: outcome.frontmatter,
      body: outcome.body,
      bodyChars: countChars(outcome.body),
      // The baseline for the NEXT save, exactly like `/chapters/:id` answers it.
      fingerprint: outcome.fingerprint,
      ...indexDegradation(ensured),
    }),
  }
}
