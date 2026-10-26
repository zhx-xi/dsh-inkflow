/**
 * The 大纲 tab: the three-level tree (整体 → 卷 → 章), every node's plot points, and
 * the one editor the setting library already owns.
 *
 * WHY A TAB OF ITS OWN (and why the old "编辑在设定库里" decision was reversed): an
 * outline is the backbone of a long book — 整体 → 卷 → 章 plus the plot points of each
 * node — while the setting library is a place to look facts up. Mixing them meant the
 * author switched a `kind` filter before every outline pass. The decision that still
 * holds is the other half of that one: there is **no second write path**. This page
 * reads `GET /library` (the `outlines` group) and saves through `POST /library/item`
 * with the CAS baseline, using `library-editor.tsx` as-is.
 *
 * What it does NOT do: it never guesses a route (an address is resolved by the
 * workbench), never writes a file itself, and never strips a plot point's `[标签]` —
 * the tag is how a story line is recorded until `outlines/arcs/` lands (conventions
 * §3.5), so it is shown as a badge beside the point.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { fetchInternal } from './internal.js'
import type { InternalResult } from './internal.js'
import { SCROLL_BOX_STYLE, SCROLL_COLUMN_STYLE } from './layout-model.js'
import { useScrollBox } from './layout.js'
import { LibraryItemEditor } from './library-editor.js'
import { describeIndexWarning, describeLibraryError, fingerprintOf } from './library-model.js'
import type { LibraryFocus, LibraryItemValue, LibraryValue } from './library-model.js'
import {
  OUTLINE_EMPTY,
  OUTLINE_GROUP_LABELS,
  OUTLINE_KIND,
  OUTLINE_TIER_LABELS,
  buildOutlineTree,
  declaredKindsOf,
  describeOutlineFacts,
  findOutlineNode,
  flattenOutlineTree,
  outlineItemOf,
  parseOutlinePlotPoints,
} from './outline-model.js'
import type { OutlineNode, OutlinePlotPoint, OutlineRow } from './outline-model.js'

/**
 * The unsaved-changes question (the same plain `confirm` the library uses: the panel
 * stays dependency-free and a modal would need focus management it does not have).
 */
function confirmDiscard(message: string): boolean {
  const host = typeof window === 'undefined' ? undefined : window
  if (host === undefined || typeof host.confirm !== 'function') return true
  return host.confirm(message)
}

/** How many detail reads run at once while the tree fills in its plot-point counts. */
const DETAIL_POOL = 4

const panelStyle = {
  display: 'grid',
  gridTemplateColumns: '320px minmax(0, 1fr)',
  minHeight: 0,
} as const

const columnStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 14,
  ...SCROLL_COLUMN_STYLE,
} as const

const detailColumnStyle = {
  ...columnStyle,
  borderLeft: '1px solid var(--dsw-alias-border-l1)',
  paddingBottom: 0,
} as const

const cardStyle = {
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 8,
  padding: '10px 12px',
  background: 'var(--dsw-alias-bg-layer-1)',
} as const

const muted = { color: 'var(--dsw-alias-label-secondary)' } as const
const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 } as const

const rowStyle = {
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  borderRadius: 6,
  padding: '2px 6px',
  fontSize: 12,
  cursor: 'pointer',
  textAlign: 'left',
  width: '100%',
  display: 'flex',
  gap: 6,
  alignItems: 'baseline',
} as const

const selectedRowStyle = {
  ...rowStyle,
  background: 'var(--dsw-alias-bg-layer-2)',
  borderColor: 'var(--dsw-alias-border-l2)',
} as const

const groupRowStyle = { ...muted, fontSize: 11, letterSpacing: 0.2, marginTop: 6 } as const

const buttonStyle = {
  padding: '2px 10px',
  fontSize: 12,
  borderRadius: 6,
  cursor: 'pointer',
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
} as const

const tierBadgeStyle = {
  ...mono,
  fontSize: 11,
  color: 'var(--dsw-alias-label-secondary)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 4,
  padding: '0 4px',
} as const

const tagBadgeStyle = {
  ...mono,
  fontSize: 11,
  color: 'var(--dsw-alias-state-success-primary)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 4,
  padding: '0 4px',
  marginRight: 6,
} as const

function NoteCard({ title, body, tone }: { title: string; body: string; tone?: 'error' }) {
  return (
    <div
      style={{
        ...cardStyle,
        borderStyle: 'dashed',
        ...(tone === 'error'
          ? { borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' }
          : {}),
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ ...muted, ...(tone === 'error' ? { color: 'var(--dsw-alias-state-error-primary)' } : {}) }}>{body}</div>
    </div>
  )
}

/** One key/value line of the detail pane; `null` is shown as `—`, never hidden. */
function Field({ name, value }: { name: string; value: string | number | null }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 12 }}>
      <span style={{ ...muted, ...mono, minWidth: 96 }}>{name}</span>
      <span style={{ ...mono, wordBreak: 'break-word' }}>{value === null ? '—' : String(value)}</span>
    </div>
  )
}

