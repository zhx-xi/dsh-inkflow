/**
 * Relative-link checker for the documentation tree.
 *
 * Why this exists: moving docs between `.agents/{constitution,specs,adrs}` and
 * `docs/` silently breaks cross-references, and a broken link in a spec means
 * the next reader (or agent) loses the authoritative source. This runs in
 * `pnpm run check`.
 *
 * Scope: every `*.md` outside build output, dependencies, and scratch dirs.
 * Checks relative links and anchors-free paths; ignores absolute URLs.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['node_modules', 'lib', '.git', '.tmp', 'dist'])
const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.agents') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(full, out)
    } else if (entry.name.endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

function isExternal(target) {
  return (
    target.startsWith('http://') ||
    target.startsWith('https://') ||
    target.startsWith('mailto:') ||
    target.startsWith('#') ||
    target.startsWith('data:')
  )
}

function normalizeTarget(raw) {
  let target = raw.trim()
  const titleMatch = /^(\S+)\s+["'(].*$/.exec(target)
  if (titleMatch) target = titleMatch[1]
  const hash = target.indexOf('#')
  if (hash !== -1) target = target.slice(0, hash)
  return target.trim()
}

const files = walk(ROOT)
const broken = []
let checked = 0

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    LINK_RE.lastIndex = 0
    let match
    while ((match = LINK_RE.exec(line)) !== null) {
      const raw = match[1]
      if (!raw || isExternal(raw)) continue
      const target = normalizeTarget(raw)
      if (target === '') continue
      checked += 1
      const absolute = target.startsWith('/') ? join(ROOT, target) : resolve(dirname(file), target)
      try {
        statSync(absolute)
      } catch {
        broken.push({ file: relative(ROOT, file), line: i + 1, target, resolved: relative(ROOT, absolute) })
      }
    }
  }
}

if (broken.length === 0) {
  console.log(`links ok: ${checked} relative link(s) across ${files.length} markdown file(s)`)
  process.exit(0)
}

console.error(`broken links: ${broken.length} of ${checked} checked`)
for (const item of broken) {
  console.error(`  ${item.file}:${item.line} -> ${item.target}  (resolved: ${item.resolved})`)
}
process.exit(1)
