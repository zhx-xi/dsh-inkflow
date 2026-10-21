/**
 * dsh-inkflow — Client half: the `conversation.view` panel skeleton (issue #17).
 *
 * The build wraps this module in `window.__ModuleLoader__.load({id, factory})`
 * (see scripts/build.mjs); this file therefore exports the standard Client
 * plugin shape `{inject, apply}` and never touches the module loader itself.
 *
 * WHY `conversation.view` AND NOTHING ELSE (ADR-0008 D1): the panel means "this
 * book's cockpit", and "this book" can only be derived from the conversation it
 * is opened in. `sidebar.panellist` and `main` are root-scoped — no session, so
 * the only way to name a directory from them would be a remembered path, which
 * is exactly the shortcut ADR-0006 D5 deleted.
 *
 * WHAT TRAVELS TO THE HOST: the session id and nothing else. `setActiveSessionId`
 * hands it to `fetchInternal`, which appends `?sessionId=` to
 * `/inkflow/internal/*`; the Host resolves the directory itself (D4). No `root`,
 * `path` or `cwd` is ever built here.
 *
 * WHAT THIS ISSUE DOES NOT DO: no editor, no write route, no placeholder pages.
 * Tabs that do not exist yet are rendered disabled with their release note, and
 * the wizard button only re-reads the read-only plan (`GET /status`), never
 * applies it (D5 / ADR-0006 D3).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ClientContext, ConversationViewProps, WorkspaceView } from './context.js'
import { fetchInternal, setActiveSessionId } from './internal.js'
import type { InternalResult } from './internal.js'
import {
  EMPTY_MESSAGES,
  PANEL_TABS,
  buildChapterTree,
  chapterHeading,
  describeAction,
  describeFacts,
  describeRouteError,
  emptyKindOf,
  previewText,
  projectFacts,
  readGate,
  relativeProjectRoot,
} from './panel-model.js'
import type { BadgeTone, ChapterDetailValue, ChaptersValue, PanelGate, StatusValue } from './panel-model.js'

// ---------------------------------------------------------------------------
// Theme tokens. Every visible colour comes from the host theme (no literals,
// no hardcoded hex): AGENTS.md §6 and architecture.md §4.4.
// ---------------------------------------------------------------------------

const panelStyle = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
  lineHeight: 1.6,
} as const

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 16px',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
  background: 'var(--dsw-alias-bg-layer-1)',
  flexWrap: 'wrap',
} as const

const tabRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '0 16px',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
  background: 'var(--dsw-alias-bg-layer-1)',
} as const

const bodyStyle = {
  display: 'grid',
  gridTemplateColumns: '260px minmax(0, 1fr)',
  flex: 1,
  minHeight: 0,
} as const

const columnStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 14,
  minHeight: 0,
  overflowY: 'auto',
} as const

const dividerStyle = { borderLeft: '1px solid var(--dsw-alias-border-l1)' } as const

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
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  borderRadius: 6,
  padding: '3px 10px',
  fontSize: 12,
  cursor: 'pointer',
} as const

/** Tone → theme token. The only place a badge colour is spelled out. */
function toneColor(tone: BadgeTone): string {
  return `var(--dsw-alias-state-${tone}-primary)`
}

function SectionTitle({ children }: { children: string }) {
  return <div style={{ ...muted, fontSize: 12, letterSpacing: 0.2 }}>{children}</div>
}

function Badge({ label, tone }: { label: string; tone: BadgeTone }) {
  return (
    <span
      style={{
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 999,
        padding: '0 8px',
        fontSize: 12,
        color: toneColor(tone),
      }}
    >
      {label}
    </span>
  )
}

