/**
 * Domain module contract — roadmap §2.1 (X-1 ~ X-8).
 *
 * Why this file exists: `indexer.ts` used to hard-code every content directory's
 * parse, its invariants and its DDL in one function, so any two domains landed on
 * the same code. A domain module owns exactly one content directory end to end —
 * scan, validate, its own tables, its model-facing tools — and the index only
 * aggregates what the registered modules return.
 *
 * The imports below are type-only on purpose: `indexer.ts` imports the registry at
 * run time, so the reverse edge must be erased at build time (no runtime cycle).
 * Lifting these types into this file is part of the index rewrite (#23), not #101.
 */

import type { ContentDir } from '../conventions.js'
import type { ToolDefinition } from '../context.js'
import type { ToolDeps } from '../tools.js'
import type { ValidationIssue, WalkedFile } from '../indexer.js'

// Re-exported so a domain module takes every type it touches from one module.
export type { ValidationIssue }

/**
 * What a domain needs to build its model-facing tools.
 *
 * Why this exists: a tool resolves the book from the **session's** working directory.
 * Without this the domain had to fall back to `process.cwd()`, which inside the host
 * process is the DSH install directory — a tool that silently targets the wrong tree.
 * Same shape as `ToolDeps` in `tools.ts`, declared here so this module keeps no
 * runtime edge back into the built-in tool surface.
 */
export type DomainToolDeps = ToolDeps

/** A row as the seam sees it: opaque to the index, tagged by its own domain. */
export type DomainRow = Readonly<Record<string, unknown>>

/**
 * Build one table bucket. The cast lives here once instead of in every domain: a
 * domain's row interface deliberately has no index signature, and adding one would
 * trade its type safety for the seam's convenience.
 */
export function rowsBucket(table: string, rows: readonly object[]): DomainTableRows {
  return { table, rows: rows as unknown as readonly DomainRow[] }
}

/**
 * A file already walked by the index build. Metadata only — the domain that owns
 * the directory reads the content itself, so a domain never re-walks the tree.
 */
export type DomainFile = WalkedFile

/** One table's rows, as a domain contributes them to the derived index. */
export interface DomainTableRows {
  /**
   * Table name; its DDL must come from the same module's `schema()` (X-2).
   *
   * One bucket per table, and **every row must carry `path`** — `applyCandidate()`
   * replaces a write's rows by path, so a row without one would survive its own
   * edit and linger in the index.
   */
  readonly table: string
  readonly rows: readonly DomainRow[]
}

/**
 * One row of the cross-class `entities` projection ([roadmap](../../.agents/specs/roadmap.md) X-1).
 *
 * Every domain emits these for its own kind and the index writes them; the column
 * set is fixed by X-1, so a domain adds rows, never columns.
 */
export interface DomainEntityRef {
  readonly kind: ContentDir
  /** Cross-class unique (`I-04`): an id already used by another kind is `DUPLICATE_ID`. */
  readonly id: string
  /** Project-relative path, forward slashes. */
  readonly path: string
  readonly title: string
  /** Normalised name for uniqueness checks — always from `domains/naming.ts` (X-1; that module lands with #23). */
  readonly nameKey?: string
  readonly category?: string
  readonly parent?: string
  readonly orderIndex?: number
  readonly status?: string
  readonly keywords?: readonly string[]
  readonly aliases?: readonly string[]
}

export interface DomainScanInput {
  readonly root: string
  /** Files under this module's content directory, in deterministic walk order. */
  readonly files: readonly DomainFile[]
}

export interface DomainScanResult {
  readonly tables: readonly DomainTableRows[]
  readonly entities: readonly DomainEntityRef[]
  /** Parse-level problems (malformed frontmatter, bad field types). */
  readonly issues: readonly ValidationIssue[]
}

/** One file's text, addressed exactly as it will be on disk. */
export interface DomainParseInput {
  readonly root: string
  /** Project-relative path with forward slashes. */
  readonly path: string
  /** Full text as it will be written (frontmatter block included). */
  readonly text: string
}

/**
 * What **one file** parses to — deliberately not a `DomainScanResult`, so the
 * write path cannot concatenate it onto a whole-project scan (`rows` belong to
 * exactly one path; merging is `applyCandidate()`'s job, once, in the seam).
 */
export interface DomainFileParse {
  readonly path: string
  /** Rows this file contributes, per table. Empty when the file produces none. */
  readonly rows: readonly DomainTableRows[]
  /** This file's projection row, when the domain publishes one for its kind. */
  readonly entity?: DomainEntityRef
  readonly issues: readonly ValidationIssue[]
}

