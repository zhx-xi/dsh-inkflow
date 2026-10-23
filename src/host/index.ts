/**
 * dsh-inkflow — Host half.
 *
 * Architecture (ADR-0005): **files are the truth**, SQLite is a rebuildable
 * derived index living inside each project's `index/` directory. There is no
 * plugin-wide database and therefore no database migration: a project outlives
 * every plugin upgrade, and a new index layout is just a new schema version
 * that causes a delete-and-rebuild.
 *
 * HARD DSH CONSTRAINTS this file obeys (verified on 0.2.1-rc.2):
 *   - The plugin API is release-candidate: depend only on `ctx.*` public surface.
 *   - No runtime imports of `@deepseek-ai/*` (see src/host/context.ts).
 *   - Plugin code runs un-sandboxed with the user's own permissions; the plugin
 *     must validate its own inputs and never trust the browser.
 *   - Never append new event types to a session log.
 */

import type { HostContext } from './context.js'
import { getLoadedBuild } from './build-info.js'
import { resolveConfig } from './config.js'
import { BUNDLED_SKILL_NAMES, bundledSkillsDir, registerInkflowSkills } from './skills.js'
import { buildWritingPreset, registerWritingPreset } from './preset.js'
import { registerWritingContext } from './prompt.js'
import { describeError } from './probe.js'
import { readState } from './state.js'
import { buildTools } from './tools.js'
import { createHttpHandler } from './routes.js'

export const name = 'dsh-inkflow'

/**
 * The writing surface (issue #21) is re-exported for the contract tests, which
 * import `lib/index.js` only and must drive what users install — the bundled
 * skills and the preset declaration are data this plugin owns, so the assembly
 * inputs are part of that surface.
 */
export {
  BUNDLED_SKILL_NAMES,
  SKILL_PROVIDER_NAME,
  SKILL_RANK,
  bundledSkillsDir,
  createInkflowSkillProvider,
  isWritingWorkspace,
  loadBundledSkills,
  readBundledSkill,
  registerInkflowSkills,
} from './skills.js'
export type { BundledSkill, SkillFileProblem, SkillRegistration } from './skills.js'
export { WRITING_PRESET_ID, buildWritingPreset, registerWritingPreset, writingPersona } from './preset.js'
export type { PresetRegistration } from './preset.js'

/**
 * The writing context (issue #20) is exported the same way: `buildWritingContext`
 * is the whole projection, and the contract tests assert it directly instead of
 * scraping a fake prompt pipeline. The panel's future briefing preview reuses
 * the same entry point, so this is not a test-only surface.
 */
export { DEFAULT_BUDGET_TOKENS, DEFAULT_TAIL_CHARS, EXTRA_SEGMENTS, buildWritingContext, estimateTokens } from './writing-context.js'
export type {
  ExtraSegmentInput,
  ExtraSegmentSpec,
  WritingContextOptions,
  WritingContextResult,
  WritingContextSegment,
  WritingContextSegmentName,
} from './writing-context.js'
export { PROMPT_SECTION_NAME, PROMPT_SECTION_ORDER, registerWritingContext } from './prompt.js'
export type { WritingContextRegistration } from './prompt.js'

/**
 * The frontmatter reader/writer is re-exported from the bundle entry so the
 * contract tests can drive it directly (they import lib/index.js only). The P1
 * proposal writer uses the same pair in-process, so this is not a test-only
 * surface: `parseMarkdown` reads a file, `patchFrontmatter` rewrites one line.
 */
export { parseMarkdown, patchFrontmatter } from './frontmatter.js'
export type { FrontmatterPatchResult, ParsedMarkdown } from './frontmatter.js'

/** Hard dependency: the tool registry. `webServer` is injected lazily. */
export const inject = ['tools']

const VERSION = '0.0.2'

/**
 * Index-build API for embedders and tests. Tools/routes use these too; exporting
 * them from the entry point keeps the structured error contract addressable
 * without pulling in plugin assembly (`IndexBuildError` is the documented
 * failure type for `buildIndex`).
 */
