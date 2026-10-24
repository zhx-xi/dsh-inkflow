/**
 * The write half of the import path (issue #37, roadmap X-17): plan → confirm → apply.
 *
 * What must FAIL when this is wired wrong:
 *   1. **the preview writes.** `planImport` is the dialog's first two steps; a single
 *      byte (or mtime) moving under it would make "look before you leap" a lie, so
 *      every read-only case is asserted with a whole-tree hash;
 *   2. **a plan token that no longer describes the book is accepted** — the author
 *      previewed one set of chapters and a different set lands;
 *   3. **apply without `confirm: true` writes** — X-17's second half;
 *   4. **a mid-batch failure leaves debris.** The rollback has to bring every covered
 *      file back to the byte it had before, including the chapter catalog;
 *   5. **the source's encoding leaks into the book** — a GBK or CRLF manuscript must
 *      land as UTF-8/LF chapter files (data-safety §2.6), with the original style
 *      reported rather than reproduced;
 *   6. **the library copy is lost or duplicated** — the import registers the original
 *      under `library/`, and a second import of the same file must not create a twin.
 *
 * The project fixture mirrors `tests/library-write.test.js` (a throwaway book on disk),
 * and the route section at the bottom drives the BUILT `lib/index.js` through a fake
 * Cordis context so the channel guards are exercised too.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  IMPORT_EXTENSIONS,
  MAX_IMPORT_BYTES,
  analyzeImportBytes,
  apply,
  applyImport,
  listBackups,
  listChapters,
  planImport,
} from '../lib/index.js'
import { hashTree } from './hash-tree.mjs'
import { changedPaths, fileDigests } from './tree-digest.mjs'

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const ALL_DIRS = [...CONTENT_DIRS, 'index']
const KEEP = '.gitkeep'
const HOST = '127.0.0.1:2149'
const ORIGIN = `http://${HOST}`
const INTERNAL = '/inkflow/internal'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function workdir(prefix = 'inkflow-import-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function scaffold(root) {
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, '.git'))
  for (const dir of ALL_DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, KEEP), '', 'utf8')
  }
  writeFileSync(
    join(root, 'inkflow.json'),
    `${JSON.stringify({ schemaVersion: 1, title: '导入之书', author: 'tester' }, null, 2)}\n`,
    'utf8',
  )
}

/** A usable book whose chapters are created by the import under test. */
function book() {
  const root = workdir()
  scaffold(root)
  return root
}

/** Write the source manuscript outside the book, the way an author would. */
function sourceFile(name, bytes) {
  const dir = workdir('inkflow-import-src-')
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

const CHAPTERS_SOURCE = ['第一章 入山', '', '山中无岁月。', '', '风起了。', '', '第二章 出山', '', '剑光一闪。'].join('\n')

/** Every `.md` file under `chapters/`, project-relative, sorted. */
function chapterFiles(root) {
  const out = []
  const walk = (relative) => {
    for (const entry of readdirSync(join(root, ...relative.split('/')), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name !== '.git' && !entry.name.startsWith('.')) walk(child)
        continue
      }
      if (entry.name.endsWith('.md')) out.push(child)
    }
  }
  walk('chapters')
  return out.sort()
}

/** The body of one chapter file: everything after the frontmatter block. */
function bodyOf(root, relativePath) {
  const text = readFileSync(join(root, ...relativePath.split('/')), 'utf8')
  const match = /^---\n[\s\S]*?\n---\n\n?/u.exec(text)
  assert.ok(match, `${relativePath} has no frontmatter block`)
  return text.slice(match[0].length)
}

/**
 * Content digests of the book's **truth**, for the rollback assertion.
 *
 * Three exclusions, each a fact about the design rather than a convenience:
 *   * `.inkflow/` — the backup package this batch is supposed to leave behind;
 *   * `index/` — a rebuildable cache (a failed batch leaves a stale cache, and the
 *     next read route rebuilds it; the files are the truth);
 *   * `.gitignore` — appended to by `openBackup` (`.inkflow/`), append-only by
 *     ADR-0012, and never rolled back.
 */
