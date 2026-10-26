/**
 * The issue-reference gate must see a file that is **not committed yet**.
 *
 * Why this test exists: the gate reads its file list from git, and the first version asked
 * for `git ls-files` alone — the index. A brand-new file is not in the index, so the gate
 * reported "no issue/PR numbers in code" for a working tree that contained one, while CI
 * (which sees the committed file) failed on the same code. A gate whose verdict depends on
 * whether you have run `git add` is worse than no gate: it teaches the author to trust a
 * green that means nothing.
 *
 * Every case below builds its own throwaway repository, so the assertions are about the
 * gate's rule and not about this repository's current contents.
 *
 * Run: pnpm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const GATE = join(ROOT, 'scripts', 'check-issue-refs.mjs')

/**
 * The fixtures need issue-looking tokens, and this file is itself scanned by the gate — so a
 * token is assembled at runtime instead of written out. Spelling one here would make the last
 * test in this file fail, which is the gate working as intended.
 */
const HASH = '#'
const ref = (number) => `${HASH}${number}`

/** A throwaway repository with `.gitignore` in place; `files` are written but never staged. */
function makeRepo(files, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-issue-refs-'))
  execFileSync('git', ['init', '--quiet'], { cwd: dir })
  writeFileSync(join(dir, '.gitignore'), ['.tmp/', 'lib/', 'node_modules/', ''].join('\n'), 'utf8')
  for (const [name, text] of Object.entries(files)) {
    const absolute = join(dir, name)
    mkdirSync(resolve(absolute, '..'), { recursive: true })
    writeFileSync(absolute, text, 'utf8')
  }
  if (options.stage === true) execFileSync('git', ['add', '--force', '.'], { cwd: dir })
  return dir
}

/** Run the gate inside `dir`; the exit code is the verdict under test. */
function runGate(dir) {
  const result = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('issue refs: an unstaged new file is scanned, not skipped', () => {
  const dir = makeRepo({ 'src/fresh.ts': `const note = "see ${ref(123)} for why"\n` })
  try {
    const run = runGate(dir)
    assert.equal(run.status, 1, 'a number in a file that was never staged must still fail the gate')
    assert.match(run.stderr, /src\/fresh\.ts/u, 'the finding names the file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('issue refs: a staged file still fails, so the widened list did not replace the old one', () => {
  const dir = makeRepo({ 'tests/staged.test.js': `// ${ref(42)}\n` }, { stage: true })
  try {
    assert.equal(runGate(dir).status, 1, 'the tracked half of the list keeps working')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('issue refs: an ignored path is out of scope, and says so by passing', () => {
  const dir = makeRepo({
    'lib/bundle.js': `// ${ref(7)}\n`,
    '.tmp/scratch.mjs': `// ${ref(8)}\n`,
  })
  try {
    assert.equal(runGate(dir).status, 0, 'ignored paths are not repository content, so nothing is reported')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('issue refs: hex colours, template markers and URL fragments stay out of the report', () => {
  const dir = makeRepo({
    'src/colour.ts': [
      "const border = { color: '#f143ab' }",
      'const css = `a { background: #fff; }`',
      'const url = "https://example.com/docs#usage"',
      'const marker = "`#{value}`"',
      '',
    ].join('\n'),
  })
  try {
    assert.equal(runGate(dir).status, 0, 'a colour or a fragment is not an issue reference')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('issue refs: this repository passes its own gate', () => {
  const run = spawnSync(process.execPath, [GATE], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
})