export { buildIndex, describeIndexBuildFailure, IndexBuildError } from './index-build.js'
export type { IndexBuildErrorCode, IndexBuildFailure } from './index-build.js'
export type { IndexBuildResult } from './indexer.js'

/**
 * Domain module registry (#101): the seam every 0.2.0 data domain plugs into
 * (roadmap §2.1 X-5). Exported so the contract tests can assert that the tool
 * surface is "built-ins + registered modules" and that the pre-write replace
 * (`applyCandidate`) keeps `I-04` honest.
 */
export { DOMAIN_MODULES, applyCandidate, domainTools } from './domains/index.js'
/** Outline planners (#24): pure, so the write-side invariants are test-driven directly. */
export { planOutlineMove, planOutlinePlacement, planOutlineUpsert } from './domains/outline-write.js'
export type { OutlinePlan, OutlineRefusal, OutlineRefusalCode, OutlineWriteNode } from './domains/outline-write.js'
/** Cross-class projection queries (#23): the nine-class panel and mention work read through these. */
export { entityCounts, listEntities, listEntityIds, listWorldEntries, searchEntities } from './domains/query.js'
/** One entity's edges in both roles (#27): the read behind `inkflow_relation_list`. */
export { listRelationsFor } from './domains/query.js'
export type { EntitySummary, WorldIndexEntry } from './domains/query.js'
export type { RelationEdge } from './domains/query.js'

/**
 * Relation domain (#27): `planRelationUpsert` is exported so the write-side decision
 * can be driven as a pure function — the same function the tool calls, so a test
 * cannot pass while the tool would refuse (or the other way round). The rest of the
 * domain stays behind `DOMAIN_MODULES`, like every other module.
 */
export { planRelationUpsert } from './domains/relation-write.js'

/** Timeline planners and views (#28): pure, so both axes are test-driven directly. */
export {
  planTimelineUpsert,
  planTimelineView,
  timelineConflicts,
  timelineValidate,
  parseWorldTime,
} from './domains/timeline-plan.js'
export type {
  TimelineConflict,
  TimelineConflictCode,
  TimelineRow,
  TimelineStatus,
  TimelineUpsertPlan,
  WorldTime,
} from './domains/timeline-plan.js'
export { listTimelineEvents } from './domains/query.js'
export type {
  RelationDirection,
  RelationErrorCode,
  RelationKind,
  RelationPlan,
  RelationPlanError,
  RelationRow,
  RelationUpsertRequest,
  RelationUpsertView,
} from './domains/relation-write.js'
export { ENTITY_COLUMNS, entityFromRow, entityKey } from './domains/entities.js'
export type { DomainWriteView } from './domains/index.js'

/**
 * Entity mentions (#29): the scan is pure (text in, rows out) so the DoD's
 * "590k characters under 5 s" is measured directly, and the three queries are
 * what the 影响面 / 改名级联 / 掉线检测 surfaces read. `MENTIONS_DDL` and
 * `insertMentions` are the seam's half — `indexer.ts` creates the table and writes
 * the rows, because `mentions` owns no content directory and is not a domain.
 */
export { MENTIONS_DDL, MENTIONS_TABLE, MENTION_SOURCES, chaptersOf, insertMentions, scanMentions } from './domains/mentions.js'
export type { MentionChapter, MentionRow, MentionSource } from './domains/mentions.js'
export { absentEntities, chaptersMentioning, mentionsOf } from './domains/mentions-query.js'
export type { AbsentEntity, AbsentQueryOptions, MentionChapterHit, MentionHit, MentionQueryOptions } from './domains/mentions-query.js'

/**
 * World book (#26): the keyword matcher, the write-side half of I-08 and the tree
 * shape are pure — no reads, no writes — so the rule that decides "which setting
 * entry this chapter pulls in" is testable without a project on disk. The
 * injection chain that consumes them is #43's and is not wired yet.
 */
