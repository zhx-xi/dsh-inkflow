/**
 * The 6→9 migrator and the rollback package it leaves behind.
 *
 * The acceptance criteria this file pins down are all about **sets and bytes**, not
 * counts:
 *
 *   1. `plan` is a pure read (`hashTree`, mtimes included) and its action list is
 *      compared to `apply`'s applied list as a **set of `op path` keys** — a step
 *      that silently does nothing cannot hide behind an equal length;
 *   2. content files (`chapters/**`, `world/**`) keep their bytes: the migration only
 *      adds directories and edits the two metadata files;
 *   3. a rollback from the package restores the book byte for byte, including after
 *      an interrupted run (the partial state is undone from the manifest);
 *   4. a rollback refuses to overwrite a file that somebody edited after the run.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyMigration, listBackups, planMigration, readBackup, rollbackMigration } from '../lib/index.js'
import { hashTree } from './hash-tree.mjs'
import { changedPaths, fileDigests } from './tree-digest.mjs'

/** The older layout: six directories, no `foreshadowing/ timeline/ relations/ facts/`. */
const LEGACY_DIRS = ['chapters', 'characters', 'world', 'outlines', 'library', 'index']

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-migrate-'))
}

function writeMarkdown(root, relativePath, frontmatterLines, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = frontmatterLines.length > 0 ? `---\n${frontmatterLines.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

/** A legacy six-directory book: no `.git` yet, `schemaVersion: 0`, one ignore line, no new dirs. */
function legacyBook() {
  const root = workdir()
  for (const dir of LEGACY_DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(
    join(root, 'inkflow.json'),
    `${JSON.stringify({ schemaVersion: 0, title: '老书', author: '作者', createdAt: '2026-01-01T00:00:00.000Z' }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(join(root, '.gitignore'), 'index/*.db\n', 'utf8')
  writeMarkdown(root, 'chapters/vol-01/0001-甲.md', ['id: ch-1', 'title: 甲', 'seq: 1'], '老书的正文，迁移后一个字节都不该变。')
  writeMarkdown(root, 'characters/清音.md', ['name: 清音'], '主角。')
  writeMarkdown(root, 'world/门派/白云观.md', ['title: 白云观', 'category: 门派'], '山中道观。')
  return root
}

const keyOf = (op, path) => `${op} ${path}`.trim()

/**
 * The one change a rollback deliberately keeps: the `.inkflow/` ignore line.
 *
 * It is appended by `ensurePrivateStateIgnored()` when the backup package is
 * created — *before* any migration step, and therefore outside the package's own
 * manifest. Removing it during a rollback would push the package directory that
 * still exists into `git status`, which is the opposite of what the line is for.
 */
const PRIVATE_STATE_IGNORE_LINE = '.inkflow/\n'

test('migrate: plan is read-only, recognises the legacy layout and lists every step', () => {
  const root = legacyBook()
  const before = hashTree(root)
  const planned = planMigration(root)
  assert.equal(hashTree(root), before, 'a dry run must not write anything')

  assert.equal(planned.legacy, true)
  assert.equal(planned.state, 'needs-repair')
  assert.equal(planned.blocked, undefined)
  assert.deepEqual(
    planned.actions.map((action) => keyOf(action.op, action.path)),
    [
      'git-init',
      'create-dir foreshadowing',
      'create-gitkeep foreshadowing/.gitkeep',
      'create-dir timeline',
      'create-gitkeep timeline/.gitkeep',
      'create-dir relations',
      'create-gitkeep relations/.gitkeep',
      'create-dir facts',
      'create-gitkeep facts/.gitkeep',
      'append-gitignore .gitignore',
      'write-meta inkflow.json',
    ],
  )
})

test('migrate: apply needs confirmation and writes nothing without it', () => {
  const root = legacyBook()
  const before = hashTree(root)
  const result = applyMigration(root, {})
  assert.equal(result.ok, false)
  assert.equal(result.requiresConfirmation, true)
  assert.equal(result.error.code, 'MIGRATION_REQUIRES_CONFIRMATION')
  assert.equal(hashTree(root), before)
})

test('migrate: the dry-run action list equals what the run actually did (set comparison)', () => {
  const root = legacyBook()
  const planned = planMigration(root)
  const result = applyMigration(root, { confirm: true })
  assert.equal(result.ok, true, result.error?.message)

  const plannedKeys = new Set(planned.actions.map((action) => keyOf(action.op, action.path)))
  const appliedKeys = new Set(result.applied)
  assert.deepEqual(
    [...plannedKeys].filter((key) => !appliedKeys.has(key)).sort(),
    [],
    'the plan promised steps the run did not perform',
  )
  assert.deepEqual(
    [...appliedKeys].filter((key) => !plannedKeys.has(key)).sort(),
    [],
    'the run performed steps the plan never promised',
  )
  assert.equal(plannedKeys.size, appliedKeys.size)
  assert.deepEqual(result.skipped, [])
})

test('migrate: only-add — the content files keep their bytes, the metadata is upgraded', () => {
  const root = legacyBook()
  const before = fileDigests(root)
  const result = applyMigration(root, { confirm: true })
  assert.equal(result.ok, true)
  assert.equal(result.stateAfter, 'usable')

  const after = fileDigests(root)
  const changed = changedPaths(before, after)
  assert.deepEqual(
    changed.filter((path) => path !== '.gitignore' && path !== 'inkflow.json' && !path.endsWith('.gitkeep')),
    [],
    'a migration must not touch a content file',
  )

  // The prose and the entries are byte-identical, including the ones in the old dirs.
  for (const path of ['chapters/vol-01/0001-甲.md', 'characters/清音.md', 'world/门派/白云观.md']) {
    assert.equal(after.get(path), before.get(path), `${path} must keep its bytes`)
  }

  // The four new directories exist, each carrying the marker git needs.
  for (const dir of ['foreshadowing', 'timeline', 'relations', 'facts']) {
    assert.ok(existsSync(join(root, dir)), `${dir}/ should exist`)
    assert.equal(readFileSync(join(root, dir, '.gitkeep'), 'utf8'), '')
  }

  // `.gitignore` only gained lines; `inkflow.json` only changed schemaVersion.
  const gitignore = readFileSync(join(root, '.gitignore'), 'utf8')
  assert.equal(gitignore.split('\n')[0], 'index/*.db', 'existing lines keep their order')
  for (const line of ['index/*.db', 'index/*.db-wal', 'index/*.db-shm']) assert.ok(gitignore.includes(line), line)
  const meta = JSON.parse(readFileSync(join(root, 'inkflow.json'), 'utf8'))
  assert.equal(meta.schemaVersion, 1)
  assert.equal(meta.title, '老书')
  assert.equal(meta.author, '作者')
  assert.equal(meta.createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(result.report?.written, true)
})

test('migrate: a successful run is rolled back byte for byte, and .git is kept', () => {
  const root = legacyBook()
  const before = fileDigests(root)
  const gitignoreBefore = readFileSync(join(root, '.gitignore'), 'utf8')
  const result = applyMigration(root, { confirm: true })
  assert.equal(result.ok, true)
  assert.ok(result.applied.includes('git-init'), 'the plan ran `git init` for a book without .git')
  const name = result.backup.dir.split('/').pop()

  const rolled = rollbackMigration(root, { backup: name })
  assert.equal(rolled.ok, true, rolled.error?.message)
  assert.ok(rolled.dirsRemoved.includes('foreshadowing'))
  assert.ok(rolled.dirsRemoved.includes('facts'))
  assert.ok(rolled.restored.includes('.gitignore'))
  assert.ok(rolled.restored.includes('inkflow.json'))
  assert.ok(
    rolled.kept.some((entry) => entry.path === '.git'),
    'git init is never undone',
  )

  // Everything the package covers is byte-identical again; the only difference is
  // the `.inkflow/` line the package creation itself appended.
  const after = fileDigests(root)
  assert.deepEqual(changedPaths(before, after), ['.gitignore'])
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), `${gitignoreBefore}${PRIVATE_STATE_IGNORE_LINE}`)
  assert.equal(existsSync(join(root, 'facts')), false, 'a created directory is removed again')
  assert.equal(existsSync(join(root, '.git')), true)
})

test('migrate: an interrupted run stays partial and is undone from its package', () => {
  const root = legacyBook()
  // Sabotage one target: the run stops when a directory cannot be created.
  writeFileSync(join(root, 'timeline'), 'not a directory', 'utf8')
  const before = fileDigests(root)
  const gitignoreBefore = readFileSync(join(root, '.gitignore'), 'utf8')

  const planned = planMigration(root)
  const result = applyMigration(root, { confirm: true })
  assert.equal(result.ok, false)
  assert.equal(result.partial, true)
  assert.equal(result.error.code, 'MIGRATION_STEP_FAILED')
  assert.ok(result.backup !== undefined, 'a failed run still hands back its package')
  assert.deepEqual(result.applied, ['git-init', 'create-dir foreshadowing', 'create-gitkeep foreshadowing/.gitkeep'])
  assert.ok(planned.actions.length > result.applied.length, 'the plan had more steps than the run performed')

  // The manifest says the run never finished, so nothing has to guess.
  const read = readBackup(root, result.backup.dir.split('/').pop())
  assert.equal(read.ok, true)
  assert.equal(read.manifest.sealed, false)

  const rolled = rollbackMigration(root, { backup: result.backup.dir.split('/').pop() })
  assert.equal(rolled.ok, true, rolled.error?.message)
  assert.ok(rolled.dirsRemoved.includes('foreshadowing'))
  assert.equal(existsSync(join(root, 'foreshadowing')), false)

  // Back to the pre-run state — the sabotaging file included. `.gitignore` keeps the
  // `.inkflow/` line the package creation added (see PRIVATE_STATE_IGNORE_LINE).
  assert.deepEqual(changedPaths(before, fileDigests(root)), ['.gitignore'])
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), `${gitignoreBefore}${PRIVATE_STATE_IGNORE_LINE}`)
  assert.equal(readFileSync(join(root, 'timeline'), 'utf8'), 'not a directory')
})

