/**
 * The book hub's *information architecture* (ADR-0010 D1/D2).
 *
 * The hub is one line per registered workspace, so a machine with seven workspaces and two
 * books shows seven lines. The author's words were 「书库中，不是 inkflow 项目的不要显示出来」,
 * but a plain "hide everything that is not usable" would be worse than the noise: a book
 * somebody broke (`needs-repair`) and a book written by a newer plugin
 * (`needs-newer-plugin`) ARE books, and hiding them reads as "my book is gone".
 *
 * So the split is three-way and this file pins it:
 *
 *   1. MAIN LIST — `usable` / `needs-repair` / `needs-newer-plugin` / `timeout`, and the two
 *      broken-but-real states are asserted one by one (they are the easy ones to drop by
 *      accident, and that is the hard acceptance item).
 *   2. OTHER DIRECTORIES — `needs-setup` / `notABook` / `missing-dir`, folded away by
 *      default, each one still explaining WHY it is not a book ("directory is gone" is
 *      useful information, not something to delete silently).
 *   3. THE INIT PROMPT — one constant, the absolute path filled in per row, the tool named,
 *      and the three boundaries spelled out: plan before apply with `confirm: true`, only
 *      missing items and never overwrite, `git init` without commit or remote.
 *
 * Plus the copy fallback: `navigator.clipboard` may be refused in the Electron renderer, so
 * the decision (copied vs. show a selectable textarea) is a pure function here and is
 * asserted in both directions. A button that does nothing is the one outcome not allowed.
 *
 * The model is bundled on the fly with the project's own esbuild, like
 * `tests/panel-bundle.test.js`: `node --test` has no DOM, so the wording decisions live in a
 * pure module and are asserted directly.
 *
 * Run: pnpm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

async function loadHubModel() {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client', 'hub-model.ts')],
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

const hub = await loadHubModel()

/** The seven workspaces measured on the author's machine, as `/hub/books` returned them. */
const MEASURED = [
  { workspaceId: 'ws-1', path: 'D:\\小说\\项目库\\蜀山，我是掌门', title: '蜀山，我是掌门', state: 'usable', usable: true, missing: [], dirStatus: 'ok', counts: { volumes: 9, chapters: 151 } },
  { workspaceId: 'ws-2', path: 'D:\\tmp\\inkflow-probe\\book', title: 'book', state: 'usable', usable: true, missing: [], dirStatus: 'ok', counts: { volumes: 1, chapters: 2 } },
  { workspaceId: 'ws-3', path: 'D:\\小说', title: '小说', state: 'needs-setup', usable: false, missing: Array.from({ length: 21 }, (_v, i) => `dir-${String(i)}`), dirStatus: 'ok', notABook: true },
  { workspaceId: 'ws-4', path: 'D:\\develop\\projects\\dsh-inkflow', title: 'dsh-inkflow', state: 'needs-setup', usable: false, missing: Array.from({ length: 21 }, (_v, i) => `dir-${String(i)}`), dirStatus: 'ok', notABook: true },
  { workspaceId: 'ws-5', path: 'D:\\develop\\scripts', title: 'scripts', state: 'needs-setup', usable: false, missing: Array.from({ length: 21 }, (_v, i) => `dir-${String(i)}`), dirStatus: 'ok', notABook: true },
  { workspaceId: 'ws-6', path: 'D:\\develop\\ds-herness', title: 'ds-herness', state: 'needs-setup', usable: false, missing: Array.from({ length: 22 }, (_v, i) => `dir-${String(i)}`), dirStatus: 'ok', notABook: true },
  { workspaceId: 'ws-7', path: 'D:\\迅雷下载\\新汉化类', title: '新汉化类', state: 'needs-setup', usable: false, missing: Array.from({ length: 22 }, (_v, i) => `dir-${String(i)}`), dirStatus: 'ok', notABook: true },
]

const pathsOf = (rows) => rows.map((row) => row.path)

// ---------------------------------------------------------------------------
// 1. The split: books stay, directories fold away
// ---------------------------------------------------------------------------

test('the measured machine lists 2 books and folds the other 5 directories', () => {
  const { main, others } = hub.splitHubRows(MEASURED)
  assert.deepEqual(pathsOf(main), [MEASURED[0].path, MEASURED[1].path])
  assert.deepEqual(pathsOf(others), MEASURED.slice(2).map((row) => row.path))
  assert.equal(hub.othersHeading(others.length), '其他目录（5）')
})

