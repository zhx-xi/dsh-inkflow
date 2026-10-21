/**
 * Which generation of the plugin is RUNNING, and does the disk hold a newer one?
 * (issue #88)
 *
 * THE FAILURE THIS PREVENTS. DSH loads a plugin's `lib/` exactly once, at process
 * start. HMR does not swap an already-loaded plugin, so a `pnpm run build` while
 * DSH is running rewrites the disk but leaves the process executing the previous
 * generation — old panel, old routes, old wording. The user then sees "needs
 * setup" on a perfectly usable book, and "refresh" re-runs the same old code, so
 * refreshing cannot help. Nothing in the old build could say "I am old".
 *
 * TWO INDEPENDENT FACTS ANSWER IT.
 *
 *   - `build` — baked in at BUILD time by `scripts/build.mjs` (esbuild `define`
 *     of `__INKFLOW_BUILD__` = `<git short sha>@<ISO>`) and shipped inside the
 *     bundle. It describes the code this process is executing, and nothing on
 *     disk can change it after the fact.
 *   - `diskBuildTime` — the mtime of the very `lib/index.js` this process loaded,
 *     read at CALL time. It is only a hint: git checkout, a file copy or an
 *     in-flight build all move it, and a junction/symlinked install makes it the
 *     mtime of the checkout rather than of a release artifact.
 *
 * Because mtime is only a hint, the verdict is deliberately ONE-SIDED and
 * TOLERANT: `staleLoadedCode` is true only when the disk file is NEWER than
 * process start by more than `STALE_TOLERANCE_MS`. A missed warning costs one
 * confusing session; a false warning teaches the user to ignore the banner — and
 * a build that races the startup (artifact written a second after the process
 * came up) says nothing about what the process loaded.
 *
 * PATH RESOLUTION. `import.meta.url` is the bundle's own file URL, so it names
 * `lib/index.js` both when the plugin is installed as a real directory under the
 * profile's `node_modules` and when it is a junction to a development checkout:
 * Node resolves the link, and both spellings name the same file, hence the same
 * mtime. Anything that is not a `file:` URL (a test bundle loaded from a `data:`
 * URL, an embedder that inlined the code) degrades to `'unknown'`.
 *
 * NOTHING HERE THROWS. It runs on the `/status` path and inside the status tool:
 * a missing file, an unreadable manifest or an unparseable stamp must cost the
 * user a field, never the panel.
 */

import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Injected by esbuild (`scripts/build.mjs`). A bundle built without the define —
 * a test bundling this file on the fly, an embedder inlining it — sees the
 * identifier as undefined and degrades to `'unknown'` instead of failing to load.
 */
declare const __INKFLOW_BUILD__: string

/** The one sentinel every unknown value uses, so the panel can say "未知". */
export const UNKNOWN_BUILD = 'unknown'

/**
 * How much newer than process start the disk file must be before we call the
 * loaded code stale. Five seconds covers the build/restart overlap: a process
 * that came up while `pnpm run build` was still writing its last file is fresh,
 * not stale.
 */
export const STALE_TOLERANCE_MS = 5_000

/** What the running process can say about its own generation. */
export interface LoadedBuild {
  /** `package.json` version (or the caller's, which is the same value). */
  version: string
  /** The injected stamp, `<git short sha>@<ISO>`; `'unknown'` without a define. */
  build: string
  /** The ISO half of `build`; `'unknown'` when the stamp carries no timestamp. */
  buildTime: string
  /** Process start: `Date.now() - process.uptime() * 1000`, as ISO. */
  loadedAt: string
  /** True only when the disk file is newer than process start + tolerance. */
  staleLoadedCode: boolean
  /** mtime of the `lib/index.js` on disk right now, as ISO; `'unknown'` if unreadable. */
  diskBuildTime: string
}

/**
 * The fifteen-line version of `LoadedBuild` that the channel and the tool carry.
 * `buildTime` stays behind: it is derivable from `build`, and the wire shape is
 * the one the panel renders.
 */
export interface BuildSummary {
  version: string
  build: string
  loadedAt: string
  staleLoadedCode: boolean
  diskBuildTime: string
}

/**
 * Knobs for tests and embedders only: every production call site passes nothing
 * but `{ version }`. The clock, the disk file and the stamp are injectable so the
 * three states can be driven deterministically instead of by sleeping.
 */
