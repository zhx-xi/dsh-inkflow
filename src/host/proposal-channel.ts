/**
 * The proposal tab's half of the private channel (#45, roadmap X-12/X-25).
 *
 * Four routes and nothing else: one read (`GET /proposal`) and three writes
 * (`POST /proposal/{decide,apply,rollback}`). The domain lives in `proposal.ts`; this
 * module only turns its results into the wire shape and an HTTP status vocabulary, the
 * same arrangement `audit-channel.ts` (#33) and `extract-channel.ts` (#38) use.
 *
 * Three request rules, stated once here so the route table stays declarative:
 *
 *   * **the read route writes nothing.** It does not call `ensureIndex`: a proposal is
 *     plain JSON under `.inkflow/proposals/`, so the tab has to open on a book whose
 *     index is missing — which is exactly when a proposal is worth reading.
 *   * **`apply` and `rollback` need `confirm: true`** — both rewrite a chapter file, so
 *     absent/false is `CONFIRM_REQUIRED` with zero writes.
 *   * **a hunk travels with its own text.** The panel must not fetch the chapter to
 *     render a diff: the hunk carries `baseLines`/`nextLines`, so what the author
 *     accepts is byte-for-byte what the Host will write.
 *
 * `decide` reports `contentFilesWritten: 0` in the same spirit as the candidate queue's
 * reject: "deciding is not writing" has to be checkable from the answer, not asserted in
 * a doc.
 */

import { ensureIndex } from './index-freshness.js'
import { countsOf, listProposals, readProposal } from './proposal.js'
// The three writers live in proposal-actions.ts (shape vs action, AGENTS.md §10.5): the
// channel calls them, it does not own them.
import { decideProposal } from './proposal-actions.js'
import { applyProposal, rollbackProposal } from './proposal-apply.js'
import type { HunkDecision } from './proposal-actions.js'
import type { ProposalError, ProposalMeta, ProposalRead } from './proposal.js'

type JsonRecord = Record<string, unknown>

/** What the proposal routes need from the resolved channel target. */
export interface ProposalSource {
  sessionId: string
  root: string
}

export interface ProposalReply {
  status: number
  body: JsonRecord
}

/** Body fields per write route; anything else is `UNEXPECTED_BODY_FIELD` (400). */
export const PROPOSAL_DECIDE_BODY_FIELDS = ['proposalId', 'decisions'] as const
export const PROPOSAL_APPLY_BODY_FIELDS = ['proposalId', 'confirm'] as const
export const PROPOSAL_ROLLBACK_BODY_FIELDS = ['proposalId', 'confirm'] as const

/** How many proposals the list route returns in one page. */
export const PROPOSAL_LIST_LIMIT = 50

/** How many hunk lines one detail reply carries before it says `truncated`. */
export const PROPOSAL_HUNK_LINE_LIMIT = 4000

/** HTTP status per refusal; anything unlisted answers 409 and keeps the domain code. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  CONFIRM_REQUIRED: 400,
  PROPOSAL_ID_INVALID: 400,
  PROPOSAL_DECISIONS_REQUIRED: 400,
  PROPOSAL_HUNK_STATUS_INVALID: 400,
  PROPOSAL_NOT_FOUND: 404,
  PROPOSAL_HUNK_NOT_FOUND: 404,
  CHAPTER_NOT_FOUND: 404,
  FILE_INVALID: 400,
  FILE_CHANGED: 409,
  PROPOSAL_STATUS: 409,
  PROPOSAL_PENDING_HUNKS: 409,
  PROPOSAL_NOTHING_ACCEPTED: 409,
  PROPOSAL_UNDECIDED: 409,
  PROJECT_BUSY: 409,
}

function refused(status: number, code: string, extra: JsonRecord = {}): ProposalReply {
  return { status, body: { ok: false, error: { code, ...extra } } }
}

/** The refusal for one domain error, with the code→status table applied. */
function refusalOf(error: ProposalError): ProposalReply {
  const status = STATUS_BY_CODE[error.code] ?? 409
  return refused(status, error.code, { ...error })
}

/** `meta.json` without the diff text: one row of the list. */
function metaWire(meta: ProposalMeta): JsonRecord {
  return {
    proposalId: meta.proposalId,
    chapterId: meta.chapterId,
    path: meta.path,
    title: meta.title,
    createdAt: meta.createdAt,
    status: meta.status,
    source: { ...meta.source },
    counts: { ...meta.counts },
    base: { ...meta.base },
    revised: { ...meta.revised },
    decidedAt: meta.decision?.at ?? null,
    appliedAt: meta.apply?.at ?? null,
    rolledBackAt: meta.rollback?.at ?? null,
    backup: meta.apply?.backup ?? null,
  }
}

/**
 * One proposal with its hunks.
 *
 * The line budget is on the *lines of diff text*, not on the hunk count: a chapter
 * rewritten wholesale is three hunks and 3,000 lines, and a cap that counted hunks
 * would either truncate nothing or everything.
 */
function detailWire(read: ProposalRead): { value: JsonRecord; truncated: boolean } {
  let budget = PROPOSAL_HUNK_LINE_LIMIT
  let truncated = false
  const hunks = read.hunks.map((hunk) => {
    const baseLines = hunk.baseLines.slice(0, Math.max(0, budget))
    budget -= baseLines.length
    const nextLines = hunk.nextLines.slice(0, Math.max(0, budget))
    budget -= nextLines.length
    if (baseLines.length < hunk.baseLines.length || nextLines.length < hunk.nextLines.length) truncated = true
    return {
      index: hunk.index,
      kind: hunk.kind,
      status: hunk.status,
      baseStart: hunk.baseStart,
      baseLines,
      nextLines,
      removed: hunk.baseLines.length,
      added: hunk.nextLines.length,
    }
  })
  return {
    value: {
      ...metaWire(read.meta),
      hunks,
      counts: countsOf(read.hunks),
      decisionBaseline: read.meta.decision?.baseline ?? null,
      apply: read.meta.apply === null ? null : { ...read.meta.apply },
      rollback: read.meta.rollback === null ? null : { ...read.meta.rollback },
    },
    truncated,
  }
}

