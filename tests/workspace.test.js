/**
 * The four-state workspace gate and the setup/repair wizard
 * (ADR-0006 D2/D3/D4).
 *
 * These run against the BUILT artifacts (lib/index.js), like the contract tests.
 * Every scenario builds a throwaway directory; the derived index is never
 * inspected here (see contract.test.js / index-build.test.js).
 *
 * The matrix:
 *   - empty directory            → needs-setup, plan lists everything, zero writes
 *   - apply                      → usable, real `git init`, no commit/remote, idempotent
 *   - broken inkflow.json        → needs-repair, original text shown, rebuild only after confirm
 *   - newer schemaVersion        → needs-newer-plugin, read-only, zero writes
 *   - ten directories + .gitkeep → usable
 *   - six-directory legacy shape → needs-repair, repair adds only the four new dirs
 *   - missing .gitkeep           → needs-repair, repair recreates only that file
 *   - book inside another repo   → own repo + "ignore it in the outer repo" notice
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

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
  return mkdtempSync(join(tmpdir(), 'inkflow-workspace-'))
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

function writeMeta(root, meta) {
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
}

/**
 * Scaffold a throwaway project shape. `dirs` lets a test build a legacy
 * six-directory book; `keeps: false` drops every .gitkeep.
 */
function scaffold(root, { git = true, dirs = ALL_DIRS, keeps = true, meta = true, title = '测试之书' } = {}) {
  mkdirSync(root, { recursive: true })
  if (git) mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of dirs) {
    mkdirSync(join(root, dir), { recursive: true })
    if (keeps) writeFileSync(join(root, dir, KEEP), '', 'utf8')
  }
  // An existing book already ignores its derived index; a repair must not have
  // to touch it, so this fixture keeps the repair assertions focused.
  writeFileSync(join(root, '.gitignore'), '# InkFlow derived index\nindex/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  if (meta === true) writeMeta(root, { schemaVersion: 1, title, author: 'tester' })
  else if (typeof meta === 'string') writeFileSync(join(root, 'inkflow.json'), meta, 'utf8')
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

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
}

/** A fresh repository has no commit and no remote: the wizard must not create one. */
function assertNoCommitNoRemote(root) {
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root, stdio: 'ignore', windowsHide: true })
  assert.notEqual(head.status, 0, 'git init must not create a commit')
  const remotes = git(['remote'], root)
  assert.equal(remotes.stdout.trim(), '', 'git init must not add a remote')
}

function assertCompleteTree(root) {
  for (const name of ALL_DIRS) {
    assert.ok(existsSync(join(root, name)), `${name}/ should exist`)
    assert.ok(existsSync(join(root, name, KEEP)), `${name}/${KEEP} should exist`)
  }
}

// ---------------------------------------------------------------------------
// 1. Empty directory → needs-setup; the plan is read-only
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1b. A plain git repository is not a broken book
// ---------------------------------------------------------------------------

