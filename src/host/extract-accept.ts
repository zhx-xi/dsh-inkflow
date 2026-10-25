/**
 * Turning a candidate into an entity — the one and only write path of extraction
 * (ADR-0017 D4/D5, issue #38).
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
import { readCandidateStore, setCandidateStatuses } from './extract.js'
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
    // The same keyword rule the tool applies (#169): a keyword carrying a separator cannot
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

function storeError(error: ExtractError): AcceptRefusal {
  return { code: error.code, message: error.message }
}

/**
 * "Would this candidate land, and as what?" — the ONE judgement (#175).
 *
 * Accept runs it and writes when it says yes; `inkflow_extract_propose` runs the very
 * same function and stores the refusal on the candidate as `willFail`, so the author
 * learns that 5 of 30 candidates are doomed *before* clicking accept, and the two
 * verdicts can never disagree (a second judge would drift the first time a domain
 * gained an invariant).
 *
 * Read-only: it scans the files, parses the rendered document, folds it into the view
 * and asks the domain's own `validate()`. The write (`writeTextAtomic`) stays in
 * `acceptCandidates`, which is why a refusal here costs the book nothing.
 *
 * `view` is optional so a caller judging a whole batch can scan once: nothing is
 * written between those calls, so one snapshot is honest — with the documented
 * consequence that two candidates *of the same batch* are judged independently
 * (the accept path re-scans per candidate and would refuse the second one).
 */
export function judgeCandidate(input: {
  readonly root: string
  readonly kind: ExtractKind
  readonly fields: Readonly<Record<string, unknown>>
  readonly modules?: readonly DomainModule[]
  readonly view?: DomainWriteView
}): { ok: true; path: string; text: string } | { ok: false; error: AcceptRefusal } {
  const domain = domainFor(input.kind, input.modules ?? DOMAIN_MODULES)
  if (domain === undefined) return refuse('CANDIDATE_KIND_INVALID', `no domain module owns "${input.kind}"`)

  // A synthetic proposal: judging must not depend on an id, an evidence string or a
  // status — those are the queue's business, not the document's.
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

  if (input.kind === 'character') {
    // I-03 has a code of its own and a name is what a reader sees, so a taken name is
    // reported as the name collision it is — `planCharacterUpsert` is the exact judge
    // `inkflow_character_upsert` uses, called with no "own path" exemption: accepting
    // never edits a card.
    const plan = planCharacterUpsert({
      name: textField(input.fields, 'name') ?? '',
      aliases: listField(input.fields, 'aliases'),
      existing: rowsOf<CharacterRow>(view.scan, 'characters'),
    })
    if (!plan.ok) {
      return refuse(plan.code, plan.message, plan.conflictPath)
    }
  }

  const parsed = domain.parseFile({ root: input.root, path, text })
  if (parsed.issues.length > 0) {
    const issue = parsed.issues[0]
    return refuse(issue?.code ?? 'FRONTMATTER_ISSUE', issue?.detail ?? 'the document could not be parsed', path)
  }

  // Accept creates; it never overwrites. A new entity's id is its path for every kind
  // but `character`, so an occupied address is I-04 `DUPLICATE_ID`.
  const targetId = parsed.entity?.id ?? path
  const clash =
    view.entities.find((entity) => entity.path === path) ??
    view.entities.find((entity) => entity.id === targetId && entity.path !== path)
  if (clash !== undefined) {
    return refuse(
      'DUPLICATE_ID',
      clash.path === path
        ? `${path} already holds an entity; accept never overwrites one — edit it, or reject this candidate`
        : `id "${targetId}" is already used by ${clash.path} (I-04)`,
      clash.path,
    )
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
      // mark `willFail` (#175), so what the panel promised and what accept does cannot
      // drift. A fresh scan happens inside it per candidate: the previous candidate in
      // this batch may have added a file, and judging the next one against a stale view
      // could let two candidates collide in the index after both were "validated".
      const judged = judgeCandidate({ root: projectRoot, kind: proposal.kind, fields: proposal.fields, modules })
      if (!judged.ok) {
        failed(judged.error)
        continue
      }
      const { path, text } = judged

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
