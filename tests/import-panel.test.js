/**
 * The import dialog's pure view model: `src/client/library-import-model.ts`.
 *
 * Why a separate file from `import-write.test.js`: that one owns the Host (bytes, files,
 * the backup package). This one owns the words the author reads and the body the panel
 * sends — the two places where a silently wrong label or a missing field would look fine
 * while showing the wrong thing.
 *
 * What must FAIL when this is wired wrong:
 *   1. the preview stops naming the encoding tier, the line endings or the chapter-title
 *      shape (the three things the author is checking);
 *   2. "no chapter was recognised" is rendered as nothing instead of as a warning;
 *   3. the apply body forgets `confirm: true` or the `planToken` — the dialog would then
 *      either be refused or write a different set of chapters than the preview showed;
 *   4. the confirm button is offered without a token;
 *   5. a rollback is not mentioned in the error line ("did it leave half a manuscript?").
 *
 * The model is bundled on the fly with the project's own esbuild (the same trick
 * `library-panel.test.js` and `panel-bundle.test.js` use), and the built bundle is checked
 * for the dialog's strings so "declared but never rendered" cannot compile cleanly.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

async function loadModel() {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client/library-import-model.ts')],
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

const PLAN = {
  source: { name: '旧稿.txt', path: 'D:\\旧稿\\旧稿.txt', bytes: 86, encoding: 'gbk', sniff: 'GBK（回落）', eol: 'crlf', bom: false },
  chaptering: true,
  pattern: 'numbered',
  totals: { chapters: 2, paragraphs: 3, chars: 17, lines: 7 },
  target: { volumeId: 'vol-01', volumeTitle: '上卷', dir: 'chapters/vol-01-上卷' },
  chapters: [
    { seq: 3, title: '第一章 入山', paragraphs: 2, chars: 12 },
    { seq: 4, title: '第二章 出山', paragraphs: 1, chars: 5 },
  ],
  library: { keepOriginal: true, path: 'library/旧稿.txt', exists: false, identical: false },
  planToken: 'a'.repeat(64),
  warnings: [],
}

test('the draft is refused until a path is typed, and says why in the panel', async () => {
  const model = await loadModel()
  const empty = model.emptyDraft()
  assert.deepEqual(empty, { sourcePath: '', volumeId: '', keepOriginal: true })
  const problem = model.describeImportDraft(empty)
  assert.equal(problem.field, 'sourcePath')
  assert.match(problem.message, /路径/u)
  assert.equal(model.describeImportDraft({ ...empty, sourcePath: '  D:\\旧稿.txt  ' }), null)
})

test('the plan body carries only what the plan route needs, and apply adds confirm + token', async () => {
  const model = await loadModel()
  const draft = { sourcePath: '  D:\\旧稿.txt ', volumeId: '', keepOriginal: false }

  const plan = model.importRequestBody(draft, 'plan')
  assert.deepEqual(plan, { action: 'plan', sourcePath: 'D:\\旧稿.txt', keepOriginal: false })
  assert.equal('volumeId' in plan, false, 'an empty volume means "loose chapters", not an empty id')
  assert.equal('confirm' in plan, false)

  const apply = model.importRequestBody({ ...draft, volumeId: 'vol-01' }, 'apply', { confirm: true, planToken: 'abc' })
  assert.deepEqual(apply, {
    action: 'apply',
    sourcePath: 'D:\\旧稿.txt',
    keepOriginal: false,
    volumeId: 'vol-01',
    confirm: true,
    planToken: 'abc',
  })
})

test('the preview names the encoding tier, the line endings, the target and the split basis', async () => {
  const model = await loadModel()
  const source = model.describeImportSource(PLAN)
  assert.match(source, /旧稿\.txt/u)
  assert.match(source, /GBK/u)
  assert.match(source, /CRLF/u)
  const target = model.describeImportTarget(PLAN)
  assert.match(target, /vol-01/u)
  assert.match(target, /上卷/u)
  assert.match(target, /2 章/u)
  assert.match(target, /第N章/u, 'the split basis must be named, not just the counts')
})

test('"no chapter recognised" is a visible warning, never silence', async () => {
  const model = await loadModel()
  assert.equal(model.importSplitNotice(PLAN), null)
  const notice = model.importSplitNotice({ ...PLAN, chaptering: false, pattern: 'none' })
  assert.ok(notice !== null)
  assert.match(notice, /整篇会作为一章/u)
  assert.equal(model.describeImportTarget({ ...PLAN, pattern: 'none' }).includes('未识别到分章'), true)
})

test('the chapter list is capped and the hidden count is stated', async () => {
  const model = await loadModel()
  const many = { ...PLAN, chapters: Array.from({ length: 60 }, (_, index) => ({ seq: index + 1, title: `第${index + 1}章`, paragraphs: 1, chars: 1 })) }
  const rows = model.importChapterRows(many)
  assert.equal(rows.length, model.IMPORT_PREVIEW_ROWS)
  assert.equal(rows[0].seq, '0001', 'the seq is padded like the file name')
  assert.equal(model.hiddenChapterCount(many), 60 - model.IMPORT_PREVIEW_ROWS)
  assert.equal(model.hiddenChapterCount(PLAN), 0)
})

test('the original-file line distinguishes "will be kept", "already there" and "not kept"', async () => {
  const model = await loadModel()
  assert.match(model.describeImportLibrary(PLAN), /library\/旧稿\.txt/u)
  assert.match(model.describeImportLibrary({ ...PLAN, library: { ...PLAN.library, exists: true, identical: true } }), /不会重写/u)
  assert.match(model.describeImportLibrary({ ...PLAN, library: { keepOriginal: false, path: null } }), /不保留原件/u)
  assert.equal(model.describeImportLibrary({ ...PLAN, library: { keepOriginal: false, path: null } }).includes('library/'), false)
})

test('confirm is only offered on a real plan, and only while nothing is in flight', async () => {
  const model = await loadModel()
  assert.equal(model.canApply(PLAN, false), true)
  assert.equal(model.canApply(PLAN, true), false, 'a second click must not double-import')
  assert.equal(model.canApply(null, false), false)
  assert.equal(model.canApply({ ...PLAN, planToken: '' }, false), false)
})

test('the applied summary names the chapter count, the backup package and the timing', async () => {
  const model = await loadModel()
  const summary = model.describeImportResult({ created: [{ seq: 1 }, { seq: 2 }], backup: { dir: '.inkflow/backup/x' }, ms: 12.4, indexRebuilt: true })
  assert.match(summary, /已导入 2 章/u)
  assert.match(summary, /\.inkflow\/backup\/x/u)
  assert.match(summary, /12 ms/u)
  assert.match(model.describeImportResult({ created: [], backup: {}, indexRebuilt: false }), /索引未重建/u)
})

test('a refusal mentions the rollback, because "half a manuscript" is the real question', async () => {
  const model = await loadModel()
  const rolled = model.describeImportError({ code: 'IMPORT_CHAPTER_FAILED', message: '第二章 失败', rolledBack: true })
  assert.match(rolled, /IMPORT_CHAPTER_FAILED/u)
  assert.match(rolled, /已回滚/u)
  const stuck = model.describeImportError({ code: 'IMPORT_ROLLBACK_FAILED', message: 'x', rolledBack: false })
  assert.match(stuck, /回滚未完成/u)
  assert.match(model.describeImportError(undefined), /IMPORT_FAILED/u)
})

test('the volume picker lists the book’s own volumes and nothing invented', async () => {
  const model = await loadModel()
  assert.deepEqual(model.importVolumeOptions(null), [])
  assert.deepEqual(model.importVolumeOptions({ volumes: [{ volumeId: 'vol-01', title: '上卷' }, { title: '没有 id' }] }), [
    { volumeId: 'vol-01', label: 'vol-01 上卷' },
  ])
})

test('the built client bundle ships the import dialog inside the library tab', () => {
  const bundle = readFileSync(join(ROOT, 'lib/client.js'), 'utf8')
  // A dialog that is declared but never mounted is exactly the "有图标没页面" failure
  // AGENTS.md §8 warns about, and it compiles cleanly: these strings only reach the
  // bundle if `library.tsx` really imports the component and renders it.
  assert.equal(bundle.includes('/library/import'), true, 'the dialog must talk to the import route')
  assert.equal(bundle.includes('导入旧稿'), true, 'the 资料 group entry must be in the built bundle')
  assert.equal(bundle.includes('计划导入') || bundle.includes('确认导入'), true, 'the confirm step must render')
})
