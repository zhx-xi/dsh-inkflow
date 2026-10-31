/**
 * The book hub's Host half: the **no-session** projection of the workspace
 * registry (ADR-0010 D2/D3/D8).
 *
 * A root-scoped panel (`sidebar.panellist`) has no session, so `internal.ts`'s
 * "browser names a session, never a directory" chain cannot answer it. The
 * anchor for this channel is therefore the Host's own `workspaceRegistry`
 * (ADR-0010 D6): the request carries nothing, and every row is derived from a
 * `Workspace` the user already opened. Nothing here accepts a path.
 *
 * WHAT A ROW IS: the four-state gate verdict the workbench and the tools
 * already give, projected per registered workspace (ADR-0010 D2 → `inspectProject`).
 * The hub adds two facts the gate does not carry:
 *
 *   - `dirStatus` — `'ok'` / `'missing-dir'`, from `Workspace.status()` (a
 *     registered directory the user deleted or moved); such a row is never
 *     recreated and the registration is never removed automatically.
 *   - `counts` — volume/chapter totals read from the **committed** catalog
 *     (`chapters/index.json` + one file per volume). Deliberately NOT
 *     `readCatalog()`: that rescans every `.md` and parses its frontmatter,
 *     which for N books is exactly the first-paint cost ADR-0010 D8 caps. A
 *     missing or unreadable catalog leaves `counts` absent (unknown), and is
 *     never rebuilt here.
 *   - `semantic` — how much of that book is in OpenViking (`semanticCoverageOf`): the
 *     settings, the book's peer layer, the plugin's ledger and one read of the derived
 *     index's chapter rows. **Zero network**, on purpose: N books times one probe would be
 *     the same first-paint cost, and it would make the list slowest exactly when the
 *     server is down. The badge on the card is a projection of this field.
 *
 * WRITE DISCIPLINE: this module writes nothing. `inspectProject` is called with
 * `recreateIndexDir: false` (its only write path), the catalog files are only
 * read, `state.json` is not touched, and a missing directory is reported
 * instead of created. Tests assert it with a whole-tree hash (`hashTree`).
 *
 * COST (ADR-0010 D8): four judgments at a time, 2 s per book → that row becomes
 * `state:'timeout'` and is not retried, a 3 s budget for the whole answer →
 * `truncated:true`, and at most 200 rows → `capped:true` + the registry's
 * `total`. The limits are injected in `tests/hub-books.test.js` so the cost
 * tests are deterministic instead of sleeping for real seconds.
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import type { HostContext } from './context.js'
import { CATALOG_FILE, CHAPTERS_DIR, CONTENT_DIRS } from './conventions.js'
import { semanticCoverageOf } from './ovk-coverage.js'
import type { SemanticCoverage } from './ovk-coverage.js'
import { inspectProject } from './project.js'
import type { ProjectProbe, ProjectState, WorkspaceAction } from './project.js'
import { readSettings } from './settings.js'
import type { InkflowSettings } from './settings.js'

/** `/hub` is the segment after `/inkflow/internal`; the route table lives in routes.ts. */
export const HUB_SEGMENT = '/hub'

/** Judgments in flight at once (ADR-0010 D8). */
export const HUB_CONCURRENCY = 4

/** One book's verdict budget. Missing it produces a `timeout` row, no retry. */
export const HUB_BOOK_TIMEOUT_MS = 2_000

/** The whole answer's budget. Exhausting it returns the finished rows + `truncated`. */
export const HUB_TOTAL_BUDGET_MS = 3_000

/** Rows returned in one answer; beyond this the answer is `capped`. */
export const HUB_MAX_BOOKS = 200

/** `{ok:true,value}` payload of `GET /inkflow/internal/hub/books`. */
export type HubBooksValue = {
  pluginVersion: string
  /** Constant: the hub has no write route, and this flag says so at the wire. */
  readOnly: true
  /** The user's home directory, so the Client can render `~/…` without guessing. */
  home: string
  /** Registered workspaces after de-duplication (a book registered twice is one row). */
  total: number
  /** True when `total` exceeded the row cap and only `HUB_MAX_BOOKS` rows were judged. */
  capped: boolean
  /** True when rows are missing because of the cap or the time budget. */
  truncated: boolean
  books: HubBookRow[]
}

