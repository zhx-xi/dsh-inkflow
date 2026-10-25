/**
 * Data sources for the injected writing context.
 *
 * Everything here is **synchronous** and **failure-tolerant**: the callers run
 * inside a prompt provider, where a rejection cannot be handled and an await is
 * not available. A missing file, a corrupt index or an unreadable world-book
 * entry therefore degrades to "this fact is absent" — never to a throw.
 *
 * Two decisions worth knowing before editing:
 *
 *   - **The index is preferred, the files are the fallback.** The derived index
 *     knows explicit `seq` frontmatter (conventions §3.2) and gives the counts
 *     for the project summary in one query; the filename walk keeps the current
 *     chapter and the previous tail alive on a fresh clone whose index has not
 *     been built yet. Neither path rebuilds anything: rebuilding is async and
 *     belongs to the tools.
 *   - **World-book entries are read by head, not body.** Matching needs only the
 *     frontmatter (`keywords` / `always` / `priority`) and the first paragraph,
 *     so each file contributes at most `WORLD_HEAD_BYTES` — a 400-entry world
 *     book stays cheap on every model step.
 */

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { INDEX_DB_FILE, INDEX_DIR, INDEX_SCHEMA_VERSION } from './conventions.js'
import { intField, parseMarkdown, stringArrayField, stringField } from './frontmatter.js'
// The chapter map the other read routes resolve through: one definition of "which
// chapter does this id mean" and one definition of reading order (`comparePosition`).
import { chapterPositions } from './domains/foreshadowing-query.js'
import { comparePosition } from './domains/foreshadowing-plan.js'
import type { ChapterPosition } from './domains/foreshadowing-plan.js'

/** At most this many world-book entries are rendered; the rest are counted. */
export const MAX_WORLD_SHOWN = 4
/** Characters of a world-book entry's body kept as its excerpt. */
const WORLD_BODY_CHARS = 200
/** Head size read per world-book file: frontmatter (≤4 KiB) + first body line. */
const WORLD_HEAD_BYTES = 8192
const MAX_WALK_DEPTH = 6
const SNIPPET_ELLIPSIS = '…'

export interface ProjectStats {
  chapters: number
  volumes: number
  words: number
}

export interface ChapterHead {
  path: string
  /**
   * The chapter's stable id (frontmatter `id`, else the id the index derived).
   *
   * The brief's audit file is named after the chapter (`brief-<id>.json`,
   * ADR-0022 D4), and a name built from `seq` alone would collide across volumes — `seq`
   * is volume-local (data-model §3.2.2).
   */
  id?: string
  seq?: number
  title?: string
  volume?: string
  status?: string
}

export interface ChapterPair {
  current?: ChapterHead
  previous?: ChapterHead
}

export interface OutlinedChapter {
  path: string
  body: string
}

export interface TailSlice {
  path: string
  seq?: number
  /** The whole body: how much of the END travels is the caller's decision. */
  body: string
}

export interface WorldEntry {
  path: string
  title: string
  keywords: string[]
  always: boolean
  priority: number
  excerpt: string
}

export interface WorldSelection {
  /** How many entries fired. */
  matched: number
  /** The entries to render (at most `MAX_WORLD_SHOWN`). */
  shown: WorldEntry[]
}

// ---------------------------------------------------------------------------
// Project summary (derived index)
// ---------------------------------------------------------------------------

/** Title counts from the derived index; `undefined` when there is no usable one. */
export function readProjectStats(root: string): ProjectStats | undefined {
  const dbFile = join(root, INDEX_DIR, INDEX_DB_FILE)
  if (!existsSync(dbFile)) return undefined
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbFile, { readOnly: true })
    if (readSchemaVersion(db) !== INDEX_SCHEMA_VERSION) return undefined
    const chapters = db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(word_count), 0) AS w FROM chapters')
      .get() as { n?: number; w?: number } | undefined
    const volumes = db
      .prepare("SELECT COUNT(*) AS n FROM outline_nodes WHERE kind = 'volume'")
      .get() as { n?: number } | undefined
    return {
      chapters: typeof chapters?.n === 'number' ? chapters.n : 0,
      words: typeof chapters?.w === 'number' ? chapters.w : 0,
      volumes: typeof volumes?.n === 'number' ? volumes.n : 0,
    }
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return typeof row?.user_version === 'number' ? row.user_version : 0
}

