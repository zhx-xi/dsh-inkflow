/**
 * The private panel channel's route contract (`/inkflow/internal/*`, ADR-0008).
 *
 * These four declarations describe what a route IS — its name, its pattern, the verbs it
 * declares, the body/query keys it reads, and what a handler is handed and returns. They
 * live here, outside `routes.ts`, for one mechanical reason and one structural one:
 *
 *   * `routes.ts` is at its recorded line budget (`scripts/check-guards.mjs`), and its job
 *     grew again with the purge area (the fold's `limit`). Moving a pure type block out is the change
 *     that costs nothing, whereas deleting working guards or comments to make room would;
 *   * more than one module now owns route descriptors (the purge routes sit
 *     routes next to the channel that answers them), so the contract needs a home that is
 *     not "wherever the biggest file's dispatch loop happens to be".
 *
 * Nothing here runs: it is types plus one constant, so importing it from a channel module
 * cannot create a cycle (`routes.ts` → channel module → `route-types.ts`).
 */

import type { ChannelTarget, JsonRecord } from './internal.js'

/** Only the verbs the channel will ever declare; anything else is a 405. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** The verbs a route may declare, in the order a 405 answers them. */
export const KNOWN_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

export interface RouteInput {
  target: ChannelTarget
  /** The verb that actually arrived; a route may declare several. */
  method: HttpMethod
  query: URLSearchParams
  version: string
  /**
   * The plugin's own data directory, for the reads that need plugin-level state rather than
   * book content (the settings file behind the semantic backend's endpoint).
   */
  dataDir: string
  /** `pattern` capture groups, still percent-encoded. */
  params: readonly string[]
  /** Parsed JSON object body (empty for a bodyless request). */
  body: JsonRecord
}

export interface RouteReply {
  status: number
  body: JsonRecord
  headers?: Record<string, string>
}

export interface InternalRoute {
  /** Human name for tests/logs, not a wire value. */
  readonly name: string
  readonly pattern: RegExp
  /** Declared per route. A verb outside this list is a 405 with `Allow`. */
  readonly methods: readonly HttpMethod[]
  /**
   * The only body fields this route accepts (writes only; `sessionId` is always
   * allowed). Anything else is a 400 `UNEXPECTED_BODY_FIELD`, so a client
   * cannot smuggle a directory or a future knob past the guards.
   */
  readonly body?: readonly string[]
  /**
   * The only QUERY keys this route reads (`sessionId` is always allowed, exactly as it is
   * in a body). Anything else is a 400 `UNKNOWN_QUERY_PARAM`.
   *
   * Required, not optional: the channel used to hand the whole query string to
   * a handler that read three keys and silently ignored the rest, so `?chapterID=` (a
   * spelling mistake) answered the DEFAULT chapter with HTTP 200 and the caller could not
   * see that its target had been dropped. A route that takes no knobs says so with `[]`,
   * and there is no third state where nobody declared anything.
   */
  readonly query: readonly string[]
  /**
   * Read routes may have to make the derived index fresh first, so a
   * handler is allowed to be async; the dispatcher awaits it either way.
   */
  readonly handle: (input: RouteInput) => RouteReply | Promise<RouteReply>
}
