/**
 * Entity mentions (#29, roadmap M18 / data-model §4.2).
 *
 * The manuscript names the setting library all the time — 清音 walks in, 白鹤门
 * raises its gate — and until this table existed none of it was indexed, so
 * "which chapters would a rename touch", "who has dropped out of the story" and
 * "what does this chapter actually pull in" could only be answered by a model
 * guessing at prose. `entity_mentions` turns those into one `SELECT`.
 *
 * Shape: one row per occurrence — `(entity_key, chapter_id, offset, source)` —
 * where `entity_key` is `kind:id`, the same address `entities` and `entities_fts`
 * use (X-1). Occurrences rather than "appeared: true" because an impact report
 * counts them and a jump-to-text needs a position; a chapter that says a name
 * twice is two places to look at.
 *
 * `source` says how strong the evidence is:
 *   `name`     the entity's own `title` occurs in the body
 *   `alias`    one of its `aliases` occurs in the body (a rename must revisit it)
 *   `explicit` the chapter's frontmatter declares it (`pov`), which is the
 *              author's own statement rather than a text match. There is no body
 *              position for it, so `offset` is negative.
 *
 * Not a domain module: `mentions` owns no content directory (it is absent from
 * `CONTENT_DIRS`), it is a cross-cutting scan over rows other domains produced.
 * The seam (`indexer.ts`) therefore calls it once, after the chapter domain has
 * already parsed the bodies — the scan never re-reads a file.
 *
 * Why these rows are **not** contributed as a `DomainTableRows` bucket, and why
 * they carry no `path` (the mechanism, not a preference):
 *
 *   `applyCandidate()` ([types.ts](./types.ts)) builds the post-write view of a
 *   table as "drop every row whose `path` equals the file being written, then append
 *   this file's rows". A mention row has no `path` — it is addressed by
 *   `(entity_key, chapter_id, offset, source)` — so `String(row['path'] ?? '')` is
 *   `''` and never equals a real file path: the row is **kept**, not replaced, and
 *   the freshly parsed rows are appended beside it. The view then holds every
 *   chapter's pre-edit offsets next to the post-edit ones, which is exactly the
 *   drift an offset cannot survive: the first thing a jump-to-text consumer does is
 *   slice the body at that number. Offsets also cannot be repaired by the write,
 *   because `offset` is part of the primary key — `INSERT OR REPLACE` treats a moved
 *   occurrence as a *new* row, so a replace-by-path patch can never retire the old
 *   one.
 *
 *   `rowsOf()` ([scan-helpers.ts](./scan-helpers.ts)) adds a second reason: it
 *   reads one bucket per table (`tables.find`), so a per-file contribution — many
 *   buckets sharing one table name — would silently write only the first bucket's
 *   rows.
 *
 * Mentions cannot be per-file anyway: the automaton is built from every entity and
 * walks every chapter, so the whole table is one scan's output. It is therefore
 * computed and written whole by the seam, inside the same transaction as the
 * projection (`insertMentions`), and rebuilt — never patched — with the index.
 */

import { entityKey } from './entities.js'
import { foldChars } from './naming.js'
import type { DomainDatabase, DomainEntityRef, DomainTableRows } from './types.js'

/** The one table this module owns. */
export const MENTIONS_TABLE = 'entity_mentions'

export const MENTION_SOURCES = ['explicit', 'alias', 'name'] as const
export type MentionSource = (typeof MENTION_SOURCES)[number]

/**
 * Statements for the mentions table (#29; `INDEX_SCHEMA_VERSION` 3 → 4).
 *
 * The primary key is the natural one and includes `offset`: a chapter naming the
 * same entity twice is two rows, and the same offset can legitimately hold both a
 * `name` and an `alias` hit when a character's alias repeats its own name.
 * `(entity_key, chapter_id)` leads so "everything this entity is mentioned in"
 * is a single index range — that is the impact-report and rename-cascade query.
 */
