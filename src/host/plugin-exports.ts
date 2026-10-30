/**
 * The plugin surface, first half: the data domains.
 *
 * Specs, outlines, facts, the ledger and the queries behind them — the half a tool reaches for.
 *
 * `index.ts` forwards both halves with `export *`, so the plugin surface is unchanged.
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
export {
  BRIEF_CAP_RATIOS,
  BRIEF_LABELS,
  BRIEF_SEGMENT_ORDER,
  BRIEF_TRIM_ORDER,
  buildWritingBrief,
} from './writing-context.js'
export type {
  BriefSegmentId,
  BriefSegmentRecord,
  BriefTrimRecord,
  WritingBrief,
} from './writing-context.js'
export { MAX_TAGGED_CHARS, charactersInChapter, voiceInChapter } from './brief-sources.js'
export type { BriefCastSource, BriefPackedText } from './brief-sources.js'
export {
  BRIEF_AUDIT_FORMAT,
  BRIEF_AUDIT_SCHEMA,
  briefAuditName,
  briefAuditPath,
  briefAuditRecord,
  briefFor,
  briefRunSummary,
  briefWire,
  resetBriefRunSummary,
  serializeBriefAudit,
  writeBriefAudit,
  writeBriefAuditFor,
} from './brief.js'
export type { BriefAuditRecord, BriefAuditSegment, BriefAuditWrite, BriefRunSummary, BriefWire } from './brief.js'
export {
  DEFAULT_CALENDAR,
  calendarDaysBetween,
  eraAt,
  findEra,
  fromAbsolute,
  isLeapYear,
  monthLength,
  toAbsolute,
  validateCalendarSpec,
} from './calendar.js'
export type {
  CalendarDate,
  CalendarError,
  CalendarErrorCode,
  CalendarResult,
  CalendarSpec,
  EraSpec,
  LeapRule,
} from './calendar.js'
export { BOOK_CALENDAR_KEY, calendarFingerprint, defaultEraOf, readBookCalendar, writeBookCalendar } from './calendar-book.js'
export type { BookCalendar } from './calendar-book.js'
export { parseMarkdown, patchFrontmatter } from './frontmatter.js'
export type { FrontmatterPatchResult, ParsedMarkdown } from './frontmatter.js'
export { MAP_NOTE, PLACE_KIND, describePin, placeGroups, readMapView } from '../client/map-model.js'
export type { MapView, PlaceGroup, PlacePin } from '../client/map-model.js'
export { PANEL_TABS } from '../client/panel-model.js'
export type { PanelTab } from '../client/panel-model.js'
export { buildIndex, describeIndexBuildFailure, IndexBuildError } from './index-build.js'
export type { IndexBuildErrorCode, IndexBuildFailure } from './index-build.js'
export type { IndexBuildResult } from './indexer.js'
export { DOMAIN_MODULES, applyCandidate, domainTools } from './domains/index.js'
export { planOutlineMove, planOutlinePlacement, planOutlineUpsert } from './domains/outline-write.js'
export type { OutlinePlan, OutlineRefusal, OutlineRefusalCode, OutlineWriteNode } from './domains/outline-write.js'
export { entityCounts, listEntities, listEntityIds, listWorldEntries, searchEntities } from './domains/query.js'
export { listRelationsFor } from './domains/query.js'
export type { EntitySummary, WorldIndexEntry } from './domains/query.js'
export type { RelationEdge } from './domains/query.js'
export { planRelationUpsert } from './domains/relation-write.js'
export { RELATION_KINDS, relationConflicts } from './domains/relation-write.js'
export type { RelationConflict } from './domains/relation-write.js'
export { chapterPositionsFromProjection, relationPeriodFindings, relationPeriodMarks, type RelationPeriodConflict, type RelationPeriodMark, type RelationPeriodUncomparable, type RelationPeriodVerdict } from './domains/relation-period.js'
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
export { MENTIONS_DDL, MENTIONS_TABLE, MENTION_SOURCES, chaptersOf, insertMentions, scanMentions } from './domains/mentions.js'
export type { MentionChapter, MentionRow, MentionSource } from './domains/mentions.js'
export { absentEntities, chaptersMentioning, mentionsOf } from './domains/mentions-query.js'
export type { AbsentEntity, AbsentQueryOptions, MentionChapterHit, MentionHit, MentionQueryOptions } from './domains/mentions-query.js'
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
export { buildTools } from './tools.js'
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
export { FRESHNESS_REASON_LIMIT, checkIndexFreshness, ensureIndex } from './index-freshness.js'
export type { EnsureIndexOptions, EnsureIndexResult, IndexFreshness, IndexFreshnessState } from './index-freshness.js'
export { walkProjectFiles } from './indexer.js'
export type { WalkedFile } from './indexer.js'
export {
  LIST_CHAPTERS_DEFAULT,
  LIST_CHAPTERS_MAX,
  clampChapterPage,
  countChapters,
  listAllChapters,
  listChapters,
  readIndexMeta,
} from './indexer.js'
export type { ChapterSummary, IndexMeta } from './indexer.js'
export { MAX_INTERNAL_BODY_BYTES } from './internal.js'
export { compareExpectation, fingerprintBytes, fingerprintFile, fingerprintProjectFile, normalizeExpectation } from './file-cas.js'
export type { FileChange, FileChangeField, FileExpectation, FileFingerprint } from './file-cas.js'
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
export { inspectProject } from './project.js'
export type { ProjectProbe, ProjectState } from './project.js'
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
export { MIN_NON_ASCII_RATIO, MIN_SIGNATURE_FEATURES, describeEncodingSuspicion, looksLikeGbkMojibake } from './encoding.js'
export type { EncodingSuspicion } from './encoding.js'
export { STALE_TOLERANCE_MS, UNKNOWN_BUILD, decideStale, getLoadedBuild, summarizeBuild } from './build-info.js'
export type { BuildSummary, LoadedBuild, LoadedBuildOptions } from './build-info.js'
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
export {
  MAX_SEARCH_OFFSET,
  SEARCH_KINDS,
  searchEntries,
} from './search.js'
export type {
  SearchBackend,
  SearchEntriesFailure,
  SearchEntriesOptions,
  SearchEntriesResult,
  SearchEntriesSuccess,
  SearchEntry,
  SearchKind,
} from './search.js'
export { REPLACE_CONTEXT_CHARS, REPLACE_KINDS, replaceApply, replacePreview } from './replace.js'
export type {
  ReplaceApplyFailure,
  ReplaceApplyRequest,
  ReplaceApplyResult,
  ReplaceApplySuccess,
  ReplaceExpectation,
  ReplaceFailure,
  ReplaceHit,
  ReplacePreviewResult,
  ReplacePreviewSuccess,
  ReplaceRequest,
  ReplaceSkipped,
  ReplaceSkipReason,
} from './replace.js'
export { searchEntityHits } from './domains/query.js'
export type { EntityHit, EntityHitOptions, EntityHitPage } from './domains/query.js'
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
export { frontmatterLine, splitFrontmatter } from './frontmatter.js'
export type { FrontmatterPatchOptions, FrontmatterSplit } from './frontmatter.js'
export { removeEmptyProjectDirectory, removeProjectFile, renameProjectDirectory } from './io.js'
export type { RemoveResult, RenameResult } from './io.js'
export { FINDING_CODES, FINDING_GROUPS, compareFindings, findingCode, locatorKey } from './findings.js'
export type { Finding, FindingCodeSpec, FindingGroup, FindingLocator, FindingSeverity } from './findings.js'
export {
  GATE_FILE_SCHEMA_VERSION,
  GATE_LIST_LIMIT,
  buildGate,
  gateFileName,
  gateFilePath,
  gateFindingRecord,
  gateWire,
  renderGateFile,
  runGate,
} from './gate.js'
export { GATE_CHECKS } from './gate.js'
export { GATE_CHECK_IDS, GATE_CHECK_LABELS, GATE_CODES, GATE_DEFAULTS, gateCheckOf } from './gate-vocabulary.js'
export type { GateCheck } from './gate.js'
export type { GateCheckId, GateFact, GateInput, GateRosterEntry, GateThresholds } from './gate-vocabulary.js'
export type { GateCounts, GateError, GateFileResult, GateReport, GateRequest, GateResult, GateRunOptions } from './gate.js'
export {
  REVIEW_DIMENSIONS,
  REVIEW_DIMENSION_CODES,
  REVIEW_DIMENSION_LABELS,
  REVIEW_DIMENSION_SPECS,
  REVIEW_DIMENSION_TASKS,
  REVIEW_NODES,
} from './review-nodes.js'
export type {
  ReviewAnchorValue,
  ReviewDimension,
  ReviewDimensionSpec,
  ReviewNode,
  ReviewNodeInput,
  ReviewNodeOutput,
  ReviewNodeResult,
} from './review-nodes.js'
export {
  REVIEW_CONTEXT_CHARS,
  REVIEW_DEFAULT_CONTEXT_CHARS,
  frontmatterLineCount,
  locateOpinion,
  paragraphsOf,
} from './review-locate.js'
export type {
  ReviewChapter,
  ReviewError,
  ReviewEvidence,
  ReviewHintSource,
  ReviewOpinion,
  ReviewOpinionInput,
  ReviewParagraph,
  ReviewRejection,
} from './review-locate.js'
export {
  REVIEW_FILE_SCHEMA_VERSION,
  REVIEW_LIST_LIMIT,
  listReviewRuns,
  renderReviewRunFile,
  reviewDirOf,
  reviewOpinionRecord,
  reviewRunId,
  reviewRunPath,
  reviewRunSummary,
  reviewRunWire,
} from './review-store.js'
export type {
  ReviewDimensionSummary,
  ReviewFileResult,
  ReviewRunList,
  ReviewRunRecord,
} from './review-store.js'
export { buildReviewContext, buildReviewList, runReview } from './review.js'
export type {
  ReviewContextResult,
  ReviewContextValue,
  ReviewRequest,
  ReviewResult,
  ReviewRunOptions,
} from './review.js'
export {
  REVIEW_COMPARE_COLUMNS,
  buildReviewCompare,
  compareReviewRuns,
  renderCompareMarkdown,
  reviewCompareWire,
} from './review-compare.js'
export type { ReviewCompare, ReviewCompareColumn, ReviewCompareRow } from './review-compare.js'
export {
  CHAPTER_STATUSES,
  CLAIM_LEASE_MS,
  DEFAULT_BATCH_SIZE,
  DEFAULT_CONCURRENCY,
  JOB_CHAPTER_FORMAT,
  JOB_FORMAT,
  JOB_GATE_FINDINGS_LIMIT,
  JOB_ID_PREFIX,
  JOB_SCHEMA_VERSION,
  JOB_STATUSES,
  MAX_ATTEMPTS,
  MAX_BATCH_SIZE,
  MAX_CONCURRENCY,
  PAUSE_POLICIES,
  approveDrafts,
  chapterDigest,
  completeChapter,
  enqueueJob,
  inFlightCount,
  isJobId,
  jobChapterPath,
  jobDirRelative,
  jobMetaPath,
  listJobs,
  pauseWorthy,
  readJob,
  reconcileChapter,
  resumeJob,
  statusFor,
  takeBatch,
} from './jobs.js'
export type {
  ApproveInput,
  ApproveResult,
  ChapterStatus,
  CompleteInput,
  CompleteResult,
  EnqueueInput,
  JobChapter,
  JobChapterInput,
  JobChapterRef,
  JobError,
  JobGateVerdict,
  JobMeta,
  JobPause,
  JobResult,
  JobState,
  JobStatus,
  JobSummary,
  PausePolicy,
  TakeResult,
  TakeTask,
} from './jobs.js'
export { BATCH_RESUME_BODY_FIELDS, buildBatchPage, resumeViaChannel } from './jobs-wire.js'
export type { BatchChapterRow, BatchCounts, BatchDetail, BatchPage } from './jobs-wire.js'
export { jobsTools } from './jobs-tools.js'
export {
  EMPTY_BATCH_NOTE,
  batchPanelState,
  describeChapter,
  describeChapterStatus,
  describeGate,
  describeJobRow,
  describeJobStatus,
  describePause,
  readBatchPage,
  resumeBlockedReason,
  resumePayload,
} from '../client/batch-model.js'
export type { BatchChapterView, BatchJobRow, BatchJobView, BatchPageView, BatchPanelState } from '../client/batch-model.js'
export {
  PRIVATE_STATE_DIR,
  PRIVATE_STATE_SUBDIRS,
  ensurePrivateStateIgnored,
  isPrivateStatePath,
  privateStateDirRelative,
  privateStateRelative,
} from './private-state.js'
export { IMPACT_KINDS, buildImpact, impactKindOf, planRename, renameRefusal, resolveEntity, scanKindEntities, titleFieldOf } from './impact.js'
