/**
 * The shared finding vocabulary (issue #121, roadmap X-14).
 *
 * The value of this suite is entirely in the two cross-checks, not in the types:
 *
 *   1. **code ↔ spec**: every code in `FINDING_CODES` must be documented in
 *      `.agents/specs/data-model.md`, and every validation code the host's domain
 *      modules actually emit must be in `FINDING_CODES`. Without the second
 *      direction, #33's report would silently miss a code that exists; without the
 *      first, a code could be invented in code and never reach the invariant table.
 *   2. **order**: `compareFindings` has to be a total order, or a report of the same
 *      unchanged project reorders itself between runs and stops being diffable.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FINDING_CODES, FINDING_GROUPS, compareFindings, findingCode, locatorKey } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

/**
 * Catalogue entries that **no host code emits today**, each for a stated reason:
 *
 *   * `FACT_LINE_MALFORMED` / `FACT_CONFLICT` — invariants I-22 / I-23, reserved for
 *     #32 (the ledger domain does not exist yet);
 *   * `FORESHADOW_TRANSITION_INVALID` — invariant I-21, reserved for #31;
 *   * `ENTITIES_DRIFT` — invariant I-15, which #23 made *unrepresentable* instead of
 *     checked (rows and projection are written from one scan in one transaction), so
 *     nothing can emit it. The name stays in the vocabulary so #33's report and any
 *     future checker can use it without re-adding the code.
 *
 * A code listed here but absent from the catalogue is an error, not an exemption.
 */
const RESERVED_CODES = new Set([
  'ENTITIES_DRIFT',
  'FACT_CONFLICT',
  'FACT_LINE_MALFORMED',
  'FORESHADOW_TRANSITION_INVALID',
])

/**
 * Codes that are **not** findings: the write path's argument rejections and the
 * plugin's own infrastructure errors. They are listed here, not derived, so that a
 * new code forces a decision — add it to `FINDING_CODES` (it describes a problem in
 * the book) or to this list (it describes a bad request). Nothing may be in neither.
 *
 * The distinction is a real one, not bookkeeping: a finding is something the audit
 * report lists and the repair pass can fix after the fact; `TITLE_REQUIRED` is
 * answered with 400 to a caller who is still typing.
 */
const WRITE_SIDE_CODES = new Set([
  // argument/shape rejections (write plans and tools)
  'CATEGORY_INVALID',
  'CHAPTER_INVALID',
  'CHARACTER_ALIAS_DUPLICATE',
  'CHARACTER_FIELD_INVALID',
  'CHARACTER_FIRST_APPEARANCE_INVALID',
  'CHARACTER_NAME_REQUIRED',
  'CHARACTER_STATE_INVALID',
  'CONFIRM_REQUIRED',
  'ENTITY_REQUIRED',
  'KEYWORD_INVALID',
  'ORDER_INVALID',
  'OUTLINE_KIND_UNKNOWN',
  'PARTICIPANT_INVALID',
  'PRIORITY_INVALID',
  'SLUG_INVALID',
  'TIMELINE_STATUS_INVALID',
  'TIMELINE_UPSERT_REQUIRES_CONFIRMATION',
  'TITLE_INVALID',
  'TITLE_REQUIRED',
  'WORLD_UPSERT_REQUIRES_CONFIRMATION',
  // infrastructure: not a problem in the book, a state of the plugin or the disk
  'CONFIRM_REQUIRED_DUPLICATE_PLACEHOLDER',
  'FILE_CHANGED',
  'FILE_EXISTS',
  'FILE_UNREADABLE',
  'INDEX_BUILD_FAILED',
  'INDEX_UNAVAILABLE',
  'NOT_AN_INKFLOW_PROJECT',
])

/**
 * Validation codes the host emits today, read from the source rather than a list
 * copied by hand: a hand-kept list would be exactly the drift this test exists to
 * catch.
 *
 * `src/host/domains/*.ts` + the seam files that also report invariants. Every
 * `code: 'SHOUTY_CASE'` literal is a candidate; io/route error codes are
 * lowercase-with-dashes and therefore cannot match the pattern.
 */
function emittedValidationCodes() {
  const files = [
    ...readdirSync(join(repoRoot, 'src/host/domains'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(repoRoot, 'src/host/domains', name)),
    join(repoRoot, 'src/host/indexer.ts'),
    join(repoRoot, 'src/host/index-build.ts'),
    join(repoRoot, 'src/host/catalog.ts'),
  ]
  const codes = new Set()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/\bcode:\s*'([A-Z][A-Z0-9_]{3,})'/g)) codes.add(match[1])
  }
  return codes
}

