#!/usr/bin/env node
/**
 * Source-file size gate: 800 lines blocks, 600 lines only nags.
 *
 * WHY TWO THRESHOLDS: the single 600-line cap treated a 620-line file and a 1200-line file as
 * the same failure. That made every slightly-long file a debt to repay while nothing
 * distinguished "come back later" from "this cannot keep growing", and the budget table it
 * needed grew to 42 entries that changes had to maintain instead of code to read. The split is:
 *
 *   * 601–800  → a warning, printed locally and as a GitHub annotation. Split it if you are in
 *                the file anyway; skipping it is a legitimate answer.
 *   * > 800    → the job fails. A file this long has already lost the property the 600-line
 *                guideline was protecting (a reader can see the whole module at once).
 *
 * There is no exemption list. The nine files that were over 800 when this gate landed have
 * been split, so the hard cap is now flat: any tracked source file over it fails the gate.
 *
 * Tracked files only (`git ls-files`): an untracked scratch file is not the repository's
 * problem, and a file the repository does not carry cannot be "too long" for it.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOFT_CAP = 600
const HARD_CAP = 800

function trackedSources() {
  const listed = execFileSync('git', ['ls-files', '-z', '--', 'src'], { cwd: ROOT, encoding: 'buffer' })
  return listed
    .toString('utf8')
    .split('\u0000')
    .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'))
}

/** The same count the guard always used: a trailing newline does not open a line. */
function lineCount(text) {
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

const files = trackedSources()
if (files.length === 0) {
  console.error('size: no tracked source files found (run inside the repository)')
  process.exit(1)
}

const failures = []
const soft = []
for (const name of files) {
  const lines = lineCount(readFileSync(join(ROOT, name), 'utf8'))
  if (lines > HARD_CAP) {
    failures.push(`${name}:${String(lines)} — over the ${String(HARD_CAP)}-line hard cap; split it (600 is a nudge, ${String(HARD_CAP)} blocks)`)
    continue
  }
  if (lines > SOFT_CAP) soft.push([name, lines])
}

soft.sort((a, b) => b[1] - a[1])

// The nudge: one line per file locally, and a GitHub annotation so it shows up on the PR
// instead of scrolling past in the job log. Neither affects the exit code.
for (const [name, lines] of soft) {
  const message = `over the ${String(SOFT_CAP)}-line soft cap — split it if you are in the file anyway; over ${String(HARD_CAP)} blocks the merge`
  console.warn(`warn: ${name}:${String(lines)} (${message})`)
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning file=${name}::${String(lines)} lines — ${message}`)
}

const summary = `size: ${String(files.length)} tracked source file(s); ${String(soft.length)} over ${String(SOFT_CAP)} (soft), ${String(failures.length)} over ${String(HARD_CAP)}`

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  console.error(`\nsize gate failed: ${String(failures.length)}`)
  process.exit(1)
}
console.log(summary)

if (process.env.GITHUB_ACTIONS === 'true' && soft.length > 0) {
  console.log(`::warning::${summary} — split one when you are next in it`)
}
