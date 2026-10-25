/**
 * The candidate tab (#38, X-20): what the session model proposed, and the author's
 * decision on each one.
 *
 * The page is a queue, not an editor. Every row shows the four things a reviewer needs
 * to judge a proposal without opening a file — the kind, the fields, the evidence it was
 * read from, and why the model thought so — plus its confidence as a word. The evidence
 * is a button when it names a chapter: the workbench decides where that goes (this page
 * never guesses a route), which is why the callback is `onOpenEvidence` and not a link.
 *
 * Two actions, and they are deliberately not symmetric:
 *
 *   * **拒绝** is one click. It writes nothing but the status, so a wrong click costs
 *     nothing and the candidate stays in the queue as history.
 *   * **采纳** writes an entity file, so it is two clicks (an armed row, then
 *     `confirm: true`) — the panel's half of ADR-0017 D5, with the route's own
 *     `EXTRACT_CONFIRM_REQUIRED` as the net under it. A refusal keeps its domain code on
 *     screen (`CHARACTER_NAME_DUPLICATE`, `DUPLICATE_ID`, …): the author needs to know
 *     *why* the entity would collide, not that "something failed".
 *
 * The client half never touches the filesystem (ADR-0008 D4) and every request names a
 * session id plus a candidate id — never a directory.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { fetchInternal, writeInternal } from './internal.js'
import type { InternalResult } from './internal.js'
import { SCROLL_BOX_STYLE, SCROLL_COLUMN_STYLE } from './layout-model.js'
import { useScrollBox } from './layout.js'
import {
  CANDIDATE_STATUSES,
  EXTRACT_KINDS,
  STATUS_LABELS,
  actionableIds,
  asValueRecord,
  candidateTitle,
  confidenceLabel,
  describeCandidateError,
  describeCounts,
  describeEvidence,
  describeFields,
  describeOutcomeSummary,
  describeOutcomes,
  evidenceTarget,
  kindLabel,
  kindLabelOf,
  readCandidateList,
  skippedIds,
  statusLabel,
  toggleAll,
  toggleSelected,
  waitingCount,
  willFailLabel,
} from './extract-model.js'
import type { CandidateListValue, CandidateRow, EvidenceJump } from './extract-model.js'

// Same shape as the other pages: the height comes from the shared measurement (#116),
// the colours from the host theme (AGENTS.md §6). This module keeps its own small style
// set rather than importing `index.tsx`'s, which would make the two import each other.
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

const buttonStyle = {
  padding: '2px 10px',
  fontSize: 12,
  borderRadius: 6,
  cursor: 'pointer',
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
} as const

const armedButtonStyle = {
  ...buttonStyle,
  borderColor: 'var(--dsw-alias-state-warn-primary)',
  color: 'var(--dsw-alias-state-warn-primary)',
} as const

const dangerButtonStyle = {
  ...buttonStyle,
  borderColor: 'var(--dsw-alias-state-error-primary)',
  color: 'var(--dsw-alias-state-error-primary)',
} as const

const rowStyle = {
  display: 'grid',
  gap: 2,
  padding: '8px 0',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
} as const

const selectStyle = {
  padding: '2px 6px',
  fontSize: 12,
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
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

export function ExtractView({
  sessionId,
  onOpenEvidence,
}: {
  sessionId: string
  onOpenEvidence?: (jump: EvidenceJump) => void
}) {
  const [list, setList] = useState<InternalResult<CandidateListValue> | null>(null)
  const [loading, setLoading] = useState(true)
  const [kind, setKind] = useState('')
  const [status, setStatus] = useState('proposed')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  /** The row whose accept was armed by the first click. */
  const [pendingAcceptId, setPendingAcceptId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const scrollBox = useScrollBox()

  const query = useMemo(() => {
    const params = new URLSearchParams()
    if (kind !== '') params.set('kind', kind)
    if (status !== '') params.set('status', status)
    const text = params.toString()
    return text === '' ? '/candidates' : `/candidates?${text}`
  }, [kind, status])

  const load = useCallback(async () => {
    setLoading(true)
    const result = await fetchInternal<CandidateListValue>(query, { sessionId })
    setList(result)
    setLoading(false)
  }, [query, sessionId])

  useEffect(() => {
    void load()
  }, [load])

  const view = readCandidateList(list !== null && list.ok ? (list.value ?? undefined) : undefined)
  const loadError = list !== null && !list.ok ? describeCandidateError(list.error) : null

  const afterAction = useCallback(
    async (result: InternalResult<unknown>) => {
      const value = asValueRecord(result)
      const summary = describeOutcomeSummary(value)
      const outcome = describeOutcomes(value)
      const lines: string[] = []
      if (summary !== null) lines.push(summary)
      for (const entry of outcome.accepted) lines.push(`已写入 ${entry.path}`)
      for (const entry of outcome.refused) lines.push(`${entry.candidateId} 未写入：${entry.code} — ${entry.message}`)
      if (lines.length > 0) setNotice(lines.join(' · '))
      setPendingAcceptId(null)
      setSelected(new Set())
      await load()
    },
    [load],
  )

  const fail = (result: InternalResult<unknown>): boolean => {
    if (result.ok) return false
    setError(describeCandidateError(result.error))
    return true
  }

  const acceptOne = async (row: CandidateRow): Promise<void> => {
    if (pendingAcceptId !== row.candidateId) {
      // The first click only arms: writing an entity file must not happen on a stray press.
      setPendingAcceptId(row.candidateId)
      setNotice(`再点一次「确认采纳」才会写入：${candidateTitle(row)}`)
      setError(null)
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    const result = await writeInternal<unknown>('/candidates/accept', { candidateIds: [row.candidateId], confirm: true }, { sessionId })
    setBusy(false)
    if (fail(result)) return
    await afterAction(result)
  }

  const rejectOne = async (row: CandidateRow): Promise<void> => {
    setBusy(true)
    setError(null)
    setNotice(null)
    const result = await writeInternal<unknown>('/candidates/reject', { candidateIds: [row.candidateId] }, { sessionId })
    setBusy(false)
    if (fail(result)) return
    setPendingAcceptId(null)
    setNotice(`已拒绝 ${row.candidateId}；没有写入任何文件`)
    await load()
  }

  const acceptBatch = async (): Promise<void> => {
    const ids = actionableIds(view.rows, selected)
    if (ids.length === 0) return
    setBusy(true)
    setError(null)
    setNotice(null)
    const result = await writeInternal<unknown>('/candidates/accept', { candidateIds: ids, confirm: true }, { sessionId })
    setBusy(false)
    if (fail(result)) return
    await afterAction(result)
  }

  const rejectBatch = async (): Promise<void> => {
    const ids = actionableIds(view.rows, selected)
    if (ids.length === 0) return
    setBusy(true)
    setError(null)
    setNotice(null)
    const result = await writeInternal<unknown>('/candidates/reject', { candidateIds: ids }, { sessionId })
    setBusy(false)
    if (fail(result)) return
    setSelected(new Set())
    setNotice(`已拒绝 ${String(ids.length)} 条候选；没有写入任何文件`)
    await load()
  }

  const waiting = waitingCount(view.counts)

  return (
    <div ref={scrollBox.ref} style={{ ...bodyStyle, ...SCROLL_BOX_STYLE, ...scrollBox.style }}>
      <div style={columnStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <SectionTitle>候选</SectionTitle>
          <span style={{ ...muted, ...mono }}>{describeCounts(view.counts)}</span>
          <span style={{ ...muted, fontSize: 12 }}>{waiting === 0 ? '没有待审的候选' : `${String(waiting)} 条待审`}</span>
          <button type="button" style={{ ...buttonStyle, marginLeft: 'auto' }} disabled={loading} onClick={() => void load()}>
            {loading ? '读取中…' : '刷新'}
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label style={{ ...muted, fontSize: 12 }}>
            类型{' '}
            <select style={selectStyle} value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="">全部</option>
              {EXTRACT_KINDS.map((entry) => (
                <option key={entry} value={entry}>
                  {kindLabelOf(entry)}
                </option>
              ))}
            </select>
          </label>
          <label style={{ ...muted, fontSize: 12 }}>
            状态{' '}
            <select style={selectStyle} value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">全部</option>
              {CANDIDATE_STATUSES.map((entry) => (
                <option key={entry} value={entry}>
                  {STATUS_LABELS[entry] ?? entry}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            style={buttonStyle}
            disabled={loading || view.rows.filter((row) => row.status === 'proposed').length === 0}
            onClick={() => setSelected(toggleAll(view.rows, selected))}
            title="勾选本页所有待审候选"
          >
            全选待审
          </button>
          <button type="button" style={buttonStyle} disabled={busy || actionableIds(view.rows, selected).length === 0} onClick={() => void acceptBatch()}>
            批量采纳（{String(actionableIds(view.rows, selected).length)}）
          </button>
          {skippedIds(view.rows, selected).length === 0 ? null : (
            <span style={{ ...muted, fontSize: 12 }} title="这些候选的实体已存在，采纳会被拒；批量里已跳过，行内可看原因">
              已跳过 {String(skippedIds(view.rows, selected).length)} 条将失败的候选
            </span>
          )}
          <button
            type="button"
            style={dangerButtonStyle}
            disabled={busy || actionableIds(view.rows, selected).length === 0}
            onClick={() => void rejectBatch()}
          >
            批量拒绝
          </button>
        </div>

        {notice === null ? null : <div style={{ ...muted, fontSize: 12 }}>{notice}</div>}
        {error === null ? null : <NoteCard title="操作未完成" body={error} tone="error" />}
        {loadError === null ? null : <NoteCard title="候选读取失败" body={loadError} tone="error" />}
        {view.issues.length === 0 ? null : (
          <NoteCard title="有候选文件读不了" body={view.issues.map((issue) => `${issue.file}: ${issue.detail}`).join('；')} tone="error" />
        )}

        {!loading && loadError === null && view.total === 0 ? (
          <div style={{ ...muted, fontSize: 12 }}>
            这个筛选下没有候选。候选由会话里的模型提交（inkflow_extract_propose）：插件不自己跑模型，所以这里只等你点头。
          </div>
        ) : null}

        {view.rows.length === 0 ? null : (
          <div style={cardStyle}>
            {view.rows.map((row) => {
              const waitingRow = row.status === 'proposed'
              const armed = pendingAcceptId === row.candidateId
              const ticked = selected.has(row.candidateId)
              const jump = evidenceTarget(row)
              const facts = describeFields(row)
              const doomed = willFailLabel(row)
              return (
                <div key={row.candidateId} style={rowStyle}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <input
                      type="checkbox"
                      checked={ticked}
                      disabled={!waitingRow || doomed !== null}
                      title={
                        !waitingRow
                          ? '已处理的候选不能再批量操作'
                          : doomed === null
                            ? '选中以便批量处理'
                            : `${doomed}：批量会跳过这一条`
                      }
                      onChange={() => setSelected(toggleSelected(selected, row.candidateId))}
                    />
                    <span style={{ fontWeight: 600 }}>{candidateTitle(row)}</span>
                    <span style={{ ...muted, fontSize: 12 }}>{kindLabel(row)}</span>
                    <span style={{ ...muted, fontSize: 12 }}>置信 {confidenceLabel(row)}</span>
                    <span style={{ ...muted, fontSize: 12 }}>{statusLabel(row)}</span>
                    {doomed === null ? null : (
                      <span style={{ fontSize: 12, color: 'var(--dsw-alias-state-warning-primary)' }} title={row.willFail?.message ?? ''}>
                        {doomed}
                      </span>
                    )}
                    <span style={{ ...muted, ...mono, fontSize: 11 }}>{row.candidateId}</span>
                    <span style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                      <button
                        type="button"
                        style={armed ? armedButtonStyle : buttonStyle}
                        disabled={busy || !waitingRow}
                        title={armed ? '再点一次确认：会写入实体文件' : '需要点两次才写入'}
                        onClick={() => void acceptOne(row)}
                      >
                        {armed ? '确认采纳' : '采纳'}
                      </button>
                      <button
                        type="button"
                        style={dangerButtonStyle}
                        disabled={busy || !waitingRow}
                        title="拒绝不改任何实体文件，只把这条候选标记为已拒绝"
                        onClick={() => void rejectOne(row)}
                      >
                        拒绝
                      </button>
                    </span>
                  </div>
                  {facts === '' ? null : <div style={{ ...mono, fontSize: 12 }}>{facts}</div>}
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ ...muted, fontSize: 11 }}>证据：{describeEvidence(row)}</span>
                    {jump === null || onOpenEvidence === undefined ? null : (
                      <button type="button" style={{ ...buttonStyle, padding: '0 8px', fontSize: 11 }} onClick={() => onOpenEvidence(jump)}>
                        跳到原文
                      </button>
                    )}
                  </div>
                  {row.rationale === '' ? null : <div style={{ ...muted, fontSize: 12 }}>{row.rationale}</div>}
                  <div style={{ ...muted, ...mono, fontSize: 10 }}>
                    {row.file}
                    {row.submittedAt === '' ? '' : ` · ${row.submittedAt}`}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {view.truncated ? <div style={{ ...muted, fontSize: 12 }}>还有更多候选没有显示（本页 {String(view.rows.length)} / 共 {String(view.total)}）：换筛选条件或先处理本页。</div> : null}
      </div>
    </div>
  )
}