test('findings: every catalogue code is documented in data-model §5', () => {
  const spec = readFileSync(join(repoRoot, '.agents/specs/data-model.md'), 'utf8')
  assert.ok(FINDING_CODES.length >= 20, 'the catalogue is expected to cover the whole invariant table')
  for (const spec_ of FINDING_CODES) {
    assert.ok(spec.includes(spec_.code), `${spec_.code} is missing from data-model.md`)
  }
})

test('findings: every host validation code is either a finding or a declared rejection', () => {
  const emitted = emittedValidationCodes()
  assert.ok(emitted.size > 10, `expected the scan to find codes, found ${String(emitted.size)}`)
  const known = new Set(FINDING_CODES.map((entry) => entry.code))
  const unknown = [...emitted]
    .filter((code) => !known.has(code) && !WRITE_SIDE_CODES.has(code))
    .sort()
  assert.deepEqual(
    unknown,
    [],
    'a code in neither FINDING_CODES nor WRITE_SIDE_CODES: classify it (a problem in the book → catalogue; a bad request → the list)',
  )
  // And the other way: a catalogue entry nobody emits must be a declared reservation.
  const stale = [...known]
    .filter((code) => !emitted.has(code) && !RESERVED_CODES.has(code))
    .sort()
  assert.deepEqual(stale, [], 'these are in the catalogue but no host code emits them')
  for (const code of RESERVED_CODES) {
    assert.ok(known.has(code), `${code} is reserved but not in the catalogue`)
    assert.equal(emitted.has(code), false, `${code} is emitted now: drop the reservation`)
  }
  // The rejection list must not shadow a real finding.
  for (const code of WRITE_SIDE_CODES) assert.equal(known.has(code), false, `${code} is a finding, not a rejection`)
})

test('findings: every catalogue code carries a group, a meaning and a lookup', () => {
  const groups = new Set(FINDING_GROUPS)
  for (const entry of FINDING_CODES) {
    assert.ok(groups.has(entry.group), `${entry.code} has an unknown group ${entry.group}`)
    assert.ok(entry.meaning.trim() !== '', `${entry.code} has no meaning`)
    assert.equal(findingCode(entry.code), entry)
  }
  assert.equal(findingCode('NO_SUCH_CODE'), undefined)
  // Codes are unique: two entries for one code would make `findingCode` arbitrary.
  assert.equal(new Set(FINDING_CODES.map((entry) => entry.code)).size, FINDING_CODES.length)
})

test('findings: compareFindings is a total order (group, severity, locator)', () => {
  const make = (overrides) => ({
    code: 'DUPLICATE_ID',
    group: 'structure',
    severity: 'warning',
    locator: { kind: 'path', path: 'world/a.md' },
    detail: 'x',
    hint: 'y',
    fixable: false,
    ...overrides,
  })
  const blocking = make({ severity: 'blocking' })
  const warning = make({ severity: 'warning' })
  const info = make({ severity: 'info', code: 'ID_PATH_DIVERGED' })
  const otherGroup = make({ group: 'timeline', severity: 'info' })

  assert.ok(compareFindings(blocking, warning) < 0)
  assert.ok(compareFindings(warning, info) < 0)
  assert.ok(compareFindings(info, otherGroup) < 0, 'group order comes from FINDING_GROUPS')
  assert.equal(compareFindings(warning, make({})), 0, 'equal findings compare equal')

  // Total order: sorting any order of the same set yields the same sequence.
  const items = [otherGroup, info, blocking, warning]
  const forward = [...items].sort(compareFindings).map((entry) => `${entry.group}:${entry.severity}:${entry.code}`)
  const backward = [...items].reverse().sort(compareFindings).map((entry) => `${entry.group}:${entry.severity}:${entry.code}`)
  assert.deepEqual(forward, backward)
})

test('findings: locatorKey renders a resolvable address for every locator kind', () => {
  assert.equal(locatorKey({ kind: 'entity', entityKind: 'world', id: 'world/门派/a.md' }), 'world:world/门派/a.md')
  assert.equal(locatorKey({ kind: 'chapter', chapterId: 'ch-0001' }), 'chapter:ch-0001')
  assert.equal(locatorKey({ kind: 'catalog' }), 'catalog:')
  assert.equal(locatorKey({ kind: 'catalog', volumeId: 'vol-02' }), 'catalog:vol-02')
  assert.equal(locatorKey({ kind: 'path', path: 'facts/a.md' }), 'facts/a.md')
  assert.equal(locatorKey({ kind: 'path', path: 'facts/a.md', line: 7 }), 'facts/a.md#L7')
})
