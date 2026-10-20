/**
 * Project detection, gating and scaffolding — the "convention over
 * configuration" half of ADR-0005.
 *
 * A directory is an InkFlow project when it is a git repository AND every
 * required directory exists (docs/conventions.md §1). The plugin never
 * registers projects anywhere: the filesystem *is* the registry.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, parse as parsePath, resolve } from 'node:path'

import {
  CONTENT_DIRS,
  FILE_SCHEMA_VERSION,
  INDEX_DIR,
  INDEX_KEEP_FILE,
  REQUIRED_DIRS,
  REQUIRED_GITIGNORE_LINES,
  ROOT_META_FILE,
} from './conventions.js'

export interface ProjectMeta {
  schemaVersion: number
  title?: string
  author?: string
  seriesId?: string | null
  createdAt?: string
}

export interface ProjectChecks {
  git: boolean
  dirs: Record<string, boolean>
  meta: boolean
}

export interface ProjectProbe {
  root: string
  checks: ProjectChecks
  missingDirs: string[]
  missing: string[]
  meta?: ProjectMeta
  metaError?: string
  /** True when `index/` was absent and got created because the rest checked out. */
  indexDirRecreated: boolean
  usable: boolean
  reasons: string[]
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** A git worktree has a `.git` *file*; a normal repo has a `.git` directory. */
export function isGitRoot(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

export function hasContentDirs(dir: string): boolean {
  return CONTENT_DIRS.every((name) => isDirectory(join(dir, name)))
}

/**
 * Walk up from `start` to find the nearest directory that looks like an
 * InkFlow project. Intentionally lenient about `index/` (it is derived) so a
 * deleted index never hides the project; `inspectProject` applies the strict
 * gate and recreates the index directory.
 */
export function findProjectRoot(start: string): string | undefined {
  let current = resolve(start)
  for (let depth = 0; depth < 16; depth += 1) {
    if (isGitRoot(current) && hasContentDirs(current)) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return undefined
}

export function readMeta(root: string): { meta?: ProjectMeta; error?: string } {
  const file = join(root, ROOT_META_FILE)
  let raw: string
  try {
    // Users edit these files with arbitrary Windows tools: a UTF-8 BOM must not
    // make the project unreadable (PowerShell's Set-Content emits one).
    raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return { error: `${ROOT_META_FILE} is missing` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: `${ROOT_META_FILE} is not valid JSON` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: `${ROOT_META_FILE} must be a JSON object` }
  }
  const record = parsed as Record<string, unknown>
  const version = record['schemaVersion']
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    return { error: `${ROOT_META_FILE} is missing an integer schemaVersion` }
  }
  const meta: ProjectMeta = { schemaVersion: version }
  if (typeof record['title'] === 'string') meta.title = record['title']
  if (typeof record['author'] === 'string') meta.author = record['author']
  if (typeof record['seriesId'] === 'string' || record['seriesId'] === null) {
    meta.seriesId = record['seriesId'] as string | null
  }
  if (typeof record['createdAt'] === 'string') meta.createdAt = record['createdAt']
  return { meta }
}

export interface InspectOptions {
  /**
   * Create `index/` when it is the only missing directory. Default true: a
   * derived directory must never be able to lock the user out (ADR-0005).
   */
  recreateIndexDir?: boolean
}

export function inspectProject(root: string, options: InspectOptions = {}): ProjectProbe {
  const recreateIndexDir = options.recreateIndexDir ?? true
  const absolute = resolve(root)
  const checks: ProjectChecks = { git: isGitRoot(absolute), dirs: {}, meta: false }
  const missingDirs: string[] = []
  let indexDirRecreated = false

  for (const name of REQUIRED_DIRS) {
    checks.dirs[name] = isDirectory(join(absolute, name))
  }

  if (!checks.dirs[INDEX_DIR] && recreateIndexDir) {
    const othersPresent = CONTENT_DIRS.every((name) => checks.dirs[name] === true)
    if (checks.git && othersPresent) {
      try {
        mkdirSync(join(absolute, INDEX_DIR), { recursive: true })
        writeFileSync(join(absolute, INDEX_DIR, INDEX_KEEP_FILE), '', 'utf8')
        checks.dirs[INDEX_DIR] = true
        indexDirRecreated = true
      } catch {
        checks.dirs[INDEX_DIR] = false
      }
    }
  }

  for (const name of REQUIRED_DIRS) {
    if (checks.dirs[name] !== true) missingDirs.push(name)
  }

  const metaResult = readMeta(absolute)
  checks.meta = metaResult.meta !== undefined
  if (metaResult.meta !== undefined && metaResult.meta.schemaVersion > FILE_SCHEMA_VERSION) {
    checks.meta = false
    metaResult.error = `project file schema v${metaResult.meta.schemaVersion} is newer than this plugin (v${FILE_SCHEMA_VERSION})`
  }

  const missing: string[] = []
  if (!checks.git) missing.push('.git')
  missing.push(...missingDirs)
  if (!checks.meta) missing.push(ROOT_META_FILE)

  const reasons: string[] = []
  if (!checks.git) reasons.push('directory is not a git repository')
  for (const name of missingDirs) reasons.push(`missing directory: ${name}/`)
  if (!checks.meta) reasons.push(metaResult.error ?? `${ROOT_META_FILE} is invalid`)

  return {
    root: absolute,
    checks,
    missingDirs,
    missing,
    ...(metaResult.meta === undefined ? {} : { meta: metaResult.meta }),
    ...(metaResult.error === undefined ? {} : { metaError: metaResult.error }),
    indexDirRecreated,
    usable: missing.length === 0,
    reasons,
  }
}

export interface InitResult {
  probe: ProjectProbe
  createdDirs: string[]
  createdFiles: string[]
  gitignoreUpdated: boolean
  gitInitNeeded: boolean
}

/**
 * Scaffold a project. Never runs `git init` on the user's behalf: the git
 * identity, remote and branch belong to the user, and a half-initialised repo
 * is worse than a clear "run git init" instruction.
 */
export function initProject(root: string, input: { title: string; author?: string }): InitResult {
  const absolute = resolve(root)
  mkdirSync(absolute, { recursive: true })

  const createdDirs: string[] = []
  for (const name of [...CONTENT_DIRS, INDEX_DIR]) {
    const path = join(absolute, name)
    if (!isDirectory(path)) {
      mkdirSync(path, { recursive: true })
      createdDirs.push(name)
    }
  }

  const createdFiles: string[] = []
  const keep = join(absolute, INDEX_DIR, INDEX_KEEP_FILE)
  if (!existsSync(keep)) {
    writeFileSync(keep, '', 'utf8')
    createdFiles.push(`${INDEX_DIR}/${INDEX_KEEP_FILE}`)
  }

  const metaFile = join(absolute, ROOT_META_FILE)
  if (!existsSync(metaFile)) {
    const title = input.title.trim()
    if (title === '') throw new Error('inkflow: project title must not be empty')
    const meta: ProjectMeta = {
      schemaVersion: FILE_SCHEMA_VERSION,
      title,
      createdAt: new Date().toISOString(),
    }
    if (input.author !== undefined && input.author.trim() !== '') meta.author = input.author.trim()
    writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
    createdFiles.push(ROOT_META_FILE)
  }

  const gitignore = join(absolute, '.gitignore')
  let gitignoreUpdated = false
  const existing = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : ''
  const missingLines = REQUIRED_GITIGNORE_LINES.filter((line) => !existing.split('\n').includes(line))
  if (missingLines.length > 0) {
    const prefix = existing === '' ? '' : existing.endsWith('\n') ? existing : `${existing}\n`
    const header = existing === '' ? '# InkFlow derived index — rebuildable, never committed\n' : ''
    writeFileSync(gitignore, `${prefix}${header}${missingLines.join('\n')}\n`, 'utf8')
    gitignoreUpdated = true
    if (existing === '') createdFiles.push('.gitignore')
  }

  return {
    probe: inspectProject(absolute),
    createdDirs,
    createdFiles,
    gitignoreUpdated,
    gitInitNeeded: !isGitRoot(absolute),
  }
}

/** Display name of a project: meta title, else the directory name. */
export function projectLabel(probe: ProjectProbe): string {
  return probe.meta?.title ?? parsePath(probe.root).name
}
