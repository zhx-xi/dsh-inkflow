/**
 * The setting library's entry editor (issue #30, second batch).
 *
 * Scope: one entry at a time — the common frontmatter fields of its kind as a
 * form, the Markdown body as plain text, and a save that carries the CAS
 * baseline the detail route handed out. Keys the form does not know are shown
 * folded and read-only; they are NOT part of the payload, so the Host's
 * line-level patch leaves them exactly as the author wrote them.
 *
 * Why this lives in its own file rather than inside `library.tsx`: the read pane
 * is already a component tree, and the editor carries its own state machine
 * (draft → save → conflict → reload). Splitting keeps both readable
 * (AGENTS.md §10.5).
 *
 * Why it does not import `library.tsx`'s style helpers: that module imports this
 * one, so the reverse edge would be a runtime cycle. The few primitives below are
 * local on purpose.
 *
 * The client half never touches the filesystem (ADR-0008 D4): it calls the
 * private channel with a session id and an entity address, never a directory.
 */

import { useEffect, useMemo, useState } from 'react'

import { fetchInternal, writeInternal } from './internal.js'
import {
  describeLibraryError,
  describeSaveError,
  draftFromItem,
  draftPayload,
  fieldsForKind,
  fingerprintOf,
  unknownFields,
} from './library-model.js'
import type { LibraryDraft, LibraryFieldSpec, LibraryItemValue, LibraryTreeItem } from './library-model.js'

const labelStyle = {
  display: 'flex',
  gap: 6,
  alignItems: 'baseline',
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
} as const

const inputStyle = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '4px 6px',
  fontSize: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  color: 'var(--dsw-alias-label-primary)',
  background: 'var(--dsw-alias-bg-layer-2)',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 6,
} as const

const buttonStyle = {
  padding: '4px 12px',
  fontSize: 12,
  borderRadius: 6,
  cursor: 'pointer',
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
} as const

const primaryButtonStyle = {
  ...buttonStyle,
  background: 'var(--dsw-alias-state-success-primary)',
  borderColor: 'var(--dsw-alias-state-success-primary)',
  color: 'var(--dsw-alias-bg-layer-1)',
} as const

const cardStyle = {
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 8,
  padding: '10px 12px',
  background: 'var(--dsw-alias-bg-layer-1)',
} as const

const muted = { color: 'var(--dsw-alias-label-secondary)' } as const
const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 } as const

