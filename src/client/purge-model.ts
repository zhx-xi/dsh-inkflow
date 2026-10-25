/**
 * The purge area's pure view model — no React, no network, no IO, so the three
 * decisions the two panels make with it are unit-testable (the rule `architecture.md` §6.2
 * states for every `*-model.ts`).
 *
 * What lives here and why each piece is a decision rather than plumbing:
 *
 *   * **two kinds, one card each** — the review page offers the runs, the proposal page offers
 *     the proposals. `purgedFor` is that split, so neither page has to re-derive "is this mine"
 *     from a string, and a new kind cannot silently appear on both;
 *   * **a missing copy says so** — `present: false` is printed as "副本已不在", not hidden: an
 *     entry whose bytes are gone can still be dropped from the manifest, and hiding it would
 *     leave a row nobody can act on;
 *   * **the request bodies are built here** — `cleanPayload` always sends `confirm: true` (the
 *     panel asks twice; the second click is what builds it) and `restorePayload` sends only the
 *     id, so the browser never names a path (ADR-0008 D4).
 */

import type { InternalResult } from './internal.js'

/** What the area holds, as the panels print it. */
export type PurgedKind = 'review-run' | 'proposal'

export interface PurgedEntry {
  readonly id: string
  readonly kind: string
  readonly target: string
  readonly label: string
  readonly deletedAt: string
  readonly bytes: number
  /** `false` when the copy is gone (hand-cleaned): the row can be dropped, nothing restored. */
  readonly present: boolean
  readonly files: readonly { readonly path: string; readonly bytes: number }[]
}

export interface PurgedValue {
  readonly manifestPath: string
  readonly total: number
  readonly bytes: number
  readonly entries: readonly PurgedEntry[]
}

export const EMPTY_PURGED: PurgedValue = { manifestPath: '', total: 0, bytes: 0, entries: [] }

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function filesOf(value: unknown): { path: string; bytes: number }[] {
  return Array.isArray(value)
    ? value.map((entry) => asRecord(entry)).map((record) => ({ path: str(record['path']), bytes: num(record['bytes']) }))
    : []
}

/** Fold the `GET /purged` envelope (or `undefined`) into what a card needs. */
export function readPurgedValue(raw: unknown): PurgedValue {
  const root = asRecord(raw)
  if (Object.keys(root).length === 0) return EMPTY_PURGED
  const entries = Array.isArray(root['entries'])
    ? (root['entries'] as unknown[]).map((entry) => {
        const record = asRecord(entry)
        return {
          id: str(record['id']),
          kind: str(record['kind']),
          target: str(record['target']),
          label: str(record['label']),
          deletedAt: str(record['deletedAt']),
          bytes: num(record['bytes']),
          present: record['present'] === true,
          files: filesOf(record['files']),
        }
      })
    : []
  return {
    manifestPath: str(root['manifestPath']),
    total: num(root['total']) || entries.length,
    bytes: num(root['bytes']),
    entries: entries.filter((entry) => entry.id !== ''),
  }
}

/** The entries one page owns: the review page offers runs, the proposal page offers proposals. */
export function purgedFor(value: PurgedValue, kind: PurgedKind): readonly PurgedEntry[] {
  return value.entries.filter((entry) => entry.kind === kind)
}

/** `2026-10-25T09:55:01Z · ch-0001 · 运行 … · 120 字节`, or `… · 副本已不在`. */
export function describePurgedEntry(entry: PurgedEntry): string {
  const head = `${entry.deletedAt} · ${entry.label}`
  return entry.present ? `${head} · ${String(entry.bytes)} 字节` : `${head} · 副本已不在（只能从清单里删掉这一行）`
}

/** The two-step confirm's label, so a mis-click cannot move a run out of the panels. */
export function cleanActionLabel(armed: boolean): string {
  return armed ? '确认清理（搬进回收区，可还原）' : '清理'
}

/** `POST /purged/clean`: the second click is the only thing that sends `confirm: true`. */
export function cleanPayload(kind: PurgedKind, target: string): Record<string, unknown> {
  return { kind, target, confirm: true }
}

/** `POST /purged/restore`: an id, never a path — the manifest owns where the bytes came from. */
export function restorePayload(id: string): Record<string, unknown> {
  return { id }
}

/** The area's read path, so both panels ask the same way. */
export const PURGED_PATH = '/purged'

/** The two write paths (one module owns the strings, so a typo cannot half-work). */
export const PURGE_CLEAN_PATH = '/purged/clean'
export const PURGE_RESTORE_PATH = '/purged/restore'

/** The error line for a failed area read: the Host's code, never a bare "failed". */
export function describePurgedError(result: InternalResult<unknown> | null): string | null {
  if (result === null || result.ok) return null
  const error = result.error
  if (error === undefined) return '回收区读取失败'
  return `${error.message ?? '回收区读取失败'}（${error.code}）`
}

/**
 * The message for a refused cleanup or restore, as one line.
 *
 * `PURGE_OPEN_PROPOSAL` and `PURGE_TARGET_EXISTS` are the two the author can actually hit, and
 * both are state, not failure: the sentence says what to do next rather than "operation failed".
 */
export function describePurgedFailure(result: InternalResult<unknown>): string {
  if (result.ok) return ''
  const error = result.error
  if (error === undefined) return '回收区操作失败'
  const hint = error.hint === undefined || error.hint === '' ? '' : ` · ${error.hint}`
  if (error.code === 'PURGE_OPEN_PROPOSAL') return `还没决定的提案不能清理：先逐段决定，再应用或回滚。${hint}`
  if (error.code === 'PURGE_TARGET_EXISTS') return `那个路径又有文件了，所以没有覆盖：先处理它，再还原。${hint}`
  return `${error.message ?? '回收区操作失败'}（${error.code}）${hint}`
}
