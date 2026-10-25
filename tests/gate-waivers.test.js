/**
 * 按书的门禁口径（ADR-0028）：`inkflow.json` 的 `gate` 段（数值）与
 * `library/gate-whitelist.txt`（字面豁免）。
 *
 * 这一组用例只回答一个问题：作者能不能在不关掉门禁的前提下说出自己的口径。所以每条
 * 断言都钉在一个**行为**上，而不是钉在实现形状上：
 *
 *   1. 没有豁免文件时照常报——不声明就不该有特权；
 *   2. 被点名的那一处不报，**同一行的不可豁免码照报**，别的行也照报——豁免是行级、码级
 *      的，不是「这一章松了」；
 *   3. 越界（超长 / 超条数）整次拒绝并指名——静默忽略一条超长条目等于作者以为豁免了；
 *   4. 老书零行为变化：阈值仍是 `GATE_DEFAULTS`、摘要不变、`configured` 为 0；
 *   5. 白名单是给人手写的：BOM、CRLF、`#` 注释、空行都要能读；
 *   6. 数值口径生效、非法值与未知键被拒、调用方的一次性覆盖仍然赢。
 *
 * 先 RED：这份文件在任何实现之前写下，第一条断言在功能落地前必然假。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GATE_DEFAULTS, renderGateFile, runGate } from '../lib/index.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Wide enough that a short sample is not a word-count finding; tests that care pass their own. */
const WIDE = { wordCountMin: 1, wordCountMax: 100000 }

/**
 * 正文行 → 报告里的行号。章节文件在 frontmatter 块之后有一个空行（真实文件的形状），
 * 所以正文第 1 行是报告里的第 2 行；这里不把 frontmatter 挤掉来迁就断言。
 */
const LINE = (bodyLine) => bodyLine + 1

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']

/** 一行一个「问题」的正文：第 1 行只有情绪直陈，第 2 行同时有情绪直陈与重复字词。 */
const BODY = [
  '他心中一沉，把刀收回鞘里。',
  '「早该如此。」他心中一沉的的回话。',
  '山风从崖口灌进来，吹得灯火乱晃。',
].join('\n')

/**
 * 一本完整的书，带一个章。`gate` 写进 `inkflow.json`；`whitelist` 写进
 * `library/gate-whitelist.txt`（`whitelistBytes` 用来造 BOM / CRLF 这类手工现场）。
 */
function book(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-waiver-'))
  const root = join(dir, '书')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const name of [...CONTENT_DIRS, 'index']) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, '.gitkeep'), '', 'utf8')
  }
  const meta = { schemaVersion: 1, title: '口径之书' }
  if (options.gate !== undefined) meta.gate = options.gate
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.gitignore'), 'index/*.db\n', 'utf8')
  if (options.whitelist !== undefined) {
    writeFileSync(join(root, 'library', 'gate-whitelist.txt'), options.whitelist, 'utf8')
  }
  if (options.whitelistBytes !== undefined) {
    writeFileSync(join(root, 'library', 'gate-whitelist.txt'), options.whitelistBytes, 'utf8')
  }
  mkdirSync(join(root, 'chapters', 'vol-01'), { recursive: true })
  writeFileSync(join(root, 'chapters', 'vol-01', '.gitkeep'), '', 'utf8')
  const frontmatter = ['---', 'id: ch-0001', 'title: 第 1 章', 'volume: vol-01', 'seq: 1', '---', '']
  writeFileSync(join(root, 'chapters', 'vol-01', '0001-ch-0001.md'), [...frontmatter, options.body ?? BODY].join('\n'), 'utf8')
  return { root, done: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Run the gate on the fixture's only chapter and hand back the result envelope. */
function gate(fixture, options = {}) {
  return runGate(fixture.root, { chapterId: 'ch-0001' }, { record: false, ...options })
}

/** Gate one throwaway book and return the report, asserting the run was accepted. */
function reportOf(options = {}, runOptions = {}) {
  const fixture = book(options)
  try {
    const result = gate(fixture, runOptions)
    assert.equal(result.ok, true, `the gate refused the fixture: ${JSON.stringify(result.error ?? null)}`)
    return result.report
  } finally {
    fixture.done()
  }
}

function codesAt(report, line) {
  return report.findings
    .filter((finding) => finding.locator.kind === 'path' && finding.locator.line === line)
    .map((finding) => finding.code)
    .sort()
}

function codesOf(report) {
  return report.findings.map((finding) => finding.code)
}

// ---------------------------------------------------------------------------
// 1. 不声明就没有特权
// ---------------------------------------------------------------------------

test('门禁豁免：没有白名单文件时，情绪直陈与重复字词都照常报', () => {
  const report = reportOf({}, { thresholds: WIDE })
  assert.deepEqual(codesAt(report, LINE(1)), ['GATE_AI_NARRATION'])
  assert.deepEqual(codesAt(report, LINE(2)), ['GATE_AI_NARRATION', 'GATE_PROOF_REPEAT_WORD'])
  assert.deepEqual(report.waivers, { configured: 0, applied: [] })
})

