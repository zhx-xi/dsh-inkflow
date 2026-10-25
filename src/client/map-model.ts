/**
 * Pure view model for the map tab (ADR-0025 D4).
 *
 * **The map is a view, not a data source.** A place is a `world/<category>` entry — no
 * `location` kind, no `locations/` directory, no coordinate columns (ADR-0025 D4). So
 * this file does not define what a place is; it re-groups what the setting library
 * already publishes (`GET /inkflow/internal/library`, X-7), by the world book's own
 * categories.
 *
 * Two consequences worth stating, because both are easy to get wrong later:
 *
 *   * **no new Host route.** The first version of the map needs nothing the library
 *     payload does not already carry, and a second projection of the same rows would be
 *     the start of the "two identities for one entry" problem D4 exists to prevent.
 *   * **a pin is an address, not a copy.** Clicking one hands the entry's `(kind, id)` to
 *     the workbench, which opens it in 设定库 — the same route the audit rows already use.
 *     The map therefore cannot drift from the entry: it holds an id and a title, never a
 *     duplicate of what the entry says.
 *
 * No IO, no React, no `@deepseek-ai/*` import (ADR-0008 D4): `node --test` has no DOM, so
 * the grouping and the wording are tested here directly.
 */

import type { InternalResult } from './internal.js'
import { buildLibraryTree } from './library-model.js'
import type { LibraryTree, LibraryValue } from './library-model.js'

/** The kind a place comes from. Fixed by ADR-0025 D4 — places are world entries. */
export const PLACE_KIND = 'world'

/** One place, i.e. one world entry, addressed the way the library addresses it. */
export interface PlacePin {
  /** Entity id, not a path: the library's own address (ADR-0014 pins it across renames). */
  id: string
  title: string
  /** Project-relative file, shown as the pin's evidence rather than as its identity. */
  path: string
}

/** One world category, with the places inside it. */
export interface PlaceGroup {
  /** `null` for the uncategorised bucket (`world/<slug>.md` with no `category`). */
  category: string | null
  label: string
  total: number
  places: PlacePin[]
}

export interface MapView {
  /** The request's own failure, already worded (`INDEX_UNAVAILABLE`, a 403, …). */
  error: string | null
  /** `false` = the derived index could not answer. NOT "this book has no places". */
  indexAvailable: boolean
  groups: PlaceGroup[]
  total: number
  /** One line above the list: what the page is showing. `null` while loading. */
  summary: string | null
  /** What to do when there are no places at all. `null` when there are some. */
  empty: string | null
}

const LOADING: MapView = {
  error: null,
  indexAvailable: true,
  groups: [],
  total: 0,
  summary: null,
  empty: null,
}

/**
 * Group a library tree's world rows into place groups.
 *
 * The order is the storage order `groupByCategory` already produces (named categories
 * first, the uncategorised bucket last), because a map that re-sorted itself alphabetically
 * would put 人间 under a different letter than the tree the author just saw.
 */
export function placeGroups(tree: LibraryTree): PlaceGroup[] {
  const world = tree.groups.find((group) => group.kind === PLACE_KIND)
  if (world === undefined) return []
  return world.categories
    .map((category) => ({
      category: category.category,
      label: category.label,
      total: category.items.length,
      places: category.items.map((item) => ({ id: item.id, title: item.title, path: item.path })),
    }))
    .filter((group) => group.total > 0)
}

/**
 * `GET /inkflow/internal/library` → the map's state.
 *
 * Three states stay apart for the same reason the foreshadow board keeps them apart: a
 * failed request, an unreadable index and an empty world book are three different things to
 * tell the author, and collapsing them makes "索引没建" read as "你还没写地点".
 */
export function readMapView(result: InternalResult<LibraryValue>): MapView {
  if (!result.ok) {
    const code = result.error?.code ?? 'unknown'
    return { ...LOADING, error: `${code}${result.error?.message === undefined ? '' : ` — ${result.error.message}`}` }
  }
  const value = result.value ?? null
  const tree = buildLibraryTree(value)
  const groups = placeGroups(tree)
  const total = groups.reduce((sum, group) => sum + group.total, 0)
  const indexAvailable = value?.indexAvailable !== false

  if (!indexAvailable) {
    return { ...LOADING, indexAvailable: false, summary: null, empty: null }
  }
  return {
    error: null,
    indexAvailable: true,
    groups,
    total,
    summary: total === 0 ? '还没有地点' : `${String(total)} 个地点，分 ${String(groups.length)} 类`,
    empty:
      total === 0
        ? '地点就是世界观条目：在设定库的「世界观」下建一个条目（world/<分类>/<名字>.md），它就会出现在这里。'
        : null,
  }
}

/** The tooltip on one pin: what clicking it does, and where the entry lives. */
export function describePin(pin: PlacePin): string {
  return `${pin.title} — 打开设定库中的条目（${pin.path}）`
}

/** The line under the list: the one thing a reader must know about this page. */
export const MAP_NOTE =
  '地点即世界观条目（ADR-0025 D4）：本页按 world/<分类> 分组，点一下跳到设定库里的同一条目。不做坐标绘图——坐标不在本单范围内。'
