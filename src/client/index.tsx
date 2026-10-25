/**
 * dsh-inkflow — Client half: the writing workbench panel (`conversation.view`,
 * issue #17) and the book hub entry (`sidebar.panellist` + `main`, issue #85).
 *
 * The build wraps this module in `window.__ModuleLoader__.load({id, factory})`
 * (see scripts/build.mjs); this file therefore exports the standard Client
 * plugin shape `{inject, apply}` and never touches the module loader itself.
 *
 * TWO ENTRIES, TWO SCOPES (ADR-0010 D1, which narrows ADR-0008 D1):
 *
 *   - the WORKBENCH is `conversation.view`: "this book's cockpit", and "this
 *     book" can only be derived from the conversation it is opened in.
 *   - the BOOK HUB is root-scoped (`sidebar.panellist` icon + `main` body). It
 *     has no session, so it names nothing: the book list comes from the Host's
 *     own workspace registry over `/inkflow/internal/hub/*` (ADR-0010 D2/D3).
 *     A remembered "last project" is still never a resolution source
 *     (ADR-0006 D5) — the registry is.
 *
 * WHAT TRAVELS TO THE HOST: a session id for the workbench routes, and nothing
 * at all for the hub routes. `setActiveSessionId` hands the id to
 * `fetchInternal`, which appends `?sessionId=` (D4); the hub calls
 * `fetchInternal(..., { sessionless: true })`, which `internal.ts` pins to
 * `/hub/*` so no session route can lose its session requirement. No `root`,
 * `path` or `cwd` is ever built here.
 *
 * WHAT IS STILL NOT HERE: the hub's new-book wizard (#86) and shared-content page
 * (#87) are disabled placeholders with their release note; the workbench's
 * setting/outline/foreshadowing tabs are the same. The wizard button in the
 * workbench only re-reads the read-only plan (`GET /status`), never applies it
 * (D5 / ADR-0006 D3).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ClientContext, ConversationViewProps, WorkspaceView } from './context.js'
import { fetchInternal, setActiveSessionId, writeInternal } from './internal.js'
import type { InternalResult } from './internal.js'
import { SCROLL_BOX_STYLE, SCROLL_COLUMN_STYLE } from './layout-model.js'
import { useScrollBox } from './layout.js'
import { EditorPane } from './editor.js'
import type { VolumeOption } from './editor.js'
import { LibraryView } from './library.js'
import type { LibraryFocus } from './library-model.js'
import { TrashView } from './trash.js'
import { ForeshadowView } from './foreshadow.js'
import { AuditView } from './audit.js'
// Issue #44: the seven quality gates for one chapter (ADR-0022 D4). Its own file, so the
// workbench's renderer map stays one line per page (X-12).
import { GateQualityView } from './gate.js'
import { ExtractView } from './extract.js'
import { BriefView } from './brief.js'
import { MapView } from './map.js'
// Issue #46: the review tab — recorded runs, opinions with their evidence, and the
// cross-model table. One file, one line in the page map below (X-12).
import { ReviewView } from './review.js'
import { PLACE_KIND } from './map-model.js'
import type { EvidenceJump } from './extract-model.js'
import type { AuditJumpTarget } from './audit-model.js'
import { HubIcon, HubView } from './hub.js'
import { createDirectoryPicker, setHubDirectoryPicker } from './hub-wizard.js'
import { HUB_PANEL_ID, HUB_PANEL_LABEL, HUB_PANEL_ORDER } from './hub-model.js'
import {
  EMPTY_MESSAGES,
  PANEL_TABS,
  buildChapterTree,
  chapterHeading,
  describeAction,
  describeBuildTime,
  describeFacts,
  describeRouteError,
  describeTitleSuspicion,
  emptyKindOf,
  flattenChapters,
  projectFacts,
  readBuild,
  readGate,
  relativeProjectRoot,
  shortBuild,
  staleWarning,
} from './panel-model.js'
import type { BadgeTone, ChapterDetailValue, ChaptersValue, PanelBuild, PanelGate, StatusValue } from './panel-model.js'
import {
  SEARCH_HINT,
  SEARCH_PAGE_LIMIT,
  describeSearchDegradation,
  describeSearchPage,
  searchBackendLabel,
  readSearchPage,
  searchHitLabel,
  searchHitTarget,
  searchRequestPath,
} from './search-model.js'
import type { SearchHit, SearchPage } from './search-model.js'

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
 * The "title looks garbled" marker (issue #89): theme warning colour, no badge —
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
 * The stamp baked into THIS bundle (`scripts/build.mjs`, issue #88).
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
 * The stale-build banner (issue #88): the one thing an old generation can never
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

export function InkflowView({ sessionId, useSessions, useSession, useWorkspaces }: ConversationViewProps) {
  const workspaceItems = useWorkspaces((state) => state.items)
  const sessionsById = useSessions((state) => state.byId)
  // Only used to say "still opening" instead of claiming the panel is empty:
  // shipped Views read `snapshot.openState === 'loading'` the same way.
  const sessionOpenState = useSession((snapshot) => snapshot.openState)

  const [status, setStatus] = useState<InternalResult<StatusValue> | null>(null)
  const [chapters, setChapters] = useState<ChaptersValue | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  // Keyed by chapter id: after switching chapters, the previous chapter's detail
  // must never seed the editor — that would put book A's prose in book B's file.
  const [detail, setDetail] = useState<{ id: string; value: ChapterDetailValue } | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [planVisible, setPlanVisible] = useState(false)
  // Which declared tab is open. Only `available` tabs are switchable, so this
  // never names a page that does not exist (issue #30 added 设定库).
  const [tab, setTab] = useState('chapters')
  // One entry the current tab wants the setting library to open (#33's audit rows). The
  // nonce makes a repeated request for the same entry a *new* prop, so the library re-selects
  // it instead of ignoring an equal value.
  const [libraryFocus, setLibraryFocus] = useState<LibraryFocus | null>(null)
  // New-chapter form (issue #19): title + volume, nothing else.
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newVolume, setNewVolume] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  // The chapter body states its own height (issue 116): the slot wrapper above the
  // panel is content-sized, so a percentage height resolves to the content and both
  // columns stop scrolling. Measured at runtime, `100%` when it cannot be measured.
  const scrollBox = useScrollBox()

  const workspace = useMemo(() => findSessionWorkspace(workspaceItems, sessionId), [workspaceItems, sessionId])
  const sessionCwd = sessionsById?.[sessionId]?.cwd ?? null

  const refresh = useCallback(async () => {
    setLoading(true)
    // The session id is the ONLY thing the panel tells the Host (ADR-0008 D4).
    setActiveSessionId(sessionId)
    // Issue #88: 重新检测 re-reads `/status`, which recomputes the stale verdict
    // from the disk mtime. It therefore cannot CLEAR the banner: a rebuilt
    // `lib/` is still newer than this process, and only a restart fixes that.
    // Nothing here may pretend the refresh made the old generation new.
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

  // One chapter, with its CAS baseline (`fingerprint`): the editor saves against
  // exactly the bytes the Host handed over (issue #19).
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
        setDetail({ id: selected, value: result.value ?? {} })
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
  // Issue #88: which generation answered, read from `value` or `error` — the
  // refusal screen is exactly where a stale build hides a healthy book.
  const build = useMemo(() => readBuild(status), [status])
  const tree = useMemo(() => buildChapterTree(chapters), [chapters])
  // Derived state the gate answer already carried: shown, never acted upon.
  const facts = useMemo(() => projectFacts(status), [status])
  const empty = emptyKindOf(gate, tree.total, selected !== null)

  // -------------------------------------------------------------------------
  // Search (#39, X-16/X-20). One box in the 章节 tab and a 「全部类型」 switch
  // beside it — no seventh tab: searching the book is a way to read this page.
  // The switch changes the SCOPE (chapters only vs the whole book), never the
  // result shape, so the list below renders one kind of row either way.
  // -------------------------------------------------------------------------
  const [searchText, setSearchText] = useState('')
  const [searchAllKinds, setSearchAllKinds] = useState(false)
  const [searchPage, setSearchPage] = useState<SearchPage | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searching, setSearching] = useState(false)
  const searchQuery = searchText.trim()
  const searchActive = searchQuery !== ''

  useEffect(() => {
    if (!searchActive) {
      setSearchPage(null)
      setSearchError(null)
      setSearching(false)
      return
    }
    if (gate.usable !== true) return
    let live = true
    setSearching(true)
    // Typing is the input: a short debounce keeps the Host from being asked once
    // per keystroke, and `live` drops a reply that a newer keystroke has outdated.
    const timer = setTimeout(() => {
      void (async () => {
        const result = await fetchInternal<unknown>(searchRequestPath(searchQuery, searchAllKinds, { limit: SEARCH_PAGE_LIMIT }), {
          sessionId,
        })
        if (!live) return
        setSearching(false)
        if (result.ok) {
          setSearchPage(readSearchPage(result.value))
          setSearchError(null)
        } else {
          setSearchPage(null)
          setSearchError(describeRouteError(result.error))
        }
      })()
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [searchActive, searchQuery, searchAllKinds, gate.usable, sessionId])

  /**
   * A click on a hit: chapter prose opens in this page's editor, anything from the
   * setting library jumps to that tab with the entry selected (the same hand-off the
   * audit report uses, #33). The search text is left alone so the list survives.
   */
  const openSearchHit = useCallback((hit: SearchHit): void => {
    const target = searchHitTarget(hit)
    if (target.kind === 'chapter') {
      setSelected(target.chapterId)
      return
    }
    setLibraryFocus({ kind: target.entityKind, id: target.id, nonce: Date.now() })
    setTab('library')
  }, [])

  // Volumes for the editor's "which volume" picker and the new-chapter form.
  const volumes: VolumeOption[] = useMemo(
    () => tree.groups.map((group) => ({ volumeId: group.volumeId, title: group.title })),
    [tree.groups],
  )

  // The project root relative to this session's workspace; the Host reported the
  // absolute path, the workspace came from the Client store.
  const rootLabel = relativeProjectRoot(gate.root, workspace?.path ?? sessionCwd)
  const projectTitle = gate.projectTitle ?? workspace?.title ?? null
  // Issue #89: a hand-written meta can carry a GBK-misread title. One marker and
  // one tooltip — the panel has no way to fix the file itself, so it says so.
  const titleWarning = describeTitleSuspicion(gate)
  const routeHint = status !== null && !status.ok ? describeRouteError(status.error) : null

  /**
   * Every tab that is not `chapters` renders from this map (roadmap X-12).
   *
   * `chapters` stays inline below: it is the default page and carries the editor,
   * the scroll box and most of this component's state, so extracting it would move
   * ~160 lines for no gain. Every *other* page is one line here — a new panel adds
   * its entry and its component file and never edits the render tree.
   *
   * `PANEL_TABS` decides what a user can click (`available`), this map decides what
   * exists. A live tab with no page here renders nothing, which is why the two are
   * meant to be changed in the same commit.
   */
  /**
   * Take the reader to an audit finding's target (#33): a chapter opens in this page's own
   * editor, an entity opens in the setting library.
   *
   * Lives here rather than in the audit page because the two destinations are *this*
   * component's state (the selected chapter) and another page's props (the library's focus).
   * An audit row therefore carries an address, and the workbench decides what an address
   * means — the report never guesses a route.
   */
  const openFromAudit = useCallback((target: AuditJumpTarget): void => {
    if (target.kind === 'chapter') {
      setTab('chapters')
      setSelected(target.chapterId)
      return
    }
    // A new nonce so that asking for the same entry twice still re-focuses it (React would
    // otherwise see an equal prop and skip the effect that selects the row).
    setLibraryFocus({ kind: target.entityKind, id: target.id, nonce: Date.now() })
    setTab('library')
  }, [])

  /**
   * Take the reader to a candidate's evidence (#38): the same rule as an audit finding —
   * an address is resolved by the workbench, because "which chapter is this?" is this
   * component's own state (the chapter tree) and not the queue's.
   */
  const openFromEvidence = useCallback(
    (jump: EvidenceJump): void => {
      const rows = flattenChapters(chapters)
      const hit =
        rows.find((chapter) => jump.chapterId !== undefined && chapter.id === jump.chapterId) ??
        rows.find((chapter) => jump.path !== undefined && chapter.path === jump.path)
      if (hit === undefined) return
      setTab('chapters')
      setSelected(hit.id)
    },
    [chapters],
  )

  /**
   * Take the reader from a map pin to the entry it stands for (#48).
   *
   * Same rule as an audit row: the pin carries `(kind, id)` and the **workbench** decides
   * what that means — for a place it always means "open it in 设定库", because the map is a
   * view over the world book and holds no copy of the entry (ADR-0025 D4). A new nonce so a
   * second click on the same pin re-focuses it.
   */
  const openFromMap = useCallback((pin: { id: string }): void => {
    setLibraryFocus({ kind: PLACE_KIND, id: pin.id, nonce: Date.now() })
    setTab('library')
  }, [])

  const pageRenderers: Readonly<Record<string, () => ReactNode>> = {
    // Issue #30: the setting library — eight-kind tree, one entry's detail, the
    // editor and the problem panel. It talks to its own three routes, so this tab
    // costs the chapter tree nothing.
    library: () => <LibraryView sessionId={sessionId} focus={libraryFocus} />,
    // Issue #35: the recovery bin — what a delete moved into `.inkflow/trash/`,
    // with restore (one click) and purge (two). One route pair of its own.
    trash: () => <TrashView sessionId={sessionId} />,
    // Issue #31: the read-only foreshadow board (超期 / 未回收 / 按角色).
    foreshadowing: () => <ForeshadowView sessionId={sessionId} />,
    // Issue #33: the five-family consistency audit — counts, findings with their
    // addresses, and the Markdown export into `.inkflow/audit/`.
    audit: () => <AuditView sessionId={sessionId} onOpen={openFromAudit} />,
    // Issue #38 (X-20): the extraction queue — accept or reject what the session model
    // proposed. Its own four routes, so it costs the other pages nothing.
    candidates: () => <ExtractView sessionId={sessionId} onOpenEvidence={openFromEvidence} />,
    // Issue #43 (X-12/X-23): the nine-segment brief — every segment with its size, share
    // and trim state, the trim ladder's record, the rendered block, and the one write that
    // records it into `.inkflow/audit/brief-<chapterId>.json`.
    brief: () => <BriefView sessionId={sessionId} />,
    // #48: 地图 — places grouped by the world book's own categories, one click to the
    // entry. It reuses 设定库's projection (a place IS a world entry, ADR-0025 D4) and
    // jumps the way an audit row does, so it adds no route and no second truth.
    map: () => <MapView sessionId={sessionId} onOpen={openFromMap} />,
    // Issue #44: the seven quality gates for one chapter — counts per check, every finding
    // with its address and hint, filtered by severity. `GET /gate` is read-only, so this tab
    // cannot change the book or the conclusion file.
    gate: () => <GateQualityView sessionId={sessionId} />,
    // Issue #46: the review runs of one chapter — which passes exist, what each dimension
    // said with its evidence, and the cross-model table. Read-only (`GET /review`), and it
    // jumps through the same `openFromEvidence` an extracted candidate uses, because an
    // address is resolved by the workbench and never by the page that printed it.
    review: () => <ReviewView sessionId={sessionId} onOpenEvidence={openFromEvidence} />,
  }

  /**
   * Create one chapter. Only a title is required; `volumeId` is omitted for a
   * loose chapter (the Host treats `null` and "absent" the same, but the panel
   * sends nothing rather than inventing a volume).
   */
  const createChapter = async (): Promise<void> => {
    const payload: Record<string, unknown> = { title: newTitle }
    if (newVolume !== '') payload['volumeId'] = newVolume
    const result = await writeInternal<{ chapter?: { chapterId?: string } }>('/chapters', payload, { sessionId })
    if (!result.ok) {
      setCreateError(describeRouteError(result.error))
      return
    }
    const created = result.value?.chapter?.chapterId
    setCreateError(null)
    setCreating(false)
    setNewTitle('')
    await refresh()
    if (typeof created === 'string' && created !== '') setSelected(created)
  }

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>InkFlow</span>
        <span style={muted}>{projectTitle ?? '长篇小说创作工作台'}</span>
        {titleWarning === null ? null : (
          <span style={titleWarningStyle} title={titleWarning} aria-label={titleWarning} role="img">
            ⚠
          </span>
        )}
        <Badge label={gate.label} tone={gate.tone} />
        <span style={{ ...muted, ...mono }} title={gate.root ?? undefined}>
          {rootLabel ?? '—'}
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <BuildStamp build={build} />
          <span style={{ ...muted, ...mono }}>
            {loading ? '检测中…' : sessionOpenState === 'loading' ? '会话打开中…' : `会话 …${sessionId.slice(-8)}`}
          </span>
          <button type="button" style={buttonStyle} onClick={() => void refresh()}>
            重新检测
          </button>
        </span>
      </div>

      <StaleBuildBanner build={build} />

      <div style={tabRowStyle}>
        {PANEL_TABS.map((entry) =>
          entry.available ? (
            // A live tab is a real switch between pages that exist in this build.
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              aria-pressed={tab === entry.id}
              style={{
                border: 'none',
                background: 'transparent',
                color: tab === entry.id ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                padding: '6px 4px',
                fontSize: 12,
                cursor: 'pointer',
                borderBottom: tab === entry.id ? '2px solid var(--dsw-alias-label-primary)' : '2px solid transparent',
              }}
            >
              {entry.label}
            </button>
          ) : (
            // Disabled on purpose: no page exists yet, so a live tab would be a
            // dead button. The note is the tooltip and the visible sub-label.
            <button
              key={entry.id}
              type="button"
              disabled
              title={entry.note}
              style={{
                border: 'none',
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                padding: '6px 4px',
                fontSize: 12,
                cursor: 'not-allowed',
              }}
            >
              {entry.label}
              <span style={{ ...muted, marginLeft: 4 }}>{entry.note}</span>
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
      ) : tab !== 'chapters' ? (
        // Extra pages (roadmap X-12): one entry per tab in `pageRenderers` above.
        // A new panel adds ONE line to that map plus its component file and touches
        // nothing here — two pages landing in the same milestone then never collide
        // inside the render tree.
        renderExtraPage(pageRenderers, tab)
      ) : (
        <div ref={scrollBox.ref} style={{ ...bodyStyle, ...SCROLL_BOX_STYLE, ...scrollBox.style }}>
          <div style={columnStyle}>
            {/* Search box (#39): the 「全部类型」 switch sits beside it and only widens
                the scope. Typing replaces the tree below with the hit list — the page
                stays one page (X-20), which is why there is no new tab. */}
            <div style={{ display: 'grid', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  aria-label="全库搜索"
                  value={searchText}
                  placeholder="搜索正文与设定…"
                  onChange={(event) => setSearchText(event.target.value)}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    border: '1px solid var(--dsw-alias-border-l1)',
                    borderRadius: 6,
                    background: 'var(--dsw-alias-bg-base)',
                    color: 'var(--dsw-alias-label-primary)',
                    padding: '3px 6px',
                    fontSize: 12,
                  }}
                />
                {searchActive ? (
                  <button type="button" style={buttonStyle} onClick={() => setSearchText('')}>
                    清空
                  </button>
                ) : null}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, ...muted, fontSize: 12 }}>
                <input
                  type="checkbox"
                  aria-label="搜索全部类型"
                  checked={searchAllKinds}
                  onChange={(event) => setSearchAllKinds(event.target.checked)}
                />
                全部类型（正文之外的设定条目也一起搜）
              </label>
            </div>
            {searchActive ? (
              <div style={{ display: 'grid', gap: 4 }}>
                {searching ? <div style={muted}>搜索中…</div> : null}
                {searchError === null ? null : (
                  <div style={{ ...cardStyle, borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' }}>
                    {searchError}
                  </div>
                )}
                {searchPage === null ? null : (
                  <>
                    <div style={muted}>
                      {describeSearchPage(searchPage, searchQuery, searchAllKinds)}
                      {' · '}
                      {searchBackendLabel(searchPage)}
                    </div>
                    {(() => {
                      const degraded = describeSearchDegradation(searchPage)
                      return degraded === null ? null : <div style={{ ...muted, fontSize: 12 }}>{degraded}</div>
                    })()}
                    {searchPage.items.map((hit) => (
                      <button
                        key={`${hit.kind}:${hit.id}`}
                        type="button"
                        onClick={() => openSearchHit(hit)}
                        style={{
                          ...buttonStyle,
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          paddingLeft: 8,
                          borderColor: 'transparent',
                        }}
                      >
                        <div>{searchHitLabel(hit)}</div>
                        {hit.snippet === '' ? null : <div style={{ ...muted, fontSize: 12 }}>{hit.snippet}</div>}
                        <div style={{ ...muted, ...mono, fontSize: 11 }}>{hit.path}</div>
                      </button>
                    ))}
                    {searchPage.items.length === 0 ? null : <div style={{ ...muted, fontSize: 12 }}>{SEARCH_HINT}</div>}
                  </>
                )}
              </div>
            ) : (
              <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <SectionTitle>章节树（卷 → 章）</SectionTitle>
              <button
                type="button"
                style={{ ...buttonStyle, marginLeft: 'auto' }}
                onClick={() => {
                  setCreating(true)
                  setCreateError(null)
                }}
              >
                新建章
              </button>
            </div>
            {creating ? (
              <div style={cardStyle}>
                <div style={{ display: 'grid', gap: 6 }}>
                  <input
                    aria-label="新章节标题"
                    value={newTitle}
                    placeholder="章节标题"
                    onChange={(event) => setNewTitle(event.target.value)}
                    style={{
                      border: '1px solid var(--dsw-alias-border-l1)',
                      borderRadius: 6,
                      background: 'var(--dsw-alias-bg-base)',
                      color: 'var(--dsw-alias-label-primary)',
                      padding: '3px 6px',
                      fontSize: 12,
                    }}
                  />
                  <select
                    aria-label="新章节所属卷"
                    value={newVolume}
                    onChange={(event) => setNewVolume(event.target.value)}
                    style={{
                      border: '1px solid var(--dsw-alias-border-l1)',
                      borderRadius: 6,
                      background: 'var(--dsw-alias-bg-base)',
                      color: 'var(--dsw-alias-label-primary)',
                      padding: '3px 6px',
                      fontSize: 12,
                    }}
                  >
                    <option value="">未分卷</option>
                    {volumes.map((volume) => (
                      <option key={volume.volumeId} value={volume.volumeId}>
                        {volume.volumeId} {volume.title}
                      </option>
                    ))}
                  </select>
                  <span style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      style={buttonStyle}
                      disabled={newTitle.trim() === ''}
                      onClick={() => void createChapter()}
                    >
                      创建
                    </button>
                    <button
                      type="button"
                      style={buttonStyle}
                      onClick={() => {
                        setCreating(false)
                        setCreateError(null)
                      }}
                    >
                      取消
                    </button>
                  </span>
                  {createError === null ? null : (
                    <span style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>{createError}</span>
                  )}
                </div>
              </div>
            ) : null}
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
              </>
            )}
          </div>

          <div style={{ ...columnStyle, ...dividerStyle }}>
            <SectionTitle>正文（Markdown 编辑器）</SectionTitle>
            {selected === null ? <EmptyCard kind="no-selection" /> : null}
            {detailError === null ? null : (
              <div style={{ ...cardStyle, borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' }}>
                {detailError}
              </div>
            )}
            {detail === null || detail.id !== selected || selected === null ? null : (
              // `key` = chapter id: switching chapters remounts the editor so no
              // undo history or baseline can leak from one chapter into another.
              <EditorPane
                key={selected}
                sessionId={sessionId}
                chapterId={selected}
                detail={detail.value}
                volumes={volumes}
                onSaved={() => void refresh()}
                onGone={() => {
                  setSelected(null)
                  void refresh()
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export const inject = ['slots']

/**
 * TWO entries, each with its own job (ADR-0010 D1):
 *
 *   `conversation.view` / id `inkflow` / order 40 — the **writing workbench** for
 *     the book the session belongs to. `id: 'inkflow'` puts it beside
 *     对话 / 轨迹 (chat 0, trajectory 10) and is stable: user patches address it
 *     by that id.
 *
 *   `sidebar.panellist` / id `inkflow-hub` / order 35 + `main` / key `inkflow-hub`
 *     — the **book hub**. A root-scoped icon is only half an entry point: the
 *     sidebar renders the glyph from `sidebar.panellist` and the BODY from the
 *     keyed `main` slot under the same id, so registering one without the other
 *     is exactly the "有图标没页面" failure (AGENTS.md §8 陷阱 3; measured on
 *     0.2.1-rc.2 — selecting a missing `main` key throws "main panel … is not
 *     registered"). The hub carries no content view and no write action: it lists
 *     books and their gate state, and every write stays in the workbench or the
 *     wizard (#86/#87).
 */
export function apply(ctx: ClientContext): void {
  // The hub's wizard is the only Client surface that needs a SERVICE (the
  // directory picker), not a slot: hand it over before either hub entry
  // registers, so the first click already has it (issue #86 / ADR-0010 E6).
  setHubDirectoryPicker(createDirectoryPicker((name) => ctx.get?.(name)))

  ctx.effect(() =>
    ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({ name: 'conversation.view', id: 'inkflow', order: 40, label: () => 'InkFlow' }, InkflowView),
    ),
  )
  ctx.effect(() =>
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        { name: 'sidebar.panellist', id: HUB_PANEL_ID, order: HUB_PANEL_ORDER, label: () => HUB_PANEL_LABEL },
        HubIcon,
      ),
    ),
  )
  ctx.effect(() =>
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: HUB_PANEL_ID }, HubView)),
  )
}
