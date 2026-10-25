/**
 * Issue #44 — the quality gate's vocabulary: the eight checks, their code table, the
 * thresholds and the input types the rules read.
 *
 * Split out of `gate-rules.ts` for two reasons, both structural rather than cosmetic:
 *
 *   * **the vocabulary is what three readers share** — `gate.ts` (report, serialiser), the
 *     tool/`GET /gate` (`check` labels, counts) and the rules themselves. Keeping it
 *     beside the rules made one file that both defines and uses the words, which is where a
 *     second definition starts growing;
 *   * the rules file was past the project's 600-line ceiling; the words are not the rules.
 *
 * #212（退化检测，第 8 项）把它的阈值与词表也放在这里（`DEGENERATION`，见下文「出处」一
 * 节）：ADR-0027 D5 要求凡引用的数字能在这一类单一来源文件里找到，散在规则文件里迟早漂移。
 *
 * Two contracts live here and nowhere else:
 *
 *   * `GATE_CHECK_IDS` order is the report's order, the file's order and the panel's order —
 *     nothing may reorder it.
 *   * `group` and `fixable` are **not** here: they come from `findings.ts` (X-14 / X-24), so a
 *     gate code cannot carry a second opinion about its family or about whether the repair
 *     pass can fix it. Severity is here because `blocking` is reserved for a write refusal
 *     (`findings.ts` says so) and a gate is a read — the loudest a gate ever gets is
 *     `warning`.
 */

import { findingCode } from './findings.js'
import type { Finding, FindingLocator, FindingSeverity } from './findings.js'

/** The eight checks, in report order. Nothing may reorder this tuple. */
export const GATE_CHECK_IDS = [
  'wordCount',
  'hook',
  'aiFlavor',
  'consistency',
  'sensitive',
  'platform',
  'proofread',
  'degeneration',
] as const
export type GateCheckId = (typeof GATE_CHECK_IDS)[number]

export const GATE_CHECK_LABELS: Readonly<Record<GateCheckId, string>> = {
  wordCount: '字数',
  hook: '章末钩子',
  // #214 起这一项不止六维：三个「太碎」判据（`FRAGMENT`）也归它，见 `GATE_CODES`。
  aiFlavor: '去 AI 味',
  consistency: '一致性',
  sensitive: '敏感自查',
  platform: '平台规则',
  proofread: '机械校对',
  degeneration: '退化检测',
}

/**
 * Every knob the rules read.
 *
 * The values travel into the gate file (ADR-0022 D4) because a verdict without its
 * thresholds cannot be reproduced: "12 项" means nothing if the next run used a different
 * word-count window. The six de-AI dimensions' numbers are defaults, not law —
 * `open-questions.md` Q4 still holds "具体维度与阈值" as open, so a caller may pass its own
 * and the file will say which were used.
 */
export interface GateThresholds {
  /** Target range for one chapter (item 1). */
  readonly wordCountMin: number
  readonly wordCountMax: number
  /** 破折号 / 省略号 per 1000 characters (item 3, dimension 2). */
  readonly aiDashPer1000: number
  readonly aiEllipsisPer1000: number
  /** Mean sentence length above which "长句成串" is reported (dimension 1). */
  readonly aiSentenceMeanMax: number
  /** Below this coefficient of variation the sentence lengths read as machine-even. */
  readonly aiSentenceEvenness: number
  /** 的 / 地 / 程度副词 per 1000 characters (dimension 5). */
  readonly aiModifierPer1000: number
  /** How many findings one rule may report before it stops naming individual hits. */
  readonly maxFindingsPerRule: number
}

export const GATE_DEFAULTS: GateThresholds = {
  wordCountMin: 2000,
  wordCountMax: 4500,
  aiDashPer1000: 0.6,
  aiEllipsisPer1000: 1.5,
  aiSentenceMeanMax: 34,
  aiSentenceEvenness: 0.34,
  aiModifierPer1000: 55,
  maxFindingsPerRule: 5,
}

// ---------------------------------------------------------------------------
// 8 退化检测（#212）的阈值与词表
// ---------------------------------------------------------------------------

/**
 * One detector: a regex **source** plus the label a finding prints.
 *
 * The source is kept as a string rather than a shared `RegExp` on purpose: a `/g` object
 * carries `lastIndex` between calls, so two rules sharing one instance would silently skip
 * every other line. Each use compiles a fresh one.
 */
