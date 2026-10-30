/**
 * Contract tests for the panel's two independent scroll boxes (issue 116).
 *
 * The bug: in the 章节 tab the chapter tree and the body were ONE page-long
 * column. `overflowY: 'auto'` was already on both columns, but nothing in the
 * ancestor chain was ever capped by the viewport, so the columns took their
 * content height and the single scroller was the conversation box around the
 * whole panel.
 *
 * Measured on DSH 0.2.1-rc.2 desktop (the numbers are quoted in
 * `.agents/specs/architecture.md` §4.3.1), which is why this contract has three
 * halves:
 *
 *   1. STATIC — the built `lib/client.js` (the artifact DSH loads) must carry the
 *      height source: the CSS variable, the `100%` fallback, the single pinned
 *      grid row, and the flex basis that lets an explicit height win.
 *   2. WIRING — both views (`index.tsx` chapters tab, `library.tsx` library tab)
 *      must consume the SAME helper and style pair, and neither may restate the
 *      variable name or do viewport arithmetic of its own. A second copy is how
 *      the two tabs drift apart, and a hardcoded number is what rots on the next
 *      harness release.
 *   3. BEHAVIOUR — the pure geometry in `layout-model.ts`: the box ends at the
 *      first thing below it in the same scroll flow, the result is floored, and an
 *      unmeasurable layout reports `null` so the `100%` fallback takes over
 *      instead of collapsing the panel.
 *
 * Run: pnpm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
const require = createRequire(import.meta.url)

function readBundle() {
  if (!existsSync(BUNDLE)) throw new Error(`lib/client.js is missing: run \`pnpm run build\` first`)
  return readFileSync(BUNDLE, 'utf8')
}

function readSource(name) {
  return readFileSync(join(ROOT, 'src', 'client', name), 'utf8')
}

/** Bundle the pure geometry module and import it, the same way the panel tests do. */
async function loadLayoutModel() {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client', 'layout-model.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    write: false,
    logLevel: 'silent',
  })
  const file = result.outputFiles[0]
  const code = Buffer.from(file.text, 'utf8').toString('base64')
  return import(`data:text/javascript;base64,${code}`)
}

const layout = await loadLayoutModel()

// ---------------------------------------------------------------------------
// 1. The built bundle: the height source is in the artifact DSH loads
// ---------------------------------------------------------------------------

test('the client bundle ships the measured height variable and its fallback', () => {
  const text = readBundle()
  // Without the variable the columns have no height source and issue 116 comes
  // back: both of them silently take the content height again. Exactly one
  // occurrence: the name is defined in one place and referenced, never restated.
  assert.equal((text.match(/--inkflow-body-h/g) ?? []).length, 1, 'the variable name exists exactly once in the bundle')
  // The fallback is `100%`, the panel's pre-fix behaviour: unconstrained but never
  // collapsed to zero.
  assert.ok(text.includes('SCROLL_HEIGHT_FALLBACK = "100%"'), 'the 100% fallback reaches the artifact')
  // The height is composed from the variable, not written as a literal.
  assert.ok(text.includes('var(${SCROLL_HEIGHT_VAR}'), 'the height is built from the variable')
})

test('no viewport constant is baked into the client half', () => {
  // The height is measured at runtime. A `calc(100dvh - Npx)` would be a magic
  // number tied to one harness chrome height, and it would slide the columns under
  // the harness composer (128px measured) — the reason it was rejected.
  for (const file of ['index.tsx', 'panel-chrome.tsx', 'panel-view.tsx', 'use-workbench.ts', 'library.tsx', 'layout.ts', 'layout-model.ts']) {
    assert.equal(/100dvh|100vh/.test(readSource(file)), false, `${file} must not carry a viewport constant`)
  }
  assert.equal(/100dvh|100vh/.test(readBundle()), false, 'the bundle must not carry a viewport constant')
})

