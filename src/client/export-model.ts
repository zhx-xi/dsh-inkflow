/**
 * The export entry's pure view model (#195, ADR-0024, roadmap X-20).
 *
 * Same reason as `hub-model.ts`: `node --test` has no DOM, so every decision the export card
 * makes — which axes exist, what a refusal means in words, what a finished export reads like —
 * lives here as a plain function over plain data and is asserted directly, while
 * `hub-export.tsx` only arranges it.
 *
 * TWO RULES THAT SHAPE THIS FILE:
 *
 *   1. The vocabularies are the Host's. `EXPORT_FORMATS` / `EXPORT_TARGETS` / `EXPORT_STATUSES`
 *      are re-declared here only because the Client cannot import the Host half; they are
 *      served to the page by `GET /hub/export/options`, and `tests/hub-export.test.js` asserts
 *      these three lists equal `export.ts`'s. A page that offered `pdf` would be a second,
 *      wrong answer to "what can this plugin export".
 *   2. A refusal is a sentence, never a code. The Host answers `EXPORT_EMPTY`,
 *      `EXPORT_SELECTION_UNUSED`, `BOOK_NOT_USABLE`…, all of which a person can act on once
 *      somebody says what they mean. `describeExportError` is the only place that says it.
 */

import type { InternalError, InternalResult } from './internal.js'

