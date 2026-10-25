/**
 * Issue #46 — the run record: its path, its bytes, reading it back, and the wire shapes
 * the tools and the panel print.
 *
 * Extracted from `review.ts` by #193. A run record is a **fact**, not a cache (ADR-0006 D2 /
 * ADR-0022 D4.5), so its file format is a contract: the schema version, the digest recipe,
 * the key order and every reader that refuses a file it does not understand live here, in
 * one file, so a change of shape cannot land on the write side without meeting the read
 * side in the same place.
 *
 * ## What this module owns
 *
 *   * the path (`.inkflow/review/<chapterId>/<runId>.json`, ADR-0023) and the run id minted
 *     from the wall clock;
 *   * the digest the record carries: the chapter plus the two setting directories the nodes
 *     read, sorted so the walk order cannot change it (the same recipe as #44's gate,
 *     because "is this run about the text I am looking at" is a fact about the bytes);
 *   * the canonical order of the opinions in a record (`sortOpinions`: dimension, offset,
 *     text) — two runs over the same input must not reorder;
 *   * writing (`recordRun` + `renderReviewRunFile`) and reading back (`listReviewRuns`,
 *     `readRunFile` and the defensive readers): a file written by a newer plugin is refused
 *     by `REVIEW_FILE_SCHEMA_VERSION`, never half-understood;
 *   * the projections built on a record: `reviewRunSummary` (one list row) and
 *     `reviewRunWire` (one run, opinions capped, counts over all of them).
 *
 * ## What it refuses to own
 *
 *   * producing or locating opinions (归 `review-nodes.ts` / `review-locate.ts`)；
 *   * reading the chapter and deciding whether to record (归 `review.ts`：`record: false` 是
 *     面板只读通道，且 404 的话术由 route 那一层说）；
 *   * the cross-model table (归 `review-compare.ts`，它读的是本文件交出的记录)。
 */

import { createHash } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import { CONTENT_DIRS } from './conventions.js'
import type { ContentDir } from './conventions.js'
import { readText } from './domains/scan-helpers.js'
import type { FindingGroup, FindingLocator } from './findings.js'
import type { WalkedFile } from './indexer.js'
import { writeTextAtomic } from './io.js'
import { ensurePrivateStateIgnored, privateStateRelative } from './private-state.js'
import {
  REVIEW_DIMENSIONS,
  REVIEW_DIMENSION_CODES,
  REVIEW_DIMENSION_GROUPS,
  REVIEW_DIMENSION_LABELS,
  asDimension,
  asSeverity,
} from './review-nodes.js'
import type { ReviewAnchorValue, ReviewDimension } from './review-nodes.js'
import type { ReviewError, ReviewOpinion, ReviewRejection } from './review-locate.js'

/** Bumped only when the record file's shape changes; a run record is a fact, not a cache. */
export const REVIEW_FILE_SCHEMA_VERSION = 1

/** How many runs a tool reply or the panel prints before saying "and N more". */
export const REVIEW_LIST_LIMIT = 20

export interface ReviewDimensionSummary {
  readonly dimension: ReviewDimension
  readonly label: string
  readonly status: 'ok' | 'failed' | 'skipped'
  readonly opinions: number
  readonly located: number
  readonly anchors: ReviewAnchorValue
  /** Set only when `status` is `failed` (e.g. `REVIEW_NODE_FAILED`). */
  readonly code: string | null
  readonly message: string | null
  /** Set only when `status` is `skipped` (`not-requested`). */
  readonly skipReason: string | null
}

export interface ReviewRunRecord {
  readonly runId: string
  readonly chapterId: string
  readonly chapterPath: string
  readonly chapterTitle: string
  readonly seq: number | undefined
  readonly wordCount: number
  /** The bytes the run depended on (chapter + characters/ + facts/), same recipe as #44. */
  readonly chapterDigest: string
  readonly reviewer: string
  /** ISO instant: a run is an event, so unlike a gate verdict this file is not clock-free. */
  readonly createdAt: string
  readonly dimensions: readonly ReviewDimensionSummary[]
  readonly opinions: readonly ReviewOpinion[]
  readonly rejected: readonly ReviewRejection[]
  readonly scores: Readonly<Record<string, number>> | null
}

