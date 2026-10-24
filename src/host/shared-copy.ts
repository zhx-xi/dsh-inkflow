/**
 * Taking shared entries INTO a book (#40): copy snapshot, `origin` provenance,
 * stale detection and the explicit per-entry update (ADR-0007 C2–C6).
 *
 * WHY A MODULE OF ITS OWN. `hub-shared.ts` is the read-only projection of
 * `dataDir/shared` and says in its header that it writes nothing — that stays
 * true. This file is the other direction: it reads the shared library, writes
 * into a **book**, and it is the only place that knows the mapping between the
 * two sides.
 *
 * FOUR RULES THAT SHAPE EVERY FUNCTION HERE (all from ADR-0007):
 *
 *   1. **A copy is a snapshot, not a pointer** (C2/C3). The destination file is
 *      the shared bytes plus an `origin` block recording
 *      `{projectId, entryId, contentHash}` as of the copy. Nothing here rewrites
 *      a copy because the source moved: `contentHash` ≠ the source hash right now
 *      means the row is **stale**, and stale is a *report*. Only
 *      `updateSharedEntry` — a caller-confirmed, backed-up action — writes.
 *   2. **The book stays self-contained** (C4). `reference` is allowed for
 *      `library/` only; the card holds no body, records the source `sha256`, and
 *      every write to it is refused with `REFERENCE_READONLY` (the enforcement
 *      sits in `library-write.ts`, the save path that would rewrite it).
 *      `world/` / `snippets/` / `series/` refusing reference is the point: a book
 *      whose setting lives elsewhere is not a book that can be taken away.
 *   3. **Writes go through the doors every other writer uses**: `io.ts` for
 *      content files (validated relative path, atomic replace, project write
 *      lock), `backup.ts` for the update's undo package, and — for the two
 *      root-level fields this feature needs (`projectId`, `seriesId`) — the
 *      direct `inkflow.json` write the wizard and the migrator already use,
 *      because root metadata is outside `resolveWriteTarget`'s whitelist.
 *   4. **A refusal writes nothing.** A conflict is checked for every planned file
 *      before the first byte, and it is `SHARED_COPY_CONFLICT` — never "overwrite
 *      the author's file because the library is newer".
 *
 * WHAT IT DELIBERATELY DOES NOT DO: nothing writes to the shared library (no
 * "push", and no `index.json` write-back — the manifest is derived), no
 * bidirectional sync, no automatic update, and no `origin` sidecar for a binary
 * original (the card's `origin` covers the pair — ADR-0007 C3).
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { closeSync, openSync, readSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'

import { newBackupBody, openBackup, sealBackup, stageFile } from './backup.js'
import type { BackupBody, BackupHandle } from './backup.js'
import {
  ROOT_META_FILE,
  SHARED_COPY_MODE,
  SHARED_ENTRY_ID_PREFIX,
  SHARED_ORIGIN_KEY,
  SHARED_REFERENCE_MODE,
  SHARED_SERIES_ID_PREFIX,
} from './conventions.js'
import type { SharedKind } from './conventions.js'
import { fingerprintProjectFile } from './file-cas.js'
import { frontmatterLine, frontmatterListItem, parseMarkdown, splitFrontmatter } from './frontmatter.js'
import { scanSharedLibrary } from './hub-shared.js'
import type { SharedEntry } from './hub-shared.js'
import { writeTextAtomic, removeProjectFile } from './io.js'
import { sharedRootOf } from './settings.js'

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** `origin` on a copy: evidence of WHICH version was copied (ADR-0007 C3). */
export interface SharedOriginCopy {
  projectId: string | null
  entryId: string
  contentHash: string
}

/** `origin` on a reference card: the source hash, and no copy hash (C4). */
export interface SharedOriginReference {
  projectId: string | null
  entryId: string
  sha256: string
}

export type SharedCopyMode = typeof SHARED_COPY_MODE | typeof SHARED_REFERENCE_MODE

export interface SharedCopyError {
  code: string
  message: string
  hint?: string
  path?: string
}

export type SharedResult<T> = { ok: true; value: T } | { ok: false; error: SharedCopyError }

export interface SharedCopyInput {
  /** The plugin data directory; `shared/` under it is the source library. */
  dataDir: string
  /** The book to copy INTO (already past the gate: this module never gates). */
  root: string
  entryId: string
  mode?: SharedCopyMode
  confirm?: boolean
}

