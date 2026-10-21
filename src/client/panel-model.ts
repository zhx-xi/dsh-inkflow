/**
 * Pure view model for the panel skeleton (issue #17).
 *
 * Everything here is a plain function over plain data: the panel's state
 * wording, the four-state badge, the volume tree, the empty-state choice and the
 * project-root display. Keeping them out of the React component is what makes
 * them testable at all — `node --test` has no DOM, so the component itself is
 * only checked as a built bundle (tests/panel-bundle.test.js).
 *
 * Two shapes from the private channel feed this file (ADR-0008 D2/D5):
 *   * `GET /inkflow/internal/status` answers `{ok:true,value}` when the book is
 *     `usable`, and `{ok:false,error}` carrying the SAME four-state checklist
 *     when it is not. `readGate` folds both into one `PanelGate`, so the panel
 *     never has to remember which of the two it is looking at.
 *   * `GET /inkflow/internal/chapters` answers the volume tree; `buildChapterTree`
 *     keeps the volumes and `flattenChapters` gives the reading order.
 *
 * No IO, no React, no `@deepseek-ai/*` import: the panel talks to the Host only
 * through `./internal.js` (ADR-0008 D4 — a session id, never a directory).
 */

import type { InternalError, InternalResult } from './internal.js'

/** The four gate states. Anything else means "we have not learnt it yet". */
export type ProjectState = 'usable' | 'needs-setup' | 'needs-repair' | 'needs-newer-plugin'

/** Theme tones, rendered as `--dsw-alias-state-<tone>-primary`. */
export type BadgeTone = 'success' | 'warn' | 'error' | 'idle'

/** One wizard step as the Host reports it (`planWorkspace`'s `actions[]`). */
export interface WorkspaceAction {
  type?: string
  path?: string
  reason?: string
}

/** `ProjectProbe.checks`, flattened: only the keys the panel shows. */
export interface ProjectChecks {
  git?: boolean
  dirs?: Record<string, boolean>
  keeps?: Record<string, boolean>
  meta?: boolean
}

/** `GET /inkflow/internal/status` → `value` (only the fields the panel reads). */
export interface StatusValue {
  pluginVersion?: string
  sessionId?: string
  resolvedFrom?: string
  root?: string
  label?: string
  state?: string
  usable?: boolean
  readOnly?: boolean
  checks?: ProjectChecks
  missing?: string[]
  actions?: WorkspaceAction[]
  reasons?: string[]
  index?: {
    dbExists?: boolean
    schemaMatches?: boolean
    builtAt?: string | null
    counts?: Record<string, number>
  }
  catalog?: { stale?: boolean; volumes?: number; chapters?: number }
}

/** One chapter as the channel lists it. */
export interface ChapterNode {
  id: string
  path: string
  seq: number | null
  title: string
}

/** `GET /inkflow/internal/chapters` → `value`. */
export interface ChaptersValue {
  total?: number
  volumes?: Array<{ volumeId?: string; dir?: string; title?: string; chapters?: ChapterNode[] }>
  looseChapters?: ChapterNode[]
}

/** `GET /inkflow/internal/chapters/:id` → `value`. */
export interface ChapterDetailValue {
  id?: string
  path?: string
  title?: string
  seq?: number | null
  volumeId?: string | null
  body?: string
  bodyChars?: number
  hasFrontmatter?: boolean
  issues?: unknown[]
}

/**
 * The one thing the panel renders about the gate, whichever envelope carried it.
 *
 * `state: null` is "not known yet" (still loading, or no session): the badge then
 * says "未定位项目" instead of pretending a fourth state.
 */
export interface PanelGate {
  state: ProjectState | null
  label: string
  tone: BadgeTone
  projectTitle: string | null
  root: string | null
  usable: boolean
  readOnly: boolean
  missing: string[]
  actions: WorkspaceAction[]
  reasons: string[]
  hint: string | null
  errorCode: string | null
}

/** The four-state badge: one row per state, plus the "unknown" fallback. */
export const STATE_BADGES: Record<ProjectState, { label: string; tone: BadgeTone }> = {
  usable: { label: '可用', tone: 'success' },
  'needs-setup': { label: '待初始化', tone: 'warn' },
  'needs-repair': { label: '待修复', tone: 'warn' },
  'needs-newer-plugin': { label: '需升级插件', tone: 'error' },
}

