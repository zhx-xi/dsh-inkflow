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

import { describeOriginRefusal, describeTooLarge } from './error-text.js'
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
  /**
   * The meta parses but its title carries GBK round-trip artifacts (issue #89):
   * a file this plugin did not write. A hint beside the title, never a gate
   * state — the Host reports it only when the title is genuinely suspicious.
   */
  titleSuspicious?: boolean
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
  /**
   * Issue #88: which generation the Host is running and whether the disk holds a
   * newer one. Present in `value` when the book is usable AND in `error` when the
   * gate refuses — a stale generation refuses a healthy book as "needs setup".
   */
  build?: BuildValue
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
  status?: string
  body?: string
  bodyChars?: number
  hasFrontmatter?: boolean
  issues?: unknown[]
  /**
   * The CAS baseline for the next save (issue #19). The Host fingerprints the
   * bytes it just handed over; the editor sends that back so a file changed in
   * the author's own editor is never overwritten silently.
   */
  fingerprint?: { size?: number; mtimeMs?: number; sha256?: string } | null
  /**
   * The file's own format (ADR-0016): the Host reads the raw bytes and reports
   * them here, `body` stays LF. The editor sends both back on save — without
   * them the Host can only normalise, which rewrites a CRLF chapter to LF and
   * turns a one-character edit into a whole-chapter diff (#132).
   */
  eol?: 'lf' | 'crlf'
  bom?: boolean
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
  /** The title looks like a GBK round-trip accident (issue #89); cosmetic only. */
  titleSuspicious: boolean
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
    title: '选择一章开始写',
    body: '左栏点一章，这里就是它的编辑器（标题 / 正文 / 状态），停止输入 1.5 秒会自动保存。',
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
  'write-failed': '保存请求没有到达 Host，检查 DSH 与插件的连接后重试',
  FILE_CHANGED: '这一章在磁盘上被改过了，面板没有覆盖它（选「重新载入」或「仍要保存」）',
  'unsupported-media-type': '写请求必须是 JSON（面板内部错误）',
  'invalid-field': '请求里有一个字段不合法',
  UNEXPECTED_BODY_FIELD: '请求里出现了面板不认识字段（面板内部错误）',
  PROJECT_BUSY: '另一个会话正在写这本书，稍后重试',
  // Only `chapters.ts` raises this (the write route resolves a chapter by id and
  // demands uniqueness), so it belongs to the chapter mapper — putting it in the
  // library mapper made it dead code and left the chapter editor showing the Host's
  // English sentence (caught in review of PR #118).
  CHAPTER_AMBIGUOUS: '这个 id 被两章共用，写路径无法确定改哪一章：请给其中一章换一个 id 后再保存。',
}

