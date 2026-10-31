/**
 * The delegation policy: one decision, three sentences, two consumers, one optional row.
 *
 * WHAT THIS FILE PINS, and why each one is a way the feature could quietly go wrong:
 *
 *   1. THE THREE STATES — off / delegated / unconfigured come from ONE function
 *      (`describeDelegation`), so the sentence the session is told and the line the batch
 *      tool prints cannot drift apart. The assertions compare the SAME string in both
 *      places rather than two strings that happen to look alike.
 *   2. NO INVENTED MODEL — "provider set, model empty" is not a dispatchable route. The
 *      plan has no `model` and no `route`, and the text says "ask the author". A default
 *      picked from a catalog would be a model the author never chose.
 *   3. THE ANSWER IS NOT WRITTEN BACK — the whole point of the human-in-the-loop step is
 *      that the author's choice belongs to THIS session. The test assembles the policy,
 *      "answers", assembles again, and proves `settings.json` is byte-identical.
 *   4. THE ROW IS CONDITIONAL AND A REGISTRATION-TIME SNAPSHOT — the workflow row is in the
 *      composition only while the switch is on, and moving the switch re-registers the
 *      preset (that is what "只影响新开的会话" means: a running session keeps its revision).
 *
 * Runs against the built artifact (`../lib/index.js`), like every other contract test.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BUNDLED_SKILL_NAMES,
  DELEGATION_SECTION_NAME,
  DELEGATION_SECTION_ORDER,
  DELEGATION_TOOL_ROW_NAME,
  apply,
  buildTools,
  buildWritingPreset,
  delegationEnabled,
  delegationPolicyText,
  describeDelegation,
  readSettings,
  registerDelegationSection,
  settingsOf,
  settingsPath,
  writeSettings,
} from '../lib/index.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

function workspace(prefix = 'inkflow-delegation-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  return {
    root,
    dataDir: join(root, 'state'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

/** The four states a form can be in, as `describeDelegation` sees them. */
const OFF = { subagentEnabled: false }
const PROVIDER_ONLY = { subagentEnabled: true, subagentProvider: 'deepseek-account' }
const READY = { subagentEnabled: true, subagentProvider: 'deepseek-account', subagentModel: 'deepseek-v4-pro' }

test('off — the session is told to write the chapter itself, in one line both consumers share', () => {
  const plan = describeDelegation(OFF)
  assert.equal(plan.state, 'off')
  assert.equal(plan.sentence, '写作方式：自己写（未开启子智能体）')
  assert.equal(delegationEnabled(OFF), false)
  const text = delegationPolicyText(plan)
  assert.ok(text.includes(plan.sentence), 'the injected policy must start from the same sentence')
  assert.ok(text.includes('本章由你自己写；不要委派。'))
  assert.equal(text.includes('ask_user_question'), false, 'an off switch must not still be asking the author')
})

test('delegated — the model and provider reach both surfaces as the same sentence', () => {
  const plan = describeDelegation(READY)
  assert.equal(plan.state, 'delegated')
  assert.equal(plan.provider, 'deepseek-account')
  assert.equal(plan.model, 'deepseek-v4-pro')
  assert.equal(plan.route, 'deepseek-account/deepseek-v4-pro')
  assert.equal(plan.sentence, '写作方式：委派子智能体（deepseek-account/deepseek-v4-pro）')
  assert.equal(delegationEnabled(READY), true)

  const text = delegationPolicyText(plan)
  assert.ok(text.includes(plan.sentence))
  assert.ok(text.includes('deepseek-v4-pro'), 'the injected policy must name the model it asks for')
  assert.ok(text.includes('审计与设定入库留在本会话'))
  assert.equal(text.includes('ask_user_question'), false, 'a configured model leaves nothing to ask')
})

test('unconfigured — the model stays absent, so the text asks instead of guessing', () => {
  const plan = describeDelegation(PROVIDER_ONLY)
  assert.equal(plan.state, 'unconfigured')
  assert.equal(plan.provider, 'deepseek-account')
  // The decision that matters: no model, so no route. A default here would be a model the
  // author never chose, applied while prose is being generated.
  assert.equal(plan.model, undefined)
  assert.equal(plan.route, undefined)
  assert.equal(delegationEnabled(PROVIDER_ONLY), true, 'the switch is on: the workflow row must be reachable')

  const text = delegationPolicyText(plan)
  assert.ok(text.includes(plan.sentence))
  assert.ok(text.includes('ask_user_question'), 'the agent is told HOW to ask')
  assert.ok(text.includes('不要自己挑一个'))
  assert.ok(text.includes('只填了 provider'), 'the form-level mistake is named, not silently accepted')
  // And the temporary answer is explicitly not to be persisted.
  assert.ok(text.includes('本次会话'))
  assert.ok(text.includes('inkflow_settings_update'))
})

