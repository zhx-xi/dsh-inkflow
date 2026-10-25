/**
 * Search-and-replace over chapter prose (roadmap X-17).
 *
 * X-17 is the batch-write contract, and this file is its worked example: a batch
 * change is **preview = execution**, it takes a rollback package, and it can be
 * undone byte for byte.
 *
 * The four properties, each one a decision rather than an implementation detail:
 *
 *   1. **Preview is the same computation as execution.** Both call [`planReplace`]:
 *      it walks the chapter list, reads each file, counts what it would change and
 *      renders the exact new text. The preview then throws the text away; `apply`
 *      writes it. "What you saw" is therefore not a second implementation that
 *      drifted, it is literally the same plan.
 *   2. **Nothing is silent.** `apply` names every file it touched and every file it
 *      refused, with a reason. A chapter whose hit count no longer matches the
 *      preview is `PREVIEW_STALE` and is skipped: the author's newer text always wins
 *      over a stale plan.
 *   3. **The file's own format survives.** A chapter written with CRLF stays CRLF and
 *      a BOM stays a BOM: the style is detected on the raw bytes and re-applied by the
 *      one text writer (`text-style.ts` through `io.ts`), never re-invented here.
 *   4. **A batch is undoable.** The rollback package (`backup.ts`) is opened and
 *      sealed *before* the first write, so an interrupted run leaves a journal, and a
 *      failure rolls back through it — the restore is verified against digests, so
 *      "rolled back" means byte-identical, not "probably fine".
 *
 * Why the chapter list comes from the catalog and not from the index: the preview has
 * to work when the index is missing or stale (it is a cache), and a plan built on a
 * stale cache would count the wrong number of places to edit. The catalog is a
 * projection of the files themselves (`catalog.ts`), so it is always current.
 *
 * Scope: chapter prose only. Replacing inside a setting-library entry needs a
 * per-kind writer that understands that kind's structure — a different job, refused
 * loudly (`KIND_INVALID`) rather than guessed at here.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { digestRelative, newBackupBody, openBackup, rollbackBackup, sealBackup, stageFile } from './backup.js'
import type { BackupBody, BackupHandle } from './backup.js'
import { readCatalog } from './catalog.js'
import type { CatalogChapter } from './catalog.js'
import { writeTextAtomic } from './io.js'
import { escapeRegExp, sliceContext } from './snippet.js'
import { detectTextStyle } from './text-style.js'
import type { TextStyle } from './text-style.js'

/** Characters of context kept before and after an occurrence in a preview row. */
export const REPLACE_CONTEXT_CHARS = 30

/** Kinds this batch writer may edit. Chapter prose only for now (X-17's sample). */
export const REPLACE_KINDS = ['chapters'] as const

export interface ReplaceRequest {
  /** The literal text to look for (case-insensitive, like every search in the product). */
  readonly query: string
  /** What replaces each occurrence. Literal: `$&` and friends mean nothing here. */
  readonly replacement: string
  /** Defaults to `['chapters']`; any other kind is refused rather than guessed. */
  readonly kinds?: readonly string[]
  /** Characters of context in a preview row (default 30). */
  readonly context?: number
}

/** One file the batch would change (preview) or did change (apply). */
export interface ReplaceHit {
  readonly chapterId: string
  readonly path: string
  readonly title: string
  /** Occurrences of `query` in the current text. */
  readonly count: number
  /** Context around the first occurrence, as the file reads now. */
  readonly before: string
  /** Context around the replacement, as the file reads afterwards. */
  readonly after: string
}

export interface ReplacePreviewSuccess {
  ok: true
  query: string
  replacement: string
  kinds: readonly string[]
  /** Files with at least one occurrence, in reading order. */
  items: ReplaceHit[]
  /** How many files the plan covers — `expected.length` for a matching `apply`. */
  total: number
}

export interface ReplaceFailure {
  ok: false
  code: string
  message: string
  hint?: string
  path?: string
}

export type ReplacePreviewResult = ReplacePreviewSuccess | ReplaceFailure

/** What the preview said, handed back to `apply` so a stale plan cannot write. */
export interface ReplaceExpectation {
  readonly chapterId: string
  readonly count: number
}

export interface ReplaceApplyRequest extends ReplaceRequest {
  /** The hit set from a preview: `[{ chapterId, count }]`. */
  readonly expected: readonly ReplaceExpectation[]
  /** Required: this rewrites files. */
  readonly confirm?: boolean
}

export type ReplaceSkipReason = 'PREVIEW_STALE' | 'NOT_IN_PREVIEW' | 'GONE' | 'WRITE_FAILED'

