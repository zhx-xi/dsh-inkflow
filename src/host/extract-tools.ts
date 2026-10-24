/**
 * The extraction tool surface (#38, ADR-0017): propose, list, accept, reject, purge.
 *
 * Five tools, one queue. Their shape follows from where the intelligence lives (D1):
 * the **model in the session** reads the manuscript and submits candidates; the plugin
 * stores them, shows them to the author, and is the only thing that can turn one into a
 * file — and only when the author says so (`confirm: true`, D5).
 *
 * Two decisions show up in the parameter schemas:
 *
 *   * `kind` is a parameter of `inkflow_extract_propose`, not of each proposal: a batch
 *     is one `<stamp>-<kind>.json` file (D3), so one submission covers one kind. Six
 *     kinds over ten chapters is six calls, and each file then reads as "what the model
 *     found about characters in these chapters".
 *   * `candidateId` on a proposal is an **echo**, never an invention: passing back an id
 *     read from `inkflow_extract_list` updates that candidate in place (same id, same
 *     count), which is how a re-read sentence refines a proposal instead of duplicating
 *     it. An id the queue does not know is refused rather than created.
 *
 * Answers are counts plus the changed candidates: the queue can be long, and
 * `inkflow_extract_list` is the tool that pages through it.
 */

import type { ContentBlock, JsonSchemaNode, ToolDefinition, ToolRunContext } from './context.js'
import { ensureIndex } from './index-freshness.js'
import { gateFailure, isRefused, resolveProject } from './domains/tool-project.js'
import { acceptCandidates } from './extract-accept.js'
import type { AcceptRefusal } from './extract-accept.js'
import {
  EXTRACT_KINDS,
  CANDIDATE_STATUSES,
  CONFIDENCES,
  candidateFieldNames,
  proposeCandidates,
  purgeCandidates,
  readCandidateStore,
  setCandidateStatuses,
} from './extract.js'
import type { CandidateProposal, CandidateRecord, ExtractError, ExtractKind } from './extract.js'
import type { ToolDeps } from './tools.js'

type Json = Record<string, unknown>

function text(lines: string[]): ContentBlock[] {
  return [{ type: 'text', text: lines.join('\n') }]
}

function asRecord(value: unknown): Json {
  return typeof value === 'object' && value !== null ? (value as Json) : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

const SUCCESS_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: true,
}

const PROJECT_ROOT_PARAM = {
  type: 'string',
  description:
    'Absolute path of the InkFlow project root. Omit to resolve from the session working directory (walks up to the nearest project). An explicit path must live inside the session working directory.',
} as const

const CONFIRM_PARAM = {
  type: 'boolean',
  description: 'Must be true. Nothing is written without it.',
} as const

function indexLine(value: Json): string {
  if (value['indexRebuilt'] === true) return 'index rebuilt'
  const error = asRecord(value['indexError'])
  if (Object.keys(error).length > 0) return `index NOT rebuilt (${String(error['code'] ?? 'unknown')}) — run inkflow_index_rebuild`
  return 'index already fresh'
}

/** One candidate as the tools report it (null, not `undefined`, so it survives JSON). */
function candidateView(record: CandidateRecord): Json {
  const proposal = record.proposal
  return {
    candidateId: proposal.candidateId,
    kind: proposal.kind,
    fields: proposal.fields,
    evidence: proposal.evidence,
    rationale: proposal.rationale,
    confidence: proposal.confidence,
    status: proposal.status,
    file: record.file,
    submittedAt: record.submittedAt,
  }
}

function failureLines(verb: string, code: string, message: string, extra: AcceptRefusal = { code, message }): ContentBlock[] {
  const lines = [`${verb} failed: ${code} — ${message}`]
  if (extra.path !== undefined) lines.push(`path: ${extra.path}`)
  return text(lines)
}

/** `{kind: 3, character: 2}` → `character 2 · foreshadowing 3`, in a stable order. */
function describeCounts(counts: Readonly<Record<string, number>>): string {
  const kinds = EXTRACT_KINDS.filter((kind) => (counts[kind] ?? 0) > 0)
  if (kinds.length === 0) return 'none'
  return kinds.map((kind) => `${kind} ${String(counts[kind] ?? 0)}`).join(' · ')
}

