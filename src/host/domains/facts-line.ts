/**
 * One fact ledger line: parse and render, as **one pair** (ADR-0013, data-model §3.5).
 *
 * Why a pair and not two independent functions: the line format is the file contract
 * of `facts/<subject>.md`, and a writer that escapes differently from the reader's
 * unescaper silently corrupts the ledger the next time it is read back. `parseFactLine`
 * and `renderFactLine` therefore live in one file, are the only two implementations, and
 * a round-trip test (`tests/facts.test.js`) pins `parse(render(parse(x))) === parse(x)`.
 *
 * The declared line shape (ADR-0013 §决策):
 *
 *   - attribute: 境界 | value: 筑基后期 | since: ch-0007 | chapterId: ch-0009 | source: text
 *
 *   * `- ` starts a fact, with up to three spaces of indentation (a list nested one
 *     level deeper still counts; anything deeper is a sub-list, not a fact);
 *   * segments are `key: value`, separated by `|`;
 *   * `attribute` and `value` are required, everything else is optional;
 *   * a missing `until` means "still true today"; a missing `source` means `manual`;
 *   * a literal `|` inside a value is written `\|`;
 *   * unknown keys are **kept**, never rejected (same policy as unknown frontmatter).
 *
 * The parser is deliberately silent about *semantics* (whether two intervals overlap,
 * whether a chapter id exists): those are invariants I-23 and belong to `facts-plan.ts`.
 * Keeping them apart is what lets the write path judge a candidate with the very same
 * rules a rebuild uses, without either half re-implementing the format.
 */

/** Keys the format gives a meaning to. Everything else is preserved verbatim. */
export const FACT_KEYS = ['attribute', 'value', 'since', 'until', 'chapterId', 'source'] as const
export type FactKnownKey = (typeof FACT_KEYS)[number]

/**
 * The `source` values the write tools accept (data-model §3.5).
 *
 * Read-back is looser on purpose: a file may already say `source: 手工` or anything
 * else the author typed, and the reader must not throw away what it cannot classify —
 * losing the author's word is worse than indexing an unknown one.
 */
export const FACT_SOURCES = ['text', 'manual', 'extract'] as const
export type FactSource = (typeof FACT_SOURCES)[number]
export const DEFAULT_FACT_SOURCE = 'manual'

/** One fact as the format expresses it. */
export interface FactLine {
  readonly attribute: string
  readonly value: string
  readonly since?: string
  readonly until?: string
  readonly chapterId?: string
  /** Always concrete: absent in the file → `manual` (ADR-0013 rule 2). */
  readonly source: string
  /**
   * Keys this module does not know, in the order they were written.
   *
   * Preserved because ADR-0013 rule 4 makes the ledger forward-compatible: a future
   * field must not be destroyed by a tool that predates it.
   */
  readonly extra: Readonly<Record<string, string>>
}

export type ParsedFactLine =
  | { readonly ok: true; readonly fact: FactLine }
  | {
      readonly ok: false
      /**
       * Why the line is not a fact. Never contains the line's own text: this string
       * reaches `validation_issues`, the tool output and the model, and the ledger may
       * hold the author's prose (data-safety §5).
       */
      readonly reason: string
    }

/** Up to three leading spaces, then `-`, then a space or end of line. */
const FACT_LINE_PREFIX = /^ {0,3}-(?:[ \t]|$)/u

/** Is this body line a fact *candidate*? A candidate that fails to parse is reported. */
export function isFactLine(line: string): boolean {
  return FACT_LINE_PREFIX.test(line)
}

/** Which of three things one body list item is (see {@link classifyFactLine}). */
export type FactLineVerdict =
  /** The first segment's key is a known key: hand it to {@link parseFactLine}. */
  | 'fact'
  /** A known key appears, but not first: the author meant a fact and mis-typed. Report it. */
  | 'malformed'
  /** Not fact-shaped at all: the author's prose. Silent, because a ledger *is* notes. */
  | 'prose'

