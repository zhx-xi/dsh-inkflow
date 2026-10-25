/**
 * The 提案 tab (#45, roadmap X-12): one proposal, its line hunks, and the three actions
 * that may follow — accept/reject per hunk, apply, roll back.
 *
 * What the page is responsible for: showing the author what would change, in lines, with
 * the hunk numbers the tools address. What it is **not**: judging the diff. The Host sends
 * each hunk with its own `baseLines`/`nextLines` and its verdict state, and this file
 * prints them — a second diff implementation in the browser would be a second answer to
 * "what will be written" (`proposal-model.ts` says the same thing from the other side).
 *
 * Two deliberate couplings:
 *
 *   1. **Applying and rolling back are two-step**: the first click arms, the second one
 *      sends `confirm: true`. Both rewrite a chapter file, and a single mis-click that
 *      rewrites prose is the one mistake this feature exists to prevent.
 *   2. **A pending hunk blocks apply, visibly.** The button is disabled with the reason
 *      printed next to it (the Host refuses the same case with `PROPOSAL_PENDING_HUNKS`) —
 *      an undecided hunk is not a "no", so silently treating it as one would drop a change
 *      the author never saw.
 *
 * Every hook sits before the first possible `return` — the page has no early return at all
 * (AGENTS.md §8 陷阱 2b: a hook after an early return blanks the whole panel).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { fetchInternal, writeInternal } from './internal.js'
import type { InternalResult } from './internal.js'
import { SCROLL_COLUMN_STYLE } from './layout-model.js'
import { useScrollBox } from './layout.js'
import {
  PROPOSAL_NOTE,
  applyActionLabel,
  applyBlocked,
  cleanable,
  confirmPayload,
  decidePayload,
  describeClosedGroup,
  describeCounts,
  describeHunk,
  describeOutcome,
  describeProposalStatus,
  describeTotals,
  detailRequestPath,
  pendingDecisions,
  preferredProposalId,
  readProposalPage,
  rollbackActionLabel,
  rollbackBlocked,
  splitProposals,
} from './proposal-model.js'
import type { Decision, HunkRow, ProposalPage, ProposalRow } from './proposal-model.js'
import {
  PURGED_PATH,
  PURGE_CLEAN_PATH,
  PURGE_RESTORE_PATH,
  cleanActionLabel,
  cleanPayload,
  describePurgedError,
  describePurgedFailure,
  purgedFor,
  readPurgedValue,
  restorePayload,
} from './purge-model.js'
import { PurgeCard } from './purge-card.js'
import { ClosedProposalGroup, ProposalListItem } from './proposal-closed.js'

const bodyStyle = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.4fr)', gap: 10, minHeight: 0 } as const

const columnStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '0 2px',
  ...SCROLL_COLUMN_STYLE,
} as const

const cardStyle = {
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 8,
  padding: '8px 10px',
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

const disabledButtonStyle = {
  ...buttonStyle,
  cursor: 'not-allowed',
  color: 'var(--dsw-alias-label-secondary)',
  opacity: 0.6,
} as const

const rowButtonStyle = {
  ...buttonStyle,
  padding: '1px 8px',
  fontSize: 11,
} as const

const selectButtonStyle = {
  ...buttonStyle,
  textAlign: 'left',
  display: 'block',
  width: '100%',
  padding: '6px 8px',
} as const

const activeSelectStyle = {
  ...selectButtonStyle,
  borderColor: 'var(--dsw-alias-brand-primary)',
  background: 'var(--dsw-alias-bg-layer-2)',
} as const

const addedStyle = { color: 'var(--dsw-alias-state-success-primary)' } as const
const removedStyle = { color: 'var(--dsw-alias-state-error-primary)' } as const

const preStyle = {
  ...mono,
  margin: 0,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
} as const

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The bits of a `POST /proposal/apply` answer the page prints back. */
interface ApplyOk {
  readonly applied?: readonly unknown[]
  readonly backup?: string
}

/** The bits of a `POST /proposal/rollback` answer the page prints back. */
interface RollbackOk {
  readonly verified?: boolean
  readonly backup?: string
}

