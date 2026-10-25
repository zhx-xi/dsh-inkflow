/**
 * The proposal's only write path (roadmap X-26): `applyProposal` and
 * `rollbackProposal`.
 *
 * One module for both because they are two halves of one guarantee: the backup package
 * `apply` opens BEFORE it writes is exactly what `rollback` replays. Keeping them apart
 * would let one grow a package shape the other cannot read.
 *
 * Three rules live here and nowhere else:
 *   * the write goes through `chapters.ts` (write lock, atomic replace, the file's own
 *     EOL/BOM — ADR-0016), never around it;
 *   * the CAS baseline is the **decision-time** fingerprint, so text typed after the
 *     decision is a `FILE_CHANGED` refusal that keeps the author's edit (ADR-0021);
 *   * `rollback` restores bytes verbatim and proves it by digest, which is what makes
 *     "100% identical" a measurement instead of a promise.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { newBackupBody, openBackup, rollbackBackup, sealBackup, stageFile } from './backup.js'
import type { BackupBody, BackupError } from './backup.js'
import { writeChapter } from './chapters.js'
import { fingerprintProjectFile } from './file-cas.js'
import { parseMarkdown } from './frontmatter.js'
import { writeJsonAtomic } from './io.js'
import { applyHunks, joinLines, splitLines } from './proposal-diff.js'
import { absolute, countsOf, digestOfFingerprint, fail, readProposal } from './proposal.js'
import type {
  ProposalDigest,
  ProposalMeta,
  ProposalResult,
} from './proposal.js'

// ---------------------------------------------------------------------------
// inkflow_proposal_apply
// ---------------------------------------------------------------------------

export interface ApplyProposalInput {
  proposalId: string
  confirm?: boolean
  at?: Date
}

export interface ApplyProposalOk {
  ok: true
  root: string
  proposalId: string
  chapterId: string
  path: string
  /** The backup package a rollback replays. */
  backup: string
  before: ProposalDigest
  after: ProposalDigest
  applied: number[]
  /** Hunks the author rejected: their text did not enter the file. */
  skipped: number[]
  bytes: number
  catalogRebuilt: boolean
  indexRebuilt: boolean
  /**
   * A commit the author can paste, NOT a commit the plugin makes (the plugin never runs
   * git — data-safety §2.5). It names the chapter and the proposal so the history says
   * what happened even months later.
   */
  commitSuggestion: string
}

/**
 * Write the accepted hunks into the chapter — the proposal's only write path.
 *
 * The order is the point:
 *   1. refuse unless `confirm: true`, every hunk is decided, and at least one is accepted;
 *   2. compare the file against the **decision-time** baseline (`FILE_CHANGED`, zero writes);
 *   3. open a `replace` backup package and copy the current bytes into it;
 *   4. write through `writeChapter` (write lock, atomic replace, the file's own EOL/BOM),
 *      which re-checks the same baseline under the lock;
 *   5. seal the package with the post-write digest and record it in `meta.apply`.
 *
 * Step 4 is the reason this module has no writer of its own: a second implementation of
 * "replace a chapter body" would be a second answer to "what does a chapter file look
 * like", and the catalog/index rebuild would be forgotten in one of the two.
 */