export interface SharedCopyValue {
  root: string
  entryId: string
  kind: SharedKind
  mode: SharedCopyMode
  /** Project-relative files this call created (empty for a series link). */
  files: string[]
  origin?: SharedOriginCopy | SharedOriginReference
  /** `true` when this call added `projectId` to `inkflow.json`. */
  projectIdCreated: boolean
  projectId: string | null
  /** Present for a series entry: the `inkflow.json.seriesId` it set. */
  seriesId?: string
  /** Things the user should know but that are not failures. */
  warnings: string[]
}

export interface SharedUpdateInput {
  dataDir: string
  root: string
  /** Address the copy by its shared entry id… */
  entryId?: string
  /** …or by the project file it lives at (which is what the panel shows). */
  file?: string
  confirm?: boolean
}

export interface SharedUpdateValue {
  root: string
  updated: string[]
  unchanged: string[]
  /** Absent when nothing was written: a no-op leaves no package behind. */
  backupDir?: string
  origin?: SharedOriginCopy
}

/** What the "only the differences" view prints per copy (ADR-0007 V3). */
export interface SharedCopyRow {
  file: string
  kind: SharedKind
  /** `null` for a file whose `origin` block carries no id (hand-edited). */
  entryId: string | null
  mode: SharedCopyMode
  /** The hash recorded in `origin` at copy time. */
  contentHash?: string
  /** The shared entry's hash right now; absent when the source is gone. */
  currentHash?: string
  state: 'current' | 'stale' | 'missing-source'
}

export interface SharedCopiesValue {
  root: string
  projectId: string | null
  seriesId: string | null
  seriesFound: boolean
  /** `false` when at least one copy is a reference (ADR-0007 C4). */
  selfContained: boolean
  entries: SharedCopyRow[]
  /** The reference cards by path, so a caller can name them without filtering. */
  references: string[]
  counts: { total: number; current: number; stale: number; missing: number }
  /** True when the walk hit its cap: the list is short, not complete. */
  truncated: boolean
}

