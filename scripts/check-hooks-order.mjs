/**
 * Finds hooks that are called AFTER an early `return` in the same component.
 *
 * React requires the same hooks in the same order on every render. A component that
 * returns early — `if (view === 'settings') return <SettingsView/>` — and then calls
 * `useCallback` below it renders fine in the first mode and throws
 * "Rendered fewer hooks than expected" in the second, which blanks the whole panel
 * (issue #174: the settings page went white and nothing was logged where the author
 * could see it).
 *
 * This walks the real AST (TypeScript is already a devDependency), so it is precise:
 * per function with a block body, in statement order, once a statement can return
 * early, any later hook call is a violation.
 *
 * Run: node scripts/check-hooks-order.mjs [dir...]    (wired into `pnpm run check:guards`)
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

const ROOT = resolve(import.meta.dirname, '..')
const DIRS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['src/client']
const HOOK = /^use[A-Z0-9]/

/** Does this statement contain a `return` that executes before the next statement? */
function exitsEarly(node) {
  if (ts.isReturnStatement(node)) return true
  if (ts.isIfStatement(node)) {
    // `if (x) return …` or `if (x) { … return … }` — either way the rest of the body may be skipped.
    return (
      ts.isReturnStatement(node.thenStatement) ||
      (ts.isBlock(node.thenStatement) && node.thenStatement.statements.some((s) => exitsEarly(s))) ||
      exitsEarly(node.thenStatement)
    )
  }
  return false
}

/** The hook called by this statement, if the statement is one. */
function hookOf(node) {
  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      const init = declaration.initializer
      if (init !== undefined && ts.isCallExpression(init)) {
        const callee = init.expression
        if (ts.isIdentifier(callee) && HOOK.test(callee.text)) return callee.text
      }
    }
  }
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
    const callee = node.expression.expression
    if (ts.isIdentifier(callee) && HOOK.test(callee.text)) return callee.text
  }
  return undefined
}

const problems = []

function scanFile(file) {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const body = node.body
      if (body !== undefined && ts.isBlock(body)) {
        let sawEarlyReturn = false
        for (const statement of body.statements) {
          const hook = hookOf(statement)
          if (hook !== undefined && sawEarlyReturn) {
            const { line } = source.getLineAndCharacterOfPosition(statement.getStart(source))
            const name = node.name !== undefined && ts.isIdentifier(node.name) ? node.name.text : '<arrow>'
            problems.push({
              file: relative(ROOT, file).replaceAll('\\', '/'),
              line: line + 1,
              message: `${name} calls ${hook}() after an early return — the hook count changes between renders`,
            })
          }
          if (exitsEarly(statement)) sawEarlyReturn = true
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

for (const dir of DIRS) {
  const full = join(ROOT, dir)
  for (const name of readdirSync(full)) {
    if (name.endsWith('.tsx') || name.endsWith('.ts')) scanFile(join(full, name))
  }
}

if (problems.length === 0) {
  console.log(`hooks order ok: no hook is called after an early return (${DIRS.join(', ')})`)
} else {
  console.error(`hooks order: ${problems.length} problem(s)`)
  for (const problem of problems) console.error(`  - ${problem.file}:${problem.line}: ${problem.message}`)
  process.exit(1)
}
