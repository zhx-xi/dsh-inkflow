/**
 * Body whitelists are declared in the module that READS the body.
 *
 * Every write route of the private channel declares which body fields it accepts, and
 * that declaration is the guard that answers 400 `UNEXPECTED_BODY_FIELD` before any
 * handler runs. A whitelist SHORTER than what the handler writes is therefore not a
 * small mistake: the field is legal in the settings/storage layer and the panel still
 * cannot save it.
 *
 * That accident is exactly what this pins, caught before it shipped: `hub-settings-update`
 * carried a hand-copied field list, and the settings work added `semanticEndpoint`/`semanticApiKey`
 * to `SETTINGS_FIELDS` without touching the copy. Nothing failed that time — the copy
 * happened to be complete — which is precisely why the next field would have been a
 * silent 400.
 *
 * This file pins the mechanical half of the rule: `routes.ts` holds NO inline
 * `body: [...]` literal. The names live next to the handler that reads them, exported
 * as one `*_BODY_FIELDS` constant, and the route imports it — one place to edit, one
 * place to drift. The settings route additionally DERIVES its list from
 * `SETTINGS_FIELDS`; that (and the wire accepting every setting) is asserted in
 * `tests/hub-settings.test.js`, which can load the route.
 *
 * Run: pnpm test
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const ROUTES = join(ROOT, 'src', 'host', 'routes.ts')

/**
 * Source text with comments removed, one trimmed line each.
 *
 * The guard is about CODE, so a doc comment that mentions `body: [...]` while
 * explaining the rule must not fail it (and a comment cannot drift from a handler).
 * Only the two comment shapes this file uses are handled: `// …` and the ` * …`
 * continuation lines of `/** … *\/` blocks.
 */
function codeLines(source) {
  return source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('//') && !line.startsWith('/*') && !line.startsWith('*'))
}

test('no route declares its body whitelist as an inline array literal', () => {
  const lines = codeLines(readFileSync(ROUTES, 'utf8'))

  // Sanity: the scan must be looking at the route table, not at an empty string. If
  // this ever fails, the file moved or the allowlists stopped being referenced here —
  // and then the assertion below would pass for the wrong reason.
  const references = lines.filter((line) => /body:\s*[A-Za-z_$][\w$]*,?$/u.test(line))
  assert.ok(
    references.length > 0,
    'expected routes.ts to reference body whitelists by constant; the guard is scanning nothing',
  )

  const offenders = lines.filter((line) => /body:\s*\[/u.test(line))
  assert.deepEqual(
    offenders,
    [],
    `body 白名单必须来自 handler 模块导出的常量；行内字面量会与写入侧漂移\n${offenders.join('\n')}`,
  )
})
