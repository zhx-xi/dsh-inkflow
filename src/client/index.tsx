/**
 * dsh-inkflow — Client half (Workbench).
 *
 * The build wraps this module in `window.__ModuleLoader__.load({id, factory})`
 * (see scripts/build.mjs); this file therefore exports the standard Client
 * plugin shape `{inject, apply}` and never touches the module loader itself.
 *
 * The page reads only from the Host's read-only projection
 * (`/inkflow/api/status`, `/inkflow/api/chapters`). It never invents a project:
 * if nothing is selected, it tells the user how to make a directory one.
 */

import { useCallback, useEffect, useState } from 'react'
import type { ClientContext, SidebarPanelIconProps } from './context.js'

const PANEL_ID = 'inkflow'

type DirChecks = Record<string, boolean>

interface StatusValue {
  pluginVersion: string
  project: null | {
    root: string
    label: string
    usable: boolean
    state?: string
    checks: { git: boolean; dirs: DirChecks; keeps?: DirChecks; meta: boolean }
    missing: string[]
    reasons: string[]
  }
  index?: {
    dbExists: boolean
    schemaMatches: boolean
    builtAt: string | null
    counts: Record<string, number>
  }
  hint?: string
}

interface ChapterSummary {
  id: string
  path: string
  seq: number | null
  title: string
  volume: string | null
  status: string
  wordCount: number
}

interface RouteResult<T> {
  ok: boolean
  value?: T
  error?: { code: string; message?: string }
}

async function getJson<T>(path: string): Promise<RouteResult<T>> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  const body = (await response.json()) as RouteResult<T>
  if (!response.ok || body.ok !== true) return { ok: false, error: body.error ?? { code: `http-${response.status}` } }
  return body
}

/**
 * Route failures that deserve a sentence instead of a bare code. Until the host
 * can map a request to its session's workspace, every projection answers
 * NO_SESSION_CONTEXT — showing a raw code there would look like a plugin bug.
 */
const ERROR_HINTS: Record<string, string> = {
  NO_SESSION_CONTEXT: '无法确定当前会话的项目，请在小说会话里用 inkflow_project_status 查看',
}

function describeRouteError(error: { code: string; message?: string } | undefined): string {
  if (error === undefined) return 'status-unavailable'
  return ERROR_HINTS[error.code] ?? error.message ?? error.code
}

/** Sidebar icon: a page with a falling ink drop. Monochrome via currentColor. */
function InkflowIcon({ size }: SidebarPanelIconProps) {
  const edge = typeof size === 'number' && size > 0 ? size : 20
  return (
    <svg width={edge} height={edge} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
      <path d="M5.5 3.75h9l4 4v12.5a.75.75 0 0 1-.75.75h-12a.75.75 0 0 1-.75-.75V4.5a.75.75 0 0 1 .75-.75Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M14.25 3.9v4.1h4.1" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8.6 12.4h6.8M8.6 15.6h4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M17.6 14.2c1.3 1.4 2 2.3 2 3.2a2 2 0 1 1-4 0c0-.9.7-1.8 2-3.2Z" fill="currentColor" opacity="0.9" />
    </svg>
  )
}

// ADR-0006 D1: nine content directories plus the derived index/, each carrying
// a .gitkeep. The keys are the `checks.dirs` / `checks.keeps` names from the host.
const DIR_LABELS: Array<[string, string, string]> = [
  ['chapters', 'chapters', '正文'],
  ['characters', 'characters', '角色'],
  ['world', 'world', '世界观'],
  ['outlines', 'outlines', '大纲'],
  ['foreshadowing', 'foreshadowing', '伏笔'],
  ['timeline', 'timeline', '时间线'],
  ['relations', 'relations', '关系'],
  ['facts', 'facts', '事实账本'],
  ['library', 'library', '资料'],
  ['index', 'index', '索引'],
]

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
  alignItems: 'baseline',
  gap: 10,
  padding: '14px 18px',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
  background: 'var(--dsw-alias-bg-layer-1)',
} as const

const bodyStyle = {
  display: 'grid',
  gridTemplateColumns: '240px minmax(0, 1fr) 240px',
  flex: 1,
  minHeight: 0,
} as const

const columnStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '14px',
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

function SectionTitle({ children }: { children: string }) {
  return <div style={{ ...muted, fontSize: 12, letterSpacing: 0.2 }}>{children}</div>
}

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      style={{
        width: 7,
        height: 7,
        borderRadius: '50%',
        display: 'inline-block',
        background: ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)',
      }}
    />
  )
}