test('the client bundle carries the three style facts the fix depends on', () => {
  const text = readBundle()
  // One explicit row: a default `auto` row grows to the content height, which is
  // the whole bug. `minmax(0, 1fr)` is what pins the row to the box.
  assert.ok(text.includes('minmax(0, 1fr)'), 'the body grid must pin its single row (minmax(0, 1fr))')
  // Measured trap: `flex: 1` means `flex-basis: 0%`, which overrides an explicit
  // `height` on a flex item — a 651px height was ignored while that was in place.
  assert.ok(text.includes('0 0 auto'), 'the sized box must not keep a zero flex basis')
  // Both columns still declare their own scrolling.
  assert.ok((text.match(/overflowY: "auto"/g) ?? []).length >= 2, 'each column keeps its own overflowY: auto')
  // No hardcoded colour creeps in with the layout change (AGENTS.md §6).
  assert.ok(text.includes('var(--dsw-alias-'), 'visible colours stay on theme tokens')
})

test('no harness class name is trusted by the geometry', () => {
  // The measured chain's names are build hashes (`Dc7zOa_*` …) and DOM ids that
  // change with the harness release, so the rule has to be structural. These are
  // the exact identifiers seen in the measurement — none of them may appear.
  for (const file of ['layout.ts', 'layout-model.ts']) {
    const source = readSource(file)
    for (const marker of ['Dc7zOa', 'viewArea', 'scrollBody', 'composerSeat']) {
      assert.equal(source.includes(marker), false, `${file} must not name the harness element ${marker}`)
    }
  }
})

// ---------------------------------------------------------------------------
// 2. Wiring: one shared helper, no second source of truth
// ---------------------------------------------------------------------------

test('both panel tabs consume the shared scroll-box helpers', () => {
  // The workbench is three files now and each helper has exactly one owner: the hook
  // measures, the view spreads the box height, the colour/style table takes the column
  // scrolling (which is where a column's own scroll declaration lives).
  const expected = {
    'use-workbench.ts': ['useScrollBox'],
    'panel-view.tsx': ['SCROLL_BOX_STYLE'],
    'panel-chrome.tsx': ['SCROLL_COLUMN_STYLE'],
    'library.tsx': ['useScrollBox', 'SCROLL_BOX_STYLE', 'SCROLL_COLUMN_STYLE'],
  }
  for (const [file, markers] of Object.entries(expected)) {
    const source = readSource(file)
    for (const marker of markers) assert.ok(source.includes(marker), `${file} takes ${marker} from the shared helper`)
  }
})

test('neither view restates the variable name', () => {
  for (const file of ['index.tsx', 'panel-chrome.tsx', 'panel-view.tsx', 'use-workbench.ts', 'library.tsx']) {
    assert.equal(readSource(file).includes('--inkflow-body-h'), false, `${file} must not hardcode the variable name`)
  }
})

test('the chapter body is a sized box, not a `flex: 1` grower', () => {
  // The style table and the spread live in different files after the split: the
  // declaration in `panel-chrome.tsx`, the use site in `panel-view.tsx`.
  const source = readSource('panel-chrome.tsx')
  const body = /const bodyStyle = \{([\s\S]*?)\n\}/.exec(source)
  assert.ok(body !== null, 'bodyStyle is still a module constant')
  assert.equal(/flex:\s*1/.test(body[1]), false, 'the body cannot keep `flex: 1`: flex-basis 0 would override its height')
  assert.ok(readSource('panel-view.tsx').includes('...SCROLL_BOX_STYLE'), 'the body grid spreads the shared box style')
})

// ---------------------------------------------------------------------------
// 3. Behaviour: the pure geometry
// ---------------------------------------------------------------------------

/** The live GUI at 1266x838, as measured (see layout-model.ts for the chain). */
function measured(overrides = {}) {
  return {
    boxTop: 187, // chapter body top
    viewportHeight: 838, // window.innerHeight
    scrollerBottom: 838, // conversation scroll box bottom
    laterTops: [710], // composer seat top — 128px above the scroll box bottom
    ...overrides,
  }
}

test('the box ends at the first thing below it in the same scroll flow', () => {
  // 710 − 187 = 523px: the measured height at which the conversation scroll box
  // stops overflowing (scrollHeight === clientHeight), so the page stops scrolling.
  assert.equal(layout.scrollBoxHeight(measured()), 523)
  assert.equal(layout.usableBottom(measured()), 710)
})

