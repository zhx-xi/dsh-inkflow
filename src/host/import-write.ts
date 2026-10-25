/**
 * Importing an old manuscript into the book (roadmap X-17): plan → confirm → apply.
 *
 * The shape is X-17's, and it is the same shape `repair.ts` and `migrate.ts` use:
 *
 *   * `planImport` **writes nothing**. Not the chapter files, not the catalog, not the
 *     index — the whole-tree hash is unchanged after it (asserted). It reads the book's
 *     catalog projection (`readCatalog`, which projects the `.md` files) so it can name
 *     the `seq` each chapter will get.
 *   * `applyImport` re-runs *the same* `prepare()` the preview ran, compares the
 *     `planToken` the caller sends back, and only then writes. "Preview = execution" is
 *     therefore a property of one code path, not two implementations kept in sync.
 *   * Every write goes through the modules that own it: `createChapter` / `writeChapter`
 *     (never a hand-built path), `writeTextAtomic` for the library copy. Nothing here
 *     composes a project-relative path for a chapter.
 *   * One batch = **one backup package** (`openBackup(root, 'import')`), sealed
 *     `sealed: false` before the first write and `sealed: true` at the end, with the
 *     `after` digests filled in so `rollbackBackup` can prove what it puts back. A
 *     failure mid-batch rolls the batch back and reports it; a rollback that cannot
 *     finish is reported as such rather than hidden.
 *
 * WHY THE LIBRARY COPY IS THE DECODE, NOT THE ORIGINAL BYTES: `io.ts` is a text writer
 * (UTF-8, LF), and `backup.ts` refuses a non-UTF-8 source for exactly that reason —
 * "the copy survives the text writer byte for byte" is the invariant. A GBK manuscript
 * therefore cannot be stored verbatim through the write door. So the copy is the
 * **decoded UTF-8 text**, `byteIdentical` says whether that happened to equal the source
 * (it does for a UTF-8/LF file), and the report carries `sourceBytes` so nothing is
 * silently assumed.
 *
 * WHY `keepOriginal` DEFAULTS TO TRUE: the issue's own words are "导入到 `library/` 的
 * 原始文件（可选保留原件）：登记 `library_files`（路径/大小/mtime），不解析". Registering
 * the source is the default because the alternative — chapters appear, the manuscript
 * does not — is the state an author cannot undo by hand.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'

import {
  digestRelative,
  newBackupBody,
  openBackup,
  rollbackBackup,
  sealBackup,
  stageFile,
} from './backup.js'
import type { BackupBody, BackupError } from './backup.js'
import { readCatalog } from './catalog.js'
import { createChapter, writeChapter } from './chapters.js'
import { CATALOG_FILE, CHAPTERS_DIR, LIBRARY_DIR } from './conventions.js'
import { ensureIndex } from './index-freshness.js'
import { IMPORT_EXTENSIONS, MAX_IMPORT_BYTES, analyzeImportBytes, decodeImportBytes } from './import.js'
import type { ImportAnalysis, ImportEncoding, ImportEol, ImportPattern } from './import.js'
import { writeTextAtomic } from './io.js'
import { inspectProject } from './project.js'

/** A plain JSON payload, the channel's envelope half. */
type JsonRecord = Record<string, unknown>

/** What the caller asks for; every field is optional except the source. */
export interface ImportPlanOptions {
  /** Absolute path to the TXT/MD the author pointed at. Read, never written. */
  sourcePath: string
  /** Target volume (`vol-NN`); omitted = loose chapters under `chapters/`. */
  volumeId?: string
  /** Register the source under `library/` (default true). */
  keepOriginal?: boolean
}

/** `plan` plus the two fields `apply` needs from it. */
export interface ImportApplyOptions extends ImportPlanOptions {
  /** X-17: a write happens only with `confirm: true`. */
  confirm?: boolean
  /** The `planToken` the preview handed back; a mismatch is `IMPORT_PLAN_STALE`. */
  planToken?: string
}

