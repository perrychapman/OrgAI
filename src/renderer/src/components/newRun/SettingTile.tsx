import type { ReactElement, ReactNode } from 'react'
import '../../styles/new-run.css'

/**
 * One glass tile of the New run settings grid: a visible label, the existing control (its trigger fills the tile) and a
 * one-line help. The control keeps its own accessible name; its short "Model:" prefix is hidden visually, not removed.
 */
export function SettingTile({ label, help, children }: { label: string; help: string; children: ReactNode }): ReactElement {
  return (
    <div className="nr-tile nr-glass">
      <span className="nr-tile__label" aria-hidden="true">
        {label}
      </span>
      {children}
      <span className="nr-tile__help">{help}</span>
    </div>
  )
}