export interface ReplaceSkipped {
  readonly chapterId: string
  readonly path: string
  readonly reason: ReplaceSkipReason
  readonly expected: number
  readonly actual: number
  readonly detail?: string
}

export interface ReplaceApplySuccess {
  ok: true
  query: string
  replacement: string
  /** The rollback package this batch opened; absent when nothing needed writing. */
  backup?: { dir: string; manifestPath: string }
  /** Files rewritten, with the occurrence count that was replaced in each. */
  written: ReplaceHit[]
  /** Files the batch left alone, each with its reason. */
  skipped: ReplaceSkipped[]
  /** True when a failure forced the batch back through the backup package. */
  rolledBack: boolean
  /** Occurrences replaced across every written file. */
  replaced: number
}

export interface ReplaceApplyFailure extends ReplaceFailure {
  /** Present once a package was opened: the address the author can roll back by hand. */
  backup?: { dir: string; manifestPath: string }
  written?: readonly ReplaceHit[]
  skipped?: readonly ReplaceSkipped[]
  rolledBack?: boolean
}

export type ReplaceApplyResult = ReplaceApplySuccess | ReplaceApplyFailure

/**
 * One compiled matcher per request, so counting and replacing can never disagree.
 *
 * Case-insensitive and Unicode-aware, matching what search does: an author who
 * searched 清音 and saw four hits must not get three replacements because one of them
 * was written in another case. The replacement is applied through a function, so `$&`
 * and `$1` inside it are literal text rather than pattern syntax.
 */
function matcherFor(query: string): RegExp {
  return new RegExp(escapeRegExp(query), 'giu')
}

/** A chapter as the plan sees it: the bytes on disk plus the style they were written in. */
interface ChapterFile {
  readonly chapter: CatalogChapter
  /** LF, no BOM — what the counting runs on. */
  readonly text: string
  /** The file's own terminator/BOM, re-applied by the writer. */
  readonly style: TextStyle
}

function normalizeForCount(raw: string): string {
  return (raw.startsWith('\uFEFF') ? raw.slice(1) : raw).replace(/\r\n?/gu, '\n')
}

function countOf(matcher: RegExp, text: string): number {
  matcher.lastIndex = 0
  let count = 0
  while (matcher.exec(text) !== null) {
    count += 1
    // A zero-length match cannot advance `lastIndex`; `query` is never empty here.
    if (matcher.lastIndex === 0) break
  }
  return count
}

/** What one chapter would become; it is only in the plan when `count > 0`. */
interface ChapterPlan {
  readonly file: ChapterFile
  readonly count: number
  readonly nextText: string
  /** Offset of the first occurrence in the current text (for the `before` context). */
  readonly firstAt: number
  readonly context: number
}

