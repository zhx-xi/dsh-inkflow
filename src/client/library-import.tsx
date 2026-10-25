/**
 * The import dialog (roadmap X-17 / X-20): 选择文件 → 预览 → 确认.
 *
 * WHERE IT LIVES: inside the setting library's 资料 group, not in a tab of its own
 * (X-20 reserves new tabs for the candidates queue). The library tab is where an author looks
 * for reference material, and importing an old draft is how material gets there.
 *
 * WHAT IT DOES NOT DO: it never touches the filesystem and never guesses a path. The
 * Client half has no file API, so the author types the path, the Host reads it, and the
 * dialog shows what the Host decided (encoding tier, line endings, chapters). Every
 * decision about *what* the payload means is a pure function in
 * `library-import-model.ts`; this file is layout and the two requests.
 *
 * THE THREE STEPS ARE THE SAFETY PROPERTY: the preview request is read-only on the Host
 * side, so closing the dialog after step 2 is zero writes by construction — and step 3
 * sends the `planToken` the preview returned, so the write cannot land on a different set
 * of chapters than the one the author just read.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { fetchInternal, writeInternal } from './internal.js'
import type { InternalResult } from './internal.js'
import {
  IMPORT_PREVIEW_ROWS,
  canApply,
  describeImportDraft,
  describeImportError,
  describeImportLibrary,
  describeImportResult,
  describeImportSource,
  describeImportTarget,
  describeImportWarnings,
  emptyDraft,
  hiddenChapterCount,
  importChapterRows,
  importRequestBody,
  importSplitNotice,
  importVolumeOptions,
  stepAfterPlan,
} from './library-import-model.js'
import type { ImportApplyValue, ImportDraft, ImportPlanValue, ImportStep } from './library-import-model.js'
import type { ChaptersValue } from './panel-model.js'

// The panel's own small style set, redeclared rather than imported: `library.tsx`
// imports this module, so importing its helpers back would be a runtime cycle (the same
// reason `library-editor.tsx` keeps its own). Colours are host theme tokens only.
const cardStyle = {
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  padding: '12px 14px',
  background: 'var(--dsw-alias-bg-layer-1)',
  display: 'grid',
  gap: 10,
} as const

const muted = { color: 'var(--dsw-alias-label-secondary)' } as const
const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 } as const

const buttonStyle = {
  padding: '3px 12px',
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

const inputStyle = {
  ...mono,
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
  width: '100%',
  boxSizing: 'border-box',
} as const

/** The step strip: three labels, the current one highlighted. Positions, not a wizard. */
const STEPS: ReadonlyArray<{ step: ImportStep; label: string }> = [
  { step: 'pick', label: '① 选择文件' },
  { step: 'preview', label: '② 预览' },
  { step: 'done', label: '③ 完成' },
]

function stepIndex(step: ImportStep): number {
  return STEPS.findIndex((entry) => entry.step === step)
}

function parsePlan(result: InternalResult<ImportPlanValue>): { plan: ImportPlanValue | null; error: string | null } {
  if (!result.ok) return { plan: null, error: describeImportError(result.error) }
  return { plan: result.value ?? null, error: null }
}

