/**
 * The private panel channel's projection layer (ADR-0008).
 *
 * This module answers one question and derives four read-only projections from
 * it: **which book does this browser request belong to?** The browser carries
 * nothing but a `sessionId` (ADR-0008 D4); the root directory is resolved here
 * from Host services, never from the request.
 *
 * Why the resolution lives here instead of `tools.ts`: the tool surface
 * resolves from `exec.agent` (a model-facing call always has one), while an
 * HTTP request has only a session id string. Both must reach the *same* gate
 * verdict and the *same* `actions[]` (ADR-0008 D5), so this module reuses
 * `inspectProject` / `findProjectRoot` / `projectLabel` instead of duplicating
 * the four-state logic.
 *
 * WRITE DISCIPLINE: nothing here writes. `inspectProject` is called with
 * `recreateIndexDir: false` (its only write path), the catalog is read through
 * the projection API, the index is opened `readOnly`, and the chapter file is
 * only read. A browser request must never repair, rebuild or scaffold a book —
 * that stays behind a tool call the user confirmed (ADR-0006 D3).
 */

import type { HostContext, SessionsLike, SessionLike, WorkingDirectoryLike, WorkspaceRegistryLike } from './context.js'
import { getLoadedBuild, summarizeBuild } from './build-info.js'
import type { ProjectProbe, ProjectState } from './project.js'
import { findProjectRoot, inspectProject } from './project.js'
import type { ChannelResolution, ChannelTarget, JsonRecord, SessionRoot, SessionRootSource } from './internal-types.js'

/** The internal prefix. Not an API: no version segment, no compatibility promise. */
export const INTERNAL_PREFIX = '/inkflow/internal'

/**
 * Upper bound for a request body.
 *
 * Why 1 MiB and not the 64 KiB this used to be: a save carries a whole
 * chapter or a whole setting entry as ONE JSON string, and the ceiling counts the
 * serialised bytes, not the prose. Measured on a real book: a body with 20,000
 * Chinese characters serialises to ~70 KB, so a long chapter could not be saved at
 * all — the panel answered `413 payload-too-large` and stayed in the editor. 1 MiB
 * is ~350k Chinese characters: far beyond any single chapter, still a guard
 * against a local page pushing megabytes through a socket nobody reads. The value
 * is exported so the tests state the ceiling once instead of hard-coding it.
 */
export const MAX_INTERNAL_BODY_BYTES = 1024 * 1024

/** Where the client puts its session identity (query wins over header). */
export const SESSION_ID_PARAM = 'sessionId'
export const SESSION_ID_HEADER = 'x-inkflow-session'

/**
 * Parameter names that would let the caller name a directory. ADR-0008 D4
 * refuses them in query *and* body before any filesystem access.
 */
export const FORBIDDEN_PATH_PARAMS = ['root', 'path', 'cwd', 'workspace', 'projectRoot'] as const

/** Session ids seen from DSH are `session-<n>` / uuid-shaped; nothing exotic. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,200}$/

// ---------------------------------------------------------------------------
// Host service narrowing
//
// Every service is optional (ADR-0008 D4): a profile may lack the workspace
// registry, the session store or workingDirectory, and the chain then simply
// falls through to its next step. Shape checks keep a Host upgrade from turning
// a missing method into a thrown TypeError inside a request handler.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function asSessions(value: unknown): SessionsLike | undefined {
  const record = asRecord(value)
  if (record === undefined || typeof record['get'] !== 'function') return undefined
  return value as SessionsLike
}

function asWorkspaceRegistry(value: unknown): WorkspaceRegistryLike | undefined {
  const record = asRecord(value)
  if (record === undefined || typeof record['list'] !== 'function') return undefined
  return value as WorkspaceRegistryLike
}

function asWorkingDirectory(value: unknown): WorkingDirectoryLike | undefined {
  const record = asRecord(value)
  if (record === undefined || typeof record['get'] !== 'function') return undefined
  return value as WorkingDirectoryLike
}

// ---------------------------------------------------------------------------
// Session → project root (ADR-0008 D4)
// ---------------------------------------------------------------------------

/**
 * The two spellings a session id can arrive in.
 *
 * DSH stores a workspace's `sessionIds` with a `session-` prefix while the
 * session log and some protocol surfaces use the bare id (observed on
 * 0.2.1-rc.2: `~/.dsh/storages/workspace.json` lists `session-<uuid>`, the
 * session log header carries `<uuid>`). The channel must match either spelling
 * rather than report "no session" for a session that plainly exists.
 */
