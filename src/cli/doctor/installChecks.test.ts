import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrgaiOnPathEntry } from '../../main/host/orgaiOnPath'
import { fakeContext } from '../testing/fakeContext'
import { installChecks, installProbes, NODE_CERT_FLOOR } from './installChecks'

const saved = { ...installProbes }
let found: OrgaiOnPathEntry[] = []
let seenPath: string | undefined

beforeEach(() => {
  found = []
  installProbes.installInfo = () => ({ channel: 'npm', version: '0.0.0-test', commit: 'abc123', source: 'file' })
  installProbes.nodeVersion = () => '24.11.0'
  installProbes.tls = () => ({ getCACertificates: () => [], setDefaultCACertificates: () => {} })
  installProbes.bundleDir = () => '/p/lib/node_modules/orgai/out/cli'
  installProbes.realpath = (p) => p
  installProbes.home = () => '/home/u'
  installProbes.findOnPath = (opts) => {
    seenPath = opts.pathList
    return found
  }
})
afterEach(() => Object.assign(installProbes, saved))

async function checks(env: NodeJS.ProcessEnv = { PATH: '/p/bin:/home/u/.local/bin' }, platform: NodeJS.Platform = 'linux') {
  const { ctx } = fakeContext({ env, platform })
  ctx.version = '0.0.0-test'
  const out = await installChecks({ ctx })
  return Object.fromEntries(out.map((c) => [c.id, c]))
}

describe('installChecks', () => {
  it('reports the channel, version and commit', async () => {
    const c = await checks()
    expect(c['install-channel']).toEqual({ id: 'install-channel', status: 'ok', detail: 'channel npm, version 0.0.0-test, commit abc123' })
  })

  it('warns for an invalid install.json and a bundle from another build; dev when absent', async () => {
    installProbes.installInfo = () => ({ channel: 'dev', source: 'invalid', problem: 'install.json is not JSON' })
    expect((await checks())['install-channel']).toMatchObject({ status: 'warn', detail: 'channel dev: install.json is not JSON' })
    installProbes.installInfo = () => ({ channel: 'app', version: '0.0.1', source: 'file' })
    expect((await checks())['install-channel']).toMatchObject({ status: 'warn' })
    installProbes.installInfo = () => ({ channel: 'dev', source: 'absent' })
    expect((await checks())['install-channel']).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^channel dev/) })
  })

  it('lists every orgai on PATH in order, marks this one and flags a shadowed newer one', async () => {
    found = [
      { path: '/p/bin/orgai', kind: 'npm', channel: 'npm', version: '0.1.6', bundleDir: '/p/lib/node_modules/orgai/out/cli' },
      { path: '/home/u/.local/bin/orgai', kind: 'app-shim', channel: 'app', version: '0.1.7', bundleDir: '/Apps/OrgAI.app/Contents/Resources/app.asar.unpacked/out/cli' }
    ]
    const c = await checks()
    expect(seenPath).toBe('/p/bin:/home/u/.local/bin')
    expect(c['orgai-on-path'].status).toBe('warn')
    expect(c['orgai-on-path'].detail).toContain('1. /p/bin/orgai (from npm 0.1.6) [runs, this one]')
    expect(c['orgai-on-path'].detail).toContain('2. /home/u/.local/bin/orgai (of an OrgAI app 0.1.7) [newer, shadowed]')
    expect(c['orgai-on-path'].detail).toContain('/home/u/.local/bin/orgai is newer (0.1.7)')
  })

  it('is ok with one orgai, or none, and reads Path on Windows', async () => {
    found = [{ path: '/p/bin/orgai', kind: 'npm', channel: 'npm', version: '0.1.6' }]
    expect((await checks())['orgai-on-path']).toMatchObject({ status: 'ok', detail: '1. /p/bin/orgai (from npm 0.1.6) [runs]' })
    found = []
    expect((await checks())['orgai-on-path']).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^No orgai on PATH/) })
    await checks({ Path: 'C:\\npm' }, 'win32')
    expect(seenPath).toBe('C:\\npm')
  })

  it('warns when this Node cannot add system certificates', async () => {
    expect((await checks())['node-certs']).toMatchObject({ status: 'ok' })
    installProbes.tls = () => ({ getCACertificates: () => [] })
    installProbes.nodeVersion = () => '22.12.0'
    expect((await checks())['node-certs']).toEqual({
      id: 'node-certs',
      status: 'warn',
      detail: `Corporate root certificates will not be trusted on Node 22.12.0; upgrade to ${NODE_CERT_FLOOR} or later`
    })
  })

  it('turns a throwing probe into a warning, never a throw', async () => {
    installProbes.findOnPath = () => {
      throw new Error('boom')
    }
    expect((await checks())['orgai-on-path']).toEqual({ id: 'orgai-on-path', status: 'warn', detail: 'Could not check: boom' })
  })

  it('agrees with the published engines floor', async () => {
    const { NODE_FLOOR_22, NODE_FLOOR_24 } = await import('../../../scripts/lib/npmPackage.mjs')
    expect(NODE_CERT_FLOOR).toBe(`${NODE_FLOOR_22} or ${NODE_FLOOR_24}`)
  })
})
