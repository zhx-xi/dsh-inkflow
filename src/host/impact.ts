/**
 * The impact report for a setting-library entry (#34, conventions §5.6, roadmap X-15).
 *
 * 改设定 is the most expensive mistake a long-form author can make, and it is the
 * only one they cannot undo with a sentence: rename 白鹤门 and forty chapters still
 * say 白鹤门. So before the write, this module answers "what would this touch" —
 * and it answers it with five *different* sources, because the book holds five
 * different kinds of reference:
 *
 *   | reference              | where it lives                        | read from |
 *   |------------------------|---------------------------------------|-----------|
 *   | chapters that name it  | `entity_mentions` (#29)               | the index |
 *   | relations at either end| `relations.source` / `target`          | the index |
 *   | timeline events        | `participants` / `place`               | the files |
 *   | ledger entries         | `facts/<subject>.md`'s `subject`      | the files |
 *   | foreshadow links       | `foreshadowing.linkedEntities`        | the files |
 *
 * Why three of the five read files rather than the index: `facts` and
 * `foreshadowing` have no table yet (data-model §4.2 reserves them for #32/#31), and
 * `timeline_events` deliberately does not carry `place` (X-1 fixes that column set).
 * Reading the files is also what keeps this listing honest when the cache is
 * missing — the point of a report is to be *complete*, not to be fast.
 *
 * THIS MODULE WRITES NOTHING. Not a file, not `state.json`, and — unlike the
 * library read routes — not even an index rebuild: `checkIndexFreshness()` is the
 * pure-read verdict, and a stale cache is reported as `indexState` instead of being
 * silently replaced under the author's feet while they weigh a rename. The write
 * happens in `impact-write.ts`, once, after the author confirms.
 *
 * Addressing goes through the FILES, not through the index: `id` is resolved by the
 * same rule every domain uses (`frontmatter.id` when present, else the
 * project-relative path), so a listing still works on a book whose index has never
 * been built — and, more importantly, a *renamed* entry (whose id no longer equals
 * its path, ADR-0014) stays reachable without trusting the cache to still hold it.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

import type { ContentDir } from './conventions.js'
import { entityKey } from './domains/entities.js'
import { chaptersMentioning } from './domains/mentions-query.js'
import { listRelationsFor } from './domains/query.js'
import { isPortableSlug } from './domains/tool-support.js'
import { fingerprintProjectFile } from './file-cas.js'
import type { FileFingerprint } from './file-cas.js'
import { parseMarkdown, stringArrayField, stringField } from './frontmatter.js'
import { checkIndexFreshness } from './index-freshness.js'
import type { IndexFreshnessState } from './index-freshness.js'
import { LIBRARY_KINDS } from './library-view.js'
import type { LibrarySource } from './library-view.js'
import { checkSegment, isSingleLine } from './path-rules.js'

/** A plain JSON payload, the channel's envelope half. */
type JsonRecord = Record<string, unknown>

/** The kinds a rename can move: everything the library shows (X-7) — see `RENAME_REFUSED`. */
export const IMPACT_KINDS: readonly ContentDir[] = LIBRARY_KINDS

/**
 * Kinds whose file name is **not** an arbitrary label, so a rename would change
 * meaning rather than identity.
 *
 * `facts/<subject>.md`: the file name *is* the subject, and the ledger's lines are
 * about that subject. Renaming the file would silently re-subject every row, which
 * is a ledger decision (ADR-0013 / #32), not a file move. Refusing is better than
 * pinning an id that makes the file name and its subject disagree forever.
 */
const RENAME_REFUSED: Readonly<Record<string, string>> = {
  facts: '账本的文件名就是它的主体：改名等于改「这条事实说的是谁」，那是账本口径（#32），不是移动文件',
}

/**
 * Which frontmatter key carries the entity's display title, per kind.
 *
 * The projection has one `title` column, but the files spell it per kind
 * (`characters` uses `name`, `facts` uses `subject`); a rename that wrote `title`
 * into a character card would leave the display name untouched.
 */
