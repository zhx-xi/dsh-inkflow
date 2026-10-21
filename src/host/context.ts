/**
 * Structural types for the slice of the DSH Host surface this plugin uses.
 *
 * WHY HAND-WRITTEN: dsh-inkflow deliberately imports NOTHING from
 * `@deepseek-ai/*` at runtime. A profile-installed plugin is loaded from
 * `~/.dsh/profiles/<profile>/node_modules/`, and only a few `@deepseek-ai/*`
 * packages exist there; relying on the host's own resolution is an
 * undocumented, version-sensitive bet. Plain objects + these interfaces keep
 * the plugin dependency-free.
 *
 * These declarations are transcribed from DSH 0.2.1-rc.2's live contracts
 * (`cordis_inspect_query` Service/Tool contracts), not from memory. When a DSH
 * upgrade changes a shape, re-query the contract and update this file.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export interface LogSink {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** Raw JSON Schema node as the tool registry accepts it (JsonSchemaNode). */
export interface JsonSchemaNode {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  additionalProperties?: boolean
  items?: JsonSchemaNode
  enum?: (string | number | boolean | null)[]
  const?: string | number | boolean | null
  description?: string
  title?: string
  default?: unknown
  examples?: unknown
  oneOf?: JsonSchemaNode[]
}

/** `@deepseek-ai/dsh-tools` ToolDefinition, reduced to the fields we set. */
export interface ToolDefinition {
  name: string
  description: string
  /** Raw JSON Schema for the model-facing parameter object. */
  parameters: Record<string, unknown>
  output: {
    schema: JsonSchemaNode
    render(args: unknown, value: unknown): ContentBlock[]
    presentationMeta?(args: unknown, value: unknown): unknown
  }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
}

/** A minimal content block: the tool pipeline accepts `{type:'text', text}`. */
export type ContentBlock = { type: 'text'; text: string }

export interface ToolRunContext {
  readonly signal: AbortSignal
  readonly callId: unknown
  readonly agent?: { readonly id: string }
}

/** `@deepseek-ai/dsh-host-webserver` WebRoute. */
export interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface WebServerLike {
  register(route: WebRoute): () => void
}

export interface ToolRegistryLike {
  register(definition: ToolDefinition): () => void
}

/**
 * `@deepseek-ai/dsh-skill` skill surface, reduced to the fields we set.
 *
 * A provider is the borrowed same-process seam described by
 * `SkillRegistry.registerProvider(create)`: the registry calls `list()` for
 * catalog discovery and `get()` only for the winning candidate. Both on-demand
 * fields exist because a catalog listing must stay cheap — a skill body is
 * loaded when (and only when) the model asks for it.
 */
export interface SkillInvocationPolicy {
  modelInvocable: boolean
  userInvocable: boolean
}

export interface SkillResourceBase {
  kind: 'directory' | 'url' | 'opaque'
  path?: string
  url?: string
  description?: string
}

export interface SkillSummaryLike {
  name: string
  description: string
  whenToUse?: string
  invocation: SkillInvocationPolicy
  /** Where the skill came from (`bundled`, `project-dsh`, `runtime`, …). */
  source: string
  /** Must equal the provider name that returned the candidate, or the registry throws. */
  provider: string
  path?: string
  resourceBase?: SkillResourceBase
}

export interface SkillCandidateLike extends SkillSummaryLike {
  /** Ascending: a smaller rank wins a duplicate name inside one layer. */
  rank: number
  /** Opaque to the registry: handed back verbatim to `get()`. */
  locator: unknown
  metadata?: Readonly<Record<string, unknown>>
}

export interface SkillDefinitionLike extends SkillSummaryLike {
  content: string
  metadata?: Readonly<Record<string, unknown>>
}

export interface SkillLookupOptionsLike {
  /** Session working directory; the only workspace signal a provider sees. */
  cwd?: string
  signal?: AbortSignal
}

export interface SkillProviderLike {
  name: string
  list(options: SkillLookupOptionsLike): Promise<readonly SkillCandidateLike[]>
  get(candidate: SkillCandidateLike, options: SkillLookupOptionsLike): Promise<SkillDefinitionLike | undefined>
}