// ---------------------------------------------------------------------------
// Chapters
// ---------------------------------------------------------------------------

/**
 * How a caller names the chapter it wants described.
 *
 * Two spellings, because a chapter has two kinds of address and they are not
 * interchangeable:
 *
 *   - `chapterPath` — an **exact chapter file**, which is what a resolved `chapterId`
 *     turns into. The channel resolves the id through `chapterPositions()` (the same map
 *     `/gate`, `/review` and the audit read) and passes the file here, so "which chapter
 *     did the request name" is answered in one place rather than guessed twice.
 *   - `chapterSeq` — a **volume-local number**, for the chapter about to be written. That
 *     chapter has no id yet (`jobs.ts` builds the batch injection from `chapterSeq`), and
 *     a seq above the newest one deliberately means "no current chapter yet".
 *
 * `chapterPath` wins when both are present: an exact address cannot be confused with a
 * number that repeats across volumes.
 */
export interface ChapterAddress {
  readonly chapterPath?: string
  readonly chapterSeq?: number
}

/**
 * The chapter to write and the one before it.
 *
 * `chapterSeq` overrides "the newest chapter": pointing it above the newest one
 * yields no current chapter and the newest as previous, which is exactly the
 * "about to write chapter N+1" case.
 */
export function readChapterPair(root: string, address: ChapterAddress = {}): ChapterPair {
  const chapterPath = (address.chapterPath ?? '').trim()
  if (chapterPath !== '') return readChapterPairAt(root, chapterPath)
  return readChapterPairFromIndex(root, address.chapterSeq) ?? readChapterPairFromFiles(root)
}

/**
 * The chapter at exactly this file, plus the one before it in reading order.
 *
 * Reading order is `(volume order, volume-local seq)` from `chapterPositions()`, never a
 * file-name comparison, so "the chapter before this one" means here what it means on the
 * board and in the gate.
 *
 * A path that matches nothing answers `{}` — **never another chapter**. The caller
 * resolved this path a moment ago (the channel refuses an id that matches nothing, 404
 * `CHAPTER_NOT_FOUND`), so a miss means the book moved underneath us; answering with the
 * last chapter is exactly the silent substitution the chapter map removed.
 */
function readChapterPairAt(root: string, chapterPath: string): ChapterPair {
  const positions = chapterPositions(root)
  const current = positions.get(chapterPath)
  if (current === undefined) return {}
  let previous: ChapterPosition | undefined
  for (const position of positions.values()) {
    // The map files every chapter under its id AND its path, so each entry is visited
    // twice; comparing positions (not keys) makes that harmless.
    if (position.path === current.path) continue
    if (comparePosition(position, current) >= 0) continue
    if (previous === undefined || comparePosition(position, previous) > 0) previous = position
  }
  // The heading comes from the FILE, not from the position: the position table has no
  // `status`, and a head that dropped it would render a different chapter block than the
  // `chapterSeq` spelling does (the two spellings must answer the same brief).
  return {
    current: withFrontmatter(root, current.path),
    ...(previous === undefined ? {} : { previous: withFrontmatter(root, previous.path) }),
  }
}

