/**
 * The shared library's Host half: a **read-only** projection of
 * `dataDir/shared` (ADR-0010 D5, issue #87; the directory layout is ADR-0007 C1).
 *
 * WHY IT LIVES BESIDE `hub.ts` INSTEAD OF INSIDE IT: the book hub projects the
 * workspace registry (books, judged per directory). The shared library is the one
 * thing the hub shows that belongs to *no* book — it is a plugin-level directory,
 * so nothing here can be anchored to a session, a workspace or a request field.
 * The root is `config.ts`'s data dir + `shared/` and nothing else (ADR-0010 D5:
 * "不接受任何路径参数"), which is also why the route takes no path parameter.
 *
 * TWO DATA SOURCES, ONE MEANING (ADR-0010 D5, ADR-0007 C1):
 *
 *   1. `shared/index.json` is a **derived manifest**. When its entry list agrees
 *      with the directory (same path set, every path inside the four kind
 *      directories, valid ids/hashes) it answers the request and
 *      `indexSource: 'index'` says so.
 *   2. Otherwise the four directories are scanned **in memory**: name, kind,
 *      relative path, a real `sha256` and the entry's tags are recomputed. The
 *      answer is `indexSource: 'scan'`, and the manifest is left alone — writing
 *      it back is #40's job, and this module has no write path at all.
 *
 * The manifest is NOT verified byte-for-byte against the files: doing that means
 * hashing every entry on every open, which is exactly the first-paint cost
 * ADR-0010 D8 caps. The criterion is the path set plus entry validity; content
 * staleness is reported only by whoever recomputes hashes (the scan).
 *
 * COST (ADR-0010 D8 discipline, constants below): at most `SHARED_MAX_ENTRIES`
 * files are considered, `SHARED_SCAN_BUDGET_MS` bounds the work, and only
 * directory entries plus one bounded head read and one bounded hash per file are
 * touched — never the whole library at once. Missing a limit sets
 * `truncated: true` instead of pretending the list is complete. All three limits
 * are injectable so the tests stay deterministic instead of sleeping.
 *
 * WRITE DISCIPLINE: this module only reads. A library that does not exist answers
 * `created: false` — empty, not an error — and is never created; the tests assert
 * it with a whole-tree hash (`hashTree`).
 */

import { createHash } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

import { SHARED_INDEX_FILE, SHARED_KINDS } from './conventions.js'
import type { SharedKind } from './conventions.js'
import { isWithin, realpathLoose } from './project.js'

/** Files considered in one answer; beyond this the answer is `truncated`. */
export const SHARED_MAX_ENTRIES = 250

/** Wall-clock budget for one scan; exhausting it returns what is done + `truncated`. */
export const SHARED_SCAN_BUDGET_MS = 1_500

/** Largest file whose `sha256` is computed; a bigger one is listed without a hash. */
export const SHARED_MAX_HASH_BYTES = 8 * 1024 * 1024

/** Bytes read from a `.md` head to find `entryId`/`tags` (frontmatter only). */
export const SHARED_HEAD_BYTES = 4 * 1024

/** A `.json` entry is parsed for ids/tags only when it is this small. */
export const SHARED_MAX_JSON_BYTES = 64 * 1024

/** The manifest is a cache: anything bigger than this is not one we wrote. */
export const SHARED_MAX_INDEX_BYTES = 1024 * 1024

/** How deep a kind directory may nest (`world/<category>/<slug>.md` is 2). */
export const SHARED_MAX_DEPTH = 6

/** One entry of `shared/index.json`, as this projection reports it. */
export type SharedEntry = {
  /** `sh-<8 hex>`: authored in the file/manifest, or derived from the path. */
  entryId: string
  kind: SharedKind
  /** POSIX-style path relative to `shared/` (never absolute, never `..`). */
  path: string
  /** Real content hash; absent when the file is too large or unreadable. */
  sha256?: string
  tags?: string[]
  /** True when the file carries no `entryId`, so this one was derived from `path`. */
  entryIdDerived?: true
}

/** `{ok:true,value}` payload of `GET /inkflow/internal/hub/shared`. */
export type HubSharedValue = {
  /** `false` = the shared library does not exist yet: empty, never an error. */
  created: boolean
  /** `'index'` = the derived manifest answered; `'scan'` = scanned in memory. */
  indexSource: 'index' | 'scan'
  /** Kinds present in the library, in canonical order. */
  kinds: SharedKind[]
  /** Entries after the `kind`/`q` filters. */
  entries: SharedEntry[]
  /** Per-kind counts over the WHOLE library, so a filter never changes them. */
  countsByKind: Record<string, number>
  /** Number of entries in this answer (after filters, after the cap). */
  total: number
  /** True when the entry cap or the time budget cut the answer short. */
  truncated: boolean
}

