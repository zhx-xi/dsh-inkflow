/**
 * The unified search and the search-replace batch on the private channel.
 *
 * Scope: `GET /inkflow/internal/search` (X-16's single entry), `GET /inkflow/internal/replace`
 * (the preview) and `POST /inkflow/internal/replace/apply` (the batch). Everything about
 * *what* a search or a replace means lives in `search.ts` / `replace.ts`; this file only
 * turns their structured results into the wire shape and an HTTP status vocabulary, exactly
 * like `audit-channel.ts` does for the audit report.
 *
 * Three request rules, stated once here so the route table stays declarative:
 *
 *   * **the search route refreshes the cache first.** It is a read over the derived index,
 *     so it calls `ensureIndex` like `/chapters`, `/search` and `/foreshadow`; `indexRebuilt`
 *     / `indexState` travel back so the panel never has to guess.
 *   * **the replace preview writes nothing at all** — no index refresh either, because a
 *     preview is a question and a cache rebuild during a question is a write. It reads the
 *     chapter files through the catalog, which is a projection of the files themselves.
 *   * **apply needs `confirm: true` and the preview's `expected` set.** `false`/absent is
 *     `CONFIRM_REQUIRED` (400) with zero writes, and a stale set is reported per file rather
 *     than applied.
 *
 * Why a separate module: `internal.ts` is ~1100 lines (AGENTS.md §10.5) and `routes.ts` is
 * the single dispatch table, so the handlers live here and the table imports them directly.
 */

import type { ContentDir } from './conventions.js'
import { ensureIndex } from './index-freshness.js'
import type { EnsureIndexResult } from './index-freshness.js'
import { replaceApply, replacePreview } from './replace.js'
import { searchEntries } from './search.js'

type JsonRecord = Record<string, unknown>

/** What these projections need from the resolved channel target. */
export interface SearchSource {
  sessionId: string
  root: string
}

export interface SearchReply {
  status: number
  body: JsonRecord
}

/** HTTP status per refusal; anything unlisted answers 500 and keeps the domain code. */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  QUERY_INVALID: 400,
  KIND_INVALID: 400,
  CONFIRM_REQUIRED: 400,
  EXPECTED_REQUIRED: 400,
  NO_SESSION_CONTEXT: 200,
  INDEX_UNAVAILABLE: 200,
  PATH_NOT_WRITABLE: 409,
  PATH_OUT_OF_SCOPE: 409,
  IO_FAILED: 409,
  CHAPTER_UNREADABLE: 409,
}

function ok(value: JsonRecord): SearchReply {
  return { status: 200, body: { ok: true, value } }
}

function refused(status: number, code: string, extra: JsonRecord = {}): SearchReply {
  return { status, body: { ok: false, error: { code, ...extra } } }
}

function statusOf(code: string): number {
  return STATUS_BY_CODE[code] ?? 500
}

/** What the cache looked like after the refresh, in the shape the other read routes send. */
function indexStateOf(ensured: EnsureIndexResult): JsonRecord {
  if (ensured.ok) return { indexRebuilt: ensured.rebuilt, indexState: ensured.state }
  return {
    indexRebuilt: false,
    indexState: ensured.state,
    indexError: { code: ensured.failure.code, errno: ensured.failure.errno, message: ensured.failure.message },
    indexReasons: ensured.freshness.reasons,
  }
}

/** `?kinds=characters,world` and `?kinds=characters&kinds=world` both work; empty means all. */
function kindsOf(raw: readonly string[]): string[] | undefined {
  const kinds = raw.flatMap((value) => value.split(',')).map((value) => value.trim()).filter((value) => value !== '')
  return kinds.length === 0 ? undefined : kinds
}

