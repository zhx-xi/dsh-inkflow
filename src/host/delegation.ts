/**
 * Delegation policy: who writes the chapter, said once and read in two places.
 *
 * WHY A POLICY AND NOT A CAPABILITY. This plugin embeds no model client (roadmap X-26,
 * zero runtime dependencies), so `subagentEnabled` cannot make a subagent run. What it
 * can do is state the answer in the two places the session's own agent actually reads
 * before it starts working: a `systemPrompt` section assembled on every request, and
 * one line in the batch tool's reply. The dispatch is the agent's call; nothing here
 * executes it and nothing here observes whether it happened.
 *
 * WHY ONE FUNCTION PRODUCES ALL THREE SENTENCES. The three states (off / delegated /
 * unconfigured) are read by two consumers with different shapes, and a second copy of
 * the wording is how "the panel says X, the tool says Y" starts. `describeDelegation`
 * is the only place the state is decided and the only place the words are written; the
 * injection prints `policy`, the tool prints `sentence`, and `sentence` is the first
 * element of `policy` — so the two surfaces cannot disagree, they share a string.
 *
 * WHY THE MODEL STAYS UNCONFIGURED INSTEAD OF GETTING A GUESS. "provider set, model
 * empty" is not a route: filling it in from the first entry of a catalog would silently
 * pick a model the author never chose, at the moment prose is generated. The pinned
 * behaviour is the opposite — say "not configured", ask with `ask_user_question`, and
 * keep the answer for THIS session only. `settings.json` is therefore never written by
 * that flow (the tests hash the file around it).
 *
 * WHY THE SECTION IS A THUNK. `text` runs per assembly (the same reason `prompt.ts`'s
 * brief section is one), so a save in the settings page is in force on the next turn
 * without a restart. The static half — the preset's tool rows — is a registered
 * composition and cannot be re-read that way; see `preset.ts` and `index.ts`.
 */

import type { HostContext, LogSink, SystemPromptServiceLike } from './context.js'
import { describeError, optionalService } from './probe.js'
import type { InkflowSettings } from './settings.js'
import { settingsOf } from './settings.js'

/** Section name on `ctx.systemPrompt`. Unique: a duplicate in one layer throws. */
export const DELEGATION_SECTION_NAME = 'inkflow:delegation'

/** Sort order: immediately after the writing context (120), which it comments on. */
export const DELEGATION_SECTION_ORDER = 121

/** The three states the policy can be in. */
export type DelegationState = 'off' | 'delegated' | 'unconfigured'

/** The slice of the settings this policy reads (a plain object keeps it testable). */
export type DelegationSettings = Pick<InkflowSettings, 'subagentEnabled'> &
  Pick<Partial<InkflowSettings>, 'subagentProvider' | 'subagentModel'>

/** A decision about delegation, with the words that state it. */
export interface DelegationPlan {
  state: DelegationState
  /** Provider route to dispatch on; absent = keep the session's own routing. */
  provider?: string
  /** Model id to dispatch on; present only in the `delegated` state. */
  model?: string
  /** `provider/model` when a provider is named, else the bare model id. */
  route?: string
  /** One line: 「写作方式：…」. The batch tool prints exactly this. */
  sentence: string
  /** The systemPrompt section's body; `sentence` is its first element. */
  policy: string[]
  /** The machine-readable half of `sentence`, carried in the tool reply. */
  wire: { state: DelegationState; sentence: string; provider?: string; model?: string }
}

/** `provider/model`, or the bare model id when no provider is configured. */
function routeLabel(provider: string | undefined, model: string): string {
  return provider === undefined ? model : `${provider}/${model}`
}

/**
 * The one decision: off, delegated-with-a-model, or enabled-without-a-model.
 *
 * A provider with no model is deliberately indistinguishable from a blank one: a route
 * needs both halves, and the interface states what is missing rather than promising a
 * dispatch it cannot make.
 */