export interface ReviewFileResult {
  readonly path: string
  readonly bytes: number
  readonly created: boolean
  readonly ignoreLineAdded: boolean
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The digest the record carries: the chapter plus the two setting directories the nodes
 * read, sorted so the walk order cannot change it. Same recipe as #44's `chapterDigest`,
 * for the same reason — "is this run about the text I am looking at" is a fact about the
 * bytes, not about the file name.
 */
export function digestOf(root: string, chapterPath: string, files: readonly WalkedFile[]): string {
  const inputs = [
    chapterPath,
    ...files.filter((file) => file.dir === 'characters' || file.dir === 'facts').map((file) => file.path),
  ].sort()
  const body = inputs.map((path) => `${path}\u0000${sha256(readText(join(root, path)))}`).join('\n')
  return sha256(`review-inputs-v1\n${body}\n`)
}

/** `20261025T095501123Z`: sortable, no separators a Windows path would reject. */
export function reviewRunId(now: Date): string {
  const iso = now.toISOString()
  const [date, time] = iso.split('T')
  const stamp = (time ?? '').replace('Z', '').replaceAll(':', '').replaceAll('.', '')
  return `${(date ?? '').replaceAll('-', '')}T${stamp}Z`
}

/** A chapter id made safe for one directory name; nothing else is allowed to leak in. */
function safeChapterId(chapterId: string): string {
  const safe = chapterId.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return safe === '' ? 'chapter' : safe
}

/** `.inkflow/review/<chapterId>` — the run directory ([ADR-0023](.agents/adrs/0023-proposal-job-private-placement.md)). */
export function reviewDirOf(chapterId: string): string {
  return privateStateRelative('review', safeChapterId(chapterId))
}

/** `.inkflow/review/<chapterId>/<runId>.json` — one run's record. */
export function reviewRunPath(chapterId: string, runId: string): string {
  const safeRun = runId.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return `${reviewDirOf(chapterId)}/${safeRun === '' ? 'run' : safeRun}.json`
}

/** Sort opinions so two runs over the same input cannot reorder: dimension, offset, text. */
export function sortOpinions(opinions: readonly ReviewOpinion[]): ReviewOpinion[] {
  const dimensionOrder = (dimension: ReviewDimension): number => REVIEW_DIMENSIONS.indexOf(dimension)
  return [...opinions].sort((left, right) => {
    const byDimension = dimensionOrder(left.dimension) - dimensionOrder(right.dimension)
    if (byDimension !== 0) return byDimension
    const leftOffset = left.evidence === null ? Number.MAX_SAFE_INTEGER : left.evidence.offset
    const rightOffset = right.evidence === null ? Number.MAX_SAFE_INTEGER : right.evidence.offset
    if (leftOffset !== rightOffset) return leftOffset - rightOffset
    if (left.detail === right.detail) return 0
    return left.detail < right.detail ? -1 : 1
  })
}

type RecordOutcome =
  | { readonly ok: true; readonly file: ReviewFileResult }
  | { readonly ok: false; readonly error: ReviewError }

export function recordRun(root: string, run: ReviewRunRecord): RecordOutcome {
  const relative = reviewRunPath(run.chapterId, run.runId)
  const ignored = ensurePrivateStateIgnored(root)
  const written = writeTextAtomic(root, relative, renderReviewRunFile(run))
  if (!written.ok) {
    return {
      ok: false,
      error: {
        code: written.error.code,
        message: written.error.message,
        hint: 'the run record lives under .inkflow/review/; check the write lock and the path rules',
      },
    }
  }
  return {
    ok: true,
    file: {
      path: relative,
      bytes: written.bytes,
      created: written.created,
      ignoreLineAdded: ignored.ok && ignored.added,
    },
  }
}

// ---------------------------------------------------------------------------
// Serialisation: the record is a contract, so the key order is part of it

function locatorRecord(locator: FindingLocator | null): Record<string, unknown> | null {
  if (locator === null) return null
  switch (locator.kind) {
    case 'entity':
      return { kind: 'entity', entityKind: locator.entityKind, id: locator.id }
    case 'chapter':
      return { kind: 'chapter', chapterId: locator.chapterId }
    case 'catalog':
      return locator.volumeId === undefined ? { kind: 'catalog' } : { kind: 'catalog', volumeId: locator.volumeId }
    case 'path':
      return locator.line === undefined
        ? { kind: 'path', path: locator.path }
        : { kind: 'path', path: locator.path, line: locator.line }
  }
}

export function reviewOpinionRecord(opinion: ReviewOpinion): Record<string, unknown> {
  return {
    dimension: opinion.dimension,
    code: opinion.code,
    group: opinion.group,
    severity: opinion.severity,
    locator: locatorRecord(opinion.locator),
    located: opinion.located,
    unlocatedReason: opinion.unlocatedReason,
    unlocatedDetail: opinion.unlocatedDetail,
    detail: opinion.detail,
    hint: opinion.hint,
    fixable: opinion.fixable,
    evidence:
      opinion.evidence === null
        ? null
        : {
            before: opinion.evidence.before,
            quote: opinion.evidence.quote,
            after: opinion.evidence.after,
            paragraph: opinion.evidence.paragraph,
            offset: opinion.evidence.offset,
            source: opinion.evidence.source,
          },
  }
}

function anchorsRecord(anchors: ReviewAnchorValue): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(anchors)) out[key] = value
  return out
}

