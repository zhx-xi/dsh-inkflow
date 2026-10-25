/**
 * The fact ledger's three model-facing tools:
 * `inkflow_facts_append`, `inkflow_facts_snapshot`, `inkflow_facts_list`.
 *
 * They live in the domain, not in `tools.ts` (roadmap §2.1 X-5): a domain branch adds one
 * line to `DOMAIN_MODULES` and never to the built-in tool array.
 *
 * They resolve the book the way a built-in tool does (`withProject()`: explicit
 * `projectRoot`, else the **session's** working directory). Never bare `process.cwd()` —
 * inside the host process that is the DSH install directory.
 *
 * Reads never bypass the derived index (`ensureIndex()` first, then `facts-query.ts`), and
 * writes never bypass `io.ts` (path checks + write lock + atomic replace).
 *
 * The append gate runs X-4 in order — `scanProject` → plan → parse the candidate →
 * `applyCandidate` → judge the post-write view with **the same** `factsConflicts` a rebuild
 * runs → only then write. This is the "double insurance" of I-23: the rebuild reports an
 * overlap, and the write refuses to create one.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ToolDefinition } from '../context.js'
import { compareExpectation, fingerprintProjectFile, sameContent } from '../file-cas.js'
import type { FileExpectation } from '../file-cas.js'
import { frontmatterLine } from '../frontmatter.js'
import { buildIndex, describeIndexBuildFailure } from '../index-build.js'
import { ensureIndex } from '../index-freshness.js'
import { scanProject } from '../indexer.js'
import { writeTextAtomic } from '../io.js'
import { DEFAULT_FACT_SOURCE, FACT_SOURCES, renderFactLine } from './facts-line.js'
import {
  FACTS_TABLE,
  chapterSeqFrom,
  conflictsTouching,
  factAnchor,
  factsConflicts,
  factsFileParse,
  factsSnapshot,
  parseFactsFile,
  sortFacts,
  unresolvedChapterIds,
} from './facts-plan.js'
import type { FactConflict, FactRow } from './facts-plan.js'
import { chapterIndex, readFactsRows, seqOfChapters } from './facts-query.js'
import { rowsOf } from './scan-helpers.js'
import {
  OUTPUT_SCHEMA,
  PROJECT_ROOT_PARAM,
  asRecord,
  indexFailure,
  isPortableSlug,
  optionalBoolean,
  optionalString,
  slugify,
  text,
  withProject,
} from './tool-support.js'
import type { Json } from './tool-support.js'
import { applyCandidate } from './types.js'
import type { DomainEntityRef, DomainToolDeps, DomainWriteView } from './types.js'

/**
 * The caller-supplied write baseline — same shape `tools.ts` exposes on the
 * chapter writers, declared here because that constant is module-private.
 */
const EXPECTED_PARAM = {
  type: 'object',
  properties: {
    sha256: { type: 'string', description: 'Lowercase hex sha256 of the file bytes you last read.' },
    size: { type: 'integer', description: 'Byte length of the file you last read (0 or higher).' },
    mtimeMs: { type: 'number', description: 'Modification time in ms (only compared when sha256/size are absent).' },
    absent: { type: 'boolean', description: 'True when the file must not exist yet.' },
  },
  additionalProperties: false,
  description:
    'Optional compare-and-swap baseline: the ledger fingerprint you last read. A mismatch is refused with FILE_CHANGED ' +
    'and nothing is written, so a hand edit in an editor is never overwritten by a stale append.',
} as const

function expectedParam(value: unknown): FileExpectation | undefined {
  const raw = asRecord(value)
  const expected: FileExpectation = {}
  if (typeof raw['sha256'] === 'string' && raw['sha256'].trim() !== '') expected.sha256 = raw['sha256'].trim()
  if (typeof raw['size'] === 'number') expected.size = raw['size']
  if (typeof raw['mtimeMs'] === 'number') expected.mtimeMs = raw['mtimeMs']
  if (raw['absent'] === true) expected.absent = true
  return Object.keys(expected).length === 0 ? undefined : expected
}

