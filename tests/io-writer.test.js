/**
 * Write-layer contract (issue #14): one atomic writer, one project write lock,
 * one path resolver.
 *
 * The plugin runs un-sandboxed in the host process (hard-constraints H7), so
 * every one of these tests is a data-safety test, not a utility test:
 *
 *   - a failed write must leave the previous bytes and no temp residue, because
 *     the user's novel is the only copy;
 *   - two sessions writing the same book must not both win: the loser gets
 *     PROJECT_BUSY instead of silently overwriting the winner;
 *   - a stale lock (killed process) must heal itself, because a wedged lock
 *     would make the whole project unwritable;
 *   - every escape hatch (.., absolute, UNC, junction, reserved name, long path)
 *     is refused before anything touches the disk.
 *
 * Like the other suites these run against the built artifact (lib/index.js).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  acquireProjectWriteLock,
  removeEmptyProjectDirectory,
  removeProjectFile,
  renameProjectDirectory,
  resolveWriteTarget,
  withProjectWriteLock,
  writeJsonAtomic,
  writeTextAtomic,
} from '../lib/index.js'

const LOCK_RELATIVE = join('index', '.write.lock')
const TEMP_PATTERN = /\.tmp-\d+-[0-9a-f]+$/

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-io-'))
}

/** A usable project skeleton: git dir, required dirs, meta. */
function project(dir) {
  const root = join(dir, 'book')
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const name of ['chapters', 'characters', 'world', 'outlines', 'index', 'library']) {
    mkdirSync(join(root, name), { recursive: true })
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '写入测试' }, null, 2)}\n`, 'utf8')
  return root
}

function lockPath(root) {
  return join(root, LOCK_RELATIVE)
}

function tempFiles(dir) {
  try {
    return readdirSync(dir).filter((name) => TEMP_PATTERN.test(name))
  } catch {
    return []
  }
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function writeLiveLock(root, pid = process.ppid) {
  writeFileSync(lockPath(root), JSON.stringify({ pid, token: 'other-session', startedAt: Date.now() }), 'utf8')
}

// ---------------------------------------------------------------------------
// 1. Atomic text writes
// ---------------------------------------------------------------------------

test('io: a text write is atomic, UTF-8 without BOM, and LF-normalized', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const relative = 'chapters/vol-01/0001-开篇.md'
    // A BOM + CRLF is exactly what PowerShell-written files look like; the
    // writer must normalize, never propagate them into the user's repository.
    const result = writeTextAtomic(root, relative, '\uFEFF第一段\r\n第二段\r\n')

    assert.equal(result.ok, true)
    assert.equal(result.created, true)
    assert.equal(result.target.relative, relative)
    assert.equal(result.target.dir, 'chapters')
    assert.equal(realpathSync.native(result.target.absolute), realpathSync.native(join(root, relative)))

    const bytes = readFileSync(join(root, relative))
    assert.equal(bytes[0] === 0xef && bytes[1] === 0xbb, false, 'no UTF-8 BOM may be written')
    assert.equal(bytes.toString('utf8'), '第一段\n第二段\n')

    // The temp file lives in the same directory and is renamed away: nothing is
    // left behind and the lock is released.
    assert.deepEqual(tempFiles(join(root, 'chapters', 'vol-01')), [])
    assert.equal(existsSync(lockPath(root)), false)
    assert.equal(existsSync(join(root, 'index', '.gitkeep')), false, 'a write does not scaffold the project')

    const again = writeTextAtomic(root, relative, '改过的正文\n')
    assert.equal(again.ok, true)
    assert.equal(again.created, false, 'an overwrite reports created=false')
    assert.equal(readFileSync(join(root, relative), 'utf8'), '改过的正文\n')
    assert.deepEqual(tempFiles(join(root, 'chapters', 'vol-01')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('io: windows-style separators are accepted and normalized', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const resolved = resolveWriteTarget(root, 'chapters\\vol-01\\0002-乙.md')
    assert.equal(resolved.ok, true)
    assert.equal(resolved.target.relative, 'chapters/vol-01/0002-乙.md')
    assert.equal(resolved.target.relative.includes('\\'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. Failure keeps the previous bytes and leaves no temp file
// ---------------------------------------------------------------------------

test(
  'io: a target that cannot be replaced keeps its bytes and no temp file',
  // On Windows an open handle on the target blocks the rename with EPERM — the
  // "somebody has the chapter open in an editor / another process" case.
  // Measured on Windows 11 + Node 24.16 (same semantics as the index build).
  { skip: process.platform === 'win32' ? false : 'Windows file-sharing semantics (rename fails EPERM)' },
  () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const relative = 'chapters/0001-甲.md'
    const absolute = join(root, relative)
    writeFileSync(absolute, '旧正文\n', 'utf8')
    const before = digest(absolute)

    const holder = openSync(absolute, 'r')
    let result
    try {
      result = writeTextAtomic(root, relative, '新正文\n')
    } finally {
      closeSync(holder)
    }

    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'IO_FAILED')
    assert.match(result.error.errno, /^(EPERM|EACCES|EBUSY)$/)
    // The temp-then-rename strategy is observable even though the write failed:
    // the error names the temp file it wrote, and that file is already gone.
    // (An in-place writer would have no temp file to name — and could leave the
    // target half-written.)
    assert.equal(typeof result.error.tempFile, 'string')
    assert.match(result.error.tempFile, /0001-甲\.md\.tmp-\d+-[0-9a-f]+$/)
    assert.equal(existsSync(result.error.tempFile), false)
    assert.equal(digest(absolute), before, 'the previous bytes are untouched')
    assert.deepEqual(tempFiles(dirname(absolute)), [], 'no temp residue after the failure')
    assert.equal(existsSync(lockPath(root)), false, 'the lock is released on the failure path')

    // And the same write succeeds once the holder is gone.
    const retry = writeTextAtomic(root, relative, '新正文\n')
    assert.equal(retry.ok, true)
    assert.equal(readFileSync(absolute, 'utf8'), '新正文\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  },
)

test('io: a target path occupied by a directory fails structured, without residue', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const relative = 'chapters/0009-占位.md'
    mkdirSync(join(root, relative))
    writeFileSync(join(root, relative, 'sentinel.txt'), 'keep me', 'utf8')

    const result = writeTextAtomic(root, relative, '正文\n')
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'IO_FAILED')
    assert.ok(typeof result.error.message === 'string')
    assert.equal(readFileSync(join(root, relative, 'sentinel.txt'), 'utf8'), 'keep me')
    assert.deepEqual(tempFiles(join(root, 'chapters')), [])
    assert.equal(existsSync(lockPath(root)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. The single-project write lock
// ---------------------------------------------------------------------------

test('io: a live lock held by another process reports PROJECT_BUSY and is not stolen', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    writeLiveLock(root)

    const held = acquireProjectWriteLock(root)
    assert.equal(held.ok, false)
    assert.equal(held.error.code, 'PROJECT_BUSY')
    assert.match(held.error.message, /another session/)

    // The loser must not write: a half-applied "retry anyway" is what silently
    // overwrites the winner's chapter.
    const blocked = writeTextAtomic(root, 'chapters/0001-甲.md', '正文\n')
    assert.equal(blocked.ok, false)
    assert.equal(blocked.error.code, 'PROJECT_BUSY')
    assert.equal(existsSync(join(root, 'chapters', '0001-甲.md')), false)
    assert.equal(existsSync(lockPath(root)), true, 'a live foreign lock survives the failed attempt')

    // Once the other session releases, the same write goes through.
    rmSync(lockPath(root))
    const written = writeTextAtomic(root, 'chapters/0001-甲.md', '正文\n')
    assert.equal(written.ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('io: stale locks self-heal (dead pid, expired timestamp, own leftover)', () => {
  const dir = workdir()
  try {
    const root = project(dir)

    // A killed session: its pid no longer exists.
    writeFileSync(lockPath(root), JSON.stringify({ pid: 999999, token: 'dead', startedAt: Date.now() }), 'utf8')
    const afterDeadPid = acquireProjectWriteLock(root)
    assert.equal(afterDeadPid.ok, true)
    afterDeadPid.value.release()
    assert.equal(existsSync(lockPath(root)), false)

    // A hung session: the pid is alive but the lock is older than any write.
    writeFileSync(
      lockPath(root),
      JSON.stringify({ pid: process.ppid, token: 'hung', startedAt: Date.now() - 11 * 60_000 }),
      'utf8',
    )
    const afterExpiry = writeTextAtomic(root, 'chapters/0002-乙.md', '正文\n')
    assert.equal(afterExpiry.ok, true)

    // A leftover from a previous plugin generation in *this* process.
    writeFileSync(lockPath(root), JSON.stringify({ pid: process.pid, token: 'own', startedAt: Date.now() }), 'utf8')
    const afterOwn = writeTextAtomic(root, 'chapters/0003-丙.md', '正文\n')
    assert.equal(afterOwn.ok, true)
    assert.equal(existsSync(lockPath(root)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('io: release verifies the token instead of deleting a foreign lock', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const acquired = acquireProjectWriteLock(root)
    assert.equal(acquired.ok, true)
    const { value: lock } = acquired

    // Somebody replaced the lock file while we held it (stale-heal race). Our
    // release must not delete the new owner's lock.
    writeFileSync(lockPath(root), JSON.stringify({ pid: process.ppid, token: 'new-owner', startedAt: Date.now() }), 'utf8')
    lock.release()
    assert.equal(existsSync(lockPath(root)), true, 'a foreign lock must survive our release')

    // A second release is a no-op (double-release must not throw or unlink).
    lock.release()
    assert.equal(existsSync(lockPath(root)), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('io: the lock is re-entrant in one process and released once', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const outer = acquireProjectWriteLock(root)
    assert.equal(outer.ok, true)
    const inner = acquireProjectWriteLock(root)
    assert.equal(inner.ok, true)
    assert.equal(inner.value.token, outer.value.token, 'nested acquires reuse the held lock')

    inner.value.release()
    assert.equal(existsSync(lockPath(root)), true, 'the outer holder still owns the lock')
    outer.value.release()
    assert.equal(existsSync(lockPath(root)), false)

    const after = writeTextAtomic(root, 'chapters/0001-甲.md', '正文\n')
    assert.equal(after.ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('io: withProjectWriteLock holds the lock for the whole body and always releases', () => {
  const dir = workdir()
  try {
    const root = project(dir)

    const body = withProjectWriteLock(root, () => {
      // A nested write must not deadlock against the lock this scope holds.
      const written = writeTextAtomic(root, 'chapters/0001-甲.md', '正文\n')
      assert.equal(written.ok, true)
      return 'done'
    })
    assert.equal(body.ok, true)
    assert.equal(body.value, 'done')
    assert.equal(existsSync(lockPath(root)), false)

    const failed = withProjectWriteLock(root, () => {
      throw new Error('body exploded')
    })
    assert.equal(failed.ok, false)
    assert.equal(failed.error.code, 'IO_FAILED')
    assert.equal(failed.error.message.includes('body exploded'), true)
    assert.equal(existsSync(lockPath(root)), false, 'the lock is released when the body throws')

    // And a foreign lock still refuses before the body runs at all.
    writeLiveLock(root)
    let ran = false
    const busy = withProjectWriteLock(root, () => {
      ran = true
      return 1
    })
    assert.equal(busy.ok, false)
    assert.equal(busy.error.code, 'PROJECT_BUSY')
    assert.equal(ran, false, 'the body must not run without the lock')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. Path safety: the write allowlist and every escape hatch
// ---------------------------------------------------------------------------

test('io: only the nine content directories and index/ are writable', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const allowed = [
      'chapters',
      'characters',
      'world',
      'outlines',
      'foreshadowing',
      'timeline',
      'relations',
      'facts',
      'library',
      'index',
    ]
    for (const name of allowed) {
      const resolved = resolveWriteTarget(root, `${name}/sample.md`)
      assert.equal(resolved.ok, true, `${name}/ must be writable`)
      assert.equal(resolved.target.dir, name)
      assert.equal(resolved.target.relative, `${name}/sample.md`)
      assert.equal(resolved.target.absolute.startsWith(realpathSync.native(root)), true)
    }

    for (const relative of ['notes/x.md', 'inkflow.json', '.git/config', 'inbox/x.md']) {
      const resolved = resolveWriteTarget(root, relative)
      assert.equal(resolved.ok, false, `${relative} must be refused`)
      assert.equal(resolved.error.code, 'PATH_NOT_WRITABLE', relative)
    }

    // Resolving must never write: the v2 directories do not exist in this
    // fixture and stay that way until an actual write asks for them.
    assert.equal(existsSync(join(root, 'foreshadowing')), false)
    assert.equal(existsSync(join(root, 'facts')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('io: .. escapes, absolute paths, UNC and drive-relative paths are refused', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const cases = [
      '../escape.md',
      'chapters/../../escape.md',
      'chapters/../../..',
      '../../book/chapters/x.md',
      join(root, 'chapters', 'x.md'), // absolute, even inside the project
      'C:\\Windows\\evil.md',
      'C:evil.md',
      '\\\\server\\share\\evil.md',
      '//server/share/evil.md',
      '',
      '   ',
      'chapters',
      'chapters/',
      'chapters//x.md',
      'chapters/./x.md',
      'chapters/x\u0000.md',
    ]
    for (const candidate of cases) {
      const resolved = resolveWriteTarget(root, candidate)
      assert.equal(resolved.ok, false, `${JSON.stringify(candidate)} must be refused`)
      assert.equal(resolved.error.code, 'PATH_INVALID', `${JSON.stringify(candidate)} -> ${resolved.error?.code}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('io: Windows reserved names, unsafe characters and trailing dots/spaces are refused', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const reserved = ['chapters/CON.md', 'chapters/prn.md', 'characters/AUX.md', 'world/NUL.txt', 'facts/COM1.md', 'timeline/lpt9.md']
    for (const candidate of reserved) {
      const resolved = resolveWriteTarget(root, candidate)
      assert.equal(resolved.ok, false, candidate)
      assert.equal(resolved.error.code, 'PATH_RESERVED', candidate)
    }

    // A name Windows would silently rewrite to a different file, and names that
    // are illegal on Windows but legal on POSIX: both are refused so a project
    // stays portable between the machines that share it.
    for (const candidate of ['chapters/x.md.', 'chapters/x.md ', 'chapters/zero.', 'chapters/a:b.md', 'chapters/a*b.md', 'chapters/a?b.md', 'chapters/a|b.md', 'chapters/a<b>.md']) {
      const resolved = resolveWriteTarget(root, candidate)
      assert.equal(resolved.ok, false, candidate)
      assert.equal(resolved.error.code, 'PATH_INVALID', candidate)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('io: over-long paths are refused before the filesystem can truncate them', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const longName = resolveWriteTarget(root, `chapters/${'长'.repeat(250)}.md`)
    assert.equal(longName.ok, false)
    assert.equal(longName.error.code, 'PATH_TOO_LONG')

    const longSegment = resolveWriteTarget(root, `chapters/${'a'.repeat(300)}.md`)
    assert.equal(longSegment.ok, false)
    assert.equal(longSegment.error.code, 'PATH_TOO_LONG')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('io: a junction that leaves the project is refused and nothing is written', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const outside = join(dir, 'outside')
    mkdirSync(outside, { recursive: true })
    // Junctions need no privileges on Windows; on POSIX the type argument is
    // ignored and this is a plain directory symlink. Both are the same escape.
    symlinkSync(outside, join(root, 'chapters', 'escape'), 'junction')

    const resolved = resolveWriteTarget(root, 'chapters/escape/leak.md')
    assert.equal(resolved.ok, false)
    assert.equal(resolved.error.code, 'PATH_OUT_OF_SCOPE')

    const write = writeTextAtomic(root, 'chapters/escape/leak.md', '泄露\n')
    assert.equal(write.ok, false)
    assert.equal(write.error.code, 'PATH_OUT_OF_SCOPE')
    assert.equal(existsSync(join(outside, 'leak.md')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('io: the write lock file itself is not a writable target', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    for (const relative of ['index/.write.lock', 'index/.lock']) {
      const resolved = resolveWriteTarget(root, relative)
      assert.equal(resolved.ok, false, relative)
      assert.equal(resolved.error.code, 'PATH_NOT_WRITABLE')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('io: the private state directory is writable only inside its three subdirectories', () => {
  const dir = workdir()
  try {
    const root = project(dir)

    // ADR-0012 / roadmap X-9: exactly trash/ backup/ audit/, one segment deeper
    // than a content directory because the file lives inside the subdirectory.
    for (const sub of ['trash', 'backup', 'audit']) {
      const resolved = resolveWriteTarget(root, `.inkflow/${sub}/chapters/vol-01/0001-a.md`)
      assert.equal(resolved.ok, true, `.inkflow/${sub}/ must be writable`)
      assert.equal(resolved.target.dir, '.inkflow')
      assert.equal(resolved.target.relative, `.inkflow/${sub}/chapters/vol-01/0001-a.md`)
      assert.equal(resolved.target.absolute.startsWith(realpathSync.native(root)), true)
    }

    // The directory itself, its other names, and a bare subdirectory are not targets.
    for (const relative of [
      '.inkflow/x.md',
      '.inkflow/other/x.md',
      '.inkflow/trash',
      '.inkflow/trash/',
      '.inkflow',
      '.inkflow/../chapters/x.md',
      '.inkflow/trash/../../inkflow.json',
    ]) {
      const resolved = resolveWriteTarget(root, relative)
      assert.equal(resolved.ok, false, `${relative} must be refused`)
    }
    // A path that reaches out of the whitelist by name is PATH_NOT_WRITABLE; one with
    // a `..` segment is PATH_INVALID before the directory is even considered.
    assert.equal(resolveWriteTarget(root, '.inkflow/other/x.md').error.code, 'PATH_NOT_WRITABLE')
    assert.equal(resolveWriteTarget(root, '.inkflow/trash/../../inkflow.json').error.code, 'PATH_INVALID')

    // Resolving still writes nothing: no `.inkflow/` appears on disk.
    assert.equal(existsSync(join(root, '.inkflow')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('io: a missing project root is PROJECT_NOT_FOUND, not a write somewhere else', () => {
  const dir = workdir()
  try {
    const missing = join(dir, 'not-here')
    const written = writeTextAtomic(missing, 'chapters/x.md', '正文\n')
    assert.equal(written.ok, false)
    assert.equal(written.error.code, 'PROJECT_NOT_FOUND')
    assert.equal(existsSync(missing), false)

    const root = project(dir)
    // A regular file where a directory is required: the resolver stays "ok"
    // (it cannot know the intent) and the write fails structurally, without
    // turning the file into a half-written mess.
    writeFileSync(join(root, 'chapters', 'not-a-dir'), 'keep me', 'utf8')
    const throughFile = writeTextAtomic(root, 'chapters/not-a-dir/x.md', '正文\n')
    assert.equal(throughFile.ok, false)
    assert.equal(throughFile.error.code, 'IO_FAILED')
    assert.equal(readFileSync(join(root, 'chapters', 'not-a-dir'), 'utf8'), 'keep me')
    assert.deepEqual(tempFiles(join(root, 'chapters')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. JSON writes round-trip
// ---------------------------------------------------------------------------

test('io: a JSON write round-trips and is formatted like the rest of the project', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const payload = {
      schemaVersion: 1,
      volumes: [{ volumeId: 'vol-01', dir: 'vol-01-入山', title: '卷一 入山', order: 0 }],
      looseChapters: [{ chapterId: 'c-1', file: '0001-开篇.md', seq: 1, title: '开篇' }],
      note: '中文与 emoji 🐦',
    }

    const result = writeJsonAtomic(root, 'chapters/index.json', payload)
    assert.equal(result.ok, true)

    const bytes = readFileSync(join(root, 'chapters', 'index.json'))
    assert.equal(bytes[0] === 0xef, false)
    assert.equal(bytes.toString('utf8').endsWith('\n'), true)
    assert.equal(bytes.toString('utf8').includes('\r'), false)
    assert.deepEqual(JSON.parse(bytes.toString('utf8')), payload)
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'chapters', 'index.json'), 'utf8')), payload)
    assert.deepEqual(tempFiles(join(root, 'chapters')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('io: un-serializable JSON is a structured failure, not a half-written file', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const bigint = writeJsonAtomic(root, 'chapters/big.json', { value: 1n })
    assert.equal(bigint.ok, false)
    assert.equal(bigint.error.code, 'IO_FAILED')

    const circular = {}
    circular.self = circular
    const loop = writeJsonAtomic(root, 'chapters/loop.json', circular)
    assert.equal(loop.ok, false)
    assert.equal(loop.error.code, 'IO_FAILED')

    const nothing = writeJsonAtomic(root, 'chapters/none.json', undefined)
    assert.equal(nothing.ok, false)
    assert.equal(nothing.error.code, 'IO_FAILED')

    assert.equal(existsSync(join(root, 'chapters', 'big.json')), false)
    assert.equal(existsSync(join(root, 'chapters', 'loop.json')), false)
    assert.deepEqual(tempFiles(join(root, 'chapters')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. Temp residue from a crashed writer is cleaned under the lock
// ---------------------------------------------------------------------------

test('io: a temp file left by a dead writer is swept by the next write', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const orphan = join(root, 'chapters', '0001-甲.md.tmp-999999-deadbeef')
    writeFileSync(orphan, 'half-written', 'utf8')

    const written = writeTextAtomic(root, 'chapters/0002-乙.md', '正文\n')
    assert.equal(written.ok, true)
    assert.equal(existsSync(orphan), false, 'the next writer under the lock removes the orphan')
    assert.deepEqual(tempFiles(join(root, 'chapters')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7. The non-textual half of the same door: rename, remove, verbatim restore
// ---------------------------------------------------------------------------

test('io: a directory rename stays inside the allowed dirs and never overwrites', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const from = 'chapters/vol-01-入山'
    mkdirSync(join(root, from), { recursive: true })
    writeFileSync(join(root, from, '0001-第一章.md'), '正文\n', 'utf8')

    const renamed = renameProjectDirectory(root, from, 'chapters/vol-01-入山卷')
    assert.equal(renamed.ok, true, JSON.stringify(renamed))
    assert.equal(existsSync(join(root, from)), false)
    assert.equal(readFileSync(join(root, 'chapters/vol-01-入山卷', '0001-第一章.md'), 'utf8'), '正文\n')

    // An occupied destination is refused, not merged.
    mkdirSync(join(root, 'chapters', 'vol-02-出海'), { recursive: true })
    const occupied = renameProjectDirectory(root, 'chapters/vol-01-入山卷', 'chapters/vol-02-出海')
    assert.equal(occupied.ok, false)
    assert.equal(occupied.error.code, 'TARGET_EXISTS')

    // A rename out of the project (or into itself) is refused before any IO.
    const escape = renameProjectDirectory(root, 'chapters/vol-01-入山卷', '../outside')
    assert.equal(escape.ok, false)
    assert.equal(escape.error.code, 'PATH_INVALID')
    const intoItself = renameProjectDirectory(root, 'chapters/vol-01-入山卷', 'chapters/vol-01-入山卷/inner')
    assert.equal(intoItself.ok, false)
    assert.ok(intoItself.error.code === 'PATH_INVALID' || intoItself.error.code === 'PATH_NOT_WRITABLE')

    const missing = renameProjectDirectory(root, 'chapters/vol-09-none', 'chapters/vol-09-other')
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'PATH_NOT_FOUND')

    assert.equal(existsSync(join(dir, 'outside')), false)
    assert.equal(existsSync(join(root, 'chapters', 'vol-01-入山卷', '0001-第一章.md')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('io: removing a file is structured; a directory or a missing file is refused', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const relative = 'chapters/0001-删我.md'
    writeTextAtomic(root, relative, '正文\n')

    const volumeDirectory = 'chapters/vol-01-入山'
    mkdirSync(join(root, volumeDirectory), { recursive: true })
    writeTextAtomic(root, `${volumeDirectory}/0001-别删.md`, '正文\n')
    const refused = removeProjectFile(root, volumeDirectory)
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'IO_FAILED')
    assert.equal(existsSync(join(root, volumeDirectory)), true, 'a chapter delete must never take a volume with it')

    const missing = removeProjectFile(root, 'chapters/9999-没有.md')
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'PATH_NOT_FOUND')

    const removed = removeProjectFile(root, relative)
    assert.equal(removed.ok, true)
    assert.equal(removed.path, relative)
    assert.equal(existsSync(join(root, relative)), false)

    // An empty directory can be removed (rollback of a created volume)…
    const empty = 'chapters/vol-08-空卷'
    mkdirSync(join(root, empty), { recursive: true })
    const gone = removeEmptyProjectDirectory(root, empty)
    assert.equal(gone.ok, true)
    assert.equal(existsSync(join(root, empty)), false)

    // …but a directory with a chapter in it cannot.
    const occupied = removeEmptyProjectDirectory(
      root,
      'chapters/vol-01-入山',
    )
    assert.equal(occupied.ok, false)
    assert.equal(occupied.error.code, 'IO_FAILED')
    assert.equal(existsSync(join(root, 'chapters/vol-01-入山')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('io: a verbatim write restores the previous bytes exactly (rollback path)', () => {
  const dir = workdir()
  try {
    const root = project(dir)
    const relative = 'chapters/0001-原样.md'
    const original = '\uFEFF---\r\ntitle: 原样\r\n---\r\n正文\r\n'
    writeFileSync(join(root, relative), original, 'utf8')
    const before = digest(join(root, relative))

    // A normal write normalizes.…
    const normalized = writeTextAtomic(root, relative, original)
    assert.equal(normalized.ok, true)
    assert.notEqual(digest(join(root, relative)), before)
    assert.equal(readFileSync(join(root, relative), 'utf8').includes('\r'), false)

    // …and a verbatim write puts the original bytes back (what a rollback uses).
    const restored = writeTextAtomic(root, relative, original, { verbatim: true })
    assert.equal(restored.ok, true)
    assert.equal(digest(join(root, relative)), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 8. The capability layer stays off the tool registry (issue #14 is capability
// only; the tool wiring belongs to #16). The exact tool list is asserted in
// contract.test.js, which would fail if a tool were registered here.
// ---------------------------------------------------------------------------
