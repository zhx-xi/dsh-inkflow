/**
 * Semantic retrieval plugged into the ONE search entry (#41, roadmap X-16, ADR-0009 P7/P8).
 *
 * WHAT THIS FILE DECIDES, in order:
 *
 *   1. **Can the semantic backend answer at all** — `diagnoseSemantic`, whose order matches
 *      the order an author can fix things in: off → no endpoint → no peer → health probe
 *      (`unreachable` / `unauthorized` / `timeout`). The verdict is a fixed vocabulary
 *      (`OvkDegradedReason`) so the panel can turn it into one concrete next step.
 *   2. **If yes, recall and locate.** OVK answers at *file* level with a summary; the
 *      ledger says which chapter and which character range that file is, and the snippet is
 *      then cut from the chapter's own text on disk. That is ADR-0009 P7 in one sentence:
 *      OVK finds, the book locates. The `abstract` OVK returns is never quoted as prose — it
 *      is a model-written summary of the file, not the author's words.
 *   3. **If no, degrade loudly.** Keyword results are returned with `searchBackend: 'fts5'`
 *      and a `degradedReason`. Nothing throws, nothing 500s: an absent OVK is a capability
 *      downgrade, not a failure (ADR-0009 P8).
 *
 * WHY THE FTS5 ENTRY STAYS THE BASE. `searchEntries` already answers every kind; the
 * semantic backend only adds *chapter* hits keywords would miss ("那把断剑" ↔ "残锋"). It is
 * merged in front of the keyword page and deduplicated by chapter id, so a chapter both
 * backends found appears once — with the semantic ordering.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseMarkdown } from './frontmatter.js'
import {
  type OvkDegradedReason,
  connectionOf,
  ovkFind,
  ovkHealth,
  parseBlockUri,
  projectSubtreeUri,
  resolveOvkPeer,
} from './ovk.js'
import type { PeerResolution } from './ovk.js'
import { chapterSources, projectIdFor, readLedger, semanticSlugOf } from './ovk-ledger.js'
import type { BlockRecord, ChapterRecord } from './ovk-ledger.js'
import { searchEntries } from './search.js'
import type { SearchEntriesOptions, SearchEntriesResult, SearchEntry } from './search.js'
import { readSettings } from './settings.js'
import type { InkflowSettings } from './settings.js'
import { sliceContext } from './snippet.js'

/** Why the semantic backend is not answering, and what it would take to fix it. */
export interface SemanticAvailability {
  backend: 'ovk' | 'fts5'
  /** Present exactly when `backend === 'fts5'`. */
  reason?: OvkDegradedReason
  /** One sentence, safe to show: no paths beyond the book, no credentials. */
  detail?: string
  /** The peer in force (also the one every request carries). */
  peer?: string
  peerSource?: 'local' | 'team'
  /** Project-relative path of the workspace config layer that answered. */
  configPath?: string
  /** The endpoint, already public in the settings page. */
  endpoint?: string
}

export interface SemanticDeps {
  readonly dataDir: string
  /** Per-request timeout; tests lower it (ADR-0020 E6). */
  readonly timeoutMs?: number
  /** Settings override for a caller that just read them. */
  readonly settings?: InkflowSettings
}

function unavailable(reason: OvkDegradedReason, detail: string, extra: Partial<SemanticAvailability> = {}): SemanticAvailability {
  return { backend: 'fts5', reason, detail, ...extra }
}

/**
 * The availability verdict, without any recall.
 *
 * The health probe is the last and most expensive step on purpose: `disabled`,
 * `no-endpoint` and `no-peer` are answered from local files, so a book that has not been
 * configured never waits on a socket. A probe failure maps 1:1 onto the three transport
 * reasons, and `http`/`malformed` (which an author can do nothing about) is reported as
 * `unreachable` with the detail attached — the vocabulary has to stay finite (ADR-0020 E5).
 */
