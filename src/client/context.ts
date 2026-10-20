/**
 * Structural types for the slice of the DSH Client surface this plugin uses.
 *
 * Same rule as the Host half: no runtime import of any `@deepseek-ai/*`
 * package. React comes from the browser module table through the factory's
 * injected `require`; slot registration goes through the public `ctx.slots`
 * service only.
 *
 * Verified against DSH 0.2.1-rc.2 (`cordis_inspect_query` client Service/Slots):
 *   slots.inject(key, callback) -> disposer
 *   slots.register(options, component) -> injection effect
 *   main                 (keyed slot, key = panel id)  -> central workbench page
 *   sidebar.panellist    (list slot,  id  = panel id)  -> left sidebar icon
 */

import type { ComponentType } from 'react'

export interface SlotRegisterOptions {
  /** Slot key being registered into. */
  name: string
  /** Panel id for `sidebar.panellist`. */
  id?: string
  /** Panel key for `main`. */
  key?: string
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

/** Icon props supplied by the sidebar for a `sidebar.panellist` entry. */
export interface SidebarPanelIconProps {
  /** Requested square edge in pixels. */
  size: number
  /** Whether this panel is the selected one in the main column. */
  active: boolean
}
