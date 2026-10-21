/**
 * Build identity and stale-load detection (issue #88).
 *
 * The user-visible failure: DSH loads a plugin's `lib/` ONCE at startup. A later
 * `pnpm run build` rewrites the disk but not the running generation, so a
 * perfectly usable book renders as "needs setup" and no amount of "refresh" can
 * help — the refresh handler is itself the old code. Nothing told the user that.
 *
 * The contract under test:
 *
 *   1. `build` is baked in at BUILD time by scripts/build.mjs (`__INKFLOW_BUILD__`
 *      = `<git short sha>@<ISO>`, esbuild `define`), so a running process can say
 *      which generation it is executing without touching the disk.
 *   2. `diskBuildTime` is the mtime of the very `lib/index.js` this process
 *      loaded, read at CALL time: the only hint that the disk has moved on.
 *   3. `staleLoadedCode` is deliberately ONE-SIDED and TOLERANT — true only when
 *      the disk file is NEWER than process start by more than
 *      `STALE_TOLERANCE_MS` (5 s). A missed warning costs one confusing session;
 *      a false warning teaches the user to ignore the banner, and a build still
 *      running when the process started must not fire it.
 *   4. An unresolvable bundle path or a missing file degrades to `'unknown'` and
 *      never throws: this code runs on the `/status` path.
 *
 * The three states are driven through `getLoadedBuild`'s injected clock, disk
 * file and stamp, so they are deterministic on every machine (the real mtime of
 * `lib/index.js` is only asserted to be *reachable*, not to a value).
 *
 * Run: pnpm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { STALE_TOLERANCE_MS, decideStale, getLoadedBuild, summarizeBuild } from '../lib/index.js'

const ROOT = resolve(import.meta.dirname, '..')
const BUNDLE = join(ROOT, 'lib', 'index.js')
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
/** A fixed process start, so the three states never depend on the wall clock. */
const STARTED_AT = Date.UTC(2026, 9, 21, 12, 52, 13)

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-build-'))
}

/** A fake bundle whose mtime is exactly `mtimeMs`. */
function bundleAt(dir, mtimeMs) {
  const file = join(dir, 'index.js')
  writeFileSync(file, '// built\n', 'utf8')
  const at = new Date(mtimeMs)
  utimesSync(file, at, at)
  return file
}

// ---------------------------------------------------------------------------
// 1. What the running process reports about itself
// ---------------------------------------------------------------------------

test('getLoadedBuild reports the running generation, its build time and its start time', () => {
  const loaded = getLoadedBuild({ version: '0.0.2' })

  assert.deepEqual(Object.keys(loaded).sort(), [
    'build',
    'buildTime',
    'diskBuildTime',
    'loadedAt',
    'staleLoadedCode',
    'version',
  ])
  assert.equal(loaded.version, '0.0.2')
  assert.match(loaded.build, /^[^@]+@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'stamp is `<sha>@<ISO>`')
  assert.equal(loaded.buildTime, loaded.build.slice(loaded.build.indexOf('@') + 1), 'buildTime is the stamp half')
  assert.match(loaded.buildTime, ISO)

  // loadedAt is process start, not "now": the banner compares it with the disk.
  assert.match(loaded.loadedAt, ISO)
  const fromUptime = Date.now() - process.uptime() * 1000
  assert.ok(Math.abs(Date.parse(loaded.loadedAt) - fromUptime) < 2_000, 'loadedAt must be the process start time')

  // `pnpm run check` builds before it tests, so the artifact this process
  // imported is never newer than the process itself.
  assert.equal(loaded.staleLoadedCode, false)
  assert.match(loaded.diskBuildTime, ISO, 'the real lib/index.js is reachable from the bundle')
})

test('summarizeBuild is the five-field shape the channel and the tool carry', () => {
  const summary = summarizeBuild(getLoadedBuild({ version: '0.0.2' }))
  assert.deepEqual(Object.keys(summary).sort(), ['build', 'diskBuildTime', 'loadedAt', 'staleLoadedCode', 'version'])
  assert.equal(summary.version, '0.0.2')
})

