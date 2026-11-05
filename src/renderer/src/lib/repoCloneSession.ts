import { useSyncExternalStore } from 'react'
import type { OrgAIApi, RepoCloneMode, RepoCloneProgress, RepoCloneResult } from '@shared/types'
import { cleanIpcError } from './ipcError'
import { isCancelledMessage } from './repoStart'

/**
 * The clone the New project form started. It lives outside the form because the form can unmount while git runs: an
 * in-app view change does not cancel it (main cancels only when the window itself goes away or reloads), and a finished
 * clone is offered again when the form reopens. One per window, in memory only.
 */
export type RepoSession =
  | { status: 'idle' }
  | { status: 'running'; requestId: string; mode: RepoCloneMode; display: string; destination: string; progress: RepoCloneProgress | null; cancelling: boolean }
  /** `cancelled` means the user stopped it; `message` is one line from main. */
  | { status: 'failed'; message: string; cancelled: boolean; mode: RepoCloneMode }
  | { status: 'done'; result: RepoCloneResult; display: string; mode: RepoCloneMode }

type ReposApi = Pick<OrgAIApi, 'repos' | 'onRepoCloneProgress'>

const IDLE: RepoSession = { status: 'idle' }
let session: RepoSession = IDLE
let quietCancel = false
const listeners = new Set<() => void>()

function set(next: RepoSession): void {
  session = next
  for (const l of listeners) l()
}

export function repoSession(): RepoSession {
  return session
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function useRepoSession(): RepoSession {
  return useSyncExternalStore(subscribe, repoSession)
}

function newRequestId(): string {
  return crypto.randomUUID()
}

/**
 * Start the clone. `source` is the text the user typed: main parses it again and builds the URL itself. Refuses (false)
 * while one is running. Never rejects: the outcome lands in the session.
 */
export function startRepoClone(input: { source: string; mode: RepoCloneMode; destination: string; display: string }, api: ReposApi = window.orgai): boolean {
  if (session.status === 'running') return false
  const requestId = newRequestId()
  quietCancel = false
  set({ status: 'running', requestId, mode: input.mode, display: input.display, destination: input.destination, progress: null, cancelling: false })
  const unsubscribe = api.onRepoCloneProgress((event) => {
    if (session.status === 'running' && session.requestId === requestId && event.requestId === requestId) set({ ...session, progress: event })
  })
  void api.repos
    .clone({ requestId, source: input.source, mode: input.mode, destination: input.destination })
    .then((result) => {
      set({ status: 'done', result, display: input.display, mode: input.mode })
    })
    .catch((err: unknown) => {
      const message = cleanIpcError(err, 'The clone failed.')
      if (quietCancel) set(IDLE)
      else set({ status: 'failed', message, cancelled: isCancelledMessage(message), mode: input.mode })
    })
    .finally(() => {
      quietCancel = false
      unsubscribe()
    })
  return true
}

/** Stop the running clone. `quiet`: the form is closing, so the outcome is not kept to show later. */
export function cancelRepoClone(opts: { quiet?: boolean } = {}, api: ReposApi = window.orgai): void {
  if (session.status !== 'running') return
  if (opts.quiet) quietCancel = true
  set({ ...session, cancelling: true })
  void api.repos.cancelClone(session.requestId).catch(() => {})
}

/** Drop a shown failure: the user changed something or reopened the form. */
export function clearRepoFailure(): void {
  if (session.status === 'failed') set(IDLE)
}

/** Forget a finished clone: the project exists, or the user chose something else. The folder stays on disk. */
export function forgetRepoClone(): void {
  if (session.status === 'done') set(IDLE)
}

/** Tests only. */
export function resetRepoSessionForTests(): void {
  quietCancel = false
  session = IDLE
  listeners.clear()
}
