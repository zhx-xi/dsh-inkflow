/**
 * Every tool reply must survive a JSON round trip unchanged.
 *
 * The bug this exists to prevent, in the words of the ticket: the relation tools reported
 * `since` / `until` / `chapter` — three keys that are optional in the file format — as
 * `undefined` VALUES. The host judges each reply as lossless JSON, so an undefined value voids
 * the whole reply: a write that succeeded read as a failure, and a list became unusable. The
 * fix at the time was a `lossless()` pass inside the relation reply factory. That is a RULE,
 * and rules are only followed by whoever remembers them — the next optional field anyone adds
 * brings the same symptom back, and the symptom ("the tool returned illegal JSON") never shows
 * up as a red test.
 *
 * So this file turns it into a MECHANISM: every registered tool is called twice — once with no
 * arguments (the refusal path) and once through the `CASES` table below (the success path, or a
 * deeper refusal) — and both answers must satisfy
 * `deepStrictEqual(JSON.parse(JSON.stringify(v)), v)`.
 *
 * WHY THE TABLE INSTEAD OF "just call everything": a tool that writes needs a shape only it
 * knows, and inventing one here would be a second spec. Tools without a row are still covered
 * by the no-argument pass; a row is what buys the success path. Adding a tool means adding a
 * row OR accepting that only its refusal is covered — and the count assertion at the bottom
 * makes that a decision rather than an oversight.
 *
 * Run: pnpm test (needs `pnpm run build` — this calls the built plugin).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

const DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']
const KEEP = '.gitkeep'

/** A usable book with two entities, so a relation can actually be written. */
function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 'inkflow-lossless-'))
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, KEEP), '')
  }
  writeFileSync(join(root, 'inkflow.json'), JSON.stringify({ schemaVersion: 1, title: '线材', author: '测试' }), 'utf8')
  writeFileSync(join(root, 'characters', '沈青.md'), ['---', 'name: 沈青', '---', '', '一个人。', ''].join('\n'), 'utf8')
  mkdirSync(join(root, 'world', '地点'), { recursive: true })
  writeFileSync(
    join(root, 'world', '地点', '长安.md'),
    ['---', 'title: 长安', 'category: 地点', '---', '', '一座城。', ''].join('\n'),
    'utf8',
  )
  return root
}

function harness(workspace) {
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
      if (name === 'workingDirectory') return { ensure: async () => workspace }
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
    webServer: { register() { return () => {} } },
  }
  return { ctx, tools }
}

const EXEC = { signal: AbortSignal.timeout(20000), agent: { id: 'test-session' } }

/**
 * The success path for the tools a minimal input can drive.
 *
 * Each row is `[tool, args, what the call is expected to do]`. The third column is not
 * decoration: a row whose call starts refusing would still pass the lossless assertion, so the
 * expectation is asserted too — otherwise this table would slowly turn into "70 refusals".
 */
const CASES = [
  ['inkflow_project_status', {}, 'ok'],
  ['inkflow_index_rebuild', {}, 'ok'],
  ['inkflow_chapter_list', {}, 'ok'],
  ['inkflow_world_tree', {}, 'ok'],
  ['inkflow_character_list', {}, 'ok'],
  ['inkflow_facts_list', {}, 'ok'],
  ['inkflow_foreshadow_list', {}, 'ok'],
  ['inkflow_timeline_list', {}, 'ok'],
  ['inkflow_calendar_get', {}, 'ok'],
  ['inkflow_outline_tree', {}, 'ok'],
  ['inkflow_relation_list', { entity: '沈青' }, 'ok'],
  ['inkflow_relation_clues', { entity: '沈青' }, 'ok'],
  ['inkflow_search', { query: '沈青' }, 'ok'],
  ['inkflow_project_plan', {}, 'ok'],
  ['inkflow_shared_list', {}, 'ok'],
  ['inkflow_extract_list', {}, 'ok'],
  ['inkflow_project_audit', {}, 'ok'],
  ['inkflow_batch_take', {}, 'refused'],
]

function undefinedPaths(value, prefix = '') {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => undefinedPaths(entry, `${prefix}[${String(index)}]`))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => {
      const path = prefix === '' ? key : `${prefix}.${key}`
      return entry === undefined ? [path] : undefinedPaths(entry, path)
    })
  }
  return []
}