/** Message for a failed call: the hint table first, then the Host's own words. */
export function describeRouteError(error: InternalError | undefined): string {
  if (error === undefined) return '面板通道没有返回内容'
  // The one refusal whose text has to carry numbers (issue 115): a save larger
  // than the channel's ceiling names the ceiling and says nothing was written.
  const tooLarge = describeTooLarge(error)
  if (tooLarge !== null) return tooLarge
  const refusedOrigin = describeOriginRefusal(error)
  if (refusedOrigin !== null) return refusedOrigin
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
    titleSuspicious: false,
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
      titleSuspicious: value.titleSuspicious === true,
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
 * The tooltip behind the small marker next to a suspicious book title (issue #89).
 *
 * Wording matters here: the panel cannot fix the file, and "your title is wrong"
 * without a way out is noise. So it names the cause (an encoding accident) and the
 * two real exits — rewrite it through the tool surface, or edit the file as UTF-8.
 */
export const TITLE_SUSPICION_NOTE =
  '书名疑似编码乱码：可在编辑器里重写或手动修正 inkflow.json（必须 UTF-8 无 BOM）'

/**
 * The marker's tooltip, or `null` when there is nothing to say.
 *
 * A hint, not a state: it is shown beside the title and blocks nothing — a book
 * with a garbled name is still editable, and refusing to open it would punish the
 * author for a file some other tool wrote.
 */
export function describeTitleSuspicion(gate: PanelGate): string | null {
  return gate.titleSuspicious ? TITLE_SUSPICION_NOTE : null
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


// ---------------------------------------------------------------------------
// Build identity and stale-load warning (issue #88). Self-contained on purpose:
// it is one block of additions, so a parallel change to the panel's book tree
// merges around it instead of through it.
// ---------------------------------------------------------------------------

/** `/status` `build` (inside `value` or `error`) exactly as the Host sends it. */
export interface BuildValue {
  version?: string
  build?: string
  loadedAt?: string
  staleLoadedCode?: boolean
  diskBuildTime?: string
}

/** The same, normalized for rendering: `null` = the Host did not say. */
export interface PanelBuild {
  version: string | null
  build: string | null
  loadedAt: string | null
  /** True only when the Host proved the disk file is newer than its own start. */
  staleLoadedCode: boolean
  diskBuildTime: string | null
}

/** What the panel shows before any answer arrives. */
export const UNKNOWN_BUILD_LABEL = '未知'

/**
 * Read the build summary out of either envelope.
 *
 * Both halves matter (issue #88): a stale generation renders the gate REFUSAL
 * for a book that is usable, so `error.build` is where the banner's evidence
 * lives exactly when the user needs it most.
 */
export function readBuild(result: InternalResult<StatusValue> | null): PanelBuild | null {
  if (result === null) return null
  const payload = result.ok ? asRecord(result.value) : asRecord(result.error)
  const raw = asRecord(payload?.['build'])
  if (raw === undefined) return null
  return {
    version: optionalString(raw['version']),
    build: optionalString(raw['build']),
    loadedAt: optionalString(raw['loadedAt']),
    staleLoadedCode: raw['staleLoadedCode'] === true,
    diskBuildTime: optionalString(raw['diskBuildTime']),
  }
}

/** The short form the panel shows: the `<sha>` half of `<sha>@<ISO>`. */
export function shortBuild(build: string | null): string | null {
  if (build === null || build === '') return null
  const separator = build.indexOf('@')
  return separator > 0 ? build.slice(0, separator) : build
}

/**
 * `2026-10-21 13:44:02` in the reader's own timezone.
 *
 * Fixed-width by hand rather than `toLocaleString`: the banner compares two
 * different days' worth of clock (a build from last night, a restart this
 * morning) and a locale-dependent format makes that comparison harder, not
 * easier. An unparseable stamp is shown as it arrived.
 */
export function describeBuildTime(iso: string | null): string {
  if (iso === null || iso === '' || iso === 'unknown') return UNKNOWN_BUILD_LABEL
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

/**
 * The banner text, or `null` when the loaded code is current.
 *
 * It states the evidence (two timestamps), the action (build, then FULLY quit and
 * restart) and the one thing that does NOT work (refresh) — because "refresh"
 * re-runs the same loaded generation, which is why the user is here in the first
 * place. The panel must never clear this on its own: only a restart makes the
 * process newer than the file.
 */
export function staleWarning(build: PanelBuild | null): string | null {
  if (build === null || build.staleLoadedCode !== true) return null
  return (
    `插件代码已更新（磁盘构建 ${describeBuildTime(build.diskBuildTime)} 晚于 DSH 启动 ${describeBuildTime(build.loadedAt)}）` +
    '→ 运行 `pnpm.cmd run build` 后完全退出并重启 DSH。刷新不会生效。'
  )
}

/** A panel tab. `available: false` renders disabled with its `note` as tooltip. */
export interface PanelTab {
  id: string
  label: string
  available: boolean
  note?: string
}

/**
 * The tabs the workbench shows.
 *
 * Five pages exist in this build: 章节 (the chapter tree + editor, issue #19),
 * 设定库 (issue #30 — the eight-kind tree, read-only detail and the problem panel),
 * 回收站 (issue #35 — the recovery bin, restore or purge), 伏笔 (issue #31 — the
 * read-only board: late / open / by linked entity) and 体检 (issue #33 — the five-family
 * consistency report with one-click export). 大纲 stays DISABLED with its release note:
 * a button that opens nothing is worse than a disabled one that says when it arrives.
 *
 * Four more rows are registered **disabled** by #180 (roadmap §2.4 「面板落点」): the
 * 0.5.0 pages that two or more issues each will land. They are rows here and not later
 * additions because the row order is this file's, not the feature's: four parallel
 * issues inserting themselves into one array is a merge conflict per rebase, while a
 * placeholder line is a one-word edit (`available: true`) nobody has to re-argue. The
 * note is the same contract as 大纲's — what the page will be, and when — so a user who
 * clicks nothing still learns something (X-12).
 */
export const PANEL_TABS: PanelTab[] = [
  { id: 'chapters', label: '章节', available: true },
  { id: 'library', label: '设定库', available: true },
  { id: 'outline', label: '大纲', available: false, note: '0.2.0 起' },
  { id: 'foreshadowing', label: '伏笔', available: true },
  { id: 'trash', label: '回收站', available: true },
  { id: 'audit', label: '体检', available: true },
  // Issue #38 (X-20): the extraction queue — the ONE tab this milestone adds. It is a
  // tab and not a section of the setting library because a candidate is not an entity:
  // it is a proposal waiting for a decision, and mixing "what is true" with "what might
  // become true" in one tree is how an author approves a duplicate by accident.
  { id: 'candidates', label: '候选', available: true },
  // 0.5.0 placeholders (#180). Each belongs to a page one of the B1/B2 issues lands:
  // `brief` #43 (nine segments + token share + what was trimmed), `gate` #44 (the seven
  // quality gates with evidence), `review` #46 (审稿意见 by chapter/paragraph/offset) and
  // `proposal` #45 (diff accepted or rejected piece by piece, then apply/roll back).
  { id: 'brief', label: '简报', available: false, note: '0.5.0 起 · 九段简报与裁剪记录' },
  { id: 'gate', label: '门禁', available: false, note: '0.5.0 起 · 七项门禁与逐条证据' },
  { id: 'review', label: '审稿', available: false, note: '0.5.0 起 · 审稿意见与证据链' },
  { id: 'proposal', label: '提案', available: false, note: '0.5.0 起 · 逐段接受与回滚' },
]

