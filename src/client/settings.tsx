/**
 * The settings page of the book hub (#42, ADR-0018): 设置 / 诊断包 / 备份, one body area.
 *
 * WHERE IT RIDES: the hub's `main` panel (root scope), as a mode of `hub.tsx` — the
 * same choice `hub-shared.tsx` made, because a root-scoped panel has exactly one body
 * area (roadmap X-20 puts settings in the 书库, not in a session tab).
 *
 * THE RULE THAT SHAPES EVERY WRITE HERE: **read first, confirm second.** The page
 * never writes on a single click: pressing a button arms a confirm card that names
 * what would change (the field labels, the entry count, the restore plan), and the
 * confirm card is what sends the request with `confirm: true`. The Host refuses
 * without that flag too — the browser is a convenience, not the guard.
 *
 * WHY A RESTORE HAS TWO STEPS. A package may be days old while the book moved on, so
 * 「恢复」 first asks the Host to COMPARE (`GET /hub/backups/plan`), shows what would be
 * overwritten, and only then writes — handing the plan's per-file digests back as
 * `expected`. A file edited between the two steps is a conflict the Host reports and
 * does not overwrite (ADR-0018 D6).
 *
 * Every colour comes from a `--dsw-alias-*` token (AGENTS.md §6); no literal colour
 * appears in this file, which the bundle test asserts.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { fetchInternal, writeInternal } from './internal.js'
import {
  SETTINGS_FIELD_LABELS,
  SETTINGS_TEXTS,
  anchorOf,
  backupSummary,
  defaultBook,
  describeDraftChanges,
  describePlan,
  describeRestore,
  describeSemantic,
  describeSemanticEstimate,
  describeSemanticRun,
  describeSettings,
  formFromSettings,
  formatBytes,
  formatStamp,
  loadableFrom,
  mergeRestoreExpected,
  patchFromForm,
} from './settings-model.js'
import type {
  BookChoice,
  DiagnosticsValue,
  HubBackupsValue,
  HubSettingsValue,
  Loadable,
  RestoreDoneValue,
  RestorePlanValue,
  SemanticRunValue,
  SemanticSectionValue,
  SettingsDraft,
} from './settings-model.js'

// ---------------------------------------------------------------------------
// Tokens only: the same vocabulary `hub.tsx` and `hub-shared.tsx` use
// ---------------------------------------------------------------------------

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
  gap: 6,
} as const

const confirmStyle = {
  ...cardStyle,
  borderColor: 'var(--dsw-alias-state-warning-primary)',
} as const

const fieldStyle = {
  display: 'grid',
  gap: 3,
} as const

const inputStyle = {
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-primary)',
  padding: '3px 8px',
  fontSize: 12,
  width: '100%',
  boxSizing: 'border-box',
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

const primaryButtonStyle = {
  ...buttonStyle,
  borderColor: 'var(--dsw-alias-brand-primary)',
  color: 'var(--dsw-alias-brand-primary)',
} as const

/** What the user armed but has not confirmed yet. */
type Pending =
  | { kind: 'settings'; label: string; patch: Record<string, unknown> }
  | { kind: 'diagnostics'; label: string }
  | { kind: 'backup'; label: string; anchor: string }
  | { kind: 'restore'; label: string; anchor: string; file: string; expected: Record<string, string | null> }
  | { kind: 'semanticRebuild'; label: string; anchor: string }
  | { kind: 'semanticPurge'; label: string; anchor: string; count: number }

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={fieldStyle}>
      <span style={{ ...muted, fontSize: 12 }}>{label}</span>
      {children}
    </label>
  )
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>{title}</span>
      </div>
      <div style={{ ...muted, fontSize: 12 }}>{hint}</div>
      {children}
    </section>
  )
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div style={{ ...cardStyle, borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' }}>
      {message}
    </div>
  )
}

