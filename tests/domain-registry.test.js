/**
 * Domain-module seam (#101) — roadmap §2.1 X-5.
 *
 * Two things are asserted here and nothing else:
 *   1. Refactoring `buildTools()` into "built-ins + registered modules" changed
 *      nothing the model sees: the 12 built-in tools and their input schemas are
 *      byte-identical to the pre-refactor surface (recorded below).
 *   2. The seam works: `domainTools()` is a pure aggregate, so a registered
 *      module's tools appear without touching `tools.ts`, and an empty registry
 *      adds nothing.
 *
 * Runs against the BUILT artifact, like every other contract test — the tests
 * drive what users install.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CONTENT_DIRS, DOMAIN_MODULES, apply, applyCandidate, buildTools, domainTools } from '../lib/index.js'

/**
 * The built-in tool surface before the seam existed. Order is the declaration
 * order in `tools.ts`, and the hash covers `description` + `parameters` + `output`
 * over key-sorted JSON — renaming a tool or editing one schema property changes a
 * hash, which is exactly the regression this guards. Recorded from the pre-seam
 * build; an empty registry must reproduce it exactly.
 *
 * Appended since: `inkflow_project_audit` (#33), the maintenance pair (#36) and
 * `inkflow_library_import` (#37) — each a new built-in, not a change to an existing one,
 * which is why the twelve recorded hashes above still hold.
 */
const BUILT_IN_TOOLS = [
  ['inkflow_project_status', 'cc6903de'],
  ['inkflow_index_rebuild', '51a5555a'],
  ['inkflow_chapter_list', '4a6eecc1'],
  ['inkflow_chapter_search', 'd10a9b63'],
  // #39: the one search entry (X-16) and the search-replace batch (X-17). Built-ins
  // because they span every kind and own no content directory.
  ['inkflow_search', '46e8ca64'],
  ['inkflow_search_replace', '1c309b8e'],
  ['inkflow_project_audit', '2e5349da'],
  // #37: importing an old manuscript. A built-in rather than a domain tool: it writes
  // chapters *and* a `library/` copy, so no single content directory owns it.
  ['inkflow_library_import', '39f228ea'],
  ['inkflow_project_plan', '52c0ddec'],
  ['inkflow_project_init', '4226bc54'],
  ['inkflow_volume_create', 'a805a3ed'],
  ['inkflow_volume_rename', 'dd03c04a'],
  ['inkflow_chapter_create', '0df12472'],
  ['inkflow_chapter_write', '4e531ce4'],
  ['inkflow_chapter_move', '8fb67189'],
  ['inkflow_chapter_delete', 'a2b2198a'],
  // #36: the maintenance pair (repair + 6→9 migration). Built-ins, not domain tools:
  // they judge the book's *layout*, not one content directory.
  ['inkflow_project_repair', 'e9825bce'],
  ['inkflow_project_migrate', '2a0f5b4b'],
  // #40: the shared library (list / copy / update). Built-ins, not domain tools:
  // `dataDir/shared` belongs to no book, so no content directory owns them.
  ['inkflow_shared_list', 'e4280396'],
  ['inkflow_shared_copy', 'f2d81abe'],
  ['inkflow_shared_update', '17ae972a'],
  // #42: the plugin's own state — settings, the diagnostics package and the local
  // backups. Built-ins for the same reason as the pair above: none of them belongs to
  // one content directory, and two of them touch no book at all.
  ['inkflow_settings_get', 'd41c07e7'],
  // #41 changed this schema on purpose: `semanticEndpoint` / `semanticApiKey` are the two
  // settings the semantic backend reads (ADR-0020 E1), so the model-facing surface gained
  // two properties. The recorded hash follows the added fields.
  ['inkflow_settings_update', '09f805e8'],
  ['inkflow_diagnostics_export', '81804879'],
  ['inkflow_backup_create', '375f1aa7'],
  ['inkflow_backup_restore', '830aaf3b'],
  // #38: the extraction queue (ADR-0017). Built-ins, not domain tools: a candidate is not
  // an entity, belongs to no content directory, and its one write path lives in
  // `extract-accept.ts` instead of inside a domain module.
  ['inkflow_extract_propose', '9a66e773'],
  ['inkflow_extract_list', 'af0ff41f'],
  ['inkflow_extract_accept', '0bdd27f8'],
  ['inkflow_extract_reject', '483c26c2'],
  ['inkflow_extract_purge', '4d5d5d6e'],
  // #41: semantic retrieval — status (read-only), rebuild (writes blocks into OVK) and
  // purge (the one tool allowed to delete there, ADR-0009 P6).
  ['inkflow_semantic_status', '019ec003'],
  ['inkflow_semantic_rebuild', 'b5d3bb95'],
  ['inkflow_semantic_purge', 'e65e1a31'],
]