test('gate: a git repository without any InkFlow layout is needs-setup, not needs-repair', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'code-repo')
    mkdirSync(root)
    assert.equal(git(['init'], root).status, 0, 'git init should succeed')
    writeFileSync(join(root, 'README.md'), '# a normal repository\n', 'utf8')
    const harness = makeTools(join(dir, 'state'), dir)

    const status = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    // Every source repository has a .git; treating it as a broken book made the
    // plugin tell users to "repair" repositories it never created.
    assert.equal(status.ok, false)
    assert.equal(status.error.state, 'needs-setup')
    assert.equal(status.error.code, 'NOT_AN_INKFLOW_PROJECT')
    // And the repair-only flag must not be set: setup, not repair, is the path.
    assert.equal(status.error.needsRepair, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('gate: an empty directory is needs-setup and the plan lists every action without writing', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '空书')
    mkdirSync(root)
    const harness = makeTools(join(dir, 'state'), dir)
    const before = hashTree(root)

    const plan = await callTool(harness, 'inkflow_project_plan', { projectRoot: root })
    assert.equal(plan.state, 'needs-setup')
    assert.equal(plan.readOnly, false)
    assert.deepEqual(plan.targetKind, 'directory')

    const types = new Set(plan.actions.map((action) => action.type))
    for (const type of ['git-init', 'create-dir', 'create-gitkeep', 'create-meta', 'create-gitignore']) {
      assert.ok(types.has(type), `the plan must include a ${type} action`)
    }
    for (const name of ALL_DIRS) {
      assert.ok(
        plan.actions.some((action) => action.type === 'create-dir' && action.path.endsWith(name)),
        `the plan must create ${name}/`,
      )
      assert.ok(
        plan.actions.some((action) => action.type === 'create-gitkeep' && action.path.endsWith(join(name, KEEP))),
        `the plan must create ${name}/${KEEP}`,
      )
    }
    assert.ok(plan.actions.some((action) => action.type === 'create-meta' && action.path.endsWith('inkflow.json')))
    assert.ok(plan.actions.some((action) => action.type === 'create-gitignore' && action.path.endsWith('.gitignore')))
    for (const action of plan.actions) assert.ok(action.reason.length > 0, 'every action explains why')

    // plan is a dry run: nothing on disk may move.
    assert.equal(hashTree(root), before)

    const status = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    assert.equal(status.ok, false)
    assert.equal(status.error.state, 'needs-setup')
    // Compatibility: needs-setup keeps the old code and flag.
    assert.equal(status.error.code, 'NOT_AN_INKFLOW_PROJECT')
    assert.equal(status.error.needsSetup, true)
    assert.equal(status.error.readOnly, false)
    assert.ok(Array.isArray(status.error.actions))
    assert.ok(status.error.missing.includes(`chapters/${KEEP}`), 'a missing .gitkeep is part of the checklist')
    assert.equal(hashTree(root), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. Apply: real git init, no commit/remote, idempotent
// ---------------------------------------------------------------------------

test('wizard: apply builds a usable book, runs git init only, and a second apply creates nothing', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '我的新书')
    mkdirSync(root)
    const harness = makeTools(join(dir, 'state'), dir)

    const blocked = await callTool(harness, 'inkflow_project_init', { root, title: '新书' })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.requiresConfirmation, true)
    assert.equal(blocked.error.code, 'INIT_REQUIRES_CONFIRMATION')
    assert.ok(blocked.willCreate.length > 0)
    assert.equal(existsSync(join(root, '.git')), false)
    assert.equal(existsSync(join(root, 'inkflow.json')), false)

    const applied = await callTool(harness, 'inkflow_project_init', { root, title: '新书', author: '作者', confirm: true })
    assert.equal(applied.ok, true)
    assert.equal(applied.state, 'usable')
    assert.equal(applied.gitInit, 'created')
    assertCompleteTree(root)
    assert.ok(applied.created.includes('inkflow.json'))
    assert.ok(applied.created.includes('.gitignore'))
    assert.ok(existsSync(join(root, '.git')), 'apply runs git init')
    assertNoCommitNoRemote(root)
    assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /index\/\*\.db/)
    const meta = JSON.parse(readFileSync(join(root, 'inkflow.json'), 'utf8'))
    assert.equal(meta.schemaVersion, 1)
    assert.equal(meta.title, '新书')
    assert.equal(meta.author, '作者')

    const again = await callTool(harness, 'inkflow_project_init', { root, title: '新书', confirm: true })
    assert.equal(again.ok, true)
    assert.deepEqual(again.created, [])
    assert.deepEqual(again.updated, [])
    for (const name of ALL_DIRS) {
      assert.ok(again.skipped.includes(name), `second apply skips ${name}/`)
      assert.ok(again.skipped.includes(`${name}/${KEEP}`), `second apply skips ${name}/${KEEP}`)
    }
    assert.ok(again.skipped.includes('inkflow.json'))
    assert.ok(again.skipped.includes('.gitignore'))
    assert.ok(again.skipped.includes('.git'))
    assert.equal(again.gitInit, 'already-initialised')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. Broken meta: show the original text, rebuild only after confirmation
// ---------------------------------------------------------------------------