/** One registered workspace, judged (or timed out). */
export type HubBookRow = {
  /** Registry id when the Host exposes one; `null` otherwise. */
  workspaceId: string | null
  /** Canonical path (`fs.realpath`-normalised by the registry). Display data only. */
  path: string
  /** Registry title, else the directory name. */
  title: string
  /** The four-state gate verdict, or `'timeout'` when this book could not be judged. */
  state: HubBookState
  usable: boolean
  /** The gate's checklist (`inspectProject`), so the panel shows what the tools show. */
  missing: string[]
  actions: WorkspaceAction[]
  /** `'missing-dir'` for a registration whose directory is gone: shown, never repaired. */
  dirStatus: 'ok' | 'missing-dir'
  /** Committed catalog totals; absent when the catalog is missing or unreadable. */
  counts?: HubBookCounts
  /**
   * Semantic coverage of this book (local files only, no probe). Absent when this answer
   * cannot tell — a timed-out judgment, a directory that is gone, or a caller with no
   * `dataDir` — which is different from `state: 'unconfigured'` (`—`): that one is a fact.
   */
  semantic?: SemanticCoverage
  /** No `inkflow.json` and no content directory: a workspace that is not a book yet. */
  notABook?: true
  /** Extra registrations of the same canonical directory collapsed into this row. */
  duplicates?: number
}

export type HubBookCounts = { chapters: number; volumes: number }

/**
 * `'timeout'` is not a fifth gate state: it means "this answer has no verdict
 * for this book" (the judgment exceeded `bookTimeoutMs`, or threw). The next
 * refresh asks again, and there is no retry inside one answer.
 */
export type HubBookState = ProjectState | 'timeout'

export type HubBooksError = { code: 'HUB_UNAVAILABLE'; message: string; hint: string }

export type HubBooksResult = { ok: true; value: HubBooksValue } | { ok: false; error: HubBooksError }

/** Test seams (and future tuning). Production callers pass nothing. */
export interface HubBooksOptions {
  pluginVersion?: string
  /** Defaults to `inspectProject(root, { recreateIndexDir: false })`. */
  probe?: (root: string) => ProjectProbe | Promise<ProjectProbe>
  concurrency?: number
  bookTimeoutMs?: number
  budgetMs?: number
  limit?: number
  home?: string
  /**
   * Plugin state directory: the semantic coverage of each row is read from it (ledger +
   * settings) and nowhere else. Absent = rows carry no `semantic` field.
   */
  dataDir?: string
  /** Full override of the coverage read, so a cost test never touches the disk. */
  coverage?: (root: string) => SemanticCoverage
}

/**
 * A registry entry, narrowed to what a row (or an anchor lookup) needs.
 *
 * This is the hub channel's ONLY trust anchor (ADR-0010 D6), so the reader is
 * exported: `hub-wizard.ts` resolves the anchor with the same list the book
 * rows come from. Two readers of the registry would be two answers to "is this
 * directory a book the user already has".
 */
export interface HubWorkspaceEntry {
  id?: string
  path: string
  title?: string
  status?: () => string
}

/** A registry entry after de-duplication: `duplicates` counts the collapsed extras. */
interface CollapsedWorkspace extends HubWorkspaceEntry {
  duplicates?: number
}

const UNAVAILABLE: HubBooksError = {
  code: 'HUB_UNAVAILABLE',
  message: 'the Host exposes no workspace registry, so the book list cannot be named',
  hint: 'this profile has no workspace registry service; open the book from a session with the InkFlow workbench instead',
}

/**
 * Project the registered workspaces into book rows.
 *
 * Never throws: a missing Host service answers `HUB_UNAVAILABLE` (HTTP 200 +
 * `ok:false` — "cannot answer", not a transport failure), and a book whose
 * judgment throws becomes a `timeout` row.
 */
