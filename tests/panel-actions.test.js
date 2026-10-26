/**
 * The panel's action buttons and the words its pages use.
 *
 * `node --test` has no DOM, so a rendered button cannot be inspected. Two kinds of
 * assertion cover the gap instead, and both fail when the contract breaks:
 *
 *   1. A SOURCE SCAN over `src/client/*.tsx`. Every `<button>` block either carries an
 *      `<Icon>` or is named in `WORD_ONLY` — so a new button with no glyph turns this red,
 *      and so does a word-only button that quietly grew an icon (the list is a claim about
 *      the page, not a skip list). The scan also refuses a hand-drawn `<svg>` in a page:
 *      the set lives in `icons.tsx`, and a second geometry is how two icon styles appear.
 *   2. A BUNDLE of the pure view models (`brief-model.ts`, `proposal-model.ts`, …) for the
 *      wording: a reader who never opens the manual has to understand 简报 / 审稿 / 提案
 *      from the labels alone, so "九段" / "被裁" / "被拒收" / bare "段" are asserted gone and
 *      their replacements are asserted explanatory.
 *
 * Why the wording lives in a model and not inline in JSX: a string in a `.tsx` cannot be
 * reached here, and a label nobody can test is a label that drifts back to jargon.
 *
 * Run: pnpm test (needs `pnpm run build` for the bundle-level tests of the other files; this
 * file only reads source and bundles the models itself).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CLIENT = join(ROOT, 'src', 'client')
const require = createRequire(import.meta.url)

/** Every page that owns action buttons. A page missing here is a page nobody checks. */
const PAGES = [
  'audit.tsx',
  'batch.tsx',
  'brief.tsx',
  'chapter-tree.tsx',
  'extract.tsx',
  'foreshadow.tsx',
  'gate.tsx',
  'library.tsx',
  'map.tsx',
  'outline.tsx',
  'proposal.tsx',
  'purge-card.tsx',
  'review.tsx',
  'timeline.tsx',
  'trash.tsx',
]

/**
 * The buttons that stay word-only, by one marker each — the marker has to appear inside that
 * button's own JSX, and the count is asserted both ways, so this table can neither hide a new
 * icon-less button nor keep a label that no longer exists.
 *
 * Two kinds are allowed and nothing else: an inline filter/switch (a glyph would compete with
 * the row of chips it sits in) and a row that selects rather than acts (the row IS the list).
 */
const WORD_ONLY = {
  // One button that renders three chips; the chip is the filter, not an action.
  'gate.tsx': ['key={level}'],
  // 横评 is a view toggle; the run row selects a run.
  'review.tsx': ['横评', `'当前'`],
  // The batch twin of the row checkboxes below it.
  'extract.tsx': ['全选待审'],
  // Two row lists: one axis each. Picking a row selects it, it does not act.
  'timeline.tsx': ['onPick(row)', 'pick(axisRowOf(entry))'],
  'library.tsx': ['pick(item)', 'pick(item)', 'describeIssueRow(issue)'],
  // A chapter row selects the chapter; the row IS the list. Its sibling — the volume head —
  // carries a caret, because folding is an action.
  'chapter-tree.tsx': ['onPick(chapter.id)'],
}

function sourceOf(page) {
  return readFileSync(join(CLIENT, page), 'utf8')
}

/** Every `<button …>…</button>` block in one source file; the panel nests no buttons. */
function buttonBlocks(source) {
  const blocks = []
  let index = source.indexOf('<button')
  while (index >= 0) {
    const end = source.indexOf('</button>', index)
    assert.ok(end > index, 'a <button> has no </button>: the scan cannot tell where it ends')
    blocks.push(source.slice(index, end))
    index = source.indexOf('<button', end)
  }
  return blocks
}

async function bundle(relative) {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(CLIENT, relative)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    write: false,
    logLevel: 'silent',
  })
  const code = Buffer.from(result.outputFiles[0].text, 'utf8').toString('base64')
  return import(`data:text/javascript;base64,${code}`)
}

test('every action button carries a glyph, and the word-only ones are listed one by one', () => {
  for (const page of PAGES) {
    const blocks = buttonBlocks(sourceOf(page))
    assert.ok(blocks.length > 0, `${page} has no <button> any more — remove it from PAGES if that is deliberate`)
    const iconless = blocks.filter((block) => !block.includes('<Icon'))
    const allowed = WORD_ONLY[page] ?? []
    assert.equal(
      iconless.length,
      allowed.length,
      `${page} has ${String(iconless.length)} word-only button(s) but ${String(allowed.length)} are documented`,
    )
    for (const label of allowed) {
      assert.ok(
        iconless.some((block) => block.includes(label)),
        `${page}: the documented word-only button「${label}」is gone — take it out of WORD_ONLY`,
      )
    }
  }
})

