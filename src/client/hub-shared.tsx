/**
 * The shared-content page of the book hub (ADR-0010 D5, issues #87 + #40).
 *
 * WHAT IT ASKS FOR: `GET /inkflow/internal/hub/shared` (the library itself) and,
 * once a book is picked, `GET /inkflow/internal/hub/shared/copies?book=…` (what
 * that book already holds, and which copies are stale). Both are sessionless: the
 * page lives inside the root-scoped book hub, so there is no session, and it must
 * never name a directory for the LIBRARY — that location is the plugin's
 * configuration. The one path it does send is `book`, and it can only be a path
 * the Host itself listed in `/hub/books` (the channel refuses anything else).
 *
 * WHAT IT WRITES: copying an entry into the book, and refreshing one stale copy.
 * Both are two-step — the button arms a confirm row and the request only carries
 * `confirm: true` after 确认 — because the Host demands that confirmation and a UI
 * that writes on one click would make the discipline decorative. Nothing here can
 * change the shared library: there is no "push" direction (ADR-0007 C6).
 *
 * Every colour comes from a `--dsw-alias-*` token (AGENTS.md §6); no literal
 * colour appears in this file, which the bundle test asserts.
 */

import { useCallback, useEffect, useState } from 'react'

import { fetchInternal, writeInternal } from './internal.js'
import {
  SHARED_KIND_LABELS,
  SHARED_TEXTS,
  copyModes,
  copyNeedsUpdate,
  copyTargets,
  copiesSummary,
  describeCopyState,
  describeSharedSource,
  describeTags,
  entryName,
  isEmptyFilter,
  isEmptyLibrary,
  isSeriesLink,
  readSharedCopies,
  readSharedLibrary,
  selfContainedNote,
  sharedGroups,
  sharedSummary,
} from './hub-shared-model.js'
import type {
  HubSharedValue,
  SharedCopiesState,
  SharedCopiesValue,
  SharedCopyRow,
  SharedEntry,
  SharedState,
} from './hub-shared-model.js'
import { describeSharedError } from './hub-shared-model.js'

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

