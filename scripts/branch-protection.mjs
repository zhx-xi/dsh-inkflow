/**
 * Branch-protection CLI: the only place that talks to GitHub.
 *
 *   node scripts/branch-protection.mjs check [--tolerant] [--json] [--repo O/R] [--branch main] [--fixture FILE]
 *   node scripts/branch-protection.mjs apply [--dry-run] [--repo O/R] [--branch main] [--fixture FILE]
 *
 * `check` is read-only and wired into `pnpm run check` in `--tolerant` mode: a
 * machine without the gh CLI, without a login or without network prints
 * `SKIP …（未验证）` and exits **0**, because the local gate must stay runnable
 * offline. Tolerance only covers "no verdict could be obtained" — a protection
 * payload that was read successfully and does not match still exits 1.
 *
 * `apply` is the only writer and needs admin on the repository. It is idempotent:
 * it PUTs the expected payload, re-reads to prove the result, and carries over
 * any pull-request review requirement that is already enabled so running it
 * never silently removes a stricter setting somebody turned on by hand.
 *
 * Test seams (used by tests/branch-protection-cli.test.js):
 *   --fixture FILE   read the protection payload from a file instead of gh
 *   INKFLOW_GH=name  the gh executable to spawn (default `gh`)
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { classifyReadFailure, evaluateProtection, flattenProtection, protectionPayload, reviewRequirement } from './branch-protection-rules.mjs'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'check'
const has = (flag) => argv.includes(flag)
const valueOf = (flag, fallback) => {
  const index = argv.indexOf(flag)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const branch = valueOf('--branch', 'main')
const tolerant = has('--tolerant')
const asJson = has('--json')
const dryRun = has('--dry-run')
const fixture = valueOf('--fixture', null)
/** `--fixture` keeps the exit-code contract testable without a network or a token. */
const ghBinary = process.env['INKFLOW_GH'] ?? 'gh'

/** Resolve `owner/name` from --repo, else from the origin remote of the current tree. */
function resolveRepo() {
  const explicit = valueOf('--repo', null)
  if (explicit) return explicit
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' })
  const url = (remote.stdout ?? '').trim()
  const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url)
  if (match) return `${match[1]}/${match[2]}`
  throw new Error('cannot resolve the repository: pass --repo owner/name')
}

function gh(args, input) {
  const result = spawnSync(ghBinary, args, { encoding: 'utf8', input })
  const stderr = (result.stderr ?? '').trim()
  const stdout = (result.stdout ?? '').trim()
  if (result.error) return { ok: false, reason: `${ghBinary} unavailable (${result.error.message})`, stdout, stderr }
  if (result.status !== 0) return { ok: false, reason: stderr || `${ghBinary} exited with ${result.status}`, stdout, stderr }
  return { ok: true, stdout, stderr }
}

/**
 * The GitHub payload, from `--fixture` when given, else from the API.
 *
 * `unprotected: true` means "the branch has no protection at all" — the state the
 * emergency exit starts in (`DELETE` → `apply` → `check`). `--fixture` can say so
 * with `{"unprotected": true}`, which keeps both branches testable offline.
 */
function readProtectionApi(repo) {
  if (fixture !== null) {
    try {
      const api = JSON.parse(readFileSync(fixture, 'utf8'))
      if (api !== null && typeof api === 'object' && api['unprotected'] === true) {
        return { ok: false, reason: 'gh: Branch not protected (HTTP 404)', unprotected: true }
      }
      return { ok: true, api }
    } catch (error) {
      return { ok: false, reason: `could not read fixture ${fixture} (${error.message})` }
    }
  }
  const result = gh(['api', `repos/${repo}/branches/${branch}/protection`])
  if (!result.ok) {
    return { ok: false, reason: result.reason, unprotected: classifyReadFailure(result.reason) === 'unprotected' }
  }
  try {
    return { ok: true, api: JSON.parse(result.stdout) }
  } catch (error) {
    return { ok: false, reason: `could not parse gh output (${error.message})`, unprotected: false }
  }
}

function report(actual, repo) {
  const { ok, problems, extraContexts } = evaluateProtection(actual)
  if (asJson) {
    console.log(JSON.stringify({ repo, branch, ok, problems, extraContexts, actual }, null, 2))
  } else if (ok) {
    const flags = [
      actual.strict ? 'strict' : 'not-strict',
      actual.enforceAdmins ? 'enforce-admins' : 'admins-exempt',
      actual.allowForcePushes ? 'force-push-allowed' : 'no-force-push',
      actual.requiredConversationResolution ? 'conversations-must-resolve' : 'conversations-may-stay-open',
    ]
    console.log(`branch-protection ok: ${repo} ${branch} — ${actual.requiredContexts.length} required check(s), ${flags.join(', ')}`)
    if (extraContexts.length > 0) console.log(`note: extra required check(s): ${extraContexts.join(', ')}`)
  } else {
    console.error(`✗ branch protection on ${repo} ${branch} does not match the expected gate:`)
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error(`\nfix: node scripts/branch-protection.mjs apply --repo ${repo} --branch ${branch}`)
  }
  return ok
}

