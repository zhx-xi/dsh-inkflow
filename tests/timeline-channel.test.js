/**
 * The timeline pane's private channel: `GET /timeline` and `POST /timeline/upsert`.
 *
 * What each block is for, so a failure names the promise that broke:
 *
 *   1. **同一条数据，同一个答案** — the read route and `inkflow_timeline_list` are compared
 *      FIELD BY FIELD on the same book. The page must never show an order the model-facing
 *      surface would not report, and a second projection of the timeline is exactly how the
 *      two start to disagree. This is the block that fails when somebody "improves" one side.
 *   2. **倒叙不是错误** — a scene told later that happens earlier has both numbers on it, so
 *      the pane can show the crossing without the data being refused.
 *   3. **拒绝码与工具同一套** — the write route answers with the codes `planTimelineUpsert`
 *      produces, compared against what the tool answers for the same args.
 *   4. **零写盘的闸门** — no `confirm: true`, nothing on disk; the same args twice are an
 *      overwrite with byte-identical output (an edit must not churn the file).
 *   5. **未知字段是 400** — the route declares its query/body keys, and the dispatcher
 *      refuses anything else instead of silently ignoring it.
 *   6. **日历与工具同源** — the era table the form hints with is the table
 *      `inkflow_calendar_get` reads, not a second reading of `inkflow.json`.
 *
 * Runs against the built artifacts (`lib/index.js`) through the panel channel, like the
 * other channel contracts: one fake request at a time.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, domainTools } from '../lib/index.js'
import { createStateDir } from './state-dir.mjs'

const HOST = '127.0.0.1:2261'
const ORIGIN = `http://${HOST}`
const INTERNAL = '/inkflow/internal'
const JSON_TYPE = 'application/json'
const DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']

// ---------------------------------------------------------------------------
// Harness (same shape as the other channel contracts)
// ---------------------------------------------------------------------------

const STATE_DIR = createStateDir('inkflow-timeline-channel-state')

function createHarness({ sessionId = 'session-1', workspace } = {}) {
  const routes = []
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
      if (name === 'sessions') {
        return {
          get(id) {
            return id === sessionId ? { id, header: { cwd: workspace } } : undefined
          },
        }
      }
      if (name === 'workingDirectory') {
        return {
          get(session) {
            return session?.header?.cwd ?? workspace
          },
        }
      }
      return undefined
    },
    logger() {
      return { debug() {}, info() {}, warn() {}, error() {} }
    },
    tools: {
      register() {
        return () => {}
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  apply(ctx, { dataDir: STATE_DIR })
  return { ctx, routes }
}

function fakeRequest({ url, method = 'GET', host = HOST, origin, remoteAddress = '127.0.0.1', body, contentType = JSON_TYPE } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  const request = { url, method, headers, socket: { remoteAddress } }
  if (body === undefined) return request
  const buffer = Buffer.from(body, 'utf8')
  headers['content-length'] = String(buffer.length)
  if (contentType !== null && buffer.length > 0) headers['content-type'] = contentType
  request[Symbol.asyncIterator] = async function* iterate() {
    if (buffer.length > 0) yield buffer
  }
  return request
}

function fakeResponse() {
  const response = {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(key, value) {
      response.headers[key] = value
    },
    end(payload) {
      response.body = payload
    },
  }
  return response
}

async function callRoute(harness, request) {
  const route = harness.routes.find((entry) => entry.path === '/inkflow')
  assert.ok(route, 'expected a /inkflow prefix route')
  const response = fakeResponse()
  await route.handler(request, response)
  return {
    status: response.statusCode,
    headers: response.headers,
    json: response.body === undefined ? undefined : JSON.parse(response.body),
  }
}

function withSession(path, sessionId) {
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}sessionId=${encodeURIComponent(sessionId)}`
}

function read(harness, path, options = {}) {
  return callRoute(harness, fakeRequest({ url: `${INTERNAL}${withSession(path, options.sessionId ?? 'session-1')}`, ...options }))
}

function post(harness, path, payload, options = {}) {
  return callRoute(
    harness,
    fakeRequest({
      origin: ORIGIN,
      ...options,
      url: `${INTERNAL}${withSession(path, options.sessionId ?? 'session-1')}`,
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  )
}

function callTool(name, args) {
  const tool = domainTools().find((candidate) => candidate.name === name)
  assert.ok(tool, `${name} must be registered by a domain module`)
  return tool.execute(args, { signal: new AbortController().signal, callId: 'timeline-channel-test' })
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-timeline-channel-'))
}

function scaffold(root) {
  mkdirSync(root, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (const dir of DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '时间线通道' }, null, 2)}\n`, 'utf8')
}

function writeEvent(root, name, frontmatter, body = '') {
  const absolute = join(root, 'timeline', `${name}.md`)
  writeFileSync(absolute, `---\n${frontmatter.join('\n')}\n---\n\n${body}`, 'utf8')
  return `timeline/${name}.md`
}

/**
 * Three events whose two orders deliberately disagree: told in world order 2 → 3 → 1,
 * i.e. the third one is a recall of the earliest scene (a legal flashback).
 */
