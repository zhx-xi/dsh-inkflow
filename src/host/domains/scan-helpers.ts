/**
 * Reading helpers shared by domain modules.
 *
 * These used to live inside `indexer.ts`, where every directory's parser sat in one
 * function. They are layout facts about paths and text, not about any one domain, so
 * they live here and each domain stays readable.
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

/** Read a file as UTF-8; an unreadable file reads as empty (the walk already skipped bad ones). */
export function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** `0001-开篇.md` → 1; used as the chapter sequence when frontmatter omits `seq`. */
export function leadingNumber(file: string): number | undefined {
  const match = /^(\d+)/.exec(basename(file))
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/**
 * `world/<category>/<slug>.md` → `<category>`; a file directly in `world/` has none.
 *
 * Taking "the parent directory name" blindly gave every root entry
 * `category: "world"` — the container itself, not a category — which also hid the
 * "a child entry must carry a category" check (found by the #8 parity fixture).
 */
export function worldCategoryOf(relPath: string): string | undefined {
  const parts = relPath.split('/')
  if (parts.length !== 3 || parts[0] !== 'world') return undefined
  const category = parts[1]
  return category === undefined || category === '' ? undefined : category
}

/**
 * `chapters/vol-01/0001-a.md` → `vol-01`; a chapter directly in `chapters/` has no
 * volume. Blindly taking the parent directory gave every top-level chapter
 * `volume: "chapters"`, which is the container, not a volume (issue #7).
 */
export function volumeDirOf(relPath: string): string | undefined {
  const parts = relPath.split('/')
  if (parts.length !== 3 || parts[0] !== 'chapters') return undefined
  const volume = parts[1]
  return volume === undefined || volume === '' ? undefined : volume
}

/** Best-effort outline kind from the file name (`overall*`, `vol-*`/`volume-*`, `ch-*`/`chapter-*`). */
export function inferOutlineKind(relPath: string): string | undefined {
  const name = basename(relPath).replace(/\.[^.]*$/u, '').toLowerCase()
  if (name === 'overall' || name.startsWith('overall')) return 'overall'
  if (name.startsWith('vol-') || name.startsWith('volume-')) return 'volume'
  if (name.startsWith('ch-') || name.startsWith('chapter-')) return 'chapter'
  return undefined
}

/** Characters with whitespace collapsed — the word count the chapter table stores. */
export function countChars(text: string): number {
  return [...text.replace(/\s+/gu, '')].length
}

/**
 * Join a list for a single text column (`entities.aliases` / `entities.keywords`).
 *
 * Space-joined rather than JSON: the same value feeds `entities_fts`, and FTS5
 * cannot tokenise a JSON array. Chinese names and keywords do not contain spaces;
 * a value that does is stored with its inner spaces collapsed, which is acceptable
 * because these columns exist for matching and display, not as the source of truth.
 */
export function joinTerms(values: readonly string[] | undefined): string | undefined {
  const terms = (values ?? []).map((value) => value.trim()).filter((value) => value !== '')
  return terms.length === 0 ? undefined : terms.join(' ')
}

/** Inverse of {@link joinTerms}; never throws on an empty/undefined column. */
export function splitTerms(value: string | undefined): string[] {
  return (value ?? '').split(' ').filter((term) => term !== '')
}

/** Read `aliases` from frontmatter: a string, or a list of strings. */
export function aliasesOf(data: Readonly<Record<string, unknown>>): string[] {
  const raw = data['aliases'] ?? data['alias']
  if (typeof raw === 'string') return raw.split(/[,，、]/u).map((value) => value.trim()).filter((value) => value !== '')
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter((value) => value !== '')
  }
  return []
}

/** Read `keywords` from frontmatter: a string, or a list of strings. */
export function keywordsOf(data: Readonly<Record<string, unknown>>): string[] {
  const raw = data['keywords'] ?? data['keyword']
  if (typeof raw === 'string') return raw.split(/[,，、]/u).map((value) => value.trim()).filter((value) => value !== '')
  if (Array.isArray(raw)) {
    return raw.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter((value) => value !== '')
  }
  return []
}

/** The rows a scan carries for one table, typed at the call site. */
export function rowsOf<T>(scan: { tables: readonly { table: string; rows: readonly unknown[] }[] }, table: string): T[] {
  const bucket = scan.tables.find((candidate) => candidate.table === table)
  return (bucket?.rows ?? []) as unknown as T[]
}
