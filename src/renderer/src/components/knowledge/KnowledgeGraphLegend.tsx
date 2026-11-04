import type { ReactElement } from 'react'
import { CircleHelp } from 'lucide-react'
import type { CanvasNodeStyle } from '@shared/types'
import { Icon } from '../ui/Icon'
import { Popover } from '../ui/Popover'
import type { LegendEntries } from '../../lib/knowledgeGraph'
import { retiredGroupLabel } from '../../lib/knowledgeGraph'

/**
 * The Graph view's legend popover (`knowledge-graph-legend`): the kinds on the canvas with their colour swatch and
 * label, the relation types on it with the line sample, then the cues that apply: "Retired" (dashed, muted) and the
 * "N retired" group. Every word is text beside its shape, never colour alone (rec 19).
 */
export function KnowledgeGraphLegend({ entries, nodeStyle }: { entries: LegendEntries; nodeStyle: CanvasNodeStyle }): ReactElement {
  const station = nodeStyle === 'station'
  const empty = entries.kinds.length === 0 && entries.relations.length === 0
  return (
    <Popover
      label="Graph legend"
      placement="bottom-end"
      triggerClassName="icon-btn size-sm"
      triggerLabel="Graph legend"
      trigger={<Icon icon={CircleHelp} size="sm" />}
      testId="knowledge-graph-legend"
      triggerTestId="knowledge-graph-legend-trigger"
    >
      <div className="knowledge-legend">
        {empty ? (
          <p className="panel-note">Nothing is drawn yet.</p>
        ) : (
          <>
            <p className="knowledge-legend-title">Kinds</p>
            <ul className="legend-list">
              {entries.kinds.map((k) => (
                <li key={k.kind} data-testid="knowledge-legend-kind" data-kind={k.kind}>
                  <span className="legend-shape">
                    <span className="knowledge-legend-swatch" data-style={nodeStyle} style={{ ['--role' as string]: k.color }} aria-hidden="true" />
                  </span>
                  {k.label}
                </li>
              ))}
            </ul>
            {entries.relations.length > 0 && (
              <>
                <p className="knowledge-legend-title">Relations</p>
                <ul className="legend-list">
                  {entries.relations.map((r) => (
                    <li key={r.relation} data-testid="knowledge-legend-relation" data-relation={r.relation}>
                      <span className="legend-shape legend-wide">
                        <span className={station ? 'legend-report legend-report-station' : 'legend-report'} aria-hidden="true" />
                      </span>
                      {r.label}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
        <p className="knowledge-legend-title">Retired</p>
        <ul className="legend-list">
          <li data-testid="knowledge-legend-retired">
            <span className="legend-shape legend-wide">
              <span className="knowledge-legend-retired-line" aria-hidden="true" />
            </span>
            Retired item or relation (dashed, muted, marked Retired)
          </li>
          <li data-testid="knowledge-legend-group">
            <span className="legend-shape legend-wide">
              <span className="legend-folded" data-style={nodeStyle} aria-hidden="true">
                {retiredGroupLabel(3)}
              </span>
            </span>
            Folded retired items (expand with the chevron)
          </li>
        </ul>
      </div>
    </Popover>
  )
}
