/**
 * The three semantic answers, kept apart: the backend, this book's coverage, and the badge.
 *
 * WHY THIS FILE EXISTS. The defect being fixed is a word doing two jobs: 「语义检索：可用」 meant
 * both "OpenViking answers" and "this book is indexed in it", so a book with a live peer and
 * zero blocks looked exactly like a fully indexed one. Three things therefore have to stay
 * separate, and each is asserted here without a server:
 *
 *   1. `coverageOf` — the pure state machine (configured / never built / built but empty /
 *      partial / complete) and its sentences. Two of these pairs MUST NOT collapse: `—` vs
 *      `未建块` (nothing configured vs nothing built) and `N/M 章` vs `已同步` (some chapters vs
 *      every chapter). The pair is what makes the badge actionable.
 *   2. The badge words (`hub-model.ts`), including the author's ruling that the row carries
 *      NO timestamp — a rebuilt-at on a list of books is noise nobody can act on.
 *   3. One sentence, two channels: the settings page and `inkflow_semantic_status` print the
 *      SAME `headline`, which is why it is computed once in the Host rather than twice.
 *
 * The behaviours that need a real book and a real HTTP stub (the zero-request
 * short-circuit, partial coverage still recalling) live in `tests/ovk.stub.test.js`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { coverageOf } from '../lib/index.js'

const ROOT = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

/** Bundle one pure client module the way the build does, so no TS loader is needed. */
async function loadClient(entry) {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client', entry)],
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

const EMPTY = { hasLedger: false, blocks: 0, tombstones: 0, coveredChapters: 0, bookChapters: null }

/** A loose regex for "this text carries a date or a clock" — the badge must carry neither. */
const STAMP = /\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}/u

// ---------------------------------------------------------------------------
// 1. The state machine
// ---------------------------------------------------------------------------

test('unconfigured names the reason and says nothing about the book', () => {
  const coverage = coverageOf({ ...EMPTY, reason: 'no-peer' })
  assert.equal(coverage.state, 'unconfigured')
  assert.equal(coverage.reason, 'no-peer')
  // Never printed: a book with no peer must not be told "未建块" — that points at the wrong fix.
  assert.equal(coverage.headline, '')
})

test('never built and built-then-emptied are different sentences, not one', () => {
  const never = coverageOf({ hasLedger: false, blocks: 0, tombstones: 0, coveredChapters: 0, bookChapters: 3 })
  assert.equal(never.state, 'no-ledger')
  assert.match(never.headline, /还没有索引账本/u)

  // The ledger survives the chapters it describes: deleting every chapter leaves records
  // whose blocks are tombstones, which is NOT the same fact as "never built".
  const emptied = coverageOf({ hasLedger: true, blocks: 0, tombstones: 3, coveredChapters: 0, bookChapters: 3 })
  assert.equal(emptied.state, 'no-blocks')
  assert.match(emptied.headline, /未建块（0\/3 章）/u)
  assert.match(emptied.headline, /语义召回不会命中这本书/u)
  assert.notEqual(never.headline, emptied.headline)
})

test('partial coverage carries the ratio AND how far behind, from the chapter counts', () => {
  const coverage = coverageOf({ hasLedger: true, blocks: 2, tombstones: 0, coveredChapters: 2, bookChapters: 5 })
  assert.equal(coverage.state, 'partial')
  assert.equal(coverage.coveredChapters, 2)
  assert.equal(coverage.behind, 3)
  assert.equal(coverage.headline, '覆盖 2/5 章（落后 3 章，下次重建会补齐）')
})

test('complete means every chapter has a block — one short is not complete', () => {
  assert.equal(coverageOf({ hasLedger: true, blocks: 2, tombstones: 0, coveredChapters: 2, bookChapters: 2 }).headline, '已同步（2/2 章）')
  assert.equal(coverageOf({ hasLedger: true, blocks: 2, tombstones: 0, coveredChapters: 2, bookChapters: 3 }).state, 'partial')
})

