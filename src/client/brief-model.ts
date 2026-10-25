/**
 * Pure view model for the brief page (ADR-0022 D1/D2).
 *
 * Everything here is a plain function over plain data, for the same reason
 * `panel-model.ts` is: `node --test` has no DOM, so the React view is only checked as a
 * built bundle while the decisions — what a segment's state is, how a share is worded,
 * what "已裁掉" looks like — are tested directly.
 *
 * One shape feeds this file: `GET /inkflow/internal/brief`. The Host already decided the
 * segment order, the caps and the ladder; this file never re-derives them. In particular
 * it does **not** recompute `missing`/`truncated`: "no source" and "trimmed away" are two
 * different facts (ADR-0022 D1), and a page that guessed one from `bytes === 0` would be
 * wrong the first time a segment is genuinely empty.
 *
 * No IO, no React, no `@deepseek-ai/*` import (ADR-0008 D4/V7).
 */

import type { InternalResult } from './internal.js'

/** One segment as the channel sends it. */
export interface BriefSegmentValue {
  id: string
  label: string
  bytes: number
  tokens: number
  /** Shortened by its cap, shrunk, or dropped by the trim ladder. */
  truncated: boolean
  /** This book has no source for it — the page says so instead of showing an empty box. */
  missing: boolean
  text: string
}

/** One trim rung that changed something. */
export interface BriefTrimValue {
  segment: string
  before: number
  after: number
  ratio: number
}

/** The payload of `GET /inkflow/internal/brief`. */
export interface BriefValue {
  pluginVersion?: string
  indexRebuilt?: boolean
  indexState?: string
  state?: string
  chapterId?: string
  chapterSeq?: number | null
  chapterPath?: string | null
  budgetTokens?: number
  tokens?: number
  overBudget?: boolean
  rungs?: number
  segments?: BriefSegmentValue[]
  trims?: BriefTrimValue[]
  text?: string
  auditPath?: string
}

/** What one row of the page shows. */
export type BriefSegmentState = 'ok' | 'trimmed' | 'missing'

export interface BriefSegmentRow {
  id: string
  label: string
  bytes: number
  tokens: number
  /** `ok` (present and whole), `trimmed` (cap or ladder touched it), `missing` (no source). */
  state: BriefSegmentState
  /** Share of the whole brief's tokens, already formatted (`'12.3%'`). */
  share: string
  /** One line for the author: what happened to this segment. */
  detail: string
  text: string
}

export interface BriefTrimRow {
  segment: string
  label: string
  before: number
  after: number
  share: string
}

export interface BriefView {
  error: string | null
  chapterId: string | null
  chapterSeq: number | null
  chapterPath: string | null
  budgetTokens: number
  tokens: number
  overBudget: boolean
  rungs: number
  rows: BriefSegmentRow[]
  trims: BriefTrimRow[]
  text: string
  /** Project-relative audit path the write action targets. */
  auditPath: string | null
  /** `true` when the Host rebuilt the derived index to answer. */
  indexRebuilt: boolean
  /** The gate verdict the Host reported (`usable` for any book that got this far). */
  state: string | null
}

