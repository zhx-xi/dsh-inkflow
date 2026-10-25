/**
 * The consistency audit tool (split out of `tools.ts`, #193): `inkflow_project_audit`
 * (#33, roadmap X-14). Read-only unless `export: true`, and the export is the one
 * action that writes — under `.inkflow/audit/` (ADR-0012 #6).
 */

import type { ContentBlock, ToolDefinition } from '../context.js'
import { AUDIT_LIST_LIMIT, auditProject, exportAuditReport } from '../audit.js'
import { auditWire } from '../audit-channel.js'
import { gateFailure, resolveProject } from '../domains/tool-project.js'
import { rememberProject } from '../state.js'
import type { Json, ToolDeps } from './shared.js'
import { PROJECT_ROOT_PARAM, SUCCESS_SCHEMA, asRecord, text } from './shared.js'

/**
 * The audit tool's refusal, rendered: a gate refusal keeps its checklist, an export refusal
 * says what to pass instead. Never a bare code — the model has to be able to act.
 */
function renderAuditFailure(value: Json): ContentBlock[] {
  const error = asRecord(value['error'])
  const lines = [`Audit failed: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`]
  if (error['path'] !== undefined) lines.push(`path: ${String(error['path'])}`)
  if (Array.isArray(error['missing'])) {
    lines.push(`Missing: ${(error['missing'] as unknown[]).map(String).join(', ') || '—'}`)
  }
  if (error['hint'] !== undefined) lines.push(String(error['hint']))
  return text(lines)
}

export function auditTools(deps: ToolDeps): ToolDefinition[] {
  /**
   * The consistency audit (#33, roadmap X-14). Read-only unless `export: true`, and the
   * export is the one action here that writes — under `.inkflow/audit/` (ADR-0012 #6).
   *
   * Why the reply carries only the first `limit` findings plus the counts: a 500-chapter
   * book can produce hundreds of findings, and a tool reply is context the model pays for.
   * The full list is the exported Markdown (and the panel), so `truncated` + `exportable`
   * tell the model what to do next instead of dumping everything.
   */
  const audit: ToolDefinition = {
    name: 'inkflow_project_audit',
    description:
      'Run the consistency audit over the whole book and return the findings grouped into five families: structure ' +
      '(tree/graph invariants and frontmatter), ledger (fact conflicts), foreshadow (late and due-now setups), ' +
      'timeline and catalog drift. Each finding carries a stable code, a severity, a locator (an entity `kind:id`, ' +
      'a chapter id, a `path#L<n>` line or a volume catalog), one sentence of what is wrong and one line of what to ' +
      'do about it. Read-only: it re-scans the files, never rebuilds the index and never writes. The reply holds the ' +
      'counts of every finding plus the first `limit` of them; pass `export: true` with `confirm: true` to also write ' +
      'the full Markdown report into `.inkflow/audit/`. Two runs on an unchanged book produce the same report, so the ' +
      'file is diffable. Use it after a bulk import or a big edit; for one specific problem prefer the domain tool ' +
      'that owns it (e.g. inkflow_foreshadow_list for a board, inkflow_facts_snapshot for a timeline-of-facts).',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        limit: {
          type: 'number',
          description: 'How many findings to return in the reply (1–500; default 100). The counts always cover all of them.',
        },
        export: {
          type: 'boolean',
          description: 'Also write the full Markdown report into `.inkflow/audit/audit-<timestamp>.md`. Needs `confirm: true`.',
        },
        confirm: {
          type: 'boolean',
          description: 'Required when `export` is true: the export writes a file. Without it nothing is written.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) return renderAuditFailure(v)
        const counts = asRecord(v['counts'])
        const byGroup = asRecord(counts['byGroup'])
        const severity = asRecord(counts['severity'])
        const findings = Array.isArray(v['findings']) ? (v['findings'] as Json[]) : []
        const lines: string[] = []
        const exported = asRecord(v['exported'])
        lines.push(
          `审计完成：${String(counts['total'] ?? 0)} 项（warning ${String(severity['warning'] ?? 0)} · info ${String(severity['info'] ?? 0)}），` +
            `其中 ${String(counts['fixable'] ?? 0)} 项可自动修复。`,
        )
        lines.push(
          `分组：${['structure', 'ledger', 'foreshadow', 'timeline', 'catalog']
            .map((group) => `${group} ${String(byGroup[group] ?? 0)}`)
            .join(' · ')}`,
        )
        if (v['catalogStale'] === true) lines.push('注意：catalog 与正文不一致（catalog 偏差组的说明里有处理办法）。')
        if (exported['path'] === undefined) {
          lines.push(`indexState: ${String(v['indexState'] ?? '?')}（只影响缓存，不影响本次结果）`)
        } else {
          lines.push(`已导出：${String(exported['path'])}（${String(exported['bytes'] ?? 0)} 字节）`)
        }
        if (findings.length === 0) {
          lines.push('没有任何问题。')
          return text(lines)
        }
        lines.push('')
        for (const finding of findings) {
          lines.push(`- [${String(finding['group'])}/${String(finding['severity'])}] ${String(finding['code'])} · ${String(finding['address'])} · ${String(finding['detail'])}`)
        }
        if (v['truncated'] === true) {
          lines.push(
            `…还有 ${String(Number(counts['total'] ?? 0) - findings.length)} 项未列出；` +
              '需要全量报告就再调一次并带 export: true、confirm: true。',
          )
        }
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const rawLimit = a['limit']
      const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : AUDIT_LIST_LIMIT
      const wantsExport = a['export'] === true
      if (wantsExport && a['confirm'] !== true) {
        return {
          ok: false,
          root: probe.root,
          error: {
            code: 'CONFIRM_REQUIRED',
            message: 'exporting writes a Markdown file under .inkflow/audit/',
            hint: 'pass export: true together with confirm: true (the report is derived and can be deleted at any time)',
          },
        }
      }
      const report = auditProject(probe.root)
      rememberProject(deps.dataDir, probe.root)
      const value = auditWire(report, limit)
      if (!wantsExport) return { ok: true, root: probe.root, ...value }
      const exported = exportAuditReport(probe.root, report)
      if (!exported.ok) {
        return {
          ok: false,
          root: probe.root,
          error: { code: exported.error.code, message: exported.error.message, ...(exported.error.path === undefined ? {} : { path: exported.error.path }) },
          counts: value['counts'],
        }
      }
      return {
        ok: true,
        root: probe.root,
        ...value,
        exported: {
          path: exported.path,
          bytes: exported.bytes,
          created: exported.created,
          ignoreLineAdded: exported.ignoreLineAdded,
        },
      }
    },
  }

  return [audit]
}

