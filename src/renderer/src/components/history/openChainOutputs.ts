import { useAppStore } from '../../store/useAppStore'
import { revealOutputsTab } from '../outputs/revealOutputsTab'

/** Open the conversation (the Live view), then its Outputs side tab with the list showing. */
export function openChainOutputs(newestId: string, onOpen: (id: string) => Promise<void>): void {
  void onOpen(newestId)
    .then(() => {
      useAppStore.getState().openRunOutput(newestId, null)
      revealOutputsTab()
    })
    .catch(() => undefined)
}