function errorTone() {
  return { borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' } as const
}

export interface LibraryItemEditorProps {
  item: LibraryTreeItem
  /** The detail the read pane loaded: the baseline this save is written against. */
  detail: LibraryItemValue
  sessionId: string
  /** The save landed: the parent refreshes the tree and leaves edit mode. */
  onSaved: (value: LibraryItemValue) => void
  /** A conflict was resolved by reloading: the parent's copy is stale, this is the new one. */
  onReloaded: (value: LibraryItemValue) => void
  onCancel: () => void
  /** `true` while the draft differs from the file — the parent guards leaving on it. */
  onDirtyChange: (dirty: boolean) => void
}

/** One input for one field: a checkbox, a one-item-per-line box, or a single line. */
function FieldInput({ spec, value, onChange }: { spec: LibraryFieldSpec; value: string; onChange: (next: string) => void }) {
  if (spec.type === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={value === 'true'}
        onChange={(event) => onChange(event.target.checked ? 'true' : 'false')}
      />
    )
  }
  if (spec.type === 'list') {
    const rows = Math.min(8, Math.max(2, value.split('\n').length + 1))
    return (
      <textarea
        value={value}
        rows={rows}
        spellCheck={false}
        placeholder="每行一项"
        style={{ ...inputStyle, resize: 'vertical' }}
        onChange={(event) => onChange(event.target.value)}
      />
    )
  }
  return (
    <input
      type={spec.type === 'number' ? 'number' : 'text'}
      value={value}
      spellCheck={false}
      style={inputStyle}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

/** Read-only preview of a key the form does not edit. */
function PreviewRow({ name, value }: { name: string; value: unknown }) {
  const shown =
    value === null || value === undefined
      ? '—'
      : Array.isArray(value)
        ? value.map((entry) => String(entry)).join('、')
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value)
  return (
    <div style={{ display: 'flex', gap: 8, ...mono }}>
      <span style={{ ...muted, minWidth: 96 }}>{name}</span>
      <span style={{ wordBreak: 'break-word' }}>{shown}</span>
    </div>
  )
}

export function LibraryItemEditor({ item, detail, sessionId, onSaved, onReloaded, onCancel, onDirtyChange }: LibraryItemEditorProps) {
  // The editor keeps its own copy of the baseline: a conflict is resolved by
  // reloading the file, which must NOT throw the author's draft away silently —
  // it replaces both at once, after the explicit click below.
  const [baseline, setBaseline] = useState<LibraryItemValue>(detail)
  const [draft, setDraft] = useState<LibraryDraft>(() =>
    draftFromItem(item.kind, baseline.frontmatter ?? {}, baseline.body ?? ''),
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const fields = useMemo(() => fieldsForKind(item.kind), [item.kind])
  const unknown = useMemo(() => unknownFields(item.kind, baseline.frontmatter ?? {}), [item.kind, baseline])

  const payload = draftPayload(item.kind, draft, baseline.frontmatter ?? {}, baseline.body ?? '')
  const dirty = payload !== null

  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  const setField = (key: string, next: string): void => {
    setDraft((current) => ({ ...current, values: { ...current.values, [key]: next } }))
  }

  /** Save against the baseline. A 409 is shown as a conflict; it is never retried blind. */
  const save = async (): Promise<void> => {
    if (saving) return
    if (payload === null) {
      setNotice('没有改动')
      setError(null)
      return
    }
    const expected = fingerprintOf(baseline)
    if (expected === null) {
      setError('这一条没有基线指纹（详情没读到文件），重新打开后再改。')
      return
    }
    const body: Record<string, unknown> = {
      kind: item.kind,
      id: item.id,
      frontmatter: payload.frontmatter,
      expected,
    }
    if (payload.body !== undefined) body['body'] = payload.body

    setSaving(true)
    setError(null)
    setNotice(null)
    setConflict(false)
    const result = await writeInternal<LibraryItemValue>('/library/item', body, { sessionId })
    setSaving(false)
    if (result.ok) {
      onSaved(result.value ?? {})
      return
    }
    if (result.status === 409 || result.error?.code === 'FILE_CHANGED') {
      setConflict(true)
      setError(describeSaveError(result.error))
      return
    }
    setError(describeSaveError(result.error))
  }

  /** The explicit half of a conflict: drop the local draft, take the file as it is. */
  const reload = async (): Promise<void> => {
    setSaving(true)
    const query = `?kind=${encodeURIComponent(item.kind)}&id=${encodeURIComponent(item.id)}`
    const result = await fetchInternal<LibraryItemValue>(`/library/item${query}`, { sessionId })
    setSaving(false)
    if (!result.ok) {
      setError(describeLibraryError(result.error))
      return
    }
    const value = result.value ?? {}
    setBaseline(value)
    setDraft(draftFromItem(item.kind, value.frontmatter ?? {}, value.body ?? ''))
    setConflict(false)
    setError(null)
    setNotice('已按磁盘上的内容重新加载，本地改动已丢弃。')
    onReloaded(value)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>编辑：{baseline.title ?? item.title}</span>
        <span style={{ ...muted, ...mono }}>{baseline.path ?? item.path}</span>
        {dirty ? <span style={{ ...muted, fontSize: 12 }}>· 未保存</span> : null}
      </div>


      <div style={cardStyle}>
        <div style={{ ...muted, fontSize: 12, marginBottom: 6 }}>常见字段（{item.kind}）</div>
        <div style={{ display: 'grid', gap: 8 }}>
          {fields.length === 0 ? (
            <div style={{ ...muted, fontSize: 12 }}>
              这一类还没有字段表单：它的文件结构随后续版本进入投影，现在只能改正文。
            </div>
          ) : null}
          {fields.map((spec) => (
            <div key={spec.key} style={{ display: 'grid', gap: 2 }}>
              <label style={labelStyle}>
                {spec.label}
                <span style={{ ...mono, fontSize: 11 }}>{spec.key}</span>
              </label>
              <FieldInput spec={spec} value={draft.values[spec.key] ?? ''} onChange={(next) => setField(spec.key, next)} />
            </div>
          ))}
        </div>
      </div>

      {unknown.length === 0 ? null : (
        <details style={cardStyle}>
          <summary style={{ ...muted, fontSize: 12, cursor: 'pointer' }}>
            其它字段（{unknown.length} 个，只读，保存时原样保留）
          </summary>
          <div style={{ display: 'grid', gap: 2, marginTop: 6 }}>
            {unknown.map(([key, value]) => (
              <PreviewRow key={key} name={key} value={value} />
            ))}
          </div>
        </details>
      )}

      <div style={cardStyle}>
        <div style={{ ...muted, fontSize: 12, marginBottom: 6 }}>正文（Markdown）</div>
        <textarea
          value={draft.body}
          rows={14}
          spellCheck={false}
          style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6 }}
          onChange={(event) => setDraft((current) => ({ ...current, body: event.target.value }))}
        />
        <div style={{ ...muted, ...mono, marginTop: 4 }}>{[...draft.body.replace(/\s+/gu, '')].length} 字</div>
      </div>

      {/* The refusal/notice sits NEXT TO the button that produced it (issue 115):
          the old position was the top of the editor, which on a long entry is
          several screens away — the author clicked 保存 and saw nothing happen. */}
      {error === null ? null : (
        <div style={{ ...cardStyle, ...(conflict ? errorTone() : {}) }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{conflict ? '文件已被改动' : '保存失败'}</div>
          {/* `role="alert"` covers the TEXT only: wrapping the buttons would make a
              screen reader announce them assertive on every failed save. */}
          <div role="alert" style={{ ...muted, ...(conflict ? { color: 'var(--dsw-alias-state-error-primary)' } : {}) }}>
            {error}
          </div>
          {conflict ? (
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button type="button" style={buttonStyle} disabled={saving} onClick={() => void reload()}>
                重新加载
              </button>
              <span style={{ ...muted, fontSize: 11 }}>重新加载会丢弃你没保存的改动，不会覆盖磁盘上的文件。</span>
            </div>
          ) : null}
        </div>
      )}
      {notice === null ? null : <div style={{ ...muted, ...mono }} role="status">{notice}</div>}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" style={primaryButtonStyle} disabled={saving || payload === null} onClick={() => void save()}>
          {saving ? '保存中…' : '保存'}
        </button>
        <button type="button" style={buttonStyle} disabled={saving} onClick={onCancel}>
          取消
        </button>
        <span style={{ ...muted, fontSize: 11 }}>
          保存会带上这次加载的基线指纹：磁盘上被改动过就拒绝写入，不会覆盖。
        </span>
      </div>
    </div>
  )
}
