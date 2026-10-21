/**
 * The chapter editor's state machine (issue #19) — pure logic, no React, no IO.
 *
 * WHY THIS IS A SEPARATE MODULE: `node --test` has no DOM, so a React component
 * cannot be rendered here. Everything the editor *decides* — is there anything
 * unsaved, when does the debounce fire, what does undo restore, what happens
 * when the file changed under us — lives in this file and is unit-tested through
 * a bundle (`tests/panel-write.test.js`). What stays in the component is
 * rendering and key bindings, nothing else.
 *
 * THE THREE RULES THAT KEEP THE MANUSCRIPT SAFE (ADR-0005 files are the truth):
 *
 *   1. **A save is a CAS write** (§5.5): it carries the fingerprint of the bytes
 *      the editor read. If a human edited the file in their own editor in the
 *      meantime, the Host answers 409 `FILE_CHANGED` and writes nothing.
 *   2. **A conflict is never resolved automatically.** The editor keeps the
 *      local text, stops autosaving, and asks: reload (throw my edits away) or
 *      save again without a baseline (overwrite). Only a human pressing one of
 *      those two buttons can destroy either side.
 *   3. **Undo is local and cheap.** It never touches the file: it restores a
 *      snapshot of the three fields. Consecutive keystrokes merge into one entry
 *      (`UNDO_GROUP_MS`), and a successful save is a new save point that empties
 *      the stack, so `Ctrl+Z` can never walk back past what is on disk.
 */

/** Debounce window after the last keystroke. */
export const AUTOSAVE_DELAY_MS = 1500

/** Keystrokes closer together than this collapse into one undo entry. */
export const UNDO_GROUP_MS = 500

export type ChapterStatus = 'draft' | 'revised' | 'final'

/** The three statuses the domain accepts (`CHAPTER_STATUSES` in conventions.ts). */
export const CHAPTER_STATUSES: readonly ChapterStatus[] = ['draft', 'revised', 'final']

export function isChapterStatus(value: unknown): value is ChapterStatus {
  return value === 'draft' || value === 'revised' || value === 'final'
}

/** One of the three editable fields, as the editor holds it. */
export interface EditorFields {
  title: string
  body: string
  status: ChapterStatus
}

/** The fingerprint shape the Host reports (`file-cas.ts`). */
export interface FileFingerprint {
  size: number
  mtimeMs: number
  sha256: string
}

/** The CAS baseline (§5.5); only the fields present are checked. */
export interface FileExpectation {
  sha256?: string
  size?: number
  mtimeMs?: number
  absent?: boolean
}

/**
 * What the editor is currently doing. `conflict` and `error` are *states*, not
 * toasts: they stay until the user acts or the next save succeeds.
 */
export type SavePhase = 'idle' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error'

/** The four words the author sees next to the save button. */
export const SAVE_LABELS: Record<SavePhase, string> = {
  idle: '未修改',
  dirty: '未保存',
  saving: '保存中…',
  saved: '已保存',
  conflict: '冲突：文件已被外部改动',
  error: '保存失败',
}

export type SaveReason = 'auto' | 'manual' | 'overwrite'

export interface SaveRequest {
  chapterId: string
  title: string
  body: string
  status: ChapterStatus
  /** Absent only for an explicit overwrite (the user pressed "仍要保存"). */
  expected?: FileExpectation
  reason: SaveReason
}

export type SaveOutcome =
  | { ok: true; fingerprint?: FileFingerprint; fields?: Partial<EditorFields> }
  | { ok: false; conflict: true; current: FileFingerprint | null; changed: string[] }
  | { ok: false; conflict: false; code: string; message?: string }

export interface ConflictInfo {
  /** What is on disk now (`null` = the file is gone). */
  current: FileFingerprint | null
  /** Which baseline field no longer matched: `sha256`, `size`, `absent`… */
  changed: string[]
}

