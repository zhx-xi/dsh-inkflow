/**
 * Entity mentions (#29, roadmap X-1 / M18): the `entity_mentions` table, the
 * body scan behind it, and the three queries the panel and the tool surface need
 * — "who is in this chapter", "which chapters mention this entity", "who dropped
 * off".
 *
 * Why offsets are pinned by slicing the body: a mention that cannot be located is
 * only a boolean "appeared", and the whole point of the table is that a rename or
 * an impact report can jump to the exact character in the manuscript. A stale or
 * shifted offset would pass a count assertion and still be useless.
 *
 * Why `source` matters: `name` (the entity's own title), `alias` (a secondary
 * name) and `explicit` (the chapter's frontmatter declares it, e.g. `pov`) are
 * different evidence strengths — an alias is a guess a rename should revisit, an
 * explicit declaration is the author's own statement.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  INDEX_SCHEMA_VERSION,
  absentEntities,
  buildIndex,
  chaptersMentioning,
  mentionsOf,
  scanMentions,
} from '../lib/index.js'

const DIRS = [
  'chapters',
  'characters',
  'world',
  'outlines',
  'foreshadowing',
  'timeline',
  'relations',
  'facts',
  'library',
  'index',
]

function workdir() {
  return mkdtempSync(join(tmpdir(), 'inkflow-mention-'))
}

function scaffold(root) {
  mkdirSync(join(root, '.git'), { recursive: true })
  for (const dir of DIRS) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, '.gitkeep'), '', 'utf8')
  }
  writeFileSync(join(root, 'inkflow.json'), `${JSON.stringify({ schemaVersion: 1, title: '提及测试' }, null, 2)}\n`, 'utf8')
}

function writeMarkdown(root, relativePath, frontmatterLines, body = '') {
  const absolute = join(root, relativePath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  const block = frontmatterLines.length > 0 ? `---\n${frontmatterLines.join('\n')}\n---\n\n` : ''
  writeFileSync(absolute, `${block}${body}`, 'utf8')
}

/**
 * Three chapters, two entities:
 *   ch-1 names 清音 in the body and declares it in `pov`
 *   ch-2 names 白鹤门 only
 *   ch-3 calls 清音 by the alias 静水
 */
function sampleBook(root) {
  scaffold(root)
  writeMarkdown(root, 'chapters/vol-01/0001-甲.md', ['id: ch-1', 'title: 甲', 'seq: 1', 'pov: 清音'], '清音推开山门，风雪灌进来。')
  writeMarkdown(root, 'chapters/vol-01/0002-乙.md', ['id: ch-2', 'title: 乙', 'seq: 2'], '白鹤门的三位长老坐在堂中，一言不发。')
  writeMarkdown(root, 'chapters/vol-01/0003-丙.md', ['id: ch-3', 'title: 丙', 'seq: 3'], '静水来了，又把门带上。')
  writeMarkdown(root, 'characters/清音.md', ['id: c-1', 'name: 清音', 'aliases: 静水、清音子'], '白鹤门弟子。')
  writeMarkdown(root, 'world/门派/白鹤门.md', ['id: w-1', 'title: 白鹤门', 'keywords: 白鹤'], '山中剑派。')
}

/**
 * The body exactly as the index stored it — the artifact a caret is placed in.
 *
 * Read back rather than restated: `parseMarkdown` keeps the blank line that
 * follows the frontmatter, so a hand-written copy of the fixture is off by one
 * character and would happily hide a real off-by-one in the offsets.
 */
function chapterBody(root, chapterId) {
  const db = new DatabaseSync(join(root, 'index', 'inkflow.db'), { readOnly: true })
  try {
    const row = db.prepare('SELECT body FROM chapters_fts WHERE chapter_id = ?').get(chapterId)
    assert.equal(typeof row?.body, 'string', `stored body for ${chapterId}`)
    return String(row.body)
  } finally {
    db.close()
  }
}

