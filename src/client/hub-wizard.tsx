/**
 * The book hub's new-book wizard (ADR-0010 D4, issue #86): the UI half.
 *
 * THE FLOW IS THE ADR'S FLOW, minus the parts a browser cannot do:
 *
 *   pickDirectory → POST /hub/plan (read-only) → the confirm card
 *     → POST /hub/apply {planToken, confirm: true, title} → the "下一步" card
 *
 *   - The panel NEVER names a directory except as `candidate` on the plan call;
 *     `apply` carries a token and a confirmation, no path at all (ADR-0010 D3).
 *   - A directory outside every registered workspace needs a SECOND
 *     confirmation: the Host answers `ANCHOR_REQUIRED`, and only that explicit
 *     click sends `outsideRegistry: true` (ADR-0010 D6, anchor 3).
 *   - "导入已有书" is not a different code path: it is the same button, aimed at
 *     a directory that already holds a book — the plan then only lists what is
 *     missing, and nothing existing is overwritten.
 *   - After apply the panel does NOT navigate. A session cannot be created
 *     programmatically (ADR-0010 E3/E4), so degradation A says "在左侧工作区
 *     「<title>」点「新会话」" and shows the canonical path to verify
 *     (ADR-0010 D4).
 *
 * NO POLLING (ADR-0010 D8): every state change here is a user action.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { writeInternal } from './internal.js'
import {
  HUB_IMPORT_NOTE,
  HUB_WIZARD_LABEL,
  HUB_WIZARD_TEXTS,
  anchorConfirmation,
  defaultTitleFor,
  describeWillCreate,
  isAnchorRequired,
  planNeedsTitle,
  readHubApply,
  readHubPlan,
} from './hub-wizard-model.js'
import type { HubApplyValue, HubPlanValue } from './hub-wizard-model.js'

/** What a successful apply contributes to the book list (no refetch). */
export interface HubAppliedRow {
  path: string
  title: string
  state: string
}

// ---------------------------------------------------------------------------
// The directory picker (the Client's only "user picked this" capability)
// ---------------------------------------------------------------------------

export type DirectoryPick = { status: 'picked'; path: string } | { status: 'cancelled' } | { status: 'unavailable' }

/**
 * One shape for every answer `pickDirectory` might give.
 *
 * The Host-side capability is not documented beyond "returns the directory the
 * user chose" (E6), so a string, `{path}`, `{paths:[…]}` and the usual cancel
 * shapes are all accepted; anything else is `cancelled` rather than an error, so
 * the panel cannot get stuck on an unknown return shape.
 */
export function normalizePick(raw: unknown): DirectoryPick {
  if (raw === null || raw === undefined) return { status: 'cancelled' }
  if (typeof raw === 'string') return raw.trim() === '' ? { status: 'cancelled' } : { status: 'picked', path: raw.trim() }
  if (typeof raw === 'object') {
    const record = raw as Record<string, unknown>
    const direct = typeof record['path'] === 'string' ? record['path'].trim() : ''
    if (direct !== '') return { status: 'picked', path: direct }
    const list = record['paths']
    if (Array.isArray(list)) {
      const first = typeof list[0] === 'string' ? list[0].trim() : ''
      if (first !== '') return { status: 'picked', path: first }
    }
  }
  return { status: 'cancelled' }
}

/** A picker bound to one Client context; `unavailable` when the service is absent. */
export function createDirectoryPicker(get: (name: string) => unknown): () => Promise<DirectoryPick> {
  return async () => {
    const service = get('uiWorkspace')
    const record = typeof service === 'object' && service !== null ? (service as Record<string, unknown>) : undefined
    const pick = record === undefined ? undefined : record['pickDirectory']
    if (typeof pick !== 'function') return { status: 'unavailable' }
    try {
      return normalizePick(await (pick as () => unknown).call(service))
    } catch {
      // A picker that throws is a picker this panel cannot use; the manual
      // field below is the fallback, not a crash.
      return { status: 'unavailable' }
    }
  }
}

/** The installed picker, set once by `index.tsx` before the panel registers. */
let activePicker: (() => Promise<DirectoryPick>) | null = null

export function setHubDirectoryPicker(picker: (() => Promise<DirectoryPick>) | null): void {
  activePicker = picker
}

async function pickDirectory(): Promise<DirectoryPick> {
  return activePicker === null ? { status: 'unavailable' } : activePicker()
}

// ---------------------------------------------------------------------------
// Styles: theme tokens only (AGENTS.md §6 — no colour literals, icons aside)
// ---------------------------------------------------------------------------

const cardStyle = {
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 8,
  padding: '10px 12px',
  background: 'var(--dsw-alias-bg-layer-1)',
  display: 'grid',
  gap: 6,
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

const primaryButtonStyle = {
  ...buttonStyle,
  borderColor: 'var(--dsw-alias-state-success-primary)',
  color: 'var(--dsw-alias-state-success-primary)',
} as const

/** A warning-toned button: the second confirmation is not the easy default. */
const warnButtonStyle = {
  ...buttonStyle,
  borderColor: 'var(--dsw-alias-state-warn-primary)',
  color: 'var(--dsw-alias-state-warn-primary)',
} as const

const inputStyle = {
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-primary)',
  borderRadius: 6,
  padding: '3px 8px',
  fontSize: 12,
  width: '100%',
  boxSizing: 'border-box',
} as const

