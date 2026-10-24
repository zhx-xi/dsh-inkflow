/**
 * The settings page's view model (#42, ADR-0018) — pure functions, no React.
 *
 * Three sections on one page (设置 / 诊断包 / 备份), and each one is a form over the
 * wire shapes the hub channel answers (`/hub/settings`, `/hub/diagnostics`,
 * `/hub/backups`). Everything that can be decided without a render lives here so it
 * can be unit-tested and so the `.tsx` file stays a layout:
 *
 *   * `formFromSettings` / `patchFromForm` — the form is STRINGS (that is what an
 *     `<input>` holds) and the wire is typed; the conversion happens once, here, so
 *     the page never sends `"3000"` where the Host expects `3000`.
 *   * `describeSettings` — one line per field, including the values that are absent
 *     ("未设置"), because "empty" and "default" are different answers.
 *   * `mergeRestoreExpected` — the per-file digests a restore hands back, which is the
 *     whole safety mechanism of D6: only the files the plan would actually rewrite.
 *   * `formatBytes` / `formatStamp` — the two formatters the three sections share.
 */

import type { InternalResult } from './internal.js'

// ---------------------------------------------------------------------------
// Wire shapes (mirrors of `src/host/settings.ts` / `hub-settings.ts`)
// ---------------------------------------------------------------------------

export interface SettingsValues {
  sharedRoot?: string
  semanticSearch: boolean
  autosaveIntervalMs: number
  authorName?: string
  excludeDirs: string[]
  backupKeep: number
}

export interface SettingsWarning {
  code: string
  message: string
}

export interface BookChoice {
  workspaceId: string | null
  bookSlug: string
  title: string
}

export interface HubSettingsValue {
  settings: SettingsValues
  source: 'default' | 'file'
  warn: SettingsWarning | null
  fields: string[]
  limits: { autosaveIntervalMs: { min: number; max: number }; backupKeep: { min: number; max: number } }
  dataDir: string
  books: BookChoice[]
}

export interface BackupPackageView {
  file: string
  stamp: string
  bytes: number
  entries: number
  createdAt: string
}

export interface HubBackupsValue {
  book: { workspaceId: string | null; bookSlug: string; title: string }
  keep: number
  backups: BackupPackageView[]
}

export interface RestorePlanEntryView {
  path: string
  action: 'create' | 'overwrite' | 'same'
  bytes: number
  current: string | null
}

export interface RestorePlanValue {
  book: { workspaceId: string | null; bookSlug: string }
  plan: {
    file: string
    counts: { create: number; overwrite: number; same: number }
    entries: RestorePlanEntryView[]
    extra: string[]
  }
}

export interface DiagnosticsValue {
  path: string
  bytes: number
  summary: string[]
  book?: { slug: string } | null
  bookProblem?: string | null
}

export interface RestoreDoneValue {
  restored: string[]
  unchanged: string[]
  extra: string[]
  index: { state: string; rebuilt: boolean; ok: boolean; message?: string }
  backups: BackupPackageView[]
}

/** The page's own states: one per section, plus the pending confirmation. */
export type Loadable<T> = { status: 'ready'; value: T } | { status: 'error'; message: string } | { status: 'loading' }

export interface SettingsDraft {
  sharedRoot: string
  semanticSearch: boolean
  autosaveIntervalMs: string
  authorName: string
  excludeDirs: string
  backupKeep: string
}

// ---------------------------------------------------------------------------
// Texts (one place, so the three sections read like one page)
// ---------------------------------------------------------------------------

