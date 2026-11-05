/**
 * Integration (Wave 7, cli-standalone.md 4.1 step 4): `--host auto` with no live host and no app runs a real in-process
 * host for a management command (withHost), and a second host-backed step of the same command (init's Architect
 * after its withHost) gets a fresh in-process host after the first one stopped. Mock adapter, a temp data folder, the
 * OS certificate reader mocked; no tokens, no network.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../main/systemCerts', () => ({ trustSystemCertificates: () => undefined, stopSystemCertRead: () => undefined }))

import { buildContext } from './context'
import { INPROC_FALLBACK_NOTE } from './client/ensureHost'
import { withHost } from './manage'
import type { CliContext } from './types'

let userDataDir: string
beforeEach(() => {
  userDataDir = realpathSync(mkdtempSync(join(tmpdir(), 'hsel-')))
})
afterEach(() => rmSync(userDataDir, { recursive: true, force: true }))

function context(): { ctx: CliContext; err: () => string } {
  let err = ''
  const ctx = buildContext({
    globals: { host: 'auto', outputFormat: 'text', color: false, secretEnv: [], dataDir: userDataDir },
    env: { ORGAI_MOCK: '1', ORGAI_DAEMON_IDLE_MINUTES: '0', PATH: process.env.PATH ?? '' },
    cwd: userDataDir,
    platform: process.platform,
    io: { stdout: { write: () => true }, stderr: { write: (s: string) => ((err += s), true) }, stdinIsTTY: false }
  })
  // This checkout may or may not be built; the test is about the case where no app exists at all.
  ctx.launcher = { ...ctx.launcher, locate: () => ({ status: 'absent', message: 'OrgAI app not found' }) }
  return { ctx, err: () => err }
}

describe('host selection without the app', () => {
  it('runs a management command in-process, then starts a fresh in-process host for the next step', async () => {
    const { ctx, err } = context()
    const first = await withHost(ctx, ['read'], async (client) => {
      expect(client.hello.hostKind).toBe('inproc')
      return client.call<unknown[]>('projects:list', [])
    })
    expect(Array.isArray(first)).toBe(true)
    expect(err()).toBe(`${INPROC_FALLBACK_NOTE}\n`)
    // The first host stopped and released the folder; a second step of the same command starts another one.
    const second = await withHost(ctx, ['read', 'configure'], async (client) => {
      expect(client.hello.grantedScopes).toEqual(expect.arrayContaining(['read', 'configure']))
      return client.hello.hostInstanceId
    })
    expect(typeof second).toBe('string')
    expect(err()).toBe(`${INPROC_FALLBACK_NOTE}\n`)
    // And nothing is left behind: a plain connect finds no host.
    const res = await ctx.connect(['read'], { waitStartingMs: 0 })
    expect(res.ok).toBe(false)
  }, 30_000)
})
