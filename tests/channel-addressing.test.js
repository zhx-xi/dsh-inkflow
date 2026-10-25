/**
 * Issue #200 — chapter addressing on the four read routes, and query keys that are
 * declared rather than guessed.
 *
 * The bug this suite pins is not "a parameter does not work": it is that
 * `GET /brief?chapterId=ch-0002` answered **the last chapter**, with HTTP 200 and a
 * complete payload. The caller's target was dropped and nothing in the response said
 * so, which is the same failure shape as #189 (a wrong answer with a legal exit).
 *
 * Five properties, in the order they failed:
 *
 *   1. **`/brief?chapterId=` briefs that chapter** — and `?chapterSeq=` keeps working,
 *      because the batch queue uses it for "the chapter being planned", which has no
 *      id yet (`jobs.ts`).
 *   2. **the two spellings agree** — the same chapter reached by id and by seq answers
 *      the same nine segments, field by field, so a caller can switch without a diff.
 *   3. **an unknown id is refused** — 404 `CHAPTER_NOT_FOUND` naming the id, and never
 *      a fallback to the last chapter. This is the regression: before the fix the route
 *      answered 200 with someone else's brief.
 *   4. **`addressedBy`** — every one of the four routes says which key answered
 *      (`chapterId` / `chapterSeq` / `default`), so "did my parameter take effect" is
 *      machine-checkable instead of a hand comparison of `chapterId`.
 *   5. **an undeclared query key is a 400** — `?chapterID=` (a spelling mistake) is
 *      `UNKNOWN_QUERY_PARAM`, naming the route, the offending key and the keys the
 *      route does take. The allowlist lives in the route table, so it cannot drift
 *      from the handler the way a comment would.
 *
 * Runs against the BUILT artifact (`lib/index.js`), like every other channel suite.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const ALL_DIRS = [...CONTENT_DIRS, 'index']
const HOST = '127.0.0.1:2149'
const INTERNAL = '/inkflow/internal'

// ---------------------------------------------------------------------------
// Harness (the same shape `internal-channel.test.js` uses: no DSH process)
// ---------------------------------------------------------------------------

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
  apply(ctx, { dataDir: join(tmpdir(), 'inkflow-addressing-state') })
  return { ctx, routes }
}

function fakeRequest({ url, method = 'GET', host = HOST, remoteAddress = '127.0.0.1' } = {}) {
  return { url, method, headers: { host }, socket: { remoteAddress } }
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

/** One `GET /inkflow/internal<path>`, with `sessionId` appended the way the panel does. */
function internalCall(harness, path, options = {}) {
  const sessionId = options.sessionId ?? 'session-1'
  const query = sessionId === null ? '' : `sessionId=${encodeURIComponent(sessionId)}`
  const separator = path.includes('?') ? '&' : '?'
  const url = query === '' ? `${INTERNAL}${path}` : `${INTERNAL}${path}${separator}${query}`
  return callRoute(harness, fakeRequest({ ...options, url }))
}

// ---------------------------------------------------------------------------
// Fixtures: one volume, three chapters, ids the author wrote by hand
// ---------------------------------------------------------------------------

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-addressing-'))
}