test('门禁豁免：白名单里的片段一处都没命中时，判决与没有白名单时逐条相同', () => {
  const plain = reportOf({}, { thresholds: WIDE })
  const unused = reportOf({ whitelist: '这句话不在正文里\n' }, { thresholds: WIDE })
  assert.deepEqual(codesOf(unused), codesOf(plain))
  assert.equal(unused.waivers.configured, 1)
  assert.deepEqual(unused.waivers.applied, [])
})

// ---------------------------------------------------------------------------
// 2. 命中即不报；行级 + 码级
// ---------------------------------------------------------------------------

test('门禁豁免：被点名那一行的情绪直陈不报，同一行的重复字词照报', () => {
  const report = reportOf({ whitelist: '# 固定台词\n\n早该如此\n' }, { thresholds: WIDE })
  // 第 2 行：NARRATION 被豁免，REPEAT_WORD 不在可豁免闭集里，仍然报。
  assert.deepEqual(codesAt(report, LINE(2)), ['GATE_PROOF_REPEAT_WORD'])
  // 别的行不受影响：第 1 行没有这个片段。
  assert.deepEqual(codesAt(report, LINE(1)), ['GATE_AI_NARRATION'])
  assert.equal(report.waivers.configured, 1)
  assert.deepEqual(report.waivers.applied, [
    { code: 'GATE_AI_NARRATION', locator: 'chapters/vol-01/0001-ch-0001.md#L3', fragment: '早该如此', whitelistLine: 3 },
  ])
})

test('门禁豁免：豁免是按行的——片段在别的行，不会连带放过这一行的同类问题', () => {
  const body = ['「早该如此。」句一。', '话说到这里，他心中一沉。', '门忽然开了。'].join('\n')
  const report = reportOf({ body, whitelist: '早该如此\n' }, { thresholds: WIDE })
  assert.deepEqual(codesAt(report, LINE(1)), [])
  assert.deepEqual(codesAt(report, LINE(2)), ['GATE_AI_NARRATION'])
  assert.deepEqual(report.waivers.applied, [])
})

test('门禁豁免：可豁免的排版口径也认（全角字母数字、半角标点、阿拉伯数字量词）', () => {
  const body = ['招牌上写着ＡＢＣ三个字。', '他点点头,没说话。', '三个人走了3里路。'].join('\n')
  const plain = reportOf({ body }, { thresholds: WIDE })
  assert.ok(codesOf(plain).includes('GATE_PROOF_FULLWIDTH_ALNUM'))
  assert.ok(codesOf(plain).includes('GATE_PROOF_HALF_PUNCT'))
  assert.ok(codesOf(plain).includes('GATE_PROOF_ARABIC_MEASURE'))
  const waived = reportOf({ body, whitelist: 'ＡＢＣ\n他点点头,没说话\n三个人走了3里路\n' }, { thresholds: WIDE })
  assert.deepEqual(waived.findings.filter((finding) => finding.code.startsWith('GATE_PROOF_')).length, 0)
  assert.equal(waived.waivers.applied.length, 3)
})

// ---------------------------------------------------------------------------
// 3. 防橡皮：越界显式拒绝
// ---------------------------------------------------------------------------

test('门禁豁免：单条超过 40 字符被拒，并指名白名单文件的行号与实际长度', () => {
  const fixture = book({ whitelist: `# 注释\n${'一'.repeat(41)}\n` })
  try {
    const result = gate(fixture, { thresholds: WIDE })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'GATE_WHITELIST_INVALID')
    assert.match(result.error.message, /line 2/u)
    assert.match(result.error.message, /41/u)
    assert.match(result.error.message, /40/u)
  } finally {
    fixture.done()
  }
})

test('门禁豁免：超过 30 条被拒，并指名实际条数与上限', () => {
  const entries = Array.from({ length: 31 }, (_unused, index) => `片段${String(index)}`).join('\n')
  const fixture = book({ whitelist: `${entries}\n` })
  try {
    const result = gate(fixture, { thresholds: WIDE })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'GATE_WHITELIST_INVALID')
    assert.match(result.error.message, /31/u)
    assert.match(result.error.message, /30/u)
  } finally {
    fixture.done()
  }
})

test('门禁豁免：恰好 40 字符的单条与恰好 30 条都合法（边界不是「差一个」）', () => {
  const thirty = Array.from({ length: 30 }, (_unused, index) => `片段${String(index)}`).join('\n')
  const many = reportOf({ whitelist: `${thirty}\n` }, { thresholds: WIDE })
  assert.equal(many.waivers.configured, 30)
  const long = reportOf({ whitelist: `${'二'.repeat(40)}\n` }, { thresholds: WIDE })
  assert.equal(long.waivers.configured, 1)
})

// ---------------------------------------------------------------------------
// 4. 老书零行为变化
// ---------------------------------------------------------------------------

test('门禁豁免：老书（无 gate 段、无白名单）阈值仍是 GATE_DEFAULTS，摘要与声明了默认值的书相同', () => {
  const old = reportOf({}, {})
  assert.deepEqual(old.thresholds, GATE_DEFAULTS)
  assert.deepEqual(old.waivers, { configured: 0, applied: [] })

  // 把默认值显式写进 gate 段：不是新口径，判定与摘要都该一模一样。
  const explicit = reportOf({ gate: { ...GATE_DEFAULTS } }, {})
  assert.deepEqual(explicit.thresholds, old.thresholds)
  assert.deepEqual(codesOf(explicit), codesOf(old))
  assert.equal(explicit.chapterDigest, old.chapterDigest)
})

