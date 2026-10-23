/**
 * Pure view model for the audit page (#33, roadmap X-14).
 *
 * Same split as every other page in this plugin: the wording, the grouping and the
 * "can this be jumped to?" decision are plain functions over plain data, so `node --test`
 * (no DOM) can pin them; `audit.tsx` keeps only state and markup.
 *
 * Two rules this file holds to:
 *
 *   * **the Host owns every verdict.** Nothing here decides whether a finding is real, how
 *     severe it is or whether it is fixable — those arrive on the wire. This file only says
 *     what they mean in the author's language.
 *   * **an address is shown, not re-derived.** `address` (rendered by the Host's
 *     `locatorKey`) is what the reader copies into an issue; the structured `locator` is
 *     used for one thing only: deciding where a click goes. Re-parsing `address` to
 *     recover the target would be a second implementation of the address format.
 *
 * `import type` only for the channel client: this module must not pull `./internal.js` in at
 * import time (the same rule `trash-model.ts` follows).
 */

import { asRecord, describeIssueCode, kindLabel } from './library-model.js'
import type { InternalError } from './internal.js'

/** One section of the report; the order is the Host's (`FINDING_GROUPS`). */
export interface AuditGroup {
  group: string
  count: number
}

/** Where a finding points, as the Host sends it (never re-interpreted). */
export type AuditLocator =
  | { kind: 'entity'; entityKind: string; id: string }
  | { kind: 'chapter'; chapterId: string }
  | { kind: 'catalog'; volumeId?: string }
  | { kind: 'path'; path: string; line?: number }
  | { kind: 'unknown' }

export interface AuditFinding {
  code: string
  group: string
  severity: string
  /** The rendered address — the same string the exported Markdown prints. */
  address: string
  locator: AuditLocator
  detail: string
  hint: string
  fixable: boolean
}

export interface AuditCounts {
  total: number
  byGroup: Readonly<Record<string, number>>
  warning: number
  info: number
  blocking: number
  fixable: number
}

export interface AuditView {
  title: string | null
  counts: AuditCounts
  groups: AuditGroup[]
  findings: AuditFinding[]
  truncated: boolean
  indexState: string
  catalogStale: boolean
  ms: number
  exportPath: string
}

/** The five family labels; unknown groups print as they arrived. */
export const AUDIT_GROUP_LABELS: Readonly<Record<string, string>> = {
  structure: '结构不变量',
  ledger: '事实账本',
  foreshadow: '伏笔超期',
  timeline: '时间线',
  catalog: 'catalog 偏差',
}

/** Severity wording. `blocking` never arrives from a read, but a page must not print nothing. */
export const AUDIT_SEVERITY_LABELS: Readonly<Record<string, string>> = {
  blocking: '必须处理',
  warning: '需要处理',
  info: '提示',
}

export function groupLabel(group: string): string {
  return AUDIT_GROUP_LABELS[group] ?? group
}

export function severityLabel(severity: string): string {
  return AUDIT_SEVERITY_LABELS[severity] ?? severity
}

/** A code's Chinese label, from the one table the library panel already uses. */
export function codeLabel(code: string): string {
  return describeIssueCode(code)
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readLocator(raw: unknown): AuditLocator {
  const record = asRecord(raw)
  if (record === undefined) return { kind: 'unknown' }
  const kind = str(record['kind'])
  if (kind === 'entity') {
    const entityKind = str(record['entityKind'])
    const id = str(record['id'])
    return entityKind !== '' && id !== '' ? { kind: 'entity', entityKind, id } : { kind: 'unknown' }
  }
  if (kind === 'chapter') {
    const chapterId = str(record['chapterId'])
    return chapterId === '' ? { kind: 'unknown' } : { kind: 'chapter', chapterId }
  }
  if (kind === 'catalog') {
    const volumeId = str(record['volumeId'])
    return volumeId === '' ? { kind: 'catalog' } : { kind: 'catalog', volumeId }
  }
  if (kind === 'path') {
    const path = str(record['path'])
    if (path === '') return { kind: 'unknown' }
    const line = record['line']
    return typeof line === 'number' && Number.isFinite(line) ? { kind: 'path', path, line } : { kind: 'path', path }
  }
  return { kind: 'unknown' }
}

function readFinding(raw: unknown): AuditFinding | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const code = str(record['code'])
  if (code === '') return undefined
  return {
    code,
    group: str(record['group']),
    severity: str(record['severity']),
    address: str(record['address']),
    locator: readLocator(record['locator']),
    detail: str(record['detail']),
    hint: str(record['hint']),
    fixable: record['fixable'] === true,
  }
}

/**
 * Read `GET /audit` → `value` defensively.
 *
 * A row without a code is dropped rather than rendered as a blank line: a finding nobody can
 * name is not actionable, and the Host never sends one (every finding carries one of
 * `FINDING_CODES`).
 */
