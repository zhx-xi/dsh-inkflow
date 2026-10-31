/**
 * How much of THIS book lives in OpenViking — the coverage question.
 *
 * WHY IT IS A SEPARATE QUESTION. "语义检索可用" used to be one word for three different
 * facts: the backend answers `/health`, this book has been written into it, and a given
 * search actually hit something. A book whose peer is configured but whose rebuild never
 * ran has 0 blocks; the panel still said 「可用」 and every search paid a round trip that
 * could not possibly return a hit. The three are therefore answered separately:
 *
 *   * **backend** — `diagnoseSemantic` in `ovk-search.ts` (one health probe);
 *   * **book coverage** — this module (local files only, no network at all);
 *   * **actual recall** — `searchWithSemantic`, which now short-circuits when this module
 *     says the book has nothing to recall.
 *
 * WHY IT IS CHEAP ENOUGH FOR THE BOOK LIST. The hub draws one of these per registered book
 * (up to 200) on every refresh, so the whole computation is: the plugin settings (read once
 * for the list by the caller), two `existsSync`/reads for the peer layer, one ledger file,
 * and one read-only pass over the derived index's chapter rows (the ids are needed anyway —
 * a chapter deleted from the tree but not yet tombstoned must not count as covered). No
 * socket, no rebuild, no scan of the prose. A book that is not configured at all stops after
 * the settings/peer files, which is why 200 unconfigured books still answer instantly.
 *
 * WHY THE CHAPTER LIST COMES FROM THE INDEX. "落后 N 章" is only meaningful as the same
 * arithmetic a rebuild would do: `chapterSources()` walks `listAllChapters()`, so that is
 * the list used here. Counting `chapters/*.md` would answer about the filesystem, not about
 * the book the index knows (`a deleted file that the index has not dropped yet` must not
 * count as covered, and a chapter whose blocks were tombstoned must not either).
 *
 * WHAT IT DELIBERATELY DOES NOT SAY. There is no timestamp in any headline — the author's
 * ruling for the book-list badge, and it is the same data here. Content-level staleness
 * ("the blocks exist but the prose changed since") is NOT visible from block counts at all;
 * that question is answered by the rebuild estimate (`estimateRebuild().pending`), which
 * hashes bodies, and it stays on the settings page where paying for prose reads is fine.
 */

import { listAllChapters } from './indexer.js'
import { connectionOf, resolveOvkPeer } from './ovk.js'
import { readLedger, semanticSlugOf } from './ovk-ledger.js'
import type { SemanticLedger } from './ovk-ledger.js'
import { readSettings } from './settings.js'
import type { InkflowSettings } from './settings.js'

/**
 * The five states a book can be in, in the order they become true:
 *
 *   `unconfigured` settings off / no endpoint / no peer — nothing can be built yet;
 *   `no-ledger`    configured, but this machine has never written a block for the book;
 *   `no-blocks`    configured, a ledger exists (or the book was never indexed) and the book
 *                  still has no live block, so a recall cannot hit it;
 *   `partial`      some chapters have blocks, some do not (= "落后 N 章");
 *   `complete`     every chapter the index lists has at least one live block.
 */
export type SemanticCoverageState = 'unconfigured' | 'no-ledger' | 'no-blocks' | 'partial' | 'complete'

/** Why nothing can be built: the same fixed words the availability verdict uses. */
export type SemanticCoverageGap = 'disabled' | 'no-endpoint' | 'no-peer'

export interface SemanticCoverage {
  state: SemanticCoverageState
  /** Present exactly when `state === 'unconfigured'`. */
  reason?: SemanticCoverageGap
  /** `false` = never built here (the "还没有索引账本" case), as opposed to "built and emptied". */
  hasLedger: boolean
  /** Live blocks (tombstones excluded: they exist only to be purged, a recall drops them). */
  blocks: number
  /** Chapter records whose blocks are tombstones (deleted chapters kept for the purge). */
  tombstones: number
  /** Chapters of THIS book that have at least one live block. */
  coveredChapters: number
  /** Chapters the derived index lists; `null` = unreadable, so no ratio can be claimed. */
  bookChapters: number | null
  /** `bookChapters - coveredChapters` floored at 0; `null` when the count is unknown. */
  behind: number | null
  /**
   * The one sentence both channels print (`设置页` and `inkflow_semantic_status`), so the
   * panel and the model cannot drift into two ways of saying the same thing.
   */
  headline: string
}

/** The facts a headline is derived from — everything that needs IO has been read. */
export interface CoverageFacts {
  reason?: SemanticCoverageGap
  hasLedger: boolean
  blocks: number
  tombstones: number
  coveredChapters: number
  bookChapters: number | null
}

export interface SemanticCoverageDeps {
  readonly dataDir: string
  /** Settings the caller already read — the book list reads them once for every row. */
  readonly settings?: InkflowSettings
}

