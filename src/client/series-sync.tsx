/**
 * The series sync section of the shared-content page.
 *
 * WHERE IT LIVES, AND WHY: roadmap §2.4 puts the entry on the 共享内容 page ("no new
 * permanent tab") — a sync is a one-off action over the shared library, not a place the
 * author works from. So this is a section mounted by `hub-shared.tsx`, not a panel of its
 * own, and it takes the book the page has already picked rather than offering a second
 * book selector.
 *
 * THE TWO STEPS ARE VISIBLE IN THE UI, because they are the contract:
 *
 *   1. 预览同步 → `GET /hub/series/plan` (read-only) → four groups: 冲突 / 新建 / 更新 /
 *      无需改动, conflict rows carrying three decision buttons each;
 *   2. 应用同步 → arms a confirmation → `POST /hub/series/apply` with the plan's own
 *      `expected` rows, the decisions, and `confirm: true`; the answer reports what was
 *      written, what was kept, what drifted, plus the run record and the undo package.
 *
 * Every colour is a `--dsw-alias-*` token (AGENTS.md §6); no literal colour appears here,
 * which the bundle test asserts. All hooks are declared before the first `return`
 * (AGENTS.md §8 trap 2b — a hook after an early return blanks the whole page).
 */

import { useCallback, useState } from 'react'

import { fetchInternal, writeInternal } from './internal.js'
import {
  SERIES_DECISION_HINTS,
  SERIES_DECISION_LABELS,
  SERIES_CONFLICT_LABELS,
  SERIES_TEXTS,
  applyBlockedReason,
  applyPayload,
  describeApplyResult,
  describeChangedFields,
  describeSeriesError,
  readSeriesPlan,
  rowId,
  seriesGroups,
  seriesSummary,
  unresolvedConflicts,
} from './series-model.js'
import type { SeriesApplyValue, SeriesDecisions, SeriesPlanState, SeriesPlanValue } from './series-model.js'

const sectionStyle = {
  display: 'grid',
  gap: 8,
  padding: '10px 12px',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
} as const

const rowStyle = {
  display: 'grid',
  gap: 2,
  padding: '6px 10px',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-layer-2)',
} as const

const conflictStyle = {
  ...rowStyle,
  borderColor: 'var(--dsw-alias-state-warn-primary)',
} as const

const muted = { color: 'var(--dsw-alias-label-secondary)' } as const
const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 } as const

const buttonStyle = {
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  borderRadius: 6,
  padding: '3px 10px',
  fontSize: 12,
  cursor: 'pointer',
} as const

const chosenStyle = {
  ...buttonStyle,
  borderColor: 'var(--dsw-alias-state-success-primary)',
  color: 'var(--dsw-alias-state-success-primary)',
} as const

const INITIAL: SeriesPlanState = { status: 'idle', message: SERIES_TEXTS.hint }

const DECISION_CHOICES = ['take-shared', 'keep-book', 'skip'] as const

