/**
 * The plugin surface, second half: channels, panels and build identity.
 *
 * The wire the panel reads, the export/import/batch channels and the version stamp.
 *
 * `index.ts` forwards both halves with `export *`, so the plugin surface is unchanged.
 */

export type {
  ImpactChapterRow,
  ImpactEventRow,
  ImpactFactRow,
  ImpactForeshadowRow,
  ImpactRelationRow,
  ImpactRenamePlan,
  ImpactReply,
  ImpactReport,
  ImpactRequest,
  ImpactSource,
  ResolvedEntity,
} from './impact.js'
export { renameEntity } from './impact-write.js'
export type { RenameRequest } from './impact-write.js'
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
export {
  DEFAULT_FACT_SOURCE,
  FACT_KEYS,
  FACT_SOURCES,
  classifyFactLine,
  isFactLine,
  parseFactLine,
  renderFactLine,
} from './domains/facts-line.js'
export type { FactKnownKey, FactLine, FactLineVerdict, FactSource, ParsedFactLine } from './domains/facts-line.js'
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
export {
  FORESHADOW_STATUSES,
  baseStatusOf,
  comparePosition,
  foreshadowTransitionAllowed,
  foreshadowUrgency,
  volumeOrderOf,
} from './domains/foreshadowing-plan.js'
export type { ChapterPosition, ForeshadowStatus, ForeshadowUrgency } from './domains/foreshadowing-plan.js'
export {
  chapterPositions,
  chapterPositionsFromFiles,
  readForeshadowView,
  volumeOrdersOf,
} from './domains/foreshadowing-query.js'
export {
  AUDIT_LIST_LIMIT,
  auditProject,
  auditReportName,
  exportAuditReport,
  hintOf,
  renderAuditReport,
  severityOf,
  sortFindings,
} from './audit.js'
export type { AuditCounts, AuditExportResult, AuditReport, RenderOptions } from './audit.js'
export { auditWire, buildAudit, exportAudit, findingWire } from './audit-channel.js'
export type { AuditReply, AuditSource } from './audit-channel.js'
export {
  BACKUP_KINDS,
  BACKUP_MANIFEST_FILE,
  BACKUP_SCHEMA_VERSION,
  backupCopyPath,
  backupStamp,
  digestRelative,
  listBackups,
  normalizeBackupDir,
  openBackup,
  readBackup,
  rollbackBackup,
  sealBackup,
  stageFile,
} from './backup.js'
export type {
  BackupBody,
  BackupDigest,
  BackupFileEntry,
  BackupHandle,
  BackupKind,
  BackupManifest,
  RollbackResult,
} from './backup.js'
export { applyRepair, detectFindings, findingKey, planRepair } from './repair.js'
export type {
  ApplyOptions,
  DetectResult,
  DetectSummary,
  PlanOptions,
  RepairAction,
  RepairKind,
  RepairOutcome,
  RepairPlan,
  RepairResult,
  RepairSkip,
} from './repair.js'
export { applyMigration, planMigration, rollbackMigration } from './migrate.js'
export type {
  MigrationAction,
  MigrationApplyResult,
  MigrationOp,
  MigrationPlan,
  RollbackOutcome,
} from './migrate.js'
export { migrationReportMarkdown, repairReportMarkdown, writeAuditReport } from './repair-report.js'
export {
  SHARED_COPY_MAX_ROWS,
  applyOriginBlock,
  buildSharedCopies,
  copySharedEntry,
  ensureProjectId,
  updateSharedEntry,
} from './shared-copy.js'
export { writeLibraryItem } from './library-write.js'
export type {
  EnsureProjectIdValue,
  SharedCopiesValue,
  SharedCopyError,
  SharedCopyInput,
  SharedCopyMode,
  SharedCopyRow,
  SharedCopyValue,
  SharedOriginCopy,
  SharedOriginReference,
  SharedResult,
  SharedUpdateInput,
  SharedUpdateValue,
} from './shared-copy.js'
export { scanSharedLibrary } from './hub-shared.js'
export type { SharedLibraryScan } from './hub-shared.js'
export { SERIES_SYNC_KINDS, applySeriesSync, buildSeriesPlan, compareSeriesContent, seriesRunName } from './series.js'
export type {
  SeriesAction,
  SeriesApplyInput,
  SeriesApplyValue,
  SeriesConflictReason,
  SeriesDecision,
  SeriesDecisionChoice,
  SeriesError,
  SeriesExclusions,
  SeriesKeptRow,
  SeriesPlanCounts,
  SeriesPlanEntry,
  SeriesPlanValue,
  SeriesResult,
  SeriesRunRecord,
  SeriesSkippedRow,
  SeriesWriteRow,
} from './series.js'
export { SERIES_APPLY_BODY_FIELDS, seriesApplyReply, seriesPlanReply } from './series-channel.js'
export { ZipError, crc32, readZip, writeZip } from './zip.js'
export type { ZipEntry, ZipErrorCode, ZipWriteEntry, ZipWriteOptions } from './zip.js'
export {
  SETTINGS_DEFAULTS,
  SETTINGS_FIELDS,
  SETTINGS_FILE,
  SETTINGS_LIMITS,
  SETTINGS_SCHEMA_VERSION,
  coerceSettings,
  coerceSettingsDetailed,
  onSettingsWritten,
  readSettings,
  removeSettingsFile,
  settingsOf,
  settingsPath,
  sharedRootOf,
  writeSettings,
} from './settings.js'
export { HUB_SETTINGS_BODY_FIELDS } from './hub-settings.js'
export type {
  CoercedSettings,
  InkflowSettings,
  SettingsError,
  SettingsField,
  SettingsFieldNotice,
  SettingsRead,
  SettingsResult,
  SettingsWarning,
  SettingsWrite,
  SharedRootResolution,
  SharedRootWarning,
} from './settings.js'
// The delegation policy: the three texts, the section that injects one of them, and the
// switch that decides whether the writing preset loads the workflow row.
export {
  DELEGATION_SECTION_NAME,
  DELEGATION_SECTION_ORDER,
  delegationEnabled,
  delegationPolicyText,
  describeDelegation,
  registerDelegationSection,
} from './delegation.js'
export type {
  DelegationPlan,
  DelegationSectionRegistration,
  DelegationSettings,
  DelegationState,
} from './delegation.js'
// The model catalog behind the settings page's picker. Exported because its degradation
// (missing service / 2 s deadline / one provider failing) IS the contract, and a contract
// is asserted against the built artifact.
export { MODELS_TIMEOUT_MS, buildHubModels } from './hub-models.js'
export type {
  HubModelsErrorCode,
  HubModelsReply,
  HubModelsValue,
  LlmModelLike,
  LlmProviderLike,
  LlmServiceLike,
  ModelChoice,
  ProviderChoice,
} from './hub-models.js'
export {
  BACKUPS_DIR,
  BACKUP_EXCLUDED_DIRS,
  BACKUP_KEEP_DEFAULT,
  BACKUP_KEEP_MAX,
  BACKUP_KEEP_MIN,
  BACKUP_ROOT_FILES,
  bookSlugOf,
  backupsDir,
  collectBackupFiles,
  createBookBackup,
  listBookBackups,
  openBookBackup,
  planRestore,
  pruneBookBackups,
  restoreBookBackup,
} from './backup-zip.js'
export type {
  BackupPackage,
  BackupZipError,
  BackupZipErrorCode,
  BackupZipResult,
  CollectOptions,
  CreateBackupOptions,
  CreateBackupValue,
  OpenBackupValue,
  RestoreOptions,
  RestorePlan,
  RestorePlanEntry,
  RestoreReport,
} from './backup-zip.js'
export {
  DIAGNOSTICS_DIR,
  DIAGNOSTICS_FORMAT,
  DIAGNOSTICS_LOG_LINES,
  buildDiagnostics,
  diagnosticsDir,
  exportDiagnostics,
  maskPath,
  toolSurfaceHash,
} from './diagnostics.js'
export type {
  DiagnosticsDocument,
  DiagnosticsIndex,
  DiagnosticsInput,
  DiagnosticsResult,
  ExportDiagnosticsValue,
  ToolSurfaceEntry,
  ToolSurfaceSource,
} from './diagnostics.js'
export { settingsTools } from './settings-tools.js'
export type { SettingsToolDeps } from './settings-tools.js'
export {
  IMPORT_EXTENSIONS,
  MAX_IMPORT_BYTES,
  analyzeImportBytes,
  decodeImportBytes,
  splitImportChapters,
} from './import.js'
export type {
  ImportAnalysis,
  ImportChapter,
  ImportDecoded,
  ImportEncoding,
  ImportEol,
  ImportPattern,
} from './import.js'
export { applyImport, planImport } from './import-write.js'
export type {
  ImportApplyOptions,
  ImportApplyResult,
  ImportApplyValue,
  ImportAppliedChapter,
  ImportError,
  ImportPlan,
  ImportPlanChapter,
  ImportPlanLibrary,
  ImportPlanOptions,
  ImportPlanResult,
  ImportPlanSource,
  ImportPlanTarget,
} from './import-write.js'
export {
  OVK_BLOCK_CHARS,
  OVK_BLOCK_OVERLAP,
  OVK_CONFIG_MAX_BYTES,
  OVK_CONFIG_VERSION,
  OVK_DEGRADED_REASONS,
  OVK_FIRST_BUILD_BYTES,
  OVK_FIRST_BUILD_CHAPTERS,
  OVK_HEALTH_PATH,
  OVK_SEARCH_PATH,
  OVK_TIMEOUT_MS,
  OVK_WRITE_PATH,
  PEER_ID_PATTERN,
  blockContentOf,
  blockTagsOf,
  blockUriOf,
  chunkBody,
  connectionOf,
  contentHashOf,
  hitsOf,
  ovkFind,
  ovkForget,
  ovkHealth,
  ovkRequest,
  ovkWriteBlock,
  parseBlockUri,
  projectSubtreeUri,
  resolveOvkPeer,
  tombstoneContentOf,
} from './ovk.js'
export type {
  BlockMetadata,
  ConnectionResult,
  OvkBlock,
  OvkConnection,
  OvkDegradedReason,
  OvkFailure,
  OvkFailureReason,
  OvkHit,
  OvkResult,
  ParsedBlockUri,
  PeerProblem,
  PeerResolution,
} from './ovk.js'
export {
  SEMANTIC_DIR,
  SEMANTIC_SCHEMA_VERSION,
  blockCountOf,
  chapterSources,
  ledgerPath,
  planRebuild,
  projectIdFor,
  readLedger,
  semanticSlugOf,
  tombstonedUrisOf,
  writeLedger,
} from './ovk-ledger.js'
export type {
  BlockRecord,
  ChapterRecord,
  ChapterSource,
  LedgerRead,
  RebuildPlan,
  RebuildSummary,
  SemanticLedger,
} from './ovk-ledger.js'
export {
  REBUILD_DEBOUNCE_MS,
  REBUILD_RETRIES,
  enqueueRebuild,
  planOnly,
  queueSnapshotOf,
  readChapterBody,
  resetQueue,
  runRebuild,
} from './ovk-queue.js'
export type { QueueSnapshot, RebuildOutcome, SemanticRuntime } from './ovk-queue.js'
export { coverageOf, semanticCoverageOf } from './ovk-coverage.js'
export type { CoverageFacts, SemanticCoverage, SemanticCoverageDeps, SemanticCoverageGap, SemanticCoverageState } from './ovk-coverage.js'
export { diagnoseSemantic, searchWithSemantic } from './ovk-search.js'
export type { SemanticAvailability, SemanticDeps, SemanticSearchOutcome } from './ovk-search.js'
export { estimateRebuild, purgeApply, purgePlanOf, rebuildNow, runtimeOf, semanticStatusOf } from './ovk-status.js'
export type { PurgeOutcome, RebuildEstimate, SemanticStatus } from './ovk-status.js'
export { semanticTools } from './ovk-tools.js'
export { buildHubSemantic, purgeHubSemantic, rebuildHubSemantic } from './ovk-hub.js'
export { maskSettingsSecrets } from './diagnostics.js'
export { CANDIDATE_SCHEMA_VERSION, EXTRACT_KINDS, CANDIDATE_STATUSES, CONFIDENCES, proposeCandidates, readCandidateStore, purgeCandidates } from './extract.js'
export type {
  CandidateBatch,
  CandidateProposal,
  CandidateRecord,
  CandidateStatus,
  Confidence,
  ExtractCode,
  ExtractError,
  ExtractKind,
  ProposeResult,
} from './extract.js'
export { acceptCandidates, materializeCandidate } from './extract-accept.js'
export type { AcceptOutcome, AcceptRefusal, AcceptReport } from './extract-accept.js'
export { acceptViaChannel, buildCandidates, purgeViaChannel, rejectViaChannel } from './extract-channel.js'
export type { CandidateReply, CandidateSource } from './extract-channel.js'
export { ETL_DEFAULT_BATCH_SIZE, ETL_MAX_BATCH_SIZE, applyEtl, planEtl, readEtlIdMap, rollbackEtl } from './etl.js'
export type {
  EtlApplyInput,
  EtlApplyResult,
  EtlApplyValue,
  EtlError,
  EtlIdMapResult,
  EtlPlanResult,
  EtlRollbackInput,
  EtlRollbackResult,
  EtlRollbackValue,
  EtlRunOptions,
} from './etl.js'
export { ETL_IDMAP_RELATIVE, ETL_IDMAP_VERSION, buildEtlPlan, hasFrontmatterBlock } from './etl-plan.js'
export { ETL_TABLES } from './etl-source.js'
export type { EtlTable } from './etl-source.js'
export type {
  EtlClassReport,
  EtlComputation,
  EtlDecision,
  EtlDiskProbe,
  EtlGap,
  EtlIdMap,
  EtlIdMapEntry,
  EtlItem,
  EtlItemState,
  EtlPlan,
  EtlPlanOptions,
  EtlReconcile,
  EtlWrite,
} from './etl-plan.js'
export { listLegacyProjects, readLegacyBook } from './etl-source.js'
export type { EtlSourceOptions, LegacyBook, LegacyProject } from './etl-source.js'
export { etlTools } from './etl-tools.js'
export {
  PROPOSAL_HUNKS_DIR,
  PROPOSAL_HUNK_STATUSES,
  PROPOSAL_ID_PREFIX,
  PROPOSAL_META_FILE,
  PROPOSAL_SCHEMA_VERSION,
  PROPOSAL_STATUSES,
  countsOf,
  isProposalHunkStatus,
  isProposalId,
  listProposals,
  proposalDirRelative,
  proposalHunkPath,
  proposalMetaPath,
  proposalsDirRelative,
  readProposal,
} from './proposal.js'
export { createProposal, decideProposal } from './proposal-actions.js'
export { applyProposal, rollbackProposal } from './proposal-apply.js'
export type {
  ProposalBase,
  ProposalCounts,
  ProposalDigest,
  ProposalError,
  ProposalHunk,
  ProposalHunkFile,
  ProposalHunkRef,
  ProposalHunkStatus,
  ProposalMeta,
  ProposalRead,
  ProposalResult,
  ProposalStatus,
} from './proposal.js'
export type { CreateProposalInput, CreateProposalOk, DecideProposalInput, DecideProposalOk, HunkDecision } from
  './proposal-actions.js'