export type HubSharedError = { code: 'SHARED_UNAVAILABLE'; message: string; hint: string }

export type HubSharedResult = { ok: true; value: HubSharedValue } | { ok: false; error: HubSharedError }

/** Test seams (and future tuning). Production callers pass the route's query. */
export interface HubSharedOptions {
  /** `kind` from the URL; anything outside the whitelist matches nothing. */
  kind?: string | undefined
  /** Case-insensitive substring match over the entry path. */
  q?: string | undefined
  maxEntries?: number
  budgetMs?: number
  maxHashBytes?: number
  /** Clock seam: the budget tests advance it instead of sleeping. */
  now?: () => number
}

const UNAVAILABLE: HubSharedError = {
  code: 'SHARED_UNAVAILABLE',
  message: 'the plugin data directory is not resolvable, so the shared library cannot be named',
  hint: 'the shared library lives under the plugin data directory (dataDir/shared); check the InkFlow plugin configuration',
}

/** One walked file, before any file content is touched. */
interface WalkedFile {
  kind: SharedKind
  path: string
}

interface WalkResult {
  files: WalkedFile[]
  truncated: boolean
}

interface Limits {
  deadline: number
  now: () => number
  maxEntries: number
  maxHashBytes: number
}

/** The identity a single entry file carries itself (frontmatter or series JSON). */
interface EntryMeta {
  entryId?: string
  tags?: string[]
}

/**
 * Project the shared library.
 *
 * `sharedRoot` is `config.ts`'s `sharedDir(dataDir)` — the ONLY source of that
 * path. Never throws: an unusable root answers `SHARED_UNAVAILABLE` (HTTP 200 +
 * `ok:false`: "cannot answer", not a transport failure).
 */
export function buildHubShared(sharedRoot: string | undefined, options: HubSharedOptions = {}): HubSharedResult {
  const root = typeof sharedRoot === 'string' ? sharedRoot.trim() : ''
  if (root === '' || !isAbsolute(root)) return { ok: false, error: UNAVAILABLE }

  const now = options.now ?? Date.now
  const limits: Limits = {
    // One deadline for the whole answer. It is checked between files, so a huge
    // library costs a bounded amount and says `truncated` about the rest.
    deadline: now() + Math.max(1, options.budgetMs ?? SHARED_SCAN_BUDGET_MS),
    now,
    maxEntries: Math.max(1, options.maxEntries ?? SHARED_MAX_ENTRIES),
    maxHashBytes: Math.max(0, options.maxHashBytes ?? SHARED_MAX_HASH_BYTES),
  }

  // Canonical root: a symlinked data dir must not make "inside shared/" mean
  // something else than it does for `isWithin` below.
  const realRoot = realpathLoose(root)
  if (!isDirectory(realRoot)) return { ok: true, value: emptyValue(false) }

  const walked = walkKinds(realRoot, limits)
  const fromManifest = walked.truncated ? undefined : readManifest(realRoot, walked.files)

  let entries: SharedEntry[]
  let source: 'index' | 'scan'
  let truncated = walked.truncated
  if (fromManifest !== undefined) {
    entries = fromManifest
    source = 'index'
  } else {
    const scanned = scanEntries(realRoot, walked.files, limits)
    entries = scanned.entries
    source = 'scan'
    truncated = truncated || scanned.truncated
  }

  return { ok: true, value: present(entries, source, truncated, options) }
}

// ---------------------------------------------------------------------------
// The directory walk: names only, bounded, containment-checked
// ---------------------------------------------------------------------------

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * List the files under the four kind directories.
 *
 * Only directory entries and `stat` are used here — no file content — so the walk
 * itself is cheap even for a large library. Three rules, all enforced in ONE
 * place so no branch can drift from them (ADR-0010 D5):
 *
 *   1. CONTAINMENT — a child's real path must stay inside `shared/`. This is what
 *      refuses `..`, absolute paths and a link/junction pointing outside; the same
 *      gate decides whether a directory may be descended into, so a linked tree
 *      outside the library can never be browsed through the hop.
 *   2. NO CYCLES — a real directory is descended into once (`visited`), so a link
 *      back into the library cannot hang the walk.
 *   3. FILES ONLY — only regular files become entries; a socket, device or a
 *      directory-shaped link that survived containment is not an entry.
 */
