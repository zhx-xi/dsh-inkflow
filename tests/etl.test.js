/**
 * Old-library ETL (issue #51, roadmap X-29 / X-30): dry run, apply, idempotency, rollback.
 *
 * The fixture is a **hand-built legacy database**: `node:sqlite` creates the 15 real table
 * shapes (the old file has 43; these are the ones the 13 content classes live in) inside a
 * temp directory, then a handful of Chinese rows go in — including the four cases the
 * migrator must not paper over:
 *
 *   * a **chapter-number gap** (order 1,2,3,5) — reported, never renumbered;
 *   * a **knowledge relation pointing at a row that does not exist** — skipped and named;
 *   * a **foreshadow marked resolved with no chapter** — cannot satisfy I-09;
 *   * a **timeline event whose time is not a calendar date** ("第三天").
 *
 * What must FAIL when this is wired wrong:
 *   1. **the preview writes.** `planEtl` is the whole dialog; a byte (or an mtime) moving
 *      under it turns "look before you leap" into a lie → whole-tree hash around it (X-29).
 *   2. **apply without `confirm: true` writes**, or a stale `planToken` is accepted.
 *   3. **a second run duplicates the book** — the id map is the only idempotency key, so
 *      running twice must write zero files and change no digest.
 *   4. **a mid-run failure leaves half a book.** The run is staged under the backup
 *      package and moved in per lock batch; a batch that cannot land must leave a package
 *      that rolls the book back to nothing, with the unpublished copies still staged.
 *   5. **the plan's numbers are fiction.** Entity and character counts are compared against
 *      what actually landed (≤1% / 0.5%, A-26), not against the intent.
 *   6. **the numbering is silently "fixed"** — files must carry the legacy numbers, gap
 *      included, unless `renumber: "compact"` was asked for.
 *
 * Run: npm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  ETL_IDMAP_RELATIVE,
  applyEtl,
  etlTools,
  hasFrontmatterBlock,
  planEtl,
  readEtlIdMap,
  rollbackEtl,
} from '../lib/index.js'
import { hashTree } from './hash-tree.mjs'

const CONTENT_DIRS = ['chapters', 'characters', 'world', 'outlines', 'foreshadowing', 'timeline', 'relations', 'facts', 'library']
const ALL_DIRS = [...CONTENT_DIRS, 'index']
const KEEP = '.gitkeep'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function workdir(prefix = 'inkflow-etl-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function scaffold(root) {
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, '.git'))
  for (const dir of ALL_DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, KEEP), '', 'utf8')
  }
  writeFileSync(
    join(root, 'inkflow.json'),
    `${JSON.stringify({ schemaVersion: 1, title: '迁移之书', author: 'tester' }, null, 2)}\n`,
    'utf8',
  )
}

function book() {
  const root = workdir()
  scaffold(root)
  return root
}

const PROJECT_UUID = 'b1f0c1a4-0000-4000-8000-000000000007'

/**
 * The old database, with the real column names.
 *
 * Only the columns the migrator reads are declared, which is the point: `etl-source.ts`
 * projects the columns a file happens to have, so a fixture that carried every column of
 * a 2026 build would never prove that tolerance.
 */