export async function buildHubBooks(ctx: HostContext, options: HubBooksOptions = {}): Promise<HubBooksResult> {
  const listed = listRegisteredWorkspaces(ctx)
  if (listed === undefined) return { ok: false, error: UNAVAILABLE }

  const entries = collapseDuplicates(listed)
  const limit = Math.max(1, options.limit ?? HUB_MAX_BOOKS)
  const capped = entries.length > limit
  const selected = entries.slice(0, limit)

  const probe = options.probe ?? ((root: string) => inspectProject(root, { recreateIndexDir: false }))
  const settings = {
    probe,
    concurrency: Math.max(1, options.concurrency ?? HUB_CONCURRENCY),
    bookTimeoutMs: Math.max(1, options.bookTimeoutMs ?? HUB_BOOK_TIMEOUT_MS),
    deadline: Date.now() + Math.max(1, options.budgetMs ?? HUB_TOTAL_BUDGET_MS),
    coverage: coverageReader(options),
  }
  const judged = await collect(selected, settings)
  const books = judged.filter((row): row is HubBookRow => row !== undefined)

  return {
    ok: true,
    value: {
      pluginVersion: options.pluginVersion ?? 'unknown',
      readOnly: true,
      home: options.home ?? homeDirectory(),
      total: entries.length,
      capped,
      truncated: capped || books.length < selected.length,
      books,
    },
  }
}

// ---------------------------------------------------------------------------
// The semantic badge's data source
// ---------------------------------------------------------------------------

/**
 * How one row's coverage is read, or a function that answers `undefined`.
 *
 * The settings file is read ONCE for the whole list (lazily, on the first book that needs
 * it) because it is the same file for every row; the ledger and the peer layer are per book
 * by definition. `undefined` for a caller with no `dataDir` keeps the row free of a field it
 * could not have computed — an absent badge is "this build cannot tell", never a verdict.
 */
function coverageReader(options: HubBooksOptions): (root: string) => SemanticCoverage | undefined {
  if (options.coverage !== undefined) return options.coverage
  const dataDir = options.dataDir
  if (dataDir === undefined) return () => undefined
  let settings: InkflowSettings | undefined
  return (root) => {
    settings ??= readSettings(dataDir).settings
    return semanticCoverageOf(root, { dataDir, settings })
  }
}

// ---------------------------------------------------------------------------
// The registry (the only trust anchor here: the request names nothing)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * `workspaceRegistry.list()` narrowed defensively.
 *
 * `undefined` = "this profile has no usable registry" (missing service, a
 * non-function `list`, or a call that throws). Every field is optional in
 * practice: a Host upgrade that renames `status()` must still list books.
 */
export function listRegisteredWorkspaces(ctx: HostContext): HubWorkspaceEntry[] | undefined {
  const raw = ctx.get('workspaceRegistry')
  const record = asRecord(raw)
  if (record === undefined || typeof record['list'] !== 'function') return undefined

  let listed: unknown
  try {
    listed = (record['list'] as () => unknown).call(raw)
  } catch {
    return undefined
  }
  if (!Array.isArray(listed)) return undefined

  const entries: HubWorkspaceEntry[] = []
  for (const item of listed) {
    const workspace = asRecord(item)
    if (workspace === undefined) continue
    const path = nonEmptyString(workspace['path'])
    if (path === undefined) continue
    const id = nonEmptyString(workspace['id'])
    const title = nonEmptyString(workspace['title'])
    const status = workspace['status']
    entries.push({
      path,
      ...(id === undefined ? {} : { id }),
      ...(title === undefined ? {} : { title }),
      // `Workspace.status()` is a method on the registry entity: keep its `this`.
      ...(typeof status === 'function' ? { status: () => (status as () => unknown).call(item) as string } : {}),
    })
  }
  return entries
}

/**
 * One row per canonical directory (review focus 2): a directory
 * registered twice — or reached through two spellings of the same path on
 * Windows — must not appear as two books. The first registration wins and the
 * extras are counted (`duplicates`), because dropping them silently would hide
 * a registry the user can see in the sidebar.
 */