export type { ApplyProposalInput, ApplyProposalOk, RollbackProposalInput, RollbackProposalOk } from './proposal-apply.js'
export { applyHunks, diffLines, joinLines, splitLines } from './proposal-diff.js'
export type { HunkKind, LineHunk } from './proposal-diff.js'
export {
  PROPOSAL_APPLY_BODY_FIELDS,
  PROPOSAL_DECIDE_BODY_FIELDS,
  PROPOSAL_HUNK_LINE_LIMIT,
  PROPOSAL_LIST_LIMIT,
  PROPOSAL_ROLLBACK_BODY_FIELDS,
  applyViaChannel,
  buildProposals,
  decideViaChannel,
  rollbackViaChannel,
} from './proposal-channel.js'
export type { ProposalReply, ProposalSource } from './proposal-channel.js'
export { proposalTools } from './proposal-tools.js'
export {
  PROPOSAL_NOTE,
  applyActionLabel,
  applyBlocked,
  confirmPayload,
  decidePayload,
  describeCounts,
  describeHunk,
  describeHunkKind,
  describeHunkStatus,
  describeOutcome,
  describeProposalStatus,
  describeTotals,
  detailRequestPath,
  pendingDecisions,
  preferredProposalId,
  readProposalPage,
  rollbackActionLabel,
  rollbackBlocked,
} from '../client/proposal-model.js'
export type { Decision, HunkRow, ProposalPage, ProposalRow } from '../client/proposal-model.js'
export {
  EPUB_MIMETYPE,
  EXPORTS_DIR,
  EXPORT_FORMATS,
  EXPORT_TARGETS,
  escapeXml,
  exportBook,
  exportsDir,
  markdownBlocks,
} from './export.js'
export type {
  ExportChapterStatus,
  ExportChapter,
  ExportError,
  ExportErrorCode,
  ExportFormat,
  ExportGroup,
  ExportMeta,
  ExportPlan,
  ExportRequest,
  ExportResult,
  ExportTarget,
  ExportValue,
  MarkdownBlock,
} from './export.js'
export { exportTools } from './export-tools.js'
