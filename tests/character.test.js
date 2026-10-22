/**
 * Character cards (issue #25) — the character domain's write side, card fields and
 * the project-wide name rule (data-model.md §3, §5 I-03).
 *
 * What is pinned here, and why each row can FAIL:
 *   1. the eight card fields round-trip file → index → tool (a dropped field is a
 *      dropped column, a dropped parse branch or a dropped projection line);
 *   2. a card missing a field the dictionary requires is reported with a specific
 *      code, not silently defaulted (the `name` fallback to the file name is a
 *      convenience for the row, not a licence to skip the field);
 *   3. I-03 is enforced on **both** sides — `planCharacterUpsert()` refuses before
 *      the write, and a rebuild reports `CHARACTER_NAME_DUPLICATE`. An alias that
 *      collides with another card is the same collision: every mention is
 *      ambiguous, whether it is spelled as a name or an alias;
 *   4. a refusal leaves the project byte-identical (hash unchanged, no new file);
 *   5. per-chapter states are queryable ("what was he at chapter 30").
 *
 * Runs against the BUILT artifact (`lib/index.js`), like every other suite.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, planCharacterUpsert } from '../lib/index.js'

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const ALL_DIRS = [...CONTENT_DIRS, 'index']
const KEEP = '.gitkeep'

// ---------------------------------------------------------------------------
// Harness (same shape as the other contract suites)
// ---------------------------------------------------------------------------

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

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-character-'))
}

function makeTools(dataDir, workspace) {
  const harness = createHarness(workspace)
  apply(harness.ctx, { dataDir })
  return harness
}

async function callTool(harness, toolName, args) {
  const tool = harness.tools.get(toolName)
  assert.ok(tool, `tool ${toolName} must be registered`)
  return tool.execute(args, { signal: AbortSignal.timeout(15000), agent: { id: 'test-session' } })
}

/** A usable book: real `.git`, ten directories with `.gitkeep`, meta, ignore rules. */
function project(root) {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of ALL_DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, KEEP), '', 'utf8')
  }
  writeFileSync(join(root, '.gitignore'), '# InkFlow derived index\nindex/*.db\nindex/*.db-wal\nindex/*.db-shm\n', 'utf8')
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '角色之书' }, null, 2)}\n`, 'utf8')
  return root
}

/** Write a markdown file, `frontmatter` being the lines between the `---` pair. */
function markdown(root, relativePath, frontmatter = [], body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = frontmatter.length > 0 ? `---\n${frontmatter.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

function hashOf(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function rebuild(harness, root) {
  const result = await callTool(harness, 'inkflow_index_rebuild', { projectRoot: root })
  assert.equal(result.ok, true, `the rebuild must always succeed: ${JSON.stringify(result.error)}`)
  return result
}

function codesOf(result) {
  return result.issues.map((issue) => issue.code)
}

function issueOf(result, code, path) {
  const found = result.issues.filter((issue) => issue.code === code && (path === undefined || issue.path === path))
  assert.equal(found.length, 1, `expected exactly one ${code}${path === undefined ? '' : ` at ${path}`}, got ${JSON.stringify(result.issues)}`)
  return found[0]
}

async function listCharacters(harness, root, args = {}) {
  const result = await callTool(harness, 'inkflow_character_list', { projectRoot: root, ...args })
  assert.equal(result.ok, true, `character list must succeed: ${JSON.stringify(result.error)}`)
  return result
}

async function upsert(harness, root, args) {
  return callTool(harness, 'inkflow_character_upsert', { projectRoot: root, confirm: true, ...args })
}

// ---------------------------------------------------------------------------
// The eight card fields (data-model.md §3 + conventions.md §3.3)
// ---------------------------------------------------------------------------

const FULL_CARD = {
  name: '清音',
  aliases: ['青音', '清音仙子'],
  group: '白鹤门',
  role: '主角',
  pov: '第三人称限知',
  firstAppearance: 1,
  voice: ['句式：短句，平均十二字', '用词：古白话，不用现代词'],
  states: [
    { chapter: 1, status: '初入门墙' },
    { chapter: 30, status: '代掌门' },
  ],
}

function assertFullCard(card) {
  assert.equal(card.name, FULL_CARD.name)
  assert.deepEqual(card.aliases, FULL_CARD.aliases)
  assert.equal(card.group, FULL_CARD.group)
  assert.equal(card.role, FULL_CARD.role)
  assert.equal(card.pov, FULL_CARD.pov)
  assert.equal(card.firstAppearance, FULL_CARD.firstAppearance)
  assert.deepEqual(card.voice, FULL_CARD.voice)
  assert.deepEqual(card.states, FULL_CARD.states)
}

test('the eight card fields are written to the file and read back through the index', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    const harness = makeTools(join(dir, 'state'), dir)

    const written = await upsert(harness, root, { ...FULL_CARD, body: '性格：寡言，认死理。' })
    assert.equal(written.ok, true, JSON.stringify(written.error))
    assert.equal(written.created, true)
    assert.equal(written.path, 'characters/清音.md')
    assertFullCard(written.character)

    // The file is the truth: the block form is what a hand editor sees.
    const text = readFileSync(join(root, 'characters', '清音.md'), 'utf8')
    assert.match(text, /^name: 清音$/mu)
    assert.match(text, /^group: 白鹤门$/mu)
    assert.match(text, /^states:$/mu)
    assert.match(text, /^ {2}- 30: 代掌门$/mu)
    assert.match(text, /性格：寡言，认死理。/u)

    // ...and the card survives a full rebuild → index → query round trip.
    await rebuild(harness, root)
    const listed = await listCharacters(harness, root)
    assert.equal(listed.total, 1)
    assertFullCard(listed.items[0])
    assert.equal(listed.items[0].path, 'characters/清音.md')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a card without a name is reported as CHARACTER_NAME_REQUIRED, not silently named after its file', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    markdown(root, 'characters/无名.md', ['id: char-1', 'group: 门派'], '没有 name 的卡片。')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    const issue = issueOf(result, 'CHARACTER_NAME_REQUIRED', 'characters/无名.md')
    assert.match(issue.detail, /name/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a non-integer firstAppearance is reported as CHARACTER_FIRST_APPEARANCE_INVALID', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    markdown(root, 'characters/清音.md', ['id: char-1', 'name: 清音', 'firstAppearance: 第一章'], '出场写成了章名。')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    const issue = issueOf(result, 'CHARACTER_FIRST_APPEARANCE_INVALID', 'characters/清音.md')
    assert.match(issue.detail, /firstAppearance/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a state entry without a chapter is reported as CHARACTER_STATE_INVALID', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    markdown(root, 'characters/清音.md', ['id: char-1', 'name: 清音', 'states:', '  - 后记很惨'], '状态条格式不对。')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    const issue = issueOf(result, 'CHARACTER_STATE_INVALID', 'characters/清音.md')
    assert.match(issue.detail, /chapter/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two states for the same chapter are reported as CHARACTER_STATE_INVALID', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    markdown(root, 'characters/清音.md', ['id: char-1', 'name: 清音', 'states:', '  - 1: 入门', '  - 1: 出师'], '同一章两个状态。')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    const issue = issueOf(result, 'CHARACTER_STATE_INVALID', 'characters/清音.md')
    assert.match(issue.detail, /duplicates/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// I-03 — the name (and every alias) is unique across the project
// ---------------------------------------------------------------------------

test('planCharacterUpsert refuses a name another card already uses', () => {
  const plan = planCharacterUpsert({
    name: '清 音',
    existing: [{ path: 'characters/清音.md', name: '清音', aliases: [] }],
  })
  assert.equal(plan.ok, false)
  assert.equal(plan.code, 'CHARACTER_NAME_DUPLICATE')
  assert.equal(plan.conflictPath, 'characters/清音.md')
})

test('planCharacterUpsert allows the same card to rewrite its own name', () => {
  const plan = planCharacterUpsert({
    name: '清音',
    path: 'characters/清音.md',
    existing: [{ path: 'characters/清音.md', name: '清音', aliases: [] }],
  })
  assert.equal(plan.ok, true)
  assert.equal(plan.nameKey, '清音')
})

test('planCharacterUpsert refuses an alias that is another card name or alias', () => {
  const existing = [{ path: 'characters/清音.md', name: '清音', aliases: ['青音'] }]

  const nameCollision = planCharacterUpsert({ name: '玄真', aliases: ['清 音'], existing })
  assert.equal(nameCollision.ok, false)
  assert.equal(nameCollision.code, 'CHARACTER_ALIAS_DUPLICATE')
  assert.equal(nameCollision.conflictPath, 'characters/清音.md')

  const aliasCollision = planCharacterUpsert({ name: '玄真', aliases: ['青音'], existing })
  assert.equal(aliasCollision.ok, false)
  assert.equal(aliasCollision.code, 'CHARACTER_ALIAS_DUPLICATE')

  assert.equal(planCharacterUpsert({ name: '玄真', aliases: ['真武'], existing }).ok, true)
})

test('planCharacterUpsert refuses an empty name', () => {
  const plan = planCharacterUpsert({ name: '   ', existing: [] })
  assert.equal(plan.ok, false)
  assert.equal(plan.code, 'CHARACTER_NAME_REQUIRED')
})

test('the write side refuses a duplicate name and leaves the project byte-identical', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    markdown(root, 'characters/清音.md', ['id: char-1', 'name: 清音'], '原始卡片。')
    const before = hashOf(join(root, 'characters', '清音.md'))
    const harness = makeTools(join(dir, 'state'), dir)

    // An explicit path is what makes this a *second* card: with the same path the
    // upsert would treat "清 音" as the very card it is editing (see the update test).
    const refused = await upsert(harness, root, { name: '清 音', role: '主角', path: 'characters/清音-别名.md' })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'CHARACTER_NAME_DUPLICATE')
    assert.equal(refused.error.path, 'characters/清音.md')

    assert.equal(hashOf(join(root, 'characters', '清音.md')), before, 'a refusal must not rewrite the other card')
    assert.deepEqual(readdirSync(join(root, 'characters')).sort(), ['.gitkeep', '清音.md'], 'no new file may appear')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the write side refuses an alias that equals another card name', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    markdown(root, 'characters/清音.md', ['id: char-1', 'name: 清音'], '原始卡片。')
    const before = hashOf(join(root, 'characters', '清音.md'))
    const harness = makeTools(join(dir, 'state'), dir)

    const refused = await upsert(harness, root, { name: '玄真', aliases: ['清音'] })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'CHARACTER_ALIAS_DUPLICATE')
    assert.equal(refused.error.path, 'characters/清音.md')
    assert.equal(hashOf(join(root, 'characters', '清音.md')), before)
    assert.deepEqual(readdirSync(join(root, 'characters')).sort(), ['.gitkeep', '清音.md'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a rebuild reports CHARACTER_NAME_DUPLICATE for two cards with the same normalised name', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    markdown(root, 'characters/a-清音.md', ['id: char-1', 'name: 清音'], '本体。')
    markdown(root, 'characters/b-清音-空格.md', ['id: char-2', 'name: "清 音"'], '同名。')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    // First file in walk order wins, so the later card is the one reported.
    const issue = issueOf(result, 'CHARACTER_NAME_DUPLICATE', 'characters/b-清音-空格.md')
    assert.match(issue.detail, /already used by characters\/a-清音\.md/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a rebuild treats an alias equal to another card name as CHARACTER_NAME_DUPLICATE', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    markdown(root, 'characters/清音.md', ['id: char-1', 'name: 清音'], '本体。')
    markdown(root, 'characters/玄真.md', ['id: char-2', 'name: 玄真', 'aliases: [清音]'], '用了别人的名字当别名。')
    const harness = makeTools(join(dir, 'state'), dir)

    const result = await rebuild(harness, root)
    const issue = issueOf(result, 'CHARACTER_NAME_DUPLICATE', 'characters/玄真.md')
    assert.match(issue.detail, /already used by characters\/清音\.md/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Group, filters and the upsert-update path
// ---------------------------------------------------------------------------

test('inkflow_character_list filters by group and by a name/alias fragment', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    const harness = makeTools(join(dir, 'state'), dir)
    await upsert(harness, root, { name: '清音', group: '白鹤门', aliases: ['青音'] })
    await upsert(harness, root, { name: '赵横', group: '黑风寨' })

    const all = await listCharacters(harness, root)
    assert.equal(all.total, 2)

    const sect = await listCharacters(harness, root, { group: '白鹤门' })
    assert.deepEqual(sect.items.map((item) => item.name), ['清音'])

    const byName = await listCharacters(harness, root, { query: '清' })
    assert.deepEqual(byName.items.map((item) => item.name), ['清音'])

    const byAlias = await listCharacters(harness, root, { query: '青音' })
    assert.deepEqual(byAlias.items.map((item) => item.name), ['清音'])

    const missing = await listCharacters(harness, root, { query: '没有这个人' })
    assert.equal(missing.total, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('upserting an existing name updates that card instead of creating a second one', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    const harness = makeTools(join(dir, 'state'), dir)

    const created = await upsert(harness, root, { name: '清音', group: '白鹤门', role: '配角' })
    assert.equal(created.created, true)

    const updated = await upsert(harness, root, { name: '清音', group: '云水观', role: '主角' })
    assert.equal(updated.ok, true, JSON.stringify(updated.error))
    assert.equal(updated.created, false)
    assert.equal(updated.path, 'characters/清音.md')
    assert.deepEqual(updated.changed.sort(), ['group', 'role'])
    assert.equal(updated.character.group, '云水观')

    const listed = await listCharacters(harness, root)
    assert.equal(listed.total, 1)
    assert.equal(listed.items[0].group, '云水观')
    assert.equal(listed.items[0].role, '主角')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('updating a card rewrites its list fields in place, keeping the rest of the file', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    // A hand-written card with a comment, an unknown field and a stale alias list.
    markdown(
      root,
      'characters/清音.md',
      ['id: char-1', 'name: 清音', 'aliases: 青音, 旧名   # 别人怎么叫她', 'mood: 冷', 'states:', '  - 1: 初入门墙'],
      '性格：寡言。',
    )
    const harness = makeTools(join(dir, 'state'), dir)

    const updated = await upsert(harness, root, {
      name: '清音',
      aliases: ['青音', '清音仙子'],
      voice: ['句式：短句'],
      states: [
        { chapter: 1, status: '初入门墙' },
        { chapter: 30, status: '代掌门' },
      ],
    })
    assert.equal(updated.ok, true, JSON.stringify(updated.error))
    assert.equal(updated.created, false)
    assert.deepEqual(updated.changed.sort(), ['aliases', 'states', 'voice'])
    assert.deepEqual(updated.character.aliases, ['青音', '清音仙子'])

    const text = readFileSync(join(root, 'characters', '清音.md'), 'utf8')
    assert.equal(text.includes('旧名'), false, 'the replaced alias list leaves nothing behind')
    assert.equal(text.includes('mood: 冷'), true, 'unknown fields are preserved')
    assert.equal(text.includes('# 别人怎么叫她'), true, 'the author comment survives the rewrite')
    assert.equal(text.includes('性格：寡言。'), true, 'the body is untouched')
    assert.match(text, /^ {2}- 30: 代掌门$/mu)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('updating a card with no frontmatter block adds one and keeps the prose', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    // A hand-written note file: prose only, no block yet.
    markdown(root, 'characters/清音.md', [], '性格：寡言，认死理。\n')
    const harness = makeTools(join(dir, 'state'), dir)

    const updated = await upsert(harness, root, { name: '清音', group: '白鹤门' })
    assert.equal(updated.ok, true, JSON.stringify(updated.error))
    assert.equal(updated.created, false)

    const text = readFileSync(join(root, 'characters', '清音.md'), 'utf8')
    assert.match(text, /^---$/mu)
    assert.match(text, /^name: 清音$/mu)
    assert.match(text, /^group: 白鹤门$/mu)
    assert.match(text, /性格：寡言，认死理。/u, 'the existing prose survives')
    assert.equal(updated.character.group, '白鹤门')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Per-chapter states — "what was he at chapter 30"
// ---------------------------------------------------------------------------

test('inkflow_character_list answers the state in force at a given chapter', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    const harness = makeTools(join(dir, 'state'), dir)
    await upsert(harness, root, {
      name: '清音',
      states: [
        { chapter: 1, status: '初入门墙' },
        { chapter: 30, status: '代掌门' },
        { chapter: 80, status: '卸任远游' },
      ],
    })

    const at29 = await listCharacters(harness, root, { chapter: 29 })
    assert.deepEqual(at29.items[0].state, { chapter: 1, status: '初入门墙' })

    const at30 = await listCharacters(harness, root, { chapter: 30 })
    assert.deepEqual(at30.items[0].state, { chapter: 30, status: '代掌门' })

    const at120 = await listCharacters(harness, root, { chapter: 120 })
    assert.deepEqual(at120.items[0].state, { chapter: 80, status: '卸任远游' })

    const beforeFirst = await listCharacters(harness, root, { chapter: 0 })
    assert.equal(beforeFirst.items[0].state, null, 'before the first recorded state nothing is in force')

    const noChapter = await listCharacters(harness, root)
    assert.equal(noChapter.items[0].state, null, 'no chapter asked, no in-force state reported')
    assert.equal(noChapter.items[0].states.length, 3, 'every recorded state is still listed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Confirm discipline
// ---------------------------------------------------------------------------

test('inkflow_character_upsert refuses to write without confirm: true', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    const harness = makeTools(join(dir, 'state'), dir)

    const refused = await callTool(harness, 'inkflow_character_upsert', { projectRoot: root, name: '清音' })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'CONFIRM_REQUIRED')
    assert.deepEqual(readdirSync(join(root, 'characters')), ['.gitkeep'], 'nothing may be written without confirm')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// A list item is one line (D-6)
// ---------------------------------------------------------------------------

/**
 * `aliases`, `voice` and a state's `status` all end up as `- item` lines, and
 * `frontmatterListItem()` throws on `\n`/`\r`. The throw happens after the write
 * lock is taken, so before this rule the model got `IO_FAILED` — "the disk failed"
 * for a project nothing had touched — with no way to tell which field was wrong.
 * Refused at the argument, the answer is data and the file is never opened.
 */
test('a line break in a list item is refused as CHARACTER_FIELD_INVALID and nothing is written', async () => {
  const dir = workdir()
  try {
    const root = project(join(dir, 'book'))
    const harness = makeTools(join(dir, 'state'), dir)

    const created = await upsert(harness, root, { name: '清音', voice: ['句式：短句'] })
    assert.equal(created.ok, true, `the fixture card must exist first: ${JSON.stringify(created.error)}`)
    const cardPath = join(root, 'characters', '清音.md')
    const before = hashOf(cardPath)

    const cases = [
      ['voice', { voice: ['句式：短句', '用词：古白话\n不用现代词'] }],
      ['aliases', { aliases: ['青音\n清音仙子'] }],
      ['states', { states: [{ chapter: 30, status: '代掌门\n兼掌门印' }] }],
    ]
    for (const [field, patch] of cases) {
      const refused = await upsert(harness, root, { name: '清音', ...patch })
      assert.equal(refused.ok, false, `${field}: a line break must be refused`)
      assert.equal(
        refused.error.code,
        'CHARACTER_FIELD_INVALID',
        `${field}: the refusal must name the field, not report an IO failure`,
      )
      assert.match(refused.error.message, /line break/u, `${field}: the message must say what is wrong`)
      assert.equal(hashOf(cardPath), before, `${field}: a refused write leaves the card byte-identical`)
      assert.deepEqual(readdirSync(join(root, 'characters')).sort(), ['.gitkeep', '清音.md'], `${field}: no stray file`)
    }

    // The create path takes the same check, before `characters/` is touched at all.
    const refusedNew = await upsert(harness, root, { name: '静水', voice: ['语速：慢\n停顿多'] })
    assert.equal(refusedNew.ok, false)
    assert.equal(refusedNew.error.code, 'CHARACTER_FIELD_INVALID')
    assert.deepEqual(
      readdirSync(join(root, 'characters')).sort(),
      ['.gitkeep', '清音.md'],
      'a refused create writes no card',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// One resolver for both halves (D-4)
// ---------------------------------------------------------------------------

test('a character tool answers the same gate refusal a built-in tool does', async () => {
  // The character tools used to carry their own copy of `resolveProject()` /
  // `gateFailure()`, and the two copies had already drifted. Both halves now import
  // `domains/tool-project.ts`; this pins the visible half of that — same code, same
  // state, same checklist, same root. (`error.build` is still attached by
  // `withBuild()` in `tools.ts` only, so a domain refusal carries no stamp; that
  // asymmetry is unchanged on purpose in this branch.)
  const dir = workdir()
  try {
    const root = join(dir, 'not-a-book')
    mkdirSync(root, { recursive: true })
    const harness = makeTools(join(dir, 'state'), root)

    const builtin = await callTool(harness, 'inkflow_project_status', { projectRoot: root })
    const character = await callTool(harness, 'inkflow_character_list', { projectRoot: root })

    assert.equal(builtin.ok, false)
    assert.equal(character.ok, false)
    assert.equal(character.error.code, builtin.error.code, 'both halves must answer the same refusal code')
    assert.equal(character.error.state, builtin.error.state, 'same gate state')
    assert.equal(character.error.root, builtin.error.root, 'same resolved root')
    assert.deepEqual(character.error.missing, builtin.error.missing, 'same missing-item checklist')
    assert.deepEqual(character.error.actions, builtin.error.actions, 'same wizard actions')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
