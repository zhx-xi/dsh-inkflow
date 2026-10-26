/**
 * The chapter tree and the editor's file footer.
 *
 * `node --test` has no DOM, so the two halves are checked the way this repo already checks
 * panels: the DECISIONS live in pure modules and are asserted through a bundle, and the
 * page's JSX is checked by a SOURCE SCAN that fails when the shape it promises goes away.
 *
 * What the scan is protecting (issue: the tree showed two lines per chapter, one of which was
 * the file path):
 *   * a row shows the heading and nothing else — no `.md`, no directory;
 *   * a volume is a control (`aria-expanded`), because collapsing it is the only reason it is
 *     a row of its own;
 *   * the file facts moved to the editor, so `index.tsx` must not render `chapter.path` any
 *     more — if it comes back, the noise is back.
 *
 * Run: pnpm test (this file bundles the models itself; no `pnpm run build` needed).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CLIENT = join(ROOT, 'src', 'client')
const require = createRequire(import.meta.url)

function sourceOf(page) {
  return readFileSync(join(CLIENT, page), 'utf8')
}

async function bundle(relative) {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(CLIENT, relative)],
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

test('collapsing is a set of ids, and every volume starts open', async () => {
  const model = await bundle('chapter-tree-model.ts')
  assert.equal(model.isVolumeOpen(model.NO_VOLUMES_CLOSED, 'vol-01'), true, 'a volume starts open')
  const once = model.toggleVolume(model.NO_VOLUMES_CLOSED, 'vol-01')
  assert.equal(model.isVolumeOpen(once, 'vol-01'), false)
  assert.equal(model.isVolumeOpen(once, 'vol-02'), true, 'collapsing one volume leaves the others alone')
  const twice = model.toggleVolume(once, 'vol-01')
  assert.equal(model.isVolumeOpen(twice, 'vol-01'), true)
  assert.deepEqual(twice, [], 'toggling back to open leaves no residue behind')
})

test('the loose group collapses through the same rule as a volume', async () => {
  const model = await bundle('chapter-tree-model.ts')
  const closed = model.toggleVolume(model.NO_VOLUMES_CLOSED, model.LOOSE_GROUP_ID)
  assert.equal(model.isVolumeOpen(closed, model.LOOSE_GROUP_ID), false)
  // The id must not be a volume id, or a book with a volume literally called "loose" would
  // collapse both at once.
  assert.notEqual(model.LOOSE_GROUP_ID, 'vol-01')
})

test('the volume head counts its chapters, and an empty volume says so', async () => {
  const model = await bundle('chapter-tree-model.ts')
  assert.equal(model.describeVolumeFacts(7), '7 章')
  assert.equal(model.describeVolumeFacts(0), '还没有章')
})

test('the editor footer names the file: path, size, line ending, BOM, mtime', async () => {
  const model = await bundle('editor-model.ts')
  const text = model.describeFileFacts({
    path: 'chapters/vol-01/0003-出门.md',
    style: { eol: 'crlf', bom: true },
    fingerprint: { size: 2048, mtimeMs: Date.UTC(2026, 9, 26, 18, 3, 15), sha256: 'abc' },
  })
  assert.ok(text.includes('chapters/vol-01/0003-出门.md'), 'the path is the point of the line')
  assert.ok(text.includes('2.0 KB'), text)
  assert.ok(text.includes('CRLF'), 'a CRLF file has to say so: it is why a save is not a whole-file diff')
  assert.ok(text.includes('BOM'), text)
  assert.match(text, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/u, 'the mtime is readable, not a raw epoch')

  const lf = model.describeFileFacts({ path: 'chapters/0001.md', style: { eol: 'lf', bom: false } })
  assert.ok(lf.includes('LF'))
  assert.equal(lf.includes('BOM'), false, 'no BOM is the default; saying so on every line is noise')
  assert.ok(lf.includes('大小未知'), 'a missing fingerprint is stated, never guessed')
})

test('the tree row shows the heading only — the path lives in the editor now', () => {
  const page = sourceOf('chapter-tree.tsx')
  assert.equal(page.includes('.path'), false, 'the row must not render the file path')
  assert.ok(page.includes('chapterHeading'), 'the row still says which chapter it is')

  // `index.tsx` keeps `chapter.path` in ONE place that is not a row: a jump address coming
  // from the audit page is matched against a chapter's path, and that is not a render. What
  // must be gone is the row itself — which was the only caller of `chapterHeading` there.
  const index = sourceOf('index.tsx')
  assert.equal(index.includes('chapterHeading'), false, 'the old row render is gone from the workbench too')
  assert.ok(index.includes('<ChapterTree'), 'the workbench renders the extracted tree')
})

test('a volume is a control: the row carries aria-expanded and a caret', () => {
  const page = sourceOf('chapter-tree.tsx')
  assert.ok(page.includes('aria-expanded'), 'a collapsing row has to announce its state')
  assert.ok(page.includes("name={open ? 'caret-down' : 'caret'}"), 'the caret tells the state twice')
  assert.equal(page.includes('<svg'), false, 'the glyph comes from the shared set')
})

test('the editor no longer prints its implementation notes', () => {
  const page = sourceOf('editor.tsx')
  assert.equal(page.includes('撤销合并粒度'), false, 'the footer line now carries the file, not the code')
  assert.ok(page.includes('describeFileFacts'), 'the footer reads the pure formatter')
})
