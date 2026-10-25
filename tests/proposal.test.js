/**
 * Issue #45 — proposal-based revision: line diff, per-hunk verdicts, apply, rollback.
 *
 * Every test here fails when the implementation is wrong in a way that matters to the
 * author, which is why the assertions are about bytes and directories rather than about
 * return values alone:
 *
 *   1. **creating and deciding write no content file** — a proposal that quietly touched
 *      the chapter would already be the silent overwrite the feature exists to prevent;
 *   2. **only accepted hunks reach the file** — a rejected hunk's text must not appear in
 *      the chapter, not even once;
 *   3. **apply → rollback is byte-identical** — compared with `Buffer`, BOM and CRLF
 *      included, because "the same text" is not "the same file" (ADR-0016);
 *   4. **the baseline is the decision-time fingerprint** — an edit made after deciding is
 *      a `FILE_CHANGED` refusal that keeps the author's text (the ADR-0021 lesson);
 *   5. **the proposal lives under `.inkflow/`** and `index/` stays free of it — a rebuild
 *      must not be able to delete an undecided revision (ADR-0023).
 *
 * Runs against the built artifact (`lib/index.js`), like every other contract test: the
 * tests drive what a user installs.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  applyBlocked,
  applyHunks,
  applyProposal,
  applyViaChannel,
  buildProposals,
  countsOf,
  createProposal,
  decideProposal,
  decideViaChannel,
  describeHunk,
  describeOutcome,
  describeTotals,
  diffLines,
  joinLines,
  listProposals,
  pendingDecisions,
  preferredProposalId,
  proposalDirRelative,
  proposalTools,
  readProposal,
  readProposalPage,
  rollbackBlocked,
  rollbackProposal,
  rollbackViaChannel,
  splitLines,
} from '../lib/index.js'

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const INDEX_DIR = 'index'
const KEEP = '.gitkeep'
const CHAPTER = 'chapters/vol-01/0001-入山.md'
const FRONTMATTER = ['---', 'id: ch-0001', 'volume: vol-01', 'seq: 1', 'title: 第1章 入山', 'status: draft', '---', '', ''].join('\n')
const BASE_BODY = ['夜色压着山门。', '清音提着剑站在阶下。', '师父没有回头。', '风从松林里过来。', '她把剑收进鞘里。', ''].join('\n')
/** Two separated changes, so one case can accept one hunk and reject the other. */
const REVISED_BODY = [
  '夜色压着山门。',
  '清音提着剑站在阶下，衣角还沾着雨。',
  '师父没有回头。',
  '风从松林里过来，带着湿冷的松脂味。',
  '她把剑收进鞘里。',
  '',
].join('\n')

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-proposal-'))
}

/** A usable book: `.git`, ten directories with `.gitkeep`, meta and ignore rules. */
function project(root) {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of [...CONTENT_DIRS, INDEX_DIR]) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, KEEP), '', 'utf8')
  }
  writeFileSync(join(root, '.gitignore'), '# derived\nindex/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '提案之书' }, null, 2)}\n`, 'utf8')
  return root
}

/** Write the chapter raw, so CRLF and a BOM can be part of the fixture. */
function chapter(root, body, options = {}) {
  const text = `${FRONTMATTER}${body}`
  const styled = options.crlf === true ? text.replace(/\n/g, '\r\n') : text
  const bytes = options.bom === true ? `\uFEFF${styled}` : styled
  const absolute = join(root, ...CHAPTER.split('/'))
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, bytes, 'utf8')
  return absolute
}

/**
 * Every file inside the nine content directories, as bytes.
 *
 * The private state (`.inkflow/`), the derived index and the root bookkeeping files are
 * excluded on purpose: "zero content writes" is a statement about the book's data, and
 * `.gitignore` legitimately gains one `.inkflow/` line the first time the proposal
 * directory is used (ADR-0012 #2) — that gets its own assertion.
 */