function bookDigests(root) {
  const map = fileDigests(root, { skipDirs: ['.inkflow', '.git', 'index'] })
  map.delete('.gitignore')
  return map
}

function titles(root) {
  return chapterFiles(root)
    .map((path) => readFileSync(join(root, ...path.split('/')), 'utf8'))
    .map((text) => /^title:[ \t]*(.+)$/mu.exec(text)?.[1]?.trim() ?? '')
}

// ---------------------------------------------------------------------------
// Preview: plan
// ---------------------------------------------------------------------------

test('plan is read-only: the whole book is byte- and mtime-identical afterwards', () => {
  const root = book()
  const source = sourceFile('旧稿.txt', Buffer.from(CHAPTERS_SOURCE, 'utf8'))
  const before = hashTree(root)

  const plan = planImport(root, { sourcePath: source })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  assert.equal(hashTree(root), before, 'the preview must not write anything, not even the index')
  assert.deepEqual(listBackups(root), [], 'a preview must not open a backup package')
})

test('plan reports the encoding tier, the source line endings and the chapters it would create', () => {
  const root = book()
  const source = sourceFile('旧稿.txt', Buffer.from(CHAPTERS_SOURCE.replaceAll('\n', '\r\n'), 'utf8'))

  const plan = planImport(root, { sourcePath: source })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  const value = plan.value
  assert.equal(value.source.encoding, 'utf8')
  assert.equal(value.source.eol, 'crlf', 'CRLF must be reported even though the chapters land as LF')
  assert.match(value.source.sniff, /utf-8/iu)
  assert.equal(value.chaptering, true)
  assert.equal(value.chapters.length, 2)
  assert.deepEqual(
    value.chapters.map((chapter) => [chapter.seq, chapter.title, chapter.paragraphs]),
    [
      [1, '第一章 入山', 2],
      [2, '第二章 出山', 1],
    ],
  )
  assert.equal(value.target.volumeId, null)
  assert.equal(value.totals.chars, analyzeImportBytes(readFileSync(source)).totals.chars)
  assert.equal(typeof value.planToken, 'string')
  assert.equal(value.planToken.length, 64, 'the token is a sha256 of the analysed source')
})

test('plan names the volume it would import into and continues that volume’s numbering', () => {
  const root = book()
  // A book with one volume already holding two chapters: the import continues at 3.
  mkdirSync(join(root, 'chapters', 'vol-01-上卷'), { recursive: true })
  writeFileSync(join(root, 'chapters', 'vol-01-上卷', KEEP), '', 'utf8')
  writeFileSync(
    join(root, 'chapters', 'vol-01-上卷', '0001-开篇.md'),
    '---\nid: c1\ntitle: 开篇\nvolume: vol-01\nseq: 1\n---\n\n甲。\n',
    'utf8',
  )
  writeFileSync(
    join(root, 'chapters', 'vol-01-上卷', '0002-续篇.md'),
    '---\nid: c2\ntitle: 续篇\nvolume: vol-01\nseq: 2\n---\n\n乙。\n',
    'utf8',
  )

  const source = sourceFile('旧稿.txt', Buffer.from(CHAPTERS_SOURCE, 'utf8'))
  const plan = planImport(root, { sourcePath: source, volumeId: 'vol-01' })
  assert.equal(plan.ok, true, JSON.stringify(plan))
  assert.equal(plan.value.target.volumeId, 'vol-01')
  assert.deepEqual(
    plan.value.chapters.map((chapter) => chapter.seq),
    [3, 4],
  )
})

test('a preview of a missing file, a directory or a non-text extension is refused, not thrown', () => {
  const root = book()
  const missing = join(workdir('inkflow-import-none-'), '没有这个文件.txt')
  assert.equal(planImport(root, { sourcePath: missing }).error.code, 'IMPORT_SOURCE_MISSING')

  const directory = workdir('inkflow-import-dir-')
  assert.equal(planImport(root, { sourcePath: directory }).error.code, 'IMPORT_SOURCE_NOT_FILE')

  const pdf = sourceFile('旧稿.pdf', Buffer.from('%PDF-1.4', 'utf8'))
  const refused = planImport(root, { sourcePath: pdf })
  assert.equal(refused.error.code, 'IMPORT_TYPE_UNSUPPORTED')
  assert.deepEqual(refused.error.allowedExtensions, IMPORT_EXTENSIONS)

  const empty = sourceFile('空.txt', Buffer.alloc(0))
  assert.equal(planImport(root, { sourcePath: empty }).error.code, 'IMPORT_SOURCE_EMPTY')

  assert.equal(typeof MAX_IMPORT_BYTES, 'number')
})

