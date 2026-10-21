/**
 * Zero-dependency lint: real AST rules over src/, scripts/ and tests/.
 *
 * We deliberately did not add ESLint: the project is dependency-free at runtime
 * and the checks that actually catch bugs here are few and semantic (no `any`,
 * no loose equality, no `console` in plugin code, no unreasoned ts-ignore).
 * `typescript` is already a devDependency, so the AST is free.
 *
 * Suppression: `// lint-ignore: <rule> - <reason>` on the same line.
 * Run: node scripts/lint.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import ts from 'typescript'

const ROOT = resolve(import.meta.dirname, '..')
const TARGET_DIRS = ['src', 'scripts', 'tests']
const EXT = new Set(['.ts', '.tsx', '.mjs', '.js'])

const PROBLEMS = []

function walk(dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (EXT.has(entry.name.slice(entry.name.lastIndexOf('.')))) out.push(full)
  }
}

const files = []
for (const dir of TARGET_DIRS) walk(join(ROOT, dir), files)

function report(file, node, rule, message) {
  const text = file.text
  const { line } = file.sourceFile.getLineAndCharacterOfPosition(node.getStart(file.sourceFile))
  const lineText = text.split('\n')[line] ?? ''
  if (lineText.includes('lint-ignore')) return
  PROBLEMS.push({
    file: relative(ROOT, file.path).replaceAll('\\', '/'),
    line: line + 1,
    rule,
    message,
  })
}

for (const path of files) {
  const text = readFileSync(path, 'utf8')
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : path.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS)
  const file = { path, text, sourceFile }
  const inSrc = path.startsWith(join(ROOT, 'src'))

  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      report(file, node, 'no-any', 'do not use `any`; model the shape or use `unknown`')
    }
    if (node.kind === ts.SyntaxKind.EqualsEqualsToken || node.kind === ts.SyntaxKind.ExclamationEqualsToken) {
      report(file, node, 'no-loose-equality', 'use === / !== (no implicit coercion)')
    }
    if (
      inSrc &&
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'console'
    ) {
      report(file, node, 'no-console', 'plugin code must use the harness logger, not console')
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)

  // Unreasoned TypeScript suppressions.
  text.split('\n').forEach((lineText, index) => {
    const match = /\/\/\s*@ts-(ignore|expect-error)\b(.*)$/.exec(lineText)
    if (!match) return
    if (lineText.includes('lint-ignore')) return
    if ((match[2] ?? '').trim().length === 0) {
      PROBLEMS.push({
        file: relative(ROOT, path).replaceAll('\\', '/'),
        line: index + 1,
        rule: 'no-bare-ts-ignore',
        message: 'a @ts-ignore / @ts-expect-error needs a reason on the same line',
      })
    }
  })
}

if (PROBLEMS.length > 0) {
  for (const p of PROBLEMS) console.error(`${p.file}:${p.line}  ${p.rule}  ${p.message}`)
  console.error(`\nlint failed: ${PROBLEMS.length} problem(s) in ${files.length} file(s)`)
  process.exit(1)
}
console.log(`lint ok: ${files.length} file(s)`)
