/**
 * The semantic backend's shape rules, asserted without a server.
 *
 * Everything here is a decision that would fail SILENTLY in production and therefore has to
 * be pinned in a test:
 *
 *   1. **The peer is read, never derived** (ADR-0009 P2 / X-21): local layer wins, the team
 *      layer is the fallback, a layer with `version ≠ 1` contributes nothing (that is what
 *      OVK does with the same file), a non-ASCII id is refused instead of being sent into a
 *      namespace OVK would silently strip to "".
 *   2. **Blocks are a stable, idempotent address** (P5): URI = projectId + chapterId + index,
 *      so a rebuild overwrites rather than appends.
 *   3. **Chunking is bounded and offset-truthful**: every block's `charStart/charEnd` points
 *      at the text it contains, because the recall side cuts its snippet out of the chapter
 *      by exactly those offsets (P7's locating chain).
 *   4. **Two grep guards for the boundaries that matter more than any single behaviour**:
 *      the code must not read OVK's machine config (ADR-0020 E1), and `forget` must not
 *      appear on any writing or deleting path (P6).
 *
 * The end-to-end behaviour against an HTTP stub lives in `tests/ovk.stub.test.js`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PEER_ID_PATTERN,
  blockContentOf,
  blockTagsOf,
  blockUriOf,
  chunkBody,
  contentHashOf,
  hitsOf,
  parseBlockUri,
  projectSubtreeUri,
  resolveOvkPeer,
  tombstoneContentOf,
} from '../lib/index.js'

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-ovk-'))
}

/** A book directory with (optionally) one `.openviking` layer. */
function bookWith(dir, layers) {
  const root = join(dir, 'book')
  mkdirSync(join(root, '.openviking'), { recursive: true })
  for (const [file, content] of Object.entries(layers)) {
    writeFileSync(join(root, '.openviking', file), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`, 'utf8')
  }
  return root
}

// ---------------------------------------------------------------------------
// 1. Peer resolution: read-only, layered, no repair
// ---------------------------------------------------------------------------

test('peer: config.local.json wins over config.json, and the source is reported', () => {
  const dir = workdir()
  try {
    const root = bookWith(dir, {
      'config.local.json': { version: 1, peer: { id: 'book-local' } },
      'config.json': { version: 1, peer: { id: 'book-team' } },
    })
    const resolution = resolveOvkPeer(root)
    assert.equal(resolution.peer, 'book-local')
    assert.equal(resolution.source, 'local')
    assert.equal(resolution.configPath, '.openviking/config.local.json')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('peer: the team layer is the fallback when there is no local layer', () => {
  const dir = workdir()
  try {
    const root = bookWith(dir, { 'config.json': { version: 1, peer: { id: 'book-team' } } })
    const resolution = resolveOvkPeer(root)
    assert.equal(resolution.peer, 'book-team')
    assert.equal(resolution.source, 'team')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('peer: no config at all is `no-config`, and nothing is invented', () => {
  const dir = workdir()
  try {
    const root = bookWith(dir, {})
    const resolution = resolveOvkPeer(root)
    assert.equal(resolution.peer, undefined, 'a peer is never derived from the directory name (P2)')
    assert.equal(resolution.problem, 'no-config')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('peer: `version: 2` makes the layer unusable instead of being repaired', () => {
  const dir = workdir()
  try {
    const root = bookWith(dir, { 'config.local.json': { version: 2, peer: { id: 'book-x' } } })
    const resolution = resolveOvkPeer(root)
    assert.equal(resolution.peer, undefined)
    assert.equal(resolution.problem, 'version-mismatch')
    assert.match(resolution.detail, /version 2/)
    // The file is untouched: OVK owns it, and a "helpful" rewrite here would be a silent
    // second implementation of its validation.
    const raw = readFileSync(join(root, '.openviking', 'config.local.json'), 'utf8')
    assert.equal(JSON.parse(raw).version, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('peer: a file above 64 KiB is ignored (OVK ignores that layer)', () => {
  const dir = workdir()
  try {
    const padding = 'x'.repeat(70 * 1024)
    const root = bookWith(dir, { 'config.local.json': `{"version":1,"peer":{"id":"book-big"},"pad":"${padding}"}` })
    const resolution = resolveOvkPeer(root)
    assert.equal(resolution.peer, undefined)
    assert.equal(resolution.problem, 'too-large')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('peer: a non-ASCII id is refused with the reason OVK would hide', () => {
  const dir = workdir()
  try {
    const root = bookWith(dir, { 'config.local.json': { version: 1, peer: { id: '蜀山' } } })
    const resolution = resolveOvkPeer(root)
    assert.equal(resolution.peer, undefined)
    assert.equal(resolution.problem, 'non-ascii')
    assert.match(resolution.detail, /ASCII/)
    assert.equal(PEER_ID_PATTERN.test('蜀山'), false)
    assert.equal(PEER_ID_PATTERN.test('book-1.2_ok@x'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('peer: peer.source without peer.id is reported, never expanded by a second template chain', () => {
  const dir = workdir()
  try {
    const root = bookWith(dir, { 'config.local.json': { version: 1, peer: { source: 'git' } } })
    const resolution = resolveOvkPeer(root)
    assert.equal(resolution.peer, undefined)
    assert.equal(resolution.problem, 'source-only')
    assert.match(resolution.detail, /peer\.id/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('peer: broken JSON reads as unreadable, not as a crash', () => {
  const dir = workdir()
  try {
    const root = bookWith(dir, { 'config.local.json': '{ not json' })
    const resolution = resolveOvkPeer(root)
    assert.equal(resolution.peer, undefined)
    assert.equal(resolution.problem, 'unreadable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. Block addresses: fixed URI, stable hash
// ---------------------------------------------------------------------------

test('blocks: one URI per (project, chapter, index), and it parses back', () => {
  const uri = blockUriOf('book-abc123', 'ch-0001', 3)
  assert.equal(uri, 'viking://resources/inkflow/book-abc123/chapters/ch-0001/3.md')
  assert.equal(projectSubtreeUri('book-abc123'), 'viking://resources/inkflow/book-abc123')
  assert.deepEqual(parseBlockUri(uri), { projectId: 'book-abc123', chapterId: 'ch-0001', blockIndex: 3 })
  // A URI this plugin did not write is not parsed as one of ours.
  assert.equal(parseBlockUri('viking://resources/somebody-else/doc.md'), undefined)
  assert.equal(parseBlockUri('viking://user/1/peers/p/memories/x.md'), undefined)
})

test('blocks: a project id cannot escape its subtree', () => {
  // `projectId` can come from a hand-edited `inkflow.json`; a slash in it would move every
  // block into a sibling tree and the recall target would no longer contain them.
  assert.equal(blockUriOf('a/../b', 'ch-1', 0), 'viking://resources/inkflow/a-..-b/chapters/ch-1/0.md')
  assert.equal(projectSubtreeUri('   '), 'viking://resources/inkflow/book')
})

test('blocks: contentHash is the sha256 of the exact text written', () => {
  assert.equal(contentHashOf('云海翻涌'), contentHashOf('云海翻涌'))
  assert.notEqual(contentHashOf('云海翻涌'), contentHashOf('云海翻涌。'))
  assert.match(contentHashOf(''), /^[0-9a-f]{64}$/)
})

test('blocks: the document and its tags carry the locating metadata, and a tombstone carries none of the prose', () => {
  const block = { index: 0, text: '他握着那把残锋。', charStart: 0, charEnd: 8 }
  const metadata = { projectId: 'book-1', chapterId: 'ch-1', blockIndex: 0, contentHash: 'abc', deleted: false, seq: 3, title: '第一章' }
  const content = blockContentOf(block, metadata)
  assert.equal(content.includes('他握着那把残锋。'), true)
  assert.equal(content.includes('ch-1'), true, 'the OVK file is readable by a human')
  const tags = blockTagsOf(metadata)
  assert.equal(tags.includes('inkflow:project=book-1'), true)
  assert.equal(tags.includes('inkflow:chapter=ch-1'), true)
  assert.equal(tags.includes('inkflow:hash=abc'), true)
  assert.equal(tags.some((tag) => tag === 'inkflow:deleted=true'), false)

  const tombstone = tombstoneContentOf({ ...metadata, deleted: true }, '2026-10-24T00:00:00.000Z')
  assert.equal(tombstone.includes('残锋'), false, 'a tombstone must not keep a byte of the deleted prose')
  assert.match(tombstone, /tombstone/)
  assert.equal(blockTagsOf({ ...metadata, deleted: true }).includes('inkflow:deleted=true'), true)
})

// ---------------------------------------------------------------------------
// 3. Chunking: bounded, overlapping, offset-truthful
// ---------------------------------------------------------------------------

test('chunking: blocks respect the limit and overlap by the configured amount', () => {
  const paragraph = (n) => `${'甲'.repeat(199)}${String(n)}\n\n`
  const body = [1, 2, 3, 4, 5].map((n) => paragraph(n)).join('')
  const blocks = chunkBody(body, { chars: 400, overlap: 50 })
  assert.ok(blocks.length > 1, 'five 200-character paragraphs cannot be one 400-character block')
  for (const block of blocks) {
    assert.ok(block.charEnd - block.charStart <= 400, `block ${String(block.index)} is ${String(block.charEnd - block.charStart)} characters`)
    // The offsets are the locating contract (P7): the slice must be the block's own text.
    assert.equal(body.slice(block.charStart, block.charEnd), block.text)
  }
  // Consecutive blocks overlap: the second one starts before the first one ended.
  assert.ok(blocks[1].charStart < blocks[0].charEnd, 'the overlap must carry text into the next block')
  assert.equal(blocks[0].charStart, 0)
  // The last span stops at the last paragraph: trailing blank lines are not prose, so the
  // block need not cover them — what matters is that no text before it is missing.
  assert.equal(body.slice(0, blocks.at(-1).charEnd).trimEnd(), body.trimEnd())
})

test('chunking: an empty or whitespace-only chapter produces no blocks at all', () => {
  assert.deepEqual(chunkBody(''), [])
  assert.deepEqual(chunkBody('   \n\n \t\n'), [])
  assert.deepEqual(chunkBody(' \n '), [])
})

test('chunking: one paragraph longer than the limit is hard-split at the limit', () => {
  const body = '乙'.repeat(1000)
  const blocks = chunkBody(body, { chars: 300, overlap: 20 })
  assert.ok(blocks.length >= 4)
  for (const block of blocks) assert.ok(block.charEnd - block.charStart <= 300)
  assert.equal(blocks[0].charStart, 0)
  assert.equal(blocks.at(-1).charEnd, 1000)
})

test('chunking: a short chapter is one block, and its offsets cover the body', () => {
  const body = '第一段。\n\n第二段。\n'
  const blocks = chunkBody(body, { chars: 800, overlap: 100 })
  assert.equal(blocks.length, 1)
  assert.deepEqual(blocks[0], { index: 0, text: body, charStart: 0, charEnd: body.length })
})

// ---------------------------------------------------------------------------
// 4. Reading OVK's FindResult
// ---------------------------------------------------------------------------

test('recall: hits are read from every bucket and ranked high-score-first', () => {
  const document = {
    status: 'ok',
    result: {
      memories: [{ uri: 'viking://user/1/memories/a.md', score: 0.4, abstract: '一个' }],
      resources: [
        { uri: 'viking://resources/inkflow/book/chapters/ch-1/0.md', score: 0.9, abstract: '两个' },
        { uri: 'viking://resources/inkflow/book/chapters/ch-2/0.md', score: 0.7 },
      ],
      skills: [],
      total: 3,
    },
  }
  const hits = hitsOf(document)
  assert.deepEqual(
    hits.map((hit) => [hit.uri.split('/').at(-2), hit.score]),
    [
      ['ch-1', 0.9],
      ['ch-2', 0.7],
      ['memories', 0.4],
    ].map(([chapter, score]) => [chapter, score]),
  )
  // An entry without a uri cannot be located at all, so it is not a hit.
  assert.equal(hitsOf({ result: { resources: [{ score: 1 }] } }).length, 0)
})

// ---------------------------------------------------------------------------
// 5. The two grep guards (the boundaries that outlive any single behaviour)
// ---------------------------------------------------------------------------

const HOST_DIR = new URL('../src/host/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1')

function ovkSources() {
  return readdirSync(HOST_DIR)
    .filter((file) => /^ovk.*\.ts$/u.test(file))
    .map((file) => ({ file, text: readFileSync(join(HOST_DIR, file), 'utf8') }))
}

test('guard: no code reads OpenViking\'s machine config (ADR-0020 E1)', () => {
  const sources = ovkSources()
  assert.ok(sources.length >= 4, 'the semantic modules must be findable by this guard')
  for (const source of sources) {
    for (const banned of ['ov.conf', 'ovcli.conf', 'ovcli.settings.conf']) {
      assert.equal(
        source.text.includes(banned),
        false,
        `${source.file} mentions ${banned}; the endpoint and key come from the plugin settings, never from OVK's machine config`,
      )
    }
  }
})

