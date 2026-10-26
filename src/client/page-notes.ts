/**
 * The one standing sentence each of the two "does this hold?" pages prints in its header.
 *
 * WHY THEY ARE CONSTANTS IN THEIR OWN MODULE: 体检 and 门禁 sit next to each other in the
 * tab row and both talk about correctness, so the only thing that tells a first-time reader
 * which page answers which question is one sentence per page. That sentence must be
 * standing text (the empty state is exactly the case where it is not there) and the two
 * must not contradict each other — so they are written once, next to each other, and a test
 * reads both and checks each one names its own scope and its own limit.
 *
 * The split: the audit walks the WHOLE book and asks whether its parts agree with each other
 * (a ledger entry against the prose, a foreshadow against its deadline, a catalog against the
 * chapters). The gate reads ONE chapter and reports mechanical defects. Neither judges
 * whether the writing is any good, and the gate calls no model.
 */

/** 体检: whole-book, cross-entity. */
export const AUDIT_SCOPE_NOTE =
  '这本书的各部分彼此对得上吗：全书跨实体的一致性与不变量（设定账本 / 伏笔 / 时间线 / 目录与正文）。它不判单章写得好不好。'

/** 门禁: one chapter, mechanical. */
export const GATE_SCOPE_NOTE = '单章机械判读（错字、硬伤、句式），零模型调用：它判这一章的毛病，不判全书一致。'
