/**
 * Host wiring for the writing context (issue #20): one `systemPrompt` section,
 * its session-directory resolution and its degradation rules.
 *
 * WHY A SECTION: the four facts (book, current chapter, previous tail, matched
 * world-book entries) must be in front of the model *before* its first token. A
 * tool call happens after the model already decided what to write; a skill body
 * loads on demand. `systemPrompt.section()` is the only surface rendered first.
 *
 * WHY THE SECTION IS FREE OF STATE: `text` is a thunk the host calls for every
 * assembly, so it must be synchronous and must never throw. It resolves the
 * session directory, runs the projection in `writing-context.ts`, and returns
 * the text — any failure is one log line plus an empty section.
 *
 * WHY THE SERVICE IS OPTIONAL: `ctx.get('systemPrompt')` instead of
 * `inject: ['systemPrompt']`, exactly like `skills` / `agentPresets`. A profile
 * without the service must lose only this feature, not the tools.
 *
 * Contract source: DSH 0.2.1-rc.2 `cordis_inspect_query` Host Services
 * `systemPrompt` (`section(section: PromptSection): () => void`,
 * `PromptSection = { name, order, text: string | ((context: AssembleContext) => string), interpolate?, complete? }`)
 * and `workingDirectory` (`get(session): string` — the committed directory,
 * without filesystem IO).
 */

import type { HostContext, LogSink, PromptSessionLike, SystemPromptServiceLike, WorkingDirectoryLike } from './context.js'
import { findProjectRoot } from './project.js'
import { describeError, optionalService } from './probe.js'
import type { WritingContextOptions } from './writing-context.js'
import { DEFAULT_BUDGET_TOKENS, buildWritingContext } from './writing-context.js'

/** Section name on `ctx.systemPrompt`. Unique: a duplicate in one layer throws. */
export const PROMPT_SECTION_NAME = 'inkflow:writing-context'

/**
 * Sort order of the section. Placement is only advisory (the host orders
 * sections numerically; the exact neighbours are an observed-not-verified
 * detail), so this value keeps us near the other context blocks.
 */
export const PROMPT_SECTION_ORDER = 120

export interface WritingContextRegistration {
  registered: boolean
  reason?: string
}

/**
 * Register the section for the lifetime of the plugin.
 *
 * Absence of the `systemPrompt` service is a supported state: one log line, and
 * the tools/skills/preset are untouched. A duplicate registration (the plugin
 * mounted twice in one layer) is also survivable — the host throws
 * `already registered`, and a second copy of this section would be wrong anyway.
 */
export function registerWritingContext(
  ctx: HostContext,
  options: WritingContextOptions & { log: LogSink },
): WritingContextRegistration {
  const service = optionalService<SystemPromptServiceLike>(
    ctx,
    'systemPrompt',
    (value) => typeof value.section === 'function',
  )
  if (service === undefined) {
    options.log.info('systemPrompt service missing: the writing context is not injected (tools and skills still work)')
    return { registered: false, reason: 'systemPrompt service missing' }
  }

  // Cordis runs an `effect` setup synchronously, so the flag written inside the
  // callback is already settled when `effect` returns. That is what lets this
  // function report the duplicate-registration case honestly instead of
  // claiming success and leaving the user with no injection and no explanation.
  let failure: string | undefined
  ctx.effect(() => {
    try {
      const dispose = service.section({
        name: PROMPT_SECTION_NAME,
        order: PROMPT_SECTION_ORDER,
        text: (context: unknown): string =>
          writingContextText(
            ctx,
            context,
            { budgetTokens: options.budgetTokens, tailChars: options.tailChars },
            options.log,
          ),
      })
      failure = undefined
      return dispose
    } catch (error) {
      failure = describeError(error)
      options.log.warn(`writing context section skipped: ${failure}`)
      return () => {}
    }
  })
  if (failure !== undefined) return { registered: false, reason: failure }
  options.log.info(
    `writing context section registered: ${PROMPT_SECTION_NAME} (budget ${String(
      options.budgetTokens ?? DEFAULT_BUDGET_TOKENS,
    )} tokens)`,
  )
  return { registered: true }
}

/**
 * The whole per-assembly body: session directory → project root → gate →
 * projection. Any failure is one log line and an empty section.
 */
function writingContextText(
  ctx: HostContext,
  context: unknown,
  options: WritingContextOptions,
  log: LogSink,
): string {
  try {
    const cwd = sessionDirectory(ctx, context)
    if (cwd === '') return ''
    const root = findProjectRoot(cwd)
    if (root === undefined) return ''
    return buildWritingContext(root, options).text
  } catch (error) {
    log.warn(`writing context skipped: ${describeError(error)}`)
    return ''
  }
}

/**
 * The session's effective directory, without awaiting anything.
 *
 * Order: the committed value from `workingDirectory.get(session)` (the same
 * source the tools resolve from), then the session header's creation-time cwd,
 * then the process cwd. Every step is optional because `AssembleContext` does
 * not formally declare `agent` — see the type note in `context.ts`.
 */
function sessionDirectory(ctx: HostContext, context: unknown): string {
  const session = asRecord(asRecord(context)?.['agent'])?.['session']
  const service = optionalService<WorkingDirectoryLike>(
    ctx,
    'workingDirectory',
    (value) => typeof value.get === 'function',
  )
  if (service !== undefined && session !== undefined) {
    try {
      const dir = service.get(session as PromptSessionLike)
      if (typeof dir === 'string' && dir !== '') return dir
    } catch {
      // Fall through: a header cwd is still a usable answer.
    }
  }
  const headerCwd = asRecord(asRecord(session)?.['header'])?.['cwd']
  if (typeof headerCwd === 'string' && headerCwd !== '') return headerCwd
  return process.cwd()
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}
