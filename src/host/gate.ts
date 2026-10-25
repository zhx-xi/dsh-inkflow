/**
 * The quality gate: seven checks over one chapter, one deterministic verdict.
 *
 * ## What this module owns, and what it refuses to own
 *
 *   * **Reading.** The gate answers from the *files*, never from `index/` (the same
 *     reasoning as `audit.ts`: a report about what the chapter says must not be answered
 *     by a cache that may be weeks old, and a read path must not rebuild it). One
 *     `walkProjectFiles()` pass plus the chapter body and the two setting directories it
 *     needs — no model, no network, no write to a content directory (X-26).
 *   * **The conclusion file** (ADR-0022 D4): `.inkflow/audit/gate-<chapterId>.json`, in the
 *     private state directory ([ADR-0012](.agents/adrs/0012-plugin-private-state-dir.md)),
 *     never in `index/` (X-25 — a directory that is silently rebuilt cannot hold "what
 *     the gate said last time").
 *   * **Determinism.** The file carries no timestamp, no random id and no absolute path,
 *     and its key order is fixed by the construction below; the same chapter against the
 *     same files therefore produces the same bytes twice (`tests/quality-gate.test.js`
 *     compares them, and the panel's route is read-only so viewing cannot change it).
 *     "Is this the newest run" is answered by `chapterDigest` — the chapter bytes plus
 *     every setting file the gate read — not by the file name.
 *   * **Not the rules.** They live in `gate-rules.ts`, which is also where the code
 *     vocabulary and the thresholds are. This file only gathers, runs, sorts and writes.
 *
 * ## Why one verdict per chapter rather than one per book
 *
 * The gate's unit of work is a chapter because that is the unit the author delivers and
 * the unit the seven checks point at (every locator is a chapter id or a `path#L<n>` line
 * inside one chapter file). A book-wide roll-up would have to invent a locator for "the
 * book", which `findings.ts` deliberately does not have.
 *
 * ## 「检测到」与「可自动改写」是两件事
 *
 * Every finding here is a **detection**: a regular expression, a static list or a threshold
 * said "this looks wrong", and that is all this module claims. `fixable` therefore stays
 * `false` for all of them, including the mechanical proofreading classes that a program
 * *could* rewrite — the rewrite would have to live in `repair.ts` (the one repair path, which
 * dispatches on the code), and no `GATE_*` action exists there. Promising `fixable: true`
 * without that action turns 「一键修复」 into a button that does nothing while the report says
 * "N 项可自动修复" — the ADR-0015 D2 accident. The classes stay detectable now; the
 * flip to `fixable: true` belongs to the commit that teaches `repair.ts` the rewrite.
 */

import { createHash } from 'node:crypto'
import { join } from 'node:path'

import { parseFactLine } from './domains/facts-line.js'
import { chapterPositionsFromFiles } from './domains/foreshadowing-query.js'
import { aliasesOf, countChars, leadingNumber, readText } from './domains/scan-helpers.js'
import { compareFindings } from './findings.js'
import type { Finding, FindingSeverity } from './findings.js'
import {
  GATE_CHECKS,
} from './gate-rules.js'
import type { GateCheck } from './gate-rules.js'
import { GATE_CHECK_IDS, GATE_DEFAULTS, gateCheckOf } from './gate-vocabulary.js'
import type { GateCheckId, GateFact, GateInput, GateRosterEntry, GateThresholds } from './gate-vocabulary.js'
import { intField, parseMarkdown, stringField } from './frontmatter.js'
import { walkProjectFiles } from './indexer.js'
import type { WalkedFile } from './indexer.js'
import { writeTextAtomic } from './io.js'
import { ensurePrivateStateIgnored, privateStateRelative } from './private-state.js'

/**
 * The gate's surface for the tool, the panel route and the tests: seven checks in order,
 * their labels, the code table and the defaults. Re-exported here so a caller imports one
 * module (`gate.ts`) instead of three.
 */
export { GATE_CHECKS } from './gate-rules.js'
export type { GateCheck } from './gate-rules.js'
export { GATE_CHECK_IDS, GATE_CHECK_LABELS, GATE_CODES, GATE_DEFAULTS, gateCheckOf } from './gate-vocabulary.js'
export type { GateCheckId, GateFact, GateInput, GateRosterEntry, GateThresholds } from './gate-vocabulary.js'

/** Bumped only when the file's shape changes; the gate file is a fact, not a cache. */
export const GATE_FILE_SCHEMA_VERSION = 1

/** How many findings a tool reply or the panel prints before saying "and N more". */
export const GATE_LIST_LIMIT = 100

