/**
 * Contract tests for the chapter editor (issue #19).
 *
 * `node --test` has no DOM, so the React editor cannot be rendered here. The
 * contract is checked in two ways that both FAIL when the editor is wired wrong:
 *
 *   1. STATIC, against the BUILT bundle `lib/client.js` — the artifact DSH
 *      actually loads. It must talk to the chapter write routes, must understand
 *      `409` / `FILE_CHANGED`, must ship the autosave + undo machinery, and must
 *      not bundle a third-party editor (the package stays dependency-free).
 *   2. BEHAVIOURAL, against `src/client/editor-model.ts` bundled on the fly with
 *      the project's own esbuild: dirty tracking, the 1500ms debounce, the
 *      500ms undo grouping, "saved clears the stack" and the conflict state
 *      (a 409 must never overwrite; the user picks reload or overwrite).
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
  if (!existsSync(BUNDLE)) throw new Error('lib/client.js is missing: run `pnpm run build` first')
  return readFileSync(BUNDLE, 'utf8')
}

/** Bundle `src/client/editor-model.ts` to an ESM data URL and import it. */
async function loadEditorModel() {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client', 'editor-model.ts')],
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

const model = await loadEditorModel()

// ---------------------------------------------------------------------------
// Harness: a fake clock, so 1500ms and 500ms are deterministic
// ---------------------------------------------------------------------------

function fakeClock() {
  let now = 0
  let seq = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimer(callback, ms) {
      const id = ++seq
      timers.set(id, { at: now + ms, callback })
      return id
    },
    clearTimer(id) {
      timers.delete(id)
    },
    advance(ms) {
      now += ms
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.callback()
        }
      }
    },
    pending: () => timers.size,
  }
}

/** Let the model's promise chain settle (save is async). */
function flush() {
  return new Promise((done) => setImmediate(done))
}

const BASE_FIELDS = { title: '开篇', body: '他走进白鹤门。', status: 'final' }
const FINGERPRINT = { size: 120, mtimeMs: 1_700_000_000_000, sha256: 'a'.repeat(64) }

/**
 * A model over `panel-model`'s editor contract: `save` is the Host call, so a
 * test can decide between success, a 409 and a hard failure.
 */
function buildEditor({ save, reload, fields = BASE_FIELDS, fingerprint = FINGERPRINT, autosave = true } = {}) {
  const clock = fakeClock()
  const calls = []
  const editor = model.createEditorModel({
    chapterId: 'ch-1',
    path: 'chapters/vol-01/0001-开篇.md',
    fields: { ...fields },
    fingerprint,
    autosave,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    save(request) {
      calls.push(request)
      return save(request)
    },
    reload,
  })
  return { editor, clock, calls }
}

// ---------------------------------------------------------------------------
// 1. The built bundle: the editor is wired to the write routes
// ---------------------------------------------------------------------------