// ---------------------------------------------------------------------------
// Apply: the confirm gate and the token
// ---------------------------------------------------------------------------

test('apply without confirm: true writes nothing at all', async () => {
  const root = book()
  const source = sourceFile('旧稿.txt', Buffer.from(CHAPTERS_SOURCE, 'utf8'))
  const before = hashTree(root)

  const refused = await applyImport(root, { sourcePath: source })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'CONFIRM_REQUIRED')
  assert.equal(hashTree(root), before)

  const explicitFalse = await applyImport(root, { sourcePath: source, confirm: false })
  assert.equal(explicitFalse.error.code, 'CONFIRM_REQUIRED')
  assert.equal(hashTree(root), before)
})

test('a plan token that no longer describes the source is refused before anything is written', async () => {
  const root = book()
  const source = sourceFile('旧稿.txt', Buffer.from(CHAPTERS_SOURCE, 'utf8'))
  const before = hashTree(root)

  const refused = await applyImport(root, { sourcePath: source, confirm: true, planToken: 'f'.repeat(64) })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'IMPORT_PLAN_STALE')
  assert.equal(hashTree(root), before)
})

// ---------------------------------------------------------------------------
// Apply: the happy path
// ---------------------------------------------------------------------------

test('apply creates one chapter per title, with the exact prose, and seals an import backup', async () => {
  const root = book()
  const source = sourceFile('旧稿.txt', Buffer.from(CHAPTERS_SOURCE, 'utf8'))
  const plan = planImport(root, { sourcePath: source })
  assert.equal(plan.ok, true, JSON.stringify(plan))

  const applied = await applyImport(root, { sourcePath: source, confirm: true, planToken: plan.value.planToken })
  assert.equal(applied.ok, true, JSON.stringify(applied))
  const value = applied.value

  // The created set is exactly the previewed set — X-17's "preview = execution",
  // asserted as a set comparison rather than "both ran".
  assert.deepEqual(
    value.created.map((chapter) => [chapter.seq, chapter.title]),
    plan.value.chapters.map((chapter) => [chapter.seq, chapter.title]),
  )

  const files = chapterFiles(root)
  assert.equal(files.length, 2)
  // The FILE NAMES carry the seq the preview promised: `created[]` alone would let the
  // plan and the files drift apart while both looked right.
  assert.deepEqual(files.map((path) => path.slice('chapters/'.length)), ['0001-第一章-入山.md', '0002-第二章-出山.md'])
  assert.deepEqual(titles(root), ['第一章 入山', '第二章 出山'])
  assert.deepEqual(
    files.map((path) => bodyOf(root, path)),
    ['山中无岁月。\n\n风起了。\n', '剑光一闪。\n'],
  )
  // New files land as UTF-8/LF (data-safety §2.6), whatever came in.
  for (const path of files) {
    const bytes = readFileSync(join(root, ...path.split('/')))
    assert.equal(bytes.includes(0x0d), false, `${path} must not carry CR`)
    assert.equal(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false, `${path} must not carry a BOM`)
  }

  // One backup package, of the import kind, sealed, covering what the batch touched.
  const backups = listBackups(root)
  assert.equal(backups.length, 1)
  assert.equal(backups[0].kind, 'import')
  assert.equal(backups[0].sealed, true)
  assert.equal(backups[0].files, 1 + files.length + 1, 'the chapter catalog, every chapter file and the library copy')
  assert.equal(value.backup.dir, backups[0].dir)
  assert.equal(value.indexRebuilt, true)

  // The cache must already know the new chapters: `listChapters` reads `index/inkflow.db`
  // directly and never rebuilds, so this fails if the batch's one rebuild is dropped (the
  // per-chapter commits are suppressed — `indexCommit: false` — on purpose).
  const indexed = listChapters(root)
  assert.ok(Array.isArray(indexed), 'the index was rebuilt by the batch')
  assert.deepEqual(
    indexed.map((chapter) => chapter.title),
    ['第一章 入山', '第二章 出山'],
  )
})

