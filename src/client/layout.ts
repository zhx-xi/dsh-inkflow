/**
 * The ONE place that measures how tall a panel scroll box may be (issue 116).
 *
 * `getBoundingClientRect` only — no `document`, no colour, no theme: the numbers
 * live in `layout-model.ts`, this file reads the DOM and hands the result back as
 * the CSS variable the two columns already consume.
 *
 * WHY A RUNTIME MEASUREMENT IS UNAVOIDABLE (measured, DSH 0.2.1-rc.2 desktop):
 * the panel's slot wrapper is a flex item with an automatic minimum size inside the
 * conversation scroll box, so it is content-sized and refuses to shrink below its
 * content. `height: '100%'` therefore resolves to the CONTENT height (measured
 * 2539px, not the 762px viewport): a purely CSS fix has no definite number to
 * inherit. The box states its own height, and `SCROLL_HEIGHT_FALLBACK` covers the
 * case where nothing can be measured.
 *
 * WHAT COUNTS AS THE BOTTOM: the harness keeps its composer seat inside the same
 * scroll flow, stuck to the bottom of the viewport (measured 128px tall, top 710 in
 * an 838px viewport, while the scroll box is 762px). Taking the scroll box's own
 * bottom sized the columns 128px too tall — their lower edge slid under the
 * composer and the page kept a 128px scrollbar (both measured). So the bottom is
 * "the first thing below this box in the same scroll flow", found structurally:
 * no harness class name is referenced anywhere (they are build hashes).
 */

import { useCallback, useLayoutEffect, useState } from 'react'
import type { CSSProperties } from 'react'

import { scrollBoxHeight, scrollHeightVariable } from './layout-model.js'
import type { ScrollBounds } from './layout-model.js'

/** `overflow-y` values that make an element a scroll viewport for its children. */
const SCROLLING = new Set(['auto', 'scroll', 'overlay'])

/** How far up the tree to look for the scroll viewport before giving up. */
const MAX_DEPTH = 40

function scrollViewportOf(box: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = box.parentElement
  let depth = 0
  while (node !== null && depth < MAX_DEPTH) {
    if (SCROLLING.has(getComputedStyle(node).overflowY)) return node
    node = node.parentElement
    depth += 1
  }
  return null
}

/**
 * The geometry of one box: its own top, the viewport height, the scroll viewport's
 * bottom and the tops of everything that follows it in the same scroll flow.
 *
 * Later siblings are collected at every level up to the viewport, because the
 * element that bounds us may be a sibling of an ancestor rather than of the box
 * itself (that is exactly where the composer seat sits). A zero-size element is
 * skipped: a collapsed panel is not a boundary.
 */
function boundsOf(box: HTMLElement, view: Window): ScrollBounds {
  const boxTop = box.getBoundingClientRect().top
  const laterTops: number[] = []
  let scrollerBottom: number | null = null
  let node: HTMLElement | null = box.parentElement
  let depth = 0
  while (node !== null && depth < MAX_DEPTH) {
    for (let sibling = node.nextElementSibling; sibling !== null; sibling = sibling.nextElementSibling) {
      const rect = sibling.getBoundingClientRect()
      if (rect.height < 1) continue
      laterTops.push(rect.top)
    }
    if (SCROLLING.has(getComputedStyle(node).overflowY)) {
      scrollerBottom = node.getBoundingClientRect().bottom
      break
    }
    node = node.parentElement
    depth += 1
  }
  return { boxTop, viewportHeight: view.innerHeight, scrollerBottom, laterTops }
}

export interface ScrollBoxHandle {
  /** Attach to the box being sized: it is measured, and it receives the variable. */
  readonly ref: (element: HTMLDivElement | null) => void
  /** Spread onto that same element: `{ '--inkflow-body-h': '523px' }`, or `{}`. */
  readonly style: CSSProperties
}

/**
 * Size one scroll box to the space it actually has.
 *
 * Four things change that space without changing the box, so the measurement runs
 * on all of them: the window (`resize`), the scroll viewport's own box and its
 * children (`ResizeObserver` — a sidebar collapse or another panel opening resizes
 * the column with no `window.resize`, and the composer seat can grow), the panel's
 * chrome (the stale-build banner appears after the first `/status` answer, the
 * header wraps at narrow widths → measured on every render), and a tab switch
 * (new element, new ref). Re-measuring a settled layout sets the same number again,
 * which React turns into a no-op, so the loop stops after one pass.
 */
export function useScrollBox(): ScrollBoxHandle {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [height, setHeight] = useState<number | null>(null)
  const ref = useCallback((next: HTMLDivElement | null) => setElement(next), [])

  const measure = useCallback(() => {
    if (element === null) {
      setHeight((previous) => (previous === null ? previous : null))
      return
    }
    const view = element.ownerDocument.defaultView
    const next = view === null ? null : scrollBoxHeight(boundsOf(element, view))
    setHeight((previous) => (previous === next ? previous : next))
  }, [element])

  useLayoutEffect(() => {
    measure()
  })

  useLayoutEffect(() => {
    if (element === null || typeof window === 'undefined') return undefined
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure())
    const viewport = scrollViewportOf(element)
    if (observer !== null && viewport !== null) {
      // The scroll viewport and its children: the composer seat and the panel's own
      // wrapper live there, and either can change size (composer grows, a panel
      // opens) without `window.resize` firing. Our own height change settles after
      // one callback because re-measuring a settled layout is a no-op in React.
      observer.observe(viewport)
      for (const child of viewport.children) observer.observe(child)
    }
    window.addEventListener('resize', measure)
    return () => {
      if (observer !== null) observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [element, measure])

  return { ref, style: scrollHeightVariable(height) }
}