export interface ImportPlanSource {
  /** Absolute path as given (the panel shows it, so it is reported, not echoed as `path`). */
  path: string
  name: string
  bytes: number
  sha256: string
  mtimeMs: number
  encoding: ImportEncoding
  sniff: string
  eol: ImportEol
  bom: boolean
}

export interface ImportPlanChapter {
  seq: number
  title: string
  paragraphs: number
  chars: number
  preface?: true
}

export interface ImportPlanTarget {
  volumeId: string | null
  volumeTitle: string | null
  /** Project-relative directory the chapter files will land in. */
  dir: string
}

export interface ImportPlanLibrary {
  keepOriginal: boolean
  /** Project-relative target, or null when the source is not kept. */
  path: string | null
  exists: boolean
  /** The file already holds exactly the text this import would write. */
  identical: boolean
}

export interface ImportPlan {
  source: ImportPlanSource
  chaptering: boolean
  pattern: ImportPattern
  totals: ImportAnalysis['totals']
  target: ImportPlanTarget
  chapters: ImportPlanChapter[]
  library: ImportPlanLibrary
  /** sha256 over everything the preview promised: apply refuses a different one. */
  planToken: string
  warnings: string[]
  catalogStale: boolean
}

export interface ImportError {
  code: string
  message: string
  hint?: string
  path?: string
  param?: string
  allowedExtensions?: readonly string[]
  planChapter?: string
  rolledBack?: boolean
  rollback?: JsonRecord
  state?: string
  missing?: string[]
}

export type ImportPlanResult = { ok: true; value: ImportPlan } | { ok: false; error: ImportError }
export type ImportApplyResult = { ok: true; value: ImportApplyValue } | { ok: false; error: ImportError }

export interface ImportAppliedChapter {
  chapterId: string
  file: string
  seq: number
  title: string
  paragraphs: number
  chars: number
}

export interface ImportApplyValue {
  plan: ImportPlan
  created: ImportAppliedChapter[]
  backup: { dir: string; sealed: boolean; files: number }
  library: {
    path: string
    written: boolean
    byteIdentical: boolean
    sourceBytes: number
    storedBytes: number
  } | null
  indexRebuilt: boolean
  indexError?: { code: string; message: string }
  ms: number
}

function fail(code: string, message: string, extra: Partial<ImportError> = {}): { ok: false; error: ImportError } {
  return { ok: false, error: { code, message, ...extra } }
}

/** The volume id a caller may name: `vol-1` and `1` both mean `vol-01`. */
function canonicalVolumeId(raw: string): string | undefined {
  const match = /^(?:vol-)?(\d{1,6})$/iu.exec(raw.trim())
  const digits = match?.[1]
  if (digits === undefined) return undefined
  const number = Number.parseInt(digits, 10)
  if (!Number.isInteger(number) || number < 1) return undefined
  return `vol-${String(number).padStart(2, '0')}`
}

/**
 * The file name the library copy gets.
 *
 * Only characters no portable filesystem round-trips are replaced, and the extension
 * is kept (`旧稿.txt` stays a `.txt`). An empty result — a name made entirely of
 * separators — falls back to `import.txt`, because refusing here would block an import
 * over a cosmetic problem.
 */