export async function applyProposal(projectRoot: string, input: ApplyProposalInput): Promise<ProposalResult<ApplyProposalOk>> {
  const root = resolve(projectRoot)
  const at = input.at ?? new Date()
  if (input.confirm !== true) {
    return fail('CONFIRM_REQUIRED', 'applying a proposal rewrites a chapter, so it needs confirm: true', {
      root,
      hint: 'show the author the accepted hunks first, then call again with confirm: true',
    })
  }
  const read = readProposal(root, input.proposalId)
  if (!read.ok) return read
  const { meta, hunks } = read.value
  if (meta.status !== 'open') {
    return fail('PROPOSAL_STATUS', `proposal ${meta.proposalId} is already ${meta.status}`, {
      root,
      path: read.value.metaPath,
      hint: 'a proposal is applied once; make a new one for further changes',
    })
  }
  const counts = countsOf(hunks)
  const baseline = meta.decision?.baseline
  if (baseline === undefined) {
    return fail('PROPOSAL_UNDECIDED', 'this proposal has no recorded decision, so it has no baseline to write against', {
      root,
      path: read.value.metaPath,
      nothingWritten: true,
      hint: 'call inkflow_proposal_decide first: the baseline is taken when the author decides, not when the write runs',
    })
  }
  if (counts.pending > 0) {
    return fail('PROPOSAL_PENDING_HUNKS', `${String(counts.pending)} of ${String(counts.total)} hunk(s) are still undecided`, {
      root,
      path: read.value.metaPath,
      nothingWritten: true,
      hint: `decide every hunk first (undecided: ${hunks.filter((hunk) => hunk.status === 'pending').map((hunk) => hunk.index).join(', ')}); an undecided hunk is not a "no"`,
    })
  }
  if (counts.accepted === 0) {
    return fail('PROPOSAL_NOTHING_ACCEPTED', 'every hunk was rejected, so there is nothing to apply', {
      root,
      path: read.value.metaPath,
      nothingWritten: true,
      hint: 'accept at least one hunk, or leave the chapter as it is',
    })
  }
  const current = fingerprintProjectFile(root, meta.path)
  if (current === undefined) {
    return fail('CHAPTER_NOT_FOUND', `${meta.path} is gone; the accepted text has nowhere to land`, { root, path: meta.path })
  }
  if (current.sha256 !== baseline.sha256) {
    return fail('FILE_CHANGED', `${meta.path} was edited after you decided (sha256 ${current.sha256.slice(0, 8)}… ≠ decision ${baseline.sha256.slice(0, 8)}…)`, {
      root,
      path: meta.path,
      nothingWritten: true,
      expected: { sha256: baseline.sha256, size: baseline.size },
      current: { sha256: current.sha256, size: current.size },
      changed: ['sha256'],
      hint: 'your edit was kept: re-read the chapter and make a new proposal instead of overwriting it',
    })
  }

  const baseBody = readBody(root, meta.path)
  if (baseBody === undefined) {
    return fail('CHAPTER_NOT_FOUND', `${meta.path} could not be read, so the accepted hunks have nothing to land on`, {
      root,
      path: meta.path,
      nothingWritten: true,
    })
  }
  const nextBody = joinLines(applyHunks(splitLines(baseBody), hunks, (hunk) => hunk.status === 'accepted'))

  const opened = openBackup(root, 'replace', at)
  if (!opened.ok) return { ok: false, error: { ...opened.error } }
  const staged = stageFile(root, opened.value, meta.path)
  if (!staged.ok) return { ok: false, error: { ...staged.error } }
  const before = staged.value
  if (before === undefined) {
    return fail('CHAPTER_NOT_FOUND', `${meta.path} vanished before it could be backed up`, { root, path: meta.path, nothingWritten: true })
  }
  const packageBody: BackupBody = newBackupBody()
  packageBody.steps.push(`stage ${meta.path}`)
  packageBody.files.push({ path: meta.path, change: 'modified', before })
  // Sealed before the write (ADR-0012 decision 1): a crash mid-apply must leave a readable
  // journal whose `sealed: false` says exactly that.
  const journal = sealBackup(root, opened.value, 'replace', packageBody, false, at)
  if (!journal.ok) return { ok: false, error: { ...journal.error } }

  const written = await writeChapter(root, {
    chapterId: meta.chapterId,
    body: nextBody,
    expected: { sha256: baseline.sha256, size: baseline.size },
  })
  if (!written.ok) {
    packageBody.steps.push('write refused')
    sealBackup(root, opened.value, 'replace', packageBody, false, at)
    const error = written.error
    return {
      ok: false,
      error: {
        code: error.code,
        message: `the chapter was not written: ${error.message}`,
        ...(error.root === undefined ? { root } : { root: error.root }),
        ...(error.path === undefined ? { path: meta.path } : { path: error.path }),
        ...(error.hint === undefined ? {} : { hint: error.hint }),
        nothingWritten: true,
        backup: opened.value.dir,
      },
    }
  }

  const afterFingerprint = fingerprintProjectFile(root, meta.path)
  const after: ProposalDigest = afterFingerprint === undefined
    ? { bytes: 0, sha256: '' }
    : digestOfFingerprint(afterFingerprint)
  const entry = packageBody.files[0]
  if (entry !== undefined) entry.after = after
  packageBody.steps.push(`write ${meta.path} (${String(after.bytes)} bytes)`)
  const sealed = sealBackup(root, opened.value, 'replace', packageBody, true, at)
  if (!sealed.ok) return { ok: false, error: { ...sealed.error } }

  const applied = hunks.filter((hunk) => hunk.status === 'accepted').map((hunk) => hunk.index)
  const skipped = hunks.filter((hunk) => hunk.status === 'rejected').map((hunk) => hunk.index)
  const nextMeta: ProposalMeta = {
    ...meta,
    status: 'applied',
    apply: { at: at.toISOString(), backup: opened.value.dir, before: { bytes: before.bytes, sha256: before.sha256 }, after, accepted: applied },
  }
  const stored = writeJsonAtomic(root, read.value.metaPath, nextMeta)
  if (!stored.ok) {
    // The chapter is written; only the bookkeeping failed. Say so instead of claiming
    // the apply did not happen — the backup package is on disk either way.
    return fail(stored.error.code, `the chapter was written but the proposal record could not be updated: ${stored.error.message}`, {
      root,
      path: stored.error.path,
      hint: `roll back with the backup package ${opened.value.dir} if the file must go back`,
    })
  }

  const result = written
  return {
    ok: true,
    value: {
      ok: true,
      root,
      proposalId: meta.proposalId,
      chapterId: result.chapter.chapterId,
      path: meta.path,
      backup: opened.value.dir,
      before: { bytes: before.bytes, sha256: before.sha256 },
      after,
      applied,
      skipped,
      bytes: after.bytes,
      catalogRebuilt: result.catalogRebuilt,
      indexRebuilt: result.indexRebuilt,
      commitSuggestion: `git add "${meta.path}" && git commit -m "revise(${meta.chapterId}): 应用提案 ${meta.proposalId}（接受 ${String(applied.length)} 段）"`,
    },
  }
}

