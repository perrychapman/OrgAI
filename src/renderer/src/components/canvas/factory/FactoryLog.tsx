// Factory Floor log strip (docs/design/factory-floor.md section 6.5). Slice 4 contract (UI Lead): props fixed here; the UI
// Engineer (4c) builds the strip and its styles in styles/factory-chrome.css. Live mode only (the scene does not mount it
// in team mode). Not a live region. Entry text is untrusted agent output: React text only.
import type { ReactElement } from 'react'
import type { FloorLogEntry } from '../../../lib/factory/types'

export interface FactoryLogProps {
  /** Newest first, at most 50 (lib/factory/floorLog.ts keeps the cap). */
  entries: readonly FloorLogEntry[]
}

export function FactoryLog({ entries }: FactoryLogProps): ReactElement {
  return (
    <details className="factory-log" data-testid="factory-log">
      <summary>Floor log ({entries.length})</summary>
    </details>
  )
}
