/**
 * The "no hardcoded colours" judgement, in one place (AGENTS.md §6).
 *
 * Two panel test files ask the same question — does a client source file draw a colour
 * from something other than a theme token — and the answer used to be the same regex in
 * both: `#[0-9a-fA-F]{3,8}`. That regex also matches an **issue reference in a comment**
 * (a comment that cites an issue), so the implementation that cited one turned the suite red,
 * and the cheapest way out was rewriting the comment. A guard whose false positive edits
 * prose is worse than no guard, hence this helper.
 *
 * What counts as a colour is a *position*, not a shape:
 *
 *   * a hex token inside quotes — `'#fff'`, `"#ff0000"`, `` `#abc` `` — because that is
 *     how a literal reaches a style object;
 *   * a hex token within a short run of text after a colour-ish property name —
 *     `border: 1px solid #0f0` — because CSS-in-JS also allows the bare form.
 *
 * A two-digit reference in a comment is neither: it is not quoted and no colour property precedes it
 * on that line, so it is not reported. The reverse still bites: `color: '#ff0000'` and
 * `background: "#abc"` are reported, which is the direction that protects the theme.
 *
 * Callers assert `findColorLiterals(source)` is empty; the returned records carry the
 * line and the token so a failure message can say where to look.
 */

/** A hex colour token that is not a prefix of a longer hex run (`#ffff` vs `#ffffff`). */
const HEX_TOKEN = '#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![0-9a-fA-F])'

/** A quoted hex literal: the quote is what makes it a value rather than prose. */
const QUOTED = new RegExp(`(['"\`])(${HEX_TOKEN})\\1`, 'g')

/**
 * The property names after which a bare hex token is a colour. `border` is listed alone
 * because every `borderX` spelling starts with it, and the suffix is matched by the
 * `[^\n]{0,40}` window rather than by enumerating dozens of names.
 */
const COLOUR_PROPERTIES =
  'color|colour|background|backgroundColor|backgroundImage|border|borderColor|borderTop|borderBottom|borderLeft|borderRight|outline|outlineColor|fill|stroke|strokeWidth|boxShadow|textShadow|caretColor|textDecorationColor|accentColor|stopColor'

/** A bare hex token on the same line, shortly after a colour-ish property name. */
const NEAR_PROPERTY = new RegExp(`\\b(?:${COLOUR_PROPERTIES})\\b[^\\n]{0,40}?(${HEX_TOKEN})`, 'gi')

/**
 * Every colour literal in `source`, ordered by position.
 *
 * `text` is the `#…` token itself (without the quotes), `index` is its offset and
 * `line` is 1-based — enough for `assert.deepEqual(…, [])` to print something an author
 * can act on.
 */
export function findColorLiterals(source) {
  if (typeof source !== 'string') return []
  const found = new Map()
  const record = (token, index) => {
    if (found.has(index)) return
    found.set(index, { index, line: source.slice(0, index).split('\n').length, text: token })
  }

  for (const match of source.matchAll(QUOTED)) {
    const token = match[2]
    // `match[0]` is quote + token + quote, so the token starts one character in.
    record(token, match.index + 1)
  }
  for (const match of source.matchAll(NEAR_PROPERTY)) {
    const token = match[1]
    record(token, match.index + match[0].length - token.length)
  }

  return [...found.values()].sort((left, right) => left.index - right.index)
}

/** Whether `source` holds at least one hardcoded colour. */
export function hasColorLiteral(source) {
  return findColorLiterals(source).length > 0
}
