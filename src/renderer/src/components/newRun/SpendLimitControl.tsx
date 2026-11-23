import type { ReactElement } from 'react'
import { useId } from 'react'
import { formatUsdCompact } from '@shared/view/cost'
import { Input } from '../ui/Input'
import { parseRunLimit } from './newRunData'
import '../../styles/new-run.css'

/**
 * The "Spending limit" tile's field: an optional amount for this run only. Empty = the project's own limit applies. It can
 * only be lower than the project's limit (main takes the lower of the two), so a higher figure is refused here with the
 * reason instead of being silently capped.
 */
export function SpendLimitControl({ value, onChange, projectCapUsd }: { value: string; onChange: (text: string) => void; projectCapUsd?: number }): ReactElement {
  const errorId = useId()
  const parsed = parseRunLimit(value, projectCapUsd)
  const capped = typeof projectCapUsd === 'number' && projectCapUsd > 0
  return (
    <div className="nr-limit">
      <div className="nr-limit__field">
        <span className="nr-limit__unit" aria-hidden="true">
          $
        </span>
        <Input
          type="number"
          inputMode="decimal"
          min="0.01"
          step="any"
          value={value}
          onChange={onChange}
          aria-label="Limit for this run ($)"
          placeholder={capped ? `Project limit ${formatUsdCompact(projectCapUsd)}` : 'No limit set'}
          invalid={!parsed.ok}
          aria-describedby={parsed.ok ? undefined : errorId}
          data-testid="new-run-limit"
        />
      </div>
      {!parsed.ok && (
        <p className="field-error" id={errorId} data-testid="new-run-limit-error">
          {parsed.problem}
        </p>
      )}
    </div>
  )
}
