/**
 * The CLI's exit codes are the contract: `pnpm run check` reads them, and a
 * wrong code either turns a dirty protection setting into a green local gate or
 * makes an offline laptop fail the whole check chain. The pure evaluator is
 * covered by tests/branch-protection.test.js; this file only drives the process
 * (review findings F1/F2 — a fixed `skip()` must be provable, not assumed).
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

const CLI = resolve(import.meta.dirname, '..', 'scripts', 'branch-protection.mjs')
const { REQUIRED_CONTEXTS } = await import('../scripts/branch-protection-rules.mjs')

const dir = mkdtempSync(join(tmpdir(), 'inkflow-branch-protection-'))
const goodFixture = join(dir, 'good.json')
const badFixture = join(dir, 'bad.json')

/** A GitHub-shaped payload that satisfies EXPECTED, in the shape the API returns. */
function goodPayload() {
  return {
    required_status_checks: { strict: true, contexts: [...REQUIRED_CONTEXTS] },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_conversation_resolution: { enabled: true },
  }
}

writeFileSync(goodFixture, JSON.stringify(goodPayload()), 'utf8')
const bad = goodPayload()
bad.required_status_checks.contexts = REQUIRED_CONTEXTS.filter((context) => context !== 'docs')
writeFileSync(badFixture, JSON.stringify(bad), 'utf8')
process.on('exit', () => rmSync(dir, { recursive: true, force: true }))

function run(args, env = {}, cwd = undefined) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    ...(cwd === undefined ? {} : { cwd }),
  })
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/** No gh on this machine as far as the CLI is concerned. */
const NO_GH = { INKFLOW_GH: 'inkflow-no-such-gh-binary' }

/**
 * A fake `gh` that answers like the real one does on an unprotected branch.
 *
 * The CLI spawns `<INKFLOW_GH> api <route…>`, so a fake executable named `api`
 * in the cwd lets `INKFLOW_GH=node` reproduce the exact 404 stderr — the only way
 * to cover the `reason → classifyReadFailure → unprotected` wiring, which
 * `--fixture '{"unprotected":true}'` cannot (review finding R1: it faked the
 * reason and left the classifier unexercised).
 */
function fakeGhSaying(message, status = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-fake-gh-'))
  writeFileSync(join(dir, 'api'), `console.error(${JSON.stringify(message)})\nprocess.exit(${status})\n`, 'utf8')
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  return { env: { INKFLOW_GH: process.execPath }, cwd: dir }
}