test('hard acceptance: a broken book and a too-new book are never filtered out', () => {
  // Both are BOOKS: the gate says something is wrong with them, not that they are absent.
  // Hiding them is the failure this test exists for ("我的书不见了").
  const repairing = { workspaceId: 'ws-r', path: 'D:\\小说\\修补中', title: '修补中', state: 'needs-repair', usable: false, missing: ['chapters/.gitkeep'], dirStatus: 'ok' }
  const tooNew = { workspaceId: 'ws-n', path: 'D:\\小说\\未来版', title: '未来版', state: 'needs-newer-plugin', usable: false, missing: [], dirStatus: 'ok' }
  const timedOut = { workspaceId: 'ws-t', path: 'D:\\小说\\慢书', title: '慢书', state: 'timeout', usable: false, missing: [], dirStatus: 'ok' }

  assert.equal(hub.isMainListRow(repairing), true, 'needs-repair must stay in the main list')
  assert.equal(hub.isMainListRow(tooNew), true, 'needs-newer-plugin must stay in the main list')
  assert.equal(hub.isMainListRow(timedOut), true, 'timeout is "no verdict yet", it is still a book')

  const { main, others } = hub.splitHubRows([repairing, tooNew, timedOut])
  assert.equal(main.length, 3)
  assert.deepEqual(others, [])
})

test('a directory that is gone, a plain directory and needs-setup all fold away', () => {
  const gone = { workspaceId: 'ws-g', path: 'D:\\小说\\已删', title: '已删', state: 'needs-repair', usable: false, missing: [], dirStatus: 'missing-dir' }
  const plain = { workspaceId: 'ws-p', path: 'D:\\tools', title: 'tools', state: 'needs-setup', usable: false, missing: [], dirStatus: 'ok', notABook: true }
  const setup = { workspaceId: 'ws-s', path: 'D:\\小说', title: '小说', state: 'needs-setup', usable: false, missing: ['chapters'], dirStatus: 'ok' }

  for (const row of [gone, plain, setup]) {
    assert.equal(hub.isMainListRow(row), false, `${row.path} is not a book yet and must fold away`)
  }
  // A registered directory that no longer exists is NEVER put back into the main list, even
  // though its gate verdict reads `needs-repair`: the row's directory is the problem.
  assert.equal(hub.isMainListRow({ ...gone, state: 'usable' }), false)
})

test('the split keeps the registry order and does not touch its input', () => {
  const input = MEASURED.map((row) => ({ ...row }))
  const snapshot = JSON.stringify(input)
  const { main, others } = hub.splitHubRows(input)
  assert.equal(main.length + others.length, input.length)
  assert.equal(JSON.stringify(input), snapshot, 'splitHubRows must not mutate the rows it is given')
  // Interleaved order survives: the main list is not "the first N rows".
  const interleaved = [MEASURED[2], MEASURED[0], MEASURED[4], MEASURED[1]]
  assert.deepEqual(pathsOf(hub.splitHubRows(interleaved).main), [MEASURED[0].path, MEASURED[1].path])
})

test('a newer Host sending an unknown state folds away instead of crashing', () => {
  const future = { workspaceId: 'ws-f', path: 'D:\\小说\\未来态', title: '未来态', state: 'some-new-state', usable: false, missing: [], dirStatus: 'ok' }
  assert.equal(hub.isMainListRow(future), false)
  assert.equal(hub.splitHubRows([future]).main.length, 0)
  // Nothing at all is not an error either.
  assert.deepEqual(hub.splitHubRows([]), { main: [], others: [] })
  assert.equal(hub.splitHubRows(undefined).main.length, 0)
})

// ---------------------------------------------------------------------------
// 2. The fold's texts
// ---------------------------------------------------------------------------

test('the fold header counts 0 / 1 / N and never prints a fraction', () => {
  assert.equal(hub.othersHeading(0), '其他目录（0）')
  assert.equal(hub.othersHeading(1), '其他目录（1）')
  assert.equal(hub.othersHeading(12), '其他目录（12）')
  assert.equal(hub.othersHeading(-3), '其他目录（0）')
  assert.equal(hub.othersHeading(Number.NaN), '其他目录（0）')
  assert.equal(hub.othersHeading('7'), '其他目录（0）', 'a string is not a count')
})

test('every folded row says WHY it is not a book, in one line', () => {
  const gone = { path: 'D:\\小说\\已删', title: '已删', state: 'needs-repair', dirStatus: 'missing-dir' }
  assert.match(hub.whyNotABook(gone), /目录不在了/u)

  const plain = { path: 'D:\\tools', title: 'tools', state: 'needs-setup', notABook: true, missing: [] }
  assert.match(hub.whyNotABook(plain), /inkflow\.json/u)
  assert.match(hub.whyNotABook(plain), /内容目录/u)

  const setup = { path: 'D:\\小说', title: '小说', state: 'needs-setup', missing: ['chapters', 'chapters/.gitkeep', 'characters', 'characters/.gitkeep', 'world', '.git', 'inkflow.json'] }
  const line = hub.whyNotABook(setup)
  assert.match(line, /缺 7 项/u)
  assert.match(line, /chapters/u)
  assert.equal(line.includes('\n'), false, 'the fold is one line per row')

  // A newer Host's row shape must still get a sentence, not an exception or an empty string.
  assert.equal(typeof hub.whyNotABook({}), 'string')
  assert.notEqual(hub.whyNotABook({}), '')
})

// ---------------------------------------------------------------------------
// 3. The init prompt: one constant, path filled in, tool named, three boundaries
// ---------------------------------------------------------------------------