/**
 * `GET /proposal`: the open proposals of this book, newest first, plus one detail when
 * `proposalId` is given.
 *
 * Read-only by construction: `listProposals` / `readProposal` only read, and this
 * function calls no `ensureIndex`.
 */
export function buildProposals(
  source: ProposalSource,
  version: string,
  options: { proposalId?: string; limit?: number } = {},
): ProposalReply {
  const limit = typeof options.limit === 'number' && options.limit > 0 ? Math.min(options.limit, 200) : PROPOSAL_LIST_LIMIT
  const metas = listProposals(source.root)
  const rows = metas.slice(0, limit).map(metaWire)
  const wanted = (options.proposalId ?? '').trim()
  if (wanted === '') {
    return {
      status: 200,
      body: {
        ok: true,
        value: {
          pluginVersion: version,
          sessionId: source.sessionId,
          root: source.root,
          proposals: rows,
          total: metas.length,
          returned: rows.length,
          truncated: metas.length > rows.length,
          counts: {
            open: metas.filter((meta) => meta.status === 'open').length,
            applied: metas.filter((meta) => meta.status === 'applied').length,
            rolledBack: metas.filter((meta) => meta.status === 'rolled-back').length,
          },
          detail: null,
        },
      },
    }
  }
  const read = readProposal(source.root, wanted)
  if (!read.ok) return refusalOf(read.error)
  const detail = detailWire(read.value)
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: source.root,
        proposals: rows,
        total: metas.length,
        returned: rows.length,
        truncated: metas.length > rows.length,
        counts: {
          open: metas.filter((meta) => meta.status === 'open').length,
          applied: metas.filter((meta) => meta.status === 'applied').length,
          rolledBack: metas.filter((meta) => meta.status === 'rolled-back').length,
        },
        detail: detail.value,
        detailTruncated: detail.truncated,
      },
    },
  }
}

/** `POST /proposal/decide`: one verdict per hunk. Writes the decision record, no chapter. */
export function decideViaChannel(source: ProposalSource, version: string, body: JsonRecord): ProposalReply {
  const proposalId = typeof body['proposalId'] === 'string' ? body['proposalId'] : ''
  const raw = body['decisions']
  if (!Array.isArray(raw)) {
    return refused(400, 'PROPOSAL_DECISIONS_REQUIRED', {
      message: 'decisions must be a list of { index, status }',
      hint: 'status is accepted, rejected or pending',
    })
  }
  // The statuses are carried as raw strings on purpose: `decideProposal` is the one place
  // that judges them, so the same validation covers the tool, the route and a hand edit.
  const decisions: HunkDecision[] = raw.map((item) => {
    const record = typeof item === 'object' && item !== null ? (item as JsonRecord) : {}
    return {
      index: typeof record['index'] === 'number' ? record['index'] : Number.NaN,
      status: typeof record['status'] === 'string' ? record['status'] : '',
    }
  })
  const decided = decideProposal(source.root, { proposalId, decisions })
  if (!decided.ok) return refusalOf(decided.error)
  const value = decided.value
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: value.root,
        proposalId: value.proposalId,
        counts: value.counts,
        decision: value.decision,
        pending: value.pending,
        contentFilesWritten: 0,
      },
    },
  }
}

/** `POST /proposal/apply`: write the accepted hunks through the chapter writer. */
export async function applyViaChannel(source: ProposalSource, version: string, body: JsonRecord): Promise<ProposalReply> {
  const proposalId = typeof body['proposalId'] === 'string' ? body['proposalId'] : ''
  const applied = await applyProposal(source.root, {
    proposalId,
    ...(typeof body['confirm'] === 'boolean' ? { confirm: body['confirm'] } : {}),
  })
  if (!applied.ok) return refusalOf(applied.error)
  const value = applied.value
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: value.root,
        proposalId: value.proposalId,
        chapterId: value.chapterId,
        path: value.path,
        backup: value.backup,
        before: value.before,
        after: value.after,
        applied: value.applied,
        skipped: value.skipped,
        bytes: value.bytes,
        catalogRebuilt: value.catalogRebuilt,
        indexRebuilt: value.indexRebuilt,
      },
    },
  }
}

/** `POST /proposal/rollback`: replay the backup package, then refresh the index. */
export async function rollbackViaChannel(source: ProposalSource, version: string, body: JsonRecord): Promise<ProposalReply> {
  const proposalId = typeof body['proposalId'] === 'string' ? body['proposalId'] : ''
  const undone = rollbackProposal(source.root, {
    proposalId,
    ...(typeof body['confirm'] === 'boolean' ? { confirm: body['confirm'] } : {}),
  })
  if (!undone.ok) return refusalOf(undone.error)
  const value = undone.value
  // The chapter bytes are back, so the derived index describes the pre-apply tree again;
  // it is a cache, refreshed here the same way every other write path does it.
  const ensured = await ensureIndex(source.root)
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: value.root,
        proposalId: value.proposalId,
        backup: value.backup,
        restored: value.restored,
        verified: value.verified,
        before: value.before,
        bytes: value.bytes,
        indexRebuilt: ensured.ok ? ensured.rebuilt : false,
      },
    },
  }
}
