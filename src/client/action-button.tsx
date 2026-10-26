/**
 * The panel's one action-button style.
 *
 * WHY ONE CONSTANT AND NOT THIRTEEN COPIES: every page under `src/client` had copied the
 * same eight-property object, and an action button that carries a glyph needs the same
 * three more everywhere (`display: inline-flex`, `alignItems: 'center'`, `gap: 4`) — without
 * them the icon and its word sit on two different baselines. Thirteen places to change is
 * thirteen places to forget, so the base shape lives here and each page's variants (`armed`,
 * `danger`, `disabled`, the dense row size) spread it and override only what they differ in.
 *
 * WHY THE COLOURS COME FROM TOKENS: AGENTS.md §6 — a button that carried its own colour
 * would fight the theme in one of the two modes and vanish in the other.
 *
 * Why not a component: the pages build their style conditionally (`armed`, `disabled`,
 * small/large), so a component with a `style` prop would move that decision into props
 * without removing a line of it. The element stays a `<button>` the page owns; only the
 * style is shared. The icon is always `<Icon size={13} />` followed by the word — the word
 * is what carries the meaning (see `icons.tsx`).
 */

const SHAPE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  borderRadius: 6,
  cursor: 'pointer',
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
} as const

/** The default: a header or page action at 12px. */
export const ACTION_BUTTON_STYLE = { ...SHAPE, padding: '2px 10px', fontSize: 12 } as const

/** The dense size: per-row verdicts inside a card, next to 11px metadata. */
export const ACTION_BUTTON_STYLE_SMALL = { ...SHAPE, padding: '1px 8px', fontSize: 11 } as const
