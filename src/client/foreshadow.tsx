/**
 * The foreshadow board tab (#31): read-only.
 *
 * This build shows the three groupings `GET /inkflow/internal/foreshadow` already
 * decided — 超期 / 未回收 / 按角色 — and nothing else. There is deliberately **no
 * editor here**: writing a foreshadow is a state-machine move (planted → advanced →
 * resolved, `resolved` terminal) and the confirm gate that guards it lives on the
 * tool (`inkflow_foreshadow_upsert`). A form in the panel would have to reimplement
 * both, and the two would drift the first time the rule changed.
 *
 * The client half never touches the filesystem (ADR-0008 D4): everything comes from
 * the private channel, and the request carries a session id and nothing else.
 */

import { useCallback, useEffect, useState } from 'react'

import { fetchInternal } from './internal.js'
import { SCROLL_BOX_STYLE, SCROLL_COLUMN_STYLE } from './layout-model.js'
import { useScrollBox } from './layout.js'
import { readForeshadowBoard } from './foreshadow-model.js'
import type { ForeshadowBoardValue, ForeshadowView } from './foreshadow-model.js'

// Every visible colour comes from the host theme (`--dsw-alias-*`); the panel keeps
// its own small style set rather than importing `index.tsx`'s, which would make the
// two modules import each other.
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

const badgeStyle = (tone: 'late' | 'now' | 'plain') => ({
  fontSize: 11,
  padding: '1px 6px',
  borderRadius: 999,
  border: '1px solid var(--dsw-alias-border-l2)',
  color:
    tone === 'late'
      ? 'var(--dsw-alias-state-error-primary)'
      : tone === 'now'
        ? 'var(--dsw-alias-state-warning-primary)'
        : 'var(--dsw-alias-label-secondary)',
  borderColor:
    tone === 'late'
      ? 'var(--dsw-alias-state-error-primary)'
      : tone === 'now'
        ? 'var(--dsw-alias-state-warning-primary)'
        : 'var(--dsw-alias-border-l2)',
}) as const

function SectionTitle({ children, note }: { children: string; note?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{children}</span>
      {note === undefined ? null : <span style={{ ...muted, fontSize: 11 }}>{note}</span>}
    </div>
  )
}

function NoteCard({ title, body, tone }: { title: string; body: string; tone?: 'error' }) {
  return (
    <div
      style={{
        ...cardStyle,
        borderStyle: 'dashed',
        ...(tone === 'error'
          ? { borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' }
          : {}),
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ ...muted, ...(tone === 'error' ? { color: 'var(--dsw-alias-state-error-primary)' } : {}) }}>{body}</div>
    </div>
  )
}

const EMPTY_VIEW: ForeshadowView = {
  error: null,
  indexAvailable: false,
  summary: null,
  currentChapter: null,
  sections: [],
  empty: null,
}

export function ForeshadowView({ sessionId }: { sessionId: string }) {
  const [view, setView] = useState<ForeshadowView>(EMPTY_VIEW)
  const [loading, setLoading] = useState(true)
  const scrollBox = useScrollBox()

  const refresh = useCallback(async () => {
    setLoading(true)
    const result = await fetchInternal<ForeshadowBoardValue>('/foreshadow', { sessionId })
    setView(readForeshadowBoard(result))
    setLoading(false)
  }, [sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div ref={scrollBox.ref} style={{ ...panelStyle, ...SCROLL_BOX_STYLE, ...scrollBox.style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <SectionTitle note="只读看板：写入请让 AI 调 inkflow_foreshadow_upsert">伏笔</SectionTitle>
        <span style={{ ...muted, ...mono, marginLeft: 'auto' }}>
          {loading ? '读取中…' : (view.currentChapter ?? '当前章未知')}
        </span>
        <button
          type="button"
          style={{
            padding: '2px 10px',
            fontSize: 12,
            borderRadius: 6,
            cursor: 'pointer',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-primary)',
          }}
          onClick={() => void refresh()}
        >
          刷新
        </button>
      </div>

      {view.summary === null ? null : <div style={{ ...muted, fontSize: 12 }}>{view.summary}</div>}

      {view.error === null ? null : <NoteCard title="读取失败" body={view.error} tone="error" />}
      {view.error === null && view.indexAvailable === false && view.empty !== null ? (
        <NoteCard title="索引不可读" body={view.empty} />
      ) : null}

      {view.sections.map((section) => (
        <div key={section.key} style={cardStyle}>
          <SectionTitle note={section.note}>{section.title}</SectionTitle>
          {section.key === 'byEntity' ? (
            section.entities.length === 0 ? (
              <div style={{ ...muted, fontSize: 12, marginTop: 6 }}>{section.empty}</div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {section.entities.map((entity) => (
                  <span key={entity.id ?? 'none'} style={{ ...badgeStyle('plain'), fontSize: 12 }}>
                    {entity.label}
                  </span>
                ))}
              </div>
            )
          ) : section.items.length === 0 ? (
            <div style={{ ...muted, fontSize: 12, marginTop: 6 }}>{section.empty}</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {section.items.map((card) => (
                <div key={`${section.key}-${card.id}`} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span
                      style={badgeStyle(card.badge === '超期' ? 'late' : card.current ? 'now' : 'plain')}
                    >
                      {card.badge}
                    </span>
                    <span style={{ fontSize: 13 }}>{card.title}</span>
                    {card.due === null ? null : <span style={{ ...muted, fontSize: 11 }}>{card.due}</span>}
                    {card.declared === null ? null : (
                      <span style={{ ...muted, fontSize: 11 }} title="文件里写的是这个状态，算出来的结果与它不同">
                        文件中：{card.declared}
                      </span>
                    )}
                  </div>
                  <span style={{ ...muted, ...mono }}>{card.file}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
