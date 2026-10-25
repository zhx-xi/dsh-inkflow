/**
 * The review tab (#46, roadmap X-12, ADR-0022 D3).
 *
 * One screen, three questions in order:
 *
 *   1. **这一章审过几次** — every recorded run as a row (model, time, how many opinions, how
 *      many of them located, which dimensions failed), so "昨天那遍说了什么" is answerable.
 *      Clicking a row opens it.
 *   2. **那一次说了什么** — the five dimensions with their mechanical anchors, then every
 *      opinion with its address, its excerpt and a button that takes the workbench to the
 *      chapter. The button is only offered when the Host located the opinion; an unlocated
 *      one says why, and stays in the list — the page never hides an opinion it cannot jump to.
 *   3. **两个模型谁更实** — the cross-model table, printed exactly as the Host exported it
 *      (Markdown in a `<pre>`), because a second rendering would be a second set of numbers.
 *
 * Read-only by construction: it calls `GET /review` and `GET /review/compare`, neither of
 * which writes. Runs are produced by `inkflow_review_run` — this plugin embeds no model
 * client (X-26), so a page cannot "re-review" anything.
 *
 * Every hook sits before the first possible `return` (AGENTS.md §8 trap 2b): the page has no
 * early return at all, which is the cheapest way to keep that true while it grows.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import type { EvidenceJump } from './extract-model.js'
import { fetchInternal } from './internal.js'
import type { InternalResult } from './internal.js'
import { SCROLL_BOX_STYLE, SCROLL_COLUMN_STYLE } from './layout-model.js'
import { useScrollBox } from './layout.js'
import { chapterHeading, flattenChapters } from './panel-model.js'
import type { ChapterNode, ChaptersValue } from './panel-model.js'
import {
  describeReviewError,
  describeRun,
  describeScores,
  dimensionLabel,
  evidenceLine,
  readCompareValue,
  readReviewValue,
  reviewPanelState,
  splitRuns,
  statusLabel,
} from './review-model.js'
import type { ReviewOpinionView, ReviewRunRow } from './review-model.js'

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

const selectStyle = {
  ...mono,
  padding: '2px 6px',
  borderRadius: 6,
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

const preStyle = {
  ...mono,
  margin: 0,
  padding: 8,
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  overflowX: 'auto',
  whiteSpace: 'pre-wrap',
} as const

/** One severity's colour, from the host theme (never a literal). */
function severityColor(severity: string): string {
  return severity === 'warning' || severity === 'blocking'
    ? 'var(--dsw-alias-state-error-primary)'
    : 'var(--dsw-alias-label-secondary)'
}

function severityLabel(severity: string): string {
  if (severity === 'warning' || severity === 'blocking') return '需要处理'
  return '提示'
}

export interface ReviewViewProps {
  /** The session this panel is attached to; the Host resolves the book from it. */
  readonly sessionId: string
  /** Take the reader to a chapter (the workbench's own jump, #38's path). */
  readonly onOpenEvidence?: (jump: EvidenceJump) => void
}