export interface DomainValidateInput {
  readonly root: string
  /**
   * The domain's rows. On the write path this is already the **post-write** view
   * (the superseded rows for `candidate.path` were dropped and the candidate's rows
   * added by `applyCandidate()`), so a domain never merges anything itself.
   */
  readonly scan: DomainScanResult
  /**
   * Every module's projection rows, for cross-domain checks (dangling refs,
   * cross-class duplicate ids). Assembled by `indexer.ts` (`scanProject`, #23),
   * never by a single domain — and on the write path it is likewise already
   * post-write, so `I-04` does not report an in-place update as a duplicate id.
   */
  readonly entities: readonly DomainEntityRef[]
  /**
   * Set only when this validation runs on the write path, and already applied.
   *
   * Semantics: with `candidate` present, `validate()` returns **only** the issues
   * that must block this write, and the caller treats every returned issue as
   * blocking (there is no severity field to distinguish). Rebuild-only diagnostics
   * — `ENTITIES_DRIFT`, catalog staleness — belong to the caller and must not be
   * returned here, or a permanent rebuild warning would block every edit.
   *
   * Scope (X-4): this covers **create and update** of one file — the write always
   * has content at a known path. A delete or a move has no content to judge, so it
   * is validated by the trash/move paths (#35, `moveChapter`) instead; when those
   * need a pre-write check they must pass the destination as a candidate too.
   *
   * Status: no production caller sets this yet — the write side is wired by the domain
   * tools (#24 onward). Until then `validate()` is only reached through a rebuild, and
   * that is why the write paths still keep their own argument checks.
   */
  readonly candidate?: { readonly path: string }
}

/**
 * The slice of `node:sqlite` a domain may use. Domains never own the connection,
 * the transaction or the index file — those stay in `index-build.ts`.
 */
export interface DomainDatabase {
  /** DDL / statements without parameters. */
  exec(sql: string): unknown
  prepare(sql: string): { run(...params: unknown[]): unknown }
}

/** This module's tables: the statements that create them, and the writer for their rows. */
export interface DomainSchema {
  readonly ddl: readonly string[]
  /**
   * Write this domain's rows inside the build transaction.
   *
   * Error discipline (settled, not either/or): a duplicate the rebuild would report
   * as an issue stays **one row plus an issue** — the existing implementation gets
   * there with `INSERT OR REPLACE` (`indexer.ts`) so a derived index can never brick
   * a project, and the scan reports `DUPLICATE_ID` separately. Throw only for a
   * structural error that cannot be attributed to a row (bad SQL, missing table);
   * the caller turns it into `INDEX_BUILD_FAILED` and discards the temporary index
   * file, which is what makes the build atomic.
   */
  insert(db: DomainDatabase, scan: DomainScanResult): void
}

/**
 * A domain module. Pure with respect to the filesystem: `scan()` and `parseFile()`
 * read, `validate()` judges, `schema()` describes, `tools()` declares. Nothing here
 * writes a project file — writes still go through `io.ts`.
 *
 * `scan()` is assembled by the caller (`indexer.ts`, #23) from one `walkProjectFiles`
 * pass, exactly like `entities`.
 *
 * Write path (X-4), in order, all before anything lands:
 *   1. `parseFile({ root, path, text })`                  — the candidate, parsed once
 *   2. `applyCandidate({ scan, entities }, parsed)`       — seam-owned replace, so
 *      `scan` and `entities` are already post-write and no domain merges by hand
 *   3. `validate({ root, scan, entities, candidate })`    — same invariants as a rebuild
 *   4. only when that returns no blocking issue does the caller write via `io.ts`
 */
export interface DomainModule {
  /** The content directory this module owns; must be one of `CONTENT_DIRS`. */
  readonly kind: ContentDir
  scan(input: DomainScanInput): DomainScanResult
  /**
   * Parse one file's text exactly as `scan()` would, so the write path and the
   * rebuild path can never disagree about what a candidate means.
   */
  parseFile(input: DomainParseInput): DomainFileParse
  /** Invariants over the parsed view; returns issues, never throws (`FRONTMATTER_ISSUE` style). */
  validate(input: DomainValidateInput): ValidationIssue[]
  schema(): DomainSchema
  /**
   * Model-facing tools this domain adds (`inkflow_*`); the aggregate stays in `tools.ts`.
   * `deps` carries the session context, so a domain tool resolves the book exactly the
   * way a built-in tool does instead of guessing from `process.cwd()`.
   */
  tools(deps: DomainToolDeps): readonly ToolDefinition[]
}
