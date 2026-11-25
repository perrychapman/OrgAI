import type { ReactElement } from 'react'
import { useId, useState } from 'react'
import { Bell, ChevronDown, ChevronRight, CircleCheck, CircleHelp, TriangleAlert } from 'lucide-react'
import type { CanvasNodeStyle } from '@shared/types'
import { Icon } from '../ui/Icon'

/** The marks the org chart draws, each with the shape it has on a node plus its word (never colour alone). */
export function LegendList({ nodeStyle }: { nodeStyle: CanvasNodeStyle }): ReactElement {
  const station = nodeStyle === 'station'
  return (
    <ul className="legend-list">
      <li>
        <span className="legend-shape">
          <span className="legend-ring" />
        </span>
        Working
      </li>
      <li>
        <span className="legend-shape legend-warn">
          <Icon icon={Bell} size="sm" />
        </span>
        Needs you
      </li>
      <li>
        <span className="legend-shape legend-ok">
          {station ? <span className="legend-dot" aria-hidden="true" /> : <Icon icon={CircleCheck} size="sm" />}
        </span>
        Finished
      </li>
      <li>
        <span className="legend-shape legend-bad">
          <Icon icon={TriangleAlert} size="sm" />
        </span>
        Failed
      </li>
      <li>
        <span className="legend-shape">
          <span className="legend-selected" />
        </span>
        Selected
      </li>
      <li>
        <span className="legend-shape legend-wide">
          <span className="legend-folded" data-style={nodeStyle} aria-hidden="true">3 done</span>
        </span>
        Folded finished agents
      </li>
      <li>
        <span className="legend-shape legend-wide">
          <span className={station ? 'legend-report legend-report-station' : 'legend-report'} />
        </span>
        {station ? "Reporting line (the lead's colour)" : 'Reporting line'}
      </li>
      <li>
        <span className="legend-shape legend-wide">
          <span className="legend-line" />
        </span>
        Message between agents
      </li>
    </ul>
  )
}

/**
 * "What the marks mean" inside the View menu: a disclosure button (`canvas-legend-trigger`) over the list
 * (`canvas-legend`). Collapsed at first, so the menu stays short; the button is a plain toggle, not a nested popover.
 */
export function ViewLegend({ nodeStyle }: { nodeStyle: CanvasNodeStyle }): ReactElement {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="view-legend">
      <button type="button" className="view-legend-trigger" data-testid="canvas-legend-trigger" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <Icon icon={CircleHelp} size="sm" />
        <span>Legend</span>
        <Icon icon={open ? ChevronDown : ChevronRight} size="sm" />
      </button>
      {open && (
        <div id={id} data-testid="canvas-legend" role="group" aria-label="Canvas legend">
          <LegendList nodeStyle={nodeStyle} />
        </div>
      )}
    </div>
  )
}
