/**
 * Per-file sha256 map of a project tree, shared by the #36 acceptance tests.
 *
 * `hashTree()` (in `hash-tree.mjs`) answers "did *anything* change" and is the right
 * tool for a zero-write assertion. This helper answers the other question a repair
 * pass has to prove: **which** files changed — "only the ones an action named, and
 * every other byte is identical". A single hash cannot tell those apart, and a
 * count cannot either.
 *
 * `skipDirs` drops whole first-level directories by name: the plugin's own
 * `.inkflow/` (a backup and a report are expected to appear there) and `.git/`.
 * A `.mjs` on purpose: the test glob only picks up `tests/*.test.js`, so requiring
 * this file registers no tests.
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @param {string} root
 * @param {{ skipDirs?: readonly string[] }} [options]
 * @returns {Map<string, string>} project-relative path → sha256 of its bytes
 */
export function fileDigests(root, options = {}) {
  const skip = new Set(options.skipDirs ?? ['.inkflow', '.git'])
  const out = new Map()
  const walk = (relative) => {
    const dir = relative === '' ? root : join(root, relative)
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (relative === '' && skip.has(entry.name)) continue
      if (entry.isDirectory()) {
        walk(child)
        continue
      }
      if (!entry.isFile()) continue
      out.set(child, createHash('sha256').update(readFileSync(join(root, child))).digest('hex'))
    }
  }
  walk('')
  return out
}

/** Paths whose digest differs between two maps (added, removed or changed). */
export function changedPaths(before, after) {
  const changed = []
  for (const [path, digest] of before) {
    if (after.get(path) !== digest) changed.push(path)
  }
  for (const path of after.keys()) {
    if (!before.has(path)) changed.push(path)
  }
  return changed.sort()
}

/** Empty files are invisible to a digest map — this keeps a directory counted as a file. */
export function fileSize(root, relative) {
  return statSync(join(root, relative)).size
}
