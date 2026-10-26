/**
 * The consistency-audit tab (roadmap X-14, DoD D3-3).
 *
 * One screen, three jobs, and no state beyond "what did the Host say":
 *
 *   1. **the counts** — five families, so a clean family is visible as a zero instead of
 *      being indistinguishable from a family nobody checked;
 *   2. **the findings** — each row shows its code, its severity, its **address** (the same
 *      string the exported Markdown prints, so a row can be pasted into an issue) and one
 *      line of what is wrong plus one line of what to do;
 *   3. **two clicks that go somewhere** — a chapter row opens that chapter in the chapters
 *      tab, an entity row opens that entry in the setting library. Everything else (a file
 *      line, a volume catalog) keeps its address and offers no button: a button that lands
 *      on a list is worse than no button.
 *
 * The export button says where the file goes in its own label (`导出到 .inkflow/audit/…`) and
 * asks `POST /audit/export` with `confirm: true`. The route re-runs the audit itself, so the
 * file always describes the files as they are now — the page never posts findings back.
 *
 * Read-only otherwise: this page cannot change the book, by construction (the one write route
 * it calls writes into `.inkflow/audit/`, which is derived and never in git).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { ACTION_BUTTON_STYLE } from './action-button.js'
import {
  auditGroupLine,
  auditHeadline,
  codeLabel,
  describeAuditError,
  exportLabel,
  exportNotice,
  groupLabel,
  groupOrder,
  jumpTargetOf,
  locateLabel,
  readAuditValue,
  severityLabel,
} from './audit-model.js'
import type { AuditFinding, AuditJumpTarget, AuditView } from './audit-model.js'
import { fetchInternal, writeInternal } from './internal.js'
import type { InternalResult } from './internal.js'
import { Icon } from './icons.js'
import { SCROLL_BOX_STYLE, SCROLL_COLUMN_STYLE } from './layout-model.js'
import { useScrollBox } from './layout.js'
import { AUDIT_SCOPE_NOTE } from './page-notes.js'

// Same shape as the other pages: the height comes from the shared measurement (issue 116),
// the colours from the host theme (AGENTS.md §6). This module keeps its own small style set
// rather than importing `index.tsx`'s, which would make the two import each other.
const bodyStyle = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minHeight: 0 } as const

const columnStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 14,
  ...SCROLL_COLUMN_STYLE,
} as const

const cardStyle = {
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 8,
  padding: '10px 12px',
  background: 'var(--dsw-alias-bg-layer-1)',
} as const

const muted = { color: 'var(--dsw-alias-label-secondary)' } as const

const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 } as const

const rowStyle = {
  display: 'grid',
  gap: 3,
  padding: '8px 0',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
} as const

function SectionTitle({ children }: { children: string }) {
  return <div style={{ ...muted, fontSize: 12, letterSpacing: 0.2 }}>{children}</div>
}

function NoteCard({ title, body, tone }: { title: string; body: string; tone?: 'error' }) {
  const accent = tone === 'error' ? { borderColor: 'var(--dsw-alias-state-error-primary)' } : {}
  return (
    <div style={{ ...cardStyle, borderStyle: 'dashed', ...accent }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={muted}>{body}</div>
    </div>
  )
}

/** One severity's colour: error for "must fix", secondary for a hint, primary otherwise. */
function severityColor(severity: string): string {
  if (severity === 'blocking' || severity === 'warning') return 'var(--dsw-alias-state-error-primary)'
  if (severity === 'info') return 'var(--dsw-alias-label-secondary)'
  return 'var(--dsw-alias-label-primary)'
}

export interface AuditViewProps {
  sessionId: string
  /**
   * Take the reader to a finding's target. Provided by `index.tsx`, which owns the tab and
   * the chapter selection; the page never navigates by itself (it has no router).
   */
  onOpen?: (target: AuditJumpTarget) => void
}