export function Workbench() {
  const [status, setStatus] = useState<StatusValue | null>(null)
  const [chapters, setChapters] = useState<ChapterSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const result = await getJson<StatusValue>('/inkflow/api/status')
      if (!result.ok || result.value === undefined) {
        setError(describeRouteError(result.error))
        setStatus(null)
        setChapters([])
      } else {
        setStatus(result.value)
        setError(null)
        if (result.value.project?.usable === true) {
          const list = await getJson<{ total: number; chapters: ChapterSummary[] }>('/inkflow/api/chapters')
          setChapters(list.ok && list.value !== undefined ? list.value.chapters : [])
        } else {
          setChapters([])
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setStatus(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const project = status?.project ?? null
  const usable = project?.usable === true
  const counts = status?.index?.counts ?? {}
  const dirs = project?.checks.dirs

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <span style={{ fontSize: 16, fontWeight: 600 }}>InkFlow</span>
        <span style={muted}>{usable ? project?.label : '长篇小说创作工作台'}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Dot ok={loading ? false : usable} />
          <span style={muted}>{loading ? '检测中…' : usable ? '项目已就绪' : '未检测到 InkFlow 项目'}</span>
        </span>
      </div>

      <div style={bodyStyle}>
        <div style={columnStyle}>
          <SectionTitle>章节</SectionTitle>
          {chapters.length === 0 ? (
            <div style={cardStyle}>
              <span style={muted}>{usable ? 'chapters/ 还是空的。' : '先让工作目录成为 InkFlow 项目。'}</span>
            </div>
          ) : (
            chapters.map((chapter) => (
              <div key={chapter.id} style={cardStyle}>
                <div style={{ fontWeight: 600 }}>
                  {chapter.seq ?? '?'}. {chapter.title}
                </div>
                <div style={muted}>
                  {chapter.status} · {chapter.wordCount} 字
                </div>
              </div>
            ))
          )}
        </div>

        <div style={{ ...columnStyle, ...dividerStyle }}>
          <SectionTitle>正文</SectionTitle>
          <div style={{ ...cardStyle, flex: 1, display: 'grid', placeItems: 'center', borderStyle: 'dashed' }}>
            <div style={{ textAlign: 'center', ...muted }}>
              <div style={{ fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: 6 }}>P0 · 文件真相 + 派生索引</div>
              <div>正文在 chapters/ 里就是 Markdown；编辑器与提案制修订在 P1。</div>
            </div>
          </div>
          <div style={cardStyle}>
            <SectionTitle>项目诊断</SectionTitle>
            <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
              <div>根目录：{project?.root ?? '—'}</div>
              <div>
                索引：{status?.index === undefined ? '—' : status.index.dbExists ? `已建（${status.index.builtAt ?? '?'}）` : '缺失'}
              </div>
              <div>
                统计：正文 {counts['chapters'] ?? 0} · 角色 {counts['characters'] ?? 0} · 世界观{' '}
                {counts['worldEntries'] ?? 0} · 大纲 {counts['outlineNodes'] ?? 0}
              </div>
              {error !== null ? <div style={{ color: 'var(--dsw-alias-state-error-primary)' }}>错误：{error}</div> : null}
              {!usable && project !== null && project.missing.length > 0 ? (
                <div style={{ color: 'var(--dsw-alias-state-warn-primary)' }}>缺少：{project.missing.join('、')}</div>
              ) : null}
              {!usable ? <div style={muted}>在小说会话里先调 inkflow_project_plan 看「将创建什么」，确认后再调 inkflow_project_init（confirm: true）。</div> : null}
            </div>
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                onClick={() => void refresh()}
                style={{
                  border: '1px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-layer-2)',
                  color: 'var(--dsw-alias-label-primary)',
                  borderRadius: 6,
                  padding: '4px 10px',
                  cursor: 'pointer',
                }}
              >
                重新检测
              </button>
            </div>
          </div>
        </div>

        <div style={{ ...columnStyle, ...dividerStyle }}>
          <SectionTitle>目录约定</SectionTitle>
          <div style={{ display: 'grid', gap: 2 }}>
            {DIR_LABELS.map(([key, name, label]) => (
              <div key={key} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 2px' }}>
                <span>
                  {label} <span style={muted}>{name}/</span>
                </span>
                <span style={muted}>{dirs === undefined ? '—' : dirs[key] === true ? '✓' : '✗'}</span>
              </div>
            ))}
          </div>
          <SectionTitle>约定</SectionTitle>
          <div style={{ ...cardStyle, ...muted }}>
            一个小说 = 一个 git 仓库。插件只在「是 git 仓库 + 九个内容目录与 index/ 齐全（每项带 .gitkeep）+ inkflow.json
            可解析」时工作；目录名固定、不可配置。
          </div>
        </div>
      </div>
    </div>
  )
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Workbench)))
  ctx.effect(() =>
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => 'InkFlow' }, InkflowIcon),
    ),
  )
}
