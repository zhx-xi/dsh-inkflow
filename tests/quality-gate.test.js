/**
 * Issue #44 — the seven quality gates (roadmap X-24/X-26, ADR-0022 D3/D4).
 *
 * `tests/gate.test.js` is already taken: it is #8's four-state *workspace* gate, a different
 * subject with the same word in it. This file is the *quality* gate — seven checks over one
 * chapter, and one deterministic conclusion file per chapter.
 *
 * What each block is for, so a failure says which promise broke:
 *
 *   1. **七项各有正例** — every check can actually block something, with the code it claims.
 *   2. **七项各有负例** — good prose stays silent. A checker that fires on clean text gets
 *      switched off by its author within a week, which is the same as not having it.
 *   3. **误报率** — 10 human-labelled samples (no defect / one known defect), asserted at
 *      ≤ 10% false positives and 100% recall. This is DoD D5-2's "误报抽查" done as a test
 *      rather than as a report nobody re-runs.
 *   4. **确定性** — the same chapter twice produces the same bytes (`git diff --no-index`
 *      empty), with no timestamp and no absolute path in the file (ADR-0022 D4).
 *   5. **落点** — `.inkflow/audit/gate-<chapterId>.json`, and `index/` gains nothing (X-25).
 *   6. **词表** — every `GATE_*` code is in `FINDING_CODES`, in data-model §5, carries a real
 *      check id, and claims `fixable: false` (no repair action exists yet).
 *   7. **工具** — `inkflow_gate_check` end to end: seven checks in the reply, the file on
 *      disk, and `write: false` writing nothing.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FINDING_CODES,
  GATE_CHECKS,
  GATE_CHECK_IDS,
  GATE_DEFAULTS,
  apply,
  gateCheckOf,
  gateFilePath,
  findingCode,
  renderGateFile,
  runGate,
} from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHARACTERS = [
  { id: 'char-qingyin', name: '清音', aliases: ['音儿'] },
  { id: 'char-limubai', name: '李慕白', aliases: ['慕白'] },
]

/** One closed ledger interval: 清音's realm stops being 筑基期 when chapter 2 starts. */
const FACTS = [{ subject: 'char-qingyin', lines: ['- attribute: 境界 | value: 筑基期 | until: ch-0002'] }]

/** Wide enough that a short sample is not a word-count finding; the tests that care pass their own. */
const WIDE = { wordCountMin: 1, wordCountMax: 100000 }

function cardText(card) {
  return ['---', `id: ${card.id}`, `name: ${card.name}`, `aliases: [${card.aliases.join(', ')}]`, '---', '', `${card.name}的卡片。`, ''].join('\n')
}

function ledgerText(ledger) {
  return ['---', `subject: ${ledger.subject}`, '---', '', ...ledger.lines, ''].join('\n')
}

