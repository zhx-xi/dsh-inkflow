/**
 * The consistency audit (#33, roadmap X-14, DoD D3-3).
 *
 * What this suite has to prove — each half is a way the report could be useless:
 *
 *   1. **Five families, one list, one order.** A report that forgets a family, or that
 *      reorders itself between two runs, is unreadable in a diff. `compareFindings` is the
 *      shared contract, `sortFindings` adds the last tiebreak, and two runs on an unchanged
 *      book must be byte-identical.
 *   2. **Every finding is addressable and explained.** Each locator has to render into an
 *      address a person can paste (`locatorKey`), the panel has to have wording for every
 *      code the audit emits, and the repair hint must be a sentence rather than the code
 *      repeated back.
 *   3. **The audit writes nothing.** It is a read path, so the assertion is a whole-tree
 *      fingerprint around it — with the index already built, so a careless "open the cache"
 *      cannot slip by unnoticed.
 *   4. **Lateness reads the files, not the cache.** A stale index must not make a late
 *      foreshadow look settled: that is exactly the failure #31 fixed for the reminder.
 *   5. **Export is the only write**, it lands in `.inkflow/audit/` (ADR-0012), and it refuses
 *      without `confirm: true`.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  FINDING_CODES,
  apply,
  auditProject,
  auditReportName,
  auditWire,
  buildAudit,
  buildIndex,
  compareFindings,
  exportAudit,
  exportAuditReport,
  hintOf,
  locatorKey,
  rebuildCatalog,
  renderAuditReport,
  severityOf,
  sortFindings,
} from '../lib/index.js'
import { hashTree } from './hash-tree.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)

const DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-audit-'))
}

/** A gate-usable project: `.git`, the nine content directories, `index/` and the meta file. */
function scaffold(root, title = '体检样例') {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title }, null, 2)}\n`, 'utf8')
}

function writeMarkdown(root, relativePath, frontmatter = [], body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = frontmatter.length === 0 ? '' : `---\n${frontmatter.join('\n')}\n---\n\n`
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

/**
 * Three chapters in one volume plus one problem per family — the fixture every assertion
 * below is about. Kept in one place so a changed detail cannot silently weaken two tests.
 *
 * Chapters are numbered 1–3, so `dueBy: ch-1` is **late** and `dueBy: ch-3` is **due now**.
 */
function dirtyBook(root) {
  scaffold(root)
  for (const [id, seq] of [['ch-1', 1], ['ch-2', 2], ['ch-3', 3]]) {
    writeMarkdown(root, `chapters/vol-01/000${String(seq)}-x.md`, [
      `id: ${id}`,
      `title: 第 ${String(seq)} 章`,
      `seq: ${String(seq)}`,
      'volume: vol-01',
      'status: draft',
    ], '正文。')
  }
  // catalog is deliberately NOT written: that is the catalog family's problem (CATALOG_STALE).
  writeFileSync(join(root, 'chapters/vol-01/notes.txt'), '不是 Markdown\n', 'utf8')

  // structure: no overall outline, and a volume outline with the wrong parent.
  writeMarkdown(root, 'outlines/vol-01.md', ['id: outline-vol-01', 'kind: volume', 'title: 卷一'])
  // structure: two cards whose names collide after normalisation.
  writeMarkdown(root, 'characters/清音.md', ['id: char-qingyin', 'name: 清音'])
  writeMarkdown(root, 'characters/清音·影.md', ['id: char-qingyin-2', 'name: 清音'])

  // foreshadow: one late, one due now, one resolved (never late) and one that contradicts itself.
  writeMarkdown(root, 'foreshadowing/late.md', [
    'id: fs-late',
    'title: 迟到的伏笔',
    'status: advanced',
    'advancedAt:',
    '  - ch-1',
    'dueBy: ch-1',
  ])
  writeMarkdown(root, 'foreshadowing/now.md', ['id: fs-now', 'title: 正好到期', 'status: planted', 'dueBy: ch-3'])
  writeMarkdown(root, 'foreshadowing/done.md', ['id: fs-done', 'title: 已回收', 'status: resolved', 'dueBy: ch-1', 'resolvedChapter: ch-2'])
  writeMarkdown(root, 'foreshadowing/bad.md', ['id: fs-bad', 'title: 自相矛盾', 'status: planted', 'advancedAt:', '  - ch-2'])

  // ledger: one conflict (overlapping intervals, different values) and one unparsable line.
  writeMarkdown(root, 'facts/char-qingyin.md', ['id: facts-qingyin', 'subject: char-qingyin', 'title: 清音的账'], [
    '- attribute: 修为 | value: 筑基后期 | since: ch-1 | until: ch-3',
    '- attribute: 修为 | value: 金丹 | since: ch-2',
    '- 这一行不是一条事实',
    '',
  ].join('\n'))

  // timeline: a confirmed event with no world time.
  writeMarkdown(root, 'timeline/event-a.md', ['id: ev-a', 'title: 事件甲', 'status: confirmed', 'narrativeOrder: 1'])

  // relations: a self loop.
  writeMarkdown(root, 'relations/loop.md', ['id: rel-loop', 'source: char-qingyin', 'target: char-qingyin', 'kind: character'])
}

function codesOf(report) {
  return report.findings.map((finding) => finding.code)
}

function byCode(report, code) {
  return report.findings.filter((finding) => finding.code === code)
}

// ---------------------------------------------------------------------------
// 1. Five families, one list, one order
// ---------------------------------------------------------------------------

test('audit: all five families arrive as one sorted list with honest counts', () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    dirtyBook(root)
    const report = auditProject(root)

    assert.equal(report.source, 'files', 'the audit answers from the files, never from a cache')
    assert.deepEqual(
      [...new Set(report.findings.map((finding) => finding.group))].sort(),
      ['catalog', 'foreshadow', 'ledger', 'structure', 'timeline'],
      'every one of the five families contributes a finding in this fixture',
    )
    assert.equal(report.counts.total, report.findings.length)
    const summed = Object.values(report.counts.byGroup).reduce((sum, count) => sum + count, 0)
    assert.equal(summed, report.counts.total, 'byGroup sums to the total')
    assert.equal(
      report.counts.severity.warning + report.counts.severity.info + report.counts.severity.blocking,
      report.counts.total,
      'every finding has exactly one severity',
    )
    assert.equal(report.counts.severity.blocking, 0, 'a read never produces `blocking` (findings.ts)')

    // The order is the shared contract, and nothing in it is out of place.
    for (let index = 1; index < report.findings.length; index += 1) {
      assert.ok(
        compareFindings(report.findings[index - 1], report.findings[index]) <= 0,
        `findings must be ordered by compareFindings at ${String(index)}`,
      )
    }

    // Every family's headline problem is actually reported.
    for (const code of [
      'OUTLINE_NO_OVERALL',
      'CHARACTER_NAME_DUPLICATE',
      'FACT_CONFLICT',
      'FACT_LINE_MALFORMED',
      'FORESHADOW_OVERDUE',
      'FORESHADOW_DUE_NOW',
      'FORESHADOW_TRANSITION_INVALID',
      'TIMELINE_TIME_MISSING',
      'CATALOG_STALE',
      'CHAPTER_NOT_MARKDOWN',
      'RELATION_SELF_LOOP',
    ]) {
      assert.ok(codesOf(report).includes(code), `${code} must be reported for this book`)
    }

    // The lateness rule's two exclusions: resolved setups are never late, and a `dueBy` that
    // points at a later chapter is neither late nor due now (it is `fs-done`, resolved).
    assert.equal(byCode(report, 'FORESHADOW_OVERDUE').length, 1, 'exactly one late setup')
    assert.equal(byCode(report, 'FORESHADOW_OVERDUE')[0].locator.kind, 'entity')
    assert.match(byCode(report, 'FORESHADOW_OVERDUE')[0].detail, /dueBy「ch-1」/u)
    assert.equal(byCode(report, 'FORESHADOW_DUE_NOW').length, 1, 'exactly one due-now setup')
    assert.equal(severityOf('FORESHADOW_DUE_NOW'), 'info', 'due-now is a hint, not a defect')
    assert.equal(severityOf('ID_PATH_DIVERGED'), 'info')
    assert.equal(severityOf('FACT_CONFLICT'), 'warning')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audit: a clean book reports nothing at all', () => {
  const dir = workdir()
  try {
    const root = join(dir, 'clean')
    scaffold(root, '干净的书')
    writeMarkdown(root, 'outlines/overall.md', ['id: outline-overall', 'kind: overall', 'title: 整体'])
    // A book with catalogs and no content is the one shape in which all five families can be
    // silent, so this is the false-positive net: `rebuildCatalog` writes them the way a write
    // tool would.
    rebuildCatalog(root)
    const report = auditProject(root)
    assert.deepEqual(
      report.findings.map((finding) => `${finding.code} ${locatorKey(finding.locator)}`),
      [],
      'an empty but well-formed book has no findings',
    )
    assert.equal(report.counts.total, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. Every finding is addressable and explained
// ---------------------------------------------------------------------------

test('audit: every locator renders a usable address and every code has panel wording', async () => {
  const panel = await loadClientModel('library-model.ts')
  const auditModel = await loadClientModel('audit-model.ts')
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    dirtyBook(root)
    const report = auditProject(root)

    const addresses = new Map()
    for (const finding of report.findings) {
      const address = locatorKey(finding.locator)
      assert.ok(address !== '', `${finding.code} must render an address`)
      switch (finding.locator.kind) {
        case 'entity':
          assert.ok(address.includes(':'), `an entity address is kind:id, got ${address}`)
          assert.ok(address.startsWith(`${finding.locator.entityKind}:`), `address ${address} names its kind`)
          break
        case 'chapter':
          assert.equal(address, `chapter:${finding.locator.chapterId}`)
          break
        case 'catalog':
          assert.match(address, /^catalog:(vol-\d+)?$/u, `catalog address, got ${address}`)
          break
        case 'path':
          assert.match(address, finding.locator.line === undefined ? /^[^#]+$/u : /^[^#]+#L\d+$/u)
          break
      }
      assert.equal(hintOf(finding.code).trim() === finding.code, false, `${finding.code} has a real hint, not its own name`)
      const seen = addresses.get(finding.code) ?? []
      assert.equal(seen.includes(address), false, `${finding.code} at ${address} appears twice — one row per problem`)
      addresses.set(finding.code, [...seen, address])

      // The panel must be able to name the code; an unknown one is printed verbatim, which
      // this fixture would then expose (`FACT_CONFLICT` used to read as itself).
      assert.notEqual(panel.describeIssueCode(finding.code), finding.code, `the panel has no wording for ${finding.code}`)
    }

    // The three address shapes the issue asks for are all present, plus the book-wide one.
    const all = [...addresses.values()].flat()
    assert.ok(all.some((address) => address.includes('#L')), 'a line-anchored address exists')
    assert.ok(all.some((address) => address.startsWith('catalog:')), 'a catalog address exists')
    assert.ok(
      addresses.get('CHARACTER_NAME_DUPLICATE')?.every((address) => address.startsWith('characters:')) === true,
      'entities are addressed as kind:id',
    )
    assert.deepEqual(addresses.get('OUTLINE_NO_OVERALL'), ['.'], 'a book-wide problem is addressed as the whole book')

    // And every finding can say where a click would go (or that it cannot).
    const jumpable = report.findings.filter((finding) => {
      const target = auditModel.jumpTargetOf(finding.locator)
      if (target === null) return false
      assert.ok(target.kind === 'chapter' || target.kind === 'entity')
      return true
    })
    assert.ok(jumpable.length >= 3, 'the fixture has at least one jumpable finding per kind')
    for (const finding of report.findings) {
      const label = auditModel.locateLabel(finding.locator)
      assert.ok(label === null || label.trim() !== '', 'a locator either has wording or explicitly has none')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audit: every catalogue code carries a hint of its own', () => {
  // The five codes a domain emits from both a scan and a write plan used to sit outside the
  // catalogue (they reached the report through SCAN_ONLY_CODES). They are in FINDING_CODES
  // now, so this loop covers them — and the "no code is both" clause it used to assert is
  // gone with the table, because being both is exactly what they are.
  for (const entry of FINDING_CODES) {
    const hint = hintOf(entry.code)
    assert.ok(hint.trim() !== '', `${entry.code} has no hint`)
    assert.notEqual(hint, entry.code, `${entry.code} falls back to its own name`)
  }
})

// ---------------------------------------------------------------------------
// 3. The report itself
// ---------------------------------------------------------------------------

test('audit: the Markdown report is one line per finding, five sections and a totals table', () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    dirtyBook(root)
    const report = auditProject(root)
    const body = renderAuditReport(report)

    assert.match(body, /^# 一致性体检报告 · 《体检样例》$/mu)
    for (const heading of ['## 结构不变量（', '## 事实账本（', '## 伏笔超期（', '## 时间线（', '## catalog 偏差（']) {
      assert.ok(body.includes(heading), `the report has a ${heading} section`)
    }
    assert.ok(body.includes('## 修复提示'), 'the hints are printed once per code')
    assert.ok(body.includes('## 汇总'), 'the totals section exists')
    assert.match(body, /\| 合计 \| \d+ \|/u, 'the totals table ends with a grand total')

    // One line per finding, in the documented shape: `CODE` · `address` · detail. The hints
    // section reuses the same bullet shape, so counting stops at its heading.
    const findingSection = body.slice(0, body.indexOf('## 修复提示'))
    const findingLines = findingSection.split('\n').filter((line) => /^- `[A-Z][A-Z0-9_]+` · `/u.test(line))
    assert.equal(findingLines.length, report.findings.length, 'exactly one line per finding')
    for (const finding of report.findings.slice(0, 5)) {
      const needle = `- \`${finding.code}\` · \`${locatorKey(finding.locator)}\` · `
      assert.ok(body.includes(needle), `line for ${finding.code} at ${locatorKey(finding.locator)}`)
    }

    // Two things that must NOT be in a body whose whole point is being diffable.
    assert.equal(/\d{4}-\d{2}-\d{2}T\d/u.test(body), false, 'no timestamp: the file name carries it')
    assert.equal(body.includes(root), false, 'no root path: the report describes the book, not the disk')
    assert.equal(body.endsWith('\n'), true, 'the file ends with one newline')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audit: two runs on an unchanged book produce byte-identical reports', () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    dirtyBook(root)
    const first = renderAuditReport(auditProject(root))
    const second = renderAuditReport(auditProject(root))
    assert.equal(second, first, 'the same book twice is the same bytes')

    // And through the export path, where the file name (not the body) carries the time.
    const early = new Date(2026, 9, 24, 1, 0, 0)
    const late = new Date(2026, 9, 24, 2, 30, 0)
    const one = exportAuditReport(root, auditProject(root), early)
    const two = exportAuditReport(root, auditProject(root), late)
    assert.equal(one.ok, true)
    assert.equal(two.ok, true)
    assert.equal(one.path, '.inkflow/audit/audit-20261024-010000.md')
    assert.equal(two.path, '.inkflow/audit/audit-20261024-023000.md')
    assert.equal(readFileSync(join(root, two.path), 'utf8'), readFileSync(join(root, one.path), 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audit: sortFindings is a total order that breaks ties on the detail', () => {
  const make = (detail, code = 'FRONTMATTER_ISSUE') => ({
    code,
    group: 'structure',
    severity: 'warning',
    locator: { kind: 'path', path: 'characters/清音.md' },
    detail,
    hint: 'h',
    fixable: false,
  })
  const a = make('甲')
  const b = make('乙')
  const forward = sortFindings([a, b]).map((finding) => finding.detail)
  const backward = sortFindings([b, a]).map((finding) => finding.detail)
  assert.deepEqual(forward, backward, 'two findings that tie on compareFindings still have one order')
  assert.equal(compareFindings(a, b), 0, 'the shared contract considers them equal, which is why the tiebreak exists')

  // The report order keeps the contract's grouping: group first, then severity.
  const info = { ...make('x', 'ID_PATH_DIVERGED'), severity: 'info' }
  const timeline = { ...make('x', 'ID_PATH_DIVERGED'), severity: 'info', group: 'timeline' }
  assert.deepEqual(
    sortFindings([timeline, info, a]).map((finding) => `${finding.group}:${finding.code}`),
    ['structure:FRONTMATTER_ISSUE', 'structure:ID_PATH_DIVERGED', 'timeline:ID_PATH_DIVERGED'],
  )
})

