/**
 * The text helpers the seven quality gates share.
 *
 * Every one of them exists because two rules needed the same answer and a second copy would
 * drift: "which line is this offset on" (all line-anchored findings), "what counts as a
 * paragraph" (clichés, numbers, the ledger cross-check), "what is the last clause *with* its
 * terminator" (the hook rule — stripping the punctuation hides the very signal it looks for),
 * and "how many occurrences does this rate allow" (dashes, ellipses).
 *
 * Nothing here reads a file or a clock: the helpers are pure over the chapter text, which is
 * what lets the determinism test feed the same input twice.
 */

import type { FindingLocator } from './findings.js'
import { DEGENERATION } from './gate-vocabulary.js'
import type { GateInput } from './gate-vocabulary.js'

/**
 * Below this many characters a "per 1000 characters" ratio is arithmetic noise (one
 * 「的」 in 200 characters reads as 5/1000). The modifier density therefore starts here; a
 * chapter that short is already item 1's finding, so nothing is lost. The dash and ellipsis
 * rules do not need this floor: they carry an allowance of at least one per chapter.
 */
export const GATE_DENSITY_FLOOR = 1000

/** The chapter as the "whole file" locator: `chapter:<id>`. */
export function chapterLocator(input: GateInput): FindingLocator {
  return { kind: 'chapter', chapterId: input.chapter.id }
}

/** One line of the chapter file: `path#L<n>`. */
export function lineLocator(input: GateInput, line: number): FindingLocator {
  return { kind: 'path', path: input.chapter.path, line }
}

/** 1-based line of a character offset in the body. */
export function lineOf(body: string, index: number): number {
  let line = 1
  const end = Math.min(Math.max(index, 0), body.length)
  for (let at = 0; at < end; at += 1) if (body[at] === '\n') line += 1
  return line
}

export interface Paragraph {
  readonly line: number
  readonly text: string
}

/** Non-empty paragraphs with their starting line — the unit "same paragraph" means. */
export function paragraphsOf(body: string): Paragraph[] {
  const out: Paragraph[] = []
  let line = 1
  for (const raw of body.split('\n')) {
    const text = raw.trim()
    if (text !== '') out.push({ line, text })
    line += 1
  }
  return out
}

/** Sentences without their terminators; empty fragments dropped. Length statistics want this. */
export function sentencesOf(body: string): string[] {
  return body
    .split(/[。！？!?…]+/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '')
}

/**
 * The final clause **with its terminator**: everything after the second-to-last sentence
 * break. Keeping the terminator is the whole point — a chapter ending in 「？」 is a hook, and
 * splitting the punctuation away (which `sentencesOf` does, correctly, for length statistics)
 * would hide exactly the signal the hook rule looks for.
 */
export function finalClause(text: string): string {
  const terminators = new Set(['。', '！', '？', '!', '?', '…'])
  let last = -1
  let previous = -1
  const chars = [...text]
  for (let at = 0; at < chars.length; at += 1) {
    const char = chars[at]
    if (char === undefined || !terminators.has(char)) continue
    previous = last
    last = at
  }
  const start = previous >= 0 ? previous + 1 : 0
  return chars.slice(start).join('').trim()
}

/** Non-overlapping occurrences of a literal string. */
export function occurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let at = haystack.indexOf(needle)
  while (at >= 0) {
    count += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

export function charLength(text: string): number {
  return [...text].length
}

export function per1000(count: number, wordCount: number): number {
  return (count * 1000) / Math.max(1, wordCount)
}

/** One-decimal formatting, so a detail string stays byte-identical between runs. */
export function fixed(value: number, digits = 1): string {
  return value.toFixed(digits)
}

export function hanOnly(text: string): boolean {
  return /^[\u4e00-\u9fff]+$/u.test(text)
}

/**
 * What counts as a visible character: Han, Latin letters and digits. Punctuation and whitespace
 * are excluded because they are what a model produces *for free* while looping — a run of 「……」
 * is not a repeated sentence, and 「……」 is not a short sentence either.
 */
const VISIBLE = /[\u4e00-\u9fff\u3400-\u4dbfA-Za-z0-9]/gu

export function visibleLength(text: string): number {
  return text.match(VISIBLE)?.length ?? 0
}

/**
 * Replace every paired quoted span with spaces of the same length, so the line keeps its shape
 * (offsets and therefore line numbers stay valid) while its quoted content stops counting.
 */
export function maskQuoted(text: string): string {
  let out = text
  for (const source of DEGENERATION.quotedSpanSources) out = out.replace(new RegExp(source, 'gu'), (match) => ' '.repeat(match.length))
  return out
}

/** Drop paired quoted spans entirely: what is left is the narration around a line of dialogue. */
export function stripQuoted(text: string): string {
  let out = text
  for (const source of DEGENERATION.quotedSpanSources) out = out.replace(new RegExp(source, 'gu'), '')
  return out
}

/**
 * Whether `count` occurrences of something that costs `rate` per 1000 characters is too many
 * for *this* chapter.
 *
 * The rate is a density (0.6/千字 for dashes), but the unit a model actually works in is a
 * chapter (the skills used to say 「一章 0–1 处」, a different rule with a different
 * answer). Rounding the rate down and keeping a floor of one turns the configured ratio into
 * "one per 1667 characters, at least one" — so a 2500-character chapter with one dash is fine,
 * a 400-character chapter with one dash is not a punctuation problem, and neither needed a
 * second sentence in the skill. The skill now states the density and this floor, one source.
 */
export function exceedsAllowance(count: number, rate: number, wordCount: number): boolean {
  return count > Math.max(1, Math.floor((wordCount * rate) / 1000))
}
