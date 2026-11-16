/**
 * Tests only: seed or inspect a data folder through a real in-process host, the way the orgai process itself would. The
 * host serves its own process only (owner proof, cli-standalone-default.md 4.1), so a test cannot keep one running
 * beside `main()` calls or attach a second client to it. It starts a host, hands `fn` an owner client, and stops the host
 * again before it returns, so the next `main()` call can take the folder.
 */
import { connectHost } from '../client/hostClient'
import { startInprocHost, type StartInprocHostOptions } from '../inprocHost'
import type { HostClient } from '../types'
import { CLI_VERSION } from '../version'
import type { HostScope } from '../../shared/types'

export interface SeedHostOptions {
  scopes?: HostScope[]
  /** Extra startInprocHost options (a fake custodian, an environment). */
  host?: Partial<StartInprocHostOptions>
}

/** `more()` opens another owner client on the same host (two clients racing each other). */
export async function withSeedHost<T>(userDataDir: string, fn: (client: HostClient, more: () => Promise<HostClient>) => Promise<T>, opts: SeedHostOptions = {}): Promise<T> {
  const host = await startInprocHost({
    userDataDir,
    dataDir: `${userDataDir}/data`,
    env: { ORGAI_MOCK: '1', ORGAI_DAEMON_IDLE_MINUTES: '0' },
    mock: true,
    overlay: new Map(),
    logging: false,
    startBackground: false,
    systemCertificates: false,
    ...opts.host
  })
  const opened: HostClient[] = []
  const open = async (): Promise<HostClient> => {
    const scopes = opts.scopes ?? ['read', 'operate', 'configure']
    // The in-memory client the CLI itself gets (no socket) unless the test asked for a listening host.
    const res = host.connectLocal
      ? await host.connectLocal(scopes, { cwd: userDataDir })
      : await connectHost({ dataDir: `${userDataDir}/data`, scopes, clientVersion: CLI_VERSION, cwd: userDataDir, pid: process.pid, ownerKey: host.ownerKey!, ownerHostInstanceId: host.hostInstanceId! })
    if (!res.ok) throw new Error(res.message)
    opened.push(res.client)
    return res.client
  }
  try {
    return await fn(await open(), open)
  } finally {
    for (const c of opened) c.close()
    await host.stop(true).catch(() => undefined)
  }
}