export function SettingsView({ onClose }: { onClose: () => void }) {
  const [settings, setSettings] = useState<Loadable<HubSettingsValue>>({ status: 'loading' })
  const [draft, setDraft] = useState<SettingsDraft | null>(null)
  const [diagnostics, setDiagnostics] = useState<Loadable<DiagnosticsValue>>({ status: 'loading' })
  const [bookAnchor, setBookAnchor] = useState<string>('')
  const [backups, setBackups] = useState<Loadable<HubBackupsValue>>({ status: 'loading' })
  const [plan, setPlan] = useState<RestorePlanValue | null>(null)
  const [done, setDone] = useState<string[] | null>(null)
  // The semantic section (#41): status + the estimate the rebuild button shows. Loaded for the
  // same book the backup section names, so the page has one book in focus.
  const [semantic, setSemantic] = useState<Loadable<SemanticSectionValue>>({ status: 'loading' })
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  const books: BookChoice[] = useMemo(
    () => (settings.status === 'ready' ? settings.value.books : []),
    [settings],
  )

  useEffect(() => {
    let live = true
    setSettings({ status: 'loading' })
    void fetchInternal<HubSettingsValue>('/hub/settings', { sessionless: true }).then((result) => {
      if (!live) return
      const loaded = loadableFrom(result)
      setSettings(loaded)
      if (loaded.status === 'ready') {
        setDraft(formFromSettings(loaded.value.settings))
        if (bookAnchor === '') {
          const first = defaultBook(loaded.value.books)
          setBookAnchor(anchorOf(first) ?? '')
        }
      }
    })
    return () => {
      live = false
    }
    // `bookAnchor` is read only to pick a first book; re-running on it would refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  useEffect(() => {
    let live = true
    setDiagnostics({ status: 'loading' })
    const suffix = bookAnchor === '' ? '' : `?book=${encodeURIComponent(bookAnchor)}`
    void fetchInternal<DiagnosticsValue>(`/hub/diagnostics${suffix}`, { sessionless: true }).then((result) => {
      if (live) setDiagnostics(loadableFrom(result))
    })
    return () => {
      live = false
    }
  }, [bookAnchor, revision])

  useEffect(() => {
    if (bookAnchor === '') {
      setBackups({ status: 'ready', value: { book: { workspaceId: null, bookSlug: '', title: '' }, keep: 0, backups: [] } })
      return
    }
    let live = true
    setBackups({ status: 'loading' })
    void fetchInternal<HubBackupsValue>(`/hub/backups?book=${encodeURIComponent(bookAnchor)}`, { sessionless: true }).then((result) => {
      if (live) setBackups(loadableFrom(result))
    })
    return () => {
      live = false
    }
  }, [bookAnchor, revision])

  useEffect(() => {
    if (bookAnchor === '') {
      setSemantic({ status: 'error', message: '还没有登记的书；先在书库里打开一本书。' })
      return
    }
    let live = true
    setSemantic({ status: 'loading' })
    void fetchInternal<SemanticSectionValue>(`/hub/semantic?book=${encodeURIComponent(bookAnchor)}`, { sessionless: true }).then((result) => {
      if (live) setSemantic(loadableFrom(result))
    })
    return () => {
      live = false
    }
  }, [bookAnchor, revision])

  const refresh = useCallback(() => {
    setPlan(null)
    setPending(null)
    setRevision((current) => current + 1)
  }, [])

  /** Send the armed action. The server refuses without `confirm: true` as well. */
  const commit = useCallback(async () => {
    if (pending === null || busy) return
    setBusy(true)
    setError(null)
    try {
      if (pending.kind === 'settings') {
        const result = await writeInternal<{ settings: HubSettingsValue['settings'] }>('/hub/settings/update', {
          ...pending.patch,
          confirm: true,
        }, { sessionless: true })
        if (!result.ok) {
          setError(`${result.error?.code ?? 'failed'} — ${result.error?.message ?? ''}`)
          return
        }
        if (result.value !== undefined) setDraft(formFromSettings(result.value.settings))
        setPending(null)
        setRevision((current) => current + 1)
        return
      }
      if (pending.kind === 'diagnostics') {
        const result = await writeInternal<DiagnosticsValue>('/hub/diagnostics/export', {
          ...(bookAnchor === '' ? {} : { book: bookAnchor }),
          confirm: true,
        }, { sessionless: true })
        if (!result.ok) {
          setError(`${result.error?.code ?? 'failed'} — ${result.error?.message ?? ''}`)
          return
        }
        setPending(null)
        if (result.value !== undefined) setDone([`诊断包已导出：${result.value.path}`, ...result.value.summary])
        return
      }
      if (pending.kind === 'backup') {
        const result = await writeInternal<{ backups: HubBackupsValue['backups']; file: string }>('/hub/backups/create', {
          book: pending.anchor,
          confirm: true,
        }, { sessionless: true })
        if (!result.ok) {
          setError(`${result.error?.code ?? 'failed'} — ${result.error?.message ?? ''}`)
          return
        }
        setPending(null)
        setRevision((current) => current + 1)
        return
      }
      if (pending.kind === 'semanticRebuild') {
        const result = await writeInternal<SemanticRunValue>('/hub/semantic/rebuild', {
          book: pending.anchor,
          confirm: true,
        }, { sessionless: true })
        setPending(null)
        if (!result.ok) {
          setError(`${result.error?.code ?? 'failed'} — ${result.error?.message ?? ''}`)
          setRevision((current) => current + 1)
          return
        }
        if (result.value !== undefined) setDone(describeSemanticRun(result.value))
        setRevision((current) => current + 1)
        return
      }
      if (pending.kind === 'semanticPurge') {
        const result = await writeInternal<SemanticRunValue>('/hub/semantic/purge', {
          book: pending.anchor,
          confirm: true,
        }, { sessionless: true })
        setPending(null)
        if (!result.ok) {
          setError(`${result.error?.code ?? 'failed'} — ${result.error?.message ?? ''}`)
          setRevision((current) => current + 1)
          return
        }
        if (result.value !== undefined) setDone(describeSemanticRun(result.value))
        setRevision((current) => current + 1)
        return
      }
      const result = await writeInternal<RestoreDoneValue>('/hub/backups/restore', {
        book: pending.anchor,
        file: pending.file,
        expected: pending.expected,
        confirm: true,
      }, { sessionless: true })
      setPending(null)
      if (!result.ok) {
        // A conflict is a partial restore: the Host restored what it could and named
        // what it skipped, so the page reports it instead of clearing the section.
        setError(`${result.error?.code ?? 'failed'} — ${result.error?.message ?? ''}`)
        setRevision((current) => current + 1)
        return
      }
      setPlan(null)
      setRevision((current) => current + 1)
      if (result.value !== undefined) setDone(describeRestore(result.value))
    } finally {
      setBusy(false)
    }
  }, [pending, busy, bookAnchor])

  /** Compare before writing: the preview the restore's confirm card is built from. */
  const previewRestore = useCallback(
    async (file: string) => {
      setError(null)
      setDone(null)
      const result = await fetchInternal<RestorePlanValue>(
        `/hub/backups/plan?book=${encodeURIComponent(bookAnchor)}&file=${encodeURIComponent(file)}`,
        { sessionless: true },
      )
      if (!result.ok || result.value === undefined) {
        setError(`${result.error?.code ?? 'failed'} — ${result.error?.message ?? ''}`)
        return
      }
      setPlan(result.value)
      setPending({
        kind: 'restore',
        label: result.value.plan.file,
        anchor: bookAnchor,
        file: result.value.plan.file,
        expected: mergeRestoreExpected(result.value.plan.entries),
      })
    },
    [bookAnchor],
  )

  return (
    <div style={sheetStyle}>
      <div style={headerStyle}>
        <span style={{ fontWeight: 600 }}>{SETTINGS_TEXTS.title}</span>
        <span style={{ ...muted, fontSize: 12 }}>{SETTINGS_TEXTS.settingsHint}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button type="button" style={buttonStyle} onClick={onClose}>
            {SETTINGS_TEXTS.back}
          </button>
          <button type="button" style={buttonStyle} onClick={refresh} disabled={busy}>
            {SETTINGS_TEXTS.refresh}
          </button>
        </span>
      </div>

      {error === null ? null : <ErrorCard message={error} />}

      {/* -------- 设置 -------- */}
      <Section title={SETTINGS_TEXTS.settingsTitle} hint={SETTINGS_TEXTS.settingsHint}>
        {settings.status === 'loading' ? <div style={muted}>{SETTINGS_TEXTS.loading}</div> : null}
        {settings.status === 'error' ? <ErrorCard message={settings.message} /> : null}
        {settings.status === 'ready' && draft !== null ? (
          <>
            <div style={{ ...mono }} title={settings.value.dataDir}>
              {settings.value.dataDir}/settings.json · 来源：{settings.value.source === 'file' ? '文件' : '默认值'}
            </div>
            {settings.value.warn === null ? null : (
              <div style={{ ...muted, fontSize: 12 }}>告警 {settings.value.warn.code}：{settings.value.warn.message}</div>
            )}
            <Field label={SETTINGS_FIELD_LABELS['sharedRoot'] ?? 'sharedRoot'}>
              <input
                style={inputStyle}
                value={draft.sharedRoot}
                onChange={(event) => setDraft({ ...draft, sharedRoot: event.target.value })}
              />
            </Field>
            <Field label={SETTINGS_FIELD_LABELS['autosaveIntervalMs'] ?? 'autosaveIntervalMs'}>
              <input
                style={inputStyle}
                value={draft.autosaveIntervalMs}
                onChange={(event) => setDraft({ ...draft, autosaveIntervalMs: event.target.value })}
              />
            </Field>
            <Field label={SETTINGS_FIELD_LABELS['authorName'] ?? 'authorName'}>
              <input
                style={inputStyle}
                value={draft.authorName}
                onChange={(event) => setDraft({ ...draft, authorName: event.target.value })}
              />
            </Field>
            <Field label={`${SETTINGS_FIELD_LABELS['excludeDirs'] ?? 'excludeDirs'}（逗号分隔，相对书根）`}>
              <input
                style={inputStyle}
                value={draft.excludeDirs}
                onChange={(event) => setDraft({ ...draft, excludeDirs: event.target.value })}
              />
            </Field>
            <Field
              label={`${SETTINGS_FIELD_LABELS['backupKeep'] ?? 'backupKeep'}（${String(settings.value.limits.backupKeep.min)}–${String(settings.value.limits.backupKeep.max)}）`}
            >
              <input
                style={inputStyle}
                value={draft.backupKeep}
                onChange={(event) => setDraft({ ...draft, backupKeep: event.target.value })}
              />
            </Field>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={draft.semanticSearch}
                onChange={(event) => setDraft({ ...draft, semanticSearch: event.target.checked })}
              />
              {SETTINGS_FIELD_LABELS['semanticSearch'] ?? 'semanticSearch'}（有语义后端时才生效）
            </label>
            <Field label={`${SETTINGS_FIELD_LABELS['semanticEndpoint'] ?? 'semanticEndpoint'}（http://主机:端口，留空=只用关键词检索）`}>
              <input
                style={inputStyle}
                value={draft.semanticEndpoint}
                placeholder="http://127.0.0.1:1933"
                onChange={(event) => setDraft({ ...draft, semanticEndpoint: event.target.value })}
              />
            </Field>
            <Field
              label={`${SETTINGS_FIELD_LABELS['semanticApiKey'] ?? 'semanticApiKey'}（${settings.value.settings.semanticApiKeySet === true ? '已设置，留空=不改' : '未设置，可选'}）`}
            >
              <input
                style={inputStyle}
                type="password"
                value={draft.semanticApiKey}
                onChange={(event) => setDraft({ ...draft, semanticApiKey: event.target.value })}
              />
            </Field>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button
                type="button"
                style={primaryButtonStyle}
                disabled={busy}
                onClick={() => {
                  const changes = describeDraftChanges(draft, settings.value.settings)
                  setPending({
                    kind: 'settings',
                    label: changes.length === 0 ? '没有字段变化' : `将改动：${changes.join('、')}`,
                    patch: patchFromForm(draft),
                  })
                }}
              >
                {SETTINGS_TEXTS.save}
              </button>
              <span style={{ ...muted, fontSize: 12 }}>{describeSettings(settings.value.settings).join(' · ')}</span>
            </div>
          </>
        ) : null}
      </Section>

      {/* -------- 语义检索（#41） -------- */}
      <Section
        title="语义检索"
        hint="可选能力：需要你自己起一个 OpenViking 并在这里填端点。没配或连不上时，检索自动用关键词（不会报错）；删章不会物理删除语义条目，只有「清理占位」才会。"
      >
        {semantic.status === 'loading' ? <div style={muted}>{SETTINGS_TEXTS.loading}</div> : null}
        {semantic.status === 'error' ? <div style={{ ...muted, fontSize: 12 }}>{semantic.message}</div> : null}
        {semantic.status === 'ready' ? (
          <>
            {describeSemantic(semantic.value).map((line) => (
              <div key={line} style={{ ...muted, fontSize: 12 }}>
                {line}
              </div>
            ))}
            <div style={{ ...muted, fontSize: 12 }}>{describeSemanticEstimate(semantic.value.estimate, semantic.value.status.thresholds)}</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                style={primaryButtonStyle}
                disabled={busy}
                onClick={() =>
                  setPending({
                    kind: 'semanticRebuild',
                    label: `${semantic.value.book.title}：${describeSemanticEstimate(semantic.value.estimate, semantic.value.status.thresholds)}`,
                    anchor: bookAnchor,
                  })
                }
              >
                重建语义索引
              </button>
              <button
                type="button"
                style={buttonStyle}
                disabled={busy || semantic.value.status.ledger.tombstones === 0}
                onClick={() =>
                  setPending({
                    kind: 'semanticPurge',
                    label: `清理 ${semantic.value.book.title} 已删除章的 ${String(semantic.value.status.ledger.tombstones)} 章占位条目（不可恢复）`,
                    anchor: bookAnchor,
                    count: semantic.value.status.ledger.tombstones,
                  })
                }
              >
                清理占位条目
              </button>
            </div>
          </>
        ) : null}
      </Section>

      {/* -------- 诊断包 -------- */}
      <Section title={SETTINGS_TEXTS.diagnosticsTitle} hint={SETTINGS_TEXTS.diagnosticsHint}>
        {diagnostics.status === 'loading' ? <div style={muted}>{SETTINGS_TEXTS.loading}</div> : null}
        {diagnostics.status === 'error' ? <ErrorCard message={diagnostics.message} /> : null}
        {diagnostics.status === 'ready' ? (
          <>
            <div style={{ ...mono }}>{diagnostics.value.path}（{formatBytes(diagnostics.value.bytes)}）</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {diagnostics.value.summary.map((line) => (
                <li key={line} style={{ ...muted, fontSize: 12 }}>
                  {line}
                </li>
              ))}
            </ul>
            <div>
              <button
                type="button"
                style={primaryButtonStyle}
                disabled={busy}
                onClick={() => setPending({ kind: 'diagnostics', label: diagnostics.value.path })}
              >
                {SETTINGS_TEXTS.exportNow}
              </button>
            </div>
          </>
        ) : null}
      </Section>

      {/* -------- 备份 -------- */}
      <Section title={SETTINGS_TEXTS.backupsTitle} hint={SETTINGS_TEXTS.backupsHint}>
        {books.length === 0 ? (
          <div style={muted}>还没有登记的书；先在书库里打开一本书。</div>
        ) : (
          <Field label={SETTINGS_TEXTS.backupsBook}>
            <select
              style={inputStyle}
              value={bookAnchor}
              onChange={(event) => {
                setPlan(null)
                setPending(null)
                setBookAnchor(event.target.value)
              }}
            >
              {books.map((book) => (
                <option key={book.workspaceId ?? book.bookSlug} value={anchorOf(book) ?? ''}>
                  {book.title}
                </option>
              ))}
            </select>
          </Field>
        )}
        {backups.status === 'loading' ? <div style={muted}>{SETTINGS_TEXTS.loading}</div> : null}
        {backups.status === 'error' ? <ErrorCard message={backups.message} /> : null}
        {backups.status === 'ready' && bookAnchor !== '' ? (
          <>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                style={primaryButtonStyle}
                disabled={busy}
                onClick={() => setPending({ kind: 'backup', label: backups.value.book.title, anchor: bookAnchor })}
              >
                {SETTINGS_TEXTS.backupNow}
              </button>
              <span style={{ ...muted, fontSize: 12 }}>{backupSummary(backups.value)}</span>
            </div>
            {backups.value.backups.length === 0 ? <div style={muted}>{SETTINGS_TEXTS.noBackups}</div> : null}
            {backups.value.backups.map((pack) => (
              <div
                key={pack.file}
                style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 4 }}
              >
                <span style={mono}>{formatStamp(pack.stamp)}</span>
                <span style={{ ...muted, fontSize: 12 }}>
                  {String(pack.entries)} 个文件 · {formatBytes(pack.bytes)}
                </span>
                <span style={{ marginLeft: 'auto' }}>
                  <button type="button" style={buttonStyle} disabled={busy} onClick={() => void previewRestore(pack.file)}>
                    {SETTINGS_TEXTS.restore}
                  </button>
                </span>
              </div>
            ))}
          </>
        ) : null}
      </Section>

      {done === null ? null : (
        <Section title="结果" hint="下面这条来自 Host 的回复。">
          {done.map((line) => (
            <div key={line} style={{ ...muted, fontSize: 12 }}>
              {line}
            </div>
          ))}
        </Section>
      )}

      {pending === null ? null : (
        <div style={confirmStyle}>
          <div style={{ fontWeight: 600 }}>
            {pending.kind === 'settings'
              ? SETTINGS_TEXTS.confirmSave
              : pending.kind === 'diagnostics'
                ? SETTINGS_TEXTS.confirmExport
                : pending.kind === 'backup'
                  ? SETTINGS_TEXTS.confirmBackup
                  : pending.kind === 'semanticRebuild'
                    ? '确认重建语义索引（每块会产生一次模型摘要调用）'
                    : pending.kind === 'semanticPurge'
                      ? '确认清理占位条目（物理删除，不可恢复）'
                      : SETTINGS_TEXTS.confirmRestore}
          </div>
          <div style={mono}>{pending.label}</div>
          {pending.kind === 'restore' && plan !== null ? (
            <div>
              {describePlan(plan).map((line) => (
                <div key={line} style={{ ...muted, fontSize: 12 }}>
                  {line}
                </div>
              ))}
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" style={primaryButtonStyle} disabled={busy} onClick={() => void commit()}>
              {busy ? SETTINGS_TEXTS.saving : '确认'}
            </button>
            <button type="button" style={buttonStyle} disabled={busy} onClick={() => setPending(null)}>
              {SETTINGS_TEXTS.cancel}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
