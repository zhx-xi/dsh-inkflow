/**
 * The session channel's route table (`/inkflow/internal/*`).
 *
 * WHY IT IS A FILE: it is ~500 lines of pure data, and it grew fastest of everything in
 * `routes.ts` — every new projection added a block. Moving the data out leaves the
 * dispatcher, the guards and the write-path adapters where a reader expects them, and the
 * table where a reader looks for "which routes exist".
 *
 * Nothing here dispatches: each entry declares its own methods, its body whitelist and its
 * handler, and `routes.ts` walks the array. Adding a route is a block in this file, in the
 * position that matches the channel it belongs to.
 */

import { AUDIT_EXPORT_BODY_FIELDS, BATCH_RESUME_BODY_FIELDS, BRIEF_AUDIT_BODY_FIELDS, CANDIDATES_ACCEPT_BODY_FIELDS, CANDIDATES_PURGE_BODY_FIELDS, CANDIDATES_REJECT_BODY_FIELDS, CHAPTER_CREATE_BODY_FIELDS, CHAPTER_MOVE_BODY_FIELDS, CHAPTER_SAVE_BODY_FIELDS, FORESHADOW_ROUTES, IMPORT_BODY_FIELDS, LIBRARY_WRITE_BODY_FIELDS, PROPOSAL_APPLY_BODY_FIELDS, PROPOSAL_DECIDE_BODY_FIELDS, PROPOSAL_ROLLBACK_BODY_FIELDS, RENAME_BODY_FIELDS, TIMELINE_ROUTES, TRASH_PURGE_BODY_FIELDS, TRASH_RESTORE_BODY_FIELDS, acceptViaChannel, applyViaChannel as applyProposalViaChannel, briefOptionsFromQuery, buildAudit, buildBatchPage, buildBrief, buildCandidates, buildChapters, buildForeshadowBoard, buildGate, buildImpact, buildLibrary, buildLibraryIssues, buildLibraryItem, buildProposals, buildReviewCompare, buildReviewList, buildSearch, buildStatus, createChapterViaChannel, decideViaChannel as decideProposalViaChannel, deleteChapterViaChannel, exportAudit, exportBriefAudit, importViaChannel, moveChapterViaChannel, purgeTrashReply, purgeViaChannel, rejectViaChannel, renameEntity, restoreTrashReply, resumeViaChannel as resumeBatchViaChannel, rollbackViaChannel as rollbackProposalViaChannel, trashListReply, writeChapterViaChannel, writeLibraryItem } from './internal.js'
import { PRIVATE_PURGE_ROUTES } from './private-purge-routes.js'
import type { InternalRoute } from './route-types.js'
import { addressedByOf, failure, ok, readChapterReply, toReply, withAddressedBy, writeRequestOf } from './routes-http.js'
import { REPLACE_APPLY_BODY_FIELDS, replaceApplyReply, replacePreviewReply, searchAllFromQuery } from './search-channel.js'
import { MAX_QUERY_CHARS } from './search.js'

