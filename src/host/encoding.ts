/**
 * Mojibake detection for hand-written meta files.
 *
 * THE CASE: an author (or an agent driving a shell) creates `inkflow.json` with
 * PowerShell 5's `Set-Content`/`echo`, whose default code page is ANSI/GBK on a
 * Chinese Windows. The file ends up holding GBK-decoded UTF-8: the field report
 * in the field report has `"title": "浜哄湪铚€灞憋紝鏄帉闂?"` for `人在蜀山，我是掌门`.
 * This plugin's own writer (`io.ts` → UTF-8, no BOM) never produces that, but a
 * file it did not write can still be *read* by it. Silently treating such a title
 * as the book name is the failure this module exists to catch.
 *
 * WHY A CURATED TABLE AND NOT "IS IT CJK?": reading UTF-8 as GBK does not yield
 * random garbage — it yields characters from a narrow, extremely rare slice of
 * the CJK block (浜 涓 鍦 鏄 鏈 鐨 锛 銆 鈥 …). Genuine Chinese, Japanese, Korean and
 * emoji all stay out of that slice. A "density of non-ASCII" test would flag
 * every Chinese title; this one flags the accident.
 *
 * HOW THE TABLE WAS BUILT (reproducible, evidence in the issue thread):
 *   1. take a corpus of genuinely written Chinese (this repository's prose,
 *      ~1.1M characters);
 *   2. decode the same corpus' UTF-8 bytes as GBK — what the accident produces;
 *   3. keep the artifacts that occur in step 2 and NEVER occur in step 1;
 *   4. group them by the GBK lead byte of the artifact, i.e. by the UTF-8 byte
 *      class that was misread (`E4`, `E5`, … `E9`, the punctuation bytes
 *      `E2`/`E3`/`EF`, and the shifted pairs whose pair straddles two characters);
 *   5. drop the top-80 per group that also occur in a second, held-out corpus
 *      (a skill library) — a character real Chinese prose uses is not a tell;
 *   6. drop the few survivors modern prose still legitimately uses (`NOT_A_TELL`).
 *
 * MEASURED on a held-out corpus (783 windows per length, `TextDecoder('gbk')` as
 * the encoder side stand-in): 0 genuine windows flagged at every length from 2 to
 * 10 characters; GBK-misread windows flagged 31% (2 chars), 75% (3), 82% (4), 92%
 * (6), 94% (10). Recall is deliberately the looser side of that trade: a missed
 * garble only means the author sees a strange title without an explanation, while
 * a false positive nags every ordinary Chinese book name.
 *
 * Zero dependencies: the table is data, the test is a loop.
 */

/**
 * One group of artifacts: what ONE misread UTF-8 byte class looks like after a
 * GBK round trip. Grouping matters — the rule below counts groups, so a genuine
 * title that happens to contain one of these rare characters (涓流, 河浜) stays
 * quiet unless a second, unrelated class shows up too.
 */
interface SignatureGroup {
  readonly name: string
  readonly chars: string
}

const SIGNATURE_GROUPS: readonly SignatureGroup[] = [
  // EF — full-width punctuation (，！？：；)
  { name: 'punctuation-ef', chars: '锛锝' },
  // E3 80 — ideographic punctuation (。、)
  { name: 'punctuation-e3', chars: '銆' },
  // E2 80/86/94 — dashes, ellipsis, arrows, box drawing
  { name: 'punctuation-e2', chars: '鈥鈹鈫鉁鈮鈶鈽鉂鈭鈻' },
  // E4 — 人 什 一 们 代 …
  { name: 'lead-e4', chars: '涓浠浣浜涔浼淇渚' },
  // E5 — 在 地 又 关 其 …
  { name: 'lead-e5', chars: '鍙鍏鍐瀹鍚鍒澶鍗褰宸鍦瀛搴寮鍥鍔寰鍖瀵寤鍓鍑蹇鍘灞骞濂甯鍧鍛鍝鍋鍩鍣鍊鍞鍨澧濮澹濉宓濡濞鍍宕鍜鍠鍌鍕' },
  // E6 — 是 有 时 文 数 …
  { name: 'lead-e6', chars: '鏂鏈鏄鏃鏉鎴鏀鏍姝鎻鏁鎵鎶鏋鎺鎬娉鎸娈娆娓妫鎹鎷娴娌鏌妯姣婧妗鏇姹鎯鎰娑鎭鎽婊鏅姘鎿婕鎾鎼妲鎮娣鏆姒姊婵鎳娼' },
  // E7 — 的 现 眼 目 端 …
  { name: 'lead-e7', chars: '鐨鐩绔鐢绾缁绗绱缂鐜鐗鐣鐪鐘绂纭绉鐧鐐绋鐮绛绠绌绯绫缃绡绐鐭绀鐓鐞缈鐙纰纾绮鐖鐫鐒鐚鐏鐑鐤鐥缇' },
  // E8 — 说 话 见 语 请 …
  { name: 'lead-e8', chars: '璇杩瑙璁琛璺鑷鑳璧璐鑰琚杈杞鑺璋瑁钀瓒鑴韬鑹鑻鑼鑱瑷鑽钘瑗鑵鑸璞韪鑲璀铏铚' },
  // E9 — 门 问 音 高 长 …
  { name: 'lead-e9', chars: '閲椤闂闈閫閮闄閿楠棰闃闇闆閰楣闀閬榛椋閽棣楂闅閾閭榻閴椹榫楦闉椴闊楹楗' },
  // Pairs that straddle two characters (continuation byte + next lead byte).
  { name: 'shifted', chars: '嶅紝笉級竴殑紙枃洰屽細屾佸佹紱屼堝啓敤夛夈嶆湰綍嶇乣佷笌勫堟囦綔哄撳圭愬佺槸呭珷舵湁愭氬敼北彲湪岃嶈跺氳畾勬彧兘瑰佽叆簱诲虹嵁氭涘紩欏氥坄曞呴岀犳噸洖嬪疄烘滃椂' },
]

