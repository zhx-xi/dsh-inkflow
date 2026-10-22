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
  classifyReadFailure,
  evaluateProtection,
  flattenProtection,
  protectionPayload,
  reviewRequirement,
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

test('apply carries over an already-enabled review requirement', () => {
  // PUT /protection replaces the whole object: the CI gate must not delete a
  // "require 1 approval" rule it does not own (review finding S1).
  const withReviews = protectionPayload(undefined, {
    required_pull_request_reviews: { dismiss_stale_reviews: true, required_approving_review_count: 2 },
  })
  assert.deepEqual(withReviews.required_pull_request_reviews, {
    dismiss_stale_reviews: true,
    required_approving_review_count: 2,
  })
  // Nothing enabled today stays nothing.
  assert.equal(protectionPayload().required_pull_request_reviews, null)
})

test('a review requirement we cannot mirror is reported as unknown, never guessed', () => {
  // Guessing either widens (silently dropping an allowlist) or tightens (adding
  // an approval requirement a single-author repo cannot satisfy) — so `apply`
  // refuses instead of inventing a value (review finding N3).
  const unknown = reviewRequirement({ required_pull_request_reviews: { something_new: true } })
  assert.equal(unknown.kind, 'unknown')
  const payload = protectionPayload(undefined, { required_pull_request_reviews: { something_new: true } })
  assert.equal(payload.required_pull_request_reviews, null)
  assert.equal(reviewRequirement(undefined).kind, 'none')
})

test('allowlists are carried over verbatim, not flattened away', () => {
  const allow = { users: [{ login: 'alice' }], teams: [], apps: [] }
  const carried = reviewRequirement({
    required_pull_request_reviews: { required_approving_review_count: 1, bypass_pull_request_allowances: allow },
  })
  assert.equal(carried.kind, 'known')
  assert.deepEqual(carried.value.bypass_pull_request_allowances, allow)
})

test('a 404 "Branch not protected" is its own kind of read failure (issue #99)', () => {
  // This is the emergency exit's starting state: nothing to carry over, so apply
  // must proceed. Any other failure means "current settings unknown" and apply
  // must refuse — the two must not collapse into one.
  assert.equal(classifyReadFailure('gh: Branch not protected (HTTP 404)'), 'unprotected')
  assert.equal(classifyReadFailure('gh: Not Found (HTTP 404)'), 'unavailable')
  assert.equal(classifyReadFailure('Branch not protected'), 'unavailable')
  assert.equal(classifyReadFailure('gh: HTTP 401: Bad credentials'), 'unavailable')
  assert.equal(classifyReadFailure('gh unavailable (spawnSync gh ENOENT)'), 'unavailable')
  assert.equal(classifyReadFailure(undefined), 'unavailable')
})
