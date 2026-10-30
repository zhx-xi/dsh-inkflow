/**
 * The book side of the copy mapping: which book this is (`inkflow.json`'s
 * `projectId` / `seriesId`), where a shared entry lands inside it, and what
 * evidence the written file carries (`origin`).
 *
 * WHY IT IS A FILE: the copy module grew to hold both "what a copy means" (the
 * operations) and "how the book records it" (this file), and a reader asking the
 * second question had to page past three operations to find it. The series sync
 * also imports the recording half (`sharedDestinationOf`, `applyOriginBlock`)
 * without ever performing a copy, so the recording half is the reusable one.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { ROOT_META_FILE, SHARED_COPY_MODE, SHARED_ORIGIN_KEY, SHARED_REFERENCE_MODE } from './conventions.js'
import type { SharedKind } from './conventions.js'
import { parseMarkdown, splitFrontmatter } from './frontmatter.js'
import type { SharedEntry } from './hub-shared.js'
import type {
  EnsureProjectIdValue,
  SharedCopyError,
  SharedCopyMode,
  SharedOriginCopy,
  SharedOriginReference,
  SharedResult,
} from './shared-copy-types.js'

// ---------------------------------------------------------------------------
// Small readers every half of the copy direction uses
// ---------------------------------------------------------------------------

export function fail(code: string, message: string, extra: Partial<SharedCopyError> = {}): { ok: false; error: SharedCopyError } {
  return { ok: false, error: { code, message, ...extra } }
}

export function readText(absolute: string): string | undefined {
  try {
    // A BOM is common in files edited on Windows; every reader here strips it (H11).
    return readFileSync(absolute, 'utf8').replace(/^\uFEFF/u, '')
  } catch {
    return undefined
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

export function isDirectory(path: string): boolean {
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

export function readMetaRecord(root: string): MetaRead | undefined {
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
export function writeMetaRecord(root: string, record: Record<string, unknown>): SharedResult<{ path: string }> {
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
export function kindOfProjectFile(file: string): SharedKind {
  if (file.startsWith('world/')) return 'world'
  if (file.startsWith('library/snippets/')) return 'snippets'
  return 'library'
}

/**
 * Where a shared entry lands inside a book — exported for the series sync.
 *
 * One function, so "which book path does this entry become" has exactly one answer: a
 * copy and a series sync that disagreed about it would write the same entry to two
 * places, or collide with a file the other one already owns.
 */
export function sharedDestinationOf(entry: SharedEntry): string | undefined {
  return destinationFor(entry)
}

// ---------------------------------------------------------------------------
// `origin`: reading and writing the block
// ---------------------------------------------------------------------------

export function originLines(origin: SharedOriginCopy | SharedOriginReference): string[] {
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

export interface ReadOrigin {
  mode: SharedCopyMode
  entryId: string | null
  projectId: string | null
  contentHash?: string
  sha256?: string
}

/** The `origin` a copy carries, or `undefined` for a file that was not copied. */
export function readOrigin(text: string): ReadOrigin | undefined {
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
