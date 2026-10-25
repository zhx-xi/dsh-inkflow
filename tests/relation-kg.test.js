/**
 * The knowledge graph: five relation types, the contradictory-edge rule and
 * the clue view.
 *
 * Three claims are pinned here, and each one is worth its own group because each can fail
 * silently:
 *
 *   1. **the type vocabulary is five wide** — `character` / `knowledge` / `kinship` /
 *      `faction` / `geography` are what `data-model` §3.3 now says, they survive a rebuild
 *      (the domain degrades an unknown value to `character` *and* reports it), and the
 *      write path refuses an unknown one instead of degrading.
 *   2. **a contradictory pair is caught by both nets** — `A→B` plus `B→A` (both directed)
 *      and `directed` plus `undirected` are `RELATION_CONFLICT`; two edges in the *same*
 *      direction stay `RELATION_DUPLICATE`, because that is a different mistake. A code
 *      only one net reports is half a net (X-4).
 *   3. **the clue view groups by type and resolves names** — a flat edge list does not
 *      answer "who is this person connected to"; the grouped view does, and it says which
 *      way each edge reads from *this* entity's side.
 *
 * Runs against the BUILT artifact (lib/index.js), like every other suite.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RELATION_KINDS, buildIndex, domainTools, listEntities } from '../lib/index.js'

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-kg-'))
}

function scaffold(root) {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of [...CONTENT_DIRS, 'index']) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '图谱测试' }, null, 2)}\n`, 'utf8')
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
  return tool.execute(args, { signal: new AbortController().signal, callId: 'kg-test' })
}

/** Two characters and one place: enough to build person, kinship, faction and geography edges. */
function sampleBook(root) {
  scaffold(root)
  markdown(root, 'characters/qingyin.md', ['id: char-qingyin', 'name: 清音'], '她是谁')
  markdown(root, 'characters/baihe.md', ['id: char-baihe', 'name: 白鹤'], '他是谁')
  markdown(root, 'world/门派/白鹤门.md', ['id: world-baihe', 'title: 白鹤门', 'category: 门派'], '一个门派')
}