function chapterFilesOf(root: string): { ok: true; files: ChapterFile[] } | ReplaceFailure {
  const catalog = readCatalog(root)
  // Reading order: volumes in order with their chapters, then the loose chapters —
  // the same order the panel and the chapter tools show.
  const chapters: CatalogChapter[] = [
    ...catalog.volumeCatalogs.flatMap((volume) => volume.chapters),
    ...catalog.catalog.looseChapters,
  ]
  const files: ChapterFile[] = []
  for (const chapter of chapters) {
    let raw: string
    try {
      raw = readFileSync(join(root, ...chapter.file.split('/')), 'utf8')
    } catch (cause) {
      return {
        ok: false,
        code: 'CHAPTER_UNREADABLE',
        message: `${chapter.file} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
        path: chapter.file,
      }
    }
    files.push({ chapter, text: normalizeForCount(raw), style: detectTextStyle(raw) })
  }
  return { ok: true, files }
}

/** Reject an empty query, an unknown kind or a non-string replacement *before* touching a file. */
function validate(request: ReplaceRequest): ReplaceFailure | undefined {
  if (typeof request.query !== 'string' || request.query === '') {
    return {
      ok: false,
      code: 'QUERY_INVALID',
      message: 'query must be a non-empty string',
      hint: 'pass the literal text to look for; use action preview first, then apply',
    }
  }
  if (typeof request.replacement !== 'string') {
    return { ok: false, code: 'QUERY_INVALID', message: 'replacement must be a string', hint: 'pass "" to delete the matches' }
  }
  const kinds = request.kinds ?? REPLACE_KINDS
  if (!Array.isArray(kinds) || kinds.length === 0) {
    return {
      ok: false,
      code: 'KIND_INVALID',
      message: 'kinds must be a non-empty array',
      hint: `this build replaces ${REPLACE_KINDS.join(', ')}`,
    }
  }
  for (const kind of kinds) {
    if (!(REPLACE_KINDS as readonly string[]).includes(kind)) {
      return {
        ok: false,
        code: 'KIND_INVALID',
        message: `kinds ${String(kind)} cannot be replaced`,
        hint: `this build replaces chapter prose only (${REPLACE_KINDS.join(', ')}); replacing inside a setting entry needs a per-kind writer`,
      }
    }
  }
  return undefined
}

/**
 * The single computation behind both halves (X-17's "preview = execution").
 *
 * Reads every chapter, counts the occurrences and renders the new text. It writes
 * nothing, so a preview can never be mistaken for an action.
 */
function planReplace(
  root: string,
  request: ReplaceRequest,
): { ok: true; plans: ChapterPlan[]; context: number } | ReplaceFailure {
  const invalid = validate(request)
  if (invalid !== undefined) return invalid
  const read = chapterFilesOf(root)
  if (!read.ok) return read

  const context = Math.min(Math.max(Math.trunc(request.context ?? REPLACE_CONTEXT_CHARS), 0), 500)
  const matcher = matcherFor(request.query)
  const plans: ChapterPlan[] = []
  for (const file of read.files) {
    matcher.lastIndex = 0
    const first = matcher.exec(file.text)
    if (first === null) continue
    const count = countOf(matcher, file.text)
    plans.push({
      file,
      count,
      nextText: file.text.replace(matcherFor(request.query), () => request.replacement),
      firstAt: first.index,
      context,
    })
  }
  return { ok: true, plans, context }
}

function hitOf(plan: ChapterPlan, request: ReplaceRequest): ReplaceHit {
  // After the replacement the query is gone, so the `after` window is anchored on
  // where the replacement landed rather than re-locating a term that no longer exists.
  const after =
    request.replacement === ''
      ? sliceContext(plan.nextText, plan.firstAt, 0, plan.context)
      : (() => {
          const match = matcherFor(request.replacement).exec(plan.nextText)
          const at = match === null ? plan.firstAt : match.index
          return sliceContext(plan.nextText, at, match === null ? 0 : match[0].length, plan.context)
        })()
  return {
    chapterId: plan.file.chapter.chapterId,
    path: plan.file.chapter.file,
    title: plan.file.chapter.title,
    count: plan.count,
    before: sliceContext(plan.file.text, plan.firstAt, request.query.length, plan.context),
    after,
  }
}

/**
 * What a replace would change — **zero writes**, always.
 *
 * The returned `items` are the `expected` set an `apply` must be given: the pair
 * `(chapterId, count)` per file is what makes a stale plan detectable.
 */
export function replacePreview(root: string, request: ReplaceRequest): ReplacePreviewResult {
  const planned = planReplace(root, request)
  if (!planned.ok) return planned
  const items = planned.plans.map((plan) => hitOf(plan, request))
  return {
    ok: true,
    query: request.query,
    replacement: request.replacement,
    kinds: request.kinds ?? REPLACE_KINDS,
    items,
    total: items.length,
  }
}

/**
 * Replace, behind a rollback package.
 *
 * `confirm: true` is mandatory (a batch that rewrites the manuscript is not a
 * default), and `expected` must come from a preview. A file whose count moved is
 * skipped with `PREVIEW_STALE`; a file with hits the preview did not list is skipped
 * with `NOT_IN_PREVIEW` — the batch writes exactly the set the author saw, and every
 * refusal is reported instead of being applied silently.
 *
 * On a write failure the package is rolled back before returning, so a failure never
 * leaves half a manuscript replaced.
 */
export function replaceApply(root: string, request: ReplaceApplyRequest): ReplaceApplyResult {
  const invalid = validate(request)
  if (invalid !== undefined) return invalid
  if (request.confirm !== true) {
    return {
      ok: false,
      code: 'CONFIRM_REQUIRED',
      message: 'applying a replace rewrites chapter files',
      hint: 'call it with the `expected` set from a preview and confirm: true; the same call without confirm changes nothing',
    }
  }
  if (!Array.isArray(request.expected)) {
    return {
      ok: false,
      code: 'EXPECTED_REQUIRED',
      message: 'expected must be the hit set from a preview',
      hint: 'run action preview first, then pass its items as [{ chapterId, count }]',
    }
  }

  const planned = planReplace(root, request)
  if (!planned.ok) return planned

  const expected = new Map(request.expected.map((item) => [item.chapterId, item.count]))
  const skipped: ReplaceSkipped[] = []
  const toWrite: ChapterPlan[] = []

  // Decide the whole set before the first write: a stale chapter is a refusal to
  // write *that file*, and the decision must not depend on the order of writes.
  for (const plan of planned.plans) {
    const want = expected.get(plan.file.chapter.chapterId)
    if (want === undefined) {
      skipped.push({
        chapterId: plan.file.chapter.chapterId,
        path: plan.file.chapter.file,
        reason: 'NOT_IN_PREVIEW',
        expected: 0,
        actual: plan.count,
        detail: 'this file has hits the preview did not list (preview expired); run the preview again',
      })
      continue
    }
    if (want !== plan.count) {
      skipped.push({
        chapterId: plan.file.chapter.chapterId,
        path: plan.file.chapter.file,
        reason: 'PREVIEW_STALE',
        expected: want,
        actual: plan.count,
        detail: 'the hit count changed since the preview; nothing was replaced in this file',
      })
      continue
    }
    toWrite.push(plan)
  }
  for (const item of request.expected) {
    if (planned.plans.some((plan) => plan.file.chapter.chapterId === item.chapterId)) continue
    // The preview listed hits, the files no longer hold any: the same refusal the
    // other way round, reported instead of written.
    skipped.push({
      chapterId: item.chapterId,
      path: '',
      reason: 'GONE',
      expected: item.count,
      actual: 0,
      detail: 'the preview listed this chapter, but its file no longer holds a hit; nothing was replaced',
    })
  }

  // Nothing to write is a success with nothing written: no package is opened, because
  // opening one appends `.inkflow/` to `.gitignore` and this path must stay zero-write.
  if (toWrite.length === 0) {
    return {
      ok: true,
      query: request.query,
      replacement: request.replacement,
      written: [],
      skipped,
      rolledBack: false,
      replaced: 0,
    }
  }

  const opened = openBackup(root, 'replace')
  if (!opened.ok) {
    return {
      ok: false,
      code: opened.error.code,
      message: opened.error.message,
      ...(opened.error.path === undefined ? {} : { path: opened.error.path }),
      written: [],
      skipped,
      rolledBack: false,
    }
  }
  const handle: BackupHandle = opened.value
  const body: BackupBody = newBackupBody()
  const address = { dir: handle.dir, manifestPath: handle.manifestPath }
  const described = sealBackup(root, handle, 'replace', body, false)
  if (!described.ok) {
    return {
      ok: false,
      code: described.error.code,
      message: `the rollback package could not be opened: ${described.error.message}`,
      backup: address,
      written: [],
      skipped,
      rolledBack: false,
    }
  }

  const written: ReplaceHit[] = []
  let replaced = 0
  for (const plan of toWrite) {
    const path = plan.file.chapter.file
    const staged = stageFile(root, handle, path)
    if (!staged.ok) {
      sealBackup(root, handle, 'replace', body, false)
      return {
        ok: false,
        code: staged.error.code,
        message: staged.error.message,
        ...(staged.error.path === undefined ? {} : { path: staged.error.path }),
        backup: address,
        written,
        skipped,
        rolledBack: rollbackBackup(root, handle.dir).ok,
      }
    }
    const wrote = writeTextAtomic(root, path, plan.nextText, { style: plan.file.style })
    if (!wrote.ok) {
      sealBackup(root, handle, 'replace', body, false)
      skipped.push({
        chapterId: plan.file.chapter.chapterId,
        path,
        reason: 'WRITE_FAILED',
        expected: plan.count,
        actual: plan.count,
        detail: wrote.error.message,
      })
      return {
        ok: false,
        code: wrote.error.code,
        message: wrote.error.message,
        ...(wrote.error.path === undefined ? {} : { path: wrote.error.path }),
        backup: address,
        written,
        skipped,
        rolledBack: rollbackBackup(root, handle.dir).ok,
      }
    }
    body.steps.push(`replace ${path} (${String(plan.count)})`)
    const after = digestRelative(root, path)
    body.files.push({
      path,
      change: 'modified',
      ...(staged.value === undefined ? {} : { before: staged.value }),
      ...(after === undefined ? {} : { after }),
    })
    written.push(hitOf(plan, request))
    replaced += plan.count
  }

  const sealed = sealBackup(root, handle, 'replace', body, true)
  if (!sealed.ok) {
    // The files are written; only the journal is missing. The package stays on disk
    // with `sealed: false` and its copies, so a rollback is still possible by hand.
    return {
      ok: false,
      code: sealed.error.code,
      message: `the replace finished, but the rollback journal could not be sealed: ${sealed.error.message}`,
      backup: address,
      written,
      skipped,
      rolledBack: false,
    }
  }

  return {
    ok: true,
    query: request.query,
    replacement: request.replacement,
    backup: address,
    written,
    skipped,
    rolledBack: false,
    replaced,
  }
}
