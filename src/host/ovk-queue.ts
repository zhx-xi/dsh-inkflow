/**
 * The semantic rebuild job — one at a time, coalesced, retried, and honest about what it
 * did not finish (ADR-0009 P5/P6/P10).
 *
 * THREE RULES, and each one exists because the naive version fails in a way the author
 * cannot see:
 *
 *   * **Serial per book, never a burst.** One chapter is N HTTP calls (one per block) and
 *     OVK summarises每块 with a model. Two rebuilds running at once would double the spend
 *     and interleave two writers over the same URIs. Requests are therefore queued per
 *     book root and one run owns the book until it finishes.
 *   * **Coalesced.** A second request while one is running does not start a second pass;
 *     it sets "run again when this one ends", and requests arriving inside
 *     `debounceMs` collapse into a single pass. Clicking a button twice must not cost two
 *     full rebuilds.
 *   * **Stale is a first-class outcome.** A chapter whose write failed stays in the plan
 *     for the next run and is named in the status (`staleChapters`), instead of being
 *     silently skipped. "Rebuilt" that quietly missed 12 chapters is the failure mode that
 *     makes an author distrust 语义检索 as a whole.
 *
 * NOTHING HERE CALLS `forget`. Deleted chapters become tombstones through
 * `tombstoneContentOf` — the same path-overwrite as a normal block (ADR-0009 P6). The only
 * physical delete in this plugin is `purge`, and it lives in `ovk-purge.ts`/the tool.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseMarkdown } from './frontmatter.js'
import { OVK_BLOCK_CHARS, OVK_BLOCK_OVERLAP, type OvkConnection, blockContentOf, blockTagsOf, blockUriOf, contentHashOf, ovkWriteBlock, tombstoneContentOf } from './ovk.js'
import type { BlockMetadata } from './ovk.js'
import {
  type ChapterRecord,
  type ChapterSource,
  type RebuildSummary,
  type SemanticLedger,
  blockCountOf,
  chapterSources,
  ledgerPath,
  planRebuild,
  projectIdFor,
  readLedger,
  semanticSlugOf,
  writeLedger,
} from './ovk-ledger.js'

/** How long a request waits for others before a pass starts. */
export const REBUILD_DEBOUNCE_MS = 250
/** Attempts per block on a *retryable* failure (timeout / unreachable / 5xx). */
export const REBUILD_RETRIES = 2
/** Delay between those attempts; grows linearly so a down server is not hammered. */
export const REBUILD_RETRY_DELAY_MS = 200

export interface SemanticRuntime {
  readonly root: string
  readonly dataDir: string
  readonly connection: OvkConnection
  readonly peer: string
  /** Per-request timeout; tests lower it so a timeout case runs in milliseconds. */
  readonly timeoutMs?: number
  /** Clock injection, so a deterministic test can assert the summary's stamp. */
  readonly now?: () => Date
  readonly retries?: number
  readonly retryDelayMs?: number
}

/** What a rebuild did, or why it did nothing. */
export interface RebuildOutcome {
  /** `'summary'` = nothing needed; `'written'` = at least one chapter changed. */
  status: 'summary' | 'written' | 'failed'
  /** Chapters that have to be written (0 = the book is in sync). */
  pending: number
  summary: RebuildSummary
  /** The ledger as it stands after the run. */
  ledger: SemanticLedger
  /** Chapters that failed and will be retried by the next run. */
  staleChapters: string[]
}

/**
 * How many times one chapter body is read before the chapter is called unreadable.
 *
 * A `readFileSync` on a file this process may have written milliseconds ago is allowed to
 * fail once: on Windows an antivirus scanning the temp directory as the file appears, or a
 * cold cache under a full-suite run, answers EPERM/EBUSY and then succeeds on the retry.
 * The second attempt is synchronous and costs nothing on the happy path; what makes a
 * *persistent* failure harmless is not the retry but the accounting in
 * `planRebuild`/`runRebuild` (one lost read used to drop the chapter from both
 * the plan and the ledger while the rebuild reported success).
 */
