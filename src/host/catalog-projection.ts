/**
 * The projection: the `.md` files are the truth, so both catalog files are derived from them.
 *
 * WHY IT IS A FILE: this is the half of `catalog.ts` that answers "what SHOULD the catalog
 * say", plus the read-only comparison that answers "does the JSON on disk still say it"
 * (`inspectCatalogs` → `stale`/parsed values). Neither writes a byte. The public read,
 * rebuild and validate functions stayed in `catalog.ts` because each of them is one of the
 * three answers a caller asks for; this file is what all three compute from.
 *
 * Ownership rules (`chapter volume`) live here because they only ever touch the projection:
 *   1. frontmatter `volume` (a stable `vol-NN` id) wins;
 *   2. otherwise the first directory segment under `chapters/` decides, if that directory is
 *      a volume directory;
 *   3. otherwise the chapter is loose.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type {
  CatalogChapter,
  CatalogVolume,
  ProjectedCatalog,
  RootCatalog,
  VolumeCatalog,
  StaleCatalogFile,
} from './catalog-types.js'
import { CATALOG_FILE, CATALOG_SCHEMA_VERSION, CHAPTERS_DIR } from './conventions.js'
import { intField, parseMarkdown, stringField } from './frontmatter.js'

// ---------------------------------------------------------------------------
// Directory check
// ---------------------------------------------------------------------------

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Projection: .md files → catalog
// ---------------------------------------------------------------------------

/** `chapters/index.json`, always with `/` separators (write targets use this form). */
export const ROOT_CATALOG_PATH = `${CHAPTERS_DIR}/${CATALOG_FILE}`

export function volumeCatalogPath(dir: string): string {
  return `${CHAPTERS_DIR}/${dir}/${CATALOG_FILE}`
}

/**
 * `vol-01-入山` → `vol-01`. A single digit is normalised (`vol-7` → `vol-07`),
 * which is why a directory named `vol-7` is reported as `VOLUME_DIR_MISMATCH`:
 * the author has to align the folder with the stable id.
 */
const VOLUME_DIR = /^vol-(\d+)(?:-(.*))?$/i

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareVolumes(left: CatalogVolume, right: CatalogVolume): number {
  return left.order - right.order || compareText(left.dir, right.dir)
}

function compareChapters(left: CatalogChapter, right: CatalogChapter): number {
  const leftSeq = left.seq
  const rightSeq = right.seq
  if (leftSeq !== undefined && rightSeq !== undefined && leftSeq !== rightSeq) return leftSeq - rightSeq
  if (leftSeq !== undefined && rightSeq === undefined) return -1
  if (leftSeq === undefined && rightSeq !== undefined) return 1
  return compareText(left.file, right.file)
}

function volumeIdOfDir(dir: string): string | undefined {
  const match = VOLUME_DIR.exec(dir)
  const digits = match?.[1]
  if (digits === undefined) return undefined
  const number = Number.parseInt(digits, 10)
  if (!Number.isInteger(number) || number < 0) return undefined
  return `vol-${String(number).padStart(2, '0')}`
}

/** The last path segment, without depending on the platform's separator rules. */
function fileName(file: string): string {
  return file.slice(file.lastIndexOf('/') + 1)
}

function chapterTitle(file: string): string {
  return fileName(file).replace(/\.md$/i, '')
}

function leadingNumber(file: string): number | undefined {
  const match = /^(\d+)/.exec(fileName(file))
  const digits = match?.[1]
  return digits === undefined ? undefined : Number(digits)
}

/**
 * Volume title: `outlines/vol-NN[-slug].md` is the human-authored source for the
 * volume's name, so it wins over the directory slug (a slug has no spaces and
 * cannot be renamed without touching the file system; the outline can).
 *
 * Frontmatter `title` is authoritative; a first `# heading` is the fallback for
 * hand-written outlines that never grew frontmatter. Missing outline, unreadable
 * file or an empty title all fall back to the directory slug at the call site.
 */
