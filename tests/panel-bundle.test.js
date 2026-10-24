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

import { findColorLiterals } from './color-guard.mjs'

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

/** The hub's pure view model, bundled the same way (its own module, same rules). */
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
  const file = result.outputFiles[0]
  const code = Buffer.from(file.text, 'utf8').toString('base64')
  return import(`data:text/javascript;base64,${code}`)
}

/** The shared-content page's pure view model (#87), bundled the same way. */
async function loadSharedModel() {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client', 'hub-shared-model.ts')],
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

/** The wizard's pure view model (issue #86), bundled the same way. */
async function loadWizardModel() {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client', 'hub-wizard-model.ts')],
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
const hub = await loadHubModel()
const shared = await loadSharedModel()
const wizard = await loadWizardModel()

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

test('client bundle registers the book hub pair: sidebar.panellist icon + keyed main body', () => {
  const text = readBundle()
  // ADR-0010 D1: the workbench stays in `conversation.view`, and the hub is a
  // PAIR. The sidebar renders the glyph from `sidebar.panellist` and the body
  // from the keyed `main` slot, so both must exist under the same id — one
  // without the other is the "icon but no page" failure (AGENTS.md §8 陷阱 3).
  assert.ok(text.includes('"sidebar.panellist"'), 'the icon slot must be injected by declaration, not assumed to exist yet')
  assert.match(text, /"inkflow-hub"/, 'the panel id the sidebar selects by is literal in the bundle')
  assert.match(text, /"InkFlow 书库"/, 'the label is the visible text, the accessible name and the tooltip')
  assert.match(text, /order: 35|HUB_PANEL_ORDER = 35/, 'order 35 keeps the hub before the workbench view (40)')
  // One symbol feeds both halves: an id/key mismatch cannot compile into the bundle.
  assert.match(text, /id: HUB_PANEL_ID/, 'the icon entry carries the hub id')
  assert.match(text, /name: "main", key: HUB_PANEL_ID/, 'the body is registered in main under the SAME id (main is keyed, not id-keyed)')
  assert.equal((text.match(/slots\.inject\(/g) ?? []).length, 3, 'three injections: view, icon, body — no placeholder pages')
  assert.equal((text.match(/slots\.register\(/g) ?? []).length, 3, 'three registrations: view, icon, body')
})

test('both hub entry points are real: no disabled placeholder is left', () => {
  const text = readBundle()
  // #86 made 新开书 real and #87 made 共享内容 real, so the release-note
  // placeholder component is gone from the hub entirely — a UI that keeps a
  // dead button and a live one side by side is the worst of both.
  assert.equal((text.match(/Placeholder, \{/g) ?? []).length, 0, 'no disabled placeholder remains')
  assert.ok(text.includes('新开书'), 'the new-book entry is labelled')
  assert.ok(text.includes('共享内容'), 'the shared-content entry is labelled')
  assert.ok(text.includes('HubWizard'), 'the wizard component is mounted')
  assert.equal((text.match(/SharedLibraryView/g) ?? []).length > 0, true, 'the shared page is mounted, not stubbed')
  assert.ok(text.includes('还没有书'), 'the empty state is shipped, not just the loaded list')
  assert.ok(text.includes('用上面的「新开书」创建'), 'the empty state points at the wizard that fills it')
  assert.ok(text.includes('刷新'), 'the hub refreshes on a user action, never on a timer')
  assert.equal(/setInterval/.test(text), false, 'no polling: every answer costs a judgment per book (ADR-0010 D8)')
})

test('the client bundle ships the shared-content page with its two write actions (#87, #40)', () => {
  const text = readBundle()
  assert.ok(text.includes('/hub/shared'), 'the page reads the no-session shared route (ADR-0010 D3/D5)')
  assert.ok(text.includes('/hub/shared/copies'), 'and the per-book copy list (the stale view, ADR-0007 V3)')
  assert.ok(text.includes('/hub/shared/copy'), 'copying an entry into a book goes through the hub channel')
  assert.ok(text.includes('/hub/shared/update'), 'refreshing a stale copy does too')
  // The target book is never hand-typed: the page sends a path it was handed.
  assert.ok(text.includes('book='), 'the copies query names the book it is about')
  assert.ok(text.includes('复制到哪本书'), 'the target book is an explicit choice, not a guess')
  // Both writes are two-step, so the wording of the confirmation is shipped.
  assert.ok(text.includes('确认复制'), 'a copy is confirmed before it writes')
  assert.ok(text.includes('确认更新（先备份）'), 'an update says it takes a backup first')
  assert.ok(text.includes('origin'), 'the page explains what a copy records')
  assert.ok(text.includes('stale'), 'and that a stale copy is not updated by itself')
  assert.ok(text.includes('数据来源：shared/index.json（派生清单）'), 'the manifest source is named on screen')
  assert.ok(text.includes('数据来源：内存扫描，未写回 index.json'), 'the rescan source says it was not written back')
  assert.ok(text.includes('返回书单'), 'the page can go back to the book list')
  assert.equal(/setInterval/.test(text), false, 'the shared page never polls: one read per open + 刷新')
})

test('the new-book wizard ships its two hub routes and still no polling (issue #86)', () => {
  const text = readBundle()
  // ADR-0010 D3/D4: plan is the only route carrying a path (`candidate`), apply
  // carries a one-shot token. Both are sessionless, like every hub call.
  assert.ok(text.includes('/hub/plan'), 'the wizard plans over the hub channel')
  assert.ok(text.includes('/hub/apply'), 'the wizard applies over the hub channel')
  assert.ok(text.includes('planToken'), 'apply sends a plan token, not a path')
  assert.ok(text.includes('outsideRegistry'), 'a directory outside the registry needs the explicit second confirmation')
  assert.ok(text.includes('confirm: true'), 'the apply body states the confirmation the Host demands')
  assert.equal(/setInterval/.test(text), false, 'the wizard adds no polling loop')
  // Degradation A (ADR-0010 D4) is shipped as wording, not as a fake navigation.
  assert.ok(text.includes('书已就绪'), 'the done card says the book is ready')
  assert.ok(text.includes('新会话'), 'and names the only remaining manual step')
  assert.ok(text.includes('导入已有书'), 'importing an existing book is explained as the same flow')
  // A picker that cannot be resolved must not leave the panel stuck.
  assert.ok(text.includes('pickDirectory'), 'the user-chosen directory comes from uiWorkspace.pickDirectory')
  assert.ok(text.includes('目录的绝对路径'), 'there is a manual-path fallback when the picker is absent')
})

test('client bundle talks only to the private internal channel', () => {
  const text = readBundle()
  assert.equal(text.includes('/inkflow/api/'), false, 'the old /inkflow/api/* path is gone (ADR-0008 D3)')
  assert.ok(text.includes('/inkflow/internal'), 'the panel reads /inkflow/internal/*')
  assert.ok(text.includes('/hub/books'), 'the hub reads the no-session hub route (ADR-0010 D3)')
  assert.ok(text.includes('sessionless'), 'the hub call declares that it carries no session')
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

test('client bundle carries the build stamp and the restart guidance (issue #88)', () => {
  const text = readBundle()
  // scripts/build.mjs bakes `__INKFLOW_BUILD__` = `<sha>@<ISO>` into this bundle;
  // the panel shows it and, when the Host proves the disk is newer, says restart.
  assert.match(text, /@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/, 'the client bundle carries its own stamp')
  for (const marker of ['staleLoadedCode', '插件代码已更新', 'pnpm.cmd run build', '完全退出并重启 DSH', '刷新不会生效']) {
    assert.ok(text.includes(marker), `bundle is missing the stale-build wording: ${marker}`)
  }
})

test('the stale-build banner sits above the tabs, so every gate state shows it', () => {
  // A stale generation renders the REFUSAL screen for a usable book, so the
  // banner must not live inside the usable-only branch of the panel tree.
  const source = readFileSync(join(ROOT, 'src/client', 'index.tsx'), 'utf8')
  const banner = source.indexOf('<StaleBuildBanner')
  const tabs = source.indexOf('<div style={tabRowStyle}>')
  assert.ok(banner > 0 && tabs > 0 && banner < tabs, 'the banner is rendered before the tab row')
  assert.ok(source.includes('readBuild(status)'), 'the panel reads the stamp out of /status, not from a guess')
})

test('every live tab has a page in the renderer map (roadmap X-12)', () => {
  // The tab row is driven by PANEL_TABS, the page by the map in index.tsx. A tab that
  // is `available` with no page in that map renders an empty panel with no error —
  // exactly the failure this guard exists to catch before a user finds it.
  const source = readFileSync(join(ROOT, 'src/client', 'index.tsx'), 'utf8')
  const mapStart = source.indexOf('const pageRenderers: Readonly<Record<string, () => ReactNode>> = {')
  assert.ok(mapStart > 0, 'index.tsx keeps the page map the tabs are resolved against')
  const mapEnd = source.indexOf('\n  }', mapStart)
  assert.ok(mapEnd > mapStart)
  const mapBody = source.slice(mapStart, mapEnd)
  const registered = [...mapBody.matchAll(/^\s{4}([a-z][a-z-]*):/gm)].map((match) => match[1])
  assert.ok(registered.length > 0, 'the map declares at least one page')

  for (const tab of model.PANEL_TABS) {
    if (!tab.available) continue
    // `chapters` is the inline default page, never a map entry.
    if (tab.id === 'chapters') {
      assert.ok(source.includes("tab !== 'chapters'"), 'the default page is the chapters tree')
      continue
    }
    assert.ok(registered.includes(tab.id), `tab ${tab.id} is live but has no page in pageRenderers`)
  }
  // The reverse direction: a page nobody can reach is dead code in the bundle.
  for (const id of registered) {
    const tab = model.PANEL_TABS.find((entry) => entry.id === id)
    assert.ok(tab !== undefined && tab.available, `pageRenderers.${id} is not a live tab`)
  }
})

test('client sources draw every colour from theme tokens', () => {
  for (const file of ['index.tsx', 'hub.tsx', 'hub-shared.tsx', 'hub-wizard.tsx']) {
    const source = readFileSync(join(ROOT, 'src/client', file), 'utf8')
    assert.deepEqual(findColorLiterals(source), [], `no hardcoded colour literals in ${file} (AGENTS.md §6)`)
    assert.ok(source.includes('var(--dsw-alias-'), `colours come from --dsw-alias-* tokens in ${file}`)
  }
  const source = readFileSync(join(ROOT, 'src/client', 'index.tsx'), 'utf8')
  assert.ok(source.includes('var(--dsw-alias-state-'), 'the badge tone is a theme state token')
})

test('the colour guard sees colours, not issue numbers (#144)', () => {
  // Same judgement as `panel-write.test.js`, which is why it lives in
  // `tests/color-guard.mjs` instead of in two copies of a regex: the book hub's
  // sources cite issues in comments too (`// ADR-0010 D5, issue #87`), and a guard
  // that flags those teaches people to stop citing issues.
  //
  // The numbers below are all-hex on purpose (`#132`, `#144`): a two-digit reference
  // such as `#87` is short enough that even the old `#[0-9a-fA-F]{3,8}` regex missed
  // it, so asserting only on `#87` would leave this guard green on the bug it exists
  // for.
  assert.deepEqual(findColorLiterals('// ADR-0010 D5, issue #87\n'), [], 'an issue number in a comment is not a colour')
  assert.deepEqual(findColorLiterals('// issue #132: the badge tone\n'), [], 'not even an all-hex one')
  assert.deepEqual(findColorLiterals('const badge = { emptyHint: \'（#144）\' }\n'), [], 'nor a reference inside prose')
  const literal = findColorLiterals("const style = { backgroundColor: '#123456' }\n")
  assert.equal(literal.length, 1, 'a quoted colour literal is still a hardcoded colour')
  assert.equal(literal[0].text, '#123456')
  assert.equal(findColorLiterals('const s = { fill: "#fff" }').length, 1, 'so is a quoted one in an SVG-ish style')
  assert.equal(findColorLiterals('const s = { stroke: \'#0af\' }').length, 1, 'and a short form')
})

test('panel-model has no runtime coupling to the channel', () => {
  for (const file of ['panel-model.ts', 'hub-model.ts', 'hub-shared-model.ts', 'hub-wizard-model.ts']) {
    const source = readFileSync(join(ROOT, 'src/client', file), 'utf8')
    for (const match of source.matchAll(/import\s+(type\s+)?[^'\n]*from\s+'\.\/internal\.js'/g)) {
      assert.ok(match[1] !== undefined, `${file} may only \`import type\` from ./internal.js (it stays pure)`)
    }
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

  // Issue 115: the refusal that carries a size must say the size in the author's
  // words — the old answer was the bare English code next to a dead-looking Save.
  const tooLarge = describeRouteError({ code: 'payload-too-large', limitBytes: 1024 * 1024 })
  assert.match(tooLarge, /太长/)
  assert.match(tooLarge, /1\.0 MB/)
  assert.doesNotMatch(tooLarge, /payload-too-large/, 'the code is not the message')
  assert.match(describeRouteError({ code: 'payload-too-large', limitBytes: 70 * 1024 }), /70 KB/)
  // Without the number, the sentence still stands (no `undefined` leaking out).
  const noLimit = describeRouteError({ code: 'payload-too-large' })
  assert.match(noLimit, /太长/)
  assert.doesNotMatch(noLimit, /undefined|NaN/)
  // An unusable count must not print "-1 B" or "NaN B" into the sentence.
  const absurd = describeRouteError({ code: 'payload-too-large', limitBytes: -1 })
  assert.match(absurd, /上限 \?/)
  assert.doesNotMatch(absurd, /-1 B|NaN/)

  // The chapter mapper is the only place `CHAPTER_AMBIGUOUS` can arrive (the write
  // route resolves a chapter by id and demands uniqueness), so its wording lives
  // here -- and it must not be the Host's English sentence.
  const ambiguous = describeRouteError({ code: 'CHAPTER_AMBIGUOUS', message: 'id "ch-1" is used by 2 chapters' })
  assert.match(ambiguous, /共用/)
  assert.doesNotMatch(ambiguous, /is used by/)

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
  // Issue #30 added 设定库 (the eight-kind setting library), issue #35 回收站 (the
  // recovery bin), issue #31 伏笔 (the read-only board) and issue #33 体检 (the five-family
  // audit). This list is the build's own claim about what a user can click, so it is
  // spelled out rather than derived.
  assert.deepEqual(
    available.map((tab) => tab.id),
    ['chapters', 'library', 'foreshadowing', 'trash', 'audit'],
    '章节, 设定库, 伏笔, 回收站 and 体检 exist in this build',
  )
  const disabled = PANEL_TABS.filter((tab) => !tab.available)
  assert.deepEqual(disabled.map((tab) => tab.id), ['outline'])
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

// ---------------------------------------------------------------------------
// 3. Build identity and the stale-build banner (issue #88)
// ---------------------------------------------------------------------------

const STAMP = 'abc1234@2026-10-21T13:44:02.000Z'
const LOADED_AT = '2026-10-21T12:52:13.000Z'

test('readBuild reads the summary out of `value` and out of a gate refusal', () => {
  const { readBuild } = model
  assert.equal(readBuild(null), null)
  assert.equal(readBuild({ ok: true, status: 200, value: { usable: true } }), null, 'an old host sends no build field')

  const fromValue = readBuild({
    ok: true,
    status: 200,
    value: {
      usable: true,
      build: { version: '0.0.2', build: STAMP, loadedAt: LOADED_AT, staleLoadedCode: true, diskBuildTime: STAMP.slice(8) },
    },
  })
  assert.deepEqual(fromValue, {
    version: '0.0.2',
    build: STAMP,
    loadedAt: LOADED_AT,
    staleLoadedCode: true,
    diskBuildTime: STAMP.slice(8),
  })

  // The refusal envelope is where a STALE generation hides a usable book, so the
  // summary has to survive there too.
  const fromError = readBuild({
    ok: false,
    status: 200,
    error: { code: 'NOT_AN_INKFLOW_PROJECT', build: { build: STAMP, staleLoadedCode: true } },
  })
  assert.equal(fromError.build, STAMP)
  assert.equal(fromError.staleLoadedCode, true)
  assert.equal(fromError.version, null, 'a field the host did not send stays null')
})

test('shortBuild shows the sha half of the stamp and nothing invented', () => {
  const { shortBuild } = model
  assert.equal(shortBuild(STAMP), 'abc1234')
  assert.equal(shortBuild('unknown@2026-10-21T13:44:02.000Z'), 'unknown')
  assert.equal(shortBuild('abc1234'), 'abc1234', 'a stamp without a timestamp is shown as it is')
  assert.equal(shortBuild(''), null)
  assert.equal(shortBuild(null), null)
})

test('describeBuildTime renders a fixed-width local clock, or the raw value it cannot read', () => {
  const { describeBuildTime } = model
  assert.match(describeBuildTime(STAMP.slice(8)), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  assert.equal(describeBuildTime(null), '未知')
  assert.equal(describeBuildTime('unknown'), '未知')
  assert.equal(describeBuildTime('not-a-date'), 'not-a-date')
})

test('staleWarning states the evidence, the action, and the thing that does NOT work', () => {
  const { staleWarning, describeBuildTime } = model
  assert.equal(staleWarning(null), null)
  assert.equal(staleWarning({ staleLoadedCode: false }), null, 'a fresh build says nothing')

  const text = staleWarning({ staleLoadedCode: true, diskBuildTime: STAMP.slice(8), loadedAt: LOADED_AT })
  assert.match(text, /插件代码已更新/)
  assert.match(text, /晚于 DSH 启动/, 'the banner shows both timestamps: it is evidence, not a slogan')
  assert.match(text, /pnpm\.cmd run build/)
  assert.match(text, /完全退出并重启 DSH/)
  assert.match(text, /刷新不会生效/)
  // Both moments are rendered, so a user can see which build is which.
  assert.ok(text.includes(describeBuildTime(STAMP.slice(8))))
  assert.ok(text.includes(describeBuildTime(LOADED_AT)))
})

// ---------------------------------------------------------------------------
// 3. The hub view model: badges, `~/` paths, counts, markers, envelopes
// ---------------------------------------------------------------------------

test('the hub badge names every gate state plus "no verdict this time"', () => {
  const { HUB_STATE_BADGES, badgeOf } = hub
  assert.deepEqual(Object.keys(HUB_STATE_BADGES).sort(), ['needs-newer-plugin', 'needs-repair', 'needs-setup', 'timeout', 'usable'])
  assert.equal(HUB_STATE_BADGES.usable.tone, 'success')
  assert.equal(HUB_STATE_BADGES['needs-setup'].tone, 'warn')
  assert.equal(HUB_STATE_BADGES['needs-repair'].tone, 'warn')
  assert.equal(HUB_STATE_BADGES['needs-newer-plugin'].tone, 'error')
  // `timeout` is NOT a broken book: it reads as "unsure", never as an error.
  assert.equal(HUB_STATE_BADGES.timeout.tone, 'idle')
  assert.equal(badgeOf('timeout').label, '读取超时')
  assert.equal(badgeOf('something-newer').label, '状态未知', 'a newer Host state must not break the panel')
  assert.equal(badgeOf(undefined).tone, 'idle')
})

test('relativeToHome shortens a path to ~/… and leaves everything else alone', () => {
  const { relativeToHome } = hub
  assert.equal(relativeToHome('/home/me/novels/a', '/home/me'), '~/novels/a')
  assert.equal(relativeToHome('/home/me', '/home/me'), '~')
  assert.equal(relativeToHome('/home/me/novels/a/', '/home/me/'), '~/novels/a')
  assert.equal(
    relativeToHome(String.raw`C:\novels\shushan`, String.raw`c:\novels`),
    '~/shushan',
    'Windows paths compare case-insensitively and both separators are normalised',
  )
  assert.equal(relativeToHome('/books/other', '/home/me'), '/books/other', 'outside home: the real path, not a fake ~')
  assert.equal(relativeToHome('/home/melon/a', '/home/me'), '/home/melon/a', 'a sibling that merely shares a prefix is not inside home')
  assert.equal(relativeToHome('/books/a', null), '/books/a', 'no home from the Host: no shortening')
  assert.equal(relativeToHome(undefined, '/home/me'), '')
})

test('describeCounts says "unknown" instead of inventing zeroes', () => {
  const { describeCounts } = hub
  assert.equal(describeCounts({ volumes: 3, chapters: 128 }), '3 卷 · 128 章')
  assert.equal(describeCounts({ volumes: 0, chapters: 0 }), '0 卷 · 0 章')
  assert.equal(describeCounts(undefined), '卷章数未知', 'no committed catalog means unknown, not empty')
  assert.equal(describeCounts(null), '卷章数未知')
  assert.equal(describeCounts({}), '卷章数未知')
  assert.equal(describeCounts({ volumes: 2 }), '2 卷 · 0 章')
})

test('rowMarkers names the missing directory, the non-book and the duplicate registration', () => {
  const { rowMarkers, rowTitle, isBookRow } = hub
  assert.deepEqual(rowMarkers({ dirStatus: 'ok', state: 'usable' }), [])
  assert.deepEqual(rowMarkers({ dirStatus: 'missing-dir' }), ['目录不在了'])
  assert.deepEqual(rowMarkers({ notABook: true }), ['不是书目录'])
  assert.deepEqual(rowMarkers({ dirStatus: 'missing-dir', notABook: true, duplicates: 2 }), ['目录不在了', '不是书目录', '重复注册 2 次'])
  assert.equal(rowTitle({ title: '蜀山' }), '蜀山')
  assert.equal(rowTitle({ path: String.raw`D:\novels\shushan` }), 'shushan', 'no title: the directory name')
  assert.equal(rowTitle({ path: '/books/shushan/' }), 'shushan', 'a trailing separator is not part of the name')
  assert.equal(rowTitle({}), '（未命名）')
  assert.equal(isBookRow({ state: 'usable' }), true)
  assert.equal(isBookRow({ notABook: true }), false)
  assert.equal(isBookRow({ dirStatus: 'missing-dir' }), false)
})

test('readHubBooks folds the channel envelope into a renderable state', () => {
  const { readHubBooks } = hub
  const ready = readHubBooks({
    ok: true,
    status: 200,
    value: { home: '/home/me', total: 2, truncated: true, capped: false, readOnly: true, books: [{ path: '/home/me/a' }, { path: '/home/me/b' }] },
  })
  assert.equal(ready.status, 'ready')
  assert.equal(ready.books.length, 2)
  assert.equal(ready.home, '/home/me')
  assert.equal(ready.truncated, true)

  const empty = readHubBooks({ ok: true, status: 200, value: {} })
  assert.equal(empty.status, 'ready')
  assert.deepEqual(empty.books, [], 'an empty answer is an empty list, not an error')
  assert.equal(empty.total, 0)

  const failed = readHubBooks({ ok: false, status: 200, error: { code: 'HUB_UNAVAILABLE' } })
  assert.equal(failed.status, 'error')
  assert.match(failed.message, /工作区注册表/, 'the code is translated, not printed raw')
  assert.match(hub.describeHubError({ code: 'not-found' }), /还没有书库路由/)
  assert.equal(hub.describeHubError(undefined), '书库通道没有返回内容')
})

test('hubSummary reports an incomplete list instead of hiding it', () => {
  const { hubSummary, readHubBooks } = hub
  const complete = readHubBooks({ ok: true, status: 200, value: { total: 2, books: [{}, {}] } })
  assert.equal(hubSummary(complete), '共 2 本')
  const cappedState = readHubBooks({ ok: true, status: 200, value: { total: 250, capped: true, truncated: true, books: [{}] } })
  assert.match(hubSummary(cappedState), /共 250 本/)
  assert.match(hubSummary(cappedState), /最多显示 1 本/)
  assert.match(hubSummary(cappedState), /本次未列全/)
  assert.equal(hubSummary({ status: 'error', message: 'x' }), '书库读不到')
})

// ---------------------------------------------------------------------------
// 4. The shared-content view model (#87): source wording, grouping, empty states
// ---------------------------------------------------------------------------

/** A ready answer with two entries and counts over the whole library. */
function sharedAnswer(overrides = {}) {
  return {
    ok: true,
    status: 200,
    value: {
      created: true,
      indexSource: 'index',
      entries: [
        { entryId: 'sh-11112222', kind: 'library', path: 'library/参考资料.md', tags: ['资料'] },
        { entryId: 'sh-33334444', kind: 'world', path: 'world/门派/白鹤门.md', tags: ['门派', '设定'] },
      ],
      countsByKind: { world: 1, library: 1, snippets: 0, series: 2 },
      total: 2,
      truncated: false,
      ...overrides,
    },
  }
}

test('the shared page names the data source it actually used', () => {
  const { describeSharedSource, SHARED_TEXTS } = shared
  assert.match(describeSharedSource('index'), /shared\/index\.json/, 'the manifest is named')
  assert.match(describeSharedSource('scan'), /内存扫描/, 'the rescan is named')
  assert.match(describeSharedSource('scan'), /未写回/, 'and says it did not write the manifest back')
  assert.match(describeSharedSource(undefined), /内存扫描/, 'an unknown source is described as the honest one')
  assert.match(SHARED_TEXTS.emptyTitle, /共享库还没有条目/, 'the empty state names the real situation')
  assert.match(SHARED_TEXTS.emptyHint, /shared\//, 'and tells the user where an entry comes from')
  assert.match(SHARED_TEXTS.copyHint, /快照/, 'a copy is described as a snapshot (ADR-0007 C2)')
  assert.match(SHARED_TEXTS.referenceHint, /不自包含/, 'a reference says the book is no longer self-contained (C4)')
})

test('the shared page groups by kind in canonical order, keeping the whole-library counts', () => {
  const { readSharedLibrary, sharedGroups, sharedSummary } = shared
  const state = readSharedLibrary(sharedAnswer())
  assert.equal(state.status, 'ready')
  const groups = sharedGroups(state.entries, state.countsByKind)
  // Only kinds with entries, in the ADR-0007 C1 order — never alphabetical.
  assert.deepEqual(groups.map((group) => group.kind), ['world', 'library', 'series'])
  assert.deepEqual(groups.map((group) => group.label), ['世界观 / 设定', '资料', '系列'])
  assert.deepEqual(groups[2].entries, [], 'a counted-but-filtered kind renders as an empty group, not a missing one')
  assert.match(sharedSummary(state), /共 2 条/)
  assert.match(sharedSummary(state), /世界观 \/ 设定 1/)
  assert.equal(sharedSummary({ status: 'error', message: 'x' }), '共享库读不到')
})

test('a filtered-to-nothing answer is not an empty library', () => {
  const { readSharedLibrary, isEmptyFilter, isEmptyLibrary, sharedSummary } = shared
  const empty = readSharedLibrary(sharedAnswer({ entries: [], total: 0 }))
  assert.equal(isEmptyFilter(empty), true, 'a created library with no match shows the filter note')
  assert.equal(isEmptyLibrary(empty), false, 'and does NOT claim the library is missing')
  const missing = readSharedLibrary({
    ok: true,
    status: 200,
    value: { created: false, indexSource: 'scan', entries: [], countsByKind: {}, total: 0 },
  })
  assert.equal(isEmptyLibrary(missing), true, 'a missing library is its own empty state')
  assert.equal(isEmptyFilter(missing), false)
  assert.match(sharedSummary(missing), /共 0 条/)
})

test('the shared page says so when the configured sharedRoot is not in force (#150)', () => {
  const { readSharedLibrary } = shared
  const ignored = 'sharedRoot "libs" is not an absolute path, so it is ignored and the shared library stays at dataDir/shared'
  const warned = readSharedLibrary(sharedAnswer({ sharedRootWarning: { code: 'SHARED_ROOT_IGNORED', message: ignored } }))
  assert.equal(warned.status, 'ready')
  assert.match(String(warned.rootWarning), /未生效/, 'the page names the problem instead of showing another library')
  assert.match(String(warned.rootWarning), /not an absolute path/, 'and quotes the reason the Host gave')
  assert.equal(
    readSharedLibrary(sharedAnswer()).rootWarning,
    null,
    'a usable setting says nothing at all — the healthy case is silence',
  )
  // A half-understood warning still shows: the message is what the author needs.
  const partial = readSharedLibrary(sharedAnswer({ sharedRootWarning: { code: 'SHARED_ROOT_IGNORED' } }))
  assert.match(String(partial.rootWarning), /未生效/)
})

test('the shared page renders names, paths and tags without inventing any', () => {
  const { entryName, describeTags } = shared
  assert.equal(entryName('world/门派/白鹤门.md'), '白鹤门')
  assert.equal(entryName('series/蜀山.json'), '蜀山')
  assert.equal(entryName('library/参考.pdf'), '参考.pdf', 'a non-md payload keeps its extension')
  assert.equal(entryName(undefined), '（未命名条目）')
  assert.equal(describeTags({ tags: ['门派', '设定'] }), '门派 · 设定')
  assert.equal(describeTags({}), '无标签', 'an entry without tags says so instead of showing a blank')
  assert.equal(describeTags({ tags: ['  '] }), '无标签')
})

test('a refused shared call becomes a sentence, not a bare code', () => {
  const { describeSharedError, readSharedLibrary } = shared
  assert.match(describeSharedError({ code: 'SHARED_UNAVAILABLE' }), /SHARED_UNAVAILABLE/)
  assert.match(describeSharedError({ code: 'not-found' }), /还没有共享内容路由/)
  assert.equal(describeSharedError(undefined), '共享内容通道没有返回内容')
  const failed = readSharedLibrary({ ok: false, status: 200, error: { code: 'SHARED_UNAVAILABLE' } })
  assert.equal(failed.status, 'error')
})

// ---------------------------------------------------------------------------
// 5. The wizard's view model (issue #86): four outcomes, one row merge
// ---------------------------------------------------------------------------

test('readHubPlan separates "ready" from "anchor needed", "blocked" and "refused"', () => {
  const { readHubPlan, isAnchorRequired, anchorConfirmation } = wizard
  const ready = readHubPlan({
    ok: true,
    status: 200,
    value: { path: '/books/new', anchor: 'outside-registry', canApply: true, planToken: 'tok-1', willCreate: ['git-init'] },
  })
  assert.equal(ready.status, 'ready')
  assert.equal(ready.token, 'tok-1')
  assert.equal(ready.path, '/books/new')

  // A registered book: no token, so "blocked" — never a confirm card.
  const blocked = readHubPlan({
    ok: true,
    status: 200,
    value: { path: '/books/old', anchor: 'registered', alreadyRegistered: true, canApply: false, willCreate: [], hint: '在工作台里打开它' },
  })
  assert.equal(blocked.status, 'blocked')
  assert.match(blocked.message, /已经在书库里/)
  assert.match(blocked.hint, /工作台/)

  const newer = readHubPlan({ ok: true, status: 200, value: { path: '/books/future', canApply: false, blockedReason: 'newer plugin', hint: '' } })
  assert.equal(newer.status, 'blocked')
  assert.match(newer.message, /newer plugin/, 'the Host reason is shown, not replaced by a canned sentence')

  // The second confirmation is its own outcome: the panel must ask again.
  const anchor = { ok: false, status: 400, error: { code: 'ANCHOR_REQUIRED', path: '/books/new' } }
  assert.equal(isAnchorRequired(anchor), true)
  assert.equal(anchorConfirmation(anchor).path, '/books/new')
  assert.match(anchorConfirmation(anchor).message, /全新的目录|不在任何已打开的工作区/)

  const refused = readHubPlan({ ok: false, status: 403, error: { code: 'PATH_FORBIDDEN' } })
  assert.equal(refused.status, 'refused')
  assert.match(refused.message, /盘符根|家目录/)
})

test('readHubApply returns the degradation-A card and the row, never a fake success', () => {
  const { readHubApply, doneMessage, appliedTitle } = wizard
  assert.equal(doneMessage('入山记'), '书已就绪。在左侧工作区「入山记」点「新会话」开始创作')

  const applied = readHubApply(
    {
      ok: true,
      status: 200,
      value: {
        path: '/books/new',
        state: 'usable',
        registered: true,
        workspace: { path: '/books/new', title: '入山记' },
        nextStep: { kind: 'open-new-session', title: '入山记', path: '/books/new', message: '书已就绪。在左侧工作区「入山记」点「新会话」开始创作' },
      },
    },
    '',
  )
  assert.equal(applied.status, 'applied')
  assert.equal(applied.title, '入山记')
  assert.equal(applied.path, '/books/new')
  assert.equal(applied.registered, true)
  assert.match(applied.message, /书已就绪/)

  // The Host could not register the workspace: say so, keep the book.
  const unregistered = readHubApply(
    { ok: true, status: 200, value: { path: '/books/new', state: 'usable', registered: false, hint: '在左侧手动打开该目录' } },
    '我起的名字',
  )
  assert.equal(unregistered.registered, false)
  assert.equal(unregistered.title, '我起的名字', 'what the user typed wins over the directory name')
  assert.match(unregistered.hint, /手动打开/)

  const refused = readHubApply({ ok: false, status: 409, error: { code: 'TOKEN_CONSUMED' } })
  assert.equal(refused.status, 'refused')
  assert.match(refused.message, /用过了/)

  assert.equal(appliedTitle('/books/新书', {}, ''), '新书', 'the last path segment is the fallback title')
})

test('mergeHubRow updates the row in place or appends, and never refetches', () => {
  const { mergeHubRow } = wizard
  const books = [
    { workspaceId: 'ws-a', path: String.raw`D:\novels\old`, title: '书甲', state: 'usable', dirStatus: 'ok' },
    { workspaceId: 'ws-b', path: String.raw`D:\novels\notyet`, title: '空目录', state: 'needs-setup', notABook: true, dirStatus: 'ok' },
  ]
  const replaced = mergeHubRow(books, { path: String.raw`d:\novels\NOTYET`, title: '新写的书', state: 'usable' })
  assert.equal(replaced.length, 2, 'a known directory is replaced, not duplicated (case-insensitive)')
  assert.equal(replaced[1].path, String.raw`d:\novels\NOTYET`, 'the applied canonical path is what the row shows')
  assert.equal(replaced[1].title, '新写的书')
  assert.equal(replaced[1].state, 'usable')
  assert.equal(replaced[1].workspaceId, 'ws-b', 'the registration id survives the merge')
  assert.equal('notABook' in replaced[1], false, 'the "not a book yet" marker is gone once it is a book')
  assert.equal(replaced[0], books[0], 'the untouched row is the same object: no re-projection of the list')

  // A trailing separator is not a different directory.
  assert.equal(mergeHubRow([{ path: '/books/x' }], { path: '/books/x/', title: 'x', state: 'usable' }).length, 1)

  const appended = mergeHubRow(books, { path: String.raw`D:\novels\brand-new`, title: '新的书', state: 'usable' })
  assert.equal(appended.length, 3)
  assert.equal(appended[2].title, '新的书')
  assert.equal(appended[2].dirStatus, 'ok')
  assert.deepEqual(appended[2].missing, [], 'a freshly built book lists nothing missing')
})

test('the wizard names every action it will perform, and knows when a title is required', () => {
  const { describeWillCreate, planNeedsTitle, defaultTitleFor, HUB_WIZARD_TEXTS } = wizard
  const lines = describeWillCreate({ willCreate: ['git-init', 'create-dir', 'create-gitkeep', 'create-meta', 'create-gitignore'] })
  assert.equal(lines.length, 5, 'every announced action gets a sentence')
  assert.match(lines[0], /git init/)
  assert.match(lines[3], /inkflow\.json/)
  assert.match(lines[4], /gitignore/)
  assert.equal(planNeedsTitle({ willCreate: ['git-init', 'create-meta'] }), true)
  assert.equal(planNeedsTitle({ willCreate: ['create-dir'] }), false)
  assert.equal(defaultTitleFor(String.raw`D:\小说\入山记`), '入山记')
  assert.match(HUB_WIZARD_TEXTS.anchorBody, /不会覆盖/, 'the second confirmation promises only additive writes')
  assert.equal(wizard.readHubApply({ ok: false, status: 400, error: { code: 'META_TITLE_REQUIRED' } }).status, 'refused')
})

// ---------------------------------------------------------------------------
// 5. The setting-library pages as SOURCE structure (issues 133 / 134)
//
// `node --test` has no DOM, so the two panel-structure bugs of the 0.3.0
// verification pass cannot be reproduced by rendering. They can be pinned as
// source structure instead, which is what these two tests do — the same style as
// the "no hardcoded colour" guard above: read the file, assert the shape.
// ---------------------------------------------------------------------------

function clientSource(name) {
  return readFileSync(join(ROOT, 'src', 'client', name), 'utf8')
}

/** One top-level function of a client source (the files are 2-space indented). */
function functionSource(source, name) {
  const match = new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`).exec(source)
  assert.ok(match !== null, `${name} is still a top-level function`)
  return match[0]
}

test('the library detail pane keeps its header OUT of the scrolling box (issue 133)', () => {
  const pane = functionSource(clientSource('library.tsx'), 'DetailPane')

  // The bug: the pane's outermost element WAS the scroll column (`...columnStyle`),
  // so 标题 + 路径 + 编辑 shared one scroll container with the content and scrolled
  // out of view on a long entry. The root must not be a scroll column again.
  assert.equal(pane.includes('SCROLL_COLUMN_STYLE'), false, 'the pane root must not be the scroll column')
  // The content box takes its height from the shared measurement (issue 116): a
  // hardcoded pixel height or `height: 100%` would resolve against a content-sized
  // wrapper and silently stop scrolling (layout-model.ts quotes the measurement).
  assert.ok(pane.includes('useScrollBox()'), 'the content box measures the height it has')
  assert.ok(pane.includes('SCROLL_BOX_STYLE'), 'the content box takes its height source from the shared style')
  assert.ok(pane.includes("overflowY: 'auto'"), 'the content box is the scroller')
  assert.equal(/height:\s*['"]/.test(pane), false, 'no written height in the pane: it is measured, never typed')

  // Structure: the header is a SIBLING of the measured box, never its first child.
  // Depth (opens minus closes) must be exactly 1 when the box's own tag opens — i.e.
  // inside the pane root only. Merging the two back into one container fails here.
  const refAt = pane.indexOf('ref={scrollBox.ref}')
  assert.ok(refAt > 0, 'the measured box is the element that carries the ref')
  const before = pane.slice(pane.indexOf('return ('), pane.lastIndexOf('<div', refAt))
  const depth = (before.match(/<div\b/g) ?? []).length - (before.match(/<\/div>/g) ?? []).length
  assert.equal(depth, 1, 'the scrolling box is a direct child of the pane root: the header is not in its scroll flow')
  assert.ok(before.includes('编辑'), 'the 编辑 button belongs to the header that never scrolls')
  assert.ok(before.includes('item.path'), 'so does the path the author copies')
})