function assertLossless(reply, where) {
  const undefineds = undefinedPaths(reply)
  assert.deepEqual(undefineds, [], `${where}: the reply carries undefined value(s) at ${undefineds.join(', ')}`)
  assert.deepEqual(JSON.parse(JSON.stringify(reply)), reply, `${where}: the reply does not survive a JSON round trip`)
}

test('every tool reply survives a JSON round trip — refusals first', async () => {
  const book = scaffold()
  const dataDir = mkdtempSync(join(tmpdir(), 'inkflow-lossless-data-'))
  const wired = harness(book)
  apply(wired.ctx, { dataDir })
  try {
    assert.ok(wired.tools.size >= 70, `expected the full tool surface, found ${String(wired.tools.size)}`)
    for (const tool of wired.tools.values()) {
      // NOT asserted to be a refusal: this harness points the session working directory at a
      // usable book, so "no arguments" is a legitimate call for the read tools. What the case is
      // about is the SHAPE of whatever comes back.
      const reply = await tool.execute({}, EXEC)
      assertLossless(reply, `${tool.name} (no arguments)`)
    }
  } finally {
    rmSync(book, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('every tool reply survives a JSON round trip — with a minimal valid input', async () => {
  const book = scaffold()
  const dataDir = mkdtempSync(join(tmpdir(), 'inkflow-lossless-data-'))
  const wired = harness(book)
  apply(wired.ctx, { dataDir })
  try {
    let okCount = 0
    for (const [name, args, expected] of CASES) {
      const tool = wired.tools.get(name)
      assert.ok(tool, `${name} is listed in CASES but is not registered any more`)
      const reply = await tool.execute(args, EXEC)
      assertLossless(reply, `${name} ${JSON.stringify(args)}`)
      if (expected === 'ok') {
        assert.equal(reply?.ok, true, `${name}: expected a successful reply, got ${String(reply?.error?.code)}`)
        okCount += 1
      } else {
        assert.equal(reply?.ok, false, `${name}: expected a refusal`)
      }
    }
    // A table that silently degraded into "everything refuses" would still pass every assertion
    // above; this is the line that notices.
    assert.ok(okCount >= 12, `only ${String(okCount)} calls actually succeeded — the table lost its success paths`)
  } finally {
    rmSync(book, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('a relation written without since/until/chapter still answers a legal JSON reply', async () => {
  const book = scaffold()
  const dataDir = mkdtempSync(join(tmpdir(), 'inkflow-lossless-data-'))
  const wired = harness(book)
  apply(wired.ctx, { dataDir })
  try {
    // This is the exact shape of the original defect: three optional frontmatter keys that the
    // file does not carry. Reporting them as `undefined` values voided a reply that had already
    // written the file.
    //
    // The two ends are addressed by the ids the projection reports (`characters/沈青.md`), not by
    // the display names — an edge names entities, and a name is not an address.
    const characters = await wired.tools.get('inkflow_character_list').execute({}, EXEC)
    assert.equal(characters?.ok, true, 'the character list answers')
    // The reply shape is the tool's own (`{ok: true, …}` here, a content-block array elsewhere),
    // so the id is read off the serialised reply rather than off a shape this test would have to
    // pin — pinning it would be a second spec.
    const characterText = JSON.stringify(characters)
    const sourceId = characterText.includes('characters/沈青.md') ? 'characters/沈青.md' : '沈青'
    const world = await wired.tools.get('inkflow_world_tree').execute({}, EXEC)
    const worldText = JSON.stringify(world)
    const targetId = worldText.includes('world/地点/长安.md') ? 'world/地点/长安.md' : '长安'

    const upsert = await wired.tools.get('inkflow_relation_upsert').execute(
      { source: sourceId, target: targetId, kind: 'knowledge', confirm: true },
      EXEC,
    )
    assertLossless(upsert, 'relation upsert without the optional window')
    assert.equal(upsert?.ok, true, `the edge should have been written: ${String(upsert?.error?.code)}`)

    const list = await wired.tools.get('inkflow_relation_list').execute({ entity: '沈青' }, EXEC)
    assertLossless(list, 'relation list after the write')
    assert.equal(list?.ok, true)
  } finally {
    rmSync(book, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }
})