function numberParam(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

export interface SearchAllInput {
  query: string
  kinds?: readonly string[]
  offset?: number
  limit?: number
}

/**
 * `GET /search`: the one search entry over every kind (X-16).
 *
 * An unusable index is *data*, not a transport failure: the reply is HTTP 200 with
 * `ok:false` + `INDEX_UNAVAILABLE`, so the panel can offer a rebuild instead of showing a
 * broken page. That is the same "no 500" rule the chapter search obeys.
 */
export async function buildSearchAll(source: SearchSource, version: string, input: SearchAllInput): Promise<SearchReply> {
  const query = input.query.trim()
  if (query === '') {
    return refused(400, 'QUERY_REQUIRED', { param: 'q', hint: 'pass ?q=<text> to search the book' })
  }
  const ensured = await ensureIndex(source.root)
  const result = searchEntries(source.root, query, {
    ...(input.kinds === undefined ? {} : { kinds: input.kinds }),
    ...(input.offset === undefined ? {} : { offset: input.offset }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  })
  const base = {
    pluginVersion: version,
    sessionId: source.sessionId,
    root: source.root,
    query,
    ...indexStateOf(ensured),
  }
  if (!result.ok) {
    return { status: 200, body: { ok: false, error: { ...base, code: result.code, message: result.message, hint: result.hint } } }
  }
  return ok({
    ...base,
    searchBackend: result.searchBackend,
    ...(result.degradedReason === undefined ? {} : { degradedReason: result.degradedReason }),
    mode: result.mode,
    offset: result.offset,
    limit: result.limit,
    total: result.total,
    truncated: result.truncated,
    items: result.items,
  })
}

/** The query string of `GET /search`, decoded and split. Lives here so the route stays thin. */
export function searchAllFromQuery(query: URLSearchParams): SearchAllInput {
  const kinds = query.getAll('kinds')
  return {
    query: query.get('q') ?? '',
    ...(kinds.length === 0 ? {} : { kinds: kindsOf(kinds) }),
    ...(numberParam(query.get('offset')) === undefined ? {} : { offset: numberParam(query.get('offset')) }),
    ...(numberParam(query.get('limit')) === undefined ? {} : { limit: numberParam(query.get('limit')) }),
  }
}

/**
 * `GET /replace`: what a batch *would* change. Zero writes — not even `.inkflow/`.
 *
 * The reply carries the exact `expected` set an apply must send back, so the panel's
 * "apply" button cannot invent one.
 */
export function replacePreviewReply(source: SearchSource, version: string, input: { query: string; replacement: string }): SearchReply {
  const preview = replacePreview(source.root, { query: input.query, replacement: input.replacement })
  if (!preview.ok) {
    return refused(statusOf(preview.code), preview.code, {
      message: preview.message,
      ...(preview.hint === undefined ? {} : { hint: preview.hint }),
      ...(preview.path === undefined ? {} : { path: preview.path }),
    })
  }
  return ok({
    pluginVersion: version,
    sessionId: source.sessionId,
    root: source.root,
    query: preview.query,
    replacement: preview.replacement,
    kinds: preview.kinds,
    total: preview.total,
    items: preview.items,
    expected: preview.items.map((item) => ({ chapterId: item.chapterId, count: item.count })),
  })
}

/** The body fields `POST /replace/apply` may carry (`sessionId` is always allowed). */
export const REPLACE_APPLY_BODY_FIELDS = ['query', 'replacement', 'expected', 'confirm'] as const

function expectationsOf(raw: unknown): { chapterId: string; count: number }[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: { chapterId: string; count: number }[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return undefined
    const record = item as JsonRecord
    const chapterId = record['chapterId']
    const count = record['count']
    if (typeof chapterId !== 'string' || chapterId === '') return undefined
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return undefined
    out.push({ chapterId, count })
  }
  return out
}

/**
 * `POST /replace/apply`: the batch, behind its rollback package.
 *
 * A write route, so it carries every write guard the dispatcher applies plus `confirm: true`
 * here. The reply names the package whether the batch succeeded or rolled back: the undo
 * address is the one thing the author needs and the one thing that must never be inferred.
 */
export function replaceApplyReply(source: SearchSource, version: string, body: JsonRecord): SearchReply {
  const query = typeof body['query'] === 'string' ? body['query'] : ''
  const replacement = typeof body['replacement'] === 'string' ? body['replacement'] : ''
  if (body['confirm'] !== undefined && typeof body['confirm'] !== 'boolean') {
    return refused(400, 'invalid-field', { field: 'confirm', hint: '`confirm` must be `true` (or absent, which is a refusal)' })
  }
  const expected = expectationsOf(body['expected'])
  if (expected === undefined) {
    return refused(400, 'EXPECTED_REQUIRED', {
      hint: 'pass the preview’s `expected` array ([{ chapterId, count }]); a batch never guesses what it is replacing',
    })
  }
  const applied = replaceApply(source.root, { query, replacement, expected, confirm: body['confirm'] === true })
  const common = {
    pluginVersion: version,
    sessionId: source.sessionId,
    root: source.root,
    query,
    replacement,
    ...(applied.backup === undefined ? {} : { backup: applied.backup }),
    ...(applied.written === undefined ? {} : { written: applied.written }),
    ...(applied.skipped === undefined ? {} : { skipped: applied.skipped }),
    ...(applied.rolledBack === undefined ? {} : { rolledBack: applied.rolledBack }),
  }
  if (!applied.ok) {
    return {
      status: statusOf(applied.code),
      body: {
        ok: false,
        error: {
          ...common,
          code: applied.code,
          message: applied.message,
          ...(applied.hint === undefined ? {} : { hint: applied.hint }),
        },
      },
    }
  }
  return ok({ ...common, replaced: applied.replaced })
}

/** Re-exported so the route table and the tests name the same kind union. */
export type SearchAllKind = ContentDir
