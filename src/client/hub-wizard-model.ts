/**
 * Pure view model for the book hub's new-book wizard (ADR-0010 D4/D6, issue #86).
 *
 * Same split as `hub-model.ts`: `node --test` has no DOM, so every wording
 * decision and every fallback is a plain function over plain data (asserted in
 * `tests/panel-bundle.test.js`), while `hub-wizard.tsx` only arranges it.
 *
 * THREE RULES SHAPE THIS FILE:
 *
 *   1. The wizard never invents a fact. It folds the Host's answer into one of
 *      four outcomes — ready / anchor-required / blocked / refused — and shows
 *      the words the Host sent (`message`, `hint`, `notices`) instead of a
 *      cheerful guess.
 *   2. The last step is ADR-0010 D4 **degradation A**: the panel says "书已就绪…
 *      在左侧工作区「<title>」点「新会话」" and shows the canonical path. It does
 *      not pretend to navigate, because a session cannot be created
 *      programmatically (ADR-0010 E3/E4).
 *   3. Nothing here builds a path for the Host: `candidate` is the ONLY field
 *      that carries one, `apply` carries none at all (ADR-0010 D3/D6).
 */

import type { InternalResult } from './internal.js'
import type { HubBookRow } from './hub-model.js'

/** The one button that opens the wizard (the shared-content page is #87's). */
export const HUB_WIZARD_LABEL = '新开书'

/** What the button does for a book the user already has on disk. */
export const HUB_IMPORT_NOTE = '导入已有书：选中它所在的目录，走同一套检查（只补缺失，不覆盖已有文件）'

export const HUB_WIZARD_TEXTS = {
  pathLabel: '目录',
  titleLabel: '书名',
  titleHint: '写进 inkflow.json；导入已有的书时保持原样',
  willCreateLabel: '将创建',
  missingLabel: '当前缺少',
  noticesLabel: '需要你处理',
  confirm: '确认创建',
  cancel: '取消',
  close: '关闭',
  retry: '重试',
  gatherPicker: '选择目录…',
  manualPathLabel: '这个环境没有目录选择器：把目录的绝对路径粘贴进来',
  manualPathGo: '用这个目录',
  planning: '正在检查目录…',
  applying: '正在创建…',
  pickCancelled: '已取消选择目录',
  doneTitle: '书已就绪',
  another: '再开一本',
  registeredTitle: '这本书已经在书库里',
  newerPluginTitle: '这本书由更新版本的插件写入',
  anchorTitle: '这是一个全新的目录',
  anchorBody: '它不在任何已打开的工作区里。确认要在这里初始化成一本小说吗？书库只会补缺失的目录与文件，不会覆盖任何已有内容。',
  anchorContinue: '确认，继续检查',
  blockedTitle: '这里没有可以直接补的项',
} as const

/** The five wizard actions, said the way a user reads them (ADR-0006 D3). */
export const HUB_WILL_CREATE_LABELS: Record<string, string> = {
  'git-init': 'git init（一部书 = 一个仓库；不提交、不配远端、不改你的 git 身份）',
  'create-dir': '补齐缺失的目录',
  'create-gitkeep': '给每个目录放一个 .gitkeep（否则 clone 后目录会消失）',
  'create-meta': '写 inkflow.json',
  'create-gitignore': '补 .gitignore 里的派生索引规则（index/*.db*）',
}

/** `POST /hub/plan` → `value`, only the fields the panel reads. */
export interface HubPlanValue {
  path?: string
  anchor?: string
  state?: string
  usable?: boolean
  missing?: string[]
  willCreate?: string[]
  notices?: string[]
  canApply?: boolean
  planToken?: string
  alreadyRegistered?: boolean
  blockedReason?: string
  message?: string
  hint?: string
  title?: string
}

/** `POST /hub/apply` → `value`, only the fields the panel reads. */
export interface HubApplyValue {
  path?: string
  anchor?: string
  state?: string
  created?: string[]
  updated?: string[]
  skipped?: string[]
  registered?: boolean
  workspace?: { path?: string; title?: string } | null
  hint?: string
  nextStep?: { kind?: string; title?: string; path?: string; message?: string }
}

/**
 * The four answers a plan can produce.
 *
 * `anchor-required` is its own outcome on purpose: it is not a failure, it is
 * the second confirmation ADR-0010 D6 requires before a directory outside every
 * registered workspace may be planned at all.
 */
