/**
 * The quality-gate tab (ADR-0022 D4, roadmap X-12).
 *
 * One screen: pick a chapter, read the eight checks, filter by severity. Nothing here
 * decides anything — the Host runs the gate (`gate.ts`) and this page prints what it said:
 *
 *   1. **八项各多少项** — a clean check shows a zero instead of looking like a check nobody ran;
 *   2. **每条 finding 先说人话** — the sentence leads and the code plus the address drop to a
 *      second line: the address is the string the conclusion file carries (paste-able into an
 *      issue), but the sentence is what a reader needs first;
 *   3. **按严重级过滤** — 需要处理 / 提示, because 30 informational notes hide 2 warnings.
 *
 * Read-only by construction: it calls `GET /gate` (`runGate(record: false)`), so opening this
 * tab never writes the verdict file. `inkflow_gate_check` writes it, and the header prints
 * where it lands so two runs can be diffed.
 *
 * Every hook sits before the first possible `return` (AGENTS.md §8 陷阱 2b); the page has no early return at all.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

import { ACTION_BUTTON_STYLE } from './action-button.js'
import { fetchInternal } from './internal.js'
import type { InternalResult } from './internal.js'
import { Icon } from './icons.js'
import { SCROLL_BOX_STYLE, SCROLL_COLUMN_STYLE } from './layout-model.js'
import { useScrollBox } from './layout.js'
import { GATE_SCOPE_NOTE } from './page-notes.js'
import { chapterHeading, flattenChapters } from './panel-model.js'
import type { ChapterNode, ChaptersValue } from './panel-model.js'

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

const selectStyle = {
  ...mono,
  padding: '2px 6px',
  borderRadius: 6,
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
} as const

const rowStyle = { display: 'grid', gap: 3, padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' } as const

/** The severity filter. `all` is the default; the two others are the report's own levels. */
type SeverityFilter = 'all' | 'warning' | 'info'

interface GateFindingView {
  readonly check: string
  readonly code: string
  readonly severity: string
  readonly address: string
  readonly detail: string
  readonly hint: string
  readonly fixable: boolean
}

interface GateView {
  readonly chapterId: string
  readonly chapterTitle: string
  readonly wordCount: number
  readonly recordPath: string
  readonly total: number
  readonly warning: number
  readonly info: number
  readonly byCheck: Readonly<Record<string, number>>
  readonly checks: readonly { readonly id: string; readonly label: string; readonly count: number }[]
  readonly findings: readonly GateFindingView[]
  readonly truncated: boolean
  /** 本作有几条豁免、这一章用掉了哪几处（ADR-0028 D6）。 */
  readonly waivers: GateWaiverView
}

interface GateWaiverView {
  readonly configured: number
  readonly applied: readonly {
    readonly code: string
    readonly locator: string
    readonly fragment: string
    readonly whitelistLine: number
  }[]
}

const NO_WAIVERS: GateWaiverView = { configured: 0, applied: [] }

