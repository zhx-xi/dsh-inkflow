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

/** Version of the on-disk file contract (inside inkflow.json). */
export const FILE_SCHEMA_VERSION = 1

/** Version of the derived SQLite schema; mismatch means "delete and rebuild". */
export const INDEX_SCHEMA_VERSION = 1

export const CHAPTER_STATUSES = ['draft', 'revised', 'final'] as const
export const OUTLINE_KINDS = ['overall', 'volume', 'chapter'] as const

/** Lines a project's .gitignore must contain (derived data never goes to git). */
export const REQUIRED_GITIGNORE_LINES = ['index/*.db', 'index/*.db-wal', 'index/*.db-shm']

/** Frontmatter fields we understand today; unknown fields are preserved in files, ignored here. */
export const KNOWN_FRONTMATTER = [
  'id',
  'title',
  'name',
  'aliases',
  'volume',
  'seq',
  'status',
  'pov',
  'group',
  'role',
  'firstAppearance',
  'category',
  'parent',
  'keywords',
  'always',
  'kind',
  'order',
] as const
