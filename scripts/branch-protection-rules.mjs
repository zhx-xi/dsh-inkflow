/**
 * Branch protection as a repository-verifiable contract (pure functions only).
 *
 * Why this file exists: the rule "CI must be green before merge" used to live
 * only in GitHub's web settings. Nothing inside the repository could tell
 * whether it was still true, so one settings edit — or a fresh clone of the
 * repository under a new owner — silently turned the gate off while every
 * document still promised it. Here the expected protection is data, the
 * evaluation is a pure function, and `../branch-protection.mjs` only fetches
 * and prints.
 *
 * The GitHub API shape is flattened on purpose. `GET
 * repos/{owner}/{repo}/branches/{branch}/protection` answers with nested
 * `{enabled: true}` objects and parallel `contexts` / `checks` arrays; the
 * evaluator takes the normalized form produced by `flattenProtection`, which is
 * also what the tests feed it, so no test needs a live GitHub token.
 *
 * Source of truth for the expected values is `EXPECTED` below — the
 * constitutional rule in `.agents/constitution/engineering-discipline.md` §9.5
 * points here rather than duplicating the list.
 */

/**
 * Every context must report success on the PR head before the merge button
 * works. Names are check contexts (job `name:` values in the workflow), so a
 * renamed job silently removes a gate — that is exactly what `check` catches.
 */
export const REQUIRED_CONTEXTS = [
  'lint',
  'test (ubuntu-latest)',
  'test (windows-latest)',
  'docs',
  'package',
]

export const EXPECTED = {
  /** The PR branch must be up to date with `main` before merging. */
  strict: true,
  /** Repository admins are bound by the same required checks. */
  enforceAdmins: true,
  allowForcePushes: false,
  allowDeletions: false,
  /** An unresolved review conversation blocks the merge. */
  requiredConversationResolution: true,
  requiredContexts: REQUIRED_CONTEXTS,
}

function asStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.filter((entry) => typeof entry === 'string')
}

/**
 * Normalize a GitHub branch-protection payload into the flat shape the
 * evaluator uses. Never throws: an unprotected branch or a partial payload
 * degrades to "everything off", which the evaluator then reports item by item.
 */
export function flattenProtection(api) {
  const statusChecks = api?.required_status_checks ?? null
  const checks = Array.isArray(statusChecks?.checks) ? statusChecks.checks : []
  const fromChecks = checks
    .map((entry) => (typeof entry?.context === 'string' ? entry.context : null))
    .filter((entry) => entry !== null)
  // `checks[]` is the modern field; `contexts[]` is the legacy one. Prefer the
  // modern one when present so the flattening matches what GitHub actually
  // enforces today, and fall back so an older payload still evaluates.
  const requiredContexts = fromChecks.length > 0 ? fromChecks : asStringArray(statusChecks?.contexts)

  return {
    strict: statusChecks?.strict === true,
    enforceAdmins: api?.enforce_admins?.enabled === true,
    allowForcePushes: api?.allow_force_pushes?.enabled === true,
    allowDeletions: api?.allow_deletions?.enabled === true,
    requiredConversationResolution: api?.required_conversation_resolution?.enabled === true,
    requiredContexts,
  }
}

const FLAGS = [
  ['strict', 'required_status_checks.strict must be true: a PR that is not rebased onto main was never verified against it'],
  ['enforceAdmins', 'enforce_admins.enabled must be true: otherwise an admin can merge with the checks red'],
  ['allowForcePushes', 'allow_force_pushes.enabled must be false: force pushes rewrite merged history'],
  ['allowDeletions', 'allow_deletions.enabled must be false: deleting main loses the whole gate'],
  [
    'requiredConversationResolution',
    'required_conversation_resolution.enabled must be true: an unresolved review thread must block the merge',
  ],
]

/**
 * Compare an actual (flattened) protection payload with the expectation.
 *
 * Returns `{ ok, problems, extraContexts }`:
 *   - `problems` are human-readable one-per-line reasons, safe to print;
 *   - `extraContexts` are required checks we did not ask for — reported, never
 *     fatal, because an extra gate only makes merging harder.
 */
export function evaluateProtection(actual, expected = EXPECTED) {
  const problems = []
  const have = new Set(asStringArray(actual?.requiredContexts))
  for (const context of expected.requiredContexts) {
    if (!have.has(context)) problems.push(`required check missing: ${context}`)
  }
  for (const [key, message] of FLAGS) {
    const want = expected[key]
    const got = actual?.[key] === true
    if (want === false && got) problems.push(message)
    if (want === true && !got) problems.push(message)
  }
  const extraContexts = [...have].filter((context) => !expected.requiredContexts.includes(context))
  return { ok: problems.length === 0, problems, extraContexts }
}

/**
 * The PUT body for `apply`. Kept next to the expectation so the write path and
 * the read path can never drift: `flattenProtection(protectionPayload())` must
 * evaluate clean, and a test asserts exactly that.
 *
 * `PUT /protection` replaces the whole object, so every field this gate does not
 * own has to be carried over explicitly. Pull-request review is the dangerous one
 * (review finding S1): sending `null` blind would delete a "require 1 approval"
 * rule somebody enabled by hand, while `check` kept saying PASS. Only the
 * documented scalar PUT fields are mirrored; an unknown shape degrades to "no
 * review requirement", which is what the repository has today.
 */
export function protectionPayload(expected = EXPECTED, currentApi = undefined) {
  const carrier = reviewRequirement(currentApi)
  return {
    required_status_checks: { strict: expected.strict, contexts: [...expected.requiredContexts] },
    enforce_admins: expected.enforceAdmins,
    required_pull_request_reviews: carrier.kind === 'known' ? carrier.value : null,
    restrictions: null,
    allow_force_pushes: expected.allowForcePushes,
    allow_deletions: expected.allowDeletions,
    required_conversation_resolution: expected.requiredConversationResolution,
  }
}

const REVIEW_FLAGS = ['dismiss_stale_reviews', 'require_code_owner_reviews', 'require_last_push_approval']
const REVIEW_COUNT = 'required_approving_review_count'
const REVIEW_PASSTHROUGH = ['dismissal_restrictions', 'bypass_pull_request_allowances']

/**
 * Classify the review requirement this gate does not own.
 *
 *   'none'    — nothing enabled: sending `null` keeps it that way;
 *   'known'   — enabled with a shape we can mirror back verbatim (scalars plus
 *               the two allowlists, so nobody's stricter setting is loosened);
 *   'unknown' — enabled but unrecognizable: the caller must REFUSE to PUT rather
 *               than guess, because guessing either widens or tightens a rule
 *               nobody asked this gate to touch (review findings N3 + S1).
 */
export function reviewRequirement(currentApi) {
  const reviews = currentApi?.required_pull_request_reviews
  if (typeof reviews !== 'object' || reviews === null) return { kind: 'none' }
  const value = {}
  for (const flag of REVIEW_FLAGS) {
    if (typeof reviews[flag] === 'boolean') value[flag] = reviews[flag]
  }
  if (typeof reviews[REVIEW_COUNT] === 'number') value[REVIEW_COUNT] = reviews[REVIEW_COUNT]
  for (const list of REVIEW_PASSTHROUGH) {
    if (reviews[list] && typeof reviews[list] === 'object') value[list] = reviews[list]
  }
  if (typeof value[REVIEW_COUNT] !== 'number' && !REVIEW_FLAGS.some((flag) => flag in value)) {
    return { kind: 'unknown', value: reviews }
  }
  return { kind: 'known', value }
}
