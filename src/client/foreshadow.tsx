/**
 * The foreshadow board tab: the three groupings `GET /inkflow/internal/foreshadow` already
 * decided — 本期到期 / 超期 / 未回收 / 按角色 — plus ONE write: 推进 a state on a row.
 *
 * Why the write lives here now: 伏笔 used to be edited in 设定库, and this board was
 * read-only because a state move is a machine decision (planted → advanced → resolved,
 * `resolved` terminal) with a `confirm` gate. Moving the entry out of that tree would have
 * cost the author the only editor it had, so the board carries the move — and **not the
 * rules**: it sends the tool's own argument names to `POST /foreshadow/advance`, which runs
 * the same pipeline as `inkflow_foreshadow_upsert`, and it prints the Host's code verbatim
 * (`FORESHADOW_TRANSITION_INVALID` included) instead of predicting a refusal.
 *
 * Creating an entry, renaming it, editing `dueBy` or the body stay on the tool: this is a
 * board with one action, not a second editor.
 *
 * The client half never touches the filesystem (ADR-0008 D4): the request carries a session
 * id and an entity address, never a directory.
 */

import { useCallback, useEffect, useState } from 'react'

import { ACTION_BUTTON_STYLE, ACTION_BUTTON_STYLE_SMALL } from './action-button.js'
import { fetchInternal, writeInternal } from './internal.js'
import { SCROLL_BOX_STYLE, SCROLL_COLUMN_STYLE } from './layout-model.js'
import { Icon } from './icons.js'
import { useScrollBox } from './layout.js'
import { advanceBody, focusFileOf, readForeshadowBoard } from './foreshadow-model.js'
import type { ForeshadowBoardValue, ForeshadowCard, ForeshadowView } from './foreshadow-model.js'
import type { LibraryFocus } from './library-model.js'

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

/** The armed button says what the second click does — the confirmation is the label. */
const armedButtonStyle = { ...ACTION_BUTTON_STYLE_SMALL, borderColor: 'var(--dsw-alias-state-warning-primary)' } as const

const inputStyle = {
  width: 120,
  fontSize: 11,
  padding: '1px 6px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
} as const

const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 } as const

/** The row a jump addressed: a border, not a colour of its own (the theme owns colours). */
const addressedRowStyle = {
  outline: '1px solid var(--dsw-alias-state-warning-primary)',
  outlineOffset: 2,
  borderRadius: 6,
} as const

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

