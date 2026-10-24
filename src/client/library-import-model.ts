/**
 * The import dialog's pure view model (issue #37, roadmap X-17 / X-20).
 *
 * No IO, no React: every decision the dialog makes (which step it is on, what the
 * preview says, which request body it sends, why a field is refused) is a function over
 * the payload the Host answered. That is what makes it testable without a DOM — the
 * project's other panel models (`library-model.ts`, `audit-model.ts`) follow the same
 * shape, and the component is only checked as a built bundle.
 *
 * WHY THE PATH IS TYPED AND NOT PICKED: the Client half has no file API — `uiWorkspace`
 * exposes `listDirectory`/`pickDirectory` and nothing that reads a file's contents, and
 * the import is about one *file*. So the author pastes a path, the Host reads it
 * (`import-channel.ts` explains why that request rides the write route's guards), and the
 * dialog never pretends to have browsed anything.
 *
 * THE THREE STEPS ARE THE SPEC (X-17: 预览=执行):
 *   `pick`    — the author names the file and the target; nothing has happened yet.
 *   `preview` — the Host's plan: encoding tier, line endings, chapters, counts. Closing
 *               the dialog here is zero writes *by construction* (the route is read-only).
 *   `done`    — the applied result, with the backup package it can be undone from.
 */

import type { InternalError } from './internal.js'
import type { ChaptersValue } from './panel-model.js'

/** Which step of the dialog is on screen. */
export type ImportStep = 'pick' | 'preview' | 'done'

/** What the author filled in before the preview exists. */
export interface ImportDraft {
  sourcePath: string
  /** `vol-NN`, or empty for loose chapters under `chapters/`. */
  volumeId: string
  keepOriginal: boolean
}

/** The draft a freshly opened dialog starts from. */
export function emptyDraft(): ImportDraft {
  return { sourcePath: '', volumeId: '', keepOriginal: true }
}

/** Chinese wording for the encoding tiers the Host reports (the codes stay on the wire). */
export const ENCODING_LABELS: Record<string, string> = {
  utf8: 'UTF-8',
  'utf8-bom': 'UTF-8（含 BOM）',
  'utf16le-bom': 'UTF-16LE（含 BOM）',
  'utf16be-bom': 'UTF-16BE（含 BOM）',
  gbk: 'GBK',
}

/** Chinese wording for the two line-ending styles. */
export const EOL_LABELS: Record<string, string> = {
  lf: 'LF',
  crlf: 'CRLF',
}

/** Chinese wording for the chapter-title shapes. */
export const PATTERN_LABELS: Record<string, string> = {
  numbered: '「第N章 / 第N回 …」',
  english: '「Chapter N …」',
  'cn-marker': '「一、二、 …」',
  'short-line': '短行独占',
  none: '未识别到分章',
}

/** One chapter as the preview lists it. */
export interface ImportPlanChapter {
  seq: number
  title: string
  paragraphs: number
  chars: number
  preface?: boolean
}

/** `POST /library/import {action:'plan'}` → `value` (only the fields the dialog reads). */
export interface ImportPlanValue {
  source?: {
    name?: string
    path?: string
    bytes?: number
    encoding?: string
    sniff?: string
    eol?: string
    bom?: boolean
  }
  chaptering?: boolean
  pattern?: string
  totals?: { chapters?: number; paragraphs?: number; chars?: number; lines?: number }
  target?: { volumeId?: string | null; volumeTitle?: string | null; dir?: string }
  chapters?: ImportPlanChapter[]
  library?: { keepOriginal?: boolean; path?: string | null; exists?: boolean; identical?: boolean }
  planToken?: string
  warnings?: string[]
}

/** `POST /library/import {action:'apply'}` → `value`. */
export interface ImportApplyValue extends Omit<ImportPlanValue, 'library'> {
  created?: Array<{ chapterId?: string; file?: string; seq?: number; title?: string; paragraphs?: number; chars?: number }>
  backup?: { dir?: string; sealed?: boolean; files?: number }
  /** On apply the field describes the copy that was written, not the plan for one. */
  library?:
    | { path?: string; written?: boolean; byteIdentical?: boolean; sourceBytes?: number; storedBytes?: number }
    | null
  indexRebuilt?: boolean
  indexError?: { code?: string; message?: string }
  ms?: number
}