export type HubPlanOutcome =
  | { status: 'ready'; path: string; token: string; plan: HubPlanValue }
  | { status: 'anchor-required'; path: string; message: string }
  | { status: 'blocked'; path: string; message: string; hint: string }
  | { status: 'refused'; code: string; message: string }

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** A route failure rendered as one sentence, never a bare code. */
const WIZARD_ERROR_HINTS: Record<string, string> = {
  PATH_FORBIDDEN: '这个路径不能当书目录（盘符根、家目录、系统或安装目录）',
  PATH_OUT_OF_SCOPE: '这个目录经软链接/junction 指到了工作区之外',
  CANDIDATE_REQUIRED: '没有拿到目录：重新选一次',
  CANDIDATE_NOT_ABSOLUTE: '需要目录的绝对路径',
  UNEXPECTED_BODY_FIELD: '请求带了没声明的字段（面板内部错误）',
  PLAN_TOKEN_REQUIRED: '缺少计划凭证（面板内部错误）',
  TOKEN_UNKNOWN: '这份计划已经失效：重新检查一次目录',
  TOKEN_CONSUMED: '这份计划已经用过了：重新检查一次目录',
  TOKEN_EXPIRED: '这份计划超过五分钟了：重新检查一次目录',
  PLAN_CHANGED: '目录在检查之后被改动过：重新检查一次，再确认',
  INIT_REQUIRES_CONFIRMATION: '没有确认：勾选后再提交',
  META_TITLE_REQUIRED: '写 inkflow.json 需要书名：填一个书名',
  'forbidden-origin': '这个请求不是从 DSH 自己的页面发出的（面板内部错误）',
  'unsupported-media-type': '面板发出了非 JSON 请求（面板内部错误）',
  'payload-too-large': '请求体太大（面板内部错误）',
  'fetch-failed': '书库通道请求失败，检查 DSH 与插件的连接',
  'not-found': '这个版本的 Host 还没有新开书路由，先更新插件并重启 DSH',
}

/** Message for a failed wizard call: the hint table first, then the Host's words. */
export function describeWizardError(code: string, message: string | undefined, hint: string | undefined): string {
  const known = WIZARD_ERROR_HINTS[code]
  if (known !== undefined && known !== '') return known
  if (typeof message === 'string' && message !== '') return message
  if (typeof hint === 'string' && hint !== '') return hint
  return code
}

/**
 * Fold `POST /hub/plan` into one renderable outcome.
 *
 * The anchor-required case is recognised by its code, not by a missing field:
 * "no token" is also what a blocked book answers, and the two need different UI.
 */
export function readHubPlan(result: InternalResult<HubPlanValue>): HubPlanOutcome {
  const value = result.value
  if (!result.ok || value === undefined) {
    const code = result.error?.code ?? 'fetch-failed'
    return {
      status: 'refused',
      code,
      message: describeWizardError(code, result.error?.message, result.error?.hint),
    }
  }
  const path = str(value.path)
  const token = str(value.planToken)
  if (value.canApply === true && token !== '') return { status: 'ready', path, token, plan: value }
  // The Host's own words first (`message`, then `blockedReason`); the canned
  // sentence is only for an answer that says nothing at all.
  const hostMessage = str(value.message) !== '' ? str(value.message) : str(value.blockedReason)
  const message =
    hostMessage !== ''
      ? hostMessage
      : value.alreadyRegistered === true
        ? HUB_WIZARD_TEXTS.registeredTitle
        : HUB_WIZARD_TEXTS.blockedTitle
  return {
    status: 'blocked',
    path,
    message,
    hint: str(value.hint),
  }
}

/** `ANCHOR_REQUIRED` is the second confirmation, not an error. */
export function isAnchorRequired(result: InternalResult<HubPlanValue>): boolean {
  return result.ok === false && result.error?.code === 'ANCHOR_REQUIRED'
}

/** The wording of the second confirmation, including the path it applies to. */
export function anchorConfirmation(result: InternalResult<HubPlanValue>): { path: string; message: string } {
  return { path: str(result.error?.path), message: HUB_WIZARD_TEXTS.anchorBody }
}

