/**
 * The book hub view (ADR-0010 D1, issue #85).
 *
 * WHERE IT RIDES: `main`, addressed by the id of the `sidebar.panellist` icon.
 * The icon slot renders the glyph only and the keyed `main` slot renders this
 * component, so "click the InkFlow icon → the book list" is one registration
 * pair, not a page the shell has to know about (measured on 0.2.1-rc.2, see
 * `src/client/context.ts`).
 *
 * WHAT IT ASKS FOR: `GET /inkflow/internal/hub/books` with `sessionless: true`.
 * A root-scoped panel has no session, and this view must never name a directory
 * — so it sends nothing but the route (ADR-0010 D3/D6). The list is read once
 * when the panel opens and again when the user presses 刷新: no polling, because
 * every answer costs one judgment per book (ADR-0010 D8).
 *
 * WHAT THE WIZARD ADDS (#86): the 「新开书」 button is real. It opens
 * `HubWizard`, which asks the Host to plan a directory, shows the plan, and
 * applies it after confirmation. A successful apply merges the new book into
 * this list IN PLACE — no refetch, because the host's answer already carries the
 * row (ADR-0010 D8 "apply 成功后就地更新该行").
 *
 * WHAT THE SHARED PAGE ADDS (#87): 「共享内容」 opens `SharedLibraryView`, a
 * read-only browse of `dataDir/shared` (`hub-shared.tsx`). It owns no book, so it
 * never touches this list; copy/ref edges belong to #40.
 *
 * WHAT THE SETTINGS PAGE ADDS (#42): 「设置」 opens `SettingsView` (`settings.tsx`) —
 * plugin settings, the diagnostics package and the local backups, in one body area.
 * Roadmap X-20 puts that entry in the 书库 (root scope) rather than in a session tab,
 * because settings are cross-book and the backups are per-book but chosen here.
 */

import { useCallback, useEffect, useState } from 'react'

import { fetchInternal } from './internal.js'
import { SharedLibraryView } from './hub-shared.js'
import {
  HUB_SHARED_LABEL,
  HUB_TEXTS,
  badgeOf,
  describeCounts,
  hubSummary,
  readHubBooks,
  relativeToHome,
  rowMarkers,
  rowTitle,
} from './hub-model.js'
import type { HubBadgeTone, HubBookRow, HubBooksValue, HubState } from './hub-model.js'
import { HubWizard } from './hub-wizard.js'
import type { HubAppliedRow } from './hub-wizard.js'
import { HUB_WIZARD_LABEL, mergeHubRow } from './hub-wizard-model.js'
import { SETTINGS_TEXTS } from './settings-model.js'
import { SettingsView } from './settings.js'

// ---------------------------------------------------------------------------
// Theme tokens only: every visible colour comes from --dsw-alias-* (AGENTS.md §6)
// ---------------------------------------------------------------------------

const sheetStyle = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  gap: 10,
  padding: 16,
  overflowY: 'auto',
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 13,
  lineHeight: 1.6,
} as const

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
  paddingBottom: 8,
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
} as const