export interface EditorState {
  chapterId: string
  path: string
  /** What the user sees in the three fields right now. */
  fields: EditorFields
  /** What the Host last confirmed — the point the file is at. */
  saved: EditorFields
  fingerprint: FileFingerprint | null
  phase: SavePhase
  conflict: ConflictInfo | null
  errorCode: string | null
  error: string | null
  autosave: boolean
  canUndo: boolean
  dirty: boolean
}

export interface ReloadResult {
  fields: EditorFields
  fingerprint?: FileFingerprint | null
}

export interface EditorModelOptions {
  chapterId: string
  path: string
  fields: EditorFields
  fingerprint?: FileFingerprint | null
  autosave?: boolean
  save: (request: SaveRequest) => Promise<SaveOutcome>
  /** Re-read the chapter from the Host (used by "reload, discard my edits"). */
  reload: () => Promise<ReloadResult | null>
  onChange?: (state: EditorState) => void
  now?: () => number
  /** Injected so the debounce is testable without real time. */
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface EditorModel {
  getState: () => EditorState
  subscribe: (listener: () => void) => () => void
  setText: (text: string) => void
  setTitle: (title: string) => void
  setStatus: (status: ChapterStatus) => void
  setAutosave: (enabled: boolean) => void
  /** `manual` is Ctrl/Cmd+S; `auto` is the debounce; `overwrite` skips the CAS. */
  save: (reason?: 'auto' | 'manual') => Promise<void>
  undo: () => boolean
  discardAndReload: () => Promise<void>
  overwriteAndSave: () => Promise<void>
  dispose: () => void
}

function sameFields(a: EditorFields, b: EditorFields): boolean {
  return a.title === b.title && a.body === b.body && a.status === b.status
}

/**
 * The CAS baseline to send. `sha256` alone: it is the content identity, while
 * `size`/`mtimeMs` are corroboration that different filesystems round
 * differently (§5.5).
 */
function expectationOf(fingerprint: FileFingerprint | null): FileExpectation | undefined {
  return fingerprint === null ? undefined : { sha256: fingerprint.sha256 }
}

interface UndoEntry {
  fields: EditorFields
  at: number
}

export function createEditorModel(options: EditorModelOptions): EditorModel {
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => globalThis.setTimeout(callback, ms))
  const clearTimer =
    options.clearTimer ?? ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>))

  let fields: EditorFields = { ...options.fields }
  let saved: EditorFields = { ...options.fields }
  let fingerprint: FileFingerprint | null = options.fingerprint ?? null
  let phase: SavePhase = 'idle'
  let conflict: ConflictInfo | null = null
  let errorCode: string | null = null
  let errorMessage: string | null = null
  let autosave = options.autosave !== false
  let undoStack: UndoEntry[] = []
  let timer: unknown = null
  let saving = false
  let disposed = false
  const listeners = new Set<() => void>()

  const dirty = (): boolean => !sameFields(fields, saved)

  function snapshot(): EditorState {
    return {
      chapterId: options.chapterId,
      path: options.path,
      fields: { ...fields },
      saved: { ...saved },
      fingerprint,
      phase,
      conflict: conflict === null ? null : { current: conflict.current, changed: [...conflict.changed] },
      errorCode,
      error: errorMessage,
      autosave,
      canUndo: undoStack.length > 0,
      dirty: dirty(),
    }
  }

  function emit(): void {
    const state = snapshot()
    for (const listener of listeners) listener()
    options.onChange?.(state)
  }

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
  }

  function scheduleSave(): void {
    cancelTimer()
    // A conflict pauses autosave on purpose: retrying would hammer the Host and
    // could overwrite a change the user has not been told about yet.
    if (!autosave || phase === 'conflict' || disposed) return
    timer = setTimer(() => {
      timer = null
      void runSave('auto')
    }, AUTOSAVE_DELAY_MS)
  }

  /**
   * Snapshot the current fields before a change. Consecutive text edits inside
   * `UNDO_GROUP_MS` of the previous snapshot collapse into it, so one `Ctrl+Z`
   * undoes a burst of typing rather than a single character.
   */
  function pushUndo(merge: boolean): void {
    const at = now()
    const last = undoStack[undoStack.length - 1]
    if (merge && last !== undefined && at - last.at <= UNDO_GROUP_MS) return
    undoStack.push({ fields: { ...fields }, at })
  }

  function commit(next: Partial<EditorFields>, merge: boolean): void {
    const candidate: EditorFields = { ...fields, ...next }
    if (sameFields(candidate, fields)) return
    pushUndo(merge)
    fields = candidate
    errorCode = null
    errorMessage = null
    // A conflict is not cleared by typing — only by one of the two buttons.
    if (phase !== 'conflict') phase = 'dirty'
    scheduleSave()
    emit()
  }

  async function runSave(reason: SaveReason): Promise<void> {
    if (disposed || saving) return
    if (reason !== 'overwrite' && !dirty()) return
    if (reason === 'auto' && (phase === 'conflict' || phase === 'error')) return

    cancelTimer()
    const sent: EditorFields = { ...fields }
    const request: SaveRequest = {
      chapterId: options.chapterId,
      title: sent.title,
      body: sent.body,
      status: sent.status,
      reason,
      ...(reason === 'overwrite' ? {} : { expected: expectationOf(fingerprint) }),
    }

    saving = true
    phase = 'saving'
    emit()

    let outcome: SaveOutcome
    try {
      outcome = await options.save(request)
    } catch (cause) {
      outcome = { ok: false, conflict: false, code: 'save-failed', message: cause instanceof Error ? cause.message : String(cause) }
    }
    saving = false
    if (disposed) return

    if (outcome.ok === true) {
      if (outcome.fields !== undefined) {
        fields = { ...fields, ...outcome.fields }
        saved = { ...fields }
      } else {
        saved = { ...sent }
      }
      if (outcome.fingerprint !== undefined) fingerprint = outcome.fingerprint
      conflict = null
      errorCode = null
      errorMessage = null
      // A save point: `Ctrl+Z` must not walk back past what is on disk. If the
      // author typed while the request was in flight, their burst keeps its own
      // history and saves again in a moment.
      if (sameFields(fields, saved)) {
        undoStack = []
        phase = 'saved'
      } else {
        phase = 'dirty'
        scheduleSave()
      }
    } else if (outcome.conflict === true) {
      phase = 'conflict'
      conflict = { current: outcome.current ?? null, changed: [...outcome.changed] }
    } else {
      phase = 'error'
      errorCode = outcome.code
      errorMessage = outcome.message ?? outcome.code
    }
    emit()
  }

  function undo(): boolean {
    const entry = undoStack.pop()
    if (entry === undefined) return false
    fields = { ...entry.fields }
    errorCode = null
    errorMessage = null
    if (phase !== 'conflict') phase = dirty() ? 'dirty' : 'idle'
    scheduleSave()
    emit()
    return true
  }

  async function discardAndReload(): Promise<void> {
    const loaded = await options.reload()
    if (loaded === null || disposed) return
    fields = { ...loaded.fields }
    saved = { ...loaded.fields }
    if (loaded.fingerprint !== undefined) fingerprint = loaded.fingerprint ?? null
    undoStack = []
    cancelTimer()
    conflict = null
    errorCode = null
    errorMessage = null
    phase = 'idle'
    emit()
  }

  return {
    getState: snapshot,
    subscribe(listener) {
      // Subscribing revives a disposed model: a UI framework that mounts →
      // unmounts → mounts the same component (React StrictMode, HMR) must not
      // end up with an editor that silently refuses to save.
      disposed = false
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setText(text) {
      if (disposed) return
      commit({ body: text }, true)
    },
    setTitle(title) {
      if (disposed) return
      commit({ title }, false)
    },
    setStatus(status) {
      if (disposed) return
      commit({ status }, false)
    },
    setAutosave(enabled) {
      if (disposed) return
      autosave = enabled
      if (enabled) scheduleSave()
      else cancelTimer()
      emit()
    },
    save(reason = 'manual') {
      return runSave(reason)
    },
    undo,
    discardAndReload,
    overwriteAndSave() {
      return runSave('overwrite')
    },
    dispose() {
      disposed = true
      cancelTimer()
      listeners.clear()
    },
  }
}