function libraryFileName(name: string): string {
  const replaced = name.replace(/[<>:"|?*\\/\u0000-\u001f\u007f]/gu, '-')
  const trimmed = replaced.replace(/^[-. ]+/u, '').replace(/[-. ]+$/u, '')
  return trimmed === '' ? 'import.txt' : trimmed
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Where the manuscript copy goes, and why that name.
 *
 * Three outcomes, and the rule behind them: **never write over a different text.**
 *   * the name is free → use it (`exists: false`);
 *   * the name holds the same text → reuse it (`identical: true`), so importing twice does
 *     not produce a twin;
 *   * the name holds different text → take `旧稿-2.txt`, `旧稿-3.txt`, … (`renamed: true`).
 *
 * The last one is the reason this is a function instead of one line: an author's
 * `library/灵感.txt` and a manuscript of the same name are two different documents, and
 * the import has no business deciding which one survives. (Before the batch, the old code
 * overwrote it — the backup package made that recoverable, but "recoverable" is not the
 * same as "not destroyed".)
 */
function chooseLibraryPath(
  root: string,
  base: string,
  decodedText: string,
): { path: string; exists: boolean; identical: boolean; renamed: boolean; collidedOut: boolean } {
  const directory = `${LIBRARY_DIR}/`
  const stem = base.replace(/\.[^.]*$/u, '')
  const extension = base.slice(stem.length)
  let last = `${directory}${base}`
  for (let attempt = 1; attempt <= 99; attempt += 1) {
    const candidate = `${directory}${attempt === 1 ? base : `${stem}-${String(attempt)}${extension}`}`
    last = candidate
    const absolute = resolve(root, ...candidate.split('/'))
    if (!existsSync(absolute)) return { path: candidate, exists: false, identical: false, renamed: attempt > 1, collidedOut: false }
    try {
      if (readFileSync(absolute, 'utf8') === decodedText) {
        return { path: candidate, exists: true, identical: true, renamed: attempt > 1, collidedOut: false }
      }
    } catch {
      // An unreadable file is not a candidate for reuse — move on to the next name.
    }
  }
  return { path: last, exists: true, identical: false, renamed: true, collidedOut: true }
}

/** Everything `plan` and `apply` must agree on, hashed. */
function planTokenOf(plan: Omit<ImportPlan, 'planToken' | 'catalogStale'>): string {
  return sha256Hex(
    Buffer.from(
      JSON.stringify({
        source: plan.source.sha256,
        encoding: plan.source.encoding,
        eol: plan.source.eol,
        volumeId: plan.target.volumeId,
        keepOriginal: plan.library.keepOriginal,
        libraryPath: plan.library.path,
        chapters: plan.chapters.map((chapter) => [chapter.seq, chapter.title, chapter.chars]),
      }),
      'utf8',
    ),
  )
}

/** What `prepare` hands to both halves: the plan plus the prose it describes. */
interface Prepared {
  plan: ImportPlan
  analysis: ImportAnalysis
  /** The decoded, LF-normalised source text: the library copy's bytes. */
  decodedText: string
}

type PrepareResult = { ok: true; value: Prepared } | { ok: false; error: ImportError }

/**
 * Read the source, analyse it, and describe what an apply would do. **Writes nothing.**
 *
 * The project gate runs first: "which file is this?" only matters inside a usable book,
 * and a refusal that happens before the source is read cannot leak whether a path exists
 * (the preview is reachable from the panel).
 */
function prepare(root: string, options: ImportPlanOptions): PrepareResult {
  const bookRoot = resolve(root)
  // `recreateIndexDir: false`: the gate's one write is creating a missing `index/`, and
  // a preview must not do that (the whole point of plan being read-only).
  const probe = inspectProject(bookRoot, { recreateIndexDir: false })
  if (probe.usable !== true) {
    return fail('NOT_A_PROJECT', 'this directory is not a usable InkFlow project, so there is nothing to import into', {
      state: probe.state,
      missing: probe.missing,
      hint: 'run the setup wizard first (inkflow_project_plan → inkflow_project_init), then import',
    })
  }

  const requested = (options.sourcePath ?? '').trim()
  if (requested === '') {
    return fail('IMPORT_SOURCE_REQUIRED', 'pass the path of the TXT or Markdown file to import', {
      param: 'sourcePath',
    })
  }
  const sourcePath = resolve(requested)

  let stat
  try {
    stat = statSync(sourcePath)
  } catch {
    return fail('IMPORT_SOURCE_MISSING', `no file at ${requested}`, {
      path: requested,
      hint: 'the path is read from the Host, so it may point outside the book; check the spelling',
    })
  }
  if (!stat.isFile()) {
    return fail('IMPORT_SOURCE_NOT_FILE', `${requested} is not a regular file`, {
      path: requested,
      hint: 'point at the manuscript file itself, not at the folder that holds it',
    })
  }
  const extension = extname(sourcePath).toLowerCase()
  if (!(IMPORT_EXTENSIONS as readonly string[]).includes(extension)) {
    return fail('IMPORT_TYPE_UNSUPPORTED', `${extension === '' ? 'a file without an extension' : extension} is not importable`, {
      path: requested,
      allowedExtensions: IMPORT_EXTENSIONS,
      hint: 'the import reads plain text: convert the manuscript to .txt or .md first (DOCX is a separate issue)',
    })
  }
  if (stat.size > MAX_IMPORT_BYTES) {
    return fail('IMPORT_TOO_LARGE', `${String(stat.size)} bytes exceeds the import cap of ${String(MAX_IMPORT_BYTES)}`, {
      path: requested,
      hint: 'split the manuscript into parts and import them one at a time',
    })
  }

  let bytes: Buffer
  try {
    bytes = readFileSync(sourcePath)
  } catch (cause) {
    return fail('IMPORT_SOURCE_UNREADABLE', `${requested} could not be read: ${String(cause)}`, { path: requested })
  }

  const name = basename(sourcePath)
  const analysis = analyzeImportBytes(bytes, { fallbackTitle: name.replace(/\.[^.]*$/u, '') })
  if (analysis.chapters.length === 0) {
    return fail('IMPORT_SOURCE_EMPTY', `${name} has no text to import`, {
      path: requested,
      hint: 'the file is empty or holds only whitespace',
    })
  }

  const catalog = readCatalog(bookRoot)
  let volumeId: string | null = null
  let volumeTitle: string | null = null
  let dir = CHAPTERS_DIR
  const requestedVolume = (options.volumeId ?? '').trim()
  if (requestedVolume !== '') {
    const canonical = canonicalVolumeId(requestedVolume)
    if (canonical === undefined) {
      return fail('VOLUME_ID_INVALID', `"${requestedVolume}" is not a volume id; expected vol-NN`, {
        param: 'volumeId',
      })
    }
    const volume = catalog.catalog.volumes.find((item) => item.volumeId === canonical)
    if (volume === undefined) {
      return fail('VOLUME_NOT_FOUND', `no volume ${canonical} in this book`, {
        param: 'volumeId',
        hint: 'create it with inkflow_volume_create, or import into the book root (no volumeId)',
      })
    }
    volumeId = volume.volumeId
    volumeTitle = volume.title
    dir = `${CHAPTERS_DIR}/${volume.dir}`
  }

  const siblings = volumeId === null ? catalog.catalog.looseChapters : (catalog.volumeCatalogs.find((item) => item.volumeId === volumeId)?.chapters ?? [])
  const highest = siblings.reduce((max, chapter) => (chapter.seq === undefined ? max : Math.max(max, chapter.seq)), 0)

  const chapters: ImportPlanChapter[] = analysis.chapters.map((chapter, index) => ({
    seq: highest + index + 1,
    title: chapter.title,
    paragraphs: chapter.paragraphs,
    chars: chapter.chars,
    ...(chapter.preface === true ? { preface: true as const } : {}),
  }))

  // The library copy is the source **as decoded** (LF, no BOM): a reader opening
  // `library/旧稿.txt` sees the manuscript. Computed once here because three things need
  // it — the collision check below, the plan token's sibling data and `applyImport`.
  const decodedText = decodeImportBytes(bytes).text
  const keepOriginal = options.keepOriginal !== false
  const chosen = keepOriginal ? chooseLibraryPath(bookRoot, libraryFileName(name), decodedText) : null
  const libraryPath = chosen?.path ?? null
  const libraryExists = chosen?.exists ?? false
  const libraryIdentical = chosen?.identical ?? false
  if (chosen?.renamed === true) {
    // A same-named file with DIFFERENT text is somebody's material: it is never
    // overwritten, the new one takes the next free name (`旧稿-2.txt`).
    analysis.warnings.push(`library/ 里已有同名的另一份文件，本次原件存为 ${String(libraryPath)}（不覆盖已有文件）。`)
  }
  if (chosen?.collidedOut === true) {
    analysis.warnings.push('library/ 里同名副本已排到 99 个，本次会复用最后一个位置：请整理后再导入。')
  }

  const withoutToken: Omit<ImportPlan, 'planToken' | 'catalogStale'> = {
    source: {
      path: sourcePath,
      name,
      bytes: bytes.byteLength,
      sha256: sha256Hex(bytes),
      mtimeMs: stat.mtimeMs,
      encoding: analysis.encoding,
      sniff: analysis.sniff,
      eol: analysis.eol,
      bom: analysis.bom,
    },
    chaptering: analysis.chaptering,
    pattern: analysis.pattern,
    totals: analysis.totals,
    target: { volumeId, volumeTitle, dir },
    chapters,
    library: { keepOriginal, path: libraryPath, exists: libraryExists, identical: libraryIdentical },
    warnings: [...analysis.warnings],
  }
  const plan: ImportPlan = {
    ...withoutToken,
    planToken: planTokenOf(withoutToken),
    catalogStale: catalog.catalogStale,
  }
  // The library copy is the **source file as decoded** (LF, no BOM) — not the chapter
  // titles re-assembled, so a reader opening `library/旧稿.txt` sees the manuscript, and
  // a UTF-8/LF source is stored byte-identically. One extra decode per prepare is the
  // price of that fidelity; `analyzeImportBytes` deliberately does not carry the text in
  // its own payload (the tool reply and the route body must not transport a 60万字 file).
  return { ok: true, value: { plan, analysis, decodedText: decodeImportBytes(bytes).text } }
}

/** `GET`-side half: the preview. Read-only by construction (see `prepare`). */
export function planImport(root: string, options: ImportPlanOptions): ImportPlanResult {
  const prepared = prepare(root, options)
  if (!prepared.ok) return prepared
  return { ok: true, value: prepared.value.plan }
}

/**
 * Apply one import: chapters, the library copy, one backup package, one index rebuild.
 *
 * Order matters and is deliberate:
 *   1. `confirm` before anything else (X-17), so a missing flag cannot cost a read;
 *   2. `prepare` again — the same call the preview made, so the plan token describes
 *      the book as it is now;
 *   3. the token comparison;
 *   4. open the package and **stage every file that already exists and will change**
 *      before the first write, then seal `sealed: false` — a crash from here on leaves
 *      a journal that says the batch was interrupted;
 *   5. chapters (create → write), then the library copy, then the `after` digests and
 *      `sealed: true`;
 *   6. rebuild the index once at the end: it is a cache, and reporting a failed rebuild
 *      must never roll the files back.
 */
export async function applyImport(root: string, options: ImportApplyOptions): Promise<ImportApplyResult> {
  if (options.confirm !== true) {
    return fail('CONFIRM_REQUIRED', 'importing writes chapter files and a library copy', {
      param: 'confirm',
      hint: 'preview first, then pass confirm: true together with the planToken the preview returned',
    })
  }

  const bookRoot = resolve(root)
  const prepared = prepare(bookRoot, options)
  if (!prepared.ok) return prepared
  const { plan, analysis, decodedText } = prepared.value

  if (options.planToken !== undefined && options.planToken !== plan.planToken) {
    return fail('IMPORT_PLAN_STALE', 'the source or the book changed since the preview', {
      param: 'planToken',
      hint: 'run the preview again and confirm the plan it returns',
    })
  }

  const startedAt = process.hrtime.bigint()
  const opened = openBackup(bookRoot, 'import')
  if (!opened.ok) return backupFailure(opened.error)
  const handle = opened.value
  const body = newBackupBody()

  // (4) Stage what already exists. A file this batch will create has no `before`.
  //
  // The library copy is deliberately NOT here: `chooseLibraryPath` only ever targets a
  // free name or a file that already holds this exact text, so it never overwrites one.
  const preExisting: string[] = [`${CHAPTERS_DIR}/${CATALOG_FILE}`]
  if (plan.target.volumeId !== null) preExisting.push(`${plan.target.dir}/${CATALOG_FILE}`)
  for (const path of preExisting) {
    if (!existsSync(resolve(bookRoot, ...path.split('/')))) continue
    const staged = stageFile(bookRoot, handle, path)
    if (!staged.ok) return backupFailure(staged.error)
    if (staged.value === undefined) continue
    body.files.push({ path, change: 'modified', before: staged.value })
  }
  body.steps.push(`open import package ${handle.dir}`)
  sealer(bookRoot, handle, body, false)

  /**
   * Files the batch brought into being: a chapter file, the library copy, and the
   * chapter catalog when the book had none. `createChapter` writes the catalog itself,
   * so it is covered here rather than in the loop — a rollback that leaves a catalog
   * listing a chapter it just deleted would hand the next reader a phantom chapter.
   */
  const coverCreated = (): void => {
    for (const path of preExisting) {
      if (body.files.some((entry) => entry.path === path)) continue
      if (existsSync(resolve(bookRoot, ...path.split('/')))) body.files.push({ path, change: 'created' })
    }
  }

  /** Fill in what the batch left behind, so a rollback can verify before overwriting. */
  const stampAfter = (): void => {
    for (const entry of body.files) {
      const digest = digestRelative(bookRoot, entry.path)
      if (digest !== undefined) entry.after = digest
    }
  }

  const rollback = (code: string, message: string, extra: Partial<ImportError> = {}): ImportApplyResult => {
    coverCreated()
    stampAfter()
    sealer(bookRoot, handle, body, false)
    const undone = rollbackBackup(bookRoot, handle.dir)
    if (!undone.ok) {
      return fail('IMPORT_ROLLBACK_FAILED', `${message}; and the rollback did not finish: ${undone.error.message}`, {
        ...extra,
        rolledBack: false,
        rollback: { dir: handle.dir, code: undone.error.code, message: undone.error.message },
        hint: 'the byte copies are still in the package directory: restore them by hand or run the rollback again',
      })
    }
    return fail(code, message, {
      ...extra,
      rolledBack: true,
      rollback: {
        dir: undone.dir,
        restored: undone.restored,
        removed: undone.removed,
        dirsRemoved: undone.dirsRemoved,
      },
    })
  }

  // (5a) Chapters, one create + one write each, through the modules that own them.
  const created: ImportAppliedChapter[] = []
  for (let index = 0; index < plan.chapters.length; index += 1) {
    const planned = plan.chapters[index]
    const chapter = analysis.chapters[index]
    if (planned === undefined || chapter === undefined) continue

    const made = await createChapter(bookRoot, {
      title: planned.title,
      ...(plan.target.volumeId === null ? {} : { volumeId: plan.target.volumeId }),
      seq: planned.seq,
      // One index build for the whole batch, not one per chapter: the index is a cache,
      // and 200 chapters × 2 full builds measured 64 s against ~2 s for the single build
      // this function runs at the end.
      indexCommit: false,
    })
    if (!made.ok) {
      return rollback('IMPORT_CHAPTER_FAILED', `the chapter 「${planned.title}」 could not be created: ${made.error.message}`, {
        planChapter: planned.title,
        hint: made.error.hint,
      })
    }
    const file = made.chapter.file
    body.files.push({ path: file, change: 'created' })
    body.steps.push(`create ${file}`)

    const written = await writeChapter(bookRoot, {
      chapterId: made.chapter.chapterId,
      body: `${chapter.body}\n`,
      // Same reason as the create above: the single rebuild at the end covers both.
      indexCommit: false,
    })
    if (!written.ok) {
      return rollback('IMPORT_CHAPTER_FAILED', `the body of 「${planned.title}」 could not be written: ${written.error.message}`, {
        planChapter: planned.title,
        hint: written.error.hint,
      })
    }
    body.steps.push(`write ${file}`)
    created.push({
      chapterId: made.chapter.chapterId,
      file,
      seq: planned.seq,
      title: planned.title,
      paragraphs: planned.paragraphs,
      chars: planned.chars,
    })
  }

  // (5b) The library copy: the manuscript stays available without being parsed again.
  let library: ImportApplyValue['library'] = null
  if (plan.library.path !== null) {
    const libraryPath = plan.library.path
    if (plan.library.identical) {
      // Same text as last time: no write, so no `mtime` churn and no duplicate entry.
      library = {
        path: libraryPath,
        written: false,
        byteIdentical: sourceIsByteIdentical(plan, decodedText),
        sourceBytes: plan.source.bytes,
        storedBytes: existsSync(resolve(bookRoot, ...libraryPath.split('/')))
          ? statSync(resolve(bookRoot, ...libraryPath.split('/'))).size
          : 0,
      }
    } else {
      const written = writeTextAtomic(bookRoot, libraryPath, decodedText)
      if (!written.ok) {
        return rollback('IMPORT_LIBRARY_FAILED', `the original could not be kept at ${libraryPath}: ${written.error.message}`, {
          path: libraryPath,
        })
      }
      // Always a fresh name (see `chooseLibraryPath`): a file holding different text is
      // never the target, so this branch never overwrites one.
      body.files.push({ path: libraryPath, change: 'created' })
      body.steps.push(`create ${libraryPath}`)
      library = {
        path: libraryPath,
        written: true,
        byteIdentical: sourceIsByteIdentical(plan, decodedText),
        sourceBytes: plan.source.bytes,
        storedBytes: Buffer.byteLength(decodedText, 'utf8'),
      }
    }
  }

  // (5c) Seal with the post-change digests.
  coverCreated()
  stampAfter()
  const sealed = sealer(bookRoot, handle, body, true)

  // (6) One index rebuild. The files are the truth: a failed rebuild is reported.
  let indexRebuilt = false
  let indexError: { code: string; message: string } | undefined
  try {
    const ensured = await ensureIndex(bookRoot, { rebuild: true })
    indexRebuilt = ensured.ok
    if (!ensured.ok) indexError = { code: ensured.failure.code, message: ensured.failure.message }
  } catch (cause) {
    indexError = { code: 'INDEX_BUILD_FAILED', message: String(cause) }
  }

  return {
    ok: true,
    value: {
      plan,
      created,
      backup: { dir: handle.dir, sealed: sealed, files: body.files.length },
      library,
      indexRebuilt,
      ...(indexError === undefined ? {} : { indexError }),
      ms: Number(process.hrtime.bigint() - startedAt) / 1e6,
    },
  }
}

/** Whether the stored copy happens to be the source bytes verbatim (UTF-8/LF only). */
function sourceIsByteIdentical(plan: ImportPlan, decodedText: string): boolean {
  if (plan.source.bom || plan.source.eol !== 'lf') return false
  if (plan.source.encoding !== 'utf8') return false
  return Buffer.byteLength(decodedText, 'utf8') === plan.source.bytes
}

/** `sealBackup`, reporting rather than throwing; returns whether the manifest landed. */
function sealer(root: string, handle: { dir: string; manifestPath: string }, body: BackupBody, sealed: boolean): boolean {
  return sealBackup(root, handle, 'import', body, sealed).ok
}

function backupFailure(error: BackupError): { ok: false; error: ImportError } {
  return fail(error.code, error.message, {
    ...(error.path === undefined ? {} : { path: error.path }),
    ...(error.hint === undefined ? {} : { hint: error.hint }),
  })
}