export interface DegenerationPattern {
  readonly source: string
  readonly label: string
}

/**
 * Everything the eighth check reads — thresholds and word lists, one place.
 *
 * ## 出处（ADR-0027 D2/D5）
 *
 * 类别划分、以及「**引号外叙述判定 + 对话行豁免**」这条形态，参考
 * `zenstory-ai/oh-story-claudecode` 的 `skills/story-deslop/scripts/check-degeneration.js`
 * （MIT，15,453 字节，只 `require` `fs`/`path`）。按 ADR-0027 的分档：
 *
 *   * **D2（数据表可引用）**：四类检测的名字、`TODO` / `lorem` / 工程词一类的词面，
 *     以及复读阈值的量级（长句 ≥12 字 × ≥3 次、紧邻整行 ≥8 字）；
 *   * **D5（数字可追溯）**：标 **自标** 的号码是本项目按「正文最不容易误伤」调的，理由写在
 *     每个值的注释里；凡自标值，出处只到「类别启发来自 oh-story」，数值不是他们的；
 *   * **D3（代码）**：判定代码按本仓形状重写（不在 `gate-rules.ts`，Finding 走
 *     `gateFinding()`，地址是 `path#L<n>`），改写点列在 `gate-degeneration.ts` 的文件头。
 *
 * 本表**不进** `GateThresholds`：那份表是「同一次判决要能复现」的参数（ADR-0022 D4），
 * 会随判决写进 `.inkflow/audit/gate-<chapterId>.json`；这几条是代码里的固定判据、调用方
 * 不能改，写进结论文件只会让文件多出四个恒不变的键。
 */
export interface DegenerationVocabulary {
  /** 同句连发：一句要有多长才值得计数（可见字，不含标点）。自标：12。 */
  readonly repeatSentenceMinChars: number
  /** 同句连发：出现几次算打转。12/3 是 oh-story 的标定，本仓沿用。 */
  readonly repeatSentenceMinCount: number
  /** 紧邻整行重复：整行要有多少可见字才判（短句复沓是体裁手法）。8 沿用 oh-story。 */
  readonly repeatLineMinChars: number
  /** 整段重复：只重复 2 次也要报，所以门槛抬高到 16 可见字。自标。 */
  readonly repeatBlockMinChars: number
  /** Findings 与 message 里回显的片段长度（字符）。自标：24。 */
  readonly excerptChars: number
  /** 一个**已写完**的段落以这些收尾；正文末段不以此结尾即视为截断。 */
  readonly truncatedTerminal: string
  /** 成对引号（台词、系统提示、引用物件）。引号内的内容不参与占位/工程词与复读判定。 */
  readonly quotedSpanSources: readonly string[]
  /** 占位语与元话语。 */
  readonly placeholder: readonly DegenerationPattern[]
  /** 工程词泄漏（写作流水线术语与模板占位）。 */
  readonly metaLeak: readonly DegenerationPattern[]
}