test('an unprotected branch read through the real gh path lets apply proceed (issue #99)', () => {
  const fake = fakeGhSaying('gh: Branch not protected (HTTP 404)')
  const { code, out } = run(['apply', '--repo', 'owner/repo', '--dry-run'], fake.env, fake.cwd)
  assert.equal(code, 0, out)
  assert.match(out, /has no protection; installing the gate from scratch/)
  assert.match(out, /"contexts": \[\s*"lint"/)
})

test('the same 404 through the real gh path makes check red', () => {
  const fake = fakeGhSaying('gh: Branch not protected (HTTP 404)')
  const { code, out } = run(['check', '--repo', 'owner/repo', '--tolerant'], fake.env, fake.cwd)
  assert.equal(code, 1, out)
  assert.match(out, /is absent: the branch is not protected/)
})

test('a gh failure that is NOT "branch not protected" still refuses to apply', () => {
  const fake = fakeGhSaying('gh: Not Found (HTTP 404)')
  const { code, out } = run(['apply', '--repo', 'owner/repo', '--dry-run'], fake.env, fake.cwd)
  assert.equal(code, 1, out)
  assert.match(out, /refusing to apply: could not read the current protection/)
})

test('a matching payload passes and prints the flags', () => {
  const { code, out } = run(['check', '--repo', 'owner/repo', '--fixture', goodFixture])
  assert.equal(code, 0, out)
  assert.match(out, /branch-protection ok: owner\/repo main/)
  assert.match(out, /enforce-admins/)
})

test('a payload missing a required check fails and names it', () => {
  const { code, out } = run(['check', '--repo', 'owner/repo', '--fixture', badFixture])
  assert.equal(code, 1, out)
  assert.match(out, /required check missing: docs/)
})

test('--tolerant does not hide a mismatch that was actually read', () => {
  const { code, out } = run(['check', '--repo', 'owner/repo', '--fixture', badFixture, '--tolerant'])
  assert.equal(code, 1, out)
  assert.match(out, /required check missing: docs/)
  assert.doesNotMatch(out, /（未验证）/)
})

test('--tolerant exits 0 and says 未验证 when gh is unavailable', () => {
  const { code, out } = run(['check', '--repo', 'owner/repo', '--tolerant'], NO_GH)
  assert.equal(code, 0, out)
  assert.match(out, /SKIP branch-protection:/)
  assert.match(out, /（未验证）/)
})

test('without --tolerant an unavailable gh is a failure', () => {
  const { code, out } = run(['check', '--repo', 'owner/repo'], NO_GH)
  assert.equal(code, 1, out)
  assert.match(out, /could not read branch protection/)
})

test('--tolerant also covers an unresolvable repository', () => {
  const { code, out } = run(['check', '--tolerant'], NO_GH)
  assert.equal(code, 0, out)
  assert.match(out, /（未验证）/)
})

test('apply --dry-run prints the payload and touches no network', () => {
  const { code, out } = run(['apply', '--repo', 'owner/repo', '--dry-run', '--fixture', goodFixture], NO_GH)
  assert.equal(code, 0, out)
  assert.match(out, /would PUT repos\/owner\/repo\/branches\/main\/protection/)
  assert.match(out, /"required_status_checks"/)
})

test('apply refuses to PUT when the current protection cannot be read', () => {
  // PUT replaces the whole object: applying blind could delete a review
  // requirement this gate does not own (review finding N1).
  const { code, out } = run(['apply', '--repo', 'owner/repo'], NO_GH)
  assert.equal(code, 1, out)
  assert.match(out, /refusing to apply: could not read the current protection/)
})

test('apply installs the gate on an unprotected branch (the emergency exit, issue #99)', () => {
  // DELETE protection → apply → check is the documented exit. The first state is
  // "not protected at all", so apply must treat it as a normal input instead of
  // refusing (which made the exit reachable only by hand).
  const unprotected = join(dir, 'unprotected.json')
  writeFileSync(unprotected, JSON.stringify({ unprotected: true }), 'utf8')
  const { code, out } = run(['apply', '--repo', 'owner/repo', '--dry-run', '--fixture', unprotected], NO_GH)
  assert.equal(code, 0, out)
  assert.match(out, /has no protection; installing the gate from scratch/)
  assert.match(out, /"contexts": \[\s*"lint"/)
})

test('an unprotected branch is a failure for check, even under --tolerant', () => {
  const unprotected = join(dir, 'unprotected.json')
  writeFileSync(unprotected, JSON.stringify({ unprotected: true }), 'utf8')
  const { code, out } = run(['check', '--repo', 'owner/repo', '--fixture', unprotected, '--tolerant'])
  assert.equal(code, 1, out)
  assert.match(out, /is absent: the branch is not protected/)
  assert.doesNotMatch(out, /（未验证）/)
})

test('apply refuses to PUT when a review requirement cannot be mirrored', () => {
  const unknown = join(dir, 'unknown-reviews.json')
  const payload = goodPayload()
  payload.required_pull_request_reviews = { brand_new_field: 3 }
  writeFileSync(unknown, JSON.stringify(payload), 'utf8')
  const { code, out } = run(['apply', '--repo', 'owner/repo', '--fixture', unknown], NO_GH)
  assert.equal(code, 1, out)
  assert.match(out, /cannot mirror back/)
})

test('an unknown command is a failure', () => {
  const { code, out } = run(['verify', '--repo', 'owner/repo'], NO_GH)
  assert.equal(code, 1, out)
  assert.match(out, /unknown command: verify/)
})