test('wizard: a broken inkflow.json is shown first and rebuilt only after confirm', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '坏meta')
    scaffold(root)
    const broken = '{"schemaVersion": 1, "title": '
    writeFileSync(join(root, 'inkflow.json'), broken, 'utf8')
    const harness = makeTools(join(dir, 'state'), dir)

    const status = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    assert.equal(status.ok, false)
    assert.equal(status.error.state, 'needs-repair')
    assert.equal(status.error.code, 'PROJECT_NEEDS_REPAIR')
    assert.equal(status.error.needsSetup, false)
    assert.equal(status.error.metaRaw.text, broken)
    assert.equal(status.error.metaRaw.truncated, false)
    assert.equal(readFileSync(join(root, 'inkflow.json'), 'utf8'), broken)

    const plan = await callTool(harness, 'inkflow_project_plan', { projectRoot: root })
    assert.equal(plan.state, 'needs-repair')
    assert.equal(plan.metaRaw.text, broken)
    assert.ok(plan.actions.some((action) => action.type === 'create-meta'))

    const blocked = await callTool(harness, 'inkflow_project_init', { root, confirm: false })
    assert.equal(blocked.requiresConfirmation, true)
    assert.equal(blocked.metaRaw.text, broken)
    assert.equal(readFileSync(join(root, 'inkflow.json'), 'utf8'), broken)

    // No title is invented for a rebuilt meta.
    const untitled = await callTool(harness, 'inkflow_project_init', { root, confirm: true })
    assert.equal(untitled.ok, false)
    assert.equal(untitled.error.code, 'META_TITLE_REQUIRED')
    assert.equal(readFileSync(join(root, 'inkflow.json'), 'utf8'), broken)

    const repaired = await callTool(harness, 'inkflow_project_init', { root, title: '修好的书', confirm: true })
    assert.equal(repaired.ok, true)
    assert.equal(repaired.state, 'usable')
    assert.equal(JSON.parse(readFileSync(join(root, 'inkflow.json'), 'utf8')).title, '修好的书')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. Newer schemaVersion: terminal, read-only, zero writes
// ---------------------------------------------------------------------------

