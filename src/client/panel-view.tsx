/**
 * The workbench page itself: the header, the tab row, the gate screens, the
 * chapter tree with its editor, the search box, and the one-line-per-page map
 * (`pageRenderers`) the tab row resolves against.
 *
 * WHY IT IS A FILE: this is the rendering half of the old `index.tsx`. Its state
 * comes from `useWorkbench()` in one destructure, so the JSX below reads as markup
 * and nothing else — no effect, no fetch, no model selection. A new panel still
 * costs ONE line in `pageRenderers` plus its own component file, which is the
 * property X-12 was meant to protect.
 */

import type { ReactNode } from 'react'

import type { ConversationViewProps } from './context.js'
import { EditorPane } from './editor.js'
import { LibraryView } from './library.js'
// 大纲 reads the library's own projection and saves through the same editor: no new route.
import { OutlineView } from './outline.js'
import { TrashView } from './trash.js'
import { ForeshadowView } from './foreshadow.js'
import { AuditView } from './audit.js'
// The seven quality gates for one chapter: its own file, so the renderer map stays one per page (X-12).
import { GateQualityView } from './gate.js'
// Proposals — one chapter's revision cut into hunks, decided piece by piece, then applied.
import { ProposalView } from './proposal.js'
import { ExtractView } from './extract.js'
import { BriefView } from './brief.js'
import { MapView } from './map.js'
// The review tab — recorded runs, opinions with their evidence and the cross-model table; one line below (X-12).
import { ReviewView } from './review.js'
// The batch job tab — status, per-chapter gate counts, the pause reason and the one 续跑 button (X-12).
import { BatchView } from './batch.js'
// 时间线 — two axes over the same events (when it happened / when the reader learns it).
import { TimelineView } from './timeline.js'
import { SCROLL_BOX_STYLE } from './layout-model.js'
import { PanelTabRow } from './panel-tabs.js'
import { ChapterTree } from './chapter-tree.js'
import {
  EMPTY_MESSAGES,
  PANEL_TABS,
  describeAction,
  describeFacts,
} from './panel-model.js'
import {
  SEARCH_HINT,
  describeSearchDegradation,
  describeSearchPage,
  searchBackendLabel,
  searchHitLabel,
} from './search-model.js'
import {
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
  headerStyle,
  mono,
  muted,
  panelStyle,
  renderExtraPage,
  titleWarningStyle,
  toneColor,
} from './panel-chrome.js'
import { useWorkbench } from './use-workbench.js'

export function InkflowView({ sessionId, useSessions, useSession, useWorkspaces }: ConversationViewProps) {
  const {
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
  } = useWorkbench({ sessionId, useSessions, useSession, useWorkspaces })

  /**
   * Every tab that is not `chapters` renders from this map (roadmap X-12). `chapters` stays
   * inline: it is the default page and carries the editor, the scroll box and most of this
   * component's state, so extracting it would move ~160 lines for no gain. Every *other* page
   * is one line here, and `PANEL_TABS` decides what a user can CLICK while this map decides
   * what EXISTS — a live tab with no page renders nothing, so both change in one commit.
   */
  const pageRenderers: Readonly<Record<string, () => ReactNode>> = {
    // 设定库 — the five-kind tree, one entry's detail, the editor, the problem panel. Its own
    // three routes, so this tab costs the chapter tree nothing; a moved kind is handed over.
    library: () => <LibraryView sessionId={sessionId} focus={libraryFocus} onOpenKind={openMovedKind} />,
    // 大纲 — the same projection in its own reading order (整体 → 卷 → 章) with each
    // node's plot points; it takes the focus address because a 体检 row can point here.
    outline: () => <OutlineView sessionId={sessionId} focus={libraryFocus} />,
    // The recovery bin — what a delete moved into `.inkflow/trash/`,
    // with restore (one click) and purge (two). One route pair of its own.
    trash: () => <TrashView sessionId={sessionId} />,
    // 伏笔 — the board (本期到期 / 超期 / 未回收 / 按角色) with one write: 推进 a state in place.
    foreshadowing: () => <ForeshadowView sessionId={sessionId} focus={libraryFocus} />,
    // The five-family consistency audit — counts, findings with their
    // addresses, and the Markdown export into `.inkflow/audit/`.
    audit: () => <AuditView sessionId={sessionId} onOpen={openFromAudit} />,
    // The extraction queue (X-20) — accept or reject what the session model
    // proposed. Its own four routes, so it costs the other pages nothing.
    candidates: () => <ExtractView sessionId={sessionId} onOpenEvidence={openFromEvidence} />,
    // The nine-segment brief (X-12/X-23) — every segment with its size, share
    // and trim state, the trim ladder's record, the rendered block, and the one write that
    // records it into `.inkflow/audit/brief-<chapterId>.json`.
    brief: () => <BriefView sessionId={sessionId} />,
    // 地图 — places grouped by the world book's own categories, one click to the
    // entry. It reuses 设定库's projection (a place IS a world entry, ADR-0025 D4) and
    // jumps the way an audit row does, so it adds no route and no second truth.
    map: () => <MapView sessionId={sessionId} onOpen={openFromMap} />,
    // The seven quality gates for one chapter — counts per check, every finding
    // with its address and hint, filtered by severity. `GET /gate` is read-only, so this tab
    // cannot change the book or the conclusion file.
    gate: () => <GateQualityView sessionId={sessionId} />,
    // The review runs of one chapter — which passes exist, what each dimension
    // said with its evidence, and the cross-model table. Read-only (`GET /review`), and it
    // jumps through the same `openFromEvidence` an extracted candidate uses, because an
    // address is resolved by the workbench and never by the page that printed it.
    review: () => <ReviewView sessionId={sessionId} onOpenEvidence={openFromEvidence} />,
    // 提案 — the diff, the per-hunk verdicts and the two confirmed actions.
    // `GET /proposal` is read-only, so opening this tab never touches a chapter.
    proposal: () => <ProposalView sessionId={sessionId} />,
    // 批量 — the job's status, every chapter's state and gate counts, the pause
    // reason and the 续跑 button. `GET /batch` is read-only; the button writes the job records
    // and never a chapter file (approving prose is a tool call, not a click).
    batch: () => <BatchView sessionId={sessionId} />,
    timeline: () => <TimelineView sessionId={sessionId} focus={libraryFocus} />,
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

      <PanelTabRow tabs={PANEL_TABS} active={tab} onPick={setTab} />

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
            {/* Search box: the 「全部类型」 switch sits beside it and only widens
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
            <ChapterTree groups={tree.groups} loose={tree.loose} selected={selected} onPick={setSelected} />
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