/**
 * First `:` of a segment — and `：` too, but **only to find the key**.
 *
 * A Chinese IME produces `：` by default, and `- attribute：境界 | value：金丹` is unambiguously
 * a fact line written with the wrong colon. Reading it as prose would swallow the line without
 * a word, which is the one outcome worse than a warning: the author sees no fact *and* no hint.
 * Recognising the key token is not accepting the syntax — `parseFactLine` still refuses the
 * line, because the format (ADR-0013) is the ASCII colon.
 */
const KEY_TERMINATOR = /[:：]/u

/** The key token of one segment, or `undefined` when the segment starts with a colon or has none. */
function segmentKey(segment: string): string | undefined {
  const index = segment.search(KEY_TERMINATOR)
  if (index <= 0) return undefined
  return unescapePipe(segment.slice(0, index)).trim()
}

function isKnownKey(key: string | undefined): boolean {
  return key !== undefined && (FACT_KEYS as readonly string[]).includes(key)
}

/**
 * Is this list item a fact line, a spoiled fact line, or just prose (I-22)?
 *
 * Every `- ` item used to be a candidate, so an author's notebook — which is mostly prose and
 * tables under bullets (`- 差别在**换算比**：A 说 2:1…`, `- 正文：`D:\小说\…``) — was reported
 * line by line as `FACT_LINE_MALFORMED` and drowned the real findings: six ledger files of the
 * verification copy produced five false files' worth of warnings and one fact. The line's
 * *first key* is what separates the two worlds:
 *
 *   1. first segment's key is a known key → a fact line, parse it (a bad one is reported by
 *      {@link parseFactLine}, which is where "`value` is required" comes from);
 *   2. a known key appears later → the author meant a fact and wrote the first field wrong
 *      (`attrbiute: 境界 | value: 金丹`) → `malformed`, so the typo hint survives;
 *   3. otherwise → prose → `prose`, and no finding is produced at all.
 *
 * Note the asymmetry with {@link parseFactLine}: that one answers "is this a *valid* fact", this
 * one answers "did the author mean a fact". Reporting belongs to the second question.
 */
export function classifyFactLine(line: string): FactLineVerdict {
  if (!isFactLine(line)) return 'prose'
  const content = line.replace(/[\r\n]+$/u, '').replace(FACT_LINE_PREFIX, '')
  const segments = splitSegments(content)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
  if (segments.length === 0) return 'prose'
  const keys = segments.map((segment) => segmentKey(segment))
  if (isKnownKey(keys[0])) return 'fact'
  return keys.some((key) => isKnownKey(key)) ? 'malformed' : 'prose'
}

/**
 * Split on `|` that is **not** preceded by a backslash.
 *
 * A hand-rolled scan rather than a look-behind regex because the escape rule is the
 * contract: `\|` is a literal pipe, every other `|` is a separator, and "not guessing"
 * a reverse edit of an unescaped separator is exactly what ADR-0013 rule 3 asks for.
 */
function splitSegments(content: string): string[] {
  const segments: string[] = []
  let current = ''
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index] as string
    if (char === '\\' && content[index + 1] === '|') {
      // Keep the escape for the unescaper below; it must not split here.
      current += '\\|'
      index += 1
      continue
    }
    if (char === '|') {
      segments.push(current)
      current = ''
      continue
    }
    current += char
  }
  segments.push(current)
  return segments
}

/**
 * `\|` → `|`. Every other backslash sequence is left alone: the format defines one
 * escape, and inventing more would make a value's rendering depend on its content.
 */
function unescapePipe(value: string): string {
  return value.replace(/\\\|/gu, '|')
}

/** The reverse of the unescaper — the only place a written line gains a backslash. */
function escapePipe(value: string): string {
  return value.replace(/\|/gu, '\\|')
}

