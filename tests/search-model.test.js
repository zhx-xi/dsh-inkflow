/**
 * Contract tests for the panel's search box (roadmap X-16 / X-20).
 *
 * `node --test` has no DOM, so — exactly like `tests/panel-bundle.test.js` — the contract
 * has two halves:
 *
 *   1. STATIC, against the built bundle `lib/client.js` (the artifact DSH loads): the 章节
 *      page must carry the search box and the 「全部类型」 switch, and the request must go
 *      to the private `/search` route. X-20 says no new tab, so the tabs are checked too:
 *      six of them, none of them a search page.
 *   2. BEHAVIOURAL, against `src/client/search-model.ts` bundled on the fly: the request
 *      path (scope switch), the defensive reading of the wire payload, the wording, and
 *      where a click on a hit goes (chapter → this page's editor, entity → 设定库).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
const require = createRequire(import.meta.url)

function readBundle() {
  if (!existsSync(BUNDLE)) throw new Error('lib/client.js is missing: run `npm run build` first')
  return readFileSync(BUNDLE, 'utf8')
}

async function loadSearchModel() {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client', 'search-model.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    write: false,
    logLevel: 'silent',
  })
  const code = Buffer.from(result.outputFiles[0].text, 'utf8').toString('base64')
  return import(`data:text/javascript;base64,${code}`)
}

test('panel: the chapters page ships the search box and the 全部类型 switch (no new tab)', () => {
  const bundle = readBundle()
  assert.equal(bundle.includes('搜索正文与设定'), true, 'the search box placeholder must be in the built panel')
  assert.equal(bundle.includes('全部类型（正文之外的设定条目也一起搜）'), true, 'the scope switch must be in the built panel')
  assert.equal(bundle.includes('/search?'), true, 'the box must call the private search route')
  assert.equal(bundle.includes('搜索全部类型'), true, 'the switch needs its accessible name')
  // X-20: searching is a way to read the 章节 tab, not a seventh tab.
  assert.equal(bundle.includes("id: 'search'"), false, 'no search tab may be registered')
})

test('search model: the scope switch changes the kinds parameter, not the route', async () => {
  const model = await loadSearchModel()
  const chaptersOnly = model.searchRequestPath('云海 翻涌', false)
  assert.equal(chaptersOnly.startsWith('/search?'), true)
  assert.equal(chaptersOnly.includes('kinds=chapters'), true)
  assert.equal(chaptersOnly.includes('q=%E4%BA%91%E6%B5%B7'), true, 'the query is percent-encoded')

  const allKinds = model.searchRequestPath('云海', true)
  assert.equal(allKinds.includes('kinds='), false, 'all kinds is the Host default, so it is omitted')
  assert.equal(allKinds.includes(`limit=${model.SEARCH_PAGE_LIMIT}`), true)

  const second = model.searchRequestPath('云海', true, { offset: 50, limit: 10 })
  assert.equal(second.includes('offset=50'), true)
  assert.equal(second.includes('limit=10'), true)
  assert.equal(model.searchRequestPath('云海', true, { offset: 0 }).includes('offset='), false, 'offset 0 is the default')
})

test('search model: the payload is read defensively and keeps the X-16 fields', async () => {
  const model = await loadSearchModel()
  const page = model.readSearchPage({
    items: [
      { kind: 'chapters', id: 'ch-1', path: 'chapters/0001-a.md', title: '第一章', snippet: '…云海…', offset: 4, score: 1.5 },
      { kind: 'characters', id: 'c-1', path: 'characters/清音.md', title: '清音', snippet: '清音 · 云海仙子' },
      { kind: '', id: 'broken' },
      'not-an-object',
    ],
    total: 2,
    offset: 0,
    limit: 50,
    truncated: true,
    searchBackend: 'fts5',
  })
  assert.equal(page.items.length, 2, 'an entry without kind+id is dropped: a click would go nowhere')
  assert.deepEqual(page.items[0], { kind: 'chapters', id: 'ch-1', path: 'chapters/0001-a.md', title: '第一章', snippet: '…云海…' })
  assert.equal(page.total, 2)
  assert.equal(page.truncated, true)
  assert.equal(page.backend, 'fts5')
  assert.equal(page.degradedReason, null)

  const empty = model.readSearchPage(undefined)
  assert.deepEqual(empty.items, [])
  assert.equal(empty.backend, 'fts5', 'an unreadable payload still names a backend')
  assert.equal(model.readSearchPage({ searchBackend: 'ovk', degradedReason: 'no peer' }).backend, 'ovk')
})

test('search model: labels, target routing, summary and degraded note', async () => {
  const model = await loadSearchModel()
  const chapter = { kind: 'chapters', id: 'ch-1', path: 'chapters/0001-a.md', title: '第一章', snippet: '' }
  const character = { kind: 'characters', id: 'c-1', path: 'characters/清音.md', title: '清音', snippet: '' }
  assert.equal(model.searchHitLabel(chapter), '章正文 · 第一章')
  assert.equal(model.searchHitLabel(character), '角色 · 清音')
  assert.equal(model.searchHitLabel({ ...character, kind: 'unknown-kind' }), 'unknown-kind · 清音', 'a new directory must not read as blank')

  assert.deepEqual(model.searchHitTarget(chapter), { kind: 'chapter', chapterId: 'ch-1' })
  assert.deepEqual(model.searchHitTarget(character), { kind: 'entity', entityKind: 'characters', id: 'c-1' })

  const page = { items: [chapter], total: 12, offset: 0, limit: 50, truncated: true, backend: 'fts5', degradedReason: null }
  const summary = model.describeSearchPage(page, '云海', false)
  assert.equal(summary.includes('命中 12 条'), true)
  assert.equal(summary.includes('仅章正文'), true)
  assert.equal(summary.includes('只显示前几页'), true, 'a truncated page must say how to narrow it')

  const nothing = model.describeSearchPage({ ...page, items: [], total: 0, truncated: false }, '云海', true)
  assert.equal(nothing.includes('没有命中'), true)
  assert.equal(nothing.includes('全部类型'), true)

  assert.equal(model.describeSearchDegradation(page), null)
  // An unknown reason is printed as-is: a code the panel does not translate is still more
  // useful than silence (the backend keeps the vocabulary fixed, the free-text path is the index's).
  assert.equal(
    model.describeSearchDegradation({ ...page, degradedReason: 'index unavailable' }),
    '关键词结果：index unavailable',
  )
  // The six fixed semantic reasons each become one actionable sentence (ADR-0020 E5).
  assert.equal(
    model.describeSearchDegradation({ ...page, degradedReason: 'no-peer' }),
    '语义检索不可用：这本书没有 .openviking 里的 peer.id，已用关键词结果。',
  )
  assert.equal(model.searchBackendLabel({ ...page, backend: 'ovk' }), '语义检索')
  assert.equal(model.searchBackendLabel(page), '关键词检索')
  assert.equal(model.hasNextPage({ ...page, total: 1, truncated: false }), false, 'one page holds everything here')
  assert.equal(model.hasNextPage({ ...page, total: 500 }), true)
})
