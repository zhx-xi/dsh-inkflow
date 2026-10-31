/**
 * The 子智能体 block of the settings page: the switch, the default route, and the model
 * catalog that fills the picker.
 *
 * WHY IT IS ITS OWN FILE: `settings.tsx` is already the page's layout plus four effects,
 * and this block has a life of its own — it fetches a catalog the rest of the page never
 * reads, and it has a degraded form (two text boxes) that the other fields do not.
 *
 * THE ONE THING THAT MUST NOT BE LOST IN THE UI: this setting is a POLICY, not a
 * capability. This plugin calls no model, so switching it on cannot make a subagent run;
 * it writes one sentence into the session's context and one line into the batch tool's
 * reply, and the session's own agent does the dispatching. The block therefore never says
 * "已启用多模型生成" — it says what the session will be told, and it says plainly that a
 * change here reaches the NEXT session (a preset is a registered composition).
 *
 * WHY THE CATALOG IS ALLOWED TO FAIL. `GET /hub/models` answers `ok:false` when the
 * profile exposes no `llm` service or when the 2 s deadline expires. That is a reason to
 * fall back to typing the ids, never a reason to block the save: the values are stored
 * either way, and a route that exists but cannot be listed still works.
 */

import { useEffect, useMemo, useState } from 'react'

import { fetchInternal } from './internal.js'
import { DELEGATION_SESSION_NOTICE, describeDelegationFields, loadableFrom } from './settings-model.js'
import type { Loadable, SettingsDraft } from './settings-model.js'

/** `GET /hub/models` — mirrors `src/host/hub-models.ts`'s value. */
export interface ModelsCatalogValue {
  providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string; description?: string }> }>
  /** The deadline that was in force; shown when the answer degraded or was slow. */
  timeoutMs: number
}

const blockStyle = {
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 8,
  padding: '8px 10px',
  display: 'grid',
  gap: 6,
  background: 'var(--dsw-alias-bg-layer-2)',
} as const

const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as const
const fieldStyle = { display: 'grid', gap: 3, minWidth: 220 } as const
const muted = { color: 'var(--dsw-alias-label-secondary)' } as const
const labelStyle = { ...muted, fontSize: 12 } as const

const inputStyle = {
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 6,
  background: 'var(--dsw-alias-bg-base)',
  color: 'var(--dsw-alias-label-primary)',
  padding: '3px 8px',
  fontSize: 12,
  width: '100%',
  boxSizing: 'border-box',
} as const

const buttonStyle = {
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  borderRadius: 6,
  padding: '2px 8px',
  fontSize: 12,
  cursor: 'pointer',
} as const

/** `provider/id` is what the Host stores separately; this keeps the picker honest. */
function routeOf(draft: SettingsDraft): string {
  const provider = draft.subagentProvider.trim()
  const model = draft.subagentModel.trim()
  return provider === '' ? model : `${provider}/${model}`
}