test('the batch tool prints the same sentence the injection carries', () => {
  const { dataDir, cleanup } = workspace()
  try {
    for (const settings of [OFF, PROVIDER_ONLY, READY]) {
      const plan = describeDelegation(settings)
      const tools = buildTools({ ctx: {}, dataDir, version: 'test' })
      const take = tools.find((tool) => tool.name === 'inkflow_batch_take')
      assert.ok(take, 'inkflow_batch_take must be registered')
      const blocks = take.output.render({}, {
        ok: true,
        jobId: 'bj-00000000',
        dir: 'D:/书/.inkflow/jobs/bj-00000000',
        status: 'running',
        counts: { total: 1, pending: 1, running: 0, done: 0, held: 0, failed: 0 },
        remaining: 1,
        delegation: plan.wire,
        tasks: [],
      })
      const lines = blocks[0].text.split('\n')
      assert.equal(
        lines.includes(plan.sentence),
        true,
        `the batch reply must print "${plan.sentence}" verbatim — got:\n${blocks[0].text}`,
      )
      assert.ok(delegationPolicyText(plan).includes(plan.sentence), 'and the injection must carry it too')
    }
  } finally {
    cleanup()
  }
})

test('the injected text is assembled per request, so a save is in force on the next turn', () => {
  const { dataDir, cleanup } = workspace()
  try {
    writeSettings(dataDir, { subagentEnabled: false })
    const sections = []
    const service = { section: (section) => { sections.push(section); return () => {} } }
    const disposers = []
    const ctx = {
      effect(setup) {
        const dispose = setup()
        disposers.push(dispose)
        return () => {}
      },
      inject(_deps, callback) { callback(ctx) },
      get: (name) => (name === 'systemPrompt' ? service : undefined),
      logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    }
    const registration = registerDelegationSection(ctx, { dataDir, log: ctx.logger('test') })
    assert.equal(registration.registered, true)
    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, DELEGATION_SECTION_NAME)
    assert.equal(sections[0].order, DELEGATION_SECTION_ORDER)
    assert.ok(sections[0].text().includes('写作方式：自己写（未开启子智能体）'))

    writeSettings(dataDir, { subagentEnabled: true, subagentProvider: 'deepseek-account', subagentModel: 'deepseek-v4-pro' })
    assert.ok(
      sections[0].text().includes('写作方式：委派子智能体（deepseek-account/deepseek-v4-pro）'),
      'the thunk must re-read the file: a save reaches the next assembly without a restart',
    )
    for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  } finally {
    cleanup()
  }
})

test('a missing systemPrompt service degrades to one log line', () => {
  const lines = []
  const ctx = {
    effect: (setup) => () => setup(),
    inject: () => {},
    get: () => undefined,
    logger: () => ({ debug() {}, info: (message) => lines.push(String(message)), warn() {}, error() {} }),
  }
  const registration = registerDelegationSection(ctx, { dataDir: 'unused', log: ctx.logger('test') })
  assert.equal(registration.registered, false)
  assert.equal(registration.reason, 'systemPrompt service missing')
  assert.ok(lines.some((line) => line.includes('systemPrompt service missing')))
})

// ---------------------------------------------------------------------------
// The preset row
// ---------------------------------------------------------------------------

test('the writing preset carries the workflow row only while the switch is on', () => {
  const off = buildWritingPreset([...BUNDLED_SKILL_NAMES])
  const offRows = off.plugins.map((row) => row.name)
  assert.equal(offRows.includes(DELEGATION_TOOL_ROW_NAME), false, 'off means no delegation row')
  assert.ok(off.description.includes('不含 shell 与委派'))

  const on = buildWritingPreset([...BUNDLED_SKILL_NAMES], { delegate: true })
  const onRows = on.plugins.map((row) => row.name)
  assert.equal(onRows.includes(DELEGATION_TOOL_ROW_NAME), true, 'on means the workflow row is mounted')
  assert.equal(onRows.filter((name) => name === DELEGATION_TOOL_ROW_NAME).length, 1)
  // The wording that said "no delegation" must be gone, or the roster contradicts the rows.
  assert.equal(on.description.includes('不含委派'), false)
  // Everything else is shared: same id, same persona, same other rows.
  assert.equal(on.id, off.id)
  assert.deepEqual(on.plugins[0], off.plugins[0])
  assert.deepEqual(onRows.filter((name) => name !== DELEGATION_TOOL_ROW_NAME), offRows)
  // Row ids stay unique, which the loader requires.
  assert.equal(new Set(on.plugins.map((row) => row.id)).size, on.plugins.length)
})

