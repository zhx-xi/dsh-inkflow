/**
 * The repair pass: detect → preview → fix, and the proof that a fix landed.
 *
 * The suite builds ONE book that carries an instance of every finding class the
 * issue names, then asserts the three-stage contract on it:
 *
 *   * `detect` lists each class (including the codes the catalogue marks as
 *     not-auto-fixable, which must simply be *reported*);
 *   * `preview` writes absolutely nothing (whole-tree hash, mtimes included);
 *   * `fix` needs `confirm: true`, clears each fixable class, re-checks to prove it,
 *     and changes **only** the files its actions named — every other byte is
 *     compared by sha256, not by count;
 *   * `fix` then `rollback` puts the book back byte for byte;
 *   * and the one thing a repair is not allowed to do ("invent data") is asserted
 *     the other way round: `DUPLICATE_ID`, `DANGLING_PARENT` and `RELATION_ENDPOINT`
 *     survive with a stated reason.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyRepair,
  detectFindings,
  openBackup,
  listBackups,
  planRepair,
  rollbackMigration,
  writeAuditReport,
} from '../lib/index.js'
import { hashTree } from './hash-tree.mjs'
import { changedPaths, fileDigests } from './tree-digest.mjs'

const DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-repair-'))
}

function writeMarkdown(root, relativePath, frontmatterLines, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = frontmatterLines.length > 0 ? `---\n${frontmatterLines.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

/**
 * One book, one instance of each class.
 *
 * Layout notes that are load-bearing:
 *   * `world/孤儿.md` sits at the **first** level with a parent and no category —
 *     the only shape that produces `WORLD_CATEGORY_REQUIRED` (a file inside
 *     `world/<category>/` derives its category from the path, so it never fires);
 *   * `relations/dup-1.md` comes before `dup-2.md` alphabetically, and the finding
 *     names the **later** one, which is what the index keeps out of its projection;
 *   * the catalog is hand-written and stale *and* points at a chapter that does not
 *     exist, so one rebuild clears both catalog codes;
 *   * `facts/白云观.md` has no `subject:` line — the additive patch case.
 */
