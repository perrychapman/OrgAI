import type { ReactElement, ReactNode } from 'react'
import '../../styles/run-settings.css'

/**
 * The run settings row (docs/design/ux-review-run-start-pre.md): Model, Effort, Permission, Goal chips in that fixed
 * order, on the New run page (`surface="start"`, a draft) and above the live composer (`surface="live"`, the running
 * run). Each chip is one Tab stop; the row wraps at narrow widths instead of shrinking the chips.
 */
export function RunSettingsRow({ surface, children }: { surface: 'start' | 'live'; children: ReactNode }): ReactElement {
  return (
    <div className="run-settings-row" role="group" aria-label="Run settings" data-testid="run-settings" data-surface={surface}>
      {children}
    </div>
  )
}