export const EMPTY_BRIEF: BriefView = {
  error: null,
  chapterId: null,
  chapterSeq: null,
  chapterPath: null,
  budgetTokens: 0,
  tokens: 0,
  overBudget: false,
  rungs: 0,
  rows: [],
  trims: [],
  text: '',
  auditPath: null,
  indexRebuilt: false,
  state: null,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function nullableNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nullableString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function segmentOf(value: unknown): BriefSegmentValue | undefined {
  if (!isRecord(value)) return undefined
  const id = stringField(value, 'id')
  const label = stringField(value, 'label')
  if (id === undefined || label === undefined) return undefined
  return {
    id,
    label,
    bytes: numberField(value, 'bytes') ?? 0,
    tokens: numberField(value, 'tokens') ?? 0,
    truncated: value['truncated'] === true,
    missing: value['missing'] === true,
    text: stringField(value, 'text') ?? '',
  }
}

function trimOf(value: unknown): BriefTrimValue | undefined {
  if (!isRecord(value)) return undefined
  const segment = stringField(value, 'segment')
  if (segment === undefined) return undefined
  return {
    segment,
    before: numberField(value, 'before') ?? 0,
    after: numberField(value, 'after') ?? 0,
    ratio: numberField(value, 'ratio') ?? 0,
  }
}

/** Percent of the brief's own tokens, one decimal (`0` total renders as `0%`). */
export function formatShare(tokens: number, total: number): string {
  if (total <= 0) return '0%'
  const percent = (tokens / total) * 100
  return `${percent.toFixed(1)}%`
}

/** The one place a segment's state is decided (the Host's two flags, never re-derived). */
export function segmentState(segment: BriefSegmentValue): BriefSegmentState {
  if (segment.missing) return 'missing'
  if (segment.truncated) return 'trimmed'
  // A segment that exists but rendered nothing is still "trimmed" in the only sense the
  // page can act on: the author asked for it and got no text.
  return segment.text === '' ? 'trimmed' : 'ok'
}

function detailOf(segment: BriefSegmentValue, state: BriefSegmentState): string {
  if (state === 'missing') return '本书没有这一段的来源（不占位、不编造）'
  if (segment.text === '') return '已裁掉'
  if (state === 'trimmed') return '被段上限剪短'
  return `${String(segment.bytes)} 字节`
}

/**
 * Turn the channel result into the page's view.
 *
 * Three failure shapes stay apart on purpose, exactly like the foreshadow board: a failed
 * request (`error`), an answer this build cannot read (`error`, because guessing would
 * show zeroes as if the book were empty), and a book whose brief really has all nine
 * segments missing.
 */
export function readBrief(result: InternalResult<BriefValue>): BriefView {
  if (!result.ok) {
    const code = result.error?.code ?? 'REQUEST_FAILED'
    const hint = result.error?.hint ?? result.error?.message ?? ''
    return { ...EMPTY_BRIEF, error: hint === '' ? code : `${code}：${hint}` }
  }
  const value: unknown = result.value
  if (!isRecord(value)) return { ...EMPTY_BRIEF, error: 'BRIEF_UNREADABLE：返回的不是对象' }

  const rawSegments = Array.isArray(value['segments']) ? value['segments'] : []
  const segments = rawSegments.map(segmentOf).filter((entry): entry is BriefSegmentValue => entry !== undefined)
  if (segments.length === 0) {
    return {
      ...EMPTY_BRIEF,
      state: nullableString(value, 'state'),
      error: 'BRIEF_EMPTY：这本书还没有可组装的简报（先建一章）',
    }
  }
  const tokens = numberField(value, 'tokens') ?? 0
  const rawTrims = Array.isArray(value['trims']) ? value['trims'] : []
  const trims = rawTrims.map(trimOf).filter((entry): entry is BriefTrimValue => entry !== undefined)
  const labels = new Map(segments.map((segment) => [segment.id, segment.label]))

  return {
    error: null,
    chapterId: nullableString(value, 'chapterId'),
    chapterSeq: nullableNumber(value, 'chapterSeq'),
    chapterPath: nullableString(value, 'chapterPath'),
    budgetTokens: numberField(value, 'budgetTokens') ?? 0,
    tokens,
    overBudget: value['overBudget'] === true,
    rungs: numberField(value, 'rungs') ?? trims.length,
    rows: segments.map((segment) => {
      const state = segmentState(segment)
      return {
        id: segment.id,
        label: segment.label,
        bytes: segment.bytes,
        tokens: segment.tokens,
        state,
        share: formatShare(segment.tokens, tokens),
        detail: detailOf(segment, state),
        text: segment.text,
      }
    }),
    trims: trims.map((trim) => ({
      segment: trim.segment,
      label: labels.get(trim.segment) ?? trim.segment,
      before: trim.before,
      after: trim.after,
      share: trim.ratio <= 0 ? '—' : `裁掉 ${(trim.ratio * 100).toFixed(0)}%`,
    })),
    text: stringField(value, 'text') ?? '',
    auditPath: nullableString(value, 'auditPath'),
    indexRebuilt: value['indexRebuilt'] === true,
    state: nullableString(value, 'state'),
  }
}
