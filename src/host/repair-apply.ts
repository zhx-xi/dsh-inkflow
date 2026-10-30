/**
 * The apply stage: the only writer of the repair pass, and the only part that
 * needs `confirm: true`.
 *
 * WHY IT IS A FILE: everything here is either a file mutation or bookkeeping for
 * one (stage into the backup package, write, digest, seal). Keeping it out of the
 * plan means the preview path cannot write by accident — the plan module has no
 * import of `io.ts` at all, so "preview writes nothing" is a property of the
 * module graph rather than a promise in a comment.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { digestRelative, newBackupBody, openBackup, sealBackup, stageFile } from './backup.js'
import type { BackupBody, BackupDigest, BackupFileEntry, BackupHandle } from './backup.js'
import { rebuildCatalog } from './catalog.js'
import { parseMarkdown, patchFrontmatter } from './frontmatter.js'
import { removeProjectFile, writeTextAtomic } from './io.js'
import { detectFindings, findingKey } from './repair-detect.js'
import { planRepair } from './repair-plan.js'
import { repairReportMarkdown, writeAuditReport } from './repair-report.js'
import type {
  ApplyOptions,
  RepairAction,
  RepairOutcome,
  RepairPatchEntry,
  RepairResult,
} from './repair-types.js'

interface StepOutcome {
  outcome: RepairOutcome
  entries: BackupFileEntry[]
}

type StageResult =
  | { ok: true; before: BackupDigest | undefined }
  | { ok: false; code: string; message: string }

/**
 * Execute the planned repairs.
 *
 * One action's failure does not abort the rest: each action is a single atomic file
 * write (or a single `removeProjectFile`), so continuing leaves no half-state —
 * unlike a migration, whose steps build one structure together. Every failure is
 * reported and the checks are re-run, so "ok" can never mean "some fixes silently
 * did not land".
 */

export function applyRepair(projectRoot: string, options: ApplyOptions = {}): RepairResult {
  const plan = planRepair(projectRoot, { select: options.select })
  const before = plan.detect

  if (plan.actions.length === 0) {
    return { ok: true, root: plan.root, before, plan, applied: [], cleared: [], remaining: before.findings }
  }

  if (options.confirm !== true) {
    return {
      ok: false,
      root: plan.root,
      before,
      plan,
      applied: [],
      cleared: [],
      remaining: before.findings,
      requiresConfirmation: true,
      error: {
        code: 'REPAIR_REQUIRES_CONFIRMATION',
        message: `nothing was written: ${String(plan.actions.length)} action(s) are planned`,
        hint: 'show the actions to the user, then call again with confirm: true (or narrow the run with `select`)',
        nothingWritten: true,
      },
    }
  }

  const now = options.now ?? new Date()
  const opened = openBackup(plan.root, 'repair', now)
  if (!opened.ok) {
    return {
      ok: false,
      root: plan.root,
      before,
      plan,
      applied: [],
      cleared: [],
      remaining: before.findings,
      error: { code: opened.error.code, message: opened.error.message, ...(opened.error.hint === undefined ? {} : { hint: opened.error.hint }), nothingWritten: true },
    }
  }
  const handle: BackupHandle = opened.value
  const body: BackupBody = newBackupBody()
  const backup = { dir: handle.dir, manifestPath: handle.manifestPath }

  // The package is described before the first change: a crash leaves a journal that
  // says which run it belonged to and that it never finished.
  const described = sealBackup(plan.root, handle, 'repair', body, false, now)
  if (!described.ok) {
    return {
      ok: false,
      root: plan.root,
      before,
      plan,
      applied: [],
      cleared: [],
      remaining: before.findings,
      error: { code: described.error.code, message: described.error.message, nothingWritten: true },
    }
  }

  const applied: RepairOutcome[] = []
  for (const action of plan.actions) {
    const step = runAction(plan.root, handle, action, plan.projections)
    applied.push(step.outcome)
    body.steps.push(`${action.kind} ${action.path}`)
    body.files.push(...step.entries)
  }

  sealBackup(plan.root, handle, 'repair', body, true, now)

  const after = detectFindings(plan.root)
  const beforeKeys = new Set(before.findings.map((finding) => findingKey(finding)))
  const afterKeys = new Set(after.findings.map((finding) => findingKey(finding)))
  const cleared = [...beforeKeys].filter((key) => !afterKeys.has(key)).sort()

  const report = writeAuditReport(
    plan.root,
    `repair-${stampForReport(now)}.md`,
    repairReportMarkdown({ root: plan.root, at: now, backup, before, plan, applied, after, cleared }),
  )

  return {
    ok: applied.every((outcome) => outcome.ok),
    root: plan.root,
    before,
    plan,
    applied,
    backup,
    after,
    cleared,
    remaining: after.findings,
    report: {
      path: report.path,
      written: report.ok,
      ...(report.error === undefined ? {} : { error: report.error }),
    },
  }
}

