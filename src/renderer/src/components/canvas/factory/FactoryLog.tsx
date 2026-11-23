// Factory Floor log strip (docs/design/factory-floor.md section 6.5). Live mode only (the scene does not mount it in team
// mode). A native details strip, closed by default; not a live region. Entry text is untrusted agent output: React text
// only, never HTML, never a link. Styles live in styles/factory-chrome.css.
import type { ReactElement } from 'react'
import { ChevronUp } from 'lucide-react'
import type { FloorLogEntry } from '../../../lib/factory/types'

export interface FactoryLogProps {
  /** Newest first, at most 50 (lib/factory/floorLog.ts keeps the cap). */
  entries: readonly FloorLogEntry[]
}

const MAX_SHOWN = 50

export function FactoryLog({ entries }: FactoryLogProps): ReactElement {
  const shown = entries.slice(0, MAX_SHOWN)
  return (
    <details className="factory-log" data-testid="factory-log">
      <summary>
        <span className="factory-log-title">Floor log</span>
        <span className="factory-log-count">{entries.length}</span>
        <ChevronUp className="factory-log-chevron" size={14} aria-hidden="true" />
      </summary>
      {shown.length === 0 ? (
        <p className="factory-log-empty" data-testid="factory-log-empty">
          Nothing has moved yet.
        </p>
      ) : (
        <div className="factory-log-scroll" tabIndex={0} role="region" aria-label="Floor log entries">
          <ol className="factory-log-list">
            {shown.map((e) => (
              <li key={e.id} className="factory-log-entry" data-testid="factory-log-entry">
                <time className="factory-log-time" dateTime={new Date(e.at).toISOString()}>
                  {new Date(e.at).toLocaleTimeString()}
                </time>
                <span className="factory-log-text">{e.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </details>
  )
}
