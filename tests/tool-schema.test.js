/**
 * Tool schemas must stay inside the JSON Schema subset the Host accepts (#114).
 *
 * Why this file exists: a single unsupported keyword does not make one tool fail —
 * `dsh-tools` throws while the plugin registers, cordis reports
 * "1 entry did not activate" and keeps booting, so the whole plugin silently
 * disappears (no `inkflow_*` tools, no `/inkflow/internal/*` routes) while the GUI
 * shows nothing but a stderr line it swallows. Measured on DSH 0.2.1-rc.2:
 *
 *   JsonSchemaError: unsupported JSON schema:
 *     schema.properties.limit.minimum is not a supported keyword
 *   JsonSchemaError: unsupported JSON schema:
 *     schema.required names "ok" which is not in properties
 *
 * So the guard is a whitelist walk over every schema the plugin ships, plus the
 * `required`-must-be-declared rule. `DESCRIPTION`-style annotations are allowed;
 * numeric bounds are not — write the range into `description` instead.
 *
 * Runs against the built artifact, like every other contract test.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, domainTools } from '../lib/index.js'

/**
 * The keywords `assertSupportedJsonSchema` accepts (dsh-tools 0.2.1-rc.2).
 *
 * Kept as a literal mirror on purpose: the Host package is not a dependency of
 * this project (AGENTS.md §2 — no `@deepseek-ai/*` imports), so the subset has to
 * be restated here. When the Host widens it, this list is where that lands.
 */
const CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
])

/**
 * `ANNOTATION_KEYWORDS`, verbatim from the same function. Deliberately NOT wider
 * than the Host's set: `$comment` and `deprecated` look harmless, but the Host
 * refuses them like any other unknown keyword — so a guard that accepted them
 * would wave through the very failure it exists to catch.
 */
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])

const SUPPORTED = new Set([...CONSTRAINT_KEYWORDS, ...ANNOTATION_KEYWORDS])

/** `ONE_OF_SIBLING_KEYWORDS`: these may not sit beside `oneOf`. */
const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']

/** Every `{ keyword: value }` object inside a schema, keyed by its JSON path. */
function schemaNodes(schema, path = 'schema', out = []) {
  if (schema === null || typeof schema !== 'object') return out
  if (Array.isArray(schema)) {
    schema.forEach((entry, index) => schemaNodes(entry, `${path}[${index}]`, out))
    return out
  }
  out.push([path, schema])
  for (const [keyword, value] of Object.entries(schema)) {
    if (keyword === 'properties' && value !== null && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) schemaNodes(child, `${path}.properties.${name}`, out)
      continue
    }
    if (keyword === 'items') {
      schemaNodes(value, `${path}.items`, out)
      continue
    }
    if (keyword === 'oneOf') {
      schemaNodes(value, `${path}.oneOf`, out)
    }
  }
  return out
}