export interface EnsureProjectIdValue {
  /** `null` when `inkflow.json` cannot be read or parsed: `origin.projectId` is then `null`. */
  projectId: string | null
  /** `true` only when THIS call wrote the field. */
  created: boolean
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Copies considered in one status answer; beyond this the list says `truncated`. */
export const SHARED_COPY_MAX_ROWS = 500

/** Bytes read from a copy's head to find `origin` (frontmatter lives in 4 KiB). */
const COPY_HEAD_BYTES = 4096

function fail(code: string, message: string, extra: Partial<SharedCopyError> = {}): { ok: false; error: SharedCopyError } {
  return { ok: false, error: { code, message, ...extra } }
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function readText(absolute: string): string | undefined {
  try {
    // A BOM is common in files edited on Windows; every reader here strips it (H11).
    return readFileSync(absolute, 'utf8').replace(/^\uFEFF/u, '')
  } catch {
    return undefined
  }
}

/** The first `bytes` of a file, for a cheap "does it carry an origin block" test. */
function readHead(absolute: string, bytes: number): string {
  let fd: number | undefined
  try {
    fd = openSync(absolute, 'r')
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('utf8').replace(/^\uFEFF/u, '')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// `inkflow.json`: projectId (ADR-0007 C3 / ADR-0018 D7) and seriesId (C5)
// ---------------------------------------------------------------------------

interface MetaRead {
  record: Record<string, unknown>
}

function readMetaRecord(root: string): MetaRead | undefined {
  const text = readText(join(root, ROOT_META_FILE))
  if (text === undefined) return undefined
  try {
    const record = asRecord(JSON.parse(text))
    return record === undefined ? undefined : { record }
  } catch {
    return undefined
  }
}

/**
 * Rewrite `inkflow.json` with the fields `mutate` changed — the one root file
 * this feature writes, and only for `projectId` / `seriesId`.
 *
 * Root metadata is outside `resolveWriteTarget` (only the scaffolding path writes
 * it — ADR-0006 D3), so this is the same direct write `workspace.ts` and
 * `hub-wizard.ts` already do. The parsed object is merged, so every other key the
 * author has survives; a file that cannot be parsed is never "repaired" here.
 */
function writeMetaRecord(root: string, record: Record<string, unknown>): SharedResult<{ path: string }> {
  try {
    writeFileSync(join(root, ROOT_META_FILE), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  } catch (cause) {
    return fail('META_WRITE_FAILED', `${ROOT_META_FILE} could not be written: ${String(cause)}`, { path: ROOT_META_FILE })
  }
  return { ok: true, value: { path: ROOT_META_FILE } }
}

/**
 * Give the book a `projectId` the first time something needs it.
 *
 * The wizard writes it for a new book (`workspace.ts`); this covers books that
 * already existed — which is why the ADR makes the field optional and keeps it
 * out of the gate: a book without one is still a book, and a copy from it simply
 * records `origin.projectId: null`. A second call is a no-op, and an existing
 * value is never replaced.
 */
export function ensureProjectId(root: string): SharedResult<EnsureProjectIdValue> {
  const meta = readMetaRecord(resolve(root))
  if (meta === undefined) return { ok: true, value: { projectId: null, created: false } }
  const existing = nonEmptyString(meta.record['projectId'])
  if (existing !== undefined) return { ok: true, value: { projectId: existing, created: false } }

  const projectId = randomUUID()
  const written = writeMetaRecord(resolve(root), { ...meta.record, projectId })
  if (!written.ok) return written
  return { ok: true, value: { projectId, created: true } }
}

// ---------------------------------------------------------------------------
// The two sides of the mapping (ADR-0007 C1/C2)
// ---------------------------------------------------------------------------

/**
 * Where a shared entry lands in the book.
 *
 * `world/` keeps its own sub-path so a shared tree copies 1:1; `snippets/` lands
 * under `library/snippets/` because `library/` is the "material" domain and the
 * book contract has exactly nine content directories (no tenth); a
 * `series/*.json` never lands as a file at all (C2/C5).
 */
function destinationFor(entry: SharedEntry): string | undefined {
  if (entry.kind === 'world') return entry.path.startsWith('world/') ? entry.path : undefined
  if (entry.kind === 'library') return entry.path.startsWith('library/') ? entry.path : undefined
  if (entry.kind === 'snippets') {
    const name = entry.path.slice('snippets/'.length)
    if (name === '' || name.split('/').includes('..')) return undefined
    return `library/snippets/${name}`
  }
  return undefined
}

/** Which kind a project file came from, from its path alone (no index involved). */
function kindOfProjectFile(file: string): SharedKind {
  if (file.startsWith('world/')) return 'world'
  if (file.startsWith('library/snippets/')) return 'snippets'
  return 'library'
}

// ---------------------------------------------------------------------------
// `origin`: reading and writing the block
// ---------------------------------------------------------------------------

function originLines(origin: SharedOriginCopy | SharedOriginReference): string[] {
  const lines = [
    `${SHARED_ORIGIN_KEY}:`,
    `  projectId: ${origin.projectId === null ? 'null' : origin.projectId}`,
    `  entryId: ${origin.entryId}`,
  ]
  if ('contentHash' in origin) lines.push(`  contentHash: ${origin.contentHash}`)
  else lines.push(`  sha256: ${origin.sha256}`)
  return lines
}

/**
 * Put the `origin` block into a document, keeping every other byte.
 *
 * An existing block (a refresh) is REPLACED rather than appended: two `origin:`
 * keys would make the reader's answer depend on line order. Line endings follow
 * the file; a document with no frontmatter gets one, and `writeTextAtomic` then
 * normalises the new file to LF/no-BOM like every other file this plugin writes.
 */
export function applyOriginBlock(text: string, origin: SharedOriginCopy | SharedOriginReference): string {
  const lines = originLines(origin)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const parts = splitFrontmatter(text)
  if (!parts.hasFrontmatter) return ['---', ...lines, '---', '', text].join(eol)

  const headLines = parts.head.split(/\r?\n/u)
  let closeIndex = -1
  for (let index = headLines.length - 1; index >= 1; index -= 1) {
    if ((headLines[index] ?? '').trim() === '---') {
      closeIndex = index
      break
    }
  }
  if (closeIndex < 0) return text

  const originAt = headLines.findIndex(
    (line, index) => index > 0 && index < closeIndex && new RegExp(`^${SHARED_ORIGIN_KEY}:`, 'u').test(line),
  )
  if (originAt < 0) {
    headLines.splice(closeIndex, 0, ...lines)
  } else {
    let end = originAt + 1
    while (end < closeIndex && /^\s+\S/u.test(headLines[end] ?? '')) end += 1
    headLines.splice(originAt, end - originAt, ...lines)
  }
  return `${headLines.join(eol)}${parts.body}`
}

interface ReadOrigin {
  mode: SharedCopyMode
  entryId: string | null
  projectId: string | null
  contentHash?: string
  sha256?: string
}

/** The `origin` a copy carries, or `undefined` for a file that was not copied. */
function readOrigin(text: string): ReadOrigin | undefined {
  const parsed = parseMarkdown(text)
  const record = asRecord(parsed.data[SHARED_ORIGIN_KEY])
  if (record === undefined) return undefined
  const contentHash = nonEmptyString(record['contentHash'])
  const sha256 = nonEmptyString(record['sha256'])
  const mode: SharedCopyMode =
    nonEmptyString(parsed.data['mode']) === SHARED_REFERENCE_MODE ? SHARED_REFERENCE_MODE : SHARED_COPY_MODE
  return {
    mode,
    entryId: nonEmptyString(record['entryId']) ?? null,
    projectId: nonEmptyString(record['projectId']) ?? null,
    ...(contentHash === undefined ? {} : { contentHash }),
    ...(sha256 === undefined ? {} : { sha256 }),
  }
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * Copy one shared entry into the book (ADR-0007 C2).
 *
 * The order is the contract: confirm → resolve the entry → refuse a bad mode →
 * map the destination → refuse a conflict for EVERY planned file → read the
 * source bytes → ensure `projectId` → write. A series entry short-circuits after
 * the mode checks because it writes no file at all.
 */
export function copySharedEntry(input: SharedCopyInput): SharedResult<SharedCopyValue> {
  const root = resolve(input.root)
  const mode: SharedCopyMode = input.mode === SHARED_REFERENCE_MODE ? SHARED_REFERENCE_MODE : SHARED_COPY_MODE
  if (input.confirm !== true) {
    return fail('CONFIRM_REQUIRED', 'copying writes files into the book', {
      hint: 'show the source entry and its destination to the user, then call again with confirm: true',
    })
  }

  const sharedRoot = sharedRootOf(input.dataDir).root
  const library = scanSharedLibrary(sharedRoot)
  if (!library.ok) return fail('SHARED_UNAVAILABLE', library.error.message, { hint: library.error.hint })

  const entryId = (input.entryId ?? '').trim()
  const matches = library.entries.filter((entry) => entry.entryId === entryId)
  if (matches.length === 0) {
    return fail('SHARED_ENTRY_NOT_FOUND', `no shared entry with id "${entryId}"`, {
      hint: `list the library first (inkflow_shared_list); ids look like ${SHARED_ENTRY_ID_PREFIX}xxxxxxxx`,
    })
  }
  if (matches.length > 1) {
    return fail('SHARED_ENTRY_AMBIGUOUS', `${matches.length} shared entries claim the id "${entryId}"`, {
      hint: 'two files carry the same entryId; give each its own id in the shared library, then copy again',
    })
  }
  const entry = matches[0] as SharedEntry

  // C4: settings, snippets and series may not be referenced.
  if (mode === SHARED_REFERENCE_MODE && entry.kind !== 'library') {
    return fail(
      'REFERENCE_NOT_ALLOWED',
      `reference mode is limited to library/ originals; "${entry.path}" is a ${entry.kind} entry`,
      {
        hint: 'copy it instead (mode: copy): world/, snippets/ and series/ entries must live inside the book (ADR-0007 C4)',
        path: entry.path,
      },
    )
  }

  if (entry.kind === 'series') return linkSeries(root, sharedRoot, entry)

  const destination = destinationFor(entry)
  if (destination === undefined) {
    return fail('SHARED_PATH_INVALID', `"${entry.path}" does not map into a book directory`, { path: entry.path })
  }

  const sourceAbsolute = join(sharedRoot, ...entry.path.split('/'))
  let sourceBytes: Buffer
  try {
    sourceBytes = readFileSync(sourceAbsolute)
  } catch (cause) {
    return fail('SHARED_SOURCE_UNREADABLE', `${entry.path} could not be read: ${String(cause)}`, { path: entry.path })
  }
  const text = sourceBytes.toString('utf8')
  if (sha256Hex(Buffer.from(text, 'utf8')) !== sha256Hex(sourceBytes)) {
    return fail('SHARED_SOURCE_NOT_UTF8', `${entry.path} is not valid UTF-8, so a byte-exact Markdown copy cannot be made`, {
      path: entry.path,
      hint: 'the shared entry is left untouched; convert it to UTF-8 first',
    })
  }
  const contentHash = sha256Hex(sourceBytes)

  // Every planned file is checked before the first write: a half copy is worse
  // than a refusal, and the author's file must win over the library's.
  const originals = mode === SHARED_COPY_MODE ? libraryOriginals(sharedRoot, entry) : []
  const plan = [destination, ...originals.map((item) => item.destination)]
  const conflict = plan.find((file) => existsSync(join(root, ...file.split('/'))))
  if (conflict !== undefined) {
    return fail('SHARED_COPY_CONFLICT', `${conflict} already exists in this book`, {
      path: conflict,
      hint: 'nothing was written: a copy never overwrites a file you already have — rename or remove it first',
    })
  }

  const projectId = ensureProjectId(root)
  if (!projectId.ok) return projectId
  const projectIdValue = projectId.value.projectId

  let writeText: string
  let origin: SharedOriginCopy | SharedOriginReference
  if (mode === SHARED_REFERENCE_MODE) {
    const reference: SharedOriginReference = { projectId: projectIdValue, entryId: entry.entryId, sha256: contentHash }
    writeText = referenceCardText(text, reference)
    origin = reference
  } else {
    const snapshot: SharedOriginCopy = { projectId: projectIdValue, entryId: entry.entryId, contentHash }
    writeText = applyOriginBlock(text, snapshot)
    origin = snapshot
  }
  const wrote = writeTextAtomic(root, destination, writeText)
  if (!wrote.ok) return fail(wrote.error.code, wrote.error.message, { path: destination })

  const warnings: string[] = []
  for (const original of originals) {
    const target = join(root, ...original.destination.split('/'))
    try {
      writeFileSync(target, readFileSync(original.source))
      warnings.push(`the library original ${original.destination} was copied next to the card`)
    } catch (cause) {
      // Undo the card so the book never holds half a pair.
      removeProjectFile(root, destination)
      return fail('SHARED_ORIGINAL_COPY_FAILED', `${original.destination} could not be copied: ${String(cause)}`, {
        path: original.destination,
      })
    }
  }

  return {
    ok: true,
    value: {
      root,
      entryId: entry.entryId,
      kind: entry.kind,
      mode,
      files: plan,
      origin,
      projectIdCreated: projectId.value.created,
      projectId: projectId.value.projectId,
      warnings,
    },
  }
}

/**
 * The non-Markdown siblings a library card may hold (`library/<stem>.<ext>`).
 *
 * ADR-0007 C1 allows the shared library to keep its own copy of the original next
 * to the card; copying the card without the text it indexes would leave a dead
 * pointer in the book. They are copied byte-for-byte — the one place here that
 * cannot use `writeTextAtomic`, whose contract is UTF-8 text.
 */
function libraryOriginals(sharedRoot: string, entry: SharedEntry): Array<{ source: string; destination: string }> {
  if (entry.kind !== 'library') return []
  const bare = entry.path.slice('library/'.length)
  if (bare.includes('/')) return []
  const stem = bare.replace(/\.md$/iu, '')
  if (stem === bare) return []
  let names: string[]
  try {
    names = readdirSync(dirname(join(sharedRoot, ...entry.path.split('/'))))
  } catch {
    return []
  }
  return names
    .filter((name) => name !== bare && extname(name).toLowerCase() !== '.md' && name.startsWith(`${stem}.`))
    .sort()
    .map((name) => ({ source: join(sharedRoot, 'library', name), destination: `library/${name}` }))
}

/**
 * A reference card (C4): the source card's metadata, `mode: reference`, an
 * `origin` with the source `sha256`, and **no body**.
 *
 * The body is dropped on purpose: a reference means "the text stays in the
 * shared library", so keeping a copy of the prose would quietly make the card a
 * copy while still claiming to be a reference.
 */
function referenceCardText(sourceText: string, origin: SharedOriginReference): string {
  const parsed = parseMarkdown(sourceText)
  const lines: string[] = []
  for (const [key, value] of Object.entries(parsed.data)) {
    if (key === SHARED_ORIGIN_KEY || key === 'mode') continue
    if (typeof value === 'string' && value.trim() !== '') lines.push(frontmatterLine(key, value))
    else if (Array.isArray(value)) {
      const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      if (items.length > 0) lines.push(`${key}:`, ...items.map(frontmatterListItem))
    }
  }
  lines.push(frontmatterLine('mode', SHARED_REFERENCE_MODE))
  lines.push(...originLines(origin))
  return ['---', ...lines, '---', ''].join('\n')
}

/**
 * A series entry copies NO file: the book only records `inkflow.json.seriesId`
 * (ADR-0007 C2/C5). The grouping itself stays in `shared/series/<slug>.json`, so
 * "one entry may belong to several series" needs no book-side copy.
 */
function linkSeries(root: string, sharedRoot: string, entry: SharedEntry): SharedResult<SharedCopyValue> {
  const meta = readMetaRecord(root)
  if (meta === undefined) {
    return fail('META_UNREADABLE', `${ROOT_META_FILE} cannot be read, so seriesId cannot be recorded`, {
      path: ROOT_META_FILE,
      hint: 'repair or rewrite inkflow.json first (the wizard reports what is wrong with it)',
    })
  }
  const declared = readText(join(sharedRoot, ...entry.path.split('/')))
  if (declared === undefined) {
    return fail('SHARED_SOURCE_UNREADABLE', `${entry.path} could not be read`, { path: entry.path })
  }
  let seriesId: string | undefined
  try {
    seriesId = nonEmptyString(asRecord(JSON.parse(declared))?.['seriesId'])
  } catch {
    seriesId = undefined
  }
  if (seriesId === undefined || !seriesId.startsWith(SHARED_SERIES_ID_PREFIX)) {
    return fail('SHARED_SERIES_INVALID', `${entry.path} does not declare a ${SHARED_SERIES_ID_PREFIX}… seriesId`, {
      path: entry.path,
      hint: 'a series file is {schemaVersion, seriesId, title, description, entryIds, createdAt} (ADR-0007 C5)',
    })
  }

  const projectId = nonEmptyString(meta.record['projectId']) ?? randomUUID()
  const created = nonEmptyString(meta.record['projectId']) === undefined
  if (nonEmptyString(meta.record['seriesId']) !== seriesId || created) {
    const written = writeMetaRecord(root, { ...meta.record, projectId, seriesId })
    if (!written.ok) return written
  }

  return {
    ok: true,
    value: {
      root,
      entryId: entry.entryId,
      kind: 'series',
      mode: SHARED_COPY_MODE,
      files: [],
      projectIdCreated: created,
      projectId,
      seriesId,
      warnings: [`inkflow.json.seriesId is ${seriesId}; the series file itself is not copied (ADR-0007 C5)`],
    },
  }
}

// ---------------------------------------------------------------------------
// The copies in a book: the stale list (reading only)
// ---------------------------------------------------------------------------

interface CollectedCopy {
  file: string
  kind: SharedKind
  origin: ReadOrigin
}

/** Every file under the two copyable content directories, bounded. */
function walkProjectFiles(root: string): { files: string[]; truncated: boolean } {
  const files: string[] = []
  const stack: string[] = ['world', 'library']
  while (stack.length > 0) {
    const relative = stack.pop()
    if (relative === undefined) break
    let dirents
    try {
      dirents = readdirSync(join(root, ...relative.split('/')), { withFileTypes: true })
    } catch {
      continue
    }
    dirents.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    for (const dirent of dirents) {
      if (files.length >= SHARED_COPY_MAX_ROWS) return { files, truncated: true }
      if (dirent.name.startsWith('.')) continue
      const child = `${relative}/${dirent.name}`
      if (dirent.isDirectory()) {
        stack.push(child)
        continue
      }
      if (!dirent.isFile()) continue
      if (extname(dirent.name).toLowerCase() !== '.md') continue
      files.push(child)
    }
  }
  return { files, truncated: false }
}

/** The project files that carry an `origin` block, with that block read. */
function collectCopies(root: string): { copies: CollectedCopy[]; truncated: boolean } {
  const walked = walkProjectFiles(root)
  const copies: CollectedCopy[] = []
  for (const file of walked.files) {
    const head = readHead(join(root, ...file.split('/')), COPY_HEAD_BYTES)
    // Cheap prefilter: a file that does not even mention the key cannot carry it.
    if (!head.includes(`${SHARED_ORIGIN_KEY}:`)) continue
    const origin = readOrigin(head)
    if (origin === undefined) continue
    copies.push({ file, kind: kindOfProjectFile(file), origin })
  }
  return { copies, truncated: walked.truncated }
}

/**
 * What this book holds from the shared library, and how fresh each copy is
 * (ADR-0007 V3 — "only the differences" is this list filtered to `stale`).
 *
 * Read-only: it hashes the shared library, reads the head of each copy and never
 * writes — not even to `shared/index.json`.
 */
export function buildSharedCopies(input: { dataDir: string; root: string }): SharedResult<SharedCopiesValue> {
  const root = resolve(input.root)
  const collected = collectCopies(root)
  const library = scanSharedLibrary(sharedRootOf(input.dataDir).root)
  if (!library.ok) return fail('SHARED_UNAVAILABLE', library.error.message, { hint: library.error.hint })

  const byId = new Map<string, SharedEntry>()
  for (const entry of library.entries) byId.set(entry.entryId, entry)

  const entries: SharedCopyRow[] = []
  const counts = { total: 0, current: 0, stale: 0, missing: 0 }
  let selfContained = true
  for (const copy of collected.copies) {
    const source = copy.origin.entryId === null ? undefined : byId.get(copy.origin.entryId)
    const currentHash = source?.sha256
    const recorded = copy.origin.mode === SHARED_REFERENCE_MODE ? copy.origin.sha256 : copy.origin.contentHash
    const state: SharedCopyRow['state'] =
      currentHash === undefined ? 'missing-source' : recorded === currentHash ? 'current' : 'stale'
    if (copy.origin.mode === SHARED_REFERENCE_MODE) selfContained = false
    counts.total += 1
    if (state === 'current') counts.current += 1
    else if (state === 'stale') counts.stale += 1
    else counts.missing += 1
    entries.push({
      file: copy.file,
      kind: copy.kind,
      entryId: copy.origin.entryId,
      mode: copy.origin.mode,
      ...(recorded === undefined ? {} : { contentHash: recorded }),
      ...(currentHash === undefined ? {} : { currentHash }),
      state,
    })
  }

  const meta = readMetaRecord(root)
  const seriesId = meta === undefined ? null : (nonEmptyString(meta.record['seriesId']) ?? null)
  const seriesFound = seriesId === null ? false : seriesExists(sharedRootOf(input.dataDir).root, seriesId)

  return {
    ok: true,
    value: {
      root,
      projectId: meta === undefined ? null : (nonEmptyString(meta.record['projectId']) ?? null),
      seriesId,
      seriesFound,
      selfContained,
      entries: entries.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0)),
      references: entries.filter((entry) => entry.mode === SHARED_REFERENCE_MODE).map((entry) => entry.file),
      counts,
      truncated: collected.truncated || library.truncated,
    },
  }
}

/** Whether `shared/series/*.json` declares this `seriesId` (V6: reported, never fixed). */
function seriesExists(sharedRoot: string, seriesId: string): boolean {
  let names: string[]
  try {
    names = readdirSync(join(sharedRoot, 'series'))
  } catch {
    return false
  }
  for (const name of names) {
    if (extname(name).toLowerCase() !== '.json') continue
    const text = readText(join(sharedRoot, 'series', name))
    if (text === undefined) continue
    try {
      if (nonEmptyString(asRecord(JSON.parse(text))?.['seriesId']) === seriesId) return true
    } catch {
      // A series file that does not parse simply does not match.
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// The explicit per-entry update (ADR-0007 C3: stale is a report, not a repair)
// ---------------------------------------------------------------------------

/**
 * Refresh ONE copy from the shared library, after the user confirmed it.
 *
 * The package is opened and every covered file staged (and sealed `false`) before
 * the first byte of the update lands, so an interrupted refresh still has its
 * undo on disk (ADR-0012). A copy that is already current is a no-op: no package,
 * no write, and its path is reported in `unchanged`.
 */
export function updateSharedEntry(input: SharedUpdateInput): SharedResult<SharedUpdateValue> {
  const root = resolve(input.root)
  if (input.confirm !== true) {
    return fail('CONFIRM_REQUIRED', 'updating a copy overwrites the file in this book', {
      hint: 'show the difference to the user, then call again with confirm: true (the previous bytes go into .inkflow/backup/)',
    })
  }

  const status = buildSharedCopies({ dataDir: input.dataDir, root })
  if (!status.ok) return status
  const wantedFile = (input.file ?? '').replaceAll('\\', '/').replace(/^\.\//u, '')
  const wantedId = (input.entryId ?? '').trim()
  if (wantedFile === '' && wantedId === '') {
    return fail('SHARED_COPY_NOT_FOUND', 'address the copy with `entryId` or `file`', {
      hint: 'inkflow_shared_list returns both for every copy in this book',
    })
  }
  const row = status.value.entries.find((entry) =>
    wantedFile !== '' ? entry.file === wantedFile : entry.entryId === wantedId,
  )
  if (row === undefined) {
    return fail('SHARED_COPY_NOT_FOUND', `this book holds no copy for ${wantedFile !== '' ? wantedFile : wantedId}`, {
      hint: 'copy it first (inkflow_shared_copy): an update only refreshes a copy that already exists',
    })
  }
  if (row.mode === SHARED_REFERENCE_MODE) {
    return fail('REFERENCE_READONLY', `${row.file} is a reference card, so it has no local snapshot to update`, {
      path: row.file,
      hint: 'a reference never holds content; remove the card and copy the entry as a snapshot (mode: copy) if the book must be self-contained',
    })
  }
  if (row.state === 'missing-source') {
    return fail('SHARED_SOURCE_MISSING', `the shared entry ${String(row.entryId)} no longer exists`, {
      path: row.file,
      hint: 'the copy is a normal file now: keep editing it, or delete it and copy a new entry instead',
    })
  }
  if (row.state === 'current') {
    return { ok: true, value: { root, updated: [], unchanged: [row.file] } }
  }
  if (row.entryId === null) {
    return fail('SHARED_COPY_INVALID', `${row.file} records no entryId, so its source cannot be named`, { path: row.file })
  }

  const library = scanSharedLibrary(sharedRootOf(input.dataDir).root)
  if (!library.ok) return fail('SHARED_UNAVAILABLE', library.error.message, { hint: library.error.hint })
  const source = library.entries.find((entry) => entry.entryId === row.entryId)
  if (source === undefined || source.sha256 === undefined) {
    return fail('SHARED_SOURCE_MISSING', `the shared entry ${row.entryId} no longer exists`, { path: row.file })
  }
  const sourceBytes = readFileSync(join(sharedRootOf(input.dataDir).root, ...source.path.split('/')))
  const text = sourceBytes.toString('utf8')
  if (sha256Hex(Buffer.from(text, 'utf8')) !== sha256Hex(sourceBytes)) {
    return fail('SHARED_SOURCE_NOT_UTF8', `${source.path} is not valid UTF-8, so the copy cannot be refreshed`, {
      path: source.path,
    })
  }

  const projectId = ensureProjectId(root)
  if (!projectId.ok) return projectId
  const origin: SharedOriginCopy = {
    projectId: projectId.value.projectId,
    entryId: source.entryId,
    contentHash: sha256Hex(sourceBytes),
  }

  const opened = openBackup(root, 'shared')
  if (!opened.ok) return fail(opened.error.code, opened.error.message, { path: row.file })
  const handle: BackupHandle = opened.value
  const body: BackupBody = newBackupBody()
  const staged = stageFile(root, handle, row.file)
  if (!staged.ok) return fail(staged.error.code, staged.error.message, { path: row.file })
  body.files.push({
    path: row.file,
    change: 'modified',
    ...(staged.value === undefined ? {} : { before: staged.value }),
  })
  // The journal is written `sealed: false` BEFORE the first byte, so a crash
  // mid-update still leaves a readable package with the previous bytes (ADR-0012).
  const journal = sealBackup(root, handle, 'shared', body, false)
  if (!journal.ok) return fail(journal.error.code, journal.error.message, { path: row.file })

  // A refresh REPLACES the copy with the source text: that is what "update the
  // snapshot" means, and it is also why this action is explicit and backed up —
  // local edits to the copy are the thing being discarded.
  const wrote = writeTextAtomic(root, row.file, applyOriginBlock(text, origin))
  if (!wrote.ok) return fail(wrote.error.code, wrote.error.message, { path: row.file })

  const after = fingerprintProjectFile(root, row.file)
  if (body.files[0] !== undefined && after !== undefined) {
    body.files[0].after = { bytes: after.size, sha256: after.sha256 }
  }
  body.steps.push(`update ${row.file} from ${source.entryId}`)
  const sealed = sealBackup(root, handle, 'shared', body, true)
  if (!sealed.ok) return fail(sealed.error.code, sealed.error.message, { path: row.file })

  return { ok: true, value: { root, updated: [row.file], unchanged: [], backupDir: handle.dir, origin } }
}
