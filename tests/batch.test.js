/**
 * Issue #47 — the batch job queue: enqueue → take → complete → approve, resumable after a kill.
 *
 * What each block is for, so a failure names the promise that broke:
 *
 *   1. **建作业零写内容目录** — `enqueue` writes `.inkflow/jobs/` and nothing else: no chapter
 *      file, no catalog entry, no `index/` entry. A job is a plan, not a manuscript.
 *   2. **领取 → 交回 → 落盘** — `take` hands out the task with its writing context, `complete`
 *      gates the draft and writes the chapter, and the recorded digest is the sha256 of the
 *      bytes that landed.
 *   3. **断点续跑** — after a simulated kill the finished chapter is byte-identical and is not
 *      handed out again, the unfinished ones are, and the chapter count neither grows nor
 *      shrinks. The judgement is a digest, not "the file exists": a hand-made empty chapter is
 *      NOT treated as done, and a chapter the author edited afterwards is never overwritten.
 *   4. **门禁不通过 → paused 且没有写盘** — a warning-level verdict holds the draft in the job
 *      record, creates no chapter file, and refuses `take` and `resume` until `approve`.
 *   5. **并发上限** — the cap is on the job, not on one call: a second `take` before a
 *      `complete` returns nothing.
 *   6. **拿不到锁** — `PROJECT_BUSY` with `lockHolder`, never a hang (X-30).
 *   7. **落点** — `index/` gains no non-database file (ADR-0023 D2), `.gitignore` gains
 *      `.inkflow/` once.
 *   8. **工具与面板模型** — the four tools end to end, and the page's three states.
 *
 * The book fixture, the tool harness and the "clean vs warning" drafts are local to this file:
 * a shared helper would have to be right about two features at once.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CLAIM_LEASE_MS,
  DEFAULT_CONCURRENCY,
  EMPTY_BATCH_NOTE,
  JOB_FORMAT,
  JOB_STATUSES,
  MAX_ATTEMPTS,
  PAUSE_POLICIES,
  apply,
  approveDrafts,
  batchPanelState,
  buildBatchPage,
  chapterDigest,
  completeChapter,
  describeChapterStatus,
  describeGate,
  describeJobStatus,
  describePause,
  enqueueJob,
  isJobId,
  jobChapterPath,
  jobDirRelative,
  jobMetaPath,
  listJobs,
  pauseWorthy,
  readBatchPage,
  readJob,
  reconcileChapter,
  resumeBlockedReason,
  resumeJob,
  resumeViaChannel,
  statusFor,
  takeBatch,
} from '../lib/index.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHARACTERS = [
  { id: 'char-qingyin', name: '清音', aliases: ['音儿'] },
  { id: 'char-limubai', name: '李慕白', aliases: [] },
]

/** A complete, usable book in a temp directory. The caller always removes it. */
function book() {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-batch-'))
  const root = join(dir, '书')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const name of ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '批量之书' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.gitignore'), 'index/*.db\n', 'utf8')
  for (const card of CHARACTERS) {
    writeFileSync(
      join(root, 'characters', `${card.id}.md`),
      ['---', `id: ${card.id}`, `name: ${card.name}`, `aliases: [${card.aliases.join(', ')}]`, '---', '', `${card.name}的卡片。`, ''].join('\n'),
      'utf8',
    )
  }
  return { dir, root, done: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * A draft the seven gates have nothing to complain about at warning level.
 *
 * Deliberately short (2 paragraphs): `GATE_WORD_COUNT_LOW` is an `info` finding, and the pause
 * policy is about warnings — a 2000-character fixture would only make the test slower without
 * testing a different branch. The last line is a hook, which is the one warning a short draft
 * would otherwise trip.
 */
const CLEAN_BODY = ['他推开门，屋里没有人。', '', '他往前走了两步，听见楼梯上有脚步。', '', '门外是谁？'].join('\n')

/** The same length, ending on a closing summary: exactly one warning (`GATE_HOOK_SUMMARY`). */
const WARNED_BODY = ['他推开门，屋里没有人。', '', '他往前走了两步，听见楼梯上有脚步。', '', '就这样，他睡着了。'].join('\n')

const CHAPTERS = [{ seq: 1, title: '第 1 章' }, { seq: 2, title: '第 2 章' }, { seq: 3, title: '第 3 章' }]

function filesIn(dir) {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

/** Every chapter file (recursively) as project-relative paths, so a rename shows up too. */
function chapterFiles(root) {
  const out = []
  const walk = (rel) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(next)
      else if (entry.name.endsWith('.md')) out.push(next)
    }
  }
  walk('chapters')
  return out.sort()
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** A job with `count` chapters, already claimed, ready for `complete`. */
function claimed(root, count = 1, options = {}) {
  const enqueued = enqueueJob(root, { chapters: CHAPTERS.slice(0, count), ...options })
  assert.equal(enqueued.ok, true, `enqueue refused: ${JSON.stringify(enqueued.error ?? null)}`)
  const taken = takeBatch(root, { jobId: enqueued.value.jobId })
  assert.equal(taken.ok, true, `take refused: ${JSON.stringify(taken.error ?? null)}`)
  assert.equal(taken.value.tasks.length, count)
  return { jobId: enqueued.value.jobId, taken: taken.value }
}

function jobState(root, jobId) {
  const state = readJob(root, jobId)
  assert.equal(state.ok, true, `job unreadable: ${JSON.stringify(state.error ?? null)}`)
  return state.value
}

// ---------------------------------------------------------------------------
// 1. enqueue writes the plan and nothing else
// ---------------------------------------------------------------------------

test('建作业零写内容目录：只落 .inkflow/jobs/，chapters/ 与 index/ 一个新文件都没有', () => {
  const fixture = book()
  try {
    const before = chapterFiles(fixture.root)
    const indexBefore = filesIn(join(fixture.root, 'index'))
    const enqueued = enqueueJob(fixture.root, {
      chapters: [
        { title: '第 1 章', outline: '清音下山', budgetWords: 3000 },
        { title: '第 2 章' },
      ],
    })
    assert.equal(enqueued.ok, true, JSON.stringify(enqueued.error ?? null))
    const jobId = enqueued.value.jobId
    assert.equal(isJobId(jobId), true, `minted id ${jobId} must match bj-<8 hex>`)
    assert.equal(enqueued.value.chapters.length, 2)
    assert.equal(enqueued.value.meta.status, 'running')
    assert.equal(enqueued.value.meta.concurrency, DEFAULT_CONCURRENCY)
    assert.deepEqual(enqueued.value.skipped, [])

    // The records exist, at the agreed path, with the agreed shape.
    assert.equal(jobDirRelative(jobId), `.inkflow/jobs/${jobId}`)
    assert.equal(existsSync(join(fixture.root, ...jobMetaPath(jobId).split('/'))), true)
    assert.equal(existsSync(join(fixture.root, ...jobChapterPath(jobId, 1).split('/'))), true)
    const meta = JSON.parse(readFileSync(join(fixture.root, ...jobMetaPath(jobId).split('/')), 'utf8'))
    assert.equal(meta.format, JOB_FORMAT)
    assert.equal(meta.jobId, jobId)
    assert.deepEqual(
      meta.chapters.map((row) => [row.seq, row.status, row.attempts, row.digest]),
      [
        [1, 'pending', 0, null],
        [2, 'pending', 0, null],
      ],
      'meta.chapters is the roll-up of the chapter files',
    )

    // Zero content writes: no chapter file, no catalog, nothing but the database in index/.
    assert.deepEqual(chapterFiles(fixture.root), before, 'enqueue must not create a chapter file')
    assert.deepEqual(filesIn(join(fixture.root, 'index')), indexBefore, 'enqueue must not touch index/')
    assert.equal(existsSync(join(fixture.root, 'chapters', 'index.json')), false, 'no catalog entry either')

    // `.gitignore` gained the private-state line exactly once, and a second job does not repeat it.
    const ignore = readFileSync(join(fixture.root, '.gitignore'), 'utf8')
    assert.equal(ignore.split('\n').filter((line) => line.trim() === '.inkflow/').length, 1)
    const second = enqueueJob(fixture.root, { chapters: [{ title: '第 9 章' }] })
    assert.equal(second.ok, true)
    const ignoreAgain = readFileSync(join(fixture.root, '.gitignore'), 'utf8')
    assert.equal(ignoreAgain.split('\n').filter((line) => line.trim() === '.inkflow/').length, 1, 'the ignore line stays idempotent')
    assert.equal(listJobs(fixture.root).length, 2)
  } finally {
    fixture.done()
  }
})

test('加章到既有作业：同 seq 幂等跳过，不同 seq 追加', () => {
  const fixture = book()
  try {
    const first = enqueueJob(fixture.root, { chapters: [{ seq: 1, title: '第 1 章' }] })
    assert.equal(first.ok, true)
    const jobId = first.value.jobId
    const again = enqueueJob(fixture.root, { jobId, chapters: [{ seq: 1, title: '重写第 1 章' }, { seq: 2, title: '第 2 章' }] })
    assert.equal(again.ok, true, JSON.stringify(again.error ?? null))
    assert.deepEqual(again.value.skipped, [1], 'an existing seq is skipped, not rewritten')
    assert.deepEqual(
      again.value.chapters.map((chapter) => [chapter.seq, chapter.title]),
      [
        [1, '第 1 章'],
        [2, '第 2 章'],
      ],
    )
    assert.equal(again.value.chapters.length, 2)
  } finally {
    fixture.done()
  }
})

// ---------------------------------------------------------------------------
// 2. take → complete → the chapter lands
// ---------------------------------------------------------------------------

test('领取 → 交回 → 落盘：章文件按 seq 建出来，记录里的 digest 就是文件字节的 sha256', async () => {
  const fixture = book()
  try {
    const enqueued = enqueueJob(fixture.root, {
      chapters: [{ seq: 1, title: '第 1 章', outline: '清音下山', budgetWords: 3000 }],
    })
    assert.equal(enqueued.ok, true)
    const jobId = enqueued.value.jobId

    const taken = takeBatch(fixture.root, { jobId })
    assert.equal(taken.ok, true, JSON.stringify(taken.error ?? null))
    assert.equal(taken.value.tasks.length, 1)
    const task = taken.value.tasks[0]
    assert.equal(task.seq, 1)
    assert.equal(task.title, '第 1 章')
    assert.equal(task.outline, '清音下山')
    assert.equal(task.budgetWords, 3000)
    assert.equal(task.attempts, 1)
    // The writing context is the brief's own assembly (X-23): nine segments and a token budget.
    // A planned chapter has no file yet, so the brief describes the book's newest chapter and
    // says `planned: true` instead of passing that block off as this chapter's plan.
    assert.equal(task.context.segments.length, 9, 'the brief always reports all nine segments')
    assert.ok(task.context.budgetTokens > 0)
    assert.equal(task.context.planned, true)
    assert.equal(task.context.chapterSeq, null, 'this book has no chapter yet')
    assert.equal(task.context.segments.find((segment) => segment.id === 'outline').missing, true)

    const chapterFilesBefore = chapterFiles(fixture.root)
    assert.deepEqual(chapterFilesBefore, [], 'take hands out a task and writes nothing')

    const done = await completeChapter(fixture.root, { jobId, seq: 1, body: CLEAN_BODY })
    assert.equal(done.ok, true, JSON.stringify(done.error ?? null))
    assert.equal(done.value.written, true)
    assert.equal(done.value.paused, false)
    assert.equal(done.value.path, done.value.state.chapters[0].path)
    const chapterPath = workedPath(fixture.root, done.value.path)
    assert.equal(existsSync(chapterPath), true)
    const fileText = readFileSync(chapterPath, 'utf8')
    assert.ok(fileText.includes(CLEAN_BODY), 'the prose must be in the chapter file')
    assert.ok(fileText.startsWith('---'), 'the chapter file keeps its frontmatter')
    assert.equal(done.value.digest, sha256File(chapterPath), 'the recorded digest is the file bytes, not the string handed in')
    assert.equal(done.value.state.chapters[0].status, 'done')
    assert.equal(done.value.state.chapters[0].chapterId, done.value.chapterId)
    assert.notEqual(done.value.chapterId, null)

    // The gate ran, and its verdict is in the record (counts for all, findings for a sample).
    const gate = done.value.state.chapters[0].gate
    assert.notEqual(gate, null)
    assert.equal(gate.counts.warning, 0, 'a clean draft has no warning')
    assert.equal(gate.checks.length, 7, 'all seven checks report, even with zero findings')
    assert.equal(gate.paused, false)

    // A second complete is refused: the chapter is no longer claimed.
    const twice = await completeChapter(fixture.root, { jobId, seq: 1, body: CLEAN_BODY })
    assert.equal(twice.ok, false)
    assert.equal(twice.error.code, 'CHAPTER_NOT_CLAIMED')
    assert.equal(readFileSync(chapterPath, 'utf8'), fileText, 'the refused call changed nothing')

    // Nothing left to claim, and the job is finished.
    const again = takeBatch(fixture.root, { jobId })
    assert.equal(again.ok, true)
    assert.equal(again.value.tasks.length, 0)
    assert.equal(again.value.reason, 'NOTHING_PENDING')
    assert.equal(again.value.state.meta.status, 'done')
    assert.equal(catalogChapterCount(fixture.root), 1, 'the catalog has exactly one chapter')
  } finally {
    fixture.done()
  }
})

/** `chapters/0001-x.md` → an absolute path inside the fixture. */
function workedPath(root, relative) {
  return join(root, ...relative.split('/'))
}

/**
 * Chapters the catalog claims: `chapters/index.json`'s loose chapters plus every volume's own
 * `index.json`. Asserted after a batch write to prove the projection was rebuilt, not just the
 * file created.
 */
function catalogChapterCount(root) {
  const base = join(root, 'chapters')
  let count = 0
  const rootFile = join(base, 'index.json')
  if (existsSync(rootFile)) {
    const catalog = JSON.parse(readFileSync(rootFile, 'utf8'))
    count += Array.isArray(catalog.looseChapters) ? catalog.looseChapters.length : 0
  }
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const volumeFile = join(base, entry.name, 'index.json')
    if (!existsSync(volumeFile)) continue
    const volume = JSON.parse(readFileSync(volumeFile, 'utf8'))
    count += Array.isArray(volume.chapters) ? volume.chapters.length : 0
  }
  return count
}

