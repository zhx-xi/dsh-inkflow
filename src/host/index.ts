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
import { getLoadedBuild } from './build-info.js'
import { resolveConfig } from './config.js'
import { BUNDLED_SKILL_NAMES, bundledSkillsDir, registerInkflowSkills } from './skills.js'
import { buildWritingPreset, registerWritingPreset } from './preset.js'
import { registerWritingContext } from './prompt.js'
import { describeError } from './probe.js'
import { readState } from './state.js'
import { buildTools } from './tools.js'
import { createHttpHandler } from './routes.js'

export const name = 'dsh-inkflow'

/**
 * The writing surface is re-exported for the contract tests, which
 * import `lib/index.js` only and must drive what users install — the bundled
 * skills and the preset declaration are data this plugin owns, so the assembly
 * inputs are part of that surface.
 */

/**
 * The writing context is exported the same way: `buildWritingContext`
 * is the whole projection, and the contract tests assert it directly instead of
 * scraping a fake prompt pipeline. The panel's future briefing preview reuses
 * the same entry point, so this is not a test-only surface.
 */

/**
 * The nine-segment brief (ADR-0022 D1/D2, roadmap X-23/X-25).
 *
 * `buildWritingBrief` is the whole brief as a pure function of the tree (order, caps,
 * ladder, `{id,bytes,tokens,truncated,missing}` per segment), and `briefFor` is the same
 * call plus the process counters the diagnostics package reports. Exporting both — and the
 * audit record/serialiser — is what lets the acceptance tests assert "preview = audit" and
 * "two runs, same bytes" against the artifact users install instead of against internals.
 */

/**
 * The calendar table and its one conversion (roadmap X-28).
 *
 * Exported because the round trip that makes this module worth having —
 * `toAbsolute(fromAbsolute(n)) === n` for every day, leap days and era boundaries
 * included — is a property of the built artifact or it is a claim. The calendar adds
 * the derived absolute-day column to the index and the foreshadow deadline work compares
 * chapters; both call these functions instead of growing a second day count.
 */

/**
 * Where the book's calendar lives, and what a missing/broken one means.
 *
 * Exported beside the arithmetic because they are one contract: `calendar.ts` answers
 * "what day is this", `calendar-book.ts` answers "which table applies to this book" —
 * and a caller that has the first without the second has to guess, which is the failure
 * mode ADR-0025 D1 exists to prevent.
 */

/**
 * The frontmatter reader/writer is re-exported from the bundle entry so the
 * contract tests can drive it directly (they import lib/index.js only). The P1
 * proposal writer uses the same pair in-process, so this is not a test-only
 * surface: `parseMarkdown` reads a file, `patchFrontmatter` rewrites one line.
 */

/**
 * The map tab's pure view model and the panel tab list.
 *
 * Exported so the two claims a user actually sees — "a place is a world entry" and "the map
 * page is reachable" — are assertions on the built artifact rather than on a source file
 * somebody has to keep in mind. The model itself lives in the client half; this is the same
 * re-export the panel's other pure models get, and it stays pure (no React, no IO).
 */

/** Hard dependency: the tool registry. `webServer` is injected lazily. */
// Every re-export lives in plugin-exports.ts; forwarding it keeps the public surface byte
// for byte identical while leaving this file with the assembler.
export * from './plugin-exports.js'
export * from './plugin-exports-channel.js'

export const inject = ['tools']

/**
 * Injected by esbuild from `package.json` (`scripts/build.mjs`).
 *
 * A bundle built without the define — a test bundling this file on the fly — sees the
 * identifier as undefined and degrades instead of failing to load, exactly like
 * `__INKFLOW_BUILD__`. The literal used to live here *and* in `package.json`, and the two
 * drifted for three milestones (package 0.0.2 while the roadmap reached 0.4.0), so the
 * version now has one source and `tests/build-info.test.js` fails when a bump is forgotten.
 */
declare const __INKFLOW_VERSION__: string
const VERSION: string = typeof __INKFLOW_VERSION__ === 'string' && __INKFLOW_VERSION__ !== '' ? __INKFLOW_VERSION__ : '0.0.0-unknown'

/** The version this bundle was built for; the tests compare it with `package.json`. */
export const PLUGIN_VERSION = VERSION

/**
 * Index-build API for embedders and tests. Tools/routes use these too; exporting
 * them from the entry point keeps the structured error contract addressable
 * without pulling in plugin assembly (`IndexBuildError` is the documented
 * failure type for `buildIndex`).
 */

/**
 * Domain module registry: the seam every 0.2.0 data domain plugs into
 * (roadmap §2.1 X-5). Exported so the contract tests can assert that the tool
 * surface is "built-ins + registered modules" and that the pre-write replace
 * (`applyCandidate`) keeps `I-04` honest.
 */