export function readAuditValue(value: unknown): AuditView {
  const record = asRecord(value) ?? {}
  const countsRaw = asRecord(record['counts']) ?? {}
  const byGroupRaw = asRecord(countsRaw['byGroup']) ?? {}
  const severityRaw = asRecord(countsRaw['severity']) ?? {}
  const byGroup: Record<string, number> = {}
  for (const [group, count] of Object.entries(byGroupRaw)) byGroup[group] = num(count)

  const groups: AuditGroup[] = []
  for (const raw of Array.isArray(record['groups']) ? (record['groups'] as unknown[]) : []) {
    const group = asRecord(raw)
    if (group === undefined) continue
    const name = str(group['group'])
    if (name === '') continue
    groups.push({ group: name, count: num(group['count']) })
  }

  const findings: AuditFinding[] = []
  for (const raw of Array.isArray(record['findings']) ? (record['findings'] as unknown[]) : []) {
    const finding = readFinding(raw)
    if (finding !== undefined) findings.push(finding)
  }

  return {
    title: str(record['title']) === '' ? null : str(record['title']),
    counts: {
      total: num(countsRaw['total'], findings.length),
      byGroup,
      warning: num(severityRaw['warning']),
      info: num(severityRaw['info']),
      blocking: num(severityRaw['blocking']),
      fixable: num(countsRaw['fixable']),
    },
    groups,
    findings,
    truncated: record['truncated'] === true,
    indexState: str(record['indexState']),
    catalogStale: record['catalogStale'] === true,
    ms: num(record['ms']),
    exportPath: str(record['exportPath']),
  }
}

/** Group order for the page: the Host's `groups` array, falling back to the label table's. */
export function groupOrder(view: AuditView): string[] {
  if (view.groups.length > 0) return view.groups.map((group) => group.group)
  return Object.keys(AUDIT_GROUP_LABELS)
}

/** The headline: "共 N 项（需要处理 X · 提示 Y）· 其中 Z 项可自动修复". */
export function auditHeadline(view: AuditView): string {
  const { counts } = view
  if (counts.total === 0) return '没有发现问题'
  const parts = [`共 ${String(counts.total)} 项`]
  const severity: string[] = []
  if (counts.blocking > 0) severity.push(`必须处理 ${String(counts.blocking)}`)
  if (counts.warning > 0) severity.push(`需要处理 ${String(counts.warning)}`)
  if (counts.info > 0) severity.push(`提示 ${String(counts.info)}`)
  if (severity.length > 0) parts.push(`（${severity.join(' · ')}）`)
  if (counts.fixable > 0) parts.push(` · ${String(counts.fixable)} 项可自动修复`)
  return parts.join('')
}

/** "结构不变量 6 · 事实账本 2 · …" for the row under the headline. */
export function auditGroupLine(view: AuditView): string {
  const order = groupOrder(view)
  if (order.length === 0) return ''
  return order.map((group) => `${groupLabel(group)} ${String(view.counts.byGroup[group] ?? 0)}`).join(' · ')
}

/**
 * The address as a person reads it: `.` is the whole book, a catalog is a volume's catalog.
 *
 * The **raw address** is what gets copied, so it is never replaced — this string only labels
 * it. `null` for a locator the page cannot name (the raw address still shows).
 */
export function locateLabel(locator: AuditLocator): string | null {
  switch (locator.kind) {
    case 'entity':
      return `${kindLabel(locator.entityKind)}的条目`
    case 'chapter':
      return '章'
    case 'catalog':
      return locator.volumeId === undefined ? '整本书的卷章目录' : `卷 ${locator.volumeId} 的卷章目录`
    case 'path':
      return locator.path === '.' ? '整本书（跨文件的不变量）' : locator.line === undefined ? '文件' : '文件行'
    case 'unknown':
      return null
  }
}

/** Where a click goes, or `null` when the page has nothing to jump to (a report-only row). */
export type AuditJumpTarget =
  | { kind: 'chapter'; chapterId: string }
  | { kind: 'entity'; entityKind: string; id: string }

export function jumpTargetOf(locator: AuditLocator): AuditJumpTarget | null {
  if (locator.kind === 'chapter') return { kind: 'chapter', chapterId: locator.chapterId }
  if (locator.kind === 'entity') return { kind: 'entity', entityKind: locator.entityKind, id: locator.id }
  // A `path` locator names a file, and the panel has no viewer for one: the address is what
  // it can offer. `catalog` has no page either — rebuilding it is a write, which the audit
  // deliberately does not do.
  return null
}

/** What the export button says it will do (the label is the confirmation, ADR-0012 #4). */
export function exportLabel(exportPath: string): string {
  return exportPath === '' ? '导出 Markdown' : `导出到 ${exportPath}`
}

/** How the export ended, in one line. Never claims success the Host did not report. */
export function exportNotice(exported: { path?: unknown; bytes?: unknown }): string {
  const path = typeof exported.path === 'string' ? exported.path : ''
  const bytes = typeof exported.bytes === 'number' ? exported.bytes : 0
  if (path === '') return '已导出报告'
  return `已导出 ${path}（${String(bytes)} 字节）`
}

const CODE_HINTS: Readonly<Record<string, string>> = {
  CONFIRM_REQUIRED: '导出会写一个文件，需要再确认一次。',
  PROJECT_BUSY: '这本书正在被另一个写入操作占用，稍后再试。',
  PATH_OUT_OF_SCOPE: '报告只能写进这本书的 .inkflow/audit/，这次的目标越界了。',
  PATH_NOT_WRITABLE: '报告落点不可写（目录被占用或没有权限）。',
  NO_SESSION_CONTEXT: '还没定位到这本书的会话，稍后再试。',
  'forbidden-origin': '这次请求不是本页面发出的，已拒绝。',
  'unsupported-media-type': '请求缺少 JSON 头，已拒绝。',
}

/** One refusal, in the author's language; falls back to the Host's own message, then the code. */
export function describeAuditError(error: InternalError | { code?: string; message?: string } | null | undefined): string {
  const code = error?.code ?? ''
  const known = CODE_HINTS[code]
  if (known !== undefined) return known
  const message = typeof error?.message === 'string' && error.message.trim() !== '' ? error.message : ''
  if (message !== '') return message
  return code === '' ? '操作失败，但没有拿到原因' : `操作失败（${code}）`
}
