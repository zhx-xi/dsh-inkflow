/**
 * Minimal Markdown frontmatter reader.
 *
 * We do NOT pull a YAML dependency: the file contract only needs scalars,
 * inline arrays, block arrays and comments, and every rejected form degrades
 * to "unknown field preserved in the file, ignored by the index" — never a
 * crash. Keeping this in-house also keeps the plugin dependency-free.
 *
 * Supported value forms:
 *   key: plain text            -> "plain text"
 *   key: "quoted text"         -> "quoted text"
 *   key: 42 / 3.5              -> "42" / "3.5" (scalars stay strings)
 *   key: true / false          -> boolean
 *   key: null / ~              -> null
 *   key: [a, "b", 3]           -> string[]
 *   key:
 *     - a
 *     - b                      -> string[]
 *   key: value   # comment     -> "value" (the comment is dropped)
 */

export interface ParsedMarkdown {
  /** Parsed frontmatter. Empty object when the document has none. */
  data: Record<string, unknown>
  /** Body after the frontmatter block (text normalized to LF, as read). */
  body: string
  hasFrontmatter: boolean
  /**
   * Human-readable problems. They name a key, a line number and a byte offset
   * only — never the line text: these strings reach the derived index, the
   * tool output and the model, and prose must not travel that path
   * (data-safety §5).
   */
  issues: string[]
}

/**
 * A frontmatter block is metadata. Anything longer is either prose or a
 * pathological file, and both must be read as body (data-safety: never swallow
 * the author's text).
 */
const MAX_FRONTMATTER_BYTES = 4096

/** One line of the source, with the offsets needed to rewrite it in place. */
interface SourceLine {
  /** Line content without its terminator; a trailing `\r` is dropped. */
  text: string
  /** Char offset of the line start in the source text. */
  start: number
  /** Char offset just past the terminator (= the next line's start). */
  end: number
}

interface DocumentScan {
  lines: SourceLine[]
  /** Present only when a well-formed frontmatter block was found. */
  block?: { firstLine: number; closeLine: number }
  /** Why an opening `---` was not accepted as frontmatter. */
  rejected?: 'unclosed' | 'prose'
}

function splitSourceLines(text: string): SourceLine[] {
  const lines: SourceLine[] = []
  let start = 0
  for (;;) {
    const newline = text.indexOf('\n', start)
    if (newline === -1) {
      lines.push({ text: text.slice(start), start, end: text.length })
      return lines
    }
    const hasCr = newline > start && text[newline - 1] === '\r'
    lines.push({ text: text.slice(start, hasCr ? newline - 1 : newline), start, end: newline + 1 })
    start = newline + 1
  }
}

/** A BOM is common in files edited on Windows; it must not hide a block (H11). */
function isOpener(line: string): boolean {
  return /^\uFEFF?---[ \t]*$/.test(line)
}

/** Is this a closing delimiter? A line on its own, trailing space allowed. */
function isCloser(line: string): boolean {
  return /^---[ \t]*$/.test(line)
}

/**
 * Find the frontmatter block.
 *
 * `indexOf('\n---', 3)` used to accept any line *starting* with three dashes,
 * so a `----` rule or a `--- text` line in the prose closed the block early and
 * the first paragraph was parsed as metadata (and echoed into issue details).
 * A closer is therefore a line that is exactly `---` plus trailing space, and
 * only inside the first 4 KiB.
 *
 * When no such closer exists, or the candidate block holds content but not a
 * single `key:` line (i.e. it is prose that merely starts with a rule), the
 * answer is "no frontmatter": that only costs ignored metadata, while the
 * opposite mistake eats prose that can never be regenerated.
 */
function scanDocument(text: string): DocumentScan {
  const lines = splitSourceLines(text)
  const opener = lines[0]
  if (opener === undefined || !isOpener(opener.text)) return { lines }
  let consumed = Buffer.byteLength(text.slice(opener.start, opener.end), 'utf8')
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) break
    // Budget first: a chapter with a scene break 20 KB in stays a chapter.
    if (consumed >= MAX_FRONTMATTER_BYTES) return { lines, rejected: 'unclosed' }
    if (isCloser(line.text)) {
      const blockLines = lines.slice(1, index)
      const hasKeyLine = blockLines.some((candidate) => keyOfLine(candidate.text) !== undefined)
      const hasContent = blockLines.some((candidate) => stripInlineComment(candidate.text).trim() !== '')
      if (!hasKeyLine && hasContent) return { lines, rejected: 'prose' }
      return { lines, block: { firstLine: 1, closeLine: index } }
    }
    consumed += Buffer.byteLength(text.slice(line.start, line.end), 'utf8')
  }
  return { lines, rejected: 'unclosed' }
}