export function describeDelegation(settings: DelegationSettings): DelegationPlan {
  const enabled = settings.subagentEnabled === true
  const provider = settings.subagentProvider
  const model = settings.subagentModel

  if (!enabled) {
    const sentence = '写作方式：自己写（未开启子智能体）'
    return {
      state: 'off',
      sentence,
      policy: [sentence, '本章由你自己写；不要委派。'],
      wire: { state: 'off', sentence },
    }
  }

  if (model === undefined) {
    const sentence = '写作方式：未配置模型 —— 先问作者要哪个模型，再委派'
    const lines = [
      sentence,
      '生成类任务（大纲 / 细纲 / 正文）必须委派给子智能体，但默认模型未配置：动手前先用 `ask_user_question` ' +
        '让作者从模型目录里选一个，再派发；不要自己挑一个。',
    ]
    if (provider !== undefined) {
      lines.push(`设置里只填了 provider（${provider}），模型为空 —— 只填 provider 不构成一条可派发的路由。`)
    }
    lines.push(
      '作者选定的模型只用于本次会话：不要调用 `inkflow_settings_update` 把它写回设置，也不要把它当成这本书的默认值。' +
        '要改长期默认，请作者自己到设置页填。',
    )
    return {
      state: 'unconfigured',
      ...(provider === undefined ? {} : { provider }),
      sentence,
      policy: lines,
      wire: { state: 'unconfigured', sentence, ...(provider === undefined ? {} : { provider }) },
    }
  }

  const route = routeLabel(provider, model)
  const sentence = `写作方式：委派子智能体（${route}）`
  const where = provider === undefined ? `model=\`${model}\`（provider 沿用本会话路由）` : `provider=\`${provider}\`，model=\`${model}\``
  return {
    state: 'delegated',
    ...(provider === undefined ? {} : { provider }),
    model,
    route,
    sentence,
    policy: [sentence, `生成类任务（大纲 / 细纲 / 正文）必须委派给子智能体，${where}；审计与设定入库留在本会话。`],
    wire: { state: 'delegated', sentence, ...(provider === undefined ? {} : { provider }), model },
  }
}

/**
 * The section body: a heading, then the policy lines.
 *
 * The last line names the limit rather than hiding it: the plugin declares the policy
 * and the agent dispatches, so "did a subagent really run" is not something this text
 * claims to have verified.
 */
export function delegationPolicyText(plan: DelegationPlan): string {
  return [
    '',
    '## 写作方式（插件设置）',
    ...plan.policy,
    '',
    '这条策略由插件声明；插件自身不调用任何模型，也不会替你派发 —— 派发由你完成。',
    '',
  ].join('\n')
}

/** Whether the writing preset should load the delegation tool row. */
export function delegationEnabled(settings: DelegationSettings): boolean {
  // Keyed on the switch, not on the model: with no model the agent must still be able
  // to ask the author and then dispatch, which needs the workflow tool.
  return settings.subagentEnabled === true
}

export interface DelegationSectionRegistration {
  registered: boolean
  reason?: string
}

/**
 * Register the delegation section, degraded exactly like the writing context.
 *
 * `ctx.get('systemPrompt')` rather than `inject`: a profile without the service loses
 * this section and keeps every tool. A duplicate registration (the plugin mounted twice
 * in one layer) is survivable — the host throws `already registered`, and a second copy
 * of the policy would be wrong anyway.
 */
export function registerDelegationSection(
  ctx: HostContext,
  options: { dataDir: string; log: LogSink },
): DelegationSectionRegistration {
  const service = optionalService<SystemPromptServiceLike>(
    ctx,
    'systemPrompt',
    (value) => typeof value.section === 'function',
  )
  if (service === undefined) {
    options.log.info('systemPrompt service missing: the delegation policy is not injected (tools and skills still work)')
    return { registered: false, reason: 'systemPrompt service missing' }
  }

  // Same shape as `registerWritingContext`: `effect` runs the setup synchronously, so a
  // duplicate registration is reported honestly instead of as a silent success.
  let failure: string | undefined
  ctx.effect(() => {
    try {
      const dispose = service.section({
        name: DELEGATION_SECTION_NAME,
        order: DELEGATION_SECTION_ORDER,
        text: (): string => {
          try {
            return delegationPolicyText(describeDelegation(settingsOf(options.dataDir)))
          } catch (error) {
            // The thunk must never throw: a broken settings file must cost this
            // section, not the request.
            options.log.warn(`delegation policy skipped: ${describeError(error)}`)
            return ''
          }
        },
      })
      failure = undefined
      return dispose
    } catch (error) {
      failure = describeError(error)
      options.log.warn(`delegation section skipped: ${failure}`)
      return () => {}
    }
  })
  if (failure !== undefined) return { registered: false, reason: failure }
  options.log.info(`delegation section registered: ${DELEGATION_SECTION_NAME} (order ${String(DELEGATION_SECTION_ORDER)})`)
  return { registered: true }
}