function sessionIdCandidates(sessionId: string): string[] {
  const prefix = 'session-'
  if (sessionId.startsWith(prefix)) {
    const bare = sessionId.slice(prefix.length)
    return bare === '' ? [sessionId] : [sessionId, bare]
  }
  return [sessionId, `${prefix}${sessionId}`]
}

/**
 * Resolve a session to the directory it belongs to, first hit wins:
 *
 *   1. `workspaceRegistry.list()` — a Workspace whose `sessionIds` contains the
 *      session. Its `path` is already `fs.realpath`-canonicalised by the host.
 *   2. `workingDirectory.get(sessions.get(sessionId))` — the committed,
 *      possibly-changed directory.
 *   3. `sessions.get(sessionId).header.cwd` — the creation-time directory.
 *
 * `undefined` means "cannot answer", which the caller turns into a structured
 * `NO_SESSION_CONTEXT` refusal. A plugin-wide remembered path is never a
 * substitute (that would report someone else's book as this session's project).
 */
export function resolveSessionRoot(ctx: HostContext, sessionId: string): SessionRoot | undefined {
  const candidates = sessionIdCandidates(sessionId)

  const registry = asWorkspaceRegistry(ctx.get('workspaceRegistry'))
  if (registry !== undefined) {
    for (const workspace of registry.list()) {
      const record = asRecord(workspace)
      if (record === undefined) continue
      const path = nonEmptyString(record['path'])
      const sessionIds = record['sessionIds']
      if (path === undefined || !Array.isArray(sessionIds)) continue
      if (candidates.some((candidate) => sessionIds.includes(candidate))) {
        return { sessionId, root: path, source: 'workspace-registry' }
      }
    }
  }

  const sessions = asSessions(ctx.get('sessions'))
  let session: SessionLike | undefined
  for (const candidate of candidates) {
    session = sessions?.get(candidate)
    if (session !== undefined) break
  }
  if (session === undefined) return undefined

  const workingDirectory = asWorkingDirectory(ctx.get('workingDirectory'))
  if (workingDirectory !== undefined) {
    try {
      const directory = nonEmptyString(workingDirectory.get(session))
      if (directory !== undefined) return { sessionId, root: directory, source: 'working-directory' }
    } catch {
      // A service that cannot answer must not decide the request: fall through.
    }
  }

  const created = nonEmptyString(session.header?.cwd)
  if (created !== undefined) return { sessionId, root: created, source: 'session-header' }
  return undefined
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * Same codes the tools return for the same state (ADR-0008 D5). Kept in one
 * place here rather than imported from `tools.ts`: that file's mapper is
 * module-private by design and the tool surface is being edited in parallel.
 */
function gateErrorCode(state: ProjectState): string {
  if (state === 'needs-newer-plugin') return 'PROJECT_NEEDS_NEWER_PLUGIN'
  if (state === 'needs-repair') return 'PROJECT_NEEDS_REPAIR'
  return 'NOT_AN_INKFLOW_PROJECT'
}

function gateHint(state: ProjectState): string {
  if (state === 'needs-newer-plugin') {
    return 'this book was written by a newer dsh-inkflow; tell the user to upgrade the plugin. Do not repair, rewrite or re-index it from this version.'
  }
  if (state === 'needs-repair') {
    return 'the book exists but is incomplete or damaged; run inkflow_project_plan for the exact list, show it to the user, then inkflow_project_init with confirm: true'
  }
  return 'an InkFlow project is a git repository with nine content directories (each carrying .gitkeep) plus index/ and inkflow.json; run inkflow_project_plan to see what would be created'
}

/** The structured four-state refusal, shaped like the tool-side checklist. */
export function gateFailureBody(sessionId: string, root: string, source: SessionRootSource, probe: ProjectProbe): JsonRecord {
  const state = probe.state
  return {
    ok: false,
    error: {
      code: gateErrorCode(state),
      state,
      message: `this directory is not a usable InkFlow project (state: ${state})`,
      needsSetup: state === 'needs-setup',
      needsRepair: state === 'needs-repair',
      readOnly: probe.readOnly,
      root: probe.root,
      sessionId,
      resolvedFrom: source,
      searchedFrom: 'session-workspace',
      checks: probe.checks,
      missing: probe.missing,
      actions: probe.actions,
      reasons: probe.reasons,
      ...(probe.metaError === undefined ? {} : { metaError: probe.metaError }),
      ...(probe.metaRaw === undefined ? {} : { metaRaw: probe.metaRaw }),
      hint: gateHint(state),
    },
  }
}

/**
 * The "cannot answer yet" refusal: HTTP 200 + `ok:false`. It is not a transport
 * failure, and it writes nothing — the book it would have named is unknown.
 */
export function noSessionContextBody(version: string, sessionId?: string): JsonRecord {
  return {
    ok: false,
    pluginVersion: version,
    error: {
      code: 'NO_SESSION_CONTEXT',
      ...(sessionId === undefined ? {} : { sessionId }),
      message: 'this request carries no session that maps to a workspace, so its project cannot be named',
      actions: [
        'open the InkFlow panel from a novel session (conversation.view) instead of a global page',
        'run inkflow_project_status in that session to see the project gate',
      ],
      hint: 'use the inkflow_* tools from the novel session; the panel only projects the book of its own session',
    },
  }
}

/**
 * Attach the loaded-build summary to a refusal envelope.
 *
 * The stale-build banner has to render on the "needs setup" / "needs repair"
 * screens too: that screen is exactly what a stale generation shows for a book
 * that is in fact usable, so the summary must travel with the refusal and not
 * only with `value`. It goes under `error` (the envelope's payload half) so the
 * Client half keeps its `{ok,value|error}` shape.
 */
function withBuild(failure: JsonRecord, version: string): JsonRecord {
  const error = asRecord(failure['error'])
  if (error === undefined) return failure
  return { ...failure, error: { ...error, build: summarizeBuild(getLoadedBuild({ version })) } }
}

/**
 * Resolve the request's session to a usable project. `findProjectRoot` walks up
 * exactly like the tool surface, so a session opened in a chapter directory
 * still names its book (ADR-0006 D5).
 */
export function resolveChannelTarget(ctx: HostContext, sessionId: string, version: string): ChannelResolution {
  const resolved = resolveSessionRoot(ctx, sessionId)
  if (resolved === undefined) return { failure: withBuild(noSessionContextBody(version, sessionId), version) }

  const root = findProjectRoot(resolved.root) ?? resolved.root
  // `recreateIndexDir: false`: this is the one write `inspectProject` performs
  // (ADR-0006 D2 relaxation) and a browser request must not perform it.
  const probe = inspectProject(root, { recreateIndexDir: false })
  if (probe.usable !== true) {
    return { failure: withBuild(gateFailureBody(sessionId, root, resolved.source, probe), version) }
  }
  return { target: { sessionId, root: probe.root, source: resolved.source, probe } }
}

/** `session-<n>` / uuid shapes only: a session id is an identifier, not a path. */
export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value)
}