function dimensionRecord(summary: ReviewDimensionSummary): Record<string, unknown> {
  return {
    dimension: summary.dimension,
    label: summary.label,
    status: summary.status,
    opinions: summary.opinions,
    located: summary.located,
    anchors: anchorsRecord(summary.anchors),
    code: summary.code,
    message: summary.message,
    skipReason: summary.skipReason,
  }
}

/**
 * The record's bytes.
 *
 * Unlike the gate's conclusion this file **is** clock-stamped (`createdAt` + the run id):
 * ADR-0022 D4.5 draws that line — a verdict about a chapter is the same bytes twice, a
 * *run* is an event, and the reviewer's opinions are not reproducible because the model
 * that produced them is not part of this plugin (X-26).
 */
export function renderReviewRunFile(run: ReviewRunRecord): string {
  const payload = {
    schemaVersion: REVIEW_FILE_SCHEMA_VERSION,
    runId: run.runId,
    chapterId: run.chapterId,
    chapterPath: run.chapterPath,
    chapterTitle: run.chapterTitle,
    seq: run.seq ?? null,
    wordCount: run.wordCount,
    chapterDigest: run.chapterDigest,
    reviewer: run.reviewer,
    createdAt: run.createdAt,
    scores: run.scores,
    dimensions: run.dimensions.map((summary) => dimensionRecord(summary)),
    rejected: run.rejected.map((rejection) => ({
      index: rejection.index,
      code: rejection.code,
      message: rejection.message,
    })),
    opinions: run.opinions.map((opinion) => reviewOpinionRecord(opinion)),
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/** Counts over everything, printing only the first `limit` opinions (the record keeps all). */
export function reviewRunWire(run: ReviewRunRecord, limit = REVIEW_LIST_LIMIT * 5): Record<string, unknown> {
  const capped = run.opinions.slice(0, Math.max(0, limit))
  const located = run.opinions.filter((opinion) => opinion.located).length
  return {
    runId: run.runId,
    chapterId: run.chapterId,
    chapterPath: run.chapterPath,
    chapterTitle: run.chapterTitle,
    seq: run.seq ?? null,
    wordCount: run.wordCount,
    chapterDigest: run.chapterDigest,
    reviewer: run.reviewer,
    createdAt: run.createdAt,
    scores: run.scores,
    counts: {
      opinions: run.opinions.length,
      located,
      unlocated: run.opinions.length - located,
      ok: run.dimensions.filter((summary) => summary.status === 'ok').length,
      failed: run.dimensions.filter((summary) => summary.status === 'failed').length,
      skipped: run.dimensions.filter((summary) => summary.status === 'skipped').length,
      rejected: run.rejected.length,
    },
    dimensions: run.dimensions.map((summary) => dimensionRecord(summary)),
    rejected: run.rejected.map((rejection) => ({
      index: rejection.index,
      code: rejection.code,
      message: rejection.message,
    })),
    opinions: capped.map((opinion) => reviewOpinionRecord(opinion)),
    returned: capped.length,
    truncated: run.opinions.length > capped.length,
    recordPath: reviewRunPath(run.chapterId, run.runId),
  }
}

// ---------------------------------------------------------------------------
// Reading runs back: the panel's list, and the comparison table's input

export interface ReviewRunList {
  readonly runs: readonly ReviewRunRecord[]
  /** Files under the run directory that could not be read as a record (never silently nothing). */
  readonly skippedFiles: readonly string[]
}

/**
 * Every recorded run of one chapter, newest first.
 *
 * Newest first is the run id sorted descending, which works because `reviewRunId` is a
 * fixed-width UTC stamp — no directory mtime, so a `git clone` or a copy keeps the order.
 */
export function listReviewRuns(root: string, chapterId: string): ReviewRunList {
  const dir = reviewDirOf(chapterId)
  let names: string[]
  try {
    names = readdirSync(join(root, ...dir.split('/')))
  } catch {
    return { runs: [], skippedFiles: [] }
  }
  const runs: ReviewRunRecord[] = []
  const skippedFiles: string[] = []
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.json')) continue
    const record = readRunFile(root, `${dir}/${name}`)
    if (record === undefined) skippedFiles.push(`${dir}/${name}`)
    else runs.push(record)
  }
  runs.sort((left, right) => (left.runId < right.runId ? 1 : left.runId > right.runId ? -1 : 0))
  skippedFiles.sort()
  return { runs, skippedFiles }
}

function readRunFile(root: string, relative: string): ReviewRunRecord | undefined {
  let text: string
  try {
    text = readText(join(root, ...relative.split('/')))
  } catch {
    return undefined
  }
  if (text === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/u, ''))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const raw = parsed as Record<string, unknown>
  // Tolerant on purpose: the reader's job is to show what is there, and a hand-edited or
  // half-written record must not take the whole panel down with it. Anything that cannot
  // supply the fields the panel needs is reported as a skipped file by the caller.
  const runId = typeof raw['runId'] === 'string' ? raw['runId'] : undefined
  const runChapterId = typeof raw['chapterId'] === 'string' ? raw['chapterId'] : undefined
  if (runId === undefined || runChapterId === undefined) return undefined
  const dimensionsRaw = Array.isArray(raw['dimensions']) ? (raw['dimensions'] as unknown[]) : []
  const opinionsRaw = Array.isArray(raw['opinions']) ? (raw['opinions'] as unknown[]) : []
  const rejectedRaw = Array.isArray(raw['rejected']) ? (raw['rejected'] as unknown[]) : []
  return {
    runId,
    chapterId: runChapterId,
    chapterPath: typeof raw['chapterPath'] === 'string' ? raw['chapterPath'] : '',
    chapterTitle: typeof raw['chapterTitle'] === 'string' ? raw['chapterTitle'] : '',
    seq: typeof raw['seq'] === 'number' ? raw['seq'] : undefined,
    wordCount: typeof raw['wordCount'] === 'number' ? raw['wordCount'] : 0,
    chapterDigest: typeof raw['chapterDigest'] === 'string' ? raw['chapterDigest'] : '',
    reviewer: typeof raw['reviewer'] === 'string' ? raw['reviewer'] : 'unknown',
    createdAt: typeof raw['createdAt'] === 'string' ? raw['createdAt'] : '',
    dimensions: dimensionsRaw.map((entry) => readDimensionSummary(entry)).filter((entry): entry is ReviewDimensionSummary => entry !== undefined),
    opinions: opinionsRaw.map((entry) => readOpinion(entry)).filter((entry): entry is ReviewOpinion => entry !== undefined),
    rejected: rejectedRaw
      .map((entry) => readRejection(entry))
      .filter((entry): entry is ReviewRejection => entry !== undefined),
    scores: readScores(raw['scores']),
  }
}

