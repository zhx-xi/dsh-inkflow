/**
 * dsh-inkflow — Client half (Workbench).
 *
 * The build wraps this module in `window.__ModuleLoader__.load({id, factory})`
 * (see scripts/build.mjs); this file therefore exports the standard Client
 * plugin shape `{inject, apply}` and never touches the module loader itself.
 *
 * P0 scope: the left sidebar icon and one workbench page that proves the
 * page -> Host route -> SQLite round trip. Layout: chapter tree (left), editor
 * (center), seven-category library tree (right) — all placeholders in P0.
 */

import { useCallback, useEffect, useState } from 'react'
import type { ClientContext, SidebarPanelIconProps } from './context.js'

const PANEL_ID = 'inkflow'

interface HealthValue {
  pluginVersion: string
  dataDir: string
  dbFile: string
  schemaVersion: number
  projectCount: number
}

interface ProjectSummary {
  id: string
  title: string
  status: string
  wordCount: number
  chapterCount: number
  updatedAt: string
}

interface RouteResult<T> {
  ok: boolean
  value?: T
  error?: { code: string; message?: string }
}

async function getJson<T>(path: string): Promise<RouteResult<T>> {
  const response = await fetch(path, { headers: { accept: 'application/json' } })
  const body = (await response.json()) as RouteResult<T>
  if (!response.ok || body.ok !== true) {
    return { ok: false, error: body.error ?? { code: `http-${response.status}` } }
  }
  return body
}

/** Sidebar icon: a page with a falling ink drop. Monochrome via currentColor. */
function InkflowIcon({ size }: SidebarPanelIconProps) {
  const edge = typeof size === 'number' && size > 0 ? size : 20
  return (
    <svg
      width={edge}
      height={edge}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block' }}
    >
      <path
        d="M5.5 3.75h9l4 4v12.5a.75.75 0 0 1-.75.75h-12a.75.75 0 0 1-.75-.75V4.5a.75.75 0 0 1 .75-.75Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M14.25 3.9v4.1h4.1" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M8.6 12.4h6.8M8.6 15.6h4.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M17.6 14.2c1.3 1.4 2 2.3 2 3.2a2 2 0 1 1-4 0c0-.9.7-1.8 2-3.2Z"
        fill="currentColor"
        opacity="0.9"
      />
    </svg>
  )
}

const LIBRARY_CATEGORIES = [
  ['world', '世界观'],
  ['character', '人物'],
  ['outline', '大纲'],
  ['timeline', '时间线'],
  ['foreshadow', '伏笔'],
  ['relation', '知识关系'],
  ['map', '地图'],
] as const

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
  gridTemplateColumns: '220px minmax(0, 1fr) 240px',
  gap: 0,
  flex: 1,
  minHeight: 0,
} as const

const columnStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '14px 14px',
  minHeight: 0,
  overflowY: 'auto',
} as const

const dividerStyle = {
  borderLeft: '1px solid var(--dsw-alias-border-l1)',
} as const

const emptyStyle = {
  border: '1px dashed var(--dsw-alias-border-l2)',
  borderRadius: 8,
  padding: '14px 12px',
  color: 'var(--dsw-alias-label-secondary)',
  background: 'var(--dsw-alias-bg-layer-2)',
} as const

function SectionTitle({ children }: { children: string }) {
  return (
    <div
      style={{
        fontSize: 12,
        letterSpacing: 0.2,
        textTransform: 'uppercase',
        color: 'var(--dsw-alias-label-secondary)',
      }}
    >
      {children}
    </div>
  )
}

function Dot({ tone }: { tone: 'ok' | 'warn' | 'idle' }) {
  const color =
    tone === 'ok'
      ? 'var(--dsw-alias-state-success-primary)'
      : tone === 'warn'
        ? 'var(--dsw-alias-state-warn-primary)'
        : 'var(--dsw-alias-state-idle-primary)'
  return (
    <span
      style={{ width: 7, height: 7, borderRadius: '50%', background: color, display: 'inline-block' }}
    />
  )
}

