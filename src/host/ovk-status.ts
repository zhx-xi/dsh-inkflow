/**
 * The three semantic operations as plain functions (#41), so the tool surface and the
 * settings panel answer from ONE implementation.
 *
 * Why this module exists: the same three questions are asked on two channels — the model
 * asks through `inkflow_semantic_*` (session-scoped, project resolved from the cwd) and the
 * panel asks through `/inkflow/internal/hub/semantic*` (root-scoped, book named by a
 * registry anchor). The anchoring differs; what "status", "rebuild" and "purge" MEAN must
 * not. The glue that differs (project gate vs. registry lookup, wire shape vs. tool reply)
 * stays in those two callers.
 *
 * Read-only by default: `semanticStatusOf` touches no network beyond one health probe and
 * writes nothing; `rebuildNow` needs the caller to have already decided `confirm`;
 * `purgeApply` is the only function here that deletes anything in OVK.
 */

import { readSettings } from './settings.js'
import { OVK_FIRST_BUILD_BYTES, OVK_FIRST_BUILD_CHAPTERS, connectionOf, ovkForget, resolveOvkPeer } from './ovk.js'
import type { OvkDegradedReason } from './ovk.js'
import type { RebuildSummary } from './ovk-ledger.js'
import { blockCountOf, readLedger, semanticSlugOf, tombstonedUrisOf, writeLedger } from './ovk-ledger.js'
import { diagnoseSemantic } from './ovk-search.js'
import type { SemanticAvailability } from './ovk-search.js'
import { enqueueRebuild, planOnly, queueSnapshotOf, resetQueue } from './ovk-queue.js'
import type { QueueSnapshot, RebuildOutcome, SemanticRuntime } from './ovk-queue.js'

export interface SemanticOpsDeps {
  readonly dataDir: string
  /** Per-request timeout; tests lower it (ADR-0020 E6). */
  readonly timeoutMs?: number
}

export interface SemanticStatus {
  availability: SemanticAvailability
  settings: { enabled: boolean; endpoint: string | null; apiKeySet: boolean }
  peer: { id: string | null; source: string | null; configPath: string | null }
  ledger: {
    projectId: string | null
    /** `false` = no usable ledger for this book on this machine. */
    fresh: boolean
    chapters: number
    blocks: number
    tombstones: number
    lastRebuild: RebuildSummary | null
  }
  queue: QueueSnapshot
  thresholds: { chapters: number; bytes: number }
}

/** Everything the status surfaces report, composed once. */
export async function semanticStatusOf(root: string, deps: SemanticOpsDeps): Promise<SemanticStatus> {
  const settings = readSettings(deps.dataDir).settings
  const availability = await diagnoseSemantic(root, {
    dataDir: deps.dataDir,
    settings,
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  })
  const slug = semanticSlugOf(root)
  const { ledger, fresh } = readLedger(deps.dataDir, slug)
  const peer = resolveOvkPeer(root)
  return {
    availability,
    settings: {
      enabled: settings.semanticSearch === true,
      endpoint: settings.semanticEndpoint ?? null,
      apiKeySet: settings.semanticApiKey !== undefined,
    },
    peer: {
      id: peer.peer ?? null,
      source: peer.source ?? peer.problem ?? null,
      configPath: peer.configPath ?? null,
    },
    ledger: {
      projectId: ledger.projectId === '' ? null : ledger.projectId,
      fresh,
      chapters: Object.keys(ledger.chapters).length,
      blocks: blockCountOf(ledger),
      tombstones: Object.values(ledger.chapters).filter((chapter) => chapter.deleted).length,
      lastRebuild: ledger.lastRebuild ?? null,
    },
    queue: queueSnapshotOf(root),
    thresholds: { chapters: OVK_FIRST_BUILD_CHAPTERS, bytes: OVK_FIRST_BUILD_BYTES },
  }
}

/** The estimate a `confirm`-less rebuild answers, plus whether that confirm is mandatory. */
export interface RebuildEstimate {
  chapters: number
  pending: number
  blocks: number
  bytes: number
  calls: number
  unchanged: number
  tombstones: number
  totalBlocks: number
  /** True when the book is above ADR-0009 P10's thresholds and `confirm` is required. */
  requiresConfirm: boolean
}

