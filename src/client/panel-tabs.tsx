/**
 * The tab bar: one row of grouped tabs, each with its glyph.
 *
 * WHY THIS IS ITS OWN FILE: it used to be ~40 lines inline in `index.tsx`, which sits at its
 * line budget, and every new band or icon would have had to borrow a line from a page that
 * needs it. A pure presentational component is also the only part of the row a test can
 * reach without a DOM.
 *
 * WHY THE BANDS ARE DRAWN FROM `group` AND NOT FROM A SECOND LIST: `PANEL_TABS` already
 * declares each row's band, and the array order is the display order (see its comment). This
 * file therefore only inserts a separator wherever the band changes — there is no ordering
 * decision here to drift out of step with the model.
 *
 * WHY WRAP AND NOT HORIZONTAL SCROLL: fourteen tabs with glyphs do not fit a narrow
 * conversation panel. A second row is visible; a tab scrolled out of sight is not, and the
 * one thing a tab bar must never do is hide an entry behind a scroll the author has no
 * reason to try. `rowGap` keeps two wrapped rows from touching.
 *
 * The disabled branch stays: a row declared `available: false` is a page this build does not
 * ship, and a live-looking button that does nothing is worse than a visibly disabled one.
 */

import { Fragment } from 'react'

import { Icon } from './icons.js'
import { PANEL_TAB_GROUPS } from './panel-model.js'
import type { PanelTab } from './panel-model.js'

const rowStyle = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 6,
  rowGap: 2,
  padding: '0 16px',
  borderBottom: '1px solid var(--dsw-alias-border-l1)',
  background: 'var(--dsw-alias-bg-layer-1)',
} as const

/** A hairline between bands: 1px, the same colour every other divider in the panel uses. */
const separatorStyle = {
  width: 1,
  alignSelf: 'stretch',
  margin: '6px 2px',
  background: 'var(--dsw-alias-border-l1)',
} as const

const labelOf = (group: string): string => PANEL_TAB_GROUPS.find((entry) => entry.id === group)?.label ?? group

export interface PanelTabRowProps {
  readonly tabs: readonly PanelTab[]
  /** The id of the page currently shown. */
  readonly active: string
  readonly onPick: (id: string) => void
}

export function PanelTabRow({ tabs, active, onPick }: PanelTabRowProps) {
  return (
    <div style={rowStyle} role="tablist">
      {tabs.map((entry, index) => {
        const previous = index === 0 ? undefined : tabs[index - 1]
        const startsBand = previous !== undefined && previous.group !== entry.group
        const chosen = active === entry.id
        // The band name rides in the tooltip rather than on screen: a second label per band
        // costs width, and the separator already says "this is a different kind of page".
        const title = entry.available ? labelOf(entry.group) : entry.note
        return (
          <Fragment key={entry.id}>
            {startsBand ? <span style={separatorStyle} aria-hidden="true" /> : null}
            <button
              type="button"
              role="tab"
              aria-selected={chosen}
              aria-pressed={chosen}
              disabled={!entry.available}
              title={title}
              onClick={() => onPick(entry.id)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                border: 'none',
                background: 'transparent',
                color: chosen ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                padding: '6px 4px',
                fontSize: 12,
                cursor: entry.available ? 'pointer' : 'not-allowed',
                borderBottom: chosen ? '2px solid var(--dsw-alias-label-primary)' : '2px solid transparent',
              }}
            >
              <Icon name={entry.icon} size={13} active={chosen} />
              <span>{entry.label}</span>
              {entry.available ? null : <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>{entry.note}</span>}
            </button>
          </Fragment>
        )
      })}
    </div>
  )
}