export const ROUTES: readonly InternalRoute[] = [
  {
    name: 'status',
    pattern: /^\/status$/,
    methods: ['GET'],
    query: [],
    handle: ({ target, version }) => ({ status: 200, body: ok(buildStatus(target, version)) }),
  },
  {
    name: 'chapters',
    pattern: /^\/chapters$/,
    methods: ['GET', 'POST'],
    query: [],
    body: CHAPTER_CREATE_BODY_FIELDS,
    handle: async (input) =>
      input.method === 'POST'
        ? toReply(await createChapterViaChannel(writeRequestOf(input)))
        : { status: 200, body: ok(await buildChapters(input.target, input.version)) },
  },
  {
    name: 'chapter',
    pattern: /^\/chapters\/([^/]+)$/,
    methods: ['GET', 'POST', 'DELETE'],
    query: [],
    // `eol`/`bom` are the file's own format, read from `GET /chapters/:id` and handed back on
    // save (ADR-0016): without them the write door can only normalise, which rewrites a CRLF
    // chapter to LF. Both are validated by `internal.ts` — the whitelist is about *which* fields
    // may travel, not what values they carry.
    body: CHAPTER_SAVE_BODY_FIELDS,
    handle: async (input) => {
      if (input.method === 'POST') return toReply(await writeChapterViaChannel(writeRequestOf(input)))
      if (input.method === 'DELETE') return toReply(await deleteChapterViaChannel(writeRequestOf(input)))
      return readChapterReply(input)
    },
  },
  {
    // Must be declared with the same `/chapters/…` prefix but a longer pattern:
    // `[^/]+` in the row above cannot swallow the `/move` segment.
    name: 'chapter-move',
    pattern: /^\/chapters\/([^/]+)\/move$/,
    methods: ['POST'],
    query: [],
    body: CHAPTER_MOVE_BODY_FIELDS,
    handle: async (input) => toReply(await moveChapterViaChannel(writeRequestOf(input))),
  },
  {
    // The single search entry (roadmap X-16): body prose plus every setting kind, one page at a time;
    // `kinds` narrows it, an unusable index is a 200 with `degradedReason` (never a 5xx).
    name: 'search',
    pattern: /^\/search$/,
    methods: ['GET'],
    query: ['q', 'kinds', 'offset', 'limit'],
    handle: async ({ target, query, version, dataDir }) => {
      const q = (query.get('q') ?? '').trim()
      if (q === '') {
        return { status: 400, body: failure('QUERY_REQUIRED', { param: 'q', hint: 'pass ?q=<text> to search the book' }) }
      }
      if (q.length > MAX_QUERY_CHARS) {
        return {
          status: 400,
          body: failure('QUERY_INVALID', { message: `query is ${q.length} characters long; the limit is ${MAX_QUERY_CHARS}` }),
        }
      }
      return { status: 200, body: ok(await buildSearch(target, version, searchAllFromQuery(query), dataDir)) }
    },
  },
  {
    // The replace preview (X-17): what a batch would change, with the exact `expected` set an apply
    // must send back. Read-only — it does not even refresh the index.
    name: 'replace-preview',
    pattern: /^\/replace$/,
    methods: ['GET'],
    query: ['q', 'with'],
    handle: ({ target, query, version }) => {
      const q = query.get('q') ?? ''
      if (q.trim() === '') {
        return { status: 400, body: failure('QUERY_REQUIRED', { param: 'q', hint: 'pass ?q=<text>&with=<replacement>' }) }
      }
      return replacePreviewReply(target, version, { query: q, replacement: query.get('with') ?? '' })
    },
  },
  {
    // The batch itself: a write, so it carries every write guard declared above plus
    // `confirm: true` and the preview's `expected` set (X-17).
    name: 'replace-apply',
    pattern: /^\/replace\/apply$/,
    methods: ['POST'],
    query: [],
    body: REPLACE_APPLY_BODY_FIELDS,
    handle: ({ target, version, body }) => replaceApplyReply(target, version, body),
  },
  {
    // The setting library (X-7): eight kind groups, `world` carrying
    // its `category` buckets. Read-only; the index is refreshed through the same
    // `ensureIndex` the chapter tree uses (conventions §4.0's single trigger).
    name: 'library',
    pattern: /^\/library$/,
    methods: ['GET'],
    query: [],
    handle: async ({ target, version }) => ({ status: 200, body: ok(await buildLibrary(target, version)) }),
  },
  {
    // One entry: `kind` and `id` are the tree's own addresses, never a path, so
    // the path-parameter ban above still means what it says. 400 for an unknown
    // kind or a missing id, 404 for an id the projection does not hold.
    //
    // POST is the editor's save (second batch): it carries the same
    // `kind`/`id` address plus `frontmatter`/`body`/`expected`, so a write still
    // names an entity and never a directory. The body allowlist below is the
    // write guard — `path`/`root`/… are a 400 before any filesystem access.
    name: 'library-item',
    pattern: /^\/library\/item$/,
    methods: ['GET', 'POST'],
    query: ['kind', 'id'],
    body: LIBRARY_WRITE_BODY_FIELDS,
    handle: async (input) => {
      if (input.method === 'POST') {
        return toReply(
          await writeLibraryItem({ source: input.target, version: input.version, body: input.body }),
        )
      }
      return buildLibraryItem(input.target, input.version, input.query.get('kind') ?? '', input.query.get('id') ?? '')
    },
  },
  {
    // `validation_issues` for the problem panel: grouped client-side by `code`,
    // because grouping is presentation and the wire stays a flat list.
    name: 'library-issues',
    pattern: /^\/library\/issues$/,
    methods: ['GET'],
    query: [],
    handle: async ({ target, version }) => ({ status: 200, body: ok(await buildLibraryIssues(target, version)) }),
  },
  {
    // The impact listing (conventions §5.6): what a setting change would touch
    // across the manuscript, the graph and the three file-only reference sites.
    //
    // GET-only and **read-only**: unlike `/chapters` and `/search` it does NOT call
    // `ensureIndex`, because the author is looking at a report to decide whether to
    // write — rebuilding the cache under them would be a write during a question.
    // A cache that is missing or stale is reported (`indexAvailable` / `indexState`)
    // instead of being silently replaced.
    //
    // `slug` / `newTitle` preview the rename plan; the dialog shows it, and simply
    // closing the dialog is therefore zero writes by construction.
    name: 'impact',
    pattern: /^\/impact$/,
    methods: ['GET'],
    query: ['kind', 'id', 'title', 'slug', 'newTitle'],
    handle: async ({ target, query, version }) =>
      buildImpact(target, version, {
        kind: query.get('kind') ?? '',
        ...(query.get('id') === null ? {} : { id: query.get('id') ?? '' }),
        ...(query.get('title') === null ? {} : { title: query.get('title') ?? '' }),
        ...(query.get('slug') === null ? {} : { slug: query.get('slug') ?? '' }),
        ...(query.get('newTitle') === null ? {} : { newTitle: query.get('newTitle') ?? '' }),
      }),
  },
  {
    // The rename itself (ADR-0014): move the file, pin the OLD id, rewrite no
    // reference. A write route, so it carries every write guard declared above plus
    // the mandatory CAS baseline (`expected`, §5.5).
    name: 'impact-rename',
    pattern: /^\/impact\/rename$/,
    methods: ['POST'],
    query: [],
    body: RENAME_BODY_FIELDS,
    handle: async ({ target, version, body }) => renameEntity({ source: target, version, body }),
  },
  {
    // The recovery bin (roadmap X-9/X-10): what a delete moved to
    // `.inkflow/trash/`, newest first. Read-only and read-only by design — the
    // bin never prunes itself (ADR-0012 decision 4), so this route only looks.
    name: 'trash',
    pattern: /^\/trash$/,
    methods: ['GET'],
    query: [],
    handle: ({ target, version }) => trashListReply(target, version),
  },
  {
    // One entry back to its original path: `id` only, never a path. The bin
    // refuses an occupied target instead of overwriting (RESTORE_TARGET_EXISTS).
    name: 'trash-restore',
    pattern: /^\/trash\/restore$/,
    methods: ['POST'],
    query: [],
    body: TRASH_RESTORE_BODY_FIELDS,
    handle: ({ target, version, body }) => restoreTrashReply(target, version, body),
  },
  // The purge area's three routes: `GET /purged`, `POST /purged/clean`,
  // `POST /purged/restore`. Their descriptors live in `private-purge-routes.ts` — this file is
  // exactly on its line budget, and they are dispatched through the same guards as every entry
  // above (the table is one list; where a row was written changes nothing).
  ...PRIVATE_PURGE_ROUTES,
  {
    // Forever: copy plus entry. `confirm: true` is required in the body — the
    // panel asks twice, and this is the net under that (ADR-0012 decision 4).
    name: 'trash-purge',
    pattern: /^\/trash\/purge$/,
    methods: ['POST'],
    query: [],
    body: TRASH_PURGE_BODY_FIELDS,
    handle: ({ target, version, body }) => purgeTrashReply(target, version, body),
  },
  // The timeline pane: two axes + pending + findings + calendar, one confirmed upsert (`timeline-channel.ts`).
  ...TIMELINE_ROUTES,
  {
    // The foreshadow board (data-model §3.2): read-only, three groupings
    // of the same entries (open / late / by linked entity). Lateness is computed by
    // the Host against the latest chapter — the panel never re-derives it, so there
    // is exactly one definition of "超期" in the product.
    name: 'foreshadow',
    pattern: /^\/foreshadow$/,
    methods: ['GET'],
    query: [],
    handle: async ({ target, version }) => ({ status: 200, body: ok(await buildForeshadowBoard(target, version)) }),
  },
  // The board's one write: a legal state move on an existing entry, same pipeline and codes as the tool.
  ...FORESHADOW_ROUTES,
  {
    // The quality gate (ADR-0022 D4): seven checks over ONE chapter — 字数 / 章末钩子 /
    // 六维去 AI 味 / 一致性 / 敏感自查 / 平台规则 / 机械校对 — with the counts of all seven
    // and one row per finding.
    //
    // GET-only and **read-only**: it calls `buildGate`, which runs the gate with
    // `record: false`. A page refresh must not write the verdict file — otherwise "the
    // conclusion on disk" would depend on who happened to open a tab, and the whole point of
    // the file (two runs, same bytes) would be gone. The file is produced by
    // `inkflow_gate_check`; this route only reads the same computation.
    name: 'gate',
    pattern: /^\/gate$/,
    methods: ['GET'],
    query: ['chapterId'],
    handle: ({ target, query, version }) => {
      const chapterId = query.get('chapterId') ?? ''
      return withAddressedBy(
        buildGate(target, version, chapterId.trim() === '' ? {} : { chapterId }),
        addressedByOf(query, ['chapterId']),
      )
    },
  },
  {
    // The consistency audit (roadmap X-14): five families — structure / ledger /
    // foreshadow / timeline / catalog — as one sorted `Finding[]`, with the first `limit`
    // of them and the counts of all.
    //
    // GET-only and **read-only**: unlike `/chapters`, `/search` and `/foreshadow` it does
    // NOT call `ensureIndex`, because the audit answers from the files (`audit.ts`'s header
    // says why) and a report about integrity must not change the tree it reports on. The
    // cache's state travels as `indexState` instead, so the panel can suggest a rebuild
    // without doing one behind the author's back.
    name: 'audit',
    pattern: /^\/audit$/,
    methods: ['GET'],
    query: ['limit'],
    handle: ({ target, query, version }) => {
      const raw = Number(query.get('limit') ?? '')
      return buildAudit(target, version, Number.isFinite(raw) && raw > 0 ? { limit: raw } : {})
    },
  },
  {
    // The report file: `.inkflow/audit/audit-<时间戳>.md`, derived and deletable
    // (ADR-0012 decision 6). A write route, so it carries every write guard declared above plus
    // `confirm: true` — the panel asks once with an explicit label, this is the net under
    // it. The audit is re-run here rather than trusting a client-supplied body: the report
    // must describe the files now.
    name: 'audit-export',
    pattern: /^\/audit\/export$/,
    methods: ['POST'],
    query: [],
    body: AUDIT_EXPORT_BODY_FIELDS,
    handle: ({ target, version, body }) => exportAudit(target, version, body),
  },
  {
    // Importing an old manuscript (X-17): `action: 'plan'` previews, `action:
    // 'apply'` writes with `confirm: true`. ONE POST for both actions, because the
    // preview has to name the file the author picked (`sourcePath`) — and a field that may
    // point outside the book has to ride the write route's guards (Origin present and
    // loopback) rather than relax them. `path`/`root`/`cwd`/… stay forbidden: a browser
    // still never names a directory, only the manuscript. `import-channel.ts` holds the
    // whole argument and the status vocabulary.
    name: 'library-import',
    pattern: /^\/library\/import$/,
    methods: ['POST'],
    query: [],
    body: IMPORT_BODY_FIELDS,
    handle: async ({ target, version, body }) => importViaChannel({ source: target, version, body }),
  },
  {
    // The extraction queue (X-20, ADR-0017): what the session model proposed and what
    // the author has not judged yet. Read-only and it does NOT call `ensureIndex` — the
    // queue is plain JSON under `.inkflow/candidates/`, so the tab must open on a book
    // whose index is missing (which is exactly when a candidate is worth accepting).
    name: 'candidates',
    pattern: /^\/candidates$/,
    methods: ['GET'],
    query: ['kind', 'status', 'offset', 'limit'],
    handle: ({ target, version, query }) =>
      buildCandidates(target, version, {
        ...(query.get('kind') === null ? {} : { kind: query.get('kind') ?? '' }),
        ...(query.get('status') === null ? {} : { status: query.get('status') ?? '' }),
        ...(query.get('offset') === null ? {} : { offset: query.get('offset') ?? '' }),
        ...(query.get('limit') === null ? {} : { limit: query.get('limit') ?? '' }),
      }),
  },
  {
    // Accepting writes entity files, so it carries every write guard plus `confirm: true`
    // (D5). Candidates are named by id, never by path: the browser still names no
    // directory (ADR-0008 D4).
    name: 'candidates-accept',
    pattern: /^\/candidates\/accept$/,
    methods: ['POST'],
    query: [],
    body: CANDIDATES_ACCEPT_BODY_FIELDS,
    handle: async ({ target, version, body }) => acceptViaChannel(target, version, body),
  },
  {
    // Rejecting writes no content file at all — the answer says so
    // (`contentFilesWritten: 0`), which is what makes "拒绝等于零写入" checkable from the panel.
    name: 'candidates-reject',
    pattern: /^\/candidates\/reject$/,
    methods: ['POST'],
    query: [],
    body: CANDIDATES_REJECT_BODY_FIELDS,
    handle: ({ target, version, body }) => rejectViaChannel(target, version, body),
  },
  {
    // Purging deletes queue entries, so it needs `confirm: true` too; a `proposed`
    // candidate is refused by the store (`CANDIDATE_NOT_PROCESSED`).
    name: 'candidates-purge',
    pattern: /^\/candidates\/purge$/,
    methods: ['POST'],
    query: [],
    body: CANDIDATES_PURGE_BODY_FIELDS,
    handle: ({ target, version, body }) => purgeViaChannel(target, version, body),
  },
  {
    // The nine-segment brief (ADR-0022 D1/D2, X-23): every segment as
    // `{id,label,bytes,tokens,truncated,missing}` in the fixed order `outline → … → anchors`, plus
    // the trim records and the totals. GET-only: it may refresh the index, never write — and the
    // one assembly both routes read is argued in `brief.ts`.
    name: 'brief',
    pattern: /^\/brief$/,
    methods: ['GET'],
    query: ['chapterId', 'chapterSeq', 'budgetTokens', 'tailChars'],
    handle: async ({ target, query, version }) => {
      const reply = await buildBrief(
        { sessionId: target.sessionId, root: target.root },
        version,
        briefOptionsFromQuery(query),
        query.get('chapterId') ?? '',
      )
      // `chapterId` wins over `chapterSeq` here as well as in the assembly: one answer.
      return withAddressedBy({ status: reply.status, body: reply.body }, addressedByOf(query, ['chapterId', 'chapterSeq']))
    },
  },
  {
    // The injection audit (ADR-0022 D4): `.inkflow/audit/brief-<chapterId>.json`, same input
    // → same bytes. It takes the SAME addressing and budget keys as `GET /brief`, so the record
    // is the brief the panel shows — the rest of the why is in `brief.ts`, beside the lookup.
    name: 'brief-audit',
    pattern: /^\/brief\/audit$/,
    methods: ['POST'],
    query: ['chapterId', 'chapterSeq', 'budgetTokens', 'tailChars'],
    body: BRIEF_AUDIT_BODY_FIELDS,
    handle: async ({ target, query, version, body }) => {
      const reply = await exportBriefAudit(
        { sessionId: target.sessionId, root: target.root },
        version,
        briefOptionsFromQuery(query),
        body,
        query.get('chapterId') ?? '',
      )
      return withAddressedBy(reply, addressedByOf(query, ['chapterId', 'chapterSeq']))
    },
  },
  {
    // The review runs of one chapter (X-24/X-26): every recorded pass as a row
    // (`runId`, model, time, opinion count, how many located, failed/skipped nodes), plus the
    // selected run expanded — its five dimensions with anchors, and every opinion with its
    // locator and evidence excerpt. `runId` only chooses which record is expanded; the list
    // and the detail are one read over `.inkflow/review/<chapterId>/`.
    //
    // GET-only and **read-only**: the runs are written by `inkflow_review_run`, never by a
    // page refresh — the record carries a timestamp, so a GET that wrote would create a run
    // nobody asked for.
    //
    // `limit` is how the panel opens the fold: the first screen keeps the declared
    // page (`REVIEW_LIST_LIMIT`), and "更早的 N 次运行" asks again with a bigger page. The
    // fold boundary itself travels back as `foldLimit`, so the panel never keeps a second
    // copy of the number.
    name: 'review',
    pattern: /^\/review$/,
    methods: ['GET'],
    query: ['chapterId', 'runId', 'limit'],
    handle: ({ target, query, version }) => {
      const chapterId = (query.get('chapterId') ?? '').trim()
      const runId = (query.get('runId') ?? '').trim()
      const pageSize = Number(query.get('limit') ?? '')
      return withAddressedBy(
        buildReviewList({ sessionId: target.sessionId, root: target.root }, version, {
          ...(chapterId === '' ? {} : { chapterId }),
          ...(runId === '' ? {} : { runId }),
          ...(Number.isFinite(pageSize) && pageSize > 0 ? { limit: pageSize } : {}),
        }),
        addressedByOf(query, ['chapterId']),
      )
    },
  },
  {
    // The cross-model table: the same computation as `inkflow_review_compare`, over the
    // same recorded runs, with the Markdown export in the payload so the panel never renders
    // a second table of its own.
    name: 'review-compare',
    pattern: /^\/review\/compare$/,
    methods: ['GET'],
    query: ['chapterId'],
    handle: ({ target, query, version }) => {
      const chapterId = (query.get('chapterId') ?? '').trim()
      return withAddressedBy(
        buildReviewCompare({ sessionId: target.sessionId, root: target.root }, version, {
          ...(chapterId === '' ? {} : { chapterId }),
        }),
        addressedByOf(query, ['chapterId']),
      )
    },
  },
  {
    // The proposal inbox (ADR-0023, X-25): what a session model has proposed as a
    // revision of one chapter, newest first, plus one proposal's hunks when `proposalId`
    // is given.
    //
    // GET-only and **read-only**: a proposal is plain JSON under `.inkflow/proposals/`,
    // so unlike `/chapters` and `/foreshadow` this route does not call `ensureIndex` — the
    // tab has to open on a book whose index is missing, which is exactly when a proposal
    // is worth reading. Each hunk travels with its own `baseLines`/`nextLines`, so the
    // page never has to fetch the chapter to draw a diff.
    name: 'proposal',
    pattern: /^\/proposal$/,
    methods: ['GET'],
    query: ['proposalId', 'limit'],
    handle: ({ target, query, version }) => {
      const proposalId = (query.get('proposalId') ?? '').trim()
      const raw = Number(query.get('limit') ?? '')
      return buildProposals(target, version, {
        ...(proposalId === '' ? {} : { proposalId }),
        ...(Number.isFinite(raw) && raw > 0 ? { limit: raw } : {}),
      })
    },
  },
  {
    // Recording a verdict writes only the proposal's own hunk records (`contentFilesWritten: 0`
    // in the answer), so it is a write route for the guards' sake, not because prose moves.
    name: 'proposal-decide',
    pattern: /^\/proposal\/decide$/,
    methods: ['POST'],
    query: [],
    body: PROPOSAL_DECIDE_BODY_FIELDS,
    handle: ({ target, version, body }) => decideProposalViaChannel(target, version, body),
  },
  {
    // Applying rewrites a chapter, so it carries every write guard plus `confirm: true`.
    name: 'proposal-apply',
    pattern: /^\/proposal\/apply$/,
    methods: ['POST'],
    query: [],
    body: PROPOSAL_APPLY_BODY_FIELDS,
    handle: async ({ target, version, body }) => applyProposalViaChannel(target, version, body),
  },
  {
    // Rollback replays the backup package the apply opened; also `confirm: true`.
    name: 'proposal-rollback',
    pattern: /^\/proposal\/rollback$/,
    methods: ['POST'],
    query: [],
    body: PROPOSAL_ROLLBACK_BODY_FIELDS,
    handle: async ({ target, version, body }) => rollbackProposalViaChannel(target, version, body),
  },
  {
    // The batch job of this book (ADR-0023, X-30): the job list plus one job's chapters,
    // each with its status, its gate counts and whether a draft is waiting for approval.
    //
    // GET-only and **read-only**, and deliberately no `ensureIndex`: a job is plain JSON under
    // `.inkflow/jobs/`, and the tab has to open on a book whose `index/` was just deleted —
    // that is exactly the moment the author wants to know whether the batch survived.
    name: 'batch',
    pattern: /^\/batch$/,
    methods: ['GET'],
    query: ['jobId'],
    handle: ({ target, query, version }) => {
      const jobId = (query.get('jobId') ?? '').trim()
      return buildBatchPage(target, version, { ...(jobId === '' ? {} : { jobId }) })
    },
  },
  {
    // 续跑: re-queue failed chapters and leave the done/failed state. Writes job records only —
    // no prose, no chapter file — so it is a write route for the guards' sake. A job paused at
    // the gate is refused with `APPROVAL_REQUIRED` (409): approving is `inkflow_batch_approve`,
    // and a button must not become a way around the gate.
    name: 'batch-resume',
    pattern: /^\/batch\/resume$/,
    methods: ['POST'],
    query: [],
    body: BATCH_RESUME_BODY_FIELDS,
    handle: ({ target, version, body }) => resumeBatchViaChannel(target, version, body),
  },
]