const muted = { color: 'var(--dsw-alias-label-secondary)' } as const
const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 } as const
const warn = { color: 'var(--dsw-alias-state-warn-primary)' } as const
const errorText = { color: 'var(--dsw-alias-state-error-primary)' } as const
const okText = { color: 'var(--dsw-alias-state-success-primary)' } as const

// ---------------------------------------------------------------------------
// The phases, as data: one `phase` at a time, no timers, no effects
// ---------------------------------------------------------------------------

type Phase =
  | { kind: 'idle' }
  | { kind: 'picking' }
  | { kind: 'manual' }
  | { kind: 'planning'; path: string }
  | { kind: 'anchor'; path: string }
  | { kind: 'confirm'; path: string; token: string; plan: HubPlanValue; title: string }
  | { kind: 'applying'; path: string }
  | { kind: 'done'; path: string; title: string; message: string; registered: boolean; hint: string }
  | { kind: 'blocked'; message: string; hint: string }
  | { kind: 'failed'; message: string }

/** A plan request: `outsideRegistry` is only ever true after the second click. */
async function requestPlan(candidate: string, outsideRegistry: boolean) {
  return writeInternal<HubPlanValue>('/hub/plan', {
    candidate,
    ...(outsideRegistry ? { outsideRegistry: true } : {}),
  }, { sessionless: true })
}