test('migrate: a rollback refuses to overwrite a file edited after the run', () => {
  const root = legacyBook()
  const result = applyMigration(root, { confirm: true })
  assert.equal(result.ok, true)
  const name = result.backup.dir.split('/').pop()

  // Somebody edits the meta after the migration: the newer text wins.
  const metaPath = join(root, 'inkflow.json')
  const edited = JSON.parse(readFileSync(metaPath, 'utf8'))
  edited.title = '改过的书名'
  writeFileSync(metaPath, `${JSON.stringify(edited, null, 2)}\n`, 'utf8')

  const rolled = rollbackMigration(root, { backup: name })
  assert.equal(rolled.ok, false)
  assert.equal(rolled.error.code, 'BACKUP_CONFLICT')
  assert.match(rolled.error.message, /inkflow\.json/u)
  assert.equal(JSON.parse(readFileSync(metaPath, 'utf8')).title, '改过的书名', 'the newer text is kept')
  // The manifest is not stamped, so the rollback can be retried once resolved.
  const read = readBackup(root, name)
  assert.equal(read.ok, true)
  assert.equal(read.manifest.rolledBackAt, undefined)
})

test('migrate: a book with nothing to do applies as a no-op', () => {
  const root = legacyBook()
  assert.equal(applyMigration(root, { confirm: true }).ok, true)
  const second = planMigration(root)
  assert.equal(second.legacy, false)
  assert.deepEqual(second.actions, [])
  const again = applyMigration(root, { confirm: true })
  assert.equal(again.ok, true)
  assert.deepEqual(again.applied, [])
  assert.equal(listBackups(root).length, 1, 'a no-op run creates no package')
})

