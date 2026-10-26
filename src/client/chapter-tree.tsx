/**
 * The chapter tree: volumes that open and close, and rows that show the heading only.
 *
 * WHY THIS LEFT `index.tsx` (issue: the tree showed two lines per chapter):
 *
 *   * **the second line was the file path.** `chapters/vol-01/0003-出门.md` under every
 *     heading doubles the height of a list whose job is "let me find chapter 43", and the
 *     path answers a different question ("where is this file on disk") that belongs beside
 *     the editor, where one chapter is open at a time.
 *   * **a volume was a caption, not a control.** Every volume rendered every chapter, so a
 *     fifteen-volume book made the left column as tall as the book. A volume head is now the
 *     thing that folds its chapters, which is also why it is a `<button>` with
 *     `aria-expanded` rather than a styled `<div>`.
 *
 * The state it keeps is one array of collapsed ids (`chapter-tree-model.ts` holds the rule and
 * the default). It is deliberately NOT persisted: a fold is a reading gesture, not a document
 * property, and writing it down would mean a new write path for a view preference.
 *
 * Read-only about the book: the only thing it can do is tell the workbench which chapter was
 * clicked — the same `setSelected` the page used before the extraction.
 */

import { useState } from 'react'

import { Icon } from './icons.js'
import { LOOSE_GROUP_ID, NO_VOLUMES_CLOSED, describeVolumeFacts, isVolumeOpen, toggleVolume } from './chapter-tree-model.js'
import { chapterHeading } from './panel-model.js'
import type { ChapterNode, ChapterTreeGroup } from './panel-model.js'

// The panel keeps one small style set per module rather than importing `index.tsx`'s: that
// import would make the two modules import each other (the reason `map.tsx` and
// `outline.tsx` do the same). Colours are host theme tokens only.
const muted = { color: 'var(--dsw-alias-label-secondary)' } as const
const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 } as const

const groupStyle = { display: 'grid', gap: 2 } as const

/** A volume head: the whole row is the fold control, so its hit area is not a 12px caret. */
const volumeHeadStyle = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  width: '100%',
  textAlign: 'left',
  padding: '2px 4px',
  border: '1px solid transparent',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: 12,
  cursor: 'pointer',
} as const

const rowStyle = {
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--dsw-alias-label-primary)',
  borderRadius: 6,
  padding: '3px 6px',
  fontSize: 12,
  cursor: 'pointer',
  textAlign: 'left',
  width: '100%',
  display: 'block',
} as const

const selectedRowStyle = {
  ...rowStyle,
  background: 'var(--dsw-alias-bg-layer-2)',
  borderColor: 'var(--dsw-alias-border-l2)',
} as const

/**
 * One chapter: `3. 初次出门`.
 *
 * A `<button>` and not a link: picking a chapter is the workbench's own state change, and
 * this module has no route to guess (ADR-0008 D4). It is the tree's only word-only button —
 * a row that selects rather than acts, which is what `tests/panel-actions.test.js` records.
 */
function ChapterRow({
  chapter,
  selected,
  onPick,
}: {
  chapter: ChapterNode
  selected: string | null
  onPick: (chapterId: string) => void
}) {
  const isSelected = chapter.id === selected
  return (
    <button
      type="button"
      onClick={() => onPick(chapter.id)}
      aria-current={isSelected ? 'true' : undefined}
      style={{ ...(isSelected ? selectedRowStyle : rowStyle), paddingLeft: 10 }}
    >
      {chapterHeading(chapter)}
    </button>
  )
}

/**
 * A foldable head: caret, title, and how many chapters it holds.
 *
 * `aria-expanded` is the machine-readable half of the caret; both change together, so a
 * screen reader and a pair of eyes are told the same thing.
 */
function VolumeHead({
  title,
  count,
  open,
  onToggle,
}: {
  title: string
  count: number
  open: boolean
  onToggle: () => void
}) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} style={volumeHeadStyle} title={`${title} · ${describeVolumeFacts(count)}`}>
      <Icon name={open ? 'caret-down' : 'caret'} size={12} />
      <span style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
      <span style={{ ...muted, ...mono }}>{describeVolumeFacts(count)}</span>
    </button>
  )
}

export interface ChapterTreeProps {
  groups: ChapterTreeGroup[]
  loose: ChapterNode[]
  /** The chapter the editor is showing; `null` before anything is picked. */
  selected: string | null
  onPick: (chapterId: string) => void
}

/**
 * Volumes (each foldable) then the loose chapters (also foldable).
 *
 * Both lists run through the same open/closed rule on purpose: a book whose chapters are all
 * loose is a normal book (a single-file draft), and a fold that only works for volumes would
 * leave its longest list permanently expanded.
 */
export function ChapterTree({ groups, loose, selected, onPick }: ChapterTreeProps) {
  // Hooks before any return (AGENTS.md §8 trap 2b): a conditional hook changes the hook count
  // between renders and blanks the whole panel with no message.
  const [closed, setClosed] = useState<readonly string[]>(NO_VOLUMES_CLOSED)
  const toggle = (volumeId: string): void => setClosed((current) => toggleVolume(current, volumeId))

  return (
    <>
      {groups.map((group) => {
        const open = isVolumeOpen(closed, group.volumeId)
        return (
          <div key={group.volumeId} style={groupStyle}>
            <VolumeHead title={group.title} count={group.chapters.length} open={open} onToggle={() => toggle(group.volumeId)} />
            {!open ? null : group.chapters.length === 0 ? (
              <div style={{ ...muted, paddingLeft: 10, fontSize: 11 }}>这一卷还没有章</div>
            ) : (
              group.chapters.map((chapter) => (
                <ChapterRow key={chapter.id} chapter={chapter} selected={selected} onPick={onPick} />
              ))
            )}
          </div>
        )
      })}

      {loose.length === 0 ? null : (
        <div style={groupStyle}>
          <VolumeHead
            title="未分卷"
            count={loose.length}
            open={isVolumeOpen(closed, LOOSE_GROUP_ID)}
            onToggle={() => toggle(LOOSE_GROUP_ID)}
          />
          {isVolumeOpen(closed, LOOSE_GROUP_ID)
            ? loose.map((chapter) => <ChapterRow key={chapter.id} chapter={chapter} selected={selected} onPick={onPick} />)
            : null}
        </div>
      )}
    </>
  )
}