export function estimateRebuild(root: string, deps: SemanticOpsDeps): { ok: true; estimate: RebuildEstimate } | { ok: false } {
  const plan = planOnly({ root, dataDir: deps.dataDir })
  if (!plan.ok) return { ok: false }
  const requiresConfirm = plan.blocks > 0 && (plan.chapters > OVK_FIRST_BUILD_CHAPTERS || plan.bytes > OVK_FIRST_BUILD_BYTES)
  return {
    ok: true,
    estimate: {
      chapters: plan.chapters,
      pending: plan.pending,
      blocks: plan.blocks,
      bytes: plan.bytes,
      calls: plan.calls,
      unchanged: plan.unchanged,
      tombstones: plan.tombstones,
      totalBlocks: plan.totalBlocks,
      requiresConfirm,
    },
  }
}

export type RuntimeResult = { ok: true; runtime: SemanticRuntime } | { ok: false; reason: OvkDegradedReason; detail: string }

/** The runtime a rebuild/purge needs, or the same fixed reasons the status reports. */
export function runtimeOf(root: string, deps: SemanticOpsDeps): RuntimeResult {
  const settings = readSettings(deps.dataDir).settings
  const connection = connectionOf(settings)
  if (!connection.ok) return { ok: false, reason: connection.reason, detail: connection.detail }
  const peer = resolveOvkPeer(root)
  if (peer.peer === undefined) {
    return { ok: false, reason: 'no-peer', detail: peer.detail ?? 'the book has no .openviking peer.id' }
  }
  const runtime: SemanticRuntime = {
    root,
    dataDir: deps.dataDir,
    connection: connection.connection,
    peer: peer.peer,
    ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
  }
  return { ok: true, runtime }
}

/** Run the rebuild through the per-book queue (serial + coalesced). */
export async function rebuildNow(root: string, deps: SemanticOpsDeps): Promise<{ ok: true; outcome: RebuildOutcome } | { ok: false; reason: OvkDegradedReason; detail: string }> {
  const runtime = runtimeOf(root, deps)
  if (!runtime.ok) return runtime
  const outcome = await enqueueRebuild(runtime.runtime, { debounceMs: 0 })
  return { ok: true, outcome }
}

/** What a purge would remove: tombstoned block URIs only, never a live chapter's. */
export function purgePlanOf(root: string, deps: SemanticOpsDeps): string[] {
  const { ledger } = readLedger(deps.dataDir, semanticSlugOf(root))
  return tombstonedUrisOf(ledger)
}

export interface PurgeOutcome {
  deleted: string[]
  /** Present only when the run stopped: the URI it stopped at and why. */
  stoppedAt?: { uri: string; reason: string; detail: string }
}

/**
 * Delete the plan's URIs one at a time, stopping at the first failure (ADR-0009 P6 step 3).
 *
 * The ledger only loses the entries that are actually gone; anything left stays listed, so
 * running this again retries exactly the remainder.
 */
export async function purgeApply(root: string, deps: SemanticOpsDeps): Promise<{ ok: true; outcome: PurgeOutcome } | { ok: false; reason: OvkDegradedReason; detail: string }> {
  const runtime = runtimeOf(root, deps)
  if (!runtime.ok) return runtime
  const slug = semanticSlugOf(root)
  const { ledger } = readLedger(deps.dataDir, slug)
  const deleted: string[] = []
  let stoppedAt: PurgeOutcome['stoppedAt']
  for (const uri of tombstonedUrisOf(ledger)) {
    const answer = await ovkForget(runtime.runtime.connection, runtime.runtime.peer, {
      uri,
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
    })
    if (!answer.ok) {
      stoppedAt = { uri, reason: answer.failure.reason, detail: answer.failure.detail }
      break
    }
    deleted.push(uri)
  }
  if (deleted.length === 0) return { ok: true, outcome: { deleted, ...(stoppedAt === undefined ? {} : { stoppedAt }) } }
  const gone = new Set(deleted)
  for (const [chapterId, chapter] of Object.entries(ledger.chapters)) {
    if (!chapter.deleted) continue
    const remaining = chapter.blocks.filter((block) => !gone.has(block.uri))
    if (remaining.length === 0) delete ledger.chapters[chapterId]
    else ledger.chapters[chapterId] = { ...chapter, blocks: remaining }
  }
  writeLedger(deps.dataDir, slug, ledger)
  if (stoppedAt === undefined) resetQueue(root)
  return { ok: true, outcome: { deleted, ...(stoppedAt === undefined ? {} : { stoppedAt }) } }
}