export interface GateCounts {
  readonly total: number
  /** Findings the repair pass claims it can fix — always 0 today (see `gate-rules.ts`). */
  readonly fixable: number
  readonly warning: number
  readonly info: number
  readonly byCheck: Readonly<Record<GateCheckId, number>>
}

/** One row of the seven. `count` is the number of its findings, never a pass/fail flag. */
export interface GateCheckSummary {
  readonly id: GateCheckId
  readonly label: string
  readonly count: number
}

/** The verdict for one chapter: what the panel shows, what the file holds. */
export interface GateReport {
  readonly chapterId: string
  readonly chapterPath: string
  readonly chapterTitle: string
  readonly seq: number | undefined
  readonly wordCount: number
  readonly chapterDigest: string
  readonly thresholds: GateThresholds
  readonly counts: GateCounts
  readonly checks: readonly GateCheckSummary[]
  /** Sorted by `compareFindings` and then by `detail`, so two runs cannot reorder. */
  readonly findings: readonly Finding[]
}

export interface GateRequest {
  /** A chapter id (uuid or, for a hand-written file, its path) — the address the tools use. */
  readonly chapterId?: string
  /** A project-relative path; the panel and the tests use it when no id is known. */
  readonly chapterPath?: string
}

/**
 * A chapter body that is **not on disk yet**: what a batch job must gate before it writes
 * (roadmap X-30).
 *
 * Why this lives here and not in `jobs.ts`: the seven checks are one implementation, and a
 * second caller that assembled its own `GateInput` would be a second opinion about what a
 * gate is. The batch passes the draft in; everything else (roster, ledger, positions,
 * thresholds) is gathered exactly as for a chapter that exists.
 *
 * `path` is the file the draft *will* be written to, or `''` when nobody knows yet (a new
 * chapter's file name comes from its slug at creation time). An empty path is honest: the
 * report says "no file yet" instead of pointing at a name that does not exist.
 */
export interface GateDraft {
  readonly body: string
  readonly title?: string
  readonly seq?: number
  readonly path?: string
  readonly id?: string
  readonly pov?: string
}

export interface GateRunOptions {
  readonly thresholds?: Partial<GateThresholds>
  /** `false` computes without writing the conclusion file (the panel's read route). */
  readonly record?: boolean
  /**
   * Gate this body instead of the one in the chapter file (an unsaved draft).
   *
   * With a draft, a chapter that does not exist yet is not an error: the input is built from
   * the draft. `record` stays `false` for a draft — the conclusion file is keyed by chapter id
   * and promises "the chapter file's bytes", which a draft does not have yet.
   */
  readonly draft?: GateDraft
}

export interface GateFileResult {
  readonly path: string
  readonly bytes: number
  readonly created: boolean
  readonly ignoreLineAdded: boolean
}

export interface GateError {
  readonly code: string
  readonly message: string
  readonly hint?: string
}

export type GateResult =
  | { readonly ok: true; readonly report: GateReport; readonly file?: GateFileResult }
  | { readonly ok: false; readonly error: GateError }

