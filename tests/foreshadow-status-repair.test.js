/**
 * Deriving a foreshadow's `status` from its own evidence fields (#136, I-21).
 *
 * The finding `FORESHADOW_TRANSITION_INVALID` used to be a dead end: the rebuild
 * reported a file that contradicts itself (`status: planted` next to
 * `advancedAt: [outline-934]`), the repair pass listed it and refused to touch it,
 * and the author had to hand-edit the file. #136 adds one repair action that
 * follows the derivation the spec already implies (`data-model.md` §3.2.1) and
 * writes **one line** — the `status` line — leaving every other byte alone.
 *
 * What the suite pins down:
 *
 *   1. the three levels of the derivation (`resolved` → `advanced` → `planted`),
 *      each on a shape that only that level can explain;
 *   2. idempotence: a file that already agrees costs **zero writes**;
 *   3. the two shapes where the evidence contradicts itself are *not* guessed —
 *      the finding survives and the report says why;
 *   4. the byte-level claim: the patched file equals the original text with the
 *      `status` line swapped, so nothing else moved (frontmatter order, quoting,
 *      the body, the line endings).
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyRepair, detectFindings, listBackups, planRepair, rollbackMigration } from '../lib/index.js'
import { changedPaths, fileDigests } from './tree-digest.mjs'

const DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-fs-status-'))
}

function writeMarkdown(root, relativePath, frontmatterLines, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = frontmatterLines.length > 0 ? `---\n${frontmatterLines.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

/** One complete book; the caller adds the foreshadow files it wants to judge. */
function book(files) {
  const root = workdir()
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '伏笔推导' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.gitignore'), 'index/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  for (const [path, lines, body] of files) writeMarkdown(root, path, lines, body)
  return root
}

const CODE = 'FORESHADOW_TRANSITION_INVALID'

function codes(findings) {
  return findings.filter((finding) => finding.code === CODE).map((finding) => finding.locator.path).sort()
}

/** The whole file, byte for byte. */
function textOf(root, path) {
  return readFileSync(join(root, path), 'utf8')
}

/** Plan + apply narrowed to the one code this suite is about. */
function repairForeshadowStatus(root) {
  return applyRepair(root, { confirm: true, select: [CODE] })
}

test('foreshadow status: `status: planted` next to `advancedAt` is derived to `advanced`', () => {
  // The author's real shape (`verify-030/foreshadowing/F4-喽啰口供.md`).
  const root = book([
    [
      'foreshadowing/F4.md',
      ['id: fs-04', 'title: F4 小喽啰口供', 'status: planted', 'plantedAt: outline-932', 'advancedAt: [outline-934]', 'resolved: false'],
      '## 埋设\n\n小喽啰口供。\n',
    ],
  ])
  const before = textOf(root, 'foreshadowing/F4.md')

  assert.deepEqual(codes(detectFindings(root).findings), ['foreshadowing/F4.md'])
  const detected = detectFindings(root).findings.find((finding) => finding.code === CODE)
  assert.equal(detected?.fixable, true, 'the catalogue now has an action for this code')

  const planned = planRepair(root, { select: [CODE] })
  assert.equal(planned.actions.length, 1)
  assert.equal(planned.actions[0].kind, 'derive-foreshadow-status')
  assert.equal(planned.actions[0].path, 'foreshadowing/F4.md')
  assert.deepEqual(planned.actions[0].patch, [{ key: 'status', value: 'advanced' }])

  const result = repairForeshadowStatus(root)
  assert.equal(result.ok, true, result.error?.message)
  assert.deepEqual(result.cleared, [`${CODE}|foreshadowing/F4.md`])
  assert.deepEqual(codes(result.remaining), [])

  // One line moved: everything else — key order, quoting, the body, the line ends — is the same text.
  assert.equal(textOf(root, 'foreshadowing/F4.md'), before.replace('status: planted', 'status: advanced'))
})

test('foreshadow status: a `resolvedChapter` derives `resolved` even under `status: advanced`', () => {
  const root = book([
    [
      'foreshadowing/F1.md',
      ['id: fs-01', 'title: F1', 'status: advanced', 'advancedAt: [outline-934]', 'resolvedChapter: ch-0012'],
      '正文。\n',
    ],
  ])
  const before = textOf(root, 'foreshadowing/F1.md')
  assert.deepEqual(codes(detectFindings(root).findings), [], 'this shape is only inconsistent once the status contradicts the chapter')

  // `resolved: true` under a non-terminal status is the shape that is reported.
  writeFileSync(join(root, 'foreshadowing/F1.md'), before.replace('status: advanced', 'status: advanced\nresolved: true'), 'utf8')
  const seeded = textOf(root, 'foreshadowing/F1.md')
  assert.deepEqual(codes(detectFindings(root).findings), ['foreshadowing/F1.md'])

  const result = repairForeshadowStatus(root)
  assert.equal(result.ok, true, result.error?.message)
  assert.deepEqual(codes(result.remaining), [])
  // `resolved` + a chapter is `resolved`; the advance position stays where it was.
  assert.match(textOf(root, 'foreshadowing/F1.md'), /^status: resolved$/mu)
  assert.equal(textOf(root, 'foreshadowing/F1.md'), seeded.replace('status: advanced', 'status: resolved'))
})