/** What `apply` produced: the row to merge, and the degradation-A card. */
export type HubApplyOutcome =
  | {
      status: 'applied'
      path: string
      title: string
      message: string
      /** The state the Host reported for the freshly built book. */
      state: string
      /** `false` when the Host could not register the workspace (honest, with `hint`). */
      registered: boolean
      hint: string
    }
  | { status: 'refused'; code: string; message: string }

/**
 * The title to show after apply.
 *
 * Order: what the user typed → what the registry/next step echoes → the last
 * path segment. An empty label would make "在左侧工作区「」点「新会话」" absurd.
 */
export function appliedTitle(path: string, value: HubApplyValue, typed: string): string {
  const fromHost = str(value.nextStep?.title) === '' ? str(value.workspace?.title) : str(value.nextStep?.title)
  if (typed.trim() !== '') return typed.trim()
  if (fromHost !== '') return fromHost
  return lastSegment(path)
}

/** `D:\小说\蜀山` → `蜀山`; `…/` → the previous segment. */
export function lastSegment(path: string): string {
  const normalised = str(path).replaceAll('\\', '/').replace(/\/+$/u, '')
  const tail = normalised.slice(normalised.lastIndexOf('/') + 1)
  return tail === '' ? normalised : tail
}

/** The ADR-0010 D4 degradation-A sentence, used when the Host sent none. */
export function doneMessage(title: string): string {
  return `书已就绪。在左侧工作区「${title}」点「新会话」开始创作`
}

export function readHubApply(result: InternalResult<HubApplyValue>, typedTitle = ''): HubApplyOutcome {
  const value = result.value
  if (!result.ok || value === undefined) {
    const code = result.error?.code ?? 'fetch-failed'
    return { status: 'refused', code, message: describeWizardError(code, result.error?.message, result.error?.hint) }
  }
  const path = str(value.path) === '' ? str(value.nextStep?.path) : str(value.path)
  const title = appliedTitle(path, value, typedTitle)
  const message = str(value.nextStep?.message) === '' ? doneMessage(title) : str(value.nextStep?.message)
  return {
    status: 'applied',
    path,
    title,
    message,
    state: str(value.state) === '' ? 'usable' : str(value.state),
    registered: value.registered === true,
    hint: str(value.hint),
  }
}

/** The `willCreate` lines, in the Host's order, unknown kinds passed through. */
export function describeWillCreate(plan: HubPlanValue): string[] {
  const kinds = Array.isArray(plan.willCreate) ? plan.willCreate : []
  return kinds.map((kind) => HUB_WILL_CREATE_LABELS[kind] ?? kind)
}

/** The host has to write `inkflow.json`, so the panel must collect a title. */
export function planNeedsTitle(plan: HubPlanValue): boolean {
  const kinds = Array.isArray(plan.willCreate) ? plan.willCreate : []
  return kinds.includes('create-meta')
}

/** A suggested title: the directory name the user picked (editable, never hidden). */
export function defaultTitleFor(path: string): string {
  return lastSegment(path)
}

/**
 * Merge an applied book into the list IN PLACE (no refetch, no polling — the
 * book list only changes when the user does something, ADR-0010 D8).
 *
 * A row with the same canonical directory is replaced (a "not a book yet"
 * workspace becomes a book); otherwise the new book is added. Comparison is
 * case-insensitive with `/` spelling, because Windows and the picker disagree
 * about case for the same directory.
 */
export function mergeHubRow(books: readonly HubBookRow[], applied: { path: string; title: string; state: string }): HubBookRow[] {
  const key = pathKey(applied.path)
  const merged: HubBookRow[] = []
  let replaced = false
  for (const row of books) {
    if (replaced || pathKey(str(row.path)) !== key) {
      merged.push(row)
      continue
    }
    replaced = true
    merged.push({
      workspaceId: row.workspaceId,
      path: applied.path,
      title: applied.title,
      state: applied.state,
      usable: applied.state === 'usable',
      missing: [],
      actions: [],
      dirStatus: 'ok',
      ...(row.duplicates === undefined ? {} : { duplicates: row.duplicates }),
    })
  }
  if (!replaced) {
    merged.push({
      path: applied.path,
      title: applied.title,
      state: applied.state,
      usable: applied.state === 'usable',
      missing: [],
      actions: [],
      dirStatus: 'ok',
    })
  }
  return merged
}

function pathKey(path: string): string {
  const normalised = str(path).replaceAll('\\', '/').replace(/\/+$/u, '')
  return normalised.toLowerCase()
}
