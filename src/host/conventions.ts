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

/** Version of the on-disk file contract (inside inkflow.json). */
export const FILE_SCHEMA_VERSION = 1

/**
 * Version of the derived SQLite schema; mismatch means "delete and rebuild".
 *
 * v2 (#23): domain modules own their tables, and the cross-class `entities`
 * projection plus one `entities_fts` are added. The index is a cache, so a mismatch
 * is never migrated (ADR-0005) — the old file is discarded.
 */
export const INDEX_SCHEMA_VERSION = 2

export const CHAPTER_STATUSES = ['draft', 'revised', 'final'] as const
export const OUTLINE_KINDS = ['overall', 'volume', 'chapter'] as const

/** Lines a project's .gitignore must contain (derived data never goes to git). */
export const REQUIRED_GITIGNORE_LINES = ['index/*.db', 'index/*.db-wal', 'index/*.db-shm']

// NOTE (#101): a `KNOWN_FRONTMATTER` list used to live here with no reader. The
// field dictionary is spec truth ([data-model.md](../../.agents/specs/data-model.md) §3)
// and domains own their own field validation, so a second copy in code only drifts.