/** The first forbidden path parameter present in `values`, if any. */
export function findPathParam(values: Iterable<[string, string]>): string | undefined {
  const forbidden = new Set<string>(FORBIDDEN_PATH_PARAMS)
  for (const [key] of values) {
    if (forbidden.has(key)) return key
  }
  return undefined
}

/** Same check for a JSON body: only top-level keys can name a directory. */
export function findPathParamInBody(body: JsonRecord): string | undefined {
  const forbidden = new Set<string>(FORBIDDEN_PATH_PARAMS)
  for (const key of Object.keys(body)) {
    if (forbidden.has(key)) return key
  }
  return undefined
}

// ---------------------------------------------------------------------------
// The setting library (roadmap X-7 / X-8)
//
// X-8 puts these payloads in this issue rather than in a view registry. The two
// readers live in `library-view.ts` and the single writer in `library-write.ts`;
// both are re-exported here so the channel keeps ONE entry point for `routes.ts`
// (this file already carries the session chain, five projections and the four
// chapter write routes — AGENTS.md §10.5: no 1000-line grab bag).
//
// The three read builders open the index `readOnly` and write nothing. The one
// writer changes a truth file through `io.ts` (atomic replace + write lock +
// path whitelist) and then invalidates the derived index.
// ---------------------------------------------------------------------------

export {
  LIBRARY_KINDS,
  LIBRARY_KIND_LIMIT,
  LIBRARY_ISSUE_LIMIT,
  buildLibrary,
  buildLibraryItem,
  buildLibraryIssues,
} from './library-view.js'
export type { LibraryIssueRow, LibraryItemReply, LibraryItemRow, LibrarySource } from './library-view.js'
export { LIBRARY_WRITE_BODY_FIELDS } from './library-request.js'
export { writeLibraryItem } from './library-write.js'
export type { LibraryWriteRequest } from './library-write.js'

