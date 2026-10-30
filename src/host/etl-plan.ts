/**
 * Old InkFlow rows → the nine content directories (roadmap X-29).
 *
 * This module is **pure**: it takes the rows `etl-source.ts` read, the prior id map and
 * a "what is on disk" probe, and returns the whole plan (target path + text + counts).
 * It does not open the book, write a byte, or take a lock — that is `etl.ts`. Two
 * consequences, both load-bearing:
 *
 *   1. **Dry run and apply are the same computation** (X-29): `etl.ts` calls
 *      `buildEtlPlan()` once per run, so the preview a person reads and the files that
 *      land cannot diverge — there is no second renderer to keep in sync.
 *   2. The mapping is unit-testable against hand-built rows, with no SQLite file and no
 *      filesystem in the loop.
 *
 * Every document goes through the **renderer its domain already uses**
 * (`renderCharacterCard`, `renderWorldFile`, `renderOutlineDocument`,
 * `renderForeshadowDocument`, `renderTimelineDocument`, `renderRelationFile`,
 * `renderPlotPoints`). A second renderer would be a second dialect of the same file
 * format, and the first field added to the real one would prove it.
 *
 * ## The 13 legacy tables and where each one lands
 *
 * | legacy table | target | unit counted for the ≤1% check |
 * |---|---|---|
 * | `volumes` | the volume node `outlines/vol-NN-<slug>.md` (+ the directory its chapters create) | volume rows |
 * | `chapters` | `chapters/**\/NNNN-<slug>.md` | chapter files (plus a 字数 reconciliation) |
 * | `chapter_summaries` | `library/etl-chapter-summaries.md` | summary lines |
 * | `characters` | `characters/<name>.md` | cards |
 * | `character_groups` (+`character_group_members`) | the card's `group` field | groups with ≥1 member, plus every membership |
 * | `world_categories` | the `world/<category>/` directories the entries need | categories that hold ≥1 entry |
 * | `world_settings` | `world/<category>/<slug>.md`, the root at `world/<slug>.md` | entries |
 * | `outlines` | `outlines/*.md` | nodes |
 * | `plot_points` | bullets inside its outline's body (`renderPlotPoints`) | rendered bullets |
 * | `story_arcs` | the `[故事线]` tag on those bullets | arcs that end up tagging ≥1 bullet |
 * | `foreshadowings` | `foreshadowing/<slug>.md` | entries |
 * | `timeline_events` | `timeline/<slug>.md` | events |
 * | `knowledge_relations` | `relations/<slug>.md` | edges whose **both** endpoints resolve |
 *
 * `facts/` has no legacy source: the fact ledger is a 0.3.0 domain the old app never had,
 * so it is simply not one of the 13 — nothing is dropped from the table to hide that.
 *
 * ## What is deliberately NOT invented
 *
 *   * **Chapter numbers are preserved**, gaps and all (`121–137` in the real 蜀山 case).
 *     `renumber: 'compact'` is the author's explicit choice, never a default.
 *   * **A `resolved` foreshadow with no recorded chapter** cannot satisfy I-09, so it
 *     lands as `planted` with the legacy state in a body note and a line in
 *     `decisions[]`. Inviting a chapter number out of a timestamp would be worse than a
 *     visible TODO.
 *   * **A timeline event whose `time_display` is not a calendar date** lands `status:
 *     unconfirmed` (the pending area) rather than being squeezed into a date.
 *   * **A relation whose endpoint is missing** is skipped and reported: I-08 refuses a
 *     dangling endpoint, and "drop it silently" is the one thing a migration must not do.
 *   * **An existing target file with other content is never overwritten** (`conflict`).
 */

import { createHash } from 'node:crypto'

import { CHAPTERS_DIR, CHAPTER_STATUSES, LIBRARY_DIR } from './conventions.js'
import { renderCharacterCard } from './domains/character-write.js'
import { renderForeshadowDocument } from './domains/foreshadowing-plan.js'
import type { ForeshadowStatus } from './domains/foreshadowing-plan.js'
import type { OutlinePlotPoint } from './domains/outline-model.js'
import { renderOutlineDocument, renderPlotPoints } from './domains/outline-write.js'
import { renderRelationFile } from './domains/relation-write.js'
import type { RelationRow } from './domains/relation-write.js'
import { renderTimelineDocument } from './domains/timeline-document.js'
import { renderWorldFile } from './domains/world-tools.js'
import { ETL_TABLES } from './etl-source.js'
import type { EtlTable, LegacyBook } from './etl-source.js'
import { frontmatterLine, splitFrontmatter } from './frontmatter.js'