export const MENTIONS_DDL: readonly string[] = [
  'CREATE TABLE entity_mentions (entity_key TEXT NOT NULL, chapter_id TEXT NOT NULL, offset INTEGER NOT NULL, source TEXT NOT NULL, PRIMARY KEY (entity_key, chapter_id, offset, source))',
  // The other direction — "who appears in this chapter" (the chapter panel, and
  // the 掉线 comparison that reads a chapter's cast) — scans by chapter then
  // position, which the composite primary key cannot serve.
  'CREATE INDEX ix_entity_mentions_chapter ON entity_mentions(chapter_id, offset)',
]

export interface MentionRow {
  /** `kind:id`, the address in `entities` (X-1). */
  readonly entity_key: string
  readonly chapter_id: string
  /** Code-unit offset into the chapter body; negative for a frontmatter mention. */
  readonly offset: number
  readonly source: MentionSource
}

/**
 * What the scan needs from a chapter: its identity, its **body** (frontmatter
 * already stripped by the chapter domain) and what its frontmatter declares.
 */
export interface MentionChapter {
  readonly id: string
  readonly body: string
  /** `pov` from frontmatter: an entity id, a `kind:id`, or a name. */
  readonly pov?: string
}

/** One pattern the automaton answers with. */
interface MentionPattern {
  readonly entityKey: string
  readonly source: 'name' | 'alias'
  /** Length in folded code points, so a match end can be turned into a start. */
  readonly length: number
}

/**
 * Aho–Corasick state machine over the folded patterns.
 *
 * Why an automaton and not "for each entity, `indexOf` the body": the DoD is 59
 * 万字 × ~2900 entities under 5 s, and the naive shape is text × entities — 1.7
 * billion comparisons. One automaton walks the manuscript once and reports every
 * pattern that ends at each position, so the cost is text plus the total pattern
 * length, independent of how many entities the book has.
 */
interface Automaton {
  readonly children: Array<Map<string, number>>
  readonly fail: number[]
  readonly out: number[][]
}

/** Node lookup that cannot silently invent a state (a missing node is a bug, not input). */
function kidsOf(children: Array<Map<string, number>>, node: number): Map<string, number> {
  const kids = children[node]
  if (kids === undefined) throw new Error(`automaton node ${String(node)} is missing`)
  return kids
}

function buildAutomaton(patternChars: readonly (readonly string[])[]): Automaton {
  const children: Array<Map<string, number>> = [new Map<string, number>()]
  const fail: number[] = [0]
  const out: number[][] = [[]]

  patternChars.forEach((chars, patternIndex) => {
    let node = 0
    for (const ch of chars) {
      const existing = kidsOf(children, node).get(ch)
      if (existing !== undefined) {
        node = existing
        continue
      }
      const created = children.length
      children.push(new Map<string, number>())
      fail.push(0)
      out.push([])
      kidsOf(children, node).set(ch, created)
      node = created
    }
    out[node]?.push(patternIndex)
  })

  // Breadth-first failure links; a node's outputs include its failure target's,
  // which is what makes "the longest suffix is also a pattern" work.
  const queue: number[] = [...kidsOf(children, 0).values()]
  let head = 0
  while (head < queue.length) {
    const node = queue[head] ?? 0
    head += 1
    for (const [ch, child] of kidsOf(children, node)) {
      let candidate = fail[node] ?? 0
      while (candidate !== 0 && !kidsOf(children, candidate).has(ch)) candidate = fail[candidate] ?? 0
      const target = kidsOf(children, candidate).get(ch)
      const resolved = target === undefined || target === child ? 0 : target
      fail[child] = resolved
      out[child] = [...(out[child] ?? []), ...(out[resolved] ?? [])]
      queue.push(child)
    }
  }

  return { children, fail, out }
}

/**
 * Everything the scan derives from `entities`, computed once per scan.
 *
 * Folding every name is not free and must not be repeated per chapter: a `pov`
 * lookup that re-folded 2900 titles for each of 2000 chapters would be the one
 * quadratic left in a scan that is otherwise linear in the manuscript.
 */
