/**
 * The plan's small text and identity helpers: file names, trimming, code-point counts, the
 * per-table tally, the write buffer and the id allocator.
 *
 * WHY IT IS A FILE: every phase of `buildEtlPlan` uses them, they hold the rules that must be
 * identical across phases (a slug rule that differed per table would produce two files that
 * collide on a case-insensitive filesystem), and none of them knows what a legacy row is.
 */

import { createHash } from 'node:crypto'
import type { EtlTable } from './etl-source.js'
import type { EtlWrite } from './etl-plan-types.js'

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

export const UNSAFE_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/gu

/** A portable file name from a title; CJK survives (a Chinese title stays readable in `git diff`). */
export function slugify(value: string, max = 48): string {
  const normalized = value
    .normalize('NFKC')
    .replace(UNSAFE_FILE_CHARS, '-')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
  const trimmed = normalized.replace(/^[-. ]+/u, '').replace(/[-. ]+$/u, '')
  return [...trimmed].slice(0, max).join('').replace(/[-. ]+$/u, '')
}

/** Never empty: an entry whose name is all separators still needs a file. */
export function fileSlug(value: string, fallback: string, max = 48): string {
  const slug = slugify(value, max)
  return slug === '' ? fallback : slug
}

export function normalizeText(value: string): string {
  return value.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n').replace(/\r/gu, '\n')
}

/** Trim outer blank space only: leading indentation is the author's. */
export function trimBlank(value: string): string {
  return normalizeText(value).replace(/^\n+/u, '').replace(/\s+$/u, '')
}

export function codePoints(value: string): number {
  return Array.from(value).length
}

export function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
}

export function pad4(value: number): string {
  return String(value).padStart(4, '0')
}

export function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

export function basenameOf(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const at = normalized.lastIndexOf('/')
  return at === -1 ? normalized : normalized.slice(at + 1)
}

/**
 * The entity id a migrated row publishes.
 *
 * ADR-0014: ids are pinned so a rename never breaks a reference. The legacy row already
 * carries a uuid for everything the old app addressed by uuid — reuse it, so the
 * references we migrate (relations, timeline chapters, foreshadow links) keep pointing at
 * the same entity even if someone renames a file later.
 */
export function entityIdOf(table: EtlTable, legacyId: number, uuid: string | undefined): string {
  return uuid !== undefined && uuid !== '' ? uuid : `lg-${table}-${String(legacyId)}`
}

/** A class's running tally, so `mapped + dropped + lost == legacyRows` is checkable. */
export interface Tally {
  mapped: number
  /** No place in the new model (recorded as a note; not data loss). */
  dropped: number
  /** Had a place and did not land (this is what the ≤1% check measures). */
  lost: number
  notes: string[]
}

export function newTally(): Tally {
  return { mapped: 0, dropped: 0, lost: 0, notes: [] }
}

export interface BuilderState {
  readonly writes: EtlWrite[]
  readonly used: Map<string, number>
}

/** Two legacy rows may want the same file name; the second one gets a deterministic suffix. */
export function uniquePath(state: BuilderState, candidate: string): string {
  const seen = state.used.get(candidate) ?? 0
  state.used.set(candidate, seen + 1)
  if (seen === 0) return candidate
  return `${candidate.replace(/\.md$/u, '')}-${String(seen + 1)}.md`
}

export function pushWrite(
  state: BuilderState,
  table: EtlTable,
  legacyId: number,
  entityId: string,
  path: string,
  text: string,
  chars: number,
): void {
  const finalPath = uniquePath(state, path)
  state.writes.push({
    key: `${table}:${String(legacyId)}`,
    table,
    legacyId,
    entityId,
    path: finalPath,
    text,
    chars,
    sha256: sha256(text),
  })
}
