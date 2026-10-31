/**
 * Settings: the four bad inputs, the write's immediacy, and the one promise that
 * matters most — a settings save touches NO book (ADR-0018 D1/D2).
 *
 * Runs against the built artifact (`../lib/index.js`), like every other contract test:
 * the thing users install is the bundle, not the sources.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SETTINGS_DEFAULTS,
  SETTINGS_FILE,
  SETTINGS_SCHEMA_VERSION,
  buildDiagnostics,
  coerceSettings,
  readSettings,
  settingsOf,
  settingsPath,
  sharedRootOf,
  writeSettings,
} from '../lib/index.js'
import { hashTree } from './hash-tree.mjs'

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'inkflow-settings-'))
  return {
    root,
    dataDir: join(root, 'state'),
    book: join(root, 'book'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function writeRaw(dataDir, text) {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(settingsPath(dataDir), text, 'utf8')
}

test('a missing file reads as the defaults and reports no warning', () => {
  const { dataDir, cleanup } = workspace()
  try {
    const read = readSettings(dataDir)
    assert.equal(read.source, 'default')
    assert.equal(read.warn, undefined)
    assert.deepEqual(read.settings, {
      semanticSearch: SETTINGS_DEFAULTS.semanticSearch,
      autosaveIntervalMs: SETTINGS_DEFAULTS.autosaveIntervalMs,
      excludeDirs: [],
      backupKeep: SETTINGS_DEFAULTS.backupKeep,
      // The delegation switch defaults to OFF: a machine that never opened the settings
      // page must keep today's behaviour (the session's own agent writes the chapter).
      subagentEnabled: SETTINGS_DEFAULTS.subagentEnabled,
    })
    // …and the two optional halves are ABSENT rather than empty strings, so "never set"
    // and "set to empty" stay distinguishable in the file and on the wire.
    assert.equal(Object.prototype.hasOwnProperty.call(read.settings, 'subagentProvider'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(read.settings, 'subagentModel'), false)
  } finally {
    cleanup()
  }
})

test('bad input 1 — invalid JSON reads as defaults plus one warning, and does not throw', () => {
  const { dataDir, cleanup } = workspace()
  try {
    writeRaw(dataDir, '{ "backupKeep": 3, ')
    const read = readSettings(dataDir)
    assert.equal(read.source, 'default')
    assert.equal(read.warn?.code, 'SETTINGS_UNREADABLE')
    assert.equal(read.settings.backupKeep, SETTINGS_DEFAULTS.backupKeep)
  } finally {
    cleanup()
  }
})

test('bad input 2 — a JSON document that is not an object reads as defaults plus a warning', () => {
  const { dataDir, cleanup } = workspace()
  try {
    writeRaw(dataDir, '[1, 2, 3]')
    const read = readSettings(dataDir)
    assert.equal(read.source, 'default')
    assert.equal(read.warn?.code, 'SETTINGS_NOT_OBJECT')
    assert.equal(read.settings.backupKeep, SETTINGS_DEFAULTS.backupKeep)
  } finally {
    cleanup()
  }
})

test('bad input 3 — out-of-range numbers are clamped to the documented bounds', () => {
  const { dataDir, cleanup } = workspace()
  try {
    writeRaw(
      dataDir,
      JSON.stringify({ schemaVersion: 1, autosaveIntervalMs: 5, backupKeep: 9999 }),
    )
    const read = readSettings(dataDir)
    assert.equal(read.source, 'file')
    assert.equal(read.warn, undefined)
    assert.equal(read.settings.autosaveIntervalMs, 500)
    assert.equal(read.settings.backupKeep, 50)

    writeRaw(dataDir, JSON.stringify({ schemaVersion: 1, autosaveIntervalMs: -1, backupKeep: 0 }))
    const low = readSettings(dataDir)
    assert.equal(low.settings.autosaveIntervalMs, 500)
    assert.equal(low.settings.backupKeep, 1)
  } finally {
    cleanup()
  }
})

test('bad input 4 — a wrong type falls back to that field\'s default, and missing fields do too', () => {
  const { dataDir, cleanup } = workspace()
  try {
    writeRaw(
      dataDir,
      JSON.stringify({
        schemaVersion: 1,
        semanticSearch: 'yes',
        autosaveIntervalMs: '1500',
        authorName: 42,
        excludeDirs: 'chapters',
        backupKeep: null,
      }),
    )
    const read = readSettings(dataDir)
    assert.equal(read.source, 'file')
    assert.equal(read.settings.semanticSearch, SETTINGS_DEFAULTS.semanticSearch)
    assert.equal(read.settings.autosaveIntervalMs, SETTINGS_DEFAULTS.autosaveIntervalMs)
    assert.equal(read.settings.authorName, undefined)
    assert.deepEqual(read.settings.excludeDirs, [])
    assert.equal(read.settings.backupKeep, SETTINGS_DEFAULTS.backupKeep)
  } finally {
    cleanup()
  }
})

test('a BOM saved by a Windows editor does not lose every setting', () => {
  const { dataDir, cleanup } = workspace()
  try {
    writeRaw(dataDir, `\uFEFF${JSON.stringify({ schemaVersion: 1, backupKeep: 9 })}`)
    const read = readSettings(dataDir)
    assert.equal(read.warn, undefined)
    assert.equal(read.settings.backupKeep, 9)
  } finally {
    cleanup()
  }
})

test('a newer schemaVersion is read (known fields) and the file is never overwritten', () => {
  const { dataDir, cleanup } = workspace()
  try {
    const original = `${JSON.stringify({ schemaVersion: SETTINGS_SCHEMA_VERSION + 1, backupKeep: 7, futureKnob: true }, null, 2)}\n`
    writeRaw(dataDir, original)
    const read = readSettings(dataDir)
    assert.equal(read.warn?.code, 'SETTINGS_NEWER_VERSION')
    assert.equal(read.settings.backupKeep, 7)

    const written = writeSettings(dataDir, { backupKeep: 2 })
    assert.equal(written.ok, false)
    assert.equal(written.error.code, 'SETTINGS_NEWER_VERSION')
    // The refusal wrote nothing: a newer plugin's fields are still there.
    assert.equal(readFileSync(settingsPath(dataDir), 'utf8'), original)
  } finally {
    cleanup()
  }
})

test('a write is merged, atomic, immediately readable, and only the whitelist lands on disk', () => {
  const { dataDir, cleanup } = workspace()
  try {
    writeRaw(dataDir, JSON.stringify({ schemaVersion: 1, authorName: '旧名', backupKeep: 3 }))
    const written = writeSettings(dataDir, { semanticSearch: true, unknownKnob: 'ignored', autosaveIntervalMs: 2000 })
    assert.equal(written.ok, true)
    assert.deepEqual(written.value.changed, ['semanticSearch', 'autosaveIntervalMs'])

    // Immediately readable — no cache, no restart (D2).
    const read = readSettings(dataDir)
    assert.equal(read.settings.semanticSearch, true)
    assert.equal(read.settings.autosaveIntervalMs, 2000)
    // The fields the patch omitted kept their values (merge, not replace).
    assert.equal(read.settings.authorName, '旧名')
    assert.equal(read.settings.backupKeep, 3)

    const onDisk = JSON.parse(readFileSync(settingsPath(dataDir), 'utf8'))
    assert.equal(onDisk.schemaVersion, SETTINGS_SCHEMA_VERSION)
    assert.equal(Object.prototype.hasOwnProperty.call(onDisk, 'unknownKnob'), false)
    // Every whitelist field is written (required ones always, so the file states its
    // own defaults instead of leaving them implicit); nothing outside the whitelist is.
    assert.deepEqual(Object.keys(onDisk).sort(), [
      'authorName',
      'autosaveIntervalMs',
      'backupKeep',
      'excludeDirs',
      'schemaVersion',
      'semanticSearch',
      'subagentEnabled',
    ])
  } finally {
    cleanup()
  }
})

test('null clears an optional field and resets a required one to its default', () => {
  const { dataDir, cleanup } = workspace()
  try {
    writeSettings(dataDir, { authorName: '名字', backupKeep: 12 })
    assert.equal(settingsOf(dataDir).backupKeep, 12)

    const cleared = writeSettings(dataDir, { authorName: null, backupKeep: null })
    assert.equal(cleared.ok, true)
    const settings = settingsOf(dataDir)
    assert.equal(settings.authorName, undefined)
    assert.equal(settings.backupKeep, SETTINGS_DEFAULTS.backupKeep)
  } finally {
    cleanup()
  }
})

test('excludeDirs keeps book-relative names only, de-duplicated', () => {
  try {
    const settings = coerceSettings({
      excludeDirs: ['drafts/', 'drafts', '.\\scratch\\tmp', '../escape', '/abs/path', 'C:\\outside', '', 7],
    })
    assert.deepEqual(settings.excludeDirs, ['drafts', 'scratch/tmp', 'abs/path'])
  } finally {
    // Pure call: nothing to clean up. Kept symmetric with the other cases.
  }
})

test('a save touches no book: the whole tree hash of the book is unchanged', () => {
  const { dataDir, book, cleanup } = workspace()
  try {
    mkdirSync(join(book, 'chapters'), { recursive: true })
    writeFileSync(join(book, 'inkflow.json'), '{"schemaVersion":1,"title":"书"}\n')
    writeFileSync(join(book, 'chapters', '0001-a.md'), '# 一\n')
    const before = hashTree(book)

    const written = writeSettings(dataDir, { backupKeep: 9, authorName: '作者', semanticSearch: true })
    assert.equal(written.ok, true)
    writeSettings(dataDir, { sharedRoot: join(dataDir, 'shared') })

    assert.equal(hashTree(book), before, 'settings must never write inside a book (D1)')
    // And the settings really did land, so the assertion above is not vacuous.
    assert.equal(settingsOf(dataDir).backupKeep, 9)
    assert.equal(settingsOf(dataDir).sharedRoot, join(dataDir, 'shared'))
  } finally {
    cleanup()
  }
})

test('an absolute sharedRoot is used, and an unset one is dataDir/shared with no warning', () => {
  const { dataDir, cleanup } = workspace()
  try {
    const fallback = join(dataDir, 'shared')

    const unset = sharedRootOf(dataDir)
    assert.equal(unset.root, fallback, 'the default is config.ts\'s dataDir/shared (ADR-0007 C1)')
    assert.equal(unset.source, 'default')
    assert.equal(unset.warning, undefined, 'an unset field is not a problem to report')

    // Absolute on every platform by construction: the rule is lexical, so a Windows
    // path written on a Linux CI runner is still "absolute" (and vice versa).
    writeSettings(dataDir, { sharedRoot: 'D:\\novel-shared' })
    const configured = sharedRootOf(dataDir)
    assert.equal(configured.root, 'D:\\novel-shared')
    assert.equal(configured.source, 'setting')
    assert.equal(configured.warning, undefined)
  } finally {
    cleanup()
  }
})

test('a relative or escaping sharedRoot is ignored: the default stays, with one warning', () => {
  const { dataDir, cleanup } = workspace()
  try {
    const fallback = join(dataDir, 'shared')
    const cases = ['libs', 'libs/nested', '..', '../outside', 'libs/../../outside', 'C:\\libs\\..\\outside']

    for (const configured of cases) {
      writeSettings(dataDir, { sharedRoot: configured })
      const resolved = sharedRootOf(dataDir)
      assert.equal(resolved.root, fallback, `${configured} must not become the shared root`)
      assert.equal(resolved.source, 'default', `${configured} is not in effect`)
      assert.equal(resolved.warning?.code, 'SHARED_ROOT_IGNORED', `${configured} must be reported, not thrown`)
      assert.match(String(resolved.warning?.message), /sharedRoot/, 'the warning names the field')
    }
  } finally {
    cleanup()
  }
})

test('the settings file name is the single constant, and the reply names it', () => {
  const { dataDir, cleanup } = workspace()
  try {
    writeSettings(dataDir, { backupKeep: 2 })
    assert.ok(settingsPath(dataDir).endsWith(SETTINGS_FILE))
  } finally {
    cleanup()
  }
})

// ---------------------------------------------------------------------------
// The delegation fields: round trip, and the four bad hand edits (D2)
// ---------------------------------------------------------------------------

test('the delegation fields round-trip, and only a real value is written', () => {
  const { dataDir, cleanup } = workspace()
  try {
    const written = writeSettings(dataDir, {
      subagentEnabled: true,
      subagentProvider: 'deepseek-account',
      subagentModel: 'deepseek-v4-pro',
    })
    assert.equal(written.ok, true)
    assert.deepEqual(written.value.changed, ['subagentEnabled', 'subagentProvider', 'subagentModel'])

    const read = readSettings(dataDir)
    assert.equal(read.source, 'file')
    assert.equal(read.settings.subagentEnabled, true)
    assert.equal(read.settings.subagentProvider, 'deepseek-account')
    assert.equal(read.settings.subagentModel, 'deepseek-v4-pro')
    // Adding fields is not a schema change: the stamped version stays 1 (a bump would make
    // every older build refuse to write the file).
    const onDisk = JSON.parse(readFileSync(settingsPath(dataDir), 'utf8'))
    assert.equal(onDisk.schemaVersion, SETTINGS_SCHEMA_VERSION)

    // `null` clears an optional half, and clearing leaves the KEY absent, never "".
    writeSettings(dataDir, { subagentModel: null })
    const cleared = JSON.parse(readFileSync(settingsPath(dataDir), 'utf8'))
    assert.equal(Object.prototype.hasOwnProperty.call(cleared, 'subagentModel'), false)
    assert.equal(cleared.subagentProvider, 'deepseek-account')
  } finally {
    cleanup()
  }
})

test('a hand-edited delegation value that cannot be used reads as not configured, and is reported', () => {
  const { dataDir, cleanup } = workspace()
  try {
    writeRaw(
      dataDir,
      `${JSON.stringify(
        { schemaVersion: 1, subagentEnabled: true, subagentProvider: '   ', subagentModel: 42 },
        null,
        2,
      )}\n`,
    )
    // Never a throw: a settings file a human edited is a supported input (D2).
    const read = readSettings(dataDir)
    assert.equal(read.settings.subagentEnabled, true)
    assert.equal(Object.prototype.hasOwnProperty.call(read.settings, 'subagentProvider'), false)
    assert.equal(Object.prototype.hasOwnProperty.call(read.settings, 'subagentModel'), false)
    assert.equal(read.warn?.code, 'SETTINGS_FIELD_IGNORED')
    assert.deepEqual(
      read.notices?.map((notice) => notice.field),
      ['subagentProvider', 'subagentModel'],
    )

    // The diagnostics package carries the same sentence, which is where a support report
    // finds it (D5).
    const document = buildDiagnostics({ dataDir, version: '0.0.0-test' })
    assert.equal(document.settings.warn?.code, 'SETTINGS_FIELD_IGNORED')

    // A route token with a space in it cannot be dispatched: refused for the same reason.
    writeRaw(dataDir, `${JSON.stringify({ schemaVersion: 1, subagentEnabled: true, subagentModel: 'deep seek' })}\n`)
    const spaced = readSettings(dataDir)
    assert.equal(Object.prototype.hasOwnProperty.call(spaced.settings, 'subagentModel'), false)
    assert.deepEqual(spaced.notices?.map((notice) => notice.field), ['subagentModel'])
  } finally {
    cleanup()
  }
})
