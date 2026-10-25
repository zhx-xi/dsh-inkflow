/**
 * The brief's audit record, its preview payload and the one write it causes (issue #43,
 * ADR-0022 D1/D4, roadmap X-23/X-25).
 *
 * WHY THE AUDIT IS A SEPARATE FILE FROM THE PREVIEW: the preview answers "what would the
 * model see right now?"; the audit answers "what did it see, and why is this segment
 * missing?" across runs. Both are produced by the SAME call (`briefFor`) so they cannot
 * disagree — the acceptance test compares them field by field rather than trusting the
 * author to notice a drift.
 *
 * WHY `.inkflow/audit/` AND NOT `index/`: `index/` is a rebuildable cache (ADR-0006 D2 —
 * delete it and it comes back empty), so a conclusion stored there disappears the first
 * time someone rebuilds. `.inkflow/audit/` is private state (ADR-0012, ADR-0023), already
 * on the write whitelist, and already git-ignored.
 *
 * WHY THE FILE NAME HAS NO TIMESTAMP: it answers "this chapter's brief now", not "the
 * brief of run 1234". A stamped name makes every run a new file, so `git diff` can never
 * show that nothing changed. Same-input-same-bytes is also why the record carries **no
 * clock, no random id and no absolute path** (ADR-0022 D4): sizes, ids and ratios are
 * enough to explain an injection, and prose stays out of it entirely — the record is a
 * measurement, not a copy of the manuscript.
 *
 * The preview payload is the one place the rendered text travels, because that is the
 * whole point of a preview: an author must be able to read what the model would read.
 */

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

import type { BriefSegmentId, BriefTrimRecord, WritingBrief, WritingContextOptions } from './writing-context.js'
import { buildWritingBrief } from './writing-context.js'
import { writeTextAtomic } from './io.js'
import { ensureIndex } from './index-freshness.js'
import { ensurePrivateStateIgnored, privateStateRelative } from './private-state.js'
// The chapter map `/gate` and `/review` resolve through (issue #200): a `chapterId` must
// mean the same chapter on every read route, so there is one lookup and not four.
import { chapterPositions } from './domains/foreshadowing-query.js'

/** The record's own identity, so a reader can refuse a file it does not understand. */
export const BRIEF_AUDIT_FORMAT = 'inkflow.brief-audit'
/**
 * `2` since #219 added `header` (the book identity line). The key set is part of the
 * contract, so an additive field still moves the number: a reader that only knows `1`
 * can tell the two shapes apart instead of guessing what an unfamiliar key means.
 * Nothing migrates — the files are private state, rewritten on the next audit.
 */
export const BRIEF_AUDIT_SCHEMA = 2

/** The one body field the write route accepts (besides `sessionId`). */
export const BRIEF_AUDIT_BODY_FIELDS = ['confirm'] as const

export interface BriefAuditSegment {
  readonly id: BriefSegmentId
  readonly label: string
  readonly bytes: number
  readonly tokens: number
  readonly truncated: boolean
  readonly missing: boolean
}

/**
 * The audit file's whole content.
 *
 * Key order is construction order and therefore part of the contract (`JSON.stringify`'s
 * order follows insertion): two runs over the same book must produce the same bytes, and
 * a reordered field would show up as a diff of every line.
 */
export interface BriefAuditRecord {
  readonly format: typeof BRIEF_AUDIT_FORMAT
  readonly schemaVersion: number
  /** The chapter key the file is named after; `no-chapter` when the book has none yet. */
  readonly chapterId: string
  readonly chapterSeq: number | null
  /** Project-relative: an absolute path would make the file machine-specific. */
  readonly chapterPath: string | null
  /**
   * The book identity line, recorded verbatim (issue #219). It is the ONE string the
   * preview, the injection and this file share, so storing it — rather than a title plus
   * two counts the reader would have to re-format — is what makes "same header" a fact
   * about bytes instead of a claim about formatting. `''` means the brief is empty.
   */
  readonly header: string
  readonly budgetTokens: number
  readonly tokens: number
  readonly overBudget: boolean
  readonly segments: readonly BriefAuditSegment[]
  readonly trims: readonly BriefTrimRecord[]
}

