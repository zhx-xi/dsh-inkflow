/**
 * The line-ending and BOM style of a manuscript file (ADR-0016).
 *
 * A chapter has a format of its own — the author wrote it on Windows with CRLF, or
 * in an editor that stamped a UTF-8 BOM — and the plugin's job is to edit the
 * prose, not to reformat the file. Reading normalises everything (that is what
 * `parseMarkdown` and the channel do, and the panel must never see a `\r`), so
 * the style has to travel separately: detection happens on the bytes read, and
 * the write door re-serialises the normalised payload in the style that was
 * detected.
 *
 * The rule is deliberately the same one the frontmatter patcher uses
 * (`lineTerminator` in `frontmatter.ts`): the **first** terminator decides. A file
 * with mixed endings has no single right answer — it can only be "mostly CRLF" or
 * "mostly LF" — and pretending otherwise would mean preserving per-line history
 * across an edit that replaces the whole body as one string.
 */

/** The two terminators a chapter file may use. */
export type EolStyle = 'lf' | 'crlf'

/** How a file is written: terminator plus a leading BOM. */
export interface TextStyle {
  eol: EolStyle
  bom: boolean
}

/** What a **new** file gets: UTF-8, no BOM, LF (data-safety §2.6). */
export const LF_STYLE: TextStyle = { eol: 'lf', bom: false }

/** Read the style of a text that came straight from disk (raw, BOM and `\r` intact). */
export function detectTextStyle(text: string): TextStyle {
  const bom = text.startsWith('\uFEFF')
  const newline = text.indexOf('\n')
  const eol: EolStyle = newline > 0 && text[newline - 1] === '\r' ? 'crlf' : 'lf'
  return { eol, bom }
}

/**
 * Serialise a **normalised** payload (LF, no BOM) in `style`.
 *
 * The caller normalises first on purpose: `normalizeText` in `io.ts` is the one
 * place that keeps BOMs and stray `\r` out of the user's repository, and this
 * function must never be the only step a payload goes through. It is still
 * defensive about a `\r` it should not see, so a wrong call order cannot write
 * `\r\r\n` into a manuscript.
 */
export function applyTextStyle(text: string, style: TextStyle = LF_STYLE): string {
  const withoutBom = text.startsWith('\uFEFF') ? text.slice(1) : text
  const body = withoutBom.replace(/\r\n?/g, '\n')
  const terminated = style.eol === 'crlf' ? body.replace(/\n/g, '\r\n') : body
  return style.bom ? `\uFEFF${terminated}` : terminated
}
