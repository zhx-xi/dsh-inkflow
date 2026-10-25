/**
 * The private state directory helpers (issue #121, ADR-0012).
 *
 * What matters here is `.gitignore` discipline, because the alternative is a deleted
 * chapter reappearing as an untracked file: the line is appended **only when the
 * directory is first used**, appending never rewrites what is already there, and a
 * hand-written spelling of the same rule is recognised instead of duplicated.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PRIVATE_STATE_DIR,
  PRIVATE_STATE_IGNORE_LINE,
  PRIVATE_STATE_SUBDIRS,
  ensurePrivateStateIgnored,
  isPrivateStatePath,
  privateStateDirRelative,
  privateStateRelative,
  REQUIRED_GITIGNORE_LINES,
} from '../lib/index.js'

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-private-'))
}

test('private state: the six subdirectories are the whole vocabulary', () => {
  assert.equal(PRIVATE_STATE_DIR, '.inkflow')
  // Six since X-25 / ADR-0023: `proposals/` (the proposal inbox, #45) and `jobs/`
  // (batch-job progress that must survive a restart, #47) joined trash/ backup/ audit/
  // candidates/ — the four X-18 left behind. A new name here widens the write
  // whitelist, which is why the list is asserted exactly rather than spot-checked.
  assert.deepEqual([...PRIVATE_STATE_SUBDIRS], ['trash', 'backup', 'audit', 'candidates', 'proposals', 'jobs'])
  assert.equal(PRIVATE_STATE_IGNORE_LINE, '.inkflow/')
  assert.equal(privateStateDirRelative('trash'), '.inkflow/trash')
  assert.equal(privateStateRelative('trash', 'chapters/vol-01/0001-a.md'), '.inkflow/trash/chapters/vol-01/0001-a.md')
  assert.equal(privateStateRelative('proposals', 'ch-0001/0001-diff.json'), '.inkflow/proposals/ch-0001/0001-diff.json')
  assert.equal(privateStateDirRelative('jobs'), '.inkflow/jobs')
  // A leading slash is not a path, it is a separator: it never doubles.
  assert.equal(privateStateRelative('backup', '/world/a.md'), '.inkflow/backup/world/a.md')
})

test('private state: the ignore line is not part of the gate contract', () => {
  // A book that never deletes anything must not be nagged about `.inkflow/`; the line
  // arrives with the first write into the directory (ensurePrivateStateIgnored).
  assert.equal((REQUIRED_GITIGNORE_LINES).includes(PRIVATE_STATE_IGNORE_LINE), false)
  assert.deepEqual([...REQUIRED_GITIGNORE_LINES], ['index/*.db', 'index/*.db-wal', 'index/*.db-shm'])
})

test('private state: isPrivateStatePath recognises the directory and its children only', () => {
  assert.equal(isPrivateStatePath('.inkflow'), true)
  assert.equal(isPrivateStatePath('.inkflow/trash/a.md'), true)
  assert.equal(isPrivateStatePath('.inkflow\\trash\\a.md'), true)
  assert.equal(isPrivateStatePath('.inkflowx/a.md'), false)
  assert.equal(isPrivateStatePath('chapters/.inkflow/a.md'), false)
  assert.equal(isPrivateStatePath('index/inkflow.db'), false)
})

test('private state: the ignore line is appended once, without touching existing lines', () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    const file = join(root, '.gitignore')
    mkdirSync(root, { recursive: true })
    // (a) no file yet → created with just the line
    const created = ensurePrivateStateIgnored(root)
    assert.deepEqual(created, { ok: true, added: true })
    assert.equal(readFileSync(file, 'utf8'), '.inkflow/\n')

    // (b) idempotent: a second call adds nothing
    assert.deepEqual(ensurePrivateStateIgnored(root), { ok: true, added: false })
    assert.equal(readFileSync(file, 'utf8'), '.inkflow/\n')

    // (c) append-only: existing rules keep their order, and a file without a trailing
    // newline gains exactly one (never a joined line)
    writeFileSync(file, 'node_modules/\nindex/*.db', 'utf8')
    assert.deepEqual(ensurePrivateStateIgnored(root), { ok: true, added: true })
    assert.equal(readFileSync(file, 'utf8'), 'node_modules/\nindex/*.db\n.inkflow/\n')

    // (d) a hand-written spelling of the same rule is respected, not duplicated
    for (const spelling of ['.inkflow', '/.inkflow/', '  .inkflow/  ']) {
      writeFileSync(file, `index/*.db\n${spelling}\n`, 'utf8')
      assert.deepEqual(ensurePrivateStateIgnored(root), { ok: true, added: false }, spelling)
      assert.equal(readFileSync(file, 'utf8'), `index/*.db\n${spelling}\n`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('private state: an unwritable .gitignore is reported, not thrown', () => {
  const dir = workdir()
  try {
    // A directory where the file should be: reading throws EISDIR, and a delete must
    // still be able to proceed — so the failure is a value, never an exception.
    const root = join(dir, 'book')
    mkdirSync(join(root, '.gitignore'), { recursive: true })
    const result = ensurePrivateStateIgnored(root)
    assert.equal(result.ok, false)
    assert.equal(result.added, false)
    assert.ok(typeof result.error === 'string' && result.error.length > 0)
    assert.equal(existsSync(join(root, '.inkflow')), false, 'no private state is created as a side effect')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
