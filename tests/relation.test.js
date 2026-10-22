/**
 * Relation domain (#27) — data-model §3.3, §5 (I-08), roadmap X-3a.
 *
 * What these tests pin, in the order the issue's acceptance criteria list it:
 *   1. an edge is one file under `relations/`, and creating it makes both of its ends
 *      resolvable entities of the book (the projection wiring X-3a promised);
 *   2. each invariant actually blocks: `RELATION_ENDPOINT`, `RELATION_SELF_LOOP`,
 *      `RELATION_DUPLICATE` — on the write path *and* on a rebuild, because a code
 *      that only one of the two nets reports is half a net (X-4);
 *   3. deleting the file removes the edge and its entity again;
 *   4. one entity's edges come back in a single call, in both roles;
 *   5. a character file that still carries an old relation field is warned about on a
 *      rebuild and never blocks an edit (the #34/#36 migration, not this issue);
 *   6. the index schema version moved, because `relations` is a new table (no ALTER).
 *
 * Runs against the BUILT artifact, like every other contract test.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  INDEX_SCHEMA_VERSION,
  apply,
  buildIndex,
  entityCounts,
  listEntities,
  listRelationsFor,
  planRelationUpsert,
  searchEntities,
} from '../lib/index.js'

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-relation-'))
}

function scaffold(root) {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of [...CONTENT_DIRS, 'index']) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '关系测试' }, null, 2)}\n`, 'utf8')
}

function markdown(root, relativePath, lines, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = lines.length > 0 ? `---\n${lines.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

/** Two characters, one world entry and one chapter: enough kinds to cross a relation. */
function sampleBook(root) {
  scaffold(root)
  markdown(root, 'characters/清音.md', ['id: c-1', 'name: 清音', 'role: 主角'], '主角。')
  markdown(root, 'characters/白鹤掌门.md', ['id: c-2', 'name: 白鹤掌门'], '掌门。')
  markdown(root, 'characters/为真子.md', ['id: c-3', 'name: 为真子'], '老掌门。')
  markdown(root, 'world/门派/白鹤门.md', ['id: w-1', 'title: 白鹤门', 'category: 门派'], '门派。')
  markdown(root, 'chapters/vol-01/0001-开篇.md', ['id: ch-1', 'title: 开篇', 'seq: 1'], '正文。')
}