function sampleBook(root) {
  scaffold(root)
  writeEvent(root, '丙辰夜袭', [
    'id: t-3',
    'title: 丙辰夜袭',
    'worldTime: 1710-02-01',
    'narrativeOrder: 2',
    'chapterId: c-2',
    'participants: [c-a, c-b]',
  ])
  writeEvent(root, '甲申立约', ['id: t-1', 'title: 甲申立约', 'worldTime: 1710-01-05', 'narrativeOrder: 3', 'chapterId: c-1'])
  writeEvent(root, '己卯屠村', ['id: t-2', 'title: 己卯屠村', 'worldTime: 1709-12-01', 'narrativeOrder: 1', 'chapterId: c-3'])
}

function idsOf(rows) {
  return (rows ?? []).map((entry) => entry.id)
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** Every file under `timeline/` with its hash: the "nothing was written" fingerprint. */
function timelineFiles(root) {
  const dir = join(root, 'timeline')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name !== '.gitkeep')
    .sort()
    .map((name) => `${name} ${sha256(readFileSync(join(dir, name), 'utf8'))}`)
}

/** The five projections the page reads, once per request shape. */
const COMPARED = ['axis', 'counts', 'worldOrder', 'narrativeOrder', 'pending', 'conflicts']

// ---------------------------------------------------------------------------
// 1. Same data, same answer
// ---------------------------------------------------------------------------