export function SeriesSyncSection({ book }: { book: string }) {
  const [plan, setPlan] = useState<SeriesPlanState>(INITIAL)
  const [decisions, setDecisions] = useState<SeriesDecisions>({})
  const [loading, setLoading] = useState(false)
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string[] } | null>(null)

  const loadPlan = useCallback(() => {
    if (book === '') {
      setPlan({ status: 'idle', message: SERIES_TEXTS.noBook })
      return
    }
    setLoading(true)
    setNotice(null)
    setArmed(false)
    setDecisions({})
    void fetchInternal<SeriesPlanValue>(`/hub/series/plan?book=${encodeURIComponent(book)}`, {
      sessionless: true,
    }).then((result) => {
      setPlan(readSeriesPlan(result))
      setLoading(false)
    })
  }, [book])

  /** Run the armed apply. `confirm: true` exists only on this path. */
  const runApply = useCallback(() => {
    if (busy || book === '') return
    setBusy(true)
    setArmed(false)
    void writeInternal<SeriesApplyValue>('/hub/series/apply', applyPayload(plan, decisions, book), {
      sessionless: true,
    }).then((result) => {
      setBusy(false)
      if (!result.ok) {
        setNotice({ tone: 'error', text: [describeSeriesError(result.error)] })
        return
      }
      setNotice({ tone: 'ok', text: describeApplyResult(result.value) })
      // The book changed: re-read the plan so the groups show the world after the write.
      loadPlan()
    })
  }, [book, busy, decisions, loadPlan, plan])

  const blocked = applyBlockedReason(plan, decisions, book)
  const unresolved = unresolvedConflicts(plan, decisions)
  const groups = seriesGroups(plan)

  return (
    <div style={sectionStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>{SERIES_TEXTS.title}</span>
        <span style={{ ...muted, fontSize: 12 }}>{loading ? SERIES_TEXTS.planning : seriesSummary(plan)}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button type="button" style={buttonStyle} onClick={loadPlan} disabled={loading || busy || book === ''}>
            {plan.status === 'ready' ? SERIES_TEXTS.replan : SERIES_TEXTS.plan}
          </button>
          <button
            type="button"
            style={buttonStyle}
            disabled={blocked !== null || loading || busy || armed}
            title={blocked ?? undefined}
            onClick={() => setArmed(true)}
          >
            {SERIES_TEXTS.apply}
          </button>
        </span>
      </div>

      <div style={muted}>{SERIES_TEXTS.hint}</div>
      {plan.status === 'ready' && plan.seriesId !== null ? (
        <div style={mono}>seriesId {plan.seriesId}</div>
      ) : null}
      {blocked !== null ? <div style={{ ...muted, fontSize: 12 }}>现在不能写入：{blocked}</div> : null}

      {armed ? (
        <div style={{ ...rowStyle, borderColor: 'var(--dsw-alias-state-warn-primary)' }}>
          <span>
            {`将同步 ${String(plan.status === 'ready' ? plan.expected.length : 0)} 条计划，其中 ` +
              `${String(takeSharedCount(plan, decisions))} 条冲突按「采用共享库」执行。` +
              '被写入的文件先落一个 .inkflow/backup/ 包，可回滚；共享库不会被改。'}
          </span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button type="button" style={buttonStyle} onClick={runApply} disabled={busy}>
              {busy ? SERIES_TEXTS.working : SERIES_TEXTS.confirmApply}
            </button>
            <button type="button" style={buttonStyle} onClick={() => setArmed(false)} disabled={busy}>
              {SERIES_TEXTS.cancel}
            </button>
          </span>
        </div>
      ) : null}

      {notice !== null ? (
        <div
          style={{
            ...rowStyle,
            borderColor:
              notice.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)',
            color:
              notice.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)',
          }}
        >
          {notice.text.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      ) : null}

      {plan.status === 'ready' && plan.rows.length === 0 ? (
        <div style={{ ...rowStyle, borderStyle: 'dashed' }}>{SERIES_TEXTS.emptyPlan}</div>
      ) : null}

      {groups.map((group) => (
        <div key={group.action} style={{ display: 'grid', gap: 6 }}>
          <div style={{ ...muted, fontWeight: 600 }}>
            {group.label} · {group.rows.length}
          </div>
          {group.action === 'unchanged' ? <div style={muted}>{SERIES_TEXTS.unchangedNote}</div> : null}
          {group.rows.map((row) => {
            const entryId = rowId(row)
            const isConflict = row.action === 'conflict'
            const decision = decisions[entryId]
            return (
              <div key={`${group.action}:${entryId}`} style={isConflict && decision === undefined ? conflictStyle : rowStyle}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600 }}>{String(row.targetPath ?? entryId)}</span>
                  {isConflict && typeof row.conflict === 'string' ? (
                    <span style={muted}>{SERIES_CONFLICT_LABELS[row.conflict] ?? row.conflict}</span>
                  ) : null}
                  {decision !== undefined ? (
                    <span style={{ ...muted, marginLeft: 'auto' }}>{SERIES_DECISION_LABELS[decision] ?? decision}</span>
                  ) : null}
                </div>
                <div style={{ ...muted, ...mono }}>
                  {entryId}
                  {describeChangedFields(row) === '' ? '' : ` · 差异：${describeChangedFields(row)}`}
                </div>
                {isConflict ? (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {DECISION_CHOICES.map((choice) => (
                      <button
                        key={choice}
                        type="button"
                        style={decision === choice ? chosenStyle : buttonStyle}
                        title={SERIES_DECISION_HINTS[choice]}
                        disabled={busy}
                        onClick={() =>
                          setDecisions((current) => {
                            const next: Record<string, string> = { ...current }
                            if (next[entryId] === choice) delete next[entryId]
                            else next[entryId] = choice
                            return next
                          })
                        }
                      >
                        {SERIES_DECISION_LABELS[choice] ?? choice}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ))}

      {plan.status === 'ready' && plan.excluded.length > 0 ? (
        <div style={muted}>不在同步范围内：{plan.excluded.join('、')}</div>
      ) : null}
    </div>
  )
}

/** How many conflicts the author decided `take-shared` — the rows that become writes. */
function takeSharedCount(plan: SeriesPlanState, decisions: SeriesDecisions): number {
  if (plan.status !== 'ready') return 0
  return plan.rows.filter((row) => row.action === 'conflict' && decisions[rowId(row)] === 'take-shared').length
}
