/**
 * Skill-number gate (zero dependencies) — the 「按章计次」 rules.
 *
 * The defect this exists for: `gate-vocabulary.ts` counts a **density** (破折号 0.6/千字) while
 * both writing skills said 「一章 0–1 处」. Two phrasings of one thing, and a model reading both
 * picks the looser one — that is not a documentation nit, it is the gate's threshold being
 * quietly overridden (ADR-0027 D5 records the same accident by name).
 *
 * So the numbers in the skills are no longer prose: a gate threshold written into a `SKILL.md`
 * must carry a marker on the same line, and the number immediately to its left must equal the
 * value in the single-source table:
 *
 *     破折号每千字 0.6 处（门禁 `aiDashPer1000`）
 *
 * Three assertions, all of them mechanical:
 *
 *   1. **对拍**：every `（门禁 \`key\`）` marker's number equals that key's value in
 *      `gate-vocabulary.ts` (the single source, ADR-0027 D5). A mismatch prints
 *      `file:line` and 「skill 写 X，词汇表是 Y」.
 *   2. **覆盖**：the thresholds each skill is required to state are actually stated, so
 *      deleting a line turns this red instead of silently lowering the bar.
 *   3. **旧措辞**：the per-chapter phrasing 「一章 N–M 处」 is refused outright — it is the
 *      wording that drifted, and a re-introduction is the same defect again.
 *
 * Run: node scripts/check-skill-numbers.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const VOCABULARY = join(ROOT, 'src', 'host', 'gate-vocabulary.ts')
const SKILLS = join(ROOT, 'skills')

/** The threshold tables the skills may quote. Adding one here is how a new table gets covered. */
const TABLES = ['GATE_DEFAULTS', 'DEGENERATION', 'FRAGMENT']

/**
 * What each skill must state, and why it must:
 *
 *   * `inkflow-writer` writes the chapter — the densities it is judged on while writing.
 *   * `inkflow-polisher` touches sentences — the dash limit plus the three 太碎 bounds it is
 *     the one skill able to break by chopping every long sentence.
 *
 * A number that is required here but missing from the file is a gate that only runs after the
 * model has already read the looser instruction.
 */
const REQUIRED = {
  'skills/inkflow-writer/SKILL.md': ['aiDashPer1000', 'aiEllipsisPer1000', 'aiModifierPer1000', 'aiSentenceMeanMax'],
  'skills/inkflow-polisher/SKILL.md': [
    'aiDashPer1000',
    'stutterRun',
    'stutterSentenceMax',
    'lowLinkPer1000',
    'longParaChars',
  ],
}

/**
 * Phrasings that contradict the vocabulary. 「一章 0–1 处」 counts occurrences per chapter while
 * the gate counts per mille, and 0.6/千字 × 2500 字 ≈ 1.5 处 — the two were never the same
 * sentence twice. A range is what drifts, so a range is what is refused.
 */
const BANNED = [
  { pattern: /一章\s*[0-9]+\s*[–—\-~～]\s*[0-9]+\s*处/u, why: '「一章 N–M 处」是按章计次的口径，门禁按每千字密度判；改成「每千字 X 处（门禁 `键`）」' },
]

const failures = []

// ---------------------------------------------------------------------------
// 1. Read the single source
// ---------------------------------------------------------------------------

/** Strip line and block comments so a digit inside a note is not mistaken for a value. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\/\/[^\n]*/gu, ' ')
}

/** The object literal of a top-level `export const NAME` (closed by a `}` in column 0). */
function tableBody(source, name) {
  const pattern = new RegExp(`^export const ${name}\\b[^\\n]*\\{([\\s\\S]*?)^\\}`, 'mu')
  const match = pattern.exec(source)
  if (match === null) throw new Error(`gate-vocabulary.ts has no \`${name}\` object literal — renamed? this gate must follow it`)
  return stripComments(match[1])
}