test('foreshadow status: `status: advanced` with an empty `advancedAt` falls back to `planted`', () => {
  const root = book([
    ['foreshadowing/F2.md', ['id: fs-02', 'title: F2', 'status: advanced', 'advancedAt: []'], '正文。\n'],
  ])
  const before = textOf(root, 'foreshadowing/F2.md')
  assert.deepEqual(codes(detectFindings(root).findings), ['foreshadowing/F2.md'], 'an advance with no position is the reported shape')

  const result = repairForeshadowStatus(root)
  assert.equal(result.ok, true, result.error?.message)
  assert.deepEqual(codes(result.remaining), [])
  assert.equal(textOf(root, 'foreshadowing/F2.md'), before.replace('status: advanced', 'status: planted'))
})

test('foreshadow status: a consistent file costs zero writes (idempotence)', () => {
  const root = book([
    ['foreshadowing/ok-planted.md', ['title: 已埋', 'status: planted'], 'a\n'],
    ['foreshadowing/ok-advanced.md', ['title: 已推进', 'status: advanced', 'advancedAt: [outline-1]'], 'b\n'],
    ['foreshadowing/ok-resolved.md', ['title: 已回收', 'resolved: true', 'status: resolved', 'resolvedChapter: ch-1'], 'c\n'],
  ])
  assert.deepEqual(codes(detectFindings(root).findings), [])
  const before = fileDigests(root)

  const planned = planRepair(root, { select: [CODE] })
  assert.deepEqual(planned.actions, [], 'nothing to derive')
  const result = repairForeshadowStatus(root)
  assert.equal(result.ok, true)
  assert.deepEqual(result.applied, [])
  assert.deepEqual(changedPaths(before, fileDigests(root)), [], 'a no-op run writes nothing at all')
  assert.deepEqual(listBackups(root), [], 'and opens no backup package')
})

test('foreshadow status: contradictory evidence is not guessed — the finding stays, with a reason', () => {
  const root = book([
    // `resolved: true` without the chapter that pays it off: promoting the status
    // would only swap one finding for `FORESHADOW_RESOLVED_WITHOUT_CHAPTER`.
    ['foreshadowing/half-resolved.md', ['title: 半截回收', 'status: planted', 'resolved: true'], 'a\n'],
    // `resolved: false` next to a `resolvedChapter`: the two evidence fields disagree.
    ['foreshadowing/denied.md', ['title: 否认回收', 'status: resolved', 'resolved: false', 'resolvedChapter: ch-9'], 'b\n'],
  ])
  const before = fileDigests(root)
  assert.deepEqual(codes(detectFindings(root).findings), ['foreshadowing/denied.md', 'foreshadowing/half-resolved.md'])

  const planned = planRepair(root, { select: [CODE] })
  assert.deepEqual(planned.actions, [], 'neither shape has a determinate status')
  const aboutStatus = planned.skipped.filter((entry) => entry.code === CODE)
  assert.equal(aboutStatus.length, 2, 'both files are reported as skipped, not silently dropped')
  assert.ok(aboutStatus.every((entry) => entry.fixable === true), 'the code is fixable; these two instances are not')
  const reasons = new Map(aboutStatus.map((entry) => [entry.path, entry.reason]))
  assert.match(reasons.get('foreshadowing/half-resolved.md'), /resolvedChapter/u)
  assert.match(reasons.get('foreshadowing/denied.md'), /resolved: false/u)

  const result = repairForeshadowStatus(root)
  assert.equal(result.ok, true)
  assert.deepEqual(result.applied, [])
  assert.deepEqual(changedPaths(before, fileDigests(root)), [], 'a refused derivation writes nothing')
  assert.deepEqual(codes(result.remaining), ['foreshadowing/denied.md', 'foreshadowing/half-resolved.md'])
})

test('foreshadow status: the derived write is covered by the backup package and rolls back byte for byte', () => {
  const root = book([
    ['foreshadowing/F4.md', ['id: fs-04', 'title: F4', 'status: planted', 'advancedAt: [outline-934]'], '正文。\n'],
  ])
  const before = fileDigests(root)
  const result = repairForeshadowStatus(root)
  assert.equal(result.ok, true, result.error?.message)
  assert.ok(result.backup !== undefined)
  assert.ok(existsSync(join(root, 'foreshadowing/F4.md')))

  const rolled = rollbackMigration(root, { backup: result.backup.dir.split('/').pop() })
  assert.equal(rolled.ok, true, rolled.error?.message)
  assert.ok(rolled.restored.includes('foreshadowing/F4.md'))
  // The `.inkflow/` ignore line is added when the package opens — before the run, so it is
  // outside the package's own manifest and stays (see `tests/migrate.test.js`).
  assert.deepEqual(changedPaths(before, fileDigests(root)), ['.gitignore'])
})