export const DEGENERATION: DegenerationVocabulary = {
  repeatSentenceMinChars: 12,
  repeatSentenceMinCount: 3,
  repeatLineMinChars: 8,
  repeatBlockMinChars: 16,
  excerptChars: 24,
  // A finished paragraph ends on a sentence terminator, a closing quote, an ellipsis run or a
  // closing bracket. `，、；：` are deliberately absent — a body ending on a comma is the
  // accident this rule exists for.
  truncatedTerminal: '[。！？!?…”"』」）)】》]$',
  // 成对引号：只收中文书名式与弯/直双引号。英文单引号（'…'）故意不收：中文正文里它是词内
  // 撇号的多，成对出现极少，收进来反而会把两处撇号之间的正常叙述整段吃掉。
  quotedSpanSources: ['「[^」]*」', '『[^』]*』', '【[^】]*】', '“[^”]*”', '"[^"]*"'],
  placeholder: [
    // 「以下是第 N 章」：批量作业里最典型的开场。锚在行首，配合「是/第」两个信号，
    // 所以「以下三条你记好」这种正常叙述不会命中。
    { source: '^\\s*以下是\\s*第\\s*[一二三四五六七八九十百千万两0-9]+\\s*章', label: '元话语（以下是第 N 章）' },
    { source: '^\\s*以下是(?:本章|正文|内容|本节|我(?:根据|按照)|根据|大纲)', label: '元话语（以下是…）' },
    { source: '^\\s*本章(?:将|主要|讲述|内容|小结|要点|分为)', label: '元话语（本章将…）' },
    // 「（此处继续展开）」一类：括号认的是形态，「括号内出现继续/省略 + 至多 12 字说明」。
    { source: '[（(]\\s*(?:此处|以下|这里|下文|后续)?\\s*(?:继续展开|继续写|省略|略去|待补|补充说明)[^）)]{0,12}[）)]', label: '占位符（括号省略）' },
    { source: '(?:此处|以下|这里|下文|后续)\\s*(?:继续展开|继续写|省略|略去|待补)', label: '占位语' },
    // 拒绝语：只在引号外算（对话里是角色在拒绝）。见 gate-degeneration.ts 的 masked()。
    { source: '我(?:无法|不能|没法)(?:答应|承诺|继续|完成|生成|创作)', label: '元话语（生成拒绝语）' },
    // 收尾寒暄一律锚行首：它们是整段性质的话，而「如需继续赶路，天亮前就得出门」这类正常叙述
    // 也以「如需」开头，只有段落级的位置信号能把两者分开。
    { source: '^\\s*(?:如需|如果需要)(?:继续|更多|其他)', label: '元话语（收尾寒暄）' },
    { source: '^\\s*(?:希望|请)(?:以上|这个|本章)(?:内容)?(?:对|能)', label: '元话语（收尾寒暄）' },
  ],
  metaLeak: [
    { source: '\\bTODO\\b', label: '工程词（TODO）' },
    { source: '\\bFIXME\\b', label: '工程词（FIXME）' },
    { source: 'lorem', label: '模板占位（lorem）' },
    { source: 'as an AI', label: '元信息（英文 AI 自指）' },
    { source: '作为(?:一个)?(?:AI|人工智能|大?语言模型|智能助手)', label: '元信息（AI 自指）' },
    { source: '\\{\\{[^}]{0,40}\\}\\}', label: '模板占位（{{…}}）' },
    { source: '占位符|placeholder', label: '模板占位' },
    // 写作流水线术语：漏进正文就破坏代入感，而漏词的模型自己发现不了。
    { source: '细纲|情节点|卷纲|字数目标|章首钩子|章尾钩子', label: '工程词（写作流水线术语）' },
  ],
}

// ---------------------------------------------------------------------------
// 太碎（#214 B 块）的阈值与词表
// ---------------------------------------------------------------------------

/**
 * The third direction of the same de-AI judgement: **too chopped**.
 *
 * The six dimensions of item 3 only ever looked at prose that is too long and too even
 * (mean sentence length, coefficient of variation, modifier density). None of them notices the
 * opposite failure — a chapter of five-character sentences, a chapter with no causal or
 * adversative link anywhere, one 300-character paragraph with no place to breathe — and the
 * polisher skill explicitly tells the model not to chop every long sentence, so the gate and
 * the skill disagreed about the direction as well as about the number (#214 A 块).
 *
 * ## 出处（ADR-0027）
 *
 * 类别划分参考 `zenstory-ai/oh-story-claudecode` 的 `check-ai-patterns.js`（MIT）里「太碎」
 * 方向的三类指纹（短句连发 / 无连接词 / 超长段）。按 ADR-0027 的分档：
 *
 *   * **D2（数据表可引用）**：只借「这三类值得判」这个分类，不借任何数字；
 *   * **D5（数字必须可追溯、阈值单一来源）**：下面每个值都是**本项目自标**，标定语料就是
 *     本仓自己的正文样本——`tests/quality-gate.test.js` 的 `CLEAN` / `CLEAN_LONG` /
 *     `LONG_SCENE` 与 7 条 `clean-*` 人工标注。实测：最长「连续 ≤5 可见字句」的 run = 2、
 *     最长单段可见字 = 70、最稀疏的连接词密度 = 1.36/千字（`CLEAN_LONG`：872 字 1 个）。
 *     三个阈值分别取 6 / 200 / 0.5，都留出了成倍的余量，理由写在各字段注释里；
 *   * **D3（代码）**：判定按本仓形状重写在 `gate-fragment.ts`，Finding 走 `gateFinding()`。
 *
 * 与 `DEGENERATION` 同样的两个理由让本表**不进** `GateThresholds`：①它是代码里的固定判据，
 * 调用方不能改（那份表是「判决要能复现」的落盘参数，ADR-0022 D4）；②把恒不变的键写进结论
 * 文件只会让文件多出五个噪声键。作者级的豁免与按书调参是 #226 的事（先落 ADR）。
 */