export function Workbench() {
  const [health, setHealth] = useState<HealthValue | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [healthResult, projectResult] = await Promise.all([
        getJson<HealthValue>('/inkflow/api/health'),
        getJson<{ total: number; projects: ProjectSummary[] }>('/inkflow/api/projects'),
      ])
      if (!healthResult.ok || healthResult.value === undefined) {
        setError(healthResult.error?.code ?? 'health-unavailable')
        setHealth(null)
      } else {
        setHealth(healthResult.value)
        setError(null)
      }
      if (projectResult.ok === true && projectResult.value !== undefined) {
        setProjects(projectResult.value.projects)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setHealth(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const connected = health !== null && error === null

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <span style={{ fontSize: 16, fontWeight: 600 }}>InkFlow</span>
        <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>长篇小说创作工作台</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Dot tone={loading ? 'idle' : connected ? 'ok' : 'warn'} />
          <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>
            {loading ? '正在连接本地库…' : connected ? '本地库已连接' : '本地库不可用'}
          </span>
        </span>
      </div>

      <div style={bodyStyle}>
        <div style={columnStyle}>
          <SectionTitle>章节</SectionTitle>
          <div style={emptyStyle}>
            还没有章节。
            <br />
            P1 在此挂载 卷 / 章 树与状态标记。
          </div>
        </div>

        <div style={{ ...columnStyle, ...dividerStyle }}>
          <SectionTitle>正文</SectionTitle>
          <div style={{ ...emptyStyle, flex: 1, display: 'grid', placeItems: 'center' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>P0 骨架已就位</div>
              <div>P1 在此挂载章节编辑器、字数统计与版本对比。</div>
            </div>
          </div>
          <div style={emptyStyle}>
            <SectionTitle>P0 自检</SectionTitle>
            <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
              <div>状态：{connected ? 'Host 路由 + SQLite 正常' : `异常：${error ?? 'unknown'}`}</div>
              <div>数据目录：{health?.dataDir ?? '—'}</div>
              <div>数据库：{health?.dbFile ?? '—'}</div>
              <div>
                架构版本：{health === null ? '—' : `v${health.schemaVersion}`} · 项目数：
                {health === null ? '—' : health.projectCount}
              </div>
              <div>插件版本：{health?.pluginVersion ?? '—'}</div>
            </div>
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                onClick={() => void refresh()}
                style={{
                  border: '1px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  color: 'var(--dsw-alias-label-primary)',
                  borderRadius: 6,
                  padding: '4px 10px',
                  cursor: 'pointer',
                }}
              >
                重新自检
              </button>
            </div>
          </div>
        </div>

        <div style={{ ...columnStyle, ...dividerStyle }}>
          <SectionTitle>资料库</SectionTitle>
          <div style={{ display: 'grid', gap: 2 }}>
            {LIBRARY_CATEGORIES.map(([key, label]) => (
              <div
                key={key}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '5px 8px',
                  borderRadius: 6,
                  color: 'var(--dsw-alias-label-primary)',
                  background: 'transparent',
                }}
              >
                <span>{label}</span>
                <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>0</span>
              </div>
            ))}
          </div>
          <SectionTitle>项目</SectionTitle>
          {projects.length === 0 ? (
            <div style={emptyStyle}>还没有项目。可让 Agent 调用 inkflow_project_create 创建。</div>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              {projects.map((project) => (
                <div key={project.id} style={emptyStyle}>
                  <div style={{ fontWeight: 600 }}>{project.title}</div>
                  <div style={{ color: 'var(--dsw-alias-label-secondary)' }}>
                    {project.status} · {project.chapterCount} 章 / {project.wordCount} 字
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ctx.effect(() =>
    ctx.slots.inject('main', () =>
      ctx.slots.register({ name: 'main', key: PANEL_ID }, Workbench),
    ),
  )
  ctx.effect(() =>
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          label: () => 'InkFlow',
        },
        InkflowIcon,
      ),
    ),
  )
}
