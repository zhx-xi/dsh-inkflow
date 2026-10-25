/**
 * The proposal's two bookkeeping actions (roadmap X-26): create and decide.
 *
 * Split from `proposal.ts` (the on-disk shape: paths, validation, read, list) and from
 * `proposal-apply.ts` (the one module that rewrites a chapter) along the line that matters
 * to the author — **this file never touches a content file**. Creating stores a work copy
 * under `.inkflow/proposals/`; deciding stores verdicts in the same directory and takes the
 * baseline `apply` will check. A reviewer asking "can a proposal change my prose before I
 * say yes?" only has to notice which writer is missing here.
 */

import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { readCatalog } from './catalog.js'
import type { CatalogChapter } from './catalog.js'
import { fingerprintProjectFile } from './file-cas.js'
import { parseMarkdown } from './frontmatter.js'
import { writeJsonAtomic } from './io.js'
import { ensurePrivateStateIgnored } from './private-state.js'
import { diffLines, joinLines, splitLines } from './proposal-diff.js'
import type { LineHunk } from './proposal-diff.js'
import {
  PROPOSAL_HUNK_STATUSES,
  PROPOSAL_ID_PREFIX,
  PROPOSAL_SCHEMA_VERSION,
  absolute,
  allCatalogChapters,
  chapterPathProblem,
  countsOf,
  digestOfFingerprint,
  fail,
  isProposalHunkStatus,
  normalizeRevised,
  proposalDirRelative,
  proposalHunkPath,
  proposalMetaPath,
  readProposal,
} from './proposal.js'
import type {
  HunkKind,
  ProposalBase,
  ProposalCounts,
  ProposalError,
  ProposalHunk,
  ProposalHunkFile,
  ProposalHunkRef,
  ProposalMeta,
  ProposalResult,
} from './proposal.js'
import { detectTextStyle } from './text-style.js'


// ---------------------------------------------------------------------------
// inkflow_proposal_create
// ---------------------------------------------------------------------------

export interface CreateProposalInput {
  chapterId?: string
  file?: string
  /** The whole revised body, as the session model wrote it. Frontmatter is NOT part of it. */
  revisedBody: string
  /** Who produced it. Free text: `session-model`, a skill name, the author's own name. */
  label?: string
  note?: string
  at?: Date
}

export interface CreateProposalOk {
  ok: true
  root: string
  proposalId: string
  dir: string
  chapterId: string
  path: string
  base: ProposalBase
  revised: { lines: number; bytes: number }
  counts: ProposalCounts
  /** The hunks without their text: enough to print "3 hunks, +12 −9" without a second read. */
  hunks: Array<{ index: number; kind: HunkKind; baseStart: number; removed: number; added: number }>
  /** Every write this call performed, so "creating a proposal touches no content file" is checkable. */
  contentFilesWritten: 0
}

/**
 * Cut a revised body into hunks and store the proposal.
 *
 * Reads the chapter, never writes it: the only files this touches are
 * `.inkflow/proposals/<id>/…` (plus the `.inkflow/` ignore line, appended by the first
 * private-state writer as always — ADR-0012).
 */