/** A draft that cannot be sent yet, and where the dialog should put the message. */
export interface ImportDraftProblem {
  field: 'sourcePath'
  message: string
}

/**
 * One refusal as one readable line.
 *
 * The Host's codes and messages are already written for a human (`IMPORT_SOURCE_MISSING ·
 * no file at …`), so this joins them instead of translating them; the one thing it adds is
 * the rollback sentence, because "did it leave half a manuscript behind?" is the first
 * question after a failed import and the answer is in the payload.
 */
export function describeImportError(error: InternalError | undefined): string {
  const detail: InternalError = error ?? { code: 'IMPORT_FAILED' }
  const code = typeof detail['code'] === 'string' ? detail['code'] : 'IMPORT_FAILED'
  const message = typeof detail['message'] === 'string' ? detail['message'] : ''
  const hint = typeof detail['hint'] === 'string' ? detail['hint'] : ''
  const rolledBack =
    detail['rolledBack'] === true
      ? '（本批已回滚：书里的文件与导入前一致）'
      : detail['rolledBack'] === false
        ? '（回滚未完成：备份包还在 .inkflow/backup/）'
        : ''
  const head = [code, message].filter((part) => part !== '').join(' · ')
  return `${head}${rolledBack}${hint === '' ? '' : ` —— ${hint}`}`
}

/** `null` when the draft can be sent, otherwise the one problem worth fixing first. */
export function describeImportDraft(draft: ImportDraft): ImportDraftProblem | null {
  if (draft.sourcePath.trim() === '') {
    return {
      field: 'sourcePath',
      message: '先填旧稿的完整路径（.txt 或 .md）—— 面板不读文件，路径交给 Host 去读。',
    }
  }
  return null
}

/** The request body for both actions: one shape, so the two calls cannot drift. */
export function importRequestBody(
  draft: ImportDraft,
  action: 'plan' | 'apply',
  options: { planToken?: string; confirm?: boolean } = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    action,
    sourcePath: draft.sourcePath.trim(),
    keepOriginal: draft.keepOriginal,
  }
  const volumeId = draft.volumeId.trim()
  if (volumeId !== '') body['volumeId'] = volumeId
  if (options.planToken !== undefined) body['planToken'] = options.planToken
  if (options.confirm === true) body['confirm'] = true
  return body
}

/** A number with thin separators, so 600000 reads as a figure instead of a wall. */
function count(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-CN') : '?'
}

/**
 * The preview's headline: what the Host decided about the *bytes*.
 *
 * Spelled out rather than folded into one sentence because it is the answer to the
 * question an author actually has about an old draft ("did it read my file right?").
 */
export function describeImportSource(plan: ImportPlanValue | null): string {
  if (plan === null) return ''
  const source = plan.source ?? {}
  const encoding = typeof source.encoding === 'string' ? (ENCODING_LABELS[source.encoding] ?? source.encoding) : '?'
  const eol = typeof source.eol === 'string' ? (EOL_LABELS[source.eol] ?? source.eol) : '?'
  const name = typeof source.name === 'string' && source.name !== '' ? source.name : '（未命名）'
  return `${name} · ${encoding} · 原文行尾 ${eol} · ${count(source.bytes)} 字节`
}

/** The preview's second line: where the chapters go, and how many. */
export function describeImportTarget(plan: ImportPlanValue | null): string {
  if (plan === null) return ''
  const target = plan.target ?? {}
  const where =
    typeof target.volumeId === 'string' && target.volumeId !== ''
      ? `卷 ${target.volumeId}${typeof target.volumeTitle === 'string' && target.volumeTitle !== '' ? `（${target.volumeTitle}）` : ''}`
      : '书根（散章）'
  const totals = plan.totals ?? {}
  const pattern =
    typeof plan.pattern === 'string' ? (PATTERN_LABELS[plan.pattern] ?? plan.pattern) : '?'
  return `目标 ${where} · ${count(totals.chapters)} 章 / ${count(totals.paragraphs)} 段 / ${count(totals.chars)} 字 · 分章依据 ${pattern}`
}

