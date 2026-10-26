/**
 * The panel's icon set: hand-drawn SVG paths, one file, no dependency.
 *
 * WHY HAND-DRAWN AND NOT A LIBRARY: this package ships with zero runtime dependencies
 * (`dependencies` is empty by contract), and a glyph font would add a font file plus a
 * licence to a plugin whose README is one page. The house style was already set by
 * `HubIcon` in `hub.tsx` — a 16×16 viewBox, `fill="none"`, `stroke="currentColor"` — so the
 * set follows it rather than inventing a second geometry.
 *
 * WHY `currentColor` ONLY: the palette belongs to the host theme (`--dsw-alias-*`), and the
 * guards reject colour literals in source. An icon that carried its own colour would fight
 * the theme in one of the two modes and be invisible in the other.
 *
 * WHY THE ICON NEVER CARRIES MEANING ALONE: every icon is `aria-hidden`, and every place
 * that uses one also shows a word (a tab label, a button label, a section title). An icon
 * is a scan target, not a label — a screen reader, a colour-blind reader and a reader who
 * has never seen this set all get the same information from the text next to it.
 *
 * Geometry conventions: strokes are 1.2 wide (1.6 when the element is the active one, the
 * same rule `HubIcon` uses for the selected sidebar entry), everything sits on whole or
 * half units of a 16-unit grid so the shapes stay crisp at 14px and 16px.
 */

import type { ReactNode } from 'react'

import type { IconName } from './icon-names.js'

