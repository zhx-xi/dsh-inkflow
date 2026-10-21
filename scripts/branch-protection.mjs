/**
 * Branch-protection CLI: the only place that talks to GitHub.
 *
 *   node scripts/branch-protection.mjs check [--tolerant] [--json] [--repo O/R] [--branch main]
 *   node scripts/branch-protection.mjs apply [--dry-run] [--repo O/R] [--branch main]
 *
 * `check` is read-only and wired into `pnpm run check` in `--tolerant` mode: a
 * machine without the gh CLI, without a login or without network prints
 * `SKIP …（未验证）` and exits 0, because the local gate must stay runnable
 * offline. SKIP is NOT a pass — claiming "the gate is verified" requires one run
 * without `--tolerant` (see .agents/constitution/engineering-discipline.md §9.5).
 *
 * `apply` is the only writer and needs admin on the repository. It is idempotent:
 * it PUTs the full expected payload and then re-reads to prove the result.
 */
import { spawnSync } from 'node:child_process'
import { evaluateProtection, flattenProtection, protectionPayload } from './branch-protection-rules.mjs'

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
  const result = spawnSync('gh', args, { encoding: 'utf8', input })
  const stderr = (result.stderr ?? '').trim()
  const stdout = (result.stdout ?? '').trim()
  if (result.error) return { ok: false, reason: `gh CLI unavailable (${result.error.message})`, stdout, stderr }
  if (result.status !== 0) return { ok: false, reason: stderr || `gh exited with ${result.status}`, stdout, stderr }
  return { ok: true, stdout, stderr }
}

function readProtection(repo) {
  const result = gh(['api', `repos/${repo}/branches/${branch}/protection`])
  if (!result.ok) return { ok: false, reason: result.reason }
  try {
    return { ok: true, api: JSON.parse(result.stdout) }
  } catch (error) {
    return { ok: false, reason: `could not parse gh output (${error.message})` }
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

function skip(reason) {
  console.log(`SKIP branch-protection: ${reason}（未验证）`)
  console.log('      run `node scripts/branch-protection.mjs check` with a logged-in gh to turn this into a PASS/FAIL')
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
  const current = readProtection(repo)
  if (!current.ok) {
    if (tolerant) return skip(current.reason)
    console.error(`✗ could not read branch protection for ${repo} ${branch}: ${current.reason}`)
    return false
  }
  return report(flattenProtection(current.api), repo)
}

function applyCommand() {
  const repo = resolveRepo()
  const payload = protectionPayload()
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
  const current = readProtection(repo)
  if (!current.ok) {
    console.error(`✗ applied, but the read-back failed: ${current.reason}`)
    return false
  }
  return report(flattenProtection(current.api), repo)
}

let passed
if (command === 'check') passed = checkCommand()
else if (command === 'apply') passed = applyCommand()
else {
  console.error(`unknown command: ${command} (expected check|apply)`)
  passed = false
}
process.exit(passed ? 0 : 1)
