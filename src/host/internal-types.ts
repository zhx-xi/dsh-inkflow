/**
 * The panel channel's shared vocabulary: the envelope record, the session-root
 * types and the resolved target every builder and every write route takes.
 *
 * WHY IT IS A FILE: `internal.ts` is both the resolver (session → book) and the
 * barrel the route table imports from, while the projections and the write routes
 * need nothing from it but these shapes. Keeping them here lets the three modules
 * depend on one leaf instead of on each other, so the graph stays acyclic even
 * though `internal.ts` re-exports builders and writers for its callers.
 */

import type { ProjectProbe } from './project.js'

/** `{ok:true,value}` / `{ok:false,error}` bodies: plain JSON objects. */
export type JsonRecord = Record<string, unknown>

/** Which link of the chain answered; reported so the panel can explain itself. */
export type SessionRootSource = 'workspace-registry' | 'working-directory' | 'session-header'

export interface SessionRoot {
  sessionId: string
  root: string
  source: SessionRootSource
}

export interface ChannelTarget {
  sessionId: string
  /** Project root: the resolved directory, walked up to the nearest book. */
  root: string
  source: SessionRootSource
  probe: ProjectProbe
}

export type ChannelResolution = { target: ChannelTarget } | { failure: JsonRecord }
