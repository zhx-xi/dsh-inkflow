/**
 * Model-facing tool surface (ADR-0005: files are the truth, the index is a cache).
 *
 * Design rules for this file:
 *   - Every business tool resolves the project from the *session working
 *     directory* (walking up), never from a plugin registry.
 *   - A gate refusal is a structured checklist, not an exception: the model
 *     needs `state` / `missing` / `actions`, not a stack (ADR-0006 D2).
 *   - The derived index is rebuilt on demand; nothing here migrates a database.
 *   - Nothing is written before `confirm: true`; the wizard's `plan` step is
 *     strictly read-only (ADR-0006 D3).
 *
 * Since #193 this file is the registry, not the tools. Every built-in lives in one
 * file per domain under `./tools/` (`project-tools.ts`, `chapter-tools.ts`,
 * `search-tools.ts`, `audit-tools.ts`, `gate-tools.ts`, `shared-library-tools.ts`,
 * `import-tools.ts`), the shapes they all return live in `./tools/shared.ts`, and
 * what is left here is the assembly and the export — so a new tool adds a line to
 * one small file instead of growing a two-thousand-line one.
 */

import type { ToolDefinition } from './context.js'
import { DOMAIN_MODULES, domainTools } from './domains/index.js'
import type { DomainModule } from './domains/types.js'
import { repairTools } from './repair-tools.js'
import { settingsTools } from './settings-tools.js'
import { extractTools } from './extract-tools.js'
import { semanticTools } from './ovk-tools.js'
import { etlTools } from './etl-tools.js'
import { reviewTools } from './review-tools.js'
import { proposalTools } from './proposal-tools.js'
import { jobsTools } from './jobs-tools.js'
import { exportTools } from './export-tools.js'
import { seriesTools } from './series-tools.js'
import { auditTools } from './tools/audit-tools.js'
import { chapterReadTools, chapterTools } from './tools/chapter-tools.js'
import { gateTools } from './tools/gate-tools.js'
import { importTools } from './tools/import-tools.js'
import { projectTools, projectWizardTools } from './tools/project-tools.js'
import { searchTools } from './tools/search-tools.js'
import { sharedLibraryTools } from './tools/shared-library-tools.js'
import type { ToolDeps } from './tools/shared.js'

export type { ToolDeps }
export { TOOL_OUTPUT_SCHEMA } from './tools/shared.js'

/**
 * The project resolution and the four-state refusal are shared with the domain-owned
 * tools, so both live in `domains/tool-project.ts` (#25 review, D-4). The copy that used
 * to sit here had already drifted: the character tools answered a refusal without the
 * `build` summary this file attaches through `withBuild()` below, so the same broken
 * book read as two different situations depending on which tool asked.
 */

/**
 * The model-facing tool table: built-ins first, then every registered domain's
 * tools (roadmap §2.1 X-5). `modules` is injectable so the contract test can prove
 * the aggregate is wired without mutating the production registry.
 *
 * The ORDER below is part of the contract, not a matter of taste: the table is
 * registered in exactly this order and `tests/domain-registry.test.js` pins it
 * name by name. That is why the built-ins come from eight aggregates instead of one
 * per module: `inkflow_chapter_list` sits between `inkflow_index_rebuild` and
 * `inkflow_chapter_search`, and the six volume/chapter writes sit after the wizard
 * pair, so the read side and the write side of `chapter-tools.ts` are two arrays.
 * The trailing comment on each line lists the tools that line contributes.
 */
export function buildTools(deps: ToolDeps, modules: readonly DomainModule[] = DOMAIN_MODULES): ToolDefinition[] {
  return [
    ...projectTools(deps), // project_status, index_rebuild
    ...chapterReadTools(deps), // chapter_list
    ...searchTools(deps), // chapter_search, search, search_replace
    ...auditTools(deps), // project_audit
    // The quality gate (#44): seven checks over one chapter plus the verdict file.
    ...gateTools(deps), // gate_check
    ...importTools(deps), // library_import
    ...projectWizardTools(deps), // project_plan, project_init
    ...chapterTools(deps), // volume_create, volume_rename, chapter_create, chapter_write, chapter_move, chapter_delete
    // Maintenance (#36): repair and migration own their own gate allowance (a book
    // that is `needs-repair` must still be repairable) and their own module.
    ...repairTools(deps),
    // The shared library (#40): one read, two writes, all in one direction
    // (`shared-copy.ts`). Registered after the maintenance pair because they are
    // the most recent built-ins and the surface baseline lists them in this order.
    ...sharedLibraryTools(deps), // shared_list, shared_copy, shared_update
    // The plugin's own state (#42): settings, the diagnostics package and the local
    // backups. They live outside any book, so they ship as one module with one gate
    // policy of their own. `toolSurface` is a provider because the diagnostics package
    // lists what this table registers, and building the table again at export time is
    // the only way to name the real surface without a module cycle.
    ...settingsTools({ ...deps, toolSurface: () => buildTools(deps, modules) }),
    // The extraction queue (#38, ADR-0017): propose / list / accept / reject / purge.
    // Built-ins rather than domain tools: a candidate is not an entity and belongs to no
    // content directory, so no domain module owns this surface.
    ...extractTools(deps),
    // Semantic retrieval (#41): status / rebuild / purge. One module, because all three
    // read the same availability verdict and the same block ledger, and the purge is the
    // only path in this plugin allowed to call OVK's physical delete (ADR-0009 P6).
    ...semanticTools(deps),
    // The old-library migrator (#51): plan / apply / rollback. A built-in for the same
    // reason as the pair above — it writes into every content directory, so no single
    // domain module owns it, and its dry run must be the same computation as its apply.
    ...etlTools(deps),
    // The review DAG (#46, ADR-0022 D3, X-26): run / context / compare. Built-ins for the
    // same reason as the pair above — a review reads one chapter plus two setting
    // directories and writes a run record under `.inkflow/review/`, so no content
    // directory owns it, and the plugin embeds no model client to produce the opinions.
    ...reviewTools(deps),
    // Proposals (#45, ADR-0023, X-26): create / decide / apply / rollback. A built-in rather
    // than a domain tool — a proposal is not an entity, belongs to no content directory, and
    // its one write path is the chapter writer, which no domain module owns.
    ...proposalTools(deps),
    // The batch queue (#47, ADR-0023, X-26/X-30): enqueue / take / complete / approve. Built-ins
    // for the same reason as the pair above — a job is not an entity, belongs to no content
    // directory, and the plugin embeds no model client to draft the chapters it queues.
    ...jobsTools(deps),
    // Export (#50, ADR-0024, X-27): one tool, `inkflow_export`, writing an EPUB / DOCX /
    // Markdown / TXT artifact into `dataDir/exports/` and nothing into the book. A built-in
    // rather than a domain tool: it reads every content directory at once, so no single
    // content directory owns it.
    ...exportTools(deps),
    // The series sync (#49, ADR-0007 C2/C5, X-17): plan / apply. Built-ins for the same reason
    // as the shared library they extend — they read the plugin-level library and write into
    // `world/`/`library/`, so no content directory owns them; and `apply` recomputes the plan
    // so it can only write the rows a preview produced.
    ...seriesTools(deps),
    // Domain modules own their own `inkflow_*` tools (roadmap §2.1 X-5): a domain
    // branch adds one line to `DOMAIN_MODULES`, never to the literal above.
    ...domainTools(deps, modules),
  ]
}