/** Shown when no session (or nothing has answered yet) named a project. */
export const UNKNOWN_BADGE: { label: string; tone: BadgeTone } = { label: '未定位项目', tone: 'idle' }

/** Empty states the panel can be in, keyed by the reason it is empty. */
export type EmptyKind = 'no-session' | 'no-chapters' | 'needs-setup' | 'no-selection'

export const EMPTY_MESSAGES: Record<EmptyKind, { title: string; body: string }> = {
  'no-session': {
    title: '没有会话身份',
    body: '面板没拿到会话 id（NO_SESSION_CONTEXT），因此无法确定这是哪本书。在小说目录的会话里打开这个页签即可让 Host 按会话解析项目。',
  },
  'no-chapters': {
    title: '还没有章节',
    body: 'chapters/ 里还没有卷或章。让 AI 建卷建章，或直接在 chapters/ 下写 Markdown，面板会显示卷章树。',
  },
  'needs-setup': {
    title: '先初始化这本小说',
    body: '这个目录还不是可用的 InkFlow 项目：git 仓库、九个内容目录与 index/（各带 .gitkeep）、inkflow.json 齐全后，面板才有东西可读。',
  },
  'no-selection': {
    title: '选择一章看正文',
    body: '左栏点一章，这里显示它的只读预览。编辑器与提案制修订在后续版本。',
  },
}

/**
 * Route failures worth a sentence. `NO_SESSION_CONTEXT` is a normal state, not a
 * bug: the page was opened without a session, so saying so beats a bare code.
 */
export const ERROR_HINTS: Record<string, string> = {
  NO_SESSION_CONTEXT: '当前页签没有会话身份，无法定位项目（NO_SESSION_CONTEXT）',
  PROJECT_NEEDS_NEWER_PLUGIN: '这本书由更新版本的 dsh-inkflow 写入，需要先升级插件',
  PROJECT_NEEDS_REPAIR: '这本小说的目录不完整或已损坏，需要按清单补齐',
  NOT_AN_INKFLOW_PROJECT: '这个目录还不是 InkFlow 项目，先按清单初始化',
  'chapter-not-found': '这一章在 chapters/ 里找不到了，可能已被改名或删除',
  'fetch-failed': '面板通道请求失败，检查 DSH 与插件的连接',
}

/** Message for a failed call: the hint table first, then the Host's own words. */
export function describeRouteError(error: InternalError | undefined): string {
  if (error === undefined) return '面板通道没有返回内容'
  return ERROR_HINTS[error.code] ?? error.message ?? error.code
}

