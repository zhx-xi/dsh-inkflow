/**
 * The chapter editor: a native `textarea` + a title field + a status
 * picker, wired to the four chapter write routes.
 *
 * WHY NO EDITOR LIBRARY (AGENTS.md §2, hard constraint "zero runtime
 * dependencies"): the project ships as one bundle with no runtime dependencies
 * and must not import `@deepseek-ai/*`. CodeMirror/ProseMirror would be a
 * megabyte of runtime for what a novelist needs here — plain text with
 * autosave, undo and a conflict prompt. External reference (novel-studio's
 * chapter editor) contributed the *wording* of the save states and "saving is a
 * gate, not a background hope"; no code or styles were copied.
 *
 * WHAT LIVES WHERE: everything the editor decides is in `editor-model.ts`
 * (dirty tracking, 1500ms debounce, the 500ms undo grouping, the conflict
 * state). This file only renders that state, binds keys, and turns Host answers
 * into `SaveOutcome`s. That split is what makes the behaviour testable without a
 * DOM.
 */

import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { fetchInternal, writeInternal } from './internal.js'
import {
  AUTOSAVE_DELAY_MS,
  CHAPTER_STATUSES,
  SAVE_LABELS,
  UNDO_GROUP_MS,
  createEditorModel,
  isChapterStatus,
} from './editor-model.js'
import type {
  ChapterStatus,
  EditorFields,
  EditorModel,
  EditorState,
  FileFingerprint,
  ReloadResult,
  SaveOutcome,
  SaveRequest,
} from './editor-model.js'
import type { ChapterStyle } from './editor-model.js'
import { describeRouteError } from './panel-model.js'
import type { ChapterDetailValue } from './panel-model.js'

const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 } as const
const muted = { color: 'var(--dsw-alias-label-secondary)' } as const

const fieldStyle = {
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-primary)',
  padding: '4px 8px',
  fontSize: 13,
} as const

const buttonStyle = {
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  borderRadius: 6,
  padding: '3px 10px',
  fontSize: 12,
  cursor: 'pointer',
} as const

const cardStyle = {
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 8,
  padding: '10px 12px',
  background: 'var(--dsw-alias-bg-layer-1)',
} as const

/** One volume in the editor's "which volume" picker. */
export interface VolumeOption {
  volumeId: string
  title: string
}

export interface EditorPaneProps {
  sessionId: string
  chapterId: string
  detail: ChapterDetailValue
  volumes: readonly VolumeOption[]
  /** The Host confirmed a write: the tree may have a new title/path. */
  onSaved: () => void
  /** The chapter is gone (deleted here, or refused as not-found). */
  onGone: () => void
}

/** A fingerprint the Host reported, or `null` when it sent something else. */
function asFingerprint(value: unknown): FileFingerprint | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const sha256 = record['sha256']
  if (typeof sha256 !== 'string' || sha256 === '') return null
  const size = record['size']
  const mtimeMs = record['mtimeMs']
  return {
    sha256,
    size: typeof size === 'number' ? size : 0,
    mtimeMs: typeof mtimeMs === 'number' ? mtimeMs : 0,
  }
}

/** The three editable fields of a `GET /chapters/:id` answer. */
function fieldsOf(detail: ChapterDetailValue, chapterId: string): EditorFields {
  const status: ChapterStatus = isChapterStatus(detail.status) ? detail.status : 'draft'
  return {
    title: (detail.title ?? chapterId).trim() === '' ? chapterId : (detail.title ?? chapterId),
    body: detail.body ?? '',
    status,
  }
}

/**
 * The file's own format from the same answer (ADR-0016). Only the two values the
 * Host can report are accepted; anything else falls back to what a new file gets,
 * so a chatty field can never make the editor declare a style the Host rejects.
 */
function styleOf(source: { eol?: unknown; bom?: unknown }): ChapterStyle {
  const eol = source.eol === 'crlf' ? 'crlf' : 'lf'
  return { eol, bom: source.bom === true }
}

/**
 * `POST /chapters/:id` → the editor's `SaveOutcome`.
 *
 * A 409 `FILE_CHANGED` is the one answer that must not be flattened into "save
 * failed": it carries what changed, and the editor turns it into a prompt.
 */
