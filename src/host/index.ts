/**
 * dsh-inkflow — Host half.
 *
 * Architecture (ADR-0005): **files are the truth**, SQLite is a rebuildable
 * derived index living inside each project's `index/` directory. There is no
 * plugin-wide database and therefore no database migration: a project outlives
 * every plugin upgrade, and a new index layout is just a new schema version
 * that causes a delete-and-rebuild.
 *
 * HARD DSH CONSTRAINTS this file obeys (verified on 0.2.1-rc.2):
 *   - The plugin API is release-candidate: depend only on `ctx.*` public surface.
 *   - No runtime imports of `@deepseek-ai/*` (see src/host/context.ts).
 *   - Plugin code runs un-sandboxed with the user's own permissions; the plugin
 *     must validate its own inputs and never trust the browser.
 *   - Never append new event types to a session log.
 */

import type { HostContext } from './context.js'
import { resolveConfig } from './config.js'
import { BUNDLED_SKILL_NAMES, bundledSkillsDir, registerInkflowSkills } from './skills.js'
import { buildWritingPreset, registerWritingPreset } from './preset.js'
import { describeError } from './probe.js'
import { readState } from './state.js'
import { buildTools } from './tools.js'
import { createHttpHandler } from './routes.js'

export const name = 'dsh-inkflow'

/**
 * The writing surface (issue #21) is re-exported for the contract tests, which
 * import `lib/index.js` only and must drive what users install — the bundled
 * skills and the preset declaration are data this plugin owns, so the assembly
 * inputs are part of that surface.
 */
export {
  BUNDLED_SKILL_NAMES,
  SKILL_PROVIDER_NAME,
  SKILL_RANK,
  bundledSkillsDir,
  createInkflowSkillProvider,
  isWritingWorkspace,
  loadBundledSkills,
  readBundledSkill,
  registerInkflowSkills,
} from './skills.js'
export type { BundledSkill, SkillFileProblem, SkillRegistration } from './skills.js'
export { WRITING_PRESET_ID, buildWritingPreset, registerWritingPreset, writingPersona } from './preset.js'
export type { PresetRegistration } from './preset.js'

/**
 * The frontmatter reader/writer is re-exported from the bundle entry so the
 * contract tests can drive it directly (they import lib/index.js only). The P1
 * proposal writer uses the same pair in-process, so this is not a test-only
 * surface: `parseMarkdown` reads a file, `patchFrontmatter` rewrites one line.
 */
export { parseMarkdown, patchFrontmatter } from './frontmatter.js'
export type { FrontmatterPatchResult, ParsedMarkdown } from './frontmatter.js'

/** Hard dependency: the tool registry. `webServer` is injected lazily. */
export const inject = ['tools']

const VERSION = '0.0.2'

/**
 * Index-build API for embedders and tests. Tools/routes use these too; exporting
 * them from the entry point keeps the structured error contract addressable
 * without pulling in plugin assembly (`IndexBuildError` is the documented
 * failure type for `buildIndex`).
 */
export { buildIndex, describeIndexBuildFailure, IndexBuildError } from './index-build.js'
export type { IndexBuildErrorCode, IndexBuildFailure } from './index-build.js'
export type { IndexBuildResult } from './indexer.js'

/**
 * Write-layer API (issue #14): the single door for project file writes.
 * Exported for the tests now and for the chapter/scaffolding writers next; no
 * tool registers against it yet, so this adds no model-facing surface.
 */
export {
  acquireProjectWriteLock,
  resolveWriteTarget,
  withProjectWriteLock,
  writeJsonAtomic,
  writeTextAtomic,
} from './io.js'
export type {
  AtomicWriteOptions,
  IoErrorCode,
  IoFailure,
  IoResult,
  ProjectLock,
  ProjectLockResult,
  ResolveWriteTargetResult,
  WriteResult,
  WriteTarget,
} from './io.js'
export { WRITE_DIRS } from './conventions.js'

/**
 * Volume/chapter catalog (issue #15, ADR-0006 D6): a reviewable, committed
 * projection of the `.md` structure. The read path never writes; rebuilds take
 * the project write lock and replace both files atomically; validation reports
 * drift instead of blocking. No tool registers against it yet.
 */
export { readCatalog, rebuildCatalog, validateCatalog } from './catalog.js'
export type {
  CatalogChapter,
  CatalogIssue,
  CatalogIssueCode,
  CatalogReadResult,
  CatalogRebuildResult,
  CatalogValidateResult,
  CatalogVolume,
  RootCatalog,
  VolumeCatalog,
} from './catalog.js'

/** Exported for the tests (and embedders) so the gate can be asserted after a catalog change. */
export { inspectProject } from './project.js'
export type { ProjectProbe, ProjectState } from './project.js'

export function apply(ctx: HostContext, rawConfig: unknown): void {
  const config = resolveConfig(rawConfig)
  const log = ctx.logger('dsh-inkflow')

  log.info(`ready: files-first mode, plugin state=${config.dataDir}`)

  // state.json is display-only (issue #7): it records the last project some
  // session touched, purely so a human can see it in the logs. It is never used
  // to resolve a project — one plugin-wide value cannot speak for a session.
  const remembered = readState(config.dataDir).lastProjectRoot
  if (remembered !== undefined) log.info(`last touched project (display only, not used for resolution): ${remembered}`)

  // Writing craft (issue #21). Both halves probe for their Host service and
  // degrade to a single log line: a profile without `skills` / `agentPresets`
  // still gets the tools and the routes, and the skills/ files still ship.
  // Wrapped whole: a rejected registration (a duplicate provider name from a
  // second row mounting this package, say) must not cost the user their tools.
  try {
    const skills = registerInkflowSkills(ctx, { dir: bundledSkillsDir(import.meta.url), log })
    registerWritingPreset(
      ctx,
      buildWritingPreset(skills.names.length > 0 ? skills.names : [...BUNDLED_SKILL_NAMES]),
      log,
    )
  } catch (error) {
    log.warn(`writing surface skipped: ${describeError(error)}`)
  }

  const tools = ctx.tools
  if (tools === undefined) {
    log.warn('tools service missing; inkflow_* tools are not registered')
  } else {
    for (const definition of buildTools({ ctx, dataDir: config.dataDir, version: VERSION })) {
      ctx.effect(() => tools.register(definition))
    }
    log.info('inkflow_* tools registered (files-first, derived index)')
  }

  if (config.serveHttp) {
    ctx.inject(['webServer'], (scoped) => {
      const webServer = scoped.webServer
      if (webServer === undefined) return
      scoped.effect(() =>
        webServer.register({
          kind: 'prefix',
          path: '/inkflow',
          handler: createHttpHandler({ ctx, dataDir: config.dataDir, version: VERSION }),
        }),
      )
      log.info('http routes registered under /inkflow')
    })
  }
}
