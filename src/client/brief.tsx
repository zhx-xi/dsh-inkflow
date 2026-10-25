/**
 * The brief page (#43, ADR-0022 D1/D2, roadmap X-23/X-25): nine segments, what each one
 * cost, what the ladder dropped, and the text they add up to.
 *
 * WHY THE PAGE SHOWS THE RENDERED TEXT: the whole point of a preview is that it is the
 * same computation the model's context comes from (`buildWritingBrief`, one input). A page
 * that showed only sizes would be a report *about* the briefing; showing the block is the
 * only way an author can answer "did it paste my outline twice?" without asking a model.
 *
 * WHAT IT DOES NOT DO: it does not re-derive the order, the caps or the trim ladder. Those
 * arrive decided (`GET /inkflow/internal/brief`), and the policy lives in `brief-model.ts`
 * so it is testable without a DOM. The one action it offers is the audit write, and it
 * sends `confirm: true` because that is a write under `.inkflow/audit/`.
 *
 * The client half never touches the filesystem (ADR-0008 D4): everything comes from the
 * private channel, and the request carries a session id and nothing else.
 */

import { useCallback, useEffect, useState } from 'react'

import { fetchInternal, writeInternal } from './internal.js'
import type { InternalResult } from './internal.js'
import { EMPTY_BRIEF, readBrief } from './brief-model.js'
import type { BriefSegmentRow, BriefValue, BriefView } from './brief-model.js'
import { SCROLL_BOX_STYLE, SCROLL_COLUMN_STYLE } from './layout-model.js'
import { useScrollBox } from './layout.js'

// Every visible colour comes from the host theme (`--dsw-alias-*`); the panel keeps its
// own small style set rather than importing `index.tsx`'s, which would make the two
// modules import each other.
const panelStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
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

const buttonStyle = {
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  padding: '2px 8px',
  cursor: 'pointer',
  fontSize: 12,
} as const

const segmentRowStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(96px, 1fr) 64px 64px 72px minmax(140px, 2fr)',
  gap: 8,
  alignItems: 'baseline',
  padding: '4px 0',
  borderTop: '1px solid var(--dsw-alias-border-l1)',
} as const

/** The state badge: three states, three readings — present / trimmed / no source. */
function StateBadge({ row }: { row: BriefSegmentRow }) {
  const tone =
    row.state === 'missing'
      ? { color: 'var(--dsw-alias-label-secondary)', borderColor: 'var(--dsw-alias-border-l2)' }
      : row.state === 'trimmed'
        ? { color: 'var(--dsw-alias-state-warning-primary)', borderColor: 'var(--dsw-alias-state-warning-primary)' }
        : { color: 'var(--dsw-alias-state-success-primary)', borderColor: 'var(--dsw-alias-state-success-primary)' }
  const label = row.state === 'missing' ? '无来源' : row.state === 'trimmed' ? '被裁' : '完整'
  return (
    <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 999, border: '1px solid', ...tone }}>{label}</span>
  )
}