const TITLE_FIELDS: Readonly<Record<string, string>> = {
  characters: 'name',
  world: 'title',
  outlines: 'title',
  foreshadowing: 'title',
  timeline: 'title',
  relations: 'title',
  facts: 'subject',
  library: 'title',
}

/** How deep a kind directory may nest (`world/<category>/`, `chapters/<vol>/`). */
const MAX_DEPTH = 4

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/** One chapter that names the entity — the row the dialog lists first. */
export interface ImpactChapterRow {
  chapterId: string
  title: string
  seq: number | null
  path: string
  mentions: number
  firstOffset: number | null
}

/** One relation edge touching the entity, with whicht end it is. */
export interface ImpactRelationRow {
  id: string
  path: string
  title: string
  role: 'source' | 'target' | 'both'
  /** The other end, so the author sees what the edge connects to. */
  other: string
  kind: string
  dir: string
}

/** One timeline event that references the entity as a participant or as its place. */
export interface ImpactEventRow {
  id: string
  path: string
  title: string
  worldTime: string | null
  role: 'participant' | 'place' | 'both'
}

/** One ledger file whose `subject` is the entity. */
export interface ImpactFactRow {
  path: string
  title: string
  subject: string
  lines: number
}

/** One foreshadow file that lists the entity in `linkedEntities`. */
export interface ImpactForeshadowRow {
  path: string
  id: string
  title: string
  status: string | null
}

/** What a rename *would* do — computed by the listing, executed by `impact-write.ts`. */
export interface ImpactRenamePlan {
  /** Current project-relative path = the file that moves. */
  from: string
  /** Where it would land (same directory, new file name). */
  to: string
  slug: string
  /** The new display title, or `null` when the rename leaves it alone. */
  title: string | null
  /** The id to pin into the moved file: always the CURRENT id (ADR-0014). */
  pinId: string
  targetExists: boolean
  /**
   * Codes that would refuse the rename; empty means it can run (§5.6).
   *
   * The same code set the write route answers 400 with — `KIND_NOT_RENAMEABLE`,
   * `SLUG_INVALID`, `TITLE_INVALID`, `RENAME_NO_CHANGE`, plus `TARGET_EXISTS` for
   * the 409 — so the dialog never shows "executable" for a request the write
   * would refuse.
   */
  blockers: string[]
}

export interface ImpactReport {
  kind: string
  /** The entity's id — unchanged by a rename, which is the whole point. */
  id: string
  path: string
  title: string
  /** `true` when the file already declares an `id:` that differs from its path. */
  pinnedId: boolean
  chapters: ImpactChapterRow[]
  relations: ImpactRelationRow[]
  events: ImpactEventRow[]
  facts: ImpactFactRow[]
  foreshadowing: ImpactForeshadowRow[]
  totals: {
    chapters: number
    mentions: number
    relations: number
    events: number
    facts: number
    foreshadowing: number
    total: number
  }
  /** The CAS baseline of the entity file: what the rename POST sends as `expected`. */
  fingerprint: FileFingerprint | null
  /** `false` = the mentions/relations halves cannot be answered (no readable index). */
  indexAvailable: boolean
  indexState: IndexFreshnessState
  /** Present only when the caller asked for a plan (`?slug=` / `?newTitle=`). */
  rename?: ImpactRenamePlan
}

/** A read/write route's answer: status + JSON envelope (`routes.ts` sends it as is). */
export interface ImpactReply {
  status: number
  body: JsonRecord
}

/** The two fields every payload here needs (`ChannelTarget` satisfies it). */
export type ImpactSource = LibrarySource

/** What `GET /impact` accepts. `id` wins over `title`; `newTitle` is the plan's display name. */
export interface ImpactRequest {
  kind: string
  id?: string
  title?: string
  slug?: string
  newTitle?: string
}

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

function ok(value: JsonRecord): JsonRecord {
  return { ok: true, value }
}

