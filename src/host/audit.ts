/**
 * The consistency audit (roadmap §2.2 X-14, DoD D3-3): five check families, one
 * `Finding[]`, one Markdown report.
 *
 * ## What this module is for, and what it deliberately is not
 *
 * Every family already has an owner that produces problems:
 *
 *   | group      | the only implementation                                          |
 *   |------------|------------------------------------------------------------------|
 *   | structure  | `scanProject()` → `validation_issues`                             |
 *   | ledger     | the same (`facts-plan.ts` emits `FACT_*`)                         |
 *   | foreshadow | the same, plus `foreshadowing-plan.ts`'s lateness rule            |
 *   | timeline   | the same (`timeline-plan.ts` emits `TIMELINE_*`)                  |
 *   | catalog    | the same (`CHAPTER_NOT_MARKDOWN`) + `validateCatalog()`           |
 *
 * So this file owns exactly four things — **aggregate, group, sort, say what to do** —
 * and nothing else. It never re-judges an invariant: a second opinion about whether a
 * relation endpoint exists would drift from `relations.ts` the moment either changed, and
 * the report would then contradict the tool that refused the write.
 *
 * ## Why the audit reads **files** and not the index
 *
 * The index is a cache (ADR-0005). A report about integrity answered from a stale cache
 * would be a lie, and the audit cannot rebuild it — `GET /audit` is a read path, and a read
 * path that writes is what a whole module here exists to prevent. `scanProject()` is a pure
 * read producing the same rows a rebuild would, so the audit is correct on a book whose
 * index was never built and on one whose index is weeks old, at the cost of one scan.
 *
 * ## Determinism
 *
 * `compareFindings` is the contract (X-14) and is total over
 * `(group, severity, code, locator)`. Two findings can still tie on all four (two
 * `FRONTMATTER_ISSUE` rows in one file share code and locator), and `Array#sort` would
 * then keep the caller's order — deterministic today only because the scan is.
 * {@link sortFindings} adds `detail` as the final tiebreak, so the report body is
 * byte-identical across two runs **and** across any future second source of the same
 * findings, which is what `tests/audit.test.js` pins.
 *
 * The report body carries **no timestamp and no root path** on purpose: the file name says
 * when it was produced, and everything inside it is a function of the book alone.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { validateCatalog } from './catalog.js'
import type { ContentDir } from './conventions.js'
import { CATALOG_FILE, CHAPTERS_DIR, ROOT_META_FILE } from './conventions.js'
import type { ChapterPosition, ForeshadowRow } from './domains/foreshadowing-plan.js'
import { FORESHADOW_TABLE, foreshadowAuditIssues } from './domains/foreshadowing-plan.js'
import { chapterPositionsFromFiles, latestChapter, volumeOrdersOf } from './domains/foreshadowing-query.js'
import { rowsOf } from './domains/scan-helpers.js'
import { FINDING_CODES, FINDING_GROUPS, compareFindings, findingCode, locatorKey } from './findings.js'
import type { Finding, FindingGroup, FindingLocator, FindingSeverity } from './findings.js'
import { checkIndexFreshness } from './index-freshness.js'
import type { IndexFreshnessState } from './index-freshness.js'
import { scanProject } from './indexer.js'
import type { ScanResult, ValidationIssue } from './indexer.js'
import { writeTextAtomic } from './io.js'
import { ensurePrivateStateIgnored, privateStateRelative } from './private-state.js'

/** How many findings a report section, a tool reply or a page shows before "and N more". */
export const AUDIT_LIST_LIMIT = 100

export interface AuditCounts {
  readonly total: number
  readonly byGroup: Readonly<Record<FindingGroup, number>>
  readonly severity: Readonly<Record<FindingSeverity, number>>
  /** Findings the repair pass has an automatic action for; the rest need a human decision. */
  readonly fixable: number
}

export interface AuditReport {
  root: string
  /** Sorted by {@link sortFindings}: the report's order, and the tool's. */
  findings: readonly Finding[]
  counts: AuditCounts
  /**
   * Where the findings came from. Only ever `files` today; the field exists so that a
   * future index-backed reader cannot silently change what an audit means.
   */
  source: 'files'
  /** The cache's state, reported for context — it never changes the findings. */
  indexState: IndexFreshnessState
  /** `true` when `.md` and the catalogs disagree: the catalog group's headline. */
  catalogStale: boolean
  /** Wall time of the audit itself (scan + catalog + lateness + sort). */
  ms: number
  /** The book's title from `inkflow.json`, when it has a readable one. */
  title?: string
}

