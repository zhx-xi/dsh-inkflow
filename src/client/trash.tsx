/**
 * The recovery bin tab (roadmap X-9/X-10).
 *
 * One list, two actions, and the smallest possible amount of state. The page
 * shows what `GET /trash` reports and nothing else: an entry's size, when it was
 * deleted, why, and whether its copy is still on disk. It never decides whether a
 * file may come back — the Host does (`409 RESTORE_TARGET_EXISTS` when the author
 * recreated the file), and the page only explains the refusal it was given.
 *
 * The two actions differ in how hard they are to do by accident, on purpose:
 *
 *   * **恢复** is one click; it restores the bytes that were deleted, byte for
 *     byte, or refuses.
 *   * **彻底删除** is two clicks. The first only arms the row (`purgeStage`), the
 *     second sends `confirm: true` — the panel's half of ADR-0012 decision 4, with the
 *     route's own `CONFIRM_REQUIRED` as the net under it.
 *
 * The client half never touches the filesystem (ADR-0008 D4) and the request
 * carries a session id plus a manifest id, never a directory.
 */

import { useCallback, useEffect, useState } from 'react'

import { ACTION_BUTTON_STYLE } from './action-button.js'
import { fetchInternal, writeInternal } from './internal.js'
import type { InternalResult } from './internal.js'
import { SCROLL_BOX_STYLE, SCROLL_COLUMN_STYLE } from './layout-model.js'
import { Icon } from './icons.js'
import { useScrollBox } from './layout.js'
import {
  describeEntry,
  describeTrashError,
  describeTrashSummary,
  purgePrompt,
  purgeStage,
  readTrashValue,
  restoreBlockedReason,
} from './trash-model.js'
import type { TrashEntryView, TrashValue } from './trash-model.js'

// Same shape as the other pages: the height comes from the shared measurement
// (issue 116), the colours from the host theme (AGENTS.md §6). This module keeps
// its own small style set rather than importing `index.tsx`'s, which would make
// the two import each other.
const bodyStyle = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minHeight: 0 } as const

const columnStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
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

const dangerButtonStyle = {
  ...ACTION_BUTTON_STYLE,
  borderColor: 'var(--dsw-alias-state-error-primary)',
  color: 'var(--dsw-alias-state-error-primary)',
} as const

const rowStyle = {
  display: 'grid',
  gap: 2,
  padding: '8px 0',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
} as const

function SectionTitle({ children }: { children: string }) {
  return <div style={{ ...muted, fontSize: 12, letterSpacing: 0.2 }}>{children}</div>
}

