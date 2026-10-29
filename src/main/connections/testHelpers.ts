import type { CodexAppServer } from '../runtime/codexAppServer'
import type { CodexRpc } from './codexAccount'

/** Test-only fixtures for the connections modules. Not imported by app code. */

export type FakeRpc = CodexRpc & {
  calls: [string, unknown][]
  closed: boolean
  emit(method: string, params: unknown): void
  start(): Promise<unknown>
  close(): void
  onExit(): () => void
  readonly running: boolean
}

/** A scripted fake app-server: answers by method name (value or function of params) and records calls. */
export function fakeRpc(answers: Record<string, unknown | ((params: unknown) => unknown)>): FakeRpc {
  const calls: [string, unknown][] = []
  const handlers = new Set<(method: string, params: unknown) => void>()
  const rpc = {
    calls,
    closed: false,
    get running() {
      return !rpc.closed
    },
    emit: (m: string, p: unknown) => handlers.forEach((h) => h(m, p)),
    start: async () => ({}),
    close: () => {
      rpc.closed = true
    },
    onExit: () => () => {},
    request: (async (method: string, params?: unknown) => {
      calls.push([method, params])
      if (!(method in answers)) throw new Error(`no answer for ${method}`)
      const a = answers[method]
      return typeof a === 'function' ? (a as (p: unknown) => unknown)(params) : a
    }) as CodexRpc['request'],
    onNotification: (h: (method: string, params: unknown) => void) => {
      handlers.add(h)
      return () => handlers.delete(h)
    }
  }
  return rpc
}

export const asCodexServer = (r: FakeRpc): CodexAppServer => r as unknown as CodexAppServer