export function DelegationSection({
  draft,
  onChange,
}: {
  draft: SettingsDraft
  /** Partial update of the page's draft; the save button (above) sends the patch. */
  onChange: (next: Partial<SettingsDraft>) => void
}) {
  const [catalog, setCatalog] = useState<Loadable<ModelsCatalogValue>>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    setCatalog({ status: 'loading' })
    void fetchInternal<ModelsCatalogValue>('/hub/models', { sessionless: true }).then((result) => {
      if (live) setCatalog(loadableFrom(result))
    })
    return () => {
      live = false
    }
    // `attempt` is the retry counter: a failed catalog is re-read on request, never polled.
  }, [attempt])

  const view = describeDelegationFields({
    enabled: draft.subagentEnabled,
    provider: draft.subagentProvider,
    model: draft.subagentModel,
  })

  const providers = catalog.status === 'ready' ? catalog.value.providers : []
  const providerId = draft.subagentProvider.trim()
  const modelId = draft.subagentModel.trim()

  /**
   * The model ids the picker offers.
   *
   * With a provider chosen: that provider's models. Without one: every model, because
   * "no provider" means "keep the session's routing" and the model id is then the only
   * thing being chosen. The currently stored value is prepended when the catalog does not
   * carry it, so opening this page never silently rewrites a route the author typed.
   */
  const modelChoices = useMemo(() => {
    const scoped = providerId === '' ? providers : providers.filter((provider) => provider.id === providerId)
    const ids: string[] = []
    for (const provider of scoped) for (const model of provider.models) if (!ids.includes(model.id)) ids.push(model.id)
    if (modelId !== '' && !ids.includes(modelId)) ids.unshift(modelId)
    return ids
  }, [providers, providerId, modelId])

  return (
    <div style={blockStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>子智能体</span>
        <span style={labelStyle}>{view.label}</span>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <input
          type="checkbox"
          checked={draft.subagentEnabled === true}
          onChange={(event) => onChange({ subagentEnabled: event.target.checked })}
        />
        生成类任务（大纲 / 细纲 / 正文）交给子智能体
      </label>

      {/* Three states, never two at once: off hides the route fields entirely; while the
          catalog is being read the fields are not shown (a manual box that turns into a
          picker a moment later reads as a bug); ready shows the pickers; a failed catalog
          shows the same two fields as plain text inputs, which always work. */}
      {draft.subagentEnabled !== true ? null : catalog.status === 'loading' ? (
        <div style={labelStyle}>正在读模型目录…（读不到就改成手填，不影响保存）</div>
      ) : catalog.status === 'ready' ? (
        <>
          <div style={rowStyle}>
            <label style={fieldStyle}>
              <span style={labelStyle}>provider（不选 = 沿用当前会话的路由）</span>
              <select
                style={inputStyle}
                value={providerId}
                onChange={(event) => {
                  const next = event.target.value
                  onChange({ subagentProvider: next })
                }}
              >
                <option value="">（不指定）</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name === provider.id ? provider.id : `${provider.name}（${provider.id}）`}
                  </option>
                ))}
                {providerId !== '' && !providers.some((provider) => provider.id === providerId) ? (
                  <option value={providerId}>{providerId}（不在本机目录里）</option>
                ) : null}
              </select>
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>默认模型（留空 = 每次让作者现场选）</span>
              <select style={inputStyle} value={modelId} onChange={(event) => onChange({ subagentModel: event.target.value })}>
                <option value="">（留空：动手前先问你）</option>
                {modelChoices.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" style={buttonStyle} onClick={() => setAttempt((current) => current + 1)}>
              重读模型目录
            </button>
          </div>
          {modelChoices.length === 0 ? (
            <div style={labelStyle}>
              这台机器上没有列出任何模型（{providers.length} 个 provider 都没报模型）：可以直接保存，也可以先到 DSH 的模型设置里确认。
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div style={rowStyle}>
            <label style={fieldStyle}>
              <span style={labelStyle}>provider（手填，可留空）</span>
              <input
                style={inputStyle}
                value={draft.subagentProvider}
                placeholder="deepseek-account"
                onChange={(event) => onChange({ subagentProvider: event.target.value })}
              />
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>默认模型（手填，留空 = 每次先问你）</span>
              <input
                style={inputStyle}
                value={draft.subagentModel}
                placeholder="deepseek-v4-pro"
                onChange={(event) => onChange({ subagentModel: event.target.value })}
              />
            </label>
            <button type="button" style={buttonStyle} onClick={() => setAttempt((current) => current + 1)}>
              再读一次目录
            </button>
          </div>
          <div style={labelStyle}>读不到模型目录，已改为手填（不影响保存）：{catalog.message}</div>
        </>
      )}

      {view.notes.map((note) => (
        <div key={note} style={labelStyle}>
          {note}
        </div>
      ))}
      <div style={labelStyle}>
        {DELEGATION_SESSION_NOTICE} 插件只声明这条策略，它自己不调用任何模型，也不会替你派发 —— 派发由会话里的 agent 完成，插件看不到它是否真的照做了。
      </div>
      <div style={{ ...labelStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}>当前：{routeOf(draft) === '' ? '（未指定模型）' : routeOf(draft)}</div>
    </div>
  )
}