export const SETTINGS_TEXTS = {
  title: '设置 · 诊断 · 备份',
  back: '返回书库',
  refresh: '刷新',
  loading: '读取中…',
  settingsTitle: '设置',
  settingsHint: '这些设置属于插件（$DSH_HOME/inkflow/settings.json），不写进任何一本书：书是作者自己的 git 仓库，放进去就会被提交。',
  save: '保存设置',
  confirmSave: '确认写入设置',
  cancel: '取消',
  diagnosticsTitle: '诊断包',
  diagnosticsHint: '导出的 JSON 只含白名单字段：版本与构建戳、平台、索引元数据、各域计数、工具清单、脱敏后的设置。不含正文、.env、credentials、OVK 私有 peer，绝对路径一律替换为 ~/…。可以安全地贴进 issue。',
  exportNow: '导出诊断包',
  confirmExport: '确认导出',
  backupsTitle: '备份',
  backupsBook: '书',
  backupsHint: '备份是安全网，不是版本控制：做一次是一份完整快照，保留份数由「保留份数」决定；历史版本请用 git。',
  backupNow: '立即备份',
  confirmBackup: '确认备份',
  restore: '恢复…',
  planRestore: '预览恢复',
  confirmRestore: '确认恢复',
  noBackups: '这本书还没有备份。',
  saving: '写入中…',
} as const

export const SETTINGS_FIELD_LABELS: Record<string, string> = {
  sharedRoot: '共享库路径',
  semanticSearch: '语义检索',
  autosaveIntervalMs: '自动保存间隔（ms）',
  authorName: '作者名',
  excludeDirs: '排除目录',
  backupKeep: '保留份数',
}

// ---------------------------------------------------------------------------
// Settings: form ↔ wire
// ---------------------------------------------------------------------------

export function formFromSettings(settings: SettingsValues): SettingsDraft {
  return {
    sharedRoot: settings.sharedRoot ?? '',
    semanticSearch: settings.semanticSearch === true,
    autosaveIntervalMs: String(settings.autosaveIntervalMs),
    authorName: settings.authorName ?? '',
    excludeDirs: settings.excludeDirs.join(', '),
    backupKeep: String(settings.backupKeep),
  }
}

/** Numbers typed by a human: an empty box means "leave it alone", not zero. */
function integerOrUndefined(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined
}

/**
 * The patch a save sends.
 *
 * An empty text field sends `null` for an optional field (clear it) and is OMITTED for
 * a required number (keep the current value) — the two are different intents and the
 * Host distinguishes them the same way.
 */
export function patchFromForm(draft: SettingsDraft): Record<string, unknown> {
  const patch: Record<string, unknown> = { semanticSearch: draft.semanticSearch }
  patch['sharedRoot'] = draft.sharedRoot.trim() === '' ? null : draft.sharedRoot.trim()
  patch['authorName'] = draft.authorName.trim() === '' ? null : draft.authorName.trim()
  const autosave = integerOrUndefined(draft.autosaveIntervalMs)
  if (autosave !== undefined) patch['autosaveIntervalMs'] = autosave
  const keep = integerOrUndefined(draft.backupKeep)
  if (keep !== undefined) patch['backupKeep'] = keep
  patch['excludeDirs'] = draft.excludeDirs
    .split(/[,，\n]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  return patch
}

/** Which fields the save would change, by label — what the confirm card lists. */
export function describeDraftChanges(draft: SettingsDraft, settings: SettingsValues): string[] {
  const patch = patchFromForm(draft)
  const changed: string[] = []
  for (const [field, label] of Object.entries(SETTINGS_FIELD_LABELS)) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue
    const next = patch[field]
    const current = (settings as unknown as Record<string, unknown>)[field]
    const same = Array.isArray(next) && Array.isArray(current)
      ? next.join('\u0000') === current.join('\u0000')
      : (next ?? '') === (current ?? '')
    if (!same) changed.push(label)
  }
  return changed
}