function collapseDuplicates(entries: readonly HubWorkspaceEntry[]): CollapsedWorkspace[] {
  const seen = new Map<string, number>()
  const unique: CollapsedWorkspace[] = []
  const duplicated: number[] = []
  for (const entry of entries) {
    const key = pathKey(entry.path)
    const index = seen.get(key)
    if (index === undefined) {
      seen.set(key, unique.length)
      unique.push({ ...entry })
      duplicated.push(0)
      continue
    }
    duplicated[index] = (duplicated[index] ?? 0) + 1
  }
  return unique.map((entry, index) => {
    const duplicates = duplicated[index] ?? 0
    return duplicates === 0 ? entry : { ...entry, duplicates }
  })
}

/** Path identity for de-duplication: Windows compares case-insensitively. */
function pathKey(path: string): string {
  const normalised = path.replaceAll('\\', '/').replace(/\/+$/u, '')
  return process.platform === 'win32' ? normalised.toLowerCase() : normalised
}

function homeDirectory(): string {
  // Same order as `project.ts` (`checkProjectRootScope`): HOME wins on POSIX,
  // USERPROFILE on Windows, and the OS account directory is the fallback.
  return process.env['HOME'] ?? process.env['USERPROFILE'] ?? homedir()
}

// ---------------------------------------------------------------------------
// The per-book judgment
// ---------------------------------------------------------------------------

interface CollectSettings {
  probe: (root: string) => ProjectProbe | Promise<ProjectProbe>
  concurrency: number
  bookTimeoutMs: number
  /** `Date.now()` deadline for the whole answer. */
  deadline: number
  /**
   * The book's semantic coverage, or `undefined` when this answer cannot tell (`dataDir`
   * absent). Injected so the cost tests can decide it, exactly like `probe`.
   */
  coverage: (root: string) => SemanticCoverage | undefined
}

/**
 * Judge every entry with at most `concurrency` judgments in flight, filling a
 * slot per registry index so the row order stays the registry's order. A spent
 * budget leaves the remaining slots empty — the caller reports `truncated`.
 */
async function collect(
  entries: readonly CollapsedWorkspace[],
  settings: CollectSettings,
): Promise<(HubBookRow | undefined)[]> {
  const rows: (HubBookRow | undefined)[] = new Array(entries.length).fill(undefined)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (Date.now() >= settings.deadline) return
      const index = next
      next += 1
      if (index >= entries.length) return
      const entry = entries[index]
      if (entry === undefined) return
      rows[index] = await judgeBook(entry, settings)
    }
  }
  const workers = Array.from({ length: Math.min(settings.concurrency, entries.length) }, worker)
  await Promise.all(workers)
  return rows
}

async function judgeBook(entry: CollapsedWorkspace, settings: CollectSettings): Promise<HubBookRow> {
  const base = {
    workspaceId: entry.id ?? null,
    path: entry.path,
    title: entry.title ?? basename(entry.path),
    dirStatus: directoryStatus(entry),
  } as const
  const duplicated = entry.duplicates === undefined ? {} : { duplicates: entry.duplicates }

  // A deleted directory cannot be judged and must not be recreated; the gate
  // would call it "needs setup" and hide the real problem (ADR-0010 D2).
  if (base.dirStatus === 'missing-dir') {
    return { ...base, ...duplicated, state: 'needs-setup', usable: false, missing: [], actions: [] }
  }

  const outcome = await raceProbe(entry.path, settings)
  if (outcome.kind === 'timeout') {
    return { ...base, ...duplicated, state: 'timeout', usable: false, missing: [], actions: [] }
  }

  const probe = outcome.value
  const counts = readCatalogCounts(entry.path)
  // The semantic badge: local files only (settings, the book's peer layer, the ledger, one
  // read of the index's chapter rows). It is deliberately computed here rather than by
  // probing, because 200 books times one HTTP request is the cost ADR-0010 D8 caps — and a
  // badge that costs a socket would make opening the book list slow exactly when a server
  // is down.
  const semantic = settings.coverage(entry.path)
  return {
    ...base,
    ...duplicated,
    state: probe.state,
    usable: probe.usable,
    missing: probe.missing,
    actions: probe.actions,
    ...(counts === undefined ? {} : { counts }),
    ...(semantic === undefined ? {} : { semantic }),
    ...(isNotABook(probe) ? { notABook: true as const } : {}),
  }
}