/** One hunk: the address, the removed lines, the added lines, and the two verdict buttons. */
function HunkCard(props: {
  readonly hunk: HunkRow
  readonly busy: boolean
  readonly onDecide: (decision: Decision) => void
}) {
  const { hunk, busy, onDecide } = props
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ ...mono, fontWeight: 600 }}>#{String(hunk.index)}</span>
        <span>{describeHunk(hunk)}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          <button
            type="button"
            disabled={busy}
            style={busy ? disabledButtonStyle : rowButtonStyle}
            onClick={() => onDecide({ index: hunk.index, status: 'accepted' })}
          >
            接受
          </button>
          <button
            type="button"
            disabled={busy}
            style={busy ? disabledButtonStyle : rowButtonStyle}
            onClick={() => onDecide({ index: hunk.index, status: 'rejected' })}
          >
            拒绝
          </button>
        </span>
      </div>
      {hunk.baseLines.length === 0 ? null : (
        <pre style={preStyle}>
          {hunk.baseLines.map((line, index) => (
            <div key={`base-${String(index)}`} style={removedStyle}>
              {`- ${line}`}
            </div>
          ))}
        </pre>
      )}
      {hunk.nextLines.length === 0 ? null : (
        <pre style={preStyle}>
          {hunk.nextLines.map((line, index) => (
            <div key={`next-${String(index)}`} style={addedStyle}>
              {`+ ${line}`}
            </div>
          ))}
        </pre>
      )}
    </div>
  )
}

export interface ProposalViewProps {
  /** The session this panel is attached to; the Host resolves the book from it. */
  readonly sessionId: string
}