function NoteCard({ title, body, tone }: { title: string; body: string; tone?: 'error' }) {
  const accent = tone === 'error' ? { borderColor: 'var(--dsw-alias-state-error-primary)' } : {}
  return (
    <div style={{ ...cardStyle, borderStyle: 'dashed', ...accent }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={muted}>{body}</div>
    </div>
  )
}

export function TrashView({ sessionId }: { sessionId: string }) {
  const [trash, setTrash] = useState<InternalResult<TrashValue> | null>(null)
  const [loading, setLoading] = useState(true)
  /** Which entry an action is running for, so only its own buttons go quiet. */
  const [busyId, setBusyId] = useState<string | null>(null)
  /** The entry whose purge was armed by the first click. */
  const [pendingPurgeId, setPendingPurgeId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const scrollBox = useScrollBox()

  const load = useCallback(async () => {
    setLoading(true)
    const result = await fetchInternal<TrashValue>('/trash', { sessionId })
    setTrash(result)
    setLoading(false)
  }, [sessionId])

  useEffect(() => {
    void load()
  }, [load])

  const list = readTrashValue(trash !== null && trash.ok ? (trash.value ?? undefined) : undefined)
  const loadError = trash !== null && !trash.ok ? describeTrashError(trash.error) : null

  const restore = async (entry: TrashEntryView): Promise<void> => {
    setBusyId(entry.id)
    setError(null)
    setNotice(null)
    const result = await writeInternal<{ restored?: { originalPath?: string } }>('/trash/restore', { id: entry.id }, { sessionId })
    setBusyId(null)
    if (!result.ok) {
      setError(describeTrashError(result.error))
      // A refusal of this kind means the row's facts changed (a file took the
      // path back), so the list is re-read even when nothing was restored.
      const code = result.error?.code
      if (code === 'RESTORE_TARGET_EXISTS' || code === 'TRASH_COPY_MISSING') await load()
      return
    }
    setNotice(`已恢复 ${result.value?.restored?.originalPath ?? entry.originalPath}`)
    await load()
  }

  const purge = async (entry: TrashEntryView): Promise<void> => {
    const stage = purgeStage(pendingPurgeId, entry.id)
    if (stage === 'armed') {
      // The first click only arms: it must be impossible to empty the bin with a
      // single stray press.
      setPendingPurgeId(entry.id)
      setNotice(purgePrompt(entry))
      setError(null)
      return
    }
    setBusyId(entry.id)
    setError(null)
    const result = await writeInternal<{ purged?: { originalPath?: string } }>('/trash/purge', { id: entry.id, confirm: true }, { sessionId })
    setBusyId(null)
    setPendingPurgeId(null)
    if (!result.ok) {
      setError(describeTrashError(result.error))
      return
    }
    setNotice(`已彻底删除 ${result.value?.purged?.originalPath ?? entry.originalPath}`)
    await load()
  }

  return (
    <div ref={scrollBox.ref} style={{ ...bodyStyle, ...SCROLL_BOX_STYLE, ...scrollBox.style }}>
      <div style={columnStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <SectionTitle>回收站</SectionTitle>
          <span style={{ ...muted, ...mono }}>{describeTrashSummary(list)}</span>
          <button type="button" style={{ ...ACTION_BUTTON_STYLE, marginLeft: 'auto' }} disabled={loading} onClick={() => void load()}>
            <Icon name="refresh" size={13} />
            {loading ? '读取中…' : '刷新'}
          </button>
        </div>
        {trash !== null && trash.ok && typeof trash.value?.manifestPath === 'string' ? (
          <div style={{ ...muted, ...mono }}>清单：{trash.value.manifestPath}</div>
        ) : null}

        {notice === null ? null : <div style={{ ...muted, fontSize: 12 }}>{notice}</div>}
        {error === null ? null : <NoteCard title="操作未完成" body={error} tone="error" />}
        {loadError === null ? null : <NoteCard title="回收站读取失败" body={loadError} tone="error" />}

        {!loading && loadError === null && list.total === 0 ? (
          <div style={{ ...muted, fontSize: 12 }}>这里还没有东西。删除章节时会先放一份副本进来，随时可以恢复。</div>
        ) : null}

        {list.entries.length === 0 ? null : (
          <div style={cardStyle}>
            {list.entries.map((entry) => {
              const facts = describeEntry(entry)
              const blocked = restoreBlockedReason(entry)
              const busy = busyId === entry.id
              const armed = purgeStage(pendingPurgeId, entry.id) === 'confirmed'
              return (
                <div key={entry.id} style={rowStyle}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ ...mono, wordBreak: 'break-all' }}>{facts.path}</span>
                    <span style={{ ...muted, fontSize: 12 }}>{facts.size}</span>
                    <span style={{ ...muted, fontSize: 12 }}>{facts.reason}</span>
                    <span style={{ ...muted, ...mono, fontSize: 11 }}>{facts.deletedAt}</span>
                    <span style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
                      <button
                        type="button"
                        style={ACTION_BUTTON_STYLE}
                        disabled={busy || blocked !== null}
                        title={blocked ?? '把文件放回原路径（原路径被占用时会拒绝）'}
                        onClick={() => void restore(entry)}
                      >
                        <Icon name="undo" size={13} />
                        恢复
                      </button>
                      <button
                        type="button"
                        style={armed ? dangerButtonStyle : ACTION_BUTTON_STYLE}
                        disabled={busy}
                        title={armed ? '再点一次确认' : '需要点两次才执行'}
                        onClick={() => void purge(entry)}
                      >
                        <Icon name={armed ? 'check' : 'trash'} size={13} />
                        {armed ? '确认彻底删除' : '彻底删除'}
                      </button>
                    </span>
                  </div>
                  {blocked === null ? null : <div style={{ ...muted, fontSize: 11 }}>{blocked}</div>}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
