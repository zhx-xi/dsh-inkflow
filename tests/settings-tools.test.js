/**
 * The tools as the model reaches them: five tools, their confirm gates, and the
 * renderer called on every shape `execute` returns.
 *
 * The module-level tests (`settings.test.js`, `diagnostics.test.js`,
 * `backup-zip.test.js`) drive the logic; this file drives the SURFACE, because three
 * failure modes only exist there: a parameter the model passes that `execute` never
 * reads, a refusal without `ok:false` (the model then reports success), and a
 * renderer that throws on a real result (the host calls it on every reply).
 *
 * Runs against the built artifact (`../lib/index.js`).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, settingsOf } from '../lib/index.js'
import { hashTree } from './hash-tree.mjs'

const NINE = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']

function harness() {
  const parent = mkdtempSync(join(tmpdir(), 'inkflow-settings-tools-'))
  const workspace = join(parent, 'book')
  for (const dir of [...NINE, 'index']) {
    mkdirSync(join(workspace, dir), { recursive: true })
    writeFileSync(join(workspace, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(workspace, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '工具面' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(workspace, '.gitignore'), 'index/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  // The gate reads "a book is one git repository", so the fixture has to be one: only
  // the backup tools need a `usable` book, but a fixture that is not a book would make
  // every gate assertion here test the wrong thing.
  const git = spawnSync('git', ['init', '--quiet', '-b', 'main'], { cwd: workspace })
  assert.equal(git.status, 0, `git init failed: ${String(git.stderr)}`)
  writeFileSync(join(workspace, 'chapters', '0001-a.md'), '---\ntitle: 一\nid: ch-1\n---\n\n正文\n', 'utf8')
  writeFileSync(join(workspace, 'characters', '清音.md'), '---\ntitle: 清音\n---\n', 'utf8')
  const dataDir = join(parent, 'state')

  const tools = new Map()
  const ctx = {
    effect(setup) {
      const dispose = setup()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    get(name) {
      if (name === 'workingDirectory') return { ensure: async () => workspace }
      return undefined
    },
    logger() {
      return { debug() {}, info() {}, warn() {}, error() {} }
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    webServer: {
      register() {
        return () => {}
      },
    },
  }
  apply(ctx, { dataDir })
  return { parent, workspace, dataDir, tools, cleanup: () => rmSync(parent, { recursive: true, force: true }) }
}

async function call(h, name, args) {
  const tool = h.tools.get(name)
  assert.ok(tool, `tool ${name} must be registered`)
  return tool.execute(args, { signal: AbortSignal.timeout(20_000), agent: { id: 'test-session' } })
}

function rendered(h, name, args, value) {
  const tool = h.tools.get(name)
  const blocks = tool.output.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0)
  const text = blocks.map((block) => String(block.text ?? '')).join('\n')
  assert.ok(text.trim() !== '', 'the renderer must produce text')
  return text
}

test('all five tools are registered with the plugin', () => {
  const h = harness()
  try {
    for (const name of [
      'inkflow_settings_get',
      'inkflow_settings_update',
      'inkflow_diagnostics_export',
      'inkflow_backup_create',
      'inkflow_backup_restore',
    ]) {
      assert.ok(h.tools.has(name), `${name} must be registered`)
    }
  } finally {
    h.cleanup()
  }
})

test('settings get returns the defaults; a settings save needs confirm and touches no book', async () => {
  const h = harness()
  try {
    const read = await call(h, 'inkflow_settings_get', {})
    assert.equal(read.ok, true)
    assert.equal(read.source, 'default')
    assert.equal(read.settings.backupKeep, 5)
    assert.match(rendered(h, 'inkflow_settings_get', {}, read), /backupKeep/u)

    const beforeBook = hashTree(h.workspace)
    const refused = await call(h, 'inkflow_settings_update', { backupKeep: 3 })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'CONFIRM_REQUIRED')
    assert.deepEqual(refused.pending, ['backupKeep'])
    assert.equal(existsSync(join(h.dataDir, 'settings.json')), false, 'a refusal writes nothing')
    assert.match(rendered(h, 'inkflow_settings_update', { backupKeep: 3 }, refused), /confirm: true/u)

    const saved = await call(h, 'inkflow_settings_update', { backupKeep: 3, authorName: '作者', confirm: true })
    assert.equal(saved.ok, true)
    assert.deepEqual(saved.changed, ['authorName', 'backupKeep'])
    assert.equal(settingsOf(h.dataDir).backupKeep, 3)
    assert.equal(hashTree(h.workspace), beforeBook, 'settings must never write inside a book')
    assert.match(rendered(h, 'inkflow_settings_update', { confirm: true }, saved), /设置已保存/u)

    const empty = await call(h, 'inkflow_settings_update', { confirm: true })
    assert.equal(empty.ok, false)
    assert.equal(empty.error.code, 'NOTHING_TO_UPDATE')
  } finally {
    h.cleanup()
  }
})

test('diagnostics export previews without writing, then writes one package on confirm', async () => {
  const h = harness()
  try {
    const beforeBook = hashTree(h.workspace)
    const refused = await call(h, 'inkflow_diagnostics_export', {})
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'CONFIRM_REQUIRED')
    assert.match(refused.preview.displayPath, /diagnostics/u)
    assert.equal(existsSync(join(h.dataDir, 'diagnostics')), false)
    assert.match(rendered(h, 'inkflow_diagnostics_export', {}, refused), /confirm: true/u)

    const exported = await call(h, 'inkflow_diagnostics_export', { confirm: true })
    assert.equal(exported.ok, true)
    assert.equal(existsSync(exported.path), true)
    const doc = JSON.parse(readFileSync(exported.path, 'utf8'))
    assert.equal(doc.format, 'inkflow-diagnostics/1')
    // The tool surface the package lists is the REAL registered one, including itself.
    assert.ok(doc.tools.entries.some((entry) => entry.name === 'inkflow_diagnostics_export'))
    assert.ok(doc.tools.count >= 36)
    assert.match(rendered(h, 'inkflow_diagnostics_export', { confirm: true }, exported), /诊断包已导出/u)
    assert.equal(hashTree(h.workspace), beforeBook, 'a diagnostics export must not write inside the book')
  } finally {
    h.cleanup()
  }
})

test('backup create: the entry list is shown before writing, and the write reports the package', async () => {
  const h = harness()
  try {
    const refused = await call(h, 'inkflow_backup_create', {})
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'CONFIRM_REQUIRED')
    assert.ok(refused.entries.includes('chapters/0001-a.md'))
    assert.match(rendered(h, 'inkflow_backup_create', {}, refused), /confirm: true/u)

    const created = await call(h, 'inkflow_backup_create', { confirm: true })
    assert.equal(created.ok, true, JSON.stringify(created))
    assert.equal(existsSync(created.path), true)
    assert.equal(created.files, created.entries.length)
    assert.equal(created.bookSlug, 'book')
    assert.match(rendered(h, 'inkflow_backup_create', { confirm: true }, created), /备份已创建/u)
  } finally {
    h.cleanup()
  }
})

test('backup restore: list → dry run (no bytes move) → confirm with the plan as baseline', async () => {
  const h = harness()
  try {
    const created = await call(h, 'inkflow_backup_create', { confirm: true })
    assert.equal(created.ok, true)

    // No `file`: the reply is the list, not an error.
    const listed = await call(h, 'inkflow_backup_restore', {})
    assert.equal(listed.ok, true)
    assert.equal(listed.needFile, true)
    assert.deepEqual(listed.backups.map((pack) => pack.file), [created.file])
    assert.match(rendered(h, 'inkflow_backup_restore', {}, listed), /备份包/u)

    // Damage the chapter, then dry-run: a plan, and not one byte written.
    writeFileSync(join(h.workspace, 'chapters', '0001-a.md'), '被改坏\n', 'utf8')
    const beforePlan = hashTree(h.workspace)
    const planned = await call(h, 'inkflow_backup_restore', { file: created.file })
    assert.equal(planned.ok, true)
    assert.equal(planned.dryRun, true)
    assert.equal(planned.plan.counts.overwrite, 1)
    assert.equal(hashTree(h.workspace), beforePlan, 'a dry run must not write')
    assert.match(rendered(h, 'inkflow_backup_restore', { file: created.file }, planned), /预览/u)

    // Confirm is still required for the write itself.
    const refused = await call(h, 'inkflow_backup_restore', { file: created.file, dryRun: false })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'CONFIRM_REQUIRED')
    assert.equal(hashTree(h.workspace), beforePlan)

    const expected = {}
    for (const entry of planned.plan.entries) {
      if (entry.action === 'same') continue
      expected[entry.path] = entry.current
    }
    const restored = await call(h, 'inkflow_backup_restore', { file: created.file, dryRun: false, confirm: true, expected })
    assert.equal(restored.ok, true, JSON.stringify(restored))
    assert.deepEqual(restored.restored, ['chapters/0001-a.md'])
    assert.equal(restored.index.ok, true)
    assert.equal(readFileSync(join(h.workspace, 'chapters', '0001-a.md'), 'utf8'), '---\ntitle: 一\nid: ch-1\n---\n\n正文\n')
    assert.match(rendered(h, 'inkflow_backup_restore', { confirm: true, dryRun: false }, restored), /恢复完成/u)
  } finally {
    h.cleanup()
  }
})

test('backup restore renders a conflict as a partial report rather than a bare failure', async () => {
  const h = harness()
  try {
    const created = await call(h, 'inkflow_backup_create', { confirm: true })
    assert.equal(created.ok, true)
    // Both files are IN the package (they existed when it was written), which is what
    // makes a restore plan name them at all.
    writeFileSync(join(h.workspace, 'chapters', '0001-a.md'), '第一版\n', 'utf8')
    writeFileSync(join(h.workspace, 'characters', '清音.md'), '角色第一版\n', 'utf8')

    const planned = await call(h, 'inkflow_backup_restore', { file: created.file })
    assert.equal(planned.ok, true)
    const expected = {}
    for (const entry of planned.plan.entries) {
      if (entry.action === 'same') continue
      expected[entry.path] = entry.current
    }
    assert.deepEqual(Object.keys(expected).sort(), ['chapters/0001-a.md', 'characters/清音.md'])
    // The author keeps writing one of them after seeing the plan.
    writeFileSync(join(h.workspace, 'characters', '清音.md'), '角色第二版（预览之后）\n', 'utf8')

    const conflicted = await call(h, 'inkflow_backup_restore', { file: created.file, dryRun: false, confirm: true, expected })
    assert.equal(conflicted.ok, false)
    assert.equal(conflicted.error.code, 'BACKUP_CONFLICT')
    assert.deepEqual(conflicted.conflicts.map((conflict) => conflict.path), ['characters/清音.md'])
    assert.ok(conflicted.restored.includes('chapters/0001-a.md'))
    const text = rendered(h, 'inkflow_backup_restore', { confirm: true, dryRun: false }, conflicted)
    assert.match(text, /冲突未覆盖 1 个/u)
    assert.match(text, /已恢复 1 个文件/u)
    // The author's newer text survived, and the other file is back.
    assert.equal(readFileSync(join(h.workspace, 'characters', '清音.md'), 'utf8'), '角色第二版（预览之后）\n')
    assert.equal(readFileSync(join(h.workspace, 'chapters', '0001-a.md'), 'utf8'), '---\ntitle: 一\nid: ch-1\n---\n\n正文\n')
  } finally {
    h.cleanup()
  }
})