function readScores(raw: unknown): Readonly<Record<string, number>> | null {
  if (typeof raw !== 'object' || raw === null) return null
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (asDimension(key) === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    out[key] = value
  }
  return Object.keys(out).length === 0 ? null : out
}

function readRejection(raw: unknown): ReviewRejection | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  if (typeof record['code'] !== 'string') return undefined
  return {
    index: typeof record['index'] === 'number' ? record['index'] : 0,
    code: record['code'],
    message: typeof record['message'] === 'string' ? record['message'] : '',
  }
}

function readDimensionSummary(raw: unknown): ReviewDimensionSummary | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const dimension = asDimension(typeof record['dimension'] === 'string' ? record['dimension'] : '')
  if (dimension === undefined) return undefined
  const status = record['status']
  const anchorsRaw = typeof record['anchors'] === 'object' && record['anchors'] !== null ? (record['anchors'] as Record<string, unknown>) : {}
  const anchors: Record<string, number | string | readonly string[]> = {}
  for (const [key, value] of Object.entries(anchorsRaw)) {
    if (typeof value === 'number' || typeof value === 'string') anchors[key] = value
    else if (Array.isArray(value)) anchors[key] = value.filter((item): item is string => typeof item === 'string')
  }
  return {
    dimension,
    label: typeof record['label'] === 'string' ? record['label'] : REVIEW_DIMENSION_LABELS[dimension],
    status: status === 'failed' ? 'failed' : status === 'skipped' ? 'skipped' : 'ok',
    opinions: typeof record['opinions'] === 'number' ? record['opinions'] : 0,
    located: typeof record['located'] === 'number' ? record['located'] : 0,
    anchors,
    code: typeof record['code'] === 'string' ? record['code'] : null,
    message: typeof record['message'] === 'string' ? record['message'] : null,
    skipReason: typeof record['skipReason'] === 'string' ? record['skipReason'] : null,
  }
}

