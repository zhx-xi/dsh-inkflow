/**
 * The writing agent preset: a Cordis composition, not a bag of options.
 *
 * WHY A PRESET AT ALL: skills are workspace-scoped (see skills.ts) and the
 * `inkflow_*` tools are registered for every session, so a novel session
 * already works without choosing anything. What a preset adds is the part a
 * catalog cannot: an identity that says *which* stage to run and *how*, plus a
 * deliberately small tool set for a writing agent — no shell, no delegation, no
 * workflow engine, so an author-facing session cannot wander into repository
 * surgery.
 *
 * Declared through `agentPresets.register(definition)` from this plugin, which
 * the registry documents as the seam "supplied by the declaring plugin". The
 * row list is the same `plugins` list a bundle patch writes; it is written here
 * because a composition this small does not deserve a second YAML file that can
 * drift from the code that owns its persona text.
 *
 * Contract source: DSH 0.2.1-rc.2 Host Service `agentPresets`
 * (`register` / `PresetDefinition` / `EntryOptions`) and
 * `@deepseek-ai/dsh-agent-preset`'s shipped preset declarations.
 */

import type { AgentPresetRegistryLike, HostContext, LoaderEntryLike, LogSink, PresetDefinitionLike } from './context.js'
import { describeError, optionalService } from './probe.js'

/** Loader row id / roster id of the writing preset. */
export const WRITING_PRESET_ID = 'inkflow-writing'

/**
 * Tools a writing session gets. Everything here is an Agent-plane row that
 * contributes scoped tools over Host services; none of them provides a service,
 * so no `isolate` realm is needed (a preset row that provides a service must be
 * isolated, and this composition deliberately has none).
 *
 * Left out on purpose: `tool-bash` / `tool-pwsh` (an author-facing writing
 * session has no business shelling out), subagents and workflow (a chapter is
 * one agent's job), compaction rows (the deployment's default composition owns
 * the token budget).
 */
const WRITING_TOOL_ROWS: readonly LoaderEntryLike[] = [
  { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
  { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search' },
  { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo' },
  { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },
]

/**
 * The persona. It is agent-plane prose, so it names the five stages and the
 * skills that carry each one's craft — a catalog entry alone does not tell the
 * model *when* to load which skill.
 */
export function writingPersona(skillNames: readonly string[]): string {
  const stage = (index: number, label: string, instrument: string): string => {
    const name = skillNames[index]
    return name === undefined ? `${String(index + 1)}. ${label}：${instrument}` : `${String(index + 1)}. ${label}：先用 \`${name}\`，${instrument}`
  }
  return [
    '# InkFlow 写作会话',
    '',
    '你是这部小说的写作助手。工作区就是作品仓库本身（`inkflow.json` + `chapters/` `characters/` `world/` `outlines/` `library/`）。',
    '你的职责是长篇小说的写作工艺，不是通用编程任务；作者要你改代码或动环境时，先确认这确实是他要的。',
    '',
    '## 五个阶段（先加载对应技能，再动手）',
    stage(0, '架构', '把设定与大纲折成本章任务书：目标、冲突、信息增量、伏笔动作、禁区。'),
    stage(1, '起草', '按任务书出正文，一次到位地处理视角、场景、对话、节奏与章末钩子。'),
    stage(2, '审校', '设定 / 时间线 / 人物 / 伏笔四维只读审计，逐条给证据与严重级。'),
    stage(3, '修订', '按审计清单定向改写，只动被点名的位置。'),
    stage(4, '润色', '句子级打磨：去 AI 味、去翻译腔、修重复与标点，不改情节。'),
    '',
    '写一章默认走 1 → 2 → 3（规划、成文、审校）；作者点明"改"或"润"时再走 4 或 5。跳阶段要说明理由。',
    '',
    '## 硬约束',
    '- **资料以文件为准**：人物、世界观、伏笔、时间线、章节一律用 `inkflow_*` 工具读当前项目，不凭记忆、不编设定。',
    '- 工具返回 `NOT_AN_INKFLOW_PROJECT` 时，先与作者确认目录（或初始化项目），**不要在别处新建任何文件**。',
    '- 具体数字（年龄、距离、银钱、境界、章号、时间跨度）必须与资料库一致；查不到就问，不要凑。',
    '- 只写作者要的那一章 / 那一段：不擅自改主线、不新增人物、不换视角、不动未涉及的文件。',
    '- 写入前先说明将改动哪个文件、改哪一段；作者没要求的文件一律不碰。',
    '- 涉及他人作品时只做原创改写，不搬运原文。',
    '',
    '## 汇报口径',
    '中文、先结论后证据（哪一章、哪条设定、哪一段）。区分"已做"与"未做/待定"，不把"应该可以"写成"已验证"。',
  ].join('\n')
}

/** Build the declaration handed to `agentPresets.register`. */
export function buildWritingPreset(skillNames: readonly string[]): PresetDefinitionLike {
  return {
    id: WRITING_PRESET_ID,
    name: 'InkFlow 写作',
    description:
      '长篇小说写作：架构 / 起草 / 审校 / 修订 / 润色五个工艺阶段，装载 InkFlow 写作技能与 inkflow_* 工具，不含 shell 与委派。',
    order: 20,
    plugins: [
      { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: writingPersona(skillNames) } },
      ...WRITING_TOOL_ROWS,
    ],
  }
}

export interface PresetRegistration {
  registered: boolean
  /** Roster id when registered. */
  id?: string
  /** Why registration did not happen or failed after the fact. */
  reason?: string
}

/**
 * Register the preset for the lifetime of the plugin.
 *
 * `register()` is asynchronous and its failure is *visible in the roster*
 * rather than thrown, so the promise is consumed here: a rejection is logged
 * once and the plugin keeps running (a broken preset must not take the tools
 * down with it). The disposer is awaited on unload, but unload must not block.
 */
export function registerWritingPreset(
  ctx: HostContext,
  definition: PresetDefinitionLike,
  log: LogSink,
): PresetRegistration {
  const registry = optionalService<AgentPresetRegistryLike>(
    ctx,
    'agentPresets',
    (value) => typeof value.register === 'function',
  )
  if (registry === undefined) {
    log.info('agentPresets service missing: the writing preset is not registered (skills and tools still work)')
    return { registered: false, reason: 'agentPresets service missing' }
  }

  ctx.effect(() => {
    let dispose: (() => Promise<void>) | undefined
    let cancelled = false
    void registry
      .register(definition)
      .then((registeredDispose) => {
        if (cancelled) {
          void registeredDispose()
          return
        }
        dispose = registeredDispose
        log.info(`agent preset registered: ${definition.id}`)
      })
      .catch((error: unknown) => {
        log.warn(`agent preset ${definition.id} could not be registered: ${describeError(error)}`)
      })
    return () => {
      cancelled = true
      void dispose?.()
    }
  })
  return { registered: true, id: definition.id }
}