/** A complete, gated book in a temp directory. The caller always removes it. */
function book({ chapters, characters = CHARACTERS, facts = FACTS }) {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-qgate-'))
  const root = join(dir, '书')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const name of ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library', 'index']) {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '门禁之书' }, null, 2)}\n`, 'utf8')
  writeFileSync(join(root, '.gitignore'), 'index/*.db\n', 'utf8')
  for (const card of characters) writeFileSync(join(root, 'characters', `${card.id}.md`), cardText(card), 'utf8')
  for (const ledger of facts) writeFileSync(join(root, 'facts', `${ledger.subject}.md`), ledgerText(ledger), 'utf8')
  const volume = join(root, 'chapters', 'vol-01')
  mkdirSync(volume, { recursive: true })
  writeFileSync(join(volume, '.gitkeep'), '', 'utf8')
  chapters.forEach((chapter, index) => {
    const seq = chapter.seq ?? index + 1
    const frontmatter = ['---', `id: ${chapter.id}`, `title: ${chapter.title ?? `第 ${String(seq)} 章`}`, 'volume: vol-01', `seq: ${String(seq)}`]
    if (chapter.extra !== undefined) frontmatter.push(chapter.extra)
    frontmatter.push('---', '')
    const file = join(volume, `${String(seq).padStart(4, '0')}-${chapter.id}.md`)
    writeFileSync(file, [...frontmatter, chapter.body].join('\n'), 'utf8')
  })
  return { dir, root, done: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Gate one chapter of a throwaway book and return the report. */
function gateOne(options) {
  const fixture = book({ chapters: options.chapters, ...(options.characters === undefined ? {} : { characters: options.characters }), ...(options.facts === undefined ? {} : { facts: options.facts }) })
  try {
    const result = runGate(fixture.root, { chapterId: options.target }, { record: false, thresholds: options.thresholds ?? WIDE })
    assert.equal(result.ok, true, `the gate refused the fixture: ${JSON.stringify(result.error ?? null)}`)
    return result.report
  } finally {
    fixture.done()
  }
}

/** One chapter, one body — the shape most subtests want. */
function gateBody(body, options = {}) {
  return gateOne({ chapters: [{ id: 'ch-0001', body, ...(options.extra === undefined ? {} : { extra: options.extra }) }], target: 'ch-0001', ...options })
}

function codesOf(report) {
  return report.findings.map((finding) => finding.code)
}

// ---------------------------------------------------------------------------
// Prose samples
// ---------------------------------------------------------------------------

/** Clean, varied, ends on a question: the negative baseline for most checks. */
const CLEAN = [
  '雾还没散，青石阶上湿得发亮。清音把药篓往肩上提了提，抬脚上台阶，鞋底碾过碎石，一声一声。',
  '「你迟了。」亭子里的人手里转着一枚铜钱，铜钱翻过指缝时，光一闪。',
  '她停下脚步。「山下的灯亮了整整一夜。」',
  '他没答。铜钱收进袖中，人已经往更高处走，走出七八步忽然回头，看了她一眼。那一眼很短，短到像是不小心。',
  '石阶越来越窄，两侧松枝压下来，枝头挂着夜里的水。清音跟着走，药篓里的刀柄磕在木沿上，磕得她心口发紧。',
  '钟声就是这时候响的。一声，两声，第三声没响下去。',
  '「这不是寺里的钟。」前面的人压低声音，脚步却没停。',
  '她握紧带子。雾更浓，山道尽头似乎有什么东西在挪动，可那东西没有影子。还跟得上吗？',
].join('\n\n')

/** Long enough (≥ 1000 characters) that the density dimensions actually run. */
const CLEAN_LONG = [
  '雨是从午后开始下的。清音把晾在檐下的药材一件件收进竹匾，捡到第七件时手指停了停——那是师父留下的刀伤药，纸包上还有他的字。',
  '她把纸包翻过来，字迹被雨气洇开，只认得出一个「勿」字。院子里水声很密，砸在石板上，溅起的泥点子落在门槛上，一点一点。',
  '「收完了没有？」李慕白站在照壁下面，斗笠檐上的水连成一线。',
  '「还差两筐。」清音没有抬头。她把竹匾往里挪了半尺，躲开斜着打进来的雨。',
  '他没有走。照壁的影子被雨打得散了形，人站在那儿像一根钉子。过了很久，他开口：「下个月初八，山门要开。」',
  '清音抱着竹匾站起来。雨水顺着她的袖口往下淌，淌到手肘，滴在青砖上。她问：「开给谁看？」',
  '「开给所有还记着这条路的人看。」他说完这句，斗笠往下压了压，「也开给那些忘了的人看。」',
  '雨忽然小了。屋檐上的水还在滴，滴得比刚才慢。清音把最后一筐药材搬到廊下，直起腰，看见他在雨里没动，也没打算动。',
  '「那你站在这里做什么？」她问。',
  '「等雨停。」他说，「雨停了，我就得走。」',
  '院子里的水开始退了，露出青砖上一条条深色的缝。清音看着那些缝，忽然想起很多年前的一个傍晚，也是这样的雨，也是这样的屋檐，只是那时候站在照壁下面的人还在笑。',
  '她把竹匾往上托了托。廊下的灯还没点，屋里黑着，药材的气味从门缝里渗出来，一层一层压在雨气上面。',
  '「初八那天，你会在山门口吗？」李慕白问。斗笠下面的眼睛很亮，亮得不像是在等一个回答。',
  '清音没有马上说话。她把竹匾放下，又提起来，重新放平一次，让那两筐药材落得稳当。',
  '「我会到。」她说，「但我不一定站在你那一边。」',
  '雨声在廊外铺开，密得听不见别的。李慕白点了点头，把斗笠摘下来抖了抖水，又重新戴上。',
  '「那就够了。」他说，「站哪边，那天再说。」',
  '清音看着他走进雨里，走过照壁，走到巷口那盏还没熄的灯下面。灯把雨照成一条条白线，白线里的人和街上的水一样，看不清脸。',
  '她转身回屋，摸到火折子，点了灯。灯光起来的时候，桌上的纸包还摊在那儿，「勿」字被光一照，忽然显得很清楚。',
  '她坐下来，把纸包重新包好，塞进袖子里。院子里的雨小了，屋檐上还有水滴。她问自己：初八那天，山门口会站着多少还记着这条路的人？',
].join('\n\n')

/** A 1100+ character paragraph set used to run the density dimensions (they need ≥ 1000). */
const LONG_SCENE = [
  '天色暗下来的时候，镇口的灯一盏盏亮了。挑担子的收摊，卖汤饼的支起棚子，热气从锅里冒出来，糊住半条街。',
  '清音把药篓放在墙根，摸出两枚铜钱，换了一碗汤饼。摊主的手很快，碗沿上撒了一把葱花，油花浮在面上，晃。',
  '街那头来了三个人，走得不快，脚步却整齐。为首的那个穿着半旧的青衫，腰间挂着一柄没有鞘的短刀，刀身在灯下泛白。',
  '清音低头吃饼，眼睛看着碗。她能听见那三个人的脚步从街心挪到离她三步远的地方，然后停住。',
  '「姑娘是哪里来的？」青衫客问。他的声音很和气，和气到像是在问路。',
  '「南边。」清音说。她没有抬头，也没有解释南边是哪里。',
  '「南边来得远。」青衫客笑了一声，把手按在腰间的刀柄上，「远来的客人，总该带点东西。」',
  '摊主的手停在半空。棚子外面，有人悄悄往后退，退了半步，又退了半步。整条街忽然安静，只有锅里还在响。',
  '清音把碗放下。碗底磕在木案上，声音很轻，可在这条街上，所有人都听见了。她抬起眼睛，看了看那柄短刀，又看了看青衫客的脸。',
  '「带的东西不多。」她说，「够用。你要试试吗？」',
].join('\n\n')

// ---------------------------------------------------------------------------
// 1. Every check can block something (positive cases)
// ---------------------------------------------------------------------------

test('质量门禁：七项各自拦得住自己的问题（正例）', async (t) => {
  await t.test('1 字数 —— 低于下限 / 超过上限', () => {
    const body = '雨停得很慢。清音把门推开一条缝，看了一眼院子里的水。\n'
    assert.ok(codesOf(gateBody(body, { thresholds: { wordCountMin: 500, wordCountMax: 5000 } })).includes('GATE_WORD_COUNT_LOW'))
    assert.ok(codesOf(gateBody(CLEAN, { thresholds: { wordCountMin: 10, wordCountMax: 100 } })).includes('GATE_WORD_COUNT_HIGH'))
    // And the same prose inside the window is silent.
    assert.equal(codesOf(gateBody(CLEAN, { thresholds: { wordCountMin: 100, wordCountMax: 5000 } })).includes('GATE_WORD_COUNT_LOW'), false)
  })

  await t.test('2 章末钩子 —— 平收与总结各一条', () => {
    const flat = [
      '清音把最后一只碗放回架子上，擦了手。',
      '屋里没点灯。她躺下，把这三年的事又想了一遍。',
    ].join('\n\n')
    assert.ok(codesOf(gateBody(flat)).includes('GATE_HOOK_MISSING'))

    const summary = [
      '天亮时雨停了。清音把院里的积水扫出去，晾好药材，坐下来记了账。',
      '总之，这一夜总算过去了。',
    ].join('\n\n')
    assert.ok(codesOf(gateBody(summary)).includes('GATE_HOOK_SUMMARY'))
    // A question at the end is a hook, not a summary.
    assert.deepEqual(codesOf(gateBody(CLEAN)).filter((code) => code.startsWith('GATE_HOOK')), [])
  })

  await t.test('3 六维去 AI 味 —— 六个维度各有自己的码', () => {
    const even = '他走进院子停下脚步。她抬头看见屋檐滴水。他把药篓放在门槛上。她伸手摸到一片冰凉。他后退半步站定了。她转身去关那扇门。他把铜钱放回袖里。她坐下没有说话。他把灯芯剪短一截。'
    assert.ok(codesOf(gateBody(even, { thresholds: { ...WIDE, aiSentenceEvenness: 0.5 } })).includes('GATE_AI_SENTENCE'))

    const dashes = [LONG_SCENE, `他没走——他就站在雨里——站了整整一夜——`, LONG_SCENE].join('\n\n')
    assert.ok(codesOf(gateBody(dashes)).includes('GATE_AI_PUNCT'))

    assert.ok(codesOf(gateBody(`${CLEAN}\n\n他不是害怕，而是愤怒。`)).includes('GATE_AI_PARALLEL'))

    assert.ok(codesOf(gateBody(`${CLEAN}\n\n他心中一沉。`)).includes('GATE_AI_NARRATION'))

    const modifiers = `${LONG_SCENE}\n\n${LONG_SCENE}\n\n${LONG_SCENE}\n\n那天的风是很冷的，很硬的风，很急的风，很脏的风，很旧的风，很沉的风。`
    assert.ok(codesOf(gateBody(modifiers, { thresholds: { ...WIDE, aiModifierPer1000: 10 } })).includes('GATE_AI_MODIFIER'))

    assert.ok(codesOf(gateBody(`${CLEAN}\n\n空气仿佛凝固。`)).includes('GATE_AI_TEMPLATE'))
  })

  await t.test('4 一致性 —— pov 不在角色库 / 账本取值已失效', () => {
    const unknownPov = gateBody(CLEAN, { extra: 'pov: 无名氏' })
    assert.ok(codesOf(unknownPov).includes('GATE_CONSISTENCY_POV_UNKNOWN'))
    // A pov that names a real character (or its alias) is silent.
    assert.equal(codesOf(gateBody(CLEAN, { extra: 'pov: 音儿' })).includes('GATE_CONSISTENCY_POV_UNKNOWN'), false)

    const stale = [
      { id: 'ch-0001', body: CLEAN },
      { id: 'ch-0002', body: '清音翻开簿子，第一页写着「筑基期」，墨迹已经淡了。\n' },
    ]
    const report = gateOne({ chapters: stale, target: 'ch-0002' })
    assert.ok(codesOf(report).includes('GATE_CONSISTENCY_FACT_STALE'))
    // The same sentence in the chapter where the value still holds is silent.
    const before = gateOne({ chapters: [{ id: 'ch-0001', body: '清音翻开簿子，第一页写着「筑基期」。\n' }], target: 'ch-0001' })
    assert.equal(codesOf(before).includes('GATE_CONSISTENCY_FACT_STALE'), false)
  })

  await t.test('5 敏感自查 —— 命中词表才报', () => {
    assert.ok(codesOf(gateBody('城门下血腥味一夜没散。\n')).includes('GATE_SENSITIVE_WORD'))
    assert.equal(codesOf(gateBody(CLEAN)).includes('GATE_SENSITIVE_WORD'), false)
  })

  await t.test('6 平台规则 —— 残留与引流', () => {
    assert.ok(codesOf(gateBody('求收藏，求推荐，走过路过不要错过。\n')).includes('GATE_PLATFORM_RESIDUE'))
    assert.ok(codesOf(gateBody('想看的加微信，扫码进群，限时特价。\n')).includes('GATE_PLATFORM_PROMO'))
    assert.deepEqual(codesOf(gateBody(CLEAN)).filter((code) => code.startsWith('GATE_PLATFORM')), [])
  })

  await t.test('7 机械校对 —— 六类各有自己的码', () => {
    assert.ok(codesOf(gateBody('她低声说：「别去了。\n')).includes('GATE_PROOF_PUNCT_UNPAIRED'))
    assert.ok(codesOf(gateBody('他走进屋子,看见桌上放着一把剑。\n')).includes('GATE_PROOF_HALF_PUNCT'))
    assert.ok(codesOf(gateBody('他数到３就停了。\n')).includes('GATE_PROOF_FULLWIDTH_ALNUM'))
    assert.ok(codesOf(gateBody('她的的剑还挂在墙上。\n')).includes('GATE_PROOF_REPEAT_WORD'))
    assert.ok(codesOf(gateBody('他忽然忽然停下，转过身来。\n')).includes('GATE_PROOF_REPEAT_WORD'))
    assert.ok(codesOf(gateBody('李慕青走进院子，把伞收了。\n')).includes('GATE_PROOF_NEAR_NAME'))
    assert.ok(
      codesOf(gateBody('清音抬头。清音没有答话。音儿把灯吹了。音儿又点上了。\n')).includes('GATE_PROOF_APPELLATION_MIXED'),
    )
    assert.ok(codesOf(gateBody('桌上放着3个瓷瓶。\n')).includes('GATE_PROOF_ARABIC_MEASURE'))
    assert.ok(codesOf(gateBody('三年前他走的，3年后他回来。\n')).includes('GATE_PROOF_NUMBER_MIXED'))
  })
})

// ---------------------------------------------------------------------------
// 2. …and good prose stays silent (negative cases)
// ---------------------------------------------------------------------------

test('质量门禁：干净正文不报（负例，逐项）', async (t) => {
  const report = gateBody(CLEAN_LONG, { thresholds: WIDE })

  await t.test('机械校对：成对引号、全角标点、无叠字、无近似名、单一称谓都不报', () => {
    assert.deepEqual(codesOf(report).filter((code) => code.startsWith('GATE_PROOF')), [])
  })

  await t.test('六维去 AI 味：变化句长、无破折号、无排比、无旁白、无套路话', () => {
    assert.deepEqual(codesOf(report).filter((code) => code.startsWith('GATE_AI')), [])
  })

  await t.test('章末钩子：以疑问收尾就是钩子', () => {
    assert.deepEqual(codesOf(report).filter((code) => code.startsWith('GATE_HOOK')), [])
  })

  await t.test('一致性与敏感自查：pov 缺省、账本取值不出现、无敏感词', () => {
    assert.deepEqual(codesOf(report).filter((code) => code.startsWith('GATE_CONSISTENCY') || code.startsWith('GATE_SENSITIVE')), [])
  })

  await t.test('两个字的角色名不参与近似名检测（已声明的限制）', () => {
    // 「清音」 is two characters: 「清风」 would be one character away, and every common word
    // sharing one character with a two-character name would become a candidate. The limit is
    // documented in `gate-proofread.ts`; this pins it so it cannot change silently.
    assert.equal(codesOf(gateBody('清风从窗口灌进来，吹得灯芯晃了晃。\n')).includes('GATE_PROOF_NEAR_NAME'), false)
  })

  await t.test('笑声明写与常用叠词不算重复词', () => {
    assert.equal(codesOf(gateBody('他笑起来，哈哈哈哈，笑得直不起腰。\n')).includes('GATE_PROOF_REPEAT_WORD'), false)
    // 汉语用「一声一声」「一步一步」「很久很久」做节奏，这是正常写法（规则只报 3–4 字的连写）。
    assert.equal(codesOf(gateBody('她一步一步往上走，很久很久没有说话。\n')).includes('GATE_PROOF_REPEAT_WORD'), false)
  })
})

// ---------------------------------------------------------------------------
// 3. Misreport rate on labelled samples (DoD D5-2's 误报抽查)
// ---------------------------------------------------------------------------

/** 10 samples: each either clean or carrying exactly one known defect. */
const LABELLED = [
  // --- clean (any finding here counts as a false positive) ---
  { name: 'clean-1', body: CLEAN, expect: [] },
  {
    name: 'clean-2',
    body: [
      '门开了。外头站着的人把伞收起来，水顺着伞骨流到阶上。',
      '「我来取药。」他说。声音沙，像一整天没喝水。',
      '清音从架子上取了那包纸，递过去，没有问名字，也没有问是谁病了。',
      '那人付了钱，转身要走，走到门口又停下。「这药，苦不苦？」',
      '「苦。」清音说，「但不会让人睡着。」',
      '他点点头，走进雨里。伞撑开的动作很慢，慢到像是不情愿。走出十几步，他忽然回头喊了一句什么，声音被雨盖住了。',
    ].join('\n\n'),
    expect: [],
  },
  {
    name: 'clean-3',
    body: [
      '灯芯剪短了，屋里暗下来。李慕白把簿子翻到最后一页，那里还留着一行空白。',
      '他蘸墨，写下「初八」两个字，随即把笔搁下。窗外的树影在纸上晃，晃了很久。',
      '「你要写什么？」门外有人问。',
      '「写日子。」他说。',
      '门外的人没有再问。脚步声远了，屋里只剩下墨水干下去的那点气味。',
      '他忽然想起，初八那一页的背后，还有半行没有写完的字。',
    ].join('\n\n'),
    expect: [],
  },
  { name: 'clean-4', body: CLEAN_LONG, expect: [] },
  {
    name: 'clean-5',
    body: [
      '药碾子转了半圈，停下来。清音把碾好的粉扫进纸包，扎好，放进抽屉最里层。',
      '院子里有人喊她，声音很急。她应了一声，手却没有停，把抽屉关严，才转身出去。',
      '天色已经很暗，暗得看不清台阶。她扶着门框往下走，走到第三级时，忽然听见有人笑。',
    ].join('\n\n'),
    expect: [],
  },
  {
    name: 'clean-6',
    body: [
      '雪停在半夜。清音推开窗，屋檐上已经积了薄薄一层白，院里的水缸结了冰。',
      '她把炭盆挪到门口，添了两块炭，火苗从灰里钻出来，先是暗红，然后发白。',
      '「这么早。」隔壁的婆婆隔着墙说话，声音里还带着睡意。',
      '「睡不着。」清音说。她把水壶放上去，等壶底开始响。',
      '婆婆家的狗在雪里跑了两圈，忽然停住，朝着巷口的方向低低地叫。',
    ].join('\n\n'),
    expect: [],
  },
  {
    name: 'clean-7',
    body: [
      '账本摊在桌上，墨迹有新有旧。清音一页页翻过去，在第七页停住，那里记着一笔她认不得的支出。',
      '「这笔是谁记的？」她问。李慕白凑过来看了一眼，摇头。',
      '两个人把那页对着灯举起来，纸背透出一行更淡的字，像是后来才补上去的。',
      '「有人改过账。」李慕白把纸放下，看向她，「你猜是为了什么？」',
    ].join('\n\n'),
    expect: [],
  },
  // --- one known defect each (recall must be 100%) ---
  { name: 'dirty-punct', body: '她低声说：「别去了，我先去看一眼。\n', expect: ['GATE_PROOF_PUNCT_UNPAIRED'] },
  { name: 'dirty-half', body: '他走进屋子,看见桌上放着一把剑，剑鞘是黑的。\n', expect: ['GATE_PROOF_HALF_PUNCT'] },
  { name: 'dirty-repeat', body: '她的的剑还挂在墙上，落了灰。\n', expect: ['GATE_PROOF_REPEAT_WORD'] },
  { name: 'dirty-name', body: '李慕青走进院子，把伞收了，抬头看了看天。\n', expect: ['GATE_PROOF_NEAR_NAME'] },
  { name: 'dirty-cliche', body: `${CLEAN}\n\n空气仿佛凝固。`, expect: ['GATE_AI_TEMPLATE'] },
]

test('质量门禁：12 条人工标注样本，误报 ≤ 10%、漏报 = 0', () => {
  const clean = LABELLED.filter((sample) => sample.expect.length === 0)
  const dirty = LABELLED.filter((sample) => sample.expect.length > 0)
  const noisy = []
  const missed = []
  for (const sample of LABELLED) {
    const report = gateBody(sample.body, { thresholds: WIDE })
    const codes = codesOf(report)
    if (sample.expect.length === 0) {
      if (codes.length > 0) noisy.push(`${sample.name}: ${codes.join(',')}`)
      continue
    }
    for (const code of sample.expect) {
      if (!codes.includes(code)) missed.push(`${sample.name}: ${code}`)
    }
  }
  assert.deepEqual(missed, [], 'every labelled defect must be reported (recall 100%)')
  const falsePositiveRate = noisy.length / clean.length
  assert.ok(
    falsePositiveRate <= 0.1,
    `false positives ${String(noisy.length)}/${String(clean.length)} exceed 10%: ${noisy.join(' | ')}`,
  )
})

// ---------------------------------------------------------------------------
// 4. Determinism (ADR-0022 D4)
// ---------------------------------------------------------------------------

test('质量门禁：同一章跑两次，结论文件字节相同、无时间戳、无绝对路径', () => {
  const fixture = book({ chapters: [{ id: 'ch-0001', body: `${CLEAN}\n\n她的的剑还挂在墙上。` }] })
  try {
    const first = runGate(fixture.root, { chapterId: 'ch-0001' })
    assert.equal(first.ok, true)
    const path = gateFilePath('ch-0001')
    assert.equal(path, '.inkflow/audit/gate-ch-0001.json')
    assert.equal(first.file?.path, path)
    const before = readFileSync(join(fixture.root, path), 'utf8')

    // A copy outside the book, so `git diff --no-index` compares two files the plugin
    // itself never touches (the point is the bytes, not the file's location).
    const snapshot = join(fixture.dir, 'gate-before.json')
    copyFileSync(join(fixture.root, path), snapshot)

    const second = runGate(fixture.root, { chapterId: 'ch-0001' })
    assert.equal(second.ok, true)
    const after = readFileSync(join(fixture.root, path), 'utf8')
    assert.equal(after, before, 'two runs on unchanged files must produce identical bytes')

    try {
      execFileSync('git', ['diff', '--no-index', '--exit-code', snapshot, join(fixture.root, path)], { stdio: 'pipe' })
    } catch (cause) {
      assert.equal(cause.status, 0, `git diff --no-index must be empty: ${String(cause.stdout ?? '')}`)
    }

    // No timestamp, no absolute path anywhere in the conclusion (ADR-0022 D4 #3).
    assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(after), false, 'the file must not carry a timestamp')
    assert.equal(after.includes(fixture.root.replaceAll('\\', '\\\\')), false, 'the file must not carry the absolute root')
    assert.equal(after.includes(fixture.root), false, 'the file must not carry the absolute root')
    // …and the digest is what answers "is this the newest run".
    const parsed = JSON.parse(after)
    assert.equal(typeof parsed.chapterDigest, 'string')
    assert.ok(parsed.chapterDigest.length === 64)
    assert.deepEqual(Object.keys(parsed).slice(0, 3), ['schemaVersion', 'chapterId', 'chapterPath'])
    assert.equal(parsed.counts.total, parsed.findings.length)
    assert.equal(parsed.counts.fixable, 0)
  } finally {
    fixture.done()
  }
})

test('质量门禁：改过正文之后 digest 变了（结论文件能说"这不是最新一次"）', () => {
  const fixture = book({ chapters: [{ id: 'ch-0001', body: CLEAN }] })
  try {
    const first = runGate(fixture.root, { chapterId: 'ch-0001' })
    const digestBefore = first.ok ? first.report.chapterDigest : ''
    const file = join(fixture.root, 'chapters', 'vol-01', '0001-ch-0001.md')
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n院子里的水退了。\n`, 'utf8')
    const second = runGate(fixture.root, { chapterId: 'ch-0001' })
    const digestAfter = second.ok ? second.report.chapterDigest : ''
    assert.notEqual(digestAfter, digestBefore)
  } finally {
    fixture.done()
  }
})

// ---------------------------------------------------------------------------
// 5. Where the conclusion lands (X-25)
// ---------------------------------------------------------------------------

test('质量门禁：结论落 .inkflow/audit/，index/ 不新增任何文件', () => {
  const fixture = book({ chapters: [{ id: 'ch-0001', body: CLEAN }] })
  try {
    const indexBefore = readdirSync(join(fixture.root, 'index')).sort()
    const gated = runGate(fixture.root, { chapterId: 'ch-0001' })
    assert.equal(gated.ok, true)
    assert.deepEqual(readdirSync(join(fixture.root, 'index')).sort(), indexBefore, 'index/ is derived: the gate never writes it')
    const auditDir = join(fixture.root, '.inkflow', 'audit')
    assert.deepEqual(readdirSync(auditDir).sort(), ['gate-ch-0001.json'])
    // First use appends the ignore line (ADR-0012), never rewrites the file.
    assert.ok(readFileSync(join(fixture.root, '.gitignore'), 'utf8').includes('.inkflow/'))
    // And `record: false` writes nothing at all — the read route's switch.
    const readOnly = runGate(fixture.root, { chapterId: 'ch-0001' }, { record: false })
    assert.equal(readOnly.ok, true)
    assert.equal(readOnly.file, undefined)
    assert.deepEqual(readdirSync(auditDir).sort(), ['gate-ch-0001.json'])
  } finally {
    fixture.done()
  }
})

// ---------------------------------------------------------------------------
// 6. The vocabulary (X-14 / X-24)
// ---------------------------------------------------------------------------

test('质量门禁：每个 GATE_* 码都在共享词表里、都在 data-model §5 里、都不声称可自动修', () => {
  const spec = readFileSync(join(repoRoot, '.agents/specs/data-model.md'), 'utf8')
  const catalogue = new Map(FINDING_CODES.map((entry) => [entry.code, entry]))
  const emitted = new Set()
  for (const check of GATE_CHECKS) {
    assert.ok(GATE_CHECK_IDS.includes(check.id), `${check.id} is not a declared check id`)
    assert.ok(check.label.trim() !== '', `${check.id} has no label`)
  }
  for (const spec_ of GATE_CHECKS) {
    for (const code of codesOfCheck(spec_.id)) emitted.add(code)
  }
  assert.ok(emitted.size >= 20, `the gate should own a real vocabulary, found ${String(emitted.size)}`)
  for (const code of emitted) {
    const entry = catalogue.get(code)
    assert.ok(entry !== undefined, `${code} is emitted by the gate but missing from FINDING_CODES`)
    assert.ok(spec.includes(code), `${code} is missing from data-model §5`)
    assert.equal(entry.fixable, false, `${code} must not claim a repair that repair.ts does not have (ADR-0015 D2)`)
    assert.ok(GATE_CHECK_IDS.includes(entry.group) === false, `${code}: group must be one of the five families, not a check id`)
    assert.ok(gateCheckOf(code) !== undefined, `${code} has no check id`)
  }
  // `GATE_CODES` and `FINDING_CODES` agree in both directions about what the gate can emit.
  for (const [code] of catalogue) {
    if (!code.startsWith('GATE_')) continue
    assert.ok(emitted.has(code), `${code} is in the catalogue with a GATE_ prefix but no check emits it`)
  }
  // Thresholds travel with the verdict, so "12 项" can be reproduced.
  const report = gateBody(CLEAN, { thresholds: WIDE })
  const file = JSON.parse(renderGateFile(report))
  assert.deepEqual(Object.keys(file.thresholds), [
    'wordCountMin',
    'wordCountMax',
    'aiDashPer1000',
    'aiEllipsisPer1000',
    'aiSentenceMeanMax',
    'aiSentenceEvenness',
    'aiModifierPer1000',
    'maxFindingsPerRule',
  ])
  assert.equal(file.thresholds.wordCountMin, WIDE.wordCountMin)
  assert.equal(typeof GATE_DEFAULTS.wordCountMax, 'number')
})

/** The codes one check can emit, read from the source so a new rule cannot be forgotten. */
function codesOfCheck(checkId) {
  const source = readFileSync(join(repoRoot, 'src/host/gate-vocabulary.ts'), 'utf8')
  const table = source.slice(source.indexOf('export const GATE_CODES'), source.indexOf('const SPEC_BY_CODE'))
  const rows = [...table.matchAll(/\{ code: '([A-Z0-9_]+)', check: '([a-zA-Z]+)'/g)]
  return rows.filter((row) => row[2] === checkId).map((row) => row[1])
}

test('质量门禁：findingCode 认识每一个门禁码，未知码返回 undefined', () => {
  assert.equal(findingCode('GATE_PROOF_HALF_PUNCT')?.code, 'GATE_PROOF_HALF_PUNCT')
  assert.equal(findingCode('NO_SUCH_GATE_CODE'), undefined)
})

// ---------------------------------------------------------------------------
// 7. The tool (one call, seven checks, one file)
// ---------------------------------------------------------------------------

function createHarness(workspace) {
  const tools = new Map()
  const ctx = {
    effect(setup) {
      const dispose = setup()
      void dispose
      return () => {}
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
    webServer: {
      register() {
        return () => {}
      },
    },
  }
  return { ctx, tools }
}

function makeTools(dataDir, workspace) {
  const harness = createHarness(workspace)
  apply(harness.ctx, { dataDir })
  return harness
}

async function callTool(harness, name, args) {
  const tool = harness.tools.get(name)
  assert.ok(tool, `tool ${name} must be registered`)
  return tool.execute(args, { signal: AbortSignal.timeout(15000), agent: { id: 'test-session' } })
}

test('质量门禁：工具 inkflow_gate_check 回七项、落一个文件，write: false 只算不写', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'inkflow-qgate-tool-'))
  const fixture = book({ chapters: [{ id: 'ch-0001', body: `${CLEAN}\n\n她的的剑还挂在墙上。` }] })
  try {
    const harness = makeTools(join(dir, 'state'), fixture.dir)
    const value = await callTool(harness, 'inkflow_gate_check', { projectRoot: fixture.root })
    assert.equal(value.ok, true)
    assert.deepEqual(value.checks.map((check) => check.id), [...GATE_CHECK_IDS])
    assert.equal(value.checks.length, 7)
    assert.ok(value.counts.total > 0)
    assert.equal(value.file.path, '.inkflow/audit/gate-ch-0001.json')
    assert.ok(readFileSync(join(fixture.root, '.inkflow/audit/gate-ch-0001.json'), 'utf8').includes('GATE_PROOF_REPEAT_WORD'))
    // Every finding on the wire is the shared shape plus its check id.
    for (const finding of value.findings) {
      assert.deepEqual(Object.keys(finding), ['check', 'code', 'group', 'severity', 'locator', 'detail', 'hint', 'fixable'])
      assert.equal(finding.fixable, false)
    }

    rmSync(join(fixture.root, '.inkflow'), { recursive: true, force: true })
    const dry = await callTool(harness, 'inkflow_gate_check', { projectRoot: fixture.root, write: false })
    assert.equal(dry.ok, true)
    assert.equal(dry.file, undefined)
    assert.equal(dry.counts.total, value.counts.total)
    assert.throws(() => readFileSync(join(fixture.root, '.inkflow/audit/gate-ch-0001.json'), 'utf8'))

    // A chapter id the book does not have is a structured refusal, not a crash.
    const missing = await callTool(harness, 'inkflow_gate_check', { projectRoot: fixture.root, chapterId: 'ch-9999' })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'CHAPTER_NOT_FOUND')
  } finally {
    fixture.done()
    rmSync(dir, { recursive: true, force: true })
  }
})
