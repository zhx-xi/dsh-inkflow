/**
 * The audit's half of the private channel (#33): one read projection and one export action.
 *
 * Scope: `GET /inkflow/internal/audit` and `POST /inkflow/internal/audit/export`. Everything
 * about *what* an audit means lives in `audit.ts`; this file only turns a report into the
 * wire shape and an HTTP status vocabulary, exactly like `trash-channel.ts` does for the bin.
 *
 * Three request rules, stated once here so the route table stays declarative:
 *
 *   * **the read route writes nothing.** It does not call `ensureIndex` (unlike
 *     `/chapters`, `/search` and `/foreshadow`): a report about integrity must not change
 *     the tree it is reporting on, and `indexState` tells the reader what the cache looks
 *     like in case they want to rebuild it themselves.
 *   * **export needs `confirm: true`** — it writes a file, so `false`/absent is
 *     `CONFIRM_REQUIRED` (400) with zero writes;
 *   * **the address of a finding travels with it.** `address` is the rendered form
 *     (`code · kind:id` / `path#L<n>`) and `locator` is the structured form the panel needs
 *     to decide where a click goes. A client that only read one of the two would have to
 *     re-parse the other, and the two would drift.
 *
 * Why a separate module from `audit.ts`: `audit.ts` is the engine (scan → findings →
 * Markdown) and knows nothing about HTTP; `internal.ts` re-exports these two functions so
 * `routes.ts` keeps one entry point (that file is already ~900 lines — AGENTS.md §10.5).
 */

import { AUDIT_LIST_LIMIT, auditProject, exportAuditReport } from './audit.js'
import type { AuditReport } from './audit.js'
import { FINDING_GROUPS, locatorKey } from './findings.js'
import type { Finding, FindingLocator } from './findings.js'

type JsonRecord = Record<string, unknown>

/** What the audit projection needs from the resolved channel target. */
export interface AuditSource {
  sessionId: string
  root: string
}

export interface AuditReply {
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

/** The locator as the panel receives it: unchanged, but never with extra keys. */
function locatorWire(locator: FindingLocator): JsonRecord {
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

/** One finding on the wire: everything the page prints, nothing it would have to infer. */
export function findingWire(finding: Finding): JsonRecord {
  return {
    code: finding.code,
    group: finding.group,
    severity: finding.severity,
    address: locatorKey(finding.locator),
    locator: locatorWire(finding.locator),
    detail: finding.detail,
    hint: finding.hint,
    fixable: finding.fixable,
  }
}

/**
 * The report on the wire, capped.
 *
 * The **counts describe every finding**; only `findings` is capped, and `truncated` says
 * so. Counting the capped list would make a 500-finding book read as "100 findings".
 */
export function auditWire(report: AuditReport, limit = AUDIT_LIST_LIMIT): JsonRecord {
  const capped = report.findings.slice(0, Math.max(1, limit))
  return {
    title: report.title ?? null,
    counts: report.counts,
    groups: FINDING_GROUPS.map((group) => ({ group, count: report.counts.byGroup[group] })),
    source: report.source,
    indexState: report.indexState,
    catalogStale: report.catalogStale,
    ms: report.ms,
    findings: capped.map(findingWire),
    returned: capped.length,
    truncated: report.findings.length > capped.length,
    /** The full report is always exportable: it is a function of the files, not of a cache. */
    exportable: true,
    exportPath: '.inkflow/audit/audit-<时间戳>.md',
  }
}

function refused(status: number, code: string, extra: JsonRecord = {}): AuditReply {
  return { status, body: { ok: false, error: { code, ...extra } } }
}

/**
 * `GET /audit`: the five families, grouped, with the first `limit` findings.
 *
 * Read-only by construction — `auditProject` opens files and creates nothing, and this
 * function calls no `ensureIndex`.
 */
export function buildAudit(source: AuditSource, version: string, options: { limit?: number } = {}): AuditReply {
  const report = auditProject(source.root)
  const limit = typeof options.limit === 'number' && options.limit > 0 ? Math.min(options.limit, 500) : AUDIT_LIST_LIMIT
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: report.root,
        ...auditWire(report, limit),
      },
    },
  }
}

/**
 * `POST /audit/export`: run the audit again and write the Markdown.
 *
 * The audit is re-run rather than reusing a payload from the browser on purpose: the report
 * must describe the files *now*, and a client-supplied report would be a second source of
 * truth for the document that lands in `.inkflow/audit/`.
 */
export function exportAudit(source: AuditSource, version: string, body: JsonRecord): AuditReply {
  const confirm = body['confirm']
  if (confirm !== undefined && typeof confirm !== 'boolean') {
    return refused(400, 'invalid-field', { field: 'confirm', hint: '`confirm` must be `true` (or absent, which is a refusal)' })
  }
  if (confirm !== true) {
    return refused(400, 'CONFIRM_REQUIRED', { hint: 'exporting writes a file under .inkflow/audit/: pass confirm: true' })
  }
  const report = auditProject(source.root)
  const exported = exportAuditReport(source.root, report)
  if (!exported.ok) {
    const status = STATUS_BY_CODE[exported.error.code] ?? 500
    return refused(status, exported.error.code, {
      message: exported.error.message,
      ...(exported.error.path === undefined ? {} : { path: exported.error.path }),
    })
  }
  return {
    status: 200,
    body: {
      ok: true,
      value: {
        pluginVersion: version,
        sessionId: source.sessionId,
        root: report.root,
        exported: {
          path: exported.path,
          bytes: exported.bytes,
          created: exported.created,
          ignoreLineAdded: exported.ignoreLineAdded,
        },
        counts: report.counts,
        ms: report.ms,
      },
    },
  }
}

/** The body fields `POST /audit/export` may carry (`sessionId` is always allowed). */
export const AUDIT_EXPORT_BODY_FIELDS = ['confirm'] as const

/** Re-exported for the route handler's own limit clamp (kept next to the payload shape). */
export { AUDIT_LIST_LIMIT }

/** `locatorKey` is part of the wire contract; re-exported so tests can compare both sides. */
export { locatorKey }
