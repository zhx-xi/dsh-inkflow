/**
 * The book hub's new-book wizard (ADR-0010 D4/D6, issue #86): plan → apply.
 *
 * WHY THIS FILE EXISTS. `hub.ts` is a read-only projection and must stay one;
 * "plan a directory the user picked, then write it after they confirm" is a
 * second responsibility with its own security story, so it lives here.
 *
 * THE TWO HALVES OF THE SECURITY ARGUMENT (ADR-0010 D6):
 *
 *   - `plan` is the only place that accepts a PATH — and only under the name
 *     `candidate`, because a field called `root`/`path`/`cwd` is refused by the
 *     channel's guard before any handler runs. A plan writes nothing: it runs
 *     the same `inspectProject(root, { recreateIndexDir: false })` the tools run
 *     and reports the same checklist.
 *   - `apply` accepts NO path at all. It accepts a one-shot `planToken` that
 *     binds the canonical path AND a digest of the plan that was shown to the
 *     user, plus `confirm: true`. The token is consumed BEFORE the first byte is
 *     written, so a replay cannot write twice even when the first attempt was
 *     refused mid-way, and a directory that changed after the plan is
 *     `PLAN_CHANGED` with zero writes instead of being quietly initialised
 *     against a plan the user never saw.
 *
 * THE ANCHOR (ADR-0010 D6 锚点 1–3). There is no session on this channel, so the
 * anchor is the workspace registry plus an absolute refusal set:
 *
 *   1. the canonical path is already registered → answer its state, NO token
 *      ("这本书已经在书库里"); a registered book's write path is its session's
 *      tool call, not the hub.
 *   2. the picked path sits inside a registered workspace → anchor that
 *      workspace and run `checkProjectRootScope` (a junction pointing out of the
 *      workspace is `PATH_OUT_OF_SCOPE`, not a silent plan against the outside
 *      tree). Containment is judged on the TEXT the user picked, while the gate
 *      judges the RESOLVED path: that is what catches the escape.
 *   3. neither → the anchor is missing. `outsideRegistry: true` is required
 *      (the panel shows the second confirmation), and the gate then runs with
 *      the candidate as its own scope, which leaves exactly the absolute
 *      refusal set (drive/volume roots, the home directory and its ancestors,
 *      the system and install directories).
 *
 * WHAT IS DELIBERATELY NOT HERE: no `git add`/`commit`/`remote`/identity, no
 * write outside the book root, no index rebuild, no catalog rebuild, no removal
 * of a registration. `applyWorkspace` (ADR-0006 D3/D4) owns every byte this
 * file causes to be written.
 */

import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute, relative as relativePath, resolve } from 'node:path'

import type { HostContext } from './context.js'
import { listRegisteredWorkspaces } from './hub.js'
import { checkProjectRootScope, isWithin, readMeta, realpathLoose } from './project.js'
import type { WorkspaceAction } from './project.js'
import { applyWorkspace, planWorkspace } from './workspace.js'
import type { WorkspaceApplyResult, WorkspacePlan } from './workspace.js'

/** ADR-0010 D3: a plan token is valid for five minutes. */
export const HUB_PLAN_TOKEN_TTL_MS = 5 * 60 * 1000

/**
 * How many spent tokens are remembered. Replay is answered with
 * `TOKEN_CONSUMED` instead of `TOKEN_UNKNOWN` only while the record lives, and
 * the record is dropped at its own expiry — so this cap only bounds memory
 * against a script that plans in a loop.
 */
const MAX_SPENT_TOKENS = 64

/** Where a picked directory gets its trust from (ADR-0010 D6). */
export type HubPlanAnchor = 'in-workspace' | 'registered' | 'outside-registry'

/** What a token binds: the canonical path, the anchor, and a digest of the plan. */
export interface HubPlanTokenRecord {
  path: string
  anchor: HubPlanAnchor
  digest: string
  issuedAt: number
  expiresAt: number
}

