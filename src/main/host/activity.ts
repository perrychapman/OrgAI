/**
 * HostActivityTracker (cli-spec 3.2(4), Wave 1): leases and polled sources that keep a host from going idle, the idle
 * exit timer and the ownership-safe drain. Electron-free; relative imports only.
 *
 * Wave 1 contracts skeleton: noopActivity is final; the tracker's methods are stubs until the activity task.
 */
import { ACTIVITY_LEASE_KINDS, DEFAULT_DAEMON_IDLE_MINUTES } from '../../shared/types'
import type { ActivityLeaseKind, HostActivitySnapshot, HostState, HostStopInput, HostStopResult } from '../../shared/types'
import type { HostActivityTrackerApi } from './types'

export interface HostActivityOptions {
  /** The host's ownership (ownership.ts): markDraining flips daemon.json to 'draining', release removes our files only. */
  ownership?: { markDraining(): boolean; release(): void }
  /** Idle time before an armed idle exit drains the host. */
  idleMs?: number
  /** How often polled sources are read. */
  pollMs?: number
  now?: () => number
  /** host.stop with force: stop every run first. */
  forceStop?: () => Promise<void>
  /** Called once the drain finished (the process may exit). */
  onDrained?: () => void
  log?: (m: string) => void
}

function zeroCounts(): Record<ActivityLeaseKind, number> {
  const counts = {} as Record<ActivityLeaseKind, number>
  for (const k of ACTIVITY_LEASE_KINDS) counts[k] = 0
  return counts
}

function idleSnapshot(state: HostState): HostActivitySnapshot {
  return { counts: zeroCounts(), total: 0, idle: true, state }
}

export class HostActivityTracker implements HostActivityTrackerApi {
  constructor(private readonly opts: HostActivityOptions = {}) {}

  acquire(_kind: ActivityLeaseKind, _label?: string): () => void {
    return () => {}
  }

  track<T>(_kind: ActivityLeaseKind, p: Promise<T>): Promise<T> {
    return p
  }

  addSource(_kind: ActivityLeaseKind, _count: () => number): () => void {
    return () => {}
  }

  snapshot(): HostActivitySnapshot {
    void this.opts
    return idleSnapshot('ready')
  }

  isIdle(): boolean {
    return true
  }

  state(): HostState {
    return 'ready'
  }

  requestDrain(_input?: HostStopInput): Promise<HostStopResult> {
    return Promise.resolve({ stopping: false })
  }

  onChange(_listener: (s: HostActivitySnapshot) => void): () => void {
    return () => {}
  }

  /** Start the idle-exit timer (background hosts). */
  armIdleExit(): void {}

  disarmIdleExit(): void {}
}

/** A tracker that tracks nothing: always idle and ready, drain refused. For hosts and tests without activity tracking. */
export function noopActivity(): HostActivityTrackerApi {
  return {
    acquire: () => () => {},
    track: (_kind, p) => p,
    addSource: () => () => {},
    snapshot: () => idleSnapshot('ready'),
    isIdle: () => true,
    state: () => 'ready',
    requestDrain: () => Promise.resolve({ stopping: false }),
    onChange: () => () => {}
  }
}

/** ORGAI_DAEMON_IDLE_MINUTES in ms. Skeleton: always the default. */
export function daemonIdleMs(_env: NodeJS.ProcessEnv): number {
  return DEFAULT_DAEMON_IDLE_MINUTES * 60_000
}