export interface SkillProviderControlLike {
  readonly signal: AbortSignal
  /** Drop cached catalog observations after the provider's own state changed. */
  invalidate(): void
}

export interface SkillRegistryLike {
  registerProvider(create: (control: SkillProviderControlLike) => SkillProviderLike): () => void
}

/**
 * `@deepseek-ai/dsh-agent-preset-registry` declaration shape.
 *
 * A preset is a *composition*: `plugins` is a Cordis entry list, exactly what a
 * bundle patch writes under `- insert:`. It cannot name skills or tools
 * directly — rows mount plugins, and those plugins contribute skills/tools into
 * the preset's scope. `disabled` is `boolean | JsExpr` in the real contract; we
 * only ever write the boolean form, so a JS expression is not modelled.
 */
export interface LoaderEntryLike {
  id?: string
  name: string
  config?: unknown
  disabled?: boolean
}

export interface PresetDefinitionLike {
  id: string
  name?: string
  description?: string
  order?: number
  plugins: readonly LoaderEntryLike[]
}

export interface AgentPresetRegistryLike {
  register(definition: PresetDefinitionLike): Promise<() => Promise<void>>
}

/**
 * `@deepseek-ai/dsh-system-prompt` PromptSection, reduced to the fields we set.
 *
 * The `text` thunk receives the assembly context, which the public type declares
 * as `{ scope?, signal? }` — a session is *not* part of that declaration. It is
 * therefore typed `unknown` here: the plugin narrows it defensively (see
 * `src/host/prompt.ts`) and degrades to "no injection" if a Host upgrade ever
 * stops passing an agent through. Type-lying it as `{ agent }` would turn that
 * upgrade into a crash inside the prompt pipeline.
 */
export interface PromptSectionLike {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: unknown) => string)
  readonly interpolate?: boolean
  readonly complete?: boolean
}

export interface SystemPromptServiceLike {
  section(section: PromptSectionLike): () => void
}

/** The slice of a Session that carries its directory. */
export interface PromptSessionLike {
  readonly header?: { readonly cwd?: string }
}

/**
 * `@deepseek-ai/dsh-working-directory` service, reduced to the sync reader.
 *
 * `get()` answers the *committed* directory without filesystem IO, which is the
 * only session-scoped directory readable from a synchronous prompt provider.
 */
export interface WorkingDirectoryLike {
  get(session: PromptSessionLike): string
}

/**
 * A live Session, reduced to the fields the panel channel reads.
 *
 * `header.cwd` is the creation-time directory the session store validates as an
 * absolute path; it is the last resort of the session → project chain
 * (ADR-0008 D4) because a later `cd` is not reflected in it.
 */
export interface SessionLike extends PromptSessionLike {
  readonly id?: string
  readonly header?: { readonly cwd?: string }
}

/** `@deepseek-ai/dsh-sessions` store, reduced to the lookup the channel needs. */
export interface SessionsLike {
  get(id: string): SessionLike | undefined
}

/**
 * `@deepseek-ai/dsh-workspace-registry` `Workspace`, reduced to the association
 * the channel needs: `path` is canonicalised through `fs.realpath` by the host,
 * and `sessionIds` is already filtered to sessions whose canonical cwd matches.
 */
export interface WorkspaceLike {
  readonly path: string
  readonly sessionIds: readonly string[]
}

/** `@deepseek-ai/dsh-workspace-registry` registry, reduced to `list()`. */
export interface WorkspaceRegistryLike {
  list(): readonly WorkspaceLike[]
}

/**
 * The Cordis context as seen by a Host plugin.
 *
 * `ctx.effect(setup)` owns a resource for the lifetime of the plugin; the
 * returned disposer is called on unload and on HMR replacement.
 */
export interface HostContext {
  effect(setup: () => void | (() => void)): () => void
  inject(deps: string[], callback: (scoped: HostContext) => void): () => void
  get(name: string): unknown
  logger(namespace: string): LogSink
  readonly tools?: ToolRegistryLike
  readonly webServer?: WebServerLike
  readonly systemPrompt?: SystemPromptServiceLike
  readonly workingDirectory?: WorkingDirectoryLike
}