export function createProposal(projectRoot: string, input: CreateProposalInput): ProposalResult<CreateProposalOk> {
  const root = resolve(projectRoot)
  const at = input.at ?? new Date()

  const revisedRaw = typeof input.revisedBody === 'string' ? input.revisedBody : ''
  if (revisedRaw.trim() === '') {
    return fail('PROPOSAL_BODY_REQUIRED', 'a proposal needs the revised body text', {
      root,
      hint: 'pass the body the model wrote (no frontmatter, no code fence around it)',
    })
  }
  const revisedText = normalizeRevised(revisedRaw)
  // A whole document instead of a body would diff the frontmatter as if it were prose,
  // and the hunks would then be unfixable garbage. `data` being non-empty is the tell:
  // a `---` scene break parses as a block but produces no keys.
  const revisedParsed = parseMarkdown(revisedText)
  if (revisedParsed.hasFrontmatter && Object.keys(revisedParsed.data).length > 0) {
    return fail('PROPOSAL_BODY_REQUIRED', 'the revised text starts with frontmatter; pass the chapter body only', {
      root,
      hint: 'the proposal replaces the body — the frontmatter of the chapter file is never part of a revision',
    })
  }

  const ref = resolveChapterRef(root, input)
  if (!ref.ok) return ref
  const chapter = ref.value
  let raw: string
  try {
    raw = readFileSync(absolute(root, chapter.file), 'utf8')
  } catch {
    return fail('CHAPTER_NOT_FOUND', `${chapter.file} could not be read`, { root, path: chapter.file })
  }
  const fingerprint = fingerprintProjectFile(root, chapter.file)
  if (fingerprint === undefined) {
    return fail('CHAPTER_NOT_FOUND', `${chapter.file} disappeared while the proposal was being made`, { root, path: chapter.file })
  }
  const style = detectTextStyle(raw)
  const baseBody = parseMarkdown(raw).body
  const baseLines = splitLines(baseBody)
  const revisedLines = alignLeadingBlank(baseLines, splitLines(revisedText))
  const hunks = diffLines(baseLines, revisedLines)
  if (hunks.length === 0) {
    return fail('PROPOSAL_EMPTY', 'the revised body is identical to the chapter body; there is nothing to propose', {
      root,
      path: chapter.file,
      hint: 'nothing was written — change something before sending a revision',
    })
  }

  const proposalId = mintProposalId(root)
  const counts: ProposalCounts = { total: hunks.length, pending: hunks.length, accepted: 0, rejected: 0 }
  const refs: ProposalHunkRef[] = hunks.map((hunk, position) => ({
    index: position + 1,
    kind: hunk.kind,
    baseStart: hunk.baseStart,
    baseLines: hunk.baseLines.length,
    nextLines: hunk.nextLines.length,
    file: proposalHunkPath(proposalId, position + 1),
  }))
  const meta: ProposalMeta = {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    proposalId,
    chapterId: chapter.chapterId,
    path: chapter.file,
    title: chapter.title,
    createdAt: at.toISOString(),
    source: {
      kind: 'revised-body',
      label: input.label === undefined || input.label.trim() === '' ? 'session-model' : input.label.trim(),
      ...(input.note === undefined || input.note.trim() === '' ? {} : { note: input.note.trim() }),
    },
    base: { ...digestOfFingerprint(fingerprint), lines: baseLines.length, eol: style.eol, bom: style.bom },
    revised: { lines: revisedLines.length, bytes: Buffer.byteLength(joinLines(revisedLines), 'utf8') },
    hunks: refs,
    counts,
    status: 'open',
    decision: null,
    apply: null,
    rollback: null,
  }

  ensurePrivateStateIgnored(root)
  for (const [position, hunk] of hunks.entries()) {
    const file: ProposalHunkFile = {
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      proposalId,
      index: position + 1,
      kind: hunk.kind,
      baseStart: hunk.baseStart,
      baseLines: [...hunk.baseLines],
      nextLines: [...hunk.nextLines],
      status: 'pending',
    }
    const written = writeJsonAtomic(root, proposalHunkPath(proposalId, position + 1), file)
    if (!written.ok) return fail(written.error.code, `the proposal could not be stored: ${written.error.message}`, { root, path: written.error.path })
  }
  const stored = writeJsonAtomic(root, proposalMetaPath(proposalId), meta)
  if (!stored.ok) return fail(stored.error.code, `the proposal could not be stored: ${stored.error.message}`, { root, path: stored.error.path })

  return {
    ok: true,
    value: {
      ok: true,
      root,
      proposalId,
      dir: proposalDirRelative(proposalId),
      chapterId: chapter.chapterId,
      path: chapter.file,
      base: meta.base,
      revised: meta.revised,
      counts,
      hunks: refs.map((ref, position) => ({
        index: ref.index,
        kind: ref.kind,
        baseStart: ref.baseStart,
        removed: (hunks[position] as LineHunk).baseLines.length,
        added: (hunks[position] as LineHunk).nextLines.length,
      })),
      contentFilesWritten: 0,
    },
  }
}

interface ChapterRef {
  chapterId: string
  file: string
  title: string
}