const vocabulary = readFileSync(VOCABULARY, 'utf8')
/** key → { table, value }: the lookup a marker is resolved against. */
const numbers = new Map()
for (const table of TABLES) {
  for (const row of tableBody(vocabulary, table).matchAll(/([A-Za-z][A-Za-z0-9_]*)\s*:\s*(-?\d+(?:\.\d+)?)/gu)) {
    const key = row[1]
    const value = Number(row[2])
    const existing = numbers.get(key)
    // Two tables sharing a key would make a bare marker ambiguous; refuse rather than guess.
    if (existing !== undefined) {
      failures.push(`gate-vocabulary.ts: 「${key}」 appears in both ${existing.table} and ${table} — a skill marker could not say which one it means`)
      continue
    }
    numbers.set(key, { table, value })
  }
}
if (numbers.size < 8) {
  failures.push(`gate-vocabulary.ts: only ${String(numbers.size)} threshold(s) parsed from ${TABLES.join('/')} — the tables were reshaped and this gate can no longer read them`)
}

// ---------------------------------------------------------------------------
// 2. Walk the skills
// ---------------------------------------------------------------------------

function skillFiles() {
  const out = []
  for (const entry of readdirSync(SKILLS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(SKILLS, entry.name, 'SKILL.md')
    try {
      readFileSync(file)
      out.push(file)
    } catch {
      // A skill directory without a SKILL.md is not this gate's business.
    }
  }
  return out.sort()
}

const MARKER = /（门禁\s*`([A-Za-z][A-Za-z0-9_]*)`/gu
const NUMBER = /(\d+(?:\.\d+)?)/gu
/** file → Set(key): which required thresholds this file actually quotes. */
const marked = new Map()
let markerCount = 0

const files = skillFiles()
for (const file of files) {
  const rel = relative(ROOT, file).replaceAll('\\', '/')
  const found = new Set()
  marked.set(rel, found)
  const lines = readFileSync(file, 'utf8').split('\n')
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]
    const where = `${rel}:${String(at + 1)}`
    for (const banned of BANNED) {
      if (banned.pattern.test(line)) failures.push(`${where}: ${banned.why}`)
    }
    for (const marker of line.matchAll(MARKER)) {
      const key = marker[1]
      const known = numbers.get(key)
      if (known === undefined) {
        failures.push(`${where}: 标记的阈值「${key}」不在 gate-vocabulary.ts 的 ${TABLES.join('/')} 里`)
        continue
      }
      // The number the skill asserts is the nearest one to the LEFT of the marker on that line:
      // each item writes its own value right before its marker, which keeps the prose readable.
      const prefix = line.slice(0, marker.index ?? 0)
      const written = [...prefix.matchAll(NUMBER)].at(-1)
      if (written === undefined) {
        failures.push(`${where}: 标记「${key}」左边没有数字——把阈值写在同一行紧邻标记处`)
        continue
      }
      markerCount += 1
      found.add(key)
      if (Number(written[1]) !== known.value) {
        failures.push(`${where}: skill 写 ${written[1]}，词汇表 ${key} 是 ${String(known.value)}（${known.table}）`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Coverage: a required threshold that vanished is the same drift, one edit later
// ---------------------------------------------------------------------------

for (const [rel, keys] of Object.entries(REQUIRED)) {
  const found = marked.get(rel)
  if (found === undefined) {
    failures.push(`${rel}: 文件不存在（脚本从这里读 skill 的阈值）`)
    continue
  }
  for (const key of keys) {
    if (numbers.get(key) === undefined) failures.push(`${rel}: REQUIRED 里的「${key}」不在词表里——先修脚本或词表`)
    else if (!found.has(key)) failures.push(`${rel}: 没有以「（门禁 \`${key}\`）」的写法给出这个阈值——skill 与门禁必须同源`)
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  console.error(`\nskill-number gate failed: ${String(failures.length)}`)
  process.exit(1)
}
console.log(`skill numbers ok: ${String(markerCount)} threshold marker(s) across ${String(files.length)} skill file(s)`)
