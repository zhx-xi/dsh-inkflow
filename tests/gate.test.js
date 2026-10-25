/**
 * The four-state gate, item by item (conventions.md §1, ADR-0006 D2).
 *
 * The gate is the plugin's only identity check, so "ten directories" has to mean
 * ten *individually reported* items, not one aggregate boolean. Every fixture
 * here starts from a complete book and removes exactly one thing, so a failure
 * names the item that is not wired up.
 *
 * Existing coverage this file deliberately builds on (not repeats):
 *   - workspace.test.js: empty directory → needs-setup, plan is read-only
 *   - workspace.test.js: newer meta, complete tree → read-only, zero writes
 *   - workspace.test.js: ten directories → usable
 *   - workspace.test.js: one missing .gitkeep → repair recreates only that file
 *   - workspace.test.js: only index/ missing → usable, gate recreates it
 *
 * New here: one subtest per required directory, one subtest per `.gitkeep`,
 * the ten-item identity of `checks.dirs`, the exact single-gap repair, and the
 * precedence of `needs-newer-plugin` over a half-missing tree (zero writes).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

// ADR-0006 D1: nine content directories plus index/, each carrying .gitkeep.
const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const INDEX_DIR = 'index'
const ALL_DIRS = [...CONTENT_DIRS, INDEX_DIR]
const KEEP = '.gitkeep'

function createHarness(workspace) {
  const tools = new Map()
  const disposes = []
  const ctx = {
    effect(setup) {
      const dispose = setup()
      disposes.push(() => {
        if (typeof dispose === 'function') dispose()
      })
      return () => {}
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    get(name) {
      // The session workspace is the trust anchor for an explicit projectRoot.
      if (name === 'workingDirectory' && typeof workspace === 'string') {
        return { ensure: async () => workspace }
      }
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
  return { ctx, tools }
}

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-gate-'))
}

function makeTools(dataDir, workspace) {
  const harness = createHarness(workspace)
  apply(harness.ctx, { dataDir })
  return harness
}

async function callTool(harness, toolName, args) {
  const tool = harness.tools.get(toolName)
  assert.ok(tool, `tool ${toolName} must be registered`)
  return tool.execute(args, { signal: AbortSignal.timeout(15000), agent: { id: 'test-session' } })
}

/** A complete, usable book. Tests then remove exactly one thing from it. */
function book(root, { dirs = ALL_DIRS, keeps = true, meta = { schemaVersion: 1, title: '门禁之书' }, git = true } = {}) {
  mkdirSync(root, { recursive: true })
  if (git) mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of dirs) {
    mkdirSync(join(root, dir), { recursive: true })
    if (keeps) writeFileSync(join(root, dir, KEEP), '', 'utf8')
  }
  writeFileSync(join(root, '.gitignore'), '# InkFlow derived index\nindex/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  if (meta !== false) writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  return root
}

/** Stable fingerprint of a directory tree: names, kinds, sizes, mtimes. */
function hashTree(root) {
  const hash = createHash('sha256')
  const walk = (relative) => {
    const dir = relative === '' ? root : join(root, relative)
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      const info = statSync(join(root, child))
      hash.update(`${child}|${entry.isDirectory() ? 'd' : 'f'}|${info.size}|${info.mtimeMs}\n`)
      if (entry.isDirectory()) walk(child)
    }
  }
  walk('')
  return hash.digest('hex')
}

// ---------------------------------------------------------------------------
// 1. Ten items — and they are individually addressable
// ---------------------------------------------------------------------------