// ---------------------------------------------------------------------------
// Severity and hints: the report's voice, not the vocabulary (that lives in findings.ts)
// ---------------------------------------------------------------------------

/**
 * The three codes that are **information**, not defects.
 *
 * `ID_PATH_DIVERGED` is the normal state after a rename (I-20 / ADR-0014);
 * `TIMELINE_WORLD_TIME_REVERSED` is a flashback (I-19, "报不拒"); and `FORESHADOW_DUE_NOW`
 * is "this is the chapter to pay it off in" — an opportunity, not a mistake. Everything
 * else is a warning; `blocking` is never produced by a read (see `findings.ts`).
 */
const INFO_CODES: ReadonlySet<string> = new Set([
  'ID_PATH_DIVERGED',
  'TIMELINE_WORLD_TIME_REVERSED',
  'FORESHADOW_DUE_NOW',
  // A relation window whose boundary this book cannot place (a free label, or a chapter
  // id it does not have) is "cannot say", not "says the opposite" — information for the
  // author, never an accusation.
  'RELATION_PERIOD_UNCOMPARABLE',
])

/**
 * What to *do* about each code, in one sentence a person can act on.
 *
 * One per code, asserted by `tests/audit.test.js`: a code without a hint would print the
 * machine's meaning twice, and "hint = meaning" is the report the audit was written to replace.
 */
