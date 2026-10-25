/**
 * Issue #212 — the eighth quality gate: degeneration detection.
 *
 * The seven checks of #44 judge **how well** the prose is written. They say nothing about
 * whether the model wrote it *wrong*: a chapter whose third paragraph repeats the second, a
 * body cut off mid-sentence by `max_tokens`, a draft left with 「（此处继续展开）」 in it, or
 * `TODO` in a line all pass them — and in a 20-chapter batch job the author only finds out by
 * opening every chapter.
 *
 * Four codes, all `warning` (deterministic judges, small false-positive surface):
 *
 *   * `GATE_DEGEN_REPEAT` — 复读：紧邻整行重复 / 整段重复 / 同句连发；
 *   * `GATE_DEGEN_TRUNCATED` — 章末停在半句（正文不再以句末或收尾标点结束）；
 *   * `GATE_DEGEN_PLACEHOLDER` — 占位语与元话语（「（此处继续展开）」「以下是第 N 章」「我无法答应你」式）；
 *   * `GATE_DEGEN_META_LEAK` — 工程词泄漏（`TODO`、`lorem`、`{{占位}}`、`as an AI`、细纲一类）。
 *
 * What each block is for, so a failure says which promise broke:
 *
 *   1. **四码各拦得住** — one failing case per code (AGENTS.md §7: every rule needs a case
 *      that proves it actually stops something).
 *   2. **对话行豁免** — 「我无法答应你。」 as a line of dialogue is a character refusing; the
 *      same words as narration are the model refusing. Both directions are pinned.
 *   3. **截断的两个边界** — a body that stops mid-sentence is reported; a body whose last
 *      sentence is merely *short* is not. The second is the misreport the rule must not have.
 *   4. **干净正文零误报** — clean samples (including dialogue-heavy ones and one ending on a
 *      short complete sentence) produce no degeneration code at all. `tests/quality-gate.test.js`
 *      pins the same promise for the shared 12-labelled set: its clean samples assert *zero*
 *      findings of any code, so a rule that fires on good prose breaks that test too.
 *   5. **词表双向** — every new code is in `FINDING_CODES`, in data-model §5, owned by the
 *      eighth check and filed as `warning` (severity is the gate's own business: `blocking`
 *      is reserved for a write refusal).
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FINDING_CODES, GATE_CHECKS, GATE_CHECK_IDS, gateCheckOf, runGate } from '../lib/index.js'

/** Wide enough that a short sample never carries an item-1 word-count finding. */
const WIDE = { wordCountMin: 1, wordCountMax: 100000 }