test('gate: a git repo with the ten directories is usable and reports exactly ten checked dirs', async () => {
  const dir = workdir()
  try {
    const root = book(join(dir, '齐全的书'))
    const harness = makeTools(join(dir, 'state'), dir)

    const status = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    assert.equal(status.ok, true)
    assert.equal(status.state, 'usable')
    assert.deepEqual(status.missing, [])
    assert.equal(status.checks.git, true)
    assert.deepEqual(Object.keys(status.checks.dirs).sort(), [...ALL_DIRS].sort())
    assert.deepEqual(Object.keys(status.checks.keeps).sort(), [...ALL_DIRS].sort())
    for (const name of ALL_DIRS) {
      assert.equal(status.checks.dirs[name], true, `${name}/ must be checked as present`)
      assert.equal(status.checks.keeps[name], true, `${name}/${KEEP} must be checked as present`)
      assert.equal(existsSync(join(root, name, KEEP)), true)
      assert.equal(statSync(join(root, name, KEEP)).size, 0, `${name}/${KEEP} stays an empty marker`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. Each required directory missing on its own
// ---------------------------------------------------------------------------

test('gate: each content directory missing on its own is reported as two missing items', async (t) => {
  for (const missingDir of CONTENT_DIRS) {
    await t.test(`missing ${missingDir}/ → needs-repair`, async () => {
      const dir = workdir()
      try {
        const root = book(join(dir, '缺一目录'), { dirs: ALL_DIRS.filter((name) => name !== missingDir) })
        const harness = makeTools(join(dir, 'state'), dir)

        const status = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
        assert.equal(status.ok, false)
        assert.equal(status.error.state, 'needs-repair')
        assert.equal(status.error.code, 'PROJECT_NEEDS_REPAIR')
        // A missing directory implies its missing marker: both are part of the
        // checklist, and nothing else may be reported.
        assert.deepEqual(status.error.missing, [missingDir, `${missingDir}/${KEEP}`])
        assert.deepEqual(status.error.actions.map((action) => action.type), ['create-dir', 'create-gitkeep'])
        assert.equal(status.error.actions[0].path.endsWith(missingDir), true)
        assert.equal(status.error.actions[1].path.endsWith(join(missingDir, KEEP)), true)
        assert.equal(status.error.checks.dirs[missingDir], false)
        assert.equal(status.error.checks.keeps[missingDir], false)
        for (const other of ALL_DIRS.filter((name) => name !== missingDir)) {
          assert.equal(status.error.checks.dirs[other], true, `${other}/ must stay present and reported`)
          assert.equal(status.error.checks.keeps[other], true, `${other}/${KEEP} must stay present`)
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }

  await t.test(`missing ${INDEX_DIR}/ → usable (derived, recreated by the gate)`, async () => {
    const dir = workdir()
    try {
      const root = book(join(dir, '缺索引'), { dirs: CONTENT_DIRS })
      const harness = makeTools(join(dir, 'state'), dir)
      assert.equal(existsSync(join(root, INDEX_DIR, KEEP)), false)

      const status = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
      // The one documented relaxation (ADR-0006 D2): a derived directory must
      // never turn a complete book into "broken".
      assert.equal(status.ok, true)
      assert.equal(status.state, 'usable')
      assert.equal(status.indexDirRecreated, true)
      assert.equal(status.checks.dirs[INDEX_DIR], true)
      assert.equal(status.checks.keeps[INDEX_DIR], true)
      assert.equal(existsSync(join(root, INDEX_DIR, KEEP)), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('gate: one missing directory is repaired with exactly two actions, nothing else', async () => {
  const dir = workdir()
  try {
    const root = book(join(dir, '缺伏笔目录'), { dirs: ALL_DIRS.filter((name) => name !== 'foreshadowing') })
    const harness = makeTools(join(dir, 'state'), dir)

    const repaired = await callTool(harness, 'inkflow_project_init', { root, confirm: true })
    assert.equal(repaired.ok, true)
    assert.equal(repaired.state, 'usable')
    assert.deepEqual(repaired.created.slice().sort(), ['foreshadowing', `foreshadowing/${KEEP}`])
    assert.deepEqual(repaired.updated, [])
    for (const name of ALL_DIRS.filter((dirName) => dirName !== 'foreshadowing')) {
      assert.ok(repaired.skipped.includes(name), `${name}/ must be skipped, never rewritten`)
    }
    assert.ok(repaired.skipped.includes('inkflow.json'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. Each required `.gitkeep` missing on its own (git drops empty directories)
// ---------------------------------------------------------------------------

test('gate: each missing .gitkeep on its own is one missing item, never a missing directory', async (t) => {
  for (const keepDir of ALL_DIRS) {
    await t.test(`missing ${keepDir}/${KEEP} → needs-repair`, async () => {
      const dir = workdir()
      try {
        const root = book(join(dir, '缺标记'))
        rmSync(join(root, keepDir, KEEP))
        const harness = makeTools(join(dir, 'state'), dir)

        const status = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
        assert.equal(status.ok, false)
        assert.equal(status.error.state, 'needs-repair')
        assert.deepEqual(status.error.missing, [`${keepDir}/${KEEP}`])
        assert.equal(status.error.checks.dirs[keepDir], true) // the directory itself is fine
        assert.equal(status.error.checks.keeps[keepDir], false)
        // One gap → one action: recreate that marker, touch nothing else.
        assert.deepEqual(status.error.actions.map((action) => action.type), ['create-gitkeep'])
        assert.equal(status.error.actions[0].path.endsWith(join(keepDir, KEEP)), true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})

// ---------------------------------------------------------------------------
// 4. Precedence: a newer meta wins over a half-missing tree, and writes nothing
// ---------------------------------------------------------------------------

test('gate: a newer inkflow.json outranks needs-repair and the whole check stays read-only', async () => {
  const dir = workdir()
  try {
    // Half a tree: no .git, three of nine content directories, no index/, and a
    // meta a future plugin wrote. Precedence says "upgrade the plugin", not
    // "repair" and not "set up".
    const root = book(join(dir, '未来之书'), {
      git: false,
      dirs: ['chapters', 'characters', 'world'],
      meta: { schemaVersion: 99, title: '未来之书' },
    })
    const before = hashTree(root)
    const harness = makeTools(join(dir, 'state'), dir)

    const status = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    assert.equal(status.ok, false)
    assert.equal(status.error.state, 'needs-newer-plugin')
    assert.equal(status.error.code, 'PROJECT_NEEDS_NEWER_PLUGIN')
    assert.equal(status.error.readOnly, true)
    assert.equal(status.error.needsSetup, false)
    assert.equal(status.error.needsRepair, false)
    assert.deepEqual(status.error.actions.map((action) => action.type), ['manual'])
    // The meta is *not* missing — it is too new, which is a different next step.
    assert.equal(status.error.missing.includes('inkflow.json'), false)
    assert.ok(status.error.missing.includes('.git'))
    assert.match(status.error.metaError, /newer than this plugin/)

    // Zero writes: no directory, no .gitkeep, no index/ — not even the relaxed
    // index/ recreation allowed to every other state.
    assert.equal(hashTree(root), before)
    assert.equal(existsSync(join(root, INDEX_DIR)), false)
    assert.equal(existsSync(join(root, 'foreshadowing')), false)
    assert.equal(existsSync(join(root, '.git')), false)

    // A rebuild must refuse too: this state is a terminal, not "repair me".
    const rebuild = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
    assert.equal(rebuild.ok, false)
    assert.equal(rebuild.error.code, 'PROJECT_NEEDS_NEWER_PLUGIN')
    assert.equal(hashTree(root), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