test('gate: a newer inkflow.json is needs-newer-plugin and no tool writes anything', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '未来之书')
    scaffold(root)
    writeMeta(root, { schemaVersion: 99, title: '未来之书' })
    const metaFile = join(root, 'inkflow.json')
    const original = readFileSync(metaFile, 'utf8')
    const before = hashTree(root)
    const harness = makeTools(join(dir, 'state'), dir)

    const status = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    assert.equal(status.ok, false)
    assert.equal(status.error.state, 'needs-newer-plugin')
    assert.equal(status.error.code, 'PROJECT_NEEDS_NEWER_PLUGIN')
    assert.equal(status.error.readOnly, true)
    assert.deepEqual(status.error.actions.map((action) => action.type), ['manual'])

    for (const tool of ['inkflow_index_rebuild', 'inkflow_chapter_list']) {
      const result = await callTool(harness, tool, { projectRoot: root })
      assert.equal(result.ok, false, `${tool} must refuse`)
      assert.equal(result.error.code, 'PROJECT_NEEDS_NEWER_PLUGIN')
      assert.equal(result.error.readOnly, true)
    }

    // Neither the gate nor the wizard may rewrite a file a newer plugin wrote.
    const wizard = await callTool(harness, 'inkflow_project_init', { root, title: '降级', confirm: true })
    assert.equal(wizard.ok, false)
    assert.equal(wizard.error.code, 'PROJECT_NEEDS_NEWER_PLUGIN')

    const plan = await callTool(harness, 'inkflow_project_plan', { projectRoot: root })
    assert.equal(plan.state, 'needs-newer-plugin')
    assert.equal(plan.readOnly, true)
    assert.deepEqual(plan.actions.map((action) => action.type), ['manual'])

    assert.equal(readFileSync(metaFile, 'utf8'), original)
    assert.equal(hashTree(root), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. Ten directories with .gitkeep → usable
// ---------------------------------------------------------------------------

test('gate: ten directories each carrying .gitkeep are usable', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '齐全的书')
    scaffold(root)
    const harness = makeTools(join(dir, 'state'), dir)
    const status = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    assert.equal(status.ok, true)
    assert.equal(status.state, 'usable')
    assert.equal(status.readOnly, false)
    assert.deepEqual(status.missing, [])
    for (const name of ALL_DIRS) {
      assert.equal(status.checks.dirs[name], true)
      assert.equal(status.checks.keeps[name], true)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. Legacy six-directory shape → needs-repair, repair adds only what is missing
// ---------------------------------------------------------------------------

test('wizard: a six-directory legacy book is needs-repair and repair adds only the four new directories', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '旧书')
    scaffold(root, { dirs: ['chapters', 'characters', 'world', 'outlines', 'index', 'library'] })
    const chapter = join(root, 'chapters', '0001-旧章.md')
    writeFileSync(chapter, '---\nid: old\nseq: 1\ntitle: 旧章\n---\n\n旧正文。\n', 'utf8')
    const metaBefore = readFileSync(join(root, 'inkflow.json'), 'utf8')
    const chapterBefore = readFileSync(chapter, 'utf8')
    const harness = makeTools(join(dir, 'state'), dir)

    const status = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    assert.equal(status.ok, false)
    assert.equal(status.error.state, 'needs-repair')
    for (const name of ['foreshadowing', 'timeline', 'relations', 'facts']) {
      assert.ok(status.error.missing.includes(name), `missing list names ${name}`)
      assert.ok(status.error.missing.includes(`${name}/${KEEP}`), `missing list names ${name}/${KEEP}`)
    }

    const repaired = await callTool(harness, 'inkflow_project_init', { root, confirm: true })
    assert.equal(repaired.ok, true)
    assert.equal(repaired.state, 'usable')
    assert.deepEqual(repaired.created.slice().sort(), [
      'facts',
      `facts/${KEEP}`,
      'foreshadowing',
      `foreshadowing/${KEEP}`,
      'relations',
      `relations/${KEEP}`,
      'timeline',
      `timeline/${KEEP}`,
    ])
    // Repair never rewrites what is already there.
    assert.equal(readFileSync(join(root, 'inkflow.json'), 'utf8'), metaBefore)
    assert.equal(readFileSync(chapter, 'utf8'), chapterBefore)
    assert.ok(repaired.skipped.includes('inkflow.json'))
    assert.deepEqual(repaired.updated, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7. A missing .gitkeep alone is structure missing (git drops empty dirs)
// ---------------------------------------------------------------------------

test('wizard: a missing .gitkeep is needs-repair and repair recreates only that file', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '缺gitkeep')
    scaffold(root)
    rmSync(join(root, 'timeline', KEEP))
    const harness = makeTools(join(dir, 'state'), dir)

    const status = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    assert.equal(status.ok, false)
    assert.equal(status.error.state, 'needs-repair')
    assert.deepEqual(status.error.missing, [`timeline/${KEEP}`])

    const repaired = await callTool(harness, 'inkflow_project_init', { root, confirm: true })
    assert.equal(repaired.ok, true)
    assert.deepEqual(repaired.created, [`timeline/${KEEP}`])
    assert.equal(existsSync(join(root, 'timeline', KEEP)), true)

    const after = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    assert.equal(after.ok, true)
    assert.equal(after.state, 'usable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 8. Book inside an outer repository: own repo + "ignore it outside" notice
// ---------------------------------------------------------------------------

test('wizard: a book inside another repository gets its own repo and an outer-.gitignore notice', async () => {
  const dir = workdir()
  try {
    const outer = join(dir, '外层仓库')
    const root = join(outer, '内层书')
    mkdirSync(outer, { recursive: true })
    mkdirSync(join(outer, '.git'))
    writeFileSync(join(outer, 'notes.txt'), '外层文件\n', 'utf8')
    mkdirSync(root)
    const harness = makeTools(join(dir, 'state'), outer)

    const plan = await callTool(harness, 'inkflow_project_plan', { projectRoot: root })
    assert.ok(plan.actions.some((action) => action.type === 'git-init'), 'a book is always its own repository')
    assert.ok(
      plan.notices.some((notice) => notice.includes('.gitignore')),
      'the plan must tell the user to ignore the book from the outer repository',
    )

    const applied = await callTool(harness, 'inkflow_project_init', { root, title: '内层书', confirm: true })
    assert.equal(applied.ok, true)
    assert.equal(existsSync(join(root, '.git')), true)
    assertNoCommitNoRemote(root)
    // Files outside the book root are never touched by the wizard.
    assert.equal(readFileSync(join(outer, 'notes.txt'), 'utf8'), '外层文件\n')
    assert.equal(existsSync(join(outer, '.gitignore')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 9. A very long broken meta is echoed truncated, never silently swallowed
// ---------------------------------------------------------------------------

test('wizard: a broken meta longer than the echo cap is returned truncated and marked', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '超长meta')
    scaffold(root)
    const broken = `{"schemaVersion": 1, "title": "${'x'.repeat(6000)}`
    writeFileSync(join(root, 'inkflow.json'), broken, 'utf8')
    const harness = makeTools(join(dir, 'state'), dir)

    const status = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    assert.equal(status.error.state, 'needs-repair')
    assert.equal(status.error.metaRaw.truncated, true)
    assert.ok(status.error.metaRaw.text.length < broken.length)
    assert.ok(status.error.metaRaw.text.length > 0)
    assert.equal(readFileSync(join(root, 'inkflow.json'), 'utf8'), broken)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 10. Only index/ missing: still usable, plan stays read-only, gate recreates it
// ---------------------------------------------------------------------------

test('gate: a derived index/ alone never changes the state and the plan does not write it', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '缺索引')
    scaffold(root, { dirs: CONTENT_DIRS })
    const harness = makeTools(join(dir, 'state'), dir)
    const before = hashTree(root)

    const plan = await callTool(harness, 'inkflow_project_plan', { projectRoot: root })
    assert.equal(plan.state, 'usable')
    assert.ok(plan.actions.some((action) => action.type === 'create-dir' && action.path.endsWith(INDEX_DIR)))
    assert.equal(hashTree(root), before)

    const status = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    assert.equal(status.ok, true)
    assert.equal(status.indexDirRecreated, true)
    assert.equal(existsSync(join(root, INDEX_DIR, KEEP)), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 11. Root resolution walks up on the meta/.git signal, not on a full tree
// ---------------------------------------------------------------------------

test('resolution: a session inside a legacy book finds its root instead of its own directory', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '旧书')
    // Legacy six-directory shape: requiring the full tree while walking up would
    // skip this book and answer "needs-setup" for the session's subdirectory.
    scaffold(root, { dirs: ['chapters', 'characters', 'world', 'outlines', 'index', 'library'] })
    const session = join(root, 'chapters')
    const harness = makeTools(join(dir, 'state'), session)

    const plan = await callTool(harness, 'inkflow_project_plan', {})
    assert.equal(plan.root, root)
    assert.equal(plan.state, 'needs-repair')

    const status = await callTool(harness, 'inkflow_project_status', {})
    assert.equal(status.ok, false)
    assert.equal(status.error.root, root)
    assert.equal(status.error.state, 'needs-repair')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 12. A .gitignore that lacks one ignore rule is extended, never rewritten
// ---------------------------------------------------------------------------

test('wizard: an existing .gitignore only gains the missing derived-index rules', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '缺ignore规则')
    scaffold(root)
    const gitignore = join(root, '.gitignore')
    const original = '# 我自己的规则\n*.bak\nindex/*.db\n'
    writeFileSync(gitignore, original, 'utf8')
    const harness = makeTools(join(dir, 'state'), dir)

    // .gitignore is not part of the gate, so the book is already usable.
    const status = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    assert.equal(status.ok, true)
    assert.equal(status.state, 'usable')

    const plan = await callTool(harness, 'inkflow_project_plan', { projectRoot: root })
    assert.ok(plan.actions.some((action) => action.type === 'create-gitignore'))

    const repaired = await callTool(harness, 'inkflow_project_init', { root, confirm: true })
    assert.equal(repaired.ok, true)
    assert.deepEqual(repaired.created, [])
    assert.deepEqual(repaired.updated, ['.gitignore'])

    const text = readFileSync(gitignore, 'utf8')
    assert.ok(text.startsWith(original), 'existing lines are kept verbatim, in order')
    assert.match(text, /index\/\*\.db-wal/)
    assert.match(text, /index\/\*\.db-shm/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 13. Write-back verification of inkflow.json
//
// "Written" is not "readable as written": a hand-written or foreign-encoding meta
// used to be discovered only when the next tool call refused the directory. The
// wizard now re-reads the file it just wrote and reports what landed, without
// ever rewriting or rolling back the author's file.
// ---------------------------------------------------------------------------

test('wizard: a written title is read back and verified', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '回读书')
    mkdirSync(root)
    const harness = makeTools(join(dir, 'state'), dir)

    const applied = await callTool(harness, 'inkflow_project_init', { root, title: '人在蜀山，我是掌门', confirm: true })
    assert.equal(applied.ok, true)
    assert.equal(applied.metaVerified, true)
    assert.deepEqual(applied.warnings, [])

    // No title asked for → nothing to verify: the field stays absent rather than
    // claiming a verification that never happened.
    const noTitle = await callTool(harness, 'inkflow_project_init', { root, confirm: true })
    assert.equal(noTitle.ok, true)
    assert.equal(noTitle.metaVerified, undefined)
    assert.deepEqual(noTitle.warnings, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('wizard: a title that does not land on disk is META_READBACK_MISMATCH and the file is not touched', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '不改写')
    scaffold(root, { title: '原来的名字' })
    const metaFile = join(root, 'inkflow.json')
    const before = readFileSync(metaFile, 'utf8')
    const harness = makeTools(join(dir, 'state'), dir)

    // The wizard never replaces a usable meta, so this title cannot land. Saying
    // so beats answering "ok" while the disk holds something else.
    const applied = await callTool(harness, 'inkflow_project_init', { root, title: '另一个名字', confirm: true })
    assert.equal(applied.ok, true)
    assert.equal(applied.metaVerified, false)
    assert.equal(applied.warnings.length, 1)
    const [warning] = applied.warnings
    assert.equal(warning.code, 'META_READBACK_MISMATCH')
    assert.equal(warning.requested, '另一个名字')
    assert.equal(warning.onDisk, '原来的名字')
    assert.equal(typeof warning.message, 'string')

    assert.equal(readFileSync(metaFile, 'utf8'), before, 'a mismatch never rewrites or rolls back the file')
    assert.equal(JSON.parse(readFileSync(metaFile, 'utf8')).title, '原来的名字')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('wizard: a title that is itself GBK mojibake is flagged, written as asked, and never rewritten', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '乱码书')
    mkdirSync(root)
    const harness = makeTools(join(dir, 'state'), dir)
    // The exact shape from the field report.
    const garbled = '浜哄湪铚€灞憋紝鏄帉闂?'

    const applied = await callTool(harness, 'inkflow_project_init', { root, title: garbled, confirm: true })
    assert.equal(applied.ok, true)
    assert.equal(applied.metaVerified, true, 'the bytes that landed are the bytes we asked for')
    assert.equal(applied.warnings.length, 1)
    assert.equal(applied.warnings[0].code, 'META_ENCODING_SUSPECT')
    assert.equal(applied.warnings[0].title, garbled)
    assert.ok(applied.warnings[0].hits.length >= 2, 'the warning carries the matched artifact groups')
    assert.equal(applied.warnings[0].hint.includes('UTF-8'), true, 'the hint names the fix')

    // Warning only: the author's title is never silently "repaired".
    assert.equal(JSON.parse(readFileSync(join(root, 'inkflow.json'), 'utf8')).title, garbled)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('wizard: whitespace and NFC differences are not a mismatch', async () => {
  const dir = workdir()
  try {
    const root = join(dir, '空白归一')
    // U+3000 IDEOGRAPHIC SPACE: what a Windows IME or a copy-paste produces.
    scaffold(root, { title: '蜀山\u3000剑仙' })
    const harness = makeTools(join(dir, 'state'), dir)

    const applied = await callTool(harness, 'inkflow_project_init', { root, title: '  蜀山 剑仙  ', confirm: true })
    assert.equal(applied.ok, true)
    assert.equal(applied.metaVerified, true, 'trim + whitespace folding + NFC make these the same title')
    assert.deepEqual(applied.warnings, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