/** The seam passes the session context through; a tool factory may read it at call time. */
const TEST_DEPS = { ctx: {}, dataDir: tmpdir(), version: 'test' }

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function surfaceHash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 8)
}

/**
 * Why a mismatch also prints three part hashes (#114): "two 8-char hex strings
 * differ" says nothing about *what* moved. The baseline stores one merged hash, so
 * this can only report the CURRENT per-part hashes — compare them with the recorded
 * commit (`scripts/surface-hash.mjs --tool <name>` against `git show <rev>`) to see
 * which of description/parameters/output moved. The message says exactly that
 * instead of pretending to know.
 */
function surfaceReport(tool) {
  const parts = {
    description: surfaceHash(tool.description),
    parameters: surfaceHash(tool.parameters),
    output: surfaceHash(tool.output),
  }
  const detail = `description=${parts.description} parameters=${parts.parameters} output=${parts.output}`
  return { hash: surfaceHash({ description: tool.description, parameters: tool.parameters, output: tool.output }), detail }
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
      if (name === 'workingDirectory' && typeof workspace === 'string') {
        return { ensure: async () => workspace }
      }
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

function registeredTools() {
  const workspace = mkdtempSync(join(tmpdir(), 'inkflow-domains-'))
  try {
    const harness = createHarness(workspace)
    apply(harness.ctx, { dataDir: workspace })
    return harness.tools
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
}

test('the built-in tool surface survives the domain seam unchanged', () => {
  const tools = registeredTools()
  const expectedNames = BUILT_IN_TOOLS.map(([name]) => name)

  // Registered = built-ins + whatever modules are registered, and the registry is
  // part of what this test pins: an unexpected module here means someone wired a
  // domain without extending this baseline.
  assert.deepEqual([...tools.keys()], [...expectedNames, ...domainTools().map((tool) => tool.name)])

  for (const [name, hash] of BUILT_IN_TOOLS) {
    const tool = tools.get(name)
    assert.ok(tool, `${name} must still be registered`)
    const report = surfaceReport(tool)
    assert.equal(
      report.hash,
      hash,
      `${name} changed its model-facing surface (now ${report.hash}, recorded ${hash}).\n` +
        `  Current parts: ${report.detail} — diff one of them against the recorded commit.\n` +
        `  If the change is intended: node scripts/surface-hash.mjs prints the paste-ready rows.\n` +
        `  To see what moved: node scripts/surface-hash.mjs --tool ${name} (full schema JSON), then diff against git history.`,
    )
    assert.ok(tool.output?.schema, `${name} keeps its output schema`)
  }
})

test('scripts/surface-hash.mjs stays in sync with the recorded baseline', () => {
  // The helper is what the failure message tells people to run, so a drifted helper
  // would send them to a wrong number. It derives from the same build, so this is a
  // contract on the script's own output shape, not a second copy of the baseline.
  // `fileURLToPath`, not `pathname`: a checkout under a directory with a space or a
  // Chinese name would come back percent-encoded and the child process would ENOENT.
  const script = fileURLToPath(new URL('../scripts/surface-hash.mjs', import.meta.url))
  const output = execFileSync(process.execPath, [script, '--json'], { encoding: 'utf8' })
  const rows = JSON.parse(output)
  const builtIn = rows.filter((entry) => !entry.domain)
  // The count matters: a script that mislabelled every tool as `domain` would print
  // nothing comparable, and the loop below would pass without checking a thing.
  assert.equal(builtIn.length, BUILT_IN_TOOLS.length, 'surface-hash.mjs must report every built-in tool')
  const recorded = new Map(BUILT_IN_TOOLS)
  for (const row of builtIn) {
    assert.equal(row.hash, recorded.get(row.name), `surface-hash.mjs disagrees about ${row.name}`)
  }
})

function stubModule(name) {
  return {
    kind: 'characters',
    scan: () => ({ tables: [], entities: [], issues: [] }),
    parseFile: ({ path }) => ({ path, rows: [], issues: [] }),
    validate: () => [],
    schema: () => ({ ddl: [], insert() {} }),
    tools: () => [{ name, description: 'stub', parameters: { type: 'object', properties: {} } }],
  }
}

test('an empty registry contributes no tools', () => {
  assert.deepEqual(domainTools(TEST_DEPS, []), [])
})

test('a registered module contributes its own tools, in registry order', () => {
  const tools = domainTools(TEST_DEPS, [stubModule('inkflow_stub_first'), stubModule('inkflow_stub_second')])
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['inkflow_stub_first', 'inkflow_stub_second'],
  )
})

test('buildTools() actually consults the registry', () => {
  // The empty-registry tests above cannot catch a `buildTools()` that forgot to
  // call `domainTools()`: with no modules, both surfaces are identical. This one
  // passes a throwaway module list and fails the moment the aggregate stops being
  // wired in. Injection instead of pushing onto `DOMAIN_MODULES` keeps the
  // production registry untouched (X-5 says it is only ever appended to).
  const tools = buildTools(
    { ctx: {}, dataDir: tmpdir(), version: 'test' },
    [stubModule('inkflow_stub_wired')],
  )
  assert.ok(
    tools.some((tool) => tool.name === 'inkflow_stub_wired'),
    'a registered module must reach the tool table',
  )
  assert.equal(tools.length, BUILT_IN_TOOLS.length + 1)
})

test('applying a candidate replaces exactly one path, so an in-place edit is not a duplicate id', () => {
  // X-4 + I-04: the projection already holds the row being replaced, so without the
  // seam-owned drop-then-add an edit would report DUPLICATE_ID against itself.
  const view = {
    scan: {
      tables: [
        {
          table: 'characters',
          rows: [
            { path: 'characters/甲.md', id: 'c-1', name: '甲' },
            { path: 'characters/乙.md', id: 'c-2', name: '乙' },
          ],
        },
      ],
      entities: [
        { kind: 'characters', id: 'c-1', path: 'characters/甲.md', title: '甲' },
        { kind: 'characters', id: 'c-2', path: 'characters/乙.md', title: '乙' },
      ],
      issues: [{ code: 'FRONTMATTER_ISSUE', path: 'characters/甲.md', detail: 'old' }],
    },
    entities: [
      { kind: 'characters', id: 'c-1', path: 'characters/甲.md', title: '甲' },
      { kind: 'characters', id: 'c-2', path: 'characters/乙.md', title: '乙' },
    ],
  }

  const parsed = {
    path: 'characters/甲.md',
    rows: [{ table: 'characters', rows: [{ path: 'characters/甲.md', id: 'c-1', name: '甲改名' }] }],
    entity: { kind: 'characters', id: 'c-1', path: 'characters/甲.md', title: '甲改名' },
    issues: [],
  }

  const next = applyCandidate(view, parsed)

  assert.deepEqual(next.scan.tables[0].rows, [
    { path: 'characters/乙.md', id: 'c-2', name: '乙' },
    { path: 'characters/甲.md', id: 'c-1', name: '甲改名' },
  ])
  // One projection row per path, still one entry per entity — the replaced row is gone.
  assert.equal(next.scan.entities.filter((entity) => entity.id === 'c-1').length, 1)
  assert.equal(next.entities.filter((entity) => entity.id === 'c-1').length, 1)
  assert.equal(next.scan.entities.find((entity) => entity.id === 'c-1').title, '甲改名')
  // The old parse issue for that path is dropped with the old file; other paths keep theirs.
  assert.deepEqual(next.scan.issues, [])
})

test('applying a candidate into an empty table still creates the table bucket', () => {
  const view = { scan: { tables: [], entities: [], issues: [] }, entities: [] }
  const next = applyCandidate(view, {
    path: 'relations/甲-乙.md',
    rows: [{ table: 'relations', rows: [{ path: 'relations/甲-乙.md', source: 'c-1', target: 'c-2' }] }],
    issues: [{ code: 'RELATION_ENDPOINT', path: 'relations/甲-乙.md', detail: 'missing c-2' }],
  })

  assert.deepEqual(next.scan.tables, [
    { table: 'relations', rows: [{ path: 'relations/甲-乙.md', source: 'c-1', target: 'c-2' }] },
  ])
  assert.equal(next.scan.entities.length, 0, 'no entity row when the domain publishes none')
  assert.deepEqual(next.scan.issues, [{ code: 'RELATION_ENDPOINT', path: 'relations/甲-乙.md', detail: 'missing c-2' }])
})

test('every registered module owns a real content directory', () => {
  // X-5: a module is one directory's owner. A typo here would silently register a
  // domain that never scans anything, so the kind set is checked against the
  // exported directory contract rather than a second copy of the list.
  const contentDirs = new Set(CONTENT_DIRS)
  for (const module of DOMAIN_MODULES) {
    assert.ok(contentDirs.has(module.kind), `unknown domain kind: ${module.kind}`)
  }
  // One owner per directory: two modules scanning `characters` would double every
  // entity row and make `ENTITIES_DRIFT` (I-15) permanent.
  const kinds = DOMAIN_MODULES.map((module) => module.kind)
  assert.equal(new Set(kinds).size, kinds.length, 'each content directory may have at most one owner')
})
