/**
 * host.stop over the real socket of an in-process host (cli-spec 3.2(3) / 6.3(6)): the reply reaches the client for a
 * forced and a non-forced drain alike, then the host releases daemon.json. Mock adapter only; no tokens.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectHost } from './client/hostClient'
import { startInprocHost, type InprocHost } from './inprocHost'
import { CLI_VERSION } from './version'

let userDataDir: string
let dataDir: string
const started: InprocHost[] = []

beforeEach(() => {
  userDataDir = realpathSync(mkdtempSync(join(tmpdir(), 'hstop-')))
  dataDir = join(userDataDir, 'data')
})
afterEach(async () => {
  for (const h of started.splice(0)) await h.stop(true).catch(() => {})
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('host.stop over the socket', () => {
  for (const force of [false, true]) {
    it(`answers { stopping: true } before the drain closes the socket (force ${force})`, async () => {
      const h = await startInprocHost({ userDataDir, dataDir, env: { ORGAI_MOCK: '1', ORGAI_DAEMON_IDLE_MINUTES: '0' }, mock: true, overlay: new Map(), logging: false, startBackground: false, systemCertificates: false })
      started.push(h)
      const res = await connectHost({ dataDir, scopes: ['read', 'configure'], clientVersion: CLI_VERSION, cwd: userDataDir, pid: process.pid })
      if (!res.ok) throw new Error(res.message)
      await expect(res.client.call('host.stop', [{ force }])).resolves.toEqual({ stopping: true })
      await h.closed
      expect(existsSync(join(dataDir, 'run', 'daemon.json'))).toBe(false)
      res.client.close()
    })
  }
})
