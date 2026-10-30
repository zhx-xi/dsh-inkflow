/**
 * The workbench's visual primitives: theme-token styles, the badge/section/card
 * helpers, the build stamp and the stale-build banner.
 *
 * WHY IT IS A FILE: these are the pieces a reader has to trust when judging whether
 * the panel obeys the theme rule (every visible colour comes from a
 * `--dsw-alias-*` token). Keeping them together means that rule has one place to
 * check, and the data/assembly half does not have to carry a style table around.
 * They are also the only things the view re-uses from more than one place: the
 * banner and the stamp sit in the page header, the cards wrap the gate refusal.
 *
 * No state, no fetch, no decisions: constants, small components, and two helpers
 * that shape an answer the Host already gave (`panelBuild`, `findSessionWorkspace`).
 */

import type { ReactNode } from 'react'

import type { WorkspaceView } from './context.js'
import { SCROLL_COLUMN_STYLE } from './layout-model.js'
import { EMPTY_MESSAGES, describeBuildTime, shortBuild, staleWarning } from './panel-model.js'
import type { BadgeTone, PanelBuild } from './panel-model.js'

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

// The two-column body. Its HEIGHT comes from `SCROLL_BOX_STYLE` (spread at the use
// site, together with the measured variable), never from `flex: 1`: a zero flex
// basis overrides an explicit height, so `flex: 1` here silently undid the fix
// (measured: setting a 651px height left the grid at 2428px).
const bodyStyle = {
  display: 'grid',
  gridTemplateColumns: '260px minmax(0, 1fr)',
  minHeight: 0,
} as const

// Each column is its own scroll box: the tree can move without the body following.
const columnStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 14,
  ...SCROLL_COLUMN_STYLE,
} as const

const dividerStyle = { borderLeft: '1px solid var(--dsw-alias-border-l1)' } as const

const cardStyle = {
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 8,
  padding: '10px 12px',
  background: 'var(--dsw-alias-bg-layer-1)',
} as const

const muted = { color: 'var(--dsw-alias-label-secondary)' } as const

/**
 * The "title looks garbled" marker: theme warning colour, no badge —
 * it annotates the title next to it and must not compete with the state badge.
 */
const titleWarningStyle = {
  color: 'var(--dsw-alias-state-warn-primary)',
  fontSize: 12,
  cursor: 'help',
} as const

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
 * The stamp baked into THIS bundle (`scripts/build.mjs`).
 *
 * A fallback only: `/status` is authoritative, because the Host half is the code
 * that actually carries the tools and routes (and the one that can see the disk).
 * This value describes the panel bundle itself, so it is still shown while the
 * first answer is in flight. `undefined` when a test bundles this module without
 * the esbuild define — hence the `typeof` guard.
 */
declare const __INKFLOW_BUILD__: string | null
const CLIENT_BUILD: string | null = typeof __INKFLOW_BUILD__ === 'string' ? __INKFLOW_BUILD__ : null

/** The Host's summary first, then this bundle's own stamp; `null` = nothing to show. */
function panelBuild(build: PanelBuild | null): PanelBuild | null {
  if (build !== null) return build
  if (CLIENT_BUILD === null) return null
  return { version: null, build: CLIENT_BUILD, loadedAt: null, staleLoadedCode: false, diskBuildTime: null }
}

/** The stamp as the panel shows it: `build abc1234`, with the long form on hover. */
function BuildStamp({ build }: { build: PanelBuild | null }) {
  const shown = panelBuild(build)
  const label = shortBuild(shown?.build ?? null)
  if (shown === null || label === null) return null
  const detail = `build ${shown.build ?? '未知'} · 磁盘构建 ${describeBuildTime(shown.diskBuildTime)} · DSH 启动 ${describeBuildTime(shown.loadedAt)}`
  return (
    <span style={{ ...muted, ...mono }} title={detail}>
      build {label}
    </span>
  )
}

/**
 * The stale-build banner: the one thing an old generation can never
 * do for itself is announce that it is old — so this renders from the HOST's
 * verdict, above the tabs, on every state including the gate refusal.
 *
 * It is deliberately not dismissible and not clearable by 重新检测: only a
 * restart makes the process newer than the file on disk (see `staleWarning`).
 */
function StaleBuildBanner({ build }: { build: PanelBuild | null }) {
  const warning = staleWarning(build)
  if (warning === null) return null
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '8px 16px',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-state-warn-primary)',
        fontSize: 12,
      }}
    >
      <span aria-hidden="true">⚠</span>
      <span>{warning}</span>
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

/**
 * Render the page a non-default tab names (roadmap X-12).
 *
 * `undefined` renders nothing rather than falling back to the chapter tree: silently
 * showing the wrong page is harder to notice than an empty one, and "a live tab has
 * a page" is the contract `PANEL_TABS` and this map keep together.
 */
function renderExtraPage(registry: Readonly<Record<string, () => ReactNode>>, tab: string): ReactNode {
  const render = registry[tab]
  return render === undefined ? null : render()
}

export {
  Badge,
  BuildStamp,
  EmptyCard,
  SectionTitle,
  StaleBuildBanner,
  bodyStyle,
  buttonStyle,
  cardStyle,
  columnStyle,
  dividerStyle,
  findSessionWorkspace,
  headerStyle,
  mono,
  muted,
  panelStyle,
  renderExtraPage,
  titleWarningStyle,
  toneColor,
}
