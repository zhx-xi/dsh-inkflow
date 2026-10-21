/**
 * The five writing-craft skills, offered through the Host `skills` registry.
 *
 * WHY A PROVIDER AND NOT `skills.register()`:
 * `register()` files the skill into the *calling* context's layer, which for a
 * repository plugin is the GLOBAL layer — every session, coding ones included,
 * would see five novel-writing skills in its catalog. `registerProvider()` is
 * the documented seam for a workspace-sensitive source instead: the registry
 * passes the session's working directory to `list()`, so this provider can
 * answer "no skills here" for any session that is not inside an InkFlow project
 * (the same trust anchor `inkflow_*` tools resolve projects from). The catalog
 * therefore stays clean outside novels, with no preset required.
 *
 * Content lives in `skills/<name>/SKILL.md` **in the package**, not in this
 * file: a skill is prose an author may want to read, diff and improve, and the
 * registry wants the body verbatim (frontmatter is metadata, the rest is
 * instructions). Bodies are read once at apply time and handed out lazily.
 *
 * Contract source: DSH 0.2.1-rc.2 `cordis_inspect_query` Host Service `skills`
 * (`registerProvider` / `SkillProvider` / `SkillCandidate` / `SkillDefinition`).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type {
  HostContext,
  LogSink,
  SkillCandidateLike,
  SkillDefinitionLike,
  SkillLookupOptionsLike,
  SkillProviderLike,
  SkillRegistryLike,
} from './context.js'
import { parseMarkdown, stringField } from './frontmatter.js'
import { describeError, optionalService } from './probe.js'
import { findProjectRoot } from './project.js'

/** Provider name on `ctx.skills`. Reserved name `runtime` is the only one taken. */
export const SKILL_PROVIDER_NAME = 'inkflow'

/**
 * Ordering weight inside one registry layer. `dsh-skill` documents 600 as the
 * rank for packaged providers and local bundled roots, so a project-level skill
 * of the same name (lower rank) still wins over ours.
 */
export const SKILL_RANK = 600

/**
 * The writing pipeline, in stage order. The directory name IS the skill name:
 * the layout `skills/<name>/SKILL.md` is asserted by tests and by `check:package`,
 * so a renamed skill cannot silently ship without its body.
 */
export const BUNDLED_SKILL_NAMES = [
  'inkflow-architect',
  'inkflow-writer',
  'inkflow-auditor',
  'inkflow-reviser',
  'inkflow-polisher',
] as const

export interface BundledSkill {
  name: string
  description: string
  whenToUse?: string
  /** SKILL.md body, frontmatter excluded, verbatim. */
  content: string
  /** Absolute path of the SKILL.md this entry was read from. */
  path: string
}

/** A missing or unparsable skill file. Never thrown at apply time: logged. */
export interface SkillFileProblem {
  name: string
  message: string
}

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Read one `skills/<name>/SKILL.md`.
 *
 * Throws with a precise message (which field, which file) because the caller is
 * either a test — where the throw is the assertion — or apply-time code that
 * records the message as a warning.
 */
