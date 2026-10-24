/**
 * The diagnostics package: a whitelist that leaves the machine (ADR-0018 D5, X-22).
 *
 * The one assertion this file exists for is an ABSENCE test, so the fixture plants
 * every kind of thing that must never travel — a chapter's prose, a `.env`, a
 * credentials file and OpenViking's private peer file — and then searches the written
 * package for each of those strings. A second pass proves the machine is not named
 * either: no absolute path survives, and what came from under the home directory
 * reads as `~/…`.
 *
 * Runs against the built artifact (`../lib/index.js`).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DIAGNOSTICS_FORMAT,
  DIAGNOSTICS_LOG_LINES,
  buildDiagnostics,
  ensureIndex,
  exportDiagnostics,
  maskPath,
  settingsPath,
  toolSurfaceHash,
  writeSettings,
} from '../lib/index.js'
import { hashTree } from './hash-tree.mjs'

const NINE = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']

/** Strings that must be absent from the package, one planted in each sensitive file. */
const SECRETS = {
  prose: '这一段正文绝对不该出现在诊断包里-7f3a',
  envValue: 'sk-live-DO-NOT-SHIP-9c1d2e',
  credentials: 'correct-horse-battery-staple-4b8e',
  peer: 'peer-secret-0a1b2c3d',
}