interface EntityScanIndex {
  readonly patterns: MentionPattern[]
  readonly patternChars: string[][]
  /** Folded name/alias → entity keys, for resolving a `pov` written as a name. */
  readonly byName: Map<string, string[]>
  /** Bare id or `kind:id` → entity keys, for resolving a `pov` written as an id. */
  readonly byId: Map<string, string[]>
}

function pushInto(map: Map<string, string[]>, key: string, value: string): void {
  if (key === '') return
  const existing = map.get(key)
  if (existing === undefined) map.set(key, [value])
  else if (!existing.includes(value)) existing.push(value)
}

/**
 * One pass over the projection: the automaton's patterns plus the two lookups a
 * frontmatter declaration can resolve against.
 *
 * An alias that only repeats the entity's own name (I-03 allows it) is not a
 * second way to be mentioned — one `name` row already covers it.
 *
 * **`kind === 'facts'` is skipped on purpose** (rework of PR #124, data-model §5 I-04). A
 * ledger entry has no name of its own: its `title` is the *subject's* display name, so
 * keeping it in the automaton counted every 清音 in the manuscript twice — once for
 * `characters:char-qingyin`, once for `facts:facts/char-qingyin.md` — and an impact report
 * or a rename would then revisit the same prose for a row that does not name anything
 * itself. The subject entity already covers that text; the ledger is reached through
 * `entities` and the ledger tools, which is what actually reads it.
 */
function indexEntities(entities: readonly DomainEntityRef[]): EntityScanIndex {
  const patterns: MentionPattern[] = []
  const patternChars: string[][] = []
  const byName = new Map<string, string[]>()
  const byId = new Map<string, string[]>()

  for (const entity of entities) {
    // A fact row's "name" is its subject's name: scanning it would double-count the very
    // occurrences the subject entity already reports.
    if (entity.kind === 'facts') continue
    const key = entityKey(entity)
    pushInto(byId, entity.id, key)
    pushInto(byId, key, key)

    const terms: Array<{ text: string; source: 'name' | 'alias' }> = [
      { text: entity.title.trim(), source: 'name' },
      ...(entity.aliases ?? []).map((alias) => ({ text: alias.trim(), source: 'alias' as const })),
    ]
    const seen = new Set<string>()
    for (const term of terms) {
      const chars = foldChars(term.text).chars
      const folded = chars.join('')
      if (folded === '' || seen.has(folded)) continue
      seen.add(folded)
      patterns.push({ entityKey: key, source: term.source, length: chars.length })
      patternChars.push(chars)
      pushInto(byName, folded, key)
    }
  }

  return { patterns, patternChars, byName, byId }
}

/**
 * Which entities a chapter declares in its frontmatter (`pov`).
 *
 * Resolution order matters for reproducibility: an exact `kind:id` or bare id is
 * unambiguous and wins over a name, because an author who wrote an id meant that
 * row. Only when no id matches does the value get read as a name/alias, in which
 * case **every** entity carrying that name is reported — silently picking one
 * would invent a fact the file does not state.
 */
function explicitMentions(chapter: MentionChapter, index: EntityScanIndex): string[] {
  const declared = chapter.pov?.trim() ?? ''
  if (declared === '') return []
  const byId = index.byId.get(declared)
  if (byId !== undefined) return [...byId].sort()
  const folded = foldChars(declared).text
  if (folded === '') return []
  const byName = index.byName.get(folded)
  return byName === undefined ? [] : [...byName].sort()
}

/** Reading order for the rows, so a rebuild produces the same file every time. */
function compareRows(left: MentionRow, right: MentionRow): number {
  if (left.chapter_id !== right.chapter_id) return left.chapter_id < right.chapter_id ? -1 : 1
  if (left.offset !== right.offset) return left.offset - right.offset
  if (left.entity_key !== right.entity_key) return left.entity_key < right.entity_key ? -1 : 1
  return left.source < right.source ? -1 : left.source > right.source ? 1 : 0
}

