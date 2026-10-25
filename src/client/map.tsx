/**
 * The map tab (#48): places grouped by world category, one click to the entry.
 *
 * First version, on purpose: **a list with jumps, not a drawing.** Nothing here draws a
 * coordinate system, because a coordinate would have to live on the entry (ADR-0025 D4
 * allows only body/`extra`) and this issue does not get to invent a second schema for
 * display data. What the page does answer — "what places does this book have, and which
 * category is each in" — it answers from the same rows the setting library shows, so the
 * two can never disagree.
 *
 * The click contract: a pin is `{kind: 'world', id}` handed to the workbench, which opens
 * 设定库 and selects the row (the same address the audit page uses). The map therefore
 * holds an id and a title, never a copy of the entry.
 *
 * Read-only: no route of its own, no write, no local state beyond the fetch.
 */

import { useCallback, useEffect, useState } from 'react'

import { fetchInternal } from './internal.js'
import { SCROLL_BOX_STYLE, SCROLL_COLUMN_STYLE } from './layout-model.js'
import { useScrollBox } from './layout.js'
import { MAP_NOTE, describePin, readMapView } from './map-model.js'
import type { MapView, PlacePin } from './map-model.js'
import type { LibraryValue } from './library-model.js'

// Every visible colour is a host theme token (`--dsw-alias-*`); the panel keeps its own
// small style set rather than importing `index.tsx`'s, which would make the two modules
// import each other.
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

const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 } as const

const pinStyle = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  width: '100%',
  textAlign: 'left',
  padding: '4px 8px',
  borderRadius: 6,
  cursor: 'pointer',
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
} as const

/** One place. A button, not a link: the jump is the workbench's own state change. */
function Pin({ pin, onOpen }: { pin: PlacePin; onOpen: (pin: PlacePin) => void }) {
  return (
    <button type="button" title={describePin(pin)} style={pinStyle} onClick={() => onOpen(pin)}>
      <span aria-hidden="true">◦</span>
      <span style={{ fontSize: 13 }}>{pin.title}</span>
      <span style={{ ...muted, ...mono, marginLeft: 'auto' }}>{pin.path}</span>
    </button>
  )
}

export function MapView({ sessionId, onOpen }: { sessionId: string; onOpen: (pin: PlacePin) => void }) {
  const [view, setView] = useState<MapView | null>(null)
  const [loading, setLoading] = useState(true)
  // Hooks come before any return (AGENTS.md §8 trap 2b): a conditional hook would change
  // the hook count between renders and blank the whole panel.
  const scrollBox = useScrollBox()

  const refresh = useCallback(async () => {
    setLoading(true)
    // The map reads the setting library's own projection instead of a second route: a place
    // IS a world entry, and two projections of one row is how they start to disagree (D4).
    const result = await fetchInternal<LibraryValue>('/library', { sessionId })
    setView(readMapView(result))
    setLoading(false)
  }, [sessionId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const current = view

  return (
    <div ref={scrollBox.ref} style={{ ...panelStyle, ...SCROLL_BOX_STYLE, ...scrollBox.style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>地图</span>
        <span style={{ ...muted, fontSize: 11 }}>{MAP_NOTE}</span>
        <span style={{ ...muted, ...mono, marginLeft: 'auto' }}>{loading ? '读取中…' : (current?.summary ?? '—')}</span>
        <button
          type="button"
          style={{
            padding: '2px 10px',
            fontSize: 12,
            borderRadius: 6,
            cursor: 'pointer',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-label-primary)',
          }}
          onClick={() => void refresh()}
        >
          刷新
        </button>
      </div>

      {current === null ? null : current.error === null ? null : (
        <div style={{ ...cardStyle, borderStyle: 'dashed', color: 'var(--dsw-alias-state-error-primary)' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>读取失败</div>
          <div style={{ fontSize: 12 }}>{current.error}</div>
        </div>
      )}

      {current === null || current.indexAvailable ? null : (
        <div style={{ ...cardStyle, borderStyle: 'dashed' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>索引不可读</div>
          <div style={{ ...muted, fontSize: 12 }}>地点列表来自派生索引；先重建索引（工具 inkflow_index_rebuild）再回来看。</div>
        </div>
      )}

      {current === null || current.empty === null ? null : (
        <div style={{ ...cardStyle, borderStyle: 'dashed' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>还没有地点</div>
          <div style={{ ...muted, fontSize: 12 }}>{current.empty}</div>
        </div>
      )}

      {current === null
        ? null
        : current.groups.map((group) => (
            <div key={group.category ?? 'none'} style={cardStyle}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{group.label}</span>
                <span style={{ ...muted, fontSize: 11 }}>{group.total} 处</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {group.places.map((pin) => (
                  <Pin key={pin.id} pin={pin} onOpen={onOpen} />
                ))}
              </div>
            </div>
          ))}
    </div>
  )
}