export const READ_ATTEMPTS = 2

/** Chapter prose as the book holds it: one reader, so hash and chunks cannot disagree. */
export function readChapterBody(root: string, chapter: ChapterSource): { text: string; hash: string } | undefined {
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt += 1) {
    let raw: string
    try {
      raw = readFileSync(join(root, chapter.path), 'utf8')
    } catch {
      continue // see READ_ATTEMPTS: one lost read is a hiccup, not a deletion
    }
    // `parseMarkdown` strips the BOM and normalises CRLF (ADR-0016), which is what the
    // index stores as the body too — offsets therefore mean the same thing in both places.
    const body = parseMarkdown(raw).body
    return { text: body, hash: contentHashOf(body) }
  }
  return undefined
}

function retryable(reason: string): boolean {
  return reason === 'timeout' || reason === 'unreachable' || reason === 'http' || reason === 'malformed'
}

/** Sleep, injectable through the runtime's `retryDelayMs` so tests stay fast. */
async function pause(ms: number): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    // Do not keep the process alive for a retry delay: a test that finishes first must
    // not hang on a pending timer.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) (timer as { unref: () => void }).unref()
  })
}

/**
 * Write one block, retrying only the failures that can pass (ADR-0009 P10's cost warning
 * makes a retry storm the thing to avoid: `unauthorized` is retried zero times).
 */
async function writeWithRetry(
  runtime: SemanticRuntime,
  body: { uri: string; content: string; tags: readonly string[] },
): Promise<{ ok: true } | { ok: false; reason: string; detail: string }> {
  const retries = Math.max(0, runtime.retries ?? REBUILD_RETRIES)
  const delay = Math.max(0, runtime.retryDelayMs ?? REBUILD_RETRY_DELAY_MS)
  let last: { reason: string; detail: string } = { reason: 'unreachable', detail: 'not attempted' }
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await pause(delay * attempt)
    const answer = await ovkWriteBlock(runtime.connection, runtime.peer, {
      uri: body.uri,
      content: body.content,
      tags: body.tags,
      ...(runtime.timeoutMs === undefined ? {} : { timeoutMs: runtime.timeoutMs }),
    })
    if (answer.ok) return { ok: true }
    last = { reason: answer.failure.reason, detail: answer.failure.detail }
    if (!retryable(answer.failure.reason)) return { ok: false, ...last }
  }
  return { ok: false, ...last }
}

/**
 * Rebuild `runtime.root`'s blocks in OVK.
 *
 * Per chapter: read the body, compare its hash with the ledger, and write every block by
 * its **fixed URI** (`blockUriOf`) in `replace` mode. That is what makes the operation
 * idempotent (ADR-0009 P5) — a second run over an unchanged chapter writes nothing because
 * the hash matched, and a run over a changed chapter overwrites the same paths rather than
 * appending new ones.
 *
 * Chapters that the ledger knows and the book no longer has become tombstones: the prose is
 * replaced by a marker, the record is kept with `deleted: true`, and nothing is forgotten
 * (P6) — the record is what `inkflow_semantic_purge` will later name.
 */
