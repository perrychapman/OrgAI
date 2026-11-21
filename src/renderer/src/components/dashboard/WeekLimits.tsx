import type { ReactElement } from 'react'
import { PlanGauges } from '../limits/PlanGauge'
import type { LimitEntry } from '../limits/useLimitEntries'

export { useLimitEntries, type LimitEntry } from '../limits/useLimitEntries'

/** Interim: the limits as gauges until the Briefing takes them (dashboard redesign). Renders nothing without entries. */
export function WeekLimits({ entries }: { entries: readonly LimitEntry[] }): ReactElement | null {
  return <PlanGauges entries={entries} arrive={false} />
}