/** The three empty cards the skeleton renders (`needs-setup` has its own card). */
function EmptyCard({ kind }: { kind: 'no-session' | 'no-chapters' | 'no-selection' }) {
  const message = EMPTY_MESSAGES[kind]
  return (
    <div style={{ ...cardStyle, borderStyle: 'dashed' }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{message.title}</div>
      <div style={muted}>{message.body}</div>
    </div>
  )
}

/**
 * The workspace this session belongs to.
 *
 * `sessionIds` is matched in both spellings DSH uses (`session-<uuid>` in the
 * workspace store, bare `<uuid>` on some protocol surfaces) — the same tolerance
 * the Host's resolver applies, so the panel and the channel agree on the book.
 */
function findSessionWorkspace(workspaces: WorkspaceView[] | undefined, sessionId: string): WorkspaceView | undefined {
  if (!Array.isArray(workspaces) || sessionId === '') return undefined
  const candidates = sessionId.startsWith('session-') ? [sessionId, sessionId.slice('session-'.length)] : [sessionId, `session-${sessionId}`]
  return workspaces.find((workspace) => Array.isArray(workspace.sessionIds) && candidates.some((candidate) => workspace.sessionIds?.includes(candidate)))
}

export function InkflowView({ sessionId, useSessions, useSession, useWorkspaces }: ConversationViewProps) {
  const workspaceItems = useWorkspaces((state) => state.items)
  const sessionsById = useSessions((state) => state.byId)
  // Only used to say "still opening" instead of claiming the panel is empty:
  // shipped Views read `snapshot.openState === 'loading'` the same way.
  const sessionOpenState = useSession((snapshot) => snapshot.openState)

  const [status, setStatus] = useState<InternalResult<StatusValue> | null>(null)
  const [chapters, setChapters] = useState<ChaptersValue | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<ChapterDetailValue | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [planVisible, setPlanVisible] = useState(false)

  const workspace = useMemo(() => findSessionWorkspace(workspaceItems, sessionId), [workspaceItems, sessionId])
  const sessionCwd = sessionsById?.[sessionId]?.cwd ?? null

  const refresh = useCallback(async () => {
    setLoading(true)
    // The session id is the ONLY thing the panel tells the Host (ADR-0008 D4).
    setActiveSessionId(sessionId)
    const statusResult = await fetchInternal<StatusValue>('/status', { sessionId })
    setStatus(statusResult)
    if (statusResult.ok && statusResult.value?.usable === true) {
      const list = await fetchInternal<ChaptersValue>('/chapters', { sessionId })
      setChapters(list.ok ? (list.value ?? null) : null)
    } else {
      // Non-usable: the chapter tree would be a repair target, not content.
      setChapters(null)
      setSelected(null)
    }
    setLoading(false)
  }, [sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // One chapter, read-only. The request names an id; containment is the Host's
  // job (it refuses anything outside chapters/).
  useEffect(() => {
    if (selected === null) {
      setDetail(null)
      setDetailError(null)
      return
    }
    let live = true
    void (async () => {
      const result = await fetchInternal<ChapterDetailValue>(`/chapters/${encodeURIComponent(selected)}`, { sessionId })
      if (!live) return
      if (result.ok) {
        setDetail(result.value ?? null)
        setDetailError(null)
      } else {
        setDetail(null)
        setDetailError(describeRouteError(result.error))
      }
    })()
    return () => {
      live = false
    }
  }, [selected, sessionId])

  const gate: PanelGate = useMemo(() => readGate(status), [status])
  const tree = useMemo(() => buildChapterTree(chapters), [chapters])
  // Derived state the gate answer already carried: shown, never acted upon.
  const facts = useMemo(() => projectFacts(status), [status])
  const empty = emptyKindOf(gate, tree.total, selected !== null)

  // The project root relative to this session's workspace; the Host reported the
  // absolute path, the workspace came from the Client store.
  const rootLabel = relativeProjectRoot(gate.root, workspace?.path ?? sessionCwd)
  const projectTitle = gate.projectTitle ?? workspace?.title ?? null
  const preview = previewText(detail?.body)
  const routeHint = status !== null && !status.ok ? describeRouteError(status.error) : null

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>InkFlow</span>
        <span style={muted}>{projectTitle ?? '长篇小说创作工作台'}</span>
        <Badge label={gate.label} tone={gate.tone} />
        <span style={{ ...muted, ...mono }} title={gate.root ?? undefined}>
          {rootLabel ?? '—'}
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...muted, ...mono }}>
            {loading ? '检测中…' : sessionOpenState === 'loading' ? '会话打开中…' : `会话 …${sessionId.slice(-8)}`}
          </span>
          <button type="button" style={buttonStyle} onClick={() => void refresh()}>
            重新检测
          </button>
        </span>
      </div>

      <div style={tabRowStyle}>
        {PANEL_TABS.map((tab) =>
          tab.available ? (
            <span
              key={tab.id}
              style={{
                padding: '6px 4px',
                borderBottom: '2px solid var(--dsw-alias-label-primary)',
                fontSize: 12,
              }}
            >
              {tab.label}
            </span>
          ) : (
            // Disabled on purpose: no page exists yet, so a live tab would be a
            // dead button. The note is the tooltip and the visible sub-label.
            <button
              key={tab.id}
              type="button"
              disabled
              title={tab.note}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                padding: '6px 4px',
                fontSize: 12,
                cursor: 'not-allowed',
              }}
            >
              {tab.label}
              <span style={{ ...muted, marginLeft: 4 }}>{tab.note}</span>
            </button>
          ),
        )}
      </div>

      {empty === 'no-session' ? (
        <div style={{ ...columnStyle, maxWidth: 560 }} title={routeHint ?? undefined}>
          {gate.hint === null ? null : <div style={muted}>{gate.hint}</div>}
          <EmptyCard kind="no-session" />
        </div>
      ) : !gate.usable ? (
        <div style={{ ...columnStyle, gap: 12 }}>
          <div style={{ ...cardStyle, borderColor: toneColor(gate.tone) }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontWeight: 600 }}>{EMPTY_MESSAGES['needs-setup'].title}</span>
              <Badge label={gate.label} tone={gate.tone} />
              {gate.readOnly ? <span style={muted}>只读：这个状态不写入</span> : null}
              <button
                type="button"
                style={{ ...buttonStyle, marginLeft: 'auto' }}
                onClick={() => {
                  setPlanVisible(true)
                  void refresh()
                }}
              >
                打开初始化向导
              </button>
            </div>
            <div style={muted}>{gate.hint ?? EMPTY_MESSAGES['needs-setup'].body}</div>
            {routeHint === null ? null : <div style={{ ...muted, marginTop: 6 }}>{routeHint}</div>}
          </div>

          <div style={cardStyle}>
            <SectionTitle>缺少（missing）</SectionTitle>
            {gate.missing.length === 0 ? (
              <div style={muted}>Host 没有列出缺失项。</div>
            ) : (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, ...mono }}>
                {gate.missing.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </div>

          <div style={cardStyle}>
            <SectionTitle>初始化向导将要做的动作（actions）</SectionTitle>
            {gate.actions.length === 0 ? (
              <div style={muted}>Host 没有列出动作。</div>
            ) : (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, ...mono }}>
                {gate.actions.map((action, index) => (
                  <li key={`${action.type ?? 'manual'}-${index}`}>{describeAction(action)}</li>
                ))}
              </ul>
            )}
            {gate.reasons.length === 0 ? null : <div style={{ ...muted, marginTop: 6 }}>{gate.reasons.join('；')}</div>}
          </div>

          {planVisible ? (
            <div style={{ ...cardStyle, borderStyle: 'dashed' }}>
              <SectionTitle>初始化计划（只读预览，等价于 inkflow_project_plan）</SectionTitle>
              <div style={{ ...muted, marginTop: 6 }}>
                面板不写盘。确认要执行时，在会话里让 AI 调 `inkflow_project_init`（confirm: true）——只补缺失项，不覆盖已有文件。
              </div>
              <ol style={{ margin: '6px 0 0', paddingLeft: 18, ...mono }}>
                {gate.actions.length === 0 ? <li>{EMPTY_MESSAGES['needs-setup'].body}</li> : null}
                {gate.actions.map((action, index) => (
                  <li key={`plan-${index}`}>{describeAction(action)}</li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      ) : (
        <div style={bodyStyle}>
          <div style={columnStyle}>
            <SectionTitle>章节树（卷 → 章）</SectionTitle>
            {tree.total === 0 ? <EmptyCard kind="no-chapters" /> : null}
            {tree.groups.map((group) => (
              <div key={group.volumeId} style={{ display: 'grid', gap: 2 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
                  <span style={{ fontWeight: 600 }}>{group.title}</span>
                  <span style={{ ...muted, ...mono }}>{group.dir ?? group.volumeId}</span>
                </div>
                {group.chapters.length === 0 ? (
                  <div style={{ ...muted, paddingLeft: 8 }}>这一卷还没有章</div>
                ) : (
                  group.chapters.map((chapter) => (
                    <button
                      key={chapter.id}
                      type="button"
                      onClick={() => setSelected(chapter.id)}
                      style={{
                        ...buttonStyle,
                        display: 'block',
                        width: '100%',
                        textAlign: 'left',
                        paddingLeft: 8,
                        background: chapter.id === selected ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                        borderColor: chapter.id === selected ? 'var(--dsw-alias-border-l2)' : 'transparent',
                      }}
                    >
                      <div>{chapterHeading(chapter)}</div>
                      <div style={{ ...muted, ...mono }}>{chapter.path}</div>
                    </button>
                  ))
                )}
              </div>
            ))}
            {tree.loose.length === 0 ? null : (
              <div style={{ display: 'grid', gap: 2 }}>
                <span style={{ fontWeight: 600 }}>未分卷</span>
                {tree.loose.map((chapter) => (
                  <button
                    key={chapter.id}
                    type="button"
                    onClick={() => setSelected(chapter.id)}
                    style={{
                      ...buttonStyle,
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      paddingLeft: 8,
                      background: chapter.id === selected ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                      borderColor: chapter.id === selected ? 'var(--dsw-alias-border-l2)' : 'transparent',
                    }}
                  >
                    <div>{chapterHeading(chapter)}</div>
                    <div style={{ ...muted, ...mono }}>{chapter.path}</div>
                  </button>
                ))}
              </div>
            )}
            <div style={{ ...muted, marginTop: 'auto', paddingTop: 6 }}>{describeFacts(facts)}</div>
          </div>

          <div style={{ ...columnStyle, ...dividerStyle }}>
            <SectionTitle>正文预览（只读）</SectionTitle>
            {selected === null ? <EmptyCard kind="no-selection" /> : null}
            {detailError === null ? null : (
              <div style={{ ...cardStyle, borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' }}>
                {detailError}
              </div>
            )}
            {detail === null || selected === null ? null : (
              <div style={cardStyle}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontWeight: 600 }}>{detail.title ?? detail.id ?? selected}</span>
                  <span style={{ ...muted, ...mono }}>{detail.path ?? ''}</span>
                  <span style={{ ...muted, marginLeft: 'auto' }}>{detail.bodyChars ?? 0} 字</span>
                </div>
                {detail.issues === undefined || detail.issues.length === 0 ? null : (
                  <div style={{ ...muted, marginTop: 4 }}>frontmatter 提示：{detail.issues.length} 条</div>
                )}
                <pre
                  style={{
                    margin: '8px 0 0',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    fontFamily: 'inherit',
                    fontSize: 13,
                    maxHeight: '100%',
                  }}
                >
                  {preview.text === '' ? '（这一章的正文还是空的）' : preview.text}
                </pre>
                {preview.truncated ? <div style={{ ...muted, marginTop: 6 }}>预览只显示开头部分；完整正文在 {detail.path ?? 'chapters/'}。</div> : null}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export const inject = ['slots']

/**
 * The ONLY registration: `conversation.view` (ADR-0008 D1).
 *
 * `id: 'inkflow'` puts the view beside 对话 / 轨迹, right after them
 * (`order: 40`; the shipped entries are chat 0 and trajectory 10). The id is
 * stable — user patches elsewhere address this view by it. No `sidebar.panellist`
 * and no `main` registration: those are root-scoped and would reintroduce the
 * "panel points at another book" path ADR-0006 D5 deleted.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() =>
    ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({ name: 'conversation.view', id: 'inkflow', order: 40, label: () => 'InkFlow' }, InkflowView),
    ),
  )
}