/** `brief-<chapterId>.json` — stable, filesystem-safe, no clock (ADR-0022 D4). */
export function briefAuditName(chapterId: string | null): string {
  const key = chapterId === null || chapterId.trim() === '' ? 'no-chapter' : chapterId.trim()
  return `brief-${key}.json`
}

/** Project-relative path of the audit file (`'` when the two never agree). */
export function briefAuditPath(chapterId: string | null): string {
  return privateStateRelative('audit', briefAuditName(chapterId))
}

function auditSegmentOf(segment: WritingBrief['segments'][number]): BriefAuditSegment {
  return {
    id: segment.id,
    label: segment.label,
    bytes: segment.bytes,
    tokens: segment.tokens,
    truncated: segment.truncated,
    missing: segment.missing,
  }
}

/**
 * The audit document for one brief. Pure: same brief in, same document out.
 *
 * The text of every segment is deliberately dropped here — `bytes`/`tokens` answer "why is
 * this in my context?" and a copy of the prose in a second file is exactly the "evidence
 * file that drifts" problem this project keeps paying for.
 */
export function briefAuditRecord(brief: WritingBrief): BriefAuditRecord {
  return {
    format: BRIEF_AUDIT_FORMAT,
    schemaVersion: BRIEF_AUDIT_SCHEMA,
    chapterId: brief.chapterId ?? 'no-chapter',
    chapterSeq: brief.chapterSeq,
    chapterPath: brief.chapterPath,
    header: brief.header,
    budgetTokens: brief.budgetTokens,
    tokens: brief.tokens,
    overBudget: brief.overBudget,
    segments: brief.segments.map(auditSegmentOf),
    trims: brief.trims.map((trim) => ({ segment: trim.segment, before: trim.before, after: trim.after, ratio: trim.ratio })),
  }
}

