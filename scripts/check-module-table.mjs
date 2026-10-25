/**
 * Module-table gate (zero dependencies).
 *
 * `architecture.md` §6 is the entry point a new reader uses to answer "who owns
 * this?" (AGENTS.md §9). A table that silently stops at last release's modules is
 * worse than no table: it reads as complete (the 0.3.0 modules were
 * missing and nobody noticed, because nothing looked).
 *
 * Two assertions, both about §6 only:
 *
 *   1. HOST — every `src/host/*.ts` file is named in §6 as `src/host/<name>.ts`.
 *      The full path, not the bare file name: a passing mention inside another
 *      module's prose is not a row, and the row is what a reader scans.
 *   2. CLIENT PURE MODELS — §6 carries ONE subsection about the pure view models
 *      and it lists every `src/client/*-model.ts`. They are a group (no React, no
 *      network, no IO: the panel's decisions, unit-tested), so they are listed as a
 *      group rather than one row each — but "a group" must still be complete, or the
 *      file that a panel's logic actually lives in is invisible.
 *
 * Run: node scripts/check-module-table.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SPEC = join(ROOT, '.agents', 'specs', 'architecture.md')

/** The heading §6 must keep using, so the slice stays findable. */
const SECTION_HEADING = /^##\s+6\.\s/m
/** Where §6 ends: the next `## N.` heading. */
const NEXT_SECTION = /^##\s+\d+\.\s/m
/** The subsection that owns the client pure models (its wording may change). */
const PURE_MODEL_HEADING = /^(#{3,6})[^\n]*纯模型[^\n]*$/m
/** A listed model: `panel-model.ts`, `hub-shared-model.ts`, … */
const MODEL_MENTION = /[A-Za-z0-9][A-Za-z0-9_-]*-model\.ts/g

function listTs(dir) {
  return readdirSync(join(ROOT, dir))
    .filter((name) => name.endsWith('.ts'))
    .sort()
}

const failures = []

const text = readFileSync(SPEC, 'utf8')
const start = text.search(SECTION_HEADING)
if (start < 0) {
  console.error('✗ architecture.md has no "## 6." section — the module table moved; fix this script or the spec')
  process.exit(1)
}
const rest = text.slice(start)
const tail = rest.slice(1)
const endMatch = NEXT_SECTION.exec(tail)
const section = endMatch === null ? rest : rest.slice(0, endMatch.index + 1)

// ---------------------------------------------------------------------------
// 1. Every host module has a row
// ---------------------------------------------------------------------------

const hostFiles = listTs('src/host')
const missingHost = hostFiles.filter((name) => !section.includes(`src/host/${name}`))
if (missingHost.length > 0) {
  failures.push(
    `${String(missingHost.length)} host module(s) have no row in architecture.md §6:\n` +
      missingHost.map((name) => `    src/host/${name}`).join('\n') +
      '\n  Add one row each: what it ONLY does / what it does NOT do, taken from the file header.',
  )
}

// ---------------------------------------------------------------------------
// 2. The client pure models are listed as one complete group
// ---------------------------------------------------------------------------

const heading = PURE_MODEL_HEADING.exec(section)
let modelCount = 0
const modelFiles = listTs('src/client').filter((name) => name.endsWith('-model.ts'))
if (heading === null) {
  failures.push(
    'architecture.md §6 has no "客户端纯模型" subsection: the pure view models must be listed as ONE group ' +
      '(a head comment saying "no React, no network, no IO" is the point of the group).',
  )
} else {
  // The group's own text: from its heading to the next heading of the same depth.
  const level = heading[1]
  const from = heading.index
  const afterHeading = section.slice(from + heading[0].length)
  const stop = new RegExp(`^#{1,${String(level.length)}}\\s`, 'm').exec(afterHeading)
  const group = stop === null ? afterHeading : afterHeading.slice(0, stop.index)
  const listed = new Set(group.match(MODEL_MENTION) ?? [])
  modelCount = listed.size
  const missingModels = modelFiles.filter((name) => !listed.has(name))
  if (missingModels.length > 0) {
    failures.push(
      `${String(missingModels.length)} client pure model(s) are missing from the 客户端纯模型 group:\n` +
        missingModels.map((name) => `    src/client/${name}`).join('\n'),
    )
  }
  // The count is not decoration: a group that collapsed to one bullet would satisfy
  // the "lists every model" rule only by accident of the section being empty.
  if (modelCount < 3) {
    failures.push(`the 客户端纯模型 group lists ${String(modelCount)} model(s); it is a group, not a row — list them all`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  console.error(`\nmodule table gate failed: ${failures.length}`)
  process.exit(1)
}

console.log(
  `module table ok: ${String(hostFiles.length)} host module(s) with a row, ` +
    `${String(modelCount)} client pure model(s) in one group`,
)