/** Outline planners: pure, so the write-side invariants are test-driven directly. */
/** Cross-class projection queries: the nine-class panel and mention work read through these. */
/** One entity's edges in both roles: the read behind `inkflow_relation_list`. */

/**
 * Relation domain: `planRelationUpsert` is exported so the write-side decision
 * can be driven as a pure function — the same function the tool calls, so a test
 * cannot pass while the tool would refuse (or the other way round). The rest of the
 * domain stays behind `DOMAIN_MODULES`, like every other module.
 */

/**
 * The knowledge graph's type vocabulary and its two contradiction rules — direction and
 * `since`/`until` windows. Exported because a test and a panel need them and each rule has
 * one implementation every net and reader calls (X-4); the window judgement is pure arithmetic, so
 * "1000 edges under 100 ms" is measured on the function itself (`relation-period.ts`). */
// Inline `type` specifiers, one line: this file sits at its recorded line budget (a file may not grow past its recorded count).

/** Timeline planners and views: pure, so both axes are test-driven directly. */

/**
 * Entity mentions: the scan is pure (text in, rows out) so the DoD's
 * "590k characters under 5 s" is measured directly, and the three queries are
 * what the 影响面 / 改名级联 / 掉线检测 surfaces read. `MENTIONS_DDL` and
 * `insertMentions` are the seam's half — `indexer.ts` creates the table and writes
 * the rows, because `mentions` owns no content directory and is not a domain.
 */

/**
 * World book: the keyword matcher, the write-side half of I-08 and the tree
 * shape are pure — no reads, no writes — so the rule that decides "which setting
 * entry this chapter pulls in" is testable without a project on disk. The
 * injection chain that consumes them belongs to the brief and is not wired yet.
 */
/** Exported for the tool-surface contract test: it asserts the aggregate is wired. */
/**
 * Character cards: `planCharacterUpsert` is the write-side I-03 decision and
 * is a pure function precisely so it can be asserted without a disk; the card
 * reader answers "what was he at chapter 30" outside a tool call too.
 */

/**
 * Index freshness: `checkIndexFreshness` is the read-only verdict and
 * `ensureIndex` is the **single** place that decides to rebuild. Exported for
 * embedders and tests the same way `buildIndex` is — the tools and the panel
 * channel both go through `ensureIndex`, so this is not a test-only surface.
 */
// The read-only projections over the cache, exported for the same reason
// `walkProjectFiles` is: a caller that must prove "the cache already knows this" cannot
// do it through `ensureIndex` (which would rebuild first and hide the staleness).
// `listChapters` serves one page (capped at `LIST_CHAPTERS_MAX`), `countChapters` is the
// whole book, and `listAllChapters` is the unabridged read for the semantic ledger — one
// chapter count, one source.

/**
 * The internal channel's request-body ceiling. Exported so the tests state
 * the number once: a save carries a whole chapter, and the old 64 KiB ceiling
 * refused a ~20k-character chapter outright.
 */

/**
 * Write-time compare-and-swap: a writer may state the baseline it
 * expects, and a mismatch is the structured `FILE_CHANGED` error with zero
 * writes. Exported so a caller can hand a test (or the panel) the same
 * fingerprint shape the writers compare against.
 */

/**
 * Write-layer API: the single door for project file writes.
 * Exported for the tests now and for the chapter/scaffolding writers next; no
 * tool registers against it yet, so this adds no model-facing surface.
 */

/**
 * Volume/chapter catalog (ADR-0006 D6): a reviewable, committed
 * projection of the `.md` structure. The read path never writes; rebuilds take
 * the project write lock and replace both files atomically; validation reports
 * drift instead of blocking. No tool registers against it yet.
 */

/** Exported for the tests (and embedders) so the gate can be asserted after a catalog change. */

/**
 * Book hub (ADR-0010): the no-session projection of the workspace
 * registry. Exported because the cost contract — four judgments at a time, 2 s
 * per book, 3 s budget, 200 rows — is only testable with an injected probe, and
 * because "which books does the hub see" must be answerable without a browser.
 */

/**
 * Shared library (ADR-0010 D5): the **read-only** projection of the
 * plugin-level shared directory, and the only hub surface that reads something
 * outside the workspace registry. Exported for the same reason as the hub: the two
 * data sources (the derived manifest vs an in-memory rescan) and the cost limits are
 * only testable by driving `buildHubShared` directly.
 *
 * `sharedDir` is exported as the DEFAULT-path helper only; the root in force comes
 * from `settings.ts`'s `sharedRootOf` (`dataDir/shared` unless `sharedRoot` is
 * configured).
 */