export { matchWorldBook } from './domains/world-match.js'
export type { WorldBookEntry, WorldBookHit, WorldBookMatchReason } from './domains/world-match.js'
export { buildWorldTree, planWorldUpsert, worldIssues } from './domains/world-plan.js'
export type {
  WorldPlanRow,
  WorldTree,
  WorldTreeEntry,
  WorldTreeGroup,
  WorldTreeNode,
  WorldUpsertCandidate,
  WorldUpsertCode,
  WorldUpsertPlan,
  WorldUpsertRejection,
} from './domains/world-plan.js'
/** Exported for the tool-surface contract test: it asserts the aggregate is wired. */
export { buildTools } from './tools.js'
/**
 * Character cards (#25): `planCharacterUpsert` is the write-side I-03 decision and
 * is a pure function precisely so it can be asserted without a disk; the card
 * reader answers "what was he at chapter 30" outside a tool call too.
 */
export { planCharacterUpsert } from './domains/character-write.js'
export type {
  CharacterIdentity,
  CharacterRejectCode,
  CharacterUpsertPlan,
  CharacterUpsertPlanInput,
} from './domains/character-write.js'
export { listCharacters } from './domains/character-query.js'
export type { CharacterListOptions, CharacterSummary } from './domains/character-query.js'
export type {
  DomainDatabase,
  DomainEntityRef,
  DomainFile,
  DomainFileParse,
  DomainModule,
  DomainParseInput,
  DomainScanInput,
  DomainScanResult,
  DomainSchema,
  DomainTableRows,
  DomainToolDeps,
  DomainValidateInput,
} from './domains/types.js'

/**
 * Index freshness (issue #5): `checkIndexFreshness` is the read-only verdict and
 * `ensureIndex` is the **single** place that decides to rebuild. Exported for
 * embedders and tests the same way `buildIndex` is — the tools and the panel
 * channel both go through `ensureIndex`, so this is not a test-only surface.
 */
export { FRESHNESS_REASON_LIMIT, checkIndexFreshness, ensureIndex } from './index-freshness.js'
export type { EnsureIndexOptions, EnsureIndexResult, IndexFreshness, IndexFreshnessState } from './index-freshness.js'
export { walkProjectFiles } from './indexer.js'
export type { WalkedFile } from './indexer.js'

/**
 * The internal channel's request-body ceiling (#115). Exported so the tests state
 * the number once: a save carries a whole chapter, and the old 64 KiB ceiling
 * refused a ~20k-character chapter outright.
 */
export { MAX_INTERNAL_BODY_BYTES } from './internal.js'

/**
 * Write-time compare-and-swap (issue #5): a writer may state the baseline it
 * expects, and a mismatch is the structured `FILE_CHANGED` error with zero
 * writes. Exported so a caller can hand a test (or the panel) the same
 * fingerprint shape the writers compare against.
 */
export { compareExpectation, fingerprintBytes, fingerprintFile, fingerprintProjectFile, normalizeExpectation } from './file-cas.js'
export type { FileChange, FileChangeField, FileExpectation, FileFingerprint } from './file-cas.js'

/**
 * Write-layer API (issue #14): the single door for project file writes.
 * Exported for the tests now and for the chapter/scaffolding writers next; no
 * tool registers against it yet, so this adds no model-facing surface.
 */
export {
  acquireProjectWriteLock,
  resolveWriteTarget,
  withProjectWriteLock,
  writeJsonAtomic,
  writeTextAtomic,
} from './io.js'
export type {
  AtomicWriteOptions,
  IoErrorCode,
  IoFailure,
  IoResult,
  ProjectLock,
  ProjectLockResult,
  ResolveWriteTargetResult,
  WriteResult,
  WriteTarget,
} from './io.js'
export {
  CONTENT_DIRS,
  INDEX_SCHEMA_VERSION,
  PRIVATE_STATE_IGNORE_LINE,
  REQUIRED_GITIGNORE_LINES,
  WRITE_DIRS,
} from './conventions.js'

/**
 * Volume/chapter catalog (issue #15, ADR-0006 D6): a reviewable, committed
 * projection of the `.md` structure. The read path never writes; rebuilds take
 * the project write lock and replace both files atomically; validation reports
 * drift instead of blocking. No tool registers against it yet.
 */