test('kg: the relation type vocabulary is five kinds, and every one of them round-trips', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    assert.deepEqual([...RELATION_KINDS], ['character', 'knowledge', 'kinship', 'faction', 'geography'])

    const kinds = [
      ['character', 'char-qingyin', 'char-baihe'],
      ['knowledge', 'char-qingyin', 'world-baihe'],
      ['kinship', 'char-baihe', 'char-qingyin'],
      ['faction', 'char-baihe', 'world-baihe'],
      ['geography', 'world-baihe', 'world-baihe'],
    ]
    // `geography` is a self-loop on purpose: it must be refused by the self-loop rule, not
    // by the kind rule — that is what proves the new kinds go through the same checks.
    for (const [kind, source, target] of kinds) {
      const result = await callTool('inkflow_relation_upsert', {
        projectRoot: root,
        source,
        target,
        kind,
        dir: kind === 'geography' ? 'directed' : 'undirected',
        confirm: true,
      })
      if (kind === 'geography') {
        assert.equal(result.ok, false)
        assert.equal(result.error.code, 'RELATION_SELF_LOOP')
        continue
      }
      assert.equal(result.ok, true, `${kind}: ${JSON.stringify(result.error ?? {})}`)
      assert.equal(result.relation.kind, kind)
    }

    await buildIndex(root)
    const relations = listEntities(root, { kind: 'relations' })
    // `category` carries the kind, which is what a panel groups by (X-1 fixed the columns).
    assert.deepEqual(
      [...new Set(relations.map((entity) => entity.category))].sort(),
      ['character', 'faction', 'kinship', 'knowledge'],
    )

    // An unknown kind is refused by the write path…
    const refused = await callTool('inkflow_relation_upsert', {
      projectRoot: root,
      source: 'char-qingyin',
      target: 'char-baihe',
      kind: 'romance',
      dir: 'undirected',
      confirm: true,
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'RELATION_FIELD_INVALID')

    // …and, when it comes from a hand-written file, it degrades to `character` and is
    // *reported* — a rebuild never loses an edge, and never silently re-types one.
    markdown(root, 'relations/hand-made.md', ['id: rel-hand', 'source: char-qingyin', 'target: world-baihe', 'kind: romance'])
    const build = await buildIndex(root)
    const issue = build.issues.find((candidate) => candidate.path === 'relations/hand-made.md')
    assert.ok(issue, 'an unknown kind must be reported by the rebuild')
    assert.equal(issue.code, 'FRONTMATTER_ISSUE')
    assert.match(issue.detail, /romance/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('kg: contradictory directions are RELATION_CONFLICT on both the rebuild and the write path', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    // One edge written by hand, then its mirror image: both `directed`, opposite ways.
    markdown(root, 'relations/a-to-b.md', [
      'id: rel-ab',
      'source: char-qingyin',
      'target: char-baihe',
      'kind: character',
      'dir: directed',
    ])
    markdown(root, 'relations/b-to-a.md', [
      'id: rel-ba',
      'source: char-baihe',
      'target: char-qingyin',
      'kind: character',
      'dir: directed',
    ])
    const build = await buildIndex(root)
    const conflicts = build.issues.filter((issue) => issue.code === 'RELATION_CONFLICT')
    assert.equal(conflicts.length, 1, `expected exactly one contradiction, got ${JSON.stringify(build.issues)}`)
    assert.equal(conflicts[0].path, 'relations/b-to-a.md', 'filed against the second file by path, so the report is deterministic')
    assert.match(conflicts[0].detail, /both directions/u)

    // The same pair is NOT a duplicate: a duplicate is the same orientation twice.
    assert.equal(build.issues.filter((issue) => issue.code === 'RELATION_DUPLICATE').length, 0)

    // A `dir` mismatch is the other shape: same pair, one directed and one undirected.
    rmSync(join(root, 'relations/b-to-a.md'))
    markdown(root, 'relations/both-ways.md', [
      'id: rel-ab2',
      'source: char-baihe',
      'target: char-qingyin',
      'kind: character',
      'dir: undirected',
    ])
    const second = await buildIndex(root)
    const dirConflicts = second.issues.filter((issue) => issue.code === 'RELATION_CONFLICT')
    assert.equal(dirConflicts.length, 1)
    assert.match(dirConflicts[0].detail, /cannot read both ways and one way/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('kg: a write that would create a contradiction is refused and writes nothing', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    const first = await callTool('inkflow_relation_upsert', {
      projectRoot: root,
      source: 'char-qingyin',
      target: 'char-baihe',
      kind: 'character',
      dir: 'directed',
      confirm: true,
    })
    assert.equal(first.ok, true)

    // The mirror edge: a different (source, target) pair, so `RELATION_DUPLICATE` does not
    // fire — the contradiction rule is the only net that can catch it.
    const refused = await callTool('inkflow_relation_upsert', {
      projectRoot: root,
      source: 'char-baihe',
      target: 'char-qingyin',
      kind: 'character',
      dir: 'directed',
      confirm: true,
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'RELATION_CONFLICT')
    // Nothing landed: the refused path does not exist.
    const build = await buildIndex(root)
    assert.equal(build.issues.filter((issue) => issue.code === 'RELATION_CONFLICT').length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('kg: the clue view groups one entity\'s edges by kind and resolves the peer names', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    for (const [source, target, kind, direction] of [
      ['char-qingyin', 'char-baihe', 'kinship', 'undirected'],
      ['char-qingyin', 'world-baihe', 'faction', 'directed'],
      ['char-baihe', 'char-qingyin', 'knowledge', 'directed'],
    ]) {
      const written = await callTool('inkflow_relation_upsert', {
        projectRoot: root,
        source,
        target,
        kind,
        dir: direction,
        confirm: true,
      })
      assert.equal(written.ok, true, JSON.stringify(written.error ?? {}))
    }

    const clues = await callTool('inkflow_relation_clues', { projectRoot: root, entity: 'char-qingyin' })
    assert.equal(clues.ok, true, JSON.stringify(clues.error ?? {}))
    assert.equal(clues.total, 3, 'both roles count: one edge leaves 清音, one arrives, one is symmetric')
    assert.equal(clues.entityTitle, '清音')
    // Groups come back in the vocabulary's own order, with empty kinds dropped.
    assert.deepEqual(
      clues.groups.map((group) => group.kind),
      ['knowledge', 'kinship', 'faction'],
    )
    const byKind = new Map(clues.groups.map((group) => [group.kind, group.peers]))
    assert.deepEqual(byKind.get('kinship'), [
      { id: 'char-baihe', title: '白鹤', direction: 'both', path: 'relations/char-qingyin--char-baihe.md' },
    ])
    assert.equal(byKind.get('knowledge')?.[0]?.direction, 'incoming', '白鹤 → 清音 reads as incoming from 清音')
    assert.equal(byKind.get('faction')?.[0]?.title, '白鹤门')

    // A kind filter narrows the same view instead of building a second one.
    const onlyFaction = await callTool('inkflow_relation_clues', { projectRoot: root, entity: 'char-qingyin', kind: 'faction' })
    assert.equal(onlyFaction.ok, true)
    assert.deepEqual(onlyFaction.groups.map((group) => group.kind), ['faction'])
    assert.equal(onlyFaction.total, 1)

    // An entity nothing touches answers with an empty view, not an error.
    markdown(root, 'characters/lone.md', ['id: char-lone', 'name: 独行'], '没人认识他')
    await buildIndex(root)
    const lonely = await callTool('inkflow_relation_clues', { projectRoot: root, entity: 'char-lone' })
    assert.equal(lonely.ok, true)
    assert.equal(lonely.groups.length, 0)
    assert.equal(lonely.total, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('kg: an isolated edge (endpoint missing) is still RELATION_ENDPOINT, with the new kinds too', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    markdown(root, 'relations/orphan.md', [
      'id: rel-orphan',
      'source: char-qingyin',
      'target: char-ghost',
      'kind: kinship',
    ])
    const build = await buildIndex(root)
    const issue = build.issues.find((candidate) => candidate.code === 'RELATION_ENDPOINT')
    assert.ok(issue, 'an endpoint that resolves to nothing is reported by the rebuild')
    assert.equal(issue.path, 'relations/orphan.md')
    assert.match(issue.detail, /char-ghost/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
