/**
 * The settings page's view model (ADR-0018) — pure functions, no React.
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
  /** OpenViking HTTP endpoint for semantic search (ADR-0020 E1); absent = not configured. */
  semanticEndpoint?: string
  /** Whether a bearer token is stored. The token itself never travels to the panel (E6). */
  semanticApiKeySet?: boolean
  autosaveIntervalMs: number
  authorName?: string
  excludeDirs: string[]
  backupKeep: number
  /** Delegation policy (optional: a payload from a build without it reads as `false`). */
  subagentEnabled?: boolean
  subagentProvider?: string
  subagentModel?: string
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
  /** Per-field detail behind `warn`: a hand-edited value the reader could not use. */
  notices?: Array<{ field: string; message: string }>
  fields: string[]
  limits: { autosaveIntervalMs: { min: number; max: number }; backupKeep: { min: number; max: number } }
  dataDir: string
  books: BookChoice[]
  /**
   * What the session is being told about delegation right now (the Host's own decision,
   * so the page never re-derives it): state + the one sentence.
   */
  delegation?: { state: 'off' | 'delegated' | 'unconfigured'; sentence: string; provider?: string; model?: string }
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
  semanticEndpoint: string
  /**
   * Write-only: the stored key is never echoed back (ADR-0020 E6), so this box starts empty
   * every time and an empty box means "keep the stored key".
   */
  semanticApiKey: string
  autosaveIntervalMs: string
  authorName: string
  excludeDirs: string
  backupKeep: string
  /** Delegation policy. `subagentModel` empty = ask the author at the moment of use. */
  subagentEnabled: boolean
  subagentProvider: string
  subagentModel: string
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
  semanticEndpoint: '语义检索端点',
  semanticApiKey: '语义检索密钥',
  autosaveIntervalMs: '自动保存间隔（ms）',
  authorName: '作者名',
  excludeDirs: '排除目录',
  backupKeep: '保留份数',
  subagentEnabled: '子智能体',
  subagentProvider: '子智能体 provider',
  subagentModel: '子智能体默认模型',
}

// ---------------------------------------------------------------------------
// Settings: form ↔ wire
// ---------------------------------------------------------------------------