function readLocator(raw: unknown): FindingLocator | null {
  if (typeof raw !== 'object' || raw === null) return null
  const record = raw as Record<string, unknown>
  switch (record['kind']) {
    case 'entity': {
      const kind = record['entityKind']
      if (typeof kind !== 'string' || typeof record['id'] !== 'string') return null
      if (!(CONTENT_DIRS as readonly string[]).includes(kind)) return null
      return { kind: 'entity', entityKind: kind as ContentDir, id: record['id'] }
    }
    case 'chapter':
      return typeof record['chapterId'] === 'string' ? { kind: 'chapter', chapterId: record['chapterId'] } : null
    case 'catalog':
      return typeof record['volumeId'] === 'string' ? { kind: 'catalog', volumeId: record['volumeId'] } : { kind: 'catalog' }
    case 'path':
      if (typeof record['path'] !== 'string') return null
      return typeof record['line'] === 'number'
        ? { kind: 'path', path: record['path'], line: record['line'] }
        : { kind: 'path', path: record['path'] }
    default:
      return null
  }
}

function readOpinion(raw: unknown): ReviewOpinion | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const dimension = asDimension(typeof record['dimension'] === 'string' ? record['dimension'] : '')
  if (dimension === undefined) return undefined
  const located = record['located'] === true
  const locator = located ? readLocator(record['locator']) : null
  const evidenceRaw = typeof record['evidence'] === 'object' && record['evidence'] !== null ? (record['evidence'] as Record<string, unknown>) : null
  const source = evidenceRaw?.['source']
  return {
    dimension,
    code: typeof record['code'] === 'string' ? record['code'] : REVIEW_DIMENSION_CODES[dimension],
    group:
      typeof record['group'] === 'string'
        ? (record['group'] as FindingGroup)
        : REVIEW_DIMENSION_GROUPS[dimension],
    severity: asSeverity(typeof record['severity'] === 'string' ? record['severity'] : undefined),
    locator,
    // One fact written twice: a record whose `located` and `locator` disagree is read as
    // unlocated, because the jump path is what would otherwise break.
    located: located && locator !== null,
    unlocatedReason: typeof record['unlocatedReason'] === 'string' ? record['unlocatedReason'] : null,
    unlocatedDetail: typeof record['unlocatedDetail'] === 'string' ? record['unlocatedDetail'] : null,
    detail: typeof record['detail'] === 'string' ? record['detail'] : '',
    hint: typeof record['hint'] === 'string' ? record['hint'] : '',
    fixable: false,
    evidence:
      evidenceRaw === null
        ? null
        : {
            before: typeof evidenceRaw['before'] === 'string' ? evidenceRaw['before'] : '',
            quote: typeof evidenceRaw['quote'] === 'string' ? evidenceRaw['quote'] : '',
            after: typeof evidenceRaw['after'] === 'string' ? evidenceRaw['after'] : '',
            paragraph: typeof evidenceRaw['paragraph'] === 'number' ? evidenceRaw['paragraph'] : null,
            offset: typeof evidenceRaw['offset'] === 'number' ? evidenceRaw['offset'] : 0,
            source:
              source === 'quote' || source === 'paragraph' || source === 'offset' || source === 'line'
                ? source
                : 'offset',
          },
  }
}

// ---------------------------------------------------------------------------
// The two channel projections (read-only: the panel never writes a run)

/** One run reduced to what a list row needs. */
export function reviewRunSummary(run: ReviewRunRecord): Record<string, unknown> {
  const located = run.opinions.filter((opinion) => opinion.located).length
  return {
    runId: run.runId,
    reviewer: run.reviewer,
    createdAt: run.createdAt,
    chapterDigest: run.chapterDigest,
    opinions: run.opinions.length,
    located,
    failed: run.dimensions.filter((summary) => summary.status === 'failed').length,
    skipped: run.dimensions.filter((summary) => summary.status === 'skipped').length,
    scores: run.scores,
  }
}
