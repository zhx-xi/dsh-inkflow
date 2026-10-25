/**
 * Relation time-window conflicts (`since` / `until` that cannot both hold).
 *
 * left this out on purpose (data-model §3.3 said so): the two fields hold free
 * labels (a chapter id *or* a world-internal time), so "these two intervals cannot both
 * hold" needs the chapter-order resolution the fact ledger already uses (I-23). The claim
 * this suite pins is that the resolution is **reused**, not re-invented: the same
 * `(volume order, volume-local seq)` reading order, the same `[since, until)` interval,
 * and the same "a boundary that cannot be placed is not judged" rule.
 *
 * Four groups:
 *
 *   1. **one edge that cannot hold** — `since` at or after `until`, judged by chapter
 *      order (never by id text: `ch-10` sorts before `ch-9` as a string) and judged
 *      across volumes (`vol-02/seq=1` comes after `vol-01/seq=1`, so that window is not
 *      empty even though the two `seq` values are equal).
 *   2. **two edges for one fact** — one `(unordered pair, kind)` bucket is one relation,
 *      so two windows that are neither identical nor a clean split at a point cannot
 *      both describe it. Abutting windows (`[a,b)` + `[b,c)`) are the one lawful split
 *      and must stay silent, or every ledger that names a boundary on both sides turns
 *      red.
 *   3. **the lax path** — a free label (`0030 年`) is never guessed at: it is reported as
 *      `RELATION_PERIOD_UNCOMPARABLE` (info), never as a conflict, and it never blocks a
 *      write. A window that cannot be judged must say so, not pick a side.
 *   4. **both nets, same verdict** (X-4) — a rebuild and a write return the same code for
 *      the same data, and the read surface marks which edge conflicts with which.
 *
 * Runs against the BUILT artifact (lib/index.js), like every other suite.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  auditProject,
  buildIndex,
  chapterPositionsFromProjection,
  domainTools,
  relationPeriodFindings,
} from '../lib/index.js'

const CONTENT_DIRS = [
  'chapters',
  'characters',
  'world',
  'outlines',
  'foreshadowing',
  'timeline',
  'relations',
  'facts',
  'library',
]

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-period-'))
}

function scaffold(root) {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of [...CONTENT_DIRS, 'index']) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '时段测试' }, null, 2)}\n`, 'utf8')
}

function markdown(root, relativePath, lines, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = lines.length > 0 ? `---\n${lines.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

function callTool(name, args) {
  const tool = domainTools().find((candidate) => candidate.name === name)
  assert.ok(tool, `${name} must be registered by a domain module`)
  return tool.execute(args, { signal: new AbortController().signal, callId: 'period-test' })
}

/**
 * Two characters, one place, and four chapters in two volumes.
 *
 * The chapters are what makes the order interesting: `ch-9` / `ch-10` live in `vol-02`
 * with volume-local `seq` 1 and 2, so a rule that compared `seq` alone would call
 * `[ch-1, ch-9)` (both `seq: 1`) empty, and a rule that compared ids as text would call
 * `[ch-2, ch-10)` reversed.
 */
function sampleBook(root) {
  scaffold(root)
  markdown(root, 'characters/qingyin.md', ['id: char-qingyin', 'name: 清音'], '她是谁')
  markdown(root, 'characters/baihe.md', ['id: char-baihe', 'name: 白鹤'], '他是谁')
  markdown(root, 'world/门派/白鹤门.md', ['id: world-baihe', 'title: 白鹤门', 'category: 门派'], '一个门派')
  markdown(root, 'chapters/vol-01-首卷/0001-a.md', ['id: ch-1', 'seq: 1', 'volume: vol-01', 'title: 一'], '正文一')
  markdown(root, 'chapters/vol-01-首卷/0002-b.md', ['id: ch-2', 'seq: 2', 'volume: vol-01', 'title: 二'], '正文二')
  markdown(root, 'chapters/vol-01-首卷/0005-e.md', ['id: ch-5', 'seq: 5', 'volume: vol-01', 'title: 五'], '正文五')
  markdown(root, 'chapters/vol-02-次卷/0001-c.md', ['id: ch-9', 'seq: 1', 'volume: vol-02', 'title: 九'], '正文九')
  markdown(root, 'chapters/vol-02-次卷/0002-d.md', ['id: ch-10', 'seq: 2', 'volume: vol-02', 'title: 十'], '正文十')
}

