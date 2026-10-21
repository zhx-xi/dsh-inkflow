/**
 * The pre-merge gate is only real if the repository can prove the GitHub
 * protection settings are still what the documents promise. These tests drive
 * the pure evaluator: every case below answers "would a specific settings edit
 * be caught?" — a test that cannot fail on a broken evaluator is worthless
 * (AGENTS.md §10.3).
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXPECTED,
  REQUIRED_CONTEXTS,
  evaluateProtection,
  flattenProtection,
  protectionPayload,
} from '../scripts/branch-protection-rules.mjs'

/** A GitHub-shaped payload that satisfies the expectation, built from the write path. */
const goodApi = () => {
  const payload = protectionPayload()
  const enabled = (value) => ({ enabled: value })
  return {
    required_status_checks: payload.required_status_checks,
    enforce_admins: enabled(payload.enforce_admins),
    allow_force_pushes: enabled(payload.allow_force_pushes),
    allow_deletions: enabled(payload.allow_deletions),
    required_conversation_resolution: enabled(payload.required_conversation_resolution),
  }
}

test('the expected gate lists lint, both test legs and package', () => {
  assert.deepEqual(REQUIRED_CONTEXTS, [
    'lint',
    'test (ubuntu-latest)',
    'test (windows-latest)',
    'docs',
    'package',
  ])
  assert.equal(EXPECTED.strict, true)
  assert.equal(EXPECTED.enforceAdmins, true)
})

test('apply payload round-trips through the evaluator without problems', () => {
  const actual = flattenProtection(goodApi())
  const result = evaluateProtection(actual)
  assert.deepEqual(result.problems, [])
  assert.equal(result.ok, true)
  assert.deepEqual(actual.requiredContexts, REQUIRED_CONTEXTS)
  assert.equal(actual.strict, true)
  assert.equal(actual.enforceAdmins, true)
})

test('dropping one required check is reported by name', () => {
  const api = goodApi()
  api.required_status_checks.contexts = ['lint', 'test (ubuntu-latest)', 'test (windows-latest)', 'package']
  const result = evaluateProtection(flattenProtection(api))
  assert.equal(result.ok, false)
  assert.deepEqual(result.problems, ['required check missing: docs'])
})

test('every single flag edit fails on its own', () => {
  const cases = [
    ['strict', (api) => { api.required_status_checks.strict = false }],
    ['enforceAdmins', (api) => { api.enforce_admins.enabled = false }],
    ['allowForcePushes', (api) => { api.allow_force_pushes.enabled = true }],
    ['allowDeletions', (api) => { api.allow_deletions.enabled = true }],
    ['requiredConversationResolution', (api) => { api.required_conversation_resolution.enabled = false }],
  ]
  for (const [flag, breakIt] of cases) {
    const api = goodApi()
    breakIt(api)
    const result = evaluateProtection(flattenProtection(api))
    assert.equal(result.ok, false, `editing ${flag} must fail the gate`)
    assert.equal(result.problems.length, 1, `editing ${flag} must produce exactly one problem: ${result.problems.join('; ')}`)
  }
})

test('an unprotected branch fails every item instead of throwing', () => {
  const result = evaluateProtection(flattenProtection(null))
  assert.equal(result.ok, false)
  // Five missing contexts, plus the three "must be true" flags. The two
  // "must be false" flags are already false on an unprotected branch, so they
  // are correctly silent.
  assert.equal(result.problems.length, REQUIRED_CONTEXTS.length + 3)
  assert.match(result.problems[0], /required check missing: lint/)
})

test('flattenProtection prefers checks[] over the legacy contexts[]', () => {
  const api = {
    required_status_checks: {
      strict: true,
      contexts: ['lint'],
      checks: [{ context: 'lint' }, { context: 'package' }],
    },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_conversation_resolution: { enabled: true },
  }
  const actual = flattenProtection(api)
  assert.deepEqual(actual.requiredContexts, ['lint', 'package'])
  assert.equal(actual.strict, true)
})

test('extra required checks are reported but never fail the gate', () => {
  const api = goodApi()
  api.required_status_checks.contexts = [...REQUIRED_CONTEXTS, 'e2e']
  const result = evaluateProtection(flattenProtection(api))
  assert.equal(result.ok, true)
  assert.deepEqual(result.extraContexts, ['e2e'])
})