// ---------------------------------------------------------------------------
// 3. resume after a kill
// ---------------------------------------------------------------------------

test('断点续跑：kill 后续跑不重复不丢章，已完成的章一个字节都没变', async () => {
  const fixture = book()
  try {
    const start = Date.parse('2026-10-25T10:00:00.000Z')
    const enqueued = enqueueJob(fixture.root, { chapters: CHAPTERS, now: start })
    assert.equal(enqueued.ok, true)
    const jobId = enqueued.value.jobId

    // Three chapters claimed, one completed — then the process dies.
    const first = takeBatch(fixture.root, { jobId, now: start })
    assert.equal(first.ok, true)
    assert.equal(first.value.tasks.length, 3, 'concurrency 3 hands out three chapters')
    const completed = await completeChapter(fixture.root, { jobId, seq: 1, body: CLEAN_BODY, now: start + 1000 })
    assert.equal(completed.ok, true, JSON.stringify(completed.error ?? null))
    const finishedPath = workedPath(fixture.root, completed.value.path)
    const finishedBytes = readFileSync(finishedPath)
    const finishedDigest = sha256File(finishedPath)
    const filesAfterKill = chapterFiles(fixture.root)
    assert.equal(filesAfterKill.length, 1)

    // A fresh process, the same job: the live claims are gone (their lease expired), so the two
    // unfinished chapters come back and the finished one does not.
    const resumed = takeBatch(fixture.root, { jobId, now: start + CLAIM_LEASE_MS + 5000 })
    assert.equal(resumed.ok, true, JSON.stringify(resumed.error ?? null))
    assert.deepEqual(
      resumed.value.tasks.map((task) => task.seq),
      [2, 3],
      'only the unfinished chapters are handed out again',
    )
    assert.deepEqual(
      resumed.value.tasks.map((task) => task.attempts),
      [2, 2],
      'a re-claim counts as an attempt',
    )
    assert.equal(readFileSync(finishedPath).equals(finishedBytes), true, 'the finished chapter is byte-identical')
    assert.equal(sha256File(finishedPath), finishedDigest)
    assert.equal(chapterFiles(fixture.root).length, 1, 'nothing new was created by resuming')

    // The record of chapter 1 still says done with the same digest: it was never re-queued.
    const state = jobState(fixture.root, jobId)
    const first_ = state.chapters[0]
    assert.equal(first_.status, 'done')
    assert.equal(first_.attempts, 1, 'a finished chapter is not claimed a second time')
    assert.equal(first_.digest, finishedDigest)

    // Finish the other two: the book ends up with exactly three chapters, no duplicates.
    for (const seq of [2, 3]) {
      // The hook has to stay the last line, or the gate holds the draft — that is the point of
      // `WARNED_BODY`, so the marker goes in front here.
      const body = `第${String(seq)}章。\n\n${CLEAN_BODY}`
      const done = await completeChapter(fixture.root, { jobId, seq, body, now: start + CLAIM_LEASE_MS + 9000 })
      assert.equal(done.ok, true, JSON.stringify(done.error ?? null))
      assert.equal(done.value.written, true, `chapter ${String(seq)} must land, not pause`)
    }
    const final = jobState(fixture.root, jobId)
    assert.equal(final.chapters.length, 3, 'the chapter count neither grows nor shrinks')
    assert.deepEqual(
      final.chapters.map((chapter) => [chapter.seq, chapter.status]),
      [
        [1, 'done'],
        [2, 'done'],
        [3, 'done'],
      ],
    )
    assert.deepEqual(new Set(final.chapters.map((chapter) => chapter.path)).size, 3, 'every chapter has its own file')
    assert.equal(chapterFiles(fixture.root).length, 3)
    assert.equal(final.meta.status, 'done')
    assert.equal(catalogChapterCount(fixture.root), 3)
  } finally {
    fixture.done()
  }
})