test('client bundle talks to the chapter write routes and understands a conflict', () => {
  const text = readBundle()
  // The four write routes share the `/chapters` prefix the editor saves through.
  assert.ok(text.includes('/inkflow/internal'), 'writes go through the private channel')
  assert.ok(text.includes('/chapters/'), 'the editor addresses one chapter by id')
  assert.match(text, /chapters\/\$\{|`\/chapters\//, 'the save path is built from the chapter id')
  // A 409 is data, not a crash: the code has to be recognised by name.
  assert.ok(text.includes('FILE_CHANGED'), 'a stale baseline must be recognised as FILE_CHANGED')
  assert.ok(text.includes('409'), 'the HTTP status is checked alongside the error code')
  for (const marker of ['expected', 'sha256']) {
    assert.ok(text.includes(marker), `the save carries the CAS baseline (${marker})`)
  }
  // Conflict resolution is two explicit actions, never automatic.
  for (const marker of ['重新载入', '仍要保存']) {
    assert.ok(text.includes(marker), `the conflict card offers ${marker}`)
  }
})

test('client bundle ships the autosave and undo machinery, and no editor library', () => {
  const text = readBundle()
  assert.ok(text.includes('1500'), 'autosave debounce is 1500ms')
  assert.ok(text.includes('500'), 'undo merges within 500ms')
  for (const marker of ['保存中', '已保存', '冲突', '未保存']) {
    assert.ok(text.includes(marker), `the save indicator must be able to say ${marker}`)
  }
  // Undo/redo has to be keyed, and a save is Cmd/Ctrl+S.
  assert.match(text, /ctrlKey|metaKey/, 'the editor binds a modifier key')
  assert.ok(text.includes('KeyS') || text.includes("'s'") || text.includes('"s"'), 'Ctrl/Cmd+S saves')

  // Zero runtime dependencies holds for the editor too: no bundled editor lib.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'dependencies stay empty (no runtime editor)')
  const forbidden = ['codemirror', '@codemirror', 'monaco-editor', 'tiptap', '@tiptap', 'prosemirror', 'lexical', 'quill', 'slate', 'marked', 'react-markdown']
  const declared = Object.keys(pkg.devDependencies ?? {})
  for (const name of forbidden) {
    assert.equal(declared.includes(name), false, `${name} must not be a dependency`)
    assert.equal(text.includes(`require("${name}")`), false, `${name} must not be bundled`)
  }
})

test('the editor draws every colour from theme tokens', () => {
  for (const file of ['index.tsx', 'editor.tsx', 'editor-model.ts']) {
    const path = join(ROOT, 'src/client', file)
    if (!existsSync(path)) continue
    const source = readFileSync(path, 'utf8')
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(source), false, `${file}: no hardcoded colour literals (AGENTS.md §6)`)
  }
  const editor = readFileSync(join(ROOT, 'src/client', 'editor.tsx'), 'utf8')
  assert.ok(editor.includes('var(--dsw-alias-'), 'the editor uses --dsw-alias-* tokens')
})

test('the editor model stays pure: no React, no IO, no channel import', () => {
  const source = readFileSync(join(ROOT, 'src/client', 'editor-model.ts'), 'utf8')
  assert.equal(/from\s+['"]react['"]/.test(source), false, 'the model must not import React')
  assert.equal(/from\s+['"](node:|\.\/internal)/.test(source), false, 'the model must not do IO or call the channel')
})

// ---------------------------------------------------------------------------
// 2. Dirty tracking and the 1500ms debounce
// ---------------------------------------------------------------------------

test('a text change is dirty and saves 1500ms after the last keystroke', async () => {
  const saves = []
  const { editor, clock } = buildEditor({
    save: async (request) => {
      saves.push(request)
      return { ok: true, fingerprint: { ...FINGERPRINT, sha256: 'b'.repeat(64) } }
    },
  })

  assert.equal(editor.getState().phase, 'idle')
  editor.setText('他走进白鹤门。风很大。')
  assert.equal(editor.getState().phase, 'dirty')
  assert.equal(editor.getState().fields.body, '他走进白鹤门。风很大。')
  assert.equal(editor.getState().saved.body, '他走进白鹤门。', 'the baseline still says what is on disk')

  clock.advance(1499)
  await flush()
  assert.equal(saves.length, 0, 'nothing is saved before 1500ms')

  clock.advance(1)
  await flush()
  assert.equal(saves.length, 1, 'the debounce fired once')
  assert.equal(saves[0].reason, 'auto')
  assert.equal(saves[0].body, '他走进白鹤门。风很大。')
  assert.equal(saves[0].expected.sha256, FINGERPRINT.sha256, 'an autosave is a CAS write')
  assert.equal(editor.getState().phase, 'saved')
  assert.equal(editor.getState().fingerprint.sha256, 'b'.repeat(64), 'the new baseline is kept')
})

test('typing again restarts the debounce instead of saving every keystroke', async () => {
  const saves = []
  const { editor, clock } = buildEditor({
    save: async (request) => {
      saves.push(request)
      return { ok: true, fingerprint: FINGERPRINT }
    },
  })

  editor.setText('一')
  clock.advance(1000)
  editor.setText('一二')
  clock.advance(1000)
  assert.equal(saves.length, 0, 'the timer restarts on each change')
  clock.advance(500)
  await flush()
  assert.equal(saves.length, 1)
  assert.equal(saves[0].body, '一二')
})

test('autosave off means no timer at all, and Ctrl/Cmd+S saves immediately', async () => {
  const saves = []
  const { editor, clock } = buildEditor({
    autosave: false,
    save: async (request) => {
      saves.push(request)
      return { ok: true, fingerprint: FINGERPRINT }
    },
  })

  editor.setText('手动保存的正文')
  clock.advance(5000)
  await flush()
  assert.equal(saves.length, 0, 'autosave is off')
  assert.equal(editor.getState().phase, 'dirty')

  await editor.save('manual')
  assert.equal(saves.length, 1, 'an explicit save does not wait for the debounce')
  assert.equal(saves[0].reason, 'manual')
  assert.equal(editor.getState().phase, 'saved')

  // Nothing changed since the last save: manual save is a no-op round trip.
  await editor.save('manual')
  assert.equal(saves.length, 1)
})

test('the save indicator wording is the one the author sees', () => {
  const labels = model.SAVE_LABELS
  assert.equal(labels.dirty, '未保存')
  assert.match(labels.saving, /^保存中/)
  assert.equal(labels.saved, '已保存')
  assert.match(labels.conflict, /^冲突/)
})

// ---------------------------------------------------------------------------
// 3. The undo stack (500ms grouping) and the save point
// ---------------------------------------------------------------------------

test('consecutive typing merges into one undo entry; a pause starts a new one', () => {
  const { editor, clock } = buildEditor({ save: async () => ({ ok: true, fingerprint: FINGERPRINT }) })

  assert.equal(editor.getState().canUndo, false)
  editor.setText('A')
  clock.advance(100)
  editor.setText('AB')
  clock.advance(100)
  editor.setText('ABC')
  assert.equal(editor.getState().canUndo, true)

  // One burst → one undo entry: it restores the text as it was before the burst.
  editor.undo()
  assert.equal(editor.getState().fields.body, BASE_FIELDS.body)
  assert.equal(editor.getState().canUndo, false, 'the burst was a single entry')

  editor.setText('A')
  clock.advance(100)
  editor.setText('AB')
  clock.advance(600) // past the 500ms grouping window
  editor.setText('ABC')
  editor.undo()
  assert.equal(editor.getState().fields.body, 'AB', 'a pause starts a new entry')
  editor.undo()
  assert.equal(editor.getState().fields.body, BASE_FIELDS.body)
  assert.equal(editor.undo(), false, 'nothing left to undo')
})

test('a successful save marks a new save point and empties the undo stack', async () => {
  const { editor, clock } = buildEditor({ save: async () => ({ ok: true, fingerprint: FINGERPRINT }) })

  editor.setText('第一版')
  clock.advance(600)
  editor.setText('第二版')
  assert.equal(editor.getState().canUndo, true)

  clock.advance(1500) // the debounce fires
  await flush()
  assert.equal(editor.getState().phase, 'saved')
  assert.equal(editor.getState().canUndo, false, 'a save point clears the stack')
  assert.equal(editor.getState().saved.body, '第二版')
})

// ---------------------------------------------------------------------------
// 4. Conflict: a 409 never overwrites, and the two actions are explicit
// ---------------------------------------------------------------------------

test('a 409 FILE_CHANGED turns the editor into a conflict state and stops autosave', async () => {
  let saves = 0
  const { editor, clock } = buildEditor({
    save: async () => {
      saves += 1
      return { ok: false, conflict: true, current: { ...FINGERPRINT, sha256: 'c'.repeat(64) }, changed: ['sha256'] }
    },
  })

  editor.setText('我的新段落')
  clock.advance(1500)
  await flush()

  const state = editor.getState()
  assert.equal(saves, 1)
  assert.equal(state.phase, 'conflict')
  assert.deepEqual(state.conflict.changed, ['sha256'])
  assert.equal(state.conflict.current.sha256, 'c'.repeat(64))
  assert.equal(state.fields.body, '我的新段落', 'the local text is kept — it is the user’s work')
  assert.equal(state.saved.body, BASE_FIELDS.body, 'the baseline is NOT advanced past the conflict')

  // No retry loop: typing in a conflict does not keep hammering the Host.
  clock.advance(10_000)
  await flush()
  assert.equal(saves, 1, 'a conflict pauses autosave until the user decides')
})

test('reload discards the local edits and clears the conflict', async () => {
  const serverFields = { title: '开篇', body: '磁盘上的正文', status: 'draft' }
  const { editor } = buildEditor({
    save: async () => ({ ok: false, conflict: true, current: FINGERPRINT, changed: ['sha256'] }),
    reload: async () => ({ fields: serverFields, fingerprint: { ...FINGERPRINT, sha256: 'd'.repeat(64) } }),
  })

  editor.setText('我的新段落')
  await editor.save('manual')
  assert.equal(editor.getState().phase, 'conflict')

  await editor.discardAndReload()
  const state = editor.getState()
  assert.equal(state.phase, 'idle')
  assert.equal(state.conflict, null)
  assert.equal(state.fields.body, '磁盘上的正文')
  assert.equal(state.fingerprint.sha256, 'd'.repeat(64))
  assert.equal(editor.getState().canUndo, false)
})

test('overwrite sends no baseline, which is the only way a 409 gets written over', async () => {
  const requests = []
  let outcome = 'conflict'
  const { editor } = buildEditor({
    save: async (request) => {
      requests.push(request)
      if (outcome === 'conflict') return { ok: false, conflict: true, current: FINGERPRINT, changed: ['sha256'] }
      return { ok: true, fingerprint: { ...FINGERPRINT, sha256: 'e'.repeat(64) } }
    },
  })

  editor.setText('覆盖用的正文')
  await editor.save('manual')
  assert.equal(editor.getState().phase, 'conflict')
  assert.equal(requests[0].expected.sha256, FINGERPRINT.sha256, 'the first attempt is a CAS write')

  outcome = 'ok'
  await editor.overwriteAndSave()
  assert.equal(requests.length, 2)
  assert.equal(requests[1].reason, 'overwrite')
  assert.equal(requests[1].expected, undefined, 'an overwrite deliberately drops the baseline')
  assert.equal(editor.getState().phase, 'saved')
  assert.equal(editor.getState().conflict, null)
})

test('a hard failure is reported, not swallowed, and keeps the text', async () => {
  const { editor } = buildEditor({
    save: async () => ({ ok: false, conflict: false, code: 'PROJECT_BUSY', message: 'another writer holds the lock' }),
  })

  editor.setText('写不进去的正文')
  await editor.save('manual')
  const state = editor.getState()
  assert.equal(state.phase, 'error')
  assert.equal(state.errorCode, 'PROJECT_BUSY')
  assert.match(state.error ?? '', /lock/)
  assert.equal(state.fields.body, '写不进去的正文')
})