/** The one constructor of a refusal, so every answer on this route has the same envelope. */
export function refused(status: number, code: string, extra: JsonRecord = {}): ImpactReply {
  return { status, body: { ok: false, error: { code, ...extra } } }
}

function isImpactKind(value: string): value is ContentDir {
  return (IMPACT_KINDS as readonly string[]).includes(value)
}

/** `true` for a kind the impact routes accept (the eight library kinds). */
export function impactKindOf(value: string): ContentDir | undefined {
  return isImpactKind(value) ? value : undefined
}

/** Why this kind cannot be renamed, or `undefined` when it can (`impact-write.ts` asks). */
export function renameRefusal(kind: string): string | undefined {
  return RENAME_REFUSED[kind]
}

/** The frontmatter key a kind keeps its display name in (`impact-write.ts` writes it). */
export function titleFieldOf(kind: string): string {
  return TITLE_FIELDS[kind] ?? 'title'
}

// ---------------------------------------------------------------------------
// (kind, id | title) → one file, by scanning the kind directory
// ---------------------------------------------------------------------------

export interface ResolvedEntity {
  kind: ContentDir
  id: string
  path: string
  title: string
  /** `true` when the file declares an `id:` that is not its own path (a renamed entry). */
  pinnedId: boolean
}

type ResolveOutcome =
  | { ok: true; entity: ResolvedEntity }
  | { ok: false; reply: ImpactReply }
  | { ok: true; ambiguous: ResolvedEntity[] }

function readText(file: string): string | undefined {
  try {
    // Same reader contract as everywhere else: UTF-8, BOM tolerated (H11).
    return readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')
  } catch {
    return undefined
  }
}