function asState(value: unknown): ProjectState | null {
  return value === 'usable' || value === 'needs-setup' || value === 'needs-repair' || value === 'needs-newer-plugin'
    ? value
    : null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function asActions(value: unknown): WorkspaceAction[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is WorkspaceAction => typeof item === 'object' && item !== null)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Fold `GET /status` into one `PanelGate`.
 *
 * A `usable` book answers `{ok:true,value}`; every other state answers
 * `{ok:false,error}` that carries the same checklist (ADR-0008 D5). Both are
 * normal answers, so this never throws: an unusable directory is a state the
 * panel renders, not an error it reports.
 */
export function readGate(result: InternalResult<StatusValue> | null): PanelGate {
  const empty: PanelGate = {
    state: null,
    label: UNKNOWN_BADGE.label,
    tone: UNKNOWN_BADGE.tone,
    projectTitle: null,
    root: null,
    usable: false,
    readOnly: false,
    missing: [],
    actions: [],
    reasons: [],
    hint: null,
    errorCode: null,
  }
  if (result === null) return empty

  if (result.ok && result.value !== undefined) {
    const value = result.value
    const state = asState(value.state) ?? (value.usable === true ? 'usable' : null)
    const badge = state === null ? UNKNOWN_BADGE : STATE_BADGES[state]
    return {
      ...empty,
      state,
      label: badge.label,
      tone: badge.tone,
      projectTitle: optionalString(value.label),
      root: optionalString(value.root),
      usable: state === 'usable',
      readOnly: value.readOnly === true,
      missing: asStringArray(value.missing),
      actions: asActions(value.actions),
      reasons: asStringArray(value.reasons),
    }
  }

  // The gate refusal: the checklist lives in `error`, not in `value`.
  const error = asRecord(result.error)
  const state = asState(error?.['state'])
  const badge = state === null ? UNKNOWN_BADGE : STATE_BADGES[state]
  return {
    ...empty,
    state,
    label: badge.label,
    tone: badge.tone,
    root: optionalString(error?.['root']),
    usable: false,
    readOnly: error?.['readOnly'] === true,
    missing: asStringArray(error?.['missing']),
    actions: asActions(error?.['actions']),
    reasons: asStringArray(error?.['reasons']),
    hint: optionalString(error?.['hint']),
    errorCode: optionalString(error?.['code']),
  }
}

/**
 * Which empty state the panel is in, if any — `null` means "render normally".
 *
 * A gate failure other than the session one (`fetch-failed`, …) is NOT an empty
 * state: the panel shows that text as the problem it is. `needs-setup` covers
 * every non-usable state, because the wizard card renders all four badge labels.
 */
export function emptyKindOf(gate: PanelGate, chapterCount: number, hasSelection: boolean): EmptyKind | null {
  if (gate.state === null) return gate.errorCode === 'NO_SESSION_CONTEXT' ? 'no-session' : null
  if (!gate.usable) return 'needs-setup'
  if (chapterCount === 0) return 'no-chapters'
  if (!hasSelection) return 'no-selection'
  return null
}

/** One volume and the chapters under it; the panel renders this as a tree. */
export interface ChapterTreeGroup {
  volumeId: string
  title: string
  dir: string | null
  chapters: ChapterNode[]
}

export interface ChapterTree {
  groups: ChapterTreeGroup[]
  loose: ChapterNode[]
  total: number
}

function asChapter(value: unknown): ChapterNode | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const id = optionalString(record['id'])
  if (id === null) return undefined
  const seq = record['seq']
  return {
    id,
    path: optionalString(record['path']) ?? id,
    seq: typeof seq === 'number' ? seq : null,
    title: optionalString(record['title']) ?? id,
  }
}

function asChapters(value: unknown): ChapterNode[] {
  if (!Array.isArray(value)) return []
  return value.map(asChapter).filter((chapter): chapter is ChapterNode => chapter !== undefined)
}

/**
 * The volume tree, kept as a tree.
 *
 * The Host lists volumes in catalog order and their chapters in reading order,
 * so this only normalises shapes and drops entries the panel cannot name. Empty
 * volumes are kept: an empty volume is a real editorial state.
 */
export function buildChapterTree(value: ChaptersValue | null): ChapterTree {
  if (value === null) return { groups: [], loose: [], total: 0 }
  const groups: ChapterTreeGroup[] = []
  const volumes = Array.isArray(value.volumes) ? value.volumes : []
  for (const [index, volume] of volumes.entries()) {
    const record = asRecord(volume)
    if (record === undefined) continue
    const volumeId = optionalString(record['volumeId']) ?? `volume-${index + 1}`
    groups.push({
      volumeId,
      title: optionalString(record['title']) ?? volumeId,
      dir: optionalString(record['dir']),
      chapters: asChapters(record['chapters']),
    })
  }
  const loose = asChapters(value.looseChapters)
  const total = groups.reduce((sum, group) => sum + group.chapters.length, 0) + loose.length
  return { groups, loose, total }
}

/** The same tree in reading order: volumes first, then the loose chapters. */
export function flattenChapters(value: ChaptersValue | null): ChapterNode[] {
  const tree = buildChapterTree(value)
  return [...tree.groups.flatMap((group) => group.chapters), ...tree.loose]
}

/** `3. 第一次出门` — the seq is null for a chapter whose name carries no number. */
export function chapterHeading(chapter: ChapterNode): string {
  return chapter.seq === null ? chapter.title : `${chapter.seq}. ${chapter.title}`
}

/** The wizard's step wording, keyed by the Host's action type. */
export const ACTION_LABELS: Record<string, string> = {
  'git-init': 'git init',
  'create-dir': '建目录',
  'create-gitkeep': '补 .gitkeep',
  'create-meta': '写 inkflow.json',
  'create-gitignore': '写 .gitignore',
  manual: '需人工处理',
}

/** One action row: `建目录 · chapters/ · 缺正文目录`. */
export function describeAction(action: WorkspaceAction): string {
  const type = action.type ?? 'manual'
  const label = ACTION_LABELS[type] ?? type
  const target = action.path === undefined || action.path === '' ? '' : ` · ${action.path}`
  const reason = action.reason === undefined || action.reason === '' ? '' : ` · ${action.reason}`
  return `${label}${target}${reason}`
}

