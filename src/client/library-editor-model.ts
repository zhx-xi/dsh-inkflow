/**
 * The setting-library editor's pure rules: which fields a kind shows, what a save sends, and
 * which of the two writes is on offer.
 *
 * WHY IT IS A FILE: everything here answers "what happens when the author edits one entry",
 * and none of it is UI — the React half (`library-editor.tsx`) only wires these functions up.
 * It was the largest of the four jobs inside `library-model.ts` and the one a reader opens
 * most often, so it gets its own file instead of sitting between the tree and the wording.
 *
 * Two rules the payload obeys, because they are what keeps a save honest:
 *   * only the fields the author CHANGED are sent — an untouched line must not be
 *     rewritten (it would show up as a git diff the author did not make);
 *   * a key the form does not know is never sent, so the Host's line-level patch leaves it
 *     exactly as it was (`id`, `tags`, `origin`, …).
 */

import type { LibraryFingerprint, LibraryItemValue } from './library-tree-model.js'

// ---------------------------------------------------------------------------
// The editor (the second batch of the setting-library work)
//
// The Host owns the file format; this half owns "which fields a kind shows" and
// "what the save sends". Both are pure functions over plain data — `node --test`
// has no DOM, so the rules are tested here and the View only wires them up.
//
// Two rules the payload obeys, because they are what keeps a save honest:
//   * only the fields the author CHANGED are sent — an untouched line must not be
//     rewritten (it would show up as a git diff the author did not make);
//   * a key the form does not know is never sent, so the Host's line-level patch
//     leaves it exactly as it was (`id`, `tags`, `origin`, …).
// ---------------------------------------------------------------------------

/** How a frontmatter field is edited. */
export type LibraryFieldType = 'text' | 'number' | 'boolean' | 'list'

export interface LibraryFieldSpec {
  readonly key: string
  readonly label: string
  readonly type: LibraryFieldType
}

/**
 * The common field set per kind — the fields the author edits by hand. Names and types come
 * from the data model (`.agents/specs/data-model.md` §3.1–§3.6), not a per-kind guess;
 * `id` is deliberately absent (it is the address both the tree and this editor use), as are
 * nested maps like `origin`, which frontmatter cannot represent.
 */
export const KIND_FIELDS: Record<string, readonly LibraryFieldSpec[]> = {
  characters: [
    { key: 'name', label: '角色名', type: 'text' },
    { key: 'aliases', label: '别名', type: 'list' },
    { key: 'group', label: '分组', type: 'text' },
    { key: 'role', label: '定位', type: 'text' },
    { key: 'pov', label: '视角', type: 'text' },
    { key: 'firstAppearance', label: '首次出场', type: 'text' },
    { key: 'voice', label: '口吻', type: 'text' },
  ],
  world: [
    { key: 'title', label: '名称', type: 'text' },
    { key: 'category', label: '分类', type: 'text' },
    { key: 'parent', label: '上级', type: 'text' },
    { key: 'keywords', label: '触发词', type: 'list' },
    { key: 'always', label: '常驻注入', type: 'boolean' },
    { key: 'priority', label: '优先级', type: 'number' },
  ],
  outlines: [
    { key: 'kind', label: '层级', type: 'text' },
    { key: 'title', label: '标题', type: 'text' },
    { key: 'parent', label: '上级', type: 'text' },
    { key: 'order', label: '次序', type: 'number' },
  ],
  relations: [
    { key: 'source', label: '起点', type: 'text' },
    { key: 'target', label: '终点', type: 'text' },
    { key: 'dir', label: '方向', type: 'text' },
    { key: 'since', label: '起始', type: 'text' },
    { key: 'until', label: '终止', type: 'text' },
    { key: 'chapter', label: '章节', type: 'text' },
  ],
  timeline: [
    { key: 'title', label: '事件', type: 'text' },
    { key: 'worldTime', label: '世界时间', type: 'text' },
    { key: 'narrativeOrder', label: '叙事顺序', type: 'number' },
    { key: 'chapterId', label: '章节', type: 'text' },
    { key: 'participants', label: '参与者', type: 'list' },
    { key: 'status', label: '状态', type: 'text' },
  ],
  foreshadowing: [
    { key: 'title', label: '伏笔名', type: 'text' },
    { key: 'status', label: '状态', type: 'text' },
    { key: 'plantedAt', label: '埋设位置', type: 'text' },
    { key: 'advancedAt', label: '推进位置', type: 'list' },
    { key: 'resolved', label: '已回收', type: 'boolean' },
    { key: 'resolvedChapter', label: '回收章', type: 'text' },
    { key: 'dueBy', label: '期望回收', type: 'text' },
    { key: 'linkedEntities', label: '相关条目', type: 'list' },
    { key: 'notes', label: '备注', type: 'text' },
  ],
  facts: [
    { key: 'subject', label: '主体', type: 'text' },
    { key: 'attribute', label: '维度', type: 'text' },
    { key: 'value', label: '当前值', type: 'text' },
    { key: 'since', label: '生效', type: 'text' },
    { key: 'until', label: '失效', type: 'text' },
    { key: 'chapterId', label: '登记章', type: 'text' },
    { key: 'source', label: '来源', type: 'text' },
    { key: 'conflictsWith', label: '冲突事实', type: 'list' },
  ],
  library: [
    { key: 'title', label: '资料名', type: 'text' },
    { key: 'source', label: '来源', type: 'text' },
    { key: 'license', label: '许可', type: 'text' },
    { key: 'sha256', label: '原文哈希', type: 'text' },
    { key: 'mode', label: '保存方式', type: 'text' },
  ],
}