/** One fact as a payload entry. `file` is the project-relative path (`path` is the anchor). */
function factJson(row: FactRow): Json {
  return {
    subject: row.subject,
    attribute: row.attribute,
    value: row.value,
    since: row.since ?? null,
    until: row.until ?? null,
    chapter: row.chapter ?? null,
    source: row.source,
    file: row.path,
    line: row.line,
    anchor: factAnchor(row.path, row.line),
  }
}

function conflictJson(conflict: FactConflict): Json {
  return {
    code: conflict.code,
    anchor: factAnchor(conflict.path, conflict.line),
    file: conflict.path,
    line: conflict.line,
    otherAnchor: factAnchor(conflict.otherPath, conflict.otherLine),
    detail: conflict.detail,
  }
}

function renderFacts(entries: readonly Json[]): string[] {
  return entries.map((entry) => {
    const since = entry['since']
    const until = entry['until']
    const span = typeof since === 'string' ? `（自 ${since}${typeof until === 'string' ? ` 至 ${until}` : ''}）` : ''
    return `- ${String(entry['subject'])} · ${String(entry['attribute'])}：${String(entry['value'])}${span} — ${String(entry['anchor'])}`
  })
}

/** The current text of one project file, or `undefined` when it is not there yet. */
function readProjectText(root: string, relativePath: string): string | undefined {
  try {
    return readFileSync(join(root, ...relativePath.split('/')), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * The ledger that already speaks for `subject`, if the book has one.
 *
 * Two sources, in this order, because each knows something the other does not:
 *
 *   1. the fact **rows** — the direct answer whenever the file holds at least one parseable
 *      line (`row.subject` is the parsed frontmatter subject, so a ledger whose file name
 *      differs from its subject is found too);
 *   2. the **projection** — `facts/<slug>.md` publishes one entity even when the file has no
 *      fact line at all (an empty or prose-only ledger is still a known ledger). Using the
 *      rows alone made `inkflow_facts_append` create a *second* file for a subject whose
 *      ledger simply held no parseable line yet: the slug was derived
 *      from the subject, found nothing at that path, and wrote a new page next to the
 *      author's.
 *
 * A candidate file's subject can only be read from the file — the entity id is the path
 * (data-model §4.1) and the projection carries no subject column — so this re-reads the
 * book's ledgers. That cost is paid once per append, on small files, and only until the
 * first match; the alternative (a subject column) would be a second truth about the
 * ledger's identity.
 */
function ledgerPathFor(
  root: string,
  scanned: { readonly entities: readonly DomainEntityRef[] },
  rows: readonly FactRow[],
  subject: string,
): string | undefined {
  const known = rows.find((row) => row.subject === subject)
  if (known !== undefined) return known.path
  for (const entity of scanned.entities) {
    if (entity.kind !== 'facts') continue
    const text = readProjectText(root, entity.path)
    if (text === undefined) continue
    if (parseFactsFile(entity.path, text).subject === subject) return entity.path
  }
  return undefined
}

// ---------------------------------------------------------------------------
// inkflow_facts_append
// ---------------------------------------------------------------------------

function factsAppendTool(deps: DomainToolDeps): ToolDefinition {
  return {
    name: 'inkflow_facts_append',
    description:
      'Append one fact to the ledger (`facts/<subject>.md`), creating the file when the subject has none, then rebuild ' +
      'the derived index. A fact is one line: `attribute` (境界/年龄/持有物/生死…) + `value` inside an interval ' +
      '`[since, until)` of **chapter ids** — omit `until` while it still holds, omit `since` for "from the beginning". ' +
      'Only contradictions are refused: FACT_CONFLICT when this line would overlap an existing fact of the same ' +
      'subject + attribute with a different value (I-23), FACT_LINE_MALFORMED when it would not parse back, ' +
      'FILE_CHANGED when the ledger changed since the baseline you passed. Facts are compared by **chapter order**, ' +
      'not by id text. Appending never rewrites the rest of the file: existing lines, prose and unknown keys stay as ' +
      'they are. Pass `expected` (the fingerprint you last read) to make the append safe against a concurrent edit.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        subject: {
          type: 'string',
          description: 'Fact subject: a character / item / place id (the file is `facts/<subject>.md` unless it already exists).',
        },
        attribute: { type: 'string', description: 'Fact dimension, e.g. 境界 / 年龄 / 持有物 / 生死.' },
        value: { type: 'string', description: 'The value inside this interval, e.g. 金丹初期.' },
        since: { type: 'string', description: 'Chapter id where this value starts holding (inclusive). Omit for "from the beginning".' },
        until: { type: 'string', description: 'Chapter id where it stops holding (exclusive). Omit while it still holds.' },
        chapter: { type: 'string', description: 'Chapter id this fact was recorded in (written as `chapterId`).' },
        source: {
          type: 'string',
          enum: [...FACT_SOURCES],
          description: '`text` (derived from the prose) / `manual` (default) / `extract` (accepted from an extraction).',
        },
        file: { type: 'string', description: 'Ledger file slug; omit to reuse the subject\'s existing file, else derive it.' },
        expected: EXPECTED_PARAM,
        confirm: {
          type: 'boolean',
          description:
            'Required when this call would create a new ledger file (a new file is a decision, an append to an existing ' +
            'one is not). Ignored when the file already exists.',
        },
      },
      required: ['subject', 'attribute', 'value'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          if (v['requiresConfirmation'] === true) {
            return text([
              `Confirmation required: ${String(error['message'] ?? '')}`,
              `Would create: ${String(v['willWrite'] ?? '?')}`,
              `Line: ${String(v['willAppend'] ?? '')}`,
              'Nothing was written. Show this to the user, then call again with confirm: true.',
            ])
          }
          return text([`Fact append refused: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`])
        }
        const indexLine =
          v['indexRebuilt'] === true
            ? 'index rebuilt.'
            : `index NOT rebuilt (${String(asRecord(v['indexError'])['code'] ?? 'unknown')}) — run inkflow_index_rebuild.`
        return text([
          `${v['created'] === true ? 'Created' : 'Appended to'} ${String(v['file'])} (${String(v['anchor'])}).`,
          String(v['line']),
          indexLine,
        ])
      },
    },
    execute: async (args, exec) =>
      withProject(deps, exec, args, async (root) => {
        const a = asRecord(args)
        const subject = optionalString(a['subject'])
        if (subject === undefined) {
          return { ok: false, root, error: { code: 'SUBJECT_REQUIRED', message: 'a fact needs a subject' } }
        }
        const attribute = optionalString(a['attribute'])
        if (attribute === undefined) {
          return { ok: false, root, error: { code: 'ATTRIBUTE_REQUIRED', message: 'a fact needs an attribute' } }
        }
        const value = optionalString(a['value'])
        if (value === undefined) {
          return { ok: false, root, error: { code: 'VALUE_REQUIRED', message: 'a fact needs a value' } }
        }
        const source = optionalString(a['source'])?.toLowerCase()
        if (source !== undefined && !(FACT_SOURCES as readonly string[]).includes(source)) {
          return {
            ok: false,
            root,
            error: {
              code: 'FACT_SOURCE_INVALID',
              message: `source must be one of ${FACT_SOURCES.join(', ')}`,
              hint: 'omit it for a fact you registered by hand (`manual`)',
            },
          }
        }

        // Values may contain any text; only a newline would split the one-line record. A
        // literal `|` is fine — `renderFactLine` escapes it and the reader unescapes it.
        const multiline = [subject, attribute, value, optionalString(a['since']), optionalString(a['until']), optionalString(a['chapter'])]
          .find((entry) => entry !== undefined && /[\r\n]/u.test(entry))
        if (multiline !== undefined) {
          return {
            ok: false,
            root,
            error: {
              code: 'FACT_VALUE_INVALID',
              message: 'a subject, attribute, value, since, until or chapter must be a single line',
              hint: 'a fact is one line of the ledger; nothing was written',
            },
          }
        }

        const scanned = scanProject(root)
        const rows = rowsOf<FactRow>(scanned, FACTS_TABLE)
        const existingLedgerPath = ledgerPathFor(root, scanned, rows, subject)
        const requestedSlug = optionalString(a['file'])
        const slug = requestedSlug !== undefined ? slugify(requestedSlug.replace(/\.md$/u, '')) : undefined
        if (requestedSlug !== undefined && (slug === undefined || !isPortableSlug(slug))) {
          return {
            ok: false,
            root,
            error: { code: 'SLUG_INVALID', message: `"${requestedSlug}" is not a portable file name` },
          }
        }
        const path = slug === undefined ? (existingLedgerPath ?? `facts/${slugify(subject)}.md`) : `facts/${slug}.md`
        if (!isPortableSlug(path.slice('facts/'.length).replace(/\.md$/u, ''))) {
          return {
            ok: false,
            root,
            error: {
              code: 'SLUG_INVALID',
              message: `"${subject}" cannot be a portable file name`,
              hint: 'pass `file` with an ASCII slug, or rename the subject',
            },
          }
        }

        const existingText = readProjectText(root, path)
        // The fingerprint of the very bytes read above, so the baseline the caller passed is
        // compared against what this call is actually editing (not a second read).
        const readFingerprint = existingText === undefined ? undefined : fingerprintProjectFile(root, path)
        const existingSubject = existingText === undefined ? undefined : parseFactsFile(path, existingText).subject
        if (existingSubject !== undefined && existingSubject !== subject) {
          return {
            ok: false,
            root,
            path,
            error: {
              code: 'FACT_SUBJECT_MISMATCH',
              message: `${path} belongs to subject "${existingSubject}", not "${subject}"`,
              hint: 'append to the subject that file declares, or pass `file` for a different ledger; nothing was written',
            },
          }
        }

        // The caller's baseline is checked before anything is judged: a ledger that changed
        // on disk since it was read makes both the candidate and the conflict verdict
        // meaningless. (The project write lock only excludes another session of this plugin,
        // so the human's editor is caught here.)
        const drift = compareExpectation(readFingerprint, expectedParam(a['expected']))
        if (drift !== undefined) {
          return {
            ok: false,
            root,
            path,
            error: {
              code: 'FILE_CHANGED',
              message: `${path} changed on disk since the baseline you passed (${drift.changed.join(', ')}); nothing was written`,
              expected: drift.expected,
              current: drift.current,
              changed: drift.changed,
              hint: 're-read the ledger, then retry with its current size / mtimeMs / sha256 as `expected`',
            },
          }
        }

        const line = renderFactLine({
          attribute,
          value,
          ...(optionalString(a['since']) === undefined ? {} : { since: optionalString(a['since']) }),
          ...(optionalString(a['until']) === undefined ? {} : { until: optionalString(a['until']) }),
          ...(optionalString(a['chapter']) === undefined ? {} : { chapterId: optionalString(a['chapter']) }),
          source: source ?? DEFAULT_FACT_SOURCE,
          extra: {},
        })

        const blank = existingText === undefined || existingText.trim() === ''
        // Nothing is written yet: creating a ledger is a decision the user should see, and a
        // new file is the one case an append cannot be undone by deleting a line.
        if (blank && !optionalBoolean(a['confirm'])) {
          return {
            ok: false,
            root,
            requiresConfirmation: true,
            willWrite: path,
            willAppend: line,
            error: {
              code: 'FACTS_APPEND_REQUIRES_CONFIRMATION',
              message: `creating ${path} needs confirmation`,
              hint: 'show the file and the line to the user; nothing was written. Call again with confirm: true',
            },
          }
        }

        // The author's own endings are kept: a one-line append must not restyle the whole
        // ledger. Writing the joined text through `normalizeText` (BOM stripped, CRLF → LF)
        // rewrote every line of a file the author had saved on Windows — the tool said "never
        // rewrites the rest of the file" and did exactly that. The
        // appended line follows the file's ending, so a CRLF ledger stays CRLF throughout.
        const eol = existingText !== undefined && existingText.includes('\r\n') ? '\r\n' : '\n'
        const head =
          blank || existingText === undefined
            ? `---\n${frontmatterLine('subject', subject)}\n---\n\n`
            : existingText.endsWith('\n')
              ? existingText
              : `${existingText}${eol}`
        const content = `${head}${line}${eol}`

        // X-4, in order: parse the candidate, fold it into the post-write view, judge it
        // with the same rules a rebuild runs, and only then write.
        const parsedFile = factsFileParse(path, content)
        const appended = parsedFile.rows.find((bucket) => bucket.table === FACTS_TABLE)?.rows.at(-1) as FactRow | undefined
        if (appended === undefined || appended.attribute !== attribute || appended.value !== value) {
          const firstIssue = parsedFile.issues[0]
          return {
            ok: false,
            root,
            path,
            error: {
              code: firstIssue?.code ?? 'FACT_LINE_MALFORMED',
              message: firstIssue?.detail ?? 'the line this call would append does not parse back as one fact',
              path: firstIssue?.path ?? path,
              hint: 'nothing was written',
            },
          }
        }

        const seqOf = chapterSeqFrom(scanned.entities)
        const view: DomainWriteView = { scan: scanned, entities: scanned.entities }
        const post = applyCandidate(view, parsedFile)
        const conflicts = conflictsTouching(factsConflicts(rowsOf<FactRow>(post.scan, FACTS_TABLE), seqOf), {
          path,
          line: appended.line,
        })
        const blocking = conflicts[0]
        if (blocking !== undefined) {
          return {
            ok: false,
            root,
            path,
            error: {
              code: blocking.code,
              message: `${blocking.detail} — the other fact is ${factAnchor(blocking.otherPath, blocking.otherLine)}`,
              path: factAnchor(blocking.path, blocking.line),
              hint:
                'nothing was written: two values of one attribute cannot hold at the same chapter. ' +
                'Give the older fact an `until`, or correct its `value`',
            },
          }
        }

        // The write lock excludes another session of this plugin but not the human's editor:
        // the file is re-fingerprinted against the bytes this call read, immediately before
        // the write, so a save that landed in between is refused instead of overwritten.
        if (!sameContent(fingerprintProjectFile(root, path), readFingerprint)) {
          return {
            ok: false,
            root,
            path,
            error: {
              code: 'FILE_CHANGED',
              message: `${path} changed on disk while this call was working on it; nothing was written`,
              expected: readFingerprint ?? { absent: true },
              current: fingerprintProjectFile(root, path) ?? null,
              hint: 're-read the ledger and retry: an editor save between the read and the write must not be lost',
            },
          }
        }

        // `verbatim`: the content above is already the exact bytes the file must end up with
        // (the author's BOM/CRLF included), so the writer must not normalise it a second time.
        const written = writeTextAtomic(root, path, content, { verbatim: true })
        if (!written.ok) return { ok: false, root, path, error: written.error }

        let indexRebuilt = false
        let indexError: Json | undefined
        try {
          await buildIndex(root)
          indexRebuilt = true
        } catch (cause) {
          const failure = describeIndexBuildFailure(cause)
          indexError = { code: failure.code, message: failure.message }
        }

        return {
          ok: true,
          root,
          file: written.target.relative,
          subject,
          attribute,
          value,
          line,
          anchor: factAnchor(written.target.relative, appended.line),
          created: written.created,
          bytes: written.bytes,
          indexRebuilt,
          ...(indexError === undefined ? {} : { indexError }),
        }
      }),
  }
}