test('the report says which encoding tier was used, for every sample', async () => {
  const cases = [
    { name: 'utf8.txt', bytes: Buffer.from(CHAPTERS_SOURCE, 'utf8'), encoding: 'utf8', eol: 'lf', expect: '第一章 入山' },
    {
      name: 'bom.txt',
      bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(CHAPTERS_SOURCE, 'utf8')]),
      encoding: 'utf8-bom',
      eol: 'lf',
      expect: '第一章 入山',
    },
    {
      name: 'crlf.txt',
      bytes: Buffer.from(CHAPTERS_SOURCE.replaceAll('\n', '\r\n'), 'utf8'),
      encoding: 'utf8',
      eol: 'crlf',
      expect: '第一章 入山',
    },
    {
      name: 'gbk.txt',
      bytes: Buffer.from(
        'b5dad2bbd5c220c8ebc9bd0d0a0d0ac9bdd6d0cedecbead4c2a3acb7e7c6f0c1cba1a3' +
          '0d0a0d0ab5dab6fed5c220b3f6c9bd0d0a0d0abda3b9e2d2bbc9c1a1a3',
        'hex',
      ),
      encoding: 'gbk',
      eol: 'crlf',
      expect: '山中无岁月，风起了。',
    },
  ]

  for (const item of cases) {
    const root = book()
    const source = sourceFile(item.name, item.bytes)
    const applied = await applyImport(root, { sourcePath: source, confirm: true })
    assert.equal(applied.ok, true, `${item.name}: ${JSON.stringify(applied)}`)
    assert.equal(applied.value.plan.source.encoding, item.encoding, item.name)
    assert.equal(applied.value.plan.source.eol, item.eol, item.name)
    // The decoded prose is what reaches the file, and the file is LF.
    const text = readFileSync(join(root, ...chapterFiles(root)[0].split('/')), 'utf8')
    assert.equal(text.includes(item.expect), true, `${item.name}: ${text}`)
    assert.equal(text.includes('\r'), false, `${item.name} must land as LF`)
  }
})

test('the original is registered under library/ and counted by the index', async () => {
  const root = book()
  const source = sourceFile('旧稿.txt', Buffer.from(CHAPTERS_SOURCE, 'utf8'))
  const applied = await applyImport(root, { sourcePath: source, confirm: true })
  assert.equal(applied.ok, true, JSON.stringify(applied))

  const libraryPath = applied.value.library?.path ?? ''
  assert.equal(libraryPath, 'library/旧稿.txt')
  assert.equal(existsSync(join(root, ...libraryPath.split('/'))), true)
  assert.equal(applied.value.library?.written, true)
  // Byte-identical here: the source was already UTF-8 without a BOM and already LF.
  assert.deepEqual(readFileSync(join(root, ...libraryPath.split('/'))), readFileSync(source))

  const status = await describeIndex(root)
  assert.equal(status.libraryFiles, 1, 'library_files must hold the registered copy')
})

test('a GBK original is kept as its decoded UTF-8 text, and says so', async () => {
  const root = book()
  const gbkBytes = Buffer.from(
    'b5dad2bbd5c220c8ebc9bd0d0a0d0ac9bdd6d0cedecbead4c2a3acb7e7c6f0c1cba1a3',
    'hex',
  )
  const source = sourceFile('gbk稿.txt', gbkBytes)
  const applied = await applyImport(root, { sourcePath: source, confirm: true })
  assert.equal(applied.ok, true, JSON.stringify(applied))

  const stored = readFileSync(join(root, 'library', 'gbk稿.txt'))
  assert.equal(stored.includes(0x0d), false)
  // The source ends without a newline (see the hex above, `…a1a3`), and the copy is the
  // decode verbatim: the write door normalises line endings, it does not invent one.
  assert.equal(stored.toString('utf8'), '第一章 入山\n\n山中无岁月，风起了。')
  // The text writer cannot reproduce GBK bytes, so the report has to state that the
  // copy is the decode, not the original file (backup.ts refuses the latter).
  assert.equal(applied.value.library?.byteIdentical, false)
  assert.equal(applied.value.library?.sourceBytes, gbkBytes.byteLength)
})

