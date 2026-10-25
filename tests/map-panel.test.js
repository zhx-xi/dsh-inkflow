/**
 * Issue #48 — the map tab (第一版：地点清单 + 跳转), ADR-0025 D4.
 *
 * The page itself is only checked as a built bundle (`tests/panel-bundle.test.js`); what is
 * pinned **here** is the three things that could go wrong silently:
 *
 *   1. **a place is a world entry** — the map groups the world book's own categories and
 *      nothing else. No `location` kind, no coordinate field, no second projection: the
 *      library payload is the only source, so a pin cannot disagree with the entry.
 *   2. **a pin is an address** — clicking hands over `(kind, id)`, never a copy. The
 *      reverse direction matters too: an entry renamed keeps its id (ADR-0014), so the jump
 *      still lands after a rename.
 *   3. **the three empty states stay apart** — a failed request, an unreadable index and a
 *      book with no places are three different sentences; collapsing them makes "索引没建"
 *      read as "你还没写地点".
 *
 * Runs against the BUILT artifact (lib/index.js), like every other suite.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DOMAIN_MODULES, MAP_NOTE, PANEL_TABS, PLACE_KIND, describePin, placeGroups, readMapView } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

/** A `/library` payload with three world entries in two categories, plus one other kind. */
function libraryPayload() {
  return {
    indexAvailable: true,
    total: 4,
    kinds: [
      {
        kind: 'characters',
        total: 1,
        items: [{ id: 'char-qingyin', path: 'characters/qingyin.md', title: '清音', category: null, parent: null, status: null }],
      },
      {
        kind: 'world',
        total: 3,
        items: [
          { id: 'world-baihe', path: 'world/门派/白鹤门.md', title: '白鹤门', category: '门派', parent: null, status: null },
          { id: 'world-cangshan', path: 'world/地点/苍山.md', title: '苍山', category: '地点', parent: null, status: null },
          { id: 'world-loose', path: 'world/无根.md', title: '无根条目', category: null, parent: null, status: null },
        ],
        categories: [
          {
            category: '门派',
            total: 1,
            items: [{ id: 'world-baihe', path: 'world/门派/白鹤门.md', title: '白鹤门', category: '门派', parent: null, status: null }],
          },
          {
            category: '地点',
            total: 1,
            items: [{ id: 'world-cangshan', path: 'world/地点/苍山.md', title: '苍山', category: '地点', parent: null, status: null }],
          },
          {
            category: null,
            total: 1,
            items: [{ id: 'world-loose', path: 'world/无根.md', title: '无根条目', category: null, parent: null, status: null }],
          },
        ],
      },
    ],
  }
}

test('map: places are the world book\'s categories, and nothing else', () => {
  const view = readMapView({ ok: true, status: 200, value: libraryPayload() })
  assert.equal(view.error, null)
  assert.equal(view.indexAvailable, true)
  assert.equal(view.total, 3, 'only world entries are places')
  assert.deepEqual(
    view.groups.map((group) => group.label),
    ['门派', '地点', '未分类'],
    'the storage order of the categories is kept, the uncategorised bucket last',
  )
  assert.deepEqual(view.groups[1].places, [
    { id: 'world-cangshan', title: '苍山', path: 'world/地点/苍山.md' },
  ])
  // No coordinate field anywhere: D4 forbids inventing one for display.
  assert.deepEqual(Object.keys(view.groups[0].places[0]).sort(), ['id', 'path', 'title'])
})

test('map: a pin is an address (kind + id), so a rename cannot break the jump', () => {
  assert.equal(PLACE_KIND, 'world', 'a place is a world entry — ADR-0025 D4, no separate kind')
  const pins = placeGroups({
    groups: [
      {
        kind: 'world',
        total: 1,
        categories: [
          {
            category: null,
            label: '未分类',
            total: 1,
            items: [{ kind: 'world', id: 'world-cangshan', path: 'world/地点/旧名.md', title: '苍山', category: null, parent: null, status: null }],
          },
        ],
      },
    ],
    total: 1,
    indexAvailable: true,
  })
  const pin = pins[0]?.places[0]
  assert.deepEqual(pin, { id: 'world-cangshan', title: '苍山', path: 'world/地点/旧名.md' })
  // The path may say the old name (renames are normal); the id is the identity.
  assert.match(describePin(pin), /world\/地点\/旧名\.md/u)
  assert.match(describePin(pin), /设定库/u)
})

test('map: the kind set does not grow — no `location` kind, no locations directory', () => {
  const kinds = new Set(DOMAIN_MODULES.map((module) => module.kind))
  assert.equal(kinds.has('location'), false, 'a new kind would give one entry two identities (D4)')
  assert.deepEqual([...kinds].includes('world'), true)
  // And no content directory was added for places.
  const conventions = readFileSync(join(repoRoot, 'src/host/conventions.ts'), 'utf8')
  const contentDirs = /export const CONTENT_DIRS = \[([\s\S]*?)\] as const/u.exec(conventions)?.[1] ?? ''
  assert.equal(contentDirs.includes('locations'), false, 'CONTENT_DIRS must not grow a locations directory')
})

test('map: the three empty states stay apart', () => {
  const failed = readMapView({ ok: false, status: 500, error: { code: 'INDEX_UNAVAILABLE', message: 'no index' } })
  assert.match(failed.error ?? '', /INDEX_UNAVAILABLE/u)
  assert.equal(failed.groups.length, 0)

  const unavailable = readMapView({ ok: true, status: 200, value: { indexAvailable: false, kinds: [] } })
  assert.equal(unavailable.error, null)
  assert.equal(unavailable.indexAvailable, false)
  assert.equal(unavailable.empty, null, '"索引读不了" must not be worded as "你没有地点"')

  const empty = readMapView({ ok: true, status: 200, value: { indexAvailable: true, kinds: [{ kind: 'world', total: 0, items: [] }] } })
  assert.equal(empty.indexAvailable, true)
  assert.equal(empty.total, 0)
  assert.match(empty.empty ?? '', /世界观条目/u, 'the empty state says how to create a place')
  assert.match(empty.summary ?? '', /还没有地点/u)
})

test('map: the tab is live and the page explains what it is not', () => {
  const tab = PANEL_TABS.find((entry) => entry.id === 'map')
  assert.ok(tab, 'the map tab is registered')
  assert.equal(tab.available, true, 'a tab with no page is a dead button; this one has one')
  assert.match(MAP_NOTE, /ADR-0025 D4/u, 'the page states the rule it follows')
  assert.match(MAP_NOTE, /坐标/u, 'and the one thing this version does not do')
})