// ---------------------------------------------------------------------------
// inkflow_facts_snapshot
// ---------------------------------------------------------------------------

function factsSnapshotTool(deps: DomainToolDeps): ToolDefinition {
  return {
    name: 'inkflow_facts_snapshot',
    description:
      'List the ledger facts **in effect at one chapter** — "what is true at chapter N". `chapterId` defaults to the ' +
      'last chapter of the book. An interval is `[since, until)` and is resolved by chapter order: a fact holds from ' +
      'the chapter named by `since` (inclusive) up to `until` (exclusive); a missing `since` starts at the beginning ' +
      'of the book and a missing `until` still holds. The reply is deterministic (subject → attribute → since), so two ' +
      'calls on the same book return the same list, and it carries the book-wide FACT_CONFLICT findings. ' +
      'Read-only; the derived index is rebuilt first when it is stale. Call it before writing a chapter when you need ' +
      'to know a character\'s current realm, possessions or life state.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        chapterId: {
          type: 'string',
          description: 'Chapter id to take the snapshot at. Omit for the current (highest `seq`) chapter.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          return text([`Facts unavailable: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`])
        }
        const facts = Array.isArray(v['facts']) ? (v['facts'] as Json[]) : []
        const chapterId = v['chapterId']
        const at = typeof chapterId === 'string' ? chapterId : '书首（无章节）'
        const lines = [
          `${String(facts.length)} fact(s) in effect at ${at}${v['indexRebuilt'] === true ? ' (index rebuilt)' : ''}:`,
          ...(facts.length === 0 ? ['  (空)'] : renderFacts(facts)),
        ]
        for (const conflict of Array.isArray(v['conflicts']) ? (v['conflicts'] as Json[]).slice(0, 10) : []) {
          lines.push(`! ${String(conflict['code'] ?? '')} ${String(conflict['anchor'] ?? '')} — ${String(conflict['detail'] ?? '')}`)
        }
        return text(lines)
      },
    },
    execute: async (args, exec) =>
      withProject(deps, exec, args, async (root) => {
        const a = asRecord(args)
        const ensured = await ensureIndex(root)
        if (!ensured.ok) return indexFailure(root, ensured.failure)
        const rows = readFactsRows(root)
        const chapters = chapterIndex(root)
        if (rows === undefined || chapters === undefined) {
          return indexFailure(root, { code: 'INDEX_UNAVAILABLE', message: 'the derived index could not be read' })
        }
        const seqOf = seqOfChapters(chapters)

        const requested = optionalString(a['chapterId'])
        let atSeq: number | undefined
        let chapterId: string | undefined
        if (requested !== undefined) {
          atSeq = chapters.byId.get(requested)
          if (atSeq === undefined) {
            return {
              ok: false,
              root,
              error: {
                code: 'CHAPTER_NOT_FOUND',
                message: `"${requested}" is not a chapter of this book (or carries no \`seq\`)`,
                hint: 'pass a chapter id from inkflow_chapter_list, or omit chapterId for the current chapter',
              },
            }
          }
          chapterId = requested
        } else {
          atSeq = chapters.maxSeq
          chapterId = atSeq === undefined ? undefined : [...chapters.byId.entries()].find(([, seq]) => seq === atSeq)?.[0]
        }

        const facts =
          atSeq === undefined
            ? []
            : factsSnapshot(rows, seqOf, atSeq)

        return {
          ok: true,
          root,
          chapterId: chapterId ?? null,
          chapterSeq: atSeq ?? null,
          facts: facts.map(factJson),
          conflicts: factsConflicts(rows, seqOf).map(conflictJson),
          indexRebuilt: ensured.rebuilt,
          indexState: ensured.state,
        }
      }),
  }
}