/** The paths of one icon, in the 16×16 box. Filled shapes use their own fill. */
const PATHS: Readonly<Record<IconName, ReactNode>> = {
  // A page with two text lines: the manuscript.
  chapters: (
    <>
      <path d="M4 2.5h5l3 3v8.5H4V2.5Z" />
      <path d="M6 7.5h4M6 10h4" />
    </>
  ),
  // Three descending bars: the overall → volume → chapter tree.
  outline: (
    <>
      <path d="M2.5 4h11M4.5 8h9M6.5 12h7" />
    </>
  ),
  // Two book spines side by side: the setting library.
  library: (
    <>
      <path d="M3 3h4v10H3zM8.5 3H13v10H8.5z" />
    </>
  ),
  // A clock: when it happened. (The second axis is told by the column, not the glyph.)
  timeline: (
    <>
      <path d="M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2Z" />
      <path d="M8 4.8V8l2.2 1.6" />
    </>
  ),
  // A bookmark: the marker a foreshadow plants and later pays off.
  foreshadow: (
    <>
      <path d="M4.5 2.5h7v11L8 10.6l-3.5 2.9v-11Z" />
    </>
  ),
  // A map pin: a place.
  map: (
    <>
      <path d="M8 2.2c2.2 0 4 1.8 4 4 0 2.9-4 7.6-4 7.6S4 9.1 4 6.2c0-2.2 1.8-4 4-4Z" />
      <path d="M8 5.3a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z" />
    </>
  ),
  // A clipboard: what will be handed to the model.
  brief: (
    <>
      <path d="M4.5 3.5h7v10h-7z" />
      <path d="M6.5 2.2h3v2h-3zM6.5 7h3M6.5 9.5h2" />
    </>
  ),
  // A shield: the mechanical checks that must pass.
  gate: (
    <>
      <path d="M8 2.2 13 4v4.2c0 2.9-2.4 5.1-5 6-2.6-.9-5-3.1-5-6V4l5-1.8Z" />
    </>
  ),
  // A magnifier: reading a chapter as a critic.
  review: (
    <>
      <path d="M7.2 3a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4Z" />
      <path d="M10.4 10.4 13.6 13.6" />
    </>
  ),
  // A ballot with a tick: accept or reject, piece by piece.
  proposal: (
    <>
      <path d="M3.5 3.5h9v9h-9z" />
      <path d="M6 8.2 7.4 9.6 10.4 6.6" />
    </>
  ),
  // A tray: what waits for a decision.
  candidates: (
    <>
      <path d="M3.2 8.6 5 3.5h6l1.8 5.1v4H3.2v-4Z" />
      <path d="M3.2 8.6h3l.9 1.8h1.8l.9-1.8h3" />
    </>
  ),
  // Stacked layers: a queue of chapters.
  batch: (
    <>
      <path d="M8 2.6 13 5.4 8 8.2 3 5.4l5-2.8Z" />
      <path d="M3 9 8 11.8 13 9" />
    </>
  ),
  // A checklist: the whole-book consistency report.
  audit: (
    <>
      <path d="M3 4h2M3 8h2M3 12h2M7 4h6M7 8h6M7 12h6" />
    </>
  ),
  // A bin: the recovery area.
  trash: (
    <>
      <path d="M4.2 5h7.6l-.7 8.2H4.9L4.2 5Z" />
      <path d="M3 5h10M6.4 3h3.2" />
    </>
  ),
  // Circular arrow: reload / re-run.
  refresh: (
    <>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13.2 3.2v3.2H10" />
    </>
  ),
  // Arrow leaving a tray: export.
  export: (
    <>
      <path d="M8 2.8v6.4M5.4 7.2 8 9.8l2.6-2.6" />
      <path d="M3.6 12.6h8.8" />
    </>
  ),
  // A tick: confirm / save / accept.
  check: (
    <>
      <path d="M3.2 8.4 6.2 11.4 12.8 4.6" />
    </>
  ),
  // A cross: cancel / reject / close.
  close: (
    <>
      <path d="M4 4l8 8M12 4l-8 8" />
    </>
  ),
  // A triangle: resume / run.
  play: (
    <>
      <path d="M5.4 3.2 12.4 8l-7 4.8V3.2Z" />
    </>
  ),
  // Circular arrow the other way: roll back.
  undo: (
    <>
      <path d="M3 8a5 5 0 1 0 1.6-3.7" />
      <path d="M2.8 3.2v3.2H6" />
    </>
  ),
  // A plus: new event / add.
  plus: (
    <>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </>
  ),
  // A caret: expand / collapse (rotated by the caller for direction).
  caret: (
    <>
      <path d="M5.6 3.6 10 8l-4.4 4.4" />
    </>
  ),
  // The same caret pointing down: the open state, drawn rather than rotated (the shared
  // `Icon` takes no transform, and a transform per caller would be a second geometry rule).
  'caret-down': (
    <>
      <path d="M4.6 6.4 8 9.8l3.4-3.4" />
    </>
  ),
  // A pencil: edit this entry's file.
  edit: (
    <>
      <path d="M10.6 2.6 13.4 5.4 6 12.8H3.2V10l7.4-7.4Z" />
      <path d="M9 4.2 11.8 7" />
    </>
  ),
  // Arrow to a corner: jump to the entry that owns this row.
  locate: (
    <>
      <path d="M5 11 11 5M6.6 5H11v4.4" />
    </>
  ),
  // A magnifier-less search: query.
  search: (
    <>
      <path d="M7 3.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z" />
      <path d="M9.9 9.9 13 13" />
    </>
  ),
  // A padlock: read-only / needs confirmation first.
  lock: (
    <>
      <path d="M5 8V6.2a3 3 0 0 1 6 0V8" />
      <path d="M3.8 8h8.4v5.6H3.8z" />
    </>
  ),
}

/** Every name in `PATHS`, so a guard can assert nothing is registered without a drawing. */
export interface IconProps {
  readonly name: IconName
  /** Edge length in px. 14 for a tab row, 16 for a page header; default 14. */
  readonly size?: number
  /** Heavier stroke for the selected/active use — the same rule `HubIcon` follows. */
  readonly active?: boolean
}

/**
 * One icon. Decorative by contract: `aria-hidden`, and the word beside it carries the meaning.
 *
 * The stroke width is the only thing `active` changes, so a selected tab reads as "selected"
 * without a second colour or a background fill (the tab already has an underline for that).
 */
export function Icon({ name, size, active }: IconProps) {
  const edge = typeof size === 'number' ? size : 14
  const width = active === true ? 1.6 : 1.2
  return (
    <svg
      width={edge}
      height={edge}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={width}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flex: 'none', display: 'block' }}
    >
      {PATHS[name]}
    </svg>
  )
}
