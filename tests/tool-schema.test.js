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
 * So the guard mirrors every rule `assertSupportedJsonSchema` applies, not just the
 * keyword whitelist: the `required`/`additionalProperties` shapes, `type`-vs-`oneOf`
 * exclusivity, the keywords that may not sit beside `oneOf`, annotation types, and
 * the keyword-to-`type` compatibility table (a `properties` without an object type,
 * a one-branch `oneOf`, an `enum` whose values do not match its `type` are all
 * refused). Numeric bounds are not in the subset — write the range into
 * `description` instead.
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

/** The keywords whose constraint needs a `type` (or a `oneOf`) to attach to. */
const TYPED_KEYWORDS = [...ONE_OF_SIBLINGS]

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']

/** Whether a scalar fits one declared schema type (the Host's own `scalarMatches`). */
function scalarMatches(type, value) {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return false
  }
}

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
    // A constraint keyword needs somewhere to attach: without `type` or `oneOf` the
    // Host refuses the schema outright.
    const typed = TYPED_KEYWORDS.filter((key) => Object.prototype.hasOwnProperty.call(node, key))
    if (!hasType && !hasOneOf && typed.length > 0) {
      out.push(`${nodePath}: ${typed.map((key) => '"' + key + '"').join(', ')} requires type or oneOf`)
    }
    if (hasOneOf) {
      if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
        out.push(`${nodePath}: oneOf must be an array of at least two schemas`)
      }
      for (const key of ONE_OF_SIBLINGS) {
        if (Object.prototype.hasOwnProperty.call(node, key)) out.push(`${nodePath}: "${key}" is not supported beside oneOf`)
      }
    }
    // Keyword-to-type compatibility, and `enum`/`const` values that fit the type.
    const type = hasType ? node.type : undefined
    if (hasType && !SCHEMA_TYPES.includes(type)) out.push(`${nodePath}: type must be one of ${SCHEMA_TYPES.join('/')}`)
    for (const pair of [
      ['properties', 'object'],
      ['required', 'object'],
      ['additionalProperties', 'object'],
      ['items', 'array'],
    ]) {
      const keyword = pair[0]
      const expected = pair[1]
      if (hasType && typed.includes(keyword) && type !== expected) {
        out.push(`${nodePath}: "${keyword}" requires type "${expected}"`)
      }
    }
    if (hasType && Object.prototype.hasOwnProperty.call(node, 'enum')) {
      const values = node.enum
      if (!Array.isArray(values) || values.length === 0) out.push(`${nodePath}: enum must be a non-empty array`)
      else {
        for (const value of values) {
          if (!scalarMatches(type, value)) {
            out.push(`${nodePath}: enum value ${JSON.stringify(value)} does not match type "${String(type)}"`)
          }
        }
      }
    }
    if (hasType && Object.prototype.hasOwnProperty.call(node, 'const')) {
      if (!scalarMatches(type, node.const)) out.push(`${nodePath}: const does not match type "${String(type)}"`)
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
    'schema: oneOf must be an array of at least two schemas',
    'schema: "items" is not supported beside oneOf',
  ])
  const oneBranch = violations({ oneOf: [{ type: 'string' }] })
  assert.deepEqual(oneBranch, ['schema: oneOf must be an array of at least two schemas'])
  // Two branches is the accepted form.
  assert.deepEqual(violations({ oneOf: [{ type: 'string' }, { type: 'number' }] }), [])
  assert.deepEqual(violations({ type: 'string', oneOf: [{ type: 'number' }] }), [
    'schema: cannot declare both type and oneOf',
    'schema: oneOf must be an array of at least two schemas',
  ])
})

test('every shipped tool schema stays inside the Host-supported subset', () => {
  const tools = registeredTools()
  // Exact, not `>=`: dropping a domain tool would otherwise stay green, and the
  // baseline below only names the built-ins (#33 audit, #36 repair/migrate,
  // #37 import, #40 shared list/copy/update).
  assert.equal(tools.size, 35, `expected the full tool surface, got ${tools.size}`)

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
  assert.equal(domain.length, 16, `expected the sixteen domain tools, got ${domain.length}`)
  const failures = []
  for (const tool of domain) {
    if (tool.parameters === undefined) failures.push(`${tool.name}: no parameters schema`)
    else failures.push(...violations(tool.parameters, `${tool.name}.parameters`))
    if (tool.output?.schema === undefined) failures.push(`${tool.name}: no output schema`)
    else failures.push(...violations(tool.output.schema, `${tool.name}.output.schema`))
  }
  assert.deepEqual(failures, [])
})
