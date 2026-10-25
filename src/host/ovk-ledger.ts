/**
 * The semantic block ledger — what this plugin has written into OpenViking.
 *
 * WHY IT IS NOT IN THE DERIVED INDEX (ADR-0020 E4). Two of the facts here cannot be
 * derived from the files:
 *
 *   * `deleted` — a chapter that was removed is gone from `chapters/`, so a rebuild of
 *     the cache has no way to learn that a block for it is a tombstone;
 *   * the purgable URI list — ADR-0009 P6 forbids `forget` on the delete path and allows
 *     it only in an explicit "clean up the deleted chapters" action, which needs a list.
 *
 * Putting that state in `index/inkflow.db` would therefore delete it exactly when the
 * cache is rebuilt (AGENTS §8 row 5), and `inkflow_semantic_purge` would always answer "no
 * orphans". ADR-0005's split is the guide: files are truth, the index is a cache, and
 * state that is neither belongs in the plugin's own directory (ADR-0012 / ADR-0018 D1).
 *
 * WHERE: `dataDir/semantic/<bookSlug>.json`, next to `settings.json` and `backups/`, so
 * it is outside the author's git repository (a machine-specific projection must not be
 * committed) and survives an index rebuild.
 *
 * WHY READS NEVER THROW. A ledger is a cache of *this machine's* writes: a user may
 * delete it, another machine never had it, an editor may truncate it. Every read answers
 * a usable ledger and marks it `fresh: false`, and the rebuild then rewrites every block
 * through the same idempotent path instead of failing.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { listAllChapters } from './indexer.js'
import { readMeta } from './project.js'
import { OVK_BLOCK_CHARS, blockUriOf, chunkBody } from './ovk.js'

/** `dataDir/semantic`: the plugin's own semantic state, outside every book. */
export const SEMANTIC_DIR = 'semantic'

/** Shape version of one ledger file. A shape change means "rebuild", not "migrate". */
export const SEMANTIC_SCHEMA_VERSION = 1

export interface BlockRecord {
  index: number
  uri: string
  /** sha256 of the block text that was written (not of the chapter). */
  contentHash: string
  charStart: number
  charEnd: number
}

export interface ChapterRecord {
  /** Project-relative chapter path (`chapters/vol-01/0001-a.md`). */
  path: string
  seq?: number
  title: string
  /** sha256 of the chapter body: the increment check (ADR-0009 P5). */
  contentHash: string
  blocks: BlockRecord[]
  /**
   * True when this chapter's blocks are tombstones (ADR-0009 P6 step 2).
   *
   * Kept rather than deleting the record: the block URIs are what a purge has to name,
   * and a record that vanished could never be cleaned up.
   */
  deleted: boolean
  updatedAt: string
}

export interface RebuildSummary {
  at: string
  /** Chapters whose blocks were (re)written this run. */
  written: number
  /** Chapters turned into tombstones this run. */
  tombstoned: number
  /** Chapters skipped because their body hash matched. */
  unchanged: number
  /** Blocks written (including tombstones). */
  blocks: number
  /** Metadata + prose bytes sent to OVK. */
  bytes: number
  /** HTTP calls made (one per block). */
  calls: number
  /** Chapters that failed and are therefore stale (retried on the next run). */
  stale: number
  /** Up to a few chapter ids that failed, for the status surface. */
  staleChapters: string[]
}

export interface SemanticLedger {
  schemaVersion: number
  /** The identity that owns the URI prefix (ADR-0020 E3). */
  projectId: string
  /** Directory name of the book, so a human can tell two ledgers apart. */
  bookSlug: string
  /** The peer in force when blocks were written; diagnostic only (ADR-0020 E2). */
  peer?: string
  chapters: Record<string, ChapterRecord>
  lastRebuild?: RebuildSummary
}

export interface LedgerRead {
  ledger: SemanticLedger
  /** `false` when the file was missing or unusable, i.e. nothing is known about OVK. */
  fresh: boolean
}

/** `dataDir/semantic`. */
export function semanticDir(dataDir: string): string {
  return join(dataDir, SEMANTIC_DIR)
}

/**
 * A book's directory name, as a file name.
 *
 * Same rule as `backup-zip.ts`'s `bookSlugOf` (non-name characters become `-`) so the two
 * plugin-owned directories read the same way for the same book.
 */