test('the init prompt names the absolute path and the tool, and states the three boundaries', () => {
  const row = { path: 'D:\\小说\\项目库\\蜀山，我是掌门', title: '蜀山，我是掌门' }
  const prompt = hub.buildInitPrompt(row)

  assert.ok(prompt.includes(row.path), 'the absolute path must travel with the prompt (nobody types it by hand)')
  assert.match(prompt, /inkflow_project_init/u, 'the tool name is how a session gets the work done')
  assert.match(prompt, /<tool>inkflow_project_init<\/tool>/u, 'the tool name is tagged so a session reads it as a call, not as prose')
  assert.match(prompt, /plan/u)
  assert.match(prompt, /confirm:\s*true/u)
  assert.match(prompt, /只补缺失项/u)
  assert.match(prompt, /不覆盖/u)
  assert.match(prompt, /git init/u)
  assert.match(prompt, /不 commit/u)
  assert.match(prompt, /不配远端/u)
  assert.equal(prompt.includes('{{'), false, 'no placeholder may survive: the button copies a finished prompt')
})

test('the prompt is ONE constant, rendered — not a second copy inside the view', () => {
  assert.ok(typeof hub.INIT_PROMPT_TEMPLATE === 'string' && hub.INIT_PROMPT_TEMPLATE.length > 0)
  const prompt = hub.buildInitPrompt({ path: 'D:\\a\\我的书', title: '我的书' })
  assert.equal(prompt.includes(hub.INIT_PROMPT_TEMPLATE), false, 'the template is a template: its placeholders are filled')
  // Every fixed line of the template survives verbatim: the substitution touches placeholders only.
  for (const line of hub.INIT_PROMPT_TEMPLATE.split('\n')) {
    const fixed = line.replace(/\{\{[a-zA-Z]+\}\}/gu, '')
    if (fixed.trim() === '') continue
    assert.ok(prompt.includes(fixed), `line lost in rendering: ${line}`)
  }
  // The title falls back to the directory name, the same rule the card uses.
  assert.match(hub.buildInitPrompt({ path: 'D:\\a\\我的书' }), /我的书/u)
})

test('the prompt carries no credential and no machine secret', () => {
  const prompt = hub.buildInitPrompt({ path: 'D:\\小说\\我的书', title: '我的书' })
  assert.doesNotMatch(prompt, /apiKey|api_key|token|password|secret|Authorization/iu)
})

// ---------------------------------------------------------------------------
// 4. The copy fallback: never a button that silently does nothing
// ---------------------------------------------------------------------------

test('copying uses the clipboard when it works', async () => {
  const written = []
  const outcome = await hub.copyPrompt('hello', { writeText: async (text) => void written.push(text) })
  assert.equal(outcome, 'copied')
  assert.deepEqual(written, ['hello'])
})

test('a refused or missing clipboard degrades to the selectable textarea', async () => {
  const rejecting = { writeText: async () => Promise.reject(new Error('NotAllowedError: clipboard is blocked')) }
  assert.equal(await hub.copyPrompt('hello', rejecting), 'fallback')

  const throwing = {
    writeText: () => {
      throw new Error('permission denied')
    },
  }
  assert.equal(await hub.copyPrompt('hello', throwing), 'fallback')

  // The Electron renderer may expose no clipboard at all, and a hand-made object may miss it.
  assert.equal(await hub.copyPrompt('hello', undefined), 'fallback')
  assert.equal(await hub.copyPrompt('hello', null), 'fallback')
  assert.equal(await hub.copyPrompt('hello', {}), 'fallback')
  // Never throws, whatever the shape.
  assert.equal(await hub.copyPrompt('hello', { writeText: 'nope' }), 'fallback')
})

test('the guide quotes the SAME template, so the button and the manual cannot drift', () => {
  const guide = readFileSync(join(ROOT, 'docs/user-guide.md'), 'utf8')
  const sample = hub.buildInitPrompt({ path: ['D:', '小说', '我的书'].join('\\') })
  assert.ok(
    guide.includes(sample),
    'docs/user-guide.md must quote buildInitPrompt() verbatim: one template, no second copy',
  )
})

// ---------------------------------------------------------------------------
// 5. The view consumes the split (no second copy of the rule in JSX)
// ---------------------------------------------------------------------------

test('the hub view draws the fold from the model, and the textarea fallback is real', () => {
  const source = readFileSync(join(ROOT, 'src/client/hub.tsx'), 'utf8')
  assert.match(source, /splitHubRows/u, 'the page must use the model function, not its own filter')
  assert.match(source, /othersHeading/u, 'the fold header comes from the model')
  assert.match(source, /copyPrompt/u, 'the copy decision comes from the model')
  // The fallback has to EXIST in the view: a read-only textarea the user can select.
  assert.match(source, /readOnly/u, 'the fallback is a readOnly textarea')
  assert.match(source, /\.select\(\)/u, 'the fallback selects the text so Ctrl+C is one keystroke')
})