/** Every `.md` under one kind directory, in a stable (sorted) order. */
function markdownFilesIn(root: string, kind: string, dir = kind, depth = 0, out: string[] = []): string[] {
  if (depth > MAX_DEPTH) return out
  let entries
  try {
    entries = readdirSync(join(root, ...dir.split('/')), { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const child = `${dir}/${entry.name}`
    // A symlink is not an entry the index would publish, and following one could
    // leave the content directory — the same rule `library-write.ts` applies.
    if (entry.isDirectory()) {
      markdownFilesIn(root, kind, child, depth + 1, out)
      continue
    }
    if (!entry.isFile()) continue
    if (extname(entry.name).toLowerCase() !== '.md') continue
    out.push(child)
  }
  out.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  return out
}

function titleOf(kind: string, path: string, data: Record<string, unknown>): string {
  const field = TITLE_FIELDS[kind] ?? 'title'
  const declared = stringField(data, field)
  if (declared !== undefined && declared.trim() !== '') return declared.trim()
  return basename(path).replace(/\.md$/u, '')
}

/** Every entity of one kind, as the files state them (no index involved). */
export function scanKindEntities(root: string, kind: ContentDir): ResolvedEntity[] {
  const entities: ResolvedEntity[] = []
  for (const path of markdownFilesIn(root, kind)) {
    const text = readText(join(root, ...path.split('/')))
    if (text === undefined) continue
    const data = parseMarkdown(text).data
    const declared = stringField(data, 'id')
    const id = declared === undefined || declared.trim() === '' ? path : declared.trim()
    entities.push({
      kind,
      id,
      path,
      title: titleOf(kind, path, data),
      pinnedId: id !== path,
    })
  }
  return entities
}

/** Case/space folding for title matching: `白云观` and `白云观 ` are the same name. */
function foldTitle(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').toLowerCase()
}

/**
 * `id` first (exact, then `\`/`./`-normalised, then as a **path**), then `title`
 * (exact, then substring).
 *
 * The path tier is what keeps a renamed entry addressable by where it lives now: a
 * pinned id is a *former* path, so "the file at `world/门派/云台观.md`" no longer
 * matches any id — the caller that just listed the tree (or read the panel's row)
 * has the path, and it must resolve to the entry carrying the old id.
 *
 * Substring title matches are reported **as candidates** rather than resolved: silently
 * picking the first of two 白云观 entries would print a confident impact list about
 * the wrong one, which is worse than asking.
 */
export function resolveEntity(root: string, kind: ContentDir, request: { id?: string; title?: string }):
  | { ok: true; entity: ResolvedEntity }
  | { ok: false; code: 'not-found' | 'ambiguous'; candidates?: ResolvedEntity[] } {
  const all = scanKindEntities(root, kind)
  const id = (request.id ?? '').trim()
  if (id !== '') {
    const normalized = id.replaceAll('\\', '/').replace(/^\.\//u, '')
    const hit =
      all.find((entity) => entity.id === id) ??
      all.find((entity) => entity.id === normalized) ??
      all.find((entity) => entity.path === normalized)
    if (hit !== undefined) return { ok: true, entity: hit }
    return { ok: false, code: 'not-found' }
  }

  const title = (request.title ?? '').trim()
  if (title === '') return { ok: false, code: 'not-found' }
  const folded = foldTitle(title)
  const exact = all.filter((entity) => foldTitle(entity.title) === folded)
  if (exact.length === 1) return { ok: true, entity: exact[0] as ResolvedEntity }
  if (exact.length > 1) return { ok: false, code: 'ambiguous', candidates: exact }
  const partial = all.filter((entity) => foldTitle(entity.title).includes(folded))
  if (partial.length === 1) return { ok: true, entity: partial[0] as ResolvedEntity }
  if (partial.length > 1) return { ok: false, code: 'ambiguous', candidates: partial }
  return { ok: false, code: 'not-found' }
}

// ---------------------------------------------------------------------------
// The three file-read reference sites
// ---------------------------------------------------------------------------

function timelineRows(root: string, id: string): ImpactEventRow[] {
  const rows: ImpactEventRow[] = []
  for (const path of markdownFilesIn(root, 'timeline')) {
    const text = readText(join(root, ...path.split('/')))
    if (text === undefined) continue
    const data = parseMarkdown(text).data
    const participant = stringArrayField(data, 'participants').includes(id)
    const place = (stringField(data, 'place') ?? '').trim() === id
    if (!participant && !place) continue
    rows.push({
      id: stringField(data, 'id')?.trim() || path,
      path,
      title: titleOf('timeline', path, data),
      worldTime: stringField(data, 'worldTime')?.trim() ?? null,
      role: participant && place ? 'both' : participant ? 'participant' : 'place',
    })
  }
  return rows
}

function factRows(root: string, id: string): ImpactFactRow[] {
  const rows: ImpactFactRow[] = []
  for (const path of markdownFilesIn(root, 'facts')) {
    const text = readText(join(root, ...path.split('/')))
    if (text === undefined) continue
    const parsed = parseMarkdown(text)
    if ((stringField(parsed.data, 'subject') ?? '').trim() !== id) continue
    rows.push({
      path,
      title: titleOf('facts', path, parsed.data),
      subject: id,
      // One `- attribute: …` line per fact (ADR-0013); the count is what the
      // author needs to see ("three facts about this entry would keep pointing at
      // the old name in the ledger's own vocabulary").
      lines: parsed.body.split('\n').filter((line) => /^\s*-\s+/u.test(line)).length,
    })
  }
  return rows
}

function foreshadowRows(root: string, id: string): ImpactForeshadowRow[] {
  const rows: ImpactForeshadowRow[] = []
  for (const path of markdownFilesIn(root, 'foreshadowing')) {
    const text = readText(join(root, ...path.split('/')))
    if (text === undefined) continue
    const data = parseMarkdown(text).data
    if (!stringArrayField(data, 'linkedEntities').includes(id)) continue
    rows.push({
      path,
      id: stringField(data, 'id')?.trim() || path,
      title: titleOf('foreshadowing', path, data),
      status: stringField(data, 'status')?.trim() ?? null,
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * What the rename would do, still without writing.
 *
 * Two rules the plan encodes, both taken from decisions already made elsewhere:
 *
 *   * **The target keeps the CURRENT directory.** For a world entry that directory
 *     is its `category`, and moving across categories is a different editorial
 *     action (with its own consequences for the world tree), not a rename.
 *   * **Only an explicit `slug` moves the file.** A title-only edit keeps the path —
 *     the same rule the library editor already follows (`library-write.ts`: a title
 *     edit does not rename the file, because for a file without `id:` the name *is*
 *     the id). Deriving a file name from the new title would turn "fix a typo in
 *     the display name" into a move nobody asked for.
 */
export function planRename(root: string, entity: ResolvedEntity, request: { slug?: string; newTitle?: string }): ImpactRenamePlan {
  const currentDir = entity.path.includes('/') ? entity.path.slice(0, entity.path.lastIndexOf('/')) : ''
  const currentSlug = basename(entity.path).replace(/\.md$/u, '')
  const rawSlug = (request.slug ?? '').trim()
  const proposedTitle = (request.newTitle ?? '').trim()
  const slug = rawSlug !== '' ? rawSlug : currentSlug
  const to = currentDir === '' ? `${slug}.md` : `${currentDir}/${slug}.md`

  const blockers: string[] = []
  if (RENAME_REFUSED[entity.kind] !== undefined) blockers.push('KIND_NOT_RENAMEABLE')
  // Two halves of one question — "will this name be written as is?" — and both
  // report `SLUG_INVALID`, because that is the code the write route answers with:
  //   * `isPortableSlug` says the name is one visible segment (no separator, no
  //     control byte, no leading dot the scanners would skip);
  //   * `checkSegment` is `io.ts`'s own rule, so `con` / `nul` / `COM1`, a
  //     trailing dot and an over-long name are refused **here**, in the preview,
  //     instead of turning into a `400 PATH_RESERVED` after the author confirmed.
  //     §5.6 reads "blockers empty means it can run": the preview owes the writer's
  //     answer, so it borrows the writer's rule rather than approximating it.
  if (!isPortableSlug(slug) || checkSegment(basename(to)) !== undefined) blockers.push('SLUG_INVALID')
  // A display name lands on one `key: value` line; a line break would silently
  // become a second frontmatter key.
  if (proposedTitle !== '' && !isSingleLine(proposedTitle)) blockers.push('TITLE_INVALID')
  // Case-insensitive on purpose: the target platform may be Windows (case-folding),
  // and two files differing only by case would be two entries the author cannot keep
  // apart — so "the name is taken" has to mean the folded name too.
  const taken = to !== entity.path && isTaken(join(root, ...to.split('/')), join(root, ...currentDir.split('/')))
  if (taken) blockers.push('TARGET_EXISTS')
  if (to === entity.path && proposedTitle === '') blockers.push('RENAME_NO_CHANGE')

  return {
    from: entity.path,
    to,
    slug,
    title: proposedTitle === '' ? null : proposedTitle,
    pinId: entity.id,
    targetExists: taken,
    blockers,
  }
}

/**
 * Does the target name already belong to another file?
 *
 * `existsSync` covers the current directory; the `readdir` comparison covers the
 * case-folded name on a case-insensitive filesystem, where `existsSync` would say
 * "taken" for the same reason but with a mention-or-not distinction the author
 * needs: writing into a file that already holds someone else's entry is how an
 * entry silently disappears.
 */
function isTaken(targetPath: string, directory: string): boolean {
  if (existsSync(targetPath)) return true
  const name = basename(targetPath).toLowerCase()
  try {
    return readdirSync(directory).some((entry) => entry.toLowerCase() === name)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// The listing
// ---------------------------------------------------------------------------

function totalsOf(report: Omit<ImpactReport, 'totals'>): ImpactReport['totals'] {
  const mentions = report.chapters.reduce((sum, row) => sum + row.mentions, 0)
  const totals = {
    chapters: report.chapters.length,
    mentions,
    relations: report.relations.length,
    events: report.events.length,
    facts: report.facts.length,
    foreshadowing: report.foreshadowing.length,
    total: 0,
  }
  totals.total = totals.chapters + totals.mentions + totals.relations + totals.events + totals.facts + totals.foreshadowing
  return totals
}

/** `GET /impact` — the whole report, read-only. */
export async function buildImpact(source: ImpactSource, version: string, request: ImpactRequest): Promise<ImpactReply> {
  const kind = (request.kind ?? '').trim()
  if (kind === '') return refused(400, 'KIND_REQUIRED', { param: 'kind', hint: `pass kind=<one of ${IMPACT_KINDS.join(', ')}>` })
  if (!isImpactKind(kind)) return refused(400, 'KIND_INVALID', { param: 'kind', value: kind, allowed: IMPACT_KINDS })

  const hasId = (request.id ?? '').trim() !== ''
  const hasTitle = (request.title ?? '').trim() !== ''
  if (!hasId && !hasTitle) {
    return refused(400, 'SELECTOR_REQUIRED', { hint: 'pass ?id=<entity id> or ?title=<name> to say which entry to inspect' })
  }

  const resolved = resolveEntity(source.root, kind, { id: request.id, title: request.title })
  if (!resolved.ok) {
    if (resolved.code === 'ambiguous') {
      return refused(400, 'TITLE_AMBIGUOUS', {
        title: (request.title ?? '').trim(),
        candidates: (resolved.candidates ?? []).map((entity) => ({ kind, id: entity.id, path: entity.path, title: entity.title })),
        hint: 'several entries match that name: pass `id` (the panel lists the candidates)',
      })
    }
    return refused(404, 'impact-entity-not-found', {
      kind,
      id: (request.id ?? '').trim(),
      title: (request.title ?? '').trim(),
      hint: 'list the tree with GET /library and use an id from its group',
    })
  }
  const entity = resolved.entity

  const freshness = checkIndexFreshness(source.root)
  // `entity_mentions` is keyed by `kind:id` (X-1): the same address `entities` and
  // `entities_fts` use, so nothing has to translate paths into keys here.
  const key = entityKey({ kind, id: entity.id, path: entity.path, title: entity.title })
  const mentionRows = chaptersMentioning(source.root, key)
  const relationRows = listRelationsFor(source.root, entity.id)
  const indexAvailable = mentionRows !== undefined && relationRows !== undefined

  const chapters: ImpactChapterRow[] = (mentionRows ?? []).map((row) => ({
    chapterId: row.chapterId,
    title: row.title === '' ? row.chapterId : row.title,
    seq: row.seq,
    path: row.path,
    mentions: row.mentions,
    firstOffset: row.firstOffset,
  }))

  const relations: ImpactRelationRow[] = (relationRows ?? []).map((edge) => {
    const isSource = edge.source === entity.id
    const isTarget = edge.target === entity.id
    return {
      id: edge.id,
      path: edge.path,
      title: edge.title,
      role: isSource && isTarget ? 'both' : isSource ? 'source' : 'target',
      other: isSource && !isTarget ? edge.target : edge.source,
      kind: edge.kind,
      dir: edge.dir,
    }
  })

  const base = {
    kind,
    id: entity.id,
    path: entity.path,
    title: entity.title,
    pinnedId: entity.pinnedId,
    chapters,
    relations,
    events: timelineRows(source.root, entity.id),
    facts: factRows(source.root, entity.id),
    foreshadowing: foreshadowRows(source.root, entity.id),
    fingerprint: fingerprintProjectFile(source.root, entity.path) ?? null,
    indexAvailable,
    indexState: freshness.state,
  }
  const report: ImpactReport = { ...base, totals: totalsOf(base) }

  const wantsPlan = (request.slug ?? '').trim() !== '' || (request.newTitle ?? '').trim() !== ''
  const value: JsonRecord = {
    pluginVersion: version,
    sessionId: source.sessionId,
    root: source.root,
    ...report,
  }
  if (wantsPlan) value['rename'] = planRename(source.root, entity, { slug: request.slug, newTitle: request.newTitle })
  return { status: 200, body: ok(value) }
}