const HINTS: Readonly<Record<string, string>> = {
  // structure
  OUTLINE_NO_OVERALL: '建一份 overall 大纲（outlines/ 下 kind: overall），其余大纲都挂在它下面',
  OUTLINE_MULTIPLE_OVERALL: '只保留一份 kind: overall 的大纲，其余改成 volume 或 chapter 并改 parent',
  OUTLINE_VOLUME_PARENT: '把该卷大纲的 parent 指向 overall 大纲的 id',
  OUTLINE_VOLUME_IN_VOLUME: '把卷大纲挂到 overall 下：卷中卷不支持（三层为上限）',
  OUTLINE_CHAPTER_IN_CHAPTER: '把章大纲挂到卷大纲或 overall 下：章挂章超三层',
  CHARACTER_NAME_DUPLICATE: '改掉其中一个角色名（或别名）；归一化后重名会让提及统计串台',
  DUPLICATE_ID: '给其中一个实体换一个 id：同一 kind 内 id 是主键，先出现的文件会赢',
  DANGLING_PARENT: '把 parent 改成存在的条目 id，或去掉 parent 让它成为顶层条目',
  WORLD_ROOT_MISSING: '分类书缺根条目：补一份 world/ 下的根条目，或把条目全部平铺在分类目录里',
  WORLD_ROOT_MULTIPLE: '世界观只允许一个根条目：把多余的根条目挂成它的子条目',
  WORLD_CATEGORY_REQUIRED: '给非根世界观条目补 category（世界书靠它分桶）',
  RELATION_ENDPOINT: '把关系两端改成各恰一个存在的实体 id，或删掉这条关系',
  RELATION_SELF_LOOP: '删掉自环，或把它改成两个不同实体之间的关系',
  RELATION_DUPLICATE: '删掉重复的关系文件：同 (source, target, kind) 只保留一条',
  RELATION_FIELD_DEPRECATED: '删掉废弃字段（如 direction），换成现行字段名',
  // The window rules. The hint names the one decision the tool cannot make — which of
  // two windows is the true one — because "merge them" would silently move the relation in time.
  RELATION_PERIOD_CONFLICT: '把这条关系的 since/until 改成成立的一段（since 早于 until）：两条边写了两套时段时，删掉错的那条或改成同一套',
  RELATION_PERIOD_UNCOMPARABLE: '把 since/until 写成本书的章 id（世界内时间在章序里没有位置）；不打算按章算就留空，留标签只会报「无法判定」',
  FRONTMATTER_ISSUE: '修好这条 frontmatter：键值写成「键: 值」，数组写成块列表',
  ENTITIES_DRIFT: '重跑一次索引重建；仍旧漂移说明同一次 scan 的两个写入点被改坏了',
  ID_PATH_DIVERGED: '不用处理：改名后旧 id 被钉住是正常状态（ADR-0014），引用才能继续解析',
  // ledger
  FACT_LINE_MALFORMED: '把这一行改成「属性: 值」，段之间用 | 分隔，值里出现 | 时写成 \\|',
  FACT_CONFLICT: '给其中一条加 since/until 划清生效区间，或改成同一个取值',
  // foreshadow
  FORESHADOW_RESOLVED_WITHOUT_CHAPTER: '补 resolvedChapter（回收它的那一章），或把状态改回 advanced/planted',
  FORESHADOW_TRANSITION_INVALID: '让 status 与 resolved/advancedAt 一致：resolved 是终态，advanced 必须有推进位置',
  FORESHADOW_OVERDUE: '在下一章回收它，或把 dueBy 顺延到它真正该回收的位置',
  FORESHADOW_DUE_NOW: '本章就是它该回收的位置：写进去，或把 dueBy 往后挪',
  // timeline
  TIMELINE_TIME_MISSING: '给事件补 worldTime（YYYY[-MM[-DD]]）；时间还没定就标成 unconfirmed',
  TIMELINE_TIME_INVALID: '把 worldTime 改成真实日期：月 1–12、日必须存在',
  TIMELINE_ORDER_CONFLICT: '同一叙事槽位只能声明一个世界时间：改 narrativeOrder 或改 worldTime',
  TIMELINE_WORLD_TIME_REVERSED: '不用处理：叙事顺序递增而世界时间倒退就是倒叙',
  // catalog
  CATALOG_STALE: '重跑一次索引重建（写工具会自动重建 catalog）；手改过目录名的话先改回来',
  CATALOG_DUPLICATE: '一章只能出现在一个卷的一条 catalog 项里：删掉重复项或改掉重复的 seq',
  VOLUME_DIR_MISMATCH: '把卷目录名改成 <volumeId>-<slug>，并同步卷大纲与 volumeId',
  CHAPTER_FILE_MISSING: 'catalog 指向的章文件不在了：从回收站恢复，或删掉这条 catalog 项',
  CHAPTER_NOT_MARKDOWN: '把该文件改成 .md，或移出 chapters/（catalog 的 index.json 除外）',
  // Codes a domain emits from **both** a scan and a write plan: a hand-written file raises
  // them, and a bad tool argument reuses the same code. They are in `FINDING_CODES`
  // (group structure, `fixable: false`) since the classification gap surfaced on the board, so the
  // report has a real hint for each instead of printing a bare code.
  CHARACTER_NAME_REQUIRED: '给角色卡补 name（文件名只是位置，不能当名字用）',
  CHARACTER_FIRST_APPEARANCE_INVALID: '把 firstAppearance 改成正整数章号，或删掉这个字段',
  OUTLINE_KIND_UNKNOWN: '给这份大纲补 kind: overall / volume / chapter',
  KEYWORD_INVALID: '把世界书条目的 keywords 改成字符串列表（一个元素一个关键词）',
  PARTICIPANT_INVALID: '时间线事件的 participants 只能写角色 id，逗号或空值会被拒',
}


/** Report severity for a code. An unknown code is a warning: never silently informational. */
export function severityOf(code: string): FindingSeverity {
  return INFO_CODES.has(code) ? 'info' : 'warning'
}

/**
 * The one-line action for a code.
 *
 * Falls back to the catalogue's `meaning`, then to a sentence that says what a bare code
 * means here, so a code added by a later batch never prints as its own name twice.
 */
export function hintOf(code: string): string {
  return HINTS[code] ?? findingCode(code)?.meaning ?? '没有专门提示的码：按 data-model §5 找到它对应的不变量后修正'
}

/** Group for a code; an unknown code is filed under `structure`, the catch-all family. */
function groupOf(code: string): FindingGroup {
  return findingCode(code)?.group ?? 'structure'
}

function fixableOf(code: string): boolean {
  return findingCode(code)?.fixable ?? false
}

// ---------------------------------------------------------------------------
// Locators: turn a scan address into the one form the panel and the report both use
// ---------------------------------------------------------------------------

/** Everything a locator needs to name the *entity* rather than the file it lives in. */
interface LocatorContext {
  /** `path → { kind, id }` from the same scan, so a finding can point at an entity. */
  readonly entityByPath: ReadonlyMap<string, { kind: ContentDir; id: string }>
  /** `path → chapter id`, from the same chapter positions the lateness rule uses. */
  readonly chapterByPath: ReadonlyMap<string, string>
}