test('a name hit and an alias hit are recorded with their own source', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)

    const byName = mentionsOf(root, 'c-1', { kind: 'characters' }) ?? []
    const ch1 = byName.filter((hit) => hit.chapterId === 'ch-1' && hit.offset >= 0)
    assert.equal(ch1.length, 1, 'the body mentions 清音 exactly once in ch-1')
    assert.deepEqual(ch1[0].sources, ['name'])
    assert.ok(ch1[0].offset >= 0, 'a body mention carries a body offset')
    assert.equal(chapterBody(root, 'ch-1').slice(ch1[0].offset, ch1[0].offset + '清音'.length), '清音')

    const ch3 = byName.filter((hit) => hit.chapterId === 'ch-3')
    assert.equal(ch3.length, 1)
    assert.deepEqual(ch3[0].sources, ['alias'], '静水 is an alias, not the character name')
    assert.equal(chapterBody(root, 'ch-3').slice(ch3[0].offset, ch3[0].offset + '静水'.length), '静水')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the chapter frontmatter declaration is an explicit mention, separate from the body', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)

    const hits = (mentionsOf(root, 'c-1', { kind: 'characters' }) ?? []).filter((hit) => hit.chapterId === 'ch-1')
    const explicit = hits.filter((hit) => hit.sources.includes('explicit'))
    assert.equal(explicit.length, 1, '`pov: 清音` is one explicit mention')
    assert.ok(explicit[0].offset < 0, 'a frontmatter mention has no body offset')
    assert.equal(hits.filter((hit) => hit.sources.includes('name')).length, 1, 'the body hit is still its own row')

    // `offset` of the declaration is -1, i.e. not a place in the text. A consumer that
    // places a caret at "the first mention" must therefore be handed the body position:
    // `firstBodyOffset` is the prose offset (never -1), and body occurrences are ordered
    // before the declaration so `hits[0]` of a chapter is always real text.
    const named = hits.find((hit) => hit.sources.includes('name'))
    assert.ok(named !== undefined)
    assert.equal(explicit[0].firstBodyOffset, named.offset, 'the declaration points at the prose, not at -1')
    assert.equal(named.firstBodyOffset, named.offset, 'a body hit is its own first body offset')
    assert.ok(hits[0].offset >= 0, 'the frontmatter row sorts last inside its chapter')

    // A chapter that declares nobody carries no explicit row, and an unresolvable
    // `pov` value is silence rather than a dangling entity_key.
    assert.deepEqual(
      (mentionsOf(root, 'w-1', { kind: 'world' }) ?? []).filter((hit) => hit.sources.includes('explicit')),
      [],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('one entity mentioned many times in many chapters keeps every location', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    // Two more occurrences of 白鹤门 across two chapters: all of them must be rows,
    // not just the first — impact reports count occurrences.
    writeMarkdown(root, 'chapters/vol-01/0004-丁.md', ['id: ch-4', 'title: 丁', 'seq: 4'], '白鹤门的门规写在石上。白鹤门的弟子背了三年。')
    await buildIndex(root)

    const hits = mentionsOf(root, 'w-1', { kind: 'world' }) ?? []
    const ch4 = hits.filter((hit) => hit.chapterId === 'ch-4')
    assert.equal(ch4.length, 2)
    const body = chapterBody(root, 'ch-4')
    for (const hit of ch4) {
      assert.equal(body.slice(hit.offset, hit.offset + '白鹤门'.length), '白鹤门')
    }
    assert.notEqual(ch4[0].offset, ch4[1].offset)

    const chapters = chaptersMentioning(root, 'world:w-1') ?? []
    assert.deepEqual(
      chapters.map((chapter) => chapter.chapterId),
      ['ch-2', 'ch-4'],
    )
    const ch4Summary = chapters.find((chapter) => chapter.chapterId === 'ch-4')
    assert.equal(ch4Summary?.mentions, 2)
    assert.equal(ch4Summary?.firstOffset, ch4[0].offset, 'the summary reports the earliest of the two')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('“how many chapters has this character been gone” answers from the last appearance', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    await buildIndex(root)

    // After ch-2: 白鹤门 has not appeared since (ch-3 is its absence), 清音 does
    // appear later (ch-3 by alias) so it must not be reported.
    const afterTwo = absentEntities(root, 'ch-2') ?? []
    const keys = afterTwo.map((entity) => entity.entityKey)
    assert.ok(keys.includes('world:w-1'), '白鹤门 is missing after ch-2')
    assert.ok(!keys.includes('characters:c-1'), '清音 appears in ch-3 and is not absent')
    const whiteCrane = afterTwo.find((entity) => entity.entityKey === 'world:w-1')
    assert.equal(whiteCrane?.missed, 1, 'one chapter came after its last appearance')
    assert.equal(whiteCrane?.lastChapterId, 'ch-2')
    assert.equal(whiteCrane?.title, '白鹤门')
    assert.equal(whiteCrane?.kind, 'world')

    // "After ch-3" is strictly-after: 清音 does appear in ch-3 itself, so nothing
    // follows its last appearance and `missed` is 0 — the chapter it is in is not one
    // it was missing from. `missed: 0` is therefore not a finding and is filtered out
    // by the default `minMissed`, which is what keeps a still-onstage character off the
    // 掉线 list.
    const afterThree = absentEntities(root, 'ch-3') ?? []
    assert.equal(
      afterThree.find((entity) => entity.entityKey === 'characters:c-1'),
      undefined,
      'missed: 0 means it is still onstage, not fallen off',
    )
    assert.equal(afterThree.find((entity) => entity.entityKey === 'world:w-1')?.missed, 1)

    // `minMissed: 0` is the "whole cast plus its position" view, where a 0 is visible.
    const cast = absentEntities(root, 'ch-3', { minMissed: 0 }) ?? []
    assert.equal(cast.find((entity) => entity.entityKey === 'characters:c-1')?.missed, 0)

    // An unknown chapter id cannot be judged — undefined, not an empty verdict.
    assert.equal(absentEntities(root, 'ch-nope'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a character known only from `pov` is not reported as having dropped out', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    // 赵孤 narrates the last chapter (ch-2) without ever being named in its prose — the
    // exact shape that used to show up in the 掉线 list with `missed: 0`, i.e. "present"
    // reported as "gone": its last appearance *is* the chapter being asked about, and
    // nothing follows it.
    writeMarkdown(root, 'chapters/vol-01/0001-甲.md', ['id: ch-1', 'title: 甲', 'seq: 1'], '白鹤门的三位长老坐在堂中。')
    writeMarkdown(root, 'chapters/vol-01/0002-乙.md', ['id: ch-2', 'title: 乙', 'seq: 2', 'pov: 赵孤'], '风雪灌进来。')
    writeMarkdown(root, 'characters/赵孤.md', ['id: c-9', 'name: 赵孤'], '独行的剑客。')
    writeMarkdown(root, 'world/门派/白鹤门.md', ['id: w-1', 'title: 白鹤门'], '山中剑派。')
    await buildIndex(root)

    // The declaration itself has no body position, so `firstBodyOffset` is absent and a
    // caret would have nowhere to go — which is exactly why it must not be -1.
    const declared = mentionsOf(root, 'c-9', { kind: 'characters' }) ?? []
    assert.equal(declared.length, 1)
    assert.ok(declared[0].offset < 0)
    assert.equal(declared[0].firstBodyOffset, undefined, 'no prose occurrence, so nothing to jump to')

    // Asked about its own chapter the character is onstage: `missed: 0` — and the default
    // threshold keeps a 0 off the list, which is the false positive this guards.
    const afterTwo = absentEntities(root, 'ch-2') ?? []
    assert.equal(
      afterTwo.find((entity) => entity.entityKey === 'characters:c-9'),
      undefined,
      'still onstage in ch-2, so not a finding',
    )
    assert.equal(afterTwo.find((entity) => entity.entityKey === 'world:w-1')?.missed, 1, '白鹤门 really is gone')

    // `minMissed: 0` is how a caller sees the raw position; the 0 is the documented
    // "in the given chapter" value rather than a fallback.
    const all = absentEntities(root, 'ch-2', { minMissed: 0 }) ?? []
    const onstage = all.find((entity) => entity.entityKey === 'characters:c-9')
    assert.equal(onstage?.missed, 0, '0 means "in the given chapter", per the documented definition')
    assert.equal(onstage?.lastChapterId, 'ch-2')
    assert.equal(onstage?.title, '赵孤')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('names are matched through nameKey folding, and the offset still points at the source', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    sampleBook(root)
    // Full-width capitals in the manuscript, ASCII alias on the character: NFKC +
    // case folding makes them the same word, and the offset must address the
    // full-width text (which is where the caret has to land).
    writeMarkdown(root, 'characters/akira.md', ['id: c-2', 'name: Akira', 'aliases: 阿基拉'], '外来剑客。')
    writeMarkdown(root, 'chapters/vol-01/0005-戊.md', ['id: ch-5', 'title: 戊', 'seq: 5'], '来客自报家门：ＡＫＩＲＡ。')
    await buildIndex(root)

    const hits = (mentionsOf(root, 'c-2', { kind: 'characters' }) ?? []).filter((hit) => hit.chapterId === 'ch-5')
    assert.equal(hits.length, 1)
    assert.deepEqual(hits[0].sources, ['name'])
    const body = chapterBody(root, 'ch-5')
    assert.equal(body.slice(hits[0].offset, hits[0].offset + 'ＡＫＩＲＡ'.length), 'ＡＫＩＲＡ')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the chapter frontmatter is not manuscript text: a title-only name is no mention', async () => {
  const dir = workdir()
  try {
    const root = join(dir, 'book')
    scaffold(root)
    // 白鹤门 appears in this chapter's *frontmatter* only. Scanning the raw file
    // would report a mention the reader never sees, so only the parsed body counts.
    writeMarkdown(root, 'chapters/vol-01/0001-甲.md', ['id: ch-1', 'title: 白鹤门', 'seq: 1'], '风雪灌进来。')
    writeMarkdown(root, 'world/门派/白鹤门.md', ['id: w-1', 'title: 白鹤门'], '山中剑派。')
    await buildIndex(root)

    assert.deepEqual(mentionsOf(root, 'w-1', { kind: 'world' }), [])
    assert.deepEqual(chaptersMentioning(root, 'world:w-1'), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the schema version moved so every project rebuilds once', async () => {
  // v6 was #29 (entity_mentions), v7 was #32 (the facts table), v8 was #31
  // (foreshadowings), v9 is #48 (the derived absolute-day column).
  assert.equal(INDEX_SCHEMA_VERSION, 9, 'a new table is a new schema version, never an ALTER')
})

test('a 590k-character / 2900-entity scan stays inside the 5 s budget', () => {
  // The DoD figure is 59 万字 / ~2900 entities. Scanning is one pass over the
  // manuscript with a shared automaton, so the cost is text × log(patterns), not
  // text × entities; this fixture is deliberately at the stated scale (600k chars,
  // 2900 entities) so a regression to per-entity `indexOf` shows up as a timeout.
  // Names are decoded from the index (not sampled with dedupe) so the fixture can
  // never spin looking for a 2901st unique name.
  const surnames = '清明白鹤静水长风赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许'.split('')
  const givenNames = '音影门观剑云月霜雪松竹梅兰菊石泉溪江河湖海楼台亭阁心'.split('')
  const entities = []
  const names = []
  for (let index = 0; index < 2900; index += 1) {
    const surname = surnames[index % surnames.length]
    const given = givenNames[Math.floor(index / surnames.length) % givenNames.length]
    const tail = givenNames[Math.floor(index / (surnames.length * givenNames.length)) % givenNames.length]
    const title = `${surname}${given}${tail}`
    names.push(title)
    entities.push({
      kind: index % 3 === 0 ? 'world' : 'characters',
      id: `e-${String(index)}`,
      path: `characters/e-${String(index)}.md`,
      title,
      nameKey: title,
      aliases: [`${surname}${given}`],
    })
  }

  const filler = '他想起那年冬天雪落在檐角上，风从门缝里挤进来，灯焰歪了一歪。'
  const chapters = []
  for (let index = 0; index < 200; index += 1) {
    let body = ''
    let mention = index
    while (body.length < 3000) {
      body += filler
      body += names[mention % names.length]
      mention += 17
    }
    chapters.push({ id: `ch-${String(index + 1)}`, body })
  }
  const chars = chapters.reduce((sum, chapter) => sum + chapter.body.length, 0)
  assert.ok(chars >= 590000, `fixture covers the stated scale (${String(chars)} chars)`)

  const started = Date.now()
  const rows = scanMentions(chapters, entities)
  const elapsed = Date.now() - started

  assert.ok(rows.length > 1000, `the fixture actually produces mentions (${String(rows.length)})`)
  assert.ok(elapsed < 5000, `scanMentions took ${String(elapsed)} ms for ${String(chars)} chars / ${String(entities.length)} entities`)
  console.log(`# scanMentions: ${String(chars)} chars, ${String(entities.length)} entities, ${String(rows.length)} rows → ${String(elapsed)} ms`)
})