export function ProposalView({ sessionId }: ProposalViewProps) {
  const [listResult, setListResult] = useState<InternalResult<unknown> | null>(null)
  const [detailResult, setDetailResult] = useState<InternalResult<unknown> | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  /** Which destructive action is armed; the second click sends `confirm: true`. */
  const [armed, setArmed] = useState<'apply' | 'rollback' | null>(null)
  /** #199: the finished proposals' fold, the cleanup being confirmed, and the purge area. */
  const [closedOpen, setClosedOpen] = useState(false)
  const [armedClean, setArmedClean] = useState<string | null>(null)
  const [purgedResult, setPurgedResult] = useState<InternalResult<unknown> | null>(null)
  const [message, setMessage] = useState('')
  const scrollBox = useScrollBox()

  const list = useMemo(() => readProposalPage(listResult, false), [listResult])
  const detailed = useMemo(() => readProposalPage(detailResult, true), [detailResult])
  const page: ProposalPage = useMemo(
    () => ({ ...list, detail: detailed.detail }),
    [list, detailed.detail],
  )
  const detail = page.detail
  const pending = detail?.hunks.filter((hunk) => hunk.status === 'pending') ?? []
  const applyReason = detail === null ? '先选一个提案' : applyBlocked(detail.counts, detail.status)
  const rollbackReason = detail === null ? '先选一个提案' : rollbackBlocked(detail.status)

  // The list, and the first selection. A refresh keeps the current selection when that
  // proposal still exists — a decide must not jump the author to another proposal.
  useEffect(() => {
    let live = true
    void (async () => {
      const result = await fetchInternal<unknown>('/proposal', { sessionId })
      if (!live) return
      setListResult(result)
      const next = readProposalPage(result, false)
      setSelected((current) => {
        if (current !== null && next.rows.some((row) => row.proposalId === current)) return current
        return preferredProposalId(next)
      })
    })()
    return () => {
      live = false
    }
  }, [sessionId, reload])

  // One proposal's hunks. Keyed by id, so switching proposals never shows the previous
  // proposal's diff while the new one is loading.
  useEffect(() => {
    if (selected === null) {
      setDetailResult(null)
      return
    }
    let live = true
    void (async () => {
      const result = await fetchInternal<unknown>(detailRequestPath(selected), { sessionId })
      if (!live) return
      setDetailResult(result)
    })()
    return () => {
      live = false
    }
  }, [sessionId, selected, reload])

  const refresh = useCallback(() => {
    setReload((value) => value + 1)
  }, [])

  /** Send one verdict set and reload both projections (the list's counts move too). */
  const decide = useCallback(
    async (decisions: readonly Decision[]) => {
      if (selected === null || decisions.length === 0) return
      setBusy(true)
      const result = await writeInternal<unknown>('/proposal/decide', decidePayload(selected, decisions), { sessionId })
      setMessage(
        result.ok ? '决定已记录（正文未改动）。' : describeOutcome('decide', { ok: false, error: result.error }, ''),
      )
      setBusy(false)
      setArmed(null)
      refresh()
    },
    [selected, sessionId, refresh],
  )

  const apply = useCallback(async () => {
    if (selected === null) return
    setBusy(true)
    const result = await writeInternal<ApplyOk>('/proposal/apply', confirmPayload(selected), { sessionId })
    const applied = result.value?.applied
    const accepted = Array.isArray(applied) ? applied.length : 0
    setMessage(
      result.ok
        ? `已写入正文：接受 ${String(accepted)} 段，备份包 ${str(result.value?.backup)}`
        : describeOutcome('apply', { ok: false, error: result.error }, ''),
    )
    setBusy(false)
    setArmed(null)
    refresh()
  }, [selected, sessionId, refresh])

  const rollback = useCallback(async () => {
    if (selected === null) return
    setBusy(true)
    const result = await writeInternal<RollbackOk>('/proposal/rollback', confirmPayload(selected), { sessionId })
    setMessage(
      result.ok
        ? result.value?.verified === true
          ? '已回滚：章节逐字节还原到应用之前。'
          : '已回滚，但字节校验未通过：核对备份包里的副本。'
        : describeOutcome('rollback', { ok: false, error: result.error }, ''),
    )
    setBusy(false)
    setArmed(null)
    refresh()
  }, [selected, sessionId, refresh])

  // The purge area (#199). Read on every refresh, so a cleanup or a restore is reflected
  // without the author having to guess whether it worked.
  useEffect(() => {
    let live = true
    void (async () => {
      const result = await fetchInternal<unknown>(PURGED_PATH, { sessionId })
      if (!live) return
      setPurgedResult(result)
    })()
    return () => {
      live = false
    }
  }, [sessionId, reload])

  /** Move one finished proposal into the area (the second click is what sends `confirm: true`). */
  const clean = useCallback(
    async (proposalId: string) => {
      setBusy(true)
      const result = await writeInternal<unknown>(PURGE_CLEAN_PATH, cleanPayload('proposal', proposalId), { sessionId })
      setMessage(result.ok ? '已搬进回收区（.inkflow/purged/）：可以还原，章节字节没动。' : describePurgedFailure(result))
      setBusy(false)
      setArmedClean(null)
      refresh()
    },
    [sessionId, refresh],
  )

  const restore = useCallback(
    async (id: string) => {
      setBusy(true)
      const result = await writeInternal<unknown>(PURGE_RESTORE_PATH, restorePayload(id), { sessionId })
      setMessage(result.ok ? '已从回收区还原到原路径。' : describePurgedFailure(result))
      setBusy(false)
      refresh()
    },
    [sessionId, refresh],
  )

  const onApplyClick = useCallback(() => {
    if (applyReason !== null) return
    if (armed === 'apply') {
      void apply()
      return
    }
    setArmed('apply')
    setMessage('再点一次「确认写入」才会改正文。')
  }, [applyReason, armed, apply])

  const onRollbackClick = useCallback(() => {
    if (rollbackReason !== null) return
    if (armed === 'rollback') {
      void rollback()
      return
    }
    setArmed('rollback')
    setMessage('再点一次「确认回滚」才会动文件。')
  }, [rollbackReason, armed, rollback])

  const phaseMessage =
    page.phase === 'failed'
      ? (page.error ?? '提案读取失败')
      : page.phase === 'unreadable'
        ? (page.error ?? '提案答案读不懂')
        : null

  // #199: the first screen shows what still needs a decision; finished proposals fold away and
  // are the only cleanable ones. `split` is also what `describeTotals` counts, so the header and
  // the column cannot disagree.
  const split = useMemo(() => splitProposals(page), [page])
  const purgedView = useMemo(() => readPurgedValue(purgedResult?.ok === true ? purgedResult.value : undefined), [purgedResult])
  const purgedProposals = useMemo(() => purgedFor(purgedView, 'proposal'), [purgedView])
  const purgedError = describePurgedError(purgedResult)

  const onCleanClick = useCallback(
    (proposalId: string) => {
      if (armedClean === proposalId) {
        void clean(proposalId)
        return
      }
      setArmedClean(proposalId)
      setMessage('再点一次「确认清理」才会把它搬进回收区（可还原）。')
    },
    [armedClean, clean],
  )

  return (
    <div style={scrollBox.style}>
      <div style={bodyStyle}>
        <div style={columnStyle}>
          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <strong>提案</strong>
              <span style={muted}>{describeTotals(page)}</span>
              <button type="button" style={rowButtonStyle} onClick={refresh}>
                刷新
              </button>
            </div>
            <div style={{ ...muted, marginTop: 4 }}>{PROPOSAL_NOTE}</div>
          </div>
          {page.rows.length === 0 ? (
            <div style={cardStyle}>
              <div>这本书还没有提案。</div>
              <div style={{ ...muted, marginTop: 4 }}>
                提案由会话里的模型写成正文草稿后存下来：对 AI 说「把第 3 章改一遍」，它会调用 inkflow_proposal_create。
              </div>
            </div>
          ) : split.open.length === 0 ? (
            <div style={cardStyle}>
              <div>没有待决定的提案。</div>
              <div style={{ ...muted, marginTop: 4 }}>已应用/已回滚的提案都在下面的「{describeClosedGroup(split)}」里，可逐条查看或清理。</div>
            </div>
          ) : (
            split.open.map((row) => (
              <ProposalListItem
                key={row.proposalId}
                row={row}
                active={row.proposalId === selected}
                onSelect={() => {
                  setSelected(row.proposalId)
                  setArmed(null)
                  setMessage('')
                }}
              />
            ))
          )}
          {split.closedCount === 0 ? null : (
            <ClosedProposalGroup
              split={split}
              open={closedOpen}
              selected={selected}
              armedClean={armedClean}
              busy={busy}
              onToggle={() => setClosedOpen(!closedOpen)}
              onSelect={(proposalId) => {
                setSelected(proposalId)
                setArmed(null)
                setMessage('')
              }}
              onClean={onCleanClick}
            />
          )}
          <PurgeCard
            title="已清理的提案"
            entries={purgedProposals}
            error={purgedError}
            busy={busy}
            note="清理掉的提案不占首屏，但没删：还原后它会重新出现在「已结束」组里。"
            onRestore={(id) => {
              void restore(id)
            }}
          />
        </div>
        <div style={columnStyle}>
          {phaseMessage === null ? null : <div style={cardStyle}>{phaseMessage}</div>}
          {message === '' ? null : (
            <div style={cardStyle}>
              <span>{message}</span>
            </div>
          )}
          {detail === null ? (
            <div style={cardStyle}>
              <div>{page.rows.length === 0 ? '没有可展开的提案。' : '选左边一个提案看逐段差异。'}</div>
            </div>
          ) : (
            <>
              <div style={cardStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <strong>{detail.title === '' ? detail.path : detail.title}</strong>
                  <span style={mono}>{detail.proposalId}</span>
                  <span>{describeProposalStatus(detail.status)}</span>
                </div>
                <div style={{ ...muted, marginTop: 4 }}>{describeCounts(detail.counts)}</div>
                <div style={{ ...muted, ...mono, marginTop: 2 }}>
                  {detail.path} · 正文 {String(detail.baseLines)} 行 · 行尾 {detail.eol}
                  {detail.bom ? ' · 带 BOM' : ''}
                  {detail.baseline === null ? '' : ` · 基线 ${detail.baseline.slice(0, 12)}…`}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    disabled={busy || pending.length === 0}
                    style={busy || pending.length === 0 ? disabledButtonStyle : buttonStyle}
                    onClick={() => void decide(pendingDecisions(detail.hunks, 'accepted'))}
                  >
                    全部接受（{String(pending.length)}）
                  </button>
                  <button
                    type="button"
                    disabled={busy || pending.length === 0}
                    style={busy || pending.length === 0 ? disabledButtonStyle : buttonStyle}
                    onClick={() => void decide(pendingDecisions(detail.hunks, 'rejected'))}
                  >
                    全部拒绝
                  </button>
                  <button
                    type="button"
                    disabled={busy || applyReason !== null}
                    style={busy || applyReason !== null ? disabledButtonStyle : buttonStyle}
                    onClick={onApplyClick}
                  >
                    {applyActionLabel(armed === 'apply')}
                  </button>
                  <button
                    type="button"
                    disabled={busy || rollbackReason !== null}
                    style={busy || rollbackReason !== null ? disabledButtonStyle : buttonStyle}
                    onClick={onRollbackClick}
                  >
                    {rollbackActionLabel(armed === 'rollback')}
                  </button>
                </div>
                {applyReason === null ? null : <div style={{ ...muted, marginTop: 4 }}>应用：{applyReason}</div>}
                {rollbackReason === null ? null : <div style={{ ...muted, marginTop: 2 }}>回滚：{rollbackReason}</div>}
                {detail.apply === null ? null : (
                  <div style={{ ...muted, ...mono, marginTop: 4 }}>备份包：{detail.apply.backup}</div>
                )}
                {detail.rollback === null ? null : (
                  <div style={{ ...muted, marginTop: 4 }}>
                    已回滚{detail.rollback.verified ? '（逐字节一致）' : '（字节校验未通过，请核对备份包）'}。
                  </div>
                )}
                {detail.truncated ? <div style={{ ...muted, marginTop: 4 }}>差异太多，只显示了前一部分行。</div> : null}
              </div>
              {detail.hunks.map((hunk) => (
                <HunkCard
                  key={`${detail.proposalId}-${String(hunk.index)}`}
                  hunk={hunk}
                  busy={busy}
                  onDecide={(decision) => void decide([decision])}
                />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