/** Resolve the chapter a proposal is about. Ids are durable; a file path is exact. */
function resolveChapterRef(
  root: string,
  input: { chapterId?: string; file?: string },
): ProposalResult<ChapterRef> {
  const hasId = typeof input.chapterId === 'string' && input.chapterId.trim() !== ''
  const hasFile = typeof input.file === 'string' && input.file.trim() !== ''
  if (hasId && hasFile) {
    return fail('CHAPTER_SELECTOR_CONFLICT', 'pass either chapterId or file, not both', { root })
  }
  if (!hasId && !hasFile) {
    return fail('CHAPTER_SELECTOR_REQUIRED', 'a chapterId or a file is required to address a chapter', {
      root,
      hint: 'use the chapter id from inkflow_chapter_list / the catalog',
    })
  }
  const chapters = allCatalogChapters(readCatalog(root))
  if (hasFile) {
    const file = (input.file as string).trim().replaceAll('\\', '/').replace(/^\/+/, '')
    const problem = chapterPathProblem(file)
    if (problem !== undefined) return fail('FILE_INVALID', `${file}: ${problem}`, { root, path: file })
    const match = chapters.find((chapter) => chapter.file === file)
    if (match === undefined) return fail('CHAPTER_NOT_FOUND', `no chapter file "${file}"`, { root, path: file })
    return { ok: true, value: { chapterId: match.chapterId, file: match.file, title: match.title } }
  }
  const id = (input.chapterId as string).trim()
  const matches = chapters.filter((chapter) => chapter.chapterId === id)
  const match = matches[0]
  if (match === undefined) {
    return fail('CHAPTER_NOT_FOUND', `no chapter with id "${id}"`, {
      root,
      hint: 'ids come from inkflow_chapter_list / the catalog; a volume directory name is not an id',
    })
  }
  if (matches.length > 1) {
    return fail('CHAPTER_AMBIGUOUS', `id "${id}" is used by ${matches.length} chapters`, {
      root,
      path: match.file,
      hint: `pass file: ${matches.map((chapter) => chapter.file).join(' | ')}`,
    })
  }
  return { ok: true, value: { chapterId: match.chapterId, file: match.file, title: match.title } }
}

/**
 * Align the revision's leading blank lines with the base's.
 *
 * `parseMarkdown().body` starts at the byte after the closing `---`, so a chapter written
 * the way this plugin writes them begins with the one blank separator line. Whether a
 * model's revised text repeats that blank line is an accident of its formatting, not a
 * decision about the prose — and diffing it as a change would put a meaningless
 * "delete an empty line" hunk on every single proposal. The frame belongs to the file;
 * only the body belongs to the revision.
 */
function alignLeadingBlank(base: readonly string[], next: readonly string[]): string[] {
  let lead = 0
  while (lead < base.length && (base[lead] ?? '') === '') lead += 1
  let skip = 0
  while (skip < next.length && (next[skip] ?? '') === '') skip += 1
  const body = next.slice(skip)
  const prefix = new Array<string>(lead).fill('')
  return body.length === 0 ? prefix : [...prefix, ...body]
}

function mintProposalId(root: string): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = `${PROPOSAL_ID_PREFIX}${randomBytes(4).toString('hex')}`
    try {
      readFileSync(absolute(root, proposalMetaPath(candidate)), 'utf8')
    } catch {
      // Nothing there: the id is free. A read is cheaper than an existsSync+race.
      return candidate
    }
  }
  // 16 collisions in a row means the directory is not what it claims to be; a fresh
  // random id would only hide that. `create` reports it instead of looping forever.
  return `${PROPOSAL_ID_PREFIX}${randomBytes(4).toString('hex')}`
}

// ---------------------------------------------------------------------------
// inkflow_proposal_decide
// ---------------------------------------------------------------------------

export interface HunkDecision {
  index: number
  /** `accepted` | `rejected` | `pending`; validated by `decideProposal`, so a raw string is allowed here. */
  status: string
}

export interface DecideProposalInput {
  proposalId: string
  decisions: readonly HunkDecision[]
  at?: Date
}

export interface DecideProposalOk {
  ok: true
  root: string
  proposalId: string
  counts: ProposalCounts
  /** The baseline `apply` will compare against, taken now (ADR-0021: the decision moment). */
  decision: { at: string; baseline: { size: number; mtimeMs: number; sha256: string } }
  /** Hunks that are still undecided — `apply` refuses while this is non-empty. */
  pending: number[]
  /** Set when the chapter changed since the proposal was made: the caller must regenerate. */
  contentFilesWritten: 0
}

/**
 * Record the author's verdict on one or more hunks.
 *
 * The chapter's fingerprint is taken **here** and stored in `meta.decision.baseline`.
 * If the chapter no longer matches the base the proposal was cut from, the decision is
 * refused (`FILE_CHANGED`) with nothing written: hunks address line ranges of a
 * specific text, so accepting them against different text would apply the right words
 * at the wrong place.
 */
