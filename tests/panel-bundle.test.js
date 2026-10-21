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

const model = await loadPanelModel()
const hub = await loadHubModel()

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

test('the hub ships the disabled placeholders for the wizard and the shared library', () => {
  const text = readBundle()
  // A clickable button that does nothing is worse than a disabled one, so the
  // two entries #86/#87 own must be disabled AND carry their release note.
  for (const marker of ['新开书', '共享内容', '0.1.0 后续项']) {
    assert.ok(text.includes(marker), `bundle is missing the hub placeholder wording: ${marker}`)
  }
  assert.match(text, /title: HUB_PLACEHOLDER_NOTE, disabled: true|title: HUB_PLACEHOLDER_NOTE,\s*disabled/, 'the placeholders are really disabled')
  assert.ok(text.includes('还没有书'), 'the empty state is shipped, not just the loaded list')
  assert.ok(text.includes('用下面的「新开书」创建（#86 提供）'), 'the empty state points at the wizard that will fill it')
  assert.ok(text.includes('刷新'), 'the hub refreshes on a user action, never on a timer')
  assert.equal(/setInterval/.test(text), false, 'no polling: every answer costs a judgment per book (ADR-0010 D8)')
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

test('client sources draw every colour from theme tokens', () => {
  for (const file of ['index.tsx', 'hub.tsx']) {
    const source = readFileSync(join(ROOT, 'src/client', file), 'utf8')
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(source), false, `no hardcoded colour literals in ${file} (AGENTS.md §6)`)
    assert.ok(source.includes('var(--dsw-alias-'), `colours come from --dsw-alias-* tokens in ${file}`)
  }
  const source = readFileSync(join(ROOT, 'src/client', 'index.tsx'), 'utf8')
  assert.ok(source.includes('var(--dsw-alias-state-'), 'the badge tone is a theme state token')
})

test('panel-model has no runtime coupling to the channel', () => {
  for (const file of ['panel-model.ts', 'hub-model.ts']) {
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