test('guard: `forget` appears only on the purge path (ADR-0009 P6)', () => {
  // The transport defines it; `ovk-status.ts`'s purge action calls it. Anywhere else — a
  // rebuild, a chapter delete, the trash — would turn "delete a chapter" into an
  // unrecoverable action, which is precisely the red line P6 draws.
  const sources = ovkSources()
  const callers = sources.filter((source) => source.text.includes('ovkForget')).map((source) => source.file).sort()
  assert.deepEqual(
    callers,
    ['ovk-status.ts', 'ovk.ts'],
    `only the transport and the purge action may mention the physical delete, found: ${callers.join(', ')}`,
  )
  for (const file of ['ovk-queue.ts', 'ovk-ledger.ts', 'ovk-search.ts', 'ovk-tools.ts']) {
    const source = sources.find((entry) => entry.file === file)
    assert.ok(source, `${file} must exist for this guard to mean anything`)
    assert.equal(source.text.includes('ovkForget'), false, `${file} must not be able to forget blocks`)
  }
  // The book's own write paths (chapter delete, trash, replace, import) are the ones a
  // future "clean up the index after deleting" change would touch first.
  for (const file of ['chapters.ts', 'internal.ts', 'trash.ts', 'replace.ts', 'import-write.ts']) {
    const text = readFileSync(join(HOST_DIR, file), 'utf8')
    assert.equal(text.includes('ovkForget'), false, `${file} must not call the physical delete`)
  }
})