function volumeTitleFromOutline(root: string, volumeId: string): string | undefined {
  const outlinesDir = join(root, 'outlines')
  let names: string[]
  try {
    names = readdirSync(outlinesDir)
  } catch {
    return undefined
  }
  const number = volumeId.startsWith('vol-') ? volumeId.slice('vol-'.length) : ''
  const wanted = number === '' ? undefined : Number.parseInt(number, 10)
  if (wanted === undefined || Number.isNaN(wanted)) return undefined
  const file = names.find((name) => {
    const match = /^vol-(\d+)(?:[-_].*)?\.md$/i.exec(name)
    return match?.[1] !== undefined && Number.parseInt(match[1], 10) === wanted
  })
  if (file === undefined) return undefined
  let text: string
  try {
    text = readFileSync(join(outlinesDir, file), 'utf8')
  } catch {
    return undefined
  }
  const parsed = parseMarkdown(text)
  const field = stringField(parsed.data, 'title')?.trim()
  if (field !== undefined && field !== '') return field
  const heading = /^\s{0,3}#\s+(.+?)\s*$/m.exec(parsed.body)
  return heading?.[1]?.trim()
}

/**
 * Volume directories are the immediate subdirectories of `chapters/` that follow
 * the `vol-NN[-slug]` convention. Anything else stays a plain directory; its
 * chapters remain visible as loose chapters instead of disappearing.
 */
function scanVolumes(root: string): CatalogVolume[] {
  let entries
  try {
    entries = readdirSync(join(root, CHAPTERS_DIR), { withFileTypes: true })
  } catch {
    return []
  }
  const volumes: CatalogVolume[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const volumeId = volumeIdOfDir(entry.name)
    if (volumeId === undefined) continue
    const slug = (VOLUME_DIR.exec(entry.name)?.[2] ?? '').trim()
    const outlineTitle = volumeTitleFromOutline(root, volumeId)
    volumes.push({
      volumeId,
      dir: entry.name,
      title: outlineTitle ?? (slug === '' ? volumeId : slug),
      order: Number.parseInt(volumeId.slice('vol-'.length), 10),
    })
  }
  volumes.sort(compareVolumes)
  return volumes
}