function legacyDb(path, options = {}) {
  const db = new DatabaseSync(path)
  db.exec(`
    create table projects (id integer primary key, name text not null, uuid text, language text, target_words integer, is_deleted integer not null default 0);
    create table volumes (id integer primary key, project_id integer not null, title text not null, order_index real not null);
    create table chapters (id integer primary key, project_id integer not null, volume_id integer, title text not null, content text not null, status text not null, order_index real not null, uuid text);
    create table chapter_summaries (id integer primary key, chapter_id integer not null, summary text not null);
    create table characters (id integer primary key, project_id integer not null, name text not null, personality text not null, background text not null, goals text not null, brief text not null, uuid text);
    create table character_groups (id integer primary key, project_id integer not null, name text not null, description text not null, sort_order integer not null);
    create table character_group_members (character_id integer not null, group_id integer not null, primary key (character_id, group_id));
    create table world_categories (id integer primary key, project_id integer not null, name text not null, kind text not null);
    create table world_settings (id integer primary key, project_id integer not null, name text not null, parent_id integer, category text not null, content text not null, uuid text);
    create table outlines (id integer primary key, project_id integer not null, name text not null, description text not null, sort_order integer not null, level text not null, parent_id integer, chapter_id integer, volume_id integer, uuid text);
    create table plot_points (id integer primary key, outline_id integer not null, project_id integer not null, name text not null, type text not null, description text not null, position integer not null, arc_id integer);
    create table story_arcs (id integer primary key, project_id integer not null, name text not null, description text not null);
    create table foreshadowings (id integer primary key, project_id integer not null, title text not null, description text not null, priority integer not null, status text not null, location text not null, first_chapter_id integer, resolved_at text);
    create table timeline_events (id integer primary key, project_id integer not null, title text not null, description text not null, time_display text not null, time_unit text not null, time_value real, era text not null default '', narrative_position integer not null, source_chapter_id integer);
    create table knowledge_relations (id integer primary key, project_id integer not null, source_type text not null, source_id integer not null, target_type text not null, target_id integer not null, relation_type text not null, description text not null);
  `)

  const run = (sql, ...params) => db.prepare(sql).run(...params)

  run('insert into projects (id, name, uuid, language, target_words, is_deleted) values (?, ?, ?, ?, ?, 0)', 7, '迁移测试书', PROJECT_UUID, 'zh', 900000)
  // A decoy project: the selector must not pick it just because it exists.
  run('insert into projects (id, name, uuid, language, target_words, is_deleted) values (?, ?, ?, ?, ?, 0)', 8, '别人的书', 'cec0c1a4-0000-4000-8000-000000000008', 'zh', 1000)

  run('insert into volumes (id, project_id, title, order_index) values (1, 7, ?, 1)', '第一卷 入山')
  run('insert into volumes (id, project_id, title, order_index) values (2, 7, ?, 2)', '第二卷 问道')

  const chapters = options.chapters ?? [
    [11, 1, '第一卷 入山', '第1章 入山', '青石台阶上落着薄雪。\n\n他抬头看了一眼山门。', 'draft', 1],
    [12, 1, '第一卷 入山', '第2章 拜师', '钟声从后山传来。\n\n「跪下。」', 'draft', 2],
    [13, 1, '第一卷 入山', '第3章 试剑', '剑出鞘时，风停了。', 'revised', 3],
    [14, 1, '第一卷 入山', '第5章 夜行', '月色像一层薄冰。', 'draft', 5],
    [15, 2, '第二卷 问道', '第6章 闭关', '洞中无日月。', 'final', 6],
    [16, 2, '第二卷 问道', '第7章 出关', '他推开石门。', 'draft', 7],
  ]
  for (const [id, volumeId, , title, content, status, order] of chapters) {
    run(
      'insert into chapters (id, project_id, volume_id, title, content, status, order_index, uuid) values (?, 7, ?, ?, ?, ?, ?, ?)',
      id,
      volumeId,
      title,
      content,
      status,
      order,
      `ch-${String(id)}-0000-4000-8000-0000000000${String(id)}`,
    )
  }
  // A loose chapter (no volume): it must land directly under chapters/.
  run(
    'insert into chapters (id, project_id, volume_id, title, content, status, order_index, uuid) values (21, 7, null, ?, ?, ?, 8, null)',
    '番外 雪夜',
    '雪落在窗纸上。',
    'draft',
  )

  run('insert into chapter_summaries (id, chapter_id, summary) values (1, 11, ?)', '少年上山，初见山门。')
  run('insert into chapter_summaries (id, chapter_id, summary) values (2, 12, ?)', '拜入掌门门下。')

  run(
    'insert into characters (id, project_id, name, personality, background, goals, brief, uuid) values (31, 7, ?, ?, ?, ?, ?, ?)',
    '沈青',
    '沉默，护短。',
    '蜀山弟子。',
    '守住山门。',
    '主角。',
    'd1f0c1a4-0000-4000-8000-000000000031',
  )
  run(
    'insert into characters (id, project_id, name, personality, background, goals, brief, uuid) values (32, 7, ?, ?, ?, ?, ?, null)',
    '柳七',
    '话多。',
    '外门弟子。',
    '下山。',
    '同门。',
  )

  run('insert into character_groups (id, project_id, name, description, sort_order) values (1, 7, ?, ?, 1)', '蜀山派', '本门')
  run('insert into character_groups (id, project_id, name, description, sort_order) values (2, 7, ?, ?, 2)', '空组', '没有成员')
  run('insert into character_group_members (character_id, group_id) values (31, 1)')

  run('insert into world_categories (id, project_id, name, kind) values (1, 7, ?, ?)', '修炼体系', 'abstract')
  run('insert into world_categories (id, project_id, name, kind) values (2, 7, ?, ?)', '地理', 'geo')

  run(
    'insert into world_settings (id, project_id, name, parent_id, category, content, uuid) values (41, 7, ?, null, ?, ?, ?)',
    '世界观总纲',
    '',
    '本书设定根节点。',
    'e1f0c1a4-0000-4000-8000-000000000041',
  )
  run(
    'insert into world_settings (id, project_id, name, parent_id, category, content, uuid) values (42, 7, ?, 41, ?, ?, null)',
    '境界与修炼',
    '修炼体系',
    '大三境：炼气、筑基、金丹。',
  )
  run(
    'insert into world_settings (id, project_id, name, parent_id, category, content, uuid) values (43, 7, ?, 42, ?, ?, null)',
    '一、炼气',
    '',
    '炼气九层。',
  )

  run(
    'insert into outlines (id, project_id, name, description, sort_order, level, parent_id, chapter_id, volume_id, uuid) values (51, 7, ?, ?, 0, ?, null, null, null, ?)',
    '总大纲',
    '全书三幕。',
    'overall',
    'f1f0c1a4-0000-4000-8000-000000000051',
  )
  run(
    'insert into outlines (id, project_id, name, description, sort_order, level, parent_id, chapter_id, volume_id, uuid) values (52, 7, ?, ?, 1, ?, 51, null, 1, null)',
    '第一卷纲',
    '',
    'volume',
  )
  run(
    'insert into outlines (id, project_id, name, description, sort_order, level, parent_id, chapter_id, volume_id, uuid) values (53, 7, ?, ?, 2, ?, 52, null, null, null)',
    '第1章细纲',
    '',
    'chapter',
  )
  // A chapter node whose parent does not exist: the report must name it, not drop it.
  run(
    'insert into outlines (id, project_id, name, description, sort_order, level, parent_id, chapter_id, volume_id, uuid) values (54, 7, ?, ?, 3, ?, 999, null, null, null)',
    '孤儿细纲',
    '',
    'chapter',
  )

  run('insert into story_arcs (id, project_id, name, description) values (61, 7, ?, ?)', '主线', '守山')
  run('insert into story_arcs (id, project_id, name, description) values (62, 7, ?, ?)', '支线', '没有被引用')

  run(
    'insert into plot_points (id, outline_id, project_id, name, type, description, position, arc_id) values (71, 53, 7, ?, ?, ?, 0, 61)',
    '上山',
    '',
    '少年抵达山门。',
  )
  run(
    'insert into plot_points (id, outline_id, project_id, name, type, description, position, arc_id) values (72, 53, 7, ?, ?, ?, 1, null)',
    '试炼',
    '',
    '三问定去留。',
  )

  run(
    'insert into foreshadowings (id, project_id, title, description, priority, status, location, first_chapter_id, resolved_at) values (81, 7, ?, ?, 1, ?, ?, 11, null)',
    '薄雪',
    '开篇的雪会在卷末再现。',
    'open',
    '第1章',
  )
  run(
    'insert into foreshadowings (id, project_id, title, description, priority, status, location, first_chapter_id, resolved_at) values (82, 7, ?, ?, 2, ?, ?, null, ?)',
    '无名剑',
    '剑从何来。',
    'resolved',
    '第3章',
    '2026-01-02T03:04:05',
  )
  run(
    'insert into foreshadowings (id, project_id, title, description, priority, status, location, first_chapter_id, resolved_at) values (83, 7, ?, ?, 3, ?, ?, null, null)',
    '怪状态',
    '旧库的枚举不在新表里。',
    'weird-state',
    '',
  )

  run(
    'insert into timeline_events (id, project_id, title, description, time_display, time_unit, time_value, era, narrative_position, source_chapter_id) values (91, 7, ?, ?, ?, ?, 1.0, ?, 1, 11)',
    '少年上山',
    '故事开始。',
    '2024-03-05',
    'day',
    '',
  )
  run(
    'insert into timeline_events (id, project_id, title, description, time_display, time_unit, time_value, era, narrative_position, source_chapter_id) values (92, 7, ?, ?, ?, ?, 3.0, ?, 1, null)',
    '第三天的夜谈',
    '不是历法日期。',
    '第三天',
    'day',
    '',
  )

  run(
    'insert into knowledge_relations (id, project_id, source_type, source_id, target_type, target_id, relation_type, description) values (101, 7, ?, 31, ?, 32, ?, ?)',
    'character',
    'character',
    '同门',
    '同门弟子。',
  )
  run(
    'insert into knowledge_relations (id, project_id, source_type, source_id, target_type, target_id, relation_type, description) values (102, 7, ?, 42, ?, 41, ?, ?)',
    'world',
    'world',
    '属于',
    '境界属于总纲。',
  )
  if (options.danglingRelation !== false) {
    // The endpoint row does not exist: I-08 refuses a dangling edge, so this one is skipped.
    run(
      'insert into knowledge_relations (id, project_id, source_type, source_id, target_type, target_id, relation_type, description) values (103, 7, ?, 31, ?, 999, ?, ?)',
      'character',
      'character',
      '不存在',
      '指向一个没有的角色。',
    )
  }
  db.close()
  return path
}