export interface FragmentVocabulary {
  /**
   * 「短句」的分界：可见字 ≤ 这个数的一句算短句。自标：5。
   *
   * 标定理由：中文里把一件事说清楚通常要 8 字以上，4–5 字的多是顿呼、单动作或景物顿笔——
   * 偶尔出现是节奏，连成串才是毛病（见下一项）。clean 语料里最短的**叙述**句是 4 字
   * （`CLEAN` 的「她停下脚步」），所以 5 把这类句子框进来，靠 run 的长度而不是单句长度判定。
   */
  readonly stutterSentenceMax: number
  /** 连续几句都算短句才算电报体。自标：6（clean 语料实测最长 run = 2，留 3 倍余量）。 */
  readonly stutterRun: number
  /**
   * 连接词密度下界（每千字）。自标：0.5——只为抓「整章一处都没有」。
   *
   * 为什么不贴近语料实测值 1.36：下界越低，越容得下作者的短句/冷叙述风格，而这条规则本来
   * 只需要区分「模型没写过连接」与「作者选择不写」。0.5 意味着 2000 字以内出现一处
   * 「但/却/因为」就安静。密度类判据照 `GATE_DENSITY_FLOOR` 只在长章上判（见
   * `gate-fragment.ts`），短摘录不判——与修饰密度同一条规矩。
   */
  readonly lowLinkPer1000: number
  /** 单段可见字上限。自标：200（clean 语料最长段 70 字，留近 3 倍余量）。 */
  readonly longParaChars: number
  /** 算作「连接」的词：因果 / 转折 / 递进 / 承接。只有这一族——代词与时态词不算。 */
  readonly lowLinkWords: readonly string[]
}

export const FRAGMENT: FragmentVocabulary = {
  stutterSentenceMax: 5,
  stutterRun: 6,
  lowLinkPer1000: 0.5,
  longParaChars: 200,
  // 长词在前：「但是」不该被「但」二次计数（`gate-fragment.ts` 按长度降序匹配并在命中后遮掉）。
  lowLinkWords: [
    '因为',
    '所以',
    '因此',
    '于是',
    '但是',
    '然而',
    '不过',
    '只是',
    '而且',
    '并且',
    '虽然',
    '如果',
    '若是',
    '既然',
    '除非',
    '否则',
    '反而',
    '甚至',
    '况且',
    '何况',
    '接着',
    '然后',
    '随即',
    '随之',
    '结果',
    '但',
    '却',
  ],
}

/** One character card as the gates read it: names only — the gates never judge a card. */
export interface GateRosterEntry {
  readonly id: string
  readonly name: string
  readonly aliases: readonly string[]
}

/** One ledger line, plus where it came from (a locator needs the file and the line). */
export interface GateFact {
  readonly path: string
  readonly line: number
  readonly subject: string
  readonly attribute: string
  readonly value: string
  readonly until: string | undefined
}

/** The chapter under the gate: already read, already parsed. */
export interface GateChapter {
  readonly id: string
  readonly path: string
  readonly seq: number | undefined
  readonly title: string
  readonly pov: string | undefined
  readonly body: string
  /** Characters ignoring whitespace — the same count the index keeps (`countChars`). */
  readonly wordCount: number
}

/**
 * Everything the seven rules may read. Assembled once by `gate.ts`, so a rule never touches
 * the disk (which is what makes the whole run one pass of reads) and the determinism test can
 * feed the same input twice.
 */
export interface GateInput {
  readonly chapter: GateChapter
  readonly roster: readonly GateRosterEntry[]
  readonly facts: readonly GateFact[]
  /** Chapter sequence for a chapter id or path — `undefined` when the book lacks it. */
  readonly seqOf: (reference: string) => number | undefined
  readonly thresholds: GateThresholds
}