function contentTree(root) {
  const out = new Map()
  const walk = (relative) => {
    for (const entry of readdirSync(join(root, ...relative.split('/')), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        walk(child)
        continue
      }
      if (entry.name === KEEP) continue
      out.set(child, readFileSync(join(root, ...child.split('/'))))
    }
  }
  for (const dir of CONTENT_DIRS) walk(dir)
  return out
}

function sameTree(left, right) {
  const changed = []
  for (const [path, bytes] of right) {
    const before = left.get(path)
    if (before === undefined) changed.push(`+${path}`)
    else if (!before.equals(bytes)) changed.push(`~${path}`)
  }
  for (const path of left.keys()) if (!right.has(path)) changed.push(`-${path}`)
  return changed
}

function indexEntries(root) {
  return readdirSync(join(root, INDEX_DIR))
    .filter((name) => name !== KEEP)
    .sort()
}

function openProposal(root, revisedBody = REVISED_BODY) {
  const created = createProposal(root, { chapterId: 'ch-0001', revisedBody })
  assert.equal(created.ok, true, created.ok ? '' : `${created.error.code}: ${created.error.message}`)
  return created.value
}

function decideAll(root, proposalId, status) {
  const read = readProposal(root, proposalId)
  assert.equal(read.ok, true)
  const decisions = read.value.hunks.map((hunk) => ({ index: hunk.index, status }))
  const decided = decideProposal(root, { proposalId, decisions })
  assert.equal(decided.ok, true, decided.ok ? '' : `${decided.error.code}: ${decided.error.message}`)
  return decided.value
}

// ---------------------------------------------------------------------------
// 1. A proposal is a work item: creating and deciding write no prose
// ---------------------------------------------------------------------------