export async function runRebuild(runtime: SemanticRuntime): Promise<RebuildOutcome> {
  const slug = semanticSlugOf(runtime.root)
  const existing = readLedger(runtime.dataDir, slug)
  const projectId = projectIdFor(runtime.root, slug, existing.ledger)
  const ledger: SemanticLedger = { ...existing.ledger, projectId, bookSlug: slug, peer: runtime.peer }
  const at = (runtime.now ?? (() => new Date()))().toISOString()
  const summary: RebuildSummary = {
    at,
    written: 0,
    tombstoned: 0,
    unchanged: 0,
    blocks: 0,
    bytes: 0,
    calls: 0,
    stale: 0,
    staleChapters: [],
  }

  const sources = chapterSources(runtime.root)
  if (sources === undefined) {
    return { status: 'failed', pending: 0, summary, ledger, staleChapters: [] }
  }
  // Chapter bodies are read once for BOTH the hash and the chunks: a second read could
  // see a file the author just saved, and then the hash would describe text that is not
  // what was written.
  const bodies = new Map<string, { text: string; hash: string }>()
  for (const chapter of sources) {
    const body = readChapterBody(runtime.root, chapter)
    if (body === undefined) continue
    bodies.set(chapter.id, body)
  }

  const plan = planRebuild(ledger, sources, bodies, {
    chars: OVK_BLOCK_CHARS,
    overlap: OVK_BLOCK_OVERLAP,
    projectId,
  })
  // A chapter the index lists and the disk would not give back is stale, not absent: it
  // must be named in the summary and retried on the next run (the silent
  // version left the ledger without the chapter and the run claiming success).
  const stale = new Set<string>(plan.unreadable)
  const pending = plan.writes.length + plan.tombstones.length
  if (pending === 0 && stale.size === 0) {
    summary.unchanged = plan.unchanged
    ledger.lastRebuild = summary
    writeLedger(runtime.dataDir, slug, ledger)
    return { status: 'summary', pending: 0, summary, ledger, staleChapters: [] }
  }

  let fatal: { reason: string; detail: string } | undefined

  for (const chapterPlan of plan.writes) {
    if (fatal !== undefined) break
    const chapter = chapterPlan.chapter
    const record: ChapterRecord = {
      path: chapter.path,
      ...(chapter.seq === undefined ? {} : { seq: chapter.seq }),
      title: chapter.title,
      contentHash: chapterPlan.contentHash,
      blocks: [],
      deleted: false,
      updatedAt: at,
    }
    let chapterFailed = false
    for (const block of chapterPlan.blocks) {
      const uri = blockUriOf(projectId, chapter.id, block.index)
      const metadata: BlockMetadata = {
        projectId,
        chapterId: chapter.id,
        blockIndex: block.index,
        contentHash: block.hash,
        deleted: false,
        ...(chapter.seq === undefined ? {} : { seq: chapter.seq }),
        title: chapter.title,
      }
      const written = await writeWithRetry(runtime, {
        uri,
        content: blockContentOf({ index: block.index, text: block.text, charStart: block.charStart, charEnd: block.charEnd }, metadata),
        tags: blockTagsOf(metadata),
      })
      summary.calls += 1
      if (!written.ok) {
        chapterFailed = true
        if (!retryable(written.reason)) fatal = { reason: written.reason, detail: written.detail }
        break
      }
      summary.bytes += Buffer.byteLength(block.text, 'utf8')
      summary.blocks += 1
      record.blocks.push({
        index: block.index,
        uri,
        contentHash: block.hash,
        charStart: block.charStart,
        charEnd: block.charEnd,
      })
    }
    if (chapterFailed || record.blocks.length !== chapterPlan.blocks.length) {
      // A partial chapter is worse than a stale one: the ledger must not claim blocks it
      // did not write, and the next run has to redo the whole chapter (its hash differs
      // only if the author edited it, so the reason is recorded as stale instead).
      stale.add(chapter.id)
      continue
    }
    ledger.chapters[chapter.id] = record
    summary.written += 1
    // Persisted per chapter: an interrupted run leaves a ledger that matches OVK instead
    // of one that has to be thrown away.
    writeLedger(runtime.dataDir, slug, ledger)
  }

  for (const tombstone of plan.tombstones) {
    if (fatal !== undefined) break
    const chapterId = tombstone.chapterId
    const record = tombstone.record
    const source: ChapterSource = {
      id: chapterId,
      path: record.path,
      title: record.title,
      ...(record.seq === undefined ? {} : { seq: record.seq }),
    }
    const marker = tombstoneContentOf(
      { projectId, chapterId, blockIndex: 0, contentHash: '', deleted: true },
      at,
    )
    const contentHash = contentHashOf(marker)
    let failed = false
    const blocks = record.blocks.map((block) => ({ ...block }))
    for (const block of blocks) {
      const metadata: BlockMetadata = {
        projectId,
        chapterId: source.id,
        blockIndex: block.index,
        contentHash,
        deleted: true,
        ...(record.seq === undefined ? {} : { seq: record.seq }),
      }
      const written = await writeWithRetry(runtime, {
        uri: block.uri,
        content: marker,
        tags: blockTagsOf(metadata),
      })
      summary.calls += 1
      if (!written.ok) {
        failed = true
        if (!retryable(written.reason)) fatal = { reason: written.reason, detail: written.detail }
        break
      }
      block.contentHash = contentHash
    }
    if (failed) {
      stale.add(chapterId)
      continue
    }
    ledger.chapters[chapterId] = { ...record, blocks, deleted: true, updatedAt: at }
    summary.tombstoned += 1
    writeLedger(runtime.dataDir, slug, ledger)
  }

  summary.unchanged = plan.unchanged
  summary.stale = stale.size
  summary.staleChapters = [...stale]
  ledger.lastRebuild = summary
  writeLedger(runtime.dataDir, slug, ledger)
  const status: RebuildOutcome['status'] = fatal === undefined ? (summary.written + summary.tombstoned > 0 ? 'written' : 'failed') : 'failed'
  return { status, pending, summary, ledger, staleChapters: summary.staleChapters }
}