function readChapterPairFromIndex(root: string, chapterSeq: number | undefined): ChapterPair | undefined {
  const dbFile = join(root, INDEX_DIR, INDEX_DB_FILE)
  if (!existsSync(dbFile)) return undefined
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(dbFile, { readOnly: true })
    if (readSchemaVersion(db) !== INDEX_SCHEMA_VERSION) return undefined
    const rows = db
      .prepare(
        'SELECT id, path, seq, title, volume, status FROM chapters' +
          ' WHERE (? IS NULL OR seq <= ?)' +
          // Chapter order is (volume order, volume-local seq) — data-model §3.2.2.
          // `seq` is **volume-local** (chapter creation takes the volume's max seq + 1),
          // so `ORDER BY seq DESC` answers "the longest volume's last chapter": with
          // vol-01 holding chapters 1-3 and vol-02 holding chapter 1, it named vol-01/3
          // the chapter being written while the author was in vol-02. The volume's number
          // is the `vol-NN` prefix (`substr(volume, 5)` → `01`), the same number
          // `volumeOrderOf()` reads in foreshadowing-plan.ts.
          // A loose chapter (no `volume`) is order 0, i.e. **before every volume**
          // (§3.2.2) — hence the COALESCE: a bare `CAST(NULL …)` sorts first under
          // DESC and would steal "current chapter" for the loosest chapter in the book.
          ' ORDER BY COALESCE(CAST(substr(volume, 5) AS INTEGER), 0) DESC, COALESCE(seq, 1) DESC, path DESC' +
          ' LIMIT 2',
      )
      .all(chapterSeq ?? null, chapterSeq ?? null) as unknown as Array<Record<string, unknown>>
    const heads = rows.map(chapterHeadFromRow)
    const first = heads[0]
    if (first === undefined) return {}
    if (chapterSeq !== undefined && first.seq !== chapterSeq) return { previous: first }
    const second = heads[1]
    return { current: first, ...(second === undefined ? {} : { previous: second }) }
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

function chapterHeadFromRow(row: Record<string, unknown>): ChapterHead {
  const head: ChapterHead = { path: String(row['path']) }
  if (typeof row['id'] === 'string' && row['id'] !== '') head.id = row['id']
  if (typeof row['seq'] === 'number') head.seq = row['seq']
  if (typeof row['title'] === 'string') head.title = row['title']
  if (typeof row['volume'] === 'string') head.volume = row['volume']
  if (typeof row['status'] === 'string') head.status = row['status']
  return head
}

/**
 * Filename fallback: the last two `.md` files in path order are the reading
 * tail of the book (the convention names files `<seq>-<slug>.md` inside
 * `vol-XX/`, so path order is chapter order).
 */
function readChapterPairFromFiles(root: string): ChapterPair {
  const files = walkMarkdown(root, 'chapters')
  const last = files[files.length - 1]
  const before = files[files.length - 2]
  const current = last === undefined ? undefined : withFrontmatter(root, last)
  const previous = before === undefined ? undefined : withFrontmatter(root, before)
  return { ...(current === undefined ? {} : { current }), ...(previous === undefined ? {} : { previous }) }
}

/** Fill a chapter head from its own frontmatter (fallback path only). */
function withFrontmatter(root: string, path: string): ChapterHead {
  const head: ChapterHead = { path }
  const parsed = parseMarkdown(readText(join(root, path)))
  const id = stringField(parsed.data, 'id')
  if (id !== undefined && id !== '') head.id = id
  const seq = intField(parsed.data, 'seq') ?? leadingNumber(path)
  if (seq !== undefined) head.seq = seq
  const title = stringField(parsed.data, 'title') ?? slugOf(path)
  if (title !== undefined && title !== '') head.title = title
  const volume = stringField(parsed.data, 'volume')
  if (volume !== undefined && volume !== '') head.volume = volume
  const status = stringField(parsed.data, 'status')
  if (status !== undefined && status !== '') head.status = status
  return head
}

/** `outlines/ch-<seq>.md`, tolerating the four spellings the conventions allow. */
export function readChapterOutline(root: string, current: ChapterHead): OutlinedChapter | undefined {
  if (current.seq === undefined) return undefined
  const padded = String(current.seq).padStart(4, '0')
  const candidates = [
    `outlines/ch-${padded}.md`,
    `outlines/ch-${String(current.seq)}.md`,
    `outlines/chapter-${padded}.md`,
    `outlines/chapter-${String(current.seq)}.md`,
  ]
  for (const path of candidates) {
    if (!existsSync(join(root, path))) continue
    const body = parseMarkdown(readText(join(root, path))).body.trim()
    return { path, body }
  }
  return undefined
}

/** The previous chapter's body, read from the file (the index stores no body). */
export function readTail(root: string, previous: ChapterHead | undefined): TailSlice | undefined {
  if (previous === undefined) return undefined
  const body = parseMarkdown(readText(join(root, previous.path))).body.trim()
  if (body === '') return undefined
  return {
    path: previous.path,
    ...(previous.seq === undefined ? {} : { seq: previous.seq }),
    body,
  }
}

/**
 * The chapter's own frontmatter `id`, or `undefined` when the file declares none.
 *
 * Why a separate read: the index derives an id from the path when the frontmatter has no
 * `id` (`chapters-vol-01-0002-起风.md`), which is stable but unreadable — and the brief names its
 * brief's audit file after it (ADR-0022 D4). So the *declared* id is read from the file,
 * and a chapter without one falls back to `seq-<n>` instead of to a path slug.
 */
export function readDeclaredChapterId(root: string, current: ChapterHead | undefined): string | undefined {
  if (current === undefined) return undefined
  const parsed = parseMarkdown(readText(join(root, current.path)))
  const id = stringField(parsed.data, 'id')
  return id === undefined || id.trim() === '' ? undefined : id.trim()
}

// ---------------------------------------------------------------------------
// World book
// ---------------------------------------------------------------------------

export function loadWorldEntries(root: string): WorldEntry[] {
  const entries: WorldEntry[] = []
  for (const path of walkMarkdown(root, 'world')) {
    const head = readHead(join(root, path), WORLD_HEAD_BYTES)
    if (head === '') continue
    const parsed = parseMarkdown(head)
    const title = (stringField(parsed.data, 'title') ?? basename(path, extname(path))).trim()
    if (title === '') continue
    const rawAlways = parsed.data['always']
    entries.push({
      path,
      title,
      keywords: stringArrayField(parsed.data, 'keywords'),
      always: rawAlways === true || rawAlways === 'true',
      priority: intField(parsed.data, 'priority') ?? 0,
      excerpt: snippet(parsed.body, WORLD_BODY_CHARS),
    })
  }
  return entries
}

/**
 * World-book matching: `always` entries are permanent, the rest fire when one
 * of their `keywords` appears in the current chapter's outline or in the
 * previous chapter's tail.
 *
 * Order: `always` first, then `priority`, then path — deterministic, so the
 * rendered block does not shuffle between steps and churn the prompt cache.
 */
export function matchWorldEntries(entries: readonly WorldEntry[], haystack: string): WorldSelection {
  const needle = haystack.toLowerCase()
  const hit = entries.filter((entry) => {
    if (entry.always) return true
    return entry.keywords.some((keyword) => {
      const trimmed = keyword.trim()
      return trimmed !== '' && needle.includes(trimmed.toLowerCase())
    })
  })
  hit.sort((left, right) => {
    if (left.always !== right.always) return left.always ? -1 : 1
    if (left.priority !== right.priority) return right.priority - left.priority
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  })
  return { matched: hit.length, shown: hit.slice(0, MAX_WORLD_SHOWN) }
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** Recursive `.md` listing under one content directory (dot entries skipped). */
function walkMarkdown(root: string, top: string): string[] {
  const out: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: top, depth: 0 }]
  while (queue.length > 0) {
    const item = queue.shift()
    if (item === undefined) break
    let entries
    try {
      entries = readdirSync(join(root, item.dir), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = `${item.dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (item.depth < MAX_WALK_DEPTH) queue.push({ dir: path, depth: item.depth + 1 })
        continue
      }
      if (!entry.isFile()) continue // junctions/symlinks are not walked
      if (extname(entry.name).toLowerCase() !== '.md') continue
      out.push(path)
    }
  }
  return out.sort()
}

function readText(absolute: string): string {
  try {
    return readFileSync(absolute, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return ''
  }
}

function readHead(absolute: string, maxBytes: number): string {
  let fd: number | undefined
  try {
    fd = openSync(absolute, 'r')
    const buffer = Buffer.allocUnsafe(maxBytes)
    const bytes = readSync(fd, buffer, 0, maxBytes, 0)
    return buffer.toString('utf8', 0, bytes).replace(/^\uFEFF/, '')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // The descriptor is being reclaimed by the process anyway.
      }
    }
  }
}

function leadingNumber(path: string): number | undefined {
  const match = /^(\d+)/.exec(basename(path))
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/** `chapters/vol-01/0002-夜行.md` → `夜行` (the title fallback when no frontmatter). */
function slugOf(path: string): string {
  return basename(path, extname(path)).replace(/^\d+[-_]?/, '')
}

/** First `max` characters of a text with newlines flattened — a snippet, not prose. */
function snippet(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(1, max - SNIPPET_ELLIPSIS.length))}${SNIPPET_ELLIPSIS}`
}
