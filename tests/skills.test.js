/**
 * The writing surface (issue #21): five craft skills + the writing agent preset.
 *
 * Two things are being pinned here:
 *
 *   1. **Capability probes.** A profile may mount this plugin without the Host
 *      `skills` or `agentPresets` service. Absence must produce one log line and
 *      keep every other capability alive — never a throw during `apply()`.
 *   2. **Argument shape.** The registrations are the contract: skill names come
 *      from the packaged files (directory name === frontmatter name), and the
 *      preset is a Cordis composition whose persona names all five skills.
 *
 * The skills are gated on the session working directory being an InkFlow
 * project: that is what keeps five novel-writing skills out of every coding
 * session's catalog. Both sides of the gate are asserted.
 *
 * Everything imports the BUILT bundle (lib/index.js), like the rest of the
 * suite: the tests must exercise what users actually install.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BUNDLED_SKILL_NAMES,
  SKILL_PROVIDER_NAME,
  WRITING_PRESET_ID,
  apply,
  buildWritingPreset,
  bundledSkillsDir,
  createInkflowSkillProvider,
  loadBundledSkills,
  readBundledSkill,
  registerInkflowSkills,
  writingPersona,
} from '../lib/index.js'

const ALL_DIRS = ['chapters', 'characters', 'world', 'outlines', 'index', 'library']

function workdir(prefix = 'inkflow-writing-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** A directory that passes the project gate (git + six dirs + inkflow.json). */
function scaffold(root) {
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, '.git'))
  for (const dir of ALL_DIRS) mkdirSync(join(root, dir), { recursive: true })
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '写作测试' }, null, 2)}\n`, 'utf8')
}

/**
 * Fake Cordis context. `services` is what `ctx.get()` answers for, so a test
 * can install exactly the capabilities under test and nothing else.
 */
function createCtx({ services = {}, tools = true } = {}) {
  const logs = []
  const logLines = []
  const disposes = []
  const ctx = {
    effect(setup) {
      const dispose = setup()
      disposes.push(() => (typeof dispose === 'function' ? dispose() : undefined))
      return () => {}
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    get(serviceName) {
      if (Object.prototype.hasOwnProperty.call(services, serviceName)) return services[serviceName]
      return undefined
    },
    logger() {
      const record = (level) => (message) => {
        const line = String(message)
        logs.push({ level, line })
        logLines.push(line)
      }
      return { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') }
    },
  }
  if (tools) ctx.tools = { register: () => () => {} }
  return { ctx, logs, logLines, disposes }
}

/** Capture the provider a skills service would install. */
function createSkillsService() {
  const captured = { created: 0, provider: undefined, disposed: false, control: undefined }
  return {
    captured,
    service: {
      registerProvider(create) {
        captured.created += 1
        captured.control = { signal: new AbortController().signal, invalidate() {} }
        captured.provider = create(captured.control)
        return () => {
          captured.disposed = true
        }
      },
    },
  }
}

/** Capture the declaration a preset registry would activate. */
function createPresetService() {
  const captured = { definitions: [], disposed: false, disposeCalls: 0 }
  return {
    captured,
    service: {
      register(definition) {
        captured.definitions.push(definition)
        return Promise.resolve(async () => {
          captured.disposeCalls += 1
          captured.disposed = true
        })
      },
    },
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

// ── capability probes ───────────────────────────────────────────────────────

test('apply() without skills or agentPresets services logs one line each and keeps the tools', () => {
  const root = workdir()
  try {
    scaffold(root)
    const { ctx, logLines } = createCtx()
    apply(ctx, { dataDir: join(root, '.dsh-state'), serveHttp: false })

    assert.equal(
      logLines.filter((line) => line.includes('skills service missing')).length,
      1,
      'a missing skills service must be reported exactly once',
    )
    assert.equal(
      logLines.filter((line) => line.includes('agentPresets service missing')).length,
      1,
      'a missing agentPresets service must be reported exactly once',
    )
    // Everything else still runs: tools are registered by the same apply().
    assert.ok(
      logLines.some((line) => line.includes('inkflow_* tools registered')),
      'the tool surface must survive a missing writing capability',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a skills service of the wrong shape degrades like a missing one', () => {
  const root = workdir()
  try {
    scaffold(root)
    const { ctx, logLines } = createCtx({ services: { skills: { register() {} } } })
    apply(ctx, { dataDir: join(root, '.dsh-state'), serveHttp: false })
    assert.ok(logLines.some((line) => line.includes('skills service missing')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a throwing skills service is contained: the tools still register', () => {
  const root = workdir()
  try {
    scaffold(root)
    const skills = {
      registerProvider() {
        throw new Error('a skill provider named "inkflow" is already registered')
      },
    }
    const { ctx, logLines } = createCtx({ services: { skills } })
    apply(ctx, { dataDir: join(root, '.dsh-state'), serveHttp: false })
    assert.ok(
      logLines.some((line) => line.includes('writing surface skipped: a skill provider named "inkflow"')),
      'the rejection must be reported, not swallowed silently',
    )
    assert.ok(logLines.some((line) => line.includes('inkflow_* tools registered')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── skills ──────────────────────────────────────────────────────────────────

test('the provider offers exactly the five packaged skills inside an InkFlow project', async () => {
  const root = workdir()
  const project = join(root, 'book')
  try {
    scaffold(project)
    const { ctx, disposes } = createCtx({ services: {} })
    const skills = createSkillsService()
    ctx.get = (serviceName) => (serviceName === 'skills' ? skills.service : undefined)

    const result = registerInkflowSkills(ctx, { dir: join(root, 'missing-skills'), log: ctx.logger('test') })
    // A package shipped without skills/ must not register an empty catalog and
    // must not throw: the plugin keeps working, the log says why.
    assert.equal(result.registered, false, 'a missing skills/ directory must not register anything')
    assert.equal(result.problems.length, 5)

    const realDir = fileURLToDirOfRepo()
    const registered = registerInkflowSkills(ctx, { dir: realDir, log: ctx.logger('test') })
    assert.equal(registered.registered, true)
    assert.deepEqual(registered.names, [...BUNDLED_SKILL_NAMES])
    assert.equal(skills.captured.created, 1, 'registerProvider must be called once')
    assert.equal(skills.captured.provider.name, SKILL_PROVIDER_NAME)
    assert.notEqual(SKILL_PROVIDER_NAME, 'runtime', '"runtime" is reserved by the registry')

    const candidates = await skills.captured.provider.list({ cwd: project })
    assert.equal(candidates.length, 5)
    assert.deepEqual(
      candidates.map((candidate) => candidate.name).sort(),
      [...BUNDLED_SKILL_NAMES].sort(),
    )
    for (const candidate of candidates) {
      assert.equal(candidate.provider, SKILL_PROVIDER_NAME, 'must match the provider name or the registry throws')
      assert.equal(candidate.source, 'bundled')
      assert.ok(candidate.description.length > 0, `${candidate.name} needs a description`)
      assert.equal(candidate.invocation.modelInvocable, true)
      assert.equal(candidate.invocation.userInvocable, true)
      assert.equal(typeof candidate.rank, 'number')
      assert.equal(candidate.resourceBase.kind, 'directory')
      assert.ok(existsSync(candidate.resourceBase.path), 'resource base must be a real directory')
      const definition = await skills.captured.provider.get(candidate)
      assert.equal(definition.name, candidate.name, 'get() must answer for the candidate it was handed')
      assert.ok(definition.content.length > 200, `${candidate.name} body must carry real instructions`)
      assert.equal(definition.content.startsWith('---'), false, 'frontmatter must be stripped from the body')
      assert.ok(definition.content.startsWith('# '), `${candidate.name} body must open with its title`)
    }

    // The provider is owned by ctx.effect: unloading disposes it.
    assert.equal(disposes.length > 0, true)
    for (const dispose of disposes) dispose()
    assert.equal(skills.captured.disposed, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skills stay out of the catalog outside an InkFlow project', async () => {
  const root = workdir()
  try {
    const bare = join(root, 'not-a-book')
    mkdirSync(bare)
    const skills = loadBundledSkills(fileURLToDirOfRepo())
    const provider = createInkflowSkillProvider({ skills: skills.skills })

    assert.deepEqual(await provider.list({ cwd: bare }), [])
    assert.deepEqual(await provider.list({}), [], 'no cwd means no workspace claim')
    // A project directory is recognized when the session sits in a subdirectory.
    const project = join(root, 'book')
    scaffold(project)
    const nested = join(project, 'chapters')
    assert.equal((await provider.list({ cwd: nested })).length, 5)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('every packaged SKILL.md has a unique kebab-case name and a real body', () => {
  const dir = fileURLToDirOfRepo()
  const { skills, problems } = loadBundledSkills(dir)
  assert.deepEqual(problems, [], 'all five skill files must load')
  assert.equal(skills.length, 5)

  const names = skills.map((skill) => skill.name)
  assert.equal(new Set(names).size, 5, 'skill names must be unique')
  assert.deepEqual(names, [...BUNDLED_SKILL_NAMES], 'BUNDLED_SKILL_NAMES is the pipeline order')

  for (const skill of skills) {
    assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    assert.equal(skill.path, join(dir, skill.name, 'SKILL.md'))
    assert.ok(skill.description.length > 10 && skill.description.length < 200, `${skill.name}: description is a catalog line`)
    assert.ok(!skill.description.includes('\n'), `${skill.name}: description must stay on one line`)
    assert.ok(skill.content.split('\n').length > 20, `${skill.name}: body must carry a real procedure`)
    for (const heading of ['输入', '检查项', '常见坑']) {
      assert.ok(skill.content.includes(heading), `${skill.name}: craft skill needs a "${heading}" section`)
    }
  }
})

test('no skill teaches CLI or HTTP usage (issue #21 acceptance)', () => {
  const dir = fileURLToDirOfRepo()
  const { skills } = loadBundledSkills(dir)
  const forbidden = ['http://', 'https://', 'curl ', 'X-InkFlow-Token', 'inkflow-ctl', 'POST /api', 'Authorization:']
  for (const skill of skills) {
    for (const needle of forbidden) {
      assert.equal(
        skill.content.includes(needle),
        false,
        `${skill.name} must not reference "${needle}": skills teach craft, not transports`,
      )
    }
  }
})

test('a broken skill file is reported as a problem, not thrown', () => {
  const root = workdir()
  try {
    const skillsDir = join(root, 'skills')
    mkdirSync(join(skillsDir, 'inkflow-writer'), { recursive: true })
    // Directory name and frontmatter name disagree: exactly the stale-rename bug.
    writeFileSync(
      join(skillsDir, 'inkflow-writer', 'SKILL.md'),
      '---\nname: something-else\ndescription: x\n---\n\nbody\n',
      'utf8',
    )
    const { skills, problems } = loadBundledSkills(skillsDir, ['inkflow-writer', 'inkflow-architect'])
    assert.equal(skills.length, 0)
    assert.equal(problems.length, 2)
    assert.ok(problems.some((problem) => problem.message.includes('is stale')))
    assert.ok(problems.some((problem) => problem.message.includes('cannot read')))
    assert.throws(() => readBundledSkill(skillsDir, 'inkflow-writer'), /is stale/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── preset ──────────────────────────────────────────────────────────────────

test('apply() registers one writing preset that names all five skills', async () => {
  const root = workdir()
  try {
    scaffold(root)
    const skills = createSkillsService()
    const presets = createPresetService()
    const { ctx, disposes } = createCtx({ services: { skills: skills.service, agentPresets: presets.service } })
    apply(ctx, { dataDir: join(root, '.dsh-state'), serveHttp: false })
    await tick()

    assert.equal(presets.captured.definitions.length, 1, 'exactly one preset per apply')
    const definition = presets.captured.definitions[0]
    assert.equal(definition.id, WRITING_PRESET_ID)
    assert.equal(definition.name, 'InkFlow 写作')
    assert.equal(typeof definition.order, 'number')
    assert.ok(definition.description.includes('架构'))

    const personaRow = definition.plugins[0]
    assert.equal(personaRow.name, '@deepseek-ai/dsh-persona')
    for (const skillName of BUNDLED_SKILL_NAMES) {
      assert.ok(personaRow.config.prefix.includes(skillName), `persona must name ${skillName}`)
    }
    assert.ok(personaRow.config.prefix.includes('inkflow_'), 'persona must point at the inkflow_* tools')

    // A composition, not a list of skill names: rows mount plugins.
    const rowNames = definition.plugins.map((row) => row.name)
    assert.equal(rowNames.length, new Set(rowNames).size, 'row names must be unique')
    for (const row of definition.plugins) {
      assert.ok(row.name.startsWith('@deepseek-ai/dsh-'), `${row.name} is not a Host plugin specifier`)
    }
    const rowIds = definition.plugins.map((row) => row.id)
    assert.equal(rowIds.length, new Set(rowIds).size, 'row ids must be unique')
    assert.ok(rowNames.includes('@deepseek-ai/dsh-tool-skill'), 'the catalog must be reachable from the preset')
    assert.ok(rowNames.includes('@deepseek-ai/dsh-tool-fs'), 'a writing session must be able to read files')
    assert.equal(
      rowNames.some((row) => row.includes('tool-bash') || row.includes('tool-pwsh')),
      false,
      'an author-facing writing session gets no shell',
    )

    // Unload disposes the definition the registry handed back.
    for (const dispose of disposes) dispose()
    await tick()
    assert.equal(presets.captured.disposeCalls, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a rejected preset registration is logged and does not take the plugin down', async () => {
  const root = workdir()
  try {
    scaffold(root)
    const presets = {
      register() {
        return Promise.reject(new Error('row not found: tool-missing'))
      },
    }
    const { ctx, logLines } = createCtx({ services: { agentPresets: presets } })
    apply(ctx, { dataDir: join(root, '.dsh-state'), serveHttp: false })
    await tick()
    assert.ok(logLines.some((line) => line.includes('could not be registered: row not found: tool-missing')))
    assert.ok(logLines.some((line) => line.includes('inkflow_* tools registered')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the preset persona describes the five stages in order', () => {
  const persona = writingPersona([...BUNDLED_SKILL_NAMES])
  const positions = BUNDLED_SKILL_NAMES.map((name) => persona.indexOf(name))
  assert.equal(positions.some((index) => index < 0), false)
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right), 'stages must appear in pipeline order')
  assert.ok(persona.includes('NOT_AN_INKFLOW_PROJECT'), 'the persona must explain the gate failure it can meet')
  assert.ok(persona.includes('不做') || persona.includes('不擅自'), 'the persona must state a scope limit')
})

test('buildWritingPreset tolerates a missing skill list', () => {
  const definition = buildWritingPreset([])
  assert.equal(definition.id, WRITING_PRESET_ID)
  assert.ok(definition.plugins[0].config.prefix.includes('架构'))
  assert.equal(definition.plugins[0].config.prefix.includes('`undefined`'), false)
})

/** `<repo>/skills`, resolved from the test file (tests/ sits beside skills/). */
function fileURLToDirOfRepo() {
  return join(import.meta.dirname, '..', 'skills')
}

// Keep the import list honest: the package ships skills/, so the directory the
// bundle resolves to must be the one the tests read.
test('the bundle resolves the same skills directory the tests read', () => {
  const fromBundle = bundledSkillsDir(new URL('../lib/index.js', import.meta.url).href)
  assert.equal(fromBundle, fileURLToDirOfRepo())
  assert.ok(readFileSync(join(fromBundle, 'inkflow-writer', 'SKILL.md'), 'utf8').length > 0)
})
