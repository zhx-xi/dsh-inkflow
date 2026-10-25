/**
 * The impact dialog's view model (conventions §5.6, ADR-0014).
 *
 * Split from `library-model.ts` rather than appended to it. That is **not** a
 * line-count fix: `library-model.ts` was already past the 600-line guideline
 * (AGENTS.md §10.5) before this dialog existed, and it still is. The reason is that
 * this half answers a different question — "what would this change touch" — with
 * its own wire shape (`GET /impact`); putting it beside the tree, the problem panel
 * and the entry editor would make two unrelated contracts share one file. Two
 * models, one rule: everything here is a plain function over plain data, so
 * `node --test` covers the dialog wording without a DOM, and the client half still
 * does no file IO (ADR-0008 D4).
 */

import type { InternalError } from './internal.js'
import { asRecord, optionalString } from './library-model.js'
import type { LibraryFingerprint } from './library-model.js'

// ---------------------------------------------------------------------------
// The impact dialog (conventions §5.6)
//
// 改设定 is the one action whose cost is invisible until later, so the dialog has
// to do two jobs and nothing else: show what the change would touch (this half),
// and send exactly one write after the author confirms (see `renamePayload`).
//
// The Host answers five sections; this half only decides how they read. The same
// rule as the rest of the file: pure functions over plain data, so `node --test`
// covers the wording without a DOM.
// ---------------------------------------------------------------------------

/** One chapter that names the entity (`GET /impact` → `chapters[]`). */
export interface ImpactChapter {
  chapterId: string
  title: string
  seq: number | null
  path: string
  mentions: number
  firstOffset: number | null
}

export interface ImpactRelationItem {
  id: string
  path: string
  title: string
  role: string
  other: string
}

export interface ImpactEventItem {
  id: string
  path: string
  title: string
  role: string
}

export interface ImpactFactItem {
  path: string
  title: string
  subject: string
  lines: number
}

export interface ImpactForeshadowItem {
  path: string
  id: string
  title: string
  status: string | null
}

export interface ImpactTotals {
  chapters: number
  mentions: number
  relations: number
  events: number
  facts: number
  foreshadowing: number
  total: number
}

/** What a rename *would* do — computed by the Host listing, never by the panel. */
export interface ImpactRenamePlan {
  from: string
  to: string
  slug: string
  title: string | null
  pinId: string
  targetExists: boolean
  blockers: string[]
}

/** `GET /inkflow/internal/impact` → `value` (only what the dialog reads). */
export interface ImpactValue {
  kind?: string
  id?: string
  path?: string
  title?: string
  pinnedId?: boolean
  chapters?: unknown[]
  relations?: unknown[]
  events?: unknown[]
  facts?: unknown[]
  foreshadowing?: unknown[]
  totals?: Partial<ImpactTotals>
  fingerprint?: LibraryFingerprint | null
  indexAvailable?: boolean
  indexState?: string
  rename?: ImpactRenamePlan
}

export interface ImpactDigestGroup {
  key: string
  label: string
  /** How many rows this section lists (occurrences are inside the row text). */
  total: number
  rows: string[]
}

export interface ImpactDigest {
  available: boolean
  /** `2 章提到 · 共 9 处引用` — the line the dialog leads with. */
  headline: string
  groups: ImpactDigestGroup[]
  /** Why the list may be incomplete (`索引不可用` / `索引落后`), or `null`. */
  notice: string | null
  /** `true` when the book really does not reference the entry anywhere. */
  empty: boolean
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function totalsOf(value: ImpactValue): ImpactTotals {
  const totals = value.totals ?? {}
  return {
    chapters: numberOr(totals.chapters),
    mentions: numberOr(totals.mentions),
    relations: numberOr(totals.relations),
    events: numberOr(totals.events),
    facts: numberOr(totals.facts),
    foreshadowing: numberOr(totals.foreshadowing),
    total: numberOr(totals.total),
  }
}

const EVENT_ROLE_LABELS: Record<string, string> = {
  participant: '参与',
  place: '地点',
  both: '参与并作为地点',
}

const RELATION_ROLE_LABELS: Record<string, string> = {
  source: '起点',
  target: '终点',
  both: '两端',
}

function chapterLine(raw: unknown): string | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const id = optionalString(record['chapterId'])
  if (id === null) return undefined
  const seq = typeof record['seq'] === 'number' ? record['seq'] : null
  const title = optionalString(record['title']) ?? id
  const mentions = numberOr(record['mentions'])
  // Real books title their chapters `第3章 清音报信`, so prefixing the number again
  // would print "第 3 章 第3章 清音报信". A title that already carries it wins.
  const numbered = /^第\s*[0-9一二三四五六七八九十百千零〇两]+\s*章/u.test(title)
  const head = numbered ? title : `第 ${seq === null ? id : String(seq)} 章 ${title}`
  return `${head} · ${String(mentions)} 处`
}

function relationLine(raw: unknown): string | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const other = optionalString(record['other']) ?? optionalString(record['path'])
  if (other === null) return undefined
  const title = optionalString(record['title'])
  const role = RELATION_ROLE_LABELS[optionalString(record['role']) ?? ''] ?? '端点'
  return `${title ?? other} · ${role}`
}

function eventLine(raw: unknown): string | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const title = optionalString(record['title'])
  if (title === null) return undefined
  const role = EVENT_ROLE_LABELS[optionalString(record['role']) ?? ''] ?? '引用'
  return `${title} · ${role}`
}

function factLine(raw: unknown): string | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const title = optionalString(record['title']) ?? optionalString(record['path'])
  if (title === null) return undefined
  return `${title} · ${String(numberOr(record['lines']))} 条事实`
}