function refuse(code: string, message: string, hint?: string): GateResult {
  return { ok: false, error: hint === undefined ? { code, message } : { code, message, hint } }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** `gate-<chapterId>.json`: the chapter id, made safe for a file name, nothing else. */
export function gateFileName(chapterId: string): string {
  const safe = chapterId.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return `gate-${safe === '' ? 'chapter' : safe}.json`
}

/** The project-relative path the conclusion lands at (X-25: `.inkflow/`, never `index/`). */
export function gateFilePath(chapterId: string): string {
  return privateStateRelative('audit', gateFileName(chapterId))
}

// ---------------------------------------------------------------------------
// Gathering: one read pass, then everything the rules need
// ---------------------------------------------------------------------------

interface Gathered {
  readonly input: GateInput
  readonly digest: string
}

function hashOf(root: string, path: string): string {
  return sha256(readText(join(root, path)))
}

function rosterOf(root: string, files: readonly WalkedFile[]): GateRosterEntry[] {
  const out: GateRosterEntry[] = []
  for (const file of files) {
    if (file.dir !== 'characters' || !file.path.toLowerCase().endsWith('.md')) continue
    const parsed = parseMarkdown(readText(join(root, file.path)))
    const name = stringField(parsed.data, 'name') ?? file.path.split('/').pop()?.replace(/\.md$/iu, '') ?? file.path
    out.push({
      id: stringField(parsed.data, 'id') ?? file.path,
      name,
      aliases: aliasesOf(parsed.data),
    })
  }
  return out
}

function factsOf(root: string, files: readonly WalkedFile[]): GateFact[] {
  const out: GateFact[] = []
  for (const file of files) {
    if (file.dir !== 'facts' || !file.path.toLowerCase().endsWith('.md')) continue
    const text = readText(join(root, file.path))
    const parsed = parseMarkdown(text)
    const subject =
      stringField(parsed.data, 'subject') ?? file.path.split('/').pop()?.replace(/\.md$/iu, '') ?? file.path
    const lines = parsed.body.split('\n')
    for (const [index, line] of lines.entries()) {
      const fact = parseFactLine(line)
      if (!fact.ok) continue
      out.push({
        path: file.path,
        line: index + 1,
        subject,
        attribute: fact.fact.attribute,
        value: fact.fact.value,
        until: fact.fact.until,
      })
    }
  }
  return out
}

/**
 * Which chapter the request names; `undefined` means "the book's last chapter".
 *
 * Addressing is by id **or** path and both spellings come from one map:
 * `chapterPositionsFromFiles()` files every chapter under its frontmatter id *and* its
 * path, so a request for a hand-written file whose `id` differs from its file name still
 * resolves — without this function parsing frontmatter a second time.
 */
function pickChapter(
  files: readonly WalkedFile[],
  positions: ReadonlyMap<string, { readonly seq: number; readonly order: number; readonly path: string }>,
  request: GateRequest,
): WalkedFile | undefined {
  const chapters = files.filter((file) => file.dir === 'chapters' && file.path.toLowerCase().endsWith('.md'))
  const wanted = (request.chapterPath ?? request.chapterId ?? '').trim()
  if (wanted !== '') {
    const direct = chapters.find((file) => file.path === wanted)
    if (direct !== undefined) return direct
    const position = positions.get(wanted)
    if (position !== undefined) return chapters.find((file) => file.path === position.path)
    return undefined
  }
  let best: WalkedFile | undefined
  let bestKey: [number, number] = [-1, -1]
  for (const file of chapters) {
    const position = positions.get(file.path)
    const seq = position?.seq ?? leadingNumber(file.path) ?? 0
    const order = position?.order ?? 0
    if (order > bestKey[0] || (order === bestKey[0] && seq > bestKey[1])) {
      best = file
      bestKey = [order, seq]
    }
  }
  return best
}

function gather(
  root: string,
  request: GateRequest,
  thresholds: GateThresholds,
  draft?: GateDraft,
): GateResult | Gathered {
  let files: WalkedFile[]
  try {
    files = walkProjectFiles(root)
  } catch (cause) {
    return refuse('GATE_READ_FAILED', `cannot walk the project: ${String(cause)}`)
  }
  const positions = chapterPositionsFromFiles(root)
  const chapterFile = pickChapter(files, positions, request)
  if (chapterFile === undefined && draft === undefined) {
    const asked = request.chapterPath ?? request.chapterId
    return refuse(
      'CHAPTER_NOT_FOUND',
      asked === undefined || asked === '' ? 'the book has no chapter files' : `no chapter matches ${asked}`,
      'run inkflow_chapter_list to get the chapter ids this book actually has',
    )
  }

  const text = chapterFile === undefined ? '' : readText(join(root, chapterFile.path))
  if (chapterFile !== undefined && text === '') {
    return refuse('FILE_UNREADABLE', `cannot read ${chapterFile.path}`, 'the chapter file exists but reads as empty')
  }
  const parsed = parseMarkdown(text)
  // A draft replaces the body and may stand in for a chapter that does not exist yet; the
  // frontmatter of a real file still wins for id/title/seq/pov, because those are the facts
  // the chapter will be filed under.
  const chapterPath = chapterFile?.path ?? draft?.path ?? ''
  const chapterId = stringField(parsed.data, 'id') ?? draft?.id ?? (chapterFile?.path ?? 'draft')
  const seq = intField(parsed.data, 'seq') ?? leadingNumber(chapterFile?.path ?? '') ?? draft?.seq
  const title =
    stringField(parsed.data, 'title') ??
    draft?.title ??
    chapterFile?.path.split('/').pop()?.replace(/\.md$/iu, '') ??
    chapterId
  const body = draft === undefined ? parsed.body : draft.body

  const roster = rosterOf(root, files)
  const facts = factsOf(root, files)

  const seqOf = (reference: string): number | undefined => {
    const position = positions.get(reference)
    return position === undefined ? undefined : position.seq
  }

  // The digest covers exactly the bytes the verdict depended on: the chapter (or the draft
  // that replaces it) and both setting directories. Sorted by path, so the digest cannot
  // depend on walk order.
  const inputs = files
    .filter((file) => file.dir === 'characters' || file.dir === 'facts')
    .map((file) => file.path)
    .sort()
  const digest =
    draft === undefined
      ? sha256(`gate-inputs-v1\n${[chapterPath, ...inputs].sort().map((path) => `${path}\u0000${hashOf(root, path)}`).join('\n')}\n`)
      : sha256(
          `gate-draft-v1\n${sha256(draft.body)}\n${inputs.map((path) => `${path}\u0000${hashOf(root, path)}`).join('\n')}\n`,
        )

  return {
    input: {
      chapter: {
        id: chapterId,
        path: chapterPath,
        seq,
        title,
        pov: stringField(parsed.data, 'pov') ?? draft?.pov,
        body,
        wordCount: countChars(body),
      },
      roster,
      facts,
      seqOf,
      thresholds,
    },
    digest,
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** `compareFindings`, then `detail`: two findings that tie on all four keys stay ordered. */
function sortGateFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((left, right) => {
    const byContract = compareFindings(left, right)
    if (byContract !== 0) return byContract
    return left.detail < right.detail ? -1 : left.detail > right.detail ? 1 : 0
  })
}

function countsOf(findings: readonly Finding[], checks: readonly GateCheckSummary[]): GateCounts {
  const byCheck = Object.fromEntries(GATE_CHECK_IDS.map((id) => [id, 0])) as Record<GateCheckId, number>
  const severity: Record<FindingSeverity, number> = { blocking: 0, warning: 0, info: 0 }
  let fixable = 0
  for (const finding of findings) {
    const check = gateCheckOf(finding.code)
    if (check !== undefined) byCheck[check] += 1
    severity[finding.severity] += 1
    if (finding.fixable) fixable += 1
  }
  for (const summary of checks) byCheck[summary.id] = summary.count
  return { total: findings.length, fixable, warning: severity.warning, info: severity.info, byCheck }
}

/**
 * Gate one chapter.
 *
 * `options.record` defaults to **true**: the conclusion file is the point of the feature
 * (ADR-0022 D4), it is derived, it is idempotent and it never lands in a content
 * directory. The panel's read route passes `record: false` instead, because a GET must not
 * write.
 */
export function runGate(root: string, request: GateRequest = {}, options: GateRunOptions = {}): GateResult {
  const thresholds: GateThresholds = { ...GATE_DEFAULTS, ...options.thresholds }
  const drafted = options.draft !== undefined
  // A draft is by definition not the file, so the conclusion file would describe bytes that
  // are not on disk. Recording it is refused here rather than silently skipped: a caller that
  // asks for both is asking for the wrong thing (the job record holds the verdict, and the chapter
  // and writes the chapter only after a human, or a clean verdict, says yes).
  if (drafted && options.record !== false) {
    return refuse(
      'GATE_DRAFT_NOT_RECORDABLE',
      'a draft has no chapter file to key the conclusion on; pass record: false',
      'the batch job keeps the verdict in .inkflow/jobs/<jobId>/chapters/<seq>.json instead',
    )
  }
  const gathered = gather(root, request, thresholds, options.draft)
  if ('ok' in gathered) return gathered

  const findingsByCheck: { check: GateCheck; findings: readonly Finding[] }[] = GATE_CHECKS.map((check) => {
    let produced: readonly Finding[] = []
    try {
      produced = check.run(gathered.input)
    } catch {
      // A rule that throws must not take the other six down with it: the verdict is a
      // report, and a missing section is visible while a crashed gate is not.
      produced = []
    }
    return { check, findings: sortGateFindings(produced) }
  })
  const findings = sortGateFindings(findingsByCheck.flatMap((entry) => entry.findings))
  const checks: GateCheckSummary[] = findingsByCheck.map((entry) => ({
    id: entry.check.id,
    label: entry.check.label,
    count: entry.findings.length,
  }))
  const report: GateReport = {
    chapterId: gathered.input.chapter.id,
    chapterPath: gathered.input.chapter.path,
    chapterTitle: gathered.input.chapter.title,
    seq: gathered.input.chapter.seq,
    wordCount: gathered.input.chapter.wordCount,
    chapterDigest: gathered.digest,
    thresholds,
    counts: countsOf(findings, checks),
    checks,
    findings,
  }

  if (options.record === false) return { ok: true, report }
  const written = recordGate(root, report)
  if (!written.ok) return { ok: false, error: written.error }
  return { ok: true, report, file: written.file }
}

/** `record`'s outcome: either the file's facts or the reason it could not be written. */
type RecordOutcome =
  | { readonly ok: true; readonly file: GateFileResult }
  | { readonly ok: false; readonly error: GateError }

function recordGate(root: string, report: GateReport): RecordOutcome {
  const relative = gateFilePath(report.chapterId)
  const ignored = ensurePrivateStateIgnored(root)
  const written = writeTextAtomic(root, relative, renderGateFile(report))
  if (!written.ok) {
    return {
      ok: false,
      error: {
        code: written.error.code,
        message: written.error.message,
        hint: 'the gate file lives under .inkflow/audit/; check the write lock and the path rules',
      },
    }
  }
  return {
    ok: true,
    file: { path: relative, bytes: written.bytes, created: written.created, ignoreLineAdded: ignored.ok && ignored.added },
  }
}

// ---------------------------------------------------------------------------
// Serialisation: the file is a contract, so the key order is part of it
// ---------------------------------------------------------------------------

function locatorRecord(finding: Finding): Record<string, unknown> {
  const locator = finding.locator
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

/** One finding as the file and the wire both carry it; `check` is derived from the code. */
export function gateFindingRecord(finding: Finding): Record<string, unknown> {
  return {
    check: gateCheckOf(finding.code) ?? 'proofread',
    code: finding.code,
    group: finding.group,
    severity: finding.severity,
    locator: locatorRecord(finding),
    detail: finding.detail,
    hint: finding.hint,
    fixable: finding.fixable,
  }
}

/**
 * The conclusion file's bytes (ADR-0022 D4): no timestamp, no absolute path, fixed keys.
 * `summary` is the "N 项 / 七项各几项" line the file needs to be readable on its own.
 */
export function renderGateFile(report: GateReport): string {
  const payload = {
    schemaVersion: GATE_FILE_SCHEMA_VERSION,
    chapterId: report.chapterId,
    chapterPath: report.chapterPath,
    chapterTitle: report.chapterTitle,
    seq: report.seq ?? null,
    wordCount: report.wordCount,
    chapterDigest: report.chapterDigest,
    thresholds: {
      wordCountMin: report.thresholds.wordCountMin,
      wordCountMax: report.thresholds.wordCountMax,
      aiDashPer1000: report.thresholds.aiDashPer1000,
      aiEllipsisPer1000: report.thresholds.aiEllipsisPer1000,
      aiSentenceMeanMax: report.thresholds.aiSentenceMeanMax,
      aiSentenceEvenness: report.thresholds.aiSentenceEvenness,
      aiModifierPer1000: report.thresholds.aiModifierPer1000,
      maxFindingsPerRule: report.thresholds.maxFindingsPerRule,
    },
    counts: {
      total: report.counts.total,
      fixable: report.counts.fixable,
      warning: report.counts.warning,
      info: report.counts.info,
      byCheck: Object.fromEntries(GATE_CHECK_IDS.map((id) => [id, report.counts.byCheck[id]])),
    },
    checks: report.checks.map((summary) => ({ id: summary.id, label: summary.label, count: summary.count })),
    findings: report.findings.map((finding) => gateFindingRecord(finding)),
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/** The report on the wire: counts cover everything, only `findings` is capped. */
export function gateWire(report: GateReport, limit = GATE_LIST_LIMIT): Record<string, unknown> {
  const capped = report.findings.slice(0, Math.max(1, limit))
  return {
    chapterId: report.chapterId,
    chapterPath: report.chapterPath,
    chapterTitle: report.chapterTitle,
    seq: report.seq ?? null,
    wordCount: report.wordCount,
    chapterDigest: report.chapterDigest,
    counts: report.counts,
    checks: report.checks,
    findings: capped.map((finding) => gateFindingRecord(finding)),
    returned: capped.length,
    truncated: report.findings.length > capped.length,
    /** Where the conclusion lands; the read route reports the path without writing it. */
    recordPath: gateFilePath(report.chapterId),
  }
}

/** `GET /gate`: read-only, so it asks `runGate` for the verdict and never for the file. */
export function buildGate(
  source: { readonly sessionId: string; readonly root: string },
  version: string,
  options: { readonly chapterId?: string; readonly chapterPath?: string; readonly limit?: number } = {},
): { status: number; body: Record<string, unknown> } {
  const request: GateRequest = {
    ...(options.chapterId === undefined ? {} : { chapterId: options.chapterId }),
    ...(options.chapterPath === undefined ? {} : { chapterPath: options.chapterPath }),
  }
  const gated = runGate(source.root, request, { record: false })
  if (!gated.ok) {
    return { status: gated.error.code === 'CHAPTER_NOT_FOUND' ? 404 : 500, body: { ok: false, error: gated.error } }
  }
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: source.root,
        ...gateWire(gated.report, options.limit),
      },
    },
  }
}
