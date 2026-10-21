/**
 * Contract tests for the panel skeleton (`conversation.view`, issue #17).
 *
 * `node --test` has no DOM, so the React View cannot be rendered here. The
 * contract is therefore checked in two ways that both FAIL when the panel is
 * wired wrong:
 *
 *   1. STATIC, against the BUILT bundle `lib/client.js` — the artifact DSH
 *      actually loads. It must register `conversation.view` with id `inkflow`
 *      and order 40, and must not register `sidebar.panellist` / `main`, must
 *      not touch the removed `/inkflow/api/*` path, and must still ship the
 *      `fetchInternal` / `setActiveSessionId` pair (ADR-0008 D1/D2/D4).
 *   2. BEHAVIOURAL, against `src/client/panel-model.ts` bundled on the fly —
 *      the pure view model (badge wording, tree, empty-state choice, root
 *      display). Bundling with the project's own esbuild keeps the test on the
 *      same compiler the build uses, without adding a TS loader dependency.
 *
 * Run: pnpm test
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
  if (!existsSync(BUNDLE)) throw new Error(`lib/client.js is missing: run \`pnpm run build\` first`)
  return readFileSync(BUNDLE, 'utf8')
}

/** Bundle `src/client/panel-model.ts` to an ESM data URL and import it. */
async function loadPanelModel() {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client', 'panel-model.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    write: false,
    logLevel: 'silent',
  })
  const file = result.outputFiles[0]
  const code = Buffer.from(file.text, 'utf8').toString('base64')
  return import(`data:text/javascript;base64,${code}`)
}

const model = await loadPanelModel()

// ---------------------------------------------------------------------------
// 1. The built bundle: one registration, in the session-scoped View slot
// ---------------------------------------------------------------------------