export function ForeshadowView({ sessionId, focus }: { sessionId: string; focus?: LibraryFocus | null }) {
  const [view, setView] = useState<ForeshadowView>(EMPTY_VIEW)
  const [loading, setLoading] = useState(true)
  /** The row a 推进 click armed, and the chapter it is about: the second click sends it. */
  const [armed, setArmed] = useState<{ slug: string; target: 'advanced' | 'resolved' } | null>(null)
  const [chapter, setChapter] = useState('')
  const [busy, setBusy] = useState(false)
  /** 已回收 starts folded: a finished list is reference, not the day's work. */
  const [showResolved, setShowResolved] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
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

  /**
   * 推进 one entry: arm on the first click, write on the second (ADR-0012 decision 4).
   *
   * The body comes from `advanceBody` and the verdict from the Host: a code the pane does
   * not know is still the most useful line on screen, so it is printed as it arrives.
   */
  const advance = async (card: ForeshadowCard, target: 'advanced' | 'resolved'): Promise<void> => {
    if (armed === null || armed.slug !== card.slug || armed.target !== target) {
      setArmed({ slug: card.slug, target })
      setNotice(`再点一次确认：把「${card.title}」标记为${target === 'resolved' ? '已回收' : '已推进'}。`)
      setRefusal(null)
      return
    }
    setBusy(true)
    setNotice(null)
    const reply = await writeInternal<{ status?: string; path?: string }>('/foreshadow/advance', advanceBody(card, target, chapter), { sessionId })
    setBusy(false)
    setArmed(null)
    if (!reply.ok) {
      setRefusal(`推进被拒绝：${reply.error?.code ?? 'unknown'} — ${reply.error?.message ?? ''}`)
      return
    }
    setChapter('')
    setNotice(`已推进 ${reply.value?.path ?? card.file} · 现在状态 ${reply.value?.status ?? '?'}`)
    await refresh()
  }

  const highlight = focusFileOf(view, focus)

  return (
    <div ref={scrollBox.ref} style={{ ...panelStyle, ...SCROLL_BOX_STYLE, ...scrollBox.style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <SectionTitle note="推进状态在行内完成；新建、改名、改正文仍用 inkflow_foreshadow_upsert">伏笔</SectionTitle>
        <span style={{ ...muted, ...mono, marginLeft: 'auto' }}>
          {loading ? '读取中…' : (view.currentChapter ?? '当前章未知')}
        </span>
        <button type="button" style={ACTION_BUTTON_STYLE} onClick={() => void refresh()}>
          <Icon name="refresh" size={13} />
          刷新
        </button>
      </div>

      {view.summary === null ? null : <div style={{ ...muted, fontSize: 12 }}>{view.summary}</div>}
      {notice === null ? null : <div style={{ ...muted, fontSize: 12 }}>{notice}</div>}
      {refusal === null ? null : <NoteCard title="推进没有完成" body={refusal} tone="error" />}

      {view.error === null ? null : <NoteCard title="读取失败" body={view.error} tone="error" />}
      {view.error === null && view.indexAvailable === false && view.empty !== null ? (
        <NoteCard title="索引不可读" body={view.empty} />
      ) : null}

      {/* Issue 137: four sections, in the order an author works in — 本期到期 /
          超期 / 未回收 / 按角色. The model drops empty ones, so no section here needs
          a "（0）" placeholder; the summary line above already carries the zeroes. */}
      {view.sections.map((section) => (
        <div key={section.key} style={cardStyle}>
          <SectionTitle note={section.note}>{section.title}</SectionTitle>
          {section.key === 'byEntity' ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {section.entities.map((entity) => (
                <span key={entity.id ?? 'none'} style={{ ...badgeStyle('plain'), fontSize: 12 }}>
                  {entity.label}
                </span>
              ))}
            </div>
          ) : section.collapsed === true && !showResolved ? (
            // 已回收 opens folded: it is reference, and unfolding it must be one click — not a
            // scroll past finished work every time the board loads.
            <button type="button" style={{ ...ACTION_BUTTON_STYLE_SMALL, marginTop: 8 }} onClick={() => setShowResolved(true)}>
              <Icon name="caret-down" size={13} />
              展开已回收的 {String(section.items.length)} 条
            </button>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {section.items.map((card) => {
                const rowArmed = armed !== null && armed.slug === card.slug ? armed.target : null
                const addressed = highlight === card.file
                return (
                  <div
                    key={`${section.key}-${card.id}`}
                    style={{ display: 'flex', flexDirection: 'column', gap: 2, ...(addressed ? addressedRowStyle : {}) }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={badgeStyle(card.badge === '超期' ? 'late' : card.current ? 'now' : 'plain')}>
                        {card.badge}
                      </span>
                      <span style={{ fontSize: 13 }}>{card.title}</span>
                      {card.due === null ? null : <span style={{ ...muted, fontSize: 11 }}>{card.due}</span>}
                      {card.declared === null ? null : (
                        <span style={{ ...muted, fontSize: 11 }} title="文件里写的是这个状态，算出来的结果与它不同">
                          文件中：{card.declared}
                        </span>
                      )}
                      {addressed ? <span style={{ ...muted, fontSize: 11 }}>定位</span> : null}
                      <span style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                        {card.resolved ? (
                          <span
                            style={{ ...muted, fontSize: 11 }}
                            title="已回收是终态：inkflow_foreshadow_upsert 可以改状态，面板不给第四种动作"
                          >
                            {card.resolvedChapter === null ? '已回收（终态）' : `已回收于 ${card.resolvedChapter}`}
                          </span>
                        ) : null}
                        {card.resolved ? null : (
                        <>
                        <button
                          type="button"
                          style={rowArmed === 'advanced' ? armedButtonStyle : ACTION_BUTTON_STYLE_SMALL}
                          disabled={busy}
                          title={rowArmed === 'advanced' ? '再点一次确认' : '把这条的推进位置加上下面填的章'}
                          onClick={() => void advance(card, 'advanced')}
                        >
                          <Icon name={rowArmed === 'advanced' ? 'check' : 'play'} size={13} />
                          {rowArmed === 'advanced' ? '确认已推进' : '推进'}
                        </button>
                        <button
                          type="button"
                          style={rowArmed === 'resolved' ? armedButtonStyle : ACTION_BUTTON_STYLE_SMALL}
                          disabled={busy}
                          title={rowArmed === 'resolved' ? '再点一次确认' : '标记已回收，需要回收章'}
                          onClick={() => void advance(card, 'resolved')}
                        >
                          <Icon name="check" size={13} />
                          {rowArmed === 'resolved' ? '确认已回收' : '标记已回收'}
                        </button>
                        </>
                        )}
                      </span>
                    </div>
                    {rowArmed === null ? null : (
                      <input
                        style={inputStyle}
                        value={chapter}
                        onChange={(event) => setChapter(event.target.value)}
                        placeholder={rowArmed === 'resolved' ? '回收章 id' : '推进到的章 id'}
                      />
                    )}
                    <span style={{ ...muted, ...mono }}>{card.file}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
