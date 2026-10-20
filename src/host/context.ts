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
  readonly systemPrompt?: {
    section(section: {
      name: string
      order: number
      text: string | ((context: unknown) => string)
      interpolate?: boolean
    }): () => void
  }
}
