/**
 * The private purge area's **actions**: clean one thing up, and (below) put one thing back
 * (#199, [ADR-0026](../../../.agents/adrs/0026-private-purge-area.md)).
 *
 * Split from `private-purge.ts`, and not only because a new file must stay under 600 lines:
 * the seam is what a reader needs. That file owns the **shape** (the layout, the manifest row,
 * what may be restored where); this one owns the **verbs** and the order they must happen in.
 *
 * The order is the whole safety argument, and it is the recovery bin's order for the same
 * reason: copies first (each verified byte for byte), then the manifest row — *before* any
 * source is removed, so a crash leaves "copy + row + source" (duplicated, recoverable) instead
 * of "copy + source, no row" (an orphan nobody can find) — then the `.gitignore` line, then the
 * sources, then the `.inkflow/audit/purge-<stamp>.md` record. Every refusal before the manifest
 * therefore writes nothing at all.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

import { removeEmptyProjectDirectory, removeProjectFile, writeTextAtomic } from './io.js'
import { absoluteOf, digestBytes } from './private-manifest.js'
import {
  PURGE_KINDS,
  PURGE_MANIFEST_RELATIVE,
  PURGE_REASON_AUTHOR_CLEANUP,
  digestOfFiles,
  filesUnder,
  privateRelativeOf,
  projectRelativeOf,
  purgeFailure,
  purgedPathOf,
  readManifest,
  restoreTargetOf,
  writeManifest,
} from './private-purge.js'
import type { PurgeEntry, PurgeFailure, PurgeKind, PurgedFile } from './private-purge.js'
import { ensurePrivateStateIgnored, privateStateDirRelative, privateStateRelative } from './private-state.js'
import { readProposal } from './proposal.js'
import { reviewDirOf, reviewRunPath } from './review-store.js'

/** Who asked. `sessionId` is what makes "who removed it" answerable after the fact. */
export interface PurgeSource {
  /** The path the request came in on; `panel` today. */
  readonly channel: string
  readonly sessionId: string
}

export interface CleanUpInput {
  readonly kind: PurgeKind
  /** `<chapterId>/<runId>` for a run, `<proposalId>` for a proposal. */
  readonly target: string
  /** Must be exactly `true` (the panel asks twice). */
  readonly confirm?: boolean
  readonly source?: PurgeSource
  /** Injectable clock, so a test can pin the record's stamp and the entry's time. */
  readonly at?: Date
}

export interface CleanUpOk {
  ok: true
  root: string
  entry: PurgeEntry
  /** The `.inkflow/audit/purge-<stamp>.md` that now records the cleanup. */
  record: string
  /** `false` when the move succeeded but its record could not be written (reported, not hidden). */
  recordWritten: boolean
  /** How many entries the area holds afterwards. */
  remaining: number
}

export type CleanUpResult = CleanUpOk | PurgeFailure

export interface RestoreInput {
  /** The manifest row to put back. */
  readonly id: string
  readonly source?: PurgeSource
  readonly at?: Date
}

export interface RestoreOk {
  ok: true
  root: string
  entry: PurgeEntry
  /** The private-state paths that were written back, in manifest order. */
  files: string[]
  record: string
  recordWritten: boolean
}

export type RestoreResult = RestoreOk | PurgeFailure

/**
 * The record file name: `purge-<YYYYMMDD>-<HHmmss>.md`, same shape as the audit reports.
 *
 * Local time, because the author reads it beside `audit-*.md` / `repair-*.md` and those are
 * named the same way; the row's own `deletedAt` stays UTC.
 */
export function purgeRecordName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp =
    `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `purge-${stamp}.md`
}

/**
 * The record body.
 *
 * No absolute path and no chapter text (data-safety §5): the record is about private state,
 * and a relative path plus a byte count is everything a later reader needs to find the copy.
 */
export function renderPurgeRecord(action: 'clean' | 'restore', entry: PurgeEntry, source: PurgeSource | undefined): string {
  const lines = [
    '# 私有状态清理记录',
    '',
    `- 动作：${action === 'clean' ? '清理（搬进 .inkflow/purged/）' : '还原（从 .inkflow/purged/ 写回）'}`,
    `- 时间：${entry.deletedAt}`,
    `- 来源：${source === undefined ? '未知' : `${source.channel} · 会话 ${source.sessionId}`}`,
    `- 类型：${entry.kind}`,
    `- 目标：${entry.target}`,
    `- 说明：${entry.label}`,
    `- 字节：${String(entry.bytes)}`,
    `- 清单 id：${entry.id}`,
    '',
    '## 文件',
    '',
    ...entry.files.map((file) => `- \`${file.path}\` · ${String(file.bytes)} 字节 · ${file.sha256}`),
    '',
  ]
  return lines.join('\n')
}