test('importing the same source twice reuses the library copy instead of twinning it', async () => {
  const root = book()
  const source = sourceFile('旧稿.txt', Buffer.from(CHAPTERS_SOURCE, 'utf8'))
  const first = await applyImport(root, { sourcePath: source, confirm: true })
  assert.equal(first.ok, true, JSON.stringify(first))
  const second = await applyImport(root, { sourcePath: source, confirm: true })
  assert.equal(second.ok, true, JSON.stringify(second))

  assert.equal(second.value.library?.path, 'library/旧稿.txt')
  assert.equal(second.value.library?.written, false, 'the identical copy must not be rewritten')
  assert.equal(readdirSync(join(root, 'library')).filter((name) => name !== KEEP).length, 1)
  // Chapters do accumulate: a second import is four more chapters, not a dedupe.
  assert.equal(chapterFiles(root).length, 4)
})

test('a same-named file with DIFFERENT text is never overwritten: the copy takes the next free name', async () => {
  const root = book()
  // Somebody's own note, already called 旧稿.txt. The import must not eat it.
  writeFileSync(join(root, 'library', '旧稿.txt'), '我自己写的一份资料，和这本旧稿无关。\n', 'utf8')
  const source = sourceFile('旧稿.txt', Buffer.from(CHAPTERS_SOURCE, 'utf8'))

  const applied = await applyImport(root, { sourcePath: source, confirm: true })
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.equal(applied.value.library?.path, 'library/旧稿-2.txt')
  assert.equal(applied.value.library?.written, true)
  // Both documents survive.
  assert.equal(readFileSync(join(root, 'library', '旧稿.txt'), 'utf8'), '我自己写的一份资料，和这本旧稿无关。\n')
  assert.equal(readFileSync(join(root, 'library', '旧稿-2.txt'), 'utf8'), CHAPTERS_SOURCE)
  // And the preview said so before anything was written.
  assert.equal(
    applied.value.plan.warnings.some((line) => line.includes('不覆盖已有文件')),
    true,
    'the rename is reported, not silent',
  )
  // A second preview now finds its own copy (`旧稿-2.txt`) and reuses it instead of
  // walking further down the suffix ladder.
  const again = planImport(root, { sourcePath: source })
  assert.equal(again.value.library.path, 'library/旧稿-2.txt')
  assert.equal(again.value.library.identical, true)
})

test('keepOriginal: false imports the chapters without registering the file', async () => {
  const root = book()
  const source = sourceFile('旧稿.txt', Buffer.from(CHAPTERS_SOURCE, 'utf8'))
  const applied = await applyImport(root, { sourcePath: source, confirm: true, keepOriginal: false })
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.equal(applied.value.library, null)
  assert.deepEqual(readdirSync(join(root, 'library')), [KEEP])
})

// ---------------------------------------------------------------------------
// Apply: failure and rollback
// ---------------------------------------------------------------------------