test('门禁豁免：白名单一改，chapterDigest 就变（「这是最新一次吗」仍然答得出来）', () => {
  const before = reportOf({ whitelist: '早该如此\n' }, { thresholds: WIDE })
  const after = reportOf({ whitelist: '早该如此\n另一句台词\n' }, { thresholds: WIDE })
  assert.notEqual(before.chapterDigest, after.chapterDigest)
  const none = reportOf({}, { thresholds: WIDE })
  assert.notEqual(before.chapterDigest, none.chapterDigest)
})

// ---------------------------------------------------------------------------
// 5. 手写的文件必须读得进来
// ---------------------------------------------------------------------------

test('门禁豁免：带 BOM、CRLF、注释与空行的白名单照常生效', () => {
  const bytes = '\uFEFF# 人物口癖\r\n\r\n早该如此\r\n'
  const report = reportOf({ whitelistBytes: bytes }, { thresholds: WIDE })
  assert.equal(report.waivers.configured, 1)
  assert.deepEqual(codesAt(report, LINE(2)), ['GATE_PROOF_REPEAT_WORD'])
  assert.equal(report.waivers.applied[0].fragment, '早该如此')
})

test('门禁豁免：全半角与大小写归一后再比对', () => {
  const body = '招牌上写着ＡＢＣ三个字。'
  const report = reportOf({ body, whitelist: 'abc\n' }, { thresholds: WIDE })
  assert.deepEqual(codesOf(report).filter((code) => code === 'GATE_PROOF_FULLWIDTH_ALNUM'), [])
  assert.equal(report.waivers.applied.length, 1)
})

// ---------------------------------------------------------------------------
// 6. 数值口径
// ---------------------------------------------------------------------------

test('门禁口径：gate 段里的数值生效（区间收到 1–10 字，一章就判超长）', () => {
  const plain = reportOf({})
  assert.deepEqual(codesOf(plain).filter((code) => code === 'GATE_WORD_COUNT_HIGH'), [])
  const tight = reportOf({ gate: { wordCountMin: 1, wordCountMax: 10 } })
  assert.deepEqual(codesOf(tight).filter((code) => code === 'GATE_WORD_COUNT_HIGH'), ['GATE_WORD_COUNT_HIGH'])
  assert.equal(tight.thresholds.wordCountMax, 10)
  // 其余键仍取默认值：只覆盖写出来的那些。
  assert.equal(tight.thresholds.aiEllipsisPer1000, GATE_DEFAULTS.aiEllipsisPer1000)
  assert.equal(tight.thresholds.aiDashPer1000, GATE_DEFAULTS.aiDashPer1000)
})

test('门禁口径：调用方的一次性 thresholds 仍然赢过书里的 gate 段', () => {
  const report = reportOf({ gate: { wordCountMin: 1, wordCountMax: 10 } }, { thresholds: WIDE })
  assert.deepEqual(codesOf(report).filter((code) => code === 'GATE_WORD_COUNT_HIGH'), [])
  assert.equal(report.thresholds.wordCountMax, WIDE.wordCountMax)
})

test('门禁口径：非法值、非法键、自相矛盾的区间都被显式拒绝', () => {
  for (const [gateSection, needle] of [
    [{ wordCountMax: '很大' }, /wordCountMax/u],
    [{ aiDashes: 2 }, /aiDashes/u],
    [{ wordCountMin: 6000, wordCountMax: 100 }, /wordCountMin/u],
    [{ maxFindingsPerRule: 0 }, /maxFindingsPerRule/u],
    [{ aiDashPer1000: -1 }, /aiDashPer1000/u],
  ]) {
    const fixture = book({ gate: gateSection })
    try {
      const result = gate(fixture, { thresholds: WIDE })
      assert.equal(result.ok, false, `gate ${JSON.stringify(gateSection)} must be refused`)
      assert.equal(result.error.code, 'GATE_BOOK_CONFIG_INVALID')
      assert.match(result.error.message, needle)
    } finally {
      fixture.done()
    }
  }
})

// ---------------------------------------------------------------------------
// 7. 可见性：回执与结论文件里都看得到「本作有 N 条豁免」
// ---------------------------------------------------------------------------

test('门禁豁免：结论文件带 waivers（条数 + 每处豁免的码、定位、片段、白名单行号）', () => {
  const report = reportOf({ whitelist: '# 台词\n早该如此\n' }, { thresholds: WIDE })
  const file = JSON.parse(renderGateFile(report))
  assert.equal(file.schemaVersion, 2)
  assert.deepEqual(file.waivers, {
    configured: 1,
    applied: [
      { code: 'GATE_AI_NARRATION', locator: 'chapters/vol-01/0001-ch-0001.md#L3', fragment: '早该如此', whitelistLine: 2 },
    ],
  })
})