/** One line per setting, including the ones that are unset. */
export function describeSettings(settings: SettingsValues): string[] {
  return [
    `共享库：${settings.sharedRoot ?? '未设置（用插件目录下的 shared）'}`,
    `语义检索：${settings.semanticSearch === true ? '开' : '关'}`,
    `自动保存间隔：${String(settings.autosaveIntervalMs)} ms`,
    `作者名：${settings.authorName ?? '未设置'}`,
    `排除目录：${settings.excludeDirs.length === 0 ? '无' : settings.excludeDirs.join('、')}`,
    `备份保留：${String(settings.backupKeep)} 份`,
  ]
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${String(Math.trunc(bytes))} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** `20261024-093000` → `2026-10-24 09:30 UTC`; the stamp is UTC by design (D3). */
export function formatStamp(stamp: string): string {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/u.exec(stamp)
  if (match === null) return stamp
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]} UTC`
}

export function backupSummary(value: HubBackupsValue): string {
  if (value.backups.length === 0) return `${value.book.title}：还没有备份（保留 ${String(value.keep)} 份）`
  const total = value.backups.reduce((sum, pack) => sum + pack.bytes, 0)
  return `${value.book.title}：${String(value.backups.length)} 份（保留 ${String(value.keep)} 份，共 ${formatBytes(total)}）`
}

// ---------------------------------------------------------------------------
// Reading the channel's answers
// ---------------------------------------------------------------------------

/** Turn one `InternalResult` into a loadable section, keeping the Host's own message. */
export function loadableFrom<T>(result: InternalResult<T>): Loadable<T> {
  if (result.ok === true && result.value !== undefined) return { status: 'ready', value: result.value }
  const code = result.error?.code ?? 'failed'
  const message = result.error?.message ?? code
  const hint = result.error?.hint
  return { status: 'error', message: typeof hint === 'string' && hint !== '' ? `${code} — ${message}（${hint}）` : `${code} — ${message}` }
}

/** The booked choice the page should select first: the first registered book. */
export function defaultBook(books: readonly BookChoice[]): BookChoice | undefined {
  return books[0]
}

/** The anchor a request sends for a choice: the registry id when there is one. */
export function anchorOf(book: BookChoice | undefined): string | undefined {
  if (book === undefined) return undefined
  return book.workspaceId ?? book.bookSlug
}

/**
 * The per-file baselines a restore sends back.
 *
 * Only the entries the plan would WRITE need one (D6): a `same` entry is not written,
 * so demanding a digest for it would be noise, and sending one for a file the plan
 * does not touch would let a stale map linger.
 */
export function mergeRestoreExpected(entries: readonly RestorePlanEntryView[]): Record<string, string | null> {
  const expected: Record<string, string | null> = {}
  for (const entry of entries) {
    if (entry.action === 'same') continue
    expected[entry.path] = entry.current
  }
  return expected
}

/** The plan as the confirm card describes it: what a restore would rewrite. */
export function describePlan(value: RestorePlanValue): string[] {
  const { counts } = value.plan
  const lines = [
    `${value.plan.file}：覆写 ${String(counts.overwrite)} · 新建 ${String(counts.create)} · 已一致 ${String(counts.same)}`,
  ]
  for (const entry of value.plan.entries.filter((candidate) => candidate.action !== 'same').slice(0, 12)) {
    lines.push(`- ${entry.action === 'create' ? '新建' : '覆写'} ${entry.path}`)
  }
  if (value.plan.entries.length > 12) lines.push(`… 共 ${String(value.plan.entries.length)} 个条目`)
  if (value.plan.extra.length > 0) {
    lines.push(`书里有 ${String(value.plan.extra.length)} 个文件不在包内，恢复不会删除它们`)
  }
  return lines
}

/** What a finished restore reports, including the index verdict. */
export function describeRestore(value: RestoreDoneValue): string[] {
  const lines = [
    `已写回 ${String(value.restored.length)} 个文件，${String(value.unchanged.length)} 个本来就一致`,
    `索引：${value.index.state}${value.index.rebuilt ? '（已重建）' : '（未重建）'}${value.index.message === undefined ? '' : ` — ${value.index.message}`}`,
  ]
  if (value.extra.length > 0) lines.push(`书里有 ${String(value.extra.length)} 个文件不在包内（未删除）`)
  return lines
}