/** The preview's warning lines: "nothing was split" and "short lines were used" live here. */
export function describeImportWarnings(plan: ImportPlanValue | null): string[] {
  if (plan === null) return []
  return Array.isArray(plan.warnings) ? plan.warnings.filter((line) => typeof line === 'string' && line !== '') : []
}

/** Why the dialog shows a "no chapters recognised" note instead of hiding it. */
export function importSplitNotice(plan: ImportPlanValue | null): string | null {
  if (plan === null || plan.chaptering !== false) return null
  return '这份稿子里没有识别到章标题：整篇会作为一章导入，正文不切分。想按章导入，先给每章加一行独立标题。'
}

/** One row per chapter, capped: a 200-chapter preview must not become the page. */
export interface ImportChapterRow {
  seq: string
  title: string
  detail: string
  preface: boolean
}

export const IMPORT_PREVIEW_ROWS = 40

export function importChapterRows(plan: ImportPlanValue | null, limit = IMPORT_PREVIEW_ROWS): ImportChapterRow[] {
  if (plan === null || !Array.isArray(plan.chapters)) return []
  return plan.chapters.slice(0, limit).map((chapter) => ({
    seq: String(chapter.seq).padStart(4, '0'),
    title: typeof chapter.title === 'string' ? chapter.title : '',
    detail: `${count(chapter.paragraphs)} 段 / ${count(chapter.chars)} 字`,
    preface: chapter.preface === true,
  }))
}

/** How many previewed chapters the row cap hid (0 when nothing was hidden). */
export function hiddenChapterCount(plan: ImportPlanValue | null, limit = IMPORT_PREVIEW_ROWS): number {
  const total = Array.isArray(plan?.chapters) ? plan.chapters.length : 0
  return total > limit ? total - limit : 0
}

/** What the original-file line says, including "it is already there". */
export function describeImportLibrary(plan: ImportPlanValue | null): string | null {
  if (plan === null) return null
  const library = plan.library ?? {}
  if (library.keepOriginal === false || library.path === null || library.path === undefined) {
    return '不保留原件：只导入章。'
  }
  if (library.identical === true) return `原件 ${library.path} 已存在且内容相同：不会重写。`
  return `原件登记到 ${library.path}（解码后的 UTF-8 文本；原件字节无法逐字过写门）`
}

/** The applied result's one-line summary, plus the package it can be undone from. */
export function describeImportResult(value: ImportApplyValue | null): string {
  if (value === null) return ''
  const created = Array.isArray(value.created) ? value.created.length : 0
  const backup = value.backup ?? {}
  const parts = [`已导入 ${count(created)} 章`]
  if (typeof backup.dir === 'string') parts.push(`备份包 ${backup.dir}`)
  if (typeof value.ms === 'number') parts.push(`${Math.round(value.ms)} ms`)
  if (value.indexRebuilt !== true) parts.push('索引未重建（下次读取会自动重建）')
  return parts.join(' · ')
}

/** The volumes the target picker offers: the book's own list, never a guess. */
export function importVolumeOptions(chapters: ChaptersValue | null): Array<{ volumeId: string; label: string }> {
  const out: Array<{ volumeId: string; label: string }> = []
  const volumes = chapters !== null && Array.isArray(chapters.volumes) ? chapters.volumes : []
  for (const volume of volumes) {
    const volumeId = typeof volume.volumeId === 'string' ? volume.volumeId : ''
    if (volumeId === '') continue
    const title = typeof volume.title === 'string' && volume.title !== '' ? volume.title : volumeId
    out.push({ volumeId, label: `${volumeId} ${title}` })
  }
  return out
}

/**
 * Where the dialog goes after a plan call.
 *
 * A failure keeps the author on the pick step with the Host's own message: the refusal
 * codes (`IMPORT_SOURCE_MISSING`, `IMPORT_TYPE_UNSUPPORTED`, `IMPORT_TOO_LARGE`, …) are
 * already written for a human, and inventing a second wording here would drift from them.
 */
export function stepAfterPlan(result: { ok: boolean }): ImportStep {
  return result.ok ? 'preview' : 'pick'
}

/** Whether the confirm button may write: a previewed plan with a token, nothing in flight. */
export function canApply(plan: ImportPlanValue | null, busy: boolean): boolean {
  if (busy || plan === null) return false
  return typeof plan.planToken === 'string' && plan.planToken !== ''
}