/**
 * The plan without writing anything: what a `confirm`-less rebuild call answers.
 *
 * Reads the same bodies the rebuild would read, so the numbers the panel shows are the
 * numbers the run then spends (ADR-0009 P10: 章数 / 块数 / 字节 / 摘要调用次数).
 */
export function planOnly(runtime: Omit<SemanticRuntime, 'connection' | 'peer'> & { projectIdHint?: string }): {
  ok: boolean
  chapters: number
  pending: number
  blocks: number
  bytes: number
  calls: number
  unchanged: number
  tombstones: number
  totalBlocks: number
  chaptersKnown: number
  lastRebuild?: RebuildSummary
} {
  const slug = semanticSlugOf(runtime.root)
  const existing = readLedger(runtime.dataDir, slug)
  const projectId = projectIdFor(runtime.root, slug, existing.ledger)
  const sources = chapterSources(runtime.root)
  if (sources === undefined) {
    return { ok: false, chapters: 0, pending: 0, blocks: 0, bytes: 0, calls: 0, unchanged: 0, tombstones: 0, totalBlocks: blockCountOf(existing.ledger), chaptersKnown: 0 }
  }
  const bodies = new Map<string, { text: string; hash: string }>()
  for (const chapter of sources) {
    const body = readChapterBody(runtime.root, chapter)
    if (body !== undefined) bodies.set(chapter.id, body)
  }
  const plan = planRebuild(existing.ledger, sources, bodies, { chars: OVK_BLOCK_CHARS, overlap: OVK_BLOCK_OVERLAP, projectId })
  const out = {
    ok: true,
    chapters: sources.length,
    pending: plan.writes.length + plan.tombstones.length,
    blocks: plan.blocks,
    bytes: plan.bytes,
    calls: plan.calls,
    unchanged: plan.unchanged,
    tombstones: plan.tombstones.length,
    totalBlocks: blockCountOf(existing.ledger),
    chaptersKnown: Object.keys(existing.ledger.chapters).length,
  }
  return existing.ledger.lastRebuild === undefined ? out : { ...out, lastRebuild: existing.ledger.lastRebuild }
}

/** A run in progress (or the last one) for one book — what the status surface reports. */
export interface QueueSnapshot {
  state: 'idle' | 'queued' | 'running' | 'failed'
  /** Passes requested while one was running (coalesced into the next run). */
  queued: number
  lastRun?: RebuildSummary
  lastError?: { reason: string; detail: string }
}

interface QueueEntry {
  running?: Promise<RebuildOutcome>
  rerun: boolean
  debounce?: ReturnType<typeof setTimeout>
  snapshot: QueueSnapshot
}

/** One entry per book root: serial per book is the whole point (see the file header). */
const QUEUE = new Map<string, QueueEntry>()