/**
 * Copy one file into the area and prove the copy before anything is removed.
 *
 * `path` is the `.inkflow/`-relative form the manifest stores; the project-relative source is
 * derived (`projectRelativeOf`), so a manifest row can never name a location outside the state
 * directory it came from.
 *
 * The text writer is the only door (`io.ts`), so a source that is not valid UTF-8 could not come
 * back byte-identical — it is refused instead of being destroyed (the rule the recovery bin
 * applies for the same reason).
 */
function stageCopy(root: string, path: string): { ok: true; file: PurgedFile } | PurgeFailure {
  let bytes: Buffer
  try {
    bytes = readFileSync(absoluteOf(root, projectRelativeOf(path)))
  } catch (cause) {
    return purgeFailure('PURGE_TARGET_NOT_FOUND', `${path} could not be read: ${String(cause)}`, {
      root,
      path,
      nothingWritten: true,
    })
  }
  const sha256 = digestBytes(bytes)
  const text = bytes.toString('utf8')
  if (digestBytes(Buffer.from(text, 'utf8')) !== sha256) {
    return purgeFailure('PURGE_COPY_MISMATCH', `${path} is not valid UTF-8, so a byte-exact copy cannot be made`, {
      root,
      path,
      hint: 'the file is left untouched',
      nothingWritten: true,
    })
  }

  const target = purgedPathOf(path)
  if (existsSync(absoluteOf(root, target))) {
    return purgeFailure('PURGE_ENTRY_EXISTS', `${target} already exists, so this copy would overwrite an earlier one`, {
      root,
      path: target,
      nothingWritten: true,
    })
  }
  const written = writeTextAtomic(root, target, text, { verbatim: true })
  if (!written.ok) {
    return purgeFailure(written.error.code, `the copy of ${path} could not be written: ${written.error.message}`, {
      root,
      path: target,
      nothingWritten: true,
    })
  }
  let copied: Buffer
  try {
    copied = readFileSync(absoluteOf(root, target))
  } catch (cause) {
    removeProjectFile(root, target)
    return purgeFailure('PURGE_COPY_MISMATCH', `the copy of ${path} could not be read back: ${String(cause)}`, {
      root,
      path: target,
      nothingWritten: true,
    })
  }
  if (digestBytes(copied) !== sha256) {
    removeProjectFile(root, target)
    return purgeFailure('PURGE_COPY_MISMATCH', `the copy of ${path} does not match the source bytes`, {
      root,
      path,
      hint: 'the source is left untouched',
      nothingWritten: true,
    })
  }
  return { ok: true, file: { path, bytes: bytes.byteLength, sha256 } }
}

/** The deletion record; its failure is reported, never swallowed (the move already happened). */
function writeRecord(
  root: string,
  action: 'clean' | 'restore',
  entry: PurgeEntry,
  source: PurgeSource | undefined,
  at: Date,
): { ok: boolean; relative: string } {
  const relative = privateStateRelative('audit', purgeRecordName(at))
  const written = writeTextAtomic(root, relative, renderPurgeRecord(action, entry, source))
  return { ok: written.ok, relative }
}

