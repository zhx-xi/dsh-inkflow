/**
 * The markdown reports a maintenance run leaves behind (ADR-0012 `audit/`).
 *
 * A report is a **derivative**: it can be recomputed from the book at any time and
 * deleting it loses nothing. That is why it lives in `<book>/.inkflow/audit/` (never
 * in a content directory, never in git — ADR-0012 decision 6) and why this module owns no
 * judgement: it renders what the repair/migration call already decided. Keeping the
 * renderer free of business logic is also what lets both callers share one file
 * without a runtime import cycle (`repair.ts` / `migrate.ts` → here, never back).
 */

import { ensurePrivateStateIgnored, privateStateRelative } from './private-state.js'
import { locatorKey } from './findings.js'
import type { Finding } from './findings.js'
import { writeTextAtomic } from './io.js'
import { PRIVATE_STATE_SUBDIRS } from './conventions.js'

/** The parts of a plan the report prints. Structural, so both callers fit. */
export interface ReportAction {
  key: string
  kind: string
  path: string
  codes: readonly string[]
  detail: string
}

export interface ReportSkip {
  key: string
  code: string
  path: string | undefined
  fixable: boolean
  reason: string
}

export interface ReportPlan {
  actions: readonly ReportAction[]
  skipped: readonly ReportSkip[]
}

export interface ReportSummaryRow {
  group: string
  total: number
  fixable: number
}

export interface ReportDetection {
  findings: readonly Finding[]
  summary: readonly ReportSummaryRow[]
  unknown: readonly { code: string; count: number }[]
}

export interface ReportOutcome {
  action: ReportAction
  ok: boolean
  detail: string
  error?: { code: string; message: string }
}

export interface RepairReportInput {
  root: string
  at: Date
  backup: { dir: string; manifestPath: string }
  before: ReportDetection
  plan: ReportPlan
  applied: readonly ReportOutcome[]
  after: ReportDetection
  cleared: readonly string[]
}

export interface ReportFileResult {
  ok: boolean
  path: string
  error?: string
}

/** Markdown-escape the few characters that would break a table cell. */
function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ').trim()
}

function shortLocator(finding: Finding): string {
  const key = locatorKey(finding.locator)
  return key === '' ? '—' : key
}

function findingsTable(findings: readonly Finding[]): string[] {
  if (findings.length === 0) return ['（无）', '']
  const lines = ['| code | 位置 | 可自动修 | 说明 |', '|---|---|---|---|']
  for (const finding of findings) {
    lines.push(`| \`${finding.code}\` | ${cell(shortLocator(finding))} | ${finding.fixable ? '是' : '否'} | ${cell(finding.detail)} |`)
  }
  lines.push('')
  return lines
}

/**
 * The repair report: what was wrong, what the run did, what it refused, and the
 * proof (a re-run of the same checks).
 */
export function repairReportMarkdown(input: RepairReportInput): string {
  const lines: string[] = [
    `# 体检修复报告`,
    '',
    `- 书：\`${input.root}\``,
    `- 时间：${input.at.toISOString()}`,
    `- 备份包：\`${input.backup.dir}/\`（清单位于 \`${input.backup.manifestPath}\`）`,
    `- 检测：${String(input.before.findings.length)} 个问题，其中 ${String(
      input.before.findings.filter((finding) => finding.fixable).length,
    )} 个标为可自动修`,
    '',
    '> 本报告是派生物：可随时重算，删掉不丢真相（ADR-0012 第 6 条）。',
    '',
    '## 1. 修复前的问题（按检查族）',
    '',
  ]

  if (input.before.summary.length === 0) {
    lines.push('（无）', '')
  } else {
    lines.push('| 检查族 | 数量 | 可自动修 |', '|---|---|---|')
    for (const row of input.before.summary) lines.push(`| ${row.group} | ${String(row.total)} | ${String(row.fixable)} |`)
    lines.push('')
  }

  if (input.before.unknown.length > 0) {
    lines.push(
      `**未入册的诊断码**（findings 目录里没有，报告只能列出不能解释）：${input.before.unknown
        .map((entry) => `${entry.code}×${String(entry.count)}`)
        .join('、')}`,
      '',
    )
  }

  lines.push('### 逐条', '')
  lines.push(...findingsTable(input.before.findings))

  lines.push('## 2. 本次动作', '')
  if (input.applied.length === 0) {
    lines.push('（没有执行任何动作）', '')
  } else {
    lines.push('| # | 动作 | 目标 | 结果 | 说明 |', '|---|---|---|---|---|')
    input.applied.forEach((outcome, index) => {
      const result = outcome.ok ? '成功' : `失败 \`${outcome.error?.code ?? 'unknown'}\``
      const detail = outcome.ok ? outcome.detail : (outcome.error?.message ?? '')
      lines.push(
        `| ${String(index + 1)} | \`${outcome.action.kind}\` | ${cell(outcome.action.path)} | ${result} | ${cell(detail)} |`,
      )
    })
    lines.push('')
  }

  lines.push('## 3. 未自动修的问题与原因', '')
  if (input.plan.skipped.length === 0) {
    lines.push('（无）', '')
  } else {
    lines.push('| code | 位置 | 目录标注 | 原因 |', '|---|---|---|---|')
    for (const skip of input.plan.skipped) {
      lines.push(
        `| \`${skip.code}\` | ${cell(skip.path ?? '—')} | ${skip.fixable ? '可自动修但本次无动作' : '不可自动修'} | ${cell(skip.reason)} |`,
      )
    }
    lines.push('')
  }

  lines.push('## 4. 重跑检测（证明）', '')
  const afterFindings = input.after.findings
  lines.push(
    `- 修复后剩余 **${String(afterFindings.length)}** 个问题，消失 **${String(input.cleared.length)}** 条`,
    `- 消失的 finding key：${input.cleared.length === 0 ? '（无）' : input.cleared.map((key) => `\`${key}\``).join('、')}`,
    '',
  )
  if (afterFindings.length > 0) {
    lines.push(...findingsTable(afterFindings))
  }

  lines.push(
    '## 5. 回滚',
    '',
    `本次批量修复的全部改动都先复制进了 \`${input.backup.dir}/\`。需要撤销时按**这个**包回滚：`,
    '',
    '```',
    `inkflow_project_migrate - action: rollback - backup: ${input.backup.dir.split('/').pop() ?? ''}`,
    '```',
    '',
    '回滚会把 `modified` 的文件按备份字节写回、删掉本次 `created` 的文件、再把本次 `removed` 的文件复原；',
    '若某个文件在本次运行之后又被改过，回滚会拒绝覆盖它并在结果里点名。',
    '',
  )

  return lines.join('\n')
}

