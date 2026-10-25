/**
 * Write-time compare-and-swap (CAS) on project files, part 2.
 *
 * The hole: a tool wrote whatever it had in memory over whatever was on disk.
 * Between "the model read the chapter" and "the tool wrote it", a human can save
 * the file in their editor; the write then silently discards that edit. The
 * reverse case matters too: two sessions initialising the same directory race
 * for `inkflow.json`.
 *
 * The contract these tests pin: a write carries the baseline it expects
 * (`size` / `mtimeMs` / `sha256`), the baseline is verified **inside** the write
 * lock against the bytes that are about to be replaced, and a mismatch is the
 * structured error `FILE_CHANGED` with **zero writes** — the target file, the
 * catalog and the index are all byte-identical afterwards.
 *
 * They run against the built artifact (lib/index.js).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, fingerprintFile } from '../lib/index.js'

const ALL_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-cas-'))
}

function createHarness(workspace) {
  const tools = new Map()
  const ctx = {
    effect(setup) {
      const dispose = setup()
      if (typeof dispose === 'function') dispose()
      return () => {}
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
  apply(ctx, { dataDir: join(workspace, '.state') })
  return { ctx, tools }
}

async function callTool(harness, toolName, args) {
  const tool = harness.tools.get(toolName)
  assert.ok(tool, `tool ${toolName} must be registered`)
  return tool.execute(args, { signal: AbortSignal.timeout(10_000), agent: { id: 'test-session' } })
}

function project(dir) {
  const root = join(dir, 'book')
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const name of ALL_DIRS) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: 'CAS 之书' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.gitignore'), 'index/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  writeFileSync(join(root, 'outlines', 'overall.md'), '---\nid: ov\nkind: overall\ntitle: 总纲\n---\n\n- 起\n', 'utf8')
  writeFileSync(join(root, 'chapters', '0001-入山.md'), '---\nid: ch-1\nseq: 1\ntitle: 第一章 入山\n---\n\n他走进白鹤门。\n', 'utf8')
  return root
}

/**
 * Stable content hash of the project tree: any *write* moves it.
 *
 * Directory mtimes are deliberately excluded: taking the project write lock
 * creates and removes `index/.write.lock`, which moves the `index/` directory's
 * mtime without writing a single byte of the book. File names, sizes and mtimes
 * are included, so a created, deleted or edited file still fails the comparison.
 */
function hashTree(root) {
  const hash = createHash('sha256')
  const walk = (relative) => {
    const dir = relative === '' ? root : join(root, relative)
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        hash.update(`${child}|d\n`)
        walk(child)
        continue
      }
      const info = statSync(join(root, child))
      hash.update(`${child}|f|${info.size}|${info.mtimeMs}\n`)
    }
  }
  walk('')
  return hash.digest('hex')
}