export async function diagnoseSemantic(root: string, deps: SemanticDeps): Promise<SemanticAvailability> {
  const settings = deps.settings ?? readSettings(deps.dataDir).settings
  const connection = connectionOf(settings)
  if (!connection.ok) return unavailable(connection.reason, connection.detail)

  const peer: PeerResolution = resolveOvkPeer(root)
  const peerFields: Partial<SemanticAvailability> = {
    endpoint: connection.connection.endpoint,
    ...(peer.peer === undefined ? {} : { peer: peer.peer }),
    ...(peer.source === undefined ? {} : { peerSource: peer.source }),
    ...(peer.configPath === undefined ? {} : { configPath: peer.configPath }),
  }
  if (peer.peer === undefined) {
    return unavailable('no-peer', peer.detail ?? 'the book has no .openviking peer.id', peerFields)
  }

  const health = await ovkHealth(connection.connection, peer.peer, {
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  })
  if (health.ok) return { backend: 'ovk', ...peerFields }
  const reason: OvkDegradedReason =
    health.failure.reason === 'unauthorized' || health.failure.reason === 'timeout' ? health.failure.reason : 'unreachable'
  return unavailable(reason, health.failure.detail, peerFields)
}

/** Chapter prose as the book holds it — the same reader the rebuild uses. */
function chapterBodyAt(root: string, path: string): string | undefined {
  try {
    return parseMarkdown(readFileSync(join(root, path), 'utf8')).body
  } catch {
    return undefined
  }
}

export interface SemanticSearchOutcome {
  result: SearchEntriesResult
  availability: SemanticAvailability
  /** Semantic hits that made it into the page (0 when the backend is off or silent). */
  semanticHits: number
  /** Hits OVK returned whose URI the ledger could not locate (P7: never guess a chapter). */
  staleHits: number
  /** Hits dropped because the chapter they belong to is deleted (tombstones). */
  tombstoneHits: number
}

/**
 * One search: semantic backend first, keyword entry as the base and the safety net.
 *
 * The answer's shape is unchanged (X-16): this composes two results, it does not invent a
 * third — a caller must not need to know which backend answered beyond
 * `searchBackend`/`degradedReason`.
 */