/**
 * Characters the generator kept but that ordinary Chinese (especially literary
 * prose and personal names) really uses: 北/凡 in place names, 寰宇, 澹泊, 濮阳,
 * 娓娓道来, 姣好, 妖娆, 缥缈, 绫罗, 绯红, 绮罗, 楠/棣/楹 (names and place names),
 * 璐/琛/璇 (given names), 哄 (哄笑), 圭 (圭臬).
 *
 * They are artifacts too — but "rare in a technical corpus" is not the same as
 * "never in a novel", and one false positive costs more than one miss here.
 */
const NOT_A_TELL = '北哄圭寰澹濮濂濡骞宕濉姣娓娴娆姹婧妲娉绮绫绯绡缃缈纰纾绀绂绔绉璇璐琛棣楠榛楣楹'

/** `char → group name`, built once: the table is data, the lookup is a map. */
function buildSignatures(): Map<string, string> {
  const signatures = new Map<string, string>()
  for (const group of SIGNATURE_GROUPS) {
    for (const char of group.chars) {
      if (NOT_A_TELL.includes(char)) continue
      // First group wins; the groups are disjoint by construction, and a bug
      // that made them overlap must not double-count a single character.
      if (!signatures.has(char)) signatures.set(char, group.name)
    }
  }
  return signatures
}

const SIGNATURES: ReadonlyMap<string, string> = buildSignatures()

/** Distinct artifact classes that must appear before a text is called suspicious. */
export const MIN_SIGNATURE_FEATURES = 2

/**
 * Share of the non-ASCII characters that must be artifacts. A real garble covers
 * most of the text (the field title: 0.73); a lone rare character inside an
 * otherwise normal title stays far below this.
 */
export const MIN_NON_ASCII_RATIO = 0.3

/** What `describeEncodingSuspicion` reports: the verdict plus its evidence. */
export interface EncodingSuspicion {
  suspicious: boolean
  /** Matched group names, in table order, each at most once. */
  hits: string[]
}

/**
 * Judge `text` as a GBK round-trip accident.
 *
 * Suspicious means BOTH: at least `MIN_SIGNATURE_FEATURES` distinct artifact
 * classes, AND at least `MIN_NON_ASCII_RATIO` of the non-ASCII characters are
 * artifacts. Two conditions because either alone is a false-positive machine —
 * one rare character at 100% of a two-character title, or a long paragraph that
 * happens to contain a handful of them.
 */
export function describeEncodingSuspicion(text: string): EncodingSuspicion {
  let nonAscii = 0
  let artifacts = 0
  const groups: string[] = []
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) <= 0x7f) continue
    nonAscii += 1
    const group = SIGNATURES.get(char)
    if (group === undefined) continue
    artifacts += 1
    if (!groups.includes(group)) groups.push(group)
  }
  const suspicious = groups.length >= MIN_SIGNATURE_FEATURES && artifacts / nonAscii >= MIN_NON_ASCII_RATIO
  return { suspicious, hits: groups }
}

/** The one-bit form of `describeEncodingSuspicion`. */
export function looksLikeGbkMojibake(text: string): boolean {
  return describeEncodingSuspicion(text).suspicious
}