export interface LoadedBuildOptions {
  /** Defaults to the `package.json` next to the bundle. */
  version?: string
  /** "Now"; defaults to `Date.now()`. */
  now?: number
  /** Process start in ms; defaults to `now - process.uptime() * 1000`. */
  startedAt?: number
  /** Bundle to stat; defaults to this module's own file. `null` = unreadable. */
  diskFile?: string | null
  /** Stamp override; defaults to the injected `__INKFLOW_BUILD__`. */
  build?: string
}

const INJECTED_BUILD: string = readInjectedBuild()

/**
 * The stamp esbuild wrote into this bundle.
 *
 * A `try`/`catch` rather than `typeof`: with the define applied this block is a
 * plain string literal, and without it the reference throws `ReferenceError`,
 * which is caught — both paths end at a usable `string`.
 */
function readInjectedBuild(): string {
  try {
    return typeof __INKFLOW_BUILD__ === 'string' && __INKFLOW_BUILD__ !== '' ? __INKFLOW_BUILD__ : UNKNOWN_BUILD
  } catch {
    return UNKNOWN_BUILD
  }
}

/** This bundle's own path, or `null` when it is not a file URL. */
function ownBundleFile(): string | null {
  try {
    const url = import.meta.url
    return url.startsWith('file:') ? fileURLToPath(url) : null
  } catch {
    return null
  }
}

function mtimeOf(file: string): number | null {
  try {
    const stats = statSync(file)
    return Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null
  } catch {
    return null
  }
}

function isoOf(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return UNKNOWN_BUILD
  const at = new Date(ms)
  return Number.isNaN(at.getTime()) ? UNKNOWN_BUILD : at.toISOString()
}

/** The ISO half of `<sha>@<ISO>`; `'unknown'` when the stamp has none. */
function buildTimeOf(build: string): string {
  const separator = build.indexOf('@')
  if (separator < 0) return UNKNOWN_BUILD
  const parsed = Date.parse(build.slice(separator + 1))
  return Number.isFinite(parsed) ? isoOf(parsed) : UNKNOWN_BUILD
}

function packageVersion(bundleFile: string | null): string {
  if (bundleFile === null) return UNKNOWN_BUILD
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dirname(bundleFile), '..', 'package.json'), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return UNKNOWN_BUILD
    const version = (parsed as Record<string, unknown>)['version']
    return typeof version === 'string' && version !== '' ? version : UNKNOWN_BUILD
  } catch {
    return UNKNOWN_BUILD
  }
}

/**
 * The staleness rule, stated once.
 *
 * An unreachable disk is NOT evidence: `null` answers `false` (the panel then
 * shows the build stamp with an unknown disk time, which is the honest answer).
 */
export function decideStale(diskMtimeMs: number | null, startedAtMs: number): boolean {
  if (diskMtimeMs === null || !Number.isFinite(diskMtimeMs)) return false
  return diskMtimeMs > startedAtMs + STALE_TOLERANCE_MS
}

/**
 * The projection the channel's `/status`, the status tool and the startup log
 * all read. Pure apart from the stat/read it does when no `diskFile` is given.
 */
export function getLoadedBuild(options: LoadedBuildOptions = {}): LoadedBuild {
  const now = options.now ?? Date.now()
  const startedAt = options.startedAt ?? now - process.uptime() * 1000
  const build = options.build ?? INJECTED_BUILD
  const ownFile = ownBundleFile()
  const diskFile = options.diskFile === undefined ? ownFile : options.diskFile
  const diskMtime = diskFile === null ? null : mtimeOf(diskFile)
  return {
    version: options.version ?? packageVersion(ownFile),
    build,
    buildTime: buildTimeOf(build),
    loadedAt: isoOf(startedAt),
    staleLoadedCode: decideStale(diskMtime, startedAt),
    diskBuildTime: isoOf(diskMtime),
  }
}

/** The wire shape (`/status` `value.build`, the tool's `build`). */
export function summarizeBuild(loaded: LoadedBuild): BuildSummary {
  return {
    version: loaded.version,
    build: loaded.build,
    loadedAt: loaded.loadedAt,
    staleLoadedCode: loaded.staleLoadedCode,
    diskBuildTime: loaded.diskBuildTime,
  }
}