function foreshadowLine(raw: unknown): string | undefined {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const title = optionalString(record['title'])
  if (title === null) return undefined
  const status = optionalString(record['status'])
  return status === null ? title : `${title} · ${status}`
}

function linesOf(value: unknown, render: (raw: unknown) => string | undefined): string[] {
  if (!Array.isArray(value)) return []
  const rows: string[] = []
  for (const raw of value) {
    const line = render(raw)
    if (line !== undefined) rows.push(line)
  }
  return rows
}

/**
 * The report → the dialog's rows.
 *
 * Five groups always, in the order the five reference sites matter to a rename:
 * the manuscript first (that is what hurts), then the graph, then the three
 * file-only sites. Keeping an empty group visible ("关系 0") is the point: the
 * author's question is "what is *not* at risk", and a section that vanishes reads
 * as "we did not check".
 */
export function buildImpactDigest(value: ImpactValue | null): ImpactDigest {
  if (value === null) {
    return {
      available: false,
      headline: '',
      groups: [],
      notice: '影响面没有返回内容（面板内部错误）。',
      empty: false,
    }
  }
  const available = value.indexAvailable !== false
  const state = optionalString(value.indexState) ?? ''
  const totals = totalsOf(value)

  const groups: ImpactDigestGroup[] = [
    { key: 'chapters', label: '提及章', total: 0, rows: linesOf(value.chapters, chapterLine) },
    { key: 'relations', label: '关系', total: 0, rows: linesOf(value.relations, relationLine) },
    { key: 'events', label: '时间线', total: 0, rows: linesOf(value.events, eventLine) },
    { key: 'facts', label: '账本', total: 0, rows: linesOf(value.facts, factLine) },
    { key: 'foreshadowing', label: '伏笔', total: 0, rows: linesOf(value.foreshadowing, foreshadowLine) },
  ]
  for (const group of groups) group.total = group.rows.length

  const notice = !available
    ? `派生索引不可用（${state === '' ? 'INDEX_UNAVAILABLE' : state}）：提及章与关系现在无法回答——这不是「没有提及」，先重建索引再看影响面。`
    : state === 'stale'
      ? '派生索引落后于磁盘：下面的清单可能不是最新的，重建索引后再确认改名。'
      : null

  return {
    available,
    headline: `${String(totals.chapters)} 章提到 · 共 ${String(totals.total)} 处引用`,
    groups,
    notice,
    empty: available && totals.total === 0,
  }
}

/** The query string the dialog sends: an entity address, never a path. */
export function impactQuery(kind: string, id: string): string {
  return `/impact?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`
}

export interface RenameInput {
  kind: string
  id: string
  slug?: string
  title?: string
  fingerprint: LibraryFingerprint | null
}

/**
 * `POST /impact/rename`'s body — and `null` when there is nothing to send.
 *
 * `null` covers two cases the dialog must refuse *before* the round trip: no
 * baseline (a rename without one could overwrite a file the author just edited),
 * and no change (neither a new file name nor a new title).
 */
export function renamePayload(input: RenameInput): Record<string, unknown> | null {
  const slug = (input.slug ?? '').trim()
  const title = (input.title ?? '').trim()
  if (slug === '' && title === '') return null
  if (input.fingerprint === null) return null
  const body: Record<string, unknown> = { kind: input.kind, id: input.id }
  if (slug !== '') body['slug'] = slug
  if (title !== '') body['title'] = title
  body['expected'] = { sha256: input.fingerprint.sha256, size: input.fingerprint.size, mtimeMs: input.fingerprint.mtimeMs }
  return body
}

/** Message for a failed impact listing: the Host's own words beat a bare code. */
export function describeImpactError(error: InternalError | undefined): string {
  if (error === undefined) return '影响面没有返回内容'
  if (error.code === 'impact-entity-not-found') return '这一条在目录里找不到了：可能已被删除或改名（刷新后重查）。'
  if (error.code === 'TITLE_AMBIGUOUS') return '这个名字匹配到多条：用左栏点开具体那一条再看影响面。'
  if (error.code === 'SELECTOR_REQUIRED') return '影响面请求没带条目地址（面板内部错误）。'
  return error.message ?? error.code
}

/** Message for a refused rename: every code gets an actionable next step. */
export function describeRenameError(error: InternalError | undefined): string {
  if (error === undefined) return '改名没有返回内容'
  if (error.code === 'TARGET_EXISTS') {
    return '同一个目录里已经有这个文件名（目标已存在）：换一个名字，或先处理那一条。这次没有写入任何文件。'
  }
  if (error.code === 'FILE_CHANGED') {
    return '文件已被改动：磁盘上的内容已经不是影响清单里那一版，所以这次没有写入任何字节。重新打开再改名。'
  }
  if (error.code === 'KIND_NOT_RENAMEABLE') return '这一类不能改名：它的文件名就是它的主体（账本口径还没定），改名等于改它说的事。'
  if (error.code === 'SLUG_INVALID') {
    return '这个文件名不能用：不能以点开头（扫描会跳过点开头的条目，写进去就找不回来了），不能含路径分隔符或控制字符，也不能用 con / nul / COM1 这类 Windows 保留名。'
  }
  if (error.code === 'TITLE_INVALID') return '显示名不能换行：frontmatter 里一个名字只占一行。'
  if (error.code === 'RENAME_NO_CHANGE') return '新名字和现在一样，没有可写的内容。'
  if (error.code === 'EXPECTED_REQUIRED') return '改名缺少基线指纹（面板内部错误），重新打开这一条再试。'
  if (error.code === 'EXPECTED_INVALID') return '基线指纹格式不对（面板内部错误），重新打开这一条再试。'
  if (error.code === 'impact-entity-not-found') return '这一条在目录里找不到了：刷新后重查。'
  return error.message ?? error.code
}

