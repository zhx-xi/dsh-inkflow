/**
 * The setting library's wording: the empty states and every refusal it can show.
 *
 * WHY IT IS A FILE: these are the strings an author reads when the tab has nothing to show
 * or when a save was refused — one job, and one that changes for a different reason than the
 * tree or the editor does (a new refusal code, a clearer empty state). Keeping the copy in
 * one file is also what makes it reviewable: no rule hides between the sentences.
 */

import { describeOriginRefusal, describeTooLarge } from './error-text.js'
import type { LibraryItemValue } from './library-tree-model.js'
import type { InternalError, InternalResult } from './internal.js'

// ---------------------------------------------------------------------------
// State wording: every card the tab can show instead of a blank area
// ---------------------------------------------------------------------------

export const LIBRARY_EMPTY = {
  'no-items': {
    title: '设定库还没有条目',
    body: '五类（角色 / 世界观 / 关系 / 事实账本 / 资料）都还是空的。大纲、伏笔、时间线各有自己的页签，条目不在这一页显示——它们没有丢，切到对应页签即可。让 AI 用 inkflow_* 工具建条目，或直接在对应目录里写带 frontmatter 的 Markdown，面板会按类显示。',
  },
  'no-selection': {
    title: '选择一条查看',
    body: '左栏点开一类，再点一条：右栏显示这条的详情（frontmatter 与正文），点「编辑」可以改常见字段和正文，保存时带基线指纹，磁盘上被改过就拒绝覆盖。',
  },
  'no-issues': {
    title: '没有记录到问题',
    body: '派生索引重建时没有记下 validation_issues：frontmatter、id 重复、层级、端点这些校验都通过了。',
  },
  'index-unavailable': {
    title: '索引不可用',
    body: '派生索引不存在、读不出来，或由别的 schema 版本建的，所以这一类暂时无法回答（不是「书里没有」）。让 AI 跑 inkflow_index_rebuild 后重开面板。',
  },
  'no-projection': {
    title: '',
    body: '空的这一类也可能是「还没有进索引投影」：伏笔 / 事实账本 / 资料 的实体随后续版本进入投影，文件本身已经在目录里。',
  },
} as const

export type LibraryEmptyKind = keyof typeof LIBRARY_EMPTY

/** Message for a failed library call: the Host's own words beat a bare code. */
export function describeLibraryError(error: InternalError | undefined): string {
  if (error === undefined) return '设定库通道没有返回内容'
  if (error.code === 'INDEX_UNAVAILABLE') return LIBRARY_EMPTY['index-unavailable'].body
  if (error.code === 'library-item-not-found') return '这一条在索引里找不到了，可能已被改名或删除（刷新后重查）'
  if (error.code === 'KIND_INVALID' || error.code === 'KIND_REQUIRED') return '请求里缺少或写错了类别（面板内部错误）'
  return error.message ?? error.code
}

/** Message for a failed save: a 409 says the file moved, everything else is the Host's own text. */
export function describeSaveError(error: InternalError | undefined): string {
  if (error === undefined) return '保存没有返回内容'
  // Same reason as the chapter editor (issue 115): a refusal that carries a size
  // must say the size, or the author only sees "保存失败" and no next step.
  const tooLarge = describeTooLarge(error)
  if (tooLarge !== null) return tooLarge
  // The card the author saw: a bare `forbidden-origin` with no hint.
  const refusedOrigin = describeOriginRefusal(error)
  if (refusedOrigin !== null) return refusedOrigin
  if (error.code === 'FILE_CHANGED') {
    return '文件已被改动：磁盘上的内容已经不是这次加载的版本，所以这次没有写入任何字节。'
  }
  if (error.code === 'library-item-not-found') return '这一条在目录里找不到了：可能已被改名或删除。'
  if (error.code === 'PATH_OUT_OF_SCOPE') return '这个 id 会逃出它的内容目录，已拒绝。'
  if (error.code === 'EXPECTED_REQUIRED') return '保存缺少基线指纹（面板内部错误），重新加载这一条后再改。'
  if (error.code === 'EXPECTED_INVALID') return '基线指纹格式不对（面板内部错误），重新加载这一条后再改。'
  if (error.code === 'BODY_INVALID') return '正文里有无法保存为 UTF-8 的字符。'
  if (error.code === 'FRONTMATTER_INVALID' || error.code === 'FRONTMATTER_VALUE_INVALID') {
    return '这个字段的值不能写进 frontmatter（嵌套结构或换行）。'
  }
  if (error.code === 'EMPTY_UPDATE') return '这次没有改动。'
  return error.message ?? error.code
}

/**
 * What to say after a save that changed the file but could not rebuild the index.
 *
 * The save itself is `ok`, so this is a notice, not an error: the file is right
 * and the tree is stale until the index is rebuilt.
 */
export function describeIndexWarning(value: LibraryItemValue | null | undefined): string | null {
  const error = value?.indexError
  if (error === undefined) return null
  return `已保存，但派生索引没能重建（${error.code ?? 'INDEX_UNAVAILABLE'}）：左栏与详情暂时还是旧值，跑一次 inkflow_index_rebuild 即可。`
}

/** `data` for a loaded-but-refused result: keeps the panel on its structured cards. */
export function libraryErrorOf(result: InternalResult<unknown> | null): InternalError | undefined {
  if (result === null || result.ok) return undefined
  return result.error
}