function relationsEdge(path, fields) {
  const lines = [`id: ${fields.id ?? path}`]
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'id' || value === undefined) continue
    lines.push(`${key}: ${value}`)
  }
  return [path, lines]
}

const periodConflicts = (issues) => issues.filter((issue) => issue.code === 'RELATION_PERIOD_CONFLICT')
const uncomparable = (issues) => issues.filter((issue) => issue.code === 'RELATION_PERIOD_UNCOMPARABLE')

// ---------------------------------------------------------------------------
// 1. One edge whose own window cannot hold
// ---------------------------------------------------------------------------

test('period: an edge whose since is later than its until is a conflict (chapter order, not text order)', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    // `[ch-10, ch-2)` is reversed by chapter order. As text, `ch-10` < `ch-2`, which is
    // why a string comparison would call this window fine — the assertion is on the code,
    // so only a real reading order passes.
    markdown(root, ...relationsEdge('relations/backwards.md', {
      source: 'char-qingyin',
      target: 'char-baihe',
      kind: 'character',
      since: 'ch-10',
      until: 'ch-2',
    }))
    const build = await buildIndex(root)
    const found = periodConflicts(build.issues)
    assert.equal(found.length, 1, `expected one period conflict, got ${JSON.stringify(build.issues)}`)
    assert.equal(found[0].path, 'relations/backwards.md')
    assert.match(found[0].detail, /since/u)
    assert.match(found[0].detail, /until/u)
    // Nothing else is accused: this edge has a valid pair of ends and no other edge.
    assert.equal(build.issues.filter((issue) => issue.code === 'RELATION_DUPLICATE').length, 0)
    assert.equal(build.issues.filter((issue) => issue.code === 'RELATION_CONFLICT').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('period: since == until is an empty window and reported, not ignored', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    markdown(root, ...relationsEdge('relations/empty.md', {
      source: 'char-qingyin',
      target: 'char-baihe',
      kind: 'character',
      since: 'ch-2',
      until: 'ch-2',
    }))
    const build = await buildIndex(root)
    assert.equal(periodConflicts(build.issues).length, 1, 'an empty window never holds, so it is a defect in the file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('period: cross-volume order decides, and a plain forward window stays silent', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    // `ch-1` and `ch-9` are both `seq: 1`, one volume apart. Only (volume order, seq)
    // makes this a real, non-empty window, so a volume-local rule reports a false conflict.
    markdown(root, ...relationsEdge('relations/cross-volume.md', {
      source: 'char-qingyin',
      target: 'char-baihe',
      kind: 'character',
      since: 'ch-1',
      until: 'ch-9',
    }))
    // Same volume, forward: `[ch-2, ch-10)` must not be read as reversed by text order.
    markdown(root, ...relationsEdge('relations/forward.md', {
      source: 'char-qingyin',
      target: 'world-baihe',
      kind: 'knowledge',
      since: 'ch-2',
      until: 'ch-10',
    }))
    const build = await buildIndex(root)
    assert.deepEqual(
      periodConflicts(build.issues).map((issue) => issue.path),
      [],
      `forward windows must not be accused: ${JSON.stringify(build.issues)}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. Two edges for one fact
// ---------------------------------------------------------------------------

test('period: two windows for one pair that cannot both hold are a conflict naming both files', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    // Both `undirected`, so the direction rule has nothing to say: the *only*
    // disagreement between these two files is when the relation starts.
    markdown(root, ...relationsEdge('relations/a-b.md', {
      source: 'char-qingyin',
      target: 'char-baihe',
      kind: 'kinship',
      dir: 'undirected',
      since: 'ch-1',
      until: 'ch-9',
    }))
    markdown(root, ...relationsEdge('relations/b-a.md', {
      source: 'char-baihe',
      target: 'char-qingyin',
      kind: 'kinship',
      dir: 'undirected',
      since: 'ch-5',
      until: 'ch-10',
    }))
    const build = await buildIndex(root)
    const found = periodConflicts(build.issues)
    assert.equal(found.length, 1, `expected one conflict, got ${JSON.stringify(build.issues)}`)
    // Filed against the second file by path, so the report is deterministic.
    assert.equal(found[0].path, 'relations/b-a.md')
    // A validation issue carries `{ code, path, detail }` only (the index stores those three),
    // so "which other edge" has to be in the detail — that is what the report and the panel row
    // show, and it is what makes the pair visible without a second view.
    assert.match(found[0].detail, /relations\/a-b\.md/u)
    assert.match(found[0].detail, /relations\/b-a\.md/u)
    assert.equal(build.issues.filter((issue) => issue.code === 'RELATION_CONFLICT').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('period: two windows that leave a gap are a conflict too', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    markdown(root, ...relationsEdge('relations/early.md', {
      source: 'char-qingyin',
      target: 'char-baihe',
      kind: 'faction',
      dir: 'undirected',
      since: 'ch-1',
      until: 'ch-2',
    }))
    markdown(root, ...relationsEdge('relations/late.md', {
      source: 'char-baihe',
      target: 'char-qingyin',
      kind: 'faction',
      dir: 'undirected',
      since: 'ch-9',
    }))
    const build = await buildIndex(root)
    assert.equal(periodConflicts(build.issues).length, 1, 'one relation cannot stop and restart in two files')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('period: abutting windows, identical windows and a different kind stay silent', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    // 1. `[ch-1, ch-2)` + `[ch-2, ch-9)`: one continuous span split at a point. The union
    //    is still one interval, so this is a lawful split rather than a disagreement.
    markdown(root, ...relationsEdge('relations/split-1.md', {
      source: 'char-qingyin',
      target: 'char-baihe',
      kind: 'character',
      dir: 'undirected',
      since: 'ch-1',
      until: 'ch-2',
    }))
    markdown(root, ...relationsEdge('relations/split-2.md', {
      source: 'char-baihe',
      target: 'char-qingyin',
      kind: 'character',
      dir: 'undirected',
      since: 'ch-2',
      until: 'ch-9',
    }))
    // 2. The same window twice: no disagreement about the span at all (that is the
    //    duplicate rule's business, not this one).
    markdown(root, ...relationsEdge('relations/twin-1.md', {
      source: 'char-qingyin',
      target: 'world-baihe',
      kind: 'faction',
      dir: 'undirected',
      since: 'ch-2',
      until: 'ch-9',
    }))
    markdown(root, ...relationsEdge('relations/twin-2.md', {
      source: 'world-baihe',
      target: 'char-qingyin',
      kind: 'faction',
      dir: 'undirected',
      since: 'ch-2',
      until: 'ch-9',
    }))
    // 3. Same two people, different types, same span: 同门 + 同乡 is what a real book says.
    markdown(root, ...relationsEdge('relations/same-clan.md', {
      source: 'char-baihe',
      target: 'char-qingyin',
      kind: 'kinship',
      dir: 'undirected',
      since: 'ch-1',
      until: 'ch-9',
    }))
    const build = await buildIndex(root)
    assert.deepEqual(
      periodConflicts(build.issues).map((issue) => issue.path),
      [],
      `this book has no window disagreement: ${JSON.stringify(build.issues)}`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. The lax path: a free label is "cannot judge", never a guess
// ---------------------------------------------------------------------------

test('period: a free label is uncomparable (info), never a conflict', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    markdown(root, ...relationsEdge('relations/world-time.md', {
      source: 'char-qingyin',
      target: 'char-baihe',
      kind: 'character',
      since: '永平三年秋',
      until: '永平五年',
    }))
    const build = await buildIndex(root)
    assert.equal(periodConflicts(build.issues).length, 0, 'a label the book cannot place is not evidence of a conflict')
    const info = uncomparable(build.issues)
    assert.equal(info.length, 1, `expected one "cannot judge" note, got ${JSON.stringify(build.issues)}`)
    assert.equal(info[0].path, 'relations/world-time.md')
    assert.match(info[0].detail, /永平三年秋/u, 'the note quotes the label it could not place')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('period: one placeable boundary and one free label is still uncomparable, and the pair is not judged', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    // Chapter id vs free label on the same window: the order of two chapters says nothing
    // about where "永平三年" sits, so the window stays unjudged.
    markdown(root, ...relationsEdge('relations/mixed.md', {
      source: 'char-qingyin',
      target: 'char-baihe',
      kind: 'character',
      since: 'ch-9',
      until: '永平三年',
    }))
    // A second edge of the same pair whose window would overlap if the label were placed:
    // the pair must not be accused either.
    markdown(root, ...relationsEdge('relations/mixed-partner.md', {
      source: 'char-baihe',
      target: 'char-qingyin',
      kind: 'character',
      dir: 'undirected',
      since: 'ch-1',
      until: 'ch-10',
    }))
    const build = await buildIndex(root)
    assert.equal(periodConflicts(build.issues).length, 0, 'an unplaceable boundary must not accuse the pair either')
    assert.ok(uncomparable(build.issues).length >= 1)
    assert.ok(
      uncomparable(build.issues).some((issue) => issue.detail.includes('relations/mixed-partner.md')),
      'the note names both edges when a pair cannot be judged',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('period: a chapter id the book does not have is uncomparable, not a conflict', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    markdown(root, ...relationsEdge('relations/typo.md', {
      source: 'char-qingyin',
      target: 'char-baihe',
      kind: 'character',
      since: 'ch-99',
      until: 'ch-2',
    }))
    const build = await buildIndex(root)
    assert.equal(periodConflicts(build.issues).length, 0, 'a typo in a boundary is not a contradiction')
    assert.equal(uncomparable(build.issues).length, 1)
    assert.match(uncomparable(build.issues)[0].detail, /ch-99/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. Both nets, and the read surface
// ---------------------------------------------------------------------------

test('period: the write path refuses the same window a rebuild would report', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)

    // (a) The candidate's own window cannot hold.
    const backwards = await callTool('inkflow_relation_upsert', {
      projectRoot: root,
      source: 'char-qingyin',
      target: 'char-baihe',
      kind: 'character',
      since: 'ch-10',
      until: 'ch-2',
      confirm: true,
    })
    assert.equal(backwards.ok, false, 'a window that never holds must not be written')
    assert.equal(backwards.error.code, 'RELATION_PERIOD_CONFLICT')

    // (b) The candidate disagrees with an existing edge about when the relation starts.
    markdown(root, ...relationsEdge('relations/a-b.md', {
      source: 'char-qingyin',
      target: 'char-baihe',
      kind: 'kinship',
      dir: 'undirected',
      since: 'ch-1',
      until: 'ch-9',
    }))
    const refused = await callTool('inkflow_relation_upsert', {
      projectRoot: root,
      source: 'char-baihe',
      target: 'char-qingyin',
      kind: 'kinship',
      dir: 'undirected',
      since: 'ch-5',
      until: 'ch-10',
      confirm: true,
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'RELATION_PERIOD_CONFLICT', 'the write net must report the same code as the rebuild')
    assert.match(String(refused.error.message), /relations\/a-b\.md/u)

    // Nothing landed, and writing the same data by hand makes the rebuild say the same thing.
    const clean = await buildIndex(root)
    assert.equal(periodConflicts(clean.issues).length, 0, 'a refused write writes nothing')
    markdown(root, ...relationsEdge('relations/b-a.md', {
      source: 'char-baihe',
      target: 'char-qingyin',
      kind: 'kinship',
      dir: 'undirected',
      since: 'ch-5',
      until: 'ch-10',
    }))
    const reported = await buildIndex(root)
    assert.equal(periodConflicts(reported.issues).length, 1, 'the same data is a conflict on the rebuild side too')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('period: a free label never blocks a write, and an unrelated conflict does not wedge one', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    // A pre-existing, unrelated period conflict: a hand-written broken pair elsewhere.
    markdown(root, ...relationsEdge('relations/old-1.md', {
      source: 'char-qingyin',
      target: 'world-baihe',
      kind: 'knowledge',
      dir: 'undirected',
      since: 'ch-9',
      until: 'ch-1',
    }))
    const written = await callTool('inkflow_relation_upsert', {
      projectRoot: root,
      source: 'char-qingyin',
      target: 'char-baihe',
      kind: 'character',
      since: '永平三年',
      until: '永平五年',
      confirm: true,
    })
    assert.equal(written.ok, true, `free labels are the lax path: ${JSON.stringify(written.error ?? {})}`)
    assert.equal(written.relation.since, '永平三年')

    // The unrelated conflict is still reported by the rebuild — it is a real problem, just
    // not this write's problem (a blocked edit would wedge the book on a line the author
    // was not touching).
    const build = await buildIndex(root)
    assert.deepEqual(periodConflicts(build.issues).map((issue) => issue.path), ['relations/old-1.md'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('period: the read surface marks which edge conflicts with which', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    markdown(root, ...relationsEdge('relations/a-b.md', {
      source: 'char-qingyin',
      target: 'char-baihe',
      kind: 'kinship',
      dir: 'undirected',
      since: 'ch-1',
      until: 'ch-9',
    }))
    markdown(root, ...relationsEdge('relations/b-a.md', {
      source: 'char-baihe',
      target: 'char-qingyin',
      kind: 'kinship',
      dir: 'undirected',
      since: 'ch-5',
      until: 'ch-10',
    }))
    await buildIndex(root)

    const listed = await callTool('inkflow_relation_list', { projectRoot: root, entity: 'char-qingyin' })
    assert.equal(listed.ok, true)
    const marked = listed.edges.find((edge) => edge.path === 'relations/b-a.md')
    assert.ok(marked, 'the edge is listed')
    assert.ok(marked.period, 'the read surface must say the edge has a period problem')
    assert.equal(marked.period.conflict.otherPath, 'relations/a-b.md', 'and which edge it disagrees with')
    const quiet = listed.edges.find((edge) => edge.path === 'relations/a-b.md')
    assert.ok(quiet.period, 'both halves of the pair are marked: the author needs to see the pair, not one side')

    const clues = await callTool('inkflow_relation_clues', { projectRoot: root, entity: 'char-qingyin' })
    assert.equal(clues.ok, true)
    const peers = clues.groups.flatMap((group) => group.peers)
    assert.ok(peers.some((peer) => peer.period !== undefined), 'the clue view carries the same marker')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The judgement itself: no model, no clock, and cheap enough to run on a whole book
// ---------------------------------------------------------------------------

test('period: the audit report carries the conflict as a warning and the note as info', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    markdown(root, ...relationsEdge('relations/a-b.md', {
      source: 'char-qingyin',
      target: 'char-baihe',
      kind: 'kinship',
      dir: 'undirected',
      since: 'ch-1',
      until: 'ch-9',
    }))
    markdown(root, ...relationsEdge('relations/b-a.md', {
      source: 'char-baihe',
      target: 'char-qingyin',
      kind: 'kinship',
      dir: 'undirected',
      since: 'ch-5',
      until: 'ch-10',
    }))
    // A different pair, with a free label: the side that must not cry wolf, and must still
    // show up in the report as a note rather than disappear.
    markdown(root, ...relationsEdge('relations/locals.md', {
      source: 'char-baihe',
      target: 'world-baihe',
      kind: 'faction',
      since: '永平三年',
      until: 'ch-9',
    }))

    const report = auditProject(root)
    const conflicts = report.findings.filter((finding) => finding.code === 'RELATION_PERIOD_CONFLICT')
    assert.equal(conflicts.length, 1, `体检 must list the window conflict, got ${JSON.stringify(report.findings)}`)
    assert.equal(conflicts[0].severity, 'warning')
    assert.equal(conflicts[0].detail.includes('relations/a-b.md'), true, 'the row names the other edge')
    assert.equal(conflicts[0].hint === '' || conflicts[0].hint === undefined, false, 'the row carries a real hint')

    const notes = report.findings.filter((finding) => finding.code === 'RELATION_PERIOD_UNCOMPARABLE')
    assert.equal(notes.length, 1)
    assert.equal(notes[0].severity, 'info', 'an unplaceable boundary is information, not an accusation')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('period: 1000 edges are judged in well under 100 ms (zero LLM, pure arithmetic)', () => {
  // The projection shape the judgement actually receives (X-1): id, path and the chapter's
  // volume-local `seq`. 50 chapters across one volume is enough to make every window resolvable.
  const chapters = chapterPositionsFromProjection(
    Array.from({ length: 50 }, (_, index) => ({
      kind: 'chapters',
      id: `ch-${String(index + 1)}`,
      path: `chapters/vol-01-c/${String(index + 1).padStart(4, '0')}-x.md`,
      title: `第 ${String(index + 1)} 章`,
      orderIndex: index + 1,
    })),
  )
  assert.equal(chapters.size, 100, 'every chapter is filed under its id and its path')

  const rows = Array.from({ length: 1000 }, (_, index) => ({
    id: `relations/edge-${String(index)}.md`,
    path: `relations/edge-${String(index)}.md`,
    title: `e${String(index)}`,
    relationKind: 'character',
    source: `char-a-${String(index)}`,
    target: `char-b-${String(index)}`,
    direction: 'undirected',
    since: `ch-${String((index % 40) + 1)}`,
    until: `ch-${String((index % 40) + 10)}`,
    chapter: undefined,
  }))
  const started = performance.now()
  const verdict = relationPeriodFindings(rows, chapters)
  const elapsed = performance.now() - started
  assert.equal(verdict.conflicts.length, 0, 'each of these edges is alone in its bucket')
  assert.ok(elapsed < 100, `1000 edges took ${elapsed.toFixed(1)} ms, budget is 100 ms`)
})