test('client bundle registers conversation.view with id inkflow and order 40', () => {
  const text = readBundle()
  assert.ok(text.startsWith('window.__ModuleLoader__.load('), 'loader-factory shape (H4)')
  assert.ok(text.includes('conversation.view'), 'the panel must register the session-scoped view slot')
  assert.match(
    text,
    /register\(\{\s*name:\s*"conversation\.view",\s*id:\s*"inkflow",\s*order:\s*40,/,
    'the entry must be id "inkflow" at order 40, right after 对话 (0) and 轨迹 (10)',
  )
  // The label is a thunk so the tab text follows the active locale.
  assert.match(text, /label:\s*\(\)\s*=>\s*"InkFlow"/)
})

test('client bundle registers nothing else: no root-scoped slots', () => {
  const text = readBundle()
  assert.equal(text.includes('sidebar.panellist'), false, 'the left sidebar icon must be gone (ADR-0008 D1)')
  assert.equal(/name:\s*["']main["']/.test(text), false, 'the root-scoped main panel must be gone (ADR-0008 D1)')
  assert.equal((text.match(/slots\.inject\(/g) ?? []).length, 1, 'exactly one slot injection')
  assert.equal((text.match(/slots\.register\(/g) ?? []).length, 1, 'exactly one registration: no placeholder pages')
})

test('client bundle talks only to the private internal channel', () => {
  const text = readBundle()
  assert.equal(text.includes('/inkflow/api/'), false, 'the old /inkflow/api/* path is gone (ADR-0008 D3)')
  assert.ok(text.includes('/inkflow/internal'), 'the panel reads /inkflow/internal/*')
  assert.ok(text.includes('fetchInternal'), 'every read goes through fetchInternal')
  assert.ok(text.includes('setActiveSessionId'), 'the session id is handed to the channel, not a directory')
  // A path parameter would let any loopback page point the panel at another book.
  const forbiddenParams = ["root=", "path=", "cwd="]
  for (const param of forbiddenParams) {
    assert.equal(text.includes(param), false, `the panel must never build a ${param} query argument (ADR-0008 D4)`)
  }
})

test('client bundle ships the skeleton wording the user sees', () => {
  const text = readBundle()
  for (const marker of ['章节树', '正文（Markdown 编辑器）', '打开初始化向导', '缺少（missing）', '0.2.0 起', '新建章']) {
    assert.ok(text.includes(marker), `bundle is missing the panel wording: ${marker}`)
  }
  // The four-state badge must be able to name every state.
  for (const state of ['needs-newer-plugin', 'needs-repair', 'needs-setup', 'usable']) {
    assert.ok(text.includes(state), `bundle is missing the gate state: ${state}`)
  }
})

test('client sources draw every colour from theme tokens', () => {
  const source = readFileSync(join(ROOT, 'src/client', 'index.tsx'), 'utf8')
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(source), false, 'no hardcoded colour literals (AGENTS.md §6)')
  assert.ok(source.includes('var(--dsw-alias-'), 'colours come from --dsw-alias-* tokens')
  assert.ok(source.includes('var(--dsw-alias-state-'), 'the badge tone is a theme state token')
})

test('panel-model has no runtime coupling to the channel', () => {
  const source = readFileSync(join(ROOT, 'src/client', 'panel-model.ts'), 'utf8')
  for (const match of source.matchAll(/import\s+(type\s+)?[^'\n]*from\s+'\.\/internal\.js'/g)) {
    assert.ok(match[1] !== undefined, 'panel-model may only `import type` from ./internal.js (it stays pure)')
  }
})

// ---------------------------------------------------------------------------
// 2. The view model: wording, four-state badge, tree, empty states, root
// ---------------------------------------------------------------------------

test('the four-state badge names every state and falls back to "未定位项目"', () => {
  const { STATE_BADGES, UNKNOWN_BADGE } = model
  assert.deepEqual(Object.keys(STATE_BADGES).sort(), ['needs-newer-plugin', 'needs-repair', 'needs-setup', 'usable'])
  assert.equal(STATE_BADGES.usable.tone, 'success')
  assert.equal(STATE_BADGES['needs-setup'].tone, 'warn')
  assert.equal(STATE_BADGES['needs-repair'].tone, 'warn')
  assert.equal(STATE_BADGES['needs-newer-plugin'].tone, 'error')
  assert.equal(UNKNOWN_BADGE.tone, 'idle')
  assert.equal(UNKNOWN_BADGE.label, '未定位项目')
})

test('readGate folds a usable /status value into the panel gate', () => {
  const { readGate } = model
  const gate = readGate({
    ok: true,
    status: 200,
    value: {
      label: '蜀山',
      root: 'D:\\novels\\shushan',
      state: 'usable',
      usable: true,
      readOnly: false,
      missing: [],
      actions: [],
      reasons: [],
    },
  })
  assert.equal(gate.state, 'usable')
  assert.equal(gate.usable, true)
  assert.equal(gate.projectTitle, '蜀山')
  assert.equal(gate.root, 'D:\\novels\\shushan')
  assert.equal(gate.label, '可用')
  assert.equal(gate.tone, 'success')
  assert.deepEqual(gate.missing, [])
})

test('readGate reads the checklist out of the gate refusal envelope', () => {
  const { readGate } = model
  const gate = readGate({
    ok: false,
    status: 200,
    error: {
      code: 'PROJECT_NEEDS_REPAIR',
      state: 'needs-repair',
      root: '/books/a',
      readOnly: false,
      missing: ['chapters/', 'index/.gitkeep'],
      actions: [{ type: 'create-dir', path: '/books/a/chapters', reason: '缺正文目录' }],
      reasons: ['index/ 缺失'],
      hint: 'the book exists but is incomplete',
    },
  })
  assert.equal(gate.state, 'needs-repair')
  assert.equal(gate.usable, false)
  assert.equal(gate.label, '待修复')
  assert.deepEqual(gate.missing, ['chapters/', 'index/.gitkeep'])
  assert.equal(gate.actions.length, 1)
  assert.equal(gate.actions[0].type, 'create-dir')
  assert.deepEqual(gate.reasons, ['index/ 缺失'])
  assert.equal(gate.errorCode, 'PROJECT_NEEDS_REPAIR')
  assert.equal(gate.hint, 'the book exists but is incomplete')
})

test('readGate reports "no session" without inventing a state', () => {
  const { readGate } = model
  const gate = readGate({ ok: false, status: 200, error: { code: 'NO_SESSION_CONTEXT', message: 'no session' } })
  assert.equal(gate.state, null)
  assert.equal(gate.usable, false)
  assert.equal(gate.label, '未定位项目')
  assert.equal(gate.tone, 'idle')
  assert.equal(gate.errorCode, 'NO_SESSION_CONTEXT')
  assert.deepEqual(gate.missing, [])
  assert.equal(readGate(null).state, null, 'nothing answered yet: still no state')
})

test('emptyKindOf picks the empty state the panel must render', () => {
  const { readGate, emptyKindOf } = model
  const noSession = readGate({ ok: false, status: 200, error: { code: 'NO_SESSION_CONTEXT' } })
  const needsSetup = readGate({ ok: false, status: 200, error: { code: 'NOT_AN_INKFLOW_PROJECT', state: 'needs-setup' } })
  const usable = readGate({ ok: true, status: 200, value: { state: 'usable', usable: true } })

  assert.equal(emptyKindOf(noSession, 0, false), 'no-session')
  assert.equal(emptyKindOf(needsSetup, 0, false), 'needs-setup')
  assert.equal(emptyKindOf(usable, 0, false), 'no-chapters')
  assert.equal(emptyKindOf(usable, 3, false), 'no-selection')
  assert.equal(emptyKindOf(usable, 3, true), null)
  // A transport failure is a problem to report, not an empty state to fill.
  assert.equal(emptyKindOf(readGate({ ok: false, status: 0, error: { code: 'fetch-failed' } }), 0, false), null)
})

test('buildChapterTree keeps volume order and reading order', () => {
  const { buildChapterTree, flattenChapters, chapterHeading } = model
  const value = {
    total: 3,
    volumes: [
      { volumeId: 'vol-01', dir: 'chapters/vol-01-qi', title: '卷一 起', chapters: [{ id: 'c1', path: 'chapters/vol-01-qi/001.md', seq: 1, title: '出门' }] },
      { volumeId: 'vol-02', dir: 'chapters/vol-02-cheng', title: '卷二 承', chapters: [] },
    ],
    looseChapters: [
      { id: 'c2', path: 'chapters/番外.md', seq: null, title: '番外' },
      { path: 'chapters/broken.md' },
    ],
  }
  const tree = buildChapterTree(value)
  assert.equal(tree.groups.length, 2)
  assert.equal(tree.groups[1].chapters.length, 0, 'an empty volume is a real editorial state, not dropped')
  assert.equal(tree.loose.length, 1, 'a chapter without an id cannot be opened, so it is dropped')
  assert.equal(tree.total, 2)

  const flat = flattenChapters(value)
  assert.deepEqual(flat.map((chapter) => chapter.id), ['c1', 'c2'])
  assert.equal(chapterHeading(flat[0]), '1. 出门')
  assert.equal(chapterHeading(flat[1]), '番外', 'no seq: the title stands alone')
  assert.deepEqual(buildChapterTree(null), { groups: [], loose: [], total: 0 })
})

test('relativeProjectRoot shows the book relative to the session workspace', () => {
  const { relativeProjectRoot } = model
  assert.equal(relativeProjectRoot('/books/a', '/books/a'), './')
  assert.equal(relativeProjectRoot('/books/a', '/books/a/'), './')
  assert.equal(relativeProjectRoot('/books/a/chapters', '/books/a'), './chapters')
  assert.equal(relativeProjectRoot('D:\\novels\\shushan', 'D:\\novels\\shushan'), './')
  assert.equal(relativeProjectRoot('D:\\novels\\shushan\\chapters', 'D:\\novels\\shushan'), './chapters')
  assert.equal(relativeProjectRoot('D:\\NOVELS\\shushan', 'd:\\novels\\shushan'), './', 'Windows paths compare case-insensitively')
  assert.equal(relativeProjectRoot('/books/other', '/books/a'), '/books/other', 'a root outside the workspace is shown as it is')
  assert.equal(relativeProjectRoot(null, '/books/a'), null)
  assert.equal(relativeProjectRoot('/books/a', null), '/books/a')
})

test('previewText is gone: the panel shows an editor, not a read-only preview', () => {
  // Issue #19 replaced the preview column with the editor, so the projection
  // helper that existed only for it must not linger as dead code.
  assert.equal(model.previewText, undefined)
})

test('describeRouteError and describeAction explain failures and wizard steps', () => {
  const { describeRouteError, describeAction } = model
  assert.match(describeRouteError(undefined), /没有返回内容/)
  assert.match(describeRouteError({ code: 'NO_SESSION_CONTEXT' }), /NO_SESSION_CONTEXT/)
  assert.equal(describeRouteError({ code: 'weird', message: 'boom' }), 'boom')
  assert.equal(describeRouteError({ code: 'weird' }), 'weird')

  assert.equal(describeAction({ type: 'create-dir', path: 'chapters', reason: '缺正文目录' }), '建目录 · chapters · 缺正文目录')
  assert.equal(describeAction({ type: 'git-init', path: '/books/a' }), 'git init · /books/a')
  assert.equal(describeAction({}), '需人工处理')
  assert.equal(describeAction({ type: 'manual', path: '/books/a', reason: 'plugin too old' }), '需人工处理 · /books/a · plugin too old')
})

test('projectFacts reports derived state without implying it is the truth', () => {
  const { projectFacts, describeFacts } = model
  const facts = projectFacts({
    ok: true,
    status: 200,
    value: {
      state: 'usable',
      usable: true,
      index: { dbExists: true, builtAt: '2026-10-21T12:00:00.000Z' },
      catalog: { volumes: 2, chapters: 7, stale: false },
    },
  })
  assert.deepEqual(facts, { indexBuilt: true, indexBuiltAt: '2026-10-21T12:00:00.000Z', volumes: 2, chapters: 7 })
  assert.equal(describeFacts(facts), '索引 已建（2026-10-21T12:00:00.000Z） · 卷 2 · 章 7')

  const missing = projectFacts({ ok: true, status: 200, value: { state: 'usable', index: { dbExists: false } } })
  assert.equal(missing.indexBuilt, false)
  assert.equal(describeFacts(missing), '索引 缺失（首次调用工具时会重建） · 卷 — · 章 —')

  // A gate refusal carries no value, so there is nothing to claim.
  assert.deepEqual(projectFacts({ ok: false, status: 200, error: { code: 'NO_SESSION_CONTEXT' } }), {
    indexBuilt: null,
    indexBuiltAt: null,
    volumes: null,
    chapters: null,
  })
  assert.equal(describeFacts(projectFacts(null)), '索引 未知 · 卷 — · 章 —')
})

test('PANEL_TABS leaves unimplemented pages disabled with their release note', () => {
  const { PANEL_TABS } = model
  const available = PANEL_TABS.filter((tab) => tab.available)
  assert.deepEqual(available.map((tab) => tab.id), ['chapters'], 'only 章节 exists in this build')
  const disabled = PANEL_TABS.filter((tab) => !tab.available)
  assert.deepEqual(disabled.map((tab) => tab.id), ['settings', 'outline', 'foreshadowing'])
  for (const tab of disabled) assert.equal(tab.note, '0.2.0 起', `tab ${tab.id} must say when it arrives`)
})

test('the client bundle ships the title-suspicion tooltip (issue #89)', () => {
  // The marker lives in the View, the wording in the model: both have to reach
  // the artifact DSH loads, or the Host flags a garbled title nobody ever sees.
  const text = readBundle()
  assert.match(text, /书名疑似编码乱码/, 'the tooltip text must be in lib/client.js')
  assert.match(text, /UTF-8 无 BOM/, 'the tooltip must name the fix')
})

test('readGate carries titleSuspicious and describeTitleSuspicion words it (issue #89)', () => {
  const { readGate, describeTitleSuspicion } = model
  // A hand-written meta whose title is UTF-8 read back as GBK: the Host reports
  // it beside the gate, and the panel only adds a marker — it never blocks.
  const flagged = readGate({
    ok: true,
    status: 200,
    value: { label: '浜哄湪铚€灞憋紝鏄帉闂?', state: 'usable', usable: true, titleSuspicious: true },
  })
  assert.equal(flagged.titleSuspicious, true)
  assert.equal(flagged.usable, true, 'a suspicious title is not a gate state')
  const note = describeTitleSuspicion(flagged)
  assert.equal(typeof note, 'string')
  assert.match(note, /乱码/)
  assert.match(note, /UTF-8/)

  const plain = readGate({ ok: true, status: 200, value: { label: '蜀山', state: 'usable', usable: true } })
  assert.equal(plain.titleSuspicious, false)
  assert.equal(describeTitleSuspicion(plain), null, 'an ordinary title renders no marker')

  // The refusal envelope never carries it: only a parseable meta can be judged.
  const refused = readGate({ ok: false, status: 200, error: { code: 'NOT_AN_INKFLOW_PROJECT', state: 'needs-setup' } })
  assert.equal(refused.titleSuspicious, false)
  assert.equal(describeTitleSuspicion(readGate(null)), null)
})
