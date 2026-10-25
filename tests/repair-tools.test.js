/**
 * The maintenance tools as the model actually reaches them.
 *
 * `repair.test.js` and `migrate.test.js` call the modules directly; this file drives
 * the registered tool surface instead, because three failure modes only exist there:
 *
 *   * a parameter name the model passes but `execute` never reads (`action`, `select`,
 *     `confirm`, `backup`) — the tool would silently do the wrong thing;
 *   * a refusal that arrives without `ok:false`, so the model reports success;
 *   * `output.render()` throwing on the shapes `execute` actually returns (the host
 *     calls it on every result, so this is the difference between a report and an
 *     exception in the transcript).
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { hashTree } from './hash-tree.mjs'

const NINE = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-repair-tools-'))
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

function makeTools(workspace) {
  const harness = createHarness(workspace)
  apply(harness.ctx, { dataDir: join(workspace, '.plugin-state') })
  return harness
}

async function callTool(harness, name, args) {
  const tool = harness.tools.get(name)
  assert.ok(tool, `tool ${name} must be registered`)
  return tool.execute(args, { signal: AbortSignal.timeout(10_000), agent: { id: 'test-session' } })
}

/** Render through the tool's own renderer, exactly as the host does. */
function rendered(harness, name, args, value) {
  const tool = harness.tools.get(name)
  const blocks = tool.output.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0)
  const text = blocks.map((block) => String(block.text ?? '')).join('\n')
  assert.ok(text.trim() !== '', 'the renderer must produce text')
  return text
}