function sha256Of(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

// ---------------------------------------------------------------------------
// 1. chapter_write
// ---------------------------------------------------------------------------

test('cas: a chapter edited outside the plugin refuses the write, zero writes', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const harness = createHarness(dir)
    const file = 'chapters/0001-入山.md'
    const absolute = join(root, file)

    // What the model last saw.
    const seen = fingerprintFile(absolute)
    assert.equal(typeof seen.sha256, 'string')

    // The author saves the file in their editor.
    const edited = '---\nid: ch-1\nseq: 1\ntitle: 第一章 入山（作者改过）\n---\n\n他走进白鹤门，回头看了一眼。\n'
    writeFileSync(absolute, edited, 'utf8')
    const before = hashTree(root)

    const refused = await callTool(harness, 'inkflow_chapter_write', {
      projectRoot: root,
      file,
      body: 'AI 重写的正文。',
      expected: { sha256: seen.sha256, size: seen.size },
    })

    assert.equal(refused.ok, false, 'a stale baseline must not be written over')
    assert.equal(refused.error.code, 'FILE_CHANGED')
    assert.equal(refused.error.path, file)
    assert.equal(refused.error.nothingWritten, true)
    assert.equal(refused.error.expected.sha256, seen.sha256)
    assert.equal(refused.error.current.sha256, sha256Of(edited), 'the error carries what is actually on disk')
    assert.deepEqual(refused.error.changed.sort(), ['sha256', 'size'].sort())

    assert.equal(readFileSync(absolute, 'utf8'), edited, 'the author edit survives')
    assert.equal(hashTree(root), before, 'nothing was written: no file, no catalog, no index')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cas: a matching baseline (sha256 + size + mtimeMs) writes normally', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const harness = createHarness(dir)
    const file = 'chapters/0001-入山.md'
    const absolute = join(root, file)
    const seen = fingerprintFile(absolute)

    const written = await callTool(harness, 'inkflow_chapter_write', {
      projectRoot: root,
      file,
      body: '他走进白鹤门，没有再回头。\n',
      expected: { sha256: seen.sha256, size: seen.size, mtimeMs: seen.mtimeMs },
    })

    assert.equal(written.ok, true, JSON.stringify(written.error))
    assert.deepEqual(written.changed, ['body'])
    assert.match(readFileSync(absolute, 'utf8'), /没有再回头/)
    // The result hands back the new baseline, so the next CAS call has one.
    assert.equal(written.fingerprint.sha256, sha256Of(readFileSync(absolute, 'utf8')))
    assert.equal(written.fingerprint.size, statSync(absolute).size)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cas: only the fields the caller passed are compared', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const harness = createHarness(dir)
    const file = 'chapters/0001-入山.md'
    const absolute = join(root, file)
    const seen = fingerprintFile(absolute)

    // A stale size with the right content still matches: sha256 wins when given.
    const written = await callTool(harness, 'inkflow_chapter_write', {
      projectRoot: root,
      file,
      status: 'revised',
      expected: { sha256: seen.sha256 },
    })
    assert.equal(written.ok, true, JSON.stringify(written.error))
    assert.deepEqual(written.changed, ['status'])

    const refused = await callTool(harness, 'inkflow_chapter_write', {
      projectRoot: root,
      file,
      body: 'x',
      expected: { size: seen.size + 99 },
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'FILE_CHANGED')
    assert.deepEqual(refused.error.changed, ['size'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cas: an empty expected object changes nothing about the old behaviour', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const harness = createHarness(dir)

    const written = await callTool(harness, 'inkflow_chapter_write', {
      projectRoot: root,
      file: 'chapters/0001-入山.md',
      body: '新的正文。\n',
    })
    assert.equal(written.ok, true, JSON.stringify(written.error))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. chapter_move / chapter_delete
// ---------------------------------------------------------------------------

test('cas: chapter_move refuses when the source file moved under it', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const harness = createHarness(dir)
    const file = 'chapters/0001-入山.md'
    const absolute = join(root, file)
    const seen = fingerprintFile(absolute)

    writeFileSync(absolute, '---\nid: ch-1\nseq: 1\ntitle: 第一章 入山\n---\n\n外部改过的正文。\n', 'utf8')
    const before = hashTree(root)

    const refused = await callTool(harness, 'inkflow_chapter_move', {
      projectRoot: root,
      file,
      volumeId: null,
      expected: { sha256: seen.sha256 },
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'FILE_CHANGED')
    assert.equal(refused.error.nothingWritten, true)
    assert.equal(hashTree(root), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cas: chapter_delete refuses to delete a file that changed under it', async () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const harness = createHarness(dir)
    const file = 'chapters/0001-入山.md'
    const absolute = join(root, file)
    const seen = fingerprintFile(absolute)

    writeFileSync(absolute, '---\nid: ch-1\nseq: 1\ntitle: 第一章 入山\n---\n\n不许删我。\n', 'utf8')
    const before = hashTree(root)

    const refused = await callTool(harness, 'inkflow_chapter_delete', {
      projectRoot: root,
      file,
      expected: { sha256: seen.sha256, size: seen.size },
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'FILE_CHANGED')
    assert.match(readFileSync(absolute, 'utf8'), /不许删我/, 'the file is still there')
    assert.equal(hashTree(root), before)

    // With the right baseline the delete goes through.
    const current = fingerprintFile(absolute)
    const deleted = await callTool(harness, 'inkflow_chapter_delete', {
      projectRoot: root,
      file,
      expected: { sha256: current.sha256 },
    })
    assert.equal(deleted.ok, true, JSON.stringify(deleted.error))
    assert.equal(deleted.deleted.file, file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. Project initialisation (two sessions, one directory)
// ---------------------------------------------------------------------------

test('cas: project_init refuses when another session created inkflow.json first', async () => {
  const dir = workdir()
  try {
    const target = join(dir, 'fresh-book')
    mkdirSync(target, { recursive: true })
    const harness = createHarness(dir)

    const planned = await callTool(harness, 'inkflow_project_plan', { projectRoot: target })
    assert.equal(planned.ok, true)
    assert.equal(planned.targetKind, 'directory', `expected an init plan: ${JSON.stringify(planned)}`)
    assert.equal(planned.metaFingerprint, null, 'no inkflow.json yet')

    // The other session wins the race while this one waits for the user.
    writeFileSync(join(target, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '别人的书' }, null, 2)}\n`, 'utf8')
    const before = hashTree(target)

    const refused = await callTool(harness, 'inkflow_project_init', {
      root: target,
      title: '我的书',
      confirm: true,
      expected: { absent: true },
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'FILE_CHANGED')
    assert.equal(refused.error.path, 'inkflow.json')
    assert.equal(hashTree(target), before, 'zero writes: no directories, no git, no meta')
    assert.match(readFileSync(join(target, 'inkflow.json'), 'utf8'), /别人的书/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cas: project_init proceeds when the baseline it was given still holds', async () => {
  const dir = workdir()
  try {
    const target = join(dir, 'fresh-book')
    mkdirSync(target, { recursive: true })
    const harness = createHarness(dir)

    const planned = await callTool(harness, 'inkflow_project_plan', { projectRoot: target })
    assert.equal(planned.metaFingerprint, null)

    const applied = await callTool(harness, 'inkflow_project_init', {
      root: target,
      title: '我的书',
      confirm: true,
      expected: { absent: true },
    })
    assert.equal(applied.ok, true, JSON.stringify(applied.error))
    assert.equal(applied.state, 'usable')
    assert.match(readFileSync(join(target, 'inkflow.json'), 'utf8'), /我的书/)

    // Now that the file exists, the plan hands out its fingerprint, and a
    // second init with that baseline is a no-op (nothing left to create).
    const replanned = await callTool(harness, 'inkflow_project_plan', { projectRoot: target })
    assert.equal(replanned.metaFingerprint.sha256, fingerprintFile(join(target, 'inkflow.json')).sha256)

    const again = await callTool(harness, 'inkflow_project_init', {
      root: target,
      title: '我的书',
      confirm: true,
      expected: { sha256: replanned.metaFingerprint.sha256 },
    })
    assert.equal(again.ok, true, JSON.stringify(again.error))
    assert.deepEqual(again.created, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
