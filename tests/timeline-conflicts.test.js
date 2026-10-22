/**
 * Issue #28 — the timeline conflict rules on **both** nets: the rebuild's `validate()`
 * and the write planner, which share one judge (`timelineConflicts`).
 *
 * Why this file exists separately: `tests/timeline.test.js` covers the two ordering axes,
 * the pending area and the write surface. Every case there stays green when the write
 * gate is deleted — a refusal is only observable by its code and by what did not happen
 * on disk. Each refusal case below therefore asserts **two** things: the code, and that
 * the bytes of the file the call would have touched are unchanged (and that a would-be
 * new file was never created).
 *
 * The last group (multi-line title, participant separator, reused id) guards the write
 * surface itself: `frontmatterLine()` throws on a newline, and a stored value that cannot
 * read back as one id corrupts the event silently.
 *
 * They run against the BUILT artifacts (lib/index.js), like every other suite.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildIndex, domainTools, listTimelineEvents, parseWorldTime } from '../lib/index.js'

const DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-timeline-'))
}

function scaffold(root) {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '时间线测试' }, null, 2)}\n`, 'utf8')
}

function writeEvent(root, relativePath, frontmatter, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, `---\n${frontmatter.join('\n')}\n---\n\n${body}`, 'utf8')
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function callTool(name, args) {
  const tool = domainTools().find((candidate) => candidate.name === name)
  assert.ok(tool, `${name} must be registered by a domain module`)
  return tool.execute(args, { signal: new AbortController().signal, callId: 'timeline-test' })
}

/** Three events whose world order and narrative order deliberately disagree. */
function sampleBook(root) {
  scaffold(root)
  writeEvent(root, 'timeline/丙辰夜袭.md', [
    'id: t-3',
    'title: 丙辰夜袭',
    'worldTime: 1710-02-01',
    'narrativeOrder: 2',
    'chapterId: c-2',
    'participants: [c-a, c-b]',
  ])
  writeEvent(root, 'timeline/甲申立约.md', [
    'id: t-1',
    'title: 甲申立约',
    'worldTime: 1710-01-05',
    'narrativeOrder: 3',
    'chapterId: c-1',
  ])
  writeEvent(root, 'timeline/己卯屠村.md', ['id: t-2', 'title: 己卯屠村', 'worldTime: 1709-12-01', 'narrativeOrder: 1', 'chapterId: c-3'])
}

function ids(entries) {
  return (entries ?? []).map((entry) => entry.id)
}

// ---------------------------------------------------------------------------
// 3. The three conflict rules, on the rebuild net
// ---------------------------------------------------------------------------