function repairBook() {
  const root = workdir()
  for (const dir of NINE) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '工具面测试' }, null, 2)}\n`, 'utf8')
  writeFileSync(
    join(root, 'facts/白云观.md'),
    '---\ntitle: 白云观\n---\n\n',
    'utf8',
  )
  return root
}

function legacyBook() {
  const root = workdir()
  for (const dir of ['chapters', 'characters', 'world', 'outlines', 'library', 'index']) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 0, title: '老书' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.gitignore'), 'index/*.db\n', 'utf8')
  return root
}

test('tool repair: detect / preview / fix through the registered surface', async () => {
  const root = repairBook()
  const harness = makeTools(root)

  const detected = await callTool(harness, 'inkflow_project_repair', { action: 'detect' })
  assert.equal(detected.ok, true)
  assert.ok(detected.findings.some((finding) => finding.code === 'FRONTMATTER_ISSUE'))
  rendered(harness, 'inkflow_project_repair', { action: 'detect' }, detected)

  const beforePreview = hashTree(root)
  const preview = await callTool(harness, 'inkflow_project_repair', { action: 'preview' })
  assert.equal(preview.ok, true)
  assert.ok(preview.actions.length > 0)
  assert.equal(preview.nothingWritten, true)
  assert.equal(hashTree(root), beforePreview)
  const previewText = rendered(harness, 'inkflow_project_repair', { action: 'preview' }, preview)
  assert.match(previewText, /Nothing was written/u)

  const refused = await callTool(harness, 'inkflow_project_repair', { action: 'fix' })
  assert.equal(refused.ok, false)
  assert.equal(refused.requiresConfirmation, true)
  assert.equal(hashTree(root), beforePreview)
  assert.match(rendered(harness, 'inkflow_project_repair', { action: 'fix' }, refused), /confirm: true/u)

  const fixed = await callTool(harness, 'inkflow_project_repair', { action: 'fix', confirm: true })
  assert.equal(fixed.ok, true)
  assert.equal(fixed.report.written, true)
  assert.ok(existsSync(join(root, fixed.report.path)))
  // The fixture's only *fixable* problem was the missing `subject:`; the empty
  // outline tree is reported as `OUTLINE_NO_OVERALL` and is not auto-fixable, so it
  // stays. What must be gone is every code the run claimed to fix.
  assert.equal(fixed.remaining.some((finding) => finding.code === 'FRONTMATTER_ISSUE'), false)
  assert.ok(fixed.cleared.length > 0, 'the re-check must report what disappeared')
  assert.match(readFileSync(join(root, 'facts/白云观.md'), 'utf8'), /subject: 白云观/u)
  const fixedText = rendered(harness, 'inkflow_project_repair', { action: 'fix', confirm: true }, fixed)
  assert.match(fixedText, /Re-check/u)
})

test('tool repair: select addresses one action, and an unknown action is refused', async () => {
  const root = repairBook()
  const harness = makeTools(root)
  const preview = await callTool(harness, 'inkflow_project_repair', { action: 'preview' })
  const key = preview.actions[0].key

  const selected = await callTool(harness, 'inkflow_project_repair', { action: 'fix', confirm: true, select: [key] })
  assert.equal(selected.ok, true)
  assert.deepEqual(selected.applied.map((outcome) => outcome.action.key), [key])

  const invalid = await callTool(harness, 'inkflow_project_repair', { action: 'nonsense' })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'ACTION_INVALID')
  rendered(harness, 'inkflow_project_repair', { action: 'nonsense' }, invalid)
})

test('tool migrate: plan / apply / rollback through the registered surface', async () => {
  const root = legacyBook()
  const harness = makeTools(root)

  const beforePlan = hashTree(root)
  const planned = await callTool(harness, 'inkflow_project_migrate', { action: 'plan' })
  assert.equal(planned.ok, true)
  assert.equal(planned.legacy, true)
  assert.ok(planned.actions.length > 0)
  assert.equal(hashTree(root), beforePlan)
  assert.match(rendered(harness, 'inkflow_project_migrate', { action: 'plan' }, planned), /dry run/u)

  const refused = await callTool(harness, 'inkflow_project_migrate', { action: 'apply' })
  assert.equal(refused.ok, false)
  assert.equal(refused.requiresConfirmation, true)
  assert.equal(hashTree(root), beforePlan)

  const applied = await callTool(harness, 'inkflow_project_migrate', { action: 'apply', confirm: true })
  assert.equal(applied.ok, true, applied.error?.message)
  assert.deepEqual(
    [...applied.applied].sort(),
    [...planned.actions.map((action) => `${action.op} ${action.path}`.trim())].sort(),
  )
  const appliedText = rendered(harness, 'inkflow_project_migrate', { action: 'apply', confirm: true }, applied)
  assert.match(appliedText, /Backup/u)

  const name = applied.backup.dir.split('/').pop()
  const missingBackup = await callTool(harness, 'inkflow_project_migrate', { action: 'rollback' })
  assert.equal(missingBackup.ok, false)
  assert.equal(missingBackup.error.code, 'BACKUP_REQUIRED')
  assert.ok(missingBackup.backups.length === 1, 'the refusal lists the packages it can see')

  const unconfirmed = await callTool(harness, 'inkflow_project_migrate', { action: 'rollback', backup: name })
  assert.equal(unconfirmed.ok, false)
  assert.equal(unconfirmed.requiresConfirmation, true)

  const rolled = await callTool(harness, 'inkflow_project_migrate', { action: 'rollback', backup: name, confirm: true })
  assert.equal(rolled.ok, true, rolled.error?.message)
  assert.ok(rolled.dirsRemoved.includes('foreshadowing'))
  assert.equal(rolled.kept.some((entry) => entry.path === '.git'), true)
  const rolledText = rendered(harness, 'inkflow_project_migrate', { action: 'rollback', backup: name, confirm: true }, rolled)
  assert.match(rolledText, /Rolled back/u)
})

test('tool migrate: refuses a directory that is not a book at all', async () => {
  const root = workdir()
  const harness = makeTools(root)
  const planned = await callTool(harness, 'inkflow_project_migrate', { action: 'plan' })
  assert.equal(planned.ok, false)
  assert.equal(planned.error.code, 'NOT_AN_INKFLOW_PROJECT')
  rendered(harness, 'inkflow_project_migrate', { action: 'plan' }, planned)
})
