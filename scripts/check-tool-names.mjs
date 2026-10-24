/**
 * Tool-name gate (zero dependencies).
 *
 * A tool name is an interface, and every place that names one is a place that can
 * drift. Two drifts have already happened and neither was caught by a test:
 *
 *   1. A tool description told the model to call `inkflow_fact_snapshot`; the real
 *      tool is `inkflow_facts_snapshot`. Nothing fails — the model simply calls a
 *      name that does not exist, at the moment it is already stuck.
 *   2. `docs/user-guide.md` never named `inkflow_backup_restore`, so half of the
 *      documented backup story had no discoverable entry point.
 *
 * Two assertions, both about names only:
 *
 *   A. SOURCE — every `inkflow_*` mention under `src/` resolves to a registered tool
 *      (`name: 'inkflow_…'`). Wildcards are skipped: `inkflow_*` and the `inkflow_
 *      outline_*` / `inkflow_semantic_*` families are prose, not names.
 *   B. GUIDE — every registered tool is mentioned in `docs/user-guide.md`.
 *
 * Run: node scripts/check-tool-names.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const GUIDE = join(ROOT, 'docs', 'user-guide.md')

/** A definition: `name: 'inkflow_…'` — the one shape `tools.register()` consumes. */
const DEFINITION = /name:\s*'inkflow_[a-z0-9_]+'/g
/** Any mention. `\w`-free on purpose: a tool name never carries a capital or a dash. */
const MENTION = /inkflow_[a-z0-9_]+/g

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
  return out
}

const failures = []
const sources = walk(join(ROOT, 'src'))
const registered = new Set()

for (const file of sources) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.match(DEFINITION) ?? []) {
    registered.add(match.replace(/^name:\s*'|'$/g, ''))
  }
}

if (registered.size === 0) {
  failures.push('src/: no tool definition was found at all (did the registry move?) — this gate cannot pass vacuously')
}

/** `index` is a `*`/`_` wildcard, not a name. */
function isWildcard(text, start, length) {
  const name = text.slice(start, start + length)
  const next = text.slice(start + length, start + length + 1)
  return next === '*' || name.endsWith('_')
}

for (const file of sources) {
  const text = readFileSync(file, 'utf8')
  const rel = relative(ROOT, file).replaceAll('\\', '/')
  for (const match of text.matchAll(MENTION)) {
    const start = match.index ?? 0
    const name = match[0]
    if (isWildcard(text, start, name.length)) continue
    if (registered.has(name)) continue
    const line = text.slice(0, start).split('\n').length
    failures.push(`${rel}:${line}: mentions ${name}, which no tool registers (typo or a renamed tool)`)
  }
}

let guide = ''
try {
  guide = readFileSync(GUIDE, 'utf8')
} catch {
  failures.push('docs/user-guide.md is missing — the guide is the only place a user learns a tool exists')
}

if (guide !== '') {
  const documented = new Set((guide.match(MENTION) ?? []).filter((name) => !name.endsWith('_')))
  for (const name of [...registered].sort()) {
    if (!documented.has(name)) failures.push(`docs/user-guide.md: never names ${name} (the tool exists but is undiscoverable)`)
  }
}

if (failures.length > 0) {
  console.error('tool-name check failed:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(`tool names ok: ${registered.size} registered tool(s), all mentioned in docs/user-guide.md, no stray mention under src/`)
