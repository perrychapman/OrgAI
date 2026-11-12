import type { ConnectionId } from '@shared/types'
import { connectionLabel } from './connectionLabel'

// The guard and choice logic is shared with the terminal (`orgai runs model`, the TUI's /model): one implementation.
export {
  filterLiveModels,
  liveModelOptions,
  MODEL_HANDOFF_BODY,
  MODEL_HANDOFF_TITLE,
  modelKey,
  modelSessionEnded,
  modelSwitchBlock,
  modelSwitchOutcome,
  needsModelHandoff,
  performModelSwitch,
  waitForModelBoundary
} from '@shared/liveModelSwitch'
export type { ModelSwitchApi } from '@shared/liveModelSwitch'

/** Show the concrete selection, even when the catalog no longer contains it. */
export function liveModelLabel(model: string, connection: ConnectionId): string {
  return `${model} via ${connectionLabel(connection)}`
}
