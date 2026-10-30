/**
 * The workbench's data assembly: one hook that owns every piece of state the page
 * renders, the three effects that fetch it, the derived values the Host's answer
 * already implies, and the address-resolution callbacks other pages hand addresses
 * to.
 *
 * WHY IT IS A FILE: it is the whole `fetch /inkflow/internal/*` and model-selection
 * half of the old `index.tsx` — "what is on screen" and "how it got there" were the
 * two things a reader had to untangle in one 600-line component. Splitting them
 * makes the React rules visible in one place: every hook here is declared before
 * any return (the guards' AST check would fail the build otherwise), and the view
 * file has no effects at all.
 *
 * WHAT IS STILL NOT HERE: any JSX, any page component, and any file IO. The session
 * id is the only thing this file hands the Host (ADR-0008 D4); no `root`, `path`
 * or `cwd` is ever built here.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import type { ConversationViewProps } from './context.js'
import { fetchInternal, setActiveSessionId, writeInternal } from './internal.js'
import type { InternalResult } from './internal.js'
import { useScrollBox } from './layout.js'
import { findSessionWorkspace } from './panel-chrome.js'
import type { VolumeOption } from './editor.js'
import type { LibraryFocus } from './library-model.js'
import type { AuditJumpTarget } from './audit-model.js'
import type { EvidenceJump } from './extract-model.js'
import { PLACE_KIND } from './map-model.js'
import { tabForEntityKind } from './outline-model.js'
import {
  buildChapterTree,
  describeRouteError,
  describeTitleSuspicion,
  emptyKindOf,
  flattenChapters,
  projectFacts,
  readBuild,
  readGate,
  relativeProjectRoot,
} from './panel-model.js'
import type { ChapterDetailValue, ChaptersValue, PanelBuild, PanelGate, StatusValue } from './panel-model.js'
import { SEARCH_PAGE_LIMIT, readSearchPage, searchHitTarget, searchRequestPath } from './search-model.js'
import type { SearchHit, SearchPage } from './search-model.js'

export function useWorkbench({ sessionId, useSessions, useSession, useWorkspaces }: ConversationViewProps) {
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
  // Which declared tab is open: `available` decides, so this never names a page that
  // does not exist.
  const [tab, setTab] = useState('chapters')
  // One entry another tab wants the setting library to open (the audit rows). The
  // nonce makes a repeated request for the same entry a *new* prop, so the library re-selects
  // it instead of ignoring an equal value.
  const [libraryFocus, setLibraryFocus] = useState<LibraryFocus | null>(null)
  // New-chapter form: title + volume, nothing else.
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newVolume, setNewVolume] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  // The chapter body states its own height (issue 116): the slot wrapper above the panel
  // is content-sized, so a percentage height resolves to the content and nothing scrolls.
  const scrollBox = useScrollBox()

  const workspace = useMemo(() => findSessionWorkspace(workspaceItems, sessionId), [workspaceItems, sessionId])
  const sessionCwd = sessionsById?.[sessionId]?.cwd ?? null

  const refresh = useCallback(async () => {
    setLoading(true)
    // The session id is the ONLY thing the panel tells the Host (ADR-0008 D4).
    setActiveSessionId(sessionId)
    // 重新检测 re-reads `/status`, which recomputes the stale verdict
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

  // One chapter, with its CAS baseline (`fingerprint`): the editor saves against exactly
  // the bytes the Host handed over, never a re-serialised copy.
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
  // Which generation answered: the refusal screen is where a stale build hides a healthy book.
  const build = useMemo(() => readBuild(status), [status])
  const tree = useMemo(() => buildChapterTree(chapters), [chapters])
  // Derived state the gate answer already carried: shown, never acted upon.
  const facts = useMemo(() => projectFacts(status), [status])
  const empty = emptyKindOf(gate, tree.total, selected !== null)

  // -------------------------------------------------------------------------
  // Search (X-16/X-20): one box in the 章节 tab and a 「全部类型」 switch beside it —
  // searching the book is a way to read this page, not a tab. The switch changes the
  // SCOPE (chapters only vs the whole book), never the result shape.
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
   * setting library jumps to the tab that owns its kind with the entry selected (the
   * same hand-off an audit finding uses). The search text is left alone.
   */
  const openSearchHit = useCallback((hit: SearchHit): void => {
    const target = searchHitTarget(hit)
    if (target.kind === 'chapter') {
      setSelected(target.chapterId)
      return
    }
    setLibraryFocus({ kind: target.entityKind, id: target.id, nonce: Date.now() })
    setTab(tabForEntityKind(target.entityKind))
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
  // A hand-written meta can carry a GBK-misread title: one marker, one tooltip (the panel cannot fix it).
  const titleWarning = describeTitleSuspicion(gate)
  const routeHint = status !== null && !status.ok ? describeRouteError(status.error) : null


  /**
   * Take the reader to an address: a chapter opens in this page's own editor, a setting
   * opens the page that owns its kind (`tabForEntityKind`).
   *
   * Lives here rather than in the reporting page because the destinations are *this*
   * component's state (the selected chapter) and another page's props (its focus): a report
   * prints an address, and the workbench decides what an address means.
   */
  const openAddress = useCallback((address: { kind: string; id?: string; path?: string }): void => {
    // A new nonce: asking for the same entry twice must still re-focus it (React skips an equal prop).
    setLibraryFocus({ ...address, nonce: Date.now() })
    setTab(tabForEntityKind(address.kind))
  }, [])
  const openFromAudit = useCallback(
    (target: AuditJumpTarget): void => {
      if (target.kind === 'chapter') {
        setTab('chapters')
        setSelected(target.chapterId)
        return
      }
      openAddress({ kind: target.entityKind, id: target.id })
    },
    [openAddress],
  )
  // A problem row knows a path and nothing else, so that address travels without an id.
  const openMovedKind = useCallback((kind: string, path: string): void => openAddress({ kind, path }), [openAddress])

  /**
   * Take the reader to a candidate's evidence: the same rule as an audit finding — the workbench
   * resolves an address, because "which chapter is this?" is this component's own state.
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
   * Take the reader from a map pin to the entry it stands for.
   *
   * Same rule as an audit row: the pin carries `(kind, id)` and the **workbench** decides
   * what that means — a place is a `world` entry, so it opens in 设定库, because the map is
   * a view over the world book and holds no copy of the entry (ADR-0025 D4). A new nonce so a
   * second click on the same pin re-focuses it.
   */
  const openFromMap = useCallback((pin: { id: string }): void => {
    setLibraryFocus({ kind: PLACE_KIND, id: pin.id, nonce: Date.now() })
    setTab(tabForEntityKind(PLACE_KIND))
  }, [])


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

  return {
    sessionOpenState,
    loading,
    gate,
    build,
    projectTitle,
    titleWarning,
    rootLabel,
    refresh,
    tab,
    setTab,
    empty,
    routeHint,
    planVisible,
    setPlanVisible,
    searchText,
    setSearchText,
    searchActive,
    searchAllKinds,
    setSearchAllKinds,
    searching,
    searchError,
    searchPage,
    searchQuery,
    openSearchHit,
    tree,
    selected,
    setSelected,
    creating,
    setCreating,
    newTitle,
    setNewTitle,
    newVolume,
    setNewVolume,
    createError,
    setCreateError,
    createChapter,
    volumes,
    facts,
    detail,
    detailError,
    scrollBox,
    libraryFocus,
    openMovedKind,
    openFromAudit,
    openFromEvidence,
    openFromMap,
  }
}

