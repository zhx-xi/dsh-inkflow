/**
 * Repository guards that no general-purpose linter knows about.
 *
 * Each check encodes a hard constraint from .agents/constitution/hard-constraints.md:
 *   H1  no runtime import of @deepseek-ai/* (only ctx.* public surface)
 *   H2  cordis.patch.yml must add rows with `- insert:` (otherwise silently dropped)
 *   H4  lib/client.js must be the loader-factory shape
 *   H5  the client half must not use iframe / document.body
 *   H11 no UTF-8 BOM in tracked text files
 * Plus: runtime `dependencies` must stay empty.
 *
 * Run: node scripts/check-guards.mjs [--no-artifacts]
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const skipArtifacts = process.argv.includes('--no-artifacts')
const failures = []
const ok = []

function check(name, fn) {
  try {
    fn()
    ok.push(name)
  } catch (error) {
    failures.push(`${name}: ${error.message}`)
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

check('dependencies stay empty', () => {
  const pkg = readJson(join(ROOT, 'package.json'))
  const deps = pkg.dependencies ?? {}
  if (Object.keys(deps).length > 0) throw new Error(`runtime dependencies present: ${Object.keys(deps).join(', ')}`)
})

check('src/ has no @deepseek-ai runtime import', () => {
  const offenders = []
  const walk = (dir) => {
    for (const entry of readFileSyncDir(dir)) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
        const text = readFileSync(full, 'utf8')
        for (const match of text.matchAll(/from\s+['"](@deepseek-ai\/[^'"]+)['"]/g)) offenders.push(`${relative(ROOT, full)} -> ${match[1]}`)
      }
    }
  }
  walk(join(ROOT, 'src'))
  if (offenders.length > 0) throw new Error(offenders.join('; '))
})

check('client half has no iframe / document.body', () => {
  const dir = join(ROOT, 'src', 'client')
  const offenders = []
  const walk = (current) => {
    for (const entry of readFileSyncDir(current)) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(tsx?|mjs|js)$/.test(entry.name)) {
        const text = readFileSync(full, 'utf8')
        if (text.includes('iframe') || text.includes('document.body')) offenders.push(relative(ROOT, full))
      }
    }
  }
  walk(dir)
  if (offenders.length > 0) throw new Error(offenders.join(', '))
})

check('cordis.patch.yml uses insert rows', () => {
  const text = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  if (!text.includes('insert:')) throw new Error('no `- insert:` block: the row would be silently dropped (H2)')
  if (!text.includes('id: dsh-inkflow')) throw new Error('row id `dsh-inkflow` is missing')
})

/**
 * Conflict markers must never be committed.
 *
 * WHY this exists: a rebase resolution left `<<<<<<< HEAD` / `=======` / `>>>>>>>` inside
 * `architecture.md` and `docs/user-guide.md`, those files were `git add -A`-ed, and every
 * gate stayed green — check-links only resolves links, check-tool-names read just the first
 * copy of the count sentence, check-module-table only asks whether a module name appears
 * somewhere in §6. The repo shipped a spec file that a human cannot read and a guide that
 * declared three different tool counts. This guard is the mechanical answer: markers in any
 * tracked text file are a hard failure, whatever the file is for.
 */
check('no conflict markers in tracked text files', () => {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' })
  if (listed.status !== 0) throw new Error('git ls-files failed (run inside the repository)')
  const names = listed.stdout.toString('utf8').split('\u0000').filter(Boolean)
  const textExt = /\.(md|ts|tsx|mjs|js|json|yml|yaml|css|txt)$/
  const offenders = []
  for (const name of names) {
    if (!textExt.test(name)) continue
    const abs = join(ROOT, name)
    if (!existsSync(abs) || !statSync(abs).isFile()) continue
    const lines = readFileSync(abs, 'utf8').split('\n')
    for (const [index, line] of lines.entries()) {
      if (/^<<<<<<< |^>>>>>>> /.test(line) || /^=======$/.test(line)) {
        offenders.push(`${name}:${String(index + 1)}`)
        break
      }
    }
  }
  if (offenders.length > 0) throw new Error(`conflict markers committed: ${offenders.join(', ')}`)
})

