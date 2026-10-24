/**
 * The setting-library tab (issue #30): eight-kind tree, one entry's detail, the
 * editor, and the problem panel.
 *
 * Scope of THIS build, stated where the code lives: the tree, one entry's
 * detail, the entry editor (common frontmatter fields + Markdown body, saved
 * against a CAS baseline), and `validation_issues` grouped by code. The editor
 * component is `library-editor.tsx`; the rules it obeys (field set per kind,
 * "only what changed" payload) are pure functions in `library-model.ts`.
 *
 * The client half never touches the filesystem (ADR-0008 D4): everything comes
 * from the private-channel routes, and the request carries a session id and an
 * entity address, never a directory.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { fetchInternal } from './internal.js'
import type { InternalResult } from './internal.js'
import { SCROLL_BOX_STYLE, SCROLL_COLUMN_STYLE } from './layout-model.js'
import { useScrollBox } from './layout.js'
import { LibraryItemEditor } from './library-editor.js'
import {
  LIBRARY_EMPTY,
  aggregateIssues,
  buildLibraryTree,
  describeIndexWarning,
  describeIssueRow,
  describeLibraryError,
  describeLibraryFacts,
  findFocusItem,
  findItemByPath,
  fingerprintOf,
} from './library-model.js'
import type { LibraryFocus, LibraryIssuesValue, LibraryItemValue, LibraryTreeItem, LibraryValue } from './library-model.js'

/**
 * The unsaved-changes question.
 *
 * A plain `confirm` on purpose: the panel stays dependency-free, and a modal
 * component would need focus management the harness does not give a plugin. When
 * there is no window (a test bundle, a non-browser host) nothing is blocked.
 */
function confirmDiscard(message: string): boolean {
  const host = typeof window === 'undefined' ? undefined : window
  if (host === undefined || typeof host.confirm !== 'function') return true
  return host.confirm(message)
}

// Every visible colour comes from the host theme (`--dsw-alias-*`); the panel
// keeps its own small style set rather than importing `index.tsx`'s, which
// would make the two modules import each other. The HEIGHT is the shared
// `SCROLL_BOX_STYLE` (issue 116): same rule as the chapters tab, one source.
const panelStyle = {
  display: 'grid',
  gridTemplateColumns: '300px minmax(0, 1fr)',
  minHeight: 0,
} as const

// The tree and the detail/editor are two independent scroll boxes: a long entry
// form scrolls in its own column, down to its 保存 button, without moving the tree.
const columnStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 14,
  ...SCROLL_COLUMN_STYLE,
} as const

const dividerStyle = { borderLeft: '1px solid var(--dsw-alias-border-l1)' } as const

/**
 * The detail column: same look as the tree column, but no BOTTOM padding.
 *
 * The measured box inside it ends at this column's border box (that is what
 * `layout.ts` measures — padding is invisible to it), so a 14px bottom pad would
 * make the column overflow by exactly 14px and the header would slide up under
 * that scroll — the very bug issue 133 reports. The breathing room moves into the
 * box, where it scrolls with the content.
 */
const detailColumnStyle = {
  ...columnStyle,
  ...dividerStyle,
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
} as const

const selectedRowStyle = {
  ...rowStyle,
  background: 'var(--dsw-alias-bg-layer-2)',
  borderColor: 'var(--dsw-alias-border-l2)',
} as const

const groupRowStyle = {
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  padding: '3px 0',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  textAlign: 'left',
  width: '100%',
} as const

const buttonStyle = {
  padding: '2px 10px',
  fontSize: 12,
  borderRadius: 6,
  cursor: 'pointer',
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
} as const

function SectionTitle({ children }: { children: string }) {
  return <div style={{ ...muted, fontSize: 12, letterSpacing: 0.2 }}>{children}</div>
}

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

/** One key/value line of the detail pane; `null` values are shown, not hidden. */
function Field({ name, value }: { name: string; value: unknown }) {
  const shown =
    value === null || value === undefined
      ? '—'
      : Array.isArray(value)
        ? value.map((entry) => String(entry)).join('、')
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value)
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 12 }}>
      <span style={{ ...muted, ...mono, minWidth: 96 }}>{name}</span>
      <span style={{ ...mono, wordBreak: 'break-word' }}>{shown}</span>
    </div>
  )
}