/**
 * 影响面与改名（conventions §5.6): re-exported only, never implemented here.
 *
 * The listing and the rename write live in `impact.ts` / `impact-write.ts` — this
 * file already carries the session chain and the library projections, and the two
 * new routes need exactly the same `{sessionId, root}` target as the library ones
 * and nothing else from it.
 */
export { IMPACT_KINDS, buildImpact } from './impact.js'
export type { ImpactReply, ImpactRequest, ImpactSource } from './impact.js'
export { RENAME_BODY_FIELDS, renameEntity } from './impact-write.js'
export type { RenameRequest } from './impact-write.js'
// The recovery bin: the domain lives in `trash.ts` (imported by
// `chapters.ts` as well), the three channel replies in `trash-channel.ts`. Both
// are re-exported here so `routes.ts` keeps ONE entry point for the channel.
export {
  TRASH_PURGE_BODY_FIELDS,
  TRASH_RESTORE_BODY_FIELDS,
  purgeTrashReply,
  restoreTrashReply,
  trashListReply,
} from './trash-channel.js'
export type { TrashReply, TrashSource } from './trash-channel.js'
// ---------------------------------------------------------------------------
// The foreshadow board (data-model §3.2). One read-only projection,
// so the payload layer keeps growing in its own module instead of in this one.
// ---------------------------------------------------------------------------

export { buildForeshadowBoard } from './domains/foreshadowing-query.js'
export type { ForeshadowSource } from './domains/foreshadowing-query.js'
// The board's write half: `POST /foreshadow/advance`, one legal state move; the descriptor travels with it.
export { FORESHADOW_ADVANCE_BODY_FIELDS, FORESHADOW_ROUTES, foreshadowAdvanceReply } from './foreshadow-channel.js'
// ---------------------------------------------------------------------------
// The consistency audit. The engine lives in `audit.ts` (scan → findings →
// Markdown; no HTTP, no writes on the read path), the two channel replies in
// `audit-channel.ts`; both are re-exported here so `routes.ts` keeps ONE entry point for
// the channel — the same arrangement the bin and the impact listing use.
// ---------------------------------------------------------------------------

export { AUDIT_EXPORT_BODY_FIELDS, auditWire, buildAudit, exportAudit, findingWire } from './audit-channel.js'
export type { AuditReply, AuditSource } from './audit-channel.js'
// ---------------------------------------------------------------------------
// Importing an old manuscript (X-17). The domain lives in `import.ts`
// (decode + split, pure) and `import-write.ts` (plan/apply + the backup package); the
// one channel reply in `import-channel.ts`. Re-exported here so `routes.ts` keeps ONE
// entry point for the channel, the same arrangement as the bin and the audit.
// ---------------------------------------------------------------------------

export { IMPORT_BODY_FIELDS, importViaChannel } from './import-channel.js'
export type { ImportChannelRequest, ImportChannelSource, ImportReply } from './import-channel.js'
// ---------------------------------------------------------------------------
// The extraction queue (X-20, ADR-0017). The store lives in `extract.ts`
// (candidates only), the write path in `extract-accept.ts` (the one place a candidate
// becomes a file), the four channel replies in `extract-channel.ts`. Re-exported here so
// `routes.ts` keeps ONE entry point for the channel, the same arrangement as the bin,
// the audit and the import.
// ---------------------------------------------------------------------------

export {
  CANDIDATES_ACCEPT_BODY_FIELDS,
  CANDIDATES_PURGE_BODY_FIELDS,
  CANDIDATES_REJECT_BODY_FIELDS,
  CANDIDATE_PAGE_LIMIT,
  acceptViaChannel,
  buildCandidates,
  purgeViaChannel,
  rejectViaChannel,
} from './extract-channel.js'
export type { CandidateReply, CandidateSource } from './extract-channel.js'
// ---------------------------------------------------------------------------
// The nine-segment brief (ADR-0022 D1/D2, X-23). The assembly lives in
// `writing-context.ts` (`buildWritingBrief`, beside the six-segment context it must not
// disturb), the two new sources in `brief-sources.ts`, the audit record and both channel
// replies in `brief.ts`. Re-exported here so `routes.ts` keeps ONE entry point for the
// channel — the same arrangement as the bin, the audit, the import and
// the queue.
// ---------------------------------------------------------------------------