export type HubPlanTokenStatus = 'ok' | 'unknown' | 'consumed' | 'expired'

export interface HubPlanTokenLookup {
  status: HubPlanTokenStatus
  /**
   * The record this answer is about. Present for `'ok'` and `'expired'`; absent
   * for `'consumed'` / `'unknown'`, where the only useful fact is the status —
   * inventing a path for a token that was already spent would be a lie.
   */
  record?: HubPlanTokenRecord
}

/**
 * The one-shot token store (ADR-0010 D3). Process-local, never persisted: a
 * token that outlived the process would be a credential on disk.
 */
export interface HubPlanTokenStore {
  /** Mint a token for a path + plan digest. Returns the opaque value. */
  issue(input: { path: string; anchor: HubPlanAnchor; digest: string }): string
  /**
   * Spend a token. A successful lookup REMOVES it, so the next call answers
   * `'consumed'` — the write path cannot be re-entered with the same value.
   */
  consume(token: string): HubPlanTokenLookup
  /** Look without spending (used by tests and by nothing else). */
  peek(token: string): HubPlanTokenLookup
  /** Live tokens; spent ones are not counted. */
  size(): number
  clear(): void
}

export interface HubPlanTokenStoreOptions {
  /** Defaults to `HUB_PLAN_TOKEN_TTL_MS`; tests inject a small value. */
  ttlMs?: number
  /** Injectable clock so expiry is deterministic instead of a real sleep. */
  now?: () => number
  /** Injectable token minting (tests only). */
  mint?: () => string
}

export function createHubPlanTokenStore(options: HubPlanTokenStoreOptions = {}): HubPlanTokenStore {
  const ttlMs = Math.max(1, options.ttlMs ?? HUB_PLAN_TOKEN_TTL_MS)
  const now = options.now ?? (() => Date.now())
  const mint = options.mint ?? (() => randomUUID().replaceAll('-', ''))
  const live = new Map<string, HubPlanTokenRecord>()
  /** token → the moment it stops being worth a `TOKEN_CONSUMED` answer. */
  const spent = new Map<string, number>()

  /**
   * Forget records long enough dead that even `TOKEN_EXPIRED` is no longer a
   * useful answer. One extra TTL of grace keeps "why did my token stop working"
   * explainable instead of silently degrading to `TOKEN_UNKNOWN`.
   */
  const prune = (at: number): void => {
    for (const [token, record] of live) {
      if (record.expiresAt + ttlMs <= at) live.delete(token)
    }
    for (const [token, expiresAt] of spent) {
      if (expiresAt + ttlMs <= at) spent.delete(token)
    }
    // A script that plans in a loop must not grow the spent set without bound.
    while (spent.size > MAX_SPENT_TOKENS) {
      const oldest = spent.keys().next()
      if (oldest.done === true) break
      spent.delete(oldest.value)
    }
  }

  /** A token that is gone: spent (one-shot) or never issued. */
  const deadLookup = (token: string): HubPlanTokenLookup =>
    spent.has(token) ? { status: 'consumed' } : { status: 'unknown' }

  return {
    issue({ path, anchor, digest }) {
      const issuedAt = now()
      const token = mint()
      live.set(token, { path: resolve(path), anchor, digest, issuedAt, expiresAt: issuedAt + ttlMs })
      prune(issuedAt)
      return token
    },
    consume(token) {
      const at = now()
      prune(at)
      const record = live.get(token)
      if (record === undefined) return deadLookup(token)
      // Remove first, report second: even a throw below leaves the token dead,
      // so the write path cannot be re-entered with the same value.
      live.delete(token)
      if (record.expiresAt <= at) return { status: 'expired', record }
      spent.set(token, record.expiresAt)
      return { status: 'ok', record }
    },
    peek(token) {
      const at = now()
      prune(at)
      const record = live.get(token)
      if (record === undefined) return deadLookup(token)
      if (record.expiresAt <= at) return { status: 'expired', record }
      return { status: 'ok', record }
    },
    size() {
      const at = now()
      prune(at)
      let count = 0
      for (const record of live.values()) {
        if (record.expiresAt > at) count += 1
      }
      return count
    },
    clear() {
      live.clear()
      spent.clear()
    },
  }
}