export function HubWizard({ onApplied, onClose }: { onApplied: (row: HubAppliedRow) => void; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [manualPath, setManualPath] = useState('')
  /** One pick per open: a StrictMode double-mount must not open two dialogs. */
  const started = useRef(false)

  const plan = useCallback(async (candidate: string, outsideRegistry: boolean) => {
    setPhase({ kind: 'planning', path: candidate })
    const result = await requestPlan(candidate, outsideRegistry)
    if (isAnchorRequired(result)) {
      setPhase({ kind: 'anchor', path: anchorConfirmation(result).path || candidate })
      return
    }
    const outcome = readHubPlan(result)
    if (outcome.status === 'ready') {
      setPhase({
        kind: 'confirm',
        path: outcome.path,
        token: outcome.token,
        plan: outcome.plan,
        title: defaultTitleFor(outcome.path),
      })
      return
    }
    if (outcome.status === 'blocked') {
      setPhase({ kind: 'blocked', message: outcome.message, hint: outcome.hint })
      return
    }
    setPhase({ kind: 'failed', message: outcome.message })
  }, [])

  const choose = useCallback(async () => {
    setPhase({ kind: 'picking' })
    const picked = await pickDirectory()
    if (picked.status === 'unavailable') {
      setPhase({ kind: 'manual' })
      return
    }
    if (picked.status === 'cancelled') {
      setPhase({ kind: 'idle' })
      return
    }
    await plan(picked.path, false)
  }, [plan])

  // Opening the wizard is the user's "I want a new book" click, so the picker
  // starts right away instead of asking for a second click on "选择目录".
  useEffect(() => {
    if (started.current) return
    started.current = true
    void choose()
  }, [choose])

  const apply = useCallback(
    async (path: string, token: string, title: string) => {
      setPhase({ kind: 'applying', path })
      const result = await writeInternal<HubApplyValue>(
        '/hub/apply',
        { planToken: token, confirm: true, ...(title.trim() === '' ? {} : { title: title.trim() }) },
        { sessionless: true },
      )
      const outcome = readHubApply(result, title)
      if (outcome.status === 'refused') {
        setPhase({ kind: 'failed', message: outcome.message })
        return
      }
      onApplied({ path: outcome.path, title: outcome.title, state: outcome.state })
      setPhase({
        kind: 'done',
        path: outcome.path,
        title: outcome.title,
        message: outcome.message,
        registered: outcome.registered,
        hint: outcome.hint,
      })
    },
    [onApplied],
  )

  const reset = useCallback(() => {
    setManualPath('')
    setPhase({ kind: 'idle' })
  }, [])

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <button
          type="button"
          style={primaryButtonStyle}
          onClick={() => void choose()}
          disabled={phase.kind === 'picking' || phase.kind === 'planning' || phase.kind === 'applying'}
        >
          {HUB_WIZARD_TEXTS.gatherPicker}
        </button>
        <span style={{ ...muted, fontSize: 12 }}>{HUB_IMPORT_NOTE}</span>
        <button type="button" style={{ ...buttonStyle, marginLeft: 'auto' }} onClick={onClose}>
          {HUB_WIZARD_TEXTS.close}
        </button>
      </div>

      {phase.kind === 'picking' ? <div style={{ ...muted, fontSize: 12 }}>{HUB_WIZARD_TEXTS.gatherPicker}</div> : null}

      {phase.kind === 'planning' ? (
        <div style={{ ...muted, fontSize: 12 }}>
          {HUB_WIZARD_TEXTS.planning} <span style={mono}>{phase.path}</span>
        </div>
      ) : null}

      {phase.kind === 'manual' ? (
        <div style={cardStyle}>
          <div style={{ ...muted, fontSize: 12 }}>{HUB_WIZARD_TEXTS.manualPathLabel}</div>
          <input
            style={inputStyle}
            value={manualPath}
            placeholder="D:\\小说\\新书"
            onChange={(event) => setManualPath(event.target.value)}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={manualPath.trim() === ''}
              onClick={() => void plan(manualPath.trim(), false)}
            >
              {HUB_WIZARD_TEXTS.manualPathGo}
            </button>
            <button type="button" style={buttonStyle} onClick={reset}>
              {HUB_WIZARD_TEXTS.cancel}
            </button>
          </div>
        </div>
      ) : null}

      {phase.kind === 'anchor' ? (
        <div style={cardStyle}>
          <div style={{ ...warn, fontWeight: 600 }}>{HUB_WIZARD_TEXTS.anchorTitle}</div>
          <div style={{ ...mono }}>{phase.path}</div>
          <div>{HUB_WIZARD_TEXTS.anchorBody}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" style={warnButtonStyle} onClick={() => void plan(phase.path, true)}>
              {HUB_WIZARD_TEXTS.anchorContinue}
            </button>
            <button type="button" style={buttonStyle} onClick={reset}>
              {HUB_WIZARD_TEXTS.cancel}
            </button>
          </div>
        </div>
      ) : null}

      {phase.kind === 'confirm' ? (
        <div style={cardStyle}>
          <div style={{ fontWeight: 600 }}>{HUB_WIZARD_TEXTS.pathLabel}</div>
          <div style={mono}>{phase.path}</div>
          {planNeedsTitle(phase.plan) ? (
            <div style={{ display: 'grid', gap: 2 }}>
              <span style={{ fontWeight: 600 }}>{HUB_WIZARD_TEXTS.titleLabel}</span>
              <input
                style={inputStyle}
                value={phase.title}
                onChange={(event) => setPhase({ ...phase, title: event.target.value })}
              />
              <span style={{ ...muted, fontSize: 12 }}>{HUB_WIZARD_TEXTS.titleHint}</span>
            </div>
          ) : null}
          <div style={{ fontWeight: 600 }}>{HUB_WIZARD_TEXTS.willCreateLabel}</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {describeWillCreate(phase.plan).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {(phase.plan.notices ?? []).length === 0 ? null : (
            <div style={{ display: 'grid', gap: 2 }}>
              <span style={{ fontWeight: 600 }}>{HUB_WIZARD_TEXTS.noticesLabel}</span>
              {(phase.plan.notices ?? []).map((notice) => (
                <span key={notice} style={{ ...warn, fontSize: 12 }}>
                  {notice}
                </span>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={planNeedsTitle(phase.plan) && phase.title.trim() === ''}
              onClick={() => void apply(phase.path, phase.token, phase.title)}
            >
              {HUB_WIZARD_TEXTS.confirm}
            </button>
            <button type="button" style={buttonStyle} onClick={reset}>
              {HUB_WIZARD_TEXTS.cancel}
            </button>
          </div>
        </div>
      ) : null}

      {phase.kind === 'applying' ? (
        <div style={{ ...muted, fontSize: 12 }}>
          {HUB_WIZARD_TEXTS.applying} <span style={mono}>{phase.path}</span>
        </div>
      ) : null}

      {phase.kind === 'done' ? (
        <div style={{ ...cardStyle, borderColor: 'var(--dsw-alias-state-success-primary)' }}>
          <div style={{ ...okText, fontWeight: 600 }}>{HUB_WIZARD_TEXTS.doneTitle}</div>
          <div>{phase.message}</div>
          <div style={mono}>{phase.path}</div>
          {phase.registered ? null : <div style={{ ...warn, fontSize: 12 }}>{phase.hint}</div>}
          <div>
            <button type="button" style={buttonStyle} onClick={reset}>
              {HUB_WIZARD_TEXTS.another}
            </button>
          </div>
        </div>
      ) : null}

      {phase.kind === 'blocked' ? (
        <div style={cardStyle}>
          <div style={{ ...warn, fontWeight: 600 }}>{phase.message}</div>
          {phase.hint === '' ? null : <div style={{ ...muted, fontSize: 12 }}>{phase.hint}</div>}
          <div>
            <button type="button" style={buttonStyle} onClick={reset}>
              {HUB_WIZARD_TEXTS.cancel}
            </button>
          </div>
        </div>
      ) : null}

      {phase.kind === 'failed' ? (
        <div style={{ ...cardStyle, borderColor: 'var(--dsw-alias-state-error-primary)' }}>
          <div style={errorText}>{phase.message}</div>
          <div>
            <button type="button" style={buttonStyle} onClick={reset}>
              {HUB_WIZARD_TEXTS.retry}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