const EMPTY_VIEW: GateView = {
  chapterId: '',
  chapterTitle: '',
  wordCount: 0,
  recordPath: '',
  total: 0,
  warning: 0,
  info: 0,
  byCheck: {},
  checks: [],
  findings: [],
  truncated: false,
  waivers: NO_WAIVERS,
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** The locator as the one string the file prints: `chapter:<id>`, `path#L<n>`, `kind:id`. */
function addressOf(raw: unknown): string {
  const locator = asRecord(raw)
  switch (str(locator['kind'])) {
    case 'chapter':
      return `chapter:${str(locator['chapterId'])}`
    case 'entity':
      return `${str(locator['entityKind'])}:${str(locator['id'])}`
    case 'catalog':
      return locator['volumeId'] === undefined ? 'catalog:' : `catalog:${str(locator['volumeId'])}`
    default:
      return locator['line'] === undefined ? str(locator['path']) : `${str(locator['path'])}#L${String(num(locator['line']))}`
  }
}

function readGateValue(raw: unknown): GateView {
  const root = asRecord(raw)
  if (Object.keys(root).length === 0) return EMPTY_VIEW
  const counts = asRecord(root['counts'])
  const byCheckRaw = asRecord(counts['byCheck'])
  const byCheck: Record<string, number> = {}
  for (const [key, value] of Object.entries(byCheckRaw)) byCheck[key] = num(value)
  const checksRaw = Array.isArray(root['checks']) ? (root['checks'] as unknown[]) : []
  const findingsRaw = Array.isArray(root['findings']) ? (root['findings'] as unknown[]) : []
  const waiversRaw = asRecord(root['waivers'])
  const appliedRaw = Array.isArray(waiversRaw['applied']) ? (waiversRaw['applied'] as unknown[]) : []
  return {
    chapterId: str(root['chapterId']),
    chapterTitle: str(root['chapterTitle']),
    wordCount: num(root['wordCount']),
    recordPath: str(root['recordPath']),
    total: num(counts['total']),
    warning: num(counts['warning']),
    info: num(counts['info']),
    byCheck,
    waivers: {
      configured: num(waiversRaw['configured']),
      applied: appliedRaw.map((entry) => {
        const hit = asRecord(entry)
        return {
          code: str(hit['code']),
          locator: str(hit['locator']),
          fragment: str(hit['fragment']),
          whitelistLine: num(hit['whitelistLine']),
        }
      }),
    },
    checks: checksRaw.map((entry) => {
      const check = asRecord(entry)
      return { id: str(check['id']), label: str(check['label']), count: num(check['count']) }
    }),
    findings: findingsRaw.map((entry) => {
      const finding = asRecord(entry)
      return {
        check: str(finding['check']),
        code: str(finding['code']),
        severity: str(finding['severity']),
        address: addressOf(finding['locator']),
        detail: str(finding['detail']),
        hint: str(finding['hint']),
        fixable: finding['fixable'] === true,
      }
    }),
    truncated: root['truncated'] === true,
  }
}

/** One severity's colour, from the host theme (never a literal). */
function severityColor(severity: string): string {
  return severity === 'warning' || severity === 'blocking'
    ? 'var(--dsw-alias-state-error-primary)'
    : 'var(--dsw-alias-label-secondary)'
}

function severityLabel(severity: string): string {
  if (severity === 'warning' || severity === 'blocking') return '需要处理'
  return '提示'
}

/** The severity as a chip, so a row leads with its sentence and the level is a small badge. */
function GateSeverityBadge({ severity }: { severity: string }) {
  const tone = { color: severityColor(severity), borderColor: severityColor(severity) }
  return (
    <span style={{ display: 'inline-flex', padding: '0 6px', borderRadius: 999, border: '1px solid', ...tone }}>
      {severityLabel(severity)}
    </span>
  )
}

function describeError(error: { code?: string; message?: string; hint?: string } | undefined): string {
  if (error === undefined) return '门禁读取失败'
  const code = error.code === undefined ? '' : `（${error.code}）`
  return `${error.message === undefined ? '门禁读取失败' : error.message}${code}`
}

export interface GateViewProps {
  /** The session this panel is attached to; the Host resolves the book from it. */
  readonly sessionId: string
}

export function GateQualityView({ sessionId }: GateViewProps) {
  const [chapters, setChapters] = useState<ChaptersValue | null>(null)
  const [selected, setSelected] = useState<string>('')
  const [gate, setGate] = useState<InternalResult<Record<string, unknown>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [chapterError, setChapterError] = useState<string | null>(null)
  const [filter, setFilter] = useState<SeverityFilter>('all')
  const scrollBox = useScrollBox()

  const rows: readonly ChapterNode[] = useMemo(() => flattenChapters(chapters), [chapters])

  const loadChapters = useCallback(async () => {
    const result = await fetchInternal<ChaptersValue>('/chapters', { sessionId })
    if (!result.ok) {
      setChapterError(describeError(result.error))
      return
    }
    setChapterError(null)
    setChapters(result.value ?? null)
    setSelected((current) => {
      if (current !== '') return current
      const list = flattenChapters(result.value ?? null)
      return list.at(-1)?.id ?? ''
    })
  }, [sessionId])

  const loadGate = useCallback(
    async (chapterId: string) => {
      if (chapterId === '') {
        setGate(null)
        setLoading(false)
        return
      }
      setLoading(true)
      const result = await fetchInternal<Record<string, unknown>>(
        `/gate?chapterId=${encodeURIComponent(chapterId)}`,
        { sessionId },
      )
      setGate(result)
      setLoading(false)
    },
    [sessionId],
  )

  useEffect(() => {
    void loadChapters()
  }, [loadChapters])

  useEffect(() => {
    void loadGate(selected)
  }, [loadGate, selected])

  const view = useMemo(() => readGateValue(gate !== null && gate.ok ? (gate.value ?? undefined) : undefined), [gate])
  const loadError = gate !== null && !gate.ok ? describeError(gate.error) : null

  const visible = useMemo(
    () => (filter === 'all' ? view.findings : view.findings.filter((finding) => finding.severity === filter)),
    [view.findings, filter],
  )

  const checkRows = useMemo(
    () =>
      view.checks.map((check) => ({
        ...check,
        items: visible.filter((finding) => finding.check === check.id),
      })),
    [view.checks, visible],
  )

  return (
    <div ref={scrollBox.ref} style={{ ...bodyStyle, ...SCROLL_BOX_STYLE, ...scrollBox.style }}>
      <div style={columnStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ ...muted, fontSize: 12, letterSpacing: 0.2 }}>质量门禁</div>
          <select
            style={selectStyle}
            value={selected}
            disabled={rows.length === 0}
            onChange={(event) => {
              setSelected(event.target.value)
            }}
          >
            {rows.length === 0 ? <option value="">（这本书还没有章节）</option> : null}
            {rows.map((chapter) => (
              <option key={chapter.id} value={chapter.id}>
                {chapterHeading(chapter)}
              </option>
            ))}
          </select>
          <span style={{ ...muted, ...mono, fontSize: 12 }}>
            {loading
              ? '跑门禁…'
              : `共 ${String(view.total)} 项（需要处理 ${String(view.warning)} · 提示 ${String(view.info)}）· ${String(
                  view.wordCount,
                )} 字`}
          </span>
          <span style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
            {(['all', 'warning', 'info'] as const).map((level) => (
              <button
                key={level}
                type="button"
                style={{ ...ACTION_BUTTON_STYLE, ...(filter === level ? { borderColor: 'var(--dsw-alias-label-primary)' } : {}) }}
                onClick={() => {
                  setFilter(level)
                }}
              >
                {level === 'all' ? '全部' : severityLabel(level)}
              </button>
            ))}
            <button type="button" style={ACTION_BUTTON_STYLE} disabled={loading} onClick={() => void loadGate(selected)}>
              <Icon name="refresh" size={13} />
              {loading ? '读取中…' : '重新跑'}
            </button>
          </span>
        </div>

        <div style={{ ...muted, ...mono, fontSize: 11 }}>{GATE_SCOPE_NOTE}</div>
        <div style={{ ...muted, ...mono, fontSize: 11 }}>
          {view.recordPath === '' ? '只读：这个页面不写任何文件' : `结论文件：${view.recordPath}（同章同文件两次运行字节相同）`}
        </div>
        {/* 本作有 N 条豁免——不显示的话，作者过两周就会忘了自己豁免过什么（ADR-0028 D6）。 */}
        {view.waivers.configured === 0 ? null : (
          <div style={{ ...muted, ...mono, fontSize: 11 }}>
            {`本作有 ${String(view.waivers.configured)} 条豁免（library/gate-whitelist.txt），这一章用掉 ${String(
              view.waivers.applied.length,
            )} 处`}
            {view.waivers.applied.length === 0
              ? ''
              : `：${view.waivers.applied
                  .map((hit) => `${hit.code} ${hit.locator}「${hit.fragment}」（第 ${String(hit.whitelistLine)} 行）`)
                  .join(' · ')}`}
          </div>
        )}
        {chapterError === null ? null : <div style={{ ...muted, fontSize: 12 }}>章节列表读取失败：{chapterError}</div>}
        {loadError === null ? null : <div style={{ ...muted, fontSize: 12 }}>{loadError}</div>}

        {checkRows.map((check) => (
          <div key={check.id} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <div style={{ fontWeight: 600 }}>{check.label}</div>
              <div style={{ ...muted, fontSize: 12 }}>{String(check.count)} 项</div>
            </div>
            {check.items.length === 0 ? (
              <div style={{ ...muted, fontSize: 12, marginTop: 4 }}>
                {check.count === 0 ? '这一项没有问题。' : '被当前严重级过滤掉了。'}
              </div>
            ) : (
              check.items.map((finding) => (
                <div key={`${finding.check}:${finding.code}:${finding.address}:${finding.detail}`} style={rowStyle}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <GateSeverityBadge severity={finding.severity} />
                    <span style={{ fontSize: 13, flex: '1 1 200px' }}>{finding.detail}</span>
                  </div>
                  <div style={{ ...muted, ...mono, fontSize: 11, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span>{finding.code}</span>
                    <span>{finding.address}</span>
                    {finding.fixable ? <span>可自动修复</span> : null}
                  </div>
                  <div style={{ ...muted, fontSize: 12 }}>{finding.hint}</div>
                </div>
              ))
            )}
          </div>
        ))}

        {!loading && loadError === null && view.total === 0 && view.checks.length > 0 ? (
          <div style={{ ...muted, fontSize: 12 }}>八项门禁都没有发现问题。</div>
        ) : null}
        {view.truncated ? (
          <div style={{ ...muted, fontSize: 11 }}>
            面板只拿到前 {String(view.findings.length)} 项（共 {String(view.total)} 项）：完整清单在结论文件里。
          </div>
        ) : null}
      </div>
    </div>
  )
}