/** How a code is filed: which check owns it, how loud it is, and what to do about it. */
export interface GateCodeSpec {
  readonly code: string
  readonly check: GateCheckId
  readonly severity: FindingSeverity
  readonly hint: string
}

/**
 * The gate's vocabulary: one row per code, in check order.
 *
 * `group` and `fixable` come from `FINDING_CODES` (see the file header); this table adds only
 * what is the gate's own business — which check emits the code, how loud it is, and one line
 * of what to do about it.
 */
export const GATE_CODES: readonly GateCodeSpec[] = [
  // 1 字数 — the target range ("did you write the chapter you planned"), not the platform's
  // hard window: item 6 owns form, item 1 owns the target.
  { code: 'GATE_WORD_COUNT_LOW', check: 'wordCount', severity: 'info', hint: '按任务书区间补足内容，或与大纲核对本章目标字数' },
  { code: 'GATE_WORD_COUNT_HIGH', check: 'wordCount', severity: 'info', hint: '删掉不推动剧情的内容，或与大纲核对本章目标字数' },

  // 2 章末钩子
  { code: 'GATE_HOOK_MISSING', check: 'hook', severity: 'warning', hint: '章末落在新处境、新疑问或新威胁上，不要用收束句结束' },
  { code: 'GATE_HOOK_SUMMARY', check: 'hook', severity: 'warning', hint: '删掉末段的总结、抒情与预告，让场景自己收口' },

  // 3 六维去 AI 味 — one code per dimension (open-questions Q4), so a report row names the
  // dimension instead of "AI 味" in general.
  { code: 'GATE_AI_SENTENCE', check: 'aiFlavor', severity: 'info', hint: '动作段用短句（10–25 字），把成串的长句切开' },
  // 数字有意不写进 hint：阈值在 `GATE_DEFAULTS`，写进提示语就是同一事实的第二份（#214 A 块）。
  { code: 'GATE_AI_PUNCT', check: 'aiFlavor', severity: 'info', hint: '破折号与省略号按每千字密度判超限：删到一两处，或改成逗号与句读' },
  { code: 'GATE_AI_PARALLEL', check: 'aiFlavor', severity: 'info', hint: '「不是…而是…」与连续同构句只在真需要排比处使用' },
  { code: 'GATE_AI_NARRATION', check: 'aiFlavor', severity: 'info', hint: '删掉动作之后的情绪结论，让读者从动作里读出来' },
  { code: 'GATE_AI_MODIFIER', check: 'aiFlavor', severity: 'info', hint: '少堆「的/地」与程度副词，改写成具体动作或细节' },
  { code: 'GATE_AI_TEMPLATE', check: 'aiFlavor', severity: 'info', hint: '换掉套路句：写具体的动作、声音或触感' },
  // 太碎（#214 B 块）—— 与上面六维同一个 check、同一个严重级：都是「写得像不像人」，
  // 都不拦写盘。三条判据的阈值在 `FRAGMENT`，判据本身在 `gate-fragment.ts`。
  { code: 'GATE_AI_STUTTER', check: 'aiFlavor', severity: 'info', hint: '电报体：把连续短句并回一句，一段里留一处能读完的长句' },
  { code: 'GATE_AI_LOW_LINK', check: 'aiFlavor', severity: 'info', hint: '整章没有因果/转折/递进：把并列的描写用「但/因为/于是」接起来' },
  { code: 'GATE_AI_LONG_PARA', check: 'aiFlavor', severity: 'info', hint: '单段太长：在动作或对话转换处断开，一段只做一件事' },

  // 4 一致性 — cross-checks against the setting library (never a second opinion about the
  // library itself: the library is the truth, the prose is what disagrees with it).
  { code: 'GATE_CONSISTENCY_POV_UNKNOWN', check: 'consistency', severity: 'warning', hint: 'pov 写角色卡里的名字或别名，或先补这张角色卡' },
  { code: 'GATE_CONSISTENCY_FACT_STALE', check: 'consistency', severity: 'info', hint: '若是回忆/回溯，把取值放进回忆语境；否则按账本当前取值改写' },

  // 5 敏感自查
  { code: 'GATE_SENSITIVE_WORD', check: 'sensitive', severity: 'warning', hint: '确认这句是否必要；必要时改成侧写，避免直陈' },

  // 6 平台规则 — the form rules platforms actually reject on: pasted-in page residue and
  // off-site promotion. Q6's platform word-count window is item 1's range; reporting one fact
  // twice would just double the noise.
  { code: 'GATE_PLATFORM_RESIDUE', check: 'platform', severity: 'warning', hint: '删掉分页、求票、码字工具留下的残留句' },
  { code: 'GATE_PLATFORM_PROMO', check: 'platform', severity: 'warning', hint: '删掉站外引流与广告词：平台会直接下架或限流' },

  // 7 机械校对 — the six classes of issue #44 plus the number/unit pair. These are the ones a
  // person would call "错字" rather than "写得不好".
  { code: 'GATE_PROOF_PUNCT_UNPAIRED', check: 'proofread', severity: 'warning', hint: '补齐或删掉不成对的引号、括号、书名号' },
  { code: 'GATE_PROOF_HALF_PUNCT', check: 'proofread', severity: 'info', hint: '把中文语境里的 , ; : ! ? 改成全角，或改写成中文标点' },
  { code: 'GATE_PROOF_FULLWIDTH_ALNUM', check: 'proofread', severity: 'info', hint: '把全角字母与数字改成半角' },
  { code: 'GATE_PROOF_REPEAT_WORD', check: 'proofread', severity: 'info', hint: '删掉重复的字词（手误或连打）' },
  { code: 'GATE_PROOF_NEAR_NAME', check: 'proofread', severity: 'warning', hint: '核对是不是把角色名写错了：名字必须与角色卡一致' },
  { code: 'GATE_PROOF_APPELLATION_MIXED', check: 'proofread', severity: 'info', hint: '同一章内统一称谓：选定一个，其余改成动作指代' },
  { code: 'GATE_PROOF_ARABIC_MEASURE', check: 'proofread', severity: 'info', hint: '正文数量一般写汉字（三个、五次），年份与编号除外' },
  { code: 'GATE_PROOF_NUMBER_MIXED', check: 'proofread', severity: 'info', hint: '同一段里统一数字写法：要么全阿拉伯数字，要么全汉字' },

  // 8 退化检测（#212）— 「模型是不是写坏了」，不是「写得好不好」。四码全 `warning`：判据是
  // 确定性的（重复 / 无收尾标点 / 占位语 / 工程词），误报面小，而批量作业的暂停策略读的是
  // warning —— 降成 `info` 就变成没人会处理的提示。
  { code: 'GATE_DEGEN_REPEAT', check: 'degeneration', severity: 'warning', hint: '删掉重复的那一段/那一句，保留一处；模型打转通常要重写该段' },
  { code: 'GATE_DEGEN_TRUNCATED', check: 'degeneration', severity: 'warning', hint: '补完结尾：正文末段要停在句末或收尾标点上，不要停在半句' },
  { code: 'GATE_DEGEN_PLACEHOLDER', check: 'degeneration', severity: 'warning', hint: '删掉占位语与元话语，按大纲把这一段真正写出来' },
  { code: 'GATE_DEGEN_META_LEAK', check: 'degeneration', severity: 'warning', hint: '删掉写作流水线术语与模板占位，改成角色/场景内的表达' },
]

const SPEC_BY_CODE = new Map(GATE_CODES.map((spec) => [spec.code, spec]))

/** The check that owns a code (`undefined` for a code this module does not emit). */
export function gateCheckOf(code: string): GateCheckId | undefined {
  return SPEC_BY_CODE.get(code)?.check
}

/**
 * Build one finding. `group` and `fixable` come from the shared catalogue, so the two lists
 * cannot disagree; an undeclared code is a programming error, not a finding, and
 * `tests/quality-gate.test.js` pins both lists so it cannot reach a build.
 */
export function gateFinding(code: string, locator: FindingLocator, detail: string): Finding {
  const spec = SPEC_BY_CODE.get(code)
  const catalogue = findingCode(code)
  if (spec === undefined || catalogue === undefined) {
    throw new Error(`gate code ${code} is missing from GATE_CODES or FINDING_CODES`)
  }
  return { code, group: catalogue.group, severity: spec.severity, locator, detail, hint: spec.hint, fixable: catalogue.fixable }
}
