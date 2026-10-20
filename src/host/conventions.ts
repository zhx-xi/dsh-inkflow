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
export const INDEX_KEEP_FILE = '.gitkeep'

/** Content directories every project must have (besides INDEX_DIR). */
export const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'library'] as const
export type ContentDir = (typeof CONTENT_DIRS)[number]

/** All six directories the gate requires (docs/conventions.md §1 G2). */
export const REQUIRED_DIRS = [
  'chapters',
  'characters',
  'world',
  'outlines',
  INDEX_DIR,
  'library',
] as const

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
