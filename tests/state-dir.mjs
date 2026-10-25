/**
 * A plugin-state directory that belongs to this test file alone.
 *
 * WHY this exists instead of naming the directory at the call site: a fixed name under
 * %TEMP% is shared with every other run on the machine — a second checkout of this
 * repository, or the same file started twice — so one process reads the plugin state another
 * one wrote. `apply()` reads `state.json` at startup, and the exporters, the backup packages
 * and the semantic ledger all live in that same directory, so "nothing writes to it today" is
 * the only thing keeping the suite honest. `mkdtempSync` mints a name no other process can
 * take.
 *
 * The `after` hook is registered from here rather than in each file: `node:test` binds the
 * hook to the file whose import pulled this module in, so a failed run leaves no directory
 * behind either. `scripts/check-guards.mjs` refuses every other %TEMP% path under `tests/`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'

/** A fresh state directory for this run, removed when this file's tests are done. */
export function createStateDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`))
  after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