/**
 * `facts/x.md#L7` → `{ path: 'facts/x.md', line: 7 }`.
 *
 * The suffix is the ledger's own anchor format (`facts-plan.ts` `factAnchor`), invented
 * because one file holds many facts and a finding has to name the line. Every other family
 * addresses a whole file, so an anchor is the only thing to unwrap.
 */
function splitAnchor(path: string): { path: string; line?: number } {
  const match = /^(.*)#L(\d+)$/u.exec(path)
  if (match === null || match[1] === undefined || match[2] === undefined) return { path }
  const line = Number(match[2])
  return Number.isSafeInteger(line) && line > 0 ? { path: match[1], line } : { path }
}

/** `chapters/vol-02/index.json` → `vol-02`; the root catalog and any other path → `undefined`. */
function catalogVolumeOf(path: string): string | undefined {
  const parts = path.split('/')
  if (parts.length !== 3) return undefined
  const [dir, volume, file] = parts
  if (dir !== CHAPTERS_DIR || file !== CATALOG_FILE || volume === undefined || volume === '') return undefined
  return volume
}

/**
 * Where a finding points when the scan gave it no file: the book itself.
 *
 * `OUTLINE_NO_OVERALL` and `WORLD_ROOT_MULTIPLE` are properties of the whole project (there
 * is no single file to name), and `FindingLocator` has no "the book" variant — deliberately,
 * because the repair pass only ever repairs *files*. `.` is the project root, renders as `` `.` `` in the report
 * (whose header says what it means) and reads as 「整本书」 on the panel. The alternative
 * that was rejected: calling it a catalog finding, which would be a lie about which family
 * a missing overall outline belongs to.
 */
const BOOK_SCOPE: FindingLocator = { kind: 'path', path: '.' }

function locatorFor(issue: ValidationIssue, context: LocatorContext): FindingLocator {
  if (issue.path === undefined || issue.path === '') return BOOK_SCOPE
  const anchored = splitAnchor(issue.path)
  if (anchored.line !== undefined) return { kind: 'path', path: anchored.path, line: anchored.line }

  // A catalog file is addressed as a catalog, not as a path: the panel has a place for
  // "卷 vol-02 的 catalog" and none for a JSON file it cannot open.
  if (anchored.path === `${CHAPTERS_DIR}/${CATALOG_FILE}`) return { kind: 'catalog' }
  const volume = catalogVolumeOf(anchored.path)
  if (volume !== undefined) return { kind: 'catalog', volumeId: volume }

  const chapterId = context.chapterByPath.get(anchored.path)
  if (chapterId !== undefined) return { kind: 'chapter', chapterId }

  const entity = context.entityByPath.get(anchored.path)
  if (entity !== undefined) return { kind: 'entity', entityKind: entity.kind, id: entity.id }

  return { kind: 'path', path: anchored.path }
}

// ---------------------------------------------------------------------------
// The audit itself
// ---------------------------------------------------------------------------

/** Every group at zero — the shape a report prints even when a family is clean. */
export function emptyGroupCounts(): Record<FindingGroup, number> {
  return Object.fromEntries(FINDING_GROUPS.map((group) => [group, 0])) as Record<FindingGroup, number>
}

function countOf(findings: readonly Finding[]): AuditCounts {
  const byGroup = emptyGroupCounts()
  const severity: Record<FindingSeverity, number> = { blocking: 0, warning: 0, info: 0 }
  let fixable = 0
  for (const finding of findings) {
    byGroup[finding.group] += 1
    severity[finding.severity] += 1
    if (finding.fixable) fixable += 1
  }
  return { total: findings.length, byGroup, severity, fixable }
}

/**
 * The report's order: the shared contract first, then `detail` — see the module comment.
 *
 * `compareFindings` alone is total over `(group, severity, code, locator)`; the extra key
 * only ever breaks ties it left at zero, so a caller that trusts `compareFindings` gets a
 * prefix of the same answer.
 */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((left, right) => {
    const byContract = compareFindings(left, right)
    if (byContract !== 0) return byContract
    if (left.detail === right.detail) return left.hint < right.hint ? -1 : left.hint > right.hint ? 1 : 0
    return left.detail < right.detail ? -1 : 1
  })
}

