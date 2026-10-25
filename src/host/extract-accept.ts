/**
 * Turning a candidate into an entity — the one and only write path of extraction
 * (ADR-0017 D4/D5).
 *
 * The discipline is the domain seam's own (X-4), run once here instead of six times:
 *
 *   1. `materializeCandidate()`   — the candidate's `fields` become one document's
 *      text, through the **domain's own renderer** (`renderCharacterCard`,
 *      `renderWorldFile`, `renderOutlineDocument`, …). A candidate therefore lands in
 *      exactly the shape a hand write produces, not a second dialect.
 *   2. `domain.parseFile()`       — the text we are about to write, parsed by the very
 *      same parser a rebuild uses.
 *   3. `applyCandidate()`         — the seam-owned "replace this path" fold, so
 *      `validate()` sees the post-write book.
 *   4. `domain.validate()`        — the same invariants a rebuild runs; every issue
 *      that names this path (or names none) blocks the write.
 *   5. `io.ts writeTextAtomic()`  — only then, under the project write lock.
 *
 * Why "silent ingestion = 0" is a STRUCTURAL claim (D5): `extract.ts` stores
 * candidates, this module is the only place a candidate becomes bytes, and the content
 * directories are reachable from here only through step 5. `tests/extract.test.js`
 * pins both halves by scanning the import graph and by hashing the content
 * directories around a refused batch — but the guarantee does not rest on that test:
 * there is no second path in the code for a test to have missed.
 *
 * Conflicts are reported with **the domain's own code** (`CHARACTER_NAME_DUPLICATE`,
 * `DUPLICATE_ID`, `WORLD_ROOT_MULTIPLE`, …) and nothing is written. Accepting never
 * overwrites: "this candidate is wrong" is `reject`, and "this entity already exists"
 * is an edit of that entity, not an extraction.
 */

import { randomUUID } from 'node:crypto'

import { newBackupBody, openBackup, sealBackup, stageFile } from './backup.js'
import { applyCandidate, DOMAIN_MODULES } from './domains/index.js'
import type { DomainModule, DomainWriteView } from './domains/types.js'
import { rowsOf } from './domains/scan-helpers.js'
import { characterFileName, planCharacterUpsert, renderCharacterCard } from './domains/character-write.js'
import type { CharacterRow, CharacterState } from './domains/character.js'
import { parsePlotPointItem } from './domains/outline-model.js'
import type { OutlinePlotPoint } from './domains/outline-model.js'
import { renderOutlineDocument } from './domains/outline-write.js'
import { renderTimelineDocument } from './domains/timeline-document.js'
import type { TimelineStatus } from './domains/timeline-plan.js'
import { renderForeshadowDocument } from './domains/foreshadowing-plan.js'
import type { ForeshadowStatus } from './domains/foreshadowing-plan.js'
import { defaultRelationPath, renderRelationFile } from './domains/relation-write.js'
import type { RelationRow } from './domains/relation-write.js'
import { keywordProblem } from './domains/world-plan.js'
import { renderWorldFile } from './domains/world-tools.js'
import { isPortableSlug, slugify } from './domains/tool-support.js'
import { compareWithExisting } from './extract-compare.js'
import { readCandidateStore, setCandidateStatuses } from './extract.js'
import { fingerprintProjectFile } from './file-cas.js'
import { scanProject } from './indexer.js'
import { withProjectWriteLock, writeTextAtomic } from './io.js'

import type { CandidateProposal, CandidateRecord, ExtractError, ExtractKind } from './extract.js'

/** Why one candidate did not land. `code` is the refusal the caller acts on. */
export interface AcceptRefusal {
  readonly code: string
  readonly message: string
  readonly path?: string
}

/** One candidate's document, ready for the seam. */
interface Materialized {
  readonly path: string
  readonly text: string
}

type MaterializeResult = { ok: true; value: Materialized } | { ok: false; error: AcceptRefusal }

function refuse(code: string, message: string, path?: string): { ok: false; error: AcceptRefusal } {
  return { ok: false, error: path === undefined ? { code, message } : { code, message, path } }
}