export function BriefView({ sessionId }: { sessionId: string }) {
  const [view, setView] = useState<BriefView>(EMPTY_BRIEF)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const scrollBox = useScrollBox()

  const refresh = useCallback(async () => {
    setLoading(true)
    const result = await fetchInternal<BriefValue>('/brief', { sessionId })
    setView(readBrief(result))
    setLoading(false)
  }, [sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  /** Record this exact brief into `.inkflow/audit/brief-<chapterId>.json`. */
  const recordAudit = useCallback(async () => {
    setSaving(true)
    const written = await writeInternal<{ chapterId?: string; written?: { path?: string; bytes?: number; sha256?: string } }>(
      '/brief/audit',
      { confirm: true },
      { sessionId },
    )
    setSaving(false)
    if (!written.ok) {
      setNotice(`写入失败：${written.error?.code ?? 'REQUEST_FAILED'}`)
      return
    }
    const path = written.value?.written?.path ?? '（路径未返回）'
    const bytes = written.value?.written?.bytes
    const sha = written.value?.written?.sha256 ?? ''
    setNotice(`已落盘 ${path}${bytes === undefined ? '' : ` · ${String(bytes)} 字节`}${sha === '' ? '' : ` · sha256 ${sha.slice(0, 12)}…`}`)
  }, [sessionId])

  const header = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>简报</span>
      <span style={{ ...muted, ...mono }}>
        {view.chapterPath === null ? '当前章未知' : view.chapterPath}
        {view.chapterSeq === null ? '' : ` · 第 ${String(view.chapterSeq)} 章`}
      </span>
      <span style={{ ...muted, ...mono }}>
        {loading ? '读取中…' : `${String(view.tokens)} / ${String(view.budgetTokens)} tokens${view.overBudget ? '（超预算）' : ''}`}
      </span>
      <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8 }}>
        <button type="button" style={buttonStyle} onClick={() => void refresh()} disabled={loading}>
          重新读取
        </button>
        <button type="button" style={buttonStyle} onClick={() => void recordAudit()} disabled={saving || view.rows.length === 0}>
          {saving ? '写入中…' : '落盘审计'}
        </button>
      </span>
    </div>
  )

  return (
    <div ref={scrollBox.ref} style={{ ...panelStyle, ...SCROLL_BOX_STYLE, ...scrollBox.style }}>
      {header}

      {notice === null ? null : (
        <div style={{ ...cardStyle, ...muted, fontSize: 12 }}>{notice}</div>
      )}

      {view.error === null ? null : (
        <div style={{ ...cardStyle, borderStyle: 'dashed', borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' }}>
          {view.error}
        </div>
      )}

      {view.rows.length === 0 ? null : (
        <div style={cardStyle}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>九段</span>
            <span style={{ ...muted, fontSize: 11 }}>
              顺序固定（outline → promise → characters → voice → facts → foreshadow → world → prevTail → anchors）
            </span>
          </div>
          <div style={{ ...segmentRowStyle, ...muted, fontSize: 11 }}>
            <span>段</span>
            <span>tokens</span>
            <span>占比</span>
            <span>状态</span>
            <span>说明</span>
          </div>
          {view.rows.map((row) => (
            <div key={row.id} style={segmentRowStyle}>
              <span style={{ fontSize: 12 }}>
                {row.label} <span style={{ ...muted, ...mono }}>{row.id}</span>
              </span>
              <span style={{ ...mono }}>{String(row.tokens)}</span>
              <span style={{ ...mono }}>{row.share}</span>
              <span>
                <StateBadge row={row} />
              </span>
              <span style={{ ...muted, fontSize: 12 }}>{row.detail}</span>
            </div>
          ))}
        </div>
      )}

      {view.trims.length === 0 ? null : (
        <div style={cardStyle}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>裁剪记录</div>
          {view.trims.map((trim, index) => (
            <div key={`${trim.segment}-${String(index)}`} style={{ ...mono, ...muted, fontSize: 12 }}>
              {trim.label}（{trim.segment}）：{String(trim.before)} → {String(trim.after)} tokens · {trim.share}
            </div>
          ))}
        </div>
      )}

      {view.text === '' ? null : (
        <div style={cardStyle}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>注入文本</span>
            <span style={{ ...muted, fontSize: 11 }}>
              与审计同一次计算{view.auditPath === null ? '' : ` · 审计落点 ${view.auditPath}`}
              {view.indexRebuilt ? ' · 索引已重建' : ''}
            </span>
          </div>
          <pre style={{ ...mono, whiteSpace: 'pre-wrap', margin: 0, marginTop: 6 }}>{view.text}</pre>
        </div>
      )}
    </div>
  )
}

/** The channel result the audit write returns, for callers that keep it around. */
export type BriefAuditResult = InternalResult<{ chapterId?: string; written?: { path?: string } }>
