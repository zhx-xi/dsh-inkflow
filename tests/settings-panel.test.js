/**
 * The settings page's pure view model (#42): form ↔ wire conversion, the confirm
 * card's change list, and the per-file baselines a restore hands back.
 *
 * `node --test` has no DOM, so the `.tsx` view cannot be rendered; the *decisions*
 * it makes all live in `src/client/settings-model.ts` and are tested here by
 * bundling that module with the project's own esbuild (same compiler as the build,
 * no TS loader dependency). Every assertion is chosen so a broken model FAILS:
 *
 *   * `patchFromForm` must send numbers as numbers (the Host clamps, but `"3000"`
 *     would fall back to the default and silently lose the user's value), and an
 *     empty box must NOT become `0`.
 *   * `mergeRestoreExpected` must include only the files the plan would WRITE — a
 *     `same` entry needs no baseline, and a stale one for an untouched file would
 *     make the Host's compare-and-swap refuse a legitimate restore.
 *   * the formatters must not invent a value for a stamp or a size they cannot read.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

async function loadModel() {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client', 'settings-model.ts')],
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

const SETTINGS = {
  semanticSearch: false,
  autosaveIntervalMs: 1500,
  excludeDirs: ['drafts'],
  backupKeep: 5,
}

test('formFromSettings keeps unset fields empty rather than inventing text', async () => {
  const model = await loadModel()
  const draft = model.formFromSettings(SETTINGS)
  assert.equal(draft.sharedRoot, '')
  assert.equal(draft.authorName, '')
  assert.equal(draft.autosaveIntervalMs, '1500')
  assert.equal(draft.excludeDirs, 'drafts')
  assert.equal(draft.backupKeep, '5')
  assert.equal(draft.semanticSearch, false)
})

test('patchFromForm sends numbers as numbers, splits the directory list, and clears unset text with null', async () => {
  const model = await loadModel()
  const patch = model.patchFromForm({
    sharedRoot: '  ',
    semanticSearch: true,
    autosaveIntervalMs: '3000',
    authorName: '作者',
    excludeDirs: 'drafts, 临时，scratch\n',
    backupKeep: '9',
  })
  assert.equal(patch.autosaveIntervalMs, 3000)
  assert.equal(patch.backupKeep, 9)
  assert.equal(patch.semanticSearch, true)
  assert.equal(patch.sharedRoot, null, 'an emptied optional field clears it')
  assert.equal(patch.authorName, '作者')
  assert.deepEqual(patch.excludeDirs, ['drafts', '临时', 'scratch'])
})

test('an empty number box leaves the setting alone (it is not zero)', async () => {
  const model = await loadModel()
  const patch = model.patchFromForm({
    sharedRoot: '',
    semanticSearch: false,
    autosaveIntervalMs: '',
    authorName: '',
    excludeDirs: '',
    backupKeep: '',
  })
  assert.equal(Object.prototype.hasOwnProperty.call(patch, 'autosaveIntervalMs'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(patch, 'backupKeep'), false)
  // A number that is not a number is dropped for the same reason: the Host would clamp
  // a wrong value, and clamping a typo is worse than keeping the old value.
  const typo = model.patchFromForm({ ...model.formFromSettings(SETTINGS), backupKeep: '5x' })
  assert.equal(Object.prototype.hasOwnProperty.call(typo, 'backupKeep'), false)
})

test('describeDraftChanges names only the fields that really move', async () => {
  const model = await loadModel()
  const unchanged = model.describeDraftChanges(model.formFromSettings(SETTINGS), SETTINGS)
  assert.deepEqual(unchanged, [])

  const moved = model.describeDraftChanges(
    { ...model.formFromSettings(SETTINGS), backupKeep: '12', authorName: '作者', excludeDirs: 'drafts, scratch' },
    SETTINGS,
  )
  assert.deepEqual(moved.sort(), ['保留份数', '作者名', '排除目录'].sort())
})

test('mergeRestoreExpected carries a baseline only for the files a restore would write', async () => {
  const model = await loadModel()
  const expected = model.mergeRestoreExpected([
    { path: 'chapters/a.md', action: 'overwrite', bytes: 4, current: 'aa' },
    { path: 'chapters/b.md', action: 'same', bytes: 4, current: 'bb' },
    { path: 'chapters/c.md', action: 'create', bytes: 4, current: null },
  ])
  assert.deepEqual(expected, { 'chapters/a.md': 'aa', 'chapters/c.md': null })
})

test('the plan and the restore report read as sentences, not codes', async () => {
  const model = await loadModel()
  const plan = model.describePlan({
    book: { workspaceId: 'ws-1', bookSlug: '书' },
    plan: {
      file: '书-20261024-093000.zip',
      counts: { create: 1, overwrite: 2, same: 7 },
      entries: [
        { path: 'chapters/a.md', action: 'overwrite', bytes: 4, current: 'aa' },
        { path: 'chapters/c.md', action: 'create', bytes: 4, current: null },
      ],
      extra: ['chapters/n.md'],
    },
  })
  assert.match(plan[0], /覆写 2 · 新建 1 · 已一致 7/u)
  assert.ok(plan.some((line) => line.includes('不会删除')))
  assert.ok(plan.some((line) => line.includes('覆写 chapters/a.md')))
  assert.ok(plan.some((line) => line.includes('新建 chapters/c.md')))

  const report = model.describeRestore({
    restored: ['chapters/a.md'],
    unchanged: ['chapters/b.md'],
    extra: [],
    index: { state: 'stale', rebuilt: true, ok: true },
    backups: [],
  })
  assert.match(report[0], /已写回 1 个文件，1 个本来就一致/u)
  assert.match(report[1], /已重建/u)
})

test('formatters never invent a value for input they cannot read', async () => {
  const model = await loadModel()
  assert.equal(model.formatStamp('20261024-093000'), '2026-10-24 09:30 UTC')
  assert.equal(model.formatStamp('not-a-stamp'), 'not-a-stamp')
  assert.equal(model.formatBytes(512), '512 B')
  assert.equal(model.formatBytes(2048), '2.0 KB')
  assert.equal(model.formatBytes(Number.NaN), '—')
})

test('loadableFrom keeps the Host\'s own code, message and hint', async () => {
  const model = await loadModel()
  const ready = model.loadableFrom({ ok: true, status: 200, value: { anything: 1 } })
  assert.equal(ready.status, 'ready')
  assert.equal(ready.value.anything, 1)

  const refused = model.loadableFrom({
    ok: false,
    status: 200,
    error: { code: 'BOOK_NOT_FOUND', message: 'no registered book matches', hint: 'refresh the list' },
  })
  assert.equal(refused.status, 'error')
  assert.match(refused.message, /BOOK_NOT_FOUND/u)
  assert.match(refused.message, /refresh the list/u)
})

test('anchorOf prefers the registry id and falls back to the directory name', async () => {
  const model = await loadModel()
  assert.equal(model.anchorOf({ workspaceId: 'ws-1', bookSlug: '书甲', title: '甲' }), 'ws-1')
  assert.equal(model.anchorOf({ workspaceId: null, bookSlug: '书甲', title: '甲' }), '书甲')
  assert.equal(model.anchorOf(undefined), undefined)
  assert.equal(model.defaultBook([]), undefined)
  assert.equal(model.defaultBook([{ workspaceId: 'ws-1', bookSlug: 'a', title: 'A' }])?.workspaceId, 'ws-1')
})
