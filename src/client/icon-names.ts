/**
 * The names of every icon the panel draws — and nothing else.
 *
 * WHY THE NAMES LIVE APART FROM THE DRAWINGS: `icons.tsx` is a React component file (JSX,
 * `ReactNode`), so a `node --test` contract cannot import it without pulling the renderer in.
 * The names are the half a test cares about ("does every tab have a glyph?"), so they sit in
 * a plain module with no JSX and no React. `icons.tsx` keys its `PATHS` record by this union,
 * which makes "a name with no drawing" a compile error instead of a blank tab.
 */

export const ICON_NAMES = [
  'chapters',
  'outline',
  'library',
  'timeline',
  'foreshadow',
  'map',
  'brief',
  'gate',
  'review',
  'proposal',
  'candidates',
  'batch',
  'audit',
  'trash',
  'refresh',
  'export',
  'check',
  'close',
  'play',
  'undo',
  'plus',
  'caret',
  'locate',
  'search',
  'lock',
] as const

/** Every icon the panel uses. The union is the contract `PANEL_TABS` and the pages check. */
export type IconName = (typeof ICON_NAMES)[number]