/** The audit record as the bytes that land on disk (LF, two-space JSON, one trailing `\n`). */
export function serializeBriefAudit(record: BriefAuditRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`
}

// ---------------------------------------------------------------------------
// The one assembly entry (ADR-0022 D1: preview = audit = injection)
// ---------------------------------------------------------------------------

export interface BriefRunSummary {
  /** How many briefs this process assembled (diagnostics only; never user-visible prose). */
  readonly runs: number
  readonly overBudgetRuns: number
  readonly last: {
    readonly overBudget: boolean
    readonly rungs: number
    readonly trimmed: readonly BriefSegmentId[]
    readonly budgetTokens: number
    readonly tokens: number
  } | null
}

let runs = 0
let overBudgetRuns = 0
let lastRun: BriefRunSummary['last'] = null

/**
 * Build the brief and count the run (ADR-0022 D2: "超预算次数进诊断包", counts and segment
 * ids only — never text, ADR-0018 D5).
 *
 * The counter lives here, not in `buildWritingBrief`: the assembly must stay a pure
 * function of the tree, while "how often did this process run out of budget" is process
 * state. Keeping them apart is what lets the determinism test call the builder twice and
 * still assert equal output.
 */
export function briefFor(root: string, options: WritingContextOptions = {}): WritingBrief {
  const brief = buildWritingBrief(root, options)
  runs += 1
  if (brief.overBudget) overBudgetRuns += 1
  lastRun = {
    overBudget: brief.overBudget,
    rungs: brief.rungs,
    trimmed: brief.trims.map((trim) => trim.segment),
    budgetTokens: brief.budgetTokens,
    tokens: brief.tokens,
  }
  return brief
}

/** The counters the diagnostics package carries (ADR-0018 D5's whitelist addition). */
export function briefRunSummary(): BriefRunSummary {
  return { runs, overBudgetRuns, last: lastRun }
}

/** Test hook: forget the counters (the process-wide state is not resettable otherwise). */
export function resetBriefRunSummary(): void {
  runs = 0
  overBudgetRuns = 0
  lastRun = null
}

// ---------------------------------------------------------------------------
// Preview payload
// ---------------------------------------------------------------------------

export interface BriefWireSegment extends BriefAuditSegment {
  /** The rendered text — the reason a preview exists. */
  readonly text: string
}

export interface BriefWire {
  readonly state: string
  readonly chapterId: string
  readonly chapterSeq: number | null
  readonly chapterPath: string | null
  /** The identity line, also the first line of {@link text} (issue #219). */
  readonly header: string
  readonly budgetTokens: number
  readonly tokens: number
  readonly overBudget: boolean
  readonly rungs: number
  readonly segments: readonly BriefWireSegment[]
  readonly trims: readonly BriefTrimRecord[]
  readonly text: string
  /** Where this exact brief would be recorded, project-relative. */
  readonly auditPath: string
}

/** The `GET /brief` payload: the record plus the prose, one object, no second computation. */
export function briefWire(brief: WritingBrief): BriefWire {
  return {
    state: brief.state,
    chapterId: brief.chapterId ?? 'no-chapter',
    chapterSeq: brief.chapterSeq,
    chapterPath: brief.chapterPath,
    header: brief.header,
    budgetTokens: brief.budgetTokens,
    tokens: brief.tokens,
    overBudget: brief.overBudget,
    rungs: brief.rungs,
    segments: brief.segments.map((segment) => ({ ...auditSegmentOf(segment), text: segment.text })),
    trims: brief.trims.map((trim) => ({ segment: trim.segment, before: trim.before, after: trim.after, ratio: trim.ratio })),
    text: brief.text,
    auditPath: briefAuditPath(brief.chapterId),
  }
}

// ---------------------------------------------------------------------------
// Writing the audit (the only write on this path)
// ---------------------------------------------------------------------------

export type BriefAuditWrite =
  | {
      readonly ok: true
      readonly path: string
      readonly bytes: number
      readonly sha256: string
      readonly created: boolean
      readonly ignoreLineAdded: boolean
      readonly chapterId: string
    }
  | { readonly ok: false; readonly code: string; readonly message: string }

/**
 * Write `.inkflow/audit/brief-<chapterId>.json` for one brief.
 *
 * Two of ADR-0012's rules apply and one is load-bearing: `.gitignore` gains `.inkflow/` on
 * first use (append-only, best-effort — an unwritable `.gitignore` must not lose the
 * record), and the write goes through `writeTextAtomic` → `resolveWriteTarget`, the only
 * door that enforces the whitelisted subdirectories and refuses `..`/absolute escapes.
 *
 * `sha256` is read back from the file, not computed from an in-memory string: the point of
 * the digest is "the bytes on disk are these bytes", and normalisation happens inside the
 * writer.
 */
export function writeBriefAudit(root: string, brief: WritingBrief): BriefAuditWrite {
  const record = briefAuditRecord(brief)
  const relative = briefAuditPath(brief.chapterId)
  const ignored = ensurePrivateStateIgnored(root)
  const written = writeTextAtomic(root, relative, serializeBriefAudit(record))
  if (!written.ok) return { ok: false, code: written.error.code, message: written.error.message }
  let sha256 = ''
  let bytes = written.bytes
  try {
    const payload = readFileSync(join(root, relative))
    sha256 = createHash('sha256').update(payload).digest('hex')
    bytes = payload.byteLength
  } catch {
    // The write succeeded a moment ago; a failed read-back costs the digest, not the file.
  }
  return {
    ok: true,
    path: relative,
    bytes,
    sha256,
    created: written.created,
    ignoreLineAdded: ignored.ok && ignored.added,
    chapterId: record.chapterId,
  }
}

/** Build and record in one step: the write route's whole body. */
export function writeBriefAuditFor(root: string, options: WritingContextOptions = {}): BriefAuditWrite {
  return writeBriefAudit(root, briefFor(root, options))
}

// ---------------------------------------------------------------------------
// The private channel's two replies (`GET /brief`, `POST /brief/audit`)
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>

/** What the replies need from the resolved channel target (never the whole target). */
export interface BriefChannelSource {
  sessionId: string
  root: string
}

export interface BriefReply {
  status: number
  body: JsonRecord
}

/** HTTP status per refusal; anything unlisted answers 500 and keeps the domain code. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  CONFIRM_REQUIRED: 400,
  PROJECT_NOT_FOUND: 404,
  PROJECT_BUSY: 409,
  PATH_NOT_WRITABLE: 409,
  PATH_OUT_OF_SCOPE: 409,
  IO_FAILED: 409,
}

function refused(status: number, code: string, extra: JsonRecord = {}): BriefReply {
  return { status, body: { ok: false, error: { code, ...extra } } }
}

/**
 * `GET /brief`: the nine-segment preview.
 *
 * The index is refreshed first, exactly like `/chapters` and `/foreshadow` (issue #5): the
 * `characters` and `voice` segments read `character_states`, and a preview that ignored a
 * card the author saved a second ago would be a preview of a different book. A failed
 * rebuild is reported (`indexRebuilt: false`), never fatal — the brief then renders with
 * the segments the files can still answer.
 *
 * CHAPTER ADDRESSING (issue #200): `chapterId` wins over the `chapterSeq` in `options`,
 * and an id that matches nothing is a **404 `CHAPTER_NOT_FOUND` naming that id** — it does
 * not fall back to the last chapter. The lookup runs AFTER `ensureIndex` and through
 * `chapterPositions()`, the map `/gate` and `/review` resolve through, so "which chapter
 * is this id" is answered by one function in this product. The resolved file travels down
 * as `chapterPath`, which is why the assembly never has to guess: before this, an unknown
 * `chapterId` on `/brief` was simply not read, and the answer was the last chapter with
 * HTTP 200 — a legal response for a target the caller never named.
 */
export async function buildBrief(
  source: BriefChannelSource,
  version: string,
  options: WritingContextOptions,
  chapterId = '',
): Promise<BriefReply> {
  const ensured = await ensureIndex(source.root)
  const asked = chapterId.trim()
  const addressed = asked === '' ? undefined : chapterPositions(source.root).get(asked)
  if (asked !== '' && addressed === undefined) {
    return refused(404, 'CHAPTER_NOT_FOUND', {
      chapterId: asked,
      hint: 'list the chapters with GET /inkflow/internal/chapters and pass one of the ids it reports',
    })
  }
  const brief = briefFor(
    source.root,
    addressed === undefined
      ? options
      : { ...options, chapterPath: addressed.path, chapterSeq: undefined },
  )
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        indexRebuilt: ensured.rebuilt,
        indexState: ensured.state,
        ...briefWire(brief),
      },
    },
  }
}

/**
 * `POST /brief/audit`: record this brief into `.inkflow/audit/brief-<chapterId>.json`.
 *
 * A write route, so `confirm: true` is required and absent/`false` is `CONFIRM_REQUIRED`
 * with zero writes — the same net `POST /audit/export` uses. The brief is rebuilt here
 * rather than taken from the request body: the record must describe the book as it is now,
 * and a client-supplied segment list would be a second assembly (the drift ADR-0022 D1 is
 * about).
 */
export function exportBriefAudit(
  source: BriefChannelSource,
  version: string,
  options: WritingContextOptions,
  body: JsonRecord,
): BriefReply {
  const confirm = body['confirm']
  if (confirm !== undefined && typeof confirm !== 'boolean') {
    return refused(400, 'invalid-field', { field: 'confirm', hint: '`confirm` must be `true` (or absent, which is a refusal)' })
  }
  if (confirm !== true) {
    return refused(400, 'CONFIRM_REQUIRED', { hint: 'recording the brief writes a file under .inkflow/audit/: pass confirm: true' })
  }
  const written = writeBriefAuditFor(source.root, options)
  if (!written.ok) {
    const status = STATUS_BY_CODE[written.code] ?? 500
    return refused(status, written.code, { message: written.message })
  }
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        chapterId: written.chapterId,
        written: {
          path: written.path,
          bytes: written.bytes,
          sha256: written.sha256,
          created: written.created,
          ignoreLineAdded: written.ignoreLineAdded,
        },
      },
    },
  }
}

/**
 * The three options a preview may override, read from the query string.
 *
 * Numbers only, and out of range falls back to the default (`clampInt` in the builder does
 * the clamping) — a panel knob must not be able to make the brief cost a book.
 */
export function briefOptionsFromQuery(query: URLSearchParams): WritingContextOptions {
  const options: WritingContextOptions = {}
  const number = (key: string): number | undefined => {
    const raw = query.get(key)
    if (raw === null || raw.trim() === '') return undefined
    const value = Number(raw)
    return Number.isFinite(value) ? Math.trunc(value) : undefined
  }
  const budgetTokens = number('budgetTokens')
  const tailChars = number('tailChars')
  const chapterSeq = number('chapterSeq')
  if (budgetTokens !== undefined) options.budgetTokens = budgetTokens
  if (tailChars !== undefined) options.tailChars = tailChars
  if (chapterSeq !== undefined) options.chapterSeq = chapterSeq
  return options
}
