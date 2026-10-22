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
import type { ValidationIssue, WalkedFile } from '../indexer.js'

/**
 * A file already walked by the index build. Metadata only — the domain that owns
 * the directory reads the content itself, so a domain never re-walks the tree.
 */
export type DomainFile = WalkedFile

/** One table's rows, as a domain contributes them to the derived index. */
export interface DomainTableRows {
  /** Table name; its DDL must come from the same module's `schema()` (X-2). */
  readonly table: string
  readonly rows: readonly Readonly<Record<string, unknown>>[]
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
 * A file that is **not on disk yet** — the bytes a write is about to produce.
 *
 * Why this exists (roadmap X-4): the write path has to refuse an invalid change
 * *before* `io.ts` replaces anything, and at that moment `scan()` cannot see the
 * file. Without this entry point the writer would either write first and validate
 * after (violates "before landing"), or re-implement parsing and normalisation
 * (exactly the second `name_key` implementation X-1 forbids).
 */
export interface DomainCandidate {
  readonly path: string
  /** Full text as it will be written; parse it with `parseFile()`, never by hand. */
  readonly text: string
}

export interface DomainValidateInput {
  readonly root: string
  readonly scan: DomainScanResult
  /**
   * Every module's projection rows, for cross-domain checks (dangling refs,
   * cross-class duplicate ids). Assembled by `indexer.ts` (#23, `scanProject`),
   * never by a single domain.
   */
  readonly entities: readonly DomainEntityRef[]
  /**
   * Set only on the write path. A domain that owns `candidate.path` must judge the
   * parsed candidate **as the replacement** for that path: drop the on-disk rows
   * it supersedes, add its own, then apply the same invariants as a rebuild.
   */
  readonly candidate?: DomainCandidate
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
   * Error discipline: a derived index must never be able to brick a project
   * (`indexer.ts` already keeps `INSERT OR REPLACE` for that reason), so an insert
   * either absorbs an unforeseen duplicate row or throws a diagnosable error — it
   * must not leave the caller guessing. The caller owns BEGIN/COMMIT and rolls back
   * on a throw.
   */
  insert(db: DomainDatabase, scan: DomainScanResult): void
}

/**
 * A domain module. Pure with respect to the filesystem: `scan()` and `parseFile()`
 * read, `validate()` judges, `schema()` describes, `tools()` declares. Nothing here
 * writes a project file — writes still go through `io.ts`.
 *
 * Write path (X-4), in order, all before anything lands:
 *   1. `parseFile({ root, path, text })`   — the candidate's rows, parsed once
 *   2. `validate({ root, scan, entities, candidate })` — same invariants as a rebuild
 *   3. only when that returns no blocking issue does the caller write via `io.ts`
 */
export interface DomainModule {
  /** The content directory this module owns; must be one of `CONTENT_DIRS`. */
  readonly kind: ContentDir
  scan(input: DomainScanInput): DomainScanResult
  /**
   * Parse one file's text exactly as `scan()` would, so the write path and the
   * rebuild path can never disagree about what a candidate means.
   */
  parseFile(input: DomainParseInput): DomainScanResult
  /** Invariants over the parsed view; returns issues, never throws (`FRONTMATTER_ISSUE` style). */
  validate(input: DomainValidateInput): ValidationIssue[]
  schema(): DomainSchema
  /** Model-facing tools this domain adds (`inkflow_*`); the aggregate stays in `tools.ts`. */
  tools(): readonly ToolDefinition[]
}