function createHarness(workspace) {
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
      if (name === 'workingDirectory' && typeof workspace === 'string') return { ensure: async () => workspace }
      return undefined
    },
    logger() {
      return { debug() {}, info() {}, warn() {}, error() {} }
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
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

function makeTools(root) {
  const dataDir = mkdtempSync(join(tmpdir(), 'inkflow-relation-state-'))
  const harness = createHarness(root)
  apply(harness.ctx, { dataDir })
  return harness
}

async function callTool(harness, toolName, args) {
  const tool = harness.tools.get(toolName)
  assert.ok(tool, `tool ${toolName} must be registered`)
  return tool.execute(args, { signal: AbortSignal.timeout(30000), agent: { id: 'test-session' } })
}

function withBook(body) {
  return async () => {
    const dir = workdir()
    try {
      const root = join(dir, 'book')
      sampleBook(root)
      await body(root, dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('the index schema version moved past 2 for the relations table', () => {
  // New table, no ALTER (ADR-0005): the version is the whole migration. Asserted as a
  // floor, not as `=== 3`, because the next data domain (#28 timeline, #31, #32) bumps
  // it again and this line must not become the rebase conflict of the batch.
  assert.ok(INDEX_SCHEMA_VERSION > 2, `expected a bump past v2, got v${String(INDEX_SCHEMA_VERSION)}`)
})

test(
  'an edge is one file, and both of its ends resolve to entities of the book',
  withBook(async (root) => {
    const harness = makeTools(root)
    const created = await callTool(harness, 'inkflow_relation_upsert', {
      projectRoot: root,
      source: 'c-1',
      target: 'c-2',
      kind: 'character',
      since: 'ch-1',
      confirm: true,
    })

    assert.equal(created.ok, true, JSON.stringify(created.error))
    assert.equal(created.created, true)
    assert.equal(created.relation.path, 'relations/c-1--c-2.md')
    assert.equal(created.relation.dir, 'directed')
    assert.equal(readFileSync(join(root, created.relation.path), 'utf8').startsWith('---\n'), true)

    // The projection: one row per edge, titled `source → target`, hung under its source.
    const entities = listEntities(root, { kind: 'relations' })
    assert.equal(entities?.length, 1)
    assert.equal(entities[0].id, 'relations/c-1--c-2.md')
    assert.equal(entities[0].title, 'c-1 → c-2')
    assert.equal(entities[0].parent, 'c-1')
    // No invariant fires: the endpoints resolved on the write path, so the rebuild has
    // nothing to report about this edge.
    const rebuild = await buildIndex(root)
    assert.deepEqual(rebuild.issues.filter((issue) => issue.code.startsWith('RELATION_')), [])
    assert.deepEqual(entityCounts(root), { chapters: 1, characters: 3, relations: 1, world: 1 })

    // An edge may join different kinds (I-08 is cross-class, exactly like DANGLING_PARENT).
    const crossKind = await callTool(harness, 'inkflow_relation_upsert', {
      projectRoot: root,
      source: 'c-1',
      target: 'w-1',
      kind: 'knowledge',
      confirm: true,
    })
    assert.equal(crossKind.ok, true, JSON.stringify(crossKind.error))
    await buildIndex(root)
    assert.deepEqual(entityCounts(root)?.relations, 2)
  }),
)

test(
  'deleting the file deletes the edge and its entity (files are the truth)',
  withBook(async (root) => {
    const harness = makeTools(root)
    const created = await callTool(harness, 'inkflow_relation_upsert', {
      projectRoot: root,
      source: 'c-1',
      target: 'c-2',
      confirm: true,
    })
    assert.equal(created.ok, true, JSON.stringify(created.error))

    unlinkSync(join(root, created.relation.path))
    const rebuild = await buildIndex(root)
    assert.deepEqual(rebuild.issues.filter((issue) => issue.code.startsWith('RELATION_')), [])
    assert.deepEqual(listEntities(root, { kind: 'relations' }), [])
    // A stale index would still answer; ensureIndex is the only rebuild decision, so
    // this asserts the read side through the same door the tool uses.
    assert.deepEqual(listRelationsFor(root, 'c-1'), [])
  }),
)

test(
  'a missing endpoint is RELATION_ENDPOINT on the write path and on a rebuild',
  withBook(async (root) => {
    const harness = makeTools(root)
    const refused = await callTool(harness, 'inkflow_relation_upsert', {
      projectRoot: root,
      source: 'c-1',
      target: 'ghost',
      confirm: true,
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'RELATION_ENDPOINT')
    // Zero writes on refusal: nothing landed in the directory.
    await buildIndex(root)
    assert.deepEqual(listEntities(root, { kind: 'relations' }), [])

    // The same edge written by hand (an editor, git, another tool) must be caught by
    // the rebuild — the write path is not the only net.
    markdown(root, 'relations/手写悬空边.md', ['id: rl-hand', 'source: c-1', 'target: ghost', 'kind: character'], '手写。')
    const rebuild = await buildIndex(root)
    const issues = rebuild.issues.filter((issue) => issue.code === 'RELATION_ENDPOINT')
    assert.equal(issues.length, 1)
    assert.equal(issues[0].path, 'relations/手写悬空边.md')
    assert.match(issues[0].detail, /ghost/u)
  }),
)

test(
  'one end declared twice is ambiguous, not merely missing, and is still RELATION_ENDPOINT',
  withBook(async (root) => {
    // Two kinds sharing an id is legal in the projection (X-1), so an edge pointing at
    // that id cannot pick a side: "exactly one entity" is the invariant, not "at least one".
    markdown(root, 'characters/双子.md', ['id: twin', 'name: 双子'], '角色。')
    markdown(root, 'world/门派/双子门.md', ['id: twin', 'title: 双子门', 'category: 门派'], '门派。')

    const harness = makeTools(root)
    const refused = await callTool(harness, 'inkflow_relation_upsert', {
      projectRoot: root,
      source: 'c-1',
      target: 'twin',
      confirm: true,
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'RELATION_ENDPOINT')
    assert.match(refused.error.message, /ambiguous/u)

    // The rebuild says the same thing about a hand-written edge, in the same code.
    markdown(root, 'relations/双关边.md', ['id: rl-twin', 'source: c-1', 'target: twin', 'kind: character'], '手写。')
    const rebuild = await buildIndex(root)
    const issues = rebuild.issues.filter((issue) => issue.code === 'RELATION_ENDPOINT')
    assert.equal(issues.length, 1)
    assert.equal(issues[0].path, 'relations/双关边.md')
    assert.match(issues[0].detail, /ambiguous/u)
  }),
)

test(
  'an edge from an entity to itself is RELATION_SELF_LOOP, directed or not',
  withBook(async (root) => {
    const harness = makeTools(root)
    const directed = await callTool(harness, 'inkflow_relation_upsert', {
      projectRoot: root,
      source: 'c-1',
      target: 'c-1',
      confirm: true,
    })
    assert.equal(directed.error?.code, 'RELATION_SELF_LOOP')

    // `dir: undirected` does not make a self-loop meaningful: an undirected edge is
    // still a pair of two entities.
    const undirected = await callTool(harness, 'inkflow_relation_upsert', {
      projectRoot: root,
      source: 'c-1',
      target: 'c-1',
      dir: 'undirected',
      confirm: true,
    })
    assert.equal(undirected.error?.code, 'RELATION_SELF_LOOP')

    // Rebuild side: the hand-written file is reported, not silently accepted.
    markdown(root, 'relations/自环.md', ['id: rl-self', 'source: c-2', 'target: c-2', 'kind: character', 'dir: undirected'], '自环。')
    const rebuild = await buildIndex(root)
    const issues = rebuild.issues.filter((issue) => issue.code === 'RELATION_SELF_LOOP')
    assert.equal(issues.length, 1)
    assert.equal(issues[0].path, 'relations/自环.md')
  }),
)

test(
  'the same (source, target, kind) edge twice is RELATION_DUPLICATE',
  withBook(async (root) => {
    const harness = makeTools(root)
    const first = await callTool(harness, 'inkflow_relation_upsert', {
      projectRoot: root,
      source: 'c-1',
      target: 'c-2',
      confirm: true,
    })
    assert.equal(first.ok, true, JSON.stringify(first.error))

    // Re-running the same call is an *update* of the same file, not a second edge.
    const again = await callTool(harness, 'inkflow_relation_upsert', {
      projectRoot: root,
      source: 'c-1',
      target: 'c-2',
      since: 'ch-1',
      confirm: true,
    })
    assert.equal(again.ok, true, JSON.stringify(again.error))
    assert.equal(again.created, false)
    assert.equal(again.relation.path, first.relation.path)

    // A different file declaring the same edge is a duplicate.
    const secondPath = await callTool(harness, 'inkflow_relation_upsert', {
      projectRoot: root,
      source: 'c-1',
      target: 'c-2',
      path: 'relations/另一条同边.md',
      confirm: true,
    })
    assert.equal(secondPath.error?.code, 'RELATION_DUPLICATE')
    assert.match(secondPath.error.message, /c-1--c-2/u)

    // The rebuild reports it too, so a hand-written duplicate cannot hide.
    markdown(root, 'relations/手写同边.md', ['id: rl-dup', 'source: c-1', 'target: c-2', 'kind: character'], '重复。')
    const rebuild = await buildIndex(root)
    const issues = rebuild.issues.filter((issue) => issue.code === 'RELATION_DUPLICATE')
    assert.equal(issues.length, 1)
    assert.equal(issues[0].path, 'relations/手写同边.md')
    assert.match(issues[0].detail, /c-1--c-2/u)

    // A different kind is a different edge: a person relation and a knowledge relation
    // may join the same two ends.
    const otherKind = await callTool(harness, 'inkflow_relation_upsert', {
      projectRoot: root,
      source: 'c-1',
      target: 'c-2',
      kind: 'knowledge',
      confirm: true,
    })
    assert.equal(otherKind.ok, true, JSON.stringify(otherKind.error))
  }),
)

test(
  'inkflow_relation_list returns every edge of one entity, as source and as target',
  withBook(async (root) => {
    const harness = makeTools(root)
    const edges = [
      { source: 'c-1', target: 'c-2' },
      { source: 'c-3', target: 'c-1' },
      { source: 'c-1', target: 'w-1', kind: 'knowledge' },
    ]
    for (const edge of edges) {
      const created = await callTool(harness, 'inkflow_relation_upsert', { projectRoot: root, ...edge, confirm: true })
      assert.equal(created.ok, true, JSON.stringify(created.error))
    }

    const listed = await callTool(harness, 'inkflow_relation_list', { projectRoot: root, entity: 'c-1' })
    assert.equal(listed.ok, true, JSON.stringify(listed.error))
    assert.equal(listed.count, 3)
    const roles = listed.edges.map((edge) => (edge.source === 'c-1' ? `out:${edge.target}` : `in:${edge.source}`))
    assert.deepEqual(roles.sort(), ['in:c-3', 'out:c-2', 'out:w-1'])

    // The other end sees only the edge it is part of.
    const other = await callTool(harness, 'inkflow_relation_list', { projectRoot: root, entity: 'c-2' })
    assert.deepEqual(other.edges.map((edge) => edge.path), ['relations/c-1--c-2.md'])

    // An entity with no edges is an empty list, not an error.
    const none = await callTool(harness, 'inkflow_relation_list', { projectRoot: root, entity: 'w-1-absent' })
    assert.equal(none.ok, true)
    assert.deepEqual(none.edges, [])
  }),
)

test(
  'a relation is searchable by title: the projection is wired, not just the table',
  withBook(async (root) => {
    const harness = makeTools(root)
    const created = await callTool(harness, 'inkflow_relation_upsert', {
      projectRoot: root,
      source: 'c-1',
      target: 'c-2',
      title: '师徒',
      confirm: true,
    })
    assert.equal(created.ok, true, JSON.stringify(created.error))

    const byTitle = searchEntities(root, '师徒')
    assert.deepEqual(byTitle?.map((entity) => `${entity.kind}:${entity.id}`), ['relations:relations/c-1--c-2.md'])

    // A book without an explicit title relies on the derived `source → target` name
    // (three characters → the trigram FTS, not the LIKE fallback).
    const derived = await callTool(harness, 'inkflow_relation_upsert', {
      projectRoot: root,
      source: 'c-2',
      target: 'c-3',
      confirm: true,
    })
    assert.equal(derived.ok, true, JSON.stringify(derived.error))
    assert.equal(derived.relation.title, 'c-2 → c-3')
    assert.deepEqual(searchEntities(root, 'c-2')?.map((entity) => `${entity.kind}:${entity.id}`), ['relations:relations/c-2--c-3.md'])
  }),
)

test(
  'a legacy relation field in a character file only warns, and never blocks a write',
  withBook(async (root) => {
    // #34/#36 migrate existing books; #27 only stops reading the field. So the file is
    // reported once per rebuild, and an edit to *another* file still goes through.
    markdown(root, 'characters/旧卡.md', ['id: c-4', 'name: 旧卡', 'relations: [c-1]'], '旧格式。')

    const rebuild = await buildIndex(root)
    const warnings = rebuild.issues.filter((issue) => issue.code === 'RELATION_FIELD_DEPRECATED')
    assert.equal(warnings.length, 1)
    assert.equal(warnings[0].path, 'characters/旧卡.md')
    assert.match(warnings[0].detail, /"relations"/u)

    const harness = makeTools(root)
    const written = await callTool(harness, 'inkflow_relation_upsert', {
      projectRoot: root,
      source: 'c-1',
      target: 'c-2',
      confirm: true,
    })
    assert.equal(written.ok, true, JSON.stringify(written.error))
    // The character file was not rewritten, and its field was not "fixed" silently.
    assert.match(readFileSync(join(root, 'characters/旧卡.md'), 'utf8'), /relations: \[c-1\]/u)
  }),
)

test(
  'a write without confirm: true is refused and writes nothing',
  withBook(async (root) => {
    const harness = makeTools(root)
    const refused = await callTool(harness, 'inkflow_relation_upsert', {
      projectRoot: root,
      source: 'c-1',
      target: 'c-2',
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'CONFIRM_REQUIRED')
    const rebuild = await buildIndex(root)
    assert.deepEqual(rebuild.issues.filter((issue) => issue.code.startsWith('RELATION_')), [])
    assert.deepEqual(listEntities(root, { kind: 'relations' }), [])
  }),
)

test(
  'an update patches the file in place: unknown fields survive, cleared ones are removed',
  withBook(async (root) => {
    markdown(
      root,
      'relations/手写边.md',
      ['id: rl-1', 'source: c-1', 'target: c-2', 'kind: character', 'until: ch-9', 'note: 作者备注'],
      '手写正文。',
    )
    const harness = makeTools(root)
    const updated = await callTool(harness, 'inkflow_relation_upsert', {
      projectRoot: root,
      id: 'rl-1',
      source: 'c-1',
      target: 'c-2',
      dir: 'undirected',
      since: 'ch-1',
      confirm: true,
    })
    assert.equal(updated.ok, true, JSON.stringify(updated.error))
    assert.equal(updated.created, false)
    assert.equal(updated.relation.path, 'relations/手写边.md', 'the id decides the file, not the derived slug')

    const text = readFileSync(join(root, 'relations/手写边.md'), 'utf8')
    assert.match(text, /dir: undirected/u)
    assert.match(text, /since: ch-1/u)
    assert.match(text, /note: 作者备注/u, 'a field this plugin does not know must survive')
    assert.match(text, /手写正文。/u, 'the body is never rewritten')
    assert.doesNotMatch(text, /until:/u, 'an omitted optional field is cleared rather than left stale')

    // A file that is only prose (no frontmatter yet) keeps its prose: the block is
    // added on top instead of replacing the document.
    writeFileSync(join(root, 'relations/纯正文.md'), '作者写的一段说明。\n', 'utf8')
    const adopted = await callTool(harness, 'inkflow_relation_upsert', {
      projectRoot: root,
      source: 'c-2',
      target: 'c-3',
      path: 'relations/纯正文.md',
      confirm: true,
    })
    assert.equal(adopted.ok, true, JSON.stringify(adopted.error))
    const adoptedText = readFileSync(join(root, 'relations/纯正文.md'), 'utf8')
    assert.match(adoptedText, /^---\n/u)
    assert.match(adoptedText, /作者写的一段说明。/u)
  }),
)

test(
  'the write-side planner is the same decision the tool makes',
  withBook(async (root) => {
    await buildIndex(root)
    const entities = listEntities(root)
    assert.ok(entities)
    const view = {
      rows: [],
      entities: entities.map((entity) => ({
        kind: entity.kind,
        id: entity.id,
        path: entity.path,
        title: entity.title,
      })),
    }

    const ok = planRelationUpsert(view, { source: 'c-1', target: 'c-2' })
    assert.equal(ok.ok, true)
    assert.equal(ok.row.path, 'relations/c-1--c-2.md')
    assert.equal(ok.row.relationKind, 'character')
    assert.equal(ok.row.direction, 'directed')

    // Field-level refusals carry their own codes and never fall through to a write.
    assert.equal(planRelationUpsert(view, { source: 'c-1', target: 'c-2', relationKind: 'romance' }).error.code, 'RELATION_FIELD_INVALID')
    assert.equal(planRelationUpsert(view, { source: 'c-1', target: 'c-2', direction: 'bidirectional' }).error.code, 'RELATION_FIELD_INVALID')
    assert.equal(planRelationUpsert(view, { source: 'c-1', target: 'c-2', path: 'characters/逃逸.md' }).error.code, 'RELATION_PATH_INVALID')
    assert.equal(planRelationUpsert(view, { source: '', target: 'c-2' }).error.code, 'RELATION_ENDPOINT')
  }),
)