function scaffold(root) {
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, '.git'))
  for (const dir of ALL_DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '寻址之书' }, null, 2)}\n`, 'utf8')
}

function writeMarkdown(root, relativePath, frontmatterLines, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = frontmatterLines.length > 0 ? `---\n${frontmatterLines.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

/** ch-0001 / ch-0002 / ch-0003, seq 1..3, one volume — the shape the bug was seen in. */
function chapterBook(root) {
  scaffold(root)
  const chapters = [
    ['ch-0001', '开端', 1, '第一章正文，青萍宗的山门在雨里。'.repeat(10)],
    ['ch-0002', '起风', 2, '第二章正文，断剑仍在鞘中。'.repeat(10)],
    ['ch-0003', '夜谈', 3, '第三章正文，灯下有人说话。'.repeat(10)],
  ]
  for (const [id, title, seq, body] of chapters) {
    const padded = String(seq).padStart(4, '0')
    writeMarkdown(
      root,
      `chapters/vol-01/${padded}-${title}.md`,
      [`id: ${id}`, `title: ${title}`, 'volume: vol-01', `seq: ${seq}`, 'status: draft'],
      body,
    )
  }
  return root
}

async function briefOf(harness, path) {
  const reply = await internalCall(harness, path)
  assert.equal(reply.status, 200, `${path} answers 200: ${JSON.stringify(reply.json)}`)
  assert.equal(reply.json.ok, true, `${path} answers ok:true: ${JSON.stringify(reply.json)}`)
  return reply.json.value
}

// ---------------------------------------------------------------------------
// 1 + 2. /brief accepts chapterId, and the two spellings agree
// ---------------------------------------------------------------------------

test('brief: ?chapterId briefs THAT chapter, and ?chapterSeq still does too', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    chapterBook(root)
    const harness = createHarness({ workspace: root })

    // The default is still the last chapter: the bug was that this happened even when
    // a chapter had been named.
    const fallback = await briefOf(harness, '/brief')
    assert.equal(fallback.chapterId, 'ch-0003', 'no address = the book moves on, i.e. the last chapter')
    assert.equal(fallback.addressedBy, 'default')

    const byId = await briefOf(harness, '/brief?chapterId=ch-0002')
    assert.equal(byId.chapterId, 'ch-0002', 'the id the caller named is the chapter briefed')
    assert.equal(byId.chapterSeq, 2)
    assert.equal(byId.chapterPath, 'chapters/vol-01/0002-起风.md')
    assert.equal(byId.addressedBy, 'chapterId')

    const bySeq = await briefOf(harness, '/brief?chapterSeq=2')
    assert.equal(bySeq.chapterId, 'ch-0002', 'chapterSeq keeps working: the planned chapter has no id yet')
    assert.equal(bySeq.addressedBy, 'chapterSeq')

    // The pre-fix behaviour, stated as a fact about the payload rather than about code:
    // the chapter named by the request is the chapter in the text.
    assert.ok(byId.text.includes('起风'), 'the brief is about the chapter the request named')
    assert.ok(!byId.text.includes('夜谈'), 'and never about another one')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('brief: ?chapterId and ?chapterSeq name the same chapter ⇒ the same answer, field by field', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    chapterBook(root)
    const harness = createHarness({ workspace: root })

    // Warm the derived index first: the first read of a fresh book rebuilds it and says so
    // (`indexRebuilt`), which is about the cache, not about which chapter was addressed.
    await briefOf(harness, '/brief?chapterId=ch-0003')

    const byId = await briefOf(harness, '/brief?chapterId=ch-0002&budgetTokens=20000')
    const bySeq = await briefOf(harness, '/brief?chapterSeq=2&budgetTokens=20000')

    // `addressedBy` is the ONE field that must differ — it reports which key answered.
    const withoutAddress = (value) => {
      const { addressedBy, ...rest } = value
      return rest
    }
    assert.equal(byId.addressedBy, 'chapterId')
    assert.equal(bySeq.addressedBy, 'chapterSeq')
    assert.deepEqual(withoutAddress(byId), withoutAddress(bySeq), 'the two spellings answer the same brief')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('brief: ?chapterId wins when both chapter keys are given', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    chapterBook(root)
    const harness = createHarness({ workspace: root })

    const value = await briefOf(harness, '/brief?chapterId=ch-0002&chapterSeq=3')
    assert.equal(value.chapterId, 'ch-0002')
    assert.equal(value.addressedBy, 'chapterId', 'the id decides, and the answer says so')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('brief: ?chapterSeq naming the chapter about to be written has no current chapter', async () => {
  // The batch queue's case (`jobs.ts`): "write chapter 4" of a three-chapter book.
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    chapterBook(root)
    const harness = createHarness({ workspace: root })

    const value = await briefOf(harness, '/brief?chapterSeq=4')
    assert.equal(value.chapterId, 'no-chapter', 'no chapter yet — not the last one pretending to be it')
    assert.equal(value.chapterSeq, null)
    assert.equal(value.addressedBy, 'chapterSeq')
    const tail = value.segments.find((segment) => segment.id === 'prevTail')
    assert.equal(tail.missing, false, 'the previous chapter is still read, so the injection keeps its tail')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. The regression: an unknown id is refused, never replaced by another chapter
// ---------------------------------------------------------------------------

test('brief: an unknown ?chapterId is refused and never falls back to the last chapter', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    chapterBook(root)
    const harness = createHarness({ workspace: root })

    const reply = await internalCall(harness, '/brief?chapterId=ch-9999-proofread')
    assert.equal(reply.status, 404, `refused, not answered: ${JSON.stringify(reply.json)}`)
    assert.equal(reply.json.ok, false)
    assert.equal(reply.json.error.code, 'CHAPTER_NOT_FOUND')
    assert.equal(reply.json.error.chapterId, 'ch-9999-proofread', 'the answer names the id that matched nothing')
    assert.ok(typeof reply.json.error.hint === 'string' && reply.json.error.hint !== '', 'and says what to do next')

    // The bug, as an assertion: no payload at all, so there is nothing to mistake for
    // the chapter the caller asked for.
    assert.equal(reply.json.value, undefined)
    assert.ok(!JSON.stringify(reply.json).includes('夜谈'), 'the last chapter is nowhere in the refusal')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. addressedBy on all four read routes
// ---------------------------------------------------------------------------

test('addressedBy: the four read routes report which key answered, default included', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    chapterBook(root)
    const harness = createHarness({ workspace: root })

    // `null` = do not assert the echoed chapter id. `/review/compare` takes its `chapterId`
    // from the recorded RUNS (`reviewCompareWire`), so a book with no runs echoes `''` even
    // though it resolved the chapter — a separate echo bug, not an addressing one; what
    // this issue pins there is `addressedBy`.
    const cases = [
      ['/brief', 'default', 'ch-0003'],
      ['/brief?chapterId=ch-0001', 'chapterId', 'ch-0001'],
      ['/brief?chapterSeq=2', 'chapterSeq', 'ch-0002'],
      ['/gate', 'default', 'ch-0003'],
      ['/gate?chapterId=ch-0001', 'chapterId', 'ch-0001'],
      ['/review', 'default', 'ch-0003'],
      ['/review?chapterId=ch-0001', 'chapterId', 'ch-0001'],
      ['/review/compare', 'default', null],
      ['/review/compare?chapterId=ch-0001', 'chapterId', null],
    ]
    for (const [path, addressedBy, chapterId] of cases) {
      const reply = await internalCall(harness, path)
      assert.equal(reply.status, 200, `${path}: ${JSON.stringify(reply.json)}`)
      assert.equal(reply.json.value.addressedBy, addressedBy, `${path} says which key answered`)
      if (chapterId !== null) {
        assert.equal(reply.json.value.chapterId, chapterId, `${path} briefs/reports the chapter it was told to`)
      }
    }
    // The refusal path carries no `addressedBy` at all — there is no answered address to
    // report, and inventing `'default'` there would be the same lie in a new place.
    const refused = await internalCall(harness, '/gate?chapterId=ch-nope')
    assert.equal(refused.status, 404)
    assert.equal(refused.json.error.code, 'CHAPTER_NOT_FOUND')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. A query key the route does not declare is a 400, not a silent default
// ---------------------------------------------------------------------------

test('query keys: a near-miss spelling is a 400 UNKNOWN_QUERY_PARAM naming route, param and allowed', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    chapterBook(root)
    const harness = createHarness({ workspace: root })

    const expected = {
      brief: ['chapterId', 'chapterSeq', 'budgetTokens', 'tailChars'],
      gate: ['chapterId'],
      review: ['chapterId', 'runId'],
      'review-compare': ['chapterId'],
    }
    const paths = [
      ['brief', '/brief?chapterID=ch-0002'],
      ['gate', '/gate?chapterID=ch-0002'],
      ['review', '/review?chapterid=ch-0002'],
      ['review-compare', '/review/compare?chapterID=ch-0002'],
    ]
    for (const [route, path] of paths) {
      const reply = await internalCall(harness, path)
      assert.equal(reply.status, 400, `${path} must not answer a brief for some other chapter`)
      assert.equal(reply.json.ok, false)
      assert.equal(reply.json.error.code, 'UNKNOWN_QUERY_PARAM')
      assert.equal(reply.json.error.route, route, 'the answer names the route')
      assert.equal(reply.json.error.param, path.split('?')[1].split('=')[0], 'and the key it did not expect')
      const allowed = reply.json.error.allowed
      assert.ok(Array.isArray(allowed), 'and the keys it does take')
      for (const key of expected[route]) assert.ok(allowed.includes(key), `${route} allows ${key}`)
      assert.ok(allowed.includes('sessionId'), 'the session id is always allowed (it is how the panel is addressed)')
      assert.ok(!allowed.includes('chapterID'), 'the misspelling is not quietly accepted')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('query keys: the allowlist is declared per route, so a route with no knobs refuses any key', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    chapterBook(root)
    const harness = createHarness({ workspace: root })

    const clean = await internalCall(harness, '/status')
    assert.equal(clean.status, 200, 'the panel calls it with sessionId only')

    const stray = await internalCall(harness, '/status?verbose=1')
    assert.equal(stray.status, 400)
    assert.equal(stray.json.error.code, 'UNKNOWN_QUERY_PARAM')
    assert.equal(stray.json.error.route, 'status')
    assert.equal(stray.json.error.param, 'verbose')

    // The path-parameter ban keeps its own code and still runs first (ADR-0008 D4).
    const path = await internalCall(harness, `/status?root=${encodeURIComponent(root)}`)
    assert.equal(path.status, 400)
    assert.equal(path.json.error.code, 'ROOT_PARAM_NOT_ALLOWED', 'a directory is refused as a directory, not as an unknown key')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('query keys: the hub channel carries the same declaration, so /hub/* cannot swallow a key either', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    chapterBook(root)
    const harness = createHarness({ workspace: root })

    // `book` is how a hub call names the book it means — declared, so it is read.
    const named = await callRoute(harness, fakeRequest({ url: `${INTERNAL}/hub/shared/copies?book=${encodeURIComponent(root)}` }))
    assert.equal(named.status === 400, false, 'a declared key is never refused as unknown')

    // `books` (a plausible typo for `book`) used to answer the DEFAULT book with 200.
    const stray = await callRoute(harness, fakeRequest({ url: `${INTERNAL}/hub/shared/copies?books=${encodeURIComponent(root)}` }))
    assert.equal(stray.status, 400)
    assert.equal(stray.json.error.code, 'UNKNOWN_QUERY_PARAM')
    assert.equal(stray.json.error.route, 'hub-shared-copies')
    assert.equal(stray.json.error.param, 'books')
    assert.deepEqual(stray.json.error.allowed, ['book', 'sessionId'], 'the body names what this route does read')

    // A hub route with no knobs says so with `[]`: any key at all is refused.
    const noKnobs = await callRoute(harness, fakeRequest({ url: `${INTERNAL}/hub/books?book=${encodeURIComponent(root)}` }))
    assert.equal(noKnobs.status, 400)
    assert.equal(noKnobs.json.error.code, 'UNKNOWN_QUERY_PARAM')
    assert.equal(noKnobs.json.error.route, 'hub-books')

    // …and the session channel's routes are untouched by the hub's declarations.
    const internal = await internalCall(harness, '/status')
    assert.equal(internal.status, 200)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