function sampleBook() {
  const root = workdir()
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '修复测试' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.gitignore'), 'index/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')

  writeMarkdown(root, 'chapters/vol-01/0001-甲.md', ['id: ch-1', 'title: 甲', 'seq: 1'], '第一章的正文，一个字节都不该被修复动到。')
  mkdirSync(join(root, 'chapters/vol-01'), { recursive: true })
  // The root catalog lists the volume but no chapter (stale), and the volume's own
  // catalog points at a chapter file that does not exist — the only shape that
  // produces CHAPTER_FILE_MISSING, because only a *volume* catalog's `chapters`
  // array is judged against the disk.
  writeFileSync(
    join(root, 'chapters/index.json'),
    `${JSON.stringify(
      { schemaVersion: 1, volumes: [{ volumeId: 'vol-01', dir: 'vol-01', title: '第一卷' }], looseChapters: [] },
      null,
      2,
    )}\n`,
    'utf8',
  )
  writeFileSync(
    join(root, 'chapters/vol-01/index.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        volumeId: 'vol-01',
        dir: 'vol-01',
        title: '第一卷',
        chapters: [{ file: 'chapters/vol-01/0002-乙.md', chapterId: 'ch-2', title: '乙' }],
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  writeMarkdown(root, 'characters/清音.md', ['name: 清音'], '主角。')

  writeMarkdown(root, 'world/门派/白云观.md', ['title: 白云观', 'category: 门派'], '山中道观。')
  writeMarkdown(root, 'world/门派/a.md', ['id: w-dup', 'title: 甲观', 'category: 门派'])
  writeMarkdown(root, 'world/门派/b.md', ['id: w-dup', 'title: 乙观', 'category: 门派'])
  writeMarkdown(root, 'world/门派/c.md', ['title: 丙观', 'category: 门派', 'parent: w-nope'])
  writeMarkdown(root, 'world/孤儿.md', ['title: 孤儿', 'parent: world/门派/白云观.md'])

  writeMarkdown(root, 'outlines/overall.md', ['kind: overall', 'id: ov-1', 'title: 整体'])
  writeMarkdown(root, 'outlines/vol-01.md', ['kind: volume', 'id: vol-1', 'title: 卷一', 'parent: characters/清音.md'])
  writeMarkdown(root, 'outlines/vol-02.md', ['kind: volume', 'id: vol-2', 'title: 卷二', 'parent: vol-1'])
  writeMarkdown(root, 'outlines/ch-01.md', ['kind: chapter', 'id: oc-1', 'title: 章一', 'parent: oc-2'])
  writeMarkdown(root, 'outlines/ch-02.md', ['kind: chapter', 'id: oc-2', 'title: 章二', 'parent: vol-1'])

  writeMarkdown(root, 'relations/清音-白云观.md', [
    'source: characters/清音.md',
    'target: world/门派/白云观.md',
    'kind: character',
  ])
  writeMarkdown(root, 'relations/dup-1.md', [
    'source: characters/清音.md',
    'target: world/门派/白云观.md',
    'kind: character',
  ])
  writeMarkdown(root, 'relations/dup-2.md', [
    'source: characters/清音.md',
    'target: world/门派/白云观.md',
    'kind: character',
  ])
  writeMarkdown(root, 'relations/broken.md', ['source: characters/清音.md', 'target: characters/不存在.md', 'kind: character'])

  writeMarkdown(root, 'facts/白云观.md', ['title: 白云观'])
  return root
}

const FIXABLE = [
  'FRONTMATTER_ISSUE',
  'RELATION_DUPLICATE',
  'CATALOG_STALE',
  'CHAPTER_FILE_MISSING',
  'WORLD_CATEGORY_REQUIRED',
  'OUTLINE_VOLUME_PARENT',
  'OUTLINE_VOLUME_IN_VOLUME',
  'OUTLINE_CHAPTER_IN_CHAPTER',
]

const NOT_FIXABLE = ['DUPLICATE_ID', 'DANGLING_PARENT', 'RELATION_ENDPOINT']

function codesOf(findings) {
  return new Set(findings.map((finding) => finding.code))
}

test('repair: detect lists every class the issue names', () => {
  const root = sampleBook()
  const detected = detectFindings(root)
  const codes = codesOf(detected.findings)
  const missing = [...FIXABLE, ...NOT_FIXABLE].filter((code) => !codes.has(code))
  assert.deepEqual(missing, [], `detection missed: ${missing.join(', ')}\nseen: ${[...codes].sort().join(', ')}`)
  // The catalogue is the single vocabulary: nothing is reported that it does not know.
  assert.deepEqual(detected.unknown, [])
  // Every code carries the group/severity the catalogue states.
  for (const finding of detected.findings) {
    assert.ok(['structure', 'ledger', 'foreshadow', 'timeline', 'catalog'].includes(finding.group), finding.code)
    assert.ok(['blocking', 'warning', 'info'].includes(finding.severity), finding.code)
  }
})

test('repair: preview writes nothing at all (whole-tree hash, mtimes included)', () => {
  const root = sampleBook()
  const before = hashTree(root)
  const planned = planRepair(root)
  assert.ok(planned.actions.length > 0, 'the fixture is expected to plan at least one action')
  assert.ok(planned.skipped.length > 0, 'the fixture is expected to report not-fixable codes')
  assert.equal(hashTree(root), before, 'a preview must not create a directory, a report or a .gitignore line')

  // Planning twice is deterministic: the same actions, in the same order.
  const again = planRepair(root)
  assert.deepEqual(again.actions.map((action) => action.key), planned.actions.map((action) => action.key))
  assert.equal(hashTree(root), before)
})

test('repair: fix requires confirmation and writes nothing without it', () => {
  const root = sampleBook()
  const before = hashTree(root)
  const result = applyRepair(root, { select: undefined })
  assert.equal(result.ok, false)
  assert.equal(result.requiresConfirmation, true)
  assert.equal(result.error.code, 'REPAIR_REQUIRES_CONFIRMATION')
  assert.equal(hashTree(root), before)
})

test('repair: fix clears each fixable class, proves it by re-checking, and touches nothing else', () => {
  const root = sampleBook()
  const before = fileDigests(root)
  const detectedBefore = detectFindings(root)
  const planned = planRepair(root)

  const result = applyRepair(root, { confirm: true })
  assert.equal(result.ok, true, `every action should have succeeded: ${JSON.stringify(result.applied.filter((a) => !a.ok))}`)
  assert.ok(result.after !== undefined, 'a fix run re-runs the checks')
  assert.ok(result.backup !== undefined)
  assert.equal(result.report?.written, true)
  assert.ok(existsSync(join(root, result.report.path)), `report missing: ${result.report.path}`)

  // 1) every fixable code is gone, and the re-run — not the plan — says so.
  const afterCodes = codesOf(result.after.findings)
  const survivors = FIXABLE.filter((code) => afterCodes.has(code))
  assert.deepEqual(survivors, [], 'the fixable classes must disappear from the re-run')

  // 2) the not-fixable codes survive with a reason: "repair" must never invent data.
  const skippedCodes = new Set(result.plan.skipped.map((skip) => skip.code))
  for (const code of NOT_FIXABLE) {
    assert.ok(afterCodes.has(code), `${code} should still be reported`)
    assert.ok(skippedCodes.has(code), `${code} should be listed as not auto-fixed`)
  }

  // 3) only the files the actions named changed. Everything else is byte-identical.
  //
  // `relations/清音-白云观.md` is part of the duplicate set: three files declare the
  // same edge, the index keeps the first in path order (`relations/dup-1.md`), and
  // the repair removes the rest — deterministically, with the survivor named in the
  // action detail and every removed byte kept in the backup package.
  const expected = new Set([
    'facts/白云观.md', // subject: added
    'relations/dup-2.md', // duplicate removed
    'relations/清音-白云观.md', // duplicate removed (kept: relations/dup-1.md)
    'outlines/vol-01.md', // parent → ov-1
    'outlines/vol-02.md', // parent → ov-1
    'outlines/ch-01.md', // parent → vol-1
    'world/孤儿.md', // category: 门派
    'chapters/index.json', // rebuilt projection
    'chapters/vol-01/index.json', // rebuilt projection (per volume)
  ])
  const changed = changedPaths(before, fileDigests(root)).filter((path) => path !== '.gitignore')
  assert.deepEqual(
    changed.filter((path) => !expected.has(path)),
    [],
    'a repair touched a file no action named',
  )
  for (const path of expected) {
    if (path.startsWith('relations/') && path !== 'relations/dup-1.md') {
      assert.equal(existsSync(join(root, path)), false, `the duplicate ${path} should be gone`)
      continue
    }
    assert.ok(changed.includes(path), `${path} should have changed`)
  }
  // The removed duplicates are exactly the ones the findings named, and the survivor
  // is the file the index kept.
  assert.ok(existsSync(join(root, 'relations/dup-1.md')), 'the keeping file must survive')
  assert.ok(existsSync(join(root, 'relations/broken.md')), 'a different edge is untouched')
  assert.ok(
    result.plan.actions.some(
      (action) => action.kind === 'remove-duplicate' && action.detail.includes('relations/dup-1.md'),
    ),
    'the duplicate action names the file that was kept',
  )

  // 4) the additive patches say exactly what the preview promised.
  const facts = readFileSync(join(root, 'facts/白云观.md'), 'utf8')
  assert.match(facts, /^---\n[^]*subject: 白云观[^]*---\n/u)
  assert.match(readFileSync(join(root, 'world/孤儿.md'), 'utf8'), /category: 门派/u)
  assert.match(readFileSync(join(root, 'outlines/ch-01.md'), 'utf8'), /parent: vol-1/u)

  // 5) the prose, the ids and the untouched entries keep their bytes.
  for (const path of ['chapters/vol-01/0001-甲.md', 'characters/清音.md', 'world/门派/白云观.md', 'world/门派/a.md', 'inkflow.json']) {
    assert.equal(fileDigests(root).get(path), before.get(path), `${path} must not be rewritten`)
  }

  // 6) the backup package describes the run and is the rollback handle.
  const packages = listBackups(root)
  assert.equal(packages.length, 1)
  assert.equal(packages[0].dir, result.backup.dir)
  assert.equal(packages[0].sealed, true)
  assert.equal(packages[0].kind, 'repair')
  assert.ok(packages[0].files >= planned.actions.length, 'every touched file is covered by the package')
  assert.ok(detectedBefore.findings.length > result.after.findings.length)
})

test('repair: a second fix run is a no-op for the classes that were cleared', () => {
  const root = sampleBook()
  const first = applyRepair(root, { confirm: true })
  assert.equal(first.ok, true)
  const second = planRepair(root)
  const stillPlanned = new Set(second.actions.flatMap((action) => action.codes))
  const fixedTwice = FIXABLE.filter((code) => stillPlanned.has(code) && !['DUPLICATE_ID'].includes(code))
  assert.deepEqual(fixedTwice, [], 'a cleared class must not be planned again')
})

test('repair: select narrows the run to one action', () => {
  const root = sampleBook()
  const planned = planRepair(root)
  const target = planned.actions.find((action) => action.kind === 'patch-frontmatter')
  assert.ok(target !== undefined, 'the fixture should plan a frontmatter patch')
  const before = fileDigests(root)
  const result = applyRepair(root, { confirm: true, select: [target.key] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.applied.map((outcome) => outcome.action.key), [target.key])
  const changed = changedPaths(before, fileDigests(root)).filter((path) => path !== '.gitignore')
  assert.deepEqual(changed, [target.path])
})

test('repair: the rollback package restores the book byte for byte', () => {
  const root = sampleBook()
  const before = fileDigests(root)
  const result = applyRepair(root, { confirm: true })
  assert.equal(result.ok, true)
  const backupName = result.backup.dir.split('/').pop()
  const rolled = rollbackMigration(root, { backup: backupName })
  assert.equal(rolled.ok, true, rolled.error?.message)
  assert.ok(rolled.restored.includes('facts/白云观.md'))
  assert.ok(rolled.restored.includes('chapters/index.json'))
  assert.ok(rolled.restored.includes('relations/清音-白云观.md'), 'a removed duplicate is put back')
  assert.ok(rolled.restored.includes('chapters/vol-01/index.json'), 'the rebuilt volume catalog is restored too')

  // `.gitignore` is deliberately not part of the package: the `.inkflow/` line is
  // appended by `ensurePrivateStateIgnored` and removing it during a rollback would
  // push the existing backup packages into `git status`. Everything else is exact.
  const after = fileDigests(root)
  const changed = changedPaths(before, after).filter((path) => path !== '.gitignore')
  assert.deepEqual(changed, [], 'a rollback must restore every byte it covered')
  assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^\.inkflow\/$/mu)
  // A second rollback is refused: the files no longer match the recorded digests.
  const twice = rollbackMigration(root, { backup: backupName })
  assert.equal(twice.ok, false)
  assert.equal(twice.error.code, 'BACKUP_ALREADY_ROLLED_BACK')
})

test('repair: an audit report is a derivative under .inkflow/audit', () => {
  const root = sampleBook()
  const written = writeAuditReport(root, 'repair-manual.md', '# 报告\n\n一行。\n')
  assert.equal(written.ok, true)
  assert.equal(written.path, '.inkflow/audit/repair-manual.md')
  assert.ok(existsSync(join(root, '.inkflow/audit/repair-manual.md')))
  // `.inkflow/` is not a content directory: the gate still calls the book usable.
  const detected = detectFindings(root)
  assert.deepEqual(detected.unknown, [])
  // And nothing under it is discovered as a book file.
  assert.equal(detected.findings.some((finding) => finding.locator.kind === 'path' && finding.locator.path.startsWith('.inkflow')), false)
})

/**
 * A code the catalogue no longer calls fixable must not appear in the plan.
 *
 * `FORESHADOW_RESOLVED_WITHOUT_CHAPTER` was listed as `fixable: true` while no repair
 * action existed for it, so the report said "1 fixable" and the repair pass answered
 * "no action yet" — the author's only clue that nothing would happen was the wording.
 * The flag is `false` now, and this pins the two surfaces together: whatever the plan
 * offers has to be what the catalogue promised.
 */
test('repair: a code the catalogue calls unfixable never reaches the plan (issue 143)', () => {
  const root = sampleBook()
  writeMarkdown(root, 'foreshadowing/缺章.md', ['title: 缺章', 'status: resolved', 'resolved: true', 'plantedAt: ch-1'], '回收了却没写是哪一章回收的。')
  const detected = detectFindings(root)
  const target = detected.findings.find((finding) => finding.code === 'FORESHADOW_RESOLVED_WITHOUT_CHAPTER')
  assert.ok(target !== undefined, 'the fixture must raise the code this test is about')
  assert.equal(target.fixable, false, 'the catalogue must not promise a repair that does not exist')

  const plan = planRepair(root)
  assert.equal(
    plan.actions.some((action) => action.code === 'FORESHADOW_RESOLVED_WITHOUT_CHAPTER'),
    false,
    'no action may target it',
  )
  assert.ok(
    plan.skipped.some((entry) => entry.code === 'FORESHADOW_RESOLVED_WITHOUT_CHAPTER'),
    'it must be reported as left to the author, not silently dropped',
  )
})

/**
 * A backup opened over an unwritable `.gitignore` must say so.
 *
 * Both branches of `openBackup` used to return the same object, so "the ignore rule
 * is in place" and "it is not" were indistinguishable — the package's files would
 * appear as untracked and nothing in the caller could tell. The batch still runs
 * (a backup is more important than one ignore line), but the handle carries it.
 */
test('repair: a backup opened without the .gitignore line reports it', () => {
  const root = sampleBook()
  // A directory where the file should be: reading it throws, so the append cannot happen.
  rmSync(join(root, '.gitignore'), { force: true })
  mkdirSync(join(root, '.gitignore'), { recursive: true })

  const opened = openBackup(root, 'repair')
  assert.equal(opened.ok, true, 'the package still opens')
  assert.deepEqual(opened.value.warnings, ['gitignore-not-updated'])

  // And a normal book reports nothing: no false positive on the happy path.
  const clean = sampleBook()
  const plain = openBackup(clean, 'repair')
  assert.equal(plain.ok, true)
  assert.equal(plain.value.warnings, undefined)
})
