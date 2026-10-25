/**
 * 门禁结论的形状：报告类型、计数、结论文件与回执序列化（[ADR-0022](../../.agents/adrs/0022-writing-context-gate-findings.md) D4）。
 *
 * 从 `gate.ts` 拆出来的原因只有一个：`gate.ts` 又要读文件、又要跑八条规则、又要处理按书口径
 * （[ADR-0028](../../.agents/adrs/0028-gate-calibration-per-book.md)），三件事挤在一个文件里会
 * 顶到 600 行的约定。**序列化不是判定**——它只把已经算好的结论摊平成字节，所以它有自己的文件，
 * 而规则、词表、口径各在各的文件里。
 *
 * 两条契约原样搬过来，一个字都没改：
 *
 *   * 结论文件的**键序是契约的一部分**（同输入同字节，可 diff）；
 *   * 文件里没有时间戳、没有随机 id、没有绝对路径。
 */

import { GATE_CHECK_IDS, gateCheckOf } from './gate-vocabulary.js'
import type { GateCheckId, GateThresholds } from './gate-vocabulary.js'
import type { GateWaiverHit, GateWaivers } from './gate-waiver.js'
import type { Finding, FindingSeverity } from './findings.js'
import { privateStateRelative } from './private-state.js'

/**
 * Bumped when the file's shape changes; the gate file is a fact, not a cache.
 *
 * v2: the `waivers` block ([ADR-0028](../../.agents/adrs/0028-gate-calibration-per-book.md) D6) —
 * 「本作有几条豁免、这次豁免了哪几处」必须和判决一起落盘，否则作者下次读结论时看不到自己
 * 声明过什么。
 */
export const GATE_FILE_SCHEMA_VERSION = 2

/** How many findings a tool reply or the panel prints before saying "and N more". */
export const GATE_LIST_LIMIT = 100

export interface GateCounts {
  readonly total: number
  /** Findings the repair pass claims it can fix — always 0 today (see `gate-rules.ts`). */
  readonly fixable: number
  readonly warning: number
  readonly info: number
  readonly byCheck: Readonly<Record<GateCheckId, number>>
}

/** One row of the eight. `count` is the number of its findings, never a pass/fail flag. */
export interface GateCheckSummary {
  readonly id: GateCheckId
  readonly label: string
  readonly count: number
}

/** The verdict for one chapter: what the panel shows, what the file holds. */
export interface GateReport {
  readonly chapterId: string
  readonly chapterPath: string
  readonly chapterTitle: string
  readonly seq: number | undefined
  readonly wordCount: number
  readonly chapterDigest: string
  readonly thresholds: GateThresholds
  /** 按书口径的留痕：白名单有几条、这次豁免了哪几处（ADR-0028 D6）。 */
  readonly waivers: GateWaivers
  readonly counts: GateCounts
  readonly checks: readonly GateCheckSummary[]
  /** Sorted by `compareFindings` and then by `detail`, so two runs cannot reorder. */
  readonly findings: readonly Finding[]
}

/** `gate-<chapterId>.json`: the chapter id, made safe for a file name, nothing else. */
export function gateFileName(chapterId: string): string {
  const safe = chapterId.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return `gate-${safe === '' ? 'chapter' : safe}.json`
}

/** The project-relative path the conclusion lands at (X-25: `.inkflow/`, never `index/`). */
export function gateFilePath(chapterId: string): string {
  return privateStateRelative('audit', gateFileName(chapterId))
}

/** Per-check and per-severity counts, computed from the findings that survived the waivers. */
export function countsOf(findings: readonly Finding[], checks: readonly GateCheckSummary[]): GateCounts {
  const byCheck = Object.fromEntries(GATE_CHECK_IDS.map((id) => [id, 0])) as Record<GateCheckId, number>
  const severity: Record<FindingSeverity, number> = { blocking: 0, warning: 0, info: 0 }
  let fixable = 0
  for (const finding of findings) {
    const check = gateCheckOf(finding.code)
    if (check !== undefined) byCheck[check] += 1
    severity[finding.severity] += 1
    if (finding.fixable) fixable += 1
  }
  for (const summary of checks) byCheck[summary.id] = summary.count
  return { total: findings.length, fixable, warning: severity.warning, info: severity.info, byCheck }
}