export { readCatalog, rebuildCatalog, validateCatalog } from './catalog.js'
export type {
  CatalogChapter,
  CatalogIssue,
  CatalogIssueCode,
  CatalogReadResult,
  CatalogRebuildResult,
  CatalogValidateResult,
  CatalogVolume,
  RootCatalog,
  VolumeCatalog,
} from './catalog.js'

/** Exported for the tests (and embedders) so the gate can be asserted after a catalog change. */
export { inspectProject } from './project.js'
export type { ProjectProbe, ProjectState } from './project.js'

/**
 * Book hub (ADR-0010, issue #85): the no-session projection of the workspace
 * registry. Exported because the cost contract — four judgments at a time, 2 s
 * per book, 3 s budget, 200 rows — is only testable with an injected probe, and
 * because "which books does the hub see" must be answerable without a browser.
 */
export { HUB_BOOK_TIMEOUT_MS, HUB_CONCURRENCY, HUB_MAX_BOOKS, HUB_SEGMENT, HUB_TOTAL_BUDGET_MS, buildHubBooks } from './hub.js'
export type {
  HubBookCounts,
  HubBookRow,
  HubBookState,
  HubBooksOptions,
  HubBooksResult,
  HubBooksValue,
  HubWorkspaceEntry,
} from './hub.js'

/**
 * Shared library (ADR-0010 D5, issue #87): the **read-only** projection of
 * `dataDir/shared`, and the only hub surface that reads something outside the
 * workspace registry. Exported for the same reason as the hub: the two data
 * sources (the derived manifest vs an in-memory rescan) and the cost limits are
 * only testable by driving `buildHubShared` directly, and `sharedDir` is the one
 * place the `dataDir/shared` path is spelled.
 */
export {
  SHARED_HEAD_BYTES,
  SHARED_MAX_ENTRIES,
  SHARED_MAX_HASH_BYTES,
  SHARED_MAX_JSON_BYTES,
  SHARED_SCAN_BUDGET_MS,
  buildHubShared,
} from './hub-shared.js'
export type {
  HubSharedError,
  HubSharedOptions,
  HubSharedResult,
  HubSharedValue,
  SharedEntry,
} from './hub-shared.js'
export { sharedDir } from './config.js'

/**
 * The hub's new-book wizard (ADR-0010 D4/D6, issue #86). Exported because the
 * two properties that make it safe are only testable from outside the route
 * handler: a plan token is ONE-SHOT and TTL-bounded (so the store takes an
 * injected clock), and `apply` accepts no path at all. The routes are a thin
 * envelope over these two functions, and the tests drive both the envelope and
 * the functions to prove they agree.
 */
export {
  HUB_PLAN_TOKEN_TTL_MS,
  createHubPlanTokenStore,
  hubApply,
  hubPlan,
  hubPlanTokens,
} from './hub-wizard.js'
export type {
  HubPlanAnchor,
  HubPlanTokenLookup,
  HubPlanTokenRecord,
  HubPlanTokenStatus,
  HubPlanTokenStore,
  HubPlanTokenStoreOptions,
  HubWizardOptions,
  HubWizardReply,
} from './hub-wizard.js'

/**
 * GBK mojibake detection (issue #89): a pure function over the title text, so the
 * tests can pin the precision bar (genuine Chinese/Japanese/emoji must not trip
 * it) without building a project on disk.
 */
export { MIN_NON_ASCII_RATIO, MIN_SIGNATURE_FEATURES, describeEncodingSuspicion, looksLikeGbkMojibake } from './encoding.js'
export type { EncodingSuspicion } from './encoding.js'

/**
 * Build identity (issue #88): `getLoadedBuild` is what `/status`, the status tool
 * and the startup log report — the generation this process is executing, the
 * disk's build time and whether the disk moved on without a restart. Exported
 * because the contract tests import `lib/index.js` only, and because any surface
 * that answers "am I running old code" must ask the same function.
 */