/** One plot point: its `[标签]` as a badge, then the text the author wrote. */
function PlotPointLine({ point }: { point: OutlinePlotPoint }) {
  return (
    // The tooltip carries `point.raw` — the file's own line, `- ` and all — so a reader can
    // always check the badge against the file: a tag the parser refused still stands in the
    // line, and a joined continuation still reads as two lines there.
    <li title={point.raw} style={{ ...mono, margin: '2px 0' }}>
      {point.arc === undefined ? null : <span style={tagBadgeStyle}>[{point.arc}]</span>}
      <span style={{ wordBreak: 'break-word' }}>{point.text}</span>
    </li>
  )
}

export function OutlineView({ sessionId, focus }: { sessionId: string; focus?: LibraryFocus | null }) {
  const [library, setLibrary] = useState<InternalResult<LibraryValue> | null>(null)
  const [loading, setLoading] = useState(true)
  // Keyed by node id: the detail the editor writes against, and the body its plot
  // points come from. A slow answer for another node can never land under this one.
  const [details, setDetails] = useState<Readonly<Record<string, LibraryItemValue>>>({})
  const [detailError, setDetailError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<readonly string[]>([])
  const [editing, setEditing] = useState(false)
  const [draftDirty, setDraftDirty] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const scrollBox = useScrollBox()
  /** Ids already asked for — the pool runs once per node, and a failure is forgotten. */
  const asked = useRef(new Set<string>())
  /** The focus request already applied, so a later tree pass does not steal the selection back. */
  const appliedFocus = useRef<number | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const result = await fetchInternal<LibraryValue>('/library', { sessionId })
    setLibrary(result)
    setLoading(false)
  }, [sessionId])

  useEffect(() => {
    void load()
  }, [load])

  const value = library !== null && library.ok ? (library.value ?? null) : null
  const declared = useMemo(() => declaredKindsOf(Object.values(details)), [details])
  const tree = useMemo(() => buildOutlineTree(value, declared), [value, declared])
  const rows = useMemo(() => flattenOutlineTree(tree), [tree])
  const libraryError = library !== null && !library.ok ? describeLibraryError(library.error) : null

  /** Plot points per node, parsed from the body the detail route handed out. */
  const points = useMemo(() => {
    const out: Record<string, OutlinePlotPoint[]> = {}
    for (const row of rows) {
      const detail = details[row.node.id]
      if (detail !== undefined) out[row.node.id] = parseOutlinePlotPoints(detail.body ?? '')
    }
    return out
  }, [rows, details])

  /** Title of the node an id names, for the "上级" line (the raw id is shown beside it). */
  const titleOf = useCallback(
    (id: string | null): string | null => (id === null ? null : (rows.find((row) => row.node.id === id)?.node.title ?? null)),
    [rows],
  )

  const ensureDetail = useCallback(
    async (id: string): Promise<void> => {
      if (asked.current.has(id)) return
      asked.current.add(id)
      const query = `?kind=${encodeURIComponent(OUTLINE_KIND)}&id=${encodeURIComponent(id)}`
      const result = await fetchInternal<LibraryItemValue>(`/library/item${query}`, { sessionId })
      if (result.ok) {
        setDetails((current) => ({ ...current, [id]: result.value ?? {} }))
        return
      }
      // Forget it, so clicking the row asks again instead of showing a dead pane.
      asked.current.delete(id)
      setDetailError(describeLibraryError(result.error))
    },
    [sessionId],
  )

  // The counts on every row need every node's body, so the page warms them up with a
  // small pool rather than one request per render tick. Bounded on purpose: this is a
  // local channel, but 500 nodes is a real number for a hand-written book.
  const nodeKey = rows.map((row) => row.node.id).join('\u0000')
  useEffect(() => {
    const ids = nodeKey === '' ? [] : nodeKey.split('\u0000').filter((id) => !asked.current.has(id))
    if (ids.length === 0) return
    let live = true
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (live && cursor < ids.length) {
        const id = ids[cursor]
        cursor += 1
        if (id === undefined) return
        await ensureDetail(id)
      }
    }
    void Promise.all(Array.from({ length: DETAIL_POOL }, worker))
    return () => {
      live = false
    }
  }, [nodeKey, ensureDetail])

  /** An address from the 体检 page (or a search hit): select it and show its points. */
  useEffect(() => {
    if (focus === undefined || focus === null || focus.kind !== OUTLINE_KIND) return
    if (appliedFocus.current === focus.nonce) return
    const hit = findOutlineNode(tree, focus)
    // The request can arrive before `GET /library` answers; the next pass retries.
    if (hit === undefined) return
    appliedFocus.current = focus.nonce
    setSelectedId(hit.id)
    setExpanded((current) => (current.includes(hit.id) ? current : [...current, hit.id]))
  }, [focus?.nonce, tree])

  /** Leaving edit mode with unsaved changes must be a decision, not an accident. */
  const mayLeaveDraft = useCallback((): boolean => {
    if (!editing || !draftDirty) return true
    return confirmDiscard('这条大纲还没保存，改动会丢掉。确定离开？')
  }, [editing, draftDirty])

  const pick = useCallback(
    (node: OutlineNode): void => {
      if (!mayLeaveDraft()) return
      setEditing(false)
      setDraftDirty(false)
      setStatus(null)
      setSelectedId(node.id)
      setExpanded((current) => (current.includes(node.id) ? current : [...current, node.id]))
      void ensureDetail(node.id)
    },
    [ensureDetail, mayLeaveDraft],
  )

  const toggle = (id: string): void => {
    setExpanded((current) => (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]))
    void ensureDetail(id)
  }

  /** A save landed: adopt the new bytes, refresh the tree (order/parent may have moved). */
  const handleSaved = useCallback(
    (id: string, saved: LibraryItemValue): void => {
      setDetails((current) => ({ ...current, [id]: saved }))
      setEditing(false)
      setDraftDirty(false)
      setStatus(describeIndexWarning(saved) ?? `已保存 · ${saved.path ?? ''} · ${saved.fingerprint?.size ?? '?'} 字节`)
      void load()
    },
    [load],
  )

  const cancelEdit = useCallback((): void => {
    if (!mayLeaveDraft()) return
    setEditing(false)
    setDraftDirty(false)
    setStatus(null)
  }, [mayLeaveDraft])

  const selectedRow: OutlineRow | undefined =
    selectedId === null ? undefined : rows.find((row) => row.node.id === selectedId)
  const selected = selectedRow?.node ?? null
  const selectedDetail = selected === null ? undefined : details[selected.id]
  const selectedPoints = selected === null ? [] : (points[selected.id] ?? [])
  const editable = selectedDetail !== undefined && selectedDetail.readable !== false && fingerprintOf(selectedDetail) !== null

  return (
    <div ref={scrollBox.ref} style={{ ...panelStyle, ...SCROLL_BOX_STYLE, ...scrollBox.style }}>
      <div style={columnStyle}>
        <div style={{ ...muted, fontSize: 12, letterSpacing: 0.2 }}>大纲（整体 → 卷 → 章）</div>
        <div style={{ ...muted, ...mono }}>{describeOutlineFacts(tree)}</div>
        {tree.truncated ? <div style={{ ...muted, fontSize: 11 }}>（已达上限，列表不完整）</div> : null}

        {loading ? <div style={muted}>载入中…</div> : null}
        {libraryError === null ? null : <NoteCard title="大纲读不出来" body={libraryError} tone="error" />}
        {detailError === null ? null : <NoteCard title="节点详情读不出来" body={detailError} tone="error" />}
        {!loading && libraryError === null && !tree.indexAvailable ? (
          <NoteCard title={OUTLINE_EMPTY['index-unavailable'].title} body={OUTLINE_EMPTY['index-unavailable'].body} />
        ) : null}
        {!loading && libraryError === null && tree.indexAvailable && tree.total === 0 ? (
          <NoteCard title={OUTLINE_EMPTY['no-nodes'].title} body={OUTLINE_EMPTY['no-nodes'].body} />
        ) : null}

        {rows.map((row, index) => {
          const previous = index === 0 ? undefined : rows[index - 1]
          const showGroup = previous === undefined || previous.group !== row.group
          const open = expanded.includes(row.node.id)
          const count = points[row.node.id]?.length
          const isSelected = selected !== null && selected.id === row.node.id
          return (
            <div key={row.node.id} style={{ display: 'grid', gap: 2 }}>
              {showGroup ? (
                <div style={groupRowStyle}>
                  {OUTLINE_GROUP_LABELS[row.group]}
                  {row.group === 'orphan' ? `（上级 ${tree.orphans.find((orphan) => orphan.node.id === row.node.id)?.parent ?? '?'}）` : ''}
                </div>
              ) : null}
              <button
                type="button"
                style={{ ...(isSelected ? selectedRowStyle : rowStyle), paddingLeft: 6 + row.depth * 14 }}
                onClick={() => pick(row.node)}
                title={row.node.path}
              >
                <span
                  onClick={(event) => {
                    // The caret collapses without re-selecting: the row click below already
                    // selects AND expands, so bubbling would make collapsing impossible.
                    event.stopPropagation()
                    toggle(row.node.id)
                  }}
                  role="presentation"
                  style={muted}
                >
                  {open ? '▾' : '▸'}
                </span>
                <span style={tierBadgeStyle}>{OUTLINE_TIER_LABELS[row.node.tier]}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.node.title}</span>
                {row.node.order === null ? null : <span style={{ ...muted, ...mono }}>#{row.node.order}</span>}
                <span style={{ ...muted, ...mono }}>{count === undefined ? '…' : `${String(count)} 点`}</span>
              </button>
              {open ? (
                count === undefined ? null : count === 0 ? (
                  <div style={{ ...muted, fontSize: 11, paddingLeft: 20 + row.depth * 14 }}>（这个节点还没有情节点）</div>
                ) : (
                  <ul style={{ margin: '2px 0 2px', paddingLeft: 20 + row.depth * 14 }}>
                    {(points[row.node.id] ?? []).map((point, pointIndex) => (
                      <PlotPointLine key={`${row.node.id}-point-${String(pointIndex)}`} point={point} />
                    ))}
                  </ul>
                )
              ) : null}
            </div>
          )
        })}
      </div>

      <div style={detailColumnStyle}>
        {selected === null || selectedRow === undefined ? (
          <NoteCard title={OUTLINE_EMPTY['no-selection'].title} body={OUTLINE_EMPTY['no-selection'].body} />
        ) : editing && selectedDetail !== undefined && editable ? (
          // Keyed by the baseline: a reload or a save mounts a fresh draft instead of
          // leaving inputs bound to bytes that are already gone.
          <LibraryItemEditor
            key={`${selected.id}:${selectedDetail.fingerprint?.sha256 ?? ''}`}
            item={outlineItemOf(selected)}
            detail={selectedDetail}
            sessionId={sessionId}
            onSaved={(saved) => handleSaved(selected.id, saved)}
            onReloaded={(reloaded) => setDetails((current) => ({ ...current, [selected.id]: reloaded }))}
            onCancel={cancelEdit}
            onDirtyChange={setDraftDirty}
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <span style={tierBadgeStyle}>{OUTLINE_TIER_LABELS[selected.tier]}</span>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{selectedDetail?.title ?? selected.title}</span>
              <span style={{ ...muted, ...mono }}>{selected.path}</span>
              <button
                type="button"
                style={buttonStyle}
                disabled={!editable}
                onClick={() => {
                  setStatus(null)
                  setEditing(true)
                }}
              >
                编辑
              </button>
              {editable ? null : <span style={{ ...muted, fontSize: 11 }}>读不到文件基线，暂时不能编辑</span>}
            </div>

            {status === null ? null : <div style={{ ...muted, ...mono }}>{status}</div>}

            <div style={cardStyle}>
              <div style={{ ...muted, fontSize: 12 }}>节点</div>
              <div style={{ display: 'grid', gap: 2, marginTop: 6 }}>
                <Field name="层级" value={OUTLINE_TIER_LABELS[selected.tier]} />
                <Field name="上级" value={selected.parent} />
                <Field name="上级标题" value={titleOf(selected.parent)} />
                <Field name="次序" value={selected.order} />
                <Field name="分组" value={OUTLINE_GROUP_LABELS[selectedRow.group]} />
                <Field name="情节点" value={selectedPoints.length} />
              </div>
            </div>

            <div style={cardStyle}>
              <div style={{ ...muted, fontSize: 12 }}>情节点（{selectedPoints.length} 条，标签照原样显示）</div>
              {selectedDetail === undefined ? (
                <div style={{ ...muted, marginTop: 6 }}>正在读这一条…</div>
              ) : selectedPoints.length === 0 ? (
                <div style={{ ...muted, marginTop: 6 }}>
                  这一条的正文里没有情节点。点「编辑」在正文里一行一条地写（`- [主线] 少年入山` 那样带标签也认）。
                </div>
              ) : (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {selectedPoints.map((point, index) => (
                    <PlotPointLine key={`selected-point-${String(index)}`} point={point} />
                  ))}
                </ul>
              )}
            </div>

            <div style={cardStyle}>
              <div style={{ ...muted, fontSize: 12 }}>正文（情节点从这里来）</div>
              <div style={{ ...mono, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflowY: 'auto', marginTop: 6 }}>
                {(selectedDetail?.body ?? '').trim() === '' ? '（正文为空）' : selectedDetail?.body}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