test('timeline-channel: GET /timeline answers field for field what the tool answers', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    const harness = createHarness({ workspace: root })

    const route = await read(harness, '/timeline?axis=both&includeUnconfirmed=true')
    assert.equal(route.status, 200, JSON.stringify(route.json))
    assert.equal(route.json.ok, true)
    const value = route.json.value

    const tool = await callTool('inkflow_timeline_list', { projectRoot: root, axis: 'both', includeUnconfirmed: true })
    assert.equal(tool.ok, true)

    // The tool's own value, minus its envelope: every key must be present on the route too.
    const missing = Object.keys(tool)
      .filter((key) => key !== 'ok')
      .filter((key) => !(key in value))
    assert.deepEqual(missing, [], 'the route must carry every field the tool answers')

    for (const key of COMPARED) {
      assert.deepEqual(value[key], tool[key], `${key} must be the same on both surfaces`)
    }
    assert.deepEqual(idsOf(value.worldOrder), ['t-2', 't-1', 't-3'], 'when it happened')
    assert.deepEqual(idsOf(value.narrativeOrder), ['t-2', 't-3', 't-1'], 'when the reader learns it')
    assert.deepEqual(value.counts, { world: 3, narrative: 3, unconfirmed: 0 })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('timeline-channel: one axis at a time, and the pending area only on request', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    writeEvent(root, '已定', ['id: t-1', 'title: 已定', 'worldTime: 1710-01-01', 'narrativeOrder: 1'])
    writeEvent(root, '待定', ['id: t-9', 'title: 待定', 'status: unconfirmed'])
    const harness = createHarness({ workspace: root })

    const world = await read(harness, '/timeline?axis=world')
    assert.equal(world.status, 200)
    assert.deepEqual(idsOf(world.json.value.worldOrder), ['t-1'])
    assert.equal('narrativeOrder' in world.json.value, false, 'axis=world must not answer the other axis')
    assert.equal('pending' in world.json.value, false, 'the pending area needs includeUnconfirmed')
    assert.equal(world.json.value.counts.unconfirmed, 1, 'the count is honest even when the rows are not sent')

    const narrative = await read(harness, '/timeline?axis=narrative&includeUnconfirmed=true')
    assert.deepEqual(idsOf(narrative.json.value.narrativeOrder), ['t-1'])
    assert.equal('worldOrder' in narrative.json.value, false)
    assert.deepEqual(idsOf(narrative.json.value.pending), ['t-9'])

    // An unknown axis value is read as `both`, exactly like the tool reads it.
    const both = await read(harness, '/timeline?axis=sideways')
    assert.equal(both.json.value.axis, 'both')
    assert.ok(Array.isArray(both.json.value.worldOrder))
    assert.ok(Array.isArray(both.json.value.narrativeOrder))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('timeline-channel: chapter filter narrows the axes but never the conflicts', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    writeEvent(root, '甲', ['id: t-1', 'title: 甲', 'worldTime: 1710-01-01', 'narrativeOrder: 2', 'chapterId: c-1'])
    writeEvent(root, '乙', ['id: t-2', 'title: 乙', 'worldTime: 1710-02-01', 'narrativeOrder: 2', 'chapterId: c-2'])
    const harness = createHarness({ workspace: root })

    const route = await read(harness, '/timeline?axis=both&chapter=c-1')
    assert.deepEqual(idsOf(route.json.value.worldOrder), ['t-1'], 'only the requested chapter is on the axis')
    // The contradiction is book-wide (the narrative slot is), so a chapter filter must not
    // hide it — that is the finding the author most needs to see.
    assert.deepEqual(
      route.json.value.conflicts.map((conflict) => conflict.code),
      ['TIMELINE_ORDER_CONFLICT'],
    )
    const tool = await callTool('inkflow_timeline_list', { projectRoot: root, axis: 'both', chapter: 'c-1' })
    assert.deepEqual(route.json.value.conflicts, tool.conflicts, 'a filter does not change the judgement')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. A flashback is not an error
// ---------------------------------------------------------------------------

test('timeline-channel: a scene told later and set earlier keeps both numbers', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    const harness = createHarness({ workspace: root })

    const route = await read(harness, '/timeline?axis=both&includeUnconfirmed=true')
    const value = route.json.value
    const recall = value.narrativeOrder.find((row) => row.id === 't-1')
    assert.equal(recall.worldTime, '1710-01-05', 'the world time is the earlier one')
    assert.equal(recall.narrativeOrder, 3, 'and it is told last')
    assert.equal(recall.worldAbsoluteDay, value.worldOrder.find((row) => row.id === 't-1').worldAbsoluteDay)

    // Reported, never refused: the only finding on this book is the crossing itself.
    assert.deepEqual(
      value.conflicts.map((conflict) => conflict.code),
      ['TIMELINE_WORLD_TIME_REVERSED'],
      'the rebuild reports the crossing as informational',
    )

    // And a write that creates the crossing still lands.
    const created = await post(harness, '/timeline/upsert', {
      title: '回忆',
      worldTime: '1709-01-01',
      narrativeOrder: 4,
      confirm: true,
    })
    assert.equal(created.status, 200, JSON.stringify(created.json))
    assert.equal(created.json.ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. The same refusal codes as the tool
// ---------------------------------------------------------------------------

test('timeline-channel: POST /timeline/upsert refuses with the tool code', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    const harness = createHarness({ workspace: root })

    const cases = [
      { label: 'a date the era cannot express', body: { title: '坏日期', worldTime: '1710-13-01', confirm: true } },
      { label: 'a status outside the enum', body: { title: '坏状态', status: 'maybe', confirm: true } },
      { label: 'a participant with whitespace', body: { title: '坏参与者', worldTime: '1710-01-01', participants: ['c a'], confirm: true } },
      { label: 'no title at all', body: { worldTime: '1710-01-01', confirm: true } },
    ]

    for (const item of cases) {
      const route = await post(harness, '/timeline/upsert', item.body)
      assert.ok(route.status >= 400, `${item.label}: expected a refusal, got ${String(route.status)}`)
      assert.equal(route.json.ok, false, item.label)
      const tool = await callTool('inkflow_timeline_upsert', { projectRoot: root, ...item.body })
      assert.equal(tool.ok, false, `${item.label}: the tool must refuse it too`)
      assert.equal(route.json.error.code, tool.error.code, `${item.label}: the code must be the tool's own`)
    }

    assert.deepEqual(timelineFiles(root), [], 'nothing was written by any refusal')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('timeline-channel: one narrative slot, two moments — the same conflict the tool reports', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    const harness = createHarness({ workspace: root })

    const first = await post(harness, '/timeline/upsert', {
      title: '甲事件',
      worldTime: '1710-01-01',
      narrativeOrder: 2,
      confirm: true,
    })
    assert.equal(first.status, 200, JSON.stringify(first.json))

    const second = await post(harness, '/timeline/upsert', {
      title: '乙事件',
      worldTime: '1710-05-05',
      narrativeOrder: 2,
      confirm: true,
    })
    assert.equal(second.status, 409, `a slot claimed twice must be 409, got ${String(second.status)}`)
    assert.equal(second.json.error.code, 'TIMELINE_ORDER_CONFLICT')

    const tool = await callTool('inkflow_timeline_upsert', {
      projectRoot: root,
      title: '乙事件',
      worldTime: '1710-05-05',
      narrativeOrder: 2,
      confirm: true,
    })
    assert.equal(tool.ok, false)
    assert.equal(tool.error.code, second.json.error.code, 'the route and the tool agree on the code')
    assert.equal(timelineFiles(root).length, 1, 'the refused write left the book alone')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. The confirmation gate and an idempotent overwrite
// ---------------------------------------------------------------------------

test('timeline-channel: no confirm means no write, and the receipt says what it would do', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    const harness = createHarness({ workspace: root })

    const refused = await post(harness, '/timeline/upsert', { title: '待确认', worldTime: '1710-01-01' })
    assert.equal(refused.status, 400)
    assert.equal(refused.json.error.code, 'TIMELINE_UPSERT_REQUIRES_CONFIRMATION')
    assert.match(refused.json.error.message, /timeline\/待确认\.md/u, 'the refusal names the file it would write')
    assert.deepEqual(timelineFiles(root), [], 'zero bytes written without confirm')

    const confirmed = await post(harness, '/timeline/upsert', { title: '待确认', worldTime: '1710-01-01', confirm: true })
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.json))
    assert.equal(confirmed.json.value.created, true)
    assert.equal(confirmed.json.value.path, 'timeline/待确认.md', 'the receipt names the file it wrote')
    assert.equal(confirmed.json.value.replaced, false)
    assert.equal(confirmed.json.value.id, 'timeline/待确认.md', 'the id defaults to the path, as the parser defaults it')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('timeline-channel: the same arguments twice overwrite, byte for byte', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    const harness = createHarness({ workspace: root })
    const body = {
      title: '丁卯夜谈',
      worldTime: '1710-04-01',
      era: 'ce',
      narrativeOrder: 5,
      chapter: 'c-7',
      participants: ['c-a'],
      body: '雨停了，两人对坐。',
      confirm: true,
    }

    const first = await post(harness, '/timeline/upsert', body)
    assert.equal(first.status, 200, JSON.stringify(first.json))
    assert.equal(first.json.value.created, true)
    const afterFirst = timelineFiles(root)
    const text = readFileSync(join(root, 'timeline', '丁卯夜谈.md'), 'utf8')
    assert.match(text, /worldTime: 1710-04-01/u)
    assert.match(text, /narrativeOrder: 5/u)
    assert.match(text, /雨停了/u)

    const second = await post(harness, '/timeline/upsert', body)
    assert.equal(second.status, 200, JSON.stringify(second.json))
    assert.equal(second.json.value.created, false, 'the second call replaces the file')
    assert.equal(second.json.value.replaced, true)
    assert.equal(second.json.value.path, first.json.value.path)
    assert.deepEqual(timelineFiles(root), afterFirst, 'an unchanged event must not churn its bytes')

    const third = await post(harness, '/timeline/upsert', { ...body, status: 'unconfirmed' })
    assert.equal(third.status, 200)
    const pending = await read(harness, '/timeline?axis=both&includeUnconfirmed=true')
    assert.deepEqual(idsOf(pending.json.value.pending), ['timeline/丁卯夜谈.md'], 'the edit moved it to the pending area')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. Declared fields only
// ---------------------------------------------------------------------------

test('timeline-channel: an undeclared query key or body field is a 400', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    const harness = createHarness({ workspace: root })

    const query = await read(harness, '/timeline?axis=both&chapters=c-1')
    assert.equal(query.status, 400, 'the misspelt key must not be silently ignored')
    assert.equal(query.json.error.code, 'UNKNOWN_QUERY_PARAM')
    assert.equal(query.json.error.param, 'chapters')

    const body = await post(harness, '/timeline/upsert', { title: '甲', confirm: true, calendar: 'x' })
    assert.equal(body.status, 400, 'a field nobody declared must not be read by nobody and reported by nobody')
    assert.equal(body.json.error.code, 'UNEXPECTED_BODY_FIELD')
    assert.equal(body.json.error.field, 'calendar')
    assert.deepEqual(timelineFiles(root), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('timeline-channel: no body field may name a directory', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    const harness = createHarness({ workspace: root })

    // The browser names a session, never a location (the channel's one rule). Both spellings a
    // caller might reach for are refused before the route sees the body at all.
    for (const field of ['root', 'path', 'projectRoot', 'cwd']) {
      const refused = await post(harness, '/timeline/upsert', { title: '甲', confirm: true, [field]: root })
      assert.equal(refused.status, 400, `${field} must be refused`)
      assert.equal(refused.json.error.code, 'ROOT_PARAM_NOT_ALLOWED', `${field} is a path-bearing key`)
      assert.equal(refused.json.error.param, field)
    }
    assert.deepEqual(timelineFiles(root), [], 'a refused request writes nothing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('timeline-channel: an existing event is edited by the slug its file carries', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    const harness = createHarness({ workspace: root })

    const created = await post(harness, '/timeline/upsert', { title: '戊辰拜山', worldTime: '1710-06-01', confirm: true })
    assert.equal(created.status, 200, JSON.stringify(created.json))
    const file = created.json.value.path

    // The page holds a row's `file`; the slug is that name without the directory and the
    // extension — the same derivation `timeline-model.ts` ships to the form.
    const slug = file.replace(/^timeline\//u, '').replace(/\.md$/u, '')
    const edited = await post(harness, '/timeline/upsert', {
      title: '戊辰拜山',
      worldTime: '1710-06-02',
      slug,
      body: '改了一笔。',
      confirm: true,
    })
    assert.equal(edited.status, 200, JSON.stringify(edited.json))
    assert.equal(edited.json.value.path, file, 'the same file, not a second one')
    assert.equal(edited.json.value.created, false)
    assert.equal(timelineFiles(root).length, 1)
    assert.match(readFileSync(join(root, file), 'utf8'), /改了一笔/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. The calendar the form hints with
// ---------------------------------------------------------------------------

test('timeline-channel: the era table is the one the calendar tool reads', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    const harness = createHarness({ workspace: root })

    const route = await read(harness, '/timeline')
    assert.equal(route.status, 200)
    const calendar = route.json.value.calendar
    assert.ok(calendar, 'the page needs the eras to hint a form field')
    const tool = await callTool('inkflow_calendar_get', { projectRoot: root })
    assert.equal(tool.ok, true)
    assert.equal(calendar.id, tool.calendarId)
    assert.equal(calendar.source, tool.source)
    assert.deepEqual(calendar.eras.map((era) => era.id), tool.eras.map((era) => era.id))
    assert.equal(calendar.defaultEra, tool.defaultEra)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