test('the smallest bound wins: viewport, scroll box, or what follows', () => {
  const { usableBottom } = layout
  assert.equal(usableBottom(measured({ laterTops: [710, 640] })), 640, 'the closest follower bounds the box')
  assert.equal(usableBottom(measured({ laterTops: [] })), 838, 'nothing below: the scroll box bottom')
  assert.equal(usableBottom(measured({ scrollerBottom: 780, laterTops: [] })), 780, 'a scroll box ending above the viewport')
  assert.equal(usableBottom(measured({ scrollerBottom: null, laterTops: [] })), 838, 'no scroll ancestor: the viewport itself')
  assert.equal(usableBottom(measured({ viewportHeight: 600, scrollerBottom: null, laterTops: [] })), 600, 'a short window')
})

test('a follower in the same row does not bound anything', () => {
  // The other column starts at the box's own top: counting it would make both
  // columns zero tall, which is exactly the trap this rule has to avoid.
  assert.equal(layout.usableBottom(measured({ laterTops: [187, 710] })), 710)
  assert.equal(layout.usableBottom(measured({ laterTops: [100, 710] })), 710, 'an element above the box is not a bottom')
  assert.equal(layout.scrollBoxHeight(measured({ laterTops: [187] })), 651, 'only the same-row sibling: fall back to the viewport')
})

test('the height is floored, never rounded up', () => {
  // Measured at 886x638: rounding the 288.75px result up left the scroll box
  // overflowing by one pixel — and a one-pixel overflow is a page scrollbar.
  assert.equal(layout.scrollBoxHeight(measured({ boxTop: 221, laterTops: [509.75], scrollerBottom: 509.75 })), 288)
})

test('an unmeasurable box reports null so the 100% fallback takes over', () => {
  const { scrollBoxHeight } = layout
  assert.equal(scrollBoxHeight(measured({ boxTop: 838 })), null, 'no room at all: do not collapse the box to 0')
  assert.equal(scrollBoxHeight(measured({ boxTop: 900 })), null, 'scrolled out of view: no claim')
  assert.equal(scrollBoxHeight(measured({ boxTop: Number.NaN })), null)
  assert.equal(scrollBoxHeight(measured({ viewportHeight: Number.POSITIVE_INFINITY })), null, 'a non-finite bound is not a height')
})

test('the variable is emitted only for a measured height', () => {
  const { scrollHeightVariable, SCROLL_HEIGHT_VAR } = layout
  assert.deepEqual(scrollHeightVariable(523), { [SCROLL_HEIGHT_VAR]: '523px' })
  assert.deepEqual(scrollHeightVariable(null), {}, 'nothing measured: the 100% fallback stays in charge')
})

test('SCROLL_BOX_STYLE states the height source once and pins the row', () => {
  const { SCROLL_BOX_STYLE, SCROLL_HEIGHT_VAR, SCROLL_HEIGHT_FALLBACK } = layout
  assert.equal(SCROLL_HEIGHT_FALLBACK, '100%', 'the fallback is the pre-fix behaviour, never a collapse')
  assert.equal(SCROLL_BOX_STYLE.height, `var(${SCROLL_HEIGHT_VAR}, 100%)`)
  assert.equal(SCROLL_BOX_STYLE.gridTemplateRows, 'minmax(0, 1fr)')
  assert.equal(SCROLL_BOX_STYLE.flex, '0 0 auto')
  assert.equal(SCROLL_BOX_STYLE.minHeight, 0)
})

test('SCROLL_COLUMN_STYLE is the two-column contract both tabs share', () => {
  const { SCROLL_COLUMN_STYLE } = layout
  assert.equal(SCROLL_COLUMN_STYLE.overflowY, 'auto', 'each column scrolls on its own')
  assert.equal(SCROLL_COLUMN_STYLE.minHeight, 0, 'a flex/grid item may shrink below its content, or it never scrolls')
})