check('no UTF-8 BOM in tracked text files', () => {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'buffer' })
  if (listed.status !== 0) throw new Error('git ls-files failed (run inside the repository)')
  const names = listed.stdout.toString('utf8').split('\u0000').filter(Boolean)
  const textExt = /\.(md|ts|tsx|mjs|js|json|yml|yaml|css|txt)$/
  const offenders = []
  for (const name of names) {
    if (!textExt.test(name)) continue
    const abs = join(ROOT, name)
    if (!existsSync(abs) || !statSync(abs).isFile()) continue
    const head = readFileSync(abs).subarray(0, 3)
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) offenders.push(name)
  }
  if (offenders.length > 0) throw new Error(offenders.join(', '))
})

/**
 * React's rules of hooks, as a mechanism.
 *
 * The settings page rendered as a blank panel because `HubView` called a `useCallback`
 * *below* the `if (view === …) return` switch: the render that switched pages had one
 * hook fewer than the previous one, React threw, and nothing in the UI said why. That is
 * a source-level defect, so it is checked at source level — the analysis needs the AST
 * (TypeScript) and lives in `scripts/check-hooks-order.mjs` so it can also be run alone
 * with a directory argument while debugging.
 */
check('no hook is called after an early return (client components)', () => {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-hooks-order.mjs')], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'check-hooks-order.mjs failed').trim())
  }
})

/**
 * Every test file owns its stub server, its port and its lifetime.
 *
 * WHY this is a mechanism: the full suite runs ~32 test files at once, each in its own
 * process, so a stub that shares a port or outlives its test fails *some other* test — at
 * random, on a loaded machine, never on the machine of whoever wrote it. That is exactly
 * how the fresh-worktree red presented ("first full run in a fresh worktree goes red, ten reruns are
 * green"). The stub in `tests/ovk.stub.test.js` turned out to be innocent — it already
 * listens on port 0 and keeps its state in a local `const` — but the two facts that make it
 * innocent are greppable, so they are checked here instead of trusted to the next copy-paste.
 *
 *   * `listen(0)`: a literal port collides with anything else on the machine, and with a
 *     second run of the same suite (an agent running two worktrees at once is normal here).
 *   * no module-level `server`: a server declared at file scope is created once and shared
 *     by every test in the file, so the state one test mutates is the state the next one
 *     asserts against.
 *
 * A fixed state directory under %TEMP% (`dataDir: tmpdir()`, `join(tmpdir(), 'inkflow-x-state')`)
 * is the same class of defect with a quieter failure mode, so it has its own check below
 * rather than a line here.
 */