/** One chapter, one body, in a throwaway book. The caller's temp dir is removed here. */
function gateBody(body) {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-degen-'))
  const root = join(dir, '书')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const name of ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '退化之书' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.gitignore'), 'index/*.db\n', 'utf8')
  const volume = join(root, 'chapters', 'vol-01')
  mkdirSync(volume, { recursive: true })
  const frontmatter = ['---', 'id: ch-0001', 'title: 第 1 章', 'volume: vol-01', 'seq: 1', '---', ''].join('\n')
  writeFileSync(join(volume, '0001-ch-0001.md'), `${frontmatter}${body}\n`, 'utf8')
  try {
    const result = runGate(root, { chapterId: 'ch-0001' }, { record: false, thresholds: WIDE })
    assert.equal(result.ok, true, `the gate refused the fixture: ${JSON.stringify(result.error ?? null)}`)
    return report(result.report)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** The report, plus the two helpers every case below asks for. */
function report(gated) {
  const codes = gated.findings.map((finding) => finding.code)
  return {
    report: gated,
    codes,
    has: (code) => codes.includes(code),
    degen: () => codes.filter((code) => code.startsWith('GATE_DEGEN')),
  }
}

// ---------------------------------------------------------------------------
// 1. Each of the four codes stops something
// ---------------------------------------------------------------------------

test('退化检测：四码各自拦得住自己的问题（正例）', async (t) => {
  await t.test('复读 —— 紧邻整行重复 / 整段重复 / 同句连发', () => {
    const adjacent = [
      '清音把药篓往肩上提了提，抬脚上台阶。',
      '清音把药篓往肩上提了提，抬脚上台阶。',
      '石阶上还留着夜里的水。',
    ].join('\n\n')
    assert.ok(gateBody(adjacent).has('GATE_DEGEN_REPEAT'), 'a verbatim back-to-back line is a loop')

    const block = [
      '雾还没散，青石阶上湿得发亮，鞋底碾过碎石一声一声。',
      '亭子里的人手里转着一枚铜钱，铜钱翻过指缝时，光一闪。',
      '雾还没散，青石阶上湿得发亮，鞋底碾过碎石一声一声。',
    ].join('\n\n')
    assert.ok(gateBody(block).has('GATE_DEGEN_REPEAT'), 'a whole paragraph twice is a loop even when not adjacent')

    const same = [
      '石阶越来越窄，两侧松枝压下来，枝头挂着夜里的水。',
      '雾比刚才更浓了，山道尽头什么也看不见。',
      '石阶越来越窄，两侧松枝压下来，枝头挂着夜里的水。',
      '钟声就是这时候响的，第三声没有响下去。',
      '石阶越来越窄，两侧松枝压下来，枝头挂着夜里的水。',
    ].join('\n\n')
    assert.ok(gateBody(same).has('GATE_DEGEN_REPEAT'), 'one long sentence three times is the same loop')
  })

  await t.test('截断 —— 结尾停在半句', () => {
    const cut = ['青石阶上湿得发亮。', '清音把药篓放在墙根，抬头看见'].join('\n\n')
    assert.ok(gateBody(cut).has('GATE_DEGEN_TRUNCATED'))
    // Stopping right after a comma is the same accident.
    assert.ok(gateBody('清音把药篓放在墙根，').has('GATE_DEGEN_TRUNCATED'))
  })

  await t.test('占位语与元话语', () => {
    assert.ok(gateBody(['雾散了。', '（此处继续展开）'].join('\n\n')).has('GATE_DEGEN_PLACEHOLDER'))
    assert.ok(gateBody('以下是第 3 章的内容。').has('GATE_DEGEN_PLACEHOLDER'))
    assert.ok(gateBody('雾散了。\n\n我无法答应你。').has('GATE_DEGEN_PLACEHOLDER'), 'the refusal as narration')
  })

  await t.test('工程词泄漏', () => {
    assert.ok(gateBody(['雾散了。', 'TODO: 这里补一段打斗。'].join('\n\n')).has('GATE_DEGEN_META_LEAK'))
    assert.ok(gateBody(['雾散了。', 'lorem ipsum dolor sit amet.'].join('\n\n')).has('GATE_DEGEN_META_LEAK'))
    assert.ok(gateBody(['{{主角名}}走了进来。'].join('\n\n')).has('GATE_DEGEN_META_LEAK'))
    assert.ok(gateBody(['As an AI, I cannot continue.'].join('\n\n')).has('GATE_DEGEN_META_LEAK'))
    assert.ok(gateBody(['细纲写着这一节要打一场。'].join('\n\n')).has('GATE_DEGEN_META_LEAK'))
  })
})

// ---------------------------------------------------------------------------
// 2. The dialogue exemption — both directions
// ---------------------------------------------------------------------------

test('退化检测：引号内是台词、引号外是叙述（正反两例）', () => {
  // (a) 台词：角色在拒绝，不是模型在拒绝。
  const dialogue = ['李慕白看着她。', '她摇头。「我无法答应你。」'].join('\n\n')
  assert.deepEqual(gateBody(dialogue).degen(), [], 'a character refusing is dialogue, not degeneration')

  // (b) 引号外：同一句话落在叙述里就是元话语泄漏。
  const narration = ['李慕白看着她。', '我无法答应你。'].join('\n\n')
  assert.ok(gateBody(narration).has('GATE_DEGEN_PLACEHOLDER'))

  // 复读同理：整段台词复沓是体裁手法，「叙述 + 台词」行的引号外部分才算。
  const refrain = ['「你迟了。」', '「你迟了。」', '「你迟了。」'].join('\n\n')
  assert.deepEqual(gateBody(refrain).degen(), [], 'repeated dialogue is a device, not a loop')
})

// ---------------------------------------------------------------------------
// 3. Truncation's two edges
// ---------------------------------------------------------------------------

test('退化检测：截断的两个边界（停在半句报、短而完整不报）', () => {
  // 半句：没有句末标点，是被 max_tokens 切掉的样子。
  assert.ok(gateBody(['雾散了，石阶上还是湿的。', '他抬起头，看见'].join('\n\n')).has('GATE_DEGEN_TRUNCATED'))
  // 短而完整：最后一句只有三个字，但它是完整的句子 —— 这是最容易误伤的一类。
  assert.deepEqual(gateBody(['雾散了，石阶上还是湿的。', '雨停了。'].join('\n\n')).degen(), [])
  // 收尾标点同样算完整（引号、省略号、括号）。
  assert.deepEqual(gateBody('她低声说：「我会到。」').degen(), [])
  assert.deepEqual(gateBody('脚步声远了，屋里只剩下墨水干下去的气味……').degen(), [])
})

// ---------------------------------------------------------------------------
// 4. Clean prose stays silent
// ---------------------------------------------------------------------------

/** Clean, varied prose with dialogue, an ellipsis and a short last sentence. */
const CLEAN = [
  '雾还没散，青石阶上湿得发亮。清音把药篓往肩上提了提，抬脚上台阶，鞋底碾过碎石，一声一声。',
  '「你迟了。」亭子里的人手里转着一枚铜钱，铜钱翻过指缝时，光一闪。',
  '她停下脚步。「山下的灯亮了整整一夜。」',
  '他没答。铜钱收进袖中，人已经往更高处走，走出七八步忽然回头，看了她一眼。那一眼很短，短到像是不小心。',
  '石阶越来越窄，两侧松枝压下来，枝头挂着夜里的水。药篓里的刀柄磕在木沿上，磕得她心口发紧……',
  '钟声就是这时候响的。一声，两声，第三声没响下去。',
  '她握紧带子。雾更浓，山道尽头似乎有什么东西在挪动。',
  '还跟得上吗？',
].join('\n\n')

test('退化检测：干净正文零误报', async (t) => {
  await t.test('叙述 + 对话 + 省略号 + 短末句，一条退化码都不报', () => {
    assert.deepEqual(gateBody(CLEAN).degen(), [])
  })

  await t.test('排比与复沓是体裁手法，「一声一声」不是复读', () => {
    const device = ['她一步一步往上走，很久很久没有说话。', '一步，一步，再一步。', '台阶数不清了。'].join('\n\n')
    assert.deepEqual(gateBody(device).degen(), [])
  })

  await t.test('章首的标题行不是工程词泄漏', () => {
    // A batch draft may start with the chapter heading; it is a heading, not 「第 N 章」 meta.
    assert.deepEqual(gateBody(['第 1 章', '雾还没散，青石阶上湿得发亮。'].join('\n\n')).degen(), [])
  })

  await t.test('故事内的「第三章」是合法叙述，不是章节结构词泄漏', () => {
    assert.deepEqual(gateBody(['他翻到第三章，指着一行字说：「这里改过。」'].join('\n\n')).degen(), [])
  })
})

// ---------------------------------------------------------------------------
// 5. The vocabulary (X-14 / X-24)
// ---------------------------------------------------------------------------

test('退化检测：第 8 项进检查表、四码都是 warning、都进共享词表与 data-model §5', () => {
  assert.equal(GATE_CHECKS.length, 8, 'the gate has eight checks after #212')
  assert.deepEqual([...GATE_CHECK_IDS].slice(6), ['proofread', 'degeneration'])
  const eighth = GATE_CHECKS[7]
  assert.equal(eighth.id, 'degeneration')
  assert.ok(eighth.label.trim() !== '')

  const catalogue = new Map(FINDING_CODES.map((entry) => [entry.code, entry]))
  const source = readFileSync(new URL('../.agents/specs/data-model.md', import.meta.url), 'utf8')
  for (const code of ['GATE_DEGEN_REPEAT', 'GATE_DEGEN_TRUNCATED', 'GATE_DEGEN_PLACEHOLDER', 'GATE_DEGEN_META_LEAK']) {
    const entry = catalogue.get(code)
    assert.ok(entry !== undefined, `${code} is missing from FINDING_CODES`)
    assert.equal(entry.fixable, false, `${code} must not claim a repair (ADR-0015 D2)`)
    assert.ok(source.includes(code), `${code} is missing from data-model §5`)
    assert.equal(gateCheckOf(code), 'degeneration', `${code} must be owned by the eighth check`)
  }

  // Severity: all four are `warning`. `blocking` is reserved for a write refusal (a gate is a
  // read), and the batch pause policy reads warnings — an `info` here would be a code nobody
  // acts on.
  const severities = new Set(
    gateBody(['雾散了。', 'TODO: 补一段。', '（此处继续展开）', '清音把药篓放下，抬头看见'].join('\n\n')).report.findings
      .filter((finding) => finding.code.startsWith('GATE_DEGEN'))
      .map((finding) => finding.severity),
  )
  assert.deepEqual([...severities], ['warning'])
})