const cardStyle = {
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 8,
  padding: '10px 12px',
  background: 'var(--dsw-alias-bg-layer-1)',
  display: 'grid',
  gap: 4,
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

function toneColor(tone: HubBadgeTone): string {
  return `var(--dsw-alias-state-${tone}-primary)`
}

function Badge({ label, tone }: { label: string; tone: HubBadgeTone }) {
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

/** One book: title, `~/…` path (full path on hover), state badge, counts, markers. */
function BookCard({ row, home }: { row: HubBookRow; home: string | null }) {
  const badge = badgeOf(row.state)
  const shown = relativeToHome(row.path, home)
  const full = typeof row.path === 'string' && row.path.trim() !== '' ? row.path : '（无路径）'
  const markers = rowMarkers(row)
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>{rowTitle(row)}</span>
        <Badge label={badge.label} tone={badge.tone} />
        {markers.map((marker) => (
          <span key={marker} style={{ ...muted, fontSize: 12 }}>
            {marker}
          </span>
        ))}
      </div>
      <div style={{ ...muted, ...mono }} title={full}>
        {shown === '' ? full : shown}
      </div>
      <div style={{ ...muted, fontSize: 12 }}>{row.notABook === true ? '还不是一本小说' : describeCounts(row.counts)}</div>
    </div>
  )
}

const INITIAL: HubState = { status: 'ready', books: [], home: null, total: 0, truncated: false, capped: false }

export function HubView() {
  const [state, setState] = useState<HubState>(INITIAL)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  // The shared library is a page of its own (#87). A root-scoped panel has one
  // body area, so it is a mode of this view instead of a second slot.
  const [view, setView] = useState<'books' | 'shared' | 'settings'>('books')
  /** The wizard is a panel of its own: its confirm card does not belong in the header row. */
  const [wizardOpen, setWizardOpen] = useState(false)

  useEffect(() => {
    let live = true
    setLoading(true)
    void fetchInternal<HubBooksValue>('/hub/books', { sessionless: true }).then((result) => {
      // The panel may have been closed (or refreshed again) while this was in
      // flight: a stale answer must not overwrite a newer one.
      if (!live) return
      setState(readHubBooks(result))
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [revision])

  const refresh = useCallback(() => {
    setRevision((current) => current + 1)
  }, [])

  if (view === 'shared') return <SharedLibraryView onClose={() => setView('books')} />
  if (view === 'settings') return <SettingsView onClose={() => setView('books')} />

  /**
   * The wizard's answer, merged into the list in place (issue #86).
   *
   * No refetch: `apply` already returned everything a row needs, and asking the
   * Host to judge every book again would be exactly the cost ADR-0010 D8 caps.
   */
  const applied = useCallback((row: HubAppliedRow) => {
    setState((current) => {
      if (current.status !== 'ready') return current
      const existed = current.books.some((book) => pathKey(book.path) === pathKey(row.path))
      return {
        ...current,
        books: mergeHubRow(current.books, row),
        total: existed ? current.total : current.total + 1,
      }
    })
  }, [])

  return (
    <div style={sheetStyle}>
      <div style={headerStyle}>
        <span style={{ fontWeight: 600 }}>{HUB_TEXTS.title}</span>
        <span style={{ ...muted, fontSize: 12 }}>{loading ? HUB_TEXTS.loading : hubSummary(state)}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <button type="button" style={buttonStyle} onClick={() => setWizardOpen(true)} disabled={wizardOpen}>
            {HUB_WIZARD_LABEL}
          </button>
          <button type="button" style={buttonStyle} onClick={() => setView('shared')}>
            {HUB_SHARED_LABEL}
          </button>
          <button type="button" style={buttonStyle} onClick={() => setView('settings')}>
            {SETTINGS_TEXTS.settingsTitle}
          </button>
          <button type="button" style={buttonStyle} onClick={refresh} disabled={loading}>
            {HUB_TEXTS.refresh}
          </button>
        </span>
      </div>

      {wizardOpen ? (
        <div style={cardStyle}>
          <HubWizard onApplied={applied} onClose={() => setWizardOpen(false)} />
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div style={{ ...cardStyle, borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' }}>
          {state.message}
        </div>
      ) : null}

      {state.status === 'ready' && state.books.length === 0 && !loading ? (
        <div style={{ ...cardStyle, borderStyle: 'dashed' }}>
          <div style={{ fontWeight: 600 }}>{HUB_TEXTS.emptyTitle}</div>
          <div>{HUB_TEXTS.emptyBody}</div>
          <div style={muted}>{HUB_TEXTS.emptyHint}</div>
        </div>
      ) : null}

      {state.status === 'ready'
        ? state.books.map((row) => <BookCard key={row.workspaceId ?? row.path ?? rowTitle(row)} row={row} home={state.home} />)
        : null}

      <div style={{ ...muted, marginTop: 'auto', paddingTop: 6, fontSize: 12 }}>{HUB_TEXTS.readOnly}</div>
    </div>
  )
}

/** Path identity for the in-place merge: Windows compares case-insensitively. */
function pathKey(path: string | undefined): string {
  return typeof path === 'string' ? path.replaceAll('\\', '/').replace(/\/+$/u, '').toLowerCase() : ''
}

/** The sidebar glyph: an open book, drawn with `currentColor` so the theme decides. */
export function HubIcon({ size, active }: { size?: number; active?: boolean }) {
  const edge = typeof size === 'number' ? size : 16
  // `active` is the sidebar's "this panel is selected" flag: a slightly heavier
  // stroke is enough, because the colour still comes from the theme token.
  const width = active === true ? 1.6 : 1.2
  return (
    <svg width={edge} height={edge} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 3.2c1.6-.7 3.4-.7 5 0v9.4c-1.6-.7-3.4-.7-5 0V3.2Zm12 0c-1.6-.7-3.4-.7-5 0v9.4c1.6-.7 3.4-.7 5 0V3.2Z"
        stroke="currentColor"
        strokeWidth={width}
        strokeLinejoin="round"
      />
    </svg>
  )
}