export { STALE_TOLERANCE_MS, UNKNOWN_BUILD, decideStale, getLoadedBuild, summarizeBuild } from './build-info.js'
export type { BuildSummary, LoadedBuild, LoadedBuildOptions } from './build-info.js'

/**
 * Chapter search (issue #22): the read-only query half of `chapters_fts`.
 * Exported because the panel's future search box reuses it in-process, so this
 * is not a test-only surface — the tool and the tests drive the same function.
 */
export { DEFAULT_SEARCH_LIMIT, DEFAULT_SNIPPET_RADIUS, MAX_QUERY_CHARS, MAX_SEARCH_LIMIT, searchChapters } from './search.js'
export type {
  ChapterSearchErrorCode,
  ChapterSearchFailure,
  ChapterSearchHit,
  ChapterSearchOptions,
  ChapterSearchResult,
  ChapterSearchSuccess,
  SearchMode,
} from './search.js'

export function apply(ctx: HostContext, rawConfig: unknown): void {
  const config = resolveConfig(rawConfig)
  const log = ctx.logger('dsh-inkflow')

  log.info(`ready: files-first mode, plugin state=${config.dataDir}`)

  // Which generation is this, and is the disk ahead of it (issue #88)? A DSH
  // process keeps running the `lib/` it loaded at startup, so this line is how a
  // human tells "old generation" from "broken book" without opening the panel.
  const loaded = getLoadedBuild({ version: VERSION })
  log.info(
    loaded.staleLoadedCode
      ? `build ${loaded.build} loaded at ${loaded.loadedAt}; the disk holds a newer build (${loaded.diskBuildTime}): run pnpm.cmd run build, then fully quit and restart DSH`
      : `build ${loaded.build} loaded at ${loaded.loadedAt}`,
  )

  // state.json is display-only (issue #7): it records the last project some
  // session touched, purely so a human can see it in the logs. It is never used
  // to resolve a project — one plugin-wide value cannot speak for a session.
  const remembered = readState(config.dataDir).lastProjectRoot
  if (remembered !== undefined) log.info(`last touched project (display only, not used for resolution): ${remembered}`)

  // Writing craft (issue #21). Both halves probe for their Host service and
  // degrade to a single log line: a profile without `skills` / `agentPresets`
  // still gets the tools and the routes, and the skills/ files still ship.
  // Wrapped whole: a rejected registration (a duplicate provider name from a
  // second row mounting this package, say) must not cost the user their tools.
  try {
    const skills = registerInkflowSkills(ctx, { dir: bundledSkillsDir(import.meta.url), log })
    registerWritingPreset(
      ctx,
      buildWritingPreset(skills.names.length > 0 ? skills.names : [...BUNDLED_SKILL_NAMES]),
      log,
    )
  } catch (error) {
    log.warn(`writing surface skipped: ${describeError(error)}`)
  }

  // Writing context (issue #20): the four facts a writing session needs before
  // its first tool call. Optional service, own degradation, and its own
  // try/catch — a broken prompt section must never cost the user their tools.
  try {
    registerWritingContext(ctx, {
      log,
      budgetTokens: config.promptBudgetTokens,
      tailChars: config.promptTailChars,
    })
  } catch (error) {
    log.warn(`writing context skipped: ${describeError(error)}`)
  }

  const tools = ctx.tools
  if (tools === undefined) {
    log.warn('tools service missing; inkflow_* tools are not registered')
  } else {
    for (const definition of buildTools({ ctx, dataDir: config.dataDir, version: VERSION })) {
      ctx.effect(() => tools.register(definition))
    }
    log.info('inkflow_* tools registered (files-first, derived index)')
  }

  if (config.serveHttp) {
    ctx.inject(['webServer'], (scoped) => {
      const webServer = scoped.webServer
      if (webServer === undefined) return
      scoped.effect(() =>
        webServer.register({
          kind: 'prefix',
          path: '/inkflow',
          handler: createHttpHandler({ ctx, dataDir: config.dataDir, version: VERSION }),
        }),
      )
      log.info('http routes registered under /inkflow')
    })
  }
}