// ---------------------------------------------------------------------------
// 4. Zero writes on the read path
// ---------------------------------------------------------------------------

test('audit: scanning and reading the audit write nothing, even with an index present', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    dirtyBook(root)
    // An index already built: if the audit opened the cache for writing (or let sqlite create
    // `-wal`/`-shm`), the fingerprint below would move.
    await buildIndex(root)
    const before = hashTree(root)
    const report = auditProject(root)
    assert.ok(report.counts.total > 0, 'the fixture has findings, so the scan really ran')
    buildAudit({ sessionId: 'session-test', root }, 'test')
    assert.equal(hashTree(root), before, 'the read path must not touch a single file')

    // No private state directory is created by looking, either.
    assert.equal(existsSync(join(root, '.inkflow')), false, 'reading the audit creates no .inkflow/')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. Export: the one write, and only where it belongs
// ---------------------------------------------------------------------------

test('audit: export writes under .inkflow/audit, ignores it in git, and needs confirm', () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    dirtyBook(root)
    const report = auditProject(root)
    const contentBefore = contentDigests(root)

    // Without `confirm: true` the channel refuses and nothing is written.
    const refused = exportAudit({ sessionId: 'session-test', root }, 'test', {})
    assert.equal(refused.status, 400)
    assert.equal(refused.body.error.code, 'CONFIRM_REQUIRED')
    assert.equal(existsSync(join(root, '.inkflow')), false, 'a refusal writes nothing')

    const exported = exportAudit({ sessionId: 'session-test', root }, 'test', { confirm: true })
    assert.equal(exported.status, 200)
    const value = exported.body.value
    assert.equal(value.exported.path.startsWith('.inkflow/audit/audit-'), true)
    const file = join(root, value.exported.path)
    assert.equal(existsSync(file), true)
    assert.equal(readFileSync(file, 'utf8'), renderAuditReport(report), 'the file is the report body')

    // `.gitignore` gained exactly one line, append-only (ADR-0012 #2).
    assert.equal(readFileSync(join(root, '.gitignore'), 'utf8'), '.inkflow/\n')
    assert.equal(value.exported.ignoreLineAdded, true)

    // Nothing else in the book moved: the audit is derived, so a report cannot edit prose.
    assert.deepEqual(contentDigests(root), contentBefore, 'only .inkflow/ and .gitignore changed')

    // A second export is a new file, not a rewrite of the first.
    const again = exportAuditReport(root, report, new Date(2026, 9, 24, 1, 0, 1))
    assert.equal(again.ok, true)
    assert.equal(readdirSync(join(root, '.inkflow', 'audit')).length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audit: the report file name is sortable and has no characters Windows refuses', () => {
  assert.equal(auditReportName(new Date(2026, 9, 24, 1, 5, 3)), 'audit-20261024-010503.md')
  assert.equal(/[<>:"/\\|?*]/u.test(auditReportName(new Date())), false)
})

// ---------------------------------------------------------------------------
// 6. Lateness reads the files, not the index
// ---------------------------------------------------------------------------

test('audit: a stale index cannot make a late foreshadow look settled', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root, '超期测试')
    // Two chapters, a setup due in ch-2: at this point it is due now, not late.
    writeMarkdown(root, 'chapters/vol-01/0001-a.md', ['id: ch-1', 'title: 一', 'seq: 1', 'volume: vol-01'])
    writeMarkdown(root, 'chapters/vol-01/0002-b.md', ['id: ch-2', 'title: 二', 'seq: 2', 'volume: vol-01'])
    writeMarkdown(root, 'foreshadowing/reminder.md', ['id: fs-1', 'title: 该回收了', 'status: planted', 'dueBy: ch-2'])
    await buildIndex(root)

    const atDue = auditProject(root)
    assert.equal(byCode(atDue, 'FORESHADOW_DUE_NOW').length, 1, 'due in the current chapter is due now')
    assert.equal(byCode(atDue, 'FORESHADOW_OVERDUE').length, 0)

    // Now add a chapter WITHOUT rebuilding the index: the cache still says the book ends at
    // ch-2, the files say it ends at ch-3.
    writeMarkdown(root, 'chapters/vol-01/0003-c.md', ['id: ch-3', 'title: 三', 'seq: 3', 'volume: vol-01'])
    const after = auditProject(root)
    assert.equal(byCode(after, 'FORESHADOW_OVERDUE').length, 1, 'the new chapter makes the setup late')
    assert.equal(byCode(after, 'FORESHADOW_DUE_NOW').length, 0)
    assert.match(byCode(after, 'FORESHADOW_OVERDUE')[0].detail, /第 3 章/u, 'the detail names where the book got to')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7. The tool
// ---------------------------------------------------------------------------

/** A minimal Host harness: enough of `ctx` for `apply()` to register tools and routes. */
function makeTools(dataDir, workspace) {
  const tools = new Map()
  const ctx = {
    effect(setup) {
      const dispose = setup()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    inject(_deps, callback) {
      callback(ctx)
    },
    get(name) {
      if (name === 'workingDirectory' && typeof workspace === 'string') {
        return { ensure: async () => workspace }
      }
      return undefined
    },
    logger() {
      return { debug() {}, info() {}, warn() {}, error() {} }
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => {}
      },
    },
    webServer: { register() { return () => {} } },
  }
  apply(ctx, { dataDir })
  return tools
}

test('audit tool: reports counts plus the first N, and exports only with confirm', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    dirtyBook(root)
    const tools = makeTools(join(dir, 'state'), root)
    const tool = tools.get('inkflow_project_audit')
    assert.ok(tool, 'inkflow_project_audit is registered')
    const call = (args) => tool.execute(args, { signal: AbortSignal.timeout(20_000), agent: { id: 'test-session' } })

    const before = contentDigests(root)
    const plain = await call({})
    assert.equal(plain.ok, true)
    assert.equal(plain.root, root)
    assert.ok(plain.counts.total > 0)
    assert.equal(plain.findings.length, Math.min(plain.counts.total, 100))
    assert.equal(plain.exported, undefined, 'no export unless asked')
    assert.equal(plain.exportable, true)
    assert.deepEqual(plain.groups.map((group) => group.group), ['structure', 'ledger', 'foreshadow', 'timeline', 'catalog'])
    for (const finding of plain.findings) {
      assert.equal(locatorKey(finding.locator), finding.address, 'the wire address is the shared rendering')
      assert.ok(finding.detail !== '' && finding.hint !== '')
    }
    assert.deepEqual(contentDigests(root), before, 'a read tool writes nothing')

    // `limit` caps the list but never the counts (a 500-finding book must not read as 1).
    const capped = await call({ limit: 1 })
    assert.equal(capped.findings.length, 1)
    assert.equal(capped.counts.total, plain.counts.total)
    assert.equal(capped.truncated, plain.counts.total > 1)

    // Export without confirmation is refused, and the refusal is data, not a throw.
    const unconfirmed = await call({ export: true })
    assert.equal(unconfirmed.ok, false)
    assert.equal(unconfirmed.error.code, 'CONFIRM_REQUIRED')
    assert.deepEqual(contentDigests(root), before, 'a refused export writes nothing')

    const exported = await call({ export: true, confirm: true })
    assert.equal(exported.ok, true)
    assert.equal(exported.exported.path.startsWith('.inkflow/audit/audit-'), true)
    assert.equal(existsSync(join(root, exported.exported.path)), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('audit channel: GET /audit answers the same counts the engine does', () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    dirtyBook(root)
    const report = auditProject(root)
    const reply = buildAudit({ sessionId: 'session-test', root }, 'test', { limit: 2 })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.ok, true)
    const value = reply.body.value
    assert.equal(value.sessionId, 'session-test')
    assert.equal(value.title, '体检样例')
    assert.deepEqual(value.counts, auditWire(report, 2).counts)
    assert.equal(value.findings.length, 2)
    assert.equal(value.truncated, report.counts.total > 2)
    assert.equal(value.exportPath, '.inkflow/audit/audit-<时间戳>.md')
    // The five groups always travel, even when one of them is zero.
    assert.deepEqual(value.groups.map((group) => group.group), ['structure', 'ledger', 'foreshadow', 'timeline', 'catalog'])
    for (const finding of value.findings) {
      for (const key of ['code', 'group', 'severity', 'address', 'locator', 'detail', 'hint', 'fixable']) {
        assert.ok(key in finding, `a wire finding carries ${key}`)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Per-file digests of everything except the private state dir and `.gitignore`. */
function contentDigests(root) {
  const digests = new Map()
  const walk = (relative) => {
    const dir = relative === '' ? root : join(root, relative)
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (child === '.inkflow' || child === '.gitignore') continue
      if (entry.isDirectory()) {
        if (entry.name === '.git') {
          digests.set(child, `dir`)
          continue
        }
        walk(child)
        continue
      }
      const info = statSync(join(root, child))
      digests.set(child, `${String(info.size)}:${String(info.mtimeMs)}`)
    }
  }
  walk('')
  return Object.fromEntries([...digests.entries()].sort(([left], [right]) => (left < right ? -1 : 1)))
}

/** Bundle one client module on the fly with the project's own esbuild (same as panel tests). */
async function loadClientModel(file) {
  const esbuild = require('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/client', file)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    write: false,
    logLevel: 'silent',
  })
  const code = Buffer.from(result.outputFiles[0].text, 'utf8').toString('base64')
  return import(`data:text/javascript;base64,${code}`)
}
