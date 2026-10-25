#!/usr/bin/env node
/**
 * Print the model-facing surface hashes `tests/domain-registry.test.js` pins.
 *
 * Why this exists: when a description or a schema property changes, that
 * test fails with two 8-character hashes and no hint about what moved. The fix it
 * demands — "recompute the baseline" — used to mean hand-running the registration
 * harness in a throwaway script. This is that script, kept in the repo so the
 * update is a copy-paste instead of an archaeology session.
 *
 * Usage:
 *   node scripts/surface-hash.mjs                 # paste-ready rows for the test
 *   node scripts/surface-hash.mjs --tool <name>   # one tool, per-part hashes + JSON
 *   node scripts/surface-hash.mjs --json          # machine-readable
 *
 * The hash is `description` + `parameters` + `output` over key-sorted JSON, first
 * 8 hex characters of sha256 — identical to `surfaceHash()` in the test.
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, domainTools } from '../lib/index.js'

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function hashOf(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 8)
}

function surfaceOf(tool) {
  return { description: tool.description, parameters: tool.parameters, output: tool.output }
}

/** Register the plugin against a throwaway harness and return name → tool. */
function registeredTools() {
  const workspace = mkdtempSync(join(tmpdir(), 'inkflow-surface-'))
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
    get() {
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
  try {
    apply(ctx, { dataDir: workspace })
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
  return tools
}

const argv = process.argv.slice(2)
const toolFlag = argv.indexOf('--tool')
const wanted = toolFlag === -1 ? undefined : argv[toolFlag + 1]
const asJson = argv.includes('--json')

const tools = registeredTools()
const domainNames = new Set(domainTools({ ctx: {}, dataDir: tmpdir(), version: 'surface-hash' }).map((tool) => tool.name))

if (wanted !== undefined) {
  const tool = tools.get(wanted)
  if (tool === undefined) {
    console.error(`unknown tool "${wanted}". Known: ${[...tools.keys()].join(', ')}`)
    process.exit(1)
  }
  const surface = surfaceOf(tool)
  console.log(
    JSON.stringify(
      {
        name: wanted,
        hash: hashOf(surface),
        parts: { description: hashOf(tool.description), parameters: hashOf(tool.parameters), output: hashOf(tool.output) },
        surface,
      },
      null,
      2,
    ),
  )
  process.exit(0)
}

const rows = [...tools.entries()].map(([name, tool]) => ({
  name,
  hash: hashOf(surfaceOf(tool)),
  domain: domainNames.has(name),
}))

if (asJson) {
  console.log(JSON.stringify(rows, null, 2))
  process.exit(0)
}

const builtIns = rows.filter((row) => !row.domain)
console.log('// paste into tests/domain-registry.test.js → BUILT_IN_TOOLS')
for (const row of builtIns) console.log(`  ['${row.name}', '${row.hash}'],`)
console.log('\n// domain tools registered by the seam (no baseline yet)')
for (const row of rows.filter((entry) => entry.domain)) console.log(`  ${row.name} ${row.hash}`)
