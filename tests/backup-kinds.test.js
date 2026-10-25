/**
 * The backup package's `kind` vocabulary (the code half).
 *
 * `backup.ts` shipped with two kinds because only the repair pass and the 6→9
 * migration existed. The 0.4.0 batch adds four more producers — batch import,
 * id replace, shared-content copy, restore — and X-17 says all of them reuse this one
 * package. So the vocabulary is widened once, here, instead of each issue adding its
 * own word and each reader having to learn about it.
 *
 * What the tests hold down:
 *   * every kind in `BACKUP_KINDS` opens, seals and reads back (a kind the writer
 *     accepts but the reader refuses would produce a package nobody can roll back);
 *   * the list is exactly the six contract values, so widening it is a visible edit
 *     rather than a silent `string`;
 *   * a manifest carrying a word this build does not know is still refused — the
 *     widening must not degrade into "any string will do", or a typo in a foreign
 *     package would be read as a valid one.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BACKUP_KINDS,
  BACKUP_MANIFEST_FILE,
  BACKUP_SCHEMA_VERSION,
  listBackups,
  openBackup,
  readBackup,
  sealBackup,
  stageFile,
} from '../lib/index.js'

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-backup-kind-'))
}

function body() {
  return { steps: [], dirs: [], files: [], kept: [] }
}

test('backup: the kind vocabulary is exactly the six contract values', () => {
  // X-17 / roadmap §2.3: the four 0.4.0 producers plus the two maintenance batches
  // The migrator already shipped. B1's tasks do not add a seventh.
  assert.deepEqual([...BACKUP_KINDS], ['repair', 'migrate', 'import', 'replace', 'shared', 'restore'])
})

test('backup: every kind opens, seals and reads back with its own kind', () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    mkdirSync(join(root, 'chapters'), { recursive: true })
    writeFileSync(join(root, 'chapters', 'a.md'), '第一章\n', 'utf8')

    for (const [index, kind] of BACKUP_KINDS.entries()) {
      // One package per kind, one distinct minute apart, so the directories do not
      // collide and the list stays readable.
      const at = new Date(2026, 9, 24, 17, index, 0)
      const opened = openBackup(root, kind, at)
      assert.equal(opened.ok, true, `openBackup('${kind}') must succeed`)
      if (!opened.ok) return
      const staged = stageFile(root, opened.value, 'chapters/a.md')
      assert.equal(staged.ok, true, `stageFile under '${kind}' must succeed`)
      const sealed = sealBackup(root, opened.value, kind, body(), true, at)
      assert.equal(sealed.ok, true, `sealBackup('${kind}') must succeed`)
      if (!sealed.ok) return
      assert.equal(sealed.value.kind, kind)

      const read = readBackup(root, opened.value.dir.split('/').pop())
      assert.equal(read.ok, true, `readBackup must accept a '${kind}' package`)
      if (!read.ok) return
      assert.equal(read.manifest.kind, kind, `the package remembers it was a '${kind}' batch`)
      assert.equal(read.manifest.sealed, true)
      // The package lives where it always did, and the copy is the file's bytes.
      assert.ok(existsSync(join(root, ...opened.value.manifestPath.split('/'))))
    }

    const listed = listBackups(root)
    assert.equal(listed.length, BACKUP_KINDS.length, 'listBackups sees every package regardless of kind')
    assert.deepEqual(
      [...new Set(listed.map((entry) => entry.kind))].sort(),
      [...BACKUP_KINDS].sort(),
      'and reports each one under its own kind',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backup: a manifest with an unknown kind is still refused', () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    mkdirSync(join(root, 'chapters'), { recursive: true })
    const name = '20261024T011500000Z'
    const packageDir = join(root, '.inkflow', 'backup', name)
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(
      join(packageDir, BACKUP_MANIFEST_FILE),
      JSON.stringify(
        {
          schemaVersion: BACKUP_SCHEMA_VERSION,
          kind: 'rollback', // a word this build does not know: not a kind, not a default
          createdAt: '2026-10-24T01:15:00.000Z',
          sealed: true,
          steps: [],
          dirs: [],
          files: [],
          kept: [],
        },
        null,
        2,
      ),
      'utf8',
    )

    const read = readBackup(root, name)
    assert.equal(read.ok, false, 'an unknown kind is not silently accepted')
    if (read.ok) return
    assert.equal(read.error.code, 'BACKUP_MANIFEST_INVALID')
    assert.ok(read.error.message.includes('kind'), 'the refusal names the field')
    // Read-back of a foreign manifest never rewrites it.
    assert.match(readFileSync(join(packageDir, BACKUP_MANIFEST_FILE), 'utf8'), /"kind": "rollback"/)
    assert.deepEqual(listBackups(root), [], 'and it is not listed as a package')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