/** Same shape as `backupStamp`, kept local so the report name cannot drift from the package. */
function stampForReport(at: Date): string {
  const iso = at.toISOString()
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}${iso.slice(20, 23)}Z`
}

function runAction(root: string, handle: BackupHandle, action: RepairAction, projections: readonly string[]): StepOutcome {
  const entries: BackupFileEntry[] = []
  const failed = (code: string, message: string): StepOutcome => ({
    outcome: { action, ok: false, detail: '', error: { code, message } },
    entries,
  })

  const stage = (path: string, required: boolean): StageResult => {
    const staged = stageFile(root, handle, path)
    if (!staged.ok) return { ok: false, code: staged.error.code, message: staged.error.message }
    if (staged.value === undefined && required) {
      return { ok: false, code: 'PATH_NOT_FOUND', message: `${path} does not exist` }
    }
    return { ok: true, before: staged.value }
  }

  try {
    switch (action.kind) {
      case 'patch-frontmatter':
      case 'derive-foreshadow-status':
      case 'reparent-outline': {
        const target = resolve(root, action.path)
        if (!existsSync(target)) return failed('PATH_NOT_FOUND', `${action.path} does not exist`)
        let text: string
        try {
          text = readFileSync(target, 'utf8')
        } catch (cause) {
          return failed('FILE_UNREADABLE', `${action.path} could not be read: ${String(cause)}`)
        }
        const patched = patchText(text, action.patch ?? [])
        if (patched === undefined) {
          return failed('REPAIR_NO_EFFECT', `${action.path} already holds the value this repair would write`)
        }
        const staged = stage(action.path, true)
        if (!staged.ok) return failed(staged.code, staged.message)
        const written = writeTextAtomic(root, action.path, patched.text, { verbatim: true })
        if (!written.ok) return failed(written.error.code, written.error.message)
        const after = digestRelative(root, action.path)
        if (after === undefined) return failed('REPAIR_WRITE_LOST', `${action.path} is gone after the write`)
        entries.push({
          path: action.path,
          change: 'modified',
          ...(staged.before === undefined ? {} : { before: staged.before }),
          after,
        })
        return {
          outcome: { action, ok: true, detail: [...patched.appended, ...patched.replaced].join(', ') || 'rewritten' },
          entries,
        }
      }
      case 'remove-duplicate': {
        const staged = stage(action.path, true)
        if (!staged.ok) return failed(staged.code, staged.message)
        if (staged.before === undefined) {
          return failed('PATH_NOT_FOUND', `${action.path} does not exist`)
        }
        const removed = removeProjectFile(root, action.path)
        if (!removed.ok) return failed(removed.error.code, removed.error.message)
        entries.push({ path: action.path, change: 'removed', before: staged.before })
        return { outcome: { action, ok: true, detail: 'removed (its bytes stay in the backup)' }, entries }
      }
      case 'rebuild-catalog': {
        for (const projection of projections) {
          const staged = stage(projection, false)
          if (!staged.ok) return failed(staged.code, staged.message)
          entries.push({
            path: projection,
            change: staged.before === undefined ? 'created' : 'modified',
            ...(staged.before === undefined ? {} : { before: staged.before }),
            after: staged.before ?? { bytes: 0, sha256: '' },
          })
        }
        const rebuilt = rebuildCatalog(root)
        if (!rebuilt.ok) return failed(rebuilt.error.code, rebuilt.error.message)
        const recorded: BackupFileEntry[] = []
        for (const entry of entries) {
          const after = digestRelative(root, entry.path)
          if (after === undefined) continue
          recorded.push({ ...entry, after })
        }
        return {
          outcome: {
            action,
            ok: true,
            detail: `rebuilt ${String(rebuilt.written.length)} catalog file(s): ${rebuilt.written.join(', ')}`,
          },
          entries: recorded,
        }
      }
    }
  } catch (cause) {
    return failed('REPAIR_FAILED', cause instanceof Error ? cause.message : String(cause))
  }
}

/** The patched text for a set of `key: value` lines, or `undefined` when nothing would change. */
function patchText(text: string, entries: readonly RepairPatchEntry[]): { text: string; appended: string[]; replaced: string[] } | undefined {
  if (entries.length === 0) return undefined
  const values: Record<string, string> = {}
  for (const entry of entries) values[entry.key] = entry.value
  const parsed = parseMarkdown(text)
  if (!parsed.hasFrontmatter) {
    // No block at all: prepend one. Additive — not one byte of the author's text moves.
    const body = text.replace(/^\uFEFF/, '')
    const block = entries.map((entry) => `${entry.key}: ${entry.value}`).join('\n')
    return { text: `---\n${block}\n---\n\n${body}`, appended: entries.map((entry) => entry.key), replaced: [] }
  }
  const patched = patchFrontmatter(text, values)
  if (patched.appended.length === 0 && patched.replaced.length === 0) return undefined
  return { text: patched.text, appended: patched.appended, replaced: patched.replaced }
}
