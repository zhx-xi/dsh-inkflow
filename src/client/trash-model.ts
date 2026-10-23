/**
 * Pure view model for the recovery-bin page (#35).
 *
 * Same split as every other page in this plugin: the wording, the formatting and
 * the two-click purge decision are plain functions over plain data, so
 * `node --test` (no DOM) can pin them; `trash.tsx` keeps only state and markup.
 *
 * Nothing here formats a state the Host did not report, and nothing here decides
 * *whether* an action is allowed — the Host refuses (`RESTORE_TARGET_EXISTS`,
 * `CONFIRM_REQUIRED`, …) and this file only says what that refusal means in the
 * author's language. `describeTrashError` therefore never invents a success.
 *
 * `import type` only: this module must not pull the channel client
 * (`./internal.js`) into the bundle at import time, or the panel's first paint
 * would depend on a module whose whole job is `fetch`.
 */

import type { InternalError } from './internal.js'

/** One bin entry as `GET /trash` reports it. */
export interface TrashEntryView {
  id: string
  originalPath: string
  deletedAt: string
  bytes: number
  sha256?: string
  reason?: string
  trashPath?: string
  /** `false` when the copy is gone (hand-cleaned bin): the entry can still be purged. */
  present?: boolean
}

/** `GET /trash` → `value` (only the fields the page reads). */
export interface TrashValue {
  root?: string
  manifestPath?: string
  total?: number
  bytes?: number
  entries?: TrashEntryView[]
}

/** The list the page renders: never `undefined`, always in the Host's order. */
export interface TrashList {
  entries: TrashEntryView[]
  total: number
  bytes: number
}

/** Read the payload defensively: a Host that answers nothing is an empty bin. */
export function readTrashValue(value: TrashValue | undefined): TrashList {
  const entries = Array.isArray(value?.entries) ? value.entries : []
  return {
    entries,
    total: typeof value?.total === 'number' ? value.total : entries.length,
    bytes: typeof value?.bytes === 'number' ? value.bytes : entries.reduce((sum, entry) => sum + entry.bytes, 0),
  }
}

/**
 * A byte count in the one unit someone would say out loud.
 *
 * One decimal for the scaled units, none below 1 KB: "2.0 KB" and "999 B" both
 * read as sizes, while "2048 B" makes the reader do arithmetic.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(1)} ${units[index]}`
}

/** Why the file is in the bin, in words (unknown reasons are shown as they are). */
export function describeReason(reason: string | undefined): string {
  if (reason === undefined || reason === '') return '未知来源'
  if (reason === 'chapter_delete') return '删除章节'
  return reason
}

/** The three facts the row shows, already formatted. */
export function describeEntry(entry: TrashEntryView): { path: string; size: string; deletedAt: string; reason: string } {
  return {
    path: entry.originalPath,
    size: formatBytes(entry.bytes),
    deletedAt: entry.deletedAt === '' ? '—' : entry.deletedAt,
    reason: describeReason(entry.reason),
  }
}

/**
 * Why the 恢复 button cannot be pressed, or `null` when it can.
 *
 * Only the one reason the panel can know without asking the Host: the copy is
 * gone. An occupied target path is the Host's refusal to make (`409
 * RESTORE_TARGET_EXISTS`), because only it can look at the tree — the panel must
 * not guess that a path is free and offer a button that will fail.
 */
export function restoreBlockedReason(entry: TrashEntryView): string | null {
  if (entry.present === false) return '回收站里的副本已不在，无法恢复；可以彻底删除这条记录'
  return null
}

/** What a purge does, said plainly enough to be worth a second click. */
export function purgePrompt(entry: TrashEntryView): string {
  return `彻底删除 ${entry.originalPath}（${formatBytes(entry.bytes)}）？副本与这条记录都会被删除，之后无法从回收站恢复。`
}

/** Where a purge click stands: armed on the first, writing on the second. */
export type PurgeStage = 'armed' | 'confirmed'

/**
 * The two-click rule, as one decision.
 *
 * `pendingId` is what the panel remembers from the previous click; asking again
 * for the same entry is the confirmation. A different entry re-arms, so a stray
 * click on another row can never confirm the earlier one.
 */
export function purgeStage(pendingId: string | null, id: string): PurgeStage {
  return pendingId === id ? 'confirmed' : 'armed'
}

/** The bin's summary line: how many entries and how much they hold. */
export function describeTrashSummary(list: TrashList): string {
  if (list.total === 0) return '回收站是空的'
  return `${list.total} 个条目 · ${formatBytes(list.bytes)}`
}

const CODE_HINTS: Readonly<Record<string, string>> = {
  RESTORE_TARGET_EXISTS: '原路径已存在同名文件，回收站不会覆盖它。先移走或删除那个文件，再恢复。',
  TRASH_ENTRY_NOT_FOUND: '回收站里没有这个条目（可能已被恢复或彻底删除）。刷新列表看看。',
  TRASH_COPY_MISSING: '副本已经不在了，无法恢复；可以彻底删除这条记录。',
  TRASH_COPY_CHANGED: '副本内容与删除时的哈希不一致，恢复不了原来的字节。',
  TRASH_COPY_MISMATCH: '文件不是合法 UTF-8，无法做出字节一致的副本，所以没有删除它。',
  TRASH_RESTORE_MISMATCH: '恢复出来的字节与删除时不一致，已撤销这次写入。',
  TRASH_MANIFEST_INVALID: '回收站清单读不出来，已拒绝改动以免丢失记录。',
  CONFIRM_REQUIRED: '彻底删除需要再确认一次。',
  NO_SESSION_CONTEXT: '还没定位到这本书的会话，稍后再试。',
  'forbidden-origin': '这次请求不是本页面发出的，已拒绝。',
  'unsupported-media-type': '请求缺少 JSON 头，已拒绝。',
}

/**
 * One refusal, in the author's language.
 *
 * Falls back to the Host's own `message`, then to the code: a page that says
 * nothing about a refusal is worse than one that shows a code nobody likes.
 */
export function describeTrashError(error: InternalError | { code?: string; message?: string } | null | undefined): string {
  const code = error?.code ?? ''
  const known = CODE_HINTS[code]
  if (known !== undefined) return known
  const message = typeof error?.message === 'string' && error.message.trim() !== '' ? error.message : ''
  if (message !== '') return message
  if (code !== '') return `操作失败（${code}）`
  return '操作失败，但没有拿到原因'
}
