/**
 * The quality-gate tool (split out of `tools.ts`): `inkflow_gate_check` (X-24/X-26).
 * Eight checks over one chapter (the eighth: 退化检测); the verdict
 * lands in `.inkflow/audit/gate-<chapterId>.json` (ADR-0022 D4) — derived, idempotent, never
 * inside a content directory and never inside `index/` (X-25).
 */

import type { ToolDefinition } from '../context.js'
import { gateWire, runGate } from '../gate.js'
import { gateFailure, resolveProject } from '../domains/tool-project.js'
import { rememberProject } from '../state.js'
import type { Json, ToolDeps } from './shared.js'
import { PROJECT_ROOT_PARAM, SUCCESS_SCHEMA, asRecord, optionalString, text } from './shared.js'

export function gateTools(deps: ToolDeps): ToolDefinition[] {
  /**
   * The quality gate (X-24/X-26). Eight checks over **one** chapter, and the verdict
   * lands in `.inkflow/audit/gate-<chapterId>.json` (ADR-0022 D4) — derived, idempotent,
   * never inside a content directory and never inside `index/` (X-25).
   *
   * Why the record is on by default while the audit's export is not: the audit's Markdown
   * is a *run* the user asks for ("give me the report"), so it carries a time-stamped name
   * and needs `confirm: true`; the gate's file is the product of gating, the same bytes
   * every time, so asking twice for one action would only teach the caller to click
   * through prompts. `write: false` computes without recording — the panel's read route is
   * that same switch, because a GET must not write.
   */
  const gateCheck: ToolDefinition = {
    name: 'inkflow_gate_check',
    description:
      'Run the eight quality gates over one chapter: word count against the target range, the chapter-end hook, the six ' +
      'de-AI dimensions (sentence length, dash/ellipsis density, parallel structure, explanatory narration, modifier ' +
      'density, paragraph-end clichés) plus the three fragmentation bounds that judge the opposite failure (telegram-style ' +
      'runs of very short sentences, a chapter with no causal or adversative link at all, an over-long single paragraph), ' +
      'consistency with the setting library (pov, ledger values that no longer hold), ' +
      'a sensitive-word self-check, platform form rules (pasted-in residue, off-site promotion), mechanical ' +
      'proofreading (punctuation pairing, half/full-width mixing, doubled words, near-miss character names, mixed ' +
      'appellations, Arabic numbers with Chinese measure words) and degeneration detection (verbatim repetition, a ' +
      'body cut off mid-sentence, placeholder/meta lines such as 「（此处继续展开）」, engineering words such as TODO or ' +
      'lorem; text inside quotation marks is a character\'s line and is exempt). Every judgement is a regular ' +
      'expression, a static word list or an arithmetic threshold: no model is called and nothing leaves the process, so ' +
      'one chapter costs ' +
      'a few file reads. The reply carries the eight checks with their counts and one row per finding (code, ' +
      'severity, locator, what is wrong, what to do), and the verdict is written to ' +
      '`.inkflow/audit/gate-<chapterId>.json` — no timestamp, no absolute path, the same bytes for the same chapter ' +
      'and files, so two runs diff empty. Omit `chapterId` for the book\'s last chapter; pass `write: false` to ' +
      'compute without recording. For the book-wide invariants (structure, ledger, foreshadow, timeline, catalog) use ' +
      'inkflow_project_audit instead.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        chapterId: {
          type: 'string',
          description:
            'Chapter id (or project-relative path) to gate. Omit for the last chapter in reading order.',
        },
        write: {
          type: 'boolean',
          description:
            'Record the verdict to `.inkflow/audit/gate-<chapterId>.json` (default true). `false` computes and returns the same report without writing.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          return text([
            `门禁没有跑成：${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`,
            String(error['hint'] ?? ''),
          ])
        }
        const counts = asRecord(v['counts'])
        const checks = Array.isArray(v['checks']) ? (v['checks'] as Json[]) : []
        const findings = Array.isArray(v['findings']) ? (v['findings'] as Json[]) : []
        const lines: string[] = []
        lines.push(
          `门禁：${String(v['chapterId'] ?? '?')}（${String(v['wordCount'] ?? 0)} 字）· ` +
            `共 ${String(counts['total'] ?? 0)} 项（需要处理 ${String(counts['warning'] ?? 0)} · 提示 ${String(counts['info'] ?? 0)}）`,
        )
        lines.push(`八项：${checks.map((check) => `${String(check['label'])} ${String(check['count'])}`).join(' · ')}`)
        const file = asRecord(v['file'])
        if (file['path'] === undefined) {
          lines.push('未落盘（write: false）。')
        } else {
          lines.push(`结论：${String(file['path'])}（${String(file['bytes'] ?? 0)} 字节，同章同文件两次运行字节相同）`)
        }
        if (findings.length === 0) {
          lines.push('八项门禁都没有发现问题。')
          return text(lines)
        }
        lines.push('')
        for (const finding of findings) {
          const locator = asRecord(finding['locator'])
          const address =
            locator['kind'] === 'chapter'
              ? `chapter:${String(locator['chapterId'])}`
              : locator['line'] === undefined
                ? String(locator['path'])
                : `${String(locator['path'])}#L${String(locator['line'])}`
          lines.push(
            `- [${String(finding['check'])}/${String(finding['severity'])}] ${String(finding['code'])} · ${address} · ${String(finding['detail'])}`,
          )
        }
        if (v['truncated'] === true) {
          lines.push(`…还有 ${String(Number(counts['total'] ?? 0) - findings.length)} 项未列出；全量看 .inkflow/audit/ 下的结论文件。`)
        }
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const chapterId = optionalString(a['chapterId'])
      const gated = runGate(probe.root, chapterId === undefined ? {} : { chapterId }, { record: a['write'] !== false })
      if (!gated.ok) return { ok: false, root: probe.root, error: gated.error }
      rememberProject(deps.dataDir, probe.root)
      const payload = gateWire(gated.report)
      return {
        ok: true,
        root: probe.root,
        ...payload,
        ...(gated.file === undefined ? {} : { file: gated.file }),
      }
    },
  }

  return [gateCheck]
}

