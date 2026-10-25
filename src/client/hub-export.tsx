/**
 * The export card on the book hub (#195, ADR-0024 D4 / 入口归属, roadmap X-20).
 *
 * WHERE IT LIVES AND WHY: the setting says the export entry belongs on the 书库 side, next to
 * 设置, and that it must NOT become a permanent tab — an export is a one-off action, not a
 * workspace. So it is a card that opens over the book list (`hub.tsx` owns the open flag), the
 * same shape the new-book wizard already uses.
 *
 * WHAT IT KNOWS: nothing about EPUB or ZIP. It picks an axis, calls
 * `GET /hub/export/options` for the volumes, and `POST /hub/export` for the artifact — both
 * handled by the Host's `exportBook()`, which is the same function `inkflow_export` calls. Every
 * wording decision lives in `export-model.ts` so it can be asserted without a DOM.
 *
 * WHAT IT CANNOT DO: open a folder (the client half has no filesystem access — the card shows
 * the landing path instead) and overwrite a previous export (names are stamped).
 *
 * EVERY HOOK SITS ABOVE THE FIRST RETURN (`scripts/check-hooks-order.mjs`, AGENTS.md §8 #2b):
 * a hook after an early return is a hook missing on that render, and React's "Rendered fewer
 * hooks than expected" is the blank-panel bug that cost a whole afternoon in #174.
 */

import { useCallback, useEffect, useState } from 'react'

import { fetchInternal, writeInternal } from './internal.js'
import {
  EXPORT_FORMATS,
  EXPORT_FORMAT_LABELS,
  EXPORT_STATUSES,
  EXPORT_STATUS_LABELS,
  EXPORT_TARGETS,
  EXPORT_TARGET_LABELS,
  EXPORT_TEXTS,
  buildExportBody,
  readExportDone,
  readExportOptions,
} from './export-model.js'
import type {
  ExportDoneState,
  ExportDoneValue,
  ExportFormat,
  ExportOptionsState,
  ExportOptionsValue,
  ExportStatus,
  ExportTarget,
} from './export-model.js'
import type { HubBookRow } from './hub-model.js'
import { rowTitle } from './hub-model.js'

const cardStyle = {
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 8,
  padding: '10px 12px',
  background: 'var(--dsw-alias-bg-layer-1)',
  display: 'grid',
  gap: 8,
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

const fieldStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  fontSize: 12,
} as const

const selectStyle = {
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  borderRadius: 6,
  padding: '2px 6px',
  fontSize: 12,
} as const

const errorStyle = {
  ...cardStyle,
  borderColor: 'var(--dsw-alias-state-error-primary)',
  color: 'var(--dsw-alias-state-error-primary)',
} as const

const doneStyle = {
  ...cardStyle,
  borderColor: 'var(--dsw-alias-state-success-primary)',
  color: 'var(--dsw-alias-state-success-primary)',
} as const

/** The books this card may export: the gate's `usable` ones, named as `/hub/books` named them. */
function usableBookRows(books: HubBookRow[]): HubBookRow[] {
  return books.filter((row) => row.state === 'usable' && row.dirStatus !== 'missing-dir')
}