/** The chapter body as it is on disk right now; `undefined` when the file cannot be read. */
function readBody(root: string, relativePath: string): string | undefined {
  try {
    return parseMarkdown(readFileSync(absolute(root, relativePath), 'utf8')).body
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// inkflow_proposal_rollback
// ---------------------------------------------------------------------------

export interface RollbackProposalInput {
  proposalId: string
  confirm?: boolean
  at?: Date
}

export interface RollbackProposalOk {
  ok: true
  root: string
  proposalId: string
  backup: string
  restored: string[]
  /** True when the chapter's bytes are byte-for-byte what they were before the apply. */
  verified: boolean
  before: ProposalDigest
  bytes: number
}

/**
 * Undo an applied proposal by replaying its backup package.
 *
 * `rollbackBackup` is the one implementation of "put these bytes back": it verifies the
 * current digest first, writes the copy **verbatim** (BOM and CRLF included) and then
 * checks the result — which is why a rollback that reports `verified: true` really is
 * byte-identical, not "the same text". A chapter edited after the apply is a
 * `BACKUP_CONFLICT` with the file left alone: the author's newer text wins over a
 * snapshot.
 */
export function rollbackProposal(projectRoot: string, input: RollbackProposalInput): ProposalResult<RollbackProposalOk> {
  const root = resolve(projectRoot)
  const at = input.at ?? new Date()
  if (input.confirm !== true) {
    return fail('CONFIRM_REQUIRED', 'rolling a proposal back rewrites a chapter, so it needs confirm: true', { root })
  }
  const read = readProposal(root, input.proposalId)
  if (!read.ok) return read
  const { meta } = read.value
  if (meta.status !== 'applied' || meta.apply === null) {
    return fail('PROPOSAL_STATUS', `proposal ${meta.proposalId} is ${meta.status}, so there is nothing to roll back`, {
      root,
      path: read.value.metaPath,
      nothingWritten: true,
      hint: 'rollback undoes one apply; an open proposal has written nothing',
    })
  }
  const undone = rollbackBackup(root, meta.apply.backup, at)
  if (!undone.ok) {
    const error: BackupError = undone.error
    return fail(error.code, error.message, {
      ...(error.root === undefined ? { root } : { root: error.root }),
      ...(error.path === undefined ? { path: error.path } : { path: error.path }),
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    })
  }

  const after = fingerprintProjectFile(root, meta.path)
  const verified = after !== undefined && after.sha256 === meta.apply.before.sha256
  const nextMeta: ProposalMeta = {
    ...meta,
    status: 'rolled-back',
    rollback: { at: at.toISOString(), backup: meta.apply.backup, verified, restored: [...undone.restored] },
  }
  const stored = writeJsonAtomic(root, read.value.metaPath, nextMeta)
  if (!stored.ok) {
    return fail(stored.error.code, `the chapter was restored but the proposal record could not be updated: ${stored.error.message}`, {
      root,
      path: stored.error.path,
    })
  }
  return {
    ok: true,
    value: {
      ok: true,
      root,
      proposalId: meta.proposalId,
      backup: meta.apply.backup,
      restored: [...undone.restored],
      verified,
      before: meta.apply.before,
      bytes: after?.size ?? 0,
    },
  }
}
