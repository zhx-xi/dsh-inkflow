/**
 * The 批量 page (roadmap X-12/X-30): one batch job, its chapters, and the one button.
 *
 * What the author needs to see, in this order:
 *
 *   1. **作业状态** — running / paused / done / failed, plus the caps it runs under (concurrency,
 *      batch size) and how many chapters are in flight right now.
 *   2. **每章状态** — one row per chapter with the status sentence, the attempts, where the file
 *      landed, and, when the gate ran, its counts.
 *   3. **门禁结论摘要** — per chapter: the seven checks' counts and the first few findings, so
 *      "why did it stop" is answerable without opening a JSON file.
 *   4. **暂停原因 + 续跑** — the reason, and the button. It is disabled when resuming would either
 *      do nothing or skip the gate, with the sentence that says so.
 *
 * Read-only apart from 续跑 (`POST /batch/resume`), which writes only the job records: drafting
 * and approving are session actions (`inkflow_batch_take` / `_complete` / `_approve`), because
 * approving prose is the author's decision told to the model, not a click that writes a chapter.
 *
 * Every hook sits before the first possible `return` (AGENTS.md §8 trap 2b) — this page has no
 * early return at all, which is the cheapest way to keep that true as it grows.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  EMPTY_BATCH_NOTE,
  batchPanelState,
  describeChapter,
  describeGate,
  describeJobRow,
  describeJobStatus,
  describePause,
  readBatchPage,
  resumeBlockedReason,
  resumePayload,
} from './batch-model.js'
import type { BatchJobView, BatchPageView } from './batch-model.js'
import { fetchInternal, writeInternal } from './internal.js'
import type { InternalResult } from './internal.js'
import { SCROLL_BOX_STYLE, SCROLL_COLUMN_STYLE } from './layout-model.js'
import { useScrollBox } from './layout.js'

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

const rowStyle = {
  display: 'grid',
  gap: 3,
  padding: '8px 0',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
} as const

/** One chapter status's tone, from the host theme (never a literal colour). */
function statusColor(status: string): string {
  if (status === 'failed') return 'var(--dsw-alias-state-error-primary)'
  if (status === 'held' || status === 'paused') return 'var(--dsw-alias-state-warning-primary)'
  if (status === 'done') return 'var(--dsw-alias-state-success-primary)'
  return 'var(--dsw-alias-label-secondary)'
}

function describeTransport(page: BatchPageView): string | null {
  if (page.transport === null) return null
  if (page.transport === 'NO_SESSION_CONTEXT') return '这个面板还没挂到会话上：从小说会话里打开 InkFlow 面板。'
  if (page.transport === 'NETWORK') return '读不到作业：本地通道没有回应。'
  return `读不到作业：${page.transport}`
}

export interface BatchViewProps {
  /** The session this panel is attached to; the Host resolves the book from it. */
  readonly sessionId: string
}

