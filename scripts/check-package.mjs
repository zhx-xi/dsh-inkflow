/**
 * Package gate: what `npm pack` would ship must stay exactly the runtime
 * surface. Catches the classic leaks (src/, tests/, .agents/, .tmp/) and a
 * missing build artifact before a release is cut.
 *
 * Run: node scripts/check-package.mjs
 */
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
// `skills/` is shipped data, not source: the Host half reads the five SKILL.md
// bodies out of the installed package at apply time (see src/host/skills.ts),
// so the directory is part of the runtime surface and its absence must fail
// here rather than silently produce a plugin with no skills.
const ALLOWED = /^(package\.json|README\.md|LICENSE|icon\.svg|cordis\.patch\.yml|lib\/|locale\/|skills\/)/

/** Every writing skill ships as `skills/<name>/SKILL.md`, one per pipeline stage. */
const REQUIRED_SKILLS = [
  'inkflow-architect',
  'inkflow-writer',
  'inkflow-auditor',
  'inkflow-reviser',
  'inkflow-polisher',
]

// Windows cannot spawn a .cmd shim without a shell (EINVAL), so go through cmd
// there and spawn npm directly elsewhere.
const isWindows = process.platform === 'win32'
const packed = isWindows
  ? spawnSync('npm pack --dry-run --json', { cwd: ROOT, encoding: 'utf8', shell: true })
  : spawnSync('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT, encoding: 'utf8' })
if (packed.error || packed.status !== 0) {
  console.error(packed.error?.message ?? packed.stderr ?? packed.stdout ?? 'npm pack failed')
  process.exit(1)
}

let parsed
try {
  parsed = JSON.parse(packed.stdout)
} catch (error) {
  console.error(`could not parse npm pack output: ${error.message}`)
  process.exit(1)
}

const files = (parsed[0]?.files ?? []).map((entry) => entry.path.replaceAll('\\', '/'))
if (files.length === 0) {
  console.error('npm pack listed no files')
  process.exit(1)
}
const leaked = files.filter((path) => !ALLOWED.test(path))
if (leaked.length > 0) {
  console.error(`✗ files outside the runtime surface: ${leaked.join(', ')}`)
  process.exit(1)
}
for (const required of ['lib/index.js', 'lib/client.js']) {
  if (!files.includes(required)) {
    console.error(`✗ missing build artifact in the package: ${required} (run the build first)`)
    process.exit(1)
  }
}
for (const skill of REQUIRED_SKILLS) {
  const required = `skills/${skill}/SKILL.md`
  if (!files.includes(required)) {
    console.error(`✗ missing writing skill in the package: ${required} (check package.json "files")`)
    process.exit(1)
  }
}
console.log(`package ok: ${files.length} file(s) shipped (${REQUIRED_SKILLS.length} skills), no source/test leakage`)
