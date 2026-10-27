/**
 * One anchor for every tool that takes `projectRoot`.
 *
 * The bug this pins: when the session working directory was unavailable, three separate copies
 * of "where is this book" gave three answers. `tool-support.withProject()` and
 * `tool-project.resolveProject()` searched `process.cwd()` — inside the host process that is the
 * DSH install directory — and answered `NOT_AN_INKFLOW_PROJECT` ("no project was found from the
 * session working directory"), naming a directory the author never chose; `relation-tools` had a
 * third copy with the same fallback; only the outline tools refused with `PROJECT_ROOT_UNKNOWN`
 * and said which anchor was missing. Same session, different stories.
 *
 * The assertion is a SHAPE assertion: every tool that declares `projectRoot` answers the same
 * code with the same three anchor fields — which directory, where it came from, and what was
 * searched. The six exceptions are listed one by one WITH a reason, because "this tool is
 * different" is exactly the sentence that needs writing down.
 *
 * Run: pnpm test (needs `pnpm run build` — this calls the built plugin).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

/**
 * The tools that answer something else first, each with the reason it does.
 *
 * They are NOT excused from the rule "say where you looked" — they simply never get as far as
 * looking, or their whole job is to answer the question instead of refusing it. Any other tool
 * growing a second opinion turns this test red.
 */
const EXEMPT = {
  'inkflow_project_plan':
    'a plan is what you ask for when you are not sure the directory is a book: it answers the question instead of refusing it',
  'inkflow_shared_list':
    'the plugin-level shared library is not a book: it lists what exists before one is chosen',
  'inkflow_project_repair':
    'this tool exists to fix a broken book, so it must be able to look at a directory that is not one yet',
  'inkflow_project_migrate':
    'same: it upgrades a legacy layout, which is by definition not yet the current project shape',
  'inkflow_diagnostics_export':
    'the confirm gate runs before any book is resolved, because a broken book is the usual reason to export diagnostics',
  'inkflow_relation_upsert':
    'the argument/confirm check runs before the anchor: a call that forgot `confirm` is answered CONFIRM_REQUIRED, which is more actionable than a missing directory',
}

/**
 * The plugin wired to a context with NO `workingDirectory` service — the state a session is in
 * when the host cannot name one. `sessionCwdWithSource()` reports `process` there, which is the
 * anchor the tools must refuse on.
 */
function harnessWithoutSession() {
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
    webServer: { register() { return () => {} } },
  }
  return { ctx, tools }
}

const EXEC = { signal: AbortSignal.timeout(5000), agent: { id: 'test-session' } }

test('every tool that takes projectRoot refuses on the same anchor, with the same fields', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'inkflow-anchor-'))
  const harness = harnessWithoutSession()
  apply(harness.ctx, { dataDir })
  try {
    const takingRoot = [...harness.tools.values()].filter(
      (tool) => tool.parameters?.properties?.projectRoot !== undefined,
    )
    // 67 of the 70 tools declare it today; a much lower number means the scan stopped matching
    // and the loop below would pass without testing anything.
    assert.ok(takingRoot.length >= 60, `only ${String(takingRoot.length)} tools declare projectRoot — the scan broke`)

    // The exemption list must describe tools that exist: a stale entry would excuse a name that
    // is no longer registered and quietly shrink the coverage.
    for (const name of Object.keys(EXEMPT)) {
      assert.ok(harness.tools.get(name), `${name} is listed as an exception but is not registered any more`)
    }

    const checked = []
    for (const tool of takingRoot) {
      if (EXEMPT[tool.name] !== undefined) continue
      const reply = await tool.execute({}, EXEC)
      assert.equal(reply?.ok, false, `${tool.name}: a call with no anchor must not succeed`)
      const error = reply?.error ?? {}
      assert.equal(
        error.code,
        'PROJECT_ROOT_UNKNOWN',
        `${tool.name}: expected the anchor refusal, got ${String(error.code)} (${String(error.message ?? '')})`,
      )
      assert.equal(typeof error.cwd, 'string', `${tool.name}: the refusal names the directory it looked at`)
      assert.equal(error.cwdSource, 'process', `${tool.name}: and says where that directory came from`)
      assert.equal(error.searchedFrom, 'none', `${tool.name}: "none" — no search happened, so nothing was ruled out`)
      checked.push(tool.name)
    }
    assert.ok(checked.length >= 50, `only ${String(checked.length)} tools were actually checked`)
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('an explicit projectRoot skips the anchor: the refusal describes the directory instead', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'inkflow-anchor-root-'))
  const book = mkdtempSync(join(tmpdir(), 'inkflow-anchor-book-'))
  const harness = harnessWithoutSession()
  apply(harness.ctx, { dataDir })
  try {
    const sample = [...harness.tools.values()].find(
      (tool) => tool.name === 'inkflow_chapter_list' && tool.parameters?.properties?.projectRoot !== undefined,
    )
    assert.ok(sample, 'the chapter list tool declares projectRoot')
    // An empty directory is not a book: the call must fail with a GATE or SCOPE answer (which
    // describe the directory that was named) rather than the anchor answer. That is the
    // difference between "you gave me the wrong place" and "you gave me no place".
    //
    // Two refusals are legitimate here and the test accepts both on purpose: a temp directory
    // lives outside the session workspace, so the path-scope check can refuse it before the
    // four-state gate ever looks (ADR-0006 D1 keeps `inspectProject()` off out-of-scope paths).
    const reply = await sample.execute({ projectRoot: book }, EXEC)
    assert.equal(reply?.ok, false)
    assert.notEqual(reply?.error?.code, 'PROJECT_ROOT_UNKNOWN', 'an explicit root skips the anchor')
    assert.ok(reply?.error?.code, 'the refusal names a code')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(book, { recursive: true, force: true })
  }
})