/**
 * The store the routes share. One per process: a token minted by `plan` is only
 * useful to `apply`, and both are the same plugin instance.
 */
const processTokens = createHubPlanTokenStore()

/** Exposed so a test can clear the shared store between unrelated cases. */
export const hubPlanTokens = processTokens

/** `{status, body}` — the reply shape `routes.ts` sends verbatim. */
export interface HubWizardReply {
  status: number
  body: Record<string, unknown>
}

export interface HubWizardOptions {
  /** Defaults to the process-wide store; tests inject their own clock/TTL. */
  store?: HubPlanTokenStore
}

function ok(value: Record<string, unknown>): Record<string, unknown> {
  return { ok: true, value }
}

function failure(code: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: false, error: { code, ...extra } }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Path identity: Windows compares case-insensitively (same rule as `hub.ts`). */
function pathKey(path: string): string {
  const normalised = resolve(path).replaceAll('\\', '/').replace(/\/+$/u, '')
  return process.platform === 'win32' ? normalised.toLowerCase() : normalised
}

/**
 * The action kinds the panel shows as "will create".
 *
 * Unique, in execution order, and `manual` is dropped: it means "upgrade the
 * plugin", which is not something this wizard will do.
 */
function actionKinds(actions: readonly WorkspaceAction[]): string[] {
  const kinds: string[] = []
  for (const action of actions) {
    if (action.type === 'manual') continue
    if (!kinds.includes(action.type)) kinds.push(action.type)
  }
  return kinds
}

/** Project-relative, `/`-spelled path: the digest must not care about the machine. */
function relativeTo(root: string, path: string): string {
  return relativePath(root, path).split('\\').join('/')
}

/**
 * What the user was shown, hashed.
 *
 * The digest deliberately covers the ACTION SET and the meta baseline rather
 * than the directory's mtime: re-planning the same directory must produce the
 * same digest (otherwise every apply would be `PLAN_CHANGED`), and a directory
 * that gained a file between plan and apply must produce a different one.
 */
