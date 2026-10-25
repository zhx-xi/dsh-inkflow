/**
 * Search built-in tools (split out of `tools.ts`): chapter-prose search
 * (`inkflow_chapter_search`), the single all-kind entry point (`inkflow_search`,
 * roadmap X-16) and the two-phase replace batch (`inkflow_search_replace`, X-17).
 *
 * All three read the derived index through `ensureIndex` — the single rebuild trigger —
 * so no two of them can disagree about which build they are reading.
 */

import type { ToolDefinition } from '../context.js'
import { ensureIndex } from '../index-freshness.js'
import { DEFAULT_SEARCH_LIMIT, MAX_QUERY_CHARS, MAX_SEARCH_LIMIT, SEARCH_KINDS, searchChapters } from '../search.js'
import { searchWithSemantic } from '../ovk-search.js'
import { replaceApply, replacePreview } from '../replace.js'
import { gateFailure, resolveProject } from '../domains/tool-project.js'
import { rememberProject } from '../state.js'
import type { Json, ToolDeps } from './shared.js'
import { PROJECT_ROOT_PARAM, SUCCESS_SCHEMA, asRecord, ensureFailure, text } from './shared.js'

export function searchTools(deps: ToolDeps): ToolDefinition[] {
  const chapterSearch: ToolDefinition = {
    name: 'inkflow_chapter_search',
    description:
      'Search chapter prose for a keyword and return the matching chapters with a snippet around the first hit. ' +
      'Queries of three or more characters use the FTS5 trigram index and are ranked; 1–2 character queries ' +
      '(which trigram cannot match at all) fall back to a LIKE scan ordered by chapter number. Terms are matched ' +
      'literally — quotes, asterisks, hyphens and OR are text, not operators — and multiple whitespace-separated ' +
      'terms all have to appear. Snippets are body prose only (never the frontmatter). If the index is missing or ' +
      'was built by another schema it is rebuilt once (it is only a cache) and the search is retried; an index ' +
      'that still cannot be used is reported as INDEX_UNAVAILABLE, never as a stack trace.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        query: {
          type: 'string',
          description: 'Words to look for in chapter bodies. Matched literally; 1–2 character queries use a LIKE scan.',
        },
        limit: {
          type: 'integer',
          description: `Maximum hits to return (1–${MAX_SEARCH_LIMIT}). Default ${DEFAULT_SEARCH_LIMIT}.`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          const message = error['message'] === undefined ? '' : ` — ${String(error['message'])}`
          const hint = error['hint'] === undefined ? '' : `\n${String(error['hint'])}`
          return text([`Cannot search chapters: ${String(error['code'] ?? 'unknown')}${message}${hint}`])
        }
        const items = Array.isArray(v['items']) ? (v['items'] as Json[]) : []
        const total = typeof v['total'] === 'number' ? v['total'] : items.length
        const query = String(v['query'])
        if (items.length === 0) return text([`No chapter matches "${query}" (${String(v['mode'])} search, total ${total}).`])
        const lines = [
          `${total} chapter(s) match "${query}" (${String(v['mode'])} search${v['indexRebuilt'] === true ? ', index rebuilt' : ''}):`,
        ]
        for (const item of items) {
          const seq = item['seq'] === undefined || item['seq'] === null ? '?' : String(item['seq'])
          lines.push(`- ${seq}. ${String(item['title'])} — ${String(item['file'])}`)
          if (String(item['snippet'] ?? '') !== '') lines.push(`    ${String(item['snippet'])}`)
        }
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) {
        return gateFailure(resolved)
      }
      const probe = resolved.probe
      const queryRaw = a['query']
      if (typeof queryRaw !== 'string' || queryRaw.replace(/\s+/gu, '') === '') {
        return {
          ok: false,
          root: probe.root,
          error: {
            code: 'QUERY_INVALID',
            message: 'query must be a non-empty string',
            hint: `pass the words to look for; 1–2 characters use a LIKE scan, 3+ use the trigram index (limit ${MAX_QUERY_CHARS} characters)`,
          },
        }
      }
      const query = queryRaw.trim()
      const limit = typeof a['limit'] === 'number' ? a['limit'] : DEFAULT_SEARCH_LIMIT
      const options = { limit }

      // Same single trigger as `inkflow_chapter_list`. The query is
      // validated above, so a rejected query still writes nothing; after that
      // the index is made fresh once and both tools read the same build.
      const ensured = await ensureIndex(probe.root)
      if (!ensured.ok) return ensureFailure(ensured, probe.root)
      const result = searchChapters(probe.root, query, options)
      rememberProject(deps.dataDir, probe.root)
      if (!result.ok) {
        return {
          ok: false,
          root: probe.root,
          query,
          indexRebuilt: ensured.rebuilt,
          indexState: ensured.state,
          error: { code: result.code, message: result.message, hint: result.hint },
        }
      }
      return {
        ok: true,
        root: probe.root,
        query,
        mode: result.mode,
        total: result.total,
        limit,
        indexRebuilt: ensured.rebuilt,
        indexState: ensured.state,
        items: result.items,
      }
    },
  }

  /**
   * The single search entry (roadmap X-16).
   *
   * One tool for every kind instead of one per kind: the model asks "where is this
   * name" and gets the setting entries and the chapter prose in one paged answer. The
   * envelope is fixed by X-16 (`{kind,id,path,title,snippet,offset?,score?}` per entry,
   * `{offset,limit,total}` paging, `searchBackend`), so a semantic backend can sit
   * behind it without changing this tool.
   */
  const searchAll: ToolDefinition = {
    name: 'inkflow_search',
    description:
      'Search the whole book through one entry: chapter prose plus every setting-library kind (characters, world, ' +
      'outlines, foreshadowing, timeline, relations, facts, library). Each hit is `{kind, id, path, title, snippet}` ' +
      'with `offset`/`score` where the backend provides them; the page is `{offset, limit, total}` and `truncated` ' +
      'says more matches exist (a `limit` above 100 is clamped, not refused). The setting library is listed before ' +
      'chapter prose, because an entity matches on its own title/aliases/keywords while the manuscript matches in ' +
      'every chapter that uses the word. Terms are matched literally (quotes, asterisks and OR are text), 1–2 ' +
      'character terms use a LIKE scan (trigram cannot match them), and multiple terms all have to appear. Snippets ' +
      'are prose or field values, never frontmatter. Read-only: if the index is missing or foreign it is rebuilt ' +
      'once and the query retried; a still-unusable index is INDEX_UNAVAILABLE, never a stack trace.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        query: { type: 'string', description: 'Words to look for. Matched literally; 1–2 character terms use a LIKE scan.' },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: [...SEARCH_KINDS] },
          description: `Kinds to include: ${SEARCH_KINDS.join(', ')}. Default: all of them.`,
        },
        offset: { type: 'integer', description: 'Hits to skip (0–5000, default 0).' },
        limit: {
          type: 'integer',
          description: `Hits per page (1–${MAX_SEARCH_LIMIT}, default ${DEFAULT_SEARCH_LIMIT}). A larger value is clamped and the reply reports truncated.`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          const message = error['message'] === undefined ? '' : ` — ${String(error['message'])}`
          const hint = error['hint'] === undefined ? '' : `\n${String(error['hint'])}`
          return text([`Search failed: ${String(error['code'] ?? 'unknown')}${message}${hint}`])
        }
        const items = Array.isArray(v['items']) ? (v['items'] as Json[]) : []
        const total = typeof v['total'] === 'number' ? v['total'] : items.length
        const offset = typeof v['offset'] === 'number' ? v['offset'] : 0
        const query = String(v['query'])
        const backend = String(v['searchBackend'] ?? 'fts5')
        if (items.length === 0) {
          return text([`No match for "${query}" in ${total === 0 ? 'any kind' : 'this page'} (${backend}, ${String(v['mode'])}).`])
        }
        const last = offset + items.length
        const lines = [
          `${total} match(es) for "${query}" — showing ${offset + 1}–${last} (${backend}, ${String(v['mode'])}${v['indexRebuilt'] === true ? ', index rebuilt' : ''}):`,
        ]
        for (const item of items) {
          lines.push(`- [${String(item['kind'])}] ${String(item['title'])} — ${String(item['path'])} (id ${String(item['id'])})`)
          if (String(item['snippet'] ?? '') !== '') lines.push(`    ${String(item['snippet'])}`)
        }
        if (v['truncated'] === true) {
          lines.push(`…more matches exist; call again with offset ${String(last)} for the next page.`)
        }
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const queryRaw = a['query']
      if (typeof queryRaw !== 'string' || queryRaw.replace(/\s+/gu, '') === '') {
        return {
          ok: false,
          root: probe.root,
          error: {
            code: 'QUERY_INVALID',
            message: 'query must be a non-empty string',
            hint: `pass the words to look for (limit ${MAX_QUERY_CHARS} characters); 1–2 characters use a LIKE scan, 3+ use the trigram index`,
          },
        }
      }
      const query = queryRaw.trim()
      const kinds = Array.isArray(a['kinds']) ? (a['kinds'] as unknown[]).map(String) : undefined
      const offset = typeof a['offset'] === 'number' ? a['offset'] : 0
      const limit = typeof a['limit'] === 'number' ? a['limit'] : DEFAULT_SEARCH_LIMIT

      // Same single rebuild trigger as every other read tool: the query is
      // validated above, so a refused query still writes nothing.
      const ensured = await ensureIndex(probe.root)
      if (!ensured.ok) return ensureFailure(ensured, probe.root)
      // The semantic backend sits BEHIND this same entry (X-16): when it is configured and
      // answering, its chapter hits lead the page; when it is not, the answer is the keyword
      // one with `degradedReason` (ADR-0009 P8). Nothing here can 500 — the composition
      // returns a structured result either way.
      const outcome = await searchWithSemantic(
        probe.root,
        query,
        { ...(kinds === undefined ? {} : { kinds }), offset, limit },
        { dataDir: deps.dataDir },
      )
      const result = outcome.result
      rememberProject(deps.dataDir, probe.root)
      if (!result.ok) {
        return {
          ok: false,
          root: probe.root,
          query,
          indexRebuilt: ensured.rebuilt,
          indexState: ensured.state,
          error: { code: result.code, message: result.message, hint: result.hint },
        }
      }
      return {
        ok: true,
        root: probe.root,
        query,
        searchBackend: result.searchBackend,
        mode: result.mode,
        offset: result.offset,
        limit: result.limit,
        total: result.total,
        truncated: result.truncated,
        ...(result.degradedReason === undefined ? {} : { degradedReason: result.degradedReason }),
        semantic: { backend: outcome.availability.backend, hits: outcome.semanticHits, staleIndex: outcome.staleHits },
        indexRebuilt: ensured.rebuilt,
        indexState: ensured.state,
        items: result.items,
      }
    },
  }

  /**
   * Search-and-replace over chapter prose (roadmap X-17).
   *
   * Two actions in one tool because the contract is "preview = execution": the
   * preview's `items` ARE the `expected` set an apply must carry, and putting them in
   * one tool means a model cannot preview with one schema and apply with another.
   * `preview` writes nothing; `apply` needs `confirm: true` and a matching `expected`,
   * rewrites through the rollback package, and reports every refused file.
   */
  const searchReplace: ToolDefinition = {
    name: 'inkflow_search_replace',
    description:
      'Preview or apply a search-and-replace over chapter prose. `preview` (the default) lists every file the batch ' +
      'would change with the occurrence count and the text around the first hit, and writes nothing at all. `apply` ' +
      'rewrites those files: it requires `confirm: true` and the `expected` set from a preview ([{ chapterId, count }]) ' +
      '— a file whose count changed since the preview is skipped and reported as preview-stale instead of being ' +
      'rewritten silently. Every file keeps its own line endings and BOM. The batch opens a rollback package under ' +
      '.inkflow/backup/ before the first write, and rolls back through it if a write fails; the reply names that ' +
      'directory so the author can undo by hand. Matching is literal and case-insensitive, like search; the ' +
      'replacement is literal too (`$1` means nothing here). Chapter prose only.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        action: {
          type: 'string',
          enum: ['preview', 'apply'],
          description: '`preview` (default) writes nothing; `apply` rewrites the chapters and needs expected + confirm.',
        },
        query: { type: 'string', description: 'Literal text to look for (case-insensitive).' },
        replacement: { type: 'string', description: 'Literal replacement text; pass "" to delete the matches.' },
        expected: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              chapterId: { type: 'string' },
              count: { type: 'integer' },
            },
            required: ['chapterId', 'count'],
            additionalProperties: false,
          },
          description: 'The preview items as [{ chapterId, count }]. Required for apply.',
        },
        confirm: { type: 'boolean', description: 'Required for apply: it rewrites chapter files.' },
      },
      required: ['query', 'replacement'],
      additionalProperties: false,
    },
    output: {
      schema: SUCCESS_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          const message = error['message'] === undefined ? '' : ` — ${String(error['message'])}`
          const hint = error['hint'] === undefined ? '' : `\n${String(error['hint'])}`
          const rolledBack = v['rolledBack'] === true ? '\nThe batch was rolled back from its backup package.' : ''
          return text([`Search-replace refused: ${String(error['code'] ?? 'unknown')}${message}${hint}${rolledBack}`])
        }
        const query = String(v['query'])
        const replacement = String(v['replacement'])
        const items = Array.isArray(v['items']) ? (v['items'] as Json[]) : []
        const written = Array.isArray(v['written']) ? (v['written'] as Json[]) : []
        const skipped = Array.isArray(v['skipped']) ? (v['skipped'] as Json[]) : []
        const lines: string[] = []
        if (v['applied'] === true) {
          const replaced = typeof v['replaced'] === 'number' ? v['replaced'] : 0
          lines.push(`Replaced "${query}" → "${replacement}": ${String(replaced)} occurrence(s) in ${String(written.length)} file(s).`)
          for (const item of written) {
            lines.push(`- ${String(item['title'])} — ${String(item['path'])} · ${String(item['count'])} 处`)
            lines.push(`    前：${String(item['before'])}`)
            lines.push(`    后：${String(item['after'])}`)
          }
          const backup = asRecord(v['backup'])
          if (backup['dir'] !== undefined) {
            lines.push(`Rollback package: ${String(backup['dir'])} (undo with inkflow_project_migrate action rollback, or delete the batch by hand).`)
          }
          if (v['indexRebuilt'] === true) lines.push('index rebuilt')
          else if (v['indexError'] !== undefined) {
            lines.push(`index NOT rebuilt (${String(asRecord(v['indexError'])['code'] ?? 'unknown')}) — run inkflow_index_rebuild`)
          }
        } else {
          const total = typeof v['total'] === 'number' ? v['total'] : items.length
          lines.push(`Preview: "${query}" → "${replacement}" would change ${String(total)} file(s). Nothing was written.`)
          for (const item of items) {
            lines.push(`- ${String(item['title'])} — ${String(item['path'])} · ${String(item['count'])} 处`)
            lines.push(`    前：${String(item['before'])}`)
            lines.push(`    后：${String(item['after'])}`)
          }
          if (items.length > 0) {
            lines.push('To apply, call again with action: apply, confirm: true and expected = these items as [{ chapterId, count }].')
          }
        }
        for (const item of skipped) {
          lines.push(
            `- skipped ${String(item['path'] === '' ? item['chapterId'] : item['path'])}: ${String(item['reason'])} ` +
              `(expected ${String(item['expected'])}, actual ${String(item['actual'])})${item['detail'] === undefined ? '' : ` — ${String(item['detail'])}`}`,
          )
        }
        return text(lines)
      },
    },
    execute: async (args, exec) => {
      const a = asRecord(args)
      const resolved = await resolveProject(deps, a['projectRoot'], exec)
      if (resolved.probe === undefined || resolved.probe.usable !== true) return gateFailure(resolved)
      const probe = resolved.probe
      const query = typeof a['query'] === 'string' ? a['query'] : ''
      const replacement = typeof a['replacement'] === 'string' ? a['replacement'] : ''
      const action = a['action'] === 'apply' ? 'apply' : 'preview'
      rememberProject(deps.dataDir, probe.root)
      if (action === 'preview') {
        const preview = replacePreview(probe.root, { query, replacement })
        if (!preview.ok) {
          return { ok: false, root: probe.root, error: { code: preview.code, message: preview.message, hint: preview.hint } }
        }
        return {
          ok: true,
          root: probe.root,
          applied: false,
          query: preview.query,
          replacement: preview.replacement,
          kinds: preview.kinds,
          items: preview.items,
          total: preview.total,
        }
      }

      const expected = Array.isArray(a['expected'])
        ? (a['expected'] as unknown[]).map((raw) => asRecord(raw)).map((item) => ({
            chapterId: String(item['chapterId'] ?? ''),
            count: typeof item['count'] === 'number' ? item['count'] : Number(item['count'] ?? 0),
          }))
        : undefined
      if (expected === undefined) {
        return {
          ok: false,
          root: probe.root,
          error: {
            code: 'EXPECTED_REQUIRED',
            message: 'apply needs the expected set from a preview',
            hint: 'call with action: preview first, then pass its items as expected: [{ chapterId, count }]',
          },
        }
      }
      const applied = replaceApply(probe.root, {
        query,
        replacement,
        expected,
        confirm: a['confirm'] === true,
      })
      if (!applied.ok) {
        return {
          ok: false,
          root: probe.root,
          ...(applied.backup === undefined ? {} : { backup: applied.backup }),
          ...(applied.written === undefined ? {} : { written: applied.written }),
          ...(applied.skipped === undefined ? {} : { skipped: applied.skipped }),
          ...(applied.rolledBack === undefined ? {} : { rolledBack: applied.rolledBack }),
          error: { code: applied.code, message: applied.message, hint: applied.hint },
        }
      }
      // The manuscript changed, so the derived cache is now stale: rebuild it here
      // (same single trigger as a chapter write) and report what happened.
      const ensured = await ensureIndex(probe.root)
      return {
        ok: true,
        root: probe.root,
        applied: true,
        query: applied.query,
        replacement: applied.replacement,
        ...(applied.backup === undefined ? {} : { backup: applied.backup }),
        written: applied.written,
        skipped: applied.skipped,
        replaced: applied.replaced,
        indexRebuilt: ensured.ok ? ensured.rebuilt : false,
        ...(ensured.ok ? {} : { indexError: { code: ensured.failure.code, message: ensured.failure.message } }),
      }
    },
  }

  return [chapterSearch, searchAll, searchReplace]
}