check('test files bind port 0 and declare no module-level server', () => {
  const dir = join(ROOT, 'tests')
  const offenders = []
  const lineOf = (text, index) => text.slice(0, index).split('\n').length
  for (const entry of readFileSyncDir(dir)) {
    if (!entry.isFile() || !/\.(js|mjs|cjs)$/.test(entry.name)) continue
    const name = `tests/${entry.name}`
    const text = readFileSync(join(dir, entry.name), 'utf8')
    for (const match of text.matchAll(/\.listen\(\s*([1-9]\d*)/gu)) {
      offenders.push(`${name}:${String(lineOf(text, match.index))} binds the fixed port ${match[1]} — use listen(0)`)
    }
    for (const match of text.matchAll(/^(?:const|let|var)\s+server\b.*$/gmu)) {
      offenders.push(`${name}:${String(lineOf(text, match.index))} declares a module-level server — build it inside the test and close it there`)
    }
  }
  if (offenders.length > 0) throw new Error(offenders.join('; '))
})

/**
 * A test may not hand the code under test a %TEMP% path whose name it did not mint.
 *
 * WHY this is the check above with the volume turned down: a fixed name under %TEMP% is a
 * resource *outside* the test process. Every checkout of this repository on the machine
 * shares it — an agent running two worktrees at once is normal here — and it outlives the
 * run that created it, so one process reads the plugin state another one wrote: `apply()`
 * reads `state.json` at startup, and the exporters, the backup packages and the semantic
 * ledger all live in that same directory. Measured before the change: a value written by
 * one process came back out of a second process's `apply()`, while two concurrent runs of
 * the same file never went red. That gap is the reason this is a mechanism and not a
 * story — nothing observable depends on the leftover today, and the day something does it
 * fails in somebody else's worktree, at random.
 *
 * What is allowed is `mkdtempSync(join(tmpdir(), '<prefix>-'))`: a name no other process
 * can pick, removed by the file's own `after` hook. A `tmpdir()` whose next character is a
 * `.` is a string read (the two "no temp path leaked" assertions), not a path handed over,
 * so it stays legal.
 *
 * A deliberately shared directory carries `guard-ignore: <reason>` on the same line, the
 * way `scripts/lint.mjs` reads `lint-ignore`.
 *
 * The scan is textual, like every other check here, so a comment under `tests/` that spells
 * the forbidden shape out is itself a finding: describe it in words instead.
 */
check('test files mint their temp directory per run', () => {
  const dir = join(ROOT, 'tests')
  const offenders = []
  for (const entry of readFileSyncDir(dir)) {
    if (!entry.isFile() || !/\.(js|mjs|cjs)$/.test(entry.name)) continue
    const name = `tests/${entry.name}`
    const text = readFileSync(join(dir, entry.name), 'utf8')
    const lines = text.split('\n')
    const minted = mkdtempSpans(text)
    for (const match of text.matchAll(/\b(?:os\s*\.\s*)?tmpdir\s*\(\s*\)/gu)) {
      if (minted.some(([open, close]) => open < match.index && match.index < close)) continue
      const next = /^\s*(\S)/u.exec(text.slice(match.index + match[0].length))
      if (next !== null && next[1] === '.') continue
      const line = text.slice(0, match.index).split('\n').length
      if ((lines[line - 1] ?? '').includes('guard-ignore')) continue
      offenders.push(`${name}:${String(line)} hands over a fixed %TEMP% path — mint one per run with mkdtempSync and delete it afterwards`)
    }
  }
  if (offenders.length > 0) throw new Error(offenders.join('; '))
})

/**
 * No source file may grow past 600 lines.
 *
 * WHY this is a mechanism and not a style note: `AGENTS.md` §10.5 has said "单文件 >600 行先
 * 考虑拆分" for the whole project, and three files reached 2269 / 1688 / 1374 lines anyway —
 * because a rule nobody checks is a preference. Every one of them still "worked"; the cost
 * was paid by the next person who had to find the write path inside it (a later task wants to add a
 * fold to `review.ts` and a cleanup tool to `tools.ts`).
 *
 * WHY a budget list rather than a flat cap: when the guard landed, 42 tracked source files
 * were already over the cap (worst: `routes.ts` 1580), so a flat cap would have reddened the
 * build over a backlog instead of stopping the growth. The rule is therefore two-sided:
 *
 *   * a file **not** on the list may not exceed the cap;
 *   * a file **on** the list may not exceed its recorded count (its budget), and once it is
 *     back under the cap its entry must be deleted in the same change — otherwise the list
 *     would quietly become a permanent exemption.
 *
 * The list only shrinks. Burning it down is roadmap work, not something this guard does.
 *
 * Tracked files only (`git ls-files`): untracked scratch files are not the repository's
 * problem, and this guard is about the repository.
 */
const SIZE_CAP = 600
const OVER_CAP_BUDGET = {
  'src/client/index.tsx': 1053,
  'src/client/library-model.ts': 821,
  'src/client/library.tsx': 602,
  'src/client/panel-model.ts': 648,
  'src/client/settings.tsx': 686,
  'src/host/backup-zip.ts': 716,
  'src/host/backup.ts': 644,
  'src/host/catalog.ts': 823,
  'src/host/chapters.ts': 1415,
  'src/host/diagnostics.ts': 621,
  'src/host/domains/facts-tools.ts': 674,
  'src/host/domains/foreshadowing-query.ts': 605,
  'src/host/domains/outline-tools.ts': 800,
  'src/host/domains/timeline-plan.ts': 679,
  'src/host/domains/timeline-tools.ts': 822,
  'src/host/domains/world-tools.ts': 661,
  'src/host/etl-plan.ts': 1209,
  'src/host/etl-source.ts': 631,
  'src/host/etl.ts': 753,
  'src/host/export.ts': 1004,
  'src/host/extract-accept.ts': 704,
  'src/host/extract-tools.ts': 677,
  'src/host/extract.ts': 1084,
  'src/host/frontmatter.ts': 747,
  'src/host/hub-shared.ts': 611,
  'src/host/hub-wizard.ts': 656,
  'src/host/impact.ts': 619,
  'src/host/import-write.ts': 675,
  'src/host/index.ts': 1519,
  'src/host/internal.ts': 1261,
  'src/host/io.ts': 925,
  'src/host/jobs-tools.ts': 624,
  'src/host/migrate.ts': 670,
  'src/host/ovk.ts': 699,
  'src/host/repair.ts': 945,
  'src/host/routes.ts': 1580,
  'src/host/search.ts': 626,
  'src/host/series.ts': 762,
  'src/host/settings-tools.ts': 643,
  'src/host/shared-copy.ts': 896,
  'src/host/writing-context.ts': 863,
}

check('no source file grows past the line cap', () => {
  const listed = spawnSync('git', ['ls-files', '-z', 'src/**/*.ts', 'src/**/*.tsx', 'src/*.ts', 'src/*.tsx'], {
    cwd: ROOT,
    encoding: 'buffer',
  })
  if (listed.status !== 0) throw new Error('git ls-files failed (run inside the repository)')
  const names = listed.stdout.toString('utf8').split('\u0000').filter(Boolean)
  const counted = new Map()
  for (const name of names) {
    const text = readFileSync(join(ROOT, name), 'utf8')
    const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    counted.set(name, lines)
  }
  const offenders = []
  for (const [name, lines] of counted) {
    const budget = OVER_CAP_BUDGET[name]
    if (budget === undefined) {
      if (lines > SIZE_CAP) offenders.push(`${name}:${String(lines)} (over the ${String(SIZE_CAP)}-line cap: split it)`)
      continue
    }
    if (lines > budget) offenders.push(`${name}:${String(lines)} (grew past its recorded ${String(budget)}: split it back down)`)
    else if (lines <= SIZE_CAP) offenders.push(`${name}:${String(lines)} (back under the cap: delete its OVER_CAP_BUDGET entry)`)
  }
  for (const name of Object.keys(OVER_CAP_BUDGET)) {
    if (!counted.has(name)) offenders.push(`${name} (budgeted but no longer a tracked source file: delete its entry)`)
  }
  if (offenders.length > 0) throw new Error(offenders.join(', '))
})

if (!skipArtifacts) {
  check('built host bundle is ESM with apply()', () => {
    const path = join(ROOT, 'lib', 'index.js')
    if (!existsSync(path)) throw new Error('lib/index.js is missing: run `pnpm run build`')
    const text = readFileSync(path, 'utf8')
    if (!/export\s*\{/.test(text)) throw new Error('lib/index.js does not look like an ES module')
    if (!text.includes('apply')) throw new Error('lib/index.js does not export apply()')
  })

  check('built client bundle is the loader-factory shape', () => {
    const path = join(ROOT, 'lib', 'client.js')
    if (!existsSync(path)) throw new Error('lib/client.js is missing: run `pnpm run build`')
    const text = readFileSync(path, 'utf8').trim()
    if (!text.startsWith('window.__ModuleLoader__.load(')) throw new Error('lib/client.js must start with window.__ModuleLoader__.load(')
    if (!text.includes('return module.exports')) throw new Error('lib/client.js must return module.exports from the factory')
  })
}

function readFileSyncDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * The `[open, close]` paren index span of every `mkdtempSync(…)` call in `text`.
 *
 * Paren counting is sufficient because the argument is a path expression; a literal holding
 * an unbalanced bracket would skew it, and no test has one (checked when this landed).
 */
function mkdtempSpans(text) {
  const spans = []
  for (const match of text.matchAll(/mkdtempSync\s*\(/gu)) {
    const open = match.index + match[0].length - 1
    let depth = 0
    for (let index = open; index < text.length; index += 1) {
      const char = text[index]
      if (char === '(') depth += 1
      else if (char === ')') {
        depth -= 1
        if (depth === 0) {
          spans.push([open, index])
          break
        }
      }
    }
  }
  return spans
}

import { readdirSync } from 'node:fs'

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  console.error(`\nguards failed: ${failures.length}`)
  process.exit(1)
}
console.log(`guards ok: ${ok.length} check(s)${skipArtifacts ? ' (artifacts skipped)' : ''}`)