test('续跑判据是摘要不是「文件存在」：手工新建的空章不算已完成', async () => {
  const fixture = book()
  try {
    // An author created a chapter by hand — the file exists and is empty.
    mkdirSync(join(fixture.root, 'chapters', 'vol-01'), { recursive: true })
    writeFileSync(join(fixture.root, 'chapters', 'vol-01', '0001-手写.md'), '---\nid: hand-1\ntitle: 手写第一章\nseq: 1\n---\n', 'utf8')

    const enqueued = enqueueJob(fixture.root, { chapters: [{ seq: 2, title: '第 2 章' }] })
    assert.equal(enqueued.ok, true)
    const jobId = enqueued.value.jobId
    const taken = takeBatch(fixture.root, { jobId })
    assert.equal(taken.ok, true)
    assert.deepEqual(taken.value.tasks.map((task) => task.seq), [2], 'the hand-made empty chapter is not a finished task')

    // A job chapter that says done but whose file no longer matches is not trusted either.
    const done = await completeChapter(fixture.root, { jobId, seq: 2, body: CLEAN_BODY })
    assert.equal(done.ok, true)
    const path = workedPath(fixture.root, done.value.path)
    const state = jobState(fixture.root, jobId)
    assert.equal(reconcileChapter(fixture.root, state.chapters[0]).status, 'done')

    // The author edits the chapter afterwards: the job must not overwrite that, and must not
    // pretend it is its own text either.
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n作者补了一句。`, 'utf8')
    const edited = reconcileChapter(fixture.root, state.chapters[0])
    assert.equal(edited.status, 'edited')
    assert.equal(edited.lastError.code, 'CHAPTER_EDITED')
    assert.equal(edited.digest, state.chapters[0].digest, 'the record keeps what the job wrote')

    const afterEdit = await completeChapter(fixture.root, { jobId, seq: 2, body: '另一版' })
    assert.equal(afterEdit.ok, false)
    assert.equal(afterEdit.error.code, 'CHAPTER_NOT_CLAIMED')
    assert.ok(readFileSync(path, 'utf8').includes('作者补了一句。'), 'the author text survives')

    const again = takeBatch(fixture.root, { jobId })
    assert.equal(again.ok, true)
    assert.equal(again.value.tasks.length, 0, 'an edited chapter is terminal, never handed out again')
    assert.equal(again.value.state.chapters[0].status, 'edited')
    assert.equal(again.value.state.meta.status, 'done')
  } finally {
    fixture.done()
  }
})

// ---------------------------------------------------------------------------
// 4. the gate stops the job, and nothing is written
// ---------------------------------------------------------------------------

test('门禁不通过 → paused 且没有写盘；approve 之后才落盘（草稿原样写入，判决留在记录里）', async () => {
  const fixture = book()
  try {
    const { jobId } = claimed(fixture.root, 1)
    const beforeFiles = chapterFiles(fixture.root)
    const beforeIndex = filesIn(join(fixture.root, 'index'))

    const held = await completeChapter(fixture.root, { jobId, seq: 1, body: WARNED_BODY })
    assert.equal(held.ok, true, JSON.stringify(held.error ?? null))
    assert.equal(held.value.written, false, 'a warning-level verdict writes nothing')
    assert.equal(held.value.paused, true)
    assert.equal(held.value.digest, null)
    assert.deepEqual(chapterFiles(fixture.root), beforeFiles, 'no chapter file was created')
    assert.deepEqual(filesIn(join(fixture.root, 'index')), beforeIndex, 'and the index did not move either')
    assert.equal(catalogChapterCount(fixture.root), 0)

    // The verdict and the draft are both in the record, so approving costs no second draft.
    const record = JSON.parse(readFileSync(join(fixture.root, ...jobChapterPath(jobId, 1).split('/')), 'utf8'))
    assert.equal(record.status, 'held')
    assert.equal(record.pendingBody, WARNED_BODY)
    assert.equal(record.gate.counts.warning, 1)
    assert.equal(record.gate.paused, true)
    assert.ok(record.gate.findings.some((finding) => finding.code === 'GATE_HOOK_SUMMARY'))
    assert.equal(jobState(fixture.root, jobId).meta.status, 'paused')
    assert.deepEqual(jobState(fixture.root, jobId).meta.pauseReason.seqs, [1])

    // A paused job hands out nothing, and 续跑 is not the door.
    const noTask = takeBatch(fixture.root, { jobId })
    assert.equal(noTask.ok, true)
    assert.equal(noTask.value.tasks.length, 0)
    assert.equal(noTask.value.reason, 'PAUSED')
    const resume = resumeJob(fixture.root, { jobId })
    assert.equal(resume.ok, false)
    assert.equal(resume.error.code, 'APPROVAL_REQUIRED')

    // Approving needs `confirm: true`, and nothing else gets approved.
    const unconfirmed = await approveDrafts(fixture.root, { jobId, seq: 1 })
    assert.equal(unconfirmed.ok, false)
    assert.equal(unconfirmed.error.code, 'CONFIRM_REQUIRED')
    assert.deepEqual(chapterFiles(fixture.root), beforeFiles)
    const wrongSeq = await approveDrafts(fixture.root, { jobId, seq: 2, confirm: true })
    assert.equal(wrongSeq.ok, false)
    assert.equal(wrongSeq.error.code, 'CHAPTER_NOT_HELD')

    const approved = await approveDrafts(fixture.root, { jobId, seq: 1, confirm: true })
    assert.equal(approved.ok, true, JSON.stringify(approved.error ?? null))
    assert.deepEqual(approved.value.approved, [1])
    const written = workedPath(fixture.root, approved.value.written[0].path)
    assert.equal(existsSync(written), true, 'approval is what writes the chapter')
    assert.ok(readFileSync(written, 'utf8').includes(WARNED_BODY), 'the bytes written are the bytes the gate judged')
    assert.equal(approved.value.written[0].digest, sha256File(written))

    const after = jobState(fixture.root, jobId)
    assert.equal(after.chapters[0].status, 'done')
    assert.equal(after.chapters[0].gate.paused, true, 'approval overrides the warning, it does not erase it')
    assert.equal(after.meta.status, 'done')
    assert.equal(after.meta.pauseReason, null, 'the pause clears once nothing is held')
    assert.equal(after.chapters[0].pendingBody, null)
  } finally {
    fixture.done()
  }
})

test('pauseOn: "any" 把 info 也算进来；"warning" 不看 info', () => {
  assert.equal(pauseWorthy({ total: 3, warning: 0 }, 'warning'), false)
  assert.equal(pauseWorthy({ total: 3, warning: 0 }, 'any'), true)
  assert.equal(pauseWorthy({ total: 1, warning: 1 }, 'warning'), true)
  assert.deepEqual([...PAUSE_POLICIES], ['warning', 'any'], 'there is no "never": the gate always runs')
})

// ---------------------------------------------------------------------------
// 5. the concurrency cap is on the job, not on one call
// ---------------------------------------------------------------------------

test('并发上限：一次 take 不超 batchSize，在写满了再来一次什么都不给，交回一章才放出一章', async () => {
  const fixture = book()
  try {
    const enqueued = enqueueJob(fixture.root, { chapters: CHAPTERS, concurrency: 2, batchSize: 5 })
    assert.equal(enqueued.ok, true)
    const jobId = enqueued.value.jobId
    assert.equal(enqueued.value.meta.concurrency, 2)
    assert.equal(enqueued.value.meta.batchSize, 5)

    const first = takeBatch(fixture.root, { jobId })
    assert.equal(first.ok, true)
    assert.deepEqual(first.value.tasks.map((task) => task.seq), [1, 2], 'concurrency 2 caps the batch at two')
    assert.equal(first.value.inFlight, 2)
    assert.equal(first.value.remaining, 1)

    const blocked = takeBatch(fixture.root, { jobId })
    assert.equal(blocked.ok, true)
    assert.equal(blocked.value.tasks.length, 0)
    assert.equal(blocked.value.reason, 'CONCURRENCY_REACHED')

    const done = await completeChapter(fixture.root, { jobId, seq: 2, body: CLEAN_BODY })
    assert.equal(done.ok, true, JSON.stringify(done.error ?? null))
    const next = takeBatch(fixture.root, { jobId })
    assert.equal(next.ok, true)
    assert.deepEqual(next.value.tasks.map((task) => task.seq), [3], 'one completion frees exactly one slot')

    const capped = enqueueJob(fixture.root, {
      jobId,
      chapters: [...CHAPTERS, { seq: 4, title: '第 4 章' }],
      concurrency: 99,
      batchSize: 99,
    })
    assert.equal(capped.ok, true)
    assert.equal(capped.value.skipped.length, 3, 'the three existing seqs are skipped')
    assert.equal(capped.value.meta.concurrency, 2, 'the caps are fixed when the job is created')
    assert.deepEqual(capped.value.chapters.map((chapter) => chapter.seq), [1, 2, 3, 4])
  } finally {
    fixture.done()
  }
})

// ---------------------------------------------------------------------------
// 6. the lock: PROJECT_BUSY with the holder, never a hang
// ---------------------------------------------------------------------------

test('拿不到写锁 → PROJECT_BUSY 并说清 lockHolder；锁放开后同一调用就能继续', () => {
  const fixture = book()
  try {
    const enqueued = enqueueJob(fixture.root, { chapters: CHAPTERS })
    assert.equal(enqueued.ok, true)
    const jobId = enqueued.value.jobId

    // Another session holds the write lock: on disk, pid alive, started a moment ago.
    //
    // The pid cannot be ours: `io.ts` treats "my own pid, not in my lock table" as a leftover
    // from a killed generation and heals it (data-safety §2.1). So the test borrows the one pid
    // it knows is alive and is not this process — its parent (the test runner).
    const lockPath = join(fixture.root, 'index', '.write.lock')
    writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, token: 'other-session', startedAt: Date.now() }), 'utf8')

    const busy = takeBatch(fixture.root, { jobId })
    assert.equal(busy.ok, false)
    assert.equal(busy.error.code, 'PROJECT_BUSY')
    assert.equal(busy.error.lockHolder.pid, process.ppid)
    assert.equal(typeof busy.error.lockHolder.startedAt, 'string')
    assert.match(busy.error.hint ?? '', /wait for it to finish/)

    const alsoBusy = enqueueJob(fixture.root, { jobId, chapters: [{ seq: 9, title: '第 9 章' }] })
    assert.equal(alsoBusy.ok, false)
    assert.equal(alsoBusy.error.code, 'PROJECT_BUSY', 'every mutating action takes the lock, not just take')

    rmSync(lockPath)
    const after = takeBatch(fixture.root, { jobId })
    assert.equal(after.ok, true, JSON.stringify(after.error ?? null))
    assert.equal(after.value.tasks.length, 3)
  } finally {
    fixture.done()
  }
})

// ---------------------------------------------------------------------------
// 7. 落点：index/ 除数据库外为空
// ---------------------------------------------------------------------------

test('落点：跑完整条链路后 index/ 只剩 .gitkeep 与数据库文件，作业记录全在 .inkflow/jobs/', async () => {
  const fixture = book()
  try {
    const { jobId } = claimed(fixture.root, 1)
    const done = await completeChapter(fixture.root, { jobId, seq: 1, body: CLEAN_BODY })
    assert.equal(done.ok, true, JSON.stringify(done.error ?? null))

    const entries = readdirSync(join(fixture.root, 'index'))
    const allowed = entries.filter((name) => name !== '.gitkeep' && !/\.db(?:-wal|-shm)?$/u.test(name))
    assert.deepEqual(allowed, [], `index/ must stay empty apart from the database (found ${allowed.join(', ')})`)

    // Every record the feature wrote lives under .inkflow/jobs/<jobId>/.
    const jobFiles = []
    const walk = (rel) => {
      for (const entry of readdirSync(join(fixture.root, rel), { withFileTypes: true })) {
        const next = `${rel}/${entry.name}`
        if (entry.isDirectory()) walk(next)
        else jobFiles.push(next)
      }
    }
    walk(`.inkflow/jobs/${jobId}`)
    assert.deepEqual(jobFiles.sort(), [
      `.inkflow/jobs/${jobId}/chapters/1.json`,
      `.inkflow/jobs/${jobId}/meta.json`,
    ])
    assert.equal(statSync(join(fixture.root, '.inkflow', 'jobs', jobId, 'meta.json')).isFile(), true)
  } finally {
    fixture.done()
  }
})

// ---------------------------------------------------------------------------
// 8. attempts, resume, status derivation
// ---------------------------------------------------------------------------

test('重试上限：领满 3 次仍交不回 → 该章 failed 并留在记录里；resume 才把它放回队列', () => {
  const fixture = book()
  try {
    const enqueued = enqueueJob(fixture.root, { chapters: [{ seq: 1, title: '第 1 章' }] })
    assert.equal(enqueued.ok, true)
    const jobId = enqueued.value.jobId
    let now = Date.now()
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const taken = takeBatch(fixture.root, { jobId, now })
      assert.equal(taken.ok, true)
      assert.equal(taken.value.tasks.length, 1, `attempt ${String(attempt)} claims the chapter`)
      assert.equal(taken.value.tasks[0].attempts, attempt)
      now += CLAIM_LEASE_MS + 1000
    }
    const exhausted = takeBatch(fixture.root, { jobId, now })
    assert.equal(exhausted.ok, true)
    assert.equal(exhausted.value.tasks.length, 0)
    assert.equal(exhausted.value.state.chapters[0].status, 'failed')
    assert.equal(exhausted.value.state.chapters[0].lastError.code, 'ATTEMPTS_EXCEEDED')
    assert.equal(exhausted.value.state.meta.status, 'failed')

    const resumed = resumeJob(fixture.root, { jobId, now })
    assert.equal(resumed.ok, true, JSON.stringify(resumed.error ?? null))
    assert.equal(resumed.value.chapters[0].status, 'pending')
    assert.equal(resumed.value.chapters[0].attempts, 0, 'a human retry gets a fresh budget')
    assert.equal(resumed.value.meta.status, 'running')
    const taken = takeBatch(fixture.root, { jobId, now: now + 1000 })
    assert.equal(taken.ok, true)
    assert.equal(taken.value.tasks.length, 1)
  } finally {
    fixture.done()
  }
})

test('状态派生：有 held 就是 paused；还有可领的就是 running；都没有才算 done/failed', () => {
  const chapter = (status) => ({ status })
  assert.equal(statusFor([], 'running'), 'running')
  assert.equal(statusFor([chapter('held'), chapter('pending')], 'running'), 'paused')
  assert.equal(statusFor([chapter('done'), chapter('pending')], 'paused'), 'running')
  assert.equal(statusFor([chapter('done'), chapter('edited')], 'running'), 'done')
  assert.equal(statusFor([chapter('done'), chapter('failed')], 'running'), 'failed')
})

// ---------------------------------------------------------------------------
// 9. the panel: routes and the three states
// ---------------------------------------------------------------------------

test('面板：GET /batch 是只读投影；三个状态（无作业 / 进行中 / 收口），暂停原因与续跑的可点性各说清楚', async () => {
  const fixture = book()
  try {
    const empty = buildBatchPage({ sessionId: 'session-1', root: fixture.root }, '0.5.0', {})
    assert.equal(empty.status, 200)
    const emptyView = readBatchPage({ ok: true, value: empty.body.value })
    assert.equal(emptyView.selected, null)
    assert.equal(batchPanelState(emptyView), 'empty')
    assert.equal(EMPTY_BATCH_NOTE.includes('inkflow_batch_enqueue'), true, 'the empty state names the tool that helps')

    const { jobId } = claimed(fixture.root, 2)
    const running = buildBatchPage({ sessionId: 'session-1', root: fixture.root }, '0.5.0', { jobId })
    assert.equal(running.status, 200)
    const runningView = readBatchPage({ ok: true, value: running.body.value })
    assert.equal(batchPanelState(runningView), 'active')
    assert.equal(runningView.jobs.length, 1)
    assert.equal(runningView.selected.jobId, jobId)
    assert.equal(runningView.selected.inFlight, 2)
    assert.equal(runningView.selected.counts.running, 2)
    assert.equal(describeJobStatus(runningView.selected.status), '进行中')
    assert.equal(resumeBlockedReason(runningView.selected).includes('正在写'), true)
    assert.equal(describePause(runningView.selected), null)

    // The route writes nothing: two reads, same bytes on disk.
    const before = readFileSync(join(fixture.root, ...jobMetaPath(jobId).split('/')), 'utf8')
    buildBatchPage({ sessionId: 'session-1', root: fixture.root }, '0.5.0', { jobId })
    assert.equal(readFileSync(join(fixture.root, ...jobMetaPath(jobId).split('/')), 'utf8'), before)

    // A gated draft: paused with the reason, and 续跑 is refused as the way forward.
    const held = await completeChapter(fixture.root, { jobId, seq: 1, body: WARNED_BODY })
    assert.equal(held.ok, true)
    const pausedPage = buildBatchPage({ sessionId: 'session-1', root: fixture.root }, '0.5.0', { jobId })
    const pausedView = readBatchPage({ ok: true, value: pausedPage.body.value })
    assert.equal(pausedView.selected.status, 'paused')
    assert.equal(batchPanelState(pausedView), 'active')
    assert.match(describePause(pausedView.selected) ?? '', /已暂停/)
    assert.match(resumeBlockedReason(pausedView.selected) ?? '', /inkflow_batch_approve/)
    assert.equal(describeGate(pausedView.selected.chapters[0].gate)?.includes('需要处理 1'), true)
    assert.equal(describeChapterStatus('held').startsWith('待批准'), true)

    const refused = resumeViaChannel({ sessionId: 'session-1', root: fixture.root }, '0.5.0', { jobId })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error.code, 'APPROVAL_REQUIRED')

    // Approve, then finish: the page收口, and 续跑 is disabled for the honest reason.
    const approved = await approveDrafts(fixture.root, { jobId, seq: 1, confirm: true })
    assert.equal(approved.ok, true)
    const clean = await completeChapter(fixture.root, { jobId, seq: 2, body: CLEAN_BODY })
    assert.equal(clean.ok, true, JSON.stringify(clean.error ?? null))
    const closedPage = buildBatchPage({ sessionId: 'session-1', root: fixture.root }, '0.5.0', { jobId })
    const closedView = readBatchPage({ ok: true, value: closedPage.body.value })
    assert.equal(batchPanelState(closedView), 'closed')
    assert.equal(describeJobStatus(closedView.selected.status), '全部完成')
    assert.equal(resumeBlockedReason(closedView.selected).includes('全部写完'), true)
    assert.equal(closedView.selected.counts.done, 2)

    // A job id that does not exist is reported, not guessed away.
    const missing = buildBatchPage({ sessionId: 'session-1', root: fixture.root }, '0.5.0', { jobId: 'bj-00000000' })
    assert.equal(missing.status, 404)
    const missingView = readBatchPage({ ok: true, value: missing.body.value })
    assert.equal(missingView.error.code, 'JOB_NOT_FOUND')
    assert.equal(batchPanelState(missingView), 'empty')

    // A transport failure and a missing session are their own sentences.
    assert.equal(readBatchPage(null).transport, 'NETWORK')
    assert.equal(batchPanelState(readBatchPage({ ok: false, error: { code: 'NO_SESSION_CONTEXT' } })), 'empty')
  } finally {
    fixture.done()
  }
})

// ---------------------------------------------------------------------------
// 10. the four tools, end to end
// ---------------------------------------------------------------------------

function createHarness({ sessionId = 'session-1', workspace }) {
  const tools = new Map()
  const ctx = {
    effect(setup) {
      const dispose = setup()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    get(name) {
      if (name === 'workspaceRegistry') {
        return { list: () => [{ id: 'ws-1', path: workspace, name: '书' }] }
      }
      if (name === 'sessions') return { get: () => ({ id: sessionId, workspaceId: 'ws-1', cwd: workspace }) }
      if (name === 'workingDirectory') {
        return { get: () => workspace, ensure: async () => workspace }
      }
      return undefined
    },
    logger() {
      return { debug() {}, info() {}, warn() {}, error() {} }
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {
          tools.delete(definition.name)
        }
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

function makeTools(dataDir, workspace) {
  const harness = createHarness({ workspace })
  apply(harness.ctx, { dataDir })
  return harness
}

async function callTool(harness, name, args) {
  const tool = harness.tools.get(name)
  assert.ok(tool, `tool ${name} must be registered`)
  return tool.execute(args, { signal: AbortSignal.timeout(20000), agent: { id: 'test-session' } })
}

test('工具：enqueue 零写内容 → take 给上下文 → complete 落盘 → approve 需 confirm（一条链路）', async () => {
  const fixture = book()
  const dataDir = mkdtempSync(join(tmpdir(), 'inkflow-batch-state-'))
  try {
    const harness = makeTools(dataDir, fixture.dir)
    const enqueued = await callTool(harness, 'inkflow_batch_enqueue', {
      projectRoot: fixture.root,
      chapters: [{ seq: 1, title: '第 1 章', outline: '清音下山' }],
    })
    assert.equal(enqueued.ok, true, JSON.stringify(enqueued.error ?? null))
    assert.equal(enqueued.contentFilesWritten, 0, 'enqueue says in the reply that it wrote no content file')
    const jobId = enqueued.jobId
    assert.equal(enqueued.chapters.length, 1)
    assert.deepEqual(chapterFiles(fixture.root), [])

    const taken = await callTool(harness, 'inkflow_batch_take', { projectRoot: fixture.root, jobId })
    assert.equal(taken.ok, true, JSON.stringify(taken.error ?? null))
    assert.equal(taken.tasks.length, 1)
    assert.equal(taken.tasks[0].context.segments.length, 9)
    assert.equal(taken.tasks[0].context.planned, true)

    const held = await callTool(harness, 'inkflow_batch_complete', { projectRoot: fixture.root, jobId, seq: 1, body: WARNED_BODY })
    assert.equal(held.ok, true, JSON.stringify(held.error ?? null))
    assert.equal(held.written, false)
    assert.equal(held.paused, true)
    assert.equal(held.verdict.warning, 1)
    assert.deepEqual(chapterFiles(fixture.root), [])

    const unconfirmed = await callTool(harness, 'inkflow_batch_approve', { projectRoot: fixture.root, jobId, seq: 1 })
    assert.equal(unconfirmed.ok, false)
    assert.equal(unconfirmed.error.code, 'CONFIRM_REQUIRED')
    assert.deepEqual(chapterFiles(fixture.root), [])

    const approved = await callTool(harness, 'inkflow_batch_approve', { projectRoot: fixture.root, jobId, seq: 1, confirm: true })
    assert.equal(approved.ok, true, JSON.stringify(approved.error ?? null))
    assert.deepEqual(approved.approved, [1])
    assert.equal(chapterFiles(fixture.root).length, 1)
    assert.equal(approved.status, 'done')

    // The four names are the whole surface this issue adds.
    for (const name of ['inkflow_batch_enqueue', 'inkflow_batch_take', 'inkflow_batch_complete', 'inkflow_batch_approve']) {
      assert.equal(harness.tools.has(name), true, `${name} must be registered`)
    }
    assert.equal(harness.tools.has('inkflow_batch_resume'), false, 'resume is the panel route, not a fifth tool')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    fixture.done()
  }
})

test('工具：take 在暂停的作业上不给任务（PAUSED），并报出暂停原因', async () => {
  const fixture = book()
  const dataDir = mkdtempSync(join(tmpdir(), 'inkflow-batch-state-'))
  try {
    const harness = makeTools(dataDir, fixture.dir)
    const enqueued = await callTool(harness, 'inkflow_batch_enqueue', {
      projectRoot: fixture.root,
      chapters: [{ seq: 1, title: '第 1 章' }],
    })
    const jobId = enqueued.jobId
    await callTool(harness, 'inkflow_batch_take', { projectRoot: fixture.root, jobId })
    await callTool(harness, 'inkflow_batch_complete', { projectRoot: fixture.root, jobId, seq: 1, body: WARNED_BODY })
    const taken = await callTool(harness, 'inkflow_batch_take', { projectRoot: fixture.root, jobId })
    assert.equal(taken.ok, true)
    assert.equal(taken.tasks.length, 0)
    assert.equal(taken.reason, 'PAUSED')
    assert.equal(taken.status, 'paused')
    assert.deepEqual(taken.pauseReason.seqs, [1])
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    fixture.done()
  }
})

// ---------------------------------------------------------------------------
// 11. the draft seam in gate.ts (§ #47 touched one merged file)
// ---------------------------------------------------------------------------

test('gate 的 draft 通道：按草稿判定而不必先落盘，且 drafts 不许写结论文件', async () => {
  const fixture = book()
  try {
    const { runGate } = await import('../lib/index.js')
    const drafted = runGate(fixture.root, {}, { record: false, draft: { body: WARNED_BODY, title: '第 1 章', seq: 1 } })
    assert.equal(drafted.ok, true, JSON.stringify(drafted.error ?? null))
    assert.equal(drafted.report.counts.warning, 1)
    assert.deepEqual(chapterFiles(fixture.root), [], 'gating a draft needs no chapter file')
    assert.equal(existsSync(join(fixture.root, '.inkflow', 'audit')), false, 'and writes no conclusion file')

    const recorded = runGate(fixture.root, {}, { draft: { body: WARNED_BODY, title: '第 1 章', seq: 1 } })
    assert.equal(recorded.ok, false)
    assert.equal(recorded.error.code, 'GATE_DRAFT_NOT_RECORDABLE')

    // The same body through a real chapter file still produces a warning — the seam did not
    // change the rules, only where the text comes from.
    mkdirSync(join(fixture.root, 'chapters', 'vol-01'), { recursive: true })
    const file = join(fixture.root, 'chapters', 'vol-01', '0001-第1章.md')
    writeFileSync(file, ['---', 'id: ch-1', 'title: 第 1 章', 'volume: vol-01', 'seq: 1', '---', '', WARNED_BODY, ''].join('\n'), 'utf8')
    const onDisk = runGate(fixture.root, { chapterId: 'ch-1' }, { record: false })
    assert.equal(onDisk.ok, true)
    assert.equal(onDisk.report.counts.warning, 1)
    assert.equal(chapterDigest(fixture.root, 'chapters/vol-01/0001-第1章.md'), sha256File(file))
  } finally {
    fixture.done()
  }
})

test('job 常量与状态词汇表是本模块的公开契约', () => {
  assert.deepEqual([...JOB_STATUSES], ['running', 'paused', 'done', 'failed'])
  assert.equal(JOB_FORMAT, 'inkflow.batch-job')
  assert.equal(isJobId('bj-1a2b3c4d'), true)
  assert.equal(isJobId('bj-1A2B3C4D'), false)
  assert.equal(isJobId('pr-1a2b3c4d'), false)
})