/** Move one set of files into the area, record it, and drop the sources (see the file header). */
function moveIntoArea(
  root: string,
  request: {
    readonly kind: PurgeKind
    readonly target: string
    readonly label: string
    readonly sources: readonly string[]
    readonly source?: PurgeSource
    readonly at: Date
  },
): CleanUpResult {
  const open = readManifest(root)
  if (!open.ok) return open

  const staged: PurgedFile[] = []
  for (const path of request.sources) {
    const result = stageCopy(root, path)
    if (result.ok === false) {
      for (const done of staged) removeProjectFile(root, purgedPathOf(done.path))
      return result
    }
    staged.push(result.file)
  }

  const entry: PurgeEntry = {
    id: randomUUID(),
    kind: request.kind,
    target: request.target,
    label: request.label,
    deletedAt: request.at.toISOString(),
    bytes: staged.reduce((sum, file) => sum + file.bytes, 0),
    sha256: digestOfFiles(staged),
    reason: PURGE_REASON_AUTHOR_CLEANUP,
    files: staged,
  }
  const recorded = writeManifest(root, [entry, ...open.entries])
  if (!recorded.ok) {
    for (const done of staged) removeProjectFile(root, purgedPathOf(done.path))
    return { ok: false, error: { ...recorded.error, nothingWritten: true } }
  }

  // The ignore line appears when the area is first used, not from the gate (ADR-0012 #2).
  ensurePrivateStateIgnored(root)

  for (const file of staged) {
    const removed = removeProjectFile(root, projectRelativeOf(file.path))
    if (!removed.ok) {
      // Unwind, so the area never claims a file that still sits in the working tree.
      const unwound = writeManifest(root, open.entries)
      for (const copy of staged) removeProjectFile(root, purgedPathOf(copy.path))
      return purgeFailure(removed.error.code, `${file.path} could not be removed: ${removed.error.message}`, {
        root,
        path: file.path,
        rolledBack: unwound.ok,
      })
    }
  }

  const record = writeRecord(root, 'clean', entry, request.source, request.at)
  return { ok: true, root, entry, record: record.relative, recordWritten: record.ok, remaining: open.entries.length + 1 }
}

/**
 * Clean up one review run: `.inkflow/review/<chapterId>/<runId>.json` moves into the area.
 *
 * `<chapterId>/<runId>` is what the panel already shows and what `GET /review` addresses, so
 * the target is the pair rather than a path: the run's own path is derived here, and a pair
 * that would climb out cannot be expressed.
 */
export function cleanUpReviewRun(
  projectRoot: string,
  chapterId: string,
  runId: string,
  request: Omit<CleanUpInput, 'kind' | 'target'>,
): CleanUpResult {
  const root = projectRoot
  const chapter = chapterId.trim()
  const run = runId.trim()
  if (chapter === '' || run === '' || chapter.includes('/') || run.includes('/')) {
    return purgeFailure('PURGE_TARGET_INVALID', `${chapterId}/${runId} is not a chapter id and a run id`, {
      root,
      nothingWritten: true,
    })
  }
  const path = reviewRunPath(chapter, run)
  const statePath = privateRelativeOf(path)
  if (statePath === undefined) {
    return purgeFailure('PURGE_TARGET_INVALID', `${path} is not inside the private state directory`, {
      root,
      path,
      nothingWritten: true,
    })
  }
  if (!existsSync(absoluteOf(root, path))) {
    return purgeFailure('PURGE_TARGET_NOT_FOUND', `${path} does not exist`, { root, path, nothingWritten: true })
  }
  const moved = moveIntoArea(root, {
    kind: 'review-run',
    target: `${chapter}/${run}`,
    label: `${chapter} · 运行 ${run}`,
    sources: [statePath],
    ...(request.source === undefined ? {} : { source: request.source }),
    at: request.at ?? new Date(),
  })
  if (!moved.ok) return moved
  // The chapter's run directory goes too once it is empty — a leftover empty directory would
  // make the panel think there is a chapter with no runs.
  removeEmptyProjectDirectory(root, reviewDirOf(chapter))
  return moved
}

/**
 * Clean up one proposal: `.inkflow/proposals/<proposalId>/` moves into the area, whole.
 *
 * `open` is refused (`PURGE_OPEN_PROPOSAL`): an undecided proposal is a decision the author has
 * not made yet, and cleaning it up throws away work nobody judged. The status comes from
 * `proposal.ts` — the same field the inbox prints — so "finished" cannot mean two things in two
 * places.
 */