function walkKinds(root: string, limits: Limits): WalkResult {
  const files: WalkedFile[] = []
  const visited = new Set<string>([root])
  for (const kind of SHARED_KINDS) {
    const base = join(root, kind)
    if (!isDirectory(base)) continue
    const stack: string[] = [kind]
    while (stack.length > 0) {
      if (limits.now() >= limits.deadline) return { files, truncated: true }
      const relative = stack.pop()
      if (relative === undefined) break
      const absolute = join(root, ...relative.split('/'))
      let dirents
      try {
        dirents = readdirSync(absolute, { withFileTypes: true })
      } catch {
        continue
      }
      // Sorted so two runs answer in the same order before the final sort.
      dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const dirent of dirents) {
        if (files.length >= limits.maxEntries) return { files, truncated: true }
        const child = `${relative}/${dirent.name}`
        const real = realpathLoose(join(absolute, dirent.name))
        if (!isWithin(root, real)) continue
        let info
        try {
          info = statSync(real)
        } catch {
          continue
        }
        if (info.isDirectory()) {
          if (!visited.has(real) && child.split('/').length <= SHARED_MAX_DEPTH) {
            visited.add(real)
            stack.push(child)
          }
          continue
        }
        if (!info.isFile()) continue
        files.push({ kind, path: child })
      }
    }
  }
  return { files, truncated: false }
}

// ---------------------------------------------------------------------------
// Source 1: the derived manifest
// ---------------------------------------------------------------------------

/**
 * The manifest's entries, or `undefined` when it cannot be trusted.
 *
 * "Cannot be trusted" is a single yes/no on purpose (ADR-0010 D5: "缺失或与文件
 * 不一致时在内存里扫目录重算"): a partially usable manifest would answer a list
 * that is neither the manifest's nor the directory's. The checks are the ones the
 * hub itself must enforce — a manifest is a file like any other, so a hand-edited
 * one may name `../` or an absolute path, and those must be refused even here.
 */
function readManifest(root: string, files: readonly WalkedFile[]): SharedEntry[] | undefined {
  const target = join(root, SHARED_INDEX_FILE)
  let raw: string
  try {
    const info = statSync(target)
    if (!info.isFile() || info.size > SHARED_MAX_INDEX_BYTES) return undefined
    raw = readFileSync(target, 'utf8')
  } catch {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(raw))
  } catch {
    return undefined
  }
  const list = asRecord(parsed)?.['entries']
  if (!Array.isArray(list)) return undefined

  const onDisk = new Set(files.map((file) => file.path))
  const seen = new Set<string>()
  const entries: SharedEntry[] = []
  for (const item of list) {
    const record = asRecord(item)
    if (record === undefined) return undefined
    const entryId = nonEmptyString(record['entryId'])
    const kind = nonEmptyString(record['kind'])
    const path = nonEmptyString(record['path'])
    if (entryId === undefined || kind === undefined || path === undefined) return undefined
    if (!isSharedKind(kind)) return undefined
    if (pathProblem(path, kind) !== undefined) return undefined
    // The manifest may only describe files the walk actually found inside
    // `shared/`, and each one once.
    if (!onDisk.has(path) || seen.has(path)) return undefined
    seen.add(path)
    const sha256 = hexDigest(record['sha256'])
    const tags = tagList(record['tags'])
    entries.push({
      entryId,
      kind,
      path,
      ...(sha256 === undefined ? {} : { sha256 }),
      ...(tags === undefined ? {} : { tags }),
    })
  }
  // A file the manifest does not know means it is stale: rescan, never append.
  if (seen.size !== onDisk.size) return undefined
  return entries
}

// ---------------------------------------------------------------------------
// Source 2: the in-memory rescan
// ---------------------------------------------------------------------------

/**
 * Recompute the list from the files themselves.
 *
 * Per file: one bounded head read (frontmatter / small JSON) for identity, and
 * one bounded hash for `sha256`. A file too large to hash is still listed without
 * a hash — a missing field beats a fabricated one.
 */
function scanEntries(
  root: string,
  files: readonly WalkedFile[],
  limits: Limits,
): { entries: SharedEntry[]; truncated: boolean } {
  const entries: SharedEntry[] = []
  let truncated = false
  for (const file of files) {
    if (limits.now() >= limits.deadline) {
      truncated = true
      break
    }
    const absolute = join(root, ...file.path.split('/'))
    const meta = readEntryMeta(absolute)
    const sha256 = hashFile(absolute, limits.maxHashBytes)
    entries.push({
      entryId: meta.entryId ?? derivedEntryId(file.path),
      kind: file.kind,
      path: file.path,
      ...(sha256 === undefined ? {} : { sha256 }),
      ...(meta.tags === undefined ? {} : { tags: meta.tags }),
      ...(meta.entryId === undefined ? { entryIdDerived: true as const } : {}),
    })
  }
  return { entries, truncated }
}