/**
 * 卷章 CRUD（issue #16）。
 */
export { createChapter, createVolume, deleteChapter, moveChapter, renameVolume, writeChapter } from './chapters.js'
export type {
  ChapterCreateInput,
  ChapterCreateResult,
  ChapterDeleteInput,
  ChapterDeleteResult,
  ChapterErrorCode,
  ChapterMoveInput,
  ChapterMoveResult,
  ChapterOpError,
  ChapterOpFailure,
  ChapterView,
  ChapterWriteInput,
  ChapterWriteResult,
  CommitInfo,
  RollbackStep,
  VolumeCreateInput,
  VolumeCreateResult,
  VolumeRenameInput,
  VolumeRenameResult,
  VolumeView,
} from './chapters.js'

/** issue #16: new frontmatter and io helpers (one export statement each). */
export { frontmatterLine, splitFrontmatter } from './frontmatter.js'
export type { FrontmatterPatchOptions, FrontmatterSplit } from './frontmatter.js'
export { removeEmptyProjectDirectory, removeProjectFile, renameProjectDirectory } from './io.js'
export type { RemoveResult, RenameResult } from './io.js'

/**
 * The shared finding shape (#121, roadmap X-14): the vocabulary the audit report
 * (#33) and the repair pass (#36) both speak, plus the ordering a report needs to
 * be stable between two runs on unchanged files.
 */
export { FINDING_CODES, FINDING_GROUPS, compareFindings, findingCode, locatorKey } from './findings.js'
export type { Finding, FindingCodeSpec, FindingGroup, FindingLocator, FindingSeverity } from './findings.js'

/** Private state directory (`.inkflow/`) helpers — ADR-0012, roadmap X-9. */
export {
  PRIVATE_STATE_DIR,
  PRIVATE_STATE_SUBDIRS,
  ensurePrivateStateIgnored,
  isPrivateStatePath,
  privateStateDirRelative,
  privateStateRelative,
} from './private-state.js'

/**
 * The recovery bin (#35, roadmap X-9/X-10): move one file into `.inkflow/trash/`,
 * list what is there, put an entry back byte-identically, or purge one entry —
 * the last only with `confirm: true`.
 */
export { listTrash, purgeTrash, restoreTrash, trashFile, undoTrashFile } from './trash.js'
export type {
  PurgeInput,
  PurgeResult,
  RestoreInput,
  RestoreResult,
  TrashEntry,
  TrashEntryView,
  TrashError,
  TrashFileInput,
  TrashFileResult,
  TrashListResult,
} from './trash.js'

/**
 * The fact ledger (#32): the line format as a parse/render **pair** (ADR-0013), the
 * interval judgement (I-23) and the "which facts hold at chapter N" query. Pure, so the
 * round-trip and the conflict rule are test-driven directly instead of through a tool.
 */
export {
  DEFAULT_FACT_SOURCE,
  FACT_KEYS,
  FACT_SOURCES,
  isFactLine,
  parseFactLine,
  renderFactLine,
} from './domains/facts-line.js'
export type { FactKnownKey, FactLine, FactSource, ParsedFactLine } from './domains/facts-line.js'
export {
  FACTS_TABLE,
  chapterIdsUsed,
  chapterSeqFrom,
  chapterSeqFromMap,
  conflictsTouching,
  factAnchor,
  factInEffect,
  factsConflicts,
  factsFileParse,
  factsSnapshot,
  factsValidate,
  parseFactsFile,
  sortFacts,
  unresolvedChapterIds,
} from './domains/facts-plan.js'
export type { ChapterSeq, FactConflict, FactRow, ParsedFacts } from './domains/facts-plan.js'
export { chapterIndex, readFactsRows, seqOfChapters } from './domains/facts-query.js'
export type { ChapterIndex } from './domains/facts-query.js'
export { MAX_SEGMENT_FACTS, factsSegment } from './domains/facts-prompt.js'