function textField(fields: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = fields[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function listField(fields: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = fields[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

function numberField(fields: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = fields[key]
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function statesField(fields: Readonly<Record<string, unknown>>): CharacterState[] {
  const value = fields['states']
  if (!Array.isArray(value)) return []
  const states: CharacterState[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const chapter = record['chapter']
    const status = record['status']
    if (typeof chapter === 'number' && Number.isInteger(chapter) && typeof status === 'string' && status.trim() !== '') {
      states.push({ chapter, status: status.trim() })
    }
  }
  return states.sort((left, right) => left.chapter - right.chapter)
}

/** `<dir>/<slug>.md`, or the refusal that makes a title unusable as a file name. */
function documentPath(directory: string, title: string): { ok: true; path: string } | { ok: false; error: AcceptRefusal } {
  const slug = slugify(title)
  if (!isPortableSlug(slug)) return refuse('CANDIDATE_FIELD_INVALID', `"${title}" has no usable file name`, directory)
  return { ok: true, path: `${directory}/${slug}.md` }
}

/**
 * The candidate's fields as one document. Pure: no disk, no clock.
 *
 * The `id` of a new entity is its project-relative path for every kind whose parser
 * defaults to it (data-model §3.1: 非章实体缺省用相对路径), written out explicitly so a
 * later rename is a deliberate act. A character card is the exception: I-03 keys it on
 * its name and `inkflow_character_upsert` mints a uuid, so a candidate mints one too —
 * a candidate must produce the same card a hand write would.
 */
export function materializeCandidate(proposal: CandidateProposal): MaterializeResult {
  const fields = proposal.fields

  if (proposal.kind === 'character') {
    const name = textField(fields, 'name')
    if (name === undefined) return refuse('CANDIDATE_FIELD_REQUIRED', 'a character candidate needs "name"', 'name')
    const path = `characters/${characterFileName(name)}.md`
    const aliases = listField(fields, 'aliases')
    const voice = listField(fields, 'voice')
    const states = statesField(fields)
    const firstAppearance = numberField(fields, 'firstAppearance')
    const group = textField(fields, 'group')
    const role = textField(fields, 'role')
    const pov = textField(fields, 'pov')
    return {
      ok: true,
      value: {
        path,
        text: renderCharacterCard(
          {
            id: randomUUID(),
            name,
            ...(aliases.length === 0 ? {} : { aliases }),
            ...(group === undefined ? {} : { group }),
            ...(role === undefined ? {} : { role }),
            ...(pov === undefined ? {} : { pov }),
            ...(firstAppearance === undefined ? {} : { firstAppearance }),
            ...(voice.length === 0 ? {} : { voice }),
            ...(states.length === 0 ? {} : { states }),
          },
          textField(fields, 'body'),
        ),
      },
    }
  }

  if (proposal.kind === 'world') {
    const title = textField(fields, 'title')
    if (title === undefined) return refuse('CANDIDATE_FIELD_REQUIRED', 'a world candidate needs "title"', 'title')
    const category = textField(fields, 'category')
    if (category !== undefined && (!isPortableSlug(category) || category.includes('/'))) {
      return refuse('CANDIDATE_FIELD_INVALID', `"${category}" is not a portable category name`, 'category')
    }
    const at = documentPath('world', title)
    if (!at.ok) return at
    const path = category === undefined ? at.path : `world/${category}/${at.path.slice('world/'.length)}`
    const parent = textField(fields, 'parent')
    const priority = numberField(fields, 'priority')
    // The same keyword rule the tool applies: a keyword carrying a separator cannot
    // survive `keywords: [a, b]`, so accepting it would write a document whose trigger word
    // is silently different from the candidate the author approved.
    const keywords = listField(fields, 'keywords')
    const badKeyword = keywordProblem(keywords)
    if (badKeyword !== undefined) {
      return refuse(
        'KEYWORD_INVALID',
        `the keyword "${badKeyword}" contains a separator (comma, bracket or newline) the frontmatter cannot read back`,
        'keywords',
      )
    }
    return {
      ok: true,
      value: {
        path,
        text: renderWorldFile({
          id: path,
          title,
          ...(category === undefined ? {} : { category }),
          ...(parent === undefined ? {} : { parent }),
          keywords,
          always: fields['always'] === true,
          ...(priority === undefined ? {} : { priority }),
          body: textField(fields, 'body') ?? '',
        }),
      },
    }
  }

  if (proposal.kind === 'outline') {
    const title = textField(fields, 'title')
    const kind = textField(fields, 'kind')
    if (title === undefined) return refuse('CANDIDATE_FIELD_REQUIRED', 'an outline candidate needs "title"', 'title')
    if (kind === undefined) return refuse('CANDIDATE_FIELD_REQUIRED', 'an outline candidate needs "kind"', 'kind')
    // The overall outline has one conventional address (I-01 speaks of
    // `outlines/overall.md`), so a candidate for it lands there instead of at a slug
    // derived from the book's title.
    let path: string
    if (kind === 'overall') {
      path = 'outlines/overall.md'
    } else {
      const at = documentPath('outlines', title)
      if (!at.ok) return at
      path = at.path
    }
    const points: OutlinePlotPoint[] = []
    for (const raw of listField(fields, 'plotPoints')) {
      const point = parsePlotPointItem(raw)
      if (point !== undefined) points.push(point)
    }
    const order = numberField(fields, 'order')
    const parent = textField(fields, 'parent')
    const body = textField(fields, 'body')
    return {
      ok: true,
      value: {
        path,
        text: renderOutlineDocument({
          fields: {
            id: path,
            kind,
            title,
            // `null` is "no parent": a fresh document writes `parent: null`, which is
            // how `parseOutlineDocument` reads an overall or a loose chapter back.
            parent: parent ?? null,
            ...(order === undefined ? {} : { order }),
          },
          ...(body === undefined ? { plotPoints: points } : { body }),
        }),
      },
    }
  }

  if (proposal.kind === 'timeline') {
    const title = textField(fields, 'title')
    if (title === undefined) return refuse('CANDIDATE_FIELD_REQUIRED', 'a timeline candidate needs "title"', 'title')
    const at = documentPath('timeline', title)
    if (!at.ok) return at
    const status = (textField(fields, 'status') ?? 'confirmed') as TimelineStatus
    const narrativeOrder = numberField(fields, 'narrativeOrder')
    const participants = listField(fields, 'participants')
    const worldTime = textField(fields, 'worldTime')
    const chapter = textField(fields, 'chapterId')
    const body = textField(fields, 'body')
    return {
      ok: true,
      value: {
        path: at.path,
        text: renderTimelineDocument({
          fields: {
            id: at.path,
            title,
            status,
            ...(worldTime === undefined ? {} : { worldTime }),
            ...(narrativeOrder === undefined ? {} : { narrativeOrder }),
            ...(chapter === undefined ? {} : { chapter }),
            ...(participants.length === 0 ? {} : { participants }),
          },
          ...(body === undefined ? {} : { body }),
        }),
      },
    }
  }

  if (proposal.kind === 'foreshadowing') {
    const title = textField(fields, 'title')
    if (title === undefined) return refuse('CANDIDATE_FIELD_REQUIRED', 'a foreshadow candidate needs "title"', 'title')
    const at = documentPath('foreshadowing', title)
    if (!at.ok) return at
    const status = (textField(fields, 'status') ?? 'planted') as ForeshadowStatus
    const plantedAt = textField(fields, 'plantedAt')
    const dueBy = textField(fields, 'dueBy')
    const resolvedChapter = textField(fields, 'resolvedChapter')
    const body = textField(fields, 'body')
    return {
      ok: true,
      value: {
        path: at.path,
        text: renderForeshadowDocument({
          fields: {
            id: at.path,
            title,
            status,
            advancedAt: listField(fields, 'advancedAt'),
            linkedEntities: listField(fields, 'linkedEntities'),
            ...(plantedAt === undefined ? {} : { plantedAt }),
            ...(dueBy === undefined ? {} : { dueBy }),
            ...(resolvedChapter === undefined ? {} : { resolvedChapter }),
          },
          ...(body === undefined ? {} : { body }),
        }),
      },
    }
  }

  // relation
  const source = textField(fields, 'source')
  const target = textField(fields, 'target')
  if (source === undefined) return refuse('CANDIDATE_FIELD_REQUIRED', 'a relation candidate needs "source"', 'source')
  if (target === undefined) return refuse('CANDIDATE_FIELD_REQUIRED', 'a relation candidate needs "target"', 'target')
  const path = defaultRelationPath(source, target)
  const row: RelationRow = {
    id: path,
    path,
    title: textField(fields, 'title') ?? `${source} → ${target}`,
    relationKind: textField(fields, 'kind') === 'knowledge' ? 'knowledge' : 'character',
    source,
    target,
    direction: textField(fields, 'dir') === 'undirected' ? 'undirected' : 'directed',
    since: textField(fields, 'since'),
    until: textField(fields, 'until'),
    chapter: textField(fields, 'chapter'),
  }
  // A fresh relation file has no prose: the renderer's own text is the block. A body
  // in the candidate is appended after it, one blank line apart.
  const block = renderRelationFile(undefined, row)
  const prose = textField(fields, 'body')
  return { ok: true, value: { path, text: prose === undefined ? block : `${block}${prose}\n` } }
}

/** One candidate's outcome: what was written, or why nothing was. */
export interface AcceptOutcome {
  readonly candidateId: string
  readonly kind: ExtractKind
  readonly accepted: boolean
  /** Project-relative path of the written file (accepted only). */
  readonly path?: string
  /** True when an existing file was replaced (only with an explicit `overwrite`). */
  readonly overwritten?: boolean
  /** True when the book already said this, so nothing had to be written. */
  readonly unchanged?: boolean
  readonly error?: AcceptRefusal
}

export interface AcceptReport {
  readonly outcomes: readonly AcceptOutcome[]
  readonly accepted: number
  readonly refused: number
}

/**
 * Extraction kind → the domain module that owns it.
 *
 * Two vocabularies, on purpose: a candidate names the *entity* (ADR-0017 D2:
 * `character`, `outline`, `relation`), while a domain module names its *content
 * directory* (`conventions.md`: `characters/`, `outlines/`, `relations/`). Mapping
 * them in one table here keeps either half from renaming itself to match the other,
 * which would be a data-model change and not a naming preference.
 */
const DOMAIN_DIR_BY_EXTRACT_KIND: Readonly<Record<ExtractKind, string>> = {
  character: 'characters',
  world: 'world',
  outline: 'outlines',
  timeline: 'timeline',
  foreshadowing: 'foreshadowing',
  relation: 'relations',
}

function domainFor(kind: ExtractKind, modules: readonly DomainModule[]): DomainModule | undefined {
  const dir = DOMAIN_DIR_BY_EXTRACT_KIND[kind]
  return modules.find((module) => module.kind === dir)
}

/**
 * Copy `path` into a sealed `replace` backup package before an overwrite (X-17).
 *
 * Sealed immediately rather than held open across the batch: one file is replaced per
 * candidate, so a package per overwrite is the honest unit — "which file did this click
 * replace" stays answerable from the directory name alone.
 */
function backupFileBeforeOverwrite(root: string, path: string): { ok: true; dir: string } | { ok: false; code: string; message: string } {
  const opened = openBackup(root, 'replace')
  if (!opened.ok) return { ok: false, code: opened.error.code, message: opened.error.message }
  const handle = opened.value
  const staged = stageFile(root, handle, path)
  if (!staged.ok) return { ok: false, code: staged.error.code, message: staged.error.message }
  const body = newBackupBody()
  if (staged.value !== undefined) {
    body.steps.push(`stage ${path}`)
    body.files.push({ path, change: 'modified', before: staged.value })
  }
  const sealed = sealBackup(root, handle, 'replace', body, true)
  if (!sealed.ok) return { ok: false, code: sealed.error.code, message: sealed.error.message }
  return { ok: true, dir: handle.dir }
}

function storeError(error: ExtractError): AcceptRefusal {
  return { code: error.code, message: error.message }
}

/**
 * What the project already holds at a candidate's address.
 *
 * The author's rule: the same entity extracted twice is not a conflict to report — if the
 * content is the same there is nothing to review, and if it differs they want to be asked
 * whether to overwrite. So the judge answers with *this* instead of a flat refusal, and
 * the caller decides:
 *
 *   - `propose` drops `identical` ones and keeps `different` ones in the queue (marked);
 *   - `accept` writes `different` ones only with an explicit `overwrite`, after a backup.
 */
export interface ExistingEntity {
  readonly state: 'identical' | 'different'
  /** The file that already holds this identity (the address a write would replace). */
  readonly path: string
  /** sha256 of those bytes, so an edit after the decision is never clobbered. */
  readonly digest?: string
  /** Which of the candidate's own fields differ; empty when identical. */
  readonly changedFields: readonly string[]
}

/**
 * "Would this candidate land, and as what?" — the ONE judgement.
 *
 * Accept runs it and writes when it says yes; `inkflow_extract_propose` runs the very same
 * function, so what the queue promises and what accepting does cannot drift (a second
 * judge would drift the first time a domain gained an invariant).
 *
 * Three outcomes:
 *   - no `existing` → a plain create;
 *   - `existing.state === 'identical'` → the book already says this: nothing to review,
 *     nothing to write;
 *   - `existing.state === 'different'` → same identity, other content: overwriting is the
 *     author's decision, so `accept` demands `overwrite: true`.
 * A real conflict (an id owned by a *different* kind of entity, an invariant the domain
 * refuses, an unreadable document) is still `{ ok: false }`.
 *
 * Read-only: scans the files, parses the rendered document, folds it into the view and asks
 * the domain's own `validate()`. The write stays in `acceptCandidates`.
 *
 * `view` is optional so a caller judging a whole batch can scan once: nothing is written
 * between those calls, so one snapshot is honest — with the documented consequence that two
 * candidates *of the same batch* are judged independently (accept re-scans per candidate and
 * would see the first one's write).
 */
export function judgeCandidate(input: {
  readonly root: string
  readonly kind: ExtractKind
  readonly fields: Readonly<Record<string, unknown>>
  readonly modules?: readonly DomainModule[]
  readonly view?: DomainWriteView
}): { ok: true; path: string; text: string; existing?: ExistingEntity } | { ok: false; error: AcceptRefusal } {
  const domain = domainFor(input.kind, input.modules ?? DOMAIN_MODULES)
  if (domain === undefined) return refuse('CANDIDATE_KIND_INVALID', `no domain module owns "${input.kind}"`)

  // A synthetic proposal: judging must not depend on an id, an evidence string or a status
  // — those are the queue's business, not the document's.
  const materialized = materializeCandidate({
    candidateId: 'ex-00000000',
    kind: input.kind,
    fields: input.fields,
    evidence: '',
    rationale: '',
    confidence: 'medium',
    status: 'proposed',
  })
  if (!materialized.ok) return materialized
  const { path, text } = materialized.value

  // Scan only when the caller did not hand one in: `propose` judges a whole batch against
  // a single snapshot (nothing is written between those calls), and rescanning per
  // candidate there would walk the book once per candidate for no gain.
  const view: DomainWriteView =
    input.view ??
    (() => {
      const scan = scanProject(input.root)
      return { scan: { tables: scan.tables, entities: scan.entities, issues: scan.issues }, entities: scan.entities }
    })()

  // Who owns this identity? A character card is keyed on its **name** (I-03), so the card
  // that already carries this folded name is the entity in question even when the file name
  // would differ; every other kind is keyed by path/id. A name taken by a card whose path
  // differs is therefore "the same entity", not a hard conflict — which is exactly the case
  // the author hit when the same person was extracted twice.
  let occupant: { path: string } | undefined
  if (input.kind === 'character') {
    const plan = planCharacterUpsert({
      name: textField(input.fields, 'name') ?? '',
      aliases: listField(input.fields, 'aliases'),
      existing: rowsOf<CharacterRow>(view.scan, 'characters'),
    })
    if (!plan.ok) {
      if (plan.conflictPath === undefined) return refuse(plan.code, plan.message, plan.conflictPath)
      occupant = { path: plan.conflictPath }
    }
  }

  const parsed = domain.parseFile({ root: input.root, path, text })
  if (parsed.issues.length > 0) {
    const issue = parsed.issues[0]
    return refuse(issue?.code ?? 'FRONTMATTER_ISSUE', issue?.detail ?? 'the document could not be parsed', path)
  }

  if (occupant === undefined) {
    const targetId = parsed.entity?.id ?? path
    const byPath = view.entities.find((entity) => entity.path === path)
    const byId = view.entities.find((entity) => entity.id === targetId && entity.path !== path)
    if (byId !== undefined && parsed.entity !== undefined && byId.kind !== parsed.entity.kind) {
      // The same id owned by another kind is not "the same entity": replacing it would
      // delete a different file's identity, so this stays a hard refusal.
      return refuse('DUPLICATE_ID', `id "${targetId}" is already used by ${byId.path} (I-04)`, byId.path)
    }
    const found = byPath ?? byId
    occupant = found === undefined ? undefined : { path: found.path }
  }

  if (occupant !== undefined) {
    const comparison = compareWithExisting(input.root, occupant.path, text, input.fields)
    const fingerprint = fingerprintProjectFile(input.root, occupant.path)
    // `comparison === undefined` means the index remembered a file that is gone now: the
    // filesystem says "nothing there", so the candidate is a plain create.
    if (comparison !== undefined) {
      return {
        ok: true,
        path: occupant.path,
        text,
        existing: {
          state: comparison.state,
          path: occupant.path,
          ...(fingerprint === undefined ? {} : { digest: fingerprint.sha256 }),
          changedFields: comparison.changedFields,
        },
      }
    }
  }

  const post = applyCandidate(view, parsed)
  const blocking = domain
    .validate({ root: input.root, scan: post.scan, entities: post.entities, candidate: { path } })
    .filter((issue) => issue.path === undefined || issue.path === path)
  if (blocking.length > 0) {
    const issue = blocking[0]
    return refuse(issue?.code ?? 'INVALID', issue?.detail ?? 'the entity breaks an invariant', path)
  }

  return { ok: true, path, text }
}


/**
 * Accept candidates: one document each, through the seam, then marked `accepted`.
 *
 * All of it happens under **one** project write lock: the batch is one author-visible
 * operation and two half-applied batches are worse than one refused one. A candidate
 * that fails is skipped — its status stays `proposed`, nothing is written for it — and
 * the rest still land, so the model can fix one candidate without resubmitting a
 * batch the author already reviewed.
 *
 * The lock itself can refuse (`PROJECT_BUSY`): that is reported, never retried.
 */
export function acceptCandidates(
  root: string,
  candidateIds: readonly string[],
  modules: readonly DomainModule[] = DOMAIN_MODULES,
  options: { readonly overwrite?: boolean } = {},
): { ok: true; value: AcceptReport } | { ok: false; error: AcceptRefusal } {
  const locked = withProjectWriteLock(root, (lock): AcceptReport => {
    const projectRoot = lock.root
    const store = readCandidateStore(projectRoot)
    const byId = new Map<string, CandidateRecord>(store.records.map((record) => [record.proposal.candidateId, record]))
    const outcomes: AcceptOutcome[] = []
    const acceptedRefs: { file: string; candidateId: string }[] = []

    for (const candidateId of candidateIds) {
      const record = byId.get(candidateId)
      if (record === undefined) {
        outcomes.push({
          candidateId,
          kind: 'character',
          accepted: false,
          error: { code: 'CANDIDATE_NOT_FOUND', message: `no candidate has the id ${candidateId}` },
        })
        continue
      }
      const proposal = record.proposal
      const failed = (error: AcceptRefusal): void => {
        outcomes.push({ candidateId, kind: proposal.kind, accepted: false, error })
      }

      if (proposal.status !== 'proposed') {
        failed({ code: 'CANDIDATE_ALREADY_PROCESSED', message: `${candidateId} is already ${proposal.status}` })
        continue
      }
      // The verdict comes from `judgeCandidate` — the same function `propose` calls to
      // mark `willFail`, so what the panel promised and what accept does cannot
      // drift. A fresh scan happens inside it per candidate: the previous candidate in
      // this batch may have added a file, and judging the next one against a stale view
      // could let two candidates collide in the index after both were "validated".
      const judged = judgeCandidate({ root: projectRoot, kind: proposal.kind, fields: proposal.fields, modules })
      if (!judged.ok) {
        failed(judged.error)
        continue
      }
      const { path, text } = judged
      const existing = judged.existing

      // The book already says exactly this: nothing to review and nothing to write, so the
      // candidate is closed out rather than reported as a failure.
      if (existing !== undefined && existing.state === 'identical') {
        outcomes.push({ candidateId, kind: proposal.kind, accepted: true, path, unchanged: true })
        acceptedRefs.push({ file: record.file, candidateId })
        continue
      }

      // Same identity, other content: replacing an entity is the author's call, so it takes
      // an explicit `overwrite`. The digest from the judgement is the CAS baseline — if the
      // file changed between the panel decision and this click, nothing is clobbered.
      if (existing !== undefined && existing.state === 'different') {
        if (options.overwrite !== true) {
          failed({
            code: 'OVERWRITE_REQUIRED',
            message:
              `${path} already exists with different content (${existing.changedFields.join(', ')}); ` +
              'accepting would replace it — ask the author, then call again with overwrite: true',
            path,
          })
          continue
        }
        // The baseline is the digest recorded when the AUTHOR decided (propose time), not
        // the one this judgement just measured — otherwise an edit made in between would
        // always look consistent and be silently clobbered.
        const baseline = proposal.duplicate?.digest ?? existing.digest
        const current = fingerprintProjectFile(projectRoot, path)
        if (baseline !== undefined && current !== undefined && current.sha256 !== baseline) {
          failed({
            code: 'FILE_CHANGED',
            message: `${path} changed after this candidate was judged; re-read the entity and decide again`,
            path,
          })
          continue
        }
        // X-17: a batch that replaces an existing file opens a backup package first, so
        // "undo that overwrite" never depends on git.
        const backupDir = backupFileBeforeOverwrite(projectRoot, path)
        if (!backupDir.ok) {
          failed({ code: backupDir.code, message: backupDir.message, path })
          continue
        }
        const replaced = writeTextAtomic(projectRoot, path, text)
        if (!replaced.ok) {
          failed({ code: replaced.error.code, message: replaced.error.message, path })
          continue
        }
        outcomes.push({ candidateId, kind: proposal.kind, accepted: true, path, overwritten: true })
        acceptedRefs.push({ file: record.file, candidateId })
        continue
      }

      const written = writeTextAtomic(projectRoot, path, text)
      if (!written.ok) {
        failed({ code: written.error.code, message: written.error.message, path })
        continue
      }
      outcomes.push({ candidateId, kind: proposal.kind, accepted: true, path: written.target.relative })
      acceptedRefs.push({ file: record.file, candidateId })
    }

    // The queue records the decision last: `accepted` on a candidate whose file never
    // landed would be a lie the reviewer cannot see in the panel.
    if (acceptedRefs.length > 0) {
      const statuses = setCandidateStatuses(projectRoot, acceptedRefs, 'accepted', ['proposed'])
      const failedStatus = statuses.find((outcome) => !outcome.ok)
      if (failedStatus !== undefined && !failedStatus.ok) {
        for (const ref of acceptedRefs) {
          const index = outcomes.findIndex((outcome) => outcome.candidateId === ref.candidateId)
          if (index < 0) continue
          const current = outcomes[index]
          if (current === undefined) continue
          outcomes[index] = {
            candidateId: current.candidateId,
            kind: current.kind,
            accepted: false,
            ...(current.path === undefined ? {} : { path: current.path }),
            error: {
              code: failedStatus.error.code,
              message: `the file was written but the queue could not record it: ${failedStatus.error.message}`,
            },
          }
        }
      }
    }

    const accepted = outcomes.filter((outcome) => outcome.accepted).length
    return { outcomes, accepted, refused: outcomes.length - accepted }
  })

  if (!locked.ok) return { ok: false, error: storeError({ code: 'CANDIDATE_STORE_UNREADABLE', message: `${locked.error.code}: ${locked.error.message}` }) }
  return { ok: true, value: locked.value }
}