export function extractTools(deps: ToolDeps): ToolDefinition[] {
  const resolveRoot = async (args: Json, exec: ToolRunContext) => resolveProject(deps, args['projectRoot'], exec)

  const propose: ToolDefinition = {
    name: 'inkflow_extract_propose',
    description:
      'Submit one batch of extraction candidates for the author to review. The plugin never runs a model: you read the manuscript and propose, this stores what you found in `.inkflow/candidates/` and nothing becomes a real entity until the author accepts it. ' +
      'Every candidate needs `evidence` (a `path#L<line>` anchor or a chapter id that exists now) and `fields` using the field dictionary of its kind. Nothing is written when any candidate in the batch is refused. ' +
      'Pass a `candidateId` you read back from inkflow_extract_list to update that candidate in place.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        kind: {
          type: 'string',
          enum: [...EXTRACT_KINDS],
          description: 'The entity kind this whole batch is about; one batch file is one kind.',
        },
        chapters: {
          type: 'array',
          items: { type: 'string' },
          description: 'Chapter ids this batch was read from; shown to the reviewer for provenance.',
        },
        proposals: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              candidateId: {
                type: 'string',
                description: 'Echo of an id from inkflow_extract_list to update that candidate; omit to create a new one.',
              },
              fields: {
                type: 'object',
                additionalProperties: true,
                description:
                  'The entity fields, named exactly as in the data model (character: name/aliases/group/role/pov/firstAppearance/voice/states/body; world: title/category/parent/keywords/always/priority/body; outline: kind/title/parent/order/plotPoints/body; timeline: title/worldTime/narrativeOrder/chapterId/participants/status/body; foreshadowing: title/status/plantedAt/advancedAt/dueBy/resolvedChapter/linkedEntities/body; relation: source/target/kind/title/dir/since/until/chapter/body). An unknown key is refused.',
              },
              evidence: { type: 'string', description: '`path#L<line>` (a line anchor in the manuscript) or a chapter id.' },
              rationale: { type: 'string', description: 'One sentence: why this text implies this entity.' },
              confidence: { type: 'string', enum: [...CONFIDENCES], description: 'Ordering hint for the reviewer; it drives no automatic decision. Default medium.' },
            },
            required: ['fields', 'evidence'],
            additionalProperties: false,
          },
          description: 'The candidates of this batch. A submission with an empty list is refused.',
        },
      },
      required: ['kind', 'proposals'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          return failureLines('Extract propose', String(error['code'] ?? 'unknown'), String(error['message'] ?? ''), {
            code: String(error['code'] ?? 'unknown'),
            message: String(error['message'] ?? ''),
            ...(typeof error['path'] === 'string' ? { path: error['path'] } : {}),
          })
        }
        const created = Array.isArray(v['created']) ? (v['created'] as Json[]) : []
        const updated = Array.isArray(v['updated']) ? (v['updated'] as Json[]) : []
        const lines = [
          `Stored ${String(created.length)} new and ${String(updated.length)} updated candidate(s) in .inkflow/candidates/${String(v['file'] ?? '')}`,
        ]
        for (const item of [...created, ...updated]) {
          const fields = asRecord(item['fields'])
          const label = String(fields['name'] ?? fields['title'] ?? fields['source'] ?? '')
          lines.push(`- ${String(item['candidateId'])} (${String(item['kind'])}) ${label} — ${String(item['evidence'])}`)
        }
        lines.push('Nothing has been written into the content directories: candidates wait for inkflow_extract_accept.')
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveRoot(a, exec)
      if (isRefused(resolved)) return gateFailure(resolved)
      const root = resolved.probe?.root ?? resolved.root

      const kind = a['kind']
      if (typeof kind !== 'string' || !(EXTRACT_KINDS as readonly string[]).includes(kind)) {
        return {
          ok: false,
          root,
          error: { code: 'CANDIDATE_KIND_INVALID', message: `kind must be one of ${EXTRACT_KINDS.join(' / ')}` },
        }
      }
      const raw = a['proposals']
      if (!Array.isArray(raw) || raw.length === 0) {
        return {
          ok: false,
          root,
          error: { code: 'CANDIDATE_FIELD_REQUIRED', message: 'proposals must be a non-empty list', field: 'proposals' },
        }
      }
      const chapters = Array.isArray(a['chapters'])
        ? a['chapters'].filter((item): item is string => typeof item === 'string')
        : []
      const result = proposeCandidates(root, {
        kind: kind as ExtractKind,
        chapters,
        proposals: raw.map((item) => {
          const record = asRecord(item)
          return {
            ...(optionalString(record['candidateId']) === undefined ? {} : { candidateId: optionalString(record['candidateId']) ?? '' }),
            fields: record['fields'],
            evidence: record['evidence'],
            ...(record['rationale'] === undefined ? {} : { rationale: record['rationale'] }),
            ...(record['confidence'] === undefined ? {} : { confidence: record['confidence'] }),
          }
        }),
      })
      if (!result.ok) {
        const error: ExtractError = result.error
        return { ok: false, root, error: { ...error } }
      }
      return {
        ok: true,
        root,
        file: result.value.file,
        submittedAt: result.value.submittedAt,
        created: result.value.created.map((proposal: CandidateProposal) => ({ ...proposal })),
        updated: result.value.updated.map((proposal: CandidateProposal) => ({ ...proposal })),
        fieldNames: candidateFieldNames(kind as ExtractKind),
      }
    },
  }

  const list: ToolDefinition = {
    name: 'inkflow_extract_list',
    description:
      'List extraction candidates: what the model proposed, with its evidence, rationale, confidence and whether the author already accepted or rejected it. Filter by `kind` and by `status`; page with `offset`/`limit`. Counts cover the whole queue, not the page.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        kind: { type: 'string', enum: [...EXTRACT_KINDS], description: 'Only candidates of this kind.' },
        status: { type: 'string', enum: [...CANDIDATE_STATUSES], description: 'Only candidates in this state.' },
        offset: { type: 'integer', description: 'Candidates to skip (0 or higher). Default 0.' },
        limit: { type: 'integer', description: 'How many to return (1–200). Default 50.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          return failureLines('Extract list', String(error['code'] ?? 'unknown'), String(error['message'] ?? ''))
        }
        const items = Array.isArray(v['items']) ? (v['items'] as Json[]) : []
        const counts = asRecord(v['counts'])
        if (items.length === 0) return text(['No candidate matches. Nothing has been proposed for this filter yet.'])
        const lines = [
          `${String(v['total'])} candidate(s)${v['truncated'] === true ? ` (showing ${String(items.length)})` : ''} — ` +
            `${String(counts['proposed'] ?? 0)} proposed · ${String(counts['accepted'] ?? 0)} accepted · ${String(counts['rejected'] ?? 0)} rejected`,
        ]
        for (const item of items) {
          const fields = asRecord(item['fields'])
          const label = String(fields['name'] ?? fields['title'] ?? fields['source'] ?? '')
          lines.push(
            `- ${String(item['candidateId'])} [${String(item['kind'])}/${String(item['status'])}] ${label} ` +
              `(${String(item['confidence'])}) — evidence ${String(item['evidence'])}`,
          )
          if (typeof item['rationale'] === 'string' && item['rationale'] !== '') lines.push(`    ${item['rationale']}`)
        }
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveRoot(a, exec)
      if (isRefused(resolved)) return gateFailure(resolved)
      const root = resolved.probe?.root ?? resolved.root

      const kind = optionalString(a['kind'])
      if (kind !== undefined && !(EXTRACT_KINDS as readonly string[]).includes(kind)) {
        return { ok: false, root, error: { code: 'CANDIDATE_KIND_INVALID', message: `unknown kind "${kind}"` } }
      }
      const status = optionalString(a['status'])
      if (status !== undefined && !(CANDIDATE_STATUSES as readonly string[]).includes(status)) {
        return { ok: false, root, error: { code: 'CANDIDATE_STATUS_INVALID', message: `unknown status "${status}"` } }
      }
      const rawOffset = a['offset']
      const offset = typeof rawOffset === 'number' && Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0
      const rawLimit = a['limit']
      const limit = typeof rawLimit === 'number' && Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50

      const store = readCandidateStore(root)
      const all = store.records.filter(
        (record) =>
          (kind === undefined || record.proposal.kind === kind) && (status === undefined || record.proposal.status === status),
      )
      const counts = { proposed: 0, accepted: 0, rejected: 0 }
      for (const record of store.records) counts[record.proposal.status] += 1
      const page = all.slice(offset, offset + limit)
      return {
        ok: true,
        root,
        total: all.length,
        offset,
        limit,
        truncated: offset + page.length < all.length,
        counts,
        queue: { total: store.records.length, unreadable: store.issues.length },
        ...(store.issues.length === 0 ? {} : { issues: store.issues.map((issue) => ({ ...issue })) }),
        items: page.map(candidateView),
      }
    },
  }

  const accept: ToolDefinition = {
    name: 'inkflow_extract_accept',
    description:
      'Accept candidates: each one becomes a real entity file through the same parser and validators a hand write uses, then the index is refreshed. Requires `confirm: true` — show the author the candidates first. A candidate whose entity would collide with an existing one is refused with that domain\'s own code and nothing is written for it. Accepted candidates are marked accepted in the queue.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        candidateIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'The candidates to accept, one by one (`ex-<8 hex>` each).',
        },
        confirm: CONFIRM_PARAM,
      },
      required: ['candidateIds', 'confirm'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          return failureLines('Extract accept', String(error['code'] ?? 'unknown'), String(error['message'] ?? ''))
        }
        const outcomes = Array.isArray(v['outcomes']) ? (v['outcomes'] as Json[]) : []
        const lines = [
          `Accepted ${String(v['accepted'] ?? 0)}, refused ${String(v['refused'] ?? 0)} candidate(s).`,
        ]
        for (const outcome of outcomes) {
          if (outcome['accepted'] === true) {
            lines.push(`- ${String(outcome['candidateId'])} → ${String(outcome['path'] ?? '')}`)
            continue
          }
          const error = asRecord(outcome['error'])
          lines.push(
            `- ${String(outcome['candidateId'])} refused: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`,
          )
        }
        lines.push(indexLine(v))
        if (Number(v['refused'] ?? 0) > 0) lines.push('A refused candidate leaves no file behind and stays proposed in the queue.')
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveRoot(a, exec)
      if (isRefused(resolved)) return gateFailure(resolved)
      const root = resolved.probe?.root ?? resolved.root

      if (a['confirm'] !== true) {
        return {
          ok: false,
          root,
          error: {
            code: 'EXTRACT_CONFIRM_REQUIRED',
            message: 'accepting a candidate writes an entity file, so it needs confirm: true',
            hint: 'list the candidates with inkflow_extract_list, show them to the author, then call again with confirm: true',
          },
        }
      }
      const ids = Array.isArray(a['candidateIds'])
        ? a['candidateIds'].filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        : []
      if (ids.length === 0) {
        return {
          ok: false,
          root,
          error: { code: 'CANDIDATE_ID_INVALID', message: 'candidateIds must name at least one candidate' },
        }
      }
      const accepted = acceptCandidates(root, ids)
      if (!accepted.ok) return { ok: false, root, error: { ...accepted.error } }

      let indexRebuilt = false
      let indexError: Json | undefined
      try {
        const ensured = await ensureIndex(root)
        if (ensured.ok) indexRebuilt = ensured.rebuilt
        else indexError = { code: ensured.failure.code, message: ensured.failure.message }
      } catch (cause) {
        indexError = { code: 'INDEX_BUILD_FAILED', message: String(cause) }
      }
      return {
        ok: true,
        root,
        accepted: accepted.value.accepted,
        refused: accepted.value.refused,
        outcomes: accepted.value.outcomes.map((outcome) => ({
          candidateId: outcome.candidateId,
          kind: outcome.kind,
          accepted: outcome.accepted,
          ...(outcome.path === undefined ? {} : { path: outcome.path }),
          ...(outcome.error === undefined ? {} : { error: { ...outcome.error } }),
        })),
        indexRebuilt,
        ...(indexError === undefined ? {} : { indexError }),
      }
    },
  }

  const reject: ToolDefinition = {
    name: 'inkflow_extract_reject',
    description:
      'Reject candidates: they stay in the queue as history and **no content file is written**. Rejecting does not undo an earlier accept — that is a delete of the entity. A rejected candidate can be purged later.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        candidateIds: { type: 'array', items: { type: 'string' }, description: 'The candidates to reject.' },
        reason: { type: 'string', description: 'Why they were rejected; recorded in the answer for the next reviewer.' },
      },
      required: ['candidateIds'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          return failureLines('Extract reject', String(error['code'] ?? 'unknown'), String(error['message'] ?? ''))
        }
        const outcomes = Array.isArray(v['outcomes']) ? (v['outcomes'] as Json[]) : []
        const lines = [`Rejected ${String(v['rejected'] ?? 0)} candidate(s); no content file was written.`]
        for (const outcome of outcomes) {
          if (outcome['ok'] === true) {
            lines.push(`- ${String(outcome['candidateId'])} rejected`)
            continue
          }
          const error = asRecord(outcome['error'])
          lines.push(`- ${String(outcome['candidateId'])} not rejected: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`)
        }
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveRoot(a, exec)
      if (isRefused(resolved)) return gateFailure(resolved)
      const root = resolved.probe?.root ?? resolved.root

      const ids = Array.isArray(a['candidateIds'])
        ? a['candidateIds'].filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        : []
      if (ids.length === 0) {
        return { ok: false, root, error: { code: 'CANDIDATE_ID_INVALID', message: 'candidateIds must name at least one candidate' } }
      }
      const store = readCandidateStore(root)
      const refs = ids.map((candidateId) => {
        const record = store.records.find((entry) => entry.proposal.candidateId === candidateId)
        return { candidateId, file: record?.file ?? '' }
      })
      const missing = refs.filter((ref) => ref.file === '')
      const statuses = setCandidateStatuses(
        root,
        refs.filter((ref) => ref.file !== ''),
        'rejected',
        ['proposed'],
      )
      const outcomes: Json[] = [
        ...missing.map((ref) => ({
          candidateId: ref.candidateId,
          ok: false,
          error: { code: 'CANDIDATE_NOT_FOUND', message: `no candidate has the id ${ref.candidateId}` },
        })),
        ...statuses.map((outcome) =>
          outcome.ok
            ? { candidateId: outcome.candidateId, ok: true }
            : { candidateId: outcome.candidateId, ok: false, error: { ...outcome.error } },
        ),
      ]
      return {
        ok: true,
        root,
        rejected: outcomes.filter((outcome) => outcome['ok'] === true).length,
        ...(optionalString(a['reason']) === undefined ? {} : { reason: optionalString(a['reason']) ?? '' }),
        outcomes,
        contentFilesWritten: 0,
      }
    },
  }

  const purge: ToolDefinition = {
    name: 'inkflow_extract_purge',
    description:
      'Delete candidates that were already accepted or rejected from the queue (their batch files shrink; an empty batch file is removed). A `proposed` candidate is refused: purge cleans up after a decision, it never hides one. Requires `confirm: true`.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        candidateIds: { type: 'array', items: { type: 'string' }, description: 'The processed candidates to delete.' },
        confirm: CONFIRM_PARAM,
      },
      required: ['candidateIds', 'confirm'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          return failureLines('Extract purge', String(error['code'] ?? 'unknown'), String(error['message'] ?? ''))
        }
        const purged = Array.isArray(v['purged']) ? (v['purged'] as Json[]) : []
        return text([
          `Purged ${String(purged.length)} candidate(s); ${String(v['remaining'] ?? 0)} left in the queue.`,
          ...purged.map((entry) => `- ${String(entry['candidateId'])} (${String(entry['file'])})`),
        ])
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveRoot(a, exec)
      if (isRefused(resolved)) return gateFailure(resolved)
      const root = resolved.probe?.root ?? resolved.root

      if (a['confirm'] !== true) {
        return {
          ok: false,
          root,
          error: { code: 'EXTRACT_CONFIRM_REQUIRED', message: 'purging deletes candidates, so it needs confirm: true' },
        }
      }
      const ids = Array.isArray(a['candidateIds'])
        ? a['candidateIds'].filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        : []
      if (ids.length === 0) {
        return { ok: false, root, error: { code: 'CANDIDATE_ID_INVALID', message: 'candidateIds must name at least one candidate' } }
      }
      const store = readCandidateStore(root)
      const refs = ids.map((candidateId) => ({
        candidateId,
        file: store.records.find((entry) => entry.proposal.candidateId === candidateId)?.file ?? '',
      }))
      if (refs.some((ref) => ref.file === '')) {
        const unknown = refs.find((ref) => ref.file === '')
        return {
          ok: false,
          root,
          error: { code: 'CANDIDATE_NOT_FOUND', message: `no candidate has the id ${String(unknown?.candidateId ?? '')}` },
        }
      }
      const purged = purgeCandidates(root, refs)
      if (!purged.ok) return { ok: false, root, error: { ...purged.error } }
      const after = readCandidateStore(root)
      return {
        ok: true,
        root,
        purged: purged.purged.map((entry) => ({ ...entry })),
        remaining: after.records.length,
      }
    },
  }

  return [propose, list, accept, reject, purge]
}