/** The editable fields of one kind; an unknown kind has none (its body is still editable). */
export function fieldsForKind(kind: string): readonly LibraryFieldSpec[] {
  return KIND_FIELDS[kind] ?? []
}

/**
 * The frontmatter key a kind keeps its display name in, if the form edits one.
 *
 * `characters` spells it `name` (its projection `title` comes from `name`), every
 * other kind that has one spells it `title`. Returns `undefined` for a kind whose
 * form has no name field, so the rename dialog hides the input instead of writing
 * a key the form does not own.
 */
export function renameTitleField(kind: string): string | undefined {
  const fields = fieldsForKind(kind)
  if (fields.some((spec) => spec.key === 'name')) return 'name'
  if (fields.some((spec) => spec.key === 'title')) return 'title'
  return undefined
}

/** How a value is shown in the form: one item per line for a list, `true`/`false` for a boolean. */
function fieldText(spec: LibraryFieldSpec, value: unknown): string {
  if (spec.type === 'boolean') {
    if (value === true || value === 'true') return 'true'
    if (value === false || value === 'false') return 'false'
    return ''
  }
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : typeof item === 'number' ? String(item) : ''))
      .filter((item) => item !== '')
      .join('\n')
  }
  return ''
}

/**
 * What the author is editing: one string per field plus the prose.
 *
 * A list is edited one item per line and a boolean is `'true'`/`'false'` (the
 * checkbox state) — one shape for the form, converted back on save.
 */
export interface LibraryDraft {
  values: Record<string, string>
  body: string
}

export function draftFromItem(kind: string, frontmatter: Record<string, unknown>, body: string): LibraryDraft {
  const values: Record<string, string> = {}
  for (const spec of fieldsForKind(kind)) values[spec.key] = fieldText(spec, frontmatter[spec.key])
  return { values, body }
}

/**
 * The keys the form does not know, in file order.
 *
 * They are shown read-only and are NOT part of the payload: the Host patches the
 * file line by line, so an untouched key survives byte for byte (that is what
 * keeps `id`, `tags`, `origin` and this plugin's future fields from being eaten
 * by an editor that does not understand them yet).
 */
export function unknownFields(kind: string, frontmatter: Record<string, unknown>): Array<[string, unknown]> {
  const known = new Set(fieldsForKind(kind).map((spec) => spec.key))
  return Object.entries(frontmatter).filter(([key]) => !known.has(key))
}

/** The body of `POST /library/item`: only what changed. */
export interface LibrarySavePayload {
  frontmatter: Record<string, unknown>
  body?: string
}

