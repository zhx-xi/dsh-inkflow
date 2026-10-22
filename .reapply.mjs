import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const files = [
  '.agents/specs/data-model.md',
  'src/host/conventions.ts',
  'src/host/domains/index.ts',
  'src/host/index.ts',
  'tests/contract.test.js',
  'tests/outline.test.js',
]

// Start from main's version of every conflicted file, then re-apply the timeline delta.
for (const file of files) {
  execFileSync('git', ['checkout', '--ours', file], { stdio: 'inherit' })
  execFileSync('git', ['add', file], { stdio: 'inherit' })
}
console.log('reset to ours')

function edit(path, pairs) {
  let source = readFileSync(path, 'utf8')
  for (const [from, to] of pairs) {
    if (!source.includes(from)) {
      console.log(`SKIP ${path}: ${from.slice(0, 50)}`)
      continue
    }
    source = source.replace(from, to)
  }
  writeFileSync(path, source, 'utf8')
  console.log(`edited ${path}`)
}

// 1. schema version 4 -> 5, with the timeline reason
edit('src/host/conventions.ts', [
  ['export const INDEX_SCHEMA_VERSION = 4', 'export const INDEX_SCHEMA_VERSION = 5'],
  [
    ' * v4 (#25)',
    ' * v5 (#28): the `timeline_events` table — one row per timeline event with both axes\n * (`world_time`, `narrative_order`) and its chapter, so the two sorts and the conflict\n * checks are queries instead of a scan.\n * v4 (#25)',
  ],
])

// 2. register the timeline domain (alphabetical by kind)
edit('src/host/domains/index.ts', [
  ['  relationDomain,\n', '  relationDomain,\n  timelineDomain,\n'],
  [`import { worldDomain } from './world.js'`, `import { timelineDomain } from './timeline.js'\nimport { worldDomain } from './world.js'`],
])

// 3. entry point: export the timeline surface next to the others
edit('src/host/index.ts', [
  [
    `export { planRelationUpsert } from './domains/relation-write.js'`,
    `export { planRelationUpsert } from './domains/relation-write.js'

/** Timeline planners and views (#28): pure, so both axes are test-driven directly. */
export {
  planTimelineUpsert,
  planTimelineView,
  timelineConflicts,
  timelineValidate,
  parseWorldTime,
} from './domains/timeline-plan.js'
export type { TimelinePlan, TimelineView, TimelineConflict, TimelineRow } from './domains/timeline-plan.js'
export { listTimelineEvents } from './domains/query.js'`,
  ],
])

// 4. contract test: the tool list is the union
edit('tests/contract.test.js', [
  [
    `      'inkflow_relation_list',`,
    `      'inkflow_timeline_list',\n      'inkflow_timeline_upsert',\n      'inkflow_relation_list',`,
  ],
])

// 5. the outline test pinned the previous version literal
edit('tests/outline.test.js', [
  ['assert.equal(version.user_version, 4)', 'assert.equal(version.user_version, INDEX_SCHEMA_VERSION)'],
])

// 6. spec: v5 + the timeline table row + the invariant rows
edit('.agents/specs/data-model.md', [
  ['### 4.1 v4（现行，`PRAGMA user_version = 4`）', '### 4.1 v5（现行，`PRAGMA user_version = 5`）'],
  [
    '| `library_files` | path | size / mtime | 资料登记 |',
    '| `timeline_events` | id | path / title / world_time / narrative_order / chapter / participants / status | 双轴排序、待确认区、冲突检测（#28） |\n| `library_files` | path | size / mtime | 资料登记 |',
  ],
])

console.log('timeline delta re-applied')