export async function searchWithSemantic(
  root: string,
  query: string,
  options: SearchEntriesOptions,
  deps: SemanticDeps,
): Promise<SemanticSearchOutcome> {
  const base = searchEntries(root, query, options)
  const settings = deps.settings ?? readSettings(deps.dataDir).settings
  const availability = await diagnoseSemantic(root, { ...deps, settings })
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 20)))
  const radius = Math.max(0, Math.trunc(options.snippet ?? 40))

  if (availability.backend === 'fts5') {
    return { result: annotate(base, availability), availability, semanticHits: 0, staleHits: 0, tombstoneHits: 0 }
  }
  // Only chapter prose is in OVK (ADR-0009 P9). A search that excludes chapters must not
  // pay for a recall it cannot use.
  if (options.kinds !== undefined && !options.kinds.includes('chapters')) {
    return { result: annotate(base, availability), availability, semanticHits: 0, staleHits: 0, tombstoneHits: 0 }
  }
  const connection = connectionOf(settings)
  if (!connection.ok) return { result: annotate(base, availability), availability, semanticHits: 0, staleHits: 0, tombstoneHits: 0 }

  const slug = semanticSlugOf(root)
  const { ledger } = readLedger(deps.dataDir, slug)
  const projectId = ledger.projectId === '' ? projectIdFor(root, slug, ledger) : ledger.projectId
  const recall = await ovkFind(connection.connection, availability.peer ?? '', {
    query,
    targetUri: projectSubtreeUri(projectId),
    limit: Math.min(100, offset + limit),
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  })
  if (!recall.ok) {
    // A server that answered `/health` can still fail a recall (restarted, key rotated).
    // That is a degradation for THIS answer: report it and keep the keywords.
    const degraded: SemanticAvailability = {
      ...availability,
      backend: 'fts5',
      reason:
        recall.failure.reason === 'unauthorized' || recall.failure.reason === 'timeout' ? recall.failure.reason : 'unreachable',
      detail: recall.failure.detail,
    }
    return { result: annotate(base, degraded), availability: degraded, semanticHits: 0, staleHits: 0, tombstoneHits: 0 }
  }

  const chapters = new Map((chapterSources(root) ?? []).map((chapter) => [chapter.id, chapter]))
  const bodyCache = new Map<string, string | undefined>()
  const located = new Map<string, { chapterId: string; block: BlockRecord }>()
  // URIs that belong to a DELETED chapter: they still exist in OVK (that is the point of
  // not calling `forget`), so they are dropped here, and they are not "stale" — the ledger
  // remembers them perfectly.
  const tombstoned = new Set<string>()
  for (const chapter of Object.values(ledger.chapters)) {
    if (!chapter.deleted) continue
    for (const block of chapter.blocks) tombstoned.add(block.uri)
  }
  let stale = 0

  for (const hit of recall.value) {
    const found = findRecordByUri(ledger.chapters, hit.uri)
    if (found !== undefined) {
      if (!located.has(hit.uri)) located.set(hit.uri, found)
      continue
    }
    if (tombstoned.has(hit.uri)) continue
    // P7: never guess a range from the URI's block index — a range that no longer matches
    // the file would show the author text unrelated to their query. A URI this plugin never
    // wrote is not ours to locate; one it wrote but does not remember is stale.
    if (parseBlockUri(hit.uri) !== undefined) stale += 1
  }

  const entries: SearchEntry[] = []
  const seenChapter = new Set<string>()
  for (const hit of recall.value) {
    const found = located.get(hit.uri)
    if (found === undefined) continue
    const chapterId = found.chapterId
    if (seenChapter.has(chapterId)) continue
    const chapter = chapters.get(chapterId)
    if (chapter === undefined) continue
    if (!bodyCache.has(chapterId)) bodyCache.set(chapterId, chapterBodyAt(root, chapter.path))
    const text = bodyCache.get(chapterId) ?? ''
    const start = found.block.charStart
    const end = Math.max(start, Math.min(found.block.charEnd, text.length))
    entries.push({
      kind: 'chapters',
      id: chapterId,
      path: chapter.path,
      title: chapter.title,
      snippet: radius === 0 ? '' : sliceContext(text, start, end - start, radius),
      offset: start,
      score: hit.score,
    })
    seenChapter.add(chapterId)
  }

  const totalStale = stale
  const tombstoneHits = recall.value.filter((hit) => tombstoned.has(hit.uri)).length
  if (!base.ok) {
    // The keyword side has no index but the semantic side answered: that is still a usable
    // answer, so it is returned instead of the INDEX_UNAVAILABLE failure.
    if (entries.length === 0) {
      return { result: annotate(base, availability), availability, semanticHits: 0, staleHits: totalStale, tombstoneHits }
    }
    const page = entries.slice(offset, offset + limit)
    return {
      result: {
        ok: true,
        items: page,
        offset,
        limit,
        total: entries.length,
        truncated: entries.length > offset + page.length,
        mode: 'fts',
        searchBackend: 'ovk',
      },
      availability,
      semanticHits: entries.length,
      staleHits: totalStale,
      tombstoneHits,
    }
  }

  // Keyword hits for chapters the semantic side already named are dropped: the same chapter
  // twice tells the author nothing, and the semantic ordering is the better one.
  const semanticIds = new Set(entries.map((entry) => entry.id))
  const rest = base.items.filter((item) => !(item.kind === 'chapters' && semanticIds.has(item.id)))
  const merged = [...entries, ...rest]
  const page = merged.slice(offset, offset + limit)
  const added = entries.filter((entry) => !base.items.some((item) => item.kind === 'chapters' && item.id === entry.id)).length
  return {
    result: {
      ok: true,
      items: page,
      offset,
      limit,
      total: base.total + added,
      truncated: base.truncated || merged.length > offset + limit,
      mode: base.mode,
      searchBackend: entries.length > 0 ? 'ovk' : 'fts5',
    },
    availability,
    semanticHits: entries.length,
    staleHits: totalStale,
    tombstoneHits,
  }
}

/** Put the degradation on the answer, leaving a healthy one untouched. */
function annotate(result: SearchEntriesResult, availability: SemanticAvailability): SearchEntriesResult {
  if (!result.ok) return result
  if (availability.backend === 'ovk') return { ...result, searchBackend: 'ovk' }
  if (availability.reason === undefined) return result
  return { ...result, searchBackend: 'fts5', degradedReason: availability.reason }
}

/** `uri → chapterId + character range`, from the ledger (the primary mapping, ADR-0009 P7). */
function findRecordByUri(
  chapters: Record<string, ChapterRecord>,
  uri: string,
): { chapterId: string; block: BlockRecord } | undefined {
  for (const [chapterId, chapter] of Object.entries(chapters)) {
    // A tombstone is filtered HERE, not in OVK: the block still exists (that is the point of
    // not calling `forget`), so "do not recall a deleted chapter" is enforced on the side
    // that knows the chapter is deleted (ADR-0009 P6 step 2).
    if (chapter.deleted) continue
    for (const block of chapter.blocks) {
      if (block.uri === uri) return { chapterId, block }
    }
  }
  return undefined
}
