/**
 * The private state's **manifest core** — one implementation of "a JSON list of removals
 * that says what can be put back" (ADR-0012, ADR-0026).
 *
 * There are two manifests in this plugin: the recovery bin's
 * (`.inkflow/trash/index.json` — chapter files the author deleted) and the private
 * purge area's (`.inkflow/purged/index.json` — review runs and closed proposals the
 * author cleaned up). They differ in what an entry means and in what a restore must refuse;
 * they do **not** differ in how a manifest is read back safely.
 *
 * WHY this is shared rather than copied: a manifest is the only thing standing between "the
 * bytes are still on disk" and "the panel can find them again". Two hand-written readers
 * drift on exactly the details that matter and no test notices, because both halves pass
 * their own tests: the schema-version check, "a row with a mistyped field is refused instead
 * of half-understood", "a broken manifest is never silently rebuilt", the io error code
 * passing through, and the "log with `{code,message}` and the underlying io failure" shape
 * that callers render. That list is what lives here; `parse` is the only per-caller part.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN: whether a path may be restored (trash refuses anything
 * under `.inkflow/`, the purge area allows exactly `.inkflow/{review,proposals}`), what the
 * entry's fields beyond the manifest's shape are, and any file movement. A caller that asks
 * "is this entry still restorable" is asking its own domain, not this file.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeJsonAtomic } from './io.js'
import type { IoFailure } from './io.js'

/** The error shape every private-state refusal uses (`io.ts`'s failure, kept structured). */
export interface PrivateManifestError {
  code: string
  message: string
  root?: string
  path?: string
  hint?: string
  /** The underlying `io.ts` failure, when the code above came from there. */
  io?: IoFailure
  /** True when the refusal happened before the first byte was written. */
  nothingWritten?: boolean
}

export interface PrivateManifestFailure {
  ok: false
  error: PrivateManifestError
}

export interface PrivateManifestRead<T> {
  ok: true
  entries: T[]
  /** `false` when the manifest file does not exist yet (an untouched area). */
  exists: boolean
}

/** What one manifest's caller must supply. Everything else is the same for both. */
export interface PrivateManifestSpec<T> {
  /** Project-relative manifest path (forward slashes). */
  readonly relative: string
  /** The only `schemaVersion` this build reads and writes; anything else is refused. */
  readonly schemaVersion: number
  /** The refusal code a caller (and its tests) already knows: `TRASH_MANIFEST_INVALID`… */
  readonly invalidCode: string
  /** What the file is called in messages ("the recovery-bin manifest"). */
  readonly label: string
  /** Why a row could not be read, appended to the file name in the message. */
  readonly entryProblem: string
  /** What to do about a manifest that is not JSON: move it aside, the area stays untouched. */
  readonly brokenHint: string
  /** One row, or `undefined` when any field is missing or mistyped. */
  readonly parse: (raw: unknown) => T | undefined
}

export function privateManifestFailure(
  code: string,
  message: string,
  extra: Omit<PrivateManifestError, 'code' | 'message'> = {},
): PrivateManifestFailure {
  return { ok: false, error: { code, message, ...extra } }
}

/** From an `io.ts` refusal, keeping its code so a caller can tell *why* it refused. */
export function privateManifestIoFailure(
  error: IoFailure,
  message: string,
  extra: Omit<PrivateManifestError, 'code' | 'message' | 'io'> = {},
): PrivateManifestFailure {
  return { ok: false, error: { code: error.code, message, io: error, ...extra } }
}

export function digestBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Absolute path of a project-relative path; forward slashes are the wire form. */
export function absoluteOf(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'))
}

/**
 * The project-relative form of a path, or `undefined` when it names something that is not a
 * plain file inside the project (`..`, an absolute path, an empty segment).
 *
 * `io.ts` re-checks this for a write; a source is read directly (and a manifest row is
 * trusted by nothing), so the check happens here as well.
 */
export function plainRelativePath(value: string): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const normalised = value.replaceAll('\\', '/').replace(/^\/+/, '')
  const segments = normalised.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined
  if (/^[A-Za-z]:/.test(normalised)) return undefined
  return normalised
}

/**
 * Read one manifest.
 *
 * A file this build cannot read is a refusal for every operation, never an empty list:
 * rebuilding it would silently forget entries the author may still need. The one exception
 * is a manifest that is not there at all, which is the normal state of an unused area.
 */
export function readPrivateManifest<T>(root: string, spec: PrivateManifestSpec<T>): PrivateManifestRead<T> | PrivateManifestFailure {
  const file = absoluteOf(root, spec.relative)
  if (!existsSync(file)) return { ok: true, entries: [], exists: false }

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (cause) {
    return privateManifestFailure(spec.invalidCode, `${spec.label} could not be read: ${String(cause)}`, {
      root,
      path: spec.relative,
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return privateManifestFailure(spec.invalidCode, `${spec.relative} is not JSON`, {
      root,
      path: spec.relative,
      hint: spec.brokenHint,
    })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return privateManifestFailure(spec.invalidCode, `${spec.relative} is not a JSON object`, { root, path: spec.relative })
  }
  const record = parsed as Record<string, unknown>
  if (record['schemaVersion'] !== spec.schemaVersion) {
    return privateManifestFailure(spec.invalidCode, `${spec.relative} has schemaVersion ${String(record['schemaVersion'])}; this build writes ${spec.schemaVersion}`, {
      root,
      path: spec.relative,
    })
  }
  const rawEntries = record['entries']
  if (!Array.isArray(rawEntries)) {
    return privateManifestFailure(spec.invalidCode, `${spec.relative} has no \`entries\` array`, { root, path: spec.relative })
  }

  const entries: T[] = []
  for (const raw of rawEntries) {
    const entry = spec.parse(raw)
    if (entry === undefined) {
      return privateManifestFailure(spec.invalidCode, `${spec.relative} ${spec.entryProblem}`, { root, path: spec.relative })
    }
    entries.push(entry)
  }
  return { ok: true, entries, exists: true }
}

export function writePrivateManifest<T>(
  root: string,
  spec: PrivateManifestSpec<T>,
  entries: readonly T[],
): { ok: true } | PrivateManifestFailure {
  const written = writeJsonAtomic(root, spec.relative, { schemaVersion: spec.schemaVersion, entries })
  if (!written.ok) {
    return privateManifestIoFailure(written.error, `${spec.label} could not be written: ${written.error.message}`, {
      path: spec.relative,
    })
  }
  return { ok: true }
}

/** A required, non-empty string field of a manifest row, or `undefined`. */
export function manifestText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** A required byte count (`>= 0`), or `undefined`. */
export function manifestBytes(record: Record<string, unknown>, key = 'bytes'): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

