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
 */

export interface ParsedMarkdown {
  /** Parsed frontmatter. Empty object when the document has none. */
  data: Record<string, unknown>
  /** Body after the frontmatter block (leading newline trimmed). */
  body: string
  hasFrontmatter: boolean
  /** Human-readable problems; the caller decides whether they are fatal. */
  issues: string[]
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
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

export function parseMarkdown(text: string): ParsedMarkdown {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) {
    return { data: {}, body: normalized, hasFrontmatter: false, issues: [] }
  }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) {
    return {
      data: {},
      body: normalized,
      hasFrontmatter: false,
      issues: ['frontmatter opened with --- but never closed'],
    }
  }
  const block = normalized.slice(4, end)
  const body = normalized.slice(end + 4).replace(/^\n/, '')

  const data: Record<string, unknown> = {}
  const issues: string[] = []
  let pendingKey: string | undefined

  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue

    const itemMatch = /^\s*-\s+(.*)$/.exec(line)
    if (itemMatch !== null) {
      if (pendingKey === undefined) {
        issues.push(`array item without a key: ${line.trim()}`)
        continue
      }
      const current = data[pendingKey]
      const list = Array.isArray(current) ? current : []
      list.push(parseScalar(itemMatch[1] ?? ''))
      data[pendingKey] = list
      continue
    }

    const kvMatch = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (kvMatch === null) {
      issues.push(`unparsed frontmatter line: ${line.trim()}`)
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

  return { data, body, hasFrontmatter: true, issues }
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

/** Read a string array field, accepting a single scalar as a one-element array. */
export function stringArrayField(data: Record<string, unknown>, key: string): string[] {
  const value = data[key]
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item : String(item ?? ''))).filter((s) => s !== '')
  }
  if (typeof value === 'string' && value !== '') return [value]
  return []
}