test('a page never draws its own svg, and the shared set keeps every glyph out of the a11y tree', () => {
  const icons = readFileSync(join(CLIENT, 'icons.tsx'), 'utf8')
  assert.match(icons, /aria-hidden="true"/, 'the shared icon must stay aria-hidden: the word beside it carries the meaning')
  assert.match(icons, /stroke="currentColor"/, 'the icon takes its colour from the host theme, never from a literal')
  for (const page of PAGES) {
    assert.equal(sourceOf(page).includes('<svg'), false, `${page} hand-draws an svg — use <Icon name="…" />`)
  }
})

test('every icon a page names exists in the shared set', async () => {
  const { ICON_NAMES } = await bundle('icon-names.ts')
  // Two shapes are in use: `name="refresh"` and `name={cond ? 'check' : 'play'}`. For the
  // expression only the BRANCHES are icon names — the condition compares against other
  // words (`armed === 'apply'`), so scanning every literal there would report a false hit.
  const NAMED = /<Icon\s+name=(?:"([a-z-]+)"|\{([^}]*)\})/gu
  for (const page of PAGES) {
    for (const match of sourceOf(page).matchAll(NAMED)) {
      const literal = match[1]
      const inside = match[2]
      const branches =
        inside === undefined
          ? []
          : [...inside.matchAll(/[?:]\s*'([a-z-]+)'/gu)].map((hit) => hit[1])
      const names = literal === undefined ? branches : [literal]
      assert.ok(names.length > 0, `${page}: an icon name the test cannot read`)
      for (const name of names) {
        assert.ok(ICON_NAMES.includes(name), `${page} names an icon that does not exist: ${name}`)
      }
    }
  }
})

test('brief: the segments are explained where they are shown, and trimmed says why', async () => {
  const model = await bundle('brief-model.ts')
  assert.equal(model.describeSegmentHeading(9), '注入的 9 段')
  for (const id of ['outline', 'promise', 'characters', 'voice', 'facts', 'foreshadow', 'world', 'prevTail', 'anchors']) {
    assert.ok(model.briefSegmentNote(id).length > 4, `${id} needs one line saying what it shows the model`)
  }
  assert.equal(model.stateLabel('trimmed'), '已裁剪（预算不够）')
  assert.equal(model.stateLabel('ok'), '完整')
  assert.equal(model.stateLabel('missing'), '无来源')

  const view = model.readBrief({
    ok: true,
    value: {
      tokens: 500,
      budgetTokens: 2000,
      segments: [{ id: 'outline', label: '大纲', tokens: 100, bytes: 40, text: 'x' }],
      trims: [],
      text: '',
    },
  })
  assert.equal(view.rows[0].note, model.briefSegmentNote('outline'), 'the row carries its own explanation')
  // "占预算" must be the budget's share: 100 of a 2000-token budget, not of the 500 assembled.
  assert.equal(view.rows[0].share, '5.0%')

  const page = sourceOf('brief.tsx')
  assert.equal(page.includes("'被裁'"), false, 'the bare term is gone from the page')
  assert.ok(page.includes('占预算'), 'the share column says what it is a share of')
  assert.ok(page.includes('describeSegmentHeading'), 'the heading counts the segments instead of claiming nine')
})

test('review: opinions the Host refused are named as “not recorded”, with the reason', async () => {
  const model = await bundle('review-model.ts')
  assert.equal(model.REJECTED_SECTION_TITLE, '未进记录的意见')
  assert.ok(model.REJECTED_SECTION_NOTE.includes('缺维度'), 'the note names the first reason')
  assert.ok(model.REJECTED_SECTION_NOTE.includes('缺正文'), 'the note names the second reason')

  const page = sourceOf('review.tsx')
  assert.equal(page.includes('被拒收的意见'), false, 'the page no longer borrows the Host’s word')
  assert.ok(page.includes('REJECTED_SECTION_TITLE'))
  assert.ok(page.includes('REJECTED_SECTION_NOTE'))
})