/**
 * Index of the `#` that starts a trailing comment, or -1.
 *
 * conventions.md's own examples put `# 可选` after a value, so keeping the whole
 * rest as the value polluted ids/volumes/statuses (`c-1   # inline comment`
 * became the id). A comment starts at line start or after whitespace — `c#1`
 * and URLs keep their `#` — and only outside quotes, so a title like
 * `"第 1 章 # 入山"` survives. Escapes follow the quote style: `\"` in double
 * quotes, `''` in single quotes.
 */
function findCommentStart(line: string): number {
  let quote: '"' | "'" | undefined
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote !== undefined) {
      if (quote === '"' && char === '\\') {
        index += 1 // skip the escaped character; it cannot close the string
        continue
      }
      if (char === quote) {
        if (line[index + 1] === quote) {
          index += 1 // `''` / `""` is an escaped quote, not two strings
          continue
        }
        quote = undefined
      }
      continue
    }
    if ((char === '"' || char === "'") && opensQuote(line, index)) {
      quote = char
      continue
    }
    if (char === '#' && (index === 0 || line[index - 1] === ' ' || line[index - 1] === '\t')) {
      return index
    }
  }
  return -1
}

/**
 * A quote opens a value only where a value can start — after `:`, a list dash,
 * `[` or `,`. Without this, `title: It's fine # note` would open a string at
 * the apostrophe and swallow the comment.
 */
function opensQuote(line: string, index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = line[cursor]
    if (char === ' ' || char === '\t') continue
    return char === ':' || char === '-' || char === '[' || char === ','
  }
  return true
}

function stripInlineComment(line: string): string {
  const at = findCommentStart(line)
  return at === -1 ? line : line.slice(0, at)
}

/** The content of a metadata line: comment and trailing whitespace removed. */
function contentOf(line: string): string {
  return stripInlineComment(line).replace(/[ \t]+$/, '')
}

/** The key on a frontmatter line, or undefined for list items/comments/prose. */
function keyOfLine(line: string): string | undefined {
  const content = contentOf(line)
  if (content.trim() === '') return undefined
  return /^([A-Za-z_][A-Za-z0-9_-]*):/.exec(content)?.[1]
}