/**
 * The hub's new-book wizard (ADR-0010 D4/D6). Exported because the
 * two properties that make it safe are only testable from outside the route
 * handler: a plan token is ONE-SHOT and TTL-bounded (so the store takes an
 * injected clock), and `apply` accepts no path at all. The routes are a thin
 * envelope over these two functions, and the tests drive both the envelope and
 * the functions to prove they agree.
 */

/**
 * GBK mojibake detection: a pure function over the title text, so the
 * tests can pin the precision bar (genuine Chinese/Japanese/emoji must not trip
 * it) without building a project on disk.
 */

/**
 * Build identity: `getLoadedBuild` is what `/status`, the status tool
 * and the startup log report — the generation this process is executing, the
 * disk's build time and whether the disk moved on without a restart. Exported
 * because the contract tests import `lib/index.js` only, and because any surface
 * that answers "am I running old code" must ask the same function.
 */

/**
 * Chapter search: the read-only query half of `chapters_fts`.
 * Exported because the panel's future search box reuses it in-process, so this
 * is not a test-only surface — the tool and the tests drive the same function.
 */

/**
 * The single search entry for every kind (roadmap X-16) and the
 * search-and-replace batch (roadmap X-17).
 *
 * Exported for the same reason as `searchChapters`: the panel's "全部类型" toggle, the
 * two tools and the channel routes all read through these two functions, and the
 * contract tests must drive what users get — not a second copy of the logic.
 */