export function cleanUpProposal(
  projectRoot: string,
  proposalId: string,
  request: Omit<CleanUpInput, 'kind' | 'target'>,
): CleanUpResult {
  const root = projectRoot
  const read = readProposal(root, proposalId)
  if (!read.ok) {
    return purgeFailure('PURGE_TARGET_NOT_FOUND', `${String(proposalId)} is not a proposal of this book`, {
      root,
      nothingWritten: true,
    })
  }
  const meta = read.value.meta
  if (meta.status === 'open') {
    return purgeFailure('PURGE_OPEN_PROPOSAL', `${meta.proposalId} is still open: only a finished proposal can be cleaned up`, {
      root,
      path: read.value.dir,
      hint: '把每段决定完、再应用或回滚之后再清理：未决定的提案一个字都还没进正文',
      nothingWritten: true,
    })
  }
  const sources = filesUnder(root, read.value.dir).map((file) => file.path)
  if (sources.length === 0) {
    return purgeFailure('PURGE_TARGET_NOT_FOUND', `${read.value.dir} holds no files`, { root, nothingWritten: true })
  }
  const moved = moveIntoArea(root, {
    kind: 'proposal',
    target: meta.proposalId,
    label: `${meta.proposalId} · ${meta.title} · ${meta.status}`,
    sources,
    ...(request.source === undefined ? {} : { source: request.source }),
    at: request.at ?? new Date(),
  })
  if (!moved.ok) return moved
  // The proposal's own directories go too: `<id>/hunks` then `<id>`. An empty leftover would
  // keep showing up as an inbox row with nothing in it.
  for (const file of moved.entry.files) {
    const parts = projectRelativeOf(file.path).split('/')
    for (let depth = parts.length - 1; depth >= 3; depth -= 1) {
      removeEmptyProjectDirectory(root, parts.slice(0, depth).join('/'))
    }
  }
  return moved
}

/**
 * Clean up one thing, whichever kind the caller named.
 *
 * `confirm` is checked here rather than in the channel so no second caller can forget it: this
 * is the only move that takes bytes out of the state the panels read, and `confirm: true` is
 * the second click ADR-0012 #4 asks for.
 */
export function cleanUp(projectRoot: string, input: CleanUpInput): CleanUpResult {
  const root = projectRoot
  if (input.confirm !== true) {
    return purgeFailure('CONFIRM_REQUIRED', 'cleaning up moves private state out of the panels and needs a second confirmation', {
      root,
      hint: 'pass `confirm: true` (the panel asks twice)',
      nothingWritten: true,
    })
  }
  const target = String(input.target ?? '').trim()
  if (target === '') {
    return purgeFailure('PURGE_TARGET_INVALID', 'a cleanup needs a target', { root, nothingWritten: true })
  }
  const rest = { ...(input.source === undefined ? {} : { source: input.source }), ...(input.at === undefined ? {} : { at: input.at }) }
  if (input.kind === 'review-run') {
    const [chapterId, runId, extra] = target.split('/')
    if (chapterId === undefined || runId === undefined || extra !== undefined) {
      return purgeFailure('PURGE_TARGET_INVALID', `${target} is not \`<chapterId>/<runId>\``, { root, nothingWritten: true })
    }
    return cleanUpReviewRun(root, chapterId, runId, rest)
  }
  if (input.kind === 'proposal') return cleanUpProposal(root, target, rest)
  return purgeFailure('PURGE_KIND_INVALID', `${String(input.kind)} is not a cleanable kind (${PURGE_KINDS.join(' / ')})`, {
    root,
    nothingWritten: true,
  })
}

/** Remove now-empty directories inside the area, deepest first, stopping at the area itself. */
export function pruneEmptyAreaDirs(root: string, projectRelativeFile: string): void {
  const floor = privateStateDirRelative('purged')
  let directory = projectRelativeFile.replaceAll('\\', '/').split('/').slice(0, -1).join('/')
  while (directory.startsWith(`${floor}/`)) {
    const removed = removeEmptyProjectDirectory(root, directory)
    if (!removed.ok) return
    directory = directory.split('/').slice(0, -1).join('/')
  }
}