test('an unreadable index degrades the sentence instead of inventing a denominator', () => {
  const coverage = coverageOf({ hasLedger: true, blocks: 2, tombstones: 0, coveredChapters: 2, bookChapters: null })
  assert.equal(coverage.bookChapters, null)
  assert.equal(coverage.behind, null)
  assert.equal(coverage.state, 'partial', 'a book whose total is unknown is never claimed as synced')
  assert.match(coverage.headline, /覆盖 2 章/u)
  assert.doesNotMatch(coverage.headline, /\//u, 'no ratio without a real denominator')
})

test('no coverage sentence carries a timestamp', () => {
  const states = [
    coverageOf({ ...EMPTY, reason: 'disabled' }),
    coverageOf({ ...EMPTY, hasLedger: false }),
    coverageOf({ ...EMPTY, hasLedger: true, tombstones: 2 }),
    coverageOf({ ...EMPTY, hasLedger: true, blocks: 2, coveredChapters: 2, bookChapters: 3 }),
    coverageOf({ ...EMPTY, hasLedger: true, blocks: 3, coveredChapters: 3, bookChapters: 3 }),
  ]
  for (const coverage of states) {
    assert.doesNotMatch(coverage.headline, STAMP, `a state sentence must not carry a time: ${coverage.headline}`)
  }
})

// ---------------------------------------------------------------------------
// 2. The badge on a book row
// ---------------------------------------------------------------------------

const BADGE_CASES = [
  ['unconfigured', { state: 'unconfigured', reason: 'no-peer' }, '语义 —'],
  ['never built', { state: 'no-ledger', hasLedger: false, coveredChapters: 0, bookChapters: 3 }, '语义 未建块'],
  ['built then emptied', { state: 'no-blocks', hasLedger: true, coveredChapters: 0, bookChapters: 3 }, '语义 未建块'],
  ['partial', { state: 'partial', coveredChapters: 12, bookChapters: 31 }, '语义 12/31 章'],
  ['complete', { state: 'complete', coveredChapters: 31, bookChapters: 31 }, '语义 已同步'],
]

test('the badge has exactly the four author-ruled labels', async () => {
  const model = await loadClient('hub-model.ts')
  for (const [name, semantic, label] of BADGE_CASES) {
    const badge = model.semanticBadgeOf(semantic)
    assert.ok(badge, `${name}: expected a badge`)
    assert.equal(badge.label, label, `${name}: label`)
    assert.doesNotMatch(badge.label, STAMP, `${name}: a badge label must not carry a time`)
    assert.doesNotMatch(badge.title ?? '', STAMP, `${name}: a badge tooltip must not carry a time`)
  }
})

test('a partial badge without a readable total shows the count alone', async () => {
  const model = await loadClient('hub-model.ts')
  assert.equal(model.semanticBadgeOf({ state: 'partial', coveredChapters: 5, bookChapters: null }).label, '语义 5 章')
})

test('no coverage on the answer means no badge — that is not the same as `—`', async () => {
  const model = await loadClient('hub-model.ts')
  assert.equal(model.semanticBadgeOf(undefined), null)
  assert.equal(model.semanticBadgeOf(null), null)
  assert.equal(model.semanticBadgeOf({}), null, 'an unknown state must not be rendered as a verdict')
  assert.equal(model.semanticBadgeOf({ state: 'unconfigured' }).label, '语义 —')
})

// ---------------------------------------------------------------------------
// 3. One sentence, two channels
// ---------------------------------------------------------------------------

function sectionValue({ backend = 'ovk', reason, coverage } = {}) {
  return {
    book: { slug: 'book', title: '测试书' },
    indexRebuilt: false,
    status: {
      availability: { backend, ...(reason === undefined ? {} : { reason }), endpoint: 'http://127.0.0.1:1933', peer: 'shushan' },
      ...(coverage === undefined ? {} : { coverage }),
      settings: { enabled: true, endpoint: 'http://127.0.0.1:1933', apiKeySet: false },
      peer: { id: 'shushan', source: 'local', configPath: '.openviking/config.local.json' },
      ledger: { projectId: 'p', fresh: true, chapters: 3, blocks: 3, tombstones: 0, lastRebuild: null },
      queue: { state: 'idle', queued: 0 },
      thresholds: { chapters: 200, bytes: 5_000_000 },
    },
    estimate: null,
  }
}

test('the settings page prints the backend and the book as two lines', async () => {
  const model = await loadClient('settings-model.ts')
  const coverage = coverageOf({ hasLedger: true, blocks: 0, tombstones: 3, coveredChapters: 0, bookChapters: 31 })
  const value = sectionValue({ coverage })
  const lines = model.describeSemantic(value)
  assert.match(lines[0], /^后端：可用（OpenViking http:\/\/127\.0\.0\.1:1933 · peer shushan）$/u)
  assert.doesNotMatch(lines.join('\n'), /语义检索：可用/u, 'the old one-word headline is gone')
  // The exact same sentence the Host put in `coverage.headline` and the tool prints.
  assert.equal(model.describeSemanticCoverage(value), `本书：${coverage.headline}`)
})

test('while the backend is down only its reason is shown, never the book line', async () => {
  const model = await loadClient('settings-model.ts')
  const coverage = coverageOf({ ...EMPTY })
  const value = sectionValue({ backend: 'fts5', reason: 'unreachable', coverage })
  const lines = model.describeSemantic(value)
  assert.match(lines[0], /^后端：不可用 —— 端点没有响应/u)
  assert.equal(model.describeSemanticCoverage(value), null, 'two complaints would point at two fixes')
})

test('an answer without coverage says so instead of guessing a state', async () => {
  const model = await loadClient('settings-model.ts')
  assert.match(model.describeSemanticCoverage(sectionValue()), /状态未知/u)
})