/**
 * The project root as the panel shows it: relative to the session's workspace.
 *
 * The workspace path comes from the Client (`useWorkspaces`), the root from the
 * Host (`/status`); they are the same directory in the normal case and the
 * panel says `./`. A root outside the workspace is shown untouched — that is a
 * sentence about the book ("this session was opened in another directory"), not
 * something to hide.
 */
export function relativeProjectRoot(root: string | null, workspacePath: string | null): string | null {
  if (root === null) return null
  if (workspacePath === null || workspacePath.trim() === '') return root
  const slash = (value: string): string => value.replaceAll('\\', '/').replace(/\/+$/u, '')
  const book = slash(root)
  const base = slash(workspacePath)
  if (book === base) return './'
  const lowerBook = book.toLowerCase()
  const lowerBase = base.toLowerCase()
  // Windows paths differ only in case across Host/Client spellings of the same
  // directory (`D:\Novels\x` vs `d:\novels\x`), so equality is case-insensitive.
  if (lowerBook === lowerBase) return './'
  if (lowerBook.startsWith(`${lowerBase}/`)) return `./${book.slice(base.length + 1)}`
  return root
}

/** A preview of the chapter body: the head, with the cut marked. */
export function previewText(body: string | undefined, limit = 2000): { text: string; truncated: boolean } {
  const source = (body ?? '').replace(/^\uFEFF/u, '').trim()
  if (source.length <= limit) return { text: source, truncated: false }
  return { text: source.slice(0, limit), truncated: true }
}

/**
 * What `/status` already answered about derived state, and nothing else.
 *
 * The index is a cache: the panel reports "built / missing" and the catalog
 * counts the Host projected. It never implies the index is a source of truth
 * (ADR-0005) and never offers to rebuild it — that is a tool call.
 */
export interface ProjectFacts {
  indexBuilt: boolean | null
  indexBuiltAt: string | null
  volumes: number | null
  chapters: number | null
}

export function projectFacts(result: InternalResult<StatusValue> | null): ProjectFacts {
  const facts: ProjectFacts = { indexBuilt: null, indexBuiltAt: null, volumes: null, chapters: null }
  if (result === null || !result.ok || result.value === undefined) return facts
  const value = result.value
  const index = asRecord(value.index)
  const catalog = asRecord(value.catalog)
  const built = index?.['dbExists']
  const volumes = catalog?.['volumes']
  const chapters = catalog?.['chapters']
  facts.indexBuilt = typeof built === 'boolean' ? built : null
  facts.indexBuiltAt = optionalString(index?.['builtAt'])
  facts.volumes = typeof volumes === 'number' ? volumes : null
  facts.chapters = typeof chapters === 'number' ? chapters : null
  return facts
}

/** The one muted line under the chapter tree: `索引 已建 · 卷 2 · 章 7`. */
export function describeFacts(facts: ProjectFacts): string {
  const index =
    facts.indexBuilt === null
      ? '索引 未知'
      : facts.indexBuilt
        ? `索引 已建${facts.indexBuiltAt === null ? '' : `（${facts.indexBuiltAt}）`}`
        : '索引 缺失（首次调用工具时会重建）'
  const volumes = facts.volumes === null ? '卷 —' : `卷 ${facts.volumes}`
  const chapters = facts.chapters === null ? '章 —' : `章 ${facts.chapters}`
  return `${index} · ${volumes} · ${chapters}`
}


/** A panel tab. `available: false` renders disabled with its `note` as tooltip. */
export interface PanelTab {
  id: string
  label: string
  available: boolean
  note?: string
}

/**
 * The tabs the skeleton shows.
 *
 * Only 章节 exists in this build: 设定 / 大纲 / 伏笔 are declared DISABLED with
 * their release note rather than wired to a placeholder page. A button that
 * opens nothing is worse than a disabled one that says when it arrives.
 */
export const PANEL_TABS: PanelTab[] = [
  { id: 'chapters', label: '章节', available: true },
  { id: 'settings', label: '设定', available: false, note: '0.2.0 起' },
  { id: 'outline', label: '大纲', available: false, note: '0.2.0 起' },
  { id: 'foreshadowing', label: '伏笔', available: false, note: '0.2.0 起' },
]
