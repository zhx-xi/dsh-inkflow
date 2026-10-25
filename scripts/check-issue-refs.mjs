#!/usr/bin/env node
/**
 * No code file may name a GitHub issue or pull request (#NNN).
 *
 * WHY: an issue number is project management, not code. Inside source it rots the moment
 * the issue is closed and it tells the next reader nothing about *why* the code is shaped
 * this way — the reason has to be written out in words (and the number belongs in the
 * commit message / PR / issue thread, where D7 already puts evidence). The user's rule
 * (2026-10-25) is absolute for code: `src/`, `scripts/`, `tests/`.
 *
 * WHAT IS NOT A VIOLATION: a hex colour (`#f143ab`, `#000`), a CSS/JS template marker
 * (`#{…}`), a fragment anchor in a URL, and a number that only *looks* like an issue id
 * because somebody wrote a colour without a letter. Those are filtered below by context so
 * the check can stay strict instead of growing an allowlist of files.
 *
 * Docs are deliberately out of scope (`.agents/**`, `docs/**`): specs and ADRs legitimately
 * cite the issue a decision came from — that is a record, not code.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const TREES = ['src/', 'scripts/', 'tests/']
const CODE = /\.(?:ts|tsx|js|mjs|cjs)$/u
const REF = /#(\d{1,4})\b/gu

/** Colour-ish or template-ish neighbours that make a `#NNN` something else entirely. */
function isNotAnIssueRef(line, index, token) {
  const before = line.slice(Math.max(0, index - 40), index)
  const after = line.slice(index + token.length, index + token.length + 8)
  // `#{` template start, `&amp;#` entity, a URL fragment.
  if (after.startsWith('{') || after.startsWith('&')) return true
  if (/https?:\/\/\S*$/u.test(before)) return true
  // A colour property: `color: '#000'`, `fill="#219"`, `background: #fff`.
  if (/(?:color|colour|background|bg|border|fill|stroke|shadow|tint)\s*[:=]\s*['"]?$/iu.test(before)) return true
  // A 3/4/6/8-digit hex immediately followed by more hex (e.g. `#1a2b3c`): not an issue id.
  if (/^[0-9a-fA-F]{3,8}$/u.test(token.slice(1)) && /[0-9a-fA-F]/u.test(after[0] ?? '')) return true
  return false
}

const files = execFileSync('git', ['ls-files', ...TREES], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => file !== '' && CODE.test(file))

const findings = []
for (const file of files) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(REF)) {
      if (isNotAnIssueRef(line, match.index, match[0])) continue
      findings.push({ file, line: index + 1, token: match[0], text: line.trim().slice(0, 120) })
    }
  })
}

if (process.argv.includes('--list')) {
  for (const finding of findings) console.log(`${finding.file}:${String(finding.line)}  ${finding.token}  ${finding.text}`)
  const perFile = new Map()
  for (const finding of findings) perFile.set(finding.file, (perFile.get(finding.file) ?? 0) + 1)
  console.log(`\n${String(findings.length)} issue/PR reference(s) in ${String(perFile.size)} code file(s)`)
  process.exit(0)
}

if (findings.length > 0) {
  console.error(`issue refs: ${String(findings.length)} GitHub issue/PR reference(s) in code — write the reason in words instead`)
  for (const finding of findings.slice(0, 40)) {
    console.error(`  ${finding.file}:${String(finding.line)}  ${finding.token}`)
  }
  if (findings.length > 40) console.error(`  … and ${String(findings.length - 40)} more (run with --list)`)
  process.exit(1)
}
console.log('issue refs ok: no GitHub issue/PR numbers in code')