async function saveChapter(sessionId: string, chapterId: string, request: SaveRequest): Promise<SaveOutcome> {
  const payload: Record<string, unknown> = {
    title: request.title,
    body: request.body,
    status: request.status,
    // The format round trip (issue 132): the Host normalises every payload, so the
    // file's own line ending and BOM can only survive if they are sent back.
    eol: request.eol,
    bom: request.bom,
  }
  if (request.expected !== undefined) payload['expected'] = request.expected

  const result = await writeInternal<{ fingerprint?: FileFingerprint | null; eol?: unknown; bom?: unknown }>(
    `/chapters/${encodeURIComponent(chapterId)}`,
    payload,
    { sessionId },
  )
  if (result.ok) {
    const fingerprint = asFingerprint(result.value?.fingerprint)
    const style = styleOf(result.value ?? {})
    return {
      ok: true,
      ...(fingerprint === null ? {} : { fingerprint }),
      // The Host echoes what it actually wrote; the model adopts it.
      ...(result.value?.eol === undefined ? {} : { style }),
    }
  }
  const error = result.error
  if (result.status === 409 && error?.code === 'FILE_CHANGED') {
    const changed = Array.isArray(error['changed']) ? (error['changed'] as unknown[]).map(String) : []
    return { ok: false, conflict: true, current: asFingerprint(error['current']), changed }
  }
  return {
    ok: false,
    conflict: false,
    code: error?.code ?? `http-${result.status}`,
    message: describeRouteError(error),
  }
}

/** Re-read the chapter: "重新载入（丢弃我的修改）". */
async function loadChapter(sessionId: string, chapterId: string): Promise<ReloadResult | null> {
  const result = await fetchInternal<ChapterDetailValue>(`/chapters/${encodeURIComponent(chapterId)}`, { sessionId })
  if (!result.ok || result.value === undefined) return null
  return {
    fields: fieldsOf(result.value, chapterId),
    fingerprint: asFingerprint(result.value.fingerprint),
    style: styleOf(result.value),
  }
}

/** The save-state pill: one word per phase, plus the tone it renders in. */
function phaseTone(phase: EditorState['phase']): string {
  if (phase === 'conflict' || phase === 'error') return 'var(--dsw-alias-state-error-primary)'
  if (phase === 'dirty') return 'var(--dsw-alias-state-warn-primary)'
  if (phase === 'saved') return 'var(--dsw-alias-state-success-primary)'
  return 'var(--dsw-alias-label-secondary)'
}