export { BRIEF_AUDIT_BODY_FIELDS, briefOptionsFromQuery, buildBrief, exportBriefAudit } from './brief.js'
export type { BriefChannelSource, BriefReply } from './brief.js'
// The quality gate (ADR-0022 D4, X-24/X-26). The engine is `gate.ts`
// (files → seven checks → the deterministic conclusion file under `.inkflow/audit/`),
// the rules in `gate-rules.ts`. Re-exported here so `routes.ts` keeps ONE entry point for
// the channel, the same arrangement as the audit and the extraction queue.
// ---------------------------------------------------------------------------

export { GATE_CHECK_IDS, GATE_LIST_LIMIT, buildGate } from './gate.js'
export type { GateReport, GateResult } from './gate.js'
// The review DAG (ADR-0022 D3, X-24/X-26). The engine is `review.ts` (one read
// pass → five independent nodes → the run record under `.inkflow/review/`), the comparison
// table `review-compare.ts`, the tool surface `review-tools.ts`. Re-exported here so
// `routes.ts` keeps ONE entry point for the channel, the same arrangement as the gate.
// ---------------------------------------------------------------------------

export { buildReviewList } from './review.js'
export { buildReviewCompare } from './review-compare.js'
export type { ReviewOpinion } from './review-locate.js'
export type { ReviewRunRecord } from './review-store.js'
// ---------------------------------------------------------------------------
// The proposal tab (ADR-0023 D5). The store and its four actions live in
// `proposal.ts` / the wire in `proposal-channel.ts`. Re-exported here so `routes.ts` keeps
// ONE entry point for the channel — the same arrangement as the bin, the audit,
// the import, the queue and the gate.
// ---------------------------------------------------------------------------

export {
  PROPOSAL_APPLY_BODY_FIELDS,
  PROPOSAL_DECIDE_BODY_FIELDS,
  PROPOSAL_ROLLBACK_BODY_FIELDS,
  applyViaChannel,
  buildProposals,
  decideViaChannel,
  rollbackViaChannel,
} from './proposal-channel.js'
export type { ProposalReply, ProposalSource } from './proposal-channel.js'
// ---------------------------------------------------------------------------
// The batch job queue (ADR-0023, X-26/X-30). The engine and the state machine live
// in `jobs.ts`, the panel projection in `jobs-wire.ts`, the tool surface in `jobs-tools.ts`.
// Re-exported here so `routes.ts` keeps ONE entry point for the channel — the same arrangement
// as the bin, the audit, the import, the queue, the gate, the
// review and the proposals.
// ---------------------------------------------------------------------------

export { BATCH_RESUME_BODY_FIELDS, buildBatchPage, resumeViaChannel } from './jobs-wire.js'
export type { BatchChapterRow, BatchCounts, BatchDetail, BatchPage } from './jobs-wire.js'
// ---------------------------------------------------------------------------
// The series sync (ADR-0007 C2/C5, X-17). The engine is `series.ts` (plan and apply
// on ONE computation, a decision per conflict, the run record under `.inkflow/audit/`), the two
// hub replies in `series-channel.ts`, the tool surface in `series-tools.ts`. Re-exported here so
// `routes.ts` keeps ONE entry point for the channel — the same arrangement as the gate,
// the review, the proposals and the batch queue.
// ---------------------------------------------------------------------------

export { SERIES_APPLY_BODY_FIELDS, seriesApplyReply, seriesPlanReply } from './series-channel.js'

// The timeline pane: the wire shape is `domains/timeline-view.ts`, the pipeline `domains/timeline-write.ts`.
export { TIMELINE_QUERY, TIMELINE_ROUTES, TIMELINE_UPSERT_BODY_FIELDS, timelineListReply, timelineUpsertReply } from './timeline-channel.js'
export type { TimelineChannelReply, TimelineChannelSource } from './timeline-channel.js'

// The route table imports this module and only this module (ADR-0008): the builders
// live in `internal-projections.ts`, the write routes in `internal-writes.ts`, the
// shared vocabulary in `internal-types.ts`. Nothing is copied, so the names the table
// already imports from here keep resolving.
export { buildChapter, buildChapters, buildSearch, buildStatus } from './internal-projections.js'
export type { ChannelSearchInput } from './internal-projections.js'
export { CHAPTER_CREATE_BODY_FIELDS, CHAPTER_MOVE_BODY_FIELDS, CHAPTER_SAVE_BODY_FIELDS, createChapterViaChannel, deleteChapterViaChannel, moveChapterViaChannel, writeChapterViaChannel } from './internal-writes.js'
export type { WriteReply, WriteRequest } from './internal-writes.js'
export type { ChannelResolution, ChannelTarget, JsonRecord, SessionRoot, SessionRootSource } from './internal-types.js'
