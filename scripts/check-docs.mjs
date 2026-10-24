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

/**
 * The user guide is the only document a first-time reader walks top to bottom, so
 * its numbering is a navigational contract: `### 5.14` twice means one of the two
 * sections is unreachable by number, and an in-page anchor `(#515-…)` silently
 * points at the wrong one (#close-out: the semantic section shipped as a second 5.14).
 * Every `## N.` block's `### N.M` children must therefore be 1, 2, 3 … in order.
 */
function checkGuideNumbering() {
  const guide = join(ROOT, 'docs', 'user-guide.md')
  const rel = 'docs/user-guide.md'
  let text
  try {
    text = readFileSync(guide, 'utf8')
  } catch {
    return
  }
  let parent
  let expected = 1
  let line = 0
  for (const row of text.split('\n')) {
    line += 1
    const top = /^##\s+(\d+)\.\s/u.exec(row)
    if (top !== null) {
      parent = Number(top[1])
      expected = 1
      continue
    }
    const sub = /^###\s+(\d+)\.(\d+)\s/u.exec(row)
    if (sub === null) continue
    const major = Number(sub[1])
    const minor = Number(sub[2])
    if (parent !== undefined && major !== parent) {
      failures.push(`${rel}:${line}: "### ${major}.${minor}" sits under a "## ${parent}." block`)
      continue
    }
    if (minor !== expected) {
      failures.push(`${rel}:${line}: "### ${major}.${minor}" should be "### ${major}.${expected}" (numbering must run 1, 2, 3 … with no gap or repeat)`)
      // Keep walking from what the file says, so one duplicate does not cascade into
      // a report of every later heading.
      expected = minor
    }
    expected += 1
  }
}

checkGuideNumbering()

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  console.error(`\ndocs gate failed: ${failures.length}`)
  process.exit(1)
}
console.log(`docs ok: ${files.length} markdown file(s)`)