export function apply(ctx: HostContext, rawConfig: unknown): void {
  const config = resolveConfig(rawConfig)
  const log = ctx.logger('dsh-inkflow')

  log.info(`ready: files-first mode, plugin state=${config.dataDir}`)

  // Which generation is this, and is the disk ahead of it? A DSH
  // process keeps running the `lib/` it loaded at startup, so this line is how a
  // human tells "old generation" from "broken book" without opening the panel.
  const loaded = getLoadedBuild({ version: VERSION })
  log.info(
    loaded.staleLoadedCode
      ? `build ${loaded.build} loaded at ${loaded.loadedAt}; the disk holds a newer build (${loaded.diskBuildTime}): run pnpm.cmd run build, then fully quit and restart DSH`
      : `build ${loaded.build} loaded at ${loaded.loadedAt}`,
  )

  // state.json is display-only: it records the last project some
  // session touched, purely so a human can see it in the logs. It is never used
  // to resolve a project — one plugin-wide value cannot speak for a session.
  const remembered = readState(config.dataDir).lastProjectRoot
  if (remembered !== undefined) log.info(`last touched project (display only, not used for resolution): ${remembered}`)

  // Writing craft. Both halves probe for their Host service and
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

  // Writing context: the four facts a writing session needs before
  // its first tool call. Optional service, own degradation, and its own
  // try/catch — a broken prompt section must never cost the user their tools.
  try {
    registerWritingContext(ctx, {
      log,
      budgetTokens: config.promptBudgetTokens,
      tailChars: config.promptTailChars,
    })
  } catch (error) {
    log.warn(`writing context skipped: ${describeError(error)}`)
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

/**
 * 卷章 CRUD。
 */

/** New frontmatter and io helpers (one export statement each). */

/**
 * The shared finding shape (roadmap X-14): the vocabulary the audit report
 * and the repair pass both speak, plus the ordering a report needs to
 * be stable between two runs on unchanged files.
 */

/**
 * The quality gate (roadmap X-24/X-26): seven checks over one chapter, the
 * `.inkflow/audit/gate-<chapterId>.json` conclusion and its deterministic serialiser.
 * The rules live in `gate-rules.ts`; this block is the one entry point for the tool, the
 * panel route and the tests.
 */

/**
 * The review DAG (roadmap X-24/X-26, ADR-0022 D3): five independent dimension
 * nodes over one chapter, the locator/evidence chain, the `.inkflow/review/<chapterId>/
 * <runId>.json` run record, and the cross-model table. Exported together so the tool
 * surface, the panel route and the tests read the same definitions.
 *
 * The engine is four files since its own split: `review.ts` orchestrates and
 * answers the callers, `review-nodes.ts` owns the dimensions and the node table,
 * `review-locate.ts` owns the addressing protocol, `review-store.ts` owns the record file.
 */

/**
 * The batch job queue (ADR-0023, roadmap X-26/X-30): the state machine and its records
 * under `.inkflow/jobs/`, the panel projection, and the four tools. Re-exported for the tests
 * and for the routes' one entry point — the same arrangement as the gate, the review and the
 * proposals.
 */

/**
 * The 批量 page's pure view model. Re-exported for the same reason as `proposal-model`:
 * the three states the page can be in, and the sentence that explains a disabled 续跑, are
 * claims the user reads, so the tests assert them on the built artifact.
 */

/** Private state directory (`.inkflow/`) helpers — ADR-0012, roadmap X-9. */

/**
 * 设定变更的影响面与改名（conventions §5.6, ADR-0014): the read-only listing
 * (five reference sites, the plan preview) and the one write that follows it
 * (move the file, pin the old id, rewrite nothing else).
 */

/**
 * The recovery bin (roadmap X-9/X-10): move one file into `.inkflow/trash/`,
 * list what is there, put an entry back byte-identically, or purge one entry —
 * the last only with `confirm: true`.
 */

/**
 * The fact ledger: the line format as a parse/render **pair** (ADR-0013), the
 * interval judgement (I-23) and the "which facts hold at chapter N" query. Pure, so the
 * round-trip and the conflict rule are test-driven directly instead of through a tool.
 */

/**
 * The foreshadow state machine and its computed lateness (data-model
 * §3.2). Exported so a test can assert the **matrix** itself rather than inferring
 * it from which writes happen to be refused.
 */

/**
 * The consistency audit (roadmap X-14). Exported so tests can drive the engine
 * directly — the report body's determinism and the locator mapping are assertions about
 * plain data, not about a tool envelope.
 */

/**
 * Maintenance (ADR-0015): the rollback package, the 6→9 migration and the
 * three-stage repair pass. Exported for the tests and for embedders; the two tools
 * that expose them are registered through `tools.ts` like every other built-in.
 */

/**
 * The shared library's take-out direction (ADR-0007 C2–C6): copy snapshot,
 * `origin` provenance, the stale list and the explicit per-entry update.
 *
 * Exported for the same reason as every other domain here — the behaviour IS the
 * contract: "a conflict writes nothing", "a stale copy is only a report" and
 * "reference is library/-only" are proved by driving these functions directly and
 * comparing whole-tree hashes, not by reading a route envelope.
 */
// The library save path is exported here so a test can prove the one rule that
// lives in it and nowhere else: a `mode: reference` card refuses every write
// (ADR-0007 C4 `REFERENCE_READONLY`), whatever the panel or a tool asks for.
// The series sync: the engine, exported so the contract tests can call `plan` and
// `apply` with a plain book on disk — no Host context, no HTTP, no session.

/**
 * The ZIP container (ADR-0018 D3): store-only by design, so a backup can
 * be opened by any tool and checked by hand. Exported for the tests and for the
 * settings/backup work that writes the package.
 */

/**
 * The plugin's own state (ADR-0018): settings (D1/D2), the diagnostics package
 * (D5) and the local ZIP backups (D3/D4/D6). None of it is book data, which is why
 * these three modules sit together and write only under `dataDir`.
 */
// Exported for the equivalence test: the route's body whitelist must stay
// `SETTINGS_FIELDS` + `confirm`, and a test can only compare what it can import.

/**
 * 资料导入（roadmap X-17）：字节 → 编码嗅探 → 行尾风格 → 分章的分析半，以及
 * 「预览 = 执行」的写入半。
 *
 * 全是纯函数或经 `chapters.ts` / `io.ts` 的写入；预览与执行共用同一份 `prepare()`，
 * 所以「预览 = 执行」是集合比较得出的，不是两处各算一遍。
 */

// Semantic retrieval (ADR-0009 / ADR-0020). Four layers: transport + block shape, the
// ledger this machine keeps, the per-book job, and the one composition into X-16's search
// entry. Exported by module so a caller cannot mistake the job for the backend or the ledger
// for the truth.

// ---------------------------------------------------------------------------
// The extraction queue (X-20, ADR-0017). Exported for the tests and for
// nothing else: no other module inside `src/host` may import the candidate store or the
// accept path (a guard test in `tests/extract.test.js` scans the import graph), because
// "one way in" is a property of the code, not of a convention.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// The old-library migrator (X-29 / X-30). Exported for the tests and for
// nothing else inside `src/host`: the runners are the only entry, and a second importer
// would be a second way to start a migration without its plan.
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Proposals (ADR-0023, X-25 / X-26). The store, the line diff, the four
// tool entries and the panel channel. Exported because the tests assert the two hard
// properties directly: creating and deciding write no content file, and applying is
// byte-for-byte reversible through the backup package.
// ---------------------------------------------------------------------------


/**
 * The proposal tab's pure view model. Re-exported for the same reason as
 * `map-model`: the three states the page can be in, and the two "why the button is
 * disabled" sentences, are claims the user sees, so the tests assert them on the built
 * artifact. Pure by construction — no React, no network, no IO.
 */

// ---------------------------------------------------------------------------
// Export (ADR-0024, X-27). One writer, one container, one directory
// outside the book. Exported because the tests assert the two properties the ADR
// names directly: `mimetype` is the first entry and the package reads back through
// `readZip`, and exporting changes nothing inside the book.
// ---------------------------------------------------------------------------