/**
 * `N/M 章`, or the honest `N 章` when the index cannot say how many there are.
 *
 * A ratio with an invented denominator is the failure mode this whole file exists to
 * avoid, so an unreadable index degrades the sentence instead of the number being guessed.
 */
function ratio(covered: number, total: number | null): string {
  return total === null ? `${String(covered)} 章` : `${String(covered)}/${String(total)} 章`
}

/** The sentence for one state. The only copy of this wording in the plugin. */
function headlineOf(state: SemanticCoverageState, covered: number, total: number | null): string {
  switch (state) {
    case 'no-ledger':
      return '还没有索引账本（从未建过块）'
    case 'no-blocks':
      return total === null
        ? '未建块 —— 语义召回不会命中这本书'
        : `未建块（0/${String(total)} 章）—— 语义召回不会命中这本书`
    case 'partial': {
      const behind = total === null ? null : Math.max(0, total - covered)
      if (behind === null) return `覆盖 ${ratio(covered, total)}（索引读不出来，落后多少未知）`
      return `覆盖 ${ratio(covered, total)}（落后 ${String(behind)} 章，下次重建会补齐）`
    }
    case 'complete':
      return total === null ? '已同步' : `已同步（${String(total)}/${String(total)} 章）`
    case 'unconfigured':
      // Never printed: both channels report the availability reason instead (a book with no
      // peer must not be told "未建块", which would point at the wrong fix).
      return ''
  }
}

/**
 * The pure half: facts in, verdict out.
 *
 * `no-blocks` is decided on COVERED chapters, not on the ledger's block count, because a
 * ledger can hold blocks for chapters this book no longer lists (deleted from the tree but
 * not yet tombstoned). Those blocks exist in OVK and are dropped on the recall side, so
 * counting them as coverage would claim a recall that cannot happen.
 */
export function coverageOf(facts: CoverageFacts): SemanticCoverage {
  const { reason, hasLedger, blocks, tombstones, coveredChapters, bookChapters } = facts
  const state: SemanticCoverageState =
    reason !== undefined
      ? 'unconfigured'
      : coveredChapters === 0
        ? hasLedger
          ? 'no-blocks'
          : 'no-ledger'
        : bookChapters !== null && coveredChapters >= bookChapters
          ? 'complete'
          : 'partial'
  const behind = bookChapters === null ? null : Math.max(0, bookChapters - coveredChapters)
  return {
    state,
    ...(reason === undefined ? {} : { reason }),
    hasLedger,
    blocks,
    tombstones,
    coveredChapters,
    bookChapters,
    behind,
    headline: headlineOf(state, coveredChapters, bookChapters),
  }
}

/** Live blocks and live chapter records: tombstones are kept for the purge, not for recall. */
function countLedger(ledger: SemanticLedger, bookIds: ReadonlySet<string> | undefined): {
  blocks: number
  tombstones: number
  covered: number
} {
  let blocks = 0
  let tombstones = 0
  let covered = 0
  for (const [chapterId, record] of Object.entries(ledger.chapters)) {
    if (record.deleted) {
      tombstones += 1
      continue
    }
    blocks += record.blocks.length
    const inBook = bookIds === undefined || bookIds.has(chapterId)
    if (inBook && record.blocks.length > 0) covered += 1
  }
  return { blocks, tombstones, covered }
}

/**
 * Read this book's coverage from local files only — **never** the network.
 *
 * The order is the order an author can fix things in: settings, peer, ledger, index. A book
 * with no peer never reads a ledger, so the common "this machine has five books and none of
 * them is configured" refresh costs two `existsSync` per row.
 */
export function semanticCoverageOf(root: string, deps: SemanticCoverageDeps): SemanticCoverage {
  const settings = deps.settings ?? readSettings(deps.dataDir).settings
  const connection = connectionOf(settings)
  if (!connection.ok) {
    return coverageOf({ reason: connection.reason, hasLedger: false, blocks: 0, tombstones: 0, coveredChapters: 0, bookChapters: null })
  }
  const peer = resolveOvkPeer(root)
  if (peer.peer === undefined) {
    return coverageOf({ reason: 'no-peer', hasLedger: false, blocks: 0, tombstones: 0, coveredChapters: 0, bookChapters: null })
  }

  const { ledger, fresh } = readLedger(deps.dataDir, semanticSlugOf(root))
  const chapters = listAllChapters(root)
  const bookIds = chapters === undefined ? undefined : new Set(chapters.map((chapter) => chapter.id))
  const bookChapters = chapters === undefined ? null : chapters.length
  const counted = countLedger(ledger, bookIds)
  return coverageOf({
    hasLedger: fresh,
    blocks: counted.blocks,
    tombstones: counted.tombstones,
    coveredChapters: counted.covered,
    bookChapters,
  })
}
