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
    })
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

test('sharedRoot defaults to dataDir/shared and resolves a relative value there', () => {
  const { dataDir, cleanup } = workspace()
  try {
    assert.equal(sharedRootOf(dataDir), join(dataDir, 'shared'))
    writeSettings(dataDir, { sharedRoot: 'libs' })
    assert.equal(sharedRootOf(dataDir), join(dataDir, 'libs'))
    writeSettings(dataDir, { sharedRoot: 'D:\\novel-shared' })
    assert.equal(sharedRootOf(dataDir), 'D:\\novel-shared')
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