/** The raw value text after `key:`, `''` for a `key:` block list. */
function valueOfLine(line: string): string | undefined {
  return /^[A-Za-z_][A-Za-z0-9_-]*:[ \t]*([\s\S]*)$/.exec(contentOf(line))?.[1]
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if (first === '"' && last === '"') {
      return value.slice(1, -1).replace(/\\(["\\])/g, '$1')
    }
    if (first === "'" && last === "'") {
      return value.slice(1, -1).replace(/''/g, "'")
    }
  }
  return value
}

function parseScalar(raw: string): unknown {
  const value = raw.trim()
  if (value === '' || value === 'null' || value === '~') return null
  if (value === 'true') return true
  if (value === 'false') return false
  // Numbers stay strings on purpose. `id: 001` and `id: 1` are two different
  // ids in the author's files; turning them into 1 and 1 made them collide on
  // the index PRIMARY KEY and bricked every read. Fields that really are
  // numbers (`seq`, `order`) go through intField, which accepts numeric strings.
  return stripQuotes(value)
}

function splitInlineArray(raw: string): unknown[] {
  const inner = raw.trim().slice(1, -1).trim()
  if (inner === '') return []
  return inner
    .split(',')
    .map((part) => parseScalar(part))
    .filter((part) => part !== null || inner.includes('null'))
}

/** What a patch did, so a caller can report it instead of guessing. */
export interface FrontmatterPatchResult {
  /** The rewritten document; identical to the input when nothing applied. */
  text: string
  /** Keys whose existing line was rewritten, in the order given. */
  replaced: string[]
  /** Keys inserted at the end of the block, in the order given. */
  appended: string[]
  /** Keys not written because the document has no frontmatter block. */
  skipped: string[]
}

/** The line terminator of `line`, or the document's usual one at EOF. */
function lineTerminator(text: string, line: SourceLine): string {
  const terminator = text.slice(line.start + line.text.length, line.end)
  if (terminator !== '') return terminator
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * Values that would not survive a round trip through `parseScalar`: an empty
 * value turns `key:` into an empty block list, and a plain scalar cannot start
 * with `#`/`[`/a quote/`-`, carry edge whitespace, spell a YAML keyword, or
 * contain ` #` (which the parser would read as a comment).
 */
function needsQuoting(value: string): boolean {
  if (value === '') return true
  if (value !== value.trim()) return true
  if (value === 'null' || value === 'true' || value === 'false' || value === '~') return true
  if (/^[#\[\]"'-]/.test(value)) return true
  return value.includes(' #')
}

/** Render a value in the given quote style, escaping what that style needs. */
function quotedValue(value: string, quote: '"' | "'"): string {
  if (quote === '"') return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return `'${value.replace(/'/g, "''")}'`
}

function renderScalar(value: string): string {
  return needsQuoting(value) ? quotedValue(value, '"') : value
}

/**
 * Rewrite one `key: value   # comment` line, keeping everything around the
 * value: the key's own spacing, the author's quote style and the comment.
 */
function rewriteKeyLine(line: string, value: string): string {
  const commentAt = findCommentStart(line)
  const head = commentAt === -1 ? line : line.slice(0, commentAt)
  const tail = commentAt === -1 ? '' : line.slice(commentAt)
  const trimmed = head.replace(/[ \t]+$/, '')
  // The whitespace that separated the value from its comment belongs to the
  // comment, not to the value.
  const gap = head.slice(trimmed.length)
  const match = /^([A-Za-z_][A-Za-z0-9_-]*:)([ \t]*)([\s\S]*)$/.exec(trimmed)
  if (match === null) return line
  const keyPart = match[1] ?? ''
  const spaces = match[2] ?? ''
  const rawValue = match[3] ?? ''
  // `key:` (a block list) keeps no space after the colon, but `key:value` is
  // not a mapping in YAML. Adding one space is the smallest correction that
  // turns the line into a scalar.
  const separator = spaces === '' && rawValue === '' ? ' ' : spaces
  const quote = rawValue.startsWith('"') ? '"' : rawValue.startsWith("'") ? "'" : undefined
  const rendered = quote === undefined ? renderScalar(value) : quotedValue(value, quote)
  return `${keyPart}${separator}${rendered}${gap}${tail}`
}

/**
 * Rewrite the values of `entries` in a Markdown document.
 *
 * This is a line-level patch on purpose: parsing into `data` and serialising it
 * back would drop comments, unknown fields, key order and quote styles — i.e.
 * silently rewrite the author's file (the P1 proposal writer builds on this).
 * Only the targeted lines are touched; a new key is appended at the end of the
 * block; the body is never rewritten, so a body that starts with a `---` rule
 * cannot be confused with the block.
 *
 * Returns the new text instead of writing it: the function stays pure (easy to
 * test, no partial file on error) and the caller does the atomic
 * temp-file-plus-rename needed by data-safety §2.1 — the same split as
 * `writeState` in state.ts.
 */
export function patchFrontmatter(
  text: string,
  entries: Readonly<Record<string, string>>,
): FrontmatterPatchResult {
  const keys = Object.keys(entries)
  const scan = scanDocument(text)
  const closeLine = scan.block === undefined ? undefined : scan.lines[scan.block.closeLine]
  if (scan.block === undefined || closeLine === undefined) {
    return { text, replaced: [], appended: [], skipped: keys }
  }

  // Last assignment wins, matching the parser: patching a duplicate key must
  // update the line the index actually read.
  const keyLines = new Map<string, number>()
  for (let index = scan.block.firstLine; index < scan.block.closeLine; index += 1) {
    const line = scan.lines[index]
    const key = line === undefined ? undefined : keyOfLine(line.text)
    if (key !== undefined) keyLines.set(key, index)
  }

  const edits: Array<{ start: number; end: number; text: string }> = []
  const replaced: string[] = []
  const appended: string[] = []
  const eol = lineTerminator(text, closeLine)
  let insertion = ''

  for (const key of keys) {
    // A key the parser could never read back (`a b: x`) would corrupt the file
    // silently; refuse it at the boundary.
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      throw new TypeError(`patchFrontmatter: "${key}" is not a valid frontmatter key`)
    }
    const value = entries[key] ?? ''
    // A newline would end the line early and split the block in half; refuse
    // loudly rather than write a file the parser cannot read back.
    if (/[\r\n]/.test(value)) {
      throw new TypeError(`patchFrontmatter: the value of "${key}" must be a single line`)
    }
    const target = keyLines.get(key)
    if (target === undefined) {
      insertion += `${key}: ${renderScalar(value)}${eol}`
      appended.push(key)
      continue
    }
    const line = scan.lines[target]
    if (line === undefined) continue
    // `key:` followed by `- item` lines: those items *are* the value, so a
    // scalar replacement has to remove them or they are left orphaned.
    let end = line.end
    if (valueOfLine(line.text) === '') {
      for (let cursor = target + 1; cursor < scan.block.closeLine; cursor += 1) {
        const item = scan.lines[cursor]
        if (item === undefined || !/^\s*-(\s|$)/.test(item.text)) break
        end = item.end
      }
    }
    edits.push({
      start: line.start,
      end,
      text: `${rewriteKeyLine(line.text, value)}${lineTerminator(text, line)}`,
    })
    replaced.push(key)
  }

  if (insertion !== '') {
    edits.push({ start: closeLine.start, end: closeLine.start, text: insertion })
  }

  // Splice from the end so the offsets collected above stay valid.
  let output = text
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
  }
  return { text: output, replaced, appended, skipped: [] }
}

export function parseMarkdown(text: string): ParsedMarkdown {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const scan = scanDocument(normalized)
  const closeIndex = scan.block?.closeLine
  const close = closeIndex === undefined ? undefined : scan.lines[closeIndex]
  if (scan.block === undefined || close === undefined) {
    // Never swallow prose: an opener we cannot close means "this file has no
    // frontmatter", and the caller keeps every byte as body.
    const issues =
      scan.rejected === 'unclosed'
        ? [`frontmatter opened with --- but no closing --- within the first ${MAX_FRONTMATTER_BYTES} bytes`]
        : []
    return { data: {}, body: normalized, hasFrontmatter: false, issues }
  }

  const data: Record<string, unknown> = {}
  const issues: string[] = []
  let pendingKey: string | undefined

  // Byte offsets point the reader at a line without quoting it. They are
  // measured in the normalized text (LF), which is what the author sees.
  const firstLine = scan.lines[scan.block.firstLine]
  let byteOffset = firstLine === undefined ? 0 : Buffer.byteLength(normalized.slice(0, firstLine.start), 'utf8')
  for (let index = scan.block.firstLine; index < scan.block.closeLine; index += 1) {
    const line = scan.lines[index]
    if (line === undefined) break
    const lineByte = byteOffset
    byteOffset += Buffer.byteLength(normalized.slice(line.start, line.end), 'utf8')
    const lineNumber = index + 1 // 1-based: the opening `---` is line 1

    const content = contentOf(line.text)
    if (content.trim() === '') continue

    const itemMatch = /^\s*-\s+(.*)$/.exec(content)
    if (itemMatch !== null) {
      if (pendingKey === undefined) {
        issues.push(`array item without a key at line ${lineNumber} (byte ${lineByte})`)
        continue
      }
      const current = data[pendingKey]
      const list = Array.isArray(current) ? current : []
      list.push(parseScalar(itemMatch[1] ?? ''))
      data[pendingKey] = list
      continue
    }

    const kvMatch = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(content)
    if (kvMatch === null) {
      issues.push(`unparsed frontmatter line at line ${lineNumber} (byte ${lineByte})`)
      continue
    }
    const key = kvMatch[1] as string
    const rest = (kvMatch[2] ?? '').trim()
    if (rest === '') {
      pendingKey = key
      data[key] = []
      continue
    }
    pendingKey = undefined
    if (rest.startsWith('[') && rest.endsWith(']')) {
      data[key] = splitInlineArray(rest)
    } else {
      data[key] = parseScalar(rest)
    }
  }

  return { data, body: normalized.slice(close.end), hasFrontmatter: true, issues }
}

/** Read a string field, tolerating numbers (e.g. `seq: 3`). */
export function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/** Read an integer field, tolerating numeric strings. */
export function intField(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key]
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim())
  return undefined
}

/**
 * Read a boolean field.
 *
 * `parseScalar` turns a bare `true`/`false` into a boolean; a quoted `"true"`
 * stays a string (the author asked for a literal, and the index must not
 * disagree with the file about whether a foreshadow is resolved).
 */
export function boolField(data: Record<string, unknown>, key: string): boolean {
  const value = data[key]
  return value === true || value === 'true'
}

/** Read a string array field, accepting a single scalar as a one-element array. */
export function stringArrayField(data: Record<string, unknown>, key: string): string[] {
  const value = data[key]
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item : String(item ?? ''))).filter((s) => s !== '')
  }
  if (typeof value === 'string' && value !== '') return [value]
  return []
}
