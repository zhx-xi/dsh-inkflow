/**
 * Structural types for the slice of the DSH Client surface this plugin uses.
 *
 * Same rule as the Host half: no runtime import of any `@deepseek-ai/*`
 * package. React comes from the browser module table through the factory's
 * injected `require`; slot registration goes through the public `ctx.slots`
 * service only.
 *
 * Verified against DSH 0.2.1-rc.2 — `cordis_inspect_query` (client/Slots) times
 * out here, so the contract was read from the packed Client bundles instead
 * (each `dsh-client-ui-<name>` package's `lib/client.js`, and the slot catalog in
 * `dsh-cordis-client-runner/lib/client.js`):
 *
 *   slots.inject(key, callback) -> disposer
 *   slots.register(options, component) -> injection effect
 *
 *   conversation.view   kind = list, scope = SESSION ("对话 / 轨迹" tabs)
 *     register options : id (required), order, label
 *     standard props   : sessionId, useSessions, useSession, useWorkspaces,
 *                        useConversation, useChat, useProjection, …
 *     owner props      : inspectCall, viewRequest, openView, completeViewRequest
 *     occupants        : chat (id 'chat', order 0), trajectory (id 'trajectory', 10)
 *
 * `sidebar.panellist` and `main` are ROOT-scoped: they never see a session, so
 * they cannot name the book the panel is about (ADR-0008 D1). This plugin
 * registers none of them.
 */

import type { ComponentType } from 'react'

export interface SlotRegisterOptions {
  /** Slot key being registered into. */
  name: string
  /** Entry key inside that slot; `conversation.view` requires it. */
  id?: string
  order?: number
  label?: string | (() => string)
}

export interface SlotsService {
  inject(key: string, callback: () => unknown): () => void
  register(options: SlotRegisterOptions, component: ComponentType<never>): unknown
}

export interface LayoutService {
  selectPanel(panelId: string | null): void
}

export interface ClientContext {
  slots: SlotsService
  layout?: LayoutService
  effect(setup: () => void | (() => void)): () => void
}

/** One workspace as the Client's `workspaces` service lists it. */
export interface WorkspaceView {
  workspaceId?: string
  /** Absolute, `fs.realpath`-canonicalised by the Host. */
  path?: string
  title?: string
  /** Session ids belonging to this workspace (`session-<uuid>` spelling). */
  sessionIds?: string[]
}

export interface WorkspaceSnapshot {
  items?: WorkspaceView[]
}

/** One session summary from the Client's `sessions` service. */
export interface SessionSummary {
  id?: string
  /** Directory the session was opened in; blank sessions point at the workspace. */
  cwd?: string
  title?: string
  blank?: boolean
}

export interface SessionsSnapshot {
  ids?: string[]
  byId?: Record<string, SessionSummary | undefined>
}

/** The per-session snapshot `useSession` selects from (only what the panel reads). */
export interface SessionViewSnapshot {
  /** `'loading'` while the transcript is still being opened. */
  openState?: string
  running?: boolean
}

/**
 * The props a `conversation.view` component receives.
 *
 * The owner adds its own props (navigation/focus) which the skeleton ignores;
 * what it needs is the session id it is bound to and the two stores that name
 * the directory — `useSessions` for the session's `cwd`, `useWorkspaces` for the
 * workspace `path`/title. Only the session id travels to the Host; the paths are
 * for display (ADR-0008 D4).
 */
export interface ConversationViewProps {
  sessionId: string
  useSessions: <T>(select: (state: SessionsSnapshot) => T) => T
  useSession: <T>(select: (state: SessionViewSnapshot) => T) => T
  useWorkspaces: <T>(select: (state: WorkspaceSnapshot) => T) => T
}