function locatorRecord(finding: Finding): Record<string, unknown> {
  const locator = finding.locator
  switch (locator.kind) {
    case 'entity':
      return { kind: 'entity', entityKind: locator.entityKind, id: locator.id }
    case 'chapter':
      return { kind: 'chapter', chapterId: locator.chapterId }
    case 'catalog':
      return locator.volumeId === undefined ? { kind: 'catalog' } : { kind: 'catalog', volumeId: locator.volumeId }
    case 'path':
      return locator.line === undefined
        ? { kind: 'path', path: locator.path }
        : { kind: 'path', path: locator.path, line: locator.line }
  }
}

/** One finding as the file and the wire both carry it; `check` is derived from the code. */
export function gateFindingRecord(finding: Finding): Record<string, unknown> {
  return {
    check: gateCheckOf(finding.code) ?? 'proofread',
    code: finding.code,
    group: finding.group,
    severity: finding.severity,
    locator: locatorRecord(finding),
    detail: finding.detail,
    hint: finding.hint,
    fixable: finding.fixable,
  }
}

/** One applied waiver, in the one shape the file and the wire share. */
export function waiverRecord(hit: GateWaiverHit): Record<string, unknown> {
  return { code: hit.code, locator: hit.locator, fragment: hit.fragment, whitelistLine: hit.whitelistLine }
}

function waiversRecord(waivers: GateWaivers): Record<string, unknown> {
  return { configured: waivers.configured, applied: waivers.applied.map((hit) => waiverRecord(hit)) }
}

/**
 * The conclusion file's bytes (ADR-0022 D4): no timestamp, no absolute path, fixed keys.
 * `summary` is the "N 项 / 八项各几项" line the file needs to be readable on its own.
 */
export function renderGateFile(report: GateReport): string {
  const payload = {
    schemaVersion: GATE_FILE_SCHEMA_VERSION,
    chapterId: report.chapterId,
    chapterPath: report.chapterPath,
    chapterTitle: report.chapterTitle,
    seq: report.seq ?? null,
    wordCount: report.wordCount,
    chapterDigest: report.chapterDigest,
    thresholds: {
      wordCountMin: report.thresholds.wordCountMin,
      wordCountMax: report.thresholds.wordCountMax,
      aiDashPer1000: report.thresholds.aiDashPer1000,
      aiEllipsisPer1000: report.thresholds.aiEllipsisPer1000,
      aiSentenceMeanMax: report.thresholds.aiSentenceMeanMax,
      aiSentenceEvenness: report.thresholds.aiSentenceEvenness,
      aiModifierPer1000: report.thresholds.aiModifierPer1000,
      maxFindingsPerRule: report.thresholds.maxFindingsPerRule,
    },
    waivers: waiversRecord(report.waivers),
    counts: {
      total: report.counts.total,
      fixable: report.counts.fixable,
      warning: report.counts.warning,
      info: report.counts.info,
      byCheck: Object.fromEntries(GATE_CHECK_IDS.map((id) => [id, report.counts.byCheck[id]])),
    },
    checks: report.checks.map((summary) => ({ id: summary.id, label: summary.label, count: summary.count })),
    findings: report.findings.map((finding) => gateFindingRecord(finding)),
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/** The report on the wire: counts cover everything, only `findings` is capped. */
export function gateWire(report: GateReport, limit = GATE_LIST_LIMIT): Record<string, unknown> {
  const capped = report.findings.slice(0, Math.max(1, limit))
  return {
    chapterId: report.chapterId,
    chapterPath: report.chapterPath,
    chapterTitle: report.chapterTitle,
    seq: report.seq ?? null,
    wordCount: report.wordCount,
    chapterDigest: report.chapterDigest,
    waivers: waiversRecord(report.waivers),
    counts: report.counts,
    checks: report.checks,
    findings: capped.map((finding) => gateFindingRecord(finding)),
    returned: capped.length,
    truncated: report.findings.length > capped.length,
    /** Where the conclusion lands; the read route reports the path without writing it. */
    recordPath: gateFilePath(report.chapterId),
  }
}