/**
 * Every mention of every entity in every chapter body (#29).
 *
 * Pure: no filesystem, no database, no clock — which is what lets the DoD figure
 * be measured directly in a test rather than inferred from a timed rebuild.
 *
 * Entities include nearly every kind (X-1): an outline node's title can legitimately be
 * named in prose too, and "does the manuscript still reference this" is a question worth one
 * uniform answer. The cost of including them is nothing — a pattern added to the same
 * automaton — and narrowing the set later is a filter on `entities`, not a change here.
 * `facts` is the one exception, and it is not a narrowing of convenience: a ledger's `title`
 * is its subject's display name, so scanning it would report the same occurrence under two
 * entity keys (see `indexEntities`).
 */
export function scanMentions(
  chapters: readonly MentionChapter[],
  entities: readonly DomainEntityRef[],
): MentionRow[] {
  const index = indexEntities(entities)
  const automaton = buildAutomaton(index.patternChars)
  const patterns = index.patterns

  const rows: MentionRow[] = []
  // Two aliases of one entity can hit the same offset (清音 / 清音子): the table's
  // primary key would keep one row anyway, so the scan reports one row and the
  // write stays a plain insert.
  const seen = new Set<string>()

  for (const chapter of chapters) {
    for (const key of explicitMentions(chapter, index)) {
      rows.push({ entity_key: key, chapter_id: chapter.id, offset: -1, source: 'explicit' })
    }
    if (chapter.body === '') continue

    // Fold once per body, keeping the map back to the original code units.
    const { chars, offsets } = foldChars(chapter.body)
    let state = 0
    for (let cursor = 0; cursor < chars.length; cursor += 1) {
      const ch = chars[cursor] ?? ''
      while (state !== 0 && !kidsOf(automaton.children, state).has(ch)) state = automaton.fail[state] ?? 0
      state = kidsOf(automaton.children, state).get(ch) ?? 0
      const hits = automaton.out[state]
      if (hits === undefined || hits.length === 0) continue
      for (const patternIndex of hits) {
        const pattern = patterns[patternIndex]
        if (pattern === undefined) continue
        const offset = offsets[cursor - pattern.length + 1]
        if (offset === undefined) continue
        const dedupeKey = `${pattern.entityKey}\u0000${chapter.id}\u0000${String(offset)}\u0000${pattern.source}`
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)
        rows.push({
          entity_key: pattern.entityKey,
          chapter_id: chapter.id,
          offset,
          source: pattern.source,
        })
      }
    }
  }

  rows.sort(compareRows)
  return rows
}

/**
 * The chapter rows a scan produced, as the mentions scan reads them.
 *
 * `body` is what the chapter domain already parsed — the manuscript with the
 * frontmatter stripped — so nothing here re-reads a file (and a name that only
 * occurs in frontmatter is correctly not a body mention).
 */
export function chaptersOf(tables: readonly DomainTableRows[]): MentionChapter[] {
  const bucket = tables.find((table) => table.table === 'chapters')
  if (bucket === undefined) return []
  const chapters: MentionChapter[] = []
  for (const row of bucket.rows) {
    const id = typeof row['id'] === 'string' ? row['id'] : ''
    if (id === '') continue
    const body = typeof row['body'] === 'string' ? row['body'] : ''
    const pov = typeof row['pov'] === 'string' ? row['pov'] : undefined
    chapters.push(pov === undefined || pov.trim() === '' ? { id, body } : { id, body, pov })
  }
  return chapters
}

/** Write the mention rows inside the build transaction (the seam calls this once). */
export function insertMentions(db: DomainDatabase, rows: readonly MentionRow[]): void {
  if (rows.length === 0) return
  const insert = db.prepare(
    'INSERT OR REPLACE INTO entity_mentions (entity_key, chapter_id, offset, source) VALUES (?, ?, ?, ?)',
  )
  for (const row of rows) insert.run(row.entity_key, row.chapter_id, row.offset, row.source)
}