// The phase modules the builder reads from. Everything they define is re-exported at the
// bottom of this file, so `etl.ts` and the tool surface still import one module.
import { planRelationEdges } from './etl-plan-relations.js'
import { codePoints, entityIdOf, fileSlug, newTally, normalizeText, pushWrite, trimBlank } from './etl-plan-text.js'
import type { BuilderState, Tally } from './etl-plan-text.js'
import type {
  EtlClassReport, EtlComputation, EtlDecision, EtlDiskProbe, EtlGap, EtlIdMap, EtlIdMapEntry,
  EtlItem, EtlItemState, EtlPlan, EtlPlanOptions, EtlReconcile, EtlWrite,
} from './etl-plan-types.js'
import { ETL_IDMAP_RELATIVE, ETL_IDMAP_VERSION } from './etl-plan-types.js'
import { basenameOf, pad2, pad4, sha256 } from './etl-plan-text.js'
import { CALENDAR_DATE, chapterStatusOf, foreshadowStatusOf, numberChapters } from './etl-plan-chapters.js'

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/** Build the whole plan for one legacy book. Nothing here reads or writes the disk. */
export function buildEtlPlan(book: LegacyBook, options: EtlPlanOptions): EtlComputation {
  const renumber: 'keep' | 'compact' = options.renumber === 'compact' ? 'compact' : 'keep'
  const state: BuilderState = { writes: [], used: new Map() }
  const decisions: EtlDecision[] = []
  const warnings: string[] = []

  // ---- id maps first: references run in both directions ----------------------------
  const chapterIdOf = new Map<number, string>()
  for (const chapter of book.chapters) chapterIdOf.set(chapter.id, entityIdOf('chapters', chapter.id, chapter.uuid))
  const characterIdOf = new Map<number, string>()
  for (const character of book.characters) characterIdOf.set(character.id, entityIdOf('characters', character.id, character.uuid))
  const worldIdOf = new Map<number, string>()
  for (const entry of book.world) worldIdOf.set(entry.id, entityIdOf('world_settings', entry.id, entry.uuid))
  const outlineIdOf = new Map<number, string>()
  for (const outline of book.outlines) outlineIdOf.set(outline.id, entityIdOf('outlines', outline.id, outline.uuid))

  // ---- volumes: `vol-NN` ids are re-allocated from the legacy reading order --------
  const volumes = [...book.volumes].sort((left, right) => left.orderIndex - right.orderIndex || left.id - right.id)
  const volumeIdOf = new Map<number, string>()
  const volumeDirOf = new Map<number, string>()
  const volumeTally = newTally()
  volumes.forEach((volume, index) => {
    const volumeId = `vol-${pad2(index + 1)}`
    volumeIdOf.set(volume.id, volumeId)
    volumeDirOf.set(volume.id, `${CHAPTERS_DIR}/${volumeId}-${fileSlug(volume.title, volumeId, 40)}`)
  })

  // ---- the single overall outline node ---------------------------------------------
  const overallRows = book.outlines.filter((outline) => outline.level === 'overall')
  const overallRow = overallRows[0]
  const overallId =
    overallRow === undefined ? `lg-overall-${String(book.project.id)}` : entityIdOf('outlines', overallRow.id, overallRow.uuid)
  if (overallRows.length > 1) {
    decisions.push({
      code: 'ETL_OUTLINE_MULTI_OVERALL',
      count: overallRows.length,
      detail: `旧库有 ${String(overallRows.length)} 条 level=overall 的大纲；只把「${String(overallRow?.name ?? '')}」写成根，其余挂到根下`,
      hint: '整体大纲只能有一个；迁移后检查 outlines/ 并把多余的并进去',
    })
  }

  // ---- chapters --------------------------------------------------------------------
  const numbering = numberChapters(book, renumber)
  const chapterTally = newTally()
  const numbersByVolume = new Map<string, number[]>()
  let legacyChars = 0
  let plannedChars = 0

  for (const chapter of book.chapters) {
    const number = numbering.numbers.get(chapter.id) ?? 1
    // A chapter pointing at a volume row that is gone still has content, so it lands as a
    // loose chapter with a note rather than being dropped: the text is the part that
    // cannot be reconstructed.
    let volumeId = chapter.volumeId === null ? undefined : volumeIdOf.get(chapter.volumeId)
    let dir = chapter.volumeId === null ? undefined : volumeDirOf.get(chapter.volumeId)
    if (chapter.volumeId !== null && (volumeId === undefined || dir === undefined)) {
      chapterTally.notes.push(`章 ${String(chapter.id)} 指向不存在的卷 ${String(chapter.volumeId)}：按散章迁移`)
      volumeId = undefined
      dir = undefined
    }
    const scope = volumeId ?? 'loose'
    const scopeNumbers = numbersByVolume.get(scope) ?? []
    scopeNumbers.push(number)
    numbersByVolume.set(scope, scopeNumbers)

    const rawTitle = normalizeText(chapter.title).trim()
    const title = rawTitle === '' ? `第${String(number)}章` : rawTitle
    const fileName = `${pad4(number)}-${fileSlug(title, `chapter-${String(number)}`)}.md`
    const path = dir === undefined ? `${CHAPTERS_DIR}/${fileName}` : `${dir}/${fileName}`
    const body = trimBlank(chapter.content)
    const entityId = entityIdOf('chapters', chapter.id, chapter.uuid)
    const head = ['---', frontmatterLine('id', entityId), frontmatterLine('title', title)]
    if (volumeId !== undefined) head.push(frontmatterLine('volume', volumeId))
    head.push(frontmatterLine('seq', String(number)), frontmatterLine('status', chapterStatusOf(chapter.status)), '---', '')
    const text = `${head.join('\n')}\n${body === '' ? '' : `${body}\n`}`

    legacyChars += codePoints(normalizeText(chapter.content))
    plannedChars += codePoints(body)
    chapterTally.mapped += 1
    pushWrite(state, 'chapters', chapter.id, entityId, path, text, codePoints(body))
  }
  if (numbering.conflicts.length > 0) {
    decisions.push({
      code: 'ETL_SEQ_CONFLICT',
      count: numbering.conflicts.length,
      detail: `旧库 order_index 有重复或非整数，${String(numbering.conflicts.length)} 章改用了下一个空号（章 id：${numbering.conflicts.slice(0, 10).join(', ')}）`,
      hint: '迁移后按 order_index 核对章序；要连续编号请用 renumber: "compact"',
    })
  }

  // ---- volume nodes -----------------------------------------------------------------
  for (const volume of volumes) {
    const volumeId = volumeIdOf.get(volume.id)
    if (volumeId === undefined) continue
    const title = normalizeText(volume.title).trim() === '' ? volumeId : normalizeText(volume.title).trim()
    const entityId = entityIdOf('volumes', volume.id, undefined)
    const text = renderOutlineDocument({
      fields: {
        id: entityId,
        kind: 'volume',
        title,
        parent: overallId,
        order: Number.parseInt(volumeId.slice('vol-'.length), 10),
      },
      body: '',
    })
    volumeTally.mapped += 1
    if ((numbersByVolume.get(volumeId) ?? []).length === 0) {
      volumeTally.notes.push(`${volumeId}（${title}）没有章：只写卷大纲，不建空目录`)
    }
    pushWrite(state, 'volumes', volume.id, entityId, `outlines/${volumeId}-${fileSlug(title, volumeId, 40)}.md`, text, codePoints(text))
  }

  // ---- characters -------------------------------------------------------------------
  const characterTally = newTally()
  const groupById = new Map(book.groups.map((group) => [group.id, group]))
  const groupTally = newTally()
  const characterNames = new Map<number, string>()
  for (const character of book.characters) {
    const rawName = normalizeText(character.name).trim()
    // A nameless card still carries prose, so it lands under a placeholder name with a note:
    // dropping it would lose the only copy of that background text.
    const name = rawName === '' ? `角色${String(character.id)}` : rawName
    if (rawName === '') characterTally.notes.push(`角色 ${String(character.id)} 在旧库没有名字：落盘为「${name}」，请改名`)
    characterNames.set(character.id, name)
    const groupIds = book.groupMembers.get(character.id) ?? []
    const firstGroup = groupIds.map((id) => groupById.get(id)).find((group) => group !== undefined)
    const sections: string[] = []
    for (const [heading, value] of [
      ['性格', character.personality],
      ['背景', character.background],
      ['目标', character.goals],
      ['简介', character.brief],
    ] as const) {
      const prose = trimBlank(value)
      if (prose !== '') sections.push(`## ${heading}\n\n${prose}`)
    }
    const entityId = entityIdOf('characters', character.id, character.uuid)
    const text = renderCharacterCard(
      {
        id: entityId,
        name,
        ...(firstGroup === undefined ? {} : { group: firstGroup.name }),
      },
      sections.length === 0 ? undefined : `${sections.join('\n\n')}\n`,
    )
    characterTally.mapped += 1
    if (groupIds.length > 1) {
      groupTally.notes.push(`角色「${name}」属于 ${String(groupIds.length)} 个分组：只写第一个（${firstGroup?.name ?? '?'}）`)
    }
    pushWrite(
      state,
      'characters',
      character.id,
      entityId,
      `characters/${fileSlug(name, `character-${String(character.id)}`, 64)}.md`,
      text,
      codePoints(text),
    )
  }
  for (const group of book.groups) {
    const members = [...book.groupMembers.values()].filter((list) => list.includes(group.id))
    if (members.length === 0) {
      // A group is a field on a card in the new model, so a group with no members has no
      // place to live — recorded, not lost.
      groupTally.dropped += 1
      groupTally.notes.push(`分组「${group.name}」没有成员：新模型里分组是角色卡上的字段，空组没有落点`)
      continue
    }
    groupTally.mapped += 1
  }
  // A membership is one written `group` field, so it counts as mapped too.
  groupTally.mapped += [...book.groupMembers.values()].reduce((sum, list) => sum + list.length, 0)
  for (const [characterId, list] of book.groupMembers) {
    for (const groupId of list) {
      if (groupById.has(groupId) && characterNames.has(characterId)) continue
      groupTally.lost += 1
      groupTally.notes.push(`成员关系 ${String(characterId)}→${String(groupId)} 的一端不存在：未迁移`)
    }
  }

  // ---- world -----------------------------------------------------------------------
  const worldTally = newTally()
  const categoryTally = newTally()
  const roots = book.world.filter((entry) => entry.parentId === null)
  const rootEntry = roots[0]
  if (roots.length > 1) {
    decisions.push({
      code: 'ETL_WORLD_MULTI_ROOT',
      count: roots.length - 1,
      detail: `旧库有 ${String(roots.length)} 个 parent_id 为空的根条目；只把「${String(rootEntry?.name ?? '')}」写成根，其余按分类落在 world/<category>/ 下且不写 parent`,
      hint: '世界观树只允许一个根；其余条目需要作者决定挂到哪',
    })
  }
  const byId = new Map(book.world.map((entry) => [entry.id, entry]))
  const nearestCategory = (id: number, depth = 0): string => {
    if (depth > 24) return ''
    const entry = byId.get(id)
    if (entry === undefined) return ''
    if (entry.parentId === null) return ''
    const parent = byId.get(entry.parentId)
    if (parent === undefined) return ''
    const own = normalizeText(parent.category).trim()
    return own !== '' ? own : nearestCategory(parent.id, depth + 1)
  }
  const categoriesUsed = new Set<string>()
  for (const entry of book.world) {
    const rawName = normalizeText(entry.name).trim()
    // Same reasoning as the character cards: the body is the unrecoverable part, so a
    // nameless entry lands under a placeholder name with a note.
    const name = rawName === '' ? `世界观${String(entry.id)}` : rawName
    if (rawName === '') worldTally.notes.push(`世界观条目 ${String(entry.id)} 在旧库没有名字：落盘为「${name}」，请改名`)
    const isRoot = entry.id === rootEntry?.id
    const ownCategory = normalizeText(entry.category).trim()
    const category = isRoot ? undefined : ownCategory !== '' ? ownCategory : nearestCategory(entry.id) || '未分类'
    if (category !== undefined) categoriesUsed.add(category)

    let parent: string | undefined
    if (!isRoot && entry.parentId !== null) {
      const mapped = worldIdOf.get(entry.parentId)
      if (mapped === undefined) {
        worldTally.notes.push(`「${name}」的父条目 ${String(entry.parentId)} 不存在：写成无 parent 的顶层条目`)
      } else parent = mapped
    }
    const entityId = entityIdOf('world_settings', entry.id, entry.uuid)
    const text = renderWorldFile({
      id: entityId,
      title: name,
      ...(category === undefined ? {} : { category }),
      ...(parent === undefined ? {} : { parent }),
      keywords: [],
      always: false,
      body: trimBlank(entry.content),
    })
    const path =
      category === undefined
        ? `world/${fileSlug(name, `world-${String(entry.id)}`)}.md`
        : `world/${fileSlug(category, '未分类', 32)}/${fileSlug(name, `world-${String(entry.id)}`)}.md`
    worldTally.mapped += 1
    pushWrite(state, 'world_settings', entry.id, entityId, path, text, codePoints(text))
  }
  for (const category of book.categories) {
    const name = normalizeText(category.name).trim()
    if (name !== '' && categoriesUsed.has(name)) {
      categoryTally.mapped += 1
      continue
    }
    // A category is a directory in the new model; one that holds no entry has nothing to
    // create, and inventing an empty directory would be a file the author never wrote.
    categoryTally.dropped += 1
    categoryTally.notes.push(`分类「${name}」（${category.kind}）没有条目：新模型里分类就是目录，空分类没有落点`)
  }

  // ---- outlines, plot points, arcs --------------------------------------------------
  const outlineTally = newTally()
  const plotTally = newTally()
  const arcTally = newTally()
  const arcById = new Map(book.arcs.map((arc) => [arc.id, arc]))
  const arcsUsed = new Set<number>()
  const pointsByOutline = new Map<number, OutlinePlotPoint[]>()
  const knownOutlines = new Set(book.outlines.map((outline) => outline.id))
  for (const point of book.plotPoints) {
    if (!knownOutlines.has(point.outlineId)) {
      // Its outline row is gone, so there is no document to put the bullet in. This one is
      // real loss (the text exists and cannot land) and counts against the ≤1% check.
      plotTally.lost += 1
      plotTally.notes.push(`情节点 ${String(point.id)} 的大纲节点 ${String(point.outlineId)} 不存在：未迁移`)
      continue
    }
    const arc = point.arcId === null ? undefined : arcById.get(point.arcId)
    const label = normalizeText(point.name).trim()
    const detail = trimBlank(point.description).replace(/\s*\n+\s*/gu, ' ')
    const text = [label, detail].filter((part) => part !== '').join('：')
    if (text === '') {
      plotTally.dropped += 1
      continue
    }
    const list = pointsByOutline.get(point.outlineId) ?? []
    const arcName = arc === undefined ? '' : normalizeText(arc.name).trim()
    list.push({ text, ...(arcName === '' ? {} : { arc: arcName }) })
    pointsByOutline.set(point.outlineId, list)
    if (arc !== undefined) arcsUsed.add(arc.id)
    plotTally.mapped += 1
  }
  for (const arc of book.arcs) {
    if (arcsUsed.has(arc.id)) arcTally.mapped += 1
    else {
      // data-model §2 lists `outlines/arcs/<slug>.md` as 【未实现】, so an arc with no plot
      // points has no legal target. Recorded, and the author is told.
      arcTally.dropped += 1
      arcTally.notes.push(`故事线「${arc.name}」没有情节点引用：新模型里故事线只是情节点上的标签，无引用即无落点`)
    }
  }

  const volumeNodeIdOf = new Map<number, string>()
  for (const volume of volumes) volumeNodeIdOf.set(volume.id, entityIdOf('volumes', volume.id, undefined))

  const orderedOutlines = [...book.outlines].sort((left, right) => left.sortOrder - right.sortOrder || left.id - right.id)
  for (const outline of orderedOutlines) {
    const entityId = entityIdOf('outlines', outline.id, outline.uuid)
    const rawTitle = normalizeText(outline.name).trim()
    const title = rawTitle === '' ? `outline-${String(outline.id)}` : rawTitle
    const kind = outline.level === 'overall' ? 'overall' : outline.level === 'volume' ? 'volume' : 'chapter'

    let parent: string | null
    if (kind === 'overall' && outline.id === overallRow?.id) {
      parent = null
    } else {
      const legacyParent = outline.parentId === null ? undefined : outlineIdOf.get(outline.parentId)
      const volumeNode = outline.volumeId === null ? undefined : volumeNodeIdOf.get(outline.volumeId)
      const chosen = legacyParent ?? volumeNode ?? overallId
      parent = chosen === entityId ? overallId : chosen
      if (kind === 'overall') {
        parent = overallId
      } else if (outline.parentId !== null && legacyParent === undefined) {
        outlineTally.notes.push(
          `大纲节点「${title}」的 parent ${String(outline.parentId)} 不存在：挂到${volumeNode === undefined ? '整体大纲' : '所属卷'}下`,
        )
      }
    }

    const points = pointsByOutline.get(outline.id) ?? []
    const description = trimBlank(outline.description)
    const bullets = points.length === 0 ? '' : renderPlotPoints(points).trimEnd()
    const body = [description, bullets].filter((part) => part !== '').join('\n\n')
    const text = renderOutlineDocument({
      fields: {
        id: entityId,
        kind,
        title,
        parent,
        order: Number.isFinite(outline.sortOrder) ? Math.trunc(outline.sortOrder) : 0,
      },
      body: body === '' ? '' : `${body}\n`,
    })
    outlineTally.mapped += 1
    const path =
      kind === 'overall' && outline.id === overallRow?.id
        ? 'outlines/overall.md'
        : `outlines/${fileSlug(title, `outline-${String(outline.id)}`, 40)}.md`
    pushWrite(state, 'outlines', outline.id, entityId, path, text, codePoints(text))
  }

  // ---- chapter summaries → one library registration ---------------------------------
  const summaryTally = newTally()
  const summaryLines: string[] = []
  for (const summary of book.summaries) {
    const prose = trimBlank(summary.summary).replace(/\s*\n+\s*/gu, ' ')
    if (prose === '') {
      // An empty summary is a row with no content: the registration table has no cell to
      // put it in, and nothing is lost by leaving it out.
      summaryTally.dropped += 1
      continue
    }
    const chapter = book.chapters.find((row) => row.id === summary.chapterId)
    const number = chapter === undefined ? undefined : numbering.numbers.get(chapter.id)
    const label =
      chapter === undefined
        ? `章 ${String(summary.chapterId)}`
        : `第 ${String(number ?? '?')} 章 ${normalizeText(chapter.title).trim()}`
    summaryLines.push(`| ${label.replaceAll('|', '\\|')} | ${prose.replaceAll('|', '\\|')} |`)
    summaryTally.mapped += 1
  }
  if (summaryLines.length > 0) {
    const text = [
      '# 旧库章末摘要（迁移登记）',
      '',
      `> 来源：旧 InkFlow 数据库 \`${basenameOf(book.sourceDb)}\` · 项目「${book.project.name}」· chapter_summaries 共 ${String(summaryLines.length)} 条`,
      '> 由 `inkflow_etl_apply` 生成；本文件只是登记，插件不解析它。',
      '',
      '| 章 | 摘要 |',
      '|---|---|',
      ...summaryLines,
      '',
    ].join('\n')
    pushWrite(state, 'chapter_summaries', 0, 'etl-chapter-summaries', `${LIBRARY_DIR}/etl-chapter-summaries.md`, text, codePoints(text))
  }

  // ---- foreshadowing -----------------------------------------------------------------
  const foreshadowTally = newTally()
  const resolvedWithoutChapter: string[] = []
  for (const foreshadow of book.foreshadows) {
    const rawTitle = normalizeText(foreshadow.title).trim()
    const title = rawTitle === '' ? `foreshadow-${String(foreshadow.id)}` : rawTitle
    const declared = foreshadowStatusOf(foreshadow.status)
    if (declared === undefined) {
      foreshadowTally.notes.push(`伏笔「${title}」的旧状态「${foreshadow.status}」不在枚举内：按 planted 迁移`)
    }
    // I-09: a `resolved` entry must name the chapter it was paid off in. The legacy column
    // that could have carried it is `resolved_at`, a timestamp — so there is nothing
    // honest to write and the entry lands `planted` with the old state in a body note.
    const wantsResolved = declared === 'resolved'
    if (wantsResolved) resolvedWithoutChapter.push(title)
    const status: ForeshadowStatus = wantsResolved ? 'planted' : (declared ?? 'planted')
    const plantedAt = foreshadow.firstChapterId === null ? undefined : chapterIdOf.get(foreshadow.firstChapterId)

    const notes = [
      `> ETL：旧库状态 \`${foreshadow.status}\`${foreshadow.location === '' ? '' : ` · 出现位置：${normalizeText(foreshadow.location)}`}`,
      ...(wantsResolved
        ? ['> ETL：旧库标记为已回收，但没有记录回收章；已按 planted 迁移，补上 `resolvedChapter` 后再置 resolved。']
        : []),
    ]
    const description = trimBlank(foreshadow.description)
    const body = [description, notes.join('\n')].filter((part) => part !== '').join('\n\n')
    const entityId = entityIdOf('foreshadowings', foreshadow.id, undefined)
    const text = renderForeshadowDocument({
      fields: {
        id: entityId,
        title,
        status,
        ...(plantedAt === undefined ? {} : { plantedAt }),
        advancedAt: [],
        linkedEntities: [],
      },
      body: `${body}\n`,
    })
    foreshadowTally.mapped += 1
    pushWrite(
      state,
      'foreshadowings',
      foreshadow.id,
      entityId,
      `foreshadowing/${fileSlug(title, `foreshadow-${String(foreshadow.id)}`)}.md`,
      text,
      codePoints(text),
    )
  }
  if (resolvedWithoutChapter.length > 0) {
    decisions.push({
      code: 'ETL_FORESHADOW_RESOLVED_WITHOUT_CHAPTER',
      count: resolvedWithoutChapter.length,
      detail: `${String(resolvedWithoutChapter.length)} 条伏笔在旧库是 resolved 但没有回收章，按 planted 迁移：${resolvedWithoutChapter.slice(0, 5).join('、')}`,
      hint: '补上 `resolvedChapter` 后用 inkflow_foreshadow_upsert 置 resolved（I-09 拒绝没有回收章的 resolved）',
    })
  }

  // ---- timeline -----------------------------------------------------------------------
  const timelineTally = newTally()
  const usedOrders = new Set<number>()
  const unconfirmed: string[] = []
  for (const event of book.timeline) {
    const rawTitle = normalizeText(event.title).trim()
    const title = rawTitle === '' ? `event-${String(event.id)}` : rawTitle
    const display = normalizeText(event.timeDisplay).trim()
    const worldTime = CALENDAR_DATE.test(display) ? display : undefined
    if (worldTime === undefined) unconfirmed.push(title)

    const position = Number.isFinite(event.narrativePosition) ? Math.trunc(event.narrativePosition) : undefined
    const narrativeOrder = position === undefined || usedOrders.has(position) ? undefined : position
    if (narrativeOrder !== undefined) usedOrders.add(narrativeOrder)
    const chapter = event.sourceChapterId === null ? undefined : chapterIdOf.get(event.sourceChapterId)

    const notes = [
      `> ETL：旧库时间 \`${display === '' ? '（空）' : display}${event.timeUnit === '' ? '' : ` ${event.timeUnit}`}${event.era === '' ? '' : ` · ${event.era}`}\``,
      ...(narrativeOrder === undefined && position !== undefined
        ? [`> ETL：narrative_position ${String(position)} 已被另一事件占用，本条不写 narrativeOrder（避免 TIMELINE_ORDER_CONFLICT）`]
        : []),
    ]
    const description = trimBlank(event.description)
    const body = [description, notes.join('\n')].filter((part) => part !== '').join('\n\n')
    const entityId = entityIdOf('timeline_events', event.id, undefined)
    const text = renderTimelineDocument({
      fields: {
        id: entityId,
        title,
        ...(worldTime === undefined ? {} : { worldTime }),
        ...(narrativeOrder === undefined ? {} : { narrativeOrder }),
        ...(chapter === undefined ? {} : { chapter }),
        status: worldTime === undefined ? 'unconfirmed' : 'confirmed',
      },
      body: `${body}\n`,
    })
    timelineTally.mapped += 1
    pushWrite(
      state,
      'timeline_events',
      event.id,
      entityId,
      `timeline/${fileSlug(title, `event-${String(event.id)}`)}.md`,
      text,
      codePoints(text),
    )
  }
  if (unconfirmed.length > 0) {
    decisions.push({
      code: 'ETL_TIMELINE_UNCONFIRMED',
      count: unconfirmed.length,
      detail: `${String(unconfirmed.length)} 个时间线事件的 time_display 不是历法日期，落到 pending（status: unconfirmed）：${unconfirmed.slice(0, 5).join('、')}`,
      hint: '按历法改成 YYYY[-MM[-DD]] 再逐条确认',
    })
  }

  // ---- relations ----------------------------------------------------------------------
  const relationTally = newTally()
  planRelationEdges({ book, state, decisions, relationTally, characterIdOf, worldIdOf, outlineIdOf })

  // ---- per-class reports ---------------------------------------------------------------
  const classes: EtlClassReport[] = []
  const classOf = (table: EtlTable, tally: Tally, legacyRows: number): void => {
    const deviation = legacyRows === 0 ? 0 : tally.lost / legacyRows
    classes.push({
      table,
      legacyRows,
      mapped: tally.mapped,
      dropped: tally.dropped,
      lost: tally.lost,
      balanced: tally.mapped + tally.dropped + tally.lost === legacyRows,
      deviation,
      ok: deviation <= 0.01,
      notes: tally.notes.slice(0, 8),
    })
  }
  let membershipTotal = 0
  for (const list of book.groupMembers.values()) membershipTotal += list.length
  classOf('volumes', volumeTally, book.counts.volumes)
  classOf('chapters', chapterTally, book.counts.chapters)
  classOf('chapter_summaries', summaryTally, book.counts.chapter_summaries)
  classOf('characters', characterTally, book.counts.characters)
  // Groups have no file of their own: the units are the group rows and the memberships.
  classOf('character_groups', groupTally, book.counts.character_groups + membershipTotal)
  classOf('world_categories', categoryTally, book.counts.world_categories)
  classOf('world_settings', worldTally, book.counts.world_settings)
  classOf('outlines', outlineTally, book.counts.outlines)
  classOf('plot_points', plotTally, book.counts.plot_points)
  classOf('story_arcs', arcTally, book.counts.story_arcs)
  classOf('foreshadowings', foreshadowTally, book.counts.foreshadowings)
  classOf('timeline_events', timelineTally, book.counts.timeline_events)
  classOf('knowledge_relations', relationTally, book.counts.knowledge_relations)

  for (const table of ETL_TABLES) {
    if (!classes.some((entry) => entry.table === table)) warnings.push(`${table}: 没有迁移类（这是迁移器的缺陷，请报告）`)
  }
  for (const entry of classes) {
    if (!entry.balanced) warnings.push(`${entry.table}: 对账不闭合（mapped ${String(entry.mapped)} + dropped ${String(entry.dropped)} + lost ${String(entry.lost)} ≠ 旧库 ${String(entry.legacyRows)}）`)
  }

  // ---- items, totals, reconcile, token ---------------------------------------------------
  const items: EtlItem[] = []
  const prior = options.prior ?? new Map<string, EtlIdMapEntry>()
  const writes: EtlWrite[] = []
  for (const write of state.writes) {
    const onDisk = options.probe.probe(write.path, write.sha256)
    const base = {
      key: write.key,
      table: write.table,
      entityId: write.entityId,
      path: write.path,
      sha256: write.sha256,
      chars: write.chars,
    }
    if (onDisk === 'same') {
      // Either a previous run or an interrupted one: the bytes are already right, and
      // rewriting them would only churn mtimes. This is what makes a second run write zero.
      items.push({ ...base, state: 'migrated' })
      continue
    }
    if (onDisk === 'different') {
      const mapped = prior.get(write.key)
      items.push({
        ...base,
        state: 'conflict',
        code: mapped === undefined ? 'ETL_TARGET_EXISTS' : 'ETL_TARGET_CHANGED',
        detail:
          mapped === undefined
            ? '目标路径已有别的内容：迁移器从不覆盖，先挪开它再重跑'
            : '这条记录迁过，但现在的内容与计划不同（可能作者改过）：不覆盖',
      })
      continue
    }
    if (prior.has(write.key)) {
      items.push({
        ...base,
        state: 'conflict',
        code: 'ETL_MAPPING_STALE',
        detail: '映射表说这一条迁过，但文件已不在：不重建（作者可能是有意删掉的）',
      })
      continue
    }
    items.push({ ...base, state: 'write' })
    writes.push(write)
  }

  const count = (state: EtlItemState): number => items.filter((item) => item.state === state).length
  const conflictItems = items.filter((item) => item.state === 'conflict')
  if (conflictItems.length > 0) {
    decisions.push({
      code: 'ETL_TARGET_CONFLICT',
      count: conflictItems.length,
      detail: `${String(conflictItems.length)} 个目标路径已有别的内容或映射表与磁盘不一致，本次跳过：${conflictItems
        .slice(0, 5)
        .map((item) => item.path)
        .join('、')}`,
      hint: '先处理这几个文件（挪开/删除）再重跑；迁移器不覆盖已有内容',
    })
  }

  const tokenSource = [...items]
    .sort((left, right) => left.key.localeCompare(right.key))
    .map((item) => `${item.key}|${item.path}|${item.sha256}`)
    .join('\n')

  // The per-class rows, not `book.counts`: a class may measure in units that are not "one
  // table row" (a group membership is a written `group` field), and the reconciliation has
  // to add up to the table the caller just read.
  const legacyEntityTotal = classes.reduce((sum, entry) => sum + entry.legacyRows, 0)
  const droppedEntityTotal = classes.reduce((sum, entry) => sum + entry.dropped, 0)
  const lostEntityTotal = classes.reduce((sum, entry) => sum + entry.lost, 0)
  // `planned` counts every row the plan can account for; the ≤1% check measures **loss**,
  // because a row the new model has no place for (an empty category, an unused story line)
  // cannot be "mapped" without inventing a file the author never wrote — it is reported, per
  // class and as a decision, instead of being hidden inside a deviation number.
  const plannedEntityTotal = classes.reduce((sum, entry) => sum + entry.mapped + entry.dropped, 0)
  const entityDeviation = legacyEntityTotal === 0 ? 0 : lostEntityTotal / legacyEntityTotal
  const charsDeviation = legacyChars === 0 ? 0 : Math.abs(legacyChars - plannedChars) / legacyChars

  if (droppedEntityTotal > 0) {
    const detail = classes
      .filter((entry) => entry.dropped > 0)
      .map((entry) => `${entry.table} ${String(entry.dropped)}/${String(entry.legacyRows)}`)
      .join('、')
    decisions.push({
      code: 'ETL_NO_TARGET',
      count: droppedEntityTotal,
      detail: `${String(droppedEntityTotal)} 行在新模型里没有落点（已记录，不是丢失）：${detail}`,
      hint: '这些是空分类 / 未被引用的故事线 / 空分组 / 重复的边：新模型里它们只是一段字段或一个目录，本来就没有文件可写；明细在各类的 notes 里',
    })
  }

  const plan: EtlPlan = {
    source: {
      db: basenameOf(book.sourceDb),
      projectId: book.project.id,
      ...(book.project.uuid === undefined ? {} : { projectUuid: book.project.uuid }),
      projectName: book.project.name,
      ...(book.project.language === undefined ? {} : { language: book.project.language }),
      ...(book.project.targetWords === undefined ? {} : { targetWords: book.project.targetWords }),
      rowCounts: book.counts,
    },
    options: { renumber },
    classes,
    items,
    gaps: numbering.gaps,
    decisions,
    warnings,
    reconcile: {
      entities: {
        legacy: legacyEntityTotal,
        planned: plannedEntityTotal,
        dropped: droppedEntityTotal,
        lost: lostEntityTotal,
        deviation: entityDeviation,
        ok: entityDeviation <= 0.01,
        threshold: 0.01,
      },
      chars: { legacy: legacyChars, planned: plannedChars, deviation: charsDeviation, ok: charsDeviation <= 0.005, threshold: 0.005 },
    },
    totals: { plannedFiles: items.length, write: count('write'), migrated: count('migrated'), conflict: count('conflict'), chars: plannedChars },
    planToken: sha256(tokenSource),
    commitSuggestion: `git add -A && git commit -m "chore(etl): 迁移旧 InkFlow 库「${book.project.name}」（${String(count('write'))} 个文件）"`,
  }
  return { plan, writes }
}

/** Whether a rendered document really carries a frontmatter block (guard against a renderer change). */
export function hasFrontmatterBlock(text: string): boolean {
  return splitFrontmatter(text).hasFrontmatter
}

// The plan's vocabulary moved to `etl-plan-types.ts`; the constants stay here because they
// name this module's contract (where the id map lives, what shape it is).
export { ETL_IDMAP_RELATIVE, ETL_IDMAP_VERSION } from './etl-plan-types.js'
export type {
  EtlClassReport, EtlComputation, EtlDecision, EtlDiskProbe, EtlGap, EtlIdMap, EtlIdMapEntry,
  EtlItem, EtlItemState, EtlPlan, EtlPlanOptions, EtlReconcile, EtlWrite,
} from './etl-plan-types.js'
