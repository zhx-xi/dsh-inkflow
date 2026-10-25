/**
 * The purge area's card, rendered by both panels that own a kind of cleanable state.
 *
 * ONE card rather than two: the review page offers the runs, the proposal page offers the
 * proposals, and the only difference is which entries arrive and what the empty line says. A
 * second copy would drift on the sentence the author actually reads — "可还原" is the whole
 * promise of this feature, and it must not be worded twice.
 *
 * No hooks: everything it needs arrives as props (AGENTS.md §8 trap 2b — a card that fetched
 * for itself would put a hook in a component that may be rendered conditionally).
 */

import { describePurgedEntry } from './purge-model.js'
import type { PurgedEntry } from './purge-model.js'

const cardStyle = {
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 8,
  padding: '8px 10px',
  background: 'var(--dsw-alias-bg-layer-1)',
} as const

const muted = { color: 'var(--dsw-alias-label-secondary)' } as const

const rowStyle = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  flexWrap: 'wrap',
  padding: '6px 0',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
} as const

const buttonStyle = {
  padding: '2px 10px',
  fontSize: 12,
  borderRadius: 6,
  cursor: 'pointer',
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
} as const

export interface PurgeCardProps {
  /** What this page's entries are, in the title: `已清理的运行记录` / `已清理的提案`. */
  readonly title: string
  readonly entries: readonly PurgedEntry[]
  /** The read failure, when the area could not be listed at all. */
  readonly error: string | null
  readonly busy: boolean
  /** Why the half-shown state is not an error: said once, here, for both pages. */
  readonly note: string
  readonly onRestore: (id: string) => void
}

/**
 * The card, or `null` when there is nothing to say.
 *
 * "Nothing" means both zero entries **and** no error: an empty card would be a permanent row
 * telling the author a feature they never used exists.
 */
export function PurgeCard({ title, entries, error, busy, note, onRestore }: PurgeCardProps): JSX.Element | null {
  if (entries.length === 0 && error === null) return null
  return (
    <div style={cardStyle}>
      <div style={{ fontWeight: 600 }}>
        {title}（{String(entries.length)}）
      </div>
      {error === null ? null : <div style={{ ...muted, fontSize: 12 }}>{error}</div>}
      {entries.length === 0 ? null : <div style={{ ...muted, fontSize: 11 }}>{note}</div>}
      {entries.map((entry) => (
        <div key={entry.id} style={rowStyle}>
          <span style={{ ...muted, fontSize: 12 }}>{describePurgedEntry(entry)}</span>
          <button
            type="button"
            style={buttonStyle}
            disabled={busy || !entry.present}
            onClick={() => {
              onRestore(entry.id)
            }}
          >
            还原
          </button>
        </div>
      ))}
    </div>
  )
}
