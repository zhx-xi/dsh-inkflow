/**
 * The model catalog the settings page offers: which provider routes exist on this
 * machine, and which model ids each one advertises.
 *
 * WHY IT IS A HUB ROUTE. The subagent switch lives in the settings page, which belongs
 * to the book hub (ADR-0018 D1) and has no session, so the catalog has to be answerable
 * without one. It is also the only surface in this plugin that asks the Host what models
 * exist.
 *
 * WHY THE SERVICE IS OPTIONAL AND THE ANSWER IS A TYPED FAILURE. `ctx.get('llm')` (not
 * `inject: ['llm']`): a profile may not mount the model layer at all, and this plugin
 * must keep working then — the tools, the routes and the rest of the page stay. A
 * missing service, a provider list that throws, or `listModels` that never settles each
 * answer `ok: false` with a reason the panel can print, so the field degrades to a
 * hand-typed input instead of blocking the save. "I could not list the models" must
 * never mean "you cannot configure one".
 *
 * WHY THERE IS A DEADLINE. `listModels` is adapter-owned and may do provider I/O; one
 * slow provider must not hold a page request open. The whole collection shares ONE
 * deadline (2 s), after which the answer is `LLM_TIMEOUT` — no partial catalog, because
 * a half-filled dropdown looks complete.
 *
 * WHY NOTHING SECRET CAN LEAVE. The two readings are `LlmProviderInfo` (id, name) and
 * `LlmModelInfo` (provider, id, name, description, modalities) — no key, no base URL,
 * no credential of any kind is in either shape, and this module reads nothing else. The
 * settings file's `semanticApiKey` is irrelevant here and is never touched.
 */

import type { HostContext } from './context.js'
import { describeError, optionalService } from './probe.js'

/** The one deadline the whole catalog shares. */
export const MODELS_TIMEOUT_MS = 2_000

/** `llm` service, reduced to the two readings this page needs. */
export interface LlmServiceLike {
  listProviders(): readonly LlmProviderLike[]
  listModels(provider: string): Promise<readonly LlmModelLike[]>
}

/** `LlmProviderInfo`, reduced to the fields a picker shows. */
export interface LlmProviderLike {
  id: string
  name?: string
}

/** `LlmModelInfo`, reduced to the fields a picker shows. */
export interface LlmModelLike {
  id: string
  name?: string
  description?: string
}

export interface ModelChoice {
  id: string
  name: string
  description?: string
}

export interface ProviderChoice {
  id: string
  name: string
  models: ModelChoice[]
}

export interface HubModelsValue {
  providers: ProviderChoice[]
  /** The deadline that was in force, so the page can say why it degraded. */
  timeoutMs: number
}

export type HubModelsErrorCode = 'LLM_UNAVAILABLE' | 'LLM_TIMEOUT' | 'LLM_FAILED'

export type HubModelsReply =
  | { ok: true; value: HubModelsValue }
  | { ok: false; error: { code: HubModelsErrorCode; message: string; hint: string } }

/** Resolve `work` or the deadline, whichever lands first. */
function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<{ ok: true; value: T } | { ok: false }> {
  return new Promise((resolve) => {
    // No `unref` and no lingering handle either way: a settlement clears the timer, and a
    // fired timer is already spent.
    const timer = setTimeout(() => {
      resolve({ ok: false })
    }, timeoutMs)
    void work.then(
      (value) => {
        clearTimeout(timer)
        resolve({ ok: true, value })
      },
      () => {
        clearTimeout(timer)
        resolve({ ok: false })
      },
    )
  })
}

/**
 * The catalog, or a typed failure.
 *
 * `timeoutMs` is injectable so the degradation is testable without waiting 2 s — the
 * constant above is what production uses.
 */
export async function buildHubModels(
  ctx: HostContext,
  options: { timeoutMs?: number } = {},
): Promise<HubModelsReply> {
  const timeoutMs = options.timeoutMs ?? MODELS_TIMEOUT_MS
  const service = optionalService<LlmServiceLike>(
    ctx,
    'llm',
    (value) => typeof value.listProviders === 'function' && typeof value.listModels === 'function',
  )
  if (service === undefined) {
    return {
      ok: false,
      error: {
        code: 'LLM_UNAVAILABLE',
        message: 'this profile exposes no llm service, so the model catalog cannot be listed',
        hint: 'type the provider and model ids by hand — they are stored either way; the subagent then works as long as the route exists',
      },
    }
  }

  let providers: readonly LlmProviderLike[]
  try {
    providers = service.listProviders()
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'LLM_FAILED',
        message: `the provider list could not be read: ${describeError(error)}`,
        hint: 'type the provider and model ids by hand; nothing about the subagent setting depends on this list',
      },
    }
  }

  const collected = await withDeadline(
    Promise.all(
      providers.map(async (provider): Promise<ProviderChoice> => {
        const id = String(provider.id)
        try {
          const models = await service.listModels(id)
          return {
            id,
            name: provider.name === undefined || provider.name === '' ? id : provider.name,
            models: models.map((model) => ({
              id: String(model.id),
              name: model.name === undefined || model.name === '' ? String(model.id) : model.name,
              ...(model.description === undefined ? {} : { description: model.description }),
            })),
          }
        } catch {
          // ONE provider failing must not blank the whole catalog: the route is listed
          // with no models, and the page offers the manual input beside it. The error
          // itself is not forwarded — adapter messages can quote a URL, and a URL can
          // carry a credential.
          return { id, name: provider.name === undefined || provider.name === '' ? id : provider.name, models: [] }
        }
      }),
    ),
    timeoutMs,
  )

  if (!collected.ok) {
    return {
      ok: false,
      error: {
        code: 'LLM_TIMEOUT',
        message: `the model catalog did not answer within ${String(timeoutMs)} ms`,
        hint: 'type the provider and model ids by hand — the deadline only affects this list, never the save',
      },
    }
  }
  return { ok: true, value: { providers: collected.value, timeoutMs } }
}