/** The id/tags a single entry file carries. Never throws: no file, no meta. */
function readEntryMeta(absolute: string): EntryMeta {
  if (absolute.toLowerCase().endsWith('.json')) {
    try {
      if (statSync(absolute).size > SHARED_MAX_JSON_BYTES) return {}
      const record = asRecord(JSON.parse(stripBom(readFileSync(absolute, 'utf8'))))
      if (record === undefined) return {}
      return { entryId: nonEmptyString(record['entryId']), tags: tagList(record['tags']) }
    } catch {
      return {}
    }
  }
  const values = parseFrontmatter(readHead(absolute, SHARED_HEAD_BYTES))
  return { entryId: nonEmptyString(values['entryId']), tags: parseTags(values['tags']) }
}

function readHead(absolute: string, bytes: number): string {
  let fd: number | undefined
  try {
    fd = openSync(absolute, 'r')
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * The top-level `key: value` pairs of a YAML frontmatter block.
 *
 * Deliberately small: the hub needs `entryId` and `tags` to *label* a row, not a
 * full YAML parser (the plugin has no runtime dependency by design). Anything it
 * cannot read is simply absent, which the type already allows.
 */
function parseFrontmatter(head: string): Record<string, string> {
  const lines = stripBom(head).split(/\r?\n/u)
  if (lines[0]?.trim() !== '---') return {}
  const values: Record<string, string> = {}
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/u.exec(line.trim())
    if (match === null) continue
    const key = match[1]
    const value = match[2]
    if (key === undefined || value === undefined) continue
    values[key] = value.trim()
  }
  return values
}

/** `[a, b]` or `a, b` → `['a','b']`; empty values mean "no tags", not "empty tags". */
function parseTags(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const inner = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  const tags = inner
    .split(',')
    .map((tag) => tag.trim().replace(/^["']|["']$/gu, '').trim())
    .filter((tag) => tag !== '')
  return tags.length === 0 ? undefined : tags
}

function hashFile(absolute: string, maxBytes: number): string | undefined {
  try {
    const info = statSync(absolute)
    if (!info.isFile() || info.size > maxBytes) return undefined
    return createHash('sha256').update(readFileSync(absolute)).digest('hex')
  } catch {
    return undefined
  }
}

/** `sh-<8 hex of the path>`: stable for a path, and explicitly flagged as derived. */
function derivedEntryId(path: string): string {
  return `sh-${createHash('sha256').update(path).digest('hex').slice(0, 8)}`
}

// ---------------------------------------------------------------------------
// Assembly: filters, counts, ordering
// ---------------------------------------------------------------------------

function present(
  entries: readonly SharedEntry[],
  indexSource: 'index' | 'scan',
  truncated: boolean,
  options: HubSharedOptions,
): HubSharedValue {
  const countsByKind: Record<string, number> = {}
  for (const entry of entries) countsByKind[entry.kind] = (countsByKind[entry.kind] ?? 0) + 1

  const kindFilter = isSharedKind(options.kind) ? options.kind : undefined
  const needle = (options.q ?? '').trim().toLowerCase()
  const filtered = entries.filter((entry) => {
    if (kindFilter !== undefined && entry.kind !== kindFilter) return false
    if (needle === '') return true
    return entry.path.toLowerCase().includes(needle)
  })
  filtered.sort(
    (a, b) => SHARED_KINDS.indexOf(a.kind) - SHARED_KINDS.indexOf(b.kind) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  )

  return {
    created: true,
    indexSource,
    kinds: SHARED_KINDS.filter((kind) => (countsByKind[kind] ?? 0) > 0),
    entries: filtered,
    countsByKind,
    total: filtered.length,
    truncated,
  }
}

function emptyValue(created: boolean): HubSharedValue {
  return { created, indexSource: 'scan', kinds: [], entries: [], countsByKind: {}, total: 0, truncated: false }
}

/**
 * Why a manifest path may not be browsed, or `undefined` when it may.
 *
 * ADR-0010 D5 turns this into three refusals: `..` segments, absolute paths, and
 * anything outside the entry's own kind directory (so a `world` entry cannot
 * point into `series/`, and nothing can point at `index.json`).
 */
function pathProblem(path: string, kind: SharedKind): string | undefined {
  if (path.includes('\\')) return 'separator'
  if (path.startsWith('/') || /^[A-Za-z]:/u.test(path)) return 'absolute'
  const segments = path.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return 'segment'
  if (segments[0] !== kind) return 'kind'
  // Same depth rule as the walk: a path the walk could never produce is refused,
  // or the manifest and the directory would disagree by construction.
  if (segments.length > SHARED_MAX_DEPTH) return 'depth'
  return undefined
}

function isSharedKind(value: unknown): value is SharedKind {
  return typeof value === 'string' && (SHARED_KINDS as readonly string[]).includes(value)
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** A `sha256` is kept only when it really is one; anything else is dropped. */
function hexDigest(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value) ? value : undefined
}

function tagList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tags = value
    .map((tag) => (typeof tag === 'string' ? tag.trim() : ''))
    .filter((tag) => tag !== '')
  return tags.length === 0 ? undefined : tags
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}
