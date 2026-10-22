/**
 * The shared-content page of the book hub (ADR-0010 D5, issue #87).
 *
 * WHAT IT ASKS FOR: `GET /inkflow/internal/hub/shared` with `sessionless: true`.
 * The page lives inside the root-scoped book hub, so it has no session, and it
 * must never name a directory — the shared library's location is the plugin's
 * configuration, not a request field. The only parameters that may appear are
 * the two filters the Host documents (`kind`, `q`).
 *
 * WHAT IT DOES NOT DO: there is no write action at all. 复制 / 引用 into a book
 * belong to #40, so the page says so instead of offering a button that cannot
 * work. It also does not poll: the list is read when the page opens and again
 * when the user presses 刷新 (each answer costs a directory scan, ADR-0010 D8).
 *
 * Every colour comes from a `--dsw-alias-*` token (AGENTS.md §6); no literal
 * colour appears in this file, which the bundle test asserts.
 */

import { useCallback, useEffect, useState } from 'react'

import { fetchInternal } from './internal.js'
import {
  SHARED_KIND_LABELS,
  SHARED_TEXTS,
  describeSharedSource,
  describeTags,
  entryName,
  isEmptyFilter,
  isEmptyLibrary,
  readSharedLibrary,
  sharedGroups,
  sharedSummary,
} from './hub-shared-model.js'
import type { HubSharedValue, SharedEntry, SharedState } from './hub-shared-model.js'

// Same tokens as `hub.tsx`; kept local so the two pages stay independent views.
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

const groupStyle = {
  display: 'grid',
  gap: 6,
  paddingTop: 4,
} as const

const rowStyle = {
  display: 'grid',
  gap: 2,
  padding: '6px 10px',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 6,
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

const INITIAL: SharedState = {
  status: 'ready',
  created: false,
  indexSource: 'scan',
  entries: [],
  countsByKind: {},
  total: 0,
  truncated: false,
}

/** One entry: its name, the relative path it lives at, and its tags. */
function EntryRow({ entry }: { entry: SharedEntry }) {
  const path = typeof entry.path === 'string' ? entry.path : ''
  return (
    <div style={rowStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>{entryName(path)}</span>
        <span style={{ ...muted, fontSize: 12 }}>{describeTags(entry)}</span>
      </div>
      <div style={{ ...muted, ...mono }} title={path}>
        {path}
      </div>
    </div>
  )
}

/**
 * The shared library, read-only.
 *
 * `onClose` returns to the book list: a root-scoped panel has one body area, so
 * the two pages are two modes of the same panel rather than two slots.
 */
export function SharedLibraryView({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<SharedState>(INITIAL)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let live = true
    setLoading(true)
    void fetchInternal<HubSharedValue>('/hub/shared', { sessionless: true }).then((result) => {
      // The page may have been left (or refreshed again) while this was in
      // flight: a stale answer must not overwrite a newer one.
      if (!live) return
      setState(readSharedLibrary(result))
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [revision])

  const refresh = useCallback(() => {
    setRevision((current) => current + 1)
  }, [])

  const groups = state.status === 'ready' ? sharedGroups(state.entries, state.countsByKind) : []

  return (
    <div style={sheetStyle}>
      <div style={headerStyle}>
        <span style={{ fontWeight: 600 }}>{SHARED_TEXTS.title}</span>
        <span style={{ ...muted, fontSize: 12 }}>{loading ? SHARED_TEXTS.loading : sharedSummary(state)}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button type="button" style={buttonStyle} onClick={onClose}>
            {SHARED_TEXTS.back}
          </button>
          <button type="button" style={buttonStyle} onClick={refresh} disabled={loading}>
            {SHARED_TEXTS.refresh}
          </button>
        </span>
      </div>

      {state.status === 'ready' ? (
        <div style={{ ...cardStyle, gap: 2 }}>
          <div style={muted}>{describeSharedSource(state.indexSource)}</div>
          <div style={muted}>{SHARED_TEXTS.readOnly}</div>
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div
          style={{
            ...cardStyle,
            borderColor: 'var(--dsw-alias-state-error-primary)',
            color: 'var(--dsw-alias-state-error-primary)',
          }}
        >
          {state.message}
        </div>
      ) : null}

      {isEmptyLibrary(state) && !loading ? (
        <div style={{ ...cardStyle, borderStyle: 'dashed' }}>
          <div style={{ fontWeight: 600 }}>{SHARED_TEXTS.emptyTitle}</div>
          <div>{SHARED_TEXTS.emptyBody}</div>
          <div style={muted}>{SHARED_TEXTS.emptyHint}</div>
        </div>
      ) : null}

      {isEmptyFilter(state) && !loading ? (
        <div style={{ ...cardStyle, borderStyle: 'dashed' }}>{SHARED_TEXTS.emptyFilter}</div>
      ) : null}

      {groups.map((group) => (
        <section key={group.kind} style={groupStyle}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontWeight: 600 }}>{group.label}</span>
            <span style={{ ...muted, fontSize: 12 }}>{group.count}</span>
          </div>
          {group.entries.length === 0 ? (
            <div style={{ ...muted, fontSize: 12 }}>{SHARED_TEXTS.noEntries}</div>
          ) : (
            group.entries.map((entry) => <EntryRow key={entry.entryId ?? entry.path ?? entryName(entry.path)} entry={entry} />)
          )}
        </section>
      ))}

      <div style={{ ...muted, marginTop: 'auto', paddingTop: 6, fontSize: 12 }}>
        {SHARED_KIND_LABELS.world} / {SHARED_KIND_LABELS.library} / {SHARED_KIND_LABELS.snippets} /{' '}
        {SHARED_KIND_LABELS.series} · {SHARED_TEXTS.readOnly}
      </div>
    </div>
  )
}