/** The frontmatter block, in file order, plus the projection fields the Host sent. */
function DetailPane({
  item,
  detail,
  error,
  status,
  onEdit,
}: {
  item: LibraryTreeItem
  detail: LibraryItemValue | null
  error: string | null
  status: string | null
  onEdit: () => void
}) {
  const frontmatter = detail?.frontmatter ?? {}
  const entity = detail?.entity ?? {}
  // Editing needs a baseline: without a fingerprint the save route would refuse
  // the request, so the button says why instead of pretending.
  const editable = detail !== null && detail.readable !== false && fingerprintOf(detail) !== null
  // Issue 133: the header is ONE row and never scrolls; only the content below it
  // scrolls. Two siblings, not one column — a long entry used to carry 编辑 out of
  // view with it. The box below measures the height it actually has (`useScrollBox`,
  // the issue-116 contract): the slot wrapper is content-sized, so `height: 100%` or
  // a pixel count would be a guess that stops scrolling.
  const scrollBox = useScrollBox()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{detail?.title ?? item.title}</span>
        <span style={{ ...muted, ...mono }}>{item.path}</span>
        {detail?.readable === false ? (
          <span style={{ color: 'var(--dsw-alias-state-warn-primary)', fontSize: 12 }}>文件读不出来</span>
        ) : null}
        <button type="button" style={buttonStyle} disabled={!editable} onClick={onEdit}>
          编辑
        </button>
        {editable ? null : <span style={{ ...muted, fontSize: 11 }}>读不到文件基线，暂时不能编辑</span>}
      </div>

      <div
        ref={scrollBox.ref}
        style={{
          ...SCROLL_BOX_STYLE,
          ...scrollBox.style,
          // A COLUMN of cards, so the shared grid row is overridden: the box only needs
          // its height from there. The bottom breathing room lives inside the scroller
          // (see `detailColumnStyle`: padding below a measured box is counted as
          // available height and would push the header up again).
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          overflowY: 'auto',
          paddingBottom: 14,
          paddingRight: 4,
        }}
      >
        {status === null ? null : <div style={{ ...muted, ...mono }}>{status}</div>}
        {error === null ? null : <NoteCard title="详情读取失败" body={error} tone="error" />}
        {detail?.readError === undefined ? null : (
          <NoteCard title="文件读不出来" body={detail.readError.message ?? '索引里有这一条，但它的文件读不出来'} />
        )}

        <div style={cardStyle}>
          <SectionTitle>索引投影（entities 行）</SectionTitle>
          <div style={{ display: 'grid', gap: 2, marginTop: 6 }}>
            <Field name="kind" value={entity['kind'] ?? item.kind} />
            <Field name="id" value={entity['id'] ?? item.id} />
            <Field name="title" value={entity['title'] ?? item.title} />
            <Field name="category" value={entity['category'] ?? item.category} />
            <Field name="parent" value={entity['parent'] ?? item.parent} />
            <Field name="status" value={entity['status'] ?? item.status} />
            <Field name="aliases" value={entity['aliases']} />
            <Field name="keywords" value={entity['keywords']} />
          </div>
        </div>

        <div style={cardStyle}>
          <SectionTitle>frontmatter（文件里的字段）</SectionTitle>
          {Object.keys(frontmatter).length === 0 ? (
            <div style={{ ...muted, marginTop: 6 }}>
              {detail?.hasFrontmatter === true ? '这个文件有 frontmatter 段，但没有可读字段。' : '这个文件没有 frontmatter 段。'}
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 2, marginTop: 6 }}>
              {Object.entries(frontmatter).map(([key, value]) => (
                <Field key={key} name={key} value={value} />
              ))}
            </div>
          )}
        </div>

        <div style={cardStyle}>
          <SectionTitle>正文（只读）</SectionTitle>
          <div style={{ ...muted, ...mono, margin: '4px 0' }}>{detail?.bodyChars ?? 0} 字</div>
          <div style={{ ...mono, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflowY: 'auto' }}>
            {(detail?.body ?? '').trim() === '' ? '（正文为空）' : detail?.body}
          </div>
        </div>

        {Array.isArray(detail?.validationIssues) && detail.validationIssues.length > 0 ? (
          <div style={cardStyle}>
            <SectionTitle>这一条被记下的问题</SectionTitle>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18, ...mono }}>
              {detail.validationIssues.map((issue, index) => {
                const record = typeof issue === 'object' && issue !== null ? (issue as Record<string, unknown>) : {}
                return (
                  <li key={`detail-issue-${index}`}>
                    {String(record['code'] ?? '')} {String(record['detail'] ?? '')}
                  </li>
                )
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function LibraryView({ sessionId, focus }: { sessionId: string; focus?: LibraryFocus | null }) {
  const [library, setLibrary] = useState<InternalResult<LibraryValue> | null>(null)
  const [issues, setIssues] = useState<InternalResult<LibraryIssuesValue> | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<readonly string[]>([])
  const [selected, setSelected] = useState<LibraryTreeItem | null>(null)
  // Keyed by `kind:id` so a slow answer for the previous row can never be shown
  // under the current one (the same lesson the chapter editor learned).
  const [detail, setDetail] = useState<{ key: string; value: LibraryItemValue } | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draftDirty, setDraftDirty] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  // Same measured height as the chapters tab (issue 116): the tab row above this
  // grid is the harness chrome, so the grid has to state its own height or the
  // library columns scroll as one page with the panel.
  const scrollBox = useScrollBox()

  const load = useCallback(async () => {
    setLoading(true)
    const [tree, problems] = await Promise.all([
      fetchInternal<LibraryValue>('/library', { sessionId }),
      fetchInternal<LibraryIssuesValue>('/library/issues', { sessionId }),
    ])
    setLibrary(tree)
    setIssues(tree.ok ? problems : null)
    setLoading(false)
  }, [sessionId])

  useEffect(() => {
    void load()
  }, [load])

  const tree = useMemo(() => buildLibraryTree(library !== null && library.ok ? (library.value ?? null) : null), [library])
  const problems = useMemo(() => aggregateIssues(issues !== null && issues.ok ? (issues.value ?? null) : null), [issues])
  const libraryError = library !== null && !library.ok ? describeLibraryError(library.error) : null
  const issuesError = issues !== null && !issues.ok ? describeLibraryError(issues.error) : null

  const detailKey = selected === null ? null : `${selected.kind}:${selected.id}`
  /** The detail that belongs to the CURRENT row: a slow answer for the previous one is ignored. */
  const current = detail !== null && detail.key === detailKey ? detail.value : null

  useEffect(() => {
    if (selected === null || detailKey === null) {
      setDetail(null)
      setDetailError(null)
      return
    }
    let live = true
    void (async () => {
      const query = `?kind=${encodeURIComponent(selected.kind)}&id=${encodeURIComponent(selected.id)}`
      const result = await fetchInternal<LibraryItemValue>(`/library/item${query}`, { sessionId })
      if (!live) return
      if (result.ok) {
        setDetail({ key: detailKey, value: result.value ?? {} })
        setDetailError(null)
      } else {
        setDetail(null)
        setDetailError(describeLibraryError(result.error))
      }
    })()
    return () => {
      live = false
    }
  }, [detailKey, selected, sessionId])

  /**
   * Leaving edit mode with unsaved changes must be a decision, not an accident.
   * `draftDirty` comes from the editor (the same "only what changed" comparison
   * the payload uses), so a draft that matches the file never nags.
   */
  const mayLeaveDraft = useCallback((): boolean => {
    if (!editing || !draftDirty) return true
    return confirmDiscard('这一条还没保存，改动会丢掉。确定离开？')
  }, [editing, draftDirty])

  /** Select one row (guarding an open draft first). */
  const pick = useCallback(
    (item: LibraryTreeItem): void => {
      if (!mayLeaveDraft()) return
      setEditing(false)
      setDraftDirty(false)
      setStatus(null)
      setSelected(item)
    },
    [mayLeaveDraft],
  )

  const cancelEdit = useCallback((): void => {
    if (!mayLeaveDraft()) return
    setEditing(false)
    setDraftDirty(false)
    setStatus(null)
  }, [mayLeaveDraft])

  /**
   * Open the entry another page asked for (#33's audit rows).
   *
   * Keyed on `focus.nonce` rather than on the object so a second click on the same finding
   * re-selects the same row instead of being swallowed as an equal prop. It waits for the
   * tree: the request can arrive before `GET /library` answers, and a selection of a row the
   * tree does not hold yet would render an empty detail pane. A focused id the tree never
   * holds (a finding about a file the index cannot see) selects nothing — silently, because
   * the audit row already shows the address, and a toast about a missing row would be noise
   * on top of the problem the author opened the audit to read.
   */
  useEffect(() => {
    if (focus === undefined || focus === null) return
    const item = findFocusItem(tree, focus)
    if (item === undefined) return
    pick(item)
    // Deps are deliberately `focus.nonce` + `tree`, not `pick`: `pick` changes identity
    // whenever `draftDirty` flips, so depending on it would re-select the row on every
    // editor keystroke and throw the author's draft away on a confirm.
  }, [focus?.nonce, tree])

  /** A save landed: take the new bytes, refresh the tree, leave edit mode. */
  const handleSaved = useCallback(
    (value: LibraryItemValue): void => {
      if (detailKey !== null) setDetail({ key: detailKey, value })
      setEditing(false)
      setDraftDirty(false)
      const warning = describeIndexWarning(value)
      setStatus(warning ?? `已保存 · ${value.path ?? ''} · ${value.fingerprint?.size ?? '?'} 字节`)
      void load()
    },
    [detailKey, load],
  )

  /** A conflict was resolved by reloading inside the editor: adopt its copy. */
  const handleReloaded = useCallback(
    (value: LibraryItemValue): void => {
      if (detailKey !== null) setDetail({ key: detailKey, value })
      setDraftDirty(false)
      setStatus(null)
    },
    [detailKey],
  )

  const toggle = (kind: string): void => {
    setExpanded((current) => (current.includes(kind) ? current.filter((entry) => entry !== kind) : [...current, kind]))
  }

  /** Jump from a problem row to its entry: select it and open its kind. */
  const jumpTo = (path: string | null): void => {
    const item = findItemByPath(tree, path)
    if (item === undefined) return
    pick(item)
    setExpanded((current) => (current.includes(item.kind) ? current : [...current, item.kind]))
  }

  return (
    <div ref={scrollBox.ref} style={{ ...panelStyle, ...SCROLL_BOX_STYLE, ...scrollBox.style }}>
      <div style={columnStyle}>
        <SectionTitle>设定库（八类）</SectionTitle>
        <div style={{ ...muted, ...mono }}>{describeLibraryFacts(tree)}</div>

        {loading ? <div style={muted}>载入中…</div> : null}
        {libraryError === null ? null : <NoteCard title="设定库读不出来" body={libraryError} tone="error" />}
        {!loading && libraryError === null && !tree.indexAvailable ? (
          <NoteCard title={LIBRARY_EMPTY['index-unavailable'].title} body={LIBRARY_EMPTY['index-unavailable'].body} />
        ) : null}

        {/* When the index cannot be read, the card above already says so — rendering eight
            empty kinds underneath would contradict it. */}
        {(tree.indexAvailable ? tree.groups : []).map((group) => (
          <div key={group.kind} style={{ display: 'grid', gap: 2 }}>
            <button type="button" style={groupRowStyle} onClick={() => toggle(group.kind)} aria-expanded={expanded.includes(group.kind)}>
              <span style={{ ...muted, marginRight: 4 }}>{expanded.includes(group.kind) ? '▾' : '▸'}</span>
              {group.label}
              <span style={{ ...muted, ...mono, marginLeft: 6 }}>{group.total}</span>
              {group.truncated ? <span style={{ ...muted, fontSize: 11 }}> （已达上限，列表不完整）</span> : null}
            </button>
            {!expanded.includes(group.kind) ? null : group.total === 0 ? (
              <div style={{ ...muted, paddingLeft: 14, fontSize: 12 }}>这一类还没有条目</div>
            ) : group.kind === 'world' ? (
              group.categories.map((category) => (
                <div key={`${group.kind}-${category.label}`} style={{ display: 'grid', gap: 2, paddingLeft: 10 }}>
                  <div style={{ ...muted, fontSize: 12 }}>
                    {category.label}
                    <span style={{ ...mono, marginLeft: 6 }}>{category.total}</span>
                  </div>
                  {category.items.map((item) => (
                    <button
                      key={`${item.kind}:${item.id}`}
                      type="button"
                      style={selected !== null && selected.id === item.id && selected.kind === item.kind ? selectedRowStyle : rowStyle}
                      onClick={() => pick(item)}
                    >
                      {item.title}
                    </button>
                  ))}
                </div>
              ))
            ) : (
              group.items.map((item) => (
                <button
                  key={`${item.kind}:${item.id}`}
                  type="button"
                  style={{
                    ...(selected !== null && selected.id === item.id && selected.kind === item.kind ? selectedRowStyle : rowStyle),
                    paddingLeft: 14,
                  }}
                  onClick={() => pick(item)}
                >
                  {item.title}
                </button>
              ))
            )}
          </div>
        ))}

        {!loading && tree.total === 0 && libraryError === null ? (
          <NoteCard title={LIBRARY_EMPTY['no-items'].title} body={LIBRARY_EMPTY['no-items'].body} />
        ) : null}
        {!loading && tree.total === 0 && libraryError === null ? (
          <div style={{ ...muted, fontSize: 12 }}>{LIBRARY_EMPTY['no-projection'].body}</div>
        ) : null}

        <div style={{ height: 1, background: 'var(--dsw-alias-border-l1)', margin: '4px 0' }} />

        <SectionTitle>问题（按 code 分组）</SectionTitle>
        {issuesError === null ? null : <NoteCard title="问题清单读不出来" body={issuesError} tone="error" />}
        {!problems.available && issuesError === null ? <div style={muted}>索引不可用，问题清单无法回答。</div> : null}
        {problems.available && problems.total === 0 && issuesError === null ? (
          <div style={{ ...muted, fontSize: 12 }}>{LIBRARY_EMPTY['no-issues'].body}</div>
        ) : null}
        {problems.truncated ? <div style={{ ...muted, fontSize: 12 }}>（问题已截断，只显示前 500 条）</div> : null}
        {problems.groups.map((group) => (
          <div key={group.code} style={{ display: 'grid', gap: 2 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{group.label}</span>
              <span style={{ ...muted, ...mono }}>{group.total}</span>
              {group.label === group.code ? null : <span style={{ ...muted, ...mono, fontSize: 11 }}>{group.code}</span>}
            </div>
            {group.items.slice(0, 5).map((issue, index) => {
              const target = findItemByPath(tree, issue.path)
              return (
                <button
                  key={`${group.code}-${index}`}
                  type="button"
                  style={{ ...rowStyle, paddingLeft: 10, cursor: target === undefined ? 'default' : 'pointer' }}
                  title={issue.detail}
                  disabled={target === undefined}
                  onClick={() => jumpTo(issue.path)}
                >
                  <span style={mono}>{describeIssueRow(issue)}</span>
                </button>
              )
            })}
            {group.items.length > 5 ? (
              <div style={{ ...muted, fontSize: 11, paddingLeft: 10 }}>还有 {group.items.length - 5} 条同类问题</div>
            ) : null}
          </div>
        ))}
      </div>

      <div style={detailColumnStyle}>
        {selected === null ? (
          <NoteCard title={LIBRARY_EMPTY['no-selection'].title} body={LIBRARY_EMPTY['no-selection'].body} />
        ) : editing && current !== null && fingerprintOf(current) !== null ? (
          // Keyed by the baseline: a reload or a save mounts a fresh draft instead
          // of leaving inputs bound to bytes that are already gone.
          <LibraryItemEditor
            key={`${detailKey ?? ''}:${current.fingerprint?.sha256 ?? ''}`}
            item={selected}
            detail={current}
            sessionId={sessionId}
            onSaved={handleSaved}
            onReloaded={handleReloaded}
            onCancel={cancelEdit}
            onDirtyChange={setDraftDirty}
          />
        ) : (
          <DetailPane
            item={selected}
            detail={current}
            error={detailError}
            status={status}
            onEdit={() => {
              setStatus(null)
              setEditing(true)
            }}
          />
        )}
      </div>
    </div>
  )
}