/** The four formats, in the order the tool's description lists them. */
export const EXPORT_FORMATS = ['epub', 'docx', 'markdown', 'txt'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export const EXPORT_FORMAT_LABELS: Readonly<Record<ExportFormat, string>> = {
  epub: 'EPUB（手机 / 阅读器）',
  docx: 'DOCX（Word）',
  markdown: 'Markdown（一份 .md）',
  txt: '纯文本（.txt）',
}

/** What gets exported. `volume` is a scope, `status` is a filter across volumes (not mixable). */
export const EXPORT_TARGETS = ['book', 'volume', 'status'] as const
export type ExportTarget = (typeof EXPORT_TARGETS)[number]

export const EXPORT_TARGET_LABELS: Readonly<Record<ExportTarget, string>> = {
  book: '整本',
  volume: '某一卷',
  status: '按章节状态筛',
}

/** Chapter statuses (ADR-0016's frontmatter `status`), in the order the gate names them. */
export const EXPORT_STATUSES = ['draft', 'revised', 'final'] as const
export type ExportStatus = (typeof EXPORT_STATUSES)[number]

export const EXPORT_STATUS_LABELS: Readonly<Record<ExportStatus, string>> = {
  draft: '草稿',
  revised: '修订稿',
  final: '定稿',
}

/** The page's visible words, so the component above holds none of them. */
export const EXPORT_TEXTS = {
  title: '导出',
  button: '导出',
  hint: '导出物落在插件自己的目录，不写进书：git status 保持干净，随时可删、随时可重算。',
  book: '哪本书',
  format: '格式',
  target: '范围',
  volume: '哪一卷',
  status: '哪个状态',
  run: '开始导出',
  running: '导出中…',
  close: '关闭',
  loading: '正在读取这本书的卷目…',
  noBook: '还没有可导出的书：先把一本修到「可用」，再回来导出。',
  openDir: '打开所在目录：在文件管理器里粘贴下面这个路径（面板没有文件系统权限，不代你打开）。',
  statusHint: '按状态筛会跨卷，所以打的是一卷一个文件的 zip。',
} as const

/** One export request as the page composes it: only the axes the current target reads. */
export interface ExportSelection {
  format: ExportFormat
  target: ExportTarget
  volumeId?: string
  status?: string
}

/** The body `POST /hub/export` accepts — `HUB_EXPORT_BODY_FIELDS`, in that order. */
export interface ExportBody {
  book: string
  format: ExportFormat
  target: ExportTarget
  volumeId?: string
  status?: string
}

/**
 * The request body, or `null` when there is no book to export.
 *
 * Why both axes travel even when the target does not read them: the Host refuses a mixed
 * selection with `EXPORT_SELECTION_UNUSED` and names the parameter to drop (#50). Dropping it
 * here instead would silently answer a different question than the one the user asked, and the
 * page would look like it had "fixed" the request. The component clears the unused axis when
 * the target changes, so a person never gets there by clicking.
 */
export function buildExportBody(book: string | null | undefined, selection: ExportSelection): ExportBody | null {
  const target = typeof book === 'string' ? book.trim() : ''
  if (target === '') return null
  const volumeId = typeof selection.volumeId === 'string' ? selection.volumeId.trim() : ''
  const status = typeof selection.status === 'string' ? selection.status.trim() : ''
  return {
    book: target,
    format: selection.format,
    target: selection.target,
    ...(volumeId === '' ? {} : { volumeId }),
    ...(status === '' ? {} : { status }),
  }
}

// ---------------------------------------------------------------------------
// The read half: what this book can be exported as
// ---------------------------------------------------------------------------

export interface ExportVolumeOption {
  volumeId?: string
  title?: string
  chapters?: number
}

/** `GET /hub/export/options` → `value`. */
export interface ExportOptionsValue {
  volumes?: ExportVolumeOption[]
  formats?: string[]
  targets?: string[]
  statuses?: string[]
  exportsDir?: string
}

export type ExportOptionsState =
  | { status: 'ready'; volumes: ExportVolumeOption[]; exportsDir: string | null }
  | { status: 'error'; message: string }

export function readExportOptions(result: InternalResult<ExportOptionsValue>): ExportOptionsState {
  if (!result.ok || result.value === undefined) {
    return { status: 'error', message: describeExportError(result.error) }
  }
  const volumes = Array.isArray(result.value.volumes) ? result.value.volumes : []
  const dir = typeof result.value.exportsDir === 'string' && result.value.exportsDir.trim() !== '' ? result.value.exportsDir : null
  return { status: 'ready', volumes, exportsDir: dir }
}

// ---------------------------------------------------------------------------
// The write half: what came back
// ---------------------------------------------------------------------------

/** `POST /hub/export` → `value` (a subset of `export.ts`'s `ExportValue`). */
export interface ExportDoneValue {
  file?: string
  path?: string
  dir?: string
  bytes?: number
  chapters?: number
  volumes?: number
  format?: string
  target?: string
  container?: string
}

export type ExportDoneState = { status: 'done'; message: string } | { status: 'error'; message: string }

export function readExportDone(result: InternalResult<ExportDoneValue>): ExportDoneState {
  if (!result.ok || result.value === undefined) return { status: 'error', message: describeExportError(result.error) }
  return { status: 'done', message: describeExportValue(result.value) }
}

/** The one sentence a finished export earns: the file, its size, and where it landed. */
export function describeExportValue(value: ExportDoneValue): string {
  const file = typeof value.file === 'string' && value.file.trim() !== '' ? value.file : '（未命名文件）'
  const dir = typeof value.dir === 'string' && value.dir.trim() !== '' ? value.dir : ''
  const chapters = typeof value.chapters === 'number' ? `${String(value.chapters)} 章` : ''
  const volumes = typeof value.volumes === 'number' && value.volumes > 0 ? `${String(value.volumes)} 卷` : ''
  const size = typeof value.bytes === 'number' ? `${formatBytes(value.bytes)}` : ''
  const scope = [volumes, chapters].filter((part) => part !== '').join(' · ')
  const details = [scope, size].filter((part) => part !== '').join('，')
  const head = `已导出 ${file}${details === '' ? '' : `（${details}）`}`
  return dir === '' ? head : `${head} → ${dir}`
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// Refusals, in words
// ---------------------------------------------------------------------------

/**
 * What each code means, in one sentence, plus what to do about it.
 *
 * The point is that the author never reads `EXPORT_EMPTY` on screen: a code is for the log.
 * Codes not listed fall through to the Host's own message with the code in front, so a newer
 * Host does not produce a blank card.
 */
export const EXPORT_ERROR_HINTS: Readonly<Record<string, string>> = {
  EXPORT_EMPTY: '没有可导出的章节（书是空的，或这个筛选一条都没命中）——一个文件都没写',
  EXPORT_FORMAT_INVALID: '不认识的格式：只有 EPUB / DOCX / Markdown / 纯文本 四种',
  EXPORT_TARGET_INVALID: '不认识的范围：只能整本、某一卷，或按状态筛',
  EXPORT_VOLUME_REQUIRED: '选了「某一卷」但没选哪一卷',
  EXPORT_VOLUME_UNKNOWN: '这本书里没有那一卷（刷新一次，卷可能被删了或改名了）',
  EXPORT_STATUS_REQUIRED: '选了「按状态筛」但没选状态',
  EXPORT_STATUS_INVALID: '不认识的状态：只有草稿 / 修订稿 / 定稿',
  EXPORT_SELECTION_UNUSED: '两条选择轴不能混用：卷是范围、状态是跨卷筛选，留一条就行——一个文件都没写',
  EXPORT_CHAPTER_UNREADABLE: '有一章的正文读不出来：先让 AI 跑一次 inkflow_index_rebuild，再导出',
  EXPORT_DATA_DIR_INSIDE_BOOK: '插件的数据目录在这本书里面，导出物会落进书里；把数据目录挪到书外再导出',
  EXPORT_SELFCHECK_FAILED: '导出的包没通过自检，插件没写盘（这是插件的 bug，把这份报告贴给开发者）',
  EXPORT_WRITE_FAILED: '文件写不下去：检查磁盘空间与插件数据目录的权限——书里一个字节都没动',
  BOOK_REQUIRED: '没有指定要导出哪本书',
  BOOK_NOT_REGISTERED: '这本书不在书库里：面板只能导出你已经打开成工作区的书',
  BOOK_NOT_USABLE: '这本书还没准备好（门禁不是「可用」）：先在书库里把它修好，再导出',
  HUB_UNAVAILABLE: '这个 DSH 没有工作区注册表，导出页读不到书单',
  CONFIRM_REQUIRED: '这一步需要确认（面板自己的按钮）',
  'fetch-failed': '导出通道请求失败：检查 DSH 与插件的连接',
  'not-found': '这个版本的 Host 还没有导出路由：先更新插件并重启 DSH',
}

/** A refusal as a sentence. Never throws, never renders an `undefined`. */
export function describeExportError(error: InternalError | undefined): string {
  if (error === undefined) return '导出没有跑成，通道也没有给出原因（没有返回内容）'
  const hint = EXPORT_ERROR_HINTS[error.code]
  if (hint !== undefined) return hint
  const message = typeof error.message === 'string' && error.message.trim() !== '' ? error.message.trim() : '未知错误'
  return `${error.code}：${message}`
}
