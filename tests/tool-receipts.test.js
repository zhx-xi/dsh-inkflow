/**
 * Two receipts the model reads, tested where they break rather than where they are built.
 *
 *   1. `inkflow_semantic_rebuild` without `confirm` is the documented first step ("estimate
 *      first"), and its reply carries no `summary` because no run happened. The renderer used
 *      to append the last-run block unconditionally and threw
 *      `Cannot read properties of undefined (reading 'slice')` — the host turns a throwing
 *      renderer into "the tool returned illegal output", so the estimate was unreachable.
 *   2. `inkflow_project_init` named its path `root` while `inkflow_project_plan` and every
 *      other tool say `projectRoot`. The unknown field was ignored, the tool fell back to the
 *      session working directory and SCAFFOLDED IT — a write nobody asked for. The name is now
 *      `projectRoot` with `root` kept as an alias, and two different values are refused.
 *
 * Both are asserted through the registered tool surface, because that is what the host calls.
 *
 * Run: pnpm test (needs `pnpm run build`)
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

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
  apply(ctx, { dataDir: join(workspace, '.plugin-state') })
  return tools
}

function rendered(tools, name, value) {
  const tool = tools.get(name)
  assert.ok(tool, `tool ${name} must be registered`)
  const blocks = tool.output.render({}, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0)
  return blocks.map((block) => String(block.text ?? '')).join('\n')
}

const EXEC = { signal: AbortSignal.timeout(20_000), agent: { id: 'test-session' } }

test('semantic rebuild: the estimate receipt renders without a summary', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'inkflow-receipt-'))
  const tools = harness(workspace)
  const text = rendered(tools, 'inkflow_semantic_rebuild', {
    ok: true,
    root: workspace,
    estimate: { pending: 2, unchanged: 1, tombstones: 0, blocks: 3, bytes: 4096, calls: 2, requiresConfirm: false },
    requiresConfirm: false,
  })
  assert.match(text, /重建预估：2 章待写/)
  assert.doesNotMatch(text, /最近一次重建/, 'an estimate is not a last run')
})

test('semantic rebuild: a stored summary without staleChapters still renders', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'inkflow-receipt-'))
  const tools = harness(workspace)
  const text = rendered(tools, 'inkflow_semantic_rebuild', {
    ok: true,
    root: workspace,
    estimate: { pending: 0, unchanged: 0, tombstones: 0, blocks: 1, bytes: 10, calls: 0 },
    requiresConfirm: false,
    // `stale` > 0 but the list is absent: the receipt must degrade, not throw.
    summary: { at: '2026-01-01T00:00:00.000Z', written: 1, tombstoned: 0, unchanged: 0, blocks: 1, bytes: 10, calls: 1, stale: 2 },
  })
  assert.match(text, /未完成（下次重试）：2 章/)
})

test('project init: projectRoot is honoured and root still answers', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'inkflow-init-'))
  const tools = harness(workspace)
  const init = tools.get('inkflow_project_init')
  assert.ok(init, 'inkflow_project_init must be registered')
  assert.ok(init.parameters.properties.projectRoot, 'the path parameter is named projectRoot, like every other tool')
  assert.ok(init.parameters.properties.root, 'the old name stays as an alias')

  const viaNewName = join(workspace, 'probe-new')
  const first = await init.execute({ projectRoot: viaNewName, title: '探针', confirm: true }, EXEC)
  assert.equal(first.ok, true, JSON.stringify(first.error ?? {}))
  assert.equal(first.root, viaNewName)
  assert.ok(existsSync(join(viaNewName, 'inkflow.json')), 'the book lands where projectRoot points')
  assert.equal(existsSync(join(workspace, 'inkflow.json')), false, 'the working directory must not be scaffolded')

  const viaAlias = join(workspace, 'probe-legacy')
  const second = await init.execute({ root: viaAlias, title: '探针二', confirm: true }, EXEC)
  assert.equal(second.ok, true, JSON.stringify(second.error ?? {}))
  assert.equal(second.root, viaAlias)
  assert.ok(existsSync(join(viaAlias, 'inkflow.json')))
})

test('project init: two different roots are refused, and nothing is written', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'inkflow-init-'))
  const tools = harness(workspace)
  const init = tools.get('inkflow_project_init')
  const a = join(workspace, 'left')
  const b = join(workspace, 'right')
  const result = await init.execute({ projectRoot: a, root: b, title: '冲突', confirm: true }, EXEC)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'PROJECT_ROOT_CONFLICT')
  assert.equal(existsSync(a), false, 'a refused call writes nothing')
  assert.equal(existsSync(b), false, 'a refused call writes nothing')
  assert.deepEqual(readdirSync(workspace).filter((name) => !name.startsWith('.')), [])
})
