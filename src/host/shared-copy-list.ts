/**
 * The read-only side of the copy direction: what this book holds from the shared
 * library, and how fresh each copy is.
 *
 * WHY IT IS A FILE: this is the only answer to "which entries did I take", and it
 * writes nothing — not the book, not `shared/index.json`. The update path reuses
 * it as its address lookup, which is exactly why it is a module rather than a
 * helper inside a write operation: a stale list and a refresh must agree on what
 * "this copy" means, and they cannot drift if one function says it.
 */

import { closeSync, openSync, readdirSync, readSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

import { SHARED_ORIGIN_KEY, SHARED_REFERENCE_MODE } from './conventions.js'
import type { SharedKind } from './conventions.js'
import { scanSharedLibrary } from './hub-shared.js'
import type { SharedEntry } from './hub-shared.js'
import { sharedRootOf } from './settings.js'
import {
  asRecord,
  fail,
  kindOfProjectFile,
  nonEmptyString,
  readMetaRecord,
  readOrigin,
  readText,
} from './shared-copy-provenance.js'
import type { ReadOrigin } from './shared-copy-provenance.js'
import { SHARED_COPY_MAX_ROWS } from './shared-copy-types.js'
import type { SharedCopiesValue, SharedCopyRow, SharedResult } from './shared-copy-types.js'

/** Bytes read from a copy's head to find `origin` (frontmatter lives in 4 KiB). */
const COPY_HEAD_BYTES = 4096

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