/**
 * Put one cleanup back: every file returns to the private-state path it left, byte for byte.
 *
 * Three refusals, all before the first write: an unknown row, a copy that is gone or changed
 * since it was recorded (restoring it would hand back bytes that were never cleaned up), and a
 * target that already exists (the author's newer state wins — the area keeps its copy). The
 * target is derived by `restoreTargetOf`, so a row can only write inside
 * `.inkflow/{review,proposals}`.
 */
export function restorePurged(projectRoot: string, input: RestoreInput): RestoreResult {
  const root = projectRoot
  const open = readManifest(root)
  if (!open.ok) return open

  const entry = open.entries.find((candidate) => candidate.id === input.id)
  if (entry === undefined) {
    return purgeFailure('PURGE_ENTRY_NOT_FOUND', `the purge area has no entry ${String(input.id)}`, {
      root,
      hint: 'list the area first; an entry leaves it when it is restored',
      nothingWritten: true,
    })
  }

  const plans: { file: PurgedFile; target: string; text: string }[] = []
  for (const file of entry.files) {
    const target = restoreTargetOf(file.path)
    if (target === undefined) {
      return purgeFailure('PURGE_RESTORE_PATH_REFUSED', `${file.path} is not inside .inkflow/{review,proposals}`, {
        root,
        path: file.path,
        hint: 'only a review run or a proposal can be put back',
        nothingWritten: true,
      })
    }
    const copy = absoluteOf(root, purgedPathOf(file.path))
    let bytes: Buffer
    try {
      bytes = readFileSync(copy)
    } catch (cause) {
      return purgeFailure('PURGE_COPY_MISSING', `the copy of ${file.path} could not be read: ${String(cause)}`, {
        root,
        path: purgedPathOf(file.path),
        nothingWritten: true,
      })
    }
    if (digestBytes(bytes) !== file.sha256) {
      return purgeFailure('PURGE_COPY_CHANGED', `the copy of ${file.path} no longer matches the recorded digest`, {
        root,
        path: purgedPathOf(file.path),
        hint: 'restoring it would not give back the bytes that were cleaned up',
        nothingWritten: true,
      })
    }
    if (existsSync(absoluteOf(root, target))) {
      return purgeFailure('PURGE_TARGET_EXISTS', `${target} exists again, so the area will not overwrite it`, {
        root,
        path: target,
        hint: 'move or clean up the file at that path, then restore again; the area keeps its copy until then',
        nothingWritten: true,
      })
    }
    plans.push({ file, target, text: bytes.toString('utf8') })
  }

  const written: string[] = []
  for (const plan of plans) {
    // `verbatim`: the normaliser would rewrite CRLF and drop a BOM, and the promise here is
    // the bytes that left, not the same-looking text (ADR-0016).
    const result = writeTextAtomic(root, plan.target, plan.text, { verbatim: true })
    if (!result.ok) {
      for (const done of written) removeProjectFile(root, done)
      return purgeFailure(result.error.code, `${plan.target} could not be written back: ${result.error.message}`, {
        root,
        path: plan.target,
        nothingWritten: written.length === 0,
      })
    }
    written.push(plan.target)
    if (digestBytes(readFileSync(absoluteOf(root, plan.target))) !== plan.file.sha256) {
      removeProjectFile(root, plan.target)
      for (const done of written.filter((path) => path !== plan.target)) removeProjectFile(root, done)
      return purgeFailure('PURGE_RESTORE_MISMATCH', `the restored ${plan.target} does not match the recorded bytes`, {
        root,
        path: plan.target,
        hint: 'the half-written file was removed again; the area still holds the copy',
        nothingWritten: true,
      })
    }
  }

  for (const plan of plans) {
    removeProjectFile(root, purgedPathOf(plan.file.path))
    pruneEmptyAreaDirs(root, purgedPathOf(plan.file.path))
  }
  const remaining = open.entries.filter((candidate) => candidate.id !== entry.id)
  const stored = writeManifest(root, remaining)
  const record = writeRecord(root, 'restore', entry, input.source, input.at ?? new Date())
  if (!stored.ok) {
    return purgeFailure(stored.error.code, `restored ${entry.target}, but ${stored.error.message}`, {
      root,
      path: PURGE_MANIFEST_RELATIVE,
    })
  }
  return { ok: true, root, entry, files: written, record: record.relative, recordWritten: record.ok }
}