/** Every entity address a scan produced, so findings can name entities instead of files. */
function entityIndex(scan: ScanResult): LocatorContext['entityByPath'] {
  const byPath = new Map<string, { kind: ContentDir; id: string }>()
  for (const entity of scan.entities) {
    // First writer wins: `scanProject` walks in sorted path order and drops same-key
    // duplicates the same way, so this cannot depend on readdir order.
    if (!byPath.has(entity.path)) byPath.set(entity.path, { kind: entity.kind, id: entity.id })
  }
  return byPath
}

/** `path → chapter id`; a chapter with no `id:` in its frontmatter is addressed by its path. */
function chapterIdByPath(positions: ReadonlyMap<string, ChapterPosition>): Map<string, string> {
  const byPath = new Map<string, string>()
  for (const position of positions.values()) {
    if (position.id === position.path) continue
    if (!byPath.has(position.path)) byPath.set(position.path, position.id)
  }
  return byPath
}

/** The book's title, read straight from `inkflow.json` (never through the gate: that writes). */
function titleOf(root: string): string | undefined {
  try {
    const raw = readFileSync(join(root, ROOT_META_FILE), 'utf8').replace(/^\uFEFF/u, '')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const title = (parsed as Record<string, unknown>)['title']
    return typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined
  } catch {
    return undefined
  }
}

/** One `ValidationIssue` → one `Finding`, with the catalogue's group/severity/hint. */
function toFinding(issue: ValidationIssue, context: LocatorContext): Finding {
  return {
    code: issue.code,
    group: groupOf(issue.code),
    severity: severityOf(issue.code),
    locator: locatorFor(issue, context),
    detail: issue.detail,
    hint: hintOf(issue.code),
    fixable: fixableOf(issue.code),
  }
}

/**
 * Run all five families and return them as one sorted list.
 *
 * Pure read: files are opened, nothing is written, and no index file is created (a book
 * whose index was never built audits fine, and `indexState` says as much).
 */
export function auditProject(root: string): AuditReport {
  const started = Date.now()

  // One scan produces four of the five families; the catalog's on-disk half is the fifth.
  const scan = scanProject(root)
  const catalog = validateCatalog(root)

  // Chapter positions come from the **files**, not the index: a stale cache would answer
  // "no such chapter" for the chapter a `dueBy` names, and the lateness rule would then go
  // quiet instead of reporting (the failure the writing reminder had already had).
  const positions = chapterPositionsFromFiles(root)
  const volumes = volumeOrdersOf(root)
  const current = latestChapter(positions)

  const context: LocatorContext = {
    entityByPath: entityIndex(scan),
    chapterByPath: chapterIdByPath(positions),
  }
  const findings: Finding[] = [...scan.issues, ...catalog.issues].map((issue) => toFinding(issue, context))

  // The lateness half of the foreshadow family: rows come from the same scan, the rule from
  // the domain (X-14 — the report does not get a second opinion about "超期").
  const foreshadows = rowsOf<ForeshadowRow>(scan, FORESHADOW_TABLE)
  for (const issue of foreshadowAuditIssues(foreshadows, current, positions, volumes)) {
    findings.push(toFinding(issue, context))
  }

  const sorted = sortFindings(findings)
  const title = titleOf(root)
  return {
    root,
    findings: sorted,
    counts: countOf(sorted),
    source: 'files',
    indexState: checkIndexFreshness(root).state,
    catalogStale: catalog.catalogStale,
    ms: Date.now() - started,
    ...(title === undefined ? {} : { title }),
  }
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

/** The five family labels, in the order the report prints them (X-14's group order). */
const GROUP_LABELS: Readonly<Record<FindingGroup, string>> = {
  structure: '结构不变量',
  ledger: '事实账本',
  foreshadow: '伏笔超期',
  timeline: '时间线',
  catalog: 'catalog 偏差',
}

export interface RenderOptions {
  /** Cap the findings printed per family; the counts always describe every finding. */
  limit?: number
}

/**
 * The report body: five sections, one line per finding, the hints, the totals.
 *
 * Line shape: `` - `CODE` · `address` · detail `` — code and address in backticks so they
 * survive a paste into an issue, detail in the author's language. The hint is printed
 * **once per code** at the end rather than on every line: twenty copies of one sentence is
 * noise, and the reader's question is "what do I do about this *kind* of problem".
 *
 * Nothing here reads the clock, the root path or the index state, so two runs on an
 * unchanged book produce the same bytes (the file name carries the time).
 */
export function renderAuditReport(report: AuditReport, options: RenderOptions = {}): string {
  const limit = Math.max(1, options.limit ?? AUDIT_LIST_LIMIT)
  const title = report.title === undefined ? '（未命名）' : report.title
  const { counts } = report
  const lines: string[] = [
    `# 一致性体检报告 · 《${title}》`,
    '',
    `- 范围：${FINDING_GROUPS.map((group) => GROUP_LABELS[group]).join(' · ')}`,
    `- 共 ${String(counts.total)} 项（warning ${String(counts.severity.warning)} · info ${String(counts.severity.info)}），其中 ${String(counts.fixable)} 项可由一键修复处理`,
    '- 定位写法：`kind:id` 是实体、`chapter:<章 id>` 是章、`path#L<n>` 是文件的第 n 行、`catalog[:卷 id]` 是卷章目录、`.` 是整本书',
  ]
  if (report.catalogStale) lines.push('- catalog 与正文不一致：用写工具的自动重建，或手工重跑一次索引重建')

  for (const group of FINDING_GROUPS) {
    const items = report.findings.filter((finding) => finding.group === group)
    lines.push('', `## ${GROUP_LABELS[group]}（${String(items.length)}）`, '')
    if (items.length === 0) {
      lines.push('无。')
      continue
    }
    for (const finding of items.slice(0, limit)) {
      lines.push(`- \`${finding.code}\` · \`${locatorKey(finding.locator)}\` · ${finding.detail}`)
    }
    if (items.length > limit) lines.push(`- …还有 ${String(items.length - limit)} 项同类问题（面板里可看全）`)
  }

  const codes = [...new Set(report.findings.map((finding) => finding.code))]
  if (codes.length > 0) {
    lines.push('', '## 修复提示', '')
    for (const code of codes) lines.push(`- \`${code}\` · ${hintOf(code)}`)
  }

  lines.push('', '## 汇总', '', '| 类 | 项数 |', '|---|---|')
  for (const group of FINDING_GROUPS) lines.push(`| ${GROUP_LABELS[group]} | ${String(counts.byGroup[group])} |`)
  lines.push(`| 合计 | ${String(counts.total)} |`, '')
  return `${lines.join('\n')}\n`
}

// ---------------------------------------------------------------------------
// Exporting to `<book>/.inkflow/audit/` (ADR-0012 decision 6: derived, deletable, never in git)
// ---------------------------------------------------------------------------

export interface AuditExportOk {
  readonly ok: true
  /** Project-relative path of the report. */
  readonly path: string
  readonly bytes: number
  readonly created: boolean
  /** `true` when `.gitignore` gained the `.inkflow/` line in this same action. */
  readonly ignoreLineAdded: boolean
}

export interface AuditExportFailure {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string; readonly path?: string }
}