/** Every `.md` under `chapters/` (project-relative, `/` separators), sorted. */
function listChapterFiles(root: string): string[] {
  const files: string[] = []
  const walk = (directory: string, relative: string, depth: number): void => {
    if (depth > 8) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const childRelative = `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), childRelative, depth + 1)
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) files.push(childRelative)
    }
  }
  walk(join(root, CHAPTERS_DIR), CHAPTERS_DIR, 0)
  files.sort(compareText)
  return files
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Build the catalog from the files on disk. Pure read: nothing is written. */
export function projectCatalog(root: string): ProjectedCatalog {
  const volumes = scanVolumes(root)
  // First volume wins when two directories normalise to the same id. That is a
  // broken layout (`vol-1` and `vol-01`), reported by `validateCatalog`; the
  // projection still has to pick one owner so the output stays deterministic.
  const indexById = new Map<string, number>()
  volumes.forEach((volume, index) => {
    if (!indexById.has(volume.volumeId)) indexById.set(volume.volumeId, index)
  })

  const chaptersByVolume: CatalogChapter[][] = volumes.map(() => [])
  const looseChapters: CatalogChapter[] = []

  for (const file of listChapterFiles(root)) {
    const data = parseMarkdown(readText(join(root, ...file.split('/')))).data
    const segments = file.split('/')
    const directory = segments.length >= 3 ? segments[1] : undefined
    const directoryVolumeId = directory === undefined ? undefined : volumeIdOfDir(directory)

    const declared = stringField(data, 'volume')
    // A `volume:` pointing at a directory that does not exist falls back to the
    // chapter's own volume directory: losing the chapter from the catalog would
    // be worse than reporting it under the closest available owner.
    let owner = declared === undefined ? undefined : indexById.get(declared)
    if (owner === undefined && directoryVolumeId !== undefined) owner = indexById.get(directoryVolumeId)

    const seq = intField(data, 'seq') ?? leadingNumber(file)
    const chapter: CatalogChapter = {
      chapterId: stringField(data, 'id') ?? file,
      file,
      ...(seq === undefined ? {} : { seq }),
      title: stringField(data, 'title') ?? chapterTitle(file),
    }

    const target = owner === undefined ? undefined : chaptersByVolume[owner]
    if (target === undefined) looseChapters.push(chapter)
    else target.push(chapter)
  }

  const catalog: RootCatalog = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    volumes: volumes.map((volume) => ({
      volumeId: volume.volumeId,
      dir: volume.dir,
      title: volume.title,
      order: volume.order,
    })),
    looseChapters: looseChapters.sort(compareChapters),
  }
  const volumeCatalogs = volumes.map((volume, index) => ({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    volumeId: volume.volumeId,
    chapters: (chaptersByVolume[index] ?? []).sort(compareChapters),
  }))

  return { catalog, volumeCatalogs }
}

// ---------------------------------------------------------------------------
// Reading what is on disk
// ---------------------------------------------------------------------------

type CatalogFileRead =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'value'; value: unknown }

function readCatalogFile(root: string, relative: string): CatalogFileRead {
  const absolute = join(root, ...relative.split('/'))
  if (!existsSync(absolute)) return { kind: 'missing' }
  let raw: string
  try {
    raw = readFileSync(absolute, 'utf8')
  } catch {
    return { kind: 'invalid' }
  }
  try {
    // A BOM is common in files edited with Windows tools and must not turn a
    // readable catalog into "invalid" (hard-constraints H11).
    return { kind: 'value', value: JSON.parse(raw.replace(/^\uFEFF/, '')) }
  } catch {
    return { kind: 'invalid' }
  }
}

/**
 * Structural comparison. Arrays are ordered (a catalog's order is meaningful),
 * object keys are not — a hand-edit that only reorders keys is still a drift
 * because the file will be rewritten on the next rebuild, but we compare values
 * so a whitespace/indentation change alone does not count as stale.
 */
function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => jsonEqual(item, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  if (leftKeys.length !== Object.keys(rightRecord).length) return false
  return leftKeys.every((key) => Object.hasOwn(rightRecord, key) && jsonEqual(leftRecord[key], rightRecord[key]))
}

export interface DiskCatalogs {
  stale: StaleCatalogFile[]
  /** Parsed top-level catalog, when it exists and is valid JSON. */
  rootValue?: unknown
  /** Parsed per-volume catalogs keyed by project-relative path. */
  volumeValues: Map<string, unknown>
}

export function inspectCatalogs(root: string, projected: ProjectedCatalog): DiskCatalogs {
  const stale: StaleCatalogFile[] = []
  const volumeValues = new Map<string, unknown>()

  const rootRead = readCatalogFile(root, ROOT_CATALOG_PATH)
  if (rootRead.kind === 'missing') stale.push({ path: ROOT_CATALOG_PATH, reason: 'missing' })
  else if (rootRead.kind === 'invalid') stale.push({ path: ROOT_CATALOG_PATH, reason: 'invalid' })
  else if (!jsonEqual(rootRead.value, projected.catalog)) stale.push({ path: ROOT_CATALOG_PATH, reason: 'differs' })

  const seenDirs = new Set<string>()
  for (let index = 0; index < projected.catalog.volumes.length; index += 1) {
    const volume = projected.catalog.volumes[index]
    const expected = projected.volumeCatalogs[index]
    if (volume === undefined || expected === undefined || seenDirs.has(volume.dir)) continue
    seenDirs.add(volume.dir)
    const relative = volumeCatalogPath(volume.dir)
    const read = readCatalogFile(root, relative)
    if (read.kind === 'missing') stale.push({ path: relative, reason: 'missing' })
    else if (read.kind === 'invalid') stale.push({ path: relative, reason: 'invalid' })
    else {
      if (!jsonEqual(read.value, expected)) stale.push({ path: relative, reason: 'differs' })
      volumeValues.set(relative, read.value)
    }
  }

  // Deliberate non-check: a `index.json` under a directory that is not a volume
  // is not judged. Rebuild never deletes files (the manuscript has no second
  // copy), so reporting it as stale would create drift no rebuild can clear.
  return {
    stale,
    ...(rootRead.kind === 'value' ? { rootValue: rootRead.value } : {}),
    volumeValues,
  }
}