const confirmStyle = {
  ...rowStyle,
  borderColor: 'var(--dsw-alias-state-warn-primary)',
  gap: 6,
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

/** The armed confirmation: what a click would write, and for which book. */
interface Pending {
  action: 'copy' | 'update'
  entryId: string
  file?: string
  mode: 'copy' | 'reference'
  label: string
}

const INITIAL: SharedState = {
  status: 'ready',
  created: false,
  indexSource: 'scan',
  entries: [],
  countsByKind: {},
  total: 0,
  truncated: false,
  rootWarning: null,
}

const NO_COPIES: SharedCopiesState = { status: 'idle', message: SHARED_TEXTS.pickBook }

/**
 * The shared library, with the two take-out actions.
 *
 * `onClose` returns to the book list: a root-scoped panel has one body area, so
 * the two pages are two modes of the same panel rather than two slots.
 */
export function SharedLibraryView({
  onClose,
  books,
}: {
  onClose: () => void
  books?: ReadonlyArray<{ path?: string; title?: string; state?: string }>
}) {
  const [state, setState] = useState<SharedState>(INITIAL)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState('')
  const [copies, setCopies] = useState<SharedCopiesState>(NO_COPIES)
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  const targets = copyTargets(books ?? [])

  // The first usable book is the default target: the common case is "the book I
  // just opened", and an empty selector would make every row unusable.
  useEffect(() => {
    if (selected !== '') return
    const first = targets[0]
    if (first !== undefined) setSelected(first.path)
  }, [selected, targets])

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

  const loadCopies = useCallback((book: string) => {
    if (book === '') {
      setCopies(NO_COPIES)
      return
    }
    setCopies({ status: 'idle', message: SHARED_TEXTS.copiesLoading })
    void fetchInternal<SharedCopiesValue>(`/hub/shared/copies?book=${encodeURIComponent(book)}`, {
      sessionless: true,
    }).then((result) => {
      setCopies(readSharedCopies(result))
    })
  }, [])

  useEffect(() => {
    loadCopies(selected)
  }, [loadCopies, selected, revision])

  const refresh = useCallback(() => {
    setNotice(null)
    setPending(null)
    setRevision((current) => current + 1)
  }, [])

  /** Run the armed action. `confirm: true` exists only on this path. */
  const runPending = useCallback(async () => {
    if (pending === null || selected === '' || busy) return
    setBusy(true)
    const path = pending.action === 'copy' ? '/hub/shared/copy' : '/hub/shared/update'
    const body =
      pending.action === 'copy'
        ? { book: selected, entryId: pending.entryId, mode: pending.mode, confirm: true }
        : { book: selected, entryId: pending.entryId, ...(pending.file === undefined ? {} : { file: pending.file }), confirm: true }
    const result = await writeInternal<{ files?: string[]; updated?: string[]; unchanged?: string[] }>(path, body, {
      sessionless: true,
    })
    setBusy(false)
    setPending(null)
    if (!result.ok) {
      setNotice({ tone: 'error', text: describeSharedError(result.error) })
      return
    }
    const files = Array.isArray(result.value?.files) ? result.value?.files : []
    const updated = Array.isArray(result.value?.updated) ? result.value?.updated : []
    const unchanged = Array.isArray(result.value?.unchanged) ? result.value?.unchanged : []
    setNotice({
      tone: 'ok',
      text:
        updated.length > 0
          ? `已更新：${updated.join('、')}`
          : files.length > 0
            ? `已复制：${files.join('、')}`
            : pending.action === 'copy'
              ? '已关联系列（不复制文件）'
              : `无需更新：${(unchanged ?? []).join('、')}`,
    })
    // Re-read both halves: the copy changed the book, and the row's state changed.
    setRevision((current) => current + 1)
  }, [busy, pending, selected])

  const groups = state.status === 'ready' ? sharedGroups(state.entries, state.countsByKind) : []
  const copyRows: SharedCopyRow[] = copies.status === 'ready' ? copies.copies : []

  return (
    <div style={sheetStyle}>
      <div style={headerStyle}>
        <span style={{ fontWeight: 600 }}>{SHARED_TEXTS.title}</span>
        <span style={{ ...muted, fontSize: 12 }}>{loading ? SHARED_TEXTS.loading : sharedSummary(state)}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button type="button" style={buttonStyle} onClick={onClose}>
            {SHARED_TEXTS.back}
          </button>
          <button type="button" style={buttonStyle} onClick={refresh} disabled={loading || busy}>
            {SHARED_TEXTS.refresh}
          </button>
        </span>
      </div>

      {/* The target book: the only path this page sends, and only from this list. */}
      <div style={{ ...cardStyle, gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>{SHARED_TEXTS.pickBook}</span>
          {targets.length === 0 ? (
            <span style={muted}>{SHARED_TEXTS.noBook}</span>
          ) : (
            <select
              value={selected}
              onChange={(event) => {
                setSelected(event.target.value)
                setPending(null)
                setNotice(null)
              }}
              style={{ ...buttonStyle, padding: '2px 6px' }}
            >
              {targets.map((target) => (
                <option key={target.path} value={target.path}>
                  {target.label}
                </option>
              ))}
            </select>
          )}
        </div>
        {state.status === 'ready' ? <div style={muted}>{describeSharedSource(state.indexSource)}</div> : null}
        {/* A configured-but-refused `sharedRoot` (#150): the list below comes from the
            default directory, and the author is standing here looking for entries that
            are somewhere else. Warn tone, no action — the fix is on the settings page. */}
        {state.status === 'ready' && state.rootWarning !== null ? (
          <div style={{ ...muted, color: 'var(--dsw-alias-state-warn-primary)' }}>{state.rootWarning}</div>
        ) : null}
        <div style={muted}>{SHARED_TEXTS.copyHint}</div>
        <div style={muted}>{SHARED_TEXTS.referenceHint}</div>
        <div style={muted}>{SHARED_TEXTS.seriesNote}</div>
      </div>

      {notice !== null ? (
        <div
          style={{
            ...cardStyle,
            borderColor:
              notice.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)',
            color:
              notice.tone === 'error' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)',
          }}
        >
          {notice.text}
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
        <div key={group.kind} style={groupStyle}>
          <div style={{ ...muted, fontWeight: 600 }}>
            {SHARED_KIND_LABELS[group.kind]} · {group.count}
          </div>
          {group.entries.map((entry) => {
            const entryId = typeof entry.entryId === 'string' ? entry.entryId : ''
            const armed = pending !== null && pending.action === 'copy' && pending.entryId === entryId
            return (
              <div key={`${group.kind}:${entryId}:${String(entry.path)}`} style={armed ? confirmStyle : rowStyle}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600 }}>{entryName(entry.path)}</span>
                  <span style={{ ...muted, fontSize: 12 }}>{describeTags(entry)}</span>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    {copyModes(entry.kind).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        style={buttonStyle}
                        disabled={busy || selected === '' || armed}
                        onClick={() =>
                          setPending({
                            action: 'copy',
                            entryId,
                            mode,
                            label: `${entryName(entry.path)}（${mode === 'reference' ? SHARED_TEXTS.reference : SHARED_TEXTS.copy}）`,
                          })
                        }
                      >
                        {mode === 'reference' ? SHARED_TEXTS.reference : SHARED_TEXTS.copy}
                      </button>
                    ))}
                  </span>
                </div>
                <div style={{ ...muted, ...mono }} title={String(entry.path)}>
                  {String(entry.path)} · {entryId || '（无 entryId）'}
                </div>
                {armed ? (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span>{`将写入：${pending.label}${isSeriesLink(entry.kind) ? '（只写 seriesId）' : ''}`}</span>
                    <button type="button" style={buttonStyle} onClick={() => void runPending()} disabled={busy}>
                      {busy ? SHARED_TEXTS.working : SHARED_TEXTS.confirmCopy}
                    </button>
                    <button type="button" style={buttonStyle} onClick={() => setPending(null)} disabled={busy}>
                      {SHARED_TEXTS.cancel}
                    </button>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ))}

      {/* What the book already holds (ADR-0007 V3): the stale list, per row. */}
      <div style={groupStyle}>
        <div style={{ ...muted, fontWeight: 600 }}>{SHARED_TEXTS.copies}</div>
        <div style={muted}>{copiesSummary(copies)}</div>
        {copies.status === 'ready' ? <div style={muted}>{selfContainedNote(copies)}</div> : null}
        {copies.status === 'ready' && copies.seriesId !== null ? (
          <div style={muted}>
            seriesId {copies.seriesId} · {copies.seriesFound ? '共享库里有这个系列' : '共享库里没有这个系列（只报告，不改动）'}
          </div>
        ) : null}
        {copies.status === 'ready' && copies.counts.stale > 0 ? <div style={muted}>{SHARED_TEXTS.staleHint}</div> : null}
        {copyRows.map((row) => {
          const file = typeof row.file === 'string' ? row.file : ''
          const armed = pending !== null && pending.action === 'update' && pending.file === file
          return (
            <div key={`copy:${file}`} style={armed ? confirmStyle : rowStyle}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600 }}>{entryName(file)}</span>
                <span style={muted}>{describeCopyState(row.state)}</span>
                {row.mode === 'reference' ? <span style={muted}>{SHARED_TEXTS.reference}</span> : null}
                <span style={{ marginLeft: 'auto' }}>
                  {copyNeedsUpdate(row) ? (
                    <button
                      type="button"
                      style={buttonStyle}
                      disabled={busy || selected === '' || armed}
                      onClick={() =>
                        setPending({
                          action: 'update',
                          entryId: typeof row.entryId === 'string' ? row.entryId : '',
                          file,
                          mode: 'copy',
                          label: file,
                        })
                      }
                    >
                      {SHARED_TEXTS.update}
                    </button>
                  ) : null}
                </span>
              </div>
              <div style={{ ...muted, ...mono }} title={file}>
                {file}
                {typeof row.contentHash === 'string' && typeof row.currentHash === 'string' && row.state === 'stale'
                  ? ` · ${row.contentHash.slice(0, 8)} → ${row.currentHash.slice(0, 8)}`
                  : ''}
              </div>
              {armed ? (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span>{`将用共享库当前内容覆盖：${pending.file ?? ''}（先写备份包，可回滚）`}</span>
                  <button type="button" style={buttonStyle} onClick={() => void runPending()} disabled={busy}>
                    {busy ? SHARED_TEXTS.working : SHARED_TEXTS.confirmUpdate}
                  </button>
                  <button type="button" style={buttonStyle} onClick={() => setPending(null)} disabled={busy}>
                    {SHARED_TEXTS.cancel}
                  </button>
                </div>
              ) : null}
            </div>
          )
        })}
        {copies.status === 'error' ? (
          <div style={{ ...cardStyle, borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' }}>
            {copies.message}
          </div>
        ) : null}
      </div>
    </div>
  )
}
