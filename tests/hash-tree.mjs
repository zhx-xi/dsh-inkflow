/**
 * Whole-tree fingerprint shared by the zero-write contract tests.
 *
 * The implementation is the one from `tests/contract.test.js` (the ADR-0010 E6
 * helper: names, kinds, sizes and mtimes), lifted into a module so a new test
 * file does not carry a third copy of it. It is a `.mjs` and not a `.test.js`
 * on purpose: the test glob only picks up `tests/*.test.js`, so requiring this
 * file registers no tests.
 *
 * `mtimes` are part of the hash: "the wizard did not touch this file" has to
 * mean the bytes AND the timestamps, because an atomic rewrite with identical
 * content is still a write.
 *
 * Note for the caller: something must be written between the two snapshots for
 * this to prove anything. Comparing two hashes of an untouched tree is a
 * tautology; comparing them around a REFUSED request is the assertion.
 */

import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function hashTree(root) {
  const hash = createHash('sha256')
  const walk = (relative) => {
    const dir = relative === '' ? root : join(root, relative)
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`
      const info = statSync(join(root, child))
      hash.update(`${child}|${entry.isDirectory() ? 'd' : 'f'}|${info.size}|${info.mtimeMs}\n`)
      if (entry.isDirectory()) walk(child)
    }
  }
  walk('')
  return hash.digest('hex')
}
