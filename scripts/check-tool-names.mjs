/**
 * Tool-name gate (zero dependencies).
 *
 * A tool name is an interface, and every place that names one is a place that can
 * drift. Three drifts have already happened and none was caught by a test:
 *
 *   1. A tool description told the model to call `inkflow_fact_snapshot`; the real
 *      tool is `inkflow_facts_snapshot`. Nothing fails — the model simply calls a
 *      name that does not exist, at the moment it is already stuck.
 *   2. `docs/user-guide.md` never named `inkflow_backup_restore`, so half of the
 *      documented backup story had no discoverable entry point.
 *   3. The guide's own count read "三十四个工具（18 个内置 + 16 个域工具）": impossible
 *      on its face (18+16≠34) and wrong on both halves (the real split was 34+16=50).
 *
 * Three assertions, all about names and counts:
 *
 *   A. SOURCE — every `inkflow_*` mention under `src/` resolves to a registered tool
 *      (`name: 'inkflow_…'`). Wildcards are skipped: `inkflow_*` and the `inkflow_
 *      outline_*` / `inkflow_semantic_*` families are prose, not names.
 *   B. GUIDE — every registered tool is mentioned in `docs/user-guide.md`.
 *   C. COUNT — that one sentence's three numbers match what `src/` registers, with
 *      "domain tool" = defined under `src/host/domains/` (the whole of X-5).
 *
 * Run: node scripts/check-tool-names.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const GUIDE = join(ROOT, 'docs', 'user-guide.md')

/** A definition: `name: 'inkflow_…'` — the one shape `tools.register()` consumes. */
const DEFINITION = /name:\s*'inkflow_[a-z0-9_]+'/g
/** Any mention. No capitals, no dashes: a tool name never carries them. */
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

const relOf = (file) => relative(ROOT, file).replaceAll('\\', '/')

const failures = []
const sources = walk(join(ROOT, 'src'))
/** name → true when a domain module owns it (X-5: one line in `DOMAIN_MODULES`). */
const registered = new Map()

for (const file of sources) {
  const isDomain = relOf(file).startsWith('src/host/domains/')
  for (const match of readFileSync(file, 'utf8').match(DEFINITION) ?? []) {
    registered.set(match.replace(/^name:\s*'|'$/g, ''), isDomain)
  }
}

if (registered.size === 0) {
  failures.push('src/: no tool definition was found at all (did the registry move?) — this gate cannot pass vacuously')
}

const domainCount = [...registered.values()].filter(Boolean).length
const builtInCount = registered.size - domainCount

/** `index` is a `*`/`_` wildcard, not a name. */
function isWildcard(text, start, length) {
  const name = text.slice(start, start + length)
  const next = text.slice(start + length, start + length + 1)
  return next === '*' || name.endsWith('_')
}

for (const file of sources) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(MENTION)) {
    const start = match.index ?? 0
    const name = match[0]
    if (isWildcard(text, start, name.length)) continue
    if (registered.has(name)) continue
    const line = text.slice(0, start).split('\n').length
    failures.push(`${relOf(file)}:${line}: mentions ${name}, which no tool registers (typo or a renamed tool)`)
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
  for (const name of [...registered.keys()].sort()) {
    if (!documented.has(name)) failures.push(`docs/user-guide.md: never names ${name} (the tool exists but is undiscoverable)`)
  }

  const stated = /(\d+)\s*个工具[（(]\s*(\d+)\s*个内置\s*\+\s*(\d+)\s*个域工具/u.exec(guide)
  if (stated === null) {
    failures.push(
      'docs/user-guide.md: the "N 个工具（M 个内置 + K 个域工具）" sentence is gone or no longer numeric — keep it so this gate can check it',
    )
  } else {
    const [total, builtIn, domain] = stated.slice(1).map(Number)
    if (total !== registered.size || builtIn !== builtInCount || domain !== domainCount) {
      failures.push(
        `docs/user-guide.md: says ${String(total)} tools (${String(builtIn)} built-in + ${String(domain)} domain), ` +
          `but src/ registers ${String(registered.size)} (${String(builtInCount)} built-in + ${String(domainCount)} domain)`,
      )
    }
  }
}

if (failures.length > 0) {
  console.error('tool-name check failed:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(
  `tool names ok: ${String(registered.size)} registered tool(s) (${String(builtInCount)} built-in + ${String(domainCount)} domain), ` +
    'all mentioned in docs/user-guide.md with matching counts, no stray mention under src/',
)