function entryOf(root: string): QueueEntry {
  const existing = QUEUE.get(root)
  if (existing !== undefined) return existing
  const created: QueueEntry = { rerun: false, snapshot: { state: 'idle', queued: 0 } }
  QUEUE.set(root, created)
  return created
}

/** The snapshot for a book, or the idle default when nothing has run in this process. */
export function queueSnapshotOf(root: string): QueueSnapshot {
  const entry = QUEUE.get(root)
  if (entry === undefined) return { state: 'idle', queued: 0 }
  return { ...entry.snapshot }
}

/** Test hook + "forget this book's queue" (a deleted book must not keep a timer alive). */
export function resetQueue(root?: string): void {
  if (root === undefined) {
    for (const entry of QUEUE.values()) if (entry.debounce !== undefined) clearTimeout(entry.debounce)
    QUEUE.clear()
    return
  }
  const entry = QUEUE.get(root)
  if (entry !== undefined && entry.debounce !== undefined) clearTimeout(entry.debounce)
  QUEUE.delete(root)
}

/**
 * Queue a rebuild for `runtime.root`.
 *
 * Debounced and coalesced: a call while a pass is running marks "run again", and a call
 * inside `debounceMs` of the previous one replaces it (one pass for a burst of edits).
 * Resolves with the outcome of the pass that eventually covered the call.
 */
export function enqueueRebuild(runtime: SemanticRuntime, options: { debounceMs?: number } = {}): Promise<RebuildOutcome> {
  const entry = entryOf(runtime.root)
  const debounceMs = Math.max(0, options.debounceMs ?? REBUILD_DEBOUNCE_MS)
  if (entry.running !== undefined) {
    entry.rerun = true
    entry.snapshot = { ...entry.snapshot, state: 'queued', queued: entry.snapshot.queued + 1 }
    return entry.running
  }
  if (entry.debounce !== undefined) clearTimeout(entry.debounce)
  if (debounceMs === 0) return start(runtime, entry)
  return new Promise<RebuildOutcome>((resolve) => {
    entry.snapshot = { ...entry.snapshot, state: 'queued', queued: entry.snapshot.queued + 1 }
    entry.debounce = setTimeout(() => {
      entry.debounce = undefined
      void start(runtime, entry).then(resolve)
    }, debounceMs)
    if (typeof entry.debounce === 'object' && entry.debounce !== null && 'unref' in entry.debounce) {
      ;(entry.debounce as { unref: () => void }).unref()
    }
  })
}

function start(runtime: SemanticRuntime, entry: QueueEntry): Promise<RebuildOutcome> {
  entry.snapshot = { state: 'running', queued: Math.max(0, entry.snapshot.queued - 1) }
  const run = runRebuild(runtime)
    .then((outcome) => {
      const failed = outcome.summary.stale > 0 || outcome.status === 'failed'
      entry.snapshot = {
        state: failed ? 'failed' : 'idle',
        queued: entry.snapshot.queued,
        lastRun: outcome.summary,
      }
      return outcome
    })
    .catch((cause: unknown) => {
      entry.snapshot = {
        state: 'failed',
        queued: entry.snapshot.queued,
        lastError: { reason: 'internal', detail: cause instanceof Error ? cause.message : String(cause) },
      }
      throw cause
    })
    .finally(() => {
      entry.running = undefined
      if (entry.rerun) {
        entry.rerun = false
        // A queued pass starts on the same tick it becomes possible: the caller's edit
        // already happened, and waiting for a debounce window here would add latency
        // without protecting anything (the previous pass has finished).
        entry.snapshot = { ...entry.snapshot, state: 'queued' }
      }
    })
  entry.running = run
  return run
}

/** Whether the book's ledger file exists at all (the status surface's `firstBuild`). */
export function hasLedger(dataDir: string, root: string): boolean {
  const slug = semanticSlugOf(root)
  try {
    readFileSync(ledgerPath(dataDir, slug), 'utf8')
    return true
  } catch {
    return false
  }
}