test('timeline: a rebuild reports the missing time, the shared slot and the reversal', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    // TIMELINE_TIME_MISSING: confirmed, but no world time to place it by.
    writeEvent(root, 'timeline/缺时.md', ['id: t-missing', 'title: 缺时', 'chapterId: c-1', 'narrativeOrder: 1'])
    // TIMELINE_ORDER_CONFLICT: one slot, two different moments, one chapter.
    writeEvent(root, 'timeline/同槽甲.md', [
      'id: t-slot-a',
      'title: 同槽甲',
      'chapterId: c-9',
      'narrativeOrder: 4',
      'worldTime: 1710-01-01',
    ])
    writeEvent(root, 'timeline/同槽乙.md', [
      'id: t-slot-b',
      'title: 同槽乙',
      'chapterId: c-9',
      'narrativeOrder: 4',
      'worldTime: 1710-05-01',
    ])
    // TIMELINE_WORLD_TIME_REVERSED: slot 2 happens before slot 1 in world time.
    writeEvent(root, 'timeline/逆序甲.md', [
      'id: t-rev-a',
      'title: 逆序甲',
      'chapterId: c-7',
      'narrativeOrder: 1',
      'worldTime: 1710-06-01',
    ])
    writeEvent(root, 'timeline/逆序乙.md', [
      'id: t-rev-b',
      'title: 逆序乙',
      'chapterId: c-7',
      'narrativeOrder: 2',
      'worldTime: 1710-02-01',
    ])

    const build = await buildIndex(root)
    const codes = build.issues.map((issue) => issue.code)
    assert.ok(codes.includes('TIMELINE_TIME_MISSING'), `missing time not reported: ${codes.join(',')}`)
    assert.ok(codes.includes('TIMELINE_ORDER_CONFLICT'), `shared slot not reported: ${codes.join(',')}`)
    assert.ok(codes.includes('TIMELINE_WORLD_TIME_REVERSED'), `reversal not reported: ${codes.join(',')}`)
    assert.equal(
      build.issues.find((issue) => issue.code === 'TIMELINE_TIME_MISSING')?.path,
      'timeline/缺时.md',
    )
    // The reversal is filed against the event told later (the one that is out of place).
    assert.equal(
      build.issues.find((issue) => issue.code === 'TIMELINE_WORLD_TIME_REVERSED')?.path,
      'timeline/逆序乙.md',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. The three conflict rules, on the write net
// ---------------------------------------------------------------------------

test('timeline: a confirmed event without a world time is refused and nothing is written', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)
    const neighbour = join(root, 'timeline/丙辰夜袭.md')
    const before = sha256(neighbour)

    const refused = await callTool('inkflow_timeline_upsert', {
      projectRoot: root,
      title: '没有时间的惨案',
      chapter: 'c-2',
      narrativeOrder: 7,
      confirm: true,
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'TIMELINE_TIME_MISSING')
    assert.equal(existsSync(join(root, 'timeline/没有时间的惨案.md')), false, 'a refused write creates no file')
    assert.equal(sha256(neighbour), before, 'a refused write touches no other file')

    // The same call with the event parked in the pending area is legal.
    const parked = await callTool('inkflow_timeline_upsert', {
      projectRoot: root,
      title: '没有时间的惨案',
      chapter: 'c-2',
      narrativeOrder: 7,
      status: 'unconfirmed',
      confirm: true,
    })
    assert.equal(parked.ok, true)
    assert.equal(parked.status, 'unconfirmed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('timeline: a shared narrative slot with a different moment is refused on write', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    writeEvent(root, 'timeline/辰时开门.md', [
      'id: t-slot-a',
      'title: 辰时开门',
      'chapterId: c-9',
      'narrativeOrder: 4',
      'worldTime: 1710-03-01',
    ])
    await buildIndex(root)
    const existing = join(root, 'timeline/辰时开门.md')
    const before = sha256(existing)

    const refused = await callTool('inkflow_timeline_upsert', {
      projectRoot: root,
      title: '午时破门',
      chapter: 'c-9',
      narrativeOrder: 4,
      worldTime: '1710-09-01',
      confirm: true,
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'TIMELINE_ORDER_CONFLICT')
    assert.equal(existsSync(join(root, 'timeline/午时破门.md')), false)
    assert.equal(sha256(existing), before)

    // A different slot in the same chapter, later in world time, is fine.
    const accepted = await callTool('inkflow_timeline_upsert', {
      projectRoot: root,
      title: '午时破门',
      chapter: 'c-9',
      narrativeOrder: 6,
      worldTime: '1710-09-01',
      confirm: true,
    })
    assert.equal(accepted.ok, true, JSON.stringify(accepted.error ?? {}))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('timeline: a world time that goes backwards in one chapter is refused on write', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    writeEvent(root, 'timeline/卯时开门.md', [
      'id: t-rev-a',
      'title: 卯时开门',
      'chapterId: c-7',
      'narrativeOrder: 1',
      'worldTime: 1710-06-01',
    ])
    await buildIndex(root)
    const existing = join(root, 'timeline/卯时开门.md')
    const before = sha256(existing)

    const refused = await callTool('inkflow_timeline_upsert', {
      projectRoot: root,
      title: '回忆:两年前',
      chapter: 'c-7',
      narrativeOrder: 2,
      worldTime: '1709-06-01',
      confirm: true,
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'TIMELINE_WORLD_TIME_REVERSED')
    // `:` is not a portable file-name character, so the slug is `回忆-两年前` — assert
    // on the path the tool would actually have written, not on a name it never uses.
    assert.equal(existsSync(join(root, 'timeline/回忆-两年前.md')), false)
    assert.equal(sha256(existing), before)

    // The escape hatch the rule documents: give the flashback its own chapter.
    const accepted = await callTool('inkflow_timeline_upsert', {
      projectRoot: root,
      title: '回忆:两年前',
      chapter: 'c-8',
      narrativeOrder: 2,
      worldTime: '1709-06-01',
      confirm: true,
    })
    assert.equal(accepted.ok, true, JSON.stringify(accepted.error ?? {}))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('timeline: an illegal date is reported by a rebuild and refused by the tool', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    writeEvent(root, 'timeline/春天.md', ['id: t-bad', 'title: 春天', 'worldTime: 春天'])

    const build = await buildIndex(root)
    const invalid = build.issues.find((issue) => issue.code === 'TIMELINE_TIME_INVALID')
    assert.ok(invalid, 'an unparseable date is a validation issue, not a crash')
    assert.equal(invalid.path, 'timeline/春天.md')
    // Non-blocking: the index is still built and the row is still there.
    const rows = listTimelineEvents(root)
    assert.deepEqual(ids(rows), ['t-bad'])

    const refused = await callTool('inkflow_timeline_upsert', {
      projectRoot: root,
      title: '春天',
      worldTime: '春天',
      confirm: true,
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'TIMELINE_TIME_INVALID')

    // Calendar arithmetic is real: 30 February and month 13 do not parse.
    assert.equal(parseWorldTime('1710-02-30'), undefined)
    assert.equal(parseWorldTime('1710-13'), undefined)
    assert.equal(parseWorldTime('1710-02-28')?.precision, 'day')
    assert.equal(parseWorldTime('1710-02')?.precision, 'month')
    assert.equal(parseWorldTime('1710')?.precision, 'year')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. Write-side guards that are not order rules
// ---------------------------------------------------------------------------
test('timeline: a participant id the frontmatter cannot read back, and a reused id, are refused', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)

    // Participants are stored space-joined, so a value containing a separator would come
    // back as two ids — the same trap `KEYWORD_INVALID` closes for the world book.
    const badParticipant = await callTool('inkflow_timeline_upsert', {
      projectRoot: root,
      title: '两派签约',
      worldTime: '1710-01-01',
      participants: ['c-a c-b'],
      confirm: true,
    })
    assert.equal(badParticipant.ok, false)
    assert.equal(badParticipant.error.code, 'PARTICIPANT_INVALID')
    assert.equal(existsSync(join(root, 'timeline/两派签约.md')), false)

    const first = await callTool('inkflow_timeline_upsert', {
      projectRoot: root,
      title: '两派签约',
      id: 't-same',
      worldTime: '1710-01-01',
      confirm: true,
    })
    assert.equal(first.ok, true, JSON.stringify(first.error ?? {}))

    // A second file claiming the same id would silently replace the first row on the
    // next rebuild (one primary key holds one row).
    const duplicate = await callTool('inkflow_timeline_upsert', {
      projectRoot: root,
      title: '另一件事',
      id: 't-same',
      worldTime: '1710-02-01',
      confirm: true,
    })
    assert.equal(duplicate.ok, false)
    assert.equal(duplicate.error.code, 'DUPLICATE_ID')
    assert.equal(existsSync(join(root, 'timeline/另一件事.md')), false)

    // The same file keeping its id is an in-place edit, not a duplicate.
    const edited = await callTool('inkflow_timeline_upsert', {
      projectRoot: root,
      title: '两派签约',
      id: 't-same',
      worldTime: '1710-01-02',
      confirm: true,
    })
    assert.equal(edited.ok, true, JSON.stringify(edited.error ?? {}))
    assert.equal(edited.replaced, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('timeline: a multi-line title is refused instead of throwing at the renderer', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    // `frontmatterLine()` throws on a newline (it would split the block in half), so the
    // tool must refuse first: a throw escapes as a harness error, not a readable code.
    const refused = await callTool('inkflow_timeline_upsert', {
      projectRoot: root,
      title: '两派\n签约',
      worldTime: '1710-01-01',
      confirm: true,
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'TITLE_INVALID')
    assert.equal(readdirSync(join(root, 'timeline')).filter((name) => name !== '.gitkeep').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