export function decideProposal(projectRoot: string, input: DecideProposalInput): ProposalResult<DecideProposalOk> {
  const root = resolve(projectRoot)
  const at = input.at ?? new Date()
  const read = readProposal(root, input.proposalId)
  if (!read.ok) return read
  const { meta, hunks } = read.value
  if (meta.status !== 'open') {
    return fail('PROPOSAL_STATUS', `proposal ${meta.proposalId} is already ${meta.status}`, {
      root,
      path: read.value.metaPath,
      hint: meta.status === 'applied' ? 'roll it back before deciding anything else' : 'make a new proposal for further changes',
    })
  }
  const decisions = Array.isArray(input.decisions) ? input.decisions : []
  if (decisions.length === 0) {
    return fail('PROPOSAL_DECISIONS_REQUIRED', 'decisions must list at least one hunk', {
      root,
      hint: 'pass [{ "index": 1, "status": "accepted" }]; status is accepted, rejected or pending',
    })
  }
  const byIndex = new Map(hunks.map((hunk) => [hunk.index, hunk]))
  for (const decision of decisions) {
    const index = typeof decision.index === 'number' ? decision.index : Number.NaN
    if (!byIndex.has(index)) {
      return fail('PROPOSAL_HUNK_NOT_FOUND', `proposal ${meta.proposalId} has no hunk ${String(decision.index)}`, {
        root,
        hint: `hunks are numbered 1…${String(hunks.length)}`,
      })
    }
    if (!isProposalHunkStatus(decision.status)) {
      return fail('PROPOSAL_HUNK_STATUS_INVALID', `"${decision.status}" is not a hunk status`, {
        root,
        hint: 'status must be accepted, rejected or pending',
      })
    }
  }

  // The decision-time baseline. Read once; a mismatch means the hunks no longer address
  // the text the author is looking at, so nothing is recorded.
  const current = fingerprintProjectFile(root, meta.path)
  if (current === undefined) {
    return fail('CHAPTER_NOT_FOUND', `${meta.path} is gone; the proposal cannot be decided against it`, { root, path: meta.path })
  }
  if (current.sha256 !== meta.base.sha256) {
    return fail(
      'FILE_CHANGED',
      `${meta.path} changed on disk since this proposal was made (sha256 ${current.sha256.slice(0, 8)}… ≠ base ${meta.base.sha256.slice(0, 8)}…)`,
      {
        root,
        path: meta.path,
        nothingWritten: true,
        expected: { sha256: meta.base.sha256, size: meta.base.bytes },
        current: { sha256: current.sha256, size: current.size },
        changed: ['sha256'],
        hint: 'the hunks address line ranges of the old text; forget this proposal and create a new one from the current file',
      },
    )
  }

  for (const decision of decisions) {
    const hunk = byIndex.get(decision.index) as ProposalHunk
    if (hunk.status === decision.status) continue
    hunk.status = decision.status
    const file: ProposalHunkFile = {
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      proposalId: meta.proposalId,
      index: hunk.index,
      kind: hunk.kind,
      baseStart: hunk.baseStart,
      baseLines: [...hunk.baseLines],
      nextLines: [...hunk.nextLines],
      status: hunk.status,
    }
    const written = writeJsonAtomic(root, proposalHunkPath(meta.proposalId, hunk.index), file)
    if (!written.ok) {
      return fail(written.error.code, `the decision could not be stored: ${written.error.message}`, { root, path: written.error.path })
    }
  }

  const counts = countsOf(hunks)
  const baseline = { size: current.size, mtimeMs: current.mtimeMs, sha256: current.sha256 }
  const next: ProposalMeta = { ...meta, counts, decision: { at: at.toISOString(), baseline, counts } }
  const stored = writeJsonAtomic(root, read.value.metaPath, next)
  if (!stored.ok) {
    return fail(stored.error.code, `the decision could not be stored: ${stored.error.message}`, { root, path: stored.error.path })
  }
  return {
    ok: true,
    value: {
      ok: true,
      root,
      proposalId: meta.proposalId,
      counts,
      decision: { at: next.decision?.at ?? at.toISOString(), baseline },
      pending: hunks.filter((hunk) => hunk.status === 'pending').map((hunk) => hunk.index),
      contentFilesWritten: 0,
    },
  }
}