export function HubExportPanel({ books, onClose }: { books: HubBookRow[]; onClose: () => void }) {
  const choices = usableBookRows(books)
  const [book, setBook] = useState<string>(() => choices[0]?.path ?? '')
  const [format, setFormat] = useState<ExportFormat>('epub')
  const [target, setTarget] = useState<ExportTarget>('book')
  const [volumeId, setVolumeId] = useState('')
  const [status, setStatus] = useState<ExportStatus | ''>('')
  const [options, setOptions] = useState<ExportOptionsState>({ status: 'ready', volumes: [], exportsDir: null })
  const [outcome, setOutcome] = useState<ExportDoneState | null>(null)
  const [busy, setBusy] = useState(false)

  // The volumes of the chosen book. Re-read when the book changes: a volume list is per book,
  // and exporting from the previous book's list would be the quiet kind of wrong.
  useEffect(() => {
    if (book === '') {
      setOptions({ status: 'ready', volumes: [], exportsDir: null })
      return
    }
    let live = true
    void fetchInternal<ExportOptionsValue>(`/hub/export/options?book=${encodeURIComponent(book)}`, { sessionless: true }).then((result) => {
      if (!live) return
      setOptions(readExportOptions(result))
    })
    return () => {
      live = false
    }
  }, [book])

  /**
   * One axis change, and the unused axis is cleared (#50: the two are not combinable).
   * Clearing here is a convenience for the clicker; `buildExportBody` still sends whatever is
   * chosen, and the Host refuses a mixed request rather than guessing which axis was meant.
   */
  const pickTarget = useCallback((next: ExportTarget) => {
    setTarget(next)
    setOutcome(null)
    if (next !== 'volume') setVolumeId('')
    if (next !== 'status') setStatus('')
  }, [])

  const run = useCallback(async () => {
    const body = buildExportBody(book, { format, target, volumeId, status })
    if (body === null) return
    setBusy(true)
    setOutcome(null)
    try {
      const result = await writeInternal<ExportDoneValue>('/hub/export', body, { sessionless: true, timeoutMs: 60_000 })
      setOutcome(readExportDone(result))
    } finally {
      setBusy(false)
    }
  }, [book, format, target, volumeId, status])

  if (choices.length === 0) {
    return (
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontWeight: 600 }}>{EXPORT_TEXTS.title}</span>
          <span style={{ marginLeft: 'auto' }}>
            <button type="button" style={buttonStyle} onClick={onClose}>
              {EXPORT_TEXTS.close}
            </button>
          </span>
        </div>
        <div style={muted}>{EXPORT_TEXTS.noBook}</div>
      </div>
    )
  }

  const volumes = options.status === 'ready' ? options.volumes : []
  const exportsDir = options.status === 'ready' ? options.exportsDir : null

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>{EXPORT_TEXTS.title}</span>
        <span style={{ ...muted, fontSize: 12 }}>{EXPORT_TEXTS.hint}</span>
        <span style={{ marginLeft: 'auto' }}>
          <button type="button" style={buttonStyle} onClick={onClose}>
            {EXPORT_TEXTS.close}
          </button>
        </span>
      </div>

      <label style={fieldStyle}>
        <span>{EXPORT_TEXTS.book}</span>
        <select style={selectStyle} value={book} onChange={(event) => setBook(event.target.value)}>
          {choices.map((row) => (
            <option key={row.workspaceId ?? row.path ?? rowTitle(row)} value={row.path ?? ''}>
              {rowTitle(row)}
            </option>
          ))}
        </select>
      </label>

      <label style={fieldStyle}>
        <span>{EXPORT_TEXTS.format}</span>
        <select style={selectStyle} value={format} onChange={(event) => setFormat(event.target.value as ExportFormat)}>
          {EXPORT_FORMATS.map((value) => (
            <option key={value} value={value}>
              {EXPORT_FORMAT_LABELS[value]}
            </option>
          ))}
        </select>
      </label>

      <label style={fieldStyle}>
        <span>{EXPORT_TEXTS.target}</span>
        <select style={selectStyle} value={target} onChange={(event) => pickTarget(event.target.value as ExportTarget)}>
          {EXPORT_TARGETS.map((value) => (
            <option key={value} value={value}>
              {EXPORT_TARGET_LABELS[value]}
            </option>
          ))}
        </select>
      </label>

      {target === 'volume' ? (
        <label style={fieldStyle}>
          <span>{EXPORT_TEXTS.volume}</span>
          <select style={selectStyle} value={volumeId} onChange={(event) => setVolumeId(event.target.value)}>
            <option value="">（选择一卷）</option>
            {volumes.map((volume) => (
              <option key={volume.volumeId ?? ''} value={volume.volumeId ?? ''}>
                {`${volume.volumeId ?? ''} ${volume.title ?? ''}（${String(volume.chapters ?? 0)} 章）`}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {target === 'status' ? (
        <label style={fieldStyle}>
          <span>{EXPORT_TEXTS.status}</span>
          <select style={selectStyle} value={status} onChange={(event) => setStatus(event.target.value as ExportStatus | '')}>
            <option value="">（选择状态）</option>
            {EXPORT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {EXPORT_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
          <span style={muted}>{EXPORT_TEXTS.statusHint}</span>
        </label>
      ) : null}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button type="button" style={buttonStyle} onClick={() => void run()} disabled={busy}>
          {busy ? EXPORT_TEXTS.running : EXPORT_TEXTS.run}
        </button>
        {options.status === 'error' ? <span style={{ ...muted, fontSize: 12 }}>{options.message}</span> : null}
      </div>

      {outcome === null ? null : outcome.status === 'done' ? (
        <div style={doneStyle}>
          <div>{outcome.message}</div>
          <div style={{ ...muted, fontSize: 12 }}>{EXPORT_TEXTS.openDir}</div>
          {exportsDir === null ? null : (
            <div style={mono} title={exportsDir}>
              {exportsDir}
            </div>
          )}
        </div>
      ) : (
        <div style={errorStyle}>{outcome.message}</div>
      )}
    </div>
  )
}