function trimmedOrUndefined(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Parse one body line.
 *
 * `extra` collects unknown keys in written order; a repeated key keeps its **last**
 * value, the same rule `parseMarkdown` applies to duplicate frontmatter keys, so the
 * reader and the writer agree about which of two identical keys is the real one.
 */
export function parseFactLine(line: string): ParsedFactLine {
  const withoutTerminator = line.replace(/[\r\n]+$/u, '')
  const prefix = FACT_LINE_PREFIX.exec(withoutTerminator)
  if (prefix === null) return { ok: false, reason: 'not a `- key: value | …` list item' }
  const content = withoutTerminator.slice(prefix[0].length)
  if (content.trim() === '') return { ok: false, reason: 'the list item declares no `key: value` segment' }

  const known = new Map<string, string>()
  const extra: Record<string, string> = {}
  for (const rawSegment of splitSegments(content)) {
    const segment = rawSegment.trim()
    // `a | | b` is tolerated: an empty segment carries no field, and refusing it would
    // make a trailing separator a data error rather than a typo.
    if (segment === '') continue
    const colon = segment.indexOf(':')
    if (colon <= 0) return { ok: false, reason: 'a segment is not `key: value`' }
    const key = unescapePipe(segment.slice(0, colon)).trim()
    const value = unescapePipe(segment.slice(colon + 1).trim())
    if (key === '') return { ok: false, reason: 'a segment has an empty key' }
    if ((FACT_KEYS as readonly string[]).includes(key)) known.set(key, value)
    else extra[key] = value
  }

  const attribute = trimmedOrUndefined(known.get('attribute') ?? '')
  if (attribute === undefined) return { ok: false, reason: '`attribute` is required' }
  const value = trimmedOrUndefined(known.get('value') ?? '')
  if (value === undefined) return { ok: false, reason: '`value` is required' }

  return {
    ok: true,
    fact: {
      attribute,
      value,
      ...optionalKey('since', known),
      ...optionalKey('until', known),
      ...optionalKey('chapterId', known),
      source: trimmedOrUndefined(known.get('source') ?? '') ?? DEFAULT_FACT_SOURCE,
      extra,
    },
  }
}

function optionalKey(key: FactKnownKey, known: ReadonlyMap<string, string>): Record<string, string> {
  const value = trimmedOrUndefined(known.get(key) ?? '')
  return value === undefined ? {} : { [key]: value }
}

/**
 * Render one fact back to a line — canonical key order, unknown keys last.
 *
 * Canonical order (`attribute` → `value` → `since` → `until` → `chapterId` → `source`)
 * is what makes two renderings of the same fact byte-identical, which the snapshot's
 * reproducibility criterion depends on. A missing optional key is omitted rather than
 * written empty: `until:` with nothing after it reads back as "no until", the same
 * meaning, but keeping it out makes the diff of an edit a single line.
 *
 * Unknown keys are a different case: their **empty value is data**.
 * `- attribute: 境界 | value: 金丹 | 备注:` parses to `extra['备注'] === ''`, and dropping
 * that on render broke the pair's only promise — `parse(render(parse(x)))` came back without
 * the key the file has, so anything that rewrites a ledger line silently ate a field the
 * author (or a newer version) wrote. The value is rendered as-is (`备注: `), which parses
 * back to the same empty string.
 */
export function renderFactLine(fact: FactLine): string {
  const segments: string[] = [
    `attribute: ${escapePipe(fact.attribute)}`,
    `value: ${escapePipe(fact.value)}`,
  ]
  const optional: ReadonlyArray<readonly [string, string | undefined]> = [
    ['since', fact.since],
    ['until', fact.until],
    ['chapterId', fact.chapterId],
    ['source', fact.source],
  ]
  for (const [key, value] of optional) {
    const trimmed = value === undefined ? undefined : trimmedOrUndefined(value)
    if (trimmed === undefined) continue
    segments.push(`${key}: ${escapePipe(trimmed)}`)
  }
  for (const [key, value] of Object.entries(fact.extra)) {
    // A blank key can never come from `parseFactLine` (it refuses one), so this only guards a
    // hand-built object — and rendering it would produce a line that cannot parse back.
    if (key.trim() === '') continue
    segments.push(`${escapePipe(key)}: ${escapePipe(value)}`)
  }
  return `- ${segments.join(' | ')}`
}
