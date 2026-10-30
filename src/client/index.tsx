/**
 * dsh-inkflow — Client half, the plugin entry point.
 *
 * The build wraps this module in `window.__ModuleLoader__.load({id, factory})`
 * (see scripts/build.mjs); this file therefore exports the standard Client plugin
 * shape `{inject, apply}` and never touches the module loader itself.
 *
 * TWO ENTRIES, TWO SCOPES (ADR-0010 D1, which narrows ADR-0008 D1):
 *
 *   - the WORKBENCH is `conversation.view`: "this book's cockpit", and "this
 *     book" can only be derived from the conversation it is opened in. Its view and
 *     its data assembly live in `panel-view.tsx` / `use-workbench.ts`.
 *   - the BOOK HUB is root-scoped (`sidebar.panellist` icon + `main` body). It
 *     has no session, so it names nothing: the book list comes from the Host's
 *     own workspace registry over `/inkflow/internal/hub/*` (ADR-0010 D2/D3).
 *     A remembered "last project" is still never a resolution source
 *     (ADR-0006 D5) — the registry is.
 *
 * WHY THIS FILE IS ONLY THE ENTRY: registration order is the part of the client
 * half a user can break without seeing a compile error — two hub entries must
 * register together, and the directory picker has to be handed over before the
 * first hub click. Keeping that in one short file means the order can be read at a
 * glance; the page itself has no business being here.
 */

import type { ClientContext } from './context.js'
import { HubIcon, HubView } from './hub.js'
import { createDirectoryPicker, setHubDirectoryPicker } from './hub-wizard.js'
import { HUB_PANEL_ID, HUB_PANEL_LABEL, HUB_PANEL_ORDER } from './hub-model.js'
import { InkflowView } from './panel-view.js'

// The page moved, the address did not: `InkflowView` is still exported from the module
// the build entry points at, so nothing that imported it by that path had to change.
export { InkflowView }

export const inject = ['slots']

/**
 * TWO entries, each with its own job (ADR-0010 D1):
 *
 *   `conversation.view` / id `inkflow` / order 40 — the **writing workbench** for
 *     the book the session belongs to. `id: 'inkflow'` puts it beside
 *     对话 / 轨迹 (chat 0, trajectory 10) and is stable: user patches address it
 *     by that id.
 *
 *   `sidebar.panellist` / id `inkflow-hub` / order 35 + `main` / key `inkflow-hub`
 *     — the **book hub**. A root-scoped icon is only half an entry point: the
 *     sidebar renders the glyph from `sidebar.panellist` and the BODY from the
 *     keyed `main` slot under the same id, so registering one without the other
 *     is exactly the "有图标没页面" failure (AGENTS.md §8 陷阱 3; measured on
 *     0.2.1-rc.2 — selecting a missing `main` key throws "main panel … is not
 *     registered"). The hub carries no content view and no write action: it lists
 *     books and their gate state, and every write stays in the workbench or the
 *     wizard.
 */
export function apply(ctx: ClientContext): void {
  // The hub's wizard is the only Client surface that needs a SERVICE (the
  // directory picker), not a slot: hand it over before either hub entry
  // registers, so the first click already has it (ADR-0010 E6).
  setHubDirectoryPicker(createDirectoryPicker((name) => ctx.get?.(name)))

  ctx.effect(() =>
    ctx.slots.inject('conversation.view', () =>
      ctx.slots.register({ name: 'conversation.view', id: 'inkflow', order: 40, label: () => 'InkFlow' }, InkflowView),
    ),
  )
  ctx.effect(() =>
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register(
        { name: 'sidebar.panellist', id: HUB_PANEL_ID, order: HUB_PANEL_ORDER, label: () => HUB_PANEL_LABEL },
        HubIcon,
      ),
    ),
  )
  ctx.effect(() =>
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: HUB_PANEL_ID }, HubView)),
  )
}