export function AuditView({ sessionId, onOpen }: AuditViewProps) {
  const [audit, setAudit] = useState<InternalResult<AuditValueShape> | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const scrollBox = useScrollBox()

  const load = useCallback(async () => {
    setLoading(true)
    const result = await fetchInternal<AuditValueShape>('/audit', { sessionId })
    setAudit(result)
    setLoading(false)
  }, [sessionId])

  useEffect(() => {
    void load()
  }, [load])

  const view = useMemo(
    () => readAuditValue(audit !== null && audit.ok ? (audit.value ?? undefined) : undefined),
    [audit],
  )
  const loadError = audit !== null && !audit.ok ? describeAuditError(audit.error) : null

  const exportReport = async (): Promise<void> => {
    setExporting(true)
    setError(null)
    setNotice(null)
    const result = await writeInternal<{ exported?: { path?: string; bytes?: number } }>('/audit/export', { confirm: true }, { sessionId })
    setExporting(false)
    if (!result.ok) {
      setError(describeAuditError(result.error))
      return
    }
    setNotice(exportNotice(result.value?.exported ?? {}))
  }

  const grouped = groupOrder(view).map((group) => ({
    group,
    items: view.findings.filter((finding) => finding.group === group),
  }))

  return (
    <div ref={scrollBox.ref} style={{ ...bodyStyle, ...SCROLL_BOX_STYLE, ...scrollBox.style }}>
      <div style={columnStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <SectionTitle>一致性体检</SectionTitle>
          <span style={{ ...mono, fontSize: 12 }}>{loading ? '扫描中…' : auditHeadline(view)}</span>
          <span style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            <button
              type="button"
              style={ACTION_BUTTON_STYLE}
              disabled={exporting || loading || loadError !== null}
              title="把完整报告写成 Markdown 放进这本书的 .inkflow/audit/"
              onClick={() => void exportReport()}
            >
              <Icon name="export" size={13} />
              {exporting ? '导出中…' : exportLabel(view.exportPath)}
            </button>
            <button type="button" style={ACTION_BUTTON_STYLE} disabled={loading} onClick={() => void load()}>
              <Icon name="refresh" size={13} />
              {loading ? '读取中…' : '重新体检'}
            </button>
          </span>
        </div>

        <div style={{ ...muted, ...mono, fontSize: 11 }}>{AUDIT_SCOPE_NOTE}</div>
        {view.title === null ? null : (
          <div style={{ ...muted, ...mono, fontSize: 11 }}>
            《{view.title}》 · 耗时 {String(view.ms)} ms · 索引状态 {view.indexState === '' ? '未知' : view.indexState}
            （只读：体检不重建索引，也不写任何文件）
          </div>
        )}
        {view.counts.total === 0 ? null : <div style={{ ...muted, fontSize: 12 }}>{auditGroupLine(view)}</div>}

        {notice === null ? null : <div style={{ ...muted, fontSize: 12 }}>{notice}</div>}
        {error === null ? null : <NoteCard title="导出未完成" body={error} tone="error" />}
        {loadError === null ? null : <NoteCard title="体检读取失败" body={loadError} tone="error" />}

        {view.catalogStale ? (
          <NoteCard
            title="catalog 与正文不一致"
            body="卷章目录是正文的结构投影。它会在下一次写章时自动重建；现在就想要一致的话，让 AI 调 inkflow_index_rebuild。"
          />
        ) : null}

        {!loading && loadError === null && view.counts.total === 0 ? (
          <div style={{ ...muted, fontSize: 12 }}>五类检查都没有问题。写之前跑一次，写之后也跑一次，两次都是这句话就说明书是干净的。</div>
        ) : null}

        {grouped.map(({ group, items }) => (
          <div key={group} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <div style={{ fontWeight: 600 }}>{groupLabel(group)}</div>
              <div style={{ ...muted, fontSize: 12 }}>{String(view.counts.byGroup[group] ?? items.length)} 项</div>
            </div>
            {items.length === 0 ? (
              <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>无。</div>
            ) : (
              items.map((finding) => <FindingRow key={`${finding.group}:${finding.code}:${finding.address}:${finding.detail}`} finding={finding} onOpen={onOpen} />)
            )}
            {items.length < (view.counts.byGroup[group] ?? 0) ? (
              <div style={{ ...muted, fontSize: 11, marginTop: 4 }}>
                只显示了前 {String(items.length)} 项；完整清单在导出的 Markdown 里。
              </div>
            ) : null}
          </div>
        ))}

        {view.truncated ? (
          <div style={{ ...muted, fontSize: 11 }}>
            面板只拿到了前 {String(view.findings.length)} 项（共 {String(view.counts.total)} 项）：点上面的导出按钮拿全量报告。
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** The wire shape this page reads; typed loosely on purpose (the model narrows it). */
type AuditValueShape = Record<string, unknown>

function FindingRow({ finding, onOpen }: { finding: AuditFinding; onOpen?: (target: AuditJumpTarget) => void }) {
  const label = locateLabel(finding.locator)
  const target = jumpTargetOf(finding.locator)
  const jumpLabel = target === null ? null : target.kind === 'chapter' ? '打开本章' : `在设定库里打开`
  return (
    <div style={rowStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ ...mono, color: severityColor(finding.severity) }}>{finding.code}</span>
        <span style={{ ...muted, fontSize: 11 }}>{severityLabel(finding.severity)}</span>
        <span style={{ ...muted, fontSize: 11 }}>{codeLabel(finding.code) === finding.code ? '' : codeLabel(finding.code)}</span>
        {finding.fixable ? <span style={{ ...muted, fontSize: 11 }}>可自动修复</span> : null}
        {jumpLabel === null || onOpen === undefined || target === null ? null : (
          <span style={{ marginLeft: 'auto' }}>
            <button type="button" style={ACTION_BUTTON_STYLE} title="跳到这一项所在的位置" onClick={() => onOpen(target)}>
              <Icon name="locate" size={13} />
              {jumpLabel}
            </button>
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ ...mono, fontSize: 11, wordBreak: 'break-all' }}>{finding.address}</span>
        {label === null ? null : <span style={{ ...muted, fontSize: 11 }}>{label}</span>}
      </div>
      <div style={{ fontSize: 12 }}>{finding.detail}</div>
      <div style={{ ...muted, fontSize: 11 }}>怎么处理：{finding.hint}</div>
    </div>
  )
}