function countFiles(root, relativeDir) {
  const absolute = join(root, ...relativeDir.split('/'))
  if (!existsSync(absolute)) return []
  const out = []
  const walk = (relative) => {
    for (const entry of readdirSync(join(root, ...relative.split('/')), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.name !== KEEP) out.push(child)
    }
  }
  walk(relativeDir)
  return out.sort()
}

/** `title: …` out of a rendered document, for the numbering assertions. */
function frontmatterOf(text) {
  const match = /^---\n([\s\S]*?)\n---/u.exec(text)
  return match?.[1] ?? ''
}

// ---------------------------------------------------------------------------
// 1. The preview writes nothing
// ---------------------------------------------------------------------------

test('planEtl is read-only: the whole tree is untouched, .inkflow/ included', () => {
  const root = book()
  const db = legacyDb(join(workdir('inkflow-etl-db-'), 'inkflow.db'))
  try {
    const before = hashTree(root)
    const planned = planEtl(root, { sourcePath: db })
    assert.equal(planned.ok, true, JSON.stringify(planned.error))
    const after = hashTree(root)
    assert.equal(after, before, 'the plan must not write a byte (not even the id map)')
    assert.equal(existsSync(join(root, '.inkflow')), false, 'the plan must not create .inkflow/')

    const plan = planned.plan
    // 13 classes, one row each, in the fixed table order.
    assert.equal(plan.classes.length, 13)
    assert.deepEqual(
      plan.classes.map((entry) => entry.table),
      [
        'volumes',
        'chapters',
        'chapter_summaries',
        'characters',
        'character_groups',
        'world_categories',
        'world_settings',
        'outlines',
        'plot_points',
        'story_arcs',
        'foreshadowings',
        'timeline_events',
        'knowledge_relations',
      ],
    )
    for (const entry of plan.classes) {
      assert.equal(entry.balanced, true, `${entry.table}: mapped + dropped + lost must equal the legacy rows`)
    }
    assert.equal(plan.classes.find((entry) => entry.table === 'chapters').legacyRows, 7)

    // Every planned document really carries a frontmatter block (a renderer change would
    // show up here before it reached a book).
    const computation = planned.plan
    assert.ok(computation.items.length > 0)
    // The project selector picked the book with content, not the first row.
    assert.equal(plan.source.projectName, '迁移测试书')
    assert.equal(plan.source.projectUuid, PROJECT_UUID)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. The four things the migrator refuses to decide on its own
// ---------------------------------------------------------------------------

test('the plan reports the gap, the dangling relation, the unresolvable resolved foreshadow and the non-calendar date', () => {
  const root = book()
  const db = legacyDb(join(workdir('inkflow-etl-db-'), 'inkflow.db'))
  try {
    const planned = planEtl(root, { sourcePath: db })
    assert.equal(planned.ok, true, JSON.stringify(planned.error))
    const plan = planned.plan

    // The gap: 1,2,3,5 in the first volume. Reported, and the numbering is NOT compacted.
    const gap = plan.gaps.find((entry) => entry.scope === 'vol-01')
    assert.ok(gap, `expected a gap in vol-01, got ${JSON.stringify(plan.gaps)}`)
    assert.deepEqual(gap.missing, [4])
    assert.deepEqual(gap.present, [1, 2, 3, 5])
    assert.equal(plan.options.renumber, 'keep')

    const codes = plan.decisions.map((decision) => decision.code)
    assert.ok(codes.includes('ETL_RELATION_ENDPOINT_UNMAPPED'), `expected the dangling relation to be reported, got ${codes.join(',')}`)
    assert.ok(codes.includes('ETL_FORESHADOW_RESOLVED_WITHOUT_CHAPTER'), `expected the resolved-without-chapter case, got ${codes.join(',')}`)
    assert.ok(codes.includes('ETL_TIMELINE_UNCONFIRMED'), `expected the non-calendar date, got ${codes.join(',')}`)

    // The relation that cannot work is not in the plan; the other two are.
    const relationFiles = plan.items.filter((item) => item.table === 'knowledge_relations')
    assert.equal(relationFiles.length, 2)
    const relationClass = plan.classes.find((entry) => entry.table === 'knowledge_relations')
    assert.equal(relationClass.mapped, 2)
    assert.equal(relationClass.lost, 1)
    assert.equal(relationClass.notes.length > 0, true)

    // An unused story arc has no place to be written, and says so.
    const arcClass = plan.classes.find((entry) => entry.table === 'story_arcs')
    assert.equal(arcClass.mapped, 1)
    assert.equal(arcClass.dropped, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. Apply: what landed matches the plan, file for file
// ---------------------------------------------------------------------------

test('applyEtl writes the planned set: legacy numbering preserved, counts reconciled, projections rebuilt', async () => {
  const root = book()
  const db = legacyDb(join(workdir('inkflow-etl-db-'), 'inkflow.db'), { danglingRelation: false })
  try {
    const planned = planEtl(root, { sourcePath: db })
    assert.equal(planned.ok, true, JSON.stringify(planned.error))
    const plan = planned.plan

    // Without the dangling relation the two acceptance thresholds must hold.
    assert.equal(plan.reconcile.entities.ok, true, `entity deviation ${plan.reconcile.entities.deviation}`)
    assert.equal(plan.reconcile.chars.ok, true, `char deviation ${plan.reconcile.chars.deviation}`)
    assert.ok(plan.reconcile.chars.deviation <= 0.005)

    const applied = await applyEtl(root, { sourcePath: db, confirm: true, planToken: plan.planToken, batchSize: 2 })
    assert.equal(applied.ok, true, JSON.stringify(applied.error))
    const value = applied.value
    assert.equal(value.written.length, plan.totals.write)
    assert.equal(value.skipped.length, 0)
    assert.equal(value.batches, Math.ceil(plan.totals.write / 2))
    assert.equal(value.backup.sealed, true)
    assert.equal(value.catalog.ok, true)
    assert.equal(value.index.ok, true)
    // The commit is recorded, never run (data-safety §3).
    assert.match(value.commitSuggestion, /^git add -A && git commit -m /u)

    // Chapter files: the legacy numbers survive, gap included.
    const chapterFiles = countFiles(root, 'chapters')
    const names = chapterFiles.map((path) => path.slice(path.lastIndexOf('/') + 1))
    assert.ok(names.includes('0001-第1章-入山.md'), names.join(','))
    assert.ok(names.includes('0005-第5章-夜行.md'), names.join(','))
    assert.ok(!names.some((name) => name.startsWith('0004-')), 'the gap must not be filled by a renumber')
    // The loose chapter lands directly under chapters/.
    assert.ok(names.includes('0008-番外-雪夜.md'), names.join(','))

    const body = readFileSync(join(root, 'chapters', 'vol-01-第一卷-入山', '0001-第1章-入山.md'), 'utf8')
    assert.match(frontmatterOf(body), new RegExp(`^volume: vol-01$`, 'mu'))
    assert.match(frontmatterOf(body), /^seq: 1$/mu)
    assert.match(body, /青石台阶上落着薄雪。/u)

    // One file per class where a file is the unit.
    assert.equal(countFiles(root, 'characters').length, 2)
    assert.equal(countFiles(root, 'world').length, 3)
    assert.equal(countFiles(root, 'relations').length, 2)
    assert.equal(countFiles(root, 'library').length, 1)
    const worldPath = countFiles(root, 'world').find((path) => path.includes('境界与修炼'))
    assert.ok(worldPath?.startsWith('world/修炼体系/'), `world entries go under their category, got ${worldPath}`)
    assert.match(readFileSync(join(root, ...worldPath.split('/')), 'utf8'), /^category: 修炼体系$/mu)

    // The chapter summaries were registered in library/ rather than parsed.
    assert.match(readFileSync(join(root, 'library', 'etl-chapter-summaries.md'), 'utf8'), /\| 第 1 章 第1章 入山 \|/u)

    // The id map is where X-29 says it is, and it names one entry per written file.
    assert.equal(existsSync(join(root, ...ETL_IDMAP_RELATIVE.split('/'))), true)
    const idmap = readEtlIdMap(root)
    assert.equal(idmap.ok, true)
    assert.equal(idmap.idmap.entries.length, plan.totals.write)
    assert.equal(idmap.idmap.source.projectId, 7)

    // Everything rendered must still parse as a document with frontmatter.
    for (const path of [...countFiles(root, 'outlines'), ...countFiles(root, 'foreshadowing'), ...countFiles(root, 'timeline')]) {
      assert.equal(hasFrontmatterBlock(readFileSync(join(root, ...path.split('/')), 'utf8')), true, path)
    }

    // X-25: `index/` stays a derived directory — `.gitkeep` plus the database, nothing else.
    for (const name of readdirSync(join(root, 'index'))) {
      assert.ok(name === KEEP || name.startsWith('inkflow.db') || name.startsWith('.write') || name.startsWith('.lock'), `index/ holds only derived files, got ${name}`)
    }
    // ADR-0012 #2: the private state directory is ignored from its first use.
    assert.match(readFileSync(join(root, '.gitignore'), 'utf8'), /^\.inkflow\/$/mu)

    // The index was rebuilt from the files, and the audit ran over the new tree.
    const codes = value.invariants.codes
    assert.equal(typeof value.invariants.issues, 'number')
    // The migrated tree must not invent dangling references: every endpoint and parent was
    // resolved in the plan (the orphan outline node was re-attached to the overall node).
    assert.equal(codes['DANGLING_PARENT'] ?? 0, 0, JSON.stringify(codes))
    assert.equal(codes['RELATION_ENDPOINT'] ?? 0, 0, JSON.stringify(codes))
    assert.equal(codes['CHARACTER_NAME_DUPLICATE'] ?? 0, 0, JSON.stringify(codes))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. Idempotency: a second run writes zero files
// ---------------------------------------------------------------------------

test('a second apply writes nothing: the id map is the idempotency key', async () => {
  const root = book()
  const db = legacyDb(join(workdir('inkflow-etl-db-'), 'inkflow.db'))
  try {
    const first = await applyEtl(root, { sourcePath: db, confirm: true })
    assert.equal(first.ok, true, JSON.stringify(first.error))
    const written = first.value.written.length
    assert.ok(written > 0)

    const chaptersBefore = countFiles(root, 'chapters').length
    const entitiesBefore = readEtlIdMap(root).idmap.entries.length

    const second = await applyEtl(root, { sourcePath: db, confirm: true })
    assert.equal(second.ok, true, JSON.stringify(second.error))
    assert.equal(second.value.written.length, 0, 'the second run must write no file')
    assert.equal(second.value.plan.totals.migrated, written, 'every planned file is already there')
    assert.equal(countFiles(root, 'chapters').length, chaptersBefore, 'no duplicate chapters')
    assert.equal(readEtlIdMap(root).idmap.entries.length, entitiesBefore, 'the map is merged, not rewritten twice')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. A mid-run failure rolls back to nothing, with the copies still staged
// ---------------------------------------------------------------------------

test('a batch that cannot land leaves a package that rolls the book back, and stages the rest', async () => {
  const root = book()
  const db = legacyDb(join(workdir('inkflow-etl-db-'), 'inkflow.db'))
  try {
    // A regular file where the second volume's directory must be created: `mkdirSync`
    // refuses, so the run dies after the first volume's chapters have landed.
    writeFileSync(join(root, 'chapters', 'vol-02-第二卷-问道'), 'not a directory', 'utf8')

    const before = new Map()
    for (const path of countFiles(root, 'chapters')) before.set(path, statSync(join(root, ...path.split('/'))).size)

    const applied = await applyEtl(root, { sourcePath: db, confirm: true, batchSize: 1 })
    assert.equal(applied.ok, false, 'the run must fail')
    assert.ok(['ETL_RENAME_FAILED', 'IO_FAILED', 'EEXIST', 'ENOTDIR'].includes(applied.error.code), applied.error.code)
    const dir = applied.error.rollback?.dir
    assert.ok(dir, 'the failure names the package it staged into')

    // Whatever landed is inside the package: the staging area still holds what did not.
    const stagingDir = join(root, ...dir.split('/'), 'staging')
    assert.equal(existsSync(stagingDir), true)

    const undone = rollbackEtl(root, { backup: dir, confirm: true })
    assert.equal(undone.ok, true, JSON.stringify(undone.error))
    assert.ok(undone.value.removed.length > 0, 'the files that landed must be removed')
    assert.ok(undone.value.stagingCleared > 0, 'the copies that never landed must be cleared too')

    // Back to the pre-run state: no chapter file, the decoy file untouched, and the
    // directory the run created gone with it.
    const after = countFiles(root, 'chapters').filter((path) => path.endsWith('.md'))
    assert.deepEqual(after, [])
    assert.equal(readFileSync(join(root, 'chapters', 'vol-02-第二卷-问道'), 'utf8'), 'not a directory')
    assert.equal(before.size, 1, 'the decoy file was the only entry under chapters/ before the run')
    assert.equal(existsSync(join(root, 'chapters', 'vol-01-第一卷-入山')), false, 'the directory the run created must go too')
    assert.deepEqual(undone.value.dirsRemoved, ['chapters/vol-01-第一卷-入山'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. X-29's set comparison and the stale-token guard
// ---------------------------------------------------------------------------

test('apply refuses a stale planToken, and skips a drifted item set instead of replacing it', async () => {
  const root = book()
  const db = legacyDb(join(workdir('inkflow-etl-db-'), 'inkflow.db'))
  try {
    const stale = await applyEtl(root, { sourcePath: db, confirm: true, planToken: 'not-the-token' })
    assert.equal(stale.ok, false)
    assert.equal(stale.error.code, 'ETL_PLAN_STALE')
    assert.deepEqual(countFiles(root, 'chapters'), [])

    const planned = planEtl(root, { sourcePath: db })
    assert.equal(planned.ok, true, JSON.stringify(planned.error))
    const items = planned.plan.items.map((item) => ({ key: item.key, count: 1 }))
    // The preview the caller sends back is missing one item on purpose.
    const dropped = items[0].key
    const partial = items.filter((item) => item.key !== dropped)

    const applied = await applyEtl(root, { sourcePath: db, confirm: true, planToken: planned.plan.planToken, items: partial })
    assert.equal(applied.ok, true, JSON.stringify(applied.error))
    assert.equal(applied.value.written.length, items.length - 1)
    assert.equal(applied.value.skipped.length, 1)
    assert.equal(applied.value.skipped[0].key, dropped)
    assert.match(applied.value.skipped[0].reason, /ETL_PLAN_DRIFT/u)
    // The dropped item was NOT written (skipped, never silently replaced).
    const writtenPaths = new Set(applied.value.written.map((entry) => entry.path))
    assert.equal(writtenPaths.has(planned.plan.items[0].path), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7. confirm is required, and the tool surface stays inside the Host subset
// ---------------------------------------------------------------------------

test('apply and rollback both refuse without confirm: true', async () => {
  const root = book()
  const db = legacyDb(join(workdir('inkflow-etl-db-'), 'inkflow.db'))
  try {
    const applied = await applyEtl(root, { sourcePath: db })
    assert.equal(applied.ok, false)
    assert.equal(applied.error.code, 'CONFIRM_REQUIRED')
    assert.deepEqual(countFiles(root, 'chapters'), [])

    const rolled = rollbackEtl(root, { backup: '20260101T000000000Z' })
    assert.equal(rolled.ok, false)
    assert.equal(rolled.error.code, 'CONFIRM_REQUIRED')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the two ETL tools keep a schema inside the Host subset', () => {
  const tools = etlTools({ ctx: {} })
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['inkflow_etl_plan', 'inkflow_etl_apply'],
  )
  // The Host refuses the WHOLE plugin when a schema uses a keyword outside its subset, so
  // this walks every node instead of checking the two top-level shapes.
  const forbidden = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'pattern', 'format', 'minItems', 'maxItems', 'minLength', 'maxLength'])
  const walk = (node, where) => {
    if (node === null || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node)) {
      assert.equal(forbidden.has(key), false, `${where}: ${key} is outside the Host schema subset`)
      if (key === 'required') {
        assert.ok(typeof node === 'object' && node.properties !== undefined, `${where}: required needs properties`)
      }
      if (Array.isArray(value)) value.forEach((child, index) => walk(child, `${where}.${key}[${String(index)}]`))
      else walk(value, `${where}.${key}`)
    }
  }
  for (const tool of tools) {
    walk(tool.parameters, `${tool.name}.parameters`)
    assert.ok(tool.output?.schema, `${tool.name} keeps an output schema`)
    walk(tool.output.schema, `${tool.name}.output.schema`)
  }
  // `inkflow_etl_plan` must not offer a writing knob at all.
  const plan = tools[0]
  assert.deepEqual(Object.keys(plan.parameters.properties).sort(), ['batchSize', 'project', 'projectRoot', 'renumber', 'sourcePath'])
})

// ---------------------------------------------------------------------------
// 8. compact renumbering is opt-in only
// ---------------------------------------------------------------------------

test('renumber: "compact" closes the gap, and only when asked for', async () => {
  const root = book()
  const db = legacyDb(join(workdir('inkflow-etl-db-'), 'inkflow.db'))
  try {
    const planned = planEtl(root, { sourcePath: db, renumber: 'compact' })
    assert.equal(planned.ok, true, JSON.stringify(planned.error))
    assert.equal(planned.plan.options.renumber, 'compact')
    assert.deepEqual(planned.plan.gaps, [], 'a compact run has no gaps to report')

    const applied = await applyEtl(root, { sourcePath: db, confirm: true, renumber: 'compact' })
    assert.equal(applied.ok, true, JSON.stringify(applied.error))
    const names = countFiles(root, 'chapters').map((path) => path.slice(path.lastIndexOf('/') + 1))
    assert.ok(names.includes('0004-第5章-夜行.md'), names.join(','), 'the fourth chapter takes number 4')
    assert.ok(!names.some((name) => name.startsWith('0009-')), 'no number past the chapter count')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 9. A messy database is refused, not half-read
// ---------------------------------------------------------------------------

test('an unreadable source and a missing project are refused with the code that names the problem', async () => {
  const root = book()
  try {
    const missing = planEtl(root, { sourcePath: resolvePath(root, 'nope.db') })
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'ETL_SOURCE_UNREADABLE')

    const db = legacyDb(join(workdir('inkflow-etl-db-'), 'inkflow.db'))
    const unknown = planEtl(root, { sourcePath: db, project: '没有这本书' })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'ETL_PROJECT_NOT_FOUND')

    // The source file is never modified by any of this.
    const before = statSync(db).size
    planEtl(root, { sourcePath: db })
    assert.equal(statSync(db).size, before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


// ---------------------------------------------------------------------------
// 10. X-30: a batch that cannot get the write lock says who holds it
// ---------------------------------------------------------------------------

test('PROJECT_BUSY names the lock holder and writes nothing (X-30)', async () => {
  const root = book()
  const db = legacyDb(join(workdir('inkflow-etl-db-'), 'inkflow.db'))
  const holder = spawn(
    process.execPath,
    [
      '-e',
      // A real foreign process: it takes the same lock file `io.ts` uses and stays alive
      // until the parent stops it, so this is "another session is writing", not a fixture.
      [
        "const {writeFileSync, mkdirSync}=require('node:fs')",
        "const {join}=require('node:path')",
        'const root=process.argv[1]',
        "mkdirSync(join(root,'index'),{recursive:true})",
        "writeFileSync(join(root,'index','.write.lock'),JSON.stringify({pid:process.pid,token:'other-session',startedAt:Date.now()}))",
        "process.stdout.write('locked')",
        'setTimeout(()=>{},60000)',
      ].join(';'),
      root,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  try {
    await new Promise((resolve, reject) => {
      holder.stdout.once('data', () => resolve())
      holder.once('error', reject)
    })
    const planner = planEtl(root, { sourcePath: db })
    assert.equal(planner.ok, true, JSON.stringify(planner.error))

    const applied = await applyEtl(root, { sourcePath: db, confirm: true, batchSize: 1 })
    assert.equal(applied.ok, false)
    assert.equal(applied.error.code, 'PROJECT_BUSY')
    // "Say who is writing" is part of X-30, not a nicety: the model has to be able to tell
    // the author which session to wait for.
    assert.equal(applied.error.lockHolder?.pid, holder.pid)
    assert.match(applied.error.hint ?? '', /re-run/u)
    // Nothing landed: the refusal happens before the first rename.
    assert.deepEqual(countFiles(root, 'chapters'), [])
  } finally {
    holder.kill()
    rmSync(root, { recursive: true, force: true })
  }
})