function planDigest(plan: WorkspacePlan, anchor: HubPlanAnchor): string {
  const payload = {
    path: plan.root,
    anchor,
    state: plan.state,
    targetKind: plan.targetKind,
    actions: plan.actions.map((action) => `${action.type}|${relativeTo(plan.root, action.path)}`),
    missing: plan.missing,
    meta: plan.metaFingerprint === null ? 'absent' : plan.metaFingerprint.sha256,
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

/** The plan fields both answers share, so the confirm card is one shape. */
function planValue(plan: WorkspacePlan): Record<string, unknown> {
  return {
    path: plan.root,
    state: plan.state,
    usable: plan.state === 'usable',
    checks: plan.checks,
    missing: plan.missing,
    actions: plan.actions,
    willCreate: actionKinds(plan.actions),
    notices: plan.notices,
    ...(plan.metaRaw === undefined ? {} : { metaRaw: plan.metaRaw }),
  }
}

/**
 * `POST /hub/plan` — judge a directory the user picked, and mint a token.
 *
 * Zero writes on every path, including the refusals: `planWorkspace` calls the
 * gate with `recreateIndexDir: false`, and nothing here touches the filesystem.
 */
export async function hubPlan(
  ctx: HostContext,
  body: Record<string, unknown>,
  options: HubWizardOptions = {},
): Promise<HubWizardReply> {
  const store = options.store ?? processTokens
  const candidate = text(body['candidate'])
  if (candidate === '') {
    return {
      status: 400,
      body: failure('CANDIDATE_REQUIRED', { hint: 'pass the directory the user picked as `candidate`' }),
    }
  }
  // A relative `candidate` would be resolved against the Host's own cwd — a
  // directory the user never named. The picker always answers absolutely.
  if (!isAbsolute(candidate)) {
    return {
      status: 400,
      body: failure('CANDIDATE_NOT_ABSOLUTE', {
        path: candidate,
        hint: 'the wizard only accepts an absolute directory path',
      }),
    }
  }

  const picked = resolve(candidate)
  const canonical = realpathLoose(picked)
  const registry = listRegisteredWorkspaces(ctx)
  /**
   * Registry paths must be compared in the SAME form as the picker's answer.
   * `realpathSync.native` resolves junctions and 8.3 short names, so a registry
   * that stored `D:\…` while the temp directory is a junction to `C:\…` (which
   * is what a Windows CI runner does) makes every containment test fail and
   * turns a directory inside a known workspace into `ANCHOR_REQUIRED` — the two
   * Windows-only failures PR #97 hit. Canonicalise both sides, never just one.
   */
  const canonicalEntry = (path: string): string => realpathLoose(resolve(path))
  const title = text(body['title'])

  // Anchor 1 (ADR-0010 D6): already a book the user has. No token: the write
  // path for a registered directory is its session's `inkflow_project_init`.
  const registered = registry?.find((entry) => pathKey(canonicalEntry(entry.path)) === pathKey(canonical))
  if (registered !== undefined) {
    const plan = planWorkspace(canonical)
    return {
      status: 200,
      body: ok({
        ...planValue(plan),
        anchor: 'registered',
        alreadyRegistered: true,
        canApply: false,
        willCreate: [],
        message: '这本书已经在书库里',
        hint:
          plan.state === 'usable'
            ? '在工作台里打开它就能写：书库只列书，不改书'
            : '初始化或修复请在该书的会话里用 inkflow_project_init（书库不发写凭证）',
      }),
    }
  }

  // Anchor 2: inside a registered workspace.
  //
  // TEXTUAL containment decides first, on purpose (ADR-0010 D6): a junction that
  // lives inside the workspace but resolves outside must still be anchored here,
  // so the gate below can refuse it with the precise `PATH_OUT_OF_SCOPE` instead
  // of a vague `ANCHOR_REQUIRED`. The canonical comparison is the second chance
  // and exists only for the spelling mismatch: a registry that stored one form
  // (junction / 8.3 short name) while the picker answered another.
  const containing = registry?.find(
    (entry) => isWithin(resolve(entry.path), picked) || isWithin(canonicalEntry(entry.path), canonical),
  )
  let anchor: HubPlanAnchor
  let scope: string
  if (containing !== undefined) {
    anchor = 'in-workspace'
    scope = containing.path
  } else if (body['outsideRegistry'] === true) {
    // Anchor 3: the user confirmed "this is a brand-new directory". The gate is
    // still run — with the candidate as its own scope — so exactly the absolute
    // refusal set applies (ADR-0010 D6).
    anchor = 'outside-registry'
    scope = canonical
  } else {
    return {
      status: 400,
      body: failure('ANCHOR_REQUIRED', {
        path: canonical,
        hint: 'this directory is outside every registered workspace: confirm it, then send outsideRegistry: true',
      }),
    }
  }

  const rejection = checkProjectRootScope(canonical, scope)
  if (rejection !== undefined) {
    return {
      status: 403,
      body: failure(rejection.code, {
        path: rejection.root,
        workspace: rejection.workspace,
        message: rejection.message,
        hint: rejection.hint,
      }),
    }
  }

  const plan = planWorkspace(canonical)
  // A fresh directory is the wizard's core case; an `absent` target lets a
  // typed-in path work too (apply creates it). Anything that already exists and
  // is not a directory is refused by `applyWorkspace` and must not get a token.
  const canApply =
    (plan.targetKind === 'directory' || plan.targetKind === 'absent') && plan.actions.some((action) => action.type !== 'manual')
  const value: Record<string, unknown> = {
    ...planValue(plan),
    anchor,
    canApply,
    ...(title === '' ? {} : { title }),
  }

  if (!canApply) {
    // `needs-newer-plugin` (or a path that exists and is not a directory): the
    // honest answer is "nothing this plugin can do", not a token nobody can use.
    return {
      status: 200,
      body: ok({
        ...value,
        ...(plan.blockedReason === '' ? {} : { blockedReason: plan.blockedReason }),
        hint:
          plan.state === 'needs-newer-plugin'
            ? '这本书由更新版本的插件写入：先升级插件，本版本不写入'
            : plan.targetKind === 'other'
              ? '这个路径存在但不是目录，换一个目录'
              : '这里没有可以补的项',
      }),
    }
  }

  const planToken = store.issue({ path: canonical, anchor, digest: planDigest(plan, anchor) })
  return { status: 200, body: ok({ ...value, planToken }) }
}

/** Status for each `applyWorkspace` failure code: environment faults are 5xx. */
const APPLY_STATUS: Record<string, number> = {
  INIT_REQUIRES_CONFIRMATION: 400,
  META_TITLE_REQUIRED: 400,
  TARGET_NOT_DIRECTORY: 400,
  PROJECT_NEEDS_NEWER_PLUGIN: 409,
  FILE_CHANGED: 409,
  GIT_INIT_FAILED: 500,
  APPLY_FAILED: 500,
}

/**
 * Register the book the Host just built (ADR-0010 D4 step 5).
 *
 * The Host does it, not the Client: two registration writers would be two
 * answers to "which title does the registry hold". A missing or throwing
 * registry is reported as `registered: false` — never as success.
 */
async function registerWorkspace(
  ctx: HostContext,
  path: string,
  title: string,
): Promise<{ registered: boolean; workspace: Record<string, unknown> | null; hint?: string }> {
  const hint = '书已建好，但工作区没有自动注册：在左侧手动打开该目录即可（也可以稍后重试）'
  const raw = ctx.get('workspaceRegistry')
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined
  if (record === undefined || typeof record['create'] !== 'function') return { registered: false, workspace: null, hint }

  try {
    const created = (record['create'] as (path: string, title?: string) => unknown).call(raw, path, title)
    const awaited = created !== null && typeof created === 'object' && 'then' in created ? await created : created
    const workspace = typeof awaited === 'object' && awaited !== null ? (awaited as Record<string, unknown>) : {}
    const confirmedPath = text(workspace['path']) === '' ? path : text(workspace['path'])
    return {
      registered: true,
      workspace: { path: confirmedPath, title: text(workspace['title']) === '' ? title : text(workspace['title']) },
    }
  } catch (cause) {
    return {
      registered: false,
      workspace: null,
      hint: `${hint}（注册服务报错：${cause instanceof Error ? cause.message : String(cause)}）`,
    }
  }
}

/** The `nextStep` card of ADR-0010 D4 degradation A: say what to do, do not pretend. */
function nextStepOf(title: string, path: string): Record<string, unknown> {
  const shown = title === '' ? basename(path) : title
  return {
    kind: 'open-new-session',
    title: shown,
    path,
    message: `书已就绪。在左侧工作区「${shown}」点「新会话」开始创作`,
  }
}

/**
 * `POST /hub/apply` — spend a token, build the book, register it.
 *
 * The order is the contract:
 *
 *   1. `confirm` is checked BEFORE the token is touched, so a refused
 *      confirmation leaves a usable token behind (the user can still say yes);
 *   2. the token is looked up and CONSUMED before re-planning, so a rejected
 *      apply can never be retried with the same value;
 *   3. the plan is re-derived and compared with the digest the token bound;
 *   4. only then does `applyWorkspace` write anything.
 */
export async function hubApply(
  ctx: HostContext,
  body: Record<string, unknown>,
  options: HubWizardOptions = {},
): Promise<HubWizardReply> {
  const store = options.store ?? processTokens

  if (body['confirm'] !== true) {
    return {
      status: 400,
      body: failure('INIT_REQUIRES_CONFIRMATION', {
        hint: 'nothing was written: show the plan to the user, then send confirm: true',
      }),
    }
  }

  const planToken = text(body['planToken'])
  if (planToken === '') {
    return { status: 400, body: failure('PLAN_TOKEN_REQUIRED', { hint: 'apply only accepts the token a plan returned' }) }
  }

  const lookup = store.consume(planToken)
  if (lookup.status === 'unknown') {
    return {
      status: 400,
      body: failure('TOKEN_UNKNOWN', { hint: 'this token was never issued here (or the process restarted): plan again' }),
    }
  }
  if (lookup.status === 'consumed') {
    return {
      status: 409,
      body: failure('TOKEN_CONSUMED', { hint: 'a plan token is one-shot: nothing was written, plan again' }),
    }
  }
  const record = lookup.record
  if (lookup.status === 'expired' || record === undefined) {
    return {
      status: 400,
      body: failure('TOKEN_EXPIRED', { hint: 'a plan token lasts five minutes: nothing was written, plan again' }),
    }
  }

  // Defence in depth: the path came from a plan that passed the gate, but the
  // refusal set is absolute and costs one stat.
  const rejection = checkProjectRootScope(record.path, record.path)
  if (rejection !== undefined) {
    return {
      status: 403,
      body: failure(rejection.code, { path: rejection.root, message: rejection.message, hint: rejection.hint }),
    }
  }

  const plan = planWorkspace(record.path)
  if (planDigest(plan, record.anchor) !== record.digest) {
    return {
      status: 409,
      body: failure('PLAN_CHANGED', {
        path: record.path,
        hint: 'the directory changed since the plan was shown: nothing was written, plan again',
        willCreate: actionKinds(plan.actions),
      }),
    }
  }

  const askedTitle = text(body['title'])
  // The author's title is never invented: fall back to the title already on
  // disk (a repair of an existing book), and let `applyWorkspace` answer
  // `META_TITLE_REQUIRED` when a new `inkflow.json` needs one.
  const title = askedTitle === '' ? (readMeta(record.path).meta?.title ?? '') : askedTitle
  const expected = plan.metaFingerprint === null ? { absent: true as const } : plan.metaFingerprint
  const applied: WorkspaceApplyResult = applyWorkspace(record.path, { confirm: true, title, expected })

  if (!applied.ok) {
    const code = applied.error?.code ?? 'APPLY_FAILED'
    return {
      status: APPLY_STATUS[code] ?? 500,
      body: failure(code, {
        path: applied.root,
        message: applied.error?.message ?? 'the apply failed',
        rolledBack: applied.error?.rolledBack ?? false,
        ...(applied.error?.changed === undefined ? {} : { changed: applied.error.changed }),
        created: applied.created,
      }),
    }
  }

  const finalTitle = title === '' ? basename(applied.root) : title
  const registration = await registerWorkspace(ctx, applied.root, finalTitle)
  return {
    status: 200,
    body: ok({
      path: applied.root,
      anchor: record.anchor,
      state: applied.state,
      created: applied.created,
      updated: applied.updated,
      skipped: applied.skipped,
      gitInit: applied.gitInit,
      notices: applied.notices,
      warnings: applied.warnings,
      ...(applied.metaVerified === undefined ? {} : { metaVerified: applied.metaVerified }),
      registered: registration.registered,
      workspace: registration.workspace,
      ...(registration.hint === undefined ? {} : { hint: registration.hint }),
      nextStep: nextStepOf(finalTitle, applied.root),
    }),
  }
}