test('提案：建立与决定都不写内容目录，提案只落在 .inkflow/proposals/', () => {
  const root = project(workdir())
  try {
    chapter(root, BASE_BODY)
    const before = contentTree(root)
    const proposal = openProposal(root)
    const decided = decideAll(root, proposal.proposalId, 'accepted')

    assert.deepEqual(sameTree(before, contentTree(root)), [], 'create/decide must not change one content byte')
    assert.equal(decided.contentFilesWritten, 0, 'deciding reports that it wrote no content file')

    // The proposal itself: one directory, one meta, one file per hunk.
    const dir = proposalDirRelative(proposal.proposalId)
    assert.equal(dir.startsWith('.inkflow/proposals/pr-'), true, `proposal dir is ${dir}`)
    assert.deepEqual(readdirSync(join(root, ...dir.split('/'))).sort(), ['hunks', 'meta.json'])
    const hunkFiles = readdirSync(join(root, ...`${dir}/hunks`.split('/'))).sort()
    assert.equal(hunkFiles.length, proposal.counts.total)
    assert.equal(proposal.hunks.length, proposal.counts.total)

    // `meta.json` records the base the hunks were cut from, and the decision baseline.
    const meta = JSON.parse(readFileSync(join(root, ...`${dir}/meta.json`.split('/')), 'utf8'))
    assert.equal(meta.status, 'open')
    assert.equal(meta.counts.accepted, meta.counts.total)
    assert.equal(meta.decision.counts.accepted, meta.counts.total)
    assert.equal(meta.decision.baseline.sha256, meta.base.sha256)
    assert.equal(meta.hunks.length, meta.counts.total)

    // `.gitignore` gained exactly the one private-state line (append-only, ADR-0012 #2).
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8').includes('\n.inkflow/\n'), true)
    // Nothing of this landed in the derived index: it is a cache, the proposal is not in it.
    assert.deepEqual(indexEntries(root), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('提案：修订正文与正文一致时拒绝建立，整份文档形状也拒绝', () => {
  const root = project(workdir())
  try {
    chapter(root, BASE_BODY)
    const identical = createProposal(root, { chapterId: 'ch-0001', revisedBody: BASE_BODY })
    assert.equal(identical.ok, false)
    assert.equal(identical.error.code, 'PROPOSAL_EMPTY')

    const whole = createProposal(root, { chapterId: 'ch-0001', revisedBody: `${FRONTMATTER}新的正文\n` })
    assert.equal(whole.ok, false)
    assert.equal(whole.error.code, 'PROPOSAL_BODY_REQUIRED', 'a document is not a body')

    // Zero writes: neither attempt created a proposal directory.
    assert.equal(listProposals(root).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. Apply writes the accepted hunks only
// ---------------------------------------------------------------------------

test('提案：应用只写已接受的段，被拒绝的段一个字节都不进文件', async () => {
  const root = project(workdir())
  try {
    const file = chapter(root, BASE_BODY)
    const proposal = openProposal(root)
    assert.equal(proposal.counts.total, 2, 'two separated paragraphs are two hunks')

    const decided = decideProposal(root, {
      proposalId: proposal.proposalId,
      decisions: [
        { index: 1, status: 'accepted' },
        { index: 2, status: 'rejected' },
      ],
    })
    assert.equal(decided.ok, true)
    assert.deepEqual(decided.value.counts, { total: 2, pending: 0, accepted: 1, rejected: 1 })

    const applied = await applyProposal(root, { proposalId: proposal.proposalId, confirm: true })
    assert.equal(applied.ok, true, applied.ok ? '' : `${applied.error.code}: ${applied.error.message}`)
    assert.deepEqual(applied.value.applied, [1])
    assert.deepEqual(applied.value.skipped, [2])

    const text = readFileSync(file, 'utf8')
    assert.equal(text.includes('衣角还沾着雨'), true, 'the accepted hunk landed')
    assert.equal(text.includes('湿冷的松脂味'), false, 'the rejected hunk did not land — not one byte of it')
    assert.equal(text.includes('风从松林里过来。'), true, 'the rejected hunk kept its original line')
    assert.equal(text.startsWith('---\nid: ch-0001\n'), true, 'frontmatter is never part of a revision')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('提案：有待定段、零接受、未决定都会被拒且零写入', async () => {
  const root = project(workdir())
  try {
    const file = chapter(root, BASE_BODY)
    const before = readFileSync(file)
    const proposal = openProposal(root)

    const undecided = await applyProposal(root, { proposalId: proposal.proposalId, confirm: true })
    assert.equal(undecided.ok, false)
    assert.equal(undecided.error.code, 'PROPOSAL_UNDECIDED')

    const partial = decideProposal(root, { proposalId: proposal.proposalId, decisions: [{ index: 1, status: 'accepted' }] })
    assert.equal(partial.ok, true)
    const pending = await applyProposal(root, { proposalId: proposal.proposalId, confirm: true })
    assert.equal(pending.ok, false)
    assert.equal(pending.error.code, 'PROPOSAL_PENDING_HUNKS')

    decideProposal(root, { proposalId: proposal.proposalId, decisions: [{ index: 2, status: 'rejected' }] })
    assert.equal(readFileSync(file).equals(before), true, 'all three refusals left the chapter byte-identical')

    const rejected = openProposal(root)
    decideAll(root, rejected.proposalId, 'rejected')
    const nothing = await applyProposal(root, { proposalId: rejected.proposalId, confirm: true })
    assert.equal(nothing.ok, false)
    assert.equal(nothing.error.code, 'PROPOSAL_NOTHING_ACCEPTED')

    const noConfirm = await applyProposal(root, { proposalId: rejected.proposalId })
    assert.equal(noConfirm.ok, false)
    assert.equal(noConfirm.error.code, 'CONFIRM_REQUIRED')
    assert.equal(readFileSync(file).equals(before), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. Apply then rollback is byte-identical (CRLF + BOM preserved)
// ---------------------------------------------------------------------------

test('提案：应用后回滚逐字节一致（CRLF 与 BOM 也一致）', async () => {
  const root = project(workdir())
  try {
    const file = chapter(root, BASE_BODY, { crlf: true, bom: true })
    const before = readFileSync(file)
    assert.equal(before.toString('utf8').startsWith('\uFEFF'), true)
    assert.equal(before.toString('utf8').includes('\r\n'), true)

    const proposal = openProposal(root)
    decideAll(root, proposal.proposalId, 'accepted')
    const applied = await applyProposal(root, { proposalId: proposal.proposalId, confirm: true })
    assert.equal(applied.ok, true, applied.ok ? '' : `${applied.error.code}: ${applied.error.message}`)

    const afterApply = readFileSync(file, 'utf8')
    assert.equal(afterApply.startsWith('\uFEFF'), true, 'the BOM survived the write (ADR-0016)')
    assert.equal(/[^\r]\n/.test(afterApply), false, 'every line is still CRLF')
    assert.equal(afterApply.includes('衣角还沾着雨'), true)

    const rolled = rollbackProposal(root, { proposalId: proposal.proposalId, confirm: true })
    assert.equal(rolled.ok, true, rolled.ok ? '' : `${rolled.error.code}: ${rolled.error.message}`)
    assert.equal(rolled.value.verified, true, 'the digest on disk equals the pre-apply digest')
    assert.deepEqual(readFileSync(file), before, 'byte-for-byte identical to before the apply')

    const again = rollbackProposal(root, { proposalId: proposal.proposalId, confirm: true })
    assert.equal(again.ok, false, 'one rollback per apply')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('提案：应用保留文件原有行尾，未涉及的段逐字节不变', async () => {
  const root = project(workdir())
  try {
    const file = chapter(root, BASE_BODY, { crlf: true })
    const beforeText = readFileSync(file, 'utf8')
    const proposal = openProposal(root)
    decideProposal(root, {
      proposalId: proposal.proposalId,
      decisions: [
        { index: 1, status: 'accepted' },
        { index: 2, status: 'rejected' },
      ],
    })
    const applied = await applyProposal(root, { proposalId: proposal.proposalId, confirm: true })
    assert.equal(applied.ok, true)

    const text = readFileSync(file, 'utf8')
    assert.equal(/[^\r]\n/.test(text), false, 'no bare LF was introduced')

    // Exactly one line moved, the accepted one; the rejected paragraph is byte-identical.
    const beforeLines = beforeText.split('\r\n')
    const afterLines = text.split('\r\n')
    assert.equal(afterLines.length, beforeLines.length, 'the line count did not move')
    const changed = afterLines.map((line, index) => (line === beforeLines[index] ? -1 : index)).filter((index) => index >= 0)
    assert.deepEqual(changed, [beforeLines.indexOf('清音提着剑站在阶下。')])
    assert.equal(afterLines[changed[0]], '清音提着剑站在阶下，衣角还沾着雨。')
    assert.equal(afterLines.includes('风从松林里过来。'), true, 'the rejected paragraph kept its original line')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. The baseline is taken at decision time
// ---------------------------------------------------------------------------

test('提案：决定之后手改正文 → 应用被拒（FILE_CHANGED）且人的改动保留', async () => {
  const root = project(workdir())
  try {
    const file = chapter(root, BASE_BODY)
    const proposal = openProposal(root)
    decideAll(root, proposal.proposalId, 'accepted')

    // The author opens their editor and writes a sentence of their own.
    writeFileSync(file, `${readFileSync(file, 'utf8')}她又想起师父说过的话。\n`, 'utf8')
    const handEdited = readFileSync(file)

    const applied = await applyProposal(root, { proposalId: proposal.proposalId, confirm: true })
    assert.equal(applied.ok, false)
    assert.equal(applied.error.code, 'FILE_CHANGED')
    assert.equal(applied.error.nothingWritten, true)
    assert.deepEqual(readFileSync(file), handEdited, "the author's own edit was kept")
    assert.equal(listProposals(root)[0].status, 'open', 'the proposal is still open: nothing was applied')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('提案：提案成立后正文变了 → 决定就被拒（FILE_CHANGED），一段裁决都不记', () => {
  const root = project(workdir())
  try {
    const file = chapter(root, BASE_BODY)
    const proposal = openProposal(root)
    writeFileSync(file, `${readFileSync(file, 'utf8')}新的一行。\n`, 'utf8')
    const decided = decideProposal(root, { proposalId: proposal.proposalId, decisions: [{ index: 1, status: 'accepted' }] })
    assert.equal(decided.ok, false)
    assert.equal(decided.error.code, 'FILE_CHANGED')
    const read = readProposal(root, proposal.proposalId)
    assert.equal(read.ok, true)
    assert.equal(read.value.meta.decision, null, 'no baseline was recorded against text the hunks do not address')
    assert.equal(read.value.hunks.every((hunk) => hunk.status === 'pending'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('提案：对同一提案重复应用是拒绝的，状态机不会被绕过', async () => {
  const root = project(workdir())
  try {
    chapter(root, BASE_BODY)
    const proposal = openProposal(root)
    decideAll(root, proposal.proposalId, 'accepted')
    const first = await applyProposal(root, { proposalId: proposal.proposalId, confirm: true })
    assert.equal(first.ok, true)
    const second = await applyProposal(root, { proposalId: proposal.proposalId, confirm: true })
    assert.equal(second.ok, false)
    assert.equal(second.error.code, 'PROPOSAL_STATUS')

    const decided = decideProposal(root, { proposalId: proposal.proposalId, decisions: [{ index: 1, status: 'rejected' }] })
    assert.equal(decided.ok, false)
    assert.equal(decided.error.code, 'PROPOSAL_STATUS')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. The diff itself: lines, not characters
// ---------------------------------------------------------------------------

test('提案：diff 按行切，插入/删除/改写各成一段，applyHunks 能原样重建两种结果', () => {
  const base = splitLines('a\nb\nc\n')
  assert.deepEqual(base, ['a', 'b', 'c', ''])

  const replaced = diffLines(base, splitLines('a\nB\nc\n'))
  assert.equal(replaced.length, 1)
  assert.equal(replaced[0].kind, 'replace')
  assert.equal(replaced[0].baseStart, 1)
  assert.deepEqual(replaced[0].baseLines, ['b'])
  assert.deepEqual(replaced[0].nextLines, ['B'])

  const inserted = diffLines(splitLines('a\nc\n'), splitLines('a\nb\nc\n'))
  assert.equal(inserted.length, 1)
  assert.equal(inserted[0].kind, 'insert')
  assert.deepEqual(inserted[0].baseLines, [])

  const deleted = diffLines(splitLines('a\nb\nc\n'), splitLines('a\nc\n'))
  assert.equal(deleted.length, 1)
  assert.equal(deleted[0].kind, 'delete')
  assert.deepEqual(deleted[0].nextLines, [])

  assert.deepEqual(diffLines(base, base), [], 'identical text has no hunks')

  // Round trip: accepting everything reproduces the revision, accepting nothing the base.
  const baseLines = splitLines(BASE_BODY)
  const next = splitLines(REVISED_BODY)
  const hunks = diffLines(baseLines, next)
  assert.equal(hunks.length, 2, 'two changed paragraphs, two hunks')
  assert.equal(joinLines(applyHunks(baseLines, hunks, () => true)), REVISED_BODY)
  assert.equal(joinLines(applyHunks(baseLines, hunks, () => false)), BASE_BODY)

  // Chinese prose is never cut inside a word: every line in a hunk is a whole line.
  for (const hunk of hunks) {
    for (const line of [...hunk.baseLines, ...hunk.nextLines]) {
      assert.equal(baseLines.includes(line) || next.includes(line), true, `whole line: ${line}`)
    }
  }
})

// ---------------------------------------------------------------------------
// 6. The panel channel: read-only read, confirm-gated writes
// ---------------------------------------------------------------------------

test('提案：面板路由的读是零写盘，写要 confirm，决定回报零内容写入', async () => {
  const root = project(workdir())
  try {
    chapter(root, BASE_BODY)
    const source = { sessionId: 'test-session', root }
    const empty = buildProposals(source, 'test')
    assert.equal(empty.status, 200)
    assert.equal(empty.body.value.proposals.length, 0)

    const proposal = openProposal(root)
    const before = contentTree(root)
    const list = buildProposals(source, 'test')
    assert.equal(list.status, 200)
    assert.equal(list.body.value.total, 1)
    assert.equal(list.body.value.proposals[0].proposalId, proposal.proposalId)
    assert.equal(list.body.value.counts.open, 1)

    const detail = buildProposals(source, 'test', { proposalId: proposal.proposalId })
    assert.equal(detail.status, 200)
    assert.equal(detail.body.value.detail.hunks.length, proposal.counts.total)
    assert.equal(Array.isArray(detail.body.value.detail.hunks[0].baseLines), true, 'the hunk carries its own text')
    assert.deepEqual(sameTree(before, contentTree(root)), [], 'reading the tab writes nothing')

    const badConfirm = await applyViaChannel(source, 'test', { proposalId: proposal.proposalId })
    assert.equal(badConfirm.status, 400)
    assert.equal(badConfirm.body.error.code, 'CONFIRM_REQUIRED')

    const decided = decideViaChannel(source, 'test', {
      proposalId: proposal.proposalId,
      decisions: [
        { index: 1, status: 'accepted' },
        { index: 2, status: 'accepted' },
      ],
    })
    assert.equal(decided.status, 200)
    assert.equal(decided.body.value.contentFilesWritten, 0)

    const applied = await applyViaChannel(source, 'test', { proposalId: proposal.proposalId, confirm: true })
    assert.equal(applied.status, 200)
    assert.equal(applied.body.value.applied.length, 2)
    assert.equal(String(applied.body.value.backup).startsWith('.inkflow/backup/'), true)

    const rolled = await rollbackViaChannel(source, 'test', { proposalId: proposal.proposalId, confirm: true })
    assert.equal(rolled.status, 200)
    assert.equal(rolled.body.value.verified, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('提案：读到不存在的提案是 404，id 形状不对是 400', () => {
  const root = project(workdir())
  try {
    const source = { sessionId: 'test-session', root }
    const missing = buildProposals(source, 'test', { proposalId: 'pr-00000000' })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.error.code, 'PROPOSAL_NOT_FOUND')

    const invalid = buildProposals(source, 'test', { proposalId: 'nope' })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.error.code, 'PROPOSAL_ID_INVALID')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('提案：工具面注册四个工具，apply/rollback 的 schema 要求 confirm', () => {
  const tools = proposalTools({ ctx: {}, dataDir: tmpdir(), version: 'test' })
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['inkflow_proposal_apply', 'inkflow_proposal_create', 'inkflow_proposal_decide', 'inkflow_proposal_rollback'],
  )
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  assert.deepEqual(byName.get('inkflow_proposal_apply').parameters.required, ['proposalId', 'confirm'])
  assert.deepEqual(byName.get('inkflow_proposal_rollback').parameters.required, ['proposalId', 'confirm'])
  assert.deepEqual(byName.get('inkflow_proposal_create').parameters.required, ['revisedBody'])
  assert.deepEqual(byName.get('inkflow_proposal_decide').parameters.required, ['proposalId', 'decisions'])
})

// ---------------------------------------------------------------------------
// 7. The panel's pure model: three states, and the two "why not" reasons
// ---------------------------------------------------------------------------

test('提案：面板模型的三态（失败 / 读不懂 / 可读，空列表不算错误）', () => {
  const failed = readProposalPage({ ok: false, status: 409, error: { code: 'NO_SESSION_CONTEXT', message: 'no session' } })
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.error.includes('NO_SESSION_CONTEXT'), true)

  const nullish = readProposalPage(null)
  assert.equal(nullish.phase, 'failed')

  const unreadable = readProposalPage({ ok: true, status: 200, value: {} })
  assert.equal(unreadable.phase, 'unreadable')
  assert.equal(unreadable.rows.length, 0)

  const noList = readProposalPage({ ok: true, status: 200, value: { total: 3 } })
  assert.equal(noList.phase, 'unreadable')

  const empty = readProposalPage({ ok: true, status: 200, value: { proposals: [], total: 0, counts: { open: 0 } } })
  assert.equal(empty.phase, 'ready')
  assert.equal(empty.rows.length, 0)
  assert.equal(preferredProposalId(empty), null)

  const ready = readProposalPage({
    ok: true,
    status: 200,
    value: {
      proposals: [
        {
          proposalId: 'pr-00000001',
          chapterId: 'ch-0001',
          path: CHAPTER,
          title: '第1章 入山',
          createdAt: '2026-10-25T00:00:00.000Z',
          status: 'applied',
          counts: { total: 2, pending: 0, accepted: 2, rejected: 0 },
          source: { kind: 'revised-body', label: 'session-model' },
        },
        {
          proposalId: 'pr-00000002',
          chapterId: 'ch-0001',
          path: CHAPTER,
          title: '第1章 入山',
          createdAt: '2026-10-25T01:00:00.000Z',
          status: 'open',
          counts: { total: 2, pending: 2, accepted: 0, rejected: 0 },
          source: { kind: 'revised-body', label: 'session-model' },
        },
      ],
      total: 2,
      counts: { open: 1, applied: 1, rolledBack: 0 },
      detail: {
        proposalId: 'pr-00000002',
        path: CHAPTER,
        title: '第1章 入山',
        status: 'open',
        counts: { total: 2, pending: 2, accepted: 0, rejected: 0 },
        base: { lines: 6, eol: 'crlf', bom: true },
        hunks: [
          { index: 1, kind: 'replace', status: 'pending', baseStart: 1, baseLines: ['旧'], nextLines: ['新'], removed: 1, added: 1 },
        ],
        decisionBaseline: null,
        apply: null,
        rollback: null,
      },
    },
  }, true)
  assert.equal(ready.phase, 'ready')
  assert.equal(ready.rows.length, 2)
  assert.equal(preferredProposalId(ready), 'pr-00000002', 'the newest OPEN proposal is selected first')
  assert.equal(ready.detail.hunks[0].lineFrom, 2, 'a hunk reports 1-based line numbers')
  assert.equal(ready.detail.bom, true)
  assert.equal(describeHunk(ready.detail.hunks[0]), '第 2 行起 · 改写 · +1 −1 · 待决定')
  assert.equal(describeTotals(ready).includes('2 个提案'), true)
})

test('提案：按钮口径 —— 待定/全拒/状态不对时应用被挡住', () => {
  assert.equal(applyBlocked({ total: 2, pending: 0, accepted: 2, rejected: 0 }, 'open'), null)
  assert.match(applyBlocked({ total: 2, pending: 1, accepted: 1, rejected: 0 }, 'open') ?? '', /没有决定/)
  assert.match(applyBlocked({ total: 2, pending: 0, accepted: 0, rejected: 2 }, 'open') ?? '', /都被拒绝/)
  assert.match(applyBlocked({ total: 2, pending: 0, accepted: 2, rejected: 0 }, 'applied') ?? '', /回滚/)

  assert.equal(rollbackBlocked('applied'), null)
  assert.match(rollbackBlocked('open') ?? '', /已应用/)
  assert.match(rollbackBlocked('rolled-back') ?? '', /回滚过/)

  assert.deepEqual(
    pendingDecisions(
      [
        { index: 1, kind: 'replace', status: 'pending', lineFrom: 1, baseLines: [], nextLines: [], removed: 0, added: 0 },
        { index: 2, kind: 'replace', status: 'accepted', lineFrom: 2, baseLines: [], nextLines: [], removed: 0, added: 0 },
      ],
      'accepted',
    ),
    [{ index: 1, status: 'accepted' }],
  )

  const changed = describeOutcome('apply', { ok: false, error: { code: 'FILE_CHANGED' } }, '')
  assert.equal(changed.includes('FILE_CHANGED'), true)
  assert.equal(changed.includes('你的改动被保留'), true)
  assert.equal(describeOutcome('decide', { ok: true }, '决定已记录').includes('决定已记录'), true)
})

test('提案：counts 由段状态算出，是唯一的汇总口径', () => {
  assert.deepEqual(
    countsOf([{ status: 'pending' }, { status: 'accepted' }, { status: 'rejected' }, { status: 'accepted' }]),
    { total: 4, pending: 1, accepted: 2, rejected: 1 },
  )
})
