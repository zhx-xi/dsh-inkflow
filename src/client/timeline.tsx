/**
 * The 时间线 tab: two axes side by side, the pending area under them, the findings, and one form
 * for a single event.
 *
 * WHY TWO COLUMNS AND NOT ONE SORTED LIST: the whole point of the dual timeline is that "when it
 * happened" and "when the reader learns it" are two orders over the same events. One list can
 * only show one of them, so the difference — a scene told after a later moment — becomes
 * invisible at exactly the moment it matters.
 *
 * WHAT THIS PAGE DOES NOT DO. It does not sort, does not derive a slot, does not validate a
 * date and does not decide which event goes to the pending area: all of that is the Host's
 * (`timeline-view.ts` builds the payload the tool answers too, `timeline-plan.ts` judges it).
 * The pane's own logic lives in `timeline-model.ts` and is unit-tested there; this file is the
 * render half.
 *
 * Every hook is declared before the first possible `return` (AGENTS.md §8 trap 2b): a conditional
 * hook changes the hook count between renders, React throws, and the whole panel goes blank.
 * Both columns scroll on their own — `SCROLL_COLUMN_STYLE` inside a measured `SCROLL_BOX_STYLE`
 * box, never `100%` plus `flex: 1` (the geometry that produced a 2539px panel once).
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

import { fetchInternal, writeInternal } from './internal.js'
import { SCROLL_BOX_STYLE, SCROLL_COLUMN_STYLE } from './layout-model.js'
import { useScrollBox } from './layout.js'
import {
  TIMELINE_EMPTY,
  TIMELINE_NOTE,
  TIMELINE_STATUS_OPTIONS,
  UNREADABLE_DATE,
  describeConflict,
  describeRow,
  describeUpsert,
  axisRowOf,
  draftOf,
  readTimelineView,
  upsertBodyOf,
} from './timeline-model.js'
import type { TimelineAxisRow, TimelineDraft, TimelineValue, TimelineView as TimelineViewState, TimelineWriteValue } from './timeline-model.js'

// Every visible colour is a host theme token (`--dsw-alias-*`); the panel keeps its own small
// style set rather than importing `index.tsx`'s, which would make the two modules import each other.
const panelStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
  minHeight: 0,
} as const

const columnStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 14,
  ...SCROLL_COLUMN_STYLE,
} as const

const rightColumnStyle = {
  ...columnStyle,
  borderLeft: '1px solid var(--dsw-alias-border-l1)',
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
  gap: 2,
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid transparent',
  background: 'var(--dsw-alias-bg-layer-1)',
  cursor: 'pointer',
  textAlign: 'left',
  color: 'var(--dsw-alias-label-primary)',
} as const

const badgeStyle = {
  fontSize: 11,
  padding: '0 6px',
  borderRadius: 999,
  border: '1px solid var(--dsw-alias-border-l2)',
  ...muted,
} as const

const inputStyle = {
  width: '100%',
  padding: '4px 8px',
  fontSize: 12,
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
} as const

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: 'grid', gap: 2 }}>
      <span style={{ ...muted, fontSize: 11 }}>
        {label}
        {hint === undefined ? '' : `（${hint}）`}
      </span>
      {children}
    </label>
  )
}

function NoteCard({ title, body, tone }: { title: string; body: string; tone?: 'error' }) {
  return (
    <div
      style={{
        ...cardStyle,
        borderStyle: 'dashed',
        ...(tone === 'error' ? { color: 'var(--dsw-alias-state-error-primary)' } : {}),
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ ...muted, fontSize: 12 }}>{body}</div>
    </div>
  )
}

/** One row of either axis: the labels come from the model, never from this file. */
function AxisRow({ row, onPick }: { row: TimelineAxisRow; onPick: (row: TimelineAxisRow) => void }) {
  return (
    <button type="button" style={rowStyle} onClick={() => onPick(row)} title={row.event.file}>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 13 }}>{row.event.title}</span>
        {row.slot === null ? null : <span style={{ ...badgeStyle, ...mono }}>{row.slot}</span>}
        {row.flashback ? <span style={{ ...badgeStyle, color: 'var(--dsw-alias-state-warn-primary)' }}>倒叙</span> : null}
        {row.unreadable ? (
          <span style={{ ...badgeStyle, color: 'var(--dsw-alias-state-error-primary)' }}>{UNREADABLE_DATE}</span>
        ) : null}
        <span style={{ ...muted, ...mono, marginLeft: 'auto' }}>{row.when}</span>
      </span>
      <span style={{ ...muted, ...mono, fontSize: 11 }}>
        {describeRow(row)}
        {row.event.participants.length === 0 ? '' : ` · ${row.event.participants.join(', ')}`}
      </span>
    </button>
  )
}

