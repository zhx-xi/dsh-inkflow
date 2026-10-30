/**
 * Knowledge relations: one edge per pair, endpoint types resolved through the id maps the
 * earlier phases built, and the two refusals the relation domain would make (a dangling
 * endpoint, a self loop) reported as decisions instead of dropped rows.
 *
 * WHY IT IS A FILE: it was a 80-line block inside `buildEtlPlan` — long enough that the
 * phase boundaries around it stopped being visible. It touches no local of the builder except
 * the buffers it is handed, so it moves out as a function taking exactly those.
 */

import { renderRelationFile } from './domains/relation-write.js'
import type { RelationRow } from './domains/relation-write.js'
import type { LegacyBook } from './etl-source.js'
import type { EtlDecision } from './etl-plan-types.js'
import type { BuilderState, Tally } from './etl-plan-text.js'
import { entityIdOf, fileSlug, newTally, normalizeText, pushWrite, trimBlank } from './etl-plan-text.js'
import { codePoints } from './etl-plan-text.js'

/**
 * Append the relations phase's writes and decisions. The three id maps are the earlier
 * phases' output: an edge whose endpoint is not in them names an entity that does not exist.
 */
export function planRelationEdges(input: {
  readonly book: LegacyBook
  readonly state: BuilderState
  readonly decisions: EtlDecision[]
  readonly relationTally: Tally
  readonly characterIdOf: ReadonlyMap<number, string>
  readonly worldIdOf: ReadonlyMap<number, string>
  readonly outlineIdOf: ReadonlyMap<number, string>
}): void {
  const { book, state, decisions, relationTally, characterIdOf, worldIdOf, outlineIdOf } = input

  const idOfType = (type: string, id: number): string | undefined => {
    const value = type.trim().toLowerCase()
    if (value === 'character' || value === 'characters') return characterIdOf.get(id)
    if (value === 'world' || value === 'world_setting' || value === 'world_settings') return worldIdOf.get(id)
    if (value === 'outline' || value === 'outlines') return outlineIdOf.get(id)
    return undefined
  }
  const dangling: string[] = []
  const seenEdges = new Set<string>()
  let duplicateEdges = 0
  for (const relation of book.relations) {
    const source = idOfType(relation.sourceType, relation.sourceId)
    const target = idOfType(relation.targetType, relation.targetId)
    if (source === undefined || target === undefined) {
      // The edge names two entities and one of them does not exist: RELATION_ENDPOINT would
      // refuse it, so the row cannot land. Real loss, and the decision names it.
      relationTally.lost += 1
      const named = `#${String(relation.id)}（${relation.sourceType}:${String(relation.sourceId)} → ${relation.targetType}:${String(relation.targetId)}）`
      relationTally.notes.push(`关系 ${named} 的端点解析不到实体：未迁移（RELATION_ENDPOINT）`)
      dangling.push(named)
      continue
    }
    if (source === target) {
      relationTally.lost += 1
      relationTally.notes.push(`关系 #${String(relation.id)} 的两端是同一个实体：未迁移（RELATION_SELF_LOOP）`)
      dangling.push(`#${String(relation.id)}（两端相同：RELATION_SELF_LOOP）`)
      continue
    }
    const edgeKey = `${source}\u0000${target}`
    if (seenEdges.has(edgeKey)) {
      duplicateEdges += 1
      // RELATION_DUPLICATE: one edge is declared once. The first copy landed, so the
      // duplicate is a representation the model already holds, not a silent deletion.
      relationTally.dropped += 1
      continue
    }
    seenEdges.add(edgeKey)
    const label = normalizeText(relation.relationType).trim()
    const row: RelationRow = {
      id: entityIdOf('knowledge_relations', relation.id, undefined),
      path: '',
      title: label === '' ? `${source} → ${target}` : label,
      relationKind: 'knowledge',
      source,
      target,
      direction: 'directed',
      since: undefined,
      until: undefined,
      chapter: undefined,
    }
    const description = trimBlank(relation.description)
    const body = description === '' ? undefined : `${description}\n`
    const text = renderRelationFile(body, row)
    relationTally.mapped += 1
    pushWrite(
      state,
      'knowledge_relations',
      relation.id,
      row.id,
      `relations/${fileSlug(label === '' ? 'relation' : label, 'relation', 24)}-${fileSlug(source, 'a', 16)}-${fileSlug(target, 'b', 16)}.md`,
      text,
      codePoints(text),
    )
  }
  if (dangling.length > 0) {
    decisions.push({
      code: 'ETL_RELATION_ENDPOINT_UNMAPPED',
      count: dangling.length,
      detail: `${String(dangling.length)} 条知识关系的端点解析不到实体，未迁移：${dangling.slice(0, 5).join('、')}`,
      hint: '关系两端必须都存在（RELATION_ENDPOINT）；补齐实体后用 inkflow_relation_upsert 重建这几条边',
    })
  }
  if (duplicateEdges > 0) {
    decisions.push({
      code: 'ETL_RELATION_DUPLICATE',
      count: duplicateEdges,
      detail: `${String(duplicateEdges)} 条知识关系与前面的边同端点重复，按 RELATION_DUPLICATE 只保留第一条`,
      hint: '同端点不同关系类型的边可以在 relations/ 里手工合并',
    })
  }
}
