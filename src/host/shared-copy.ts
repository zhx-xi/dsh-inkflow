/**
 * Taking shared entries INTO a book: copy snapshot, `origin` provenance,
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
 *
 * WHERE THE PIECES LIVE: the wire shapes are `shared-copy-types.ts`, the
 * book-side recording (identity, destination, `origin` block) is
 * `shared-copy-provenance.ts`, the read-only stale list is
 * `shared-copy-list.ts`, and this file keeps the two write operations — copy and
 * update. Every public name is re-exported below, so no caller address moved.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
import { fingerprintProjectFile } from './file-cas.js'
import { frontmatterLine, frontmatterListItem, parseMarkdown } from './frontmatter.js'
import { scanSharedLibrary } from './hub-shared.js'
import type { SharedEntry } from './hub-shared.js'
import { removeProjectFile, writeTextAtomic } from './io.js'
import { sharedRootOf } from './settings.js'
import { buildSharedCopies } from './shared-copy-list.js'
import {
  applyOriginBlock,
  asRecord,
  ensureProjectId,
  fail,
  nonEmptyString,
  originLines,
  readMetaRecord,
  readText,
  sharedDestinationOf,
  writeMetaRecord,
} from './shared-copy-provenance.js'
import type {
  SharedCopyInput,
  SharedCopyMode,
  SharedCopyValue,
  SharedOriginCopy,
  SharedOriginReference,
  SharedResult,
  SharedUpdateInput,
  SharedUpdateValue,
} from './shared-copy-types.js'

// ---------------------------------------------------------------------------
// Small helpers only a write operation needs
// ---------------------------------------------------------------------------

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
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

  const destination = sharedDestinationOf(entry)
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

// ---------------------------------------------------------------------------
// The public surface, at its original address
// ---------------------------------------------------------------------------

export { buildSharedCopies } from './shared-copy-list.js'
export { applyOriginBlock, ensureProjectId, sharedDestinationOf } from './shared-copy-provenance.js'
export { SHARED_COPY_MAX_ROWS } from './shared-copy-types.js'

export type {
  EnsureProjectIdValue,
  SharedCopiesValue,
  SharedCopyError,
  SharedCopyInput,
  SharedCopyMode,
  SharedCopyRow,
  SharedCopyValue,
  SharedOriginCopy,
  SharedOriginReference,
  SharedResult,
  SharedUpdateInput,
  SharedUpdateValue,
} from './shared-copy-types.js'