export function semanticSlugOf(root: string): string {
  const name = basename(root.replaceAll('\\', '/').replace(/\/+$/u, ''))
  const slug = name.replace(/[^A-Za-z0-9_.\u4e00-\u9fff-]/gu, '-').replace(/^-+|-+$/gu, '')
  return slug === '' ? 'book' : slug
}

export function ledgerPath(dataDir: string, slug: string): string {
  return join(semanticDir(dataDir), `${slug}.json`)
}

function emptyLedger(projectId: string, bookSlug: string): SemanticLedger {
  return { schemaVersion: SEMANTIC_SCHEMA_VERSION, projectId, bookSlug, chapters: {} }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** One chapter record, or `undefined` when the shape is not one we can use. */
function chapterRecordOf(value: unknown): ChapterRecord | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const path = record['path']
  const contentHash = record['contentHash']
  if (typeof path !== 'string' || typeof contentHash !== 'string') return undefined
  const rawBlocks = Array.isArray(record['blocks']) ? record['blocks'] : []
  const blocks: BlockRecord[] = []
  for (const raw of rawBlocks) {
    const block = asRecord(raw)
    if (block === undefined) continue
    const uri = block['uri']
    if (typeof uri !== 'string' || uri === '') continue
    blocks.push({
      index: numberOr(block['index'], blocks.length),
      uri,
      contentHash: typeof block['contentHash'] === 'string' ? block['contentHash'] : '',
      charStart: numberOr(block['charStart'], 0),
      charEnd: numberOr(block['charEnd'], 0),
    })
  }
  const out: ChapterRecord = {
    path,
    title: typeof record['title'] === 'string' ? record['title'] : '',
    contentHash,
    blocks,
    deleted: record['deleted'] === true,
    updatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : '',
  }
  if (typeof record['seq'] === 'number' && Number.isFinite(record['seq'])) out.seq = record['seq']
  return out
}

/**
 * Read a book's ledger. Never throws; a missing or broken file reads as an empty ledger
 * with `fresh: false` (see the file header — a ledger is this machine's own cache).
 */
export function readLedger(dataDir: string, slug: string, projectIdHint?: string): LedgerRead {
  const path = ledgerPath(dataDir, slug)
  const fallback = (): LedgerRead => ({
    ledger: emptyLedger(projectIdHint ?? '', slug),
    fresh: false,
  })
  if (!existsSync(path)) return fallback()
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return fallback()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/u, ''))
  } catch {
    return fallback()
  }
  const record = asRecord(parsed)
  if (record === undefined) return fallback()
  if (record['schemaVersion'] !== SEMANTIC_SCHEMA_VERSION) return fallback()
  const projectId = typeof record['projectId'] === 'string' && record['projectId'] !== '' ? record['projectId'] : (projectIdHint ?? '')
  if (projectId === '') return fallback()
  const ledger = emptyLedger(projectId, typeof record['bookSlug'] === 'string' ? record['bookSlug'] : slug)
  if (typeof record['peer'] === 'string') ledger.peer = record['peer']
  const chapters = asRecord(record['chapters']) ?? {}
  for (const [chapterId, raw] of Object.entries(chapters)) {
    const chapter = chapterRecordOf(raw)
    if (chapter !== undefined) ledger.chapters[chapterId] = chapter
  }
  const last = asRecord(record['lastRebuild'])
  if (last !== undefined) ledger.lastRebuild = rebuildSummaryOf(last)
  return { ledger, fresh: true }
}

function rebuildSummaryOf(record: Record<string, unknown>): RebuildSummary {
  return {
    at: typeof record['at'] === 'string' ? record['at'] : '',
    written: numberOr(record['written'], 0),
    tombstoned: numberOr(record['tombstoned'], 0),
    unchanged: numberOr(record['unchanged'], 0),
    blocks: numberOr(record['blocks'], 0),
    bytes: numberOr(record['bytes'], 0),
    calls: numberOr(record['calls'], 0),
    stale: numberOr(record['stale'], 0),
    staleChapters: Array.isArray(record['staleChapters']) ? (record['staleChapters'] as unknown[]).map(String) : [],
  }
}