function fixture() {
  const parent = mkdtempSync(join(tmpdir(), 'inkflow-diagnostics-'))
  const root = join(parent, '诊断书')
  for (const dir of [...NINE, 'index']) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '诊断书' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.gitignore'), 'index/*.db\n', 'utf8')
  mkdirSync(join(root, 'chapters', 'vol-01'), { recursive: true })
  writeFileSync(join(root, 'chapters', 'vol-01', '0001-a.md'), `---\ntitle: 一\n---\n\n${SECRETS.prose}\n`, 'utf8')
  // The three files D5 forbids outright, plus the OVK private layer.
  writeFileSync(join(root, '.env'), `DSH_TOKEN=${SECRETS.envValue}\n`, 'utf8')
  writeFileSync(join(root, '.credentials.yaml'), `password: ${SECRETS.credentials}\n`, 'utf8')
  mkdirSync(join(root, '.openviking'), { recursive: true })
  writeFileSync(join(root, '.openviking', 'config.local.json'), `${JSON.stringify({ version: 1, peer: { id: SECRETS.peer } })}\n`, 'utf8')
  return { parent, root, dataDir: join(parent, 'state'), cleanup: () => rmSync(parent, { recursive: true, force: true }) }
}

test('the package carries the whole whitelist and nothing that names the machine', async () => {
  const f = fixture()
  try {
    const ensured = await ensureIndex(f.root, { rebuild: true })
    assert.equal(ensured.ok, true, JSON.stringify(ensured))
    writeSettings(f.dataDir, { backupKeep: 7, authorName: '作者', sharedRoot: f.dataDir })

    const exported = exportDiagnostics({ dataDir: f.dataDir, version: '9.9.9', bookRoot: f.root, at: new Date('2026-10-24T09:30:00Z') })
    assert.equal(exported.ok, true, JSON.stringify(exported))
    const doc = exported.value.document

    // --- the whitelist, field by field (D5) ---
    assert.equal(doc.format, DIAGNOSTICS_FORMAT)
    assert.equal(doc.generatedAt, '2026-10-24T09:30:00.000Z')
    assert.equal(doc.plugin.version, '9.9.9')
    assert.equal(typeof doc.plugin.build.build, 'string')
    assert.equal(typeof doc.plugin.build.loadedAt, 'string')
    assert.deepEqual(doc.plugin.engines, { node: '>=22.12.0', dsh: '>=0.2.1-rc.2' })
    assert.equal(doc.runtime.node, process.versions.node)
    assert.equal(doc.runtime.platform, process.platform)
    assert.equal(doc.runtime.arch, process.arch)
    assert.equal(typeof doc.runtime.icuSmall, 'boolean')
    // Settings travel masked, but their VALUES are the point of the section.
    assert.equal(doc.settings.values.backupKeep, 7)
    assert.equal(doc.settings.values.authorName, '作者')
    assert.equal(typeof doc.settings.values.sharedRoot, 'string')
    // Index metadata: user_version / fileCount / entityCount / last rebuild + per-domain.
    assert.equal(doc.book?.slug, '诊断书')
    assert.equal(doc.book?.index.available, true)
    assert.equal(doc.book?.index.userVersion, doc.book?.index.expectedUserVersion)
    assert.ok((doc.book?.index.fileCount ?? 0) >= 1)
    assert.ok((doc.book?.index.entityCount ?? 0) >= 1)
    assert.equal(typeof doc.book?.index.builtAt, 'string')
    assert.ok(Object.keys(doc.book?.index.byKind ?? {}).length >= 1)
    assert.ok(Object.keys(doc.book?.index.tableCounts ?? {}).includes('chapters'))
    assert.equal(doc.book?.index.freshness, 'fresh')
    // Logs: present and honestly unavailable, never silently missing.
    assert.equal(doc.logs.available, false)
    assert.equal(doc.logs.requestedLines, DIAGNOSTICS_LOG_LINES)
    assert.ok(doc.logs.reason.length > 20)
    assert.ok(doc.summary.length > 3)

    // --- the absentees: no body text, no .env, no credentials, no OVK peer ---
    const text = readFileSync(exported.value.path, 'utf8')
    for (const [kind, secret] of Object.entries(SECRETS)) {
      assert.equal(text.includes(secret), false, `${kind} leaked into the diagnostics package`)
    }
    // And no absolute path: neither the fixture's own directory nor the home directory.
    assert.equal(text.includes(f.parent.replaceAll('\\', '/')), false, 'an absolute path leaked')
    assert.equal(text.includes(f.parent.replaceAll('/', '\\')), false, 'a native absolute path leaked')
    if (homedir() !== '') {
      assert.equal(text.includes(homedir().replaceAll('\\', '/')), false, 'the home directory leaked')
    }
    assert.match(exported.value.displayPath, /^~|^<absolute>/u)
  } finally {
    f.cleanup()
  }
})

test('settings paths are replaced with ~/… and a relative value stays relative', () => {
  const f = fixture()
  try {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? homedir()
    assert.equal(maskPath(join(home, 'books', '我的书'), home), '~/books/我的书')
    assert.equal(maskPath(join(home, 'books', '我的书'), home, join(home, 'books', '我的书')), '<book>')
    assert.equal(maskPath(join(home, 'books', '我的书', 'chapters'), home, join(home, 'books', '我的书')), '<book>/chapters')
    // A path on another volume keeps one segment and says the rest was dropped.
    assert.match(maskPath('E:\\elsewhere\\secret-name.txt', home), /^<absolute>\/secret-name\.txt$/u)
    // A relative value is not a path to hide.
    assert.equal(maskPath('libs', home), 'libs')

    writeSettings(f.dataDir, { sharedRoot: join(home, 'shared-root') })
    const doc = buildDiagnostics({ dataDir: f.dataDir, version: '1.0.0' })
    assert.equal(doc.settings.values.sharedRoot, '~/shared-root')
  } finally {
    f.cleanup()
  }
})

test('a broken settings file shows up as a warning field instead of breaking the export', () => {
  const f = fixture()
  try {
    mkdirSync(f.dataDir, { recursive: true })
    writeFileSync(settingsPath(f.dataDir), '{ broken', 'utf8')
    const doc = buildDiagnostics({ dataDir: f.dataDir, version: '1.0.0' })
    assert.equal(doc.settings.warn?.code, 'SETTINGS_UNREADABLE')
    // The package is still written: a broken setting is exactly what a maintainer needs
    // to see, so it must not be the reason the export fails.
    const exported = exportDiagnostics({ dataDir: f.dataDir, version: '1.0.0' })
    assert.equal(exported.ok, true)
  } finally {
    f.cleanup()
  }
})

test('exporting writes exactly one file under dataDir/diagnostics and touches no book', () => {
  const f = fixture()
  try {
    const before = hashTree(f.root)
    const exported = exportDiagnostics({ dataDir: f.dataDir, version: '1.0.0', bookRoot: f.root, at: new Date('2026-10-24T09:30:00Z') })
    assert.equal(exported.ok, true)
    assert.equal(exported.value.path, join(f.dataDir, 'diagnostics', '20261024-093000.json'))
    assert.equal(existsSync(exported.value.path), true)
    assert.equal(hashTree(f.root), before, 'a diagnostics export must not write inside the book')
  } finally {
    f.cleanup()
  }
})

test('a book-less package is legal and says so, and a missing index is reported not thrown', () => {
  const f = fixture()
  try {
    const doc = buildDiagnostics({ dataDir: f.dataDir, version: '1.0.0' })
    assert.equal(doc.book, null)
    assert.ok(doc.summary.some((line) => line.includes('book: none in scope')))

    // `ensureIndex` never ran for this fixture, so a book that has an `index/`
    // directory but no database is REPORTED, not rebuilt (a diagnostics export must not
    // change the tree it describes).
    const withBook = buildDiagnostics({ dataDir: f.dataDir, version: '1.0.0', bookRoot: f.root })
    assert.equal(withBook.book?.index.available, false)
    assert.equal(typeof withBook.book?.index.reason, 'string')
    const missingDir = join(f.parent, 'empty-book')
    mkdirSync(join(missingDir, 'index'), { recursive: true })
    const missing = buildDiagnostics({ dataDir: f.dataDir, version: '1.0.0', bookRoot: missingDir })
    assert.equal(missing.book?.index.available, false)
    assert.equal(typeof missing.book?.index.reason, 'string')
  } finally {
    f.cleanup()
  }
})

test('the tool surface list is a name plus a stable hash of the model-facing shape', () => {
  const hashA = toolSurfaceHash({ name: 'inkflow_x', description: 'a', parameters: { type: 'object' }, output: { schema: { type: 'object' } } })
  const hashB = toolSurfaceHash({ name: 'inkflow_x', description: 'a', parameters: { type: 'object' }, output: { schema: { type: 'object' } } })
  const hashC = toolSurfaceHash({ name: 'inkflow_x', description: 'changed', parameters: { type: 'object' }, output: { schema: { type: 'object' } } })
  assert.equal(hashA, hashB, 'the hash must be stable for the same surface')
  assert.notEqual(hashA, hashC, 'a changed description must move the hash')
  assert.match(hashA, /^[0-9a-f]{8}$/u)

  const f = fixture()
  try {
    const doc = buildDiagnostics({
      dataDir: f.dataDir,
      version: '1.0.0',
      tools: [
        { name: 'inkflow_b', description: 'b' },
        { name: 'inkflow_a', description: 'a' },
      ],
    })
    assert.equal(doc.tools.count, 2)
    assert.deepEqual(doc.tools.entries.map((entry) => entry.name), ['inkflow_a', 'inkflow_b'])
  } finally {
    f.cleanup()
  }
})