export interface MigrationReportInput {
  root: string
  at: Date
  /** `plan` or `apply` — a dry run report is written too when the caller asks for one. */
  stage: 'plan' | 'apply' | 'rollback'
  actions: readonly ReportAction[]
  applied: readonly string[]
  backup?: { dir: string; manifestPath: string }
  notices: readonly string[]
  before: string
  after?: string
  rolledBack?: { restored: readonly string[]; removed: readonly string[]; dirsRemoved: readonly string[]; kept: readonly { path: string; reason: string }[] }
  error?: { code: string; message: string }
}

/** The migration report: the action list (dry run) and what actually changed. */
export function migrationReportMarkdown(input: MigrationReportInput): string {
  const lines: string[] = [
    `# 目录迁移报告（${input.stage}）`,
    '',
    `- 书：\`${input.root}\``,
    `- 时间：${input.at.toISOString()}`,
    `- 门禁：${input.before}${input.after === undefined ? '' : ` → ${input.after}`}`,
  ]
  if (input.backup !== undefined) lines.push(`- 备份包：\`${input.backup.dir}/\``)
  lines.push('')

  if (input.error !== undefined) {
    lines.push(`**未完成**：\`${input.error.code}\` — ${input.error.message}`, '')
  }

  lines.push('## 动作清单', '')
  if (input.actions.length === 0) {
    lines.push('（没有需要执行的迁移动作）', '')
  } else {
    lines.push('| # | 动作 | 目标 | 说明 |', '|---|---|---|---|')
    input.actions.forEach((action, index) => {
      lines.push(`| ${String(index + 1)} | \`${action.kind}\` | ${cell(action.path)} | ${cell(action.detail)} |`)
    })
    lines.push('')
  }

  if (input.stage !== 'plan') {
    lines.push('## 实际执行', '')
    if (input.applied.length === 0) lines.push('（没有步骤真正执行）', '')
    else for (const step of input.applied) lines.push(`- \`${step}\``)
    lines.push('')
  }

  if (input.rolledBack !== undefined) {
    lines.push(
      '## 回滚结果',
      '',
      `- 复原：${input.rolledBack.restored.length === 0 ? '（无）' : input.rolledBack.restored.map((path) => `\`${path}\``).join('、')}`,
      `- 删除本次创建的文件：${input.rolledBack.removed.length === 0 ? '（无）' : input.rolledBack.removed.map((path) => `\`${path}\``).join('、')}`,
      `- 删除本次创建的目录：${input.rolledBack.dirsRemoved.length === 0 ? '（无）' : input.rolledBack.dirsRemoved.map((path) => `\`${path}/\``).join('、')}`,
      '',
    )
    for (const kept of input.rolledBack.kept) lines.push(`- 保留 \`${kept.path}\`：${kept.reason}`)
    lines.push('')
  }

  if (input.notices.length > 0) {
    lines.push('## 需要你自己处理', '')
    for (const notice of input.notices) lines.push(`- ${notice}`)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Write one report into `.inkflow/audit/`.
 *
 * The ignore line is appended here rather than at the gate (ADR-0012 decision 2): this is
 * the first moment the directory is used in this book, and a book that never runs a
 * maintenance pass must not carry a `needs-repair` action for an optional line.
 */
export function writeAuditReport(projectRoot: string, name: string, markdown: string): ReportFileResult {
  if (!PRIVATE_STATE_SUBDIRS.includes('audit')) {
    return { ok: false, path: '', error: 'audit is not a declared private-state subdirectory' }
  }
  const relative = privateStateRelative('audit', name)
  ensurePrivateStateIgnored(projectRoot)
  const written = writeTextAtomic(projectRoot, relative, markdown.endsWith('\n') ? markdown : `${markdown}\n`)
  if (!written.ok) return { ok: false, path: relative, error: written.error.message }
  return { ok: true, path: relative }
}

/** Re-exported so a caller can name the audit directory without importing conventions. */
export { privateStateDirRelative } from './private-state.js'