test('a chapter that cannot be created rolls the whole batch back to the previous bytes', async () => {
  const root = book()
  const source = sourceFile('旧稿.txt', Buffer.from(CHAPTERS_SOURCE, 'utf8'))
  // Occupy the second chapter's file path with a DIRECTORY: `createChapter` refuses
  // CHAPTER_EXISTS after the first chapter has already landed, which is exactly the
  // mid-batch failure the rollback exists for.
  mkdirSync(join(root, 'chapters', '0002-第二章-出山.md'), { recursive: true })
  const before = bookDigests(root)

  const failed = await applyImport(root, { sourcePath: source, confirm: true })
  assert.equal(failed.ok, false, JSON.stringify(failed))
  assert.equal(failed.error.code, 'IMPORT_CHAPTER_FAILED')
  assert.equal(failed.error.rolledBack, true)
  assert.equal(failed.error.planChapter, '第二章 出山')

  // Every covered file is back to the bytes it had before — including the chapter
  // catalog, which chapter 1 already rewrote. `fileDigests` compares content, not
  // mtimes: a restored file legitimately gets a new mtime.
  assert.deepEqual(changedPaths(before, bookDigests(root)), [], 'the rollback must restore every byte')
  assert.equal(chapterFiles(root).length, 0, 'no chapter of the batch may survive')
  assert.equal(
    existsSync(join(root, 'chapters', 'index.json')),
    false,
    'the catalog file this batch created is removed by the rollback (the book had none)',
  )

  const backups = listBackups(root)
  assert.equal(backups.length, 1)
  assert.equal(backups[0].kind, 'import')
  assert.equal(backups[0].sealed, false, 'an interrupted batch reports itself as interrupted')
})

test('a volume the book does not have is refused with nothing written', async () => {
  const root = book()
  const source = sourceFile('旧稿.txt', Buffer.from(CHAPTERS_SOURCE, 'utf8'))
  const before = hashTree(root)
  const refused = await applyImport(root, { sourcePath: source, confirm: true, volumeId: 'vol-09' })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'VOLUME_NOT_FOUND')
  assert.equal(hashTree(root), before)
})

test('a book that is not an InkFlow project is refused before the source is even read', async () => {
  const root = workdir('inkflow-import-notabook-')
  mkdirSync(root, { recursive: true })
  const source = sourceFile('旧稿.txt', Buffer.from(CHAPTERS_SOURCE, 'utf8'))
  const plan = planImport(root, { sourcePath: source })
  assert.equal(plan.ok, false)
  assert.equal(plan.error.code, 'NOT_A_PROJECT')
})

// ---------------------------------------------------------------------------
// The route: guards, body whitelist, confirm
// ---------------------------------------------------------------------------

function createHarness(workspace) {
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
        return { get: (id) => (id === 'session-1' ? { id, header: { cwd: workspace } } : undefined) }
      }
      if (name === 'workingDirectory') {
        return { get: () => workspace }
      }
      return undefined
    },
    logger() {
      return { debug() {}, info() {}, warn() {}, error() {} }
    },
    tools: { register: () => () => {} },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  apply(ctx, { dataDir: join(tmpdir(), 'inkflow-import-state') })
  return routes
}

