/**
 * Documentation gate (zero dependencies).
 *
 * Encodes the doc rules from AGENTS.md §9.3/§9.5 that a link checker cannot see:
 *   - a spec/ADR file stays under 800 lines (S6)
 *   - docs never link to gitignored paths such as lib/ or .tmp/ (D2)
 *
 * Run: node scripts/check-docs.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const MAX_LINES = 800
const failures = []

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

const files = [
  join(ROOT, 'AGENTS.md'),
  join(ROOT, 'CLAUDE.md'),
  join(ROOT, 'README.md'),
  ...walk(join(ROOT, '.agents')),
  ...walk(join(ROOT, 'docs')),
]

const GITIGNORED = /(^|\/)(lib|node_modules|\.tmp)\//

for (const file of files) {
  const rel = relative(ROOT, file).replaceAll('\\', '/')
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const lines = text.split('\n')
  if (rel.startsWith('.agents/') && lines.length > MAX_LINES) {
    failures.push(`${rel}: ${lines.length} lines > ${MAX_LINES} (split it or move detail to references/)`)
  }
  // Only markdown link targets count: plain prose may name a gitignored file
  // without promising that it is readable (e.g. AGENTS.md says `lib/` is not committed).
  const linkPattern = /\]\(([^)\s]+)\)/g
  let match
  while ((match = linkPattern.exec(text)) !== null) {
    const target = match[1]
    if (/^(https?:|#|mailto:)/.test(target)) continue
    if (GITIGNORED.test(target) || target.startsWith('../.tmp/') || target.startsWith('./.tmp/')) {
      failures.push(`${rel}: links to a gitignored path: ${target} (D2)`)
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  console.error(`\ndocs gate failed: ${failures.length}`)
  process.exit(1)
}
console.log(`docs ok: ${files.length} markdown file(s)`)
