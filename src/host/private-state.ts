/**
 * The private state directory (ADR-0012): three helpers its two writers share.
 *
 *   * `<book>/.inkflow/{trash,backup,audit}/` is **not** a content directory — the
 *     gate never requires it, no domain scans it, and `walk()` in `indexer.ts` skips
 *     it because every dot entry is skipped (`indexer.ts:99`).
 *   * Writes go through `resolveWriteTarget` + `writeTextAtomic` like every other
 *     write; the whitelist was widened by exactly these three subdirectories
 *     (`io.ts`, `conventions.ts`).
 *   * `.gitignore` gains `.inkflow/` **when the directory is first used**, not from
 *     the gate: an optional directory must not produce a permanent wizard action for
 *     a book that never deletes anything.
 *
 * Why a module rather than two copies: the recovery bin (#35) and the migration backup
 * (#36) both need the same path shape and the same ignore line, and a second hand-rolled
 * copy of "append this line if missing" is how two writers end up disagreeing about
 * whether the file keeps its trailing newline.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PRIVATE_STATE_DIR, PRIVATE_STATE_IGNORE_LINE, PRIVATE_STATE_SUBDIRS } from './conventions.js'
import type { PrivateStateSubdir } from './conventions.js'

/** `.inkflow/<sub>` as a project-relative path (forward slashes). */
export function privateStateDirRelative(sub: PrivateStateSubdir): string {
  return `${PRIVATE_STATE_DIR}/${sub}`
}

/**
 * The project-relative write target for a copy kept under `<sub>`.
 *
 * `relativePath` is what the copy preserves — typically the original project-relative
 * path of the file being removed (so `.inkflow/trash/chapters/vol-01/0001-a.md` says
 * where it came from without reading a manifest). Leading slashes and `..` are refused
 * by `resolveWriteTarget` downstream; this function does not sanitise, it only composes.
 */
export function privateStateRelative(sub: PrivateStateSubdir, relativePath: string): string {
  return `${privateStateDirRelative(sub)}/${relativePath.replace(/^\/+/, '')}`
}

/** Whether a project-relative path lives under `.inkflow/` (any subdirectory). */
export function isPrivateStatePath(relativePath: string): boolean {
  const normalised = relativePath.replaceAll('\\', '/')
  return normalised === PRIVATE_STATE_DIR || normalised.startsWith(`${PRIVATE_STATE_DIR}/`)
}

/**
 * Make sure `.gitignore` ignores the private state directory (ADR-0012).
 *
 * Append-only, same discipline as the wizard: existing lines keep their content and
 * order, and an existing file keeps its trailing newline. Best-effort on purpose — a
 * delete must not fail because `.gitignore` is read-only, so the caller reports
 * `added: false` and the recovered copy still lands on disk.
 */
export function ensurePrivateStateIgnored(root: string): { ok: boolean; added: boolean; error?: string } {
  const file = join(root, '.gitignore')
  let existing = ''
  try {
    existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  } catch (cause) {
    return { ok: false, added: false, error: `cannot read .gitignore: ${String(cause)}` }
  }
  // Accept the harmless spellings of the same rule, so a hand-written `.gitignore`
  // is not appended to forever: `.inkflow/`, `/.inkflow/`, `.inkflow`.
  const spellings = new Set([PRIVATE_STATE_IGNORE_LINE, `/${PRIVATE_STATE_IGNORE_LINE}`, PRIVATE_STATE_DIR])
  const already = existing
    .split('\n')
    .map((line) => line.trim())
    .some((line) => spellings.has(line))
  if (already) return { ok: true, added: false }

  const prefix = existing === '' ? '' : existing.endsWith('\n') ? existing : `${existing}\n`
  try {
    writeFileSync(file, `${prefix}${PRIVATE_STATE_IGNORE_LINE}\n`, 'utf8')
  } catch (cause) {
    return { ok: false, added: false, error: `cannot write .gitignore: ${String(cause)}` }
  }
  return { ok: true, added: true }
}

export { PRIVATE_STATE_DIR, PRIVATE_STATE_SUBDIRS }