function fakeRequest({ url, method = 'POST', host = HOST, origin, body, remoteAddress = '127.0.0.1' } = {}) {
  const headers = { host }
  if (origin !== undefined) headers.origin = origin
  const request = { url, method, headers, socket: { remoteAddress } }
  const buffer = Buffer.from(body ?? '', 'utf8')
  headers['content-length'] = String(buffer.length)
  if (buffer.length > 0) headers['content-type'] = 'application/json'
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

async function callImport(routes, payload, options = {}) {
  const route = routes.find((entry) => entry.path === '/inkflow')
  assert.ok(route, 'expected the /inkflow prefix route')
  const response = fakeResponse()
  await route.handler(
    fakeRequest({ origin: ORIGIN, url: `${INTERNAL}/library/import?sessionId=session-1`, body: JSON.stringify(payload), ...options }),
    response,
  )
  return { status: response.statusCode, json: response.body === undefined ? undefined : JSON.parse(response.body) }
}

test('POST /library/import: plan is read-only, apply needs confirm, and `path` stays refused', async () => {
  const root = book()
  const source = sourceFile('旧稿.txt', Buffer.from(CHAPTERS_SOURCE, 'utf8'))
  const routes = createHarness(root)
  const before = hashTree(root)

  const plan = await callImport(routes, { action: 'plan', sourcePath: source })
  assert.equal(plan.status, 200, JSON.stringify(plan.json))
  assert.equal(plan.json.ok, true)
  assert.equal(plan.json.value.chapters.length, 2)
  assert.equal(hashTree(root), before, 'the preview route must write nothing')

  const noConfirm = await callImport(routes, { action: 'apply', sourcePath: source })
  assert.equal(noConfirm.json.error.code, 'CONFIRM_REQUIRED')
  assert.equal(hashTree(root), before)

  // The project-directory ban (ADR-0008 D4) still holds, and it is TWO nets: `path` is a
  // forbidden path parameter (checked before any body handling) and it is also absent from
  // this route's allowlist. Both are asserted, because a later widening of either one
  // must not silently open the other.
  const pathAttempt = await callImport(routes, { action: 'plan', path: root, sourcePath: source })
  assert.equal(pathAttempt.status, 400, JSON.stringify(pathAttempt.json))
  assert.equal(pathAttempt.json.error.code, 'ROOT_PARAM_NOT_ALLOWED')
  const undeclared = await callImport(routes, { action: 'plan', sourcePath: source, volumeTitle: '上卷' })
  assert.equal(undeclared.status, 400, JSON.stringify(undeclared.json))
  assert.equal(undeclared.json.error.code, 'UNEXPECTED_BODY_FIELD')
  assert.equal(undeclared.json.error.field, 'volumeTitle')
  assert.equal(hashTree(root), before, 'a refused body field writes nothing')

  const applied = await callImport(routes, { action: 'apply', sourcePath: source, confirm: true })
  assert.equal(applied.json.ok, true, JSON.stringify(applied.json))
  assert.equal(chapterFiles(root).length, 2)
})

test('POST /library/import: a cross-site Origin never reaches the handler', async () => {
  const root = book()
  const source = sourceFile('旧稿.txt', Buffer.from(CHAPTERS_SOURCE, 'utf8'))
  const routes = createHarness(root)
  const before = hashTree(root)

  const crossSite = await callImport(routes, { action: 'apply', sourcePath: source, confirm: true }, { origin: 'http://evil.example' })
  assert.equal(crossSite.status, 403, JSON.stringify(crossSite.json))
  assert.equal(hashTree(root), before)
})

/** `inkflow_project_status` is the cheapest way to read the index counts. */
async function describeIndex(root) {
  const routes = createHarness(root)
  const route = routes.find((entry) => entry.path === '/inkflow')
  const response = fakeResponse()
  await route.handler(fakeRequest({ method: 'GET', url: `${INTERNAL}/status?sessionId=session-1` }), response)
  return JSON.parse(response.body).value.index.counts
}

test('the fixture scaffolds what the gate needs (guards against a silently empty book)', () => {
  const root = book()
  assert.equal(existsSync(join(root, 'inkflow.json')), true)
  assert.equal(statSync(join(root, 'chapters')).isDirectory(), true)
  assert.equal(chapterFiles(root).length, 0)
})

// ---------------------------------------------------------------------------
// The tool: inkflow_library_import (plan / apply)
// ---------------------------------------------------------------------------

/** A minimal Host harness: enough of `ctx` for `apply()` to register the tools. */
function makeTools(dataDir, workspace) {
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
      if (name === 'workingDirectory' && typeof workspace === 'string') return { ensure: async () => workspace }
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
    webServer: { register: () => () => {} },
  }
  apply(ctx, { dataDir })
  return tools
}

test('the tool previews, then applies with confirm and the preview token', async () => {
  const root = book()
  const dir = workdir('inkflow-import-tool-')
  const source = sourceFile('旧稿.txt', Buffer.from(CHAPTERS_SOURCE, 'utf8'))
  const tools = makeTools(join(dir, 'state'), root)
  const tool = tools.get('inkflow_library_import')
  assert.ok(tool, 'inkflow_library_import is registered')
  const call = (args) => tool.execute(args, { signal: AbortSignal.timeout(20_000), agent: { id: 'test-session' } })

  const before = hashTree(root)
  const preview = await call({ sourcePath: source })
  assert.equal(preview.ok, true, JSON.stringify(preview))
  assert.equal(preview.action, 'plan')
  assert.equal(preview.chapters.length, 2)
  assert.equal(hashTree(root), before, 'the tool preview writes nothing')

  const noConfirm = await call({ sourcePath: source, action: 'apply' })
  assert.equal(noConfirm.ok, false)
  assert.equal(noConfirm.error.code, 'CONFIRM_REQUIRED')
  assert.equal(hashTree(root), before)

  const applied = await call({ sourcePath: source, action: 'apply', confirm: true, planToken: preview.planToken })
  assert.equal(applied.ok, true, JSON.stringify(applied))
  assert.equal(applied.action, 'apply')
  assert.equal(applied.created.length, 2)
  assert.equal(chapterFiles(root).length, 2)

  // The rendered text is what the model reads: it must name the encoding tier and the
  // chapters, so a wrong split is visible without opening a file.
  const rendered = tool.output.render({}, applied)
  assert.equal(rendered.length, 1)
  assert.match(rendered[0].text, /已导入/u)
  assert.match(rendered[0].text, /utf8/u)
  assert.match(rendered[0].text, /第一章 入山/u)
  assert.match(rendered[0].text, /备份包/u)
})