export function BatchView({ sessionId }: BatchViewProps) {
  const [page, setPage] = useState<BatchPageView | null>(null)
  const [selectedId, setSelectedId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const scrollBox = useScrollBox()

  const load = useCallback(async () => {
    setLoading(true)
    const query = selectedId === '' ? '' : `?jobId=${encodeURIComponent(selectedId)}`
    const result = await fetchInternal<Record<string, unknown>>(`/batch${query}`, { sessionId })
    setPage(readBatchPage(result))
    setLoading(false)
  }, [sessionId, selectedId])

  useEffect(() => {
    void load()
  }, [load])

  const view: BatchPageView | null = page
  const state = useMemo(() => (view === null ? 'empty' : batchPanelState(view)), [view])
  const job: BatchJobView | null = view === null ? null : view.selected
  const pause = useMemo(() => (job === null ? null : describePause(job)), [job])
  const blocked = useMemo(() => (job === null ? null : resumeBlockedReason(job)), [job])

  /** 续跑: the one write this page performs (job records only, no prose). */
  const resume = useCallback(async () => {
    if (job === null) return
    setBusy(true)
    const result = await writeInternal<Record<string, unknown>>('/batch/resume', resumePayload(job.jobId), { sessionId })
    if (!result.ok) {
      const error = result.error
      setActionError(
        `续跑没有成功：${error?.message === undefined ? 'unknown' : error.message}` +
          (error?.hint === undefined ? '' : `（${error.hint}）`),
      )
      setBusy(false)
      return
    }
    setActionError(null)
    setBusy(false)
    await load()
  }, [job, load, sessionId])

  const transportNote = view === null ? null : describeTransport(view)

  return (
    <div ref={scrollBox.ref} style={{ ...bodyStyle, ...SCROLL_BOX_STYLE, ...scrollBox.style }}>
      <div style={columnStyle}>
        {view === null && loading ? <p style={muted}>正在读批量作业…</p> : null}
        {transportNote !== null ? <p style={{ ...muted, ...cardStyle }}>{transportNote}</p> : null}
        {view !== null && view.error !== null ? (
          <p style={{ ...muted, ...cardStyle }}>
            读不到这个作业：{view.error.message}
            {view.error.hint === undefined ? '' : `（${view.error.hint}）`}
          </p>
        ) : null}

        {view !== null && view.jobs.length > 0 ? (
          <div style={cardStyle}>
            <div style={{ ...muted, marginBottom: 4 }}>全书作业</div>
            <select
              value={selectedId === '' ? (job === null ? '' : job.jobId) : selectedId}
              onChange={(event) => {
                setSelectedId(event.target.value)
              }}
              style={{ ...mono, padding: '2px 6px', borderRadius: 6 }}
            >
              {view.jobs.map((row) => (
                <option key={row.jobId} value={row.jobId}>
                  {describeJobRow(row)}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {state === 'empty' ? <p style={{ ...muted, ...cardStyle }}>{EMPTY_BATCH_NOTE}</p> : null}

        {job !== null ? (
          <div style={cardStyle}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <strong>{job.jobId}</strong>
              <span style={{ ...muted, color: statusColor(job.status) }}>{describeJobStatus(job.status)}</span>
              <span style={muted}>
                并发 {job.concurrency} · 每批 {job.batchSize} · 在写 {job.inFlight} · 待领取 {job.remaining}
              </span>
            </div>
            <div style={{ ...muted, ...mono, marginTop: 4 }}>{job.dir}</div>
            <div style={{ ...muted, marginTop: 4 }}>
              共 {job.counts.total} 章：待写 {job.counts.pending} · 领取中 {job.counts.running} · 待批准{' '}
              {job.counts.held} · 已落盘 {job.counts.done} · 失败 {job.counts.failed}
              {job.counts.edited > 0 ? ` · 作者改过 ${job.counts.edited}` : ''}
            </div>
            {pause !== null ? <div style={{ color: 'var(--dsw-alias-state-warning-primary)', marginTop: 6 }}>{pause}</div> : null}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <button type="button" style={buttonStyle} disabled={busy || blocked !== null} onClick={() => void resume()}>
                {busy ? '续跑中…' : '续跑'}
              </button>
              {blocked !== null ? <span style={muted}>{blocked}</span> : null}
            </div>
            {actionError !== null ? (
              <div style={{ color: 'var(--dsw-alias-state-error-primary)', marginTop: 6 }}>{actionError}</div>
            ) : null}
          </div>
        ) : null}

        {job !== null && job.chapters.length > 0 ? (
          <div style={cardStyle}>
            <div style={{ ...muted, marginBottom: 4 }}>每章状态与门禁结论</div>
            {job.chapters.map((chapter) => {
              const gateLine = describeGate(chapter.gate)
              return (
                <div key={chapter.seq} style={rowStyle}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={{ color: statusColor(chapter.status) }}>{describeChapter(chapter)}</span>
                    {chapter.hasDraft ? <span style={muted}>· 草稿已存，等批准</span> : null}
                  </div>
                  {gateLine !== null ? <div style={muted}>{gateLine}</div> : null}
                  {chapter.gate !== null && chapter.gate.checks.length > 0 ? (
                    <div style={{ ...muted, ...mono }}>
                      {chapter.gate.checks.map((check) => `${check.label} ${check.count}`).join(' · ')}
                    </div>
                  ) : null}
                  {chapter.gate !== null
                    ? chapter.gate.findings.slice(0, 3).map((finding, index) => (
                        <div key={`${chapter.seq}-${String(index)}`} style={muted}>
                          · [{finding.check}/{finding.severity}] {finding.detail}
                        </div>
                      ))
                    : null}
                  {chapter.gate !== null && chapter.gate.truncated ? (
                    <div style={muted}>…还有更多项，看作业记录里的 chapters/{chapter.seq}.json</div>
                  ) : null}
                  {chapter.lastError !== null ? (
                    <div style={{ color: 'var(--dsw-alias-state-error-primary)' }}>
                      {chapter.lastError.code}：{chapter.lastError.message}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        ) : null}

        {job !== null ? (
          <p style={muted}>
            起草与批准走会话里的工具：inkflow_batch_take 领取、inkflow_batch_complete 交回、inkflow_batch_approve 批准。
            这个页面只读（外加一个续跑），不会不经批准就写正文。
          </p>
        ) : null}
      </div>
    </div>
  )
}
