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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CONTENT_DIRS, DOMAIN_MODULES, apply, domainTools } from '../lib/index.js'

/**
 * The built-in tool surface before the seam existed. Order is the declaration
 * order in `tools.ts`, and the hash covers `description` + `parameters` + `output`
 * over key-sorted JSON — renaming a tool or editing one schema property changes a
 * hash, which is exactly the regression this guards. Recorded from the pre-seam
 * build; an empty registry must reproduce it exactly.
 */
const BUILT_IN_TOOLS = [
  ['inkflow_project_status', 'cc6903de'],
  ['inkflow_index_rebuild', '51a5555a'],
  ['inkflow_chapter_list', '7fa48ea8'],
  ['inkflow_chapter_search', 'fe398cf5'],
  ['inkflow_project_plan', '52c0ddec'],
  ['inkflow_project_init', 'ec98d360'],
  ['inkflow_volume_create', 'a805a3ed'],
  ['inkflow_volume_rename', 'dd03c04a'],
  ['inkflow_chapter_create', 'dd6f9879'],
  ['inkflow_chapter_write', '6fc33ed0'],
  ['inkflow_chapter_move', 'd3a1d8f1'],
  ['inkflow_chapter_delete', 'a0cfc616'],
]

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function surfaceHash(tool) {
  const surface = { description: tool.description, parameters: tool.parameters, output: tool.output }
  return createHash('sha256').update(stableStringify(surface)).digest('hex').slice(0, 8)
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
    assert.equal(surfaceHash(tool), hash, `${name} changed its model-facing surface`)
    assert.ok(tool.output?.schema, `${name} keeps its output schema`)
  }
})

function stubModule(name) {
  return {
    kind: 'characters',
    scan: () => ({ tables: [], entities: [], issues: [] }),
    parseFile: () => ({ tables: [], entities: [], issues: [] }),
    validate: () => [],
    schema: () => ({ ddl: [], insert() {} }),
    tools: () => [{ name, description: 'stub', parameters: { type: 'object', properties: {} } }],
  }
}

test('an empty registry contributes no tools', () => {
  assert.deepEqual(domainTools([]), [])
})

test('a registered module contributes its own tools, in registry order', () => {
  const tools = domainTools([stubModule('inkflow_stub_first'), stubModule('inkflow_stub_second')])
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['inkflow_stub_first', 'inkflow_stub_second'],
  )
})

test('buildTools() actually consults the registry', () => {
  // The empty-registry tests above cannot catch a `buildTools()` that forgot to
  // call `domainTools()`: with no modules, both surfaces are identical. This one
  // registers a throwaway module and then drops it, which fails the moment the
  // aggregate stops being wired in.
  DOMAIN_MODULES.push(stubModule('inkflow_stub_wired'))
  try {
    const tools = registeredTools()
    assert.ok(tools.has('inkflow_stub_wired'), 'a registered module must reach the tool table')
  } finally {
    DOMAIN_MODULES.pop()
  }
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