/** Atomic replace (temp + rename), like every other write in this plugin. */
export function writeLedger(dataDir: string, slug: string, ledger: SemanticLedger): void {
  const dir = semanticDir(dataDir)
  mkdirSync(dir, { recursive: true })
  const path = ledgerPath(dataDir, slug)
  const temp = `${path}.tmp-${String(process.pid)}-${String(Date.now())}`
  writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

/**
 * The book's semantic identity.
 *
 * `inkflow.json`'s `projectId` when the book has one (ADR-0018 D7 — the wizard mints it).
 * Otherwise `book-<hash12 of the directory name>` **recorded in the ledger and never
 * recomputed**, because a value that is recomputed per run would rename the namespace the
 * moment the author renames the directory, orphaning every block (and `purge` could never
 * find them).
 */
export function projectIdFor(root: string, slug: string, existing?: SemanticLedger): string {
  const meta = readMeta(root).meta
  if (meta?.projectId !== undefined && meta.projectId.trim() !== '') return meta.projectId.trim().replace(/[^A-Za-z0-9_.-]/gu, '-')
  if (existing !== undefined && existing.projectId !== '') return existing.projectId
  const digest = createHash('sha256').update(slug, 'utf8').digest('hex').slice(0, 12)
  return `book-${digest}`
}

/** Every block URI this ledger knows, tombstoned ones included. */
export function blockCountOf(ledger: SemanticLedger): number {
  let total = 0
  for (const chapter of Object.values(ledger.chapters)) total += chapter.blocks.length
  return total
}

/** The purgable list ADR-0009 P6 step 3 requires — tombstones only, never live blocks. */
export function tombstonedUrisOf(ledger: SemanticLedger): string[] {
  const uris: string[] = []
  for (const chapter of Object.values(ledger.chapters)) {
    if (!chapter.deleted) continue
    for (const block of chapter.blocks) uris.push(block.uri)
  }
  return uris
}

// ---------------------------------------------------------------------------
// Reading the book (what a rebuild has to walk)
// ---------------------------------------------------------------------------

export interface ChapterSource {
  id: string
  path: string
  seq?: number
  title: string
}

/**
 * Every chapter in the derived index, in reading order.
 *
 * Unabridged on purpose: the first-build threshold in ADR-0009 P10 is *200 chapters*, and
 * a book that trips the confirm threshold can also be a book a page-capped read would cut
 * short — a rebuild that saw 500 of 520 chapters would silently stop writing blocks for
 * the tail. The unbounded read therefore lives in `indexer.ts` (`listAllChapters`) so the
 * book's chapter count has exactly one source; this function only narrows the
 * summary to the fields a rebuild walks.
 */
export function chapterSources(root: string): ChapterSource[] | undefined {
  const chapters = listAllChapters(root)
  if (chapters === undefined) return undefined
  return chapters.map((chapter) => {
    const out: ChapterSource = { id: chapter.id, path: chapter.path, title: chapter.title }
    if (chapter.seq !== null) out.seq = chapter.seq
    return out
  })
}

// ---------------------------------------------------------------------------
// The plan: what a rebuild would write, and what it would leave alone
// ---------------------------------------------------------------------------

export interface ChapterPlan {
  chapter: ChapterSource
  /** Chunks of the chapter body as they will be written. */
  blocks: Array<{ index: number; text: string; charStart: number; charEnd: number; hash: string }>
  /** sha256 of the whole body (the increment check). */
  contentHash: string
  /** Metadata + prose bytes that will be sent for this chapter. */
  bytes: number
  /** Why the chapter is in the plan. */
  reason: 'new' | 'changed' | 'missing-ledger'
}

export interface TombstonePlan {
  chapterId: string
  record: ChapterRecord
}

export interface RebuildPlan {
  writes: ChapterPlan[]
  tombstones: TombstonePlan[]
  /** Chapters whose body hash matched an existing, non-deleted record. */
  unchanged: number
  /** Chapter bodies read (for the estimate: same number as `writes` + `unchanged`). */
  chapters: number
  /**
   * Chapters the book still lists but whose body could not be read this run.
   *
   * NOT a tombstone: a read that failed says nothing about whether the chapter still
   * exists, and the tombstone path *overwrites* the chapter's blocks with a deleted marker
   * — one lost read would wipe a live chapter out of recall. They are handed
   * to the caller as stale so the next run retries them and the status surface names them.
   */
  unreadable: string[]
  bytes: number
  blocks: number
  calls: number
}

/**
 * Compare the book with the ledger.
 *
 * `bodies` is keyed by chapter id and holds the chapter's prose as the book reader
 * produced it — one read serves both the hash and the chunking, so the increment check
 * cannot disagree with what would be written.
 *
 * A chapter the ledger knows and the book no longer lists is a TOMBSTONE, not a deletion of
 * the record (ADR-0009 P6 step 2/3): the record is what a purge names. "The book no longer
 * lists it" is read from the index listing, which is the book's own record — a chapter the
 * index still lists is never tombstoned, even when its body could not be read (that case is
 * `unreadable`, and the next index rebuild is what settles whether the file is really gone).
 */
export function planRebuild(
  ledger: SemanticLedger,
  chapters: readonly ChapterSource[],
  bodies: ReadonlyMap<string, { text: string; hash: string }>,
  options: { chars?: number; overlap?: number; projectId?: string } = {},
): RebuildPlan {
  const projectId = options.projectId ?? ledger.projectId
  const writes: ChapterPlan[] = []
  const tombstones: TombstonePlan[] = []
  const unreadable: string[] = []
  const seen = new Set<string>()
  let unchanged = 0
  let chaptersRead = 0
  let bytes = 0
  let blocks = 0
  let calls = 0

  for (const chapter of chapters) {
    // Recorded before the body check: the book still has this chapter, so it must not fall
    // through to the tombstone loop below just because this run could not read it.
    seen.add(chapter.id)
    const body = bodies.get(chapter.id)
    if (body === undefined) {
      unreadable.push(chapter.id)
      continue
    }
    chaptersRead += 1
    const existing = ledger.chapters[chapter.id]
    const sameShape =
      existing !== undefined && !existing.deleted && existing.contentHash === body.hash && existing.blocks.length > 0
    if (sameShape) {
      unchanged += 1
      continue
    }
    const chunks = chunkBody(body.text, {
      ...(options.chars === undefined ? {} : { chars: options.chars }),
      ...(options.overlap === undefined ? {} : { overlap: options.overlap }),
    })
    // A chapter with no prose produces no blocks at all — not one empty block. An empty
    // block would be a recall hit with nothing behind it (ADR-0009 P9: no empty shells).
    if (chunks.length === 0) continue
    const planBlocks = chunks.map((chunk) => ({
      index: chunk.index,
      text: chunk.text,
      charStart: chunk.charStart,
      charEnd: chunk.charEnd,
      hash: createHash('sha256').update(chunk.text, 'utf8').digest('hex'),
    }))
    const chapterBytes = planBlocks.reduce((sum, block) => sum + Buffer.byteLength(block.text, 'utf8'), 0)
    writes.push({
      chapter,
      blocks: planBlocks,
      contentHash: body.hash,
      bytes: chapterBytes,
      reason: existing === undefined ? (ledger.chapters[chapter.id] === undefined ? 'new' : 'new') : existing.deleted ? 'new' : 'changed',
    })
    bytes += chapterBytes
    blocks += planBlocks.length
    calls += planBlocks.length
    // Guard the URI shape once here instead of in the queue: a silent mismatch between
    // what the plan assumes and what the writer builds would look like "OVK lost a block".
    void blockUriOf(projectId, chapter.id, 0)
  }

  for (const [chapterId, record] of Object.entries(ledger.chapters)) {
    if (seen.has(chapterId) || record.deleted) continue
    tombstones.push({ chapterId, record })
  }

  return { writes, tombstones, unreadable, unchanged, chapters: chaptersRead, bytes, blocks, calls }
}

/** Chapter body text, chunk counts and bytes for the estimator (no writes implied). */
export function estimateFrom(plan: RebuildPlan, chars = OVK_BLOCK_CHARS): {
  chapters: number
  blocks: number
  bytes: number
  calls: number
  charsPerBlock: number
} {
  return {
    chapters: plan.writes.length + plan.unchanged,
    blocks: plan.blocks,
    bytes: plan.bytes,
    calls: plan.calls,
    charsPerBlock: chars,
  }
}

/** Bytes on disk of one book file, `0` when it cannot be read (an estimate, not a gate). */
export function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