export function readBundledSkill(dir: string, name: string): BundledSkill {
  const path = join(dir, name, 'SKILL.md')
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${path}: ${describeError(error)}`)
  }

  const parsed = parseMarkdown(raw)
  if (!parsed.hasFrontmatter) throw new Error(`${path} has no frontmatter block`)

  const declared = stringField(parsed.data, 'name')
  if (declared === undefined || declared.trim() === '') throw new Error(`${path} has no name in its frontmatter`)
  if (declared !== name) {
    throw new Error(`${path} declares name "${declared}" but its directory is "${name}": one of them is stale`)
  }
  if (!SKILL_NAME_PATTERN.test(declared)) {
    throw new Error(`${path} declares name "${declared}", which is not kebab-case (the registry rejects it)`)
  }

  const description = stringField(parsed.data, 'description')
  if (description === undefined || description.trim() === '') {
    throw new Error(`${path} has no description (the catalog shows it, so the registry requires it)`)
  }

  const body = parsed.body.trim()
  if (body === '') throw new Error(`${path} has frontmatter but no body: a skill without instructions is useless`)

  const whenToUse = stringField(parsed.data, 'whenToUse')
  const skill: BundledSkill = { name: declared, description: description.trim(), content: body, path }
  if (whenToUse !== undefined && whenToUse.trim() !== '') skill.whenToUse = whenToUse.trim()
  return skill
}

/** Read the whole bundled set, collecting per-file problems instead of throwing. */
export function loadBundledSkills(
  dir: string,
  names: readonly string[] = BUNDLED_SKILL_NAMES,
): { skills: BundledSkill[]; problems: SkillFileProblem[] } {
  const skills: BundledSkill[] = []
  const problems: SkillFileProblem[] = []
  for (const name of names) {
    try {
      skills.push(readBundledSkill(dir, name))
    } catch (error) {
      problems.push({ name, message: describeError(error) })
    }
  }
  return { skills, problems }
}

/** True when `cwd` sits inside an InkFlow project (same walk as the tools use). */
export function isWritingWorkspace(cwd: string): boolean {
  return findProjectRoot(cwd) !== undefined
}

/**
 * The borrowed provider handed to `ctx.skills.registerProvider`.
 *
 * `list()` answers `[]` — not an "incomplete" observation — outside a novel
 * project. The distinction matters: an incomplete observation suppresses the
 * whole catalog in `dsh-tool-skill`, while an empty complete one correctly says
 * "this session has no InkFlow skills".
 */
export function createInkflowSkillProvider(input: {
  skills: readonly BundledSkill[]
  inWritingWorkspace?: (cwd: string) => boolean
}): SkillProviderLike {
  const byName = new Map(input.skills.map((skill) => [skill.name, skill]))
  const inWritingWorkspace = input.inWritingWorkspace ?? isWritingWorkspace

  const summaryOf = (skill: BundledSkill): Omit<SkillDefinitionLike, 'content'> => ({
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'bundled',
    provider: SKILL_PROVIDER_NAME,
    path: skill.path,
    // The model gets the SKILL.md's own directory as its resource base, so
    // "references/…" resolves beside the file instead of in the cwd.
    resourceBase: { kind: 'directory', path: dirname(skill.path) },
  })

  const candidateOf = (skill: BundledSkill): SkillCandidateLike => ({
    ...summaryOf(skill),
    rank: SKILL_RANK,
    locator: skill.name,
  })

  return {
    name: SKILL_PROVIDER_NAME,
    async list(options: SkillLookupOptionsLike): Promise<readonly SkillCandidateLike[]> {
      const cwd = options.cwd
      if (cwd === undefined || cwd === '') return []
      if (!inWritingWorkspace(cwd)) return []
      return [...byName.values()].map(candidateOf)
    },
    async get(candidate: SkillCandidateLike): Promise<SkillDefinitionLike | undefined> {
      const skill = byName.get(candidate.name)
      if (skill === undefined) return undefined
      return { ...summaryOf(skill), content: skill.content }
    },
  }
}

export interface SkillRegistration {
  /** False when the Host has no skills service, or no skill file could be read. */
  registered: boolean
  /** Names actually offered to the registry. */
  names: string[]
  problems: SkillFileProblem[]
}

/**
 * Register the provider for the lifetime of the plugin.
 *
 * Absence is a supported state, not an error: a profile without the skills
 * service still gets the tools and the preset, and gets exactly one log line
 * saying why its catalog has no InkFlow skills.
 */
export function registerInkflowSkills(
  ctx: HostContext,
  options: { dir: string; log: LogSink; names?: readonly string[]; inWritingWorkspace?: (cwd: string) => boolean },
): SkillRegistration {
  const { skills, problems } = loadBundledSkills(options.dir, options.names)
  for (const problem of problems) options.log.warn(`skill file skipped: ${problem.message}`)

  const registry = optionalService<SkillRegistryLike>(
    ctx,
    'skills',
    (value) => typeof value.registerProvider === 'function',
  )
  if (registry === undefined) {
    options.log.info('skills service missing: the writing craft skills ship in skills/ but are not registered')
    return { registered: false, names: [], problems }
  }
  if (skills.length === 0) {
    options.log.warn(`no bundled skill could be read from ${options.dir}: nothing registered`)
    return { registered: false, names: [], problems }
  }

  ctx.effect(() =>
    registry.registerProvider(() =>
      createInkflowSkillProvider({
        skills,
        ...(options.inWritingWorkspace === undefined ? {} : { inWritingWorkspace: options.inWritingWorkspace }),
      }),
    ),
  )
  const names = skills.map((skill) => skill.name)
  options.log.info(`writing skills registered: ${names.join(', ')} (InkFlow project sessions only)`)
  return { registered: true, names, problems }
}

/** `<package>/skills` — `lib/index.js` is one level below the package root. */
export function bundledSkillsDir(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), '..', 'skills')
}