export function TimelineView({ sessionId }: { sessionId: string }) {
  const [view, setView] = useState<TimelineViewState | null>(null)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<TimelineDraft | null>(null)
  // The receipt carries its own tone: the same one line answers "wrote 186 bytes" and "the Host
  // refused with TIMELINE_ORDER_CONFLICT", and a failure painted like a success is worse than none.
  const [receipt, setReceipt] = useState<{ text: string; failed: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  // Hooks before any return (see the file header).
  const scrollBox = useScrollBox()

  const refresh = useCallback(async () => {
    setLoading(true)
    // One read for the whole pane: `axis=both` plus the pending area, the findings and the era
    // table travel together so the two columns can never be drawn from two different reads.
    const result = await fetchInternal<TimelineValue>('/timeline?axis=both&includeUnconfirmed=true', { sessionId })
    setView(readTimelineView(result))
    setLoading(false)
  }, [sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const pick = useCallback((row: TimelineAxisRow) => {
    setDraft(draftOf(row.event))
    setReceipt(null)
  }, [])

  const submit = useCallback(async () => {
    if (draft === null) return
    setSaving(true)
    const result = await writeInternal<TimelineWriteValue>('/timeline/upsert', upsertBodyOf(draft), { sessionId })
    const text = describeUpsert(result)
    setReceipt(text === null ? null : { text, failed: !result.ok })
    setSaving(false)
    if (result.ok) {
      setDraft(null)
      await refresh()
    }
  }, [draft, refresh, sessionId])

  const current = view
  const eras = current?.eras ?? []

  return (
    <div ref={scrollBox.ref} style={{ ...panelStyle, ...SCROLL_BOX_STYLE, ...scrollBox.style }}>
      <div style={columnStyle}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>时间线</span>
          <span style={{ ...muted, fontSize: 11 }}>{current?.pendingNote ?? '没有待定'}</span>
          <span style={{ ...muted, fontSize: 11 }}>·</span>
          <span style={{ ...muted, fontSize: 11 }}>{current?.conflictsNote ?? '没有冲突'}</span>
          <button type="button" style={{ ...badgeStyle, marginLeft: 'auto', cursor: 'pointer' }} onClick={() => void refresh()}>
            刷新
          </button>
          <button
            type="button"
            style={{ ...badgeStyle, cursor: 'pointer' }}
            onClick={() => {
              setDraft(draftOf(null))
              setReceipt(null)
            }}
          >
            新建事件
          </button>
        </div>
        <div style={{ ...muted, fontSize: 11 }}>{TIMELINE_NOTE}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 2 }}>
          <span style={{ fontSize: 12, fontWeight: 600 }}>世界内时间</span>
          <span style={{ ...muted, fontSize: 11 }}>什么时候发生</span>
          <span style={{ ...muted, ...mono, marginLeft: 'auto' }}>
            {loading ? '读取中…' : `${String(current?.counts.world ?? 0)} 条`}
          </span>
        </div>

        {current === null || current.error === null ? null : <NoteCard title="时间线读不出来" body={current.error} tone="error" />}
        {current === null || current.indexAvailable ? null : (
          <NoteCard title={TIMELINE_EMPTY['index-unavailable'].title} body={TIMELINE_EMPTY['index-unavailable'].body} />
        )}
        {current === null || current.empty === null ? null : <NoteCard title={current.empty.title} body={current.empty.body} />}

        {current === null
          ? null
          : current.world.map((row) => <AxisRow key={row.event.file} row={row} onPick={pick} />)}
      </div>

      <div style={rightColumnStyle}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>叙事顺序</span>
          <span style={{ ...muted, fontSize: 11 }}>读者什么时候知道</span>
          <span style={{ ...muted, ...mono, marginLeft: 'auto' }}>
            {loading ? '读取中…' : `${String(current?.counts.narrative ?? 0)} 条`}
          </span>
        </div>

        {draft === null ? null : (
          <div style={cardStyle}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{draft.slug === '' ? '新建事件' : `编辑 ${draft.slug}`}</div>
            <div style={{ display: 'grid', gap: 6 }}>
              <Field label="事件（必填）">
                <input style={inputStyle} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
              </Field>
              <Field label="世界时间" hint="YYYY / YYYY-MM / YYYY-MM-DD">
                <input
                  style={inputStyle}
                  value={draft.worldTime}
                  placeholder="1710-03-05"
                  onChange={(event) => setDraft({ ...draft, worldTime: event.target.value })}
                />
              </Field>
              <Field label="纪元" hint={eras.length === 0 ? '本书历法未读到' : `本书：${eras.join(' / ')}`}>
                <input
                  style={inputStyle}
                  value={draft.era}
                  placeholder={current?.defaultEra ?? ''}
                  onChange={(event) => setDraft({ ...draft, era: event.target.value })}
                />
              </Field>
              <Field label="叙事顺序" hint="全书一个槽位，留空=不参与叙事轴">
                <input
                  style={inputStyle}
                  value={draft.narrativeOrder}
                  placeholder="1"
                  onChange={(event) => setDraft({ ...draft, narrativeOrder: event.target.value })}
                />
              </Field>
              <Field label="章节 id">
                <input style={inputStyle} value={draft.chapter} onChange={(event) => setDraft({ ...draft, chapter: event.target.value })} />
              </Field>
              <Field label="参与者" hint="角色 id，逗号分隔">
                <input
                  style={inputStyle}
                  value={draft.participants}
                  placeholder="c-a, c-b"
                  onChange={(event) => setDraft({ ...draft, participants: event.target.value })}
                />
              </Field>
              <Field label="状态">
                <select
                  style={inputStyle}
                  value={draft.status}
                  onChange={(event) => setDraft({ ...draft, status: event.target.value === 'unconfirmed' ? 'unconfirmed' : 'confirmed' })}
                >
                  {TIMELINE_STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="正文" hint="Markdown，留空=保留原正文">
                <textarea
                  style={{ ...inputStyle, minHeight: 60 }}
                  value={draft.body}
                  onChange={(event) => setDraft({ ...draft, body: event.target.value })}
                />
              </Field>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                type="button"
                style={{ ...badgeStyle, cursor: saving ? 'progress' : 'pointer' }}
                disabled={saving || draft.title.trim() === ''}
                onClick={() => void submit()}
              >
                {saving ? '保存中…' : '保存'}
              </button>
              <button type="button" style={{ ...badgeStyle, cursor: 'pointer' }} onClick={() => setDraft(null)}>
                取消
              </button>
            </div>
            {receipt === null ? null : (
              <div
                style={{
                  ...mono,
                  marginTop: 6,
                  ...(receipt.failed ? { color: 'var(--dsw-alias-state-error-primary)' } : muted),
                }}
              >
                {receipt.text}
              </div>
            )}
          </div>
        )}

        {receipt === null || draft !== null ? null : (
          <NoteCard title="上一次写入" body={receipt.text} {...(receipt.failed ? { tone: 'error' as const } : {})} />
        )}

        {current === null
          ? null
          : current.narrative.map((row) => <AxisRow key={`n-${row.event.file}`} row={row} onPick={pick} />)}

        {current === null || current.pending.length === 0 ? null : (
          <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
            <div style={{ ...muted, fontSize: 11 }}>待确认区（{current.pendingNote}，不参与两条轴的排序）</div>
            {current.pending.map((entry) => (
              <button key={`p-${entry.file}`} type="button" style={rowStyle} onClick={() => pick(axisRowOf(entry))} title={entry.file}>
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 13 }}>{entry.title}</span>
                  <span style={{ ...badgeStyle, color: 'var(--dsw-alias-state-warn-primary)' }}>待定</span>
                  <span style={{ ...muted, ...mono, marginLeft: 'auto' }}>{entry.worldTime ?? '—'}</span>
                </span>
                <span style={{ ...muted, ...mono, fontSize: 11 }}>{entry.file}</span>
              </button>
            ))}
          </div>
        )}

        {current === null || current.conflicts.length === 0 ? null : (
          <div style={{ display: 'grid', gap: 6, marginTop: 4 }}>
            <div style={{ ...muted, fontSize: 11 }}>冲突（{current.conflictsNote}）</div>
            {current.conflicts.map((conflict) => (
              <div key={`${conflict.code}-${conflict.path}-${conflict.otherPath ?? ''}`} style={cardStyle}>
                <div style={{ fontSize: 12 }}>{describeConflict(conflict)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