/**
 * "No verdict" — and it must not fail the local gate. Returning `true` here is
 * the whole point of `--tolerant`: a laptop without gh still runs `pnpm run
 * check` to completion, and the printed wording says 未验证 so nobody reads the
 * SKIP line as a pass.
 */
function skip(reason) {
  if (asJson) {
    console.log(JSON.stringify({ skipped: true, verified: false, reason }, null, 2))
  } else {
    console.log(`SKIP branch-protection: ${reason}（未验证）`)
    console.log('      run `node scripts/branch-protection.mjs check` with a logged-in gh to turn this into a PASS/FAIL')
  }
  return true
}

function checkCommand() {
  let repo
  try {
    repo = resolveRepo()
  } catch (error) {
    if (tolerant) return skip(error.message)
    console.error(`✗ ${error.message}`)
    return false
  }
  const current = readProtectionApi(repo)
  if (!current.ok) {
    if (current.unprotected) {
      // A valid answer, and the one the exit starts from: there is no protection
      // to compare against. Tolerant mode must not swallow it — "no gate at all"
      // is a configuration error, not a missing verdict.
      if (asJson) {
        console.log(JSON.stringify({ repo, branch, ok: false, unprotected: true, problems: ['branch is not protected'] }, null, 2))
      } else {
        console.error(`✗ branch protection on ${repo} ${branch} is absent: the branch is not protected`)
        console.error(`\nfix: node scripts/branch-protection.mjs apply --repo ${repo} --branch ${branch}`)
      }
      return false
    }
    if (tolerant) return skip(current.reason)
    console.error(`✗ could not read branch protection for ${repo} ${branch}: ${current.reason}`)
    return false
  }
  return report(flattenProtection(current.api), repo)
}

function applyCommand() {
  let repo
  try {
    repo = resolveRepo()
  } catch (error) {
    console.error(`✗ ${error.message}`)
    return false
  }
  // Carry over a review requirement that is already on: `apply` owns the CI
  // gate, and an unrelated stricter setting must not disappear as a side effect
  // (review finding S1). Reading the current object is therefore a precondition,
  // not an optimisation: `PUT` replaces everything, so a failed pre-read means a
  // successful PUT would delete settings we never saw (review finding N1).
  //
  // The one exception is "not protected at all" (404 `Branch not protected`):
  // that IS the emergency exit's starting state, and there is nothing to carry
  // over. Refusing it made the documented exit unreachable — the only way back
  // was a manual `gh api -X PUT`.
  const current = readProtectionApi(repo)
  if (!current.ok && !current.unprotected) {
    console.error(`✗ refusing to apply: could not read the current protection (${current.reason})`)
    console.error('  PUT replaces the whole object, so applying blind could drop a review requirement this gate does not own')
    return false
  }
  if (current.unprotected) {
    console.log(`note: ${repo} ${branch} has no protection; installing the gate from scratch (nothing to carry over)`)
  }
  const carrier = current.ok ? reviewRequirement(current.api) : { kind: 'none' }
  if (carrier.kind === 'unknown') {
    console.error('✗ refusing to apply: a review requirement is enabled in a shape this gate cannot mirror back')
    console.error(`  read: ${JSON.stringify(carrier.value)}`)
    console.error('  widen scripts/branch-protection-rules.mjs REVIEW_* tables to mirror it, then retry')
    return false
  }
  const payload = protectionPayload(undefined, current.ok ? current.api : undefined)
  if (dryRun) {
    console.log(`would PUT repos/${repo}/branches/${branch}/protection`)
    console.log(JSON.stringify(payload, null, 2))
    return true
  }
  const put = gh(['api', '-X', 'PUT', `repos/${repo}/branches/${branch}/protection`, '--input', '-'], JSON.stringify(payload))
  if (!put.ok) {
    console.error(`✗ could not apply branch protection to ${repo} ${branch}: ${put.reason}`)
    return false
  }
  // Re-read instead of trusting the PUT response: the read path is what `check`
  // and the evaluator see, so only that proves the gate is now in force.
  const after = readProtectionApi(repo)
  if (!after.ok) {
    console.error(`✗ applied, but the read-back failed: ${after.reason}`)
    return false
  }
  return report(flattenProtection(after.api), repo)
}

let passed
/**
 * A seam that can fabricate a verdict must announce itself: a `PASS` printed
 * under `--fixture` is evidence about a file, not about GitHub (review finding
 * N2). Printed for every run, plain text, never suppressed.
 */
if (fixture !== null || process.env['INKFLOW_GH'] !== undefined) {
  console.log('note: test seam active (--fixture / INKFLOW_GH); this run is NOT evidence about the real repository')
}
if (command === 'check') passed = checkCommand()
else if (command === 'apply') passed = applyCommand()
else {
  console.error(`unknown command: ${command} (expected check|apply)`)
  passed = false
}
process.exit(passed ? 0 : 1)
