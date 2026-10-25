/**
 * The quality gate: eight checks over one chapter, one deterministic verdict.
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
 *   * **Not the serialisation.** `gate-report.ts` owns the report types, the counts and the
 *     conclusion file's bytes; this file hands it a finished verdict.
 *   * **Not the calibration.** What the book says about its own gate — the numbers in
 *     `inkflow.json`'s `gate` section and the literal waivers in
 *     `library/gate-whitelist.txt` — is read by `gate-config.ts`, and the waiving itself
 *     belongs to `gate-waiver.ts` (ADR-0028). One line matters here: a refusal from either
 *     of them stops the run, because a gate that half-applies a calibration is worse than one that
 *     says why it could not.
 *
 * ## Why one verdict per chapter rather than one per book
 *
 * The gate's unit of work is a chapter because that is the unit the author delivers and
 * the unit the eight checks point at (every locator is a chapter id or a `path#L<n>` line
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
import type { Finding } from './findings.js'
import { gateWhitelistPath, loadGateConfig } from './gate-config.js'
import { countsOf, gateFilePath, gateWire, renderGateFile } from './gate-report.js'
import type { GateCheckSummary, GateReport } from './gate-report.js'
import { GATE_CHECKS } from './gate-rules.js'
import type { GateCheck } from './gate-rules.js'
import type { GateFact, GateInput, GateRosterEntry, GateThresholds } from './gate-vocabulary.js'
import { waiveFindings } from './gate-waiver.js'
import type { GateWaiverHit } from './gate-waiver.js'
import { intField, parseMarkdown, stringField } from './frontmatter.js'
import { walkProjectFiles } from './indexer.js'
import type { WalkedFile } from './indexer.js'
import { writeTextAtomic } from './io.js'
import { ensurePrivateStateIgnored } from './private-state.js'

/**
 * The gate's surface for the tool, the panel route and the tests: eight checks in order,
 * their labels, the code table, the defaults and the book-level calibration. Re-exported
 * here so a caller imports one module (`gate.ts`) instead of six.
 */
export { GATE_CHECKS } from './gate-rules.js'
export type { GateCheck } from './gate-rules.js'
export { GATE_CHECK_IDS, GATE_CHECK_LABELS, GATE_CODES, GATE_DEFAULTS, gateCheckOf } from './gate-vocabulary.js'
export type { GateCheckId, GateFact, GateInput, GateRosterEntry, GateThresholds } from './gate-vocabulary.js'
export {
  GATE_FILE_SCHEMA_VERSION,
  GATE_LIST_LIMIT,
  gateFileName,
  gateFilePath,
  gateFindingRecord,
  gateWire,
  renderGateFile,
} from './gate-report.js'
export type { GateCheckSummary, GateCounts, GateReport } from './gate-report.js'
export { GATE_BOOK_SECTION, gateWhitelistPath, loadGateConfig } from './gate-config.js'
export { GATE_WAIVER_LIMITS, WAIVABLE_CODES } from './gate-waiver.js'
export type { GateWaiverHit, GateWaivers } from './gate-waiver.js'

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
 * Why this lives here and not in `jobs.ts`: the eight checks are one implementation, and a
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
  // that replaces it), both setting directories, and — when the book has one — the waiver
  // list, because editing it changes the verdict (ADR-0028 D6). A book without that file
  // therefore keeps the digest it had before this feature existed. Sorted by path, so the
  // digest cannot depend on walk order.
  const waiverFile = gateWhitelistPath()
  const inputs = files
    .filter((file) => file.dir === 'characters' || file.dir === 'facts' || file.path === waiverFile)
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

/**
 * Gate one chapter.
 *
 * `options.record` defaults to **true**: the conclusion file is the point of the feature
 * (ADR-0022 D4), it is derived, it is idempotent and it never lands in a content
 * directory. The panel's read route passes `record: false` instead, because a GET must not
 * write.
 *
 * The book's own calibration (`inkflow.json`'s `gate` section, `library/gate-whitelist.txt`)
 * is read first and a refusal there stops the run: half-applying a口径 would report a verdict
 * whose numbers the author never agreed to (ADR-0028 D1/D5). `options.thresholds` still wins
 * over the book's numbers — it is a one-shot override for tests and panels, not a standing
 * setting.
 */
export function runGate(root: string, request: GateRequest = {}, options: GateRunOptions = {}): GateResult {
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
  const configured = loadGateConfig(root)
  if (configured.ok === false) return refuse(configured.error.code, configured.error.message, configured.error.hint)
  const thresholds: GateThresholds = { ...configured.config.thresholds, ...options.thresholds }
  const gathered = gather(root, request, thresholds, options.draft)
  if ('ok' in gathered) return gathered

  // Waivers are applied **inside** the per-check loop, before sorting: the check table's
  // counts are then the counts of what the author will actually see, and a waiver can only
  // ever remove its own finding (ADR-0028 D3).
  const applied: GateWaiverHit[] = []
  const findingsByCheck: { check: GateCheck; findings: readonly Finding[] }[] = GATE_CHECKS.map((check) => {
    let produced: readonly Finding[] = []
    try {
      produced = check.run(gathered.input)
    } catch {
      // A rule that throws must not take the other seven down with it: the verdict is a
      // report, and a missing section is visible while a crashed gate is not.
      produced = []
    }
    const kept = waiveFindings(
      produced,
      gathered.input.chapter.path,
      gathered.input.chapter.body,
      configured.config.whitelist,
      applied,
    )
    return { check, findings: sortGateFindings(kept) }
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
    waivers: { configured: configured.config.whitelist.length, applied },
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
