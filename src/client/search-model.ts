/**
 * Pure view model for the panel's search box (issue #39, roadmap X-16/X-20).
 *
 * The panel gets **one** search box in the 章节 tab and a 「全部类型」 switch beside it,
 * not a new tab (X-20): searching the book is a way to read the chapter tab, not a
 * seventh place to look. This module holds everything about that box that can be
 * decided without a DOM — the request path, the wire shape, the wording, where a click
 * goes — so `node --test` can assert it (the React component is only checked as a built
 * bundle, see tests/panel-bundle.test.js).
 *
 * The wire shape is the Host's X-16 envelope, read defensively: the panel must render
 * *something* for a reply it half understands (an older/newer build on the other side),
 * so every field below has a defined fallback instead of throwing.
 */

/** One hit as the panel shows it — the X-16 entry, nothing more. */
export interface SearchHit {
  kind: string
  id: string
  path: string
  title: string
  snippet: string
}

/** One page of hits plus what the answer says about itself. */
export interface SearchPage {
  items: SearchHit[]
  total: number
  offset: number
  limit: number
  truncated: boolean
  /** `fts5` in this build; the field exists so a future backend needs no client change. */
  backend: string
  /** Set when the Host answered from a degraded path; shown as a note, never as an error. */
  degradedReason: string | null
}

/** What a click on a hit should do. */
export type SearchTarget =
  | { kind: 'chapter'; chapterId: string }
  | { kind: 'entity'; entityKind: string; id: string }

/** Where a hit goes when clicked: chapter prose opens in this tab, everything else in the library. */
export const SEARCH_TARGET_CHAPTER = 'chapters'

/** Chinese labels for the nine content directories — the panel speaks to the author. */
export const KIND_LABELS: Readonly<Record<string, string>> = {
  chapters: '章正文',
  characters: '角色',
  world: '世界观',
  outlines: '大纲',
  foreshadowing: '伏笔',
  timeline: '时间线',
  relations: '关系',
  facts: '账本',
  library: '资料',
}

/** A kind the panel does not know is shown as itself: a new directory must not read as blank. */
export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

/**
 * How many hits one page holds.
 *
 * The panel shows one page and no pager: a narrow column with a "next page" button asks
 * the author to page through a list they did not want. 50 is more than a person scans,
 * and `truncated` turns the summary into "narrow the query" instead of a lie.
 */
export const SEARCH_PAGE_LIMIT = 50

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * The request path for one search.
 *
 * `allKinds: false` sends `kinds=chapters`, which is the narrow question ("where is this
 * word in the manuscript"); `true` omits `kinds` and asks the whole book. Both are the
 * same route and the same result shape — the switch changes the scope, not the feature.
 */
export function searchRequestPath(query: string, allKinds: boolean, options: { offset?: number; limit?: number } = {}): string {
  const params: string[] = [`q=${encodeURIComponent(query.trim())}`]
  if (!allKinds) params.push('kinds=chapters')
  const limit = options.limit ?? SEARCH_PAGE_LIMIT
  params.push(`limit=${String(limit)}`)
  if (options.offset !== undefined && options.offset > 0) params.push(`offset=${String(options.offset)}`)
  return `/search?${params.join('&')}`
}

/** Read the Host's X-16 payload; anything unreadable becomes an empty page, never a crash. */
export function readSearchPage(value: unknown): SearchPage {
  const record = asRecord(value)
  if (record === undefined) return { items: [], total: 0, offset: 0, limit: SEARCH_PAGE_LIMIT, truncated: false, backend: 'fts5', degradedReason: null }
  const rawItems = Array.isArray(record['items']) ? record['items'] : []
  const items: SearchHit[] = []
  for (const raw of rawItems) {
    const item = asRecord(raw)
    if (item === undefined) continue
    const kind = text(item['kind'])
    const id = text(item['id'])
    // A hit the panel cannot address is not renderable: a click would go nowhere.
    if (kind === '' || id === '') continue
    items.push({
      kind,
      id,
      path: text(item['path']),
      title: text(item['title']) === '' ? id : text(item['title']),
      snippet: text(item['snippet']),
    })
  }
  return {
    items,
    total: count(record['total'], items.length),
    offset: count(record['offset'], 0),
    limit: count(record['limit'], SEARCH_PAGE_LIMIT),
    truncated: record['truncated'] === true,
    backend: text(record['searchBackend']) === '' ? 'fts5' : text(record['searchBackend']),
    degradedReason: text(record['degradedReason']) === '' ? null : text(record['degradedReason']),
  }
}

/** `章正文 · 第一章 云海初见` — the kind prefix is what makes a merged list readable. */
export function searchHitLabel(hit: SearchHit): string {
  return `${kindLabel(hit.kind)} · ${hit.title}`
}

/** Where a click goes: chapter prose to the editor, every entity to the setting library. */
export function searchHitTarget(hit: SearchHit): SearchTarget {
  return hit.kind === SEARCH_TARGET_CHAPTER
    ? { kind: 'chapter', chapterId: hit.id }
    : { kind: 'entity', entityKind: hit.kind, id: hit.id }
}

/**
 * The one-line summary above the list: what was asked, how much there is, which page.
 *
 * It states the backend only when it is not the default, because "fts5" is the product's
 * own answer and naming it on every search is noise; a degraded answer is named always.
 */
export function describeSearchPage(page: SearchPage, query: string, allKinds: boolean): string {
  const scope = allKinds ? '全部类型' : '仅章正文'
  if (page.items.length === 0) {
    return page.total === 0 ? `「${query}」没有命中（${scope}）。` : `「${query}」这一页没有命中（${scope}）。`
  }
  const from = page.offset + 1
  const to = page.offset + page.items.length
  const range = page.total > page.items.length ? `，显示 ${from}–${to} 条` : ''
  const more = page.truncated ? '，只显示前几页：把关键词写长一点，或切到「仅章正文」' : ''
  const backend = page.backend === 'fts5' ? '' : ` · ${page.backend}`
  return `「${query}」命中 ${page.total} 条（${scope}${backend}${range}${more}）。`
}

/** The degraded-answer note, or `null` when the Host answered normally. */
export function describeSearchDegradation(page: SearchPage): string | null {
  return page.degradedReason === null ? null : `降级结果：${page.degradedReason}`
}

/** How many pages a total needs — kept for callers that add a pager later. */
export function hasNextPage(page: SearchPage): boolean {
  return page.truncated && page.offset + page.items.length < page.total
}

/** Where a click lands, as the sentence under the list explains it. */
export const SEARCH_HINT = '点章正文条目在右侧打开；点设定条目会跳到「设定库」并选中它。'