export function ReviewView({ sessionId, onOpenEvidence }: ReviewViewProps) {
  const [chapters, setChapters] = useState<ChaptersValue | null>(null)
  const [selected, setSelected] = useState<string>('')
  const [runId, setRunId] = useState<string>('')
  const [review, setReview] = useState<InternalResult<Record<string, unknown>> | null>(null)
  const [compare, setCompare] = useState<InternalResult<Record<string, unknown>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [compareLoading, setCompareLoading] = useState(true)
  const [chapterError, setChapterError] = useState<string | null>(null)
  const [showCompare, setShowCompare] = useState(false)
  // #199: whether the run list's "更早的 N 次运行" row is open. The page it needs is fetched,
  // not hidden: folding is about what the first screen shows, never about dropping history.
  const [olderOpen, setOlderOpen] = useState(false)
  const scrollBox = useScrollBox()

  const rows: readonly ChapterNode[] = useMemo(() => flattenChapters(chapters), [chapters])

  const loadChapters = useCallback(async () => {
    const result = await fetchInternal<ChaptersValue>('/chapters', { sessionId })
    if (!result.ok) {
      setChapterError(describeReviewError(result.error))
      return
    }
    setChapterError(null)
    setChapters(result.value ?? null)
    setSelected((current) => {
      if (current !== '') return current
      const list = flattenChapters(result.value ?? null)
      return list.at(-1)?.id ?? ''
    })
  }, [sessionId])

  const loadReview = useCallback(
    async (chapterId: string, wantedRun: string, pageSize: number) => {
      if (chapterId === '') {
        setReview(null)
        setLoading(false)
        return
      }
      setLoading(true)
      const runQuery = wantedRun === '' ? '' : `&runId=${encodeURIComponent(wantedRun)}`
      // #199: `0` asks for the Host's own page (the fold's first screen); a bigger number is
      // the fold opening. The fold boundary itself comes back as `foldLimit`.
      const pageQuery = pageSize > 0 ? `&limit=${String(pageSize)}` : ''
      const result = await fetchInternal<Record<string, unknown>>(
        `/review?chapterId=${encodeURIComponent(chapterId)}${runQuery}${pageQuery}`,
        { sessionId },
      )
      setReview(result)
      setLoading(false)
    },
    [sessionId],
  )

  const loadCompare = useCallback(
    async (chapterId: string) => {
      if (chapterId === '') {
        setCompare(null)
        setCompareLoading(false)
        return
      }
      setCompareLoading(true)
      const result = await fetchInternal<Record<string, unknown>>(
        `/review/compare?chapterId=${encodeURIComponent(chapterId)}`,
        { sessionId },
      )
      setCompare(result)
      setCompareLoading(false)
    },
    [sessionId],
  )

  useEffect(() => {
    void loadChapters()
  }, [loadChapters])

  useEffect(() => {
    setRunId('')
    setOlderOpen(false)
    void loadReview(selected, '', 0)
    void loadCompare(selected)
  }, [loadCompare, loadReview, selected])

  const view = useMemo(() => readReviewValue(review !== null && review.ok ? (review.value ?? undefined) : undefined), [review])
  const compareView = useMemo(
    () => readCompareValue(compare !== null && compare.ok ? (compare.value ?? undefined) : undefined),
    [compare],
  )
  const state = useMemo(() => reviewPanelState({ loading, result: review }), [loading, review])
  const split = useMemo(() => splitRuns(view), [view])
  const loadError = state === 'error' ? describeReviewError(review?.error) : null
  const compareError = compare !== null && !compare.ok ? describeReviewError(compare.error) : null

  const openRun = (wanted: string): void => {
    setRunId(wanted)
    void loadReview(selected, wanted, olderOpen ? view.runCount : 0)
  }

  /**
   * Open or close the fold (#199).
   *
   * Two things must survive the toggle: the run the reader is looking at (passed back
   * through `runId`, so expanding never silently switches to the newest run) and the page
   * size, which is `runCount` while open and the Host's default while closed.
   */
  const toggleOlder = (): void => {
    const next = !olderOpen
    setOlderOpen(next)
    void loadReview(selected, runId, next ? view.runCount : 0)
  }

  const opinions = view.dimensions.reduce((sum, dimension) => sum + dimension.items.length, 0)
  const unlocated = view.dimensions.reduce(
    (sum, dimension) => sum + dimension.items.filter((item) => !item.located).length,
    0,
  )

  return (
    <div ref={scrollBox.ref} style={{ ...bodyStyle, ...SCROLL_BOX_STYLE, ...scrollBox.style }}>
      <div style={columnStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ ...muted, fontSize: 12, letterSpacing: 0.2 }}>审稿</div>
          <select
            style={selectStyle}
            value={selected}
            disabled={rows.length === 0}
            onChange={(event) => {
              setSelected(event.target.value)
            }}
          >
            {rows.length === 0 ? <option value="">（这本书还没有章节）</option> : null}
            {rows.map((chapter) => (
              <option key={chapter.id} value={chapter.id}>
                {chapterHeading(chapter)}
              </option>
            ))}
          </select>
          <span style={{ ...muted, ...mono, fontSize: 12 }}>
            {state === 'loading'
              ? '读审稿记录…'
              : `${String(view.runCount)} 次运行 · 本次 ${String(opinions)} 条意见（${String(unlocated)} 条未定位）· ${String(
                  view.wordCount,
                )} 字 / ${String(view.paragraphCount)} 段`}
          </span>
          <span style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            <button
              type="button"
              style={{ ...buttonStyle, ...(showCompare ? { borderColor: 'var(--dsw-alias-label-primary)' } : {}) }}
              onClick={() => {
                setShowCompare(!showCompare)
              }}
            >
              横评
            </button>
            <button
              type="button"
              style={buttonStyle}
              disabled={loading}
              onClick={() => {
                void loadReview(selected, runId, olderOpen ? view.runCount : 0)
                void loadCompare(selected)
              }}
            >
              {loading ? '读取中…' : '重新读'}
            </button>
          </span>
        </div>

        <div style={{ ...muted, ...mono, fontSize: 11 }}>
          {view.recordDir === '' ? '只读：这个页面不写任何文件' : `运行记录：${view.recordDir}/<runId>.json`}
        </div>
        {chapterError === null ? null : <div style={{ ...muted, fontSize: 12 }}>章节列表读取失败：{chapterError}</div>}
        {loadError === null ? null : <div style={{ ...muted, fontSize: 12 }}>{loadError}</div>}

        {view.runs.length === 0 ? (
          <div style={{ ...muted, fontSize: 12 }}>
            {state === 'ready'
              ? '这一章还没有审稿记录。让会话里的模型读一次（inkflow_review_context），把它的意见交给 inkflow_review_run，运行就会出现在这里。'
              : null}
          </div>
        ) : (
          <div style={cardStyle}>
            <div style={{ fontWeight: 600 }}>运行记录</div>
            {split.recent.map((row) => (
              <RunRowView key={row.runId} row={row} selectedRunId={view.selectedRunId} onOpen={openRun} />
            ))}
            {split.olderCount === 0 ? null : (
              <div style={{ ...rowStyle }}>
                <button type="button" style={buttonStyle} disabled={loading} onClick={toggleOlder}>
                  {olderOpen ? `收起更早的 ${String(split.olderCount)} 次运行` : `更早的 ${String(split.olderCount)} 次运行`}
                </button>
                {olderOpen ? null : (
                  <span style={{ ...muted, fontSize: 11, marginLeft: 8 }}>默认只列最近一页；展开后可以逐条打开、照常看证据与横评。</span>
                )}
              </div>
            )}
            {olderOpen
              ? split.older.map((row) => (
                  <RunRowView key={row.runId} row={row} selectedRunId={view.selectedRunId} onOpen={openRun} />
                ))
              : null}
            {view.skippedFiles.length === 0 ? null : (
              <div style={{ ...muted, fontSize: 11 }}>
                读不动的记录文件（未计入）：{view.skippedFiles.join('、')}
              </div>
            )}
          </div>
        )}

        {view.selectedRunId === '' ? null : (
          <div style={{ ...muted, ...mono, fontSize: 11 }}>
            当前运行 {view.selectedRunId} · 模型 {view.selectedReviewer === '' ? 'unknown' : view.selectedReviewer} ·{' '}
            {view.selectedCreatedAt}
            {view.selectedScores.length === 0 ? '' : ` · 自评 ${describeScores(view.selectedScores)}`}
          </div>
        )}

        {view.dimensions.map((dimension) => (
          <div key={dimension.dimension} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontWeight: 600 }}>{dimensionLabel(dimension.dimension, dimension.label)}</div>
              <div style={{ ...muted, fontSize: 12 }}>
                {statusLabel(dimension.status)} · {String(dimension.opinions)} 条（{String(dimension.located)} 条带定位）
              </div>
              {dimension.status === 'failed' ? (
                <div style={{ ...mono, fontSize: 11, color: severityColor('warning') }}>
                  {dimension.code} {dimension.message}
                </div>
              ) : null}
            </div>
            {dimension.anchors.length === 0 ? null : (
              <div style={{ ...muted, ...mono, fontSize: 11, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {dimension.anchors.map((anchor) => (
                  <span key={anchor.key}>
                    {anchor.key} {anchor.value}
                  </span>
                ))}
              </div>
            )}
            {dimension.items.length === 0 ? (
              <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>
                {dimension.status === 'skipped' ? '这一维没有跑（本次跳过）。' : '这一维没有意见。'}
              </div>
            ) : (
              dimension.items.map((opinion) => (
                <OpinionRow key={`${opinion.code}:${opinion.where}:${opinion.detail}`} opinion={opinion} onOpenEvidence={onOpenEvidence} />
              ))
            )}
          </div>
        ))}

        {view.rejected.length === 0 ? null : (
          <div style={cardStyle}>
            <div style={{ fontWeight: 600 }}>被拒收的意见</div>
            <div style={{ ...muted, fontSize: 12 }}>结构不合法（缺维度/缺正文等），没有进记录：</div>
            {view.rejected.map((rejection) => (
              <div key={`${String(rejection.index)}:${rejection.code}`} style={{ ...mono, fontSize: 11 }}>
                #{String(rejection.index + 1)} {rejection.code} {rejection.message}
              </div>
            ))}
          </div>
        )}

        {showCompare ? (
          <div style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <div style={{ fontWeight: 600 }}>模型横评</div>
              <div style={{ ...muted, fontSize: 12 }}>
                {compareLoading
                  ? '算表…'
                  : `${String(compareView.rows.length)} 行 · 模型 ${compareView.reviewers.join(' / ') || '—'}`}
              </div>
            </div>
            {compareError === null ? null : <div style={{ ...muted, fontSize: 12 }}>{compareError}</div>}
            {compareView.comparable ? null : (
              <div style={{ ...muted, fontSize: 12 }}>同一章至少要有 2 个模型各跑一次才是横评；现在只有 1 个或 0 个。</div>
            )}
            {compareView.markdown === '' ? null : <pre style={preStyle}>{compareView.markdown}</pre>}
            {compareView.note === '' ? null : <div style={{ ...muted, fontSize: 11 }}>{compareView.note}</div>}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** One opinion: address, severity, the excerpt, and the jump when the Host located it. */
function OpinionRow({
  opinion,
  onOpenEvidence,
}: {
  readonly opinion: ReviewOpinionView
  readonly onOpenEvidence?: (jump: EvidenceJump) => void
}) {
  const jump = opinion.jump
  const excerpt = evidenceLine(opinion)
  return (
    <div style={rowStyle}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ ...mono, fontSize: 11, color: severityColor(opinion.severity) }}>{severityLabel(opinion.severity)}</span>
        <span style={{ ...mono, fontSize: 11 }}>{opinion.code}</span>
        <span style={{ ...muted, ...mono, fontSize: 11 }}>
          {opinion.located ? opinion.where : `未定位（${opinion.unlocatedReason}）`}
        </span>
        {jump === null || onOpenEvidence === undefined ? null : (
          <button
            type="button"
            style={{ ...buttonStyle, padding: '0 8px', fontSize: 11 }}
            onClick={() => {
              onOpenEvidence(jump)
            }}
          >
            跳到正文
          </button>
        )}
      </div>
      <div style={{ fontSize: 13 }}>{opinion.detail}</div>
      {excerpt === '' ? null : <div style={{ ...muted, ...mono, fontSize: 11 }}>{excerpt}</div>}
      {opinion.located ? null : <div style={{ ...muted, fontSize: 11 }}>{opinion.unlocatedDetail}</div>}
      <div style={{ ...muted, fontSize: 12 }}>{opinion.hint}</div>
    </div>
  )
}

/**
 * One run as a list row (#199).
 *
 * Lifted out of the map body so the folded and the unfolded lists print the **same** row:
 * an older run that looked different from a recent one would read as a smaller feature, and
 * "选中后证据与横评照常工作" is only true if the row can be selected the same way.
 */
function RunRowView({
  row,
  selectedRunId,
  onOpen,
}: {
  readonly row: ReviewRunRow
  readonly selectedRunId: string
  readonly onOpen: (runId: string) => void
}) {
  return (
    <div style={{ ...rowStyle, display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
      <button
        type="button"
        style={{
          ...buttonStyle,
          ...(row.runId === selectedRunId ? { borderColor: 'var(--dsw-alias-label-primary)' } : {}),
        }}
        onClick={() => {
          onOpen(row.runId)
        }}
      >
        {row.runId === selectedRunId ? '当前' : '打开'}
      </button>
      <span style={{ ...mono, fontSize: 11 }}>{row.runId}</span>
      <span style={{ ...muted, fontSize: 12 }}>{describeRun(row)}</span>
      {row.scores === null ? null : (
        <span style={{ ...muted, ...mono, fontSize: 11 }}>
          自评{' '}
          {Object.entries(row.scores)
            .map(([dimension, value]) => `${dimension} ${String(value)}`)
            .join(' · ')}
        </span>
      )}
    </div>
  )
}
