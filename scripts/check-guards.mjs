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
 * React's rules of hooks, as a mechanism (#174).
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

import { readdirSync } from 'node:fs'

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  console.error(`\nguards failed: ${failures.length}`)
  process.exit(1)
}
console.log(`guards ok: ${ok.length} check(s)${skipArtifacts ? ' (artifacts skipped)' : ''}`)
