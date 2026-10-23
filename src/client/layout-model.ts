/**
 * The panel's scroll-box geometry — the single source of the numbers (issue 116).
 *
 * WHY THIS FILE EXISTS. In the 章节 tab the chapter tree (left) and the body
 * (right) both already declared `overflowY: 'auto'`, yet neither ever scrolled:
 * nothing in the ancestor chain was ever capped by the viewport. Measured in the
 * live GUI (DSH 0.2.1-rc.2 desktop, window 1280x900 → viewport 1266x838), from
 * the panel upwards:
 *
 *   our panel root (`height:'100%'`)   2539px   ← the percentage RESOLVED, but
 *   our grid body (`flex:1`)           2428px     against a content-sized box
 *   our two columns (`overflowY:auto`) 2428px   ← scrollHeight === clientHeight,
 *                                                 so `auto` could never engage
 *   the slot wrapper (flex item with   2539px   ← automatic minimum size: it
 *     `min-height:auto`)                          refuses to shrink below content
 *   the conversation scroll box         762px   ← the ONE scroller on screen;
 *     (overflow-y:auto)                content 2667px   the whole panel scrolled
 *
 * So the panel cannot inherit a height (the issue's option A): the wrapper is
 * content-sized by construction and is not ours to style. It has to state its own
 * height, measured at runtime (option C).
 *
 * TWO THINGS THE FIRST MEASUREMENT TAUGHT (each cost a round):
 *
 *   1. `flex: 1` on the grid means `flex-basis: 0%`, and a zero basis overrides an
 *      explicit `height` on a flex item. Setting only the height left the body at
 *      2428px — nothing happened. Hence `flex: '0 0 auto'` below.
 *   2. The bottom is NOT the scroll box's own bottom. The harness keeps its
 *      composer seat inside the same scroll flow, stuck to the bottom of the
 *      viewport (measured 128px tall, top 710 in an 838px viewport, while the
 *      scroll box itself is 762px tall). Sizing to the scroll box slid the
 *      columns' lower edge under the composer and left the page with a 128px
 *      scrollbar; sizing to the composer's top left zero overflow (both measured).
 *
 * Hence the rule: the box may grow until the FIRST thing below it in the same
 * scroll flow — whatever harness element that happens to be, found structurally,
 * never by class name (those are build hashes that change with the harness).
 */

import type { CSSProperties } from 'react'

/** Carries the measured height of the scroll box, in px, down to the columns. */
export const SCROLL_HEIGHT_VAR = '--inkflow-body-h'

/**
 * Last resort when nothing could be measured (no DOM, no window, a degenerate
 * layout). This is the behaviour the panel had before issue 116: unconstrained,
 * ugly, but never collapsed to zero — a panel with no height at all is worse than
 * a panel that scrolls as a page.
 */
export const SCROLL_HEIGHT_FALLBACK = '100%'

/**
 * The sized box: an explicit height (measured variable, `100%` fallback), one
 * pinned grid row, and a flex basis that lets the explicit height win.
 */
export const SCROLL_BOX_STYLE: CSSProperties = {
  height: `var(${SCROLL_HEIGHT_VAR}, ${SCROLL_HEIGHT_FALLBACK})`,
  gridTemplateRows: 'minmax(0, 1fr)',
  flex: '0 0 auto',
  minHeight: 0,
}

/**
 * One column of the two-column layout. Shared by the chapters tab and the setting
 * library so the two tabs cannot drift apart; `minHeight: 0` is what lets a flex
 * or grid item shrink below its content — the precondition for scrolling.
 */
export const SCROLL_COLUMN_STYLE: CSSProperties = {
  minHeight: 0,
  overflowY: 'auto',
}

/** Everything the geometry needs, in viewport coordinates (CSS pixels). */
export interface ScrollBounds {
  /** `getBoundingClientRect().top` of the box being sized. */
  boxTop: number
  /** `window.innerHeight`: the bound when the box has no scrolling ancestor. */
  viewportHeight: number
  /** Bottom of the nearest scrolling ancestor, or `null` when there is none. */
  scrollerBottom: number | null
  /** Tops of the elements that follow the box in the same scroll flow, any level. */
  laterTops: readonly number[]
}

/**
 * The lowest edge the box may reach, in viewport coordinates: the smallest of the
 * viewport, the scroll box's bottom, and whatever starts below the box.
 *
 * A "later" element that starts at (or above) the box's own top is in the same row
 * — the other column — and is skipped, or both columns would come out zero tall.
 */
export function usableBottom(bounds: ScrollBounds): number {
  const { boxTop, viewportHeight, scrollerBottom, laterTops } = bounds
  let bottom = viewportHeight
  if (scrollerBottom !== null) bottom = Math.min(bottom, scrollerBottom)
  for (const top of laterTops) {
    if (top > boxTop + 1) bottom = Math.min(bottom, top)
  }
  return bottom
}

/**
 * Height for the box, or `null` when the geometry cannot support a claim (no
 * finite bound, no room, scrolled out of view) — `null` leaves the CSS fallback in
 * charge instead of collapsing the box.
 *
 * Floored, never rounded: rounding up by 0.3px leaves the parent scroll box
 * overflowing by a pixel, and a one-pixel overflow is a page scrollbar (measured
 * at 886x638: rounded → 1px overflow, floored → 0).
 */
export function scrollBoxHeight(bounds: ScrollBounds): number | null {
  if (!Number.isFinite(bounds.boxTop) || !Number.isFinite(bounds.viewportHeight)) return null
  const bottom = usableBottom(bounds)
  if (!Number.isFinite(bottom)) return null
  const height = Math.floor(bottom - bounds.boxTop)
  return height > 0 ? height : null
}

/**
 * The CSS variable declaration for a measured height. React's `CSSProperties` has
 * no index signature for custom properties, hence the cast: the value is a legal
 * CSS declaration, the type simply does not model `--*`.
 */
export function scrollHeightVariable(height: number | null): CSSProperties {
  if (height === null) return {}
  return { [SCROLL_HEIGHT_VAR]: `${height}px` } as CSSProperties
}