export type AuditExportResult = AuditExportOk | AuditExportFailure

/** `audit-20261024-015300.md`: sortable, unique per second, no colons (Windows). */
export function auditReportName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp =
    `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `audit-${stamp}.md`
}

/**
 * Write the report into the book's private state directory.
 *
 * The one write in this module, under ADR-0012's two rules:
 *   * the land is `.inkflow/audit/` — derived, deletable, outside git — reached through
 *     `writeTextAtomic` → `resolveWriteTarget`, the only door that enforces the three
 *     whitelisted subdirectories and refuses `..`/absolute/symlinked escapes;
 *   * `.gitignore` gains `.inkflow/` on **first use** (`ensurePrivateStateIgnored`,
 *     append-only), never from the gate.
 *
 * A failed `ensurePrivateStateIgnored` does not fail the export: an unwritable `.gitignore`
 * is a repository problem, and losing the report over it would be the wrong trade (the same
 * call the bin makes before a restore).
 */
export function exportAuditReport(root: string, report: AuditReport, now: Date = new Date()): AuditExportResult {
  const relative = privateStateRelative('audit', auditReportName(now))
  const ignored = ensurePrivateStateIgnored(root)
  const written = writeTextAtomic(root, relative, renderAuditReport(report))
  if (!written.ok) {
    return {
      ok: false,
      error: {
        code: written.error.code,
        message: written.error.message,
        ...(written.error.path === undefined ? {} : { path: written.error.path }),
      },
    }
  }
  return {
    ok: true,
    path: relative,
    bytes: written.bytes,
    created: written.created,
    ignoreLineAdded: ignored.ok && ignored.added,
  }
}

/** The vocabulary, re-exported so a caller can list codes without importing `findings.ts`. */
export { FINDING_CODES }
