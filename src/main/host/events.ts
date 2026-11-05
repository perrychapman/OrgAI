/**
 * The host's push event bus (cli-spec 3.3(3) "push: socket_subscribable", Wave 1).
 *
 * Every main -> client push that a socket client may subscribe to goes through one HostEventBus: the desktop shell
 * forwards it to windows (webContents.send), and the Wave 2 socket server to subscribed sockets. The three
 * window-targeted push channels (app:focusRun, menu:action, projects:cloneProgress) never go on the bus: they address
 * one window.
 *
 * Electron-free (noElectronImport.test.ts); relative imports only.
 */
import { IPC } from '../../shared/types'
import type {
  AppSettingsInfo,
  CapabilityProgressEvent,
  ConnectionEvent,
  EngagementChangedEvent,
  McpLibraryInfo,
  RunEvent,
  SkillLibraryInfo,
  TeamReviewSummary
} from '../../shared/types'

/** Payload of each socket-subscribable push channel (what webContents.send passes today). */
export interface HostPushPayloads {
  'runs:event': RunEvent
  'settings:changed': AppSettingsInfo
  'connections:event': ConnectionEvent
  'mcpLibrary:changed': McpLibraryInfo[]
  'skillLibrary:changed': SkillLibraryInfo[]
  'capabilities:progress': CapabilityProgressEvent
  'capabilities:reviewUpdated': TeamReviewSummary
  'projects:engagementChanged': EngagementChangedEvent
}

/** The 8 socket-subscribable push channels. */
export type HostPushChannel =
  | typeof IPC.runEvent
  | typeof IPC.settingsChanged
  | typeof IPC.connectionsEvent
  | typeof IPC.mcpLibraryChanged
  | typeof IPC.skillLibraryChanged
  | typeof IPC.capabilitiesProgress
  | typeof IPC.capabilitiesReviewUpdated
  | typeof IPC.projectsEngagementChanged

// Compile-time check that the payload map and the channel union name the same channels.
type SameKeys<A, B> = [Exclude<A, B>, Exclude<B, A>] extends [never, never] ? true : never
const _payloadKeysMatch: SameKeys<keyof HostPushPayloads, HostPushChannel> = true
void _payloadKeysMatch

export const HOST_PUSH_CHANNELS: readonly HostPushChannel[] = [
  IPC.runEvent,
  IPC.settingsChanged,
  IPC.connectionsEvent,
  IPC.mcpLibraryChanged,
  IPC.skillLibraryChanged,
  IPC.capabilitiesProgress,
  IPC.capabilitiesReviewUpdated,
  IPC.projectsEngagementChanged
]

export type HostEventListener = <C extends HostPushChannel>(channel: C, payload: HostPushPayloads[C]) => void

/**
 * Synchronous fan-out in subscription order. A throwing listener is logged (console.error) and the rest still run.
 * A listener added during an emit does not get that emit; one removed during an emit and not yet called does not
 * either. The unsubscribe function is idempotent.
 */
export class HostEventBus {
  private listeners: { fn: HostEventListener; active: boolean }[] = []

  emit<C extends HostPushChannel>(channel: C, payload: HostPushPayloads[C]): void {
    const snapshot = this.listeners.slice()
    for (const entry of snapshot) {
      if (!entry.active) continue
      try {
        entry.fn(channel, payload)
      } catch (e) {
        console.error(`[host events] A ${channel} listener failed:`, e)
      }
    }
  }

  on(listener: HostEventListener): () => void {
    const entry = { fn: listener, active: true }
    this.listeners.push(entry)
    return () => {
      if (!entry.active) return
      entry.active = false
      this.listeners = this.listeners.filter((l) => l !== entry)
    }
  }
}