export function formFromSettings(settings: SettingsValues): SettingsDraft {
  return {
    sharedRoot: settings.sharedRoot ?? '',
    semanticSearch: settings.semanticSearch === true,
    semanticEndpoint: settings.semanticEndpoint ?? '',
    // Never prefilled: the Host does not send the stored key back, only `semanticApiKeySet`.
    semanticApiKey: '',
    autosaveIntervalMs: String(settings.autosaveIntervalMs),
    authorName: settings.authorName ?? '',
    excludeDirs: settings.excludeDirs.join(', '),
    backupKeep: String(settings.backupKeep),
    // Absent means off (a payload from a build without the field), and an absent model means
    // "ask me" — the empty box, not a guess.
    subagentEnabled: settings.subagentEnabled === true,
    subagentProvider: settings.subagentProvider ?? '',
    subagentModel: settings.subagentModel ?? '',
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
  // An empty endpoint clears it (that IS the intent: "no semantic backend"). An empty key
  // box means "keep the stored one", because the value is never shown back to be re-typed.
  patch['semanticEndpoint'] = draft.semanticEndpoint.trim() === '' ? null : draft.semanticEndpoint.trim()
  const key = draft.semanticApiKey.trim()
  if (key !== '') patch['semanticApiKey'] = key
  const autosave = integerOrUndefined(draft.autosaveIntervalMs)
  if (autosave !== undefined) patch['autosaveIntervalMs'] = autosave
  const keep = integerOrUndefined(draft.backupKeep)
  if (keep !== undefined) patch['backupKeep'] = keep
  patch['excludeDirs'] = draft.excludeDirs
    .split(/[,，\n]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  // Delegation: an empty box CLEARS the field (`null`), which is the same intent as the
  // endpoint above. The switch is always sent — it is a boolean, and "unchecked" is a
  // value, not an omission. A provider with no model is stored as given and reads as
  // unconfigured on the Host side, which is exactly what the note beside the field says.
  patch['subagentEnabled'] = draft.subagentEnabled === true
  const provider = (draft.subagentProvider ?? '').trim()
  patch['subagentProvider'] = provider === '' ? null : provider
  const model = (draft.subagentModel ?? '').trim()
  patch['subagentModel'] = model === '' ? null : model
  return patch
}

/**
 * Whether a patch value equals what is stored.
 *
 * Three shapes, three rules: arrays compare by content; a BOOLEAN compares against
 * "absent = false", because a payload from a build without the field has no key at all and
 * an unchecked box is not a change; everything else uses the empty-string identity the
 * rest of this module already relies on (`null` and absent both mean "cleared").
 */
function sameFieldValue(next: unknown, current: unknown): boolean {
  if (Array.isArray(next) || Array.isArray(current)) {
    const left = Array.isArray(next) ? next.map(String) : []
    const right = Array.isArray(current) ? current.map(String) : []
    return left.join('\u0000') === right.join('\u0000')
  }
  if (typeof next === 'boolean' || typeof current === 'boolean') return (next === true) === (current === true)
  return (next ?? '') === (current ?? '')
}

/** Which fields the save would change, by label — what the confirm card lists. */
export function describeDraftChanges(draft: SettingsDraft, settings: SettingsValues): string[] {
  const patch = patchFromForm(draft)
  const changed: string[] = []
  for (const [field, label] of Object.entries(SETTINGS_FIELD_LABELS)) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue
    const current = (settings as unknown as Record<string, unknown>)[field]
    if (!sameFieldValue(patch[field], current)) changed.push(label)
  }
  return changed
}

/** The delegation block as the page shows it: one deciding line plus what to do next. */
export interface DelegationView {
  state: 'off' | 'delegated' | 'unconfigured'
  /** The summary label: `关` / `开（provider/model）` / `还差模型`. */
  label: string
  /** What the state means, in the page's own words. */
  notes: string[]
}

/**
 * The page's reading of the three values.
 *
 * NOT a copy of the policy the Host injects: that sentence is produced once, in
 * `src/host/delegation.ts`, and reaches the session (and the tool reply) from there. This
 * function answers a different question — "what does this form currently mean, and what is
 * missing before it can work" — and it is neutral about wording so the two cannot be
 * mistaken for each other.
 */
export function describeDelegationFields(fields: {
  enabled?: boolean
  provider?: string
  model?: string
}): DelegationView {
  const provider = (fields.provider ?? '').trim()
  const model = (fields.model ?? '').trim()
  if (fields.enabled !== true) {
    return { state: 'off', label: '关', notes: ['生成类任务（大纲 / 细纲 / 正文）由本会话自己写，不委派。'] }
  }
  if (model === '') {
    return {
      state: 'unconfigured',
      label: '还差模型',
      notes: [
        provider === ''
          ? '还差模型：模型留空 = 没有默认路由，每次动手前会先问你要用哪个模型（选项来自模型目录）。'
          : `还差模型：只填了 provider（${provider}），模型留空 —— 只填 provider 不构成一条能派发的路由，每次动手前会先问你要用哪个模型。`,
      ],
    }
  }
  return {
    state: 'delegated',
    label: provider === '' ? `开（${model}，provider 沿用当前会话）` : `开（${provider}/${model}）`,
    notes: ['生成类任务（大纲 / 细纲 / 正文）委派给这条路由；审计与设定入库留在本会话。'],
  }
}

/**
 * The one thing about this switch a panel can get wrong: a composition is loaded when the
 * session starts, so a change here reaches the NEXT session.
 */
export const DELEGATION_SESSION_NOTICE = '改这里只影响新开的会话：正在跑的会话保持它注册时的工具集。'

/** One line per setting, including the ones that are unset. */
export function describeSettings(settings: SettingsValues): string[] {
  return [
    `共享库：${settings.sharedRoot ?? '未设置（用插件目录下的 shared）'}`,
    `语义检索：${settings.semanticSearch === true ? '开' : '关'}${settings.semanticEndpoint === undefined ? '（未填端点，仍用关键词检索）' : `（端点 ${settings.semanticEndpoint}）`}`,
    `语义检索密钥：${settings.semanticApiKeySet === true ? '已设置（不显示）' : '未设置'}`,
    `自动保存间隔：${String(settings.autosaveIntervalMs)} ms`,
    `作者名：${settings.authorName ?? '未设置'}`,
    `排除目录：${settings.excludeDirs.length === 0 ? '无' : settings.excludeDirs.join('、')}`,
    `备份保留：${String(settings.backupKeep)} 份`,
    `子智能体：${describeDelegationFields({ enabled: settings.subagentEnabled, provider: settings.subagentProvider, model: settings.subagentModel }).label}`,
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
// Semantic retrieval: the status section's wire shapes and sentences
// ---------------------------------------------------------------------------

export interface SemanticRebuildSummary {
  at: string
  written: number
  tombstoned: number
  unchanged: number
  blocks: number
  bytes: number
  calls: number
  stale: number
  staleChapters: string[]
}

/**
 * How much of this book is in OpenViking — a different answer from `availability`, which
 * only says whether the backend answers. `headline` is the Host's own sentence (the same
 * string the tool prints), so the page and the model cannot describe the same state twice.
 */
export interface SemanticCoverageValue {
  state: string
  reason?: string
  hasLedger?: boolean
  blocks?: number
  tombstones?: number
  coveredChapters?: number
  bookChapters?: number | null
  behind?: number | null
  headline?: string
}

export interface SemanticStatusValue {
  availability: {
    backend: 'ovk' | 'fts5'
    reason?: string
    detail?: string
    peer?: string
    peerSource?: string
    configPath?: string
    endpoint?: string
  }
  coverage?: SemanticCoverageValue
  settings: { enabled: boolean; endpoint: string | null; apiKeySet: boolean }
  peer: { id: string | null; source: string | null; configPath: string | null }
  ledger: {
    projectId: string | null
    fresh: boolean
    chapters: number
    blocks: number
    tombstones: number
    lastRebuild: SemanticRebuildSummary | null
  }
  queue: { state: string; queued: number }
  thresholds: { chapters: number; bytes: number }
}

export interface SemanticEstimateValue {
  chapters: number
  pending: number
  blocks: number
  bytes: number
  calls: number
  unchanged: number
  tombstones: number
  totalBlocks: number
  requiresConfirm: boolean
}

/** `GET /hub/semantic?book=` — status plus the estimate the rebuild button shows. */
export interface SemanticSectionValue {
  book: { slug: string; title: string }
  indexRebuilt?: boolean
  indexState?: string
  status: SemanticStatusValue
  estimate: SemanticEstimateValue | null
}

/** `POST /hub/semantic/rebuild` and `…/purge` share this envelope. */
export interface SemanticRunValue {
  book: { slug: string; title: string }
  estimate?: SemanticEstimateValue
  executed?: boolean
  requiresConfirm?: boolean
  status?: string
  summary?: SemanticRebuildSummary
  staleChapters?: string[]
  uris?: string[]
  deleted?: string[]
  stoppedAt?: { uri: string; reason: string; detail: string }
}

/**
 * What each fixed degradation means as a next step.
 *
 * The vocabulary is fixed in the Host (ADR-0020 E5) exactly so this table can exist: one
 * sentence per reason, each naming an action the author can take. A free-text reason would
 * have forced a substring guess here.
 */
export const SEMANTIC_REASON_TEXTS: Record<string, string> = {
  disabled: '设置里的「语义检索」开关是关的',
  'no-endpoint': '没有填语义检索端点（设置里的「语义检索端点」）',
  'no-peer': '这本书没有 .openviking 里的 peer.id',
  // Not a backend problem: the block count is a fact about the book, so this reason can
  // only come from a search answer (a 0-block book never probes the server at all).
  'no-blocks': '这本书还没有建语义块（设置 → 语义检索 → 建立索引）',
  unreachable: '端点没有响应（OpenViking 没起来，或端口不对）',
  unauthorized: '端点拒绝了凭据（密钥不对）',
  timeout: '端点在超时内没有回答',
}

/** `（OpenViking <endpoint> · peer <id>）`, skipping the halves that are not configured. */
function backendFacts(status: SemanticStatusValue): string {
  const endpoint = status.settings.endpoint ?? ''
  const peer = status.peer.id ?? ''
  const parts = [endpoint === '' ? '' : endpoint, peer === '' ? '' : `peer ${peer}`].filter((part) => part !== '')
  return parts.length === 0 ? '' : `（OpenViking ${parts.join(' · ')}）`
}

/**
 * The section's headline lines, grouped as two answers instead of one word.
 *
 * WHY TWO LINES. 「语义检索：可用」 was one sentence for two facts: the server answers, and
 * this book is indexed in it. A book with a live peer and 0 blocks read as "可用", which is
 * exactly the misreading this split removes. The first line is the BACKEND (one health
 * probe), the second the BOOK (local files only, printed by `describeSemanticCoverage`).
 * While the backend does not answer there is no second line on purpose: the only fix is the
 * reason on the first one, and a second complaint would point at the wrong thing.
 */
export function describeSemantic(value: SemanticSectionValue): string[] {
  const status = value.status
  const lines: string[] = []
  const backendUp = status.availability.backend === 'ovk'
  lines.push(
    backendUp
      ? `后端：可用${backendFacts(status)}`
      : `后端：不可用 —— ${SEMANTIC_REASON_TEXTS[status.availability.reason ?? ''] ?? String(status.availability.reason ?? '未配置')}`,
  )
  if (status.availability.detail !== undefined && status.availability.detail !== '') {
    lines.push(`  ${status.availability.detail}`)
  }
  // While the backend is down its error is the headline, so the endpoint and peer it was
  // tried with go on their own line — "which server did it fail to reach" is the next question.
  if (!backendUp) {
    lines.push(`端点：${status.settings.endpoint ?? '未设置'} · peer：${status.peer.id ?? '无'}`)
  }
  lines.push(
    `密钥：${status.settings.apiKeySet ? '已设置（不显示）' : '未设置'} · 已写入：${String(status.ledger.blocks)} 块（章 ${String(status.ledger.chapters)} · 已删除章的占位 ${String(status.ledger.tombstones)}）`,
  )
  const last = status.ledger.lastRebuild
  if (last !== null) {
    lines.push(
      `最近重建：${formatStamp(last.at)} · 写 ${String(last.written)} 章 / 占位 ${String(last.tombstoned)} 章 · ${formatBytes(last.bytes)} · 调用 ${String(last.calls)} 次`,
    )
    if (last.stale > 0) lines.push(`  未完成 ${String(last.stale)} 章（下次重建会重试）`)
  }
  return lines
}

/**
 * The 「本书」 line: how much of THIS book the semantic index can hit, or `null` when there
 * is no point showing it.
 *
 * `null` in two cases, both deliberate: the backend is not answering (its reason is the one
 * thing to fix), or the Host does not report coverage at all (an older build — claiming
 * either "未建块" or "已同步" from missing data would be a guess). The sentence itself is
 * `coverage.headline`, computed once in the Host and printed here and by
 * `inkflow_semantic_status`, so the two channels cannot drift.
 */
export function describeSemanticCoverage(value: SemanticSectionValue): string | null {
  const status = value.status
  if (status.availability.backend !== 'ovk') return null
  const headline = status.coverage?.headline
  if (typeof headline !== 'string' || headline === '') return '本书：状态未知（这一版 Host 没有报覆盖率）'
  return `本书：${headline}`
}

/** The estimate under the rebuild button: size AND cost, because both are the decision. */
export function describeSemanticEstimate(estimate: SemanticEstimateValue | null, thresholds: { chapters: number; bytes: number }): string {
  if (estimate === null) return '预估不可用（索引读不出来）'
  if (estimate.pending === 0) return '这本书已与语义索引同步，无需重建。'
  const confirm = estimate.chapters > thresholds.chapters || estimate.bytes > thresholds.bytes
  return `待写 ${String(estimate.pending)} 章（未变 ${String(estimate.unchanged)}）· 约 ${String(estimate.blocks)} 块 · ${formatBytes(estimate.bytes)} · 约 ${String(estimate.calls)} 次摘要调用${confirm ? '（超过首次重建阈值，需要二次确认）' : ''}`
}

/** The line a finished run leaves behind. */
export function describeSemanticRun(value: SemanticRunValue): string[] {
  if (value.uris !== undefined && value.deleted !== undefined) {
    const stopped = value.stoppedAt
    return [
      `已清理 ${String(value.deleted.length)} 个占位块（共列出 ${String(value.uris.length)} 个）。`,
      ...(stopped === undefined ? [] : [`在 ${stopped.uri} 处停止：${stopped.reason} — ${stopped.detail}`]),
    ]
  }
  const summary = value.summary
  if (summary === undefined) return ['没有需要重建的章节。']
  return [
    `重建完成：写 ${String(summary.written)} 章 / 占位 ${String(summary.tombstoned)} 章 / 未变 ${String(summary.unchanged)} 章`,
    `块 ${String(summary.blocks)} 个 · ${formatBytes(summary.bytes)} · 调用 ${String(summary.calls)} 次${summary.stale > 0 ? ` · 未完成 ${String(summary.stale)} 章` : ''}`,
  ]
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
