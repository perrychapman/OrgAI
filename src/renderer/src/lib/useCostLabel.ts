import type { ConnectionId } from '@shared/types'
import { activeRun, useAppStore } from '../store/useAppStore'
import { formatCost } from './layout'
import { runCostLabel } from './usage'

type Label = { text: string; title: string; hidden: boolean }

/**
 * Returns a formatter for cost figures labelled by a run's own connection. Pass the connection of the
 * run the figure belongs to; omit it for the open run (live canvas, side panel).
 */
export function useCostLabel(connection?: ConnectionId): (usd: number, conn?: ConnectionId) => Label {
  const openConnection = useAppStore((s) => activeRun(s)?.summary.connection)
  const authMode = useAppStore((s) => s.usageByConnection.anthropic?.authMode)
  return (usd, conn) => runCostLabel(usd, conn ?? connection ?? openConnection, authMode, formatCost)
}
