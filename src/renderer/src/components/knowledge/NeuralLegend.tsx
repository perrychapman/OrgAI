import type { ReactElement } from 'react'
import { KNOWLEDGE_KEY_RE } from '@shared/types'
import { kindLabel } from '../../lib/knowledge'
import { Popover } from '../ui/Popover'
import { KindMark } from './KindMark'

export const SIZE_NOTE = 'Bigger means it comes up more often.'

/** Bottom left of the stage: the quiet size line (hidden under 480 px, where the legend carries it) and the Legend popover. */
export function NeuralLegend({ kinds }: { kinds: readonly string[] }): ReactElement {
  return (
    <div className="neural-legend-row">
      <Popover trigger="Legend" label="Legend" placement="top-start" className="neural-legend" testId="knowledge-neural-legend" triggerTestId="knowledge-neural-legend-trigger">
        <p className="neural-legend-note">{SIZE_NOTE}</p>
        <ul className="neural-legend-kinds">
          {kinds
            .filter((k) => KNOWLEDGE_KEY_RE.test(k))
            .map((k) => (
              <li key={k} data-testid="knowledge-neural-legend-kind" data-kind={k}>
                <KindMark kind={k} />
                <span>{kindLabel(k)}</span>
              </li>
            ))}
        </ul>
        <ul className="neural-legend-lines">
          <li>
            <span className="neural-key neural-key-line" aria-hidden="true" />
            <span>Line: a recorded relation</span>
          </li>
          <li>
            <span className="neural-key neural-key-dotted" aria-hidden="true" />
            <span>Dotted line: an inferred link, found by matching names in text; it may be wrong</span>
          </li>
          <li>
            <span className="neural-key neural-key-retired" aria-hidden="true" />
            <span>Faded with a dashed ring: retired</span>
          </li>
          <li>
            <span className="neural-key neural-key-flash" aria-hidden="true" />
            <span>Flash: an agent just used this item</span>
          </li>
        </ul>
      </Popover>
      <span className="neural-size-note" data-testid="knowledge-neural-size-note">
        {SIZE_NOTE}
      </span>
    </div>
  )
}