test('proposal: a hunk is a 改动块, and a row starts with 第 N 处', async () => {
  const model = await bundle('proposal-model.ts')
  assert.match(model.describeCounts({ total: 3, pending: 3, accepted: 0, rejected: 0 }), /共 3 个改动块/)
  assert.equal(model.hunkLabel(3), '第 3 处')
  const blocked = model.applyBlocked({ total: 2, pending: 2, accepted: 0, rejected: 0 }, 'open')
  assert.ok(blocked.includes('改动块') && !blocked.includes(' 段'), blocked)
  assert.ok(model.PROPOSAL_NOTE.includes('改动块'), 'the header explains what a 改动块 is')
  assert.ok(model.PROPOSAL_NOTE.includes('回滚'), 'the header tells 应用 and 回滚 apart')

  const page = sourceOf('proposal.tsx')
  assert.ok(page.includes('hunkLabel'), 'the row head is the number, written as 第 N 处')
  assert.equal(page.includes('逐段'), false, 'the page stops saying 逐段')
})

test('the audit and the gate each state their own boundary, in a constant both pages print', async () => {
  const notes = await bundle('page-notes.ts')
  assert.ok(notes.AUDIT_SCOPE_NOTE.includes('一致性'))
  assert.ok(notes.AUDIT_SCOPE_NOTE.includes('不变量'))
  assert.ok(notes.GATE_SCOPE_NOTE.includes('单章'))
  assert.ok(notes.GATE_SCOPE_NOTE.includes('零模型调用'))
  assert.notEqual(notes.AUDIT_SCOPE_NOTE, notes.GATE_SCOPE_NOTE, 'two pages, two boundaries — not one sentence twice')

  for (const [page, name, emptyState] of [
    ['audit.tsx', 'AUDIT_SCOPE_NOTE', 'view.counts.total === 0'],
    ['gate.tsx', 'GATE_SCOPE_NOTE', 'view.total === 0'],
  ]) {
    const source = sourceOf(page)
    const note = source.indexOf(name)
    assert.ok(note > 0, `${page} does not print ${name}`)
    assert.ok(
      note < source.indexOf(emptyState),
      `${page}: the boundary line must be standing text, not something the empty state says`,
    )
  }
})

test('gate: a finding row leads with the sentence; the code and the address drop to a second line', () => {
  const source = sourceOf('gate.tsx')
  const detail = source.indexOf('{finding.detail}')
  const code = source.indexOf('{finding.code}</span>')
  assert.ok(detail > 0, 'the row prints the sentence')
  assert.ok(code > detail, 'the sentence must come first in the DOM, the code after it')
  assert.ok(source.includes('<GateSeverityBadge'), 'the severity is a badge, not a word glued to the code')
})

test('a two-step confirm still says the word, so the icon is never the only cue', async () => {
  const purge = await bundle('purge-model.ts')
  assert.ok(purge.cleanActionLabel(true).startsWith('确认'))
  const proposal = await bundle('proposal-model.ts')
  assert.ok(proposal.applyActionLabel(true).startsWith('确认'))
  assert.ok(proposal.rollbackActionLabel(true).startsWith('确认'))
})

/**
 * An icon must not start a line of its own.
 *
 * The first icon pass put `display: 'block'` on the shared `<svg>`, which is what an SVG
 * defaults to anyway. Inside a flex row (the tab bar, the shared action button) that was
 * invisible; inside an inline `<span>` (a tree caret) and inside a plain `<button>` with no
 * `display` of its own (设定库's group row) it pushed the glyph onto its own line box — the
 * caret rendered ABOVE its label instead of beside it.
 *
 * These two assertions pin the fix at the two places the class of bug lives: the one component
 * that draws every icon, and the one row that was reported.
 */
test('icons flow with the text they sit next to, never above it', () => {
  const icons = sourceOf('icons.tsx')
  assert.match(
    icons,
    /display: 'inline-block'/,
    'the shared svg must be inline-block: block-level starts a new line in a span or a plain button',
  )
  assert.match(icons, /verticalAlign: '-2px'/, 'and sit on the text baseline rather than the descender line')
  assert.doesNotMatch(icons, /display: 'block'/, 'block is the value that broke the caret in 设定库')
})

test('设定库 group rows lay the caret, the name and its count on one line', () => {
  const source = sourceOf('library.tsx')
  const start = source.indexOf('const groupRowStyle = {')
  assert.ok(start > 0, 'the group row has its own style object')
  const style = source.slice(start, source.indexOf('} as const', start))
  assert.match(style, /display: 'flex'/, 'a row, not a line of text')
  assert.match(style, /alignItems: 'center'/, 'the caret and the 12px label share a centre line')
  assert.match(style, /gap: /, 'spacing comes from the container, not from a margin on the count')
})
