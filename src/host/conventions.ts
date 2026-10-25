/**
 * The single source of truth for InkFlow's **file conventions**.
 *
 * 约定大于配置: these names are fixed on purpose. They are the project's
 * identity check — the plugin only treats a directory as an InkFlow project
 * when it is a git repo AND every required directory exists. Making them
 * configurable would require a registry/config file, which is exactly the
 * "configuration hell" this design avoids.
 *
 * If a name in here changes, docs/conventions.md MUST change in the same
 * commit. Code and contract are meant to be greppable against each other.
 */

/** Project metadata file at the repository root. */
export const ROOT_META_FILE = 'inkflow.json'

/** Derived-index directory (never hand-edited, never committed except .gitkeep). */
export const INDEX_DIR = 'index'
export const INDEX_DB_FILE = 'inkflow.db'

/**
 * Empty marker carried by **every** required directory (ADR-0006 D1).
 *
 * git does not track empty directories, so without it a fresh `git clone`
 * makes the directory disappear and the gate reports a complete book as broken.
 * "directory present but `.gitkeep` missing" therefore counts as structure
 * missing and lands in `needs-repair`.
 */
export const DIR_KEEP_FILE = '.gitkeep'

/**
 * Content directories every project must have (ADR-0006 D1: nine of them).
 * Each domain owns a first-level directory so the gate and every tool can prove
 * membership without guessing nest levels.
 */
export const CONTENT_DIRS = [
  'chapters',
  'characters',
  'world',
  'outlines',
  'foreshadowing',
  'timeline',
  'relations',
  'facts',
  'library',
] as const
export type ContentDir = (typeof CONTENT_DIRS)[number]

/** The chapter tree: the only directory whose immediate subdirectories are volumes. */
export const CHAPTERS_DIR = 'chapters' satisfies ContentDir

/**
 * The reference library (conventions §3.6): arbitrary files the author keeps for
 * reference. Named here because the import path (#37) copies an old manuscript into it,
 * and a literal directory name outside this file is what breaks the contract.
 */
export const LIBRARY_DIR = 'library' satisfies ContentDir

/**
 * Volume/chapter catalog file (ADR-0006 D6): one in `chapters/` for the volume
 * list plus loose chapters, and one in every volume directory for its chapters.
 * It is a committed **projection** of the `.md` files, not a second truth.
 */
export const CATALOG_FILE = 'index.json'

/** Version of the catalog file shape; a different value means "rebuild from `.md`". */
export const CATALOG_SCHEMA_VERSION = 1

/** The ten directories the gate requires: the nine content dirs plus `index/`. */
export const REQUIRED_DIRS = [...CONTENT_DIRS, INDEX_DIR] as const
export type RequiredDir = (typeof REQUIRED_DIRS)[number]

/**
 * Directories a **write target** may live under (ADR-0006 D1): the nine content
 * directories plus the derived `index/`.
 *
 * This is deliberately a different list from `CONTENT_DIRS`/`REQUIRED_DIRS`:
 * those describe what must *exist* for a project to be usable (a read-side
 * gate), while this describes where a writer may *create* a file. The four v2
 * directories are writable before the gate starts requiring them, so the writer
 * does not have to be revisited when the directory contract moves to nine.
 */
export const WRITE_DIRS = [
  'chapters',
  'characters',
  'world',
  'outlines',
  'foreshadowing',
  'timeline',
  'relations',
  'facts',
  'library',
  INDEX_DIR,
] as const
export type WriteDir = (typeof WRITE_DIRS)[number]

/**
 * The plugin's private state directory (ADR-0012): a dot-prefixed directory at the
 * book root that holds the recovery bin, migration backups and audit exports.
 *
 * Three properties it must keep, and why each is stated here rather than discovered:
 *
 *   * **Not a content directory** — it is deliberately absent from `CONTENT_DIRS` /
 *     `REQUIRED_DIRS`, so the gate never requires it and no domain scans it.
 *   * **Not in the index** — `walk()` in `indexer.ts` skips every dot entry, so
 *     nothing under here can drift into `files` / `entities` / the freshness
 *     baseline; that is a property of the walker, not a special case added later.
 *   * **Not in git** — `REQUIRED_GITIGNORE_LINES` carries `.inkflow/`, otherwise a
 *     deleted chapter would reappear as an untracked file under `trash/`.
 *
 * Writing is allowed only inside the subdirectories below, never in the directory
 * itself and never elsewhere under it.
 */
export const PRIVATE_STATE_DIR = '.inkflow'
/**
 * The six writable names under `.inkflow/` (roadmap X-18 widened this from three;
 * X-25 / ADR-0023 widened it again from four).
 *
 * `candidates/` holds the extract pipeline's unreviewed proposals (ADR-0017 D3): they
 * are work files, not derived artefacts, so a rebuild must not be able to sweep them
 * away — which is exactly why they are here instead of under `index/`.
 *
 * `proposals/` (#45), `jobs/` (#47) and `audit/` (#43's gate records) follow the same
 * rule: a piece of prose awaiting the author's decision, or a progress record a long
 * task must survive a restart with, is not rebuildable. `index/` is (ADR-0006 D2:
 * delete it and it comes back empty), so anything a rebuild would erase lives here.
 * The issue texts for #43/#47 named `index/audit/` and `index/jobs/`; X-25 overrides
 * them for exactly that reason.
 */
export const PRIVATE_STATE_SUBDIRS = ['trash', 'backup', 'audit', 'candidates', 'proposals', 'jobs'] as const
export type PrivateStateSubdir = (typeof PRIVATE_STATE_SUBDIRS)[number]

/**
 * The plugin-level shared library's four subdirectories (ADR-0007 C1), one per
 * `kind`. They live under `dataDir/shared` — outside every book — so the book hub
 * can browse them without touching a project (ADR-0010 D5).
 */