/** One form value → the JSON value the Host writes (`null` deletes, `[]` deletes a list). */
function payloadValue(spec: LibraryFieldSpec, text: string): unknown {
  if (spec.type === 'boolean') return text === 'true'
  if (spec.type === 'list') {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
  }
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (spec.type === 'number') {
    // Text typed into a number field is sent as text: refusing the save would be
    // worse than storing exactly what the author wrote, and the Host writes it
    // back as a plain scalar either way.
    const numeric = Number(trimmed)
    return Number.isFinite(numeric) ? numeric : trimmed
  }
  return trimmed
}

/**
 * The save payload, or `null` when nothing changed.
 *
 * `null` is the "no edits" answer the View uses to skip a pointless round trip;
 * the Host answers the same request with `400 EMPTY_UPDATE`.
 */
export function draftPayload(
  kind: string,
  draft: LibraryDraft,
  frontmatter: Record<string, unknown>,
  body: string,
): LibrarySavePayload | null {
  const changed: Record<string, unknown> = {}
  for (const spec of fieldsForKind(kind)) {
    const next = draft.values[spec.key] ?? ''
    if (next === fieldText(spec, frontmatter[spec.key])) continue
    changed[spec.key] = payloadValue(spec, next)
  }
  const payload: LibrarySavePayload = { frontmatter: changed }
  if (draft.body !== body) payload.body = draft.body
  return Object.keys(changed).length === 0 && payload.body === undefined ? null : payload
}

/** The CAS baseline a detail answer carries, or `null` when it has none. */
export function fingerprintOf(value: LibraryItemValue | null | undefined): LibraryFingerprint | null {
  const fingerprint = value?.fingerprint
  if (fingerprint === undefined || fingerprint === null) return null
  if (typeof fingerprint.sha256 !== 'string' || fingerprint.sha256 === '') return null
  return fingerprint
}

// ---------------------------------------------------------------------------
// The editor's two writes: which one is on offer (issue 134)
// ---------------------------------------------------------------------------

/** The rename block's state: no confirm yet, folded away, or its confirm button. */
export type EditorRenameState = 'hidden' | 'blocked' | 'confirm'

/** One state of the editor's action area, as the view renders it. */
export interface EditorActionState {
  /** The content save: the primary button, or a grey line where that button stood. */
  readonly contentSave: 'primary' | 'muted'
  readonly rename: EditorRenameState
  /** The sentence shown where the 保存 button stood; `null` while the button is there. */
  readonly contentNote: string | null
  /** The sentence telling the author why the rename is not on offer; `null` when it is. */
  readonly renameNote: string | null
}

/**
 * Which of the editor's two writes the author is being offered, and why not the other.
 *
 * The bug (issue 134): 确认改名 was `disabled={busy || dirty || plan === undefined}`,
 * so before 查看影响面 answered it sat there greyed out with no sentence saying why —
 * and the content's 保存 was rendered next to it as a second, equally primary button.
 * A greyed-out button is a question the panel refuses to answer.
 *
 * Two inputs decide it, and only two: `dirty` (the draft differs from the file) and
 * `planReady` (查看影响面 has answered, so a rename plan exists).
 *
 * | dirty | planReady | 保存          | 改名与影响面                      |
 * |-------|-----------|---------------|-----------------------------------|
 * | no    | no        | primary       | inputs + 查看影响面, no 确认改名   |
 * | yes   | either    | primary       | folded into one grey line         |
 * | no    | yes       | grey line     | inputs + 查看影响面 + 确认改名     |
 *
 * `dirty` wins over `planReady` because both writes target the same bytes: renaming
 * with an unsaved draft would silently drop it (the plan is refused for exactly that
 * reason, so the panel must not offer the click either).
 */
export function editorActions(state: { dirty: boolean; planReady: boolean }): EditorActionState {
  if (state.dirty) {
    return {
      contentSave: 'primary',
      rename: 'blocked',
      contentNote: null,
      renameNote: '内容有未保存的改动：先保存或放弃，再改名（两处改动会互相覆盖）。',
    }
  }
  if (state.planReady) {
    return {
      contentSave: 'muted',
      rename: 'confirm',
      contentNote: '内容没有未保存的改动，「保存」这时用不上。',
      renameNote: null,
    }
  }
  return {
    contentSave: 'primary',
    rename: 'hidden',
    contentNote: null,
    renameNote: '先点「查看影响面」确认影响，才能改名。',
  }
}