/** Every reason this schema would be refused, as readable sentences. */
function violations(schema, path = 'schema', out = []) {
  for (const [nodePath, node] of schemaNodes(schema, path, [])) {
    for (const keyword of Object.keys(node)) {
      if (!SUPPORTED.has(keyword)) out.push(`${nodePath}: "${keyword}" is not a supported keyword`)
    }
    if (Object.prototype.hasOwnProperty.call(node, 'required')) {
      const required = node.required
      if (!Array.isArray(required) || required.some((name) => typeof name !== 'string')) {
        out.push(`${nodePath}: required must be an array of strings`)
      } else {
        const declared = node.properties !== null && typeof node.properties === 'object' ? node.properties : {}
        for (const name of required) {
          if (!Object.prototype.hasOwnProperty.call(declared, name)) {
            out.push(`${nodePath}: required names "${name}" which is not in properties`)
          }
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
      // A schema-valued `additionalProperties` is refused: only `true`/`false`.
      out.push(`${nodePath}: additionalProperties must be a boolean`)
    }
    if (Object.prototype.hasOwnProperty.call(node, 'description') && typeof node.description !== 'string') {
      out.push(`${nodePath}: description must be a string`)
    }
    if (Object.prototype.hasOwnProperty.call(node, 'title') && typeof node.title !== 'string') {
      out.push(`${nodePath}: title must be a string`)
    }
    const hasType = Object.prototype.hasOwnProperty.call(node, 'type')
    const hasOneOf = Object.prototype.hasOwnProperty.call(node, 'oneOf')
    if (hasType && hasOneOf) out.push(`${nodePath}: cannot declare both type and oneOf`)
    if (hasOneOf) {
      for (const key of ONE_OF_SIBLINGS) {
        if (Object.prototype.hasOwnProperty.call(node, key)) out.push(`${nodePath}: "${key}" is not supported beside oneOf`)
      }
    }
  }
  return out
}

function registeredTools() {
  const workspace = mkdtempSync(join(tmpdir(), 'inkflow-schema-'))
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

test('the guard itself catches the two shapes that killed the plugin', () => {
  // A vacuous guard would pass everything, so the rule is asserted on its own:
  // this is the exact schema DSH refused at register() time.
  assert.deepEqual(violations({ type: 'integer', minimum: 1, description: 'x' }), [
    'schema: "minimum" is not a supported keyword',
  ])
  assert.deepEqual(violations({ type: 'object', required: ['ok'], additionalProperties: true }), [
    'schema: required names "ok" which is not in properties',
  ])
  // The accepted form of the same intent: the range lives in the description.
  assert.deepEqual(violations({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }), [])
  // ... and the near-misses an over-generous guard would wave through:
  assert.deepEqual(violations({ type: 'string', $comment: 'harmless?' }), ['schema: "$comment" is not a supported keyword'])
  assert.deepEqual(violations({ type: 'string', deprecated: true }), ['schema: "deprecated" is not a supported keyword'])
  assert.deepEqual(violations({ type: 'object', additionalProperties: { type: 'string' } }), [
    'schema: additionalProperties must be a boolean',
  ])
  // Both rules fire on this shape, and both are real refusals: the Host reports
  // the `type`+`oneOf` conflict first and then the sibling keyword.
  assert.deepEqual(violations({ type: 'array', oneOf: [{ type: 'string' }], items: { type: 'string' } }), [
    'schema: cannot declare both type and oneOf',
    'schema: "items" is not supported beside oneOf',
  ])
  assert.deepEqual(violations({ oneOf: [{ type: 'string' }], items: { type: 'string' } }), [
    'schema: "items" is not supported beside oneOf',
  ])
  assert.deepEqual(violations({ type: 'string', oneOf: [{ type: 'number' }] }), ['schema: cannot declare both type and oneOf'])
})

test('every shipped tool schema stays inside the Host-supported subset', () => {
  const tools = registeredTools()
  assert.ok(tools.size >= 21, `expected the full tool surface, got ${tools.size}`)

  const failures = []
  for (const [name, tool] of tools) {
    if (tool.parameters === undefined) failures.push(`${name}: no parameters schema`)
    else failures.push(...violations(tool.parameters, `${name}.parameters`).map((line) => `  ${line}`))
    if (tool.output?.schema === undefined) failures.push(`${name}: no output schema`)
    else failures.push(...violations(tool.output.schema, `${name}.output.schema`).map((line) => `  ${line}`))
  }

  assert.deepEqual(
    failures,
    [],
    `a schema keyword outside the Host subset makes the ENTIRE plugin fail to activate, not just that tool:\n${failures.join('\n')}`,
  )
})

test('the domain tools the registry contributes are covered by the same guard', () => {
  // `domainTools()` is what `apply()` registers beyond the built-ins; asserting the
  // count keeps this file honest when a new domain lands.
  const domain = domainTools({ ctx: {}, dataDir: tmpdir(), version: 'test' })
  assert.ok(domain.length >= 9, `expected the nine domain tools, got ${domain.length}`)
  const failures = []
  for (const tool of domain) {
    if (tool.parameters === undefined) failures.push(`${tool.name}: no parameters schema`)
    else failures.push(...violations(tool.parameters, `${tool.name}.parameters`))
    if (tool.output?.schema === undefined) failures.push(`${tool.name}: no output schema`)
    else failures.push(...violations(tool.output.schema, `${tool.name}.output.schema`))
  }
  assert.deepEqual(failures, [])
})