test('the build stamp is baked into the artifact the host actually loads', () => {
  const text = readFileSync(BUNDLE, 'utf8')
  const { build } = getLoadedBuild({ version: '0.0.2' })
  assert.ok(build !== 'unknown', 'esbuild define must inject __INKFLOW_BUILD__ for the host half')
  assert.ok(text.includes(build), `lib/index.js must contain its own stamp (${build})`)
})

// ---------------------------------------------------------------------------
// 2. The three states (disk vs process start)
// ---------------------------------------------------------------------------

test('a disk build NEWER than the process start means the loaded code is stale', () => {
  const dir = workdir()
  try {
    const diskAt = STARTED_AT + 52 * 60 * 1000
    const loaded = getLoadedBuild({ version: 'x', startedAt: STARTED_AT, diskFile: bundleAt(dir, diskAt) })
    assert.equal(loaded.staleLoadedCode, true)
    assert.equal(loaded.diskBuildTime, new Date(diskAt).toISOString())
    assert.equal(loaded.loadedAt, new Date(STARTED_AT).toISOString())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a disk build OLDER than the process start is the normal case: not stale', () => {
  const dir = workdir()
  try {
    const diskAt = STARTED_AT - 52 * 60 * 1000
    const loaded = getLoadedBuild({ version: 'x', startedAt: STARTED_AT, diskFile: bundleAt(dir, diskAt) })
    assert.equal(loaded.staleLoadedCode, false)
    assert.equal(loaded.diskBuildTime, new Date(diskAt).toISOString())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a rebuild that races the startup within the tolerance window is NOT reported', () => {
  const dir = workdir()
  try {
    // The build and the restart overlap: writing the artifact two seconds after
    // the process came up says nothing about a stale generation.
    const insideWindow = getLoadedBuild({
      version: 'x',
      startedAt: STARTED_AT,
      diskFile: bundleAt(dir, STARTED_AT + 2_000),
    })
    assert.equal(insideWindow.staleLoadedCode, false)

    const justOutside = getLoadedBuild({
      version: 'x',
      startedAt: STARTED_AT,
      diskFile: bundleAt(dir, STARTED_AT + STALE_TOLERANCE_MS + 1_000),
    })
    assert.equal(justOutside.staleLoadedCode, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('decideStale states the rule once: strictly newer than start + tolerance', () => {
  assert.equal(decideStale(STARTED_AT + STALE_TOLERANCE_MS, STARTED_AT), false, 'the edge itself is fresh')
  assert.equal(decideStale(STARTED_AT + STALE_TOLERANCE_MS + 1, STARTED_AT), true)
  assert.equal(decideStale(STARTED_AT - 1, STARTED_AT), false)
  assert.equal(decideStale(null, STARTED_AT), false, 'an unreachable disk is not evidence of staleness')
})

// ---------------------------------------------------------------------------
// 3. Degradation: never throw, never guess
// ---------------------------------------------------------------------------

test('a bundle path that cannot be read degrades to unknown instead of throwing', () => {
  const dir = workdir()
  try {
    const loaded = getLoadedBuild({ version: 'x', startedAt: STARTED_AT, diskFile: join(dir, 'missing.js') })
    assert.equal(loaded.diskBuildTime, 'unknown')
    assert.equal(loaded.staleLoadedCode, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a stamp without a parseable timestamp keeps the stamp and reports an unknown build time', () => {
  const loaded = getLoadedBuild({ version: 'x', startedAt: STARTED_AT, diskFile: null, build: 'abc1234' })
  assert.equal(loaded.build, 'abc1234')
  assert.equal(loaded.buildTime, 'unknown')

  const noDisk = getLoadedBuild({ version: 'x', startedAt: STARTED_AT, diskFile: null, build: 'unknown' })
  assert.equal(noDisk.diskBuildTime, 'unknown', 'a null disk file is unknown, not "now"')
  assert.equal(noDisk.staleLoadedCode, false)
})