test('moving the switch re-registers the composition; a save that does not move it does not', async () => {
  const { dataDir, cleanup } = workspace()
  try {
    const registrations = []
    const disposed = []
    const registry = {
      register(definition) {
        registrations.push(definition)
        return Promise.resolve(async () => {
          disposed.push(definition)
        })
      },
    }
    const disposers = []
    const ctx = {
      effect(setup) {
        const dispose = setup()
        disposers.push(dispose)
        return () => {}
      },
      inject(_deps, callback) { callback(ctx) },
      get: (name) => (name === 'agentPresets' ? registry : undefined),
      logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    }
    const rowsOf = (definition) => definition.plugins.map((row) => row.name)

    writeSettings(dataDir, { subagentEnabled: false })
    apply(ctx, { dataDir, serveHttp: false })
    await tick()
    assert.equal(registrations.length, 1, 'one composition per apply')
    assert.equal(rowsOf(registrations[0]).includes(DELEGATION_TOOL_ROW_NAME), false)

    // A save that does not touch the switch must not reload the composition: the row set is
    // what a registration is for, and the policy text is a thunk that needs no reload.
    writeSettings(dataDir, { backupKeep: 9 })
    await tick()
    assert.equal(registrations.length, 1)

    // The switch moving IS the row set moving, so it becomes a new declaration. Sessions
    // that start from now on get it; running ones keep the revision they joined (the Host's
    // own retention — the reason the settings page says "只影响新开的会话").
    writeSettings(dataDir, { subagentEnabled: true, subagentProvider: 'deepseek-account', subagentModel: 'deepseek-v4-pro' })
    await tick()
    await tick()
    await tick()
    assert.equal(registrations.length, 2, 'a revision is a new declaration, not a mutation')
    assert.equal(rowsOf(registrations[1]).includes(DELEGATION_TOOL_ROW_NAME), true)
    // Old revision disposed only after the replacement was registered.
    assert.equal(disposed.length, 1)
    assert.equal(disposed[0], registrations[0])

    // Unload disposes the current one; nothing is left registered.
    for (const dispose of disposers) if (typeof dispose === 'function') dispose()
    await tick()
    assert.equal(disposed.length, 2)
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// The human-in-the-loop answer stays in the session
// ---------------------------------------------------------------------------

test('the model the author picks at the moment of use is NOT written back to settings.json', () => {
  const { dataDir, cleanup } = workspace()
  try {
    writeSettings(dataDir, { subagentEnabled: true, subagentProvider: 'deepseek-account' })
    const before = readFileSync(settingsPath(dataDir))
    assert.equal(readSettings(dataDir).settings.subagentModel, undefined)

    // The session, as far as the plugin is concerned: the policy says "ask", the agent asks,
    // and the answer lives in the session's own context (a local value here). Nothing in this
    // module can persist it — `src/host/delegation.ts` does not import the writer, which the
    // source guard below asserts separately.
    const first = describeDelegation(settingsOf(dataDir))
    assert.equal(first.state, 'unconfigured')
    const remembered = 'deepseek-v4-pro' // the author's answer, for THIS session only
    assert.equal(remembered.length > 0, true)

    // Read again: the choice did not become a setting, so the next session starts by asking
    // again — which is the pinned behaviour ("本次会话" means exactly that).
    const second = describeDelegation(settingsOf(dataDir))
    assert.equal(second.state, 'unconfigured')
    assert.equal(second.model, undefined)
    const after = readFileSync(settingsPath(dataDir))
    assert.deepEqual(after, before, 'settings.json must be byte-identical after the author answers')
  } finally {
    cleanup()
  }
})

test('the delegation module has no way to write settings (source guard)', () => {
  // A rule followed only by whoever remembers it is not a guarantee. The HITL decision is
  // "the answer is not persisted", so the module that produces the policy must not hold the
  // writer at all — then "do not write it back" cannot be broken by a one-line mistake there.
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'host', 'delegation.ts'), 'utf8')
  assert.equal(/from\s+'\.\/settings\.js'/.test(source), true, 'the module reads settings through settings.js')
  assert.equal(/writeSettings|removeSettingsFile|onSettingsWritten/.test(source), false, 'but it never writes them')
  // …and the policy itself tells the agent the same thing, for the tool-call route.
  assert.ok(delegationPolicyText(describeDelegation(PROVIDER_ONLY)).includes('不要调用 `inkflow_settings_update`'))
})

test('a settings file that predates the switch reads as off, and writes leave no empty strings', () => {
  const { dataDir, cleanup } = workspace()
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(settingsPath(dataDir), `${JSON.stringify({ schemaVersion: 1, backupKeep: 3 })}\n`, 'utf8')
    const read = readSettings(dataDir)
    assert.equal(read.settings.subagentEnabled, false)
    assert.equal(read.warn, undefined, 'a missing field is not a warning: it is the default')

    const written = writeSettings(dataDir, { subagentProvider: '   ', subagentModel: null })
    assert.equal(written.ok, true)
    const onDisk = JSON.parse(readFileSync(settingsPath(dataDir), 'utf8'))
    // A blank box is a CLEAR, never an empty string stored in the file.
    assert.equal(Object.prototype.hasOwnProperty.call(onDisk, 'subagentProvider'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(onDisk, 'subagentModel'), false)
  } finally {
    cleanup()
  }
})