test('migrate: a book written by a newer plugin is refused, zero writes', () => {
  const root = legacyBook()
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 99, title: '未来之书' }, null, 2)}\n`, 'utf8')
  const before = hashTree(root)
  const planned = planMigration(root)
  assert.equal(planned.blocked?.code, 'PROJECT_NEEDS_NEWER_PLUGIN')
  const result = applyMigration(root, { confirm: true })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'PROJECT_NEEDS_NEWER_PLUGIN')
  assert.equal(hashTree(root), before)
})

test('migrate: an unreadable inkflow.json is not migrated — the wizard asks for a title', () => {
  const root = legacyBook()
  writeFileSync(join(root, 'inkflow.json'), '{ not json', 'utf8')
  const planned = planMigration(root)
  assert.equal(planned.blocked?.code, 'META_INVALID')
  const result = applyMigration(root, { confirm: true })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'META_INVALID')
  assert.equal(readFileSync(join(root, 'inkflow.json'), 'utf8'), '{ not json')
})

// ---------------------------------------------------------------------------
// The derived `index/` directory
// ---------------------------------------------------------------------------

/**
 * The legacy layout **without** `index/`.
 *
 * This is the shape the field report described. It matters because `index/` is the one
 * required directory the write path creates by itself: `io.ts` puts the project
 * write lock at `index/.write.lock`, so the first `stageFile` of any run materialises
 * the directory. A plan (read-only, no lock) therefore promises `create-dir index`,
 * while the run reached that step with the directory already in place — and used to
 * report one step fewer than it had promised.
 */
function legacyBookWithoutIndex() {
  const root = legacyBook()
  rmSync(join(root, 'index'), { recursive: true, force: true })
  assert.equal(existsSync(join(root, 'index')), false)
  return root
}

test('migrate: plan and apply agree step for step on a book without index/', () => {
  const root = legacyBookWithoutIndex()
  const planned = planMigration(root)
  const plannedKeys = planned.actions.map((action) => keyOf(action.op, action.path))
  assert.ok(plannedKeys.includes('create-dir index'), 'the plan still promises the derived directory')
  assert.equal(planned.actions.length, 13)

  const result = applyMigration(root, { confirm: true })
  assert.equal(result.ok, true, result.error?.message)
  assert.equal(result.applied.length, planned.actions.length, 'the run did as many steps as the plan promised')
  assert.deepEqual(result.applied, plannedKeys, 'the same steps, in the same order, spelled the same way')
  assert.deepEqual(result.skipped, [])
  assert.equal(existsSync(join(root, 'index')), true)
  assert.equal(readFileSync(join(root, 'index', '.gitkeep'), 'utf8'), '')
})

test('migrate: a rollback removes the empty index/ directory the run created', () => {
  const root = legacyBookWithoutIndex()
  const before = fileDigests(root)
  const gitignoreBefore = readFileSync(join(root, '.gitignore'), 'utf8')
  const result = applyMigration(root, { confirm: true })
  assert.equal(result.ok, true)
  assert.equal(existsSync(join(root, 'index')), true)

  const rolled = rollbackMigration(root, { backup: result.backup.dir.split('/').pop() })
  assert.equal(rolled.ok, true, rolled.error?.message)
  assert.ok(rolled.dirsRemoved.includes('index'), 'the directory the run created is swept like the other four')
  assert.equal(existsSync(join(root, 'index')), false, 'no empty index/ residue after a rollback')
  assert.deepEqual(changedPaths(before, fileDigests(root)), ['.gitignore'])
  assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), `${gitignoreBefore}${PRIVATE_STATE_IGNORE_LINE}`)
})

test('migrate: a rollback keeps index/ that holds the derived database, and says why', () => {
  const root = legacyBookWithoutIndex()
  const result = applyMigration(root, { confirm: true })
  assert.equal(result.ok, true)
  // The index is a rebuildable cache, not this run's product: it may appear between
  // the migration and the rollback (the gate rebuilds it on the next read).
  writeFileSync(join(root, 'index', 'inkflow.db'), 'derived', 'utf8')

  const rolled = rollbackMigration(root, { backup: result.backup.dir.split('/').pop() })
  assert.equal(rolled.ok, true, rolled.error?.message)
  assert.equal(rolled.dirsRemoved.includes('index'), false)
  assert.equal(existsSync(join(root, 'index')), true, 'a directory holding a cache is never deleted')
  assert.equal(readFileSync(join(root, 'index', 'inkflow.db'), 'utf8'), 'derived')
  const kept = rolled.kept.find((entry) => entry.path === 'index')
  assert.ok(kept !== undefined, 'the report names the directory it left alone')
  assert.match(kept.reason, /derived|派生物/u)
  // The marker file this run created is gone again; only the cache is left.
  assert.equal(existsSync(join(root, 'index', '.gitkeep')), false)
})