/** `Workspace.status()` when the Host exposes it, else one `stat`. */
function directoryStatus(entry: HubWorkspaceEntry): 'ok' | 'missing-dir' {
  if (entry.status !== undefined) {
    try {
      const status = entry.status()
      if (status === 'missing-dir') return 'missing-dir'
      if (status === 'ok') return 'ok'
    } catch {
      // A status() that cannot answer must not decide the row: fall back to stat.
    }
  }
  try {
    return statSync(entry.path).isDirectory() ? 'ok' : 'missing-dir'
  } catch {
    return 'missing-dir'
  }
}

type ProbeOutcome = { kind: 'done'; value: ProjectProbe } | { kind: 'timeout' }

/**
 * One judgment against the per-book deadline.
 *
 * The timer is `unref`ed so a timed-out judgment never keeps the process (or a
 * test run) alive waiting for it, and a probe that throws is reported as
 * `timeout`: both mean "this answer has no verdict for this book".
 */
async function raceProbe(root: string, settings: CollectSettings): Promise<ProbeOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<ProbeOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), settings.bookTimeoutMs)
    timer.unref?.()
  })
  const judged = Promise.resolve()
    .then(() => settings.probe(root))
    .then((value): ProbeOutcome => ({ kind: 'done', value }))
    .catch((): ProbeOutcome => ({ kind: 'timeout' }))
  try {
    return await Promise.race([judged, expired])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * A workspace with no meta and no content directory is not a broken book — it
 * is a directory the user opened in DSH (ADR-0010 D2). The row says so, and the
 * action belongs to the new-book wizard, which is why nothing here
 * initialises it.
 */
function isNotABook(probe: ProjectProbe): boolean {
  if (probe.state !== 'needs-setup' || probe.checks.meta) return false
  return CONTENT_DIRS.every((name) => probe.checks.dirs[name] !== true)
}

// ---------------------------------------------------------------------------
// Counts from the committed catalog (read-only, no rebuild)
// ---------------------------------------------------------------------------

function readJsonObject(file: string): Record<string, unknown> | undefined {
  let raw: string
  try {
    // Users edit these files with arbitrary Windows tools: a BOM must not make
    // the counts unreadable (same tolerance as every other reader here).
    raw = readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')
  } catch {
    return undefined
  }
  try {
    return asRecord(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/**
 * Volume/chapter totals from the committed catalog, or `undefined` when it is
 * missing, unreadable or half-present — "unknown" is honest, and a partial sum
 * would look like a real count. Nothing is scanned and nothing is rebuilt.
 */
function readCatalogCounts(root: string): HubBookCounts | undefined {
  const chaptersDir = join(root, CHAPTERS_DIR)
  const rootCatalog = readJsonObject(join(chaptersDir, CATALOG_FILE))
  if (rootCatalog === undefined) return undefined
  const volumes = rootCatalog['volumes']
  const loose = rootCatalog['looseChapters']
  if (!Array.isArray(volumes) || !Array.isArray(loose)) return undefined

  let chapters = loose.length
  for (const volume of volumes) {
    const record = asRecord(volume)
    const dir = record === undefined ? undefined : nonEmptyString(record['dir'])
    if (dir === undefined) return undefined
    const volumeCatalog = readJsonObject(join(chaptersDir, dir, CATALOG_FILE))
    const listed = volumeCatalog?.['chapters']
    if (!Array.isArray(listed)) return undefined
    chapters += listed.length
  }
  return { chapters, volumes: volumes.length }
}