export function LibraryImportDialog({
  sessionId,
  onClose,
  onImported,
}: {
  sessionId: string
  onClose: () => void
  onImported: () => void
}) {
  const [step, setStep] = useState<ImportStep>('pick')
  const [draft, setDraft] = useState<ImportDraft>(emptyDraft)
  const [plan, setPlan] = useState<ImportPlanValue | null>(null)
  const [applied, setApplied] = useState<ImportApplyValue | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [volumes, setVolumes] = useState<ChaptersValue | null>(null)

  // The target picker offers the book's own volumes. A failed read is not fatal: the
  // author can still import into the book root, which is the default anyway.
  useEffect(() => {
    let live = true
    void fetchInternal<ChaptersValue>('/chapters', { sessionId }).then((result) => {
      if (live && result.ok) setVolumes(result.value ?? null)
    })
    return () => {
      live = false
    }
  }, [sessionId])

  const volumeOptions = useMemo(() => importVolumeOptions(volumes), [volumes])
  const draftProblem = describeImportDraft(draft)
  const rows = useMemo(() => importChapterRows(plan), [plan])
  const hidden = hiddenChapterCount(plan)
  const warnings = useMemo(() => describeImportWarnings(plan), [plan])
  const splitNotice = importSplitNotice(plan)

  const preview = useCallback(async (): Promise<void> => {
    if (draftProblem !== null) {
      setError(draftProblem.message)
      return
    }
    setBusy(true)
    setError(null)
    const result = await writeInternal<ImportPlanValue>('/library/import', importRequestBody(draft, 'plan'), { sessionId })
    const parsed = parsePlan(result)
    setPlan(parsed.plan)
    setError(parsed.error)
    setBusy(false)
    setStep(stepAfterPlan({ ok: parsed.plan !== null && parsed.error === null }))
  }, [draft, draftProblem, sessionId])

  const apply = useCallback(async (): Promise<void> => {
    if (!canApply(plan, busy) || plan === null) return
    setBusy(true)
    setError(null)
    const result = await writeInternal<ImportApplyValue>(
      '/library/import',
      importRequestBody(draft, 'apply', { confirm: true, planToken: plan.planToken ?? '' }),
      { sessionId },
    )
    setBusy(false)
    if (!result.ok) {
      setError(describeImportError(result.error))
      return
    }
    setApplied(result.value ?? null)
    setStep('done')
    onImported()
  }, [draft, onImported, plan, sessionId, busy])

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>导入旧稿</span>
        {STEPS.map((entry) => (
          <span
            key={entry.step}
            style={{
              ...mono,
              ...(stepIndex(step) >= stepIndex(entry.step) ? {} : muted),
              fontWeight: step === entry.step ? 600 : 400,
            }}
          >
            {entry.label}
          </span>
        ))}
        <button type="button" style={{ ...buttonStyle, marginLeft: 'auto' }} onClick={onClose}>
          关闭
        </button>
      </div>

      {step === 'pick' ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ ...muted, fontSize: 12 }}>
            TXT 或 Markdown 的完整路径（面板不读文件，路径交给 Host 去读；可以在书外）。编码、行尾、分章都由 Host 判定，下一步就能看到结果。
          </div>
          <input
            style={inputStyle}
            value={draft.sourcePath}
            placeholder="D:\\旧稿\\第一卷.txt"
            onChange={(event) => setDraft({ ...draft, sourcePath: event.currentTarget.value })}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ ...muted, ...mono }}>目标</span>
            <select
              style={{ ...inputStyle, width: 'auto' }}
              value={draft.volumeId}
              onChange={(event) => setDraft({ ...draft, volumeId: event.currentTarget.value })}
            >
              <option value="">书根（散章）</option>
              {volumeOptions.map((option) => (
                <option key={option.volumeId} value={option.volumeId}>
                  {option.label}
                </option>
              ))}
            </select>
            <label style={{ ...muted, ...mono, display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={draft.keepOriginal}
                onChange={(event) => setDraft({ ...draft, keepOriginal: event.currentTarget.checked })}
              />
              保留原件到 library/
            </label>
          </div>
          {error === null ? null : <div style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>{error}</div>}
          <div>
            <button type="button" style={primaryButtonStyle} disabled={busy || draftProblem !== null} onClick={() => void preview()}>
              {busy ? '读取中…' : '下一步：预览'}
            </button>
          </div>
        </div>
      ) : null}

      {step === 'preview' ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ ...mono }}>{describeImportSource(plan)}</div>
          <div style={{ ...mono, ...muted }}>编码判定：{plan?.source?.sniff ?? '?'}</div>
          <div style={{ ...mono }}>{describeImportTarget(plan)}</div>
          {splitNotice === null ? null : (
            <div style={{ color: 'var(--dsw-alias-state-warn-primary)', fontSize: 12 }}>{splitNotice}</div>
          )}
          <div style={{ ...mono, ...muted }}>{describeImportLibrary(plan)}</div>
          {warnings.length === 0 ? null : (
            <ul style={{ margin: 0, paddingLeft: 18, ...mono, ...muted }}>
              {warnings.map((warning, index) => (
                <li key={`import-warning-${index}`}>{warning}</li>
              ))}
            </ul>
          )}
          {rows.length === 0 ? null : (
            <div style={{ display: 'grid', gap: 2, maxHeight: 260, overflowY: 'auto', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, padding: 8 }}>
              {rows.map((row) => (
                <div key={`import-row-${row.seq}`} style={{ ...mono, display: 'flex', gap: 8 }}>
                  <span style={{ ...muted }}>{row.seq}</span>
                  <span style={{ flex: 1 }}>{row.title}</span>
                  <span style={{ ...muted }}>{row.detail}</span>
                </div>
              ))}
            </div>
          )}
          {hidden === 0 ? null : (
            <div style={{ ...mono, ...muted }}>
              只列出前 {IMPORT_PREVIEW_ROWS} 章，还有 {hidden} 章未显示（都会写入）。
            </div>
          )}
          {error === null ? null : <div style={{ color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={buttonStyle} disabled={busy} onClick={() => setStep('pick')}>
              返回改路径
            </button>
            <button type="button" style={primaryButtonStyle} disabled={!canApply(plan, busy)} onClick={() => void apply()}>
              {busy ? '写入中…' : '确认导入'}
            </button>
            <span style={{ ...muted, fontSize: 11, alignSelf: 'center' }}>
              确认后一次写入，失败会自动回滚；这一步之前没有任何写盘。
            </span>
          </div>
        </div>
      ) : null}

      {step === 'done' ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ ...mono }}>{describeImportResult(applied)}</div>
          {applied?.library === null || applied?.library === undefined ? null : (
            <div style={{ ...mono, ...muted }}>
              原件：{applied.library.path ?? ''}
              {applied.library.byteIdentical === true ? '（与原件逐字节相同）' : '（解码后的 UTF-8 文本）'}
            </div>
          )}
          <div style={{ ...muted, fontSize: 12 }}>
            想要撤销：导入前的那一版在备份包里（.inkflow/backup/），一个包对应这一次导入。
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={buttonStyle} onClick={() => void preview()}>
              再预览一次
            </button>
            <button type="button" style={buttonStyle} onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
