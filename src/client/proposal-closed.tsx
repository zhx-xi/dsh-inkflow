/**
 * The proposals the author has finished with, behind one fold row.
 *
 * Its own file for two reasons: `proposal.tsx` is at the 600-line cap (`check-guards` item 10),
 * and this block is a self-contained decision — which finished proposals exist, which one is
 * being looked at, and which one is one click away from being cleaned up. The first screen must
 * not carry it: an inbox that mixes "waiting on you" with "done, months ago" is how the author
 * asked whether these stay forever in the first place.
 *
 * No hooks (props only): the fold's own state belongs to the page, because the page also decides
 * which proposal the right-hand column opens.
 */

import { cleanActionLabel } from './purge-model.js'
import { cleanable, describeClosedGroup, describeCounts, describeProposalStatus } from './proposal-model.js'
import type { ProposalRow, ProposalSplit } from './proposal-model.js'

const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 } as const

const cardStyle = {
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: 8,
  padding: '8px 10px',
  background: 'var(--dsw-alias-bg-layer-1)',
} as const

const muted = { color: 'var(--dsw-alias-label-secondary)' } as const

const buttonStyle = {
  padding: '2px 10px',
  fontSize: 12,
  borderRadius: 6,
  cursor: 'pointer',
  border: '1px solid var(--dsw-alias-border-l2)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
} as const

const selectButtonStyle = {
  ...buttonStyle,
  textAlign: 'left',
  display: 'block',
  width: '100%',
  padding: '6px 8px',
} as const

const activeSelectStyle = {
  ...selectButtonStyle,
  borderColor: 'var(--dsw-alias-label-primary)',
} as const

export interface ClosedProposalGroupProps {
  readonly split: ProposalSplit
  readonly open: boolean
  readonly selected: string | null
  /** The proposal whose cleanup is waiting for its second click. */
  readonly armedClean: string | null
  readonly busy: boolean
  readonly onToggle: () => void
  readonly onSelect: (proposalId: string) => void
  readonly onClean: (proposalId: string) => void
}

/**
 * One proposal in the left column.
 *
 * Lives here (not in `proposal.tsx`) because both groups draw the **same** row: an open proposal
 * and a finished one must look alike, or the fold would read as "different, lesser things" and
 * the author would not recognise the proposal they applied yesterday.
 */
export function ProposalListItem(props: {
  readonly row: ProposalRow
  readonly active: boolean
  readonly onSelect: () => void
}): JSX.Element {
  const { row, active, onSelect } = props
  return (
    <button type="button" style={active ? activeSelectStyle : selectButtonStyle} onClick={onSelect}>
      <span style={{ ...mono, display: 'block' }}>{row.proposalId}</span>
      <span style={{ display: 'block', fontWeight: 600 }}>{row.title === '' ? row.path : row.title}</span>
      <span style={{ ...muted, display: 'block' }}>
        {describeProposalStatus(row.status)} · {describeCounts(row.counts)}
      </span>
    </button>
  )
}

/** The fold row plus its rows: `已结束（2）`, then one line each when opened. */
export function ClosedProposalGroup(props: ClosedProposalGroupProps): JSX.Element | null {
  const { split, open, selected, armedClean, busy, onToggle, onSelect, onClean } = props
  if (split.closedCount === 0) return null
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" style={buttonStyle} onClick={onToggle}>
          {open ? `收起${describeClosedGroup(split)}` : describeClosedGroup(split)}
        </button>
        {open ? null : (
          <span style={{ ...muted, fontSize: 12 }}>已结束的提案不占首屏；展开可逐条打开、清理（搬进回收区，可还原）。</span>
        )}
      </div>
      {open
        ? split.closed.map((row) => (
            <div key={row.proposalId} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6 }}>
              <span style={{ flex: '1 1 240px', minWidth: 0 }}>
                <ProposalListItem
                  row={row}
                  active={row.proposalId === selected}
                  onSelect={() => {
                    onSelect(row.proposalId)
                  }}
                />
              </span>
              <button
                type="button"
                disabled={busy || !cleanable(row.status)}
                style={buttonStyle}
                onClick={() => onClean(row.proposalId)}
              >
                {cleanActionLabel(armedClean === row.proposalId)}
              </button>
            </div>
          ))
        : null}
    </div>
  )
}