// ---------------------------------------------------------------------------
// inkflow_facts_list
// ---------------------------------------------------------------------------

function factsListTool(deps: DomainToolDeps): ToolDefinition {
  return {
    name: 'inkflow_facts_list',
    description:
      'List every ledger fact of the book, optionally narrowed to one `subject` and/or one `attribute`, in the stable ' +
      'order subject → attribute → since (by chapter order) → line. Each entry carries its anchor `facts/<subject>.md#L<n>` ' +
      'and its interval, plus the book-wide FACT_CONFLICT findings and the chapter ids the ledger names that this book ' +
      'does not have (a typo in `since`/`until` is not a conflict, and cannot be judged). Read-only; the derived index ' +
      'is rebuilt first when it is stale. This is the inspection tool: use it to see the whole ledger, to find why a ' +
      'value changed, or after an append to confirm what the ledger now says.',
    parameters: {
      type: 'object',
      properties: {
        projectRoot: PROJECT_ROOT_PARAM,
        subject: { type: 'string', description: 'Only facts of this subject id.' },
        attribute: { type: 'string', description: 'Only facts of this attribute (e.g. 境界).' },
      },
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const v = asRecord(value)
        if (v['ok'] !== true) {
          const error = asRecord(v['error'])
          return text([`Ledger unavailable: ${String(error['code'] ?? 'unknown')} — ${String(error['message'] ?? '')}`])
        }
        const facts = Array.isArray(v['facts']) ? (v['facts'] as Json[]) : []
        const lines = [
          `${String(facts.length)} fact(s)${v['indexRebuilt'] === true ? ' (index rebuilt)' : ''}:`,
          ...(facts.length === 0 ? ['  (空)'] : renderFacts(facts)),
        ]
        const unresolved = Array.isArray(v['unresolvedChapters']) ? (v['unresolvedChapters'] as unknown[]).map(String) : []
        if (unresolved.length > 0) {
          lines.push(`! chapter ids not in this book: ${unresolved.join(', ')} (those intervals cannot be judged)`)
        }
        for (const conflict of Array.isArray(v['conflicts']) ? (v['conflicts'] as Json[]).slice(0, 10) : []) {
          lines.push(`! ${String(conflict['code'] ?? '')} ${String(conflict['anchor'] ?? '')} — ${String(conflict['detail'] ?? '')}`)
        }
        return text(lines)
      },
    },
    execute: async (args, exec) =>
      withProject(deps, exec, args, async (root) => {
        const a = asRecord(args)
        const ensured = await ensureIndex(root)
        if (!ensured.ok) return indexFailure(root, ensured.failure)
        const rows = readFactsRows(root)
        const chapters = chapterIndex(root)
        if (rows === undefined || chapters === undefined) {
          return indexFailure(root, { code: 'INDEX_UNAVAILABLE', message: 'the derived index could not be read' })
        }
        const seqOf = seqOfChapters(chapters)
        const subject = optionalString(a['subject'])
        const attribute = optionalString(a['attribute'])
        const filtered = rows.filter(
          (row) =>
            (subject === undefined || row.subject === subject) && (attribute === undefined || row.attribute === attribute),
        )
        return {
          ok: true,
          root,
          counts: { total: rows.length, matched: filtered.length },
          facts: sortFacts(filtered, seqOf).map(factJson),
          // Judged over the whole book: a `subject` filter would hide the very pair the
          // author needs to see (the conflict's other side is often another subject file).
          conflicts: factsConflicts(rows, seqOf).map(conflictJson),
          unresolvedChapters: unresolvedChapterIds(rows, seqOf),
          indexRebuilt: ensured.rebuilt,
          indexState: ensured.state,
        }
      }),
  }
}

/** All three ledger tools, in registry order (X-5: the domain's whole model-facing surface). */
export function factsTools(deps: DomainToolDeps): readonly ToolDefinition[] {
  return [factsListTool(deps), factsAppendTool(deps), factsSnapshotTool(deps)]
}