export function EditorPane({ sessionId, chapterId, detail, volumes, onSaved, onGone }: EditorPaneProps) {
  // One model per mounted editor; the parent remounts on chapter change (key),
  // so this never has to migrate state between two chapters.
  const modelRef = useRef<EditorModel | null>(null)
  if (modelRef.current === null) {
    modelRef.current = createEditorModel({
      chapterId,
      path: detail.path ?? chapterId,
      fields: fieldsOf(detail, chapterId),
      fingerprint: asFingerprint(detail.fingerprint),
      style: styleOf(detail),
      save: (request) => saveChapter(sessionId, chapterId, request),
      reload: () => loadChapter(sessionId, chapterId),
    })
  }
  const model = modelRef.current

  const [state, setState] = useState<EditorState>(() => model.getState())
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  useEffect(() => {
    setState(model.getState())
    return model.subscribe(() => setState(model.getState()))
  }, [model])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!(event.ctrlKey || event.metaKey)) return
    // `event.key` is layout-dependent but 's'/'z' are stable across layouts we
    // care about; the letter keys are the ones writers press.
    const key = event.key.toLowerCase()
    if (key === 's') {
      event.preventDefault()
      void model.save('manual')
    } else if (key === 'z' && !event.shiftKey) {
      event.preventDefault()
      model.undo()
    }
  }

  const moveTo = async (volumeId: string): Promise<void> => {
    const result = await writeInternal(`/chapters/${encodeURIComponent(chapterId)}/move`, { volumeId: volumeId === '' ? null : volumeId }, { sessionId })
    if (!result.ok) {
      setActionError(describeRouteError(result.error))
      return
    }
    setActionError(null)
    onSaved()
  }

  const removeChapter = async (): Promise<void> => {
    const payload: Record<string, unknown> = {}
    if (state.fingerprint !== null) payload['expected'] = { sha256: state.fingerprint.sha256 }
    const result = await writeInternal(`/chapters/${encodeURIComponent(chapterId)}`, payload, { method: 'DELETE', sessionId })
    setConfirmingDelete(false)
    if (!result.ok) {
      setActionError(describeRouteError(result.error))
      return
    }
    setActionError(null)
    onGone()
  }

  const conflict = state.conflict

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0, flex: 1 }} onKeyDown={onKeyDown}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input
          aria-label="章节标题"
          value={state.fields.title}
          onChange={(event) => model.setTitle(event.target.value)}
          style={{ ...fieldStyle, flex: '1 1 220px', fontWeight: 600 }}
        />
        <select
          aria-label="章节状态"
          value={state.fields.status}
          onChange={(event) => {
            const next = event.target.value
            if (isChapterStatus(next)) model.setStatus(next)
          }}
          style={{ ...fieldStyle, ...mono }}
        >
          {CHAPTER_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
        <select
          aria-label="所属卷"
          value={detail.volumeId ?? ''}
          onChange={(event) => void moveTo(event.target.value)}
          style={{ ...fieldStyle, ...mono }}
        >
          <option value="">未分卷</option>
          {volumes.map((volume) => (
            <option key={volume.volumeId} value={volume.volumeId}>
              {volume.volumeId} {volume.title}
            </option>
          ))}
        </select>
        <span style={{ ...mono, ...muted }}>{state.fields.body.length} 字</span>
        <span style={{ ...mono, color: phaseTone(state.phase) }} title={`自动保存：停止输入 ${AUTOSAVE_DELAY_MS / 1000} 秒`}>
          {SAVE_LABELS[state.phase]}
        </span>
        <label style={{ ...mono, ...muted, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input type="checkbox" checked={state.autosave} onChange={(event) => model.setAutosave(event.target.checked)} />
          自动保存
        </label>
        <button type="button" style={buttonStyle} onClick={() => void model.save('manual')} title="Ctrl/Cmd+S">
          保存
        </button>
        {confirmingDelete ? (
          <span style={{ display: 'inline-flex', gap: 4 }}>
            <button type="button" style={{ ...buttonStyle, borderColor: 'var(--dsw-alias-state-error-primary)' }} onClick={() => void removeChapter()}>
              确认删除
            </button>
            <button type="button" style={buttonStyle} onClick={() => setConfirmingDelete(false)}>
              取消
            </button>
          </span>
        ) : (
          <button type="button" style={buttonStyle} onClick={() => setConfirmingDelete(true)}>
            删除
          </button>
        )}
      </div>

      {conflict === null ? null : (
        <div style={{ ...cardStyle, borderColor: 'var(--dsw-alias-state-error-primary)' }}>
          <div style={{ fontWeight: 600, color: 'var(--dsw-alias-state-error-primary)', marginBottom: 4 }}>
            这一章在磁盘上被改过了（{conflict.changed.join('、') || 'sha256'}）
          </div>
          <div style={{ ...muted, marginBottom: 8 }}>
            面板没有覆盖它。你的改动还在编辑器里：可以重新载入磁盘上的版本，也可以明确覆盖。
          </div>
          <span style={{ display: 'inline-flex', gap: 6 }}>
            <button type="button" style={buttonStyle} onClick={() => void model.discardAndReload()}>
              重新载入（丢弃我的修改）
            </button>
            <button type="button" style={{ ...buttonStyle, borderColor: 'var(--dsw-alias-state-error-primary)' }} onClick={() => void model.overwriteAndSave()}>
              仍要保存（覆盖）
            </button>
          </span>
        </div>
      )}

      {actionError === null ? null : (
        <div style={{ ...cardStyle, borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' }}>
          {actionError}
        </div>
      )}

      <textarea
        aria-label="章节正文"
        value={state.fields.body}
        onChange={(event) => model.setText(event.target.value)}
        spellCheck={false}
        placeholder="正文（Markdown）。停止输入 1.5 秒自动保存，Ctrl/Cmd+S 立刻保存，Ctrl/Cmd+Z 撤销。"
        style={{
          flex: 1,
          minHeight: 240,
          resize: 'none',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: 8,
          background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-label-primary)',
          padding: '10px 12px',
          lineHeight: 1.7,
          fontSize: 14,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        }}
      />

      <div style={{ ...mono, ...muted }}>
        撤销合并粒度 {UNDO_GROUP_MS}ms · 保存成功后清空撤销栈 · 冲突必须二选一，默认不覆盖
      </div>
    </div>
  )
}