export const SHARED_KINDS = ['world', 'library', 'snippets', 'series'] as const
export type SharedKind = (typeof SHARED_KINDS)[number]

/**
 * The shared library's **derived** manifest (ADR-0007 C1): a rebuildable
 * projection of the four directories. The hub only reads it — writing it back is
 * the shared-library writer's job (#40).
 */
export const SHARED_INDEX_FILE = 'index.json'

/**
 * The `mode` values a `library/` card may carry (ADR-0007 C4, data-model §3.3).
 *
 * `reference` is the one exception to "a copy is a real file in the book": the
 * card points at the shared原文 and holds no body, so the book is no longer
 * self-contained and every write to that card is refused with
 * `REFERENCE_READONLY` until the user turns it into a copy.
 */
export const SHARED_COPY_MODE = 'copy'
export const SHARED_REFERENCE_MODE = 'reference'
export type SharedEntryMode = typeof SHARED_COPY_MODE | typeof SHARED_REFERENCE_MODE

/**
 * The frontmatter key that records where a copy came from (ADR-0007 C3).
 *
 * An **object** with `{projectId, entryId, contentHash}`, written as an indented
 * block — which is why `frontmatter.ts` reads nested mappings: without that the
 * block would be reported as unparsed lines and every copy would show up as a
 * `FRONTMATTER_ISSUE` in the audit.
 */
export const SHARED_ORIGIN_KEY = 'origin'

/** `<entryId>` shape the shared library issues (ADR-0007 C1). */
export const SHARED_ENTRY_ID_PREFIX = 'sh-'

/** `<seriesId>` shape `series/<slug>.json` carries (ADR-0007 C5). */
export const SHARED_SERIES_ID_PREFIX = 'se-'

/** Version of the on-disk file contract (inside inkflow.json). */
export const FILE_SCHEMA_VERSION = 1

/**
 * Version of the derived SQLite schema; mismatch means "delete and rebuild".
 *
 * v2 (#23): domain modules own their tables, and the cross-class `entities`
 * projection plus one `entities_fts` are added.
 * v3 (#24, #26, #27): `outline_nodes` gains `plot_point_count` / `plot_points` (the
 * parsed body list items, i.e. plot points and their optional story-line tags);
 * `world_entries` gains the world book own fields — `keywords`, `always`,
 * `priority` — so a chapter setting can be matched without reading every file;
 * and the `relations` table (one row per `relations/<slug>.md` edge) joins them,
 * so `relations/` stops being a frontmatter-only directory: it publishes entities.
 * The `entities` column set is unchanged (X-1).
 * v6 (#29): the `entity_mentions` table — every name/alias occurrence with its body
 * offset and its evidence source (`entity_key` = `kind:id`), plus a chapter's frontmatter
 * declaration as a negative-offset `explicit` row. One table, no new columns.
 * v5 (#28): the `timeline_events` table — one row per timeline event with both axes
 * (`world_time`, `narrative_order`) and its chapter, so the two sorts and the conflict
 * checks are queries instead of a scan.
 * v4 (#25): `characters` gains the card fields the query tool reads without parsing
 * frontmatter — `pov`, `first_appearance`, `aliases`, `voice` — and a new
 * `character_states` table holds one row per recorded state, so "what was he at
 * chapter 30" is a `chapter <=` query instead of a JSON scan.
 * v7 (#32): the `facts` table — one row per ledger line (`facts/<subject>.md`), with its
 * 1-based `line` so a finding can point at it and with `since` / `until` so "which facts
 * hold at chapter N" is a range query instead of a re-parse. `facts/` stops being a
 * frontmatter-only directory: it publishes one entity per subject.
 * v8 (#31): the `foreshadowings` table — one row per `foreshadowing/<slug>.md` with the
 * state machine's field and its deadline inputs, so `foreshadowing/` stops being a
 * frontmatter-only directory. `overdue` is NOT a column: it is computed per read from
 * the chapter being asked about (data-model §3.2.2), and a stored mark would go stale.
 *
 * **Bump this for every column/table a domain adds, even when the file mtime does
 * not move** (AGENTS.md §8 trap 5): a stale `user_version` makes `ensureIndex()` call
 * the file fresh, the new `SELECT` then fails, and every read silently degrades to
 * `INDEX_UNAVAILABLE` until the author rebuilds by hand.
 *
 * The index is a cache, so a mismatch is never migrated (ADR-0005) — the old file is
 * discarded.
 */
export const INDEX_SCHEMA_VERSION = 8

export const CHAPTER_STATUSES = ['draft', 'revised', 'final'] as const
export const OUTLINE_KINDS = ['overall', 'volume', 'chapter'] as const

/** Lines a project's .gitignore must contain (derived data never goes to git). */
export const REQUIRED_GITIGNORE_LINES = ['index/*.db', 'index/*.db-wal', 'index/*.db-shm']

/**
 * The ignore line for the private state directory (ADR-0012).
 *
 * Deliberately **not** part of `REQUIRED_GITIGNORE_LINES`: the gate must not nag a book
 * that never uses the recovery bin about a line for a directory it does not have. The
 * writers that first create `.inkflow/` (#35 trash, #36 backup) append this line
 * through `ensurePrivateStateIgnored()` — append-only, like the wizard.
 */
export const PRIVATE_STATE_IGNORE_LINE = `${PRIVATE_STATE_DIR}/`

// NOTE (#101): a `KNOWN_FRONTMATTER` list used to live here with no reader. The
// field dictionary is spec truth ([data-model.md](../../.agents/specs/data-model.md) §3)
// and domains own their own field validation, so a second copy in code only drifts.