test('the tool refuses an unknown action instead of silently previewing', async () => {
  const root = book()
  const dir = workdir('inkflow-import-tool2-')
  const source = sourceFile('旧稿.txt', Buffer.from(CHAPTERS_SOURCE, 'utf8'))
  const tools = makeTools(join(dir, 'state'), root)
  const tool = tools.get('inkflow_library_import')
  const call = (args) => tool.execute(args, { signal: AbortSignal.timeout(20_000), agent: { id: 'test-session' } })
  const refused = await call({ sourcePath: source, action: 'write' })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'ACTION_INVALID')
  assert.equal(chapterFiles(root).length, 0)
})

// ---------------------------------------------------------------------------
// The 60万字 acceptance case, end to end
// ---------------------------------------------------------------------------

test('a 200-chapter, 60万字 manuscript imports without losing a paragraph', async (t) => {
  const root = book()
  // 200 chapters × 15 paragraphs × 200 characters, CRLF, UTF-8 with a BOM.
  const lines = []
  const expected = { chapters: 200, paragraphs: 3000, chars: 600_000 }
  for (let chapter = 1; chapter <= 200; chapter += 1) {
    lines.push(`第${chapter}章 章名${chapter}`, '')
    for (let paragraph = 1; paragraph <= 15; paragraph += 1) {
      const unit = `第${chapter}章第${paragraph}段`
      lines.push(`　　${unit}${'文'.repeat(200 - [...unit].length)}`, '')
    }
  }
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join('\r\n'), 'utf8')])
  const source = sourceFile('六十万字.txt', bytes)

  const applied = await applyImport(root, { sourcePath: source, confirm: true })
  assert.equal(applied.ok, true, JSON.stringify(applied).slice(0, 600))
  const value = applied.value

  assert.equal(value.created.length, expected.chapters, 'chapter count')
  assert.equal(value.plan.source.encoding, 'utf8-bom')
  assert.equal(value.plan.source.eol, 'crlf')
  assert.equal(value.plan.totals.paragraphs, expected.paragraphs, 'paragraph count')
  assert.equal(value.plan.totals.chars, expected.chars, 'character count (error must be 0)')

  // The files themselves: same counts read back off disk, not just from the plan.
  const files = chapterFiles(root)
  assert.equal(files.length, expected.chapters)
  let paragraphs = 0
  let chars = 0
  for (const path of files) {
    const body = bodyOf(root, path)
    paragraphs += body.split(/\n[ \t\u3000]*\n/u).filter((block) => block.trim() !== '').length
    chars += [...body.replace(/\s+/gu, '')].length
    const bytesOfFile = readFileSync(join(root, ...path.split('/')))
    assert.equal(bytesOfFile.includes(0x0d), false, `${path} must be LF`)
  }
  assert.equal(paragraphs, expected.paragraphs, 'paragraph count read back from the chapter files')
  assert.equal(chars, expected.chars, 'character count read back from the chapter files')
  assert.equal(value.backup.sealed, true)

  t.diagnostic(
    `${String(value.created.length)} 章 / ${String(paragraphs)} 段 / ${String(chars)} 字 · ` +
      `写出与索引 ${String(Math.round(value.ms))} ms · 备份包 ${String(value.backup.files)} 个文件`,
  )
})
